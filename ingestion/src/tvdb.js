import { config } from './config.js';
import { fetchJson, RateLimiter } from './http.js';
import { safeImageUrl } from './image-hosts.js';

// TheTVDB v4 — optional metadata enrichment (TVDB_API_KEY). Free tier requires
// the "Metadata provided by TheTVDB" attribution in the app. Entirely
// best-effort: every failure is caught by the caller and never fails a run.
const BASE = 'https://api4.thetvdb.com/v4';
// Exported so the episode-history client (tvdb-episodes.js) reuses ONE limiter
// and ONE memoised token per process — keeping the whole app under the shared
// ≤4 req/s budget even when both clients run together.
export const limiter = new RateLimiter(250); // polite: ≤4 req/s

let cachedToken = null;

/** POST /login { apikey } → 1-month JWT, memoised for the process lifetime.
 *  Exported for reuse by tvdb-episodes.js (see `limiter` above). */
export async function login() {
  if (cachedToken) return cachedToken;
  const json = await fetchJson(`${BASE}/login`, {
    label: 'TVDB login',
    method: 'POST',
    body: { apikey: config.tvdbApiKey },
    limiter,
  });
  cachedToken = json?.data?.token;
  if (!cachedToken) throw new Error('TVDB login: no token in response');
  return cachedToken;
}

/**
 * Resolve a series by title (+ optional first-air year). Returns
 * { tvdbId, overview, imageUrl } or null when there is no confident match.
 * Search results already carry overview/image_url, so no second call is needed.
 */
/**
 * Países de onde vem animação que o Nimu segue. O resto do TVDB é, para nós,
 * imagem real (a adaptação da Netflix do One Piece é "usa").
 */
const ANIME_COUNTRIES = new Set(['jpn', 'chn', 'kor', 'twn', 'hkg']);

/**
 * Um título reduzido ao que interessa comparar: sem acentos, sem maiúsculas,
 * sem pontuação nem espaços, e sem o "(2024)" com que o TVDB desambigua.
 * "Re:ZERO -Starting Life in Another World-" e "Re:Zero - Starting Life in
 * Another World" ficam iguais.
 */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\(\d{4}\)\s*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Todos os nomes por que o resultado responde: o principal, os alias e o inglês. */
function hitNames(hit) {
  const names = [hit?.name, hit?.translations?.eng, hit?.name_translated];
  for (const a of Array.isArray(hit?.aliases) ? hit.aliases : []) {
    names.push(typeof a === 'string' ? a : a?.name);
  }
  return names.map(normalizeTitle).filter((n) => n !== '');
}

/**
 * O resultado da pesquisa que É o título procurado, ou `null`.
 *
 * ## Porque não o primeiro resultado
 *
 * Até 2026-09-22 ficava-se com o primeiro, e a pesquisa do TVDB é difusa:
 * medido com a sonda (`src/tvdb-probe.js`), "Re:Zero" devolve primeiro
 * "Jezero", "One Piece" devolve primeiro a série de imagem real da Netflix, e
 * "Hell Mode" devolveu "白日梦与她", uma série chinesa de imagem real que foi
 * parar ao billboard da página inicial. Este id é também de onde saem a
 * sinopse, a capa de recurso e os EPISÓDIOS, portanto um resultado errado
 * envenena a ficha inteira.
 *
 * ## Porque não os géneros
 *
 * A primeira correção exigia o género "Animation". A sonda mostrou que a
 * pesquisa NÃO devolve `genres` nenhum (o swagger diz que sim), e o filtro
 * recusava tudo: a ingestão deixou de encontrar ids em silêncio. Os géneros da
 * ficha completa também falham ("Link Click" não tem "Animation").
 *
 * ## O critério
 *
 * Um nome, alias ou título inglês do resultado tem de ser EXATAMENTE o termo
 * procurado, depois de `normalizeTitle`, e o país tem de ser de animação. Na
 * dúvida não há resultado: um título sem id fica sem banner, que é muito
 * melhor do que ficar com o de outra coisa.
 *
 * Exportada para os testes.
 */
export function pickMatchingHit(results, term) {
  if (!Array.isArray(results)) return null;
  const alvo = normalizeTitle(term);
  if (alvo === '') return null;
  for (const hit of results) {
    if (!hit?.tvdb_id) continue;
    if (!ANIME_COUNTRIES.has(String(hit.country ?? '').toLowerCase())) continue;
    if (hitNames(hit).includes(alvo)) return hit;
  }
  return null;
}

/**
 * Esta série do TVDB é animação? `true`/`false`, ou `null` se não se conseguiu
 * ler. Para os ids que JÁ estão gravados, e que vieram da pesquisa antiga sem
 * filtro: o `banners.js` não pode ir buscar arte a um id sem o confirmar.
 */
export async function isAnimatedSeries(tvdbId) {
  const token = await login();
  try {
    const json = await fetchJson(`${BASE}/series/${encodeURIComponent(tvdbId)}/extended?short=true`, {
      label: 'TVDB series extended',
      headers: { Authorization: `Bearer ${token}` },
      limiter,
      retries: 2,
    });
    const genres = json?.data?.genres;
    if (!Array.isArray(genres)) return null;
    return genres.some((g) => typeof g?.name === 'string' && /anim/i.test(g.name));
  } catch {
    return null;
  }
}

