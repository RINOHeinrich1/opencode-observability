// pilot.mjs — Logique métier du centre de pilotage d'agents IA.
//
// Toute écriture transite par le MCP `task-orchestrator` (source de vérité unique),
// jamais par une écriture directe dans registry.db. Le lancement/injection de
// sessions opencode est délégué au bridge `session-bridge.mjs` (Plan C).

import { taskOrchestrator, coderWorkspaces } from "./mcp-client.mjs";
import { launchSession, injectMessage, buildLaunchPrompt, buildReworkPrompt, buildRecettePrompt, buildSprintPrompt, buildMigrationPrompt, buildTestPrompt, buildFreeTestPrompt, buildBatchSessionPrompt, listSessions, killSession, sessionExists, sessionExistsById } from "./session-bridge.mjs";
import { existsSync } from "node:fs";

// Décision n°7 : agents contraints par type de tâche.
export function agentsForType(type, auditTarget) {
  if (type === "audit") {
    const target = auditTarget || "backend";
    if (target === "frontend") return [{ agent: "clean-arch-detector-react", role: "auditor" }];
    if (target === "both") {
      return [
        { agent: "hexagonal-architecture-auditor", role: "auditor" },
        { agent: "clean-arch-detector-react", role: "auditor" },
      ];
    }
    return [{ agent: "hexagonal-architecture-auditor", role: "auditor" }];
  }
  // feature / debug → planner + executor
  return [
    { agent: "atomic-plan", role: "planner" },
    { agent: "build-notify", role: "executor" },
  ];
}

export async function listWorkspaces(org) {
  const disc = (await coderWorkspaces("workspace_list", {})) || {};
  let workspaces = disc.workspaces || disc.discovered || [];
  // Enrichit la découverte Docker avec le VRAI statut Coder (coder list) : les
  // transitions (starting/stopping/restarting/deleting) ne sont pas visibles
  // via Docker, et le statut "stopped" après un stop l'est à peine.
  try {
    const cfg = await getOrganizationCoderConfig(org || "onirtech");
    if (cfg && cfg.url && cfg.token) {
      const env = { ...process.env, CODER_URL: cfg.url, CODER_SESSION_TOKEN: cfg.token };
      const list = JSON.parse(execFileSync("coder", ["list", "--output", "json"], { encoding: "utf8", env, timeout: 30000 }));
      const sub = (x, k) => (x && x[k]) || null;
      const stateOf = (w) => {
        const lb = w.latest_build || {};
        const status = lb.status || null; // started/running/succeeded/failed…
        const transition = lb.transition || null; // start/stop/delete/restart
        const job = (lb.job && lb.job.status) || null; // pending/running/succeeded/failed
        const transitioning = job && ["pending", "running", "started"].includes(job);
        let label = transitioning ? `${transition || "?"}ing` : status;
        if (!label) label = "unknown";
        return { label, transition, buildStatus: status, job, transitioning };
      };
      const byName = new Map(list.map((w) => [`${w.owner_name}/${w.name}`, w]));
      // Match par owner/name (RINOHeinrich1/myxmax), sinon par name simple.
      workspaces = workspaces.map((w) => {
        const ownerName = (w.owner || "").toLowerCase();
        const key = `${ownerName}/${String(w.name).toLowerCase()}`;
        const match = byName.get(key.toLowerCase()) || [...byName.entries()].find(([k]) => k.toLowerCase().endsWith(`/${String(w.name).toLowerCase()}`))?.[1];
        const st = match ? stateOf(match) : null;
        // URL de l'IDE web Coder (code-server / vscode) — ouverte dans un nouvel onglet.
        const ideUrl = (() => {
          if (!match) return null;
          const resources = (match.latest_build || {}).resources || [];
          for (const r of resources) for (const a of r.agents || []) for (const app of a.apps || []) if (app.slug) return `${cfg.url}/@${match.owner_name}/${match.name}/apps/${app.slug}/`;
          return null;
        })();
        return { ...w, ...(st ? { coderStatus: st.label, coderTransition: st.transition, coderBuildStatus: st.buildStatus, jobStatus: st.job, transitioning: st.transitioning } : {}), ideUrl: ideUrl || undefined };
      });
    }
  } catch { /* enrichissement best-effort : on garde la découverte Docker */ }
  return { count: workspaces.length, workspaces };
}

// --- Workspaces Coder : opérations CRUD via coder CLI (admin) ---------------
import { execFileSync, spawn } from "node:child_process";
import { getOrganizationCoderConfig } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

function coderExec(org, args) {
  return getOrganizationCoderConfig(org).then((cfg) => {
    if (!cfg || !cfg.url || !cfg.token) throw new Error(`Config Coder incomplète pour l'org ${org}`);
    const env = { ...process.env, CODER_URL: cfg.url, CODER_SESSION_TOKEN: cfg.token };
    return execFileSync("coder", args, { encoding: "utf8", env, timeout: 120000 });
  });
}

export async function showWorkspace(name, org) {
  const out = await coderExec(org || "onirtech", ["show", name]);
  return { output: out };
}

// Ouvre l'IDE web Coder d'un workspace SANS authentification Coder côté
// utilisateur : le panneau dépose le cookie de session Coder (token
// d'organisation, renouvelé automatiquement chaque semaine) sur le domaine
// partagé, puis redirige vers l'app. Coder accepte un token d'API comme valeur
// du cookie `coder_session_token` (vérifié : l'app répond au lieu de rediriger
// vers /login). Évite le partage de workspace Coder (non supporté pour l'IDE web).
export async function openCoderIde({ org, targetUrl }) {
  const cfg = await getOrganizationCoderConfig(org || "onirtech");
  if (!cfg || !cfg.url || !cfg.token) return { ok: false, error: "configuration Coder incomplète (URL ou token manquant)" };
  let target;
  try { target = new URL(String(targetUrl || "")); } catch { return { ok: false, error: "URL Coder invalide" }; }
  let coderOrigin;
  try { coderOrigin = new URL(cfg.url).origin; } catch { return { ok: false, error: "URL Coder d'organisation invalide" }; }
  if (target.origin !== coderOrigin) return { ok: false, error: "URL hors du serveur Coder de l'organisation" };
  const domain = process.env.PANEL_COOKIE_DOMAIN ? `; Domain=${process.env.PANEL_COOKIE_DOMAIN}` : "";
  const attrs = `${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
  // Deux cookies de même nom :
  //  - Path=/     : couverture générale ;
  //  - Path=<app> : chemin PLUS LONG que le Path=/ (le navigateur trie par
  //    longueur de chemin décroissante) → prioritaire pour les requêtes de
  //    l'app. Indispensable si le navigateur porte déjà un `coder_session_token`
  //    obsolète (ex. ancien cookie host-only de ide.madatalk.fr) : sans cela,
  //    Coder lit le cookie obsolète en premier et renvoie vers /login.
  const cookies = [`coder_session_token=${cfg.token}; Path=/${attrs}`];
  const appMatch = target.pathname.match(/^(\/@[^/]+\/[^/]+\/apps\/[^/]+)/);
  if (appMatch) cookies.push(`coder_session_token=${cfg.token}; Path=${appMatch[1]}${attrs}`);
  return { ok: true, location: target.href, cookies };
}

// Lance une commande coder en ARRIÈRE-PLAN (non bloquant) : répond immédiatement
// avec {queued:true}, le statut évolue ensuite dans la liste (polling).
function coderActionAsync(org, args) {
  return new Promise((resolve, reject) => {
    getOrganizationCoderConfig(org || "onirtech").then((cfg) => {
      if (!cfg || !cfg.url || !cfg.token) { reject(new Error(`Config Coder incomplète pour l'org ${org || "onirtech"}`)); return; }
      const env = { ...process.env, CODER_URL: cfg.url, CODER_SESSION_TOKEN: cfg.token };
      const child = spawn("coder", args, { env, stdio: "ignore" });
      const done = (code) => {
        resolve({ queued: true, exitCode: code });
        // collecte tronquée pour diagnostic si échec
      };
      child.on("error", reject);
      child.on("exit", done);
    }).catch(reject);
  });
}

export async function startWorkspace(name, org) {
  return coderActionAsync(org, ["start", name, "--yes"]);
}
export async function stopWorkspace(name, org) {
  return coderActionAsync(org, ["stop", name, "--yes"]);
}
export async function restartWorkspace(name, org) {
  return coderActionAsync(org, ["restart", name, "--yes"]);
}
export async function deleteWorkspace(name, org) {
  return coderActionAsync(org, ["delete", name, "--yes"]);
}

export async function listProjects() {
  return taskOrchestrator("project_list", {});
}

// --- Organisations (v0.9.47) : tenant de premier niveau (nom + description) --
export async function listOrganizations() {
  const r = await taskOrchestrator("org_list", {});
  return (r && r.organizations) || [];
}
export async function registerOrganization({ id, name, description, isDefault, coderUrl, coderToken, coderTemplate, gitToken, by }) {
  const r = await taskOrchestrator("org_register", { id, name, description: description || undefined, isDefault: !!isDefault, coderUrl: coderUrl !== undefined ? coderUrl : undefined, coderToken: coderToken || undefined, coderTemplate: coderTemplate !== undefined ? coderTemplate : undefined, gitToken: gitToken || undefined, createdBy: by });
  return r && r.organization;
}
export async function deleteOrganization(id) {
  return taskOrchestrator("org_delete", { id });
}
export async function setDefaultOrganization(id) {
  const r = await taskOrchestrator("org_set_default", { id });
  return r && r.organization;
}

// --- Tokens git multiples par organisation (v0.10) ---------------------------
export async function addOrgGitToken({ org, name, token, by }) {
  const r = await taskOrchestrator("org_git_token_add", { org, name, token, createdBy: by });
  return r || {};
}
export async function listOrgGitTokens(org) {
  const r = await taskOrchestrator("org_git_token_list", { org });
  return (r && r.tokens) || [];
}
export async function deleteOrgGitToken({ id, org }) {
  return taskOrchestrator("org_git_token_delete", { id, org });
}

// --- Repos (ADR 09) : dépôt de code physique, rattaché à 1..N projets --------
export async function listRepos(projectId) {
  return taskOrchestrator("repo_list", { projectId: projectId || undefined });
}
export async function registerRepo({ id, name, description, deploy, workspace, repoDir, gitUrl, branches, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy }) {
  return taskOrchestrator("repo_register", { id, name: name || undefined, description: description || undefined, deploy: deploy || undefined, workspace: workspace || undefined, repoDir: repoDir || undefined, gitUrl: gitUrl || undefined, branches, mainBranch: mainBranch || undefined, e2eRepoDir: e2eRepoDir || undefined, e2eBaseUrl: e2eBaseUrl || undefined, organizationId: organizationId || undefined, createdBy });
}
export async function linkRepoToProject({ projectId, repoId, role, gitTokenId }) {
  return taskOrchestrator("project_repo_link", { projectId, repoId, role: role || undefined, gitTokenId: gitTokenId || undefined });
}
export async function unlinkRepoFromProject({ projectId, repoId }) {
  return taskOrchestrator("project_repo_unlink", { projectId, repoId });
}
export async function deleteRepo(id) {
  if (!id) throw new Error("id requis");
  return taskOrchestrator("repo_delete", { id });
}

export async function createProject({ id, name, workspace, gitPath, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy }) {
  if (!id || !name) throw new Error("id et name requis pour créer un projet");
  // ADR 09 : le PRODUIT ne porte plus de branche/repo (attributs du REPO).
  // Les champs workspace/gitPath/mainBranch restent acceptés en rétrocompat
  // pour les anciens flux, mais ne sont plus requis.
  const reg = await taskOrchestrator("project_register", {
    id, name, workspace: workspace || undefined, gitPath: gitPath || undefined,
    mainBranch: mainBranch || undefined, createdBy,
    e2eRepoDir: e2eRepoDir || undefined, e2eBaseUrl: e2eBaseUrl || undefined,
    organizationId: organizationId || undefined,
  });

  // Rétrocompat : crée le répertoire du projet dans le workspace Coder si un
  // workspace est fourni (ancien flux). Non bloquant.
  let dirCreated = false;
  let dirWarning = null;
  if (workspace) {
    try {
      const folder = gitPath ? String(gitPath).split("/").filter(Boolean).pop() : id;
      const exec = await coderWorkspaces("workspace_exec", {
        workspace,
        cwd: "/home/coder",
        command: `mkdir -p "${folder}" && cd "${folder}" && git init -b main >/dev/null 2>&1; echo OK`,
      });
      dirCreated = !!(exec && exec.ok);
      if (!dirCreated) dirWarning = "répertoire non créé (workspace injoignable)";
    } catch (e) {
      dirWarning = `répertoire non créé : ${(e && e.message) || e}`;
    }
  }
  return { ...reg, dirCreated, dirWarning };
}

