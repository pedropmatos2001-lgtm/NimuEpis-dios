// @ts-check
/**
 * O estado de emissão que se MOSTRA, e o que a ingestão GRAVA. Uma regra só.
 *
 * ## Porque existe (2026-11-04)
 *
 * O dono, em PT: "One Piece, Mushoku Tensei, Slime... nenhum está no ar!". E
 * tinha razão. Medido nesse dia contra a base real (só leituras):
 *
 *  - Slime (ficha da franquia, 96 episódios em 4 temporadas): o 96.º saiu a
 *    2026-09-25, não há nenhum episódio por sair, e estava `airing`;
 *  - Mushoku Tensei (63 episódios): o 63.º saiu a 2026-09-27, idem;
 *  - One Piece: o 1180 saiu a 2026-09-27 e a fonte diz "Episodes 1181 and
 *    further will continue in April 2027". Está em pausa, não no ar.
 *
 * O `status` guardado vinha da fonte de quando a temporada nova estava a dar
 * (a correção pelo horário só promovia a "airing", nunca terminava nada) e
 * ninguém o voltava a pôr como estava. Esta regra decide pelo que os
 * EPISÓDIOS dizem, e é a mesma nos dois lados:
 *
 *  - `ingestion/src/status-reconcile.js` usa-a para corrigir a base;
 *  - `web/` usa-a para nunca MOSTRAR "No ar" enquanto a base não foi
 *    corrigida (ver `web/lib/data/live-status.ts`).
 *
 * É JavaScript puro (`.mjs`) para a ingestão, que corre em Node sem compilar,
 * a poder importar tal e qual. O TypeScript lê os tipos do JSDoc.
 *
 * ## A regra
 *
 * "No ar" SÓ quando saiu um episódio nas últimas três semanas ou o próximo tem
 * data marcada nas próximas três semanas. Fora disso:
 *
 *  - nunca saiu nada e há data → "Em breve" (`upcoming`);
 *  - nunca saiu nada, não há data, e a fonte diz `airing` → sem estado
 *    (`null`, ver "Sem prova");
 *  - há data, mas para lá das três semanas → "Em breve" se a série estava
 *    terminada ou por estrear (é uma estreia: temporada nova, filme), "Em
 *    pausa" se estava a dar (voltará nessa data);
 *  - não há data nenhuma:
 *      - a fonte disse terminada → terminada (episódios sem data não a
 *        desmentem, ver "Episódios sem data");
 *      - a fonte disse por estrear (ou nada) → terminada só com o total
 *        conhecido atingido; senão, a palavra da fonte;
 *      - a fonte deu uma nota de horário (adiamento, regresso) ou a base tem
 *        episódios por datar depois do último que saiu → "Em pausa";
 *      - o último episódio que saiu chegou ao TOTAL CONHECIDO da temporada →
 *        terminada. É o caso do Slime e do Mushoku: a temporada acabou;
 *      - em tudo o resto → "Em pausa". Sem total conhecido não se diz
 *        "terminada": o Hanakappa (série longa, total desconhecido) e o Chibi
 *        Godzilla 3 (2 de 48 episódios na base) ficam "Em pausa".
 *
 * ## O total conhecido
 *
 * A base não guarda o número de episódios de uma série. O total que se conhece
 * é o do TVDB: a recolha de episódios do TVDB (catalogue-episodes.js) grava a
 * temporada inteira tal como o TVDB a lista, com `season_number` e os
 * metadados (título, sinopse, imagem). Por isso: o último episódio que saiu
 * tem temporada, essa temporada tem episódios com metadados do TVDB, e nenhum
 * episódio dela tem número maior → o total foi atingido. Uma temporada feita
 * só com a janela do horário (sem metadados do TVDB) não diz o total.
 *
 * `cancelled` passa sempre tal como está.
 *
 * ## Episódios sem data (revisão de 2026-11-04)
 *
 * Um episódio sem data depois do último que saiu NÃO diz que a série continua
 * quando a fonte a deu por terminada. Medido na base real: a arrumação da
 * ingestão (`clearStaleFutureEpisodes`) tira a data às projeções que a fonte
 * deixou de anunciar, e o TVDB lista temporadas novas sem data. O BLEACH TYBW
 * "The Calamity" (10 episódios, terminado na AnimeSchedule e na AniList)
 * tinha 11 a 13 sem data, e passava a "No ar"; o [Oshi no Ko], o BLACK TORCH e
 * mais 27 terminadas passavam a "Em pausa" na ficha. Por isso, para uma
 * terminada, só um episódio DATADO à frente conta. Para uma que estava a dar,
 * os episódios sem data continuam a querer dizer "Em pausa" e não terminada.
 *
 * ## Sem prova
 *
 * Uma ficha `airing` sem um único episódio datado sai sem estado (`null`):
 * nem "No ar" (não se vê nada a sair), nem "Em pausa" (nunca começou aqui).
 * Também nunca se inventa "Em pausa" para o que a fonte deu por estrear.
 */

