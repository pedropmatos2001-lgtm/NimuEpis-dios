import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { normalizeEpisodes, mergeEpisodeRows } from '../src/tvdb-episodes.js';

const here = dirname(fileURLToPath(import.meta.url));

test('normalizeEpisodes uses absoluteNumber as episode_number and keeps seasonNumber', () => {
  const eps = normalizeEpisodes([
    { seasonNumber: 1, number: 1, absoluteNumber: 1, aired: '1999-10-20', name: 'A', overview: 'a', image: '/x/1.jpg' },
    { seasonNumber: 2, number: 1, absoluteNumber: 62, aired: '2001-01-14', name: 'B', overview: 'b', image: '/x/62.jpg' },
  ]);
  assert.deepEqual(eps.map((e) => e.episodeNumber), [1, 62]);
  assert.deepEqual(eps.map((e) => e.seasonNumber), [1, 2]); // grouping key for the season dropdown
  assert.equal(eps[0].title, 'A');
  assert.equal(eps[0].overview, 'a');
});

test('normalizeEpisodes falls back to a running index (across seasons, aired order) when absoluteNumber is missing', () => {
  const eps = normalizeEpisodes([
    { seasonNumber: 1, number: 1, aired: '2020-01-01', name: 'S1E1' },
    { seasonNumber: 1, number: 2, aired: '2020-01-08', name: 'S1E2' },
    { seasonNumber: 2, number: 1, aired: '2021-01-01', name: 'S2E1' },
  ]);
  // No absoluteNumber anywhere → 1,2,3 continuing across the season boundary.
  assert.deepEqual(eps.map((e) => e.episodeNumber), [1, 2, 3]);
  assert.deepEqual(eps.map((e) => e.seasonNumber), [1, 1, 2]);
});

test('normalizeEpisodes running index advances for every kept episode so a fallback never collides with a real absolute number', () => {
  const eps = normalizeEpisodes([
    { seasonNumber: 1, number: 1, absoluteNumber: 1, aired: '2020-01-01', name: 'has-abs' },
    { seasonNumber: 1, number: 2, aired: '2020-01-08', name: 'no-abs' }, // fallback = position 2
  ]);
  assert.deepEqual(eps.map((e) => e.episodeNumber), [1, 2]);
});

test('normalizeEpisodes skips specials (season 0) unless they carry an absoluteNumber', () => {
  const eps = normalizeEpisodes([
    { seasonNumber: 1, number: 1, absoluteNumber: 1, aired: '2020-01-01', name: 'regular' },
    { seasonNumber: 0, number: 5, absoluteNumber: null, aired: '2020-06-01', name: 'unplaced special' }, // dropped
    { seasonNumber: 0, number: 6, absoluteNumber: 999, aired: '2020-07-01', name: 'placed special' }, // kept
  ]);
  assert.deepEqual(eps.map((e) => e.episodeNumber), [1, 999]);
  assert.deepEqual(eps.map((e) => e.seasonNumber), [1, 0]); // the kept special keeps season 0
});

test('normalizeEpisodes turns the date-only aired string into a midnight-UTC ISO instant', () => {
  const [ep] = normalizeEpisodes([{ seasonNumber: 1, absoluteNumber: 1, aired: '2019-10-20', name: 'x' }]);
  assert.equal(ep.airedIso, '2019-10-20T00:00:00.000Z');

  // Missing / sentinel aired → null (a valid, announced-but-undated episode).
  const [noDate] = normalizeEpisodes([{ seasonNumber: 1, absoluteNumber: 1, name: 'x' }]);
  assert.equal(noDate.airedIso, null);
  const [sentinel] = normalizeEpisodes([{ seasonNumber: 1, absoluteNumber: 1, aired: '0001-01-01', name: 'x' }]);
  assert.equal(sentinel.airedIso, null);
});

test('normalizeEpisodes absolutizes the episode image against the artworks CDN', () => {
  const eps = normalizeEpisodes([
    { seasonNumber: 1, absoluteNumber: 1, image: '/banners/episodes/81797/1.jpg', name: 'slash' },
    { seasonNumber: 1, absoluteNumber: 2, image: 'banners/episodes/81797/2.jpg', name: 'no-slash' },
    { seasonNumber: 1, absoluteNumber: 3, image: 'https://artworks.thetvdb.com/banners/episodes/81797/3.jpg', name: 'absolute' },
    { seasonNumber: 1, absoluteNumber: 4, image: '', name: 'empty' },
  ]);
  assert.deepEqual(eps.map((e) => e.imageUrl), [
    'https://artworks.thetvdb.com/banners/episodes/81797/1.jpg',
    'https://artworks.thetvdb.com/banners/episodes/81797/2.jpg',
    'https://artworks.thetvdb.com/banners/episodes/81797/3.jpg',
    null,
  ]);
});

