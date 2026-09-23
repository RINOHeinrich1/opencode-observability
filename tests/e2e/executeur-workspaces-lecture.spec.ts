/**
 * E2E — Accès API Workspaces en LECTURE SEULE pour le rôle exécuteur (+
 * non-régression admin).
 *
 * Entités E2E (1er niveau) :
 *   - E2E-ECOSYSTEM-2msn5v (relation CREATED) — « Exécuteur : lecture seule de
 *     l'API Workspaces (GET 200, écritures 403) » ;
 *   - E2E-ECOSYSTEM-th2ogw (relation REGRESSION) — « Non-régression admin —
 *     onglet Workspaces inchangé ».
 *   project = ecosystem · repo = opencode-observability
 *   specFile = tests/e2e/executeur-workspaces-lecture.spec.ts
 *
 * Tâche : T-20260923-143326-9da8 (plan
 *   Plan-executeur-lecture-workspaces-20260923-174500).
 *
 * ADR de référence (Accepté) :
 *   - ADR-002 (Rôles utilisateurs du panneau) : la page Workspace est accordée
 *     à l'EXÉCUTEUR → son API de LECTURE doit l'être aussi, sans élargir
 *     l'écriture (admin-only) ;
 *   - ADR-006 (instances opencode + routage) : GET /api/coder/ide est la
 *     passerelle d'ouverture de l'IDE sans auth Coder côté utilisateur.
 *
 * Avant le correctif, EXECUTEUR_ALLOWED_API (server.mjs) ne contenait ni
 * /api/workspaces ni /api/coder/ide → enforceRoleAcl (FAIL-CLOSED, appelée
 * AVANT toute route) répondait 403 « accès refusé — hors périmètre exécuteur »
 * sur tout GET, et GET /api/workspaces/:name renvoyait un 403 au libellé
 * trompeur « réservé aux administrateurs » (confondu avec un refus admin-only).
 *
 * ---------------------------------------------------------------------------
 * Feature: Accès API Workspaces en lecture seule pour l'exécuteur
 *
 *   Scenario: Lecture autorisée dans le périmètre
 *     Given je suis connecté en rôle exécuteur avec au moins un projet assigné
 *     When je fais GET /api/workspaces
 *     Then la réponse est 200 et ne liste que les workspaces de mon périmètre
 *     And GET /api/workspaces/:name d'un workspace de mon périmètre renvoie 200
 *     And GET /api/coder/ide?url=<workspace du périmètre> n'est pas refusé par l'ACL
 *
 *   Scenario: Refus de périmètre explicite
 *     Given je suis connecté en rôle exécuteur
 *     When je fais GET /api/workspaces/:name d'un workspace HORS de mon périmètre
 *     Then la réponse est 403 avec un message de périmètre explicite
 *     And ce message n'est jamais « réservé aux administrateurs »
 *
 *   Scenario: Les écritures restent interdites à l'exécuteur
 *     Given je suis connecté en rôle exécuteur
 *     When je fais POST /api/workspaces, POST /api/workspaces/:name/start|stop|restart,
 *       ou DELETE /api/workspaces/:name
 *     Then chaque réponse est 403 (écritures hors périmètre exécuteur)
 *
 *   Scenario: Non-régression admin
 *     Given je suis connecté en administrateur
 *     When j'ouvre l'onglet Workspaces
 *     Then GET /api/workspaces renvoie 200 et la liste n'est pas restreinte
 *     And la colonne Actions est affichée et la création de workspace est disponible
 *     And l'admin n'est pas soumis au refus de périmètre de l'exécuteur
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
 *   - ECOSYSTEM_E2E_USER_USERNAME  : compte EXÉCUTEUR (scénario 1) ;
 *   - ECOSYSTEM_E2E_USER_PASSWORD  : mot de passe du compte EXÉCUTEUR ;
 *   - ECOSYSTEM_E2E_ADMIN_USERNAME : compte ADMIN (scénario 4, non-régression) ;
 *   - ECOSYSTEM_E2E_ADMIN_PASSWORD : mot de passe du compte ADMIN.
 *
 * Si le compte EXÉCUTEUR (resp. ADMIN) n'est pas provisionné, le scénario se
 * SKIPPE explicitement — JAMAIS de faux vert.
 */
import { test, expect, type Page } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set des entités E2E-ECOSYSTEM-2msn5v / th2ogw) ---
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://orchestrator.madatalk.fr";

// Compte EXÉCUTEUR : uniquement les variables dédiées (jamais le compte admin).
const EXEC_USERNAME =
  process.env.ECOSYSTEM_E2E_USER_USERNAME ||
  process.env.E2E_EXECUTEUR_USERNAME ||
  "";
const EXEC_PASSWORD =
  process.env.ECOSYSTEM_E2E_USER_PASSWORD ||
  process.env.E2E_EXECUTEUR_PASSWORD ||
  "";

const ADMIN_USERNAME =
  process.env.ECOSYSTEM_E2E_ADMIN_USERNAME ||
  process.env.adminUsername ||
  "";
const ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD ||
  process.env.adminPassword ||
  "";

