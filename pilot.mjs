// pilot.mjs — Logique métier du centre de pilotage d'agents IA.
//
// Toute écriture transite par le MCP `task-orchestrator` (source de vérité unique),
// jamais par une écriture directe dans registry.db. Le lancement/injection de
// sessions opencode est délégué au bridge `session-bridge.mjs` (Plan C).

import { taskOrchestrator, coderWorkspaces } from "./mcp-client.mjs";
import { launchSession, injectMessage, buildLaunchPrompt, buildReworkPrompt, buildRecettePrompt, buildTestPrompt, buildFreeTestPrompt, buildBatchSessionPrompt, listSessions, killSession, sessionExists } from "./session-bridge.mjs";

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
    projectId: args.projectId || undefined, repoId: args.repoId || undefined,
    organizationId: args.organizationId || undefined, createdBy: args.createdBy,
  });
}
export async function updateDoc(args) {
  return taskOrchestrator("doc_update", {
    docId: args.docId, kind: args.kind || undefined, title: args.title,
    path: args.path, description: args.description,
    addProjectId: args.addProjectId || undefined, addRepoId: args.addRepoId || undefined,
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

const DOC_KINDS = ["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"];

// Import d'un fichier DOCUMENT depuis le PC de l'utilisateur : le fichier est
// stocké côté serveur (storage/ref-docs) puis enregistré comme doc de référence
// (ADR-12) rattaché à un projet et/ou un repo. Renvoie le doc enregistré.
export async function registerDocUpload({ kind, title, filename, dataBase64, projectId, repoId, organizationId, by }) {
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
    projectId: projectId || undefined,
    repoId: repoId || undefined,
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

export async function createRecette({ project, title, description, taskIds, documents, docIds, by, organizationId }) {
  if (!project || !String(project).trim()) throw new Error("un projet (produit) requis pour créer une recette — ses repos transverses couvrent la portée");
  if (!title || !String(title).trim()) throw new Error("titre requis pour créer une recette");
  const r = await taskOrchestrator("recette_start", {
    project: String(project).trim(),
    title: String(title).trim(),
    description: description ? String(description).trim() : undefined,
    taskIds: (taskIds || []).filter(Boolean),
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
  // ADR-12 : docs de référence cochées (cases à cocher) → rattachées à la recette
  // comme documents à lire (chemin existant, nature par kind). L'agent de recette
  // les liste via recette_get et les lit pour confronter le constat.
  if (Array.isArray(docIds) && docIds.length) {
    const wanted = new Set(docIds.map((x) => String(x).trim()).filter(Boolean));
    const allDocs = [];
    try {
      const rl = await taskOrchestrator("doc_list", { projectId: project, includeRepoDocs: true });
      for (const d of ((rl && rl.docs) || [])) if (d && !allDocs.some((x) => x.docId === d.docId)) allDocs.push(d);
    } catch {}
    for (const d of allDocs) {
      if (!wanted.has(d.docId)) continue;
      try {
        await taskOrchestrator("recette_doc_add", {
          recetteId,
          source: "import",
          path: d.path,
          title: d.title || d.docId,
          nature: `[${d.kind}] ${d.kind === "adr-tech" ? "Architecture technique" : d.kind === "specs-fonctionnelles" ? "Specs fonctionnelles (User stories/règles métier)" : "Scénarios Gherkin"} — document de référence du projet à lire pour la recette.`,
        });
      } catch {}
    }
  }
  return { ok: true, recette: r.recette };
}

// Lance (ou reprend) la session dédiée de l'agent-recette pour une recette.
// `force = true` : ignore la session rattachée et en démarre une nouvelle.
export async function launchRecetteSession({ recetteId, force = false }) {
  if (!recetteId) throw new Error("recetteId requis");
  const r = await taskOrchestrator("recette_get", { recetteId });
  const rec = r && r.recette;
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);

  const proj = rec.project;
  const gitPath = await projectGitPath(proj);
  const dir = gitPath || null;

  // REPRISE : dès qu'une session est rattachée à la recette, on la REPREND —
  // on n'en relance JAMAIS automatiquement une nouvelle. L'ancienne détection
  // par `opencode session list` (répertoire) dépendait du cwd du serveur au
  // moment du lancement : en cas de faux négatif, chaque clic créait une
  // nouvelle session (doublons). Pour repartir de zéro : `force = true`.
  // Si le projet n'a pas de répertoire (gitPath null), la session stockée est
  // dans un contexte inconnu (souvent un fantôme du cwd panneau) — on la
  // ignore et on en crée une nouvelle dans le projet global d'opencode.
  if (!force && rec.sessionId && /^ses_/.test(rec.sessionId)) {
    if (dir && sessionExists(rec.sessionId, dir)) {
      return { recetteId, sessionId: rec.sessionId, resumed: true };
    }
    // gitPath null ou session disparue → on crée une nouvelle session.
  }
  // ADR-12 : documents de référence du projet couvert (adr-tech, specs,
  // gherkin) — lus en contexte par l'agent de recette pour confronter le constat.
  let recDocs = [];
  try {
    const rd = await taskOrchestrator("doc_list", { projectId: proj, includeRepoDocs: true });
    recDocs = (rd && rd.docs) || [];
  } catch {}
  const prompt = buildRecettePrompt({ project: proj, repos: rec.repos || [], title: rec.title, taskIds: rec.tasks || [], docs: recDocs });
  const { sessionId } = await launchSession({ dir, agent: "agent-recette", prompt, title: `Recette ${rec.title || proj}` });
  if (!sessionId || !/^ses_/.test(sessionId)) {
    throw new Error("échec de lancement de la session de recette (agent-recette indisponible ?)");
  }
  await taskOrchestrator("recette_session_set", { recetteId, sessionId });
  return { recetteId, sessionId, resumed: false };
}

// Lance la SESSION D'ORCHESTRATION UNIQUE d'un batch en mode `session`.
// Une seule session orchestrateur pilote toutes les tâches (ordonnancement +
// délégation aux agents de fond). Anti-doublon : si le batch a déjà une session
// rattachée, on la REPREND (sauf `force = true`).
export async function launchBatchSession({ batchId, force = false }) {
  if (!batchId) throw new Error("batchId requis");
  const r = await taskOrchestrator("batch_get", { batchId });
  const batch = r && r.batch;
  if (!batch) throw new Error(`batch inconnu : ${batchId}`);

  if (!force && batch.sessionId && /^ses_/.test(batch.sessionId)) {
    const gitPath = await projectGitPath(batch.project);
    if (gitPath && sessionExists(batch.sessionId, gitPath)) {
      return { batchId, sessionId: batch.sessionId, resumed: true };
    }
  }

  // Ancrage : checkout (gitPath) du projet + détail des tâches pour le prompt.
  const gitPath = await projectGitPath(batch.project);
  const dir = gitPath || null;
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
// `docIds` (optionnel) : documents de référence (ADR-12) du projet à fournir en
// contexte (cases à cocher) — défaut : tous les docs du projet.
export async function launchFreeTestSession({ project, repoId, message, docIds }) {
  // Résolution du répertoire d'ancrage : le repo donné (sinon le projet → 1er repo).
  let dir = null;
  if (repoId) {
    try { const g = await taskOrchestrator("repo_get", { id: repoId }); if (g && g.repo && g.repo.repoDir) dir = g.repo.repoDir; } catch {}
  }
  if (!dir && project) dir = await projectGitPath(project);
  const projects = project ? [project] : [];
  // ADR-12 : documents de référence du projet (+ ses repos), filtrés par docIds.
  let sessionDocs = [];
  if (project) {
    try {
      const dr = await taskOrchestrator("doc_list", { projectId: project, includeRepoDocs: true });
      sessionDocs = (dr && dr.docs) || [];
    } catch {}
    if (Array.isArray(docIds)) {
      if (docIds.length) {
        const wanted = new Set(docIds.map((x) => String(x).trim()).filter(Boolean));
        sessionDocs = sessionDocs.filter((d) => d && wanted.has(d.docId));
      } else {
        sessionDocs = []; // tableau fourni vide = aucun doc
      }
    }
  }
  const title = `Session test-agent ${project ? "— " + project : ""}`;
  const prompt = buildFreeTestPrompt({ project, projects, message, docs: sessionDocs });
  const { sessionId } = await launchSession({ dir, agent: "test-agent", prompt, title });
  if (!sessionId || !/^ses_/.test(sessionId)) {
    throw new Error("échec de lancement de la session test-agent (agent indisponible ?)");
  }
  return { sessionId, resumed: false, dir, docsProvided: sessionDocs.map((d) => d.docId) };
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
// `docIds` (optionnel) : sous-ensemble de documents de référence (ADR-12) à
// fournir en contexte (les cases à cocher du panneau). Défaut : tous les docs
// du projet.
export async function launchTestSession({ e2eTestId, force = false, mode, docIds }) {
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
  // ADR-12 : docs de référence — toutes celles du projet (défaut), ou seulement
  // la sous-sélection cochée (docIds). Un tableau FOURNI même vide = aucun doc.
  let sessionDocs = t.docs || [];
  if (Array.isArray(docIds)) {
    if (docIds.length) {
      const wanted = new Set(docIds.map((x) => String(x).trim()).filter(Boolean));
      sessionDocs = (t.docs || []).filter((d) => d && wanted.has(d.docId));
    } else {
      sessionDocs = [];
    }
  }
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
    docs: sessionDocs,   // ADR-12 : docs de référence du projet (contexte)
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

// Clôt la recette : crée une tâche par élément confirmé (via task_register) puis confirme.
export async function finishRecette({ recetteId, items, by, launchMode = "batch" }) {
  if (!recetteId) throw new Error("recetteId requis");
  const r = await taskOrchestrator("recette_get", { recetteId });
  const rec = r && r.recette;
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  if (rec.status !== "in_progress") throw new Error(`recette non en cours (statut ${rec.status})`);

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
