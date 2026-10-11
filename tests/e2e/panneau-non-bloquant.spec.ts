/**
 * E2E — Panneau orchestrateur NON BLOQUANT / anti-crash (robustesse au couplage).
 *
 * Entité E2E (1er niveau) : « Admin — le panneau reste RÉACTIF et GET
 * /api/workspaces répond dans un délai BORNÉ même quand un process/réseau
 * externe (Coder) est lent ou indisponible, sans geler ni crasher l'ensemble du
 * panneau » (project = ecosystem · repo = opencode-observability).
 *   specFile = tests/e2e/panneau-non-bloquant.spec.ts
 *
 * Tâche : T-20261011-114739-nrv3 (plan
 *   Plan-decouplage-appels-externes-anti-crash-20261011-114947, défauts D1-D5).
 *
 * ADR de référence (Accepté) :
 *   - ADR-008 (cycle de vie / rotation du token Coder) : la panne Coder doit
 *     rester VISIBLE (`coderUnavailable`/`coderError`) et l'IDE rester
 *     accessible ; la dégradation gracieuse est CONSERVÉE.
 *   - ADR-005 : capture bornée de la sortie (stderr) non bloquante.
 *   - ADR-002 : les écritures Workspaces restent admin-only (ce spec ne fait que
 *     des GET, en admin).
 *
 * ---------------------------------------------------------------------------
 * Feature: Le panneau reste réactif malgré un appel externe lent/indisponible
 *
 *   Scenario: /healthz répond en temps borné (event loop non gelé)
 *     Given le panneau est déployé
 *     When j'interroge GET /healthz plusieurs fois
 *     Then chaque réponse est 200 et arrive en moins de 2 s
 *
 *   Scenario: GET /api/workspaces répond dans un délai borné (hot path découplé)
 *     Given je suis connecté en administrateur
 *     When GET /api/workspaces (enrichissement Coder en panne ou non) est appelé
 *     Then la réponse arrive en moins de 20 s (jamais un blocage de l'event loop)
 *     And le corps porte un tableau `workspaces`
 *     And si `coderUnavailable` vaut true alors `coderError` porte une cause (ADR-008)
 *
 *   Scenario: Parcours connexion + chargement organisation (non-régression)
 *     Given des identifiants admin valides
 *     When je me connecte puis choisis l'organisation si demandé
 *     Then l'onglet Workspaces s'affiche (aucune régression de l'organisation)
 * ---------------------------------------------------------------------------
 *
 * Le spec vit dans le repo opencode-observability et s'exécute contre une
 * instance du panneau DÉJÀ DÉPLOYÉE (défaut https://orchestrator.madatalk.fr).
 *
 * Variables d'environnement (posées par le runner e2e_run / secrets du projet) :
 *   - E2E_BASE_URL                 : cible du panneau (posée par le runner) ;
 *   - sinon `baseUrl`              : surcharge paramValues (défaut orchestrator.madatalk.fr) ;
 *   - ECOSYSTEM_E2E_ADMIN_USERNAME : compte ADMIN ;
 *   - ECOSYSTEM_E2E_ADMIN_PASSWORD : mot de passe du compte ADMIN.
 *
 * Si le compte ADMIN n'est pas provisionné, les scénarios admin se SKIPPENT
 * explicitement — JAMAIS de faux vert.
 */
import { test, expect, type Page } from "@playwright/test";

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

/** Délai maximal toléré pour un GET /healthz (le panneau ne doit pas geler). */
const HEALTHZ_MAX_MS = 2_000;
/** Délai maximal toléré pour GET /api/workspaces (hot path découplé de Coder). */
const WORKSPACES_MAX_MS = 20_000;

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

test("Le panneau reste réactif : GET /healthz répond 200 en moins de 2 s (event loop non gelé)", async ({ page }) => {
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const resp = await page.request.get(`${BASE_URL}/healthz`);
    const elapsed = Date.now() - t0;
    expect(
      resp.status(),
      `GET /healthz doit répondre 200 — reçu ${resp.status()}`,
    ).toBe(200);
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.ok, "GET /healthz doit porter {ok:true}").toBe(true);
    expect(
      elapsed,
      `GET /healthz doit répondre en moins de ${HEALTHZ_MAX_MS} ms (panneau non gelé) — reçu ${elapsed} ms`,
    ).toBeLessThan(HEALTHZ_MAX_MS);
  }
});

test(
  "Admin — GET /api/workspaces répond dans un délai borné et préserve la dégradation gracieuse (coderUnavailable)",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const t0 = Date.now();
    const resp = await page.request.get(`${BASE_URL}/api/workspaces`);
    const elapsed = Date.now() - t0;

    expect(
      resp.status(),
      `GET /api/workspaces doit répondre 200 — reçu ${resp.status()}`,
    ).toBe(200);
    expect(
      elapsed,
      `GET /api/workspaces doit répondre dans un délai BORNÉ (< ${WORKSPACES_MAX_MS} ms) — reçu ${elapsed} ms : un appel externe (Coder) ne doit plus geler l'event loop`,
    ).toBeLessThan(WORKSPACES_MAX_MS);

    const body = (await resp.json().catch(() => ({}))) as {
      workspaces?: unknown;
      coderUnavailable?: boolean;
      coderError?: string | null;
    };
    expect(
      Array.isArray(body.workspaces),
      "le corps doit porter un tableau `workspaces` (même vide)",
    ).toBe(true);

    // ADR-008 : si l'enrichissement Coder a échoué, la panne reste VISIBLE.
    if (body.coderUnavailable === true) {
      expect(
        String(body.coderError || ""),
        "coderUnavailable=true doit s'accompagner de coderError (cause visible, ADR-008)",
      ).not.toHaveLength(0);
    }
  },
);

test(
  "Admin — parcours connexion + chargement organisation (non-régression) puis onglet Workspaces",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    // login() couvre la connexion + le choix d'organisation (dégradation gracieuse).
    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await page.click('#tabs button[data-tab="workspaces"]');
    await expect(
      page.locator("#pane-workspaces"),
      "l'onglet Workspaces doit s'afficher (non-régression organisation/workspaces)",
    ).toBeVisible({ timeout: 15_000 });
  },
);
