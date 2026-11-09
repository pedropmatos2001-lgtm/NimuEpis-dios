/**
 * O nome em inglês com que as pessoas PESQUISAM um anime cujo título guardado
 * está em romaji.
 *
 * ## Porquê (2026-10-01)
 *
 * Dos 60 animes no ar mais seguidos, 13 tinham o título em romaji: "Tsuki ga
 * Michibiku Isekai Douchuu 3rd Season", "Tokidoki Bosotto Russia-go de Dereru
 * Tonari no Alya-san", "Kono Subarashii Sekai ni Shukufuku wo! 4". E esse era
 * o `<title>` e o `<h1>` da ficha, enquanto quem pesquisa escreve "Tsukimichi
 * season 3", "Alya Sometimes Hides Her Feelings in Russian", "KonoSuba season
 * 4". O nome inglês já estava na base (`alt_titles`), só não era usado.
 *
 * ## Como escolhe (refeito a 2026-11-03)
 *
 * A base não diz qual dos `alt_titles` é o nome inglês OFICIAL: é um saco de
 * sinónimos (o do manami vem por ordem alfabética), com o oficial ao lado de
 * traduções de fãs ("I Am the Only the One Who Levels Up"), alcunhas ("sl",
 * "AoT") e traduções para meia Europa. A primeira versão deste módulo
 * contava palavras funcionais inglesas, e isso dava a vitória às traduções
 * literais dos fãs: em produção a ficha do "Shingeki no Kyojin" chamava-se
 * "Advancing Giants", a do Frieren "Frieren, the Final Farewell to the Dead"
 * e a do Kimetsu no Yaiba "Demon Slayer - A démonvadász" (húngaro).
 *
 * Só atua quando o título É romaji (partículas como "no", "wa", "ga", "na",
 * "dake", e nenhuma palavra funcional inglesa). Entre os outros nomes:
 *
 *  - fora o que não é inglês: letras fora do ASCII ("démonvadász", "Titãs"),
 *    partículas do romaji, palavras de outras línguas ("Staffel", "los");
 *  - fora a temporada errada (um nome da temporada 2 numa ficha da 3);
 *  - pontos, por ordem de peso:
 *     * **a sigla** (+6): se outro nome é a sigla deste ("sl" → "Solo
 *       Leveling", "AoT" → "Attack on Titan"), é o nome pelo qual a série é
 *       conhecida — ninguém abrevia uma tradução de fã;
 *     * **a família** (+1,5 por nome, até +4,5): outros nomes que começam por
 *       este e continuam ("Demon Slayer: Kimetsu no Yaiba", "Demon Slayer -
 *       …"): é a marca, de que as outras edições derivam;
 *     * **título com subtítulo** (+2): "Frieren: Beyond Journey's End", a
 *       forma das edições oficiais;
 *     * parecer inglês (até +3): palavras que acabam em consoante (o romaji
 *       acaba quase sempre em vogal ou "n"), e +1 se tiver ALGUMA palavra
 *       funcional ("the", "on") — só a presença, não a contagem, que era o
 *       que premiava as frases literais;
 *     * a mesma temporada do título (+2; sem temporada nenhuma, −2);
 *     * partilhar uma palavra própria com o título ("Frieren") (+1).
 *
 * ## As sequelas (2026-11-04)
 *
 * "Ore dake Level Up na Ken Season 2: Arise from the Shadow" (o Solo
 * Leveling 2) e "Shingeki no Kyojin: The Final Season" têm um subtítulo
 * inglês, com "from", "the"; a regra antiga via a palavra inglesa e dizia que
 * o título não era romaji, e a ficha ficava com ele. Agora:
 *
 *  - **romaji pela cabeça** (`headOf`): conta o título inteiro OU a parte
 *    antes de ": ", " - ", "Season N", "Nth Season", "Part N", de um romano
 *    ou de um número final. A deteção conhece também "kara", "hen", "sama",
 *    "tachi" e "isekai" ("Re:Zero kara…", "…Yuukaku-hen"), mas só para
 *    detetar: um candidato com "sama" ("Kaguya-sama: Love Is War") continua
 *    elegível;
 *  - **a marca** (+2, mais 1,5 por palavra): um outro nome curto, sem
 *    temporada, com sigla ("sl" → "Solo Leveling") ou com pelo menos dois
 *    nomes da família a começar por ele. Um candidato que começa pela marca
 *    ganha às traduções: é o que faz "Kaguya-sama: Love Is War" ganhar a
 *    "Kaguya Wants to Be Confessed to…" e "Solo Leveling Season 2: Arise…"
 *    ganhar a "Na Honjaman…";
 *  - **o título entre parênteses retos** ("[Oshi no Ko]") é a estilização
 *    oficial, o nome comercial: não se troca (os parênteses saem na
 *    apresentação, `normalizeDisplayName`);
 *  - **o subtítulo inglês do título fica**: "Attack on Titan The Final
 *    Season" passa a "Attack on Titan: The Final Season", com a cabeça
 *    traduzida e o subtítulo como o título o escreve;
 *  - **a parte** (o cour) conta como a temporada: "2nd Season Part 2" não é
 *    "Season 2" (o "Part 4:" do JoJo é um arco, não conta);
 *  - **um arco** ("…Shiken-hen") não fica com o nome da série sozinho;
 *  - os candidatos já vêm normalizados (`lib/titles/decorations.ts`): "X
 *    -Sub-" é "X: Sub", "2nd Season" é "Season 2".
 *
 * Continua a ser uma heurística: sem um campo "inglês oficial" na base, é o
 * melhor que os dados permitem. Os casos de produção estão no teste.
 */

