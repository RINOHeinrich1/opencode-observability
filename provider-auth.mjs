// provider-auth.mjs — Génération, propagation et migration de l'auth.json opencode.
//
// L'auth.json natif opencode a le format `{ "<provider>": { "type": "api", "key": "<clé>" } }`.
// Ce module est la SEULE source de génération : il lit la clé ACTIVE de chaque
// fournisseur depuis la table `provider_keys` (panel-db.mjs, chiffrée
// AES-256-GCM) et écrit :
//   - l'auth.json de RÉFÉRENCE (`SHARED_AUTH`, instance de référence) ;
//   - l'auth.json de CHAQUE instance utilisateur
//     (`<USERS_DIR>/<user>/data/opencode/auth.json`).
//
// L'écriture est IDEMPOTENTE (comparaison sha256, skip si identique) pour NE PAS
// re-déclencher en boucle l'unité systemd `opencode-auth-sync.path` qui surveille
// `SHARED_AUTH`. `auth.json` est un fichier DÉRIVÉ : jamais édité à la main,
// toujours root-only 0600.
//
// Importé par le panneau (`server.mjs`) ET par les scripts d'infra
// (`opencode-user-provision.mjs`, `opencode-auth-sync.mjs`) via chemin absolu.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { getActiveProviderKeys, listProviderKeys, addProviderKey } from "./panel-db.mjs";

export const SHARED_AUTH = process.env.OPENCODE_SHARED_AUTH || "/root/.local/share/opencode/auth.json";
export const USERS_DIR = process.env.OPENCODE_USERS_DIR || "/root/.config/opencode/users";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Rend le contenu `auth.json` (format natif opencode) depuis les clés ACTIVES.
export function renderAuthJson(activeKeys) {
  const obj = {};
  for (const { provider, key } of activeKeys || []) {
    if (!provider || !key) continue;
    obj[provider] = { type: "api", key };
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

// Écrit un `auth.json` (0600) en SKIP si le contenu est déjà identique
// (idempotent : évite de re-déclencher le path-unit systemd en boucle).
export function writeAuthJson(dest, content) {
  const buf = Buffer.from(String(content));
  try {
    if (existsSync(dest) && sha256(readFileSync(dest)) === sha256(buf)) return { written: false, skipped: true };
  } catch { /* en cas de doute, on réécrit */ }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf, { mode: 0o600 });
  chmodSync(dest, 0o600);
  return { written: true, skipped: false };
}

// Régénère l'auth.json de référence + propage à toutes les instances utilisateur.
// `writeShared` (défaut true) : écrire AUSSI `SHARED_AUTH` (false côté
// provisioning d'une instance isolée, qui ne doit pas toucher la référence).
// GARDE : sans aucune clé active, on N'ÉCRIT RIEN (ne jamais vider l'auth.json).
export async function regenerateAndPropagate({ writeShared = true } = {}) {
  const active = await getActiveProviderKeys();
  if (!active.length) {
    return { providers: 0, shared: { written: false, skipped: true }, synced: 0, skipped: 0, errors: 0, notice: "aucune clé active — auth.json inchangé" };
  }
  const content = renderAuthJson(active);
  const shared = writeShared ? writeAuthJson(SHARED_AUTH, content) : { written: false, skipped: true };
  let synced = 0;
  let skipped = 0;
  let errors = 0;
  if (existsSync(USERS_DIR)) {
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const r = writeAuthJson(join(USERS_DIR, entry.name, "data", "opencode", "auth.json"), content);
        if (r.skipped) skipped++;
        else synced++;
      } catch {
        errors++;
      }
    }
  }
  return { providers: active.length, shared, synced, skipped, errors };
}

// Migration IDEMPOTENTE : au PREMIER déploiement, importe les fournisseurs de
// l'auth.json existant (1 clé ACTIVE par fournisseur). Ne fait RIEN si la table
// `provider_keys` n'est pas vide (aucun écrasement d'une gestion déjà en place).
export async function migrateFromAuthJson() {
  const existing = await listProviderKeys();
  if (existing.length > 0) return { migrated: 0, skipped: true, reason: "table déjà peuplée" };
  if (!existsSync(SHARED_AUTH)) return { migrated: 0, skipped: true, reason: "auth.json absent" };
  let raw;
  try {
    raw = JSON.parse(readFileSync(SHARED_AUTH, "utf8"));
  } catch {
    return { migrated: 0, skipped: true, reason: "auth.json illisible" };
  }
  let migrated = 0;
  for (const [provider, cred] of Object.entries(raw || {})) {
    const key = cred && typeof cred === "object" ? cred.key : null;
    if (!provider || !key) continue;
    await addProviderKey({ provider, label: "importé (auth.json)", key: String(key) });
    migrated++;
  }
  return { migrated, skipped: false };
}
