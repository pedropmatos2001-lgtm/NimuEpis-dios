import { config } from './config.js';
import { fetchJson, RateLimiter } from './http.js';

// AnimeSchedule.net API v3 — https://animeschedule.net/api/v3/documentation
// Documented limit: 120 req/min. 600 ms spacing (+ limiter jitter) keeps us at
// ~95 req/min worst case, comfortably under it.
const BASE = 'https://animeschedule.net/api/v3';
const limiter = new RateLimiter(600);

function authHeaders() {
  return { Authorization: `Bearer ${config.animescheduleToken}` };
}

/**
 * One week of the timetable: GET /timetables/{airType}?year=&week=&tz=Etc/UTC.
 * Returns an array of timetable entries ({ title, route, episodeDate,
 * episodeNumber, streams, airingStatus, … }). `tz=Etc/UTC` pins both the week
 * boundaries and the episodeDate offsets to UTC, which is what we store.
 */
export async function fetchTimetableWeek({ year, week, airType = config.airType }) {
  const url = `${BASE}/timetables/${encodeURIComponent(airType)}?year=${year}&week=${week}&tz=Etc/UTC`;
  const json = await fetchJson(url, {
    label: `AnimeSchedule timetables ${year}-W${week}`,
    headers: authHeaders(),
    limiter,
  });
  return Array.isArray(json) ? json : [];
}

/** Full detail for one show: GET /anime/{route} (names, websites with external
 *  ids, description, genres, studios, stats incl. accent colours). */
export async function fetchAnimeDetail(route) {
  const url = `${BASE}/anime/${encodeURIComponent(route)}`;
  return fetchJson(url, {
    label: `AnimeSchedule anime/${route}`,
    headers: authHeaders(),
    limiter,
  });
}

/**
 * Uma página do catálogo completo: GET /anime?page=N.
 *
 * O envelope é `{ page, totalAmount, anime: [...] }` e cada entrada traz o MESMO
 * detalhe que `/anime/{route}` — incluindo `description` e `websites` (de onde
 * sai o `mal_id`). É essa a razão de este endpoint existir aqui: percorrer o
 * catálogo às páginas custa ~1 080 pedidos para as 19 416 fichas, contra um
 * pedido por título se fôssemos de `mal_id` em `mal_id`. Ver `descriptions.js`.
 *
 * Sem filtro de propósito. A API aceita `&years=YYYY`, mas medido não é de
 * confiança: 2023 devolve 6 fichas e 2024 devolve 736, e a soma de 2020-2026 dá
 * 1 414 das 19 416 do catálogo. Fatiar por ano perderia a maior parte dos
 * títulos em silêncio, por isso quem quiser o catálogo percorre-o todo.
 *
 * Devolve sempre a forma normalizada `{ page, totalAmount, anime }` — a API
 * responde 500 (não 404) a páginas para lá do fim, por isso quem chama tem de
 * parar pela contagem, nunca por erro.
 */
export async function fetchAnimeCataloguePage({ page = 1, query = '' } = {}) {
  // `query`: um filtro extra já codificado (ex. "media-types=music", ver reclassify-extras.js).
  // Quem o usa tem de VERIFICAR as fichas que vêm, porque um filtro que a API
  // ignore devolve o catálogo inteiro sem erro nenhum (ver o `years` acima).
  const extra = query ? `&${query}` : '';
  const json = await fetchJson(`${BASE}/anime?page=${encodeURIComponent(page)}${extra}`, {
    label: `AnimeSchedule anime page ${page}${query ? ` (${query})` : ''}`,
    headers: authHeaders(),
    limiter,
  });
  return {
    page: Number(json?.page) || page,
    totalAmount: Number(json?.totalAmount) || 0,
    anime: Array.isArray(json?.anime) ? json.anime : [],
  };
}
