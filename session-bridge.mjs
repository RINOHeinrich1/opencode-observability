// session-bridge.mjs — Bridge de pilotage des sessions opencode depuis le panneau.
//
// Composant d'INFRASTRUCTURE (norme v1.0 §7) : lancer une session d'orchestration
// est une opération d'infrastructure, pas un développement sur le code d'un projet.
//
// Capacités :
//  - launchSession({ dir, agent, prompt, title }) : lance une session opencode
//    DÉTACHÉE de l'agent `orchestrator` avec un prompt initial (mission + cadre,
//    jamais la méthode). Résout la Promise avec le `sessionId` capturé.
//  - injectMessage({ sessionId, prompt }) : injecte un message dans une session
//    existante (choix 1 de reprise après rejet). Vérifie l'existence de la session.
//  - sessionExists(sessionId) : vrai si la session existe (`opencode session list`).
//  - listSessions() : liste les sessions (JSON).
//  - buildLaunchPrompt(...) / buildReworkPrompt(...) : constructeurs de prompt
//    mission + cadre — AUCUNE consigne de méthode (interdiction « mission ≠ méthode »).
//
// DÉCISION n°5 : le choix 2 (compaction + réinjection de l'ancienne session) est
// SUPPRIMÉ. Aucune fonction de compaction n'est fournie ici, volontairement.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OPENCODE_BIN = "/root/.opencode/bin/opencode";
// Serveur opencode auquel attacher les sessions (pour qu'elles soient streamées
// dans le web et que les permissions y soient résolues). Surchargeable via env.
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const AGENT_DIR = process.env.OPENCODE_AGENT_DIR || join(homedir(), ".config", "opencode", "agent");

function assertBinary() {
  if (!existsSync(OPENCODE_BIN)) {
    throw new Error(`binaire opencode introuvable : ${OPENCODE_BIN}`);
  }
}

// Lit le modèle déclaré par un agent (`model:` de son frontmatter), ou null.
// Permet de forcer `--model` au lancement : opencode met en cache la définition
// des agents au démarrage du serveur, donc une édition de `model:` ne serait pas
// prise en compte sans redémarrage si on s'en remettait au seul `--agent`.
function readAgentModel(agent) {
  if (!agent) return null;
  const file = join(AGENT_DIR, `${agent}.md`);
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) return null;
    const line = /^[ \t]*model:[ \t]*([^\r\n]+)$/m.exec(m[1]);
    return line ? line[1].trim() : null;
  } catch {
    return null;
  }
}

// --- Primitives bas-niveau ------------------------------------------------

