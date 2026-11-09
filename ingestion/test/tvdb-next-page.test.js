// A paginação da TVDB só segue `links.next` dentro da própria API — cada
// pedido leva o bearer token (auditoria de segurança de 2026-10, F23).
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextPageUrl } from '../src/tvdb-episodes.js';

test('sem página seguinte, acaba', () => {
  assert.equal(nextPageUrl(null), null);
  assert.equal(nextPageUrl(undefined), null);
  assert.equal(nextPageUrl(''), null);
});

test('a página seguinte da própria TVDB segue', () => {
  const next = 'https://api4.thetvdb.com/v4/series/81797/episodes/default?page=2';
  assert.equal(nextPageUrl(next), next);
});

test('outro anfitrião (ou http) pára com erro, antes de mandar o token', () => {
  assert.throws(() => nextPageUrl('https://evil.example/steal'), /fora de/);
  assert.throws(() => nextPageUrl('http://api4.thetvdb.com/v4/x'), /fora de/);
  assert.throws(() => nextPageUrl('https://api4.thetvdb.com.evil.example/v4/x'), /fora de/);
});
