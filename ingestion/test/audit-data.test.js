import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverHost,
  decodeDashEntities,
  findDashIssues,
  isCoverMissing,
  isSeasonPast,
  isSynopsisEmpty,
  isSynopsisTooShort,
  parseArgs,
  pct,
  planCoverChecks,
  readOnlyClient,
  visibleText,
} from '../src/audit-data.js';

// ── A deteção de travessões, que é onde mora o risco de falsos positivos ─────

const kinds = (text) => findDashIssues(text).map((i) => i.kind);

test('palavras compostas passam limpas (o falso positivo que interessa evitar)', () => {
  for (const limpo of [
    'Bem-vindo ao calendário.',
    'Leva o guarda-chuva, que hoje chove.',
    'Manda um e-mail ao anfitrião.',
    'A pré-estreia é segunda-feira.',
    'Ficou tudo mais ou menos meio-termo.',
    'Anti-herói, sub-região, super-homem.',
    'Fate/stay night: Unlimited Blade Works',
    'Sem sinal nenhum aqui.',
  ]) {
    assert.deepEqual(findDashIssues(limpo), [], `marcou por engano: ${limpo}`);
  }
});

test('travessão a separar ideias é marcado, com ou sem espaços', () => {
  assert.deepEqual(kinds('Temporadas — o que vem aí'), ['travessao']);
  assert.deepEqual(kinds('Temporadas—o que vem aí'), ['travessao']);
  assert.deepEqual(kinds('Um plano – e um problema'), ['travessao']);
  assert.deepEqual(kinds('Uma ideia ― outra ideia'), ['travessao']);
});

test('hífen a fazer de travessão é marcado; a mesma frase sem espaços não é', () => {
  assert.deepEqual(kinds('Temporadas - o que vem aí'), ['hifen-travessao']);
  assert.deepEqual(kinds('Temporadas-o-que-vem-ai'), []);
});

test('hífen com espaço de um lado só é composto partido', () => {
  assert.deepEqual(kinds('Diz bem- vindo à casa.'), ['hifen-solto']);
  assert.deepEqual(kinds('Diz bem -vindo à casa.'), ['hifen-solto']);
  assert.deepEqual(kinds('O título acaba assim-'), ['hifen-solto']);
});

test('hífen duplo a fazer de travessão é marcado, régua de três ou mais não é', () => {
  assert.deepEqual(kinds('Isto--aquilo'), ['hifen-duplo']);
  assert.deepEqual(kinds('Uma ideia -- outra'), ['hifen-duplo']);
  assert.deepEqual(kinds('Fim da secção\n---\nOutra secção'), []);
  assert.deepEqual(kinds('Fim da secção\n———\nOutra secção'), []);
});

test('intervalos numéricos não são frases partidas ao meio', () => {
  assert.deepEqual(findDashIssues('Compilação dos episódios 1-4 do OVA.'), []);
  assert.deepEqual(findDashIssues('A guerra de 1939 – 1945 é o pano de fundo.'), []);
  assert.deepEqual(findDashIssues('Emitido às 20:00-21:00.'), []);
});

test('sinal negativo não é pontuação', () => {
  assert.deepEqual(findDashIssues('A temperatura desceu a -5 graus.'), []);
});

test('marcador de lista e travessão de diálogo no início da linha passam', () => {
  assert.deepEqual(findDashIssues('Elenco:\n- Rin\n- Kaoru'), []);
  assert.deepEqual(findDashIssues('— Olá.\n— Adeus.'), []);
  assert.deepEqual(findDashIssues('  - com indentação'), []);
  // Mas o mesmo sinal no meio da linha continua a ser marcado.
  assert.deepEqual(kinds('Elenco:\nRin — a protagonista'), ['travessao']);
});

