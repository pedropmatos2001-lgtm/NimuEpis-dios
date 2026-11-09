import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/run.js');

test('`run.js --dry-run` completes on fixtures without env, network or Supabase', () => {
  // Scrub every credential from the child env to PROVE the dry run needs none
  // and can never touch a real backend.
  const env = { ...process.env };
  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ANIMESCHEDULE_TOKEN',
    'TVDB_API_KEY',
    'TMDB_API_KEY',
  ]) {
    delete env[key];
  }

  const res = spawnSync(process.execPath, [entry, '--dry-run'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(res.status, 0, `stderr was: ${res.stderr}`);
  assert.match(res.stdout, /DRY RUN \(fixtures, no writes\)/);
  assert.match(res.stdout, /would upsert 3 animes, 3 episodes/);
  assert.match(res.stdout, /Dry run OK .* nothing written/);
});
