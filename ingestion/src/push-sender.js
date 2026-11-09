// =============================================================================
// Nimu — Web Push delivery worker (runs as a GitHub Action, NOT an Edge Function)
// =============================================================================
// WHAT THIS IS
//
//   The server end of the Web Push transport. It drains the 'web_push' rows the
//   fan-out writes to the outbox (public.notification_deliveries) and turns each
//   into a real, VAPID-signed browser push via the `web-push` npm library.
//
//   It is the Node/GitHub-Action twin of supabase/functions/send-push/index.ts
//   (the never-deployed Edge Function). Same logic — claim pending rows, send to
//   every one of the user's push_subscriptions, mark sent/failed, prune dead
//   subscriptions (404/410) — reimplemented on the ingestion stack (config.js +
//   the service-role supabase client) because the owner does NOT deploy Supabase
//   functions; everything server-side ships as a scheduled GitHub Action.
//
//   It does NOT create deliveries. The fan-out
//   (fan_out_episode_airing/_upcoming/_delayed, migration 030) writes one
//   web_push row per (user × event) when channel_web_push is on and the user has
//   a live subscription. This worker only consumes rows with status = 'pending'.
//
// RUN
//   npm run push:send        → live: read pending web_push, send, mark, prune.
//   npm run push:send:dry    → dry-run: report how many rows it WOULD send and
//                              the payload it WOULD build; sends nothing, marks
//                              nothing, needs NO VAPID keys. Falls back to an
//                              OFFLINE payload demo when Supabase env is absent.
//
// ENV (read via config.js — the only module that touches process.env)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — read the outbox / prune subs.
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,       — sign the push (live send only).
//   VAPID_SUBJECT (mailto:/https:)
//   PUBLIC_SITE_URL                            — optional; click target + icon
//                                                origin. Default:
//                                                https://www.nimuhome.com
//   PUSH_SEND_BATCH_SIZE (default 200),        — optional tuning.
//   PUSH_SEND_TTL_SECONDS (default 21600, i.e. 6h — see PUSH_TTL_SECONDS)
//
// RETRY
//   A transient failure (network, 5xx, 429) puts the row BACK to pending
//   with an exponential `scheduled_for`, up to MAX_ATTEMPTS. A dead endpoint
//   (404/410) and "every subscription expired" are terminal and go straight to
//   failed. Before this, there was no retry at all: `attempts` never passed
//   1 and a one-second network blip lost the notification for good.
//
// IDEMPOTENCY / AT-LEAST-ONCE
//   Only 'pending' rows are picked and each UPDATE is guarded by
//   .eq('status','pending'), so a re-run never re-sends a completed delivery.
//   Delivery is at-least-once: a crash between "push accepted" and "row marked"
//   can re-send — so every notification carries a `tag` (event/delivery id) and
//   the service worker sets renotify, collapsing a duplicate into a replace.
//
// SECURITY
//   Uses the service-role client (bypasses RLS) — it must read every user's
//   pending deliveries and subscriptions. That runs ONLY here (CI / server), never
//   in the app. Secrets are read by name and never logged.
// =============================================================================

import { pathToFileURL } from 'node:url';

import webpush from 'web-push';

import { config, assertPushConfig } from './config.js';
import { dentroDoSilencio, fimDoSilencio } from './quiet-hours.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Absolute web origin (no trailing slash) for click targets + the icon URL.
// O dominio do produto, e nao o de outra pessoa.
//
// O valor por omissao era `https://nimu.app`, que NAO e nosso: responde 200 e
// e de um terceiro. Um envio sem PUBLIC_SITE_URL definida mandava toda a gente
// que tocasse na notificacao para o site de outro. Apanhado na auditoria de
// 2026-08-21.
//
// A variavel continua a poder sobrepor-se (a pre-producao precisa disso), mas
// quando falta, o fallback e o sitio certo.
const SITE_URL = (config.publicSiteUrl ?? 'https://www.nimuhome.com').replace(/\/+$/, '');

// Oldest-due rows per run. A few hundred keeps a single Action run well within
// its time budget; increase the cron frequency or this for higher volume.
const BATCH_SIZE = clampInt(config.pushBatchSize, 200, 1, 1000);
// Quanto tempo o servico de push guarda a mensagem enquanto o aparelho estiver
// offline.
//
// SEIS HORAS por omissao, e nao as vinte e quatro que aqui estavam. E o mesmo
// numero que a migracao 20260822000000 impos ao fan-out, e e o mesmo pela mesma
// razao: se nao criamos sequer um evento para um episodio que saiu ha mais de
// seis horas, tambem nao faz sentido ENTREGAR um aviso com essa idade.
//
// Com vinte e quatro horas, um "o episodio estreia daqui a pouco" guardado por
// um telemovel desligado podia aterrar no dia seguinte, a anunciar uma estreia
// que ja tinha acontecido. Passado o prazo, o servico deita a mensagem fora, que
// e o comportamento certo para um aviso com hora marcada.
const PUSH_TTL_SECONDS = clampInt(config.pushTtlSeconds, 60 * 60 * 6, 0, 60 * 60 * 24 * 28);

/** Quanto pode demorar UM envio ao serviço de push antes de desistir (ms). */
const PUSH_SEND_TIMEOUT_MS = 10_000;

// How many sample payloads the dry-run prints.
const DRY_RUN_SAMPLE = 5;

// ---------------------------------------------------------------------------
// Payload mapping — mirrors supabase/functions/send-push/index.ts and the shape
// web/public/sw.js reads (title/body/url/icon/tag). Defensive: the fan-out
// payload schema isn't frozen, so probe several plausible keys and always fall
// back to something useful. Pure + exported so it is unit-testable offline.
// ---------------------------------------------------------------------------

