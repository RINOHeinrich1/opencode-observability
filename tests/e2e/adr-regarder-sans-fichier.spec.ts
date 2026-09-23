/**
 * E2E — Onglet ADR : modal de lecture UNIFIÉE (« Regarder ») — fallback
 * structuré quand le fichier `path` est absent + statut + pièces jointes.
 *
 * Entité E2E (1er niveau) : E2E-ECOSYSTEM-1l8hboa (classe `update`)
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/adr-regarder-sans-fichier.spec.ts
 *
 * Source : cadrage CT-mue5oi9p-667h (item 33) — tâche T-20260923-143326-vpy3,
 * plan Plan-adr-modal-lecture-unifiee-20260923-154814 (A001/A005). La modal
 * « Regarder » devient la lecture UNIQUE : titre + statut + contexte/décision/
 * conséquences intégraux + pièces jointes. Le dépliage en place
 * (`<tr class="adr-detail-row">`) et le bouton « ▸ Complet » sont SUPPRIMÉS.
 *
 * ---------------------------------------------------------------------------
 * Feature: Lecture unifiée d'une ADR dans une modal
 *
 *   Scenario: Lecture d'une ADR sans fichier — modal unifiée, contenu du registre
 *     Given l'onglet ADR affiche une ADR dont le fichier référencé est absent et
 *           dont les champs structurés (contexte/décision/conséquences) existent
 *     When l'utilisateur clique sur « Regarder »
 *     Then une modal scrollable affiche le titre, le statut et le contenu
 *          (fichier s'il existe, sinon fallback structuré du registre)
 *     And aucun 404 « fichier introuvable » n'est renvoyé
 *
 *   Scenario: Aucun contenu disponible — action désactivée, message explicite
 *     Given une ADR sans fichier sur disque et sans aucun champ structuré
 *     Then l'action de lecture est désactivée avec un title explicite
 *     And aucun 404 n'est renvoyé
 *
 *   Scenario: La table ADR reste stable (plus de dépliage en place)
 *     Given l'onglet ADR affiche plusieurs ADR
 *     Then aucune ligne <tr class="adr-detail-row"> n'est présente
 * ---------------------------------------------------------------------------
 *
 * Paramètres (déclarés au registre ; surchargeables au run) :
 *   - baseUrl        (url)     défaut https://dev.madatalk.fr — env E2E_BASE_URL
 *   - adminEmail     (secret)  ref ECOSYSTEM_E2E_ADMIN_EMAIL
 *   - adminPassword  (secret)  ref ECOSYSTEM_E2E_ADMIN_PASSWORD
 */
import { test, expect, type Page } from "@playwright/test";

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

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
}

test("Onglet ADR : « Regarder » ouvre la modal unifiée (titre + statut + contenu intégral + pièces jointes) sans 404, une ADR sans aucun contenu a l'action désactivée avec un message explicite, et la table reste stable.", async ({
  page,
}) => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page);

  // --- Given : un projet portant au moins une ADR (via l'API, mêmes cookies) --
  const projectsResp = await page.request.get(`${BASE_URL}/api/projects`);
  expect(projectsResp.ok(), "GET /api/projects doit répondre 200").toBeTruthy();
  const { projects = [] } = (await projectsResp.json()) as { projects?: Array<{ id: string }> };

  let targetProject: string | null = null;
  for (const p of projects) {
    const r = await page.request.get(
      `${BASE_URL}/api/docs?projectId=${encodeURIComponent(p.id)}&includeRepoDocs=1`,
    );
    if (!r.ok()) continue;
    const { docs = [] } = (await r.json()) as { docs?: Array<{ kind?: string }> };
    if (docs.some((d) => d.kind === "adr-tech")) {
      targetProject = p.id;
      break;
    }
  }
  test.skip(!targetProject, "aucun projet avec ADR n'est disponible pour ce scénario.");

  // Ouverture du projet (surface UI) puis de l'onglet ADR.
  await page.locator(`[data-open-project="${targetProject}"]`).first().click();
  await page.click('#tabs button[data-tab="adr"]');
  const pane = page.locator("#pane-adr");
  await expect(pane).toBeVisible({ timeout: 15_000 });
  await expect(pane.locator("table.adr-table tbody tr[data-status]").first()).toBeVisible({
    timeout: 15_000,
  });

  // --- Then : plus de dépliage en place (table stable) -----------------------
  await expect(pane.locator("tr.adr-detail-row")).toHaveCount(0);
  await expect(pane.locator("[data-adr-full]")).toHaveCount(0);

  // Aucun 404 « fichier introuvable » n'est attendu : on collecte les alertes.
  const alerts: string[] = [];
  page.on("dialog", async (d) => {
    alerts.push(d.message());
    await d.accept().catch(() => {});
  });
  const failedResponses: string[] = [];
  page.on("response", (resp) => {
    if (resp.status() === 404) failedResponses.push(resp.url());
  });

  // --- Scenario 1 : « Regarder » ouvre la modal unifiée ----------------------
  const rowWithView = pane
    .locator("table.adr-table tbody tr")
    .filter({ has: page.locator("button[data-adr-view]") })
    .first();

  if (await rowWithView.count()) {
    await rowWithView.locator("button[data-adr-view]").click();
    const modal = page.locator("#modal-backdrop .modal.modal-doc-fullscreen");
    await expect(modal, "la modal de lecture doit s'ouvrir").toBeVisible({ timeout: 15_000 });
    await expect(modal.locator(".doc-view-head h3")).not.toBeEmpty();
    await expect(
      modal.locator(".doc-view-head .badge"),
      "le statut de l'ADR doit être affiché",
    ).toHaveCount(1);
    await expect(modal.getByText("Pièces jointes", { exact: true })).toBeVisible();
    // Le corps affiche soit le fichier (markdown/pré) soit le fallback structuré
    // (adrFullContentHtml) — jamais un échec silencieux.
    await expect(
      modal.locator(".adr-detail, .doc-view-body pre, .doc-view-body .markdown-view"),
    ).not.toHaveCount(0);
    await page.locator("#modal-backdrop #modal-cancel").click().catch(() => {});
  }

  // --- Scenario 2 : ADR sans aucun contenu → action désactivée + message -----
  const disabledView = pane.locator(".adr-actions button[disabled]", { hasText: "Regarder" }).first();
  if (await disabledView.count()) {
    await expect(disabledView).toBeDisabled();
    const title = await disabledView.getAttribute("title");
    expect(
      (title || "").toLowerCase(),
      "l'action désactivée doit porter un message explicite (aucun contenu disponible)",
    ).toContain("contenu");
  }

  // --- Oracle commun : jamais de 404 « fichier introuvable » -----------------
  expect(
    failedResponses.filter((u) => /\/api\/docs\//.test(u)),
    `aucune réponse 404 sur les docs ne doit survenir — reçu : ${failedResponses.join(", ")}`,
  ).toHaveLength(0);
  expect(
    alerts.filter((m) => /impossible|404|introuvable/i.test(m)),
    `aucune alerte d'échec de lecture ne doit survenir — reçu : ${alerts.join(" | ")}`,
  ).toHaveLength(0);
});
