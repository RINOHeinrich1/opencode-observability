// server.mjs — Panneau web de supervision de l'orchestrateur.
// - Lecture SEULE du registre de tâches (PostgreSQL `task_registry`).
// - Authentification par formulaire (session cookie) + gestion d'utilisateurs.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, extname, normalize, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import pg from "pg";
import { openDb, getUserByUsername, verifyPassword, createUser, updateUserRole, updateUserOrganization, listUsers, listUserOrganizations, setUserOrganizations, listUsersByOrganization, listUserProjects, setUserProjects, listUsersByProject, getUserOpencode, setUserOpencode, listUsersOpencode, updatePassword, setUserNotifyEmail, deleteUser, createSession, deleteSession, setSessionOrganization, pruneSessions, listArchives, archivedTaskIds, archiveTask, restoreTask, getArchive, removeArchive } from "./panel-db.mjs";
import { currentUser, sessionToken, cookieHeader, clearCookieHeader, allowedPages } from "./auth.mjs";
import { scanEcosystem, updateAgentModel } from "./ecosystem.mjs";
import { loadEnv } from "./env.mjs";
import * as pilot from "./pilot.mjs";
import { closeAllMcpClients } from "./mcp-client.mjs";
import { sessionUsage, taskConsumption } from "./usage.mjs";
import * as metrics from "./metrics.mjs";
import { marked } from "marked";
import { generateSubtitledVideo, generateNarratedVideo } from "./subtitles.mjs";

// --- ACL rôle `evaluateur` (ADR-002) — allowlist FAIL-CLOSED ----------------
// L'évaluateur n'accède qu'aux pages Fonctionnalités & Règles, Tests E2E et
// Recette (évaluateur) (+ lecture Projets/Repos pour choisir un projet). Toute route NON
// listée est refusée en 403 : la protection est côté serveur, jamais l'UI.
// Les RÉGLAGES TECHNIQUES E2E (`/api/e2e-vars`, `/api/e2e-secrets`) sont HORS
// périmètre évaluateur (ADR-003) : le run est lancé tel qu'enregistré.
// Allowlist de LECTURE (préfixes autorisés, méthode GET/HEAD uniquement).
const EVALUATEUR_ALLOWED_API = [
  "/api/me", "/api/config", "/api/orgs", "/api/session/organization", "/api/render-md",
  "/api/projects", "/api/repos", "/api/pieces", "/api/features", "/api/rules", "/api/links",
  "/api/cardinality", "/api/sprints", "/api/docs", "/api/e2e-tests", "/api/e2e/jobs",
  "/api/e2e/agent-sessions", "/api/e2e/file", "/api/recettes",
  "/api/batches", "/api/adr-vigilances",
];
// Interdits EXPLICITES (défense en profondeur) même si un préfixe de l'allowlist
// les couvrirait : `/api/docs/file` sert le contenu des ADR (onglet ADR interdit).
const EVALUATEUR_DENIED_API = ["/api/docs/file", "/api/e2e-secrets", "/api/cadrages"];
// Écritures autorisées (méthodes non-GET) : SES recettes évaluateur
// (création/items/documents/verdicts/finish/session), le lancement d'un test E2E, le
// marquage « incohérent » d'un test, le dépôt de pièces, la levée d'une
// vigilance ADR et le changement d'organisation active. Rien d'autre (cadrage
// technique, création/modification/obsolescence E2E, vars/secrets,
// features/rules/docs/sprints/projets/repos… = 403).
const EVALUATEUR_WRITE_PATTERNS = [
  /^\/api\/session\/organization$/,
  /^\/api\/pieces$/,
  /^\/api\/recettes$/,
  /^\/api\/recettes\/[^/]+\/(items|documents|verdicts|finish|session)(\/.*)?$/,
  // Lancement d'un TEST DE PERFORMANCE préprod depuis sa recette (maquette +
  // perf — ADR-003). La LECTURE de la maquette est déjà couverte par le préfixe
  // `/api/recettes` de l'allowlist ; seul le déclenchement est ajouté ici.
  /^\/api\/recettes\/[^/]+\/perf-run$/,
  /^\/api\/e2e-tests\/[^/]+\/run$/,
  // SEULE écriture E2E permise à l'évaluateur : marquer un test « incohérent »
  // (signal comportement réel ≠ scénario) avec remarques. Créer / modifier /
  // obsoléter un test reste interdit (403) — l'évaluateur ne touche pas au code
  // de test (ADR-003).
  /^\/api\/e2e-tests\/[^/]+\/incoherent$/,
  /^\/api\/adr-vigilances\/[^/]+\/resolve$/,
];

// --- ACL rôle `executeur` (ADR-001/002) — allowlist FAIL-CLOSED -------------
// L'exécuteur accède à Vue d'ensemble, Tâches, Cadrage technique (onglet
// `cadrages`), Tests E2E, Fonctionnalités & Règles, Décisions, ADR et
// Workspaces (+ lecture Projets/Repos/Pièces/Sprints pour choisir un projet et
// tracer un sprint). Toute route NON listée est refusée en 403 (protection
// serveur, jamais l'UI). Les Déploiements sont atteints via le modal de tâche
// (`/api/deployments`, `/api/plans`, `/api/events`) — pas d'onglet dédié.
const EXECUTEUR_ALLOWED_API = [
  "/api/me", "/api/config", "/api/orgs", "/api/session/organization", "/api/render-md",
  "/api/projects", "/api/repos", "/api/pieces",
  "/api/features", "/api/rules", "/api/links", "/api/cardinality", "/api/sprints",
  "/api/docs", "/api/e2e-tests", "/api/e2e/jobs", "/api/e2e/agent-sessions", "/api/e2e/file",
  "/api/e2e-vars", "/api/cadrages", "/api/recettes", "/api/tasks", "/api/plans", "/api/events",
  "/api/deployments", "/api/decisions", "/api/batches", "/api/adr-vigilances", "/api/artifacts",
];
// Interdits EXPLICITES (défense en profondeur) : secrets E2E et gestion des
// utilisateurs restent hors périmètre exécuteur.
const EXECUTEUR_DENIED_API = ["/api/e2e-secrets", "/api/users"];
// Écritures autorisées (méthodes non-GET) : cadrages techniques (création,
// session, éléments, documents, terminaison → tâches), dépôt de pièces,
// lancement d'un test E2E, levée d'une vigilance ADR, création/édition de
// tâches et changement d'organisation active. Rien d'autre (sprints, features,
// rules, docs, vars/secrets, projets/repos, users… = 403).
const EXECUTEUR_WRITE_PATTERNS = [
  /^\/api\/session\/organization$/,
  /^\/api\/pieces$/,
  /^\/api\/cadrages$/,
  /^\/api\/cadrages\/[^/]+\/(items|documents|session|finish|tasks|recette-items)(\/.*)?$/,
  /^\/api\/e2e-tests\/[^/]+\/run$/,
  /^\/api\/adr-vigilances\/[^/]+\/resolve$/,
  /^\/api\/tasks$/,
  /^\/api\/tasks\/[^/]+\/(edit|archive|restore)$/,
];

// --- Routes « Cadrage technique » (ADR-004) --------------------------------
// `/api/cadrages*` est la route CANONIQUE du cadrage technique (plus d'alias :
// l'ancien alias `/api/cadrages*` → `/api/recettes*` est SUPPRIMÉ car
// `/api/recettes*` est désormais la route canonique de la RECETTE évaluateur —
// les deux objets ne peuvent pas partager le même chemin).

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_STORAGE_DIR = join(__dirname, "storage", "e2e");
mkdirSync(join(E2E_STORAGE_DIR, "inbox"), { recursive: true });
mkdirSync(join(E2E_STORAGE_DIR, "runs"), { recursive: true });
// Pièces binaires des RECETTES (recette évaluateur) — famille isolée.
const RECETTE_DOC_DIR = join(__dirname, "storage", "recette-docs");
mkdirSync(RECETTE_DOC_DIR, { recursive: true });
// MAQUETTES de recette (HTML/CSS/JS, données mock) — pages STATIQUES servies
// par le panneau via `GET /api/recettes/:id/maquette/*`. Le tool MCP
// `recette_maquette_add` écrit dans CE répertoire (même chemin des deux
// côtés). Garde anti-traversée stricte au service.
// `EVALUATION_MAQUETTE_DIR` (legacy) reste en FALLBACK une release (transition).
const RECETTE_MAQUETTE_DIR = process.env.RECETTE_MAQUETTE_DIR || process.env.EVALUATION_MAQUETTE_DIR || join(__dirname, "storage", "recette-maquettes");
mkdirSync(RECETTE_MAQUETTE_DIR, { recursive: true });
// RAPPORTS de PERFORMANCE (tests standard) + jobs de lancement asynchrone
// (`perf-jobs`). Le runner `perf-runner.mjs` écrit `report.json`/`report.md` ici.
// `EVALUATION_PERF_DIR` (legacy) reste en FALLBACK une release (transition).
const RECETTE_PERF_DIR = process.env.RECETTE_PERF_DIR || process.env.EVALUATION_PERF_DIR || join(__dirname, "storage", "recette-perf");
mkdirSync(join(RECETTE_PERF_DIR, "jobs"), { recursive: true });
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
loadEnv();
const DATABASE_URL = process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const REFRESH_S = Math.max(10, Number(process.env.PANEL_REFRESH_S) || 10);
const SESSION_BASE_URL = process.env.SESSION_BASE_URL || "https://dev.madatalk.fr";
const OPENCODE_BIN = process.env.OPENCODE_BIN || "/root/.opencode/bin/opencode";
// Données opencode ciblées (instance dédiée de l'utilisateur) : isole la base
// des sessions pour `opencode models`/`export` et les lancements d'agents.
const OPENCODE_DATA_HOME = process.env.OPENCODE_DATA_HOME || null;
const OC_ENV = OPENCODE_DATA_HOME ? { ...process.env, XDG_DATA_HOME: OPENCODE_DATA_HOME } : process.env;

// Organisation par défaut (cache court) — seule autorisée à configurer l'écosystème.
let _defaultOrgCache = { id: null, at: 0 };
async function getDefaultOrgId() {
  if (Date.now() - _defaultOrgCache.at < 60000) return _defaultOrgCache.id;
  try {
    const orgs = await pilot.listOrganizations();
    const def = (orgs || []).find((o) => o.isDefault);
    _defaultOrgCache = { id: def ? def.id : null, at: Date.now() };
  } catch { _defaultOrgCache = { id: _defaultOrgCache.id, at: Date.now() }; }
  return _defaultOrgCache.id;
}

