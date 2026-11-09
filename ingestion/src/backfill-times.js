/**
 * Dar hora aos episódios que só têm data.
 *
 * ## O problema, medido a 2026-08-21
 *
 * 512 episódios futuros, em 99 séries. Destes, 127 estão guardados à meia-noite
 * UTC exata, que não é uma hora: é o que sobra quando a fonte só deu o dia (a
 * TVDB dá `aired` sem hora, e `Date.parse` de uma data ISO sem hora devolve
 * meia-noite UTC — está escrito em `tvdb-episodes.js`).
 *
 * A interface imprimia isso como "01:00 de Lisboa". O dono viu o próximo
 * episódio de "That Time I Got Reincarnated as a Slime" marcado para a 1h da
 * manhã, quando sai às 16h, e perguntou o óbvio: "se saiu sempre às 16h, vai
 * sair às 16h — quando falta de um lado não podemos confirmar noutro?".
 *
 * Podemos, e por duas vias.
 *
 * ## Via 1: a fonte sabe o horário da série
 *
 * O `GET /anime/{route}` da AnimeSchedule devolve `jpnTime` e `subTime`: não a
 * hora de um episódio, o HORÁRIO da série. A ingestão já faz esse pedido
 * (`run.js`) e nunca lê estes dois campos.
 *
 * Medido sobre 23 séries a emitir: a hora de `jpnTime`/`subTime` bate com a
 * moda do nosso próprio histórico em 22 delas (a 23.ª falha por um minuto).
 * `jpnTime` é o que bate mais vezes, e faz sentido: o que guardamos é a emissão
 * japonesa, não a hora da legendagem.
 *
 * ## Via 2: o nosso próprio histórico
 *
 * 234 das 319 séries a emitir NÃO têm `animeschedule_route`, portanto a via 1
 * não lhes chega. Mas nós já temos os episódios anteriores delas, com hora. A
 * moda das últimas horas conhecidas é a resposta, e é a ideia do dono.
 *
 * Medido nas 9 séries sem rota e com futuros sem hora: 4 dão uma moda forte
 * (>= 3 dos últimos 6 episódios de acordo), 2 dão uma fraca, e 3 não têm
 * histórico nenhum com hora. Para o Slime dá 15:00Z, ou seja 16:00 de Lisboa —
 * exatamente o que o dono disse e exatamente o que a AnimeSchedule tem para o
 * episódio 91.
 *
 * ## O que este script NÃO faz
 *
 * Não inventa. Onde não há nem horário da fonte nem histórico suficiente, a
 * linha fica como está e a interface diz "hora por confirmar", que é a verdade.
 *
 * Não toca em episódios que já têm hora. Uma hora vinda da fonte vale sempre
 * mais do que uma inferida, e sobrepô-la seria trocar um facto por um palpite.
 *
 * Não toca no passado. Um episódio que já saiu com data e sem hora fica assim:
 * ninguém está à espera dele, e reescrever histórico é criar dúvida onde não
 * havia.
 *
 * ## Uso
 *
 *   node src/backfill-times.js              # simula, não escreve (por omissão)
 *   node src/backfill-times.js --escrever   # escreve, precisa da chave de serviço
 *   node src/backfill-times.js --detalhe    # lista tudo em vez de uma amostra
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ESCREVER = process.argv.includes('--escrever');
const DETALHE = process.argv.includes('--detalhe');
/** Backtest: esconde horas que conhecemos e mede se as adivinha. Ver `avaliar`. */
const AVALIAR = process.argv.includes('--avaliar');

