import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRows } from '../src/pipeline.js';
import { buildManamiIndex } from '../src/manami.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = async (name) =>
  JSON.parse(await readFile(resolve(here, 'fixtures', name), 'utf8'));

const timetableEntries = await load('timetable-week.json');
const detailsByRoute = new Map(Object.entries(await load('anime-details.json')));
const manamiIndex = buildManamiIndex((await load('manami-mini.json')).data);

test('buildRows produces validated anime rows and episode protos', () => {
  const out = buildRows({ timetableEntries, detailsByRoute, manamiIndex });

  // frieren, kingdom, mystery are valid; "broken-entry" (no title) is rejected;
  // the empty-route entry never groups at all.
  assert.deepEqual(
    out.animeRows.map((r) => r.animeschedule_route).sort(),
    ['kingdom-6th-season', 'mystery-show-no-date', 'sousou-no-frieren-2nd-season'],
  );
  assert.equal(out.rejectedAnimes, 1);

  // Episodes: frieren e5+e6 and kingdom e9. Skipped: mystery (sentinel date),
  // empty-route, broken-entry (its show was rejected).
  assert.equal(out.episodeProtos.length, 3);
  assert.equal(out.skippedEpisodes, 3);
});

test('buildRows: detail + manami enrich the frieren row end-to-end', () => {
  const { animeRows } = buildRows({ timetableEntries, detailsByRoute, manamiIndex });
  const frieren = animeRows.find((r) => r.animeschedule_route === 'sousou-no-frieren-2nd-season');

  assert.equal(frieren.title, "Frieren: Beyond Journey's End Season 2");
  assert.equal(frieren.status, 'airing');
  assert.deepEqual(frieren.external_ids, {
    mal: 52991,
    anilist: 154587,
    kitsu: '46474',
    anidb: 17617,
    animeschedule_route: 'sousou-no-frieren-2nd-season',
  });
  assert.deepEqual(frieren.genres, ['Adventure', 'Fantasy']);
  assert.deepEqual(frieren.studios, ['Madhouse']);
  assert.equal(frieren.score, 91.34);
  assert.equal(frieren.accent_color, '#a8c69a');
  assert.match(frieren.description, /^Decades after/);
  assert.doesNotMatch(frieren.description, /</); // HTML stripped
  assert.equal(
    frieren.cover_image_url,
    'https://img.animeschedule.net/production/assets/public/img/sousou-no-frieren-2nd-season-v2.webp',
  );
});

test('buildRows: kingdom falls back to romaji, crossfills anilist, handles bad stats', () => {
  const { animeRows, yearByRoute } = buildRows({ timetableEntries, detailsByRoute, manamiIndex });
  const kingdom = animeRows.find((r) => r.animeschedule_route === 'kingdom-6th-season');

  assert.equal(kingdom.title, 'Kingdom 6th Season'); // english is "" → romaji
  assert.equal(kingdom.status, 'airing'); // Delayed ⇒ still airing
  assert.equal(kingdom.external_ids.mal, 60543); // scheme-full URL parsed
  assert.equal(kingdom.external_ids.anilist, 187654); // via manami cross-fill
  assert.equal(kingdom.score, null); // averageScore 0 ⇒ unrated
  assert.equal(kingdom.accent_color, null); // invalid colours rejected
  assert.equal(yearByRoute.get('kingdom-6th-season'), 2026);
});

test('buildRows: a show without detail still ingests from timetable data', () => {
  const { animeRows, episodeProtos } = buildRows({ timetableEntries, detailsByRoute, manamiIndex });
  const mystery = animeRows.find((r) => r.animeschedule_route === 'mystery-show-no-date');

  assert.equal(mystery.title, 'Mystery Show');
  assert.equal(mystery.status, 'upcoming');
  assert.deepEqual(mystery.external_ids, { animeschedule_route: 'mystery-show-no-date' });
  assert.equal(mystery.description, null);
  // …but its sentinel-dated episode was (correctly) skipped.
  assert.equal(episodeProtos.some((e) => e.route === 'mystery-show-no-date'), false);
});

test('buildRows: episode protos carry UTC timestamps and normalized links', () => {
  const { episodeProtos } = buildRows({ timetableEntries, detailsByRoute, manamiIndex });
  const e5 = episodeProtos.find(
    (e) => e.route === 'sousou-no-frieren-2nd-season' && e.episode_number === 5,
  );
  assert.equal(e5.airing_at, '2026-07-31T16:00:00.000Z');
  assert.deepEqual(e5.streaming_links, [
    {
      platform: 'Crunchyroll',
      url: 'https://www.crunchyroll.com/series/GDKHZEJ0K/frieren-beyond-journeys-end',
    },
    { platform: 'Netflix', url: 'https://www.netflix.com/title/81726714' },
  ]);
  // Delayed episode keeps its (already shifted) delayed air date.
  const kingdom9 = episodeProtos.find((e) => e.route === 'kingdom-6th-season');
  assert.equal(kingdom9.airing_at, '2026-08-12T15:10:00.000Z');
  assert.deepEqual(kingdom9.streaming_links, []);
});