import { normalizeDisplayName } from "../titles/decorations.ts";

const ROMAJI_PARTICLES = new Set([
  "no", "wa", "ga", "ni", "wo", "de", "mo", "ka", "yo", "ne", "suru", "shitara", "datta", "desu",
  // "Ore dake Level Up na Ken" (Solo Leveling): sem estas duas o título não
  // contava como romaji e a ficha ficava com ele.
  "na", "dake",
]);

/**
 * Só para DETETAR o romaji ("Re:Zero kara…", "…Yuukaku-hen", "Kaguya-sama
 * wa…"). Um candidato inglês pode tê-las ("Kaguya-sama: Love Is War"), por
 * isso não o excluem.
 */
const ROMAJI_HINTS = new Set(["kara", "hen", "sama", "tachi", "isekai"]);

/** As partículas mais as palavras de ligação que não distinguem um título. */
const ROMAJI_FILLER = new Set([...ROMAJI_PARTICLES, "kara", "made", "to", "e"]);

const ENGLISH_FUNCTION = new Set([
  "the", "of", "and", "an", "a", "in", "my", "with", "is", "for", "on", "at", "from", "your", "you",
  "this", "that", "into", "how", "what", "who", "when", "i", "me", "her", "his", "their", "to",
]);

const OTHER_LANGUAGE = new Set([
  "staffel", "saison", "stagione", "temporada", "sezon", "sezonul", "la", "los", "las", "el", "del",
  "le", "les", "des", "du", "di", "il", "der", "die", "und", "ein", "eine", "et", "y", "sur", "une",
]);

/** Palavras que não distinguem um título de outro. */
const GENERIC = new Set(["season", "part", "movie", "the", "of", "and", "arc", "special", "specials", "ova", "nd", "st", "rd", "th", "cour"]);