/** A janela de "no ar", para trás e para a frente. Cerca de três semanas. */
export const LIVE_WINDOW_DAYS = 21;

const DAY_MS = 86_400_000;
const WINDOW_MS = LIVE_WINDOW_DAYS * DAY_MS;

/**
 * @typedef {"airing" | "finished" | "upcoming" | "hiatus" | "cancelled"} AnimeStatus
 */

/**
 * O que a regra precisa de saber de um título. Tudo o que se refere a
 * episódios é sobre episódios COM data, exceto `episodesPending`.
 *
 * @typedef {object} AiringFacts
 * @property {AnimeStatus | null} status O estado guardado (a palavra da fonte).
 * @property {boolean} airedEver Saiu pelo menos um episódio com data até agora.
 * @property {boolean} airedWithinWindow Saiu um episódio nas últimas `LIVE_WINDOW_DAYS`.
 * @property {string | null} nextAiringAt A data (ISO) do próximo episódio, ou `null`.
 * @property {boolean} episodesPending Há episódios sem data numerados depois do último que saiu.
 * @property {boolean} pauseNote A fonte publicou uma nota de horário (`schedule_note`).
 * @property {boolean} finalEpisodeAired O último episódio que saiu chegou ao total
 *   conhecido da sua temporada (ver "O total conhecido", acima).
 */

/**
 * O estado que é verdade AGORA.
 *
 * @param {AiringFacts} facts
 * @param {Date} [now]
 * @returns {AnimeStatus | null}
 */
export function liveStatus(facts, now = new Date()) {
  const status = facts.status;
  if (status === "cancelled") return "cancelled";

  const nowMs = now.getTime();
  const nextMs = facts.nextAiringAt === null ? Number.NaN : Date.parse(facts.nextAiringAt);
  const hasNext = Number.isFinite(nextMs) && nextMs > nowMs;
  const soon = hasNext && nextMs - nowMs <= WINDOW_MS;

  if (!facts.airedEver) {
    if (hasNext) return "upcoming";
    // "No ar" sem um único episódio datado: não há prova de nada. Nem "No ar"
    // nem "Em pausa" (que diz que começou e parou): sem rótulo. Medido a
    // 2026-11-04 nas 170 fichas assim (todas do manami): a AniList dá 33 a
    // emitir, 32 terminadas e não conhece as outras 104. Ver "Sem prova".
    if (status === "airing") return null;
    return status;
  }

  if (facts.airedWithinWindow || soon) {
    // O último episódio saiu há pouco e a fonte já disse que acabou. Só um
    // episódio DATADO à frente a desmente (ver "Episódios sem data").
    if (status === "finished" && !hasNext) return "finished";
    return "airing";
  }

  if (hasNext) return status === "finished" || status === "upcoming" ? "upcoming" : "hiatus";
  // (b) A fonte diz terminada. Episódios sem data não a desmentem.
  if (status === "finished") return "finished";
  // A fonte nunca disse que estava a dar: "Em pausa" não se inventa. Só o
  // total conhecido a dá por terminada; sem ele fica a palavra da fonte.
  if (status === "upcoming" || status === null) return facts.finalEpisodeAired ? "finished" : status;
  if (status === "hiatus" || facts.pauseNote || facts.episodesPending) return "hiatus";
  // (a) O último que saiu chegou ao total conhecido.
  if (facts.finalEpisodeAired) return "finished";
  return "hiatus";
}

/**
 * Um episódio, como a regra o lê. `seasonNumber` e os metadados do TVDB
 * (`title`, `overview`, `imageUrl`) servem para saber o total da temporada.
 *
 * @typedef {{
 *   episodeNumber: number,
 *   airingAt: string | null,
 *   seasonNumber?: number | null,
 *   title?: string | null,
 *   overview?: string | null,
 *   imageUrl?: string | null,
 * }} EpisodeFacts
 */

