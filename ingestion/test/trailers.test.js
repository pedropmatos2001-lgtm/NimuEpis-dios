/**
 * A escolha do trailer. O caso real que a fez nascer: o "Frontier Lord" tem no
 * TVDB quatro PVs japoneses e o trailer inglês da Crunchyroll, e é esse que o
 * dono quer ver na ficha.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escolherTrailers, youtubeId } from '../src/trailers.js';

test('youtubeId lê os formatos de URL do YouTube e recusa o resto', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=nuSfm9NlJyo'), 'nuSfm9NlJyo');
  assert.equal(youtubeId('https://youtu.be/nuSfm9NlJyo?t=3'), 'nuSfm9NlJyo');
  assert.equal(youtubeId('https://www.youtube.com/embed/nuSfm9NlJyo'), 'nuSfm9NlJyo');
  assert.equal(youtubeId('https://vimeo.com/123'), null);
  assert.equal(youtubeId(null), null);
});

test('o trailer inglês (Crunchyroll) vem primeiro, e o mais recente de cada grupo antes', () => {
  const trailers = [
    { url: 'https://www.youtube.com/watch?v=8YrRIHwbZqY', language: 'jpn' },
    { url: 'https://www.youtube.com/watch?v=BiDDgaQ-SKo', language: 'jpn' },
    { url: 'https://www.youtube.com/watch?v=nuSfm9NlJyo', language: 'eng' },
  ];
  assert.deepEqual(escolherTrailers(trailers), ['nuSfm9NlJyo', 'BiDDgaQ-SKo', '8YrRIHwbZqY']);
});

test('sem trailers, URLs estranhos e repetidos não partem nada', () => {
  assert.deepEqual(escolherTrailers(undefined), []);
  assert.deepEqual(
    escolherTrailers([
      { url: 'x' },
      { url: 'https://youtu.be/nuSfm9NlJyo' },
      { url: 'https://youtu.be/nuSfm9NlJyo' },
    ]),
    ['nuSfm9NlJyo'],
  );
});