export async function deleteProject(id) {
  if (!id) throw new Error("id requis");
  return taskOrchestrator("project_delete", { id });
}

export async function deleteTask(taskId) {
  if (!taskId) throw new Error("taskId requis");
  return taskOrchestrator("task_delete", { taskId });
}

// Modification d'une tâche non lancée (queued).
export async function editTask({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks }) {
  if (!taskId) throw new Error("taskId requis");
  return taskOrchestrator("task_update", {
    taskId,
    request: request !== undefined ? request : undefined,
    title: title !== undefined ? title : undefined,
    acceptanceCriteria: acceptanceCriteria !== undefined ? acceptanceCriteria : undefined,
    scope: scope !== undefined ? scope : undefined,
    priority: priority !== undefined ? priority : undefined,
    directExecution: directExecution !== undefined ? directExecution : undefined,
    linkedTasks: linkedTasks !== undefined ? linkedTasks.filter((l) => l && l.taskId) : undefined,
  });
}
export async function createTask({ request, title, acceptanceCriteria, project, type, scope, priority, auditTarget, linkedTasks, directExecution, agents, repoIds, originTaskId, originReason, createdBy, organizationId }) {
  if (!request || !project || !type) throw new Error("request, project et type requis");
  const reg = await taskOrchestrator("task_register", {
    request,
    title: title !== undefined ? title : undefined,
    acceptanceCriteria: acceptanceCriteria !== undefined ? acceptanceCriteria : undefined,
    project,
    type,
    auditTarget: auditTarget || undefined,
    scope: scope || undefined,
    priority: priority || "normal",
    directExecution: !!directExecution,
    linkedTasks: (linkedTasks || []).filter((l) => l && l.taskId).map((l) => ({ taskId: l.taskId, description: l.description })),
    repoIds: Array.isArray(repoIds) && repoIds.length ? repoIds : undefined,
    originTaskId: originTaskId || undefined,
    originReason: originReason || undefined,
    createdBy: createdBy || undefined,
    organizationId: organizationId || undefined,
  });
  const taskId = reg && (reg.taskId || (reg.task && reg.task.id));
  const list = agents && agents.length ? agents : agentsForType(type, auditTarget);
  for (const a of list) {
    await taskOrchestrator("participant_add", { taskId, agent: a.agent, role: a.role });
  }
  return reg;
}

export async function scopeConflict(project, scope) {
  return taskOrchestrator("scope_conflict", { project, scope });
}

// Résolution d'une décision humaine (approuver/rejeter) — couplée à la transition
// atomique vers approved/rejected (Plan A).
export async function resolveDecision({ decisionId, status, resolution, by }) {
  if (!decisionId || !status) throw new Error("decisionId et status requis");
  const r = await taskOrchestrator("decision_resolve", { decisionId, status, resolution, by: by || "human" });

  // Bug 4 — réveille la session orchestrateur pour qu'elle continue
  // automatiquement après la résolution (plus besoin de retaper un message).
  try {
    const decision = r && (r.decision || r.decisions);
    const taskId = decision && decision.taskId;
    if (taskId && status !== "permission") {
      const t = await taskOrchestrator("task_get", { taskId });
      const sessions = (t && t.sessions) || [];
      const sid = sessions.length ? sessions[sessions.length - 1].sessionId : (t && t.task && t.task.sessionId);
      if (sid) {
        const dir = await projectGitPath((t && t.task && t.task.project) || null);
        const verdict = status === "approved" ? "approuvée" : "rejetée";
        injectMessage({
          sessionId: sid,
          dir,
          prompt: `La décision ${decisionId} a été ${verdict} par l'humain${resolution ? ` avec les remarques : ${resolution}` : ""}. Poursuis l'orchestration de la tâche ${taskId} : récupère l'état via task_get, applique la suite (validation/review/merge) sans demander de confirmation.`,
        });
      }
    }
  } catch {
    /* réveil non bloquant (session absente/expirée) */
  }

  return r;
}

// Validation de la recette (acceptation humaine après déploiement) : approved/rejected
// + remarques, tracée comme décision kind="recette", colonne recette_status.
export async function resolveRecette({ taskId, status, resolution, by }) {
  if (!taskId || !status) throw new Error("taskId et status requis");
  const r = await taskOrchestrator("task_recette", { taskId, status, resolution, by: by || "human" });

  // Recette APPROUVÉE = tâche clôturée (v0.5.2) : arrêter le traitement de la
  // session orchestrateur (elle n'accepte plus aucune demande) MAIS conserver
  // l'enregistrement de session (lien + consommation restent consultables,
  // v0.6.3 — killSession ne supprime plus).
  if (status === "approved") {
    try {
      const t = await taskOrchestrator("task_get", { taskId });
      const sessions = (t && t.sessions) || [];
      const sid = sessions.length ? sessions[sessions.length - 1].sessionId : (t && t.task && t.task.sessionId);
      if (sid) killSession({ taskId, sessionId: sid });
    } catch { /* non bloquant */ }
  }
  return r;
}

// Résout le chemin git d'un projet (pour le --dir de la session orchestrateur).
async function projectGitPath(projectId) {
  if (!projectId) return null;
  const r = await listProjects();
  const projects = (r && r.projects) || [];
  const p = projects.find((x) => x.id === projectId);
  return p ? p.gitPath : null;
}

// Répertoire d'ANCRAGE d'une session opencode pour un projet : le `gitPath` du
// projet s'il est renseigné, sinon le `repoDir` d'un repo lié (ADR 09). Sans ce
// repli, un projet enregistré uniquement via des repos (gitPath null, ex.
// myxmax) lançait ses sessions sans `--dir` → projet opencode « global »
// (directory `/`), d'où des reprises impossibles.
// NB : `repo_list({ projectId })` renvoie TOUS les repos (enrichis du rôle pour
// ce projet) — on croise donc avec `project.repos` (association N:N réelle).
async function projectAnchorDir(projectId) {
  const gitPath = await projectGitPath(projectId);
  if (gitPath && existsSync(gitPath)) return gitPath;
  if (!projectId) return null;
  try {
    const pr = await listProjects();
    const project = ((pr && pr.projects) || []).find((x) => x.id === projectId);
    const repoIds = (project && project.repos) || [];
    if (!repoIds.length) return null;
    const rr = await taskOrchestrator("repo_list", {});
    const byId = new Map(((rr && rr.repos) || []).map((x) => [x.id, x]));
    // Priorité au repo homonyme du projet (convention myxmax ↔ repo myxmax),
    // puis aux autres repos liés, dans l'ordre d'association.
    const ordered = [projectId, ...repoIds.filter((id) => id !== projectId)];
    for (const id of ordered) {
      const repo = byId.get(id);
      const dir = repo && (repo.repoDir || repo.gitPath);
      if (dir && existsSync(dir)) return dir;
    }
    return null;
  } catch {
    return null;
  }
}

// Vrai si la session existe encore : vérification par identifiant auprès du
// serveur opencode (fiable, indépendante du projet). Repli sur `opencode session
// list` scopé par répertoire uniquement si le serveur est injoignable.
async function sessionAlive(sessionId, dir) {
  const exists = await sessionExistsById(sessionId);
  if (exists !== null) return exists;
  return !!(dir && sessionExists(sessionId, dir));
}

// Verrou d'unicité par clé (recette/batch) : sérialise les lancements de session
// pour une même entité. Un double-clic (ou deux appels concurrents) attend la fin
// du premier lancement puis RÉ-ÉVALUE la session rattachée (relecture dans le
// corps verrouillé) → reprise au lieu d'une seconde session. Le panneau est un
// process unique (pm2 fork) : un verrou mémoire suffit.
const launchLocks = new Map();
async function withLaunchLock(key, fn) {
  while (launchLocks.has(key)) {
    try { await launchLocks.get(key); } catch { /* ignoré : on retente */ }
  }
  let release;
  const p = new Promise((resolve) => { release = resolve; });
  launchLocks.set(key, p);
  try {
    return await fn();
  } finally {
    launchLocks.delete(key);
    release();
  }
}

// Lancement d'une tâche : garde atomique anti double-lancement + session orchestrateur.
// Le worktree/branche sont gérés en interne par l'orchestrateur (pas de sélection ici).
export async function launchTask({ taskId, kind = "launch" }) {
  if (!taskId) throw new Error("taskId requis");

  // 1. Lire l'état courant.
  const t = await taskOrchestrator("task_get", { taskId });
  const task = t && t.task;
  const exec = t && t.executions && t.executions[0];
  const status = exec && exec.status;

  // 2. Garde anti double-lancement. Source de vérité : la trace `task_sessions`
  //    (sessions d'EXÉCUTION : launch/rework/relaunch). Le champ `task.sessionId`
  //    est la session de CRÉATION de la tâche (posée par task_register via
  //    permission-hook) — il ne bloque PAS le lancement.
  const sessions = (t && t.sessions) || [];
  const execSessions = sessions.filter((s) => s.sessionId && /^ses_/.test(s.sessionId) && (s.kind === "launch" || s.kind === "relaunch" || s.kind === "rework"));
  if (execSessions.length) {
    throw new Error(`tâche ${taskId} déjà lancée (session d'exécution ${execSessions[execSessions.length - 1].sessionId}) : lancement refusé`);
  }
  if (status !== "queued") {
    throw new Error(`tâche ${taskId} non lançable (statut ${status || "inconnu"}) : seules les tâches queued peuvent être lancées`);
  }

  // 3. Transition ATOMIQUE queued → started (verrou optimiste). Elle réserve le
  //    lancement : un second appel concurrent échoue (transition refusée).
  //    La planification (`started` → `planning`) sera posée par l'orchestrateur
  //    quand il déléguera à atomic-plan.
  await taskOrchestrator("task_transition", { taskId, to: "started", by: "orchestrator" });

  // 4. Lancement de la session orchestrateur + lien. ADR 09 : la tâche cible
  //    1..N repos ; on ancre la session sur le 1er repo et on passe la liste au
  //    prompt pour que l'orchestrateur travaille repo par repo.
  const repos = (task && task.repos) || [];
  const anchor = repos[0] && repos[0].repoDir ? repos[0].repoDir : (await projectGitPath(task && task.project));
  const prompt = buildLaunchPrompt({
    taskId,
    executionId: exec && exec.executionId,
    project: task && task.project,
    workspace: task && task.workspace,
    scope: task && task.scope,
    request: task && task.request,
    title: task && task.title,
    acceptanceCriteria: task && task.acceptanceCriteria,
    auditTarget: task && task.auditTarget,
    directExecution: task && task.directExecution,
    repos,
  });
  const dir = anchor;
  const { sessionId } = await launchSession({ dir, agent: "orchestrator", prompt, title: `Tâche ${taskId}` });
  if (sessionId) {
    await taskOrchestrator("task_link_session", { taskId, sessionId, kind });
  }
  return { taskId, sessionId };
}

// Reprise après rejet : choix 1 (injecter dans la session courante) ou choix 3 (nouvelle session vierge).
export async function reworkTask({ taskId, mode, remarks, by, sessionId }) {
  if (!taskId) throw new Error("taskId requis");
  const prompt = buildReworkPrompt({ taskId, remarks, by });

  const t = await taskOrchestrator("task_get", { taskId });
  const task = t && t.task;
  const exec = t && t.executions && t.executions[0];
  const status = exec && exec.status;
  const dir = await projectGitPath(task && task.project);

  // Reprise après rejet de recette : la tâche est `done` (exécution terminée).
  // Rouvrir l'exécution (done → rework) et remettre la recette à `pending`.
  if (status === "done") {
    await taskOrchestrator("task_transition", { taskId, to: "rework", by: by || "human" });
    try { await taskOrchestrator("task_recette_reset", { taskId }); } catch {}
  }

  if (mode === "continue") {
    if (!sessionId) throw new Error("sessionId requis pour le mode continue (choix 1)");
    return injectMessage({ sessionId, prompt, dir });
  }
  // choix 3 : nouvelle session vierge
  const { sessionId: newSid } = await launchSession({ dir, agent: "orchestrator", prompt, title: `Reprise ${taskId}` });
  if (newSid) await taskOrchestrator("task_link_session", { taskId, sessionId: newSid, kind: "rework" });
  return { taskId, sessionId: newSid };
}

