/**
 * E2E — Panneau orchestrateur ROBUSTE au STOCKAGE NAVIGATEUR BLOQUÉ.
 *
 * Défaut reproduit (T-20261011-124659-8igl) : `public/app.js` accédait à
 * `localStorage` SANS PROTECTION, y compris AU CHARGEMENT DU MODULE (lignes
 * 12/20-55). Quand le navigateur bloque le stockage (mode privé mobile, cookies
 * bloqués, réglages de confidentialité), l'accès lève
 * `SecurityError: The operation is insecure.` → l'exécution d'app.js s'arrête
 * AVANT `init()` → page MUETTE après connexion (aucun onglet, combo
 * d'organisation vide, bouton « Déconnexion » inerte).
 *
 * Correctif vérifié ici :
 *   1. `safeStorage` (getItem/setItem/removeItem/clear en try/catch + repli
 *      MÉMOIRE) remplace TOUS les accès directs `localStorage` de app.js ;
 *   2. chargement + `init()` sous try/catch → bandeau d'erreur VISIBLE avec
 *      actions (« Recharger » / « Se reconnecter »), jamais de page muette ;
 *   3. bouton « Déconnexion » câblé par délégation d'événement au niveau module
 *      → fonctionne même si `init()` échoue ailleurs.
 *
 * ---------------------------------------------------------------------------
 * Feature: Le panneau reste fonctionnel malgré un stockage navigateur bloqué
 *
 *   Scenario: Stockage bloqué — onglets, organisations et déconnexion
 *     Given un navigateur où `localStorage`/`sessionStorage` LÈVENT à l'accès
 *     And un backend panneau qui répond (/api/me, /api/orgs, /api/config)
 *     When j'ouvre le panneau
 *     Then `#tabs` contient des onglets
 *     And `#org-select` contient des options
 *     And le clic « Déconnexion » navigue vers /login
 *     And aucune `SecurityError` non capturée n'est remontée
 *
 *   Scenario: Stockage normal — non-régression
 *     Given un navigateur avec stockage normal
 *     When j'ouvre le panneau
 *     Then les onglets, les organisations et l'onglet Workspaces s'affichent
 *     And la persistance `localStorage` fonctionne
 *
 *   Scenario: Échec du chargement — message visible (jamais de page muette)
 *     Given /api/me répond 500
 *     When j'ouvre le panneau
 *     Then un bandeau d'erreur VISIBLE propose « Recharger » / « Se reconnecter »
 * ---------------------------------------------------------------------------
 *
 * Ce spec est HERMÉTIQUE : il installe lui-même un serveur statique local
 * (qui sert `public/`) et stubbe les routes `/api/**` côté Playwright. Il ne
 * dépend d'AUCUNE instance déployée ni d'AUCUN identifiant — le défaut est
 * CLIENT et doit être prouvable de façon déterministe, y compris dans le CI.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const PUBLIC_DIR = join(process.cwd(), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    if (rel === "/login") rel = "/login.html"; // miroir de server.mjs
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Simule un navigateur qui BLOQUE le stockage : l'accès à `localStorage` et
 *  `sessionStorage` lève `SecurityError` (comme en mode privé / cookies bloqués). */
async function installBlockedStorage(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const deny = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    try {
      Object.defineProperty(window, "localStorage", { configurable: true, get: deny });
    } catch {
      /* certaines implémentations : repli sur le patch de Storage.prototype */
      try {
        const s = Storage.prototype as unknown as Record<string, unknown>;
        s.getItem = deny;
        s.setItem = deny;
        s.removeItem = deny;
        s.clear = deny;
      } catch { /* ignore */ }
    }
    try {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get: deny });
    } catch { /* ignore */ }
  });
}

interface StubOpts {
  meStatus?: number;
  user?: Record<string, unknown>;
  orgs?: Array<Record<string, unknown>>;
}

/** Stubbe les routes `/api/**`. Le motif générique est enregistré EN PREMIER
 *  (Playwright : la route enregistrée en dernier a priorité). */
