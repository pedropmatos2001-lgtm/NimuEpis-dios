/**
 * A RESILIENCIA do worker de envio: o que acontece quando as coisas correm mal.
 *
 * ## Porque este ficheiro existe
 *
 * O `push-sender-send.test.js` cobre o veredito de UMA subscricao (410 apaga,
 * 500 conta, 429 traz o `Retry-After`). O que ninguem exercitava era a camada de
 * cima, que e onde vive a decisao que o dono sente:
 *
 *   - uma falha passageira volta mesmo a fila, ou perde-se?
 *   - ha teto de tentativas, ou uma entrega fica a ser repescada para sempre?
 *   - uma entrega pode ficar presa em `pending` sem `scheduled_for`, e o cron
 *     a apanha-la de volta em ciclo infinito?
 *   - um dispositivo morto trava a fila toda?
 *
 * Essa logica esta no `markFailed` e no `deliverOne`. Nenhum dos dois era
 * observavel de fora, por isso nenhum dos dois tinha teste. O ficheiro de origem
 * passou a exporta-los, e nada mais mudou la.
 *
 * ## O que NAO se testa aqui, de proposito
 *
 * Nada toca na rede nem numa base real. O `webpush.sendNotification` e
 * substituido em cada teste e o cliente Supabase e um duplo em memoria. Nenhuma
 * notificacao verdadeira sai daqui.
 *
 * Correr com `npm test` dentro de `ingestion/`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import webpush from 'web-push';

import {
  backoffSeconds,
  deliverOne,
  markFailed,
  readRetryAfter,
  MAX_ATTEMPTS,
  RETRIABLE_REASON,
  RETRY_MAX_SECONDS,
  RETRY_MIN_SECONDS,
} from '../src/push-sender.js';

/* ---------------------------------------------------------------------------
   Duplos
   -------------------------------------------------------------------------- */

/**
 * Um cliente Supabase falso com LEITURAS, e nao so escritas.
 *
 * O duplo do `push-sender-send.test.js` so precisava de registar updates e
 * deletes. Aqui e preciso mais: o `deliverOne` comeca por LER as subscricoes do
 * utilizador, e metade dos cenarios interessantes sao sobre essa leitura falhar
 * ou vir vazia.
 *
 * `subscricoes` e o que a tabela devolve; se for um `Error`, a leitura rebenta,
 * que e como se imita um segundo de rede a menos.
 */
