/**
 * As horas de silencio, a matematica.
 *
 * A interface promete que as notificacoes pausam de noite. Este e o codigo que
 * cumpre essa promessa, e e do tipo que erra sem dar erro: uma fronteira trocada
 * (o `<` que devia ser `<=`) nao rebenta, so deixa um aviso passar as 22:00 em
 * ponto quando devia ter esperado, ou cala um que devia ter saido. Por isso as
 * fronteiras e o intervalo que passa a meia-noite estao aqui fixados um a um.
 *
 * Todas as horas sao no fuso do UTILIZADOR, nunca no do servidor: os testes usam
 * um instante UTC conhecido e um fuso, e verificam a hora local que sai.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dentroDoSilencio,
  fimDoSilencio,
  horaLocal,
  minutoLocal,
} from '../src/quiet-hours.js';

/** 2026-01-15 e inverno: Lisboa esta em UTC+0, Toquio em UTC+9. */
const INVERNO_2230_UTC = new Date('2026-01-15T22:30:00Z');
/** 2026-07-15 e verao: Lisboa esta em UTC+1. */
const VERAO_2230_UTC = new Date('2026-07-15T22:30:00Z');

test('a hora local sai no fuso da pessoa, nao no do servidor', () => {
  assert.equal(horaLocal(INVERNO_2230_UTC, 'Europe/Lisbon'), 22);
  // Toquio, mesmo instante, esta nove horas a frente: 07:30 do dia seguinte.
  assert.equal(horaLocal(INVERNO_2230_UTC, 'Asia/Tokyo'), 7);
});

test('o horario de verao de Lisboa e respeitado, sem aritmetica a mao', () => {
  // No verao Lisboa e UTC+1, portanto as 22:30 UTC sao 23:30 locais.
  assert.equal(horaLocal(VERAO_2230_UTC, 'Europe/Lisbon'), 23);
});

test('sem silencio definido, nunca esta em silencio', () => {
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, null, null, null), false);
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, 22, 8, null), false, 'sem fuso');
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, null, 8, 'Europe/Lisbon'), false);
});

test('um intervalo vazio (start igual a end) nao silencia nada', () => {
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, 8, 8, 'Europe/Lisbon'), false);
});

test('intervalo que passa a meia-noite: 22 as 8 apanha as 22:30', () => {
  // O caso normal de "nao incomodar de noite". 22:30 locais em Lisboa no
  // inverno estao dentro.
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, 22, 8, 'Europe/Lisbon'), true);
});

test('intervalo que passa a meia-noite: as 07:30 de Toquio ainda esta dentro de 22-8', () => {
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, 22, 8, 'Asia/Tokyo'), true);
});

test('intervalo normal 1 as 6: as 22:30 esta FORA', () => {
  assert.equal(dentroDoSilencio(INVERNO_2230_UTC, 1, 6, 'Europe/Lisbon'), false);
});

test('as fronteiras: start e inclusivo, end e exclusivo', () => {
  const meiaNoite = new Date('2026-01-15T00:00:00Z'); // 00:00 em Lisboa (inverno)
  const seis = new Date('2026-01-15T06:00:00Z'); // 06:00 em Lisboa
  // Silencio 0 as 6.
  assert.equal(dentroDoSilencio(meiaNoite, 0, 6, 'Europe/Lisbon'), true, '00:00 entra');
  assert.equal(dentroDoSilencio(seis, 0, 6, 'Europe/Lisbon'), false, '06:00 ja saiu');
});

test('o fim do silencio cai perto de end:00 no fuso da pessoa', () => {
  // As 22:30 de Lisboa (inverno), com silencio a acabar as 8, o fim e as 08:00
  // do dia seguinte, ou seja 08:00 UTC de 16 de janeiro.
  const fim = fimDoSilencio(INVERNO_2230_UTC, 8, 'Europe/Lisbon');
  assert.equal(horaLocal(fim, 'Europe/Lisbon'), 8, 'a hora local do alvo e 8');
  // E e no futuro, nunca no passado.
  assert.ok(fim.getTime() > INVERNO_2230_UTC.getTime(), 'o fim e depois de agora');
  // Faltam nove horas e meia (22:30 ate 08:00), mais ou menos os minutos zerados.
  const horas = (fim.getTime() - INVERNO_2230_UTC.getTime()) / 3600000;
  assert.ok(horas > 9 && horas < 10, `esperava ~9.5h, deu ${horas.toFixed(2)}h`);
});

test('o fim do silencio nunca e "daqui a zero horas"', () => {
  // As 08:00 em ponto, com end=8: nao devemos devolver o mesmo instante (que
  // deixaria a entrega a disparar contra si mesma), mas sim 24h depois.
  const oitoEmPonto = new Date('2026-01-15T08:00:00Z');
  const fim = fimDoSilencio(oitoEmPonto, 8, 'Europe/Lisbon');
  assert.ok(fim.getTime() > oitoEmPonto.getTime(), 'o alvo tem de estar no futuro');
});

test('num fuso de meia hora, o fim do silencio cai em end:00 local, nao 30 min ao lado', () => {
  // A India esta em +5:30. Uma versao anterior zerava os minutos EM UTC, o que
  // caia 30 min ao lado do end:00 local. A conta em minutos resolve-o.
  const agora = new Date('2026-01-15T20:00:00Z'); // 01:30 do dia 16 na India
  const fim = fimDoSilencio(agora, 7, 'Asia/Kolkata');
  assert.equal(horaLocal(fim, 'Asia/Kolkata'), 7, 'a hora local do alvo e 7');
  assert.equal(minutoLocal(fim, 'Asia/Kolkata'), 0, 'e os minutos sao 0, nao 30');
});
