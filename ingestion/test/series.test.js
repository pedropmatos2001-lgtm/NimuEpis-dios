import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assignSeasons,
  buildComponents,
  chooseSeriesSlug,
  compactAsEntry,
  isAsSeriesNode,
  isRowSeriesFormat,
  markersOf,
  MAX_MEMBERS,
  parseSeasonMarkers,
  parseSeriesOverrides,
  planSeries,
  slugify,
  stripSeason,
} from '../src/series-plan.js';
import { applyPlan, formatReviewList, formatSummary, loadSeriesOverrides, parseArgs } from '../src/series.js';

// Fichas e linhas REAIS (2026-11-04) das franquias de referência do plano.
const FIX = JSON.parse(readFileSync(new URL('./fixtures/series-reais.json', import.meta.url), 'utf8'));
const OVERRIDES = loadSeriesOverrides();
const PLAN = planSeries({ asEntries: FIX.animeschedule, rows: FIX.rows, overrides: OVERRIDES });

/** A série que tem a linha com este endereço. */
function seriesOf(slug, plan = PLAN) {
  return plan.series.find((s) => s.members.some((m) => m.slug === slug)) ?? null;
}
/** "T1", "T3 P2" por ordem de estreia. */
function seasons(s) {
  return s.members.map((m) => `T${m.season}${m.part ? ` P${m.part}` : ''}`);
}

// ── Temporada pelo nome ──────────────────────────────────────────────────────

test('a temporada e a parte saem do nome', () => {
  const cases = [
    ['Solo Leveling Season 2: Arise from the Shadow', { season: 2, part: null, final: false }],
    ['Solo Leveling 2nd Season: Arise from the Shadow', { season: 2, part: null, final: false }],
    ['Haikyuu!! Second Season', { season: 2, part: null, final: false }],
    ['Overlord II', { season: 2, part: null, final: false }],
    ['Shingeki no Kyojin 2', { season: 2, part: null, final: false }],
    ['Mushoku Tensei II: Isekai Ittara Honki Dasu', { season: 2, part: null, final: false }],
    ['Re:Zero kara Hajimeru Isekai Seikatsu 2 Part 2', { season: 2, part: 2, final: false }],
    ['Attack on Titan Season 3 Part 2', { season: 3, part: 2, final: false }],
    ['Attack on Titan: The Final Season', { season: null, part: null, final: true }],
    ['Shingeki no Kyojin: The Final Season Part 2', { season: null, part: 2, final: true }],
    ['Spy x Family Part 2', { season: null, part: 2, final: false }],
    ['The Apothecary Diaries Season 3 Cour 2', { season: 3, part: 2, final: false }],
    ['Jujutsu Kaisen: Shimetsu Kaiyuu - Kouhen', { season: null, part: 2, final: false }],
    // Não são temporadas: o nome, um número grande, um arco do JoJo.
    ['Kaiju No. 8', { season: null, part: null, final: false }],
    ['Mob Psycho 100', { season: null, part: null, final: false }],
    ['86', { season: null, part: null, final: false }],
    ["JoJo no Kimyou na Bouken Part 4: Diamond wa Kudakenai", { season: null, part: null, final: false }],
    ['Demon Slayer: Entertainment District Arc', { season: null, part: null, final: false }],
  ];
  for (const [name, want] of cases) assert.deepEqual(parseSeasonMarkers(name), want, name);
});

test('o primeiro nome que diz alguma coisa ganha, sem misturar nomes', () => {
  // O inglês do AnimeSchedule chama-lhe "Season 4", mas o nome da ficha diz
  // que é a segunda metade ("Kouhen") da temporada anterior.
  assert.deepEqual(markersOf(['Jujutsu Kaisen: Shimetsu Kaiyuu - Kouhen', 'JUJUTSU KAISEN Season 4: The Culling Game Part 2']), {
    season: null,
    part: 2,
    final: false,
  });
  assert.deepEqual(markersOf(['Kimetsu no Yaiba', null, 'Demon Slayer']), { season: null, part: null, final: false });
});