export async function searchSeries(title, year) {
  const token = await login();
  const params = new URLSearchParams({ query: title, type: 'series' });
  if (year) params.set('year', String(year));
  const json = await fetchJson(`${BASE}/search?${params}`, {
    label: 'TVDB search',
    headers: { Authorization: `Bearer ${token}` },
    limiter,
  });
  const hit = pickMatchingHit(json?.data, title);
  if (hit === null) return null;
  return {
    tvdbId: Number(hit.tvdb_id),
    overview: hit.overview ?? null,
    // O mesmo filtro de anfitriões da restante ingestão (image-hosts.js):
    // isto vai parar a `cover_image_url` (F12).
    imageUrl: safeImageUrl(hit.image_url),
  };
}

/**
 * Primary artwork URL for a series we ALREADY hold a tvdb id for (the cover
 * repair pass — ingestion/src/covers.js). GET /series/{id} returns the poster
 * in `image` (a full artworks.thetvdb.com URL). Returns the URL or null; the
 * caller HEAD-validates before writing. Best-effort like the rest of tvdb.js.
 */
export async function seriesImage(tvdbId) {
  const token = await login();
  const json = await fetchJson(`${BASE}/series/${encodeURIComponent(tvdbId)}`, {
    label: 'TVDB series',
    headers: { Authorization: `Bearer ${token}` },
    limiter,
  });
  const image = json?.data?.image;
  return typeof image === 'string' && image.trim() !== '' ? image.trim() : null;
}

/** Trimmed non-empty string, else null. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * English series synopsis for a series we ALREADY hold a tvdb id for — used to
 * fill an empty `animes.description` (the manami catalogue import carried no
 * synopses, so ~99.7% of rows are blank, leaving detail pages and SEO without
 * one). TVDB has a synopsis per series.
 *
 * Prefers the ENGLISH translation: GET /series/{id}/translations/eng returns
 * `data.overview` in English. The bare GET /series/{id} `overview` is the
 * series' ORIGINAL language (Japanese for most anime), so it is only the
 * fallback when no English translation exists. Returns trimmed non-empty text or
 * null. Best-effort like the rest of tvdb.js: each lookup is caught, so a 404 /
 * missing translation just falls through instead of failing the caller.
 */
export async function seriesOverviewEnglish(tvdbId) {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const id = encodeURIComponent(tvdbId);

  const eng = await fetchJson(`${BASE}/series/${id}/translations/eng`, {
    label: 'TVDB series translation',
    headers,
    limiter,
  }).catch(() => null);
  const engOverview = nonEmptyString(eng?.data?.overview);
  if (engOverview) return engOverview;

  const series = await fetchJson(`${BASE}/series/${id}`, {
    label: 'TVDB series',
    headers,
    limiter,
  }).catch(() => null);
  return nonEmptyString(series?.data?.overview);
}

/**
 * Arte de FUNDO (horizontal) de uma série, para o billboard da página inicial.
 *
 * ## Porque isto teve de existir
 *
 * O billboard mostrava um banner por trás do título, e os 56 que a base tinha
 * apontavam TODOS para `s4.anilist.co`. Quando `lib/prose.ts` passou a filtrar
 * esse anfitrião por causa do risco B0, o billboard ficou sem imagem nenhuma: só
 * o gradiente da cor dominante. É a primeira coisa que alguém vê ao chegar ao
 * site, e passou a ser uma mancha de cor.
 *
 * O TVDB serve arte de fundo em `artworks.thetvdb.com`, que já está na lista de
 * anfitriões permitidos do `web/next.config.ts` porque as capas reparadas já
 * vêm de lá. Não é fonte nova, é a mesma a dar outra coisa.
 *
 * ## O tipo 3, e não o 1
 *
 * No TVDB, para séries, o tipo 1 é "banner" (uma tira de 758x140, pensada para
 * cabeçalhos de listas do Kodi) e o tipo 3 é "background" (1920x1080, arte a
 * sério). O billboard tem 1440px de largura e uma altura generosa: o banner
 * ficaria esticado a três vezes o tamanho e ilegível.
 *
 * ## A escolha entre as candidatas
 *
 * Uma série popular tem dezenas de fundos. A ordem é: pontuação da comunidade
 * primeiro (é o sinal de qualidade que o TVDB já reúne), largura a desempatar.
 * Não se filtra por idioma: um fundo é arte, e um fundo "japonês" e um "inglês"
 * são a mesma imagem com outra etiqueta.
 *
 * Best-effort como o resto deste ficheiro: quem chama trata `null` como "não há".
 */
export async function seriesBackground(tvdbId) {
  const token = await login();
  const json = await fetchJson(
    `${BASE}/series/${encodeURIComponent(tvdbId)}/artworks?type=3`,
    {
      label: 'TVDB background',
      headers: { Authorization: `Bearer ${token}` },
      limiter,
    },
  );

  const candidatas = (json?.data?.artworks ?? [])
    .filter((a) => nonEmptyString(a?.image) !== null)
    // O `type` volta a ser verificado apesar de o pedido já o filtrar: o
    // parâmetro é ignorado em silêncio nalgumas versões da API, e escrever um
    // banner de 758x140 no lugar de um fundo passaria despercebido até alguém
    // olhar para a página inicial.
    .filter((a) => a.type === 3 || a.type === undefined)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.width ?? 0) - (a.width ?? 0));

  return candidatas.length > 0 ? nonEmptyString(candidatas[0].image) : null;
}
