// Filtro 18+ (2026-11-01). Um título sai quando QUALQUER fonte o marca como
// adulto; "R+ - Mild Nudity", "ecchi" e "adult audience only" ficam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  adultReason,
  adultTitleKey,
  buildManamiAdultTitleIndex,
  isAdultContent,
  isAdultRating,
  manamiAdultReasonByIds,
  manamiAdultReasonByTitle,
} from '../src/adult-content.js';
import { buildManamiIndex } from '../src/manami.js';
import { buildRows } from '../src/pipeline.js';
import { manamiEntryToAnimeRow } from '../src/catalogue-mappers.js';
import { mapEntries } from '../src/catalogue.js';
import { assertPurgeIsSane, parseArgs, planAdultPurge } from '../src/purge-adult.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(await readFile(resolve(here, 'fixtures', 'adult-signals.json'), 'utf8'));
const manamiIndex = buildManamiIndex(fx.manami);
const manamiAdultTitles = buildManamiAdultTitleIndex(fx.manami);

// ── Cada sinal, fonte a fonte ──────────────────────────────────────────────

test('AniList: isAdult=true exclui; isAdult=false com Ecchi fica', () => {
  assert.equal(adultReason({ isAdult: fx.anilist.adult.isAdult }), 'isAdult');
  assert.equal(adultReason({ isAdult: fx.anilist.ecchi.isAdult, genres: fx.anilist.ecchi.genres }), null);
  // O género "Hentai" da AniList também chega sozinho.
  assert.equal(adultReason({ genres: fx.anilist.adult.genres }), 'genre:hentai');
});

test('MAL/Jikan: só "Rx" exclui — "R+ - Mild Nudity" e "R - 17+" ficam', () => {
  assert.equal(isAdultRating(fx.jikan.hentai.rating), true);
  assert.equal(adultReason({ rating: fx.jikan.hentai.rating }), 'rating:Rx - Hentai');
  assert.equal(isAdultRating(fx.jikan.mildNudity.rating), false);
  assert.equal(adultReason({ rating: fx.jikan.mildNudity.rating, genres: fx.jikan.mildNudity.genres }), null);
  assert.equal(isAdultRating(fx.jikan.violent.rating), false);
  assert.equal(isAdultRating('  rx - hentai '), true);
  assert.equal(isAdultRating('Rxyz'), false); // tem de ser a palavra "Rx"
  assert.equal(isAdultRating(undefined), false);
  // Os géneros do Jikan vêm como { name }: "Hentai" também apanha.
  assert.equal(adultReason({ genres: fx.jikan.hentai.genres }), 'genre:hentai');
});

test('TMDB: adult=true exclui', () => {
  assert.equal(adultReason({ adult: fx.tmdb.adult.adult }), 'adult');
  assert.equal(adultReason({ adult: fx.tmdb.clean.adult }), null);
});

test('etiquetas/géneros: hentai, erotica e "18 restricted" excluem; ecchi e os falsos amigos ficam', () => {
  assert.equal(adultReason({ tags: ['romance', 'Hentai'] }), 'tag:hentai');
  assert.equal(adultReason({ tags: ['erotica'] }), 'tag:erotica');
  assert.equal(adultReason({ tags: ['18 restricted'] }), 'tag:18 restricted');
  assert.equal(adultReason({ genres: [{ name: ' Hentai ' }] }), 'genre:hentai');
  // Ficam: o ecchi é mainstream; os outros estão em títulos legítimos (ver o
  // topo de adult-content.js — "Afro Samurai", "91 Days", "Air").
  for (const tag of ['ecchi', 'adult audience only', 'pornography', 'borderline porn', 'erotic game', 'adult cast', 'eroticism']) {
    assert.equal(isAdultContent({ tags: [tag] }), false, tag);
  }
  assert.equal(isAdultContent({}), false);
  assert.equal(isAdultContent(), false);
});

test('lista à mão: "Harem-tou e Youkoso!" sai pelo título, com ou sem pontuação', () => {
  assert.equal(adultReason({ titles: ['Harem-tou e Youkoso!'] }), 'lista:Harem-tou e Youkoso!');
  assert.equal(adultReason({ titles: ['Harem Shima e Youkoso'] }), 'lista:Harem Shima e Youkoso');
  assert.equal(adultReason({ titles: ['Harem in the Labyrinth of Another World'] }), null);
});

test('manami pelos ids: hentai/erotica excluem, Perfect Addiction (BL, "eroticism") fica', () => {
  assert.equal(manamiAdultReasonByIds({ mal: 64531 }, manamiIndex), 'manami:hentai');
  assert.equal(manamiAdultReasonByIds({ mal: '63619' }, manamiIndex), 'manami:erotica');
  assert.equal(manamiAdultReasonByIds({ mal: 63514 }, manamiIndex), null);
  assert.equal(manamiAdultReasonByIds({ mal: 2001 }, manamiIndex), null); // Afro Samurai
  assert.equal(manamiAdultReasonByIds({ mal: 123456 }, manamiIndex), null);
  assert.equal(manamiAdultReasonByIds({ mal: 64531 }, null), null);
});

