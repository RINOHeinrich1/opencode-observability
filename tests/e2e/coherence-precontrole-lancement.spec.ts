/**
 * E2E — Pré-contrôle de cohérence « clé active fournisseur ↔ modèles déclarés
 * des agents » rendu VISIBLE AU POINT DE LANCEMENT (carte/détail d'un cadrage
 * ou d'un batch, à côté du bouton « Lancer la session d'orchestration »).
 *
 * Entités E2E (1er niveau, indépendantes de la tâche) :
 *   - « Badge + accès direct à la correction au point de lancement »
 *   - « Non-régression : aucun badge quand la clé active sert tous les modèles »
 *   project  = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/coherence-precontrole-lancement.spec.ts
 *
 * Tâche d'origine : T-20260923-143326-phkw
 *   (Plan Plan-coherence-precontrole-lancement-20260923-182823, item de recette
 *    CT-mue5oi9p-667h — recommandation médium « surface du garde-fou proactif »)
 * ADR de référence (Accepté) : ADR-005 — « Sélection des modèles d'exécution des
 *   sessions du panneau (cohérence clé active fournisseur ↔ frontmatter des
 *   agents) », volet (a) : contrôle PRÉVENTIF et NON bloquant, avec repli sans
 *   faux blocage quand le catalogue est indisponible (`catalogAvailable:false`).
 *
 * ---------------------------------------------------------------------------
 * Feature: Pré-contrôle de cohérence au point de lancement (cadrage / batch)
 *
 *   Scenario 1 (oracle) : le pré-contrôle cesse d'être confiné à « Fournisseurs »
 *     Given l'administrateur ouvre le projet puis l'onglet « Cadrage technique »
 *     And la clé active d'un fournisseur ne sert PAS le modèle déclaré d'au moins
 *         un agent (état lu via GET /api/providers/coherence)
 *     When le panneau rend les cartes de cadrage et de batch (et leurs détails)
 *     Then un badge « ⚠ N agent(s) sur un modèle non servi » est affiché sur la
 *          carte du batch ET sur celle du cadrage, à côté du bouton de lancement
 *     And le détail du cadrage et celui du batch affichent le même badge,
 *         le badge du batch étant placé AU-DESSUS du bouton de lancement
 *     And le bouton « Corriger » du badge ouvre la modale de cohérence en mode
 *         PRÉ-LANCEMENT (« Avant le lancement de la session, … »)
 *     And la modale propose « Changer le modèle » → modale d'édition du modèle
 *         (accès direct à la correction)
 *
 *   Scenario 2 (non-régression) : état cohérent → AUCUN faux blocage visuel
 *     Given la clé active sert TOUS les modèles déclarés des agents
 *     When l'administrateur ouvre l'onglet « Cadrage technique »
 *     Then AUCUN badge « modèle non servi » n'est affiché sur les cartes
 *          (jamais de faux positif — ADR-005 : non bloquant)
 * ---------------------------------------------------------------------------
 *
 * Non-régression couverte par des specs VOISINS (inchangés, `providerCoherenceBanner`
 * et le chemin réactif `showSessionModelError` ne sont pas refactorés) :
 *   - tests/e2e/ecosystem-fournisseurs-coherence.spec.ts (E2E-ECOSYSTEM-mv8foy, jsottp)
 *   - tests/e2e/batches-session-lancement.spec.ts        (E2E-ECOSYSTEM-1k47rxo)
 *
 * Politique d'état non reproduit : le spec DÉTECTE l'état via
 * `GET /api/providers/coherence` (JAMAIS de mutation réelle de la clé
 * fournisseur — l'activation d'une clé régénère `auth.json` et REDÉMARRE toutes
 * les instances opencode : interdite ici). Si l'état requis n'est pas
 * reproductible (cohérence OK), le test se SKIP avec une raison explicite —
 * jamais d'échec rouge trompeur, jamais de faux vert.
 *
 * Paramètres (déclarés au registre sur les entités ; surchargeables au run) :
 *   - baseUrl        (url)     défaut https://orchestrator.madatalk.fr — env E2E_BASE_URL
 *   - adminUsername  (secret)  ref    ECOSYSTEM_E2E_ADMIN_USERNAME
 *   - adminPassword  (secret)  ref    ECOSYSTEM_E2E_ADMIN_PASSWORD
 *   - coherencePath  (string)  défaut /api/providers/coherence
 */
