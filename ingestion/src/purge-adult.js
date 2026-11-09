// =============================================================================
// Nimu — tirar do catálogo os títulos 18+ que já lá estão
// =============================================================================
// PORQUE EXISTE (2026-11-01)
//
//   Até esta data a ingestão semanal da AnimeSchedule não tinha filtro 18+, e
//   entraram OVAs hentai com fichas e episódios ("Kanojo Saimin", "Pure x
//   Holic", "NTR Kishi"…), que em agosto foram as páginas mais procuradas do
//   site no Google. O filtro passou a existir em todos os caminhos de inserção
//   (adult-content.js), mas não apaga o que já entrou. É isso que este script
//   faz, à mão e com simulação primeiro.
//
// COMO DECIDE (basta um sinal; ver adult-content.js)
//
//   1. Os géneros guardados na ficha ("Hentai", "Erotica"…) e a lista de
//      títulos confirmados à mão (`KNOWN_ADULT_TITLE_KEYS`).
//   2. O manami, pelos ids da ficha (`mal_id`, `external_ids.mal/anilist`).
//   3. A AnimeSchedule, pelos géneros do detalhe, para as fichas com rota —
//      só quando há ANIMESCHEDULE_TOKEN; sem ele este passo é saltado.
//   4. O manami pelo TÍTULO, para fichas sem id em comum com ele. Só ENTRA NO
//      RELATÓRIO ("por rever"), não se apaga: um título pode repetir-se numa
//      série legítima. Quem confirmar acrescenta-o à lista à mão, ou corre com
//      --apply-titulos.
//
// PORQUE APAGA, E NÃO ESCONDE
//
//   Não há na base marca de "escondido" que a app respeite: acrescentar uma
//   obrigava a mexer em todas as leituras (calendário, Descobrir, pesquisa,
//   sitemap, RPCs). Apagar a ficha dá 404 nas páginas (é o que tira o URL do
//   Google), e o filtro novo impede que volte a entrar.
//
//   O PREÇO: as FKs para `animes` são todas `on delete cascade`. Sai também:
//   episódios, `watched_episodes`, `watchlist` (incl. favoritos),
//   `notification_preferences`, `notification_events` → `notification_deliveries`
//   e `anime_route_aliases`. É o que se quer para títulos que não deviam estar
//   cá, mas NÃO SE DESFAZ. Por isso: simulação por omissão, o relatório mostra
//   quantas listas de utilizadores cada ficha leva consigo (só contagens,
//   nenhum id de utilizador), há um travão para lotes grandes, e --keep tira
//   do lote qualquer slug que se queira poupar.
//
// RUN
//   node src/purge-adult.js                       → só relata, não escreve
//   node src/purge-adult.js --apply               → apaga os de sinal forte (1–3)
//   node src/purge-adult.js --apply --apply-titulos → e também os "por rever"
//   --keep=slug-a,slug-b                          → nunca tocar nestes
//   --max=N                                       → travão (omissão: 200)
//
// SEGURANÇA
//   Cliente de serviço (escreve no catálogo). Corre só no Actions ou à mão.
// =============================================================================

import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { buildManamiIndex } from './manami.js';
import { chunk } from './util.js';
import {
  adultReason,
  buildManamiAdultTitleIndex,
  manamiAdultReasonByIds,
  manamiAdultReasonByTitle,
} from './adult-content.js';

const PAGE = 1000;
const IN_LIST_CHUNK = 150;
const DEFAULT_MAX = 200;

/** Os ids de uma ficha que o manami conhece (coluna + JSONB). */
function idsOf(row) {
  const ext = row.external_ids ?? {};
  return { mal: row.mal_id ?? ext.mal ?? null, anilist: ext.anilist ?? null };
}

/**
 * Decide o que sai. Pura, para se testar sem base.
 *
 * @param {Array} rows  fichas: { id, slug, title, alt_titles?, genres, external_ids, mal_id, animeschedule_route }
 * @param {object} ctx
 * @param {object} [ctx.manamiIndex]        buildManamiIndex()
 * @param {Map}    [ctx.manamiAdultTitles]  buildManamiAdultTitleIndex()
 * @param {Map}    [ctx.detailsByRoute]     rota → detalhe da AnimeSchedule
 * @param {Set}    [ctx.keep]               slugs a nunca tocar
 * @returns {{ remove: Array, review: Array, kept: Array }}
 */
export function planAdultPurge(rows, { manamiIndex = null, manamiAdultTitles = null, detailsByRoute = new Map(), keep = new Set() } = {}) {
  const remove = [];
  const review = [];
  const kept = [];
  for (const row of rows ?? []) {
    const titles = [row.title, ...(Array.isArray(row.alt_titles) ? row.alt_titles : [])];
    const ids = idsOf(row);
    const detail = row.animeschedule_route ? detailsByRoute.get(row.animeschedule_route) : null;

    const strong =
      adultReason({ genres: row.genres ?? [], titles }) ??
      manamiAdultReasonByIds(ids, manamiIndex) ??
      (detail ? adultReason({ genres: detail.genres ?? [] }) : null);

    let reason = strong;
    let bucket = remove;
    if (!reason) {
      const knownToManami =
        (ids.mal != null && manamiIndex?.byMal?.has(Number(ids.mal))) ||
        (ids.anilist != null && manamiIndex?.byAnilist?.has(Number(ids.anilist)));
      // Pelo título só o nome principal: os `alt_titles` incluem sinónimos e
      // abreviaturas, que colidem com facilidade.
      reason = knownToManami ? null : manamiAdultReasonByTitle([row.title], manamiAdultTitles);
      bucket = review;
    }
    if (!reason) continue;

    const item = {
      id: row.id,
      slug: row.slug ?? null,
      title: row.title,
      mal_id: ids.mal,
      route: row.animeschedule_route ?? null,
      reason,
    };
    if (row.slug && keep.has(row.slug)) kept.push(item);
    else bucket.push(item);
  }
  return { remove, review, kept };
}

