import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAnime, planAnimeEpisodes, sourceAligned } from '../src/episode-merge.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const ID = '00000000-0000-0000-0000-000000000001';

const exact = (n, iso) => [n, { episodeNumber: n, airingAt: iso, precision: 'exact', streamingLinks: [{ platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/x' }], delayedFrom: null }];
const day = (n, iso) => [n, { episodeNumber: n, airingAt: iso, precision: 'day' }];

/** Solo Leveling S1: 12 episódios, sábados de 6 de janeiro a 30 de março de 2024. */
function soloAs() {
  const m = new Map();
  for (let n = 1; n <= 12; n += 1) {
    m.set(...exact(n, new Date(Date.UTC(2024, 0, 6 + (n - 1) * 7, 17, 30)).toISOString()));
  }
  return m;
}

test('classifyAnime: videoclipe, por estrear, sem estado, filme, série', () => {
  assert.equal(classifyAnime({ status: 'finished', media_type: 'Special' }, { music: true }), 'music');
  assert.equal(classifyAnime({ status: 'finished', media_type: 'Music' }), 'music');
  assert.equal(classifyAnime({ status: 'upcoming', media_type: 'TV' }), 'upcoming');
  assert.equal(classifyAnime({ status: null, media_type: 'TV' }), 'unknown');
  assert.equal(classifyAnime({ status: 'finished', media_type: 'Movie' }), 'movie');
  assert.equal(classifyAnime({ status: 'finished', media_type: 'ONA' }), 'episodic');
});

test('Solo Leveling S1: os 12 episódios do histórico do AnimeSchedule, com hora e streams', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { animeschedule: soloAs() },
    total: 12,
    now: NOW,
  });
  assert.equal(plan.inserts.length, 12);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.counts.animeschedule, 12);
  assert.equal(plan.counts.undated, 0);
  assert.equal(plan.inserts[0].airing_at, '2024-01-06T17:30:00.000Z');
  assert.equal(plan.inserts[0].streaming_links[0].platform, 'Crunchyroll');
  assert.equal(plan.inserts[0].air_date_unknown, false);
});

test('prioridade: hora exata do AnimeSchedule > dia do Kitsu > dia do TVDB; em empate, a ordem das fontes', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: {
      animeschedule: new Map([exact(1, '2024-01-06T17:30:00.000Z')]),
      kitsu: new Map([day(1, '2024-01-06T00:00:00.000Z'), day(2, '2024-01-13T00:00:00.000Z')]),
      tvdb: new Map([day(2, '2024-01-13T00:00:00.000Z'), day(3, '2024-01-20T00:00:00.000Z')]),
    },
    total: 3,
    now: NOW,
  });
  const by = Object.fromEntries(plan.inserts.map((r) => [r.episode_number, r.airing_at]));
  assert.equal(by[1], '2024-01-06T17:30:00.000Z');
  assert.equal(by[2], '2024-01-13T00:00:00.000Z');
  assert.equal(by[3], '2024-01-20T00:00:00.000Z');
  assert.deepEqual(plan.counts, { animeschedule: 1, premiere: 0, kitsu: 1, tvdb: 1, undated: 0, flagged: 0, upgraded: 0 });
});

test('sem data em fonte nenhuma: 1..total sem data e com a marca', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { kitsu: new Map([day(1, '1998-04-03T00:00:00.000Z')]) },
    total: 26,
    now: NOW,
  });
  assert.equal(plan.inserts.length, 26);
  assert.equal(plan.counts.kitsu, 1);
  assert.equal(plan.counts.undated, 25);
  const e2 = plan.inserts.find((r) => r.episode_number === 2);
  assert.deepEqual(e2, {
    anime_id: ID,
    episode_number: 2,
    airing_at: null,
    streaming_links: [],
    delayed_from: null,
    air_date_unknown: true,
  });
});

test('sem a coluna na base: só entram os episódios com data, nenhum sem data', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { kitsu: new Map([day(1, '1998-04-03T00:00:00.000Z')]) },
    total: 26,
    now: NOW,
    withFlag: false,
  });
  assert.equal(plan.inserts.length, 1);
  assert.equal('air_date_unknown' in plan.inserts[0], false);
});

