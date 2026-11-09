export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ISO-8601 week for a date (UTC). Returns { year, week } — note the ISO year
 *  can differ from the calendar year around New Year. */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to this week's Thursday
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return { year, week };
}

/**
 * Quantas semanas ISO depois da atual se lê do horário da AnimeSchedule.
 *
 * A web usa o MESMO número para saber até onde o horário está publicado e
 * dizer "Horário ainda não publicado" nos dias depois disso
 * (`web/lib/calendar/timetable-horizon.ts`). São pacotes diferentes, por isso
 * o teste `web/test/timetable-horizon.test.ts` lê este valor e falha se os dois
 * divergirem: quem mudar um muda o outro.
 *
 * Era 2 até 2026-11-08. A 3.ª semana entrou para o calendário saber mais à
 * frente, mas só ACRESCENTA (ver `TIMETABLE_STRICT_WEEKS_AHEAD`).
 */
export const TIMETABLE_WEEKS_AHEAD = 3;

/**
 * As semanas à frente que a ingestão lê "a sério", como sempre leu: se o "sub"
 * de uma delas falha, a corrida falha; e é só até ao fim delas que a arrumação
 * dos episódios futuros (`staleFutureEpisodeIds`) olha.
 *
 * As semanas entre esta e `TIMETABLE_WEEKS_AHEAD` (hoje, só a +3) são extra: a
 * AnimeSchedule ainda as está a publicar e costumam vir a meio. Uma falha nelas
 * é um aviso e a corrida segue com as outras; e um episódio que lá falte não
 * diz nada (ainda não foi publicado), por isso não leva a apagar datas.
 * Ver `fetchTimetableWindow` em timetable-window.js.
 */
export const TIMETABLE_STRICT_WEEKS_AHEAD = 2;

/**
 * O último milissegundo (domingo, 23:59:59.999 UTC) da semana ISO que fica
 * `weeksAhead` semanas depois da de `now`. As semanas contam-se em UTC, como o
 * horário que se pede (`tz=Etc/UTC`, ver animeschedule.js). Igual a
 * `timetableHorizon` em web/lib/calendar/timetable-horizon.ts.
 */
export function isoWeekEndUtc(now, weeksAhead) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(midnight).getUTCDay() || 7; // Mon=1 … Sun=7
  const monday = midnight - (weekday - 1) * 86400000;
  return new Date(monday + (weeksAhead + 1) * 7 * 86400000 - 1);
}

/**
 * As linhas do horário que contam para a arrumação dos episódios futuros: as
 * das semanas lidas "a sério", com data até `staleWindowEnd` (ISO). As da
 * semana extra ficam de fora: acrescentam episódios e atualizam datas, mas
 * nunca fazem a arrumação apagar nada, nem lhe alargam a janela.
 *
 * Como o horário vem em UTC (`tz=Etc/UTC`), cada entrada cai dentro da sua
 * semana, e as da semana extra têm todas data depois de `staleWindowEnd`. Sem
 * `staleWindowEnd` (os fixtures do dry-run) devolve tudo, como antes.
 */
export function staleCleanupRows(rows, staleWindowEnd) {
  const endMs = staleWindowEnd ? Date.parse(staleWindowEnd) : Number.NaN;
  if (!Number.isFinite(endMs)) return [...(rows ?? [])];
  return (rows ?? []).filter((r) => {
    if (!r?.airing_at) return true;
    const t = Date.parse(r.airing_at);
    return !Number.isFinite(t) || t <= endMs;
  });
}

/** The {year, week} pairs to ingest: `behind` past + current + `ahead` future
 *  weeks. Feeds AnimeSchedule's timetables endpoint (one request per week). */
export function isoWeeksWindow(now = new Date(), behind = 1, ahead = TIMETABLE_WEEKS_AHEAD) {
  const seen = new Set();
  const out = [];
  for (let i = -behind; i <= ahead; i += 1) {
    const d = new Date(now.getTime() + i * 7 * 86400000);
    const yw = isoWeek(d);
    const key = `${yw.year}-${yw.week}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(yw);
    }
  }
  return out;
}

/** Split an array into chunks of `size` (for batched upserts / IN() lists). */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Keep the last row seen per key (last-wins), skipping null/undefined keys. */
export function dedupeByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key != null) map.set(key, row);
  }
  return [...map.values()];
}

/**
 * Ids of episodes that have ALREADY AIRED, from rows shaped `{ id, airing_at }`
 * (as returned by the episodes upsert with `.select('id, airing_at')`). These
 * are the only episodes the weekly sync fans notifications out for — a "new
 * episode" is one that is OUT, so future-dated rows are excluded, and so are
 * rows missing an id or a parseable date.
 *
 * This is only a cheap pre-filter to keep the fan-out RPC payload to aired
 * episodes instead of the whole ~5-week calendar window; the AUTHORITATIVE
 * "how recent still counts as new" cut-off lives in the DB function
 * public.fan_out_episode_airing (its p_recent_window). Passing an already-aired
 * id that later proves too old is harmless — the function drops it.
 */
export function airedEpisodeIds(rows, now = new Date()) {
  const nowMs = now.getTime();
  const out = [];
  for (const row of rows ?? []) {
    if (!row || typeof row.id !== 'string' || row.id === '' || !row.airing_at) continue;
    const airedMs = Date.parse(row.airing_at);
    if (Number.isFinite(airedMs) && airedMs <= nowMs) out.push(row.id);
  }
  return out;
}

/**
 * Deduplicate episode rows by (anime_id, episode_number) — the UNIQUE key the
 * upsert conflicts on. Two source entries can collapse into one anime (e.g.
 * sub + dub timetable entries, or overlapping weekly windows), yielding the
 * same key twice; Postgres then aborts the whole batch ("ON CONFLICT DO UPDATE
 * command cannot affect row a second time"). Criterion: keep the row with the
 * most streaming_links (the most complete record); on a tie keep the
 * later-seen one, matching dedupeByKey's last-wins semantics.
 */
export function dedupeEpisodes(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.anime_id}:${row.episode_number}`;
    const prev = map.get(key);
    const links = (r) => (Array.isArray(r.streaming_links) ? r.streaming_links.length : 0);
    if (!prev || links(row) >= links(prev)) map.set(key, row);
  }
  return [...map.values()];
}

