// =============================================================================
// Nimu — apagar fotos de perfil órfãs do Storage
// =============================================================================
// Auditoria independente de 2026-10-04, F13. A app apaga as fotos no momento
// certo (ao trocar de foto, `removeAllAvatars`; ao apagar a conta, antes de
// `delete_account()`), mas essas limpezas são "melhor esforço": se o pedido ao
// Storage falhar, o ficheiro fica no bucket. No caso da conta apagada, fica
// para sempre — e uma foto é um dado pessoal (RGPD art. 5.º(1)(e) e 17.º).
//
// Este script é a rede por baixo disso. Para cada pasta `<user_id>/` do bucket:
//  - sem perfil (conta apagada; o perfil sai em cascata com `auth.users`):
//    apaga tudo;
//  - com perfil: apaga tudo menos o ficheiro para onde `avatar_url` aponta.
// Ficheiros com menos de uma hora ficam sempre: um upload acabado de fazer só
// passa a estar no perfil um instante depois, e não se pode apagá-lo a meio.
//
// Só imprime totais: nenhum id, caminho ou URL sai no log.
//
// RUN   node src/sweep-avatars.js [--dry-run]
// =============================================================================

import { pathToFileURL } from 'node:url';

import { avatarObjectPath } from './rotate-avatars.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BUCKET = 'avatars';
const PAGE = 1000;
const LIST_PAGE = 100;
const REMOVE_BATCH = 100;
/** Idade mínima de um ficheiro para poder ser apagado (ver o topo). */
export const MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Marca de "não mexer nesta pasta": o perfil aponta para o nosso Storage, mas
 * num formato que não se conseguiu ler. Apagar aí podia levar a foto em uso.
 */
export const SKIP_FOLDER = Symbol('skip');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Travão: se muitas fotos EM USO não aparecem nas pastas, o mais provável é
 * que o script esteja a ler mal os caminhos (e não que tantas fotos tenham
 * desaparecido) — nesse caso não se apaga nada e o job falha, para alguém ver.
 */
export function assertPlanIsSane(folders, keepByUser) {
  let inUse = 0;
  let missing = 0;
  for (const [user, keep] of keepByUser) {
    if (typeof keep !== 'string') continue;
    inUse += 1;
    const files = folders.get(user) ?? [];
    if (!files.some((f) => `${user}/${f.name}` === keep)) missing += 1;
  }
  if (missing > Math.max(2, Math.ceil(inUse * 0.2))) {
    throw new Error(
      `${missing} de ${inUse} fotos em uso não aparecem no bucket — nada foi apagado (verificar o script)`,
    );
  }
}

/**
 * Decide o que apagar. Pura, para se testar sem Storage.
 *
 * @param {Map<string, {name: string, createdAt: string | null}[]>} folders
 *   os ficheiros de cada pasta (chave: o nome da pasta, que é o `user_id`).
 * @param {Map<string, string | null | typeof SKIP_FOLDER>} keepByUser
 *   para cada utilizador COM perfil, o caminho que o perfil usa (`null` sem
 *   foto no bucket; `SKIP_FOLDER` quando não se percebeu o `avatar_url`).
 * @param {Date} now
 * @returns {{paths: string[], deletedAccounts: number, staleFiles: number}}
 */
export function planAvatarSweep(folders, keepByUser, now) {
  const paths = [];
  let deletedAccounts = 0;
  let staleFiles = 0;
  for (const [folder, files] of folders) {
    // Só pastas com o nome de um id de utilizador: outra coisa qualquer no
    // bucket não é nossa para apagar.
    if (!UUID.test(folder)) continue;
    const hasProfile = keepByUser.has(folder);
    const keep = keepByUser.get(folder) ?? null;
    if (keep === SKIP_FOLDER) continue;
    let removedHere = 0;
    for (const file of files) {
      const path = `${folder}/${file.name}`;
      if (path === keep) continue;
      const created = file.createdAt === null ? NaN : Date.parse(file.createdAt);
      // Sem data conhecida, ou recente demais: fica (o lado seguro).
      if (!Number.isFinite(created) || now.getTime() - created < MIN_AGE_MS) continue;
      paths.push(path);
      removedHere += 1;
    }
    if (removedHere > 0) {
      if (hasProfile) staleFiles += removedHere;
      else deletedAccounts += 1;
    }
  }
  return { paths, deletedAccounts, staleFiles };
}

async function listAll(storage, prefix) {
  const out = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await storage.list(prefix, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`listagem falhou: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < LIST_PAGE) break;
  }
  return out;
}

async function main() {
  const { supabase } = await import('./supabase.js');
  const storage = supabase.storage.from(BUCKET);

  // O caminho que cada perfil usa (`avatar_url` com uma referência ao bucket).
  const keepByUser = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, avatar_url')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leitura dos perfis falhou: ${error.message}`);
    for (const p of data ?? []) {
      const path = avatarObjectPath(p.avatar_url);
      const ours = typeof p.avatar_url === 'string' && p.avatar_url.includes('/storage/v1/object/');
      keepByUser.set(p.user_id, path === null && ours ? SKIP_FOLDER : path);
    }
    if ((data ?? []).length < PAGE) break;
  }

  // As pastas do bucket (entradas sem `id` são pastas) e os ficheiros de cada.
  const folders = new Map();
  for (const entry of await listAll(storage, '')) {
    if (entry.id !== null && entry.id !== undefined) continue;
    const files = await listAll(storage, entry.name);
    folders.set(
      entry.name,
      files
        .filter((f) => f.id !== null && f.id !== undefined)
        .map((f) => ({ name: f.name, createdAt: f.created_at ?? null })),
    );
  }

  assertPlanIsSane(folders, keepByUser);
  const plan = planAvatarSweep(folders, keepByUser, new Date());
  let removed = 0;
  if (!DRY_RUN) {
    for (let i = 0; i < plan.paths.length; i += REMOVE_BATCH) {
      const batch = plan.paths.slice(i, i + REMOVE_BATCH);
      const { error } = await storage.remove(batch);
      if (error) throw new Error(`remoção falhou: ${error.message}`);
      removed += batch.length;
    }
  }
  console.log(
    `[nimu:sweep-avatars] ${DRY_RUN ? 'SIMULAÇÃO: ' : ''}pastas: ${folders.size}, ` +
      `contas apagadas com fotos: ${plan.deletedAccounts}, ficheiros antigos de contas ativas: ` +
      `${plan.staleFiles}, ${DRY_RUN ? 'a apagar' : 'apagados'}: ${DRY_RUN ? plan.paths.length : removed}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[nimu:sweep-avatars] falhou:', err.message);
    process.exitCode = 1;
  });
}
