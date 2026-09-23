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
const AGENT_DIR = process.env.OPENCODE_AGENT_DIR || join(homedir(), ".config", "opencode", "agent");
// Lus À L'EXÉCUTION (pas au chargement) : le .env du panneau est chargé après les
// imports ES → une lecture top-level verrait une valeur obsolète.
function ocServerUrl() { return process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096"; }
function ocEnv() { const d = process.env.OPENCODE_DATA_HOME; return d ? { ...process.env, XDG_DATA_HOME: d } : process.env; }

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

// --- Cohérence « clé active fournisseur ↔ modèle déclaré » (ADR-005) --------
//
// Point d'étranglement UNIQUE de tout lancement de session : le modèle déclaré
// par l'agent (frontmatter `model:`) DOIT être servi par une clé fournisseur
// ACTIVE. Sinon, le `--model` forcé fait échouer opencode — historiquement de
// façon SILENCIEUSE (timeout 20 s + session fantôme rattachée). Politique A
// (défaut) : échec explicite et lisible. Politique B (fallback compatible) :
// uniquement en opt-in EXPLICITE et tracé.

// auth.json de référence (dérivé de `provider_keys` par provider-auth.mjs :
// une clé par fournisseur actif). `OPENCODE_SHARED_AUTH` prioritaire.
const AUTH_JSON_PATH = process.env.OPENCODE_SHARED_AUTH || "/root/.local/share/opencode/auth.json";

// Fournisseurs à clé ACTIVE = clés de `auth.json`. `∅` si le fichier est
// illisible/absent (⇒ repli sur le seul catalogue, cf. checkModelServable).
export function getActiveProviderIds() {
  try {
    const obj = JSON.parse(readFileSync(AUTH_JSON_PATH, "utf8"));
    return new Set(Object.keys(obj || {}).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Fournisseurs PAR DÉFAUT, SANS clé API : ils servent leurs modèles sans qu'une
// clé soit requise dans `auth.json` (convention produit `kind: 'default'` ⇒
// AUCUNE clé requise, modèles toujours servis — cf. élément de recette 24 et sa
// maquette). `opencode` sert les modèles `opencode/<nom>` (ex. opencode/big-pickle).
//
// Source UNIQUE de la notion : ne PAS dupliquer la valeur ailleurs. L'exception
// est portée par ce prédicat DÉDIÉ, JAMAIS par `getActiveProviderIds()` (qui
// reste la liste des clés RÉELLES — un fournisseur par défaut n'y figure pas,
// sinon `activeProviders` et les messages d'erreur mentiraient en l'affichant
// comme « clé active »).
export const DEFAULT_PROVIDER_IDS = new Set(["opencode"]);

// Prédicat PUR : le fournisseur bénéficie-t-il de l'exception « par défaut sans
// clé » ? Consommé par `checkModelServable` (contrôle de clé) et
// `resolveAgentModel` (pool de repli politique B) — même sémantique partagée.
export function isDefaultProvider(provider) {
  return !!provider && DEFAULT_PROVIDER_IDS.has(provider);
}

// Cache court du catalogue `opencode models` (5 min) : l'appel CLI est coûteux
// et le catalogue ne bouge pas à cette échelle de temps.
let _modelsCache = { at: 0, models: [] };
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

// Catalogue des modèles SERVIS (`provider/model`) tel que listé par le CLI
// opencode. `[]` si le CLI est indisponible — l'appelant ne doit alors PAS
// bloquer sur le catalogue (cf. checkModelServable).
export function listServedModels({ force = false } = {}) {
  const now = Date.now();
  if (!force && _modelsCache.at && now - _modelsCache.at < MODELS_CACHE_TTL_MS) {
    return _modelsCache.models;
  }
  let models = [];
  try {
    assertBinary();
    const out = execFileSync(OPENCODE_BIN, ["models"], {
      env: ocEnv(),
      timeout: 15000,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    models = String(out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.includes("/"));
  } catch {
    models = [];
  }
  _modelsCache = { at: now, models };
  return models;
}

// Erreur STRUCTURÉE « modèle non servi par la clé active » (politique A). Porte
// tout le nécessaire à une raison lisible (UI + logs) et au HTTP 400 dédié.
export class ModelNotServedError extends Error {
  constructor({ model, provider, activeProviders, catalog, reason }) {
    const act = [...(activeProviders || [])];
    const cat = catalog || [];
    const detail =
      reason || `le modèle « ${model} » n'est pas servi par la clé active du fournisseur « ${provider} »`;
    super(
      `${detail} (fournisseurs à clé active : ${act.length ? act.join(", ") : "aucun"} ; catalogue servi : ${cat.length} modèle(s))`,
    );
    this.name = "ModelNotServedError";
    this.code = "MODEL_NOT_SERVED";
    this.model = model || null;
    this.provider = provider || null;
    this.activeProviders = act;
    this.catalog = cat;
    this.reason = detail;
  }
}

// Fonction PURE : décide si `model` est servable au regard des fournisseurs à
// clé active et du catalogue servi. Distingue les causes (fournisseur sans clé
// active vs modèle absent du catalogue). Quand le catalogue est VIDE (CLI
// injoignable), on ne se fie QU'AU fournisseur — jamais de faux blocage.
export function checkModelServable({ model, activeProviders, catalog }) {
  const act = activeProviders instanceof Set ? activeProviders : new Set(activeProviders || []);
  const cat = Array.isArray(catalog) ? catalog : [];
  const m = String(model || "").trim();
  if (!m) return { servable: false, provider: null, reason: "aucun modèle déclaré" };
  const slash = m.indexOf("/");
  const provider = slash > 0 ? m.slice(0, slash) : null;

  if (!cat.length) {
    // Catalogue indisponible : repli NON bloquant sur la présence d'une clé active.
    if (!provider) {
      return { servable: true, provider: null, reason: "catalogue indisponible — modèle sans fournisseur : non vérifiable" };
    }
    if (isDefaultProvider(provider)) {
      // Fournisseur par défaut sans clé : servable par construction.
      return { servable: true, provider, reason: `catalogue indisponible — fournisseur par défaut « ${provider} » (aucune clé requise)` };
    }
    return act.has(provider)
      ? { servable: true, provider, reason: `catalogue indisponible — clé active présente pour « ${provider} »` }
      : { servable: false, provider, reason: `aucune clé active pour le fournisseur « ${provider} »` };
  }

  if (!provider) {
    return cat.includes(m)
      ? { servable: true, provider: null, reason: "modèle servi (sans fournisseur identifié)" }
      : { servable: false, provider: null, reason: `modèle « ${m} » absent du catalogue servi` };
  }
  // Le fournisseur par défaut n'a PAS de clé par construction : ne pas exiger
  // `act.has(provider)`. Le contrôle de CATALOGUE reste appliqué juste après
  // (un `opencode/<modèle inexistant>` demeure refusé — pas de sur-correction).
  if (!act.has(provider) && !isDefaultProvider(provider)) {
    return { servable: false, provider, reason: `aucune clé active pour le fournisseur « ${provider} »` };
  }
  if (!cat.includes(m)) {
    return {
      servable: false,
      provider,
      reason: `le modèle « ${m} » n'est pas servi par le fournisseur « ${provider} » (clé active)`,
    };
  }
  if (!act.has(provider)) {
    // Fournisseur par défaut sans clé, modèle présent au catalogue ⇒ servi.
    return { servable: true, provider, reason: `modèle « ${m} » servi par le fournisseur par défaut « ${provider} » (aucune clé requise)` };
  }
  return { servable: true, provider, reason: `modèle « ${m} » servi par « ${provider} » (clé active)` };
}

// Résout le modèle d'un agent AVANT tout spawn (politique A par défaut).
// Politique B (fallback compatible) UNIQUEMENT si `allowFallback` est vrai :
// même fournisseur d'abord, sinon 1er modèle du catalogue ∩ providers actifs.
// Retour : { model, fallback, reason } — ou `ModelNotServedError` levée.
export function resolveAgentModel(agent, { activeProviders, catalog, allowFallback = false, fallbackModel = null } = {}) {
  const model = readAgentModel(agent);
  if (!model) return { model: null, fallback: false, reason: "aucun modèle déclaré par l'agent" };

  const act = activeProviders instanceof Set ? activeProviders : getActiveProviderIds();
  const cat = Array.isArray(catalog) ? catalog : listServedModels();
  const check = checkModelServable({ model, activeProviders: act, catalog: cat });
  if (check.servable) return { model, fallback: false, reason: check.reason };

  if (!allowFallback) {
    // Politique A : échec explicite (jamais de `--model` non servi).
    throw new ModelNotServedError({ model, provider: check.provider, activeProviders: act, catalog: cat, reason: check.reason });
  }

  // Politique B — opt-in explicite et tracé : choisir un modèle COMPATIBLE.
  // Un modèle est candidat s'il est servi par un fournisseur à clé ACTIVE **ou**
  // par un fournisseur par défaut sans clé (même prédicat que `checkModelServable`,
  // sinon un repli vers `opencode/*` serait refusé par le contrôle de clé alors
  // que le pool l'aurait exclu — asymétrie corrigée).
  const isActiveOrDefault = (p) => act.has(p) || isDefaultProvider(p);
  let chosen = null;
  if (fallbackModel && checkModelServable({ model: fallbackModel, activeProviders: act, catalog: cat }).servable) {
    chosen = fallbackModel;
  } else if (check.provider) {
    chosen = cat.find((x) => x.startsWith(check.provider + "/") && isActiveOrDefault(x.slice(0, x.indexOf("/")))) || null;
  }
  if (!chosen) chosen = cat.find((x) => isActiveOrDefault(x.slice(0, x.indexOf("/")))) || null;
  if (!chosen) {
    throw new ModelNotServedError({
      model,
      provider: check.provider,
      activeProviders: act,
      catalog: cat,
      reason: `${check.reason} — aucun modèle de repli compatible (politique B)`,
    });
  }
  return { model: chosen, fallback: true, reason: `${check.reason} → repli sur « ${chosen} » (politique B, opt-in explicite)` };
}

// Extrait borné de `stderr` pour un message d'erreur exploitable (diagnostic).
function stderrTail(stderr, max = 2000) {
  const t = String(stderr || "").trim();
  if (!t) return " (aucune sortie d'erreur opencode)";
  return ` — sortie d'erreur opencode : ${t.length > max ? t.slice(t.length - max) : t}`;
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
    env: ocEnv(),
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

/**
 * Existence d'une session VÉRIFIÉE PAR IDENTIFIANT auprès du serveur opencode
 * attaché (`GET /session/:id`, basic auth). Indispensable : `opencode session
 * list` est SCOPÉ par répertoire/projet et ne voit donc PAS une session créée
 * dans un autre projet opencode (ex. `global`, directory `/`) — d'où des reprises
 * qui échouaient et recréaient une session à chaque clic.
 *
 * Retour : `true` (200 — la session existe), `false` (404/410 — disparue),
 * `null` (indéterminé : serveur injoignable / auth) → l'appelant peut alors
 * retomber sur `sessionExists`.
 */
export async function sessionExistsById(sessionId) {
  if (!sessionId || !/^ses_/.test(sessionId)) return false;
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const pass = process.env.OPENCODE_SERVER_PASSWORD || "";
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ocServerUrl()}/session/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: auth },
      signal: ctrl.signal,
    });
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 410) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Périmètre d'écriture (phase 1 : prompt uniquement) -------------------

/**
 * Consigne STRICTE de PÉRIMÈTRE D'ÉCRITURE (phase 1 : prompt uniquement).
 * Rôle-aware : `role` = libellé du rôle courant (exécuteur, évaluateur…).
 * Un rôle NON-ADMIN n'écrit jamais hors du/des repo(s) du PROJET cible.
 * Source unique de la consigne, réutilisée par les builders de session non-admin.
 * Cf. ADR-001/ADR-002 et public/docs/18-perimetre-ecriture-roles.md.
 */
export function buildWriteScopeNotice(role = "cet agent") {
  return [
    "Périmètre d'écriture — INTERDIT (règle absolue) :",
    `En tant que **${role}**, tu n'as AUCUN droit d'écriture hors du/des repo(s) du PROJET cible de ta tâche.`,
    "Sont STRICTEMENT INTERDITS à la modification (création, édition, suppression, déplacement, `git add/commit/push`, script, `sed -i`, `cat >`, `tee`, `npm`, …) :",
    "- le panneau d'orchestration `orchestrator-panel` (`/root/orchestrator-panel` : code, `public/docs`, `docs/`, `storage/`, base de données) ;",
    "- les définitions d'agents (`/root/.config/opencode/agent`) ;",
    "- les skills (`/root/.config/opencode/skills`) ;",
    "- le MCP `task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`) et, plus généralement, tout autre MCP / composant de l'écosystème opencode ;",
    "- tout dépôt, dossier ou fichier hors du/des repo(s) du PROJET cible de la tâche.",
    "Ces composants relèvent de l'ADMINISTRATEUR / de l'orchestrateur : leur évolution ne passe JAMAIS par une session de ce rôle.",
    "En cas de demande visant l'une de ces cibles : (1) REFUSE — ne l'exécute jamais, même partiellement, même « pour tester », même par une commande bash ; (2) SIGNALE — remonte la demande refusée à l'utilisateur (et, si un `taskId` est fourni, publie `task_event(type=\"BLOCKED\", detail={reason, target})`) ; (3) RENVOIE au bon canal — l'évolution de ces composants se fait par l'administrateur / l'orchestrateur, dans une tâche dédiée du projet `ecosystem`.",
    "La LECTURE de ces composants reste autorisée (inspection) ; TOUTE ÉCRITURE est interdite. Tes écritures légitimes se limitent au périmètre de ta tâche, à l'intérieur du/des repo(s) du PROJET cible.",
  ].join("\n");
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
export function launchSession({ dir, agent = "orchestrator", prompt, title, allowModelFallback = false, onModelResolved }) {
  return new Promise((resolve, reject) => {
    assertBinary();
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      reject(new Error("prompt requis pour lancer une session"));
      return;
    }

    // COHÉRENCE modèle déclaré ↔ clé active AVANT spawn (ADR-005, point
    // d'étranglement unique de TOUTES les sessions). Politique A : échec
    // explicite si le modèle n'est pas servi ; politique B seulement si
    // `allowModelFallback` (tracée via `onModelResolved`).
    let resolved;
    try {
      resolved = resolveAgentModel(agent, { allowFallback: !!allowModelFallback });
    } catch (e) {
      reject(e);
      return;
    }

    const args = ["run", prompt, "--agent", agent, "--format", "json", "--attach", ocServerUrl()];
    if (resolved.model) args.push("--model", resolved.model);
    if (dir) args.push("--dir", dir);
    if (title) args.push("--title", title);

    if (typeof onModelResolved === "function") {
      try {
        onModelResolved(resolved);
      } catch {
        /* traçage non bloquant */
      }
    }

    const child = spawn(OPENCODE_BIN, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ocEnv(),
    });

    let sessionId = null;
    let settled = false;
    let buffer = "";
    let stderr = "";

    const finish = (sid) => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ pid: child.pid, sessionId: sid });
    };

    // TIMEOUT : on ne résout PLUS jamais une session « présumée » (plus de
    // `latestSessionId` fantôme). Sans `sessionId` capturé, c'est un ÉCHEC
    // explicite portant la sortie d'erreur opencode.
    const timeout = setTimeout(() => {
      if (settled) return;
      if (!sessionId) {
        settled = true;
        reject(new Error(`délai dépassé (20 s) sans session capturée pour l'agent « ${agent} »${stderrTail(stderr)}`));
        return;
      }
      finish(sessionId);
    }, 20000);

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

    // Capture de `stderr` (borné 4 Ko) : la VRAIE cause du crash opencode
    // n'est plus jetée — elle est jointe aux erreurs de timeout/exit.
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= 4096) return;
      stderr += chunk.toString().slice(0, 4096 - stderr.length);
    });

    // EXIT AVANT capture d'un `sessionId` avec code non nul : échec IMMÉDIAT
    // et CAUSAL (plus d'attente aveugle de 20 s). Code 0 sans session : on
    // laisse le timeout trancher (pas de session à résoudre).
    child.on("exit", (code, signal) => {
      if (settled || sessionId) return;
      if (code === 0) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `opencode a quitté (code ${code == null ? signal : code}) avant la capture de la session pour l'agent « ${agent} »${stderrTail(stderr)}`,
        ),
      );
    });

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

  const args = ["run", prompt, "--continue", "--session", sessionId, "--agent", "orchestrator", "--format", "json", "--attach", ocServerUrl()];

  const child = spawn(OPENCODE_BIN, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: ocEnv(),
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
 * du panneau et par l'approbation de cadrage (v0.6.3 : plus aucune suppression).
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
 * Prompt d'ouverture d'une session de CADRAGE TECHNIQUE (agent `agent-cadrage`,
 * terminologie « cadrage technique » — ADR-001) — v0.9.1.
 * Le cadrage technique est un objet de PROJET (titre + 0..N tâches couvertes) :
 * il conserve le workflow historique du cadrage technique (contexte + code réel →
 * éléments → liste de tâches techniques). Mission + cadre, jamais méthode.
 * NB : les outils MCP `cadrage_*` gardent leur nom (contrat `pilot.mjs`/
 * `server.mjs`) — seule la terminologie du prompt et l'agent changent.
 */
export function buildCadragePrompt({ project, repos, title, taskIds, docs = [], adrContext = "", featureContext = "", ruleContext = "", recetteItems = [] }) {
  const proj = (project && String(project).trim()) || "";
  const repoBlock = (repos && repos.length)
    ? `  Repos transverses du projet (portée réelle — ADR 11) : ${repos.map((x) => x.repoId || x.id || x).join(", ")}`
    : "";
  // Bloc ADR (item 125) : « ## ADR de référence » construit par `adr_context`
  // (sélection ADR du panneau ou ADR actives du projet). Additif et non cassant.
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  // Blocs « ## Fonctionnalités de référence » / « ## Règles métier de référence »
  // (T-20260922-070103-ncs1) construits par `feature_context`/`rule_context`.
  // FACULTATIFS : aucun bloc si la sélection est vide. Insérés APRÈS le bloc ADR.
  const featureBlock = (featureContext && String(featureContext).trim())
    ? ["", String(featureContext).trim(), ""]
    : [];
  const ruleBlock = (ruleContext && String(ruleContext).trim())
    ? ["", String(ruleContext).trim(), ""]
    : [];
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence des projets couverts (à LIRE avant la vérification) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "Lis chacun de ces fichiers : architecture technique (stack, archi cible, composants, patterns, structure de dossiers), specs fonctionnelles (User stories, règles métier) et scénarios Gherkin. Confronte le constat (comportement réel) à ces références — un écart entre le réalisé et l'architecture/spécification documentée est un élément de cadrage (rework/bug).",
        "",
      ]
    : [];
  // Bloc « Éléments de recette évaluateur repris en contexte » (workflow admin →
  // exécuteur) : éléments marqués « à traiter » par l'admin et REPRIS dans ce
  // cadrage. L'exécuteur produit les tâches techniques À PARTIR de ces éléments
  // (plus de conversion automatique des recettes évaluateur en tâches).
  const evalItemBlock = (recetteItems && recetteItems.length)
    ? [
        "",
        "## Éléments de recette évaluateur repris en contexte",
        "Ces éléments proviennent de recettes de l'ÉVALUATEUR produit, ont été marqués « à traiter » par l'admin et sont REPRIS dans ce cadrage technique. Traite-les comme ENTRÉE du cadrage (ce ne sont PAS des tâches) :",
        ...recetteItems.map((it, i) => {
          const pieces = (it.pieces || it.documents || []).map((p) => p.title || p.path || p.documentId).filter(Boolean);
          const piecesStr = pieces.length ? ` — pièces : ${pieces.join(", ")}` : "";
          return `  ${i + 1}. [${it.category || "élément"}/${it.severity || "?"}] (item ${it.itemId}) ${String(it.content || "").trim()}${piecesStr}`;
        }),
        "Consigne : c'est CE cadrage qui définit les tâches techniques à produire (elles seront créées à la confirmation finale, via le panneau) — jamais une conversion automatique de la recette évaluateur.",
        "",
      ]
    : [];
  return [
    `Ouvre le cadrage technique **« ${title || proj} »** — projet : \`${proj}\`${repoBlock ? `\n${repoBlock}` : ""} (v0.9.0).`,
    "",
    taskIds && taskIds.length ? `Tâches couvertes par ce cadrage technique : ${taskIds.join(", ")}.` : "Ce cadrage technique ne couvre aucune tâche (parcours global / exploratoire).",
    "Un cadrage technique = **un seul projet** (produit). Sa portée réelle est couverte par les **repos transverses du projet** (ex: le projet mada-talk traverse les repos mada-talk et oniria). Chaque élément de cadrage relevé est rattaché au **projet du cadrage** (la future tâche y sera créée) — le `project` de `cadrage_item_add` doit être le projet du cadrage, jamais un repo transverse.",
    "Les tâches couvertes restent HISTORIQUEMENT INTACTES : tu ne les modifies jamais (aucune transition, aucun rework direct).",
    ...adrBlock,
    ...featureBlock,
    ...ruleBlock,
    ...docBlock,
    ...evalItemBlock,
    "Mission :",
    "- Récupère le contexte : `cadrage_get(<cadrageId>)` (titre, projet, repos transverses, tâches couvertes, éléments), et pour chaque tâche couverte `task_get` (plans, commits, artefacts, tâches liées), `artifact_list`, `events_list`.",
    "- Accompagne l'utilisateur dans la vérification du périmètre : réponds à ses questions, aide-le à comprendre ce qui a été réalisé.",
    "- Enregistre chaque élément de cadrage détecté via `cadrage_item_add` avec **classification** (`rework`/`bug`/`improvement`/`feature`), **project** (= projet du cadrage), **scope** (chemins), **titre court** et **critère d'acceptation** (ce qui permettra de considérer la tâche créée comme terminée).",
    "- Regroupe les remarques liées ; **ne crée AUCUNE tâche pendant la discussion** (les tâches seront créées à la confirmation finale, via le panneau).",
    "- Prépare la synthèse consolidée des éléments de cadrage (type + action + projet) pour la présenter à l'utilisateur.",
    "",
    "Cadre : session dédiée au cadrage technique ; l'utilisateur déclenchera « Terminer le cadrage » puis confirmera la liste.",
    "",
    buildWriteScopeNotice("l'EXÉCUTEUR (cadrage technique)"),
  ].join("\n");
}

