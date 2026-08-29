// pilot.mjs — Logique métier du centre de pilotage d'agents IA.
//
// Toute écriture transite par le MCP `task-orchestrator` (source de vérité unique),
// jamais par une écriture directe dans registry.db. Le lancement/injection de
// sessions opencode est délégué au bridge `session-bridge.mjs` (Plan C).

import { taskOrchestrator, coderWorkspaces } from "./mcp-client.mjs";
import { launchSession, injectMessage, buildLaunchPrompt, buildReworkPrompt, killSession } from "./session-bridge.mjs";

// Décision n°7 : agents contraints par type de tâche.
export function agentsForType(type) {
  if (type === "audit") {
    return [{ agent: "hexagonal-architecture-auditor", role: "auditor" }];
  }
  // feature / debug → planner + executor
  return [
    { agent: "atomic-plan", role: "planner" },
    { agent: "build-notify", role: "executor" },
  ];
}

export async function listWorkspaces() {
  return coderWorkspaces("workspace_list", {});
}

export async function listProjects() {
  return taskOrchestrator("project_list", {});
}

export async function createProject({ id, name, workspace, gitPath, createdBy }) {
  if (!id || !name) throw new Error("id et name requis pour créer un projet");
  return taskOrchestrator("project_register", { id, name, workspace, gitPath, createdBy });
}

export async function deleteProject(id) {
  if (!id) throw new Error("id requis");
  return taskOrchestrator("project_delete", { id });
}

export async function deleteTask(taskId) {
  if (!taskId) throw new Error("taskId requis");
  return taskOrchestrator("task_delete", { taskId });
}

export async function createTask({ request, project, type, scope, priority, agents }) {
  if (!request || !project || !type) throw new Error("request, project et type requis");
  const reg = await taskOrchestrator("task_register", {
    request,
    project,
    type,
    scope: scope || undefined,
    priority: priority || "normal",
  });
  const taskId = reg && (reg.taskId || (reg.task && reg.task.id));
  const list = agents && agents.length ? agents : agentsForType(type);
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
  return taskOrchestrator("decision_resolve", { decisionId, status, resolution, by: by || "human" });
}

// Validation de la recette (acceptation humaine après déploiement) : approved/rejected
// + remarques, tracée comme décision kind="recette", colonne recette_status.
export async function resolveRecette({ taskId, status, resolution, by }) {
  if (!taskId || !status) throw new Error("taskId et status requis");
  return taskOrchestrator("task_recette", { taskId, status, resolution, by: by || "human" });
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
export async function launchTask({ taskId }) {
  if (!taskId) throw new Error("taskId requis");

  // 1. Lire l'état courant.
  const t = await taskOrchestrator("task_get", { taskId });
  const task = t && t.task;
  const exec = t && t.executions && t.executions[0];
  const status = exec && exec.status;

  // 2. Garde : une tâche déjà liée à une session, ou déjà sortie de `queued`,
  //    ne peut pas être lancée une seconde fois.
  if (task && task.sessionId) {
    throw new Error(`tâche ${taskId} déjà liée à une session (${task.sessionId}) : lancement refusé`);
  }
  if (status !== "queued") {
    throw new Error(`tâche ${taskId} non lançable (statut ${status || "inconnu"}) : seules les tâches queued peuvent être lancées`);
  }

  // 3. Transition ATOMIQUE queued → started (verrou optimiste). Elle réserve le
  //    lancement : un second appel concurrent échoue (transition refusée).
  //    La planification (`started` → `planning`) sera posée par l'orchestrateur
  //    quand il déléguera à atomic-plan.
  await taskOrchestrator("task_transition", { taskId, to: "started", by: "orchestrator" });

  // 4. Lancement de la session orchestrateur + lien.
  const prompt = buildLaunchPrompt({
    taskId,
    executionId: exec && exec.executionId,
    project: task && task.project,
    workspace: task && task.workspace,
    scope: task && task.scope,
    request: task && task.request,
  });
  const dir = await projectGitPath(task && task.project);
  const { sessionId } = await launchSession({ dir, agent: "orchestrator", prompt, title: `Tâche ${taskId}` });
  if (sessionId) {
    await taskOrchestrator("task_link_session", { taskId, sessionId });
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
  if (newSid) await taskOrchestrator("task_link_session", { taskId, sessionId: newSid });
  return { taskId, sessionId: newSid };
}

// Arrêt d'une session de tâche : tue le process opencode + supprime la session
// + abandonne la tâche + libère le worktree (bouton « Tuer la session »).
export async function killTaskSession({ taskId }) {
  if (!taskId) throw new Error("taskId requis");

  const t = await taskOrchestrator("task_get", { taskId });
  const task = t && t.task;
  const sessionId = task && task.sessionId;
  const wt = t && t.worktree;

  const killed = killSession({ taskId, sessionId });

  let aborted = false;
  try {
    const r = await taskOrchestrator("task_transition", { taskId, to: "aborted", by: "human" });
    aborted = !!(r && r.to === "aborted");
  } catch {}

  // Vider la session (ne plus pointer vers la session supprimée).
  try { await taskOrchestrator("task_clear_session", { taskId }); } catch {}

  let worktreeReleased = false;
  if (wt && ["RESERVED", "IN_USE"].includes(wt.status)) {
    try {
      await taskOrchestrator("worktree_release", { worktreeId: wt.worktreeId });
      worktreeReleased = true;
    } catch {}
  }

  return { taskId, sessionId, killed, aborted, worktreeReleased };
}

// Relance une tâche abandonnée (kill) : vide la session, repasse en queued, puis lance.
export async function relaunchTask({ taskId }) {
  if (!taskId) throw new Error("taskId requis");
  await taskOrchestrator("task_clear_session", { taskId });
  await taskOrchestrator("task_transition", { taskId, to: "queued", by: "human" });
  return launchTask({ taskId });
}
