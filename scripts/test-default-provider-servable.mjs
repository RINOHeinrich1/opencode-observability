#!/usr/bin/env node
// Test déterministe (SANS DB, sans réseau) : le fournisseur par défaut `opencode`
// (sans clé API) est TOUJOURS servable — tout en préservant la politique A pour
// les fournisseurs à clé et le contrôle de CATALOGUE.
//
// Vérifie :
//   1. `checkModelServable` accepte `opencode/*` (présent au catalogue) même sans
//      `opencode` dans les fournisseurs à clé active — et aussi catalogue vide (A002) ;
//   2. `resolveAgentModel("clean-arch-detector-react")` (modèle `opencode/*`) NE
//      LÈVE PAS et renvoie le modèle déclaré (politique A — A002/A003) ;
//   3. NON-RÉGRESSION : un agent dont le fournisseur à clé N'EST PAS actif lève
//      toujours `MODEL_NOT_SERVED` (politique A inchangée) ;
//   4. NON-RÉGRESSION : un modèle `opencode/*` ABSENT du catalogue reste refusé
//      (pas de sur-correction : le contrôle de catalogue est conservé).
//
// Usage : node scripts/test-default-provider-servable.mjs
import {
  DEFAULT_PROVIDER_IDS,
  isDefaultProvider,
  checkModelServable,
  resolveAgentModel,
  listServedModels,
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

// Fournisseurs à clé active RÉELS (auth.json) — SANS `opencode` (par construction).
const KEYED = new Set(["deepseek", "deepinfra", "opencode-go"]);
// Catalogue réel du CLI ; repli minimal DÉTERMINISTE si le CLI est injoignable.
const realCatalog = listServedModels();
const CATALOG = realCatalog.length ? realCatalog : ["opencode/big-pickle", "deepseek/deepseek-v4-pro"];

// --- 0. Notion « fournisseur par défaut » (A001) --------------------------
check("0. DEFAULT_PROVIDER_IDS = ['opencode']", [...DEFAULT_PROVIDER_IDS], ["opencode"]);
check("0. isDefaultProvider('opencode')", isDefaultProvider("opencode"), true);
check("0. isDefaultProvider('deepseek')", isDefaultProvider("deepseek"), false);
check("0. isDefaultProvider(null)", isDefaultProvider(null), false);

// --- 1. checkModelServable : opencode/* servable SANS clé active (A002) ----
const r1 = checkModelServable({ model: "opencode/big-pickle", activeProviders: KEYED, catalog: CATALOG });
check("1. opencode/big-pickle servable sans clé active", r1.servable, true);
check("1. fournisseur identifié « opencode »", r1.provider, "opencode");

// Catalogue indisponible (CLI injoignable) : repli NON bloquant pour le défaut.
const r1b = checkModelServable({ model: "opencode/big-pickle", activeProviders: KEYED, catalog: [] });
check("1bis. opencode/* servable quand catalogue indisponible", r1b.servable, true);

// --- 2. resolveAgentModel politique A : agent opencode/* ne lève pas -------
let r2 = null, err2 = null;
try {
  r2 = resolveAgentModel("clean-arch-detector-react", { activeProviders: KEYED, catalog: CATALOG });
} catch (e) {
  err2 = e;
}
check("2. resolveAgentModel N'échoue PAS", err2 === null, true);
check("2. modèle déclaré conservé (opencode/big-pickle)", r2 && r2.model, "opencode/big-pickle");
check("2. aucun repli appliqué (fallback=false)", r2 && r2.fallback, false);

// --- 3. NON-RÉGRESSION politique A : fournisseur à clé NON active ----------
let err3 = null;
try {
  resolveAgentModel("orchestrator", { activeProviders: new Set(), catalog: CATALOG });
} catch (e) {
  err3 = e;
}
check("3. orchestrator (deepseek/*) sans clé ⇒ ModelNotServedError", err3 instanceof ModelNotServedError, true);
check("3. code = MODEL_NOT_SERVED", err3 && err3.code, "MODEL_NOT_SERVED");

// --- 4. NON-RÉGRESSION : opencode/* ABSENT du catalogue reste refusé -------
const r4 = checkModelServable({ model: "opencode/modele-inexistant-xyz", activeProviders: KEYED, catalog: CATALOG });
check("4. opencode/* absent du catalogue ⇒ refusé", r4.servable, false);
// Contrôle de catalogue toujours actif pour un fournisseur à clé ACTIVE.
const r4b = checkModelServable({ model: "deepseek/modele-inexistant-xyz", activeProviders: KEYED, catalog: CATALOG });
check("4bis. deepseek/* absent du catalogue ⇒ refusé", r4b.servable, false);
// Un fournisseur à clé ACTIVE + modèle présent ⇒ servi (non-régression positive).
const keyedModel = CATALOG.find((x) => x.startsWith("deepseek/")) || "deepseek/deepseek-v4-pro";
const r4c = checkModelServable({ model: keyedModel, activeProviders: KEYED, catalog: CATALOG });
check(`4ter. modèle à clé active présent au catalogue (${keyedModel}) ⇒ servable`, r4c.servable, true);

console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "TOUS LES TESTS PASSENT" : failures + " ÉCHEC(S)"}`);
process.exit(failures === 0 ? 0 : 1);
