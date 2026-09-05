// server.mjs — Panneau web de supervision de l'orchestrateur.
// - Lecture SEULE du registre de tâches (PostgreSQL `task_registry`).
// - Authentification par formulaire (session cookie) + gestion d'utilisateurs.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, extname, normalize, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { openDb, getUserByUsername, verifyPassword, createUser, listUsers, updatePassword, deleteUser, createSession, deleteSession, pruneSessions, listArchives, archivedTaskIds, archiveTask, restoreTask, getArchive, removeArchive } from "./panel-db.mjs";
import { currentUser, sessionToken, cookieHeader, clearCookieHeader } from "./auth.mjs";
import { scanEcosystem, updateAgentModel } from "./ecosystem.mjs";
import { loadEnv } from "./env.mjs";
import * as pilot from "./pilot.mjs";
import { sessionUsage, taskConsumption } from "./usage.mjs";
import * as metrics from "./metrics.mjs";
import { marked } from "marked";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_STORAGE_DIR = join(__dirname, "storage", "e2e");
mkdirSync(join(E2E_STORAGE_DIR, "inbox"), { recursive: true });
mkdirSync(join(E2E_STORAGE_DIR, "runs"), { recursive: true });
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
loadEnv();
const DATABASE_URL = process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const REFRESH_S = Math.max(10, Number(process.env.PANEL_REFRESH_S) || 10);
const SESSION_BASE_URL = process.env.SESSION_BASE_URL || "https://dev.madatalk.fr";
const OPENCODE_BIN = process.env.OPENCODE_BIN || "/root/.opencode/bin/opencode";