/**
 * Prompt d'ouverture d'une session d'ÉVALUATION PRODUIT (agent-recette
 * évaluateur, ADR-001/003) — v0.1.1.
 * L'évaluateur décrit le parcours évalué, rattache fonctionnalités (verdict) et
 * règles métier, enregistre des recommandations/problèmes et joint des pièces.
 * Blocs `featureContext`/`ruleContext` injectés (parité `buildCadragePrompt`).
 * Il peut en outre : GÉNÉRER UNE MAQUETTE HTML/CSS/JS (données mock) servie par
 * le panneau comme PAGE STATIQUE (URL rattachable à un élément), LANCER UN TEST
 * DE PERFORMANCE préprod (réseau + Core Web Vitals + stress borné) et LANCER
 * LES TESTS E2E disponibles. La recette évaluateur N'EST JAMAIS convertie en
 * tâches : les éléments « à traiter » sont repris par un cadrage technique.
 */
export function buildRecettePrompt({ recetteId, project, repos, title, description, docs = [], adrContext = "", featureContext = "", ruleContext = "", featureIds = [], ruleIds = [] }) {
  const proj = (project && String(project).trim()) || "";
  const repoBlock = (repos && repos.length)
    ? `  Repos transverses du projet (portée réelle — ADR 11) : ${repos.map((x) => x.repoId || x.id || x).join(", ")}`
    : "";
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  // Blocs « ## Fonctionnalités de référence » / « ## Règles métier de référence »
  // construits par `feature_context`/`rule_context` (mêmes règles d'injection que
  // `buildCadragePrompt`) : bloc VIDE si la sélection est vide, inséré APRÈS le
  // bloc ADR et AVANT les documents de référence.
  const featureBlock = (featureContext && String(featureContext).trim())
    ? ["", String(featureContext).trim(), ""]
    : [];
  const ruleBlock = (ruleContext && String(ruleContext).trim())
    ? ["", String(ruleContext).trim(), ""]
    : [];
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence des projets couverts (à LIRE avant la vérification) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "",
      ]
    : [];
  return [
    `Ouvre la recette d'ÉVALUATION PRODUIT **« ${title || proj} »** — projet : \`${proj}\`${repoBlock ? `\n${repoBlock}` : ""} (v0.1.1).`,
    recetteId ? `Recette : \`${recetteId}\`.` : "",
    "",
    description ? `Parcours évalué : ${description}` : "Parcours évalué : à préciser avec l'utilisateur.",
    "",
    "Tu es l'agent **`agent-recette` ÉVALUATEUR PRODUIT** (ADR-001/003) : ta mission est l'ÉVALUATION du produit (parcours réel, UX, design, cohérence, performance) — distincte du CADRAGE TECHNIQUE (`agent-cadrage`). Tu peux LIRE le code réel si besoin (maquette réaliste), mais tu ne produis AUCUNE tâche technique.",
    "Cette recette est un objet de 1er NIVEAU, DISTINCT du cadrage technique : elle N'EST JAMAIS convertie en tâches (les éléments « à traiter » sont repris par un cadrage technique, décision ADMIN).",
    ...adrBlock,
    ...featureBlock,
    ...ruleBlock,
    ...docBlock,
    "Mission :",
    "- Récupère le contexte : `recette_get(<recetteId>)` (titre, projet, fonctionnalités + verdicts, règles, éléments, pièces), `feature_list`/`rule_list` du projet, `e2e_list` pour les tests E2E disponibles.",
    "- Accompagne l'utilisateur dans l'évaluation du parcours : réponds à ses questions, aide-le à confronter le réalisé au besoin.",
    "- Enregistre chaque constat via `recette_item_add` (catégorie `recommandation`/`probleme`, sévérité, contenu, discussion). La DÉCISION « à traiter » reste ADMIN (`recette_item_decision`), tu ne décides pas.",
    "- Rattache les fonctionnalités (`recette_feature_link`) et règles métier (`recette_rule_link`) évaluées, puis pose les verdicts (`recette_verdict_set` : conforme | non_conforme | a_ameliorer).",
    "- Dépose les pièces via `recette_doc_add` (lien | document | photo | vidéo) — `itemId` pour rattacher une pièce à un ÉLÉMENT précis.",
    "",
    "Outils MAQUETTE & PERFORMANCE (ADR-003) :",
    "- `recette_maquette_add` : GÉNÈRE une MAQUETTE HTML/CSS/JS avec données mock pour la fonctionnalité évaluée. Fournis `files` = liste de { path, content } (ex. index.html, style.css, app.js) et `entry` (défaut index.html). L'outil écrit les fichiers et renvoie une **URL** servie par le panneau comme PAGE STATIQUE (`/api/recettes/<recetteId>/maquette/<slug>/index.html`) : cette URL est rattachable à un élément (`itemId`) comme pièce `maquette`.",
    "- `recette_perf_run` : lance des **TESTS STANDARD** sur la cible PRÉPROD (`url` http/https) — **distincts des tests E2E Playwright**. Couvre : (1) **parcours de pages** (`pages` optionnel : URLs supplémentaires, ≤ 10 ; défaut `url`) avec informations réseau (durées/requêtes/types/tailles, compression, timings TTFB/DCL/load) ET capture des **erreurs console** (warnings, exceptions JS) + **erreurs réseau** (4xx/5xx, DNS, timeouts) ; (2) **Core Web Vitals** (LCP < 2,5 s, INP < 200 ms, CLS < 0,1) + long tasks > 50 ms + temps d'exécution JS ; (3) **STRESS TEST des routes d'API** (`routes` optionnel : chaînes relatives à `baseUrl` ou absolues, ex. `/api/health`, ou objets `{ path, method? }` ; ≤ 20 ; défaut `url`) — accès parallèles bornés : débit req/s, latence moy/p50/p95/p99, taux d'erreurs, **par route** + agrégat. Fournis `repoDir` (checkout applicatif contenant Playwright, ex. `/root/mada-talk-preprod`) pour les Core Web Vitals et la capture console ; sans Playwright, la mesure réseau/stress se fait via fetch. Le stress est BORNÉ (routes ≤ 20, concurrency ≤ 10, requests ≤ 200) : reste prudent pour ne pas dégrader la préprod. Le rapport (avec les **preuves** d'erreurs console/réseau et le détail par route) est rattaché à la recette comme pièce `performance` (rattachable à un élément via `itemId`, ou à un test Playwright via `e2eTestId`).",
    "- Tests E2E : liste-les avec `e2e_list` et lance-les avec `e2e_run` (`e2eTestId`, `origin='recette'`) — tu peux les rattacher à la recette et associer une mesure de performance via `e2eTestId`.",
    "",
    "Cadre : session dédiée à l'évaluation produit ; l'utilisateur clôturera la recette (« Terminer la recette »). Aucune création de tâche, aucune modification d'une recette qui n'est pas la tienne.",
    // Consigne de périmètre d'écriture (rôle ÉVALUATEUR PRODUIT) : préfixée d'un
    // saut de ligne car ce tableau est filtré (`filter(x => x !== "")`).
    "\n" + buildWriteScopeNotice("l'ÉVALUATEUR PRODUIT"),
  ].filter((x) => x !== "").join("\n");
}

