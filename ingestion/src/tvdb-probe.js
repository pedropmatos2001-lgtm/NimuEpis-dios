// Sonda: o que a pesquisa do TVDB devolve de facto, campo a campo, para os
// títulos dados. Serve para afinar `pickMatchingHit` com dados e não com o
// swagger. Só lê. Uso: node src/tvdb-probe.js "Hell Mode" "Link Click"
import { config } from './config.js';
import { fetchJson } from './http.js';
import { login, limiter } from './tvdb.js';

if (!config.tvdbApiKey) {
  console.error('falta TVDB_API_KEY');
  process.exit(1);
}
const token = await login();
for (const termo of process.argv.slice(2)) {
  const params = new URLSearchParams({ query: termo, type: 'series' });
  const json = await fetchJson(`https://api4.thetvdb.com/v4/search?${params}`, {
    label: 'probe',
    headers: { Authorization: `Bearer ${token}` },
    limiter,
  });
  console.log(`\n=== "${termo}": ${(json?.data ?? []).length} resultado(s)`);
  for (const h of (json?.data ?? []).slice(0, 5)) {
    console.log(
      JSON.stringify({
        tvdb_id: h.tvdb_id,
        name: h.name,
        genres: h.genres,
        primary_type: h.primary_type,
        type: h.type,
        country: h.country,
        primary_language: h.primary_language,
        year: h.year,
        network: h.network,
        studios: h.studios,
        companies: h.companies,
        remote_ids: (h.remote_ids ?? []).map((r) => `${r.sourceName}:${r.id}`),
        aliases: (h.aliases ?? []).slice(0, 4),
        translations_eng: h.translations?.eng,
      }),
    );
  }
}

// Trailers da série que a pesquisa escolheria (pickMatchingHit), para medir a
// cobertura do TVDB antes de ligar os trailers à ingestão.
const { pickMatchingHit } = await import('./tvdb.js');
for (const termo of process.argv.slice(2)) {
  const params = new URLSearchParams({ query: termo, type: 'series' });
  const json = await fetchJson(`https://api4.thetvdb.com/v4/search?${params}`, {
    label: 'probe',
    headers: { Authorization: `Bearer ${token}` },
    limiter,
  });
  const hit = pickMatchingHit(json?.data, termo);
  if (!hit) {
    console.log(`\n### "${termo}": sem série correspondente`);
    continue;
  }
  const ext = await fetchJson(`https://api4.thetvdb.com/v4/series/${hit.tvdb_id}/extended?short=false`, {
    label: 'probe-extended',
    headers: { Authorization: `Bearer ${token}` },
    limiter,
  });
  const trailers = ext?.data?.trailers ?? [];
  console.log(`\n### "${termo}" -> ${hit.tvdb_id}: ${trailers.length} trailer(s)`);
  for (const tr of trailers.slice(0, 5)) console.log('  ', JSON.stringify({ name: tr.name, url: tr.url, language: tr.language }));
}
