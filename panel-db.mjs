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
  role          TEXT NOT NULL DEFAULT 'user',
  organization_id TEXT,
  notify_email  TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_organizations (
  user_id         INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  PRIMARY KEY (user_id, organization_id)
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id    INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
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
      // Migration rétrocompat (rôle superviseur v0.9.29) : ajoute la colonne role
      // aux tables existantes puis porte is_admin=1 → role='admin'.
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'");
      await pool().query("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role = 'user'");
      // Multi-organisation (v0.9.47) : chaque utilisateur appartient à une org.
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT");
      await pool().query("UPDATE users SET organization_id = 'onirtech' WHERE organization_id IS NULL");
      // Email de notification par utilisateur (v0.9.65) : destinataire des emails
      // du daemon opencode-notifier (résolu via tasks.created_by = username).
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email TEXT");
      // Multi-org (v0.9.49) : appartenance N:N + organisation active de session.
      await pool().query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_organization_id TEXT");
      // Identité opencode par utilisateur (v0.9.57) : instance dédiée (port + mot de passe).
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS opencode_port INTEGER");
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS opencode_password TEXT");
      await pool().query(
        `INSERT INTO user_organizations (user_id, organization_id)
         SELECT id, COALESCE(organization_id, 'onirtech') FROM users
         ON CONFLICT DO NOTHING`,
      );
      // Accès par PROJET (v0.9.52) : aucun par défaut. Backfill Gonzague → mada-talk.
      await pool().query(
        `INSERT INTO user_projects (user_id, project_id)
         SELECT u.id, 'mada-talk' FROM users u WHERE u.username = 'Gonzague'
         ON CONFLICT DO NOTHING`,
      );
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
  await pool().query("INSERT INTO users (username, password_hash, salt, is_admin, role, created_at) VALUES ($1,$2,$3,1,'admin',$4)", ["admin", hash, salt, new Date().toISOString()]);
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
  const res = await pool().query("SELECT id, username, role, is_admin, organization_id, notify_email, created_at FROM users ORDER BY id");
  return res.rows.map((r) => ({ ...r, role: normalizeRole(r), organizationId: r.organization_id ?? null, notifyEmail: r.notify_email ?? null }));
}

// Rôle effectif : 'admin' > 'supervisor' > 'user' (is_admin rétrocompat supercede).
function normalizeRole(r) {
  if (r.is_admin) return "admin";
  return ["admin", "supervisor", "user"].includes(r.role) ? r.role : "user";
}

// Crée un utilisateur avec un rôle explicite ('admin' | 'supervisor' | 'user').
export async function createUser(username, password, isAdmin, role, organizationId) {
  const targetRole = isAdmin ? "admin" : (["admin", "supervisor", "user"].includes(role) ? role : "user");
  const { salt, hash } = hashPassword(password);
  await pool().query(
    "INSERT INTO users (username, password_hash, salt, is_admin, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [username, hash, salt, targetRole === "admin" ? 1 : 0, targetRole, organizationId || "onirtech", new Date().toISOString()],
  );
  return getUserByUsername(username);
}

export async function updateUserRole(userId, role) {
  const targetRole = ["admin", "supervisor", "user"].includes(role) ? role : "user";
  await pool().query("UPDATE users SET role = $1, is_admin = $2 WHERE id = $3", [targetRole, targetRole === "admin" ? 1 : 0, userId]);
  return getUserById(userId);
}

// Affecte un utilisateur à une organisation.
export async function updateUserOrganization(userId, organizationId) {
  await pool().query("UPDATE users SET organization_id = $1 WHERE id = $2", [organizationId ?? null, userId]);
  return getUserById(userId);
}

// --- Appartenance N:N utilisateur ⇄ organisations (v0.9.49) ----------------
export async function listUserOrganizations(userId) {
  const res = await pool().query("SELECT organization_id FROM user_organizations WHERE user_id = $1 ORDER BY organization_id", [userId]);
  return res.rows.map((r) => r.organization_id);
}

