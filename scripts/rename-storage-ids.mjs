#!/usr/bin/env node
// rename-storage-ids.mjs — Renommage des FICHIERS/DOSSIERS de `storage/` dont le
// nom porte un ANCIEN identifiant ADR-004 (ancien `RECT-*` d'un cadrage devenu
// `CT-*` ; ancien `EVAL-*` d'une recette devenue `RECT-*`), puis alignement des
// `artifacts.path` / `meta.maquetteDir` / `meta.url` sur l'emplacement disque réel.
//
// Ce script est le « point 4 » du suivi ADR-004 : la migration
// `migrate-nomenclature-cadrage-recette.mjs` a renommé les identifiants EN BASE
// mais PAS les noms de fichiers sur le disque. Le renommage des DOSSIERS RACINES
// (`recette-docs`→`cadrage-docs`, `evaluation-*`→`recette-*`) est traité par le
// plan frère `rename-storage-roots.mjs`.
//
// GARANTIES (exigences du plan) :
//   - IDEMPOTENT : un fichier déjà renommé est ignoré ; une cible déjà présente
//     n'est jamais écrasée ;
//   - RÉVERSIBLE : `--revert` rejoue la table d'audit `storage_rename_map` à
//     l'envers (fichiers + chemins en base) ;
//   - AUDITÉ : tables `storage_rename_migrations` (marqueur d'étape) et
//     `storage_rename_map` (correspondance ancien→nouveau) ;
//   - `--dry-run` PAR DÉFAUT : aucune écriture (disque ET base) sans `--apply` ;
//   - AUCUNE SUPPRESSION : uniquement des `fs.rename` ;
//   - RÉSOLUTION SÛRE : un token est renommé SEULEMENT s'il est résolu par
//     `nomenclature_id_map` ET référencé par un artefact ; un token inconnu
//     (`AMBIGU`) ou un fichier non référencé (`ORPHELIN`) est SIGNALÉ, jamais
//     renommé aveuglément. `storage/e2e/**` (ids `EXE-*`, hors ADR-004) est exclu.
//
// ⚠️ L'APPLICATION RÉELLE (`--apply`) est une DÉCISION HUMAINE.
//
// Usage :
//   node scripts/rename-storage-ids.mjs                       # dry-run (défaut)
//   node scripts/rename-storage-ids.mjs --orphans             # liste les orphelins
//   node scripts/rename-storage-ids.mjs --check               # 0 lien mort ?
//   node scripts/rename-storage-ids.mjs --apply [--align-paths]   # décision humaine
//   node scripts/rename-storage-ids.mjs --align-paths         # dry-run de l'alignement
//   node scripts/rename-storage-ids.mjs --revert [--apply]    # retour arrière
//
// Options :
//   --dry-run       (défaut) n'écrit rien.
//   --apply         exécute les renommages (+ alignement si --align-paths).
//   --revert        rejoue la table d'audit à l'envers (dry-run sans --apply).
//   --align-paths   recalcule `artifacts.path` (+ meta.maquetteDir/meta.url)
//                   depuis l'emplacement disque réel APRÈS renommage (écrit
//                   seulement avec --apply). Idempotent et correct dans les deux
//                   ordres : renommage + alignement dans le MÊME run, ou
//                   alignement seul après renommage.
//   --orphans       liste les fichiers de `storage/` non référencés (jamais supprimés).
//   --check         vérifie que tout `artifacts.path` sous `storage/` existe (0 lien mort).
//   --dir=<path>    dossier `storage` (défaut : /root/orchestrator-panel/storage).
//   --json          sortie JSON (preuve machine).
//   --help          aide.
//
// Env : DATABASE_URL (défaut : registre local).

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const DEFAULT_STORAGE_DIR = "/root/orchestrator-panel/storage";
const DEFAULT_DB_URL =
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

