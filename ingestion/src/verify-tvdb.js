// =============================================================================
// Nimu — confirmar que cada id do TVDB guardado aponta para uma ANIMAÇÃO
// =============================================================================
// PORQUE EXISTE
//
//   Até 2026-09-22 a pesquisa do TVDB (`searchSeries` em tvdb.js) ficava com o
//   primeiro resultado, fosse ele o que fosse. O caso que o denunciou: o
//   "Hell Mode" da página inicial com o fundo de uma série chinesa de imagem
//   real. A pesquisa já foi corrigida (`pickMatchingHit`), mas o que ela gravou
//   antes continua na base:
//
//     - `external_ids.tvdb`, de onde saem episódios, sinopse e capa de recurso;
//     - `banner_image_url`, o fundo do billboard.
//
//   Este script pergunta ao TVDB os géneros de cada série referida e aponta as
//   que não são animação.
//
// RUN
//   node src/verify-tvdb.js            → só relata, não escreve nada
//   node src/verify-tvdb.js --apply     → limpa os banners suspeitos
//   node src/verify-tvdb.js --apply-ids → isso, e tira também os ids suspeitos
//
// O QUE O --apply FAZ, E O QUE NÃO FAZ
//
//   - Limpa o banner das linhas cujo id do TVDB aponta para uma série sem
//     género de animação.
//   - Limpa TODOS os banners de linhas sem `external_ids.tvdb`. Esses vieram
//     sempre de uma pesquisa por nome, e muitos têm URLs em que não se lê o id
//     da série (`fanart/original/<hash>.jpg`), portanto não há como confirmar.
//     Depois disto, `npm run banners` volta a enchê-los, já com o filtro.
//   - NÃO mexe no `external_ids.tvdb` sem `--apply-ids`. Medido na primeira
//     corrida (2026-09-22): os géneros do TVDB são incompletos. "Link Click",
//     "Candy Caries" e "Soul Land 2" são animação e o TVDB não lhes dá o
//     género, portanto "sem género de animação" não chega para condenar um id.
//     Um banner errado é cosmético e volta a encher-se; um id apagado leva a
//     ficha a perder a fonte de episódios. Os ids ficam no relatório, com o
//     nome da série do TVDB ao lado, para quem decide olhar para eles.
//   - NÃO apaga episódios nem sinopses. Não há na base marca de que vieram do
//     TVDB, e apagar à cega podia levar dados bons. As linhas afetadas são
//     listadas para revisão à mão.
//
// SEGURANÇA
//   Cliente de serviço (escreve no catálogo). Corre só aqui, nunca na app.
// =============================================================================

import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { fetchJson } from './http.js';

const APPLY_IDS = process.argv.includes('--apply-ids');
const APPLY = APPLY_IDS || process.argv.includes('--apply');
const BASE = 'https://api4.thetvdb.com/v4';
const PAGE = 1000;

/** Os géneros e o nome de uma série no TVDB, ou `null` se não se conseguiu ler. */
async function seriesGenres(tvdbId, { login, limiter }) {
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
    return {
      genres: genres.map((g) => g?.name).filter((n) => typeof n === 'string'),
      name: typeof json?.data?.name === 'string' ? json.data.name : '?',
    };
  } catch {
    return null;
  }
}

/** Exportada para os testes. */
export function isAnimationGenres(genres) {
  return Array.isArray(genres) && genres.some((g) => /anim/i.test(g));
}

/** O id da série num URL de arte do TVDB, quando o URL o traz. */
export function seriesIdFromArtworkUrl(url) {
  if (typeof url !== 'string') return null;
  const v4 = /\/series\/(\d+)\//.exec(url);
  if (v4) return Number(v4[1]);
  const legacy = /\/fanart\/original\/(\d+)-\d+\./.exec(url);
  if (legacy) return Number(legacy[1]);
  return null;
}

async function loadRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    // `.range()` e não `.limit()`: a PostgREST desta instância corta tudo às
    // 1000 linhas em silêncio.
    const { data, error } = await supabase
      .from('animes')
      .select('id, title, status, external_ids, banner_image_url')
      .or('external_ids->>tvdb.not.is.null,banner_image_url.not.is.null')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leitura falhou: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

