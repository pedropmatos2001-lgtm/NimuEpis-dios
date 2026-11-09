// Videoclipes, PV, CM, teasers e trailers: o que está no catálogo mas não é um
// anime para ver.
//
// ## Porque existe (2026-11-04)
//
// Pesquisar "Solo Leveling" mostrava "Echo", um videoclipe de 3 minutos dos
// The Boyz: o MAL tem-no como "Music", o manami chama `SPECIAL` aos videoclipes
// e nós guardámo-lo como `media_type = 'Special'`. Medido nesse dia: o
// AnimeSchedule marca "Music" em 2 502 linhas nossas (2 481 guardadas como
// `Special`), e há mais umas centenas de PV e CM que nenhuma fonte marca.
//
// ## O que faz
//
// Classifica uma linha como `'Music'` (videoclipe) ou `'PV'` (PV, CM, teaser,
// trailer), ou devolve `null` (é um anime, fica como está). O resultado vai
// para a coluna `media_type`, que já existe, é texto livre e já recebe
// "Music" do AnimeSchedule (`mappers.js`). Não há coluna nova nem migração: o
// site deixa de mostrar estes dois valores (web/lib/data/extras.ts).
//
// ## A regra, por ordem
//
// 1. A lista de exceções (`data/extras-overrides.json`) manda sempre: `keep`
//    nunca é extra, `extra` é sempre o tipo dito lá.
// 2. O AnimeSchedule diz "Music" (e não também TV) → `'Music'`. É a fonte licenciada e, medido,
//    não erra: das 2 502, 2 473 têm 1 episódio e 2 485 duram ≤8 min; as
//    restantes são coleções de videoclipes ("Macross F Music Clip Shuu").
// 3. Título com PV, CM, Teaser ou Trailer como PALAVRA ("Fate/strange Fake PV",
//    "Granblue Fantasy CMs"), num formato que não seja TV, e com episódios de
//    ≤15 min quando a duração se sabe → `'PV'`.
// 4. Só para linhas que o AnimeSchedule não decide (sem rota e sem
//    seguidores): o manami diz `SPECIAL`, etiqueta `music`, ≤1 episódio e uma
//    duração CONHECIDA de ≤8 min → `'Music'`. Apanha 97% das que o
//    AnimeSchedule marca, sem precisar dele.
//
// O que NUNCA é extra, por construção: TV e TV Short (Oshi no Ko, Bocchi the
// Rock, Given, Love Live, Teekyuu…), filmes de música, qualquer coisa com mais
// de um episódio pela regra do manami, qualquer coisa sem duração conhecida, e
// qualquer linha que alguém siga no AnimeSchedule (essas decide o AnimeSchedule).
import { readFileSync } from 'node:fs';

/** Os dois valores de `media_type` que o site não mostra como anime. */
export const EXTRA_MEDIA_TYPES = Object.freeze(['Music', 'PV']);

/** Teto da regra do manami: um videoclipe dura uma canção (medido: 99% ≤8 min). */
export const MUSIC_MAX_SECONDS = 8 * 60;

/** Teto da regra do título: um PV ou CM não passa de uns minutos. */
export const PV_MAX_SECONDS = 15 * 60;

/**
 * PV, CM, Teaser, Trailer (e plurais) como palavra inteira, em maiúsculas para
 * as siglas. "CM" e "PV" só em maiúsculas: "Pv" ou "cm" a meio de um título não
 * são siglas. "Teaser"/"Trailer" em qualquer caixa, mas nunca "Teasing".
 */
const PV_TITLE = /(?:^|[^\p{L}\p{N}])(?:PVs?|CMs?|[Tt](?:easer|EASER|railer|RAILER)s?)(?:$|[^\p{L}\p{N}])/u;

/** Formatos que nunca são extra pela regra do título (séries de verdade). */
const SERIES_TYPES = new Set(['tv', 'tv short', 'tv (chinese)', 'tv short (chinese)']);

const OVERRIDES_FILE = new URL('../data/extras-overrides.json', import.meta.url);

