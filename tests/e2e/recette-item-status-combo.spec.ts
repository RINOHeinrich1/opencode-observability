/**
 * E2E — Statut de suivi d'un élément de recette : COMBO modifiable
 * (ouvert | traité | écarté) émettant `PATCH /api/recettes/:id/items/:itemId`
 * `{ status }`, aux côtés du combo de DÉCISION ADMIN (lecture seule hors admin).
 *
 * Entité E2E (1er niveau) :
 *   - E2E-ECOSYSTEM-… : combo statut 3 valeurs + PATCH au changement +
 *     rafraîchissement de la modale ; les DEUX combos sont sur la même ligne
 *     dans `.eval-item-foot` avec labels en majuscules ; compteurs « À traiter
 *     (visible exécuteur) / Traités / Total » + légende des deux axes.
 *   - Scénario non-admin : décision en LECTURE SEULE (`.readonly-note`),
 *     aucun combo de décision.
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/recette-item-status-combo.spec.ts
 *
 * Source : maquette RECT-mudv60ay-niqy (éléments de recette — deux combos),
 * tâche T-20260924-054723-187s, plan
 * Plan-recette-elements-combos-20260924-054847 (A009). Justif. ADR-001/002/003.
 *
 * ---------------------------------------------------------------------------
 * Feature: Statut de suivi d'un élément de recette en combo modifiable
 *
 *   Scenario: L'admin/évaluateur change le statut via un combo à 3 valeurs
 *     Given je suis administrateur et qu'une recette possède au moins un élément
 *     When j'ouvre le détail de la recette
 *     Then la ligne expose DEUX combos sur la même ligne (.eval-item-foot)
 *          — décision admin (select data-eval-item-decision) et statut de suivi
 *          (select data-eval-item-status) — chacun précédé d'un label en majuscules
 *     And le combo statut a les valeurs « ouvert », « traité », « écarté »
 *     And les compteurs « À traiter (visible exécuteur) », « Traités », « Total »
 *          et la légende des deux axes sont affichés
 *     When je sélectionne un nouveau statut
 *     Then un PATCH est émis sur /api/recettes/:id/items/:itemId avec { status }
 *     And la modale est rafraîchie et reflète la nouvelle valeur
 *     And AUCUN POST …/items/:itemId/decision n'est émis (axes distincts)
 *
 *   Scenario: Hors admin, la décision est en lecture seule
 *     Given je ne suis pas administrateur
 *     When j'ouvre la ligne d'un élément de recette
 *     Then aucun combo de décision admin n'est affiché
 *     And la décision est affichée en lecture seule (.readonly-note)
 * ---------------------------------------------------------------------------
 *
 * Paramètres (déclarés au registre ; surchargeables au run) :
 *   - baseUrl        (url)     défaut https://dev.madatalk.fr — env E2E_BASE_URL
 *   - adminUsername  (variable) ref ECOSYSTEM_E2E_ADMIN_USERNAME
 *   - adminPassword  (secret)   ref ECOSYSTEM_E2E_ADMIN_PASSWORD
 *   - userUsername   (variable) ref ECOSYSTEM_E2E_USER_USERNAME (scénario non-admin ; skip si absent)
 *   - userPassword   (secret)   ref ECOSYSTEM_E2E_USER_PASSWORD (skip si absent)
 *
 * Le scénario non-admin se SKIPPE explicitement si aucun compte non-admin n'est
 * provisionné — jamais de faux vert.
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
  process.env.ECOSYSTEM_E2E_ADMIN_EMAIL ||
  process.env.adminEmail ||
  process.env.E2E_USER_EMAIL ||
  "";

const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  process.env.E2E_USER_PASSWORD ||
  "";

const USER_USERNAME =
  process.env.ECOSYSTEM_E2E_USER_USERNAME ||
  process.env.userUsername ||
  process.env.ECOSYSTEM_E2E_NONADMIN_USERNAME ||
  "";

const USER_PASSWORD =
  process.env.ECOSYSTEM_E2E_USER_PASSWORD ||
  process.env.userPassword ||
  process.env.ECOSYSTEM_E2E_NONADMIN_PASSWORD ||
  "";

// Libellés attendus (source : EVAL_ITEM_STATUS_LABELS dans public/app.js).
const STATUS_LABELS: Record<string, string> = {
  open: "ouvert",
  treated: "traité",
  dismissed: "écarté",
};

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

/** Ouvre le premier projet listé puis l'onglet « Recette » (recettes). */
async function openFirstProjectRecettesTab(page: Page): Promise<void> {
  const openBtn = page.locator("[data-open-project]").first();
  await expect(openBtn, "au moins un projet est listé").toBeVisible({ timeout: 15_000 });
  await openBtn.click();
  await page.click('#tabs button[data-tab="recettes"]');
  await expect(page.locator("#pane-recettes")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#pane-recettes")).toContainText("Recette", { timeout: 15_000 });
}

/** Ouvre le détail de la première recette. Retourne false si aucune recette. */
async function openFirstRecetteDetail(page: Page): Promise<boolean> {
  const detail = page.locator("#pane-recettes [data-eval-detail]").first();
  if ((await detail.count()) === 0) return false;
  await detail.click();
  await expect(page.locator("#modal-backdrop .modal")).toBeVisible({ timeout: 15_000 });
  return true;
}

test("Recette : le statut de suivi d'un élément est un combo à 3 valeurs qui émet un PATCH, à côté du combo de décision ; compteurs et légende affichés.", async ({
  page,
}) => {
  test.skip(
    !ADMIN_USERNAME || !ADMIN_PASSWORD,
    "Identifiants admin E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  // Trace réseau : le changement de STATUT doit passer par PATCH …/items/:itemId
  // et ne JAMAIS toucher la route de décision admin.
  const requests: Array<{ method: string; url: string }> = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url() }));

  await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await openFirstProjectRecettesTab(page);
  const hasRecette = await openFirstRecetteDetail(page);
  test.skip(!hasRecette, "Aucune recette disponible dans le premier projet (rien à vérifier).");

  const modal = page.locator("#modal-backdrop");
  const item = modal.locator(".eval-item").first();
  const hasItem = (await item.count()) > 0;
  test.skip(!hasItem, "La recette ouverte ne contient aucun élément (rien à vérifier).");
  await expect(item).toBeVisible();

  // --- Then (A004/A007) : compteurs + légende ---------------------------------
  await expect(modal.locator(".eval-strip .stat"), "3 compteurs attendus").toHaveCount(3);
  await expect(modal.locator(".eval-strip")).toContainText("À traiter (visible exécuteur)");
  await expect(modal.locator(".eval-strip")).toContainText("Traités");
  await expect(modal.locator(".eval-strip")).toContainText("Total");
  await expect(modal.locator(".eval-legend")).toContainText("Décision admin");
  await expect(modal.locator(".eval-legend")).toContainText("Statut de suivi");

  // --- Then (A003) : DEUX combos sur la même ligne, labels en majuscules ------
  const foot = item.locator(".eval-item-foot");
  await expect(foot, "le pied d'item (.eval-item-foot) doit exister").toHaveCount(1);
  await expect(
    foot.locator("select[data-eval-item-decision]"),
    "le combo de décision admin est dans .eval-item-foot",
  ).toHaveCount(1);
  const statusSelect = foot.locator("select[data-eval-item-status]");
  await expect(statusSelect, "le combo de statut de suivi est dans .eval-item-foot").toHaveCount(1);

  const labels = foot.locator(".ctrl .lbl");
  await expect(labels).toHaveCount(2);
  await expect(labels.first()).toHaveText("Décision admin");
  await expect(labels.nth(1)).toHaveText("Statut de suivi");
  expect(
    await labels.first().evaluate((el) => getComputedStyle(el).textTransform),
    "les labels sont affichés en majuscules (text-transform)",
  ).toBe("uppercase");

  // --- Then (A001) : 3 valeurs de statut + libellés ---------------------------
  const values = await statusSelect.locator("option").evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value),
  );
  expect(values, "les 3 valeurs de statut de suivi").toEqual(["open", "treated", "dismissed"]);
  const optionLabels = await statusSelect.locator("option").evaluateAll((opts) =>
    opts.map((o) => (o.textContent || "").trim()),
  );
  expect(optionLabels, "libellés depuis EVAL_ITEM_STATUS_LABELS").toEqual([
    STATUS_LABELS.open,
    STATUS_LABELS.treated,
    STATUS_LABELS.dismissed,
  ]);

  // --- When / Then (A005) : changer le statut émet un PATCH -------------------
  const current = await statusSelect.inputValue();
  const target = current === "treated" ? "dismissed" : "treated";

  requests.length = 0;
  await statusSelect.selectOption(target);
  await expect(
    item.locator("select[data-eval-item-status]"),
    `la modale rafraîchie doit refléter le statut « ${STATUS_LABELS[target]} »`,
  ).toHaveValue(target, { timeout: 15_000 });

  const patches = requests.filter(
    (r) =>
      r.method() === "PATCH" &&
      /\/api\/recettes\/[^/]+\/items\/\d+$/.test(new URL(r.url).pathname),
  );
  expect(
    patches.length,
    "le changement de statut doit émettre PATCH …/items/:itemId",
  ).toBeGreaterThan(0);

  // --- Then : AUCUN impact sur la décision admin (axes distincts) -------------
  const decisionPosts = requests.filter(
    (r) => r.method() === "POST" && /\/items\/\d+\/decision$/.test(new URL(r.url).pathname),
  );
  expect(
    decisionPosts.map((r) => `${r.method} ${r.url}`),
    "aucune écriture de décision admin lors d'un changement de statut",
  ).toHaveLength(0);
});

