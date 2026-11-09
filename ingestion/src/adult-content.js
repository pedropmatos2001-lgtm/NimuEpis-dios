// =============================================================================
// Nimu — o filtro de conteúdo adulto (18+), num só sítio
// =============================================================================
// PORQUE EXISTE (2026-11-01)
//
//   O Nimu é uma app para o público geral na UE: não mostra títulos 18+. Até
//   aqui o filtro vivia só no mapeador do manami (catalogue-mappers.js), e só
//   olhava para as etiquetas do manami. A ingestão semanal da AnimeSchedule
//   (run.js → pipeline.js) NÃO tinha filtro nenhum. Foi por aí que entraram,
//   com episódios e tudo, os OVAs hentai de verão de 2026 ("Kanojo Saimin",
//   "Pure x Holic", "NTR Kishi"…), que em agosto chegaram a ser as páginas
//   mais procuradas do site no Google. A prova está no próprio slug: o de
//   "Pure x Holic" é `…kon-in-kankei…`, com o apóstrofo da grafia da
//   AnimeSchedule ("Kon'in"); o manami escreve "Konin". E o slug só se gera na
//   inserção (migração 20260821000000), logo foi a AnimeSchedule que criou a
//   linha.
//
//   Este módulo junta TODOS os sinais que as fontes dão e é chamado em TODOS
//   os caminhos que inserem em `animes` (catalogue.js e run.js), e ainda pelo
//   `purge-adult.js`, que limpa o que já entrou. Basta UMA fonte dizer "adulto"
//   para o título ficar de fora.
//
// OS SINAIS, POR FONTE
//
//   - AniList `isAdult: true`. Hoje não chamamos a AniList (ToS, ver o README
//     da ingestão), mas o sinal fica aceite para quando houver uma fonte que o
//     traga.
//   - MyAnimeList/Jikan `rating` começado por "Rx" ("Rx - Hentai"). ATENÇÃO:
//     "R+ - Mild Nudity" e "R - 17+" NÃO são hentai e NÃO excluem — são o
//     ecchi e o seinen violento que fazem parte do catálogo normal.
//   - TMDB `adult: true` (a pesquisa já vai com `include_adult=false`).
//   - Etiquetas do manami e géneros da AnimeSchedule: "Hentai", "Erotica"… ver
//     ADULT_TAGS. Comparam-se normalizadas, por isso "Hentai" (género da
//     AnimeSchedule, que segue a taxonomia do MAL) e "hentai" (etiqueta do
//     manami) dão o mesmo.
//
// O QUE FICA DE FORA DE PROPÓSITO (medido no manami de 2026-07-04)
//
//   - "ecchi": género mainstream, fica.
//   - "adult audience only" (aniSearch): está em 1 818 entradas, incluindo
//     "Afro Samurai: Resurrection" e "Devilman". É "para adultos" por
//     violência tanto quanto por sexo; sozinho condenava títulos legítimos.
//   - "pornography" (AniDB): está em "91 Days" e "Akatsuki no Yona". Na AniDB
//     é um elemento temático, não a classificação 18+.
//   - "borderline porn", "erotic game", "adult cast": ecchi pesado, títulos
//     baseados em visual novels (Air, Clannad…) e demografia, respetivamente.
// =============================================================================

import { normalizeTitleKey } from './manami.js';

/**
 * A chave de título para o filtro 18+: a de `normalizeTitleKey` SEM espaços.
 * Porque a AnimeSchedule e o manami romanizam de maneira diferente: "Kon'in
 * Kankei" contra "Konin Kankei", "Yatte Mitara" contra "Yattemitara" — os
 * dois casos reais de 2026-08. Juntar as palavras torna-os iguais; o risco de
 * colisão que isto acrescenta fica coberto pela regra da ambiguidade de
 * `buildManamiAdultTitleIndex`.
 */
export function adultTitleKey(title) {
  return normalizeTitleKey(title).replace(/\s+/g, '');
}

