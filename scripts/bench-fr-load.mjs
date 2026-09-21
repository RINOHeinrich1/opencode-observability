#!/usr/bin/env node
// scripts/bench-fr-load.mjs — Banc de mesure reproductible « avant / après » du
// chargement de l'onglet Fonctionnalités / Règles métier du panneau.
//
// Mesure, pour un projet (défaut `myxmax`) :
//   1. un appel MCP simple (`org_list`) ×3 — froid puis chaud ;
//   2. les DEUX listes MCP de l'onglet (`feature_list`, `rule_list`) ;
//   3. l'ANCIEN chemin de l'index des liens (N+1) : un `feature_get`/`rule_get`
//      par entité (55 appels pour 45 fonctionnalités + 10 règles), concurrence 4 ;
//   4. le NOUVEAU chemin : index dérivé du payload des listes (`links`) —
//      0 appel réseau.
//
// Usage :
//   node scripts/bench-fr-load.mjs [projectId] [--json]
//
// Le process MCP ciblé est celui résolu par `mcp-client.mjs` (surchargeable par
// `MCP_TASK_ORCHESTRATOR_PATH`). Le banc ne fait QUE des lectures.

import { performance } from "node:perf_hooks";
import { taskOrchestrator, closeAllMcpClients } from "../mcp-client.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const projectId = args.find((a) => !a.startsWith("--")) || "myxmax";

const ms = (n) => Math.round(n * 1000) / 1000;
const results = [];
function record(phase, label, durationMs, detail = "") {
  results.push({ phase, label, ms: ms(durationMs), detail });
  if (!asJson) {
    console.log(`  ${label.padEnd(52)} ${String(ms(durationMs)).padStart(10)} ms  ${detail}`);
  }
}

// Réutilise le même client MCP que le panneau (persistant après le correctif).
async function timeIt(phase, label, fn, detail = "") {
  const t0 = performance.now();
  const out = await fn();
  record(phase, label, performance.now() - t0, typeof detail === "function" ? detail() : detail);
  return out;
}

// Pool de concurrence bornée (reproduit la concurrence 4 de l'ancien index).
async function runPool(jobs, concurrency, worker) {
  const queue = jobs.slice();
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (job) await worker(job);
    }
  });
  await Promise.all(runners);
}

// Index des liens dérivé du payload (nouveau chemin) — pur, sans réseau.
function buildFeatureRuleLinkIndex(features, rules) {
  const index = { features: {}, rules: {} };
  (features || []).forEach((f) => { if (f && f.id && f.links) index.features[f.id] = f.links; });
  (rules || []).forEach((r) => { if (r && r.id && r.links) index.rules[r.id] = r.links; });
  return index;
}

