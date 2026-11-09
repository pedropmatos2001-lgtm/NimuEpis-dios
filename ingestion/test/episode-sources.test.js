import test from 'node:test';
import assert from 'node:assert/strict';

import {
  animescheduleCatalogueIndex,
  animescheduleHistoryIndex,
  dayToIso,
  kitsuEpisodesIndex,
  precisionOf,
  tvdbEpisodesIndex,
} from '../src/episode-sources.js';

test('precisionOf: hora exata, só o dia, nada', () => {
  assert.equal(precisionOf('2024-01-13T17:30:00.000Z'), 'exact');
  assert.equal(precisionOf('2024-01-13T00:00:00.000Z'), 'day');
  assert.equal(precisionOf(null), 'none');
  assert.equal(precisionOf('lixo'), 'none');
});

test('dayToIso: o dia à meia-noite UTC, e nada para lixo ou anos impossíveis', () => {
  assert.equal(dayToIso('2024-01-07'), '2024-01-07T00:00:00.000Z');
  assert.equal(dayToIso('2024-01-06T00:00:00Z'), '2024-01-06T00:00:00.000Z');
  assert.equal(dayToIso(''), null);
  assert.equal(dayToIso(null), null);
  assert.equal(dayToIso('0001-01-01'), null);
});

test('AnimeSchedule, histórico: o sub manda, o raw preenche, e a semana mais recente ganha', () => {
  const weeks = [
    {
      // Semana 1 do Solo Leveling: o sub tem o ep. 1, o raw tem o 1 e um especial sem sub.
      sub: [{ route: 'solo-leveling', episodeNumber: 1, episodeDate: '2024-01-06T17:30:00Z', streams: { crunchyroll: 'series/GDKHZEJ0K' } }],
      raw: [
        { route: 'solo-leveling', episodeNumber: 1, episodeDate: '2024-01-06T15:30:00Z' },
        { route: 'so-raw', episodeNumber: 3, episodeDate: '2024-01-07T15:00:00Z' },
      ],
    },
    {
      sub: [
        { route: 'solo-leveling', episodeNumber: 2, episodeDate: '2024-01-13T17:30:00Z' },
        // Adiado: o mesmo número aparece mais tarde, com a data nova.
        { route: 'so-raw', episodeNumber: 3, episodeDate: '2024-01-14T15:00:00Z', delayedFrom: '2024-01-07T15:00:00Z' },
        { route: 'sem-data', episodeNumber: 1, episodeDate: '0001-01-01T00:00:00Z' },
      ],
      raw: [],
    },
  ];
  const idx = animescheduleHistoryIndex(weeks);
  const solo = idx.get('solo-leveling');
  assert.equal(solo.get(1).airingAt, '2024-01-06T17:30:00.000Z');
  assert.equal(solo.get(1).precision, 'exact');
  assert.equal(solo.get(1).streamingLinks[0].platform, 'Crunchyroll');
  assert.equal(solo.get(2).airingAt, '2024-01-13T17:30:00.000Z');
  assert.equal(idx.get('so-raw').get(3).airingAt, '2024-01-14T15:00:00.000Z');
  assert.equal(idx.get('so-raw').get(3).delayedFrom, '2024-01-07T15:00:00.000Z');
  assert.equal(idx.has('sem-data'), false);
});

test('AnimeSchedule, catálogo: mal_id, estreia só com o dia, total e videoclipes', () => {
  const { byRoute, routeByMal } = animescheduleCatalogueIndex([
    { route: 'solo-leveling', websites: { mal: 'myanimelist.net/anime/52299' }, mediaTypes: [{ name: 'TV' }], premier: '2024-01-06T00:00:00Z', episodes: 12 },
    { route: 'the-boyz-echo', websites: { mal: 'https://myanimelist.net/anime/60000' }, mediaTypes: [{ name: 'Music' }], premier: '0001-01-01T00:00:00Z', episodes: 1 },
    { route: 'outra-rota-mesmo-mal', websites: { mal: 'myanimelist.net/anime/52299' }, mediaTypes: [{ name: 'TV' }] },
    { route: 'filme', websites: {}, mediaTypes: [{ name: 'Movie' }], premier: '2024-03-08T00:00:00Z', episodes: 1 },
  ]);
  assert.equal(routeByMal.get(52299), 'solo-leveling');
  assert.equal(byRoute.get('solo-leveling').premier, '2024-01-06T00:00:00.000Z');
  assert.equal(byRoute.get('solo-leveling').episodes, 12);
  assert.equal(byRoute.get('the-boyz-echo').music, true);
  assert.equal(byRoute.get('the-boyz-echo').premier, null);
  assert.equal(byRoute.get('filme').movie, true);
  assert.equal(byRoute.get('filme').mal, null);
});

