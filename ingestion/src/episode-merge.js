// O plano de escrita de episódios de UM título, a partir do que já está na
// base e do que as fontes dizem (episode-sources.js). Puro: sem rede, sem base.
//
// ## As regras (o pedido do dono, 2026-11-04)
//
// "Temos de ter episódios para tudo. Se algo não tem episódios, é porque está
// confirmado mas ainda não começou."
//
//  - Por estrear (`upcoming`) ou sem estado: nada sem data. Só entra um
//    episódio que uma fonte diz que JÁ saiu, com data (é a prova de que o
//    estado guardado está velho; o status-reconcile.js trata do resto).
//  - Videoclipes ("Music"/"PV"): nada. Não são séries. Inclui os que o
//    #60 (extras.js) ainda não marcou na base: ver `wouldBeExtra`.
//  - Filme: um só registo, o número 1, com a data de estreia quando há. A
//    ficha mostra-o como "Estreia", não como lista (web/components/anime).
//  - Série terminada (ou cancelada): os episódios 1..total. O total é o do
//    manami (ou o do AnimeSchedule); sem ele, até ao maior número conhecido.
//  - Série no ar ou em pausa: só até ao último episódio que JÁ saiu. Os
//    seguintes são da ingestão semanal, que tem as datas futuras.
//
// Cada número fica com a melhor data que alguma fonte tem (hora exata >
// só o dia > nenhuma; em empate, a ordem de SOURCE_ORDER). Sem data nenhuma
// num título que já saiu, o episódio entra sem data e com a marca
// `air_date_unknown` (migração 20261104000100).
//
// ## O que nunca acontece
//
//  - Uma data boa substituída por uma pior: só se escreve quando a precisão
//    sobe (nenhuma → dia → hora). Um episódio com data no FUTURO nunca é
//    tocado (é da ingestão semanal).
//  - Duplicados: as inserções vão com `on conflict do nothing` sobre a chave
//    única (anime_id, episode_number); as atualizações só mudam
//    `airing_at`/`air_date_unknown` de números que já existem.
//  - Avisos: nada do que se escreve é recente. Uma data dos últimos
//    `RECENT_GUARD_MS` (3 dias) é da ingestão semanal e fica de fora, tanto
//    nas inserções como nas atualizações. É o que garante que o pg_cron não
//    avisa ninguém: o `nimu-fanout-aired` (de minuto a minuto) avisa de
//    QUALQUER episódio cujo `episode_notify_at(airing_at)` caia nas últimas 2
//    horas, e uma data só com o dia (meia-noite UTC) avisa às 09:00 UTC desse
//    dia (migração 20260821000100). Não basta não chamar a distribuição.
//  - Episódios a mais: num título terminado com total conhecido, uma fonte
//    com números acima do total é de outra entrada (o AnimeSchedule junta às
//    vezes dois cours numa rota) e é posta de parte por inteiro, assim como
//    uma fonte cujas datas não batem com as que já conhecemos.
//
// Idempotente: correr outra vez com a mesma base e as mesmas fontes não
// produz escrita nenhuma.

import { classifyExtra, defaultOverrides, isExtraMediaType } from './extras.js';
import { PRECISION_RANK, SOURCE_ORDER, precisionOf } from './episode-sources.js';

const DAY_MS = 86_400_000;
/** O maior número de episódios que se cria sem data num título. */
export const MAX_UNDATED = 3000;
/** Duas datas da mesma estreia (fontes, fusos) cabem nesta folga. */
const ALIGN_TOLERANCE_MS = 2 * DAY_MS;

const NON_EPISODIC_TYPES = new Set(['music', 'pv', 'cm']);

/**
 * Uma data destes últimos dias é da ingestão semanal, não do backfill: o
 * `nimu-fanout-aired` avisa até 2 horas depois de `episode_notify_at`, que é
 * o `airing_at` (ou as 09:00 UTC do dia, numa data sem hora), e o
 * `nimu-fanout-upcoming` 45 minutos antes. Três dias cobrem tudo com folga.
 */
