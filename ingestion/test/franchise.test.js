import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  tvdbIdOf,
  groupByTvdbId,
  alignMemberToTvdb,
  pickCanonical,
  planFranchise,
  victimRenumberSteps,
  partitionByAlias,
  aliasEpisodeRow,
  baseFranchiseTitle,
  bestCanonicalMetadata,
} from '../src/franchise.js';
import { normalizeEpisodes } from '../src/tvdb-episodes.js';

const here = dirname(fileURLToPath(import.meta.url));

// A tiny One-Piece-shaped TVDB history: absolute 1,2 (season 1), 62 (season 2).
const TVDB = normalizeEpisodes([
  { seasonNumber: 1, absoluteNumber: 1, aired: '1999-10-20', name: 'E1' },
  { seasonNumber: 1, absoluteNumber: 2, aired: '1999-11-17', name: 'E2' },
  { seasonNumber: 2, absoluteNumber: 62, aired: '2001-01-14', name: 'E62' },
]);

// ── baseFranchiseTitle ───────────────────────────────────────────────────────

test('baseFranchiseTitle strips season/part/ordinal markers down to the franchise root', () => {
  assert.equal(baseFranchiseTitle('Mushoku Tensei: Jobless Reincarnation 3'), 'Mushoku Tensei: Jobless Reincarnation');
  assert.equal(baseFranchiseTitle('That Time I Got Reincarnated as a Slime 4th Season'), 'That Time I Got Reincarnated as a Slime');
  assert.equal(baseFranchiseTitle('Tensei shitara Slime Datta Ken 2nd Season'), 'Tensei shitara Slime Datta Ken');
  assert.equal(baseFranchiseTitle('Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2'), 'Mushoku Tensei : Isekai Ittara Honki Dasu');
  assert.equal(baseFranchiseTitle('Attack on Titan OVA'), 'Attack on Titan');
});

test('baseFranchiseTitle leaves a plain title (no ordinal) unchanged', () => {
  assert.equal(baseFranchiseTitle('One Piece'), 'One Piece');
  assert.equal(baseFranchiseTitle('Frieren: Beyond Journey’s End'), 'Frieren: Beyond Journey’s End');
  assert.equal(baseFranchiseTitle(''), '');
  assert.equal(baseFranchiseTitle(null), '');
});

// ── tvdbIdOf / groupByTvdbId ─────────────────────────────────────────────────

test('tvdbIdOf reads a positive numeric tvdb id and rejects everything else', () => {
  assert.equal(tvdbIdOf({ external_ids: { tvdb: 371310 } }), 371310);
  assert.equal(tvdbIdOf({ external_ids: { tvdb: '371310' } }), 371310); // stringified
  assert.equal(tvdbIdOf({ external_ids: {} }), null);
  assert.equal(tvdbIdOf({ external_ids: { tvdb: 0 } }), null);
  assert.equal(tvdbIdOf({ external_ids: { tvdb: -5 } }), null);
  assert.equal(tvdbIdOf({}), null);
  assert.equal(tvdbIdOf(null), null);
});

