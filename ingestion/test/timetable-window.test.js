// A janela de semanas do horário (src/timetable-window.js) e a arrumação dos
// episódios futuros com a semana extra (2026-11-08): a +3 só acrescenta.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchTimetableWindow } from '../src/timetable-window.js';
import {
  airedEpisodeIds,
  TIMETABLE_STRICT_WEEKS_AHEAD,
  TIMETABLE_WEEKS_AHEAD,
  isoWeek,
  isoWeekEndUtc,
  isoWeeksWindow,
  staleCleanupRows,
  staleFutureEpisodeIds,
} from '../src/util.js';

// Domingo, 8 de novembro de 2026 (semana 45). As semanas lidas: 44 a 48.
const AGORA = new Date('2026-11-08T12:00:00Z');
const DIA = 86_400_000;

/** Uma entrada de horário no dia `d` (2026-11-d, ou dezembro para d > 30). */
function entrada(route, episodeNumber, iso) {
  return { route, episodeNumber, episodeDate: iso, title: route };
}

/**
 * Um `fetchWeek` de mentira: uma entrada "sub" e uma só "raw" por semana, com a
 * data na quinta dessa semana. `falhas` diz que pedidos atiram
 * (`"48"` para o sub da 48, `"48:raw"` para o raw).
 */
function falso({ falhas = [] } = {}) {
  const pedidos = [];
  const fetchWeek = async ({ year, week, airType = 'sub' }) => {
    pedidos.push(`${year}-W${week}:${airType}`);
    if (falhas.includes(airType === 'raw' ? `${week}:raw` : `${week}`)) {
      throw new Error(`HTTP 500 ${week} ${airType}`);
    }
    // A quinta da semana ISO `week` de 2026 (1 de janeiro de 2026 é quinta).
    const quinta = new Date(Date.UTC(2026, 0, 1) + (week - 1) * 7 * DIA).toISOString();
    return airType === 'raw'
      ? [entrada(`so-raw-${week}`, 1, quinta), entrada(`sub-${week}`, week, quinta)]
      : [entrada(`sub-${week}`, week, quinta)];
  };
  return { fetchWeek, pedidos };
}

const silencio = () => {};

test('as constantes: lê-se até à +3, e a +2 é a última lida "a sério"', () => {
  assert.equal(TIMETABLE_WEEKS_AHEAD, 3);
  assert.equal(TIMETABLE_STRICT_WEEKS_AHEAD, 2);
  assert.equal(isoWeeksWindow(AGORA).length, 5); // anterior + atual + 3
  assert.deepEqual(isoWeeksWindow(AGORA).at(-1), { year: 2026, week: 48 });
});

test('isoWeekEndUtc é o último milissegundo da semana ISO', () => {
  assert.equal(isoWeekEndUtc(AGORA, 2).toISOString(), '2026-11-22T23:59:59.999Z');
  assert.equal(isoWeekEndUtc(AGORA, 3).toISOString(), '2026-11-29T23:59:59.999Z');
  for (let t = Date.parse('2026-12-20T00:00:00Z'); t < Date.parse('2027-01-20T00:00:00Z'); t += 6 * 3600_000) {
    const now = new Date(t);
    for (const k of [2, 3]) {
      const fim = isoWeekEndUtc(now, k);
      assert.deepEqual(isoWeek(fim), isoWeeksWindow(now, 1, k).at(-1), now.toISOString());
      assert.notDeepEqual(isoWeek(new Date(fim.getTime() + 1)), isoWeek(fim));
    }
  }
});

test('lê as cinco semanas, "sub" e "raw", e a +3 entra nas entradas', async () => {
  const { fetchWeek, pedidos } = falso();
  const r = await fetchTimetableWindow({ fetchWeek, now: AGORA, log: silencio, warn: silencio });
  // 10 pedidos: 5 semanas x (sub + raw). Antes eram 8.
  assert.equal(pedidos.length, 10);
  assert.deepEqual(
    pedidos.filter((p) => p.endsWith(':sub')).map((p) => p.split(':')[0]),
    ['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48'],
  );
  assert.equal(r.timetableComplete, true);
  assert.equal(r.staleWindowEnd, '2026-11-22T23:59:59.999Z');
  assert.deepEqual(r.extraWeeks, [{ year: 2026, week: 48, ok: true, entries: 2 }]);
  assert.ok(r.timetableEntries.some((e) => e.route === 'sub-48'));
  assert.ok(r.timetableEntries.some((e) => e.route === 'so-raw-48'));
  assert.equal(r.timetableEntries.length, 10);
});

test('com airType "raw" não há segundo pedido', async () => {
  const { fetchWeek, pedidos } = falso();
  await fetchTimetableWindow({ fetchWeek, now: AGORA, airType: 'raw', log: silencio, warn: silencio });
  assert.equal(pedidos.length, 5);
});

