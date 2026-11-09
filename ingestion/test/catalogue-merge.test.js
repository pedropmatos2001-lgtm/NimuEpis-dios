import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGapFill,
  mapEntries,
  unionGenres,
} from '../src/catalogue.js';

// Merge semantics (the "critical — do not clobber" path in catalogue.js). These
// helpers run only during a LIVE run, so they get their own coverage here.

test('unionGenres keeps existing order first, then appends new, de-duped', () => {
  assert.deepEqual(unionGenres(['Action', 'Drama'], ['Drama', 'Isekai']), [
    'Action',
    'Drama',
    'Isekai',
  ]);
  assert.deepEqual(unionGenres([], ['Fantasy']), ['Fantasy']);
  assert.deepEqual(unionGenres(['Fantasy'], []), ['Fantasy']);
  assert.deepEqual(unionGenres(null, null), []);
});

test('computeGapFill fills ONLY null facets and never overwrites existing ones', () => {
  const existing = {
    mal_id: 1,
    year: 2010, // already set → must be preserved
    season: null, // null → gap-fillable
    media_type: null, // null → gap-fillable
    genres: ['Action'],
  };
  const manami = {
    year: 1999, // must NOT win — existing.year is non-null
    season: 'Spring',
    media_type: 'TV',
    genres: ['Action', 'Mecha'],
  };
  const patch = computeGapFill(existing, manami);
  assert.deepEqual(patch, {
    mal_id: 1,
    year: 2010, // preserved (not clobbered by manami's 1999)
    season: 'Spring', // gap-filled
    media_type: 'TV', // gap-filled
    genres: ['Action', 'Mecha'], // unioned
  });
});

test('computeGapFill unions genres even when facets are already complete', () => {
  const existing = { mal_id: 2, year: 2020, season: 'Fall', media_type: 'TV', genres: ['Drama'] };
  const manami = { year: 2020, season: 'Fall', media_type: 'TV', genres: ['Drama', 'Romance'] };
  assert.deepEqual(computeGapFill(existing, manami), {
    mal_id: 2,
    year: 2020,
    season: 'Fall',
    media_type: 'TV',
    genres: ['Drama', 'Romance'],
  });
});

test('computeGapFill returns null when there is nothing to add (idempotent re-run)', () => {
  // A row already carrying everything manami could offer → no write.
  const existing = { mal_id: 3, year: 2020, season: 'Fall', media_type: 'TV', genres: ['Drama', 'Romance'] };
  const manami = { year: 2020, season: 'Fall', media_type: 'TV', genres: ['Romance', 'Drama'] };
  assert.equal(computeGapFill(existing, manami), null);
  // A fully-null existing row that manami also can't fill → still no write.
  const blank = { mal_id: 4, year: null, season: null, media_type: null, genres: [] };
  assert.equal(computeGapFill(blank, { year: null, season: null, media_type: null, genres: [] }), null);
});

test('computeGapFill fills a fully-null legacy row from manami', () => {
  const legacy = { mal_id: 5, year: null, season: null, media_type: null, genres: [] };
  const manami = { year: 2008, season: 'Winter', media_type: 'Movie', genres: ['Fantasy'] };
  assert.deepEqual(computeGapFill(legacy, manami), {
    mal_id: 5,
    year: 2008,
    season: 'Winter',
    media_type: 'Movie',
    genres: ['Fantasy'],
  });
});

test('mapEntries drops rejects and collapses duplicate mal_ids (last-wins)', () => {
  const entries = [
    { sources: ['https://myanimelist.net/anime/10'], title: 'First', type: 'TV', status: 'FINISHED', tags: ['action'] },
    { sources: ['https://anidb.net/anime/1'], title: 'No MAL', type: 'TV', status: 'FINISHED', tags: [] }, // rejected
    { sources: ['https://myanimelist.net/anime/10'], title: 'Dup (wins)', type: 'MOVIE', status: 'FINISHED', tags: ['drama'] },
  ];
  const { rows, rejected, dupes } = mapEntries(entries);
  assert.equal(rejected, 1);
  assert.equal(dupes, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Dup (wins)'); // last write per mal_id wins
  assert.equal(rows[0].media_type, 'Movie');
});
