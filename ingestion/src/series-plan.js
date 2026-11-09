// A chave de série (fase 4 do plano "fichas por série", 2026-11-04): que
// linhas de `animes` são temporadas da MESMA série, que temporada e que parte
// é cada uma, o nome e o endereço da série.
//
// Módulo puro (sem rede nem Supabase): o que os testes exercitam. Quem lê as
// fontes e escreve é `series.js`.
//
// ## A regra, em linhas
//
//  1. Os nós são as fichas do AnimeSchedule em formato de série: TV, ONA ou
//     TV Short (também as "(Chinese)", que são o mesmo formato para os donghua).
//     Um ONA ou TV Short de UM episódio não é uma temporada (o "MONSTERS" do
//     One Piece, um PV): fica de fora.
//  2. As arestas são as relações `sequels`/`prequels` do AnimeSchedule entre
//     dois nós. Filmes, OVAs e especiais NÃO ligam nada: ficam fichas soltas
//     nesta versão, e um especial no meio da cadeia não junta duas séries
//     diferentes (medido: os curtos "Maomao no Hitorigoto" e o "●● no Mahou"
//     do Frieren ficam de fora, o que está certo).
//  3. Uma série é uma componente ligada. Cada nó passa a uma linha de
//     `animes` (pelo `anime_route_aliases` quando se pode ler, senão pela
//     `animeschedule_route`, senão pelo `mal_id`); duas fichas que dão a
//     MESMA linha (uma franquia já fundida, como o Mushoku Tensei) contam uma
//     vez. A linha também tem de ser de série (`media_type` TV, ONA, TV Short
//     ou vazio): um videoclipe ou um especial que o AnimeSchedule ache "ONA"
//     não entra.
//  4. Uma componente com um só membro não é série (One Piece, Mushoku Tensei,
//     Slime): não tem linha em `series`. Uma com mais de 12 membros vai para
//     revisão e não se escreve sem estar aprovada em `series-overrides.json`.
//  5. A temporada sai do nome ("Season 2", "2nd Season", "II", "… 3", "Final
//     Season", "Part 2" é a parte), senão da ordem de estreia.
//  6. O nome da série é o nome comercial (o que a ficha mostra, `displayTitle`
//     do site) sem a temporada; o endereço sai dele, livre de colisões com os
//     endereços dos animes.
import { displayTitle, normalizeDisplayName } from '../../web/lib/titles/display-title.ts';
import { nameKey } from '../../web/lib/titles/decorations.ts';
import { isRomaji } from '../../web/lib/seo/english-name.ts';
import { isExtraMediaType } from './extras.js';
import { ACCENTS_FROM, ACCENTS_TO } from './names.js';

/** Mais membros do que isto e a série vai para revisão (plano, secção 4.1). */
export const MAX_MEMBERS = 12;

/** Quantas fichas que não são de série pode ter uma ponte entre duas que são. */
export const MAX_BRIDGE = 4;

/** Os formatos que fazem uma série. O resto (filmes, OVAs, especiais) fica solto. */
export const SERIES_FORMATS = Object.freeze(['TV', 'ONA', 'TV Short']);
const SERIES_FORMAT_SET = new Set(SERIES_FORMATS.map((f) => f.toLowerCase()));

/** "ONA (Chinese)" → "ona". */
export function baseFormat(value) {
  return String(value ?? '')
    .replace(/\s*\(chinese\)\s*$/i, '')
    .trim()
    .toLowerCase();
}

// ── Fichas do AnimeSchedule ──────────────────────────────────────────────────

const MAL_RE = /myanimelist\.net\/anime\/(\d+)/i;

/**
 * A ficha do AnimeSchedule (`GET /anime?page=N`) reduzida ao que esta regra
 * usa. É também a forma da cache (`.cache/animeschedule-relacoes.json`).
 */
export function compactAsEntry(entry) {
  const rel = entry?.relations ?? {};
  const mal = Number(MAL_RE.exec(entry?.websites?.mal ?? '')?.[1] ?? NaN);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : []);
  return {
    route: String(entry?.route ?? ''),
    mal: Number.isInteger(mal) ? mal : null,
    en: entry?.names?.english || null,
    t: entry?.title || null,
    mt: (entry?.mediaTypes ?? []).map((m) => String(m?.name ?? m)),
    eps: Number.isInteger(entry?.episodes) ? entry.episodes : null,
    pr: entry?.premier ?? null,
    y: Number.isInteger(entry?.year) ? entry.year : null,
    seq: list(rel.sequels),
    pre: list(rel.prequels),
  };
}

/** A ficha é de série (TV, ONA, TV Short) e não um episódio só? */
export function isAsSeriesNode(entry) {
  const formats = (entry?.mt ?? []).map(baseFormat);
  if (formats.length === 0 || !formats.some((f) => SERIES_FORMAT_SET.has(f))) return false;
  if (formats.some((f) => f === 'music')) return false;
  // "Só entra quem tem ≥2 episódios ou formato TV" (plano, 4.2: o MONSTERS do
  // One Piece é um ONA de um episódio que o AnimeSchedule põe como prequela).
  const tv = formats.includes('tv');
  if (!tv && entry.eps === 1) return false;
  return true;
}

