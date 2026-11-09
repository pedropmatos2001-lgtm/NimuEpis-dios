// A chave de série (fase 4 do plano "fichas por série"): escreve a tabela
// `series` e as colunas `animes.series_*` (migração 20261105000200_series.sql).
// A regra está em `series-plan.js`; aqui só se lê e se escreve.
//
//   node src/series.js                    → o mesmo que --plan
//   node src/series.js --plan             → lê a base (chave PUBLICÁVEL chega)
//                                           e o AnimeSchedule, diz o que faria,
//                                           grava o relatório; não escreve nada
//   node src/series.js --aplicar          → escreve só as séries seguras
//                                           (service role, e só com a
//                                           migração aplicada)
//   --incluir-duvidosos  (com --aplicar) escreve também as de ponte e derivado
//   --json=caminho   o relatório completo (por omissão .cache/series-plano.json)
//   --sem-cache      volta a ler o catálogo do AnimeSchedule mesmo com cache
//   --dry-run        fixture; sem rede nem base (é o que o `npm test` corre)
//
// ## O que lê, e quanto pesa na base
//
//  - `animes`: só colunas leves (id, slug, title, media_type, status, year,
//    season, mal_id, animeschedule_route, popularity e, com a migração, as
//    `series_*`), às páginas de 1000, UMA página de cada vez (~29 pedidos).
//    Os `alt_titles` (pesados) só das ~3 400 linhas candidatas, por lotes de
//    150 ids. Nada em paralelo: a base é a instância mais pequena da Supabase.
//  - `anime_route_aliases` (só a service role a lê): as rotas das franquias já
//    fundidas. Com a chave publicável fica de fora, e as fichas dessas rotas
//    caem pelo `mal_id` (que já não existe na base) e não contam.
//  - `series`, se a migração já estiver aplicada.
//  - o catálogo do AnimeSchedule, `GET /anime?page=N` (~1 080 páginas, ~12 min
//    ao ritmo partilhado de `animeschedule.js`), com cache de 7 dias em
//    `.cache/as-relacoes.json`.
//
// ## O que escreve (só com --aplicar)
//
//  - `series`: uma linha por série SEGURA com 2+ membros. As que têm uma
//    ponte (um filme ou OVA pelo meio), um membro que pode ser derivado ou
//    mais de 12 membros ficam para revisão (fichas soltas, lista em
//    `revisao.txt`), salvo `approve` em `data/series-overrides.json`. Com
//    `--incluir-duvidosos` entram as de ponte e derivado; as de mais de 12
//    membros, nunca sem `approve`;
//  - `animes.series_id/series_season/series_part/series_order`, só nas linhas
//    em que mudam, uma a uma, com uma pausa entre escritas;
//  - desliga (`series_* = null`) os membros que deixaram de pertencer. Uma
//    série que fica sem membros NÃO se apaga (o endereço dela pode já estar
//    em uso na fase 5): fica no relatório para o dono decidir.
//
// Nunca toca em listas, episódios, episódios vistos nem avisos, e nunca chama
// as funções de distribuição de avisos. Idempotente: a segunda corrida
// seguida não escreve nada.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compactAsEntry, MAX_MEMBERS, parseSeriesOverrides, planSeries } from './series-plan.js';
import { chunk, sleep } from './util.js';

const PAGE = 1000;
const IN_CHUNK = 150;
const AS_PAGE_SIZE = 18;
const AS_MAX_PAGES = 2000;
const AS_CACHE_DAYS = 7;
const AS_CACHE = new URL('../.cache/as-relacoes.json', import.meta.url);
const DEFAULT_JSON = fileURLToPath(new URL('../.cache/series-plano.json', import.meta.url));
const OVERRIDES_FILE = new URL('../data/series-overrides.json', import.meta.url);
/** Uma escrita de cada vez, e esta pausa entre elas (a base é pequena). */
const WRITE_PAUSE_MS = 40;
/** Uma corrida que queira mudar mais linhas do que isto pára sem escrever. */
const MAX_ROW_UPDATES = 8000;