/**
 * As frases da notificação, por língua.
 *
 * A app está inteiramente traduzida (web/lib/i18n/messages/), mas o servidor de
 * push não tem acesso a essa camada — vive noutro processo, sem React e sem o
 * cookie de idioma. Por isso as frases estão aqui, e a língua vem do perfil de
 * quem recebe (`profiles.locale`), que é lido por `loadLocales` e passado até
 * aqui. Sem perfil, ou com um idioma que não conheçamos, cai no inglês.
 *
 * Manter em sintonia com `web/lib/i18n/messages/notifications.ts` quando o texto
 * lá mudar: são as mesmas mensagens, uma para a caixa de entrada da app e outra
 * para a barra de notificações do sistema.
 */
const COPY = {
  en: {
    airingSoonTitle: 'Episode airing soon',
    airingSoonBodyN: (n) => `Episode ${n} airs soon.`,
    airingSoonBody: 'A new episode airs soon.',
    airedTitle: 'New episode',
    airedBody: 'A new episode is out. Catch it here.',
    delayedTitle: (t) => `${t}: delayed`,
    delayedTitleFallback: 'Episode delayed',
    delayedBodyN: (n) => `Episode ${n} was delayed.`,
    delayedBody: 'An episode was delayed.',
    newsTitle: (t) => `News about ${t}`,
    newsTitleFallback: 'News',
    newsBody: 'Tap to read more.',
    fallbackTitle: 'Nimu',
    fallbackBody: 'You have a new notification.',
  },
  pt: {
    airingSoonTitle: 'Estreia daqui a pouco',
    airingSoonBodyN: (n) => `O episódio ${n} estreia daqui a pouco.`,
    airingSoonBody: 'Está quase a sair um episódio novo.',
    airedTitle: 'Episódio novo',
    airedBody: 'Saiu um novo episódio. Acompanha aqui.',
    delayedTitle: (t) => `${t}: adiado`,
    delayedTitleFallback: 'Episódio adiado',
    delayedBodyN: (n) => `O episódio ${n} foi adiado.`,
    delayedBody: 'Um episódio foi adiado.',
    newsTitle: (t) => `Novidades sobre ${t}`,
    newsTitleFallback: 'Novidades',
    newsBody: 'Toca para ler.',
    fallbackTitle: 'Nimu',
    fallbackBody: 'Tens uma notificação nova.',
  },
};

/** A língua pedida, ou inglês se não a conhecermos. */
function copyFor(locale) {
  return COPY[locale] ?? COPY.en;
}

/**
 * @param {{ id: string, event_id: string|null, payload: unknown }} delivery
 * @param {string} siteUrl absolute origin, no trailing slash
 * @param {string} [locale] idioma de quem recebe ('pt' | 'en')
 * @returns {{ title: string, body: string, url: string, icon: string, tag: string }}
 */
export function buildPushPayload(delivery, siteUrl = SITE_URL, locale = 'en') {
  const c = copyFor(locale);
  const payload = isRecord(delivery.payload) ? delivery.payload : {};
  const type = payload.type;
  const kind = payload.kind;
  const animeTitle = firstString(payload, ['anime_title', 'title', 'animeTitle']);
  const episodeNumber = firstNumber(payload, ['episode_number', 'episodeNumber']);
  const summary = firstString(payload, ['summary', 'body', 'message']);
  const animeId = firstString(payload, ['anime_id', 'animeId']);

  let title;
  let body;

  switch (type) {
    case 'episode_airing':
      if (kind === 'upcoming') {
        // The 5-minutes-before heads-up (fan_out_episode_upcoming).
        title = animeTitle ?? c.airingSoonTitle;
        body =
          episodeNumber !== null ? c.airingSoonBodyN(episodeNumber) : c.airingSoonBody;
      } else {
        // SEM o numero do episodio, e de proposito. O dono foi direto: "o
        // numero do episodio nao diz nada a ninguem, quem e que vai saber qual
        // e o ep". Tem razao: "episodio 1175" nao situa ninguem, e ocupava o
        // lugar da unica coisa que importa, o nome da serie e o convite. O nome
        // vai no titulo (a negrito, e o que se le primeiro) e o corpo e so a
        // frase e o convite.
        title = animeTitle ?? c.airedTitle;
        body = c.airedBody;
      }
      break;
    case 'episode_delayed':
      title = animeTitle !== null ? c.delayedTitle(animeTitle) : c.delayedTitleFallback;
      body =
        episodeNumber !== null ? c.delayedBodyN(episodeNumber) : c.delayedBody;
      break;
    case 'news':
      title = animeTitle !== null ? c.newsTitle(animeTitle) : c.newsTitleFallback;
      body = summary ?? c.newsBody;
      break;
    default:
      title = c.fallbackTitle;
      body = summary ?? c.fallbackBody;
  }

  // O destino do toque: a FICHA da serie.
  //
  // O dono foi direto: "se saiu notificacao de One Piece que saiu agora, ao
  // clicar deveria ir para a ficha de One Piece".
  //
  // Uma versao anterior mandava para a pagina do episodio
  // (/anime/<id>/episodio/<n>), com o argumento de que uma ficha de mil linhas
  // e muito para quem foi avisado de UM episodio. Duas coisas mudaram isso:
  //
  //   1. O dono pediu a ficha, com todas as letras.
  //   2. A pagina de episodio esta fragil: medido a 2026-08-23, ate o episodio
  //      1 de uma serie a emitir devolve o estado de "nao encontrado". Mandar
  //      um toque de notificacao para uma pagina que mostra "nao encontrado" e
  //      pior do que o mandar para a ficha, que existe sempre e tem o episodio
  //      novo la em cima.
  //
  // O id vai em UUID e a rota responde 308 para o endereco com slug. Um salto a
  // mais num toque e invisivel, e a alternativa era pedir o slug a base no
  // momento do envio, o que poe uma consulta no caminho de cada push.
  //
  // Sem serie nenhuma (uma noticia global), cai-se no centro de notificacoes.
  const url =
    animeId === null
      ? `${siteUrl}/notifications`
      : `${siteUrl}/anime/${animeId}`;

  // O destino deixou de depender do numero, mas a ETIQUETA ainda depende: e ela
  // que faz o "ja saiu" substituir o "esta quase a sair" do mesmo episodio no
  // telemovel, em vez de os empilhar. Por isso continua a distinguir se ha um
  // numero de episodio valido.
  const temEpisodio =
    episodeNumber !== null && Number.isInteger(episodeNumber) && episodeNumber > 0;

  return {
    title,
    body,
    url,
    // PNG e nao SVG: o Chromium nao descodifica SVG em notificacoes
    // (crbug 478654), e o Android e a unica plataforma onde isso se ve.
    icon: `${siteUrl}/icons/icon-192.png`,
    // O icone pequeno da barra de estado do Android. Silhueta branca sobre
    // transparente, porque a plataforma mascara-o pelo alfa e ignora a cor.
    badge: `${siteUrl}/icons/badge-96.png`,
    // A etiqueta agrupa por EPISODIO, e nao por evento.
    //
    // Era o id do evento, ou seja uma etiqueta diferente para cada aviso. O
    // resultado, medido na auditoria: tres notificacoes sobre o MESMO episodio
    // empilhadas no telemovel com 3,7 segundos entre elas (o "esta quase a
    // sair", o "ja saiu", e um adiamento), porque o browser nao tinha como
    // saber que falavam da mesma coisa.
    //
    // Com `ep:<id>`, a mais recente SUBSTITUI a anterior. E o comportamento
    // certo: quem foi avisado de que o episodio estava quase a sair nao precisa
    // de ficar com esse aviso no ecra depois de ele ter saido.
    //
    // Sem episodio (uma noticia), volta-se ao id do evento: duas noticias
    // diferentes sobre a mesma serie sao duas coisas e devem aparecer as duas.
    tag:
      animeId !== null && temEpisodio
        ? `ep:${animeId}:${episodeNumber}`
        : (delivery.event_id ?? delivery.id),
  };
}

