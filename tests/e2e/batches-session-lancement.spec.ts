/**
 * E2E — Lancement d'un batch en « session unique » : cohérence clé active
 * fournisseur ↔ modèle déclaré de l'agent `orchestrator`.
 *
 * Entité E2E (1er niveau) : E2E-ECOSYSTEM-1k47rxo
 *   project = ecosystem · repoIds = ['opencode-observability']
 *   specFile = tests/e2e/batches-session-lancement.spec.ts
 *
 * Source : cadrage CT-mudra9eh-tgqa (item 162, bug HIGH « constat 13 »).
 * ADR de référence (Accepté) : ADR-005 — « Sélection des modèles d'exécution des
 * sessions du panneau (cohérence clé active fournisseur ↔ frontmatter des agents) ».
 *
 * ---------------------------------------------------------------------------
 * Feature: Lancement d'un batch en session unique — cohérence clé active
 *          fournisseur ↔ modèle déclaré
 *
 *   Scenario (couvert, oracle) : Modèle déclaré non servi par la clé active
 *     Given un batch actif en mode « session unique » sur un projet de l'écosystème
 *     And l'agent orchestrator déclare le modèle deepseek/deepseek-v4-flash dans son frontmatter
 *     And la clé active du fournisseur ne sert pas ce modèle
 *     When l'administrateur lance la session d'orchestration du batch depuis le panneau
 *     Then le panneau affiche une erreur explicite mentionnant le modèle demandé ET le fournisseur de la clé active
 *      OR  la session démarre avec un modèle compatible (opt-in explicite et tracé)
 *     And aucune session fantôme n'est rattachée au batch (politique A)
 *     And l'échec survient sans attendre un timeout muet
 *
 *   Scenario (documentaire, politique B) : démarrage avec un modèle compatible
 *     Given l'opt-in explicite de fallback modèle est activé et tracé
 *     When l'administrateur lance la session d'orchestration du batch
 *     Then la session démarre avec un modèle compatible servi par la clé active
 *     And le recours au fallback est tracé
 *
 *   Scenario (documentaire, échec réel) : cause remontée depuis stderr
 *     Given l'orchestrator est indisponible ou le modèle est inconnu du catalogue
 *     When l'administrateur lance la session d'orchestration du batch
 *     Then le panneau affiche la cause réelle remontée depuis la sortie du process (stderr)
 *     And aucun blocage silencieux au-delà du timeout n'est observé
 * ---------------------------------------------------------------------------
 *
 * Interdit de non-régression : le lancement ne doit JAMAIS rester muet au-delà
 * du timeout générique (≈ 20 s) en affichant seulement « orchestrator
 * indisponible » — la cause réelle (modèle demandé + fournisseur de la clé
 * active + catalogue servi) doit être remontée.
 *
 * Preuve alternative (sans harness, hors spec) : protocole HTTP
 *   POST /api/batches/:id/session → 400 { code:'MODEL_NOT_SERVED', model, provider, activeProviders }
 *
 * Paramètres (déclarés au registre sur l'entité ; surchargeables au run) :
 *   - baseUrl        (url)     défaut  https://dev.madatalk.fr   — env E2E_BASE_URL
 *   - adminEmail     (secret)  ref     ECOSYSTEM_E2E_ADMIN_EMAIL
 *   - adminPassword  (secret)  ref     ECOSYSTEM_E2E_ADMIN_PASSWORD
 */
import { test, expect, type Page } from "@playwright/test";

// --- Paramètres (cf. e2e_test_param_set de l'entité E2E-ECOSYSTEM-1k47rxo) ---
// Le runner e2e_run pose E2E_BASE_URL ; les secrets du projet sont injectés sous
// leur nom (ECOSYSTEM_E2E_ADMIN_*). Les surcharges paramValues arrivent aussi par nom.
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

// Contexte produit « sous test » : ce que le panneau DOIT dire quand la clé
// active du fournisseur ne sert pas le modèle déclaré de l'agent orchestrator.
const REQUESTED_MODEL = process.env.E2E_REQUESTED_MODEL || "deepseek/deepseek-v4-flash";
const ACTIVE_PROVIDER = process.env.E2E_ACTIVE_PROVIDER || "deepseek";

// Batch cible : laissé vide → premier batch actif en mode « session » du projet.
const TARGET_BATCH_ID = process.env.E2E_BATCH_ID || "";

// Le timeout générique du lancement est d'environ 20 s : au-delà, un silence
// est précisément la régression que l'on verrouille.
const SILENT_TIMEOUT_MS = Number(process.env.E2E_SILENT_TIMEOUT_MS || 25_000);

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.click(".login-submit"),
  ]);
  // Le panneau a chargé l'utilisateur (onglets rendus).
  await expect(page.locator("#tabs")).toBeVisible({ timeout: 15_000 });
}

