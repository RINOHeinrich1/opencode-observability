#!/usr/bin/env node
// rename-storage-roots.mjs — Renommage des DOSSIERS RACINES de stockage du
// panneau, aligné sur la nomenclature ADR-004 (doc 17-convention-stockage.md).
//
// Les racines historiques `evaluation-*` (et l'ancienne racine `recette-docs`,
// qui portait en réalité les documents de CADRAGE) sont renommées pour porter
// le nom de l'objet réellement stocké.
//
// ORDRE DE RENOMMAGE IMPOSÉ (anti-collision `recette-docs`) :
//   1. recette-docs        -> cadrage-docs
//   2. evaluation-docs     -> recette-docs
//   3. evaluation-maquettes-> recette-maquettes
//   4. evaluation-perf     -> recette-perf
//
// IDEMPOTENT (une racine déjà renommée est ignorée), RÉVERSIBLE (--revert) et
// AUDITÉ (journal JSON sous `<storage>/.rename-storage-roots/`). `--dry-run` est
// le mode PAR DÉFAUT : aucune écriture sans `--apply` explicite. AUCUNE
// SUPPRESSION — uniquement des `fs.rename` de dossiers.
//
// Usage :
//   node scripts/rename-storage-roots.mjs [--dry-run] [--json] [--dir=<storage>]
//   node scripts/rename-storage-roots.mjs --apply [--dir=<storage>]
//   node scripts/rename-storage-roots.mjs --revert [--dir=<storage>]
//
// Options :
//   --dry-run     (défaut) liste les renommages planifiés, sans écrire.
//   --apply       applique les renommages (écriture + journal d'audit).
//   --revert      renomme en sens inverse (racines cibles -> racines historiques).
//   --dir=<path>  dossier `storage` (défaut : /root/orchestrator-panel/storage).
//   --json        sortie JSON (preuve machine).
//   --help        aide.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_STORAGE_DIR = "/root/orchestrator-panel/storage";

// Ordre IMPOSÉ : `recette-docs -> cadrage-docs` AVANT `evaluation-docs -> recette-docs`.
const ROOTS = [
  { from: "recette-docs", to: "cadrage-docs" },
  { from: "evaluation-docs", to: "recette-docs" },
  { from: "evaluation-maquettes", to: "recette-maquettes" },
  { from: "evaluation-perf", to: "recette-perf" },
];

function parseArgs(argv) {
  const out = { dryRun: true, apply: false, revert: false, json: false, help: false, dir: DEFAULT_STORAGE_DIR };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") { out.apply = true; out.dryRun = false; }
    else if (a === "--revert") out.revert = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
    else { console.error(`option inconnue : ${a}`); process.exit(2); }
  }
  return out;
}

const HELP = `Renommage des dossiers racines de stockage (ADR-004, doc 17) — dry-run par défaut.

  node scripts/rename-storage-roots.mjs [--dry-run] [--json] [--dir=<storage>]
  node scripts/rename-storage-roots.mjs --apply [--dir=<storage>]
  node scripts/rename-storage-roots.mjs --revert [--dir=<storage>]

Ordre imposé : recette-docs -> cadrage-docs ; evaluation-docs -> recette-docs ;
evaluation-maquettes -> recette-maquettes ; evaluation-perf -> recette-perf.
Aucune suppression. Aucune écriture sans --apply explicite.`;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Calcule le plan (dry-run) en SIMULANT l'état du système de fichiers au fur et
// à mesure : l'ordre imposé libère `recette-docs` (renommé en `cadrage-docs`)
// AVANT que `evaluation-docs` ne prenne ce nom. Sans simulation, on verrait un
// faux conflit sur `recette-docs`.
function plan(storageDir, pairs) {
  // Noms concernés : état virtuel initialisé depuis le disque.
  const names = new Set();
  for (const { from, to } of pairs) { names.add(from); names.add(to); }
  const virtual = new Map(); // name -> bool (présent)
  for (const n of names) virtual.set(n, isDir(path.join(storageDir, n)));

  return pairs.map(({ from, to }) => {
    const fromAbs = path.join(storageDir, from);
    const toAbs = path.join(storageDir, to);
    const fromExists = virtual.get(from);
    const toExists = virtual.get(to);
    let action;
    if (fromExists && !toExists) {
      action = "rename";
      virtual.set(from, false);
      virtual.set(to, true);
    } else if (!fromExists && toExists) action = "skip-already-done";
    else if (fromExists && toExists) action = "conflict";
    else action = "skip-absent";
    return { from, to, fromAbs, toAbs, fromExists, toExists, action };
  });
}

function audit(storageDir, entry) {
  const dir = path.join(storageDir, ".rename-storage-roots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

function printHuman(o) {
  const label = o.mode === "dry-run" ? "[dry-run]" : o.mode === "apply" ? "[apply]" : "[revert]";
  console.log(`${label} storage = ${o.storageDir}`);
  for (const e of o.entries) {
    const arrow = `${e.from} -> ${e.to}`;
    if (e.action === "rename") console.log(`  ${o.mode === "dry-run" ? "PLANIFIÉ" : "RENOMMÉ "} : ${arrow}`);
    else if (e.action === "skip-already-done") console.log(`  IGNORÉ   : ${arrow} (déjà renommé — idempotent)`);
    else if (e.action === "skip-absent") console.log(`  IGNORÉ   : ${arrow} (racine source absente)`);
    else if (e.action === "conflict") console.log(`  CONFLIT  : ${arrow} (source ET cible présentes — arrêt)`);
  }
  if (o.mode === "dry-run") console.log("Aucune écriture effectuée. Relancer avec --apply pour appliquer.");
  if (o.auditFile) console.log(`Journal d'audit : ${o.auditFile}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.apply && args.revert) { console.error("--apply et --revert sont exclusifs"); process.exit(2); }
  if (!isDir(args.dir)) { console.error(`dossier storage introuvable : ${args.dir}`); process.exit(1); }

  const pairs = args.revert ? [...ROOTS].reverse().map(({ from, to }) => ({ from: to, to: from })) : ROOTS;

  if (!args.apply && !args.revert) {
    // DRY-RUN (défaut) : aucun écrit.
    const entries = plan(args.dir, pairs);
    const o = { mode: "dry-run", storageDir: args.dir, generatedAt: new Date().toISOString(), entries };
    if (args.json) console.log(JSON.stringify(o, null, 2)); else printHuman(o);
    return;
  }

  // APPLY / REVERT : exécution réelle, dans l'ordre imposé, avec garde conflit.
  const entries = plan(args.dir, pairs);
  const conflict = entries.find((e) => e.action === "conflict");
  if (conflict) {
    console.error(`CONFLIT : ${conflict.fromAbs} et ${conflict.toAbs} existent tous deux — renommage refusé.`);
    process.exit(3);
  }
  const done = [];
  for (const e of entries) {
    if (e.action !== "rename") { done.push({ ...e, status: e.action }); continue; }
    fs.renameSync(e.fromAbs, e.toAbs);
    done.push({ ...e, status: "renamed" });
  }
  const o = { mode: args.revert ? "revert" : "apply", storageDir: args.dir, at: new Date().toISOString(), by: process.env.USER || "cli", entries: done };
  o.auditFile = audit(args.dir, o);
  if (args.json) console.log(JSON.stringify(o, null, 2)); else printHuman(o);
}

main().catch((e) => { console.error("ERREUR :", (e && e.message) || e); process.exit(1); });
