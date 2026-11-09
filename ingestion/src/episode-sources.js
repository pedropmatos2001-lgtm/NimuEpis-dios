// As fontes de episódios do backfill (episodes-backfill.js), reduzidas à mesma
// forma: por título, um mapa `número → { airingAt, precision, ... }`.
//
// Só funções puras: nada de rede nem de base. Os pedidos vivem em
// episodes-backfill.js, que guarda as respostas em cache e chama isto.
//
// ## As fontes, por ordem de prioridade (medidas a 2026-11-04 a partir do
// runner, ramo auditoria/episodios-2026-11-04)
//
//  1. AnimeSchedule, os calendários de semanas PASSADAS (`/timetables/sub` e
//     `/raw`): a hora exata, a mesma numeração por cour da ingestão semanal e
//     os links de streaming. É a fonte licenciada que já usamos. Só cobre as
//     semanas desde o início do histórico deles (ver HISTORY_START).
//     Do catálogo deles (`/anime?page=N`) sai o `mal_id` de cada rota, a data
//     de estreia (`premier`) e o tipo "Music" (videoclipes, que não são séries).
//  2. AniList: NÃO entra. Os termos proíbem guardar os dados e a recolha em
//     massa (docs/research/RESEARCH-DATASOURCES-2026-07-29.md). Mede-se só a
//     cobertura, numa amostra, e não se guarda nada.
//  3. Kitsu (`/anime/{id}/episodes`): público, sem chave. Dá o `airdate` (só
//     o dia) de cada episódio, com a numeração da entrada, que é a do MAL. É o
//     que cobre as séries antigas.
//  4. TheTVDB: só para as linhas que já têm um id do TVDB que não é partilhado
//     por outra linha, e cuja contagem de episódios bate com o total (o TVDB
//     tem a série inteira numa só entrada: foi assim que a ficha da S1 do
//     Oshi no Ko ficou com os 36 episódios das quatro temporadas).
//
// ## Precisão
//
// Uma data com hora (AnimeSchedule) vale mais do que uma data só com o dia
// (Kitsu, TVDB, estreia do catálogo), que vale mais do que nenhuma. As datas
// só com o dia guardam-se à meia-noite UTC, como o TVDB já fazia: a web já as
// reconhece e mostra só o dia (lib/airing-time.ts).

import { animescheduleToEpisodeProto, toUtcIso } from './mappers.js';
import { mergeTimetables } from './util.js';

export const PRECISION_RANK = { exact: 3, day: 2, none: 0 };

/** A ordem de desempate entre fontes com a mesma precisão. */
export const SOURCE_ORDER = ['animeschedule', 'kitsu', 'tvdb'];

/** `exact` quando a data tem hora; `day` quando é meia-noite UTC em ponto. */
export function precisionOf(iso) {
  if (typeof iso !== 'string' || iso === '') return 'none';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'none';
  return ms % 86_400_000 === 0 ? 'day' : 'exact';
}

/** "2024-01-07" (ou um ISO completo) → "2024-01-07T00:00:00.000Z", ou null. */
export function dayToIso(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || Number(m[1]) < 1900) return null;
  return new Date(ms).toISOString();
}

// ── AnimeSchedule: histórico de calendários ──────────────────────────────────

/**
 * As semanas de calendário (cada uma `{ sub: [...], raw: [...] }`, por ordem
 * cronológica) → `Map<route, Map<número, episódio>>`.
 *
 * Por semana, o "sub" manda e o "raw" só preenche o que o "sub" não tem (a
 * mesma regra da ingestão semanal, `mergeTimetables`). Entre semanas, a mais
 * recente ganha: um episódio adiado aparece na semana para onde foi.
 */
