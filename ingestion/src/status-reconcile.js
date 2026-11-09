// Acerta `animes.status` com o que os EPISÓDIOS dizem.
//
//   node src/status-reconcile.js             → corrige (service role)
//   node src/status-reconcile.js --dry-run   → só diz o que mudaria; não escreve
//
// Corre também no fim de cada ingestão (run.js), por isso não é uma correção
// de uma vez: a base fica certa a cada seis horas, e uma série que acaba deixa
// de dizer "No ar" na primeira corrida a seguir.
//
// ## Porque existe (2026-11-04)
//
// O dono: "One Piece, Mushoku Tensei, Slime... nenhum está no ar!". Medido
// nesse dia (só leituras, ramo auditoria/estado-no-ar-2026-11-04): das 317
// séries `airing`, 131 tinham um episódio nas três semanas à volta de hoje.
//
//  - Slime e Mushoku Tensei são fichas de FRANQUIA (as temporadas dobradas na
//    ficha da 1.ª, ver catalogue-franchises.js). Quando a temporada nova estava
//    a dar, a correção pelo horário (`statusCorrections`, que só promovia a
//    "airing") pô-las no ar. A temporada acabou (o 96.º do Slime a 2026-09-25,
//    o 63.º do Mushoku a 2026-09-27) e nada as voltava a terminar: a ficha da
//    franquia não tem rota própria no horário, por isso nenhuma corrida a
//    voltava a ler.
//  - One Piece: o 1180 a 2026-09-27, e a fonte diz que o 1181 e os seguintes
//    voltam em abril de 2027. Em pausa, não no ar.
//
// A regra é a de `web/lib/status/live-status.mjs`, a MESMA que a web usa para
// mostrar o estado. Importada daqui, não copiada: se mudar, muda nos dois.
//
// ## O que pode mudar (`statusToStore`)
//
//  - `airing` → `finished`: nada saiu nas últimas três semanas, nada tem data
//    à frente, não há episódios por datar depois do último, a fonte não deu
//    nota de horário, E o último que saiu chegou ao total conhecido da
//    temporada (o do TVDB). É o fim da temporada (Slime, Mushoku);
//  - `airing` → `hiatus`: parada sem isso tudo. Com nota da fonte, com
//    episódios por datar, com o próximo para lá das três semanas (o One
//    Piece), ou sem total conhecido (o Hanakappa, o Chibi Godzilla 3);
//  - `hiatus` → `airing`, `finished` → `airing`, `upcoming` → `airing`: quando
//    volta a haver episódios na janela. Uma terminada só com um episódio
//    DATADO à frente: episódios sem data não a desmentem (o BLEACH TYBW "The
//    Calamity", 2026-11-04, ver "Episódios sem data" na regra).
//
// Uma série sem UM episódio datado não é tocada: não há prova de nada. Cada
// escrita leva o estado antigo no filtro (`.eq('status', de)`), para não pisar
// uma mudança feita entretanto por outro passo. Idempotente: uma segunda
// corrida não encontra nada para mudar.
import { pathToFileURL } from 'node:url';

import {
  LIVE_WINDOW_DAYS,
  factsFor,
  needsProbe,
  needsTotal,
  statusToStore,
  windowByAnime,
} from '../../web/lib/status/live-status.mjs';
import { chunk } from './util.js';

const DAY_MS = 86_400_000;
const PAGE = 1000;
const IN_LIST_CHUNK = 150;
const PROBE_CONCURRENCY = 6;

// Os testes chegam a estas pelas mesmas portas.
export { factsFor, needsProbe, windowByAnime };

/**
 * As mudanças a gravar. Puro: recebe as fichas, a janela e as sondagens.
 *
 * @param {{ id: string, title?: string, status: string | null, schedule_note?: string | null }[]} animes
 * @param {Map<string, { aired: boolean, nextAiringAt: string | null }>} windows
 * @param {Map<string, { airedEver: boolean, nextAiringAt: string | null, episodesPending: boolean }>} probes
 * @param {Date} now
 */
export function planStatusChanges(animes, windows, probes, now) {
  const out = [];
  for (const a of animes ?? []) {
    const to = statusToStore(factsFor(a, windows.get(a.id), probes.get(a.id) ?? null), now);
    if (to !== null) out.push({ id: a.id, title: a.title ?? null, from: a.status, to });
  }
  return out;
}