const log = (msg) => console.log(`[nimu:series] ${msg}`);

export function loadSeriesOverrides(file = OVERRIDES_FILE) {
  return parseSeriesOverrides(JSON.parse(readFileSync(file, 'utf8')));
}

export function parseArgs(argv) {
  const apply = argv.includes('--aplicar') || argv.includes('--apply');
  return {
    apply,
    plan: !apply,
    dryRun: argv.includes('--dry-run'),
    noCache: argv.includes('--sem-cache'),
    json: argv.find((a) => a.startsWith('--json='))?.slice('--json='.length) || DEFAULT_JSON,
    // Desligado por omissão (decisão do dono, 2026-11-05): só as seguras.
    includeDoubtful: argv.includes('--incluir-duvidosos'),
  };
}

// ── AnimeSchedule ────────────────────────────────────────────────────────────

function readAsCache(now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(AS_CACHE, 'utf8'));
    const age = now - Date.parse(raw?.em ?? '');
    if (!Array.isArray(raw?.fichas) || !(age >= 0 && age < AS_CACHE_DAYS * 86400000) || raw.completo !== true) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * O catálogo inteiro do AnimeSchedule, compacto. `completo` é falso se uma
 * página falhou depois das tentativas: o plano diz, e `--aplicar` recusa (uma
 * página em falta pode partir uma série em duas).
 */
export async function loadAsRelations(fetchPage, { noCache = false } = {}) {
  if (!noCache) {
    const cached = readAsCache();
    if (cached) {
      log(`AnimeSchedule: ${cached.fichas.length} fichas da cache (${cached.em})`);
      return { entries: cached.fichas, complete: true, failedPages: [], total: cached.total, cache: true };
    }
  }
  const entries = [];
  const failedPages = [];
  let total = Infinity;
  for (let page = 1; (page - 1) * AS_PAGE_SIZE < total && page <= AS_MAX_PAGES; page += 1) {
    let res;
    try {
      res = await fetchPage({ page });
    } catch (error) {
      failedPages.push(page);
      log(`⚠ AnimeSchedule página ${page}: ${error.message}`);
      if (failedPages.length > 20) break;
      continue;
    }
    total = res.totalAmount || total;
    if (res.anime.length === 0) break;
    for (const e of res.anime) entries.push(compactAsEntry(e));
    if (page % 100 === 0) log(`AnimeSchedule: página ${page} (${entries.length} fichas de ${total})`);
  }
  const complete = failedPages.length === 0 && Number.isFinite(total) && entries.length >= total - AS_PAGE_SIZE;
  if (complete) {
    try {
      mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
      writeFileSync(AS_CACHE, JSON.stringify({ em: new Date().toISOString(), total, completo: true, fichas: entries }));
    } catch (error) {
      log(`⚠ não consegui gravar a cache do AnimeSchedule: ${error.message}`);
    }
  }
  log(`AnimeSchedule: ${entries.length} fichas lidas (total da API ${total})${complete ? '' : `, INCOMPLETO (páginas em falta: ${failedPages.join(', ')})`}`);
  return { entries, complete, failedPages, total, cache: false };
}

// ── Base ─────────────────────────────────────────────────────────────────────

const BASE_COLUMNS = 'id, slug, title, media_type, status, year, season, mal_id, animeschedule_route, popularity';
const SERIES_COLUMNS = 'series_id, series_season, series_part, series_order';

/** A migração está aplicada? (a coluna `series_id` e a tabela `series` existem). */
export async function hasSeriesSchema(supabase) {
  const col = await supabase.from('animes').select('series_id').limit(1);
  if (col.error) return false;
  const tab = await supabase.from('series').select('id').limit(1);
  return !tab.error;
}

