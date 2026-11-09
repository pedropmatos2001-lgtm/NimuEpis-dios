import test from 'node:test';
import assert from 'node:assert/strict';
import {
  animescheduleToAnimeRow,
  animescheduleToEpisodeProto,
  extractExternalIds,
  imageUrl,
  isNullDate,
  mapShowStatus,
  normalizeHexColor,
  normalizeStreams,
  stripHtml,
  toUtcIso,
  validateAnimeRow,
} from '../src/mappers.js';

test('mapShowStatus maps AnimeSchedule statuses to the anime_status enum', () => {
  assert.equal(mapShowStatus('Ongoing'), 'airing');
  assert.equal(mapShowStatus('Delayed'), 'airing'); // delayed shows are still airing
  assert.equal(mapShowStatus('Finished'), 'finished');
  assert.equal(mapShowStatus('Upcoming'), 'upcoming');
  assert.equal(mapShowStatus('finished'), 'finished'); // case-insensitive
  assert.equal(mapShowStatus('???'), null);
  assert.equal(mapShowStatus(undefined), null);
});

test('isNullDate / toUtcIso handle the 0001-01-01 sentinel and store UTC', () => {
  assert.equal(isNullDate('0001-01-01T00:00:00Z'), true);
  assert.equal(isNullDate(undefined), true);
  assert.equal(isNullDate('2026-07-31T16:00:00Z'), false);
  assert.equal(toUtcIso('0001-01-01T00:00:00Z'), null);
  assert.equal(toUtcIso('garbage'), null);
  // Offset datetimes normalise to UTC (tz=Etc/UTC is requested, but be safe).
  assert.equal(toUtcIso('2026-08-01T01:00:00+09:00'), '2026-07-31T16:00:00.000Z');
});

test('imageUrl builds the CDN URL and passes absolute URLs through', () => {
  assert.equal(
    imageUrl('sousou-no-frieren-2nd-season-v2.webp'),
    'https://img.animeschedule.net/production/assets/public/img/sousou-no-frieren-2nd-season-v2.webp',
  );
  // Absolutos só num anfitrião de imagens conhecido (src/image-hosts.js, F24).
  assert.equal(
    imageUrl('https://img.animeschedule.net/production/assets/public/img/x.webp'),
    'https://img.animeschedule.net/production/assets/public/img/x.webp',
  );
  assert.equal(imageUrl('https://example.com/x.png'), null);
  assert.equal(imageUrl('http://img.animeschedule.net/x.png'), null);
  assert.equal(imageUrl(''), null);
  assert.equal(imageUrl(undefined), null);
});