// Arrêt d'une session de tâche : tue le process opencode + supprime la session
// + abandonne la tâche (bouton « Tuer la session »). Le worktree est géré en
// interne par l'agent orchestrateur (session-guard), pas par le panneau.
export async function killTaskSession({ taskId }) {
  if (!taskId) throw new Error("taskId requis");

  const t = await taskOrchestrator("task_get", { taskId });
  const task = t && t.task;
  const sessionId = task && task.sessionId;

  const killed = killSession({ taskId, sessionId });

  let aborted = false;
  try {
    const r = await taskOrchestrator("task_transition", { taskId, to: "aborted", by: "human" });
    aborted = !!(r && r.to === "aborted");
  } catch {}

  // Vider la session (ne plus pointer vers la session supprimée).
  try { await taskOrchestrator("task_clear_session", { taskId }); } catch {}

  return { taskId, sessionId, killed, aborted };
}

// Relance une tâche abandonnée (kill) : vide la session, repasse en queued, puis lance.
export async function relaunchTask({ taskId }) {
  if (!taskId) throw new Error("taskId requis");
  await taskOrchestrator("task_clear_session", { taskId });
  await taskOrchestrator("task_transition", { taskId, to: "queued", by: "human" });
  return launchTask({ taskId, kind: "relaunch" });
}

// ===========================================================================
// Recette (v0.8.0) — objet de PROJET : titre + 0..N tâches couvertes
// ===========================================================================

// Crée une recette de PROJET (titre + tâches couvertes 0..N) + documents éventuels.
// --- Documents de référence (ADR-12) : contexte architecture & comportement ---
// Registre générique N:N docs ⇄ projets et/ou repos. Pas de contenu en base :
// `path` pointe le fichier (workspace/checkout) que les agents LISENT.
export async function listDocs(args = {}) {
  return taskOrchestrator("doc_list", {
    kind: args.kind || undefined,
    projectId: args.projectId || undefined,
    repoId: args.repoId || undefined,
    includeRepoDocs: args.includeRepoDocs,
    limit: args.limit || undefined,
  });
}
export async function registerDoc(args) {
  return taskOrchestrator("doc_register", {
    kind: args.kind, title: args.title || undefined, path: args.path,
    description: args.description || undefined,
    // Champs ADR structurés (item 120) — restitués en table par l'onglet ADR.
    status: args.status || undefined,
    context: args.context ?? undefined,
    decision: args.decision ?? undefined,
    consequences: args.consequences ?? undefined,
    replacedBy: args.replacedBy || undefined,
    projectId: args.projectId || undefined, repoId: args.repoId || undefined,
    // Rattachement repos 1..N + ADR globale (tous les repos du projet).
    repoIds: Array.isArray(args.repoIds) && args.repoIds.length ? args.repoIds : undefined,
    global: args.global === true ? true : undefined,
    organizationId: args.organizationId || undefined, createdBy: args.createdBy,
  });
}
export async function updateDoc(args) {
  return taskOrchestrator("doc_update", {
    docId: args.docId, kind: args.kind || undefined, title: args.title,
    path: args.path, description: args.description,
    // Champs ADR structurés (item 120).
    status: args.status || undefined,
    context: args.context ?? undefined,
    decision: args.decision ?? undefined,
    consequences: args.consequences ?? undefined,
    replacedBy: args.replacedBy ?? undefined,
    addProjectId: args.addProjectId || undefined, addRepoId: args.addRepoId || undefined,
    // Rattachement : ajout de repos (1..N) + bascule « tous les repos » (globale).
    addRepoIds: Array.isArray(args.addRepoIds) && args.addRepoIds.length ? args.addRepoIds : undefined,
    setGlobal: typeof args.setGlobal === "boolean" ? args.setGlobal : undefined,
  });
}
export async function deleteDoc(docId) {
  if (!docId) throw new Error("docId requis");
  return taskOrchestrator("doc_delete", { docId });
}

// Détail d'un document de référence (doc_get MCP) — pour la lecture de contenu.
export async function docGet(docId) {
  if (!docId) throw new Error("docId requis");
  const r = await taskOrchestrator("doc_get", { docId });
  return (r && r.doc) || null;
}

// --- PIÈCES CLIENT (ADR-001, item 4) : pont panneau → MCP (source de vérité) --
// Une pièce est la matière première d'un sprint. Natures admises : markdown |
// pdf | docx | lien externe (Drive public). PHOTO et VIDÉO sont REFUSÉES.
// La garde AUTORITATIVE est côté MCP (`assertPieceAllowed`, db.mjs) ; la garde
// ci-dessous est un MIROIR (défense en profondeur) appelé AVANT toute écriture
// disque par la route POST /api/pieces.
export const PIECE_NATURES = ["markdown", "pdf", "docx", "lien"];
export const PIECE_NATURE_BY_EXT = { ".md": "markdown", ".markdown": "markdown", ".pdf": "pdf", ".docx": "docx" };
export const PIECE_REFUSED_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".tiff", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];
export const PIECE_REFUSED_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "tiktok.com"];

export function assertPieceAllowed({ nature, path, url, filename } = {}) {
  const extOf = (s) => { if (!s) return ""; const c = String(s).trim().toLowerCase().split("?")[0].split("#")[0]; const i = c.lastIndexOf("."); return i >= 0 ? c.slice(i) : ""; };
  const p = path ? String(path).trim() : null;
  const u = url ? String(url).trim() : null;
  const f = filename ? String(filename).trim() : null;
  for (const cand of [f, p]) {
    const e = extOf(cand);
    if (e && PIECE_REFUSED_EXT.includes(e)) throw new Error(`pièce refusée : les photos et vidéos ne sont pas admises (extension « ${e} »). Natures admises : ${PIECE_NATURES.join(" | ")}`);
  }
  if (u) {
    let host = ""; let pathname = "";
    try {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocole non http(s)");
      host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      pathname = parsed.pathname || "";
    } catch { throw new Error(`lien invalide : ${u} (une URL http(s) publique est attendue)`); }
    if (PIECE_REFUSED_HOSTS.some((h) => host === h || host.endsWith("." + h))) throw new Error(`lien refusé : la vidéo (${host}) n'est pas une pièce client admise`);
    const e = extOf(pathname);
    if (e && PIECE_REFUSED_EXT.includes(e)) throw new Error(`lien refusé : photo/vidéo non admise (extension « ${e} »)`);
  }
  let nat = nature ? String(nature).trim() : "";
  if (u) nat = "lien";
  else if (!nat) nat = PIECE_NATURE_BY_EXT[extOf(f || p)] || "";
  if (!PIECE_NATURES.includes(nat)) throw new Error(`nature de pièce invalide : ${nature || "(absente)"} (attendu : ${PIECE_NATURES.join(" | ")})`);
  return nat;
}

// Liste les pièces d'un projet (pièces nouvelles + docs ADR-12 requalifiés).
export async function listPieces(args = {}) {
  return taskOrchestrator("piece_list", {
    projectId: args.projectId || undefined,
    nature: args.nature || undefined,
    emergent: typeof args.emergent === "boolean" ? args.emergent : undefined,
    includeRequalified: typeof args.includeRequalified === "boolean" ? args.includeRequalified : undefined,
  });
}

// Ajoute une pièce client (garde miroir PUIS MCP, garde autoritative).
export async function addPiece(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  assertPieceAllowed({ nature: args.nature, path: args.path, url: args.url, filename: args.filename });
  return taskOrchestrator("piece_add", {
    projectId: args.projectId,
    nature: args.nature || undefined,
    title: args.title || undefined,
    path: args.path || undefined,
    url: args.url || undefined,
    filename: args.filename || undefined,
    description: args.description || undefined,
    createdBy: args.createdBy,
  });
}

// Requalifie sans perte les docs ADR-12 d'un projet (ou de tous).
export async function requalifyPieces(args = {}) {
  return taskOrchestrator("piece_requalify", { projectId: args.projectId || undefined });
}

// Retire une pièce client (famille `piece`).
export async function removePiece(args = {}) {
  if (!args.pieceId) throw new Error("pieceId requis");
  return taskOrchestrator("piece_delete", { pieceId: args.pieceId });
}

// ===========================================================================
// Famille SPRINT `sprint_*` (ADR-001, T3/T4) : pont panneau→registre.
// Source de vérité = MCP (aucune écriture directe en base). La CLÔTURE
// (`sprint_close`) et la REPRISE (`sprint_reopen`) sont les actions OFFICIELLES
// qui basculent / suspendent la garde d'émergence : le panneau ne recalcule
// jamais l'émergence, il affiche l'état renvoyé par le registre.
// ===========================================================================

// `listSprints` : sprints d'un projet (statut + dates) ; la clôture AUTOMATIQUE
// à l'échéance est appliquée côté registre AVANT lecture.
export async function listSprints(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  return taskOrchestrator("sprint_list", {
    projectId: args.projectId,
    status: args.status || undefined,
  });
}

// `getSprintDetail` : détail complet d'un sprint (pièces/fonctionnalités/règles/
// tâches/recettes rattachées + compteurs).
export async function getSprintDetail(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  return taskOrchestrator("sprint_get", { sprintId: args.sprintId });
}

// `createSprint` : création à DURÉE PARAMÉTRABLE (startDate/endDate ISO 8601),
// clôture auto à l'échéance (`autoClose`), pièces client rattachées à la création.
export async function createSprint(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  if (!args.title) throw new Error("title requis");
  return taskOrchestrator("sprint_start", {
    projectId: args.projectId,
    title: args.title,
    startDate: args.startDate || undefined,
    endDate: args.endDate || undefined,
    autoClose: typeof args.autoClose === "boolean" ? args.autoClose : undefined,
    createdBy: args.createdBy || undefined,
    pieces: Array.isArray(args.pieces) && args.pieces.length ? args.pieces : undefined,
  });
}

// `closeSprint` : CLÔTURE manuelle d'un sprint — déclenche la règle d'émergence.
export async function closeSprint(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  return taskOrchestrator("sprint_close", {
    sprintId: args.sprintId,
    reason: args.reason || undefined,
  });
}

// `reopenSprint` : REPRISE / réouverture d'un sprint clôturé — suspend la règle
// d'émergence ; `endDate` prolonge l'échéance.
export async function reopenSprint(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  return taskOrchestrator("sprint_reopen", {
    sprintId: args.sprintId,
    endDate: args.endDate || undefined,
    autoClose: typeof args.autoClose === "boolean" ? args.autoClose : undefined,
    by: args.by || undefined,
  });
}

// `attachSprintPieces` : rattache des pièces client à un sprint (garde NATURE
// côté registre). `atInit=true` = pièces de création (NON émergentes).
export async function attachSprintPieces(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  const pieceIds = Array.isArray(args.pieceIds) ? args.pieceIds.filter(Boolean) : [];
  if (!pieceIds.length) throw new Error("pieceIds requis (au moins une pièce)");
  return taskOrchestrator("sprint_attach_pieces", {
    sprintId: args.sprintId,
    pieceIds,
    atInit: args.atInit === true,
    by: args.by || undefined,
  });
}

// `deleteSprint` : SUPPRIME un sprint (refus dur du sprint par défaut et des
// sprints portant tâches/recettes — c'est le registre qui décide).
export async function deleteSprint(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  return taskOrchestrator("sprint_delete", { sprintId: args.sprintId });
}

// `sprintReport` : RAPPORT DE SPRINT généré côté registre (markdown par défaut).
export async function sprintReport(args = {}) {
  if (!args.sprintId) throw new Error("sprintId requis");
  return taskOrchestrator("sprint_report", {
    sprintId: args.sprintId,
    format: args.format || undefined,
  });
}

// ===========================================================================
// Famille SESSION DE MIGRATION DES ANCIENS SPRINTS `migration_*` (ADR-001 §6).
// Pont panneau→registre. Le rattachement à l'ancien sprint est IDEMPOTENT et
// ANTI-ÉMERGENT (le registre ne marque jamais les éléments hérités).
// ===========================================================================

// `startMigration` : démarre (ou résout) la session de migration d'un projet,
// ancrée sur le sprint par défaut (= l'ancien sprint).
export async function startMigration(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  return taskOrchestrator("migration_start", {
    projectId: args.projectId,
    title: args.title || undefined,
    startDate: args.startDate || undefined,
    endDate: args.endDate || undefined,
    createdBy: args.createdBy || undefined,
  });
}

