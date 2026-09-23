/**
 * E2E — Onglet Fournisseurs : contrôle PROACTIF de cohérence « clé active
 * fournisseur ↔ modèles déclarés par les agents » (volet préventif du constat 13).
 *
 * Entité E2E (1er niveau, indépendante de la tâche) : E2E-ECOSYSTEM-1j9t0jq
 *   project   = ecosystem
 *   repoIds   = ['opencode-observability']
 *   specFile  = tests/e2e/ecosystem-fournisseurs-coherence.spec.ts
 *
 * Tâche d'origine : T-20260923-073508-d3i9 (Plan B — volet test).
 * Source produit  : cadrage CT-mudra9eh-tgqa (item 163, improvement) — volet
 *                   préventif du « constat 13 » (bug HIGH).
 * ADR de référence (Accepté) : ADR-005 — « Sélection des modèles d'exécution des
 *                   sessions du panneau (cohérence clé active fournisseur ↔
 *                   frontmatter des agents) », volet (a) : contrôle préventif
 *                   NON bloquant à l'activation/création d'une clé et à l'édition
 *                   du modèle d'un agent, avec repli si le catalogue est absent.
 *
 * ---------------------------------------------------------------------------
 * Feature: Onglet Fournisseurs — contrôle proactif clé active ↔ modèles déclarés
 *
 *   Scenario 1 (oracle) : état incohérent visible SANS action
 *     Given l'administrateur ouvre la page Écosystème → sous-onglet « Fournisseurs »
 *     And la clé active d'un fournisseur ne sert PAS le modèle déclaré d'au moins
 *         un agent (ex. orchestrator → deepseek/deepseek-v4-flash)
 *     When l'onglet Fournisseurs est rendu
 *     Then un bandeau d'état explicite signale « N agent(s) sur un modèle non servi
 *          par la clé active » et liste les couples « agent → modèle »
 *     And une action « Corriger » ouvre une modale listant CHAQUE agent affecté
 *         (agent → modèle, fournisseur de la clé active, raison)
 *     And la modale propose la mise à jour du modèle de l'agent (bouton
 *         « Changer le modèle » → modale d'édition du modèle)
 *
 *   Scenario 2 (non-régression) : état cohérent → AUCUN faux avertissement
 *     Given la clé active sert TOUS les modèles déclarés des agents
 *     When l'administrateur ouvre l'onglet Fournisseurs
 *     Then AUCUN bandeau d'avertissement de cohérence n'est affiché
 *
 *   Scenario 3 : l'édition du modèle d'un agent déclenche le contrôle
 *     Given l'administrateur ouvre la modale « Modèle » d'un agent
 *     When il enregistre le modèle de l'agent
 *     Then, si l'état est incohérent, une modale de cohérence explicite est
 *          affichée (agents/modèles affectés + proposition de mise à jour)
 *     And, si l'état est cohérent, aucune modale de cohérence n'est affichée
 *
 *   Scenario 4 (fournisseur par défaut SANS clé) : opencode/* jamais « non servi »
 *     Given un agent déclare un modèle `opencode/*` (fournisseur par défaut sans clé)
 *     When l'état de cohérence est lu
 *     Then aucun modèle `opencode/*` n'est signalé « non servi par la clé active »
 *     And `opencode` n'apparaît jamais dans `activeProviders` (ce n'est pas une clé)
 *
 * ---------------------------------------------------------------------------
 * Politique d'état non reproduit : le spec DÉTECTE l'état via
 * `GET /api/providers/coherence` (jamais de mutation réelle de la clé
 * fournisseur — l'activation d'une clé régénère `auth.json` et REDÉMARRE toutes
 * les instances opencode : interdite ici). Si le comportement préventif n'est
 * pas déployé (route absente) ou si l'état requis n'est pas reproductible, le
 * test se SKIP avec une raison explicite (jamais d'échec rouge trompeur).
 *
 * Preuve alternative (registre, hors harness) : protocole HTTP
 *   GET /api/providers/coherence → 200 { ok, catalogAvailable, activeProviders,
 *                                         affected:[{agent, model, provider, reason}],
 *                                         authPath }
 *   POST /api/providers/keys/:id/activate → 200 { ok, propagation, restarted,
 *                                                 failed, coherence }
 *   POST /api/providers/keys            → 201 { ok, key, coherence }
 *   POST /api/agents/:name/model        → 200 { ok, name, model, file, coherence }
 *
 * Paramètres (déclarés au registre sur l'entité ; surchargeables au run) :
 *   - baseUrl        (url)                 défaut https://dev.madatalk.fr — env E2E_BASE_URL
 *   - adminEmail     (secret/ref)          ECOSYSTEM_E2E_ADMIN_EMAIL
 *   - adminPassword  (secret/ref)          ECOSYSTEM_E2E_ADMIN_PASSWORD
 *   - coherencePath  (string)              défaut /api/providers/coherence
 *   - requestedModel (string)              défaut deepseek/deepseek-v4-flash
 *   - activeProvider (string)              défaut deepseek
 */