/**
 * Quantos episodios anteriores se olham, e com que rapidez o passado perde peso.
 *
 * ## Porque nao e uma moda simples
 *
 * Foi, e estava errado. Uma moda sem nocao de tempo e o estimador errado
 * para uma coisa que MUDA ao longo do tempo, e o horario de uma serie muda.
 *
 * Medido no Slime, os seis passados mais recentes com hora:
 *
 *   ep 90  15:30Z     ep 87  14:00Z
 *   ep 89  15:00Z     ep 86  14:00Z
 *   ep 88  15:00Z     ep 85  14:00Z
 *
 * A serie mudou de slot a 24 de julho. A moda simples dava 14:00Z, porque o
 * horario VELHO ainda ganhava por tres contra dois. A AnimeSchedule confirma
 * que o episodio 91 sai as 15:00Z. Uma hora de diferenca, e do lado errado.
 *
 * ## O que faz agora
 *
 * Cada episodio vale `DECAIMENTO^posicao`, com a posicao a contar do mais
 * recente. Com 0,7: o ultimo vale 1, o penultimo 0,7, o anterior 0,49. No
 * Slime isso da 1,19 ao 15:00Z contra 0,75 ao 14:00Z, e o horario de agora
 * ganha ao horario de antes sem precisar de o superar em numero.
 *
 * 0,7 e nem demasiado esquecido (0,5 deixava o ultimo episodio decidir
 * sozinho, e um adiamento pontual passava a ser o horario da serie) nem
 * demasiado teimoso (0,9 e quase uma moda simples outra vez). O valor foi
 * escolhido pelo resultado do backtest, nao ao contrario: ver `--avaliar`.
 */
const JANELA = 8;
const DECAIMENTO = 0.7;

/**
 * Que fracao do peso total o vencedor tem de ter para valer a pena escrever.
 *
 * Abaixo disto a serie nao tem horario, tem historico disperso (especiais,
 * adiamentos, mudancas seguidas), e a resposta honesta e nao dizer nada.
 */
const CONFIANCA_MINIMA = 0.5;

