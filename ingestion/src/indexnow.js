// Avisa os motores de busca (IndexNow: Bing, e por ele o Copilot, o ChatGPT e o
// DuckDuckGo, mais Yandex, Seznam, Naver) das páginas do Nimu que acabaram de
// mudar, em vez de esperar que eles voltem cá por iniciativa própria.
//
//   node src/indexnow.js             → calcula a lista e envia
//   node src/indexnow.js --dry-run   → só mostra o que enviaria
//   node src/indexnow.js --hours=72  → janela maior, para um envio à mão
//   node src/indexnow.js --url=https://nimuhome.com/llms.txt --url=…
//                                    → só esses URLs (sem base de dados)
//
// Corre depois de cada ingestão (de 6 em 6 horas). Só manda o que mudou MESMO
// nessa janela, que é o que o protocolo pede (reenviar tudo a cada corrida é o
// que o faz ignorar um site):
//
//  - episódios que saíram desde a última corrida: a página deles passa de
//    "sai" a "saiu", e a ficha da série passa a ter outro próximo episódio;
//  - episódios novos com data (páginas novas);
//  - séries novas a dar ou por estrear;
//  - uma vez por dia, a capa, as notícias e as estreias da semana.
//
// Só entram páginas que o site deixa indexar (web/lib/seo/indexable.ts): tudo o
// que aqui se escolhe é recente por construção.
//
// A chave é PÚBLICA de propósito: o ficheiro web/public/<chave>.txt é a prova de
// que o domínio é nosso. Quem a souber só consegue avisar os motores de páginas
// deste domínio.
import { pathToFileURL } from 'node:url';

export const INDEXNOW_KEY = '7862c64d1c50165829f8dc2779ea6f71';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const DEFAULT_SITE = 'https://nimuhome.com';

/** A janela de cada corrida: o intervalo do cron do ingest.yml. */
export const WINDOW_HOURS = 6;
/** Um episódio novo só vale a pena se ainda for notícia (lib/seo/indexable.ts). */
const NEW_EPISODE_PAST_DAYS = 14;
/** O protocolo aceita até 10 000 URLs por pedido. */
const MAX_URLS = 10_000;

const DRY_RUN = process.argv.includes('--dry-run');
const HOURS = parseHours(process.argv);

function parseHours(argv) {
  const arg = argv.find((a) => a.startsWith('--hours='));
  const n = arg ? Number(arg.slice('--hours='.length)) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : WINDOW_HOURS;
}
const HOUR_MS = 60 * 60 * 1000;

/** `/anime/<slug>`, ou pelo id quando não há slug (o mesmo que `animeHref`). */
function animePath(anime) {
  return `/anime/${encodeURIComponent(anime.slug || anime.id)}`;
}

/**
 * A lista de URLs a enviar, nas duas línguas (`/pt/...`), sem repetidos.
 *
 * Função pura, para os testes: recebe as linhas já lidas.
 *   aired:     episódios que saíram na janela   [{ episode_number, animes }]
 *   created:   episódios criados na janela      [{ episode_number, airing_at, animes }]
 *   newAnimes: séries criadas na janela         [{ id, slug, status }]
 *   daily:     se esta corrida manda as páginas do dia
 */
export function planUrls({ site = DEFAULT_SITE, now, aired = [], created = [], newAnimes = [], daily = false }) {
  const origin = new URL(site).origin;
  const paths = new Set();
  const addEpisode = (row) => {
    const anime = row?.animes;
    const n = Number(row?.episode_number);
    if (!anime?.id || !Number.isInteger(n) || n <= 0) return;
    paths.add(animePath(anime));
    paths.add(`${animePath(anime)}/episodio/${n}`);
  };

  for (const row of aired) addEpisode(row);
  const desde = now.getTime() - NEW_EPISODE_PAST_DAYS * 24 * HOUR_MS;
  for (const row of created) {
    const quando = Date.parse(row?.airing_at ?? '');
    if (Number.isFinite(quando) && quando >= desde) addEpisode(row);
  }
  for (const anime of newAnimes) {
    if (anime?.id && (anime.status === 'airing' || anime.status === 'upcoming')) {
      paths.add(animePath(anime));
    }
  }
  if (daily) {
    for (const path of ['/', '/noticias', '/noticias/estreias-da-semana', ...seasonGuidePaths(now)]) paths.add(path);
  }

  const urls = [];
  for (const path of paths) {
    urls.push(`${origin}${path}`);
    urls.push(`${origin}${path === '/' ? '/pt' : `/pt${path}`}`);
  }
  return urls.slice(0, MAX_URLS);
}