/** A linha de `animes` é de série? `media_type` vazio deixa o AnimeSchedule decidir. */
export function isRowSeriesFormat(row) {
  if (row?.media_type == null || row.media_type === '') return true;
  if (isExtraMediaType(row.media_type)) return false;
  return SERIES_FORMAT_SET.has(baseFormat(row.media_type));
}

/** A data de estreia do AnimeSchedule, ou null ("0001-01-01" é "sem data"). */
export function asPremiere(entry) {
  const ms = Date.parse(entry?.pr ?? '');
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 1900) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Exceções (data/series-overrides.json) ────────────────────────────────────

/**
 * Um nó do ficheiro de exceções: a rota do AnimeSchedule ("solo-leveling") ou
 * "mal:52299".
 */
function refKey(ref) {
  if (typeof ref === 'number') return `mal:${ref}`;
  const s = String(ref ?? '').trim();
  return /^mal:\d+$/i.test(s) ? s.toLowerCase() : s;
}

/**
 * `series-overrides.json` validado. Formas (todas opcionais; escreve sempre o
 * `why`, para quem vier depois):
 *
 *   join:    [{ refs: [a, b, …], why }]        junta estes nós numa série
 *                                               (mesmo um que a regra deixa de
 *                                               fora, como um especial)
 *   cut:     [{ refs: [a, b], why }]           corta a relação entre a e b
 *   split:   [{ ref, why }]                     tira o nó de qualquer série
 *   approve: [{ ref, why }]                     série grande (> 12) revista e
 *                                               aprovada; `ref` é um membro
 *   title:   [{ ref, title, why }]              nome da série que tem `ref`
 *   season:  [{ ref, season, part?, why }]      temporada (e parte) forçada
 */
export function parseSeriesOverrides(raw) {
  const out = { join: [], cut: [], split: new Set(), approve: new Set(), title: new Map(), season: new Map() };
  const arr = (v) => (Array.isArray(v) ? v : []);
  for (const j of arr(raw?.join)) {
    const refs = arr(j?.refs).map(refKey).filter(Boolean);
    if (refs.length >= 2) out.join.push(refs);
  }
  for (const c of arr(raw?.cut)) {
    const refs = arr(c?.refs).map(refKey).filter(Boolean);
    if (refs.length === 2) out.cut.push(refs);
  }
  for (const s of arr(raw?.split)) if (s?.ref != null) out.split.add(refKey(s.ref));
  for (const a of arr(raw?.approve)) if (a?.ref != null) out.approve.add(refKey(a.ref));
  for (const t of arr(raw?.title)) {
    if (t?.ref != null && typeof t.title === 'string' && t.title.trim() !== '') out.title.set(refKey(t.ref), t.title.trim());
  }
  for (const s of arr(raw?.season)) {
    const season = Number(s?.season);
    const part = s?.part == null ? null : Number(s.part);
    if (s?.ref != null && Number.isInteger(season) && season >= 0 && season < 100 && (part === null || (Number.isInteger(part) && part > 0 && part < 100))) {
      out.season.set(refKey(s.ref), { season, part });
    }
  }
  return out;
}

export const NO_SERIES_OVERRIDES = Object.freeze(parseSeriesOverrides({}));

// ── Componentes ──────────────────────────────────────────────────────────────

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * As componentes ligadas das relações sequela/prequela entre nós de série.
 * Devolve `{ components: string[][] (rotas), nodes: Map<rota, ficha>, bridged }`.
 * As exceções `join`/`cut`/`split` aplicam-se aqui.
 */