test('idempotente: a segunda corrida sobre o resultado da primeira não escreve nada', () => {
  const input = {
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { animeschedule: soloAs(), kitsu: new Map([day(13, '2024-04-01T00:00:00.000Z')]) },
    total: 12,
    now: NOW,
  };
  const first = planAnimeEpisodes({ ...input, sources: { animeschedule: soloAs() } });
  const existing = first.inserts.map(({ episode_number, airing_at, air_date_unknown }) => ({ episode_number, airing_at, air_date_unknown }));
  const second = planAnimeEpisodes({ ...input, sources: { animeschedule: soloAs() }, existing });
  assert.equal(second.inserts.length, 0);
  assert.equal(second.updates.length, 0);

  const undatedFirst = planAnimeEpisodes({ anime: input.anime, total: 4, now: NOW });
  const again = planAnimeEpisodes({
    anime: input.anime,
    total: 4,
    now: NOW,
    existing: undatedFirst.inserts.map((r) => ({ episode_number: r.episode_number, airing_at: null, air_date_unknown: true })),
  });
  assert.equal(again.inserts.length + again.updates.length, 0);
});

test('nunca troca uma data melhor por uma pior; sobe a precisão quando pode', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    existing: [
      { episode_number: 1, airing_at: '2024-01-06T17:30:00.000Z', air_date_unknown: false }, // hora exata
      { episode_number: 2, airing_at: '2024-01-13T00:00:00.000Z', air_date_unknown: false }, // só o dia (TVDB)
      { episode_number: 3, airing_at: null, air_date_unknown: true }, // sem data, marcado
      { episode_number: 4, airing_at: null, air_date_unknown: false }, // antigo, sem data e sem marca
    ],
    sources: {
      kitsu: new Map([day(1, '2024-01-06T00:00:00.000Z'), day(3, '2024-01-20T00:00:00.000Z')]),
      animeschedule: new Map([exact(2, '2024-01-13T17:30:00.000Z')]),
    },
    total: 4,
    now: NOW,
  });
  assert.equal(plan.inserts.length, 0);
  const by = Object.fromEntries(plan.updates.map((r) => [r.episode_number, r]));
  assert.equal(by[1], undefined, 'a hora exata fica');
  assert.equal(by[2].airing_at, '2024-01-13T17:30:00.000Z');
  assert.equal(by[2].air_date_unknown, false);
  assert.equal(by[3].airing_at, '2024-01-20T00:00:00.000Z');
  assert.equal(by[3].air_date_unknown, false);
  assert.deepEqual(by[4], { anime_id: ID, episode_number: 4, airing_at: null, air_date_unknown: true });
  assert.equal(plan.counts.upgraded, 1);
  assert.equal(plan.counts.flagged, 1);
});

test('um episódio com data no futuro nunca é tocado (é da ingestão semanal)', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    existing: [{ episode_number: 1, airing_at: '2026-12-01T00:00:00.000Z' }],
    sources: { animeschedule: new Map([exact(1, '2024-01-06T17:30:00.000Z')]) },
    total: 1,
    now: NOW,
  });
  assert.equal(plan.updates.length + plan.inserts.length, 0);
});

test('no ar: só até ao último que já saiu; os futuros e os seguintes ficam para a ingestão semanal', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'airing', media_type: 'TV' },
    existing: [
      { episode_number: 5, airing_at: '2026-10-28T15:00:00.000Z' },
      { episode_number: 6, airing_at: '2026-11-11T15:00:00.000Z' },
      { episode_number: 7, airing_at: null },
    ],
    sources: { kitsu: new Map([day(1, '2026-10-07T00:00:00.000Z'), day(8, '2026-12-01T00:00:00.000Z')]) },
    total: 12,
    now: NOW,
  });
  assert.deepEqual(plan.inserts.map((r) => [r.episode_number, r.airing_at, r.air_date_unknown]), [
    [1, '2026-10-07T00:00:00.000Z', false],
    [2, null, true],
    [3, null, true],
    [4, null, true],
  ]);
  assert.equal(plan.updates.length, 0, 'o 7 sem data é futuro, não se marca');
});

test('por estrear: nada sem data; só um episódio que já saiu com data', () => {
  const vazio = planAnimeEpisodes({ anime: { id: ID, status: 'upcoming', media_type: 'TV' }, total: 12, now: NOW });
  assert.equal(vazio.inserts.length, 0);
  const comProva = planAnimeEpisodes({
    anime: { id: ID, status: 'upcoming', media_type: 'TV' },
    sources: { kitsu: new Map([day(1, '2026-10-01T00:00:00.000Z'), day(2, '2026-12-01T00:00:00.000Z')]) },
    premiere: '2026-10-01T00:00:00.000Z',
    total: 12,
    now: NOW,
  });
  assert.deepEqual(comProva.inserts.map((r) => r.episode_number), [1]);
});

