/**
 * E2E — Sélecteurs multiples (cadrage/recette) : option « tout sélectionner /
 * tout désélectionner » SUR LES ÉLÉMENTS FILTRÉS.
 *
 * Entité E2E (1er niveau) :
 *   - E2E-ECOSYSTEM-<id> : bouton `.adr-pick-all` présent dans les 3 sélecteurs
 *     (ADR, Fonctionnalités/Règles, Éléments de recette « à traiter ») ; la
 *     bascule n'agit QUE sur les lignes VISIBLES (`row.hidden === false`), les
 *     lignes masquées par le filtre restent INCHANGÉES ; le libellé du bouton
 *     reflète la sélection des visibles ; le compteur visible / total est préservé.
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/selecteurs-multiples-tout-selectionner.spec.ts
 *
 * Source : tâche T-20260924-060147-k955, plan
 * Plan-selecteurs-multiples-tout-selectionner-20260924-060238 (A005).
 *
 * ---------------------------------------------------------------------------
 * Feature: « tout sélectionner / tout désélectionner » sur les sélecteurs multiples
 *
 *   Scenario: Bascule en masse limitée aux éléments filtrés (ADR)
 *     Given je suis administrateur, un projet est ouvert et j'ouvre le cadrage technique
 *     When le sélecteur ADR affiche des lignes
 *     Then un bouton « tout sélectionner / tout désélectionner » est présent
 *     And son libellé reflète la sélection courante des lignes visibles
 *     And un clic ne coche/décoche QUE les lignes visibles (les masquées sont inchangées)
 *     And le compteur visible / total reste cohérent
 *
 *   Scenario: Bascule en masse limitée aux éléments filtrés (Fonctionnalités / Règles / Éléments de recette)
 *     Given les sélecteurs Fonctionnalités, Règles métier et Éléments de recette sont peuplés
 *     Then chacun expose le bouton et se comporte de la même façon sur les visibles
 * ---------------------------------------------------------------------------
 *
 * Paramètres (déclarés au registre ; surchargeables au run) :
 *   - baseUrl        (url)      défaut https://dev.madatalk.fr — env E2E_BASE_URL
 *   - adminUsername  (variable) ref ECOSYSTEM_E2E_ADMIN_USERNAME
 *   - adminPassword  (secret)   ref ECOSYSTEM_E2E_ADMIN_PASSWORD
 *
 * NOTE : l'exécution (run) suppose le code fusionné ET déployé (dérogation
 * manuelle post-review). Sans identifiants admin, le test est SKIPPÉ
 * explicitement — jamais de faux vert.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://dev.madatalk.fr";

const ADMIN_USERNAME =
  process.env.ECOSYSTEM_E2E_ADMIN_USERNAME ||
  process.env.adminUsername ||
  process.env.ECOSYSTEM_E2E_ADMIN_EMAIL ||
  process.env.adminEmail ||
  process.env.E2E_USER_EMAIL ||
  "";

const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  process.env.E2E_USER_PASSWORD ||
  "";

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
}

/** Ouvre le premier projet listé (si nécessaire) puis l'onglet « Cadrage technique ». */
async function openFirstProjectCadragesTab(page: Page): Promise<void> {
  const openBtn = page.locator("[data-open-project]").first();
  if ((await openBtn.count()) > 0) {
    await openBtn.click();
    await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
  }
  await page.click('#tabs button[data-tab="cadrages"]');
  await expect(page.locator("#pane-cadrages")).toBeVisible({ timeout: 15_000 });
}

const VISIBLE_ROWS = ".adr-pick-row:not([hidden])";
const HIDDEN_ROWS = ".adr-pick-row[hidden]";

/** Nombre de cases cochées parmi les lignes VISIBLES d'un sélecteur. */
function checkedVisible(scope: Locator): Promise<number> {
  return scope.locator(`${VISIBLE_ROWS} input[type=checkbox]:checked`).count();
}

/** Nombre de cases cochées parmi les lignes MASQUÉES d'un sélecteur. */
function checkedHidden(scope: Locator): Promise<number> {
  return scope.locator(`${HIDDEN_ROWS} input[type=checkbox]:checked`).count();
}

/**
 * Vérifie le comportement « tout sélectionner / tout désélectionner » d'un
 * sélecteur `.adr-pick` : présent, libellé cohérent, action limitée aux
 * VISIBLES, masquées inchangées, compteur préservé.
 */