import { test, expect, type Page, type APIResponse } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set des entités du spec) ----------------
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://orchestrator.madatalk.fr";

const ADMIN_USERNAME =
  process.env.ECOSYSTEM_E2E_ADMIN_USERNAME ||
  process.env.adminUsername ||
  process.env.E2E_USER_USERNAME ||
  "";

const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  process.env.E2E_USER_PASSWORD ||
  "";

const COHERENCE_PATH = process.env.coherencePath || "/api/providers/coherence";

// --- Types du contrat de cohérence (server.mjs::agentsModelCoherence) -------
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

/**
 * Écran « Choisir une organisation » (utilisateur multi-organisations sans
 * organisation active) : il précède tout accès au panneau et intercepte les
 * clics tant qu'aucune org n'est choisie. On sélectionne l'organisation PAR
 * DÉFAUT (★) — périmètre du projet testé.
 */
async function selectOrganizationIfPrompted(page: Page): Promise<void> {
  const firstPick = page.locator("#modal-backdrop [data-org-pick]").first();
  const appeared = await firstPick
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return; // utilisateur mono-organisation : aucun écran de choix
  const star = page.locator("#modal-backdrop [data-org-pick]", { hasText: "★" }).first();
  const button = (await star.count()) ? star : firstPick;
  await button.click();
  await expect(page.locator("#modal-backdrop")).toBeHidden({ timeout: 15_000 });
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", ADMIN_USERNAME);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
  await selectOrganizationIfPrompted(page);
}

/**
 * Lit l'état de cohérence via l'API (mêmes cookies que la page).
 * `null` si la route n'existe pas (comportement non déployé).
 */
async function fetchCoherence(page: Page): Promise<Coherence | null> {
  const resp: APIResponse = await page.request.get(`${BASE_URL}${COHERENCE_PATH}`);
  if (resp.status() === 404) return null;
  if (!resp.ok()) {
    throw new Error(
      `GET ${COHERENCE_PATH} → HTTP ${resp.status()} (${await resp.text().catch(() => "")})`,
    );
  }
  return (await resp.json()) as Coherence;
}

/** Ouvre un projet (idempotent : le bouton peut déjà avoir été consommé). */
async function openProject(page: Page, project: string): Promise<void> {
  const btn = page.locator(`button[data-open-project="${project}"]`);
  if (await btn.count()) {
    await btn.first().click();
  }
}

/** Ouvre l'onglet « Cadrage technique » (rend cartes de cadrage + batches actifs). */
async function openCadragesTab(page: Page): Promise<void> {
  await page.click('#tabs button[data-tab="cadrages"]');
  await expect(page.locator("#pane-cadrages"), "panneau Cadrage technique").toBeVisible({
    timeout: 15_000,
  });
}

/** Le badge de pré-contrôle « modèle non servi » (classe posée par A002). */
function launchBadge(page: Page) {
  return page.locator(".coh-launch-badge");
}