// Liste les sessions (tableau trié, plus récente en premier). `dir` restreint au
// projet du répertoire donné (les sessions --dir sont rattachées à ce projet).
export function listSessions(dir) {
  assertBinary();
  const opts = {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
  };
  if (dir) opts.cwd = dir;
  const out = execFileSync(OPENCODE_BIN, ["session", "list", "--format", "json"], opts);
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function sessionExists(sessionId, dir) {
  if (!sessionId) return false;
  return listSessions(dir).some((s) => s.id === sessionId);
}

// Résout le sessionId le plus récent (fallback en cas d'échec de capture du flux).
function latestSessionId(title, dir) {
  const sessions = listSessions(dir);
  if (title) {
    const byTitle = sessions.find((s) => s.title === title);
    if (byTitle) return byTitle.id;
  }
  return sessions[0]?.id || null;
}

// --- Lancement ------------------------------------------------------------

/**
 * Lance une session opencode détachée et résout la Promise avec son sessionId.
 * La session survit à un redémarrage du panneau (detached + unref) ; son cycle de
 * vie reste piloté par l'orchestrateur (décision validée « orchestrateur pilote »).
 *
 * NOTE : on ne passe JAMAIS `--auto` (auto-approve des permissions) : les
 * permissions restent soumises à l'humain.
 */
export function launchSession({ dir, agent = "orchestrator", prompt, title }) {
  return new Promise((resolve, reject) => {
    assertBinary();
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      reject(new Error("prompt requis pour lancer une session"));
      return;
    }

    const args = ["run", prompt, "--agent", agent, "--format", "json", "--attach", OPENCODE_SERVER_URL];
    const model = readAgentModel(agent);
    if (model) args.push("--model", model);
    if (dir) args.push("--dir", dir);
    if (title) args.push("--title", title);

    const child = spawn(OPENCODE_BIN, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let sessionId = null;
    let settled = false;
    let buffer = "";

    const finish = (sid) => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ pid: child.pid, sessionId: sid });
    };

    const timeout = setTimeout(() => {
      finish(sessionId || latestSessionId(title, dir));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (!sessionId && evt.sessionID) {
            sessionId = evt.sessionID;
            clearTimeout(timeout);
            finish(sessionId);
          }
        } catch {
          /* ligne non JSON (log) : ignorée */
        }
      }
    });

    child.stderr.on("data", () => {});
    child.on("error", (e) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

// --- Injection (choix 1 de reprise) ---------------------------------------

/**
 * Injecte un message (remarques) dans une session existante, en la continuant.
 * Retourne immédiatement { pid, sessionId } (process détaché).
 */
export function injectMessage({ sessionId, prompt, dir }) {
  assertBinary();
  if (!sessionId) throw new Error("sessionId requis pour injecter un message");
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt requis pour injecter un message");
  }
  if (!sessionExists(sessionId, dir)) {
    throw new Error(`session inconnue ou expirée : ${sessionId}`);
  }

  const args = ["run", prompt, "--continue", "--session", sessionId, "--agent", "orchestrator", "--format", "json", "--attach", OPENCODE_SERVER_URL];

  const child = spawn(OPENCODE_BIN, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.on("error", () => {});
  child.unref();

  return { pid: child.pid, sessionId };
}

// --- Arrêt d'une session (kill du process + suppression) --------------------

/**
 * Arrête la session opencode d'une tâche : tue les processus `opencode run`
 * associés (headless) MAIS CONSERVE l'enregistrement de session (lien et
 * consommation restent consultables). Utilisé par le bouton « Tuer la session »
 * du panneau et par l'approbation de recette (v0.6.3 : plus aucune suppression).
 * La suppression d'une session (`opencode session delete`) n'est JAMAIS faite ici.
 */
export function killSession({ taskId, sessionId }) {
  const result = { killedPids: [], sessionDeleted: false };

  // 1. Trouver et tuer les processus `opencode run` dont la ligne de commande
  //    contient le taskId (ex. --title "Tâche <taskId>").
  let pids = [];
  try {
    const out = execFileSync(
      "bash",
      ["-c", `ps -eo pid=,cmd= | grep '[o]pencode run' | grep '${taskId}' | awk '{print $1}'`],
      { encoding: "utf8" },
    );
    pids = out.trim().split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
  } catch {
    pids = [];
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      result.killedPids.push(pid);
    } catch {}
  }
  if (pids.length) {
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }, 2500);
  }

  // NOTE (v0.6.3) : la session opencode n'est PAS supprimée — l'enregistrement
  // persiste sur disque (lien consultable + `opencode export` pour la consommation).
  result.sessionDeleted = false;
  return result;
}

// --- Constructeurs de prompt (mission + cadre, jamais méthode) -------------

/**
 * Prompt de lancement d'une session orchestrateur : mission + cadre.
 * Aucune consigne de méthode d'exécution (règle « mission ≠ méthode »).
 */
