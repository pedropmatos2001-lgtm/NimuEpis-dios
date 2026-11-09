// Mappers: manami anime-offline-database entries → `animes` catalogue rows.
//
// The AnimeSchedule pipeline (src/mappers.js) only covers the ~weekly airing
// window. This module harvests the FULL manami catalogue (tens of thousands of
// titles) so the Discover page can browse everything — the metadata manami
// already ships (title, type, season, tags, cover) that we currently throw away
// after the id cross-fill. Rows produced here are intentionally SHALLOW: manami
// has no score/popularity/description/studios, so those stay unset and the
// richer AnimeSchedule-sourced rows keep theirs (see catalogue.js merge).

import { safeImageUrl } from './image-hosts.js';
import { ADULT_TAGS, adultReason } from './adult-content.js';
import { classifyExtra, defaultOverrides } from './extras.js';

const MAX_TITLE_LEN = 500; // matches animes.title varchar(500)

// manami ships this exact URL as `picture` for entries it has NO artwork for.
// It is a grey "no picture" placeholder, not a cover — storing it would point
// the app at a non-allow-listed host that renders a broken/blank tile. Treat it
// as absent so the row's cover stays null (→ the app's typographic fallback,
// the intended "no cover" state). See ingestion/src/covers.js (the repair pass).
export const MANAMI_NO_PIC =
  'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/pics/no_pic.png';

// Source URL → id extractors. Mirrors buildManamiIndex() in manami.js (kitsu
// ids stay strings; the numeric providers cast to Number). Kept local so this
// module needs no change to the shared manami loader.
const SOURCE_RES = {
  mal: /myanimelist\.net\/anime\/(\d+)/i,
  anilist: /anilist\.co\/anime\/(\d+)/i,
  kitsu: /kitsu\.(?:io|app)\/anime\/(\d+)/i,
  anidb: /anidb\.net\/anime\/(\d+)/i,
};

// manami `type` (uppercase) → media_type in AnimeSchedule casing, so the
// Discover "type" facet is uniform across both ingestion sources. UNKNOWN → null.
const MEDIA_TYPE_MAP = {
  TV: 'TV',
  MOVIE: 'Movie',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'Special',
  UNKNOWN: null,
};

// manami `status` → our anime_status enum. UNKNOWN (and anything else) → null.
const STATUS_MAP = {
  FINISHED: 'finished',
  ONGOING: 'airing',
  UPCOMING: 'upcoming',
};

// manami `animeSeason.season` → Discover season facet. UNDEFINED → null.
const SEASON_MAP = {
  WINTER: 'Winter',
  SPRING: 'Spring',
  SUMMER: 'Summer',
  FALL: 'Fall',
};

/**
 * CURATED tag → genre map. manami aggregates thousands of freeform lowercase
 * tags (from AniList / Anime-Planet / Kitsu / anidb); an uncurated genre facet
 * would be unusable. We keep ONLY a clean, well-known set — the standard genres
 * plus the popular themes/demographics people actually filter by — and map the
 * common synonyms onto canonical Title-Case names. Every tag NOT in this map is
 * dropped, so each title ends up with a small, meaningful genre set and the
 * Discover "Genre" dropdown stays short.
 */
const TAG_TO_GENRE = {
  // ── Standard genres ──────────────────────────────────────────────────────
  action: 'Action',
  adventure: 'Adventure',
  adventures: 'Adventure',
  comedy: 'Comedy',
  comedies: 'Comedy',
  drama: 'Drama',
  tragedy: 'Drama',
  'coming of age': 'Drama',
  'coming-of-age': 'Drama',
  ecchi: 'Ecchi',
  fantasy: 'Fantasy',
  'dark fantasy': 'Fantasy',
  'high fantasy': 'Fantasy',
  horror: 'Horror',
  isekai: 'Isekai',
  'other world': 'Isekai',
  mecha: 'Mecha',
  mechas: 'Mecha',
  robots: 'Mecha',
  music: 'Music',
  musical: 'Music',
  mystery: 'Mystery',
  mysteries: 'Mystery',
  detective: 'Mystery',
  psychological: 'Psychological',
  romance: 'Romance',
  romantic: 'Romance',
  'sci-fi': 'Sci-Fi',
  'sci fi': 'Sci-Fi',
  scifi: 'Sci-Fi',
  'science fiction': 'Sci-Fi',
  'slice of life': 'Slice of Life',
  'slice-of-life': 'Slice of Life',
  sports: 'Sports',
  sport: 'Sports',
  'team sports': 'Sports',
  supernatural: 'Supernatural',
  thriller: 'Thriller',
  suspense: 'Thriller',
  // ── Popular themes & demographics worth a filter ─────────────────────────
  historical: 'Historical',
  history: 'Historical',
  military: 'Military',
  war: 'Military',
  school: 'School',
  schools: 'School',
  'school life': 'School',
  seinen: 'Seinen',
  shounen: 'Shounen',
  shonen: 'Shounen',
  shoujo: 'Shoujo',
  shojo: 'Shoujo',
  josei: 'Josei',
  superpower: 'Superpower',
  'super power': 'Superpower',
  'super-power': 'Superpower',
  superpowers: 'Superpower',
  vampire: 'Vampire',
  vampires: 'Vampire',
  magic: 'Magic',
  magical: 'Magic',
  'martial arts': 'Martial Arts',
  'martial-arts': 'Martial Arts',
  space: 'Space',
  demons: 'Demons',
  demon: 'Demons',
  harem: 'Harem',
  'reverse harem': 'Harem',
  iyashikei: 'Iyashikei',
};