// Remplace les organisations d'un utilisateur (admin). Garde : au moins une.
export async function setUserOrganizations(userId, organizationIds) {
  const ids = [...new Set((organizationIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) throw new Error("un utilisateur doit appartenir à au moins une organisation");
  await pool().query("DELETE FROM user_organizations WHERE user_id = $1", [userId]);
  for (const org of ids) {
    await pool().query("INSERT INTO user_organizations (user_id, organization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, org]);
  }
  // Maintient la colonne legacy = 1re org.
  await pool().query("UPDATE users SET organization_id = $1 WHERE id = $2", [ids[0], userId]);
  return listUserOrganizations(userId);
}

// Utilisateurs membres d'une organisation.
export async function listUsersByOrganization(organizationId) {
  const res = await pool().query(
    `SELECT u.id, u.username, u.role, u.is_admin, u.notify_email, u.created_at
     FROM users u JOIN user_organizations uo ON uo.user_id = u.id
     WHERE uo.organization_id = $1 ORDER BY u.id`, [organizationId],
  );
  return res.rows.map((r) => ({ ...r, role: normalizeRole(r), organizationId, notifyEmail: r.notify_email ?? null }));
}

// --- Accès par PROJET (v0.9.52) : N:N utilisateur ⇄ projet ------------------
export async function listUserProjects(userId) {
  const res = await pool().query("SELECT project_id FROM user_projects WHERE user_id = $1 ORDER BY project_id", [userId]);
  return res.rows.map((r) => r.project_id);
}

// Remplace les projets accessibles à un utilisateur (aucun par défaut, 0..N).
export async function setUserProjects(userId, projectIds) {
  const ids = [...new Set((projectIds || []).map((x) => String(x).trim()).filter(Boolean))];
  await pool().query("DELETE FROM user_projects WHERE user_id = $1", [userId]);
  for (const pid of ids) {
    await pool().query("INSERT INTO user_projects (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, pid]);
  }
  return listUserProjects(userId);
}

export async function listUsersByProject(projectId) {
  const res = await pool().query(
    `SELECT u.id, u.username, u.role, u.is_admin, u.created_at
     FROM users u JOIN user_projects up ON up.user_id = u.id
     WHERE up.project_id = $1 ORDER BY u.id`, [projectId],
  );
  return res.rows.map((r) => ({ ...r, role: normalizeRole(r), projectId }));
}

export async function updatePassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  await pool().query("UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3", [hash, salt, userId]);
}

// Email de NOTIFICATION d'un utilisateur (v0.9.65) : destinataire des emails du
// daemon opencode-notifier. Vide → repli sur NOTIFY_RECIPIENTS global.
export async function setUserNotifyEmail(userId, email) {
  const value = email && String(email).trim() ? String(email).trim() : null;
  await pool().query("UPDATE users SET notify_email = $1 WHERE id = $2", [value, userId]);
  return getUserById(userId);
}

export async function deleteUser(userId) {
  await pool().query("DELETE FROM users WHERE id = $1", [userId]);
}

// --- Instance opencode dédiée par utilisateur (v0.9.57) --------------------
// Chaque utilisateur a son propre `opencode web` (port + mot de passe) avec des
// données de sessions ISOLÉES (XDG_DATA_HOME) et la config partagée.
export async function getUserOpencode(userId) {
  const r = (await pool().query("SELECT id, username, opencode_port, opencode_password FROM users WHERE id = $1", [userId])).rows[0];
  if (!r) return null;
  return { id: r.id, username: r.username, port: r.opencode_port ?? null, password: r.opencode_password ?? null };
}

export async function setUserOpencode(userId, { port, password }) {
  await pool().query("UPDATE users SET opencode_port = $1, opencode_password = $2 WHERE id = $3", [port ?? null, password ?? null, userId]);
  return getUserOpencode(userId);
}

// Liste (port, mot de passe) par utilisateur — pour provisionner/route.
export async function listUsersOpencode() {
  const res = await pool().query("SELECT id, username, opencode_port, opencode_password FROM users ORDER BY id");
  return res.rows.map((r) => ({ id: r.id, username: r.username, port: r.opencode_port ?? null, password: r.opencode_password ?? null }));
}

// --- Sessions --------------------------------------------------------------
export async function createSession(userId, activeOrganizationId = null) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_H * 3600 * 1000).toISOString();
  await pool().query("INSERT INTO sessions (token, user_id, expires_at, active_organization_id) VALUES ($1,$2,$3,$4)", [token, userId, expiresAt, activeOrganizationId]);
  return { token, expiresAt };
}

export async function getSession(token) {
  const res = await pool().query("SELECT * FROM sessions WHERE token = $1", [token]);
  return res.rows[0] || null;
}

// Change l'organisation ACTIVE de la session courante (isolation serveur).
export async function setSessionOrganization(token, organizationId) {
  await pool().query("UPDATE sessions SET active_organization_id = $1 WHERE token = $2", [organizationId ?? null, token]);
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