/** Nom de workspace volontairement HORS périmètre (jamais attribué à un repo). */
const OUT_OF_SCOPE_WS = "__e2e_hors_perimetre__";

/** Message ACL de l'allowlist FAIL-CLOSED (rôle exécuteur) — le vrai marqueur de régression. */
const ACL_REFUSED = /hors périmètre exécuteur/i;
/** Libellé 403 admin-only (ne doit JAMAIS servir à un refus de périmètre). */
const ADMIN_ONLY = /réservé aux administrateurs/i;
/** Libellé de périmètre attendu sur GET /api/workspaces/:name hors périmètre. */
const PERIMETER = /périmètre/i;

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
  "L'exécuteur accède en LECTURE aux Workspaces de son périmètre (GET /api/workspaces, GET /api/workspaces/:name, GET /api/coder/ide) et les écritures restent 403",
  async ({ page }) => {
    test.skip(
      !EXEC_USERNAME || !EXEC_PASSWORD,
      "Compte exécuteur non provisionné (ECOSYSTEM_E2E_USER_USERNAME / ECOSYSTEM_E2E_USER_PASSWORD) — jamais de faux vert.",
    );

    await login(page, EXEC_USERNAME, EXEC_PASSWORD);

    // --- When/Then : GET /api/workspaces = 200 (l'ACL ne bloque plus la lecture) ---
    const listResp = await page.request.get(`${BASE_URL}/api/workspaces`);
    expect(
      listResp.status(),
      "GET /api/workspaces doit répondre 200 pour l'exécuteur (avant le correctif : 403 « accès refusé — hors périmètre exécuteur »)",
    ).toBe(200);
    const listBody = (await listResp.json()) as { workspaces?: Array<{ name?: string }> };
    const workspaces = listBody.workspaces || [];
    // Le message ne doit jamais être l'ACL FAIL-CLOSED.
    expect(JSON.stringify(listBody)).not.toMatch(ACL_REFUSED);

    // L'onglet Workspaces de l'exécuteur affiche le RÉSULTAT, jamais le libellé
    // admin-only trompeur (A003 : le message serveur réel est affiché).
    await page.click('#tabs button[data-tab="workspaces"]');
    await expect(page.locator("#pane-workspaces")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("#pane-workspaces"),
      "l'onglet Workspaces de l'exécuteur ne doit pas afficher « Réservé aux administrateurs. »",
    ).not.toContainText("Réservé aux administrateurs.");

    // --- Then : refus de périmètre explicite (jamais « réservé aux administrateurs ») ---
    const outResp = await page.request.get(
      `${BASE_URL}/api/workspaces/${encodeURIComponent(OUT_OF_SCOPE_WS)}`,
    );
    expect(
      outResp.status(),
      "GET /api/workspaces/:name d'un workspace HORS périmètre doit répondre 403",
    ).toBe(403);
    const outBody = (await outResp.json()) as { error?: string };
    const outErr = String(outBody.error || "");
    expect(
      outErr,
      `le 403 de périmètre doit porter un message de périmètre explicite — reçu : ${outErr}`,
    ).toMatch(PERIMETER);
    expect(
      outErr,
      `le 403 de périmètre ne doit JAMAIS dire « réservé aux administrateurs » — reçu : ${outErr}`,
    ).not.toMatch(ADMIN_ONLY);

    // --- Then : lecture autorisée d'un workspace DU périmètre ---
    if (workspaces.length > 0) {
      const name = String(workspaces[0].name || "");
      expect(name, "un workspace du périmètre doit avoir un nom").not.toHaveLength(0);

      const showResp = await page.request.get(`${BASE_URL}/api/workspaces/${encodeURIComponent(name)}`);
      expect(
        showResp.status(),
        `GET /api/workspaces/${name} (workspace du périmètre) doit répondre 200`,
      ).toBe(200);

      // GET /api/coder/ide : l'ACL exécuteur ne doit plus le refuser. Idéalement
      // 302 (redirection IDE) ; une erreur CÔTÉ CODER (400/500) prouve aussi que
      // l'ACL est passée. Un 403 ACL est la régression verrouillée.
      const ideResp = await page.request.get(
        `${BASE_URL}/api/coder/ide?url=${encodeURIComponent(`https://coder.example/@user/${name}/`)}`,
        { maxRedirects: 0 },
      );
      const ideBody = await ideResp.text().catch(() => "");
      expect(
        ideResp.status(),
        `GET /api/coder/ide ne doit pas être refusé par l'ACL exécuteur (reçu ${ideResp.status()} — ${ideBody.slice(0, 160)})`,
      ).not.toBe(403);
      expect(ideBody, "pas de refus ACL « hors périmètre exécuteur » sur /api/coder/ide").not.toMatch(ACL_REFUSED);
    }

    // --- Then : les ÉCRITURES restent 403 pour l'exécuteur ---
    const target = workspaces.length > 0 ? String(workspaces[0].name || "") : OUT_OF_SCOPE_WS;
    const writeCases: Array<{ label: string; method: "POST" | "DELETE"; path: string }> = [
      { label: "POST /api/workspaces", method: "POST", path: "/api/workspaces" },
      { label: "POST /api/workspaces/:name/start", method: "POST", path: `/api/workspaces/${encodeURIComponent(target)}/start` },
      { label: "POST /api/workspaces/:name/stop", method: "POST", path: `/api/workspaces/${encodeURIComponent(target)}/stop` },
      { label: "POST /api/workspaces/:name/restart", method: "POST", path: `/api/workspaces/${encodeURIComponent(target)}/restart` },
      { label: "DELETE /api/workspaces/:name", method: "DELETE", path: `/api/workspaces/${encodeURIComponent(target)}` },
    ];
    for (const c of writeCases) {
      const resp = await page.request.fetch(`${BASE_URL}${c.path}`, {
        method: c.method,
        data: c.method === "POST" && c.path === "/api/workspaces" ? {} : undefined,
      });
      expect(
        resp.status(),
        `${c.label} doit rester 403 pour l'exécuteur (écriture admin-only)`,
      ).toBe(403);
    }
  },
);

