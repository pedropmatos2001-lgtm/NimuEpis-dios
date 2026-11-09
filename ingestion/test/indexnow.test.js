import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { INDEXNOW_KEY, isDailyRun, manualUrls, planUrls, seasonGuidePaths, submit } from '../src/indexnow.js';

const AGORA = new Date('2026-09-29T12:00:00Z');
const bb = { id: 'a1', slug: 'ao-no-hako-2nd-season', status: 'airing' };

describe('planUrls', () => {
  it('um episódio que saiu leva a página dele e a da série, nas duas línguas', () => {
    const urls = planUrls({ now: AGORA, aired: [{ episode_number: 2, animes: bb }] });
    assert.deepEqual(urls, [
      'https://nimuhome.com/anime/ao-no-hako-2nd-season',
      'https://nimuhome.com/pt/anime/ao-no-hako-2nd-season',
      'https://nimuhome.com/anime/ao-no-hako-2nd-season/episodio/2',
      'https://nimuhome.com/pt/anime/ao-no-hako-2nd-season/episodio/2',
    ]);
  });

  it('sem repetidos, mesmo quando o episódio saiu e foi criado na mesma janela', () => {
    const ep = { episode_number: 3, airing_at: '2026-09-29T10:00:00Z', animes: bb };
    assert.equal(planUrls({ now: AGORA, aired: [ep], created: [ep] }).length, 4);
  });

  it('episódios novos mas antigos não entram (já ninguém os pesquisa)', () => {
    const velho = { episode_number: 1, airing_at: '2026-08-01T10:00:00Z', animes: bb };
    assert.deepEqual(planUrls({ now: AGORA, created: [velho] }), []);
  });

  it('séries novas só se estiverem a dar ou por estrear', () => {
    const urls = planUrls({
      now: AGORA,
      newAnimes: [
        { id: 'x', slug: 'nova', status: 'upcoming' },
        { id: 'y', slug: 'antiga', status: 'finished' },
      ],
    });
    assert.deepEqual(urls, ['https://nimuhome.com/anime/nova', 'https://nimuhome.com/pt/anime/nova']);
  });

  it('sem slug usa o id, e números de episódio inválidos ficam de fora', () => {
    const semSlug = { id: 'c99b6283', slug: null, status: 'airing' };
    const urls = planUrls({
      now: AGORA,
      aired: [{ episode_number: 5, animes: semSlug }, { episode_number: 0, animes: bb }],
    });
    assert.ok(urls.includes('https://nimuhome.com/anime/c99b6283/episodio/5'));
    assert.ok(!urls.some((u) => u.includes('ao-no-hako')));
  });

  it('a corrida do dia junta a capa e as notícias, com /pt na raiz', () => {
    const urls = planUrls({ now: AGORA, daily: true });
    assert.ok(urls.includes('https://nimuhome.com/'));
    assert.ok(urls.includes('https://nimuhome.com/pt'));
    assert.ok(urls.includes('https://nimuhome.com/pt/noticias/estreias-da-semana'));
  });

  it('só uma das quatro corridas por dia é a "do dia"', () => {
    const horas = [0, 6, 12, 18].map((h) => isDailyRun(new Date(Date.UTC(2026, 8, 29, h, 30))));
    assert.deepEqual(horas, [true, false, false, false]);
  });
});

describe('seasonGuidePaths (2026-11-03)', () => {
  it('a temporada atual e a seguinte, com os slugs portugueses', () => {
    assert.deepEqual(seasonGuidePaths(new Date('2026-11-03T12:00:00Z')), [
      '/noticias/temporada/outono-2026',
      '/noticias/temporada/inverno-2027',
    ]);
    assert.deepEqual(seasonGuidePaths(new Date('2026-07-01T00:00:00Z')), [
      '/noticias/temporada/verao-2026',
      '/noticias/temporada/outono-2026',
    ]);
  });

  it('a corrida do dia leva os guias nas duas línguas', () => {
    const urls = planUrls({ now: new Date('2026-11-03T00:30:00Z'), daily: true });
    assert.ok(urls.includes('https://nimuhome.com/noticias/temporada/outono-2026'));
    assert.ok(urls.includes('https://nimuhome.com/pt/noticias/temporada/inverno-2027'));
  });
});

describe('manualUrls', () => {
  it('só URLs deste domínio, os inválidos ficam de fora', () => {
    const argv = [
      'node',
      'indexnow.js',
      '--url=https://nimuhome.com/llms.txt',
      '--url=https://outro.com/x',
      '--url=isto não é um url',
      '--dry-run',
    ];
    assert.deepEqual(manualUrls(argv, 'https://nimuhome.com'), ['https://nimuhome.com/llms.txt']);
  });
});

describe('submit', () => {
  it('manda o host, a chave e onde a encontrar', async () => {
    let corpo;
    const status = await submit(['https://nimuhome.com/'], 'https://nimuhome.com', async (_url, init) => {
      corpo = JSON.parse(init.body);
      return { status: 202, text: async () => '' };
    });
    assert.equal(status, 202);
    assert.equal(corpo.host, 'nimuhome.com');
    assert.equal(corpo.keyLocation, `https://nimuhome.com/${INDEXNOW_KEY}.txt`);
  });

  it('uma recusa é um erro, não um sucesso calado', async () => {
    await assert.rejects(
      submit(['https://nimuhome.com/'], 'https://nimuhome.com', async () => ({ status: 403, text: async () => 'key' })),
      /403/,
    );
  });
});

describe('o ficheiro da chave no site', () => {
  it('existe em web/public e tem a mesma chave', () => {
    const ficheiro = new URL(`../../web/public/${INDEXNOW_KEY}.txt`, import.meta.url);
    assert.ok(existsSync(ficheiro), 'falta web/public/<chave>.txt');
    assert.equal(readFileSync(ficheiro, 'utf8').trim(), INDEXNOW_KEY);
  });
});