async function main() {
  if (!config.tvdbApiKey) {
    console.error('[nimu:verify-tvdb] falta TVDB_API_KEY.');
    process.exitCode = 1;
    return;
  }
  const { supabase } = await import('./supabase.js');
  const { login, limiter } = await import('./tvdb.js');

  const rows = await loadRows(supabase);
  console.log(`[nimu:verify-tvdb] ${rows.length} linha(s) com id do TVDB ou banner`);

  // Cada série só se pergunta uma vez, mesmo que várias linhas a partilhem.
  const ids = new Set();
  for (const r of rows) {
    const own = r.external_ids?.tvdb;
    if (own != null) ids.add(Number(own));
    const fromBanner = seriesIdFromArtworkUrl(r.banner_image_url);
    if (fromBanner !== null) ids.add(fromBanner);
  }

  const verdict = new Map();
  const info = new Map();
  let n = 0;
  for (const id of ids) {
    const lido = await seriesGenres(id, { login, limiter });
    if (lido !== null) info.set(id, lido);
    verdict.set(id, lido === null ? 'unknown' : isAnimationGenres(lido.genres) ? 'ok' : 'bad');
    n += 1;
    if (n % 50 === 0) console.log(`  ${n}/${ids.size} séries confirmadas`);
  }

  const badIdRows = rows.filter((r) => {
    const own = r.external_ids?.tvdb;
    return own != null && verdict.get(Number(own)) === 'bad';
  });
  const searchBanners = rows.filter(
    (r) => r.external_ids?.tvdb == null && r.banner_image_url !== null,
  );

  console.log(`\n[nimu:verify-tvdb] séries: ${[...verdict.values()].filter((v) => v === 'ok').length} animação, ` +
    `${[...verdict.values()].filter((v) => v === 'bad').length} NÃO animação, ` +
    `${[...verdict.values()].filter((v) => v === 'unknown').length} por confirmar`);

  console.log(`\nFichas com id do TVDB de uma série que não é animação (${badIdRows.length}):`);
  for (const r of badIdRows) {
    const i = info.get(Number(r.external_ids.tvdb));
    console.log(
      `  ${r.title}  ->  TVDB ${r.external_ids.tvdb} "${i?.name ?? '?'}" [${(i?.genres ?? []).join(', ')}]  (anime ${r.id})`,
    );
  }
  console.log('  -> confirmar à mão: os géneros do TVDB falham em animação verdadeira. Se o nome');
  console.log('     for de outra coisa, os EPISÓDIOS e a SINOPSE desta ficha vieram da série errada.');

  console.log(`\nBanners vindos de pesquisa por nome (${searchBanners.length}):`);
  for (const r of searchBanners) {
    const sid = seriesIdFromArtworkUrl(r.banner_image_url);
    const tag = sid === null ? 'sem id no URL' : verdict.get(sid);
    console.log(`  [${tag}] ${r.title}`);
  }

  if (!APPLY) {
    console.log('\nSimulação: nada foi escrito. Corre com --apply para limpar, e depois `npm run banners`.');
    return;
  }

  let fixedIds = 0;
  for (const r of badIdRows) {
    const patch = { banner_image_url: null };
    if (APPLY_IDS) {
      const { tvdb: _removed, ...rest } = r.external_ids;
      patch.external_ids = rest;
    } else if (r.banner_image_url === null) {
      continue;
    }
    const { error } = await supabase.from('animes').update(patch).eq('id', r.id);
    if (error) console.warn(`  aviso: ${r.title}: ${error.message}`);
    else fixedIds += 1;
  }

  let clearedBanners = 0;
  for (const r of searchBanners) {
    const { error } = await supabase
      .from('animes')
      .update({ banner_image_url: null })
      .eq('id', r.id)
      // Só se ainda for o mesmo URL: uma arte trocada à mão entretanto fica.
      .eq('banner_image_url', r.banner_image_url);
    if (error) console.warn(`  aviso: ${r.title}: ${error.message}`);
    else clearedBanners += 1;
  }

  console.log(`\n[nimu:verify-tvdb] ✅ ${APPLY_IDS ? 'ids retirados' : 'banners de ids suspeitos limpos'}: ${fixedIds}, banners de pesquisa limpos: ${clearedBanners}`);
  console.log('  Próximo passo: npm run banners');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:verify-tvdb] falhou:', err.message);
    process.exitCode = 1;
  });
}