/**
 * Prompt d'ouverture d'une session de SPRINT (agent-sprint) — v0.1.0.
 * Le sprint est un objet de PROJET (titre + durée + pièces client). La session
 * est rattachée au sprint (sprints.session_id). Mission + cadre, jamais méthode.
 * L'agent lit les pièces client → dialogue → PROPOSE puis REMPLIT les
 * fonctionnalités/règles métier (feature_* / rule_*) avec pièce source + émergence.
 * Il n'écrit JAMAIS d'ADR (les ADR restent à la charge des utilisateurs en recette).
 */
export function buildSprintPrompt({ sprintId, project, repos, title, startDate, endDate, pieces = [], docs = [], adrContext = "" }) {
  const proj = (project && String(project).trim()) || "";
  const repoBlock = (repos && repos.length)
    ? `  Repos transverses du projet (portée réelle — ADR 11) : ${repos.map((x) => x.repoId || x.id || x).join(", ")}`
    : "";
  // Bloc ADR (item 125) : « ## ADR de référence » construit par `adr_context`.
  // Les ADR servent d'ancrage (statut Accepté = fait de référence) — l'agent de
  // sprint ne les ÉCRIT jamais, il les CITE au plus.
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  const pieceBlock = (pieces && pieces.length)
    ? [
        "",
        "PIÈCES CLIENT du sprint (à LIRE avant toute proposition) :",
        ...pieces.map((p, i) => {
          const where = p.path ? `chemin : \`${p.path}\`` : (p.url ? `lien (lecture) : ${p.url}` : "localisation : à demander");
          const em = p.emergent ? ` · ÉMERGENTE${p.emergentOrigin ? ` (${p.emergentOrigin})` : ""}` : "";
          return `  ${i + 1}. [${p.nature || "pièce"}] ${p.title || p.pieceId || ""} — ${where}${em}`;
        }),
        "Lis chaque pièce (markdown/pdf/docx via son chemin ; lien Drive en LECTURE via son url). Classe son contenu : DÉJÀ EN PLACE (non à traiter) vs À FAIRE vs AMBIGU (à clarifier).",
        "",
      ]
    : [
        "",
        "Ce sprint n'a AUCUNE pièce client rattachée pour l'instant : demande à l'utilisateur de rattacher les pièces (onglet Sprints → bouton « Pièces ») avant de proposer, ou précise le besoin de vive voix.",
        "",
      ];
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence du projet (à LIRE — ils décrivent l'EXISTANT) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "Ils t'aident à trancher « déjà en place » (documenté/implémenté) vs « à faire » et à éviter les doublons. Les ADR Accepté sont des faits de référence ; les ADR Proposé ne sont pas actées.",
        "",
      ]
    : [];
  return [
    `Ouvre la **session de sprint** « ${title || sprintId || proj} » — projet : \`${proj}\`${repoBlock ? `\n${repoBlock}` : ""} (v0.1.0).`,
    "",
    `Sprint : \`${sprintId || "(non précisé)"}\`${startDate || endDate ? ` — période ${startDate || "?"} → ${endDate || "?"}` : ""}.`,
    "Un sprint est l'unité de temps d'UN SEUL projet (le produit) ; sa portée réelle est couverte par les repos transverses du projet (ADR 11). La session est RATTACHÉE au sprint (`sprints.session_id`) : elle se reprend.",
    ...adrBlock,
    ...pieceBlock,
    ...docBlock,
    "Mission :",
    "- Récupère le contexte : `sprint_get(<sprintId>)` (sprint, pièces client, fonctionnalités/règles déjà enregistrées, tâches et cadrages rattachées), `feature_list({ projectId })` / `rule_list({ projectId })` (inventaire AVANT de proposer, éviter les doublons), `doc_list({ projectId, includeRepoDocs: true })` (documents de référence).",
    "- **Pipeline** : (1) LIRE les pièces client et en faire la synthèse (déjà en place / à faire / ambigu) → (2) DIALOGUER avec l'utilisateur (confirmations, clarifications — admin dans un premier temps) → (3) PROPOSER fonctionnalités (`US-xxx`) et règles métier (`RM-xxxx`) → (4) REMPLIR après validation.",
    "- **Remplissage** via le MCP : `feature_register` / `rule_register` (avec `sourcedPieceId` = pièce SOURCE), liaisons `feature_rule_link`, rattachements `feature_sprint_link` / `rule_sprint_link` ; corrections via `feature_update` / `rule_update`. Le registre calcule lui-même l'ÉMERGENCE.",
    "- **Distinguer « déjà en place » vs « à faire »** : ne génère JAMAIS une fonctionnalité pour un comportement existant (vérifie `feature_list`/`rule_list` + documents de référence + ADR Accepté). En cas de doute : `question` avant d'écrire.",
    "- **N'écris JAMAIS d'ADR** (interdit) : les ADR restent à la charge des utilisateurs lors des cadrages. Tu peux au plus CITER une ADR existante (`adr_list`/`adr_get`).",
    "- **Émergents** (tâches sans fonctionnalité, règles apparues en cadrage, pièces après clôture) : SIGNALÉS et TRACÉS par le registre, JAMAIS bloqués. `cardinality_report` / `cardinality_signals_list` sont informatifs ; leur résolution est une décision humaine tracée.",
    "- Ne crée aucune tâche, aucun test, aucun code : tu remplis les Fonctionnalités et Règles métier du sprint, rien d'autre.",
    "",
    "Cadre : session dédiée au sprint ; à la fin, résume ce qui a été lu, ce qui est « déjà en place », les fonctionnalités/règles proposées puis créées (refs + pièces sources), les émergents signalés et les questions restantes.",
    "",
    buildWriteScopeNotice("l'AGENT DE SPRINT"),
  ].join("\n");
}

