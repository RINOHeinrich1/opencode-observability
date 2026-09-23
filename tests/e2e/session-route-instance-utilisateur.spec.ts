import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { test, expect, type Page } from '@playwright/test';

/**
 * E2E — Routage des liens de session opencode depuis l'instance dédiée de
 * l'utilisateur AUTHENTIFIÉ (ADR-006).
 *
 * Entité E2E : E2E-ECOSYSTEM-16oxalj (projet `ecosystem`, repo `opencode-observability`),
 * liée à la tâche T-20260923-073507-rm5y (plan
 * Plan-routage-session-instance-utilisateur-20260923-074104).
 *
 * Extension d'effectivité (tâche T-20260923-143326-vfw7, cadrage CT-mue5oi9p-667h
 * élément 167 / recette RECT-mudv60ay-niqy item 21 ; plan
 * Plan-effectivite-routage-session-instance-20260923-201752, étapes A001–A008) :
 * ce plan NE MODIFIE AUCUN code de production (`public/app.js`, `server.mjs`
 * référencés en LECTURE SEULE). Il renforce la PREUVE E2E et trace l'écart infra.
 *
 * Constat d'origine (recette RECT-mudnzfos-606d, item 17, HIGH ; cadrage
 * CT-mudra9eh-tgqa, constat 17) : une session créée en tant qu'évaluateur `anjary`
 * redirigeait vers l'instance `rino.dev` au lieu de `anjary.dev`. L'identité
 * opencode web reposant sur le cookie navigateur du domaine, cela provoquait une
 * IDENTITÉ CROISÉE.
 *
 * Comportement verrouillé ici :
 *  - `sessionHref`/`sessionLink` (public/app.js l.560-564 / l.548-553) construisent
 *    l'URL depuis `OPENCODE_INSTANCE_URL`, alimenté par `GET /api/me` →
 *    `user.opencodeUrl` (résolu côté serveur via `getUserOpencode(user.id)`,
 *    server.mjs l.1856-1872) ;
 *  - `GET /api/auth-check` (server.mjs l.1821-1828) expose l'en-tête
 *    `X-Opencode-Port` = port de l'instance dédiée : c'est le CONTRAT du routage
 *    nginx dynamique (vhost `oc-<user>.conf` → `http://127.0.0.1:<port>`) ;
 *  - `SESSION_BASE_URL` (servie par `GET /api/config`, server.mjs l.2029 ; env
 *    `SESSION_BASE_URL` l.142) n'est que le FALLBACK pour un utilisateur sans
 *    instance provisionnée ;
 *  - le scénario multi-onglets (cookie résiduel d'un autre compte) ne contamine
 *    jamais l'instance d'un autre utilisateur (isolation par HÔTE du navigateur) ;
 *  - le clic sur `sessionLink(...)` OUVRE réellement un nouvel onglet (popup) dont
 *    l'URL est celle de l'instance dédiée.
 *
 * =========================================================================
 * ÉCART INFRA — préconditions HORS repos (condition de levée = ADMIN/infra)
 * =========================================================================
 * L'acceptance « un utilisateur avec instance provisionnée ouvre bien SA propre
 * instance » dépend de préconditions NON couvrables depuis les repos du projet
 * (opencode-observability / opencode-mcp-task-orchestrator / opencode-scripts) :
 *
 *  1. DNS wildcard `*.dev.madatalk.fr` (aucun enregistrement par utilisateur) ;
 *  2. vhost nginx `/etc/nginx/sites-available/oc-<user>.conf`
 *     (`server_name <user>.dev.madatalk.fr` → `proxy_pass http://127.0.0.1:<port>`,
 *     en-têtes `Upgrade`/`Connection` pour le websocket) + `nginx -t` + reload ;
 *  3. certificat TLS (Let's Encrypt / `certbot --nginx -d <user>.dev.madatalk.fr`) ;
 *  4. service systemd `opencode@<user>` (env `OPENCODE_PORT`, `XDG_DATA_HOME`
 *     isolé par utilisateur) provisionné par
 *     `/root/.config/opencode/scripts/opencode-user-provision.mjs`
 *     (`--user <user> --port <port> --password <pw>`).
 *
 * Ces éléments sont ADMIN/infra et sortent du périmètre des repos. Les scénarios
 * d'EFFECTIVITÉ (A006 instance dédiée / A007 repli) sont donc OPT-IN : ils ne
 * s'exécutent QUE si l'opérateur fournit les paramètres live (`E2E_INSTANCE_LIVE`
 * / `e2eInstanceLive=true`, `E2E_INSTANCE_USER` / `e2eInstanceUser`,
 * `E2E_INSTANCE_BASE_URL` / `e2eInstanceBaseUrl`). Sinon ils se SKIPPENT avec une
 * raison EXPLICITE (jamais de faux vert). Levée de l'écart = ADMIN/infra :
 * provisionner l'instance, vérifier DNS + routage nginx + port, puis relancer les
 * scénarios avec les paramètres live. Incident de traçage : INC-018 (plan-manager).
 * =========================================================================
 *
 * Le spec est AUTO-SUFFISANT pour les scénarios `keep`/mockés : il sert le
 * `index.html` et l'`app.js` RÉELS du dépôt et simule `/api/**` (aucun panneau en
 * marche ni provisioning opencode requis). Les scénarios de CONTRAT (A002/A003)
 * et les SONDES live (A006/A007) s'exécutent contre la cible déployée.
 *
 * Variables d'environnement :
 *  - `PANEL_BASE_URL`   : origine servant la page mockée (défaut http://127.0.0.1:4000) ;
 *  - `PANEL_REPO_DIR`   : racine du dépôt panneau (défaut : cwd, où Playwright est lancé) ;
 *  - `SESSION_BASE_URL` : base globale de repli (défaut https://dev.madatalk.fr) ;
 *  - `PANEL_LIVE_URL`   : cible panneau DÉPLOYÉE (défaut E2E_BASE_URL, sinon
 *                         https://dev.madatalk.fr) — scénarios de contrat/sonde ;
 *  - `ECOSYSTEM_E2E_ADMIN_USERNAME` / `ECOSYSTEM_E2E_ADMIN_PASSWORD` : credentials
 *    admin (sinon skip explicite des scénarios de contrat) ;
 *  - `E2E_INSTANCE_LIVE` (ou `e2eInstanceLive`) : opt-in des sondes d'effectivité ;
 *  - `E2E_INSTANCE_USER` (ou `e2eInstanceUser`) : utilisateur cible de la sonde ;
 *  - `E2E_INSTANCE_BASE_URL` (ou `e2eInstanceBaseUrl`) : base de l'instance cible.
 */

