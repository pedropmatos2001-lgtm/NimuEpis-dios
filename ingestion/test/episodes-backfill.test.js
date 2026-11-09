import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backfillRows,
  emptyReport,
  estimateMegabytes,
  kitsuNextUrl,
  manamiTotals,
  parseArgs,
  runOutcome,
  weeksFrom,
  withoutEpisodesReason,
} from '../src/episodes-backfill.js';

/**
 * Uma base falsa, só com o que o backfill usa: ler episódios por
 * `.in('anime_id', …)` às páginas, e `upsert` com a chave única
 * (anime_id, episode_number), com ou sem `ignoreDuplicates`.
 */
function fakeSupabase(initial = []) {
  const rows = initial.map((r) => ({ air_date_unknown: false, streaming_links: [], ...r }));
  const writes = [];
  const key = (r) => `${r.anime_id}#${r.episode_number}`;
  return {
    rows,
    writes,
    from(table) {
      assert.equal(table, 'episodes');
      let ids = null;
      const q = {
        select() { return q; },
        in(col, values) { assert.equal(col, 'anime_id'); ids = new Set(values); return q; },
        order() { return q; },
        range(from, to) {
          const data = rows
            .filter((r) => ids.has(r.anime_id))
            .sort((a, b) => (a.anime_id < b.anime_id ? -1 : a.anime_id > b.anime_id ? 1 : a.episode_number - b.episode_number))
            .slice(from, to + 1)
            .map((r) => ({ ...r }));
          return Promise.resolve({ data, error: null });
        },
        upsert(batch, opts) {
          writes.push({ n: batch.length, ignore: Boolean(opts?.ignoreDuplicates) });
          for (const r of batch) {
            const i = rows.findIndex((x) => key(x) === key(r));
            if (i === -1) rows.push({ air_date_unknown: false, streaming_links: [], delayed_from: null, ...r });
            else if (!opts?.ignoreDuplicates) rows[i] = { ...rows[i], ...r };
          }
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
}

const NOW = new Date('2026-11-04T12:00:00Z');
const SOLO = { id: 'a1', slug: 'ore-dake-level-up-na-ken', title: 'Ore dake Level Up na Ken', status: 'finished', media_type: 'TV', mal_id: 52299, external_ids: { mal: 52299 } };
const OLD = { id: 'a2', slug: 'cowboy-bebop', title: 'Cowboy Bebop', status: 'finished', media_type: 'TV', mal_id: 1, external_ids: { mal: 1 } };
const SOON = { id: 'a3', slug: 'sousou-no-frieren-ougonkyou-hen', title: 'Frieren 3', status: 'upcoming', media_type: 'TV', mal_id: 63816, external_ids: { mal: 63816 } };
const MOVIE = { id: 'a4', slug: 'filme', title: 'Filme', status: 'finished', media_type: 'Movie', mal_id: 9, external_ids: { mal: 9 } };

function soloHistory() {
  const eps = new Map();
  for (let n = 1; n <= 12; n += 1) {
    eps.set(n, { episodeNumber: n, airingAt: new Date(Date.UTC(2024, 0, 6 + (n - 1) * 7, 17, 30)).toISOString(), precision: 'exact', streamingLinks: [], delayedFrom: null });
  }
  return new Map([['solo-leveling', eps]]);
}

function ctx(supabase, extra = {}) {
  return {
    supabase,
    rows: [SOLO, OLD, SOON, MOVIE],
    animeschedule: {
      history: soloHistory(),
      catalogue: {
        byRoute: new Map([['solo-leveling', { route: 'solo-leveling', mal: 52299, premier: '2024-01-06T00:00:00.000Z', episodes: 12, music: false }]]),
        routeByMal: new Map([[52299, 'solo-leveling']]),
      },
    },
    totals: new Map([[52299, 12], [1, 26], [63816, 10], [9, 1]]),
    sources: new Set(['animeschedule']),
    apply: true,
    withFlag: true,
    now: NOW,
    log: () => {},
    ...extra,
  };
}

test('backfill: escreve, conta por fonte, e uma segunda corrida não escreve nada', async () => {
  const db = fakeSupabase();
  const report = await backfillRows(ctx(db));
  assert.equal(report.titlesBySource.animeschedule, 1);
  assert.equal(report.episodes.animeschedule, 12);
  assert.equal(report.episodes.undated, 26 + 1, 'Cowboy Bebop sem datas + o filme');
  assert.equal(db.rows.filter((r) => r.anime_id === 'a1').length, 12);
  assert.equal(db.rows.filter((r) => r.anime_id === 'a2' && r.air_date_unknown).length, 26);
  assert.equal(db.rows.filter((r) => r.anime_id === 'a3').length, 0, 'por estrear: nada');
  assert.deepEqual(report.withoutEpisodes, { 'por-estrear': 1 });
  assert.deepEqual(report.exceptions, []);

  const writesBefore = db.writes.length;
  const again = await backfillRows(ctx(db));
  assert.equal(again.inserts + again.updates, 0);
  assert.equal(db.writes.length, writesBefore, 'nenhum pedido de escrita');
});

test('backfill: simulação não escreve, e o cursor avança por lote', async () => {
  const db = fakeSupabase();
  const cursors = [];
  const report = await backfillRows(ctx(db, { apply: false, onBatch: async (id) => cursors.push(id) }));
  assert.equal(db.writes.length, 0);
  assert.equal(db.rows.length, 0);
  assert.equal(report.inserts, 12 + 26 + 1);
  assert.deepEqual(cursors, ['a4']);
});

test('backfill: retomado a meio, acaba no mesmo sítio que de uma vez', async () => {
  const a = fakeSupabase();
  await backfillRows(ctx(a));
  const b = fakeSupabase();
  await backfillRows(ctx(b, { rows: [SOLO, OLD] }));
  await backfillRows(ctx(b, { rows: [SOLO, OLD, SOON, MOVIE].filter((r) => r.id > 'a2') }));
  const norm = (rows) => rows.map((r) => `${r.anime_id}#${r.episode_number}#${r.airing_at}#${r.air_date_unknown}`).sort();
  assert.deepEqual(norm(b.rows), norm(a.rows));
});

test('backfill: nunca duplica um episódio que já existe', async () => {
  const db = fakeSupabase([{ anime_id: 'a1', episode_number: 1, airing_at: '2024-01-06T17:30:00.000Z' }]);
  await backfillRows(ctx(db, { rows: [SOLO] }));
  const keys = db.rows.map((r) => `${r.anime_id}#${r.episode_number}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 12);
});

test('weeksFrom: do início do histórico até à semana de hoje, com anos de 53 semanas', () => {
  const weeks = weeksFrom({ year: 2020, week: 52 }, new Date('2021-01-12T00:00:00Z'));
  assert.deepEqual(weeks.map((w) => `${w.year}-W${w.week}`), ['2020-W52', '2020-W53', '2021-W1', '2021-W2']);
});

test('manamiTotals: mal_id → total, só os positivos', () => {
  const t = manamiTotals([
    { sources: ['https://myanimelist.net/anime/52299', 'https://kitsu.app/anime/46474'], episodes: 12 },
    { sources: ['https://myanimelist.net/anime/1'], episodes: 0 },
    { sources: ['https://anilist.co/anime/5'], episodes: 3 },
  ]);
  assert.deepEqual([...t], [[52299, 12]]);
});

test('kitsuNextUrl: só segue páginas do próprio Kitsu', () => {
  assert.equal(kitsuNextUrl('https://kitsu.app/api/edge/anime/1/episodes?page%5Boffset%5D=20'), 'https://kitsu.app/api/edge/anime/1/episodes?page%5Boffset%5D=20');
  assert.equal(kitsuNextUrl('https://evil.example/x'), null);
  assert.equal(kitsuNextUrl(null), null);
});

test('parseArgs: simulação por omissão; escrever pede --aplicar', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--aplicar']).apply, true);
  assert.equal(parseArgs(['--limite=50']).limit, 50);
  assert.deepEqual([...parseArgs(['--fontes=kitsu']).sources], ['kitsu']);
  assert.deepEqual(parseArgs(['--historico-desde=2022-W10']).historyStart, { year: 2022, week: 10 });
  assert.equal(parseArgs(['--supor-migracao']).assumeMigration, true);
  assert.equal(parseArgs([]).assumeMigration, false);
});

test('motivos de ficar sem episódios e o volume estimado', () => {
  assert.equal(withoutEpisodesReason('upcoming', 'upcoming'), 'por-estrear');
  assert.equal(withoutEpisodesReason('music', 'finished'), 'videoclipe');
  assert.equal(withoutEpisodesReason('episodic', 'airing'), 'no-ar-sem-episodio-datado');
  const r = emptyReport();
  r.inserts = 400_000;
  assert.ok(estimateMegabytes(r) > 90 && estimateMegabytes(r) < 110);
});

test('Kitsu em lote: todos os episódios de cada entrada, pelas relações', async () => {
  const { kitsuBatchFromJson } = await import('../src/episodes-backfill.js');
  const json = {
    data: [
      { id: '1', attributes: { episodeCount: 2, startDate: '1998-04-03', endDate: '1999-04-24' }, relationships: { episodes: { data: [{ id: '10', type: 'episodes' }, { id: '11', type: 'episodes' }] } } },
      { id: '2', attributes: { episodeCount: 1, startDate: '2024-03-08' }, relationships: { episodes: { data: [] } } },
    ],
    included: [
      { id: '10', type: 'episodes', attributes: { number: 1, airdate: '1998-04-03' } },
      { id: '11', type: 'episodes', attributes: { number: 2, airdate: null } },
    ],
  };
  const { entries, incomplete } = kitsuBatchFromJson(json, ['1', '2', '3']);
  assert.deepEqual(entries.get('1').episodes.map((e) => e.attributes.number), [1, 2]);
  assert.equal(entries.get('2').startDate, '2024-03-08');
  assert.equal(entries.get('1').endDate, '1999-04-24', 'o fim da entrada vem para a regra das datas plausíveis');
  assert.equal(entries.get('1').episodeCount, 2);
  assert.deepEqual(entries.get('3'), { episodes: [], startDate: null, endDate: null, episodeCount: null }, 'o que o Kitsu não devolve fica vazio');
  assert.deepEqual(incomplete, []);
});

// ── Revisão do PR #62 ───────────────────────────────────────────────────────

test('isKitsuId: só ids numéricos (213 linhas têm um slug no lugar do id)', async () => {
  const { isKitsuId } = await import('../src/episodes-backfill.js');
  assert.equal(isKitsuId('46231'), true);
  assert.equal(isKitsuId(359), true);
  assert.equal(isKitsuId('one-piece'), false);
  assert.equal(isKitsuId(null), false);
  assert.equal(isKitsuId(''), false);
});

test('manamiHints: o índice do #60 (mal_id → entrada do manami, a primeira ganha)', async () => {
  const { manamiHints } = await import('../src/episodes-backfill.js');
  const echo = { sources: ['https://myanimelist.net/anime/100'], type: 'SPECIAL', tags: ['music'], episodes: 1, duration: { value: 200, unit: 'SECONDS' }, title: 'Echo' };
  const both = { sources: ['https://kitsu.app/anime/5', 'https://myanimelist.net/anime/101', 'https://myanimelist.net/anime/102'], type: 'TV', title: 'Duas' };
  const later = { sources: ['https://myanimelist.net/anime/100'], type: 'TV', title: 'Depois' };
  const hints = manamiHints([echo, both, later]);
  assert.equal(hints.get(100), echo, 'a primeira entrada ganha');
  assert.equal(hints.get(101), both);
  assert.equal(hints.get(102), both, 'todas as fontes do MAL da entrada');
});

test('backfill: um teto de tempo esgotado pára antes do lote seguinte', async () => {
  const db = fakeSupabase();
  const report = await backfillRows({
    supabase: db,
    rows: [SOLO, OLD],
    totals: new Map([[52299, 12], [1, 26]]),
    sources: new Set(),
    apply: true,
    withFlag: true,
    now: NOW,
    deadline: Date.now() - 1,
    log: () => {},
  });
  assert.equal(report.stoppedEarly, true);
  assert.equal(report.titles, 0);
  assert.equal(db.rows.length, 0);
});

test('backfill: o que o #60 vai marcar como videoclipe fica sem episódios', async () => {
  const db = fakeSupabase();
  const clip = { id: 'a9', slug: 'echo', title: 'Echo', status: 'finished', media_type: 'Special', mal_id: 900, external_ids: { mal: 900 } };
  const report = await backfillRows({
    supabase: db,
    rows: [clip],
    totals: new Map([[900, 1]]),
    hints: new Map([[900, { type: 'SPECIAL', tags: ['music'], episodes: 1, duration: { value: 200, unit: 'SECONDS' }, title: 'Echo' }]]),
    sources: new Set(),
    apply: true,
    withFlag: true,
    now: NOW,
    log: () => {},
  });
  assert.equal(db.rows.length, 0);
  assert.equal(report.withoutEpisodes.videoclipe, 1);
});

test('passo incremental: teto de títulos, primeiro os do horário desta corrida', async () => {
  const { backfillRecent } = await import('../src/episodes-backfill.js');
  const mk = (i, created) => ({ id: `r${String(i).padStart(3, '0')}`, slug: `t${i}`, title: `T${i}`, status: 'finished', media_type: 'TV', mal_id: 1000 + i, external_ids: { mal: 1000 + i }, created_at: created });
  const recentes = Array.from({ length: 30 }, (_, i) => mk(i, `2026-11-0${3 + (i % 2)}T00:00:00Z`));
  const doHorario = mk(99, '2026-10-01T00:00:00Z');
  const mudouDeEstado = mk(98, '2025-01-01T00:00:00Z');
  const seen = [];
  const supabase = {
    from(table) {
      const q = {
        _table: table,
        _in: null,
        select() { return q; },
        gte() { return q; },
        order() { return q; },
        eq() { return q; },
        is() { return q; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        in(col, values) { q._in = [col, values]; return q; },
        range(from, to) {
          if (table === 'animes') return Promise.resolve({ data: recentes.slice(from, to + 1), error: null });
          seen.push(...q._in[1]);
          return Promise.resolve({ data: [], error: null });
        },
        upsert() { return Promise.resolve({ error: null }); },
        then(resolve) {
          // `.in('id', …)` sem range: os títulos do horário que não mudaram.
          resolve({ data: table === 'animes' ? [doHorario, mudouDeEstado].filter((r) => q._in[1].includes(r.id)) : [], error: null });
        },
      };
      return q;
    },
  };
  const report = await backfillRecent(supabase, {
    animeIds: [doHorario.id],
    changedIds: [mudouDeEstado.id],
    totals: new Map(),
    maxTitles: 10,
    now: NOW,
    log: () => {},
  });
  assert.equal(report.titles, 10);
  assert.ok(seen.includes(doHorario.id), 'o do horário entra sempre');
  assert.ok(seen.includes(mudouDeEstado.id), 'o que mudou de estado nesta corrida também');
  assert.equal(new Set(seen).size, 10);
});

test('backfill: um episódio sem data que recebe a hora do AnimeSchedule leva os links, sem apagar os das outras linhas', async () => {
  const db = fakeSupabase([
    { anime_id: 'a1', episode_number: 1, airing_at: null, air_date_unknown: true },
    { anime_id: 'a1', episode_number: 2, airing_at: '2024-01-13T00:00:00.000Z', streaming_links: [{ platform: 'Netflix', url: 'https://www.netflix.com/x' }] },
  ]);
  const links = [{ platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/x' }];
  const history = new Map([
    ['solo', new Map([
      [1, { episodeNumber: 1, airingAt: '2024-01-06T17:30:00.000Z', precision: 'exact', streamingLinks: links, delayedFrom: null }],
      [2, { episodeNumber: 2, airingAt: '2024-01-13T17:30:00.000Z', precision: 'exact', streamingLinks: links, delayedFrom: null }],
    ])],
  ]);
  await backfillRows({
    supabase: db,
    rows: [{ ...SOLO, animeschedule_route: 'solo' }],
    animeschedule: { history },
    totals: new Map([[52299, 2]]),
    sources: new Set(['animeschedule']),
    apply: true,
    withFlag: true,
    now: NOW,
    log: () => {},
  });
  const one = db.rows.find((r) => r.episode_number === 1);
  const two = db.rows.find((r) => r.episode_number === 2);
  assert.equal(one.airing_at, '2024-01-06T17:30:00.000Z');
  assert.equal(one.air_date_unknown, false);
  assert.deepEqual(one.streaming_links, links);
  assert.equal(two.airing_at, '2024-01-13T17:30:00.000Z');
  assert.deepEqual(two.streaming_links, [{ platform: 'Netflix', url: 'https://www.netflix.com/x' }], 'a linha que já tinha data fica com os seus links');
});

test('backfill: uma linha já marcada como Music ou PV pelo #60 fica sem episódios, sem pedir nada ao Kitsu', async () => {
  const db = fakeSupabase([{ anime_id: 'm2', episode_number: 1, airing_at: null }]);
  const rows = [
    { id: 'm1', slug: 'echo', title: 'Echo', status: 'finished', media_type: 'Music', mal_id: 901, external_ids: { mal: 901, kitsu: 4242 }, popularity: 5 },
    { id: 'm2', slug: 'pv', title: 'Algo', status: 'finished', media_type: 'PV', mal_id: 902, external_ids: { mal: 902, kitsu: 4243, tvdb: 77 } },
  ];
  const report = await backfillRows({
    supabase: db,
    rows,
    totals: new Map([[901, 3], [902, 12]]),
    sources: new Set(['kitsu', 'tvdb']),
    apply: true,
    withFlag: true,
    now: NOW,
    log: () => {},
  });
  assert.equal(report.inserts + report.updates, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(report.requests.kitsu, 0);
  assert.equal(report.requests.tvdb, 0);
  assert.deepEqual(report.kinds, { music: 2 });
  assert.equal(report.withoutEpisodes.videoclipe, 1, 'a que já tinha um episódio não conta como "sem episódios"');
});

test('teto de tempo: a corrida parada a meio retoma do cursor e acaba igual a uma corrida inteira', async (t) => {
  // 150 títulos terminados: dois lotes de 100 e 50.
  const many = Array.from({ length: 150 }, (_, i) => ({
    id: `t${String(i).padStart(3, '0')}`, slug: `t${i}`, title: `T${i}`, status: 'finished', media_type: 'TV', mal_id: 5000 + i, external_ids: { mal: 5000 + i },
  }));
  const totals = new Map(many.map((r, i) => [r.mal_id, 1 + (i % 3)]));
  const base = { totals, sources: new Set(), apply: true, withFlag: true, now: NOW, log: () => {} };

  const whole = fakeSupabase();
  await backfillRows({ ...base, supabase: whole, rows: many });

  // 1.ª corrida: o relógio passa o teto logo depois do primeiro lote. O
  // `limite` cobria tudo (150), mas a corrida não pode dar-se por acabada.
  const clock = { now: 1_000 };
  t.mock.method(Date, 'now', () => clock.now);
  const db = fakeSupabase();
  const saved = [];
  const first = await backfillRows({
    ...base,
    supabase: db,
    rows: many,
    deadline: 5_000,
    onBatch: async (id) => {
      saved.push(id);
      clock.now = 10_000;
    },
  });
  t.mock.restoreAll();
  assert.equal(first.stoppedEarly, true);
  assert.equal(first.titles, 100);
  assert.deepEqual(saved, ['t099']);
  const one = runOutcome({ after: null, pending: many, rows: many, report: first });
  assert.deepEqual(one, { done: false, cursor: 't099' }, 'nunca "catálogo percorrido até ao fim" nem cursor apagado');

  // 2.ª corrida, como o main(): só o que está depois do cursor.
  const pending = many.filter((r) => r.id > one.cursor);
  const second = await backfillRows({ ...base, supabase: db, rows: pending });
  assert.equal(second.titles, 50);
  assert.deepEqual(runOutcome({ after: one.cursor, pending, rows: pending, report: second }), { done: true, cursor: null });

  const norm = (rows) => rows.map((r) => `${r.anime_id}#${r.episode_number}#${r.airing_at}#${r.air_date_unknown}`).sort();
  assert.deepEqual(norm(db.rows), norm(whole.rows));
  assert.equal(db.rows.length, whole.rows.length);
});

test('runOutcome: parada antes do primeiro lote mantém o cursor; sem teto, o limite decide', () => {
  const rows = [{ id: 'b1' }, { id: 'b2' }];
  assert.deepEqual(runOutcome({ after: 'a9', pending: rows, rows, report: { stoppedEarly: true } }), { done: false, cursor: 'a9' });
  assert.deepEqual(runOutcome({ after: null, pending: rows, rows, report: { stoppedEarly: true } }), { done: false, cursor: null });
  assert.deepEqual(runOutcome({ pending: [...rows, { id: 'b3' }], rows, report: {} }), { done: false, cursor: 'b2' });
  assert.deepEqual(runOutcome({ pending: rows, rows, report: {} }), { done: true, cursor: null });
});

test('parseArgs: --minutos é o teto de relógio (nada por omissão)', () => {
  assert.equal(parseArgs([]).minutes, null);
  assert.equal(parseArgs(['--minutos=45']).minutes, 45);
  assert.equal(parseArgs(['--minutos=0']).minutes, null);
  assert.equal(parseArgs(['--minutos=abc']).minutes, null);
});
