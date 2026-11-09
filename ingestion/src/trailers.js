// =============================================================================
// Nimu — o trailer de cada série no ar ou por estrear, a partir do TVDB
// =============================================================================
// PORQUE EXISTE
//
//   A ficha procurava o trailer só no Kitsu, que não tem os das séries novas.
//   O dono deu o exemplo: "The Frontier Lord Begins with Zero Subjects" tem o
//   trailer da Crunchyroll no YouTube (nuSfm9NlJyo) e a ficha dizia que não
//   havia. Medido com a sonda a 2026-09-22: o TVDB tem esse trailer, marcado
//   como inglês, e tem trailers para as outras séries da temporada testadas.
//
// O QUE FAZ
//
//   Para as fichas com id do TVDB e sem trailer guardado (as mais populares
//   primeiro),
//   lê os trailers da ficha do TVDB, escolhe (`escolherTrailers`), confirma no
//   oEmbed do YouTube que o vídeo existe e é público, e guarda o id em
//   `external_ids.youtube_trailer`. Sem migração: o `external_ids` já é jsonb.
//   Quem não tem trailer fica marcado com a data da verificação e só volta a
//   ser visto passada uma semana, para não gastar o TVDB em cada corrida.
//
// RUN
//   node src/trailers.js [--limit=150] [--dry-run]
// =============================================================================

import { pathToFileURL } from 'node:url';

import { formasDeBusca } from './banners.js';
import { config } from './config.js';
import { fetchJson } from './http.js';

const BASE = 'https://api4.thetvdb.com/v4';
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8)) || 150;
const RECHECK_MS = 7 * 86400000;
const PAGE = 1000;
/** Quantas fichas sem id do TVDB se tentam resolver por corrida. */
const RESOLVE_LIMIT = 120;

