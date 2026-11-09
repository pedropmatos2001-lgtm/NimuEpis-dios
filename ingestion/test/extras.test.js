import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  classifyExtra,
  hasPvTitle,
  isManamiMusicClip,
  loadOverrides,
  manamiSeconds,
  parseOverrides,
  planReclassification,
} from '../src/extras.js';
import { fetchAsMusicMal, isAsMusic, manamiByMalIndex, summarize } from '../src/reclassify-extras.js';
import { animescheduleToAnimeRow } from '../src/mappers.js';
import { manamiEntryToAnimeRow } from '../src/catalogue-mappers.js';

// Linhas REAIS (catálogo e manami de 2026-11-04): videoclipes e PV que têm de
// sair, e séries de música, curtas e especiais verdadeiros que têm de ficar.
const REAIS = JSON.parse(readFileSync(new URL('./fixtures/extras-reais.json', import.meta.url), 'utf8'));
const OVERRIDES = loadOverrides();

function classifyFixture(f, overrides = OVERRIDES) {
  return classifyExtra(
    {
      mal: f.row.mal_id,
      title: f.row.title,
      mediaType: f.row.media_type,
      asMediaTypes: (f.animeschedule ?? []).includes('Music') ? ['Music'] : [],
      asDecides: Boolean(f.row.animeschedule_route) || f.row.popularity != null,
      manami: f.manami,
    },
    overrides,
  );
}

test('as linhas reais: cada uma tem a classificação esperada', () => {
  assert.ok(REAIS.length >= 40, 'a fixture tem de ter exemplos suficientes');
  for (const f of REAIS) {
    assert.equal(classifyFixture(f), f.expected, `${f.row.title}`);
  }
});

test('positivos: o "Echo" do Solo Leveling é um videoclipe', () => {
  const echo = REAIS.find((f) => f.row.title === 'Echo');
  assert.equal(classifyFixture(echo), 'Music');
  // E sem o AnimeSchedule (que não tem esta ficha), só pelo manami.
  assert.equal(isManamiMusicClip(echo.manami), true);
});

test('negativos: séries de música a sério ficam (Oshi no Ko, Given, Bocchi, Love Live)', () => {
  for (const title of [
    '[Oshi no Ko]',
    '[Oshi no Ko] 2nd Season',
    'Given',
    'Given Movie 1',
    'Bocchi the Rock!',
    'Bocchi the Rock! Movie',
    'Love Live! School Idol Project',
    'Love Live! Sunshine!!',
    'Love Live! Sunshine!! Recap',
    'Liella no Uta',
    'K-On!',
    'Girls Band Cry',
  ]) {
    const f = REAIS.find((x) => x.row.title === title);
    assert.ok(f, `falta ${title} na fixture`);
    assert.equal(classifyFixture(f), null, title);
  }
});

test('negativos: curtas e especiais verdadeiros ficam (Teekyuu, Hetalia, ●● no Mahou…)', () => {
  for (const title of [
    'Teekyuu',
    'Hetalia Axis Powers',
    'Aiura',
    'Hacka Doll The Animation',
    'Isekai Quartet',
    'Sousou no Frieren: ●● no Mahou',
    'Danshi Koukousei no Nichijou Specials',
    'Bocchi the Rock!: Gotou Futari no Onee-chan Kansatsu Nikki',
    'Love Live! Superstar!! 3rd Season (TV Special)',
  ]) {
    const f = REAIS.find((x) => x.row.title === title);
    assert.ok(f, `falta ${title} na fixture`);
    assert.equal(classifyFixture(f), null, title);
  }
});

test('a lista de exceções manda: sem ela, o Jango e os prólogos do ef seriam marcados', () => {
  const none = parseOverrides({});
  for (const title of ['One Piece: Jango no Dance Carnival', 'ef: A Tale of Memories. - Prologue']) {
    const f = REAIS.find((x) => x.row.title === title);
    assert.equal(classifyFixture(f, none), 'Music', `${title} sem exceções`);
    assert.equal(classifyFixture(f), null, `${title} com exceções`);
  }
  const forced = parseOverrides({ extra: [{ mal: 21, type: 'PV' }, { mal: 22, type: 'Outro' }] });
  assert.equal(classifyExtra({ mal: 21, title: 'One Piece', mediaType: 'TV' }, forced), 'PV');
  assert.equal(forced.extra.has(22), false, 'um tipo desconhecido no ficheiro é ignorado');
});

