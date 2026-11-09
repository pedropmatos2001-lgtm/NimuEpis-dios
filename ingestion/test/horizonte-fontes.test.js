// O estudo do horizonte das fontes (auditoria/horizonte-lib.mjs), sem rede:
// dados de mentira com a forma das três fontes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agreement,
  coverage,
  fetchAniListRange,
  fromAniList,
  fromAnimeSchedule,
  fromDb,
  malToAniList,
  matchEpisodes,
  mergeSubRaw,
  recommendHorizon,
  renderMarkdown,
  showKey,
  topDisagreements,
  weekIndexOf,
  weekSpans,
  weeklyStats,
} from '../auditoria/horizonte-lib.mjs';
import { isoWeek } from '../src/util.js';

const AGORA = new Date('2026-11-08T12:00:00Z'); // domingo, semana 45
const DIA = 86_400_000;
const HORA = 3_600_000;
const spans = weekSpans(AGORA, 8);
const iso = (ms) => new Date(ms).toISOString();

test('weekSpans: +0 a +8, semanas ISO em UTC, de segunda a domingo', () => {
  assert.equal(spans.length, 9);
  assert.equal(iso(spans[0].start), '2026-11-02T00:00:00.000Z');
  assert.equal(iso(spans[0].end), '2026-11-08T23:59:59.999Z');
  assert.equal(iso(spans[8].end), '2027-01-03T23:59:59.999Z');
  for (const s of spans) {
    assert.deepEqual(isoWeek(new Date(s.start)), { year: s.year, week: s.week });
    assert.deepEqual(isoWeek(new Date(s.end)), { year: s.year, week: s.week });
  }
  // A semana 53 de 2026.
  assert.ok(spans.some((s) => s.year === 2026 && s.week === 53));
  assert.equal(weekIndexOf(Date.parse('2026-11-23T00:00:00Z'), spans), 3);
  assert.equal(weekIndexOf(Date.parse('2026-11-01T23:59:59Z'), spans), null);
});

test('showKey: AniList direto, pelo MAL, ou o MAL sozinho', () => {
  const m = new Map([[52991, 154587]]);
  assert.equal(showKey({ anilist: 21 }, m), 'al:21');
  assert.equal(showKey({ mal: 52991 }, m), 'al:154587');
  assert.equal(showKey({ mal: '777' }, m), 'mal:777');
  assert.equal(showKey({}, m), null);
  assert.equal(showKey({ anilist: 'x', mal: 0 }, m), null);
});

// ── Dados de mentira ─────────────────────────────────────────────────────────
// Três séries: Frieren (AniList 154587, MAL 52991), One Piece (AniList 21) e
// uma só da AnimeSchedule sem ids. A AniList sabe até à +5; a AnimeSchedule
// tem tudo até à +2, metade na +3 e nada depois.

const segunda = (k) => spans[k].start;
const FRIEREN = { route: 'frieren-2', anilist: null, mal: 52991, title: 'Frieren 2' };
const OP = { route: 'one-piece', anilist: 21, mal: 21, title: 'One Piece' };
const SOLTA = { route: 'serie-solta', title: 'Solta' };
const idsByRoute = new Map([
  [FRIEREN.route, { anilist: FRIEREN.anilist, mal: FRIEREN.mal, title: FRIEREN.title }],
  [OP.route, { anilist: OP.anilist, mal: OP.mal, title: OP.title }],
]);

function horarioAs() {
  const sub = [];
  const raw = [];
  for (let k = 0; k <= 3; k += 1) {
    // Frieren: sábado 15:00 UTC no raw; o sub sai 1 h depois.
    const fr = segunda(k) + 5 * DIA + 15 * HORA;
    raw.push({ route: FRIEREN.route, episodeNumber: 10 + k, episodeDate: iso(fr) });
    if (k <= 2) sub.push({ route: FRIEREN.route, episodeNumber: 10 + k, episodeDate: iso(fr + HORA) });
    // One Piece: domingo 00:15 UTC, sem raw (na +3 já não vem).
    if (k <= 2) sub.push({ route: OP.route, episodeNumber: 1150 + k, episodeDate: iso(segunda(k) + 6 * DIA + 15 * 60_000) });
    if (k <= 2) sub.push({ route: SOLTA.route, episodeNumber: 1 + k, episodeDate: iso(segunda(k) + 2 * DIA) });
  }
  sub.push({ route: 'sentinela', episodeNumber: 1, episodeDate: '0001-01-01T00:00:00Z' });
  return { sub, raw };
}