// Marcadores de conteúdo adulto: o conjunto passou para adult-content.js
// (2026-11-01), partilhado por TODOS os caminhos que inserem em `animes`. Antes
// só este mapeador filtrava e a ingestão semanal da AnimeSchedule não filtrava
// nada — foi por aí que entraram os OVAs hentai do verão de 2026. Reexporta-se
// para os imports antigos continuarem a funcionar. NOTA: "ecchi" NÃO é adulto
// de propósito — é um género mainstream que fica no catálogo.
export { ADULT_TAGS };

/** Lowercase + trim + collapse internal whitespace, so " Slice  of Life "
 *  and "slice of life" hit the same map key. */
function normalizeTag(tag) {
  return String(tag ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Trimmed non-empty string, else null (manami fields are usually present but
 *  may be "" — which we must not store as a title). */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** manami `picture` → a real cover URL, or null. Drops the `no_pic` placeholder
 *  (see MANAMI_NO_PIC) so image-less entries land as null, not a broken tile. */
export function manamiPicture(picture) {
  const url = nonEmptyString(picture);
  // O `no_pic` vive no raw.githubusercontent.com, que nem está na lista de
  // anfitriões — mas sai explicitamente, para o motivo ficar escrito.
  return url === MANAMI_NO_PIC ? null : safeImageUrl(url);
}

/** Parse cross-source ids from an entry's `sources` array. Numeric providers →
 *  Number; kitsu → string (matches manami.js). First hit per provider wins. */
function parseSourceIds(sources) {
  const ids = {};
  for (const source of sources ?? []) {
    if (typeof source !== 'string') continue;
    for (const [key, re] of Object.entries(SOURCE_RES)) {
      const m = source.match(re);
      if (m && ids[key] === undefined) ids[key] = key === 'kitsu' ? m[1] : Number(m[1]);
    }
  }
  return ids;
}

/** Curated, de-duplicated genre list for an entry's tags (order preserved). */
export function deriveGenres(tags) {
  const out = [];
  const seen = new Set();
  for (const tag of tags ?? []) {
    const genre = TAG_TO_GENRE[normalizeTag(tag)];
    if (genre && !seen.has(genre)) {
      seen.add(genre);
      out.push(genre);
    }
  }
  return out;
}

/** True when any tag flags adult content (see ADULT_TAGS in adult-content.js). */
export function hasAdultTag(tags) {
  return adultReason({ tags: tags ?? [] }) !== null;
}

/**
 * One manami entry → an `animes` catalogue row, or `null` to skip it.
 *
 * Returns null when the entry:
 *   - has NO MyAnimeList id — mal_id is our UNIQUE upsert key AND a quality
 *     gate (no-MAL manami entries are almost always obscure/unindexed junk);
 *   - is adult content (hentai/erotica — see hasAdultTag);
 *   - has no usable title (title is NOT NULL in the schema).
 *
 * Score/popularity/description/studios/accent_color are intentionally omitted:
 * manami carries none, and the catalogue.js merge must not clobber the values
 * the AnimeSchedule pipeline sets on airing titles.
 */
export function manamiEntryToAnimeRow(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const ids = parseSourceIds(entry.sources);
  if (ids.mal === undefined) return null; // MAL id required (upsert key + curation)

  const tags = entry.tags ?? [];
  // App para o público geral: nada de 18+. Passa pelo filtro partilhado
  // (adult-content.js) com as etiquetas E o título, para a lista confirmada à
  // mão valer também aqui — um título sem etiquetas no manami não pode entrar
  // por este caminho depois de ter sido barrado no outro (2026-11-01).
  if (adultReason({ tags, titles: [entry.title, ...(entry.synonyms ?? [])] })) return null;

  const title = nonEmptyString(entry.title);
  if (!title) return null; // animes.title is NOT NULL

  const year = Number(entry.animeSeason?.year);
  const mediaType = MEDIA_TYPE_MAP[String(entry.type ?? '').toUpperCase()] ?? null;
  // Videoclipes e PV entram já marcados (extras.js), para nunca aparecerem
  // como anime nem por uma corrida. O AnimeSchedule não se sabe aqui: as
  // linhas antigas, e as que ele marca "Music", são da reclassify-extras.js.
  const extra = classifyExtra({ mal: ids.mal, title, mediaType, manami: entry }, defaultOverrides());

  return {
    mal_id: ids.mal,
    title: title.slice(0, MAX_TITLE_LEN),
    status: STATUS_MAP[String(entry.status ?? '').toUpperCase()] ?? null,
    media_type: extra ?? mediaType,
    season: SEASON_MAP[String(entry.animeSeason?.season ?? '').toUpperCase()] ?? null,
    year: Number.isInteger(year) && year > 1900 ? year : null,
    cover_image_url: manamiPicture(entry.picture),
    external_ids: ids, // {mal, anilist?, kitsu?, anidb?}
    genres: deriveGenres(tags),
  };
}