declare function sessionHref(sid: string): string;
declare function sessionLink(sid: string): string;
declare const OPENCODE_INSTANCE_URL: string | null;

const PANEL_BASE_URL = process.env.PANEL_BASE_URL || process.env.E2E_PANEL_BASE_URL || 'http://127.0.0.1:4000';
/** Base GLOBALE de repli, servie par `GET /api/config` (fallback ADR-006). */
const GLOBAL_SESSION_BASE = process.env.SESSION_BASE_URL || 'https://dev.madatalk.fr';
const REPO_ROOT = process.env.PANEL_REPO_DIR || process.cwd();

// --- Cible panneau DÉPLOYÉE (contrats serveur + sondes d'effectivité) --------
const LIVE_PANEL_URL =
  process.env.PANEL_LIVE_URL ||
  process.env.E2E_BASE_URL ||
  process.env.ECOSYSTEM_E2E_BASE_URL ||
  'https://dev.madatalk.fr';
const LIVE_ADMIN_USERNAME =
  process.env.ECOSYSTEM_E2E_ADMIN_USERNAME || process.env.adminUsername || process.env.E2E_USER_USERNAME || '';
const LIVE_ADMIN_PASSWORD =
  process.env.ECOSYSTEM_E2E_ADMIN_PASSWORD || process.env.adminPassword || process.env.E2E_USER_PASSWORD || '';