test("Recette : hors admin, la décision est en lecture seule (.readonly-note) — aucun combo de décision.", async ({
  page,
}) => {
  test.skip(
    !USER_USERNAME || !USER_PASSWORD,
    "Aucun compte non-admin provisionné (ECOSYSTEM_E2E_USER_USERNAME / ECOSYSTEM_E2E_USER_PASSWORD).",
  );

  await login(page, USER_USERNAME, USER_PASSWORD);
  await openFirstProjectRecettesTab(page);
  const hasRecette = await openFirstRecetteDetail(page);
  test.skip(!hasRecette, "Aucune recette visible pour le non-admin (rien à vérifier).");

  const modal = page.locator("#modal-backdrop");
  const item = modal.locator(".eval-item").first();
  test.skip((await item.count()) === 0, "La recette n'a aucun élément (rien à vérifier).");

  // --- Then : la décision est en LECTURE SEULE ---------------------------------
  await expect(
    item.locator("[data-eval-item-decision]"),
    "un non-admin ne doit voir AUCUN combo de décision admin",
  ).toHaveCount(0);
  await expect(
    item.locator(".readonly-note"),
    "la décision hors admin est affichée en lecture seule",
  ).toContainText("admin uniquement");
  // Le combo a bien deux contrôles (décision lecture seule + statut éventuel).
  await expect(item.locator(".eval-item-foot .ctrl"), "les deux axes sont présentés").toHaveCount(2);
});
