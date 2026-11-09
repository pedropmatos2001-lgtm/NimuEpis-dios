// Auditoria do catálogo — diz o que está partido, e nada mais que isso.
//
//   node src/audit-data.js                → auditoria completa (verifica capas por HTTP)
//   node src/audit-data.js --json         → o mesmo relatório em JSON, para canalizar
//   node src/audit-data.js --no-http      → só a base, sem tocar na rede (rápido)
//   node src/audit-data.js --sample=400   → amostra maior nas origens grandes de capas
//   node src/audit-data.js --examples=12  → mais exemplos por secção
//
// `--sample=N` governa só as origens de capa GRANDES: as pequenas verificam-se
// sempre por inteiro, porque é lá que as capas partidas vivem (ver
// `planCoverChecks`).
//
// ## É SÓ DE LEITURA, e isso está trancado
//
// Uma auditoria que repara deixa de ser auditoria: perde-se a fotografia do
// antes. Este passo não escreve uma única linha, e a garantia não é a boa
// vontade de quem lê o ficheiro — o cliente Supabase passa por `readOnlyClient`
// (abaixo), que rebenta se alguém chamar `insert`, `update`, `upsert`, `delete`
// ou `rpc`. Quem quiser reparar tem ferramentas próprias: `covers.js` para as
// capas, `descriptions.js` para as sinopses.
//
// ## Porque lê o catálogo todo em vez de contar no servidor
//
// As contagens simples (sinopses nulas, capas nulas) davam-se com `count:exact`
// numa fração do tempo. As outras duas perguntas não: a deteção de travessões
// precisa de olhar para cada texto caractere a caractere, e a regra vive em
// JavaScript, não em SQL. Medido contra a base real, ler as colunas de texto
// inteiras custa ~13s (2,9 MB do catálogo, 5,0 MB dos episódios) e responde às
// quatro perguntas a partir de uma só leitura. Vale a simplicidade: um número
// contado no servidor e outro contado em memória podem discordar, dois números
// contados sobre a mesma leitura não podem.
import { pathToFileURL } from 'node:url';

// Importado pelo efeito, e a ordem importa: é `config.js` que corre o dotenv
// sobre `ingestion/.env`. Sem isto o `assertConfig()` lá em baixo lê um
// `process.env` ainda vazio e uma corrida local morre a dizer que faltam
// credenciais que estão no ficheiro.
import './config.js';
import { inspectImage } from './covers.js';
import { stripHtml } from './mappers.js';

const PAGE = 1000; // a PostgREST corta uma leitura às 1000 linhas
const DEFAULT_SAMPLE = 150; // capas amostradas por HTTP nas origens grandes
const DEFAULT_EXAMPLES = 5; // exemplos impressos por secção
const HTTP_CONCURRENCY = 10; // pedidos de capa em paralelo (o mesmo do covers.js)
// Uma origem com poucas linhas verifica-se INTEIRA em vez de se amostrar. Ver a
// justificação em `planCoverChecks`.
const FULL_SCAN_UNDER = 150;

// Abaixo disto não é sinopse, é etiqueta. O mesmo corte que o `descriptions.js`
// usa para decidir se um texto serve para a ficha, para os dois passos não
// discordarem sobre o que conta como "tem sinopse".
const MIN_DESCRIPTION_CHARS = 25;

// ── Puro (testável sem rede nem base) ────────────────────────────────────────

/** Lê as opções da linha de comandos. Valores inválidos caem no predefinido. */
export function parseArgs(argv = []) {
  const has = (name) => argv.includes(`--${name}`);
  const valueOf = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const positive = (raw, fallback) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    json: has('json'),
    http: !has('no-http'),
    sampleSize: positive(valueOf('sample'), DEFAULT_SAMPLE),
    examples: positive(valueOf('examples'), DEFAULT_EXAMPLES),
  };
}

/**
 * Trava de segurança: um cliente Supabase que só sabe ler.
 *
 * Devolve um objeto com `from()` apenas, e o construtor de consultas que ele
 * devolve vem embrulhado num proxy que atira ao primeiro sinal de escrita. Não
 * é decoração: é a diferença entre "prometi que não escrevo" e "não consigo
 * escrever". As funções são ligadas ao alvo real para o `this` do supabase-js
 * continuar a ser o construtor verdadeiro e não o proxy.
 */
