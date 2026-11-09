// Ingestion entry point.
//   node src/run.js             → live run (AnimeSchedule → Supabase)
//   node src/run.js --dry-run   → fixtures only; no network, no Supabase.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config, assertLiveConfig } from './config.js';
import { buildRows } from './pipeline.js';
import { scheduleNoteOf } from './mappers.js';
import { buildManamiIndex } from './manami.js';
import { buildManamiAdultTitleIndex } from './adult-content.js';
import {
  airedEpisodeIds,
  chunk,
  dedupeByKey,
  dedupeEpisodes,
  scheduleNoteChanges,
  staleCleanupRows,
  staleFutureEpisodeIds,
} from './util.js';
import { fetchTimetableWindow } from './timetable-window.js';
import { reconcileStatuses } from './status-reconcile.js';
import { backfillRecent, manamiHints, manamiTotals } from './episodes-backfill.js';
import { partitionByAlias, aliasEpisodeRow } from './franchise.js';

const EPISODE_UPSERT_CHUNK = 500;
const IN_LIST_CHUNK = 150; // keeps PostgREST .in() URLs comfortably short
const DRY_RUN = process.argv.includes('--dry-run');

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../test/fixtures');

async function readFixture(name) {
  return JSON.parse(await readFile(resolve(FIXTURES_DIR, name), 'utf8'));
}

// ── Source gathering ─────────────────────────────────────────────────────────

/** Live: timetable window + per-show detail + manami index. */
async function gatherLive() {
  const { fetchTimetableWeek, fetchAnimeDetail } = await import('./animeschedule.js');

  // Manami is optional infrastructure (id mapping + cover fallback): a download
  // failure must not block the calendar refresh.
  let manamiIndex = null;
  let manamiAdultTitles = null;
  let manamiEpisodeTotals = new Map();
  let manamiEpisodeHints = new Map();
  try {
    const { loadManamiDatabase } = await import('./manami.js');
    const manamiEntries = await loadManamiDatabase();
    manamiIndex = buildManamiIndex(manamiEntries);
    // O total de episódios de cada título, para os episódios em falta no fim
    // da corrida (ver `backfillRecent` em episodes-backfill.js).
    manamiEpisodeTotals = manamiTotals(manamiEntries);
    // E o que diz dos videoclipes e PV, para não lhes criar episódios.
    manamiEpisodeHints = manamiHints(manamiEntries);
    // Segundo filtro 18+ pelo título, para as séries sem id em comum com o
    // manami (ver adult-content.js).
    manamiAdultTitles = buildManamiAdultTitleIndex(manamiEntries);
    console.log(`[nimu] manami-DB loaded (${manamiIndex.size} entries)`);
  } catch (err) {
    console.warn(`[nimu] ⚠ manami-DB unavailable (non-fatal): ${err.message}`);
  }

  // As semanas do horário: da anterior à +2 como sempre (o "sub" tem de vir),
  // mais a +3, que só acrescenta e cuja falha é só um aviso. O "raw" preenche o
  // que o "sub" ainda não tem, sobretudo as estreias (ver `mergeTimetables`).
  // Só com o horário lido por inteiro se pode concluir que uma série "não está
  // lá" (`timetableComplete`, ver `clearStaleFutureEpisodes`), e a arrumação só
  // olha até `staleWindowEnd`, o fim da +2. Ver timetable-window.js.
  const { timetableEntries, timetableComplete, staleWindowEnd } = await fetchTimetableWindow({
    fetchWeek: fetchTimetableWeek,
    airType: config.airType,
  });

  // One detail call per unique show (names, websites/external ids, metadata).
  // A failed detail is non-fatal: the show still ingests on timetable data.
  const routes = [...new Set(timetableEntries.map((e) => e?.route).filter(Boolean))];
  const detailsByRoute = new Map();
  let detailFailures = 0;
  for (const route of routes) {
    try {
      detailsByRoute.set(route, await fetchAnimeDetail(route));
    } catch (err) {
      detailFailures += 1;
      console.warn(`[nimu] ⚠ detail failed for "${route}" (non-fatal): ${err.message}`);
    }
  }
  console.log(`[nimu] details: ${detailsByRoute.size} ok, ${detailFailures} failed`);

  return {
    timetableEntries,
    detailsByRoute,
    manamiIndex,
    manamiAdultTitles,
    timetableComplete,
    staleWindowEnd,
    manamiEpisodeTotals,
    manamiEpisodeHints,
  };
}