/**
 * Prompt d'ouverture d'une session de MIGRATION DES ANCIENS SPRINTS
 * (agent-migration) — v0.1.0. La session est rattachée à la migration
 * (`migrations.session_id`). Mission + cadre, jamais méthode : l'agent LIT les
 * ADR monolithiques + pièces client, PROPOSE un découpage en ADR atomiques,
 * n'écrit qu'APRÈS validation utilisateur, pose les détails en pièces jointes,
 * associe chaque ADR convertie à 1..N fonctionnalités, et rattache les éléments
 * hérités à l'ANCIEN SPRINT (sprint par défaut) SANS AUCUN faux émergent.
 */
export function buildMigrationPrompt({ migrationId, project, repos, sprintId, title, startDate, endDate, pieces = [], docs = [], adrs = [], adrContext = "" }) {
  const proj = (project && String(project).trim()) || "";
  const repoBlock = (repos && repos.length)
    ? `  Repos transverses du projet (portée réelle — ADR 11) : ${repos.map((x) => x.repoId || x.id || x).join(", ")}`
    : "";
  // Bloc ADR (item 125) : « ## ADR de référence » construit par `adr_context`.
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  // ADR monolithiques du projet (à LIRE et à DÉCOUPER).
  const adrListBlock = (adrs && adrs.length)
    ? [
        "",
        "ADR MONOLITHIQUES du projet (à LIRE puis à DÉCOUPER en ADR atomiques) :",
        ...adrs.map((a, i) => `  ${i + 1}. [${a.status || "(sans statut)"}] ${a.title || a.adrId || ""} — \`${a.adrId}\` — chemin : \`${a.path}\``),
        "Lis chaque fichier (`adr_get` puis lecture du `path`) : il contient PLUSIEURS décisions distinctes à séparer en ADR atomiques (titre/statut/contexte/décision/conséquences) ; les grands détails iront en PIÈCES JOINTES (`adr_file`).",
        "",
      ]
    : [];
  const pieceBlock = (pieces && pieces.length)
    ? [
        "",
        "PIÈCES CLIENT du projet (à LIRE — matière héritée à rattacher à l'ancien sprint) :",
        ...pieces.map((p, i) => {
          const where = p.path ? `chemin : \`${p.path}\`` : (p.url ? `lien (lecture) : ${p.url}` : "localisation : à demander");
          return `  ${i + 1}. [${p.nature || "pièce"}] ${p.title || p.pieceId || ""} — ${where}`;
        }),
        "",
      ]
    : [];
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence du projet (à LIRE — ils décrivent l'EXISTANT) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "",
      ]
    : [];
  return [
    `Ouvre la **session de migration des anciens sprints** « ${title || migrationId || proj} » — projet : \`${proj}\`${repoBlock ? `\n${repoBlock}` : ""} (v0.1.0).`,
    "",
    `Migration : \`${migrationId || "(non précisée)"}\`. ANCIEN SPRINT (sprint par défaut, cible de tous les rattachements) : \`${sprintId || "(non précisé)"}\`${startDate || endDate ? ` — période ${startDate || "?"} → ${endDate || "?"}` : ""}.`,
    "Tous les éléments migrés (pièces client, fonctionnalités, règles métier, ADR converties) et les anciennes tâches sont rattachés à CET ancien sprint. La session est RATTACHÉE à la migration (`migrations.session_id`) : elle se reprend.",
    ...adrBlock,
    ...adrListBlock,
    ...pieceBlock,
    ...docBlock,
    "Mission :",
    "- Récupère le contexte : `migration_get(<migrationId>)` (migration + sprint cible résolu), `sprint_get(<sprintId>)` (éléments déjà rattachés), `adr_list({ projectId })` + `adr_get(adrId)` (ADR monolithiques), `doc_attachment_list({ docId })` / `adr_conversion_list({ originalAdrId })` (conversions déjà faites), `feature_list({ projectId })` / `rule_list({ projectId })` (inventaire avant proposition).",
    "- **Pipeline** : (1) LIRE chaque ADR monolithique et repérer les DÉCISIONS DISTINCTES → (2) PROPOSER un découpage en ADR atomiques (titre/statut/contexte/décision/conséquences + pièces jointes pour les détails + fonctionnalités associées) → (3) FAIRE VALIDER EXPLICITEMENT par l'utilisateur (`question`) → (4) ÉCRIRE seulement après validation.",
    "- **Conversion sans perte** : `adr_convert({ originalAdrId, title, status, context, decision, consequences, attachments })`. L'ADR d'origine reste INTACTE ; le lien historique est écrit dans `adr_conversions`. Les grands détails passent en PIÈCES JOINTES (`adr_attach` / `doc_attachment_add` → `adr_file`) — jamais supprimés.",
    "- **ADR ↔ fonctionnalités** : associe CHAQUE ADR convertie à 1..N fonctionnalités (`feature_adr_link`), existantes ou créées après validation (`feature_register`). Ne laisse jamais une ADR convertie sans fonctionnalité (garde de cardinalité T1).",
    "- **Rattachement à l'ancien sprint** : `sprint_migrate_elements({ projectId })` — INSERT directs et idempotents pour les pièces client, fonctionnalités, règles métier, anciennes tâches et cadrages. N'appelle **JAMAIS** `sprint_attach_pieces` (il écrit `meta.emergent`).",
    "- **AUCUN FAUX ÉMERGENT (règle absolue)** : n'écris JAMAIS `emergent`/`emergent_origin` sur un élément hérité. Les anciennes tâches sont associées à l'ancien sprint SANS être marquées émergentes ; tu peux les lier à leur fonctionnalité (`task_feature_link`) et proposer leur ADR (`task_adr_propose` → validation humaine `task_adr_validate`).",
    "- **Clôture** : `migration_finish({ migrationId, status: 'done' })` quand la migration du projet est terminée et validée. Vérifie ensuite `cardinality_report({ projectId })` : aucun NOUVEAU signal d'émergence sur les éléments hérités.",
    "- Ne crée aucune tâche, aucun test, aucun code : tu convertis les ADR et tu rattaches l'existant, rien d'autre.",
    "",
    "Cadre : session dédiée à la migration ; VALIDATION UTILISATEUR OBLIGATOIRE avant toute écriture. À la fin, résume les ADR converties (origine → atomiques), les pièces jointes posées, les fonctionnalités associées, les éléments/tâches rattachés à l'ancien sprint et les questions restantes.",
    "",
    buildWriteScopeNotice("l'AGENT DE MIGRATION"),
  ].join("\n");
}

