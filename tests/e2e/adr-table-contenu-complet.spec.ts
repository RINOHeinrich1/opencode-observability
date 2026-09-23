/**
 * E2E — Table ADR : lecture COMPLÈTE d'une ADR dans une modal UNIFIÉE
 * (plus de dépliage en place).
 *
 * Entité E2E (1er niveau) : E2E-ECOSYSTEM-k5n82t
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/adr-table-contenu-complet.spec.ts
 *
 * Source : cadrage CT-mue5oi9p-667h (item 33, amélioration) — tâche
 * T-20260923-143326-vpy3, plan Plan-adr-modal-lecture-unifiee-20260923-154814.
 * Ce spec REMPLACE les scénarios d'affichage EN PLACE (obsolètes) :
 *   E2E-ECOSYSTEM-1f243yg / qnmfb0 / 12fbo8y — elles validaient
 *   `<tr class="adr-detail-row">`, le bouton « ▸ Complet » et le repli des lignes
 *   de détail au filtrage, tous SUPPRIMÉS par A002-A006.
 *
 * ---------------------------------------------------------------------------
 * Feature: Lecture complète d'une ADR dans une modal unifiée
 *
 *   Scenario: Ouvrir le contenu complet d'une ADR dans une modal
 *     Given l'onglet ADR affiche une ADR avec son statut, ses champs structurés
 *           et ses pièces jointes
 *     When l'utilisateur déclenche l'action de lecture de cette ADR
 *     Then une modal scrollable s'ouvre et affiche le titre, le statut, le
 *           contexte/décision/conséquences intégraux et les pièces jointes
 *     And la table ADR ne contient aucune ligne de détail insérée (elle reste
 *         stable)
 *
 *   Scenario: Unification des mécanismes
 *     Given la table ADR expose une action de lecture par ligne
 *     Then il n'existe plus de bouton « Complet » dépliant une ligne de détail
 *          en place
 *     And l'action de lecture ouvre la modal unifiée
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

/** Ouvre un projet (le premier listé) puis l'onglet ADR. */
async function openFirstProjectAdrTab(page: Page): Promise<void> {
  const openBtn = page.locator("[data-open-project]").first();
  await expect(openBtn, "au moins un projet est listé").toBeVisible({ timeout: 15_000 });
  await openBtn.click();
  await page.click('#tabs button[data-tab="adr"]');
  await expect(page.locator("#pane-adr")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("#pane-adr table.adr-table tbody tr[data-status]").first(),
    "au moins une ligne ADR est rendue",
  ).toBeVisible({ timeout: 15_000 });
}

test("Onglet ADR : l'action unique « Regarder » ouvre une modal scrollable (titre + statut + intégraux + pièces jointes) et la table reste stable (aucune ligne de détail, plus de bouton « Complet »).", async ({
  page,
}) => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page);
  await openFirstProjectAdrTab(page);

  const pane = page.locator("#pane-adr");

  // --- Then (unification) : plus de dépliage en place ni bouton « Complet » --
  await expect(
    pane.locator("tr.adr-detail-row"),
    "aucune ligne de détail en place ne doit être rendue (A002)",
  ).toHaveCount(0);
  await expect(
    pane.locator("[data-adr-full]"),
    "le bouton « ▸ Complet » ne doit plus exister (A003)",
  ).toHaveCount(0);
  await expect(
    pane.locator(".adr-actions button", { hasText: "Complet" }),
    "aucun libellé « Complet » ne doit subsister dans les actions",
  ).toHaveCount(0);

  // Une action de lecture unique par ligne : « Regarder » (data-adr-view).
  const rowWithView = pane
    .locator("table.adr-table tbody tr")
    .filter({ has: page.locator("button[data-adr-view]") })
    .first();
  await expect(
    rowWithView,
    "au moins une ADR expose une action de lecture « Regarder » active",
  ).toBeVisible({ timeout: 15_000 });

  // --- When : déclencher l'action de lecture --------------------------------
  await rowWithView.locator("button[data-adr-view]").click();

  // --- Then : la modal unifiée s'ouvre --------------------------------------
  const modal = page.locator("#modal-backdrop .modal.modal-doc-fullscreen");
  await expect(modal, "la modal unifiée de lecture doit s'ouvrir").toBeVisible({ timeout: 15_000 });

  // Titre affiché.
  await expect(modal.locator(".doc-view-head h3")).not.toBeEmpty();

  // Statut affiché (badge adrStatusBadge dans l'en-tête).
  await expect(
    modal.locator(".doc-view-head .badge"),
    "le statut de l'ADR doit être affiché dans la modal",
  ).toHaveCount(1);

  // Pièces jointes affichées (section dédiée).
  await expect(modal.getByText("Pièces jointes", { exact: true })).toBeVisible();

  // Contenu INTÉGRAL (adrFullContentHtml) : bloc de lecture présent, avec au
  // moins un champ structuré OU le message explicite d'indisponibilité.
  await expect(
    modal.locator(".adr-detail"),
    "le contenu intégral (contexte/décision/conséquences) doit être rendu",
  ).toBeVisible();

  // Modal scrollable : le corps de lecture réutilise `doc-view-body` (overflow:auto).
  const overflowY = await modal
    .locator(".doc-view-body")
    .evaluate((el) => getComputedStyle(el as HTMLElement).overflowY);
  expect(["auto", "scroll"], "le corps de la modal doit être scrollable").toContain(overflowY);

  // --- Then (stabilité) : la table reste stable, aucune ligne insérée --------
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("#modal-backdrop #modal-cancel").click().catch(() => {});
  await expect(
    pane.locator("tr.adr-detail-row"),
    "la table ADR reste stable : aucune ligne de détail n'est insérée à la lecture",
  ).toHaveCount(0);
});
