import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Local-dev convenience: load .env from ingestion/ or the repo root if present.
// In CI these come from GitHub Actions secrets and no .env exists (no-op then).
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../.env') }); // ingestion/.env
loadEnv({ path: resolve(here, '../../.env') }); // repo-root .env

// Reads are centralised here; nothing else touches process.env. Tokens must
// NEVER be logged — keep them out of error messages and console output.
export const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // AnimeSchedule.net API v3 — primary source (calendar + streams). Required
  // for live runs; --dry-run works without it.
  animescheduleToken: process.env.ANIMESCHEDULE_TOKEN,

  // Optional enrichment. Absent keys simply skip that enrichment step.
  tvdbApiKey: process.env.TVDB_API_KEY,
  tmdbApiKey: process.env.TMDB_API_KEY,

  // Which release time to track: 'sub' (default — when the episode becomes
  // watchable subbed on streaming), 'raw' (Japanese TV broadcast), 'dub', 'all'.
  airType: process.env.ANIMESCHEDULE_AIR_TYPE ?? 'sub',

  // ── Web Push delivery worker (src/push-sender.js) ────────────────────────
  // VAPID keypair that signs the push. The SAME values the owner already has on
  // Vercel go in as GitHub Actions secrets. Only needed to ACTUALLY send — the
  // dry-run and payload building don't touch them. Never log these.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  // A mailto: or https: the push service can contact (required by the spec).
  vapidSubject: process.env.VAPID_SUBJECT,
  // Absolute web origin used to build the push click target + icon URL. Optional
  // (defaults to https://nimu.app in push-sender.js). Same var name the Edge
  // Function reference uses.
  publicSiteUrl: process.env.PUBLIC_SITE_URL,
  // Optional tuning (raw strings; parsed/clamped in push-sender.js).
  pushBatchSize: process.env.PUSH_SEND_BATCH_SIZE,
  pushTtlSeconds: process.env.PUSH_SEND_TTL_SECONDS,
};

// Identifiable User-Agent (polite-API requirement, e.g. AnimeSchedule / manami).
// Optionally append a contact via INGEST_CONTACT (URL or e-mail).
const contact = process.env.INGEST_CONTACT;
export const USER_AGENT = `nimu-ingestion/0.2.0${contact ? ` (${contact})` : ' (anime release tracker ingestion bot)'}`;

/** Fail fast (with names only, never values) when a live run lacks its env. */
export function assertLiveConfig() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANIMESCHEDULE_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}.\n` +
        '→ Local: copy .env.example to ingestion/.env and fill it in.\n' +
        '→ CI: add them as GitHub Actions secrets.\n' +
        '→ No credentials? Use `npm run ingest -- --dry-run` (fixtures only).',
    );
  }
}

/**
 * Fail fast (names only, never values) when the Web Push SENDER lacks its env.
 * Needs Supabase (to read the outbox + prune subscriptions) AND the full VAPID
 * triple (to sign the push). The dry-run does NOT call this — it must run without
 * VAPID keys — so this gate applies only to a real `npm run push:send`.
 */
export function assertPushConfig() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s) for web push: ${missing.join(', ')}.\n` +
        '→ CI: add them as GitHub Actions secrets (see .github/workflows/push.yml).\n' +
        '→ The VAPID_* values are the SAME ones already set on Vercel.\n' +
        '→ Just checking what it would send? Use `npm run push:send:dry` (no send, no VAPID needed).',
    );
  }
}