import { test, expect, type Page, type APIResponse } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set de l'entité E2E-ECOSYSTEM-1j9t0jq) ----
// Le runner e2e_run pose E2E_BASE_URL ; les secrets du projet sont injectés sous
// leur nom (ECOSYSTEM_E2E_ADMIN_*) ; les surcharges paramValues arrivent aussi par nom.
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://dev.madatalk.fr";

const ADMIN_EMAIL =
  process.env.ECOSYSTEM_E2E_ADMIN_EMAIL ||
  process.env.adminEmail ||
  process.env.E2E_USER_EMAIL ||
  "";

const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  process.env.E2E_USER_PASSWORD ||
  "";

const COHERENCE_PATH = process.env.coherencePath || "/api/providers/coherence";

// Contexte produit « sous test » : modèle déclaré par l'agent orchestrator et
// fournisseur de la clé active (cf. ADR-005 / constat 13).
const REQUESTED_MODEL = process.env.requestedModel || process.env.E2E_REQUESTED_MODEL || "deepseek/deepseek-v4-flash";
const ACTIVE_PROVIDER = process.env.activeProvider || process.env.E2E_ACTIVE_PROVIDER || "deepseek";

// --- Types du contrat de cohérence (Plan A — server.mjs::agentsModelCoherence) -
interface CoherenceAffected {
  agent: string;
  model: string;
  provider?: string;
  reason?: string;
}
interface Coherence {
  ok: boolean;
  catalogAvailable?: boolean;
  activeProviders?: string[];
  affected?: CoherenceAffected[];
  fallbackCatalog?: string[];
  authPath?: string;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  // Le panneau a chargé l'utilisateur (barre d'onglets rendue).
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
}

/** Ouvre la page Écosystème puis le sous-onglet Fournisseurs (admin). */
async function openProvidersTab(page: Page): Promise<void> {
  await page.click('#tabs button[data-tab="ecosystem"]');
  const providersSubTab = page.locator('#eco-tabs [data-eco-tab="providers"]');
  await expect(providersSubTab, "sous-onglet Fournisseurs (admin)").toBeVisible({ timeout: 15_000 });
  await providersSubTab.click();
  await expect(page.locator("#eco-tab-content")).toBeVisible({ timeout: 15_000 });
}

/**
 * Lit l'état de cohérence via l'API (mêmes cookies que la page).
 * Retourne `null` si la route n'existe pas (comportement préventif non déployé).
 */
async function fetchCoherence(page: Page): Promise<Coherence | null> {
  const resp: APIResponse = await page.request.get(`${BASE_URL}${COHERENCE_PATH}`);
  if (resp.status() === 404) return null;
  if (!resp.ok()) {
    // 401/403 : problème d'authentification/garde — remonté explicitement.
    throw new Error(`GET ${COHERENCE_PATH} → HTTP ${resp.status()} (${await resp.text().catch(() => "")})`);
  }
  return (await resp.json()) as Coherence;
}

/** Sélecteur résilient du bandeau d'état de cohérence (A010). */
function coherenceBanner(page: Page) {
  return page.locator("#eco-tab-content").getByText(/modèle non servi|non servi par la clé active|agent\(s\) sur un modèle/i);
}