async function stubApi(page: Page, opts: StubOpts = {}): Promise<void> {
  const user = opts.user ?? {
    id: "u1",
    username: "admin",
    role: "admin",
    is_admin: true,
    organizations: ["org-default", "org-second"],
    activeOrganizationId: "org-default", // évite la modale de choix
    opencodeUrl: null,
  };
  const orgs = opts.orgs ?? [
    { id: "org-default", name: "Organisation par défaut", isDefault: true },
    { id: "org-second", name: "Seconde organisation", isDefault: false },
  ];

  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/me", (route) => {
    const status = opts.meStatus ?? 200;
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(status === 200 ? { user } : { error: "boom" }),
    });
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ refreshSeconds: 600, sessionBaseUrl: "https://dev.madatalk.fr" }),
    }),
  );
  await page.route("**/api/orgs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ organizations: orgs }),
    }),
  );
  await page.route("**/api/logout", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

test("Stockage bloqué — le panneau reste fonctionnel (onglets, organisations, déconnexion)", async ({
  context,
  page,
}) => {
  await installBlockedStorage(context);
  await stubApi(page);

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });

  // Le stockage est bien BLOQUÉ dans ce contexte (preuve de la condition du test).
  const storageThrows = await page.evaluate(() => {
    try { void (window as unknown as { localStorage: unknown }).localStorage; return false; }
    catch { return true; }
  });
  expect(storageThrows, "le contexte de test doit bien faire LEVER l'accès à localStorage").toBe(true);

  // 1) Onglets présents (app.js a survécu au blocage grâce à safeStorage).
  const tabs = page.locator("#tabs button");
  await expect(tabs.first()).toBeVisible({ timeout: 15_000 });
  expect(await tabs.count(), "#tabs doit contenir des onglets malgré le stockage bloqué").toBeGreaterThan(0);

  // 2) Organisations peuplées.
  const orgOptions = page.locator("#org-select option");
  expect(await orgOptions.count(), "#org-select doit contenir des options malgré le stockage bloqué").toBeGreaterThan(0);

  // 3) « Déconnexion » fonctionne → navigue vers /login.
  await Promise.all([
    page.waitForURL((u) => u.pathname === "/login", { timeout: 15_000 }),
    page.locator("#logout-btn").click(),
  ]);
  expect(new URL(page.url()).pathname).toBe("/login");

  // 4) Aucune SecurityError non capturée remontée.
  expect(
    pageErrors.filter((m) => /insecure|SecurityError/i.test(m)),
    `aucune SecurityError non capturée — reçu : ${JSON.stringify(pageErrors)}`,
  ).toEqual([]);
});

test("Stockage normal — non-régression (onglets, organisations, workspaces, persistance)", async ({ page }) => {
  await stubApi(page);
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });

  const tabs = page.locator("#tabs button");
  await expect(tabs.first()).toBeVisible({ timeout: 15_000 });
  expect(await tabs.count()).toBeGreaterThan(0);
  expect(await page.locator("#org-select option").count()).toBeGreaterThan(0);

  // Admin → onglet Workspaces disponible.
  await expect(page.locator('#tabs button[data-tab="workspaces"]')).toBeVisible();

  // Le stockage réel fonctionne (persistance).
  const roundTrip = await page.evaluate(() => {
    window.localStorage.setItem("panel_eco_tab", "providers");
    return window.localStorage.getItem("panel_eco_tab");
  });
  expect(roundTrip).toBe("providers");
});

test("Échec du chargement — bandeau d'erreur VISIBLE avec actions (jamais de page muette)", async ({ page }) => {
  await stubApi(page, { meStatus: 500 });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });

  const banner = page.locator("#panel-fatal-error");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/recharger/i);
  await expect(banner).toContainText(/reconnecter/i);
  await expect(page.locator("#panel-fatal-reload")).toBeVisible();
  await expect(page.locator("#panel-fatal-logout")).toBeVisible();
});
