// Standalone backfill: the FULL per-episode history from TheTVDB into
// `episodes`, MERGED on top of the AnimeSchedule calendar without clobbering it.
//
//   node src/catalogue-episodes.js --dry-run        → fixtures only, no net/DB
//   node src/catalogue-episodes.js                  → top-N popular titles
//   node src/catalogue-episodes.js --limit=50       → top-50
//   node src/catalogue-episodes.js --anime=<uuid>   → a single title
//   node src/catalogue-episodes.js --resolve        → fill missing tvdb ids first
//
// Kept SEPARATE from run.js (the frequent calendar refresh): a full-history
// backfill is long and deliberately bounded (top-N), not something the ~weekly
// timetable sync should carry. Scopes to catalogue rows that already have a
// `external_ids.tvdb` (most won't yet — that is expected); `--resolve` can fill
// some first via the existing title search.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';
import { chunk } from './util.js';
import { fetchAllEpisodes, normalizeEpisodes, mergeEpisodeRows } from './tvdb-episodes.js';

const EPISODE_UPSERT_CHUNK = 500;
// PostgREST caps a single SELECT at 1000 rows; a show like One Piece has more
// episodes than that, so existing-row reads MUST be paged.
const READ_PAGE = 1000;
const DEFAULT_LIMIT = 300;

const DRY_RUN = process.argv.includes('--dry-run');
const RESOLVE = process.argv.includes('--resolve');

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../test/fixtures');

