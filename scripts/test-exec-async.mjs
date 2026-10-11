#!/usr/bin/env node
// scripts/test-exec-async.mjs — Test unitaire DÉTERMINISTE de exec-async.mjs.
//
// Aucune dépendance externe (pas de DB, pas de réseau) : n'utilise que le
// process Node courant. Vérifie :
//   1. succès (code 0) → pas de rejet, stdout capturé ;
//   2. code ≠ 0 → RÉSOLUTION (jamais de rejet) avec le bon code ;
//   3. timeout borné → SIGTERM/SIGKILL, `timedOut:true`, résolution rapide ;
//   4. redaction des secrets (PAT dans une URL de clone git) ;
//   5. runJson : succès (parse) + échec (code ≠ 0 rejeté, message redacté).
//
// Sortie : exit 0 si tous les cas passent, exit 1 sinon. Aucune fuite : le PAT
// factice utilisé n'est jamais réel.

import { runExternal, runJson, redactSecrets } from "../exec-async.mjs";

const NODE = process.execPath;
let failures = 0;
function ok(cond, label) {
  if (cond) { console.log(`  ✔ ${label}`); }
  else { failures++; console.error(`  ✘ ${label}`); }
}

// PAT factice (jamais un vrai token : chaîne reconnaissable, format ghp_ + 36 car.).
const FAKE_PAT = "ghp_" + "A".repeat(36);
const FAKE_CLONE_URL = `https://x-access-token:${FAKE_PAT}@github.com/org/repo.git`;

async function main() {
  console.log("test-exec-async — exec-async.mjs");

  // 1. Succès (code 0).
  {
    const r = await runExternal(NODE, ["-e", "process.stdout.write('hello')"]);
    ok(r.code === 0, "code 0 sur succès");
    ok(r.stdout === "hello", "stdout capturé");
    ok(r.timedOut === false, "timedOut=false sur succès");
  }

  // 2. code ≠ 0 → résolution, pas de rejet.
  {
    let threw = false;
    let r;
    try {
      r = await runExternal(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
    } catch { threw = true; }
    ok(!threw, "aucun rejet sur code ≠ 0");
    ok(r && r.code === 3, "code 3 remonté");
    ok(r && /boom/.test(r.stderr), "stderr capturé");
  }

  // 3. Timeout borné : process long (60 s) tué par le timeout (300 ms) + grâce.
  {
    const t0 = Date.now();
    const r = await runExternal(NODE, ["-e", "setTimeout(()=>{},60000)"], { timeout: 300 });
    const elapsed = Date.now() - t0;
    ok(r.timedOut === true, "timedOut=true au dépassement");
    ok(elapsed < 10000, `résolution rapide malgré le process long (${elapsed} ms)`);
    ok(r.signal === "SIGTERM" || r.signal === "SIGKILL", `process tué par signal (${r.signal})`);
  }

  // 4. Redaction des secrets (PAT dans une URL de clone git, stdout + stderr).
  {
    const script = "process.stdout.write(process.env.U); process.stderr.write(process.env.U)";
    const r = await runExternal(NODE, ["-e", script], { env: { ...process.env, U: FAKE_CLONE_URL } });
    ok(!r.stdout.includes(FAKE_PAT), "PAT absent de stdout (redacté)");
    ok(!r.stderr.includes(FAKE_PAT), "PAT absent de stderr (redacté)");
    ok(r.stdout.includes("***:***@"), "userinfo de l'URL masqué dans stdout");
    ok(!redactSecrets(`CODER_SESSION_TOKEN=${FAKE_PAT}`).includes(FAKE_PAT), "CODER_SESSION_TOKEN masqué");
    ok(!redactSecrets(`Authorization: Bearer ${FAKE_PAT}`).includes(FAKE_PAT), "Authorization: Bearer masqué");
    ok(!redactSecrets(`--token ${FAKE_PAT}`).includes(FAKE_PAT), "--token masqué");
    ok(redactSecrets(null) === null && redactSecrets(undefined) === undefined, "redactSecrets tolère null/undefined");
  }

  // 5. runJson : succès + échec.
  {
    const out = await runJson(NODE, ["-e", "process.stdout.write(JSON.stringify({ok:true,n:1}))"]);
    ok(out && out.ok === true && out.n === 1, "runJson parse la sortie JSON");
    let threw = false;
    try {
      await runJson(NODE, ["-e", "process.stderr.write('nope'); process.exit(2)"]);
    } catch (e) {
      threw = true;
      ok(e.code === 2, "runJson rejette avec le code");
      ok(/nope/.test(e.message), "runJson remonte le message d'erreur");
    }
    ok(threw, "runJson rejette si code ≠ 0");
  }

  if (failures) {
    console.error(`\nÉCHEC : ${failures} assertion(s) en erreur.`);
    process.exit(1);
  }
  console.log("\nOK — tous les cas passent.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ÉCHEC inattendu :", (e && e.stack) || e);
  process.exit(1);
});
