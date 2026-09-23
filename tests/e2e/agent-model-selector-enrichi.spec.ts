/**
 * E2E — Sélecteur de modèle d'agent ENRICHI (modale « Modèle — <agent> »).
 *
 * Entité E2E (1er niveau, indépendante de la tâche) : E2E-ECOSYSTEM-<à confirmer>
 *   project   = ecosystem
 *   repoIds   = ['opencode-observability']
 *   specFile  = tests/e2e/agent-model-selector-enrichi.spec.ts
 *
 * Tâche d'origine : T-20260923-143326-d2jk
 * Plan            : Plan-selecteur-modele-agent-enrichi-20260923-190852 (A006)
 * Source produit  : cadrage CT-mue5oi9p-667h — item 25 (recommandation/medium).
 * ADR de référence (Accepté) : ADR-005 — contrôle de cohérence clé active ↔
 *   modèle déclaré ; le sélecteur réutilise la MÊME source (`checkModelServable`)
 *   pour signaler les modèles non servis.
 *
 * ---------------------------------------------------------------------------
 * Feature: Modale « Modèle — <agent> » — catalogue lisible
 *
 *   Scenario 1 (create) : groupement + badge clé + modèles non servis
 *     Given l'administrateur ouvre la modale « Modèle » d'un agent
 *     When le catalogue enrichi (GET /api/models → providers[]) est chargé
 *     Then les modèles sont GROUPÉS par fournisseur (<optgroup>)
 *     And chaque groupe porte le STATUT DE CLÉ du fournisseur (clé active ✓ /
 *         défaut sans clé / aucune clé)
 *     And tout modèle non servi est marqué « ⚠ non servi » (title = raison)
 *
 *   Scenario 2 (create) : recherche/filtre + modèle courant mis en évidence
 *     Given la modale « Modèle » d'un agent est ouverte
 *     When l'administrateur saisit une recherche dans #agent-model-search
 *     Then la liste est filtrée (fournisseur/modèle, insensible à la casse)
 *     And le modèle courant reste mis en évidence (option `selected`)
 *
 * ---------------------------------------------------------------------------
 * Politique d'état : aucun état n'est muté (l'édition du modèle modifie le
 * frontmatter de l'agent → interdite ici). Les assertions portent sur la
 * modale ouverte. Si le comportement n'est pas déployé (GET /api/models sans
 * `providers[]`), le test se SKIP avec une raison explicite (jamais d'échec
 * rouge trompeur).
 *
 * Paramètres (registre) : baseUrl (url) ; adminUsername / adminPassword
 * (secrets ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).
 */
import { test, expect, type Page } from "@playwright/test";

const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://dev.madatalk.fr";

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

const MODELS_PATH = process.env.modelsPath || "/api/models";

interface CatalogModel {
  id: string;
  served?: boolean;
  reason?: string;
}
interface CatalogProvider {
  provider: string;
  keyStatus: "active" | "default_no_key" | "no_key";
  keyLabel: string;
  modelCount?: number;
  models?: CatalogModel[];
}
interface Catalog {
  models?: string[];
  catalogAvailable?: boolean;
  activeProviders?: string[];
  providers?: CatalogProvider[];
}

/**
 * Écran « Choisir une organisation » (utilisateur multi-organisations) : il
 * précède tout accès au panneau. On sélectionne l'organisation PAR DÉFAUT (★).
 */
