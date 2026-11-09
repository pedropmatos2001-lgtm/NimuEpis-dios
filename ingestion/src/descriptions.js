// Preenchimento das sinopses em falta — o passo que dá texto às fichas.
//
//   node src/descriptions.js              → live: varre o catálogo e preenche
//   node src/descriptions.js --dry-run    → fixture; sem rede, sem Supabase
//   node src/descriptions.js --plan       → lê a base e a API A SÉRIO, mas não
//                                           escreve nada: diz o que faria
//   node src/descriptions.js --limit=N    → pára ao fim de N sinopses escritas
//
// `--dry-run` prova que o mapeador está certo sem sair do disco; `--plan` prova
// que a corrida real vai fazer o que deve, contra os dados verdadeiros, antes
// de alguém lhe dar licença para escrever.
//
// ## Porque existe
//
// A importação do manami trouxe 28 784 títulos e ZERO sinopses: 28 707 linhas
// (99,7%) têm `description` nula. O relatório de SEO pede isto de frente — uma
// ficha sem texto não ranqueia, e é por isso que o sitemap está travado nas
// 2 000 fichas. Só a ingestão do AnimeSchedule escreve descrições hoje, e essa
// toca em ~90 títulos (a janela do calendário).
//
// ## Porque a fonte é o AnimeSchedule e NÃO a AniList
//
// O pedido original era ir buscá-las à AniList em lote. Não vamos, e a razão
// está escrita no próprio projeto: `docs/research/RESEARCH-DATASOURCES-2026-07-29.md`
// documenta que os termos da AniList proíbem literalmente *"hoarding or mass
// collection"* e usá-la como *"backup or data storage service"*. Descarregar
// 20 000 sinopses e gravá-las na nossa base é as duas coisas ao mesmo tempo —
// exatamente o que motivou arrancar `ingestion/src/anilist.js` da árvore.
//
// A medição resolveu o dilema sem custo nenhum: o AnimeSchedule — a fonte
// primária que já temos licenciada, e que o comentário da própria coluna já
// nomeia como dona da `description` — responde por `mal_id` e conhece o
// catálogo antigo (Cowboy Bebop, Ginga Eiyuu Densetsu, Spirited Away). Numa
// amostra estratificada de 100 títulos sem sinopse: 92% de acerto em 2020+,
// 68% em 2005-2019, 68% até 2004, 0% nos que nem ano têm (anúncios, curtas
// promocionais e donghua — precisamente as fichas que não queremos indexar).
//
// ## Porque varre às páginas em vez de perguntar título a título
//
// `GET /anime?page=N` devolve 18 fichas COMPLETAS por pedido, com `description`
// e `websites` (donde sai o `mal_id`). São ~1 080 pedidos para as 19 416 fichas
// do catálogo inteiro — contra 28 707 se fôssemos linha a linha. A ~95 req/min
// (o limitador partilhado de `animeschedule.js`, sob o teto documentado de 120)
// dá uma varredura completa em ~12 minutos, em vez de mais de cinco horas.
//
// ## O que escreve, e só isso
//
// `animes.description`. Mais nada. As outras colunas têm dono declarado
// (`catalogue.js`: título/capa/score/popularidade são do pipeline do
// AnimeSchedule, as facetas do manami) e este passo não lhes toca. A escrita é
// `UPDATE … WHERE id = ? AND description IS NULL`: a guarda no `WHERE` — a
// mesma que `catalogue-episodes.js --resolve` usa — garante que uma sinopse já
// escrita nunca é reescrita, mesmo que outro processo a tenha preenchido entre
// a leitura e a escrita. Correr duas vezes seguidas não escreve nada da segunda
// vez, porque a segunda leitura já não encontra a linha.
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Importado pelo efeito, e a ordem importa: é `config.js` que corre o dotenv
// sobre `ingestion/.env`. Sem isto, o `assertConfig()` lá em baixo lê um
// `process.env` ainda vazio e uma corrida local morre a dizer que faltam
// credenciais que estão no ficheiro — o `supabase.js` só é importado depois,
// tarde demais para as validar.
import './config.js';
import { extractExternalIds, stripHtml } from './mappers.js';