test('groupByTvdbId groups rows sharing a tvdb id and ignores rows without one', () => {
  const rows = [
    { id: 'a', external_ids: { tvdb: 100 } },
    { id: 'b', external_ids: { tvdb: 100 } },
    { id: 'c', external_ids: { tvdb: 200 } },
    { id: 'd', external_ids: {} }, // no tvdb → not grouped
  ];
  const groups = groupByTvdbId(rows);
  assert.deepEqual(groups.get(100).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(groups.get(200).map((r) => r.id), ['c']);
  assert.equal(groups.has(undefined), false);
  assert.equal(groups.size, 2);
});

// ── alignMemberToTvdb ────────────────────────────────────────────────────────

test('alignMemberToTvdb aligns an origin cour to offset 0 / season 1', () => {
  const member = [
    { episode_number: 1, airing_at: '1999-10-20T09:00:00.000Z' },
    { episode_number: 2, airing_at: '1999-11-17T09:00:00.000Z' },
  ];
  const a = alignMemberToTvdb(member, TVDB);
  assert.equal(a.matched, true);
  assert.equal(a.episodeOffset, 0);
  assert.equal(a.seasonNumber, 1);
  assert.equal(a.votes, 2);
});

test('alignMemberToTvdb derives the absolute offset + season of a later, per-cour-renumbered cour', () => {
  // Cour that AnimeSchedule numbers from 1 but is absolute 62 → offset 61, season 2.
  const member = [{ episode_number: 1, airing_at: '2001-01-14T20:00:00.000Z' }];
  const a = alignMemberToTvdb(member, TVDB);
  assert.equal(a.matched, true);
  assert.equal(a.episodeOffset, 61);
  assert.equal(a.seasonNumber, 2);
});

test('alignMemberToTvdb takes the MODAL offset so a single stray air date cannot move the cour', () => {
  const member = [
    { episode_number: 1, airing_at: '1999-10-20T09:00:00.000Z' }, // → abs 1, offset 0
    { episode_number: 2, airing_at: '1999-11-17T09:00:00.000Z' }, // → abs 2, offset 0
    { episode_number: 3, airing_at: '2035-01-01T00:00:00.000Z' }, // nonsense date, far → dropped by tolerance
  ];
  const a = alignMemberToTvdb(member, TVDB);
  assert.equal(a.episodeOffset, 0);
  assert.equal(a.seasonNumber, 1);
  assert.equal(a.votes, 2); // only the two real matches voted
  assert.equal(a.total, 3);
});

test('alignMemberToTvdb reports unmatched when the member has no dated episodes', () => {
  const a = alignMemberToTvdb([{ episode_number: 1, airing_at: null }], TVDB);
  assert.equal(a.matched, false);
  assert.equal(a.episodeOffset, 0);
  assert.equal(a.seasonNumber, null);
});

test('alignMemberToTvdb reports unmatched when dated episodes do NOT line up with the series (the guard)', () => {
  // Episodes aired years away from every TVDB episode → beyond tolerance.
  const member = [
    { episode_number: 1, airing_at: '2015-04-01T00:00:00.000Z' },
    { episode_number: 2, airing_at: '2015-04-08T00:00:00.000Z' },
  ];
  const a = alignMemberToTvdb(member, TVDB);
  assert.equal(a.matched, false);
  assert.equal(a.votes, 0);
});

// ── pickCanonical ────────────────────────────────────────────────────────────

test('pickCanonical picks the definitive origin (matched, offset 0)', () => {
  const members = [
    { id: 'later', popularity: 900, year: 2001, alignment: { matched: true, episodeOffset: 61, seasonNumber: 2 } },
    { id: 'origin', popularity: 100, year: 1999, alignment: { matched: true, episodeOffset: 0, seasonNumber: 1 } },
  ];
  assert.equal(pickCanonical(members).id, 'origin'); // offset-0 origin beats bigger popularity
});

test('pickCanonical prefers the EARLIEST-YEAR season 1 even when only a LATER cour has aligned episodes', () => {
  // The real split-franchise shape: season 1 is an episode-less stub (unmatched),
  // the current airing cour is the only air-date-matched row. Origin must still win.
  const members = [
    { id: 's3', popularity: 1312, year: 2026, alignment: { matched: true, episodeOffset: 40, seasonNumber: 3 } },
    { id: 's1-stub', popularity: null, year: 2021, alignment: { matched: false, episodeOffset: 0, seasonNumber: null } },
    { id: 's2-stub', popularity: null, year: 2023, alignment: { matched: false, episodeOffset: 0, seasonNumber: null } },
  ];
  assert.equal(pickCanonical(members).id, 's1-stub'); // earliest year = origin
});

test('pickCanonical prefers the ROOT title over an ordinal cour of the SAME year', () => {
  // Season 1 and its "Part 2" share a year — the root (no ordinal) must win, not
  // an id/popularity coin-flip.
  const members = [
    { id: 'zzz-part2', title: 'Mushoku Tensei: Isekai Ittara Honki Dasu Part 2', year: 2021, popularity: null, alignment: { matched: false, episodeOffset: 0 } },
    { id: 'aaa-s1', title: 'Mushoku Tensei: Isekai Ittara Honki Dasu', year: 2021, popularity: null, alignment: { matched: false, episodeOffset: 0 } },
  ];
  assert.equal(pickCanonical(members).id, 'aaa-s1'); // root title beats "Part 2"
});

test('pickCanonical falls back to popularity when years are unknown', () => {
  const bothUnmatched = pickCanonical([
    { id: 'low', popularity: 10, year: null, alignment: { matched: false, episodeOffset: 0 } },
    { id: 'high', popularity: 50, year: null, alignment: { matched: false, episodeOffset: 0 } },
  ]);
  assert.equal(bothUnmatched.id, 'high'); // most popular
});

// ── planFranchise ────────────────────────────────────────────────────────────

function opMembers() {
  return [
    { id: 'a1', title: 'One Piece', animeschedule_route: 'one-piece', popularity: 999, year: 1999, external_ids: { tvdb: 81797 } },
    { id: 'b2', title: 'One Piece: Arabasta', animeschedule_route: 'one-piece-arabasta', popularity: 500, year: 2001, external_ids: { tvdb: 81797 } },
  ];
}
function opEpisodes() {
  return new Map([
    ['a1', [
      { episode_number: 1, airing_at: '1999-10-20T09:00:00.000Z' },
      { episode_number: 2, airing_at: '1999-11-17T09:00:00.000Z' },
    ]],
    ['b2', [{ episode_number: 1, airing_at: '2001-01-14T09:00:00.000Z' }]],
  ]);
}

test('planFranchise folds two cours: canonical origin, victim at its absolute offset, aliases + no exclusions', () => {
  const plan = planFranchise({ tvdbId: 81797, members: opMembers(), episodesByAnimeId: opEpisodes(), tvdbEpisodes: TVDB });
  assert.equal(plan.folded, true);
  assert.equal(plan.canonical.id, 'a1');
  assert.equal(plan.canonical.alignment.episodeOffset, 0);
  assert.deepEqual(plan.victims.map((v) => v.id), ['b2']);
  assert.equal(plan.victims[0].alignment.episodeOffset, 61);
  assert.equal(plan.victims[0].alignment.seasonNumber, 2);

  // Alias set: the origin canonical (offset 0) needs NO alias — only the victim,
  // routed to the canonical at its absolute offset/season.
  const byRoute = new Map(plan.aliases.map((a) => [a.animeschedule_route, a]));
  assert.equal(byRoute.has('one-piece'), false); // offset-0 origin → not aliased
  assert.equal(byRoute.get('one-piece-arabasta').episode_offset, 61);
  assert.equal(byRoute.get('one-piece-arabasta').season_number, 2);
  assert.equal(byRoute.get('one-piece-arabasta').anime_id, 'a1'); // → canonical
  assert.equal(plan.aliases.length, 1);
  assert.equal(plan.excluded.length, 0);
});

test('planFranchise EXCLUDES a row that shares the tvdb id but whose episodes do not align (never merges a distinct show)', () => {
  const members = [
    ...opMembers(),
    { id: 'wrong', title: 'Unrelated Show (bad search hit)', animeschedule_route: 'unrelated', popularity: 5, year: 2015, external_ids: { tvdb: 81797 } },
  ];
  const episodes = opEpisodes();
  episodes.set('wrong', [
    { episode_number: 1, airing_at: '2015-04-01T00:00:00.000Z' },
    { episode_number: 2, airing_at: '2015-04-08T00:00:00.000Z' },
  ]);
  const plan = planFranchise({ tvdbId: 81797, members, episodesByAnimeId: episodes, tvdbEpisodes: TVDB });
  assert.equal(plan.folded, true);
  assert.deepEqual(plan.victims.map((v) => v.id), ['b2']); // 'wrong' NOT a victim
  assert.deepEqual(plan.excluded.map((e) => e.id), ['wrong']);
  assert.equal(plan.canonical.id, 'a1');
});

test('planFranchise (requireAnchor) refuses to fold a group with NO air-date-anchored member', () => {
  // Two episode-less rows resolved to the same id by title search alone — could
  // be a mis-resolution, so an unattended scan must not merge them.
  const members = [
    { id: 'a', title: 'Foo', animeschedule_route: null, year: 2020, external_ids: { tvdb: 999 } },
    { id: 'b', title: 'Foo 2', animeschedule_route: null, year: 2022, external_ids: { tvdb: 999 } },
  ];
  const episodes = new Map([['a', []], ['b', []]]);
  const strict = planFranchise({ tvdbId: 999, members, episodesByAnimeId: episodes, tvdbEpisodes: TVDB, requireAnchor: true });
  assert.equal(strict.folded, false);
  assert.match(strict.reason, /no air-date-anchored member/);

  // The same group folds when the operator vouches (requireAnchor false).
  const curated = planFranchise({ tvdbId: 999, members, episodesByAnimeId: episodes, tvdbEpisodes: TVDB, requireAnchor: false });
  assert.equal(curated.folded, true);
});

test('planFranchise (requireAnchor) still folds when at least ONE member is anchored', () => {
  // Mushoku shape: season-1 stub (unmatched) + the airing cour (matched).
  const plan = planFranchise({ tvdbId: 81797, members: opMembers(), episodesByAnimeId: opEpisodes(), tvdbEpisodes: TVDB, requireAnchor: true });
  assert.equal(plan.folded, true);
  assert.equal(plan.canonical.id, 'a1');
});

test('planFranchise does not fold a lone row (nothing to group)', () => {
  const plan = planFranchise({
    tvdbId: 81797,
    members: [opMembers()[0]],
    episodesByAnimeId: opEpisodes(),
    tvdbEpisodes: TVDB,
  });
  assert.equal(plan.folded, false);
  assert.equal(plan.canonical, null);
  assert.deepEqual(plan.victims, []);
});

test('planFranchise folds an announced future cour (no dated episodes) at offset 0, low-confidence', () => {
  const members = [
    ...opMembers(),
    { id: 'future', title: 'One Piece: Elbaf', animeschedule_route: 'one-piece-elbaf', popularity: 400, year: 2026, external_ids: { tvdb: 81797 } },
  ];
  const episodes = opEpisodes();
  episodes.set('future', [{ episode_number: 1, airing_at: null }]); // announced, no date yet
  const plan = planFranchise({ tvdbId: 81797, members, episodesByAnimeId: episodes, tvdbEpisodes: TVDB });
  const future = plan.victims.find((v) => v.id === 'future');
  assert.ok(future, 'future cour is folded, not excluded');
  assert.equal(future.alignment.matched, false);
  assert.equal(future.alignment.episodeOffset, 0);
  assert.equal(plan.excluded.length, 0);
});

// ── victimRenumberSteps ──────────────────────────────────────────────────────

test('victimRenumberSteps shifts UP in descending order so an in-place UPDATE never transiently collides', () => {
  const eps = [{ episode_number: 1 }, { episode_number: 2 }, { episode_number: 12 }];
  const steps = victimRenumberSteps(eps, 11, 1);
  assert.deepEqual(steps.map((s) => s.from), [12, 2, 1]); // highest first
  assert.deepEqual(steps.map((s) => s.to), [23, 13, 12]);
  assert.equal(steps.every((s) => s.season === 1), true);
});

test('victimRenumberSteps shifts DOWN in ascending order (mirror case)', () => {
  const steps = victimRenumberSteps([{ episode_number: 13 }, { episode_number: 14 }], -12, 2);
  assert.deepEqual(steps.map((s) => s.from), [13, 14]); // lowest first
  assert.deepEqual(steps.map((s) => s.to), [1, 2]);
});

// ── bestCanonicalMetadata ────────────────────────────────────────────────────

test('bestCanonicalMetadata carries max popularity + fills a missing synopsis onto an origin stub', () => {
  const canonical = { id: 's1', popularity: null, score: null, description: null, cover_image_url: 'canon.jpg' };
  const members = [
    canonical,
    { id: 's3', popularity: 1312, score: 8.2, description: 'The real synopsis.', cover_image_url: 's3.jpg' },
    { id: 's2', popularity: 500, score: null, description: 'older', cover_image_url: 's2.jpg' },
  ];
  const patch = bestCanonicalMetadata(canonical, members);
  assert.equal(patch.popularity, 1312); // max across members
  assert.equal(patch.score, 8.2);
  assert.equal(patch.description, 'The real synopsis.'); // from the most-popular member
  assert.equal('cover_image_url' in patch, false); // canonical already had a cover — not overwritten
});

test('bestCanonicalMetadata returns an empty patch when the canonical is already the richest (idempotent)', () => {
  const canonical = { id: 'x', popularity: 2000, score: 9, description: 'have', cover_image_url: 'c.jpg' };
  const members = [canonical, { id: 'y', popularity: 100, score: 5, description: 'less', cover_image_url: 'y.jpg' }];
  assert.deepEqual(bestCanonicalMetadata(canonical, members), {});
});

// ── run.js consumption helpers ───────────────────────────────────────────────

test('partitionByAlias separates aliased member routes from pass-through rows', () => {
  const aliasByRoute = new Map([['one-piece-arabasta', { anime_id: 'a1', episode_offset: 61, season_number: 2 }]]);
  const rows = [
    { animeschedule_route: 'one-piece-arabasta', title: 'victim cour' },
    { animeschedule_route: 'frieren', title: 'unrelated' },
  ];
  const { passthrough, aliased } = partitionByAlias(rows, aliasByRoute);
  assert.deepEqual(passthrough.map((r) => r.animeschedule_route), ['frieren']);
  assert.deepEqual(aliased.map((a) => a.row.animeschedule_route), ['one-piece-arabasta']);
  assert.equal(aliased[0].alias.anime_id, 'a1');
});

test('aliasEpisodeRow re-aims a per-cour episode at the canonical absolute number + season, dropping route', () => {
  const proto = { route: 'one-piece-arabasta', episode_number: 1, airing_at: '2001-01-14T09:00:00.000Z', streaming_links: [{ platform: 'CR', url: 'u' }], delayed_from: null };
  const row = aliasEpisodeRow(proto, { anime_id: 'a1', episode_offset: 61, season_number: 2 });
  assert.equal(row.route, undefined); // route key dropped
  assert.equal(row.anime_id, 'a1');
  assert.equal(row.episode_number, 62); // 1 + 61
  assert.equal(row.season_number, 2);
  assert.deepEqual(row.streaming_links, [{ platform: 'CR', url: 'u' }]); // carried through
  assert.equal(row.delayed_from, null);
});

// ── CLI dry run (fixtures, no env / no network / no Supabase) ─────────────────

test('`catalogue-franchises.js --dry-run` completes on fixtures without env, network or Supabase', () => {
  const env = { ...process.env };
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANIMESCHEDULE_TOKEN', 'TVDB_API_KEY', 'TMDB_API_KEY']) {
    delete env[key];
  }
  const entry = resolve(here, '../src/catalogue-franchises.js');
  const res = spawnSync(process.execPath, [entry, '--dry-run'], { env, encoding: 'utf8', timeout: 30000 });

  assert.equal(res.status, 0, `stderr was: ${res.stderr}`);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /group 81797 has 2 members/);
  assert.match(res.stdout, /canonical: "One Piece" \(route=one-piece, offset 0, season 1\)/);
  assert.match(res.stdout, /victim: "One Piece: Arabasta".*offset 61, season 2, matched=true/);
  assert.match(res.stdout, /call merge_anime_into 1 time/);
  assert.match(res.stdout, /Dry run OK/);
});
