#!/usr/bin/env node
// Test déterministe (SANS DB, sans réseau) : distinguer « absence de clé » de
// « auth.json transitoirement illisible » dans l'erreur de cohérence modèle/clé
// (ADR-005 §b, politique A). Verrouille la distinction absent / illisible / ok
// et le caractère `transient` — NON reproductible en E2E sans muter l'auth
// partagé (interdit).
//
// Vérifie :
//   1. `getAuthJsonPath()` lit l'env À L'EXÉCUTION (`OPENCODE_SHARED_AUTH`) ;
//   2. `getActiveProvidersStatus()` distingue `ok` / `absent` / `illisible` ;
//   3. `getActiveProviderIds()` délègue et conserve le contrat `Set` ;
//   4. `checkModelServable({authStatus})` produit des `reason`/`cause` DISTINCTES
//      (clé absente vs auth.json illisible vs auth.json absent) et un comportement
//      INCHANGÉ si `authStatus` est omis ;
//   5. `ModelNotServedError` porte authPath/authExists/authReadable/cause/transient
//      et conserve `code = MODEL_NOT_SERVED` + champs model/provider ;
//   6. `resolveAgentModel` propage la distinction jusqu'à l'erreur levée ;
//   7. NON-RÉGRESSION : un agent `opencode/*` (fournisseur par défaut sans clé)
//      reste servable même sans clé active.
//
// Usage : node scripts/test-auth-read-robustness.mjs
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAuthJsonPath,
  getActiveProvidersStatus,
  getActiveProviderIds,
  checkModelServable,
  resolveAgentModel,
  ModelNotServedError,
} from "../session-bridge.mjs";

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
}

// --- Fixtures : 3 états de fichier + 1 catalogue déterministe --------------
const origEnv = process.env.OPENCODE_SHARED_AUTH;
const tmp = mkdtempSync(join(tmpdir(), "auth-read-robustness-"));
const absentPath = join(tmp, "absent.json");
const unreadablePath = join(tmp, "unreadable.json");
const okPath = join(tmp, "ok.json");
writeFileSync(unreadablePath, "{ ceci n'est pas du JSON valide", "utf8");
writeFileSync(okPath, JSON.stringify({ deepseek: { type: "api", key: "x" }, deepinfra: { type: "api", key: "y" } }), "utf8");

const CAT = ["deepinfra/m2", "deepseek/ds", "opencode/big-pickle"];

