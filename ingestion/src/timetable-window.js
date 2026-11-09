// A janela de semanas do horário da AnimeSchedule, lida como a ingestão a lê.
//
// Partilhado pelo run.js (a corrida a sério) e pelo simulate.js (o diagnóstico
// só de leitura), para os dois lerem as mesmas semanas da mesma maneira. O
// pedido entra por parâmetro (`fetchWeek`), por isso os testes correm sem rede.
//
// ## As semanas (2026-11-08)
//
// Da anterior até à +2 (`TIMETABLE_STRICT_WEEKS_AHEAD`), como sempre:
//  - o "sub" de cada uma TEM de vir; se falha, a corrida falha (era assim e
//    continua: sem o horário destas semanas o calendário ficava a meio);
//  - o "raw" é a ajuda de sempre para as estreias (ver `mergeTimetables`); se
//    falha, segue-se, mas o horário fica "incompleto" e a arrumação não trata
//    as séries ausentes (`timetableComplete`).
//
// E a +3 (até `TIMETABLE_WEEKS_AHEAD`), a semana EXTRA, para o calendário
// saber mais à frente:
//  - qualquer falha (do "sub" ou do "raw") é um aviso, e a corrida segue com as
//    outras semanas exatamente como antes; não se usa meia semana extra;
//  - não mexe no `timetableComplete`;
//  - só acrescenta: a AnimeSchedule costuma tê-la a meio, e a falta de um
//    episódio lá não quer dizer nada. Por isso a arrumação dos episódios
//    futuros nunca olha para ela: `staleWindowEnd` é o fim da semana +2, e o
//    run.js só lhe passa as linhas até aí (`staleCleanupRows` em util.js).
import {
  TIMETABLE_STRICT_WEEKS_AHEAD,
  TIMETABLE_WEEKS_AHEAD,
  isoWeekEndUtc,
  isoWeeksWindow,
  mergeTimetables,
} from './util.js';

const PREFIX = '[nimu]';

/**
 * @param {object} options
 * @param {(args: { year: number, week: number, airType?: string }) => Promise<any[]>} options.fetchWeek
 *   O pedido de uma semana (`fetchTimetableWeek` de animeschedule.js).
 * @param {Date} [options.now]
 * @param {string} [options.airType] O tipo principal (`config.airType`). Com
 *   "raw" não há segundo pedido.
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<{
 *   timetableEntries: any[],
 *   timetableComplete: boolean,
 *   staleWindowEnd: string,
 *   extraWeeks: { year: number, week: number, ok: boolean, entries: number }[],
 * }>}
 */
export async function fetchTimetableWindow({
  fetchWeek,
  now = new Date(),
  airType = 'sub',
  log = console.log,
  warn = console.warn,
}) {
  const strict = isoWeeksWindow(now, 1, TIMETABLE_STRICT_WEEKS_AHEAD);
  const strictKeys = new Set(strict.map(weekKey));
  const extra = isoWeeksWindow(now, 1, TIMETABLE_WEEKS_AHEAD).filter((w) => !strictKeys.has(weekKey(w)));

  const timetableEntries = [];
  let timetableComplete = true;

  for (const { year, week } of strict) {
    const entries = await fetchWeek({ year, week });
    let raw = [];
    if (airType !== 'raw') {
      try {
        raw = await fetchWeek({ year, week, airType: 'raw' });
      } catch (err) {
        timetableComplete = false;
        warn(`${PREFIX} ⚠ timetable raw ${year}-W${week} (non-fatal): ${err.message}`);
      }
    }
    const merged = mergeTimetables(entries, raw);
    log(
      `${PREFIX} timetable ${year}-W${week}: ${entries.length} ${airType}` +
        ` + ${merged.length - entries.length} só em raw = ${merged.length}`,
    );
    timetableEntries.push(...merged);
  }

  const extraWeeks = [];
  for (const { year, week } of extra) {
    let merged;
    try {
      const entries = await fetchWeek({ year, week });
      const raw = airType !== 'raw' ? await fetchWeek({ year, week, airType: 'raw' }) : [];
      merged = mergeTimetables(entries, raw);
      log(
        `${PREFIX} timetable ${year}-W${week} (semana extra, só acrescenta): ${entries.length} ${airType}` +
          ` + ${merged.length - entries.length} só em raw = ${merged.length}`,
      );
    } catch (err) {
      warn(`${PREFIX} ⚠ timetable ${year}-W${week} (semana extra, non-fatal, fica de fora): ${err.message}`);
      extraWeeks.push({ year, week, ok: false, entries: 0 });
      continue;
    }
    timetableEntries.push(...merged);
    extraWeeks.push({ year, week, ok: true, entries: merged.length });
  }

  return {
    timetableEntries,
    timetableComplete,
    staleWindowEnd: isoWeekEndUtc(now, TIMETABLE_STRICT_WEEKS_AHEAD).toISOString(),
    extraWeeks,
  };
}

function weekKey({ year, week }) {
  return `${year}-${week}`;
}