/**
 * Etiquetas/géneros que, sozinhos, fazem de um título conteúdo adulto.
 * Mantém-se o conjunto que já existia no mapeador do manami (2026-07): o
 * "erotica" das 232 entradas do manami que o têm sem "hentai" são quase todas
 * OVAs explícitos ("Ai no Kusabi", "Beast City", "Blackmail").
 */
export const ADULT_TAGS = new Set([
  'hentai',
  'erotica',
  'erotic',
  'pornographic',
  'porn',
  'smut',
  'nsfw',
  // Esta é a marca 18+ da própria AniDB (no manami de 2026-07-04 vem sempre
  // junto com "hentai", mas a AniDB pode chegar sem o resto).
  '18 restricted',
]);

/**
 * Títulos 18+ confirmados à mão para os quais as nossas fontes não dão sinal
 * fiável (2026-11-01). Guardam-se com `adultTitleKey`, ver `KNOWN_ADULT_TITLES`.
 *
 * Acrescentar aqui só com uma fonte pública que o comprove, e escrevê-la.
 */
export const KNOWN_ADULT_TITLES = [
  // ハーレム島へようこそ！ — no TMDB (tv/320889) é "Adult" com a palavra-chave
  // "hentai". Não está no manami de 2026-07-04.
  'Harem-tou e Youkoso!',
  'Harem Shima e Youkoso!',
  // MAL 63619: "Rx - Hentai", género Hentai. No manami há uma entrada com o
  // título inglês e SEM etiquetas nem ids, que deixa o título ambíguo.
  "My Classmate's a Sexy Actress, and Now We Live Together?!",
  'Onaji Semi no Someya-san ga Sexy Joyuu datta Hanashi.',
  // Os OVAs que apareceram nas páginas mais procuradas do Search Console em
  // 2026-08. Todos têm a etiqueta "hentai" no manami (lançamento 2026-27) e,
  // os que lá têm id, "Rx - Hentai" no MAL. Ficam aqui também porque as fichas
  // que a AnimeSchedule criou podem não ter id nenhum em comum com o manami, e
  // pelo título só iriam para "por rever" (purge-adult.js). Estar na lista
  // impede também que voltem a entrar por qualquer caminho.
  'Kanojo Saimin',
  "Pure x Holic: Junketsu Otome to Kon'in Kankei!? The Animation",
  'Netorareta Bakunyuu Tsuma-tachi',
  'Netorareta Bakunyuu Tsuma-tachi 2',
  'NTR Kishi',
  'Muramata-san no Aijou',
  'Mujikaku na Osananajimi to Kyoumi Honi de Yatte Mitara The Animation',
  'Sare Tsuma wa Ubawaretai',
  'Deco x Deco The Animation',
  'Inaka ni wa Kore Kurai Shika Goraku ga Nai',
];
export const KNOWN_ADULT_TITLE_KEYS = new Set(KNOWN_ADULT_TITLES.map((t) => adultTitleKey(t)));

/** Minúsculas, sem espaços a mais. Aceita a string ou o objeto `{ name }` da
 *  AnimeSchedule (os géneros vêm como `{ name, route }`). */