test('o nome sem a temporada', () => {
  assert.equal(stripSeason('Solo Leveling Season 2: Arise from the Shadow'), 'Solo Leveling');
  assert.equal(stripSeason('Attack on Titan: The Final Season Part 2'), 'Attack on Titan');
  assert.equal(stripSeason('Spy x Family Part 2'), 'Spy x Family');
  assert.equal(stripSeason('Overlord IV'), 'Overlord');
  assert.equal(stripSeason('Mushoku Tensei II: Isekai Ittara Honki Dasu'), 'Mushoku Tensei: Isekai Ittara Honki Dasu');
  assert.equal(stripSeason('Demon Slayer: Mugen Train Arc (TV)'), 'Demon Slayer: Mugen Train Arc');
  assert.equal(stripSeason('Kaiju No. 8 Season 2'), 'Kaiju No. 8');
  assert.equal(stripSeason('[Oshi no Ko] 3rd Season'), 'Oshi no Ko');
});

test('temporadas pela ordem quando o nome não diz; um "Season 2" repetido é a parte', () => {
  const m = (title, premiere) => ({ row: { id: title, title }, shown: title, premiere, markers: parseSeasonMarkers(title), refs: [] });
  const { members, doubts } = assignSeasons([
    m('Sword Art Online: Alicization - War of Underworld Season 2', '2020-07-11'),
    m('Sword Art Online', '2012-07-07'),
    m('Sword Art Online II', '2014-07-04'),
    m('Sword Art Online: Alicization', '2018-10-06'),
    m('Sword Art Online: Alicization - War of Underworld', '2019-10-12'),
  ]);
  assert.deepEqual(
    members.map((x) => [x.order, x.season, x.part]),
    [
      [1, 1, null],
      [2, 2, null],
      [3, 3, null],
      [4, 4, 1],
      [5, 4, 2],
    ],
  );
  assert.equal(doubts[0].tipo, 'temporada-repetida');
});

test('uma temporada forçada no ficheiro de exceções ganha ao nome', () => {
  const overrides = parseSeriesOverrides({ season: [{ ref: 'b', season: 3, part: 2, why: 'teste' }] });
  const { members } = assignSeasons(
    [
      { row: { id: 'a', title: 'X' }, shown: 'X', premiere: '2020-01-01', markers: parseSeasonMarkers('X'), refs: ['a'] },
      { row: { id: 'b', title: 'X 2' }, shown: 'X 2', premiere: '2021-01-01', markers: parseSeasonMarkers('X 2'), refs: ['b'] },
    ],
    overrides,
  );
  assert.deepEqual(members.map((x) => [x.season, x.part, x.seasonFrom]), [
    [1, null, 'ordem'],
    [3, 2, 'exceção'],
  ]);
});

// ── Componentes ──────────────────────────────────────────────────────────────

const as = (route, mt, { seq = [], pre = [], eps = 12, mal = null } = {}) => ({ route, mal, en: null, t: route, mt: [mt], eps, pr: null, y: null, seq, pre });

test('só TV, ONA e TV Short ligam; um ONA de um episódio e os videoclipes ficam de fora', () => {
  assert.equal(isAsSeriesNode(as('a', 'TV')), true);
  assert.equal(isAsSeriesNode(as('a', 'ONA (Chinese)')), true);
  assert.equal(isAsSeriesNode(as('a', 'TV Short')), true);
  assert.equal(isAsSeriesNode(as('a', 'ONA', { eps: 1 })), false);
  assert.equal(isAsSeriesNode(as('a', 'TV', { eps: 1 })), true);
  for (const mt of ['Movie', 'OVA', 'Special', 'Music']) assert.equal(isAsSeriesNode(as('a', mt)), false, mt);
  assert.equal(isRowSeriesFormat({ media_type: 'Music' }), false);
  assert.equal(isRowSeriesFormat({ media_type: 'PV' }), false);
  assert.equal(isRowSeriesFormat({ media_type: 'Special' }), false);
  assert.equal(isRowSeriesFormat({ media_type: null }), true);
  assert.equal(isRowSeriesFormat({ media_type: 'TV Short' }), true);
});