/** `{ keep: Set<mal>, extra: Map<mal, 'Music'|'PV'> }` do ficheiro de exceções. */
export function loadOverrides(file = OVERRIDES_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return parseOverrides(raw);
}

export function parseOverrides(raw) {
  const keep = new Set();
  const extra = new Map();
  for (const item of raw?.keep ?? []) {
    const mal = Number(item?.mal);
    if (Number.isInteger(mal) && mal > 0) keep.add(mal);
  }
  for (const item of raw?.extra ?? []) {
    const mal = Number(item?.mal);
    if (Number.isInteger(mal) && mal > 0 && EXTRA_MEDIA_TYPES.includes(item?.type)) {
      extra.set(mal, item.type);
    }
  }
  return { keep, extra };
}

const NO_OVERRIDES = Object.freeze({ keep: new Set(), extra: new Map() });

let defaultOverridesCache = null;
/** As exceções do repositório, lidas uma vez por processo (para os mapeadores). */
export function defaultOverrides() {
  if (defaultOverridesCache === null) {
    try {
      defaultOverridesCache = loadOverrides();
    } catch {
      // Um ficheiro estragado não pode parar a ingestão: as regras valem sem ele.
      defaultOverridesCache = NO_OVERRIDES;
    }
  }
  return defaultOverridesCache;
}

/** `true` se o valor de `media_type` é um dos extras. */
export function isExtraMediaType(value) {
  return typeof value === 'string' && EXTRA_MEDIA_TYPES.includes(value);
}

/** `true` se o título tem PV/CM/Teaser/Trailer como palavra. */
export function hasPvTitle(title) {
  return typeof title === 'string' && PV_TITLE.test(title);
}

