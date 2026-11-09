// =============================================================================
// As horas de silencio, a logica pura
// =============================================================================
//
// A interface promete, com todas as letras (`profile.account.notifications.
// quietHoursDescription`): "Pausa as notificacoes push e por email durante
// estas horas". Ate 2026-08-23 nenhum worker as respeitava: as colunas
// existiam, a UI gravava-as, e o envio ignorava-as. Uma interface que promete
// uma coisa que nao acontece e pior do que nao ter a funcionalidade.
//
// Este modulo e a parte que se pode enganar em silencio (a matematica das horas
// e dos fusos), separada para ter testes. O `push-sender.js` usa-o para decidir,
// no momento do envio, se a entrega e para sair agora ou para esperar pela
// manha.
//
// ## O que se guarda, e como se interpreta
//
//  - `start` e `end` sao horas locais, 0 a 23. O silencio vai de `start:00`
//    (inclusive) a `end:00` (exclusive).
//  - Um intervalo que passa a meia-noite (start > end, ex.: 22 para 8) e valido
//    e le-se como envolvente: silencio das 22 as 8 da manha seguinte.
//  - `tz` e um fuso IANA (ex.: "Europe/Lisbon"), para a hora ser a DELE e nao a
//    do servidor.

/**
 * A hora local (0 a 23) de um instante, no fuso dado.
 *
 * Usa o `Intl.DateTimeFormat`, que sabe de fusos e de horario de verao, em vez
 * de aritmetica de offsets a mao, que erra duas vezes por ano.
 */
export function horaLocal(agora, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  // `hour: 'numeric'` com `hour12: false` da 0..23, mas a meia-noite sai como
  // "24" nalgumas plataformas: o modulo 24 normaliza-a de volta a 0.
  return Number(fmt.format(agora)) % 24;
}

/** O minuto local (0..59) de um instante, no fuso dado. */
export function minutoLocal(agora, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    minute: 'numeric',
  });
  return Number(fmt.format(agora)) % 60;
}

/**
 * Estamos dentro das horas de silencio desta pessoa, neste instante?
 *
 * `false` quando nao ha silencio definido, ou quando o intervalo e vazio
 * (start igual a end), que e como se le "sem silencio".
 */
export function dentroDoSilencio(agora, start, end, tz) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    typeof tz !== 'string' ||
    tz === ''
  ) {
    return false;
  }
  if (start === end) return false;

  const h = horaLocal(agora, tz);
  // Intervalo normal (ex.: 1 as 6): dentro se start <= h < end.
  if (start < end) return h >= start && h < end;
  // Intervalo envolvente (ex.: 22 as 8): dentro se h >= start OU h < end.
  return h >= start || h < end;
}

/**
 * O instante em que o silencio acaba, para adiar a entrega ate la.
 *
 * E a proxima ocorrencia de `end:00` no fuso da pessoa. O calculo e por horas
 * inteiras a partir de agora, e assume que o minuto certo nao importa: uma
 * notificacao que sai as 08:03 em vez das 08:00 nao incomoda ninguem, e tentar
 * o minuto exato traria de volta a aritmetica de fusos que o `Intl` existe para
 * evitar.
 *
 * O erro maximo e de uma hora, nos dois dias do ano em que o relogio muda: a
 * notificacao sai ate uma hora antes ou depois do fim exato, ainda dentro da
 * manha. E um preco pequeno por nao ter codigo de horario de verao a mao.
 *
 * ## Porque a conta e em MINUTOS, e nao em horas
 *
 * Uma versao anterior somava horas inteiras e depois fazia `setUTCMinutes(0)`.
 * Isso partia-se nos fusos de meia hora (a India em +5:30, o Nepal em +5:45, a
 * Terra Nova em -3:30): zerar os minutos EM UTC nao cai em `end:00` LOCAL nesses
 * sitios, e a notificacao saia ate meia hora ao lado. Contar em minutos ate a
 * proxima ocorrencia de `end:00` local resolve-o sem trazer de volta a
 * aritmetica de fusos, porque somar minutos a um instante e uma operacao
 * indiferente ao fuso.
 */
export function fimDoSilencio(agora, end, tz) {
  const agoraMinutos = horaLocal(agora, tz) * 60 + minutoLocal(agora, tz);
  const fimMinutos = end * 60;

  // Minutos ate a proxima vez que o relogio local marca `end:00`. Se ja e essa
  // hora exata, e so daqui a um dia; o `|| DIA` impede um "daqui a zero
  // minutos", que deixaria a entrega presa a disparar contra si mesma.
  const DIA = 24 * 60;
  let faltam = (fimMinutos - agoraMinutos + DIA) % DIA;
  if (faltam === 0) faltam = DIA;

  return new Date(agora.getTime() + faltam * 60 * 1000);
}
