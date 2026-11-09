import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ACCENTS_FROM,
  ACCENTS_TO,
  MAX_ALT_TITLES,
  altNames,
  animescheduleNames,
  cleanName,
  isUsefulName,
  manamiNames,
  newNamesFor,
  normName,
} from '../src/names.js';
import { manamiNamesByMal, planUpdates } from '../src/alt-titles.js';
import { buildRows } from '../src/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../../supabase/migrations/20260928000000_titulos_alternativos.sql');

test('a tabela de acentos é a mesma da nimu_norm no SQL', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const fn = sql.slice(sql.indexOf('function public.nimu_norm'), sql.indexOf('comment on function public.nimu_norm'));
  // As duas strings do `translate`: entre plicas, numa só linha, compridas.
  const strings = [...fn.matchAll(/'([^'\n]{50,})'/g)].map((m) => m[1]);
  assert.deepEqual(strings, [ACCENTS_FROM, ACCENTS_TO]);
  assert.equal([...ACCENTS_FROM].length, [...ACCENTS_TO].length);
});

test('normName: acentos, maiúsculas e pontuação', () => {
  assert.equal(normName('Pokémon'), 'pokemon');
  assert.equal(normName('  Re:Zero — Starting!! '), 're zero starting');
  assert.equal(normName('Shōnen Ōji'), 'shonen oji');
  assert.equal(normName('Ataque dos Titãs'), 'ataque dos titas');
  assert.equal(normName('バルよめ'), '');
  assert.equal(normName(null), '');
});

test('isUsefulName: só alfabeto latino', () => {
  assert.equal(isUsefulName('The Warrior Princess and the Barbaric King'), true);
  assert.equal(isUsefulName('Ataque dos Titãs'), true);
  assert.equal(isUsefulName('BaruYome'), true);
  assert.equal(isUsefulName('姫騎士は蛮族の嫁'), false);
  assert.equal(isUsefulName('Атака титанов'), false);
  assert.equal(isUsefulName('進撃の巨人 attack on titan'), false);
  assert.equal(isUsefulName('!!'), false);
  assert.equal(isUsefulName('A'), false);
  assert.equal(isUsefulName(''), false);
  assert.equal(isUsefulName(undefined), false);
});

test('cleanName: fora marcas de direção, largura zero e controlo', () => {
  assert.equal(cleanName('Evil\u202Egnp.exe'), 'Evilgnp.exe');
  assert.equal(cleanName('One\u200BPiece'), 'OnePiece');
  assert.equal(cleanName('Tab\there'), 'Tabhere');
  assert.deepEqual(altNames(['\u202EThe Warrior Princess and the Barbaric King']), ['The Warrior Princess and the Barbaric King']);
});

test('altNames: sem o título, sem repetidos, ordem da fonte, com teto', () => {
  const names = altNames(
    [
      'Himekishi wa Barbaroi no Yome',
      'BaruYome',
      'The Warrior Princess and the Barbaric King',
      'the warrior princess AND the barbaric king!',
      '姫騎士は蛮族の嫁',
      '  ',
    ],
    'Himekishi wa Barbaroi no Yome',
  );
  assert.deepEqual(names, ['BaruYome', 'The Warrior Princess and the Barbaric King']);
  const many = altNames(Array.from({ length: 60 }, (_, i) => `Name ${i}`));
  assert.equal(many.length, MAX_ALT_TITLES);
  assert.equal(altNames(['x'.repeat(300)])[0].length, 200);
});

test('animescheduleNames: romaji, inglês, abreviatura e sinónimos', () => {
  const detail = {
    names: {
      romaji: 'Sousou no Frieren 2nd Season',
      english: "Frieren: Beyond Journey's End Season 2",
      native: '葬送のフリーレン 第2期',
      abbreviation: 'Frieren S2',
      synonyms: ['Frieren at the Funeral 2'],
    },
  };
  const names = altNames(animescheduleNames({ title: 'Sousou no Frieren 2nd Season' }, detail), "Frieren: Beyond Journey's End Season 2");
  assert.deepEqual(names, ['Sousou no Frieren 2nd Season', 'Frieren S2', 'Frieren at the Funeral 2']);
});

test('newNamesFor: só o que ainda não está na linha', () => {
  const row = { title: 'Shingeki no Kyojin', alt_titles: ['Attack on Titan'] };
  assert.deepEqual(newNamesFor(row, ['Shingeki no Kyojin', 'attack on titan', 'AoT', 'Ataque dos Titãs']), ['AoT', 'Ataque dos Titãs']);
  assert.deepEqual(newNamesFor(row, ['Attack on Titan']), []);
  const full = { title: 'X', alt_titles: Array.from({ length: MAX_ALT_TITLES }, (_, i) => `N${i} name`) };
  assert.deepEqual(newNamesFor(full, ['Something new']), []);
});

test('manamiNamesByMal + planUpdates: o caso que o Pedro encontrou', () => {
  const entries = [
    {
      title: 'Himekishi wa Barbaroi no Yome',
      sources: ['https://myanimelist.net/anime/60028', 'https://anilist.co/anime/182483'],
      synonyms: ['BaruYome', 'The Warrior Princess and the Barbaric King', 'バルよめ'],
    },
    { title: 'Sem MAL', sources: ['https://kitsu.app/anime/1'], synonyms: ['Nope'] },
  ];
  const byMal = manamiNamesByMal(entries);
  assert.deepEqual(byMal.get(60028), manamiNames(entries[0]));
  assert.equal(byMal.size, 1);

  const rows = [
    { id: 'a', mal_id: 60028, title: 'Himekishi wa Barbaroi no Yome', alt_titles: [] },
    { id: 'b', mal_id: 60028, title: 'Himekishi wa Barbaroi no Yome', alt_titles: ['BaruYome', 'The Warrior Princess and the Barbaric King'] },
    { id: 'c', mal_id: 1, title: 'Outro', alt_titles: [] },
  ];
  assert.deepEqual(planUpdates(rows, byMal), [
    { id: 'a', names: ['BaruYome', 'The Warrior Princess and the Barbaric King'] },
  ]);
});

test('buildRows devolve os nomes de cada série, sem o título', async () => {
  const read = async (name) => JSON.parse(await readFile(resolve(here, 'fixtures', name), 'utf8'));
  const timetable = await read('timetable-week.json');
  const details = await read('anime-details.json');
  const { animeRows, namesByRoute } = buildRows({
    timetableEntries: timetable,
    detailsByRoute: new Map(Object.entries(details)),
  });
  assert.ok(animeRows.length > 0);
  assert.ok([...namesByRoute.values()].some((names) => names.length > 0));
  for (const row of animeRows) {
    const names = namesByRoute.get(row.animeschedule_route);
    assert.ok(Array.isArray(names));
    assert.ok(!names.map(normName).includes(normName(row.title)));
  }
});
