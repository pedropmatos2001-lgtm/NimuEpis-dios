import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveGenres,
  hasAdultTag,
  manamiEntryToAnimeRow,
  MANAMI_NO_PIC,
} from '../src/catalogue-mappers.js';

// A well-formed entry we clone-and-tweak per test.
const base = () => ({
  sources: [
    'https://anidb.net/anime/17617',
    'https://anilist.co/anime/154587',
    'https://kitsu.app/anime/46474',
    'https://myanimelist.net/anime/52991',
  ],
  title: 'Sousou no Frieren',
  type: 'TV',
  episodes: 28,
  status: 'FINISHED',
  animeSeason: { season: 'FALL', year: 2023 },
  picture: 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg',
  synonyms: [],
  tags: ['adventure', 'fantasy'],
});

test('manamiEntryToAnimeRow maps a well-formed entry to a shallow catalogue row', () => {
  const row = manamiEntryToAnimeRow(base());
  assert.deepEqual(row, {
    mal_id: 52991,
    title: 'Sousou no Frieren',
    status: 'finished',
    media_type: 'TV',
    season: 'Fall',
    year: 2023,
    cover_image_url: 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg',
    external_ids: { anidb: 17617, anilist: 154587, kitsu: '46474', mal: 52991 },
    genres: ['Adventure', 'Fantasy'],
  });
  // Shallow by design: manami has none of these, so they must not appear (the
  // AnimeSchedule pipeline owns them; the merge must not clobber them).
  for (const key of ['score', 'popularity', 'description', 'studios', 'accent_color']) {
    assert.equal(key in row, false, `row must not carry "${key}"`);
  }
});

test('a MAL id is REQUIRED — no MAL source ⇒ null', () => {
  const noMal = { ...base(), sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587'] };
  assert.equal(manamiEntryToAnimeRow(noMal), null);
  // …and mal is the only mandatory id (anilist/kitsu/anidb may be absent).
  const malOnly = { ...base(), sources: ['https://myanimelist.net/anime/52991'] };
  assert.deepEqual(manamiEntryToAnimeRow(malOnly).external_ids, { mal: 52991 });
});

test('kitsu id stays a string; numeric providers are cast to Number', () => {
  const { external_ids } = manamiEntryToAnimeRow(base());
  assert.strictEqual(external_ids.mal, 52991);
  assert.strictEqual(external_ids.anilist, 154587);
  assert.strictEqual(external_ids.anidb, 17617);
  assert.strictEqual(external_ids.kitsu, '46474'); // string on purpose
});

test('tags → genres: curated map, synonyms, drop-unmapped, de-dupe, order kept', () => {
  // "sci fi"/"science fiction" → Sci-Fi, "slice of life" → Slice of Life,
  // "coming of age" → Drama; "cooking"/"cgdct" are unmapped and dropped; the
  // duplicate Sci-Fi collapses; casing/spacing is normalized.
  const genres = deriveGenres([
    'Action',
    'sci fi',
    'science fiction',
    '  Slice   of Life  ',
    'coming of age',
    'martial-arts',
    'cooking',
    'cgdct',
  ]);
  assert.deepEqual(genres, ['Action', 'Sci-Fi', 'Slice of Life', 'Drama', 'Martial Arts']);
  // Everything unmapped ⇒ empty set (not garbage).
  assert.deepEqual(deriveGenres(['cooking', 'cgdct', 'workplace']), []);
  assert.deepEqual(deriveGenres(undefined), []);
});

test('adult content is excluded wholesale, but ecchi is kept', () => {
  assert.equal(hasAdultTag(['romance', 'hentai']), true);
  assert.equal(hasAdultTag(['erotica']), true);
  assert.equal(hasAdultTag(['action', 'ecchi']), false); // ecchi is a kept genre
  assert.equal(hasAdultTag(['adventure']), false);

  const adult = { ...base(), tags: ['romance', 'hentai'] };
  assert.equal(manamiEntryToAnimeRow(adult), null);
  // Ecchi entries still map, and Ecchi survives as a genre.
  const ecchiRow = manamiEntryToAnimeRow({ ...base(), tags: ['ecchi', 'comedy'] });
  assert.deepEqual(ecchiRow.genres, ['Ecchi', 'Comedy']);
});

test('type → media_type in AnimeSchedule casing (UNKNOWN ⇒ null)', () => {
  const typeOf = (type) => manamiEntryToAnimeRow({ ...base(), type }).media_type;
  assert.equal(typeOf('TV'), 'TV');
  assert.equal(typeOf('MOVIE'), 'Movie');
  assert.equal(typeOf('OVA'), 'OVA');
  assert.equal(typeOf('ONA'), 'ONA');
  assert.equal(typeOf('SPECIAL'), 'Special');
  assert.equal(typeOf('UNKNOWN'), null);
  assert.equal(typeOf('what'), null);
});

test('status → anime_status enum (UNKNOWN/other ⇒ null)', () => {
  const statusOf = (status) => manamiEntryToAnimeRow({ ...base(), status }).status;
  assert.equal(statusOf('FINISHED'), 'finished');
  assert.equal(statusOf('ONGOING'), 'airing');
  assert.equal(statusOf('UPCOMING'), 'upcoming');
  assert.equal(statusOf('UNKNOWN'), null);
  assert.equal(statusOf(undefined), null);
});

test('animeSeason.season → Title-Case season (UNDEFINED ⇒ null)', () => {
  const seasonOf = (season) => manamiEntryToAnimeRow({ ...base(), animeSeason: { season, year: 2020 } }).season;
  assert.equal(seasonOf('WINTER'), 'Winter');
  assert.equal(seasonOf('SPRING'), 'Spring');
  assert.equal(seasonOf('SUMMER'), 'Summer');
  assert.equal(seasonOf('FALL'), 'Fall');
  assert.equal(seasonOf('UNDEFINED'), null);
});

test('year is kept only when a plausible integer > 1900', () => {
  const yearOf = (year) => manamiEntryToAnimeRow({ ...base(), animeSeason: { season: 'FALL', year } }).year;
  assert.equal(yearOf(2023), 2023);
  assert.equal(yearOf(1930), 1930);
  assert.equal(yearOf(1900), null); // boundary is exclusive
  assert.equal(yearOf(0), null);
  assert.equal(yearOf(undefined), null);
});

test('untitled / malformed entries are rejected', () => {
  assert.equal(manamiEntryToAnimeRow({ ...base(), title: '' }), null);
  assert.equal(manamiEntryToAnimeRow({ ...base(), title: '   ' }), null);
  assert.equal(manamiEntryToAnimeRow(null), null);
  assert.equal(manamiEntryToAnimeRow(undefined), null);
});

test('the manami no_pic placeholder is dropped to null (not stored as a cover)', () => {
  // manami ships this exact URL for image-less entries; storing it would point
  // the app at a non-allow-listed host that renders a broken tile. It must land
  // as null so the row shows the typographic fallback (repaired later by covers.js).
  const row = manamiEntryToAnimeRow({ ...base(), picture: MANAMI_NO_PIC });
  assert.equal(row.cover_image_url, null);
  // A real cover still comes through untouched.
  const real = manamiEntryToAnimeRow({ ...base(), picture: 'https://cdn.myanimelist.net/images/anime/1/1.jpg' });
  assert.equal(real.cover_image_url, 'https://cdn.myanimelist.net/images/anime/1/1.jpg');
});

test('title is trimmed and capped at 500 chars', () => {
  const long = 'x'.repeat(600);
  const row = manamiEntryToAnimeRow({ ...base(), title: `  ${long}  ` });
  assert.equal(row.title.length, 500);
});