// ---------------------------------------------------------------------------
// Data access (service-role supabase client, imported lazily so this module can
// be imported for its pure helpers without Supabase env present)
// ---------------------------------------------------------------------------

async function getSupabase() {
  const { supabase } = await import('./supabase.js');
  return supabase;
}

async function loadPendingDeliveries(supabase, limit) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('notification_deliveries')
    .select('id, user_id, event_id, payload, attempts')
    .eq('channel', 'web_push')
    .eq('status', 'pending')
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`fetch web_push deliveries failed: ${error.message}`);
  return data ?? [];
}

async function countPendingDeliveries(supabase) {
  const nowIso = new Date().toISOString();
  const { count, error } = await supabase
    .from('notification_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'web_push')
    .eq('status', 'pending')
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`);
  if (error) throw new Error(`count web_push deliveries failed: ${error.message}`);
  return count ?? 0;
}

/**
 * O idioma de cada destinatário do lote, numa consulta só.
 *
 * Falha em silêncio: sem idioma, a notificação sai em inglês — nunca deixa de
 * sair. Uma notificação na língua errada é um defeito; uma notificação em falta
 * é a funcionalidade partida.
 */
async function loadLocales(supabase, userIds) {
  const out = new Map();
  if (userIds.length === 0) return out;
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, locale')
    .in('user_id', userIds);
  if (error) {
    console.warn(`[nimu] ⚠ could not read locales (falling back to English): ${error.message}`);
    return out;
  }
  for (const row of data ?? []) {
    if (typeof row.locale === 'string' && row.locale !== '') out.set(row.user_id, row.locale);
  }
  return out;
}

async function loadSubscriptions(supabase, userId) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, failure_count')
    .eq('user_id', userId);
  if (error) throw new Error(`load subscriptions failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Core: drain the outbox
// ---------------------------------------------------------------------------

async function processPendingDeliveries(supabase) {
  const deliveries = await loadPendingDeliveries(supabase, BATCH_SIZE);
  const summary = { processed: 0, sent: 0, failed: 0, pruned: 0, revoked: 0, adiadas: 0 };

  const userIds = [...new Set(deliveries.map((d) => d.user_id))];

  // Uma consulta para o lote inteiro, em vez de uma por notificação.
  const locales = await loadLocales(supabase, userIds);
  const { podem, silencio } = await loadConsent(supabase, userIds);
  const agora = new Date();

  for (const delivery of deliveries) {
    summary.processed += 1;

    // O CONSENTIMENTO É RELIDO AQUI, e não só quando o aviso foi criado.
    //
    // O fan-out decide quem recebe no instante em que o episódio sai, e o worker
    // esvazia a caixa até 37 minutos depois (mediana medida: 25,6). Entre uma
    // coisa e a outra a pessoa pode ter desligado o interruptor, ou corrigido o
    // ano de nascimento para um que a torna menor. Nada relia nenhuma das duas.
    //
    // Resultado, antes disto: quem desligava os avisos continuava a recebê-los
    // durante mais de meia hora, e o gatilho `profiles_reapply_minor_limits`
    // punha o canal a `false` sem impedir a entrega que já estava na fila. Um
    // menor recebia push com a base a dizer, nesse instante, que era menor. Não
    // é um caso de canto: é o que acontece a quem se engana no ano e corrige.
    //
    // A migração 20260823000000 escreveu esta defesa como `pode_receber_push` e
    // prometeu, no próprio cabeçalho, que "o fan-out passa a confirmar a idade
    // no momento do envio". Nunca foi ligada: a função existia e ninguém lhe
    // chamava, em lado nenhum do repositório. Isto é essa promessa, cumprida no
    // sítio onde ela morde de verdade, que é o último passo antes de sair.
    if (podem.get(delivery.user_id) === false) {
      await markFailed(supabase, delivery, 'consent_revoked');
      summary.failed += 1;
      summary.revoked += 1;
      continue;
    }

    // AS HORAS DE SILENCIO, cumpridas no momento do envio.
    //
    // A interface promete, nas Definicoes: "Pausa as notificacoes push durante
    // estas horas". Ate hoje nenhum worker as respeitava, e a promessa era
    // falsa. Aqui olha-se para a hora LOCAL da pessoa (no fuso dela) e, se cair
    // dentro do silencio dela, a entrega NAO se manda embora: adia-se ate a
    // manha, pondo-a de volta a `pending` com `scheduled_for` no fim do
    // silencio. O cron volta a apanha-la ai.
    //
    // Adiar, e nao descartar, e a diferenca entre "silencio" e "censura": a
    // pessoa pediu para nao ser incomodada de noite, nao para perder o aviso.
    const janela = silencio.get(delivery.user_id);
    if (
      janela !== undefined &&
      dentroDoSilencio(agora, janela.start, janela.end, janela.tz)
    ) {
      const fim = fimDoSilencio(agora, janela.end, janela.tz);
      await adiarEntrega(supabase, delivery, fim);
      summary.adiadas += 1;
      continue;
    }

    const result = await deliverOne(supabase, delivery, locales.get(delivery.user_id));
    summary.sent += result.sent ? 1 : 0;
    summary.failed += result.sent ? 0 : 1;
    summary.pruned += result.pruned;
  }
  return summary;
}

/**
 * Quem, NESTE momento, ainda pode receber push.
 *
 * Duas condições, e as duas têm de valer:
 *
 *  1. `channel_web_push` continua ligado. É o consentimento.
 *  2. A pessoa é maior. Ano ausente conta como menor, que é a mesma regra que os
 *     gatilhos já aplicam e está certa: sem idade não há como afirmar que é
 *     adulto, e a DSA põe o ónus do nosso lado.
 *
 * Uma consulta para o lote inteiro, e não uma por notificação: um lote são 100
 * entregas, e cem idas à base antes de cada envio transformavam uma defesa numa
 * penalização.
 *
 * ## Porque é aqui e não numa RPC
 *
 * A `pode_receber_push` da migração faz exactamente esta conta, mas por
 * utilizador e com um `revoke` que nem deixa o `service_role` chamá-la. Repetir
 * a regra em dois sítios seria pior. Aqui a leitura é directa às duas tabelas,
 * com a chave de serviço que o worker já usa, e faz-se uma vez por lote.
 *
 * ## Em caso de erro, deixa passar
 *
 * De propósito, e é a decisão difícil deste bloco. Se esta leitura falhar
 * (rede, tempo esgotado), o mapa vem vazio e nada é bloqueado. A alternativa,
 * bloquear tudo, transformava uma falha de leitura numa paragem silenciosa de
 * TODAS as notificações, que é o defeito de que o dono mais se queixou. O
 * interruptor no fan-out continua a ser a primeira defesa; esta é a segunda, e
 * uma segunda defesa que se avaria não pode derrubar a casa.
 */
export async function loadConsent(supabase, userIds) {
  const podem = new Map();
  const silencio = new Map();
  if (userIds.length === 0) return { podem, silencio };

  const anoAgora = new Date().getUTCFullYear();

  const [defs, perfis] = await Promise.all([
    supabase
      .from('notification_settings')
      .select(
        'user_id, channel_web_push, quiet_hours_start, quiet_hours_end, quiet_hours_tz',
      )
      .in('user_id', userIds),
    supabase.from('profiles').select('user_id, birth_year').in('user_id', userIds),
  ]);

  if (defs.error || perfis.error) {
    console.error(
      '[push] não foi possível reler o consentimento, o lote segue com a decisão do fan-out',
      defs.error?.message ?? perfis.error?.message,
    );
    return { podem, silencio };
  }

  const anos = new Map((perfis.data ?? []).map((p) => [p.user_id, p.birth_year]));

  for (const linha of defs.data ?? []) {
    const ano = anos.get(linha.user_id);
    const maior = typeof ano === 'number' && anoAgora - ano >= 18;
    podem.set(linha.user_id, linha.channel_web_push === true && maior);
    silencio.set(linha.user_id, {
      start: linha.quiet_hours_start,
      end: linha.quiet_hours_end,
      tz: linha.quiet_hours_tz,
    });
  }

  // Quem não tem linha de definições nenhuma nunca ligou o canal. Uma entrega
  // para essa pessoa não devia existir, e se existe é para não sair.
  for (const id of userIds) {
    if (!podem.has(id)) podem.set(id, false);
  }

  return { podem, silencio };
}

/**
 * Exportada SÓ para os testes (`test/push-sender-resiliencia.test.js`).
 *
 * O comportamento não muda: continua a ser chamada apenas por
 * `processPendingDeliveries`. Sem a exportação, a decisão entre "volta à fila"
 * e "desiste" só era observável em produção, que é onde ela custa caro. Ver o
 * cabeçalho do ficheiro de teste.
 */
export async function deliverOne(supabase, delivery, locale = 'en') {
  let subs;
  try {
    subs = await loadSubscriptions(supabase, delivery.user_id);
  } catch (err) {
    // Passageira, e nao terminal. Ler as subscricoes e uma consulta a base: se
    // ela falhar por um segundo de rede, a entrega tem de voltar a fila como
    // qualquer outra falha temporaria. Ficava em `failed` para sempre, e o
    // cabecalho deste ficheiro prometia o contrario desde o commit fc41a80.
    await markFailed(supabase, delivery, RETRIABLE_REASON, {
      detail: `load_subscriptions: ${err.message}`,
    });
    return { sent: false, pruned: 0 };
  }

  if (subs.length === 0) {
    // Channel on but no live device: terminal (so it isn't retried forever) and
    // the audit trail records why. The fan-out normally gates these out, but a
    // subscription can be pruned between fan-out and send — hence this guard.
    await markFailed(supabase, delivery, 'no_active_subscription');
    return { sent: false, pruned: 0 };
  }

  const message = JSON.stringify(buildPushPayload(delivery, SITE_URL, locale));

  let anySent = false;
  let pruned = 0;
  let liveFailures = 0;
  // Quantas subscrições recusaram a NOSSA assinatura, e não o aparelho delas.
  let denied = 0;
  // O MAIOR de todos: se um serviço pediu dez minutos e outro pediu um, esperar
  // um minuto voltava a bater no primeiro antes do tempo.
  let retryAfter = null;

  for (const sub of subs) {
    let veredito;
    try {
      veredito = await sendToSubscription(supabase, sub, message);
    } catch (error) {
      // A BELT, on top of the braces `sendToSubscription` already has.
      //
      // That function catches send errors and always returns a verdict, so in
      // principle nothing escapes it. In principle is the operative phrase: a
      // missing helper inside its own `catch` block (see `readStatusCode`) is
      // exactly the kind of thing that turns a handled failure into an
      // unhandled throw, and the cost of that is not one lost notification.
      //
      // It is the whole queue. The throw escapes the loop, escapes
      // `deliverOne`, escapes `processPendingDeliveries`, and kills the run.
      // The delivery is left `pending`, the cron picks up the same batch five
      // minutes later, and hits the same wall. One bad subscription silences
      // push for every user, on every platform, until someone notices.
      //
      // One device failing must never be able to do that.
      console.error(
        '[push] unexpected error while sending',
        sub.id,
        // `?.message ?? error` and not `error.message`: a `throw 'string'` would
        // otherwise make this very handler throw.
        error?.message ?? error,
      );
      veredito = { outcome: 'failed', retryAfter: null };
    }
    if (veredito.retryAfter !== null) {
      retryAfter = retryAfter === null ? veredito.retryAfter : Math.max(retryAfter, veredito.retryAfter);
    }
    if (veredito.outcome === 'sent') anySent = true;
    else if (veredito.outcome === 'gone') pruned += 1;
    else if (veredito.outcome === 'denied') denied += 1;
    else liveFailures += 1;
  }

  if (anySent) {
    await markSent(supabase, delivery);
    return { sent: true, pruned };
  }

  // TRÊS motivos, e nenhum deles é intercambiável.
  //
  // `vapid_rejected` é terminal, e é a novidade: tentar outra vez não muda a
  // chave. Antes, um 403 caía no ramo genérico e gastava as cinco tentativas
  // contra uma parede, deixando quatro linhas de ruído a esconder a primeira.
  //
  // `all_subscriptions_expired` é terminal pela razão de sempre: não há para
  // onde enviar, e voltar a tentar daqui a cinco minutos não faz aparecer um
  // aparelho novo.
  //
  // A ordem importa. O 403 só decide quando NADA mais falhou por outra via: com
  // um aparelho a dar 403 e outro a dar 500, o 500 merece a retentativa, e
  // desistir dos dois por causa do primeiro perdia a notificação de quem podia
  // tê-la recebido.
  const reason =
    liveFailures === 0 && denied > 0
      ? 'vapid_rejected'
      : liveFailures === 0
        ? 'all_subscriptions_expired'
        : RETRIABLE_REASON;
  await markFailed(supabase, delivery, reason, { retryAfter });
  return { sent: false, pruned };
}

/**
 * SSRF guard for a push endpoint (defence in depth).
 *
 * The endpoint is attacker-influenced data: any authenticated user can register
 * an arbitrary `push_subscriptions.endpoint` via `register_push_subscription`,
 * whose only check is `^https?://`. This worker then POSTs to that URL. Real
 * browser push services are ALL public HTTPS hostnames (fcm.googleapis.com,
 * updates.push.services.mozilla.com, web.push.apple.com, *.notify.windows.com),
 * so we can safely refuse two things a legitimate endpoint is never:
 *
 *   1. a non-`https:` scheme (blocks `http://` loopback/plaintext), and
 *   2. an IP-literal host or localhost (blocks pointing the request straight at
 *      127.0.0.1, 169.254.169.254, 10.x, ::1, fc00::/7, …).
 *
 * This closes the "register an endpoint aimed at an internal address and make
 * the CI worker fetch it" vector. It does NOT resolve DNS, so a public name
 * pointing at a private IP (rebinding) is out of scope — proportionate, since
 * the body is encrypted, no response is returned to the attacker, and this runs
 * in an ephemeral CI runner. Pure + exported so it is unit-testable offline.
 *
 * @param {string} endpoint
 * @returns {boolean} true when the endpoint is safe to send to.
 */
export function isSafePushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint === '') return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  // `URL` strips the brackets from an IPv6 literal; a bracketed host is always
  // an IP literal. Refuse it, and any IPv4 literal, and localhost — no real
  // push service is ever addressed this way.
  let host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const isIpv6Literal = endpoint.includes('[') || host.includes(':');
  if (isIpv6Literal) return false;
  const isIpv4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIpv4Literal) return false;

  // LISTA FECHADA dos serviços de push reais (auditoria de 2026-09-24).
  //
  // Recusar IPs e localhost não chegava: qualquer DOMÍNIO passava, e um nome
  // como `169.254.169.254.nip.io` resolve para o endereço de metadados da
  // nuvem. Uma conta qualquer podia registar esse "aparelho" e pôr este worker
  // a fazer pedidos por ela (SSRF). Os browsers só usam estes serviços:
  // Chrome/Edge Android/Opera/Samsung (FCM), Firefox (Mozilla), Safari e iOS
  // (Apple), Edge no Windows (WNS).
  return PUSH_SERVICE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Ver `isSafePushEndpoint`. Espelhado em web/lib/notifications/push-hosts.ts. */
