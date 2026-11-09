import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  descriptionsByMalId,
  parseLimit,
  planFills,
  prioritize,
  usableDescription,
} from '../src/descriptions.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/descriptions.js');

test('parseLimit lê um --limit=N positivo, senão null', () => {
  assert.equal(parseLimit(['node', 'descriptions.js', '--limit=250']), 250);
  assert.equal(parseLimit(['--limit=1']), 1);
  assert.equal(parseLimit(['--limit=0']), null); // tem de ser > 0
  assert.equal(parseLimit(['--limit=-5']), null);
  assert.equal(parseLimit(['--limit=abc']), null);
  assert.equal(parseLimit(['--dry-run']), null);
  assert.equal(parseLimit([]), null);
});

test('usableDescription limpa o HTML e recusa o que não é sinopse', () => {
  assert.equal(
    usableDescription('<p>Uma cartógrafa descobre uma ilha <span>apagada</span> dos mapas.</p>'),
    'Uma cartógrafa descobre uma ilha apagada dos mapas.',
  );
  // As entidades passam pelo stripHtml partilhado com o pipeline principal.
  assert.equal(usableDescription('<p>Rapazes &amp; raparigas numa escola de vento.</p>'), 'Rapazes & raparigas numa escola de vento.');
  assert.equal(usableDescription(''), null);
  assert.equal(usableDescription(null), null);
  assert.equal(usableDescription(undefined), null);
  assert.equal(usableDescription('<p>Anúncio.</p>'), null); // curta demais
  assert.equal(usableDescription('<p>   </p>'), null); // só espaço
  // Uma frase curta mas verdadeira PASSA — o mínimo trava fragmentos, não factos.
  assert.equal(
    usableDescription('Compilação dos episódios 1-4 do OVA.'),
    'Compilação dos episódios 1-4 do OVA.',
  );
});

test('descriptionsByMalId só aceita entradas com mal_id E texto utilizável', () => {
  const map = descriptionsByMalId([
    {
      description: '<p>Uma sinopse com tamanho mais do que suficiente.</p>',
      websites: { mal: 'myanimelist.net/anime/101/Um_Titulo' },
    },
    { description: '<p>Outra sinopse igualmente respeitável aqui.</p>', websites: {} }, // sem mal
    { description: '', websites: { mal: 'myanimelist.net/anime/103/Vazio' } }, // sem texto
    { description: '<p>N/A</p>', websites: { mal: 'myanimelist.net/anime/104/Curto' } }, // curto
    { websites: { mal: 'myanimelist.net/anime/105/Nada' } }, // sem campo nenhum
  ]);
  assert.deepEqual([...map.keys()], [101]);
  assert.equal(map.get(101), 'Uma sinopse com tamanho mais do que suficiente.');
});

test('descriptionsByMalId acumula entre páginas e o primeiro a escrever ganha', () => {
  const into = new Map();
  descriptionsByMalId(
    [{ description: '<p>A sinopse da primeira página, a que vale.</p>', websites: { mal: 'myanimelist.net/anime/7/A' } }],
    into,
  );
  descriptionsByMalId(
    [{ description: '<p>A sinopse da segunda página, que não deve mandar.</p>', websites: { mal: 'myanimelist.net/anime/7/A' } }],
    into,
  );
  assert.equal(into.size, 1);
  assert.equal(into.get(7), 'A sinopse da primeira página, a que vale.');
});

test('prioritize: popularidade desc (nulos no fim), depois ano desc, depois id', () => {
  const ordered = prioritize([
    { id: 'd', popularity: null, year: 1998 },
    { id: 'b', popularity: 500, year: 2020 },
    { id: 'c', popularity: null, year: 2024 },
    { id: 'a', popularity: 9000, year: 2011 },
    { id: 'e', popularity: null, year: 1998 },
  ]);
  assert.deepEqual(
    ordered.map((r) => r.id),
    ['a', 'b', 'c', 'd', 'e'], // 9000 → 500 → sem pop: 2024 → 1998 (id d antes de e)
  );
});