export const RECENT_GUARD_MS = 3 * DAY_MS;

// ── Videoclipes e PV (PR #60, `extras.js`) ──────────────────────────────────
//
// O #60 marca `media_type = 'Music'`/`'PV'` em ~5 000 linhas (2 502 que o
// AnimeSchedule diz "Music", e as outras pelas regras do título e do manami).
// O backfill não lhes cria episódios: nem às que já estão marcadas na base,
// nem às que a reclassificação ainda não marcou (uma ficha nova do manami
// entra como `Special` e só é marcada na corrida seguinte). A regra é a do
// #60, importada, com a mesma lista de exceções; não há uma segunda cópia.

/**
 * Esta linha é (ou o #60 vai marcá-la como) videoclipe ou PV?
 *
 * @param {{ title?: string|null, media_type?: string|null, mal_id?: number|null,
 *           animeschedule_route?: string|null, popularity?: number|null }} anime
 * @param {object | null} manami A entrada do manami com o mesmo mal_id
 *   (`manamiHints` em episodes-backfill.js, o mesmo índice do #60).
 * @param {{ overrides?: object }} [options] Por omissão, `data/extras-overrides.json`.
 */
export function wouldBeExtra(anime, manami = null, { overrides = defaultOverrides() } = {}) {
  if (isExtraMediaType(anime?.media_type)) return true;
  const mal = anime?.mal_id == null ? null : Number(anime.mal_id);
  const kind = classifyExtra(
    {
      mal,
      title: anime?.title ?? null,
      mediaType: anime?.media_type ?? null,
      // O "Music" do AnimeSchedule chega ao plano por `music` (o catálogo dele).
      asMediaTypes: [],
      // A regra do manami só vale onde o AnimeSchedule não decide (sem rota e
      // sem seguidores), como em `planReclassification`.
      asDecides: Boolean(anime?.animeschedule_route) || anime?.popularity != null,
      manami,
    },
    overrides,
  );
  return kind !== null;
}

/**
 * Que tipo de título é, para o backfill.
 *
 * @param {{ status: string | null, media_type: string | null }} anime
 * @param {{ music?: boolean }} [hints] `music`: o AnimeSchedule diz "Music".
 * @returns {'music' | 'upcoming' | 'unknown' | 'movie' | 'episodic'}
 */
export function classifyAnime(anime, { music = false } = {}) {
  const type = String(anime?.media_type ?? '').trim().toLowerCase();
  if (music || NON_EPISODIC_TYPES.has(type)) return 'music';
  if (anime?.status === 'upcoming') return 'upcoming';
  if (anime?.status == null) return 'unknown';
  if (type.startsWith('movie')) return 'movie';
  return 'episodic';
}

function isAired(iso, nowMs) {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) && ms <= nowMs;
}

/** Saiu há mais de `RECENT_GUARD_MS`: pode ser escrito pelo backfill sem avisar ninguém. */
function isSettled(iso, nowMs) {
  return isAired(iso, nowMs - RECENT_GUARD_MS);
}

/**
 * As datas de uma fonte batem com as de referência? Compara os números que
 * têm data nos dois lados; se mais de metade diferirem mais de dois dias, a
 * fonte está desalinhada (numeração de outra entrada) e não serve.
 */
export function sourceAligned(source, reference) {
  let overlap = 0;
  let off = 0;
  for (const [n, ep] of source ?? []) {
    const ref = reference.get(n);
    if (!ep?.airingAt || !ref) continue;
    overlap += 1;
    if (Math.abs(Date.parse(ep.airingAt) - Date.parse(ref)) > ALIGN_TOLERANCE_MS) off += 1;
  }
  return overlap === 0 || off * 2 <= overlap;
}