test("Dans l'écosystème admin, créer un batch en mode session unique avec un fournisseur dont la clé active ne sert pas le modèle déclaré de l'orchestrator : lancer le batch → l'UI affiche une erreur explicite (modèle demandé + fournisseur clé active) OU la session démarre avec un modèle compatible ; jamais un blocage silencieux au-delà du timeout.", async ({
  page,
}) => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    "Identifiants E2E absents (ECOSYSTEM_E2E_ADMIN_EMAIL / ECOSYSTEM_E2E_ADMIN_PASSWORD).",
  );

  await login(page);

  // --- Given : un batch actif en mode « session unique » (surface UI) --------
  // Sélection du batch via l'API (mêmes cookies que la page) puis vérification
  // de sa carte dans le panneau « Cadrage technique ».
  const batchesResp = await page.request.get(`${BASE_URL}/api/batches`);
  expect(batchesResp.ok(), "GET /api/batches doit répondre 200").toBeTruthy();
  const { batches = [] } = (await batchesResp.json()) as { batches?: any[] };

  const candidates = batches.filter(
    (b) => b.status === "active" && (b.launchMode === "session" || b.launchMode === "batch"),
  );
  const batch = TARGET_BATCH_ID
    ? candidates.find((b) => b.batchId === TARGET_BATCH_ID)
    : candidates[0];

  expect(
    batch,
    TARGET_BATCH_ID
      ? `batch ${TARGET_BATCH_ID} actif en mode session introuvable`
      : "aucun batch actif en mode « session » à lancer",
  ).toBeTruthy();

  const sessionBefore: string | null = batch.sessionId || null;

  // Ouverture du projet puis de l'onglet « Cadrage technique » (rend les cartes batch).
  await page.click(`button[data-open-project="${batch.project}"]`);
  await page.click('#tabs button[data-tab="cadrages"]');

  const launchBtn = page.locator(`#pane-cadrages button[data-batch-session="${batch.batchId}"]`);
  await expect(launchBtn, "bouton de lancement de la session d'orchestration du batch").toBeVisible({
    timeout: 15_000,
  });

  // --- When : l'administrateur lance la session d'orchestration du batch -----
  // Two acceptable outcomes (ADR-005) : erreur explicite (politique A par défaut)
  // OU démarrage d'une session avec un modèle compatible (opt-in tracé, politique B).
  let dialogMessage: string | undefined;
  let dialogResolve: (() => void) | undefined;
  const dialogSeen = new Promise<void>((resolve) => {
    dialogResolve = resolve;
  });

  page.on("dialog", async (d) => {
    dialogMessage = d.message();
    dialogResolve?.();
    await d.accept().catch(() => {});
  });

  const popupPromise = page.waitForEvent("popup", { timeout: SILENT_TIMEOUT_MS }).catch(() => null);

  await launchBtn.click();

  const outcome = await Promise.race([
    dialogSeen.then(() => "dialog" as const),
    popupPromise.then((p) => (p ? ("popup" as const) : ("timeout" as const))),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SILENT_TIMEOUT_MS)),
  ]);

  // --- Then : oracle de non-régression --------------------------------------
  if (outcome === "timeout") {
    // Ni erreur explicite, ni session démarrée : blocage silencieux (constat 13).
    throw new Error(
      `Blocage silencieux : aucune erreur explicite ni session démarrée dans les ${SILENT_TIMEOUT_MS} ms ` +
        `au lancement du batch ${batch.batchId} (modèle déclaré ${REQUESTED_MODEL}, fournisseur ${ACTIVE_PROVIDER}).`,
    );
  }

  if (outcome === "popup") {
    // Politique B (opt-in) : une session compatible a démarré → issue acceptée.
    const popup = await popupPromise;
    const url = popup?.url() || "";
    expect(
      /ses_|\/session/i.test(url),
      `session d'orchestration attendue (sessionId dans l'URL) — reçu : ${url}`,
    ).toBeTruthy();
    await popup?.close().catch(() => {});
    return;
  }

  // Politique A (défaut) : erreur explicite → doit nommer le MODÈLE demandé ET
  // le FOURNISSEUR de la clé active (jamais le timeout muet générique).
  const message = dialogMessage || "";
  expect(message, "message d'erreur non vide attendu").not.toHaveLength(0);
  expect(
    message.toLowerCase(),
    `l'erreur doit mentionner le modèle demandé « ${REQUESTED_MODEL} » — reçu : ${message}`,
  ).toContain(REQUESTED_MODEL.toLowerCase());
  expect(
    message.toLowerCase(),
    `l'erreur doit mentionner le fournisseur de la clé active « ${ACTIVE_PROVIDER} » — reçu : ${message}`,
  ).toContain(ACTIVE_PROVIDER.toLowerCase());

  // Aucune session fantôme rattachée au batch (échec propre, politique A).
  const afterResp = await page.request.get(`${BASE_URL}/api/batches/${encodeURIComponent(batch.batchId)}`);
  if (afterResp.ok()) {
    const after = (await afterResp.json()) as { batch?: { sessionId?: string | null } };
    expect(
      after.batch?.sessionId || null,
      "aucune session fantôme ne doit être rattachée au batch après un échec explicite",
    ).toBe(sessionBefore);
  }
});
