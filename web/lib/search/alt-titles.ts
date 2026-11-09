/**
 * Que outros nomes de um anime mostrar na ficha ("Also known as").
 *
 * `alt_titles` guarda TODOS os nomes latinos que as fontes conhecem, e é isso
 * que a pesquisa quer. Para ler, é demasiado: o manami mistura o nome inglês
 * oficial com abreviaturas ("BaruYome"), variantes do próprio romaji
 * ("Hime Kishi wa Barbaroi no Yome"), traduções de fãs ("The Bride of
 * Babaroi", com gralha) e traduções para meia Europa. Não diz qual é o
 * oficial, por isso aqui escolhe-se o que mais PARECE um título inglês:
 *
 *  - conta as palavras funcionais inglesas ("the", "of", "and"…) e desconta as
 *    partículas do romaji e as palavras de outras línguas ("no", "wa", "de",
 *    "los"…): "The Warrior Princess and the Barbaric King" ganha a "The
 *    Barbarian's Bride", e "Attack on Titan" a "L'Attaque des Titans";
 *  - no empate, o nome mais completo (mais palavras);
 *  - fora as variantes do título e as variantes umas das outras: quase iguais
 *    letra a letra ("Babaroi" e "Barbaroi") ou com as mesmas palavras em
 *    grande parte ("Saga of Tanya the Evil : Saison 2" ao lado de "Saga of
 *    Tanya the Evil II");
 *  - fora as alcunhas de uma palavra só ("AoT", "BaruYome") e os nomes que a
 *    fonte partiu a meio (aspas por fechar, a começar em pontuação);
 *  - só entra o que tem pelo menos uma palavra funcional inglesa: sem isso não
 *    se distingue "Frieren: Beyond Journey's End" de "Tutti all'arrembaggio!",
 *    e é melhor não mostrar nada do que mostrar italiano no One Piece;
 *  - no máximo `max`.
 *
 * Medido com os animes mais populares a 2026-09-28 (ver o teste).
 *
 * Módulo puro: testado em test/alt-titles.test.ts.
 */

/** A mesma ideia da `nimu_norm` da base: minúsculas, sem acentos nem pontuação. */
function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Igual ignorando espaços: "Hime Kishi wa…" é o mesmo que "Himekishi wa…". */
function compact(value: string): string {
  return normalize(value).replace(/ /g, "");
}

// Palavras funcionais: dizem a língua sem depender do vocabulário do título.
// "to", "a" e "na" ficam de fora das duas listas: existem em inglês, romaji e
// português ao mesmo tempo, e não decidem nada.
const ENGLISH = new Set([
  "the", "of", "and", "an", "in", "my", "with", "is", "for", "on", "at", "from",
  "your", "you", "this", "that", "into", "how", "what", "who", "when", "i", "me",
]);
const NOT_ENGLISH = new Set([
  // partículas do romaji
  "no", "wa", "ga", "ni", "wo", "de", "mo", "ka", "yo", "ne", "e",
  // espanhol, português, francês, italiano, alemão
  "la", "los", "las", "el", "del", "da", "das", "do", "dos", "le", "les", "des",
  "du", "di", "il", "der", "die", "und", "ein", "eine", "et", "y", "o", "sur",
  "dei", "degli", "della", "delle", "gli", "une", "un", "au", "aux",
  // "temporada" em várias línguas: variantes de lojas estrangeiras
  "staffel", "saison", "stagione", "temporada", "sezon", "sezonul",
]);

/** Parte das palavras em comum (Jaccard). Acima de 0,6 é o mesmo nome com outra roupa. */
function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return union > 0 && shared / union >= 0.6;
}

/** A fonte às vezes parte um nome nas vírgulas: `" I Became a Legend.` */
function looksBroken(name: string): boolean {
  if (!/^[\p{L}\p{N}(\[]/u.test(name)) return true;
  return (name.match(/"/g)?.length ?? 0) % 2 === 1;
}

function englishScore(words: readonly string[]): number {
  let score = 0;
  for (const word of words) {
    if (ENGLISH.has(word)) score += 1;
    else if (NOT_ENGLISH.has(word)) score -= 2;
  }
  return score;
}

/** Distância de edição, com teto: só interessa saber se é "quase igual". */
function nearlyEqual(a: string, b: string, maxEdits = 2): boolean {
  if (Math.abs(a.length - b.length) > maxEdits) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxEdits) return false;
    previous = current;
  }
  return previous[b.length] <= maxEdits;
}

export function displayAltTitles(
  title: string,
  altTitles: readonly string[] | null | undefined,
  max = 2,
): string[] {
  const titleKey = compact(title);
  const titleWords = new Set(normalize(title).split(" "));
  const candidates: {
    name: string;
    key: string;
    wordSet: Set<string>;
    score: number;
    words: number;
    overlap: number;
    index: number;
  }[] = [];
  (altTitles ?? []).forEach((raw, index) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    const key = compact(name);
    const words = normalize(name).split(" ").filter(Boolean);
    if (key === "" || words.length < 2 || looksBroken(name)) return;
    const wordSet = new Set(words);
    if (key === titleKey || nearlyEqual(key, titleKey) || sameWords(wordSet, titleWords)) return;
    candidates.push({
      wordSet,
      name,
      key,
      score: englishScore(words),
      words: words.length,
      // Entre duas grafias do mesmo nome, a que escreve como o título
      // ("Barbaroi") ganha à gralha ("Babaroi").
      overlap: words.filter((w) => titleWords.has(w)).length,
      index,
    });
  });

  const chosen: typeof candidates = [];
  for (const candidate of candidates.sort(
    (a, b) => b.score - a.score || b.words - a.words || b.overlap - a.overlap || a.index - b.index,
  )) {
    if (candidate.score < 1) break;
    if (
      chosen.some(
        (c) =>
          c.key === candidate.key ||
          nearlyEqual(c.key, candidate.key) ||
          sameWords(c.wordSet, candidate.wordSet),
      )
    ) {
      continue;
    }
    chosen.push(candidate);
    if (chosen.length >= max) break;
  }
  return chosen.map((c) => c.name);
}
