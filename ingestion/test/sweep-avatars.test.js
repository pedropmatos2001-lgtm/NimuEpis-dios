import test from 'node:test';
import assert from 'node:assert/strict';

import { assertPlanIsSane, MIN_AGE_MS, planAvatarSweep, SKIP_FOLDER } from '../src/sweep-avatars.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const OLD = new Date(NOW.getTime() - MIN_AGE_MS - 1000).toISOString();
const FRESH = new Date(NOW.getTime() - 60 * 1000).toISOString();
const ALICE = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';

test('conta apagada: todas as fotos antigas saem', () => {
  const folders = new Map([[GONE, [{ name: 'avatar-a.webp', createdAt: OLD }, { name: 'avatar-b.png', createdAt: OLD }]]]);
  const plan = planAvatarSweep(folders, new Map(), NOW);
  assert.deepEqual(plan.paths, [`${GONE}/avatar-a.webp`, `${GONE}/avatar-b.png`]);
  assert.equal(plan.deletedAccounts, 1);
  assert.equal(plan.staleFiles, 0);
});

test('conta ativa: fica a foto do perfil, saem os restos', () => {
  const folders = new Map([[ALICE, [{ name: 'avatar-atual.webp', createdAt: OLD }, { name: 'avatar-velho.jpg', createdAt: OLD }]]]);
  const keep = new Map([[ALICE, `${ALICE}/avatar-atual.webp`]]);
  const plan = planAvatarSweep(folders, keep, NOW);
  assert.deepEqual(plan.paths, [`${ALICE}/avatar-velho.jpg`]);
  assert.equal(plan.staleFiles, 1);
  assert.equal(plan.deletedAccounts, 0);
});

test('nunca apaga um upload recente nem um ficheiro sem data', () => {
  const folders = new Map([
    [ALICE, [{ name: 'avatar-novo.webp', createdAt: FRESH }]],
    [GONE, [{ name: 'avatar-x.webp', createdAt: null }]],
  ]);
  const plan = planAvatarSweep(folders, new Map([[ALICE, null]]), NOW);
  assert.deepEqual(plan.paths, []);
});

test('pastas que não são ids de utilizador não se tocam', () => {
  const folders = new Map([['public', [{ name: 'logo.png', createdAt: OLD }]]]);
  assert.deepEqual(planAvatarSweep(folders, new Map(), NOW).paths, []);
});

test('perfil com um avatar_url do bucket que não se percebe: a pasta fica intacta', () => {
  const folders = new Map([[ALICE, [{ name: 'avatar-a.webp', createdAt: OLD }]]]);
  assert.deepEqual(planAvatarSweep(folders, new Map([[ALICE, SKIP_FOLDER]]), NOW).paths, []);
});

test('travão: muitas fotos em uso sem ficheiro param tudo', () => {
  const keep = new Map();
  const folders = new Map();
  for (let i = 0; i < 5; i += 1) {
    const id = `3333333${i}-3333-4333-8333-333333333333`;
    keep.set(id, `${id}/avatar-em-uso.webp`);
    folders.set(id, [{ name: 'outro-nome.webp', createdAt: OLD }]);
  }
  assert.throws(() => assertPlanIsSane(folders, keep), /nada foi apagado/);
});

test('travão: com as fotos em uso no sítio, deixa seguir', () => {
  const keep = new Map([[ALICE, `${ALICE}/avatar-a.webp`]]);
  const folders = new Map([[ALICE, [{ name: 'avatar-a.webp', createdAt: OLD }]]]);
  assert.doesNotThrow(() => assertPlanIsSane(folders, keep));
});