test('regra do AnimeSchedule: "Music" ganha a tudo, menos à lista keep', () => {
  assert.equal(classifyExtra({ title: 'Snow Halation', mediaType: 'Special', asMediaTypes: ['Music'] }), 'Music');
  assert.equal(classifyExtra({ title: 'X', mediaType: 'Movie', asMediaTypes: [{ name: 'Music' }] }), 'Music');
  assert.equal(classifyExtra({ title: 'X', mediaType: 'Special', asMediaTypes: [{ name: 'Special' }] }), null);
});

test('regra do AnimeSchedule: "Music" ao lado de TV ou TV Short não esconde a série', () => {
  assert.equal(classifyExtra({ title: 'Idol Show', mediaType: 'TV', asMediaTypes: [{ name: 'TV' }, { name: 'Music' }] }), null);
  assert.equal(classifyExtra({ title: 'Idol Show', mediaType: 'Music', asMediaTypes: [{ name: 'Music' }, { name: 'TV Short' }] }), null);
  // E o mapeador guarda o formato de série, não "Music".
  assert.equal(
    animescheduleToAnimeRow({ route: 'i', title: 'Idol Show' }, { mediaTypes: [{ name: 'Music' }, { name: 'TV' }] }).media_type,
    'TV',
  );
});

test('lista keep no AnimeSchedule: o mapeador nunca escreve "Music" (sem vaivém com a reclassificação)', () => {
  const entry = { route: 'jango', title: 'One Piece: Jango no Dance Carnival' };
  const detail = { mediaTypes: [{ name: 'Music' }], websites: { mal: 'https://myanimelist.net/anime/2385' } };
  const row = animescheduleToAnimeRow(entry, detail);
  assert.equal(row.media_type, 'Special');
  // E a passagem seguinte não tem nada a mudar nessa linha.
  const manamiByMal = new Map([[2385, { type: 'SPECIAL', episodes: 1, duration: { value: 360 }, tags: ['music'] }]]);
  const rows = [{ id: 'a', mal_id: 2385, title: entry.title, media_type: row.media_type, animeschedule_route: 'jango' }];
  assert.deepEqual(planReclassification(rows, { manamiByMal, asMusicMal: new Set([2385]), overrides: OVERRIDES }), []);
});

test('planReclassification: keep sem entrada no manami volta a "Special", nunca a null', () => {
  const rows = [{ id: 'a', mal_id: 2385, title: 'One Piece: Jango no Dance Carnival', media_type: 'Music' }];
  assert.deepEqual(planReclassification(rows, { manamiByMal: new Map(), overrides: OVERRIDES }), [
    { id: 'a', media_type: 'Special', from: 'Music', why: 'keep' },
  ]);
});

test('regra do título: PV, CM, Teaser e Trailer como palavra, nunca a meio de outra', () => {
  for (const t of [
    'Fate/strange Fake PV',
    'Granblue Fantasy CMs',
    'Shounen Sunday CM: ARMS',
    'Boogiepop and Others: Promotional Trailer',
    'Dungeon Meshi PVs',
    'Chainsaw Man Teaser',
    'Candy Caries (PV)',
  ]) {
    assert.equal(hasPvTitle(t), true, t);
  }
  for (const t of [
    'Karakai Jouzu no Takagi-san',
    'Teasing Master Takagi-san',
    'Space Brothers',
    'PVZ Heroes',
    'Kanpai CMYK',
    'cmon',
    'Gakkou Gurashi!',
    null,
  ]) {
    assert.equal(hasPvTitle(t), false, String(t));
  }
});

test('regra do título: nunca numa série de TV, nunca num episódio longo', () => {
  assert.equal(classifyExtra({ title: 'Bamboo Blade: CM Fanfu-Fufe-Fo', mediaType: 'Special' }), 'PV');
  assert.equal(classifyExtra({ title: 'Imaginary CM Show', mediaType: 'TV' }), null);
  assert.equal(classifyExtra({ title: 'Imaginary CM Show', mediaType: 'TV Short' }), null);
  assert.equal(
    classifyExtra({ title: 'Trailer Park', mediaType: 'Movie', manami: { type: 'MOVIE', duration: { value: 5400, unit: 'SECONDS' } } }),
    null,
    'um filme de hora e meia com "Trailer" no título não é um trailer',
  );
  assert.equal(
    classifyExtra({ title: 'Some Show CM', mediaType: null, manami: { type: 'TV', episodes: 12 } }),
    null,
  );
});