function horarioAniList() {
  const out = [];
  for (let k = 0; k <= 5; k += 1) {
    out.push({
      airingAt: (segunda(k) + 5 * DIA + 15 * HORA) / 1000,
      episode: 10 + k,
      media: { id: 154587, idMal: 52991, isAdult: false, popularity: 300000, title: { english: 'Frieren S2', romaji: 'Sousou no Frieren 2' } },
    });
    // One Piece: a AniList dá 30 min mais tarde que a AnimeSchedule na +1.
    out.push({
      airingAt: (segunda(k) + 6 * DIA + 15 * 60_000 + (k === 1 ? 30 * 60_000 : 0)) / 1000,
      episode: 1150 + k,
      media: { id: 21, idMal: 21, isAdult: false, popularity: 500000, title: { english: 'ONE PIECE' } },
    });
    out.push({
      airingAt: (segunda(k) + 3 * DIA) / 1000,
      episode: k + 1,
      media: { id: 999, idMal: 999, isAdult: true, popularity: 900000, title: { romaji: '18+' } },
    });
  }
  return out;
}

function montar() {
  const { sub, raw } = horarioAs();
  const schedules = horarioAniList();
  const malToAl = malToAniList(schedules);
  const opts = { idsByRoute, malToAl, spans };
  const asSub = fromAnimeSchedule(sub, opts);
  const asRaw = fromAnimeSchedule(raw, opts);
  const asMerged = fromAnimeSchedule(mergeSubRaw(sub, raw), opts);
  const anilist = fromAniList(schedules, { spans });
  const db = fromDb(
    [
      // O que a ingestão guardou da +1 (sub), e um episódio do TVDB na +6.
      {
        anime_id: 'u1',
        episode_number: 11,
        airing_at: iso(segunda(1) + 5 * DIA + 16 * HORA),
        animes: { title: 'Frieren 2', animeschedule_route: 'frieren-2', mal_id: 52991, external_ids: {} },
      },
      {
        anime_id: 'u2',
        episode_number: 40,
        airing_at: iso(segunda(6) + DIA),
        animes: { title: 'Do TVDB', animeschedule_route: null, mal_id: null, external_ids: {} },
      },
    ],
    { malToAl, spans },
  );
  return { asSub, asRaw, asMerged, anilist, db, malToAl };
}

test('normalização: o sentinela e os 18+ ficam de fora; o MAL cruza com a AniList', () => {
  const { asSub, asMerged, anilist, db } = montar();
  assert.ok(!asSub.some((r) => r.show === 'as:sentinela'));
  assert.ok(!anilist.some((r) => r.key === 'al:999'));
  assert.ok(asMerged.filter((r) => r.show === 'as:frieren-2').every((r) => r.key === 'al:154587'));
  assert.ok(asMerged.filter((r) => r.show === 'as:serie-solta').every((r) => r.key === null));
  // O sub manda: o Frieren das semanas +0 a +2 tem a hora do sub (16:00).
  const fr11 = asMerged.find((r) => r.show === 'as:frieren-2' && r.episode === 11);
  assert.equal(iso(fr11.at).slice(11, 16), '16:00');
  // A +3 do Frieren só tem raw.
  assert.equal(iso(asMerged.find((r) => r.episode === 13 && r.show === 'as:frieren-2').at).slice(11, 16), '15:00');
  assert.deepEqual(db.map((r) => r.viaHorario), [true, false]);
});

test('matchEpisodes e agreement: pares por (série, episódio), data e hora', () => {
  const { asRaw, anilist } = montar();
  const { pairs, onlyA, onlyB } = matchEpisodes(asRaw, anilist);
  // O raw só tem o Frieren de +0 a +3: os 4 batem certo ao minuto.
  assert.equal(pairs.length, 4);
  assert.equal(onlyA.length, 0);
  assert.ok(onlyB.length > 0);
  assert.deepEqual(agreement(pairs), { n: 4, sameDate: 1, within5m: 1, within1h: 1 });
  assert.deepEqual(agreement([]), { n: 0, sameDate: null, within5m: null, within1h: null });
});

