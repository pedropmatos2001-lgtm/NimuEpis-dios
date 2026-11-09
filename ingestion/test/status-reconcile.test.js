// O estado das fichas pelos episódios (src/status-reconcile.js), com os títulos
// reais de 2026-11-04 (o mesmo ficheiro que os testes da web usam).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  factsFor,
  needsProbe,
  planStatusChanges,
  reconcileStatuses,
  windowByAnime,
} from '../src/status-reconcile.js';
import { AGORA, REAIS, episodiosDe } from '../../web/test/fixtures/estado-real-2026-11-04.mjs';

/**
 * Uma Supabase em memória, só com o que o módulo usa. Cada consulta filtra as
 * linhas como o PostgREST faria; `update` regista o que se escreveu.
 */
function fakeSupabase(tables) {
  const writes = [];
  const from = (name) => {
    const filters = [];
    let order = null;
    let limit = Infinity;
    let range = null;
    let patch = null;
    const q = {
      select() { return q; },
      update(p) { patch = p; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
      gt(c, v) { filters.push((r) => r[c] != null && r[c] > v); return q; },
      gte(c, v) { filters.push((r) => r[c] != null && r[c] >= v); return q; },
      lte(c, v) { filters.push((r) => r[c] != null && r[c] <= v); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      // Só a forma que o módulo usa: "a.not.is.null,b.not.is.null".
      or(expr) {
        const cols = expr.split(',').map((part) => part.replace('.not.is.null', ''));
        filters.push((r) => cols.some((c) => r[c] != null));
        return q;
      },
      order(c, { ascending = true } = {}) { order = { c, ascending }; return q; },
      limit(n) { limit = n; return q; },
      range(a, b) { range = [a, b]; return q; },
      then(resolve, reject) {
        try {
          let rows = tables[name].filter((r) => filters.every((f) => f(r)));
          if (patch) {
            for (const r of rows) { Object.assign(r, patch); writes.push({ id: r.id, ...patch }); }
            return resolve({ data: null, error: null });
          }
          if (order) {
            const { c, ascending } = order;
            rows = [...rows].sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (ascending ? 1 : -1));
          }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          rows = rows.slice(0, limit);
          return resolve({ data: rows.map((r) => ({ ...r })), error: null });
        } catch (err) {
          return reject(err);
        }
      },
    };
    return q;
  };
  return { from, writes };
}

function tabelas(titulos) {
  const animes = [];
  const episodes = [];
  for (const [id, t] of Object.entries(titulos)) {
    animes.push({ id, title: t.title, status: t.status, schedule_note: t.scheduleNote });
    for (const e of episodiosDe(t)) {
      episodes.push({
        id: `${id}#${e.episodeNumber}`,
        anime_id: id,
        episode_number: e.episodeNumber,
        airing_at: e.airingAt === null ? null : new Date(e.airingAt).toISOString(),
        season_number: e.seasonNumber ?? null,
        title: e.title ?? null,
        overview: null,
        image_url: null,
      });
    }
  }
  return { animes, episodes };
}

test('reconcileStatuses: Slime, Mushoku e Plannosaurus terminam; One Piece, Hanakappa e Chibi Godzilla 3 ficam em pausa', async () => {
  const db = fakeSupabase(tabelas(REAIS));
  const linhas = [];
  const changes = await reconcileStatuses(db, { now: AGORA, log: (l) => linhas.push(l) });
  assert.deepEqual(
    changes.map((c) => [c.id, c.from, c.to]).sort(),
    [
      ['chibiGodzilla3', 'airing', 'hiatus'],
      ['hanakappa', 'airing', 'hiatus'],
      ['mushoku', 'airing', 'finished'],
      ['onePiece', 'airing', 'hiatus'],
      ['plannosaurus', 'airing', 'finished'],
      ['slime', 'airing', 'finished'],
    ],
  );
  assert.deepEqual(db.writes.map((w) => [w.id, w.status]).sort(), [
    ['chibiGodzilla3', 'hiatus'],
    ['hanakappa', 'hiatus'],
    ['mushoku', 'finished'],
    ['onePiece', 'hiatus'],
    ['plannosaurus', 'finished'],
    ['slime', 'finished'],
  ]);

  // Idempotente: a segunda corrida não encontra nada.
  const outra = await reconcileStatuses(db, { now: AGORA, log: () => {} });
  assert.deepEqual(outra, []);
  assert.equal(db.writes.length, 6);
});

test('reconcileStatuses --dry-run não escreve nada', async () => {
  const db = fakeSupabase(tabelas(REAIS));
  const changes = await reconcileStatuses(db, { now: AGORA, dryRun: true, log: () => {} });
  assert.equal(changes.length, 6);
  assert.equal(db.writes.length, 0);
});

test('reconcileStatuses: One Piece em pausa volta ao ar quando o 1181 tem data', async () => {
  const t = tabelas({ onePiece: { ...REAIS.onePiece, status: 'hiatus' } });
  t.episodes.find((e) => e.episode_number === 1181).airing_at = new Date(AGORA.getTime() + 5 * 86_400_000).toISOString();
  const db = fakeSupabase(t);
  const changes = await reconcileStatuses(db, { now: AGORA, log: () => {} });
  assert.deepEqual(changes.map((c) => [c.id, c.to]), [['onePiece', 'airing']]);
});

test('reconcileStatuses: uma terminada com episódio esta semana volta ao ar (a temporada nova)', async () => {
  const t = tabelas({ slime: { ...REAIS.slime, status: 'finished' } });
  t.episodes.push({ id: 'slime#97', anime_id: 'slime', episode_number: 97, airing_at: new Date(AGORA.getTime() + 2 * 86_400_000).toISOString() });
  const db = fakeSupabase(t);
  const changes = await reconcileStatuses(db, { now: AGORA, log: () => {} });
  assert.deepEqual(changes.map((c) => [c.id, c.from, c.to]), [['slime', 'finished', 'airing']]);
});

test('a escrita leva o estado antigo no filtro: não pisa uma mudança feita entretanto', async () => {
  const t = tabelas({ slime: REAIS.slime });
  const db = fakeSupabase(t);
  const original = db.from;
  db.from = (name) => {
    const q = original(name);
    const update = q.update;
    q.update = (p) => {
      t.animes[0].status = 'cancelled'; // outro passo mexeu nela entretanto
      return update(p);
    };
    return q;
  };
  await reconcileStatuses(db, { now: AGORA, log: () => {} });
  assert.equal(t.animes[0].status, 'cancelled');
});

test('windowByAnime + needsProbe: uma série a dar decide-se só pela janela', () => {
  const now = AGORA;
  const w = windowByAnime(
    [
      { anime_id: 'a', airing_at: '2026-10-28T15:30:00Z' },
      { anime_id: 'a', airing_at: '2026-11-11T15:30:00Z' },
      { anime_id: 'a', airing_at: '2026-11-04T15:30:00Z' },
      { anime_id: 'b', airing_at: '2026-11-06T23:00:00Z' },
    ],
    now,
  );
  assert.deepEqual(w.get('a'), { aired: true, nextAiringAt: '2026-11-04T15:30:00Z' });
  assert.equal(needsProbe(w.get('a')), false);
  // b: só futuro na janela, é preciso saber se alguma vez saiu alguma coisa
  assert.equal(needsProbe(w.get('b')), true);
  assert.equal(needsProbe(undefined), true);
});

test('reconcileStatuses: terminada há dias com episódios sem data (projeções antigas) não volta ao ar', async () => {
  // BLEACH TYBW "The Calamity", 2026-11-04: 10 episódios, o 10.º a
  // 2026-10-26, e o 11 a 13 sem data. A AnimeSchedule e a AniList dão-na
  // terminada.
  const dia = 86_400_000;
  const t = {
    animes: [{ id: 'bleach', title: 'BLEACH', status: 'finished', schedule_note: null }],
    episodes: Array.from({ length: 13 }, (_, i) => ({
      id: `bleach#${i + 1}`,
      anime_id: 'bleach',
      episode_number: i + 1,
      airing_at: i < 10 ? new Date(AGORA.getTime() - (10 - i) * 7 * dia + 6 * dia).toISOString() : null,
      season_number: null,
      title: null,
      overview: null,
      image_url: null,
    })),
  };
  const db = fakeSupabase(t);
  assert.deepEqual(await reconcileStatuses(db, { now: AGORA, log: () => {} }), []);
  assert.equal(db.writes.length, 0);
});

test('planStatusChanges: sem episódios nenhuns não há prova, fica como está', () => {
  const animes = [{ id: 'mt', title: 'Marriagetoxin', status: 'airing', schedule_note: null }];
  const probes = new Map([['mt', { airedEver: false, nextAiringAt: null, episodesPending: false }]]);
  assert.deepEqual(planStatusChanges(animes, new Map(), probes, AGORA), []);
  const f = factsFor(animes[0], undefined, probes.get('mt'));
  assert.equal(f.airedEver, false);
  assert.equal(f.pauseNote, false);
});

test('reconcileStatuses: sem os metadados do TVDB, o Slime parado fica em pausa e não terminado', async () => {
  const t = tabelas({ slime: REAIS.slime });
  for (const e of t.episodes) e.title = null;
  const db = fakeSupabase(t);
  const changes = await reconcileStatuses(db, { now: AGORA, log: () => {} });
  assert.deepEqual(changes.map((c) => [c.id, c.to]), [['slime', 'hiatus']]);
});
