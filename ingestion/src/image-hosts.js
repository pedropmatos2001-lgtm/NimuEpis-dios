// Os anfitriões de onde a ingestão aceita endereços de imagem (capas, banners,
// imagens de episódio) — auditoria de segurança de 2026-10, F24.
//
// São os mesmos de `IMAGE_CDN_ORIGINS` em web/lib/security-headers.ts (a CSP
// do site), menos o `wsrv.nl`, que é o proxy do próprio site e nunca se guarda
// na base. Uma imagem fora desta lista nunca chegaria ao ecrã — a CSP do site
// recusava-a —, por isso guardá-la só servia para uma coisa: deixar uma fonte
// comprometida pôr no catálogo um endereço à escolha, e fazer a ingestão
// pedi-lo (HEAD) a partir da máquina de quem a corre. Manter as duas listas
// em sincronia.

export const IMAGE_HOSTS = new Set([
  'img.animeschedule.net',
  'artworks.thetvdb.com',
  'cdn.myanimelist.net',
  'media.kitsu.app',
  'media.kitsu.io',
  'image.tmdb.org',
  'cdn.anisearch.com',
  'cdn.anidb.net',
  'u.livechart.me',
  'cdn.anime-planet.com',
  'simkl.in',
]);

/**
 * O endereço normalizado, se for `https` num anfitrião da lista (sem
 * credenciais nem porta), ou `null`.
 */
export function safeImageUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!IMAGE_HOSTS.has(url.hostname)) return null;
  return url.href;
}
