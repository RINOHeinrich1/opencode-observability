// e2e-run-worker.mjs — Exécuteur E2E ASYNCHRONE (process détaché par le panel).
//
// Le POST /api/e2e-tests/:id/run du panneau HTTP ne doit pas bloquer pendant
// les minutes du run Playwright. Il détache ce worker (spawn + unref) qui fait
// l'appel MCP `e2e_run` (long, jusqu'à 15 min) puis écrit un marqueur de fin.
//
// Usage :
//   node e2e-run-worker.mjs <fichier-payload.json> <fichier-resultat.json>
// Le payload contient les arguments e2e_run ; le worker relaie vers le MCP et
// écrit {ok, result} ou {ok:false, error} dans le fichier résultat.
import { readFileSync, writeFileSync } from "node:fs";
import { taskOrchestrator } from "./mcp-client.mjs";

const [payloadFile, resultFile] = process.argv.slice(2);
if (!payloadFile || !resultFile) {
  writeFileSync(resultFile || "/tmp/e2e-run-worker-result.json", JSON.stringify({ ok: false, error: "payloadFile et resultFile requis" }));
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
  const result = await taskOrchestrator("e2e_run", payload);

  // ── Correctif 2026-09-26 : enregistrer l'exécution dans le registre ──────
  // `e2e_run` exécute le test et renvoie le runId, mais n'écrit PAS de ligne
  // `e2e_executions` : le panneau n'affichait donc jamais le dernier run
  // (il restait bloqué sur la dernière ligne enregistrée). On crée la ligne
  // ici, puis on la complète (verdict, durée, vidéo produite par le run).
  // ⚠️ Best-effort : ne doit JAMAIS faire échouer le run.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const e2eTestId = payload.e2eTestId || (result && result.e2eTestId);
    if (e2eTestId) {
      const rec = await taskOrchestrator("e2e_execution_record", {
        e2eTestId,
        origin: payload.origin || "manual",
        ...(payload.taskId ? { taskId: payload.taskId } : {}),
        ...(payload.baseUrl ? { env: String(payload.baseUrl) } : {}),
      });
      const executionId = rec && rec.execution && rec.execution.id;
      if (executionId) {
        const runId = result && (result.runId || result.run_id);
        const base = process.env.E2E_STORAGE_DIR || "/root/orchestrator-panel/storage/e2e";
        const runDir = runId ? path.join(base, "runs", String(runId)) : null;
        let status = result && (result.status || result.verdict);
        let durationMs = result && (result.durationMs || result.duration);
        let videoUrl = result && (result.videoUrl || result.video);
        if (runDir && fs.existsSync(runDir)) {
          try {
            const vids = fs.readdirSync(runDir).filter((f) => f.endsWith(".webm"));
            if (!videoUrl && vids.length) {
              vids.sort((a, b) => fs.statSync(path.join(runDir, b)).size - fs.statSync(path.join(runDir, a)).size);
              videoUrl = path.join(runDir, vids[0]);
            }
            if (!status) {
              const rep = fs.readdirSync(runDir).filter((f) => f.startsWith("report-") && f.endsWith(".txt"));
              if (rep.length) {
                const m = fs.readFileSync(path.join(runDir, rep[0]), "utf8").match(/\[STATUS\]\s+([A-Z]+)/);
                if (m) status = m[1];
              }
            }
          } catch {}
        }
        if (!durationMs) durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
        await taskOrchestrator("e2e_execution_update", {
          executionId,
          status: status || "PASSED",
          durationMs,
          ...(videoUrl ? { videoUrl: String(videoUrl) } : {}),
          summary: `Run ${runId || ""} (${payload.origin || "manual"}) — enregistré automatiquement par le worker (correctif 2026-09-26).`.trim(),
        });
      }
    }
  } catch (e) {
    try { writeFileSync(resultFile + ".record-error.txt", String((e && e.error) || (e && e.message) || e)); } catch {}
  }
  writeFileSync(resultFile, JSON.stringify({ ok: true, startedAt, finishedAt: new Date().toISOString(), result }, null, 2));
} catch (e) {
  const msg = String((e && e.message) || e);
  writeFileSync(resultFile, JSON.stringify({ ok: false, startedAt, finishedAt: new Date().toISOString(), error: msg }, null, 2));
  process.exit(2);
}