test('hífen suspenso do português está correto e não é marcado', () => {
  assert.deepEqual(findDashIssues('Fala do pós- e do pré-guerra.'), []);
  assert.deepEqual(findDashIssues('Entre micro- ou macroeconomia.'), []);
  // Sem o "e"/"ou" a seguir volta a ser um composto partido.
  assert.deepEqual(kinds('Fala do pós- guerra.'), ['hifen-solto']);
});

test('o hífen suspenso vale nas outras línguas do catálogo, não só em português', () => {
  // Linhas reais da base, que antes saíam no relatório como composto partido.
  assert.deepEqual(findDashIssues('His brother- and sister-in-law were there.'), []);
  assert.deepEqual(findDashIssues('Varem oli tegu enesekindla nalja- ja vembumehega.'), []);
  assert.deepEqual(findDashIssues('Choose the pre- or post-war edition.'), []);
  // A conjunção é que abre a exceção: sem ela continua a ser composto partido.
  assert.deepEqual(kinds('Fala do pós- guerra.'), ['hifen-solto']);
  assert.deepEqual(kinds('The post- war edition.'), ['hifen-solto']);
});

test('conta cada ocorrência e devolve um excerto utilizável', () => {
  const issues = findDashIssues('Primeiro — segundo — terceiro');
  assert.equal(issues.length, 2);
  assert.ok(issues[0].excerpt.includes('Primeiro'));
  assert.ok(issues[0].index < issues[1].index);
});

test('lê o texto como o visitante o vê: HTML fora, entidades traduzidas', () => {
  assert.deepEqual(kinds('Temporadas &mdash; o que vem aí'), ['travessao']);
  assert.deepEqual(kinds('Temporadas &#8212; o que vem aí'), ['travessao']);
  assert.deepEqual(kinds('Temporadas &#x2014; o que vem aí'), ['travessao']);
  // A marcação não conta como texto, e <br> vira quebra de linha (início de
  // linha), por isso o travessão de diálogo a seguir continua limpo.
  assert.deepEqual(findDashIssues('<p>Olá.</p><br>— Adeus.'), []);
  assert.equal(decodeDashEntities('a &ndash; b'), 'a – b');
  assert.equal(decodeDashEntities(null), '');
  assert.equal(visibleText('<b>Olá</b>'), 'Olá');
  assert.equal(visibleText(null), '');
});

test('entrada inútil não rebenta nem inventa ocorrências', () => {
  for (const vazio of [null, undefined, '', '   ', 42, {}]) {
    assert.deepEqual(findDashIssues(vazio), []);
  }
});

// ── Sinopses ─────────────────────────────────────────────────────────────────

test('isSynopsisEmpty apanha nulo, vazio, espaço branco e só marcação', () => {
  assert.equal(isSynopsisEmpty(null), true);
  assert.equal(isSynopsisEmpty(undefined), true);
  assert.equal(isSynopsisEmpty(''), true);
  assert.equal(isSynopsisEmpty('   \n  '), true);
  assert.equal(isSynopsisEmpty('<p></p>'), true);
  assert.equal(isSynopsisEmpty('Uma sinopse a sério, com texto que chega.'), false);
});

test('isSynopsisTooShort separa a etiqueta da sinopse curta mas verdadeira', () => {
  assert.equal(isSynopsisTooShort('N/A'), true);
  assert.equal(isSynopsisTooShort('Anúncio.'), true);
  assert.equal(isSynopsisTooShort('Compilação dos episódios 1-4 do OVA.'), false);
  // Vazio não é curto: são coisas diferentes e contam-se em sítios diferentes.
  assert.equal(isSynopsisTooShort(null), false);
  assert.equal(isSynopsisTooShort(''), false);
});

// ── Capas ────────────────────────────────────────────────────────────────────

test('isCoverMissing trata nulo, vazio e espaço branco como ausência', () => {
  assert.equal(isCoverMissing(null), true);
  assert.equal(isCoverMissing(undefined), true);
  assert.equal(isCoverMissing(''), true);
  assert.equal(isCoverMissing('   '), true);
  assert.equal(isCoverMissing('https://exemplo.test/a.jpg'), false);
});

