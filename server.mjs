// server.mjs — Panneau web de supervision de l'orchestrateur.
// - Lecture SEULE du registre de tâches (PostgreSQL `task_registry`).
// - Authentification par formulaire (session cookie) + gestion d'utilisateurs.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, dirname, extname, normalize, basename } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { openDb, getUserByUsername, verifyPassword, createUser, listUsers, updatePassword, deleteUser, createSession, deleteSession, pruneSessions, listArchives, archivedTaskIds, archiveTask, restoreTask, getArchive, removeArchive } from "./panel-db.mjs";
import { currentUser, sessionToken, cookieHeader, clearCookieHeader } from "./auth.mjs";
import { scanEcosystem } from "./ecosystem.mjs";
import { loadEnv } from "./env.mjs";
import * as pilot from "./pilot.mjs";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
loadEnv();
const DATABASE_URL = process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const REFRESH_S = Math.max(10, Number(process.env.PANEL_REFRESH_S) || 10);
const SESSION_BASE_URL = process.env.SESSION_BASE_URL || "https://dev.madatalk.fr";

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

// --- Registre de tâches (lecture seule PostgreSQL) --------------------------
let _registryPool = null;
function registry() {
  if (_registryPool) return _registryPool;
  _registryPool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return _registryPool;
}

function latestStatusSubquery() {
  return "(SELECT status FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1)";
}

async function registryStats() {
  const archived = await archivedTaskIds();
  const db = registry();
  const byStatus = {};
  let tasks = 0;
  let openDecisions = 0;
  try {
    const res = await db.query(`SELECT t.id, ${latestStatusSubquery()} AS status FROM tasks t`);
    for (const r of res.rows) {
      if (archived.has(r.id)) continue;
      const st = r.status || "queued";
      byStatus[st] = (byStatus[st] || 0) + 1;
      tasks++;
    }
    const decRes = await db.query("SELECT task_id FROM decisions WHERE status = 'awaiting'");
    openDecisions = decRes.rows.filter((d) => !archived.has(d.task_id)).length;
  } catch {
    /* registre indisponible */
  }
  return { tasks, byStatus, openDecisions, archived: archived.size };
}

async function registryTasks(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  let rows = [];
  try {
    const res = await db.query(
      `SELECT t.id, t.project, t.type, t.priority, t.request, t.created_at, t.session_id, t.recette_status,
         ${latestStatusSubquery()} AS status,
         (SELECT attempt FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS attempt,
         (SELECT rework_count FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS rework_count
       FROM tasks t ORDER BY t.created_at DESC`,
    );
    rows = res.rows.filter((r) => !archived.has(r.id));
  } catch {
    rows = [];
  }
  if (project) rows = rows.filter((r) => r.project === project);
  if (status) rows = rows.filter((r) => (r.status || "queued") === status);
  return { tasks: rows };
}

async function registryTaskDetail(id) {
  const db = registry();
  const task = (await db.query("SELECT * FROM tasks WHERE id = $1", [id]).catch(() => ({ rows: [] }))).rows[0];
  if (!task) return { error: "tâche inconnue" };
  const q = async (sql, params = []) => (await db.query(sql, params).catch(() => ({ rows: [] }))).rows;
  const executions = await q("SELECT * FROM executions WHERE task_id = $1 ORDER BY attempt DESC", [id]);
  const events = await q("SELECT * FROM events WHERE task_id = $1 ORDER BY seq DESC LIMIT 200", [id]);
  const deployments = await q("SELECT * FROM deployments WHERE task_id = $1 ORDER BY id DESC", [id]);
  const decisions = await q("SELECT * FROM decisions WHERE task_id = $1 ORDER BY id DESC", [id]);
  const artifacts = await q("SELECT * FROM artifacts WHERE task_id = $1 ORDER BY id DESC", [id]);
  return { task, executions, events, deployments, decisions, artifacts, archived: (await archivedTaskIds()).has(id) };
}

