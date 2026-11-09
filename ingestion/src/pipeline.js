// Pure transformation pipeline: raw source payloads → validated DB-shaped rows.
// No I/O here — this is what the unit tests and --dry-run exercise directly.
import {
  animescheduleToAnimeRow,
  animescheduleToEpisodeProto,
  validateAnimeRow,
} from './mappers.js';
import { crossFillIds } from './manami.js';
import { altNames, animescheduleNames } from './names.js';
import {
  adultReason,
  manamiAdultReasonByIds,
  manamiAdultReasonByTitle,
} from './adult-content.js';

/**
 * @param {object} input
 * @param {Array}  input.timetableEntries  concatenated weekly timetable entries
 * @param {Map}    [input.detailsByRoute]  route → GET /anime/{route} payload
 * @param {object} [input.manamiIndex]     from buildManamiIndex() (optional)
 * @param {Map}    [input.manamiAdultTitles] from buildManamiAdultTitleIndex() (optional)
 * @returns {{ animeRows, episodeProtos, yearByRoute, namesByRoute, rejectedAnimes,
 *             adultRejected, skippedEpisodes }}
 */
export function buildRows({
  timetableEntries,
  detailsByRoute = new Map(),
  manamiIndex = null,
  manamiAdultTitles = null,
}) {
  // Group weekly entries per show; the LAST entry wins for catalogue fields
  // (consistent with historical last-wins dedupe semantics).
  const entriesByRoute = new Map();
  for (const entry of timetableEntries ?? []) {
    if (!entry?.route) continue;
    if (!entriesByRoute.has(entry.route)) entriesByRoute.set(entry.route, []);
    entriesByRoute.get(entry.route).push(entry);
  }

  const animeRows = [];
  const yearByRoute = new Map(); // enrichment hint for TVDB/TMDB year filters
  // route → os outros nomes (romaji, inglês, sinónimos) para animes.alt_titles.
  // Não vão na linha: a coluna pode ainda não existir, e o run.js junta-os à
  // parte, sem apagar os que o manami já lá pôs.
  const namesByRoute = new Map();
  let rejectedAnimes = 0;
  // Títulos 18+ barrados nesta corrida: { route, title, mal, reason }. O run.js
  // usa-os para avisar quando algum JÁ está guardado (ver purge-adult.js).
  const adultRejected = [];

  for (const [route, entries] of entriesByRoute) {
    const detail = detailsByRoute.get(route) ?? null;
    const row = animescheduleToAnimeRow(entries.at(-1), detail);

    // ── Conteúdo adulto: fora ANTES de tudo o resto (2026-11-01) ───────────
    // Até aqui este caminho não filtrava nada, e foi por ele que os OVAs
    // hentai do verão de 2026 entraram no catálogo com episódios. Basta uma
    // fonte dizer "adulto": os géneros da AnimeSchedule (detalhe e horário),
    // as etiquetas do manami pelos ids, e — só quando não há id nenhum em
    // comum — o título no manami, se for inequívoco. A lista à mão vê todos
    // os nomes.
    const reason = animescheduleAdultReason(entries.at(-1), detail, row, {
      manamiIndex,
      manamiAdultTitles,
    });
    if (reason) {
      adultRejected.push({
        route,
        title: row.title,
        mal: row.external_ids?.mal ?? null,
        reason,
      });
      continue;
    }

    // Cross-fill missing external ids via the manami anime-offline-database
    // (matched on mal/anilist); its picture is the last-resort cover fallback.
    if (manamiIndex) {
      const { ids, picture } = crossFillIds(row.external_ids, manamiIndex);
      row.external_ids = ids;
      if (!row.cover_image_url && picture) row.cover_image_url = picture;
    }

    if (!validateAnimeRow(row)) {
      rejectedAnimes += 1;
      continue;
    }
    animeRows.push(row);
    namesByRoute.set(route, altNames(animescheduleNames(entries.at(-1), detail), row.title));
    const year = Number(detail?.year);
    yearByRoute.set(route, Number.isInteger(year) ? year : null);
  }

  // Episodes only for shows that produced a valid anime row.
  const validRoutes = new Set(animeRows.map((r) => r.animeschedule_route));
  const episodeProtos = [];
  let skippedEpisodes = 0;
  for (const entry of timetableEntries ?? []) {
    const proto = animescheduleToEpisodeProto(entry ?? {});
    if (!proto || !validRoutes.has(proto.route)) {
      skippedEpisodes += 1;
      continue;
    }
    episodeProtos.push(proto);
  }

  return {
    animeRows,
    episodeProtos,
    yearByRoute,
    namesByRoute,
    rejectedAnimes,
    adultRejected,
    skippedEpisodes,
  };
}

/**
 * O motivo por que um título da AnimeSchedule é 18+, ou `null`.
 *
 * Exportada para os testes. `row` é a linha já mapeada (traz os ids extraídos
 * dos `websites` do detalhe e o título escolhido).
 */
export function animescheduleAdultReason(entry, detail, row, { manamiIndex = null, manamiAdultTitles = null } = {}) {
  const allNames = animescheduleNames(entry, detail);
  const own = adultReason({
    genres: [...(detail?.genres ?? []), ...(entry?.genres ?? [])],
    // Nenhum destes vem hoje na v3 da AnimeSchedule; ficam aceites para o dia
    // em que vierem, sem ser preciso voltar aqui.
    isAdult: detail?.isAdult,
    adult: detail?.adult ?? detail?.nsfw,
    rating: detail?.rating,
    titles: allNames,
  });
  if (own) return own;

  const ids = row?.external_ids ?? {};
  const byIds = manamiAdultReasonByIds(ids, manamiIndex);
  if (byIds) return byIds;

  // Pelo título só quando a linha não tem id que o manami conheça: com um id em
  // comum, o manami já respondeu acima, e um título repetido noutra série não
  // pode desmentir o id. Só os nomes principais (inglês, romaji, título), não
  // sinónimos nem abreviaturas, que colidem com facilidade.
  const knownToManami =
    (ids.mal != null && manamiIndex?.byMal?.has(Number(ids.mal))) ||
    (ids.anilist != null && manamiIndex?.byAnilist?.has(Number(ids.anilist)));
  if (knownToManami) return null;
  const names = detail?.names ?? {};
  return manamiAdultReasonByTitle(
    [names.english, entry?.english, names.romaji, entry?.romaji, entry?.title, detail?.title],
    manamiAdultTitles,
  );
}