try {
  // --- 1. chemin d'auth lu à l'exécution (A001) ---------------------------
  process.env.OPENCODE_SHARED_AUTH = okPath;
  check("1. getAuthJsonPath() lit l'env À L'EXÉCUTION", getAuthJsonPath(), okPath);

  // --- 2. état `ok` (A001/A002) -------------------------------------------
  const sOk = getActiveProvidersStatus();
  check("2. ok.exists", sOk.exists, true);
  check("2. ok.readable", sOk.readable, true);
  check("2. ok.path", sOk.path, okPath);
  check("2. ok.providers", [...sOk.providers].sort(), ["deepinfra", "deepseek"]);
  check("2. ok.error", sOk.error, null);
  check("2. getActiveProviderIds() délègue (Set)", getActiveProviderIds() instanceof Set, true);
  check("2. getActiveProviderIds() contenu identique", [...getActiveProviderIds()].sort(), ["deepinfra", "deepseek"]);

  // --- 3. état `absent` ---------------------------------------------------
  process.env.OPENCODE_SHARED_AUTH = absentPath;
  const sAbsent = getActiveProvidersStatus();
  check("3. absent.exists", sAbsent.exists, false);
  check("3. absent.readable", sAbsent.readable, false);
  check("3. absent.providers vide", [...sAbsent.providers], []);
  check("3. absent.path", sAbsent.path, absentPath);
  check("3. getActiveProviderIds() vide", [...getActiveProviderIds()], []);

  // --- 4. état `illisible` (fichier existe, JSON invalide) ----------------
  process.env.OPENCODE_SHARED_AUTH = unreadablePath;
  const sBad = getActiveProvidersStatus();
  check("4. illisible.exists", sBad.exists, true);
  check("4. illisible.readable", sBad.readable, false);
  check("4. illisible.providers vide", [...sBad.providers], []);
  check("4. illisible.error borné non nul", typeof sBad.error === "string" && sBad.error.length > 0, true);

  // --- 5. checkModelServable : causes DISTINCTES (A003) -------------------
  const authOk = { path: okPath, exists: true, readable: true, providers: new Set(["deepseek"]), error: null };
  const authAbsent = { path: absentPath, exists: false, readable: false, providers: new Set(), error: null };
  const authBad = { path: unreadablePath, exists: true, readable: false, providers: new Set(), error: "SyntaxError" };

  // (a) clé réellement absente : auth.json lisible, aucune entrée pour le fournisseur.
  const rKey = checkModelServable({ model: "deepinfra/m2", activeProviders: new Set(["deepseek"]), catalog: CAT, authStatus: authOk });
  check("5a. clé absente ⇒ non servable", rKey.servable, false);
  check("5a. clé absente ⇒ cause provider_key_absent", rKey.cause, "provider_key_absent");
  check("5a. clé absente ⇒ transient false", rKey.transient, false);
  check("5a. clé absente ⇒ reason historique conservée", rKey.reason, "aucune clé active pour le fournisseur « deepinfra »");

  // (b) auth.json TRANSITOIREMENT illisible : cause indéterminée, à réessayer.
  const rBad = checkModelServable({ model: "deepinfra/m2", activeProviders: new Set(), catalog: CAT, authStatus: authBad });
  check("5b. illisible ⇒ cause auth_unreadable", rBad.cause, "auth_unreadable");
  check("5b. illisible ⇒ transient TRUE", rBad.transient, true);
  check("5b. illisible ⇒ reason mentionne l'illisibilité", /illisible/i.test(rBad.reason), true);
  check("5b. illisible ≠ message « clé absente »", rBad.reason === "aucune clé active pour le fournisseur « deepinfra »", false);

  // (c) auth.json ABSENT : configuration à corriger (non transitoire).
  const rMissing = checkModelServable({ model: "deepinfra/m2", activeProviders: new Set(), catalog: CAT, authStatus: authAbsent });
  check("5c. auth absent ⇒ cause auth_absent", rMissing.cause, "auth_absent");
  check("5c. auth absent ⇒ transient false", rMissing.transient, false);

  // (d) comportement INCHANGÉ si `authStatus` omis (contrat historique).
  const rNoStatus = checkModelServable({ model: "deepinfra/m2", activeProviders: new Set(["deepseek"]), catalog: CAT });
  check("5d. authStatus omis ⇒ reason historique", rNoStatus.reason, "aucune clé active pour le fournisseur « deepinfra »");
  check("5d. authStatus omis ⇒ pas de cause structurée", rNoStatus.cause, undefined);
  check("5d. authStatus omis ⇒ pas de transient structuré", rNoStatus.transient, undefined);

  // --- 6. ModelNotServedError enrichie (A004) -----------------------------
  const err = new ModelNotServedError({
    model: "deepinfra/m2",
    provider: "deepinfra",
    activeProviders: new Set(),
    catalog: CAT,
    reason: rBad.reason,
    authPath: unreadablePath,
    authExists: true,
    authReadable: false,
    cause: "auth_unreadable",
    transient: true,
  });
  check("6. code CONSERVÉ MODEL_NOT_SERVED", err.code, "MODEL_NOT_SERVED");
  check("6. authPath porté", err.authPath, unreadablePath);
  check("6. authExists porté", err.authExists, true);
  check("6. authReadable porté", err.authReadable, false);
  check("6. cause portée", err.cause, "auth_unreadable");
  check("6. transient porté", err.transient, true);
  check("6. champs model/provider conservés", [err.model, err.provider], ["deepinfra/m2", "deepinfra"]);
  check("6. message signale TRANSITOIRE", /TRANSITOIRE/.test(err.message), true);
  check("6. détail lisible conservé", err.reason, rBad.reason);

  // --- 7. resolveAgentModel propage la distinction (A005) -----------------
  // Agent `orchestrator` ⇒ modèle `deepseek/deepseek-v4-pro` (fournisseur à clé).
  process.env.OPENCODE_SHARED_AUTH = unreadablePath;
  let errResolve = null;
  try {
    resolveAgentModel("orchestrator", { catalog: CAT });
  } catch (e) {
    errResolve = e;
  }
  check("7. resolveAgentModel (auth illisible) ⇒ ModelNotServedError", errResolve instanceof ModelNotServedError, true);
  check("7. cause auth_unreadable propagée", errResolve && errResolve.cause, "auth_unreadable");
  check("7. transient TRUE propagé", errResolve && errResolve.transient, true);
  check("7. authPath propagé", errResolve && errResolve.authPath, unreadablePath);
  check("7. authReadable false propagé", errResolve && errResolve.authReadable, false);
  check("7. code conservé", errResolve && errResolve.code, "MODEL_NOT_SERVED");

  // Clé réellement absente (auth.json lisible, fournisseur non présent).
  process.env.OPENCODE_SHARED_AUTH = okPath;
  let errKey = null;
  try {
    resolveAgentModel("orchestrator", { catalog: ["deepinfra/m2", "opencode/big-pickle"] });
  } catch (e) {
    errKey = e;
  }
  check("7bis. clé absente ⇒ ModelNotServedError", errKey instanceof ModelNotServedError, true);
  check("7bis. cause provider_key_absent", errKey && errKey.cause, "provider_key_absent");
  check("7bis. transient FALSE (pas transitoire)", errKey && errKey.transient, false);
  check("7bis. authPath = chemin effectif", errKey && errKey.authPath, okPath);

  // --- 8. NON-RÉGRESSION : opencode/* (défaut sans clé) reste servable -----
  process.env.OPENCODE_SHARED_AUTH = absentPath; // aucun fournisseur à clé active
  let r8 = null, e8 = null;
  try {
    r8 = resolveAgentModel("clean-arch-detector-react", { catalog: ["opencode/big-pickle"] });
  } catch (e) {
    e8 = e;
  }
  check("8. agent opencode/* sans clé ne lève PAS", e8 === null, true);
  check("8. modèle déclaré conservé", r8 && r8.model, "opencode/big-pickle");
  check("8. aucun repli (politique A)", r8 && r8.fallback, false);
} finally {
  if (origEnv === undefined) delete process.env.OPENCODE_SHARED_AUTH;
  else process.env.OPENCODE_SHARED_AUTH = origEnv;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "TOUS LES TESTS PASSENT" : failures + " ÉCHEC(S)"}`);
process.exit(failures === 0 ? 0 : 1);