/** Dry-run: documented-shape fixtures, zero network. */
async function gatherFixtures() {
  const timetableEntries = await readFixture('timetable-week.json');
  const detailsByRoute = new Map(Object.entries(await readFixture('anime-details.json')));
  const manamiEntries = (await readFixture('manami-mini.json')).data;
  const manamiIndex = buildManamiIndex(manamiEntries);
  const manamiAdultTitles = buildManamiAdultTitleIndex(manamiEntries);
  return { timetableEntries, detailsByRoute, manamiIndex, manamiAdultTitles };
}

// ── Enrichment (all optional, all non-fatal) ─────────────────────────────────

/** TVDB: resolve tvdb id (+ description fallback) for rows that lack one. */
async function enrichWithTvdb(animeRows, yearByRoute) {
  if (!config.tvdbApiKey) {
    console.log('[nimu] TVDB enrichment skipped (TVDB_API_KEY not set)');
    return;
  }
  const { searchSeries } = await import('./tvdb.js');
  let hits = 0;
  for (const row of animeRows) {
    if (row.external_ids.tvdb !== undefined) continue;
    try {
      const found = await searchSeries(row.title, yearByRoute.get(row.animeschedule_route));
      if (!found) continue;
      row.external_ids.tvdb = found.tvdbId;
      if (!row.description && found.overview) row.description = found.overview;
      if (!row.cover_image_url && found.imageUrl) row.cover_image_url = found.imageUrl;
      hits += 1;
    } catch (err) {
      console.warn(`[nimu] ⚠ TVDB lookup failed for "${row.title}" (non-fatal): ${err.message}`);
    }
  }
  console.log(`[nimu] TVDB enrichment: ${hits} matched`);
}

/** TMDB: preferred poster URLs (artwork licence paper trail). */
async function enrichWithTmdb(animeRows, yearByRoute) {
  if (!config.tmdbApiKey) {
    console.log('[nimu] TMDB posters skipped (TMDB_API_KEY not set)');
    return;
  }
  const { searchTvPoster } = await import('./tmdb.js');
  let hits = 0;
  for (const row of animeRows) {
    if (row.external_ids.tmdb !== undefined) continue; // resolved on a past run
    try {
      const found = await searchTvPoster(row.title, yearByRoute.get(row.animeschedule_route));
      if (!found) continue;
      row.external_ids.tmdb = found.tmdbId;
      row.cover_image_url = found.posterUrl; // TMDB poster is preferred
      hits += 1;
    } catch (err) {
      console.warn(`[nimu] ⚠ TMDB lookup failed for "${row.title}" (non-fatal): ${err.message}`);
    }
  }
  console.log(`[nimu] TMDB posters: ${hits} matched`);
}

// ── Reconciliation with existing rows ────────────────────────────────────────

/**
 * Legacy rows (AniList era) have mal_id but no animeschedule_route. Matching
 * incoming rows to them BY mal_id and carrying their `id` into the upsert
 * adopts those rows in place — preserving watchlist/notification FKs — instead
 * of creating duplicates (which the mal_id UNIQUE index would reject anyway).
 */
