import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * E2E — Routage des liens de session opencode depuis l'instance dédiée de
 * l'utilisateur AUTHENTIFIÉ (ADR-006).
 *
 * Entité E2E : E2E-ECOSYSTEM-16oxalj (projet `ecosystem`, repo `opencode-observability`),
 * liée à la tâche T-20260923-073507-rm5y (plan
 * Plan-routage-session-instance-utilisateur-20260923-074104).
 *
 * Constat d'origine (recette RECT-mudnzfos-606d, item 17, HIGH ; cadrage
 * CT-mudra9eh-tgqa, constat 17) : une session créée en tant qu'évaluateur `anjary`
 * redirigeait vers l'instance `rino.dev` au lieu de `anjary.dev`. L'identité
 * opencode web reposant sur le cookie navigateur du domaine, cela provoquait une
 * IDENTITÉ CROISÉE.
 *
 * Comportement verrouillé ici :
 *  - `sessionHref`/`sessionLink` (public/app.js) construisent l'URL depuis
 *    `OPENCODE_INSTANCE_URL`, alimenté par `GET /api/me` → `user.opencodeUrl`
 *    (résolu côté serveur via `getUserOpencode(user.id)`) ;
 *  - `SESSION_BASE_URL` (servie par `GET /api/config`) n'est que le FALLBACK pour
 *    un utilisateur sans instance provisionnée ;
 *  - tous les points d'ancrage (liste des sessions `sessionLink`, boutons
 *    cadrage/recette/tâche `window.open(sessionHref(...))`) passent par ce point
 *    unique et pointent donc vers la MÊME instance dédiée ;
 *  - le scénario multi-onglets (usage préalable d'un autre compte) ne contamine
 *    jamais l'instance d'un autre utilisateur.
 *
 * Le spec est AUTO-SUFFISANT : il sert le `index.html` et l'`app.js` RÉELS du
 * dépôt et simule `/api/**` (aucun panneau en marche ni provisioning opencode
 * requis). Seule dépendance : `@playwright/test` (harnais à fournir par la tâche
 * d'outillage E2E panneau — ce repo n'a ni `playwright.config.*` ni
 * `tests/`, cf. le champ description de l'entité E2E).
 *
 * Variables d'environnement (optionnelles) :
 *  - `PANEL_BASE_URL`   : origine servant la page (défaut http://127.0.0.1:4000) ;
 *  - `PANEL_REPO_DIR`   : racine du dépôt panneau (défaut : cwd, où Playwright est lancé) ;
 *  - `SESSION_BASE_URL` : base globale de repli (défaut https://dev.madatalk.fr).
 */

declare function sessionHref(sid: string): string;
declare function sessionLink(sid: string): string;
declare const OPENCODE_INSTANCE_URL: string | null;

const PANEL_BASE_URL = process.env.PANEL_BASE_URL || process.env.E2E_PANEL_BASE_URL || 'http://127.0.0.1:4000';
/** Base GLOBALE de repli, servie par `GET /api/config` (fallback ADR-006). */
const GLOBAL_SESSION_BASE = process.env.SESSION_BASE_URL || 'https://dev.madatalk.fr';
const REPO_ROOT = process.env.PANEL_REPO_DIR || process.cwd();

const INDEX_HTML = readFileSync(resolve(REPO_ROOT, 'public/index.html'), 'utf8');
const APP_JS = readFileSync(resolve(REPO_ROOT, 'public/app.js'), 'utf8');
const VENDOR_CHART = resolve(REPO_ROOT, 'public/vendor/chart.umd.js');

/** Encode base64url d'une base (identique à `btoa(base).replace(/=+$/, '')`). */
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface MePayload {
  id: number;
  username: string;
  role: string;
  is_admin?: boolean;
  opencodeUrl: string | null;
  opencodePort: number | null;
}

/**
 * Simule le panneau : page + `app.js` réels servis depuis le dépôt, toutes les
 * routes `/api/**` simulées. `user` fait varier l'identité (et donc l'instance
 * opencode dédiée) sans dépendre d'un vrai provisioning.
 */
async function mountPanel(page: Page, user: MePayload): Promise<void> {
  // Défaut neutre (assets non essentiels : css, favicon, …). Enregistré EN
  // PREMIER → les routes plus spécifiques ci-dessous l'emportent (la dernière
  // route enregistrée a la priorité).
  await page.route('**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  await page.route('**/app.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: APP_JS }));
  await page.route('**/vendor/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: existsSync(VENDOR_CHART) ? readFileSync(VENDOR_CHART, 'utf8') : '',
    }),
  );
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { ...user, pages: [] } }),
    }),
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ refreshSeconds: 0, sessionBaseUrl: GLOBAL_SESSION_BASE }),
    }),
  );
  // Document principal (enregistré EN DERNIER → prioritaire).
  await page.route(new RegExp(`^${escapeRe(PANEL_BASE_URL)}/?$`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: INDEX_HTML }),
  );
}

