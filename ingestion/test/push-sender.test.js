import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPushPayload, isSafePushEndpoint } from '../src/push-sender.js';

// O dominio do produto. Era 'https://nimu.app', que nao e nosso: um teste que
// consagra o dominio errado nao protege contra o enviar para la, valida-o.
const SITE = 'https://www.nimuhome.com';

test('episode_airing (after airing) → nome no titulo, SEM numero, convite, FICHA', () => {
  const p = buildPushPayload(
    { id: 'd1', event_id: 'e1', payload: { type: 'episode_airing', anime_title: 'Frieren', episode_number: 12, anime_id: 'a1' } },
    SITE,
  );
  assert.equal(p.title, 'Frieren');
  // SEM o numero do episodio no corpo. O dono foi direto: "o numero nao diz
  // nada a ninguem, quem e que vai saber qual e o ep". A palavra "episodio"
  // fica ("saiu um novo episodio"), o que sai e o NUMERO. O nome vai no titulo.
  assert.doesNotMatch(p.body, /\d/, 'nenhum digito no corpo: o numero do episodio saiu');
  assert.match(p.body, /new episode is out/, 'a frase, sem numero');
  // O CONVITE, que o dono pediu: a notificacao nao anuncia so, chama.
  assert.match(p.body, /Catch it here/);
  // O toque abre a FICHA da serie, nao a pagina do episodio. O dono pediu a
  // ficha, e a pagina de episodio estava a devolver "nao encontrado" ate para
  // o episodio 1 (medido a 2026-08-23). Ver o comentario no push-sender.js.
  assert.equal(p.url, `${SITE}/anime/a1`);
  // PNG e nao SVG, e com badge proprio. O Chromium nao descodifica SVG em
  // notificacoes (crbug 478654): no Android a notificacao vinha sem logotipo e
  // com o icone do Chrome na barra de estado. O badge tem de ser um ficheiro a
  // parte porque o Android reduz-o ao canal alfa e pinta-o a branco, portanto o
  // icon-192, que tem alfa cheio, daria uma mancha branca solida.
  assert.equal(p.icon, `${SITE}/icons/icon-192.png`);
  assert.equal(p.badge, `${SITE}/icons/badge-96.png`);
  assert.ok(!JSON.stringify(p).includes(".svg"), "nada de SVG no payload de push");
  // A etiqueta agrupa por EPISODIO: um aviso novo sobre o mesmo episodio
  // SUBSTITUI o anterior no telemovel, em vez de empilhar tres.
  assert.equal(p.tag, 'ep:a1:12');
});

test('episode_airing kind=upcoming → "airs soon" copy', () => {
  const p = buildPushPayload(
    { id: 'd2', event_id: 'e2', payload: { type: 'episode_airing', kind: 'upcoming', anime_title: 'Frieren', episode_number: 13, anime_id: 'a1' } },
    SITE,
  );
  assert.match(p.body, /airs soon/i);
  assert.match(p.body, /13/);
});

test('episode_delayed → delayed copy + deep link', () => {
  const p = buildPushPayload(
    { id: 'd3', event_id: 'e3', payload: { type: 'episode_delayed', anime_title: 'One Piece', episode_number: 1122, anime_id: 'a2' } },
    SITE,
  );
  assert.match(p.title, /One Piece/);
  assert.match(p.title, /delayed/i);
  assert.match(p.body, /1122/);
  // A ficha da serie, como todos os toques com serie identificada.
  assert.equal(p.url, `${SITE}/anime/a2`);
});

test('sem numero de episodio → cai na ficha da serie', () => {
  const p = buildPushPayload(
    { id: 'd7', event_id: 'e7', payload: { type: 'episode_airing', anime_title: 'Frieren', anime_id: 'a1' } },
    SITE,
  );
  assert.equal(p.url, `${SITE}/anime/a1`);
});

test('numero de episodio invalido → cai na ficha, nunca /episodio/0 nem /episodio/NaN', () => {
  for (const mau of [0, -3, 2.5, 'doze', null]) {
    const p = buildPushPayload(
      { id: 'd8', event_id: 'e8', payload: { type: 'episode_airing', anime_id: 'a1', episode_number: mau } },
      SITE,
    );
    assert.equal(p.url, `${SITE}/anime/a1`, String(mau));
  }
});

