/**
 * E2E — Décision ADMIN d'un élément de recette : COMBO UNIQUE à 3 valeurs
 * (non décidé | à traiter | non retenu) au lieu de 2 boutons.
 *
 * Entités E2E (1er niveau) :
 *   - E2E-ECOSYSTEM-9njnxu : combo admin 3 valeurs + retour « non décidé » +
 *     statut de suivi inchangé (aucun PATCH /items/:itemId).
 *   - E2E-ECOSYSTEM-5z1x4t : combo réservé à l'admin (403 hors admin).
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/recette-item-decision-combo.spec.ts
 *
 * Source : cadrage CT-mue5oi9p-667h (recette item 36, recommandation/low) —
 * tâche T-20260923-143326-fd22, plan
 * Plan-decision-admin-combo-recette-20260923-172051 (A004). Justif. ADR-003.
 *
 * ---------------------------------------------------------------------------
 * Feature: Décision admin d'un élément de recette en combo unique
 *
 *   Scenario: L'admin change la décision via un combo unique à 3 valeurs
 *     Given je suis administrateur et qu'une recette possède au moins un élément
 *     When j'ouvre le détail de la recette
 *     Then la décision est un SEUL combo (select data-eval-item-decision) avec les
 *          valeurs « non décidé », « à traiter », « non retenu »
 *     And plus aucun bouton data-eval-item-decide n'est rendu
 *     And je peux sélectionner une décision puis revenir à « non décidé »
 *     And le badge de décision reflète la valeur choisie après rafraîchissement
 *     And le statut de suivi de l'élément reste inchangé (aucun PATCH/POST /items/:itemId)
 *
 *   Scenario: Le combo de décision est réservé à l'admin
 *     Given je ne suis pas administrateur
 *     When j'ouvre la ligne d'un élément de recette
 *     Then aucun combo de décision admin n'est affiché
 *     And un appel direct à POST /api/recettes/:id/items/:itemId/decision renvoie 403
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

// Libellés attendus (source : EVAL_ITEM_DECISION_LABELS dans public/app.js).
const DECISION_LABELS: Record<string, string> = {
  pending: "non décidé",
  a_traiter: "à traiter",
  non_retenu: "non retenu",
};

const DECISION_BADGE = 'span.badge[title="Décision admin (à traiter / non retenu)"]';

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

test("Recette : la décision admin d'un élément est un SEUL combo à 3 valeurs (non décidé | à traiter | non retenu), le retour à « non décidé » est possible et le statut de suivi reste inchangé.", async ({
  page,
}) => {
  test.skip(
    !ADMIN_USERNAME || !ADMIN_PASSWORD,
    "Identifiants admin E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  // Trace réseau : on vérifie que la décision passe par la route dédiée et
  // qu'AUCUN PATCH/POST n'est émis sur la ressource de statut de suivi.
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

  // --- Then (A002) : un SEUL combo, plus aucun bouton de décision -----------
  await expect(
    modal.locator("[data-eval-item-decide]"),
    "les 2 boutons data-eval-item-decide doivent avoir disparu",
  ).toHaveCount(0);
  await expect(
    item.locator("button", { hasText: /^(À traiter|Non retenu)$/ }),
    "aucun bouton « À traiter » / « Non retenu » ne doit subsister sur la ligne",
  ).toHaveCount(0);

  const select = item.locator("select[data-eval-item-decision]");
  await expect(select, "un combo unique porte data-eval-item-decision").toHaveCount(1);

  const values = await select.locator("option").evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value),
  );
  expect(values, "les 3 valeurs de décision (dont pending)").toEqual([
    "pending",
    "a_traiter",
    "non_retenu",
  ]);
  const labels = await select.locator("option").evaluateAll((opts) =>
    opts.map((o) => (o.textContent || "").trim()),
  );
  expect(labels, "libellés depuis EVAL_ITEM_DECISION_LABELS").toEqual([
    "non décidé",
    "à traiter",
    "non retenu",
  ]);

  // Statut de suivi (badge adjacent au contenu) — capturé pour non-régression.
  const statusBadge = item.locator(".eval-item-content + span.badge");
  const statusBefore = ((await statusBadge.textContent()) || "").trim();

  // --- When / Then : choisir une décision puis revenir à « non décidé » -----
  const current = await select.inputValue();
  const target = current === "non_retenu" ? "a_traiter" : "non_retenu";

  requests.length = 0;
  await select.selectOption(target);
  await expect(
    item.locator(DECISION_BADGE),
    `le badge de décision doit refléter « ${DECISION_LABELS[target]} »`,
  ).toHaveText(DECISION_LABELS[target], { timeout: 15_000 });

  // Retour explicite à « non décidé » (pending) — impossible avec les 2 boutons.
  await item.locator("select[data-eval-item-decision]").selectOption("pending");
  await expect(
    item.locator(DECISION_BADGE),
    "le retour à « non décidé » doit être possible et reflété",
  ).toHaveText(DECISION_LABELS.pending, { timeout: 15_000 });

  // --- Then : la décision passe par la route dédiée -------------------------
  const decisionPosts = requests.filter(
    (r) => r.method() === "POST" && /\/items\/\d+\/decision$/.test(new URL(r.url).pathname),
  );
  expect(
    decisionPosts.length,
    "la décision doit être envoyée via POST …/items/:itemId/decision",
  ).toBeGreaterThan(0);

  // --- Then : AUCUN impact sur le statut de suivi ---------------------------
  const statusWrites = requests.filter(
    (r) =>
      ["PATCH", "POST", "PUT"].includes(r.method()) &&
      /\/items\/\d+$/.test(new URL(r.url).pathname),
  );
  expect(
    statusWrites.map((r) => `${r.method} ${r.url}`),
    "aucune écriture sur /items/:itemId (statut de suivi) — axe décision DISTINCT",
  ).toHaveLength(0);

  await expect(
    item.locator(".eval-item-content + span.badge"),
    "le statut de suivi de l'élément reste inchangé",
  ).toHaveText(statusBefore);
});

test("Recette : le combo de décision admin est réservé à l'administrateur (aucun combo pour un non-admin ; POST direct → 403).", async ({
  page,
}) => {
  test.skip(
    !USER_USERNAME || !USER_PASSWORD,
    "Aucun compte non-admin provisionné (ECOSYSTEM_E2E_USER_USERNAME / ECOSYSTEM_E2E_USER_PASSWORD).",
  );

  await login(page, USER_USERNAME, USER_PASSWORD);
  await openFirstProjectRecettesTab(page);

  const detail = page.locator("#pane-recettes [data-eval-detail]").first();
  if ((await detail.count()) === 0) {
    test.skip(true, "Aucune recette visible pour le non-admin (rien à vérifier).");
  }

  const recetteId = (await detail.getAttribute("data-eval-detail")) || "";
  await detail.click();
  await expect(page.locator("#modal-backdrop .modal")).toBeVisible({ timeout: 15_000 });

  // --- Then : aucun combo de décision admin (ni bouton legacy) --------------
  await expect(
    page.locator("#modal-backdrop [data-eval-item-decision]"),
    "un non-admin ne doit voir AUCUN combo de décision admin",
  ).toHaveCount(0);
  await expect(
    page.locator("#modal-backdrop [data-eval-item-decide]"),
    "un non-admin ne doit voir AUCUN bouton de décision legacy",
  ).toHaveCount(0);

  // --- And : appel direct POST …/decision → 403 (garde admin serveur) -------
  const res = await page.request.get(`/api/recettes/${encodeURIComponent(recetteId)}`);
  expect(res.ok(), "lecture de la recette par le non-admin").toBeTruthy();
  const body = await res.json();
  const items: Array<{ itemId: number }> = (body.recette && body.recette.items) || [];
  if (items.length === 0) {
    test.skip(true, "La recette n'a aucun élément (impossible de tester le 403).");
  }

  const decision = await page.request.post(
    `/api/recettes/${encodeURIComponent(recetteId)}/items/${items[0].itemId}/decision`,
    { data: { decision: "a_traiter" } },
  );
  expect(
    decision.status(),
    "la route de décision admin doit répondre 403 pour un non-admin (ADR-001/002)",
  ).toBe(403);
});