test('manami pelo título: só condena quando a chave é inequívoca', () => {
  assert.equal(manamiAdultReasonByTitle(['Sare Tsuma wa Ubawaretai'], manamiAdultTitles), 'manami-titulo:Sare Tsuma wa Ubawaretai');
  // Romanizações diferentes do mesmo título (o caso real: AnimeSchedule
  // "Kon'in" contra manami "Konin") dão a mesma chave.
  assert.equal(adultTitleKey("Pure x Holic: Junketsu Otome to Kon'in Kankei!?"), adultTitleKey('Pure x Holic: Junketsu Otome to Konin Kankei!?'));
  assert.equal(manamiAdultReasonByTitle(['Sare-Tsuma wa Ubawa retai'], manamiAdultTitles), 'manami-titulo:Sare-Tsuma wa Ubawa retai');
  // "Akira" é sinónimo de um hentai E título do filme de 1988 → ambíguo, fica.
  assert.equal(manamiAdultTitles.get(adultTitleKey('Akira')), false);
  assert.equal(manamiAdultReasonByTitle(['Akira'], manamiAdultTitles), null);
  assert.equal(manamiAdultReasonByTitle(['Perfect Addiction'], manamiAdultTitles), null);
  // Uma entrada sem etiquetas não desempata: o título inglês de "Onaji Semi"
  // também existe numa entrada vazia do manami, e a chave continua adulta.
  assert.equal(
    manamiAdultReasonByTitle(["My Classmate's a Sexy Actress, and Now We Live Together?!"], manamiAdultTitles),
    "manami-titulo:My Classmate's a Sexy Actress, and Now We Live Together?!",
  );
  assert.equal(manamiAdultReasonByTitle(['Sare Tsuma wa Ubawaretai'], null), null);
});

// ── Caminho 1: a ingestão semanal (AnimeSchedule → pipeline.js) ─────────────

test('buildRows barra os 18+ da AnimeSchedule e deixa passar o resto', () => {
  const out = buildRows({
    timetableEntries: fx.animescheduleTimetable,
    detailsByRoute: new Map(Object.entries(fx.animescheduleDetails)),
    manamiIndex,
    manamiAdultTitles,
  });
  const byRoute = new Map(out.adultRejected.map((a) => [a.route, a.reason]));
  // Género "Hentai" no detalhe.
  assert.equal(byRoute.get('pure-x-holic-junketsu-otome-to-kon-in-kankei-the-animation'), 'genre:hentai');
  // Sem género adulto na AnimeSchedule, mas o MAL 64531 é "hentai" no manami
  // (o nome é inventado para o teste não passar pela lista à mão).
  assert.equal(byRoute.get('hypnosis-girlfriend'), 'manami:hentai');
  // Confirmado à mão (MAL "Rx - Hentai"): a lista vê o nome inglês.
  assert.equal(
    byRoute.get('onaji-semi-no-someya-san-ga-sexy-joyuu-datta-hanashi'),
    "lista:My Classmate's a Sexy Actress, and Now We Live Together?!",
  );
  // Sem detalhe nem ids: a lista à mão e o título no manami.
  assert.equal(byRoute.get('harem-tou-e-youkoso'), 'lista:Harem-tou e Youkoso!');
  assert.equal(byRoute.get('kokuhaku-the-animation'), 'manami-titulo:Kokuhaku The Animation');

  assert.deepEqual(
    out.animeRows.map((r) => r.animeschedule_route).sort(),
    ['akira', 'ecchi-show', 'perfect-addiction'],
  );
  // O Ecchi continua a ser um género da ficha.
  assert.deepEqual(out.animeRows.find((r) => r.animeschedule_route === 'ecchi-show').genres, ['Comedy', 'Ecchi']);
  // Nem um episódio dos barrados chega ao upsert.
  const epRoutes = new Set(out.episodeProtos.map((p) => p.route));
  for (const route of byRoute.keys()) assert.equal(epRoutes.has(route), false, route);
  assert.equal(out.adultRejected.length, 5);
  // Os barrados não contam como "rejeitados por dados partidos".
  assert.equal(out.rejectedAnimes, 0);
});

test('buildRows sem manami continua a barrar pelos sinais da própria AnimeSchedule', () => {
  const out = buildRows({
    timetableEntries: fx.animescheduleTimetable,
    detailsByRoute: new Map(Object.entries(fx.animescheduleDetails)),
  });
  const routes = out.adultRejected.map((a) => a.route).sort();
  assert.deepEqual(routes, [
    'harem-tou-e-youkoso',
    'onaji-semi-no-someya-san-ga-sexy-joyuu-datta-hanashi',
    'pure-x-holic-junketsu-otome-to-kon-in-kankei-the-animation',
  ]);
});

// ── Caminho 2: o catálogo do manami (catalogue.js) ──────────────────────────