async function snapshotForTask(taskId) {
  const db = registry();
  const cnt = async (sql) => {
    const res = await db.query(sql, [taskId]).catch(() => ({ rows: [{ n: 0 }] }));
    return Number(res.rows[0].n);
  };
  const plans = async () => {
    try {
      const res = await db.query("SELECT COUNT(*) AS n FROM plans WHERE task_id = $1", [taskId]);
      return Number(res.rows[0].n);
    } catch { return 0; }
  };
  return {
    executions: await cnt("SELECT COUNT(*) AS n FROM executions WHERE task_id = $1"),
    events: await cnt("SELECT COUNT(*) AS n FROM events WHERE task_id = $1"),
    deployments: await cnt("SELECT COUNT(*) AS n FROM deployments WHERE task_id = $1"),
    decisions: await cnt("SELECT COUNT(*) AS n FROM decisions WHERE task_id = $1"),
    artifacts: await cnt("SELECT COUNT(*) AS n FROM artifacts WHERE task_id = $1"),
    plans: await plans(),
  };
}

async function registryEvents(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const limit = Number(url.searchParams.get("limit") || 200);
  let rows = [];
  try {
    const res = taskId
      ? await db.query("SELECT * FROM events WHERE task_id = $1 ORDER BY seq DESC LIMIT $2", [taskId, limit])
      : await db.query("SELECT * FROM events ORDER BY seq DESC LIMIT $1", [limit]);
    rows = res.rows;
  } catch { rows = []; }
  return { events: rows.filter((e) => !archived.has(e.task_id)) };
}

async function registryDeployments(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  let rows = [];
  try {
    const res = taskId
      ? await db.query("SELECT * FROM deployments WHERE task_id = $1 ORDER BY id DESC", [taskId])
      : await db.query("SELECT * FROM deployments ORDER BY id DESC LIMIT 200");
    rows = res.rows;
  } catch { rows = []; }
  return { deployments: rows.filter((d) => !archived.has(d.task_id)) };
}

async function registryDecisions(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  let rows = [];
  try {
    const res = taskId
      ? await db.query("SELECT * FROM decisions WHERE task_id = $1 ORDER BY id DESC", [taskId])
      : await db.query("SELECT * FROM decisions ORDER BY id DESC LIMIT 200");
    rows = res.rows;
  } catch { rows = []; }
  return { decisions: rows.filter((d) => !archived.has(d.task_id)) };
}

async function registryArtifacts(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  let rows = [];
  try {
    const res = taskId
      ? await db.query("SELECT * FROM artifacts WHERE task_id = $1 ORDER BY id DESC", [taskId])
      : await db.query("SELECT * FROM artifacts ORDER BY id DESC LIMIT 500");
    rows = res.rows;
  } catch { rows = []; }
  return { artifacts: rows.filter((a) => !archived.has(a.task_id)) };
}

async function registryPlans(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  let rows = [];
  try {
    const res = await db.query(
      `SELECT p.id, p.task_id, p.objective, p.deliverables, p.status, p.branch, p.created_at,
              (SELECT pe.status FROM plan_executions pe WHERE pe.plan_id = p.id ORDER BY pe.id DESC LIMIT 1) AS execution_status
       FROM plans p ORDER BY p.created_at DESC`,
    );
    rows = res.rows;
  } catch { rows = []; }
  let stepStmt = async (planId) => (await db.query("SELECT step_id, status FROM plan_steps WHERE plan_id = $1", [planId]).catch(() => ({ rows: [] }))).rows;
  const plans = [];
  for (const p of rows.filter((p) => !archived.has(p.task_id) && (!taskId || p.task_id === taskId))) {
    let steps = [];
    try { steps = await stepStmt(p.id); } catch { steps = []; }
    const total = steps.length;
    const done = steps.filter((s) => s.status === "done").length;
    const skipped = steps.filter((s) => s.status === "skipped").length;
    const pct = total === 0 ? 0 : Math.round(((done + skipped) / total) * 100);
    plans.push({
      planId: p.id,
      task_id: p.task_id,
      objective: p.objective,
      status: p.status,
      execution_status: p.execution_status || null,
      branch: p.branch,
      pct,
      deliverables: p.deliverables ? JSON.parse(p.deliverables) : [],
      created_at: p.created_at,
    });
  }
  return { plans };
}