export const PUSH_SERVICE_DOMAINS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

/**
 * Send to one subscription. Returns { outcome, retryAfter }, where outcome is
 * 'sent', 'gone' (pruned) or 'failed', and retryAfter are the seconds the push
 * service asked us to wait, when it asked.
 *
 * Exported for the tests, which is not ceremony: the `catch` in here is the
 * branch that shipped broken (see `readStatusCode`) precisely because nothing
 * exercised it. A 410 is the NORMAL end of a subscription's life, not an edge
 * case, and it now has a test.
 */
export async function sendToSubscription(supabase, sub, message) {
  // Refuse to fetch an endpoint aimed at an internal/loopback address before we
  // ever make the request (see isSafePushEndpoint). Keep the row but count the
  // failure, like any other non-terminal delivery error.
  if (!isSafePushEndpoint(sub.endpoint)) {
    const { error: incError } = await supabase
      .from('push_subscriptions')
      .update({ failure_count: (sub.failure_count ?? 0) + 1 })
      .eq('id', sub.id);
    if (incError) console.error('[push] failure_count bump failed', sub.id, incError.message);
    console.error('[push] refused unsafe endpoint (SSRF guard)');
    return { outcome: 'failed', retryAfter: null };
  }

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      message,
      {
        TTL: PUSH_TTL_SECONDS,
        // Teto de tempo por envio (auditoria de segurança de 2026-10, F11). Sem
        // ele, um serviço de push que pendurasse a ligação parava o worker para
        // toda a gente, porque os envios esperam uns pelos outros.
        timeout: PUSH_SEND_TIMEOUT_MS,
        // `high` e nao a omissao `normal`.
        //
        // No Android, o Doze mode adia as mensagens de urgencia normal ate a
        // proxima janela de manutencao, que pode ser HORAS depois. Para um aviso
        // com hora marcada isso e o mesmo que nao o mandar: chega quando ja nao
        // interessa.
        //
        // Nao ha aqui abuso de prioridade. Tudo o que este worker envia e um
        // episodio a estrear ou acabado de estrear, ou seja exatamente a classe
        // de mensagem para que o `high` existe na especificacao.
        urgency: 'high',
      },
    );
    return { outcome: 'sent', retryAfter: null };
  } catch (error) {
    const statusCode = readStatusCode(error);
    // 404 (endpoint unknown) / 410 (subscription gone) => device is dead. Prune
    // it so we stop trying and keep the table free of stale personal data.
    if (statusCode === 404 || statusCode === 410) {
      const { error: delError } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('id', sub.id);
      if (delError) console.error('[push] prune failed', sub.id, delError.message);
      return { outcome: 'gone', retryAfter: null };
    }
    // 403 = a ASSINATURA foi recusada, e isso nunca e culpa do aparelho.
    //
    // O caminho que leva aqui: a `NEXT_PUBLIC_VAPID_PUBLIC_KEY` que a app usa
    // para criar subscricoes deixa de bater certo com a `VAPID_PUBLIC_KEY` com
    // que este worker assina. Uma rotacao feita so num dos lados chega.
    //
    // O que torna isto insidioso e tudo o resto continuar a parecer bem. O
    // `subscribe()` no browser passa. A linha grava. O cartao nas Definicoes diz
    // "ligado". E cada envio morre em 403, que nao e 404 nem 410, portanto a
    // subscricao nao e podada, e e tratado como passageiro, portanto gasta as
    // cinco tentativas e acaba em `failed`. Repete-se por cada notificacao,
    // indefinidamente, sem sinal nenhum em lado nenhum.
    //
    // Tentar outra vez nao ajuda: a chave nao muda entre tentativas. O que
    // ajuda e o registo dizer o que se passa, em vez de "send failed 403" ao
    // lado de mais duzentos.
    if (statusCode === 403) {
      console.error(
        '[push] 403: a assinatura VAPID foi recusada. NAO e o aparelho. ' +
          'A NEXT_PUBLIC_VAPID_PUBLIC_KEY da app e a VAPID_PUBLIC_KEY deste ' +
          'worker tem de ser A MESMA chave. Enquanto discordarem, TODAS as ' +
          'notificacoes falham e a interface continua a dizer "ligado".',
      );
      const { error: incError } = await supabase
        .from('push_subscriptions')
        .update({ failure_count: (sub.failure_count ?? 0) + 1 })
        .eq('id', sub.id);
      if (incError) console.error('[push] failure_count bump failed', sub.id, incError.message);
      // `denied` e nao `failed`: quem chama transforma isto numa falha TERMINAL,
      // porque cinco tentativas contra uma chave errada sao cinco tentativas
      // desperdicadas e mais quatro linhas de ruido a esconder a primeira.
      return { outcome: 'denied', retryAfter: null };
    }
    // Any other error (network, 5xx, 429, …): keep the subscription but count the
    // failure, so persistently-broken endpoints are visible / prunable later.
    const { error: incError } = await supabase
      .from('push_subscriptions')
      .update({ failure_count: (sub.failure_count ?? 0) + 1 })
      .eq('id', sub.id);
    if (incError) console.error('[push] failure_count bump failed', sub.id, incError.message);
    console.error('[push] send failed', statusCode ?? '(no status)');
    return { outcome: 'failed', retryAfter: readRetryAfter(error) };
  }
}

