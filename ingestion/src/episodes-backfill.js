// Episódios para tudo: o backfill do catálogo inteiro.
//
//   npm run episodes:backfill                         → SIMULAÇÃO (só leituras)
//   npm run episodes:backfill -- --aplicar            → escreve (service role)
//   … --limite=500                                    → no máximo 500 títulos nesta corrida
//   … --desde=<uuid>                                  → retoma depois deste id
//   … --do-inicio                                     → ignora o cursor guardado
//   … --anime=<uuid ou slug>                          → um só título
//   … --fontes=animeschedule,kitsu,tvdb               → só estas fontes
//   … --relatorio=caminho.json                        → grava o relatório em JSON
//   … --minutos=45                                    → teto de relógio desta corrida (ver abaixo)
//   … --supor-migracao                                → (só simulação) planeia como se a
//                                                       migração 20261104000100 já estivesse aplicada
//
// ## Porque existe (2026-11-04)
//
// "Temos de ter episódios para tudo. Se algo não tem episódios, é porque está
// confirmado mas ainda não começou." Nesse dia 98,6% dos terminados não tinham
// um único episódio: a ingestão semanal (run.js) só vê a janela de semanas à
// volta de hoje, e o catálogo do manami (catalogue.js) só traz a ficha.
//
// As fontes e a ordem estão em episode-sources.js; as regras de escrita em
// episode-merge.js. Aqui ficam os pedidos (com cache e ritmo), o cursor e a
// escrita.
//
// ## Seguro de repetir
//
//  - Simulação por omissão. Escrever pede `--aplicar` E a service role.
//  - Idempotente: uma segunda corrida não encontra nada para escrever.
//  - Retomável: os títulos andam por ordem de id e o cursor (o último id
//    tratado) fica em `.cache/episodes/cursor.json` depois de cada lote, por
//    isso uma corrida cortada a meio continua onde parou.
//  - Em lotes: 100 títulos por leitura de episódios, 500 linhas por escrita.
//  - Com teto de relógio (`--minutos`, contado desde o arranque): quando se
//    esgota, a corrida acaba o lote em curso, deixa o cursor no último título
//    tratado e sai com sucesso. O workflow dá 45 minutos, para a ingestão de 6
//    em 6 horas (o mesmo grupo de `concurrency`) nunca esperar mais de uma hora.
//  - Nunca duplica (on conflict do nothing na chave única), nunca troca uma
//    data por uma pior, nunca toca num episódio com data futura, e nunca chama
//    a distribuição de avisos (os episódios antigos não avisam ninguém).
//
// ## Ritmo e termos
//
//  - AnimeSchedule: o mesmo token de leitura da ingestão, ~70 pedidos/min (o
//    teto deles é 120 e o cron das 6 h também conta). As semanas passadas não
//    mudam e ficam em cache para sempre; o catálogo, uma semana.
//  - Kitsu: API pública sem chave e sem limite publicado; 2 pedidos/s, com o
//    User-Agent da ingestão. Guarda-se só o número e o dia de cada episódio
//    (factos), em cache 30 dias. Os termos do site remetem os da API para
//    "pedido": ver o relatório do PR.
//  - TVDB: o mesmo cliente (e o mesmo ritmo) do catalogue-episodes.js.
//  - AniList: não se usa (os termos proíbem guardar os dados).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { USER_AGENT, config } from './config.js';
import { fetchJson, RateLimiter } from './http.js';
import {
  animescheduleCatalogueIndex,
  animescheduleHistoryIndex,
  compactCatalogueEntry,
  compactKitsuEpisode,
  compactTimetableEntry,
  dayToIso,
  kitsuEpisodesIndex,
  plausibleKitsuIndex,
  tvdbEpisodesIndex,
} from './episode-sources.js';
import { addCounts, planAnimeEpisodes, wouldBeExtra } from './episode-merge.js';
import { manamiByMalIndex } from './reclassify-extras.js';
import { chunk, isoWeek } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(here, '../.cache/episodes');
// Um cursor para a escrita e outro para a simulação: simular não pode fazer a
// escrita saltar títulos.
const cursorFile = (apply) => resolve(CACHE_DIR, apply ? 'cursor.json' : 'cursor-simulacao.json');

/**
 * A primeira semana em que o AnimeSchedule responde com calendário: 2021-W41
 * (11 de outubro de 2021). Medido a 2026-11-04 a partir do runner (ramo
 * auditoria/episodios-2026-11-04, pesquisa binária semana a semana): a W40
 * responde 404, a W41 traz 88 entradas, e daí até hoje não falta nenhuma
 * semana (59 372 entradas sub + raw). Pode passar-se outra com
 * `--historico-desde=AAAA-Wss`.
 */
export const HISTORY_START = { year: 2021, week: 41 };

const AS_BASE = 'https://animeschedule.net/api/v3';
const KITSU_BASE = 'https://kitsu.app/api/edge';
const DAY_MS = 86_400_000;
const PAGE = 1000;
const BATCH = 100;
const WRITE_CHUNK = 500;
const DEFAULT_LIMIT = 30_000;
const CATALOGUE_TTL_MS = 7 * DAY_MS;
const KITSU_TTL_MS = 30 * DAY_MS;
/** Bytes por episódio na base, com os índices (ver o relatório de volume). */
export const BYTES_PER_EPISODE = 260;
export const BYTES_PER_STREAM_LINKS = 120;

const asLimiter = new RateLimiter(850);
const kitsuLimiter = new RateLimiter(500);

// ── CLI ─────────────────────────────────────────────────────────────────────