test('componentes: sequelas, a ponte por um filme, e as exceções join/cut/split', () => {
  const entries = [
    as('s1', 'TV', { seq: ['s2'] }),
    as('s2', 'TV', { pre: ['s1'], seq: ['filme'] }),
    as('filme', 'Movie', { pre: ['s2'], seq: ['s3'] }),
    as('s3', 'TV', { pre: ['filme'] }),
    as('pv', 'ONA', { eps: 1, seq: ['s1'] }),
    as('outra', 'TV'),
    as('derivado', 'TV', { pre: ['s3'] }),
  ];
  const norm = (cs) => cs.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
  const plain = buildComponents(entries);
  assert.deepEqual(norm(plain.components), [['derivado', 's1', 's2', 's3'], ['outra']]);
  assert.equal(plain.bridged.length, 1);
  assert.deepEqual(plain.bridged[0], { de: 's2', por: ['filme'], para: 's3' });
  // Sem a ponte, o filme parte a série.
  assert.deepEqual(norm(buildComponents(entries, undefined, { bridges: false }).components), [['derivado', 's3'], ['outra'], ['s1', 's2']]);
  const ov = parseSeriesOverrides({
    cut: [{ refs: ['s3', 'derivado'], why: 't' }],
    join: [{ refs: ['outra', 's1'], why: 't' }],
    split: [{ ref: 's2', why: 't' }],
  });
  // Sem o s2, a ponte já não tem de onde partir: o s3 fica sozinho.
  assert.deepEqual(norm(buildComponents(entries, ov).components), [['derivado'], ['outra', 's1'], ['s3']]);
});

test('a ficha compacta do AnimeSchedule', () => {
  const e = compactAsEntry({
    route: 'solo-leveling',
    title: 'Solo Leveling',
    names: { english: '' },
    websites: { mal: 'https://myanimelist.net/anime/52299' },
    mediaTypes: [{ name: 'TV' }],
    episodes: 12,
    premier: '2024-01-06T00:00:00Z',
    year: 2024,
    relations: { sequels: ['solo-leveling-arise-from-the-shadow'], prequels: null },
  });
  assert.deepEqual(e, {
    route: 'solo-leveling',
    mal: 52299,
    en: null,
    t: 'Solo Leveling',
    mt: ['TV'],
    eps: 12,
    pr: '2024-01-06T00:00:00Z',
    y: 2024,
    seq: ['solo-leveling-arise-from-the-shadow'],
    pre: [],
  });
});

// ── As franquias de referência (dados reais) ─────────────────────────────────

test('Solo Leveling: uma série, T1 e T2, sem o filme, o especial nem o videoclipe', () => {
  const s = seriesOf('ore-dake-level-up-na-ken');
  assert.ok(s);
  assert.equal(s.title, 'Solo Leveling');
  assert.equal(s.slug, 'solo-leveling');
  assert.equal(s.inheritsSlugFrom, null);
  assert.deepEqual(s.members.map((m) => m.slug), ['ore-dake-level-up-na-ken', 'ore-dake-level-up-na-ken-season-2-arise-from-the-shadow']);
  assert.deepEqual(seasons(s), ['T1', 'T2']);
  assert.equal(s.flagged, false);
});

test('Attack on Titan: S1, S2, S3 P1/P2, Final Season P1/P2; The Final Chapters (especial) fica de fora', () => {
  const s = seriesOf('shingeki-no-kyojin');
  assert.equal(s.title, 'Attack on Titan');
  assert.equal(s.slug, 'attack-on-titan');
  assert.deepEqual(s.members.map((m) => m.slug), [
    'shingeki-no-kyojin',
    'shingeki-no-kyojin-season-2',
    'shingeki-no-kyojin-season-3',
    'shingeki-no-kyojin-season-3-part-2',
    'shingeki-no-kyojin-the-final-season',
    'shingeki-no-kyojin-the-final-season-part-2',
  ]);
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3 P1', 'T3 P2', 'T4 P1', 'T4 P2']);
  assert.equal(seriesOf('shingeki-no-kyojin-the-final-season-kanketsu-hen'), null);
});

test('Demon Slayer: os cinco arcos pela ordem de estreia, sem o ONA da MLB', () => {
  const s = seriesOf('kimetsu-no-yaiba');
  assert.equal(s.title, 'Demon Slayer');
  assert.deepEqual(s.members.map((m) => m.slug), [
    'kimetsu-no-yaiba',
    'kimetsu-no-yaiba-mugen-ressha-hen',
    'kimetsu-no-yaiba-yuukaku-hen',
    'kimetsu-no-yaiba-katanakaji-no-sato-hen',
    'kimetsu-no-yaiba-hashira-geiko-hen',
  ]);
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.ok(s.members.every((m) => m.seasonFrom === 'ordem'));
  // Ligadas diretamente (S1 → Mugen TV → Yuukaku): nenhuma ponte a rever.
  assert.equal(s.doubts.filter((d) => d.tipo === 'ponte').length, 0);
});

