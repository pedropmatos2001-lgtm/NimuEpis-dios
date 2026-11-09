// Pure franchise-grouping logic: decide WHICH split catalogue rows are really
// the same TheTVDB series and HOW their per-cour episodes line up on that
// series' absolute timeline. No I/O here — every function is a deterministic
// transform the unit tests and `catalogue-franchises.js --dry-run` exercise
// directly (the CLI does the network/DB side, exactly like catalogue.js splits
// pure mappers from its runner).
//
// The grouping key is the shared **TheTVDB series id** (external_ids.tvdb).
// TVDB models a whole franchise — Mushoku Tensei, Slime, … — as ONE series with
// seasons + absolute episode numbering; AnimeSchedule instead emits one
// catalogue row per cour. So two `animes` rows that resolve to the SAME tvdb
// series id are, by definition, two cours of one franchise. That shared id is
// the authoritative "same show" signal; the air-date alignment below is a
// second gate that refuses to fold a row whose episodes do NOT actually line up
// with the series (a defensive guard against a wrong title-search hit).

// ── Title normalisation (for franchise-aware id resolution) ──────────────────

/**
 * Strip the season/cour/part ordinal off a catalogue title to get the FRANCHISE
 * root, e.g. "Mushoku Tensei: Jobless Reincarnation 3" → "Mushoku Tensei:
 * Jobless Reincarnation", "That Time I Got Reincarnated as a Slime 4th Season"
 * → "That Time I Got Reincarnated as a Slime". TheTVDB models the whole
 * franchise as ONE series named after its root, and — crucially — that series'
 * first-air YEAR is season 1's, so a later cour's own title+year never matches
 * it; searching the stripped root (without the year) is what finds the shared
 * series id for the split rows.
 *
 * Deliberately conservative: it only removes trailing/− ordinal markers and
 * OVA/Movie/Special tags, never interior words, so it won't collapse two
 * genuinely different titles together. Returns the trimmed root (possibly equal
 * to the input, when there is no ordinal to strip).
 */
