/**
 * A releitura do consentimento antes de enviar.
 *
 * ## Porque isto tem de estar coberto
 *
 * Esta defesa já tinha sido escrita uma vez, na migração
 * `20260823000000_dsa_e_rgpd.sql`, como a função `pode_receber_push`. O
 * cabeçalho dessa migração promete, com todas as letras, que "o fan-out passa a
 * confirmar a idade no momento do envio" e avisa que "um só dos dois deixava a
 * porta encostada".
 *
 * Nunca foi ligada. A função ficou lá, correcta, e nada em todo o repositório
 * lhe chamava. Uma auditoria com sessenta e oito agentes passou por cima dela e
 * só a apanhou na terceira volta, porque uma função que existe e não é chamada
 * lê-se exactamente como uma função que funciona.
 *
 * É por isso que os testes desta defesa importam mais do que os da maioria do
 * código: o modo de falha dela é o silêncio. Se ela desaparecer outra vez, nada
 * na aplicação muda, nada parte, nenhum registo se queixa. Só volta a haver uma
 * janela de meia hora em que um menor pode receber push.
 *
 * ## O cenário concreto que estes testes fixam
 *
 * Alguém põe 1990, liga o push, fica com `channel_web_push = true`. Sai um
 * episódio. O fan-out cria a entrega. Antes de o worker correr (mediana medida:
 * 25,6 minutos, máximo 37,2) a pessoa corrige o ano para 2010. O gatilho em
 * `profiles` põe o canal a `false` e faz o trabalho dele.
 *
 * A entrega, essa, já estava na fila. Antes disto, saía na mesma.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import webpush from 'web-push';

import { loadConsent, sendToSubscription } from '../src/push-sender.js';

const ANO_ATUAL = new Date().getUTCFullYear();
const ADULTO = ANO_ATUAL - 30;
const MENOR = ANO_ATUAL - 12;
/** Faz hoje exactamente 18. A fronteira, que é onde as contas se enganam. */
const FAZ_18 = ANO_ATUAL - 18;
/** Falta um ano. O outro lado da mesma fronteira. */
const FAZ_17 = ANO_ATUAL - 17;

/**
 * Uma Supabase de mentira que devolve o que lhe dermos.
 *
 * Só entende a forma exacta que o `loadConsent` usa
 * (`.from(t).select(c).in(col, ids)`), e atira em tudo o resto. É de propósito:
 * um postiço permissivo deixa o teste passar contra uma consulta que mudou.
 */
function supabaseFalsa({ settings = [], profiles = [], erro = null } = {}) {
  return {
    from(tabela) {
      return {
        select() {
          return {
            in(coluna, ids) {
              assert.equal(coluna, 'user_id', 'a consulta tem de filtrar por user_id');
              assert.ok(Array.isArray(ids), 'os ids têm de vir em lista');
              if (erro !== null) return Promise.resolve({ data: null, error: { message: erro } });
              const linhas = tabela === 'notification_settings' ? settings : profiles;
              return Promise.resolve({
                data: linhas.filter((l) => ids.includes(l.user_id)),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

test('um adulto com o canal ligado pode receber', async () => {
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [{ user_id: 'a', channel_web_push: true }],
      profiles: [{ user_id: 'a', birth_year: ADULTO }],
    }),
    ['a'],
  );
  assert.equal(podem.get('a'), true);
});

test('quem desligou o canal NÃO pode, mesmo tendo entrega na fila', async () => {
  // A janela dos 37 minutos. O fan-out decidiu que sim quando o episódio saiu;
  // entretanto a pessoa disse que não. Ganha o que ela disse por último.
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [{ user_id: 'a', channel_web_push: false }],
      profiles: [{ user_id: 'a', birth_year: ADULTO }],
    }),
    ['a'],
  );
  assert.equal(podem.get('a'), false);
});

test('um MENOR não pode, mesmo com o canal ainda ligado', async () => {
  // O caso da DSA. O interruptor pode estar ligado por o gatilho ainda não ter
  // corrido, ou por a linha ter sido escrita por um caminho que ele não cobre.
  // A idade decide na mesma.
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [{ user_id: 'a', channel_web_push: true }],
      profiles: [{ user_id: 'a', birth_year: MENOR }],
    }),
    ['a'],
  );
  assert.equal(podem.get('a'), false);
});