// Liste des modèles disponibles (fournisseur/modèle), depuis `opencode models`,
// mise en cache 5 minutes.
let _modelsCache = { at: 0, models: [] };
function listModels() {
  const now = Date.now();
  if (_modelsCache.models.length && now - _modelsCache.at < 5 * 60 * 1000) return _modelsCache.models;
  try {
    const out = execFileSync(OPENCODE_BIN, ["models"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000, env: OC_ENV });
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

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8", ".zip": "application/zip", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const PUBLIC_EXT = [".css", ".js", ".svg", ".ico", ".png", ".woff", ".woff2", ".map"];
function isPublicAsset(path) {
  // Les routes d'API peuvent porter une extension statique (ex. sous-ressources de
  // maquette : `/api/recettes/:id/maquette/<slug>/style.css`) : le raccourci
  // d'asset public ne doit JAMAIS court-circuiter le routeur d'API (garde l.1662).
  if (path.startsWith("/api/")) return false;
  return PUBLIC_EXT.some((e) => path.toLowerCase().endsWith(e));
}

function serveFile(res, rel) {
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
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

// Renvoie les workspaces accessibles et leurs projets attachés selon l'organisation
// active et/ou la liste des projets assignés. Admin sans contrainte = null.
async function workspaceAccess(projectAccess, organizationId) {
  // Aucune contrainte (admin sans org active) → pas de filtre.
  if (projectAccess === null && !organizationId) return null;
  const conds = ["r.workspace IS NOT NULL"];
  const params = [];
  if (projectAccess !== null) {
    params.push(projectAccess);
    conds.push(`pr.project_id = ANY($${params.length})`);
  }
  if (organizationId) {
    params.push(organizationId);
    conds.push(`r.organization_id = $${params.length}`);
  }
  // LEFT JOIN pour récupérer tous les workspaces de l'org (même sans projet)
  // tout en listant les project_id attachés quand ils existent.
  const rows = (await registry().query(
    `SELECT DISTINCT r.workspace, pr.project_id FROM repos r
     LEFT JOIN project_repos pr ON pr.repo_id = r.id
     WHERE ${conds.join(" AND ")}`,
    params,
  )).rows;
  const allowedNames = new Set(rows.map((row) => row.workspace));
  const attachedProjects = new Map();
  for (const row of rows) {
    if (!row.project_id) continue;
    const set = attachedProjects.get(row.workspace) || new Set();
    set.add(row.project_id);
    attachedProjects.set(row.workspace, set);
  }
  return { allowedNames, attachedProjects };
}

async function registryStats(url, forcedOrg, ownerScope, projectAccess) {
  const archived = await archivedTaskIds();
  const db = registry();
  const project = url && url.searchParams ? url.searchParams.get("project") : null;
  const org = forcedOrg || (url && url.searchParams ? url.searchParams.get("org") : null);
  const accessOk = (proj) => projectAccess === null || projectAccess === undefined || projectAccess.includes(proj);
  const byStatus = {};
  let tasks = 0;
  let openDecisions = 0;
  try {
    const res = project
      ? await db.query(`SELECT t.id, t.organization_id, t.created_by, t.project, ${latestStatusSubquery()} AS status FROM tasks t WHERE t.project = $1`, [project])
      : await db.query(`SELECT t.id, t.organization_id, t.created_by, t.project, ${latestStatusSubquery()} AS status FROM tasks t`);
    const inScope = (r) => !archived.has(r.id)
      && (!org || (r.organization_id || "onirtech") === org)
      && (!ownerScope || r.created_by === ownerScope)
      && accessOk(r.project);
    const ids = new Set(res.rows.filter(inScope).map((r) => r.id));
    for (const r of res.rows) {
      if (!inScope(r)) continue;
      const st = r.status || "queued";
      byStatus[st] = (byStatus[st] || 0) + 1;
      tasks++;
    }
    const decRes = await db.query(
      `SELECT d.task_id FROM decisions d
       WHERE d.status = 'awaiting'
         AND (SELECT status FROM executions e WHERE e.task_id = d.task_id ORDER BY attempt DESC LIMIT 1) <> 'done'`,
    );
    openDecisions = decRes.rows.filter((d) => !archived.has(d.task_id) && ids.has(d.task_id)).length;
  } catch {
    /* registre indisponible */
  }
  return { tasks, byStatus, openDecisions, archived: archived.size, project: project || null };
}

// Garde : l'utilisateur (username) est-il propriétaire de l'entité (tasks/cadrages/e2e) ?
// Renvoie true si l'entité est introuvable (la route renverra 404 elle-même).
async function userOwnsEntity(username, kind, id) {
  const db = registry();
  try {
    if (kind === "tasks") {
      const r = (await db.query("SELECT created_by FROM tasks WHERE id = $1", [id])).rows[0];
      return !r || r.created_by === username;
    }
    if (kind === "cadrages") {
      const r = (await db.query("SELECT created_by FROM cadrages WHERE cadrage_id = $1", [id])).rows[0];
      return !r || r.created_by === username;
    }
    if (kind === "recettes") {
      const r = (await db.query("SELECT created_by FROM recettes WHERE recette_id = $1", [id])).rows[0];
      return !r || r.created_by === username;
    }
    if (kind === "e2e-tests") {
      const r = (await db.query("SELECT created_by FROM e2e_tests WHERE id = $1", [id])).rows[0];
      return !r || r.created_by === username;
    }
  } catch { return false; }
  return true;
}

// Table d'ACL par rôle restreint (source UNIQUE serveur, ADR-002). Les rôles
// absents (admin/supervisor) ne sont pas restreints par page.
const ROLE_ACL = {
  evaluateur: { label: "évaluateur", allowed: EVALUATEUR_ALLOWED_API, denied: EVALUATEUR_DENIED_API, writes: EVALUATEUR_WRITE_PATTERNS },
  executeur: { label: "exécuteur", allowed: EXECUTEUR_ALLOWED_API, denied: EXECUTEUR_DENIED_API, writes: EXECUTEUR_WRITE_PATTERNS },
};

// Garde ACL rôle-aware (FAIL-CLOSED) : renvoie `true` (et écrit un 403) si la
// requête sort du périmètre autorisé du rôle, `false` sinon. Ne concerne QUE les
// rôles restreints (`evaluateur`, `executeur`) — les autres sont inchangés.
// Lecture = allowlist de préfixes ; écriture = patterns explicites ; toute autre
// route API est refusée.
function enforceRoleAcl(user, path, method, res) {
  if (!user) return false;
  const acl = ROLE_ACL[user.role];
  if (!acl) return false;
  if (!path.startsWith("/api/")) return false;
  if (acl.denied.some((p) => path === p || path.startsWith(p + "/"))) {
    sendJson(res, 403, { error: `accès refusé — hors périmètre ${acl.label}` });
    return true;
  }
  const isRead = method === "GET" || method === "HEAD";
  const allowed = isRead
    ? acl.allowed.some((p) => path === p || path.startsWith(p + "/"))
    : acl.writes.some((re) => re.test(path));
  if (!allowed) {
    sendJson(res, 403, { error: `accès refusé — hors périmètre ${acl.label}` });
    return true;
  }
  return false;
}

// --- Périmètre SPRINT du rôle `executeur` (ADR-001/002) --------------------
// Un projet = UN sprint actif (nominal : `is_default = 0`, `status = 'open'`).
// Le SPRINT PAR DÉFAUT (`is_default = 1`) est l'ancre de traçage des anciens
// sprints (MCP `ensureDefaultSprint`) : il n'est PAS le sprint de travail.
// - défaut : l'exécuteur voit les éléments du sprint actif + ceux NON rattachés
//   à un sprint (anti sur-restriction tant que l'historique n'est pas rattaché) ;
//   les éléments rattachés à un AUTRE sprint (ancien / clôturé) sont exclus.
// - `?sprint=<id>` : traçage LECTURE SEULE d'un sprint précis (exact).
async function activeSprintId(projectId) {
  if (!projectId) return null;
  try {
    const r = await registry().query(
      "SELECT id FROM sprints WHERE project = $1 AND status = 'open' AND is_default = 0 ORDER BY created_at DESC, id DESC LIMIT 1",
      [projectId],
    );
    return r.rows[0] ? r.rows[0].id : null;
  } catch { return null; }
}

// Résout le périmètre sprint : `null` si le rôle n'est pas `executeur` (aucune
// restriction) ; sinon `{ sprintId, explicit }` (sprint actif, ou `?sprint=`).
async function executeurSprintScope(user, url, projectId) {
  if (!user || user.role !== "executeur") return null;
  const explicit = url.searchParams.get("sprint");
  if (explicit) return { sprintId: explicit, explicit: true };
  return { sprintId: await activeSprintId(projectId), explicit: false };
}

// Filtre d'ids selon le périmètre sprint. `table`/`idCol` sont des constantes
// internes (jamais des entrées utilisateur). Renvoie :
//   { mode: "exact", ids }   → ne garder QUE ces ids (`?sprint=`) ;
//   { mode: "exclude", ids } → EXCLURE ces ids (rattachés à un autre sprint) ;
//   null                     → aucune restriction.
async function sprintScopeIds(scope, table, idCol) {
  if (!scope || !scope.sprintId) return null;
  try {
    const r = scope.explicit
      ? await registry().query(`SELECT ${idCol} AS id FROM ${table} WHERE sprint_id = $1`, [scope.sprintId])
      : await registry().query(`SELECT ${idCol} AS id FROM ${table} WHERE sprint_id <> $1`, [scope.sprintId]);
    return { mode: scope.explicit ? "exact" : "exclude", ids: new Set(r.rows.map((x) => x.id)) };
  } catch { return null; }
}

function applySprintScope(rows, sc, keyOf) {
  if (!sc) return rows;
  return sc.mode === "exact" ? rows.filter((r) => sc.ids.has(keyOf(r))) : rows.filter((r) => !sc.ids.has(keyOf(r)));
}

async function registryTasks(url, forcedOrg, ownerScope, projectAccess, sprintScope = null) {
  const db = registry();
  const archived = await archivedTaskIds();
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  const org = forcedOrg || url.searchParams.get("org");
  const accessOk = (proj) => projectAccess === null || projectAccess === undefined || projectAccess.includes(proj);
  let rows = [];
  try {
    const res = await db.query(
      `SELECT t.id, t.project, t.type, t.priority, t.request, t.title, t.created_at, t.session_id, t.cadrage_status, t.cadrage_class, t.organization_id, t.created_by,
         ${latestStatusSubquery()} AS status,
         (SELECT attempt FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS attempt,
         (SELECT rework_count FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS rework_count,
         COALESCE(t.cadrage_id, (SELECT l.linked_task_id FROM task_links l WHERE l.task_id = t.id AND l.description LIKE 'Issu de la recette%' ORDER BY l.id LIMIT 1)) AS cadrage_source,
         (SELECT r.title FROM cadrages r WHERE r.cadrage_id = t.cadrage_id) AS cadrage_source_title,
         (SELECT ri.exec_order FROM cadrage_items ri WHERE ri.created_task_id = t.id ORDER BY ri.id LIMIT 1) AS cadrage_order,
         (SELECT ri.vigilance FROM cadrage_items ri WHERE ri.created_task_id = t.id ORDER BY ri.id LIMIT 1) AS cadrage_vigilance,
         EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.status = 'awaiting'
                 AND d.permission_id IS NULL AND d.kind <> 'cadrage'
                 AND (SELECT status FROM executions e WHERE e.task_id = t.id ORDER BY attempt DESC LIMIT 1) <> 'done') AS waiting_human
       FROM tasks t ORDER BY t.created_at DESC`,
    );
    rows = res.rows.filter((r) => !archived.has(r.id)
      && (!org || (r.organization_id || "onirtech") === org)
      && (!ownerScope || r.created_by === ownerScope)
      && accessOk(r.project));
    // Périmètre SPRINT (rôle `executeur`) : sprint actif par défaut, `?sprint=`
    // pour tracer un ancien sprint en lecture seule.
    rows = applySprintScope(rows, await sprintScopeIds(sprintScope, "task_sprints", "task_id"), (r) => r.id);
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
  // Repos ciblés de la tâche (ADR 09) — 1..N, défaut = tous ceux du projet.
  const taskRepos = await q(
    `SELECT r.id, r.name, r.git_path AS "repoDir", r.workspace, r.main_branch AS "mainBranch", r.e2e_repo_dir AS "e2eRepoDir", r.e2e_base_url AS "e2eBaseUrl"
     FROM repos r JOIN task_repos tr ON tr.repo_id = r.id
     WHERE tr.task_id = $1 ORDER BY r.name ASC`, [id],
  );
  const linkedTasks = await q(
    `SELECT l.linked_task_id, l.description, l.relation_type AS "relationType",
            t.request AS linked_request, t.cadrage_status AS linked_cadrage,
            (SELECT x.status FROM executions x WHERE x.task_id = l.linked_task_id ORDER BY attempt DESC LIMIT 1) AS linked_status,
            (SELECT COUNT(*) FROM plans p WHERE p.task_id = l.linked_task_id) AS linked_plans,
            (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = l.linked_task_id) AS linked_artifacts
     FROM task_links l LEFT JOIN tasks t ON t.id = l.linked_task_id
     WHERE l.task_id = $1 ORDER BY l.id ASC`,
    [id],
  );
  // Tâches émergentes créées depuis cette tâche (lien inverse emergent).
  const emergentFrom = await q(
    `SELECT t.id AS task_id, t.request, t.title, t.cadrage_status,
            (SELECT x.status FROM executions x WHERE x.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS status,
            l.description AS reason
     FROM task_links l JOIN tasks t ON t.id = l.task_id
     WHERE l.linked_task_id = $1 AND l.relation_type = 'emergent' ORDER BY l.id ASC`,
    [id],
  );
  let cadrage = null;
  const rec = (await q(
    `SELECT r.*, rt.task_id FROM cadrages r
     LEFT JOIN cadrage_tasks rt ON rt.cadrage_id = r.cadrage_id
     WHERE rt.task_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [id],
  ))[0];
  if (rec) {
    const items = mapCadrageItems(await q("SELECT id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, test_intent, doc_intent, status, created_task_id, created_at FROM cadrage_items WHERE cadrage_id = $1 ORDER BY id ASC", [rec.cadrage_id]));
    const tasks = (await q("SELECT task_id FROM cadrage_tasks WHERE cadrage_id = $1", [rec.cadrage_id])).map((x) => x.task_id);
    cadrage = { cadrageId: rec.cadrage_id, project: rec.project, repos: await reposOfProject(rec.project), title: rec.title, sessionId: rec.session_id, status: rec.status, confirmedAt: rec.confirmed_at, confirmedBy: rec.confirmed_by, tasks, items };
  }
  return { task: { ...task, repos: taskRepos }, executions, events, deployments, decisions, artifacts, sessions, linkedTasks, emergentFrom, cadrage, archived: (await archivedTaskIds()).has(id) };
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
  const project = url.searchParams.get("project");
  const limit = Number(url.searchParams.get("limit") || 200);
  let rows = [];
  try {
    if (taskId) {
      rows = (await db.query("SELECT * FROM events WHERE task_id = $1 ORDER BY seq DESC LIMIT $2", [taskId, limit])).rows;
    } else if (project) {
      rows = (await db.query(
        `SELECT e.* FROM events e JOIN tasks t ON t.id = e.task_id
         WHERE t.project = $1 ORDER BY e.seq DESC LIMIT $2`, [project, limit])).rows;
    } else {
      rows = (await db.query("SELECT * FROM events ORDER BY seq DESC LIMIT $1", [limit])).rows;
    }
  } catch { rows = []; }
  return { events: rows.filter((e) => !archived.has(e.task_id)) };
}

async function registryDeployments(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const project = url.searchParams.get("project");
  let rows = [];
  try {
    if (taskId) {
      rows = (await db.query("SELECT * FROM deployments WHERE task_id = $1 ORDER BY id DESC", [taskId])).rows;
    } else if (project) {
      rows = (await db.query(
        `SELECT d.* FROM deployments d JOIN tasks t ON t.id = d.task_id
         WHERE t.project = $1 ORDER BY d.id DESC LIMIT 500`, [project])).rows;
    } else {
      rows = (await db.query("SELECT * FROM deployments ORDER BY id DESC LIMIT 200")).rows;
    }
  } catch { rows = []; }
  return { deployments: rows.filter((d) => !archived.has(d.task_id)) };
}

 async function registryDecisions(url) {
   const db = registry();
   const archived = await archivedTaskIds();
   const taskId = url.searchParams.get("taskId");
   const project = url.searchParams.get("project");
   let rows = [];
   try {
     if (taskId) {
       rows = (await db.query(
           `SELECT d.*, t.title AS task_title, t.project AS task_project, t.request AS task_request
            FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id
            WHERE d.task_id = $1 ORDER BY d.id DESC`, [taskId])).rows;
     } else if (project) {
       rows = (await db.query(
           `SELECT d.*, t.title AS task_title, t.project AS task_project, t.request AS task_request
            FROM decisions d JOIN tasks t ON t.id = d.task_id
            WHERE t.project = $1 ORDER BY d.id DESC LIMIT 500`, [project])).rows;
     } else {
       rows = (await db.query(
           `SELECT d.*, t.title AS task_title, t.project AS task_project, t.request AS task_request
            FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id
            ORDER BY d.id DESC LIMIT 200`)).rows;
     }
   } catch { rows = []; }
   return { decisions: rows.filter((d) => !archived.has(d.task_id)) };
 }

// Taxonomie `doc_type` (source de vérité : public/docs/nomenclature-doc-type.md).
const DOC_TYPES = ["adr", "specs", "gherkin", "project_doc", "adr_file", "plan", "task_synthese",
  "task_report", "audit_report", "cadrage_report", "cadrage_doc", "recette_doc", "e2e_report", "e2e_video", "piece", "autre"];
const TASK_DOC_TYPES = ["plan", "task_synthese", "task_report", "audit_report", "autre"];
const CADRAGE_DOC_TYPES = ["cadrage_doc", "cadrage_report"];
// Pièces jointes d'une ÉVALUATION (« Recette » évaluateur) — famille ISOLÉE des
// pièces client (autorise lien/document/photo/vidéo, ADR-001).
const RECETTE_DOC_TYPES = ["recette_doc"];
const DOCS_DOC_TYPES = ["adr", "specs", "gherkin", "project_doc"];
const ARTIFACT_KINDS = ["plan", "audit", "report", "autre"];

// Gestionnaire CENTRAL d'artefacts (T-20260920-162801-jxtr) : liste TOUS les
// artefacts, toutes entités confondues, identifiés par (doc_type, content_id).
// Filtres : docType, contentId, kind, q (titre/path), project, taskId (rétrocompat).
async function registryArtifacts(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const project = url.searchParams.get("project");
  const docType = url.searchParams.get("docType");
  const contentId = url.searchParams.get("contentId");
  const kind = url.searchParams.get("kind");
  const qtext = url.searchParams.get("q");
  const conds = [];
  const params = [];
  if (taskId) {
    // Rétrocompat `artifact_list(taskId)` : famille task uniquement.
    params.push(taskId); conds.push(`a.content_id = $${params.length}`);
    params.push(TASK_DOC_TYPES); conds.push(`a.doc_type = ANY($${params.length})`);
  }
  if (docType) { params.push(docType); conds.push(`a.doc_type = $${params.length}`); }
  if (contentId) { params.push(contentId); conds.push(`a.content_id = $${params.length}`); }
  if (kind) { params.push(kind); conds.push(`a.kind = $${params.length}`); }
  if (qtext) { params.push(`%${qtext}%`); conds.push(`(a.title ILIKE $${params.length} OR a.path ILIKE $${params.length})`); }
  if (project) {
    params.push(project);
    conds.push(`(a.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id = $${params.length}) OR a.content_id IN (SELECT id FROM tasks WHERE project = $${params.length}))`);
  }
  params.push(TASK_DOC_TYPES);
  const taskTypeParam = params.length;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT a.*, t.title AS task_title, r.title AS cadrage_title, p.name AS project_name
       FROM artifacts a
       LEFT JOIN tasks t ON t.id = a.content_id AND a.doc_type = ANY($${taskTypeParam})
       LEFT JOIN cadrages r ON r.cadrage_id = a.content_id
       LEFT JOIN projects p ON p.id = a.content_id
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY a.id DESC LIMIT 1000`,
      params,
    )).rows;
  } catch { rows = []; }
  // Entité résolue (libellé) ; `archived` ne filtre QUE la famille task.
  const artifacts = rows
    .filter((a) => !(TASK_DOC_TYPES.includes(a.doc_type) && archived.has(a.content_id)))
    .map((a) => ({
      ...a,
      entity: a.content_id,
      entity_label: a.task_title || a.cadrage_title || a.project_name || a.content_id,
      entity_kind: a.task_title ? "task" : (a.cadrage_title ? "cadrage" : (a.project_name ? "project" : (String(a.content_id || "").startsWith("doc-") ? "doc" : "entity"))),
    }));
  return { artifacts };
}

// Ajout d'un artefact depuis le gestionnaire central (toute entité).
async function createArtifactCentral(b, user) {
  const db = registry();
  const docType = String(b.docType || "autre").trim();
  const kind = String(b.kind || "autre").trim();
  if (!DOC_TYPES.includes(docType)) throw new Error(`docType invalide : ${docType} (cf. public/docs/nomenclature-doc-type.md)`);
  if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind} (attendu : ${ARTIFACT_KINDS.join(" | ")})`);
  if (!b.contentId || !String(b.contentId).trim()) throw new Error("contentId requis (entité porteuse)");
  if (!b.path || !String(b.path).trim()) throw new Error("path requis (chemin absolu du fichier)");
  const artifactId = `ART-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const meta = b.meta && typeof b.meta === "object" ? b.meta : null;
  await db.query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, nature, source, meta, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [artifactId, docType, String(b.contentId).trim(), kind, b.title ?? null, String(b.path).trim(),
     b.nature ?? null, b.source || "import", meta,
     b.organizationId || (user && (user.activeOrganizationId || user.organizationId)) || null,
     new Date().toISOString(), (user && user.username) || null],
  );
  const artifact = (await db.query("SELECT * FROM artifacts WHERE artifact_id = $1", [artifactId])).rows[0];
  return { ok: true, artifact };
}

async function registryPlans(url) {
  const db = registry();
  const archived = await archivedTaskIds();
  const taskId = url.searchParams.get("taskId");
  const project = url.searchParams.get("project");
  let rows = [];
  try {
    if (project) {
      rows = (await db.query(
        `SELECT p.id, p.task_id, p.objective, p.deliverables, p.status, p.branch, p.created_at,
                (SELECT pe.status FROM plan_executions pe WHERE pe.plan_id = p.id ORDER BY pe.id DESC LIMIT 1) AS execution_status,
                (SELECT COUNT(*) FROM plan_commits pc WHERE pc.plan_id = p.id) AS commit_count
         FROM plans p JOIN tasks t ON t.id = p.task_id
         WHERE t.project = $1 ORDER BY p.created_at DESC`, [project])).rows;
    } else {
      rows = (await db.query(
        `SELECT p.id, p.task_id, p.objective, p.deliverables, p.status, p.branch, p.created_at,
                (SELECT pe.status FROM plan_executions pe WHERE pe.plan_id = p.id ORDER BY pe.id DESC LIMIT 1) AS execution_status,
                (SELECT COUNT(*) FROM plan_commits pc WHERE pc.plan_id = p.id) AS commit_count
         FROM plans p ORDER BY p.created_at DESC`)).rows;
    }
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
    // Le téléchargement ne dépend plus de `task_id` (artefact polymorphe).
    a = (await db.query("SELECT * FROM artifacts WHERE artifact_id = $1", [artifactId])).rows[0];
  } catch { return notFound(); }
  // Rétrocompat route legacy : contrôle souple (famille task uniquement).
  if (a && taskId && TASK_DOC_TYPES.includes(a.doc_type) && a.content_id !== taskId) return notFound();
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
    // La visionneuse ne dépend plus de `task_id` (artefact polymorphe).
    a = (await db.query("SELECT * FROM artifacts WHERE artifact_id = $1", [artifactId])).rows[0];
  } catch { return notFound(); }
  if (a && taskId && TASK_DOC_TYPES.includes(a.doc_type) && a.content_id !== taskId) return notFound();
  if (!a || !a.path) return notFound();
  if (!existsSync(a.path) || statSync(a.path).isDirectory()) return notFound();
  if (extname(a.path).toLowerCase() !== ".md") {
    return sendJson(res, 415, { error: "pas de visionneuse pour ce type de fichier (markdown uniquement)" });
  }
  const raw = readFileSync(a.path, "utf8");
  const html = marked.parse(raw);
  return sendJson(res, 200, { artifactId, taskId: a.content_id, docType: a.doc_type, kind: a.kind, title: a.title || basename(a.path), html });
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
  let role = u.role && ["admin", "supervisor", "evaluateur", "executeur"].includes(u.role) ? u.role : "executeur";
  if (u.is_admin) role = "admin";
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": cookieHeader(s.token) });
  res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username, is_admin: role === "admin", role } }));
}

async function handleLogout(req, res) {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": clearCookieHeader() });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUsers(req, res, user) {
  if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
  if (req.method === "GET") return sendJson(res, 200, { users: user.activeOrganizationId ? await listUsersByOrganization(user.activeOrganizationId) : await listUsers() });
  if (req.method === "POST") {
    const { username, password, role, organizationId, projectIds } = await readBody(req);
    if (!username || !password) return sendJson(res, 400, { error: "username et password requis" });
    try {
      // role : admin | supervisor | evaluateur | executeur (défaut executeur ; isAdmin rétrocompat).
      const u = await createUser(String(username), String(password), false, role || "executeur", organizationId);
      // Accès par projet (aucun par défaut).
      if (Array.isArray(projectIds) && projectIds.length) { try { await setUserProjects(u.id, projectIds); } catch {} }
      return sendJson(res, 201, { ok: true, user: { id: u.id, username: u.username, is_admin: u.is_admin ? true : false, role: (u.role || "executeur"), organizationId: u.organization_id || null } });
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
  if (req.method === "GET" && parts[3] === "organizations") {
    return sendJson(res, 200, { organizations: await listUserOrganizations(id) });
  }
  // Instance opencode dédiée (identité par utilisateur).
  if (parts[3] === "opencode") {
    if (req.method === "GET") {
      const oc = await getUserOpencode(id);
      if (!oc) return sendJson(res, 404, { error: "utilisateur inconnu" });
      return sendJson(res, 200, { username: oc.username, port: oc.port, password: oc.password, provisioned: !!(oc.port && oc.password), url: `https://${oc.username.toLowerCase()}.dev.madatalk.fr` });
    }
    if (req.method === "POST") {
      const { randomBytes } = await import("node:crypto");
      const oc = await getUserOpencode(id);
      if (!oc) return sendJson(res, 404, { error: "utilisateur inconnu" });
      const port = oc.port || (4200 + id);
      const password = oc.password || randomBytes(18).toString("base64url");
      try {
        execFileSync("node", ["/root/.config/opencode/scripts/opencode-user-provision.mjs", "--user", oc.username, "--port", String(port), "--password", password], { encoding: "utf8", timeout: 120000 });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 500) }); }
      await setUserOpencode(id, { port, password });
      return sendJson(res, 200, { ok: true, username: oc.username, port, password, url: `https://${oc.username.toLowerCase()}.dev.madatalk.fr` });
    }
    if (req.method === "DELETE") {
      const oc = await getUserOpencode(id);
      if (oc) { try { execFileSync("node", ["/root/.config/opencode/scripts/opencode-user-provision.mjs", "--user", oc.username, "--deprovision"], { encoding: "utf8", timeout: 60000 }); } catch {} }
      await setUserOpencode(id, { port: null, password: null });
      return sendJson(res, 200, { ok: true });
    }
  }
  if (req.method === "GET" && parts[3] === "projects") {
    return sendJson(res, 200, { projects: await listUserProjects(id) });
  }
  // Accès par projet (N:N) : remplace la liste des projets d'un utilisateur.
  if (req.method === "POST" && parts[3] === "projects") {
    const { projectIds } = await readBody(req);
    try {
      const projects = await setUserProjects(id, Array.isArray(projectIds) ? projectIds : []);
      return sendJson(res, 200, { ok: true, projects });
    } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
  }
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
  if (req.method === "POST" && parts[3] === "role") {
    const { role } = await readBody(req);
    if (!["admin", "supervisor", "evaluateur", "executeur"].includes(role)) return sendJson(res, 400, { error: "role invalide (admin|supervisor|evaluateur|executeur)" });
    if (id === user.id) return sendJson(res, 400, { error: "impossible de changer son propre rôle" });
    const u = await updateUserRole(id, role);
    if (!u) return sendJson(res, 404, { error: "utilisateur inconnu" });
    return sendJson(res, 200, { ok: true, user: { id: u.id, username: u.username, is_admin: u.is_admin ? true : false, role: u.role || "executeur" } });
  }
  if (req.method === "POST" && parts[3] === "organization") {
    const { organizationId } = await readBody(req);
    const u = await updateUserOrganization(id, organizationId ? String(organizationId) : null);
    if (!u) return sendJson(res, 404, { error: "utilisateur inconnu" });
    return sendJson(res, 200, { ok: true, user: { id: u.id, username: u.username, organizationId: u.organization_id || null } });
  }
  // Email de notification par utilisateur (v0.9.65) : destinataire des emails.
  if (req.method === "POST" && parts[3] === "notify-email") {
    const { email } = await readBody(req);
    const u = await setUserNotifyEmail(id, email ? String(email) : null);
    if (!u) return sendJson(res, 404, { error: "utilisateur inconnu" });
    return sendJson(res, 200, { ok: true, user: { id: u.id, username: u.username, notifyEmail: u.notify_email || null } });
  }
  // Appartenance N:N : remplace la liste des organisations d'un utilisateur.
  if (req.method === "POST" && parts[3] === "organizations") {
    const { organizationIds } = await readBody(req);
    try {
      const orgs = await setUserOrganizations(id, Array.isArray(organizationIds) ? organizationIds : []);
      return sendJson(res, 200, { ok: true, organizations: orgs });
    } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
  }
  return sendJson(res, 405, { error: "méthode non autorisée" });
}

function mapCadrageItems(rows) {
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
    testIntent: i.test_intent ? (() => { try { const o = JSON.parse(i.test_intent); return o && o.action ? o : null; } catch { return null; } })() : null,
    docIntent: i.doc_intent ? (() => { try { const o = JSON.parse(i.doc_intent); return o && o.action ? o : null; } catch { return null; } })() : null,
    status: i.status,
    createdTaskId: i.created_task_id ?? null,
    createdAt: i.created_at,
  }));
}

// Repos transverses par projet (project_repos — ADR 11) — la portée réelle
// d'un cadrage du projet. Indexé par project_id.
async function reposByProjectIds(ids) {
  if (!ids || !ids.length) return {};
  const rows = (await registry().query(
    `SELECT pr.project_id, pr.repo_id, pr.role, r.name, r.git_path AS repo_dir
     FROM project_repos pr LEFT JOIN repos r ON r.id = pr.repo_id
     WHERE pr.project_id = ANY($1) ORDER BY pr.repo_id`,
    [ids],
  )).rows;
  const map = {};
  for (const x of rows) (map[x.project_id] = map[x.project_id] || []).push({ repoId: x.repo_id, role: x.role, name: x.name || x.repo_id, repoDir: x.repo_dir });
  return map;
}

async function reposOfProject(project) {
  if (!project) return [];
  const m = await reposByProjectIds([project]);
  return m[project] || [];
}

// --- Provisionnement d'un workspace Coder pour un repo (ADR 09) --------------
// Si le repo n'a pas de workspace Coder, crée le workspace (workspace-create.mjs,
// clone du remote git + masquage du token), dérive le repoDir hôte depuis le
// volume monté sur /home/coder, puis enregistre workspace + repoDir sur le repo.
// Tokens Coder/git : si l'organisation n'en a pas enregistrés, ils sont demandés
// (400 avec code coder-token-required / git-token-required) avant toute création.
class ProvisionError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

