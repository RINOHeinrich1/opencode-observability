// pilot.mjs — Logique métier du centre de pilotage d'agents IA.
//
// Toute écriture transite par le MCP `task-orchestrator` (source de vérité unique),
// jamais par une écriture directe dans registry.db. Le lancement/injection de
// sessions opencode est délégué au bridge `session-bridge.mjs` (Plan C).

import { taskOrchestrator, coderWorkspaces } from "./mcp-client.mjs";
import { launchSession, injectMessage, buildLaunchPrompt, buildReworkPrompt, buildRecettePrompt, killSession, sessionExists } from "./session-bridge.mjs";

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

export async function listWorkspaces() {
  return coderWorkspaces("workspace_list", {});
}

export async function listProjects() {
  return taskOrchestrator("project_list", {});
}

export async function createProject({ id, name, workspace, gitPath, mainBranch, createdBy }) {
  if (!id || !name) throw new Error("id et name requis pour créer un projet");
  if (!mainBranch || !String(mainBranch).trim()) {
    throw new Error("branche principale requise (obligatoire pour autoriser le déploiement)");
  }
  const reg = await taskOrchestrator("project_register", { id, name, workspace, gitPath, mainBranch: mainBranch.trim(), createdBy });

  // Bug 1 — crée automatiquement le répertoire du projet dans le workspace Coder
  // (mkdir + git init). Non bloquant : un échec (workspace arrêté/inconnu)
  // renvoie un avertissement sans empêcher l'enregistrement du projet.
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
export async function createTask({ request, title, acceptanceCriteria, project, type, scope, priority, auditTarget, linkedTasks, directExecution, agents }) {
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
    title: task && task.title,
    acceptanceCriteria: task && task.acceptanceCriteria,
    auditTarget: task && task.auditTarget,
    directExecution: task && task.directExecution,
  });
  const dir = await projectGitPath(task && task.project);
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
export async function createRecette({ project, projects, title, description, taskIds, documents, by }) {
  const projs = [...new Set(((projects && projects.length ? projects : (project ? [project] : [])).map((p) => p && String(p).trim()).filter(Boolean)))];
  if (!projs.length) throw new Error("au moins un projet requis pour créer une recette");
  if (!title || !String(title).trim()) throw new Error("titre requis pour créer une recette");
  const r = await taskOrchestrator("recette_start", {
    project: projs[0],
    projects: projs,
    title: String(title).trim(),
    description: description ? String(description).trim() : undefined,
    taskIds: (taskIds || []).filter(Boolean),
    status: "pending",
  });
  // Rattache les documents fournis à la création (import ou artefact).
  for (const doc of documents || []) {
    if (!doc) continue;
    try {
      await addRecetteDocument({
        recetteId: r.recette.recetteId,
        mode: doc.mode === "artifact" ? "artifact" : "import",
        filename: doc.filename,
        dataBase64: doc.dataBase64,
        artifactId: doc.artifactId,
        nature: doc.nature,
        title: doc.title,
      });
    } catch {}
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

  // REPRISE : dès qu'une session est rattachée à la recette, on la REPREND —
  // on n'en relance JAMAIS automatiquement une nouvelle. L'ancienne détection
  // par `opencode session list` (répertoire) dépendait du cwd du serveur au
  // moment du lancement : en cas de faux négatif, chaque clic créait une
  // nouvelle session (doublons). Pour repartir de zéro : `force = true`.
  if (!force && rec.sessionId && /^ses_/.test(rec.sessionId)) {
    return { recetteId, sessionId: rec.sessionId, resumed: true };
  }

  // Multi-projets : pas de « projet principal » métier. Pour le lancement de la
  // session (simple ancrage), on prend le 1er projet rattaché qui a un gitPath.
  const projs = (rec.projects && rec.projects.length ? rec.projects : (rec.project ? [rec.project] : []));
  let dir = null;
  for (const p of projs) {
    const g = await projectGitPath(p);
    if (g) { dir = g; break; }
  }
  const prompt = buildRecettePrompt({ project: projs[0] || rec.project, projects: projs, title: rec.title, taskIds: rec.tasks || [] });
  const { sessionId } = await launchSession({ dir, agent: "agent-recette", prompt, title: `Recette ${rec.title || projs.join(", ")}` });
  if (!sessionId || !/^ses_/.test(sessionId)) {
    throw new Error("échec de lancement de la session de recette (agent-recette indisponible ?)");
  }
  await taskOrchestrator("recette_session_set", { recetteId, sessionId });
  return { recetteId, sessionId, resumed: false };
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

// Ajoute un projet à une recette existante (recette multi-projets).
export async function addRecetteProject({ recetteId, project, by }) {
  if (!recetteId || !project) throw new Error("recetteId et projet requis");
  const r = await taskOrchestrator("recette_project_add", { recetteId, project });
  return { ok: true, recette: r && r.recette };
}

// Retire un projet d'une recette existante (refus si dernier projet / tâches couvertes).
export async function removeRecetteProject({ recetteId, project, by }) {
  if (!recetteId || !project) throw new Error("recetteId et projet requis");
  const r = await taskOrchestrator("recette_project_remove", { recetteId, project });
  return { ok: true, recette: r && r.recette };
}

// Rattache une tâche couverte à une recette (garde projet vérifiée côté MCP).
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

// Clôt la recette : crée une tâche par élément confirmé (via task_register) puis confirme.
export async function finishRecette({ recetteId, items, by }) {
  if (!recetteId) throw new Error("recetteId requis");
  const r = await taskOrchestrator("recette_get", { recetteId });
  const rec = r && r.recette;
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  if (rec.status !== "in_progress") throw new Error(`recette non en cours (statut ${rec.status})`);

  const created = [];
  const CLASS_LABEL = { rework: "Rework", bug: "Bug", improvement: "Improvement", feature: "Feature" };
  // Projets de la recette (aucun « projet principal ») : un item = un projet cible.
  const recProjs = (rec.projects && rec.projects.length ? rec.projects : (rec.project ? [rec.project] : []));
  const projByItem = {};
  for (const i of rec.items || []) if (i.itemId) projByItem[i.itemId] = i.project;
  for (const it of items || []) {
    if (!it || !it.content) continue;
    const cls = ["rework", "bug", "improvement", "feature"].includes(it.classification) ? it.classification : "rework";
    const type = cls === "bug" ? "debug" : "feature";
    const itemProject = (it.project && recProjs.includes(it.project)) ? it.project
      : (projByItem[Number(it.itemId)] && recProjs.includes(projByItem[Number(it.itemId)])) ? projByItem[Number(it.itemId)]
      : (recProjs[0] || rec.project);
    const request = `[${CLASS_LABEL[cls]} — issu de la recette ${recetteId}] ${it.content}`;
    const reg = await taskOrchestrator("task_register", {
      request,
      title: it.title || `[${CLASS_LABEL[cls]}] ${it.content.slice(0, 60)}`,
      project: itemProject,
      type,
      priority: "normal",
      scope: Array.isArray(it.scope) && it.scope.length ? it.scope : undefined,
      acceptanceCriteria: it.acceptance ? [it.acceptance] : undefined,
      linkedTasks: (rec.tasks || []).map((t) => ({ taskId: t, description: `Couvert par la recette ${recetteId} — ${CLASS_LABEL[cls]}` })),
      recetteClass: cls,
      recetteId,
    });
    const newTaskId = reg && (reg.taskId || (reg.task && reg.task.id));
    if (newTaskId) {
      created.push({ taskId: newTaskId, classification: cls, content: it.content });
      try { await taskOrchestrator("recette_item_update", { itemId: Number(it.itemId), status: "task_created", createdTaskId: newTaskId }); } catch {}
    }
  }

  const confirmed = await taskOrchestrator("recette_confirm", { recetteId, confirmedBy: by || "human" });
  return { ok: true, recetteId, created, recette: confirmed.recette };
}