/** Travão: um lote enorme quer dizer que o filtro está a ler mal, não que o
 *  catálogo esteja cheio de hentai. Nada se apaga e o job falha. */
export function assertPurgeIsSane(count, max) {
  if (count > max) {
    throw new Error(
      `${count} fichas marcadas para apagar (> ${max}) — nada foi apagado. ` +
        'Rever o relatório; se estiver certo, subir o travão com --max=N.',
    );
  }
}

/** `--nome=valor` → valor, ou `null`. */
function argValue(argv, name) {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

export function parseArgs(argv) {
  const max = Number(argValue(argv, 'max'));
  return {
    apply: argv.includes('--apply'),
    applyTitles: argv.includes('--apply-titulos'),
    keep: new Set(
      (argValue(argv, 'keep') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    max: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX,
  };
}

async function loadRows(supabase) {
  const rows = [];
  // `alt_titles` só existe depois da migração 20260928000000; sem ela lê-se o
  // resto e a verificação faz-se só pelo título principal.
  let columns = 'id, slug, title, alt_titles, genres, external_ids, mal_id, animeschedule_route';
  for (let from = 0; ; from += PAGE) {
    // `.range()` e não `.limit()`: a PostgREST desta instância corta tudo às
    // 1000 linhas em silêncio.
    const { data, error } = await supabase.from('animes').select(columns).order('id').range(from, from + PAGE - 1);
    if (error && columns.includes('alt_titles') && /alt_titles/.test(error.message ?? '')) {
      columns = 'id, slug, title, genres, external_ids, mal_id, animeschedule_route';
      from -= PAGE;
      continue;
    }
    if (error) throw new Error(`leitura falhou: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

/** Quantas entradas de `watchlist` cada ficha leva consigo. Só contagens. */
async function watchlistCounts(supabase, ids) {
  const counts = new Map();
  for (const idChunk of chunk(ids, IN_LIST_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('watchlist')
        .select('anime_id')
        .in('anime_id', idChunk)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`leitura da watchlist falhou: ${error.message}`);
      for (const r of data ?? []) counts.set(r.anime_id, (counts.get(r.anime_id) ?? 0) + 1);
      if ((data ?? []).length < PAGE) break;
    }
  }
  return counts;
}

/** Detalhe da AnimeSchedule para as fichas com rota (só com token). */
async function loadDetails(rows) {
  const details = new Map();
  if (!config.animescheduleToken) {
    console.log('[nimu:purge-adult] sem ANIMESCHEDULE_TOKEN: géneros da AnimeSchedule não consultados');
    return details;
  }
  const { fetchAnimeDetail } = await import('./animeschedule.js');
  const routes = [...new Set(rows.map((r) => r.animeschedule_route).filter(Boolean))];
  let failed = 0;
  for (const route of routes) {
    try {
      details.set(route, await fetchAnimeDetail(route));
    } catch {
      failed += 1; // uma rota que já não existe na fonte não condena nada
    }
  }
  console.log(`[nimu:purge-adult] AnimeSchedule: ${details.size} detalhe(s), ${failed} falha(s)`);
  return details;
}

function printList(label, items, counts) {
  console.log(`\n${label} (${items.length}):`);
  for (const i of items) {
    const n = counts?.get(i.id) ?? 0;
    console.log(
      `  ${i.slug ?? i.id}  "${i.title}"  mal=${i.mal_id ?? '-'}  → ${i.reason}  [${n} na lista de alguém]`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { supabase } = await import('./supabase.js');
  const { loadManamiDatabase } = await import('./manami.js');

  const entries = await loadManamiDatabase();
  const manamiIndex = buildManamiIndex(entries);
  const manamiAdultTitles = buildManamiAdultTitleIndex(entries);
  console.log(`[nimu:purge-adult] manami: ${entries.length} entradas`);

  const rows = await loadRows(supabase);
  console.log(`[nimu:purge-adult] ${rows.length} fichas no catálogo`);
  const detailsByRoute = await loadDetails(rows);

  const { remove, review, kept } = planAdultPurge(rows, {
    manamiIndex,
    manamiAdultTitles,
    detailsByRoute,
    keep: args.keep,
  });
  const targets = args.applyTitles ? [...remove, ...review] : remove;
  const counts = await watchlistCounts(
    supabase,
    [...remove, ...review].map((i) => i.id),
  );

  printList('A APAGAR — sinal forte', remove, counts);
  printList(`Por rever — só pelo título no manami${args.applyTitles ? ' (incluídos: --apply-titulos)' : ''}`, review, counts);
  if (kept.length) printList('Poupados por --keep', kept, counts);

  if (!args.apply) {
    console.log('\nSimulação: nada foi escrito. Corre com --apply para apagar a lista "A APAGAR".');
    return;
  }

  assertPurgeIsSane(targets.length, args.max);
  let deleted = 0;
  for (const idChunk of chunk(targets.map((t) => t.id), IN_LIST_CHUNK)) {
    const { data, error } = await supabase.from('animes').delete().in('id', idChunk).select('id');
    if (error) throw new Error(`apagar falhou: ${error.message}`);
    deleted += (data ?? []).length;
  }
  console.log(`\n[nimu:purge-adult] ✅ ${deleted} ficha(s) apagada(s) (episódios, listas e avisos em cascata)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:purge-adult] falhou:', err.message);
    process.exitCode = 1;
  });
}