// Id « exact » (segment entier : dossier id-nommé, ou fichier sans suffixe).
const ID_EXACT = /^(?:CT|RECT|EVAL)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
// Préfixe d'un ancien id (candidat au renommage).
const ID_PREFIX = /^(?:RECT|EVAL)-/;
// Motif CONFORME de la convention ADR-004 : `<PREFIX>-<8 alnum>-<4 alnum>`.
const ID_CONFORM = /^(?:CT|RECT|EVAL)-[a-z0-9]{8}-[a-z0-9]{4}$/;
// Un nom de fichier conventionnel : `<ID>-<timestamp 13 chiffres>-<libellé>.<ext>`.
const NAME_WITH_TS = /^((?:CT|RECT|EVAL)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*?)-\d{13}-/;

const HELP = `Renommage des fichiers de storage/ portant un ancien id (ADR-004) — dry-run par défaut.

  node scripts/rename-storage-ids.mjs [--dry-run] [--json] [--dir=<storage>]
  node scripts/rename-storage-ids.mjs --orphans
  node scripts/rename-storage-ids.mjs --check
  node scripts/rename-storage-ids.mjs --align-paths
  node scripts/rename-storage-ids.mjs --apply [--align-paths]
  node scripts/rename-storage-ids.mjs --revert [--apply]

Résolution sûre via nomenclature_id_map + ids courants (cadrages/recettes).
Un token inconnu (AMBIGU) ou un fichier non référencé (ORPHELIN) est signalé,
jamais renommé. storage/e2e/** (EXE-*) est exclu. Aucune suppression.`;

// ---------------------------------------------------------------------------
// Détection d'identifiant dans un segment de chemin
// ---------------------------------------------------------------------------
function extractToken(segment) {
  if (!segment || segment.startsWith(".")) return null;
  if (ID_EXACT.test(segment)) return segment;
  const m = segment.match(NAME_WITH_TS);
  if (m) return m[1];
  return null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    dryRun: true, apply: false, revert: false, alignPaths: false,
    orphans: false, check: false, json: false, help: false,
    dir: DEFAULT_STORAGE_DIR,
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") { out.apply = true; out.dryRun = false; }
    else if (a === "--revert") out.revert = true;
    else if (a === "--align-paths") out.alignPaths = true;
    else if (a === "--orphans") out.orphans = true;
    else if (a === "--check") out.check = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
    else { console.error(`option inconnue : ${a}`); process.exit(2); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Résolveur d'identifiants (base du registre)
// ---------------------------------------------------------------------------
async function buildIdResolver(client) {
  const idMap = new Map(); // old_id -> { newId, entity }
  const idMapRows = (await client.query(
    "SELECT old_id, new_id, entity FROM nomenclature_id_map",
  )).rows;
  for (const r of idMapRows) idMap.set(r.old_id, { newId: r.new_id, entity: r.entity });

  const current = new Set();
  for (const r of (await client.query("SELECT cadrage_id AS id FROM cadrages")).rows) current.add(r.id);
  for (const r of (await client.query("SELECT recette_id AS id FROM recettes")).rows) current.add(r.id);

  const reverse = new Map(); // new_id -> [old_id...]
  for (const [oldId, v] of idMap) {
    if (!reverse.has(v.newId)) reverse.set(v.newId, []);
    reverse.get(v.newId).push(oldId);
  }

  return {
    current, idMap, reverse,
    resolve(token) {
      if (current.has(token)) return { status: "DEJA_A_JOUR", newId: token, entity: null };
      if (idMap.has(token)) return { status: "RESOLU", newId: idMap.get(token).newId, entity: idMap.get(token).entity };
      if (ID_PREFIX.test(token)) return { status: "AMBIGU", newId: null, entity: null };
      return { status: "NON_CONFORME", newId: null, entity: null };
    },
    // Candidats (id courant + anciens ids) pour retrouver un artefact sur disque.
    candidatesFor(contentId) {
      const c = [contentId];
      for (const o of (reverse.get(contentId) || [])) c.push(o);
      return c;
    },
  };
}

// ---------------------------------------------------------------------------
// Parcours de storage/ (hors storage/e2e/** et journaux d'audit)
// ---------------------------------------------------------------------------
const SKIP_TOP = new Set(["e2e"]);

function scanStorage(storageDir) {
  const out = []; // { rel, abs, isDir }
  function walk(relDir) {
    const absDir = relDir ? path.join(storageDir, relDir) : storageDir;
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".rename-storage")) continue;
      if (!relDir && SKIP_TOP.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      out.push({ rel, abs: path.join(storageDir, rel), isDir: e.isDirectory() });
      if (e.isDirectory()) walk(rel);
    }
  }
  walk("");
  return out;
}