function words(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

/** A temporada que o nome diz, ou `null`. "3rd Season", "Season 3", "… 4", "… III". */
export function seasonOf(name: string): number | null {
  const w = words(name);
  const text = w.join(" ");
  const ordinal = /\b(\d{1,2})(?: ?(?:st|nd|rd|th))? season\b/.exec(text);
  if (ordinal) return Number(ordinal[1]);
  const after = /\bseason (\d{1,2})\b/.exec(text);
  if (after) return Number(after[1]);
  const last = w[w.length - 1];
  if (last !== undefined && /^\d$/.test(last)) return Number(last);
  if (last !== undefined && ROMAN[last] !== undefined) return ROMAN[last];
  return null;
}

/**
 * A parte (o cour) que o nome diz, ou `null`. "Part 2", "Part II", "Cour 2",
 * "2nd Part". Um "Part 4:" com subtítulo é o arco do JoJo ("Part 4: Diamond
 * is Unbreakable"), não um cour, e não conta.
 */
export function partOf(name: string): number | null {
  const text = normalizeDisplayName(name);
  const m =
    /\b(?:part|cour) (\d{1,2})\b(?!\s*:)/i.exec(text) ?? /\b(\d{1,2})(?:st|nd|rd|th) (?:part|cour)\b(?!\s*:)/i.exec(text);
  return m === null ? null : Number(m[1]);
}

/**
 * A cabeça do título: o que vem antes do subtítulo ou da temporada.
 * "Ore dake Level Up na Ken Season 2: Arise from the Shadow" → "Ore dake
 * Level Up na Ken"; "Shingeki no Kyojin: The Final Season" → "Shingeki no
 * Kyojin".
 */
export function headOf(title: string): string {
  const t = normalizeDisplayName(title);
  const cut = /(\s*:\s|\s+-\s|\s+\d+(st|nd|rd|th)\s+season\b|\s+season\s+\d+\b|\s+part\s+\d+\b|\s+(ii|iii|iv|v|vi)\b|\s+\d+\s*$)/i.exec(t);
  return cut === null ? t : t.slice(0, cut.index);
}

function romajiWords(w: readonly string[], hints: boolean): boolean {
  return (
    w.some((x) => ROMAJI_PARTICLES.has(x) || (hints && ROMAJI_HINTS.has(x))) &&
    !w.some((x) => ENGLISH_FUNCTION.has(x) && x !== "a" && x !== "to")
  );
}

/**
 * O título está em romaji? Partícula japonesa e nenhuma palavra funcional
 * inglesa, no título inteiro OU na cabeça (`headOf`): as sequelas juntam um
 * subtítulo inglês ao romaji. Na cabeça só contam as partículas: "Kaguya-sama:
 * Love Is War" é inglês, apesar do "sama".
 */
export function isRomaji(title: string): boolean {
  return romajiWords(words(title), true) || romajiWords(words(headOf(title)), false);
}

function looksEnglish(w: readonly string[]): number {
  const alpha = w.filter((x) => /^[a-z]+$/.test(x) && x.length > 1);
  if (alpha.length === 0) return 0;
  const consonantEnd = alpha.filter((x) => /[bcdfghjklmpqrstvwxyz]$/.test(x)).length;
  return consonantEnd / alpha.length;
}

/** Tem letras fora do ASCII? Um nome inglês oficial quase nunca tem ("Titãs", "démonvadász"). */
function hasNonAsciiLetter(name: string): boolean {
  for (const ch of name) if (ch > "\u007f" && /\p{L}/u.test(ch)) return true;
  return false;
}

/** As siglas que a lista traz: nomes de uma palavra só, de 2 a 6 letras ("sl", "AoT"). */
function acronymsIn(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const w = words(name);
    if (w.length === 1 && /^[a-z]{2,6}$/.test(w[0])) out.add(w[0]);
  }
  return out;
}

/** As iniciais de um nome: "Attack on Titan" → "aot". */
function initialsOf(w: readonly string[]): string {
  return w.filter((x) => /^[a-z]/.test(x)).map((x) => x[0]).join("");
}

