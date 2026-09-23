// panel-db.mjs — Base d'authentification du panneau (users + sessions + archives),
// SÉPARÉE du registre de tâches. PostgreSQL (base `panel`).
import pg from "pg";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
// Chiffrement AES-256-GCM des clés fournisseurs LLM — module partagé (même
// crypto que les secrets E2E ; ne JAMAIS le dupliquer).
import { encryptSecret, decryptSecret } from "/root/.config/opencode/mcp/task-orchestrator/secret-crypto.mjs";

const { Pool } = pg;
const SESSION_TTL_H = Number(process.env.PANEL_SESSION_TTL_H || 24);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'executeur',
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
-- Audit de la migration du rôle 'user' (ADR-002, doc 16) : trace RÉVERSIBLE et
-- IDEMPOTENTE des comptes migrés vers 'executeur' (ou un autre rôle cible).
-- Aucune migration automatique : alimentée par scripts/migrate-user-role.mjs.
CREATE TABLE IF NOT EXISTS user_role_migrations (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  username    TEXT NOT NULL,
  from_role   TEXT NOT NULL,
  to_role     TEXT NOT NULL,
  rule        TEXT,
  migrated_at TEXT NOT NULL,
  migrated_by TEXT,
  reverted_at TEXT,
  reverted_by TEXT
);
-- Fournisseurs LLM & clés API (v0.9.75) : N clés par fournisseur, UNE seule
-- ACTIVE par fournisseur (index unique partiel). Les clés sont chiffrées
-- AES-256-GCM (secret-crypto) : la valeur en clair n'est JAMAIS stockée ni
-- retournée par l'API (seul un fingerprint non réversible est exposé).
CREATE TABLE IF NOT EXISTS provider_keys (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider   TEXT NOT NULL,
  label      TEXT,
  key_enc    TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_active_uniq ON provider_keys(provider) WHERE is_active = 1;
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
      // aux tables existantes puis porte is_admin=1 → role='admin'. Défaut
      // 'executeur' depuis la suppression du rôle 'user' (ADR-002, doc 16).
      await pool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'executeur'");
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

// Rôles valides du panneau (ADR-002, doc 16) : 'admin' > 'supervisor' >
// 'evaluateur' > 'executeur'. Le rôle 'user' est SUPPRIMÉ (migration vers
// 'executeur' — cf. migrateUserRole).
const ROLES = ["admin", "supervisor", "evaluateur", "executeur"];

// Rôle effectif : 'admin' > 'supervisor' > 'evaluateur' > 'executeur'
// (is_admin rétrocompat supercede). FAIL-SAFE : un rôle inconnu — dont l'ancien
// 'user' non migré — est résolu en 'executeur' (jamais 'user').
function normalizeRole(r) {
  if (r.is_admin) return "admin";
  return ROLES.includes(r.role) ? r.role : "executeur";
}

// Crée un utilisateur avec un rôle explicite
// ('admin' | 'supervisor' | 'evaluateur' | 'executeur' ; défaut 'executeur').
export async function createUser(username, password, isAdmin, role, organizationId) {
  const targetRole = isAdmin ? "admin" : (ROLES.includes(role) ? role : "executeur");
  const { salt, hash } = hashPassword(password);
  await pool().query(
    "INSERT INTO users (username, password_hash, salt, is_admin, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [username, hash, salt, targetRole === "admin" ? 1 : 0, targetRole, organizationId || "onirtech", new Date().toISOString()],
  );
  return getUserByUsername(username);
}

export async function updateUserRole(userId, role) {
  const targetRole = ROLES.includes(role) ? role : "executeur";
  await pool().query("UPDATE users SET role = $1, is_admin = $2 WHERE id = $3", [targetRole, targetRole === "admin" ? 1 : 0, userId]);
  return getUserById(userId);
}

// --- Migration du rôle `user` (ADR-002, doc 16) ----------------------------
// Rôles CIBLES valides (jamais `user` : c'est précisément ce qu'on élimine).
const MIGRATION_TARGET_ROLES = ["admin", "supervisor", "evaluateur", "executeur"];

// Migre tous les comptes `role='user'` vers un rôle cible, en TRACE (audit) et
// de façon IDEMPOTENTE : le filtre `WHERE role='user'` garantit qu'une seconde
// exécution ne migre plus rien (aucune double ligne d'audit).
// `rules` : table de correspondance par username (ex. { Ronald: "executeur" }) ;
// tout autre compte `user` reçoit `targetRole` (défaut `executeur`).
// ATTENTION : fonction d'ÉCRITURE — n'est appelée que par le CLI explicite
// (`--apply`) ; JAMAIS au démarrage du serveur.
export async function migrateUserRole({ targetRole = "executeur", rules = { Ronald: "executeur" }, by = "system" } = {}) {
  await ensureReady();
  const fallback = MIGRATION_TARGET_ROLES.includes(targetRole) ? targetRole : "executeur";
  const ruleMap = new Map(Object.entries(rules || {}).map(([k, v]) => [String(k), String(v)]));
  const client = await pool().connect();
  const applied = [];
  try {
    await client.query("BEGIN");
    const rows = (await client.query("SELECT id, username, role FROM users WHERE role = 'user' ORDER BY id FOR UPDATE")).rows;
    for (const u of rows) {
      const rawTarget = ruleMap.has(u.username) ? ruleMap.get(u.username) : fallback;
      const to = MIGRATION_TARGET_ROLES.includes(rawTarget) ? rawTarget : fallback;
      await client.query("UPDATE users SET role = $1, is_admin = $2 WHERE id = $3", [to, to === "admin" ? 1 : 0, u.id]);
      const ins = await client.query(
        `INSERT INTO user_role_migrations (user_id, username, from_role, to_role, rule, migrated_at, migrated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.id, u.username, u.role, to, ruleMap.has(u.username) ? "explicit" : "default", new Date().toISOString(), by],
      );
      applied.push(ins.rows[0]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return applied;
}

// Annule une (ou toutes les) migration(s) non encore annulée(s) : restaure le
// rôle d'origine (`from_role`) et pose `reverted_at`/`reverted_by` (audit conservé,
// jamais supprimé). Idempotente : une migration déjà annulée est ignorée.
export async function revertUserRoleMigration({ migrationIds = null, all = false, by = "system" } = {}) {
  await ensureReady();
  const client = await pool().connect();
  const reverted = [];
  try {
    await client.query("BEGIN");
    let rows;
    if (all) {
      rows = (await client.query("SELECT * FROM user_role_migrations WHERE reverted_at IS NULL ORDER BY id FOR UPDATE")).rows;
    } else {
      const ids = (migrationIds || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
      if (!ids.length) { await client.query("COMMIT"); return []; }
      rows = (await client.query("SELECT * FROM user_role_migrations WHERE id = ANY($1) AND reverted_at IS NULL ORDER BY id FOR UPDATE", [ids])).rows;
    }
    for (const m of rows) {
      await client.query("UPDATE users SET role = $1, is_admin = $2 WHERE id = $3", [m.from_role, m.from_role === "admin" ? 1 : 0, m.user_id]);
      const upd = await client.query("UPDATE user_role_migrations SET reverted_at = $1, reverted_by = $2 WHERE id = $3 RETURNING *", [new Date().toISOString(), by, m.id]);
      reverted.push(upd.rows[0]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return reverted;
}

// Lecture de l'audit de migration (tri du plus récent au plus ancien).
export async function listUserRoleMigrations() {
  await ensureReady();
  const res = await pool().query("SELECT * FROM user_role_migrations ORDER BY migrated_at DESC, id DESC");
  return res.rows;
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

// --- Fournisseurs LLM : clés API chiffrées (v0.9.75) -----------------------
// Source de vérité des identifiants fournisseurs (deepinfra/deepseek/opencode-go…).
// UNE clé ACTIVE par fournisseur (contrainte base : index unique partiel
// `provider_keys_active_uniq`). La clé en clair n'est JAMAIS retournée :
// `listProviderKeys` n'expose qu'un `fingerprint` (sha256 tronqué du CHIFFRÉ,
// non réversible) ; le déchiffrement (`getActiveProviderKeys`) n'est utilisé que
// pour GÉNÉRER l'auth.json des instances (provider-auth.mjs).

function fingerprintOf(keyEnc) {
  return createHash("sha256").update(String(keyEnc)).digest("hex").slice(0, 12);
}

// Liste SANS secret : jamais `key_enc`, jamais la clé en clair.
export async function listProviderKeys() {
  await ensureReady();
  const res = await pool().query(
    "SELECT id, provider, label, is_active, key_enc, created_at, updated_at FROM provider_keys ORDER BY provider, is_active DESC, id",
  );
  return res.rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label ?? null,
    isActive: r.is_active === 1,
    hasKey: true,
    fingerprint: fingerprintOf(r.key_enc),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// Clés ACTIVES déchiffrées — usage INTERNE (génération auth.json), JAMAIS exposé
// tel quel par l'API.
export async function getActiveProviderKeys() {
  await ensureReady();
  const res = await pool().query("SELECT provider, key_enc FROM provider_keys WHERE is_active = 1 ORDER BY provider");
  return res.rows.map((r) => ({ provider: r.provider, key: decryptSecret(r.key_enc) }));
}

// Ajoute une clé (chiffrée AES-256-GCM). La clé est ACTIVE automatiquement si
// c'est la PREMIÈRE du fournisseur (un fournisseur a toujours ≥ 1 clé active).
export async function addProviderKey({ provider, label = null, key }) {
  await ensureReady();
  const prov = String(provider || "").trim();
  const plain = String(key || "").trim();
  if (!prov) throw new Error("provider requis");
  if (!plain) throw new Error("clé requise");
  const enc = encryptSecret(plain);
  const now = new Date().toISOString();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const cnt = await client.query("SELECT count(*)::int AS n FROM provider_keys WHERE provider = $1", [prov]);
    const isFirst = cnt.rows[0].n === 0;
    const ins = await client.query(
      `INSERT INTO provider_keys (provider, label, key_enc, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, provider, label, is_active, created_at, updated_at`,
      [prov, label ? String(label) : null, enc, isFirst ? 1 : 0, now],
    );
    await client.query("COMMIT");
    const r = ins.rows[0];
    return { id: r.id, provider: r.provider, label: r.label ?? null, isActive: r.is_active === 1, hasKey: true, createdAt: r.created_at, updatedAt: r.updated_at };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Désigne la clé ACTIVE d'un fournisseur : désactive les autres du MÊME
// fournisseur puis active celle-ci — transaction atomique (respecte l'unicité).
export async function setActiveProviderKey(id) {
  await ensureReady();
  const client = await pool().connect();
  let provider = null;
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT id, provider FROM provider_keys WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!row) throw new Error("clé inconnue");
    provider = row.provider;
    const now = new Date().toISOString();
    await client.query("UPDATE provider_keys SET is_active = 0, updated_at = $1 WHERE provider = $2 AND is_active = 1", [now, provider]);
    await client.query("UPDATE provider_keys SET is_active = 1, updated_at = $1 WHERE id = $2", [now, id]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
  return { id, provider };
}

// Supprime une clé. GARDE : refuse de supprimer la DERNIÈRE clé d'un
// fournisseur (un fournisseur garde toujours une clé). Si la clé supprimée était
// ACTIVE, ré-active une autre clé du même fournisseur.
export async function deleteProviderKey(id) {
  await ensureReady();
  const client = await pool().connect();
  let deleted = null;
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT id, provider, is_active FROM provider_keys WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!row) throw new Error("clé inconnue");
    const cnt = (await client.query("SELECT count(*)::int AS n FROM provider_keys WHERE provider = $1", [row.provider])).rows[0].n;
    if (cnt <= 1) throw new Error("impossible de supprimer la dernière clé d'un fournisseur");
    await client.query("DELETE FROM provider_keys WHERE id = $1", [id]);
    deleted = { id, provider: row.provider, wasActive: row.is_active === 1 };
    if (row.is_active === 1) {
      const next = (await client.query("SELECT id FROM provider_keys WHERE provider = $1 ORDER BY updated_at DESC, id DESC LIMIT 1", [row.provider])).rows[0];
      if (next) await client.query("UPDATE provider_keys SET is_active = 1, updated_at = $1 WHERE id = $2", [new Date().toISOString(), next.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
  return deleted;
}