test('regra do manami: SPECIAL + etiqueta music + ≤1 episódio + duração conhecida ≤8 min', () => {
  const clip = { type: 'SPECIAL', episodes: 1, duration: { value: 180, unit: 'SECONDS' }, tags: ['music'] };
  assert.equal(isManamiMusicClip(clip), true);
  assert.equal(isManamiMusicClip({ ...clip, tags: ['Music'] }), true);
  assert.equal(isManamiMusicClip({ ...clip, episodes: 2 }), false, 'dois episódios já é uma série');
  assert.equal(isManamiMusicClip({ ...clip, duration: { value: 481, unit: 'SECONDS' } }), false);
  assert.equal(isManamiMusicClip({ ...clip, duration: null }), false, 'sem duração não se adivinha');
  assert.equal(isManamiMusicClip({ ...clip, tags: ['comedy'] }), false);
  assert.equal(isManamiMusicClip({ ...clip, type: 'ONA' }), false);
  assert.equal(isManamiMusicClip({ ...clip, type: 'TV' }), false);
  assert.equal(isManamiMusicClip({ ...clip, type: 'MOVIE' }), false);
  assert.equal(manamiSeconds({ duration: { value: 3, unit: 'MINUTES' } }), 180);
  // Uma linha que o AnimeSchedule decide (tem rota ou seguidores) não usa esta regra.
  assert.equal(classifyExtra({ title: 'Echo', mediaType: 'Special', manami: clip, asDecides: true }), null);
  assert.equal(classifyExtra({ title: 'Echo', mediaType: 'Special', manami: clip }), 'Music');
});

test('planReclassification: só escreve o que muda, e uma segunda passagem não escreve nada', () => {
  const rows = REAIS.map((f, i) => ({ id: `r${i}`, ...f.row }));
  const manamiByMal = new Map(REAIS.map((f) => [f.row.mal_id, f.manami]));
  const asMusicMal = new Set(REAIS.filter((f) => (f.animeschedule ?? []).includes('Music')).map((f) => f.row.mal_id));
  const plan = planReclassification(rows, { manamiByMal, asMusicMal, overrides: OVERRIDES });
  const esperados = REAIS.filter((f) => f.expected !== null).length;
  assert.equal(plan.length, esperados);
  for (const u of plan) assert.ok(['Music', 'PV'].includes(u.media_type));

  // Aplicar e voltar a planear: idempotente.
  const depois = rows.map((r) => ({ ...r, media_type: plan.find((u) => u.id === r.id)?.media_type ?? r.media_type }));
  assert.deepEqual(planReclassification(depois, { manamiByMal, asMusicMal, overrides: OVERRIDES }), []);

  // Sem o AnimeSchedule nesta corrida, nada do que já foi marcado se desfaz.
  assert.deepEqual(planReclassification(depois, { manamiByMal, asMusicMal: null, overrides: OVERRIDES }), []);

  const resumo = summarize(rows, plan);
  assert.equal(resumo.aMudar, esperados);
});

test('planReclassification: a lista keep devolve uma linha marcada ao formato do manami', () => {
  const rows = [{ id: 'a', mal_id: 2385, title: 'One Piece: Jango no Dance Carnival', media_type: 'Music' }];
  const manamiByMal = new Map([[2385, { type: 'SPECIAL', episodes: 1, duration: { value: 360 }, tags: ['music'] }]]);
  assert.deepEqual(planReclassification(rows, { manamiByMal, overrides: OVERRIDES }), [
    { id: 'a', media_type: 'Special', from: 'Music', why: 'keep' },
  ]);
});