test(
  "Non-régression — l'administrateur conserve l'accès complet aux Workspaces (GET 200 + actions start/stop/restart/delete)",
  async ({ page }) => {
    test.skip(
      !ADMIN_USERNAME || !ADMIN_PASSWORD,
      "Identifiants admin non provisionnés (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
    );

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // --- Then : GET /api/workspaces = 200, liste non restreinte (projectAccess = null) ---
    const listResp = await page.request.get(`${BASE_URL}/api/workspaces`);
    expect(listResp.status(), "GET /api/workspaces doit répondre 200 pour l'admin").toBe(200);

    // --- Then : l'onglet Workspaces expose la colonne Actions + la création ---
    await page.click('#tabs button[data-tab="workspaces"]');
    const pane = page.locator("#pane-workspaces");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(pane.locator("table")).toBeVisible({ timeout: 15_000 });
    await expect(
      pane.locator("thead th", { hasText: "Actions" }),
      "la colonne Actions (IS_ADMIN) doit être affichée",
    ).toBeVisible();
    await expect(
      pane.locator("#ws-create-btn"),
      "le bouton de création de workspace (admin) doit être disponible",
    ).toBeVisible();

    // Au moins une action de workspace (start|stop|restart|delete) si des
    // workspaces sont listés — les actions restent donc exposées à l'admin.
    const rows = pane.locator("tbody tr");
    if ((await rows.count()) > 0) {
      await expect(
        pane.locator(
          "[data-ws-start], [data-ws-stop], [data-ws-restart], [data-ws-delete]",
        ).first(),
        "les actions start/stop/restart/delete restent exposées à l'admin",
      ).toBeVisible();
    }

    // --- Then : l'admin conserve la LECTURE du détail d'un workspace de son org ---
    // NB : l'admin n'a PAS de filtre par projets (projectAccess = null), mais il
    // reste scopé à son ORGANISATION ACTIVE : `workspaceAccess(projectAccess,
    // activeOrganizationId)` renvoie l'allowlist des workspaces de l'org dès
    // qu'une organisation est active (cf. server.mjs). Un nom INCONNU de l'org
    // est donc refusé en 403 « workspace hors périmètre » — comportement
    // PRÉEXISTANT (l'ancien libellé étant « réservé aux administrateurs »). On
    // n'exécute AUCUNE action destructive et on vérifie :
    //   1) un workspace RÉEL de l'org est lisible en détail (200) par l'admin ;
    //   2) un nom inconnu ne renvoie JAMAIS le refus ACL du rôle exécuteur ni le
    //      libellé admin-only (le garde-fou exécuteur ne concerne pas l'admin).
    const listBody = (await (
      await page.request.get(`${BASE_URL}/api/workspaces`)
    )
      .json()
      .catch(() => ({}))) as { workspaces?: Array<{ name?: string }> };
    const adminWorkspaces = listBody.workspaces || [];
    if (adminWorkspaces.length > 0) {
      const wsName = String(adminWorkspaces[0].name || "");
      expect(wsName, "un workspace de l'org admin doit avoir un nom").not.toHaveLength(0);
      const detailResp = await page.request.get(
        `${BASE_URL}/api/workspaces/${encodeURIComponent(wsName)}`,
      );
      expect(
        detailResp.status(),
        `GET /api/workspaces/${wsName} (workspace réel de l'org) doit répondre 200 pour l'admin`,
      ).toBe(200);
    }

    const outResp = await page.request.get(
      `${BASE_URL}/api/workspaces/${encodeURIComponent(OUT_OF_SCOPE_WS)}`,
    );
    const outErr = String(
      ((await outResp.json().catch(() => ({}))) as { error?: string }).error || "",
    );
    expect(
      outErr,
      "l'admin ne doit jamais recevoir le refus ACL du rôle exécuteur",
    ).not.toMatch(ACL_REFUSED);
    expect(
      outErr,
      "l'admin ne doit jamais recevoir « réservé aux administrateurs » (refus admin-only)",
    ).not.toMatch(ADMIN_ONLY);
  },
);
