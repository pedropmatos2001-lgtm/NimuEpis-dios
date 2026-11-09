import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { USER_AGENT } from './config.js';

// manami-project anime-offline-database (ODbL v1.0 + DbCL v1.0 — attribution
// required; see ingestion/README.md). Weekly GitHub release, downloaded with a
// local cache so we hit GitHub at most once per week.
const DOWNLOAD_URL =
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week — matches release cadence

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE_FILE = resolve(here, '../.cache/anime-offline-database-minified.json');

const SOURCE_RES = {
  mal: /myanimelist\.net\/anime\/(\d+)/i,
  anilist: /anilist\.co\/anime\/(\d+)/i,
  kitsu: /kitsu\.(?:io|app)\/anime\/(\d+)/i,
  anidb: /anidb\.net\/anime\/(\d+)/i,
};

/** Download (or reuse the ≤1-week-old cache of) the minified DB. Returns the
 *  parsed entry array. Throws on failure — callers treat manami as optional. */
export async function loadManamiDatabase({ cacheFile = CACHE_FILE } = {}) {
  try {
    const info = await stat(cacheFile);
    if (Date.now() - info.mtimeMs < CACHE_MAX_AGE_MS) {
      return parseEntries(JSON.parse(await readFile(cacheFile, 'utf8')));
    }
  } catch {
    // no cache yet — fall through to download
  }
  const res = await fetch(DOWNLOAD_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`manami download: HTTP ${res.status}`);
  const text = await res.text();
  const entries = parseEntries(JSON.parse(text)); // validate BEFORE caching
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, text);
  return entries;
}

/** The release file wraps entries in { data: [...] }; tolerate a bare array. */
function parseEntries(json) {
  const entries = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(entries)) throw new Error('manami: unexpected JSON structure');
  return entries;
}

/**
 * Index entries by source ids for O(1) cross-fill lookups.
 * Each indexed record: { ids: {mal?, anilist?, kitsu?, anidb?}, picture?, tags }.
 */
export function buildManamiIndex(entries) {
  const byMal = new Map();
  const byAnilist = new Map();
  for (const entry of entries ?? []) {
    const ids = {};
    for (const source of entry?.sources ?? []) {
      for (const [key, re] of Object.entries(SOURCE_RES)) {
        const m = typeof source === 'string' && source.match(re);
        if (m && ids[key] === undefined) ids[key] = key === 'kitsu' ? m[1] : Number(m[1]);
      }
    }
    // As etiquetas vão no registo para a ingestão semanal poder perguntar ao
    // manami se um título da AnimeSchedule é 18+ (adult-content.js). Sem isto,
    // um OVA hentai que a AnimeSchedule não marca entrava (2026-11-01).
    const record = { ids, picture: entry?.picture ?? null, tags: entry?.tags ?? [] };
    if (ids.mal !== undefined) byMal.set(ids.mal, record);
    if (ids.anilist !== undefined) byAnilist.set(ids.anilist, record);
  }
  return { byMal, byAnilist, size: (entries ?? []).length };
}

/**
 * Fill gaps in an external_ids object using the manami index (matched via mal
 * or anilist). Non-destructive: existing keys always win. Returns the merged
 * ids plus a fallback `picture` when the index has one.
 */
export function crossFillIds(externalIds, index) {
  const ids = { ...externalIds };
  const record =
    (ids.mal !== undefined ? index.byMal.get(Number(ids.mal)) : undefined) ??
    (ids.anilist !== undefined ? index.byAnilist.get(Number(ids.anilist)) : undefined);
  if (!record) return { ids, picture: null };
  for (const [key, value] of Object.entries(record.ids)) {
    if (ids[key] === undefined) ids[key] = value;
  }
  return { ids, picture: record.picture };
}

/**
 * Index entries by NORMALISED title and synonym, for rows we hold no shared id
 * with.
 *
 * ## Porque isto existe
 *
 * `buildManamiIndex` cruza por id (mal/anilist), e é o que a ingestão semanal
 * usa. Mas a cauda do catálogo não tem id nenhum em comum com o manami: medido
 * a 2026-08-22, das 254 séries sem capa apenas 3 tinham `mal_id`. Pelo título,
 * o manami resolve 243 dessas 254, e 26 das 27 que estão a emitir — ou seja,
 * as que se vêem no calendário.
 *
 * ## Porque o cruzamento por título é seguro aqui
 *
 * Porque é EXATO depois de normalizar (minúsculas, sem acentos, pontuação
 * reduzida a um espaço), e não uma busca aproximada. Dois títulos diferentes
 * que normalizem para a mesma chave são o mesmo título escrito de duas
 * maneiras. O primeiro a entrar ganha, e as entradas oficiais vêm antes dos
 * sinónimos por construção do laço.
 *
 * E porque o custo de um engano é uma capa trocada, não um dado errado: nada
 * aqui escreve ids, episódios ou horas.
 */
export function buildManamiTitleIndex(entries, { skipPicture = null } = {}) {
  const byTitle = new Map();
  for (const entry of entries ?? []) {
    const picture = entry?.picture ?? null;
    // Sem imagem, ou com o marcador de lugar do próprio manami, não serve: o
    // objetivo é uma capa a sério, e o placeholder desenharia um mosaico
    // cinzento igual para toda a gente.
    if (!picture || picture === skipPicture) continue;
    const record = { picture, year: entry?.animeSeason?.year ?? null };
    // Título oficial primeiro, sinónimos depois: quando duas entradas colidem
    // na mesma chave, quem ganha é aquela para quem a chave é o nome principal.
    for (const raw of [entry?.title, ...(entry?.synonyms ?? [])]) {
      const key = normalizeTitleKey(raw);
      if (key && !byTitle.has(key)) byTitle.set(key, record);
    }
  }
  return byTitle;
}

/** A chave de cruzamento: minúsculas, sem acentos, sem pontuação. */
export function normalizeTitleKey(title) {
  if (typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
