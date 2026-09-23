/**
 * E2E — Onglet Workspaces : indicateur de santé du token Coder (ADR-008).
 *
 * Entité E2E (1er niveau) :
 *   - E2E-ECOSYSTEM — « l'onglet Workspaces affiche l'état de santé du token
 *     Coder (état, expiration, dernière rotation, signal rotation non
 *     exécutée) » (relation CREATED vers T-20260923-143326-6sqg).
 *   project = ecosystem · repo = opencode-observability
 *   specFile = tests/e2e/coder-token-health.spec.ts
 *
 * Tâche : T-20260923-143326-6sqg (plan
 *   Plan-indicateur-sante-token-coder-20260923-200558, recette item 30).
 *
 * ADR de référence (Accepté) :
 *   - ADR-008 (cycle de vie / rotation du token Coder) : l'état du token
 *     (valide / expire bientôt / expiré / rotation en échec), sa date
 *     d'expiration et l'état de la dernière rotation DOIVENT être exposés dans
 *     le panneau comme ÉTAT DE SANTÉ, avec échec BRUYANT si la rotation ne
 *     tourne pas.
 *   - ADR-002 (rôles) : l'indicateur est lisible par les rôles de l'onglet
 *     Workspaces (lecture seule, non sensible).
 *
 * ---------------------------------------------------------------------------
 * Feature: Indicateur de santé du token Coder dans l'onglet Workspaces
 *
 *   Scenario: L'onglet affiche l'état, l'expiration, la dernière rotation et le
 *             signal « rotation non exécutée »
 *     Given je suis connecté en administrateur
 *     When GET /api/coder/token-health répond 200 avec l'état de santé
 *     Then le bandeau #ws-token-health est affiché avec le badge d'état
 *     And la date d'expiration est visible
 *     And un signal explicite « la rotation ne tourne pas » apparaît si le
 *       heartbeat est périmé (rotationStale)
 *     And le badge « Rotation en échec » apparaît si status=rotation_failed
 *
 *   Scenario: Contrat de l'API de santé
 *     Given je suis connecté
 *     When GET /api/coder/token-health
 *     Then la réponse est 200 et porte status / expiresAt / lastRotation / rotationStale
 * ---------------------------------------------------------------------------
 *
 * Le spec vit dans le repo opencode-observability (le comportement couvre le
 * panneau de l'écosystème opencode). Il s'exécute contre une instance du
 * panneau DÉJÀ DÉPLOYÉE (défaut https://orchestrator.madatalk.fr) — l'exécution
 * est portée par le CI/CD, jamais par build-notify.
 *
 * Le rendu est rendu DÉTERMINISTE par interception de la route de santé
 * (l'état réel du token n'est pas reproductible). Aucune écriture, aucune
 * donnée sensible : l'état ne contient JAMAIS le token.
 *
 * Variables d'environnement (posées par le runner e2e_run / secrets du projet) :
 *   - E2E_BASE_URL                 : cible du panneau (posée par le runner) ;
 *   - sinon `baseUrl`              : surcharge paramValues (défaut orchestrator.madatalk.fr) ;
 *   - ECOSYSTEM_E2E_ADMIN_USERNAME : compte ADMIN ;
 *   - ECOSYSTEM_E2E_ADMIN_PASSWORD : mot de passe du compte ADMIN.
 *
 * Si le compte ADMIN n'est pas provisionné, le scénario se SKIPPE
 * explicitement — JAMAIS de faux vert.
 */
import { test, expect, type Page } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set de l'entité E2E-ECOSYSTEM) ---
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

/** Charge /api/workspaces minimale pour que l'onglet se rende (1 workspace). */
const WORKSPACES_PAYLOAD = {
  count: 1,
  coderUnavailable: false,
  workspaces: [
    {
      name: "ws-token-health-e2e",
      owner: "RINOHeinrich1",
      running: true,
      coderStatus: "running",
      ideUrl: "https://coder.example/@RINOHeinrich1/ws-token-health-e2e",
    },
  ],
};

/** État de santé de référence : token valide, expiration connue, rotation saine. */
function healthValid() {
  return {
    ok: true,
    org: "onirtech",
    checkedAt: "2026-09-23T20:00:00.000Z",
    stateFile: "/var/lib/coder-token-rotate/state.json",
    stateReadable: true,
    stateOrg: "onirtech",
    orgMismatch: false,
    thresholds: { staleHours: 13, minRemainingHours: 48 },
    status: "valid",
    expiresAt: "2026-10-01T00:00:00.000Z",
    expiresAtEstimated: false,
    remainingHours: 120,
    lastRotation: {
      status: "valid",
      at: "2026-09-23T06:00:00.000Z",
      successAt: "2026-09-23T06:00:00.000Z",
      exitCode: 0,
    },
    rotationStale: false,
    rotationWarning: null,
    detail: "token Coder valide (~120 h)",
  };
}

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