/**
 * Junta o horário "sub" com o "raw" da AnimeSchedule, com o "sub" a mandar.
 *
 * A ingestão pedia só o "sub" (quando sai legendado em inglês). As ESTREIAS
 * ainda não têm data de legendas anunciada, portanto não vinham: a 2026-09-22 a
 * semana de 9 de outubro (início da temporada de outono) trazia 15 entradas, e
 * a página desse dia mostrava 4 séries. O "raw" é a emissão japonesa, e essa
 * está anunciada com semanas de antecedência.
 *
 * Por episódio (rota + número): se há entrada "sub", é essa; senão, a "raw".
 * Quando as legendas forem anunciadas, a corrida seguinte troca a hora pela do
 * "sub" sozinha. Isso NÃO dispara o aviso de adiamento, que depende do
 * `delayedFrom` que a própria AnimeSchedule põe, e não de a hora mudar.
 */
export function mergeTimetables(primary, fallback) {
  const key = (e) =>
    e?.route && e?.episodeNumber != null ? `${e.route}#${e.episodeNumber}` : null;
  const out = [...(primary ?? [])];
  const seen = new Set(out.map(key).filter((k) => k !== null));
  for (const e of fallback ?? []) {
    const k = key(e);
    if (k === null || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Os episódios FUTUROS que a fonte deixou de anunciar, e que por isso já não
 * são verdade.
 *
 * A ingestão acrescentava e atualizava, mas nunca desmarcava. Quando uma série
 * mudava de horário (uma pausa, um adiamento), a data antiga ficava para trás.
 * Medido a 2026-09-22: o BLEACH com o episódio 10 a 26/09 depois de o 9 ter
 * passado para 05/10, e o "Please Excuse My Younger Brothers" com o episódio 15
 * a 09/10 ÀS 15:00, antes do 14 às 16:30 do mesmo dia, uma projeção do
 * preenchimento em massa de agosto que nunca foi corrigida.
 *
 * Só entra quem cumpre TUDO:
 *  - a fonte está a falar da série agora: ou está no horário que acabou de ser
 *    lido (`timetableKeys`), ou a AnimeSchedule segue-a e o horário, lido por
 *    inteiro, não a traz (`absentAnimeIds`, ver `clearStaleFutureEpisodes`);
 *  - a data é futura e cai dentro da janela lida (até `windowEnd`, a data mais
 *    tardia do próprio horário), porque fora dela a fonte simplesmente não disse
 *    nada;
 *  - esse (série, episódio) não está no horário.
 *
 * Os episódios com `delayed_from` já ficaram de fora, para não disparar o aviso
 * de "adiado sem data". Foi um erro: a AnimeSchedule arrasta o mesmo
 * `delayedFrom` para todos os episódios seguintes, e assim as projeções de uma
 * série que entrou em pausa ficavam presas para sempre. Medido a 2026-10-02: o
 * One Piece com os episódios 1181 e 1182 a 4 e 11/10, todos com o adiamento de
 * 05/07 arrastado, quando a fonte diz "Episodes 1181 and further will continue
 * in April 2027". Ia notificar quem o segue de um episódio que não existe. E o
 * aviso de "adiado sem data" (migração 20260801000000) não está ligado a nada:
 * nem a ingestão nem o pg_cron chamam `fan_out_episode_delayed`.
 */
export function staleFutureEpisodeIds({ dbRows, timetableKeys, now, windowEnd, absentAnimeIds = new Set() }) {
  const animes = new Set([...timetableKeys].map((k) => k.split('#')[0]));
  const nowMs = new Date(now).getTime();
  const endMs = new Date(windowEnd).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(endMs)) return [];
  const out = [];
  for (const r of dbRows ?? []) {
    if (!r?.id || !r.airing_at) continue;
    if (!animes.has(r.anime_id) && !absentAnimeIds.has(r.anime_id)) continue;
    const t = new Date(r.airing_at).getTime();
    if (!(t > nowMs && t <= endMs)) continue;
    if (timetableKeys.has(`${r.anime_id}#${r.episode_number}`)) continue;
    out.push(r.id);
  }
  return out;
}

/**
 * Uma nota de horário por ficha, e só as que mudaram.
 *
 * Várias rotas da AnimeSchedule podem dar na mesma ficha (as temporadas
 * dobradas numa franquia, ver franchise.js); uma frase ganha a um silêncio.
 * `pairs`: `{ id, note }` por rota; `current`: `Map` id → nota que lá está.
 * Devolve `{ id, note }` só onde a nota pedida é diferente da guardada, para a
 * ingestão não reescrever as mesmas ~190 linhas a cada corrida.
 */
export function scheduleNoteChanges(pairs, current) {
  const wanted = new Map();
  for (const { id, note } of pairs ?? []) {
    if (!id) continue;
    const n = note ?? null;
    if (!wanted.has(id) || (n !== null && wanted.get(id) === null)) wanted.set(id, n);
  }
  const out = [];
  for (const [id, note] of wanted) {
    if ((current?.get(id) ?? null) !== note) out.push({ id, note });
  }
  return out;
}