export function baseFranchiseTitle(title) {
  let s = String(title ?? '');
  // Season / cour / part ordinals, roman numerals, OVA/Movie/Special tags.
  s = s.replace(
    /\b(Part\s*\d+|Cour\s*\d+|\d+(st|nd|rd|th)\s+Season|Season\s*\d+|II|III|IV|V|VI|OVA|ONA|Specials?|Movies?.*)\b/gi,
    ' ',
  );
  s = s.replace(/\s+\d+\s*$/, ' '); // a trailing bare number ("… 3")
  s = s.replace(/[:\-–—]\s*$/, ' '); // a now-dangling separator
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/** The TheTVDB series id stored on a catalogue row, or null when absent/invalid. */
export function tvdbIdOf(row) {
  const raw = row?.external_ids?.tvdb;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Group catalogue rows by their shared TheTVDB series id. Rows without a tvdb
 * id are ignored (they carry no grouping signal). Returns a Map keyed by the
 * numeric tvdb id → the rows that share it, in input order.
 */
export function groupByTvdbId(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const id = tvdbIdOf(row);
    if (id === null) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
}

// ── Alignment (a member cour → the franchise's absolute timeline) ─────────────

const DAY_MS = 86400000;

/**
 * Work out where one member cour sits on the franchise's absolute TVDB
 * timeline, by matching that member's OWN episodes (the AnimeSchedule calendar,
 * numbered per-cour from 1) to the TVDB episode list by AIR DATE.
 *
 * For every member episode we find the nearest TVDB episode by aired date
 * (within `toleranceDays`, absorbing the sub-vs-broadcast / timezone / date-only
 * skew) and derive a candidate offset:
 *     offset = tvdbAbsoluteNumber − memberEpisodeNumber
 * so that   canonicalEpisodeNumber = memberEpisodeNumber + offset.
 * The MODAL offset across all of the member's episodes wins — a single stray
 * date can never move the whole cour, because the correct alignment produces the
 * same offset for every episode while noise scatters. `seasonNumber` is the
 * modal TVDB seasonNumber among the episodes that voted for the winning offset.
 *
 * Returns { episodeOffset, seasonNumber, matched, votes, total }:
 *   - matched=false with offset 0 / season null when nothing lined up (either
 *     the member has no dated episodes yet, or — the guard — its episodes do NOT
 *     belong to this series and it should NOT be folded on episode evidence).
 *
 * @param {Array} memberEpisodes  [{ episode_number, airing_at }]
 * @param {Array} tvdbEpisodes    from tvdb-episodes.js normalizeEpisodes()
 */
export function alignMemberToTvdb(memberEpisodes, tvdbEpisodes, { toleranceDays = 4 } = {}) {
  const tvdb = [];
  for (const e of tvdbEpisodes ?? []) {
    const ms = e?.airedIso ? Date.parse(e.airedIso) : NaN;
    if (Number.isFinite(ms) && Number.isInteger(e?.episodeNumber)) {
      tvdb.push({ day: Math.floor(ms / DAY_MS), absolute: e.episodeNumber, season: e.seasonNumber });
    }
  }

  const offsetVotes = new Map(); // offset → count
  const seasonByOffset = new Map(); // offset → Map(season → count)
  let total = 0;
  for (const m of memberEpisodes ?? []) {
    const num = Number(m?.episode_number);
    const ms = m?.airing_at ? Date.parse(m.airing_at) : NaN;
    if (!Number.isInteger(num) || !Number.isFinite(ms)) continue;
    total += 1;
    const day = Math.floor(ms / DAY_MS);

    let best = null;
    let bestDiff = Infinity;
    for (const t of tvdb) {
      const diff = Math.abs(t.day - day);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = t;
      }
    }
    if (!best || bestDiff > toleranceDays) continue;

    const offset = best.absolute - num;
    offsetVotes.set(offset, (offsetVotes.get(offset) ?? 0) + 1);
    if (!seasonByOffset.has(offset)) seasonByOffset.set(offset, new Map());
    if (Number.isInteger(best.season)) {
      const sm = seasonByOffset.get(offset);
      sm.set(best.season, (sm.get(best.season) ?? 0) + 1);
    }
  }

  // Modal offset (ties → the smaller offset, i.e. the earlier position).
  let winOffset = null;
  let winVotes = 0;
  for (const [off, v] of offsetVotes) {
    if (v > winVotes || (v === winVotes && (winOffset === null || off < winOffset))) {
      winVotes = v;
      winOffset = off;
    }
  }
  if (winOffset === null) {
    return { episodeOffset: 0, seasonNumber: null, matched: false, votes: 0, total };
  }

  // Modal season among the episodes that agreed on the winning offset.
  let winSeason = null;
  let winSeasonVotes = -1;
  for (const [s, v] of seasonByOffset.get(winOffset) ?? []) {
    if (v > winSeasonVotes) {
      winSeasonVotes = v;
      winSeason = s;
    }
  }
  return { episodeOffset: winOffset, seasonNumber: winSeason, matched: true, votes: winVotes, total };
}

// ── Canonical selection ──────────────────────────────────────────────────────

/** Lexicographic compare of two rank tuples (numbers or strings, same shape). */
function cmpTuple(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Choose the canonical row a franchise folds into: the ORIGIN cour (season 1).
 * Keeping the ORIGIN canonical matters — its own episodes are already at their
 * absolute numbers (offset 0), so nothing on the canonical needs renumbering and
 * its route needs no weekly-pipeline offset. The catch these split franchises
 * expose: the origin is often an episode-less catalogue stub (imported metadata),
 * while the only air-date-MATCHED row is a *later* airing cour. Picking that
 * later cour would drop its per-cour episodes onto season 1's absolute slots and
 * corrupt the timeline — so origin selection must NOT just follow the match.
 *
 * Rank (ascending) — first key dominates:
 *   1. the DEFINITIVE origin (matched AND offset 0) before anything else,
 *   2. the ROOT title (no season/part ordinal) before an ordinal'd one — this
 *      separates "… Honki Dasu" (season 1) from "… Honki Dasu Part 2", which
 *      share a year and would otherwise tie,
 *   3. earliest year — season 1 aired first,
 *   4. smallest matched offset (an earlier cour) as a fallback,
 *   5. most popular, 6. id — pure determinism.
 *
 * @param {Array} members [{ id, title, popularity, year, alignment }]
 */
export function pickCanonical(members) {
  const BIG = Number.MAX_SAFE_INTEGER;
  const hasOrdinal = (t) => (baseFranchiseTitle(t) === String(t ?? '').trim() ? 0 : 1);
  const rank = (m) => [
    m.alignment?.matched && m.alignment.episodeOffset === 0 ? 0 : 1,
    hasOrdinal(m.title),
    Number.isInteger(m.year) ? m.year : BIG,
    m.alignment?.matched ? m.alignment.episodeOffset : BIG,
    -(Number.isFinite(m.popularity) ? m.popularity : -1),
    m.id ?? '',
  ];
  return [...members].sort((a, b) => cmpTuple(rank(a), rank(b)))[0] ?? null;
}

// ── Planning a franchise fold (pure) ─────────────────────────────────────────

/**
 * Decide the whole fold for ONE tvdb series id: which member is canonical, which
 * are victims to merge, the route→canonical aliases (with per-cour offset +
 * season), and which members are EXCLUDED because their episodes don't line up
 * with the series (a defensive refusal to merge a probable wrong search hit).
 *
 * A member is included when it either (a) air-date-aligns to the series, or
 * (b) has no dated episodes yet (an announced future cour — nothing to
 * mis-place, folded low-confidence so it stops showing as a separate entry).
 * A member that HAS dated episodes which do NOT align is excluded + flagged.
 *
 * Returns null when there is nothing to fold (fewer than two includable members
 * once the guard has run) — a lone row is not a split franchise.
 *
 * @param {object} input
 * @param {number} input.tvdbId
 * @param {Array}  input.members            [{ id, title, route, popularity, year, external_ids }]
 * @param {Map}    input.episodesByAnimeId  id → [{ episode_number, airing_at, ... }]
 * @param {Array}  input.tvdbEpisodes       normalized TVDB history for tvdbId
 * @param {number} [input.toleranceDays]
 * @param {boolean} [input.requireAnchor]   when true, refuse to fold a group in
 *   which NO member air-date-aligns to the series — i.e. a group held together
 *   only by title-search resolution, with no episode evidence that the id is
 *   right. Used for unattended search-based scans; operator-curated folds
 *   (explicit ids + a verified series id) pass false, having vouched already.
 */
export function planFranchise({
  tvdbId,
  members,
  episodesByAnimeId,
  tvdbEpisodes,
  toleranceDays = 4,
  requireAnchor = false,
}) {
  const included = [];
  const excluded = [];
  for (const row of members ?? []) {
    const eps = episodesByAnimeId?.get(row.id) ?? [];
    const alignment = alignMemberToTvdb(eps, tvdbEpisodes, { toleranceDays });
    const hasDatedEpisodes = eps.some((e) => e?.airing_at);
    const member = {
      id: row.id,
      title: row.title,
      route: row.animeschedule_route ?? row.route ?? null,
      popularity: row.popularity ?? null,
      year: row.year ?? null,
      episodeCount: eps.length,
      alignment,
    };
    // Guard: dated episodes that refuse to align ⇒ probably a WRONG tvdb id on
    // this row (bad title search). Never fold it — surface for review instead.
    if (hasDatedEpisodes && !alignment.matched) {
      excluded.push({ ...member, reason: 'episodes do not align to the TVDB series' });
    } else {
      included.push(member);
    }
  }

  if (included.length < 2) {
    return { tvdbId, canonical: null, victims: [], aliases: [], excluded, folded: false };
  }

  // Anchor guard: for a search-resolved group, insist at least one member's
  // episodes actually line up with this series before folding on resolution
  // alone — otherwise a title-search that mis-mapped several rows to one id
  // could quietly merge unrelated shows. Operator-curated folds skip this.
  if (requireAnchor && !included.some((m) => m.alignment.matched)) {
    return {
      tvdbId,
      canonical: null,
      victims: [],
      aliases: [],
      excluded,
      folded: false,
      reason: 'no air-date-anchored member — refusing to fold on title resolution alone',
    };
  }

  const canonical = pickCanonical(included);
  const victims = included.filter((m) => m.id !== canonical.id);

  // Aliases route a member's per-cour episodes onto the canonical absolute
  // timeline in the WEEKLY pipeline. Every victim route gets one. The canonical
  // route needs one ONLY in the rare case it is a non-origin cour (offset ≠ 0);
  // the normal origin canonical is offset 0, so its own route needs no alias and
  // keeps refreshing normally in run.js.
  const canonicalOffset = canonical.alignment.matched ? canonical.alignment.episodeOffset : 0;
  const aliases = [
    ...(canonicalOffset !== 0
      ? [{
          animeschedule_route: canonical.route,
          anime_id: canonical.id,
          episode_offset: canonicalOffset,
          season_number: canonical.alignment.seasonNumber ?? null,
        }]
      : []),
    ...victims.map((v) => ({
      animeschedule_route: v.route,
      anime_id: canonical.id,
      episode_offset: v.alignment.matched ? v.alignment.episodeOffset : 0,
      season_number: v.alignment.seasonNumber ?? null,
    })),
  ].filter((a) => a.animeschedule_route); // a row with no route can't be aliased

  return { tvdbId, canonical, victims, aliases, excluded, folded: true };
}

/**
 * Compute the metadata the canonical should ADOPT from its members so the folded
 * entry is never poorer than the richest cour it absorbed — the origin cour is
 * often an imported metadata stub (no popularity, no synopsis), while a later,
 * currently-airing cour carries the real popularity/description. Returns a patch
 * of ONLY the fields that improve the canonical:
 *   - popularity / score: the MAX across members (keeps it discoverable — Discover
 *     ranks on popularity, so a null here would hide the whole franchise),
 *   - description / cover_image_url: filled from the most-popular member that has
 *     one, ONLY when the canonical's is missing (never overwrites a present value).
 * Empty when nothing improves (idempotent re-run).
 *
 * @param {object} canonicalRow  the canonical's current row
 * @param {Array}  memberRows    all member rows (canonical + victims), full cols
 */
export function bestCanonicalMetadata(canonicalRow, memberRows) {
  const rows = memberRows ?? [];
  const maxNum = (field) => {
    const vals = rows.map((r) => Number(r?.[field])).filter((v) => Number.isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  };
  const byPopularity = [...rows].sort((a, b) => (Number(b?.popularity) || -1) - (Number(a?.popularity) || -1));
  const firstNonEmpty = (field) => {
    for (const r of byPopularity) {
      const v = r?.[field];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  };

  const patch = {};
  const maxPop = maxNum('popularity');
  if (maxPop !== null && maxPop > (Number(canonicalRow?.popularity) || -1)) patch.popularity = maxPop;
  const maxScore = maxNum('score');
  if ((canonicalRow?.score ?? null) === null && maxScore !== null) patch.score = maxScore;
  for (const field of ['description', 'cover_image_url']) {
    if ((canonicalRow?.[field] ?? null) === null) {
      const v = firstNonEmpty(field);
      if (v !== null) patch[field] = v;
    }
  }
  return patch;
}

/**
 * The in-place renumbering steps to shift one victim's episodes onto the
 * canonical absolute timeline BEFORE the merge: each step moves episode `from`
 * → `from + offset` and stamps the season. Ordered so an in-place UPDATE never
 * transiently collides with a not-yet-moved sibling on the (anime_id,
 * episode_number) unique key: descending when shifting UP (offset ≥ 0),
 * ascending when shifting DOWN. Renumbering in place (vs delete+insert) keeps
 * each episodes.id, so watched_episodes marks ride along untouched.
 */
export function victimRenumberSteps(memberEpisodes, offset, season) {
  const steps = (memberEpisodes ?? [])
    .map((e) => Number(e?.episode_number))
    .filter((n) => Number.isInteger(n))
    .map((from) => ({ from, to: from + offset, season: season ?? null }));
  steps.sort((a, b) => (offset >= 0 ? b.from - a.from : a.from - b.from));
  return steps;
}

// ── Weekly-pipeline consumption (run.js) ─────────────────────────────────────
// The fold only STAYS folded if the weekly calendar sync honours the aliases:
// a member route must never re-create the catalogue row that was just merged
// away, and its per-cour episodes must land at the right absolute number/season
// on the canonical. These two pure helpers are what run.js wires in.

/**
 * Split freshly-built anime rows into those whose route is NOT aliased
 * (pass through to the normal upsert) and those that ARE (their canonical row
 * already exists — do not re-create it). `aliasByRoute` is route → alias record
 * ({ anime_id, episode_offset, season_number }).
 */
export function partitionByAlias(animeRows, aliasByRoute) {
  const passthrough = [];
  const aliased = [];
  for (const row of animeRows ?? []) {
    const alias = aliasByRoute?.get(row.animeschedule_route);
    if (alias) aliased.push({ row, alias });
    else passthrough.push(row);
  }
  return { passthrough, aliased };
}

/**
 * Turn a route-keyed episode proto into an episode row aimed at the CANONICAL
 * anime, at its absolute number and season. The proto's own `route` key is
 * dropped (its remaining fields — airing_at, streaming_links, delayed_from — are
 * carried through unchanged).
 */
export function aliasEpisodeRow(proto, alias) {
  const { route, episode_number, ...rest } = proto;
  return {
    anime_id: alias.anime_id,
    episode_number: episode_number + (alias.episode_offset ?? 0),
    season_number: alias.season_number ?? null,
    ...rest,
  };
}
