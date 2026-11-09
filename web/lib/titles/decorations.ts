/**
 * A forma de um nome antes de ir para um ecrã: as decorações das fontes fora.
 *
 * ## Porquê (2026-11-04)
 *
 * Os nomes chegam do manami e do AnimeSchedule com a pontuação de cada
 * edição japonesa: "Solo Leveling Season 2 -Arise from the Shadow-",
 * "TSUKIMICHI -Moonlit Fantasy- Season 3", "Kaguya-sama : Love Is War",
 * "Ranma ½ (2024) 3rd Season", "[Oshi no Ko]". Num cartaz, um hífen solto no
 * fim do nome parece um erro, e a mesma série dizia "2nd Season" numa ficha
 * e "Season 2" na seguinte. O dono quer o nome comercial, escrito sempre da
 * mesma maneira.
 *
 * ## O que muda
 *
 *  - os caracteres invisíveis saem (havia espaços de largura zero no
 *    "Failure Frame" e no "#I'm Looking For a Zombie");
 *  - "X -Sub-" e "X ~Sub~" passam a "X: Sub". Se já houver ":" antes, passam
 *    a "X: Y - Sub", para não haver dois ":" seguidos. Só conta como
 *    decoração o hífen colado ao subtítulo: "Sword Art Online - Alicization -
 *    War of Underworld" fica como está;
 *  - um hífen ou um til sem par, colado ao fim ("Moonlit Fantasy-") ou ao
 *    princípio do nome, sai;
 *  - os travessões (– e —) passam a hífen: é a regra da casa para o texto que
 *    se vê (`test/i18n-separators.test.ts`);
 *  - " : " passa a ": ";
 *  - os honoríficos vão em minúsculas ("Kaguya-Sama" fica "Kaguya-sama");
 *  - os parênteses retos do princípio saem ("[Oshi no Ko]" fica "Oshi no Ko");
 *  - o espaço antes do "!" e do "?" sai ("Big Four !" fica "Big Four!");
 *  - "2nd Season" passa a "Season 2", "3rd Season" a "Season 3", e assim por
 *    diante; "Part II" passa a "Part 2", e "Season 2: Part 2" a "Season 2
 *    Part 2".
 *
 * É idempotente: passar duas vezes dá o mesmo que passar uma.
 *
 * Módulo puro: testado em `test/display-title.test.ts`.
 */

/**
 * "X -Sub-" ou "X ~Sub~": o hífen de abrir tem espaço antes e está colado ao
 * subtítulo, o de fechar está colado ao fim dele. Lá dentro pode haver hífenes
 * de palavras ("-Ergam-se das Sombras-").
 */
const PAIRED = /\s[-~]([^\s\-~](?:.*?[^\s\-~])?)[-~](?=\s|$|[!?.,:;])/g;

/** "X -Sub" sem o hífen de fechar, até ao fim do nome. */
const OPEN_TO_END = /\s[-~]([^\s\-~].*[^\s\-~]|[^\s\-~])$/;

const PART_ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4 };

export function normalizeDisplayName(name: string): string {
  let s = name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  // Travessões: espaçados ficam " - ", colados ficam "-".
  s = s.replace(/\s*[–—]\s*/g, (m) => (/\s/.test(m) ? " - " : "-"));
  s = s.replace(PAIRED, (_m, sub: string, offset: number, all: string) =>
    all.slice(0, offset).includes(":") ? ` - ${sub}` : `: ${sub}`,
  );
  s = s.replace(OPEN_TO_END, (_m, sub: string, offset: number, all: string) =>
    all.slice(0, offset).includes(":") ? ` - ${sub}` : `: ${sub}`,
  );
  // Hífens e tis soltos nas pontas.
  s = s.replace(/\s*[-~]+\s*$/, "").replace(/^[-~]+\s*/, "");
  s = s.replace(/\s+:\s*/g, ": ");
  s = s.replace(/^\[([^\]]+)\]/, "$1");
  s = s.replace(/\b(\d{1,2})(?:st|nd|rd|th) Season\b/gi, "Season $1");
  // "Season 3rd Season" (há fontes que o escrevem) fica "Season 3".
  s = s.replace(/\bSeason (Season \d{1,2}\b)/gi, "$1");
  // "Part II" fica "Part 2", como "Season 2".
  s = s.replace(/\bPart (II|III|IV)\b/g, (_m, roman: string) => `Part ${PART_ROMAN[roman]}`);
  // "Season 2: Part 2" fica "Season 2 Part 2".
  s = s.replace(/\b(Season \d{1,2}):\s+(Part \d{1,2})\b/gi, "$1 $2");
  // "Kaguya-Sama" fica "Kaguya-sama": o honorífico escreve-se em minúsculas.
  s = s.replace(/-(Sama|Kun|San|Chan|Senpai|Sensei|Dono)\b/g, (_m, honorific: string) => `-${honorific.toLowerCase()}`);
  s = s.replace(/:\s*:/g, ":").replace(/\s{2,}/g, " ").trim();
  // "Big Four !", "Wizard ?!": o espaço antes do "!" e do "?" é da tipografia
  // francesa das fontes; em inglês e em português cola-se à palavra.
  s = s.replace(/(?<=[\p{L}\p{N}])\s+([!?]+)(?=\s|$|[:)\]])/gu, "$1");
  return s;
}

/** A chave de comparação: minúsculas, sem acentos nem pontuação, "2nd Season" = "Season 2". */
export function nameKey(name: string): string {
  return normalizeDisplayName(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** O mesmo nome com outra pontuação ("Tsukimichi -Moonlit Fantasy-" e "Tsukimichi: Moonlit Fantasy")? */
export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}