/** Read a `--name=value` CLI flag, or null when absent. */
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** `--limit=N` (positive int), else DEFAULT_LIMIT. */
function parseLimit() {
  const n = Number.parseInt(argValue('limit') ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// ── Target selection ─────────────────────────────────────────────────────────

/**
 * Catalogue rows to backfill: those with `external_ids->>tvdb` set, most
 * popular first, capped at `limit` — or exactly one when `--anime=<uuid>`.
 * (The `->>` predicate is a seq-scan, not the GIN containment index, but this
 * is a bounded one-off backfill so that is fine.)
 */
async function selectTargets(supabase, { animeId, limit }) {
  let query = supabase
    .from('animes')
    .select('id, title, external_ids')
    .not('external_ids->>tvdb', 'is', null);
  if (animeId) query = query.eq('id', animeId);
  else query = query.order('popularity', { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? [])
    .map((r) => ({ id: r.id, title: r.title, tvdbId: Number(r.external_ids?.tvdb) }))
    .filter((r) => Number.isFinite(r.tvdbId) && r.tvdbId > 0);
}

/**
 * Optional (`--resolve`): fill missing `external_ids.tvdb` via the existing
 * title search before the backfill picks targets. Merges into external_ids
 * (never erases sibling ids). Behind a flag because it adds one search call per
 * title and needs title + year, which the primary path does not.
 */
async function resolveMissingTvdbIds(supabase, { animeId, limit }) {
  const { searchSeries } = await import('./tvdb.js');
  let query = supabase
    .from('animes')
    .select('id, title, year, external_ids')
    .is('external_ids->>tvdb', null);
  if (animeId) query = query.eq('id', animeId);
  else query = query.order('popularity', { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await query;
  if (error) throw error;

  let resolved = 0;
  for (const row of data ?? []) {
    if (!row.title) continue;
    try {
      const found = await searchSeries(row.title, row.year ?? undefined);
      if (!found) continue;
      const external_ids = { ...(row.external_ids ?? {}), tvdb: found.tvdbId };
      const { error: upErr } = await supabase
        .from('animes')
        .update({ external_ids })
        .eq('id', row.id);
      if (upErr) throw upErr;
      resolved += 1;
    } catch (err) {
      console.warn(`[nimu:eps] ⚠ resolve failed for "${row.title}" (non-fatal): ${err.message}`);
    }
  }
  console.log(`[nimu:eps] --resolve: filled ${resolved} tvdb id(s)`);
}

/**
 * Optional (`--resolve`): fill an empty `animes.description` from the TVDB series
 * synopsis (English) for catalogue rows that already carry a tvdb id. The manami
 * import brought titles but no synopses (~99.7% of rows blank), leaving detail
 * pages and SEO without a description; TVDB has one per series.
 *
 * Runs in the SAME bounded `--resolve` pass (top-N by popularity, or one
 * `--anime`), right AFTER the tvdb-id resolve so freshly-linked rows are covered
 * too. It is NOT a second full-catalogue scan: the WHERE narrows to rows that
 * both have a tvdb id and lack a description, and the same limit/anime bound
 * applies. Only writes non-empty text and NEVER overwrites an existing
 * description — the SELECT and the guarded UPDATE both require `description` to
 * still be null. Non-fatal per row, like the rest of this file.
 */
async function backfillDescriptions(supabase, { animeId, limit }) {
  const { seriesOverviewEnglish } = await import('./tvdb.js');
  let query = supabase
    .from('animes')
    .select('id, title, external_ids, description')
    .not('external_ids->>tvdb', 'is', null)
    .is('description', null);
  if (animeId) query = query.eq('id', animeId);
  else query = query.order('popularity', { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await query;
  if (error) throw error;

  let filled = 0;
  for (const row of data ?? []) {
    const tvdbId = Number(row.external_ids?.tvdb);
    if (!Number.isFinite(tvdbId) || tvdbId <= 0) continue;
    try {
      const overview = await seriesOverviewEnglish(tvdbId);
      if (!overview) continue;
      const { error: upErr } = await supabase
        .from('animes')
        .update({ description: overview })
        .eq('id', row.id)
        // Guard: only fill a still-null description — never clobber one written
        // by another process between the SELECT above and this UPDATE.
        .is('description', null);
      if (upErr) throw upErr;
      filled += 1;
    } catch (err) {
      console.warn(
        `[nimu:eps] ⚠ description backfill failed for "${row.title}" (non-fatal): ${err.message}`,
      );
    }
  }
  console.log(`[nimu:eps] --resolve: filled ${filled} description(s)`);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/** All existing episodes for one anime (paged past PostgREST's 1000-row cap). */
async function readExistingEpisodes(supabase, animeId) {
  const out = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await supabase
      .from('episodes')
      .select('episode_number, airing_at, streaming_links')
      .eq('anime_id', animeId)
      .order('episode_number', { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < READ_PAGE) break;
  }
  return out;
}

/** Batched upsert on the (anime_id, episode_number) conflict key. */
async function upsertEpisodes(supabase, rows) {
  for (const batch of chunk(rows, EPISODE_UPSERT_CHUNK)) {
    const { error } = await supabase
      .from('episodes')
      .upsert(batch, { onConflict: 'anime_id,episode_number' });
    if (error) throw error;
  }
}

// ── Live backfill ────────────────────────────────────────────────────────────

async function runLive() {
  // This backfill's own requirements — Supabase (destination) + TVDB (source).
  // It deliberately does NOT depend on ANIMESCHEDULE_TOKEN (unlike run.js): it
  // never calls AnimeSchedule, so we assert only what we use, names not values.
  // (Reading config also loaded ingestion/.env for local runs.)
  const missing = [
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.supabaseServiceRoleKey],
    ['TVDB_API_KEY', config.tvdbApiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        'Set them (ingestion/.env locally, or CI secrets), or use --dry-run.',
    );
  }
  const { supabase } = await import('./supabase.js');
  const animeId = argValue('anime');
  const limit = parseLimit();

  if (RESOLVE) {
    await resolveMissingTvdbIds(supabase, { animeId, limit });
    await backfillDescriptions(supabase, { animeId, limit });
  }

  const targets = await selectTargets(supabase, { animeId, limit });
  console.log(
    `[nimu:eps] ${targets.length} target title(s) with a tvdb id` +
      `${animeId ? ` (anime=${animeId})` : ` (top ${limit} by popularity)`}`,
  );

  let done = 0;
  let totalInsert = 0;
  let totalUpdate = 0;
  for (const target of targets) {
    try {
      const episodes = await fetchAllEpisodes(target.tvdbId);
      if (episodes.length === 0) {
        console.log(`[nimu:eps] ${target.title} (tvdb ${target.tvdbId}): no TVDB episodes — skipped`);
        continue;
      }
      const existing = await readExistingEpisodes(supabase, target.id);
      const { rows, inserts, updates } = mergeEpisodeRows(target.id, episodes, existing);
      await upsertEpisodes(supabase, rows);
      done += 1;
      totalInsert += inserts;
      totalUpdate += updates;
      console.log(
        `[nimu:eps] ${target.title} (tvdb ${target.tvdbId}): ` +
          `${episodes.length} eps → ${inserts} new, ${updates} updated`,
      );
    } catch (err) {
      console.warn(`[nimu:eps] ⚠ ${target.title} failed (non-fatal): ${err.message}`);
    }
  }
  console.log(
    `[nimu:eps] ✅ Done: ${done}/${targets.length} titles, ` +
      `${totalInsert} inserted, ${totalUpdate} updated`,
  );
}

// ── Dry run (fixtures, no network / no DB) ───────────────────────────────────

async function runDryRun() {
  const payload = JSON.parse(await readFile(resolve(FIXTURES_DIR, 'tvdb-episodes.json'), 'utf8'));
  const raw = payload?.data?.episodes ?? payload?.episodes ?? payload;
  const episodes = normalizeEpisodes(raw);

  // Simulate a partial AnimeSchedule calendar already in the DB, to prove the
  // MERGE preserves it: ep 2 already has a precise airing_at + a Crunchyroll
  // link (must survive untouched), ep 1 exists but with a null airing_at (TVDB
  // fills it). Everything else is a fresh INSERT.
  const animeId = '00000000-0000-0000-0000-000000000001';
  const existing = [
    { episode_number: 1, airing_at: null, streaming_links: [] },
    {
      episode_number: 2,
      airing_at: '2026-01-15T15:00:00.000Z',
      streaming_links: [{ platform: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/X/ep2' }],
    },
  ];
  const { rows, inserts, updates } = mergeEpisodeRows(animeId, episodes, existing);

  const seasons = [...new Set(episodes.map((e) => e.seasonNumber))].sort((a, b) => a - b);
  const existingNums = new Set(existing.map((e) => e.episode_number));
  const sampleInsert = rows.find((r) => !existingNums.has(r.episode_number));
  const sampleFilled = rows.find((r) => r.episode_number === 1); // updated: airing_at filled from TVDB
  const samplePreserved = rows.find((r) => r.episode_number === 2); // updated: airing_at + links kept

  console.log('[nimu:eps] DRY RUN (fixtures, no writes) — TVDB episode history');
  console.log(`[nimu:eps] fixture: ${raw.length} raw episodes → ${episodes.length} kept (specials without an absolute number dropped)`);
  console.log(`[nimu:eps] seasons present (dropdown groups on season_number): ${seasons.join(', ')}`);
  console.log(`[nimu:eps] merge vs ${existing.length} existing rows → ${inserts} insert, ${updates} update`);
  console.log('[nimu:eps] sample INSERT row:', JSON.stringify(sampleInsert, null, 2));
  console.log('[nimu:eps] sample UPDATE row (null airing_at filled from TVDB):', JSON.stringify(sampleFilled, null, 2));
  console.log('[nimu:eps] sample UPDATE row (real airing_at + streaming_links preserved):', JSON.stringify(samplePreserved, null, 2));
  console.log('[nimu:eps] ✅ Dry run OK — nothing written');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log(`[nimu:eps] ${DRY_RUN ? 'DRY RUN' : 'Live backfill'} starting…`);
  if (DRY_RUN) await runDryRun();
  else await runLive();
  console.log(`[nimu:eps] finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('[nimu:eps] ❌ Backfill failed:', error);
  process.exitCode = 1;
});
