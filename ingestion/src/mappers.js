// Mappers: raw AnimeSchedule.net API v3 shapes → DB rows.
// Field names follow the official v3 docs (lowerCamelCase; datetimes ISO 8601
// with `0001-01-01T00:00:00Z` as the null value). See ingestion/README.md.

import { classifyExtra, defaultOverrides, isExtraMediaType } from './extras.js';
import { safeImageUrl } from './image-hosts.js';

const MAX_TITLE_LEN = 500; // matches animes.title varchar(500)
const IMG_BASE = 'https://img.animeschedule.net/production/assets/public/img/';

/** AnimeSchedule datetimes use 0001-01-01T00:00:00Z as "null". */
export function isNullDate(value) {
  return !value || String(value).startsWith('0001-01-01');
}

/** ISO string in UTC, or null for missing/sentinel/invalid dates. */
export function toUtcIso(value) {
  if (isNullDate(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** AnimeSchedule show status ("Ongoing" | "Finished" | "Upcoming" | "Delayed")
 *  → our anime_status enum. A Delayed show is still airing overall. */
export function mapShowStatus(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'ongoing':
    case 'delayed':
      return 'airing';
    case 'finished':
      return 'finished';
    case 'upcoming':
      return 'upcoming';
    default:
      return null;
  }
}

/** `imageVersionRoute` is a path fragment under the AnimeSchedule image CDN. */
export function imageUrl(imageVersionRoute) {
  if (!imageVersionRoute) return null;
  // Um endereço absoluto só passa se for de um anfitrião de imagens conhecido
  // (ver image-hosts.js); um caminho relativo vive sempre no CDN da AnimeSchedule.
  if (/^https?:\/\//i.test(imageVersionRoute)) return safeImageUrl(imageVersionRoute);
  return safeImageUrl(IMG_BASE + String(imageVersionRoute).replace(/^\/+/, ''));
}

// Platform slug → { label, base URL for path-only stream values }.
const PLATFORMS = {
  crunchyroll: { label: 'Crunchyroll', base: 'https://www.crunchyroll.com/' },
  hidive: { label: 'HIDIVE', base: 'https://www.hidive.com/' },
  netflix: { label: 'Netflix', base: 'https://www.netflix.com/' },
  amazon: { label: 'Amazon Prime Video', base: 'https://www.amazon.com/' },
  hulu: { label: 'Hulu', base: 'https://www.hulu.com/' },
  youtube: { label: 'YouTube', base: 'https://www.youtube.com/' },
  disney: { label: 'Disney+', base: 'https://www.disneyplus.com/' },
  apple: { label: 'Apple TV+', base: 'https://tv.apple.com/' },
  wakanim: { label: 'Wakanim', base: 'https://www.wakanim.tv/' },
  funimation: { label: 'Funimation', base: 'https://www.funimation.com/' },
};

function platformLabel(slug) {
  const known = PLATFORMS[String(slug).toLowerCase()];
  if (known) return known.label;
  return String(slug).charAt(0).toUpperCase() + String(slug).slice(1);
}

/** Stream values may be absolute URLs, scheme-less "domain/path", or a bare
 *  path relative to the platform's site. Returns null when un-resolvable. */
function absolutizeStreamUrl(platform, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  // "www.netflix.com/title/81726714" — a dot before the first slash ⇒ a host.
  const firstSegment = v.split('/', 1)[0];
  if (firstSegment.includes('.')) return `https://${v}`;
  const known = PLATFORMS[String(platform).toLowerCase()];
  return known ? known.base + v.replace(/^\/+/, '') : null; // unknown platform + bare path
}

/**
 * Timetable `streams` → streaming_links JSONB: [{ platform, url }].
 * Accepts BOTH documented shapes defensively:
 *  - object map: { "crunchyroll": "series/XXXX/slug", ... }
 *  - array: [{ platform, url, name }, ...]
 * Always returns an array (satisfies the episodes.streaming_links CHECK).
 */
export function normalizeStreams(streams) {
  if (!streams) return [];
  const pairs = Array.isArray(streams)
    ? streams.map((s) => [s?.platform ?? s?.name, s?.url])
    : Object.entries(streams);
  const out = [];
  for (const [platform, rawUrl] of pairs) {
    if (!platform) continue;
    const url = absolutizeStreamUrl(platform, rawUrl);
    if (url) out.push({ platform: platformLabel(platform), url });
  }
  return out;
}

// Anime-detail `websites` values may also lack a scheme; match on the host.
const ID_EXTRACTORS = {
  mal: { re: /myanimelist\.net\/anime\/(\d+)/i, cast: Number },
  anilist: { re: /anilist\.co\/anime\/(\d+)/i, cast: Number },
  kitsu: { re: /kitsu\.(?:io|app)\/anime\/([\w-]+)/i, cast: String },
  anidb: { re: /anidb\.net\/(?:anime\/|a)(\d+)/i, cast: Number },
};

/** `websites` object from GET /anime/{route} → { mal?, anilist?, kitsu?, anidb? }. */
export function extractExternalIds(websites) {
  const ids = {};
  for (const value of Object.values(websites ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    for (const [key, { re, cast }] of Object.entries(ID_EXTRACTORS)) {
      const m = value.match(re);
      if (m && ids[key] === undefined) ids[key] = cast(m[1]);
    }
  }
  return ids;
}

/** Crude but sufficient HTML → text for descriptions (v3 serves HTML). */
export function stripHtml(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** "#RRGGBB"-style value or null (feeds the animes_accent_color_is_hex CHECK). */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/^#/, '');
  return /^[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(v) ? `#${v.toLowerCase()}` : null;
}

/** First argument that is a non-empty string (the API uses "" for absent
 *  names, which `??` would happily keep). */
function firstNonEmpty(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

/**
 * O `media_type` a guardar quando a linha NÃO é um extra (`classifyExtra` deu
 * null): o primeiro formato do AnimeSchedule que não seja "Music". Sem isto, um
 * título da lista `keep` (ou uma série que o AnimeSchedule também chame
 * "Music") era escrito como "Music" a cada ingestão e escondido no site, e o
 * `reclassify-extras.js` tinha de o desfazer logo a seguir, corrida após
 * corrida. Só com "Music" fica `'Special'`, que é como o manami os chama.
 */
function asStoredMediaType(mediaTypes) {
  const names = (mediaTypes ?? []).map((m) => m?.name).filter((n) => typeof n === 'string' && n.trim() !== '');
  if (names.length === 0) return null;
  return names.find((n) => !isExtraMediaType(n)) ?? 'Special';
}

/**
 * One timetable entry (+ optional /anime/{route} detail) → an `animes` row.
 * `detail` is null when the detail fetch failed — the row still stands on
 * timetable data alone (route + title are always present there).
 */
export function animescheduleToAnimeRow(entry, detail = null) {
  const route = firstNonEmpty(entry.route, detail?.route);
  const title = firstNonEmpty(
    detail?.names?.english,
    entry.english,
    detail?.names?.romaji,
    entry.romaji,
    entry.title,
    detail?.title,
  );

  const external = { ...extractExternalIds(detail?.websites) };
  if (route) external.animeschedule_route = route;

  const stats = detail?.stats ?? {};
  const score = Number(stats.averageScore);
  // `trackedCount` = quantos utilizadores do AnimeSchedule seguem o título. É o
  // ÚNICO sinal de popularidade real que temos, e vem sem licença nova (mesmo
  // endpoint /anime/{route} que já chamamos). Alimenta o billboard "mais
  // aguardados", que tem de ordenar por isto e NÃO pela nota.
  const tracked = Number(stats.trackedCount);

  // Facetas do Discover (ano/temporada/tipo). Vêm no detalhe; `entry` (a
  // timetable) não as tem, por isso ficam `null` quando não houve detalhe.
  const year = Number(detail?.year);
  const season = detail?.season?.season ?? null; // Winter/Spring/Summer/Fall
  const mediaType = detail?.mediaTypes?.[0]?.name ?? null; // TV/Movie/OVA/...
  // Videoclipes e PV (extras.js): o AnimeSchedule já diz "Music"; um especial
  // com "PV"/"CM"/"Trailer" no título passa a "PV". A regra do manami não se
  // aplica aqui (`asDecides`): para estas linhas manda o AnimeSchedule.
  const extra = classifyExtra(
    {
      mal: external.mal,
      title,
      mediaType,
      asMediaTypes: detail?.mediaTypes ?? [],
      asDecides: true,
    },
    defaultOverrides(),
  );

  return {
    animeschedule_route: route,
    title: title ? String(title).slice(0, MAX_TITLE_LEN) : null,
    status: mapShowStatus(detail?.status ?? entry.status),
    cover_image_url: imageUrl(detail?.imageVersionRoute ?? entry.imageVersionRoute),
    external_ids: external,
    description: stripHtml(detail?.description),
    genres: (detail?.genres ?? []).map((g) => g?.name).filter(Boolean),
    studios: (detail?.studios ?? []).map((s) => s?.name).filter(Boolean),
    score: Number.isFinite(score) && score > 0 ? Math.round(score * 100) / 100 : null,
    popularity: Number.isFinite(tracked) && tracked >= 0 ? Math.round(tracked) : null,
    year: Number.isInteger(year) && year > 1900 ? year : null,
    season: season ? String(season) : null,
    media_type: extra ?? asStoredMediaType(detail?.mediaTypes),
    // Dark-mode colour first: the app's calendar/detail chrome is dark-first.
    accent_color:
      normalizeHexColor(stats.colorDarkMode) ?? normalizeHexColor(stats.colorLightMode),
  };
}

/** A timetable entry → an `episodes` proto-row keyed by route (the caller
 *  swaps route → anime_id after the animes upsert). Returns null when the
 *  entry lacks a usable key or air time (e.g. the 0001-01-01 sentinel). */
export function animescheduleToEpisodeProto(entry) {
  const airingAt = toUtcIso(entry.episodeDate);
  const episodeNumber = Number(entry.episodeNumber);
  if (!entry.route || !Number.isInteger(episodeNumber) || episodeNumber <= 0 || !airingAt) {
    return null;
  }
  // `delayedFrom` (data original) quando o episódio foi adiado. Guarda-se o
  // sinal CRU — sempre que é anterior à data real. NÃO se filtra aqui o
  // "arrasto" (o AnimeSchedule propaga o mesmo `delayedFrom` para os episódios
  // seguintes): isso é uma decisão de APRESENTAÇÃO — a UI mostra a tag só no
  // PRIMEIRO episódio de cada grupo com o mesmo `delayed_from`, que é onde o
  // adiamento de facto aconteceu (ver `delayedBadgeEpisodeIds` no front-end).
  const delayedFrom = toUtcIso(entry.delayedFrom);
  const delayed_from =
    delayedFrom && delayedFrom < airingAt ? delayedFrom : null;

  return {
    route: entry.route,
    episode_number: episodeNumber,
    airing_at: airingAt,
    streaming_links: normalizeStreams(entry.streams),
    delayed_from,
  };
}

/**
 * A frase da AnimeSchedule sobre o horário (`delayedDesc` do detalhe), para
 * `animes.schedule_note`. Ex. do One Piece a 2026-10-02: "Episodes 1181 and
 * further will continue in April 2027." Espaços normalizados, no máximo 500
 * caracteres (o limite da coluna), `null` quando não há frase.
 */
export function scheduleNoteOf(detail) {
  const raw = typeof detail?.delayedDesc === 'string' ? detail.delayedDesc : '';
  const note = raw.replace(/\s+/g, ' ').trim();
  return note === '' ? null : note.slice(0, 500);
}

/** Reject rows that would corrupt the catalogue (missing natural key/title). */
export function validateAnimeRow(row) {
  return Boolean(row.animeschedule_route && row.title);
}
