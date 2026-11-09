// Cover repair pass — drives the catalogue toward a REAL cover on (nearly)
// every title, so the app almost never falls back to the typographic plate.
//
//   node src/covers.js                → live: repair NULL + manami-placeholder rows
//   node src/covers.js --dry-run      → resolve + validate, but write NOTHING
//   node src/covers.js --limit=N      → cap to N affected rows (bounded run)
//   node src/covers.js --revalidate   → ALSO HEAD-check existing http covers and
//                                        repair the ones that are definitively dead
//   node src/covers.js --no-tvdb-search → skip the (slow, low-yield) TVDB title
//                                          search; still uses tvdb ids we hold
//
// WHY this exists: the manami import is ~98% of the catalogue and ships a grey
// `no_pic.png` placeholder (raw.githubusercontent.com — deliberately NOT
// allow-listed) for entries it has no artwork for. Those rows, plus any genuinely
// dead cover URL, are the only ones that break. This pass finds a WORKING cover
// for them from a reliable source and HEAD-validates (200) BEFORE writing.
//
// Source waterfall per affected row (preferred → last resort). Every URL written
// is on a host allow-listed in web/next.config.ts, so a repaired cover never
// stripes:
//   1. TheTVDB artwork — reliable + allow-listed. By tvdb id when we hold one,
//      else resolve by title(+year) search (best-effort; never blocks the pass).
//   2. manami-DB por titulo (cdn.myanimelist.net) — acerto exato numa tabela
//      em memoria, sem rede. E a fonte de 990 de cada 1000 capas que ja temos.
//   3. Busca por titulo no TVDB — best-effort, faz rede.
//   4. AnimeSchedule image — for rows that carry an AnimeSchedule image route
//      (the manami rows this pass targets do not; kept as an explicit tier).
//   5. Kitsu poster CDN (media.kitsu.app) — via the kitsu external id.
// When NO source yields a validated cover and the row still holds the manami
// placeholder, the cover is set to NULL — the app's canonical "no cover" state,
// which renders the typographic fallback cleanly instead of a broken tile.
//
// Idempotent: only ever touches rows whose cover is NULL, the manami placeholder,
// or (with --revalidate) a definitively dead URL. A repaired row now carries a
// validated, allow-listed URL and is skipped next run. Working covers are never
// overwritten. Writes `animes.cover_image_url` only.
import { pathToFileURL } from 'node:url';

import { config, USER_AGENT } from './config.js';
import { RateLimiter } from './http.js';
import { MANAMI_NO_PIC } from './catalogue-mappers.js';
import { safeImageUrl } from './image-hosts.js';
import { buildManamiTitleIndex, loadManamiDatabase, normalizeTitleKey } from './manami.js';

// Image CDNs (MAL/Kitsu/TVDB) are happier with a browser-like UA than a bot one
// — the same UA the diagnosis HEAD-checks used. API calls keep the polite bot UA.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const KITSU_API = 'https://kitsu.app/api/edge';
const HEAD_TIMEOUT_MS = 12000;
const PAGE = 1000; // Supabase read page size
const REVALIDATE_CONCURRENCY = 10; // parallel HEADs when scanning for dead covers

// Polite Kitsu pacing (no published limit; ~3 req/s is courteous). TVDB reuses
// tvdb.js's shared ≤4 req/s limiter via the imported client functions.
const kitsuLimiter = new RateLimiter(300);