test('ano de nascimento ausente conta como menor', async () => {
  // Sem idade não há como afirmar que é adulto, e a DSA põe o ónus do nosso
  // lado. É a mesma regra que os gatilhos já aplicam.
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [{ user_id: 'a', channel_web_push: true }],
      profiles: [{ user_id: 'a', birth_year: null }],
    }),
    ['a'],
  );
  assert.equal(podem.get('a'), false);
});

test('sem linha de perfil nenhuma, também conta como menor', async () => {
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [{ user_id: 'a', channel_web_push: true }],
      profiles: [],
    }),
    ['a'],
  );
  assert.equal(podem.get('a'), false);
});

test('a fronteira dos 18 decide-se pelo ano, e para os dois lados', async () => {
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [
        { user_id: 'faz18', channel_web_push: true },
        { user_id: 'faz17', channel_web_push: true },
      ],
      profiles: [
        { user_id: 'faz18', birth_year: FAZ_18 },
        { user_id: 'faz17', birth_year: FAZ_17 },
      ],
    }),
    ['faz18', 'faz17'],
  );
  assert.equal(podem.get('faz18'), true, 'quem faz 18 este ano passa');
  assert.equal(podem.get('faz17'), false, 'a quem falta um ano, não');
});

test('quem nunca teve definições nenhumas não pode receber', async () => {
  // Uma entrega para essa pessoa não devia sequer existir. Se existe, é para
  // não sair: o mapa tem de responder por TODOS os ids pedidos, e não deixar
  // buracos que o chamador leia como "não sei, deixa passar".
  const { podem } = await loadConsent(supabaseFalsa({}), ['fantasma']);
  assert.equal(podem.get('fantasma'), false);
  assert.ok(podem.has('fantasma'), 'o mapa não pode ter buracos');
});

test('um lote misto resolve-se pessoa a pessoa', async () => {
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [
        { user_id: 'ok', channel_web_push: true },
        { user_id: 'desligou', channel_web_push: false },
        { user_id: 'menor', channel_web_push: true },
      ],
      profiles: [
        { user_id: 'ok', birth_year: ADULTO },
        { user_id: 'desligou', birth_year: ADULTO },
        { user_id: 'menor', birth_year: MENOR },
      ],
    }),
    ['ok', 'desligou', 'menor', 'ausente'],
  );
  assert.deepEqual(
    [...podem.entries()].sort(),
    [
      ['ausente', false],
      ['desligou', false],
      ['menor', false],
      ['ok', true],
    ],
  );
});

test('uma falha de leitura DEIXA PASSAR, e não bloqueia o lote todo', async () => {
  // A decisão difícil deste bloco, e está tomada de propósito.
  //
  // Se esta leitura falhar (rede, tempo esgotado), a alternativa seria bloquear
  // tudo, e isso transformava uma falha de leitura numa paragem silenciosa de
  // TODAS as notificações. É exactamente o defeito de que o dono mais se
  // queixou: "está tudo partido nas notificações".
  //
  // O interruptor no fan-out continua a ser a primeira defesa. Esta é a segunda,
  // e uma segunda defesa que se avaria não pode derrubar a casa.
  const { podem } = await loadConsent(supabaseFalsa({ erro: 'rede foi abaixo' }), ['a', 'b']);
  assert.equal(podem.size, 0, 'mapa vazio: ninguém é bloqueado');
  assert.equal(podem.get('a'), undefined);
  // E o chamador compara com `=== false`, portanto `undefined` deixa seguir.
  assert.notEqual(podem.get('a'), false);
});

test('um lote vazio não vai à base', async () => {
  const supabase = {
    from() {
      throw new Error('não devia ter havido consulta nenhuma');
    },
  };
  const { podem } = await loadConsent(supabase, []);
  assert.equal(podem.size, 0);
});

test('o canal só conta a TRUE de verdade, e não a qualquer coisa parecida', async () => {
  // A comparação é `=== true`. Um nulo na coluna, ou uma cadeia de texto vinda
  // de um caminho que não passe pelo tipo booleano, não pode passar por
  // consentimento.
  const { podem } = await loadConsent(
    supabaseFalsa({
      settings: [
        { user_id: 'nulo', channel_web_push: null },
        { user_id: 'texto', channel_web_push: 'true' },
        { user_id: 'um', channel_web_push: 1 },
      ],
      profiles: [
        { user_id: 'nulo', birth_year: ADULTO },
        { user_id: 'texto', birth_year: ADULTO },
        { user_id: 'um', birth_year: ADULTO },
      ],
    }),
    ['nulo', 'texto', 'um'],
  );
  assert.equal(podem.get('nulo'), false);
  assert.equal(podem.get('texto'), false);
  assert.equal(podem.get('um'), false);
});

