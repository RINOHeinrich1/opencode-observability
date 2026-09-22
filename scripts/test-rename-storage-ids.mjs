#!/usr/bin/env node
// Test de `scripts/rename-storage-ids.mjs` — base PostgreSQL JETABLE + dossier
// de stockage TEMPORAIRE (créés puis supprimés). Aucune écriture sur la prod.
//
// Vérifie :
//   1. `--dry-run` (défaut) : AUCUNE écriture (fichiers intacts, pas de tables d'audit) ;
//   2. `--orphans` : signale les fichiers non référencés (sans les toucher) ;
//   3. `--apply` : renomme les fichiers à ancien id RÉSOLUS et RÉFÉRENCÉS,
//      ignore (signale) les AMBIGUS et les ORPHELINS, `storage/e2e/**` exclu ;
//   4. `--align-paths --apply` : `artifacts.path` + `meta.maquetteDir` alignés ;
//   5. `--check` : 0 lien mort ;
//   6. idempotence (`--apply` rejoué = 0 renommage) ;
//   7. `--revert --apply` : retour à l'état initial (fichiers + chemins).
//
// Usage : node scripts/test-rename-storage-ids.mjs
import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "rename-storage-ids.mjs");

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const dbName = `task_registry_renids_${Date.now().toString(36)}_${process.pid}`;
const conn = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); })();

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
}
const q = async (c, sql, params) => (await c.query(sql, params)).rows;
const n1 = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);

