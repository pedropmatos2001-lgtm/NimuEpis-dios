import test from 'node:test';
import assert from 'node:assert/strict';
import {
  airedEpisodeIds,
  chunk,
  dedupeByKey,
  dedupeEpisodes,
  isoWeek,
  isoWeeksWindow,
} from '../src/util.js';

test('isoWeek matches known ISO-8601 week vectors', () => {
  assert.deepEqual(isoWeek(new Date('2026-01-01T12:00:00Z')), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek(new Date('2016-01-01T00:00:00Z')), { year: 2015, week: 53 });
  assert.deepEqual(isoWeek(new Date('2015-12-31T00:00:00Z')), { year: 2015, week: 53 });
  assert.deepEqual(isoWeek(new Date('2019-12-30T00:00:00Z')), { year: 2020, week: 1 });
  assert.deepEqual(isoWeek(new Date('2020-06-15T00:00:00Z')), { year: 2020, week: 25 });
});

test('isoWeeksWindow spans behind→ahead without duplicates, across year ends', () => {
  const window = isoWeeksWindow(new Date('2026-07-29T00:00:00Z'), 1, 2);
  assert.equal(window.length, 4);
  const weeks = window.map((w) => w.week);
  assert.deepEqual(weeks, [weeks[0], weeks[0] + 1, weeks[0] + 2, weeks[0] + 3]);
  // Year-end rollover: ISO year flips mid-window.
  const rollover = isoWeeksWindow(new Date('2026-12-28T00:00:00Z'), 1, 2);
  assert.equal(rollover.length, 4);
  assert.equal(new Set(rollover.map((w) => `${w.year}-${w.week}`)).size, 4);
});

test('chunk splits arrays for batched upserts', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
});

test('dedupeByKey keeps the last row per key and skips null keys', () => {
  const rows = [
    { route: 'a', v: 1 },
    { route: 'b', v: 2 },
    { route: 'a', v: 3 },
    { route: null, v: 4 },
  ];
  assert.deepEqual(dedupeByKey(rows, (r) => r.route), [
    { route: 'a', v: 3 },
    { route: 'b', v: 2 },
  ]);
});

test('airedEpisodeIds keeps only already-aired rows with a usable id + date', () => {
  const now = new Date('2026-07-31T12:00:00Z');
  const rows = [
    { id: 'aired-yesterday', airing_at: '2026-07-30T15:00:00Z' }, // aired → kept
    { id: 'aired-now', airing_at: '2026-07-31T12:00:00Z' }, // == now → kept (boundary)
    { id: 'future', airing_at: '2026-08-05T15:00:00Z' }, // not out yet → dropped
    { id: 'no-date', airing_at: null }, // no air time → dropped
    { id: '', airing_at: '2026-07-01T00:00:00Z' }, // empty id → dropped
    { airing_at: '2026-07-01T00:00:00Z' }, // missing id → dropped
    { id: 'bad-date', airing_at: 'not-a-date' }, // unparseable → dropped
    null, // defensive: skip nullish rows
  ];
  assert.deepEqual(airedEpisodeIds(rows, now), ['aired-yesterday', 'aired-now']);
});

test('airedEpisodeIds is empty for nullish / empty input', () => {
  assert.deepEqual(airedEpisodeIds(undefined), []);
  assert.deepEqual(airedEpisodeIds([]), []);
});

test('dedupeEpisodes keeps the most complete row per (anime_id, episode_number)', () => {
  const rows = [
    { anime_id: 'A', episode_number: 1, streaming_links: [{ platform: 'X', url: 'u' }] },
    { anime_id: 'A', episode_number: 1, streaming_links: [] }, // fewer links → loses
    { anime_id: 'A', episode_number: 2, streaming_links: [] },
    { anime_id: 'B', episode_number: 1, streaming_links: [] },
  ];
  const out = dedupeEpisodes(rows);
  assert.equal(out.length, 3);
  const a1 = out.find((r) => r.anime_id === 'A' && r.episode_number === 1);
  assert.equal(a1.streaming_links.length, 1);
});

test('dedupeEpisodes ties resolve last-wins (coherent with dedupeByKey)', () => {
  const rows = [
    { anime_id: 'A', episode_number: 1, streaming_links: [], tag: 'first' },
    { anime_id: 'A', episode_number: 1, streaming_links: [], tag: 'second' },
  ];
  const out = dedupeEpisodes(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].tag, 'second');
});

test('mergeTimetables: o sub manda, o raw só entra onde o sub não tem o episódio', async () => {
  const { mergeTimetables } = await import('../src/util.js');
  const sub = [{ route: 'a', episodeNumber: 5, episodeDate: 'sub-a5' }];
  const raw = [
    { route: 'a', episodeNumber: 5, episodeDate: 'raw-a5' },
    { route: 'b', episodeNumber: 1, episodeDate: 'raw-b1' },
    { route: 'b', episodeNumber: 1, episodeDate: 'raw-b1-dup' },
    { episodeNumber: 1 },
  ];
  const out = mergeTimetables(sub, raw);
  assert.deepEqual(out.map((e) => e.episodeDate), ['sub-a5', 'raw-b1']);
  assert.deepEqual(mergeTimetables(undefined, undefined), []);
});