// ---------------------------------------------------------------------------
// Delivery status writes (guarded by status='pending' — idempotent)
// ---------------------------------------------------------------------------

async function markSent(supabase, delivery) {
  const { error } = await supabase
    .from('notification_deliveries')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      attempts: (delivery.attempts ?? 0) + 1,
      error: null,
    })
    .eq('id', delivery.id)
    .eq('status', 'pending');
  if (error) console.error('[push] markSent failed', delivery.id, error.message);
}

/**
 * Uma falha PASSAGEIRA volta para a fila, com recuo. Uma definitiva desiste.
 *
 * ## O que estava a acontecer
 *
 * Não havia retentativa nenhuma. `markFailed` punha `status = 'failed'`,
 * `loadPendingDeliveries` só apanha `'pending'`, e nada em todo o repositório
 * devolvia uma linha a `'pending'`. O `attempts` nunca passava de 1, apesar de
 * o comentário do enum na migração 20260730001200 prometer retentativa.
 *
 * Na prática: uma falha de rede de um segundo, ou um 503 do FCM enquanto eles
 * reiniciavam um servidor, e aquele aviso ficava perdido para sempre. Sem
 * ninguém dar por isso, porque `failed` é um estado terminal que ninguém lê.
 *
 * Pior: o 429 do FCM quer dizer "abranda, volta daqui a X segundos", e era
 * tratado como falha definitiva.
 *
 * ## O recuo
 *
 * Exponencial a partir dos cinco minutos, que é o intervalo do cron: recuar
 * menos do que isso não adianta nada, porque a corrida seguinte só acontece daí
 * a cinco minutos de qualquer maneira. Teto de seis horas, que é o mesmo TTL do
 * push: passado isso a mensagem já foi deitada fora pelo serviço e insistir é
 * gastar pedidos.
 *
 * Quando o serviço diz de quanto tempo precisa (`Retry-After`), é esse que
 * manda. Ele sabe melhor do que nós.
 *
 * Cinco tentativas. À quinta, um endpoint que continua a recusar não é uma
 * falha passageira, é um endpoint avariado.
 *
 * Não precisa de migração: `loadPendingDeliveries` já filtra por
 * `scheduled_for.lte.now` e a migração já indexa `(scheduled_for) where status
 * = 'pending'`.
 */