async function deriveRepoGitUrl({ gitUrl, repoDir }) {
  if (gitUrl) return String(gitUrl).trim().replace(/^(https?:\/\/)[^@/]+@/, "$1");
  if (repoDir && existsSync(join(repoDir, ".git"))) {
    try {
      const out = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 20000 });
      const u = String(out || "").trim();
      if (u) return u.replace(/^(https?:\/\/)[^@/]+@/, "$1");
    } catch {}
  }
  return null;
}

async function provisionRepoWorkspace({ repoId, org, body, username }) {
  const orgs = await pilot.listOrganizations();
  const orgInfo = (orgs || []).find((o) => o.id === org) || null;
  if (orgInfo && !orgInfo.coderUrl) throw new ProvisionError("Organisation sans URL Coder configurée (coderUrl).", "coder-url-required");

  const gitUrl = await deriveRepoGitUrl({ gitUrl: prev(body && body.gitUrl), repoDir: prev(body && body.repoDir) });
  if (!gitUrl) throw new ProvisionError("Aucun remote git pour ce repo (gitUrl absent et pas de checkout hôte). Renseignez d'abord l'URL du dépôt.", "git-url-required");

  // Token git sélectionné pour la liaison repo↔projet (org_git_tokens).
  // Si un gitTokenId est fourni dans le body, on le propage à workspace-create.mjs
  // qui le résoudra via db (jamais de token en clair sur argv).
  const gitTokenId = prev(body && body.gitTokenId);
  const hasOrgGitToken = !!(orgInfo && orgInfo.hasGitToken) || (Array.isArray(orgInfo && orgInfo.gitTokens) && orgInfo.gitTokens.length > 0);
  const hasCoderToken = !!(orgInfo && orgInfo.hasCoderToken);
  const coderGiven = prev(body && body.coderToken);
  const gitGiven = prev(body && body.gitToken);
  if (!hasOrgGitToken && !gitTokenId && !gitGiven) throw new ProvisionError("Token git requis — l'organisation n'a pas de token git enregistré et aucun token sélectionné pour cette liaison (gitTokenId).", "git-token-required");
  if (!hasCoderToken && !coderGiven) throw new ProvisionError("Token Coder requis — l'organisation n'a pas de token Coder enregistré.", "coder-token-required");

  // Tokens fournis par l'utilisateur → mémorisés (chiffrés) sur l'organisation,
  // UNIQUEMENT si l'organisation n'en avait pas (ne jamais écraser un token actif).
  if ((!hasCoderToken && coderGiven) || (!hasOrgGitToken && gitGiven)) {
    await pilot.registerOrganization({
      id: org, name: (orgInfo && orgInfo.name) || org,
      coderToken: (!hasCoderToken && coderGiven) ? coderGiven : undefined,
      gitToken: (!hasOrgGitToken && gitGiven) ? gitGiven : undefined,
      by: username,
    });
  }

  const wsName = String((body && body.workspaceName) || repoId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!wsName) throw new ProvisionError("Impossible de dériver un nom de workspace valide.", "invalid-workspace-name");

  const args = [
    "/root/.config/opencode/scripts/workspace-create.mjs",
    "--org", org,
    "--name", wsName,
    ...(body && body.owner ? ["--owner", String(body.owner)] : []),
    ...(body && body.template ? ["--template", String(body.template)] : []),
    ...(gitTokenId ? ["--git-token-id", gitTokenId] : []),
    "--clone", gitUrl,
    "--repo", `/home/coder/${wsName}`,
    ...((Array.isArray(body && body.params) ? body.params : []).flatMap((p) => ["--param", String(p)])),
  ];
  let out;
  try {
    out = JSON.parse(execFileSync("node", args, { encoding: "utf8", timeout: 900000 }));
  } catch (e) {
    throw new ProvisionError("Échec de création du workspace : " + String(e && (e.stdout || e.stderr || e.message) || e).slice(0, 500), "provision-failed");
  }
  if (!out || !out.ok) {
    throw new ProvisionError("Échec de création du workspace : " + String((out && out.error) || JSON.stringify(out)).slice(0, 400), "provision-failed");
  }

  // repoDir hôte du checkout : source du volume monté sur /home/coder + wsName.
  let hostRepoDir = prev(body && body.repoDir) || `/home/coder/${wsName}`;
  if (out.container) {
    try {
      const src = execFileSync("docker", ["inspect", "-f", '{{range .Mounts}}{{if eq .Destination "/home/coder"}}{{.Source}}{{end}}{{end}}', out.container], { encoding: "utf8" }).trim();
      if (src) hostRepoDir = join(src, wsName);
    } catch {}
  }

  const repo = await pilot.registerRepo({ id: repoId, workspace: wsName, repoDir: hostRepoDir, organizationId: org, createdBy: username });
  return { ok: true, repoId, workspace: wsName, container: out.container || null, cloned: out.cloned || null, repoDir: hostRepoDir, gitSetup: out.gitSetup || null, repo };
}

// Valeur effective ('' / null / undefined → null) pour les champs libres.
function prev(v) { return (v === undefined || v === null || String(v).trim() === "") ? null : String(v).trim(); }

// --- Tests E2E (entités de 1er niveau) : lecture SQL + écritures via pilot --
function mapE2ETestRow(r) {
  return {
    e2eTestId: r.id,
    project: r.project,
    specFile: r.spec_file,
    scenario: r.scenario,
    title: r.title,
    description: r.description,
    gherkin: r.gherkin,
    sessionId: r.session_id,
    status: r.status,
    version: r.version,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by || null,
    // Signal évaluateur « comportement réel ≠ scénario » (statut INCOHERENT).
    incoherentRemarks: r.incoherent_remarks || null,
    incoherentBy: r.incoherent_by || null,
    incoherentAt: r.incoherent_at || null,
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
    skipReason: r.skip_reason,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
    paramValues: r.param_values,
  };
}

// Ligne e2e_tests (existence + repo source) pour les routes /:id.
 async function registryE2ETest(id) {
   try {
     const t = (await registry().query("SELECT id, project, spec_file, scenario FROM e2e_tests WHERE id = $1", [id])).rows[0] || null;
     if (!t) return null;
     // ADR 11 : repos traversés du test (le spec vit dans l'un d'eux).
     const repos = (await registry().query(
       `SELECT r.id, r.name, r.e2e_repo_dir AS "e2eRepoDir", r.e2e_base_url AS "e2eBaseUrl", r.workspace, r.main_branch AS "mainBranch"
        FROM e2e_test_repos x JOIN repos r ON r.id = x.repo_id
        WHERE x.e2e_test_id = $1 ORDER BY r.name ASC`, [id],
     )).rows;
     t.repos = repos || [];
     return t;
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

async function registryE2ETests(url, forcedOrg, ownerScope, projectAccess) {
  const db = registry();
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const taskId = url.searchParams.get("taskId");
  const conds = [];
  const params = [];
  if (project) {
    params.push(String(project));
    // ADR 11 : project = PROJET (produit) du test.
    conds.push(`t.project = $${params.length}`);
  } else if (projectAccess !== null && projectAccess !== undefined) {
    if (!projectAccess.length) conds.push("1 = 0");
    else { params.push(projectAccess); conds.push(`t.project = ANY($${params.length})`); }
  }
  if (forcedOrg) { params.push(forcedOrg); conds.push(`(t.organization_id = $${params.length})`); }
  if (ownerScope) { params.push(ownerScope); conds.push(`t.created_by = $${params.length}`); }
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
      `SELECT t.id, t.project, t.spec_file, t.scenario, t.title, t.description, t.status, t.version, t.meta, t.first_seen_at, t.updated_at, t.created_by,
              (SELECT COUNT(*) FROM task_e2e te WHERE te.e2e_test_id = t.id)::int AS task_count,
              (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_status,
              (SELECT x.origin FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_origin,
              (SELECT x.created_at FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_run_at
       FROM e2e_tests t ${where}
       ORDER BY t.updated_at DESC`,
      params,
    )).rows;
  } catch { rows = []; }
  // ADR 11 : repos traversés (ids) indexés par test, pour la table.
  const repoMap = {};
  if (rows.length) {
    try {
      const rr = (await db.query(
        "SELECT e2e_test_id, repo_id FROM e2e_test_repos WHERE e2e_test_id = ANY($1) ORDER BY repo_id", [rows.map((r) => r.id)],
      )).rows;
      for (const x of rr) (repoMap[x.e2e_test_id] = repoMap[x.e2e_test_id] || []).push(x.repo_id);
    } catch {}
  }
  const tests = rows.map((r) => ({
    ...mapE2ETestRow(r),
    // ADR 11 : project = projet (produit) unique ; repos = repos traversés.
    project: r.project,
    repos: repoMap[r.id] || [],
    taskCount: Number(r.task_count) || 0,
    lastStatus: r.last_status || null,
    lastOrigin: r.last_origin || null,
    lastRunAt: r.last_run_at || null,
  }));
  return { tests };
}

async function registryE2ETestDetail(res, id, user) {
  // Projection ÉVALUATEUR (ADR-003) : AUCUNE donnée technique. Les sections
  // `params` (paramètres du test), `projectVars` / `projectSecrets` (réglages
  // d'environnement), `docs` (ADR) et `linkedTasks` / `requiredOpenTasks`
  // (tâches liées) sont réservées aux rôles NON restreints. Fail-closed : pour
  // l'évaluateur elles ne sont ni calculées ni renvoyées.
  const isEvaluateur = !!(user && user.role === "evaluateur");
  const db = registry();
  let row = null;
  try { row = (await db.query("SELECT * FROM e2e_tests WHERE id = $1", [id])).rows[0]; } catch { row = null; }
  if (!row) return sendJson(res, 404, { error: "test E2E inconnu" });
  const q = async (sql, p = []) => (await db.query(sql, p).catch(() => ({ rows: [] }))).rows;
  const projects = (await q("SELECT project FROM e2e_test_projects WHERE e2e_test_id = $1 ORDER BY project", [id])).map((x) => x.project);
  // ADR 11 : repos traversés par le test (le spec vit dans l'un d'eux).
  const repos = (await q(
    `SELECT r.id, r.name, r.description, r.git_path AS "repoDir", r.workspace,
            r.main_branch AS "mainBranch", r.e2e_repo_dir AS "e2eRepoDir", r.e2e_base_url AS "e2eBaseUrl"
     FROM e2e_test_repos x JOIN repos r ON r.id = x.repo_id
     WHERE x.e2e_test_id = $1 ORDER BY r.name ASC`, [id],
  ));
  // Exécutions (preuve scénario ↔ comportement : rapport texte + vidéo) —
  // conservées pour TOUS les rôles, y compris l'évaluateur.
  const executions = (await q("SELECT * FROM e2e_executions WHERE e2e_test_id = $1 ORDER BY created_at DESC LIMIT 100", [id])).map(mapE2EExecRow);
  const test = {
    ...mapE2ETestRow(row),
    projects: projects.length ? projects : (row.project ? [row.project] : []),
    repos,
  };
  if (!isEvaluateur) {
    // ADR-12 : documents de référence du projet (contexte test-agent / cadrage).
    const docs = (await q(
      `SELECT DISTINCT a.artifact_id AS "docId", a.doc_type AS kind, a.title, a.path, a.description
       FROM artifacts a
       WHERE a.doc_type IN ('adr','specs','gherkin','project_doc')
         AND (a.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id = $1)
           OR a.artifact_id IN (SELECT ar.artifact_id FROM artifact_repos ar JOIN project_repos pr ON pr.repo_id = ar.repo_id WHERE pr.project_id = $1))
       ORDER BY a.doc_type, a.title NULLS LAST, a.created_at DESC`, [row.project],
    ));
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
    // Tâches REQUIRED (contrat BDD/TDD) dont la tâche n'est pas done → test « bloqué par ».
    const requiredOpenTasks = linkedTasks.filter((l) => l.relationType === "REQUIRED" && l.taskStatus !== "done")
      .map((l) => ({ taskId: l.taskId, title: l.taskTitle, taskStatus: l.taskStatus }));
    // Vars du projet (module vars unifié) disponibles au run — méta seulement.
    let projectVars = [];
    let projectSecrets = [];
    try {
      const d = await pilot.listE2EVars(row.project);
      projectVars = ((d && d.vars) || []).filter((v) => v.kind !== "secret");
      projectSecrets = ((d && d.vars) || []).filter((v) => v.kind === "secret").map((v) => ({ name: v.name, kind: v.kind, purpose: v.purpose }));
    } catch { projectVars = []; projectSecrets = []; }
    test.docs = docs; // ADR-12 : documents de référence du projet (contexte)
    test.params = params;
    test.linkedTasks = linkedTasks;
    test.requiredOpen = requiredOpenTasks.length;
    test.requiredOpenTasks = requiredOpenTasks;
    test.projectSecrets = projectSecrets;
    test.projectVars = projectVars;
  }
  return sendJson(res, 200, { test, executions });
}

// Crée une tâche depuis un test E2E (contrat BDD/TDD) et la lie en REQUIRED.
async function handleE2ECreateTask(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const { request, title, type, scope, priority, acceptanceCriteria, directExecution, extraRequest } = b || {};
  const project = t.project;
  if (!project) return sendJson(res, 400, { error: "le test n'a pas de projet (produit) — création de tâche impossible" });
  const taskRequest = (request && String(request).trim())
    ? String(request).trim()
    : `[Test E2E requis — ${t.spec_file} :: ${t.scenario}] ${extraRequest ? String(extraRequest).trim() : "Implémenter le comportement couvert par ce test (contrat BDD/TDD)."}`;
  const taskTitle = (title && String(title).trim()) || `E2E requis : ${t.scenario || t.title || t.e2eTestId}`;
  // ADR 11 : la tâche requise hérite des repos de code du test (couverture).
  const taskRepoIds = ((t.repos || []).map((r) => r && r.id).filter(Boolean)).length
    ? (t.repos || []).map((r) => r && r.id).filter(Boolean)
    : undefined;
  try {
    const created = await pilot.createTask({
      request: taskRequest,
      title: taskTitle,
      acceptanceCriteria: acceptanceCriteria || undefined,
      project,
      type: type || "feature",
      scope: scope || undefined,
      priority: priority || "normal",
      repoIds: taskRepoIds,
      directExecution: !!directExecution,
    });
    const taskId = created && (created.taskId || (created.task && created.task.id));
    if (!taskId) return sendJson(res, 500, { error: "tâche créée mais identifiant introuvable" });
    // Lie le test à la tâche en REQUIRED (le test ne passe que si la tâche est done).
    await pilot.linkE2ETest({ taskId, e2eTestId: id, relationType: "REQUIRED", reason: "Tâche requise pour que le test E2E (contrat) soit PASS." });
    return sendJson(res, 201, { ok: true, taskId, testId: id });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/requis|inconnu|projet/i.test(msg)) return sendJson(res, 400, { error: msg });
    return sendJson(res, 500, { error: msg });
  }
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