async function readPages(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

async function readRows(supabase, withSeries) {
  const cols = withSeries ? `${BASE_COLUMNS}, ${SERIES_COLUMNS}` : BASE_COLUMNS;
  return readPages(() => supabase.from('animes').select(cols).order('id'));
}

async function readAltTitles(supabase, ids) {
  const out = new Map();
  for (const lote of chunk(ids, IN_CHUNK)) {
    const { data, error } = await supabase.from('animes').select('id, alt_titles').in('id', lote);
    if (error) throw new Error(`alt_titles: ${error.message}`);
    for (const r of data) out.set(r.id, r.alt_titles ?? []);
  }
  return out;
}

/** `anime_route_aliases` (só a service role): Map rota → anime_id, ou null. */
async function readAliases(supabase) {
  try {
    const rows = await readPages(() => supabase.from('anime_route_aliases').select('animeschedule_route, anime_id').order('animeschedule_route'));
    return new Map(rows.map((r) => [r.animeschedule_route, r.anime_id]));
  } catch {
    return null;
  }
}

// ── Relatório ────────────────────────────────────────────────────────────────

function seasonLabel(m) {
  return `T${m.season}${m.part ? ` P${m.part}` : ''}`;
}

/** A lista das séries para revisão (o `revisao.txt` ao lado do relatório), por popularidade. */
export function formatReviewList(plan) {
  const lines = [
    `# Séries para revisão: ${plan.stats.paraRevisao} (${plan.stats.membrosParaRevisao} linhas)`,
    '# Não se escrevem por omissão (ficam fichas soltas). Para escrever uma: `approve` em ingestion/data/series-overrides.json;',
    '# para a partir: `cut` ou `split`. Todas de uma vez: --aplicar --incluir-duvidosos (as de > 12 membros continuam a precisar de approve).',
    '',
  ];
  for (const x of plan.series.filter((y) => y.review)) {
    lines.push(`- ${x.title} → /anime/${x.slug}, ${x.popularity} seguidores [${x.reviewReasons.join(', ')}] (${x.key})`);
    for (const m of x.members) lines.push(`    ${m.order}. ${seasonLabel(m)} ${m.shown} [${m.slug}] ${m.premiere ?? m.year ?? 's/ data'}`);
    for (const d of x.doubts) {
      if (d.tipo === 'ponte') lines.push(`    ? ponte: ${d.de} → ${d.por.join(' → ')} → ${d.para}`);
      else lines.push(`    ? ${d.tipo}: ${d.titulo ?? (d.membros ?? []).join(' / ')}`);
    }
  }
  return lines.join('\n');
}

/** O resumo para o log e para o `resumo.txt` da auditoria: números e as 50 mais seguidas. */
export function formatSummary(plan, { top = 50 } = {}) {
  const lines = [];
  const s = plan.stats;
  lines.push(
    `séries a escrever (as seguras, o que o --aplicar escreve por omissão): ${s.series} (${s.membros} linhas)`,
    `para revisão (ficam fichas soltas; lista em revisao.txt): ${s.paraRevisao} (${s.membrosParaRevisao} linhas); por motivo: ${JSON.stringify(s.revisaoPorMotivo)}`,
    `sinalizadas (> ${MAX_MEMBERS} membros, nem com --incluir-duvidosos sem aprovação): ${s.sinalizadas} (${s.membrosSinalizados} linhas)`,
    `fichas do AnimeSchedule: ${s.fichasAnimeSchedule}; nós de série (TV/ONA/TV Short): ${s.nosDeSerie}; componentes com relação: ${s.componentesComRelacao}`,
    `componentes que dão uma só linha (franquias já fundidas ou membros fora da base): ${s.componentesDeUmaLinha}; fichas sem linha na base: ${s.fichasSemLinha}; linhas fora do formato: ${s.linhasForaDoFormato}; fichas na mesma linha (fold): ${s.fichasNaMesmaLinha}`,
    `endereços: ${s.herdamSlug} séries herdam o endereço de um membro (esse membro passa a 308 na fase 5); ${s.slugsComSufixo} com sufixo por colisão`,
  );
  const doubts = {};
  for (const x of plan.series) for (const d of x.doubts) doubts[d.tipo] = (doubts[d.tipo] ?? 0) + 1;
  lines.push(`dúvidas: ${JSON.stringify(doubts)}`);
  lines.push('', `## As ${top} mais seguidas`);
  for (const x of plan.series.filter((y) => !y.flagged).slice(0, top)) {
    const extra = [x.inheritsSlugFrom ? `herda ${x.inheritsSlugFrom}` : null, x.slugCollidedWith ? `colide com ${x.slugCollidedWith}` : null]
      .filter(Boolean)
      .join('; ');
    const mark = x.review ? ` [REVISÃO: ${x.reviewReasons.join(', ')}]` : '';
    lines.push(`- ${x.title} → /anime/${x.slug}${extra ? ` (${extra})` : ''}, ${x.popularity} seguidores${mark}`);
    for (const m of x.members) lines.push(`    ${m.order}. ${seasonLabel(m)} ${m.shown} [${m.slug}] ${m.premiere ?? m.year ?? 's/ data'} (${m.seasonFrom})`);
    for (const d of x.doubts) lines.push(`    ? ${d.tipo}: ${d.titulo ?? (d.membros ?? []).join(' / ') ?? ''}${d.por ? `${d.de} → ${d.por.join(' → ')} → ${d.para}` : ''}`);
  }
  lines.push('', '## Sinalizadas (não se escrevem sem aprovação)');
  for (const x of plan.series.filter((y) => y.flagged)) {
    lines.push(`- ${x.title}: ${x.members.length} membros: ${x.members.slice(0, 8).map((m) => m.shown).join(' | ')}${x.members.length > 8 ? ' | …' : ''}`);
  }
  lines.push('', '## Endereços com sufixo (o natural já era de outro)');
  for (const x of plan.series.filter((y) => y.slugCollidedWith)) lines.push(`- ${x.slug} (natural ${x.slugNatural}, de ${x.slugCollidedWith})`);
  return lines.join('\n');
}

// ── Escrita ──────────────────────────────────────────────────────────────────

function rowMismatch(row, want) {
  return (
    (row.series_id ?? null) !== (want.series_id ?? null) ||
    (row.series_season ?? null) !== (want.series_season ?? null) ||
    (row.series_part ?? null) !== (want.series_part ?? null) ||
    (row.series_order ?? null) !== (want.series_order ?? null)
  );
}

export async function applyPlan(supabase, plan, rows, { pauseMs = WRITE_PAUSE_MS, includeDoubtful = false } = {}) {
  const { data: existing, error } = await supabase.from('series').select('id, key, slug, title, source');
  if (error) throw new Error(`leitura de series: ${error.message}`);
  const byKey = new Map(existing.map((s) => [s.key, s]));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // Só as seguras, salvo --incluir-duvidosos; as de mais de 12 membros só
  // com `approve`, sempre.
  const toWrite = plan.series.filter((s) => !s.flagged && (!s.review || includeDoubtful));
  const written = new Set(toWrite.map((s) => s.key));
  const desired = new Map(); // anime id → colunas
  const stats = { seriesNovas: 0, seriesAtualizadas: 0, linhas: 0, desligadas: 0, slugs: 0, seriesSemMembros: [] };
  const plannedIds = new Set();

  for (const s of toWrite) {
    // A série que já existe: pela chave; senão a de mais membros já ligados
    // (a chave muda se aparecer uma temporada anterior à primeira).
    let current = byKey.get(s.key);
    if (!current) {
      const counts = new Map();
      for (const m of s.members) {
        const sid = rowById.get(m.id)?.series_id;
        if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
      }
      const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      current = best ? existing.find((e) => e.id === best && !plannedIds.has(e.id)) : undefined;
    }
    if (current) {
      const patch = {};
      if (current.key !== s.key) patch.key = s.key;
      if (current.title !== s.title) patch.title = s.title;
      if (current.source !== s.source) patch.source = s.source;
      if (Object.keys(patch).length > 0) {
        const { error: e } = await supabase.from('series').update(patch).eq('id', current.id);
        if (e) throw new Error(`series ${s.key}: ${e.message}`);
        stats.seriesAtualizadas += 1;
        await sleep(pauseMs);
      }
    } else {
      // O endereço entra DEPOIS de os membros estarem ligados: a guarda da
      // base deixa a série herdar o endereço de um membro, mas só de um dela.
      const { data, error: e } = await supabase.from('series').insert({ key: s.key, title: s.title, source: s.source, slug: null }).select('id, key, slug, title, source').single();
      if (e) throw new Error(`series ${s.key}: ${e.message}`);
      current = data;
      stats.seriesNovas += 1;
      await sleep(pauseMs);
    }
    plannedIds.add(current.id);
    s.id = current.id;
    s.currentSlug = current.slug ?? null;
    for (const m of s.members) {
      desired.set(m.id, { series_id: current.id, series_season: m.season, series_part: m.part ?? null, series_order: m.order });
    }
  }

  const updates = [];
  for (const [id, want] of desired) if (rowMismatch(rowById.get(id) ?? {}, want)) updates.push([id, want]);
  // Desligar: estava numa série desta ingestão e já não está em nenhuma. Os
  // membros de uma série que não se escreve nesta corrida (para revisão, ou
  // sinalizada) ficam como estão até o dono a rever: desligá-los partia uma
  // série que já existe.
  const ours = new Set(existing.filter((e) => e.source === 'animeschedule' || e.source === 'override').map((e) => e.id));
  const onHold = new Set(plan.series.filter((x) => !written.has(x.key)).flatMap((x) => x.members.map((m) => m.id)));
  for (const r of rows) {
    if (r.series_id && ours.has(r.series_id) && !desired.has(r.id) && !onHold.has(r.id)) {
      updates.push([r.id, { series_id: null, series_season: null, series_part: null, series_order: null }]);
    }
  }
  if (updates.length > MAX_ROW_UPDATES) {
    throw new Error(`${updates.length} linhas a mudar é mais do que o teto (${MAX_ROW_UPDATES}). Ver com --plan.`);
  }
  for (const [id, want] of updates) {
    const { error: e } = await supabase.from('animes').update(want).eq('id', id);
    if (e) throw new Error(`animes ${id}: ${e.message}`);
    if (want.series_id === null) stats.desligadas += 1;
    else stats.linhas += 1;
    await sleep(pauseMs);
  }

  // Os endereços que faltam, agora que os membros estão ligados.
  for (const s of toWrite) {
    if (s.currentSlug || !s.slug) continue;
    let candidate = s.slug;
    for (let n = 2; n < 50; n += 1) {
      const { error: e } = await supabase.from('series').update({ slug: candidate }).eq('id', s.id);
      if (!e) {
        stats.slugs += 1;
        break;
      }
      // 23505 (outra série tem-no) ou a guarda (um anime que não é membro):
      // o sufixo seguinte, como a `anime_set_slug`.
      log(`endereço ${candidate} recusado (${e.code ?? e.message}); a tentar o seguinte`);
      candidate = `${s.slugNatural ?? s.slug}-${n}`;
    }
    await sleep(pauseMs);
  }

  // As séries desta ingestão que ficaram sem membros NÃO se apagam: na fase 5
  // o endereço delas pode já estar no Google. Ficam contadas, para o dono.
  const stillUsed = new Set([...desired.values()].map((d) => d.series_id));
  for (const r of rows) if (r.series_id && onHold.has(r.id)) stillUsed.add(r.series_id);
  stats.seriesSemMembros = existing.filter((e) => ours.has(e.id) && !stillUsed.has(e.id)).map((e) => e.key);
  return stats;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function writeReport(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 1));
  log(`relatório em ${file}`);
}