function supabaseFalso({ subscricoes = [], erroAoLer = null } = {}) {
  const chamadas = [];

  const encadeavel = (tipo, tabela, dados) => {
    const registo = { tipo, tabela, dados, filtros: {} };
    chamadas.push(registo);
    const alvo = {
      eq(coluna, valor) {
        registo.filtros[coluna] = valor;
        return alvo;
      },
      then(resolve) {
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return alvo;
  };

  const seleccao = (tabela) => (colunas) => {
    const registo = { tipo: 'select', tabela, dados: colunas, filtros: {} };
    chamadas.push(registo);
    const alvo = {
      eq(coluna, valor) {
        registo.filtros[coluna] = valor;
        return alvo;
      },
      then(resolve) {
        const resposta =
          erroAoLer === null
            ? { data: subscricoes, error: null }
            : { data: null, error: { message: erroAoLer } };
        return Promise.resolve(resposta).then(resolve);
      },
    };
    return alvo;
  };

  return {
    chamadas,
    /** A ultima escrita numa tabela, que e o veredito que interessa afirmar. */
    ultimaEscrita(tabela) {
      return [...chamadas].reverse().find((c) => c.tipo === 'update' && c.tabela === tabela);
    },
    from(tabela) {
      return {
        select: seleccao(tabela),
        update: (dados) => encadeavel('update', tabela, dados),
        delete: () => encadeavel('delete', tabela, null),
      };
    },
  };
}

const SUB_VIVA = {
  id: 'sub-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: 'p',
  auth: 'a',
  failure_count: 0,
};

const ENTREGA = {
  id: 'entrega-1',
  user_id: 'user-1',
  event_id: 'evento-1',
  attempts: 0,
  payload: { type: 'episode_airing', anime_title: 'Frieren', episode_number: 12, anime_id: 'a1' },
};

function erroDeEnvio(statusCode, headers) {
  const erro = new Error(`push failed with ${statusCode}`);
  erro.statusCode = statusCode;
  if (headers !== undefined) erro.headers = headers;
  return erro;
}

const originalSend = webpush.sendNotification;
afterEach(() => {
  webpush.sendNotification = originalSend;
});

/* ---------------------------------------------------------------------------
   1. O recuo: quanto tempo, e com que teto
   -------------------------------------------------------------------------- */

describe('backoffSeconds', () => {
  it('a primeira tentativa espera o intervalo do cron, e nao menos', () => {
    // Recuar menos do que o intervalo do cron nao adianta nada: a corrida
    // seguinte so acontece dai a esse tempo de qualquer maneira.
    assert.equal(backoffSeconds(1, null), RETRY_MIN_SECONDS);
  });

  it('duplica a cada tentativa', () => {
    assert.equal(backoffSeconds(2, null), RETRY_MIN_SECONDS * 2);
    assert.equal(backoffSeconds(3, null), RETRY_MIN_SECONDS * 4);
    assert.equal(backoffSeconds(4, null), RETRY_MIN_SECONDS * 8);
  });

  it('nunca passa do teto, por muitas tentativas que ja tenha havido', () => {
    // Sem teto, a exponencial com 20 tentativas dava meses. E a linha ficava em
    // `pending` com uma data no futuro que ninguem ia ler.
    assert.equal(backoffSeconds(50, null), RETRY_MAX_SECONDS);
  });

  it('um Retry-After absurdo fica preso ao teto em vez de parquear a entrega', () => {
    // Um servico de push que peca uma semana nao pode conseguir guardar um aviso
    // de um episodio durante uma semana. O teto e o mesmo TTL do push.
    assert.equal(backoffSeconds(1, 60 * 60 * 24 * 7), RETRY_MAX_SECONDS);
  });

  it('um Retry-After curto sobe ao minimo, que e o do cron', () => {
    assert.equal(backoffSeconds(1, 3), RETRY_MIN_SECONDS);
  });

  it('o que o servico pediu ganha ao nosso calculo quando esta dentro dos limites', () => {
    const pedido = RETRY_MIN_SECONDS * 3;
    assert.equal(backoffSeconds(1, pedido), pedido);
  });
});

describe('readRetryAfter', () => {
  it('le os segundos', () => {
    assert.equal(readRetryAfter({ headers: { 'retry-after': '90' } }), 90);
  });

  it('le uma data HTTP e converte para segundos daqui a', () => {
    const daquiA2Min = new Date(Date.now() + 120_000).toUTCString();
    const segundos = readRetryAfter({ headers: { 'retry-after': daquiA2Min } });
    assert.ok(segundos >= 115 && segundos <= 121, `esperava ~120, veio ${segundos}`);
  });

  it('uma data no PASSADO nao devolve um numero negativo', () => {
    // Um negativo somado ao `Date.now()` punha o `scheduled_for` no passado, ou
    // seja a entrega voltava a ser lida na corrida seguinte sem recuo nenhum.
    const ontem = new Date(Date.now() - 86_400_000).toUTCString();
    assert.equal(readRetryAfter({ headers: { 'retry-after': ontem } }), 0);
  });

  it('sem cabecalhos, com lixo, ou com um erro que nem objeto e, devolve null', () => {
    assert.equal(readRetryAfter(new Error('socket hang up')), null);
    assert.equal(readRetryAfter({ headers: { 'retry-after': 'logo' } }), null);
    assert.equal(readRetryAfter(null), null);
    assert.equal(readRetryAfter('uma string atirada'), null);
  });
});

/* ---------------------------------------------------------------------------
   2. markFailed: volta a fila, ou desiste?
   -------------------------------------------------------------------------- */

describe('markFailed', () => {
  it('uma falha passageira volta a "pending" COM data marcada', async () => {
    const supabase = supabaseFalso();

    await markFailed(supabase, { ...ENTREGA, attempts: 0 }, RETRIABLE_REASON);

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'pending');
    assert.equal(escrita.dados.attempts, 1);
    // A DATA E O QUE IMPEDE O CICLO INFINITO. Sem ela a linha volta a `pending`
    // sem recuo, o cron apanha-a no minuto seguinte, e o mesmo endpoint avariado
    // e batido de minuto a minuto ate esgotar as tentativas em cinco minutos.
    assert.ok(escrita.dados.scheduled_for, 'tem de ficar com scheduled_for');
    assert.ok(
      new Date(escrita.dados.scheduled_for).getTime() > Date.now() + 1000,
      'o scheduled_for tem de ficar no FUTURO',
    );
  });

  it('a escrita e guardada por status=pending, para nao ressuscitar uma entrega ja enviada', async () => {
    // Sem esta guarda, uma corrida que demorasse a marcar podia reabrir uma
    // linha que outra corrida ja tinha posto em `sent`, e a pessoa recebia o
    // mesmo aviso duas vezes.
    const supabase = supabaseFalso();

    await markFailed(supabase, ENTREGA, RETRIABLE_REASON);

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.filtros.id, 'entrega-1');
    assert.equal(escrita.filtros.status, 'pending');
  });

  it('a ULTIMA tentativa desiste: fica em "failed" e sai da fila', async () => {
    const supabase = supabaseFalso();

    await markFailed(supabase, { ...ENTREGA, attempts: MAX_ATTEMPTS - 1 }, RETRIABLE_REASON);

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'failed');
    assert.equal(escrita.dados.attempts, MAX_ATTEMPTS);
    assert.equal(
      escrita.dados.scheduled_for,
      undefined,
      'uma entrega terminal nao volta a ser agendada',
    );
  });

  it('nenhuma entrega fica em pending para alem do teto, seja qual for o percurso', async () => {
    // O teste que responde a pergunta "pode ficar presa para sempre?".
    // Percorre-se o ciclo inteiro como o cron o faria e conta-se.
    let entrega = { ...ENTREGA, attempts: 0 };
    let voltas = 0;

    while (voltas < 50) {
      const supabase = supabaseFalso();
      await markFailed(supabase, entrega, RETRIABLE_REASON);
      const escrita = supabase.ultimaEscrita('notification_deliveries');
      voltas += 1;
      if (escrita.dados.status === 'failed') break;
      entrega = { ...entrega, attempts: escrita.dados.attempts };
    }

    assert.equal(voltas, MAX_ATTEMPTS, `esperava ${MAX_ATTEMPTS} voltas, houve ${voltas}`);
  });

  it('um motivo TERMINAL desiste a primeira, sem gastar tentativas', async () => {
    const supabase = supabaseFalso();

    await markFailed(supabase, ENTREGA, 'all_subscriptions_expired');

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'failed');
    assert.equal(escrita.dados.attempts, 1);
  });

  it('o texto do erro vai no detalhe e NAO colado ao motivo', async () => {
    // Foi exatamente assim que o `load_subscriptions` ficou terminal em
    // silencio: trazia a mensagem colada ao motivo, e a comparacao com a
    // constante nunca batia certo. Se isto voltar a acontecer, o teste apanha.
    const supabase = supabaseFalso();

    await markFailed(supabase, ENTREGA, RETRIABLE_REASON, {
      detail: 'load_subscriptions: fetch failed',
    });

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'pending', 'continua a ser passageira');
    assert.match(escrita.dados.error, /load_subscriptions/);
  });
});