test('news → summary body', () => {
  const p = buildPushPayload(
    { id: 'd4', event_id: 'e4', payload: { type: 'news', anime_title: 'Chainsaw Man', summary: 'Part 2 announced.', anime_id: 'a3' } },
    SITE,
  );
  assert.match(p.title, /Chainsaw Man/);
  assert.equal(p.body, 'Part 2 announced.');
});

test('missing anime_id → notifications fallback URL', () => {
  const p = buildPushPayload({ id: 'd5', event_id: null, payload: { type: 'episode_airing' } }, SITE);
  assert.equal(p.url, `${SITE}/notifications`);
  assert.equal(p.tag, 'd5'); // falls back to delivery id when no event id
});

test('empty / unknown payload → safe generic fallback, never "undefined"', () => {
  for (const payload of [{}, null, undefined, { type: 'something_else' }]) {
    const p = buildPushPayload({ id: 'dx', event_id: 'ex', payload }, SITE);
    assert.equal(p.title, 'Nimu');
    assert.ok(p.body.length > 0);
    assert.ok(!/undefined/.test(`${p.title} ${p.body} ${p.url}`));
  }
});

test('isSafePushEndpoint: accepts the real push-service hosts', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAA',
    'https://web.push.apple.com/QABC',
    'https://par02p.notify.windows.com/w/?token=xyz',
    'https://wns2-par02p.notify.windows.com/w/?token=xyz',
    'https://android.googleapis.com/gcm/send/abc',
  ]) {
    assert.equal(isSafePushEndpoint(ok), true, ok);
  }
});

test('isSafePushEndpoint: refuses non-https, IP literals and localhost (SSRF guard)', () => {
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc', // plaintext
    'https://127.0.0.1/x', // loopback v4
    'https://169.254.169.254/latest/meta-data/', // link-local (metadata)
    'https://10.0.0.5/internal',
    'https://192.168.1.10/x',
    'https://[::1]/x', // loopback v6
    'https://[fd00::1]/x', // ULA v6
    'https://localhost/x',
    'https://api.internal.localhost/x',
    'ftp://fcm.googleapis.com/x',
    'not-a-url',
    '',
    // Domínios que não são serviços de push: o SSRF por nome, que a versão
    // anterior deixava passar.
    'https://169.254.169.254.nip.io/latest/meta-data/',
    'https://attacker.example.com/collect',
    'https://fcm.googleapis.com.evil.com/x',
    'https://evilfcm.googleapis.com.attacker.net/x',
  ]) {
    assert.equal(isSafePushEndpoint(bad), false, bad);
  }
});

test('trailing slash on site origin is normalised by the caller default', () => {
  // buildPushPayload takes an already-normalised origin; verify it does not add
  // a double slash when given a clean origin.
  const p = buildPushPayload({ id: 'd6', event_id: 'e6', payload: { type: 'news', anime_id: 'a9' } }, SITE);
  assert.equal(p.url, `${SITE}/anime/a9`);
  assert.ok(!p.url.includes('//anime'));
});

test('notícia sobre uma série agrupa pelo evento, não pelo episódio', () => {
  // Duas notícias diferentes sobre a mesma série são duas coisas, e devem
  // aparecer as duas. Só os avisos sobre o MESMO episódio é que se substituem.
  const a = buildPushPayload(
    { id: 'd9', event_id: 'e9', payload: { type: 'news', anime_id: 'a1', summary: 'Uma.' } },
    SITE,
  );
  const b = buildPushPayload(
    { id: 'd10', event_id: 'e10', payload: { type: 'news', anime_id: 'a1', summary: 'Outra.' } },
    SITE,
  );
  assert.equal(a.tag, 'e9');
  assert.notEqual(a.tag, b.tag);
});

test('avisos diferentes sobre o mesmo episódio partilham a etiqueta', () => {
  const antes = buildPushPayload(
    { id: 'd11', event_id: 'e11', payload: { type: 'episode_airing', kind: 'upcoming', anime_id: 'a1', episode_number: 12 } },
    SITE,
  );
  const depois = buildPushPayload(
    { id: 'd12', event_id: 'e12', payload: { type: 'episode_airing', anime_id: 'a1', episode_number: 12 } },
    SITE,
  );
  assert.equal(antes.tag, depois.tag);
  assert.equal(antes.tag, 'ep:a1:12');
});
