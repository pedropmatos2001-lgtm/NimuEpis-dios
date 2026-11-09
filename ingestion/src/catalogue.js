// Catalogue ingestion entry point — harvests the FULL manami anime-offline-
// database into `animes` so Discover can browse every title, not just the
// ~weekly AnimeSchedule airing window.
//
//   node src/catalogue.js             → live (manami-DB → Supabase, MERGE)
//   node src/catalogue.js --dry-run   → fixture only; no network, no Supabase
//   node src/catalogue.js --limit=N   → cap to N rows (bounded test run)
//
// Merge, never clobber: for a mal_id that ALREADY exists we only GAP-FILL the
// null facets (year/season/media_type) and UNION genres — title/cover/
// description/score/popularity set by the AnimeSchedule pipeline stay intact.
// For a mal_id not present we INSERT a new (shallow) catalogue row. mal_id is
// UNIQUE, so the whole thing upserts idempotently: a second run writes nothing.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { manamiEntryToAnimeRow } from './catalogue-mappers.js';
import { chunk, dedupeByKey } from './util.js';

const UPSERT_CHUNK = 500; // batch size for animes upserts
const IN_LIST_CHUNK = 150; // keeps PostgREST .in() URLs comfortably short
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseLimit(process.argv);

const here = dirname(fileURLToPath(import.meta.url));
// A tiny curated fixture (MAL-less, adult, and unmapped-tag edge cases) so the
// dry run exercises the whole mapper without touching the network.
const FIXTURE = resolve(here, '../test/fixtures/catalogue-sample.json');