// `listMigrations` : liste des sessions de migration (filtrable par projet).
export async function listMigrations(args = {}) {
  return taskOrchestrator("migration_list", {
    project: args.project || args.projectId || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  });
}

// `getMigration` : détail d'une migration (+ sprint cible résolu).
export async function getMigration(args = {}) {
  if (!args.migrationId) throw new Error("migrationId requis");
  return taskOrchestrator("migration_get", { migrationId: args.migrationId });
}

// ===========================================================================
// Familles FONCTIONNALITÉS `feature_*` / RÈGLES `rule_*` (ADR-001, T5).
// CRUD : l'agent propose via le registre, l'humain valide/ajuste dans le panneau.
// ===========================================================================

export async function listFeatures(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  return taskOrchestrator("feature_list", {
    projectId: args.projectId,
    emergent: typeof args.emergent === "boolean" ? args.emergent : undefined,
    search: args.search || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  });
}

export async function getFeature(args = {}) {
  if (!args.featureId) throw new Error("featureId requis");
  return taskOrchestrator("feature_get", { featureId: args.featureId });
}

export async function createFeature(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  if (!args.ref) throw new Error("ref requis");
  if (!args.userStory) throw new Error("userStory requis");
  return taskOrchestrator("feature_register", {
    projectId: args.projectId,
    ref: args.ref,
    role: args.role || undefined,
    userStory: args.userStory,
    sourcedPieceId: args.sourcedPieceId || undefined,
    recetteId: args.recetteId || undefined,
    createdBy: args.createdBy || undefined,
  });
}

export async function updateFeature(args = {}) {
  if (!args.featureId) throw new Error("featureId requis");
  return taskOrchestrator("feature_update", {
    featureId: args.featureId,
    ref: args.ref || undefined,
    role: args.role != null ? args.role : undefined,
    userStory: args.userStory || undefined,
    sourcedPieceId: args.sourcedPieceId != null ? args.sourcedPieceId : undefined,
    // Qualification d'implémentation (T-20260921-133134-yz2i) — pass-through.
    implemented: typeof args.implemented === "boolean" ? args.implemented : undefined,
    implementedOrigin: args.implementedOrigin || undefined,
    implementedNote: args.implementedNote != null ? args.implementedNote : undefined,
    by: args.by || undefined,
  });
}

// `deleteFeature` : SUPPRIME une fonctionnalité + ses liens (CASCADE). Garde
// d'intégrité « ADR ≥ 1 fonctionnalité » : refus `[ADR_LAST_FEATURE]` sauf
// `cascadeAdrs=true` (supprime aussi l'ADR orpheline). Le registre reste la
// source de vérité ; le panneau ne fait que relayer.
export async function deleteFeature(args = {}) {
  if (!args.featureId) throw new Error("featureId requis");
  return taskOrchestrator("feature_delete", {
    featureId: args.featureId,
    cascadeAdrs: args.cascadeAdrs === true,
    by: args.by || undefined,
  });
}

export async function listRules(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  return taskOrchestrator("rule_list", {
    projectId: args.projectId,
    emergent: typeof args.emergent === "boolean" ? args.emergent : undefined,
    search: args.search || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  });
}

export async function getRule(args = {}) {
  if (!args.ruleId) throw new Error("ruleId requis");
  return taskOrchestrator("rule_get", { ruleId: args.ruleId });
}

export async function createRule(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  if (!args.ref) throw new Error("ref requis");
  if (!args.content) throw new Error("content requis");
  return taskOrchestrator("rule_register", {
    projectId: args.projectId,
    ref: args.ref,
    content: args.content,
    sourcedPieceId: args.sourcedPieceId || undefined,
    recetteId: args.recetteId || undefined,
    // Association EXPLICITE de rôles (T-20260922-064200-e0yw) — pass-through.
    roles: Array.isArray(args.roles) ? args.roles : undefined,
    roleGlobal: typeof args.roleGlobal === "boolean" ? args.roleGlobal : undefined,
    createdBy: args.createdBy || undefined,
  });
}

export async function updateRule(args = {}) {
  if (!args.ruleId) throw new Error("ruleId requis");
  return taskOrchestrator("rule_update", {
    ruleId: args.ruleId,
    ref: args.ref || undefined,
    content: args.content || undefined,
    sourcedPieceId: args.sourcedPieceId != null ? args.sourcedPieceId : undefined,
    // Association EXPLICITE de rôles (T-20260922-064200-e0yw) — pass-through.
    // `[]` est transmis tel quel (association vidée) : `Array.isArray` le distingue d'un champ absent.
    roles: Array.isArray(args.roles) ? args.roles : undefined,
    roleGlobal: typeof args.roleGlobal === "boolean" ? args.roleGlobal : undefined,
    // Qualification d'implémentation (T-20260921-133134-yz2i) — pass-through.
    implemented: typeof args.implemented === "boolean" ? args.implemented : undefined,
    implementedOrigin: args.implementedOrigin || undefined,
    implementedNote: args.implementedNote != null ? args.implementedNote : undefined,
    by: args.by || undefined,
  });
}

// `deleteRule` : SUPPRIME une règle métier + ses liens (CASCADE). Aucun invariant.
export async function deleteRule(args = {}) {
  if (!args.ruleId) throw new Error("ruleId requis");
  return taskOrchestrator("rule_delete", { ruleId: args.ruleId });
}

// ===========================================================================
// Liaisons N:N (ADR-001, T5) : dispatcher UNIQUE `linkEntities`/`unlinkEntities`.
// Évite 18 routes dédiées : `kind` → tool MCP `*_link`/`*_unlink` + clés des 2
// extrémités. Aucune logique métier côté panneau (le registre valide).
// ===========================================================================
export const LINK_KINDS = {
  feature_rule:    { a: "featureId", b: "regleId" },
  feature_gherkin: { a: "featureId", b: "e2eTestId" },
  feature_adr:     { a: "featureId", b: "adrId" },
  feature_sprint:  { a: "featureId", b: "sprintId" },
  rule_sprint:     { a: "regleId",   b: "sprintId" },
  task_sprint:     { a: "taskId",    b: "sprintId" },
  task_feature:    { a: "taskId",    b: "featureId" },
  recette_sprint:  { a: "recetteId", b: "sprintId" },
  recette_feature: { a: "recetteId", b: "featureId" },
};

function linkArgs(kind, args = {}) {
  const map = LINK_KINDS[kind];
  if (!map) throw new Error(`kind de lien inconnu : ${kind || "(absent)"} (attendu : ${Object.keys(LINK_KINDS).join(" | ")})`);
  if (!args.a || !args.b) throw new Error("a et b requis (identifiants des 2 extrémités du lien)");
  return { tool: `${kind}_link`, args: { [map.a]: args.a, [map.b]: args.b } };
}

// `linkEntities` : crée un lien N:N (idempotent côté registre).
export async function linkEntities(args = {}) {
  const { tool, args: mcpArgs } = linkArgs(String(args.kind || "").trim(), args);
  return taskOrchestrator(tool, mcpArgs);
}

// `unlinkEntities` : retire un lien N:N.
export async function unlinkEntities(args = {}) {
  const kind = String(args.kind || "").trim();
  const map = LINK_KINDS[kind];
  if (!map) throw new Error(`kind de lien inconnu : ${kind || "(absent)"} (attendu : ${Object.keys(LINK_KINDS).join(" | ")})`);
  if (!args.a || !args.b) throw new Error("a et b requis (identifiants des 2 extrémités du lien)");
  return taskOrchestrator(`${kind}_unlink`, { [map.a]: args.a, [map.b]: args.b });
}

// ===========================================================================
// CARDINALITÉS HEURISTIQUES / ÉMERGENCE (ADR-001 §5, T6). LECTURE SEULE (sauf
// la clôture TRACÉE d'un signal) : le panneau affiche l'état, ne recalcule rien.
// ===========================================================================

// `cardinalityReport` : agrégat (10 vues + signaux) ou vue unique via `view`.
export async function cardinalityReport(args = {}) {
  if (!args.projectId) throw new Error("projectId requis");
  return taskOrchestrator("cardinality_report", {
    projectId: args.projectId,
    view: args.view || undefined,
  });
}

// `listCardinalitySignals` : historique filtrable des signaux de cardinalité.
export async function listCardinalitySignals(args = {}) {
  return taskOrchestrator("cardinality_signals_list", {
    projectId: args.projectId || undefined,
    entityType: args.entityType || undefined,
    entityId: args.entityId || undefined,
    status: args.status || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  });
}

// `resolveCardinalitySignal` : clôt un signal avec une RAISON TRACÉE (obligatoire).
export async function resolveCardinalitySignal(args = {}) {
  if (!args.signalId) throw new Error("signalId requis");
  if (!args.resolution) throw new Error("resolution requise (raison tracée de la clôture)");
  return taskOrchestrator("cardinality_signal_resolve", {
    signalId: args.signalId,
    resolution: args.resolution,
    resolvedBy: args.resolvedBy || undefined,
  });
}

// --- Famille ADR `adr_*` (item 125) : lecture condensée + bloc de contexte ---
// `listAdrs` : vue condensée des ADR d'un projet (titre, statut, repos, décision).
export async function listAdrs(args = {}) {
  return taskOrchestrator("adr_list", {
    projectId: args.projectId || undefined,
    repoIds: Array.isArray(args.repoIds) && args.repoIds.length ? args.repoIds : undefined,
    status: args.status || undefined,
    search: args.search || undefined,
    includeRepoDocs: args.includeRepoDocs,
  });
}

// `adrContext` : bloc « ## ADR de référence » prêt à injecter dans un prompt.
// `adrIds` FOURNI vide = sélection explicite vide → aucun ADR (bloc vide) ;
// `adrIds` absent = ADR actives du projet (filtrage éventuel par `scope`).
export async function adrContext(args = {}) {
  if (Array.isArray(args.adrIds) && args.adrIds.length === 0) {
    return { projectId: args.projectId || null, count: 0, adrs: [], context: "" };
  }
  return taskOrchestrator("adr_context", {
    projectId: args.projectId || undefined,
    scope: Array.isArray(args.scope) ? args.scope : undefined,
    adrIds: Array.isArray(args.adrIds) && args.adrIds.length ? args.adrIds : undefined,
    taskId: args.taskId || undefined,
  });
}

// `featureContext` : bloc « ## Fonctionnalités de référence » prêt à injecter
// dans un prompt (T-20260922-070103-ncs1). Sélection EXPLICITE (`featureIds`) ;
// sélection vide ⇒ `context: ""` (aucun bloc — court-circuit local, 0 appel).
export async function featureContext(args = {}) {
  if (Array.isArray(args.featureIds) && args.featureIds.length === 0) {
    return { projectId: args.projectId || null, count: 0, features: [], context: "" };
  }
  return taskOrchestrator("feature_context", {
    projectId: args.projectId || undefined,
    featureIds: Array.isArray(args.featureIds) && args.featureIds.length ? args.featureIds : undefined,
  });
}

// `ruleContext` : bloc « ## Règles métier de référence » prêt à injecter dans un
// prompt (T-20260922-070103-ncs1). Sélection vide ⇒ `context: ""` (aucun bloc).
export async function ruleContext(args = {}) {
  if (Array.isArray(args.ruleIds) && args.ruleIds.length === 0) {
    return { projectId: args.projectId || null, count: 0, rules: [], context: "" };
  }
  return taskOrchestrator("rule_context", {
    projectId: args.projectId || undefined,
    ruleIds: Array.isArray(args.ruleIds) && args.ruleIds.length ? args.ruleIds : undefined,
  });
}

// --- Vigilances ADR (item 126) : historique filtrable + levée tracée ----------
// `listAdrVigilances` : historique append-only des points de vigilance ADR
// remontés par les recettes/tests (manquant/conflit), filtrable.
export async function listAdrVigilances(args = {}) {
  return taskOrchestrator("adr_vigilance_list", {
    projectId: args.projectId || args.project || undefined,
    recetteId: args.recetteId || undefined,
    type: args.type || undefined,
    status: args.status || undefined,
    from: args.from || undefined,
    to: args.to || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  });
}