test('Kitsu: número e dia; sem número fora; um repetido fica com a data', () => {
  const idx = kitsuEpisodesIndex([
    { attributes: { number: 1, airdate: '1998-04-03' } },
    { attributes: { number: 2, airdate: null } },
    { attributes: { number: 2, airdate: '1998-04-10' } },
    { attributes: { number: 2, airdate: null } },
    { attributes: { number: null, airdate: '1998-04-17' } },
    { attributes: { number: 0, airdate: '1998-04-17' } },
  ]);
  assert.deepEqual([...idx.keys()], [1, 2]);
  assert.equal(idx.get(1).airingAt, '1998-04-03T00:00:00.000Z');
  assert.equal(idx.get(1).precision, 'day');
  assert.equal(idx.get(2).airingAt, '1998-04-10T00:00:00.000Z');
});

test('TVDB: só quando o id não é partilhado e a contagem bate com o total', () => {
  const eps = [
    { seasonNumber: 0, airedIso: '2024-01-01T00:00:00.000Z' },
    { seasonNumber: 1, airedIso: '2024-01-07T00:00:00.000Z' },
    { seasonNumber: 1, airedIso: null },
  ];
  assert.equal(tvdbEpisodesIndex(eps, { total: 2, sharedId: false }).get(1).airingAt, '2024-01-07T00:00:00.000Z');
  assert.equal(tvdbEpisodesIndex(eps, { total: 2, sharedId: false }).get(2).airingAt, null);
  assert.equal(tvdbEpisodesIndex(eps, { total: 2, sharedId: true }).size, 0);
  assert.equal(tvdbEpisodesIndex(eps, { total: 12, sharedId: false }).size, 0);
  assert.equal(tvdbEpisodesIndex(eps, { total: null, sharedId: false }).size, 0);
});

test('Kitsu, datas implausíveis: o ep. 2 do Yu Yu Hakusho (1994 numa série de 1992) sai e fica sem data', async () => {
  const { plausibleKitsuIndex, kitsuEpisodesIndex } = await import('../src/episode-sources.js');
  const ep = (number, airdate) => ({ attributes: { number, airdate } });
  const idx = kitsuEpisodesIndex([
    ep(1, '1992-10-10'),
    ep(2, '1994-04-09'),
    ep(3, '1992-10-24'),
    ep(4, '1992-10-31'),
    ep(5, '1992-11-07'),
    ep(6, '1992-11-14'),
  ]);
  const stats = { titles: 0, dated: 0, dropped: 0, titlesDropped: 0, titlesDiscarded: 0, byReason: {} };
  const out = plausibleKitsuIndex(idx, { startDate: '1992-10-10', endDate: '1995-01-07', year: 1992, stats });
  assert.equal(out.get(2).airingAt, null);
  assert.equal(out.get(2).precision, 'none');
  assert.equal(out.get(3).airingAt, '1992-10-24T00:00:00.000Z');
  assert.equal(out.size, 6, 'o número fica; só o dia sai');
  assert.deepEqual(stats.byReason, { 'fora-de-ordem': 1 });
  assert.equal(stats.dropped, 1);
});

test('Kitsu, datas implausíveis: antes do início, depois do fim, antes do ano; e a entrada inteira fora acima de 1/4', async () => {
  const { plausibleKitsuIndex, kitsuEpisodesIndex } = await import('../src/episode-sources.js');
  const ep = (number, airdate) => ({ attributes: { number, airdate } });
  const weekly = (n, start) => ep(n, new Date(Date.parse(start) + (n - 1) * 7 * 86_400_000).toISOString().slice(0, 10));
  const twelve = Array.from({ length: 12 }, (_, i) => weekly(i + 1, '2024-01-06'));
  // Um só episódio fora do fim (a data de uma reposição): sai só ele.
  const tail = kitsuEpisodesIndex([...twelve.slice(0, 11), ep(12, '2025-06-01')]);
  const a = plausibleKitsuIndex(tail, { startDate: '2024-01-06', endDate: '2024-03-23' });
  assert.equal(a.get(12).airingAt, null);
  assert.equal(a.get(11).airingAt, '2024-03-16T00:00:00.000Z');
  // Antes do início, com a semana de folga: o 1 três dias antes fica.
  const early = kitsuEpisodesIndex([ep(1, '2024-01-03'), ...twelve.slice(1)]);
  assert.equal(plausibleKitsuIndex(early, { startDate: '2024-01-06' }).get(1).airingAt, '2024-01-03T00:00:00.000Z');
  const tooEarly = kitsuEpisodesIndex([ep(1, '2023-06-01'), ...twelve.slice(1)]);
  assert.equal(plausibleKitsuIndex(tooEarly, { startDate: '2024-01-06' }).get(1).airingAt, null);
  // Sem startDate, o ano do catálogo: antes de dezembro do ano anterior sai.
  assert.equal(plausibleKitsuIndex(tooEarly, { year: 2024 }).get(1).airingAt, null);
  // Mais de um quarto implausível: nenhuma data da entrada fica.
  const mess = kitsuEpisodesIndex(twelve.map((e, i) => (i % 3 === 0 ? ep(i + 1, '2030-01-01') : e)));
  const stats = { titles: 0, dated: 0, dropped: 0, titlesDropped: 0, titlesDiscarded: 0, byReason: {} };
  const b = plausibleKitsuIndex(mess, { startDate: '2024-01-06', endDate: '2024-03-23', stats });
  assert.ok([...b.values()].every((e) => e.airingAt === null));
  assert.equal(stats.titlesDiscarded, 1);
  assert.equal(stats.dropped, 12);
  // Datas iguais (estreia de vários episódios no mesmo dia) não são "fora de ordem".
  const premiere = kitsuEpisodesIndex([ep(1, '2023-09-29'), ep(2, '2023-09-29'), ep(3, '2023-09-29'), ep(4, '2023-10-06')]);
  assert.ok([...plausibleKitsuIndex(premiere, { startDate: '2023-09-29' }).values()].every((e) => e.airingAt !== null));
});