async function downloadArtifact(res, taskId, artifactId) {
  const db = registry();
  const notFound = () => { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Document introuvable"); };
  let a;
  try {
    a = (await db.query("SELECT * FROM artifacts WHERE artifact_id = $1 AND task_id = $2", [artifactId, taskId])).rows[0];
  } catch { return notFound(); }
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

async function registryArchives() {
  const archives = await listArchives();
  const db = registry();
  const out = [];
  for (const a of archives) {
    let task = null;
    try {
      task = (await db.query("SELECT project, type, priority, request, created_at FROM tasks WHERE id = $1", [a.task_id])).rows[0] || null;
    } catch { task = null; }
    out.push({ task_id: a.task_id, archived_at: a.archived_at, archived_by: a.archived_by, snapshot: a.snapshot, task });
  }
  return { archives: out };
}

async function archivePreview(res, taskId) {
  const db = registry();
  const task = (await db.query("SELECT * FROM tasks WHERE id = $1", [taskId]).catch(() => ({ rows: [] }))).rows[0];
  if (!task) return sendJson(res, 404, { error: "tâche inconnue" });
  return sendJson(res, 200, { taskId, snapshot: await snapshotForTask(taskId) });
}

async function handleArchive(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const db = registry();
  const task = (await db.query("SELECT * FROM tasks WHERE id = $1", [taskId]).catch(() => ({ rows: [] }))).rows[0];
  if (!task) return sendJson(res, 404, { error: "tâche inconnue" });
  const snapshot = await snapshotForTask(taskId);
  const a = await archiveTask(taskId, user.username, snapshot);
  return sendJson(res, 200, { ok: true, taskId, snapshot, archived_at: a.archived_at, archived_by: a.archived_by });
}

async function handleRestore(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const a = await restoreTask(taskId);
  if (!a) return sendJson(res, 404, { error: "tâche non archivée" });
  return sendJson(res, 200, { ok: true, taskId, snapshot: a.snapshot });
}

async function handleDelete(req, res, user, taskId) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const archive = await getArchive(taskId);
  if (!archive) return sendJson(res, 409, { error: "tâche non archivée : archiver avant de supprimer" });
  try {
    const r = await pilot.deleteTask(taskId);
    await removeArchive(taskId);
    return sendJson(res, 200, { ok: true, taskId, deleted: !!(r && r.deleted) });
  } catch (e) {
    return sendJson(res, 400, { error: String((e && e.message) || e) });
  }
}

// --- Auth / utilisateurs ---------------------------------------------------
async function handleLogin(req, res) {
  const { username, password } = await readBody(req);
  if (!username || !password) return sendJson(res, 400, { error: "username et password requis" });
  const u = await getUserByUsername(String(username));
  if (!u || !verifyPassword(String(password), u.salt, u.password_hash)) {
    return sendJson(res, 401, { error: "identifiants invalides" });
  }
  const s = await createSession(u.id);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": cookieHeader(s.token) });
  res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin } }));
}

async function handleLogout(req, res) {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": clearCookieHeader() });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUsers(req, res, user) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  if (req.method === "GET") return sendJson(res, 200, { users: await listUsers() });
  if (req.method === "POST") {
    const { username, password, isAdmin } = await readBody(req);
    if (!username || !password) return sendJson(res, 400, { error: "username et password requis" });
    try {
      const u = await createUser(String(username), String(password), !!isAdmin);
      return sendJson(res, 201, { ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin } });
    } catch (e) {
      return sendJson(res, 409, { error: "nom d'utilisateur déjà pris" });
    }
  }
  return sendJson(res, 405, { error: "méthode non autorisée" });
}

async function handleUserAction(req, res, user, path) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  const parts = path.split("/").filter(Boolean);
  const id = Number(parts[2]);
  if (req.method === "DELETE") {
    await deleteUser(id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && parts[3] === "password") {
    const { password } = await readBody(req);
    if (!password) return sendJson(res, 400, { error: "password requis" });
    await updatePassword(id, String(password));
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: "méthode non autorisée" });
}