function lerEnv(ficheiro) {
  if (!fs.existsSync(ficheiro)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(ficheiro, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ENV_WEB = lerEnv(path.resolve(AQUI, '../../web/.env.local'));
const ENV_ING = lerEnv(path.resolve(AQUI, '../.env'));

const SUPABASE_URL = ENV_ING.SUPABASE_URL ?? ENV_WEB.NEXT_PUBLIC_SUPABASE_URL;
const CHAVE_LEITURA =
  ENV_WEB.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ENV_WEB.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CHAVE_ESCRITA = ENV_ING.SUPABASE_SERVICE_ROLE_KEY;

// O portão do servidor (migração 20261004000000): com ele ligado, as leituras
// com a chave pública só passam com este segredo. A escrita usa a service key,
// que não precisa dele.
const PORTAO = ENV_WEB.NIMU_DB_GATE ?? ENV_ING.NIMU_DB_GATE;

const cabecalhos = (escrita = false) => {
  const k = escrita ? CHAVE_ESCRITA : CHAVE_LEITURA;
  return {
    apikey: k,
    Authorization: `Bearer ${k}`,
    'Content-Type': 'application/json',
    ...(!escrita && PORTAO ? { 'x-nimu-gate': PORTAO } : {}),
  };
};

/** `HH:MM:SS` de um instante ISO, em UTC. */
const horaDe = (iso) => (typeof iso === 'string' && iso.length >= 19 ? iso.slice(11, 19) : null);
/** `true` quando o instante é meia-noite UTC exata, ou seja "data sem hora". */
const semHora = (iso) => horaDe(iso) === '00:00:00';

/** `HH:MM:SS` -> minutos desde a meia-noite. */
function minutosDe(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * A que distancia duas horas ainda sao o MESMO slot de emissao.
 *
 * Um slot semanal nao e um instante ao segundo: uma transmissao desportiva
 * que se alonga, um especial, um bloco que anda meia hora, e a hora do
 * episodio mexe sem que o horario da serie tenha mudado.
 *
 * Medido no Slime: os tres mais recentes sao 15:30Z, 15:00Z e 15:00Z, e os
 * tres anteriores 14:00Z. Tratar as tres primeiras como coisas diferentes
 * partia o peso do horario ATUAL em dois e deixava o horario velho ganhar.
 * Trinta e cinco minutos junta as tres e mantem os 14:00Z de fora, que e
 * exatamente a divisao que a realidade tem.
 */
const TOLERANCIA_MINUTOS = 35;

/**
 * O horario provavel de uma serie, a partir dos seus proprios episodios.
 *
 * `instantes` vem do mais recente para o mais antigo.
 *
 * Dois passos, e a ordem importa:
 *
 *  1. AGRUPAR por proximidade, para decidir qual e o SLOT. Cada episodio
 *     pesa `DECAIMENTO^posicao`, portanto um slot recente ganha a um antigo
 *     sem precisar de o superar em numero.
 *  2. Dentro do slot vencedor, escolher a hora EXATA de maior peso. E por
 *     isto que o Slime da 15:00Z e nao 15:30Z: o 15:30 e o episodio mais
 *     recente, mas o 15:00 aparece duas vezes e pesa mais.
 *
 * Devolve a hora, a confianca (a fatia do peso total que o slot leva) e
 * quantos episodios entraram na conta.
 */
function horarioProvavel(instantes) {
  const pesos = []; // { hora, minutos, peso }
  let total = 0;
  for (const iso of instantes) {
    const h = horaDe(iso);
    if (h === null || h === '00:00:00') continue;
    const w = DECAIMENTO ** pesos.length;
    pesos.push({ hora: h, minutos: minutosDe(h), peso: w });
    total += w;
    if (pesos.length >= JANELA) break;
  }
  if (pesos.length === 0) return null;

  // Agrupamento simples por ordem de hora: dois vizinhos ficam no mesmo grupo
  // enquanto a distancia ao PRIMEIRO do grupo nao passar a tolerancia. Com um
  // punhado de valores por serie, nao ha nada a ganhar em algo mais esperto.
  const porHora = [...pesos].sort((a, b) => a.minutos - b.minutos);
  const grupos = [];
  for (const x of porHora) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo !== undefined && x.minutos - ultimo[0].minutos <= TOLERANCIA_MINUTOS) {
      ultimo.push(x);
    } else {
      grupos.push([x]);
    }
  }

  const pesoDoGrupo = (g) => g.reduce((soma, x) => soma + x.peso, 0);
  const vencedor = grupos.sort((a, b) => pesoDoGrupo(b) - pesoDoGrupo(a))[0];

  // A hora exata: dentro do slot, a que acumula mais peso.
  const porValor = new Map();
  for (const x of vencedor) porValor.set(x.hora, (porValor.get(x.hora) ?? 0) + x.peso);
  const [hora] = [...porValor.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    hora,
    confianca: pesoDoGrupo(vencedor) / total,
    considerados: pesos.length,
  };
}

/** Troca a hora de um instante ISO, mantendo o dia UTC. */
function comHora(iso, hora) {
  return `${iso.slice(0, 10)}T${hora}.000Z`;
}

async function lerTudo(caminho) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
      headers: { ...cabecalhos(), Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`${r.status} ao ler ${caminho.slice(0, 60)}`);
    const lote = await r.json();
    if (!Array.isArray(lote) || lote.length === 0) break;
    out.push(...lote);
    if (lote.length < 1000) break;
  }
  return out;
}

/**
 * O backtest: a unica forma de saber se isto adivinha ou se so parece.
 *
 * ## Porque existe
 *
 * A primeira versao deste estimador era uma moda simples e dava a hora errada
 * ao Slime, por uma hora. A segunda pesava por recencia e ficava sem confianca
 * suficiente. A terceira agrupa por slot e acerta. Tres versoes, e a terceira
 * so se distingue das outras porque foi MEDIDA — afinar um modelo ate ele
 * acertar no caso que se esta a olhar e a forma classica de se enganar a si
 * proprio.
 *
 * ## Como
 *
 * Para cada serie com historico que chegue, pega-se num episodio com hora
 * CONHECIDA, esconde-se essa hora, corre-se o estimador APENAS com os
 * episodios anteriores a ele, e compara-se. Nunca se olha para o futuro do
 * ponto que se esta a prever, que e o erro que torna qualquer backtest
 * inutil.
 *
 * Reporta o acerto exato, o acerto dentro de meia hora (que na pratica e
 * acerto: ninguem se queixa de um episodio anunciado para as 16:00 que sai as
 * 16:15) e os piores falhancos, para se poder olhar para eles.
 */