test('filme: um só registo, com a estreia do catálogo, ou sem data com a marca', () => {
  const comData = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'Movie' },
    premiere: '2024-03-08T00:00:00.000Z',
    total: 1,
    now: NOW,
  });
  assert.deepEqual(comData.inserts.map((r) => [r.episode_number, r.airing_at, r.air_date_unknown]), [
    [1, '2024-03-08T00:00:00.000Z', false],
  ]);
  const semData = planAnimeEpisodes({ anime: { id: ID, status: 'finished', media_type: 'Movie' }, total: 1, now: NOW });
  assert.deepEqual(semData.inserts.map((r) => [r.episode_number, r.air_date_unknown]), [[1, true]]);
});

test('videoclipe: nada', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'Special' },
    music: true,
    total: 1,
    premiere: '2024-03-08T00:00:00.000Z',
    now: NOW,
  });
  assert.equal(plan.kind, 'music');
  assert.equal(plan.inserts.length, 0);
});

test('fonte com números acima do total é de outra entrada e fica de fora', () => {
  const as = new Map();
  for (let n = 13; n <= 24; n += 1) as.set(...exact(n, new Date(Date.UTC(2024, 3, 6 + (n - 13) * 7, 17)).toISOString()));
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { animeschedule: as },
    total: 12,
    now: NOW,
  });
  assert.deepEqual(plan.rejected, [{ source: 'animeschedule', reason: 'numeros-acima-do-total' }]);
  assert.equal(plan.counts.undated, 12);
});

test('fonte com datas que não batem com as que já temos fica de fora', () => {
  const existing = [1, 2, 3].map((n) => ({ episode_number: n, airing_at: new Date(Date.UTC(2024, 0, 6 + (n - 1) * 7, 17)).toISOString() }));
  const kitsu = new Map([1, 2, 3, 4].map((n) => day(n, new Date(Date.UTC(2021, 0, 6 + (n - 1) * 7)).toISOString())));
  const plan = planAnimeEpisodes({ anime: { id: ID, status: 'finished', media_type: 'TV' }, existing, sources: { kitsu }, total: 4, now: NOW });
  assert.deepEqual(plan.rejected, [{ source: 'kitsu', reason: 'datas-desalinhadas' }]);
  assert.deepEqual(plan.inserts.map((r) => [r.episode_number, r.air_date_unknown]), [[4, true]]);
});

test('sourceAligned tolera um dia de fuso', () => {
  const ref = new Map([[1, '2024-01-06T17:30:00.000Z']]);
  assert.equal(sourceAligned(new Map([day(1, '2024-01-07T00:00:00.000Z')]), ref), true);
  assert.equal(sourceAligned(new Map([day(1, '2024-01-20T00:00:00.000Z')]), ref), false);
  assert.equal(sourceAligned(new Map(), ref), true);
});

test('nunca duplica: um número que já existe não volta a ser inserido', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    existing: [{ episode_number: 1, airing_at: '2024-01-06T17:30:00.000Z' }],
    sources: { animeschedule: soloAs() },
    total: 12,
    now: NOW,
  });
  assert.equal(plan.inserts.length, 11);
  assert.equal(new Set(plan.inserts.map((r) => r.episode_number)).size, 11);
  assert.equal(plan.inserts.some((r) => r.episode_number === 1), false);
});

test('a estreia do catálogo só vale para o episódio 1 quando nenhuma fonte o tem', () => {
  const comKitsu = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    sources: { kitsu: new Map([day(1, '1995-10-04T00:00:00.000Z')]) },
    premiere: '1995-10-03T00:00:00.000Z',
    total: 2,
    now: NOW,
  });
  assert.equal(comKitsu.inserts[0].airing_at, '1995-10-04T00:00:00.000Z');
  assert.equal(comKitsu.counts.premiere, 0);
  const so = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'TV' },
    premiere: '1995-10-03T00:00:00.000Z',
    total: 2,
    now: NOW,
  });
  assert.deepEqual(so.inserts.map((r) => [r.episode_number, r.airing_at]), [
    [1, '1995-10-03T00:00:00.000Z'],
    [2, null],
  ]);
  assert.equal(so.counts.premiere, 1);
});

// ── Revisão do PR #62 ───────────────────────────────────────────────────────