test('longestNonDecreasing: a maior sequência que não desce', async () => {
  const { longestNonDecreasing } = await import('../src/episode-sources.js');
  assert.deepEqual(longestNonDecreasing([1, 9, 2, 3, 3, 4]), [0, 2, 3, 4, 5]);
  assert.deepEqual(longestNonDecreasing([]), []);
  assert.deepEqual(longestNonDecreasing([5]), [0]);
});

test('Kitsu, numeração desviada: o Yu Yu Hakusho real (ep. 6 com a data da estreia) perde TODAS as datas', async () => {
  const { plausibleKitsuIndex, kitsuEpisodesIndex } = await import('../src/episode-sources.js');
  // Como o Kitsu o tem (medido a 2026-11-04): 1 a 5 com datas de 1993-1994, e
  // do 6 em diante semanal desde a estreia, 1992-10-10. As datas vêm todas
  // cinco episódios adiantadas, e o ep. 112 fica em 1994-11-12, quase dois
  // meses antes do fim (1995-01-07).
  const eps = [
    ['1993-07-10'], ['1994-04-09'], ['1994-04-09'], ['1994-10-05'], ['1994-10-05'],
  ].map(([d], i) => ({ attributes: { number: i + 1, airdate: d } }));
  for (let n = 6; n <= 112; n += 1) {
    eps.push({ attributes: { number: n, airdate: new Date(Date.UTC(1992, 9, 10) + (n - 6) * 7 * 86_400_000).toISOString().slice(0, 10) } });
  }
  const stats = { titles: 0, dated: 0, dropped: 0, titlesDropped: 0, titlesDiscarded: 0, byReason: {} };
  const out = plausibleKitsuIndex(kitsuEpisodesIndex(eps), {
    startDate: '1992-10-10',
    endDate: '1995-01-07',
    year: 1992,
    episodeCount: 112,
    stats,
  });
  assert.ok([...out.values()].every((e) => e.airingAt === null), 'nenhuma data do Yu Yu Hakusho fica');
  assert.equal(stats.byReason['numeracao-desviada'], 1);
  assert.equal(stats.titlesDiscarded, 1);
});

test('Kitsu, fim desalinhado: o último episódio meses antes do fim da entrada tira as datas todas', async () => {
  const { plausibleKitsuIndex, kitsuEpisodesIndex } = await import('../src/episode-sources.js');
  const weekly = (count, start) =>
    Array.from({ length: count }, (_, i) => ({
      attributes: { number: i + 1, airdate: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10) },
    }));
  // 26 semanais desde 2001-04-07 acabam a 2001-09-29: com o fim certo, fica tudo.
  const ok = plausibleKitsuIndex(kitsuEpisodesIndex(weekly(26, '2001-04-07')), {
    startDate: '2001-04-07',
    endDate: '2001-09-29',
    episodeCount: 26,
  });
  assert.ok([...ok.values()].every((e) => e.airingAt !== null));
  // Os mesmos 26 metidos em 13 semanas (datas repetidas): o 26 fica três meses antes do fim.
  const squashed = weekly(26, '2001-04-07').map((e, i) => ({ attributes: { ...e.attributes, airdate: weekly(13, '2001-04-07')[i >> 1].attributes.airdate } }));
  const bad = plausibleKitsuIndex(kitsuEpisodesIndex(squashed), {
    startDate: '2001-04-07',
    endDate: '2001-09-29',
    episodeCount: 26,
  });
  assert.ok([...bad.values()].every((e) => e.airingAt === null));
  // Sem a contagem (ou com a lista incompleta), não se decide pelo fim.
  const partial = plausibleKitsuIndex(kitsuEpisodesIndex(weekly(13, '2001-04-07')), {
    startDate: '2001-04-07',
    endDate: '2001-09-29',
    episodeCount: 26,
  });
  assert.ok([...partial.values()].every((e) => e.airingAt !== null));
  // Um especial com início = fim e episódios em streaming depois: não é "depois do fim".
  const special = plausibleKitsuIndex(kitsuEpisodesIndex(weekly(1, '2025-11-07')), {
    startDate: '2025-10-17',
    endDate: '2025-10-17',
  });
  assert.equal(special.get(1).airingAt, '2025-11-07T00:00:00.000Z');
});
