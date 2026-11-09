// Estudo do horizonte das fontes: a lógica pura (sem rede), para os testes.
// O que corre a sério está em horizonte-fontes.mjs. Ver o cabeçalho de lá.

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ── Semanas ──────────────────────────────────────────────────────────────────

/**
 * As semanas ISO (UTC) de +0 a `ahead`, com o início (segunda 00:00) e o fim
 * (domingo 23:59:59.999) em milissegundos. As semanas contam-se em UTC, como o
 * horário da AnimeSchedule que a ingestão pede (`tz=Etc/UTC`).
 */
export function weekSpans(now, ahead) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(midnight).getUTCDay() || 7;
  const monday = midnight - (weekday - 1) * DAY_MS;
  const out = [];
  for (let k = 0; k <= ahead; k += 1) {
    const start = monday + k * 7 * DAY_MS;
    const { year, week } = isoWeekOf(new Date(start));
    out.push({ k, year, week, start, end: start + 7 * DAY_MS - 1 });
  }
  return out;
}

/** O mesmo que `isoWeek` em src/util.js (copiado para este ficheiro não ter imports). */
export function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return { year, week };
}

/** O `k` da semana onde `ms` cai, ou `null` fora da janela. */
export function weekIndexOf(ms, spans) {
  for (const s of spans) if (ms >= s.start && ms <= s.end) return s.k;
  return null;
}

// ── Identidade das séries ────────────────────────────────────────────────────

const numero = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A chave de uma série entre fontes: o id da AniList quando se sabe, direto ou
 * pelo MAL (`malToAl`, tirado dos próprios resultados da AniList); senão o MAL;
 * senão `null` (a série não se consegue cruzar).
 */
export function showKey({ anilist, mal } = {}, malToAl = new Map()) {
  const al = numero(anilist) ?? (numero(mal) !== null ? malToAl.get(numero(mal)) ?? null : null);
  if (al !== null) return `al:${al}`;
  if (numero(mal) !== null) return `mal:${numero(mal)}`;
  return null;
}

// ── Normalização: cada fonte vira { key, show, title, episode, at, k, popularity } ──

/**
 * Entradas do horário da AnimeSchedule (`/timetables/{tipo}`). `idsByRoute`:
 * rota → { anilist, mal, title } (da base, ou do detalhe da AnimeSchedule).
 */
export function fromAnimeSchedule(entries, { idsByRoute = new Map(), malToAl = new Map(), spans }) {
  const out = [];
  for (const e of entries ?? []) {
    const at = Date.parse(e?.episodeDate ?? '');
    const episode = numero(e?.episodeNumber);
    if (!e?.route || !Number.isFinite(at) || episode === null || at < Date.UTC(1900, 0, 1)) continue;
    const k = weekIndexOf(at, spans);
    if (k === null) continue;
    const ids = idsByRoute.get(e.route) ?? {};
    out.push({
      key: showKey(ids, malToAl),
      show: `as:${e.route}`,
      title: ids.title ?? e.english ?? e.title ?? e.route,
      episode,
      at,
      k,
      popularity: null,
    });
  }
  return out;
}

/**
 * Junta o "sub" com o "raw" como a ingestão faz (`mergeTimetables` em
 * src/util.js): por rota e número, o "sub" manda.
 */
