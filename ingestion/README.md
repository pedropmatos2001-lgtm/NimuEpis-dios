# Nimu — Ingestion

Fetches the airing calendar and upserts it into Supabase. Runs on a schedule
via GitHub Actions, and can also be run locally.

> **Why not AniList/Jikan?** The previous pipeline violated the AniList ToS
> (mass collection / storage / competing service) and MyAnimeList's ToS via
> Jikan. Full analysis and the decision record:
> [`docs/research/RESEARCH-DATASOURCES-2026-07-29.md`](../docs/research/RESEARCH-DATASOURCES-2026-07-29.md).

## Data sources

| Source | Role | Env var | Required? |
|---|---|---|---|
| [AnimeSchedule.net API v3](https://animeschedule.net/api/v3/documentation) | **Primary**: weekly timetables (exact per-episode `episodeDate` in UTC, delays, streams) + per-show detail (names, external ids, description, genres, studios, score, accent colours) | `ANIMESCHEDULE_TOKEN` | Yes (live runs) |
| [manami anime-offline-database](https://github.com/manami-project/anime-offline-database) | Cross-source id mapping (MAL ↔ AniList ↔ Kitsu ↔ AniDB) + last-resort cover fallback. Downloaded weekly with a local cache (`.cache/`) | — | No (non-fatal) |
| [TheTVDB v4](https://thetvdb.com/api-information) | Metadata enrichment (tvdb id, description/artwork fallback) | `TVDB_API_KEY` | No (non-fatal) |
| [Kitsu API](https://kitsu.docs.apiary.io/) | Per-episode `airdate` (day only) for older shows, only in the episode backfill (`episodes-backfill.js`). Public, no key | — | No (non-fatal) |
| [TMDB](https://developer.themoviedb.org/) | **Preferred poster URLs** (artwork licence paper trail). Watch providers are deliberately NOT used (JustWatch data — commercially restricted) | `TMDB_API_KEY` | No (non-fatal) |

Poster preference: **TMDB → AnimeSchedule image → manami picture → `null`**
(the app renders a typographic fallback when `null`).

Episode times: the timetable is fetched with `tz=Etc/UTC` and stored as UTC
(`episodes.airing_at`). By default we track the **`sub`** air type (when an
episode becomes watchable subbed on streaming); override with
`ANIMESCHEDULE_AIR_TYPE=raw|sub|dub|all`.

All writes are **idempotent** upserts on natural keys:
`animes.animeschedule_route` (the AnimeSchedule slug) and
`episodes(anime_id, episode_number)`. Legacy AniList-era rows (which only have
`mal_id`) are **adopted** on first contact — matched by `mal_id`, updated in
place — so watchlists and notification preferences keep pointing at the same
rows. `animes.external_ids` (JSONB) accumulates the cross-source id map.

## How to obtain each token

### AnimeSchedule (`ANIMESCHEDULE_TOKEN`) — required

1. Create an account on [animeschedule.net](https://animeschedule.net) and add
   an **App** in your account settings; copy the Bearer token it issues.
2. ⚠️ **Commercial use requires written permission.** AnimeSchedule's API terms
   say to *ask before using the API for commercial purposes*. Before launch
   (ads/paid tiers), contact them, request authorization in writing, and file
   the reply with the project records. Their terms also require **visible
   attribution** (link to AnimeSchedule.net in the app) and minimal caching.
3. Rate limit: **120 req/min** — the client self-limits to ~95 req/min with
   retry/backoff + jitter, and honours `Retry-After` on 429.

### TheTVDB (`TVDB_API_KEY`) — optional

1. Register at [thetvdb.com/api-information](https://thetvdb.com/api-information)
   and request a v4 API key.
2. Licensing (the only provider with a published price list): free while the
   product earns <$50k/yr **with the attribution** "Metadata provided by
   TheTVDB"; $1,000/yr tier above that.

### TMDB (`TMDB_API_KEY`) — optional

1. Create an account at [themoviedb.org](https://www.themoviedb.org/), then
   Settings → API → request a key. Either the **v3 key** or the **v4 Read
   Access Token** works (the client auto-detects).
2. Terms: attribution required ("This product uses the TMDB API…"), cached
   data must be refreshed within 6 months. **Do not** enable watch-provider
   endpoints — that is JustWatch data with separate commercial restrictions.

### manami anime-offline-database — no token

Public weekly GitHub release, ODbL v1.0 + DbCL v1.0: **attribution required**
in the app (the ingestion never redistributes the database itself, only
derived id mappings). Cached in `ingestion/.cache/` for 7 days.

> **App attribution checklist** (Flutter side, tracked separately): visible
> link to AnimeSchedule.net · "Metadata provided by TheTVDB" · TMDB logo/notice
> · manami-project (ODbL).

## Run locally

```bash
cd ingestion
npm install
cp ../.env.example ./.env      # fill in SUPABASE_* + ANIMESCHEDULE_TOKEN (+ optional TVDB/TMDB)
npm run ingest
```

> Uses the **service_role** key (bypasses RLS to write the catalogue). Keep it
> server-side only — `.env` is gitignored and this key must never ship in the
> app. Tokens are read from env only and are never logged.

### Dry run (no tokens, no writes)

```bash
npm run dry-run     # = node src/run.js --dry-run
```

Runs the full mapping pipeline against the fixtures in `test/fixtures/`
(documented API shapes), prints what *would* be upserted, and exits **without
touching the network or Supabase**. Use it to validate mapper changes safely.

### Tests

```bash
npm test            # node:test — mappers, dedupe, manami index, pipeline, dry-run
```

## Scheduled run (CI)

[`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml) runs every
6 hours and on manual dispatch. Tests + dry run gate every live run. Secrets
(**GitHub → Settings → Secrets and variables → Actions**):

| Secret | Required | Value |
|--------|----------|-------|
| `SUPABASE_URL` | yes | project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase → Settings → API → `service_role` secret |
| `ANIMESCHEDULE_TOKEN` | yes | AnimeSchedule App bearer token (see above) |
| `TVDB_API_KEY` | no | TheTVDB v4 key — enrichment skipped when absent |
| `TMDB_API_KEY` | no | TMDB v3 key or v4 read token — posters skipped when absent |

## Layout

```
src/
  config.js        # env loading + validation (tokens never logged)
  http.js          # fetch with retry/backoff+jitter + client-side rate limiter
  supabase.js      # service-role client
  animeschedule.js # v3 client: weekly timetables + per-show detail + catalogue
                   #   paging (Bearer)
  manami.js        # anime-offline-database download/cache + id cross-fill
  tvdb.js          # optional TVDB v4 enrichment (login JWT + search)
  tmdb.js          # optional TMDB poster lookup
  mappers.js       # raw API → DB rows (status/streams/ids/HTML/colour mapping)
  pipeline.js      # pure transform: sources → validated rows (unit-testable)
  adult-content.js # filtro 18+ partilhado por TODOS os caminhos de inserção
  purge-adult.js   # apaga os 18+ que já estão guardados (simulação por omissão)
  util.js          # sleep, ISO weeks, chunking, dedupe (animes + episodes)
  run.js           # orchestration + --dry-run (entry point)
  descriptions.js  # backfills the missing animes.description (see below)
  extras.js        # videoclipes/PV → media_type 'Music'/'PV' (a regra, pura)
  reclassify-extras.js # a passagem pelo catálogo que aplica essa regra (ver abaixo)
data/
  extras-overrides.json # exceções à mão: o que nunca/sempre é videoclipe ou PV
  audit-data.js    # read-only data audit, run by hand (see below)
test/
  fixtures/        # documented-shape API payloads (power tests + dry run)
  *.test.js        # node:test suites
```

## Filling the missing synopses (`descriptions.js`)

99.7% of the catalogue has **no synopsis**: 28 707 of 28 784 rows have a NULL
`description`. The manami import (which is ~98% of the catalogue) carries none,
and the AnimeSchedule pipeline only writes one for the ~90 titles inside the
weekly airing window. Pages without text don't rank — this is why the sitemap
is deliberately capped at 2 000 entries.

```bash
npm run descriptions:dry    # fixture only — no network, no Supabase
npm run descriptions:plan   # reads the DB + API for real, writes NOTHING
npm run descriptions        # live: sweeps the catalogue and fills the blanks
node src/descriptions.js --limit=500   # bounded run, most-followed titles first
```

**Source: AnimeSchedule, not AniList.** The obvious move is to pull them from
AniList, and it is the wrong one — the same one this project already reversed.
AniList's terms prohibit *"hoarding or mass collection"* and use as a *"backup
or data storage service"* (see
[`docs/research/RESEARCH-DATASOURCES-2026-07-29.md`](../docs/research/RESEARCH-DATASOURCES-2026-07-29.md));
downloading ~20 000 synopses into our own table is both at once. AnimeSchedule
— already licensed here, and already named as this column's owner in the
migration comment — answers by `mal_id` and knows the back catalogue. Measured
hit rate on a stratified 100-title sample of rows lacking a synopsis: **92% for
2020+, 68% for 2005–2019, 68% up to 2004, 0% for the year-less rows** (ad
spots, promo shorts and donghua — the pages we don't want indexed anyway).

**Why it pages the catalogue instead of asking per title.** `GET /anime?page=N`
returns 18 *complete* records per request, `description` and `websites` (the
`mal_id`) included: ~1 080 requests for all 19 416 records, versus 28 707 going
row by row. At the shared ~95 req/min limiter that is ~12 minutes instead of
five-plus hours. The `&years=` filter exists but is **not** trustworthy — 2023
returns 6 records and 2024 returns 736 — so the sweep is unfiltered.

**It writes `description` and nothing else.** Every other column has a declared
owner (`catalogue.js`), and this pass never touches them. The write is
`UPDATE … WHERE id = ? AND description IS NULL`, so a synopsis that already
exists is never overwritten — even if another pipeline filled it between the
read and the write — and a second run writes nothing at all.

## Videoclipes e PV (`extras.js`, `reclassify-extras.js`)

O catálogo tem ~5 000 linhas que não são anime para ver: videoclipes (o
"Echo" que aparecia ao pesquisar "Solo Leveling"), PV, CM, teasers e
trailers. Ficam na base (nunca se apagam: levavam listas e episódios vistos),
mas com `media_type` `'Music'` ou `'PV'`, e o site não os mostra
(`web/lib/data/extras.ts`). Sem coluna nova: a `media_type` já existia e já
recebia "Music" do AnimeSchedule.

```bash
npm run extras:dry    # fixture: sem rede nem base
npm run extras:plan   # lê a sério e diz o que faria; basta SUPABASE_ANON_KEY
npm run extras        # escreve só o que muda (corre em cada ingestão)
```

A regra, por ordem: a lista `data/extras-overrides.json`; o AnimeSchedule diz
"Music" (`/anime?media-types=music`, verificado ficha a ficha); PV, CM, Teaser
ou Trailer como palavra no título, fora de TV, ≤15 min por episódio; e, só
onde o AnimeSchedule não decide, manami `SPECIAL` + etiqueta `music` + 1
episódio + ≤8 min. Medido a 2026-11-04: 2 502 + 2 160 + 315 = 4 977 linhas.
O mapeador do manami e o do AnimeSchedule aplicam a mesma regra à entrada.

## Episodes for everything (`episodes-backfill.js`)

Every title that has started airing gets its episode list (owner's request,
2026-11-04). Sources, in priority order: AnimeSchedule past timetables (exact
time; history starts 2021-W41), Kitsu (day only), TheTVDB (only a tvdb id no
other row shares, and only when the count matches the total), and the
AnimeSchedule catalogue premiere for episode 1. When no source has a date, the
episodes 1..N are created from the manami total with no date and
`air_date_unknown = true` (migration `20261104000100`). AniList is not used:
its terms forbid storing the data.

```bash
npm run episodes:backfill                      # dry run (default): read-only, prints counts per source
npm run episodes:backfill -- --aplicar         # write (service role)
npm run episodes:backfill -- --limite=15000    # titles per run; the cursor resumes the next run
npm run episodes:backfill -- --minutos=45      # wall-clock budget; stops cleanly, keeps the cursor
npm run episodes:backfill -- --anime=<slug>    # one title
```

Idempotent, resumable (cursor in `.cache/episodes/`), never duplicates
(`on conflict do nothing`), never replaces a better date with a worse one,
never touches future-dated episodes and never calls the notification fan-out.
It also never writes or changes a date from the last three days
(`RECENT_GUARD_MS`): the `nimu-fanout-aired` pg_cron job notifies about ANY
episode whose `episode_notify_at` falls in the last two hours, so a recent
date written by the backfill would notify people. Recent episodes belong to
the weekly ingestion.

Kitsu per-episode dates are only kept when plausible (`plausibleKitsuIndex`):
inside the entry's start/end dates, never going backwards by episode number,
and with the numbering not shifted (Yu Yu Hakusho's episode 6 carries the
premiere date). Otherwise the episode is created undated. Music videos and
PVs get no episodes: rows already stored as `Music`/`PV`, and rows that
`extras.js` (the rule above, imported, with the same overrides) would mark but
the reclassification has not marked yet (`wouldBeExtra`).

The real run is the `Episodios para tudo (backfill)` workflow (`confirmar=SIM`,
main only). It shares the ingestion's concurrency group, so each run is
bounded: the script stops itself after 45 minutes (`--minutos=45`), finishes
the batch in progress, leaves the cursor at the last title it handled and exits
0; the step is killed at 48 minutes and the job at 55. The next run resumes
from the cursor. The 6-hourly `run.js` does the same, cheaply and with hard caps
(600 titles, 2 minutes, 10 Kitsu requests with a 20 s timeout each), for the
titles in this run's timetable, the ones whose status this run changed, and
the ones created in the last two days (`backfillRecent`).

## Auditing the data (`audit-data.js`)

Answers four questions about the catalogue and writes nothing. Reach for it
before and after a repair pass, to see whether the repair actually moved
anything.

```bash
npm run audit          # full report, covers verified over HTTP (~17s)
npm run audit:fast     # DB only, no network (~12s)
npm run audit:json     # same report as JSON on stdout, progress on stderr
node src/audit-data.js --sample=400 --examples=12
```

**It cannot write, and that is enforced rather than promised.** The Supabase
client goes through `readOnlyClient()`, a proxy that throws on `insert`,
`update`, `upsert`, `delete` and `rpc`. An audit that repairs loses the
before picture, so repairs stay where they belong: `npm run covers` and
`npm run descriptions`.

**Missing covers and dead covers are two different numbers.** `cover_image_url
IS NULL` misses the rows whose URL is stored but rejected at the origin, so a
sample is fetched. Origins under 150 rows are checked in full and the large
ones are sampled, because the dead covers do not spread evenly: the run of
2026-08-21 found 4 dead in a 90 row origin (all HTTP 403) and 0 in the 150
sampled from the 28 373 row origin. A proportional sample would have sent 5
requests to the small origin and missed all four most of the time. Sampling is
at a fixed stride, so two runs check the same rows and a difference between two
reports is a change in the data.

**The dash rule, since it is the one that risks crying wolf.** What gets flagged
is the sign that separates ideas, never the hyphen that joins a compound:
`bem-vindo` and `guarda-chuva` come through clean, `" - "` and `" — "` do not.
Five exceptions, each one earned against real rows: numeric ranges (`1-4`,
`1939 – 1945`), a negative sign, a list bullet or dialogue dash at the start of
a line, a decorative rule of three signs or more, and the suspended hyphen
followed by a conjunction. That last one is not Portuguese-only: the catalogue
holds text in many languages, and `brother- and sister-in-law` is as correct as
`pós- e pré-guerra`.

Read the title columns differently from the prose columns. In `animes.title` a
dash is usually part of the work's name and rewriting it would rename the work;
in `animes.description` and `episodes.overview` it is our own punctuation.

Baseline from the run of 2026-08-21, against 28 784 titles and 14 351 episodes:

| Check | Result |
| --- | --- |
| No synopsis | 28 707 (99.7%), of which 249 of the 319 airing |
| No cover | 206 (0.7%) |
| Cover stored but dead | ~4, all HTTP 403 from one origin |
| Dash or hyphen misused | 1 536 rows, 1 718 occurrences |
| `upcoming` with the season already over | 33, spread over 2020 to 2026 |

## Database schema notes

Migration `supabase/migrations/20260729010000_multi_source_ingestion.sql`:

- `animes.mal_id` is now **nullable** (still UNIQUE) — not every title has a
  MAL id; `animes.animeschedule_route` (UNIQUE) is the upsert key.
- `animes.external_ids` JSONB (`{mal, anilist, kitsu, anidb, tvdb, tmdb,
  animeschedule_route}`) with a GIN index for containment lookups.
- New defensive metadata columns: `description`, `genres`, `studios`, `score`
  (0–100), `accent_color` (hex). All nullable/defaulted; RLS unchanged.