/**
 * Os nomes de MARCA da lista: curtos (até 8 palavras, para caber "Re:Zero -
 * Starting Life in Another World"), sem temporada, sem romaji nem outra
 * língua, e com sigla ("sl" → "Solo Leveling") ou com pelo menos dois nomes
 * que começam por eles ("Kaguya-sama: Love Is War", "… Season 2", "… Ultra
 * Romantic"). O nome da personagem do título ("Senko", "Kamiina Botan") não
 * é marca: dava pontos às traduções de fãs que começam por ele.
 */
function brandsIn(
  all: readonly string[],
  keys: readonly string[],
  acronyms: ReadonlySet<string>,
  title: string,
): Set<string> {
  const titleWords = new Set(words(title));
  const titleTokens = new Set(title.split(/\s+/).map((token) => words(token).join(" ")));
  const out = new Set<string>();
  for (const name of all) {
    const w = words(name);
    if (w.length < 1 || w.length > 8 || seasonOf(name) !== null) continue;
    if (w.some((x) => ROMAJI_PARTICLES.has(x) || OTHER_LANGUAGE.has(x))) continue;
    // Palavras do próprio título ("Senko", "Kamiina Botan") são romaji, não
    // uma marca inglesa; a não ser que o título as escreva juntas como uma
    // marca ("Re:Zero", "Kaguya-sama").
    const key = w.join(" ");
    if (w.every((x) => titleWords.has(x)) && !titleTokens.has(key)) continue;
    const family = keys.filter((other) => other !== key && other.startsWith(`${key} `)).length;
    if (acronyms.has(initialsOf(w)) || family >= 2) out.add(key);
  }
  return out;
}

/**
 * O título é uma cabeça em romaji com um subtítulo inglês ("Ore dake Level Up
 * na Ken Season 2: Arise from the Shadow", "Shingeki no Kyojin: The Final
 * Season")? Devolve esse subtítulo, como está no título (" Season 2: Arise
 * from the Shadow", ": The Final Season"); senão `null`.
 */
function englishTailOf(title: string): string | null {
  if (romajiWords(words(title), true)) return null;
  const shown = normalizeDisplayName(title);
  const head = headOf(title);
  if (!shown.startsWith(head) || !romajiWords(words(head), false)) return null;
  const tail = shown.slice(head.length);
  const w = words(tail);
  if (!w.some((x) => ENGLISH_FUNCTION.has(x))) return null;
  if (w.some((x) => ROMAJI_PARTICLES.has(x) || ROMAJI_HINTS.has(x))) return null;
  return tail;
}

/**
 * "Attack on Titan The Final Season" com o subtítulo ": The Final Season":
 * a parte do nome antes do subtítulo ("Attack on Titan"), ou `null` se o nome
 * não acaba nele. Os candidatos só têm letras ASCII, por isso as palavras de
 * `words` são as mesmas que as de `[A-Za-z0-9]+`.
 */
function nameBefore(name: string, tail: string): string | null {
  const tailWords = words(tail);
  const spans = [...name.matchAll(/[A-Za-z0-9]+/g)];
  const n = tailWords.length;
  if (n === 0 || spans.length <= n) return null;
  const last = spans.slice(spans.length - n).map((m) => m[0].toLowerCase());
  if (last.some((x, i) => x !== tailWords[i])) return null;
  const head = name.slice(0, spans[spans.length - n].index).replace(/[\s:,-]+$/, "");
  return head === "" ? null : head;
}

/**
 * Uma alcunha toda em minúsculas ("death march", "kimimachi tv") ou um pedaço
 * de nome partido pela fonte, a começar por uma palavra funcional em
 * minúscula ("and the Magic Lantern", "the Giant"). As fontes guardam-nas
 * como etiquetas de pesquisa; nenhuma é o nome comercial ("xxxHOLiC" e
 * "anohana: The Flower We Saw That Day" continuam a contar). Continuam a
 * contar para as siglas e para a família (`acronymsIn`, `brandsIn`); só não
 * podem ser o nome escolhido.
 */