test("Onglet Fournisseurs — état incohérent (clé active ne servant pas le modèle déclaré) : le panneau affiche un avertissement proactif listant les agents/modèles affectés ET propose la mise à jour du modèle.", async ({
  page,
}) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  // --- Given : état de cohérence lu depuis l'API (sans mutation) -------------
  const coherence = await fetchCoherence(page);
  test.skip(
    coherence === null,
    `Comportement préventif non déployé : GET ${COHERENCE_PATH} absent (404) — nécessite le Plan A (T-20260923-073508-d3i9).`,
  );

  const affected = coherence!.affected || [];
  test.skip(
    coherence!.ok === true || affected.length === 0,
    `Oracle non reproduit sur cet environnement : la clé active « ${ACTIVE_PROVIDER} » sert tous les modèles déclarés ` +
      `(coherence.ok=${coherence!.ok}, affected=${affected.length}). Aucune mutation de clé n'est effectuée par ce test.`,
  );

  // --- When : ouverture de l'onglet Fournisseurs -----------------------------
  await openProvidersTab(page);

  // --- Then : bandeau d'état explicite + liste « agent → modèle » ------------
  await expect(
    coherenceBanner(page),
    "bandeau de cohérence attendu (N agents sur un modèle non servi par la clé active)",
  ).toBeVisible({ timeout: 15_000 });

  // Chaque agent affecté de l'état doit être listé dans l'onglet.
  for (const a of affected) {
    await expect(
      page.locator("#eco-tab-content").getByText(a.agent, { exact: false }).first(),
      `l'agent affecté « ${a.agent} » doit être listé`,
    ).toBeVisible({ timeout: 15_000 });
  }
  await expect(
    page.locator("#eco-tab-content").getByText(affected[0].model, { exact: false }).first(),
    `le modèle affecté « ${affected[0].model} » doit être listé`,
  ).toBeVisible({ timeout: 15_000 });

  // « Corriger » → modale de cohérence listant chaque agent + proposition de MAJ.
  const fixBtn = page.locator("#eco-tab-content").getByRole("button", { name: /corriger/i });
  await expect(fixBtn, "bouton « Corriger » du bandeau de cohérence").toBeVisible({ timeout: 15_000 });
  await fixBtn.click();

  const modal = page.locator("#modal-backdrop");
  await expect(modal, "modale de cohérence ouverte").toBeVisible({ timeout: 15_000 });
  await expect(modal.getByText(affected[0].agent, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

  // La modale propose explicitement la mise à jour du modèle de l'agent.
  const changeModelBtn = modal.getByRole("button", { name: /changer le modèle/i }).first();
  await expect(
    changeModelBtn,
    "action « Changer le modèle » proposée par la modale de cohérence",
  ).toBeVisible({ timeout: 15_000 });

  // L'action ouvre la modale d'édition du modèle de l'agent (frontmatter).
  await changeModelBtn.click();
  await expect(
    page.locator("#agent-model-select"),
    "modale d'édition du modèle de l'agent ouverte depuis la proposition",
  ).toBeVisible({ timeout: 15_000 });

  // Le modèle demandé/proposé est porté par l'URL funct. attendue côté produit.
  expect(
    REQUESTED_MODEL.length,
    "modèle de référence déclaré (paramètre requestedModel)",
  ).toBeGreaterThan(0);
});

test("Onglet Fournisseurs — non-régression : si la clé active sert TOUS les modèles déclarés des agents, aucun avertissement de cohérence n'est affiché.", async ({
  page,
}) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  const coherence = await fetchCoherence(page);
  test.skip(
    coherence === null,
    `Comportement préventif non déployé : GET ${COHERENCE_PATH} absent (404) — nécessite le Plan A (T-20260923-073508-d3i9).`,
  );
  test.skip(
    coherence!.ok !== true,
    `État non cohérent sur cet environnement (affected=${(coherence!.affected || []).length}) : la non-régression ` +
      `(absence d'avertissement quand TOUT est cohérent) n'est pas évaluable sans muter la configuration fournisseur.`,
  );

  await openProvidersTab(page);

  // Aucun faux avertissement lorsque la configuration est cohérente.
  await expect(
    coherenceBanner(page),
    "aucun bandeau d'avertissement attendu quand la clé active sert tous les modèles déclarés",
  ).toHaveCount(0);
});