test('weeklyStats: contagens por fonte e concordância por semana', () => {
  const { asSub, asRaw, asMerged, anilist, db } = montar();
  const weeks = weeklyStats({ spans, asSub, asRaw, asMerged, anilist, db });
  assert.equal(weeks.length, 9);
  assert.equal(weeks[3].label, '2026-W48');
  assert.deepEqual(weeks[1].counts, { asSub: 3, asRaw: 1, asMerged: 3, anilist: 2, dbHorario: 1, dbOutras: 0 });
  assert.deepEqual(weeks[3].counts, { asSub: 0, asRaw: 1, asMerged: 1, anilist: 2, dbHorario: 0, dbOutras: 0 });
  assert.equal(weeks[6].counts.dbOutras, 1);
  // +1: o Frieren sai 1 h mais tarde no sub; o One Piece 30 min de diferença.
  assert.deepEqual(weeks[1].mergedVsAniList, { n: 2, sameDate: 1, within5m: 0, within1h: 1 });
  assert.deepEqual(weeks[0].mergedVsAniList, { n: 2, sameDate: 1, within5m: 0.5, within1h: 1 });
  assert.deepEqual(weeks[1].rawVsAniList, { n: 1, sameDate: 1, within5m: 1, within1h: 1 });
  // +3: a AnimeSchedule só tem o Frieren; a AniList tem também o One Piece,
  // que a AnimeSchedule segue (tem-no de +0 a +2) mas ainda não pôs na +3: 1/2.
  // A série solta (sem ids) não conta.
  assert.equal(weeks[2].asCoversAniList.ratio, 1);
  assert.equal(weeks[3].asCoversAniList.ratio, 0.5);
  assert.deepEqual(weeks[4].asCoversAniList, { sharedShows: 2, bEpisodesOfShared: 2, aHasOfThose: 0, ratio: 0 });
  assert.equal(weeks[6].asCoversAniList.ratio, null);
  // base x ingerido na +1: a mesma hora do sub.
  assert.deepEqual(weeks[1].dbVsMerged, { n: 1, sameDate: 1, within5m: 1, within1h: 1 });
});

test('coverage conta só as séries que as duas fontes conhecem', () => {
  const a = [{ key: 'al:1', episode: 1 }, { key: 'al:2', episode: 5 }];
  const b = [{ key: 'al:1', episode: 1 }, { key: 'al:1', episode: 2 }, { key: 'al:3', episode: 1 }];
  assert.deepEqual(coverage(a, b), { sharedShows: 1, bEpisodesOfShared: 2, aHasOfThose: 1, ratio: 0.5 });
  // Com as séries da janela inteira: a al:3 também conta, e falta em `a`.
  assert.deepEqual(coverage(a, b, new Set(['al:1', 'al:3'])), { sharedShows: 2, bEpisodesOfShared: 3, aHasOfThose: 1, ratio: 1 / 3 });
});

test('recommendHorizon: semanas cheias da AnimeSchedule e uma extra a meio', () => {
  const { asSub, asRaw, asMerged, anilist, db } = montar();
  const r = recommendHorizon(weeklyStats({ spans, asSub, asRaw, asMerged, anilist, db }));
  // +0 a +2 com 3 episódios (o volume normal), +3 com 1 de 3 (33%, abaixo dos 40%).
  assert.equal(r.strict, 2);
  assert.equal(r.extra, null);
  assert.equal(r.timetableWeeksAhead, 2);
  assert.equal(r.reference, 3);
  assert.equal(r.aniListKnownUntil, 5);
  assert.equal(r.animeScheduleKnownUntil, 2);

  // Uma semana +3 com metade do volume conta como extra.
  const semanas = [0, 1, 2, 3, 4].map((k) => ({
    k,
    counts: { asMerged: [100, 100, 95, 50, 10][k], anilist: 100 },
    asCoversAniList: { ratio: [1, 0.98, 0.9, 0.5, 0.1][k] },
  }));
  assert.deepEqual(
    { ...recommendHorizon(semanas), reference: undefined },
    { strict: 2, extra: 3, timetableWeeksAhead: 3, reference: undefined, animeScheduleKnownUntil: 3, aniListKnownUntil: 4 },
  );
  // A cobertura também conta: +2 com o volume mas só 70% do que a AniList sabe.
  semanas[2].asCoversAniList.ratio = 0.7;
  assert.equal(recommendHorizon(semanas).strict, 1);
});

