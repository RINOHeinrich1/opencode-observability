// exec-async.mjs — Exécution de process externes NON BLOQUANTE et BORNÉE.
//
// Remplace les `execFileSync` (synchrones, bloquants pour l'event loop HTTP :
// un `coder list`/`git clone`/`systemctl` lent gelait TOUT le panneau) par un
// `spawn` + promesse, avec :
//   - sortie bornée (stdout/stderr capturés en pipe, JAMAIS hérités — aucun
//     secret ne part directement dans les logs PM2) ;
//   - timeout dur : SIGTERM puis SIGKILL après un délai de grâce ;
//   - résolution SANS rejet sur code ≠ 0 (l'appelant décide), sauf `runJson`.
//
// D5 — Redaction des secrets : toute sortie (stdout/stderr) est nettoyée de tout
// PAT/URL de clone/token avant remontée ou journalisation (`redactSecrets`), y
// compris les gardes globales (cf. server.mjs).

import { spawn } from "node:child_process";

/** Timeout par défaut (ms) quand l'appelant n'en fournit pas. */
export const DEFAULT_TIMEOUT_MS = 120000;
/** Délai de grâce (ms) entre SIGTERM et SIGKILL. */
export const KILL_GRACE_MS = 2000;
/** Plafond de capture d'un flux (octets) — évite une accumulation illimitée (ADR-005). */
export const MAX_CAPTURE_BYTES = 1000000;

// --- Redaction des secrets (D5) -------------------------------------------
// Motifs couvrant les fuites constatées/possibles :
//   - URL de clone git avec PAT : https://user:token@host, x-access-token:token@ ;
//   - tokens GitHub (ghp_/github_pat_/gho_/ghs_/ghr_) ;
//   - en-têtes/variables/flags (CODER_SESSION_TOKEN, Authorization: Bearer, --token,
//     token/password/secret=…, access_token=…).
const SECRET_PATTERNS = [
  // URL de remote git : masque userinfo (user:motdepasse@ / x-access-token:token@)
  [/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1***:***@"],
  // userinfo sans schéma (ex. //x-access-token:ghp_…@)
  [/(\/\/)[^/@\s:]+:[^/@\s]+@/g, "$1***:***@"],
  // Tokens GitHub
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***"],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, "***"],
  [/\bghs_[A-Za-z0-9]{20,}\b/g, "***"],
  [/\bghr_[A-Za-z0-9]{20,}\b/g, "***"],
  // Variables / en-têtes / flags porteurs de secret
  [/(CODER_SESSION_TOKEN\s*[:=]\s*)\S+/gi, "$1***"],
  [/(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1***"],
  [/(--token[= ])\S+/gi, "$1***"],
  [/([?&](?:access_token|token|password|passwd|pwd|tokenId|secret)=)[^&\s]+/gi, "$1***"],
];

/**
 * Masque les secrets d'un texte avant toute remontée/journalisation.
 * Idempotent et sûr : renvoie l'entrée non-string inchangée (null/undefined).
 */
export function redactSecrets(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

/**
 * Exécute `file` avec `args` de façon ASYNCHRONE et BORNÉE.
 *
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string,
 *                    stderr:string, timedOut:boolean, error:Error|null}>}
 *   Ne rejette JAMAIS sur code ≠ 0 : le `code` est porté par le résultat.
 *   `stderr`/`stdout` sont déjà nettoyés par `redactSecrets`.
 */
export function runExternal(file, args = [], { timeout = DEFAULT_TIMEOUT_MS, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({
        code: null, signal: null, stdout: "",
        stderr: redactSecrets(String((e && e.message) || e)),
        timedOut: false, error: e || new Error("spawn impossible"),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const append = (cur, chunk) =>
      cur.length >= MAX_CAPTURE_BYTES ? cur : cur + String(chunk).slice(0, MAX_CAPTURE_BYTES - cur.length);

    const finish = (code, signal, err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: code === undefined ? null : code,
        signal: signal || null,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
        error: err || null,
      });
    };

    // Timeout dur : SIGTERM (arrêt propre) puis SIGKILL après le délai de grâce.
    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch {}
          killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
        }, timeout)
      : null;

    if (child.stdout) child.stdout.on("data", (c) => { stdout = append(stdout, c); });
    if (child.stderr) child.stderr.on("data", (c) => { stderr = append(stderr, c); });
    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

/**
 * Comme `runExternal` mais en exigeant une sortie JSON sur stdout et un code 0.
 * Rejette (avec message redacté) si code ≠ 0 ou JSON invalide. L'erreur porte
 * `code`/`stdout`/`stderr` (redactés) pour un diagnostic sans fuite.
 */
export async function runJson(file, args = [], opts = {}) {
  const r = await runExternal(file, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || (r.error && r.error.message) || `exit ${r.code}`);
    throw Object.assign(new Error(String(detail).trim().slice(0, 500) || `exit ${r.code}`), {
      code: r.code, stdout: r.stdout, stderr: r.stderr,
    });
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw Object.assign(new Error(`sortie JSON invalide : ${String(r.stdout).slice(0, 200)}`), {
      code: -1, stdout: r.stdout, stderr: r.stderr,
    });
  }
}
