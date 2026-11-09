// TheTVDB v4 — FULL per-episode history for a series (season grouping, titles,
// overviews, thumbnails). The AnimeSchedule timetable only ever carries the
// current ~1-week slice (e.g. One Piece 1169–1174); this backfills 1..N so the
// app can offer a Crunchyroll-style season dropdown + per-episode details.
//
// Best-effort like the rest of TVDB enrichment: the runner catches failures per
// title and continues. Attribution: the TVDB free tier requires a "Metadata
// provided by TheTVDB" credit in the app (handled in the web UI).
//
// Reuses tvdb.js's login (memoised JWT) + RateLimiter so both TVDB clients stay
// under one shared ≤4 req/s budget. The token is NEVER logged.
import { login, limiter } from './tvdb.js';
import { fetchJson } from './http.js';
import { safeImageUrl } from './image-hosts.js';

const BASE = 'https://api4.thetvdb.com/v4';
// Episode `image` values are paths under the artworks CDN (already allow-listed
// in web/next.config). Absolute URLs pass through untouched.
const ARTWORKS_BASE = 'https://artworks.thetvdb.com';
// Defensive stop for a pathological pager; TVDB terminates via links.next=null
// long before this (page_size is up to 500 → even a 10k-episode show is ~20).
const MAX_PAGES = 200;

// ── Tiny date helpers ────────────────────────────────────────────────────────
// Same shape as mappers.js's isNullDate/toUtcIso, copied (not imported) on
// purpose: mappers.js is AnimeSchedule-specific and off-limits to couple to.
// TVDB `aired` is date-only "YYYY-MM-DD"; Date.parse treats a date-only ISO
// string as UTC, so toUtcIso yields midnight-UTC — exactly what we want.

/** True for missing values and the 0001-01-01 sentinel some feeds emit. */
function isNullDate(value) {
  return !value || String(value).startsWith('0001-01-01');
}

