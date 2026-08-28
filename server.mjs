// server.mjs — Panneau web de supervision de l'orchestrateur.
// - Lecture SEULE du registre de tâches (registry.db en readonly).
// - Authentification par formulaire (session cookie) + gestion d'utilisateurs.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, dirname, extname, normalize, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { openDb, getUserByUsername, verifyPassword, createUser, listUsers, updatePassword, deleteUser, createSession, deleteSession, pruneSessions, listArchives, archivedTaskIds, archiveTask, restoreTask, getArchive, removeArchive } from "./panel-db.mjs";
import { currentUser, sessionToken, cookieHeader, clearCookieHeader } from "./auth.mjs";
import { scanEcosystem } from "./ecosystem.mjs";
import { loadEnv } from "./env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
// Charge le .env global (~/.config/opencode/.env) AVANT de résoudre REGISTRY_DB,
// afin que TASK_REGISTRY_DB (chemin de la base partagée) soit pris en compte.
loadEnv();
const REGISTRY_DB = process.env.TASK_REGISTRY_DB || join(homedir(), ".config", "opencode", "task-registry", "registry.db");
const REFRESH_S = Math.max(10, Number(process.env.PANEL_REFRESH_S) || 10); // intervalle de rafraîchissement par défaut (min 10 s)
const SESSION_BASE_URL = process.env.SESSION_BASE_URL || "https://dev.madatalk.fr"; // base des liens de session opencode

openDb(); // init panel.db + bootstrap admin

// --- helpers HTTP ----------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8", ".zip": "application/zip" };

const PUBLIC_EXT = [".css", ".js", ".svg", ".ico", ".png", ".woff", ".woff2", ".map"];
function isPublicAsset(path) {
  return PUBLIC_EXT.some((e) => path.toLowerCase().endsWith(e));
}

function serveFile(res, rel) {
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
  res.end(readFileSync(file));
}

// --- Registre de tâches (lecture seule) ------------------------------------
let _registry = null;
function registry() {
  if (_registry) return _registry;
  if (existsSync(REGISTRY_DB)) {
    _registry = new Database(REGISTRY_DB, { readonly: true });
  }
  return _registry;
}

function latestStatusSubquery() {
  return "(SELECT status FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1)";
}

// Les tâches archivées (et tout ce qui leur est rattaché) sont masquées des vues.
function isArchivedTaskId(archived, taskId) {
  return !!taskId && archived.has(taskId);
}

function registryStats() {
  const archived = archivedTaskIds();
  const db = registry();
  if (!db) return { tasks: 0, byStatus: {}, worktrees: 0, openDecisions: 0, archived: archived.size };
  const byStatus = {};
  let tasks = 0;
  for (const r of db.prepare(`SELECT t.id, ${latestStatusSubquery()} AS status FROM tasks t`).all()) {
    if (archived.has(r.id)) continue;
    const st = r.status || "queued";
    byStatus[st] = (byStatus[st] || 0) + 1;
    tasks++;
  }
  const worktrees = db.prepare("SELECT task_id FROM worktrees").all().filter((w) => !isArchivedTaskId(archived, w.task_id)).length;
  const openDecisions = db.prepare("SELECT task_id FROM decisions WHERE status = 'awaiting'").all().filter((d) => !isArchivedTaskId(archived, d.task_id)).length;
  return { tasks, byStatus, worktrees, openDecisions, archived: archived.size };
}

function registryTasks(url) {
  const db = registry();
  if (!db) return { tasks: [] };
  const archived = archivedTaskIds();
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  let rows = db.prepare(
    `SELECT t.id, t.project, t.type, t.priority, t.request, t.created_at, t.session_id,
       ${latestStatusSubquery()} AS status,
       (SELECT attempt FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS attempt,
       (SELECT rework_count FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS rework_count
     FROM tasks t ORDER BY t.created_at DESC`,
  ).all();
  rows = rows.filter((r) => !archived.has(r.id));
  if (project) rows = rows.filter((r) => r.project === project);
  if (status) rows = rows.filter((r) => (r.status || "queued") === status);
  return { tasks: rows };
}

function registryTaskDetail(id) {
  const db = registry();
  if (!db) return { error: "registre vide" };
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return { error: "tâche inconnue" };
  const executions = db.prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY attempt DESC").all(id);
  const worktree = db.prepare("SELECT * FROM worktrees WHERE task_id = ?").all(id);
  const events = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 200").all(id);
  const deployments = db.prepare("SELECT * FROM deployments WHERE task_id = ? ORDER BY rowid DESC").all(id);
  const decisions = db.prepare("SELECT * FROM decisions WHERE task_id = ? ORDER BY rowid DESC").all(id);
  const artifacts = db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY rowid DESC").all(id);
  return { task, executions, worktree, events, deployments, decisions, artifacts, archived: archivedTaskIds().has(id) };
}

