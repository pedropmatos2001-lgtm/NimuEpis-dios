// =============================================================================
// Nimu — arte de fundo para o billboard da página inicial
// =============================================================================
// O QUE ISTO É
//
//   Enche `animes.banner_image_url` com arte HORIZONTAL do TheTVDB, para os
//   títulos que o billboard da página inicial pode mostrar.
//
// PORQUE EXISTE
//
//   Os 56 banners que a base tinha apontavam TODOS para `s4.anilist.co`. Quando
//   `web/lib/prose.ts` passou a filtrar esse anfitrião por causa do risco B0
//   (os termos da AniList proíbem serviços concorrentes, e o Nimu é um), o
//   billboard ficou sem imagem nenhuma: só o gradiente da cor dominante. É a
//   primeira coisa que alguém vê ao chegar, e passou a ser uma mancha de cor.
//
//   O TVDB serve arte de fundo em `artworks.thetvdb.com`, que JÁ está na lista
//   de anfitriões permitidos do `web/next.config.ts`, porque as capas reparadas
//   já vêm de lá. Não é fonte nova nem licença nova.
//
// PORQUE SÓ OS DO TOPO
//
//   O billboard mostra três títulos, escolhidos por popularidade entre os que
//   estão a emitir. Buscar arte para as 28 784 linhas do catálogo seria dezenas
//   de milhares de chamadas para encher uma coluna que 28 700 delas nunca
//   mostram. O teto por omissão é 60, que cobre a rotação do billboard com
//   folga larga.
//
// RUN
//   npm run banners              → escreve
//   npm run banners -- --dry-run → diz o que faria, não escreve
//   npm run banners -- --limit=20
//
// SEGURANÇA
//   Usa o cliente de serviço (ignora RLS) porque escreve no catálogo. Corre só
//   aqui, nunca na app. Só toca em `banner_image_url`, e só quando está a nulo.
// =============================================================================

import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { safeImageUrl } from './image-hosts.js';

/**
 * Quantos títulos cobrir. Ver a nota "PORQUE SÓ OS DO TOPO" no cabeçalho.
 *
 * Declarado ANTES do `LIMIT` que o usa, e não depois: um `const` não é içado
 * como uma função, e a versão anterior rebentava com um ReferenceError em
 * qualquer corrida SEM `--limit=`. Só não rebentou de imediato porque o
 * caminho com `--limit=` devolve antes de lhe tocar, e foi assim que a
 * simulação passou e a corrida a sério não.
 */
const DEFAULT_LIMIT = 60;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseLimit(process.argv);

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEAD_TIMEOUT_MS = 12000;

export function parseLimit(argv) {
  const arg = (argv ?? []).find((a) => a.startsWith('--limit='));
  if (arg === undefined) return DEFAULT_LIMIT;
  const n = Number(arg.slice('--limit='.length));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

/**
 * O URL responde e é mesmo uma imagem?
 *
 * Escrever um URL sem o verificar é como não escrever nada: a coluna fica
 * preenchida, o billboard tenta desenhar, e o que se vê é o mesmo vazio de
 * antes mais um pedido falhado. O `content-type` é verificado porque o TVDB
 * responde 200 com uma página de erro em HTML quando a arte foi removida.
 */
async function isLiveImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': BROWSER_UA },
      signal: controller.signal,
      // Um redirecionamento podia levar o pedido para fora da lista de
      // anfitriões; aqui não se segue nenhum.
      redirect: 'manual',
    });
    if (!res.ok) return false;
    const tipo = res.headers.get('content-type') ?? '';
    return tipo.startsWith('image/');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O id do TVDB desta série, do que já temos ou por busca.
 *
 * A busca por título é o segundo caminho e não o primeiro: das quarenta séries
 * mais populares a emitir, dezanove já trazem `external_ids.tvdb` da ingestão, e
 * um id que já temos é sempre melhor do que um resultado de pesquisa.
 */
/**
 * O título sem o sufixo de temporada, ou `null` se não tiver nenhum.
 *
 * O TVDB trata uma franquia como UMA série com várias temporadas: o "Re:Zero"
 * dele tem quatro temporadas, e não há série nenhuma chamada "Re:Zero, Starting
 * Life in Another World 4". Os nossos títulos vêm da outra convenção, em que
 * cada temporada é um título próprio.
 *
 * Medido numa amostra dos oito mais populares a emitir: com o título cru, seis
 * dos oito não resolviam. Todos eles traziam um sufixo destes.
 *
 * Só se tenta esta segunda forma quando a primeira falha, e nunca ao contrário:
 * há séries cujo nome ACABA mesmo num numeral romano.
 */