test('topDisagreements: as mais populares primeiro, com as diferenças e o que só uma tem', () => {
  const { asMerged, asRaw, anilist } = montar();
  const d = topDisagreements(asMerged, anilist, { rawList: asRaw, top: 30 });
  assert.deepEqual(d.map((x) => x.title), ['ONE PIECE', 'Frieren S2']);
  const op = d[0];
  // Sem raw: compara com a hora ingerida. +1 com 30 min; +3, +4 e +5 só na AniList.
  assert.deepEqual(op.rows.map((x) => [x.episode, x.diffMin, x.vs]), [[1151, 30, 'ingerido'], [1153, null, null], [1154, null, null], [1155, null, null]]);
  // Frieren: o sub sai 1 h depois, mas o raw bate certo com a AniList, por
  // isso não há diferença de hora; só os episódios +4 e +5 que só a AniList tem.
  assert.deepEqual(d[1].rows.map((x) => [x.episode, x.diffMin]), [[14, null], [15, null]]);
  // Sem a lista do raw, a hora do sub conta como diferença de 1 h.
  const semRaw = topDisagreements(asMerged, anilist).find((x) => x.title === 'Frieren S2');
  assert.deepEqual(semRaw.rows.filter((x) => x.diffMin !== null).map((x) => x.diffMin), [-60, -60, -60]);
  assert.equal(topDisagreements(asMerged, anilist, { top: 1 }).length, 1);
});

test('renderMarkdown: as secções e nenhum segredo', () => {
  const { asSub, asRaw, asMerged, anilist, db } = montar();
  const weeks = weeklyStats({ spans, asSub, asRaw, asMerged, anilist, db });
  const md = renderMarkdown({
    weeks,
    recommendation: recommendHorizon(weeks),
    disagreements: topDisagreements(asMerged, anilist, { rawList: asRaw }),
    meta: { geradoEm: AGORA.toISOString(), erros: ['AniList 2027-W1: HTTP 500'], pedidos: { AniList: 12 } },
  });
  for (const s of ['## Recomendação', '## Episódios por semana e por fonte', '## Concordância', '### ONE PIECE', 'ERRO: AniList 2027-W1']) {
    assert.ok(md.includes(s), s);
  }
  assert.match(md, /`TIMETABLE_WEEKS_AHEAD` recomendado: \*\*2\*\*/);
  assert.ok(!/sb_publishable|Bearer|apikey/i.test(md));
  assert.ok(!md.includes(' · '));
});

test('fetchAniListRange: segue as páginas, e para no teto', async () => {
  const pedidos = [];
  const post = async (body) => {
    pedidos.push(body.variables);
    const page = body.variables.page;
    return { data: { Page: { pageInfo: { hasNextPage: page < 3 }, airingSchedules: [{ airingAt: page, episode: page, media: { id: page } }] } } };
  };
  const r = await fetchAniListRange({ post, fromMs: 1_000_000, toMs: 2_000_000 });
  assert.equal(r.pages, 3);
  assert.equal(r.schedules.length, 3);
  assert.equal(r.truncated, false);
  assert.deepEqual(pedidos[0], { page: 1, from: 999, to: 2001 });
  const preso = await fetchAniListRange({
    post: async () => ({ data: { Page: { pageInfo: { hasNextPage: true }, airingSchedules: [] } } }),
    fromMs: 0,
    toMs: 1,
    maxPages: 4,
  });
  assert.deepEqual({ pages: preso.pages, truncated: preso.truncated }, { pages: 4, truncated: true });
  await assert.rejects(fetchAniListRange({ post: async () => ({ errors: [{ message: 'Too Many Requests' }] }), fromMs: 0, toMs: 1 }), /sem Page/);
});
