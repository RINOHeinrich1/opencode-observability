// env.mjs — Chargement du .env pour orchestrator-panel.
//
// Lit le .env global hôte (~/.config/opencode/.env) puis un éventuel .env
// local du panel (./.env, gitignoré), au format KEY=VALUE, SANS écraser une
// variable déjà présente dans l'environnement (`process.env` prime).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return false;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

/**
 * Charge la configuration d'environnement du panel :
 *   1. ~/.config/opencode/.env (global hôte)
 *   2. <panel>/.env (local, gitignoré)
 * Sans écraser les variables déjà définies.
 */
export function loadEnv() {
  loadEnvFile(join(homedir(), ".config", "opencode", ".env"));
  loadEnvFile(join(__dirname, ".env"));
}