export function normalizeLabel(value) {
  const raw = typeof value === 'object' && value !== null ? value.name : value;
  return String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * A classificação do MAL/Jikan é hentai? Só "Rx" (o MAL escreve "Rx - Hentai").
 * "R+ - Mild Nudity" e "R - 17+" ficam — não são hentai (ver o topo).
 */
export function isAdultRating(rating) {
  if (typeof rating !== 'string') return false;
  return /^rx\b/i.test(rating.trim());
}

/** A primeira etiqueta/género adulto da lista, ou `null`. */
function firstAdultLabel(labels) {
  for (const label of Array.isArray(labels) ? labels : []) {
    const norm = normalizeLabel(label);
    if (ADULT_TAGS.has(norm)) return norm;
  }
  return null;
}

/**
 * O motivo por que um título é adulto, ou `null` se nenhuma fonte o diz.
 *
 * Todos os campos são opcionais e cada fonte passa os que tem. Devolve um texto
 * curto ("rating:Rx - Hentai", "genre:hentai"…) que vai para os registos, para
 * quem lê saber PORQUÊ um título ficou de fora.
 *
 * @param {object} [signals]
 * @param {boolean} [signals.isAdult]  AniList
 * @param {boolean} [signals.adult]    TMDB
 * @param {string}  [signals.rating]   MAL/Jikan
 * @param {Array}   [signals.tags]     manami (strings)
 * @param {Array}   [signals.genres]   AnimeSchedule ({name}) ou guardados (strings)
 * @param {Array}   [signals.titles]   nomes, para a lista confirmada à mão
 */
export function adultReason({ isAdult, adult, rating, tags, genres, titles } = {}) {
  if (isAdult === true) return 'isAdult';
  if (adult === true) return 'adult';
  if (isAdultRating(rating)) return `rating:${rating.trim()}`;
  const tag = firstAdultLabel(tags);
  if (tag) return `tag:${tag}`;
  const genre = firstAdultLabel(genres);
  if (genre) return `genre:${genre}`;
  for (const title of Array.isArray(titles) ? titles : []) {
    const key = adultTitleKey(title);
    if (key && KNOWN_ADULT_TITLE_KEYS.has(key)) return `lista:${String(title).trim()}`;
  }
  return null;
}

/** Atalho booleano de `adultReason`. */
export function isAdultContent(signals) {
  return adultReason(signals) !== null;
}

/**
 * O que o manami diz deste título, pelos ids (mal/anilist) contra o índice de
 * `buildManamiIndex` — cujos registos trazem as etiquetas (`tags`).
 *
 * É o cruzamento que apanha um título que a AnimeSchedule não marca mas o
 * manami sim (ex.: "My Classmate's a Sexy Actress", MAL 63619, "Rx - Hentai"
 * no MAL e "erotica" no manami).
 */
export function manamiAdultReasonByIds(ids, index) {
  if (!index || !ids) return null;
  const mal = ids.mal ?? null;
  const anilist = ids.anilist ?? null;
  for (const record of [
    mal != null ? index.byMal?.get(Number(mal)) : undefined,
    anilist != null ? index.byAnilist?.get(Number(anilist)) : undefined,
  ]) {
    const tag = record ? firstAdultLabel(record.tags) : null;
    if (tag) return `manami:${tag}`;
  }
  return null;
}

/**
 * Índice por TÍTULO do manami, para as linhas sem id em comum com ele.
 *
 * Cada chave (título ou sinónimo, ver `adultTitleKey`) fica `true` só quando
 * TODAS as entradas do manami com essa chave, e que tenham etiquetas, são
 * adultas. Uma colisão com uma entrada limpa torna a chave ambígua e ela não
 * condena nada. Medido: o sinónimo "Akira" de "Yuuwaku Countdown: Akira"
 * (hentai) colide com o filme "Akira" de 1988; sem esta regra, o "Akira"
 * sairia do catálogo.
 *
 * Uma entrada SEM etiquetas não conta para nenhum dos lados: não saber não é
 * prova de que é limpo (é o caso das entradas acabadas de criar no manami).
 *
 * @returns {Map<string, boolean>}
 */
export function buildManamiAdultTitleIndex(entries) {
  const byKey = new Map();
  for (const entry of entries ?? []) {
    if (!Array.isArray(entry?.tags) || entry.tags.length === 0) continue;
    const adult = firstAdultLabel(entry.tags) !== null;
    for (const raw of [entry?.title, ...(entry?.synonyms ?? [])]) {
      const key = adultTitleKey(raw);
      if (!key) continue;
      byKey.set(key, (byKey.get(key) ?? true) && adult);
    }
  }
  return byKey;
}

/** `manami-titulo:<nome>` quando um dos nomes é inequivocamente adulto no
 *  manami (ver `buildManamiAdultTitleIndex`), senão `null`. */
export function manamiAdultReasonByTitle(titles, titleIndex) {
  if (!titleIndex) return null;
  for (const title of titles ?? []) {
    const key = adultTitleKey(title);
    if (key && titleIndex.get(key) === true) return `manami-titulo:${String(title).trim()}`;
  }
  return null;
}