/** O id de um vídeo do YouTube num URL, ou `null`. */
export function youtubeId(url) {
  if (typeof url !== 'string') return null;
  const m =
    /[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(url) ??
    /youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&#]|$)/.exec(url) ??
    /youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})(?:[?&#/]|$)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Os candidatos, pela ordem em que se tentam.
 *
 * Primeiro os INGLESES (é o trailer da Crunchyroll, legendado, o que o dono
 * mostrou), depois os outros; dentro de cada grupo, do último para o primeiro,
 * porque o TVDB acrescenta por ordem e o último é o mais recente (numa ficha de
 * franquia, o da temporada que está a dar agora). Sem repetidos.
 */
export function escolherTrailers(trailers) {
  const lista = (Array.isArray(trailers) ? trailers : [])
    .map((t) => ({ id: youtubeId(t?.url), lang: String(t?.language ?? '').toLowerCase() }))
    .filter((t) => t.id !== null);
  const ordem = [
    ...lista.filter((t) => t.lang === 'eng').reverse(),
    ...lista.filter((t) => t.lang !== 'eng').reverse(),
  ];
  return [...new Set(ordem.map((t) => t.id))];
}

/** O vídeo existe e é público? O oEmbed responde 401/403/404 aos que não. */
async function videoPublico(id) {
  const alvo = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${alvo}&format=json`, {
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fichas no ar ou por estrear SEM id do TVDB: resolve-o e guarda-o.
 *
 * Medido a 2026-09-22: 233 séries no ar e 513 por estrear sem id. Sem ele não
 * há trailer, nem banner, nem episódios do TVDB. A ingestão só tentava o título
 * completo; aqui tentam-se as formas do `banners.js` (sem sufixo de temporada,
 * sem subtítulo), com o critério de `pickMatchingHit` (título exato e país de
 * animação), que é o que torna seguro GRAVAR o id. As no ar primeiro. Quem não
 * resolve fica marcado e só volta a ser tentado passada uma semana.
 */
async function resolverIdsEmFalta(supabase, searchSeries) {
  const linhas = [];
  for (const status of ['airing', 'upcoming']) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, title, year, external_ids')
      .eq('status', status)
      .is('external_ids->>tvdb', null)
      .order('popularity', { ascending: false, nullsFirst: false })
      .limit(1000);
    if (error) throw new Error(`leitura (sem tvdb) falhou: ${error.message}`);
    linhas.push(...(data ?? []));
  }
  const agora = Date.now();
  const porTentar = linhas
    .filter((r) => {
      const visto = Date.parse(r.external_ids?.tvdb_search_checked_at ?? '');
      return r.title && (!Number.isFinite(visto) || agora - visto > RECHECK_MS);
    })
    .slice(0, RESOLVE_LIMIT);

  let resolvidos = 0;
  for (const row of porTentar) {
    let tvdbId = null;
    for (const termo of formasDeBusca(row.title)) {
      try {
        const achado = await searchSeries(termo, termo === row.title ? (row.year ?? undefined) : undefined);
        if (achado?.tvdbId != null) {
          tvdbId = achado.tvdbId;
          break;
        }
      } catch {
        // Best-effort: passa-se à forma seguinte.
      }
    }
    const external_ids = {
      ...(row.external_ids ?? {}),
      tvdb_search_checked_at: new Date().toISOString(),
      ...(tvdbId !== null ? { tvdb: tvdbId } : {}),
    };
    if (tvdbId !== null) resolvidos += 1;
    if (DRY_RUN) continue;
    const { error } = await supabase.from('animes').update({ external_ids }).eq('id', row.id);
    if (error) console.warn(`  aviso: ${row.title.slice(0, 30)}: ${error.message}`);
  }
  console.log(`[nimu:trailers] ids do TVDB resolvidos: ${resolvidos} de ${porTentar.length} tentados`);
}

async function main() {
  if (!config.tvdbApiKey) {
    console.log('[nimu:trailers] sem TVDB_API_KEY, nada a fazer');
    return;
  }
  const { supabase } = await import('./supabase.js');
  const { login, limiter, searchSeries } = await import('./tvdb.js');

  await resolverIdsEmFalta(supabase, searchSeries);

  const rows = [];
  for (let from = 0; ; from += PAGE) {
    // `.range()`: a PostgREST desta instância corta às 1000 linhas em silêncio.
    const { data, error } = await supabase
      .from('animes')
      .select('id, title, external_ids')
      // Todas as fichas com id do TVDB, e não só as no ar: quem acabou de
      // terminar (o "Frontier Lord" acabou a 18/09) continua a ser visitado.
      // Por popularidade, e 150 por corrida, portanto as mais vistas primeiro.
      .not('external_ids->>tvdb', 'is', null)
      .is('external_ids->>youtube_trailer', null)
      .order('popularity', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leitura falhou: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  const agora = Date.now();
  const porVer = rows
    .filter((r) => {
      const visto = Date.parse(r.external_ids?.youtube_trailer_checked_at ?? '');
      return !Number.isFinite(visto) || agora - visto > RECHECK_MS;
    })
    .slice(0, LIMIT);
  console.log(`[nimu:trailers] ${porVer.length} série(s) a ver (${rows.length} sem trailer)`);

  const token = await login();
  let com = 0;
  let sem = 0;
  for (const row of porVer) {
    let candidatos = [];
    try {
      const json = await fetchJson(
        `${BASE}/series/${encodeURIComponent(row.external_ids.tvdb)}/extended?short=false`,
        { label: 'TVDB trailers', headers: { Authorization: `Bearer ${token}` }, limiter, retries: 2 },
      );
      candidatos = escolherTrailers(json?.data?.trailers);
    } catch {
      // Best-effort: fica para a próxima corrida.
      continue;
    }
    let escolhido = null;
    for (const id of candidatos) {
      if (await videoPublico(id)) {
        escolhido = id;
        break;
      }
    }
    if (escolhido) com += 1;
    else sem += 1;
    if (DRY_RUN) {
      if (escolhido) console.log(`  ${row.title.slice(0, 45)} -> ${escolhido}`);
      continue;
    }
    const external_ids = {
      ...row.external_ids,
      youtube_trailer_checked_at: new Date().toISOString(),
      ...(escolhido ? { youtube_trailer: escolhido } : {}),
    };
    const { error } = await supabase.from('animes').update({ external_ids }).eq('id', row.id);
    if (error) console.warn(`  aviso: ${row.title.slice(0, 30)}: ${error.message}`);
  }
  console.log(`[nimu:trailers] ✅ com trailer: ${com}, sem: ${sem}${DRY_RUN ? ' (simulação)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:trailers] falhou:', err.message);
    process.exitCode = 1;
  });
}
