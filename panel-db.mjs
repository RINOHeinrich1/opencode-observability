// panel-db.mjs — Base d'authentification du panneau (users + sessions + archives),
// SÉPARÉE du registre de tâches. PostgreSQL (base `panel`).
import pg from "pg";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const { Pool } = pg;
const SESSION_TTL_H = Number(process.env.PANEL_SESSION_TTL_H || 24);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS archives (
  task_id     TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL,
  archived_by TEXT,
  snapshot    TEXT NOT NULL
);
`;

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const url = process.env.PANEL_DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/panel";
  _pool = new Pool({ connectionString: url, max: 10 });
  return _pool;
}

let _ready = false;
let _readyPromise = null;
async function ensureReady() {
  if (_ready) return;
  if (!_readyPromise) {
    _readyPromise = (async () => {
      await pool().query(SCHEMA);
      await bootstrapAdmin();
      _ready = true;
    })();
  }
  await _readyPromise;
}

export async function openDb() {
  await ensureReady();
  return pool();
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
export async function bootstrapAdmin() {
  const res = await pool().query("SELECT id FROM users WHERE username = 'admin'");
  if (res.rows[0]) return;
  const defaultPwd = process.env.PANEL_ADMIN_PASSWORD || "changeme";
  const { salt, hash } = hashPassword(defaultPwd);
  await pool().query("INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES ($1,$2,$3,1,$4)", ["admin", hash, salt, new Date().toISOString()]);
}

export async function getUserByUsername(username) {
  const res = await pool().query("SELECT * FROM users WHERE username = $1", [username]);
  return res.rows[0] || null;
}

export async function getUserById(id) {
  const res = await pool().query("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0] || null;
}

export async function listUsers() {
  const res = await pool().query("SELECT id, username, is_admin, created_at FROM users ORDER BY id");
  return res.rows;
}

export async function createUser(username, password, isAdmin) {
  const { salt, hash } = hashPassword(password);
  await pool().query("INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES ($1,$2,$3,$4,$5)", [username, hash, salt, isAdmin ? 1 : 0, new Date().toISOString()]);
  return getUserByUsername(username);
}

export async function updatePassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  await pool().query("UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3", [hash, salt, userId]);
}

export async function deleteUser(userId) {
  await pool().query("DELETE FROM users WHERE id = $1", [userId]);
}

// --- Sessions --------------------------------------------------------------
export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_H * 3600 * 1000).toISOString();
  await pool().query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)", [token, userId, expiresAt]);
  return { token, expiresAt };
}

export async function getSession(token) {
  const res = await pool().query("SELECT * FROM sessions WHERE token = $1", [token]);
  return res.rows[0] || null;
}

export async function deleteSession(token) {
  await pool().query("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function pruneSessions() {
  await pool().query("DELETE FROM sessions WHERE expires_at < $1", [new Date().toISOString()]);
}

// --- Archivage (niveau panneau, le registre reste en lecture seule) ---------
export async function listArchives() {
  const res = await pool().query("SELECT task_id, archived_at, archived_by, snapshot FROM archives ORDER BY archived_at DESC");
  return res.rows.map((a) => ({ ...a, snapshot: JSON.parse(a.snapshot) }));
}

export async function getArchive(taskId) {
  const res = await pool().query("SELECT task_id, archived_at, archived_by, snapshot FROM archives WHERE task_id = $1", [taskId]);
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

export async function archivedTaskIds() {
  const res = await pool().query("SELECT task_id FROM archives");
  return new Set(res.rows.map((r) => r.task_id));
}

export async function archiveTask(taskId, archivedBy, snapshot) {
  await pool().query(
    `INSERT INTO archives (task_id, archived_at, archived_by, snapshot) VALUES ($1,$2,$3,$4)
     ON CONFLICT(task_id) DO UPDATE SET archived_at = EXCLUDED.archived_at, archived_by = EXCLUDED.archived_by, snapshot = EXCLUDED.snapshot`,
    [taskId, new Date().toISOString(), archivedBy || null, JSON.stringify(snapshot)],
  );
  return getArchive(taskId);
}

export async function restoreTask(taskId) {
  const row = await getArchive(taskId);
  if (!row) return null;
  await pool().query("DELETE FROM archives WHERE task_id = $1", [taskId]);
  return row;
}

export async function removeArchive(taskId) {
  await pool().query("DELETE FROM archives WHERE task_id = $1", [taskId]);
}