export function buildLaunchPrompt({ taskId, executionId, project, workspace, scope, request, title, acceptanceCriteria, auditTarget, directExecution, repos }) {
  const lines = ["Traite la tâche orchestrée suivante.", ""];
  if (taskId) lines.push(`- taskId : ${taskId}`);
  if (executionId) lines.push(`- executionId : ${executionId}`);
  if (project) lines.push(`- projet : ${project}`);
  if (workspace) lines.push(`- workspace Coder : ${workspace}`);
  if (auditTarget) lines.push(`- cible d'audit : ${auditTarget} (backend | frontend | both)`);
  if (directExecution) lines.push("- mode : EXÉCUTION DIRECTE (pas de planification atomic-plan) — délègue directement à build-notify (la demande est le travail).");
  if (scope && scope.length) lines.push(`- scope : ${scope.join(", ")}`);
  if (repos && repos.length) {
    lines.push("", "Repos concernés par la tâche (ADR 09 — travaille sur chacun des repos ciblés) :");
    for (const r of repos) {
      lines.push(`  - repo ${r.id || r.repoId}${r.name ? ` (${r.name})` : ""} · workspace ${r.workspace || "?"} · répertoire ${r.repoDir || "?"} · branche ${r.mainBranch || r.branch || "?"}`);
      if (r.deploy) lines.push(`    MÉCANISME DE DÉPLOIEMENT de ce repo : ${String(r.deploy).split("\n").map((l) => l.trim()).join(" ")}`);
    }
    lines.push("Pour chaque repo ciblé, réserve un worktree dans SON workspace Coder (en non-root via workspace_exec), isole et trace. Le scope/les patches peuvent couvrir plusieurs repos.");
    lines.push("Le DÉPLOIEMENT se fait repo par repo via SON mécanisme CI/CD (champ deploy ci-dessus) : pousse sur la branche de travail puis laisse le CI déployer — jamais de déploiement manuel.");
  }
  lines.push("", "Titre :", title || "(—)");
  lines.push("", "Demande :", request || "");
  if (acceptanceCriteria && acceptanceCriteria.length) lines.push("", "Critère d'acceptation / livrable attendu :", acceptanceCriteria.join("\n"));
  lines.push("", "La tâche est déjà enregistrée (statut `started`) : récupère son état via `task_get`, ne la ré-enregistre pas (pas de `task_register`).");
  lines.push("Respecte la norme de référence (docs/norme-environnement-travail.md) et le cadre d'orchestration.");
  return lines.join("\n");
}

/**
 * Prompt de reprise après rejet humain (choix 1 ou 3) : remarques + cadre.
 */
export function buildReworkPrompt({ taskId, remarks, by }) {
  const lines = [`Reprise de la tâche ${taskId || ""} après rejet humain.`.trim(), ""];
  lines.push("Remarques de l'humain :");
  lines.push(remarks || "(aucune remarque)");
  if (by) lines.push(`Auteur du rejet : ${by}`);
  lines.push("", "Cadre : reprends l'exécution en tenant compte de ces remarques, dans le respect du cadre de travail (isolation Coder, traçabilité Git, CI/CD).");
  return lines.join("\n");
}

/**
 * Prompt d'ouverture d'une session de RECETTE (agent-recette) — v0.8.0.
 * La recette est un objet de PROJET (titre + 0..N tâches couvertes).
 * Mission + cadre, jamais méthode.
 */