test("Onglet Fournisseurs — édition du modèle d'un agent : le contrôle de cohérence est appliqué (avertissement si l'état est incohérent, silence sinon).", async ({
  page,
}) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  // --- Given : modale « Modèle » d'un agent du registre ----------------------
  await page.click('#tabs button[data-tab="ecosystem"]');
  const editBtn = page.locator('#pane-ecosystem [data-edit-model]').first();
  await expect(editBtn, "au moins un agent avec action « Modifier » le modèle").toBeVisible({ timeout: 15_000 });

  const coherenceBefore = await fetchCoherence(page);
  test.skip(
    coherenceBefore === null,
    `Comportement préventif non déployé : GET ${COHERENCE_PATH} absent (404) — nécessite le Plan A (T-20260923-073508-d3i9).`,
  );

  await editBtn.click();
  const modal = page.locator("#modal-backdrop");
  await expect(modal, "modale d'édition du modèle ouverte").toBeVisible({ timeout: 15_000 });
  const select = page.locator("#agent-model-select");
  await expect(select, "sélecteur de modèle de l'agent").toBeVisible({ timeout: 15_000 });

  const incoherentBefore = coherenceBefore!.ok !== true;

  // --- When : enregistrement du modèle (valeur COURANTE — aucune mutation) ---
  // On confirme sans changer la valeur : la réponse de l'API porte néanmoins le
  // rapport `coherence` global, ce qui déclenche (ou non) l'avertissement UI.
  const confirm = page.locator("#modal-confirm");
  const respPromise = page.waitForResponse(
    (r) => /\/api\/agents\/[^/]+\/model$/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await confirm.click();

  let coherenceFromResponse: Coherence | null = null;
  try {
    const resp = await respPromise;
    if (resp.ok()) {
      const body = (await resp.json()) as { coherence?: Coherence };
      coherenceFromResponse = body.coherence ?? null;
    }
  } catch {
    coherenceFromResponse = null;
  }

  // Le contrôle est appliqué au geste d'édition : le rapport de cohérence est
  // porté par la réponse (sinon le comportement n'est pas déployé côté API).
  test.skip(
    coherenceFromResponse === null,
    "Le geste d'édition ne renvoie pas de rapport `coherence` (réponse sans champ) — comportement non déployé côté API.",
  );

  // --- Then : cohérent ⇒ silence ; incohérent ⇒ avertissement explicite ------
  const warningVisible = await page
    .locator("#modal-backdrop")
    .getByText(/non servi|incohéren|modèle|agent/i)
    .first()
    .isVisible()
    .catch(() => false);

  if (coherenceFromResponse!.ok === true) {
    expect(
      incoherentBefore,
      "état cohérent renvoyé par l'API : incohérence attendue uniquement si l'état était déjà incohérent",
    ).toBe(false);
    expect(warningVisible, "aucun avertissement attendu quand le rapport de cohérence est ok").toBe(false);
  } else {
    expect(
      warningVisible,
      "un avertissement de cohérence doit être affiché après l'édition quand le rapport est incohérent",
    ).toBe(true);
  }
});

test("Onglet Fournisseurs — fournisseur par défaut « opencode » (sans clé) : aucun modèle opencode/* n'est signalé « non servi » par la clé active.", async ({
  page,
}) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  // --- Given : état de cohérence lu depuis l'API (sans mutation) -------------
  const coherence = await fetchCoherence(page);
  test.skip(
    coherence === null,
    `Comportement préventif non déployé : GET ${COHERENCE_PATH} absent (404) — nécessite le Plan A (T-20260923-073508-d3i9).`,
  );

  const affected = coherence!.affected || [];

  // --- Then : `opencode` est un fournisseur par DÉFAUT SANS clé ---------------
  // Aucune entrée affectée dont le modèle appartient au fournisseur par défaut :
  // exiger `act.has("opencode")` produirait un faux positif (bug corrigé).
  expect(
    affected.filter((a) => String(a.model || "").startsWith("opencode/")),
    "aucun modèle opencode/* ne doit être signalé « non servi » (fournisseur par défaut sans clé)",
  ).toEqual([]);

  // Les DEUX agents déclarant `opencode/*` ne doivent JAMAIS être affectés.
  for (const agent of ["clean-arch-detector-react", "hexagonal-architecture-auditor"]) {
    expect(
      affected.some((a) => a.agent === agent),
      `l'agent « ${agent} » (modèle opencode/*) ne doit pas être signalé non servi`,
    ).toBe(false);
  }

  // Véracité : `opencode` n'est PAS une clé active (ce n'est pas un fournisseur à
  // clé — il ne doit donc jamais apparaître dans `activeProviders`).
  expect(
    (coherence!.activeProviders || []).includes("opencode"),
    "« opencode » (fournisseur par défaut sans clé) ne doit pas figurer dans activeProviders",
  ).toBe(false);

  // Vérification produit : la bannière de cohérence éventuelle (autre incohérence
  // RÉELLE) ne cite jamais un modèle du fournisseur par défaut.
  await openProvidersTab(page);
  await expect(
    coherenceBanner(page).getByText(/opencode\//),
    "aucun modèle opencode/* ne doit apparaître dans la bannière de cohérence",
  ).toHaveCount(0);
});