// Compte les éléments rattachés à une tâche (aperçu avant archivage + snapshot).
function snapshotForTask(db, taskId) {
  return {
    executions: db.prepare("SELECT COUNT(*) AS n FROM executions WHERE task_id = ?").get(taskId).n,
    events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(taskId).n,
    worktrees: db.prepare("SELECT COUNT(*) AS n FROM worktrees WHERE task_id = ?").get(taskId).n,
    deployments: db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE task_id = ?").get(taskId).n,
    decisions: db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE task_id = ?").get(taskId).n,
    artifacts: db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ?").get(taskId).n,
    plans: hasTable(db, "plans") ? db.prepare("SELECT COUNT(*) AS n FROM plans WHERE task_id = ?").get(taskId).n : 0,
  };
}

function registryWorktrees(url) {
  const db = registry();
  if (!db) return { worktrees: [] };
  const archived = archivedTaskIds();
  const project = url.searchParams.get("project");
  const taskId = url.searchParams.get("taskId");
  let rows = db.prepare("SELECT * FROM worktrees ORDER BY status, project").all();
  rows = rows.filter((w) => !isArchivedTaskId(archived, w.task_id));
  if (project) rows = rows.filter((r) => r.project === project);
  if (taskId) rows = rows.filter((r) => r.task_id === taskId);
  const now = Date.now();
  rows = rows.map((w) => ({ ...w, leaseExpired: ["RESERVED", "IN_USE"].includes(w.status) && w.lease_until && new Date(w.lease_until).getTime() < now }));
  return { worktrees: rows };
}

function registryEvents(url) {
  const db = registry();
  if (!db) return { events: [] };
  const archived = archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const limit = Number(url.searchParams.get("limit") || 200);
  const rows = taskId
    ? db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?").all(taskId, limit)
    : db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit);
  return { events: rows.filter((e) => !isArchivedTaskId(archived, e.task_id)) };
}

function registryDeployments(url) {
  const db = registry();
  if (!db) return { deployments: [] };
  const archived = archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const rows = taskId
    ? db.prepare("SELECT * FROM deployments WHERE task_id = ? ORDER BY rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM deployments ORDER BY rowid DESC LIMIT 200").all();
  return { deployments: rows.filter((d) => !isArchivedTaskId(archived, d.task_id)) };
}

function registryDecisions(url) {
  const db = registry();
  if (!db) return { decisions: [] };
  const archived = archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const rows = taskId
    ? db.prepare("SELECT * FROM decisions WHERE task_id = ? ORDER BY rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM decisions ORDER BY rowid DESC LIMIT 200").all();
  return { decisions: rows.filter((d) => !isArchivedTaskId(archived, d.task_id)) };
}

function registryArtifacts(url) {
  const db = registry();
  if (!db) return { artifacts: [] };
  const archived = archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const rows = taskId
    ? db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM artifacts ORDER BY rowid DESC LIMIT 500").all();
  return { artifacts: rows.filter((a) => !isArchivedTaskId(archived, a.task_id)) };
}

// --- Plans (lecture seule, onglet « Plans ») -------------------------------
// Garde : la table `plans` peut ne pas exister encore si le panel (readonly)
// est le premier à ouvrir registry.db, avant que plan-manager ne la crée.
function hasTable(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", name);
}

function registryPlans(url) {
  const db = registry();
  if (!db) return { plans: [] };
  if (!hasTable(db, "plans")) return { plans: [] };
  const archived = archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const rows = db.prepare("SELECT id, task_id, objective, deliverables, status, created_at FROM plans ORDER BY created_at DESC").all();
  const stepStmt = db.prepare("SELECT step_id, status FROM plan_steps WHERE plan_id = ?");
  const plans = rows
    .filter((p) => !isArchivedTaskId(archived, p.task_id))
    .filter((p) => !taskId || p.task_id === taskId)
    .map((p) => {
      const steps = stepStmt.all(p.id);
      const total = steps.length;
      const done = steps.filter((s) => s.status === "done").length;
      const skipped = steps.filter((s) => s.status === "skipped").length;
      const pct = total === 0 ? 0 : Math.round(((done + skipped) / total) * 100);
      return {
        planId: p.id,
        task_id: p.task_id,
        objective: p.objective,
        status: p.status,
        pct,
        deliverables: p.deliverables ? JSON.parse(p.deliverables) : [],
        created_at: p.created_at,
      };
    });
  return { plans };
}