function positiveNumber(raw) {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const limit = Number.parseInt(get('limite') ?? '', 10);
  const sources = (get('fontes') ?? 'animeschedule,kitsu,tvdb').split(',').map((s) => s.trim()).filter(Boolean);
  const hist = /^(\d{4})-W(\d{1,2})$/.exec(get('historico-desde') ?? '');
  return {
    apply: argv.includes('--aplicar'),
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    since: get('desde'),
    fromStart: argv.includes('--do-inicio'),
    anime: get('anime'),
    assumeMigration: argv.includes('--supor-migracao'),
    sources: new Set(sources),
    report: get('relatorio'),
    minutes: positiveNumber(get('minutos')),
    historyStart: hist ? { year: Number(hist[1]), week: Number(hist[2]) } : HISTORY_START,
  };
}

// ── Cache em disco ──────────────────────────────────────────────────────────

async function readCache(file, maxAgeMs = Infinity) {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > maxAgeMs) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// ── Semanas ISO ─────────────────────────────────────────────────────────────

function isoWeeksInYear(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
}

/** Todas as semanas de `start` até à semana de `now`, inclusive. */
export function weeksFrom(start, now = new Date()) {
  const end = isoWeek(now);
  const out = [];
  for (let y = start.year; y <= end.year; y += 1) {
    const first = y === start.year ? start.week : 1;
    const last = y === end.year ? end.week : isoWeeksInYear(y);
    for (let w = first; w <= last; w += 1) out.push({ year: y, week: w });
  }
  return out;
}

// ── AnimeSchedule ───────────────────────────────────────────────────────────

function asHeaders() {
  return { Authorization: `Bearer ${config.animescheduleToken}` };
}