async function reconcile(supabase, animeRows) {
  const routes = animeRows.map((r) => r.animeschedule_route);
  const malIds = animeRows.map((r) => r.external_ids.mal).filter((v) => v != null);

  const existing = [];
  for (const routeChunk of chunk(routes, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, animeschedule_route, external_ids, cover_image_url, description')
      .in('animeschedule_route', routeChunk);
    if (error) throw error;
    existing.push(...data);
  }
  for (const malChunk of chunk(malIds, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, animeschedule_route, external_ids, cover_image_url, description')
      .in('mal_id', malChunk);
    if (error) throw error;
    existing.push(...data);
  }

  const byRoute = new Map();
  const byMal = new Map();
  for (const row of existing) {
    if (row.animeschedule_route) byRoute.set(row.animeschedule_route, row);
    if (row.mal_id != null) byMal.set(row.mal_id, row);
  }

  const claimedMal = new Set(); // in-batch: one row per mal_id column value
  const withId = [];
  const withoutId = [];
  for (const row of animeRows) {
    const mal = row.external_ids.mal;
    const match =
      byRoute.get(row.animeschedule_route) ?? (mal != null ? byMal.get(mal) : undefined);

    if (match) {
      // Merge, never erase: ids found on past runs (tvdb/tmdb), TMDB posters
      // and TVDB descriptions must survive runs where enrichment is skipped.
      row.external_ids = { ...match.external_ids, ...row.external_ids };
      if (row.external_ids.tmdb !== undefined && match.cover_image_url?.startsWith('https://image.tmdb.org/')) {
        row.cover_image_url = match.cover_image_url;
      }
      row.cover_image_url = row.cover_image_url ?? match.cover_image_url;
      row.description = row.description ?? match.description;
    }

    // mal_id column: only when this row is the sole claimant (UNIQUE index).
    // The id always remains available in external_ids.mal regardless.
    const malOwner = mal != null ? byMal.get(mal) : undefined;
    const canClaimMal =
      mal != null && !claimedMal.has(mal) && (!malOwner || malOwner.id === match?.id);
    row.mal_id = canClaimMal ? mal : (match?.mal_id ?? null);
    if (row.mal_id != null) claimedMal.add(row.mal_id);

    if (match) {
      withId.push({ id: match.id, ...row });
    } else {
      withoutId.push(row);
    }
  }
  return { withId, withoutId };
}

/**
 * Load the franchise route→canonical aliases for the incoming routes (empty
 * until a fold has run). Keyed by animeschedule_route → { anime_id,
 * episode_offset, season_number }. Chunked to keep the .in() URL short.
 */
async function loadRouteAliases(supabase, routes) {
  const byRoute = new Map();
  const unique = [...new Set((routes ?? []).filter(Boolean))];
  for (const routeChunk of chunk(unique, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('anime_route_aliases')
      .select('animeschedule_route, anime_id, episode_offset, season_number')
      .in('animeschedule_route', routeChunk);
    if (error) throw error;
    for (const a of data ?? []) byRoute.set(a.animeschedule_route, a);
  }
  return byRoute;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log(`[nimu] ${DRY_RUN ? 'DRY RUN (fixtures, no writes)' : 'Live ingestion'} starting…`);
  if (!DRY_RUN) assertLiveConfig();

  const sources = DRY_RUN ? await gatherFixtures() : await gatherLive();
  const {
    animeRows: rawRows,
    episodeProtos,
    yearByRoute,
    namesByRoute,
    rejectedAnimes,
    adultRejected,
    skippedEpisodes,
  } = buildRows(sources);
  const animeRows = dedupeByKey(rawRows, (r) => r.animeschedule_route);
  console.log(
    `[nimu] built ${animeRows.length} anime rows (${rejectedAnimes} rejected), ` +
      `${episodeProtos.length} episode rows (${skippedEpisodes} skipped)`,
  );
  if (adultRejected.length > 0) {
    // O título e o motivo vão para o registo: é o que permite a quem lê o log
    // do Actions ver PORQUÊ uma série deixou de aparecer.
    console.log(`[nimu] 18+: ${adultRejected.length} título(s) barrado(s):`);
    for (const a of adultRejected) console.log(`[nimu]   - ${a.title} (${a.route}) → ${a.reason}`);
  }

  if (DRY_RUN) {
    // Exercise the remaining pure steps with synthetic ids, then stop.
    const episodeRows = dedupeEpisodes(
      episodeProtos.map(({ route, ...rest }) => ({ anime_id: `dry:${route}`, ...rest })),
    );
    console.log(`[nimu] would upsert ${animeRows.length} animes, ${episodeRows.length} episodes (after dedupe)`);
    if (animeRows[0]) console.log('[nimu] sample anime row:', JSON.stringify(animeRows[0], null, 2));
    if (animeRows[0]) {
      console.log('[nimu] sample alt names:', JSON.stringify(namesByRoute.get(animeRows[0].animeschedule_route)));
    }
    if (episodeRows[0]) console.log('[nimu] sample episode row:', JSON.stringify(episodeRows[0], null, 2));
    console.log(`[nimu] ✅ Dry run OK in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — nothing written`);
    return;
  }

  await enrichWithTvdb(animeRows, yearByRoute);
  await enrichWithTmdb(animeRows, yearByRoute);

  const { supabase } = await import('./supabase.js');

  // ── 18+ que JÁ está guardado ─────────────────────────────────────────────
  // O filtro acima impede que entre ou se atualize, mas não apaga o que entrou
  // antes de 2026-11-01. Apagar uma ficha leva em cascata a lista e os
  // episódios vistos de quem a seguia, por isso não se faz às escondidas numa
  // corrida de 6 em 6 horas: avisa-se aqui (aviso do Actions), e quem decide
  // corre `purge-adult.js` (workflow "Seguranca", tarefa purge-adult). Não fatal.
  try {
    await warnStoredAdult(supabase, adultRejected);
  } catch (err) {
    console.warn(`[nimu] ⚠ verificação de 18+ guardado falhou (non-fatal): ${err.message}`);
  }

  // ── Franchise aliases: keep folded franchises folded ─────────────────────
  // A member cour whose route was merged into a canonical (catalogue-franchises.js
  // → public.anime_route_aliases) must NOT be re-created as its own catalogue row
  // here, and its per-cour episodes must land at the right ABSOLUTE number/season
  // on the canonical. Split the freshly-built rows: aliased ones are dropped from
  // the animes upsert (their canonical already exists); their episodes are routed
  // to the canonical below. No aliases (the common case) ⇒ a pure no-op.
  const aliasByRoute = await loadRouteAliases(supabase, animeRows.map((r) => r.animeschedule_route));
  const { passthrough, aliased } = partitionByAlias(animeRows, aliasByRoute);
  if (aliased.length > 0) {
    console.log(
      `[nimu] ${aliased.length} aliased member route(s) → routed to their canonical (not re-created)`,
    );
  }

  // ── Animes: adopt legacy rows by mal_id, then upsert on the natural keys ──
  const { withId, withoutId } = await reconcile(supabase, passthrough);
  const routeToId = new Map();
  if (withId.length > 0) {
    const { data, error } = await supabase
      .from('animes')
      .upsert(withId, { onConflict: 'id' })
      .select('id, animeschedule_route');
    if (error) throw error;
    for (const a of data) routeToId.set(a.animeschedule_route, a.id);
  }
  if (withoutId.length > 0) {
    const { data, error } = await supabase
      .from('animes')
      .upsert(withoutId, { onConflict: 'animeschedule_route' })
      .select('id, animeschedule_route');
    if (error) throw error;
    for (const a of data) routeToId.set(a.animeschedule_route, a.id);
  }
  console.log(`[nimu] Upserted ${routeToId.size} animes (${withId.length} adopted/updated, ${withoutId.length} new)`);

  // ── Episodes: route → anime_id, dedupe on the conflict key, batch upsert ──
  // Two payload shapes so the upsert never clobbers a canonical's TVDB-set
  // season_number: pass-through rows carry NO season_number column (as before);
  // aliased rows re-aimed at the canonical carry the season only when the alias
  // knows it. Rows are split into uniform batches accordingly.
  const normalEpisodeRows = []; // { anime_id, episode_number, airing_at, streaming_links, delayed_from }
  const seasonEpisodeRows = []; // + season_number (aliased cours with a known season)
  for (const proto of episodeProtos) {
    const alias = aliasByRoute.get(proto.route);
    if (alias) {
      const row = aliasEpisodeRow(proto, alias);
      if (row.season_number == null) {
        const { season_number, ...rest } = row; // omit ⇒ don't touch existing season_number
        normalEpisodeRows.push(rest);
      } else {
        seasonEpisodeRows.push(row);
      }
    } else {
      const anime_id = routeToId.get(proto.route);
      if (!anime_id) continue;
      const { route, ...rest } = proto;
      normalEpisodeRows.push({ anime_id, ...rest });
    }
  }

  const upsertedEpisodeRows = [];
  for (const [rows, onConflict] of [
    [dedupeEpisodes(normalEpisodeRows), 'anime_id,episode_number'],
    [dedupeEpisodes(seasonEpisodeRows), 'anime_id,episode_number'],
  ]) {
    for (const batch of chunk(rows, EPISODE_UPSERT_CHUNK)) {
      const { data, error } = await supabase
        .from('episodes')
        .upsert(batch, { onConflict })
        .select('id, airing_at');
      if (error) throw error;
      upsertedEpisodeRows.push(...(data ?? []));
    }
  }
  console.log(`[nimu] Upserted ${upsertedEpisodeRows.length} episodes`);

  // ── Episódios futuros que a fonte deixou de anunciar ──────────────────────
  // Ver `staleFutureEpisodeIds`. Passam a "sem data" (não se apagam: podem estar
  // marcados como vistos, e a próxima corrida volta a datá-los quando a fonte os
  // anunciar). Não fatal: é arrumação, e o calendário acima já está gravado.
  // Só com as linhas das semanas lidas "a sério" (até ao fim da +2): a semana
  // extra acrescenta, nunca faz apagar (`staleCleanupRows` em util.js).
  try {
    await clearStaleFutureEpisodes(
      supabase,
      staleCleanupRows([...normalEpisodeRows, ...seasonEpisodeRows], sources.staleWindowEnd),
      { timetableComplete: sources.timetableComplete === true },
    );
  } catch (err) {
    console.warn(`[nimu] ⚠ reconciliação de episódios futuros falhou (non-fatal): ${err.message}`);
  }

  // ── Outros nomes (romaji, inglês, sinónimos) → animes.alt_titles ──────────
  // É o que faz a pesquisa encontrar a série pelo nome que a pessoa conhece. Um
  // membro de franquia dobrado dá os nomes ao canónico ("Frieren Season 2"
  // encontra o Frieren). Não fatal: é pesquisa, não o calendário.
  try {
    await mergeAltTitles(supabase, namesByRoute, routeToId, aliasByRoute);
  } catch (err) {
    console.warn(`[nimu] ⚠ nomes alternativos falharam (non-fatal): ${err.message}`);
  }

  // ── A frase da fonte sobre o horário → animes.schedule_note ──────────────
  // "Episodes 1181 and further will continue in April 2027." É o que deixa a
  // ficha dizer quando a série volta, em vez de só "sem data". Não fatal.
  try {
    await mergeScheduleNotes(supabase, sources.detailsByRoute, routeToId, aliasByRoute);
  } catch (err) {
    console.warn(`[nimu] ⚠ notas de horário falharam (non-fatal): ${err.message}`);
  }

  // ── O estado de cada ficha, pelo que os episódios dizem ──────────────────
  // Depois da arrumação dos episódios futuros, que tira as datas às projeções
  // antigas: é com elas já fora que uma série em pausa deixa de parecer "no
  // ar". Vê TODAS as fichas no ar ou em pausa (poucas centenas), não só as do
  // horário: é o que termina uma temporada dobrada numa franquia, que já não
  // tem rota no horário (Slime, Mushoku Tensei, 2026-11-04). Ver
  // status-reconcile.js.
  // Depois das notas de horário também: uma nota nova desta corrida ("volta
  // em abril") tem de contar já, para a série ficar em pausa e não terminada.
  // Não fatal: o calendário já está gravado.
  // As mudanças de estado desta corrida vão também para o passo dos episódios
  // em falta, lá em baixo: uma série que acabou de terminar fica com os 1..N.
  let statusChanges = [];
  try {
    statusChanges = (await reconcileStatuses(supabase)) ?? [];
  } catch (err) {
    console.warn(`[nimu] ⚠ estado das fichas falhou (non-fatal): ${err.message}`);
  }

  // ── Notifications: fan out in-app alerts for genuinely NEW (recently aired)
  //    episodes of FAVOURITED titles. This is the ONLY place fan-out is
  //    triggered — the TVDB historical backfill (catalogue-episodes.js) and the
  //    manami catalogue import (catalogue.js) never call it, so their thousands
  //    of historical rows never notify anyone (no `episodes` INSERT trigger
  //    exists that would). See migration 20260731000400.
  await fanOutNewEpisodes(supabase, upsertedEpisodeRows);

  // ── Episódios em falta (depois da distribuição de avisos, de propósito) ──
  // Uma temporada que acabou fica com os episódios 1..N (com a data que as
  // fontes tiverem, ou sem data e com a marca de "já saiu"), e uma ficha nova
  // já terminada não chega sem episódios. Estes episódios são antigos: não
  // entram na distribuição acima. Não fatal. Ver episodes-backfill.js.
  try {
    await backfillRecent(supabase, {
      animeIds: [...routeToId.values()],
      timetableEntries: sources.timetableEntries,
      details: [...(sources.detailsByRoute?.values() ?? [])],
      totals: sources.manamiEpisodeTotals ?? new Map(),
      hints: sources.manamiEpisodeHints ?? new Map(),
      changedIds: statusChanges.map((c) => c.id),
    });
  } catch (err) {
    console.warn(`[nimu] ⚠ episódios em falta (non-fatal): ${err.message}`);
  }

  console.log(`[nimu] ✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

/**
 * Avisa (sem escrever nada) quando um título barrado como 18+ nesta corrida já
 * existe na base, pela rota da AnimeSchedule ou pelo `mal_id`.
 */
async function warnStoredAdult(supabase, adultRejected) {
  if (!adultRejected?.length) return;
  const routes = adultRejected.map((a) => a.route).filter(Boolean);
  const malIds = adultRejected.map((a) => a.mal).filter((v) => v != null);
  const found = new Map();
  for (const routeChunk of chunk(routes, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, slug, title')
      .in('animeschedule_route', routeChunk);
    if (error) throw error;
    for (const r of data ?? []) found.set(r.id, r);
  }
  for (const malChunk of chunk(malIds, IN_LIST_CHUNK)) {
    const { data, error } = await supabase.from('animes').select('id, slug, title').in('mal_id', malChunk);
    if (error) throw error;
    for (const r of data ?? []) found.set(r.id, r);
  }
  if (found.size === 0) return;
  const lista = [...found.values()].map((r) => r.slug ?? r.id).join(', ');
  console.log(
    `::warning::${found.size} título(s) 18+ ainda guardado(s): ${lista}. ` +
      'Correr o workflow "Seguranca" → purge-adult-simulacao e depois purge-adult.',
  );
}

/**
 * Junta os nomes do AnimeSchedule a `animes.alt_titles` pela RPC
 * `merge_anime_alt_titles`, que só acrescenta (os sinónimos que o manami lá pôs
 * ficam). Antes da migração 20260928000000 a RPC não existe: diz-se uma vez e
 * segue-se.
 */
async function mergeAltTitles(supabase, namesByRoute, routeToId, aliasByRoute) {
  const byId = new Map();
  for (const [route, names] of namesByRoute) {
    const id = routeToId.get(route) ?? aliasByRoute.get(route)?.anime_id;
    if (!id || names.length === 0) continue;
    byId.set(id, [...(byId.get(id) ?? []), ...names]);
  }
  if (byId.size === 0) return;
  let changed = 0;
  for (const batch of chunk([...byId].map(([id, names]) => ({ id, names })), 500)) {
    const { data, error } = await supabase.rpc('merge_anime_alt_titles', { payload: batch });
    if (error) {
      // 42883/PGRST202: a função ainda não existe (migração por aplicar).
      if (error.code === 'PGRST202' || error.code === '42883') {
        console.log('[nimu] nomes alternativos: falta a migração 20260928000000_titulos_alternativos.sql');
        return;
      }
      throw error;
    }
    changed += Number(data) || 0;
  }
  console.log(`[nimu] Nomes alternativos: ${changed} animes com nomes novos`);
}

/**
 * Grava a frase da AnimeSchedule sobre o horário (`scheduleNoteOf`) em
 * `animes.schedule_note`, só onde mudou (`scheduleNoteChanges`). Antes da
 * migração 20261002000000 a coluna não existe: diz-se uma vez e segue-se.
 * A pergunta é um GET e não um HEAD: sem corpo, o 42703 não vem no erro.
 */
async function mergeScheduleNotes(supabase, detailsByRoute, routeToId, aliasByRoute) {
  const probe = await supabase.from('animes').select('schedule_note').limit(1);
  if (probe.error) {
    if (probe.error.code === '42703') {
      console.log('[nimu] notas de horário: falta a migração 20261002000000_nota_de_horario.sql');
      return;
    }
    throw probe.error;
  }
  const pairs = [];
  for (const [route, detail] of detailsByRoute ?? []) {
    const id = routeToId.get(route) ?? aliasByRoute.get(route)?.anime_id;
    if (id) pairs.push({ id, note: scheduleNoteOf(detail) });
  }
  const ids = [...new Set(pairs.map((p) => p.id))];
  const current = new Map();
  for (const batch of chunk(ids, IN_LIST_CHUNK)) {
    const { data, error } = await supabase.from('animes').select('id, schedule_note').in('id', batch);
    if (error) throw error;
    for (const r of data ?? []) current.set(r.id, r.schedule_note ?? null);
  }
  const changes = scheduleNoteChanges(pairs, current);
  for (const { id, note } of changes) {
    const { error } = await supabase.from('animes').update({ schedule_note: note }).eq('id', id);
    if (error) throw error;
  }
  console.log(
    `[nimu] Notas de horário: ${changes.length} mudaram` +
      ` (${pairs.filter((p) => p.note !== null).length} séries com nota)`,
  );
}

/**
 * Ver `staleFutureEpisodeIds` em util.js e a chamada em `main`.
 *
 * Além das séries que estão no horário, entram as que a AnimeSchedule segue
 * (têm `animeschedule_route`) e que o horário, lido por inteiro, já não traz:
 * acabaram ou entraram em pausa, e as datas futuras que lhes ficaram são
 * projeções antigas. Sem rota, a série vem só do TVDB ou do catálogo, e o
 * silêncio da AnimeSchedule não diz nada sobre ela.
 */
async function clearStaleFutureEpisodes(supabase, timetableRows, { timetableComplete = false } = {}) {
  const timetableKeys = new Set(
    timetableRows
      .filter((r) => r.anime_id && r.episode_number != null)
      .map((r) => `${r.anime_id}#${r.episode_number}`),
  );
  const datas = timetableRows.map((r) => r.airing_at).filter(Boolean).sort();
  if (timetableKeys.size === 0 || datas.length === 0) return;
  const now = new Date().toISOString();
  // A data mais tardia do horário que chega aqui. O `main` só passa as linhas
  // das semanas lidas "a sério" (`staleCleanupRows`), por isso isto nunca passa
  // do fim da semana +2, como antes da semana extra.
  const windowEnd = datas[datas.length - 1];
  const animeIds = [...new Set(timetableRows.map((r) => r.anime_id).filter(Boolean))];

  const dbRows = [];
  for (const ids of chunk(animeIds, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('episodes')
      .select('id, anime_id, episode_number, airing_at, delayed_from')
      .in('anime_id', ids)
      .gt('airing_at', now)
      .lte('airing_at', windowEnd);
    if (error) throw error;
    dbRows.push(...(data ?? []));
  }

  const absentAnimeIds = new Set();
  if (timetableComplete) {
    const noHorario = new Set(animeIds);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('episodes')
        .select('id, anime_id, episode_number, airing_at, delayed_from, animes!inner(animeschedule_route)')
        .not('animes.animeschedule_route', 'is', null)
        .gt('airing_at', now)
        .lte('airing_at', windowEnd)
        .order('id')
        .range(from, from + 999);
      if (error) throw error;
      for (const { animes: _a, ...r } of data ?? []) {
        if (noHorario.has(r.anime_id)) continue;
        absentAnimeIds.add(r.anime_id);
        dbRows.push(r);
      }
      if (!data || data.length < 1000) break;
    }
  } else {
    console.log('[nimu] horário incompleto: as séries ausentes ficam como estão');
  }

  const stale = staleFutureEpisodeIds({ dbRows, timetableKeys, now, windowEnd, absentAnimeIds });
  for (const ids of chunk(stale, IN_LIST_CHUNK)) {
    const { error } = await supabase.from('episodes').update({ airing_at: null }).in('id', ids);
    if (error) throw error;
  }
  console.log(
    `[nimu] ${stale.length} episódio(s) futuro(s) que a fonte deixou de anunciar passaram a sem data` +
      ` (${absentAnimeIds.size} série(s) fora do horário)`,
  );
}

/**
 * Hand the recently-aired episode ids to the DB fan-out function, which creates
 * the notification events + per-favouriter in-app deliveries (idempotently, and
 * gated to a hard recency window so historical rows never blast). NON-FATAL: the
 * calendar refresh is the primary job, so a notification hiccup only warns — it
 * never fails ingestion.
 */
async function fanOutNewEpisodes(supabase, episodeRows) {
  const episodeIds = airedEpisodeIds(episodeRows);
  if (episodeIds.length === 0) {
    console.log('[nimu] fan-out: no newly-aired episodes this run — nothing to notify');
    return;
  }
  try {
    // A JANELA VAI EXPLICITA, e nao a de omissao.
    //
    // Sem ela usava-se o valor por omissao, que eram OITO DIAS. A 2026-08-22
    // isso produziu 98 avisos num minuto, para episodios espalhados por toda a
    // semana anterior. Oito dias fazem sentido para nao PERDER eventos depois
    // de o servico estar em baixo; nao fazem sentido nenhum para AVISAR alguem.
    //
    // A funcao tambem passou a ter um teto duro de 6 horas (migracao
    // 20260822000000), portanto isto agora e cinto e suspensorios. Fica
    // explicito na mesma: quem ler este ficheiro tem de ver a janela sem ter de
    // ir procurar a omissao noutro sitio.
    const { data, error } = await supabase.rpc('fan_out_episode_airing', {
      p_episode_ids: episodeIds,
      p_recent_window: '06:00:00',
    });
    if (error) throw error;
    const summary = data ?? {};
    console.log(
      `[nimu] fan-out: ${episodeIds.length} aired episode id(s) → ` +
        `${summary.events_upserted ?? 0} event(s), ` +
        `${summary.deliveries_created ?? 0} in-app delivery(ies)`,
    );
  } catch (err) {
    console.warn(`[nimu] ⚠ notification fan-out failed (non-fatal): ${err.message}`);
  }
}

main().catch((error) => {
  console.error('[nimu] ❌ Ingestion failed:', error);
  process.exitCode = 1;
});