test('normalizeStreams accepts the object-map shape and absolutizes URLs', () => {
  const links = normalizeStreams({
    crunchyroll: 'series/GDKHZEJ0K/frieren',
    netflix: 'www.netflix.com/title/81726714',
    hidive: 'https://www.hidive.com/tv/x',
    unknownsite: 'some/bare/path',
  });
  assert.deepEqual(links, [
    { platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GDKHZEJ0K/frieren' },
    { platform: 'Netflix', url: 'https://www.netflix.com/title/81726714' },
    { platform: 'HIDIVE', url: 'https://www.hidive.com/tv/x' },
    // unknown platform + bare path is dropped (cannot build a real URL)
  ]);
});

test('normalizeStreams accepts the array shape and always returns an array', () => {
  const links = normalizeStreams([
    { platform: 'crunchyroll', url: 'https://www.crunchyroll.com/series/X', name: 'Crunchyroll' },
    { platform: 'youtube', url: 'watch?v=abc' },
    { platform: 'nourl' },
  ]);
  assert.deepEqual(links, [
    { platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/X' },
    { platform: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' },
  ]);
  assert.deepEqual(normalizeStreams(undefined), []);
  assert.deepEqual(normalizeStreams({}), []);
});

test('extractExternalIds parses websites values with or without scheme', () => {
  const ids = extractExternalIds({
    official: 'frieren-anime.jp',
    mal: 'myanimelist.net/anime/52991',
    aniList: 'https://anilist.co/anime/154587',
    kitsu: 'kitsu.app/anime/46474',
    anidb: 'anidb.net/anime/17617',
    crunchyroll: 'www.crunchyroll.com/series/GDKHZEJ0K/frieren',
  });
  assert.deepEqual(ids, { mal: 52991, anilist: 154587, kitsu: '46474', anidb: 17617 });
  assert.deepEqual(extractExternalIds(undefined), {});
});

test('stripHtml flattens the HTML description into readable text', () => {
  assert.equal(
    stripHtml('<p>Line one.</p><p>Line &amp; two.</p>'),
    'Line one.\n\nLine & two.',
  );
  assert.equal(stripHtml(''), null);
  assert.equal(stripHtml('<p></p>'), null);
});

test('normalizeHexColor validates and normalises hex colours', () => {
  assert.equal(normalizeHexColor('#A8C69A'), '#a8c69a');
  assert.equal(normalizeHexColor('A8C69A'), '#a8c69a');
  assert.equal(normalizeHexColor('not-a-color'), null);
  assert.equal(normalizeHexColor(''), null);
  assert.equal(normalizeHexColor(undefined), null);
});

test('animescheduleToAnimeRow merges timetable entry + detail', () => {
  const entry = {
    title: 'Show X',
    route: 'show-x',
    english: '',
    romaji: 'Shou X',
    status: 'Ongoing',
    imageVersionRoute: 'show-x.webp',
  };
  const detail = {
    route: 'show-x',
    status: 'Ongoing',
    description: '<p>Synopsis.</p>',
    genres: [{ name: 'Action' }],
    studios: [{ name: 'Trigger' }],
    stats: {
      averageScore: 77.5,
      trackedCount: 52000,
      colorDarkMode: '#112233',
      colorLightMode: '#445566',
    },
    year: 2026,
    season: { title: 'Spring 2026', season: 'Spring' },
    mediaTypes: [{ name: 'TV', route: 'tv' }],
    names: { english: 'Show X (EN)', romaji: 'Shou X' },
    websites: { mal: 'myanimelist.net/anime/1' },
    imageVersionRoute: 'show-x-v2.webp',
  };
  const row = animescheduleToAnimeRow(entry, detail);
  assert.equal(row.animeschedule_route, 'show-x');
  assert.equal(row.title, 'Show X (EN)');
  assert.equal(row.status, 'airing');
  assert.equal(
    row.cover_image_url,
    'https://img.animeschedule.net/production/assets/public/img/show-x-v2.webp',
  );
  assert.deepEqual(row.external_ids, { mal: 1, animeschedule_route: 'show-x' });
  assert.equal(row.description, 'Synopsis.');
  assert.deepEqual(row.genres, ['Action']);
  assert.deepEqual(row.studios, ['Trigger']);
  assert.equal(row.score, 77.5);
  assert.equal(row.popularity, 52000); // stats.trackedCount -> popularity
  assert.equal(row.year, 2026);
  assert.equal(row.season, 'Spring');
  assert.equal(row.media_type, 'TV');
  assert.equal(row.accent_color, '#112233'); // dark-mode colour preferred
  assert.equal(validateAnimeRow(row), true);
});

test('animescheduleToAnimeRow survives a missing detail (timetable-only)', () => {
  const row = animescheduleToAnimeRow(
    { title: 'Solo', route: 'solo', english: 'Solo EN', status: 'Upcoming', imageVersionRoute: 's.webp' },
    null,
  );
  assert.equal(row.title, 'Solo EN');
  assert.equal(row.status, 'upcoming');
  assert.equal(row.score, null);
  assert.equal(row.popularity, null); // sem detalhe, sem sinal de popularidade
  assert.deepEqual(row.external_ids, { animeschedule_route: 'solo' });
  assert.equal(validateAnimeRow(row), true);
});

test('validateAnimeRow rejects rows without natural key or title', () => {
  const noTitle = animescheduleToAnimeRow({ route: 'r', title: '', english: '', romaji: '' }, null);
  assert.equal(validateAnimeRow(noTitle), false);
  const noRoute = animescheduleToAnimeRow({ route: '', title: 'T' }, null);
  assert.equal(validateAnimeRow(noRoute), false);
});

test('animescheduleToEpisodeProto validates key fields and skips sentinels', () => {
  const ok = animescheduleToEpisodeProto({
    route: 'show-x',
    episodeNumber: 5,
    episodeDate: '2026-07-31T16:00:00Z',
    streams: { crunchyroll: 'series/A/b' },
  });
  assert.deepEqual(ok, {
    route: 'show-x',
    episode_number: 5,
    airing_at: '2026-07-31T16:00:00.000Z',
    streaming_links: [
      { platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/A/b' },
    ],
    delayed_from: null, // sem delayedFrom -> não adiado
  });

  // Episódio adiado: delayedFrom anterior à data real -> guarda a original.
  const delayed = animescheduleToEpisodeProto({
    route: 'show-x',
    episodeNumber: 17,
    episodeDate: '2026-08-07T15:00:00Z',
    delayedFrom: '2026-07-31T00:00:00Z',
    delayedUntil: '2026-08-07T00:00:00Z',
  });
  assert.equal(delayed.delayed_from, '2026-07-31T00:00:00.000Z');

  // delayedFrom igual/posterior à data real (residual) NÃO marca adiamento.
  const notReally = animescheduleToEpisodeProto({
    route: 'show-x',
    episodeNumber: 6,
    episodeDate: '2026-08-07T15:00:00Z',
    delayedFrom: '2026-08-07T15:00:00Z',
  });
  assert.equal(notReally.delayed_from, null);
  // Sentinel date, missing route, and episode 0 are all rejected.
  assert.equal(
    animescheduleToEpisodeProto({ route: 'x', episodeNumber: 1, episodeDate: '0001-01-01T00:00:00Z' }),
    null,
  );
  assert.equal(
    animescheduleToEpisodeProto({ route: '', episodeNumber: 1, episodeDate: '2026-07-31T16:00:00Z' }),
    null,
  );
  assert.equal(
    animescheduleToEpisodeProto({ route: 'x', episodeNumber: 0, episodeDate: '2026-07-31T16:00:00Z' }),
    null,
  );
});

test('scheduleNoteOf: a frase do horário, limpa e com o limite da coluna', async () => {
  const { scheduleNoteOf } = await import('../src/mappers.js');
  assert.equal(
    scheduleNoteOf({ delayedDesc: '  Episodes 1181 and further\n will continue in April 2027. ' }),
    'Episodes 1181 and further will continue in April 2027.',
  );
  assert.equal(scheduleNoteOf({ delayedDesc: '   ' }), null);
  assert.equal(scheduleNoteOf({}), null);
  assert.equal(scheduleNoteOf(null), null);
  assert.equal(scheduleNoteOf({ delayedDesc: 'x'.repeat(600) }).length, 500);
});