// ---------------------------------------------------------------------------
// Index des références (artifacts.path → token)
// ---------------------------------------------------------------------------
async function buildRefIndex(client) {
  const rows = (await client.query(
    "SELECT artifact_id, path FROM artifacts WHERE path IS NOT NULL",
  )).rows;
  const byToken = new Map();
  const exact = new Map();
  for (const r of rows) {
    if (!r.path) continue;
    exact.set(r.path, r.artifact_id);
    for (const seg of String(r.path).split("/")) {
      const t = extractToken(seg);
      if (t && !byToken.has(t)) byToken.set(t, r.artifact_id);
    }
  }
  return { byToken, exact };
}

function referencedBy(rel, abs, refIndex) {
  for (const seg of rel.split("/")) {
    const t = extractToken(seg);
    if (t && refIndex.byToken.has(t)) return refIndex.byToken.get(t);
  }
  return refIndex.exact.get(abs) || null;
}

// ---------------------------------------------------------------------------
// Plan de renommage (dry-run / apply)
// ---------------------------------------------------------------------------
function buildPlan(storageDir, entries, resolver, refIndex) {
  const plan = [];
  for (const e of entries) {
    const segs = e.rel.split("/");
    let changed = false;
    const newSegs = segs.map((seg) => {
      const tok = extractToken(seg);
      if (!tok) return seg;
      const r = resolver.resolve(tok);
      if (r.status === "RESOLU" && r.newId && r.newId !== tok) {
        changed = true;
        return seg.replace(tok, r.newId);
      }
      return seg;
    });
    if (!changed) continue;
    const token = segs.map(extractToken).find(Boolean);
    const res = resolver.resolve(token);
    const artifactId = referencedBy(e.rel, e.abs, refIndex);
    const referenced = !!artifactId;
    plan.push({
      from: e.rel,
      to: newSegs.join("/"),
      fromAbs: e.abs,
      toAbs: path.join(storageDir, ...newSegs),
      isDir: e.isDir,
      token,
      status: res.status,
      entity: res.entity,
      conform: ID_CONFORM.test(token),
      referenced,
      artifactId,
      action: referenced && res.status === "RESOLU" ? "rename" : referenced ? "skip-ambiguous" : "skip-orphan",
    });
  }
  // Ne garder que l'entrée la plus haute d'une sous-arborescence renommée.
  const dirRels = new Set(plan.filter((p) => p.isDir).map((p) => p.from));
  return plan.filter((p) => ![...dirRels].some((d) => p.from.startsWith(d + "/")));
}

// Liste des fichiers non référencés (orphelins) — jamais supprimés.
function listOrphans(entries, refIndex) {
  return entries
    .filter((e) => !e.isDir)
    .map((e) => ({ rel: e.rel, abs: e.abs, artifactId: referencedBy(e.rel, e.abs, refIndex) }))
    .filter((e) => !e.artifactId);
}