/**
 * O último episódio que saiu chegou ao total conhecido da sua temporada?
 *
 * @param {readonly EpisodeFacts[]} episodes Todos os episódios da ficha.
 * @param {number} lastAiredNumber O maior número entre os que já saíram.
 * @param {number | null | undefined} lastAiredSeason A temporada desse episódio.
 * @returns {boolean}
 */
export function reachedKnownTotal(episodes, lastAiredNumber, lastAiredSeason) {
  if (lastAiredSeason === null || lastAiredSeason === undefined) return false;
  let fromTvdb = false;
  let seasonMax = Number.NEGATIVE_INFINITY;
  for (const e of episodes) {
    if (e.seasonNumber !== lastAiredSeason) continue;
    if (e.episodeNumber > seasonMax) seasonMax = e.episodeNumber;
    if (hasTvdbMetadata(e)) fromTvdb = true;
  }
  return fromTvdb && lastAiredNumber >= seasonMax;
}

/**
 * @param {{ title?: string | null, overview?: string | null, imageUrl?: string | null }} e
 * @returns {boolean}
 */
function hasTvdbMetadata(e) {
  return Boolean(e.title || e.overview || e.imageUrl);
}

/**
 * Os factos de um título a partir da lista dos seus episódios. É o que a ficha
 * tem à mão (todos os episódios), e o que os testes usam.
 *
 * @param {{
 *   status: AnimeStatus | null,
 *   scheduleNote?: string | null,
 *   episodes: readonly EpisodeFacts[],
 * }} input
 * @param {Date} [now]
 * @returns {AiringFacts}
 */
export function airingFactsFromEpisodes(input, now = new Date()) {
  const nowMs = now.getTime();
  let lastAiredMs = Number.NEGATIVE_INFINITY;
  let lastAiredNumber = Number.NEGATIVE_INFINITY;
  /** @type {number | null | undefined} */
  let lastAiredSeason = null;
  let nextMs = Number.POSITIVE_INFINITY;
  /** @type {string | null} */
  let nextAiringAt = null;
  for (const episode of input.episodes) {
    if (episode.airingAt === null) continue;
    const at = Date.parse(episode.airingAt);
    if (!Number.isFinite(at)) continue;
    if (at <= nowMs) {
      if (at > lastAiredMs) lastAiredMs = at;
      if (episode.episodeNumber > lastAiredNumber) {
        lastAiredNumber = episode.episodeNumber;
        lastAiredSeason = episode.seasonNumber ?? null;
      }
    } else if (at < nextMs) {
      nextMs = at;
      nextAiringAt = episode.airingAt;
    }
  }
  const airedEver = Number.isFinite(lastAiredMs);
  const episodesPending = input.episodes.some(
    (episode) => episode.airingAt === null && (!airedEver || episode.episodeNumber > lastAiredNumber),
  );
  return {
    status: input.status,
    airedEver,
    airedWithinWindow: airedEver && nowMs - lastAiredMs <= WINDOW_MS,
    nextAiringAt,
    episodesPending,
    pauseNote: typeof input.scheduleNote === "string" && input.scheduleNote.trim() !== "",
    finalEpisodeAired: airedEver && reachedKnownTotal(input.episodes, lastAiredNumber, lastAiredSeason),
  };
}

/**
 * As mudanças de estado que a INGESTÃO pode gravar. Mais estreita do que a
 * regra de cima, de propósito: a base só muda com prova.
 *
 *  - `airing` → `finished` ou `hiatus`, só com pelo menos um episódio datado
 *    (sem episódios nenhuns não há prova de nada, e fica como está);
 *  - `hiatus` → `airing`, quando volta a sair ou a haver episódio na janela;
 *  - `finished` → `airing`, só com um episódio DATADO por sair e outro (ou
 *    ele) na janela das três semanas: é a temporada nova dobrada para a
 *    ficha. Episódios sem data não chegam (ver "Episódios sem data");
 *  - `upcoming` → `airing`, só com um episódio já saído.
 *
 * Nunca escreve `upcoming` por cima de nada, nem toca em `cancelled`.
 *
 * @param {AiringFacts} facts
 * @param {Date} [now]
 * @returns {AnimeStatus | null} O estado a gravar, ou `null` para deixar como está.
 */
