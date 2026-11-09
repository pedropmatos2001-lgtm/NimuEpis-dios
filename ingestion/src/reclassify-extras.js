// Passagem pelo catálogo inteiro: marca os videoclipes como `media_type =
// 'Music'` e os PV/CM/teasers/trailers como `'PV'` (regra em extras.js).
//
//   node src/reclassify-extras.js            → escreve só o que muda
//   node src/reclassify-extras.js --plan     → lê a base e as fontes A SÉRIO e
//                                              diz o que faria; não escreve nada
//   node src/reclassify-extras.js --dry-run  → fixture; sem rede, sem Supabase
//   --json=caminho   (com --plan) grava o relatório completo nesse ficheiro
//   --sem-animeschedule  não pergunta ao AnimeSchedule (só manami e título)
//
// ## Porque corre em cada ingestão, e não uma vez à mão
//
// É a "passagem única" pelas linhas que já existem, mas idempotente: depois de
// a primeira corrida escrever (~5 000 linhas), as seguintes leem as 29 páginas
// do catálogo, não encontram nada para mudar e saem. Assim ninguém tem de se
// lembrar de a correr, e uma linha nova do manami que entre como `Special` é
// apanhada na corrida a seguir.
//
// ## O que lê
//
//  - `animes` (id, mal_id, title, media_type, animeschedule_route, popularity),
//    às páginas de 1000. Com `--plan` basta a chave PUBLICÁVEL
//    (SUPABASE_ANON_KEY): o catálogo é público pela RLS.
//  - o manami (a mesma cache semanal da ingestão);
//  - o AnimeSchedule: só as fichas "Music" (`/anime?media-types=music`, ~140 páginas),
//    guardadas em `.cache/` uma semana. O filtro é VERIFICADO: se a API o
//    ignorar (devolve fichas que não são Music), esta fonte fica de fora nesta
//    corrida e as outras regras continuam. Nada se desfaz por isso.
//
// ## O que escreve
//
// Só `animes.media_type`, e só nas linhas em que o valor muda. Nunca apaga
// linhas (levavam consigo listas e episódios vistos de alguém).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isExtraMediaType, loadOverrides, planReclassification } from './extras.js';
import { chunk } from './util.js';

const PLAN = process.argv.includes('--plan');
const DRY_RUN = process.argv.includes('--dry-run');
const SEM_AS = process.argv.includes('--sem-animeschedule');
const JSON_OUT = process.argv.find((a) => a.startsWith('--json='))?.slice('--json='.length) ?? null;

const PAGE = 1000;
const IN_CHUNK = 150;
/** Uma corrida que queira mudar mais do que isto não é esta regra: pára. */
const MAX_UPDATES = 8000;
/** Teto de páginas do AnimeSchedule (as ~2 530 fichas Music são ~141). */
const MAX_AS_PAGES = 250;
const AS_CACHE_DAYS = 7;
const AS_CACHE = new URL('../.cache/animeschedule-music.json', import.meta.url);
/**
 * As formas do filtro que se tentam, por ordem. A primeira que se confirma ganha.
 * Medido a 2026-11-04 no runner: `media-types=music` devolve as 2 530 fichas
 * Music em 141 páginas; `mt=` é ignorado (vem o catálogo inteiro, 19 498).
 */
const AS_FILTERS = ['media-types=music', 'mt=music'];

const log = (msg) => console.log(`[nimu:extras] ${msg}`);

// ── Fontes ───────────────────────────────────────────────────────────────────

/** `true` se a ficha do AnimeSchedule se diz "Music". */
export function isAsMusic(entry) {
  return (entry?.mediaTypes ?? []).some((m) => String(m?.name ?? m).toLowerCase() === 'music');
}

/**
 * Os mal_ids das fichas "Music" do AnimeSchedule, ou `null` se não se conseguiu
 * saber nesta corrida. `fetchPage({ page, query })` é o `fetchAnimeCataloguePage`.
 */