export function animescheduleHistoryIndex(weeks) {
  const byRoute = new Map();
  for (const week of weeks ?? []) {
    for (const entry of mergeTimetables(week?.sub ?? [], week?.raw ?? [])) {
      const proto = animescheduleToEpisodeProto(entry ?? {});
      if (!proto) continue;
      let eps = byRoute.get(proto.route);
      if (!eps) byRoute.set(proto.route, (eps = new Map()));
      eps.set(proto.episode_number, {
        episodeNumber: proto.episode_number,
        airingAt: proto.airing_at,
        precision: precisionOf(proto.airing_at),
        streamingLinks: proto.streaming_links,
        delayedFrom: proto.delayed_from,
        source: 'animeschedule',
      });
    }
  }
  return byRoute;
}

const MAL_RE = /myanimelist\.net\/anime\/(\d+)/i;

/**
 * As fichas do catálogo do AnimeSchedule (`/anime?page=N`, juntas) → índice
 * por rota e por `mal_id`. De cada ficha só interessa: o `mal_id` (para ligar
 * a rota à nossa linha), a estreia (`premier`, só o dia), o total de
 * episódios, e se é um videoclipe ("Music").
 */
export function animescheduleCatalogueIndex(animeList) {
  const byRoute = new Map();
  const routeByMal = new Map();
  for (const a of animeList ?? []) {
    if (!a?.route) continue;
    const malMatch = MAL_RE.exec(String(a.websites?.mal ?? ''));
    const mal = malMatch ? Number(malMatch[1]) : null;
    const types = (a.mediaTypes ?? []).map((m) => String(m?.name ?? m ?? ''));
    const premierIso = toUtcIso(a.premier);
    const record = {
      route: a.route,
      mal,
      premier: premierIso ? dayToIso(premierIso) : null,
      episodes: Number.isInteger(a.episodes) && a.episodes > 0 ? a.episodes : null,
      music: types.some((t) => /^music/i.test(t)),
      movie: types.some((t) => /^movie/i.test(t)),
    };
    byRoute.set(a.route, record);
    // A primeira rota que reclama um mal_id fica com ele.
    if (mal !== null && !routeByMal.has(mal)) routeByMal.set(mal, a.route);
  }
  return { byRoute, routeByMal };
}

/** A forma compacta que se guarda em cache (o catálogo inteiro tem ~19 500 fichas). */
export function compactCatalogueEntry(a) {
  return {
    route: a?.route ?? null,
    websites: { mal: a?.websites?.mal ?? null },
    mediaTypes: (a?.mediaTypes ?? []).map((m) => ({ name: m?.name ?? null })),
    premier: a?.premier ?? null,
    episodes: a?.episodes ?? null,
  };
}

/** A forma compacta de uma entrada de calendário (só o que o mapeador lê). */
export function compactTimetableEntry(e) {
  return {
    route: e?.route ?? null,
    episodeNumber: e?.episodeNumber ?? null,
    episodeDate: e?.episodeDate ?? null,
    delayedFrom: e?.delayedFrom ?? null,
    streams: e?.streams ?? null,
  };
}

// ── Kitsu ────────────────────────────────────────────────────────────────────

/**
 * Os episódios de uma entrada do Kitsu (`data` de `/anime/{id}/episodes`,
 * todas as páginas juntas) → `Map<número, episódio>`. Só os que têm número
 * inteiro positivo. O `airdate` é só o dia. Um número repetido fica com o que
 * tem data.
 */
export function kitsuEpisodesIndex(data) {
  const out = new Map();
  for (const item of data ?? []) {
    const attrs = item?.attributes ?? {};
    const n = Number(attrs.number);
    if (!Number.isInteger(n) || n <= 0) continue;
    const airingAt = dayToIso(attrs.airdate ?? attrs.airDate ?? null);
    const prev = out.get(n);
    if (prev && prev.airingAt && !airingAt) continue;
    out.set(n, { episodeNumber: n, airingAt, precision: airingAt ? 'day' : 'none', source: 'kitsu' });
  }
  return out;
}

/** A forma compacta de um episódio do Kitsu, para a cache. */
export function compactKitsuEpisode(item) {
  const a = item?.attributes ?? {};
  return { attributes: { number: a.number ?? null, airdate: a.airdate ?? a.airDate ?? null } };
}

// ── TVDB ─────────────────────────────────────────────────────────────────────