test('Re:Zero: S1, S2 P1/P2, S3, S4', () => {
  const s = seriesOf('re-zero-kara-hajimeru-isekai-seikatsu');
  assert.equal(s.members.length, 5);
  assert.deepEqual(seasons(s), ['T1', 'T2 P1', 'T2 P2', 'T3', 'T4']);
  assert.match(s.title, /^Re:Zero - Starting Life in Another World$/i);
  // A "Break Time" (curtas) é outra cadeia e não entra.
  assert.ok(s.members.every((m) => !/break-time/.test(m.slug)));
});

test('Spy x Family: S1 em duas partes, S2, S3; a série herda o endereço da S1', () => {
  const s = seriesOf('spy-x-family');
  assert.equal(s.title, 'Spy x Family');
  assert.deepEqual(seasons(s), ['T1 P1', 'T1 P2', 'T2', 'T3']);
  assert.equal(s.slug, 'spy-x-family');
  assert.equal(s.inheritsSlugFrom, 'spy-x-family');
});

test('Oshi no Ko: quatro temporadas, sem os parênteses retos no nome', () => {
  const s = seriesOf('oshi-no-ko');
  assert.equal(s.title, 'Oshi no Ko');
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3', 'T4']);
});

test("Frieren: S1, S2 e o arco seguinte; o ONA '●● no Mahou' fica de fora", () => {
  const s = seriesOf('sousou-no-frieren');
  assert.equal(s.title, "Frieren: Beyond Journey's End");
  assert.deepEqual(s.members.map((m) => m.slug), ['sousou-no-frieren', 'sousou-no-frieren-2nd-season', 'sousou-no-frieren-ougonkyou-hen']);
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3']);
});

test('Apothecary Diaries: S3 em duas partes; os curtos do Maomao são outra série', () => {
  const s = seriesOf('kusuriya-no-hitorigoto');
  assert.equal(s.title, 'The Apothecary Diaries');
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3 P1', 'T3 P2']);
  assert.notEqual(seriesOf('maomao-no-hitorigoto'), s);
});

test('Mushoku Tensei: a linha já fundida não se duplica nem vira série', () => {
  // Seis fichas do AnimeSchedule, uma só linha na base (as outras foram
  // fundidas): não há série.
  assert.equal(seriesOf('mushoku-tensei-jobless-reincarnation'), null);
  // Com o anime_route_aliases (o que a service role lê), todas as rotas dão a
  // linha canónica, e ela conta uma vez, mesmo que uma linha da S2 tenha
  // voltado à base pelo manami.
  const canonical = FIX.rows.find((r) => r.slug === 'mushoku-tensei-jobless-reincarnation');
  const s2 = { ...canonical, id: '00000000-0000-4000-8000-000000000002', slug: 'mushoku-tensei-ii', title: 'Mushoku Tensei II', mal_id: 51179, popularity: 10 };
  const aliases = new Map(
    FIX.animeschedule.filter((e) => e.route.startsWith('mushoku-tensei')).map((e) => [e.route, canonical.id]),
  );
  const plan = planSeries({ asEntries: FIX.animeschedule, rows: [...FIX.rows, s2], aliases, overrides: OVERRIDES });
  assert.equal(seriesOf('mushoku-tensei-jobless-reincarnation', plan), null);
  assert.equal(seriesOf('mushoku-tensei-ii', plan), null);
  assert.ok(plan.stats.fichasNaMesmaLinha >= 4);
  // Sem aliases, a S2 que voltou JUNTA-SE à canónica (2 linhas, uma série).
  const sem = planSeries({ asEntries: FIX.animeschedule, rows: [...FIX.rows, s2], overrides: OVERRIDES });
  assert.deepEqual(seriesOf('mushoku-tensei-ii', sem).members.map((m) => m.slug), ['mushoku-tensei-jobless-reincarnation', 'mushoku-tensei-ii']);
});