test("Cadrage technique — état incohérent (clé active ne servant pas le modèle déclaré) : un badge « modèle non servi » + accès direct à la correction est visible sur la carte ET le détail d'un cadrage et d'un batch, à côté du bouton de lancement de la session d'orchestration.", async ({
  page,
}) => {
  test.skip(
    !ADMIN_USERNAME || !ADMIN_PASSWORD,
    "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page);

  // --- Given : état de cohérence lu depuis l'API (sans mutation) --------------
  const coherence = await fetchCoherence(page);
  test.skip(
    coherence === null,
    `Comportement non déployé : GET ${COHERENCE_PATH} absent (404).`,
  );

  const affected = coherence!.affected || [];
  test.skip(
    coherence!.ok === true || affected.length === 0,
    `Oracle non reproduit sur cet environnement : la clé active sert tous les modèles déclarés ` +
      `(coherence.ok=${coherence!.ok}, affected=${affected.length}). ` +
      "Aucune mutation de clé fournisseur n'est effectuée par ce test (activation = régénération " +
      "d'auth.json + redémarrage des instances opencode, interdite en E2E).",
  );

  // --- Given : un projet portant cadrages et/ou batch actif -------------------
  const batchesResp = await page.request.get(`${BASE_URL}/api/batches`);
  expect(batchesResp.ok(), "GET /api/batches doit répondre 200").toBeTruthy();
  const { batches = [] } = (await batchesResp.json()) as {
    batches?: Array<{ batchId: string; project: string; status: string; launchMode: string }>;
  };
  const launchable = batches.filter(
    (b) => b.status === "active" && (b.launchMode === "session" || b.launchMode === "batch"),
  );
  const batch = launchable[0];

  // Le projet de référence : celui du batch, sinon le projet courant du panneau.
  const projectsResp = await page.request.get(`${BASE_URL}/api/projects`);
  const projects = projectsResp.ok()
    ? ((await projectsResp.json()) as { projects?: Array<{ id: string }> }).projects || []
    : [];
  const projectId = batch?.project || projects[0]?.id || "";
  expect(projectId, "un projet est nécessaire pour rendre les cartes de cadrage").toBeTruthy();

  await openProject(page, projectId);
  await openCadragesTab(page);

  // --- Then (1) : badge sur la CARTE de cadrage, près du bouton de lancement --
  const cadrageCards = page.locator("#pane-cadrages article.project-card").filter({
    has: page.locator("[data-rec-detail]"),
  });
  const cadrageCardCount = await cadrageCards.count();
  if (cadrageCardCount > 0) {
    const card = cadrageCards.first();
    const cardBadge = card.locator(".coh-launch-badge");
    await expect(cardBadge, "badge « modèle non servi » sur la carte du cadrage").toBeVisible({
      timeout: 15_000,
    });
    await expect(cardBadge).toContainText(/modèle non servi/i);
    // Le badge est ancré au point de lancement de la session du cadrage.
    await expect(
      card.locator("[data-rec-session]"),
      "bouton de session du cadrage présent dans la même carte que le badge",
    ).toHaveCount(1);
    // Ancrage tracé : le badge sait d'où il vient (source `cadrage-card`).
    await expect(cardBadge.locator("[data-coh-launch]")).toHaveAttribute(
      "data-coh-source",
      "cadrage-card",
    );
  } else {
    test.info().annotations.push({
      type: "note",
      description: `Aucun cadrage dans le projet « ${projectId} » : couverture carte cadrage non évaluable sur cet environnement.`,
    });
  }

  // --- Then (2) : badge sur la CARTE de batch, près du bouton de lancement ----
  if (batch) {
    const card = page
      .locator("#pane-cadrages article.project-card")
      .filter({ has: page.locator(`[data-batch-session="${batch.batchId}"]`) });
    await expect(card, `carte du batch ${batch.batchId}`).toHaveCount(1);
    const cardBadge = card.locator(".coh-launch-badge");
    await expect(
      cardBadge,
      "badge « modèle non servi » sur la carte du batch, à côté du bouton de lancement",
    ).toBeVisible({ timeout: 15_000 });
    await expect(cardBadge.locator("[data-coh-launch]")).toHaveAttribute(
      "data-coh-source",
      "batch-card",
    );

    // « Corriger » (carte batch) → modale de cohérence en mode PRÉ-LANCEMENT.
    await cardBadge.locator("[data-coh-launch]").click();
    const modal = page.locator("#modal-backdrop");
    await expect(modal, "modale de cohérence ouverte depuis la carte batch").toBeVisible({
      timeout: 15_000,
    });
    await expect(modal.getByText(/avant le lancement de la session/i)).toBeVisible({
      timeout: 15_000,
    });
    // Accès direct à la correction : « Changer le modèle » → édition du modèle.
    const changeModelBtn = modal.getByRole("button", { name: /changer le modèle/i }).first();
    await expect(
      changeModelBtn,
      "action « Changer le modèle » proposée par la modale de cohérence",
    ).toBeVisible({ timeout: 15_000 });
    await changeModelBtn.click();
    await expect(
      page.locator("#agent-model-select"),
      "modale d'édition du modèle de l'agent ouverte depuis le badge",
    ).toBeVisible({ timeout: 15_000 });
    await page.locator("#modal-cancel").click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
  } else {
    test.info().annotations.push({
      type: "note",
      description:
        "Aucun batch actif en mode « session »/« batch » à lancer : couverture carte/détail batch non évaluable sur cet environnement.",
    });
  }

  // --- Then (3) : badge dans le DÉTAIL d'un cadrage ---------------------------
  const detailTrigger = page.locator("#pane-cadrages [data-rec-detail]").first();
  if (await detailTrigger.count()) {
    await detailTrigger.click();
    const detailModal = page.locator("#cadrage-detail-modal");
    await expect(detailModal, "modale de détail du cadrage").toBeVisible({ timeout: 15_000 });
    const detailBadge = detailModal.locator(".coh-launch-badge");
    await expect(detailBadge, "badge « modèle non servi » dans le détail du cadrage").toBeVisible({
      timeout: 15_000,
    });
    await expect(detailBadge.locator("[data-coh-launch]")).toHaveAttribute(
      "data-coh-source",
      "cadrage-detail",
    );
    await page.locator("#modal-cancel").click();
    await expect(detailModal).toBeHidden({ timeout: 15_000 });
  }

  // --- Then (4) : badge dans le DÉTAIL d'un batch, AU-DESSUS du lancement -----
  if (batch) {
    await page
      .locator(`#pane-cadrages article.project-card`)
      .filter({ has: page.locator(`[data-batch-detail="${batch.batchId}"]`) })
      .locator("[data-batch-detail]")
      .first()
      .click();
    const modal = page.locator("#modal-backdrop");
    await expect(modal, "modale de détail du batch").toBeVisible({ timeout: 15_000 });
    const launchBtn = modal.locator("#batch-modal-session");
    await expect(launchBtn, "bouton de lancement de la session d'orchestration (détail batch)").toBeVisible({
      timeout: 15_000,
    });
    const detailBadge = modal.locator(".coh-launch-badge");
    await expect(detailBadge, "badge « modèle non servi » dans le détail du batch").toBeVisible({
      timeout: 15_000,
    });
    await expect(detailBadge.locator("[data-coh-launch]")).toHaveAttribute(
      "data-coh-source",
      "batch-detail",
    );
    // Ancrage exigé : badge rendu AU-DESSUS du bouton de lancement.
    const badgeAboveLaunch = await detailBadge.evaluate((badgeEl, sel) => {
      const btn = badgeEl.parentElement?.querySelector(sel);
      if (!btn) return false;
      return (
        badgeEl.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING
      ) !== 0;
    }, "#batch-modal-session");
    expect(
      badgeAboveLaunch,
      "le badge de pré-contrôle doit précéder (au-dessus de) le bouton de lancement de la session",
    ).toBe(true);
  }
});

test("Cadrage technique — non-régression : si la clé active sert TOUS les modèles déclarés des agents, AUCUN badge « modèle non servi » n'est affiché au point de lancement (pas de faux blocage).", async ({
  page,
}) => {
  test.skip(
    !ADMIN_USERNAME || !ADMIN_PASSWORD,
    "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page);

  // --- Given : état cohérent exigé (sinon le scénario n'est pas évaluable) ----
  const coherence = await fetchCoherence(page);
  test.skip(
    coherence === null,
    `Comportement non déployé : GET ${COHERENCE_PATH} absent (404).`,
  );
  test.skip(
    coherence!.ok !== true,
    `État non cohérent sur cet environnement (affected=${(coherence!.affected || []).length}) : ` +
      "la non-régression (absence de badge quand TOUT est cohérent) n'est pas évaluable sans " +
      "muter la configuration fournisseur (interdite en E2E).",
  );

  // --- When : rendu des points de lancement -----------------------------------
  const projectsResp = await page.request.get(`${BASE_URL}/api/projects`);
  const projects = projectsResp.ok()
    ? ((await projectsResp.json()) as { projects?: Array<{ id: string }> }).projects || []
    : [];
  if (projects[0]?.id) await openProject(page, projects[0].id);
  await openCadragesTab(page);

  // --- Then : aucun badge, aucun faux blocage ---------------------------------
  await expect(
    launchBadge(page),
    "aucun badge « modèle non servi » attendu quand la clé active sert tous les modèles déclarés",
  ).toHaveCount(0);
});
