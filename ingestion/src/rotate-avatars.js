// =============================================================================
// Nimu — invalidar os URLs de avatar de um ano que já saíram
// =============================================================================
// Auditoria do dono, 2026-09-24: o `profiles.avatar_url` guardava um URL
// assinado válido até 2027, e esse URL ia para o browser. A app já não o faz
// (web/lib/data/avatar-display.ts assina na leitura por uma hora), mas os URLs
// antigos continuam válidos para o objeto antigo enquanto ele existir.
//
// Este script muda cada avatar para um caminho novo e aleatório e guarda a
// referência nova (sem token). O objeto antigo deixa de existir, e qualquer URL
// assinado antigo passa a dar 404 na hora. Não é preciso rodar a chave de
// assinatura do projeto, que invalidaria também as sessões de toda a gente.
//
// Só imprime totais: nenhum id, caminho ou URL sai no log.
//
// RUN   node src/rotate-avatars.js [--dry-run]
// =============================================================================

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { config } from './config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BUCKET = 'avatars';
const PAGE = 1000;

/** O caminho do objeto no bucket, de qualquer forma de URL guardada. */
export function avatarObjectPath(stored) {
  if (typeof stored !== 'string') return null;
  const m = /\/storage\/v1\/object\/(?:sign|authenticated|public)\/avatars\/([^?#]+)/.exec(stored);
  if (!m) return null;
  let path;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) return null;
  return path;
}

async function main() {
  const { supabase } = await import('./supabase.js');
  const origin = new URL(config.supabaseUrl).origin;
  const referencia = (p) =>
    `${origin}/storage/v1/object/authenticated/${BUCKET}/${p.split('/').map(encodeURIComponent).join('/')}`;

  const perfis = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, avatar_url')
      .not('avatar_url', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leitura falhou: ${error.message}`);
    perfis.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  let movidos = 0;
  let semObjeto = 0;
  let foraDaPasta = 0;
  let limpos = 0;
  for (const p of perfis) {
    const antigo = avatarObjectPath(p.avatar_url);
    // O objeto tem de estar na pasta do próprio dono; outra coisa não se toca.
    if (antigo === null || !antigo.startsWith(`${p.user_id}/`)) {
      foraDaPasta += 1;
      continue;
    }
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(antigo)?.[1] ?? 'webp').toLowerCase();
    const novo = `${p.user_id}/avatar-${randomUUID()}.${ext}`;
    if (DRY_RUN) {
      movidos += 1;
      continue;
    }
    const { error: moveError } = await supabase.storage.from(BUCKET).move(antigo, novo);
    if (moveError) {
      // O ficheiro já não existe: a coluna apontava para nada. Limpa-se.
      semObjeto += 1;
      await supabase.from('profiles').update({ avatar_url: null }).eq('user_id', p.user_id);
      continue;
    }
    const { error: updError } = await supabase
      .from('profiles')
      .update({ avatar_url: referencia(novo) })
      .eq('user_id', p.user_id);
    if (updError) throw new Error(`atualização falhou: ${updError.message}`);
    movidos += 1;

    // Restos na pasta do utilizador (versões antigas com outra extensão).
    const { data: lista } = await supabase.storage.from(BUCKET).list(p.user_id, { limit: 100 });
    const restos = (lista ?? []).map((o) => `${p.user_id}/${o.name}`).filter((x) => x !== novo);
    if (restos.length > 0) {
      const { error: rmError } = await supabase.storage.from(BUCKET).remove(restos);
      if (!rmError) limpos += restos.length;
    }
  }
  console.log(
    `[nimu:rotate-avatars] ${DRY_RUN ? 'SIMULAÇÃO: ' : ''}perfis com avatar: ${perfis.length}, ` +
      `movidos: ${movidos}, sem ficheiro (coluna limpa): ${semObjeto}, ` +
      `fora da pasta do dono (não tocados): ${foraDaPasta}, restos apagados: ${limpos}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:rotate-avatars] falhou:', err.message);
    process.exitCode = 1;
  });
}