test('Slime e One Piece: uma linha cada, sem série (o MONSTERS é um ONA de um episódio)', () => {
  assert.equal(seriesOf('that-time-i-got-reincarnated-as-a-slime'), null);
  assert.equal(seriesOf('tensura-nikki-tensei-shitara-slime-datta-ken'), null);
  assert.equal(seriesOf('one-piece'), null);
  assert.equal(seriesOf('monsters-ippyaku-sanjou-hiryuu-jigoku'), null);
});

test('KonoSuba: a ponte pelo filme junta as quatro temporadas, e fica como dúvida', () => {
  const s = seriesOf('kono-subarashii-sekai-ni-shukufuku-wo');
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3', 'T4']);
  assert.ok(s.doubts.some((d) => d.tipo === 'ponte' && d.por.includes('kono-subarashii-sekai-ni-shukufuku-wo-kurenai-densetsu')));
});

test('Dr. Stone: o nome da série é o começo comum, não o arco mais repetido', () => {
  const s = seriesOf('dr-stone');
  assert.equal(s.title, 'Dr. Stone');
  assert.deepEqual(seasons(s), ['T1', 'T2', 'T3 P1', 'T3 P2', 'T4 P1', 'T4 P2', 'T4 P3']);
  assert.equal(s.slug, 'dr-stone');
  assert.equal(s.inheritsSlugFrom, 'dr-stone');
});

test('Jujutsu Kaisen: Zenpen e Kouhen são as duas partes da temporada 3', () => {
  assert.deepEqual(seasons(seriesOf('jujutsu-kaisen')), ['T1', 'T2', 'T3 P1', 'T3 P2']);
});

test('as exceções do repositório: o Barakamon sem o Handa-kun', () => {
  const s = seriesOf('barakamon');
  assert.ok(s === null || s.members.every((m) => m.slug !== 'handa-kun'));
  const sem = planSeries({ asEntries: FIX.animeschedule, rows: FIX.rows });
  const junta = seriesOf('barakamon', sem);
  assert.ok(junta && junta.members.some((m) => m.slug === 'handa-kun'), 'sem a exceção, o AnimeSchedule junta-os');
});

test(`mais de ${MAX_MEMBERS} membros: sinalizada, e só se escreve aprovada`, () => {
  const s = seriesOf('yami-shibai');
  assert.ok(s.members.length > MAX_MEMBERS);
  assert.equal(s.flagged, true);
  const approved = planSeries({
    asEntries: FIX.animeschedule,
    rows: FIX.rows,
    overrides: parseSeriesOverrides({ approve: [{ ref: 'yami-shibai', why: 'revista' }] }),
  });
  assert.equal(seriesOf('yami-shibai', approved).flagged, false);
});

// ── Endereços ────────────────────────────────────────────────────────────────

test('slugify: a mesma regra da anime_slugify', () => {
  assert.equal(slugify('Solo Leveling'), 'solo-leveling');
  assert.equal(slugify("Frieren: Beyond Journey's End"), 'frieren-beyond-journey-s-end');
  assert.equal(slugify('Re:ZERO - Starting Life in Another World'), 're-zero-starting-life-in-another-world');
  assert.equal(slugify('Pokémon: Mezase Pokémon Master'), 'pokemon-mezase-pokemon-master');
  assert.equal(slugify('"Ai" wo Taberu'), 'ai-wo-taberu');
  assert.equal(slugify('進撃の巨人'), '');
  const long = slugify('I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability');
  assert.equal(long, 'i-was-reincarnated-as-the-7th-prince-so-i-can-take-my-time-perfecting-my');
  assert.ok(long.length <= 80);
});

test('o endereço da série: livre, herdado de um membro, ou com o ano se já é de outro', () => {
  const anime = new Map([
    ['spy-x-family', 'm1'],
    ['fruits-basket', 'outro'],
    ['fruits-basket-2019', 'outro2'],
  ]);
  const taken = { anime, series: new Set(['date-a-live']) };
  assert.deepEqual(chooseSeriesSlug('Solo Leveling', 'x', ['a', 'b'], taken), { slug: 'solo-leveling', natural: 'solo-leveling', inheritsFrom: null, collidedWith: null });
  assert.equal(chooseSeriesSlug('Spy x Family', 'x', ['m1', 'm2'], taken).inheritsFrom, 'm1');
  // O ano já está tomado por outro anime: o primeiro número livre.
  assert.equal(chooseSeriesSlug('Fruits Basket', 'x', ['a'], taken, 2019).slug, 'fruits-basket-2');
  assert.equal(chooseSeriesSlug('Fruits Basket', 'x', ['a'], taken, 2020).slug, 'fruits-basket-2020');
  assert.equal(chooseSeriesSlug('Date A Live', 'x', ['a'], taken, 2019).slug, 'date-a-live-2019');
  assert.equal(chooseSeriesSlug('進撃の巨人', 'shingeki-no-kyojin', ['a'], taken).slug, 'shingeki-no-kyojin');
});