test('planFills nunca reescreve uma linha que já tem sinopse', () => {
  const byMalId = new Map([
    [101, 'Sinopse nova para uma linha vazia.'],
    [102, 'Sinopse nova para uma linha que JÁ tem texto.'],
  ]);
  const { fills, jaTinha, semFonte } = planFills(
    [
      { id: 'vazia', mal_id: 101, title: 'Vazia', popularity: 10, year: 2024, description: null },
      { id: 'cheia', mal_id: 102, title: 'Cheia', popularity: 20, year: 2024, description: 'Já cá estava.' },
      { id: 'branca', mal_id: 102, title: 'Branca', popularity: 5, year: 2024, description: '   ' },
      { id: 'orfa', mal_id: 999, title: 'Órfã', popularity: 1, year: 2024, description: null },
    ],
    byMalId,
  );
  assert.deepEqual(
    fills.map((f) => f.id),
    ['vazia', 'branca'], // "branca" só tem espaços → conta como vazia
  );
  assert.equal(fills[0].description, 'Sinopse nova para uma linha vazia.');
  assert.equal(jaTinha, 1);
  assert.equal(semFonte, 1);
});

test('planFills respeita o --limit cortando pela cauda da prioridade', () => {
  const byMalId = new Map([
    [1, 'Sinopse do título mais seguido de todos.'],
    [2, 'Sinopse do título do meio da tabela.'],
    [3, 'Sinopse do título que ninguém segue.'],
  ]);
  const rows = [
    { id: 'c', mal_id: 3, title: 'C', popularity: 1, year: 2000, description: null },
    { id: 'a', mal_id: 1, title: 'A', popularity: 9000, year: 2024, description: null },
    { id: 'b', mal_id: 2, title: 'B', popularity: 400, year: 2020, description: null },
  ];
  const { fills } = planFills(rows, byMalId, 2);
  assert.deepEqual(
    fills.map((f) => f.id),
    ['a', 'b'], // corta o 'c', o menos seguido
  );
});

test('planFills é idempotente: sobre linhas já preenchidas não propõe nada', () => {
  const byMalId = new Map([[101, 'Uma sinopse qualquer, suficientemente longa.']]);
  const rows = [{ id: 'x', mal_id: 101, title: 'X', popularity: 1, year: 2024, description: null }];

  const primeira = planFills(rows, byMalId);
  assert.equal(primeira.fills.length, 1);

  // Aplicar o que a primeira passagem escreveria e voltar a planear — é o que
  // uma segunda corrida vê, e tem de dar zero escritas.
  const depois = rows.map((r) => ({ ...r, description: primeira.fills[0].description }));
  const segunda = planFills(depois, byMalId);
  assert.equal(segunda.fills.length, 0);
  assert.equal(segunda.jaTinha, 1);
});

test('`descriptions.js --dry-run` corre sem env, sem rede e sem Supabase', () => {
  // Limpa todas as credenciais do ambiente do filho para PROVAR que o dry run
  // não precisa de nenhuma e nunca pode tocar num backend real.
  const env = { ...process.env };
  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ANIMESCHEDULE_TOKEN',
    'TVDB_API_KEY',
    'TMDB_API_KEY',
  ]) {
    delete env[key];
  }

  const res = spawnSync(process.execPath, [entry, '--dry-run'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(res.status, 0, `stderr foi: ${res.stderr}`);
  assert.match(res.stdout, /DRY RUN \(fixture, sem escritas\)/);
  // A fixture tem 5 linhas: 1 preenchível, 1 já com sinopse, 3 sem fonte
  // (catálogo vazio, catálogo curto demais, e uma que a AnimeSchedule não tem).
  assert.match(res.stdout, /preencheria 1 · 1 já tinha\(m\) sinopse \(intocada\) · 3 sem fonte/);
  assert.match(res.stdout, /Dry run OK .* nada escrito/);
});