/**
 * Os episódios normalizados do TVDB (`normalizeEpisodes`) → `Map<número, …>`,
 * mas só quando a entrada do TVDB é esta temporada e só esta: nenhuma outra
 * linha do catálogo tem o mesmo id, e a contagem de episódios fora dos
 * especiais bate com o total conhecido. Sem isso, devolve um mapa vazio (o
 * TVDB tem a série inteira, e o Oshi no Ko S1 ficou com 36 episódios assim).
 */
export function tvdbEpisodesIndex(episodes, { total, sharedId }) {
  const out = new Map();
  if (sharedId) return out;
  const regular = (episodes ?? []).filter((e) => e.seasonNumber !== 0);
  if (!Number.isInteger(total) || total <= 0 || regular.length !== total) return out;
  // Numeração 1..N pela ordem de emissão da própria temporada.
  regular.forEach((e, i) => {
    const airingAt = e.airedIso ? dayToIso(e.airedIso) : null;
    out.set(i + 1, { episodeNumber: i + 1, airingAt, precision: airingAt ? 'day' : 'none', source: 'tvdb' });
  });
  return out;
}

// ── Kitsu: datas implausíveis ────────────────────────────────────────────────
//
// O Kitsu tem erros de data por episódio. O caso que se viu (2026-11-04): o
// Yu Yu Hakusho começou a 1992-10-10, mas o episódio 2 vem a 1994-04-09 (é a
// data de outro episódio). Uma data dessas, escrita, mentia na ficha e na
// ordem do "Continuar a ver". Medido no catálogo inteiro na revisão do PR #62
// (ramo auditoria/episodios-revisao-62); os números estão no PR.
//
// A regra: uma data só fica se for plausível. Sai, e o episódio fica sem data
// (e entra com a marca "já saiu"), quando:
//  - é antes do início da própria entrada no Kitsu (`startDate`) ou depois do
//    fim (`endDate`), com uma semana de folga (estreias antecipadas, fusos);
//  - é antes de dezembro do ano anterior ao ano de estreia do catálogo;
//  - está fora de ordem: a lista, por número, tem de ter datas que nunca
//    andam para trás. Fica a maior sequência que não anda para trás, e as
//    datas fora dela saem (o ep. 45 da Sailor Moon, 1993-01-20 entre dois de
//    fevereiro);
// e a entrada INTEIRA não é de confiança, e saem todas as datas, quando:
//  - saem mais de um quarto das datas;
//  - os dois (ou mais) primeiros episódios saem por estarem fora de ordem: a
//    numeração está desviada (um só é um erro de um episódio, e sai só ele). O Yu Yu Hakusho é isto: o Kitsu dá ao ep. 6 a data da estreia
//    (1992-10-10) e aos 1 a 5 datas de 1993 e 1994, por isso TODAS as datas
//    vêm cinco episódios adiantadas;
//  - o último episódio (o número `episodeCount`) sai mais de cinco semanas
//    antes do fim da entrada (`endDate`): é o mesmo desvio visto pelo fim (o
//    Yu Yu Hakusho acaba a 1995-01-07, o ep. 112 do Kitsu é de 1994-11-12; o
//    Rurouni Kenshin repete um bloco e o ep. 94 fica quatro meses antes).

const PLAUSIBLE_SLACK_MS = 7 * 86_400_000;
/** O último episódio tem de cair a menos disto do fim da entrada. */
const END_ALIGN_MS = 35 * 86_400_000;
/** Acima desta fração de datas implausíveis, nenhuma data da entrada fica. */
export const KITSU_DISCARD_RATIO = 0.25;

/**
 * Os índices (por ordem) da maior subsequência de `values` que não desce.
 * O(n log n), o clássico com "pilhas de paciência".
 */
export function longestNonDecreasing(values) {
  const tails = []; // índice do último elemento da melhor sequência de cada tamanho
  const prev = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    // A primeira pilha cujo topo é MAIOR do que values[i] (não descer: iguais seguem).
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] <= values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) out.push(i);
  return out.reverse();
}