test('normalizeEpisodes normalizes empty name/overview to null and tolerates an empty input', () => {
  const [ep] = normalizeEpisodes([{ seasonNumber: 1, absoluteNumber: 1, name: '', overview: '   ' }]);
  assert.equal(ep.title, null);
  assert.equal(ep.overview, null);
  assert.deepEqual(normalizeEpisodes([]), []);
  assert.deepEqual(normalizeEpisodes(undefined), []);
});

test('mergeEpisodeRows preserves AnimeSchedule airing_at + streaming_links, fills only nulls, and inserts the rest', () => {
  const tvdb = normalizeEpisodes([
    { seasonNumber: 1, absoluteNumber: 1, aired: '1999-10-20', name: 'E1', overview: 'o1', image: '/i/1.jpg' },
    { seasonNumber: 1, absoluteNumber: 2, aired: '1999-11-17', name: 'E2', overview: 'o2', image: '/i/2.jpg' },
    { seasonNumber: 2, absoluteNumber: 62, aired: '2001-01-14', name: 'E62', overview: 'o62', image: '/i/62.jpg' },
  ]);
  const existing = [
    { episode_number: 1, airing_at: null, streaming_links: [] }, // airing_at should be filled from TVDB
    {
      episode_number: 2,
      airing_at: '2026-01-15T15:00:00.000Z', // precise time — must survive
      streaming_links: [{ platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/X/ep2' }],
    },
  ];
  const { rows, inserts, updates } = mergeEpisodeRows('anime-1', tvdb, existing);
  assert.equal(inserts, 1); // ep 62
  assert.equal(updates, 2); // ep 1 + ep 2

  const byNum = new Map(rows.map((r) => [r.episode_number, r]));

  // ep 1: metadata written, null airing_at filled from TVDB (date-only midnight).
  assert.equal(byNum.get(1).airing_at, '1999-10-20T00:00:00.000Z');
  assert.equal(byNum.get(1).title, 'E1');
  assert.equal(byNum.get(1).season_number, 1);
  assert.deepEqual(byNum.get(1).streaming_links, []);

  // ep 2: real airing_at + streaming_links preserved; metadata still applied.
  assert.equal(byNum.get(2).airing_at, '2026-01-15T15:00:00.000Z');
  assert.deepEqual(byNum.get(2).streaming_links, [
    { platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/X/ep2' },
  ]);
  assert.equal(byNum.get(2).overview, 'o2');

  // ep 62: brand-new insert — TVDB date, empty links, image absolutized.
  assert.equal(byNum.get(62).airing_at, '2001-01-14T00:00:00.000Z');
  assert.deepEqual(byNum.get(62).streaming_links, []);
  assert.equal(byNum.get(62).image_url, 'https://artworks.thetvdb.com/i/62.jpg');
  assert.equal(byNum.get(62).season_number, 2);

  // Uniform key set on every row (what makes the single upsert safe).
  const keys = rows.map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(keys).size, 1);
});

test('mergeEpisodeRows collapses duplicate episode_numbers (last-wins) to keep the upsert conflict-safe', () => {
  const dupes = [
    { episodeNumber: 5, seasonNumber: 1, title: 'first', overview: null, imageUrl: null, airedIso: '2020-01-01T00:00:00.000Z' },
    { episodeNumber: 5, seasonNumber: 1, title: 'second', overview: null, imageUrl: null, airedIso: '2020-01-02T00:00:00.000Z' },
  ];
  const { rows } = mergeEpisodeRows('anime-1', dupes, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'second'); // last-wins
});

test('`catalogue-episodes.js --dry-run` completes on fixtures without env, network or Supabase', () => {
  // Scrub every credential to PROVE the dry run needs none and cannot reach a
  // real backend (mirrors dryrun.test.js).
  const env = { ...process.env };
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANIMESCHEDULE_TOKEN', 'TVDB_API_KEY', 'TMDB_API_KEY']) {
    delete env[key];
  }
  const entry = resolve(here, '../src/catalogue-episodes.js');
  const res = spawnSync(process.execPath, [entry, '--dry-run'], { env, encoding: 'utf8', timeout: 30000 });

  assert.equal(res.status, 0, `stderr was: ${res.stderr}`);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /5 raw episodes → 4 kept/); // one unplaced special dropped
  assert.match(res.stdout, /2 insert, 2 update/);
  assert.match(res.stdout, /Dry run OK/);
});