export function readOnlyClient(client) {
  const BLOQUEADO = new Set(['insert', 'update', 'upsert', 'delete']);
  return {
    from(table) {
      return new Proxy(client.from(table), {
        get(target, prop) {
          if (typeof prop === 'string' && BLOQUEADO.has(prop)) {
            throw new Error(
              `Auditoria é só de leitura: ${prop}() sobre "${table}" está bloqueado.`,
            );
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rpc() {
      // Uma função da base pode escrever sem que se veja daqui. Fora.
      throw new Error('Auditoria é só de leitura: rpc() está bloqueado.');
    },
  };
}

/** Texto que não serve de sinopse: nulo, vazio, ou curto demais para informar. */
export function isSynopsisEmpty(description) {
  return stripHtml(description) === null;
}

/** Sinopse presente mas curta demais para dizer alguma coisa na ficha. */
export function isSynopsisTooShort(description) {
  const text = stripHtml(description);
  return text !== null && text.length < MIN_DESCRIPTION_CHARS;
}

/** Capa ausente: nula, vazia, ou só espaço branco. */
export function isCoverMissing(url) {
  return typeof url !== 'string' || url.trim() === '';
}

/** Origem de uma capa (o host), ou 'url-invalida' quando nem URL é. */
export function coverHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'url-invalida';
  }
}

// ── Travessões e hífenes ─────────────────────────────────────────────────────
//
// ## A regra, por extenso
//
// O que se procura é o travessão a separar ideias, o vício que o dono já mandou
// arrancar da app. O que NÃO se procura é o hífen que une uma palavra composta:
// "bem-vindo" e "guarda-chuva" estão certos e não podem aparecer no relatório,
// senão o relatório deixa de se ler.
//
// A decisão faz-se pela VIZINHANÇA de cada sinal, não pelo sinal em si:
//
//   marcado    travessão tipográfico (– — ― ‒ −) entre palavras, com espaços
//              ou sem eles: é sempre um separador de ideias
//   marcado    hífen com espaço dos DOIS lados (" - "): hífen a fazer de
//              travessão, que é o erro mais comum
//   marcado    hífen com espaço de UM lado só ("bem- vindo"): composto partido
//   marcado    hífen duplo ("--"): travessão de máquina de escrever
//   limpo      hífen entre dois caracteres de palavra ("bem-vindo", "e-mail")
//
// E cinco exceções, todas por causa de falsos positivos reais:
//
//   1. intervalo numérico: "1-4", "1939 – 1945". Números dos dois lados (a
//      ignorar um espaço) é um intervalo, não uma frase partida ao meio.
//   2. sinal negativo: " -5" a seguir a espaço é um número, não pontuação.
//   3. início de linha seguido de espaço: "- item" é marcador de lista e
//      "— Olá" é travessão de diálogo. Nenhum dos dois separa ideias.
//   4. régua decorativa: três ou mais sinais seguidos ("---", "———") é layout.
//   5. hífen suspenso: "pós- e pré-guerra" está correto em português. O hífen
//      fica pendurado à espera do segundo termo, e é seguido de uma conjunção.
//
// O texto é limpo de HTML antes de ser lido, e as entidades de travessão
// (&mdash;, &ndash;, &#8212;, …) são traduzidas primeiro: o que interessa é o
// que o visitante vê renderizado, não o que está guardado.

const DASH_RUN = /[-‐‑‒–—―−]+/g;
const TYPOGRAPHIC_DASH = /[‒–—―−]/;
// A conjunção que fecha um hífen suspenso. O português é o que interessa
// ("pós- e pré-guerra"), mas o catálogo guarda sinopses em várias línguas e a
// construção existe nelas também. Medido contra a base real: só com "e"/"ou"
// aqui, "brother- and sister-in-law" e "nalja- ja vembumehega" saíam no
// relatório como compostos partidos, e ambos estão corretos.
const HIFEN_SUSPENSO = /^\s+(?:e|ou|and|or|ja)\s/;
const DASH_ENTITY = /&(?:mdash|ndash|horbar|minus|#8211|#8212|#8722|#x201[34]|#x2212);/gi;
const ENTITY_TO_DASH = {
  mdash: '—',
  ndash: '–',
  horbar: '―',
  minus: '−',
  '#8211': '–',
  '#8212': '—',
  '#8722': '−',
  '#x2013': '–',
  '#x2014': '—',
  '#x2212': '−',
};

/** Entidades HTML de travessão → o caractere que o visitante vê. */
export function decodeDashEntities(text) {
  if (typeof text !== 'string') return '';
  return text.replace(DASH_ENTITY, (m) => {
    const key = m.slice(1, -1).toLowerCase();
    return ENTITY_TO_DASH[key] ?? m;
  });
}

/** Texto tal como aparece na app: sem marcação, com os travessões já visíveis. */
export function visibleText(raw) {
  return stripHtml(decodeDashEntities(raw)) ?? '';
}

const isSpace = (ch) => ch === '' || /\s/.test(ch);

/** Verdadeiro quando entre o início da linha e `index` só há espaço branco. */
function atLineStart(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') return true;
    if (!/\s/.test(ch)) return false;
  }
  return true;
}

/** Primeiro caractere não-espaço antes de `index`, sem saltar de linha. */
function prevMeaningful(text, index) {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  return i >= 0 ? text[i] : '';
}

/** Primeiro caractere não-espaço a partir de `index`, sem saltar de linha. */
function nextMeaningful(text, index) {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return i < text.length ? text[i] : '';
}

/** Classifica uma sequência de sinais, ou null quando está correta. */
function classifyDashRun(text, start, end, run) {
  if (run.length >= 3) return null; // régua decorativa

  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  const spaceBefore = isSpace(before);
  const spaceAfter = isSpace(after);

  if (spaceAfter && atLineStart(text, start)) return null; // lista ou diálogo
  if (/\d/.test(prevMeaningful(text, start)) && /\d/.test(nextMeaningful(text, end))) {
    return null; // intervalo numérico
  }
  if (spaceBefore && /\d/.test(after)) return null; // sinal negativo

  if (TYPOGRAPHIC_DASH.test(run)) return 'travessao';

  if (!spaceBefore && spaceAfter && HIFEN_SUSPENSO.test(text.slice(end))) {
    return null; // hífen suspenso: "pós- e pré-guerra"
  }
  if (run.length >= 2) return 'hifen-duplo';
  if (spaceBefore && spaceAfter) return 'hifen-travessao';
  if (spaceBefore !== spaceAfter) return 'hifen-solto';
  return null; // palavra composta
}

/** Um bocado de texto à volta da ocorrência, para o relatório ser lível. */
function excerptAt(text, start, end, pad = 34) {
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  const slice = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${slice}${to < text.length ? '…' : ''}`;
}

/**
 * Ocorrências de travessão ou hífen mal formatado num texto, já limpo de HTML.
 * Devolve `[{ kind, index, excerpt }]`, vazio quando o texto está limpo.
 */
export function findDashIssues(raw) {
  const text = visibleText(raw);
  if (text === '') return [];
  const issues = [];
  DASH_RUN.lastIndex = 0;
  let match;
  while ((match = DASH_RUN.exec(text)) !== null) {
    const run = match[0];
    const start = match.index;
    const end = start + run.length;
    const kind = classifyDashRun(text, start, end, run);
    if (kind) issues.push({ kind, index: start, excerpt: excerptAt(text, start, end) });
  }
  return issues;
}

// ── Temporadas ───────────────────────────────────────────────────────────────

// Mês (índice JS) do PRIMEIRO mês DEPOIS da temporada. Inverno acaba antes de
// abril, primavera antes de julho, e assim por diante.
const SEASON_ENDS_BEFORE = { winter: 3, spring: 6, summer: 9, fall: 12, autumn: 12 };

/**
 * A temporada de estreia já passou por completo?
 *
 * Sem ano não se decide nada (devolve falso): a linha pode ser um anúncio sem
 * data. Com ano mas sem temporada usa-se o ano inteiro, que é o critério mais
 * conservador possível — só marca quando nem dezembro desse ano salva a linha.
 */
export function isSeasonPast(year, season, now = new Date()) {
  if (!Number.isInteger(year)) return false;
  const key = typeof season === 'string' ? season.trim().toLowerCase() : '';
  const endsBefore = SEASON_ENDS_BEFORE[key];
  const end = Date.UTC(year, endsBefore ?? 12, 1);
  return now.getTime() >= end;
}

// ── Amostragem ───────────────────────────────────────────────────────────────

/**
 * Escolhe que capas verificar por HTTP, agrupadas por origem.
 *
 * ## Porque uma origem pequena se verifica inteira
 *
 * Amostrar por igual seria enganador. Das 28 578 capas guardadas, 28 373 vêm de
 * uma só origem e as outras quatro ficam-se pelas dezenas. Só que as capas
 * mortas medidas contra a base real estavam TODAS numa origem de 90 linhas (4
 * em 90, todas a responder 403). Uma amostra proporcional de 60 linhas dá cinco
 * pedidos a essa origem e falha as quatro mortas em quatro corridas de cada
 * cinco. A origem pequena é a mais suspeita, não a menos.
 *
 * Por isso: origens abaixo de `fullScanUnder` verificam-se por inteiro (são
 * poucas linhas, o custo é baixo e o número que sai é exato, não estimado), e
 * `sampleSize` reparte-se pelas restantes por tamanho, com o mínimo de uma.
 *
 * ## Porque a passo fixo e não ao acaso
 *
 * Dentro de cada origem os elementos apanham-se a passo fixo. Duas corridas
 * seguidas verificam as mesmas linhas, e a diferença entre dois relatórios é
 * uma mudança nos dados, não no sorteio.
 *
 * Devolve `{ checks, completos }`: as linhas a verificar, e o conjunto de
 * origens que ficaram cobertas na íntegra.
 */
export function planCoverChecks(rows, keyOf, { sampleSize, fullScanUnder = FULL_SCAN_UNDER } = {}) {
  const vazio = { checks: [], completos: new Set() };
  if (!Array.isArray(rows) || rows.length === 0) return vazio;

  const groups = new Map();
  for (const row of rows) {
    const key = String(keyOf(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keys = [...groups.keys()].sort();

  const pequenas = keys.filter((k) => groups.get(k).length <= fullScanUnder);
  const grandes = keys.filter((k) => groups.get(k).length > fullScanUnder);

  const quota = new Map();
  const completos = new Set();
  for (const key of pequenas) {
    quota.set(key, groups.get(key).length);
    completos.add(key);
  }

  // O orçamento de amostra reparte-se pelas origens grandes, por tamanho, mas
  // com o mínimo de uma linha cada para nenhuma ficar invisível.
  const budget = Math.max(0, sampleSize ?? 0);
  if (grandes.length > 0 && budget > 0) {
    const totalGrandes = grandes.reduce((sum, k) => sum + groups.get(k).length, 0);
    let porGastar = budget;
    grandes
      .map((key) => ({ key, size: groups.get(key).length }))
      .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key))
      .forEach(({ key, size }, i, arr) => {
        const restantes = arr.length - i - 1;
        const ideal = Math.round((size / totalGrandes) * budget);
        const take = Math.max(1, Math.min(size, porGastar - restantes, ideal));
        quota.set(key, take);
        porGastar -= take;
        if (take >= size) completos.add(key);
      });
  }

  const checks = [];
  for (const key of keys) {
    const group = groups.get(key);
    const take = Math.min(group.length, quota.get(key) ?? 0);
    if (take <= 0) continue;
    const stride = group.length / take;
    for (let i = 0; i < take; i += 1) checks.push(group[Math.floor(i * stride)]);
  }
  return { checks, completos };
}

// ── Formatação ───────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('pt-PT');
const num = (n) => nf.format(n ?? 0);

/** "1 234 (4,3%)" — a percentagem à portuguesa, e "n/d" quando não há base. */
export function pct(part, total) {
  if (!total) return 'n/d';
  return `${((part / total) * 100).toFixed(1).replace('.', ',')}%`;
}

// ── Leituras (nunca escritas) ────────────────────────────────────────────────

/** Todas as linhas de uma tabela, às páginas, ordenadas por `id`. */
async function pageAll(db, table, columns, onProgress) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (onProgress) onProgress(out.length);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// ── Verificações ─────────────────────────────────────────────────────────────

/** 1. Sinopses vazias, com o recorte do que está no ar à parte. */
function auditSynopses(animes) {
  const vazias = animes.filter((a) => isSynopsisEmpty(a.description));
  const curtas = animes.filter((a) => isSynopsisTooShort(a.description));
  const porEstado = {};
  for (const estado of ['airing', 'upcoming', 'finished', 'hiatus', 'cancelled']) {
    const doEstado = animes.filter((a) => a.status === estado);
    if (doEstado.length === 0) continue;
    porEstado[estado] = {
      total: doEstado.length,
      vazias: doEstado.filter((a) => isSynopsisEmpty(a.description)).length,
    };
  }
  return {
    total: animes.length,
    vazias: vazias.length,
    curtas: curtas.length,
    porEstado,
    exemplos: vazias.filter((a) => a.status === 'airing').map((a) => a.title),
  };
}

/** 2a. Capas em falta, contadas na base (sem tocar na rede). */
function auditMissingCovers(animes) {
  const semCapa = animes.filter((a) => isCoverMissing(a.cover_image_url));
  const comCapa = animes.filter((a) => !isCoverMissing(a.cover_image_url));
  const porOrigem = {};
  for (const a of comCapa) {
    const host = coverHost(a.cover_image_url);
    porOrigem[host] = (porOrigem[host] ?? 0) + 1;
  }
  return {
    total: animes.length,
    semCapa: semCapa.length,
    semCapaNoAr: semCapa.filter((a) => a.status === 'airing').length,
    comCapa: comCapa.length,
    porOrigem,
    exemplos: semCapa.map((a) => a.title),
  };
}

/**
 * 2b. Capas partidas: uma amostra verificada por HTTP.
 *
 * `cover_image_url IS NULL` não chega: já se apurou que há URLs guardadas que a
 * origem recusa. Só um pedido diz a verdade, e 28 578 pedidos não são uma
 * ferramenta que se corra à mão, por isso as origens pequenas verificam-se por
 * inteiro e as grandes por amostra, com a taxa de cada origem extrapolada para
 * o total dessa origem (ver `planCoverChecks`).
 *
 * Um veredicto 'unknown' (tempo esgotado, 429, erro de rede) NUNCA conta como
 * morto e sai da base de cálculo da taxa: é a mesma prudência que o `covers.js`
 * usa antes de mexer numa linha.
 */
async function auditBrokenCovers(animes, { sampleSize, onProgress }) {
  const comCapa = animes.filter((a) => !isCoverMissing(a.cover_image_url));
  const { checks, completos } = planCoverChecks(comCapa, (a) => coverHost(a.cover_image_url), {
    sampleSize,
  });

  const resultados = [];
  for (let i = 0; i < checks.length; i += HTTP_CONCURRENCY) {
    const lote = checks.slice(i, i + HTTP_CONCURRENCY);
    const veredictos = await Promise.all(lote.map((a) => inspectImage(a.cover_image_url)));
    lote.forEach((a, k) => resultados.push({ anime: a, ...veredictos[k] }));
    if (onProgress) onProgress(resultados.length, checks.length);
  }

  const porOrigem = {};
  for (const r of resultados) {
    const host = coverHost(r.anime.cover_image_url);
    const g = (porOrigem[host] ??= {
      naBase: 0,
      verificadas: 0,
      completa: completos.has(host),
      ok: 0,
      mortas: 0,
      indeterminadas: 0,
      estados: {},
    });
    g.verificadas += 1;
    if (r.verdict === 'ok') g.ok += 1;
    else if (r.verdict === 'dead') g.mortas += 1;
    else g.indeterminadas += 1;
    if (r.status != null) g.estados[r.status] = (g.estados[r.status] ?? 0) + 1;
  }
  for (const a of comCapa) {
    const host = coverHost(a.cover_image_url);
    if (porOrigem[host]) porOrigem[host].naBase += 1;
  }

  let estimativa = 0;
  for (const g of Object.values(porOrigem)) {
    const base = g.verificadas - g.indeterminadas;
    g.taxaMorta = base > 0 ? g.mortas / base : null;
    // Verificada por inteiro, o número é contado; amostrada, é extrapolado.
    g.estimativaMortas =
      g.completa && g.indeterminadas === 0
        ? g.mortas
        : g.taxaMorta === null
          ? null
          : Math.round(g.taxaMorta * g.naBase);
    estimativa += g.estimativaMortas ?? 0;
  }

  return {
    comCapa: comCapa.length,
    verificadas: resultados.length,
    ok: resultados.filter((r) => r.verdict === 'ok').length,
    mortas: resultados.filter((r) => r.verdict === 'dead').length,
    indeterminadas: resultados.filter((r) => r.verdict === 'unknown').length,
    porOrigem,
    estimativaMortasNoCatalogo: estimativa,
    exemplos: resultados
      .filter((r) => r.verdict === 'dead')
      .map((r) => ({ titulo: r.anime.title, estado: r.status, url: r.anime.cover_image_url })),
  };
}

/** 3. Travessões e hífenes mal formatados, coluna a coluna. */
function auditDashes(animes, episodes) {
  const colunas = [
    { nome: 'animes.title', linhas: animes, campo: 'title', rotulo: (r) => r.title },
    { nome: 'animes.description', linhas: animes, campo: 'description', rotulo: (r) => r.title },
    { nome: 'episodes.title', linhas: episodes, campo: 'title', rotulo: (r) => r.title },
    { nome: 'episodes.overview', linhas: episodes, campo: 'overview', rotulo: (r) => r.title ?? r.id },
  ];

  const porColuna = {};
  const tiposGlobais = {};
  let linhasMarcadas = 0;
  let ocorrencias = 0;

  for (const col of colunas) {
    const preenchidas = col.linhas.filter((r) => typeof r[col.campo] === 'string' && r[col.campo] !== '');
    const marcadas = [];
    const tipos = {};
    let total = 0;
    for (const linha of preenchidas) {
      const issues = findDashIssues(linha[col.campo]);
      if (issues.length === 0) continue;
      marcadas.push({ linha, issues });
      total += issues.length;
      for (const i of issues) {
        tipos[i.kind] = (tipos[i.kind] ?? 0) + 1;
        tiposGlobais[i.kind] = (tiposGlobais[i.kind] ?? 0) + 1;
      }
    }
    linhasMarcadas += marcadas.length;
    ocorrencias += total;
    porColuna[col.nome] = {
      preenchidas: preenchidas.length,
      linhasMarcadas: marcadas.length,
      ocorrencias: total,
      tipos,
      exemplos: marcadas.map((m) => ({
        titulo: col.rotulo(m.linha),
        tipo: m.issues[0].kind,
        excerto: m.issues[0].excerpt,
      })),
    };
  }

  return { linhasMarcadas, ocorrencias, tipos: tiposGlobais, porColuna };
}

/** 4. Títulos por estrear cuja temporada de estreia já passou. */
function auditStaleUpcoming(animes, now) {
  const porEstrear = animes.filter((a) => a.status === 'upcoming');
  const passados = porEstrear.filter((a) => isSeasonPast(a.year, a.season, now));
  const semAno = porEstrear.filter((a) => !Number.isInteger(a.year));
  const porAno = {};
  for (const a of passados) porAno[a.year] = (porAno[a.year] ?? 0) + 1;
  return {
    porEstrear: porEstrear.length,
    passados: passados.length,
    semAno: semAno.length,
    porAno,
    exemplos: [...passados]
      .sort((a, b) => a.year - b.year || String(a.title).localeCompare(String(b.title)))
      .map((a) => ({ titulo: a.title, ano: a.year, temporada: a.season ?? 'sem temporada' })),
  };
}

// ── Relatório em texto ───────────────────────────────────────────────────────

const TIPO_LEGENDA = {
  travessao: 'travessão a separar ideias',
  'hifen-travessao': 'hífen com espaço dos dois lados, a fazer de travessão',
  'hifen-solto': 'hífen com espaço de um lado só (composto partido)',
  'hifen-duplo': 'hífen duplo a fazer de travessão',
};

const rule = (titulo) => `\n${titulo}\n${'─'.repeat(78)}`;

function renderText(report, { examples }) {
  const L = [];
  const { sinopses: s, capas: c, capasHttp: h, hifens: d, porEstrear: u } = report;

  L.push(rule('1. SINOPSES'));
  L.push(`  sem sinopse (nula, vazia ou só marcação) : ${num(s.vazias)} de ${num(s.total)}  (${pct(s.vazias, s.total)})`);
  L.push(`  com sinopse curta demais (< ${MIN_DESCRIPTION_CHARS} caracteres) : ${num(s.curtas)}`);
  L.push('  por estado do título:');
  for (const [estado, v] of Object.entries(s.porEstado)) {
    L.push(`    ${estado.padEnd(10)} ${String(num(v.vazias)).padStart(7)} sem sinopse de ${num(v.total).padStart(7)}  (${pct(v.vazias, v.total)})`);
  }
  const noAr = s.porEstado.airing;
  if (noAr) {
    L.push(`  as que o visitante vê mesmo (no ar) : ${num(noAr.vazias)} fichas sem texto, de ${num(noAr.total)} no ar`);
  }
  for (const t of s.exemplos.slice(0, examples)) L.push(`    exemplo (no ar, sem sinopse): ${t}`);

  L.push(rule('2. CAPAS'));
  L.push(`  sem capa na base : ${num(c.semCapa)} de ${num(c.total)}  (${pct(c.semCapa, c.total)}), das quais ${num(c.semCapaNoAr)} estão no ar`);
  L.push(`  com capa na base : ${num(c.comCapa)}`);
  L.push('  origens das capas guardadas:');
  for (const [host, n] of Object.entries(c.porOrigem).sort((a, b) => b[1] - a[1])) {
    L.push(`    ${host.padEnd(28)} ${num(n).padStart(7)}`);
  }
  for (const t of c.exemplos.slice(0, examples)) L.push(`    exemplo (sem capa): ${t}`);

  if (!h) {
    L.push('  capas partidas: não verificado (--no-http)');
  } else {
    L.push(`\n  capas partidas, por verificação HTTP de ${num(h.verificadas)} capas:`);
    L.push('  As origens pequenas são verificadas por inteiro, as grandes por amostra.');
    L.push(`    respondem bem  : ${num(h.ok)}`);
    L.push(`    mortas         : ${num(h.mortas)}`);
    L.push(`    indeterminadas : ${num(h.indeterminadas)}  (tempo esgotado ou 429; não contam como mortas)`);
    L.push('    por origem:');
    for (const [host, g] of Object.entries(h.porOrigem).sort((a, b) => b[1].naBase - a[1].naBase)) {
      const estados = Object.entries(g.estados)
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${code}×${n}`)
        .join(' ');
      const taxa = g.taxaMorta === null ? 'n/d' : pct(g.mortas, g.verificadas - g.indeterminadas);
      const cobertura = g.completa ? 'todas as' : 'amostra de';
      const conta = g.completa && g.indeterminadas === 0 ? 'contadas ' : 'estimadas';
      L.push(
        `      ${host.padEnd(26)} ${cobertura.padStart(10)} ${num(g.verificadas).padStart(4)} de ${num(g.naBase).padStart(7)} na base` +
          `  mortas ${String(g.mortas).padStart(3)} (${taxa})  ${conta} ${num(g.estimativaMortas ?? 0).padStart(5)}  [${estados}]`,
      );
    }
    L.push(`    capas partidas no catálogo : ~${num(h.estimativaMortasNoCatalogo)}`);
    for (const e of h.exemplos.slice(0, examples)) {
      L.push(`      exemplo (HTTP ${e.estado}): ${e.titulo}`);
    }
  }

  L.push(rule('3. TRAVESSÕES E HÍFENES'));
  L.push('  Regra: marca-se o sinal que SEPARA ideias, não o que UNE palavras.');
  L.push('  "bem-vindo" e "guarda-chuva" passam limpos; " - " e " — " não passam.');
  L.push('  Exceções: intervalos numéricos, sinal negativo, marcador de lista ou');
  L.push('  travessão de diálogo no início da linha, réguas de três sinais ou mais,');
  L.push('  e o hífen suspenso seguido de conjunção ("pós- e pré-guerra").');
  L.push('  Nota de leitura: nas colunas de título o sinal costuma fazer parte do');
  L.push('  nome da obra, e reescrevê-lo mudava o nome. Nas colunas de texto corrido');
  L.push('  é pontuação nossa, e essa é a que se corrige.');
  L.push(`  linhas marcadas : ${num(d.linhasMarcadas)}   ocorrências : ${num(d.ocorrencias)}`);
  for (const [tipo, n] of Object.entries(d.tipos).sort((a, b) => b[1] - a[1])) {
    L.push(`    ${String(num(n)).padStart(7)}  ${TIPO_LEGENDA[tipo] ?? tipo}`);
  }
  for (const [nome, col] of Object.entries(d.porColuna)) {
    L.push(`\n    ${nome}: ${num(col.linhasMarcadas)} linhas marcadas de ${num(col.preenchidas)} preenchidas (${pct(col.linhasMarcadas, col.preenchidas)}), ${num(col.ocorrencias)} ocorrências`);
    for (const [tipo, n] of Object.entries(col.tipos).sort((a, b) => b[1] - a[1])) {
      L.push(`      ${String(num(n)).padStart(6)}  ${TIPO_LEGENDA[tipo] ?? tipo}`);
    }
    for (const e of col.exemplos.slice(0, examples)) {
      // Num título curto o excerto É o título; repeti-lo só ocupa a linha.
      const nu = e.excerto.replaceAll('…', '');
      const repetido = String(e.titulo).includes(nu) || nu.includes(String(e.titulo));
      L.push(`      exemplo [${e.tipo}] ${e.titulo}${repetido ? '' : `: ${e.excerto}`}`);
    }
  }

  L.push(rule('4. TÍTULOS POR ESTREAR COM A TEMPORADA JÁ PASSADA'));
  L.push(`  marcados "upcoming" : ${num(u.porEstrear)}`);
  L.push(`  com a temporada de estreia já vencida : ${num(u.passados)}  (${pct(u.passados, u.porEstrear)})`);
  L.push(`  sem ano nenhum (não se pode decidir)  : ${num(u.semAno)}`);
  if (Object.keys(u.porAno).length > 0) {
    L.push('  por ano de estreia:');
    for (const [ano, n] of Object.entries(u.porAno).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      L.push(`    ${ano}  ${String(num(n)).padStart(5)}`);
    }
  }
  for (const e of u.exemplos.slice(0, examples)) {
    L.push(`    exemplo: ${e.ano} ${e.temporada}, ${e.titulo}`);
  }

  L.push(rule('RESUMO'));
  L.push(`  títulos no catálogo                      : ${num(s.total)}`);
  L.push(`  sem sinopse                              : ${num(s.vazias)}  (${pct(s.vazias, s.total)})`);
  L.push(`  sem sinopse, estando no ar               : ${num(noAr?.vazias ?? 0)}  de ${num(noAr?.total ?? 0)} no ar`);
  L.push(`  sem capa                                 : ${num(c.semCapa)}  (${pct(c.semCapa, c.total)})`);
  L.push(
    h
      ? `  com capa partida                         : ~${num(h.estimativaMortasNoCatalogo)}  (${num(h.mortas)} mortas em ${num(h.verificadas)} capas verificadas)`
      : '  com capa partida                         : não verificado (--no-http)',
  );
  L.push(`  textos com travessão ou hífen a mais     : ${num(d.linhasMarcadas)} linhas, ${num(d.ocorrencias)} ocorrências`);
  L.push(`  "upcoming" com a temporada já passada    : ${num(u.passados)}`);
  L.push('');
  L.push('  Auditoria: nada foi escrito na base.');
  L.push('  Reparações vivem noutro lado: `npm run covers` e `npm run descriptions`.');
  return L.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function assertConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Faltam variáveis de ambiente: ${missing.join(', ')}.\n` +
        '→ Local: preenche-as em ingestion/.env.\n' +
        '→ CI: adiciona-as como segredos do GitHub Actions.',
    );
  }
}

async function main() {
  const options = parseArgs(process.argv);
  // Em modo --json o stdout é do relatório e de mais nada, para se poder
  // canalizar. O progresso vai por stderr, onde não estorva um `| jq`.
  const log = (msg) => (options.json ? process.stderr : process.stdout).write(`${msg}\n`);

  const startedAt = Date.now();
  log(`[nimu:audit] Auditoria de dados (só leitura) a começar…`);
  assertConfig();

  const { supabase } = await import('./supabase.js');
  const db = readOnlyClient(supabase);

  const animes = await pageAll(db, 'animes', 'id, title, status, year, season, description, cover_image_url');
  log(`[nimu:audit] catálogo lido: ${num(animes.length)} títulos`);
  const episodes = await pageAll(db, 'episodes', 'id, anime_id, title, overview');
  log(`[nimu:audit] episódios lidos: ${num(episodes.length)}`);

  const now = new Date();
  const report = {
    geradoEm: now.toISOString(),
    parametros: { amostraCapas: options.sampleSize, verificacaoHttp: options.http },
    sinopses: auditSynopses(animes),
    capas: auditMissingCovers(animes),
    capasHttp: null,
    hifens: auditDashes(animes, episodes),
    porEstrear: auditStaleUpcoming(animes, now),
  };

  if (options.http) {
    log('[nimu:audit] a verificar capas por HTTP…');
    report.capasHttp = await auditBrokenCovers(animes, {
      sampleSize: options.sampleSize,
      onProgress: (feito, total) => {
        if (feito % 24 === 0 || feito === total) log(`[nimu:audit]   capas ${feito}/${total}`);
      },
    });
  }

  const duracao = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (options.json) {
    report.duracaoSegundos = Number(duracao);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(report, options)}\n`);
    log(`\n[nimu:audit] ✅ Auditoria terminada em ${duracao}s`);
  }
}

// Corre só quando é executado diretamente, nunca quando um teste o importa —
// é o que mantém os ajudantes puros acima testáveis sem efeitos secundários.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:audit] ❌ Auditoria falhou:', error);
    process.exitCode = 1;
  });
}