async function main() {
  if (!asJson) {
    console.log(`\n=== bench-fr-load — projet « ${projectId} » — ${new Date().toISOString()} ===`);
    console.log(`MCP : ${process.env.MCP_TASK_ORCHESTRATOR_PATH || "(défaut mcp-client.mjs)"}\n`);
  }

  // --- Phase 1 : appel MCP simple (froid puis chaud) -----------------------
  if (!asJson) console.log("[1] Appel MCP simple (org_list) ×3");
  for (let i = 1; i <= 3; i++) {
    await timeIt("simple", `org_list #${i}`, () => taskOrchestrator("org_list", {}));
  }

  // --- Phase 2 : listes MCP de l'onglet ------------------------------------
  if (!asJson) console.log("\n[2] Listes MCP de l'onglet");
  const featRes = await timeIt("lists", "feature_list", () => taskOrchestrator("feature_list", { projectId }));
  const ruleRes = await timeIt("lists", "rule_list", () => taskOrchestrator("rule_list", { projectId }));
  const features = (featRes && featRes.features) || [];
  const rules = (ruleRes && ruleRes.rules) || [];
  const withLinks = features.filter((f) => f && f.links).length + rules.filter((r) => r && r.links).length;
  if (!asJson) console.log(`    → ${features.length} fonctionnalité(s), ${rules.length} règle(s), ${withLinks} entité(s) portant « links »`);

  // --- Phase 3 : ANCIEN chemin (N+1) ---------------------------------------
  if (!asJson) console.log("\n[3] ANCIEN chemin — index des liens par entité (N+1, concurrence 4)");
  const jobs = [
    ...features.filter((f) => f && f.id).map((f) => ({ kind: "feature", id: f.id })),
    ...rules.filter((r) => r && r.id).map((r) => ({ kind: "rule", id: r.id })),
  ];
  const oldIndex = { features: {}, rules: {} };
  let oldErrors = 0;
  await timeIt("old-index", `index N+1 — ${jobs.length} appels (concurrence 4)`, async () => {
    await runPool(jobs, 4, async (job) => {
      try {
        const d = job.kind === "feature"
          ? await taskOrchestrator("feature_get", { featureId: job.id })
          : await taskOrchestrator("rule_get", { ruleId: job.id });
        const o = (job.kind === "feature" ? d.feature : d.rule) || {};
        if (job.kind === "feature") {
          oldIndex.features[job.id] = {
            rules: (o.regles || []).length,
            gherkin: (o.gherkin || []).length,
            adrs: (o.adrs || []).length,
            sprints: (o.sprints || []).length,
            tasks: (o.tasks || []).length,
            recettes: (o.recettes || []).length,
          };
        } else {
          oldIndex.rules[job.id] = { features: (o.fonctionnalites || []).length, sprints: (o.sprints || []).length };
        }
      } catch { oldErrors++; }
    });
  }, () => `${jobs.length} appels, ${oldErrors} erreur(s)`);

  // --- Phase 4 : NOUVEAU chemin (0 appel réseau) ---------------------------
  if (!asJson) console.log("\n[4] NOUVEAU chemin — index dérivé du payload (0 appel réseau)");
  const newIndex = await timeIt("new-index", "buildFeatureRuleLinkIndex (local, 0 appel)", async () =>
    buildFeatureRuleLinkIndex(features, rules),
  );
  const newFeatures = Object.keys(newIndex.features).length;
  const newRules = Object.keys(newIndex.rules).length;
  if (!asJson) {
    console.log(`    → index : ${newFeatures} fonctionnalité(s), ${newRules} règle(s) — réseau : 0 appel`);
    console.log(`    → (ancien index : ${Object.keys(oldIndex.features).length} fonctionnalité(s), ${Object.keys(oldIndex.rules).length} règle(s))`);
  }

  // --- Synthèse ------------------------------------------------------------
  const total = (ph) => results.filter((r) => r.phase === ph).reduce((s, r) => s + r.ms, 0);
  const summary = {
    projectId,
    mcpPath: process.env.MCP_TASK_ORCHESTRATOR_PATH || null,
    counts: { features: features.length, rules: rules.length, withLinks },
    simple: results.filter((r) => r.phase === "simple").map((r) => r.ms),
    lists: { feature_list: results.find((r) => r.label === "feature_list")?.ms, rule_list: results.find((r) => r.label === "rule_list")?.ms },
    oldIndex: { ms: total("old-index"), calls: jobs.length, errors: oldErrors },
    newIndex: { ms: total("new-index"), calls: 0 },
    networkCallsForIndex: { before: jobs.length, after: 0 },
    results,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("\n=== SYNTHÈSE ===");
    console.log(`  Appel MCP simple #1 (froid) : ${summary.simple[0]} ms`);
    console.log(`  Appel MCP simple #2 (chaud) : ${summary.simple[1]} ms`);
    console.log(`  feature_list                : ${summary.lists.feature_list} ms`);
    console.log(`  rule_list                   : ${summary.lists.rule_list} ms`);
    console.log(`  Index liens ANCIEN (N+1)    : ${summary.oldIndex.ms} ms (${summary.oldIndex.calls} appels)`);
    console.log(`  Index liens NOUVEAU         : ${summary.newIndex.ms} ms (0 appel)`);
    console.log("");
  }

  // Le client MCP est PERSISTANT (process partagé) : on le ferme explicitement
  // pour que le process Node du banc se termine (sinon il reste vivant).
  await closeAllMcpClients();
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error("ERREUR bench:", e && e.message ? e.message : e);
  try { await closeAllMcpClients(); } catch {}
  process.exit(1);
});