// --- Paramètres live des sondes d'effectivité (OPT-IN) ----------------------
const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const E2E_INSTANCE_LIVE = truthy(process.env.E2E_INSTANCE_LIVE) || truthy(process.env.e2eInstanceLive);
const E2E_INSTANCE_USER = (process.env.E2E_INSTANCE_USER || process.env.e2eInstanceUser || '').trim();
const E2E_INSTANCE_BASE_URL = (
  process.env.E2E_INSTANCE_BASE_URL ||
  process.env.e2eInstanceBaseUrl ||
  process.env.E2E_INSTANCE_BASE ||
  ''
).trim();

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

// --- Helpers des scénarios live (contrats + sondes d'effectivité) -----------

/** Nettoie une URL de panneau (retire le slash final) pour composer les routes. */
const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Timeout générique d'une promesse (DNS/HTTP) — jamais de blocage silencieux. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${label} — timeout ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); res(v); },
      (e) => { clearTimeout(timer); rej(e); },
    );
  });
}

/** Résolution DNS d'un hôte (preuve que le sous-domaine existe). */
async function probeDns(host: string): Promise<{ address: string; family: number }> {
  const r = await withTimeout(lookup(host), 10_000, `DNS lookup ${host}`);
  return { address: r.address, family: r.family };
}

interface HttpProbeResult {
  status: number;
  location: string | null;
}

/**
 * Requête HTTP(S) GET en lecture seule (aucune écriture, aucun secret loggé).
 * Ne suit PAS les redirections (on veut le statut du premier saut) et tolère un
 * certificat non vérifié (cibles de test). Lève sur erreur réseau/timeout : une
 * cible injoignable est un échec explicite de la sonde, jamais un faux vert.
 */
function probeHttp(urlStr: string, timeoutMs = 15_000): Promise<HttpProbeResult> {
  return new Promise<HttpProbeResult>((res, rej) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      rej(new Error(`URL invalide : ${urlStr}`));
      return;
    }
    const isTls = u.protocol === 'https:';
    const mod = isTls ? httpsRequest : httpRequest;
    const req = mod(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { 'user-agent': 'e2e-session-route-probe', accept: '*/*' },
      },
      (resp) => {
        resp.resume();
        res({ status: resp.statusCode || 0, location: (resp.headers.location as string) || null });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout HTTP ${timeoutMs}ms sur ${urlStr}`)));
    req.on('error', (e) => rej(e));
    req.end();
  });
}

/** Une réponse « non cassée » : ni erreur serveur/upstream (>=500), ni 404 (hôte non routé). */
function expectNonBroken(status: number, label: string): void {
  expect(status, `${label} — réponse HTTP cassée (>=500 : upstream/nginx indisponible)`).toBeLessThan(500);
  expect(status, `${label} — HTTP 404 : hôte NON ROUTÉ (vhost nginx / DNS manquant)`).not.toBe(404);
}

/**
 * Écran « Choisir une organisation » (utilisateur multi-organisations sans org
 * active) : il précède tout accès au panneau. Sélectionne l'org PAR DÉFAUT (★).
 */
async function selectOrganizationIfPrompted(page: Page): Promise<void> {
  const firstPick = page.locator('#modal-backdrop [data-org-pick]').first();
  const appeared = await firstPick
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return; // utilisateur mono-organisation : aucun écran de choix
  const star = page.locator('#modal-backdrop [data-org-pick]', { hasText: '★' }).first();
  const button = (await star.count()) ? star : firstPick;
  await button.click();
  await expect(page.locator('#modal-backdrop')).toBeHidden({ timeout: 15_000 });
}

/** Connexion au panneau DÉPLOYÉ (contrats serveur) avec les credentials admin. */
async function loginLive(page: Page): Promise<void> {
  await page.goto(`${trimSlash(LIVE_PANEL_URL)}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', LIVE_ADMIN_USERNAME);
  await page.fill('#password', LIVE_ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 }),
    page.click('.login-submit'),
  ]);
  await expect(page.locator('#tabs')).toBeVisible({ timeout: 20_000 });
  await selectOrganizationIfPrompted(page);
}

const SID = 'ses_01HZYabc123def456';

