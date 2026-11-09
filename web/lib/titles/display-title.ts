/**
 * O nome que se MOSTRA de um anime, e os outros nomes.
 *
 * ## A regra (pedido do dono, 2026-11-03)
 *
 * O nome inglês oficial quando existe; senão, o título principal. O "Solo
 * Leveling", das séries mais vistas, aparecia como "Ore dake Level Up na Ken",
 * com o nome conhecido escondido no "Também conhecido como".
 *
 * A base tem `animes.title` (o do manami, quase sempre o romaji, ou o inglês
 * nas linhas do AnimeSchedule) e `animes.alt_titles` (os sinónimos, sem
 * nenhum marcado como oficial). Por isso o "inglês oficial" é o que
 * `englishSearchName` escolhe entre os sinónimos (ver lá porquê e como),
 * e só quando o título é romaji.
 *
 * ## Onde se aplica
 *
 * Na fronteira dos dados (`lib/data/mappers.ts` e afins): o `title` de um
 * `AnimeSummary` JÁ é este nome, e o guardado fica em `storedTitle`. Assim os
 * cartazes, o calendário, a Biblioteca, a pesquisa, as Notícias, a ficha, o
 * `<title>` e o JSON-LD dizem todos o mesmo, sem cada ecrã ter de se lembrar.
 * A pesquisa continua a procurar em todos os nomes (`search_blob`, na base).
 *
 * ## A forma (2026-11-04)
 *
 * O nome mostrado e os outros nomes passam por `normalizeDisplayName`
 * (`lib/titles/decorations.ts`): "Solo Leveling Season 2 -Arise from the
 * Shadow-" é "Solo Leveling Season 2: Arise from the Shadow", "Ranma ½
 * (2024) 3rd Season" é "Ranma ½ (2024) Season 3", "[Oshi no Ko]" é "Oshi no
 * Ko". Nenhum ecrã mostra um hífen solto nas pontas de um nome.
 *
 * Módulo puro: testado em `test/display-title.test.ts`, e usado também pelo
 * `e2e/global-setup.ts` para os testes saberem o que a ficha vai mostrar.
 */

import { displayAltTitles } from "../search/alt-titles.ts";
import { englishSearchName } from "../seo/english-name.ts";
import { normalizeDisplayName, sameName } from "./decorations.ts";

export { normalizeDisplayName, sameName } from "./decorations.ts";

/** O nome a mostrar: o inglês oficial, se o título é romaji e ele existe, já sem decorações. */
export function displayTitle(title: string, altTitles: readonly string[] | null | undefined): string {
  const shown = normalizeDisplayName(englishSearchName(title, altTitles) ?? title);
  // Nunca vazio: um guardado que é só decoração ("-", "~") fica como está.
  return shown === "" ? title : shown;
}

/**
 * O "Também conhecido como": o título guardado primeiro (o romaji, quando o
 * que se mostra é o inglês), depois os outros nomes legíveis
 * (`displayAltTitles`), sem repetir o que já se vê. No máximo `max`.
 *
 * Tudo sem decorações, e sem o guardado quando ele é só o mostrado com outra
 * pontuação ("Tsukimichi -Moonlit Fantasy- Season 2" ao lado de "Tsukimichi:
 * Moonlit Fantasy Season 2", "[Oshi no Ko]" ao lado de "Oshi no Ko").
 */
export function otherNames(
  shown: string,
  storedTitle: string,
  altTitles: readonly string[] | null | undefined,
  max = 2,
): string[] {
  const names: string[] = [];
  for (const raw of [storedTitle, ...displayAltTitles(shown, altTitles ?? [], max + 1)]) {
    const name = normalizeDisplayName(raw);
    if (name === "" || sameName(name, shown) || names.some((other) => sameName(other, name))) continue;
    names.push(name);
  }
  return names.slice(0, max);
}