const run = (args, dir) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, `--dir=${dir}`, "--json"], {
    env: { ...process.env, DATABASE_URL: conn }, encoding: "utf8",
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
};

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const c = new pg.Client({ connectionString: conn });
  await c.connect();

  // --- Fixtures base (schéma minimal du registre) -------------------------
  await c.query(`CREATE TABLE cadrages (cadrage_id TEXT PRIMARY KEY)`);
  await c.query(`CREATE TABLE recettes (recette_id TEXT PRIMARY KEY)`);
  await c.query(`CREATE TABLE nomenclature_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, entity TEXT NOT NULL, migrated_at TEXT)`);
  await c.query(`CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, path TEXT, content_id TEXT, meta JSONB, updated_at TEXT)`);
  const ts = new Date().toISOString();
  await c.query("INSERT INTO cadrages (cadrage_id) VALUES ('CT-cad0001-aaaa')");
  await c.query("INSERT INTO recettes (recette_id) VALUES ('RECT-rec00001-aaaa')");
  await c.query("INSERT INTO nomenclature_id_map (old_id,new_id,entity,migrated_at) VALUES ('RECT-cad0001-aaaa','CT-cad0001-aaaa','cadrage',$1)", [ts]);
  await c.query("INSERT INTO nomenclature_id_map (old_id,new_id,entity,migrated_at) VALUES ('RECT-T-20260101-000000-aaaa-bbbb','CT-T-20260101-000000-aaaa-bbbb','cadrage',$1)", [ts]);

  // --- Fixtures disque (dossier temporaire) -------------------------------
  const dir = fs.mkdtempSync(join(os.tmpdir(), "renids-"));
  const mk = (rel, content = "x") => { const p = join(dir, rel); fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const fCad = mk("cadrage-docs/RECT-cad0001-aaaa-1700000000000-doc.md");
  const fRec = mk("recette-maquettes/RECT-rec00001-aaaa/slug/index.html");
  const fOrphan = mk("cadrage-docs/RECT-orph0001-aaaa-1700000000001-x.md");
  const fNonConf = mk("cadrage-docs/RECT-T-20260101-000000-aaaa-bbbb-1700000000002-note.md");
  mk("e2e/runs/EXE-aaaa/y.webm"); // doit être ignoré

  // Artefact cadrage : path porte l'ANCIEN id (fichier à renommer).
  await c.query("INSERT INTO artifacts (artifact_id,path,content_id,meta) VALUES ('ART-CAD',$1,'CT-cad0001-aaaa','{}'::jsonb)", [fCad]);
  // Artefact maquette : path + meta.maquetteDir pointent une ANCIENNE racine.
  const staleDir = join(dir, "evaluation-maquettes/RECT-rec00001-aaaa/slug");
  await c.query("INSERT INTO artifacts (artifact_id,path,content_id,meta) VALUES ('ART-REC',$1,'RECT-rec00001-aaaa',$2::jsonb)",
    [join(staleDir, "index.html"), JSON.stringify({ maquetteDir: staleDir, url: "/api/recettes/RECT-rec00001-aaaa/maquette/slug/index.html" })]);

  // --- 1. DRY-RUN (aucune écriture) ---------------------------------------
  const dry = run([], dir);
  check("dry-run code 0", dry.code, 0);
  check("dry-run : fichier NON renommé", fs.existsSync(fCad), true);
  check("dry-run : cible absente", fs.existsSync(join(dir, "cadrage-docs/CT-cad0001-aaaa-1700000000000-doc.md")), false);
  check("dry-run : aucune table d'audit", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_name='storage_rename_map'"), 0);
  check("dry-run : 1 entrée à renommer", (dry.json.entries || []).filter((e) => e.action === "rename").length, 1);
  check("dry-run : orphelin signalé (skip-orphan)", (dry.json.entries || []).filter((e) => e.action === "skip-orphan").length, 1);

  // --- 2. ORPHANS ---------------------------------------------------------
  const orph = run(["--orphans"], dir);
  check("orphans code 0", orph.code, 0);
  check("orphans : 2 fichiers non référencés", orph.json.orphans.length, 2);
  check("orphans : inclut RECT-orph0001", orph.json.orphans.some((o) => o.rel.includes("RECT-orph0001")), true);
  check("orphans : inclut RECT-T-20260101 (NON CONFORME)", orph.json.orphans.some((o) => o.rel.includes("RECT-T-20260101")), true);

  // --- 3. APPLY -----------------------------------------------------------
  const apply = run(["--apply"], dir);
  check("apply code 0", apply.code, 0);
  check("apply : fichier renommé (CT-*)", fs.existsSync(join(dir, "cadrage-docs/CT-cad0001-aaaa-1700000000000-doc.md")), true);
  check("apply : ancien fichier disparu (rename)", fs.existsSync(fCad), false);
  check("apply : dossier recette DEJA_A_JOUR intact", fs.existsSync(fRec), true);
  check("apply : orphelin AMBIGU NON renommé", fs.existsSync(fOrphan), true);
  check("apply : orphelin NON CONFORME NON renommé", fs.existsSync(fNonConf), true);
  check("apply : e2e intact", fs.existsSync(join(dir, "e2e/runs/EXE-aaaa/y.webm")), true);
  check("apply : 1 rename enregistré", await n1(c, "SELECT count(*) n FROM storage_rename_map WHERE kind='file' AND new_path LIKE '%CT-cad0001%'"), 1);
  check("apply : étape audit tracée", await n1(c, "SELECT count(*) n FROM storage_rename_migrations WHERE step='files:rename'"), 1);

  // --- 4. ALIGN-PATHS --APPLY --------------------------------------------
  const align = run(["--align-paths", "--apply"], dir);
  check("align code 0", align.code, 0);
  check("align : artifacts.path cadrage aligné", (await q(c, "SELECT path FROM artifacts WHERE artifact_id='ART-CAD'"))[0].path, join(dir, "cadrage-docs/CT-cad0001-aaaa-1700000000000-doc.md"));
  check("align : artifacts.path maquette aligné", (await q(c, "SELECT path FROM artifacts WHERE artifact_id='ART-REC'"))[0].path, join(dir, "recette-maquettes/RECT-rec00001-aaaa/slug/index.html"));
  check("align : meta.maquetteDir aligné", (await q(c, "SELECT meta->>'maquetteDir' AS m FROM artifacts WHERE artifact_id='ART-REC'"))[0].m, join(dir, "recette-maquettes/RECT-rec00001-aaaa/slug"));
  check("align : meta.url inchangée (déjà au bon id)", (await q(c, "SELECT meta->>'url' AS u FROM artifacts WHERE artifact_id='ART-REC'"))[0].u, "/api/recettes/RECT-rec00001-aaaa/maquette/slug/index.html");

  // --- 5. CHECK (0 lien mort) --------------------------------------------
  const chk = run(["--check"], dir);
  check("check code 0", chk.code, 0);
  check("check : 0 lien mort", chk.json.deadCount, 0);

  // --- 6. IDEMPOTENCE -----------------------------------------------------
  const again = run(["--apply"], dir);
  check("idempotence : 0 rename", (again.json.entries || []).filter((e) => e.result === "renamed").length, 0);

  // --- 7. REVERT ----------------------------------------------------------
  const rev = run(["--revert", "--apply"], dir);
  check("revert code 0", rev.code, 0);
  check("revert : fichier ancien restauré", fs.existsSync(fCad), true);
  check("revert : fichier CT-* disparu", fs.existsSync(join(dir, "cadrage-docs/CT-cad0001-aaaa-1700000000000-doc.md")), false);
  check("revert : artifacts.path cadrage restauré", (await q(c, "SELECT path FROM artifacts WHERE artifact_id='ART-CAD'"))[0].path, fCad);
  check("revert : artifacts.path maquette restauré", (await q(c, "SELECT path FROM artifacts WHERE artifact_id='ART-REC'"))[0].path, join(staleDir, "index.html"));
  check("revert : meta.maquetteDir restauré", (await q(c, "SELECT meta->>'maquetteDir' AS m FROM artifacts WHERE artifact_id='ART-REC'"))[0].m, staleDir);

  await c.end();
  fs.rmSync(dir, { recursive: true, force: true });
  const admin2 = new pg.Client({ connectionString: ADMIN_URL });
  await admin2.connect();
  await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin2.end();

  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "TOUS LES TESTS PASSENT" : failures + " ÉCHEC(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERREUR test :", e.message); process.exit(1); });
