// batch-pilot.mjs — Pilote de BATCH d'orchestration (Phase 2 : auto-avancement contrôlé).
//
// Rôle : pour chaque batch `active`, lancer AUTOMATIQUEMENT les tâches `ready`
// (dépendances satisfaites + aucun conflit fichiers avec une tâche active),
// jusqu'à `max_parallel` écrivains simultanés. À chaque événement (tâche done,
// batch modifié), un créneau se libère → la tâche suivante démarre seule.
//
// Cadre de sûreté (Phase 2) :
//  - Le worker ne lance QUE les tâches `ready` (batch_readiness) qui sont encore
//    `queued` (jamais lancées). `pilot.launchTask` garde le statut `queued` +
//    la trace `task_sessions` : pas de double lancement.
//  - Les PORTES HUMAINES (validation de plan, merge, déploiement) restent
//    humaines : le worker ne les franchit pas. La continuation post-décision est
//    assurée par `resolveDecision` (injection dans la session orchestrateur).
//  - Rythme bas (polling ~20 s + LISTEN/NOTIFY), jamais de boucle serrée.
//  - Un seul process pm2 (instance fork, max 1).
//
// Usage : node batch-pilot.mjs   (supervisé par pm2, name `batch-pilot`).

import { Pool, Client } from "pg";
import { taskOrchestrator } from "./mcp-client.mjs";
import { loadEnv } from "./env.mjs";
import { launchTask } from "./pilot.mjs";

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const CHANNEL = "registry_changed";
const POLL_MS = Number(process.env.BATCH_PILOT_POLL_MS || 20000);
const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext('batch-pilot')) AS ok`;

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

let running = false;
let lastLog = 0;

function log(msg) {
  console.log(`[batch-pilot] ${new Date().toISOString()} — ${msg}`);
}

// Batches `active` pilotés automatiquement (launch_mode='batch' uniquement).
// Les batches `session` (session orchestrateur unique) et `manual` (pilote humain)
// ne sont PAS gérés par le worker.
async function activeBatches() {
  const { rows } = await pool.query(
    `SELECT b.id FROM batches b
     WHERE b.status = 'active' AND b.launch_mode = 'batch'
     ORDER BY b.created_at ASC`,
  );
  return rows.map((r) => r.id);
}

// Une itération du pilote : pour chaque batch actif, lancer les tâches prêtes.
async function drainOnce() {
  if (running) return;
  running = true;
  try {
    const ids = await activeBatches();
    if (!ids.length) return;
    for (const batchId of ids) {
      try {
        await drainBatch(batchId);
      } catch (e) {
        log(`batch ${batchId} — erreur : ${(e && e.message) || e}`);
      }
    }
  } catch (e) {
    log(`erreur drain : ${(e && e.message) || e}`);
  } finally {
    running = false;
  }
}

async function drainBatch(batchId) {
  const r = await taskOrchestrator("batch_get", { batchId });
  const batch = r && r.batch;
  if (!batch || batch.status !== "active") return;
  const readiness = batch.readiness || [];
  const maxParallel = batch.maxParallel || 2;
  const activeCount = readiness.filter((x) => x.active).length;
  const free = Math.max(0, maxParallel - activeCount);
  if (free <= 0) return;

  // Tâches prêtes ET encore `queued` (jamais lancées). Ordre stable = position.
  const launchable = readiness
    .filter((x) => x.ready && !x.active && !x.done)
    .slice(0, free);

  if (!launchable.length) {
    // Batch terminé ? Toutes les tâches done (ou plus rien de lançable) →
    // vérifier complétion pour clore le batch.
    const allDone = readiness.length > 0 && readiness.every((x) => x.done);
    if (allDone) {
      await taskOrchestrator("batch_set_status", { batchId, status: "completed" });
      log(`batch ${batchId} — toutes les tâches done → completed`);
    }
    return;
  }

  for (const item of launchable) {
    try {
      // Garde anti-doublon + transition atomique queued→started faite par launchTask.
      const res = await launchTask({ taskId: item.taskId, kind: "launch" });
      log(`batch ${batchId} — lancement auto ${item.taskId} → session ${res.sessionId || "?"}`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // Déjà lancée / non queued : normal (concurrence avec le panel ou tick précédent).
      log(`batch ${batchId} — ${item.taskId} non lançable : ${msg.slice(0, 140)}`);
    }
  }
}

async function main() {
  // Élection : verrou advisory PostgreSQL (un seul pilote actif même si 2 instances).
  const { rows } = await pool.query(LOCK_SQL);
  if (!rows[0] || !rows[0].ok) {
    log("un autre pilote détient le verrou — arrêt.");
    process.exit(0);
  }
  log(`batch-pilot démarré (poll ${POLL_MS} ms, un seul process pilote).`);

  await drainOnce();
  setInterval(() => drainOnce(), POLL_MS);

  // Réactivité : LISTEN/NOTIFY du registre (tick immédiat au moindre changement).
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    client.on("notification", () => drainOnce());
    log("listener LISTEN actif.");
  } catch (e) {
    log(`listener indisponible (polling seul) : ${e.message}`);
    try { await client.end(); } catch {}
  }
}

main().catch((e) => {
  console.error("[batch-pilot] erreur fatale :", e);
  process.exit(1);
});