// Prompt de mission pour la session de CRÉATION / MISE À JOUR d'un test E2E
// (agent `test-agent`). Le test est une entité de 1er niveau : la session est
// rattachée au test (e2e_tests.session_id). mission ≠ méthode : le prompt porte
// la mission et le cadre, jamais la méthode d'écriture du spec.
export function buildTestPrompt({ e2eTestId, project, projects, title, description, mode = "create", specFile, scenario, docs = [], adrContext = "" }) {
  const projs = (projects && projects.length ? projects : (project ? [project] : []));
  const first = projs[0] || project || "";
  // Bloc ADR (item 125) : « ## ADR de référence » (adr_context). Additif.
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  const header =
    mode === "create"
      ? `Ouvre la session de CRÉATION du test E2E **« ${title || first} »** (projet repo source : ${projs.join(", ")}) (cadrage 08). Le test n'existe pas encore — tu vas le créer de bout en bout.`
      : `Ouvre la session de MISE À JOUR du test E2E **« ${title || e2eTestId} »** (projet repo source : ${projs.join(", ")}) (cadrage 08).`;
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence fournis en contexte (à LIRE avant d'écrire le spec) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "Lis chacun de ces fichiers (via read/cat/workspace) : ils portent l'architecture technique (stack, archi cible, composants, patterns, structure de dossiers), les specs fonctionnelles (User stories, règles métier) et les scénarios Gherkin existants. Le spec que tu écris DOIT respecter l'architecture (où placer/comment structurer) et couvrir le comportement décrit.",
        "",
      ]
    : [];
  return [
    header,
    "",
    `Test (entité 1er niveau) : ${e2eTestId ? `\`${e2eTestId}\`` : "(non encore enregistré)"}.`,
    description ? `Comportement à couvrir : ${description}.` : "Comportement à couvrir : à préciser avec l'utilisateur.",
    specFile ? `Emplacement du spec : \`${specFile}\`.` : "Emplacement du spec : à déterminer (tests/playwright/ ou testDir de la config du dépôt).",
    scenario ? `Scénario cible : ${scenario}.` : "",
    ...adrBlock,
    ...docBlock,
    "",
    "Mission :",
    "- Récupère le contexte : `e2e_list` (référentiel, éviter les doublons), `e2e_test_get(<e2eTestId>)` si le test existe déjà (DRAFT), et le contexte du dépôt (config Playwright, socle E2E existant, helpers).",
    "- Où écrire : dans le WORKSPACE CODER du projet repo source, sur une **branche de travail** dédiée (jamais l'hôte, jamais la branche principale).",
    "- Crée ou mets à jour le spec Playwright (test() = un scénario ; comportement transverse = une seule entité), enregistre l'entité via `e2e_test_register` (project = projet produit, repoIds = repos traversés), déclare les paramètres via `e2e_test_param_set` (défauts NON sensibles, secretRef pour les tokens), rattache la session via `e2e_test_session_set`.",
    "- Vérifie si possible par un run ciblé (`e2e_run`, origine `session`) : lis le **rapport texte** uniquement, corrige si besoin.",
    "- Règle IA : tu ne traites que le **texte** ; la vidéo est une preuve humaine (jamais interprétée).",
    "",
    "Cadre : session dédiée au test ; à la fin, résume ce qui a été fait (branche, fichier(s), test enregistré ACTIVE, paramètres) et les prochaines étapes (merge de la branche, run de vérification).",
    "",
    buildWriteScopeNotice("l'AGENT DE TEST E2E"),
  ].join("\n");
}