test('coverHost extrai a origem e não rebenta com lixo', () => {
  assert.equal(coverHost('https://exemplo.test/a/b.jpg'), 'exemplo.test');
  assert.equal(coverHost('nao-e-url'), 'url-invalida');
  assert.equal(coverHost(null), 'url-invalida');
});

// ── Temporadas ───────────────────────────────────────────────────────────────

test('isSeasonPast conhece as quatro temporadas e as suas fronteiras', () => {
  const agora = new Date('2026-08-20T00:00:00Z');
  assert.equal(isSeasonPast(2026, 'Winter', agora), true);
  assert.equal(isSeasonPast(2026, 'Spring', agora), true);
  assert.equal(isSeasonPast(2026, 'Summer', agora), false); // ainda a decorrer
  assert.equal(isSeasonPast(2026, 'Fall', agora), false);
  assert.equal(isSeasonPast(2025, 'Fall', agora), true);
  assert.equal(isSeasonPast(2027, 'Winter', agora), false);
  // Fronteira exata: o verão acaba a 30 de setembro.
  assert.equal(isSeasonPast(2026, 'Summer', new Date('2026-09-30T23:59:59Z')), false);
  assert.equal(isSeasonPast(2026, 'Summer', new Date('2026-10-01T00:00:00Z')), true);
});

test('isSeasonPast aceita a grafia da fonte e é conservador sem dados', () => {
  const agora = new Date('2026-08-20T00:00:00Z');
  assert.equal(isSeasonPast(2026, ' spring ', agora), true);
  assert.equal(isSeasonPast(2025, 'AUTUMN', agora), true);
  // Sem temporada decide o ano inteiro, nunca menos que isso.
  assert.equal(isSeasonPast(2026, null, agora), false);
  assert.equal(isSeasonPast(2025, null, agora), true);
  // Sem ano não se decide nada.
  assert.equal(isSeasonPast(null, 'Winter', agora), false);
  assert.equal(isSeasonPast(undefined, undefined, agora), false);
  // Temporada que a fonte não conhece cai no ano, sem rebentar.
  assert.equal(isSeasonPast(2026, 'Terceira', agora), false);
});

// ── Amostragem ───────────────────────────────────────────────────────────────

const linhas = (host, n) => Array.from({ length: n }, (_, i) => ({ host, id: `${host}-${i}` }));

const contaPorHost = (rows) => {
  const out = {};
  for (const r of rows) out[r.host] = (out[r.host] ?? 0) + 1;
  return out;
};

test('a origem pequena verifica-se por inteiro, a grande por amostra', () => {
  // A forma real da base: uma origem enorme e uma pequena onde vivem as mortas.
  const rows = [...linhas('grande.test', 28373), ...linhas('pequena.test', 90)];
  const { checks, completos } = planCoverChecks(rows, (r) => r.host, { sampleSize: 150 });
  const porHost = contaPorHost(checks);
  assert.equal(porHost['pequena.test'], 90, 'a origem pequena tem de ir toda');
  assert.equal(porHost['grande.test'], 150, 'a grande fica-se pela amostra pedida');
  assert.ok(completos.has('pequena.test'));
  assert.ok(!completos.has('grande.test'));
});

test('uma origem grande amostrada até ao fim conta como completa', () => {
  const rows = linhas('grande.test', 200);
  const { completos } = planCoverChecks(rows, (r) => r.host, { sampleSize: 500, fullScanUnder: 150 });
  assert.ok(completos.has('grande.test'));
});

test('o orçamento reparte-se pelas origens grandes sem estourar', () => {
  const rows = [...linhas('a.test', 9000), ...linhas('b.test', 1000), ...linhas('c.test', 200)];
  const { checks } = planCoverChecks(rows, (r) => r.host, { sampleSize: 100, fullScanUnder: 150 });
  assert.equal(checks.length, 100);
  const porHost = contaPorHost(checks);
  // Nenhuma origem grande fica invisível, mesmo a mais pequena das três.
  for (const host of ['a.test', 'b.test', 'c.test']) assert.ok(porHost[host] >= 1, host);
  assert.ok(porHost['a.test'] > porHost['b.test']);
});