// `resolveAdrVigilance` : lève un point de vigilance avec une RAISON TRACÉE
// (obligatoire) — ADR créée / dépréciation actée / décision explicite / manuelle.
export async function resolveAdrVigilance(args = {}) {
  if (!args.vigilanceId) throw new Error("vigilanceId requis");
  if (!args.resolution) throw new Error("resolution requise (raison tracée de la levée)");
  return taskOrchestrator("adr_vigilance_resolve", {
    vigilanceId: args.vigilanceId,
    resolution: args.resolution,
    resolutionKind: args.resolutionKind || undefined,
    adrId: args.adrId || undefined,
    resolvedBy: args.resolvedBy || undefined,
  });
}

// Pièces jointes d'ADR (item 122) : rattacher un document/fichier à une ADR.
// 3 sources : 'registry' (targetDocId), 'import' (path stocké storage/ref-docs)
// ou 'ref' (path référencé workspace/checkout).
export async function addDocAttachment(args = {}) {
  if (!args.docId) throw new Error("docId requis");
  return taskOrchestrator("doc_attachment_add", {
    docId: args.docId,
    targetDocId: args.targetDocId || undefined,
    path: args.path || undefined,
    title: args.title || undefined,
    kind: args.kind || undefined,
    nature: args.nature || undefined,
    source: args.source || undefined,
    meta: args.meta || undefined,
  });
}

// Retrait d'une pièce jointe d'ADR par son attachmentId stable.
export async function removeDocAttachment(args = {}) {
  if (!args.attachmentId) throw new Error("attachmentId requis");
  return taskOrchestrator("doc_attachment_remove", {
    attachmentId: args.attachmentId,
    docId: args.docId || undefined,
  });
}

// Lecture dédiée des pièces jointes d'une ADR (doc_attachment_list MCP).
export async function listDocAttachments(args = {}) {
  if (!args.docId) throw new Error("docId requis");
  return taskOrchestrator("doc_attachment_list", { docId: args.docId });
}

const DOC_KINDS = ["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"];