// Prompt d'une session test-agent LIBRE (hors entité test) : l'utilisateur veut
// dialoguer avec l'agent de test sans forcément créer de test (questions,
// diagnostic, conseils, exploration). Mission + cadre, jamais méthode.
export function buildFreeTestPrompt({ project, projects, message, docs = [], adrContext = "" }) {
  const projs = (projects && projects.length ? projects : (project ? [project] : []));
  const first = projs[0] || project || "";
  // Bloc ADR (item 125) : « ## ADR de référence » (adr_context). Additif.
  const adrBlock = (adrContext && String(adrContext).trim())
    ? ["", String(adrContext).trim(), ""]
    : [];
  const docBlock = (docs && docs.length)
    ? [
        "",
        "Documents de référence du projet fournis en contexte (à LIRE selon la demande) :",
        ...docs.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.title || d.docId || ""} — chemin : \`${d.path}\``),
        "Ce sont l'architecture technique (ADR), les specs fonctionnelles (User stories/règles métier) et les scénarios Gherkin du projet. Consulte-les pour ancrer tes réponses dans le réel.",
        "",
      ]
    : [];
  const lines = [
    `Session **test-agent** (libre — ${first ? "projet(s) : " + projs.join(", ") : "sans projet attaché"}) (cadrage 08).`,
    "",
    "Tu es l'agent dédié au cycle de vie des tests E2E Playwright (entités de 1er niveau) : tu aides l'utilisateur à créer/mettre à jour/supprimer un test, à comprendre le référentiel, à diagnostiquer un écart ou à préparer un spec. Cette session est LIBRE : aucun test n'est nécessairement créé — suis la demande de l'utilisateur.",
    message ? `Demande de l'utilisateur : ${message}` : "Demande de l'utilisateur : à préciser.",
    ...adrBlock,
    ...docBlock,
    "Contexte utile :",
    "- `e2e_list` (référentiel des tests existants, éviter les doublons), `e2e_test_get` (détail d'un test), `doc_list` (documents de référence ADR/specs/Gherkin du projet), `e2e_var_list` (variables & secrets E2E déclarés pour le projet — nécessaires au run d'un spec).",
    "- Si tu crées/mets à jour un test : travaille dans le workspace Coder du repo, branche de travail, `e2e_test_register` (project = projet produit, repoIds = repos traversés), `e2e_test_session_set` (rattache cette session), puis un run de vérification `e2e_run` (origine session) — rapporte texte uniquement.",
    "- Si l'utilisateur ne veut que discuter / explorer : réponds, propose des options, ne crée rien sans accord.",
    "Règle IA : tu ne traites que le texte ; la vidéo est une preuve humaine.",
    "",
    buildWriteScopeNotice("l'AGENT DE TEST E2E"),
  ];
  return lines.join("\n");
}

