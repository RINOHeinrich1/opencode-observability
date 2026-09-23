/**
 * E2E — Onglet Workspaces : remontée des échecs Coder (actions + enrichissement).
 *
 * Entités E2E (1er niveau) :
 *   - E2E-ECOSYSTEM-yzbqke (relation CREATED) — « Admin — un échec d'action coder
 *     remonte un statut d'échec avec cause (jamais 200 {queued:true}) » ;
 *   - E2E-ECOSYSTEM-118rzv4 (relation CREATED) — « Admin — l'échec d'enrichissement
 *     Coder est visible (« statut Coder indisponible ») et l'IDE reste accessible
 *     (URL de repli) ».
 *   - E2E-ECOSYSTEM-th2ogw (relation REGRESSION — admin, onglet Workspaces) :
 *     non-régression du rendu de l'onglet, couverte par
 *     tests/e2e/executeur-workspaces-lecture.spec.ts.
 *   project = ecosystem · repo = opencode-observability
 *   specFile = tests/e2e/workspaces-echecs-coder.spec.ts
 *
 * Tâche : T-20260923-143326-dz3h (plan
 *   Plan-workspaces-echecs-coder-20260923-180926, recette items 27 + 28).
 *
 * ADR de référence (Accepté) :
 *   - ADR-008 (cycle de vie et rotation du token Coder) : « fin de la panne
 *     silencieuse des workspaces admin (actions et IDE) ; la panne devient
 *     VISIBLE immédiatement au lieu de se manifester par des échecs déguisés en
 *     succès ». Ce spec verrouille exactement cette conséquence.
 *   - ADR-005 (cohérence modèle session ↔ clés fournisseur) : capture de la
 *     sortie (child.stderr) pour remonter la vraie cause — principe réutilisé.
 *   - ADR-002 (rôles) : les écritures Workspaces restent admin-only.
 *
 * ---------------------------------------------------------------------------
 * Feature: Remontée des échecs Coder dans l'onglet Workspaces
 *
 *   Scenario: Un échec d'action coder remonte un statut d'échec avec cause
 *     Given je suis connecté en administrateur
 *     When je POST /api/workspaces/<nom-inexistant>/start (action coder en échec)
 *     Then la réponse est 502 (jamais 200)
 *     And le corps porte { ok:false, error:<cause> } — jamais { queued:true }
 *
 *   Scenario: L'échec d'enrichissement Coder est visible et l'IDE reste accessible
 *     Given je suis connecté en administrateur
 *     And GET /api/workspaces renvoie un état dégradé (coderUnavailable + coderError)
 *     When j'ouvre l'onglet Workspaces
 *     Then la mention « Statut Coder indisponible » est visible
 *     And le badge IDE (URL de repli) est conservé malgré le mode dégradé
 * ---------------------------------------------------------------------------
 *
 * Le spec vit dans le repo opencode-observability (le comportement couvre le
 * panneau de l'écosystème opencode). Il s'exécute contre une instance du
 * panneau DÉJÀ DÉPLOYÉE (défaut https://orchestrator.madatalk.fr) — l'exécution
 * est portée par le CI/CD, jamais par build-notify.
 *
 * Variables d'environnement (posées par le runner e2e_run / secrets du projet) :
 *   - E2E_BASE_URL                 : cible du panneau (posée par le runner) ;
 *   - sinon `baseUrl`              : surcharge paramValues (défaut orchestrator.madatalk.fr) ;
 *   - ECOSYSTEM_E2E_ADMIN_USERNAME : compte ADMIN ;
 *   - ECOSYSTEM_E2E_ADMIN_PASSWORD : mot de passe du compte ADMIN.
 *
 * Si le compte ADMIN n'est pas provisionné, chaque scénario se SKIPPE
 * explicitement — JAMAIS de faux vert.
 */
import { test, expect, type Page } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set des entités E2E-ECOSYSTEM-yzbqke / 118rzv4) ---
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://orchestrator.madatalk.fr";