/** (Re)pose les interceptions de l'onglet avec un payload de santé donné. */
async function mockWorkspacesTab(page: Page, health: unknown): Promise<void> {
  await page.unroute("**/api/workspaces").catch(() => {});
  await page.unroute("**/api/coder/token-health").catch(() => {});
  await page.route("**/api/workspaces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(WORKSPACES_PAYLOAD),
    }),
  );
  await page.route("**/api/coder/token-health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(health),
    }),
  );
}

/** Ouvre (ou re-rend) l'onglet Workspaces. */
async function openWorkspaces(page: Page): Promise<void> {
  await page.click('#tabs button[data-tab="workspaces"]');
  await expect(page.locator("#pane-workspaces")).toBeVisible({ timeout: 15_000 });
}

test(
  "L'onglet Workspaces affiche l'état de santé du token Coder (état, expiration, dernière rotation, signal rotation non exécutée)",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // --- Then (1) : token valide → badge « Valide » + date d'expiration visible ---
    await mockWorkspacesTab(page, healthValid());
    await openWorkspaces(page);
    const banner = page.locator("#pane-workspaces #ws-token-health");
    await expect(
      banner,
      "le bandeau de santé du token Coder (#ws-token-health) doit être affiché",
    ).toBeVisible({ timeout: 15_000 });
    await expect(banner, "un token valide doit afficher le badge « Valide »").toContainText("Valide");
    await expect(
      banner,
      "la date d'expiration du token doit être visible (jamais masquée)",
    ).toContainText("2026-10-01");
    await expect(
      banner,
      "l'état de la DERNIÈRE rotation doit être visible",
    ).toContainText("Dernière rotation");

    // --- Then (2) : heartbeat périmé (rotationStale) → signal EXPLICITE (ADR-008) ---
    await mockWorkspacesTab(page, {
      ...healthValid(),
      rotationStale: true,
      rotationWarning:
        "la rotation ne tourne pas — dernier succès 2026-09-20T06:00:00.000Z (> 13 h)",
    });
    await openWorkspaces(page);
    const alert = page.locator("#pane-workspaces #ws-token-health-alert");
    await expect(
      alert,
      "un heartbeat périmé doit produire un signal EXPLICITE « la rotation ne tourne pas »",
    ).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText("la rotation ne tourne pas");

    // --- Then (3) : rotation en échec → badge « Rotation en échec » ---
    await mockWorkspacesTab(page, {
      ...healthValid(),
      status: "rotation_failed",
      lastRotation: {
        status: "failed",
        at: "2026-09-23T18:00:00.000Z",
        successAt: null,
        exitCode: 1,
      },
      detail: "la dernière rotation a échoué — token non renouvelé (voir le runbook de rotation)",
    });
    await openWorkspaces(page);
    await expect(
      page.locator("#pane-workspaces #ws-token-health"),
      "une rotation en échec doit afficher le badge « Rotation en échec »",
    ).toContainText("Rotation en échec", { timeout: 15_000 });

    // --- Non-régression : la notice #ws-coder-notice existante reste inchangée ---
    await expect(
      page.locator("#pane-workspaces table"),
      "l'insertion du bandeau ne doit pas casser le tableau des workspaces",
    ).toBeVisible({ timeout: 15_000 });
  },
);

test(
  "Contrat de l'API — GET /api/coder/token-health répond 200 avec status / expiresAt / lastRotation / rotationStale",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — jamais de faux vert.",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const resp = await page.request.get(`${BASE_URL}/api/coder/token-health`);
    expect(
      resp.status(),
      `GET /api/coder/token-health doit répondre 200 — reçu ${resp.status()}`,
    ).toBe(200);

    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.ok, "le corps doit porter {ok:true}").toBe(true);
    for (const field of ["status", "expiresAt", "lastRotation", "rotationStale"]) {
      expect(
        Object.prototype.hasOwnProperty.call(body, field),
        `le contrat de santé doit exposer le champ « ${field} »`,
      ).toBe(true);
    }
    expect(
      ["no_config", "expired", "rotation_failed", "expiring", "valid"],
      `status doit appartenir aux états ADR-008 — reçu ${String(body.status)}`,
    ).toContain(body.status);
    // Jamais de token en clair dans la réponse (état de santé uniquement).
    expect(JSON.stringify(body)).not.toMatch(/(token|secret)\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}/i);
  },
);
