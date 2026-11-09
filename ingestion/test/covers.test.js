import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLimit,
  isBrokenCover,
  prioritize,
  kitsuPosterFromResponse,
  classifyImage,
} from '../src/covers.js';
import { MANAMI_NO_PIC, manamiPicture } from '../src/catalogue-mappers.js';

test('manamiPicture keeps real covers but drops the manami no_pic placeholder', () => {
  assert.equal(manamiPicture('https://cdn.myanimelist.net/images/anime/1/1.jpg'),
    'https://cdn.myanimelist.net/images/anime/1/1.jpg');
  assert.equal(manamiPicture(MANAMI_NO_PIC), null); // the placeholder → null
  assert.equal(manamiPicture(''), null);
  assert.equal(manamiPicture('  '), null);
  assert.equal(manamiPicture(undefined), null);
});

test('isBrokenCover: null and the manami placeholder are broken; real URLs are not', () => {
  assert.equal(isBrokenCover(null), true);
  assert.equal(isBrokenCover(undefined), true);
  assert.equal(isBrokenCover(MANAMI_NO_PIC), true);
  assert.equal(isBrokenCover('https://media.kitsu.app/anime/poster_images/1/original.jpg'), false);
  assert.equal(isBrokenCover('https://cdn.myanimelist.net/images/anime/1/1.jpg'), false);
});

test('parseLimit reads a positive --limit=N, else null', () => {
  assert.equal(parseLimit(['node', 'covers.js', '--limit=50']), 50);
  assert.equal(parseLimit(['--limit=1']), 1);
  assert.equal(parseLimit(['--limit=0']), null); // must be > 0
  assert.equal(parseLimit(['--limit=-3']), null);
  assert.equal(parseLimit(['--limit=abc']), null);
  assert.equal(parseLimit(['--dry-run']), null);
  assert.equal(parseLimit([]), null);
});

test('prioritize: popularity desc (nulls last), stable id tiebreak', () => {
  const rows = [
    { id: 'c', popularity: null },
    { id: 'a', popularity: 10 },
    { id: 'b', popularity: 10 },
    { id: 'd', popularity: 999 },
    { id: 'e', popularity: null },
  ];
  assert.deepEqual(
    prioritize(rows).map((r) => r.id),
    ['d', 'a', 'b', 'c', 'e'],
  );
  // Pure: does not mutate the input array.
  assert.equal(rows[0].id, 'c');
});

test('kitsuPosterFromResponse prefers original, falls through, tolerates absence', () => {
  const mk = (posterImage) => ({ data: { attributes: { posterImage } } });
  assert.equal(
    kitsuPosterFromResponse(mk({ original: 'https://media.kitsu.app/x/original.jpg', large: 'L' })),
    'https://media.kitsu.app/x/original.jpg',
  );
  assert.equal(kitsuPosterFromResponse(mk({ large: 'https://media.kitsu.app/x/large.jpg' })),
    'https://media.kitsu.app/x/large.jpg');
  assert.equal(kitsuPosterFromResponse(mk({ small: 'https://media.kitsu.app/x/small.jpg' })),
    'https://media.kitsu.app/x/small.jpg');
  assert.equal(kitsuPosterFromResponse(mk(null)), null);
  assert.equal(kitsuPosterFromResponse(mk({})), null);
  assert.equal(kitsuPosterFromResponse({}), null);
  assert.equal(kitsuPosterFromResponse(mk({ original: '   ' })), null);
});

test('classifyImage: ok on 200/206, dead on 4xx/5xx, unknown on 429/errors', async () => {
  // Um endereço num anfitrião de imagens permitido (ver src/image-hosts.js).
  const u = 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg';
  const fake = (status) => async () => ({ status });
  assert.equal(await classifyImage(u, fake(200)), 'ok');
  assert.equal(await classifyImage(u, fake(206)), 'ok');
  assert.equal(await classifyImage(u, fake(404)), 'dead');
  assert.equal(await classifyImage(u, fake(403)), 'dead');
  assert.equal(await classifyImage(u, fake(500)), 'dead');
  assert.equal(await classifyImage(u, fake(429)), 'unknown'); // transient — never "dead"
  assert.equal(await classifyImage('', fake(200)), 'unknown'); // no url
  // A HEAD-hostile CDN (405) → ranged GET fallback decides.
  let calls = 0;
  const headThenGet = async (_url, opts) => {
    calls += 1;
    return { status: opts.method === 'HEAD' ? 405 : 200 };
  };
  assert.equal(await classifyImage(u, headThenGet), 'ok');
  assert.equal(calls, 2);
  // A thrown network error is transient, not dead.
  assert.equal(await classifyImage(u, async () => { throw new Error('boom'); }), 'unknown');
});

test('classifyImage: fora da lista de anfitriões é morta, e nem se pede (F24)', async () => {
  let pedidos = 0;
  const conta = async () => { pedidos += 1; return { status: 200 }; };
  assert.equal(await classifyImage('https://evil.example/x.jpg', conta), 'dead');
  assert.equal(await classifyImage('http://cdn.myanimelist.net/images/x.jpg', conta), 'dead');
  assert.equal(await classifyImage('https://169.254.169.254/latest/meta-data', conta), 'dead');
  assert.equal(pedidos, 0);
  // Um redirecionamento que acaba fora da lista também não serve.
  const redireciona = async () => ({ status: 200, url: 'https://evil.example/x.jpg' });
  assert.equal(await classifyImage('https://cdn.myanimelist.net/images/x.jpg', redireciona), 'dead');
});