const PAGE = 1000; // página de leitura do Supabase (a PostgREST corta às 1000)
const PAGE_SIZE = 18; // o que /anime?page=N devolve por página (fixo na API)

// Abaixo disto não é uma sinopse, é uma etiqueta ("Anúncio.", "N/A"). O corte
// é baixo de propósito: "Compilação dos episódios 1-4 do OVA." tem 39 caracteres
// e é informação verdadeira — vale mais na ficha do que um vazio. O que este
// mínimo trava são os fragmentos e os campos preenchidos por preencher.
const MIN_DESCRIPTION_CHARS = 25;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../test/fixtures/descriptions-sample.json');

const DRY_RUN = process.argv.includes('--dry-run');
const PLAN = process.argv.includes('--plan');
const LIMIT = parseLimit(process.argv);

/**
 * Onde fica a marca da ultima pagina varrida com sucesso.
 *
 * ## Porque isto passou a existir
 *
 * O catalogo da AnimeSchedule sao ~1080 paginas. Medido a 2026-08-21, uma
 * corrida limpa morre a pagina 121 com HTTP 429, e morre DEPOIS de o cliente
 * ja ter tentado quatro vezes com backoff e de ter respeitado o Retry-After.
 * Ou seja: o limite real nao e o documentado de 120 pedidos por minuto, e uma
 * quota por rajada que nenhuma corrida unica consegue contornar.
 *
 * O resultado era pior do que uma falha: as 121 paginas varridas nao davam
 * nada, porque o processo abortava antes de escrever, e a corrida seguinte
 * comecava outra vez na pagina 1. E por isso que o catalogo tem 85 sinopses
 * em 28 784 fichas, quando 93% das fichas varridas tem uma disponivel.
 *
 * Com a marca, cada corrida avanca um pedaco e a seguinte continua. Doze
 * corridas de uma hora fazem o que uma corrida infinita nunca ia fazer.
 *
 * Fica em `.cache/`, que ja e ignorada pelo Git e ja e o sitio onde a
 * ingestao guarda a base do manami.
 */
const MARCADOR = 'catalogue-sweep.json';

/** Quantas paginas no maximo por corrida. `--paginas N` muda-o. */
const PAGINAS_POR_CORRIDA = parseNumero(process.argv, '--paginas', 100);

