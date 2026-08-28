// panel-db.mjs — Base d'authentification du panneau (users + sessions),
// SÉPARÉE du registre de tâches (registry.db) qui reste en lecture seule.
import Database from "better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PANEL_DB || join(__dirname, "panel.db");
const SESSION_TTL_H = Number(process.env.PANEL_SESSION_TTL_H || 24);

let _db = null;

export function openDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
    -- Archivage (niveau panneau) : tâche archivée = masquée de toutes les vues.
    -- Le registre registry.db reste en lecture seule : l'archivage est un état
    -- de vue stocké dans panel.db, pas une écriture dans le registre.
    CREATE TABLE IF NOT EXISTS archives (
      task_id     TEXT PRIMARY KEY,
      archived_at TEXT NOT NULL,
      archived_by TEXT,
      snapshot    TEXT NOT NULL
    );
  `);
  bootstrapAdmin();
  return _db;
}

// --- Hachage de mots de passe (scrypt, aucune dépendance externe) ----------
export function hashPassword(password, salt = null) {
  const s = salt || randomBytes(16).toString("hex");
  const hash = scryptSync(password, s, 64).toString("hex");
  return { salt: s, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const hash = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// --- Utilisateurs ----------------------------------------------------------
export function bootstrapAdmin() {
  const db = openDb();
  if (db.prepare("SELECT id FROM users WHERE username = 'admin'").get()) return;
  const defaultPwd = process.env.PANEL_ADMIN_PASSWORD || "changeme";
  const { salt, hash } = hashPassword(defaultPwd);
  db.prepare("INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, 1, ?)")
    .run("admin", hash, salt, new Date().toISOString());
}

export function getUserByUsername(username) {
  return openDb().prepare("SELECT * FROM users WHERE username = ?").get(username) || null;
}

export function getUserById(id) {
  return openDb().prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export function listUsers() {
  return openDb().prepare("SELECT id, username, is_admin, created_at FROM users ORDER BY id").all();
}

export function createUser(username, password, isAdmin) {
  const db = openDb();
  const { salt, hash } = hashPassword(password);
  db.prepare("INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(username, hash, salt, isAdmin ? 1 : 0, new Date().toISOString());
  return getUserByUsername(username);
}

export function updatePassword(userId, password) {
  const db = openDb();
  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, userId);
}

export function deleteUser(userId) {
  openDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

// --- Sessions --------------------------------------------------------------
export function createSession(userId) {
  const db = openDb();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_H * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function getSession(token) {
  return openDb().prepare("SELECT * FROM sessions WHERE token = ?").get(token) || null;
}

export function deleteSession(token) {
  openDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function pruneSessions() {
  openDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}

// --- Archivage (niveau panneau, le registre reste en lecture seule) ---------
// snapshot : { executions, events, worktrees, deployments, decisions, artifacts }
// (comptes des éléments rattachés à la tâche au moment de l'archivage).

export function listArchives() {
  return openDb()
    .prepare("SELECT task_id, archived_at, archived_by, snapshot FROM archives ORDER BY archived_at DESC")
    .all()
    .map((a) => ({ ...a, snapshot: JSON.parse(a.snapshot) }));
}

export function getArchive(taskId) {
  const row = openDb().prepare("SELECT task_id, archived_at, archived_by, snapshot FROM archives WHERE task_id = ?").get(taskId);
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

export function archivedTaskIds() {
  return new Set(openDb().prepare("SELECT task_id FROM archives").all().map((r) => r.task_id));
}

export function archiveTask(taskId, archivedBy, snapshot) {
  const db = openDb();
  db.prepare(
    "INSERT OR REPLACE INTO archives (task_id, archived_at, archived_by, snapshot) VALUES (?, ?, ?, ?)",
  ).run(taskId, new Date().toISOString(), archivedBy || null, JSON.stringify(snapshot));
  return getArchive(taskId);
}

export function restoreTask(taskId) {
  const row = getArchive(taskId);
  if (!row) return null;
  openDb().prepare("DELETE FROM archives WHERE task_id = ?").run(taskId);
  return row;
}

// Supprime la seule entrée d'archive (sans retour), utilisé après une
// suppression définitive de la tâche (les données du registre ont déjà disparu).
export function removeArchive(taskId) {
  openDb().prepare("DELETE FROM archives WHERE task_id = ?").run(taskId);
}
