/**
 * O que a ingestão IRIA escrever, sem escrever nada.
 *
 * ## Porque este ficheiro existe
 *
 * O `--dry-run` do `run.js` corre sobre FIXTURES: zero rede, zero Supabase. É a
 * porta de segurança do CI (um mapper partido nunca chega à base) e para isso é
 * exatamente o que deve ser. Mas não responde à pergunta que se põe quando a
 * ingestão esteve parada: "o que é que está desatualizado agora, e o que é que
 * uma volta corrige?".
 *
 * Isto responde. Vai à rede a sério, constrói as MESMAS linhas que o `run.js`
 * construiria (pelas mesmas funções, não por uma cópia), e depois LÊ a base para
 * comparar. Não escreve. Não importa sequer o cliente com a chave de serviço:
 * lê com a chave publicável, que é a mesma que o site usa e que só vê o que é
 * público.
 *
 * ## Porque não é um teste
 *
 * Porque o resultado depende do dia. Serve para diagnosticar, não para afirmar
 * uma invariante — a lógica pura já tem testes em `test/`.
 *
 * Uso:
 *   node src/simulate.js              # resumo
 *   node src/simulate.js --detalhe    # lista cada episódio que muda de hora
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRows } from './pipeline.js';
import { fetchTimetableWeek, fetchAnimeDetail } from './animeschedule.js';
import { fetchTimetableWindow } from './timetable-window.js';
import { config } from './config.js';

const DETALHE = process.argv.includes('--detalhe');

/** A chave publicável do site: lê o catálogo, que é público. Nunca escreve. */
function leituraSupabase() {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/.env.local');
  const env = Object.fromEntries(
    fs
      .readFileSync(raiz, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('faltam NEXT_PUBLIC_SUPABASE_URL/KEY em web/.env.local');
  // O portão do servidor (migração 20261004000000): com ele ligado, o catálogo
  // só responde a quem manda este segredo.
  const gate = env.NIMU_DB_GATE;
  return {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(gate ? { 'x-nimu-gate': gate } : {}) },
  };
}

async function main() {
  console.log('[sim] a ler a AnimeSchedule (só leitura, nada é escrito)…');

  // AS MESMAS semanas do run.js, lidas da mesma maneira ("sub" + "raw", e a
  // semana extra que só acrescenta). Ver timetable-window.js.
  const { timetableEntries } = await fetchTimetableWindow({
    fetchWeek: fetchTimetableWeek,
    airType: config.airType,
  });

  const rotas = [...new Set(timetableEntries.map((e) => e?.route).filter(Boolean))];
  const detailsByRoute = new Map();
  for (const route of rotas) {
    try {
      detailsByRoute.set(route, await fetchAnimeDetail(route));
    } catch {
      /* um detalhe falhado não é fatal, tal como no run.js */
    }
  }
  console.log(`[sim] detalhes: ${detailsByRoute.size} de ${rotas.length} rotas`);

  // AS MESMAS funções do run.js, não uma cópia delas.
  const { episodeProtos } = buildRows({ timetableEntries, detailsByRoute });
  console.log(`[sim] a ingestão construiria ${episodeProtos.length} linhas de episódio`);

  // ── O que a base tem hoje, para as mesmas rotas ───────────────────────────
  const { url, headers } = leituraSupabase();
  const porRota = new Map();
  for (let i = 0; i < rotas.length; i += 40) {
    const lote = rotas.slice(i, i + 40);
    const filtro = lote.map((r) => `"${r}"`).join(',');
    const r = await fetch(
      `${url}/rest/v1/animes?select=id,title,animeschedule_route&animeschedule_route=in.(${encodeURIComponent(filtro)})`,
      { headers },
    );
    for (const a of await r.json()) porRota.set(a.animeschedule_route, a);
  }
  console.log(`[sim] ${porRota.size} de ${rotas.length} rotas existem na base`);

  const ids = [...porRota.values()].map((a) => a.id);
  const atuais = new Map(); // `${anime_id}#${episode_number}` → airing_at
  for (let i = 0; i < ids.length; i += 30) {
    const lote = ids.slice(i, i + 30);
    const r = await fetch(
      `${url}/rest/v1/episodes?select=anime_id,episode_number,airing_at&anime_id=in.(${lote.join(',')})`,
      { headers },
    );
    for (const e of await r.json()) atuais.set(`${e.anime_id}#${e.episode_number}`, e.airing_at);
  }
  console.log(`[sim] ${atuais.size} episódios lidos da base para comparação`);

  // ── A comparação ─────────────────────────────────────────────────────────
  const meiaNoite = (iso) => typeof iso === 'string' && iso.slice(11, 19) === '00:00:00';
  let iguais = 0;
  let novos = 0;
  const corrigidos = [];
  const mudados = [];

  for (const proto of episodeProtos) {
    const anime = porRota.get(proto.route);
    if (!anime) continue;
    const chave = `${anime.id}#${proto.episode_number}`;
    const atual = atuais.get(chave);
    if (atual === undefined) {
      novos += 1;
      continue;
    }
    const antes = new Date(atual).toISOString();
    const depois = new Date(proto.airing_at).toISOString();
    if (antes === depois) {
      iguais += 1;
      continue;
    }
    const linha = {
      titulo: anime.title,
      episodio: proto.episode_number,
      antes,
      depois,
      antesLisboa: new Date(antes).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' }),
      depoisLisboa: new Date(depois).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' }),
    };
    // A distinção que interessa: passar de "sem hora" para "com hora" é uma
    // CORREÇÃO; qualquer outra mudança é uma alteração de calendário.
    if (meiaNoite(antes) && !meiaNoite(depois)) corrigidos.push(linha);
    else mudados.push(linha);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  iguais (nada a fazer)          ${iguais}`);
  console.log(`  episódios novos                ${novos}`);
  console.log(`  HORA CORRIGIDA (sem → com)     ${corrigidos.length}`);
  console.log(`  outras mudanças de data/hora   ${mudados.length}`);
  console.log('══════════════════════════════════════════════════════════');

  const mostrar = DETALHE ? 1000 : 12;
  if (corrigidos.length > 0) {
    console.log('\nepisódios que passam a ter hora:');
    for (const c of corrigidos.slice(0, mostrar)) {
      console.log(`  ${c.titulo.slice(0, 42).padEnd(42)} ep ${String(c.episodio).padStart(4)}  ${c.antesLisboa}  →  ${c.depoisLisboa}`);
    }
    if (corrigidos.length > mostrar) console.log(`  … e mais ${corrigidos.length - mostrar} (usa --detalhe)`);
  }
  if (mudados.length > 0) {
    console.log('\noutras mudanças:');
    for (const c of mudados.slice(0, mostrar)) {
      console.log(`  ${c.titulo.slice(0, 42).padEnd(42)} ep ${String(c.episodio).padStart(4)}  ${c.antesLisboa}  →  ${c.depoisLisboa}`);
    }
    if (mudados.length > mostrar) console.log(`  … e mais ${mudados.length - mostrar} (usa --detalhe)`);
  }

  console.log('\n[sim] ✅ nada foi escrito.');
}

main().catch((err) => {
  console.error('[sim] falhou:', err.message);
  process.exitCode = 1;
});