/* ---------------------------------------------------------------------------
   3. deliverOne: a entrega inteira, subscricao a subscricao
   -------------------------------------------------------------------------- */

describe('deliverOne', () => {
  beforeEach(() => {
    webpush.sendNotification = async () => ({ statusCode: 201 });
  });

  it('o caminho feliz marca "sent" e nao volta a fila', async () => {
    const supabase = supabaseFalso({ subscricoes: [SUB_VIVA] });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, true);
    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'sent');
    assert.ok(escrita.dados.sent_at, 'tem de registar a hora do envio');
  });

  it('a leitura das subscricoes a falhar e PASSAGEIRA, nao terminal', async () => {
    // Um segundo de rede a menos ao ler a base nao pode custar o aviso. Ficava
    // em `failed` para sempre, apesar de o cabecalho do ficheiro prometer o
    // contrario desde o commit fc41a80.
    const supabase = supabaseFalso({ erroAoLer: 'fetch failed' });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, false);
    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'pending', 'tem de voltar a fila');
    assert.ok(escrita.dados.scheduled_for);
  });

  it('sem dispositivo nenhum e TERMINAL: nao ha para onde enviar', async () => {
    // Voltar a tentar daqui a cinco minutos nao faz aparecer um telemovel.
    const supabase = supabaseFalso({ subscricoes: [] });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, false);
    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'failed');
    assert.match(escrita.dados.error, /no_active_subscription/);
  });

  it('todas as subscricoes expiradas (410) e terminal, e as linhas mortas sao apagadas', async () => {
    webpush.sendNotification = async () => {
      throw erroDeEnvio(410);
    };
    const supabase = supabaseFalso({
      subscricoes: [SUB_VIVA, { ...SUB_VIVA, id: 'sub-2' }],
    });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, false);
    assert.equal(resultado.pruned, 2, 'as duas subscricoes mortas tem de sair da tabela');
    const apagadas = supabase.chamadas.filter(
      (c) => c.tipo === 'delete' && c.tabela === 'push_subscriptions',
    );
    assert.equal(apagadas.length, 2);
    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'failed');
    assert.match(escrita.dados.error, /all_subscriptions_expired/);
  });

  it('um 500 e PASSAGEIRO e a subscricao fica de pe', async () => {
    webpush.sendNotification = async () => {
      throw erroDeEnvio(500);
    };
    const supabase = supabaseFalso({ subscricoes: [SUB_VIVA] });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, false);
    assert.equal(resultado.pruned, 0);
    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'pending');
  });

  it('um 429 respeita o Retry-After do servico em vez do nosso calculo', async () => {
    const pedido = RETRY_MIN_SECONDS * 4;
    webpush.sendNotification = async () => {
      throw erroDeEnvio(429, { 'retry-after': String(pedido) });
    };
    const supabase = supabaseFalso({ subscricoes: [SUB_VIVA] });

    const antes = Date.now();
    await deliverOne(supabase, ENTREGA);

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    const espera = (new Date(escrita.dados.scheduled_for).getTime() - antes) / 1000;
    assert.ok(
      espera > pedido - 10 && espera < pedido + 10,
      `esperava ~${pedido}s de recuo, veio ${espera}s`,
    );
  });

  it('com DOIS servicos a pedir esperas diferentes, ganha a MAIOR', async () => {
    // Esperar a menor voltava a bater no primeiro servico antes do tempo, e um
    // 429 respondido cedo demais e como o servico corta a torneira de vez.
    let vez = 0;
    webpush.sendNotification = async () => {
      vez += 1;
      throw erroDeEnvio(429, { 'retry-after': vez === 1 ? '600' : '60' });
    };
    const supabase = supabaseFalso({
      subscricoes: [SUB_VIVA, { ...SUB_VIVA, id: 'sub-2' }],
    });

    const antes = Date.now();
    await deliverOne(supabase, ENTREGA);

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    const espera = (new Date(escrita.dados.scheduled_for).getTime() - antes) / 1000;
    assert.ok(espera > 590, `esperava os 600s do servico mais lento, veio ${espera}s`);
  });

  it('UM aparelho vivo entre varios mortos chega para a entrega contar como feita', async () => {
    // Ter tres aparelhos e um deles avariado nao pode fazer perder o aviso nos
    // outros dois.
    webpush.sendNotification = async (sub) => {
      if (sub.endpoint.endsWith('morto')) throw erroDeEnvio(410);
      return { statusCode: 201 };
    };
    const supabase = supabaseFalso({
      subscricoes: [
        { ...SUB_VIVA, id: 'sub-morta', endpoint: 'https://fcm.googleapis.com/fcm/send/morto' },
        SUB_VIVA,
      ],
    });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, true);
    assert.equal(resultado.pruned, 1);
    assert.equal(supabase.ultimaEscrita('notification_deliveries').dados.status, 'sent');
  });

  it('um erro inesperado num aparelho NAO mata a entrega dos outros', async () => {
    // O cinto por cima do `sendToSubscription`. Um `throw` que lhe escapasse
    // subia por tudo e matava a corrida, e o cron voltava a apanhar o MESMO lote
    // cinco minutos depois. Uma subscricao avariada silenciava o push para toda
    // a gente.
    webpush.sendNotification = async (sub) => {
      // Um throw de uma string, que e o que faz `error.message` rebentar dentro
      // do proprio tratador de erros.
      if (sub.endpoint.endsWith('mau')) throw 'isto nem sequer e um Error';
      return { statusCode: 201 };
    };
    const supabase = supabaseFalso({
      subscricoes: [
        { ...SUB_VIVA, id: 'sub-ma', endpoint: 'https://fcm.googleapis.com/fcm/send/mau' },
        SUB_VIVA,
      ],
    });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(resultado.sent, true, 'o aparelho bom tem de receber na mesma');
  });

  it('um endpoint apontado a rede interna e recusado sem chegar a haver pedido', async () => {
    let tentou = false;
    webpush.sendNotification = async () => {
      tentou = true;
      return { statusCode: 201 };
    };
    const supabase = supabaseFalso({
      subscricoes: [{ ...SUB_VIVA, endpoint: 'https://169.254.169.254/latest/meta-data' }],
    });

    const resultado = await deliverOne(supabase, ENTREGA);

    assert.equal(tentou, false, 'nao pode sair pedido nenhum para um endereco interno');
    assert.equal(resultado.sent, false);
    // Conta como falha VIVA, portanto passageira: a linha fica e volta a fila.
    assert.equal(supabase.ultimaEscrita('notification_deliveries').dados.status, 'pending');
  });

  it('o contador de tentativas vem da LINHA e nao de zero em cada corrida', async () => {
    // Se o worker reiniciar o contador a cada corrida, o teto de tentativas
    // nunca e atingido e a entrega e repescada para sempre.
    webpush.sendNotification = async () => {
      throw erroDeEnvio(500);
    };
    const supabase = supabaseFalso({ subscricoes: [SUB_VIVA] });

    await deliverOne(supabase, { ...ENTREGA, attempts: 3 });

    assert.equal(supabase.ultimaEscrita('notification_deliveries').dados.attempts, 4);
  });

  it('a QUINTA falha seguida desiste, e a entrega sai da fila de vez', async () => {
    webpush.sendNotification = async () => {
      throw erroDeEnvio(503);
    };
    const supabase = supabaseFalso({ subscricoes: [SUB_VIVA] });

    await deliverOne(supabase, { ...ENTREGA, attempts: MAX_ATTEMPTS - 1 });

    const escrita = supabase.ultimaEscrita('notification_deliveries');
    assert.equal(escrita.dados.status, 'failed');
    assert.equal(escrita.dados.attempts, MAX_ATTEMPTS);
  });
});