// Slug minimal d'un titre → nom de spec Playwright (création via agent).
function e2eTitleSlug(title) {
  const s = String(title || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "test";
}

async function handleE2ECreate(res, b, user) {
  const { project, specFile, scenario, title, description, coveredProjects, repoIds, repos, params, viaAgent, adrIds, organizationId } = b || {};
  const orgId = organizationId || (user && user.organizationId) || undefined;
  const createdBy = user && user.username;
  if (!project) return sendJson(res, 400, { error: "project requis (projet produit)" });
  const guard = e2eParamsGuard(params);
  if (guard) return sendJson(res, 400, { error: guard });
  // repos de code associés (ADR 11) : `repos` = alias `repoIds` (ids de repos).
  const repoList = (Array.isArray(repos) && repos.length ? repos : repoIds);
  const repoIdsFinal = Array.isArray(repoList) ? repoList.map((x) => x && String(x).trim()).filter(Boolean) : undefined;

  if (viaAgent) {
    // Création via test-agent : le spec n'existe pas encore. On enregistre une
    // entité DRAFT à l'emplacement cible (spec_file dérivé du titre, scenario =
    // titre), puis on lance la session de création (test-agent) rattachée au test.
    if (!title || !String(title).trim()) return sendJson(res, 400, { error: "title (comportement) requis pour créer un test via agent" });
    const slug = e2eTitleSlug(title);
    const specPath = (specFile && String(specFile).trim()) || `tests/playwright/${slug}.spec.ts`;
    const sc = (scenario && String(scenario).trim()) || String(title).trim();
    const r = await pilot.createE2ETest({ project, specFile: specPath, scenario: sc, title, description, coveredProjects, repoIds: repoIdsFinal, params, organizationId: orgId, createdBy });
    const test = r && r.test;
    if (!test) return sendJson(res, 500, { error: "création du test échouée" });
    // Passe l'entité en DRAFT (spec pas encore rédigé) puis lance la session.
    await pilot.draftE2ETest(test.e2eTestId);
    let session = null;
    try { session = await pilot.launchTestSession({ e2eTestId: test.e2eTestId, mode: "create", adrIds: Array.isArray(adrIds) ? adrIds : undefined }); } catch (e) { session = { error: (e && e.message) || String(e) }; }
    return sendJson(res, 201, { ok: true, test: { ...test, status: "DRAFT" }, session, viaAgent: true });
  }

  if (!specFile || !scenario) return sendJson(res, 400, { error: "project, specFile et scenario requis pour enregistrer un test existant" });
  const r = await pilot.createE2ETest({ project, specFile, scenario, title, description, coveredProjects, repoIds: repoIdsFinal, params, organizationId: orgId, createdBy });
  return sendJson(res, 201, { ok: true, test: r && r.test });
}

// Défauts E2E d'un projet : e2e_repo_dir / e2e_base_url du registre (mapping
// explicite renseigné via Projets), repli sur la convention de checkout hôte
// /root/<projet>-preprod pour les projets applicatifs.
async function e2eDefaultsForProject(project) {
  const fallback = { repoDir: `/root/${project}-preprod`, baseUrl: null };
  if (!project) return fallback;
  try {
    const r = (await registry().query("SELECT e2e_repo_dir, e2e_base_url FROM projects WHERE id = $1", [project])).rows[0];
    if (!r) return fallback;
    return {
      repoDir: (r.e2e_repo_dir && String(r.e2e_repo_dir).trim()) || `/root/${project}-preprod`,
      baseUrl: (r.e2e_base_url && String(r.e2e_base_url).trim()) || null,
    };
  } catch {
    return fallback;
  }
}

async function handleE2ERun(res, id, b) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const { repoDir, baseUrl, origin, taskId, specPattern, playwrightConfig, pwArgs, paramValues, secretNames, runFromRef } = b || {};
  // ADR 11 — repo d'exécution par défaut : parmi les repos traversés du test,
  // celui dont le checkout E2E contient le spec_file (repo « source » du spec) ;
  // sinon le 1er repo traversé qui a un e2e_repo_dir ; sinon convention hôte.
  const testRepos = (t.repos || []).filter((r) => r && r.e2eRepoDir);
  let defaultRepo = testRepos.find((r) => {
    try { return existsSync(join(String(r.e2eRepoDir).trim(), String(t.spec_file).replace(/^\.\//, ""))); } catch { return false; }
  });
  if (!defaultRepo) defaultRepo = testRepos[0];
  const fallbackRepoDir = defaultRepo ? defaultRepo.e2eRepoDir : `/root/${t.project}-preprod`;
  const fallbackBaseUrl = (defaultRepo && defaultRepo.e2eBaseUrl) || null;
  const finalRepoDir = (repoDir && String(repoDir).trim()) || fallbackRepoDir;
  const finalBaseUrl = (baseUrl && String(baseUrl).trim()) || fallbackBaseUrl || undefined;
  if (!finalRepoDir) return sendJson(res, 400, { error: "repoDir requis (dépôt applicatif à exécuter) — renseigner le checkout E2E d'un repo du test (Projets → Modifier le repo, champ e2eRepoDir)" });
  // SÉCURITÉ : un secret ne peut JAMAIS être transmis en clair dans paramValues.
  // La sélection se fait par NOM (secretNames) ; les valeurs sont déchiffrées et
  // injectées par le MCP au run. On rejette toute tentative de forcer une clé
  // secrète via paramValues.
  if (paramValues && typeof paramValues === "object") {
    let secretKeys = [];
    try {
      const s = await pilot.listE2ESecrets(t.project);
      secretKeys = (s && s.secrets || []).map((x) => x.name);
    } catch {}
    const forbidden = Object.keys(paramValues).filter((k) => secretKeys.includes(k));
    if (forbidden.length) return sendJson(res, 400, { error: `secret(s) non surchargeable(s) en clair — sélectionner par nom : ${forbidden.join(", ")}` });
  }
  // NB : `origin='recette'` (origine E2E déclenchée par la recette évaluateur) est
  // un contrat CONSERVÉ par ADR-004 — ne pas renommer en 'cadrage'.
  const runOrigin = ["manual", "task", "recette", "ci", "session"].includes(origin) ? origin : "manual";
  // Run ASYNCHRONE : le POST retourne immédiatement ; un worker détaché relaie
  // l'appel MCP e2e_run (jusqu'à 15 min) et écrit un marqueur de fin. Le front
  // suit l'état via le job (GET /api/e2e/jobs/:jobId) + l'historique du test.
  const E2E_JOBS = join(dirname(fileURLToPath(import.meta.url)), "storage", "e2e", "jobs");
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    mkdirSync(E2E_JOBS, { recursive: true });
  } catch {}
  const payload = {
    project: t.project,
    repoDir: String(finalRepoDir).trim(),
    baseUrl: finalBaseUrl,
    e2eTestId: t.id,
    origin: runOrigin,
    taskId: taskId || undefined,
    specPattern: specPattern || undefined,
    playwrightConfig: playwrightConfig || undefined,
    pwArgs,
    paramValues,
    secretNames,
    runFromRef: runFromRef || undefined,
  };
  const payloadFile = join(E2E_JOBS, `${jobId}.json`);
  const resultFile = join(E2E_JOBS, `${jobId}.result.json`);
  try { writeFileSync(payloadFile, JSON.stringify(payload, null, 2)); } catch (e) { return sendJson(res, 500, { error: "impossible d'écrire le job : " + e.message }); }
  const worker = join(dirname(fileURLToPath(import.meta.url)), "e2e-run-worker.mjs");
  let child;
  try {
    child = spawn("node", [worker, payloadFile, resultFile], { stdio: "ignore", detached: true });
    child.unref();
  } catch (e) {
    return sendJson(res, 500, { error: "impossible de lancer le worker : " + String((e && e.message) || e) });
  }
  return sendJson(res, 202, {
    ok: true, async: true, jobId, e2eTestId: t.id, origin: runOrigin,
    defaults: { project: t.project, repoDir: finalRepoDir, baseUrl: finalBaseUrl },
    message: `Run lancé en arrière-plan (job ${jobId}) — suivez l'état via l'historique du test (détail) ; il peut prendre plusieurs minutes.`,
  });
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

// Marque un test E2E INCOHERENT (signal ÉVALUATEUR : le comportement réel ne
// correspond pas au scénario / à la règle) avec des remarques OBLIGATOIRES.
// Unique écriture E2E permise à l'évaluateur (aucune modif du code de test).
async function handleE2EIncoherent(res, id, b, user) {
  const t = await registryE2ETest(id);
  if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
  const remarks = String((b && b.remarks) || "").trim();
  if (!remarks) return sendJson(res, 400, { error: "remarks requis (décrivez l'incohérence constatée)" });
  const by = (b && b.by) || (user && user.username) || null;
  try {
    return sendJson(res, 200, await pilot.markE2ETestIncoherent({ e2eTestId: id, remarks, by }));
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

// --- Redémarrage des instances opencode (systemd) ---------------------------
// Chaque utilisateur dispose d'une instance systemd `opencode@<user>.service` ;
// le redémarrage recharge la config des agents (modèles, permissions, skills).
const OPENCODE_SHARED_UNIT = "opencode.service";

// L'unité existe-t-elle ? (fichier d'unité présent OU instance chargée/démarrée)
function opencodeUnitExists(unit) {
  if (!/^opencode@[a-zA-Z0-9_-]+\.service$/.test(unit) && unit !== OPENCODE_SHARED_UNIT) return false;
  try {
    execFileSync("systemctl", ["list-unit-files", unit], { encoding: "utf8", timeout: 10000 });
    return true;
  } catch {
    // Instance non installée sur disque mais chargée/démarrée (démarrée à la volée).
    try {
      const out = execFileSync("systemctl", ["list-units", unit, "--all", "--no-legend", "--no-pager"], { encoding: "utf8", timeout: 10000 });
      return out.split("\n").some((l) => l.trim().split(/\s+/)[0] === unit);
    } catch {
      return false;
    }
  }
}

// Liste des instances opencode@<user>.service (fichiers + instance chargée) + opencode.service.
function listOpencodeUnits() {
  const units = new Set();
  const collect = (out) => {
    for (const line of out.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      // Exclut le template nu (opencode@.service) : non redémarrable sans instance.
      if (name && name.endsWith(".service") && !name.endsWith("@.service")) units.add(name);
    }
  };
  try {
    collect(execFileSync("systemctl", ["list-unit-files", "opencode@*.service", "--no-legend", "--no-pager"], { encoding: "utf8", timeout: 10000 }));
  } catch { /* aucun fichier d'unité template — on continue avec les instances chargées */ }
  try {
    collect(execFileSync("systemctl", ["list-units", "opencode@*.service", "--all", "--no-legend", "--no-pager"], { encoding: "utf8", timeout: 10000 }));
  } catch { /* idem */ }
  if (opencodeUnitExists(OPENCODE_SHARED_UNIT)) units.add(OPENCODE_SHARED_UNIT);
  return [...units].sort();
}

// --- Router ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname;
  try {
    await pruneSessions();

    if (path === "/healthz") return sendJson(res, 200, { ok: true, registry: true });

    if (path === "/login" && req.method === "GET") return serveFile(res, "login.html");
    if (path === "/api/login" && req.method === "POST") return handleLogin(req, res);

    // Asset statique HORS `/api/**` uniquement (cf. sous-ressources de maquette
    // `/api/recettes/:id/maquette/...`) : ce raccourci ne doit JAMAIS intercepter
    // une route d'API (voir l'invariant porté par isPublicAsset).
    if (isPublicAsset(path)) return serveFile(res, path.slice(1));

    // Documentation publique (markdown) — accessible sans authentification.
    if (path === "/docs") return redirect(res, "/docs/README.md");
    if (path.startsWith("/docs/")) {
      return path.endsWith(".md") ? serveDoc(res, path.slice(1)) : serveFile(res, path.slice(1));
    }

    const user = await currentUser(req);
    if (path === "/api/logout" && req.method === "POST") return handleLogout(req, res);

    // Vérification d'authentification pour nginx `auth_request` : 200 + en-tête
    // X-User si authentifié, 401 sinon. Sert à gater dev.madatalk.fr (opencode web).
    if (path === "/api/auth-check") {
      if (!user) return sendJson(res, 401, { error: "non authentifié" });
      // Port de l'instance opencode DÉDIÉE à l'utilisateur (routage nginx dynamique).
      let ocPort = "";
      try { const oc = await getUserOpencode(user.id); ocPort = oc && oc.port ? String(oc.port) : ""; } catch {}
      res.writeHead(200, { "Content-Type": "application/json", "X-User": user.username, "X-Opencode-Port": ocPort });
      return res.end(JSON.stringify({ ok: true, user: user.username, port: ocPort }));
    }

    if (!user) {
      if (path.startsWith("/api/")) return sendJson(res, 401, { error: "non authentifié" });
      return redirect(res, "/login");
    }

    // ACL rôles restreints (ADR-002) : refus 403 FAIL-CLOSED AVANT toute route
    // (`evaluateur`, `executeur` — dispatcher unique `enforceRoleAcl`).
    if (enforceRoleAcl(user, path, req.method, res)) return;

    // Rôle SUPERVISEUR / lecture seule (v0.9.29) : accès en LECTURE (GET)
    // uniquement. Toute méthode d'écriture (POST/PUT/DELETE/PATCH) est refusée
    // sauf pour un administrateur. La protection est côté serveur (jamais l'UI).
    if (user.isReadOnly && req.method !== "GET") {
      if (path.startsWith("/api/")) return sendJson(res, 403, { error: "lecture seule (rôle superviseur) — opération non autorisée" });
    }
    // Garde rôle `evaluateur` (ADR-002) : l'écriture est limitée à SES PROPRES
    // recettes évaluateur (items/documents/verdicts/finish). La création (sans id)
    // reste permise et est attribuée à l'évaluateur.
    if (user.role === "evaluateur" && req.method !== "GET") {
      const m = path.match(/^\/api\/recettes\/([^/]+)/);
      if (m) {
        const owned = await userOwnsEntity(user.username, "recettes", decodeURIComponent(m[1]));
        if (!owned) return sendJson(res, 403, { error: "accès en écriture limité à vos propres recettes" });
      }
    }

    if (path === "/api/me") return sendJson(res, 200, { user: { ...user, pages: allowedPages(user.role) } });
    // Change l'organisation ACTIVE de la session (isolation serveur). L'utilisateur
    // doit être membre de l'organisation ciblée.
    if (path === "/api/session/organization" && req.method === "POST") {
      const b = await readBody(req);
      const target = b && b.organizationId ? String(b.organizationId) : null;
      if (!target) return sendJson(res, 400, { error: "organizationId requis" });
      const member = (user.organizations || []).includes(target);
      if (!member) return sendJson(res, 403, { error: "vous n'appartenez pas à cette organisation" });
      await setSessionOrganization(sessionToken(req), target);
      return sendJson(res, 200, { ok: true, activeOrganizationId: target });
    }
    // Rendu markdown à la volée (GET, lecture) — utilisé par la vue d'approbation.
    if (path === "/api/render-md" && req.method === "GET") {
      const text = url.searchParams.get("text") || "";
      const html = text ? marked.parse(text) : "";
      return sendJson(res, 200, { html });
    }
    // Écosystème : configurable UNIQUEMENT par l'organisation par défaut.
    if (path === "/api/ecosystem") {
      const def = await getDefaultOrgId();
      if (def && user.activeOrganizationId !== def) return sendJson(res, 403, { error: "réservé à l'organisation par défaut" });
      return sendJson(res, 200, scanEcosystem());
    }
    if (path === "/api/models" && req.method === "GET") return sendJson(res, 200, { models: listModels() });
    const agentModelMatch = path.match(/^\/api\/agents\/([^/]+)\/model$/);
    if (agentModelMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
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
    // --- Redémarrage des instances opencode (admin uniquement) ---------------
    const opencodeRestartUserMatch = path.match(/^\/api\/opencode\/restart-user\/([^/]+)$/);
    if (opencodeRestartUserMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const username = decodeURIComponent(opencodeRestartUserMatch[1]);
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return sendJson(res, 400, { error: "username invalide (uniquement [a-zA-Z0-9_-])" });
      }
      const unit = `opencode@${username}.service`;
      if (!opencodeUnitExists(unit)) return sendJson(res, 404, { error: `service inconnu : ${unit}` });
      try {
        execFileSync("systemctl", ["restart", unit], { encoding: "utf8", timeout: 60000 });
        return sendJson(res, 200, { ok: true, service: unit });
      } catch (e) {
        const err = String((e && e.stderr) || (e && e.message) || e).slice(0, 500);
        return sendJson(res, 500, { ok: false, error: `redémarrage de ${unit} impossible : ${err}` });
      }
    }
    if (path === "/api/opencode/restart-all" && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      let units;
      try {
        units = listOpencodeUnits();
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `liste des services impossible : ${String((e && e.message) || e).slice(0, 500)}` });
      }
      if (!units.length) return sendJson(res, 200, { ok: true, restarted: [], failed: [], notice: "aucune instance opencode trouvée" });
      const restarted = [];
      const failed = [];
      for (const unit of units) {
        try {
          execFileSync("systemctl", ["restart", unit], { encoding: "utf8", timeout: 60000 });
          restarted.push(unit);
        } catch (e) {
          const err = String((e && e.stderr) || (e && e.message) || e).slice(0, 300);
          failed.push({ unit, error: err });
        }
      }
      return sendJson(res, 200, { ok: true, restarted, failed });
    }
    if (path === "/api/config") return sendJson(res, 200, { refreshSeconds: REFRESH_S, sessionBaseUrl: SESSION_BASE_URL });
    if (path === "/api/stats") return sendJson(res, 200, await registryStats(url, user.activeOrganizationId, user.ownerScope, user.projectAccess));

    if (path === "/api/workspaces" && req.method === "GET") {
      const r = await pilot.listWorkspaces(user.activeOrganizationId || undefined);
      let ws = (r && r.workspaces) || [];
      // Filtrage par accès PROJET / ORGANISATION : la source de vérité est la
      // table repos (+ project_repos pour les utilisateurs). L'admin sans org
      // active voit tout ; sinon il est limité à son organisation.
      // On en profite pour enrichir chaque workspace avec ses VRAIS projets
      // attachés (ceux des repos dont le workspace correspond).
      const access = await workspaceAccess(user.projectAccess, user.activeOrganizationId);
      if (access) {
        ws = ws.filter((w) => access.allowedNames.has(w.name));
        for (const w of ws) {
          const set = access.attachedProjects.get(w.name);
          w.attachedProjects = set ? [...set].sort() : [];
        }
      } else {
        // Admin sans org active : on enrichit quand même avec tous les projets attachés.
        const rows = (await registry().query(
          "SELECT DISTINCT r.workspace, pr.project_id FROM repos r LEFT JOIN project_repos pr ON pr.repo_id = r.id WHERE r.workspace IS NOT NULL",
        )).rows;
        const map = new Map();
        for (const row of rows) {
          const set = map.get(row.workspace) || new Set();
          set.add(row.project_id);
          map.set(row.workspace, set);
        }
        for (const w of ws) {
          const set = map.get(w.name);
          w.attachedProjects = set ? [...set].sort() : [];
        }
      }
      return sendJson(res, 200, { count: ws.length, workspaces: ws });
    }
    // --- Workspaces Coder : opérations CRUD (admin) -------------------------
    const wsShowMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (wsShowMatch && req.method === "GET") {
      const name = decodeURIComponent(wsShowMatch[1]);
      // Lecture seule : un utilisateur peut voir le détail si le workspace
      // correspond à un de ses projets assignés / à son organisation (admin = tous).
      const access = await workspaceAccess(user.projectAccess, user.activeOrganizationId);
      if (access && !access.allowedNames.has(name)) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.showWorkspace(name, user.activeOrganizationId || "onirtech")); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e).slice(0, 500) }); }
    }
    const wsStartMatch = path.match(/^\/api\/workspaces\/([^/]+)\/start$/);
    if (wsStartMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.startWorkspace(decodeURIComponent(wsStartMatch[1]), user.activeOrganizationId || "onirtech")); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e).slice(0, 500) }); }
    }
    const wsStopMatch = path.match(/^\/api\/workspaces\/([^/]+)\/stop$/);
    if (wsStopMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.stopWorkspace(decodeURIComponent(wsStopMatch[1]), user.activeOrganizationId || "onirtech")); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e).slice(0, 500) }); }
    }
    const wsRestartMatch = path.match(/^\/api\/workspaces\/([^/]+)\/restart$/);
    if (wsRestartMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.restartWorkspace(decodeURIComponent(wsRestartMatch[1]), user.activeOrganizationId || "onirtech")); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e).slice(0, 500) }); }
    }
    const wsDelMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (wsDelMatch && req.method === "DELETE") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.deleteWorkspace(decodeURIComponent(wsDelMatch[1]), user.activeOrganizationId || "onirtech")); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e).slice(0, 500) }); }
    }
    // Ouvre l'IDE web Coder d'un workspace SANS authentification Coder côté
    // utilisateur : pose le cookie de session Coder (token d'organisation,
    // renouvelé automatiquement) sur le domaine partagé, puis redirige vers l'app.
    if (path === "/api/coder/ide" && req.method === "GET") {
      const target = url.searchParams.get("url") || "";
      // Utilisateur restreint : n'ouvre que les workspaces de ses projets.
      if (user.projectAccess !== null && user.projectAccess !== undefined) {
        const access = await workspaceAccess(user.projectAccess, user.activeOrganizationId);
        let wsName = "";
        try { const m = new URL(target).pathname.match(/^\/@[^/]+\/([^/]+)\//); wsName = m ? decodeURIComponent(m[1]) : ""; } catch {}
        if (access && (!wsName || !access.allowedNames.has(wsName))) return sendJson(res, 403, { error: "workspace non autorisé" });
      }
      const r = await pilot.openCoderIde({ org: user.activeOrganizationId || "onirtech", targetUrl: target });
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      res.writeHead(302, { "Set-Cookie": r.cookies, Location: r.location });
      return res.end();
    }
    if (path === "/api/projects" && req.method === "GET") {
      const r = await pilot.listProjects();
      const all = (r && r.projects) || [];
      // Isolation : ne renvoie que les projets de l'organisation active.
      const projects = all.filter((p) => (!user.activeOrganizationId || (p.organizationId || "onirtech") === user.activeOrganizationId) && (user.projectAccess === null || user.projectAccess.includes(p.id)));
      return sendJson(res, 200, { projects });
    }
    // --- Repos (ADR 09) : dépôts physiques rattachables à 1..N projets ------
    if (path === "/api/repos" && req.method === "GET") {
      const projectId = url.searchParams.get("project") || "";
      const r = await pilot.listRepos(projectId || undefined);
      const all = (r && r.repos) || [];
      const repos = all.filter((rp) => (!user.activeOrganizationId || (rp.organizationId || "onirtech") === user.activeOrganizationId));
      return sendJson(res, 200, { repos });
    }
    if (path === "/api/repos" && req.method === "POST") {
      const b = await readBody(req);
      try { return sendJson(res, 200, await pilot.registerRepo({ ...b, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId, createdBy: user.username })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    const repoDelMatch = path.match(/^\/api\/repos\/([^/]+)$/);
    if (repoDelMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.deleteRepo(repoDelMatch[1])); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    const repoLinkMatch = path.match(/^\/api\/projects\/([^/]+)\/repos\/([^/]+)$/);
    if (repoLinkMatch && req.method === "PUT") {
      const b = await readBody(req).catch(() => ({}));
      try { return sendJson(res, 200, await pilot.linkRepoToProject({ projectId: repoLinkMatch[1], repoId: repoLinkMatch[2], role: (b && b.role) || undefined, gitTokenId: (b && b.gitTokenId) || undefined })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (repoLinkMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.unlinkRepoFromProject({ projectId: repoLinkMatch[1], repoId: repoLinkMatch[2] })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // --- Documents de référence (ADR-12) : registre générique docs ⇄ projets/repos ---
    // GET /api/docs?kind=&projectId=&repoId=&includeRepoDocs=1 — POST {kind,title,path,…}
    if (path === "/api/docs" && req.method === "GET") {
      try {
        const r = await pilot.listDocs({
          kind: url.searchParams.get("kind") || undefined,
          projectId: url.searchParams.get("projectId") || undefined,
          repoId: url.searchParams.get("repoId") || undefined,
          includeRepoDocs: url.searchParams.get("includeRepoDocs") === "1",
        });
        // A004 — Annonce au panneau, pour chaque doc, la disponibilité de son
        // contenu (fichier présent et/ou champs structurés) afin d'activer/
        // désactiver les actions « Regarder »/« Télécharger ».
        return sendJson(res, 200, { docs: ((r && r.docs) || []).map((d) => ({ ...d, ...docContentAvailability(d) })) });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/docs" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.filename && b.dataBase64) {
          // Import depuis le PC : fichier stocké côté serveur (storage/ref-docs).
          return sendJson(res, 201, await pilot.registerDocUpload({
            kind: b.kind, title: b.title, filename: b.filename, dataBase64: b.dataBase64,
            projectId: b.projectId, repoId: b.repoId,
            // Champs ADR structurés + rattachements (onglet ADR) — ne pas les perdre
            // sur le chemin d'import fichier.
            status: b.status, context: b.context, decision: b.decision, consequences: b.consequences,
            replacedBy: b.replacedBy, repoIds: b.repoIds, global: b.global,
            by: user.username,
          }));
        }
        return sendJson(res, 201, await pilot.registerDoc({ ...b, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId, createdBy: user.username }));
      }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const docDelMatch = path.match(/^\/api\/docs\/([^/]+)$/);
    if (docDelMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.deleteDoc(docDelMatch[1])); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // Édition d'un document de référence (ADR-12) : champs ADR structurés +
    // rattachements (addRepoIds / setGlobal) — requis par le CRUD de l'onglet ADR.
    if (docDelMatch && req.method === "PUT") {
      const b = await readBody(req);
      try { return sendJson(res, 200, await pilot.updateDoc({ docId: docDelMatch[1], ...b })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- PIÈCES CLIENT (ADR-001, item 4) : natures md/pdf/docx/lien Drive -----
    // GET /api/pieces?projectId=&nature=&emergent=&includeRequalified= — liste
    // unifiée (pièces nouvelles + docs ADR-12 requalifiés).
    if (path === "/api/pieces" && req.method === "GET") {
      try {
        const r = await pilot.listPieces({
          projectId: url.searchParams.get("projectId") || undefined,
          nature: url.searchParams.get("nature") || undefined,
          emergent: url.searchParams.get("emergent") === "1" ? true : (url.searchParams.get("emergent") === "0" ? false : undefined),
          includeRequalified: url.searchParams.get("includeRequalified") !== "0",
        });
        return sendJson(res, 200, { pieces: (r && r.pieces) || [] });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // POST /api/pieces — ajout d'une pièce : import PC (filename+dataBase64 →
    // storage/pieces), lien externe public (url) ou chemin référencé (path).
    // GARDE PHOTO/VIDÉO (défense en profondeur) AVANT toute écriture disque.
    if (path === "/api/pieces" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (!b.projectId) return sendJson(res, 400, { error: "projectId requis" });
        // 1) Garde natures (refus photo/vidéo, import ET lien) — AVANT écriture.
        pilot.assertPieceAllowed({ nature: b.nature, path: b.path, url: b.url, filename: b.filename });
        if (b.filename && b.dataBase64) {
          const PIECE_STORAGE = join(__dirname, "storage", "pieces");
          mkdirSync(PIECE_STORAGE, { recursive: true });
          const buf = Buffer.from(String(b.dataBase64), "base64");
          if (!buf.length) return sendJson(res, 400, { error: "fichier vide" });
          if (buf.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: "fichier trop volumineux (max 5 Mo)" });
          const safe = String(b.filename).replace(/[^\w.\-]+/g, "_").slice(-80) || "piece";
          const dest = join(PIECE_STORAGE, `${Date.now()}-${safe}`);
          writeFileSync(dest, buf);
          return sendJson(res, 201, await pilot.addPiece({
            projectId: b.projectId, nature: b.nature, title: b.title, path: dest,
            filename: b.filename, description: b.description, createdBy: user.username,
          }));
        }
        if (b.url) {
          return sendJson(res, 201, await pilot.addPiece({
            projectId: b.projectId, nature: b.nature || "lien", title: b.title, url: b.url,
            description: b.description, createdBy: user.username,
          }));
        }
        if (b.path) {
          return sendJson(res, 201, await pilot.addPiece({
            projectId: b.projectId, nature: b.nature, title: b.title, path: b.path,
            filename: b.filename, description: b.description, createdBy: user.username,
          }));
        }
        return sendJson(res, 400, { error: "pièce requise : filename+dataBase64, url ou path" });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // DELETE /api/pieces/:id — retire une pièce (famille `piece` uniquement).
    const pieceDelMatch = path.match(/^\/api\/pieces\/([^/]+)$/);
    if (pieceDelMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.removePiece({ pieceId: pieceDelMatch[1] })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // GET /api/pieces/file?path= — sert un fichier de pièce IMPORTÉ (restreint
    // à storage/pieces : jamais un chemin arbitraire du système).
    if (path === "/api/pieces/file" && req.method === "GET") {
      const piecePath = url.searchParams.get("path") || "";
      try {
        const PIECE_STORAGE = join(__dirname, "storage", "pieces");
        const abs = normalize(piecePath);
        if (!abs.startsWith(PIECE_STORAGE + "/") || !existsSync(abs) || statSync(abs).isDirectory()) {
          return sendJson(res, 404, { error: "fichier de pièce introuvable (ou hors storage/pieces)" });
        }
        const ext = extname(abs) || "";
        const base = (basename(abs, ext) || "piece").replace(/[^\w.\- ]+/g, "_").trim() || "piece";
        const filename = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext;
        const ct = MIME[ext.toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-store",
        });
        createReadStream(abs).pipe(res);
        return;
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // --- SPRINTS (ADR-001, T4) : CRUD + RAPPORT DE SPRINT téléchargeable ------
    // La clôture (manuelle via le panneau, ou automatique à l'échéance appliquée
    // par le registre AVANT lecture) est l'action OFFICIELLE qui bascule la garde
    // d'émergence : le panneau ne recalcule jamais l'émergence.
    // GET /api/sprints?projectId=&status= — liste (statut + dates).
    if (path === "/api/sprints" && req.method === "GET") {
      try {
        const r = await pilot.listSprints({
          projectId: url.searchParams.get("projectId") || undefined,
          status: url.searchParams.get("status") || undefined,
        });
        return sendJson(res, 200, {
          sprints: (r && r.sprints) || [],
          count: (r && r.count) || 0,
          autoClosed: (r && r.autoClosed) || [],
        });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/sprints — création à DURÉE PARAMÉTRABLE (startDate/endDate ISO).
    if (path === "/api/sprints" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (!b.projectId) return sendJson(res, 400, { error: "projectId requis" });
        return sendJson(res, 201, await pilot.createSprint({
          projectId: b.projectId,
          title: b.title,
          startDate: b.startDate || undefined,
          endDate: b.endDate || undefined,
          autoClose: typeof b.autoClose === "boolean" ? b.autoClose : undefined,
          pieces: Array.isArray(b.pieces) ? b.pieces : undefined,
          createdBy: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // GET /api/sprints/:id — détail complet (pièces/fonctionnalités/règles/tâches/cadrages).
    const sprintGetMatch = path.match(/^\/api\/sprints\/([^/]+)$/);
    if (sprintGetMatch && req.method === "GET") {
      try { return sendJson(res, 200, await pilot.getSprintDetail({ sprintId: decodeURIComponent(sprintGetMatch[1]) })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // DELETE /api/sprints/:id — SUPPRESSION d'un sprint. Refus DURS du registre
    // (sprint par défaut `[SPRINT_DEFAULT]`, tâches/cadrages `[SPRINT_LINKED]`)
    // → 409 avec message explicite affiché tel quel par le panneau.
    if (sprintGetMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.deleteSprint({ sprintId: decodeURIComponent(sprintGetMatch[1]) })); }
      catch (e) { return sendJson(res, 409, { error: String((e && e.message) || e) }); }
    }
    // POST /api/sprints/:id/close — CLÔTURE manuelle (déclenche l'émergence).
    const sprintCloseMatch = path.match(/^\/api\/sprints\/([^/]+)\/close$/);
    if (sprintCloseMatch && req.method === "POST") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.closeSprint({
          sprintId: decodeURIComponent(sprintCloseMatch[1]),
          reason: b.reason || undefined,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/sprints/:id/reopen — REPRISE (réouverture, suspend l'émergence).
    const sprintReopenMatch = path.match(/^\/api\/sprints\/([^/]+)\/reopen$/);
    if (sprintReopenMatch && req.method === "POST") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.reopenSprint({
          sprintId: decodeURIComponent(sprintReopenMatch[1]),
          endDate: b.endDate || undefined,
          autoClose: typeof b.autoClose === "boolean" ? b.autoClose : undefined,
          by: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/sprints/:id/pieces — rattachement de pièces client (atInit=true
    // pour un rattachement à la création, NON émergent).
    const sprintPiecesMatch = path.match(/^\/api\/sprints\/([^/]+)\/pieces$/);
    if (sprintPiecesMatch && req.method === "POST") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.attachSprintPieces({
          sprintId: decodeURIComponent(sprintPiecesMatch[1]),
          pieceIds: Array.isArray(b.pieceIds) ? b.pieceIds : (b.pieceId ? [b.pieceId] : []),
          atInit: b.atInit === true,
          by: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // GET /api/sprints/:id/report[?download=1] — RAPPORT DE SPRINT généré par le
    // registre (`sprint_report`). `download=1` → pièce jointe markdown.
    const sprintReportMatch = path.match(/^\/api\/sprints\/([^/]+)\/report$/);
    if (sprintReportMatch && req.method === "GET") {
      const sprintId = decodeURIComponent(sprintReportMatch[1]);
      try {
        const r = await pilot.sprintReport({ sprintId, format: "markdown" });
        const markdown = typeof r === "string" ? r : ((r && r.markdown) || "");
        if (url.searchParams.get("download") === "1") {
          const filename = `rapport-sprint-${sprintId}.md`;
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "no-store",
          });
          return res.end(markdown);
        }
        return sendJson(res, 200, { sprintId, markdown });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/sprints/:id/session — LANCE (ou REPREND) la session IA dédiée de
    // l'agent-sprint rattachée au sprint (`sprints.session_id`). Miroir de
    // `/api/cadrages/:id/session`. Corps `{ force }` : force=true démarre une
    // nouvelle session. Ne touche pas au statut open/close du sprint.
    const sprintSessionMatch = path.match(/^\/api\/sprints\/([^/]+)\/session$/);
    if (sprintSessionMatch && req.method === "POST") {
      let sb = {};
      try { sb = await readBody(req); } catch {}
      try {
        return sendJson(res, 200, await pilot.launchSprintSession({
          sprintId: decodeURIComponent(sprintSessionMatch[1]),
          force: !!(sb && sb.force),
          adrIds: (sb && sb.adrIds) || undefined,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- SESSION DE MIGRATION DES ANCIENS SPRINTS (ADR-001 §6) ----------------
    // Entité `migrations` d'un PROJET (type dédié), ancrée sur le sprint par
    // défaut (= l'ancien sprint). Le rattachement des éléments est idempotent et
    // ANTI-ÉMERGENT (jamais de marquage rétroactif) : le panneau ne fait que
    // relayer le registre.
    // GET /api/migrations?project=&limit= — liste des sessions de migration.
    if (path === "/api/migrations" && req.method === "GET") {
      try {
        const r = await pilot.listMigrations({
          project: url.searchParams.get("project") || undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        return sendJson(res, 200, { migrations: (r && r.migrations) || [], count: (r && r.count) || 0 });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/migrations — DÉMARRE (ou résout, idempotent) la session de
    // migration d'un projet ; ancre sur le sprint par défaut (ancien sprint).
    if (path === "/api/migrations" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (!b.projectId) return sendJson(res, 400, { error: "projectId requis" });
        return sendJson(res, 201, await pilot.startMigration({
          projectId: b.projectId,
          title: b.title || undefined,
          startDate: b.startDate || undefined,
          endDate: b.endDate || undefined,
          createdBy: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // GET /api/migrations/:id — détail (migration + sprint cible résolu).
    const migrationGetMatch = path.match(/^\/api\/migrations\/([^/]+)$/);
    if (migrationGetMatch && req.method === "GET") {
      try { return sendJson(res, 200, await pilot.getMigration({ migrationId: decodeURIComponent(migrationGetMatch[1]) })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/migrations/:id/session — LANCE (ou REPREND) la session IA dédiée
    // de l'agent-migration rattachée à la migration (`migrations.session_id`).
    // Miroir de `/api/sprints/:id/session`. Corps `{ force }`. Ne touche pas au
    // statut open/close du sprint.
    const migrationSessionMatch = path.match(/^\/api\/migrations\/([^/]+)\/session$/);
    if (migrationSessionMatch && req.method === "POST") {
      let mb = {};
      try { mb = await readBody(req); } catch {}
      try {
        return sendJson(res, 200, await pilot.launchMigrationSession({
          migrationId: decodeURIComponent(migrationSessionMatch[1]),
          force: !!(mb && mb.force),
          adrIds: (mb && mb.adrIds) || undefined,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- FONCTIONNALITÉS / RÈGLES MÉTIER (ADR-001, T5) : CRUD + liens N:N ----
    // GET /api/features?projectId=&emergent=&search=&limit=
    if (path === "/api/features" && req.method === "GET") {
      try {
        const r = await pilot.listFeatures({
          projectId: url.searchParams.get("projectId") || undefined,
          emergent: url.searchParams.get("emergent") === "1" ? true : (url.searchParams.get("emergent") === "0" ? false : undefined),
          search: url.searchParams.get("search") || undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        // Périmètre SPRINT (rôle `executeur`) : sprint actif par défaut (les
        // éléments rattachés à un autre sprint sont exclus), `?sprint=` = traçage.
        let features = (r && r.features) || [];
        const scope = await executeurSprintScope(user, url, url.searchParams.get("projectId"));
        features = applySprintScope(features, await sprintScopeIds(scope, "sprint_fonctionnalites", "fonctionnalite_id"), (f) => f.id);
        return sendJson(res, 200, { features, count: features.length });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/features — création (l'agent propose, l'humain valide/ajuste).
    if (path === "/api/features" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (!b.projectId) return sendJson(res, 400, { error: "projectId requis" });
        // GARDE ADMIN : une création demandée DANS UN CONTEXTE CADRAGE/CADRAGE
        // (`fromCadrage` explicite ou `cadrageId`) marque l'élément émergent
        // d'origine `cadrage` — réservée à l'administrateur (ADR-001 : « création
        // administrateur si manquant, marquée émergente »). La création STANDARD
        // (onglet Fonctionnalités & Règles, sans contexte cadrage) reste inchangée.
        const fromCadrage = b.fromCadrage === true || !!b.cadrageId;
        if (fromCadrage && !user.is_admin) {
          return sendJson(res, 403, { error: "réservé aux administrateurs — création d'une fonctionnalité depuis un cadrage" });
        }
        return sendJson(res, 201, await pilot.createFeature({
          projectId: b.projectId, ref: b.ref, role: b.role, userStory: b.userStory,
          sourcedPieceId: b.sourcedPieceId || undefined, cadrageId: b.cadrageId || undefined,
          fromCadrage: typeof b.fromCadrage === "boolean" ? b.fromCadrage : undefined,
          createdBy: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const featureMatch = path.match(/^\/api\/features\/([^/]+)$/);
    if (featureMatch && req.method === "GET") {
      try { return sendJson(res, 200, await pilot.getFeature({ featureId: decodeURIComponent(featureMatch[1]) })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    if (featureMatch && req.method === "PUT") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.updateFeature({
          featureId: decodeURIComponent(featureMatch[1]),
          ref: b.ref, role: b.role, userStory: b.userStory,
          sourcedPieceId: b.sourcedPieceId != null ? b.sourcedPieceId : undefined,
          // Qualification d'implémentation (T-20260921-133134-yz2i).
          implemented: typeof b.implemented === "boolean" ? b.implemented : undefined,
          implementedOrigin: b.implementedOrigin || undefined,
          implementedNote: b.implementedNote != null ? b.implementedNote : undefined,
          // Statut de développement (T-20260922-100651-m6va) — axe 3.
          devStatus: b.devStatus != null ? b.devStatus : undefined,
          devStatusSource: b.devStatusSource || undefined,
          devStatusNote: b.devStatusNote != null ? b.devStatusNote : undefined,
          by: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // DELETE /api/features/:id?cascadeAdrs=1 — SUPPRESSION d'une fonctionnalité
    // (+ liens CASCADE). Garde d'intégrité « ADR ≥ 1 fonctionnalité » : refus
    // `[ADR_LAST_FEATURE]` → 409 (le panneau propose alors la cascade ADR).
    if (featureMatch && req.method === "DELETE") {
      try {
        return sendJson(res, 200, await pilot.deleteFeature({
          featureId: decodeURIComponent(featureMatch[1]),
          cascadeAdrs: url.searchParams.get("cascadeAdrs") === "1",
          by: user.username,
        }));
      } catch (e) { return sendJson(res, 409, { error: String((e && e.message) || e) }); }
    }
    // GET /api/rules?projectId=&emergent=&search=&limit=
    if (path === "/api/rules" && req.method === "GET") {
      try {
        const r = await pilot.listRules({
          projectId: url.searchParams.get("projectId") || undefined,
          emergent: url.searchParams.get("emergent") === "1" ? true : (url.searchParams.get("emergent") === "0" ? false : undefined),
          search: url.searchParams.get("search") || undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        // Périmètre SPRINT (rôle `executeur`) — cf. GET /api/features.
        let rules = (r && r.rules) || [];
        const scope = await executeurSprintScope(user, url, url.searchParams.get("projectId"));
        rules = applySprintScope(rules, await sprintScopeIds(scope, "sprint_regles", "regle_id"), (x) => x.id);
        return sendJson(res, 200, { rules, count: rules.length });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/rules — création d'une règle métier.
    if (path === "/api/rules" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (!b.projectId) return sendJson(res, 400, { error: "projectId requis" });
        // GARDE ADMIN (miroir de POST /api/features) : création en contexte
        // cadrage/cadrage → émergente origine `cadrage`, réservée à l'admin.
        const fromCadrage = b.fromCadrage === true || !!b.cadrageId;
        if (fromCadrage && !user.is_admin) {
          return sendJson(res, 403, { error: "réservé aux administrateurs — création d'une règle depuis un cadrage" });
        }
        return sendJson(res, 201, await pilot.createRule({
          projectId: b.projectId, ref: b.ref, content: b.content,
          sourcedPieceId: b.sourcedPieceId || undefined, cadrageId: b.cadrageId || undefined,
          fromCadrage: typeof b.fromCadrage === "boolean" ? b.fromCadrage : undefined,
          // Association EXPLICITE de rôles (T-20260922-064200-e0yw).
          roles: Array.isArray(b.roles) ? b.roles : undefined,
          roleGlobal: typeof b.roleGlobal === "boolean" ? b.roleGlobal : undefined,
          createdBy: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
    if (ruleMatch && req.method === "GET") {
      try { return sendJson(res, 200, await pilot.getRule({ ruleId: decodeURIComponent(ruleMatch[1]) })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    if (ruleMatch && req.method === "PUT") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.updateRule({
          ruleId: decodeURIComponent(ruleMatch[1]),
          ref: b.ref, content: b.content,
          sourcedPieceId: b.sourcedPieceId != null ? b.sourcedPieceId : undefined,
          // Association EXPLICITE de rôles (T-20260922-064200-e0yw).
          roles: Array.isArray(b.roles) ? b.roles : undefined,
          roleGlobal: typeof b.roleGlobal === "boolean" ? b.roleGlobal : undefined,
          // Qualification d'implémentation (T-20260921-133134-yz2i).
          implemented: typeof b.implemented === "boolean" ? b.implemented : undefined,
          implementedOrigin: b.implementedOrigin || undefined,
          implementedNote: b.implementedNote != null ? b.implementedNote : undefined,
          // Statut de RESPECT (T-20260922-100651-m6va) — axe dédié, distinct.
          respectStatus: b.respectStatus != null ? b.respectStatus : undefined,
          respectStatusNote: b.respectStatusNote != null ? b.respectStatusNote : undefined,
          by: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // DELETE /api/rules/:id — SUPPRESSION d'une règle métier (+ liens CASCADE).
    if (ruleMatch && req.method === "DELETE") {
      try { return sendJson(res, 200, await pilot.deleteRule({ ruleId: decodeURIComponent(ruleMatch[1]) })); }
      catch (e) { return sendJson(res, 409, { error: String((e && e.message) || e) }); }
    }
    // POST /api/links — dispatcher de LIAISON N:N ({ kind, a, b }).
    if (path === "/api/links" && req.method === "POST") {
      const b = await readBody(req);
      try { return sendJson(res, 200, await pilot.linkEntities({ kind: b.kind, a: b.a, b: b.b })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // DELETE /api/links/:kind/:a/:b — retrait d'un lien N:N.
    const linkDelMatch = path.match(/^\/api\/links\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (linkDelMatch && req.method === "DELETE") {
      try {
        return sendJson(res, 200, await pilot.unlinkEntities({
          kind: decodeURIComponent(linkDelMatch[1]),
          a: decodeURIComponent(linkDelMatch[2]),
          b: decodeURIComponent(linkDelMatch[3]),
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- CARDINALITÉS / ÉMERGENCE (ADR-001 §5, T6) : lecture + clôture tracée -
    // GET /api/cardinality?projectId=&view= — agrégat (10 vues + signaux).
    if (path === "/api/cardinality" && req.method === "GET") {
      try {
        return sendJson(res, 200, await pilot.cardinalityReport({
          projectId: url.searchParams.get("projectId") || undefined,
          view: url.searchParams.get("view") || undefined,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // GET /api/cardinality/signals?projectId=&entityType=&entityId=&status=
    if (path === "/api/cardinality/signals" && req.method === "GET") {
      try {
        const r = await pilot.listCardinalitySignals({
          projectId: url.searchParams.get("projectId") || undefined,
          entityType: url.searchParams.get("entityType") || undefined,
          entityId: url.searchParams.get("entityId") || undefined,
          status: url.searchParams.get("status") || undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        return sendJson(res, 200, { signals: (r && r.signals) || [], count: (r && r.count) || 0 });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // POST /api/cardinality/signals/:id/resolve — clôture TRACÉE (résolution obligatoire).
    const cardSignalResolveMatch = path.match(/^\/api\/cardinality\/signals\/([^/]+)\/resolve$/);
    if (cardSignalResolveMatch && req.method === "POST") {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await pilot.resolveCardinalitySignal({
          signalId: decodeURIComponent(cardSignalResolveMatch[1]),
          resolution: b.resolution,
          resolvedBy: user.username,
        }));
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- Pièces jointes d'ADR (item 122) : 0..N documents/fichiers par ADR ----
    // Ajout : import PC (filename+dataBase64 → storage/ref-docs), document du
    // registre (targetDocId) ou fichier référencé par chemin (path).
    const docAttAddMatch = path.match(/^\/api\/docs\/([^/]+)\/attachments$/);
    if (docAttAddMatch && req.method === "POST") {
      const docId = docAttAddMatch[1];
      const b = await readBody(req);
      try {
        if (b.filename && b.dataBase64) {
          const DOC_STORAGE = join(__dirname, "storage", "ref-docs");
          mkdirSync(DOC_STORAGE, { recursive: true });
          const buf = Buffer.from(String(b.dataBase64), "base64");
          if (!buf.length) return sendJson(res, 400, { error: "fichier vide" });
          if (buf.length > 2 * 1024 * 1024) return sendJson(res, 400, { error: "fichier trop volumineux (max 2 Mo)" });
          const safe = String(b.filename).replace(/[^\w.\-]+/g, "_").slice(-80) || "fichier";
          const dest = join(DOC_STORAGE, `${Date.now()}-${safe}`);
          writeFileSync(dest, buf);
          return sendJson(res, 201, await pilot.addDocAttachment({
            docId, source: "import", path: dest,
            title: b.title || safe, kind: b.kind, nature: b.nature,
          }));
        }
        if (b.targetDocId) {
          return sendJson(res, 201, await pilot.addDocAttachment({
            docId, source: "registry", targetDocId: b.targetDocId,
            title: b.title, kind: b.kind, nature: b.nature,
          }));
        }
        if (b.path) {
          return sendJson(res, 201, await pilot.addDocAttachment({
            docId, source: b.source === "import" ? "import" : "ref", path: b.path,
            title: b.title, kind: b.kind, nature: b.nature,
          }));
        }
        return sendJson(res, 400, { error: "pièce jointe requise : filename+dataBase64, targetDocId ou path" });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // Retrait d'une pièce jointe (+ nettoyage du fichier importé sous storage/ref-docs).
    const docAttDelMatch = path.match(/^\/api\/docs\/([^/]+)\/attachments\/([^/]+)$/);
    if (docAttDelMatch && req.method === "DELETE") {
      const docId = docAttDelMatch[1];
      const attachmentId = docAttDelMatch[2];
      try {
        const doc = await pilot.docGet(docId);
        if (!doc) return sendJson(res, 404, { error: "document inconnu" });
        const att = (doc.attachments || []).find((a) => a.attachmentId === attachmentId);
        if (!att) return sendJson(res, 404, { error: "pièce jointe inconnue" });
        const r = await pilot.removeDocAttachment({ docId, attachmentId });
        // Suppression du fichier physique UNIQUEMENT si importé sous storage/ref-docs
        // (jamais un fichier du workspace/checkout).
        if (att.source === "import" && att.path) {
          const DOC_STORAGE = join(__dirname, "storage", "ref-docs");
          const abs = normalize(att.path);
          if (abs.startsWith(DOC_STORAGE + "/") && existsSync(abs)) {
            try { unlinkSync(abs); } catch {}
          }
        }
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // Téléchargement d'une pièce jointe (fichier importé OU référencé par chemin).
    const docAttDlMatch = path.match(/^\/api\/docs\/([^/]+)\/attachments\/([^/]+)\/download$/);
    if (docAttDlMatch && req.method === "GET") {
      const docId = docAttDlMatch[1];
      const attachmentId = docAttDlMatch[2];
      try {
        const doc = await pilot.docGet(docId);
        if (!doc) return sendJson(res, 404, { error: "document inconnu" });
        const att = (doc.attachments || []).find((a) => a.attachmentId === attachmentId);
        if (!att) return sendJson(res, 404, { error: "pièce jointe inconnue" });
        if (att.source === "registry") return sendJson(res, 400, { error: "pièce jointe du registre : consulter le document cible" });
        const abs = att.path;
        if (!abs || !existsSync(abs) || statSync(abs).isDirectory()) return sendJson(res, 404, { error: "fichier introuvable au chemin : " + (abs || "—") });
        const ext = extname(abs) || "";
        const base = (att.title || basename(abs, ext) || "piece-jointe").replace(/[^\w.\- ]+/g, "_").trim() || "piece-jointe";
        const filename = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext;
        const ct = MIME[ext.toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-store",
        });
        createReadStream(abs).pipe(res);
        return;
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // --- A001/A002/A003 — Disponibilité du contenu d'un document de référence ---
    // Le `path` n'est qu'une RÉFÉRENCE fichier (ADR-004) : le contenu structuré du
    // registre (context/décision/conséquences/description) doit rester lisible même
    // si le fichier est absent du disque. Ces helpers centralisent ce test et sont
    // déclarés en `function` (hoistés) car utilisés par GET /api/docs (plus haut).
    // A001 — Le document porte-t-il un contenu structuré exploitable ?
    function docHasStructuredContent(doc) {
      if (!doc) return false;
      return ["context", "decision", "consequences", "description"]
        .some((k) => typeof doc[k] === "string" && doc[k].trim() !== "");
    }
    // A002 — Markdown de repli construit UNIQUEMENT depuis les champs structurés du
    // registre (aucune lecture de fichier arbitraire). Renvoie null si vide.
    function docStructuredMarkdown(doc) {
      if (!docHasStructuredContent(doc)) return null;
      const parts = [`# ${doc.title || doc.docId || "Document"}`];
      if (doc.status) parts.push(`**Statut :** ${doc.status}`);
      if (doc.description) parts.push(`## Description\n\n${doc.description}`);
      if (doc.context) parts.push(`## Contexte\n\n${doc.context}`);
      if (doc.decision) parts.push(`## Décision\n\n${doc.decision}`);
      if (doc.consequences) parts.push(`## Conséquences\n\n${doc.consequences}`);
      return parts.join("\n\n") + "\n";
    }
    // A003 — Disponibilité du contenu : fichier présent sur le disque (prioritaire)
    // et/ou champs structurés du registre (repli). `contentAvailable` pilote
    // l'activation des actions « Regarder »/« Télécharger » dans le panneau.
    function docContentAvailability(doc) {
      const p = doc && doc.path;
      let hasFile = false;
      try { hasFile = !!p && existsSync(p) && !statSync(p).isDirectory(); } catch { hasFile = false; }
      const hasStructured = docHasStructuredContent(doc);
      return { hasFile, hasStructured, contentAvailable: hasFile || hasStructured };
    }
    // Lecture du CONTENU d'un document de référence (ADR-12) par docId : lit le
    // fichier au chemin enregistré (workspace/checkout ou storage/ref-docs) et le
    // rend (markdown / feature / texte brut). Restreint aux paths enregistrés.
    const docContentMatch = path.match(/^\/api\/docs\/([^/]+)\/content$/);
    if (docContentMatch && req.method === "GET") {
      try {
        const doc = await pilot.docGet(docContentMatch[1]);
        if (!doc) return sendJson(res, 404, { error: "document inconnu" });
        const abs = doc.path;
        // A005 — Priorité au fichier référencé s'il existe réellement sur le disque.
        if (abs && existsSync(abs) && !statSync(abs).isDirectory()) {
          const raw = readFileSync(abs, "utf8");
          const isMd = /\.(md|markdown)$/i.test(abs);
          const isFeature = /\.(feature)$/i.test(abs);
          let html = null;
          if (isMd) html = marked.parse(raw);
          else if (isFeature) html = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px">${String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
          return sendJson(res, 200, { title: doc.title || doc.docId, kind: doc.kind, path: abs, source: "file", html, raw: html ? null : raw.slice(0, 300000) });
        }
        // Repli : contenu structuré du registre (le fichier n'est qu'une référence,
        // ADR-004) — jamais de 404 « fichier introuvable » quand le contenu existe.
        const fallbackMd = docStructuredMarkdown(doc);
        if (fallbackMd) {
          return sendJson(res, 200, { title: doc.title || doc.docId, kind: doc.kind, path: abs || null, source: "structured", html: marked.parse(fallbackMd), raw: null });
        }
        // Dernier recours : ni fichier ni contenu structuré → 404 explicite.
        return sendJson(res, 404, { error: "aucun contenu disponible (ni fichier « " + (abs || "—") + " » ni champs structurés)" });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // Téléchargement d'un document de référence (ADR-12) : renvoie le fichier
    // en pièce jointe (Content-Disposition) pour l'enregistrer depuis le panel.
    const docDownloadMatch = path.match(/^\/api\/docs\/([^/]+)\/download$/);
    if (docDownloadMatch && req.method === "GET") {
      try {
        const doc = await pilot.docGet(docDownloadMatch[1]);
        if (!doc) return sendJson(res, 404, { error: "document inconnu" });
        const abs = doc.path;
        // A006 — Priorité au fichier référencé s'il existe réellement sur le disque.
        if (abs && existsSync(abs) && !statSync(abs).isDirectory()) {
          const ext = extname(abs) || "";
          const base = ((doc.title || basename(abs, ext)) || "document").replace(/[^\w.\- ]+/g, "_").trim() || "document";
          const filename = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext;
          const ct = MIME[ext.toLowerCase()] || (ext.toLowerCase() === ".feature" ? "text/plain; charset=utf-8" : "application/octet-stream");
          res.writeHead(200, {
            "Content-Type": ct,
            "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "no-store",
          });
          createReadStream(abs).pipe(res);
          return;
        }
        // Repli : pièce jointe `.md` générée depuis les champs structurés du registre
        // (le fichier n'est qu'une référence — ADR-004) ; jamais de 404 si le contenu
        // est disponible. Content-Disposition assaini + no-store conservés.
        const fallbackMd = docStructuredMarkdown(doc);
        if (fallbackMd) {
          const base = ((doc.title || doc.docId || "document").replace(/[^\w.\- ]+/g, "_").trim()) || "document";
          const filename = base.toLowerCase().endsWith(".md") ? base : base + ".md";
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "no-store",
          });
          res.end(fallbackMd);
          return;
        }
        // Dernier recours : ni fichier ni contenu structuré → 404 explicite.
        return sendJson(res, 404, { error: "aucun contenu disponible (ni fichier « " + (abs || "—") + " » ni champs structurés)" });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/projects" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createProject({ ...b, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId, createdBy: user.username }));
    }
    const projDelMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projDelMatch && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.deleteProject(projDelMatch[1]));
    }
    // --- Organisations (v0.9.47) : tenant de premier niveau (nom + description)
    if (path === "/api/orgs" && req.method === "GET") {
      return sendJson(res, 200, { organizations: await pilot.listOrganizations() });
    }
    if (path === "/api/orgs" && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const b = await readBody(req);
      try { return sendJson(res, 200, await pilot.registerOrganization({ id: b.id, name: b.name, description: b.description, isDefault: !!b.isDefault, coderUrl: b.coderUrl, coderToken: b.coderToken, coderTemplate: b.coderTemplate, gitToken: b.gitToken, by: user.username })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const orgDelMatch = path.match(/^\/api\/orgs\/([^/]+)$/);
    if (orgDelMatch && req.method === "DELETE") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.deleteOrganization(orgDelMatch[1])); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const orgDefaultMatch = path.match(/^\/api\/orgs\/([^/]+)\/default$/);
    if (orgDefaultMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.setDefaultOrganization(orgDefaultMatch[1])); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // --- Tokens git multiples par organisation (v0.10) -----------------------
    const orgGitTokenListMatch = path.match(/^\/api\/orgs\/([^/]+)\/git-tokens$/);
    if (orgGitTokenListMatch && req.method === "GET") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, { org: orgGitTokenListMatch[1], tokens: await pilot.listOrgGitTokens(orgGitTokenListMatch[1]) }); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    if (orgGitTokenListMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const b = await readBody(req);
      if (!b.name || !b.token) return sendJson(res, 400, { error: "name (libellé) et token requis" });
      try { return sendJson(res, 200, await pilot.addOrgGitToken({ org: orgGitTokenListMatch[1], name: b.name, token: b.token, by: user.username })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    const orgGitTokenDelMatch = path.match(/^\/api\/orgs\/([^/]+)\/git-tokens\/([^/]+)$/);
    if (orgGitTokenDelMatch && req.method === "DELETE") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      try { return sendJson(res, 200, await pilot.deleteOrgGitToken({ org: orgGitTokenDelMatch[1], id: orgGitTokenDelMatch[2] })); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    // Crée un workspace Coder pour l'organisation (+ clone git optionnel + masquage).
    if (path === "/api/workspaces" && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const b = await readBody(req);
      if (!b.name) return sendJson(res, 400, { error: "name (nom du workspace) requis" });
      try {
        const args = [
          "/root/.config/opencode/scripts/workspace-create.mjs",
          "--org", b.org || user.activeOrganizationId || "onirtech",
          "--name", String(b.name),
          ...(b.owner ? ["--owner", String(b.owner)] : []),
          ...(b.template ? ["--template", String(b.template)] : []),
          ...(b.clone ? ["--clone", String(b.clone)] : []),
          ...(b.repo ? ["--repo", String(b.repo)] : []),
          ...((Array.isArray(b.params) ? b.params : []).flatMap((p) => ["--param", String(p)])),
        ];
        const out = execFileSync("node", args, { encoding: "utf8", timeout: 900000 });
        return sendJson(res, 200, JSON.parse(out));
      } catch (e) { return sendJson(res, 500, { error: String((e && e.stdout) || (e && e.stderr) || (e && e.message) || e).slice(0, 800) }); }
    }
    // Masque le token git d'un dépôt DANS un workspace Coder (retire le token de
    // l'URL du remote + installe un credential helper qui lit le token 0600).
    const gitSetupMatch = path.match(/^\/api\/workspaces\/([^/]+)\/git-setup$/);
    if (gitSetupMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const b = await readBody(req);
      if (!b.repo) return sendJson(res, 400, { error: "repo (chemin dans le workspace) requis" });
      try {
        const out = execFileSync("node", [
          "/root/.config/opencode/scripts/workspace-git-setup.mjs",
          "--container", decodeURIComponent(gitSetupMatch[1]),
          "--repo", String(b.repo),
          ...(b.remote ? ["--remote", String(b.remote)] : []),
          ...(b.token ? ["--token", String(b.token)] : []),
        ], { encoding: "utf8", timeout: 120000 });
        return sendJson(res, 200, JSON.parse(out));
      } catch (e) { return sendJson(res, 500, { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 500) }); }
    }
    // Provisionne un workspace Coder pour un repo (ADR 09) : crée le workspace
    // via workspace-create.mjs (clone du remote + masquage du token), dérive le
    // repoDir hôte depuis le volume du conteneur, puis enregistre workspace +
    // repoDir sur le repo. Tokens Coder/git demandés si l'organisation n'en a pas.
    const repoProvMatch = path.match(/^\/api\/repos\/([^/]+)\/provision$/);
    if (repoProvMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await provisionRepoWorkspace({ repoId: decodeURIComponent(repoProvMatch[1]), org: user.activeOrganizationId || user.organizationId || "onirtech", body: b, username: user.username }));
      } catch (e) {
        return sendJson(res, e.status || 400, { error: String(e.message || e), code: e.code || "provision-failed" });
      }
    }
    if (path === "/api/tasks" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createTask({ ...b, createdBy: user.username, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId }));
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
    const cadrageMatch = path.match(/^\/api\/tasks\/([^/]+)\/cadrage$/);
    if (cadrageMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.resolveCadrage({ taskId: cadrageMatch[1], status: b.status, resolution: b.resolution, by: user.username }));
    }
    const resolveMatch = path.match(/^\/api\/decisions\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.resolveDecision({ decisionId: resolveMatch[1], status: b.status, resolution: b.resolution, by: user.username }));
    }

    // Ajout d'un artefact pour TOUTE entité (gestionnaire central).
    if (path === "/api/artifacts" && req.method === "POST") {
      const b = await readBody(req);
      try { return sendJson(res, 201, await createArtifactCentral(b, user)); }
      catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/artifacts") return sendJson(res, 200, await registryArtifacts(url));
    // Gestionnaire central : « Regarder » / « Télécharger » pour TOUT artefact.
    const artCentralView = path.match(/^\/api\/artifacts\/([^/]+)\/view$/);
    if (artCentralView) return viewArtifact(res, null, decodeURIComponent(artCentralView[1]));
    const artCentralDownload = path.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    if (artCentralDownload) return downloadArtifact(res, null, decodeURIComponent(artCentralDownload[1]));
    // Routes legacy (rétrocompat `view-md.html`).
    const artDownload = path.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/download$/);
    if (artDownload) return downloadArtifact(res, artDownload[1], artDownload[2]);
    const artView = path.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/view$/);
    if (artView) return viewArtifact(res, artView[1], artView[2]);
    if (path === "/api/archives") return sendJson(res, 200, await registryArchives());
    if (path === "/api/tasks") {
      const sprintScope = await executeurSprintScope(user, url, url.searchParams.get("project"));
      return sendJson(res, 200, await registryTasks(url, user.activeOrganizationId, user.ownerScope, user.projectAccess, sprintScope));
    }
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
        // ADR 11 : repos traversés par test lié.
        const repoMap2 = {};
        if (tests.length) {
          try {
            const rr2 = (await db.query("SELECT e2e_test_id, repo_id FROM e2e_test_repos WHERE e2e_test_id = ANY($1) ORDER BY repo_id", [tests.map((x) => x.id)])).rows;
            for (const x of rr2) (repoMap2[x.e2e_test_id] = repoMap2[x.e2e_test_id] || []).push(x.repo_id);
          } catch {}
        }
        return sendJson(res, 200, { taskId, task_id: taskId, tests: tests.map((r) => ({ e2eTestId: r.id, project: r.project, repos: repoMap2[r.id] || [], specFile: r.spec_file, scenario: r.scenario, title: r.title, testStatus: r.test_status, relationType: r.relation_type, reason: r.reason, lastExecutionId: r.last_execution_id, lastStatus: r.last_status, lastDurationMs: r.last_duration_ms, lastAttempts: r.last_attempts })), executions: execRows.map((r) => ({ id: r.id, e2eTestId: r.e2e_test_id, status: r.status, durationMs: r.duration_ms, attempts: r.attempts, executedAt: r.executed_at, summary: r.summary, skipReason: r.skip_reason, logsUrl: r.logs_url, videoUrl: r.video_url, reportArtifactId: r.report_artifact_id, commitSha: r.commit_sha, branch: r.branch, pipelineRef: r.pipeline_ref })) });
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
    // Phase D — cadrage (v0.8) : opérations de PROJET
    if (path === "/api/metrics/cadrage" && req.method === "GET") return sendJson(res, 200, await metrics.cadrage(registry()));
    if (path === "/api/cadrages" && req.method === "GET") {
      const project = url.searchParams.get("project");
      const conds = [];
      const params = [];
      if (project) { params.push(project); conds.push(`r.project = $${params.length}`); }
      if (user.activeOrganizationId) { params.push(user.activeOrganizationId); conds.push(`(r.organization_id = $${params.length})`); }
      // Périmètre propriétaire (`recetteOwnerScope`) : un évaluateur ne voit que
      // ses recettes ; admin/superviseur voient tout (scope = null).
      if (user.recetteOwnerScope) { params.push(user.recetteOwnerScope); conds.push(`r.created_by = $${params.length}`); }
      if (user.projectAccess !== null && user.projectAccess !== undefined) {
        if (!user.projectAccess.length) conds.push("1 = 0");
        else { params.push(user.projectAccess); conds.push(`r.project = ANY($${params.length})`); }
      }
      let rows = (await registry().query(
        `SELECT r.*,
           (SELECT COUNT(*) FROM cadrage_tasks rt WHERE rt.cadrage_id = r.cadrage_id) AS tasks_count,
           (SELECT COUNT(*) FROM cadrage_items i WHERE i.cadrage_id = r.cadrage_id) AS items_count,
           (SELECT COUNT(*) FROM artifacts a WHERE a.content_id = r.cadrage_id AND a.doc_type IN ('cadrage_doc','cadrage_report')) AS documents_count,
           (SELECT COUNT(*) FROM adr_vigilances v WHERE v.cadrage_id = r.cadrage_id AND v.status = 'open') AS adr_vigilances_count
         FROM cadrages r
         ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
         ORDER BY r.created_at DESC`,
        params,
      )).rows;
      // Périmètre SPRINT (rôle `executeur`) : sprint actif par défaut, `?sprint=`
      // pour tracer un ancien sprint (lecture seule).
      const sprintScope = await executeurSprintScope(user, url, project);
      rows = applySprintScope(rows, await sprintScopeIds(sprintScope, "cadrage_sprints", "cadrage_id"), (x) => x.cadrage_id);
      const reposMap = await reposByProjectIds([...new Set(rows.map((x) => x.project).filter(Boolean))]);
      for (const row of rows) row.repos = reposMap[row.project] || [];
      return sendJson(res, 200, { cadrages: rows });
    }
    // Vigilances ADR (item 126) — HISTORIQUE FILTRABLE append-only des ADR
    // manquantes / conflits remontés par les cadrages (et les tests). Lecture
    // seule (aucune route de suppression). Chaque point porte sa `reason` explicite.
    if (path === "/api/adr-vigilances" && req.method === "GET") {
      const r = await pilot.listAdrVigilances({
        projectId: url.searchParams.get("project") || undefined,
        cadrageId: url.searchParams.get("cadrageId") || undefined,
        type: url.searchParams.get("type") || undefined,
        status: url.searchParams.get("status") || undefined,
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      });
      const vigilancess = (r && r.vigilancess) || [];
      return sendJson(res, 200, { vigilancess, count: vigilancess.length });
    }
    // Levée TRACÉE d'un point de vigilance ADR (raison obligatoire).
    const adrVigResolve = path.match(/^\/api\/adr-vigilances\/([^/]+)\/resolve$/);
    if (adrVigResolve && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.resolveAdrVigilance({
        vigilanceId: decodeURIComponent(adrVigResolve[1]),
        resolution: b.resolution,
        resolutionKind: b.resolutionKind,
        adrId: b.adrId,
        resolvedBy: (user && user.username) || "human",
      }));
    }
    // Candidats : tâches NON encore couvertes par un cadrage (cadrage_status != done, non présentes dans cadrage_tasks).
    // Multi-projets : répéter le paramètre ?project=a&project=b (ou un seul).
    if (path === "/api/cadrages/candidates" && req.method === "GET") {
      const projects = url.searchParams.getAll("project").filter(Boolean);
      const where = [
        "t.cadrage_status = 'pending'",
        "NOT EXISTS (SELECT 1 FROM cadrage_tasks rt WHERE rt.task_id = t.id)",
      ];
      if (projects.length) where.push("t.project = ANY($1)");
      const rows = (await registry().query(
        `SELECT t.id, t.project, t.title, t.request, t.cadrage_status, t.created_at,
                (SELECT x.status FROM executions x WHERE x.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS status
         FROM tasks t
         WHERE ${where.join(" AND ")}
         ORDER BY t.created_at DESC`,
        projects.length ? [projects] : [],
      )).rows;
      return sendJson(res, 200, { candidates: rows });
    }
    if (path === "/api/cadrages" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createCadrage({ project: b.project, title: b.title, description: b.description, taskIds: b.taskIds, documents: b.documents, featureIds: b.featureIds, ruleIds: b.ruleIds, adrIds: b.adrIds, by: user.username, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId }));
    }
    const cadrageAction = path.match(/^\/api\/cadrages\/([^/]+)\/(session|finish)$/);
    if (cadrageAction && req.method === "POST") {
      if (cadrageAction[2] === "session") {
        let sb = {};
        try { sb = await readBody(req); } catch {}
        return sendJson(res, 200, await pilot.launchCadrageSession({ cadrageId: cadrageAction[1], force: !!(sb && sb.force), adrIds: (sb && sb.adrIds) || undefined, featureIds: (sb && sb.featureIds) || undefined, ruleIds: (sb && sb.ruleIds) || undefined }));
      }
      // ADR-001/002 : le cadrage technique n'est PAS du ressort de l'évaluateur
      // (pas de conversion en tâches). Refus explicite.
      if (user.role === "evaluateur") return sendJson(res, 403, { error: "conversion d'un cadrage en tâches interdite au rôle évaluateur (ADR-001/002)" });
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.finishCadrage({ cadrageId: cadrageAction[1], items: b.items, by: user.username, launchMode: b.launchMode, createTasks: b.createTasks !== false, maxParallel: b.maxParallel }));
    }
    const cadrageTaskAdd = path.match(/^\/api\/cadrages\/([^/]+)\/tasks$/);
    if (cadrageTaskAdd && req.method === "POST") {
      // ADR-001/002 : rattacher/détacher des tâches = cadrage technique → interdit.
      if (user.role === "evaluateur") return sendJson(res, 403, { error: "gestion des tâches d'un cadrage interdite au rôle évaluateur (ADR-001/002)" });
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addCadrageTask({ cadrageId: cadrageTaskAdd[1], taskId: b.taskId }));
    }
    const cadrageTaskDel = path.match(/^\/api\/cadrages\/([^/]+)\/tasks\/([^/]+)$/);
    if (cadrageTaskDel && req.method === "DELETE") {
      if (user.role === "evaluateur") return sendJson(res, 403, { error: "gestion des tâches d'un cadrage interdite au rôle évaluateur (ADR-001/002)" });
      return sendJson(res, 200, await pilot.removeCadrageTask({ cadrageId: cadrageTaskDel[1], taskId: decodeURIComponent(cadrageTaskDel[2]) }));
    }
    const cadrageItemDel = path.match(/^\/api\/cadrages\/([^/]+)\/items\/([0-9]+)$/);
    if (cadrageItemDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeCadrageItem({ cadrageId: cadrageItemDel[1], itemId: Number(cadrageItemDel[2]) }));
    }
    const cadrageItemEdit = path.match(/^\/api\/cadrages\/([^/]+)\/items\/([0-9]+)$/);
    if (cadrageItemEdit && (req.method === "PATCH" || req.method === "POST")) {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.updateCadrageItem({ cadrageId: cadrageItemEdit[1], itemId: Number(cadrageItemEdit[2]), fields: b.fields || b }));
    }
    // Reprise d'un ÉLÉMENT DE RECETTE ÉVALUATEUR par un CADRAGE technique (traçage
    // « repris par le cadrage X »). L'écriture est autorisée à l'exécuteur via
    // EXECUTEUR_WRITE_PATTERNS ; la GARDE « a_traiter » est portée par le registre.
    const cadrageEvalItems = path.match(/^\/api\/cadrages\/([^/]+)\/recette-items$/);
    if (cadrageEvalItems && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.linkCadrageRecetteItem({ cadrageId: cadrageEvalItems[1], itemId: b.itemId, by: user.username }));
    }
    const cadrageEvalItemDel = path.match(/^\/api\/cadrages\/([^/]+)\/recette-items\/([0-9]+)$/);
    if (cadrageEvalItemDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.unlinkCadrageRecetteItem({ cadrageId: cadrageEvalItemDel[1], itemId: Number(cadrageEvalItemDel[2]) }));
    }
    const cadrageDocView = path.match(/^\/api\/cadrages\/([^/]+)\/documents\/([0-9]+)\/view$/);
    if (cadrageDocView && req.method === "GET") {
      const d = (await registry().query("SELECT * FROM artifacts WHERE id = $1 AND doc_type = ANY($2)", [Number(cadrageDocView[2]), CADRAGE_DOC_TYPES])).rows[0];
      if (!d || !d.path || !existsSync(d.path)) return sendJson(res, 404, { error: "document introuvable" });
      const raw = readFileSync(d.path, "utf8");
      const html = /\.md$/i.test(d.path) ? marked.parse(raw) : null;
      return sendJson(res, 200, { title: d.title || d.path.split("/").pop(), html, raw: html ? null : raw });
    }
    const cadrageDocAction = path.match(/^\/api\/cadrages\/([^/]+)\/documents$/);
    if (cadrageDocAction && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addCadrageDocument({ cadrageId: cadrageDocAction[1], mode: b.mode, filename: b.filename, dataBase64: b.dataBase64, artifactId: b.artifactId, nature: b.nature, title: b.title }));
    }
    const cadrageDocDel = path.match(/^\/api\/cadrages\/([^/]+)\/documents\/([0-9]+)$/);
    if (cadrageDocDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeCadrageDocument({ documentId: Number(cadrageDocDel[2]) }));
    }
    const cadrageDetail = path.match(/^\/api\/cadrages\/([^/]+)$/);
    if (cadrageDetail && req.method === "GET") {
      const r = (await registry().query(
        `SELECT r.*, (SELECT COUNT(*) FROM cadrage_tasks rt WHERE rt.cadrage_id = r.cadrage_id) AS tasks_count FROM cadrages r WHERE r.cadrage_id = $1`,
        [cadrageDetail[1]],
      )).rows[0];
      if (!r) return sendJson(res, 404, { error: "cadrage inconnu" });
      const items = mapCadrageItems((await registry().query(
        "SELECT id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, test_intent, doc_intent, status, created_task_id, created_at FROM cadrage_items WHERE cadrage_id = $1 ORDER BY id ASC",
        [r.cadrage_id],
      )).rows);
      // Éléments de recette évaluateur REPRIS par ce cadrage technique (traçage
      // « repris par le cadrage X ») — lecture SQL directe de la table de lien
      // (`cadrage_recette_items`, créée par le plan MCP …-mcp-20260922-113243).
      const recetteItems = (await registry().query(
        `SELECT i.id, i.recette_id, i.content, i.category, i.severity, i.discussion, i.status, i.decision, i.created_at,
                e.title AS recette_title
           FROM cadrage_recette_items cei
           JOIN recette_items i ON i.id = cei.recette_item_id
           JOIN recettes e ON e.recette_id = i.recette_id
          WHERE cei.cadrage_id = $1 ORDER BY i.id ASC`,
        [r.cadrage_id],
      )).rows.map((i) => ({ itemId: Number(i.id), recetteId: i.recette_id, recetteTitle: i.recette_title || null, category: i.category, severity: i.severity, content: i.content, status: i.status, decision: i.decision, createdAt: i.created_at }));
      const tasks = (await registry().query(
        `SELECT rt.task_id, t.project, t.title, t.request FROM cadrage_tasks rt LEFT JOIN tasks t ON t.id = rt.task_id
         WHERE rt.cadrage_id = $1 ORDER BY rt.task_id`, [r.cadrage_id],
      )).rows.map((x) => ({ taskId: x.task_id, project: x.project || '', title: x.title || x.task_id, request: x.request || '' }));
      const docs = (await registry().query(
        `SELECT d.id, d.artifact_id, d.title, d.nature, d.source, d.path, d.created_at,
                a.title AS artifact_title, a.content_id AS artifact_task
         FROM artifacts d LEFT JOIN artifacts a ON a.artifact_id = (d.meta->>'artifactId')
         WHERE d.content_id = $1 AND d.doc_type = ANY($2) ORDER BY d.id ASC`, [r.cadrage_id, CADRAGE_DOC_TYPES],
      )).rows;
      // FONCTIONNALITÉS / RÈGLES MÉTIER rattachées au cadrage (ADR-001 : un
      // cadrage doit être rattaché à ≥1 fonctionnalité et des règles métier).
      // Lecture SQL directe des tables de lien existantes ; l'émergence est
      // exposée (origine `cadrage` pour les éléments créés depuis le cadrage).
      const fonctionnalites = (await registry().query(
        `SELECT f.id, f.ref, f.role, f.user_story, f.emergent, f.emergent_origin
           FROM cadrage_fonctionnalites rf
           JOIN fonctionnalites f ON f.id = rf.fonctionnalite_id
          WHERE rf.cadrage_id = $1 ORDER BY f.ref ASC`, [r.cadrage_id],
      )).rows.map((f) => ({ id: f.id, ref: f.ref, role: f.role ?? null, userStory: f.user_story, emergent: !!f.emergent, emergentOrigin: f.emergent_origin ?? null }));
      const regles = (await registry().query(
        `SELECT g.id, g.ref, g.content, g.emergent, g.emergent_origin
           FROM cadrage_regles rr
           JOIN regles_metier g ON g.id = rr.regle_id
          WHERE rr.cadrage_id = $1 ORDER BY g.ref ASC`, [r.cadrage_id],
      )).rows.map((g) => ({ id: g.id, ref: g.ref, content: g.content, emergent: !!g.emergent, emergentOrigin: g.emergent_origin ?? null }));
      // A001 — ADR DE CE CADRAGE : union de deux mécanismes de rattachement qui
      // coexistent : (1) la table de lien canonique `cadrage_adr` (tool MCP
      // `cadrage_adr_link`) ; (2) les ADR rattachées comme DOCUMENTS à la
      // création (`createCadrage` → `cadrage_doc_add`, source `import`, path =
      // chemin de l'ADR). La jointure documents→ADR se fait par `path`
      // (`artifacts.doc_type = 'adr'`) ; l'union est dédupliquée par `adrId`
      // (UNION, pas UNION ALL). Le statut est lu en direct sur `artifacts.status`
      // (jamais figé dans la chaîne `nature`).
      const adrs = (await registry().query(
        `SELECT a.artifact_id AS adr_id, a.title, a.status, a.path, a.kind, a.doc_type
           FROM artifacts a
           JOIN cadrage_adr ra ON ra.adr_id = a.artifact_id
          WHERE ra.cadrage_id = $1
         UNION
         SELECT a.artifact_id AS adr_id, a.title, a.status, a.path, a.kind, a.doc_type
           FROM artifacts a
           JOIN artifacts d ON d.path = a.path
          WHERE d.content_id = $1 AND d.doc_type = ANY($2) AND a.doc_type = 'adr'
          ORDER BY adr_id ASC`,
        [r.cadrage_id, CADRAGE_DOC_TYPES],
      )).rows.map((a) => ({ adrId: a.adr_id, title: a.title ?? null, status: a.status ?? null, path: a.path ?? null, kind: a.kind ?? null, docType: a.doc_type }));
      // A002 — TÂCHES GÉNÉRÉES DEPUIS LES ÉLÉMENTS : une entrée par élément de
      // cadrage portant un `created_task_id`, avec le titre/projet de la tâche et
      // son statut (dernière exécution, même sous-requête que le reste du panneau).
      // LEFT JOIN : une tâche supprimée laisse `title`/`project`/`status` NULL —
      // le rendu retombe sur `badge(status || 'queued')` et affiche l'identifiant.
      const generatedTasks = (await registry().query(
        `SELECT ci.id AS item_id, ci.title AS item_title, ci.classification,
                ci.created_task_id AS task_id, t.title, t.project,
                ${latestStatusSubquery()} AS status
           FROM cadrage_items ci
           LEFT JOIN tasks t ON t.id = ci.created_task_id
          WHERE ci.cadrage_id = $1 AND ci.created_task_id IS NOT NULL
          ORDER BY ci.id ASC`,
        [r.cadrage_id],
      )).rows.map((x) => ({ itemId: Number(x.item_id), itemTitle: x.item_title ?? null, classification: x.classification, taskId: x.task_id, title: x.title ?? null, project: x.project ?? null, status: x.status ?? null }));
      // Points de vigilance ADR (item 126) — historique + points OUVERTs qui
      // BLOQUENT la terminaison (la modale de clôture les affiche avec la raison).
      let adrVigilances = [];
      try { const v = await pilot.listAdrVigilances({ cadrageId: r.cadrage_id }); adrVigilances = (v && v.vigilancess) || []; } catch {}
      return sendJson(res, 200, { cadrage: { ...r, repos: await reposOfProject(r.project), tasks, items, recetteItems, documents: docs, fonctionnalites, regles, adrs, generatedTasks, adrVigilances, adrVigilancesOpen: adrVigilances.filter((x) => x.status === "open") } });
    }
    // SUPPRESSION d'un CADRAGE ENTIER (cadrage technique) — ADMIN uniquement.
    // Nettoyage en CASCADE de toute sa famille polymorphe côté registre. Route
    // canonique `/api/cadrages/:id` (ADR-004).
    // L'exécuteur est déjà refusé (aucun motif `^/api/cadrages/[^/]+$` dans
    // EXECUTEUR_WRITE_PATTERNS) ; la garde admin couvre aussi le rôle `user`.
    if (cadrageDetail && req.method === "DELETE") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      return sendJson(res, 200, await pilot.deleteCadrage({ cadrageId: cadrageDetail[1] }));
    }
    // =========================================================================
    // ÉVALUATIONS — « Recette » de l'ÉVALUATEUR PRODUIT (T-20260922-100650-sbc1).
    // Objet de 1er niveau DISTINCT du Cadrage technique (`/api/cadrages*`).
    // Routes ADDITIVES (aucune collision). Périmètre propriétaire via
    // `recetteOwnerScope` (l'évaluateur ne voit que SES recettes).
    // =========================================================================
    if (path === "/api/recettes" && req.method === "GET") {
      const project = url.searchParams.get("project");
      const conds = [];
      const params = [];
      if (project) { params.push(project); conds.push(`e.project = $${params.length}`); }
      if (user.activeOrganizationId) { params.push(user.activeOrganizationId); conds.push(`(e.organization_id = $${params.length})`); }
      if (user.recetteOwnerScope) { params.push(user.recetteOwnerScope); conds.push(`e.created_by = $${params.length}`); }
      if (user.projectAccess !== null && user.projectAccess !== undefined) {
        if (!user.projectAccess.length) conds.push("1 = 0");
        else { params.push(user.projectAccess); conds.push(`e.project = ANY($${params.length})`); }
      }
      params.push(RECETTE_DOC_TYPES);
      const rows = (await registry().query(
        `SELECT e.*,
           (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = e.recette_id) AS items_count,
           (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = e.recette_id AND i.decision = 'a_traiter') AS treatable_count,
           (SELECT COUNT(*) FROM recette_fonctionnalites ef WHERE ef.recette_id = e.recette_id) AS features_count,
           (SELECT COUNT(*) FROM recette_regles er WHERE er.recette_id = e.recette_id) AS rules_count,
           (SELECT COUNT(*) FROM artifacts a WHERE a.content_id = e.recette_id AND a.doc_type = ANY($${params.length})) AS documents_count
         FROM recettes e
         ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
         ORDER BY e.created_at DESC`,
        params,
      )).rows;
      const reposMap = await reposByProjectIds([...new Set(rows.map((x) => x.project).filter(Boolean))]);
      for (const row of rows) row.repos = reposMap[row.project] || [];
      return sendJson(res, 200, { recettes: rows });
    }
    if (path === "/api/recettes" && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.createRecette({ project: b.project, title: b.title, description: b.description, featureIds: b.featureIds, ruleIds: b.ruleIds, documents: b.documents, by: user.username, organizationId: b.organizationId || user.activeOrganizationId || user.organizationId }));
    }
    // Pièce binaire d'une évaluation (document/photo/vidéo) — AVANT /:id.
    if (path === "/api/recettes/file" && req.method === "GET") {
      const rel = url.searchParams.get("p") || "";
      const abs = normalize(join(RECETTE_DOC_DIR, rel));
      if (!abs.startsWith(RECETTE_DOC_DIR + "/") || !existsSync(abs)) return sendJson(res, 404, { error: "introuvable" });
      const ext = extname(abs).toLowerCase();
      // MIME photo/vidéo étendus : vidéos de parcours (iPhone .mov, .avi, .mkv,
      // .m4v) et images (.heic, .bmp, .tiff) servies *inline* comme .mp4/.webm.
      const VIDEO_MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".m4v": "video/x-m4v" };
      const type = VIDEO_MIME[ext] || (/^\.(png|jpe?g|gif|webp|heic|bmp|tiff)$/.test(ext) ? `image/${ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext.slice(1)}`
        : (/^\.pdf$/.test(ext) ? "application/pdf"
        : (/^\.json$/.test(ext) ? "application/json; charset=utf-8" : "application/octet-stream")));
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
    // MAQUETTE d'évaluation — PAGE STATIQUE servie par le panneau (URL). Chemin :
    // `/api/recettes/:id/maquette/<slug>/<fichier>`. Garde anti-traversée
    // stricte (`normalize` + confinement) + MIME allowlist (html/css/js/json/svg/
    // png…). Aucune exécution serveur : les fichiers sont servis tels quels.
    const evalMaquette = path.match(/^\/api\/recettes\/([^/]+)\/maquette\/(.+)$/);
    if (evalMaquette && req.method === "GET") {
      let rel = "";
      try { rel = decodeURIComponent(evalMaquette[2]); } catch { return sendJson(res, 400, { error: "chemin invalide" }); }
      const abs = normalize(join(RECETTE_MAQUETTE_DIR, decodeURIComponent(evalMaquette[1]), rel));
      if (!abs.startsWith(RECETTE_MAQUETTE_DIR + "/") || !existsSync(abs) || !statSync(abs).isFile()) return sendJson(res, 404, { error: "maquette introuvable" });
      const ext = extname(abs).toLowerCase();
      const MAQUETTE_MIME = {
        ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
        ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8",
      };
      const ct = MAQUETTE_MIME[ext];
      if (!ct) return sendJson(res, 415, { error: `type de fichier non servi (maquette) : ${ext || "(sans extension)"}` });
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return createReadStream(abs).pipe(res);
    }
    const evalItemAdd = path.match(/^\/api\/recettes\/([^/]+)\/items$/);
    if (evalItemAdd && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addRecetteItem({ recetteId: evalItemAdd[1], content: b.content, category: b.category, severity: b.severity, discussion: b.discussion }));
    }
    // LANCEMENT (ou REPRISE) de la SESSION de l'agent-recette ÉVALUATEUR pour une
    // recette évaluateur (ADR-001/003). Anti-doublon via `recettes.session_id`
    // (tool MCP `recette_session_set`) ; `force` démarre une nouvelle session.
    // L'ACL évaluateur autorise cette route sur SES propres recettes (B009) et la
    // garde d'ownership (userOwnsEntity) reste appliquée plus haut.
    const evalSession = path.match(/^\/api\/recettes\/([^/]+)\/session$/);
    if (evalSession && req.method === "POST") {
      let sb = {};
      try { sb = await readBody(req); } catch {}
      return sendJson(res, 200, await pilot.launchRecetteSession({ recetteId: evalSession[1], force: !!(sb && sb.force), adrIds: (sb && sb.adrIds) || undefined, featureIds: (sb && sb.featureIds) || undefined, ruleIds: (sb && sb.ruleIds) || undefined }));
    }
    // DÉCISION ADMIN d'un élément (« à traiter » / « non retenu »). ADMIN-ONLY :
    // l'évaluateur INFORME, l'admin décide (ADR-001/002). Garde EXPLICITE requise
    // car le pattern d'écriture évaluateur `/api/recettes/:id/items/...`
    // (EVALUATEUR_WRITE_PATTERNS) matcherait sinon cette route.
    const evalItemDecision = path.match(/^\/api\/recettes\/([^/]+)\/items\/([0-9]+)\/decision$/);
    if (evalItemDecision && req.method === "POST") {
      if (user.role !== "admin") return sendJson(res, 403, { error: "décision réservée à l'administrateur (ADR-001/002)" });
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.setRecetteItemDecision({ recetteId: evalItemDecision[1], itemId: Number(evalItemDecision[2]), decision: b.decision, by: user.username }));
    }
    const evalItemEdit = path.match(/^\/api\/recettes\/([^/]+)\/items\/([0-9]+)$/);
    if (evalItemEdit && (req.method === "PATCH" || req.method === "POST")) {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.updateRecetteItem({ recetteId: evalItemEdit[1], itemId: Number(evalItemEdit[2]), fields: b.fields || b }));
    }
    if (evalItemEdit && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeRecetteItem({ recetteId: evalItemEdit[1], itemId: Number(evalItemEdit[2]) }));
    }
    const evalVerdict = path.match(/^\/api\/recettes\/([^/]+)\/verdicts$/);
    if (evalVerdict && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.setRecetteVerdict({ recetteId: evalVerdict[1], fonctionnaliteId: b.fonctionnaliteId || b.featureId, verdict: b.verdict, verdictComment: b.verdictComment }));
    }
    const evalDocView = path.match(/^\/api\/recettes\/([^/]+)\/documents\/([0-9]+)\/view$/);
    if (evalDocView && req.method === "GET") {
      const d = (await registry().query("SELECT * FROM artifacts WHERE id = $1 AND doc_type = ANY($2)", [Number(evalDocView[2]), RECETTE_DOC_TYPES])).rows[0];
      if (!d) return sendJson(res, 404, { error: "document introuvable" });
      // Pièce LIEN : on renvoie l'URL externe (pas de contenu local).
      if (d.nature === "lien" || /^https?:\/\//i.test(String(d.path || ""))) return sendJson(res, 200, { title: d.title || d.path, url: d.path, link: true });
      if (!d.path || !existsSync(d.path)) return sendJson(res, 404, { error: "document introuvable" });
      const raw = readFileSync(d.path, "utf8");
      const html = /\.md$/i.test(d.path) ? marked.parse(raw) : null;
      return sendJson(res, 200, { title: d.title || basename(d.path), html, raw: html ? null : raw });
    }
    // Pièces d'une recette de l'ÉVALUATEUR (lien | document | photo | vidéo) —
    // GARDE CIBLÉE : AUCUNE restriction de nature ici, l'évaluateur joint
    // librement ses preuves visuelles (captures, photos, vidéos de parcours).
    // La garde photo/vidéo ne vise QUE les pièces CLIENT de sprint : elle est
    // portée par POST /api/pieces (`pilot.assertPieceAllowed`, voir l.1941) et
    // NE DOIT JAMAIS être appliquée sur cette route.
    const evalDocAction = path.match(/^\/api\/recettes\/([^/]+)\/documents$/);
    if (evalDocAction && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.addRecetteDocument({ recetteId: evalDocAction[1], mode: b.mode, filename: b.filename, dataBase64: b.dataBase64, artifactId: b.artifactId, url: b.url, path: b.path, nature: b.nature, title: b.title, itemId: b.itemId }));
    }
    const evalDocDel = path.match(/^\/api\/recettes\/([^/]+)\/documents\/([0-9]+)$/);
    if (evalDocDel && req.method === "DELETE") {
      return sendJson(res, 200, await pilot.removeRecetteDocument({ documentId: Number(evalDocDel[2]) }));
    }
    const evalFinish = path.match(/^\/api\/recettes\/([^/]+)\/finish$/);
    if (evalFinish && req.method === "POST") {
      return sendJson(res, 200, await pilot.confirmRecette({ recetteId: evalFinish[1], by: user.username }));
    }
    // TESTS STANDARD (préprod) lancés depuis le panneau : ASYNCHRONE. Le POST
    // retourne immédiatement (202 {jobId}) ; un worker détaché relaie l'appel MCP
    // `recette_perf_run` (parcours de pages + erreurs console/réseau + stress
    // des routes d'API, plusieurs minutes) et écrit un marqueur de fin. Le front
    // suit l'état via GET .../perf-jobs/:jobId.
    const evalPerfRun = path.match(/^\/api\/recettes\/([^/]+)\/perf-run$/);
    if (evalPerfRun && req.method === "POST") {
      const recetteId = decodeURIComponent(evalPerfRun[1]);
      const b = await readBody(req).catch(() => ({}));
      const e = (await registry().query("SELECT recette_id FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
      if (!e) return sendJson(res, 404, { error: "recette inconnue" });
      if (!b || !b.url || !/^https?:\/\//i.test(String(b.url))) return sendJson(res, 400, { error: "url préprod requise (http/https)" });
      const PERF_JOBS = join(RECETTE_PERF_DIR, "jobs");
      const jobId = `perf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      try { mkdirSync(PERF_JOBS, { recursive: true }); } catch {}
      const payload = {
        recetteId,
        url: String(b.url),
        pages: Array.isArray(b.pages) && b.pages.length ? b.pages : undefined,
        routes: Array.isArray(b.routes) && b.routes.length ? b.routes : undefined,
        repoDir: b.repoDir ? String(b.repoDir) : undefined,
        baseUrl: b.baseUrl ? String(b.baseUrl) : undefined,
        concurrency: b.concurrency,
        requests: b.requests,
        itemId: b.itemId,
        e2eTestId: b.e2eTestId || undefined,
        title: b.title || undefined,
      };
      const payloadFile = join(PERF_JOBS, `${jobId}.json`);
      const resultFile = join(PERF_JOBS, `${jobId}.result.json`);
      try { writeFileSync(payloadFile, JSON.stringify(payload, null, 2)); } catch (err) { return sendJson(res, 500, { error: "impossible d'écrire le job : " + err.message }); }
      const worker = join(__dirname, "perf-run-worker.mjs");
      try {
        const child = spawn("node", [worker, payloadFile, resultFile], { stdio: "ignore", detached: true });
        child.unref();
      } catch (err) {
        return sendJson(res, 500, { error: "impossible de lancer le worker de performance : " + String((err && err.message) || err) });
      }
      return sendJson(res, 202, {
        ok: true, async: true, jobId, recetteId,
        message: `Test de performance lancé en arrière-plan (job ${jobId}) — suivez l'état via /api/recettes/${encodeURIComponent(recetteId)}/perf-jobs/${jobId} ; il peut prendre plusieurs minutes.`,
      });
    }
    // Statut d'un job de performance asynchrone : en cours / terminé.
    const evalPerfJob = path.match(/^\/api\/recettes\/([^/]+)\/perf-jobs\/([^/]+)$/);
    if (evalPerfJob && req.method === "GET") {
      const jobId = decodeURIComponent(evalPerfJob[2]);
      const resultFile = join(RECETTE_PERF_DIR, "jobs", `${jobId}.result.json`);
      if (!existsSync(resultFile)) return sendJson(res, 200, { jobId, status: "RUNNING" });
      try {
        const r = JSON.parse(readFileSync(resultFile, "utf8"));
        return sendJson(res, 200, { jobId, status: r.ok ? "DONE" : "ERROR", ...r });
      } catch (err) { return sendJson(res, 200, { jobId, status: "ERROR", error: "resultat illisible : " + err.message }); }
    }
    // Éléments de recette évaluateur « à traiter » (décision admin) — entrée de
    // contexte de l'exécuteur pour un cadrage technique. AVANT `/:id` (sinon
    // « treatable » serait capté comme un id d'évaluation).
    if (path === "/api/recettes/treatable" && req.method === "GET") {
      const project = url.searchParams.get("project") || undefined;
      return sendJson(res, 200, await pilot.listTreatableRecetteItems({ project }));
    }
    const evalDetail = path.match(/^\/api\/recettes\/([^/]+)$/);
    if (evalDetail && req.method === "GET") {
      const e = (await registry().query("SELECT * FROM recettes WHERE recette_id = $1", [evalDetail[1]])).rows[0];
      if (!e) return sendJson(res, 404, { error: "recette inconnue" });
      let items = (await registry().query(
        "SELECT id, content, category, severity, discussion, status, decision, decided_at, decided_by, created_at FROM recette_items WHERE recette_id = $1 ORDER BY id ASC",
        [e.recette_id],
      )).rows.map((i) => ({ itemId: Number(i.id), content: i.content, category: i.category, severity: i.severity, discussion: i.discussion, status: i.status, decision: i.decision, decidedAt: i.decided_at || null, decidedBy: i.decided_by || null, createdAt: i.created_at }));
      // Traçage « repris par le cadrage X » (une requête pour tous les éléments).
      const reprisRows = items.length ? (await registry().query(
        `SELECT cei.recette_item_id, cei.cadrage_id, cei.created_at, cei.taken_by, r.title
           FROM cadrage_recette_items cei LEFT JOIN cadrages r ON r.cadrage_id = cei.cadrage_id
          WHERE cei.recette_item_id = ANY($1) ORDER BY cei.created_at ASC`,
        [items.map((i) => i.itemId)],
      )).rows : [];
      const reprisByItem = new Map();
      for (const x of reprisRows) {
        const k = Number(x.recette_item_id);
        if (!reprisByItem.has(k)) reprisByItem.set(k, []);
        reprisByItem.get(k).push({ cadrageId: x.cadrage_id, title: x.title || null, createdAt: x.created_at, takenBy: x.taken_by || null });
      }
      for (const it of items) it.reprisPar = reprisByItem.get(it.itemId) || [];
      // Rôle-aware (ADR-001/002) : l'exécuteur n'accède QU'aux éléments « à traiter »
      // — filtrage SERVEUR (défense en profondeur ; l'UI n'est qu'un confort).
      if (user.role === "executeur") items = items.filter((it) => it.decision === "a_traiter");
      const documents = (await registry().query(
        `SELECT d.id, d.artifact_id, d.title, d.nature, d.source, d.path, d.meta, d.created_at, (d.meta->>'itemId') AS item_id, a.title AS artifact_title
         FROM artifacts d LEFT JOIN artifacts a ON a.artifact_id = (d.meta->>'artifactId')
         WHERE d.content_id = $1 AND d.doc_type = ANY($2) ORDER BY d.id ASC`, [e.recette_id, RECETTE_DOC_TYPES],
      )).rows.map((d) => ({ documentId: Number(d.id), artifactId: d.artifact_id, title: d.title || d.artifact_title || (d.path ? d.path.split("/").pop() : null), nature: d.nature, source: d.source, path: d.path, meta: d.meta || null, itemId: d.item_id ? Number(d.item_id) : null, createdAt: d.created_at }));
      const fonctionnalites = (await registry().query(
        `SELECT f.id, f.ref, f.role, f.user_story, ef.verdict, ef.verdict_comment
         FROM fonctionnalites f JOIN recette_fonctionnalites ef ON ef.fonctionnalite_id = f.id
         WHERE ef.recette_id = $1 ORDER BY f.ref ASC`, [e.recette_id],
      )).rows.map((f) => ({ id: f.id, ref: f.ref, role: f.role, userStory: f.user_story, verdict: f.verdict, verdictComment: f.verdict_comment }));
      const regles = (await registry().query(
        `SELECT rm.id, rm.ref, rm.content FROM regles_metier rm JOIN recette_regles er ON er.regle_id = rm.id
         WHERE er.recette_id = $1 ORDER BY rm.ref ASC`, [e.recette_id],
      )).rows.map((r) => ({ id: r.id, ref: r.ref, content: r.content }));
      return sendJson(res, 200, { recette: { ...e, repos: await reposOfProject(e.project), items, documents, fonctionnalites, regles } });
    }
    // --- Batches d'orchestration (v0.9.0) : sessions / statut -----------------
    if (path === "/api/batches" && req.method === "GET") {
      const project = url.searchParams.get("project");
      return sendJson(res, 200, { batches: await pilot.listBatches(project) });
    }
    const batchGetMatch = path.match(/^\/api\/batches\/([^/]+)$/);
    if (batchGetMatch && req.method === "GET") {
      const batch = await pilot.getBatchDetail(batchGetMatch[1]);
      if (!batch) return sendJson(res, 404, { error: "batch inconnu" });
      return sendJson(res, 200, { batch });
    }
    // Lance (ou reprend) la SESSION D'ORCHESTRATION UNIQUE d'un batch (mode session).
    const batchSessionMatch = path.match(/^\/api\/batches\/([^/]+)\/session$/);
    if (batchSessionMatch && req.method === "POST") {
      let sb = {};
      try { sb = await readBody(req); } catch {}
      return sendJson(res, 200, await pilot.launchBatchSession({ batchId: batchSessionMatch[1], force: !!(sb && sb.force) }));
    }
    const batchStatusMatch = path.match(/^\/api\/batches\/([^/]+)\/status$/);
    if (batchStatusMatch && req.method === "POST") {
      const b = await readBody(req);
      return sendJson(res, 200, await pilot.setBatchStatus(batchStatusMatch[1], b.status));
    }
    // --- Tests E2E (v0.9.0) : entités de 1er niveau, indépendantes des tâches
    if (path === "/api/e2e-tests" && req.method === "GET") return sendJson(res, 200, await registryE2ETests(url, user.activeOrganizationId, user.ownerScope, user.projectAccess));
    // Statut d'un job E2E asynchrone (worker détaché) : en cours / terminé.
    const e2eJobMatch = path.match(/^\/api\/e2e\/jobs\/([^/]+)$/);
    if (e2eJobMatch && req.method === "GET") {
      const jobId = e2eJobMatch[1];
      const E2E_JOBS = join(dirname(fileURLToPath(import.meta.url)), "storage", "e2e", "jobs");
      const resultFile = join(E2E_JOBS, `${jobId}.result.json`);
      if (!existsSync(resultFile)) return sendJson(res, 200, { jobId, status: "RUNNING" });
      try {
        const r = JSON.parse(readFileSync(resultFile, "utf8"));
        return sendJson(res, 200, { jobId, status: r.ok ? "DONE" : "ERROR", ...r });
      } catch (e) { return sendJson(res, 200, { jobId, status: "ERROR", error: "resultat illisible : " + e.message }); }
    }
    if (path === "/api/e2e-tests" && req.method === "POST") {
      const b = await readBody(req);
      return handleE2ECreate(res, b, user);
    }
    const e2eDetailMatch = path.match(/^\/api\/e2e-tests\/([^/]+)$/);
    if (e2eDetailMatch && req.method === "GET") return registryE2ETestDetail(res, e2eDetailMatch[1], user);
    const e2eRunMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/run$/);
    if (e2eRunMatch && req.method === "POST") {
      const b = await readBody(req);
      return handleE2ERun(res, e2eRunMatch[1], b);
    }
    // Session de création / mise à jour du test (agent test-agent) — reprise ou force.
    const e2eSessionMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/session$/);
    if (e2eSessionMatch && req.method === "POST") {
      const t = await registryE2ETest(e2eSessionMatch[1]);
      if (!t) return sendJson(res, 404, { error: "test E2E inconnu" });
      const sb = await readBody(req).catch(() => ({}));
      try {
        const s = await pilot.launchTestSession({ e2eTestId: e2eSessionMatch[1], force: !!(sb && sb.force), mode: (sb && sb.mode) || undefined, adrIds: (sb && sb.adrIds) || undefined });
        return sendJson(res, 200, s);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/indisponible|inconnu|absent/i.test(msg)) return sendJson(res, 400, { error: msg });
        return sendJson(res, 500, { error: msg });
      }
    }
    // --- Sessions test-agent libres (accès agent sans créer de test) ---
    // GET /api/e2e/agent-sessions : liste les sessions opencode pertinentes.
    if (path === "/api/e2e/agent-sessions" && req.method === "GET") {
      try { return sendJson(res, 200, { sessions: await pilot.listTestAgentSessions() }); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // POST /api/e2e/agent-sessions { action: 'new'|'continue', project?, repoId?,
    //      message?, sessionId? } — new = ouvre une session ; continue = reprend.
    if (path === "/api/e2e/agent-sessions" && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      try {
        if ((b && b.action) === "continue") {
          return sendJson(res, 200, await pilot.continueFreeTestSession({ sessionId: b.sessionId, message: b.message }));
        }
        return sendJson(res, 200, await pilot.launchFreeTestSession({ project: (b && b.project) || undefined, repoId: (b && b.repoId) || undefined, message: (b && b.message) || undefined, adrIds: (b && b.adrIds) || undefined }));
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/indisponible|inconnu|absent|expir/i.test(msg)) return sendJson(res, 400, { error: msg });
        return sendJson(res, 500, { error: msg });
      }
    }
    // Création d'une tâche depuis un test (contrat BDD/TDD) + lien REQUIRED.
    const e2eCreateTaskMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/create-task$/);
    if (e2eCreateTaskMatch && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      return handleE2ECreateTask(res, e2eCreateTaskMatch[1], b);
    }
    // --- Vars E2E (module vars/secrets unifié) : variables d'env par projet ---
    // GET ?project=&kind=variable|secret ; POST {project,name,value,kind,purpose} ; DELETE ?project=&name=
    if (path === "/api/e2e-vars" && req.method === "GET") {
      const project = url.searchParams.get("project") || "";
      const kind = url.searchParams.get("kind") || "";
      if (!project) return sendJson(res, 400, { error: "project requis" });
      try { return sendJson(res, 200, await pilot.listE2EVars(project, kind || undefined)); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/e2e-vars" && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const { project, name, value, kind, purpose } = b || {};
      if (!project || !name || value === undefined) return sendJson(res, 400, { error: "project, name et value requis" });
      try { return sendJson(res, 201, await pilot.setE2EVar({ project, name, value, kind, purpose })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/e2e-vars" && req.method === "DELETE") {
      const project = url.searchParams.get("project") || "";
      const name = url.searchParams.get("name") || "";
      if (!project || !name) return sendJson(res, 400, { error: "project et name requis" });
      try { return sendJson(res, 200, await pilot.deleteE2EVar({ project, name })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    // Alias rétrocompat : /api/e2e-secrets (v0.9.6) → secrets (kind=secret).
    if (path === "/api/e2e-secrets" && req.method === "GET") {
      const project = url.searchParams.get("project") || "";
      if (!project) return sendJson(res, 400, { error: "project requis" });
      try { return sendJson(res, 200, await pilot.listE2ESecrets(project)); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/e2e-secrets" && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const { project, name, value, purpose } = b || {};
      if (!project || !name || !value) return sendJson(res, 400, { error: "project, name et value requis" });
      try { return sendJson(res, 201, await pilot.setE2ESecret({ project, name, value, purpose })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (path === "/api/e2e-secrets" && req.method === "DELETE") {
      const project = url.searchParams.get("project") || "";
      const name = url.searchParams.get("name") || "";
      if (!project || !name) return sendJson(res, 400, { error: "project et name requis" });
      try { return sendJson(res, 200, await pilot.deleteE2ESecret({ project, name })); }
      catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    }

    // Vidéo E2E ENRICHIE à la demande : SOUS-TITRES gravés ou NARRATION vocale,
    // générées depuis le rapport texte horodaté (même origine temporelle que la
    // vidéo). Réservé admin (coûteux, écrit des fichiers). Cache par executionId.
    const e2eEnrichMatch = path.match(/^\/api\/e2e\/(subtitled|narrated)$/);
    if (e2eEnrichMatch && req.method === "POST") {
      if (!user.is_admin) return sendJson(res, 403, { error: "réservé aux administrateurs" });
      const kind = e2eEnrichMatch[1];
      const b = await readBody(req).catch(() => ({}));
      const executionId = (b && b.executionId) || "";
      if (!executionId) return sendJson(res, 400, { error: "executionId requis" });
      try {
        const row = (await registry().query("SELECT * FROM e2e_executions WHERE id = $1", [executionId])).rows[0];
        if (!row) return sendJson(res, 404, { error: "exécution inconnue" });
        const logsUrl = row.logs_url, videoUrl = row.video_url, status = row.status;
        if (!logsUrl || !existsSync(logsUrl)) return sendJson(res, 400, { error: "rapport texte introuvable pour cette exécution" });
        if (!videoUrl || !existsSync(videoUrl)) return sendJson(res, 400, { error: "vidéo introuvable pour cette exécution" });
        const reportText = readFileSync(logsUrl, "utf8");
        const subDir = join(__dirname, "storage", "e2e", kind);
        const ext = kind === "narrated" ? ".mp4" : ".webm";
        const outPath = join(subDir, `${executionId}${ext}`);
        let generated = existsSync(outPath) ? outPath : null; // cache
        const cached = !!generated;
        if (!generated) {
          if (kind === "narrated") generated = generateNarratedVideo({ reportText, videoPath: videoUrl, outPath });
          else generated = generateSubtitledVideo({ reportText, status, videoPath: videoUrl, outPath });
        }
        if (!generated) return sendJson(res, 500, { error: `génération ${kind} impossible (rapport sans étapes horodatées ou ffmpeg/espeak en échec)` });
        const rel = relative(E2E_STORAGE_DIR, generated).replace(/\\/g, "/");
        return sendJson(res, 200, { ok: true, kind, executionId, file: generated, url: `/api/e2e/file?p=${encodeURIComponent(rel)}`, cached });
      } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
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
    // Marquage « incohérent » (signal évaluateur : comportement réel ≠ scénario)
    // — seule écriture E2E autorisée à l'évaluateur (remarques obligatoires).
    const e2eIncoherentMatch = path.match(/^\/api\/e2e-tests\/([^/]+)\/incoherent$/);
    if (e2eIncoherentMatch && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      return handleE2EIncoherent(res, e2eIncoherentMatch[1], b, user);
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
      const type = /\.(webm|mp4)$/i.test(abs) ? "video/webm" : (/\.json$/i.test(abs) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
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
    // Fichier importé d'un DOCUMENT de référence (ADR-12) — storage/ref-docs.
    // Accès restreint : lecture seule du contenu (aperçu / lecture par agents).
    if (path === "/api/docs/file" && req.method === "GET") {
      const DOC_STORAGE = join(__dirname, "storage", "ref-docs");
      const rel = url.searchParams.get("p") || "";
      const abs = normalize(join(DOC_STORAGE, rel));
      if (!abs.startsWith(DOC_STORAGE + "/") || !existsSync(abs)) return sendJson(res, 404, { error: "introuvable" });
      const raw = readFileSync(abs, "utf8");
      const isMd = /\.(md|markdown)$/i.test(abs);
      const isFeature = /\.(feature)$/i.test(abs);
      let html = null;
      let body = raw;
      if (isMd || isFeature) {
        if (isMd) {
          html = marked.parse(raw);
        } else {
          html = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px">${String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
        }
      }
      return sendJson(res, 200, { title: basename(abs), path: abs, html, raw: html ? null : body.slice(0, 200000) });
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

// Arrêt propre : fermer les clients MCP persistants (aucun process MCP orphelin
// au redémarrage PM2), puis quitter. Filet de sécurité : le hook `exit` du
// client MCP tue aussi les process de façon synchrone.
async function shutdown(signal) {
  console.log(`[orchestrator-panel] ${signal} reçu — arrêt propre…`);
  try { await closeAllMcpClients(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });
