// Standalone driver: fold split multi-season franchises into ONE catalogue
// entry. AnimeSchedule emits one `animes` row per cour (Mushoku Tensei ×6,
// "That Time I Got Reincarnated as a Slime" ×5, …); TheTVDB models each whole
// franchise as ONE series with seasons + absolute numbering. This resolves the
// tvdb series id for the split rows, GROUPS the rows that share it, picks the
// origin cour as canonical, records the route→canonical aliases (+ per-cour
// offset/season), backfills the canonical with the full TVDB history, and folds
// every other member in via public.merge_anime_into — the shape the app already
// renders for One Piece (a single entry with a season dropdown).
//
//   node src/catalogue-franchises.js --dry-run          → fixtures only, no net/DB
//   node src/catalogue-franchises.js --title="Mushoku"  → fold one franchise (title ILIKE)
//   node src/catalogue-franchises.js --anime=<uuid>     → fold the franchise a given row belongs to
//   node src/catalogue-franchises.js --limit=50         → scan top-50 popular rows for splits
//   node src/catalogue-franchises.js                    → scan top-N popular rows (DEFAULT_LIMIT)
//   node src/catalogue-franchises.js --ids=a,b,c --tvdb=352408
//                                                       → operator-curated fold: an explicit row
//                                                         set pinned to a VERIFIED series id, for
//                                                         franchises whose split rows title-search
//                                                         unreliably (divergent EN/romaji names, or
//                                                         a correct id reachable from one season
//                                                         only). The air-date guard still applies.
//   ...any of the above, plus --plan-only              → REAL-DATA rehearsal: resolves, groups and
//                                                         plans against the live DB + TVDB but writes
//                                                         NOTHING (no tvdb persist, no renumber, no
//                                                         merge_anime_into). Prints the plan so you can
//                                                         eyeball it before the destructive run. Unlike
//                                                         --dry-run (fixture only), needs the live env.
//
// SAFETY: a fold NEVER happens on a title guess. Two rows merge only when they
// resolve to the SAME tvdb series id AND their episodes air-date-align to that
// series; a row that shares the id but whose episodes don't line up is left
// alone and logged. Idempotent: victims are gone after the first run, so a
// re-run finds nothing left to fold. The DB half (anime_route_aliases,
// merge_anime_into, anime_franchise_size) is migration 20260731001000.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';
import { chunk } from './util.js';
import { fetchAllEpisodes, normalizeEpisodes, mergeEpisodeRows } from './tvdb-episodes.js';
import {
  baseFranchiseTitle,
  bestCanonicalMetadata,
  groupByTvdbId,
  planFranchise,
  tvdbIdOf,
  victimRenumberSteps,
} from './franchise.js';

const EPISODE_UPSERT_CHUNK = 500;
const READ_PAGE = 1000; // PostgREST caps a SELECT at 1000 rows — page past it.
const DEFAULT_LIMIT = 300;
const ALIGN_TOLERANCE_DAYS = 4; // air-date match slack (sub vs broadcast / TZ)
const MIN_FRANCHISE_SEASONS = 2; // a fold target must be a genuine multi-season series

const DRY_RUN = process.argv.includes('--dry-run');
// --plan-only: um ENSAIO com dados REAIS. Faz tudo o que o --live faz (seleciona,
// resolve o tvdb por pesquisa, agrupa, planeia o fold) MAS nao escreve UMA linha:
// nem persiste tvdb ids, nem renumera, nem chama merge_anime_into (que apaga a
// vitima). So imprime o que FARIA. E a rede de seguranca antes de uma operacao
// destrutiva: ve-se o plano, confirma-se, e so depois se corre a serio. Ao
// contrario do --dry-run (que so corre a fixture do One Piece), este toca na base
// e na TVDB de leitura, portanto precisa das mesmas env vars do --live.
const PLAN_ONLY = process.argv.includes('--plan-only');

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../test/fixtures');

const log = (msg) => console.log(`[nimu:franchise] ${msg}`);
const warn = (msg) => console.warn(`[nimu:franchise] ⚠ ${msg}`);

/** Read a `--name=value` CLI flag, or null when absent. */
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** `--limit=N` (positive int), else DEFAULT_LIMIT. */
function parseLimit() {
  const n = Number.parseInt(argValue('limit') ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// ── Candidate selection ──────────────────────────────────────────────────────
// Grouping needs tvdb ids on the candidate rows, but most rows don't carry one
// yet, and resolving all ~30k is out of the question for a bounded run. So we
// pick a small candidate SET first, resolve the missing ids only for those,
// then group. Three ways to scope the set:
//   --title=<substr>  every row whose title ILIKE %substr% (a named franchise)
//   --anime=<uuid>    the given row + its franchise siblings by title prefix
//   (default)         top-N rows by popularity (--limit)

const ANIME_COLS =
  'id, title, animeschedule_route, external_ids, popularity, year, score, cover_image_url, description';

/** Rows whose title matches an ILIKE substring (a named franchise scan). */
async function selectByTitle(supabase, title, limit) {
  const { data, error } = await supabase
    .from('animes')
    .select(ANIME_COLS)
    .ilike('title', `%${title}%`)
    .order('popularity', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * The given row plus its likely franchise siblings. We can't know siblings by
 * tvdb id yet (unresolved), so we seed from the row's leading title word(s) —
 * "Mushoku Tensei: …" → siblings matching "Mushoku Tensei". The shared-tvdb-id +
 * air-date gates downstream discard any false sibling this wide net catches.
 */
async function selectByAnime(supabase, animeId, limit) {
  const { data: seedRows, error: seedErr } = await supabase
    .from('animes')
    .select(ANIME_COLS)
    .eq('id', animeId)
    .limit(1);
  if (seedErr) throw seedErr;
  const seed = (seedRows ?? [])[0];
  if (!seed) return [];
  // First two words of the title are a good, cheap franchise stem.
  const stem = String(seed.title ?? '').split(/[\s:—-]+/).filter(Boolean).slice(0, 2).join(' ');
  if (!stem) return [seed];
  const siblings = await selectByTitle(supabase, stem, limit);
  const byId = new Map(siblings.map((r) => [r.id, r]));
  byId.set(seed.id, seed); // ensure the seed itself is present
  return [...byId.values()];
}

/** Top-N rows by popularity (the un-scoped default scan). */
async function selectTopPopular(supabase, limit) {
  const { data, error } = await supabase
    .from('animes')
    .select(ANIME_COLS)
    .order('popularity', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * An explicit, operator-curated uuid list (`--ids=a,b,c`). The escape hatch for
 * the real-world cases where title search is unreliable: a franchise whose split
 * rows use divergent English/romaji titles, or whose correct TVDB series id is
 * only reachable from ONE season's title — pair with `--tvdb=<id>` to pin the
 * verified id on exactly these rows. Membership is the operator's assertion; the
 * air-date guard still runs, so an episode-bearing row that doesn't actually
 * belong is still excluded.
 */
async function selectByIds(supabase, ids) {
  const clean = ids.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return [];
  const { data, error } = await supabase.from('animes').select(ANIME_COLS).in('id', clean);
  if (error) throw error;
  return data ?? [];
}

/**
 * Pin an operator-verified TVDB series id (`--tvdb=<id>`) on every candidate,
 * skipping the title-search resolution entirely. Use when the automated cascade
 * would land on a wrong/duplicate series (e.g. TheTVDB carries both a full
 * multi-season series and a single-season stub under similar names, and search
 * ranks the stub first). Persists the id (merged into external_ids) and reflects
 * it in memory. Idempotent.
 */
async function pinTvdbId(supabase, rows, tvdbId) {
  let pinned = 0;
  for (const row of rows) {
    if (tvdbIdOf(row) === tvdbId) continue;
    const external_ids = { ...(row.external_ids ?? {}), tvdb: tvdbId };
    if (!PLAN_ONLY) {
      const { error } = await supabase.from('animes').update({ external_ids }).eq('id', row.id);
      if (error) throw error;
    }
    row.external_ids = external_ids; // reflect in memory (grouping + preview alike)
    pinned += 1;
  }
  log(`--tvdb=${tvdbId}: ${PLAN_ONLY ? 'would pin' : 'pinned'} verified series id on ${pinned}/${rows.length} candidate row(s)`);
}

// ── TVDB id resolution ───────────────────────────────────────────────────────

/**
 * Resolve ONE title to a tvdb series id with a franchise-aware cascade. A later
 * cour's own title+year never matches the franchise series (whose year is season
 * 1's), so we try, in order of decreasing precision:
 *   1. (title, year)      — exact, best for the season-1 row,
 *   2. (title)            — drops the year filter (finds the series for a later cour),
 *   3. (baseFranchiseTitle) — strips the season/part ordinal to the root title.
 * The first hit wins. Duplicate queries are skipped. Returns a tvdbId or null.
 */
async function resolveSeriesId(searchSeries, title, year) {
  const base = baseFranchiseTitle(title);
  const attempts = [
    [title, year],
    [title, undefined],
    [base, undefined],
  ];
  const seen = new Set();
  for (const [q, y] of attempts) {
    if (!q) continue;
    const key = `${q} ${y ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = await searchSeries(q, y ?? undefined);
    if (found?.tvdbId) return found.tvdbId;
  }
  return null;
}

/**
 * Fill missing external_ids.tvdb for the candidate rows via the cascade above,
 * persisting each hit (merged into external_ids, never erasing sibling ids) and
 * reflecting it in memory so the group step sees it. Rate-limited by the shared
 * TVDB limiter. Idempotent: rows that already carry a tvdb id are skipped.
 */
async function resolveMissingTvdbIds(supabase, rows) {
  const { searchSeries } = await import('./tvdb.js');
  let resolved = 0;
  for (const row of rows) {
    if (tvdbIdOf(row) !== null) continue; // already known
    if (!row.title) continue;
    try {
      const tvdbId = await resolveSeriesId(searchSeries, row.title, row.year ?? undefined);
      if (!tvdbId) continue;
      const external_ids = { ...(row.external_ids ?? {}), tvdb: tvdbId };
      if (!PLAN_ONLY) {
        const { error } = await supabase.from('animes').update({ external_ids }).eq('id', row.id);
        if (error) throw error;
      }
      row.external_ids = external_ids; // reflect in memory for grouping (preview included)
      resolved += 1;
    } catch (err) {
      warn(`resolve failed for "${row.title}" (non-fatal): ${err.message}`);
    }
  }
  log(`${PLAN_ONLY ? 'would resolve' : 'resolved'} ${resolved} missing tvdb id(s) across ${rows.length} candidate row(s)`);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/** All episodes for one anime (paged past PostgREST's 1000-row cap). */
const MAX_EPISODE_ROWS = 5000; // sanity cap, mirrors web/lib/data/animes.ts
async function readEpisodes(supabase, animeId) {
  const out = [];
  for (let from = 0; from < MAX_EPISODE_ROWS; from += READ_PAGE) {
    const { data, error } = await supabase
      .from('episodes')
      .select('episode_number, airing_at, streaming_links, season_number')
      .eq('anime_id', animeId)
      .order('episode_number', { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < READ_PAGE) break;
  }
  return out;
}

/** Batched episode upsert on the (anime_id, episode_number) conflict key. */
async function upsertEpisodes(supabase, rows) {
  for (const batch of chunk(rows, EPISODE_UPSERT_CHUNK)) {
    const { error } = await supabase
      .from('episodes')
      .upsert(batch, { onConflict: 'anime_id,episode_number' });
    if (error) throw error;
  }
}

/** Upsert the route→canonical alias records (PK animeschedule_route). */
async function upsertAliases(supabase, aliases) {
  if (aliases.length === 0) return;
  const { error } = await supabase
    .from('anime_route_aliases')
    .upsert(aliases, { onConflict: 'animeschedule_route' });
  if (error) throw error;
}

/**
 * Renumber one victim's episodes onto the canonical absolute timeline, in place
 * (UPDATE, so ids — and the watched_episodes marks keyed on them — survive), in
 * a collision-safe order. offset 0 with an unknown season is a no-op.
 */
async function renumberVictimEpisodes(supabase, victimId, episodes, offset, season) {
  if (offset === 0 && season == null) return 0;
  const steps = victimRenumberSteps(episodes, offset, season);
  let moved = 0;
  for (const step of steps) {
    if (step.from === step.to && season == null) continue;
    const { error } = await supabase
      .from('episodes')
      .update({ episode_number: step.to, season_number: step.season })
      .eq('anime_id', victimId)
      .eq('episode_number', step.from);
    if (error) throw error;
    moved += 1;
  }
  return moved;
}

/**
 * Shift a row's watchlist progress pointer by the same offset its episodes were
 * renumbered by, so `watchlist.last_watched_episode` (a bare episode number)
 * keeps pointing at the SAME episode on the canonical absolute timeline. Without
 * this, a follower who was "up to per-cour episode 5" would look like they had
 * stopped at absolute episode 5 (a season-1 episode) after the fold. Precise
 * per-episode history (watched_episodes, keyed on episodes.id) is already safe —
 * this only keeps the rough progress counter honest. A single cour's follower
 * set is small, so per-row updates are fine.
 */
async function shiftWatchlistProgress(supabase, animeId, offset) {
  if (!Number.isInteger(offset) || offset === 0) return 0;
  const { data, error } = await supabase
    .from('watchlist')
    .select('user_id, last_watched_episode')
    .eq('anime_id', animeId)
    .gt('last_watched_episode', 0);
  if (error) throw error;
  let n = 0;
  for (const w of data ?? []) {
    const { error: upErr } = await supabase
      .from('watchlist')
      .update({ last_watched_episode: w.last_watched_episode + offset })
      .eq('anime_id', animeId)
      .eq('user_id', w.user_id);
    if (upErr) throw upErr;
    n += 1;
  }
  return n;
}

/** public.anime_franchise_size(canonical) — distinct season count (dropdown size). */
async function franchiseSize(supabase, canonicalId) {
  const { data, error } = await supabase.rpc('anime_franchise_size', { p_canonical: canonicalId });
  if (error) throw error;
  return Number(data ?? 0);
}

// ── Execute one planned fold ─────────────────────────────────────────────────

/**
 * Carry out a single group's fold against the DB, then report it. Order matters:
 *   1. renumber each victim's episodes to absolute (preserving ids),
 *   2. write the aliases (so a mid-run crash still routes the weekly pipeline),
 *   3. merge_anime_into(canonical, victim) — moves user data + the renumbered
 *      episodes onto the canonical and deletes the victim row,
 *   4. backfill the canonical from the full TVDB history LAST, so mergeEpisodeRows
 *      keeps the streaming_links/precise airing that rode in from the cours while
 *      stamping every absolute episode with its season/title/overview/image and
 *      inserting whatever episodes nobody had yet (the dropdown's full spine).
 */
async function executeFold(supabase, plan, tvdbEpisodes, episodesByAnimeId, memberRows) {
  const { canonical, victims, aliases } = plan;
  log(
    `tvdb ${plan.tvdbId}: canonical "${canonical.title}" (${canonical.id}, route=${canonical.route}, ` +
      `offset ${canonical.alignment.episodeOffset}, season ${canonical.alignment.seasonNumber ?? '—'}) ` +
      `← folding ${victims.length} member(s)`,
  );

  await upsertAliases(supabase, aliases);

  // Carry the richest member's popularity/synopsis onto the canonical BEFORE the
  // victims are deleted, so the folded entry stays as discoverable as its best
  // cour (the origin is often a metadata stub). Only improving fields are written.
  const canonicalRow = (memberRows ?? []).find((r) => r.id === canonical.id) ?? {};
  const patch = bestCanonicalMetadata(canonicalRow, memberRows ?? []);
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from('animes').update(patch).eq('id', canonical.id);
    if (error) throw error;
    log(`  enriched canonical from members: ${Object.keys(patch).join(', ')}`);
  }

  // Defensive: if the canonical is (unusually) a non-origin cour, its OWN
  // episodes are still at per-cour numbers — renumber them onto the absolute
  // timeline too, else the TVDB backfill below would preserve them at the wrong
  // (season-1) absolute slots. The normal origin canonical is offset 0 → no-op.
  if (canonical.alignment.matched && canonical.alignment.episodeOffset !== 0) {
    const ceps = episodesByAnimeId.get(canonical.id) ?? [];
    const moved = await renumberVictimEpisodes(
      supabase, canonical.id, ceps, canonical.alignment.episodeOffset, canonical.alignment.seasonNumber,
    );
    await shiftWatchlistProgress(supabase, canonical.id, canonical.alignment.episodeOffset);
    warn(`  canonical is a non-origin cour — renumbered its own ${moved} episode(s) +${canonical.alignment.episodeOffset}`);
  }

  for (const victim of victims) {
    const veps = episodesByAnimeId.get(victim.id) ?? [];
    const off = victim.alignment.matched ? victim.alignment.episodeOffset : 0;
    if (victim.alignment.matched) {
      const moved = await renumberVictimEpisodes(
        supabase, victim.id, veps, off, victim.alignment.seasonNumber,
      );
      const shifted = await shiftWatchlistProgress(supabase, victim.id, off);
      log(
        `  merge victim "${victim.title}" (${victim.id}, route=${victim.route}): ` +
          `${moved} episode(s) renumbered +${off} → season ${victim.alignment.seasonNumber ?? '—'}` +
          `${shifted ? `, ${shifted} watchlist progress shifted` : ''}`,
      );
    } else {
      warn(
        `  victim "${victim.title}" (${victim.id}, route=${victim.route}) shares tvdb ${plan.tvdbId} ` +
          `but has no dated episodes to align — folding at offset 0 (alias season unknown)`,
      );
    }
    const { error } = await supabase.rpc('merge_anime_into', {
      p_canonical: canonical.id,
      p_victim: victim.id,
    });
    if (error) throw error;
  }

  // Backfill the canonical from the full TVDB history (absolute #s + seasons).
  const existing = await readEpisodes(supabase, canonical.id);
  const { rows, inserts, updates } = mergeEpisodeRows(canonical.id, tvdbEpisodes, existing);
  await upsertEpisodes(supabase, rows);

  const size = await franchiseSize(supabase, canonical.id);
  log(
    `  ✅ "${canonical.title}": folded ${victims.length} member(s), backfilled ` +
      `${tvdbEpisodes.length} TVDB episode(s) (${inserts} new, ${updates} updated) → ` +
      `${size} season(s) in the dropdown`,
  );
  return { canonicalId: canonical.id, canonicalTitle: canonical.title, folded: victims.length, seasons: size };
}

// ── Preview one planned fold (--plan-only): logs, never writes ───────────────

/**
 * O gémeo de `executeFold` para `--plan-only`: diz o que FARIA, sem tocar na
 * base. Lê tudo da memória (o plano, os episódios já lidos, a história TVDB) e
 * não chama uma única escrita — nem `merge_anime_into` (que apagaria a vítima),
 * nem renumeração, nem upsert. O tamanho do dropdown vem ESTIMADO pelas
 * temporadas distintas da TVDB (só o backfill o carimbaria ao certo), por isso
 * marcado com "~".
 */
function previewFold(plan, tvdbEpisodes, episodesByAnimeId, memberRows) {
  const { canonical, victims, aliases } = plan;
  log(
    `[plan] tvdb ${plan.tvdbId}: canonical "${canonical.title}" (${canonical.id}, route=${canonical.route}, ` +
      `offset ${canonical.alignment.episodeOffset}, season ${canonical.alignment.seasonNumber ?? '—'}) ` +
      `← would fold ${victims.length} member(s)`,
  );
  log(`[plan]   would upsert ${aliases.length} route alias(es)`);

  const canonicalRow = (memberRows ?? []).find((r) => r.id === canonical.id) ?? {};
  const patch = bestCanonicalMetadata(canonicalRow, memberRows ?? []);
  if (Object.keys(patch).length > 0) {
    log(`[plan]   would enrich canonical from members: ${Object.keys(patch).join(', ')}`);
  }

  for (const victim of victims) {
    const veps = episodesByAnimeId.get(victim.id) ?? [];
    if (victim.alignment.matched) {
      log(
        `[plan]   would merge victim "${victim.title}" (${victim.id}, route=${victim.route}): ` +
          `${veps.length} episode(s) renumbered +${victim.alignment.episodeOffset} → ` +
          `season ${victim.alignment.seasonNumber ?? '—'}, then DELETE the victim row`,
      );
    } else {
      warn(
        `[plan]   victim "${victim.title}" (${victim.id}, route=${victim.route}) shares tvdb ${plan.tvdbId} ` +
          'but has no dated episodes to align — would fold at offset 0 (alias season unknown)',
      );
    }
  }

  const seasons = new Set(
    tvdbEpisodes.map((e) => e.seasonNumber).filter((s) => Number.isInteger(s) && s > 0),
  ).size;
  log(
    `[plan]   would backfill canonical with ${tvdbEpisodes.length} TVDB episode(s) → ` +
      `~${seasons} season(s) in the dropdown`,
  );
  return { canonicalId: canonical.id, canonicalTitle: canonical.title, folded: victims.length, seasons };
}

// ── Live run ─────────────────────────────────────────────────────────────────

async function runLive() {
  const missing = [
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.supabaseServiceRoleKey],
    ['TVDB_API_KEY', config.tvdbApiKey],
  ]
    .filter(([, v]) => !v)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        'Set them (ingestion/.env locally, or CI secrets), or use --dry-run.',
    );
  }

  const { supabase } = await import('./supabase.js');
  const title = argValue('title');
  const animeId = argValue('anime');
  const idsArg = argValue('ids');
  const tvdbOverride = Number.parseInt(argValue('tvdb') ?? '', 10);
  const limit = parseLimit();
  // Operator-curated folds (explicit ids and/or a pinned verified id) have
  // vouched for membership; search-based scans must be episode-anchored.
  const requireAnchor = !(idsArg || (Number.isInteger(tvdbOverride) && tvdbOverride > 0));

  // 1) candidate set
  let candidates;
  if (idsArg) candidates = await selectByIds(supabase, idsArg.split(','));
  else if (title) candidates = await selectByTitle(supabase, title, limit);
  else if (animeId) candidates = await selectByAnime(supabase, animeId, limit);
  else candidates = await selectTopPopular(supabase, limit);
  log(
    `${candidates.length} candidate row(s) ` +
      `${idsArg ? '(explicit --ids list)' : title ? `(title ILIKE "%${title}%")` : animeId ? `(anime=${animeId} + siblings)` : `(top ${limit} by popularity)`}`,
  );
  if (candidates.length === 0) return { folds: [] };

  // 2) resolve (or pin an operator-verified id), then 3) group by tvdb series id
  if (Number.isInteger(tvdbOverride) && tvdbOverride > 0) {
    await pinTvdbId(supabase, candidates, tvdbOverride);
  } else {
    await resolveMissingTvdbIds(supabase, candidates);
  }
  const groups = groupByTvdbId(candidates);
  const splitGroups = [...groups.entries()].filter(([, rows]) => rows.length >= 2);
  log(
    `${groups.size} distinct tvdb series across candidates; ` +
      `${splitGroups.length} appear split (≥2 rows) and are fold candidates`,
  );

  // 4) plan + execute per group
  const results = [];
  for (const [tvdbId, rows] of splitGroups) {
    try {
      const tvdbEpisodes = await fetchAllEpisodes(tvdbId);
      if (tvdbEpisodes.length === 0) {
        warn(`tvdb ${tvdbId}: no episodes from TVDB — skipped (cannot align/backfill)`);
        continue;
      }
      // Multi-season guard: a genuine franchise (the thing that needs a dropdown)
      // spans ≥2 TVDB seasons. This refuses to fold a group into a single-season
      // STUB / duplicate series id (a real hazard — e.g. TheTVDB carries both a
      // full 4-season Slime series and a 1-season 12-episode stub, and a loose
      // title search can land on the stub). Skipping keeps the split rows intact
      // rather than collapsing them onto a broken 1-season canonical.
      const seasonCount = new Set(
        tvdbEpisodes.map((e) => e.seasonNumber).filter((s) => Number.isInteger(s) && s > 0),
      ).size;
      if (seasonCount < MIN_FRANCHISE_SEASONS) {
        warn(
          `tvdb ${tvdbId}: only ${seasonCount} season(s) in TVDB (${tvdbEpisodes.length} eps) — ` +
            'looks like a single-cour/stub series, NOT folding (guards against a duplicate id)',
        );
        continue;
      }
      const episodesByAnimeId = new Map();
      for (const row of rows) episodesByAnimeId.set(row.id, await readEpisodes(supabase, row.id));

      const plan = planFranchise({
        tvdbId,
        members: rows,
        episodesByAnimeId,
        tvdbEpisodes,
        toleranceDays: ALIGN_TOLERANCE_DAYS,
        requireAnchor, // search-based scans must be episode-anchored; curated folds vouch
      });
      for (const ex of plan.excluded) {
        warn(
          `tvdb ${tvdbId}: NOT folding "${ex.title}" (${ex.id}) — ${ex.reason}; ` +
            'likely a wrong title-search hit, left as its own entry',
        );
      }
      if (!plan.folded) {
        log(`tvdb ${tvdbId}: nothing to fold${plan.reason ? ` — ${plan.reason}` : ' after guards (needs ≥2 members)'}`);
        continue;
      }
      results.push(
        PLAN_ONLY
          ? previewFold(plan, tvdbEpisodes, episodesByAnimeId, rows)
          : await executeFold(supabase, plan, tvdbEpisodes, episodesByAnimeId, rows),
      );
    } catch (err) {
      warn(`tvdb ${tvdbId} failed (non-fatal): ${err.message}`);
    }
  }

  log('── summary ──────────────────────────────────────────────');
  for (const r of results) {
    log(`${r.canonicalTitle}: ${r.folded} row(s) ${PLAN_ONLY ? 'would fold' : 'folded'} → ${r.seasons} season(s)`);
  }
  log(
    PLAN_ONLY
      ? `✅ ${results.length} franchise(s) to fold — PLAN ONLY, nothing was written`
      : `✅ ${results.length} franchise(s) folded`,
  );
  return { folds: results };
}

// ── Dry run (fixtures, no network / no DB) ───────────────────────────────────
// Builds a self-contained One Piece scenario from the TVDB fixture + two
// synthetic member rows (an origin cour + a later cour) to prove grouping,
// air-date alignment, canonical selection and the fold PLAN end-to-end — without
// touching the network or Supabase.

async function runDryRun() {
  const payload = JSON.parse(await readFile(resolve(FIXTURES_DIR, 'tvdb-episodes.json'), 'utf8'));
  const raw = payload?.data?.episodes ?? payload?.episodes ?? payload;
  const tvdbEpisodes = normalizeEpisodes(raw); // One Piece: abs 1(s1), 2(s1), 62(s2), 999(s0)

  // Two split catalogue rows that BOTH resolve to the same tvdb series (81797):
  // an origin cour (per-cour eps 1,2 → absolute 1,2, offset 0, season 1) and a
  // later cour (per-cour ep 1 → absolute 62, offset 61, season 2).
  const members = [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'One Piece', animeschedule_route: 'one-piece', popularity: 999, year: 1999, external_ids: { tvdb: 81797 } },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', title: 'One Piece: Arabasta', animeschedule_route: 'one-piece-arabasta', popularity: 500, year: 2001, external_ids: { tvdb: 81797 } },
  ];
  const episodesByAnimeId = new Map([
    [members[0].id, [
      { episode_number: 1, airing_at: '1999-10-20T09:00:00.000Z', streaming_links: [] },
      { episode_number: 2, airing_at: '1999-11-17T09:00:00.000Z', streaming_links: [] },
    ]],
    [members[1].id, [
      { episode_number: 1, airing_at: '2001-01-14T09:00:00.000Z', streaming_links: [{ platform: 'Crunchyroll', url: 'https://cr/op62' }] },
    ]],
  ]);

  const groups = groupByTvdbId(members);
  const plan = planFranchise({ tvdbId: 81797, members, episodesByAnimeId, tvdbEpisodes, toleranceDays: ALIGN_TOLERANCE_DAYS });

  log('DRY RUN (fixtures, no writes) — franchise grouping');
  log(`grouped ${members.length} rows → ${groups.size} tvdb series; group 81797 has ${groups.get(81797)?.length ?? 0} members`);
  log(`canonical: "${plan.canonical.title}" (route=${plan.canonical.route}, offset ${plan.canonical.alignment.episodeOffset}, season ${plan.canonical.alignment.seasonNumber})`);
  for (const v of plan.victims) {
    log(`victim: "${v.title}" (route=${v.route}) → offset ${v.alignment.episodeOffset}, season ${v.alignment.seasonNumber}, matched=${v.alignment.matched}`);
  }
  const seasons = [...new Set(tvdbEpisodes.map((e) => e.seasonNumber))].sort((a, b) => a - b);
  log(`would write ${plan.aliases.length} route alias(es), call merge_anime_into ${plan.victims.length} time(s)`);
  log(`would backfill canonical with ${tvdbEpisodes.length} TVDB episode(s) spanning season(s) ${seasons.join(', ')} (dropdown)`);
  log('✅ Dry run OK — nothing written');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  log(`${DRY_RUN ? 'DRY RUN' : 'Live fold'} starting…`);
  if (DRY_RUN) await runDryRun();
  else await runLive();
  log(`finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

// Run only when executed directly, so the fixtures-free helpers stay importable
// by tests without kicking off a run.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:franchise] ❌ Fold failed:', error);
    process.exitCode = 1;
  });
}