/**
 * O índice do Kitsu (`kitsuEpisodesIndex`) só com as datas plausíveis. As
 * implausíveis ficam no mapa SEM data (o número existe; o dia não se sabe).
 *
 * @param {Map<number, object>} idx
 * @param {{ startDate?: string|null, endDate?: string|null, year?: number|null,
 *           episodeCount?: number|null, stats?: object }} [opts] `stats` acumula
 *   as contagens (o relatório).
 */
export function plausibleKitsuIndex(
  idx,
  { startDate = null, endDate = null, year = null, episodeCount = null, stats = null } = {},
) {
  const out = new Map(idx);
  const dated = [...idx.values()].filter((ep) => ep.airingAt).sort((a, b) => a.episodeNumber - b.episodeNumber);
  if (dated.length === 0) return out;
  const reasons = new Map(); // número → motivo
  const start = Date.parse(dayToIso(startDate) ?? '');
  const end = Date.parse(dayToIso(endDate) ?? '');
  const floor = Number.isInteger(year) && year > 1900 ? Date.UTC(year - 1, 11, 1) : NaN;
  for (const ep of dated) {
    const ms = Date.parse(ep.airingAt);
    if (Number.isFinite(start) && ms < start - PLAUSIBLE_SLACK_MS) reasons.set(ep.episodeNumber, 'antes-do-inicio');
    // O fim só conta numa entrada que dura (um especial com início = fim tem
    // muitas vezes episódios em streaming depois da estreia).
    else if (Number.isFinite(end) && end > start && ms > end + PLAUSIBLE_SLACK_MS) reasons.set(ep.episodeNumber, 'depois-do-fim');
    else if (Number.isFinite(floor) && ms < floor) reasons.set(ep.episodeNumber, 'antes-do-ano');
  }
  const inRange = dated.filter((ep) => !reasons.has(ep.episodeNumber));
  const keep = new Set(longestNonDecreasing(inRange.map((ep) => Date.parse(ep.airingAt))).map((i) => inRange[i].episodeNumber));
  for (const ep of inRange) if (!keep.has(ep.episodeNumber)) reasons.set(ep.episodeNumber, 'fora-de-ordem');

  // A numeração desviada, vista pelo princípio: os primeiros episódios com
  // data saíram por estarem fora de ordem.
  const shiftedStart =
    dated.length >= 2 &&
    reasons.get(dated[0].episodeNumber) === 'fora-de-ordem' &&
    reasons.get(dated[1].episodeNumber) === 'fora-de-ordem';
  // E pelo fim: o último episódio da entrada longe do fim dela.
  const last = dated[dated.length - 1];
  const shiftedEnd =
    Number.isInteger(episodeCount) && episodeCount > 1 && last.episodeNumber >= episodeCount &&
    Number.isFinite(end) && Number.isFinite(start) && end > start &&
    keep.has(last.episodeNumber) && Date.parse(last.airingAt) < end - END_ALIGN_MS;
  let discardReason = null;
  if (shiftedStart) discardReason = 'numeracao-desviada';
  else if (shiftedEnd) discardReason = 'fim-desalinhado';
  else if (reasons.size > dated.length * KITSU_DISCARD_RATIO) discardReason = 'descartado';
  const discard = discardReason !== null;
  for (const ep of dated) {
    if (discard || reasons.has(ep.episodeNumber)) out.set(ep.episodeNumber, { ...ep, airingAt: null, precision: 'none' });
  }
  if (stats) {
    stats.titles += 1;
    stats.dated += dated.length;
    const dropped = discard ? dated.length : reasons.size;
    stats.dropped += dropped;
    if (dropped > 0) stats.titlesDropped += 1;
    if (discard) stats.titlesDiscarded += 1;
    for (const r of reasons.values()) stats.byReason[r] = (stats.byReason[r] ?? 0) + 1;
    if (discard) stats.byReason[discardReason] = (stats.byReason[discardReason] ?? 0) + 1;
  }
  return out;
}