function downloadArtifact(res, taskId, artifactId) {
  const db = registry();
  const notFound = () => { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Document introuvable"); };
  if (!db) return notFound();
  const a = db.prepare("SELECT * FROM artifacts WHERE artifact_id = ? AND task_id = ?").get(artifactId, taskId);
  if (!a || !a.path) return notFound();
  if (!existsSync(a.path) || statSync(a.path).isDirectory()) return notFound();
  const filename = basename(a.path);
  const ct = MIME[extname(a.path).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": ct,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  createReadStream(a.path).pipe(res);
}

// --- Archivage / restauration (niveau panneau) -----------------------------
// L'archivage masque une tâche ET tout ce qui lui est rattaché (événements,
// documents, worktrees, déploiements, décisions, exécutions) de toutes les
// vues. Le registre registry.db reste en lecture seule : on stocke l'état
// d'archive dans panel.db et on filtre à l'affichage.

function registryArchives() {
  const db = registry();
  const archives = listArchives().map((a) => {
    const task = db ? db.prepare("SELECT project, type, priority, request, created_at FROM tasks WHERE id = ?").get(a.task_id) : null;
    return { task_id: a.task_id, archived_at: a.archived_at, archived_by: a.archived_by, snapshot: a.snapshot, task };
  });
  return { archives };
}

function archivePreview(res, taskId) {
  const db = registry();
  if (!db) return sendJson(res, 404, { error: "registre vide" });
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return sendJson(res, 404, { error: "tâche inconnue" });
  return sendJson(res, 200, { taskId, snapshot: snapshotForTask(db, taskId) });
}

async function handleArchive(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const db = registry();
  if (!db) return sendJson(res, 404, { error: "registre vide" });
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return sendJson(res, 404, { error: "tâche inconnue" });
  const snapshot = snapshotForTask(db, taskId);
  const a = archiveTask(taskId, user.username, snapshot);
  return sendJson(res, 200, { ok: true, taskId, snapshot, archived_at: a.archived_at, archived_by: a.archived_by });
}

async function handleRestore(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const a = restoreTask(taskId);
  if (!a) return sendJson(res, 404, { error: "tâche non archivée" });
  return sendJson(res, 200, { ok: true, taskId, snapshot: a.snapshot });
}

// Suppression DEFINITIVE d'une tâche (et de tout ce qui lui est rattaché).
// Contrairement à l'archivage (soft-hide), on écrit réellement dans registry.db.
function deleteTaskPermanently(taskId) {
  if (!existsSync(REGISTRY_DB)) return null;
  const db = new Database(REGISTRY_DB);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  try {
    return db.transaction(() => {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      if (!task) return null;
      const snapshot = snapshotForTask(db, taskId);
      // Suppression EXPLICITE de tous les éléments rattachés (défense en
      // profondeur) : certaines tables (events, worktrees) peuvent avoir été
      // créées sans contrainte FK ON DELETE CASCADE dans des registres existants.
      db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM executions WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM deployments WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM decisions WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM worktrees WHERE task_id = ?").run(taskId);
      // Purge des plans rattachés (défense en profondeur : la FK plans.task_id
      // → tasks(id) ON DELETE CASCADE couvre déjà le cas, mais les tables
      // enfants plan_steps/incidents/inconsistencies sont supprimées
      // explicitement pour rester robuste aux anciens schémas).
      if (hasTable(db, "plans")) {
        db.prepare("DELETE FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
        db.prepare("DELETE FROM plan_incidents WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
        db.prepare("DELETE FROM plan_inconsistencies WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
        db.prepare("DELETE FROM plans WHERE task_id = ?").run(taskId);
      }
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      return { task, snapshot };
    })();
  } finally {
    db.close();
  }
}

async function handleDelete(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const archive = getArchive(taskId);
  if (!archive) return sendJson(res, 409, { error: "tâche non archivée : archiver avant de supprimer" });
  const result = deleteTaskPermanently(taskId);
  removeArchive(taskId);
  if (!result) return sendJson(res, 200, { ok: true, taskId, note: "tâche absente du registre (archive nettoyée)" });
  return sendJson(res, 200, { ok: true, taskId, snapshot: result.snapshot });
}

// --- Auth / utilisateurs ---------------------------------------------------
async function handleLogin(req, res) {
  const { username, password } = await readBody(req);
  if (!username || !password) return sendJson(res, 400, { error: "username et password requis" });
  const u = getUserByUsername(String(username));
  if (!u || !verifyPassword(String(password), u.salt, u.password_hash)) {
    return sendJson(res, 401, { error: "identifiants invalides" });
  }
  const s = createSession(u.id);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": cookieHeader(s.token) });
  res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin } }));
}

function handleLogout(req, res) {
  const token = sessionToken(req);
  if (token) deleteSession(token);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": clearCookieHeader() });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUsers(req, res, user) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  if (req.method === "GET") return sendJson(res, 200, { users: listUsers() });
  if (req.method === "POST") {
    const { username, password, isAdmin } = await readBody(req);
    if (!username || !password) return sendJson(res, 400, { error: "username et password requis" });
    try {
      const u = createUser(String(username), String(password), !!isAdmin);
      return sendJson(res, 201, { ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin } });
    } catch (e) {
      return sendJson(res, 409, { error: "nom d'utilisateur déjà pris" });
    }
  }
  return sendJson(res, 405, { error: "méthode non autorisée" });
}

