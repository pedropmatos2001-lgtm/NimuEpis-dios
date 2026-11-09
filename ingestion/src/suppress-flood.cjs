/**
 * Suprimir a enxurrada de avisos de 2026-08-22 01:19.
 *
 * NAO apaga nada: poe `status = 'suppressed'`, que e o unico estado que a caixa
 * de entrada filtra (`web/lib/notifications/inbox.ts` faz `.neq("status",
 * "suppressed")`). O rasto fica na base para quem quiser perceber o que
 * aconteceu.
 *
 * O criterio e estreito de proposito: SO as entregas cujo evento avisa sobre um
 * episodio que ja tinha saido ha mais de seis horas quando o aviso foi criado.
 * Um aviso legitimo de hoje (ha menos de seis horas) fica onde esta.
 *
 * Simula por omissao. `--escrever` para aplicar.
 */

const fs = require("fs");

const ESCREVER = process.argv.includes("--escrever");
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/** O instante que a chave `airing:<id>:AAAAMMDDHHMM` carrega. */
function instanteDaChave(chave) {
  const m = String(chave).match(/:(\d{12})$/);
  if (!m) return null;
  const s = m[1];
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00Z`,
  );
}

async function main() {
  console.log(ESCREVER ? "[limpeza] MODO ESCRITA" : "[limpeza] simulacao (nada e escrito)");

  const eventos = await (
    await fetch(
      `${URL_}/rest/v1/notification_events?select=id,dedupe_key,created_at,payload&created_at=gte.2026-08-22T00:00:00Z&created_at=lt.2026-08-22T09:00:00Z&limit=500`,
      { headers: H },
    )
  ).json();

  const velhos = [];
  for (const e of eventos) {
    const quando = instanteDaChave(e.dedupe_key);
    if (quando === null) continue;
    const horas = (new Date(e.created_at) - quando) / 3600000;
    // Mais de seis horas entre a emissao e o aviso: o aviso nunca devia ter
    // saido, e e o criterio que a migracao 20260822000000 passa a impor.
    if (horas > 6) velhos.push({ ...e, horas: Math.round(horas) });
  }

  console.log(`eventos do periodo: ${eventos.length}, dos quais tardios: ${velhos.length}`);
  if (velhos.length === 0) return;

  const idades = {};
  for (const v of velhos) {
    const d = `${Math.floor(v.horas / 24)}d`;
    idades[d] = (idades[d] ?? 0) + 1;
  }
  console.log("atraso do aviso, em dias:", JSON.stringify(idades));
  console.log(
    "exemplos:",
    velhos
      .slice(0, 4)
      .map((v) => `${String(v.payload?.anime_title ?? "?").slice(0, 26)} ep ${v.payload?.episode_number} (${v.horas}h tarde)`)
      .join(" | "),
  );

  const ids = velhos.map((v) => v.id);
  let porSuprimir = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const lote = ids.slice(i, i + 40);
    const d = await (
      await fetch(
        `${URL_}/rest/v1/notification_deliveries?select=id,channel,status&event_id=in.(${lote.join(",")})&status=eq.pending`,
        { headers: H },
      )
    ).json();
    porSuprimir += d.length;
  }
  console.log(`entregas PENDENTES a suprimir: ${porSuprimir}`);
  console.log("(as que ja foram enviadas por push nao se desfazem, ficam como estao)");

  if (!ESCREVER) {
    console.log("\n[limpeza] nada foi escrito. --escrever para aplicar.");
    return;
  }

  let ok = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const lote = ids.slice(i, i + 40);
    const r = await fetch(
      `${URL_}/rest/v1/notification_deliveries?event_id=in.(${lote.join(",")})&status=eq.pending`,
      {
        method: "PATCH",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify({ status: "suppressed" }),
      },
    );
    if (!r.ok) {
      console.warn(`  aviso: ${r.status} ${(await r.text()).slice(0, 90)}`);
      continue;
    }
    ok += (await r.json()).length;
  }
  console.log(`\n[limpeza] ${ok} entrega(s) suprimida(s).`);
}

main().catch((err) => {
  console.error("[limpeza] falhou:", err.message);
  process.exitCode = 1;
});