function isLowercaseAlias(name: string): boolean {
  if (!/\p{Lu}/u.test(name)) return true;
  const first = /^\p{Ll}+/u.exec(name);
  return first !== null && ENGLISH_FUNCTION.has(first[0]);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * O próprio título com outra grafia, e não uma tradução: "GO! GO! TOKYO MER
 * ~Kinkyuujitai to Tatakau Nakamatchi~" ao lado de "Go! Go! Tokyo MER:
 * Kinkyuujitai to Tatakau Nakama-tachi". Duas condições:
 *  - as letras e os dígitos, sem espaços nem pontuação, quase iguais (90%);
 *    "My Hero Academia" e "Boku no Hero Academia" ficam longe (72%);
 *  - nenhuma palavra inglesa nova: "Tokyo Revengers: Tenjiku Arc" (de
 *    "…Tenjiku-hen") e "Shigeo is Handsome" (de "Shigeo wa Handsome") são
 *    traduções, mesmo com as letras quase iguais.
 */
function isSpellingOf(name: string, title: string): boolean {
  const nameWords = words(name);
  const titleWords = new Set(words(title));
  if (nameWords.some((x) => !titleWords.has(x) && (ENGLISH_FUNCTION.has(x) || GENERIC.has(x)))) return false;
  const a = nameWords.join("");
  const b = [...words(title)].join("");
  if (a === "" || b === "") return false;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length) >= 0.9;
}

/**
 * A sigla ao lado do nome por extenso: "CSM - The Movie: Reze Arc" quando há
 * "Chainsaw Man - The Movie: Reze Arc". A sigla (2 a 5 maiúsculas no
 * princípio) é uma alcunha; o nome por extenso, com o mesmo resto, é o
 * comercial. "SPY x FAMILY" não é sigla de nada: o outro nome começa pela
 * mesma palavra.
 */
function isAbbreviationOfAnother(name: string, all: readonly string[]): boolean {
  const first = /^([A-Z]{2,5})(?![\p{L}\p{N}])/u.exec(name);
  if (first === null) return false;
  const letters = first[1].toLowerCase();
  const rest = words(name).slice(1);
  if (rest.length === 0) return false;
  const restKey = rest.join(" ");
  return all.some((other) => {
    if (other === name) return false;
    const w = words(other);
    if (w.length <= rest.length || w.slice(w.length - rest.length).join(" ") !== restKey) return false;
    // A sigla tem as iniciais das palavras por extenso, por ordem ("CSM":
    // Chainsaw Man), e as letras todas aparecem nelas por ordem.
    const headWords = w.slice(0, w.length - rest.length);
    const head = headWords.join("");
    if (headWords.length < 2 || head[0] !== letters[0]) return false;
    let at = 0;
    for (const word of headWords) {
      at = letters.indexOf(word[0], at);
      if (at < 0) return false;
      at += 1;
    }
    let i = 0;
    for (const ch of head) if (ch === letters[i]) i += 1;
    return i === letters.length;
  });
}