export async function fetchAsMusicMal(fetchPage, extractMal, { filters = AS_FILTERS, maxPages = MAX_AS_PAGES } = {}) {
  for (const query of filters) {
    let first;
    try {
      first = await fetchPage({ page: 1, query });
    } catch (error) {
      log(`AnimeSchedule (${query}): ${error.message}`);
      continue;
    }
    const anime = first.anime ?? [];
    // O filtro só vale se TODAS as fichas da 1.ª página forem Music, e se o total
    // for o de uma fatia (o catálogo inteiro são ~19 500).
    if (anime.length === 0 || !anime.every(isAsMusic) || first.totalAmount > 6000) {
      log(`AnimeSchedule (${query}): o filtro não se confirmou (${anime.length} fichas, total ${first.totalAmount})`);
      continue;
    }
    const mal = new Set();
    let total = first.totalAmount;
    let lidas = 0;
    let page = 1;
    let res = first;
    for (;;) {
      for (const entry of res.anime ?? []) {
        if (!isAsMusic(entry)) continue;
        lidas += 1;
        const id = extractMal(entry?.websites);
        if (Number.isInteger(id)) mal.add(id);
      }
      if ((res.anime ?? []).length === 0 || page * 18 >= total || page >= maxPages) break;
      page += 1;
      try {
        res = await fetchPage({ page, query });
      } catch (error) {
        // A meio: o que já se leu é verdade, mas está incompleto. Não se guarda
        // em cache, e usa-se só nesta corrida.
        log(`AnimeSchedule (${query}) parou na página ${page}: ${error.message}`);
        return { mal, query, complete: false, pages: page - 1, total, lidas };
      }
      total = res.totalAmount || total;
    }
    return { mal, query, complete: true, pages: page, total, lidas };
  }
  return null;
}

function readAsCache(now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(AS_CACHE, 'utf8'));
    const age = now - Date.parse(raw?.em ?? '');
    if (!Array.isArray(raw?.mal) || !(age >= 0 && age < AS_CACHE_DAYS * 86400000)) return null;
    return { mal: new Set(raw.mal.map(Number)), query: raw.query, complete: true, cache: true, total: raw.total };
  } catch {
    return null;
  }
}

function writeAsCache(result) {
  try {
    mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
    writeFileSync(
      AS_CACHE,
      JSON.stringify({ em: new Date().toISOString(), query: result.query, total: result.total, mal: [...result.mal] }),
    );
  } catch (error) {
    log(`⚠ não consegui gravar a cache do AnimeSchedule: ${error.message}`);
  }
}

/** mal_id → entrada do manami (a primeira ganha, como em alt-titles.js). */
export function manamiByMalIndex(entries) {
  const byMal = new Map();
  for (const entry of entries ?? []) {
    for (const source of entry?.sources ?? []) {
      const m = typeof source === 'string' ? source.match(/myanimelist\.net\/anime\/(\d+)/i) : null;
      if (m && !byMal.has(Number(m[1]))) byMal.set(Number(m[1]), entry);
    }
  }
  return byMal;
}

async function readAllRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, title, media_type, animeschedule_route, popularity')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leitura de animes: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

// ── Relatório ────────────────────────────────────────────────────────────────

/** Contagens e exemplos de um plano, para o log e para o `--json`. */
export function summarize(rows, updates) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const contagem = {};
  const deTipo = {};
  for (const u of updates) {
    const k = `${u.media_type ?? 'null'} (${u.why})`;
    contagem[k] = (contagem[k] ?? 0) + 1;
    deTipo[u.from ?? 'null'] = (deTipo[u.from ?? 'null'] ?? 0) + 1;
  }
  const exemplos = {};
  for (const u of updates) {
    const k = `${u.media_type} (${u.why})`;
    (exemplos[k] ??= []);
    if (exemplos[k].length < 25) exemplos[k].push(byId.get(u.id)?.title ?? u.id);
  }
  const antes = rows.filter((r) => isExtraMediaType(r.media_type)).length;
  const visiveis = updates
    .map((u) => byId.get(u.id))
    .filter((r) => r && (r.popularity != null || r.animeschedule_route))
    .map((r) => r.title);
  return {
    linhas: rows.length,
    jaMarcadasAntes: antes,
    aMudar: updates.length,
    depois: antes + updates.filter((u) => isExtraMediaType(u.media_type)).length -
      updates.filter((u) => !isExtraMediaType(u.media_type)).length,
    porRegra: contagem,
    vindasDe: deTipo,
    comSeguidoresOuRota: visiveis,
    exemplos,
  };
}

// ── Escrita ──────────────────────────────────────────────────────────────────