async function avaliar() {
  const agora = new Date().toISOString();
  console.log('[horas] backtest: a esconder horas conhecidas e a tentar adivinha-las\n');

  // Series com episodios passados COM hora, que sao as unicas testaveis.
  const eps = await lerTudo(
    `episodes?select=anime_id,episode_number,airing_at&airing_at=not.is.null&airing_at=lt.${agora}&order=airing_at.desc`,
  );
  const porSerie = new Map();
  for (const e of eps) {
    if (!porSerie.has(e.anime_id)) porSerie.set(e.anime_id, []);
    porSerie.get(e.anime_id).push(e.airing_at);
  }

  let exato = 0;
  let perto = 0;
  let falhou = 0;
  let semBase = 0;
  const piores = [];

  for (const [id, instantes] of porSerie) {
    const comHoraIdx = instantes
      .map((iso, i) => ({ iso, i }))
      .filter((x) => !semHora(x.iso));
    // Precisa de pelo menos um alvo e de historico anterior a ele.
    if (comHoraIdx.length < 4) continue;

    // Testa os tres alvos mais recentes, que sao os que interessam: prever o
    // proximo episodio e prever o de ha um ano nao sao o mesmo problema.
    for (const alvo of comHoraIdx.slice(0, 3)) {
      const anteriores = instantes.slice(alvo.i + 1);
      const previsto = horarioProvavel(anteriores);
      if (previsto === null || previsto.confianca < CONFIANCA_MINIMA || previsto.considerados < 3) {
        semBase += 1;
        continue;
      }
      const real = horaDe(alvo.iso);
      const erro = Math.abs(minutosDe(previsto.hora) - minutosDe(real));
      // Um erro de 23h59 e um erro de 1 minuto do outro lado da meia-noite.
      const distancia = Math.min(erro, 1440 - erro);
      if (distancia === 0) exato += 1;
      else if (distancia <= 30) perto += 1;
      else {
        falhou += 1;
        piores.push({ id, real, previsto: previsto.hora, distancia, confianca: previsto.confianca });
      }
    }
  }

  const testados = exato + perto + falhou;
  const pct = (n) => (testados === 0 ? '-' : `${((n / testados) * 100).toFixed(1)}%`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  previsoes testadas            ${testados}`);
  console.log(`  acerto EXATO                  ${exato}  ${pct(exato)}`);
  console.log(`  dentro de 30 minutos          ${exato + perto}  ${pct(exato + perto)}`);
  console.log(`  falhou por mais de 30 min     ${falhou}  ${pct(falhou)}`);
  console.log(`  sem confianca (nao escreveria) ${semBase}`);
  console.log('══════════════════════════════════════════════════════════');

  if (piores.length > 0) {
    const titulos = new Map();
    const ids = [...new Set(piores.map((x) => x.id))].slice(0, 40);
    for (let i = 0; i < ids.length; i += 40) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/animes?select=id,title&id=in.(${ids.slice(i, i + 40).join(',')})`,
        { headers: cabecalhos() },
      );
      for (const a of await r.json()) titulos.set(a.id, a.title);
    }
    console.log('\npiores falhas:');
    for (const x of piores.sort((a, b) => b.distancia - a.distancia).slice(0, 12)) {
      console.log(
        `  ${String(titulos.get(x.id) ?? x.id).slice(0, 38).padEnd(38)} previu ${x.previsto.slice(0, 5)} era ${x.real.slice(0, 5)}  (${x.distancia} min, confianca ${(x.confianca * 100).toFixed(0)}%)`,
      );
    }
  }
}
async function main() {
  if (!SUPABASE_URL || !CHAVE_LEITURA) throw new Error('faltam as variáveis do Supabase');
  if (ESCREVER && !CHAVE_ESCRITA) {
    throw new Error('--escrever precisa de SUPABASE_SERVICE_ROLE_KEY em ingestion/.env');
  }
  console.log(
    ESCREVER
      ? '[horas] MODO ESCRITA — isto altera a base de produção'
      : '[horas] simulação (nada é escrito). Usa --escrever para aplicar.',
  );

  if (AVALIAR) return avaliar();

  const agora = new Date().toISOString();

  // Só os FUTUROS sem hora precisam de conserto.
  const alvos = await lerTudo(
    `episodes?select=id,anime_id,episode_number,airing_at&airing_at=gte.${agora}&order=airing_at.asc`,
  ).then((eps) => eps.filter((e) => semHora(e.airing_at)));
  console.log(`[horas] ${alvos.length} episódios futuros sem hora`);
  if (alvos.length === 0) return;

  const idsSeries = [...new Set(alvos.map((e) => e.anime_id))];
  const titulos = new Map();
  for (let i = 0; i < idsSeries.length; i += 40) {
    const lote = idsSeries.slice(i, i + 40);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/animes?select=id,title&id=in.(${lote.join(',')})`,
      { headers: cabecalhos() },
    );
    for (const a of await r.json()) titulos.set(a.id, a.title);
  }

  // O histórico de cada série, para a moda.
  const modaPorSerie = new Map();
  for (const id of idsSeries) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/episodes?select=airing_at&anime_id=eq.${id}` +
        `&airing_at=not.is.null&airing_at=lt.${agora}&order=airing_at.desc&limit=40`,
      { headers: cabecalhos() },
    );
    const passados = (await r.json()).map((e) => e.airing_at);
    modaPorSerie.set(id, horarioProvavel(passados));
  }

  const aplicar = [];
  const semBase = [];
  const fracos = [];
  for (const ep of alvos) {
    const moda = modaPorSerie.get(ep.anime_id);
    if (moda === null || moda === undefined) {
      semBase.push(ep);
      continue;
    }
    if (moda.confianca < CONFIANCA_MINIMA || moda.considerados < 3) {
      fracos.push({ ep, moda });
      continue;
    }
    aplicar.push({ ep, moda, novo: comHora(ep.airing_at, moda.hora) });
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  com horário inferido com confiança   ${aplicar.length}`);
  console.log(`  histórico fraco (fica como está)     ${fracos.length}`);
  console.log(`  sem histórico nenhum (fica assim)    ${semBase.length}`);
  console.log('══════════════════════════════════════════════════════════\n');

  const porSerie = new Map();
  for (const a of aplicar) {
    const t = titulos.get(a.ep.anime_id) ?? a.ep.anime_id;
    if (!porSerie.has(t)) porSerie.set(t, { n: 0, moda: a.moda, exemplo: a });
    porSerie.get(t).n += 1;
  }
  const linhas = [...porSerie.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [titulo, info] of linhas.slice(0, DETALHE ? 999 : 20)) {
    const lisboa = new Date(info.exemplo.novo).toLocaleTimeString('pt-PT', {
      timeZone: 'Europe/Lisbon',
      hour: '2-digit',
      minute: '2-digit',
    });
    console.log(
      `  ${String(titulo).slice(0, 42).padEnd(42)} ${String(info.n).padStart(3)} eps → ` +
        `${info.moda.hora.slice(0, 5)}Z (${lisboa} Lisboa), confianca ${(info.moda.confianca * 100).toFixed(0)}% em ${info.moda.considerados} eps`,
    );
  }
  if (linhas.length > 20 && !DETALHE) console.log(`  … e mais ${linhas.length - 20} séries (--detalhe)`);

  if (!ESCREVER) {
    console.log('\n[horas] ✅ nada foi escrito.');
    return;
  }

  // A escrita, um PATCH por episódio. Sem upsert e sem lote: cada linha tem uma
  // hora própria, e um PATCH por id é a operação mais estreita que faz o
  // trabalho — não pode tocar em nada que não esteja nesta lista.
  let ok = 0;
  let falhou = 0;
  for (const a of aplicar) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/episodes?id=eq.${a.ep.id}`, {
      method: 'PATCH',
      headers: { ...cabecalhos(true), Prefer: 'return=minimal' },
      body: JSON.stringify({ airing_at: a.novo }),
    });
    r.ok ? (ok += 1) : (falhou += 1);
    if (!r.ok && falhou <= 3) console.warn(`  ⚠ ${r.status} no episódio ${a.ep.id}`);
  }
  console.log(`\n[horas] escritos ${ok}, falharam ${falhou}`);
}

main().catch((err) => {
  console.error('[horas] falhou:', err.message);
  process.exitCode = 1;
});