async function handleUserAction(req, res, user, path) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const parts = path.split("/").filter(Boolean); // ["api","users","<id>","password"]
  const id = Number(parts[2]);
  if (req.method === "DELETE") {
    deleteUser(id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && parts[3] === "password") {
    const { password } = await readBody(req);
    if (!password) return sendJson(res, 400, { error: "password requis" });
    updatePassword(id, String(password));
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: "méthode non autorisée" });
}

// --- Router ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    pruneSessions();

    if (path === "/healthz") return sendJson(res, 200, { ok: true, registry: existsSync(REGISTRY_DB) });

    // Page de login (publique)
    if (path === "/login" && req.method === "GET") return serveFile(res, "login.html");
    if (path === "/api/login" && req.method === "POST") return handleLogin(req, res);

    // Assets statiques publics (css/js/ico...) — requis pour le rendu de la page de login
    if (isPublicAsset(path)) return serveFile(res, path.slice(1));

    const user = currentUser(req);
    if (path === "/api/logout" && req.method === "POST") return handleLogout(req, res);

    if (!user) {
      if (path.startsWith("/api/")) return sendJson(res, 401, { error: "non authentifié" });
      return redirect(res, "/login");
    }

    if (path === "/api/me") return sendJson(res, 200, { user });
    if (path === "/api/ecosystem") return sendJson(res, 200, scanEcosystem());
    if (path === "/api/config") return sendJson(res, 200, { refreshSeconds: REFRESH_S, sessionBaseUrl: SESSION_BASE_URL });
    if (path === "/api/stats") return sendJson(res, 200, registryStats());
    if (path === "/api/artifacts") return sendJson(res, 200, registryArtifacts(url));
    const artDownload = path.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/download$/);
    if (artDownload) return downloadArtifact(res, artDownload[1], artDownload[2]);
    if (path === "/api/archives") return sendJson(res, 200, registryArchives());
    if (path === "/api/tasks") return sendJson(res, 200, registryTasks(url));
    if (path.startsWith("/api/tasks/")) {
      const taskId = path.split("/")[3];
      if (!taskId) return sendJson(res, 400, { error: "taskId manquant" });
      if (path.endsWith("/archive-preview") && req.method === "GET") return archivePreview(res, taskId);
      if (path.endsWith("/archive") && req.method === "POST") return handleArchive(req, res, user, taskId);
      if (path.endsWith("/restore") && req.method === "POST") return handleRestore(req, res, user, taskId);
      if (path.endsWith("/delete") && req.method === "POST") return handleDelete(req, res, user, taskId);
      if (path.endsWith("/plans") && req.method === "GET") {
        const u = new URL("http://localhost/api/plans");
        u.searchParams.set("taskId", taskId);
        return sendJson(res, 200, registryPlans(u));
      }
      return sendJson(res, 200, registryTaskDetail(taskId));
    }
    if (path === "/api/worktrees") return sendJson(res, 200, registryWorktrees(url));
    if (path === "/api/events") return sendJson(res, 200, registryEvents(url));
    if (path === "/api/deployments") return sendJson(res, 200, registryDeployments(url));
    if (path === "/api/decisions") return sendJson(res, 200, registryDecisions(url));
    if (path === "/api/plans") return sendJson(res, 200, registryPlans(url));
    if (path === "/api/users") return handleUsers(req, res, user);
    if (path.startsWith("/api/users/")) return handleUserAction(req, res, user, path);

    if (path === "/") return serveFile(res, "index.html");
    return serveFile(res, path.slice(1));
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[orchestrator-panel] écoute sur http://${HOST}:${PORT}`);
});