// --- Router ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    await pruneSessions();

    if (path === "/healthz") return sendJson(res, 200, { ok: true, registry: true });

    if (path === "/login" && req.method === "GET") return serveFile(res, "login.html");
    if (path === "/api/login" && req.method === "POST") return handleLogin(req, res);

    if (isPublicAsset(path)) return serveFile(res, path.slice(1));

    // Documentation publique (markdown) — accessible sans authentification.
    if (path === "/docs") return redirect(res, "/docs/README.md");
    if (path.startsWith("/docs/")) return serveFile(res, path.slice(1));

    const user = await currentUser(req);
    if (path === "/api/logout" && req.method === "POST") return handleLogout(req, res);

    if (!user) {
      if (path.startsWith("/api/")) return sendJson(res, 401, { error: "non authentifié" });
      return redirect(res, "/login");
    }

    if (path === "/api/me") return sendJson(res, 200, { user });
    if (path === "/api/ecosystem") return sendJson(res, 200, scanEcosystem());
    if (path === "/api/config") return sendJson(res, 200, { refreshSeconds: REFRESH_S, sessionBaseUrl: SESSION_BASE_URL });
    if (path === "/api/stats") return sendJson(res, 200, await registryStats());

    if (path === "/api/workspaces" && req.method === "GET") {
      return sendJson(res, 200, await pilot.listWorkspaces());
    }
    if (path === "/api/projects" && req.method === "GET") {
      return sendJson(res, 200, await pilot.listProjects());
    }
    if (path === "/api/projects" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createProject({ ...b, createdBy: user.username }));
    }
    const projDelMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projDelMatch && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.deleteProject(projDelMatch[1]));
    }
    if (path === "/api/tasks" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createTask(b));
    }
    if (path === "/api/scope-conflict" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.scopeConflict(b.project, b.scope));
    }
    const launchMatch = path.match(/^\/api\/tasks\/([^/]+)\/launch$/);
    if (launchMatch && req.method === "POST") {
      return sendJson(res, 200, await pilot.launchTask({ taskId: launchMatch[1] }));
    }
    const reworkMatch = path.match(/^\/api\/tasks\/([^/]+)\/rework$/);
    if (reworkMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.reworkTask({ taskId: reworkMatch[1], mode: b.mode, remarks: b.remarks, by: user.username, sessionId: b.sessionId }));
    }
    const killMatch = path.match(/^\/api\/tasks\/([^/]+)\/kill-session$/);
    if (killMatch && req.method === "POST") {
      return sendJson(res, 200, await pilot.killTaskSession({ taskId: killMatch[1] }));
    }
    const relaunchMatch = path.match(/^\/api\/tasks\/([^/]+)\/relaunch$/);
    if (relaunchMatch && req.method === "POST") {
      return sendJson(res, 200, await pilot.relaunchTask({ taskId: relaunchMatch[1] }));
    }
    const recetteMatch = path.match(/^\/api\/tasks\/([^/]+)\/recette$/);
    if (recetteMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.resolveRecette({ taskId: recetteMatch[1], status: b.status, resolution: b.resolution, by: user.username }));
    }
    const resolveMatch = path.match(/^\/api\/decisions\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.resolveDecision({ decisionId: resolveMatch[1], status: b.status, resolution: b.resolution, by: user.username }));
    }

    if (path === "/api/artifacts") return sendJson(res, 200, await registryArtifacts(url));
    const artDownload = path.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/download$/);
    if (artDownload) return downloadArtifact(res, artDownload[1], artDownload[2]);
    if (path === "/api/archives") return sendJson(res, 200, await registryArchives());
    if (path === "/api/tasks") return sendJson(res, 200, await registryTasks(url));
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
        return sendJson(res, 200, await registryPlans(u));
      }
      return sendJson(res, 200, await registryTaskDetail(taskId));
    }
    if (path === "/api/events") return sendJson(res, 200, await registryEvents(url));
    if (path === "/api/deployments") return sendJson(res, 200, await registryDeployments(url));
    if (path === "/api/decisions") return sendJson(res, 200, await registryDecisions(url));
    if (path === "/api/plans") return sendJson(res, 200, await registryPlans(url));
    if (path === "/api/users") return handleUsers(req, res, user);
    if (path.startsWith("/api/users/")) return handleUserAction(req, res, user, path);

    if (path === "/") return serveFile(res, "index.html");
    return serveFile(res, path.slice(1));
  } catch (e) {
    const msg = String((e && e.message) || e);
    let status = 500;
    if (/timeout/i.test(msg)) status = 504;
    else if (/projet inconnu/i.test(msg)) status = 409;
    else if (/requis|invalide|transition refusée|non disponible/i.test(msg)) status = 400;
    sendJson(res, status, { error: msg });
  }
});

await openDb(); // init panel.db (users/sessions/archives) + bootstrap admin

server.listen(PORT, HOST, () => {
  console.log(`[orchestrator-panel] écoute sur http://${HOST}:${PORT}`);
});