const DRY_RUN = process.argv.includes('--dry-run');
const REVALIDATE = process.argv.includes('--revalidate');
const NO_TVDB_SEARCH = process.argv.includes('--no-tvdb-search');
const LIMIT = parseLimit(process.argv);

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Parse `--limit=N` (positive integer) or return null. */
export function parseLimit(argv) {
  const arg = (argv ?? []).find((a) => a.startsWith('--limit='));
  if (!arg) return null;
  const n = Number(arg.slice('--limit='.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A cover the app can't really show: absent, or the manami `no_pic` placeholder. */
export function isBrokenCover(url) {
  return url == null || url === MANAMI_NO_PIC;
}

/**
 * Repair priority: most-followed titles first (popularity desc, nulls last),
 * then a stable id tiebreak so runs are deterministic and resumable.
 */
export function prioritize(rows) {
  return [...rows].sort((a, b) => {
    const pa = a.popularity ?? -1;
    const pb = b.popularity ?? -1;
    if (pb !== pa) return pb - pa;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Kitsu JSON:API anime record → best poster URL (original → … → small), or null. */
export function kitsuPosterFromResponse(json) {
  const p = json?.data?.attributes?.posterImage;
  if (!p || typeof p !== 'object') return null;
  const url = p.original ?? p.large ?? p.medium ?? p.small ?? null;
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null;
}

// ── Network primitives ───────────────────────────────────────────────────────

/**
 * Inspect an image URL by a browser-UA HEAD (falling back to a 1-byte ranged
 * GET when a CDN rejects HEAD). Returns the verdict AND the HTTP status behind
 * it, so a caller that only reports (the read-only audit) can name the status
 * while the repair path below still just asks "ok or not".
 *   'ok'      → 200/206, a real image is there.
 *   'dead'    → a definitive HTTP status that won't recover (4xx/5xx, not 429).
 *   'unknown' → timeout / network error / 429 — transient, so callers must NOT
 *               treat it as dead (never null a cover on a flaky check).
 * `status` is null when no response was obtained (no url, timeout, network).
 */
export async function inspectImage(url, fetchImpl = fetch) {
  if (!url) return { verdict: 'unknown', status: null };
  // Fora da lista de anfitriões (ver image-hosts.js) nem se pede: o site nunca
  // a mostraria, e pedir um endereço vindo de uma fonte externa a partir desta
  // máquina é exatamente o que não se quer. É definitivo, não passageiro.
  if (safeImageUrl(url) === null) return { verdict: 'dead', status: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
  const headers = { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*' };
  try {
    let res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { ...headers, Range: 'bytes=0-0' },
      });
    }
    // Um redirecionamento que tenha ido parar fora da lista também não serve.
    if (res.url && safeImageUrl(res.url) === null) return { verdict: 'dead', status: res.status };
    if (res.status === 200 || res.status === 206) return { verdict: 'ok', status: res.status };
    if (res.status === 429) return { verdict: 'unknown', status: res.status };
    return { verdict: 'dead', status: res.status };
  } catch {
    return { verdict: 'unknown', status: null };
  } finally {
    clearTimeout(timer);
  }
}

/** `inspectImage`'s verdict alone — the shape the repair waterfall wants. */
export async function classifyImage(url, fetchImpl = fetch) {
  return (await inspectImage(url, fetchImpl)).verdict;
}

const isLive = async (url) => (await classifyImage(url)) === 'ok';

/** Kitsu poster URL for an anime id, or null (best-effort; never throws). */
async function kitsuPoster(kitsuId) {
  await kitsuLimiter.wait();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${KITSU_API}/anime/${encodeURIComponent(kitsuId)}`, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.api+json' },
    });
    if (!res.ok) return null;
    return kitsuPosterFromResponse(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a WORKING, allow-listed cover for one row, or null. Walks the source
 * waterfall in preference order and validates (200) each candidate before
 * returning it. Every step is best-effort — a source failure just falls through.
 */
async function resolveCover(row, tvdb, manamiTitles) {
  const ids = row.external_ids ?? {};

  // 1) TheTVDB — preferred (reliable + already allow-listed).
  if (tvdb) {
    if (ids.tvdb != null) {
      try {
        const url = await tvdb.seriesImage(ids.tvdb);
        if (url && (await isLive(url))) return { url, source: 'tvdb:id' };
      } catch {
        /* best-effort */
      }
    }
  }

  // 2) manami por TITULO, a fonte que ja serve 990 de cada 1000 capas do
  //    catalogo, so que cruzada pelo nome em vez de por id.
  //
  //    Medido a 2026-08-22: das 254 series sem capa, 3 tinham mal_id e 243
  //    tinham entrada no manami com o mesmo titulo. Cruzar so por id deixava
  //    de fora 240 series, 26 delas a emitir e portanto no calendario.
  //
  //    Vem ANTES da busca por titulo no TVDB de proposito: e um acerto exato
  //    numa tabela em memoria contra uma chamada de rede que, na passagem
  //    anterior, resolveu 6 de 273. Mais preciso, e sem trafego nenhum.
  if (manamiTitles && row.title) {
    const hit = manamiTitles.get(normalizeTitleKey(row.title));
    if (hit?.picture && (await isLive(hit.picture))) {
      return { url: hit.picture, source: 'manami:title' };
    }
  }

  // 3) Busca por titulo no TVDB, o ultimo recurso que ainda faz rede.
  if (tvdb) {
    if (!NO_TVDB_SEARCH && row.title) {
      try {
        const found = await tvdb.searchSeries(row.title, row.year ?? undefined);
        if (found?.imageUrl && (await isLive(found.imageUrl))) {
          return { url: found.imageUrl, source: 'tvdb:search' };
        }
      } catch {
        /* best-effort */
      }
    }
  }

  // 4) AnimeSchedule image — only rows carrying an AnimeSchedule image route
  //    (a live-ingested show) can use this. The manami-catalogue rows this pass
  //    targets have no route, so there is nothing to fetch here; this tier is
  //    kept explicit for rows that later gain a route via the weekly pipeline.

  // 5) Kitsu poster CDN — the external-id CDN fallback.
  if (ids.kitsu != null) {
    const url = await kitsuPoster(ids.kitsu);
    if (url && (await isLive(url))) return { url, source: 'kitsu' };
  }

  return null;
}

// ── Supabase reads ───────────────────────────────────────────────────────────

const SELECT_COLS = 'id, title, year, popularity, external_ids, cover_image_url';

/** Page every row matching `apply`, calling `onPage(rows)` per page. */
async function pageAll(supabase, apply, onPage) {
  let from = 0;
  for (;;) {
    let q = supabase.from('animes').select(SELECT_COLS);
    q = apply(q).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) return;
    onPage(data);
    if (data.length < PAGE) return;
    from += PAGE;
  }
}

/** The always-broken set: NULL covers + manami placeholder covers, de-duplicated. */
async function fetchBrokenRows(supabase) {
  const rows = [];
  const seen = new Set();
  const add = (data) => {
    for (const r of data) if (!seen.has(r.id)) (seen.add(r.id), rows.push(r));
  };
  await pageAll(supabase, (q) => q.is('cover_image_url', null), add);
  await pageAll(supabase, (q) => q.eq('cover_image_url', MANAMI_NO_PIC), add);
  return rows;
}

/**
 * --revalidate: scan http covers in priority order and return the ones that are
 * DEFINITIVELY dead (classifyImage 'dead' — never on a transient failure). Stops
 * early once `cap` dead rows are found (LIMIT applies to the priority order, so
 * the scan need not read the whole catalogue). Deliberately opt-in: the dead
 * rate is ~0%, so a full scan is a lot of requests for a handful of repairs.
 */
async function fetchDeadCovers(supabase, cap) {
  const dead = [];
  let from = 0;
  outer: for (;;) {
    const { data, error } = await supabase
      .from('animes')
      .select(SELECT_COLS)
      .like('cover_image_url', 'http%')
      .neq('cover_image_url', MANAMI_NO_PIC)
      .order('popularity', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (let i = 0; i < data.length; i += REVALIDATE_CONCURRENCY) {
      const batch = data.slice(i, i + REVALIDATE_CONCURRENCY);
      const verdicts = await Promise.all(batch.map((r) => classifyImage(r.cover_image_url)));
      for (let k = 0; k < batch.length; k += 1) {
        if (verdicts[k] === 'dead') dead.push(batch[k]);
      }
      if (cap && dead.length >= cap) break outer;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return dead;
}

async function updateCover(supabase, id, url) {
  const { error } = await supabase.from('animes').update({ cover_image_url: url }).eq('id', id);
  if (error) throw error;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function assertConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}.\n` +
        '→ Local: fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in ingestion/.env or the repo-root .env.\n' +
        '→ CI: add them as GitHub Actions secrets.',
    );
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(
    `[nimu:covers] ${DRY_RUN ? 'DRY RUN (no writes)' : 'Cover repair'} starting…` +
      `${LIMIT ? ` (limit ${LIMIT})` : ''}${REVALIDATE ? ' +revalidate' : ''}`,
  );
  assertConfig();

  const { supabase } = await import('./supabase.js');

  // TVDB client is optional: without a key we simply skip the TVDB tiers.
  let tvdb = null;
  if (config.tvdbApiKey) {
    const { searchSeries, seriesImage } = await import('./tvdb.js');
    tvdb = { searchSeries, seriesImage };
  } else {
    console.log('[nimu:covers] TVDB tiers skipped (TVDB_API_KEY not set)');
  }

  // O indice de titulos do manami e opcional pela mesma razao que o TVDB: se a
  // descarga falhar, a passagem continua com as outras fontes em vez de morrer.
  // Carrega-se UMA vez e fica em memoria (41 537 entradas, 161 283 chaves).
  let manamiTitles = null;
  try {
    const entries = await loadManamiDatabase();
    manamiTitles = buildManamiTitleIndex(entries, { skipPicture: MANAMI_NO_PIC });
    console.log(`[nimu:covers] manami title index: ${manamiTitles.size} key(s)`);
  } catch (err) {
    console.log(`[nimu:covers] manami tier skipped (${err.message})`);
  }

  let affected = await fetchBrokenRows(supabase);
  console.log(`[nimu:covers] ${affected.length} broken cover(s): NULL or manami placeholder`);

  if (REVALIDATE) {
    const cap = LIMIT ? Math.max(0, LIMIT - affected.length) : null;
    const dead = cap === 0 ? [] : await fetchDeadCovers(supabase, cap);
    console.log(`[nimu:covers] --revalidate found ${dead.length} definitively dead cover URL(s)`);
    const seen = new Set(affected.map((r) => r.id));
    for (const r of dead) if (!seen.has(r.id)) affected.push(r);
  }

  affected = prioritize(affected);
  if (LIMIT && affected.length > LIMIT) {
    affected = affected.slice(0, LIMIT);
    console.log(`[nimu:covers] capped to ${affected.length} row(s) by --limit`);
  }

  const bySource = { 'tvdb:id': 0, 'tvdb:search': 0, kitsu: 0 };
  let repaired = 0;
  let nulledPlaceholder = 0; // placeholder rows with no cover anywhere → set NULL
  let leftNull = 0; // already NULL, nothing found → keeps typographic fallback
  let deadUnrepaired = 0; // --revalidate dead rows we couldn't replace (left as-is)

  let i = 0;
  for (const row of affected) {
    i += 1;
    const resolved = await resolveCover(row, tvdb, manamiTitles);
    if (resolved) {
      if (!DRY_RUN) await updateCover(supabase, row.id, resolved.url);
      repaired += 1;
      bySource[resolved.source] = (bySource[resolved.source] ?? 0) + 1;
    } else if (row.cover_image_url === MANAMI_NO_PIC) {
      if (!DRY_RUN) await updateCover(supabase, row.id, null);
      nulledPlaceholder += 1;
    } else if (row.cover_image_url == null) {
      leftNull += 1;
    } else {
      deadUnrepaired += 1; // a dead http cover with no replacement — leave it
    }
    if (i % 25 === 0 || i === affected.length) {
      console.log(
        `[nimu:covers] ${i}/${affected.length} — repaired ${repaired}, ` +
          `nulled ${nulledPlaceholder}, residual ${leftNull + deadUnrepaired}`,
      );
    }
  }

  const residual = nulledPlaceholder + leftNull + deadUnrepaired;
  console.log(
    `[nimu:covers] ${DRY_RUN ? '✅ Dry run' : '✅ Done'} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n` +
      `  scanned            : ${affected.length}\n` +
      `  repaired (real cover): ${repaired}  ` +
      `[tvdb:id ${bySource['tvdb:id']}, tvdb:search ${bySource['tvdb:search']}, kitsu ${bySource.kitsu}]\n` +
      `  placeholder → NULL : ${nulledPlaceholder}  (now show the typographic fallback cleanly)\n` +
      `  left NULL          : ${leftNull}\n` +
      `  dead, unrepaired   : ${deadUnrepaired}\n` +
      `  residual "no working cover": ${residual}`,
  );
}

// Run only when executed directly (`node src/covers.js`), not when imported by a
// test — so the pure helpers above stay unit-testable without side effects.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:covers] ❌ Cover repair failed:', error);
    process.exitCode = 1;
  });
}