async function pages(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * O que a base sabe de uma ficha para lá da janela. Três leituras pequenas, e
 * mais duas quando é o total da temporada a decidir.
 */
async function probeAnime(supabase, anime, win, nowIso) {
  const id = anime.id;
  const [aired, next] = await Promise.all([
    supabase
      .from('episodes')
      .select('episode_number, season_number')
      .eq('anime_id', id)
      .lte('airing_at', nowIso)
      .order('episode_number', { ascending: false })
      .limit(1),
    supabase
      .from('episodes')
      .select('airing_at')
      .eq('anime_id', id)
      .gt('airing_at', nowIso)
      .order('airing_at', { ascending: true })
      .limit(1),
  ]);
  if (aired.error) throw aired.error;
  if (next.error) throw next.error;
  const last = aired.data?.[0]?.episode_number ?? null;
  let pendingQuery = supabase.from('episodes').select('id').eq('anime_id', id).is('airing_at', null);
  if (last !== null) pendingQuery = pendingQuery.gt('episode_number', last);
  const pending = await pendingQuery.limit(1);
  if (pending.error) throw pending.error;
  const probe = {
    airedEver: last !== null,
    nextAiringAt: next.data?.[0]?.airing_at ?? null,
    episodesPending: (pending.data?.length ?? 0) > 0,
    finalEpisodeAired: false,
  };
  // O total conhecido só importa quando é ele a decidir (ver `needsTotal`).
  const season = aired.data?.[0]?.season_number ?? null;
  if (needsTotal(anime, win, probe) && season !== null) {
    probe.finalEpisodeAired = await reachedSeasonTotal(supabase, id, season, last);
  }
  return probe;
}

/**
 * O último que saiu (`last`) chegou ao total da temporada `season`, tal como o
 * TVDB a lista? Duas leituras: o maior número da temporada, e se algum
 * episódio dela tem metadados do TVDB. Ver "O total conhecido" em
 * web/lib/status/live-status.mjs.
 */
async function reachedSeasonTotal(supabase, id, season, last) {
  const [maior, tvdb] = await Promise.all([
    supabase
      .from('episodes')
      .select('episode_number')
      .eq('anime_id', id)
      .eq('season_number', season)
      .order('episode_number', { ascending: false })
      .limit(1),
    supabase
      .from('episodes')
      .select('id')
      .eq('anime_id', id)
      .eq('season_number', season)
      .or('title.not.is.null,overview.not.is.null,image_url.not.is.null')
      .limit(1),
  ]);
  if (maior.error) throw maior.error;
  if (tvdb.error) throw tvdb.error;
  const max = maior.data?.[0]?.episode_number ?? null;
  return (tvdb.data?.length ?? 0) > 0 && max !== null && last >= max;
}

/**
 * Lê, decide e (sem `dryRun`) grava. Devolve as mudanças.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ now?: Date, dryRun?: boolean, log?: (line: string) => void }} [options]
 */
export async function reconcileStatuses(supabase, { now = new Date(), dryRun = false, log = console.log } = {}) {
  const nowIso = now.toISOString();
  const from = new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const to = new Date(now.getTime() + LIVE_WINDOW_DAYS * DAY_MS).toISOString();

  // 1. Tudo o que está "no ar" ou "em pausa": são poucas centenas.
  const candidatas = await pages(() =>
    supabase
      .from('animes')
      .select('id, title, status, schedule_note')
      .in('status', ['airing', 'hiatus'])
      .order('id', { ascending: true }),
  );

  // 2. Os episódios da janela, de TODO o catálogo: dizem quem está no ar, e
  //    trazem as terminadas/por estrear que voltaram a ter episódios.
  //    Ordenados por `airing_at` (e `id`, para as páginas não se repetirem):
  //    é o índice `episodes_airing_at_idx` que serve a janela. Por `id` só, o
  //    plano podia percorrer a tabela inteira pela chave, e com a chave
  //    pública a simulação rebentou no limite de tempo (57014, 2026-11-04).
  const janela = await pages(() =>
    supabase
      .from('episodes')
      .select('anime_id, airing_at')
      .gte('airing_at', from)
      .lte('airing_at', to)
      .order('airing_at', { ascending: true })
      .order('id', { ascending: true }),
  );
  const windows = windowByAnime(janela, now);

  const conhecidas = new Set(candidatas.map((a) => a.id));
  const outras = [...windows.keys()].filter((id) => !conhecidas.has(id));
  for (const ids of chunk(outras, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, title, status, schedule_note')
      .in('id', ids)
      .in('status', ['finished', 'upcoming']);
    if (error) throw error;
    candidatas.push(...(data ?? []));
  }

  // 3. Só se pergunta mais à base quando a janela não chega para decidir.
  const probes = new Map();
  const porSondar = candidatas.filter((a) => needsProbe(windows.get(a.id)));
  await pool(porSondar, PROBE_CONCURRENCY, async (a) => {
    probes.set(a.id, await probeAnime(supabase, a, windows.get(a.id), nowIso));
  });

  const changes = planStatusChanges(candidatas, windows, probes, now);
  for (const c of changes) {
    log(`[nimu] estado: ${c.title ?? c.id} ${c.from} → ${c.to}${dryRun ? ' (simulação)' : ''}`);
    if (dryRun) continue;
    const { error } = await supabase.from('animes').update({ status: c.to }).eq('id', c.id).eq('status', c.from);
    if (error) throw error;
  }
  log(
    `[nimu] estado: ${candidatas.length} ficha(s) vistas, ${porSondar.length} sondadas, ` +
      `${changes.length} ${dryRun ? 'mudariam' : 'mudaram'}`,
  );
  return changes;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.SUPABASE_URL;
  // Em simulação chega a chave pública (só leituras, o catálogo é público).
  const key = dryRun
    ? (process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      dryRun
        ? 'Falta SUPABASE_URL e SUPABASE_ANON_KEY (ou SUPABASE_SERVICE_ROLE_KEY).'
        : 'Falta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await reconcileStatuses(supabase, { dryRun });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[nimu] ❌ estado:', err);
    process.exitCode = 1;
  });
}