test('fetchAsMusicMal: só aceita o filtro se todas as fichas vierem "Music"', async () => {
  const music = (mal) => ({ mediaTypes: [{ name: 'Music' }], websites: { mal: `myanimelist.net/anime/${mal}` } });
  const tv = { mediaTypes: [{ name: 'TV' }], websites: {} };
  const pages = {
    'mt=music': [[music(1), music(2)], [music(3)]],
    'mt=Music': [[music(9)]],
  };
  const extract = (w) => Number(/anime\/(\d+)/.exec(w?.mal ?? '')?.[1] ?? NaN);

  // A primeira forma é ignorada pela API (vem uma TV): passa à segunda.
  const ignored = async ({ page, query }) =>
    query === 'mt=music' ? { anime: [tv, music(1)], totalAmount: 19000 } : { anime: pages[query][page - 1] ?? [], totalAmount: 1 };
  const r1 = await fetchAsMusicMal(ignored, extract, { filters: ['mt=music', 'mt=Music'] });
  assert.equal(r1.query, 'mt=Music');
  assert.deepEqual([...r1.mal], [9]);

  // A forma certa, com duas páginas (18 por página, total 19 → 2 páginas).
  const honoured = async ({ page, query }) => ({ anime: pages[query][page - 1] ?? [], totalAmount: 19 });
  const r2 = await fetchAsMusicMal(honoured, extract, { filters: ['mt=music'] });
  assert.equal(r2.complete, true);
  assert.deepEqual([...r2.mal].sort(), [1, 2, 3]);

  // Nenhuma forma serve: null, e as outras regras continuam sem ela.
  const never = async () => ({ anime: [tv], totalAmount: 19000 });
  assert.equal(await fetchAsMusicMal(never, extract, { filters: ['mt=music'] }), null);

  // Uma falha a meio: o que se leu vale nesta corrida, marcado como incompleto.
  let n = 0;
  const breaks = async () => {
    n += 1;
    if (n > 1) throw new Error('HTTP 429');
    return { anime: [music(5)], totalAmount: 100 };
  };
  const r3 = await fetchAsMusicMal(breaks, extract, { filters: ['mt=music'] });
  assert.equal(r3.complete, false);
  assert.deepEqual([...r3.mal], [5]);
  assert.equal(isAsMusic({ mediaTypes: [{ name: 'music' }] }), true);
});

test('manamiByMalIndex: indexa pelo mal_id das sources', () => {
  const idx = manamiByMalIndex([{ sources: ['https://myanimelist.net/anime/51321'], title: 'Echo' }]);
  assert.equal(idx.get(51321).title, 'Echo');
});

test('ingestão normal: o manami entra já classificado', () => {
  const echo = {
    sources: ['https://myanimelist.net/anime/51321'],
    title: 'Echo',
    type: 'SPECIAL',
    episodes: 1,
    status: 'FINISHED',
    animeSeason: { season: 'WINTER', year: 2022 },
    duration: { value: 180, unit: 'SECONDS' },
    tags: ['action', 'music'],
    synonyms: ['The Boyz - Echo (Solo Leveling OST)'],
  };
  assert.equal(manamiEntryToAnimeRow(echo).media_type, 'Music');
  const given = { ...echo, sources: ['https://myanimelist.net/anime/39533'], title: 'Given', type: 'TV', episodes: 11, duration: { value: 1320 } };
  assert.equal(manamiEntryToAnimeRow(given).media_type, 'TV');
  const pv = { ...echo, sources: ['https://myanimelist.net/anime/1'], title: 'Dungeon Meshi PVs', episodes: 2, duration: { value: 58 }, tags: [] };
  assert.equal(manamiEntryToAnimeRow(pv).media_type, 'PV');
});

test('ingestão normal: o AnimeSchedule mantém "Music" e marca os PV pelo título', () => {
  const entry = { route: 'r', title: 'Fate/strange Fake PV' };
  assert.equal(animescheduleToAnimeRow(entry, { mediaTypes: [{ name: 'Special' }] }).media_type, 'PV');
  assert.equal(
    animescheduleToAnimeRow({ route: 's', title: 'Snow Halation' }, { mediaTypes: [{ name: 'Music' }] }).media_type,
    'Music',
  );
  assert.equal(
    animescheduleToAnimeRow({ route: 'o', title: 'Oshi no Ko' }, { mediaTypes: [{ name: 'TV' }] }).media_type,
    'TV',
  );
  // Uma série de TV com "CM" no título continua a ser TV.
  assert.equal(
    animescheduleToAnimeRow({ route: 'c', title: 'Imaginary CM Show' }, { mediaTypes: [{ name: 'TV' }] }).media_type,
    'TV',
  );
});

test('`reclassify-extras.js --dry-run` corre sem rede, sem base e sem segredos', () => {
  const env = { ...process.env };
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'ANIMESCHEDULE_TOKEN']) delete env[key];
  const res = spawnSync(process.execPath, [fileURLToPath(new URL('../src/reclassify-extras.js', import.meta.url)), '--dry-run'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /nada escrito/);
});