function parseNumero(argv, nome, omissao) {
  const i = argv.indexOf(nome);
  if (i < 0) return omissao;
  const n = Number.parseInt(argv[i + 1] ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : omissao;
}

function caminhoMarcador() {
  return new URL(`../.cache/${MARCADOR}`, import.meta.url);
}

/** A pagina onde a proxima corrida deve comecar. 1 quando nao ha marca. */
function lerMarcador() {
  try {
    const bruto = JSON.parse(readFileSync(caminhoMarcador(), 'utf8'));
    const n = Number.parseInt(bruto?.proximaPagina ?? '', 10);
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Grava a marca. Uma falha aqui nao pode derrubar a corrida: o pior que
 * acontece e a proxima repetir paginas, e repetir e barato (a escrita tem
 * `.is('description', null)`, portanto nunca sobrepoe nada).
 */
function escreverMarcador(proximaPagina, total) {
  try {
    mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
    writeFileSync(
      caminhoMarcador(),
      JSON.stringify({ proximaPagina, total, em: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.warn(`[nimu:desc] ⚠ não consegui gravar a marca: ${err.message}`);
  }
}

// ── Puro (testável sem rede nem base) ────────────────────────────────────────

/** Lê `--limit=N` (inteiro positivo), ou null. */
export function parseLimit(argv) {
  const arg = (argv ?? []).find((a) => a.startsWith('--limit='));
  if (!arg) return null;
  const n = Number(arg.slice('--limit='.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Texto limpo bom o suficiente para ir para a ficha, ou null. */
export function usableDescription(html) {
  const text = stripHtml(html);
  return text !== null && text.length >= MIN_DESCRIPTION_CHARS ? text : null;
}

/**
 * Uma página de `/anime` → Map(mal_id → sinopse limpa).
 *
 * Só entram as entradas que têm as DUAS pontas: um `mal_id` extraível de
 * `websites` (é a única chave que cruza com a nossa base — 100% das linhas sem
 * sinopse têm `mal_id`) e um texto que passe o mínimo. As restantes não são
 * erro nenhum, são só ruído do catálogo.
 */
export function descriptionsByMalId(anime, into = new Map()) {
  for (const entry of anime ?? []) {
    const malId = extractExternalIds(entry?.websites).mal;
    if (!Number.isInteger(malId)) continue;
    const text = usableDescription(entry?.description);
    if (text === null) continue;
    // Primeiro a ganhar. Dois `route` diferentes podem apontar ao mesmo
    // `mal_id` (uma série e o seu recap, por exemplo); sem esta regra a última
    // página visitada mandaria, e a varredura deixaria de ser determinística.
    if (!into.has(malId)) into.set(malId, text);
  }
  return into;
}

/**
 * Ordem de preenchimento: mais seguidos primeiro (`popularity` desc, nulos no
 * fim), depois os mais recentes, e por fim o `id` para a corrida ser
 * determinística — assim um `--limit` corta sempre pela cauda e não pelo meio.
 */
export function prioritize(rows) {
  return [...rows].sort((a, b) => {
    const pa = a.popularity ?? -1;
    const pb = b.popularity ?? -1;
    if (pb !== pa) return pb - pa;
    const ya = a.year ?? -1;
    const yb = b.year ?? -1;
    if (yb !== ya) return yb - ya;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * As escritas que este passo faria: linha sem sinopse × sinopse encontrada.
 *
 * Uma linha que JÁ tenha texto nunca entra, mesmo que a fonte traga outro — é
 * a regra de não reescrever o que já está bom, aplicada antes de chegar à base
 * (a guarda no `UPDATE` é a segunda linha de defesa, não a primeira).
 */
export function planFills(rows, byMalId, limit = null) {
  const fills = [];
  let jaTinha = 0;
  let semFonte = 0;
  for (const row of prioritize(rows ?? [])) {
    const atual = typeof row.description === 'string' ? row.description.trim() : '';
    if (atual !== '') {
      jaTinha += 1;
      continue;
    }
    const text = byMalId.get(row.mal_id);
    if (text === undefined) {
      semFonte += 1;
      continue;
    }
    if (limit !== null && fills.length >= limit) continue;
    fills.push({ id: row.id, title: row.title, description: text });
  }
  return { fills, jaTinha, semFonte };
}

// ── Leituras e escritas ──────────────────────────────────────────────────────

/** As linhas sem sinopse, paginadas (são ~28 700 — não cabem numa leitura). */
async function fetchRowsMissingDescription(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, title, popularity, year, description')
      .is('description', null)
      .not('mal_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * Varre o catálogo do AnimeSchedule e devolve Map(mal_id → sinopse).
 *
 * Pára pela CONTAGEM, nunca por erro: pedir uma página para lá do fim devolve
 * HTTP 500 (verificado — a página 1080 de 1079), e o `fetchJson` trata 5xx como
 * falha transitória e ainda tenta quatro vezes antes de rebentar. Enquanto a
 * página vier cheia e o acumulado for menor que o `totalAmount`, continua.
 *
 * `onProgress` recebe o acumulado para o chamador poder desistir cedo quando o
 * `--limit` já está satisfeito — não vale a pena varrer 1 000 páginas para
 * escrever 50 linhas.
 */
async function sweepCatalogue(
  fetchPage,
  { onProgress = null, into, desde = 1, maximo = Infinity } = {},
) {
  const byMalId = into ?? new Map();
  let vistos = 0;
  let paginas = 0;
  let page = desde;
  let fim = false;

  for (; paginas < maximo; page += 1) {
    const res = await fetchPage({ page });
    paginas += 1;
    vistos += res.anime.length;
    descriptionsByMalId(res.anime, byMalId);
    if (onProgress) onProgress({ page, paginas, vistos, total: res.totalAmount, byMalId });
    // O fim do catalogo: uma pagina curta, ou a posicao da pagina ja passou o
    // total que ele diz ter. A conta e pela POSICAO e nao pelas fichas vistas
    // nesta corrida: uma corrida que comeca na pagina 500 tem `vistos` a zero
    // e pararia de imediato se comparasse os dois.
    if (res.anime.length < PAGE_SIZE) {
      fim = true;
      break;
    }
    if (res.totalAmount > 0 && page * PAGE_SIZE >= res.totalAmount) {
      fim = true;
      break;
    }
  }

  // `proximaPagina`: onde a corrida seguinte pega. No fim do catalogo volta a
  // 1, porque o catalogo cresce e uma segunda volta apanha o que e novo.
  return { byMalId, vistos, paginas, proximaPagina: fim ? 1 : page, fim };
}

/**
 * Escreve UMA sinopse, e só se a linha continuar sem nenhuma.
 *
 * O `.is('description', null)` no WHERE não é decorativo: entre a leitura (que
 * pode ter horas, numa varredura completa) e esta escrita, a ingestão do
 * AnimeSchedule ou o `--resolve` do TVDB podem ter preenchido a mesma linha. A
 * guarda faz com que essa corrida acabe sempre no mesmo sítio — o primeiro a
 * escrever ganha, e este passo nunca é quem apaga trabalho de outro.
 */
async function fillDescription(supabase, id, description) {
  const { error } = await supabase
    .from('animes')
    .update({ description })
    .eq('id', id)
    .is('description', null);
  if (error) throw error;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Sinal interno para abortar a varredura quando o `--limit` já está servido. */
class EarlyStop extends Error {}

/** Falha cedo (nomes, nunca valores) quando falta ambiente a uma corrida real. */
function assertConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANIMESCHEDULE_TOKEN'].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}.\n` +
        '→ Local: preencher em ingestion/.env (ou no .env da raiz).\n' +
        '→ CI: adicionar como GitHub Actions secrets.\n' +
        '→ Sem credenciais? `node src/descriptions.js --dry-run` (fixture, sem rede).',
    );
  }
}

async function dryRun(startedAt) {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const byMalId = descriptionsByMalId(fixture.catalogue.anime);
  const { fills, jaTinha, semFonte } = planFills(fixture.rows, byMalId, LIMIT);

  console.log(
    `[nimu:desc] fixture: ${fixture.catalogue.anime.length} fichas do catálogo → ` +
      `${byMalId.size} sinopse(s) utilizável(eis) com mal_id`,
  );
  console.log(`[nimu:desc] alvo: ${fixture.rows.length} linha(s) de animes`);
  for (const fill of fills) {
    console.log(`[nimu:desc]   PREENCHERIA "${fill.title}" → ${JSON.stringify(fill.description)}`);
  }
  console.log(
    `[nimu:desc] preencheria ${fills.length} · ${jaTinha} já tinha(m) sinopse (intocada) · ` +
      `${semFonte} sem fonte`,
  );
  console.log(
    `[nimu:desc] ✅ Dry run OK em ${((Date.now() - startedAt) / 1000).toFixed(1)}s — nada escrito`,
  );
}

async function main() {
  const startedAt = Date.now();
  const modo = DRY_RUN
    ? 'DRY RUN (fixture, sem escritas)'
    : PLAN
      ? 'PLANO (dados reais, sem escritas)'
      : 'Preenchimento de sinopses';
  console.log(
    `[nimu:desc] ${modo} a começar…` +
      `${LIMIT ? ` (limite ${LIMIT})` : ''}`,
  );

  if (DRY_RUN) return dryRun(startedAt);

  assertConfig();
  const { supabase } = await import('./supabase.js');
  const { fetchAnimeCataloguePage } = await import('./animeschedule.js');

  const rows = await fetchRowsMissingDescription(supabase);
  console.log(`[nimu:desc] ${rows.length} linha(s) sem sinopse (todas com mal_id)`);
  if (rows.length === 0) {
    console.log('[nimu:desc] ✅ Nada a fazer — o catálogo já tem sinopses');
    return;
  }

  // Só interessa uma sinopse cujo mal_id esteja em falta cá dentro: assim a
  // varredura pode desistir assim que o --limit estiver satisfeito.
  const emFalta = new Set(rows.map((r) => r.mal_id));
  const alvo = LIMIT ?? Infinity;

  const byMalId = new Map();
  let vistosTotal = 0;
  let paginasTotal = 0;

  // Quantas das sinopses recolhidas servem MESMO para preencher uma linha
  // nossa. É esta a contagem que o --limit trava — não as páginas, que não
  // dizem nada sobre o proveito. Só é recontada quando é precisa (a cada 25
  // páginas para o registo, ou sempre que há limite para verificar); percorrer
  // uma Map de 19 mil chaves a cada uma das ~1 080 páginas seria trabalho a
  // troco de nada numa corrida sem limite.
  const contaUteis = () => {
    let uteis = 0;
    for (const malId of byMalId.keys()) if (emFalta.has(malId)) uteis += 1;
    return uteis;
  };

  const onProgress = ({ paginas, vistos, total }) => {
    vistosTotal = vistos;
    paginasTotal = paginas;
    const marco = paginas % 25 === 0;
    if (!marco && LIMIT === null) return;
    const uteis = contaUteis();
    if (marco) {
      console.log(
        `[nimu:desc] varrido ${vistos}${total ? `/${total}` : ''} ficha(s) em ` +
          `${paginas} página(s) — ${uteis} servem para preencher`,
      );
    }
    if (uteis >= alvo) throw new EarlyStop();
  };

  // Onde a corrida anterior ficou. Ver `MARCADOR` para o porque de isto existir.
  const desde = lerMarcador();
  if (desde > 1) console.log(`[nimu:desc] a retomar na pagina ${desde}`);

  try {
    const res = await sweepCatalogue(fetchAnimeCataloguePage, {
      into: byMalId,
      onProgress,
      desde,
      maximo: PAGINAS_POR_CORRIDA,
    });
    vistosTotal = res.vistos;
    paginasTotal = res.paginas;
    // A marca grava-se AQUI, com a varredura terminada em bom estado, e nao a
    // cada pagina: uma marca escrita a meio de uma pagina que depois falha
    // faria a corrida seguinte saltar fichas sem ninguem dar por isso.
    if (!PLAN && !DRY_RUN) escreverMarcador(res.proximaPagina, res.total ?? null);
    if (res.fim) console.log('[nimu:desc] catalogo percorrido ate ao fim');
    else console.log(`[nimu:desc] a proxima corrida comeca na pagina ${res.proximaPagina}`);
  } catch (err) {
    if (!(err instanceof EarlyStop)) throw err;
    console.log('[nimu:desc] limite satisfeito — varredura interrompida cedo');
  }

  console.log(
    `[nimu:desc] varredura: ${vistosTotal} ficha(s) em ${paginasTotal} página(s) → ` +
      `${byMalId.size} sinopse(s) utilizável(eis)`,
  );

  const { fills, jaTinha, semFonte } = planFills(rows, byMalId, LIMIT);
  console.log(`[nimu:desc] ${fills.length} sinopse(s) ${PLAN ? 'a preencher (plano)' : 'para escrever'}`);

  let escritas = 0;
  for (const fill of fills) {
    if (!PLAN) await fillDescription(supabase, fill.id, fill.description);
    escritas += 1;
    if (escritas % 100 === 0 || escritas === fills.length) {
      console.log(`[nimu:desc] ${escritas}/${fills.length} ${PLAN ? 'planeada(s)' : 'escrita(s)'}`);
    }
  }

  if (PLAN) {
    for (const fill of fills.slice(0, 5)) {
      console.log(`[nimu:desc]   exemplo: "${fill.title}" → ${JSON.stringify(fill.description.slice(0, 120))}`);
    }
  }

  console.log(
    `[nimu:desc] ${PLAN ? '✅ Plano' : '✅ Feito'} em ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n` +
      `  linhas sem sinopse   : ${rows.length}\n` +
      `  ${PLAN ? 'preencheria         ' : 'preenchidas         '} : ${escritas}\n` +
      `  já tinham (intocadas): ${jaTinha}\n` +
      `  sem fonte (ficam)    : ${semFonte}` +
      (PLAN ? '\n  NADA foi escrito — tira o --plan para valer.' : ''),
  );
}

// Corre só quando é executado diretamente, nunca quando um teste o importa —
// é o que mantém os ajudantes puros acima testáveis sem efeitos secundários.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:desc] ❌ Preenchimento de sinopses falhou:', error);
    process.exitCode = 1;
  });
}