export function statusToStore(facts, now = new Date()) {
  const from = facts.status;
  const to = liveStatus(facts, now);
  if (to === from || to === null) return null;
  const evidence = facts.airedEver || facts.nextAiringAt !== null;
  if (!evidence) return null;
  if (from === "airing" && (to === "finished" || to === "hiatus")) return to;
  if (from === "hiatus" && to === "airing") return to;
  if (from === "finished" && to === "airing") return to;
  if (from === "upcoming" && to === "airing" && facts.airedEver) return to;
  return null;
}

// ── Os factos a partir de leituras em lote (ingestão e web) ──────────────────

/**
 * @typedef {{ aired: boolean, nextAiringAt: string | null }} WindowFacts
 *   O que a janela diz: saiu lá algum episódio, e o primeiro que vem nela.
 * @typedef {{ airedEver: boolean, nextAiringAt: string | null, episodesPending: boolean, finalEpisodeAired?: boolean }} ProbeFacts
 *   O que a base diz para lá da janela. `finalEpisodeAired` só é preciso
 *   quando nada saiu na janela e não há próximo (ver `needsTotal`).
 */

/**
 * O que a janela de três semanas diz de cada ficha.
 *
 * @param {{ anime_id: string, airing_at: string }[]} rows Episódios com data
 *   dentro de [agora − janela, agora + janela].
 * @param {Date} now
 * @returns {Map<string, WindowFacts>}
 */
export function windowByAnime(rows, now) {
  const nowMs = now.getTime();
  const out = new Map();
  for (const r of rows ?? []) {
    if (!r?.anime_id || !r.airing_at) continue;
    const at = Date.parse(r.airing_at);
    if (!Number.isFinite(at)) continue;
    /** @type {WindowFacts} */
    const w = out.get(r.anime_id) ?? { aired: false, nextAiringAt: null };
    if (at <= nowMs) w.aired = true;
    else if (w.nextAiringAt === null || at < Date.parse(w.nextAiringAt)) w.nextAiringAt = r.airing_at;
    out.set(r.anime_id, w);
  }
  return out;
}

/**
 * Os factos da regra para uma ficha. `probe` só é preciso quando a janela não
 * chega para decidir (nada saiu nela, ou não há próximo dentro dela).
 *
 * @param {{ status: AnimeStatus | null, schedule_note?: string | null }} anime
 * @param {WindowFacts | undefined} win
 * @param {ProbeFacts | null} probe
 * @returns {AiringFacts}
 */
export function factsFor(anime, win, probe) {
  const note = typeof anime.schedule_note === "string" && anime.schedule_note.trim() !== "";
  return {
    status: anime.status ?? null,
    airedEver: Boolean(win?.aired) || Boolean(probe?.airedEver),
    airedWithinWindow: Boolean(win?.aired),
    nextAiringAt: win?.nextAiringAt ?? probe?.nextAiringAt ?? null,
    episodesPending: Boolean(probe?.episodesPending),
    pauseNote: note,
    finalEpisodeAired: Boolean(probe?.finalEpisodeAired),
  };
}

/**
 * A janela chega para decidir? Só quando nela saiu um episódio E há outro
 * marcado: é o caso comum de uma série a dar. Nos outros pergunta-se à base se
 * alguma vez saiu alguma coisa e qual é o próximo, mesmo longe.
 */
/**
 * @param {WindowFacts | undefined} win
 * @returns {boolean}
 */
export function needsProbe(win) {
  return !win || !win.aired || win.nextAiringAt === null;
}

/**
 * Vale a pena ler o total da temporada? Só quando a decisão depende dele: algo
 * já saiu, nada saiu na janela, não há próximo, nem episódios por datar, nem
 * nota. Poupa leituras às séries que a regra decide sem ele.
 *
 * @param {{ status: AnimeStatus | null, schedule_note?: string | null }} anime
 * @param {WindowFacts | undefined} win
 * @param {ProbeFacts} probe
 * @returns {boolean}
 */
export function needsTotal(anime, win, probe) {
  const note = typeof anime.schedule_note === "string" && anime.schedule_note.trim() !== "";
  return (
    (anime.status === "airing" || anime.status === "upcoming") &&
    probe.airedEver &&
    !win?.aired &&
    (win?.nextAiringAt ?? probe.nextAiringAt) === null &&
    !probe.episodesPending &&
    !note
  );
}