const ANJARY: MePayload = { id: 7, username: 'anjary', role: 'evaluateur', opencodeUrl: 'https://anjary.dev.madatalk.fr', opencodePort: 4207 };
const RINO: MePayload = { id: 3, username: 'rino', role: 'evaluateur', opencodeUrl: 'https://rino.dev.madatalk.fr', opencodePort: 4203 };
const SANS_INSTANCE: MePayload = { id: 9, username: 'sansinstance', role: 'executeur', opencodeUrl: null, opencodePort: null };

// --- Motif de refus explicite des scénarios d'effectivité (traçabilité infra) --
const INFRA_SKIP_REASON =
  'infra non provisionnée — nécessite ADMIN/infra : DNS wildcard *.dev.madatalk.fr + vhost nginx oc-<user>.conf → 127.0.0.1:<port> + certbot + systemd opencode@<user> (opencode-user-provision.mjs). ' +
  'Activer avec e2eInstanceLive=true (+ e2eInstanceUser / e2eInstanceBaseUrl). Incident de traçage : INC-018.';

test.describe('Routage session opencode — instance dédiée de l’utilisateur (ADR-006)', () => {
  // =========================================================================
  // Scénarios MOCKÉS (déterministes, sans infra) — chaîne du lien
  // =========================================================================

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

  // =========================================================================
  // A004 — Multi-onglets RENFORCÉ : cookie résiduel dans un MÊME contexte
  // persistant + isolation par hôte (renforce l'ancien test à 2 contextes séparés).
  // =========================================================================
  test('multi-onglets / identité croisée : chaque session ouvre l’instance de SON utilisateur', async ({ browser }) => {
    // UN SEUL contexte persistant : le cookie résiduel du compte précédent est
    // réellement présent au moment où le second compte se connecte (ce que ne
    // reproduisaient pas 2 contextes séparés).
    const context = await browser.newContext();
    try {
      // --- 1) Visite préalable de l'hôte d'un AUTRE utilisateur (rino) ---------
      const pageRino = await context.newPage();
      await mountPanel(pageRino, RINO);
      await openPanel(pageRino);
      const hrefRino = await pageRino.evaluate((s) => sessionHref(s), SID);
      expect(new URL(hrefRino).host).toBe('rino.dev.madatalk.fr');
      // L'identité opencode web repose sur le cookie du DOMAINE de l'instance :
      // on matérialise le cookie résiduel laissé par la visite de rino.dev.
      await context.addCookies([
        { name: 'opencode_session', value: 'rino-residual', domain: 'rino.dev.madatalk.fr', path: '/' },
      ]);

      // --- 2) Reconnexion en anjary dans un NOUVEL onglet, MÊME contexte -------
      const pageAnjary = await context.newPage();
      await mountPanel(pageAnjary, ANJARY);
      await openPanel(pageAnjary);

      const hrefAnjary = await pageAnjary.evaluate((s) => sessionHref(s), SID);
      const urlAnjary = new URL(hrefAnjary);

      // Le cookie résiduel de rino ne doit PAS influencer le routage d'anjary.
      expect(urlAnjary.host).toBe('anjary.dev.madatalk.fr');
      expect(urlAnjary.pathname).toBe(`/server/${b64url('https://anjary.dev.madatalk.fr')}/session/${SID}`);
      expect(hrefAnjary).not.toContain('rino.dev.madatalk.fr');
      expect(urlAnjary.host).not.toBe('dev.madatalk.fr');

      // `sessionLink` (point d'ancrage réel de l'UI) embarque la même instance.
      const htmlAnjary = await pageAnjary.evaluate((s) => sessionLink(s), SID);
      expect(htmlAnjary).toContain('anjary.dev.madatalk.fr');
      expect(htmlAnjary).not.toContain('rino.dev.madatalk.fr');

      // --- 3) Isolation par HÔTE : le cookie de l'hôte A n'est JAMAIS envoyé à B -
      const rinoCookies = await context.cookies('https://rino.dev.madatalk.fr');
      const anjaryCookiesBefore = await context.cookies('https://anjary.dev.madatalk.fr');
      expect(
        rinoCookies.some((c) => c.name === 'opencode_session' && c.value === 'rino-residual'),
        'le cookie de l\'hôte rino doit rester porté par rino.dev uniquement',
      ).toBe(true);
      expect(
        anjaryCookiesBefore.some((c) => c.value === 'rino-residual'),
        'le cookie de l\'hôte rino ne doit JAMAIS être visible pour l\'hôte anjary (isolation par hôte)',
      ).toBe(false);

      // Symétrique : un cookie déposé sur anjary.dev n'est pas visible pour rino.dev.
      await context.addCookies([
        { name: 'opencode_session', value: 'anjary-session', domain: 'anjary.dev.madatalk.fr', path: '/' },
      ]);
      const anjaryCookies = await context.cookies('https://anjary.dev.madatalk.fr');
      const rinoCookiesAfter = await context.cookies('https://rino.dev.madatalk.fr');
      expect(anjaryCookies.find((c) => c.domain === 'anjary.dev.madatalk.fr')?.value).toBe('anjary-session');
      expect(rinoCookiesAfter.some((c) => c.value === 'anjary-session')).toBe(false);
    } finally {
      await context.close();
    }
  });

  // =========================================================================
  // A005 — Ouverture NAVIGATEUR du lien : le clic ouvre un popup vers l'instance.
  // Prouve que le lien S'OUVRE (déclencheur navigateur), sans dépendre de l'infra.
  // =========================================================================
  test('Ouverture du lien de session — le clic sur sessionLink ouvre l\'instance dédiée de l\'utilisateur (popup capturé)', async ({
    context,
    page,
  }) => {
    await mountPanel(page, ANJARY);
    await openPanel(page);

    // Le popup est une NOUVELLE page : une route de CONTEXTE est requise pour
    // répondre à sa navigation (une route de page ne s'applique pas au popup).
    await context.route('**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>instance opencode</title>' }),
    );

    // Rend un lien de session réel (sessionLink) dans le DOM puis clique dessus.
    await page.evaluate((s) => {
      const box = document.createElement('div');
      box.id = 'e2e-session-link';
      box.innerHTML = sessionLink(s);
      document.body.appendChild(box);
    }, SID);

    const anchor = page.locator('#e2e-session-link a');
    await expect(anchor).toBeVisible({ timeout: 10_000 });

    const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 15_000 }), anchor.click()]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});

    const opened = new URL(popup.url());
    expect(opened.origin).toBe('https://anjary.dev.madatalk.fr');
    expect(opened.pathname).toBe(`/server/${b64url('https://anjary.dev.madatalk.fr')}/session/${SID}`);
    // Jamais l'instance d'un autre utilisateur ni la base globale seule.
    expect(opened.host).not.toContain('rino.dev.madatalk.fr');
    expect(opened.host).not.toBe('dev.madatalk.fr');
    await popup.close();
  });

  // =========================================================================
  // A002 — CONTRAT serveur `GET /api/me` : source de vérité du routage (ADR-006).
  // Skip explicite si les credentials admin ne sont pas provisionnés.
  // =========================================================================
  test("Contrat GET /api/me — l'utilisateur authentifié expose son instance dédiée (opencodeUrl = https://<username>.dev.madatalk.fr + opencodePort ; null/null si non provisionné)", async ({
    page,
  }) => {
    test.skip(
      !LIVE_ADMIN_USERNAME || !LIVE_ADMIN_PASSWORD,
      'Credentials admin E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — contrat /api/me non vérifiable. Jamais de faux vert.',
    );

    await loginLive(page);

    const resp = await page.request.get(`${trimSlash(LIVE_PANEL_URL)}/api/me`);
    expect(resp.status(), 'GET /api/me doit répondre 200').toBe(200);
    const body = (await resp.json()) as { user?: MePayload };
    const me = body.user;
    expect(me, '/api/me doit renvoyer un objet user').toBeTruthy();

    // Source de vérité ADR-006 : la base du lien vient de l'utilisateur authentifié.
    if (me!.opencodePort != null) {
      expect(typeof me!.opencodePort, 'opencodePort doit être un entier').toBe('number');
      expect(Number.isInteger(me!.opencodePort)).toBe(true);
      expect(me!.opencodePort).toBeGreaterThan(0);
      expect(me!.opencodePort).toBeLessThan(65536);
      // Dérivation serveur : https://<username>.dev.madatalk.fr (server.mjs l.1856-1872).
      expect(me!.opencodeUrl).toBe(`https://${String(me!.username).toLowerCase()}.dev.madatalk.fr`);
      expect(me!.opencodeUrl).toMatch(/^https:\/\/[a-z0-9-]+\.dev\.madatalk\.fr$/);
    } else {
      // Utilisateur NON provisionné → null/null, le front retombe sur SESSION_BASE_URL.
      expect(me!.opencodeUrl, 'opencodeUrl doit être null quand opencodePort est absent (fallback ADR-006)').toBeNull();
      expect(me!.opencodePort).toBeNull();
    }
  });

  // =========================================================================
  // A003 — CONTRAT serveur `GET /api/auth-check` : en-tête X-Opencode-Port =
  // contrat du routage nginx dynamique (vhost oc-<user>.conf → 127.0.0.1:<port>).
  // =========================================================================
  test("Contrat GET /api/auth-check — l'en-tête X-Opencode-Port porte le port de l'instance dédiée (routage nginx dynamique)", async ({
    page,
  }) => {
    test.skip(
      !LIVE_ADMIN_USERNAME || !LIVE_ADMIN_PASSWORD,
      'Credentials admin E2E absents (ECOSYSTEM_E2E_ADMIN_USERNAME / ECOSYSTEM_E2E_ADMIN_PASSWORD) — contrat /api/auth-check non vérifiable. Jamais de faux vert.',
    );

    await loginLive(page);

    const resp = await page.request.get(`${trimSlash(LIVE_PANEL_URL)}/api/auth-check`);
    expect(resp.status(), 'GET /api/auth-check doit répondre 200 pour un utilisateur authentifié').toBe(200);
    const headers = resp.headers();
    const meResp = await page.request.get(`${trimSlash(LIVE_PANEL_URL)}/api/me`);
    const me = ((await meResp.json()) as { user?: MePayload }).user;

    // X-User = identité authentifiée (contrat nginx).
    expect(headers['x-user'], 'en-tête X-User attendu').toBeTruthy();

    // X-Opencode-Port : présent (chaîne, possiblement vide si non provisionné) et
    // cohérent avec le port exposé par /api/me (source de vérité).
    expect(headers, "l'en-tête X-Opencode-Port doit être présent (contrat du routage nginx)").toHaveProperty(
      'x-opencode-port',
    );
    const headerPort = String(headers['x-opencode-port'] || '');
    if (me && me.opencodePort != null) {
      expect(headerPort, 'X-Opencode-Port doit égaler le port de l\'instance dédiée').toBe(String(me.opencodePort));
    } else {
      expect(headerPort, 'X-Opencode-Port doit être vide quand aucune instance n\'est provisionnée').toBe('');
    }

    const body = (await resp.json()) as { ok?: boolean; user?: string; port?: string };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(headerPort);
  });

  // =========================================================================
  // A006 — SONDES D'EFFECTIVITÉ (OPT-IN, dépendantes infra). Se SKIPPENT
  // explicitement sans paramètres live : jamais de faux vert.
  // =========================================================================

  test("Effectivité instance dédiée (sonde opt-in) — l'URL construite résout (DNS) et ouvre l'instance de l'utilisateur authentifié", async ({
    page,
  }) => {
    test.skip(
      !E2E_INSTANCE_LIVE,
      `Sonde live NON activée (E2E_INSTANCE_LIVE / e2eInstanceLive absent) — ${INFRA_SKIP_REASON}`,
    );

    // Cible : soit l'utilisateur paramétré, soit l'utilisateur authentifié (via /api/me).
    let user = E2E_INSTANCE_USER;
    let base = E2E_INSTANCE_BASE_URL;
    let contractPort: number | null = null;

    if ((!user || !base) && LIVE_ADMIN_USERNAME && LIVE_ADMIN_PASSWORD) {
      await loginLive(page);
      const me = ((await (await page.request.get(`${trimSlash(LIVE_PANEL_URL)}/api/me`)).json()) as { user?: MePayload })
        .user;
      if (me && me.opencodeUrl) {
        user = user || me.username;
        base = base || me.opencodeUrl;
        contractPort = me.opencodePort;
      } else {
        test.skip(true, 'Utilisateur authentifié SANS instance provisionnée (opencodeUrl null) — voir le scénario de repli A007.');
      }
    }

    test.skip(
      !user || !base,
      `Cible d'instance live non résolue (E2E_INSTANCE_USER / E2E_INSTANCE_BASE_URL absents et /api/me sans instance) — ${INFRA_SKIP_REASON}`,
    );

    const instanceUrl = new URL(base!);
    const expectedHost = `${String(user).toLowerCase()}.dev.madatalk.fr`;

    // (3) Identité : la cible est bien l'instance dédiée de CET utilisateur (pas un autre).
    expect(instanceUrl.hostname, `la base cible doit être l'instance dédiée de ${user}`).toBe(expectedHost);
    expect(instanceUrl.origin, "l'instance dédiée ne doit jamais être la base globale de repli").not.toBe(
      new URL(GLOBAL_SESSION_BASE).origin,
    );
    if (contractPort != null) expect(contractPort).toBeGreaterThan(0);

    // (1) DNS : le sous-domaine de l'instance résout.
    const dns = await probeDns(instanceUrl.hostname);
    expect(dns.address, `DNS : ${instanceUrl.hostname} doit résoudre vers une adresse`).toBeTruthy();

    // (2) HTTP : la racine de l'instance répond de façon NON cassée (nginx → upstream vivant).
    //     + le lien de session complet (chemin réellement construit) est servi par la même instance.
    const root = await probeHttp(`${instanceUrl.origin}/`);
    expectNonBroken(root.status, `Instance ${instanceUrl.hostname} (racine)`);

    const sessionPath = `/server/${b64url(instanceUrl.origin)}/session/${SID}`;
    const sessionProbe = await probeHttp(`${instanceUrl.origin}${sessionPath}`);
    expectNonBroken(sessionProbe.status, `Instance ${instanceUrl.hostname} (${sessionPath})`);

    // Trace lisible de la preuve (lecture seule : DNS + GET, aucun secret loggé).
    console.log(
      `[sonde instance dédiée] host=${instanceUrl.hostname} dns=${dns.address} (IPv${dns.family}) ` +
        `root=${root.status} session=${sessionProbe.status} port_contrat=${contractPort ?? 'n/a'}`,
    );
  });

  test('Effectivité du repli (sonde opt-in) — un utilisateur sans instance obtient un lien valide non cassé (SESSION_BASE_URL répond)', async () => {
    test.skip(
      !E2E_INSTANCE_LIVE,
      `Sonde live NON activée (E2E_INSTANCE_LIVE / e2eInstanceLive absent) — ${INFRA_SKIP_REASON}`,
    );

    // Base de repli : SESSION_BASE_URL (réserve ADMIN) — surchargeable pour la sonde.
    const fallbackBase = (
      process.env.E2E_INSTANCE_FALLBACK_BASE_URL ||
      process.env.SESSION_BASE_URL ||
      GLOBAL_SESSION_BASE
    ).trim();
    const fallbackUrl = new URL(fallbackBase);

    // Un utilisateur SANS instance obtient un lien construit sur cette base :
    // on vérifie que la cible du repli est VALIDE (résout et répond), pas seulement la chaîne.
    const dns = await probeDns(fallbackUrl.hostname);
    expect(dns.address, `DNS : l'hôte de repli ${fallbackUrl.hostname} doit résoudre`).toBeTruthy();

    const root = await probeHttp(`${fallbackUrl.origin}/`);
    expectNonBroken(root.status, `Repli ${fallbackUrl.hostname} (racine)`);

    const sessionPath = `/server/${b64url(fallbackUrl.origin)}/session/${SID}`;
    const sessionProbe = await probeHttp(`${fallbackUrl.origin}${sessionPath}`);
    expectNonBroken(sessionProbe.status, `Repli ${fallbackUrl.hostname} (${sessionPath})`);

    console.log(
      `[sonde repli] host=${fallbackUrl.hostname} dns=${dns.address} (IPv${dns.family}) ` +
        `root=${root.status} session=${sessionProbe.status}`,
    );
  });
});