export function buildComponents(asEntries, overrides = NO_SERIES_OVERRIDES, { bridges = true } = {}) {
  const bridged = [];
  const byRoute = new Map();
  const routeByMal = new Map();
  for (const e of asEntries ?? []) {
    if (!e?.route || byRoute.has(e.route)) continue;
    byRoute.set(e.route, e);
    if (Number.isInteger(e.mal) && !routeByMal.has(`mal:${e.mal}`)) routeByMal.set(`mal:${e.mal}`, e.route);
  }
  const toRoute = (ref) => (ref.startsWith('mal:') ? routeByMal.get(ref) ?? null : byRoute.has(ref) ? ref : null);
  const splitRoutes = new Set([...overrides.split].map(toRoute).filter(Boolean));
  const forced = new Set();
  for (const refs of overrides.join) for (const r of refs.map(toRoute)) if (r) forced.add(r);

  const nodes = new Map();
  for (const [route, e] of byRoute) {
    if (splitRoutes.has(route)) continue;
    if (isAsSeriesNode(e) || forced.has(route)) nodes.set(route, e);
  }
  const cut = new Set();
  for (const [a, b] of overrides.cut) {
    const ra = toRoute(a);
    const rb = toRoute(b);
    if (ra && rb) cut.add(`${ra}\u0000${rb}`).add(`${rb}\u0000${ra}`);
  }
  const uf = new UnionFind();
  for (const route of nodes.keys()) uf.find(route);
  for (const [route, e] of nodes) {
    for (const other of [...e.seq, ...e.pre]) {
      if (other === route || !nodes.has(other) || cut.has(`${route}\u0000${other}`)) continue;
      uf.union(route, other);
    }
  }
  // A ponte: fichas que não são de série (filmes, OVAs, especiais) entre duas
  // que são, sempre no MESMO sentido: "KonoSuba 2" → filme "Kurenai Densetsu"
  // → "KonoSuba 3"; "Date A Live II" → OVA → filme → "Date A Live III";
  // "Psycho-Pass 2" → quatro filmes → "Psycho-Pass 3". Sem isto a série
  // partia-se. Só para a frente (sequela a sequela), no máximo MAX_BRIDGE
  // fichas pelo meio, e parando na primeira de série que se encontra.
  if (bridges) {
    const after = new Map();
    const add = (k, v) => (after.has(k) ? after.get(k).add(v) : after.set(k, new Set([v])));
    for (const [route, e] of byRoute) {
      for (const x of e.seq) add(route, x);
      for (const x of e.pre) add(x, route);
    }
    for (const a of nodes.keys()) {
      const seen = new Set([a]);
      let frontier = [...(after.get(a) ?? [])].filter((x) => byRoute.has(x) && !nodes.has(x) && !splitRoutes.has(x));
      const path = new Map(frontier.map((x) => [x, [x]]));
      for (let depth = 1; depth <= MAX_BRIDGE && frontier.length > 0; depth += 1) {
        const next = [];
        for (const x of frontier) {
          if (seen.has(x)) continue;
          seen.add(x);
          for (const y of after.get(x) ?? []) {
            if (seen.has(y) || !byRoute.has(y) || splitRoutes.has(y)) continue;
            if (nodes.has(y)) {
              if (!cut.has(`${a}\u0000${y}`)) {
                // Só se regista a ponte que juntou o que estava separado.
                if (uf.find(a) !== uf.find(y)) bridged.push({ de: a, por: path.get(x), para: y });
                uf.union(a, y);
              }
            } else if (!path.has(y)) {
              path.set(y, [...path.get(x), y]);
              next.push(y);
            }
          }
        }
        frontier = next;
      }
    }
  }
  for (const refs of overrides.join) {
    const routes = refs.map(toRoute).filter((r) => r && nodes.has(r));
    for (let i = 1; i < routes.length; i += 1) uf.union(routes[0], routes[i]);
  }
  const groups = new Map();
  for (const route of nodes.keys()) {
    const root = uf.find(route);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(route);
  }
  return { components: [...groups.values()], nodes, toRoute, bridged };
}

// ── Temporada e parte pelo nome ──────────────────────────────────────────────