/** ISO string in UTC, or null for missing/sentinel/invalid dates. */
function toUtcIso(value) {
  if (isNullDate(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Trimmed non-empty string, else null (TVDB uses "" for absent name/overview). */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Episode `image` path → absolute artworks URL; absolute URLs pass through. */
function absolutizeImage(image) {
  const v = String(image ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return safeImageUrl(v);
  return safeImageUrl(ARTWORKS_BASE + (v.startsWith('/') ? v : `/${v}`));
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a raw TVDB `/series/{id}/episodes/default` episode list (already
 * concatenated across pages, in aired/"default" order) into episode rows:
 *   [{ episodeNumber, seasonNumber, title, overview, imageUrl, airedIso }]
 *
 * episode_number policy — MUST line up with the AnimeSchedule timetable rows so
 * the merge updates them in place instead of duplicating:
 *   - Prefer `absoluteNumber`. AnimeSchedule numbers long-running shows
 *     absolutely too (One Piece 1174, not S21E12), so it is the shared key.
 *   - Fallback: a running index over the KEPT episodes in aired order. For a
 *     show TVDB never numbered absolutely, that running position *is* its
 *     absolute number.
 * The index advances for EVERY kept episode (even ones that also carry an
 * absoluteNumber) so a fallback number can never collide with a real absolute
 * number appearing earlier in the same show.
 *
 * Specials (seasonNumber 0) are skipped UNLESS they carry an absoluteNumber:
 * without one they have no place on the absolute timeline and would pollute /
 * collide with the numbered run.
 *
 * `seasonNumber` is preserved verbatim (the season dropdown groups on it); the
 * running index is deliberately global, NOT reset per season.
 */
export function normalizeEpisodes(rawEpisodes) {
  const out = [];
  let runningIndex = 0; // over kept episodes, in aired order
  for (const ep of rawEpisodes ?? []) {
    const seasonNumber = Number.isInteger(ep?.seasonNumber) ? ep.seasonNumber : null;
    const absolute =
      Number.isInteger(ep?.absoluteNumber) && ep.absoluteNumber > 0 ? ep.absoluteNumber : null;

    // Specials with no absolute position are not placeable on episode_number.
    if (seasonNumber === 0 && absolute === null) continue;

    runningIndex += 1;
    out.push({
      episodeNumber: absolute ?? runningIndex,
      seasonNumber,
      title: nonEmpty(ep?.name),
      overview: nonEmpty(ep?.overview),
      imageUrl: absolutizeImage(ep?.image),
      airedIso: toUtcIso(ep?.aired),
    });
  }
  return out;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Page through GET /series/{id}/episodes/default and return the whole history,
 * normalized. Follows `links.next` (a full URL) until it is null/absent. Every
 * request goes through the shared RateLimiter; a single long show is a handful
 * of requests, but the full catalogue is many shows — which is why the runner
 * bounds the target set.
 */
async function fetchEpisodePages(startUrl, headers) {
  const out = [];
  let url = startUrl;
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const json = await fetchJson(url, { label: 'TVDB episodes', headers, limiter });
    out.push(...(json?.data?.episodes ?? []));
    url = nextPageUrl(json?.links?.next);
  }
  return out;
}

/**
 * A página seguinte, SÓ se for da própria TVDB (auditoria de segurança de
 * 2026-10, F23). Cada pedido leva o `Authorization: Bearer` da TVDB, e o
 * endereço da página seguinte vem da RESPOSTA: uma resposta comprometida (ou
 * um intermediário) que apontasse `links.next` para outro anfitrião recebia o
 * token no pedido seguinte, e os episódios desse anfitrião entravam no
 * catálogo público. Fora da origem da API, pára aqui com um erro claro.
 */
export function nextPageUrl(next) {
  if (typeof next !== 'string' || next === '') return null;
  const resolved = new URL(next, BASE);
  if (resolved.origin !== new URL(BASE).origin) {
    throw new Error(`tvdb: links.next fora de ${new URL(BASE).origin}: ${resolved.origin}`);
  }
  return resolved.href;
}

export async function fetchAllEpisodes(tvdbId) {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const id = encodeURIComponent(tvdbId);
  const base = await fetchEpisodePages(`${BASE}/series/${id}/episodes/default?page=0`, headers);

  // Overlay the English `name`/`overview` where TVDB has a translation. The bare
  // `/episodes/default` returns the series' ORIGINAL language (Japanese for most
  // anime), which is why titles/synopses were showing in Japanese. The `/eng`
  // variant carries the English translation where one exists; we keep the base
  // value wherever it doesn't, so a field is never blanked — an original-language
  // title beats an empty one. Non-fatal: if the translated endpoint is
  // unavailable, ingestion proceeds with the base data exactly as before.
  const eng = await fetchEpisodePages(`${BASE}/series/${id}/episodes/default/eng?page=0`, headers).catch(
    () => [],
  );
  if (eng.length > 0) {
    const byId = new Map(eng.map((e) => [e?.id, e]));
    for (const ep of base) {
      const t = byId.get(ep?.id);
      if (!t) continue;
      if (nonEmpty(t.name)) ep.name = t.name;
      if (nonEmpty(t.overview)) ep.overview = t.overview;
    }
  }
  return normalizeEpisodes(base);
}

// ── Merge into the `episodes` table ──────────────────────────────────────────

/**
 * Merge normalized TVDB episodes with the rows already stored for one anime,
 * producing a UNIFORM upsert payload (identical key set on every row). That
 * uniformity is what lets a single PostgREST upsert on (anime_id,
 * episode_number) update the metadata columns while leaving streaming_links and
 * any real airing_at untouched: the DO UPDATE SET only lists the payload's
 * columns, and for existing rows we feed those columns back their current value.
 *
 * Preserve rules — AnimeSchedule owns the calendar:
 *   - streaming_links: always carried over from the existing row (TVDB has
 *     none); brand-new rows get [].
 *   - airing_at: keep the existing value when non-null (AnimeSchedule's precise
 *     time, tied to streaming_links); fill from TVDB (date-only) only when it
 *     was null, or on a new row.
 * TVDB owns (always written): season_number, title, overview, image_url.
 *
 * Idempotent: re-running writes byte-identical rows. `delayed_from`,
 * `created_at`, etc. are intentionally NOT in the payload, so the upsert never
 * disturbs them.
 *
 * @param {string} animeId
 * @param {Array}  tvdbEpisodes  from normalizeEpisodes / fetchAllEpisodes
 * @param {Array}  existingRows  [{ episode_number, airing_at, streaming_links }]
 * @returns {{ rows: Array, inserts: number, updates: number }}
 */
export function mergeEpisodeRows(animeId, tvdbEpisodes, existingRows = []) {
  const existingByNumber = new Map();
  for (const row of existingRows) existingByNumber.set(Number(row.episode_number), row);

  // Collapse any duplicate episode_number the source might carry (a stray
  // second entry claiming the same absolute number). Last-wins, matching the
  // repo's dedupeByKey semantics; without this the upsert would abort with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const byNumber = new Map();
  for (const ep of tvdbEpisodes) byNumber.set(ep.episodeNumber, ep);

  const rows = [];
  let inserts = 0;
  let updates = 0;
  for (const ep of byNumber.values()) {
    const existing = existingByNumber.get(ep.episodeNumber);
    if (existing) updates += 1;
    else inserts += 1;
    rows.push({
      anime_id: animeId,
      episode_number: ep.episodeNumber,
      season_number: ep.seasonNumber,
      title: ep.title,
      overview: ep.overview,
      image_url: ep.imageUrl,
      // Never overwrite a real AnimeSchedule time; fill a null (or a new row).
      airing_at: existing ? existing.airing_at ?? ep.airedIso : ep.airedIso,
      // Preserve existing streams verbatim; new rows start empty.
      streaming_links: existing ? existing.streaming_links ?? [] : [],
    });
  }
  return { rows, inserts, updates };
}