export function englishSearchName(title: string, altTitles: readonly string[] | null | undefined): string | null {
  // "[Oshi no Ko]": a estilização oficial É o nome comercial.
  if (/^\s*\[/.test(title)) return null;
  if (!isRomaji(title)) return null;
  const titleWords = words(title);
  const titleSeason = seasonOf(title);
  const titlePart = partOf(title);
  const distinctive = new Set(titleWords.filter((x) => x.length > 3 && !GENERIC.has(x) && !ROMAJI_FILLER.has(x)));
  // Um arco ("Mashle: Shinkakusha Kouho Senbatsu Shiken-hen"): o nome da
  // série sozinho ("Mashle: Magic and Muscles") diria a temporada errada.
  const isArc = words(title.slice(headOf(title).length)).some((x) => x === "hen" || x === "arc");
  // Os candidatos já sem decorações: "TSUKIMICHI -Moonlit Fantasy-" conta
  // como "TSUKIMICHI: Moonlit Fantasy", com os pontos do subtítulo.
  const all = (altTitles ?? [])
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => normalizeDisplayName(raw));
  const acronyms = acronymsIn(all);
  const keys = all.map((name) => words(name).join(" "));
  const brands = brandsIn(all, keys, acronyms, title);

  let best: { name: string; score: number } | null = null;
  for (const name of all) {
    // Só alfabeto latino sem acentos, sem anos entre parênteses ("Blue Box
    // (2026)") nem nomes partidos pela fonte.
    if (name === "" || hasNonAsciiLetter(name) || /[^\u0000-ɏ‘’“”–—★☆]/.test(name)) continue;
    if (/\(\d{4}\)/.test(name) || !/^[\p{L}\p{N}(\[]/u.test(name)) continue;
    const w = words(name);
    if (w.filter((x) => /^[a-z]+$/.test(x)).length < 2) continue;
    if (w.some((x) => ROMAJI_PARTICLES.has(x) || OTHER_LANGUAGE.has(x))) continue;
    // Alcunhas e o próprio título com outra grafia nunca são o nome comercial.
    if (isLowercaseAlias(name) || isSpellingOf(name, title) || isAbbreviationOfAnother(name, all)) continue;

    const season = seasonOf(name);
    if (titleSeason !== null && season !== null && season !== titleSeason) continue;
    const english = looksEnglish(w);
    // A palavra funcional não conta dentro de uma palavra com hífen: "You-Zitsu"
    // (do "Youkoso Jitsuryoku…") é uma alcunha, não um nome inglês com "you".
    const hasFunction = words(name.replace(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu, " ")).some((x) => ENGLISH_FUNCTION.has(x));
    if (english < 0.34 && !hasFunction) continue;

    let score = english * 3 + (hasFunction ? 1 : 0);
    if (titleSeason !== null) score += season === titleSeason ? 2 : -1;
    else if (season !== null) score -= 2;
    // A parte (o cour) também: "2nd Season Part 2" não é "Season 2".
    const part = partOf(name);
    if (titlePart !== null) score += part === titlePart ? 2 : -2;
    if (w.some((x) => distinctive.has(x))) score += 1;
    if (/\S: \S/.test(name)) score += 2;
    if (acronyms.has(initialsOf(w))) score += 6;
    const key = w.join(" ");
    const family = keys.filter((other) => other !== key && other.startsWith(`${key} `)).length;
    score += Math.min(family, 3) * 1.5;
    // A marca: começa por (ou é) um nome de marca da família; a mais longa
    // conta. Num arco, a marca sozinha não ganha pontos.
    let brandWords = 0;
    for (const brand of brands) {
      if (isArc && key === brand) continue;
      if (key === brand || key.startsWith(`${brand} `)) brandWords = Math.max(brandWords, brand.split(" ").length);
    }
    if (brandWords > 0) score += 2 + 1.5 * brandWords;

    if (best === null || score > best.score) best = { name, score };
  }
  if (best === null) return null;
  const chosen = best.name;
  // Cabeça em romaji com subtítulo inglês: o nome inglês da cabeça mais o
  // subtítulo tal como o título o escreve ("Attack on Titan The Final
  // Season" → "Attack on Titan: The Final Season").
  const tail = englishTailOf(title);
  const head = tail === null ? null : nameBefore(chosen, tail);
  if (tail !== null && head !== null) return `${head}${tail}`;
  // O nome inglês da série sem a temporada (ou sem a parte), numa ficha que a
  // tem: junta-se. É o "season 2" que vai na pesquisa.
  const withSeason = titleSeason !== null && seasonOf(chosen) === null ? `${chosen} Season ${titleSeason}` : chosen;
  return titlePart !== null && partOf(withSeason) === null ? `${withSeason} Part ${titlePart}` : withSeason;
}