/**
 * O plano de um título.
 *
 * @param {object} input
 * @param {{ id: string, status: string | null, media_type: string | null }} input.anime
 * @param {{ episode_number: number, airing_at: string | null, air_date_unknown?: boolean }[]} input.existing
 * @param {{ animeschedule?: Map, kitsu?: Map, tvdb?: Map }} input.sources
 * @param {string | null} [input.premiere] Estreia (só o dia) do catálogo do AnimeSchedule.
 * @param {number | null} [input.total] O total de episódios conhecido.
 * @param {boolean} [input.music]
 * @param {boolean} [input.extra] O #60 vai marcá-lo como videoclipe/PV (`wouldBeExtra`).
 * @param {Date} [input.now]
 * @param {boolean} [input.withFlag] A base já tem a coluna `air_date_unknown`.
 */
export function planAnimeEpisodes({
  anime,
  existing = [],
  sources = {},
  premiere = null,
  total = null,
  music = false,
  extra = false,
  now = new Date(),
  withFlag = true,
}) {
  const nowMs = now.getTime();
  const kind = classifyAnime(anime, { music: music || extra });
  const counts = { animeschedule: 0, premiere: 0, kitsu: 0, tvdb: 0, undated: 0, flagged: 0, upgraded: 0 };
  const plan = { kind, inserts: [], updates: [], counts, rejected: [] };
  if (kind === 'music') return plan;

  const ex = new Map();
  for (const row of existing ?? []) ex.set(Number(row.episode_number), row);
  const knownTotal = Number.isInteger(total) && total > 0 ? total : null;
  const ended = anime.status === 'finished' || anime.status === 'cancelled';

  // As datas de referência: as que já estão na base.
  const reference = new Map();
  for (const [n, row] of ex) if (row.airing_at) reference.set(n, row.airing_at);

  // As fontes, já filtradas: só episódios que já saíram; fora as desalinhadas.
  const usable = {};
  for (const name of SOURCE_ORDER) {
    const src = sources[name];
    if (!src || src.size === 0) continue;
    const aired = new Map();
    // Só o que saiu há mais de três dias: o resto é da ingestão semanal (e
    // dos avisos), ver RECENT_GUARD_MS.
    for (const [n, ep] of src) if (ep?.airingAt && isSettled(ep.airingAt, nowMs)) aired.set(n, ep);
    if (aired.size === 0) continue;
    const cap = kind === 'movie' ? Math.max(1, knownTotal ?? 1) : ended ? knownTotal : null;
    if (cap !== null && [...aired.keys()].some((n) => n > cap)) {
      plan.rejected.push({ source: name, reason: 'numeros-acima-do-total' });
      continue;
    }
    if (!sourceAligned(aired, reference)) {
      plan.rejected.push({ source: name, reason: 'datas-desalinhadas' });
      continue;
    }
    usable[name] = aired;
    // As fontes seguintes comparam-se também com esta.
    for (const [n, ep] of aired) if (!reference.has(n)) reference.set(n, ep.airingAt);
  }
  // A estreia do catálogo do AnimeSchedule conta como episódio 1 (só o dia),
  // mas SÓ quando nenhuma fonte tem o episódio 1: é uma data da série, não do
  // episódio, e às vezes de outra emissão (o Cowboy Bebop na TV Tokyo, o Kitsu
  // na WOWOW) ou um dia antes pelo fuso.
  const hasFirst = Object.values(usable).some((src) => src.has(1));
  if (premiere && !hasFirst && isSettled(premiere, nowMs) && kind !== 'upcoming' && kind !== 'unknown') {
    const ref = reference.get(1);
    if (!ref || Math.abs(Date.parse(ref) - Date.parse(premiere)) <= ALIGN_TOLERANCE_MS) {
      usable.premiere = new Map([[1, { episodeNumber: 1, airingAt: premiere, precision: 'day', source: 'premiere' }]]);
    }
  }

  /** A melhor data de uma fonte para o número `n`, ou null. */
  const best = (n) => {
    let pick = null;
    for (const name of [...SOURCE_ORDER, 'premiere']) {
      const ep = usable[name]?.get(n);
      if (!ep) continue;
      const rank = PRECISION_RANK[ep.precision ?? precisionOf(ep.airingAt)] ?? 0;
      if (pick === null || rank > pick.rank) pick = { ...ep, rank, source: name };
    }
    return pick;
  };

  // Até onde vão os episódios que JÁ saíram (com ou sem data).
  let maxAired = 0;
  for (const [n, row] of ex) if (row.airing_at && isAired(row.airing_at, nowMs)) maxAired = Math.max(maxAired, n);
  for (const src of Object.values(usable)) for (const n of src.keys()) maxAired = Math.max(maxAired, n);

  let undatedUpTo = 0;
  if (kind === 'movie') undatedUpTo = ended || maxAired > 0 ? Math.max(1, knownTotal ?? 1) : 0;
  else if (kind === 'episodic') {
    if (ended) undatedUpTo = knownTotal ?? Math.max(maxAired, ...[...ex.keys(), 0]);
    else undatedUpTo = maxAired;
  }
  undatedUpTo = Math.min(undatedUpTo, MAX_UNDATED);
  if (!withFlag) undatedUpTo = 0;

  const numbers = new Set();
  for (let n = 1; n <= undatedUpTo; n += 1) numbers.add(n);
  for (const src of Object.values(usable)) for (const n of src.keys()) numbers.add(n);

  for (const n of [...numbers].sort((a, b) => a - b)) {
    const cand = best(n);
    const row = ex.get(n);
    if (!row) {
      if (cand) {
        plan.inserts.push({
          anime_id: anime.id,
          episode_number: n,
          airing_at: cand.airingAt,
          streaming_links: cand.streamingLinks ?? [],
          delayed_from: cand.delayedFrom ?? null,
          ...(withFlag ? { air_date_unknown: false } : {}),
        });
        counts[cand.source] += 1;
      } else if (n <= undatedUpTo) {
        plan.inserts.push({
          anime_id: anime.id,
          episode_number: n,
          airing_at: null,
          streaming_links: [],
          delayed_from: null,
          air_date_unknown: true,
        });
        counts.undated += 1;
      }
      continue;
    }
    // Já existe. Um episódio com data futura, ou destes últimos dias, é da
    // ingestão semanal (e dos avisos): não se toca.
    if (row.airing_at && !isSettled(row.airing_at, nowMs)) continue;
    const currentRank = row.airing_at ? PRECISION_RANK[precisionOf(row.airing_at)] : 0;
    if (cand && cand.rank > currentRank) {
      // Um episódio que estava SEM data e recebe a do histórico do
      // AnimeSchedule leva também os links e o adiamento (o que uma inserção
      // levaria). Uma linha que já tinha data fica com os links que tinha.
      const withLinks = !row.airing_at && cand.source === 'animeschedule' && (cand.streamingLinks ?? []).length > 0;
      plan.updates.push({
        anime_id: anime.id,
        episode_number: n,
        airing_at: cand.airingAt,
        ...(withFlag ? { air_date_unknown: false } : {}),
        ...(withLinks ? { streaming_links: cand.streamingLinks, delayed_from: cand.delayedFrom ?? null } : {}),
      });
      counts[cand.source] += 1;
      if (row.airing_at) counts.upgraded += 1;
    } else if (!row.airing_at && !row.air_date_unknown && n <= undatedUpTo) {
      // Um episódio antigo sem data, de uma série que já passou dele.
      plan.updates.push({ anime_id: anime.id, episode_number: n, airing_at: null, air_date_unknown: true });
      counts.flagged += 1;
    }
  }
  return plan;
}

/** Soma os contadores de vários planos (para o relatório). */
export function addCounts(into, counts) {
  for (const [k, v] of Object.entries(counts)) into[k] = (into[k] ?? 0) + v;
  return into;
}