export function buildRecettePrompt({ project, projects, title, taskIds }) {
  const projs = (projects && projects.length ? projects : (project ? [project] : []));
  const first = projs[0] || project || "";
  return [
    `Ouvre la recette **« ${title || first} »** (projets : ${projs.join(", ")}) (v0.9.0).`,
    "",
    taskIds && taskIds.length ? `Tâches couvertes par cette recette : ${taskIds.join(", ")}.` : "Cette recette ne couvre aucune tâche (parcours global / exploratoire).",
    "Une recette peut couvrir **un ou plusieurs projets** (pas de projet principal). Chaque élément relevé est rattaché à **UN projet cible** (celui où la future tâche sera créée) — renseigne `project` dans `recette_item_add`, obligatoirement parmi les projets de la recette.",
    "Les tâches couvertes restent HISTORIQUEMENT INTACTES : tu ne les modifies jamais (aucune transition, aucun rework direct).",
    "Mission :",
    "- Récupère le contexte : `recette_get(<recetteId>)` (titre, projets, tâches couvertes, éléments), et pour chaque tâche couverte `task_get` (plans, commits, artefacts, tâches liées), `artifact_list`, `events_list`.",
    "- Accompagne l'utilisateur dans la vérification du périmètre : réponds à ses questions, aide-le à comprendre ce qui a été réalisé.",
    "- Enregistre chaque élément détecté via `recette_item_add` avec **classification** (`rework`/`bug`/`improvement`/`feature`), **project** (projet cible de l'élément), **scope** (chemins), **titre court** et **critère d'acceptation** (ce qui permettra de considérer la tâche créée comme terminée).",
    "- Regroupe les remarques liées ; **ne crée AUCUNE tâche pendant la discussion** (les tâches seront créées à la confirmation finale, via le panneau).",
    "- Prépare la synthèse consolidée des éléments (type + action + projet) pour la présenter à l'utilisateur.",
    "",
    "Cadre : session dédiée à la recette ; l'utilisateur déclenchera « Terminer la recette » puis confirmera la liste.",
  ].join("\n");
}

// Prompt de mission pour la session de CRÉATION / MISE À JOUR d'un test E2E
// (agent `test-agent`). Le test est une entité de 1er niveau : la session est
// rattachée au test (e2e_tests.session_id). mission ≠ méthode : le prompt porte
// la mission et le cadre, jamais la méthode d'écriture du spec.
export function buildTestPrompt({ e2eTestId, project, projects, title, description, mode = "create", specFile, scenario }) {
  const projs = (projects && projects.length ? projects : (project ? [project] : []));
  const first = projs[0] || project || "";
  const header =
    mode === "create"
      ? `Ouvre la session de CRÉATION du test E2E **« ${title || first} »** (projet repo source : ${projs.join(", ")}) (cadrage 08). Le test n'existe pas encore — tu vas le créer de bout en bout.`
      : `Ouvre la session de MISE À JOUR du test E2E **« ${title || e2eTestId} »** (projet repo source : ${projs.join(", ")}) (cadrage 08).`;
  return [
    header,
    "",
    `Test (entité 1er niveau) : ${e2eTestId ? `\`${e2eTestId}\`` : "(non encore enregistré)"}.`,
    description ? `Comportement à couvrir : ${description}.` : "Comportement à couvrir : à préciser avec l'utilisateur.",
    specFile ? `Emplacement du spec : \`${specFile}\`.` : "Emplacement du spec : à déterminer (tests/playwright/ ou testDir de la config du dépôt).",
    scenario ? `Scénario cible : ${scenario}.` : "",
    "",
    "Mission :",
    "- Récupère le contexte : `e2e_list` (référentiel, éviter les doublons), `e2e_test_get(<e2eTestId>)` si le test existe déjà (DRAFT), et le contexte du dépôt (config Playwright, socle E2E existant, helpers).",
    "- Où écrire : dans le WORKSPACE CODER du projet repo source, sur une **branche de travail** dédiée (jamais l'hôte, jamais la branche principale).",
    "- Crée ou mets à jour le spec Playwright (test() = un scénario ; comportement transverse = une seule entité), enregistre l'entité via `e2e_test_register` (project = repo source, coveredProjects = projets couverts), déclare les paramètres via `e2e_test_param_set` (défauts NON sensibles, secretRef pour les tokens), rattache la session via `e2e_test_session_set`.",
    "- Vérifie si possible par un run ciblé (`e2e_run`, origine `session`) : lis le **rapport texte** uniquement, corrige si besoin.",
    "- Règle IA : tu ne traites que le **texte** ; la vidéo est une preuve humaine (jamais interprétée).",
    "",
    "Cadre : session dédiée au test ; à la fin, résume ce qui a été fait (branche, fichier(s), test enregistré ACTIVE, paramètres) et les prochaines étapes (merge de la branche, run de vérification).",
  ].join("\n");
}

export { OPENCODE_BIN };