const ORDINAL_WORDS = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ROMAN = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** "Season 2", "Second Season", "Final Season", "Part 2"… à frente de um nome (para cortar). */
const SEASON_MARKER =
  /(?:\s*[:\-]\s*|\s+)(?:the\s+)?(?:final\s+season|season\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+season|(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season|part\s+\d{1,2}(?!\s*:)|cour\s+\d{1,2}|\d(?:st|nd|rd|th)\s+(?:part|cour))\b/i;

/**
 * O número ou romano solto no fim (ou antes de ": subtítulo", " - …", " Part"):
 * "Shingeki no Kyojin 2", "Overlord II", "Mushoku Tensei II: Isekai…". De 2 a
 * 19, e nunca depois de "No." ou "#" ("Kaiju No. 8" é o nome, não a temporada)
 * nem de "Part" ("Spy x Family Part 2" é a parte 2, não a temporada 2).
 */
const TRAILING_NUMBER =
  /(?<!\b(?:no\.?|vol\.?|ep\.?|part|cour|season|episode|chapter|level|lv\.?)|#)\s+(\d{1,2}|II|III|IV|V|VI|VII|VIII|IX|X)(?=$|\s*:|\s+-\s|\s+part\b|\s+\()/i;

/**
 * O que o nome diz: `{ season, part, final }` (cada um null/false se não diz).
 * "Final Season" não tem número: quem atribui (`assignSeasons`) põe-lhe o
 * seguinte ao último.
 */
export function parseSeasonMarkers(name) {
  const s = normalizeDisplayName(String(name ?? ''));
  let season = null;
  const explicit = /\bseason\s+(\d{1,2})\b/i.exec(s) ?? /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i.exec(s);
  if (explicit) season = Number(explicit[1]);
  if (season === null) {
    const word = /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/i.exec(s);
    if (word) season = ORDINAL_WORDS[word[1].toLowerCase()];
  }
  const final = /\bfinal\s+season\b/i.test(s);
  if (season === null && !final) {
    const t = TRAILING_NUMBER.exec(s);
    if (t) {
      const raw = t[1];
      const n = /^\d+$/.test(raw) ? Number(raw) : ROMAN[raw.toUpperCase()] ?? null;
      // O romano só em maiúsculas: "Mob Psycho 100 II" sim, "… vi" (palavra) não.
      if (n !== null && n >= 2 && n <= 19 && (/^\d+$/.test(raw) || raw === raw.toUpperCase())) season = n;
    }
  }
  const partMatch =
    /\b(?:part|cour)\s+(\d{1,2})\b(?!\s*:)/i.exec(s) ?? /\b(\d)(?:st|nd|rd|th)\s+(?:part|cour)\b(?!\s*:)/i.exec(s);
  let part = partMatch ? Number(partMatch[1]) : null;
  // "Shimetsu Kaiyuu - Zenpen / Kouhen" (a primeira e a segunda metade).
  if (part === null && /\bzenpen\b/i.test(s)) part = 1;
  if (part === null && /\bkouhen\b/i.test(s)) part = 2;
  return { season, part, final };
}

/**
 * O que diz o PRIMEIRO nome que diz alguma coisa (temporada, parte ou "final"),
 * pela ordem dada: o nome que o site mostra primeiro. Não se misturam nomes:
 * o "Jujutsu Kaisen: Shimetsu Kaiyuu - Kouhen" é a parte 2 da temporada 3,
 * embora o inglês do AnimeSchedule lhe chame "Season 4: … Part 2".
 */
export function markersOf(names) {
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') continue;
    const m = parseSeasonMarkers(name);
    if (m.season !== null || m.part !== null || m.final) return m;
  }
  return { season: null, part: null, final: false };
}

/** O nome sem a temporada: "Solo Leveling Season 2: Arise from the Shadow" → "Solo Leveling". */
export function stripSeason(name) {
  let s = normalizeDisplayName(String(name ?? ''));
  const m = SEASON_MARKER.exec(s);
  if (m) s = s.slice(0, m.index);
  const t = TRAILING_NUMBER.exec(s);
  if (t) {
    const raw = t[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : ROMAN[raw.toUpperCase()] ?? null;
    // "Mushoku Tensei II: Isekai Ittara Honki Dasu" → "Mushoku Tensei: Isekai
    // Ittara Honki Dasu" (o subtítulo fica: é o nome da primeira);
    // "Overlord II" → "Overlord".
    if (n !== null && n >= 2 && n <= 19 && (/^\d+$/.test(raw) || raw === raw.toUpperCase())) {
      const rest = s.slice(t.index + t[0].length);
      s = /^\s*:/.test(rest) ? `${s.slice(0, t.index)}${rest}` : s.slice(0, t.index);
    }
  }
  return s
    .replace(/\s*\((?:TV|TV Series|\d(?:st|nd|rd|th)? Cour)\)\s*$/i, '')
    .replace(/[\s:\-~,]+$/, '')
    .trim();
}

/** Data de ordenação de um membro: a estreia do AnimeSchedule, senão o ano e a estação da linha. */
const SEASON_MONTH = { winter: '01', spring: '04', summer: '07', fall: '10', autumn: '10' };
export function premiereKey(member) {
  if (member.premiere) return member.premiere;
  const y = member.row?.year ?? member.as?.y ?? null;
  if (!Number.isInteger(y)) return '9999-12-31';
  const month = SEASON_MONTH[String(member.row?.season ?? '').toLowerCase()] ?? '06';
  return `${y}-${month}-15`;
}

/**
 * Ordem, temporada e parte de cada membro (já ordenados por estreia).
 * Devolve os membros com `order`, `season`, `part`, `seasonFrom` e as dúvidas.
 */
export function assignSeasons(members, overrides = NO_SERIES_OVERRIDES) {
  const sorted = [...members].sort(
    (a, b) =>
      premiereKey(a).localeCompare(premiereKey(b)) ||
      (a.as?.mal ?? a.row?.mal_id ?? Infinity) - (b.as?.mal ?? b.row?.mal_id ?? Infinity) ||
      String(a.row?.title).localeCompare(String(b.row?.title)),
  );
  const doubts = [];
  let maxSeason = 0;
  let prev = null;
  const used = new Map(); // temporada → membros
  for (const [i, m] of sorted.entries()) {
    m.order = i + 1;
    const forced = m.refs?.map((r) => overrides.season.get(r)).find(Boolean) ?? null;
    const mk = m.markers ?? { season: null, part: null, final: false };
    let season;
    let part = mk.part;
    let from;
    if (forced) {
      season = forced.season;
      part = forced.part ?? null;
      from = 'exceção';
    } else if (mk.season !== null && !(used.has(mk.season) && mk.season < maxSeason)) {
      season = mk.season;
      from = 'nome';
    } else if (mk.season !== null) {
      // "Alicization - War of Underworld 2nd Season": o "2" do nome é o cour,
      // e a temporada 2 já é outra linha. Fica como parte da anterior.
      season = prev?.season ?? maxSeason;
      part = (prev?.part ?? 1) + 1;
      from = 'nome repetido → parte';
      doubts.push({ tipo: 'temporada-repetida', membro: m.row.id, titulo: m.shown, temporadaNoNome: mk.season });
    } else if (mk.final) {
      season = prev?.markers?.final ? prev.season : maxSeason + 1;
      from = 'final';
    } else if (part !== null && part >= 2 && prev) {
      season = prev.season;
      from = 'parte';
    } else {
      season = maxSeason + 1;
      from = 'ordem';
    }
    m.season = season;
    m.part = part;
    m.seasonFrom = from;
    maxSeason = Math.max(maxSeason, season);
    if (!used.has(season)) used.set(season, []);
    used.get(season).push(m);
    prev = m;
  }
  // As partes: numa temporada com dois ou mais membros, o primeiro sem parte é
  // a parte 1 ("Season 3" ao lado de "Season 3 Part 2"); sozinho, sem parte.
  for (const [season, group] of used) {
    if (group.length < 2) continue;
    const taken = new Set(group.map((m) => m.part).filter((p) => p !== null));
    let next = 1;
    for (const m of group) {
      if (m.part !== null) continue;
      while (taken.has(next)) next += 1;
      m.part = next;
      taken.add(next);
    }
    const parts = group.map((m) => m.part);
    const semParte = group.filter((m) => m.markers?.part == null && !m.seasonFrom.startsWith('nome repetido')).length;
    if (semParte > 1) {
      doubts.push({ tipo: 'temporada-repetida', temporada: season, membros: group.map((m) => m.shown) });
    }
    if (new Set(parts).size !== parts.length) {
      doubts.push({ tipo: 'parte-repetida', temporada: season, membros: group.map((m) => m.shown) });
    }
  }
  return { members: sorted, doubts };
}

// ── Nome e endereço ──────────────────────────────────────────────────────────

/** O nome comercial de uma linha: o do site (`displayTitle`); se ainda for romaji, o inglês do AnimeSchedule. */
export function commercialName(row, as) {
  const shown = displayTitle(String(row?.title ?? ''), row?.alt_titles ?? []);
  if (isRomaji(shown) && as?.en) return normalizeDisplayName(as.en);
  return shown;
}

/** As palavras de um nome com a posição onde acabam: a base para cortar o nome sem lhe mexer na grafia. */
function wordSpans(name) {
  const out = [];
  for (const m of name.matchAll(/[\p{L}\p{N}]+/gu)) {
    const key = nameKey(m[0]);
    if (key !== '') out.push({ key, end: m.index + m[0].length });
  }
  return out;
}

/** Palavras que não acabam um nome de série ("Rascal Does Not Dream of" → "… Dream"). */
const DANGLING = new Set(['the', 'of', 'and', 'a', 'an', 'to', 'in', 'on', 'with', 'for', 'no', 'wa', 'ga', 'wo', 'ni', 'de', 'x']);

/**
 * O começo comum a todos os nomes, sem a temporada ("Demon Slayer" de "Demon
 * Slayer: Mugen Train Arc" e "… Hashira Training Arc"; "Dr. Stone" de "Dr.
 * Stone: New World" e "… Science Future"), na grafia mais vista. Só conta se
 * for o nome inteiro de pelo menos um membro (a primeira temporada, quase
 * sempre): "The World's" (de "The World's Best Assassin" e "The World's
 * Finest Assassin…") não é um nome. `null` se não houver.
 */
function commonName(names) {
  const bases = names.map(stripSeason).filter((b) => nameKey(b) !== '');
  if (bases.length === 0) return null;
  const spans = bases.map(wordSpans);
  let k = 0;
  for (;;) {
    const key = spans[0][k]?.key;
    if (key === undefined || spans.some((w) => w[k]?.key !== key)) break;
    k += 1;
  }
  while (k > 0 && DANGLING.has(spans[0][k - 1].key)) k -= 1;
  if (k === 0 || !spans.some((w) => w.length === k)) return null;
  const counts = new Map();
  for (const [i, base] of bases.entries()) {
    const cutAt = spans[i][k - 1].end;
    const cut = base.slice(0, cutAt).replace(/[\s:\-~,]+$/, '').trim();
    // Um "!" ou "?" do fim de um nome inteiro fica ("KONOSUBA: … world!").
    const tail = spans[i].length === k ? /^[.!?]+/.exec(base.slice(cutAt))?.[0] ?? '' : '';
    const name = `${cut}${tail}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = null;
  let n = -1;
  for (const [name, c] of counts) if (c > n) [best, n] = [name, c];
  return best;
}

/**
 * O nome da série.
 *
 *  1. O nome inglês do AnimeSchedule (`names.english`, a fonte licenciada do
 *     nome comercial, plano 5.2) quando a primeira temporada o tem: o começo
 *     comum (`commonName`) dos membros, cada um com o inglês dele ou, sem
 *     ele, o nome que o site mostra. Assim "Komi Can't Communicate" e "My
 *     Dress-Up Darling" ganham às traduções que o site ainda mostra.
 *  2. Senão, o mesmo com o nome que o site mostra (`displayTitle`): "Solo
 *     Leveling", "Spy x Family", "Jujutsu Kaisen".
 *  3. Se os dois dizem o mesmo a menos de maiúsculas e pontuação, fica a
 *     grafia do site (a guarda 2 do plano: nada de "MARRIAGETOXIN").
 *  4. Sem começo comum, o nome da primeira temporada sem a temporada; se ainda
 *     for romaji e houver o inglês, o inglês.
 */
export function seriesTitleFor(sortedMembers) {
  const shown = sortedMembers.map((m) => m.shown ?? '');
  const site = commonName(shown) ?? stripSeason(shown[0] ?? '');
  const root = sortedMembers[0];
  let title = site;
  if (root?.as?.en) {
    const asNames = sortedMembers.map((m) => (m.as?.en ? normalizeDisplayName(m.as.en) : m.shown ?? ''));
    const fromAs = commonName(asNames) ?? stripSeason(asNames[0]);
    if (fromAs !== '' && nameKey(fromAs) !== nameKey(site) && !isRomaji(fromAs)) title = fromAs;
  }
  if (title === '' || isRomaji(title)) {
    const en = root?.as?.en ? stripSeason(root.as.en) : '';
    if (en !== '') title = en;
  }
  return title === '' ? normalizeDisplayName(shown[0] ?? '') : title;
}

const ACCENT_MAP = new Map([...ACCENTS_FROM].map((ch, i) => [ch, [...ACCENTS_TO][i]]));

/** A MESMA regra que `public.anime_slugify` (migração 20260821000000). */
export function slugify(input) {
  let s = '';
  for (const ch of String(input ?? '')) s += ACCENT_MAP.get(ch) ?? ch;
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= 80) return s;
  // Teto de 80, cortado na fronteira de palavra.
  const cut = s.slice(0, 80).replace(/-[^-]*$/, '').replace(/^-+|-+$/g, '');
  return cut === '' ? s.slice(0, 80) : cut;
}

/**
 * O endereço da série. `taken.anime` é o mapa slug → id de TODOS os animes,
 * `taken.series` o conjunto dos endereços de série já dados.
 *
 *  - livre: fica;
 *  - é o de um MEMBRO ("spy-x-family"): a série herda-o (plano, 6.3) e, na
 *    fase 5, a ficha desse membro passa a responder 308 para a série;
 *  - é de outro anime ou de outra série: o ano da primeira temporada
 *    ("fruits-basket-2019"), senão o primeiro sufixo livre (-2, -3…), como a
 *    `anime_set_slug`.
 */
export function chooseSeriesSlug(title, fallback, memberIds, taken, year = null) {
  const natural = slugify(title) || slugify(fallback) || null;
  if (natural === null) return { slug: null, natural: null, inheritsFrom: null, collidedWith: null };
  const memberSet = new Set(memberIds);
  const ownerOf = (s) => taken.anime.get(s);
  const naturalOwner = ownerOf(natural);
  if (!taken.series.has(natural) && (naturalOwner === undefined || memberSet.has(naturalOwner))) {
    return { slug: natural, natural, inheritsFrom: naturalOwner ?? null, collidedWith: null };
  }
  // Primeiro o ano da primeira temporada ("fruits-basket-2019", ao lado do
  // "fruits-basket" de 2001): "-2" num endereço de série lê-se "temporada 2".
  const tries = [...(Number.isInteger(year) ? [`${natural}-${year}`] : []), ...Array.from({ length: 198 }, (_, i) => `${natural}-${i + 2}`)];
  for (const candidate of tries) {
    const owner = ownerOf(candidate);
    if (!taken.series.has(candidate) && (owner === undefined || memberSet.has(owner))) {
      return {
        slug: candidate,
        natural,
        inheritsFrom: owner ?? null,
        collidedWith: taken.series.has(natural) ? 'série' : naturalOwner ?? null,
      };
    }
  }
  return { slug: null, natural, inheritsFrom: null, collidedWith: naturalOwner ?? 'série' };
}

// ── O plano ──────────────────────────────────────────────────────────────────

const GENERIC_WORDS = new Set(['the', 'season', 'part', 'final', 'arc', 'hen', 'and', 'of', 'no', 'wa', 'ga', 'to', 'de', 'ni', 'tv']);
function distinctiveWords(name) {
  return new Set(
    nameKey(name)
      .split(' ')
      .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)),
  );
}

/**
 * O plano inteiro.
 *
 * @param asEntries fichas compactas do AnimeSchedule (`compactAsEntry`)
 * @param rows      linhas de `animes`: id, slug, title, alt_titles, media_type,
 *                  status, year, season, mal_id, animeschedule_route, popularity
 * @param aliases   Map rota → anime_id (`anime_route_aliases`), ou null
 * @param existingSeries  séries que já existem ({ key, slug }): a que tem a
 *                  mesma chave guarda o endereço (um endereço não muda), e os
 *                  das outras contam como ocupados
 */
export function planSeries({ asEntries, rows, aliases = null, overrides = NO_SERIES_OVERRIDES, existingSeries = [] }) {
  const { components, nodes, bridged } = buildComponents(asEntries, overrides);
  const bridgesByRoute = new Map();
  for (const b of bridged) for (const r of [b.de, b.para]) bridgesByRoute.set(r, [...(bridgesByRoute.get(r) ?? []), b]);
  const rowById = new Map();
  const rowByRoute = new Map();
  const rowByMal = new Map();
  const slugOwner = new Map();
  for (const r of rows) {
    rowById.set(r.id, r);
    if (r.animeschedule_route) rowByRoute.set(r.animeschedule_route, r);
    if (Number.isInteger(r.mal_id) && !rowByMal.has(r.mal_id)) rowByMal.set(r.mal_id, r);
    if (r.slug) slugOwner.set(r.slug, r.id);
  }
  const rowFor = (e) =>
    (aliases?.get(e.route) && rowById.get(aliases.get(e.route))) ||
    rowByRoute.get(e.route) ||
    (Number.isInteger(e.mal) ? rowByMal.get(e.mal) : undefined) ||
    null;

  const stats = {
    fichasAnimeSchedule: (asEntries ?? []).length,
    nosDeSerie: nodes.size,
    componentes: components.length,
    componentesComRelacao: 0,
    fichasSemLinha: 0,
    linhasForaDoFormato: 0,
    fichasNaMesmaLinha: 0,
    componentesDeUmaLinha: 0,
    series: 0,
    membros: 0,
    paraRevisao: 0,
    membrosParaRevisao: 0,
    revisaoPorMotivo: {},
    sinalizadas: 0,
    membrosSinalizados: 0,
    herdamSlug: 0,
    slugsComSufixo: 0,
  };
  const candidates = [];
  const claimed = new Map(); // anime id → índice do candidato que o tem
  const conflicts = [];
  for (const routes of components) {
    if (routes.length >= 2) stats.componentesComRelacao += 1;
    const members = new Map();
    for (const route of routes) {
      const e = nodes.get(route);
      const row = rowFor(e);
      if (!row) {
        if (routes.length >= 2) stats.fichasSemLinha += 1;
        continue;
      }
      if (!isRowSeriesFormat(row) && !overrides.join.some((refs) => refs.includes(route) || refs.includes(`mal:${e.mal}`))) {
        if (routes.length >= 2) stats.linhasForaDoFormato += 1;
        continue;
      }
      if (members.has(row.id)) {
        // Uma franquia já fundida (o Mushoku Tensei): várias fichas, uma linha.
        stats.fichasNaMesmaLinha += 1;
        const m = members.get(row.id);
        m.routes.push(route);
        m.refs.push(route, `mal:${e.mal}`);
        continue;
      }
      members.set(row.id, { row, as: e, routes: [route], refs: [route, `mal:${e.mal}`, `mal:${row.mal_id}`], premiere: asPremiere(e) });
    }
    if (members.size < 2) {
      if (routes.length >= 2) stats.componentesDeUmaLinha += 1;
      continue;
    }
    candidates.push([...members.values()]);
  }

  // Uma linha em duas componentes (pelo alias de um fold): fica na maior.
  candidates.sort((a, b) => b.length - a.length);
  const kept = [];
  for (const [i, list] of candidates.entries()) {
    const own = list.filter((m) => {
      const other = claimed.get(m.row.id);
      if (other !== undefined) {
        conflicts.push({ linha: m.row.id, titulo: m.row.title, ficouEm: other });
        return false;
      }
      claimed.set(m.row.id, i);
      return true;
    });
    if (own.length >= 2) kept.push(own);
  }

  const takenSeries = new Set(existingSeries.map((e) => e.slug).filter(Boolean));
  const keptSlug = new Map(existingSeries.filter((e) => e.slug).map((e) => [e.key, e.slug]));
  const planned = [];
  for (const list of kept) {
    for (const m of list) {
      m.shown = commercialName(m.row, m.as);
      m.markers = markersOf([m.shown, m.row.title, m.as?.en, m.as?.t]);
    }
    const { members, doubts } = assignSeasons(list, overrides);
    const root = members[0];
    const refs = members.flatMap((m) => m.refs);
    const titleOverride = refs.map((r) => overrides.title.get(r)).find(Boolean) ?? null;
    const title = titleOverride ?? seriesTitleFor(members);
    // Derivados possíveis: um membro sem nenhuma palavra do nome da série.
    const titleWords = distinctiveWords(title);
    for (const m of members) {
      const w = distinctiveWords(`${m.shown} ${m.row.title} ${m.as?.en ?? ''} ${m.as?.t ?? ''}`);
      if (titleWords.size > 0 && ![...titleWords].some((x) => w.has(x))) {
        doubts.push({ tipo: 'derivado?', membro: m.row.id, titulo: m.shown, porque: 'não partilha nenhuma palavra com o nome da série' });
      }
    }
    // Juntas só por uma ponte (um filme ou OVA pelo meio): o dono confirma.
    const memberRoutes = new Set(members.flatMap((m) => m.routes));
    const seenBridge = new Set();
    for (const r of memberRoutes) {
      for (const b of bridgesByRoute.get(r) ?? []) {
        const id = `${b.de}>${b.para}`;
        if (seenBridge.has(id) || !memberRoutes.has(b.de) || !memberRoutes.has(b.para)) continue;
        seenBridge.add(id);
        doubts.push({ tipo: 'ponte', de: b.de, por: b.por, para: b.para });
      }
    }
    const tooBig = members.length > MAX_MEMBERS;
    const approved = refs.some((r) => overrides.approve.has(r));
    const flagged = tooBig && !approved;
    // "Só os seguros" (decisão do dono, 2026-11-05): uma série com uma ponte
    // (um filme ou OVA pelo meio), um membro que pode ser derivado ou mais de
    // 12 membros não se escreve por omissão; fica para revisão. Aprovada em
    // `series-overrides.json` (`approve`), deixa de ficar.
    const reviewReasons = approved
      ? []
      : [
          ...(tooBig ? [`mais de ${MAX_MEMBERS} membros`] : []),
          ...(doubts.some((d) => d.tipo === 'ponte') ? ['ponte'] : []),
          ...(doubts.some((d) => d.tipo === 'derivado?') ? ['derivado?'] : []),
        ];
    const forcedByOverride = refs.some((r) => overrides.join.some((j) => j.includes(r)));
    const popularity = Math.max(0, ...members.map((m) => m.row.popularity ?? 0));
    planned.push({
      key: `as:${root.routes[0]}`,
      source: forcedByOverride ? 'override' : 'animeschedule',
      title,
      titleFrom: titleOverride ? 'exceção' : 'nome comercial',
      popularity,
      flagged,
      review: reviewReasons.length > 0,
      reviewReasons,
      flagReason: flagged ? `${members.length} membros (> ${MAX_MEMBERS}): rever e aprovar em series-overrides.json` : null,
      doubts,
      members: members.map((m) => ({
        id: m.row.id,
        slug: m.row.slug ?? null,
        title: m.row.title,
        shown: m.shown,
        media_type: m.row.media_type ?? null,
        status: m.row.status ?? null,
        year: m.row.year ?? null,
        popularity: m.row.popularity ?? null,
        routes: m.routes,
        mal: m.row.mal_id ?? m.as?.mal ?? null,
        premiere: m.premiere,
        order: m.order,
        season: m.season,
        part: m.part,
        seasonFrom: m.seasonFrom,
      })),
    });
  }

  // `series`/`membros`: o que o `--aplicar` escreve por omissão (as seguras).
  const count = (s) => {
    if (s.flagged) (stats.sinalizadas += 1), (stats.membrosSinalizados += s.members.length);
    if (s.review) {
      stats.paraRevisao += 1;
      stats.membrosParaRevisao += s.members.length;
      for (const r of s.reviewReasons) stats.revisaoPorMotivo[r] = (stats.revisaoPorMotivo[r] ?? 0) + 1;
    } else {
      stats.series += 1;
      stats.membros += s.members.length;
    }
  };
  // Os endereços por popularidade: a série mais seguida fica com o natural
  // quando duas o querem.
  planned.sort((a, b) => b.popularity - a.popularity || a.key.localeCompare(b.key));
  for (const s of planned) {
    if (keptSlug.has(s.key)) {
      s.slug = keptSlug.get(s.key);
      s.slugNatural = slugify(s.title) || null;
      s.inheritsSlugFrom = s.members.find((m) => m.slug === s.slug)?.slug ?? null;
      s.slugCollidedWith = null;
      s.slugKept = true;
      count(s);
      continue;
    }
    const firstYear = Number(String(s.members[0]?.premiere ?? '').slice(0, 4)) || s.members[0]?.year || null;
    const pick = chooseSeriesSlug(s.title, s.key.slice(3), s.members.map((m) => m.id), { anime: slugOwner, series: takenSeries }, firstYear);
    s.slug = pick.slug;
    s.slugNatural = pick.natural;
    s.inheritsSlugFrom = pick.inheritsFrom ? s.members.find((m) => m.id === pick.inheritsFrom)?.slug ?? pick.inheritsFrom : null;
    s.slugCollidedWith = pick.collidedWith ? rowById.get(pick.collidedWith)?.slug ?? pick.collidedWith : null;
    if (pick.slug) takenSeries.add(pick.slug);
    if (s.inheritsSlugFrom) stats.herdamSlug += 1;
    if (s.slugCollidedWith) stats.slugsComSufixo += 1;
    count(s);
  }
  return { series: planned, stats, conflicts };
}