/**
 * O motivo que marca uma falha como PASSAGEIRA.
 *
 * Uma constante e nao uma string escrita em cada sitio: o `markFailed` decide
 * se volta a tentar comparando o motivo, e um sitio que escrevesse a palavra
 * com outra grafia ficava terminal em silencio. Foi exatamente isso que
 * aconteceu com o `load_subscriptions`, que trazia a mensagem do erro colada ao
 * motivo e por isso nunca batia certo com a comparacao.
 */
export const RETRIABLE_REASON = 'delivery_failed';

// Exportadas para os testes poderem afirmar o TETO em vez de o copiarem. Um
// teste que escreva o número à mão deixa de proteger no dia em que alguém mude
// a constante, porque passa a validar o valor antigo.
export const RETRY_MIN_SECONDS = 5 * 60;
export const RETRY_MAX_SECONDS = 6 * 60 * 60;
export const MAX_ATTEMPTS = 5;

/** Os segundos que o serviço pediu. Aceita segundos ou data HTTP (RFC 9110). */
export function readRetryAfter(error) {
  const headers = isRecord(error) && isRecord(error.headers) ? error.headers : null;
  if (headers === null) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return null;

  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.round(asSeconds);

  const asDate = Date.parse(String(raw));
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, Math.round((asDate - Date.now()) / 1000));
}