test('staleFutureEpisodeIds: só desmarca o futuro, dentro da janela, que a fonte deixou de anunciar', async () => {
  const { staleFutureEpisodeIds } = await import('../src/util.js');
  const timetableKeys = new Set(['A#14', 'B#9']);
  const now = '2026-09-22T12:00:00Z';
  const windowEnd = '2026-10-11T23:59:00Z';
  const dbRows = [
    { id: 'a14', anime_id: 'A', episode_number: 14, airing_at: '2026-10-09T16:30:00Z' }, // no horário
    { id: 'a15', anime_id: 'A', episode_number: 15, airing_at: '2026-10-09T15:00:00Z' }, // velho: sai
    { id: 'b10', anime_id: 'B', episode_number: 10, airing_at: '2026-09-26T14:30:00Z' }, // pausa: sai
    { id: 'a16', anime_id: 'A', episode_number: 16, airing_at: '2026-10-20T15:00:00Z' }, // fora da janela: fica
    { id: 'a13', anime_id: 'A', episode_number: 13, airing_at: '2026-09-20T15:00:00Z' }, // passado: fica
    { id: 'c1', anime_id: 'C', episode_number: 1, airing_at: '2026-10-01T15:00:00Z' }, // série fora do horário: fica
    { id: 'b12', anime_id: 'B', episode_number: 12, airing_at: null }, // sem data: fica
  ];
  assert.deepEqual(staleFutureEpisodeIds({ dbRows, timetableKeys, now, windowEnd }).sort(), ['a15', 'b10']);
  assert.deepEqual(staleFutureEpisodeIds({ dbRows, timetableKeys, now: 'x', windowEnd }), []);
});

test('staleFutureEpisodeIds: o adiamento arrastado não segura as projeções de uma série em pausa', async () => {
  // O One Piece a 2026-10-02: o 1180 (27/09) ainda no horário, o 1181 e o 1182
  // projetados para 4 e 11/10, todos com o adiamento de 05/07 arrastado pela
  // AnimeSchedule, que já diz "Episodes 1181 and further will continue in April 2027".
  const { staleFutureEpisodeIds } = await import('../src/util.js');
  const arrastado = '2026-07-05T00:00:00Z';
  const dbRows = [
    { id: 'op1180', anime_id: 'OP', episode_number: 1180, airing_at: '2026-09-27T16:00:00Z', delayed_from: arrastado },
    { id: 'op1181', anime_id: 'OP', episode_number: 1181, airing_at: '2026-10-04T16:00:00Z', delayed_from: arrastado },
    { id: 'op1182', anime_id: 'OP', episode_number: 1182, airing_at: '2026-10-11T16:00:00Z', delayed_from: arrastado },
    // um adiamento verdadeiro que a fonte ainda anuncia, na data nova: fica
    { id: 'b11', anime_id: 'B', episode_number: 11, airing_at: '2026-10-03T14:30:00Z', delayed_from: '2026-09-27T14:30:00Z' },
  ];
  const stale = staleFutureEpisodeIds({
    dbRows,
    timetableKeys: new Set(['OP#1180', 'B#11']),
    now: '2026-10-02T08:00:00Z',
    windowEnd: '2026-10-18T16:21:00Z',
  });
  assert.deepEqual(stale.sort(), ['op1181', 'op1182']);
});

test('staleFutureEpisodeIds: uma série seguida pela fonte mas fora do horário só perde as datas se for dita ausente', async () => {
  const { staleFutureEpisodeIds } = await import('../src/util.js');
  const dbRows = [
    { id: 'pd425', anime_id: 'PD', episode_number: 425, airing_at: '2026-10-04T09:00:00Z', delayed_from: '2026-08-02T09:00:00Z' },
    { id: 'pd430', anime_id: 'PD', episode_number: 430, airing_at: '2026-11-08T09:00:00Z' }, // fora da janela: fica
    { id: 'tv1', anime_id: 'TV', episode_number: 26, airing_at: '2026-10-04T00:00:00Z' }, // sem rota (não é dita ausente): fica
  ];
  const base = { dbRows, timetableKeys: new Set(['A#1']), now: '2026-10-02T08:00:00Z', windowEnd: '2026-10-18T16:21:00Z' };
  assert.deepEqual(staleFutureEpisodeIds(base), []);
  assert.deepEqual(staleFutureEpisodeIds({ ...base, absentAnimeIds: new Set(['PD']) }), ['pd425']);
});

test('scheduleNoteChanges: uma frase por ficha, e só as que mudaram', async () => {
  const { scheduleNoteChanges } = await import('../src/util.js');
  const pausa = 'Episodes 1181 and further will continue in April 2027.';
  const pairs = [
    { id: 'op', note: pausa },
    { id: 'franquia', note: null }, // a temporada antiga, sem frase
    { id: 'franquia', note: 'Episode 5 has been delayed.' }, // a nova: a frase ganha
    { id: 'igual', note: 'Sem mudança.' },
    { id: 'limpa', note: null }, // a fonte tirou a frase: limpa-se
    { id: null, note: 'sem ficha' },
  ];
  const current = new Map([['igual', 'Sem mudança.'], ['limpa', 'Antiga.'], ['op', null]]);
  assert.deepEqual(scheduleNoteChanges(pairs, current), [
    { id: 'op', note: pausa },
    { id: 'franquia', note: 'Episode 5 has been delayed.' },
    { id: 'limpa', note: null },
  ]);
});