test('avisos: nada dos últimos três dias é escrito (o pg_cron avisava de uma data recente)', async () => {
  const { RECENT_GUARD_MS } = await import('../src/episode-merge.js');
  assert.equal(RECENT_GUARD_MS, 3 * 86_400_000);
  // Um título a dar, com o 1 e o 2 datados há semanas e o 3 que saiu ONTEM
  // (só no histórico do AnimeSchedule, sem linha na base) e o 4 hoje às 00:00
  // UTC no Kitsu (um dia sem hora, que o pg_cron avisava às 09:00 UTC).
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'airing', media_type: 'TV' },
    existing: [
      { episode_number: 1, airing_at: '2026-10-14T15:00:00.000Z' },
      { episode_number: 2, airing_at: '2026-10-21T00:00:00.000Z' },
    ],
    sources: {
      animeschedule: new Map([
        exact(2, '2026-10-21T15:00:00.000Z'),
        exact(3, '2026-11-03T15:00:00.000Z'),
      ]),
      kitsu: new Map([day(4, '2026-11-04T00:00:00.000Z')]),
    },
    total: 12,
    now: NOW,
  });
  assert.deepEqual(plan.inserts, [], 'o 3 e o 4 são da ingestão semanal');
  assert.deepEqual(
    plan.updates.map((r) => [r.episode_number, r.airing_at]),
    [[2, '2026-10-21T15:00:00.000Z']],
    'uma data antiga ainda pode subir de dia para hora',
  );
});

test('avisos: uma linha da base com data destes dias nunca é atualizada', () => {
  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'airing', media_type: 'TV' },
    existing: [{ episode_number: 1, airing_at: '2026-11-03T00:00:00.000Z' }],
    sources: { animeschedule: new Map([exact(1, '2026-11-03T15:00:00.000Z')]) },
    total: 12,
    now: new Date('2026-11-08T12:00:00Z'),
  });
  // A fonte (de há 5 dias) passa a guarda; a linha também: sobe para a hora.
  assert.equal(plan.updates.length, 1);
  const recent = planAnimeEpisodes({
    anime: { id: ID, status: 'airing', media_type: 'TV' },
    existing: [{ episode_number: 1, airing_at: '2026-11-03T00:00:00.000Z' }],
    sources: { animeschedule: new Map([exact(1, '2026-11-03T15:00:00.000Z')]) },
    total: 12,
    now: NOW,
  });
  assert.equal(recent.updates.length + recent.inserts.length, 0);
});

test('videoclipes e PV: a regra do #60 (extras.js), mesmo antes da marca, e os já marcados', async () => {
  const { wouldBeExtra } = await import('../src/episode-merge.js');
  const secs = (type, value) => ({ type, duration: { value, unit: 'SECONDS' } });
  // Já marcados na base pelo #60: sempre, seja o que for o resto.
  assert.equal(wouldBeExtra({ title: 'Echo', media_type: 'Music' }), true);
  assert.equal(wouldBeExtra({ title: 'Fate/strange Fake', media_type: 'PV', popularity: 9 }), true);
  // Regra 3: PV/CM/Teaser/Trailer no título, fora de TV.
  assert.equal(wouldBeExtra({ title: 'Granblue Fantasy CMs', media_type: 'Special' }), true);
  assert.equal(wouldBeExtra({ title: 'Fate/strange Fake PV', media_type: 'ONA' }, secs('ONA', 120)), true);
  assert.equal(wouldBeExtra({ title: 'Long Trailer', media_type: 'Movie' }, secs('MOVIE', 3600)), false, 'longo demais');
  assert.equal(wouldBeExtra({ title: 'Some Show PV', media_type: 'TV' }), false, 'TV nunca');
  assert.equal(wouldBeExtra({ title: 'Kaleido Star', media_type: 'TV' }), false);
  // Regra 4: o videoclipe do manami, só sem rota e sem seguidores.
  const clip = { type: 'SPECIAL', tags: ['music'], episodes: 1, duration: { value: 200, unit: 'SECONDS' } };
  assert.equal(wouldBeExtra({ title: 'Echo', media_type: 'Special' }, clip), true);
  assert.equal(wouldBeExtra({ title: 'Echo', media_type: 'Special' }, { ...clip, duration: undefined }), false, 'sem duração nunca');
  assert.equal(wouldBeExtra({ title: 'Echo', media_type: 'Special', animeschedule_route: 'echo' }, clip), false);
  assert.equal(wouldBeExtra({ title: 'Echo', media_type: 'Special', popularity: 3 }, clip), false);
  // A lista `keep` do #60 (data/extras-overrides.json).
  assert.equal(wouldBeExtra({ title: 'One Piece: Jango no Dance Carnival', media_type: 'Special', mal_id: 2385 }, clip), false);
  // A lista `extra`, quando a houver.
  const overrides = { keep: new Set(), extra: new Map([[77, 'PV']]) };
  assert.equal(wouldBeExtra({ title: 'Um Título', media_type: 'ONA', mal_id: 77 }, null, { overrides }), true);

  const plan = planAnimeEpisodes({
    anime: { id: ID, status: 'finished', media_type: 'Special' },
    total: 1,
    extra: true,
    now: NOW,
  });
  assert.equal(plan.kind, 'music');
  assert.equal(plan.inserts.length, 0);
});