/** Quando voltar a tentar, em segundos. */
export function backoffSeconds(attempts, retryAfter) {
  // O que o serviço pediu ganha, preso ao nosso teto para um `Retry-After`
  // absurdo não parquear a entrega durante uma semana.
  if (retryAfter !== null) {
    return Math.min(Math.max(retryAfter, RETRY_MIN_SECONDS), RETRY_MAX_SECONDS);
  }
  return Math.min(RETRY_MIN_SECONDS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_SECONDS);
}

/**
 * Adia uma entrega para depois do silencio, sem a marcar como falhada.
 *
 * Fica em `pending` com o `scheduled_for` no fim do silencio, que e a unica
 * coisa que a faz voltar a ser lida (o `loadPendingDeliveries` so apanha
 * `pending` com o `scheduled_for` ja vencido ou nulo). Nao mexe em `attempts`:
 * ser adiada por escolha da pessoa nao e uma tentativa gasta, e nao deve
 * aproximar a entrega do tecto de desistencia.
 */
export async function adiarEntrega(supabase, delivery, scheduledFor) {
  const { error } = await supabase
    .from('notification_deliveries')
    .update({ status: 'pending', scheduled_for: scheduledFor.toISOString() })
    .eq('id', delivery.id)
    .eq('status', 'pending');
  if (error) console.error('[push] adiarEntrega falhou', delivery.id, error.message);
}

