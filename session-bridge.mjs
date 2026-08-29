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
import { existsSync } from "node:fs";

const OPENCODE_BIN = "/root/.opencode/bin/opencode";
// Serveur opencode auquel attacher les sessions (pour qu'elles soient streamées
// dans le web et que les permissions y soient résolues). Surchargeable via env.
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";

function assertBinary() {
  if (!existsSync(OPENCODE_BIN)) {
    throw new Error(`binaire opencode introuvable : ${OPENCODE_BIN}`);
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
 * associés (headless) puis supprime l'enregistrement de session. Utilisé par le
 * bouton « Tuer la session » du panneau.
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

  // 2. Supprimer l'enregistrement de session.
  if (sessionId) {
    try {
      execFileSync(OPENCODE_BIN, ["session", "delete", sessionId], { stdio: "ignore" });
      result.sessionDeleted = true;
    } catch {}
  }

  return result;
}

// --- Constructeurs de prompt (mission + cadre, jamais méthode) -------------

/**
 * Prompt de lancement d'une session orchestrateur : mission + cadre.
 * Aucune consigne de méthode d'exécution (règle « mission ≠ méthode »).
 */
export function buildLaunchPrompt({ taskId, executionId, project, workspace, scope, request }) {
  const lines = ["Traite la tâche orchestrée suivante.", ""];
  if (taskId) lines.push(`- taskId : ${taskId}`);
  if (executionId) lines.push(`- executionId : ${executionId}`);
  if (project) lines.push(`- projet : ${project}`);
  if (workspace) lines.push(`- workspace Coder : ${workspace}`);
  if (scope && scope.length) lines.push(`- scope : ${scope.join(", ")}`);
  lines.push("", "Demande :", request || "");
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

export { OPENCODE_BIN };
