import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildManamiIndex, crossFillIds } from '../src/manami.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(resolve(here, 'fixtures/manami-mini.json'), 'utf8'),
);

test('buildManamiIndex extracts ids from source URLs', () => {
  const index = buildManamiIndex(fixture.data);
  assert.equal(index.size, 2);
  const frieren = index.byMal.get(52991);
  assert.ok(frieren);
  assert.deepEqual(frieren.ids, {
    anidb: 17617,
    anilist: 154587,
    kitsu: '46474',
    mal: 52991,
  });
  assert.equal(index.byAnilist.get(154587), frieren);
});

test('crossFillIds fills gaps without overwriting existing ids', () => {
  const index = buildManamiIndex(fixture.data);
  // Matched via mal → gains anilist/kitsu/anidb + fallback picture.
  const { ids, picture } = crossFillIds({ mal: 60543, animeschedule_route: 'kingdom-6th-season' }, index);
  assert.deepEqual(ids, {
    mal: 60543,
    anilist: 187654,
    animeschedule_route: 'kingdom-6th-season',
  });
  assert.equal(picture, 'https://cdn.myanimelist.net/images/anime/1234/999999.jpg');
  // Matched via anilist, and an existing key is never overwritten.
  const viaAnilist = crossFillIds({ anilist: 154587, kitsu: 'keep-me' }, index);
  assert.equal(viaAnilist.ids.mal, 52991);
  assert.equal(viaAnilist.ids.kitsu, 'keep-me');
  // No match → unchanged, no picture.
  const none = crossFillIds({ animeschedule_route: 'unknown' }, index);
  assert.deepEqual(none, { ids: { animeschedule_route: 'unknown' }, picture: null });
});