export async function markFailed(supabase, delivery, reason, { retryAfter = null, detail = null } = {}) {
  const attempts = (delivery.attempts ?? 0) + 1;
  // Uma falha de rede, um 5xx ou um 429 são passageiros. Uma subscrição morta
  // ou uma que expirou não são, e essas já vêm com `reason` terminal.
  //
  // A comparação é com a CONSTANTE, e o texto livre vai no `detail`. Colar a
  // mensagem do erro ao motivo (como o `load_subscriptions` fazia) tornava a
  // falha terminal sem ninguém escrever isso em lado nenhum.
  const passageira = reason === RETRIABLE_REASON && attempts < MAX_ATTEMPTS;
  const texto = detail === null ? reason : `${reason} (${detail})`;

  const patch = passageira
    ? {
        // Fica em `pending`, que é a única coisa que a faz voltar a ser lida.
        status: 'pending',
        attempts,
        error: `${texto} (tentativa ${attempts} de ${MAX_ATTEMPTS})`,
        scheduled_for: new Date(
          Date.now() + backoffSeconds(attempts, retryAfter) * 1000,
        ).toISOString(),
      }
    : { status: 'failed', attempts, error: texto };

  const { error } = await supabase
    .from('notification_deliveries')
    .update(patch)
    .eq('id', delivery.id)
    .eq('status', 'pending');
  if (error) console.error('[push] markFailed failed', delivery.id, error.message);
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

// Representative fan-out payloads, one per notification kind, for the OFFLINE
// dry-run demo (used when Supabase env is absent — e.g. a local checkout). Shows
// exactly what buildPushPayload would produce for each event type.
const OFFLINE_SAMPLES = [
  { id: 'demo-1', event_id: 'evt-1', payload: { type: 'episode_airing', anime_title: 'Frieren', episode_number: 12, anime_id: 'anime-uuid-1' } },
  { id: 'demo-2', event_id: 'evt-2', payload: { type: 'episode_airing', kind: 'upcoming', anime_title: 'Frieren', episode_number: 13, anime_id: 'anime-uuid-1' } },
  { id: 'demo-3', event_id: 'evt-3', payload: { type: 'episode_delayed', anime_title: 'One Piece', episode_number: 1122, anime_id: 'anime-uuid-2' } },
  { id: 'demo-4', event_id: 'evt-4', payload: { type: 'news', anime_title: 'Chainsaw Man', summary: 'Part 2 announced.', anime_id: 'anime-uuid-3' } },
  { id: 'demo-5', event_id: 'evt-5', payload: {} },
];

function printSamplePayloads(deliveries) {
  for (const d of deliveries.slice(0, DRY_RUN_SAMPLE)) {
    console.log(`  • delivery ${d.id} →`, JSON.stringify(buildPushPayload(d)));
  }
}

async function runDryRun() {
  console.log('[push] DRY RUN — no push sent, no rows marked.');
  console.log(`[push] site origin for links/icon: ${SITE_URL}`);
  console.log(
    `[push] VAPID keys present: ${
      config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject ? 'yes' : 'no (not needed for a dry-run)'
    }`,
  );

  const haveSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
  if (!haveSupabase) {
    console.log(
      '[push] Supabase env not set (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — ' +
        'cannot query the outbox here. Showing OFFLINE payload demo instead:',
    );
    printSamplePayloads(OFFLINE_SAMPLES);
    console.log('[push] ✅ Dry run OK (offline) — payload mapping exercised, nothing queried or sent.');
    return;
  }

  const supabase = await getSupabase();
  const total = await countPendingDeliveries(supabase);
  console.log(`[push] pending web_push deliveries due now: ${total}`);
  const batch = await loadPendingDeliveries(supabase, Math.min(BATCH_SIZE, DRY_RUN_SAMPLE));
  if (batch.length === 0) {
    console.log('[push] nothing due — no sample payloads to show.');
  } else {
    console.log(`[push] sample of up to ${DRY_RUN_SAMPLE} payload(s) it would send:`);
    printSamplePayloads(batch);
  }
  console.log(
    `[push] ✅ Dry run OK — would process up to ${Math.min(total, BATCH_SIZE)} row(s) ` +
      `(BATCH_SIZE=${BATCH_SIZE}). Nothing sent, nothing marked.`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Uma passagem pela fila, e devolve o resumo.
 *
 * Exportada para a Edge Function `supabase/functions/push-worker`, que corre
 * ESTE MESMO ficheiro dentro da Supabase, chamada pelo pg_cron a cada minuto.
 * Até 2026-09-22 o envio só corria no GitHub Actions, cujo cron "de 5 em 5
 * minutos" era executado de 2 em 2 a 5 em 5 horas: um aviso de "vai sair"
 * chegava depois de o episódio ter saído. Um só worker, dois sítios de onde
 * se chama, para não voltar a haver duas versões a divergir.
 */
export async function runOnce() {
  assertPushConfig();
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  const supabase = await getSupabase();
  return processPendingDeliveries(supabase);
}

async function main() {
  const startedAt = Date.now();

  if (DRY_RUN) {
    await runDryRun();
    return;
  }

  const summary = await runOnce();
  console.log(
    `[push] ✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `processed ${summary.processed}, sent ${summary.sent}, failed ${summary.failed}, ` +
      `pruned ${summary.pruned}, revoked ${summary.revoked}, adiadas ${summary.adiadas}`,
  );
}

// ---------------------------------------------------------------------------
// Small helpers (shared shape with the Edge Function / notification-copy.ts)
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status of a `web-push` rejection, when there is one.
 *
 * ## Why this comment is longer than the function
 *
 * Because this function did not exist, and `sendToSubscription` called it. The
 * `catch` block is only reached when a push endpoint answers with something
 * other than 2xx — which had never happened here (49 sent, 0 failed) — so the
 * `ReferenceError` sat there, armed and invisible, for as long as every device
 * stayed alive.
 *
 * What it would have done the first time a subscription expired: the throw
 * escapes `sendToSubscription`, escapes the subscription loop (which has no
 * `try`), escapes `deliverOne` and `processPendingDeliveries`, and lands on
 * `main().catch`. The run dies. The delivery is still `pending`, so the
 * five-minute cron picks up THE SAME BATCH, hits THE SAME dead endpoint, and
 * dies again. Nobody gets a push after that, on any platform, until someone
 * deletes the row by hand.
 *
 * Android is what makes this urgent rather than theoretical: subscriptions
 * there expire on a schedule of their own (uninstalling the PWA, clearing
 * Chrome's data, Play Services rotating the token), and a 410 is the normal
 * end of a subscription's life, not an exception.
 *
 * The twin in `supabase/functions/send-push/index.ts` has always had it. This
 * is the same shape, deliberately, so the two stay comparable.
 */
function readStatusCode(error) {
  return isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : null;
}

function firstString(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function firstNumber(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function clampInt(raw, fallback, min, max) {
  const n = raw !== undefined && raw !== null ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Only run main() when invoked as a script, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[push] ❌ Web push send failed:', error.message);
    process.exitCode = 1;
  });
}