// ---------------------------------------------------------------------------
// Projection des entrées vers leur emplacement APRÈS renommage
// ---------------------------------------------------------------------------
// L'alignement DOIT viser le nom de fichier RÉEL post-renommage. Comme le plan
// de renommage est calculé AVANT toute écriture, on projette ici les entrées
// scannées (`fromAbs`/`from`) vers leur cible (`toAbs`/`to`) pour que le
// dry-run et le run `--apply --align-paths` (renommage + alignement dans le
// MÊME run) produisent le bon chemin. En `--apply`, on re-scanne le disque
// après renommage (source de vérité), ce qui couvre aussi le cas « alignement
// seul après renommage ».
function projectEntries(entries, plan, storageDir) {
  const renames = plan
    .filter((p) => p.action === "rename")
    .map((p) => ({ from: p.from, to: p.to, isDir: p.isDir }))
    .sort((a, b) => b.from.length - a.from.length); // plus long préfixe d'abord
  return entries.map((e) => {
    for (const r of renames) {
      if (e.rel === r.from) {
        return { ...e, rel: r.to, abs: path.join(storageDir, ...r.to.split("/")) };
      }
      if (r.isDir && e.rel.startsWith(r.from + "/")) {
        const rel = r.to + e.rel.slice(r.from.length);
        return { ...e, rel, abs: path.join(storageDir, ...rel.split("/")) };
      }
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Alignement des chemins (artifacts.path / meta.*)
// ---------------------------------------------------------------------------
async function buildAlignPlan(client, storageDir, resolver, entries) {
  const tokenIndex = new Map(); // token -> [abs de fichiers]
  for (const e of entries) {
    if (e.isDir) continue;
    for (const seg of e.rel.split("/")) {
      const t = extractToken(seg);
      if (!t) continue;
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(e.abs);
    }
  }

  const arts = (await client.query(
    "SELECT artifact_id, path, content_id, meta FROM artifacts WHERE path IS NOT NULL",
  )).rows;
  const changes = [];
  for (const a of arts) {
    if (!String(a.path).startsWith(storageDir + path.sep) && !String(a.path).startsWith(storageDir + "/")) continue;
    const cands = resolver.candidatesFor(a.content_id);
    let realPath = null;
    for (const cand of cands) {
      const hits = tokenIndex.get(cand);
      if (hits && hits.length) {
        // Préférer le chemin RÉEL existant (cas --apply : disque post-renommage) ;
        // sinon la cible projetée (dry-run : le fichier n'est pas encore renommé).
        // Conserve `a.path` s'il est lui-même un chemin valide (idempotence).
        realPath = hits.includes(a.path) && fs.existsSync(a.path)
          ? a.path
          : (hits.find((h) => fs.existsSync(h)) || hits[0]);
        break;
      }
    }
    if (!realPath) continue;

    const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
    const newMeta = { ...meta };
    let metaChanged = false;
    if (meta.maquetteDir && String(meta.maquetteDir).startsWith(storageDir) && meta.maquetteDir !== path.dirname(realPath)) {
      newMeta.maquetteDir = path.dirname(realPath);
      metaChanged = true;
    }
    if (meta.url) {
      let u = String(meta.url);
      for (const o of (resolver.reverse.get(a.content_id) || [])) {
        if (u.includes(o)) { u = u.split(o).join(a.content_id); metaChanged = true; }
      }
      if (u !== meta.url) newMeta.url = u;
    }
    if (realPath !== a.path || metaChanged) {
      changes.push({
        artifact_id: a.artifact_id, oldPath: a.path, newPath: realPath,
        oldMeta: meta, newMeta, metaChanged,
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Audit (tables du registre)
// ---------------------------------------------------------------------------
async function ensureAuditTables(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS storage_rename_migrations (
    step       TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'applied',
    applied_at TEXT NOT NULL,
    detail     TEXT
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS storage_rename_map (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    old_path    TEXT NOT NULL,
    new_path    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    artifact_id TEXT,
    applied_at  TEXT NOT NULL
  )`);
}

async function recordStep(client, step, detail) {
  await client.query(
    `INSERT INTO storage_rename_migrations (step, status, applied_at, detail)
     VALUES ($1,'applied',$2,$3)
     ON CONFLICT (step) DO UPDATE SET status='applied', applied_at=EXCLUDED.applied_at, detail=EXCLUDED.detail`,
    [step, new Date().toISOString(), JSON.stringify(detail)],
  );
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------
async function applyFileRenames(client, plan) {
  const done = [];
  for (const e of plan) {
    if (e.action !== "rename") { done.push({ ...e, result: e.action }); continue; }
    if (!fs.existsSync(e.fromAbs)) { done.push({ ...e, result: "skip-absent" }); continue; }
    if (fs.existsSync(e.toAbs)) { done.push({ ...e, result: "skip-target-exists" }); continue; }
    fs.renameSync(e.fromAbs, e.toAbs);
    await client.query(
      `INSERT INTO storage_rename_map (old_path,new_path,kind,artifact_id,applied_at) VALUES ($1,$2,'file',$3,$4)`,
      [e.fromAbs, e.toAbs, e.artifactId || null, new Date().toISOString()],
    );
    done.push({ ...e, result: "renamed" });
  }
  return done;
}

async function applyAlign(client, changes) {
  const done = [];
  for (const ch of changes) {
    const now = new Date().toISOString();
    await client.query(
      "UPDATE artifacts SET path=$1, meta=$2::jsonb, updated_at=$3 WHERE artifact_id=$4",
      [ch.newPath, JSON.stringify(ch.newMeta), now, ch.artifact_id],
    );
    await client.query(
      `INSERT INTO storage_rename_map (old_path,new_path,kind,artifact_id,applied_at) VALUES ($1,$2,'db_path',$3,$4)`,
      [ch.oldPath, ch.newPath, ch.artifact_id, now],
    );
    if (ch.metaChanged) {
      await client.query(
        `INSERT INTO storage_rename_map (old_path,new_path,kind,artifact_id,applied_at) VALUES ($1,$2,'db_meta',$3,$4)`,
        [JSON.stringify(ch.oldMeta), JSON.stringify(ch.newMeta), ch.artifact_id, now],
      );
    }
    done.push({ ...ch, result: "aligned" });
  }
  return done;
}

async function runRevert(client, write) {
  await ensureAuditTables(client);
  const rows = (await client.query("SELECT * FROM storage_rename_map ORDER BY id DESC")).rows;
  const done = [];
  for (const r of rows) {
    if (r.kind === "file") {
      const exists = fs.existsSync(r.new_path);
      const targetFree = !fs.existsSync(r.old_path);
      if (!exists) { done.push({ kind: "file", from: r.new_path, to: r.old_path, result: "skip-absent" }); continue; }
      if (!targetFree) { done.push({ kind: "file", from: r.new_path, to: r.old_path, result: "skip-target-exists" }); continue; }
      if (write) fs.renameSync(r.new_path, r.old_path);
      done.push({ kind: "file", from: r.new_path, to: r.old_path, result: write ? "reverted" : "planifie" });
    } else if (r.kind === "db_path") {
      if (write) await client.query("UPDATE artifacts SET path=$1 WHERE artifact_id=$2 AND path=$3", [r.old_path, r.artifact_id, r.new_path]);
      done.push({ kind: "db_path", artifactId: r.artifact_id, from: r.new_path, to: r.old_path, result: write ? "reverted" : "planifie" });
    } else if (r.kind === "db_meta") {
      if (write) await client.query("UPDATE artifacts SET meta=$1::jsonb WHERE artifact_id=$2", [r.old_path, r.artifact_id]);
      done.push({ kind: "db_meta", artifactId: r.artifact_id, result: write ? "reverted" : "planifie" });
    }
  }
  return done;
}

async function runCheck(client, storageDir) {
  const arts = (await client.query(
    "SELECT artifact_id, path FROM artifacts WHERE path IS NOT NULL",
  )).rows.filter((a) => String(a.path).startsWith(storageDir));
  const dead = arts.filter((a) => !fs.existsSync(a.path)).map((a) => ({ artifact_id: a.artifact_id, path: a.path }));
  return { checked: arts.length, deadCount: dead.length, dead };
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
function printPlan(o) {
  const label = o.write ? "[apply]" : "[dry-run]";
  console.log(`${label} storage = ${o.storageDir}`);
  for (const e of o.entries) {
    const arrow = `${e.from} -> ${e.to}`;
    const tag = e.referenced ? `référencé ${e.artifactId}` : "ORPHELIN";
    if (e.action === "rename") console.log(`  ${o.write ? "RENOMMÉ " : "PLANIFIÉ"} : ${arrow}  [${e.status}${e.conform ? "" : " / NON_CONFORME"}] (${tag})`);
    else if (e.action === "skip-ambiguous") console.log(`  SIGNALÉ  : ${arrow}  [${e.status} — renommage refusé] (${tag})`);
    else console.log(`  SIGNALÉ  : ${arrow}  [ORPHELIN — renommage refusé] (${tag})`);
  }
  if (!o.write) console.log("Aucune écriture effectuée. Relancer avec --apply (décision humaine).");
}

function printOrphans(orphans) {
  console.log(`Orphelins (présents sur disque, non référencés en base) — ${orphans.length} :`);
  for (const o of orphans) console.log(`  ${o.rel}`);
  console.log("Aucune suppression. À statuer manuellement.");
}

function printCheck(r) {
  console.log(`Liens morts (artifacts.path sous storage/ inexistants) : ${r.deadCount}/${r.checked}`);
  for (const d of r.dead) console.log(`  MORT : ${d.artifact_id} -> ${d.path}`);
  if (r.deadCount === 0) console.log("0 lien mort.");
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!fs.existsSync(args.dir)) { console.error(`dossier storage introuvable : ${args.dir}`); process.exit(1); }

  const client = new pg.Client({ connectionString: DEFAULT_DB_URL });
  await client.connect();
  try {
    const resolver = await buildIdResolver(client);
    const entries = scanStorage(args.dir);
    const refIndex = await buildRefIndex(client);

    if (args.check) {
      const r = await runCheck(client, args.dir);
      if (args.json) console.log(JSON.stringify({ mode: "check", ...r }, null, 2)); else printCheck(r);
      return;
    }

    if (args.orphans && !args.apply && !args.revert && !args.alignPaths) {
      const orphans = listOrphans(entries, refIndex);
      if (args.json) console.log(JSON.stringify({ mode: "orphans", orphans }, null, 2)); else printOrphans(orphans);
      return;
    }

    if (args.revert) {
      const write = args.apply;
      const done = await runRevert(client, write);
      if (args.json) console.log(JSON.stringify({ mode: write ? "revert" : "revert-dry-run", entries: done }, null, 2));
      else { console.log(`[${write ? "revert" : "revert-dry-run"}] ${done.length} entrée(s)`); for (const d of done) console.log(`  ${d.result} : ${d.from || ""} -> ${d.to || ""}`); if (!write) console.log("Relancer avec --apply pour appliquer."); }
      return;
    }

    const plan = buildPlan(args.dir, entries, resolver, refIndex);

    if (!args.apply) {
      // DRY-RUN (défaut) : aucune écriture. L'alignement est calculé sur l'état
      // du disque APRÈS renommage (projeté) pour rester correct quand renommage
      // et alignement sont demandés dans le MÊME run.
      const alignPlan = args.alignPaths
        ? await buildAlignPlan(client, args.dir, resolver, projectEntries(entries, plan, args.dir))
        : [];
      if (args.json) {
        console.log(JSON.stringify({ mode: "dry-run", storageDir: args.dir, entries: plan, align: alignPlan }, null, 2));
      } else {
        printPlan({ write: false, storageDir: args.dir, entries: plan });
        if (args.alignPaths) {
          console.log(`\nAlignement des chemins (${alignPlan.length}) :`);
          for (const c of alignPlan) console.log(`  ${c.artifact_id} : ${c.oldPath} -> ${c.newPath}`);
        }
      }
      return;
    }

    // APPLY (décision humaine).
    await ensureAuditTables(client);
    await client.query("BEGIN");
    const renamed = await applyFileRenames(client, plan);
    // Alignement calculé APRÈS le renommage effectif : `scanStorage` reflète le
    // nom de fichier RÉEL (post-renommage) → `artifacts.path` n'est jamais
    // laissé sur l'ancien nom. Idempotent : un second passage ne change rien.
    let aligned = [];
    if (args.alignPaths) {
      const entriesAfter = scanStorage(args.dir);
      const alignPlan = await buildAlignPlan(client, args.dir, resolver, entriesAfter);
      aligned = await applyAlign(client, alignPlan);
    }
    await recordStep(client, "files:rename", { renamed: renamed.filter((r) => r.result === "renamed").length });
    if (args.alignPaths) await recordStep(client, "paths:align", { aligned: aligned.length });
    await client.query("COMMIT");

    if (args.json) console.log(JSON.stringify({ mode: "apply", entries: renamed, align: aligned }, null, 2));
    else {
      printPlan({ write: true, storageDir: args.dir, entries: renamed });
      if (args.alignPaths) { console.log(`\nAlignement des chemins (${aligned.length}) :`); for (const c of aligned) console.log(`  ${c.artifact_id} : ${c.oldPath} -> ${c.newPath}`); }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => { console.error("ERREUR :", (e && e.message) || e); process.exit(1); });