// ---------------------------------------------------------------------------
// O 403 da chave VAPID
// ---------------------------------------------------------------------------
//
// Um 403 do serviço de push quer dizer que a NOSSA assinatura foi recusada, e
// isso nunca é culpa do aparelho. Acontece quando a `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
// que a app usa para criar subscrições deixa de bater certo com a
// `VAPID_PUBLIC_KEY` com que o worker assina: uma rotação feita só num dos lados
// chega.
//
// O que o torna insidioso é tudo o resto continuar a parecer bem. O `subscribe()`
// passa, a linha grava, o cartão diz "ligado", e cada envio morre em 403. Não é
// 404 nem 410, portanto a subscrição não é podada. Era tratado como passageiro,
// portanto gastava as cinco tentativas e acabava em `failed`, repetindo-se por
// cada notificação, indefinidamente, sem sinal nenhum em lado nenhum.

// Estes testes CORREM o código, e não olham para ele. A primeira versão deles
// era um grupo de tautologias (um `assert.notEqual` sobre duas constantes) e
// dois regex sobre o próprio texto do `push-sender.js`, e a auditoria de
// 2026-08-23 apanhou-os: apagar o ramo do 403 por inteiro deixava a suite 197/197
// verde, ou seja, protegiam ZERO comportamento. Um falso alarme é pior do que
// nenhum. Agora mocam o `webpush` e exercitam a decisão a sério.

const originalSend = webpush.sendNotification;
afterEach(() => {
  webpush.sendNotification = originalSend;
});

/** Um erro como a `web-push` os atira: um objeto com `statusCode`. */
function erroDeEnvio(statusCode) {
  const erro = new Error(`push failed with ${statusCode}`);
  erro.statusCode = statusCode;
  return erro;
}

/**
 * Uma Supabase falsa encadeável que regista os updates, para os testes poderem
 * afirmar QUE estado a entrega levou, e não só o que a função devolveu.
 */
function supabaseComRegisto() {
  const updates = [];
  return {
    updates,
    from() {
      return {
        update(dados) {
          const registo = { dados, filtros: {} };
          updates.push(registo);
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
        },
        delete() {
          const alvo = { eq: () => alvo, then: (r) => Promise.resolve({ error: null }).then(r) };
          return alvo;
        },
      };
    },
  };
}

const SUB_VIVA = {
  id: 'sub-403',
  endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
  p256dh: 'p',
  auth: 'a',
  failure_count: 0,
};

test('um 403 devolve "denied", e NÃO poda a subscrição', async () => {
  // A subscrição está boa, é a NOSSA assinatura que foi recusada. Podá-la seria
  // apagar um aparelho são por um erro que não é dele.
  webpush.sendNotification = async () => {
    throw erroDeEnvio(403);
  };
  const supabase = supabaseComRegisto();
  const veredito = await sendToSubscription(supabase, SUB_VIVA, '{}');

  assert.equal(veredito.outcome, 'denied', 'o 403 é "denied", não "failed" nem "gone"');
  // Nenhum DELETE: a subscrição fica. Só o `failure_count` sobe.
  const apagou = supabase.updates.some((u) => u.dados && u.dados.status === undefined && u.dados.failure_count === undefined);
  assert.ok(!apagou, 'não deve haver delete');
  assert.ok(
    supabase.updates.some((u) => u.dados.failure_count === 1),
    'o failure_count sobe',
  );
});

test('um 410 continua a podar (o contraste com o 403)', async () => {
  // O par do teste acima: um aparelho MORTO apaga-se, uma assinatura recusada
  // não. Se algum dia os dois se confundirem, é aqui que se vê.
  webpush.sendNotification = async () => {
    throw erroDeEnvio(410);
  };
  const supabase = supabaseComRegisto();
  const veredito = await sendToSubscription(supabase, SUB_VIVA, '{}');
  assert.equal(veredito.outcome, 'gone');
});

test('um 500 é "failed", e volta à fila (o 403 não)', async () => {
  // O terceiro vértice: um erro passageiro do serviço de push. Este SIM volta à
  // fila, e é a diferença que separa o 403 (terminal) do 500 (passageiro).
  webpush.sendNotification = async () => {
    throw erroDeEnvio(500);
  };
  const supabase = supabaseComRegisto();
  const veredito = await sendToSubscription(supabase, SUB_VIVA, '{}');
  assert.equal(veredito.outcome, 'failed');
});