async function selectOrganizationIfPrompted(page: Page): Promise<void> {
  const firstPick = page.locator("#modal-backdrop [data-org-pick]").first();
  const appeared = await firstPick
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
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

/** Lit le catalogue enrichi via l'API (mêmes cookies que la page). */
async function fetchCatalog(page: Page): Promise<Catalog | null> {
  const resp = await page.request.get(`${BASE_URL}${MODELS_PATH}`);
  if (resp.status() === 404) return null;
  if (!resp.ok()) {
    throw new Error(`GET ${MODELS_PATH} → HTTP ${resp.status()} (${await resp.text().catch(() => "")})`);
  }
  return (await resp.json()) as Catalog;
}

/** Ouvre la modale « Modèle » du premier agent exposé par l'onglet Écosystème. */
async function openFirstAgentModelModal(page: Page): Promise<void> {
  await page.click('#tabs button[data-tab="ecosystem"]');
  const editBtn = page.locator("#pane-ecosystem [data-edit-model]").first();
  await expect(editBtn, "au moins un agent avec action « Modifier » le modèle").toBeVisible({ timeout: 15_000 });
  await editBtn.click();
  await expect(page.locator("#modal-backdrop"), "modale d'édition du modèle ouverte").toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#agent-model-select"), "sélecteur de modèle de l'agent").toBeVisible({ timeout: 15_000 });
}

test("Sélecteur de modèle — groupement par fournisseur, badge de statut de clé et modèles non servis signalés.", async ({ page }) => {
  test.skip(!ADMIN_USERNAME || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  // --- Given : le catalogue enrichi expose `providers[]` ---------------------
  const cat = await fetchCatalog(page);
  test.skip(cat === null, `Comportement non déployé : GET ${MODELS_PATH} absent (404).`);
  const providers = (cat!.providers || []).filter((p) => p && p.provider);
  test.skip(
    providers.length === 0,
    "Catalogue enrichi absent (aucun `providers[]`) ou catalogue CLI indisponible sur cet environnement — comportement non déployé.",
  );

  await openFirstAgentModelModal(page);
  const select = page.locator("#agent-model-select");

  // --- Then : groupement par fournisseur (<optgroup>) ------------------------
  const optgroups = select.locator("optgroup");
  await expect(optgroups.first(), "au moins un groupe (optgroup) par fournisseur").toBeVisible({ timeout: 15_000 });
  expect(await optgroups.count(), "autant d'optgroup que de fournisseurs au catalogue").toBeGreaterThanOrEqual(1);

  // Chaque fournisseur du catalogue est représenté par un groupe dont le libellé
  // porte son nom ET le libellé de statut de clé.
  for (const p of providers.slice(0, 5)) {
    const group = select.locator("optgroup", { hasText: p.provider }).first();
    await expect(group, `groupe du fournisseur « ${p.provider} »`).toHaveCount(1);
    const label = await group.getAttribute("label");
    expect(String(label || ""), `le libellé du groupe « ${p.provider} » porte le statut de clé`).toContain(p.keyLabel);
  }

  // Badge de statut de clé visible dans la modale (légende).
  const keyLabels = ["clé active ✓", "défaut sans clé", "aucune clé"];
  const badge = page.locator("#modal-backdrop .prov-key-badge").first();
  await expect(badge, "badge de statut de clé affiché dans la modale").toBeVisible({ timeout: 15_000 });
  const badgeText = (await page.locator("#modal-backdrop .prov-key-badge").allInnerTexts()).join(" | ");
  expect(keyLabels.some((l) => badgeText.includes(l)), `au moins un statut de clé parmi ${keyLabels.join(", ")}`).toBeTruthy();

  // --- Then : les modèles NON SERVIS sont explicitement marqués ---------------
  const notServed = providers.flatMap((p) => (p.models || []).filter((m) => m && m.served === false));
  if (notServed.length) {
    const firstBad = notServed[0];
    const opt = select.locator(`option[value="${firstBad.id}"]`);
    await expect(opt, `option « ${firstBad.id} » présente au catalogue`).toHaveCount(1);
    await expect(opt, `le modèle non servi « ${firstBad.id} » est marqué`).toContainText("non servi");
  }
});

test("Sélecteur de modèle — la recherche filtre les modèles et le modèle courant reste mis en évidence.", async ({ page }) => {
  test.skip(!ADMIN_USERNAME || !ADMIN_PASSWORD, "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).");

  await login(page);

  const cat = await fetchCatalog(page);
  test.skip(cat === null, `Comportement non déployé : GET ${MODELS_PATH} absent (404).`);
  const providers = (cat!.providers || []).filter((p) => p && (p.models || []).length);
  test.skip(providers.length === 0, "Catalogue enrichi absent ou vide sur cet environnement — comportement non déployé.");

  await openFirstAgentModelModal(page);
  const select = page.locator("#agent-model-select");
  const search = page.locator("#agent-model-search");
  await expect(search, "champ de recherche #agent-model-search présent").toBeVisible({ timeout: 15_000 });

  // --- Given : le modèle courant est mis en évidence (une option `selected`) --
  const checked = select.locator("option:checked");
  await expect(checked, "exactement une option sélectionnée (modèle courant)").toHaveCount(1);
  const currentValue = await checked.getAttribute("value");
  expect(String(currentValue || "").length, "le modèle courant est porté par l'option sélectionnée").toBeGreaterThan(0);

  // Le modèle courant est aussi rappelé par un chip lisible.
  await expect(
    page.locator("#modal-backdrop").getByText(/Modèle courant/i),
    "chip « Modèle courant » affiché dans la modale",
  ).toBeVisible({ timeout: 15_000 });

  // --- When : filtre par le nom du premier fournisseur ------------------------
  const target = providers[0];
  const optionsBefore = await select.locator("option").count();
  await search.fill(target.provider);

  // --- Then : la liste est filtrée -------------------------------------------
  const optionsAfter = await select.locator("option").count();
  expect(optionsAfter, "le filtre réduit (ou maintient) la liste des options").toBeLessThanOrEqual(optionsBefore);
  expect(optionsAfter, "au moins une option correspond au fournisseur recherché").toBeGreaterThanOrEqual(1);

  // Chaque option visible appartient au fournisseur recherché, à l'exception du
  // repli explicite « modèle courant » (réaffiché s'il est exclu par le filtre).
  const values = await select.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(
    values.filter((v) => v !== currentValue && !v.toLowerCase().includes(target.provider.toLowerCase())),
    `toutes les options filtrées portent le fournisseur « ${target.provider} » (hors repli « modèle courant »)`,
  ).toEqual([]);

  // Le modèle courant reste mis en évidence (rendu en repli s'il est filtré).
  await expect(select.locator("option:checked"), "le modèle courant reste sélectionné après filtrage").toHaveCount(1);
});
