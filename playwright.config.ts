/**
 * Harness Playwright du panneau (repo opencode-observability) — prérequis
 * d'exécution des specs E2E de l'écosystème (ex.
 * tests/e2e/batches-session-lancement.spec.ts, entité E2E-ECOSYSTEM-1k47rxo).
 *
 * La cible est une instance du panneau DÉJÀ DÉPLOYÉE (défaut : préprod/dev).
 * L'exécution est portée par le CI/CD (jamais par build-notify) — cf.
 * public/docs/07-tests-e2e.md (décision D3).
 *
 * Variables d'environnement :
 *   - E2E_BASE_URL  : cible du panneau (posée par le runner e2e_run) ;
 *   - sinon `baseUrl` (surcharge paramValues) ;
 *   - sinon défaut https://dev.madatalk.fr.
 */
import { defineConfig } from "@playwright/test";

const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.baseUrl ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  "https://dev.madatalk.fr";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/e2e-results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