test('o "sub" da semana extra falha: aviso, e fica tudo como com as quatro semanas', async () => {
  const avisos = [];
  const { fetchWeek } = falso({ falhas: ['48'] });
  const r = await fetchTimetableWindow({ fetchWeek, now: AGORA, log: silencio, warn: (l) => avisos.push(l) });
  assert.equal(r.timetableComplete, true);
  assert.equal(r.timetableEntries.length, 8);
  assert.ok(!r.timetableEntries.some((e) => e.route.endsWith('-48')));
  assert.deepEqual(r.extraWeeks, [{ year: 2026, week: 48, ok: false, entries: 0 }]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /2026-W48 \(semana extra, non-fatal/);
});

test('o "raw" da semana extra falha: a semana extra sai inteira, e o horário continua completo', async () => {
  const avisos = [];
  const { fetchWeek } = falso({ falhas: ['48:raw'] });
  const r = await fetchTimetableWindow({ fetchWeek, now: AGORA, log: silencio, warn: (l) => avisos.push(l) });
  assert.equal(r.timetableComplete, true);
  assert.equal(r.timetableEntries.length, 8);
  assert.equal(r.extraWeeks[0].ok, false);
  assert.equal(avisos.length, 1);
});

test('o "sub" de uma semana normal falha: a corrida falha, como antes', async () => {
  const { fetchWeek } = falso({ falhas: ['47'] });
  await assert.rejects(
    fetchTimetableWindow({ fetchWeek, now: AGORA, log: silencio, warn: silencio }),
    /HTTP 500 47 sub/,
  );
});

test('o "raw" de uma semana normal falha: segue, com o horário incompleto, como antes', async () => {
  const { fetchWeek } = falso({ falhas: ['46:raw'] });
  const r = await fetchTimetableWindow({ fetchWeek, now: AGORA, log: silencio, warn: silencio });
  assert.equal(r.timetableComplete, false);
  assert.ok(r.timetableEntries.some((e) => e.route === 'sub-48'));
});

// ── A arrumação dos episódios futuros com a semana extra ─────────────────────

const FIM_MAIS_2 = '2026-11-22T23:59:59.999Z';
const linha = (anime_id, episode_number, airing_at) => ({ anime_id, episode_number, airing_at });

// O que o horário trouxe: o A nas semanas normais, o X só na semana extra (uma
// série que volta, ou estreia, a 26/11), e o A outra vez na extra.
const HORARIO = [
  linha('A', 5, '2026-11-12T15:00:00Z'),
  linha('A', 6, '2026-11-19T15:00:00Z'),
  linha('B', 2, '2026-11-22T23:30:00Z'), // a última da +2, domingo à noite
  linha('A', 7, '2026-11-26T15:00:00Z'), // semana extra
  linha('X', 3, '2026-11-26T18:00:00Z'), // semana extra
];

test('staleCleanupRows deixa só as semanas normais, e sem fim devolve tudo', () => {
  const core = staleCleanupRows(HORARIO, FIM_MAIS_2);
  assert.deepEqual(core.map((r) => `${r.anime_id}#${r.episode_number}`), ['A#5', 'A#6', 'B#2']);
  assert.equal(staleCleanupRows(HORARIO, undefined).length, HORARIO.length);
  // A janela da arrumação (a data mais tardia) fica no fim da +2, como antes.
  const fim = core.map((r) => r.airing_at).sort().at(-1);
  assert.equal(fim, '2026-11-22T23:30:00Z');
});

/** A mesma conta que `clearStaleFutureEpisodes` faz, sobre linhas dadas. */
function arrumar(rows, dbRows, absentAnimeIds = new Set()) {
  const timetableKeys = new Set(rows.map((r) => `${r.anime_id}#${r.episode_number}`));
  const windowEnd = rows.map((r) => r.airing_at).sort().at(-1);
  return staleFutureEpisodeIds({ dbRows, timetableKeys, now: AGORA.toISOString(), windowEnd, absentAnimeIds });
}

test('a semana extra nunca faz apagar: o mesmo resultado que só com as quatro semanas', () => {
  // Na base: o X tem o ep 2 a 20/11 (uma projeção antiga, dentro da +2) e uma
  // data na +3 que o horário não traz; o A tem o ep 8 a 27/11 (na +3, ainda
  // por publicar).
  const db = [
    { id: 'x2', anime_id: 'X', episode_number: 2, airing_at: '2026-11-20T18:00:00Z' },
    { id: 'x9', anime_id: 'X', episode_number: 9, airing_at: '2026-11-27T18:00:00Z' },
    { id: 'a8', anime_id: 'A', episode_number: 8, airing_at: '2026-11-27T15:00:00Z' },
  ];
  const antes = HORARIO.filter((r) => Date.parse(r.airing_at) <= Date.parse(FIM_MAIS_2));
  const comExtra = staleCleanupRows(HORARIO, FIM_MAIS_2);

  // Horário incompleto (sem séries ausentes): nada se apaga, nem antes nem agora.
  assert.deepEqual(arrumar(comExtra, db), arrumar(antes, db));
  assert.deepEqual(arrumar(comExtra, db), []);
  // Sem o filtro, o X (só na semana extra) contava como "no horário" e a
  // projeção dele a 20/11 perdia a data; e a janela ia até 26/11.
  assert.deepEqual(arrumar(HORARIO, db).sort(), ['x2']);

  // Horário completo: o X é uma série ausente das semanas normais, como era
  // antes da semana extra. A janela continua a acabar na +2: x9 e a8 ficam.
  const ausentes = new Set(['X']);
  assert.deepEqual(arrumar(comExtra, db, ausentes), arrumar(antes, db, ausentes));
  assert.deepEqual(arrumar(comExtra, db, ausentes), ['x2']);
});

test('os episódios da semana extra nunca entram na distribuição de avisos', () => {
  // `fanOutNewEpisodes` só passa à base os ids de episódios que JÁ saíram (e a
  // função da base ainda corta a 6 horas). Um episódio da +3 é sempre futuro.
  const upserted = [
    { id: 'novo-extra', airing_at: '2026-11-26T15:00:00Z' },
    { id: 'novo-mais-2', airing_at: '2026-11-20T15:00:00Z' },
    { id: 'saiu', airing_at: '2026-11-08T11:00:00Z' },
  ];
  assert.deepEqual(airedEpisodeIds(upserted, AGORA), ['saiu']);
});