export function mergeSubRaw(sub, raw) {
  const key = (e) => (e?.route && e?.episodeNumber != null ? `${e.route}#${e.episodeNumber}` : null);
  const out = [...(sub ?? [])];
  const seen = new Set(out.map(key).filter(Boolean));
  for (const e of raw ?? []) {
    const k = key(e);
    if (k === null || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** `airingSchedules` da AniList. Os 18+ (`isAdult`) ficam de fora. */
export function fromAniList(schedules, { spans }) {
  const out = [];
  for (const s of schedules ?? []) {
    const m = s?.media;
    if (!m || m.isAdult === true || numero(m.id) === null) continue;
    const at = Number(s.airingAt) * 1000;
    const episode = numero(s.episode);
    if (!Number.isFinite(at) || episode === null) continue;
    const k = weekIndexOf(at, spans);
    if (k === null) continue;
    out.push({
      key: `al:${m.id}`,
      show: `al:${m.id}`,
      title: m.title?.english || m.title?.romaji || `AniList ${m.id}`,
      episode,
      at,
      k,
      popularity: Number.isFinite(m.popularity) ? m.popularity : null,
    });
  }
  return out;
}

/** MAL → AniList, a partir dos próprios resultados da AniList. */
export function malToAniList(schedules) {
  const map = new Map();
  for (const s of schedules ?? []) {
    const al = numero(s?.media?.id);
    const mal = numero(s?.media?.idMal);
    if (al !== null && mal !== null && !map.has(mal)) map.set(mal, al);
  }
  return map;
}

/**
 * Episódios da base nas semanas do estudo (`episodes` com `animes!inner(...)`). A tabela não
 * tem coluna de fonte; a série ter `animeschedule_route` é o que mais se
 * aproxima ("veio do horário") contra o resto (TVDB, catálogo, Kitsu).
 */
export function fromDb(rows, { malToAl = new Map(), spans }) {
  const out = [];
  for (const r of rows ?? []) {
    const a = r?.animes ?? {};
    const at = Date.parse(r?.airing_at ?? '');
    const episode = numero(r?.episode_number);
    if (!Number.isFinite(at) || episode === null) continue;
    const k = weekIndexOf(at, spans);
    if (k === null) continue;
    const ext = a.external_ids ?? {};
    out.push({
      key: showKey({ anilist: ext.anilist, mal: a.mal_id ?? ext.mal }, malToAl),
      show: `db:${r.anime_id ?? a.id ?? a.title}`,
      title: a.title ?? '?',
      episode,
      at,
      k,
      popularity: null,
      viaHorario: Boolean(a.animeschedule_route),
    });
  }
  return out;
}

// ── Comparação ───────────────────────────────────────────────────────────────

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Cruza duas listas pelo par (série, episódio). Só entram registos com chave
 * (série cruzável). Devolve os pares, e o que só uma das fontes tem.
 */
export function matchEpisodes(a, b) {
  const index = (list) => {
    const m = new Map();
    for (const r of list) if (r.key) m.set(`${r.key}#${r.episode}`, r);
    return m;
  };
  const ia = index(a);
  const ib = index(b);
  const pairs = [];
  const onlyA = [];
  for (const [k, ra] of ia) {
    const rb = ib.get(k);
    if (rb) pairs.push({ a: ra, b: rb, diffMs: rb.at - ra.at });
    else onlyA.push(ra);
  }
  const onlyB = [...ib].filter(([k]) => !ia.has(k)).map(([, r]) => r);
  return { pairs, onlyA, onlyB };
}

/** Percentagens de concordância de um conjunto de pares. */
export function agreement(pairs) {
  const n = pairs.length;
  const count = (f) => pairs.filter(f).length;
  const ratio = (x) => (n === 0 ? null : x / n);
  return {
    n,
    sameDate: ratio(count((p) => utcDay(p.a.at) === utcDay(p.b.at))),
    within5m: ratio(count((p) => Math.abs(p.diffMs) <= 5 * MIN_MS)),
    within1h: ratio(count((p) => Math.abs(p.diffMs) <= 60 * MIN_MS)),
  };
}

/**
 * Que parte dos episódios de `b` a fonte `a` também tem, contando só as séries
 * que as duas conhecem. É a pergunta "a AnimeSchedule já tem o que a AniList
 * sabe desta semana?".
 *
 * `shared`: as séries que as duas conhecem em TODA a janela do estudo. Tem de
 * ser a janela inteira e não só a semana: uma série que a AnimeSchedule segue
 * mas ainda não pôs na +3 é exatamente o que falta medir. Sem `shared`, usa as
 * séries de `a` nesta lista.
 */
export function coverage(a, b, shared = null) {
  const showsA = shared ?? new Set(a.filter((r) => r.key).map((r) => r.key));
  const bShared = b.filter((r) => r.key && showsA.has(r.key));
  const { pairs } = matchEpisodes(a, bShared);
  return {
    sharedShows: new Set(bShared.map((r) => r.key)).size,
    bEpisodesOfShared: bShared.length,
    aHasOfThose: pairs.length,
    ratio: bShared.length === 0 ? null : pairs.length / bShared.length,
  };
}

/** Por semana: contagens e as comparações que interessam. */
export function weeklyStats({ spans, asSub, asRaw, asMerged, anilist, db }) {
  // As séries que as duas fontes conhecem, em toda a janela (ver `coverage`).
  const keys = (list) => new Set(list.map((r) => r.key).filter(Boolean));
  const alKeys = keys(anilist);
  const shared = new Set([...keys(asMerged)].filter((k) => alKeys.has(k)));
  return spans.map((s) => {
    const w = (list) => list.filter((r) => r.k === s.k);
    const wSub = w(asSub);
    const wRaw = w(asRaw);
    const wMerged = w(asMerged);
    const wAl = w(anilist);
    const wDb = w(db);
    const shows = (list) => new Set(list.map((r) => r.show)).size;
    return {
      k: s.k,
      label: `${s.year}-W${String(s.week).padStart(2, '0')}`,
      start: utcDay(s.start),
      end: utcDay(s.end),
      counts: {
        asSub: wSub.length,
        asRaw: wRaw.length,
        asMerged: wMerged.length,
        anilist: wAl.length,
        dbHorario: wDb.filter((r) => r.viaHorario).length,
        dbOutras: wDb.filter((r) => !r.viaHorario).length,
      },
      shows: { asMerged: shows(wMerged), anilist: shows(wAl) },
      rawVsAniList: agreement(matchEpisodes(wRaw, wAl).pairs),
      mergedVsAniList: agreement(matchEpisodes(wMerged, wAl).pairs),
      dbVsMerged: agreement(matchEpisodes(wMerged, wDb).pairs),
      asCoversAniList: coverage(wMerged, wAl, shared),
      aniListCoversAs: coverage(wAl, wMerged, shared),
    };
  });
}

/**
 * Até onde cada fonte "sabe": a última semana seguida cujo número de episódios
 * chega a `threshold` da média das semanas +0 e +1 (as que estão de certeza
 * publicadas). `null` se nem a +0 chega.
 */
export function knownUntil(weeks, field, threshold) {
  const base = weeks.filter((w) => w.k <= 1).map((w) => w.counts[field]);
  const ref = base.length ? base.reduce((x, y) => x + y, 0) / base.length : 0;
  if (ref === 0) return null;
  let last = null;
  for (const w of weeks) {
    if (w.counts[field] / ref >= threshold) last = w.k;
    else break;
  }
  return last;
}

/**
 * A recomendação. A ingestão só pode guardar a AnimeSchedule (os termos da
 * AniList não deixam guardar os dados dela; ver episodes-backfill.js), por
 * isso a pergunta é até que semana a AnimeSchedule está "cheia":
 *  - semanas lidas a sério: a última seguida com >= 85% do volume normal E
 *    >= 85% dos episódios que a AniList dá para as séries que as duas conhecem;
 *  - mais uma semana extra (que só acrescenta) enquanto tiver >= 40% do volume.
 */
export function recommendHorizon(weeks, { full = 0.85, partial = 0.4 } = {}) {
  const ref = (() => {
    const base = weeks.filter((w) => w.k <= 1).map((w) => w.counts.asMerged);
    return base.length ? base.reduce((x, y) => x + y, 0) / base.length : 0;
  })();
  let strict = null;
  for (const w of weeks) {
    const vol = ref ? w.counts.asMerged / ref : 0;
    const cov = w.asCoversAniList.ratio;
    if (vol >= full && (cov === null || cov >= full)) strict = w.k;
    else break;
  }
  let extra = null;
  if (strict !== null) {
    const next = weeks.find((w) => w.k === strict + 1);
    if (next && ref && next.counts.asMerged / ref >= partial) extra = next.k;
  }
  return {
    strict,
    extra,
    timetableWeeksAhead: extra ?? strict,
    reference: ref,
    animeScheduleKnownUntil: knownUntil(weeks, 'asMerged', partial),
    aniListKnownUntil: knownUntil(weeks, 'anilist', partial),
  };
}

/**
 * As diferenças das séries mais populares (pela AniList) que as duas fontes
 * conhecem: episódios que só uma tem, ou com hora diferente (mais de 5 min).
 *
 * A presença conta-se pelo que a ingestão guardaria (`asList`, o sub com o raw
 * a preencher). A HORA compara-se com o "raw" quando a AnimeSchedule o tem
 * (`rawList`), porque a AniList dá a emissão japonesa e o "sub" sai quase
 * sempre mais tarde; sem raw, com a hora ingerida (e diz-se).
 */
export function topDisagreements(asList, alList, { rawList = [], top = 30, toleranceMs = 5 * MIN_MS } = {}) {
  const asShows = new Set(asList.filter((r) => r.key).map((r) => r.key));
  const pop = new Map();
  for (const r of alList) {
    if (!asShows.has(r.key)) continue;
    const cur = pop.get(r.key);
    if (!cur || (r.popularity ?? 0) > (cur.popularity ?? 0)) pop.set(r.key, { title: r.title, popularity: r.popularity });
  }
  const rawBy = new Map(rawList.filter((r) => r.key).map((r) => [`${r.key}#${r.episode}`, r]));
  const shows = [...pop].sort((x, y) => (y[1].popularity ?? 0) - (x[1].popularity ?? 0)).slice(0, top);
  const out = [];
  for (const [key, info] of shows) {
    const a = asList.filter((r) => r.key === key);
    const b = alList.filter((r) => r.key === key);
    const { pairs, onlyA, onlyB } = matchEpisodes(a, b);
    const rows = [];
    for (const p of pairs) {
      const raw = rawBy.get(`${key}#${p.a.episode}`) ?? null;
      const ref = raw ?? p.a;
      const diffMs = p.b.at - ref.at;
      if (Math.abs(diffMs) > toleranceMs) {
        rows.push({ episode: p.a.episode, raw: raw?.at ?? null, as: p.a.at, al: p.b.at, diffMin: Math.round(diffMs / MIN_MS), vs: raw ? 'raw' : 'ingerido' });
      }
    }
    for (const r of onlyA) rows.push({ episode: r.episode, raw: rawBy.get(`${key}#${r.episode}`)?.at ?? null, as: r.at, al: null, diffMin: null, vs: null });
    for (const r of onlyB) rows.push({ episode: r.episode, raw: null, as: null, al: r.at, diffMin: null, vs: null });
    rows.sort((x, y) => x.episode - y.episode);
    out.push({ key, title: info.title, popularity: info.popularity, matched: pairs.length, rows });
  }
  return out;
}

// ── Relatório ────────────────────────────────────────────────────────────────

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const quando = (ms) => (ms === null ? 'n/a' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

/** O relatório em Markdown. `meta`: { geradoEm, erros: string[], pedidos: {...} }. */
export function renderMarkdown({ weeks, recommendation, disagreements, meta }) {
  const L = [];
  L.push('# Horizonte das fontes do horário');
  L.push('');
  L.push(`Gerado em ${meta.geradoEm} (UTC). Semanas ISO em UTC, de +0 (a atual) a +${weeks.length - 1}.`);
  L.push('');
  L.push('Fontes: AnimeSchedule (horário "sub" e "raw"; "ingerido" é o sub com o raw a preencher, como a ingestão faz), AniList (`airingSchedules`, sem 18+; hora da emissão japonesa) e a nossa base (os episódios dessas semanas; "horário" são séries com rota da AnimeSchedule, "outras" vêm do TVDB, do catálogo ou do Kitsu). A base não tem coluna de fonte por episódio.');
  L.push('');
  L.push('## Recomendação');
  L.push('');
  const r = recommendation;
  L.push(`- Semanas que a AnimeSchedule tem cheias (lidas a sério, falha fatal): até **+${r.strict ?? 'n/a'}**.`);
  L.push(`- Semana extra, só a acrescentar: ${r.extra === null ? '**nenhuma**' : `**+${r.extra}**`}.`);
  L.push(`- \`TIMETABLE_WEEKS_AHEAD\` recomendado: **${r.timetableWeeksAhead ?? 'n/a'}** (hoje: 2; o PR #74 propõe 3).`);
  L.push(`- Até onde cada fonte sabe (>= 40% do volume normal, semanas seguidas): AnimeSchedule +${r.animeScheduleKnownUntil ?? 'n/a'}, AniList +${r.aniListKnownUntil ?? 'n/a'}.`);
  L.push(`- Volume de referência (média das semanas +0 e +1, AnimeSchedule ingerido): ${r.reference.toFixed(0)} episódios.`);
  L.push('');
  L.push('Regra: a última semana seguida com >= 85% do volume de referência e >= 85% dos episódios que a AniList dá para as séries que as duas conhecem; mais uma semana extra se essa tiver >= 40% do volume.');
  L.push('');
  L.push('## Episódios por semana e por fonte');
  L.push('');
  L.push('| semana | datas | AS sub | AS raw | AS ingerido | AniList | base (horário) | base (outras) | séries AS | séries AniList |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const w of weeks) {
    const c = w.counts;
    L.push(`| +${w.k} ${w.label} | ${w.start} a ${w.end} | ${c.asSub} | ${c.asRaw} | ${c.asMerged} | ${c.anilist} | ${c.dbHorario} | ${c.dbOutras} | ${w.shows.asMerged} | ${w.shows.anilist} |`);
  }
  L.push('');
  L.push('## Concordância (episódios que as duas fontes têm, pela série e pelo número)');
  L.push('');
  L.push('"AS cobre AniList": dos episódios que a AniList dá nessa semana para as séries que as duas fontes conhecem (em qualquer semana do estudo), quantos a AnimeSchedule também tem. É a medida do horizonte. Mesma data é o mesmo dia em UTC. O "sub" é quando sai legendado e a AniList dá a emissão japonesa: diferenças de horas entre os dois são esperadas. A comparação justa da hora é a do "raw".');
  L.push('');
  L.push('| semana | AS cobre AniList | AniList cobre AS | raw x AniList (n, data, ±5 min, ±1 h) | ingerido x AniList (n, data, ±5 min, ±1 h) | base x ingerido (n, data, ±5 min) |');
  L.push('|---|---:|---:|---|---|---|');
  for (const w of weeks) {
    const f = (a, h = true) => `${a.n}, ${pct(a.sameDate)}, ${pct(a.within5m)}${h ? `, ${pct(a.within1h)}` : ''}`;
    L.push(`| +${w.k} | ${pct(w.asCoversAniList.ratio)} (${w.asCoversAniList.aHasOfThose}/${w.asCoversAniList.bEpisodesOfShared}) | ${pct(w.aniListCoversAs.ratio)} (${w.aniListCoversAs.aHasOfThose}/${w.aniListCoversAs.bEpisodesOfShared}) | ${f(w.rawVsAniList)} | ${f(w.mergedVsAniList)} | ${f(w.dbVsMerged, false)} |`);
  }
  L.push('');
  L.push(`## Diferenças das ${disagreements.length} séries mais populares (AniList) que as duas conhecem`);
  L.push('');
  L.push('Horas em UTC. "Ingerido" é o que a ingestão guardaria (o sub, ou o raw quando não há sub). A diferença é a hora da AniList menos a do raw da AnimeSchedule (a mesma emissão japonesa), ou menos a ingerida quando não há raw. Só as linhas com mais de 5 minutos de diferença, ou que só uma fonte tem.');
  L.push('');
  for (const d of disagreements) {
    L.push(`### ${d.title} (popularidade ${d.popularity ?? 'n/a'}, ${d.matched} episódios em comum)`);
    if (d.rows.length === 0) {
      L.push('');
      L.push('Sem diferenças.');
      L.push('');
      continue;
    }
    L.push('');
    L.push('| ep | AS raw | AS ingerido | AniList | diferença |');
    L.push('|---:|---|---|---|---:|');
    for (const x of d.rows) {
      const dif = x.diffMin === null ? (x.al === null ? 'só na AS' : 'só na AniList') : `${x.diffMin} min (${x.vs})`;
      L.push(`| ${x.episode} | ${quando(x.raw)} | ${quando(x.as)} | ${quando(x.al)} | ${dif} |`);
    }
    L.push('');
  }
  L.push('## Pedidos e erros');
  L.push('');
  for (const [k, v] of Object.entries(meta.pedidos ?? {})) L.push(`- ${k}: ${v}`);
  if ((meta.erros ?? []).length === 0) L.push('- Sem erros.');
  for (const e of meta.erros ?? []) L.push(`- ERRO: ${e}`);
  L.push('');
  return L.join('\n');
}

// ── AniList: paginação ───────────────────────────────────────────────────────

export const ANILIST_QUERY = `query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      airingAt
      episode
      media { id idMal isAdult popularity format countryOfOrigin title { romaji english } }
    }
  }
}`;

/**
 * Todas as páginas de `airingSchedules` entre `fromMs` e `toMs`. `post(body)`
 * devolve o JSON da resposta (e respeita o ritmo: ver horizonte-fontes.mjs).
 * Para em `maxPages` para nunca ficar preso.
 */
export async function fetchAniListRange({ post, fromMs, toMs, maxPages = 60 }) {
  const out = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const json = await post({
      query: ANILIST_QUERY,
      variables: { page, from: Math.floor(fromMs / 1000) - 1, to: Math.floor(toMs / 1000) + 1 },
    });
    pages += 1;
    const p = json?.data?.Page;
    if (!p) throw new Error(`AniList: resposta sem Page (${JSON.stringify(json?.errors ?? null).slice(0, 200)})`);
    out.push(...(p.airingSchedules ?? []));
    if (!p.pageInfo?.hasNextPage) return { schedules: out, pages, truncated: false };
  }
  return { schedules: out, pages, truncated: true };
}