export function semSufixoDeTemporada(title) {
  const limpo = title
    // "2nd Season", "3rd Season", "Season 2", "Part 2", "Cour 2"
    .replace(/\s*[,:]?\s*\b(\d+(?:st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+|cour\s+\d+)\s*$/i, '')
    // Um numeral romano ou árabe solto no fim: "Tanya the Evil II", "Re:Zero 4"
    .replace(/\s+(?:[IVX]{1,4}|\d{1,2})\s*$/, '')
    .trim();
  return limpo !== '' && limpo !== title.trim() ? limpo : null;
}

/**
 * O título sem o subtítulo, ou `null` se não tiver nenhum.
 *
 * A TERCEIRA forma, e nasceu de olhar para quem ficou de fora. Depois da corrida
 * de 2026-08-23, 210 séries a emitir continuavam sem fundo e a razão dominante
 * era "sem id no TVDB": 187 de 278. A lista dos mais populares entre elas dizia
 * tudo de uma vez:
 *
 *   "Trapped in a Dating Sim: The World of Otome Games is Tough for Mobs"
 *   "BLEACH: Thousand-Year Blood War - The Calamity"
 *   "Ascendance of a Bookworm: Adopted Daughter of an Archduke"
 *
 * Não são títulos japoneses por traduzir. São títulos ingleses LONGOS, e o TVDB
 * guarda a forma curta com que a série é conhecida. A busca pelo nome inteiro
 * não devolve nada porque nome nenhum bate certo.
 *
 * ## O corte, e as duas armadilhas
 *
 * Corta no primeiro `": "` ou `" - "`, com o ESPAÇO obrigatório. Sem essa
 * exigência, "Re:Zero" partia-se em "Re", e "Re" encontra qualquer coisa.
 *
 * E exige oito caracteres à esquerda. Um cabeçalho curto de mais ("Gan", "Ao")
 * é um termo de busca que devolve a série errada com toda a confiança do mundo,
 * que é pior do que não devolver nada.
 *
 * ## Porque um resultado da franquia serve
 *
 * Isto pode ir buscar o fundo do "BLEACH" original em vez do da Guerra dos Mil
 * Anos. É a MESMA troca que o `semSufixoDeTemporada` já aceita, e pela mesma
 * razão: o TVDB trata a franquia como uma série só, e o que se escreve daqui é
 * `banner_image_url`, uma imagem de fundo atrás do título. Arte da franquia
 * certa é a resposta certa. A alternativa não é arte melhor, é o desfoque cinzento
 * de que o dono se queixou.
 *
 * É por isso que esta forma é a ÚLTIMA a ser tentada: quem tem id, ou quem
 * resolve pelo nome inteiro, nunca chega aqui.
 */
export function semSubtitulo(title) {
  const corte = /^(.{8,}?)(?::\s|\s[-–—]\s)/.exec(title.trim());
  if (corte === null) return null;
  const cabeca = corte[1].trim();
  return cabeca !== '' && cabeca !== title.trim() ? cabeca : null;
}

/**
 * As formas a tentar, pela ordem em que se tentam, sem repetidas.
 *
 * Separado da busca para ser testável sem rede: a ordem é a parte que se pode
 * enganar em silêncio, e um teste que precise do TVDB não corre em lado nenhum.
 */
export function formasDeBusca(title) {
  if (!title) return [];
  const semSufixo = semSufixoDeTemporada(title);
  const cabeca = semSubtitulo(title);
  const formas = [
    title,
    semSufixo,
    cabeca,
    // AS DUAS ORDENS DE COMPOSIÇÃO, e não só uma. Parece redundante e não é:
    // cada uma delas apanha títulos que a outra não apanha, porque o
    // `semSufixoDeTemporada` só corta no FIM da cadeia.
    //
    //   "Clevatess II: Majuu no Ou to Itsuwari no Yuusha"
    //     o "II" está no meio, portanto `semSufixoDeTemporada` do título
    //     inteiro não vê nada. Só cortando o subtítulo primeiro é que o "II"
    //     passa a estar no fim e cai. Isto era o caminho em falta: sem ele
    //     tentava-se "Clevatess II", que o TVDB não conhece, e nunca
    //     "Clevatess", que conhece.
    //
    //   "Attack on Titan Season 3: Part 2"
    //     aqui é ao contrário. O subtítulo é que esconde o sufixo.
    semSufixo === null ? null : semSubtitulo(semSufixo),
    cabeca === null ? null : semSufixoDeTemporada(cabeca),
  ];
  const vistas = new Set();
  return formas.filter((f) => {
    if (f === null || f === '' || vistas.has(f)) return false;
    vistas.add(f);
    return true;
  });
}

async function resolveTvdbId(row, tvdb) {
  // Um id já gravado só serve se for de uma animação. Até 2026-09-22 a pesquisa
  // gravava o primeiro resultado fosse o que fosse, e há fichas ligadas a
  // séries de imagem real. Nesses casos tenta-se a pesquisa, que já filtra.
  const conhecido = row.external_ids?.tvdb;
  if (conhecido != null && (await tvdb.isAnimatedSeries(Number(conhecido))) === true) {
    return Number(conhecido);
  }
  if (!row.title) return null;

  for (const termo of formasDeBusca(row.title)) {
    try {
      // O ano SÓ na primeira tentativa. Nas outras o ano é o da NOSSA temporada,
      // e a série do TVDB estreou no ano da primeira: passá-lo afastava
      // justamente o resultado que se procura.
      const achado = await tvdb.searchSeries(
        termo,
        termo === row.title ? (row.year ?? undefined) : undefined,
      );
      if (achado?.tvdbId != null) return achado.tvdbId;
    } catch {
      // Best-effort: passa-se à forma seguinte.
    }
  }
  return null;
}

async function main() {
  console.log(
    `[nimu:banners] ${DRY_RUN ? 'SIMULAÇÃO (não escreve)' : 'A encher banners'}` +
      ` (teto ${LIMIT})`,
  );

  if (!config.tvdbApiKey) {
    console.error('[nimu:banners] falta TVDB_API_KEY. Sem ela não há de onde buscar arte.');
    process.exitCode = 1;
    return;
  }

  const { supabase } = await import('./supabase.js');
  const { searchSeries, seriesBackground, isAnimatedSeries } = await import('./tvdb.js');
  const tvdb = { searchSeries, seriesBackground, isAnimatedSeries };

  // A MESMA ordem do billboard: a emitir, por popularidade. Se a ordem aqui
  // divergisse da da app, enchia-se arte para títulos que ninguém vê e
  // deixavam-se sem arte os que aparecem.
  //
  // E as que VÃO estrear (`upcoming`), desde 2026-09-26: o Nimu News abre com
  // as estreias da semana e da temporada seguinte, e sem isto nenhuma delas
  // tinha arte horizontal (medido: 0 banners nas 73 séries de Outono 2026).
  const { data, error } = await supabase
    .from('animes')
    .select('id, title, year, external_ids, banner_image_url')
    .in('status', ['airing', 'upcoming'])
    .is('banner_image_url', null)
    .order('popularity', { ascending: false, nullsFirst: false })
    .order('average_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);

  if (error) {
    console.error('[nimu:banners] leitura falhou:', error.message);
    process.exitCode = 1;
    return;
  }

  const linhas = data ?? [];
  console.log(`[nimu:banners] ${linhas.length} título(s) sem banner`);

  let escritos = 0;
  let semId = 0;
  let semArte = 0;
  let mortos = 0;

  for (const [i, row] of linhas.entries()) {
    const tvdbId = await resolveTvdbId(row, tvdb);
    if (tvdbId === null) {
      semId += 1;
      continue;
    }

    let url = null;
    try {
      // Só anfitriões de imagens conhecidos (image-hosts.js): o URL vem da
      // resposta do TVDB, e pedi-lo (HEAD) e guardá-lo sem filtro fazia deste
      // passo um SSRF cego a partir do runner e deixava passar `data:` —
      // auditoria independente de 2026-10, F12.
      url = safeImageUrl(await tvdb.seriesBackground(tvdbId));
    } catch {
      // Best-effort: uma série sem arte não pode parar a passagem.
    }
    if (url === null) {
      semArte += 1;
      continue;
    }

    if (!(await isLiveImage(url))) {
      mortos += 1;
      continue;
    }

    if (DRY_RUN) {
      escritos += 1;
      if (escritos <= 5) console.log(`  ${row.title.slice(0, 40)} → ${url}`);
      continue;
    }

    const { error: writeError } = await supabase
      .from('animes')
      .update({ banner_image_url: url })
      .eq('id', row.id)
      // Guarda: só escreve se ainda estiver a nulo. Duas passagens em paralelo
      // nunca se pisam, e uma arte escolhida à mão nunca é substituída.
      .is('banner_image_url', null);

    if (writeError) {
      console.warn(`  aviso: ${row.title.slice(0, 30)}: ${writeError.message}`);
      continue;
    }
    escritos += 1;

    if ((i + 1) % 10 === 0) {
      console.log(`[nimu:banners] ${i + 1}/${linhas.length} — ${escritos} escritos`);
    }
  }

  console.log('[nimu:banners] ✅');
  console.log(`  com arte           : ${escritos}`);
  console.log(`  sem id no TVDB     : ${semId}`);
  console.log(`  id mas sem fundo   : ${semArte}`);
  console.log(`  URL que não responde: ${mortos}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:banners] falhou:', err.message);
    process.exitCode = 1;
  });
}