async function dryRun(args) {
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/series-reais.json', import.meta.url), 'utf8'));
  const plan = planSeries({ asEntries: fixture.animeschedule, rows: fixture.rows, overrides: loadSeriesOverrides() });
  log(`DRY RUN (fixture, sem rede nem base): ${plan.stats.series} séries, ${plan.stats.membros} linhas`);
  if (args.json !== DEFAULT_JSON) writeReport(args.json, plan);
  log('✅ DRY RUN: nada escrito');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.dryRun) return dryRun(args);
  const startedAt = Date.now();
  const { config, USER_AGENT } = await import('./config.js');
  // Com --plan chega a chave publicável; --aplicar pede a service role.
  // Só os NOMES das variáveis vão para o log, nunca os valores.
  const key = args.apply ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !config.supabaseUrl && 'SUPABASE_URL',
    !key && (args.apply ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_ANON_KEY (ou SUPABASE_SERVICE_ROLE_KEY)'),
    !config.animescheduleToken && 'ANIMESCHEDULE_TOKEN',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Faltam variáveis: ${missing.join(', ')}.`);
  const { createClient } = await import('@supabase/supabase-js');
  const gate = process.env.NIMU_DB_GATE;
  const supabase = createClient(config.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'User-Agent': USER_AGENT, ...(gate && !args.apply ? { 'x-nimu-gate': gate } : {}) } },
  });
  log(args.apply ? 'A ESCREVER (service role)' : 'PLANO: só leituras, nada se escreve');

  const withSeries = await hasSeriesSchema(supabase);
  log(withSeries ? 'migração das séries: aplicada' : 'migração das séries: AINDA NÃO aplicada (o plano corre na mesma)');
  if (args.apply && !withSeries) throw new Error('Falta a migração 20261105000200_series.sql. Nada escrito.');

  const { fetchAnimeCataloguePage } = await import('./animeschedule.js');
  const as = await loadAsRelations(fetchAnimeCataloguePage, { noCache: args.noCache });
  if (args.apply && !as.complete) throw new Error('O catálogo do AnimeSchedule veio incompleto. Nada escrito.');

  const rows = await readRows(supabase, withSeries);
  const aliases = await readAliases(supabase);
  log(`base: ${rows.length} linhas; aliases das franquias fundidas: ${aliases ? aliases.size : 'não legíveis com esta chave'}`);
  let existingSeries = [];
  if (withSeries) {
    const { data, error } = await supabase.from('series').select('id, key, slug, title, source');
    if (error) throw new Error(`leitura de series: ${error.message}`);
    existingSeries = data;
  }
  const overrides = loadSeriesOverrides();

  // Primeiro sem os nomes alternativos, para saber que linhas são candidatas;
  // depois só essas com eles (é o nome comercial, `displayTitle`, que os usa).
  const first = planSeries({ asEntries: as.entries, rows, aliases, overrides });
  const candidateIds = [...new Set(first.series.flatMap((s) => s.members.map((m) => m.id)))];
  const alt = await readAltTitles(supabase, candidateIds);
  for (const r of rows) if (alt.has(r.id)) r.alt_titles = alt.get(r.id);
  // Os endereços de séries que JÁ existem contam como ocupados; a própria
  // série (pela chave) guarda o seu.
  const plan = planSeries({ asEntries: as.entries, rows, aliases, overrides, existingSeries });
  console.log(formatSummary(plan));
  const reviewFile = `${dirname(args.json)}/revisao.txt`;
  mkdirSync(dirname(reviewFile), { recursive: true });
  writeFileSync(reviewFile, `${formatReviewList(plan)}\n`);
  log(`lista para revisão em ${reviewFile}`);
  if (args.apply) log(args.includeDoubtful ? 'a escrever também as séries para revisão (--incluir-duvidosos)' : `a escrever só as seguras (${plan.stats.series}); ${plan.stats.paraRevisao} ficam para revisão`);
  writeReport(args.json, {
    geradoEm: new Date().toISOString(),
    modo: args.apply ? 'aplicar' : 'plano',
    migracaoAplicada: withSeries,
    animeschedule: { fichas: as.entries.length, total: as.total, completo: as.complete, paginasEmFalta: as.failedPages, daCache: as.cache },
    aliasesLidos: aliases ? aliases.size : null,
    ...plan,
  });

  if (!args.apply) {
    log(`PLANO: nada escrito (${((Date.now() - startedAt) / 1000).toFixed(0)} s)`);
    return plan;
  }
  const stats = await applyPlan(supabase, plan, rows, { includeDoubtful: args.includeDoubtful });
  log(`✅ ${JSON.stringify(stats)} em ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
  return plan;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:series] ❌ falhou:', error?.message ?? error);
    process.exitCode = 1;
  });
}