// Prompt d'une session d'orchestration UNIQUE pour un BATCH (mode `session`).
// L'orchestrateur pilote TOUTES les tâches du batch depuis cette seule session :
// il délègue chaque tâche aux agents de fond (atomic-plan → build-notify) dans
// l'ordre dicté par la readiness (dépendances + conflits fichiers), prépare ce
// qui peut l'être pendant les points bloquants, et respecte les portes humaines.
export function buildBatchSessionPrompt({ batch, tasksDetail, repos }) {
  const b = batch || {};
  const tasks = tasksDetail || [];
  const readiness = b.readiness || [];
  const line = [];
  line.push(`Pilote le **batch d'orchestration ${b.batchId || "?"}** — « ${b.title || ""} » (projet ${b.project || "?"}) en MODE SESSION UNIQUE.`);
  line.push("");
  line.push(`Le batch couvre ${tasks.length} tâche(s) issues de ${b.cadrageId ? "le cadrage " + b.cadrageId : "un regroupement ad-hoc"}. Tu es l'**unique session d'orchestration** de ce batch : les tâches sont exécutées en ordonnancement par TOI (délégation aux agents de fond), pas par des sessions par tâche.`);
  line.push("");
  line.push("Règles d'orchestration du batch :");
  line.push(`- Ne lance JAMAIS plus de ${b.maxParallel || 2} tâches en cours simultanément (plafond de parallélisme).`);
  line.push("- Consulte la READINESS (`batch_readiness`) et la MATRICE DE CONFLIT (`batch_conflict_matrix`) à chaque décision : une tâche n'est lançable que si ses dépendances sont satisfaites ET qu'aucune de ses étapes ne chevauche une étape active d'une autre tâche.");
  line.push("- Une tâche bloquée (dépendance non satisfaite, étape en conflit, déploiement en attente) n'est pas perdue : PRÉPARE ce qui est préparable (plans des tâches suivantes, contexte), puis lance-la dès que le blocage est levé — sans intervention humaine pour l'ORDONNANCEMENT.");
  line.push("- Les PORTES HUMAINES restent humaines : validation de plan (`decision_request` kind=validation), review/merge, déploiement. Tu ne les franchis jamais ; tu enchaînes la suite après résolution.");
  line.push("- À chaque tâche terminée (`done`), relance la readiness : une autre tâche devient peut-être lançable. Quand TOUTES les tâches sont `done`, passe le batch à `completed` (`batch_set_status`).");
  line.push("");
  if (tasks.length) {
    line.push("Tâches du batch :");
    for (const t of tasks) {
      line.push(`  - ${t.id || t.taskId} [${t.status || "?"}] — ${(t.title || t.request || "").slice(0, 90)}`);
    }
  }
  line.push("");
  line.push("Pour CHAQUE tâche, suis le pipeline d'orchestration standard (cf. ton guide `orchestrator.md`) : task_get pour l'état, délégation à `atomic-plan` (planification) puis `build-notify` (exécution), plan_transition/task_transition, décisions humaines, déploiement via le mécanisme CI/CD des repos concernés.");
  line.push("");
  line.push("Cadre : tu n'édites jamais le code toi-même (tu délègues), tu ne ré-enregistres pas les tâches (déjà enregistrées, statut `queued`/`started`), tu publies `task_event`/événements pour tracer. Tu informes l'utilisateur de l'avancement et des blocages.");
  return line.join("\n");
}

export { OPENCODE_BIN };