/** Charge le panneau et attend que `init()` ait résolu `/api/me` (ME + whoami posés). */
async function openPanel(page: Page): Promise<void> {
  await page.goto(PANEL_BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const el = document.getElementById('whoami');
    return typeof sessionHref === 'function' && !!el && !!el.textContent && el.textContent.trim().length > 0;
  }, undefined, { timeout: 15000 });
}

const SID = 'ses_01HZYabc123def456';

const ANJARY: MePayload = { id: 7, username: 'anjary', role: 'evaluateur', opencodeUrl: 'https://anjary.dev.madatalk.fr', opencodePort: 4207 };
const RINO: MePayload = { id: 3, username: 'rino', role: 'evaluateur', opencodeUrl: 'https://rino.dev.madatalk.fr', opencodePort: 4203 };
const SANS_INSTANCE: MePayload = { id: 9, username: 'sansinstance', role: 'executeur', opencodeUrl: null, opencodePort: null };

test.describe('Routage session opencode — instance dédiée de l’utilisateur (ADR-006)', () => {
  test('le lien de session vise l’instance dédiée de l’utilisateur connecté (anjary → anjary.dev)', async ({ page }) => {
    await mountPanel(page, ANJARY);
    await openPanel(page);

    // A002 : la variable est alimentée par /api/me.
    expect(await page.evaluate(() => OPENCODE_INSTANCE_URL)).toBe('https://anjary.dev.madatalk.fr');

    const href = await page.evaluate((s) => sessionHref(s), SID);
    const url = new URL(href);

    expect(url.origin).toBe('https://anjary.dev.madatalk.fr');
    expect(url.pathname).toBe(`/server/${b64url('https://anjary.dev.madatalk.fr')}/session/${SID}`);
    // Jamais la base globale seule, jamais l'instance d'un autre utilisateur.
    expect(url.host).not.toBe('dev.madatalk.fr');
    expect(href).not.toContain('rino.dev.madatalk.fr');
  });

  test('sessionLink (liste des sessions) embarque la même instance dédiée', async ({ page }) => {
    await mountPanel(page, ANJARY);
    await openPanel(page);

    const html = await page.evaluate((s) => sessionLink(s), SID);
    const m = html.match(/href="([^"]+)"/);
    expect(m, `sessionLink doit contenir un href — reçu : ${html}`).not.toBeNull();
    const url = new URL(m![1]);
    expect(url.origin).toBe('https://anjary.dev.madatalk.fr');
    expect(url.pathname).toBe(`/server/${b64url('https://anjary.dev.madatalk.fr')}/session/${SID}`);
  });

  test('fallback SESSION_BASE_URL pour un utilisateur sans instance provisionnée', async ({ page }) => {
    await mountPanel(page, SANS_INSTANCE);
    await openPanel(page);

    expect(await page.evaluate(() => OPENCODE_INSTANCE_URL)).toBeNull();

    const href = await page.evaluate((s) => sessionHref(s), SID);
    const url = new URL(href);

    expect(url.origin).toBe(GLOBAL_SESSION_BASE);
    expect(url.pathname).toBe(`/server/${b64url(GLOBAL_SESSION_BASE)}/session/${SID}`);
  });

  test('multi-onglets / identité croisée : chaque session ouvre l’instance de SON utilisateur', async ({ browser }) => {
    const ctxAnjary = await browser.newContext();
    const ctxRino = await browser.newContext();
    try {
      const pageAnjary = await ctxAnjary.newPage();
      const pageRino = await ctxRino.newPage();
      await mountPanel(pageAnjary, ANJARY);
      await mountPanel(pageRino, RINO);
      await Promise.all([openPanel(pageAnjary), openPanel(pageRino)]);

      const [hrefAnjary, hrefRino] = await Promise.all([
        pageAnjary.evaluate((s) => sessionHref(s), SID),
        pageRino.evaluate((s) => sessionHref(s), SID),
      ]);

      expect(new URL(hrefAnjary).host).toBe('anjary.dev.madatalk.fr');
      expect(new URL(hrefRino).host).toBe('rino.dev.madatalk.fr');
      // Aucune contamination croisée : l'instance de l'un n'apparaît jamais chez l'autre.
      expect(hrefAnjary).not.toContain('rino.dev.madatalk.fr');
      expect(hrefRino).not.toContain('anjary.dev.madatalk.fr');
    } finally {
      await ctxAnjary.close();
      await ctxRino.close();
    }
  });
});
