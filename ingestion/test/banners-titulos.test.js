/**
 * As formas de busca dos banners.
 *
 * Estas funções decidem com que nome se pergunta ao TVDB, e é aí que a coisa se
 * ganha ou se perde: um termo mau não dá erro nenhum, dá zero resultados, e zero
 * resultados lê-se na app como um título sem fundo. Foi assim que 187 séries de
 * 278 ficaram sem arte sem ninguém dar por isso.
 *
 * Testa-se sem rede de propósito. Um teste que precise do TVDB não corre no
 * portátil de ninguém, e a parte que se engana em silêncio é esta, não a HTTP.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formasDeBusca, semSubtitulo, semSufixoDeTemporada } from '../src/banners.js';

test('o sufixo de temporada sai, nas formas em que aparece', () => {
  assert.equal(semSufixoDeTemporada('Grand Blue Dreaming 3rd Season'), 'Grand Blue Dreaming');
  assert.equal(semSufixoDeTemporada('Spy x Family Season 2'), 'Spy x Family');
  assert.equal(semSufixoDeTemporada('Attack on Titan Part 3'), 'Attack on Titan');
  assert.equal(semSufixoDeTemporada('Vinland Saga Cour 2'), 'Vinland Saga');
  assert.equal(semSufixoDeTemporada('Tanya the Evil II'), 'Tanya the Evil');
});

test('um título sem sufixo devolve nulo, e não ele próprio', () => {
  // Devolver o mesmo título faria a busca repetir-se, e cada repetição é um
  // pedido ao TVDB que se sabe de antemão que vai falhar outra vez.
  assert.equal(semSufixoDeTemporada('Frieren'), null);
  assert.equal(semSufixoDeTemporada('Bocchi the Rock!'), null);
});

test('o subtítulo sai depois de dois pontos ou de um travessão isolado', () => {
  assert.equal(
    semSubtitulo('Trapped in a Dating Sim: The World of Otome Games is Tough for Mobs'),
    'Trapped in a Dating Sim',
  );
  assert.equal(
    semSubtitulo('Ascendance of a Bookworm: Adopted Daughter of an Archduke'),
    'Ascendance of a Bookworm',
  );
});

test('o mínimo de oito caracteres salta o primeiro corte quando ele é curto', () => {
  // "BLEACH: Thousand-Year Blood War - The Calamity" tem dois cortes. O
  // primeiro deixaria "BLEACH", seis caracteres, abaixo do mínimo, portanto o
  // corte avança para o segundo.
  //
  // E o resultado é MELHOR do que o que eu esperava quando escrevi isto: no
  // TVDB a série chama-se mesmo "Bleach: Thousand-Year Blood War", e é essa a
  // arte certa. "BLEACH" sozinho traria o fundo da série de 2004.
  //
  // Fica registado porque é fácil alguém achar que o mínimo é um detalhe
  // arbitrário e baixá-lo para quatro. Não é: ele está a proteger dois casos ao
  // mesmo tempo, o termo curto de mais e o corte no sítio errado.
  assert.equal(
    semSubtitulo('BLEACH: Thousand-Year Blood War - The Calamity'),
    'BLEACH: Thousand-Year Blood War',
  );
  assert.equal(
    semSubtitulo('Ascendance of a Bookworm: Adopted Daughter of an Archduke'),
    'Ascendance of a Bookworm',
  );
});

test('"Re:Zero" NÃO se parte, porque os dois pontos não têm espaço a seguir', () => {
  // A armadilha que justifica o espaço obrigatório na expressão. Partido em
  // "Re", a busca devolvia qualquer coisa, com toda a confiança do mundo.
  const inteiro = 'Re:Zero kara Hajimeru Isekai Seikatsu';
  assert.equal(semSubtitulo(inteiro), null);
});

test('um cabeçalho curto de mais não conta como forma de busca', () => {
  // Oito caracteres é o mínimo. "Gan" ou "Ao" encontram séries erradas, e uma
  // capa errada é pior do que nenhuma: ninguém a reporta, porque parece certa.
  assert.equal(semSubtitulo('Gan: Something Long Here'), null);
  assert.equal(semSubtitulo('Ao - The Blue One'), null);
  // Com oito ou mais, já conta.
  assert.equal(semSubtitulo('Oitochars: E o resto'), 'Oitochars');
});

test('um hífen colado não é um travessão, e não corta nada', () => {
  // "Thousand-Year" tem de sobreviver inteiro. O corte exige espaço dos dois
  // lados, senão qualquer palavra composta partia o título ao meio.
  assert.equal(semSubtitulo('Thousand-Year Blood War Arc'), null);
});

test('as formas saem por ordem, sem repetidas', () => {
  const formas = formasDeBusca('Clevatess II: Majuu no Ou to Itsuwari no Yuusha');
  // O título inteiro vem sempre primeiro: é o mais específico, e o único que
  // pode ir com o ano.
  assert.equal(formas[0], 'Clevatess II: Majuu no Ou to Itsuwari no Yuusha');
  // E o corte duplo (sufixo E subtítulo) tem de estar lá, senão esta série
  // nunca resolve: o "II" está antes dos dois pontos.
  assert.ok(formas.includes('Clevatess'), `sem "Clevatess" em ${JSON.stringify(formas)}`);
  assert.equal(new Set(formas).size, formas.length, 'há formas repetidas');
});

test('um título simples gera uma forma só, e não quatro pedidos', () => {
  assert.deepEqual(formasDeBusca('Frieren'), ['Frieren']);
});

test('um título vazio ou ausente não gera busca nenhuma', () => {
  assert.deepEqual(formasDeBusca(''), []);
  assert.deepEqual(formasDeBusca(null), []);
  assert.deepEqual(formasDeBusca(undefined), []);
});