async function applyUpdates(supabase, updates) {
  const porValor = new Map();
  for (const u of updates) {
    const k = u.media_type ?? '\0null';
    porValor.set(k, [...(porValor.get(k) ?? []), u.id]);
  }
  let escritas = 0;
  for (const [valor, ids] of porValor) {
    const media_type = valor === '\0null' ? null : valor;
    for (const lote of chunk(ids, IN_CHUNK)) {
      const { error } = await supabase.from('animes').update({ media_type }).in('id', lote);
      if (error) throw new Error(`escrita de media_type: ${error.message}`);
      escritas += lote.length;
    }
  }
  return escritas;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function dryRun() {
  const fixture = JSON.parse(
    readFileSync(new URL('../test/fixtures/extras-reais.json', import.meta.url), 'utf8'),
  );
  const rows = fixture.map((f, i) => ({ id: `fx-${i}`, ...f.row }));
  const manamiByMal = new Map(fixture.map((f) => [f.row.mal_id, f.manami]));
  const asMusicMal = new Set(
    fixture.filter((f) => (f.animeschedule ?? []).includes('Music')).map((f) => f.row.mal_id),
  );
  const updates = planReclassification(rows, { manamiByMal, asMusicMal, overrides: loadOverrides() });
  const resumo = summarize(rows, updates);
  log(`DRY RUN (fixture, sem rede nem base): ${rows.length} linhas, ${updates.length} a mudar`);
  log(`por regra: ${JSON.stringify(resumo.porRegra)}`);
  log('✅ DRY RUN: nada escrito');
}

async function main() {
  if (DRY_RUN) return dryRun();
  const startedAt = Date.now();
  const { config } = await import('./config.js');

  // Com --plan chega a chave publicável; sem --plan é precisa a service role.
  // Só os NOMES das variáveis vão para o log, nunca os valores.
  const key = PLAN
    ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !config.supabaseUrl && 'SUPABASE_URL',
    !key && (PLAN ? 'SUPABASE_ANON_KEY (ou SUPABASE_SERVICE_ROLE_KEY)' : 'SUPABASE_SERVICE_ROLE_KEY'),
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Faltam variáveis: ${missing.join(', ')}.`);
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(config.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { loadManamiDatabase } = await import('./manami.js');
  const manamiByMal = manamiByMalIndex(await loadManamiDatabase());
  log(`manami: ${manamiByMal.size} mal_ids`);

  let asMusic = null;
  if (SEM_AS) {
    log('AnimeSchedule: desligado (--sem-animeschedule)');
  } else if (!config.animescheduleToken) {
    log('AnimeSchedule: sem ANIMESCHEDULE_TOKEN, fica de fora nesta corrida');
  } else {
    asMusic = readAsCache();
    if (asMusic) {
      log(`AnimeSchedule: ${asMusic.mal.size} fichas Music da cache (${asMusic.query})`);
    } else {
      const { fetchAnimeCataloguePage } = await import('./animeschedule.js');
      const { extractExternalIds } = await import('./mappers.js');
      asMusic = await fetchAsMusicMal(fetchAnimeCataloguePage, (w) => extractExternalIds(w).mal);
      if (asMusic) {
        log(
          `AnimeSchedule (${asMusic.query}): ${asMusic.lidas} fichas Music em ${asMusic.pages} páginas ` +
            `(total da API ${asMusic.total}), ${asMusic.mal.size} com mal_id${asMusic.complete ? '' : ', INCOMPLETO'}`,
        );
        if (asMusic.complete) writeAsCache(asMusic);
      } else {
        log('AnimeSchedule: nenhuma forma do filtro se confirmou; fica de fora nesta corrida');
      }
    }
  }

  const rows = await readAllRows(supabase);
  const updates = planReclassification(rows, {
    manamiByMal,
    asMusicMal: asMusic?.mal ?? null,
    overrides: loadOverrides(),
  });
  const resumo = summarize(rows, updates);
  log(`${rows.length} linhas lidas; já marcadas ${resumo.jaMarcadasAntes}; a mudar ${updates.length}; depois ${resumo.depois}`);
  log(`por regra: ${JSON.stringify(resumo.porRegra)}`);
  log(`formato de origem: ${JSON.stringify(resumo.vindasDe)}`);
  log(`com seguidores ou rota do AnimeSchedule: ${resumo.comSeguidoresOuRota.length} ${JSON.stringify(resumo.comSeguidoresOuRota.slice(0, 20))}`);
  for (const [regra, titulos] of Object.entries(resumo.exemplos)) {
    log(`ex. ${regra}: ${titulos.slice(0, 12).join(' | ')}`);
  }

  if (PLAN) {
    if (JSON_OUT) {
      const titleOf = new Map(rows.map((r) => [r.id, r.title]));
      writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            ...resumo,
            animeschedule: asMusic
              ? { query: asMusic.query, fichasMusic: asMusic.mal.size, completo: asMusic.complete, total: asMusic.total }
              : null,
            alteracoes: updates.map((u) => ({ ...u, title: titleOf.get(u.id) })),
          },
          null,
          1,
        ),
      );
      log(`relatório em ${JSON_OUT}`);
    }
    log('PLAN: nada escrito');
    return;
  }

  if (updates.length > MAX_UPDATES) {
    throw new Error(`${updates.length} linhas a mudar é mais do que o teto (${MAX_UPDATES}). Nada escrito; ver com --plan.`);
  }
  const escritas = await applyUpdates(supabase, updates);
  log(`✅ ${escritas} linhas atualizadas em ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:extras] ❌ falhou:', error?.message ?? error);
    process.exitCode = 1;
  });
}