test('nos dados reais: Fruits Basket (2019) não fica com o endereço do de 2001', () => {
  const s = seriesOf('fruits-basket-1st-season');
  assert.equal(s.slug, 'fruits-basket-2019');
  assert.equal(s.slugCollidedWith, 'fruits-basket');
});

test('nenhum endereço de série repete outro, nem é de um anime que não é membro', () => {
  const owner = new Map(FIX.rows.filter((r) => r.slug).map((r) => [r.slug, r.id]));
  const seen = new Set();
  for (const s of PLAN.series) {
    assert.ok(s.slug, s.title);
    assert.match(s.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(!seen.has(s.slug), s.slug);
    seen.add(s.slug);
    const o = owner.get(s.slug);
    assert.ok(o === undefined || s.members.some((m) => m.id === o), `${s.slug} é de outro anime`);
  }
});

test('idempotente: com as séries já escritas, o plano é o mesmo e os endereços não mudam', () => {
  const existing = PLAN.series.map((s) => ({ key: s.key, slug: s.slug }));
  const again = planSeries({ asEntries: FIX.animeschedule, rows: FIX.rows, overrides: OVERRIDES, existingSeries: existing });
  assert.deepEqual(
    again.series.map((s) => [s.key, s.slug, s.members.map((m) => [m.id, m.season, m.part, m.order])]),
    PLAN.series.map((s) => [s.key, s.slug, s.members.map((m) => [m.id, m.season, m.part, m.order])]),
  );
  assert.ok(again.series.every((s) => s.slugKept));
});

// ── Ficheiro de exceções e CLI ───────────────────────────────────────────────

test('series-overrides.json: válido, e cada exceção diz porquê', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/series-overrides.json', import.meta.url), 'utf8'));
  for (const kind of ['join', 'cut', 'split', 'approve', 'title', 'season']) {
    assert.ok(Array.isArray(raw[kind]), kind);
    for (const entry of raw[kind]) assert.ok(typeof entry.why === 'string' && entry.why.length > 10, `${kind}: falta o porquê`);
  }
  assert.equal(OVERRIDES.cut.length, raw.cut.length);
});

test('o resumo tem os números e as séries mais seguidas', () => {
  const text = formatSummary(PLAN, { top: 3 });
  assert.match(text, /séries a escrever \(as seguras, o que o --aplicar escreve por omissão\): \d+/);
  assert.match(text, /- Jujutsu Kaisen → \/anime\/jujutsu-kaisen/);
  assert.match(text, /Sinalizadas/);
});

test('--plan é o que corre por omissão; --aplicar tem de ser pedido', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs([]).plan, true);
  assert.equal(parseArgs(['--aplicar']).apply, true);
  assert.equal(parseArgs(['--json=/tmp/x.json']).json, '/tmp/x.json');
  assert.equal(parseArgs(['--aplicar']).includeDoubtful, false);
  assert.equal(parseArgs(['--aplicar', '--incluir-duvidosos']).includeDoubtful, true);
});

test('`series.js --dry-run` corre sem rede, sem base e sem credenciais', () => {
  const env = { ...process.env };
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'ANIMESCHEDULE_TOKEN']) delete env[k];
  const res = spawnSync(process.execPath, [fileURLToPath(new URL('../src/series.js', import.meta.url)), '--dry-run'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN .* séries/);
  assert.match(res.stdout, /nada escrito/);
});

// ── A escrita (com uma base de mentira, em memória) ──────────────────────────