// Liste des modèles disponibles (fournisseur/modèle), depuis `opencode models`,
// mise en cache 5 minutes.
let _modelsCache = { at: 0, models: [] };
function listModels() {
  const now = Date.now();
  if (_modelsCache.models.length && now - _modelsCache.at < 5 * 60 * 1000) return _modelsCache.models;
  try {
    const out = execFileSync(OPENCODE_BIN, ["models"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    const models = out.split("\n").map((l) => l.trim()).filter((l) => l && l.includes("/"));
    _modelsCache = { at: now, models };
  } catch {
    /* conserve le cache précédent (éventuellement vide) */
  }
  return _modelsCache.models;
}

// --- Consommation (usage) par session et par tâche --------------------------
// (module usage.mjs : sessionUsage, taskConsumption, globalUsage)

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

// Rendu d'un fichier markdown de la documentation (`/docs/*.md`) en HTML.
function serveDoc(res, rel) {
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory() || extname(file).toLowerCase() !== ".md") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const md = readFileSync(file, "utf8");
  const html = marked.parse(md);
  const title = basename(file, ".md");
  const page = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Framework docs</title>
<style>
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:920px;margin:0 auto;padding:24px;line-height:1.65;color:#1f2328;}
h1,h2,h3,h4{line-height:1.3;margin-top:1.6em;} h1{border-bottom:1px solid #d0d7de;padding-bottom:.3em;}
code{background:#f0f2f4;padding:2px 5px;border-radius:4px;font-size:.92em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
pre{background:#f6f8fa;padding:14px;border-radius:6px;overflow:auto;} pre code{background:none;padding:0;}
table{border-collapse:collapse;width:100%;margin:1em 0;display:block;overflow-x:auto;}
th,td{border:1px solid #d0d7de;padding:8px 11px;text-align:left;font-size:.95em;}
th{background:#f6f8fa;font-weight:600;}
a{color:#0969da;text-decoration:none;} a:hover{text-decoration:underline;}
blockquote{border-left:4px solid #d0d7de;margin:1em 0;padding:.1em 1em;color:#57606a;}
.docs-nav{margin-bottom:1.6em;font-size:.95em;padding:8px 12px;background:#f6f8fa;border-radius:6px;}
hr{border:none;border-top:1px solid #d0d7de;margin:2em 0;}
</style></head><body>
<div class="docs-nav"><a href="/docs/README.md">← Index / Table des matières</a></div>
${html}
</body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
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
      `SELECT t.id, t.project, t.type, t.priority, t.request, t.title, t.created_at, t.session_id, t.recette_status, t.recette_class,
         ${latestStatusSubquery()} AS status,
         (SELECT attempt FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS attempt,
         (SELECT rework_count FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS rework_count,
         COALESCE(t.recette_id, (SELECT l.linked_task_id FROM task_links l WHERE l.task_id = t.id AND l.description LIKE 'Issu de la recette%' ORDER BY l.id LIMIT 1)) AS recette_source,
         (SELECT r.title FROM recettes r WHERE r.recette_id = t.recette_id) AS recette_source_title,
         (SELECT ri.exec_order FROM recette_items ri WHERE ri.created_task_id = t.id ORDER BY ri.id LIMIT 1) AS recette_order,
         (SELECT ri.vigilance FROM recette_items ri WHERE ri.created_task_id = t.id ORDER BY ri.id LIMIT 1) AS recette_vigilance,
         EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.status = 'awaiting'
                 AND d.permission_id IS NULL AND d.kind <> 'recette') AS waiting_human
       FROM tasks t ORDER BY t.created_at DESC`,
    );
    rows = res.rows.filter((r) => !archived.has(r.id));
    // Agrégat E2E par tâche : nombre de tests liés + dernier statut par test.
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const cnt = (await db.query("SELECT task_id, COUNT(*) AS n FROM task_e2e WHERE task_id = ANY($1) GROUP BY task_id", [ids])).rows;
      const last = (await db.query(
        `SELECT te.task_id, ex.status FROM task_e2e te
           JOIN e2e_executions ex ON ex.e2e_test_id = te.e2e_test_id AND ex.task_id = te.task_id
             AND ex.created_at = (SELECT MAX(x.created_at) FROM e2e_executions x
                                  WHERE x.e2e_test_id = te.e2e_test_id AND x.task_id = te.task_id)
          WHERE te.task_id = ANY($1)`,
        [ids],
      )).rows;
      const cntMap = {}; cnt.forEach((r) => { cntMap[r.task_id] = Number(r.n); });
      const stMap = {};
      for (const r of last) (stMap[r.task_id] = stMap[r.task_id] || []).push(r.status);
      for (const row of rows) {
        const n = cntMap[row.id] || 0;
        const sts = stMap[row.id] || [];
        if (!n) { row.e2e = null; continue; }
        let state = "pending";
        if (sts.some((s) => s === "FAILED" || s === "ERROR")) state = "fail";
        else if (sts.length === n && sts.every((s) => s === "PASSED")) state = "pass";
        row.e2e = { state, count: n, done: sts.length };
      }
    }
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
  const sessions = await q("SELECT session_id, kind, created_at FROM task_sessions WHERE task_id = $1 ORDER BY id ASC", [id]);
  const linkedTasks = await q(
    `SELECT l.linked_task_id, l.description,
            t.request AS linked_request, t.recette_status AS linked_recette,
            (SELECT x.status FROM executions x WHERE x.task_id = l.linked_task_id ORDER BY attempt DESC LIMIT 1) AS linked_status,
            (SELECT COUNT(*) FROM plans p WHERE p.task_id = l.linked_task_id) AS linked_plans,
            (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = l.linked_task_id) AS linked_artifacts
     FROM task_links l LEFT JOIN tasks t ON t.id = l.linked_task_id
     WHERE l.task_id = $1 ORDER BY l.id ASC`,
    [id],
  );
  let recette = null;
  const rec = (await q(
    `SELECT r.*, rt.task_id FROM recettes r
     LEFT JOIN recette_tasks rt ON rt.recette_id = r.recette_id
     WHERE rt.task_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [id],
  ))[0];
  if (rec) {
    const items = mapRecetteItems(await q("SELECT id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, status, created_task_id, created_at FROM recette_items WHERE recette_id = $1 ORDER BY id ASC", [rec.recette_id]));
    const tasks = (await q("SELECT task_id FROM recette_tasks WHERE recette_id = $1", [rec.recette_id])).map((x) => x.task_id);
    const projs = (await q("SELECT project FROM recette_projects WHERE recette_id = $1 ORDER BY project", [rec.recette_id])).map((x) => x.project);
    recette = { recetteId: rec.recette_id, project: rec.project, projects: projs.length ? projs : (rec.project ? [rec.project] : []), title: rec.title, sessionId: rec.session_id, status: rec.status, confirmedAt: rec.confirmed_at, confirmedBy: rec.confirmed_by, tasks, items };
  }
  return { task, executions, events, deployments, decisions, artifacts, sessions, linkedTasks, recette, archived: (await archivedTaskIds()).has(id) };
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
              (SELECT pe.status FROM plan_executions pe WHERE pe.plan_id = p.id ORDER BY pe.id DESC LIMIT 1) AS execution_status,
              (SELECT COUNT(*) FROM plan_commits pc WHERE pc.plan_id = p.id) AS commit_count
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
      commit_count: Number(p.commit_count) || 0,
      branch: p.branch,
      pct,
      deliverables: p.deliverables ? JSON.parse(p.deliverables) : [],
      created_at: p.created_at,
    });
  }
  return { plans };
}

async function registryPlanCommits(planId) {
  const db = registry();
  let rows = [];
  try {
    const res = await db.query(
      "SELECT * FROM plan_commits WHERE plan_id = $1 ORDER BY id ASC",
      [planId],
    );
    rows = res.rows;
  } catch { rows = []; }
  return {
    planId,
    commits: rows.map((r) => {
      let files = [];
      try { files = r.files ? JSON.parse(r.files) : []; } catch { files = []; }
      return {
        id: r.id,
        sha: r.sha,
        message: r.message,
        author: r.author,
        branch: r.branch,
        committedAt: r.committed_at,
        createdAt: r.created_at,
        files,
      };
    }),
  };
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

// Visionneuse : rend un document markdown en HTML (via `marked`).
async function viewArtifact(res, taskId, artifactId) {
  const db = registry();
  const notFound = (msg) => sendJson(res, 404, { error: msg || "Document introuvable" });
  let a;
  try {
    a = (await db.query("SELECT * FROM artifacts WHERE artifact_id = $1 AND task_id = $2", [artifactId, taskId])).rows[0];
  } catch { return notFound(); }
  if (!a || !a.path) return notFound();
  if (!existsSync(a.path) || statSync(a.path).isDirectory()) return notFound();
  if (extname(a.path).toLowerCase() !== ".md") {
    return sendJson(res, 415, { error: "pas de visionneuse pour ce type de fichier (markdown uniquement)" });
  }
  const raw = readFileSync(a.path, "utf8");
  const html = marked.parse(raw);
  return sendJson(res, 200, { artifactId, taskId, title: a.title || basename(a.path), html });
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

function mapRecetteItems(rows) {
  return rows.map((i) => ({
    id: i.id,
    content: i.content,
    classification: i.classification,
    discussion: i.discussion,
    scope: i.scope ? JSON.parse(i.scope) : [],
    project: i.project ?? null,
    title: i.title ?? null,
    acceptance: i.acceptance ?? null,
    execOrder: i.exec_order ?? null,
    vigilance: i.vigilance ?? null,
    status: i.status,
    createdTaskId: i.created_task_id ?? null,
    createdAt: i.created_at,
  }));
}

// Projets rattachés à une recette (recette_projects) — indexé par recette_id.
async function recetteProjectsByIds(ids) {
  if (!ids || !ids.length) return {};
  const rows = (await registry().query(
    "SELECT recette_id, project FROM recette_projects WHERE recette_id = ANY($1) ORDER BY project",
    [ids],
  )).rows;
  const map = {};
  for (const x of rows) (map[x.recette_id] = map[x.recette_id] || []).push(x.project);
  return map;
}

// --- Tests E2E (entités de 1er niveau) : lecture SQL + écritures via pilot --
function mapE2ETestRow(r) {
  return {
    e2eTestId: r.id,
    project: r.project,
    specFile: r.spec_file,
    scenario: r.scenario,
    title: r.title,
    description: r.description,
    status: r.status,
    version: r.version,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
  };
}

function mapE2EExecRow(r) {
  return {
    id: r.id,
    e2eTestId: r.e2e_test_id,
    origin: r.origin,
    taskId: r.task_id,
    deploymentId: r.deployment_id,
    planId: r.plan_id,
    env: r.env,
    commitSha: r.commit_sha,
    branch: r.branch,
    pipelineRef: r.pipeline_ref,
    status: r.status,
    durationMs: r.duration_ms,
    attempts: r.attempts,
    executedAt: r.executed_at,
    reportArtifactId: r.report_artifact_id,
    logsUrl: r.logs_url,
    videoUrl: r.video_url,
    summary: r.summary,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
    paramValues: r.param_values,
  };
}

// Ligne e2e_tests (existence + repo source) pour les routes /:id.
async function registryE2ETest(id) {
  try {
    return (await registry().query("SELECT id, project, spec_file, scenario FROM e2e_tests WHERE id = $1", [id])).rows[0] || null;
  } catch { return null; }
}

// Projets couverts indexés par test (fallback repo source côté appelant).
async function e2eProjectsByTestIds(ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  try {
    const rows = (await registry().query(
      "SELECT e2e_test_id, project FROM e2e_test_projects WHERE e2e_test_id = ANY($1) ORDER BY project", [ids],
    )).rows;
    for (const x of rows) (map[x.e2e_test_id] = map[x.e2e_test_id] || []).push(x.project);
  } catch {}
  return map;
}

async function registryE2ETests(url) {
  const db = registry();
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const taskId = url.searchParams.get("taskId");
  const conds = [];
  const params = [];
  if (project) {
    params.push(String(project));
    const i = params.length;
    // Projet couvert : présent dans e2e_test_projects OU repo source du test.
    conds.push(`(EXISTS (SELECT 1 FROM e2e_test_projects ep WHERE ep.e2e_test_id = t.id AND ep.project = $${i}) OR t.project = $${i})`);
  }
  if (status) { params.push(String(status)); conds.push(`t.status = $${params.length}`); }
  if (search) {
    params.push(`%${String(search)}%`);
    const i = params.length;
    conds.push(`(t.title ILIKE $${i} OR t.scenario ILIKE $${i} OR t.spec_file ILIKE $${i})`);
  }
  if (taskId) {
    params.push(String(taskId));
    conds.push(`EXISTS (SELECT 1 FROM task_e2e te WHERE te.e2e_test_id = t.id AND te.task_id = $${params.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT t.id, t.project, t.spec_file, t.scenario, t.title, t.description, t.status, t.version, t.meta, t.first_seen_at, t.updated_at,
              (SELECT COUNT(*) FROM task_e2e te WHERE te.e2e_test_id = t.id)::int AS task_count,
              (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_status,
              (SELECT x.origin FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_origin,
              (SELECT x.created_at FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_run_at
       FROM e2e_tests t ${where}
       ORDER BY t.updated_at DESC`,
      params,
    )).rows;
  } catch { rows = []; }
  const projMap = await e2eProjectsByTestIds(rows.map((r) => r.id));
  const tests = rows.map((r) => ({
    ...mapE2ETestRow(r),
    // Projets couverts agrégés (triés) ; fallback : repo source.
    projects: projMap[r.id] || (r.project ? [r.project] : []),
    taskCount: Number(r.task_count) || 0,
    lastStatus: r.last_status || null,
    lastOrigin: r.last_origin || null,
    lastRunAt: r.last_run_at || null,
  }));
  return { tests };
}

async function registryE2ETestDetail(res, id) {
  const db = registry();
  let row = null;
  try { row = (await db.query("SELECT * FROM e2e_tests WHERE id = $1", [id])).rows[0]; } catch { row = null; }
  if (!row) return sendJson(res, 404, { error: "test E2E inconnu" });
  const q = async (sql, p = []) => (await db.query(sql, p).catch(() => ({ rows: [] }))).rows;
  const projects = (await q("SELECT project FROM e2e_test_projects WHERE e2e_test_id = $1 ORDER BY project", [id])).map((x) => x.project);
  const params = (await q("SELECT name, kind, default_value, secret_ref, required FROM e2e_test_params WHERE e2e_test_id = $1 ORDER BY name", [id])).map((x) => ({
    name: x.name,
    kind: x.kind,
    // SÉCURITÉ : un paramètre secret ne renvoie JAMAIS de valeur (defaultValue).
    defaultValue: x.kind === "secret" ? null : x.default_value,
    secretRef: x.secret_ref,
    required: !!x.required,
  }));
  const linkedTasks = (await q(
    `SELECT te.task_id, te.relation_type, te.reason,
            t.project AS task_project, t.title AS task_title, t.request AS task_request,
            (SELECT x.status FROM executions x WHERE x.task_id = te.task_id ORDER BY attempt DESC LIMIT 1) AS task_status
     FROM task_e2e te LEFT JOIN tasks t ON t.id = te.task_id
     WHERE te.e2e_test_id = $1 ORDER BY te.task_id`,
    [id],
  )).map((x) => ({
    taskId: x.task_id,
    relationType: x.relation_type,
    reason: x.reason,
    taskProject: x.task_project,
    taskTitle: x.task_title,
    taskRequest: x.task_request,
    taskStatus: x.task_status,
  }));
  const executions = (await q("SELECT * FROM e2e_executions WHERE e2e_test_id = $1 ORDER BY created_at DESC LIMIT 100", [id])).map(mapE2EExecRow);
  const test = {
    ...mapE2ETestRow(row),
    projects: projects.length ? projects : (row.project ? [row.project] : []),
    params,
    linkedTasks,
  };
  return sendJson(res, 200, { test, executions });
}

// Garde d'écriture : rejette toute valeur secrète concrète dans defaultValue.
function e2eParamsGuard(params) {
  for (const p of params || []) {
    if (!p || p.name == null) continue;
    if (String(p.kind || "string") === "secret" && (p.defaultValue != null || p.default_value != null)) {
      return `paramètre secret « ${p.name} » : fournir secretRef, jamais de defaultValue (valeur concrète)`;
    }
  }
  return null;
}

async function handleE2ECreate(res, b) {
  const { project, specFile, scenario, title, description, coveredProjects, params } = b || {};
  if (!project || !specFile || !scenario) return sendJson(res, 400, { error: "project, specFile et scenario requis" });
  const guard = e2eParamsGuard(params);
  if (guard) return sendJson(res, 400, { error: guard });
  const r = await pilot.createE2ETest({ project, specFile, scenario, title, description, coveredProjects, params });
  return sendJson(res, 201, { ok: true, test: r && r.test });
}

async function handleE2ERun(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const { repoDir, baseUrl, origin, taskId, specPattern, playwrightConfig, pwArgs, paramValues } = b || {};
  if (!repoDir || !String(repoDir).trim()) return sendJson(res, 400, { error: "repoDir requis (dépôt applicatif à exécuter)" });
  // SÉCURITÉ : un paramètre secret ne peut pas être surchargé en clair (il ne
  // doit jamais transiter ni être persisté dans param_values).
  if (paramValues && typeof paramValues === "object") {
    let secretNames = [];
    try {
      secretNames = (await registry().query("SELECT name FROM e2e_test_params WHERE e2e_test_id = $1 AND kind = 'secret'", [id])).rows.map((x) => x.name);
    } catch {}
    const forbidden = Object.keys(paramValues).filter((k) => secretNames.includes(k));
    if (forbidden.length) return sendJson(res, 400, { error: `paramètre(s) secret(s) non surchargeables : ${forbidden.join(", ")}` });
  }
  const runOrigin = ["manual", "task", "recette", "ci", "session"].includes(origin) ? origin : "manual";
  try {
    const r = await pilot.runE2ETest({
      project: t.project,
      repoDir: String(repoDir).trim(),
      baseUrl: baseUrl || undefined,
      e2eTestId: t.id,
      origin: runOrigin,
      taskId: taskId || undefined,
      specPattern: specPattern || undefined,
      playwrightConfig: playwrightConfig || undefined,
      pwArgs,
      paramValues,
    });
    return sendJson(res, 200, r);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Le run peut dépasser le timeout MCP (30 s côté mcp-client) : explicite.
    if (/timeout/i.test(msg)) return sendJson(res, 502, { error: "run trop long — vérifier dans l'historique du test" });
    if (/requis|invalide|non disponible|introuvable|absents/i.test(msg)) return sendJson(res, 400, { error: msg });
    return sendJson(res, 500, { error: msg });
  }
}

async function handleE2EParamSet(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const params = (b && b.params) || [];
  const guard = e2eParamsGuard(params);
  if (guard) return sendJson(res, 400, { error: guard });
  return sendJson(res, 200, await pilot.setE2ETestParams({ e2eTestId: id, params }));
}

async function handleE2ELink(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const { taskId, relationType, reason } = b || {};
  if (!taskId) return sendJson(res, 400, { error: "taskId requis" });
  let taskExists = false;
  try { taskExists = (await registry().query("SELECT 1 FROM tasks WHERE id = $1", [String(taskId)])).rows.length > 0; } catch {}
  if (!taskExists) return sendJson(res, 404, { error: "tâche inconnue" });
  return sendJson(res, 200, await pilot.linkE2ETest({ taskId, e2eTestId: id, relationType, reason }));
}

async function handleE2EUnlink(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const { taskId } = b || {};
  if (!taskId) return sendJson(res, 400, { error: "taskId requis" });
  return sendJson(res, 200, await pilot.unlinkE2ETest({ taskId, e2eTestId: id }));
}

async function handleE2EObsolete(res, id) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  return sendJson(res, 200, await pilot.obsoleteE2ETest(id));
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
    if (path.startsWith("/docs/")) {
      return path.endsWith(".md") ? serveDoc(res, path.slice(1)) : serveFile(res, path.slice(1));
    }

    const user = await currentUser(req);
    if (path === "/api/logout" && req.method === "POST") return handleLogout(req, res);

    if (!user) {
      if (path.startsWith("/api/")) return sendJson(res, 401, { error: "non authentifié" });
      return redirect(res, "/login");
    }

    if (path === "/api/me") return sendJson(res, 200, { user });
    if (path === "/api/ecosystem") return sendJson(res, 200, scanEcosystem());
    if (path === "/api/models" && req.method === "GET") return sendJson(res, 200, { models: listModels() });
    const agentModelMatch = path.match(/^\/api\/agents\/([^/]+)\/model$/);
    if (agentModelMatch && req.method === "POST") {
      const b = await readBody(req);
      const model = String(b.model || "").trim();
      if (!model || model.length > 200 || !model.includes("/")) {
        return sendJson(res, 400, { error: "modèle invalide (format fournisseur/modèle)" });
      }
      try {
        const r = updateAgentModel(agentModelMatch[1], model);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
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
    const artView = path.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/view$/);
    if (artView) return viewArtifact(res, artView[1], artView[2]);
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
      if (path.endsWith("/consumption") && req.method === "GET") {
        return sendJson(res, 200, await taskConsumption(taskId, registry()));
      }
      if (path.endsWith("/edit") && req.method === "POST") {
        const b = await readBody(req);
        return sendJson(res, 200, await pilot.editTask({ taskId, ...b }));
      }
      if (path.endsWith("/e2e/videos.zip") && req.method === "GET") {
        const db = registry();
        const rows = (await db.query("SELECT id, video_url FROM e2e_executions WHERE task_id = $1 AND video_url IS NOT NULL ORDER BY created_at DESC", [taskId])).rows.filter((x) => existsSync(x.video_url));
        if (!rows.length) return sendJson(res, 404, { error: "aucune vidéo" });
        const tmp = `/tmp/opencode/e2e-zip-${Date.now()}.zip`;
        try {
          execFileSync("zip", ["-j", "-q", tmp, ...rows.map((x) => x.video_url)], { timeout: 120000 });
          const st = statSync(tmp);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/zip");
          res.setHeader("Content-Disposition", `attachment; filename="e2e-videos-${taskId}.zip"`);
          res.setHeader("Content-Length", st.size);
          const rs = createReadStream(tmp);
          rs.pipe(res);
          rs.on("end", () => { try { unlinkSync(tmp); } catch {} });
          return;
        } catch (e) { return sendJson(res, 500, { error: "échec zip : " + (e.message || e) }); }
      }
      if (path.endsWith("/e2e") && req.method === "GET") {
        const db = registry();
        const tests = (await db.query(`SELECT t.id, t.project, t.spec_file, t.scenario, t.title, t.status AS test_status, te.relation_type, te.reason,
          (SELECT x.id FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_execution_id,
          (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_status,
          (SELECT x.duration_ms FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_duration_ms,
          (SELECT x.attempts FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_attempts
          FROM task_e2e te JOIN e2e_tests t ON t.id = te.e2e_test_id WHERE te.task_id = $1 ORDER BY t.scenario`, [taskId])).rows;
        const execRows = (await db.query(`SELECT id, e2e_test_id, status, duration_ms, attempts, executed_at, summary, logs_url, video_url, report_artifact_id, commit_sha, branch, pipeline_ref FROM e2e_executions WHERE task_id = $1 ORDER BY created_at DESC LIMIT 100`, [taskId])).rows;
        // Projets couverts par test (fallback : repo source) — ajout compatible.
        const projMap = await e2eProjectsByTestIds(tests.map((r) => r.id));
        return sendJson(res, 200, { taskId, task_id: taskId, tests: tests.map((r) => ({ e2eTestId: r.id, project: r.project, projects: projMap[r.id] || (r.project ? [r.project] : []), specFile: r.spec_file, scenario: r.scenario, title: r.title, testStatus: r.test_status, relationType: r.relation_type, reason: r.reason, lastExecutionId: r.last_execution_id, lastStatus: r.last_status, lastDurationMs: r.last_duration_ms, lastAttempts: r.last_attempts })), executions: execRows.map((r) => ({ id: r.id, e2eTestId: r.e2e_test_id, status: r.status, durationMs: r.duration_ms, attempts: r.attempts, executedAt: r.executed_at, summary: r.summary, logsUrl: r.logs_url, videoUrl: r.video_url, reportArtifactId: r.report_artifact_id, commitSha: r.commit_sha, branch: r.branch, pipelineRef: r.pipeline_ref })) });
      }
      return sendJson(res, 200, await registryTaskDetail(taskId));
    }
    if (path === "/api/events") return sendJson(res, 200, await registryEvents(url));
    if (path === "/api/deployments") return sendJson(res, 200, await registryDeployments(url));
    if (path === "/api/decisions") return sendJson(res, 200, await registryDecisions(url));
    const planCommitsMatch = path.match(/^\/api\/plans\/([^/]+)\/commits$/);
    if (planCommitsMatch && req.method === "GET") {
      return sendJson(res, 200, await registryPlanCommits(planCommitsMatch[1]));
    }
    if (path === "/api/plans") return sendJson(res, 200, await registryPlans(url));
    if (path === "/api/users") return handleUsers(req, res, user);
    if (path.startsWith("/api/users/")) return handleUserAction(req, res, user, path);

    // --- Observabilité / KPI (v0.2.0) ---
    if (path === "/api/metrics/summary" && req.method === "GET") return sendJson(res, 200, await metrics.summary(registry()));
    if (path === "/api/metrics/status" && req.method === "GET") return sendJson(res, 200, await metrics.status(registry()));
    if (path === "/api/metrics/throughput" && req.method === "GET") {
      return sendJson(res, 200, await metrics.throughput(registry(), Number(url.searchParams.get("days") || 14)));
    }
    if (path === "/api/metrics/leadtime" && req.method === "GET") {
      return sendJson(res, 200, await metrics.leadtime(registry(), Number(url.searchParams.get("days") || 14)));
    }
    if (path === "/api/metrics/agents" && req.method === "GET") return sendJson(res, 200, await metrics.agents(registry()));
    if (path === "/api/metrics/costs" && req.method === "GET") return sendJson(res, 200, await metrics.costs(registry()));
    // Phase 2 — où passe le temps, blocages, succès/échec
    if (path === "/api/metrics/phases" && req.method === "GET") return sendJson(res, 200, await metrics.phases(registry()));
    if (path === "/api/metrics/timeline" && req.method === "GET") {
      return sendJson(res, 200, await metrics.timeline(registry(), url.searchParams.get("taskId") || ""));
    }
    if (path === "/api/metrics/blocked" && req.method === "GET") {
      return sendJson(res, 200, await metrics.blocked(registry(), Number(url.searchParams.get("days") || 14)));
    }
    if (path === "/api/metrics/successfailure" && req.method === "GET") {
      return sendJson(res, 200, await metrics.successfailure(registry(), Number(url.searchParams.get("days") || 14)));
    }
    // Phase 4 — durcissement (décisions expirées, conflits de scope)
    if (path === "/api/metrics/hardening" && req.method === "GET") return sendJson(res, 200, await metrics.hardening(registry()));
    // Phase D — recette (v0.8) : opérations de PROJET
    if (path === "/api/metrics/recette" && req.method === "GET") return sendJson(res, 200, await metrics.recette(registry()));
    if (path === "/api/recettes" && req.method === "GET") {
      const project = url.searchParams.get("project");
      const rows = (await registry().query(
        `SELECT r.*,
           (SELECT COUNT(*) FROM recette_tasks rt WHERE rt.recette_id = r.recette_id) AS tasks_count,
           (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = r.recette_id) AS items_count,
           (SELECT COUNT(*) FROM recette_documents d WHERE d.recette_id = r.recette_id) AS documents_count
         FROM recettes r
         ${project ? "WHERE EXISTS (SELECT 1 FROM recette_projects rp WHERE rp.recette_id = r.recette_id AND rp.project = $1)" : ""}
         ORDER BY r.created_at DESC`,
        project ? [project] : [],
      )).rows;
      const pmap = await recetteProjectsByIds(rows.map((x) => x.recette_id));
      for (const row of rows) row.projects = pmap[row.recette_id] || (row.project ? [row.project] : []);
      return sendJson(res, 200, { recettes: rows });
    }
    // Candidats : tâches NON encore couvertes par une recette (recette_status != done, non présentes dans recette_tasks).
    // Multi-projets : répéter le paramètre ?project=a&project=b (ou un seul).
    if (path === "/api/recettes/candidates" && req.method === "GET") {
      const projects = url.searchParams.getAll("project").filter(Boolean);
      const where = [
        "t.recette_status = 'pending'",
        "NOT EXISTS (SELECT 1 FROM recette_tasks rt WHERE rt.task_id = t.id)",
      ];
      if (projects.length) where.push("t.project = ANY($1)");
      const rows = (await registry().query(
        `SELECT t.id, t.project, t.title, t.request, t.recette_status, t.created_at,
                (SELECT x.status FROM executions x WHERE x.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS status
         FROM tasks t
         WHERE ${where.join(" AND ")}
         ORDER BY t.created_at DESC`,
        projects.length ? [projects] : [],
      )).rows;
      return sendJson(res, 200, { candidates: rows });
    }
    if (path === "/api/recettes" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createRecette({ project: b.project, projects: b.projects, title: b.title, description: b.description, taskIds: b.taskIds, documents: b.documents, by: user.username }));
    }
    const recetteAction = path.match(/^\/api\/recettes\/([^/]+)\/(session|finish)$/);
    if (recetteAction && req.method === "POST") {
      if (recetteAction[2] === "session") {
        let sb = {};
        try { sb = await readBody(req); } catch {}
        return sendJson(res, 200, await pilot.launchRecetteSession({ recetteId: recetteAction[1], force: !!(sb && sb.force) }));
      }
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.finishRecette({ recetteId: recetteAction[1], items: b.items, by: user.username }));
    }
    const recetteTaskAdd = path.match(/^\/api\/recettes\/([^/]+)\/tasks$/);
    if (recetteTaskAdd && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addRecetteTask({ recetteId: recetteTaskAdd[1], taskId: b.taskId }));
    }
    const recetteTaskDel = path.match(/^\/api\/recettes\/([^/]+)\/tasks\/([^/]+)$/);
    if (recetteTaskDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeRecetteTask({ recetteId: recetteTaskDel[1], taskId: decodeURIComponent(recetteTaskDel[2]) }));
    }
    const recetteItemDel = path.match(/^\/api\/recettes\/([^/]+)\/items\/([0-9]+)$/);
    if (recetteItemDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeRecetteItem({ recetteId: recetteItemDel[1], itemId: Number(recetteItemDel[2]) }));
    }
    const recetteProjAdd = path.match(/^\/api\/recettes\/([^/]+)\/projects$/);
    if (recetteProjAdd && req.method === "POST") {
      const b = await readBody(req);
      const r = await pilot.addRecetteProject({ recetteId: recetteProjAdd[1], project: b.project, by: user.username });
      return sendJson(res, 200, r);
    }
    const recetteProjDel = path.match(/^\/api\/recettes\/([^/]+)\/projects\/([^/]+)$/);
    if (recetteProjDel && req.method === "DELETE") {
      const r = await pilot.removeRecetteProject({ recetteId: recetteProjDel[1], project: decodeURIComponent(recetteProjDel[2]), by: user.username });
      return sendJson(res, 200, r);
    }
    const recetteDocView = path.match(/^\/api\/recettes\/([^/]+)\/documents\/([0-9]+)\/view$/);
    if (recetteDocView && req.method === "GET") {
      const d = (await registry().query("SELECT * FROM recette_documents WHERE id = $1", [Number(recetteDocView[2])])).rows[0];
      if (!d || !d.path || !existsSync(d.path)) return sendJson(res, 404, { error: "document introuvable" });
      const raw = readFileSync(d.path, "utf8");
      const html = /\.md$/i.test(d.path) ? marked.parse(raw) : null;
      return sendJson(res, 200, { title: d.title || d.path.split("/").pop(), html, raw: html ? null : raw });
    }
    const recetteDocAction = path.match(/^\/api\/recettes\/([^/]+)\/documents$/);
    if (recetteDocAction && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addRecetteDocument({ recetteId: recetteDocAction[1], mode: b.mode, filename: b.filename, dataBase64: b.dataBase64, artifactId: b.artifactId, nature: b.nature, title: b.title }));
    }
    const recetteDocDel = path.match(/^\/api\/recettes\/([^/]+)\/documents\/([0-9]+)$/);
    if (recetteDocDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeRecetteDocument({ documentId: Number(recetteDocDel[2]) }));
    }
    const recetteDetail = path.match(/^\/api\/recettes\/([^/]+)$/);
    if (recetteDetail && req.method === "GET") {
      const r = (await registry().query(
        `SELECT r.*, (SELECT COUNT(*) FROM recette_tasks rt WHERE rt.recette_id = r.recette_id) AS tasks_count FROM recettes r WHERE r.recette_id = $1`,
        [recetteDetail[1]],
      )).rows[0];
      if (!r) return sendJson(res, 404, { error: "recette inconnue" });
      const items = mapRecetteItems((await registry().query(
        "SELECT id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, status, created_task_id, created_at FROM recette_items WHERE recette_id = $1 ORDER BY id ASC",
        [r.recette_id],
      )).rows);
      const tasks = (await registry().query(
        `SELECT rt.task_id, t.project, t.title, t.request FROM recette_tasks rt LEFT JOIN tasks t ON t.id = rt.task_id
         WHERE rt.recette_id = $1 ORDER BY rt.task_id`, [r.recette_id],
      )).rows.map((x) => ({ taskId: x.task_id, project: x.project || '', title: x.title || x.task_id, request: x.request || '' }));
      const docs = (await registry().query(
        `SELECT d.id, d.title, d.nature, d.source, d.path, d.artifact_id, d.created_at, a.title AS artifact_title, a.task_id AS artifact_task
         FROM recette_documents d LEFT JOIN artifacts a ON a.artifact_id = d.artifact_id
         WHERE d.recette_id = $1 ORDER BY d.id ASC`, [r.recette_id],
      )).rows;
      const projs = (await registry().query("SELECT project FROM recette_projects WHERE recette_id = $1 ORDER BY project", [r.recette_id])).rows.map((x) => x.project);
      return sendJson(res, 200, { recette: { ...r, projects: projs.length ? projs : (r.project ? [r.project] : []), tasks, items, documents: docs } });
    }
    // --- Tests E2E (v0.9.0) : entités de 1er niveau, indépendantes des tâches
    if (path === "/api/e2e-tests" && req.method === "GET") return sendJson(res, 200, await registryE2ETests(url));
    if (path === "/api/e2e-tests" && req.method === "POST") {
      const b = await readBody(req);
      return handleE2ECreate(res, b);
    }
    const e2eDetailMatch = path.match(/^\/api\/e2e-tests\/([^/]+)$/);
    if (e2eDetailMatch && req.method === "GET") return registryE2ETestDetail(res, e2eDetailMatch[1]);
    const e2eRunMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/run$/);
    if (e2eRunMatch && req.method === "POST") {
      const b = await readBody(req);
      return handleE2ERun(res, e2eRunMatch[1], b);
    }
    const e2eParamsMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/params$/);
    if (e2eParamsMatch && req.method === "POST") {
      const b = await readBody(req);
      return handleE2EParamSet(res, e2eParamsMatch[1], b);
    }
    const e2eLinkMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/link-task$/);
    if (e2eLinkMatch && req.method === "POST") {
      const b = await readBody(req);
      return handleE2ELink(res, e2eLinkMatch[1], b);
    }
    const e2eUnlinkMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/unlink-task$/);
    if (e2eUnlinkMatch && req.method === "POST") {
      const b = await readBody(req);
      return handleE2EUnlink(res, e2eUnlinkMatch[1], b);
    }
    const e2eObsoleteMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/obsolete$/);
    if (e2eObsoleteMatch && req.method === "POST") {
      return handleE2EObsolete(res, e2eObsoleteMatch[1]);
    }
    // --- Tests E2E (cadrage 07) : collecteur hôte + lecture ---
    if (path === "/api/e2e/collect" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.collectE2EResults({ runId: b.runId }));
    }
    if (path === "/api/e2e/prune" && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé admin" });
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.pruneE2EVideos({ days: b.days }));
    }
    // Fichier de preuve E2E (rapport texte / vidéo humaine) — accès restreint à storage/e2e.
    if (path === "/api/e2e/file" && req.method === "GET") {
      const rel = url.searchParams.get("p") || "";
      const abs = normalize(join(E2E_STORAGE_DIR, rel));
      if (!abs.startsWith(E2E_STORAGE_DIR + "/") || !existsSync(abs)) return sendJson(res, 404, { error: "introuvable" });
      const type = /\.(webm|mp4)$/i.test(abs) ? "video/webm" : (/\.json$/i.test(abs) ? "application/json" : "text/plain");
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Disposition", `inline; filename="${basename(abs)}"`);
      const st = statSync(abs);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
        res.statusCode = 206;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
        res.setHeader("Content-Length", end - start + 1);
        createReadStream(abs, { start, end }).pipe(res);
      } else {
        res.statusCode = 200;
        res.setHeader("Content-Length", st.size);
        createReadStream(abs).pipe(res);
      }
      return;
    }
    // Phase 3 (hors worktree) — qualité : funnel, rework, cost vs throughput
    if (path === "/api/metrics/quality" && req.method === "GET") return sendJson(res, 200, await metrics.quality(registry()));
    if (path === "/api/metrics/rework" && req.method === "GET") {
      return sendJson(res, 200, await metrics.rework(registry(), Number(url.searchParams.get("days") || 14)));
    }
    if (path === "/api/metrics/costvsthroughput" && req.method === "GET") {
      return sendJson(res, 200, await metrics.costvsthroughput(registry(), Number(url.searchParams.get("days") || 14)));
    }

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
