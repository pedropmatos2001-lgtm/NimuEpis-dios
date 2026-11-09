/**
 * O filtro que impede o TVDB de nos dar uma série de imagem real.
 *
 * O caso que o fez nascer: a pesquisa "Hell Mode" devolveu em primeiro lugar
 * uma série chinesa de imagem real, e o billboard da home passou a mostrar
 * duas pessoas por trás de um isekai. A mesma pesquisa grava o id do TVDB de
 * onde saem os episódios, portanto um resultado errado não fica pelo banner.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeTitle, pickMatchingHit } from '../src/tvdb.js';

// Resultados REAIS da pesquisa do TVDB (sonda de 2026-09-22), só com os campos
// que contam. Repara que não trazem `genres`: foi isso que partiu o primeiro
// filtro.
const HELL_MODE = [
  { tvdb_id: '461730', name: '白日梦与她', country: 'chn', aliases: ['Hello, Model'], translations: { eng: 'Wanna Be (2025)' } },
  { tvdb_id: '468486', name: '地獄は善意で出来ている', country: 'jpn', aliases: ['jigodeki', 'Hell is Made of Good Intentions'] },
  {
    tvdb_id: '457532',
    name: 'ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～',
    country: 'jpn',
    aliases: ['Hell Mode'],
    translations: { eng: 'Hell Mode: The Hardcore Gamer Dominates in Another World with Garbage Balancing' },
  },
];
const ONE_PIECE = [
  { tvdb_id: '392276', name: 'ONE PIECE (2023)', country: 'usa', aliases: ['One Piece'] },
  { tvdb_id: '81797', name: 'One Piece', country: 'jpn', aliases: [] },
];
const RE_ZERO = [
  { tvdb_id: '374586', name: 'Jezero', country: 'svn', aliases: [] },
  { tvdb_id: '305089', name: 'Re：ゼロから始める異世界生活', country: 'jpn', aliases: ['Re:ZERO -Starting Life in Another World-'] },
];

test('o Hell Mode já não cai na série chinesa de imagem real', () => {
  assert.equal(pickMatchingHit(HELL_MODE, 'Hell Mode')?.tvdb_id, '457532');
  assert.equal(
    pickMatchingHit(HELL_MODE, 'Hell Mode: The Hardcore Gamer Dominates in Another World with Garbage Balancing')?.tvdb_id,
    '457532',
  );
});

test('a adaptação de imagem real (EUA) fica de fora mesmo com o alias igual', () => {
  assert.equal(pickMatchingHit(ONE_PIECE, 'One Piece')?.tvdb_id, '81797');
});

test('a pesquisa difusa não passa: Re:Zero encontra o Re:Zero e não o Jezero', () => {
  assert.equal(pickMatchingHit(RE_ZERO, 'Re:Zero - Starting Life in Another World')?.tvdb_id, '305089');
  assert.equal(pickMatchingHit(RE_ZERO, 'Re:Zero'), null);
});

test('o ano de desambiguação do TVDB não impede o encontro', () => {
  const hits = [{ tvdb_id: '451468', name: '时光代理人Link Click', country: 'chn', translations: { eng: 'Link Click (2024)' } }];
  assert.equal(pickMatchingHit(hits, 'LINK CLICK')?.tvdb_id, '451468');
});

test('sem título igual não há resultado, e respostas malformadas não rebentam', () => {
  assert.equal(pickMatchingHit(HELL_MODE, 'Hello'), null);
  assert.equal(pickMatchingHit(undefined, 'x'), null);
  assert.equal(pickMatchingHit([null, { name: 'x', country: 'jpn' }], 'x'), null);
  assert.equal(pickMatchingHit(HELL_MODE, ''), null);
});

test('normalizeTitle ignora pontuação, maiúsculas, acentos e o (ano)', () => {
  assert.equal(normalizeTitle('Re:ZERO -Starting Life in Another World-'), normalizeTitle('Re:Zero - Starting Life in Another World'));
  assert.equal(normalizeTitle('Pokémon'), 'pokemon');
  assert.equal(normalizeTitle('Link Click (2024)'), 'linkclick');
});

test('lê o id da série nos dois formatos de URL de arte do TVDB', async () => {
  const { seriesIdFromArtworkUrl } = await import('../src/verify-tvdb.js');
  assert.equal(
    seriesIdFromArtworkUrl('https://artworks.thetvdb.com/banners/v4/series/461730/backgrounds/67e1b64e03de5.jpg'),
    461730,
  );
  assert.equal(seriesIdFromArtworkUrl('https://artworks.thetvdb.com/banners/fanart/original/315500-3.jpg'), 315500);
  // Arte antiga com hash no nome: não há id para ler, e não se inventa um.
  assert.equal(seriesIdFromArtworkUrl('https://artworks.thetvdb.com/banners/fanart/original/5da0f56142c49.jpg'), null);
  assert.equal(seriesIdFromArtworkUrl(null), null);
});

test('o veredito de géneros do verify-tvdb bate com o da pesquisa', async () => {
  const { isAnimationGenres } = await import('../src/verify-tvdb.js');
  assert.equal(isAnimationGenres(['Comedy', 'Drama', 'Romance']), false);
  assert.equal(isAnimationGenres(['Action', 'Animation']), true);
  assert.equal(isAnimationGenres(null), false);
});