/** O mínimo do cliente da Supabase que `applyPlan` usa, com a guarda de endereços da M3. */
function fakeSupabase(animes) {
  const series = [];
  const calls = [];
  let n = 0;
  const guard = (slug, id) => {
    if (slug == null) return null;
    if (series.some((x) => x.slug === slug && x.id !== id)) return { code: '23505', message: 'series_slug_key' };
    if (animes.some((a) => a.slug === slug && a.series_id !== id)) return { code: '23505', message: 'series_check_slug' };
    return null;
  };
  const table = (name) => (name === 'series' ? series : animes);
  return {
    calls,
    series,
    from(name) {
      return {
        select: () => Promise.resolve({ data: table(name).map((x) => ({ ...x })), error: null }),
        insert(obj) {
          calls.push(['insert', name, obj]);
          const row = { id: `s${++n}`, ...obj };
          const error = guard(row.slug, row.id);
          if (!error) series.push(row);
          const res = { data: error ? null : { ...row }, error };
          return { select: () => ({ single: () => Promise.resolve(res) }) };
        },
        update(patch) {
          return {
            eq(_col, id) {
              calls.push(['update', name, id, patch]);
              const row = table(name).find((x) => x.id === id);
              if (name === 'series' && 'slug' in patch) {
                const error = guard(patch.slug, id);
                if (error) return Promise.resolve({ error });
              }
              Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

test('aplicar: série sem endereço, membros ligados, e só depois o endereço (herdado); a 2.ª vez não escreve', async () => {
  const rows = FIX.rows.map((r) => ({ ...r, series_id: null, series_season: null, series_part: null, series_order: null }));
  const db = fakeSupabase(rows);
  const only = { ...PLAN, series: PLAN.series.filter((s) => ['spy-x-family', 'solo-leveling', 'yami-shibai'].some((x) => s.slug.startsWith(x))) };
  const first = await applyPlan(db, structuredClone(only), rows, { pauseMs: 0 });
  assert.equal(first.seriesNovas, 2); // o Yami Shibai está sinalizado: não se escreve
  assert.equal(first.linhas, 6);
  assert.equal(first.slugs, 2);
  // A ordem: o insert da série vem sem endereço, o endereço depois dos membros.
  const spyInsert = db.calls.findIndex((c) => c[0] === 'insert' && c[2].key.includes('spy-x-family'));
  const spySlug = db.calls.findIndex((c) => c[0] === 'update' && c[1] === 'series' && c[3].slug === 'spy-x-family');
  const spyMember = db.calls.findIndex((c) => c[0] === 'update' && c[1] === 'animes' && rows.find((r) => r.id === c[2])?.slug === 'spy-x-family');
  assert.equal(db.calls[spyInsert][2].slug, null);
  assert.ok(spyInsert < spyMember && spyMember < spySlug);
  assert.deepEqual(db.series.map((x) => x.slug).sort(), ['solo-leveling', 'spy-x-family']);
  const s2 = rows.find((r) => r.slug === 'ore-dake-level-up-na-ken-season-2-arise-from-the-shadow');
  assert.equal(s2.series_season, 2);
  assert.equal(s2.series_order, 2);
  // Nunca se escreve noutra tabela.
  assert.ok(db.calls.every((c) => c[1] === 'series' || c[1] === 'animes'));

  const before = db.calls.length;
  const again = planSeries({ asEntries: FIX.animeschedule, rows, overrides: OVERRIDES, existingSeries: db.series });
  const onlyAgain = { ...again, series: again.series.filter((s) => only.series.some((o) => o.key === s.key)) };
  const second = await applyPlan(db, onlyAgain, rows, { pauseMs: 0 });
  assert.equal(db.calls.length, before, JSON.stringify(db.calls.slice(before)));
  assert.deepEqual([second.seriesNovas, second.linhas, second.slugs, second.desligadas], [0, 0, 0, 0]);
});

test('aplicar: um membro que sai (uma exceção nova) é desligado; a série não se apaga', async () => {
  const rows = FIX.rows.map((r) => ({ ...r, series_id: null, series_season: null, series_part: null, series_order: null }));
  const db = fakeSupabase(rows);
  const pick = (p) => ({ ...p, series: p.series.filter((s) => s.key === 'as:solo-leveling') });
  await applyPlan(db, pick(PLAN), rows, { pauseMs: 0 });
  const split = planSeries({
    asEntries: FIX.animeschedule,
    rows,
    overrides: parseSeriesOverrides({ split: [{ ref: 'solo-leveling-arise-from-the-shadow', why: 'teste' }] }),
    existingSeries: db.series,
  });
  const res = await applyPlan(db, pick(split), rows, { pauseMs: 0 });
  assert.equal(res.desligadas, 2);
  assert.deepEqual(res.seriesSemMembros, ['as:solo-leveling']);
  assert.equal(db.series.length, 1);
  assert.ok(rows.every((r) => r.series_id === null));
});

// ── Só os seguros (decisão do dono, 2026-11-05) ──────────────────────────────

test('só os seguros: ponte, derivado? e > 12 membros ficam para revisão; as de referência são seguras', () => {
  for (const slug of ['ore-dake-level-up-na-ken', 'sousou-no-frieren', 'shingeki-no-kyojin', 'jujutsu-kaisen', 'spy-x-family', 'kimetsu-no-yaiba', 'oshi-no-ko']) {
    const s = seriesOf(slug);
    assert.equal(s.review, false, `${slug}: ${s.reviewReasons}`);
  }
  assert.deepEqual(seriesOf('kono-subarashii-sekai-ni-shukufuku-wo').reviewReasons, ['ponte']);
  assert.deepEqual(seriesOf('yami-shibai').reviewReasons, [`mais de ${MAX_MEMBERS} membros`]);
  // Uma ponte aprovada à mão deixa de ficar para revisão.
  const approved = planSeries({
    asEntries: FIX.animeschedule,
    rows: FIX.rows,
    overrides: parseSeriesOverrides({ approve: [{ ref: 'kono-subarashii-sekai-ni-shukufuku-wo', why: 'revista' }] }),
  });
  assert.equal(seriesOf('kono-subarashii-sekai-ni-shukufuku-wo', approved).review, false);
  // As contas: seguras + para revisão = todas.
  assert.equal(PLAN.stats.series + PLAN.stats.paraRevisao, PLAN.series.length);
  assert.equal(PLAN.stats.revisaoPorMotivo.ponte, PLAN.series.filter((s) => s.reviewReasons.includes('ponte')).length);
  const list = formatReviewList(PLAN);
  assert.match(list, /KONOSUBA.*\[ponte\]/);
  assert.doesNotMatch(list, /Solo Leveling →/);
  assert.match(formatSummary(PLAN), /para revisão \(ficam fichas soltas/);
});

test('aplicar: por omissão só as seguras; --incluir-duvidosos junta as de ponte, nunca as de > 12 sem approve', async () => {
  const keys = ['as:solo-leveling', 'as:kono-subarashii-sekai-ni-shukufuku-wo', 'as:yami-shibai'];
  const pick = { ...PLAN, series: PLAN.series.filter((s) => keys.includes(s.key)) };
  assert.equal(pick.series.length, 3);

  const rows = FIX.rows.map((r) => ({ ...r, series_id: null, series_season: null, series_part: null, series_order: null }));
  const db = fakeSupabase(rows);
  const safe = await applyPlan(db, structuredClone(pick), rows, { pauseMs: 0 });
  assert.equal(safe.seriesNovas, 1);
  assert.deepEqual(db.series.map((x) => x.key), ['as:solo-leveling']);

  const rows2 = FIX.rows.map((r) => ({ ...r, series_id: null, series_season: null, series_part: null, series_order: null }));
  const db2 = fakeSupabase(rows2);
  const all = await applyPlan(db2, structuredClone(pick), rows2, { pauseMs: 0, includeDoubtful: true });
  assert.equal(all.seriesNovas, 2);
  assert.deepEqual(db2.series.map((x) => x.key).sort(), ['as:kono-subarashii-sekai-ni-shukufuku-wo', 'as:solo-leveling']);
});

test('aplicar: uma série que passa a ficar para revisão não é desfeita', async () => {
  const rows = FIX.rows.map((r) => ({ ...r, series_id: null, series_season: null, series_part: null, series_order: null }));
  const db = fakeSupabase(rows);
  const key = 'as:kono-subarashii-sekai-ni-shukufuku-wo';
  const pick = (p) => ({ ...p, series: p.series.filter((s) => s.key === key) });
  await applyPlan(db, pick(PLAN), rows, { pauseMs: 0, includeDoubtful: true });
  const linked = rows.filter((r) => r.series_id).length;
  assert.equal(linked, 4);
  const res = await applyPlan(db, pick(PLAN), rows, { pauseMs: 0 });
  assert.equal(res.desligadas, 0);
  assert.equal(rows.filter((r) => r.series_id).length, linked);
});