const SEASON_SLUGS = ['inverno', 'primavera', 'verao', 'outono'];

/**
 * Os guias da temporada atual e da seguinte (`/noticias/temporada/outono-2026`),
 * as páginas que respondem a "anime de outono 2026, datas de estreia". A mesma
 * conta de `currentSeason`/`nextSeason` em web/lib/data/season-ref.ts (estação
 * pelo mês UTC) e os mesmos slugs (2026-11-03).
 */
export function seasonGuidePaths(now) {
  const i = Math.floor(now.getUTCMonth() / 3);
  const ano = now.getUTCFullYear();
  const seguinte = i === 3 ? { i: 0, ano: ano + 1 } : { i: i + 1, ano };
  return [
    `/noticias/temporada/${SEASON_SLUGS[i]}-${ano}`,
    `/noticias/temporada/${SEASON_SLUGS[seguinte.i]}-${seguinte.ano}`,
  ];
}

/**
 * URLs dados à mão (`--url=https://nimuhome.com/x`, repetível), para avisar
 * de uma página publicada fora da ingestão. Só deste domínio: o protocolo
 * recusa o pedido inteiro (422) se um URL for de outro anfitrião.
 */
export function manualUrls(argv, site = DEFAULT_SITE) {
  const { host } = new URL(site);
  const out = [];
  for (const arg of argv) {
    if (!arg.startsWith('--url=')) continue;
    try {
      const url = new URL(arg.slice('--url='.length));
      if (url.host === host && (url.protocol === 'https:' || url.protocol === 'http:')) out.push(url.href);
    } catch {
      // um URL inválido fica de fora, sem travar os outros
    }
  }
  return out;
}

/** A corrida da meia-noite UTC (a primeira do dia no cron) manda as páginas do dia. */
export function isDailyRun(now) {
  return now.getUTCHours() < WINDOW_HOURS;
}

async function readWindow(supabase, now, hours) {
  const inicio = new Date(now.getTime() - hours * HOUR_MS).toISOString();
  const fim = now.toISOString();
  const cols = 'episode_number, airing_at, animes!inner(id, slug, status)';
  const [aired, created, newAnimes] = await Promise.all([
    supabase.from('episodes').select(cols).gte('airing_at', inicio).lte('airing_at', fim).limit(2000),
    supabase.from('episodes').select(cols).gte('created_at', inicio).not('airing_at', 'is', null).limit(2000),
    supabase.from('animes').select('id, slug, status').gte('created_at', inicio).limit(2000),
  ]);
  for (const r of [aired, created, newAnimes]) if (r.error) throw r.error;
  return { aired: aired.data ?? [], created: created.data ?? [], newAnimes: newAnimes.data ?? [] };
}

export async function submit(urls, site = DEFAULT_SITE, fetchImpl = fetch) {
  const { host, origin } = new URL(site);
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${origin}/${INDEXNOW_KEY}.txt`, urlList: urls }),
  });
  // 200 e 202 são os dois "recebido". 403: a chave ainda não está no site
  // (antes do primeiro deploy com o ficheiro). 422: URL fora do domínio.
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.status;
}

async function main() {
  const site = process.env.PUBLIC_SITE_URL || DEFAULT_SITE;
  // Modo manual: só os URLs dados, sem ler a base (não precisa de segredos).
  const manuais = manualUrls(process.argv, site);
  if (manuais.length > 0) {
    console.log(`[nimu:indexnow] ${manuais.length} URLs dados à mão`);
    if (DRY_RUN) {
      for (const url of manuais) console.log(`  ${url}`);
      console.log('[nimu:indexnow] DRY RUN: nada enviado');
      return;
    }
    console.log(`[nimu:indexnow] ✅ enviado (${await submit(manuais, site)})`);
    return;
  }
  await import('./config.js');
  const { supabase } = await import('./supabase.js');
  const now = new Date();
  const janela = await readWindow(supabase, now, HOURS);
  const urls = planUrls({ site, now, ...janela, daily: isDailyRun(now) });
  console.log(
    `[nimu:indexnow] ${janela.aired.length} episódios saíram, ${janela.created.length} novos, ` +
      `${janela.newAnimes.length} séries novas: ${urls.length} URLs`,
  );
  if (urls.length === 0) return;
  if (DRY_RUN) {
    for (const url of urls.slice(0, 20)) console.log(`  ${url}`);
    console.log('[nimu:indexnow] DRY RUN: nada enviado');
    return;
  }
  const status = await submit(urls, site);
  console.log(`[nimu:indexnow] ✅ enviado (${status})`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:indexnow] ❌ falhou:', error?.message ?? error);
    process.exitCode = 1;
  });
}