async function exerciseBulk(page: Page, scopeSel: string, name: string): Promise<void> {
  const scope = page.locator(scopeSel);
  const btn = scope.locator(".adr-pick-all");
  const rows = scope.locator(".adr-pick-row");
  const countEl = scope.locator(".adr-pick-count");

  await expect(btn, `${name} : le bouton « tout sélectionner / tout désélectionner » est présent`).toHaveCount(1);

  const total = await rows.count();

  // -- État initial : libellé cohérent avec la sélection des VISIBLES --------
  let nVisible = await scope.locator(VISIBLE_ROWS).count();
  let nCheckedVisible = await checkedVisible(scope);
  await expect(
    btn,
    `${name} : libellé initial cohérent avec la sélection des visibles`,
  ).toHaveText(nVisible > 0 && nCheckedVisible === nVisible ? "Tout désélectionner" : "Tout sélectionner");

  // -- Filtre : restreindre à un sous-ensemble visible (lignes masquées) -----
  const search = scope.locator(".adr-pick-search");
  const q = (await rows.first().getAttribute("data-search")) || "";
  if ((await search.count()) > 0 && q) {
    await search.fill(q);
    await expect
      .poll(() => scope.locator(VISIBLE_ROWS).count(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
  }
  nVisible = await scope.locator(VISIBLE_ROWS).count();
  const nHidden = total - nVisible;
  const hiddenCheckedBefore = await checkedHidden(scope);

  // -- Compteur visible / total préservé et cohérent -------------------------
  if ((await countEl.count()) > 0) {
    const txt = ((await countEl.textContent()) || "").trim();
    expect(txt.startsWith(`${nVisible} / ${total}`), `${name} : compteur « ${nVisible} / ${total} » (lu: « ${txt} »)`).toBeTruthy();
  }

  // -- Bascule : n'agit QUE sur les visibles --------------------------------
  const makeChecked = (((await btn.textContent()) || "").includes("Tout sélectionner"));
  const visibleBoxes = scope.locator(`${VISIBLE_ROWS} input[type=checkbox]`);
  await btn.click();

  const statesAfter = await visibleBoxes.evaluateAll((bx) => bx.map((b) => (b as HTMLInputElement).checked));
  expect(statesAfter.length, `${name} : nombre de cases visibles`).toBe(nVisible);
  expect(
    statesAfter.every((c) => c === makeChecked),
    `${name} : toutes les lignes VISIBLES basculent dans l'état cible`,
  ).toBeTruthy();
  expect(
    await checkedHidden(scope),
    `${name} : les lignes MASQUÉES ne sont JAMAIS touchées (1er clic)`,
  ).toBe(hiddenCheckedBefore);

  await expect(
    btn,
    `${name} : libellé après bascule`,
  ).toHaveText(nVisible > 0 && makeChecked ? "Tout désélectionner" : "Tout sélectionner");

  // -- 2e clic : bascule inverse, masquées toujours inchangées ---------------
  await btn.click();
  const statesBack = await visibleBoxes.evaluateAll((bx) => bx.map((b) => (b as HTMLInputElement).checked));
  expect(
    statesBack.every((c) => c === !makeChecked),
    `${name} : le 2e clic inverse l'état des VISIBLES`,
  ).toBeTruthy();
  expect(
    await checkedHidden(scope),
    `${name} : les lignes MASQUÉES sont toujours inchangées (2e clic)`,
  ).toBe(hiddenCheckedBefore);
  await expect(btn, `${name} : libellé après 2e clic`).toHaveText("Tout sélectionner");

  // -- Compteur toujours cohérent après les bascules ------------------------
  if ((await countEl.count()) > 0) {
    const txt = ((await countEl.textContent()) || "").trim();
    expect(txt.startsWith(`${nVisible} / ${total}`), `${name} : compteur inchangé après bascules`).toBeTruthy();
  }
}

test("Sélecteurs multiples du cadrage : option « tout sélectionner / tout désélectionner » limitée aux éléments FILTRÉS (visibles).", async ({
  page,
}) => {
  test.skip(
    !ADMIN_USERNAME || !ADMIN_PASSWORD,
    "Identifiants admin E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await openFirstProjectCadragesTab(page);

  // Ouvre la modale de création de cadrage (contient les 3 sélecteurs multiples).
  await page.click("#new-cadrage-btn");
  await expect(page.locator("#modal-backdrop .modal")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("#rm-adr-fieldset .adr-pick"),
    "le sélecteur ADR doit être rendu",
  ).toBeVisible({ timeout: 15_000 });

  const scopes: Array<{ sel: string; name: string }> = [
    { sel: "#rm-adr-fieldset .adr-pick", name: "ADR" },
    { sel: "#rm-feature-fieldset .adr-pick", name: "Fonctionnalités" },
    { sel: "#rm-rule-fieldset .adr-pick", name: "Règles métier" },
    { sel: "#rm-eval-item-fieldset .adr-pick", name: "Éléments de recette" },
  ];

  let tested = 0;
  for (const s of scopes) {
    if ((await page.locator(s.sel).count()) === 0) continue; // fieldset absent (rôle)
    if ((await page.locator(`${s.sel} .adr-pick-row`).count()) === 0) continue; // aucune ligne
    await exerciseBulk(page, s.sel, s.name);
    tested++;
  }

  expect(
    tested,
    "au moins un sélecteur multiple peuplé doit avoir été vérifié (ADR / Fonctionnalités / Règles / Éléments de recette)",
  ).toBeGreaterThan(0);
});
