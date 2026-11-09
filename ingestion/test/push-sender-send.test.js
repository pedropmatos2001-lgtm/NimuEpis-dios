/**
 * O caminho de erro do envio de push, que nunca tinha sido corrido.
 *
 * ## Porque este ficheiro existe
 *
 * `sendToSubscription` tem um `catch` que decide, pelo código HTTP, se uma
 * subscrição morreu (404/410, apaga-se) ou se apenas falhou desta vez (conta-se
 * e volta à fila). Esse `catch` chamava `readStatusCode`, uma função que NÃO
 * EXISTIA no ficheiro.
 *
 * Nada apanhou isso. O TypeScript não vê este ficheiro, e em produção o `catch`
 * só corre quando um endpoint responde fora de 2xx, o que nunca tinha
 * acontecido: 49 enviados, 0 falhados. O defeito esteve armado e invisível
 * desde que foi escrito.
 *
 * O que teria acontecido à primeira subscrição expirada: `ReferenceError`, que
 * sobe pelo ciclo de subscrições, por `deliverOne`, por
 * `processPendingDeliveries`, e mata a corrida. A entrega fica em `pending`, e
 * o cron de cinco em cinco minutos volta a apanhar o mesmo lote e volta a
 * morrer. Uma subscrição morta silenciava o push para toda a gente, em todas as
 * plataformas.
 *
 * No Android isso não é hipótese remota: as subscrições expiram por rotina
 * (desinstalar a PWA, limpar os dados do Chrome, o Play Services rodar o
 * token), e o 410 é como uma subscrição normalmente acaba.
 *
 * Correr com `npm test` dentro de `ingestion/`.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import webpush from 'web-push';

import { sendToSubscription } from '../src/push-sender.js';

/* ---------------------------------------------------------------------------
   Duplos
   -------------------------------------------------------------------------- */

/**
 * Um cliente Supabase falso, encadeável, que regista o que lhe pediram.
 *
 * O verdadeiro devolve um objeto encadeável (`.from().update().eq()`) que só
 * resolve no fim. Este imita essa forma e guarda as chamadas, para os testes
 * poderem afirmar que a linha foi mesmo apagada, e não apenas que a função
 * devolveu a palavra certa.
 */
function supabaseFalso() {
  const chamadas = [];
  const encadeavel = (tipo, tabela, dados) => {
    const registo = { tipo, tabela, dados, filtros: {} };
    chamadas.push(registo);
    const alvo = {
      eq(coluna, valor) {
        registo.filtros[coluna] = valor;
        return alvo;
      },
      // Um `await` numa consulta do Supabase resolve o encadeamento; um `then`
      // próprio é o que torna este objeto esperável sem ser uma Promise.
      then(resolve) {
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return alvo;
  };

  return {
    chamadas,
    from(tabela) {
      return {
        update: (dados) => encadeavel('update', tabela, dados),
        delete: () => encadeavel('delete', tabela, null),
      };
    },
  };
}

const SUB = {
  id: 'sub-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: 'p',
  auth: 'a',
  failure_count: 2,
};

/** Um erro como a `web-push` os atira: um objeto com `statusCode`. */
function erroDeEnvio(statusCode, headers) {
  const erro = new Error(`push failed with ${statusCode}`);
  erro.statusCode = statusCode;
  if (headers !== undefined) erro.headers = headers;
  return erro;
}

const original = webpush.sendNotification;
afterEach(() => {
  webpush.sendNotification = original;
});

/* ---------------------------------------------------------------------------
   Testes
   -------------------------------------------------------------------------- */

describe('sendToSubscription', () => {
  it('um 410 apaga a subscrição e devolve "gone"', async () => {
    // ESTE é o teste que rebentava com ReferenceError antes da correção.
    webpush.sendNotification = async () => {
      throw erroDeEnvio(410);
    };
    const supabase = supabaseFalso();

    const { outcome } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'gone');
    const apagou = supabase.chamadas.find((c) => c.tipo === 'delete');
    assert.notEqual(apagou, undefined, 'a linha morta tem de ser apagada');
    assert.equal(apagou.tabela, 'push_subscriptions');
    assert.equal(apagou.filtros.id, 'sub-1');
  });

  it('um 404 conta como morta pela mesma razão', async () => {
    webpush.sendNotification = async () => {
      throw erroDeEnvio(404);
    };
    const supabase = supabaseFalso();

    const { outcome } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'gone');
    assert.ok(supabase.chamadas.some((c) => c.tipo === 'delete'));
  });

  it('um 500 guarda a subscrição e conta a falha', async () => {
    webpush.sendNotification = async () => {
      throw erroDeEnvio(500);
    };
    const supabase = supabaseFalso();

    const { outcome } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'failed');
    assert.ok(
      !supabase.chamadas.some((c) => c.tipo === 'delete'),
      'um 500 é temporário: a subscrição fica',
    );
    const contou = supabase.chamadas.find((c) => c.tipo === 'update');
    assert.notEqual(contou, undefined);
    assert.equal(contou.dados.failure_count, 3, 'de 2 para 3');
  });

  it('um 429 devolve os segundos que o serviço pediu', async () => {
    // O 429 do FCM quer dizer "abranda, volta daqui a X". Era tratado como
    // falha definitiva, e a entrega perdia-se.
    webpush.sendNotification = async () => {
      throw erroDeEnvio(429, { 'retry-after': '120' });
    };
    const supabase = supabaseFalso();

    const { outcome, retryAfter } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'failed');
    assert.equal(retryAfter, 120);
  });

  it('um erro SEM statusCode não rebenta, conta como falha', async () => {
    // Uma falha de rede não traz código nenhum. `readStatusCode` tem de
    // devolver null em vez de atirar, senão volta o problema original.
    webpush.sendNotification = async () => {
      throw new Error('socket hang up');
    };
    const supabase = supabaseFalso();

    const { outcome, retryAfter } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'failed');
    assert.equal(retryAfter, null);
    assert.ok(!supabase.chamadas.some((c) => c.tipo === 'delete'));
  });

  it('um envio aceite devolve "sent" e não escreve nada', async () => {
    webpush.sendNotification = async () => ({ statusCode: 201 });
    const supabase = supabaseFalso();

    const { outcome } = await sendToSubscription(supabase, SUB, '{}');

    assert.equal(outcome, 'sent');
    assert.equal(supabase.chamadas.length, 0, 'o caminho feliz não toca na base');
  });

  it('um endpoint interno é recusado antes de haver pedido nenhum', async () => {
    // A guarda de SSRF. Se isto alguma vez deixar passar, o worker passa a
    // poder ser usado para bater em serviços da rede interna.
    let tentou = false;
    webpush.sendNotification = async () => {
      tentou = true;
      return { statusCode: 201 };
    };
    const supabase = supabaseFalso();

    const { outcome } = await sendToSubscription(
      supabase,
      { ...SUB, endpoint: 'http://127.0.0.1:8080/push' },
      '{}',
    );

    assert.equal(outcome, 'failed');
    assert.equal(tentou, false, 'não pode haver pedido nenhum a um endereço interno');
  });
});
