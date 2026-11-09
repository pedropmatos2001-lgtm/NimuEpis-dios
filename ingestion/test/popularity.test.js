import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planPopularityUpdates, readSourceEntry } from '../src/popularity.js';

describe('readSourceEntry', () => {
  it('tira a rota, o mal_id e os seguidores', () => {
    const s = readSourceEntry({
      route: 'sousou-no-frieren-2nd-season',
      websites: { mal: 'https://myanimelist.net/anime/59978' },
      stats: { trackedCount: 2931.4 },
    });
    assert.deepEqual(s, { route: 'sousou-no-frieren-2nd-season', mal: '59978', popularity: 2931 });
  });

  it('sem seguidores, ou sem nada por onde casar, fica de fora', () => {
    assert.equal(readSourceEntry({ route: 'x', stats: {} }), null);
    assert.equal(readSourceEntry({ stats: { trackedCount: 10 } }), null);
  });
});

describe('planPopularityUpdates', () => {
  const sources = [
    { route: 'frieren-2', mal: '59978', popularity: 2931 },
    { route: 'one-piece', mal: '21', popularity: 3640 },
  ];

  it('preenche quem não tinha e muda quem mudou', () => {
    const rows = [
      { id: 'a', animeschedule_route: null, mal_id: '59978', popularity: null },
      { id: 'b', animeschedule_route: 'one-piece', mal_id: '21', popularity: 3637 },
    ];
    assert.deepEqual(planPopularityUpdates(sources, rows), [
      { id: 'a', popularity: 2931 },
      { id: 'b', popularity: 3640 },
    ]);
  });

  it('não reescreve o que já está igual', () => {
    const rows = [{ id: 'b', animeschedule_route: 'one-piece', mal_id: '21', popularity: 3640 }];
    assert.deepEqual(planPopularityUpdates(sources, rows), []);
  });

  it('a rota manda sobre o mal_id quando os dois existem', () => {
    const rows = [{ id: 'c', animeschedule_route: 'one-piece', mal_id: '59978', popularity: null }];
    assert.deepEqual(planPopularityUpdates(sources, rows), [{ id: 'c', popularity: 3640 }]);
  });

  it('o mal_id numérico casa com o de texto', () => {
    const rows = [{ id: 'd', animeschedule_route: null, mal_id: 21, popularity: 1 }];
    assert.deepEqual(planPopularityUpdates(sources, rows), [{ id: 'd', popularity: 3640 }]);
  });
});
