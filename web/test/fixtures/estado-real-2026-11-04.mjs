/**
 * Títulos REAIS, como estavam na base a 2026-11-04 (levantamento só de
 * leitura, ramo `auditoria/estado-no-ar-2026-11-04`). Partilhado pelos testes
 * da web e da ingestão: os dois lados aplicam a mesma regra
 * (`web/lib/status/live-status.mjs`) aos mesmos factos.
 *
 * Cada temporada guarda o que a base tinha: primeiro e último episódio, as
 * datas do primeiro e do último, o `season_number` (`null` quando a base não
 * o tem) e se os episódios trazem metadados do TVDB (título, sinopse ou
 * imagem: é o que diz que a temporada está inteira, ver "O total conhecido"
 * em lib/status/live-status.mjs). Os episódios do meio espalham-se entre as
 * duas datas (para a regra só contam o último que saiu, o próximo, os que
 * ficaram sem data e o total da temporada).
 */

export const AGORA = new Date("2026-11-04T09:09:44Z");

/**
 * @typedef {{ from: number, to: number, first: string, last: string, season?: number | null, tvdb?: boolean }} Temporada
 * @typedef {{ title: string, status: "airing" | "finished" | "upcoming" | "hiatus", scheduleNote: string | null,
 *   temporadas: Temporada[], extra?: { episodeNumber: number, airingAt: string | null, seasonNumber?: number | null, title?: string | null }[] }} Titulo
 */

/** @type {Record<string, Titulo>} */
export const REAIS = {
  slime: {
    title: "That Time I Got Reincarnated as a Slime",
    status: "airing",
    scheduleNote: null,
    temporadas: [
      { from: 1, to: 24, first: "2018-10-02T00:00:00Z", last: "2019-03-19T00:00:00Z", season: 1, tvdb: true },
      { from: 25, to: 48, first: "2021-01-12T00:00:00Z", last: "2021-09-21T00:00:00Z", season: 2, tvdb: true },
      { from: 49, to: 72, first: "2024-04-05T00:00:00Z", last: "2024-09-27T00:00:00Z", season: 3, tvdb: true },
      { from: 73, to: 96, first: "2026-04-03T00:00:00Z", last: "2026-09-25T15:00:00Z", season: 4, tvdb: true },
    ],
  },
  mushoku: {
    title: "Mushoku Tensei: Jobless Reincarnation",
    status: "airing",
    scheduleNote: null,
    temporadas: [
      { from: 1, to: 24, first: "2021-01-11T00:00:00Z", last: "2021-12-20T00:00:00Z", season: 1, tvdb: true },
      { from: 26, to: 49, first: "2023-07-10T00:00:00Z", last: "2024-07-01T00:00:00Z", season: 2, tvdb: true },
      { from: 50, to: 63, first: "2026-07-04T11:00:00Z", last: "2026-09-27T15:01:00Z", season: 3, tvdb: true },
    ],
  },
  onePiece: {
    title: "One Piece",
    status: "airing",
    scheduleNote: "Episodes 1181 and further will continue in April 2027.",
    temporadas: [
      // As temporadas 1 a 23 do TVDB, numa só (para a regra é igual).
      { from: 1, to: 1174, first: "1999-10-20T00:00:00Z", last: "2026-08-16T16:00:00Z", season: 23, tvdb: true },
      // Os do horário, sem temporada nem metadados.
      { from: 1175, to: 1180, first: "2026-08-23T16:00:00Z", last: "2026-09-27T16:00:00Z", season: null },
    ],
    // Os dois que a fonte deixou de anunciar ficaram sem data.
    extra: [
      { episodeNumber: 1181, airingAt: null },
      { episodeNumber: 1182, airingAt: null },
    ],
  },
  hanakappa: {
    // Série longa, total desconhecido. A temporada 1 do TVDB (66 episódios, 63
    // sem data) e os seis mais recentes do horário, sem temporada: o 668.º a
    // 2026-08-06.
    title: "Hanakappa",
    status: "airing",
    scheduleNote: null,
    temporadas: [
      { from: 1, to: 3, first: "2010-04-05T00:00:00Z", last: "2010-04-07T00:00:00Z", season: 1, tvdb: true },
      { from: 663, to: 668, first: "2026-07-02T22:10:00Z", last: "2026-08-06T22:10:00Z", season: null },
    ],
    extra: Array.from({ length: 63 }, (_, i) => ({ episodeNumber: 4 + i, airingAt: null, seasonNumber: 1, title: "TVDB" })),
  },
  chibiGodzilla3: {
    // 2 dos 48 episódios na base, os dois do horário: o 47 e o 48.
    title: "Chibi Godzilla Raids Again Season 3",
    status: "airing",
    scheduleNote: null,
    temporadas: [{ from: 47, to: 48, first: "2026-07-14T22:06:00Z", last: "2026-07-21T22:06:00Z", season: null }],
  },
  plannosaurus: {
    // Temporada 1 do TVDB inteira (12 de 12), a última a 2026-09-26.
    title: "Plannosaurus Gachi Koseibutsu-bu",
    status: "airing",
    scheduleNote: null,
    temporadas: [{ from: 1, to: 12, first: "2026-07-04T22:00:00Z", last: "2026-09-26T22:00:00Z", season: 1, tvdb: true }],
  },
  espada2: {
    title: "Reincarnated as a Sword 2",
    status: "airing",
    scheduleNote: null,
    temporadas: [{ from: 1, to: 8, first: "2026-09-30T15:30:00Z", last: "2026-11-18T15:30:00Z" }],
  },
  marriagetoxin: {
    // `airing` no manami, sem um único episódio na base.
    title: "Marriagetoxin",
    status: "airing",
    scheduleNote: null,
    temporadas: [],
  },
  blueBox2: {
    // No ar, com nota de horário (um adiamento) e o próximo a 2026-11-08.
    title: "Blue Box 2nd Season",
    status: "airing",
    scheduleNote: "Episode 5 has been delayed.",
    temporadas: [{ from: 1, to: 7, first: "2026-10-04T08:00:00Z", last: "2026-11-22T08:00:00Z" }],
    extra: [],
  },
  cardfight: {
    // Por estrear, com a estreia marcada para daqui a dois dias.
    title: "CARDFIGHT!! VANGUARD Divinez: Parallactic Fate",
    status: "upcoming",
    scheduleNote: null,
    temporadas: [{ from: 1, to: 3, first: "2026-11-06T23:00:00Z", last: "2026-11-20T23:00:00Z" }],
  },
};

/**
 * Os episódios de um título, espalhados entre as datas de cada temporada.
 *
 * @param {Titulo} titulo
 * @returns {{ episodeNumber: number, airingAt: string | null, seasonNumber: number | null, title: string | null }[]}
 */
export function episodiosDe(titulo) {
  const out = [];
  for (const t of titulo.temporadas) {
    const a = Date.parse(t.first);
    const b = Date.parse(t.last);
    const n = t.to - t.from;
    for (let k = 0; k <= n; k += 1) {
      const at = n === 0 ? a : a + ((b - a) * k) / n;
      out.push({
        episodeNumber: t.from + k,
        airingAt: new Date(at).toISOString(),
        seasonNumber: t.season ?? null,
        title: t.tvdb ? `Episódio ${t.from + k}` : null,
      });
    }
  }
  const extra = (titulo.extra ?? []).map((e) => ({ seasonNumber: null, title: null, ...e }));
  return [...out, ...extra];
}
