// perf-run-worker.mjs — Exécuteur de TEST DE PERFORMANCE ASYNCHRONE (process
// détaché par le panneau). Miroir de `e2e-run-worker.mjs`.
//
// Le POST /api/evaluations/:id/perf-run du panneau HTTP ne doit pas bloquer
// pendant les minutes du run (navigation + stress). Il détache ce worker
// (spawn + unref) qui fait l'appel MCP `evaluation_perf_run` (long) puis écrit
// un marqueur de fin. Le front suit l'état via
// GET /api/evaluations/:id/perf-jobs/:jobId.
//
// Usage :
//   node perf-run-worker.mjs <fichier-payload.json> <fichier-resultat.json>
// Le payload contient les arguments `evaluation_perf_run` ; le worker relaie
// vers le MCP et écrit {ok, result} ou {ok:false, error} dans le fichier
// résultat.
import { readFileSync, writeFileSync } from "node:fs";
import { taskOrchestrator } from "./mcp-client.mjs";

const [payloadFile, resultFile] = process.argv.slice(2);
if (!payloadFile || !resultFile) {
  writeFileSync(resultFile || "/tmp/perf-run-worker-result.json", JSON.stringify({ ok: false, error: "payloadFile et resultFile requis" }));
  process.exit(1);
}

let payload = {};
try { payload = JSON.parse(readFileSync(payloadFile, "utf8")); }
catch (e) {
  writeFileSync(resultFile, JSON.stringify({ ok: false, error: "payload illisible : " + e.message }));
  process.exit(1);
}

const startedAt = new Date().toISOString();
try {
  const result = await taskOrchestrator("evaluation_perf_run", payload);
  writeFileSync(resultFile, JSON.stringify({ ok: true, startedAt, finishedAt: new Date().toISOString(), result }, null, 2));
} catch (e) {
  const msg = String((e && e.message) || e);
  writeFileSync(resultFile, JSON.stringify({ ok: false, startedAt, finishedAt: new Date().toISOString(), error: msg }, null, 2));
  process.exit(2);
}