/** Duração de um episódio no manami, em segundos, ou null se não se sabe. */
export function manamiSeconds(entry) {
  const value = Number(entry?.duration?.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = String(entry?.duration?.unit ?? 'SECONDS').toUpperCase();
  if (unit === 'MINUTES') return value * 60;
  if (unit === 'HOURS') return value * 3600;
  return value;
}

/** A regra 4: um videoclipe pelo manami. */
export function isManamiMusicClip(entry) {
  if (!entry || String(entry.type ?? '').toUpperCase() !== 'SPECIAL') return false;
  const tags = (entry.tags ?? []).map((t) => String(t).toLowerCase().trim());
  if (!tags.includes('music')) return false;
  const episodes = Number(entry.episodes);
  if (!Number.isInteger(episodes) || episodes > 1) return false;
  const seconds = manamiSeconds(entry);
  return seconds !== null && seconds <= MUSIC_MAX_SECONDS;
}

/**
 * A classificação de UMA linha.
 *
 * @param {object} input
 * @param {number|null} [input.mal]        mal_id da linha
 * @param {string|null} [input.title]      título guardado
 * @param {string|null} [input.mediaType]  `media_type` guardado (ou o que se vai guardar)
 * @param {string[]}    [input.asMediaTypes] os `mediaTypes` do AnimeSchedule, se se sabem
 * @param {boolean}     [input.asDecides]  a linha é do AnimeSchedule (rota ou seguidores):
 *                                          a regra do manami não se aplica
 * @param {object|null} [input.manami]     a entrada do manami com o mesmo mal_id
 * @param {object}      [overrides]        de `loadOverrides()`
 * @returns {'Music'|'PV'|null}
 */
export function classifyExtra(input, overrides = NO_OVERRIDES) {
  const mal = Number(input?.mal);
  if (Number.isInteger(mal)) {
    if (overrides.keep.has(mal)) return null;
    const forced = overrides.extra.get(mal);
    if (forced) return forced;
  }

  const asTypes = (input?.asMediaTypes ?? []).map((t) => String(t?.name ?? t).toLowerCase());
  // "Music" ao lado de "TV" ou "TV Short" não esconde a série: uma ficha com os
  // dois é uma série de música, não um videoclipe (hoje não há nenhuma assim).
  const asSeries = asTypes.some((t) => SERIES_TYPES.has(t));
  if (asTypes.includes('music') && !asSeries) return 'Music';

  const manami = input?.manami ?? null;
  const stored = String(input?.mediaType ?? '').trim().toLowerCase();
  const manamiType = String(manami?.type ?? '').trim().toLowerCase();
  const isSeries = SERIES_TYPES.has(stored) || manamiType === 'tv' || asSeries;

  const titles = [input?.title, manami?.title];
  if (!isSeries && titles.some(hasPvTitle)) {
    const seconds = manamiSeconds(manami);
    if (seconds === null || seconds <= PV_MAX_SECONDS) return 'PV';
  }

  if (!input?.asDecides && isManamiMusicClip(manami)) return 'Music';
  return null;
}

/**
 * O que escrever numa passagem pelo catálogo: `[{ id, media_type, from, why }]`
 * só para as linhas cujo `media_type` muda.
 *
 * Idempotente: uma linha que já tem o valor certo não entra. Nunca DESFAZ uma
 * classificação por omissão (se o AnimeSchedule falhar numa corrida, a regra
 * 2 não se aplica nessa corrida, e não se quer que uma linha marcada ontem
 * volte a aparecer hoje). Só a lista `keep` devolve uma linha ao seu formato
 * de origem, o do manami.
 *
 * @param {object[]} rows            `{ id, mal_id, title, media_type, animeschedule_route, popularity }`
 * @param {object}   ctx
 * @param {Map<number, object>} ctx.manamiByMal
 * @param {Set<number>|null}    ctx.asMusicMal  mal_ids que o AnimeSchedule marca "Music" (null = não se sabe)
 * @param {object}   [ctx.overrides]
 */
export function planReclassification(rows, { manamiByMal, asMusicMal = null, overrides = NO_OVERRIDES }) {
  const updates = [];
  for (const row of rows ?? []) {
    const mal = row?.mal_id == null ? null : Number(row.mal_id);
    const manami = mal !== null ? manamiByMal?.get(mal) ?? null : null;
    const fromAs = Boolean(row?.animeschedule_route) || row?.popularity != null;
    const kind = classifyExtra(
      {
        mal,
        title: row?.title,
        // Uma linha já marcada lê-se pelo formato de ORIGEM, senão a regra do
        // título (que exclui TV) via o próprio "Music" e não decidia nada.
        mediaType: isExtraMediaType(row?.media_type) ? manamiMediaType(manami) : row?.media_type,
        asMediaTypes: mal !== null && asMusicMal?.has(mal) ? ['Music'] : [],
        asDecides: fromAs,
        manami,
      },
      overrides,
    );
    const current = row?.media_type ?? null;
    if (kind !== null) {
      if (current !== kind) {
        updates.push({ id: row.id, media_type: kind, from: current, why: whyOf(row, kind, manami, asMusicMal) });
      }
      continue;
    }
    // Só a lista `keep` desfaz: volta ao formato do manami.
    if (isExtraMediaType(current) && mal !== null && overrides.keep.has(mal)) {
      // Sem entrada no manami, 'Special' (o mesmo que o `mappers.js` escreve):
      // um null aqui tirava a linha do filtro de formato do Descobrir.
      const back = manamiMediaType(manami) ?? 'Special';
      if (back !== current) updates.push({ id: row.id, media_type: back, from: current, why: 'keep' });
    }
  }
  return updates;
}

function whyOf(row, kind, manami, asMusicMal) {
  const mal = row?.mal_id == null ? null : Number(row.mal_id);
  if (kind === 'Music' && mal !== null && asMusicMal?.has(mal)) return 'animeschedule';
  if (kind === 'PV') return 'titulo';
  if (kind === 'Music' && isManamiMusicClip(manami)) return 'manami';
  return 'excecao';
}

/** O `type` do manami no formato que a base guarda (o mesmo de catalogue-mappers.js). */
export function manamiMediaType(entry) {
  const map = { TV: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special' };
  return map[String(entry?.type ?? '').toUpperCase()] ?? null;
}