test('a escolha é determinística: duas corridas verificam as mesmas linhas', () => {
  const rows = [...linhas('a.test', 3000), ...linhas('b.test', 40)];
  const um = planCoverChecks(rows, (r) => r.host, { sampleSize: 30 }).checks.map((r) => r.id);
  const dois = planCoverChecks(rows, (r) => r.host, { sampleSize: 30 }).checks.map((r) => r.id);
  assert.deepEqual(um, dois);
  assert.equal(new Set(um).size, um.length, 'sem repetidos');
});

test('degenera bem: sem amostra, sem linhas, ou entrada absurda', () => {
  const pequenas = linhas('a.test', 4);
  // Origem pequena não depende do orçamento: vai toda de qualquer maneira.
  assert.equal(planCoverChecks(pequenas, (r) => r.host, { sampleSize: 0 }).checks.length, 4);
  // Origem grande com orçamento zero não gera pedido nenhum.
  assert.equal(
    planCoverChecks(linhas('a.test', 5000), (r) => r.host, { sampleSize: 0 }).checks.length,
    0,
  );
  assert.deepEqual(planCoverChecks([], (r) => r.host, { sampleSize: 10 }).checks, []);
  assert.deepEqual(planCoverChecks(null, (r) => r.host, { sampleSize: 10 }).checks, []);
});

// ── Opções e formatação ──────────────────────────────────────────────────────

test('parseArgs lê as opções e ignora valores absurdos', () => {
  assert.deepEqual(parseArgs([]), { json: false, http: true, sampleSize: 150, examples: 5 });
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--no-http']).http, false);
  assert.equal(parseArgs(['--sample=400']).sampleSize, 400);
  assert.equal(parseArgs(['--sample=0']).sampleSize, 150); // tem de ser > 0
  assert.equal(parseArgs(['--sample=-3']).sampleSize, 150);
  assert.equal(parseArgs(['--sample=abc']).sampleSize, 150);
  assert.equal(parseArgs(['--examples=12']).examples, 12);
});

test('pct escreve a percentagem à portuguesa e sobrevive a um total zero', () => {
  assert.equal(pct(1, 4), '25,0%');
  assert.equal(pct(28707, 28784), '99,7%');
  assert.equal(pct(0, 10), '0,0%');
  assert.equal(pct(5, 0), 'n/d');
});

// ── A trava de leitura ───────────────────────────────────────────────────────

test('readOnlyClient deixa ler e rebenta em qualquer escrita', () => {
  let selecionou = false;
  const fake = {
    from: () => ({
      select: () => {
        selecionou = true;
        return 'resultado';
      },
      insert: () => 'escreveu',
      update: () => 'escreveu',
      upsert: () => 'escreveu',
      delete: () => 'escreveu',
    }),
    rpc: () => 'chamou',
  };
  const db = readOnlyClient(fake);
  assert.equal(db.from('animes').select('id'), 'resultado');
  assert.equal(selecionou, true);
  for (const metodo of ['insert', 'update', 'upsert', 'delete']) {
    assert.throws(() => db.from('animes')[metodo]({}), /só de leitura/, `${metodo} tinha de rebentar`);
  }
  assert.throws(() => db.rpc('o_que_for'), /só de leitura/);
});

test('readOnlyClient mantém o `this` do construtor real (encadeamento intacto)', () => {
  const builder = {
    tabela: 'animes',
    filtros: [],
    eq(col, val) {
      this.filtros.push(`${col}=${val}`);
      return this;
    },
    select() {
      return `${this.tabela}?${this.filtros.join('&')}`;
    },
  };
  const db = readOnlyClient({ from: () => builder });
  assert.equal(db.from('animes').eq('status', 'airing').select(), 'animes?status=airing');
});
