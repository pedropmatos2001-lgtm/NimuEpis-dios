// Refresca `animes.popularity` (quantas pessoas seguem cada série no
// AnimeSchedule) para as séries mais seguidas do catálogo inteiro.
//
//   node src/popularity.js              → lê as primeiras páginas e atualiza
//   node src/popularity.js --dry-run    → a mesma conta, sem escrever
//   node src/popularity.js --pages=N    → quantas páginas ler (defeito 80)
//
// ## Porque existe (2026-09-29)
//
// O Top 10 da home ordena por seguidores (web/lib/data/top.ts), e a coluna só
// estava preenchida para as séries que a ingestão normal toca: as da janela do
// calendário. No inverno de 2026, 6 de 239 séries tinham o valor; o Frieren 2
// não tinha. Um "Top do ano" assim deixava de fora os maiores êxitos do ano.
//
// `GET /anime?page=N` devolve o catálogo do AnimeSchedule das séries mais
// seguidas para as menos (medido: a página 1 abre com One Piece, Jujutsu
// Kaisen, Solo Leveling), com os `stats` completos. As primeiras 80 páginas são
// ~1 440 séries, até às que ainda têm ~500 seguidores: tudo o que pode entrar
// num top. São 80 pedidos ao ritmo do limitador partilhado, menos de um minuto.
//
// Escreve SÓ `popularity`, e só quando o valor mudou. A coluna é do pipeline do
// AnimeSchedule (ver catalogue.js), e a fonte é a mesma.
import { pathToFileURL } from 'node:url';

import { extractExternalIds } from './mappers.js';
import { chunk } from './util.js';

const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_PAGES = 80;
const PAGES = parsePages(process.argv);
const LOOKUP_CHUNK = 150; // ids por `.in()`, para o URL não crescer de mais
const WRITE_CONCURRENCY = 10;

function parsePages(argv) {
  const arg = argv.find((a) => a.startsWith('--pages='));
  const n = arg ? Number(arg.slice('--pages='.length)) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 1200 ? n : DEFAULT_PAGES;
}

/** De uma ficha do AnimeSchedule: a rota, o mal_id e os seguidores. */
export function readSourceEntry(entry) {
  const tracked = Number(entry?.stats?.trackedCount);
  if (!Number.isFinite(tracked) || tracked < 0) return null;
  const mal = extractExternalIds(entry?.websites).mal;
  const route = typeof entry?.route === 'string' && entry.route ? entry.route : null;
  if (route === null && mal == null) return null;
  return { route, mal: mal == null ? null : String(mal), popularity: Math.round(tracked) };
}

/**
 * `[{ id, popularity }]` para as linhas cujo valor mudou.
 *
 * Casa primeiro pela rota do AnimeSchedule (exata, é a mesma fonte) e só
 * depois pelo mal_id, que é o que as linhas vindas do manami têm.
 */
export function planPopularityUpdates(sources, rows) {
  const byRoute = new Map();
  const byMal = new Map();
  for (const s of sources) {
    if (!s) continue;
    if (s.route && !byRoute.has(s.route)) byRoute.set(s.route, s.popularity);
    if (s.mal && !byMal.has(s.mal)) byMal.set(s.mal, s.popularity);
  }
  const updates = [];
  for (const row of rows ?? []) {
    const novo =
      (row.animeschedule_route ? byRoute.get(row.animeschedule_route) : undefined) ??
      (row.mal_id != null ? byMal.get(String(row.mal_id)) : undefined);
    if (novo === undefined) continue;
    if (Number(row.popularity) === novo && row.popularity !== null) continue;
    updates.push({ id: row.id, popularity: novo });
  }
  return updates;
}

async function readMatchingRows(supabase, sources) {
  const routes = [...new Set(sources.map((s) => s.route).filter(Boolean))];
  const mals = [...new Set(sources.map((s) => s.mal).filter(Boolean))];
  const rows = new Map();
  const cols = 'id, mal_id, animeschedule_route, popularity';
  for (const lote of chunk(routes, LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from('animes').select(cols).in('animeschedule_route', lote);
    if (error) throw error;
    for (const row of data ?? []) rows.set(row.id, row);
  }
  for (const lote of chunk(mals, LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from('animes').select(cols).in('mal_id', lote);
    if (error) throw error;
    for (const row of data ?? []) rows.set(row.id, row);
  }
  return [...rows.values()];
}

async function main() {
  await import('./config.js');
  const { supabase } = await import('./supabase.js');
  const { fetchAnimeCataloguePage } = await import('./animeschedule.js');
  const startedAt = Date.now();

  const sources = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const { anime, totalAmount } = await fetchAnimeCataloguePage({ page });
    for (const entry of anime) {
      const s = readSourceEntry(entry);
      if (s) sources.push(s);
    }
    // A API responde 500 depois do fim: pára pela contagem, nunca pelo erro.
    if (anime.length === 0 || page * anime.length >= totalAmount) break;
  }

  const rows = await readMatchingRows(supabase, sources);
  const updates = planPopularityUpdates(sources, rows);
  console.log(
    `[nimu:popularity] ${sources.length} séries lidas, ${rows.length} na base, ${updates.length} com valor novo`,
  );
  if (DRY_RUN) {
    for (const u of updates.slice(0, 10)) console.log(`  ${u.id} -> ${u.popularity}`);
    console.log('[nimu:popularity] DRY RUN: nada escrito');
    return;
  }

  let escritas = 0;
  for (const lote of chunk(updates, WRITE_CONCURRENCY)) {
    const resultados = await Promise.all(
      lote.map((u) => supabase.from('animes').update({ popularity: u.popularity }).eq('id', u.id)),
    );
    for (const { error } of resultados) {
      if (error) throw error;
      escritas += 1;
    }
  }
  console.log(
    `[nimu:popularity] ✅ ${escritas} atualizadas em ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:popularity] ❌ falhou:', error?.message ?? error);
    process.exitCode = 1;
  });
}
