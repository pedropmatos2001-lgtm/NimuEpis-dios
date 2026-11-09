// =============================================================================
// Nimu — diagnóstico das notificações (SÓ LEITURA, SÓ TOTAIS)
// =============================================================================
// Corre no GitHub (workflow diagnostico.yml), porque a chave de serviço só vive
// lá. Não escreve nada e não imprime nenhum email, id de utilizador, endpoint ou
// texto de notificação: só contagens e datas, para se poder dizer com números se
// a cadeia inteira (fan-out -> fila -> envio -> aparelho) está a funcionar.
// =============================================================================

import { supabase } from './supabase.js';

const PAGE = 1000;
const agora = Date.now();
const dias = (n) => new Date(agora - n * 86400000).toISOString();

/** Todas as linhas (paginado: a PostgREST corta às 1000 em silêncio). */
async function todas(tabela, colunas, filtro = (q) => q) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filtro(supabase.from(tabela).select(colunas)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

function contar(linhas, chave) {
  const m = new Map();
  for (const l of linhas) {
    const k = typeof chave === 'function' ? chave(l) : l[chave];
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

const [subs, defs, perfis, eventos, entregas] = await Promise.all([
  todas('push_subscriptions', 'user_id, platform, failure_count, last_seen_at, created_at, endpoint'),
  todas('notification_settings', 'user_id, channel_in_app, channel_web_push, quiet_hours_start'),
  todas('profiles', 'user_id, birth_year'),
  todas('notification_events', 'type, created_at', (q) => q.gte('created_at', dias(14))),
  todas('notification_deliveries', 'user_id, channel, status, attempts, error, scheduled_for, created_at, sent_at', (q) =>
    q.gte('created_at', dias(14)),
  ),
]);

const ano = new Date().getUTCFullYear();
const idade = new Map(perfis.map((p) => [p.user_id, p.birth_year]));
const comSub = new Set(subs.map((s) => s.user_id));
const canalPush = defs.filter((d) => d.channel_web_push);

console.log('\n=== Utilizadores');
console.log('perfis:', perfis.length, '| com definições de notificação:', defs.length);
console.log('sem ano de nascimento (push bloqueado):', perfis.filter((p) => p.birth_year == null).length);
console.log('menores (push bloqueado):', perfis.filter((p) => p.birth_year != null && ano - p.birth_year < 18).length);

console.log('\n=== Push');
console.log('canal web push LIGADO:', canalPush.length);
console.log('  ... desses, com aparelho registado:', canalPush.filter((d) => comSub.has(d.user_id)).length);
console.log('  ... desses, SEM aparelho (não recebem nada):', canalPush.filter((d) => !comSub.has(d.user_id)).length);
console.log('  ... desses, sem idade válida:', canalPush.filter((d) => { const a = idade.get(d.user_id); return a == null || ano - a < 18; }).length);
console.log('aparelho registado mas canal DESLIGADO:', [...comSub].filter((u) => !defs.find((d) => d.user_id === u)?.channel_web_push).length);
console.log('subscrições:', subs.length, contar(subs, 'platform'));
console.log('  com falhas acumuladas (failure_count>0):', subs.filter((s) => s.failure_count > 0).length);
console.log('  criadas nos últimos 7 dias:', subs.filter((s) => s.created_at >= dias(7)).length);
// Por serviço de push, só o domínio (nunca o endereço, que é um segredo do
// aparelho), e quantas a migração 20260924000000 apagaria.
const PERMITIDOS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:443)?\//i;
const servico = (e) => {
  try {
    return new URL(e).hostname.split('.').slice(-3).join('.');
  } catch {
    return '(inválido)';
  }
};
console.log('  por serviço:', contar(subs, (s) => servico(s.endpoint)));
console.log('  fora da lista (a migração apagaria):', subs.filter((s) => !PERMITIDOS.test(s.endpoint ?? '')).length);
console.log('  utilizadores com mais de 10 aparelhos:', Object.values(contar(subs, 'user_id')).filter((n) => n > 10).length);

console.log('\n=== Eventos (14 dias)');
console.log(contar(eventos, 'type'));
console.log('por dia:', contar(eventos, (e) => e.created_at.slice(0, 10)));

console.log('\n=== Entregas (14 dias)');
console.log('por canal/estado:', contar(entregas, (e) => `${e.channel}:${e.status}`));
const push = entregas.filter((e) => e.channel === 'web_push');
console.log('web_push por dia (criadas):', contar(push, (e) => e.created_at.slice(0, 10)));
console.log('web_push, motivos de falha:', contar(push.filter((e) => e.status === 'failed'), (e) => String(e.error ?? '').slice(0, 60)));
const enviadas = push.filter((e) => e.sent_at);
const atrasos = enviadas.map((e) => (new Date(e.sent_at) - new Date(e.scheduled_for ?? e.created_at)) / 60000).sort((a, b) => a - b);
if (atrasos.length > 0) {
  const q = (p) => Math.round(atrasos[Math.min(atrasos.length - 1, Math.floor(p * atrasos.length))]);
  console.log(`atraso até ao envio (min): mediana ${q(0.5)}, p90 ${q(0.9)}, máx ${q(0.999)} (n=${atrasos.length})`);
}
const pend = push.filter((e) => e.status === 'pending');
console.log('web_push pendentes agora:', pend.length);

// Utilizadores que receberam in_app mas não web_push, tendo o canal ligado:
// é o sintoma de "o sino tem avisos e o telemóvel não toca".
const inApp = new Set(entregas.filter((e) => e.channel === 'in_app').map((e) => e.user_id));
const pushU = new Set(push.map((e) => e.user_id));
console.log(
  '\ncanal push ligado, com avisos in-app, mas sem nenhuma entrega push em 14 dias:',
  canalPush.filter((d) => inApp.has(d.user_id) && !pushU.has(d.user_id)).length,
);
