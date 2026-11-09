import { config } from './config.js';
import { fetchJson, RateLimiter } from './http.js';

// TMDB — optional, poster URLs only (licence paper trail for artwork).
// Deliberately NOT used for watch providers (JustWatch data — commercially
// restricted; see docs/research/RESEARCH-DATASOURCES-2026-07-29.md).
const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w780';
const limiter = new RateLimiter(120); // well under TMDB's ~50 req/s

/** TMDB_API_KEY may be a v3 key (query param) or a v4 read token (Bearer JWT —
 *  contains dots). Support both so ops can rotate either kind. */
function authFor(url) {
  const key = config.tmdbApiKey ?? '';
  if (key.includes('.')) return { url, headers: { Authorization: `Bearer ${key}` } };
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}api_key=${encodeURIComponent(key)}`, headers: {} };
}

/**
 * Search TV by title (+ first-air year, which acts as the confidence filter —
 * no result for that year means we simply skip the poster). Returns
 * { tmdbId, posterUrl } or null.
 */
export async function searchTvPoster(title, year) {
  const params = new URLSearchParams({ query: title, include_adult: 'false' });
  if (year) params.set('first_air_date_year', String(year));
  const { url, headers } = authFor(`${BASE}/search/tv?${params}`);
  const json = await fetchJson(url, { label: 'TMDB search/tv', headers, limiter });
  // `include_adult=false` já pede ao TMDB para esconder o 18+, mas o resultado
  // traz `adult` e não custa confirmar: um cartaz de um título adulto nunca pode
  // ir parar a uma ficha do Nimu (2026-11-01, ver adult-content.js).
  const hit = (json?.results ?? []).find((r) => r?.poster_path && r?.adult !== true);
  if (!hit) return null;
  return { tmdbId: Number(hit.id), posterUrl: `${IMG_BASE}${hit.poster_path}` };
}