/** Parse `--limit=N` (positive integer) or return null. */
function parseLimit(argv) {
  const arg = argv.find((a) => a.startsWith('--limit='));
  if (!arg) return null;
  const n = Number(arg.slice('--limit='.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Fail fast (names only, never values) when a live run lacks its Supabase env.
 *  Unlike run.js this needs NO AnimeSchedule token — manami is a plain download. */
function assertCatalogueConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}.\n` +
        '→ Local: copy .env.example to ingestion/.env and fill it in.\n' +
        '→ CI: add them as GitHub Actions secrets.\n' +
        '→ No credentials? Use `node src/catalogue.js --dry-run` (fixture only).',
    );
  }
}

/** manami entries — the download for a live run, the fixture for a dry run. */
async function loadEntries() {
  if (DRY_RUN) {
    const json = JSON.parse(await readFile(FIXTURE, 'utf8'));
    return Array.isArray(json) ? json : json.data;
  }
  const { loadManamiDatabase } = await import('./manami.js');
  return loadManamiDatabase();
}

/** Map every entry, drop skipped ones, de-dupe by mal_id (the upsert key). */
export function mapEntries(entries) {
  const rows = [];
  let rejected = 0;
  for (const entry of entries ?? []) {
    const row = manamiEntryToAnimeRow(entry);
    if (row) rows.push(row);
    else rejected += 1;
  }
  const deduped = dedupeByKey(rows, (r) => r.mal_id);
  return { rows: deduped, rejected, dupes: rows.length - deduped.length };
}

/** Existing animes indexed by mal_id (only the columns the merge needs). */
async function fetchExistingByMal(supabase, malIds) {
  const byMal = new Map();
  for (const idChunk of chunk(malIds, IN_LIST_CHUNK)) {
    const { data, error } = await supabase
      .from('animes')
      .select('id, mal_id, year, season, media_type, genres')
      .in('mal_id', idChunk);
    if (error) throw error;
    for (const row of data) byMal.set(row.mal_id, row);
  }
  return byMal;
}

/** existing ∪ incoming genres, order-preserving and de-duplicated. */
export function unionGenres(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const g of [...(existing ?? []), ...(incoming ?? [])]) {
    if (g && !seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** Same genres, same order (unionGenres keeps existing order first, so equal
 *  length ⇒ nothing was added). */
function sameGenres(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Gap-fill patch for an existing row, or null when there is nothing to change.
 *
 * Only the null facets are filled and genres are unioned; title/cover/
 * description/score/popularity are never included, so the AnimeSchedule data is
 * untouchable. The payload keeps a FIXED column set (mal_id + the four merged
 * fields) so a batch upsert stays uniform for PostgREST; unchanged fields are
 * rewritten to their own value, and a fully-complete row returns null (→ the
 * re-run idempotency this whole design turns on).
 */
export function computeGapFill(existing, manami) {
  const merged = {
    mal_id: existing.mal_id,
    year: existing.year ?? manami.year ?? null,
    season: existing.season ?? manami.season ?? null,
    media_type: existing.media_type ?? manami.media_type ?? null,
    genres: unionGenres(existing.genres, manami.genres),
  };
  const unchanged =
    merged.year === (existing.year ?? null) &&
    merged.season === (existing.season ?? null) &&
    merged.media_type === (existing.media_type ?? null) &&
    sameGenres(merged.genres, existing.genres);
  return unchanged ? null : merged;
}

/** Batched upsert on a conflict key. With `ignoreDuplicates` it is ON CONFLICT
 *  DO NOTHING (insert-only: never touches an existing row → never clobbers). */
async function upsertChunks(supabase, rows, onConflict, ignoreDuplicates = false) {
  for (const batch of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await supabase
      .from('animes')
      .upsert(batch, { onConflict, ignoreDuplicates });
    if (error) throw error;
  }
}

/**
 * Apply gap-fill patches to EXISTING rows via UPDATE, one per row.
 *
 * WHY UPDATE, not upsert: a patch is `{mal_id, year, season, media_type,
 * genres}` with NO title. Upserting it risks an INSERT (if the conflict target
 * doesn't match for any reason), which violates `title NOT NULL`. An UPDATE that
 * matches nothing is a harmless no-op — so a stale/false-positive match can
 * never create a title-less row. Only pre-existing rows reach here (a few
 * hundred among tens of thousands), so per-row calls are cheap.
 */
async function updateGapFills(supabase, patches) {
  let count = 0;
  for (const { mal_id, ...fields } of patches) {
    const { error } = await supabase.from('animes').update(fields).eq('mal_id', mal_id);
    if (error) throw error;
    count += 1;
  }
  return count;
}

async function main() {
  const startedAt = Date.now();
  console.log(
    `[nimu:catalogue] ${DRY_RUN ? 'DRY RUN (fixture, no writes)' : 'Live catalogue ingestion'} starting…`,
  );

  const entries = await loadEntries();
  if (!DRY_RUN) console.log(`[nimu:catalogue] manami-DB loaded (${entries.length} entries)`);

  let { rows, rejected, dupes } = mapEntries(entries);
  console.log(
    `[nimu:catalogue] mapped ${rows.length} catalogue rows ` +
      `(${rejected} skipped: no MAL id / adult / untitled; ${dupes} duplicate mal_id collapsed)`,
  );

  if (LIMIT && rows.length > LIMIT) {
    rows = rows.slice(0, LIMIT);
    console.log(`[nimu:catalogue] --limit=${LIMIT} → capped to ${rows.length} rows`);
  }

  if (DRY_RUN) {
    console.log(
      `[nimu:catalogue] would MERGE ${rows.length} rows into animes (upsert onConflict mal_id)`,
    );
    for (const sample of rows.slice(0, 3)) {
      console.log('[nimu:catalogue] sample row:', JSON.stringify(sample, null, 2));
    }
    console.log(
      `[nimu:catalogue] ✅ Dry run OK in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — nothing written`,
    );
    return;
  }

  assertCatalogueConfig();
  const { supabase } = await import('./supabase.js');

  // Read the rows that ALREADY exist (by mal_id) BEFORE writing — a few hundred
  // AnimeSchedule/legacy rows among the tens of thousands of manami rows.
  const existingByMal = await fetchExistingByMal(
    supabase,
    rows.map((r) => r.mal_id),
  );

  // Gap-fill patches for the pre-existing rows (fill null facets + union genres).
  // Computed BEFORE the insert so freshly-inserted rows don't count as "existing".
  const gapFills = [];
  let alreadyComplete = 0;
  for (const row of rows) {
    const existing = existingByMal.get(row.mal_id);
    if (!existing) continue;
    const patch = computeGapFill(existing, row);
    if (patch) gapFills.push(patch);
    else alreadyComplete += 1;
  }

  // INSERT every mapped row, SKIPPING mal_ids already present (ON CONFLICT DO
  // NOTHING). Two guarantees: existing rows are never clobbered, and every
  // inserted row carries a title (the mapper enforces it) — so `title NOT NULL`
  // cannot be violated. New titles: everything not already in the catalogue.
  await upsertChunks(supabase, rows, 'mal_id', true);
  const insertedCount = rows.length - existingByMal.size;

  // Gap-fill the pre-existing rows via UPDATE (never inserts — see updateGapFills).
  const gapFilledCount = await updateGapFills(supabase, gapFills);

  console.log(
    `[nimu:catalogue] ✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `~${insertedCount} new inserted (existing skipped), ${gapFilledCount} gap-filled, ` +
      `${alreadyComplete} already complete`,
  );
}

// Run only when executed directly (`node src/catalogue.js`), not when imported
// by a test — so the pure merge helpers above stay unit-testable.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[nimu:catalogue] ❌ Catalogue ingestion failed:', error);
    process.exitCode = 1;
  });
}