const ADMIN_USERNAME =
  process.env.ECOSYSTEM_E2E_ADMIN_USERNAME ||
  process.env.adminUsername ||
  "";
const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  "";

/** Nom de workspace volontairement INEXISTANT → `coder start` échoue de façon déterministe. */
const UNKNOWN_WS = "__e2e_inexistant_echec_coder__";

/**
 * Écran « Choisir une organisation » (utilisateur multi-organisations, sans
 * organisation active dans la session) : on sélectionne l'organisation PAR
 * DÉFAUT (★), périmètre du projet testé.
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

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
  await selectOrganizationIfPrompted(page);
}

test(
  "Admin — un échec d'action coder remonte un statut d'échec avec cause (jamais 200 {queued:true})",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // --- When : action coder sur un workspace INEXISTANT → échec déterministe ---
    const resp = await page.request.post(
      `${BASE_URL}/api/workspaces/${encodeURIComponent(UNKNOWN_WS)}/start`,
    );
    const body = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      queued?: boolean;
      error?: string;
      exitCode?: number;
    };

    // --- Then : statut d'échec non-2xx (502), jamais un succès déguisé ---
    expect(
      resp.status(),
      `POST /api/workspaces/${UNKNOWN_WS}/start (échec coder) doit répondre 502 — reçu ${resp.status()} : ${JSON.stringify(body).slice(0, 200)}`,
    ).toBe(502);
    expect(
      body.queued,
      "un échec coder ne doit JAMAIS être présenté {queued:true} (échec déguisé en succès, ADR-008)",
    ).not.toBe(true);
    expect(body.ok, "le corps d'un échec doit porter {ok:false}").toBe(false);
    expect(
      String(body.error || ""),
      "l'échec doit remonter sa cause (stderr `coder` tronqué), pas un message vide",
    ).not.toHaveLength(0);
  },
);

test(
  "Admin — l'échec d'enrichissement Coder est visible (« statut Coder indisponible ») et l'IDE reste accessible (URL de repli)",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // --- Given : GET /api/workspaces renvoie un état DÉGRADÉ (token expiré simulé) ---
    // L'expiration réelle du token n'est pas reproductible de façon déterministe :
    // on intercepte la réponse API (page.route) et on vérifie le RENDU dégradé.
    const degradedPayload = {
      count: 1,
      coderUnavailable: true,
      coderError: "token Coder expiré (simulation E2E)",
      workspaces: [
        {
          name: "ws-degrade-e2e",
          owner: "RINOHeinrich1",
          // Docker voit le conteneur arrêté ; le VRAI statut Coder est indisponible.
          running: false,
          // URL IDE de repli dérivable (<cfg.url>/@<owner>/<name>).
          ideUrl: "https://coder.example/@RINOHeinrich1/ws-degrade-e2e",
        },
      ],
    };
    await page.route("**/api/workspaces", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(degradedPayload),
      }),
    );

    // --- When : j'ouvre l'onglet Workspaces ---
    await page.click('#tabs button[data-tab="workspaces"]');
    const pane = page.locator("#pane-workspaces");
    await expect(pane).toBeVisible({ timeout: 15_000 });

    // --- Then : l'échec d'enrichissement est VISIBLE (plus avalé en silence) ---
    await expect(
      pane.locator("#ws-coder-notice"),
      "l'onglet doit afficher une notice explicite « Statut Coder indisponible »",
    ).toBeVisible({ timeout: 15_000 });
    await expect(pane.locator("#ws-coder-notice")).toContainText("Statut Coder indisponible");

    // --- Then : l'accès IDE n'est PAS silencieusement retiré (URL de repli) ---
    // running:false + coderUnavailable → sans la règle dégradée le badge serait masqué.
    await expect(
      pane.locator("a.ws-ide"),
      "le badge IDE doit rester proposé en mode dégradé (URL de repli), jamais retiré en silence",
    ).toBeVisible({ timeout: 15_000 });
  },
);
