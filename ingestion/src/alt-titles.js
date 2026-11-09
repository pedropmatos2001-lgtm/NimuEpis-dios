// Enche `animes.alt_titles` com os sinónimos do manami, para a pesquisa
// encontrar cada anime pelos outros nomes (inglês, romaji, traduções latinas).
//
//   node src/alt-titles.js             → lê o manami e a base, escreve só o que é novo
//   node src/alt-titles.js --dry-run   → a mesma conta, sem escrever nada
//   node src/alt-titles.js --limit=N   → no máximo N animes a atualizar
//
// Cobre as 28 mil linhas do catálogo (e as do AnimeSchedule que tenham mal_id).
// Os nomes do próprio AnimeSchedule entram pela ingestão normal (run.js).
//
// Nada parte antes da migração 20260928000000_titulos_alternativos.sql: sem a
// coluna, o script diz o que falta e sai sem erro, para não pintar de vermelho
// a ingestão de 6 em 6 horas.
import { pathToFileURL } from 'node:url';

import { manamiNames, newNamesFor } from './names.js';
import { chunk } from './util.js';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseLimit(process.argv);
const PAGE = 1000; // linhas por leitura (o teto por defeito do PostgREST)
const RPC_CHUNK = 500; // animes por chamada à merge_anime_alt_titles

function parseLimit(argv) {
  const arg = argv.find((a) => a.startsWith('--limit='));
  if (!arg) return null;
  const n = Number(arg.slice('--limit='.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** mal_id → nomes do manami (título principal + sinónimos). */
export function manamiNamesByMal(entries) {
  const byMal = new Map();
  for (const entry of entries ?? []) {
    for (const source of entry?.sources ?? []) {
      const m = typeof source === 'string' ? source.match(/myanimelist\.net\/anime\/(\d+)/i) : null;
      if (!m) continue;
      const mal = Number(m[1]);
      // Duas entradas com o mesmo mal_id (raro): juntam-se os nomes.
      byMal.set(mal, [...(byMal.get(mal) ?? []), ...manamiNames(entry)]);
    }
  }
  return byMal;
}

/** O que escrever: `[{ id, names }]` só para as linhas com nomes novos. */
export function planUpdates(rows, namesByMal) {
  const updates = [];
  for (const row of rows ?? []) {
    const candidates = row?.mal_id != null ? namesByMal.get(Number(row.mal_id)) : null;
    if (!candidates) continue;
    const names = newNamesFor(row, candidates);
    if (names.length > 0) updates.push({ id: row.id, names });
  }
  return updates;
}

/**
 * `true`/`false` se a coluna existe; lança noutros erros (rede, chave).
 *
 * GET e não HEAD: um HEAD não tem corpo, e sem corpo o erro chega sem o código
 * 42703 (medido a 2026-09-28: `{"message":""}`), indistinguível de uma falha.
 */
export async function hasAltTitlesColumn(supabase) {
  const { error } = await supabase.from('animes').select('alt_titles').limit(1);
  if (!error) return true;
  if (error.code === '42703') return false;
  throw error;
}

async function readAllRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, title, alt_titles')
      .not('mal_id', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function main() {
  const startedAt = Date.now();
  // O config.js carrega o .env local; só depois dele se sabe o que falta. Só os
  // NOMES das variáveis vão para a mensagem, nunca os valores.
  await import('./config.js');
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Faltam variáveis: ${missing.join(', ')} (ver ingestion/.env.example).`);
  }
  const { supabase } = await import('./supabase.js');

  if (!(await hasAltTitlesColumn(supabase))) {
    console.log(
      '[nimu:alt-titles] a coluna animes.alt_titles ainda não existe. ' +
        'Aplica supabase/migrations/20260928000000_titulos_alternativos.sql e volta a correr. Nada escrito.',
    );
    return;
  }

  const { loadManamiDatabase } = await import('./manami.js');
  const namesByMal = manamiNamesByMal(await loadManamiDatabase());
  console.log(`[nimu:alt-titles] manami: nomes para ${namesByMal.size} mal_ids`);

  const rows = await readAllRows(supabase);
  let updates = planUpdates(rows, namesByMal);
  const totalNames = updates.reduce((n, u) => n + u.names.length, 0);
  console.log(
    `[nimu:alt-titles] ${rows.length} animes com mal_id lidos; ${updates.length} com nomes novos (${totalNames} nomes)`,
  );
  if (LIMIT && updates.length > LIMIT) {
    updates = updates.slice(0, LIMIT);
    console.log(`[nimu:alt-titles] --limit=${LIMIT}: só os primeiros ${updates.length}`);
  }

  if (DRY_RUN) {
    for (const sample of updates.slice(0, 5)) {
      const row = rows.find((r) => r.id === sample.id);
      console.log(`[nimu:alt-titles] ex.: "${row?.title}" + ${JSON.stringify(sample.names)}`);
    }
    console.log('[nimu:alt-titles] DRY RUN: nada escrito');
    return;
  }

  let changed = 0;
  for (const batch of chunk(updates, RPC_CHUNK)) {
    const { data, error } = await supabase.rpc('merge_anime_alt_titles', { payload: batch });
    if (error) throw error;
    changed += Number(data) || 0;
  }
  console.log(
    `[nimu:alt-titles] ✅ ${changed} animes atualizados em ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:alt-titles] ❌ falhou:', error?.message ?? error);
    process.exitCode = 1;
  });
}
