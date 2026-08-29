#!/usr/bin/env node
// migrate-sqlite-to-postgres.mjs — Étape 3 : migration des données SQLite → PostgreSQL.
// Lit registry.db + panel.db (SQLite, lecture seule), insère dans task_registry + panel
// (PostgreSQL). Idempotent : les tables cibles sont vidées (TRUNCATE) avant insertion.
import Database from "better-sqlite3";
import pg from "pg";
import { homedir } from "node:os";
import { join } from "node:path";

const { Pool } = pg;

const REGISTRY_DB = process.env.TASK_REGISTRY_DB || join(homedir(), ".config", "opencode", "task-registry", "registry.db");
const PANEL_DB = process.env.PANEL_DB || "/root/orchestrator-panel/panel.db";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const PANEL_DATABASE_URL = process.env.PANEL_DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/panel";

// Tables du registre, ordre respectant les FK. `exclude` : colonnes non insérées
// (IDENTITY générées par Postgres, ou colonnes retirées). `orderByRowid` : préserver
// l'ordre d'insertion (remplace `rowid` pour les tris « plus récent d'abord »).
const REGISTRY_TABLES = [
  { name: "projects", exclude: [] },
  { name: "tasks", exclude: ["change_kind"] },
  { name: "executions", exclude: [] },
  { name: "worktrees", exclude: [] },
  { name: "events", exclude: ["seq"], orderByRowid: true },
  { name: "deployments", exclude: [], orderByRowid: true },
  { name: "decisions", exclude: [], orderByRowid: true },
  { name: "participants", exclude: [] },
  { name: "artifacts", exclude: [], orderByRowid: true },
  { name: "plans", exclude: [] },
  { name: "plan_steps", exclude: [] },
  { name: "plan_incidents", exclude: [], orderByRowid: true },
  { name: "plan_inconsistencies", exclude: [], orderByRowid: true },
  { name: "plan_counters", exclude: [] },
];

function sqliteTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
}

async function truncateTables(pgPool, tables) {
  await pgPool.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

async function copyTable(pgPool, sqlite, table, exclude = [], orderByRowid = false) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const insertCols = cols.filter((c) => !exclude.includes(c));
  if (insertCols.length === 0) return 0;
  const order = orderByRowid ? " ORDER BY rowid" : "";
  const sel = insertCols.map((c) => `"${c}"`).join(", ");
  const rows = sqlite.prepare(`SELECT ${sel} FROM "${table}"${order}`).all();
  let count = 0;
  for (const row of rows) {
    const ph = insertCols.map((_, i) => `$${i + 1}`).join(", ");
    await pgPool.query(`INSERT INTO "${table}" (${sel}) VALUES (${ph})`, insertCols.map((c) => row[c]));
    count++;
  }
  return count;
}

async function migrateRegistry() {
  const sqlite = new Database(REGISTRY_DB, { readonly: true });
  const pgPool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const existing = sqliteTableNames(sqlite);
  const tables = REGISTRY_TABLES.filter((t) => existing.includes(t.name));
  await truncateTables(pgPool, tables.map((t) => t.name));
  const stats = {};
  for (const t of tables) {
    const n = await copyTable(pgPool, sqlite, t.name, t.exclude, t.orderByRowid);
    stats[t.name] = n;
    console.log(`  ${t.name}: ${n} lignes`);
  }
  await pgPool.end();
  sqlite.close();
  return stats;
}

async function migratePanel() {
  const sqlite = new Database(PANEL_DB, { readonly: true });
  const pgPool = new Pool({ connectionString: PANEL_DATABASE_URL, max: 10 });
  await truncateTables(pgPool, ["users", "sessions", "archives"]);
  // users (remappage des id : sessions.user_id référence users.id)
  const users = sqlite.prepare("SELECT id, username, password_hash, salt, is_admin, created_at FROM users ORDER BY id").all();
  const idMap = {};
  for (const u of users) {
    const res = await pgPool.query(
      "INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [u.username, u.password_hash, u.salt, u.is_admin, u.created_at],
    );
    idMap[u.id] = res.rows[0].id;
  }
  console.log(`  users: ${users.length} lignes`);
  const sessions = sqlite.prepare("SELECT token, user_id, expires_at FROM sessions").all();
  let sCount = 0;
  for (const s of sessions) {
    const uid = idMap[s.user_id];
    if (uid === undefined) continue; // orpheline (utilisateur supprimé)
    await pgPool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)", [s.token, uid, s.expires_at]);
    sCount++;
  }
  console.log(`  sessions: ${sCount} lignes`);
  const archives = sqlite.prepare("SELECT task_id, archived_at, archived_by, snapshot FROM archives").all();
  for (const a of archives) {
    await pgPool.query("INSERT INTO archives (task_id, archived_at, archived_by, snapshot) VALUES ($1,$2,$3,$4)", [a.task_id, a.archived_at, a.archived_by, a.snapshot]);
  }
  console.log(`  archives: ${archives.length} lignes`);
  await pgPool.end();
  sqlite.close();
  return { users: users.length, sessions: sCount, archives: archives.length };
}

async function verify() {
  const sqlite = new Database(REGISTRY_DB, { readonly: true });
  const pgPool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const existing = sqliteTableNames(sqlite);
  console.log("\n=== Vérification (SQLite vs PostgreSQL) ===");
  let ok = true;
  for (const t of REGISTRY_TABLES) {
    if (!existing.includes(t.name)) continue;
    const s = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
    const p = Number((await pgPool.query(`SELECT COUNT(*) AS n FROM "${t.name}"`)).rows[0].n);
    const match = s === p;
    if (!match) ok = false;
    console.log(`  ${t.name}: sqlite=${s} pg=${p} ${match ? "OK" : "!! ÉCART"}`);
  }
  await pgPool.end();
  sqlite.close();
  return ok;
}

async function main() {
  console.log("Migration SQLite → PostgreSQL");
  console.log("=== Registre (task_registry) ===");
  await migrateRegistry();
  console.log("=== Panneau (panel) ===");
  await migratePanel();
  const ok = await verify();
  console.log(ok ? "\nTerminé (comptes concordants)." : "\nTerminé avec des ÉCARTS de comptage — vérifier.");
}

main().catch((e) => {
  console.error("Erreur de migration :", e);
  process.exit(1);
});