async function asGet(path, label) {
  try {
    return await fetchJson(`${AS_BASE}${path}`, { label, headers: asHeaders(), limiter: asLimiter });
  } catch (err) {
    // 404: a semana não existe no histórico deles. Fica registado como vazio.
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

/** O catálogo do AnimeSchedule, compacto, em cache uma semana. */
async function loadAnimescheduleCatalogue(log) {
  const file = resolve(CACHE_DIR, 'as-catalogue.json');
  const cached = await readCache(file, CATALOGUE_TTL_MS);
  if (cached) {
    log(`[nimu:eps] AnimeSchedule: catálogo da cache (${cached.length} fichas)`);
    return cached;
  }
  const out = [];
  let total = Infinity;
  for (let page = 1; (page - 1) * 18 < total && page <= 2000; page += 1) {
    const json = await asGet(`/anime?page=${page}`, `AnimeSchedule anime page ${page}`);
    if (!json) break;
    total = Number(json.totalAmount) || total;
    const list = Array.isArray(json.anime) ? json.anime : [];
    if (list.length === 0) break;
    out.push(...list.map(compactCatalogueEntry));
    if (page % 100 === 0) log(`[nimu:eps] AnimeSchedule: catálogo, página ${page} (${out.length} fichas)`);
  }
  await writeCache(file, out);
  log(`[nimu:eps] AnimeSchedule: catálogo lido (${out.length} fichas)`);
  return out;
}

/**
 * As semanas do histórico, cada uma `{ sub, raw }`. Uma semana com mais de
 * quatro semanas já não muda: fica em cache para sempre. As recentes, um dia.
 */
async function loadAnimescheduleHistory(start, now, log) {
  const weeks = weeksFrom(start, now);
  const out = [];
  let fetched = 0;
  const recentFrom = Date.now() - 35 * DAY_MS;
  for (const { year, week } of weeks) {
    const file = resolve(CACHE_DIR, 'as-weeks', `${year}-W${String(week).padStart(2, '0')}.json`);
    const monday = Date.UTC(year, 0, 4) - ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) * DAY_MS + (week - 1) * 7 * DAY_MS;
    const cached = await readCache(file, monday < recentFrom ? Infinity : DAY_MS);
    if (cached) {
      out.push(cached);
      continue;
    }
    const entry = { year, week, sub: [], raw: [] };
    for (const type of ['sub', 'raw']) {
      const json = await asGet(`/timetables/${type}?year=${year}&week=${week}&tz=Etc/UTC`, `AnimeSchedule ${type} ${year}-W${week}`);
      entry[type] = (Array.isArray(json) ? json : []).map(compactTimetableEntry);
      fetched += 1;
    }
    await writeCache(file, entry);
    out.push(entry);
  }
  log(`[nimu:eps] AnimeSchedule: ${weeks.length} semanas de histórico (${fetched} pedidos novos, o resto da cache)`);
  return out;
}

// ── Kitsu ───────────────────────────────────────────────────────────────────

/** Só se segue um `links.next` do próprio Kitsu (o mesmo cuidado do TVDB). */
export function kitsuNextUrl(next) {
  if (typeof next !== 'string' || next === '') return null;
  const url = new URL(next, KITSU_BASE);
  return url.hostname === 'kitsu.app' || url.hostname === 'kitsu.io' ? url.href : null;
}

/** O Kitsu é uma API pública sem SLA: nenhum pedido pode pendurar a corrida. */
const KITSU_TIMEOUT_MS = 20_000;

async function kitsuGet(url, label, { retries = 4 } = {}) {
  return fetchJson(url, {
    label,
    headers: { Accept: 'application/vnd.api+json' },
    limiter: kitsuLimiter,
    retries,
    timeoutMs: KITSU_TIMEOUT_MS,
    maxRetryAfterMs: 30_000,
  });
}

/**
 * Só os ids numéricos são do Kitsu. Medido a 2026-11-04: 213 linhas têm no
 * `external_ids.kitsu` um slug ("one-piece", "detective-conan"), e um slug
 * no `filter[id]` estraga o pedido inteiro, que leva mais 19 títulos.
 */
export function isKitsuId(id) {
  return /^\d+$/.test(String(id ?? ''));
}

const kitsuFile = (id) => resolve(CACHE_DIR, 'kitsu', `${id}.json`);

/**
 * Os episódios de uma entrada, página a página (o caminho lento, um título).
 * Devolve `null` se não couber em `maxPages` pedidos (a lista ficava a meio, e
 * uma lista a meio não se guarda).
 */
async function kitsuEpisodePages(kitsuId, { maxPages = 300, retries = 4 } = {}) {
  const episodes = [];
  let url = `${KITSU_BASE}/anime/${encodeURIComponent(kitsuId)}/episodes?page[limit]=20&fields[episodes]=number,airdate&sort=number`;
  let pages = 0;
  for (; url && pages < maxPages; pages += 1) {
    const json = await kitsuGet(url, `Kitsu episodes ${kitsuId}`, { retries });
    episodes.push(...(json?.data ?? []).map(compactKitsuEpisode));
    url = kitsuNextUrl(json?.links?.next);
  }
  return { episodes: url ? null : episodes, pages };
}

/**
 * Um pedido do Kitsu com até 20 entradas e TODOS os seus episódios
 * (`include=episodes`). Medido a 2026-11-04: o `include` traz a lista inteira
 * de cada entrada (26 do Cowboy Bebop, 43 do GTO), e não só os 20 da página,
 * por isso o catálogo inteiro cabe em ~1 000 pedidos em vez de ~20 000.
 *
 * Devolve `Map<id, { episodes, startDate }>`. Uma entrada que o Kitsu não
 * devolve (18+, apagada) fica com a lista vazia. Uma cuja lista incluída vem
 * mais curta do que `episodeCount` é lida página a página.
 */
export function kitsuBatchFromJson(json, ids) {
  const included = new Map();
  for (const item of json?.included ?? []) {
    if (item?.type === 'episodes') included.set(String(item.id), item);
  }
  const out = new Map();
  const incomplete = [];
  for (const a of json?.data ?? []) {
    const rel = a?.relationships?.episodes?.data;
    const count = Number(a?.attributes?.episodeCount);
    const episodes = (Array.isArray(rel) ? rel : [])
      .map((r) => included.get(String(r?.id)))
      .filter(Boolean)
      .map(compactKitsuEpisode);
    if (!Array.isArray(rel) || (Number.isInteger(count) && count > episodes.length && episodes.length >= 20)) {
      incomplete.push(String(a.id));
    }
    out.set(String(a.id), {
      episodes,
      startDate: a?.attributes?.startDate ?? null,
      endDate: a?.attributes?.endDate ?? null,
      episodeCount: Number.isInteger(count) ? count : null,
    });
  }
  for (const id of ids) if (!out.has(String(id))) out.set(String(id), { episodes: [], startDate: null, endDate: null, episodeCount: null });
  return { entries: out, incomplete };
}

/**
 * Garante a cache do Kitsu para estes ids, em lotes de 20. Devolve quantos
 * pedidos fez (cada página conta). Em cache 30 dias.
 *
 * `maxRequests` é um teto DURO (o passo incremental da ingestão passa 10):
 * quando se esgota, o resto fica para a próxima corrida, e uma entrada cuja
 * lista não coube não se guarda.
 */
async function prefetchKitsu(ids, log, { maxRequests = Infinity, retries = 4 } = {}) {
  const missing = [];
  for (const id of new Set(ids.map(String))) {
    if (!isKitsuId(id)) continue;
    // Uma entrada guardada antes da revisão do PR #62 não tem o fim nem a
    // contagem (a regra das datas plausíveis precisa deles): volta a pedir-se.
    const cached = await readCache(kitsuFile(id), KITSU_TTL_MS);
    if (!cached || !('endDate' in cached)) missing.push(id);
  }
  let requests = 0;
  for (const part of chunk(missing, 20)) {
    if (requests >= maxRequests) break;
    let json = null;
    try {
      requests += 1;
      json = await kitsuGet(
        `${KITSU_BASE}/anime?filter[id]=${part.map(encodeURIComponent).join(',')}&include=episodes` +
          '&fields[anime]=episodeCount,startDate,endDate,episodes&fields[episodes]=number,airdate&page[limit]=20',
        `Kitsu anime x${part.length}`,
        { retries },
      );
    } catch (err) {
      log(`[nimu:eps] ⚠ Kitsu (lote de ${part.length}): ${err.message}`);
      continue;
    }
    const { entries, incomplete } = kitsuBatchFromJson(json, part);
    for (const id of incomplete) {
      const left = maxRequests - requests;
      if (left <= 0) {
        entries.delete(id);
        continue;
      }
      try {
        const { episodes, pages } = await kitsuEpisodePages(id, { maxPages: Math.min(300, left), retries });
        requests += pages;
        if (episodes === null) entries.delete(id);
        else entries.get(id).episodes = episodes;
      } catch (err) {
        entries.delete(id);
        requests += 1;
        log(`[nimu:eps] ⚠ Kitsu ${id}: ${err.message}`);
      }
    }
    for (const [id, value] of entries) await writeCache(kitsuFile(id), value);
  }
  return requests;
}

/** O que está na cache do Kitsu para um id (depois de `prefetchKitsu`). */
async function cachedKitsu(kitsuId) {
  return (await readCache(kitsuFile(String(kitsuId)))) ?? null;
}

// ── manami ──────────────────────────────────────────────────────────────────

const MAL_SOURCE = /myanimelist\.net\/anime\/(\d+)/i;

/**
 * `mal_id → entrada do manami`: o que `wouldBeExtra` (episode-merge.js) passa
 * ao `classifyExtra` do #60 para saltar os videoclipes e PV. O mesmo índice da
 * reclassificação (`manamiByMalIndex` em reclassify-extras.js: todas as fontes
 * do MAL de cada entrada, a primeira entrada ganha), para as duas contarem as
 * mesmas linhas.
 */
export function manamiHints(entries) {
  return manamiByMalIndex(entries);
}

/** `mal_id → total de episódios` (só os totais positivos). */
export function manamiTotals(entries) {
  const out = new Map();
  for (const e of entries ?? []) {
    const total = Number(e?.episodes);
    if (!Number.isInteger(total) || total <= 0) continue;
    for (const s of e?.sources ?? []) {
      const m = typeof s === 'string' ? MAL_SOURCE.exec(s) : null;
      if (m) {
        out.set(Number(m[1]), total);
        break;
      }
    }
  }
  return out;
}

// ── Base ────────────────────────────────────────────────────────────────────

async function pages(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** A base já tem a coluna `episodes.air_date_unknown` (migração 20261104000100)? */
export async function hasAirDateUnknown(supabase) {
  const { error } = await supabase.from('episodes').select('air_date_unknown').limit(1);
  if (!error) return true;
  if (error.code === '42703') return false;
  throw error;
}

const ANIME_COLUMNS = 'id, slug, title, status, media_type, year, season, mal_id, external_ids, animeschedule_route, popularity';

async function readCatalogue(supabase, { anime }) {
  if (anime) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(anime);
    const { data, error } = await supabase.from('animes').select(ANIME_COLUMNS).eq(isUuid ? 'id' : 'slug', anime);
    if (error) throw error;
    return data ?? [];
  }
  return pages(() => supabase.from('animes').select(ANIME_COLUMNS).order('id', { ascending: true }));
}

async function readEpisodes(supabase, ids, withFlag) {
  const cols = `anime_id, episode_number, airing_at${withFlag ? ', air_date_unknown' : ''}`;
  return pages(() =>
    supabase.from('episodes').select(cols).in('anime_id', ids).order('anime_id').order('episode_number'),
  );
}

async function writePlan(supabase, inserts, updates) {
  for (const batch of chunk(inserts, WRITE_CHUNK)) {
    const { error } = await supabase
      .from('episodes')
      .upsert(batch, { onConflict: 'anime_id,episode_number', ignoreDuplicates: true });
    if (error) throw error;
  }
  // Atualizações agrupadas pelo FEITIO (as mesmas colunas em todas as linhas
  // de um pedido): num upsert em lote, uma coluna que só algumas linhas trazem
  // ia a nulo nas outras. Assim o upsert só muda as colunas que vêm no pedido.
  const shapes = new Map();
  for (const row of updates) {
    const shape = Object.keys(row).sort().join(',');
    if (!shapes.has(shape)) shapes.set(shape, []);
    shapes.get(shape).push(row);
  }
  for (const group of shapes.values()) {
    for (const batch of chunk(group, WRITE_CHUNK)) {
      const { error } = await supabase.from('episodes').upsert(batch, { onConflict: 'anime_id,episode_number' });
      if (error) throw error;
    }
  }
}

// ── O relatório ─────────────────────────────────────────────────────────────

export function emptyReport() {
  return {
    titles: 0,
    // Quantos títulos de cada tipo (`classifyAnime`): `music` são os
    // videoclipes e PV, marcados na base ou pela regra do #60.
    kinds: {},
    titlesBySource: { animeschedule: 0, premiere: 0, kitsu: 0, tvdb: 0 },
    titlesUndated: 0,
    titlesOnlyUndated: 0,
    titlesTouched: 0,
    episodes: { animeschedule: 0, premiere: 0, kitsu: 0, tvdb: 0, undated: 0, flagged: 0, upgraded: 0 },
    inserts: 0,
    updates: 0,
    insertsWithLinks: 0,
    withoutEpisodes: {},
    exceptions: [],
    rejected: {},
    requests: { kitsu: 0, tvdb: 0 },
    // As datas do Kitsu postas de parte por implausíveis (ver
    // `plausibleKitsuIndex` em episode-sources.js).
    kitsuDates: { titles: 0, dated: 0, dropped: 0, titlesDropped: 0, titlesDiscarded: 0, byReason: {} },
    examples: [],
  };
}

const EXAMPLE_SLUGS = new Set([
  'ore-dake-level-up-na-ken',
  'ore-dake-level-up-na-ken-season-2-arise-from-the-shadow',
  'shingeki-no-kyojin',
  'shingeki-no-kyojin-season-2',
  'shingeki-no-kyojin-season-3',
  'shingeki-no-kyojin-the-final-season-part-2',
  'sousou-no-frieren',
  'sousou-no-frieren-2nd-season',
  'cowboy-bebop',
  'shinseiki-evangelion',
  'great-teacher-onizuka',
  'trigun',
  'kenpuu-denki-berserk',
  'serial-experiments-lain',
  'slam-dunk',
  'bishoujo-senshi-sailor-moon',
  'rurouni-kenshin-meiji-kenkaku-romantan',
  'yuu-yuu-hakusho',
]);

/** Porque é que um título fica sem episódios nenhuns. */
export function withoutEpisodesReason(kind, status) {
  if (kind === 'upcoming') return 'por-estrear';
  if (kind === 'music') return 'videoclipe';
  if (kind === 'unknown') return 'sem-estado';
  if (status === 'finished' || status === 'cancelled') return kind === 'movie' ? 'filme-sem-data' : 'terminada-sem-total-nem-datas';
  return kind === 'movie' ? 'filme-no-ar-sem-data' : 'no-ar-sem-episodio-datado';
}

/** Junta o plano de um título ao relatório. */
export function recordPlan(report, { anime, plan, existingCount }) {
  report.titles += 1;
  report.kinds[plan.kind] = (report.kinds[plan.kind] ?? 0) + 1;
  addCounts(report.episodes, plan.counts);
  report.inserts += plan.inserts.length;
  report.updates += plan.updates.length;
  report.insertsWithLinks += plan.inserts.filter((r) => (r.streaming_links ?? []).length > 0).length;
  for (const s of ['animeschedule', 'premiere', 'kitsu', 'tvdb']) if (plan.counts[s] > 0) report.titlesBySource[s] += 1;
  const dated = plan.counts.animeschedule + plan.counts.premiere + plan.counts.kitsu + plan.counts.tvdb;
  if (plan.counts.undated + plan.counts.flagged > 0) {
    report.titlesUndated += 1;
    if (dated === 0 && existingCount === 0) report.titlesOnlyUndated += 1;
  }
  if (plan.inserts.length + plan.updates.length > 0) report.titlesTouched += 1;
  for (const r of plan.rejected) report.rejected[`${r.source}:${r.reason}`] = (report.rejected[`${r.source}:${r.reason}`] ?? 0) + 1;

  const after = existingCount + plan.inserts.length;
  if (after === 0) {
    const why = withoutEpisodesReason(plan.kind, anime.status);
    report.withoutEpisodes[why] = (report.withoutEpisodes[why] ?? 0) + 1;
    // Por estrear e videoclipes são o esperado. Tudo o resto é uma exceção.
    if (plan.kind !== 'upcoming' && plan.kind !== 'music') {
      report.exceptions.push({ slug: anime.slug, title: anime.title, status: anime.status, media_type: anime.media_type, year: anime.year, reason: why });
    }
  }
  if (anime.slug && EXAMPLE_SLUGS.has(anime.slug)) {
    report.examples.push({
      slug: anime.slug,
      title: anime.title,
      status: anime.status,
      media_type: anime.media_type,
      existing: existingCount,
      inserts: plan.inserts.length,
      updates: plan.updates.length,
      counts: plan.counts,
      first: plan.inserts.slice(0, 3).map((r) => [r.episode_number, r.airing_at]),
      last: plan.inserts.slice(-1).map((r) => [r.episode_number, r.airing_at]),
      rejected: plan.rejected,
    });
  }
}

/** Volume estimado da escrita, em MB. */
export function estimateMegabytes(report) {
  const bytes = report.inserts * BYTES_PER_EPISODE + report.insertsWithLinks * BYTES_PER_STREAM_LINKS;
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

function printReport(report, { apply, log }) {
  const verbo = apply ? 'escritos' : 'a escrever';
  log('[nimu:eps] ── relatório ──────────────────────────────────────────');
  log(`[nimu:eps] títulos vistos: ${report.titles}; com alguma escrita: ${report.titlesTouched}`);
  log(`[nimu:eps] por tipo: ${JSON.stringify(report.kinds)} (music = videoclipes e PV, sem episódios)`);
  log(`[nimu:eps] títulos com episódios do AnimeSchedule: ${report.titlesBySource.animeschedule} (${report.episodes.animeschedule} episódios ${verbo})`);
  log(`[nimu:eps] títulos com a estreia do catálogo do AnimeSchedule (só o ep. 1, só o dia): ${report.titlesBySource.premiere} (${report.episodes.premiere} episódios)`);
  log(`[nimu:eps] títulos com episódios do Kitsu: ${report.titlesBySource.kitsu} (${report.episodes.kitsu} episódios)`);
  log(`[nimu:eps] títulos com episódios do TVDB: ${report.titlesBySource.tvdb} (${report.episodes.tvdb} episódios)`);
  log(`[nimu:eps] títulos com episódios sem data: ${report.titlesUndated} (${report.episodes.undated} novos + ${report.episodes.flagged} antigos marcados); só sem data: ${report.titlesOnlyUndated}`);
  log(`[nimu:eps] datas melhoradas (dia → hora): ${report.episodes.upgraded}`);
  log(`[nimu:eps] linhas: ${report.inserts} inserções, ${report.updates} atualizações; ~${estimateMegabytes(report)} MB`);
  log(`[nimu:eps] sem episódios no fim, por motivo: ${JSON.stringify(report.withoutEpisodes)}`);
  log(`[nimu:eps] fontes postas de parte: ${JSON.stringify(report.rejected)}`);
  log(`[nimu:eps] pedidos: Kitsu ${report.requests.kitsu}, TVDB ${report.requests.tvdb}`);
  const kd = report.kitsuDates;
  log(
    `[nimu:eps] datas do Kitsu postas de parte por implausíveis: ${kd.dropped} de ${kd.dated} ` +
      `(${kd.titlesDropped} de ${kd.titles} títulos; ${kd.titlesDiscarded} descartados por inteiro): ${JSON.stringify(kd.byReason)}`,
  );
  log(`[nimu:eps] exceções (já começaram e ficam sem episódios): ${report.exceptions.length}`);
  for (const e of report.exceptions.slice(0, 40)) log(`[nimu:eps]   - ${e.title} (${e.slug}; ${e.status}, ${e.media_type ?? 'sem tipo'}, ${e.year ?? 'sem ano'})`);
  for (const ex of report.examples) log(`[nimu:eps] exemplo ${ex.slug}: ${JSON.stringify(ex)}`);
}

// ── Principal ───────────────────────────────────────────────────────────────

/**
 * Um passo do backfill sobre `rows`. É também o que a ingestão semanal chama
 * (run.js) para os títulos que mudaram, só com as fontes baratas.
 *
 * @param {object} ctx
 * @param {import('@supabase/supabase-js').SupabaseClient} ctx.supabase
 * @param {object[]} ctx.rows Linhas de `animes` (ANIME_COLUMNS).
 * @param {{ history?: Map, catalogue?: { byRoute: Map, routeByMal: Map } }} ctx.animeschedule
 * @param {Map<number, number>} ctx.totals mal_id → total (manami).
 * @param {Set<string>} ctx.sources
 * @param {boolean} ctx.apply
 * @param {boolean} ctx.withFlag Planear episódios sem data (a coluna existe, ou a simulação supõe-na).
 * @param {boolean} [ctx.selectFlag] A coluna existe e pode ler-se (por omissão, `withFlag`).
 * @param {Map<number, number>} [ctx.tvdbUse] tvdb id → nº de linhas com ele.
 * @param {(cursor: string) => Promise<void>} [ctx.onBatch]
 */
export async function backfillRows(ctx) {
  const {
    supabase,
    rows,
    animeschedule = {},
    totals,
    hints = new Map(),
    sources,
    apply,
    withFlag,
    tvdbUse = new Map(),
    onBatch,
    onPlan,
    deadline = Infinity,
    now = new Date(),
  } = ctx;
  const log = ctx.log ?? console.log;
  const report = ctx.report ?? emptyReport();
  const { history = new Map(), catalogue = { byRoute: new Map(), routeByMal: new Map() } } = animeschedule;

  for (const batch of chunk(rows, BATCH)) {
    // Um teto de tempo (o passo incremental da ingestão): o que falta fica
    // para a próxima corrida.
    if (Date.now() > deadline) {
      report.stoppedEarly = true;
      log(`[nimu:eps] tempo esgotado: ${rows.length - report.titles} título(s) ficam para a próxima corrida`);
      break;
    }
    const existing = await readEpisodes(supabase, batch.map((r) => r.id), ctx.selectFlag ?? withFlag);
    const byAnime = new Map();
    for (const e of existing) {
      let list = byAnime.get(e.anime_id);
      if (!list) byAnime.set(e.anime_id, (list = []));
      list.push(e);
    }
    const inserts = [];
    const updates = [];

    // 1.ª volta: o que as fontes já carregadas dizem (o histórico e o
    // catálogo do AnimeSchedule, o total do manami).
    const work = batch.map((anime) => {
      const mal = Number(anime.mal_id ?? anime.external_ids?.mal) || null;
      const route = anime.animeschedule_route ?? (mal ? catalogue.routeByMal.get(mal) : undefined) ?? null;
      const asInfo = route ? catalogue.byRoute.get(route) : undefined;
      const total = (mal ? totals.get(mal) : undefined) ?? asInfo?.episodes ?? null;
      const rowExisting = byAnime.get(anime.id) ?? [];
      const manami = mal ? hints.get(mal) ?? null : null;
      const input = {
        anime,
        existing: rowExisting,
        sources: {},
        premiere: sources.has('animeschedule') ? asInfo?.premier ?? null : null,
        total,
        music: asInfo?.music === true,
        extra: wouldBeExtra(anime, manami),
        now,
        withFlag,
      };
      if (sources.has('animeschedule') && route && history.has(route)) input.sources.animeschedule = history.get(route);
      const plan = planAnimeEpisodes(input);
      return { anime, input, plan, total, rowExisting, kind: plan.kind };
    });
    const missing = (w) => w.plan.counts.undated + w.plan.counts.flagged + w.plan.counts.premiere > 0;

    // 2.ª volta: o Kitsu, em lotes de 20, só para quem ainda tem episódios
    // sem data (ou só a estreia do catálogo).
    if (sources.has('kitsu')) {
      const want = work.filter((w) => missing(w) && isKitsuId(w.anime.external_ids?.kitsu) && w.kind !== 'music');
      const budget = Number.isFinite(ctx.kitsuBudget) ? Math.max(0, ctx.kitsuBudget - report.requests.kitsu) : Infinity;
      const ids = Date.now() > deadline ? [] : want.map((w) => String(w.anime.external_ids.kitsu)).slice(0, budget * 20);
      if (ids.length > 0) {
        report.requests.kitsu += await prefetchKitsu(ids, log, {
          maxRequests: budget,
          retries: Number.isFinite(ctx.kitsuBudget) ? 1 : 4,
        });
      }
      const allowed = new Set(ids);
      for (const w of want) {
        const kitsuId = String(w.anime.external_ids.kitsu);
        if (!allowed.has(kitsuId)) continue;
        const k = await cachedKitsu(kitsuId);
        if (!k) continue;
        const idx = plausibleKitsuIndex(kitsuEpisodesIndex(k.episodes), {
          startDate: k.startDate ?? null,
          endDate: k.endDate ?? null,
          episodeCount: k.episodeCount ?? null,
          year: Number.isInteger(w.anime.year) ? w.anime.year : Number.parseInt(w.anime.year, 10) || null,
          stats: report.kitsuDates,
        });
        if (w.kind === 'movie' && !idx.get(1)?.airingAt) {
          const start = dayToIso(k.startDate ?? null);
          if (start) idx.set(1, { episodeNumber: 1, airingAt: start, precision: 'day', source: 'kitsu' });
        }
        w.input.sources.kitsu = idx;
        w.plan = planAnimeEpisodes(w.input);
      }
    }

    // 3.ª volta: o TVDB, um pedido por título, só com um id seguro.
    for (const w of work) {
      const tvdbId = Number(w.anime.external_ids?.tvdb) || null;
      if (!missing(w) || !sources.has('tvdb') || !tvdbId || !config.tvdbApiKey || w.kind !== 'episodic') continue;
      if (Date.now() > deadline) break;
      if ((tvdbUse.get(tvdbId) ?? 0) > 1) continue;
      try {
        const { fetchAllEpisodes } = await import('./tvdb-episodes.js');
        const eps = await fetchAllEpisodes(tvdbId);
        report.requests.tvdb += 1;
        w.input.sources.tvdb = tvdbEpisodesIndex(eps, { total: w.total, sharedId: false });
        w.plan = planAnimeEpisodes(w.input);
      } catch (err) {
        log(`[nimu:eps] ⚠ TVDB ${tvdbId} (${w.anime.slug ?? w.anime.id}): ${err.message}`);
      }
    }

    for (const w of work) {
      recordPlan(report, { anime: w.anime, plan: w.plan, existingCount: w.rowExisting.length });
      if (onPlan) onPlan(w.anime, w.plan, w.rowExisting);
      inserts.push(...w.plan.inserts);
      updates.push(...w.plan.updates);
    }
    if (apply && (inserts.length > 0 || updates.length > 0)) await writePlan(supabase, inserts, updates);
    // O último título TRATADO (lido, planeado e, a escrever, escrito): é daqui
    // que a corrida seguinte retoma se esta parar pelo teto de tempo.
    report.lastId = batch[batch.length - 1].id;
    if (onBatch) await onBatch(report.lastId);
  }
  return report;
}

/**
 * O passo incremental da ingestão de 6 em 6 horas (run.js): os títulos que
 * esta corrida tocou (os do horário), os que o status-reconcile.js acabou de
 * mudar de estado nesta corrida (`changedIds`) e as fichas criadas nos
 * últimos dois dias ficam com os episódios que lhes faltam. É assim que uma
 * temporada que acaba fica com os 1..N, e que um título novo já terminado não
 * chega sem episódios.
 *
 * Revisão do PR #62: era "tudo o que tem `updated_at` dos últimos dois dias".
 * Medido a 2026-11-04, isso são 448 títulos (2 096 numa semana), porque o
 * `updated_at` sobe também com as sinopses, os trailers e os seguidores: o
 * passo incremental fazia o backfill do catálogo às escondidas, logo a seguir
 * à migração e antes do `confirmar=SIM`, e sem o histórico do AnimeSchedule
 * (os links de streaming desses episódios perdiam-se). Por isso agora é por
 * `created_at`, e o resto do catálogo é do workflow do backfill.
 *
 * Só fontes baratas: o horário que a corrida já leu, a ficha do AnimeSchedule
 * que já leu, o total do manami, e o Kitsu com no máximo `kitsuLimit`
 * pedidos (cada página conta, cada um com 20 s de teto). Não fatal para quem
 * chama (run.js apanha o erro).
 *
 * Com tetos, para nunca atrasar a ingestão de 6 em 6 horas: no máximo
 * `maxTitles` títulos (primeiro os desta corrida) e `budgetMs` de relógio; o
 * que sobra fica para a próxima corrida.
 */
export async function backfillRecent(
  supabase,
  {
    animeIds = [],
    timetableEntries = [],
    details = [],
    totals = new Map(),
    hints = new Map(),
    changedIds = [],
    now = new Date(),
    kitsuLimit = 10,
    maxTitles = 600,
    budgetMs = 120_000,
    log = console.log,
  } = {},
) {
  const deadline = Date.now() + budgetMs;
  const withFlag = await hasAirDateUnknown(supabase);
  const since = new Date(now.getTime() - 2 * DAY_MS).toISOString();
  const recent = await pages(() =>
    supabase
      .from('animes')
      .select(`${ANIME_COLUMNS}, created_at`)
      .gte('created_at', since)
      .in('status', ['finished', 'airing', 'hiatus', 'cancelled'])
      .order('id', { ascending: true }),
  );
  const byId = new Map(recent.map((r) => [r.id, r]));
  const missing = [...new Set([...animeIds, ...changedIds])].filter((id) => !byId.has(id));
  for (const ids of chunk(missing, 150)) {
    const { data, error } = await supabase.from('animes').select(ANIME_COLUMNS).in('id', ids);
    if (error) throw error;
    for (const r of data ?? []) byId.set(r.id, r);
  }
  // Primeiro os desta corrida (horário e estados mudados), depois as fichas
  // novas, das mais recentes para as mais antigas.
  const fromRun = new Set([...animeIds, ...changedIds]);
  const rows = [...byId.values()]
    .sort((a, b) => (fromRun.has(b.id) ? 1 : 0) - (fromRun.has(a.id) ? 1 : 0) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, maxTitles)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (byId.size > rows.length) log(`[nimu] episódios em falta: ${byId.size - rows.length} título(s) ficam para a próxima corrida (teto de ${maxTitles})`);
  const animeschedule = {
    history: animescheduleHistoryIndex([{ sub: timetableEntries, raw: [] }]),
    catalogue: animescheduleCatalogueIndex(details),
  };
  // O Kitsu com um teto de pedidos por corrida (cada pedido são 20 títulos).
  const report = await backfillRows({
    supabase,
    rows,
    animeschedule,
    totals,
    hints,
    sources: new Set(['animeschedule', 'kitsu']),
    apply: true,
    withFlag,
    log,
    now,
    deadline,
    kitsuBudget: kitsuLimit,
  });
  log(
    `[nimu] episódios em falta: ${rows.length} título(s) vistos, ${report.inserts} episódio(s) novos ` +
      `(${report.episodes.undated} sem data), ${report.updates} atualizado(s), Kitsu ${report.requests.kitsu}`,
  );
  return report;
}

/**
 * Acabou o catálogo, e de onde retoma a corrida seguinte. Uma corrida parada
 * pelo teto de tempo nunca conta como acabada, mesmo que o `limite` cobrisse
 * o resto: retoma depois do último lote tratado (ou do mesmo cursor, se não
 * tratou nenhum).
 */
export function runOutcome({ after = null, pending, rows, report }) {
  if (report.stoppedEarly) return { done: false, cursor: report.lastId ?? after ?? null };
  const done = pending.length <= rows.length;
  return { done, cursor: done ? null : rows[rows.length - 1]?.id ?? null };
}

async function readCursor(apply) {
  return (await readCache(cursorFile(apply)))?.after ?? null;
}

async function saveCursor(apply, after) {
  await writeCache(cursorFile(apply), { after, at: new Date().toISOString() });
}

export async function main(argv = process.argv.slice(2), { log = console.log, onPlan = null } = {}) {
  const args = parseArgs(argv);
  const startedAt = Date.now();
  const url = process.env.SUPABASE_URL;
  // Em simulação, a chave pública chega (o catálogo e os episódios são
  // públicos). Escrever pede a service role, e só com `--aplicar`.
  const key = args.apply ? config.supabaseServiceRoleKey : process.env.SUPABASE_ANON_KEY ?? config.supabaseServiceRoleKey;
  if (!url || !key) {
    throw new Error(
      args.apply
        ? 'Falta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (escrever pede a service role).'
        : 'Falta SUPABASE_URL e SUPABASE_ANON_KEY (a simulação só lê).',
    );
  }
  const { createClient } = await import('@supabase/supabase-js');
  const gate = process.env.NIMU_DB_GATE;
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'User-Agent': USER_AGENT, ...(gate ? { 'x-nimu-gate': gate } : {}) } },
  });
  log(`[nimu:eps] ${args.apply ? 'A ESCREVER' : 'SIMULAÇÃO (nada se escreve)'}; fontes: ${[...args.sources].join(', ')}`);

  // `columnExists` decide o que se PEDE à base; `withFlag` o que se PLANEIA.
  // Só a simulação pode supor a migração (`--supor-migracao`), para mostrar
  // o que a escrita faria depois de o dono a aplicar.
  const columnExists = await hasAirDateUnknown(supabase);
  const withFlag = columnExists || (!args.apply && args.assumeMigration);
  if (!columnExists) {
    log(
      withFlag
        ? '[nimu:eps] a coluna air_date_unknown ainda não existe; a simulação SUPÕE a migração 20261104000100 aplicada'
        : '[nimu:eps] ⚠ falta a migração 20261104000100_episodios_sem_data.sql: só entram episódios COM data',
    );
  }

  const { loadManamiDatabase } = await import('./manami.js');
  const manamiEntries = await loadManamiDatabase();
  const totals = manamiTotals(manamiEntries);
  const hints = manamiHints(manamiEntries);
  log(`[nimu:eps] manami: ${totals.size} totais de episódios`);

  const animeschedule = {};
  if (args.sources.has('animeschedule')) {
    if (!config.animescheduleToken) {
      log('[nimu:eps] ⚠ sem ANIMESCHEDULE_TOKEN: o AnimeSchedule fica de fora');
      args.sources.delete('animeschedule');
    } else {
      animeschedule.catalogue = animescheduleCatalogueIndex(await loadAnimescheduleCatalogue(log));
      animeschedule.history = animescheduleHistoryIndex(await loadAnimescheduleHistory(args.historyStart, new Date(), log));
      log(`[nimu:eps] AnimeSchedule: ${animeschedule.history.size} rotas com episódios no histórico`);
    }
  }
  if (args.sources.has('tvdb') && !config.tvdbApiKey) {
    log('[nimu:eps] sem TVDB_API_KEY: o TVDB fica de fora');
    args.sources.delete('tvdb');
  }

  const all = await readCatalogue(supabase, args);
  const tvdbUse = new Map();
  for (const r of all) {
    const t = Number(r.external_ids?.tvdb) || null;
    if (t) tvdbUse.set(t, (tvdbUse.get(t) ?? 0) + 1);
  }
  if (args.anime && args.anime.length > 0 && all.length > 0) {
    // Um título só conta o seu próprio tvdb partilhado pelo catálogo inteiro.
    const full = await pages(() => supabase.from('animes').select('external_ids->tvdb').not('external_ids->>tvdb', 'is', null).order('id'));
    tvdbUse.clear();
    for (const r of full) {
      const t = Number(r.tvdb) || null;
      if (t) tvdbUse.set(t, (tvdbUse.get(t) ?? 0) + 1);
    }
  }
  // `--do-inicio` esquece o cursor guardado já aqui: se esta corrida parar
  // pelo tempo antes do primeiro lote, a seguinte também começa do início.
  if (args.fromStart && !args.anime && !args.since) await saveCursor(args.apply, null);
  const after = args.anime ? null : args.since ?? (args.fromStart ? null : await readCursor(args.apply));
  const pending = after ? all.filter((r) => r.id > after) : all;
  const rows = pending.slice(0, args.limit);
  log(`[nimu:eps] catálogo: ${all.length} títulos; ${after ? `depois de ${after}: ${pending.length}; ` : ''}nesta corrida: ${rows.length}`);

  const report = await backfillRows({
    supabase,
    rows,
    animeschedule,
    totals,
    hints,
    onPlan,
    sources: args.sources,
    apply: args.apply,
    withFlag,
    selectFlag: columnExists,
    tvdbUse,
    log,
    deadline: args.minutes ? startedAt + args.minutes * 60_000 : Infinity,
    onBatch: args.anime ? null : (id) => saveCursor(args.apply, id),
  });
  const { done, cursor } = runOutcome({ after, pending, rows, report });
  // Só uma corrida que chegou ao fim do catálogo apaga o cursor. Uma parada
  // pelo tempo deixa-o onde o último lote o pôs (`onBatch`).
  if (done && !args.anime) await saveCursor(args.apply, null);
  report.cursor = cursor;
  report.withFlag = withFlag;
  report.megabytes = estimateMegabytes(report);
  printReport(report, { apply: args.apply, log });
  log(
    `[nimu:eps] ${
      done
        ? 'catálogo percorrido até ao fim'
        : report.cursor
          ? `por acabar${report.stoppedEarly ? ' (teto de tempo)' : ''}: a próxima corrida retoma depois de ${report.cursor}`
          : 'por acabar (teto de tempo antes do primeiro lote): a próxima corrida começa do início'
    }` +
      ` (${((Date.now() - startedAt) / 1000).toFixed(0)} s)`,
  );
  if (args.report) await writeCache(resolve(process.cwd(), args.report), report);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[nimu:eps] ❌ backfill falhou:', err);
    process.exitCode = 1;
  });
}