test('catálogo do manami: hentai/erotica saem, a lista à mão vale também aqui, ecchi fica', () => {
  const { rows, rejected } = mapEntries([
    ...fx.manami,
    { sources: ['https://myanimelist.net/anime/70001'], title: 'Harem-tou e Youkoso!', tags: [] },
    { sources: ['https://myanimelist.net/anime/70002'], title: 'Ecchi Show', tags: ['ecchi'] },
  ]);
  const titles = rows.map((r) => r.title).sort();
  assert.deepEqual(titles, ['91 Days', 'Afro Samurai: Resurrection', 'Akira', 'Ecchi Show', 'Perfect Addiction']);
  // Kanojo Saimin, Onaji Semi, Yuuwaku Countdown, Kamui-san ("erotica") e
  // Harem-tou (sem etiquetas) saem por 18+; Sare Tsuma, Kokuhaku e a entrada
  // vazia de "My Classmate's…" saem também, mas por não terem id do MAL.
  assert.equal(rejected, 8);
  assert.equal(manamiEntryToAnimeRow({ ...fx.manami[0] }), null);
});

// ── A limpeza do que já está guardado (purge-adult.js) ──────────────────────

const stored = [
  { id: 'a1', slug: 'hypnosis-girlfriend', title: 'Hypnosis Girlfriend', genres: [], external_ids: { mal: 64531 }, mal_id: 64531 },
  { id: 'a2', slug: 'pure-x-holic-junketsu-otome-to-kon-in-kankei-the-animation', title: 'Pure x Holic', genres: ['Fantasy', 'Hentai'], external_ids: {}, mal_id: null },
  { id: 'a3', slug: 'harem-tou-e-youkoso', title: 'Harem-tou e Youkoso!', genres: [], external_ids: {}, mal_id: null },
  { id: 'a4', slug: 'kokuhaku-the-animation', title: 'Kokuhaku The Animation', genres: [], external_ids: {}, mal_id: null },
  // Um dos casos reais, sem ids nem géneros: sai pela lista à mão.
  { id: 'a10', slug: 'sare-tsuma-wa-ubawaretai', title: 'Sare Tsuma wa Ubawaretai', genres: [], external_ids: {}, mal_id: null },
  { id: 'a5', slug: 'perfect-addiction', title: 'Perfect Addiction', genres: ['Romance'], external_ids: { mal: 63514 }, mal_id: 63514 },
  { id: 'a6', slug: 'akira', title: 'Akira', genres: ['Action'], external_ids: {}, mal_id: null },
  { id: 'a7', slug: 'ecchi-show', title: 'Ecchi Show', genres: ['Ecchi'], external_ids: {}, mal_id: null },
  // O caso de fronteira: no MAL é "R+ - Mild Nudity" (o rating sozinho não o
  // tiraria), mas o MAL dá-lhe o género Erotica e o manami a etiqueta
  // "erotica" — que já era motivo de exclusão no mapeador antes desta mudança.
  { id: 'a8', slug: 'kamui-he-s-behind-you', title: "KAMUI: He's Behind You", genres: ['Comedy'], external_ids: { mal: 63468 }, mal_id: null },
  { id: 'a9', slug: 'outro', title: 'Outro', genres: [], external_ids: {}, mal_id: null, animeschedule_route: 'outro' },
];

test('planAdultPurge: sinal forte apaga, título sozinho fica para rever, legítimos ficam', () => {
  const plan = planAdultPurge(stored, {
    manamiIndex,
    manamiAdultTitles,
    detailsByRoute: new Map([['outro', { genres: [{ name: 'Hentai' }] }]]),
  });
  assert.deepEqual(
    plan.remove.map((i) => [i.slug, i.reason]),
    [
      ['hypnosis-girlfriend', 'manami:hentai'],
      ['pure-x-holic-junketsu-otome-to-kon-in-kankei-the-animation', 'genre:hentai'],
      ['harem-tou-e-youkoso', 'lista:Harem-tou e Youkoso!'],
      ['sare-tsuma-wa-ubawaretai', 'lista:Sare Tsuma wa Ubawaretai'],
      ['kamui-he-s-behind-you', 'manami:erotica'],
      ['outro', 'genre:hentai'], // pelo detalhe da AnimeSchedule
    ],
  );
  assert.deepEqual(plan.review.map((i) => i.slug), ['kokuhaku-the-animation']);
  assert.deepEqual(plan.kept, []);
});

test('planAdultPurge: --keep poupa um slug', () => {
  const plan = planAdultPurge(stored, { manamiIndex, manamiAdultTitles, keep: new Set(['kamui-he-s-behind-you']) });
  assert.equal(plan.remove.some((i) => i.slug === 'kamui-he-s-behind-you'), false);
  assert.deepEqual(plan.kept.map((i) => i.slug), ['kamui-he-s-behind-you']);
});

test('purge-adult: argumentos e travão', () => {
  const a = parseArgs(['node', 'x', '--apply', '--keep=a, b,,c', '--max=10']);
  assert.equal(a.apply, true);
  assert.equal(a.applyTitles, false);
  assert.deepEqual([...a.keep], ['a', 'b', 'c']);
  assert.equal(a.max, 10);
  const d = parseArgs(['node', 'x']);
  assert.equal(d.apply, false);
  assert.equal(d.max, 200);
  assert.doesNotThrow(() => assertPurgeIsSane(200, 200));
  assert.throws(() => assertPurgeIsSane(201, 200), /nada foi apagado/);
});
