// Os outros nomes de um anime (inglês, romaji, sinónimos) para a coluna
// `animes.alt_titles` — é o que deixa a pesquisa encontrar "The Warrior
// Princess and the Barbaric King" quando o título guardado é "Himekishi wa
// Barbaroi no Yome", e "Shingeki no Kyojin" quando é "Attack on Titan".
//
// Módulo puro (sem rede nem Supabase): o que os testes exercitam.

// A MESMA tabela de acentos de `public.nimu_norm` (migração
// 20260928000000_titulos_alternativos.sql), que por sua vez é a do
// `anime_slugify`. Um teste compara as duas, para nunca divergirem: é com esta
// normalização que a ingestão decide se um nome já está na base.
export const ACCENTS_FROM =
  'áàâãäåāăąÁÀÂÃÄÅĀĂĄéèêëēĕėęěÉÈÊËĒĔĖĘĚíìîïĩīĭįÍÌÎÏĨĪĬĮóòôõöøōŏőÓÒÔÕÖØŌŎŐúùûüũūŭůÚÙÛÜŨŪŬŮçćĉċčÇĆĈĊČñńņňÑŃŅŇýÿŷÝŸŶšśŝşŠŚŜŞžźżŽŹŻğĝġģĞĜĠĢďđĎĐĺļľłĹĻĽŁŕŗřŔŖŘţťŧŢŤŦ';
export const ACCENTS_TO =
  'aaaaaaaaaAAAAAAAAAeeeeeeeeeEEEEEEEEEiiiiiiiiIIIIIIIIoooooooooOOOOOOOOOuuuuuuuuUUUUUUUUcccccCCCCCnnnnNNNNyyyYYYssssSSSSzzzZZZggggGGGGddDDllllLLLLrrrRRRtttTTT';

const ACCENT_MAP = new Map([...ACCENTS_FROM].map((ch, i) => [ch, [...ACCENTS_TO][i]]));

/** Teto por anime, igual ao `check` da coluna. */
export const MAX_ALT_TITLES = 40;
/** Teto por nome, igual ao `left(..., 200)` do `anime_merge_names`. */
export const MAX_NAME_LEN = 200;

/**
 * A normalização da pesquisa, igual à `public.nimu_norm`: acentos fora,
 * minúsculas, tudo o que não é [a-z0-9] vira espaço, pontas aparadas.
 */
export function normName(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) out += ACCENT_MAP.get(ch) ?? ch;
  return out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Só alfabeto latino (mais dígitos, pontuação e acentos combinados): é o que
// se escreve num site em inglês e português. Kana, han, cirílico e afins ficam
// de fora; "進撃の巨人 attack on titan", misto, também (o nome latino costuma
// vir sozinho noutro sinónimo).
const ONLY_LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;
const HAS_LATIN = /\p{Script=Latin}/u;

// Caracteres de controlo e de formato invisíveis (marcas de direção do texto,
// espaços de largura zero). Os sinónimos vêm de sites que qualquer pessoa edita;
// uma marca de direção escondida pode baralhar o que o nome parece dizer.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** O nome sem caracteres invisíveis e sem espaços nas pontas. */
export function cleanName(value) {
  return typeof value === 'string' ? value.replace(INVISIBLE, '').trim() : '';
}

/** Um nome que vale a pena guardar: latino e com pelo menos 2 caracteres úteis. */
export function isUsefulName(value) {
  if (typeof value !== 'string') return false;
  const name = cleanName(value);
  if (name === '' || !ONLY_LATIN.test(name) || !HAS_LATIN.test(name)) return false;
  return normName(name).length >= 2;
}

/**
 * Os nomes a guardar para um anime, pela ordem dada (a primeira fonte é a mais
 * fiável): só latinos, sem repetidos depois de normalizados, sem o próprio
 * título, cortados a MAX_NAME_LEN e no máximo MAX_ALT_TITLES.
 */
export function altNames(candidates, title = null) {
  const seen = new Set();
  const titleKey = normName(title ?? '');
  if (titleKey) seen.add(titleKey);
  const out = [];
  for (const candidate of candidates ?? []) {
    if (!isUsefulName(candidate)) continue;
    const name = cleanName(candidate).slice(0, MAX_NAME_LEN);
    const key = normName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_ALT_TITLES) break;
  }
  return out;
}

/**
 * Os nomes que o AnimeSchedule dá a um anime: inglês, romaji, abreviatura e
 * sinónimos. A linha guarda um deles como título (o inglês, se houver); os
 * restantes vão para `alt_titles`.
 */
export function animescheduleNames(entry, detail = null) {
  const names = detail?.names ?? {};
  return [
    names.english,
    entry?.english,
    names.romaji,
    entry?.romaji,
    entry?.title,
    detail?.title,
    names.abbreviation,
    ...(Array.isArray(names.synonyms) ? names.synonyms : []),
  ];
}

/** Os nomes de uma entrada do manami: o título principal e os sinónimos. */
export function manamiNames(entry) {
  return [entry?.title, ...(Array.isArray(entry?.synonyms) ? entry.synonyms : [])];
}

/**
 * Os nomes de `candidates` que ainda NÃO estão na linha (nem como título nem
 * em `existing`). Vazio quando não há nada de novo, e aí não se escreve nada:
 * é isso que torna as corridas seguintes quase gratuitas.
 */
export function newNamesFor(row, candidates) {
  const known = new Set([normName(row?.title ?? ''), ...(row?.alt_titles ?? []).map(normName)]);
  const room = MAX_ALT_TITLES - (row?.alt_titles?.length ?? 0);
  if (room <= 0) return [];
  return altNames(candidates, row?.title).filter((n) => !known.has(normName(n))).slice(0, room);
}