// Import d'un fichier DOCUMENT depuis le PC de l'utilisateur : le fichier est
// stocké côté serveur (storage/ref-docs) puis enregistré comme doc de référence
// (ADR-12) rattaché à un projet et/ou un repo. Renvoie le doc enregistré.
export async function registerDocUpload({ kind, title, filename, dataBase64, projectId, repoId, repoIds, status, context, decision, consequences, replacedBy, global, organizationId, by }) {
  if (!dataBase64 || !filename) throw new Error("fichier requis (filename + dataBase64)");
  if (!DOC_KINDS || !DOC_KINDS.includes(kind)) throw new Error("kind requis (adr-tech | specs-fonctionnelles | scenarios-gherkin)");
  const fs = await import("node:fs");
  const docDir = "/root/orchestrator-panel/storage/ref-docs";
  fs.mkdirSync(docDir, { recursive: true });
  const buf = Buffer.from(String(dataBase64), "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("fichier trop volumineux (max 2 Mo)");
  const safe = String(filename).replace(/[^\w.\-]+/g, "_").slice(-80);
  const dest = `${docDir}/${Date.now()}-${safe}`;
  fs.writeFileSync(dest, buf);
  const r = await taskOrchestrator("doc_register", {
    kind,
    title: title ? String(title).trim() : undefined,
    path: dest,
    // Champs ADR structurés : ne pas les perdre sur le chemin d'import fichier.
    status: status || undefined,
    context: context ?? undefined,
    decision: decision ?? undefined,
    consequences: consequences ?? undefined,
    replacedBy: replacedBy || undefined,
    projectId: projectId || undefined,
    repoId: repoId || undefined,
    repoIds: Array.isArray(repoIds) && repoIds.length ? repoIds : undefined,
    global: global === true ? true : undefined,
    organizationId: organizationId || undefined,
    createdBy: by,
  });
  return { ok: true, doc: r && r.doc };
}

// Chemin relatif d'accès public à un fichier importé (storage/ref-docs).
export function refDocRelPath(absPath) {
  if (!absPath) return null;
  return String(absPath).replace("/root/orchestrator-panel/storage/", "");
}

export async function createRecette({ project, title, description, taskIds, documents, featureIds, ruleIds, adrIds, by, organizationId }) {
  if (!project || !String(project).trim()) throw new Error("un projet (produit) requis pour créer une recette — ses repos transverses couvrent la portée");
  if (!title || !String(title).trim()) throw new Error("titre requis pour créer une recette");
  const r = await taskOrchestrator("recette_start", {
    project: String(project).trim(),
    title: String(title).trim(),
    description: description ? String(description).trim() : undefined,
    taskIds: (taskIds || []).filter(Boolean),
    // Sélection du panneau (T-20260922-070103-ncs1) : fonctionnalités + règles
    // métier (NON bloquant ; tableaux vides tolérés ⇒ 0 sélection possible).
    featureIds: (featureIds || []).filter(Boolean),
    ruleIds: (ruleIds || []).filter(Boolean),
    status: "pending",
    createdBy: by || undefined,
    organizationId: organizationId || undefined,
  });
  const recetteId = r.recette.recetteId;
  // Rattache les documents fournis à la création (import ou artefact).
  for (const doc of documents || []) {
    if (!doc) continue;
    try {
      await addRecetteDocument({
        recetteId,
        mode: doc.mode === "artifact" ? "artifact" : "import",
        filename: doc.filename,
        dataBase64: doc.dataBase64,
        artifactId: doc.artifactId,
        nature: doc.nature,
        title: doc.title,
      });
    } catch {}
  }
  // ADR (item 125) : ADR sélectionnées (lignes multi-sélection du panneau) →
  // rattachées à la recette comme documents à lire (chemin existant, nature
  // `[adr-tech] …`). L'agent de recette les liste via recette_get et les lit
  // pour confronter le constat. Le module doc_* n'est pas sollicité ici.
  if (Array.isArray(adrIds) && adrIds.length) {
    const wanted = new Set(adrIds.map((x) => String(x).trim()).filter(Boolean));
    let allAdrs = [];
    try {
      const rl = await listAdrs({ projectId: project, includeRepoDocs: true });
      allAdrs = (rl && rl.adrs) || [];
    } catch {}
    for (const a of allAdrs) {
      if (!a || !wanted.has(a.adrId)) continue;
      try {
        await taskOrchestrator("recette_doc_add", {
          recetteId,
          source: "import",
          path: a.path,
          title: a.title || a.adrId,
          nature: `[adr-tech] Architecture technique — ADR ${a.status || "(sans statut)"}${a.isGlobal ? " (globale)" : ""} à lire pour la recette.`,
        });
      } catch {}
    }
  }
  return { ok: true, recette: r.recette };
}

// Lance (ou reprend) la session dédiée de l'agent-recette pour une recette.
// `force = true` : ignore la session rattachée et en démarre une nouvelle.
export async function launchRecetteSession({ recetteId, force = false, adrIds, featureIds, ruleIds }) {
  if (!recetteId) throw new Error("recetteId requis");
  return withLaunchLock(`recette:${recetteId}`, async () => {
    const r = await taskOrchestrator("recette_get", { recetteId });
    const rec = r && r.recette;
    if (!rec) throw new Error(`recette inconnue : ${recetteId}`);

    const proj = rec.project;
    const dir = await projectAnchorDir(proj);

    // REPRISE : dès qu'une session est rattachée à la recette, on la REPREND —
    // on n'en relance JAMAIS automatiquement une nouvelle. L'existence est
    // vérifiée PAR IDENTIFIANT auprès du serveur opencode (fiable même si la
    // session vit dans un autre projet opencode). Pour repartir de zéro :
    // `force = true`.
    if (!force && rec.sessionId && /^ses_/.test(rec.sessionId)) {
      if (await sessionAlive(rec.sessionId, dir)) {
        return { recetteId, sessionId: rec.sessionId, resumed: true };
      }
    }
    // ADR (item 125) : bloc de contexte ADR du projet — `adrIds` = sélection du
    // panneau, sinon les ADR ACTIVES (Proposé/Accepté) du projet. L'agent de
    // recette confronte le constat à ces décisions (statut + décision + conséquence).
    let adrCtx = { context: "", adrs: [] };
    try { adrCtx = await adrContext({ projectId: proj, adrIds, scope: [] }); } catch {}
    // Blocs Fonctionnalités / Règles métier (T-20260922-070103-ncs1) : dérivés des
    // LIENS PERSISTÉS de la recette (`rec.fonctionnalites` / `rec.regles`, lus par
    // le `recette_get` ci-dessus) ⇒ 0 N+1 et le prompt reflète la recette réellement
    // enregistrée. Surcharge explicite possible (parité avec `adrIds`) via
    // `featureIds`/`ruleIds` ; un tableau vide = aucune sélection (bloc vide).
    const fIds = Array.isArray(featureIds) ? featureIds : (rec.fonctionnalites || []).map((f) => f.id);
    const rIds = Array.isArray(ruleIds) ? ruleIds : (rec.regles || []).map((r) => r.id);
    let featureCtx = { context: "" };
    let ruleCtx = { context: "" };
    try { featureCtx = await featureContext({ projectId: proj, featureIds: fIds }); } catch {}
    try { ruleCtx = await ruleContext({ projectId: proj, ruleIds: rIds }); } catch {}
    const prompt = buildRecettePrompt({ project: proj, repos: rec.repos || [], title: rec.title, taskIds: rec.tasks || [], adrContext: adrCtx.context || "", featureContext: featureCtx.context || "", ruleContext: ruleCtx.context || "" });
    const { sessionId } = await launchSession({ dir, agent: "agent-recette", prompt, title: `Recette ${rec.title || proj}` });
    if (!sessionId || !/^ses_/.test(sessionId)) {
      throw new Error("échec de lancement de la session de recette (agent-recette indisponible ?)");
    }
    await taskOrchestrator("recette_session_set", { recetteId, sessionId });
    return { recetteId, sessionId, resumed: false };
  });
}

// Lance (ou reprend) la session dédiée de l'agent-sprint pour un sprint.
// `force = true` : ignore la session rattachée et en démarre une nouvelle.
// Anti-doublon : dès qu'une session est rattachée au sprint (`sprints.session_id`),
// on la REPREND (vérifiée par identifiant auprès du serveur opencode). La session
// est ancrée sur le projet du sprint ; le prompt injecte les PIÈCES CLIENT et les
// documents de référence. Le rattachement passe par `sprint_session_set` (T8) —
// qui ne touche PAS au statut open/close du sprint.
export async function launchSprintSession({ sprintId, force = false, adrIds }) {
  if (!sprintId) throw new Error("sprintId requis");
  return withLaunchLock(`sprint:${sprintId}`, async () => {
    const d = await taskOrchestrator("sprint_get", { sprintId });
    const sprint = d && d.sprint;
    if (!sprint) throw new Error(`sprint inconnu : ${sprintId}`);

    const proj = sprint.project;
    const dir = await projectAnchorDir(proj);

    // REPRISE : session rattachée au sprint (vérifiée par identifiant). Pour
    // repartir de zéro : `force = true`.
    if (!force && sprint.sessionId && /^ses_/.test(sprint.sessionId)) {
      if (await sessionAlive(sprint.sessionId, dir)) {
        return { sprintId, sessionId: sprint.sessionId, resumed: true };
      }
    }
    // ADR (item 125) : bloc de contexte ADR du projet — ancrage (l'agent de
    // sprint ne les écrit jamais ; il les cite au plus).
    let adrCtx = { context: "", adrs: [] };
    try { adrCtx = await adrContext({ projectId: proj, adrIds, scope: [] }); } catch {}
    // Repos transverses du projet (ADR 11) — portée réelle du sprint.
    let repos = [];
    try {
      const pr = await listProjects();
      const project = ((pr && pr.projects) || []).find((x) => x.id === proj);
      repos = ((project && project.repos) || []).map((id) => ({ repoId: id }));
    } catch { repos = []; }
    // Documents de référence du projet (ADR-12) — décrivent l'EXISTANT.
    let docs = [];
    try {
      const dl = await listDocs({ projectId: proj, includeRepoDocs: true });
      docs = ((dl && dl.docs) || []).filter((x) => x && x.path);
    } catch { docs = []; }
    const prompt = buildSprintPrompt({
      sprintId,
      project: proj,
      repos,
      title: sprint.title,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      pieces: (d && d.pieces) || [],
      docs,
      adrContext: adrCtx.context || "",
    });
    const { sessionId } = await launchSession({ dir, agent: "agent-sprint", prompt, title: `Sprint ${sprint.title || sprintId}` });
    if (!sessionId || !/^ses_/.test(sessionId)) {
      throw new Error("échec de lancement de la session de sprint (agent-sprint indisponible ?)");
    }
    await taskOrchestrator("sprint_session_set", { sprintId, sessionId });
    return { sprintId, sessionId, resumed: false };
  });
}

// Lance (ou reprend) la session dédiée de l'agent-migration pour une migration
// d'anciens sprints. `force = true` : ignore la session rattachée et en démarre
// une nouvelle. Anti-doublon : dès qu'une session est rattachée à la migration
// (`migrations.session_id`), on la REPREND (vérifiée par identifiant auprès du
// serveur opencode). La session est ancrée sur le projet de la migration ; le
// prompt injecte l'ancien sprint cible (sprint par défaut), les ADR
// monolithiques, les pièces client et les documents de référence. Le
// rattachement passe par `migration_session_set` (qui ne touche PAS au statut
// open/close du sprint). R6 : si aucun répertoire d'ancrage n'est résolu
// (`dir = null`), on lève une erreur explicite.
export async function launchMigrationSession({ migrationId, force = false, adrIds } = {}) {
  if (!migrationId) throw new Error("migrationId requis");
  return withLaunchLock(`migration:${migrationId}`, async () => {
    const r = await taskOrchestrator("migration_get", { migrationId });
    const migration = r && r.migration;
    if (!migration) throw new Error(`migration inconnue : ${migrationId}`);

    const proj = migration.project;
    const dir = await projectAnchorDir(proj);
    if (!dir) throw new Error(`aucun répertoire d'ancrage résolu pour le projet ${proj} (migration ${migrationId})`);

    // REPRISE : session rattachée à la migration (vérifiée par identifiant).
    // Pour repartir de zéro : `force = true`.
    if (!force && migration.sessionId && /^ses_/.test(migration.sessionId)) {
      if (await sessionAlive(migration.sessionId, dir)) {
        return { migrationId, sessionId: migration.sessionId, resumed: true };
      }
    }
    // ADR (item 125) : bloc de contexte ADR du projet — ancrage de référence.
    let adrCtx = { context: "", adrs: [] };
    try { adrCtx = await adrContext({ projectId: proj, adrIds, scope: [] }); } catch {}
    // Repos transverses du projet (ADR 11) — portée réelle de la migration.
    let repos = [];
    try {
      const pr = await listProjects();
      const project = ((pr && pr.projects) || []).find((x) => x.id === proj);
      repos = ((project && project.repos) || []).map((id) => ({ repoId: id }));
    } catch { repos = []; }
    // Documents de référence du projet (ADR-12) — décrivent l'EXISTANT.
    let docs = [];
    try {
      const dl = await listDocs({ projectId: proj, includeRepoDocs: true });
      docs = ((dl && dl.docs) || []).filter((x) => x && x.path);
    } catch { docs = []; }
    // ADR MONOLITHIQUES du projet (à découper) : `adr_list` (vue condensée).
    let adrs = [];
    try {
      const al = await taskOrchestrator("adr_list", { projectId: proj, includeRepoDocs: true });
      adrs = ((al && al.adrs) || []).filter((x) => x && x.path);
    } catch { adrs = []; }
    // Pièces client du projet (matière héritée à rattacher).
    let pieces = [];
    try {
      const pl = await taskOrchestrator("piece_list", { projectId: proj });
      pieces = (pl && pl.pieces) || [];
    } catch { pieces = []; }
    const sprintId = migration.sprintId || null;
    const prompt = buildMigrationPrompt({
      migrationId,
      project: proj,
      repos,
      sprintId,
      title: migration.title,
      startDate: (migration.sprint && migration.sprint.startDate) || null,
      endDate: (migration.sprint && migration.sprint.endDate) || null,
      pieces,
      docs,
      adrs,
      adrContext: adrCtx.context || "",
    });
    const { sessionId } = await launchSession({ dir, agent: "agent-migration", prompt, title: `Migration ${migration.title || proj}` });
    if (!sessionId || !/^ses_/.test(sessionId)) {
      throw new Error("échec de lancement de la session de migration (agent-migration indisponible ?)");
    }
    await taskOrchestrator("migration_session_set", { migrationId, sessionId });
    return { migrationId, sessionId, resumed: false };
  });
}

// Lance la SESSION D'ORCHESTRATION UNIQUE d'un batch en mode `session`.
// Une seule session orchestrateur pilote toutes les tâches (ordonnancement +
// délégation aux agents de fond). Anti-doublon : si le batch a déjà une session
// rattachée, on la REPREND (sauf `force = true`).
export async function launchBatchSession({ batchId, force = false }) {
  if (!batchId) throw new Error("batchId requis");
  return withLaunchLock(`batch:${batchId}`, async () => {
    const r = await taskOrchestrator("batch_get", { batchId });
    const batch = r && r.batch;
    if (!batch) throw new Error(`batch inconnu : ${batchId}`);

    if (!force && batch.sessionId && /^ses_/.test(batch.sessionId)) {
      const anchor = await projectAnchorDir(batch.project);
      if (await sessionAlive(batch.sessionId, anchor)) {
        return { batchId, sessionId: batch.sessionId, resumed: true };
      }
    }

    // Ancrage : répertoire du projet (gitPath ou repoDir d'un repo lié) + détail
    // des tâches pour le prompt.
    const dir = await projectAnchorDir(batch.project);
    const tasksDetail = [];
    for (const taskId of batch.tasks || []) {
      try {
        const t = await taskOrchestrator("task_get", { taskId });
        const task = t && t.task;
        tasksDetail.push({ id: taskId, title: task && task.title, request: task && task.request, status: (t && t.executions && t.executions[0] && t.executions[0].status) || "queued" });
      } catch { tasksDetail.push({ id: taskId, status: "?" }); }
    }
    const prompt = buildBatchSessionPrompt({ batch, tasksDetail });
    const { sessionId } = await launchSession({ dir, agent: "orchestrator", prompt, title: `Batch ${batch.batchId} — ${(batch.title || "").slice(0, 50)}` });
    if (!sessionId || !/^ses_/.test(sessionId)) {
      throw new Error("échec de lancement de la session d'orchestration du batch (orchestrator indisponible ?)");
    }
    await taskOrchestrator("batch_set_session", { batchId, sessionId });
    return { batchId, sessionId, resumed: false };
  });
}

// Lecture des batches (délégation MCP) — pour le panneau.
export async function listBatches(project) {
  const r = await taskOrchestrator("batch_list", { project: project || undefined });
  return (r && r.batches) || [];
}

export async function getBatchDetail(batchId) {
  const r = await taskOrchestrator("batch_get", { batchId });
  return r && r.batch;
}

export async function setBatchStatus(batchId, status) {
  const r = await taskOrchestrator("batch_set_status", { batchId, status });
  return r && r.batch;
}

// Passe un test E2E en DRAFT (entité créée, spec en cours de rédaction via session).
export async function draftE2ETest(e2eTestId) {
  if (!e2eTestId) throw new Error("e2eTestId requis");
  return taskOrchestrator("e2e_test_draft", { e2eTestId });
}

// --- Sessions test-agent libres (page Tests E2E) ----------------------------
// Accéder à l'agent de test SANS forcément créer un test : l'utilisateur choisit
// entre reprendre une session test-agent existante ou en ouvrir une nouvelle.

// Liste les sessions opencode existantes pertinentes pour les tests E2E.
// `opencode session list` est SCOPÉ par répertoire : on agrège donc les sessions
// de tous les checkouts connus (gitPath/workspace des projets + e2eRepoDir des
// repos), dédupliquées par sessionId. Marquées si rattachées à un test
// (e2e_tests.session_id) pour l'afficher.
export async function listTestAgentSessions() {
  // Répertoires à scruter : gitPath des projets + e2eRepoDir des repos + dossiers
  // des sessions déjà connues (répertoire porté par la session elle-même).
  let dirs = new Set();
  try {
    const pr = await taskOrchestrator("project_list", {});
    const projects = (pr && pr.projects) || [];
    for (const p of projects) {
      if (p.gitPath) dirs.add(String(p.gitPath).replace(/\/+$/, ""));
      for (const rid of p.repos || []) {
        try {
          const g = await taskOrchestrator("repo_get", { id: rid });
          if (g && g.repo) {
            for (const d of [g.repo.repoDir, g.repo.e2eRepoDir].filter(Boolean)) dirs.add(String(d).replace(/\/+$/, ""));
          }
        } catch {}
      }
    }
  } catch {}
  dirs.add("/root/orchestrator-panel"); // sessions du panneau lui-même
  const byId = new Map();
  for (const dir of dirs) {
    let sessions = [];
    try { sessions = listSessions(dir) || []; } catch { sessions = []; }
    for (const s of sessions) {
      if (s && s.id && !byId.has(s.id)) byId.set(s.id, { ...s, directory: s.directory || dir });
    }
  }
  // Sessions rattachées à un test (registre).
  let testSessionIds = new Set();
  try {
    const list = await taskOrchestrator("e2e_list", { status: undefined, limit: 1000 });
    for (const t of (list && list.tests) || []) if (t.sessionId && /^ses_/.test(t.sessionId)) testSessionIds.add(t.sessionId);
  } catch {}
  // On ne présente QUE les sessions test-agent pertinentes : rattachées à un test
  // (registre) ou au titre explicite (création/MAJ test, session test-agent libre).
  const testRelevant = (title) => {
    if (!title) return false;
    const t = String(title).toLowerCase();
    return t.startsWith("création test") || t.startsWith("maj test") || t.includes("session test-agent") || t.includes("test-agent");
  };
  return [...byId.values()]
    .filter((s) => testSessionIds.has(s.id) || testRelevant(s.title))
    .map((s) => ({
      sessionId: s.id,
      title: s.title || null,
      directory: s.directory || null,
      updated: s.updated ? new Date(s.updated).toISOString() : null,
      boundToTest: testSessionIds.has(s.id),
      inRepo: true,
    }))
    .sort((a, b) => (a.updated || "").localeCompare(b.updated || "") * -1);
}

// Ouvre une session test-agent LIBRE (aucun test créé) dans le workspace d'un
// projet/repo. Retourne { sessionId } (l'utilisateur reprendra via l'UI).
// `adrIds` (optionnel) : ADR (item 125) à fournir en contexte (lignes
// multi-sélection du panneau). Tableau FOURNI vide = aucun ADR ; absent = ADR
// ACTIVES (Proposé/Accepté) du projet.
export async function launchFreeTestSession({ project, repoId, message, adrIds }) {
  // Résolution du répertoire d'ancrage : le repo donné (sinon le projet → 1er repo).
  let dir = null;
  if (repoId) {
    try { const g = await taskOrchestrator("repo_get", { id: repoId }); if (g && g.repo && g.repo.repoDir) dir = g.repo.repoDir; } catch {}
  }
  if (!dir && project) dir = await projectGitPath(project);
  const projects = project ? [project] : [];
  // ADR (item 125) : bloc de contexte ADR — `adrIds` = sélection du panneau,
  // sinon les ADR actives du projet. Le module doc_* reste consultable à la demande.
  let adrCtx = { context: "", adrs: [] };
  if (project) {
    try { adrCtx = await adrContext({ projectId: project, adrIds, scope: [] }); } catch {}
  }
  const title = `Session test-agent ${project ? "— " + project : ""}`;
  const prompt = buildFreeTestPrompt({ project, projects, message, adrContext: adrCtx.context || "" });
  const { sessionId } = await launchSession({ dir, agent: "test-agent", prompt, title });
  if (!sessionId || !/^ses_/.test(sessionId)) {
    throw new Error("échec de lancement de la session test-agent (agent indisponible ?)");
  }
  return { sessionId, resumed: false, dir, adrProvided: (adrCtx.adrs || []).map((a) => a.adrId) };
}

// Relance/reprend une session test-agent existante (la continue via injectMessage).
export async function continueFreeTestSession({ sessionId, message }) {
  if (!sessionId) throw new Error("sessionId requis");
  if (!sessionExists(sessionId)) throw new Error(`session inconnue ou expirée : ${sessionId}`);
  const r = injectMessage({ sessionId, prompt: message || "Poursuis notre échange sur les tests E2E." });
  return { sessionId: r.sessionId || sessionId, resumed: true };
}

// Lance (ou reprend) la session de CRÉATION / MISE À JOUR d'un test E2E (entité
// 1er niveau) via l'agent `test-agent`. `force = true` : nouvelle session.
// `adrIds` (optionnel) : ADR (item 125) à fournir en contexte — lignes
// multi-sélection du panneau (elles PRIMENT sur le filtre de scope). Tableau
// FOURNI vide = aucun ADR ; absent = ADR actives du projet applicables au
// scope du test (specFile).
export async function launchTestSession({ e2eTestId, force = false, mode, adrIds }) {
  if (!e2eTestId) throw new Error("e2eTestId requis");
  const r = await taskOrchestrator("e2e_test_get", { e2eTestId });
  const t = r && r.test;
  if (!t) throw new Error(`test E2E inconnu : ${e2eTestId}`);

  // REPRISE : dès qu'une session est rattachée au test, on la REPREND (jamais de
  // doublon). Pour repartir de zéro : `force = true`. Si la session rattachée a
  // disparu (expirée/nettoyée), on en crée une nouvelle sans demander `force`.
  if (!force && t.sessionId && /^ses_/.test(t.sessionId)) {
    const projs0 = (t.projects && t.projects.length ? t.projects : (t.project ? [t.project] : []));
    let g0 = null;
    for (const p of projs0) { g0 = await projectGitPath(p); if (g0) break; }
    if (g0 && sessionExists(t.sessionId, g0)) {
      return { e2eTestId, sessionId: t.sessionId, resumed: true };
    }
  }

  // Ancrage : repo source du test (1er projet couvert avec un gitPath).
  const projs = (t.projects && t.projects.length ? t.projects : (t.project ? [t.project] : []));
  let dir = null;
  for (const p of projs) {
    const g = await projectGitPath(p);
    if (g) { dir = g; break; }
  }
  // ADR (item 125) : bloc de contexte ADR applicables — `adrIds` = sélection du
  // panneau (prime sur le scope), sinon ADR actives du projet filtrées par le
  // scope du test (specFile). Le module doc_* reste consultable à la demande.
  let adrCtx = { context: "", adrs: [] };
  try {
    adrCtx = await adrContext({
      projectId: projs[0] || t.project || null,
      adrIds,
      scope: t.specFile ? [t.specFile] : [],
    });
  } catch {}
  const testMode = mode || (t.status === "DRAFT" ? "create" : "update");
  const prompt = buildTestPrompt({
    e2eTestId: t.e2eTestId,
    project: t.project,
    projects: projs,
    title: t.title || t.scenario,
    description: t.description,
    mode: testMode,
    specFile: t.specFile,
    scenario: t.scenario,
    adrContext: adrCtx.context || "",   // ADR (item 125) : bloc de contexte
  });
  const { sessionId } = await launchSession({ dir, agent: "test-agent", prompt, title: `${testMode === "create" ? "Création" : "MAJ"} test ${t.title || t.e2eTestId}` });
  if (!sessionId || !/^ses_/.test(sessionId)) {
    throw new Error("échec de lancement de la session test-agent (agent test-agent indisponible ?)");
  }
  await taskOrchestrator("e2e_test_session_set", { e2eTestId, sessionId });
  return { e2eTestId, sessionId, resumed: false, mode: testMode };
}

// Rattache un document à une recette : import (upload base64) ou artefact existant.
export async function addRecetteDocument({ recetteId, mode, filename, dataBase64, artifactId, nature, title }) {
  if (!recetteId) throw new Error("recetteId requis");
  if (mode === "artifact") {
    if (!artifactId) throw new Error("artifactId requis en mode artefact");
    return taskOrchestrator("recette_doc_add", { recetteId, source: "artifact", artifactId, nature: nature || undefined, title: title || undefined });
  }
  // mode import
  if (!dataBase64 || !filename) throw new Error("fichier requis (mode import)");
  const docDir = "/root/orchestrator-panel/storage/recette-docs";
  const fs = await import("node:fs");
  fs.mkdirSync(docDir, { recursive: true });
  const safeName = String(filename).replace(/[^\w.\-]+/g, "_");
  const dest = `${docDir}/${recetteId}-${Date.now()}-${safeName}`;
  fs.writeFileSync(dest, Buffer.from(String(dataBase64), "base64"));
  return taskOrchestrator("recette_doc_add", { recetteId, source: "import", path: dest, nature: nature || undefined, title: title || filename });
}

export async function removeRecetteDocument({ documentId }) {
  if (!documentId) throw new Error("documentId requis");
  return taskOrchestrator("recette_doc_remove", { documentId });
}

// Rattache une tâche couverte à une recette (garde : projet de la recette vérifié côté MCP).
export async function addRecetteTask({ recetteId, taskId }) {
  if (!recetteId || !taskId) throw new Error("recetteId et taskId requis");
  const r = await taskOrchestrator("recette_link_task", { recetteId, taskId });
  return { ok: true, recette: r && r.recette };
}

// Détache une tâche couverte d'une recette (la tâche reste intacte).
export async function removeRecetteTask({ recetteId, taskId }) {
  if (!recetteId || !taskId) throw new Error("recetteId et taskId requis");
  const r = await taskOrchestrator("recette_unlink_task", { recetteId, taskId });
  return { ok: true, recette: r && r.recette };
}

// Supprime un élément de recette (garde : refus si tâche déjà créée depuis).
export async function removeRecetteItem({ recetteId, itemId }) {
  if (!itemId) throw new Error("itemId requis");
  const r = await taskOrchestrator("recette_item_delete", { itemId: Number(itemId) });
  return { ok: true };
}

// Modifie un élément de recette (édition lors de la confirmation de clôture).
// Garde : recette encore ouverte (non `done`) — on n'édite pas une recette clôturée.
export async function updateRecetteItem({ recetteId, itemId, fields = {} }) {
  if (!recetteId || !itemId) throw new Error("recetteId et itemId requis");
  const r = await taskOrchestrator("recette_get", { recetteId });
  const rec = r && r.recette;
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  if (rec.status === "done") throw new Error("recette clôturée : élément non modifiable");
  const allowed = ["content", "classification", "discussion", "scope", "project", "title", "acceptance", "execOrder", "vigilance"];
  const payload = { itemId: Number(itemId) };
  for (const k of allowed) if (fields[k] !== undefined) payload[k] = fields[k];
  const res = await taskOrchestrator("recette_item_update", payload);
  return { ok: true, item: res && res.item };
}

// Clôt la recette : crée une tâche par élément confirmé (via task_register) puis confirme.
// `createTasks: false` clôt la recette SANS générer de tâche (les éléments relevés
// restent consultables dans le détail) — les corrections éventuelles des éléments
// ont déjà été persistées via updateRecetteItem.
export async function finishRecette({ recetteId, items, by, launchMode = "batch", createTasks = true }) {
  if (!recetteId) throw new Error("recetteId requis");
  const r = await taskOrchestrator("recette_get", { recetteId });
  const rec = r && r.recette;
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  if (rec.status !== "in_progress") throw new Error(`recette non en cours (statut ${rec.status})`);

  // PRÉ-CHECK ADR (item 126) — AVANT toute création de tâche : un point de
  // vigilance ADR OUVERT (ADR manquante / conflit) BLOQUE la terminaison avec la
  // raison explicite. Le registre reste la source de vérité (garde confirmRecette),
  // mais ce pré-check évite de créer des tâches orphelines avant le refus.
  const vig = await listAdrVigilances({ recetteId, status: "open" });
  const vigOpen = Array.isArray(vig && vig.vigilancess) ? vig.vigilancess : [];
  if (vigOpen.length) {
    const reasons = vigOpen.map((v) => v.reason || (v.type === "conflict" ? `Conflit d'ADR : ${v.adrId || "?"} vs ${v.relatedAdrId || "?"}` : `ADR manquant pour ${v.entity || "?"}`));
    throw new Error(`terminaison bloquée : ${reasons.join(" ; ")} — résolvez chaque point (adr_vigilance_resolve) ou levez-le explicitement avec une raison tracée`);
  }

  // Clôture SANS création de tâches : on confirme simplement la recette.
  if (createTasks === false) {
    const confirmed = await taskOrchestrator("recette_confirm", { recetteId, confirmedBy: by || "human" });
    return { ok: true, recetteId, created: [], batch: null, createTasks: false, recette: confirmed.recette };
  }

  const created = [];
  const CLASS_LABEL = { rework: "Rework", bug: "Bug", improvement: "Improvement", feature: "Feature" };
  // 1 recette = 1 PROJET unique : chaque item cible le projet de la recette
  // (les repos transverses du projet sont des repos, pas des projets).
  const recProject = rec.project;
  // Phase 4 : l'execOrder des items détermine la PRÉCÉDENCE entre les tâches
  // créées. Les items de même numéro sont parallèles ; un numéro supérieur
  // dépend des inférieurs (dependencies → auto-avancement séquentiel du batch).
  const orderedItems = (items || [])
    .filter((it) => it && it.content)
    .sort((a, b) => (Number(a.execOrder) || 999) - (Number(b.execOrder) || 999));
  // Intentions TEST des items enregistrés (source de vérité : rec.items via
  // recette_get → testIntent). Un constat qui requiert de faire évoluer les tests
  // crée une tâche clairement orientée test (test-agent).
  const recItemsById = new Map((rec.items || []).map((i) => [i.itemId, i]));
  const intentLabel = (intent) => intent && intent.action ? `${intent.testType === "e2e" ? "[E2E TEST] " : "[TEST] "}${intent.action === "create" ? "créer" : intent.action === "update" ? "adapter" : "obsoléter"}${intent.target ? ` (${intent.target})` : ""}` : null;
  const byOrder = new Map(); // execOrder → [taskId]
  for (const it of orderedItems) {
    const cls = ["rework", "bug", "improvement", "feature"].includes(it.classification) ? it.classification : "rework";
    const type = cls === "bug" ? "debug" : "feature";
    const itemProject = recProject;
    const execOrder = (it.execOrder != null && it.execOrder !== "") ? Number(it.execOrder) : null;
    // Intentions test/document de l'item enregistré (testIntent/docIntent), sinon du payload.
    const full = recItemsById.get(Number(it.itemId)) || it;
    const testIntent = full.testIntent || null;
    const docIntent = full.docIntent || null;
    const docTypeTag = docIntent && docIntent.docType === "scenarios-gherkin" ? "GHERKIN"
      : docIntent && docIntent.docType === "specs-fonctionnelles" ? "SPECS"
      : docIntent && docIntent.docType === "adr-tech" ? "ADR"
      : docIntent ? "DOC" : null;
    const docIntentLabel = docIntent && docIntent.action
      ? `[${docTypeTag || "DOC"} ${docIntent.action === "create" ? "documenter" : docIntent.action === "update" ? "mettre à jour" : "obsoléter"}${docIntent.target ? ` (${docIntent.target})` : ""}]`
      : null;
    const intentTag = testIntent ? intentLabel(testIntent) : null;
    const tags = [intentTag, docIntentLabel].filter(Boolean).join(" ");
    // Dépendances : toutes les tâches déjà créées d'ORDRE STRICTEMENT INFÉRIEUR.
    const deps = [];
    if (execOrder != null) {
      for (const [order, ids] of byOrder) {
        if (order < execOrder) deps.push(...ids);
      }
    }
    const request = `${tags ? tags + " — " : ""}[${CLASS_LABEL[cls]} — issu de la recette ${recetteId}] ${it.content}`;
    // Acceptance : intention test → comportement/scénario à couvrir ; intention doc →
    // le document doit refléter la décision ; sinon le critère fourni.
    const acceptanceCriterion = it.acceptance || (testIntent
      ? `${testIntent.action === "obsolete" ? "Le test obsolète est retiré/marqué obsolète." : `Le test couvre le comportement attendu.${testIntent.scenario ? ` Scénario : ${testIntent.scenario}.` : ""}`}`
      : docIntent
        ? `${docIntent.action === "obsolete" ? "Le document obsolète est retiré/marqué obsolète." : `Le document de référence reflète la décision de recette.${docIntent.summary ? ` À documenter : ${docIntent.summary}.` : ""}`}`
        : undefined);
    const reg = await taskOrchestrator("task_register", {
      request,
      title: it.title || `${tags ? tags + " — " : ""}[${CLASS_LABEL[cls]}] ${it.content.slice(0, 60)}`,
      project: itemProject,
      type,
      priority: "normal",
      scope: Array.isArray(it.scope) && it.scope.length ? it.scope : undefined,
      acceptanceCriteria: acceptanceCriterion ? [acceptanceCriterion] : undefined,
      dependencies: deps.length ? [...new Set(deps)] : undefined,
      linkedTasks: (rec.tasks || []).map((t) => ({ taskId: t, description: `Couvert par la recette ${recetteId} — ${CLASS_LABEL[cls]}` })),
      recetteClass: cls,
      recetteId,
    });
    const newTaskId = reg && (reg.taskId || (reg.task && reg.task.id));
    if (newTaskId) {
      created.push({ taskId: newTaskId, classification: cls, content: it.content, execOrder, testIntent, docIntent });
      if (execOrder != null) {
        const arr = byOrder.get(execOrder) || [];
        arr.push(newTaskId);
        byOrder.set(execOrder, arr);
      }
      try { await taskOrchestrator("recette_item_update", { itemId: Number(it.itemId), status: "task_created", createdTaskId: newTaskId }); } catch {}
    }
  }

  const confirmed = await taskOrchestrator("recette_confirm", { recetteId, confirmedBy: by || "human" });
  // Batch d'orchestration (v0.9.0) : les tâches créées par cette recette forment
  // UN batch naturel — une session d'orchestration unique pour les séquencer sans
  // conflit. maxParallel = 2 (défaut sûr).
  let batch = null;
  if (created.length) {
    try {
      // Mode de lancement (3 options à la clôture) :
      //  - batch   → le worker batch-pilot lance les tâches prêtes automatiquement ;
      //  - session → une session orchestrateur unique pilote le batch (déclenché ensuite) ;
      //  - manual  → aucun auto-lancement, l'utilisateur lance chaque tâche lui-même.
      const mode = ["batch", "session", "manual"].includes(launchMode) ? launchMode : "batch";
      const b = await taskOrchestrator("batch_register", {
        project: recProject,
        title: `Recette ${rec.title || recetteId}`,
        recetteId,
        taskIds: created.map((c) => c.taskId),
        maxParallel: 2,
        launchMode: mode,
        createdBy: by || "human",
      });
      batch = b && b.batch;
    } catch {}
  }
  return { ok: true, recetteId, created, batch, launchMode: batch && (batch.launchMode || "batch"), recette: confirmed.recette };
}

// ===========================================================================
// Tests E2E — entités de 1er niveau (v0.9.0). Toute écriture transite par le
// MCP task-orchestrator (source de vérité unique) : enregistrement, run,
// paramètres, liens tâche↔test, obsolescence.
// ===========================================================================

// Enregistre (ou réactive) un test E2E + paramètres éventuels. project = PROJET
// (produit) ; repoIds = repos de code associés (repos traversés, ADR 11). Renvoie
// le test à jour (via e2e_test_get) afin que la réponse contienne repos + params.
export async function createE2ETest({ project, specFile, scenario, title, description, coveredProjects, repoIds, params, organizationId, createdBy }) {
  if (!project || !specFile || !scenario) throw new Error("project (projet produit), specFile et scenario requis");
  const r = await taskOrchestrator("e2e_test_register", {
    project,
    specFile,
    scenario,
    title: title ? String(title).trim() : undefined,
    description: description ? String(description).trim() : undefined,
    coveredProjects: Array.isArray(coveredProjects) && coveredProjects.length ? coveredProjects.map((p) => p && String(p).trim()).filter(Boolean) : undefined,
    repoIds: Array.isArray(repoIds) && repoIds.length ? repoIds.map((x) => x && String(x).trim()).filter(Boolean) : undefined,
    organizationId: organizationId || undefined,
    createdBy: createdBy || undefined,
  });
  const test = r && r.test;
  const id = test && (test.e2eTestId || test.id);
  if (Array.isArray(params) && params.length && id) {
    await taskOrchestrator("e2e_test_param_set", { e2eTestId: id, params });
    const g = await taskOrchestrator("e2e_test_get", { e2eTestId: id });
    return { ok: true, test: g && g.test };
  }
  return r;
}

// Lance une exécution E2E sur un test (entité 1er niveau). project = repo
// source du test, e2eTestId résout le specPattern + défauts des paramètres.
export async function runE2ETest(args) {
  if (!args || !args.repoDir || !String(args.repoDir).trim()) throw new Error("repoDir requis (dépôt applicatif à exécuter)");
  return taskOrchestrator("e2e_run", {
    project: args.project,
    repoDir: String(args.repoDir).trim(),
    baseUrl: args.baseUrl || undefined,
    e2eTestId: args.e2eTestId,
    origin: args.origin || undefined,
    taskId: args.taskId || undefined,
    specPattern: args.specPattern || undefined,
    playwrightConfig: args.playwrightConfig || undefined,
    pwArgs: Array.isArray(args.pwArgs) && args.pwArgs.length ? args.pwArgs : undefined,
    paramValues: args.paramValues || undefined,
    secretNames: Array.isArray(args.secretNames) && args.secretNames.length ? args.secretNames : undefined,
  });
}

// Déclare/remplace les paramètres d'un test (valeurs défaut NON sensibles).
export async function setE2ETestParams({ e2eTestId, params }) {
  if (!e2eTestId) throw new Error("e2eTestId requis");
  return taskOrchestrator("e2e_test_param_set", { e2eTestId, params: params || [] });
}

// Associe un test E2E à une tâche (N:N pure association, relation typée).
export async function linkE2ETest({ taskId, e2eTestId, relationType, reason }) {
  if (!taskId || !e2eTestId) throw new Error("taskId et e2eTestId requis");
  return taskOrchestrator("e2e_test_link", { taskId, e2eTestId, relationType: relationType || "REGRESSION", reason: reason || undefined });
}

// Détache un test E2E d'une tâche (le test reste enregistré).
export async function unlinkE2ETest({ taskId, e2eTestId }) {
  if (!taskId || !e2eTestId) throw new Error("taskId et e2eTestId requis");
  return taskOrchestrator("e2e_test_unlink", { taskId, e2eTestId });
}

// Marque un test E2E OBSOLETE (spec disparu du repo). Jamais de suppression.
export async function obsoleteE2ETest(e2eTestId) {
  if (!e2eTestId) throw new Error("e2eTestId requis");
  return taskOrchestrator("e2e_test_obsolete", { e2eTestId });
}

// ===========================================================================
// Vars E2E (module vars/secrets unifié) — variables d'env par projet.
// kind='variable' (clair, éditable) | 'secret' (chiffré côté MCP, jamais en clair).
// ===========================================================================
export async function setE2EVar({ project, name, value, kind, purpose }) {
  if (!project || !name || value === undefined || value === "") throw new Error("project, name et value requis");
  return taskOrchestrator("e2e_var_set", { project, name, value, kind: kind || "variable", purpose: purpose || undefined });
}

export async function listE2EVars(project, kind) {
  if (!project) throw new Error("project requis");
  return taskOrchestrator("e2e_var_list", { project, kind: kind || undefined });
}

export async function deleteE2EVar({ project, name }) {
  if (!project || !name) throw new Error("project et name requis");
  return taskOrchestrator("e2e_var_delete", { project, name });
}

// Aliases rétrocompat (module secrets v0.8.6) → vars unifiées.
export async function setE2ESecret({ project, name, value, purpose }) {
  return setE2EVar({ project, name, value, kind: "secret", purpose });
}
export async function listE2ESecrets(project) {
  const r = await listE2EVars(project, "secret");
  return { ok: r && r.ok, project, secrets: (r && r.vars) || [], count: (r && r.count) || 0 };
}
export async function deleteE2ESecret({ project, name }) {
  return deleteE2EVar({ project, name });
}

// ===========================================================================
// Tests E2E — collecteur hôte (cadrage 07). Importe les résultats Playwright
// produits par le CI (instance éphémère) depuis storage/e2e/inbox/<runId>.
// ===========================================================================
const E2E_STORAGE = "/root/orchestrator-panel/storage/e2e";
const E2E_INBOX = `${E2E_STORAGE}/inbox`;
const E2E_RUNS = `${E2E_STORAGE}/runs`;

function e2eStableId(project, specFile, scenario) {
  let h = 0x811c9dc5;
  for (const part of [project, specFile, scenario]) {
    for (let i = 0; i < part.length; i++) { h ^= part.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  const hash = (h >>> 0).toString(36).slice(0, 8);
  const proj = String(project).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "APP";
  return `E2E-${proj}-${hash}`;
}

const fs = (await import("node:fs"));
const path = (await import("node:path"));

async function e2eRunRecorded(runId) {
  const marker = path.join(E2E_RUNS, runId, "imported.json");
  return fs.existsSync(marker);
}

// Prune rétention mensuelle des vidéos (fichiers + url) au-delà de N jours.
export async function pruneE2EVideos({ days = 35 } = {}) {
  const cutoff = Date.now() - (Number(days) || 35) * 86400000;
  const rows = (await taskOrchestrator("e2e_execution_list", { limit: 5000 })).executions || [];
  let removed = 0;
  for (const ex of rows) {
    if (!ex.videoUrl || !ex.createdAt) continue;
    if (new Date(ex.createdAt).getTime() < cutoff) {
      try { fs.unlinkSync(ex.videoUrl); } catch {}
      try {
        await taskOrchestrator("e2e_execution_update", { executionId: ex.id, videoUrl: null });
        removed++;
      } catch {}
    }
  }
  return { removedVideos: removed };
}

// Importe un run CI (manifest + résultats) dans le registre E2E.
export async function collectE2EResults({ runId }) {
  if (!runId) throw new Error("runId requis");
  const runDir = path.join(E2E_INBOX, runId);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest introuvable : ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { taskId, project, env, commitSha, branch, pipelineRef, attempts = 1 } = manifest;
  const results = Array.isArray(manifest.results) ? manifest.results : [];
  if (!results.length) throw new Error("aucun résultat dans le manifest");

  // Répertoire de travail stable du run (conservé pour preuves humaines).
  const outDir = path.join(E2E_RUNS, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const imported = [];
  for (const res of results) {
    if (!res.specFile || !res.scenario) continue;
    const reg = await taskOrchestrator("e2e_test_register", { project, specFile: res.specFile, scenario: res.scenario, title: res.title });
    const e2eTestId = reg && reg.test && reg.test.id;
    if (!e2eTestId) continue;
    if (taskId) {
      await taskOrchestrator("e2e_test_link", { taskId, e2eTestId, relationType: res.relation || "REGRESSION", reason: res.reason || "Associé à l'exécution CI" });
    }
    const rec = await taskOrchestrator("e2e_execution_record", {
      e2eTestId, taskId, deploymentId: manifest.deploymentId, planId: manifest.planId,
      env, commitSha, branch, pipelineRef, attempts,
    });
    const executionId = rec && rec.execution && rec.execution.id;
    if (!executionId) continue;

    // Rapport texte (IA + humain) : conservé sous storage/e2e/runs/<runId>/.
    const reportName = `report-${executionId}.json`;
    const reportPath = path.join(outDir, reportName);
    fs.writeFileSync(reportPath, JSON.stringify({ runId, executionId, e2eTestId, specFile: res.specFile, scenario: res.scenario, status: res.status, durationMs: res.durationMs, error: res.error || null, attempts }, null, 2));

    // Vidéo (preuve humaine) si présente dans le run.
    let videoUrl = null;
    if (res.videoFile && fs.existsSync(path.join(runDir, res.videoFile))) {
      const ext = path.extname(res.videoFile) || ".webm";
      const dest = path.join(outDir, `video-${executionId}${ext}`);
      fs.copyFileSync(path.join(runDir, res.videoFile), dest);
      videoUrl = dest;
    }

    await taskOrchestrator("e2e_execution_update", {
      executionId,
      status: res.status || "ERROR",
      durationMs: res.durationMs || null,
      logsUrl: reportPath,
      videoUrl,
      summary: (res.summary || (res.error ? `Échec : ${String(res.error).slice(0, 400)}` : `PASS ${res.scenario}`)).slice(0, 2000),
      verdictBy: "build-notify",
      executedAt: manifest.executedAt || new Date().toISOString(),
    });
    imported.push({ e2eTestId, executionId, status: res.status || "ERROR" });
  }

  // Marqueur d'import (évite les doubles imports du même run).
  fs.writeFileSync(path.join(outDir, "imported.json"), JSON.stringify({ runId, importedAt: new Date().toISOString(), count: imported.length }, null, 2));
  // Nettoyage de l'inbox pour ce run.
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}

  const failures = imported.filter((i) => i.status === "FAILED").length;
  return { ok: true, runId, imported, count: imported.length, failures };
}
