// perf-runner.mjs — Moteur de TESTS STANDARD (préprod) du panneau.
//
// TESTS STANDARD = outils distincts des tests E2E Playwright. Mesure, sur une
// cible PRÉPROD (URL) :
//   1. PARCOURS DE PAGES — informations réseau (durées/statuts/types/tailles,
//      compression) + CAPTURE DES ERREURS CONSOLE (exceptions JS non catchées,
//      warnings) et RÉSEAU (4xx/5xx, DNS, timeouts, requêtes échouées) ;
//   2. TIMINGS  — TTFB, DOMContentLoaded, load ;
//   3. VITALS   — Core Web Vitals (LCP < 2,5 s, INP < 200 ms, CLS < 0,1),
//                 long tasks > 50 ms, temps d'exécution JS ;
//   4. STRESS   — accès PARALLÈLES bornés par ROUTE d'API (débit req/s, latence
//                 moy/p50/p95/p99, taux d'erreurs) + agrégat global.
//
// Le navigateur (Playwright) est résolu depuis le CHECKOUT APPLICATIF `repoDir`
// (ex. /root/mada-talk-preprod) — le panneau n'embarque pas Playwright. Si aucun
// Playwright n'est disponible, la mesure réseau/parcours se fait SANS navigateur
// (fetch) et les Core Web Vitals sont marqués indisponibles (avertissement). Le
// STRESS des routes d'API fonctionne TOUJOURS (fetch, sans navigateur).
//
// CONVERGENCE : ce runner est EXTENSIBLE (blocs network/vitals/stress séparés) —
// il est étendu, jamais dupliqué. BORNÉ : pages ≤ 10, concurrency ≤ 10,
// requests ≤ 200 (parcours global), routes ≤ 20.
//
// Usage : node perf-runner.mjs <payload.json>
//   payload = { evaluationId?, url, pages?, routes?, repoDir?, baseUrl?,
//               concurrency?, requests?, outDir? }
//   `routes` = [{ path|url, method? }] ou ["/api/x", ...] (relatives à baseUrl).
// Sortie : écrit `report.json` + `report.md` dans `outDir` et imprime le JSON
//          du rapport sur stdout.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const MAX_CONCURRENCY = 10;
const MAX_REQUESTS = 200;
const MAX_PAGES = 10;
const MAX_ROUTES = 20;
const NAV_TIMEOUT_MS = 45000;
const LONG_TASK_THRESHOLD_MS = 50;

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function round1(n) { return Math.round(n * 10) / 10; }

// --- Pages & routes (parcours multi-pages / stress par route) ---------------
function normalizePages(payload) {
  const list = [];
  if (payload.url) list.push(String(payload.url));
  if (Array.isArray(payload.pages)) for (const p of payload.pages) { if (p) list.push(String(p)); }
  const uniq = [...new Set(list)].filter((u) => /^https?:\/\//i.test(u));
  return uniq.slice(0, MAX_PAGES);
}

function normalizeRoutes(routes) {
  const out = [];
  if (!Array.isArray(routes)) return out;
  for (const r of routes) {
    if (!r) continue;
    if (typeof r === "string") out.push({ path: r.trim(), method: "GET", name: null });
    else if (typeof r === "object") out.push({ path: String(r.path || r.url || "").trim(), method: String(r.method || "GET").toUpperCase(), name: r.name ? String(r.name) : null });
  }
  return out.filter((r) => r.path).slice(0, MAX_ROUTES);
}

// Résout une route (relative à baseUrl, ou absolue) en URL.
function resolveRouteUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return String(baseUrl).replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

// Résout Playwright depuis le checkout applicatif (puis, à défaut, depuis le
// panneau lui-même). Retourne { chromium } ou null.
async function resolvePlaywright(repoDir) {
  const candidates = [];
  if (repoDir) candidates.push(join(String(repoDir), "package.json"));
  candidates.push(join(dirname(new URL(import.meta.url).pathname), "package.json"));
  for (const pkg of candidates) {
    for (const mod of ["playwright", "playwright-core"]) {
      try {
        const req = createRequire(pkg);
        const resolved = req.resolve(mod);
        const imported = await import(pathToFileURL(resolved).href);
        const pw = imported.default || imported;
        if (pw && pw.chromium) return pw;
      } catch { /* tente le suivant */ }
    }
  }
  return null;
}

// --- 3. Core Web Vitals : seuils + script d'instrumentation ----------------
function rateLcp(v) { if (v == null) return null; return v < 2500 ? "good" : v < 4000 ? "needs-improvement" : "poor"; }
function rateInp(v) { if (v == null) return null; return v < 200 ? "good" : v < 500 ? "needs-improvement" : "poor"; }
function rateCls(v) { if (v == null) return null; return v < 0.1 ? "good" : v < 0.25 ? "needs-improvement" : "poor"; }

// Injecté AVANT tout script de page : observe LCP, CLS, INP (event/first-input),
// long tasks > `threshold` ms et accumule le temps d'exécution JS bloquant.
function vitalsInitScript(threshold) {
  window.__perfVitals = { lcpMs: null, inpMs: null, cls: 0, longTasks: [], longTasksMs: 0, jsExecMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perfVitals.lcpMs = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* non supporté */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { if (!e.hadRecentInput) window.__perfVitals.cls += e.value; }
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* non supporté */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= threshold) {
          window.__perfVitals.longTasks.push({ startTime: Math.round(e.startTime * 10) / 10, durationMs: Math.round(e.duration * 10) / 10 });
          window.__perfVitals.longTasksMs += e.duration;
          window.__perfVitals.jsExecMs += e.duration;
        }
      }
      if (window.__perfVitals.longTasks.length > 100) window.__perfVitals.longTasks = window.__perfVitals.longTasks.slice(-100);
    }).observe({ type: "longtask", buffered: true });
  } catch { /* non supporté */ }
  const trackInp = (list) => {
    for (const e of list.getEntries()) {
      const d = e.duration || 0;
      if (window.__perfVitals.inpMs === null || d > window.__perfVitals.inpMs) window.__perfVitals.inpMs = d;
    }
  };
  try { new PerformanceObserver(trackInp).observe({ type: "event", buffered: true, durationThreshold: 40 }); } catch { /* non supporté */ }
  try { new PerformanceObserver(trackInp).observe({ type: "first-input", buffered: true }); } catch { /* non supporté */ }
}

// Agrège les vitals d'un parcours multi-pages en pire-cas (max) + total JS.
function aggregateVitals(byPage) {
  const entries = Object.values(byPage || {}).filter(Boolean);
  if (!entries.length) return null;
  let lcpMs = null, inpMs = null, cls = 0, longTasksMs = 0, jsExecMs = 0;
  const longTasks = [];
  for (const v of entries) {
    if (v.lcpMs != null) lcpMs = lcpMs == null ? v.lcpMs : Math.max(lcpMs, v.lcpMs);
    if (v.inpMs != null) inpMs = inpMs == null ? v.inpMs : Math.max(inpMs, v.inpMs);
    cls = Math.max(cls, Number(v.cls) || 0);
    longTasksMs += Number(v.longTasksMs) || 0;
    jsExecMs += Number(v.jsExecMs) || 0;
    if (Array.isArray(v.longTasks)) longTasks.push(...v.longTasks);
  }
  return {
    lcpMs: lcpMs == null ? null : round1(lcpMs),
    inpMs: inpMs == null ? null : round1(inpMs),
    cls: Math.round(cls * 1000) / 1000,
    longTasksCount: longTasks.length,
    longTasksMs: round1(longTasksMs),
    jsExecMs: round1(jsExecMs),
    longTasks: longTasks.slice(0, 100),
    ratings: { lcp: rateLcp(lcpMs), inp: rateInp(inpMs), cls: rateCls(cls) },
  };
}

// --- A004. Métriques réseau par type + poids total + compression ------------
function resourceKind(resourceType) {
  const t = String(resourceType || "").toLowerCase();
  if (t === "document") return "documents";
  if (t === "script") return "js";
  if (t === "stylesheet") return "css";
  if (t === "image") return "images";
  if (t === "font") return "fonts";
  if (t === "xhr" || t === "fetch") return "xhr";
  if (t === "media") return "media";
  if (t === "manifest") return "manifest";
  return t ? t : "other";
}

function summarizeNetwork(network) {
  const byType = {};
  let totalBytes = 0, totalRequests = 0;
  let compressed = 0, uncompressed = 0, unknown = 0;
  let durationSum = 0, durationCount = 0;
  for (const n of network) {
    const kind = resourceKind(n.resourceType);
    const b = byType[kind] || (byType[kind] = { count: 0, bytes: 0, durationMs: 0 });
    const bytes = Number(n.sizeBytes) || 0;
    b.count += 1;
    b.bytes += bytes;
    totalBytes += bytes;
    totalRequests += 1;
    if (typeof n.durationMs === "number") { b.durationMs += n.durationMs; durationSum += n.durationMs; durationCount += 1; }
    const enc = n.contentEncoding;
    if (enc === null || enc === undefined) unknown += 1;
    else if (String(enc).trim() === "" || String(enc).toLowerCase() === "identity") uncompressed += 1;
    else compressed += 1;
  }
  for (const k of Object.keys(byType)) byType[k].durationMs = round1(byType[k].durationMs);
  return {
    byType,
    totalRequests,
    totalBytes,
    avgDurationMs: durationCount ? round1(durationSum / durationCount) : 0,
    compression: {
      compressed,
      uncompressed,
      unknown,
      ratio: totalRequests ? Math.round((compressed / totalRequests) * 1000) / 10 : 0,
    },
  };
}

// --- A005. Classification des erreurs réseau (4xx/5xx/DNS/timeouts) ----------
function classifyFailure(errorText) {
  const t = String(errorText || "").toLowerCase();
  if (t.includes("name_not_resolved") || t.includes("name_resolution") || t.includes("dns") || t.includes("getaddrinfo")) return "dns";
  if (t.includes("timed_out") || t.includes("timeout")) return "timeouts";
  if (t.includes("connection_refused") || t.includes("connection_reset") || t.includes("connection_closed") || t.includes("connection_aborted") || t.includes("connection_failed")) return "connection";
  if (t.includes("aborted")) return "aborted";
  return "other";
}

// Combine les statuts 4xx/5xx (requêtes terminées) et les échecs de requête
// (requestfailed : DNS/timeouts/connexion) en un rapport catégorisé.
function classifyNetworkErrors(network, failedRequests = []) {
  const items = [];
  let by4xx = 0, by5xx = 0, dns = 0, timeouts = 0, connection = 0, aborted = 0, other = 0;
  for (const n of network) {
    if (typeof n.status === "number" && n.status >= 400) {
      const cat = n.status >= 500 ? "5xx" : "4xx";
      if (cat === "5xx") by5xx += 1; else by4xx += 1;
      items.push({ kind: cat, category: cat, page: n.page || null, url: n.url, method: n.method, resourceType: n.resourceType, status: n.status });
    }
  }
  for (const f of failedRequests) {
    const category = classifyFailure(f.errorText);
    if (category === "dns") dns += 1;
    else if (category === "timeouts") timeouts += 1;
    else if (category === "connection") connection += 1;
    else if (category === "aborted") aborted += 1;
    else other += 1;
    items.push({ kind: "failed", category, page: f.page || null, url: f.url, method: f.method, resourceType: f.resourceType, errorText: f.errorText });
  }
  return { total: items.length, by4xx, by5xx, dns, timeouts, connection, aborted, other, items };
}

// --- A001/A002. Capture navigateur : réseau + console + pageerror + failed ---
function attachPageCapture(page, pageUrl, collector) {
  // A001 — erreurs console (warnings + exceptions JS non catchées).
  page.on("console", (msg) => {
    try {
      const level = msg.type();
      if (level === "warning" || level === "error") {
        collector.console.push({ page: pageUrl, level, text: String(msg.text()).slice(0, 500), location: (() => { try { return msg.location(); } catch { return null; } })() });
      }
    } catch { /* ignore */ }
  });
  page.on("pageerror", (err) => {
    collector.pageErrors.push({ page: pageUrl, message: String((err && err.message) || err).slice(0, 500), stack: String((err && err.stack) || "").slice(0, 1000) });
  });
  page.on("requestfailed", (request) => {
    try {
      const failure = request.failure();
      collector.failedRequests.push({ page: pageUrl, url: request.url(), method: request.method(), resourceType: request.resourceType(), errorText: failure ? failure.errorText : "unknown" });
    } catch { /* ignore */ }
  });
  // A002 — entrée réseau enrichie (contentEncoding + page).
  page.on("requestfinished", async (request) => {
    try {
      const response = await request.response();
      const timing = request.timing();
      const duration = timing && timing.responseEnd >= timing.startTime ? timing.responseEnd - timing.startTime : null;
      let size = 0, contentEncoding = null;
      try {
        const headers = response ? response.headers() : null;
        if (headers) {
          const cl = headers["content-length"];
          size = cl ? Number(cl) : 0;
          contentEncoding = headers["content-encoding"] != null ? headers["content-encoding"] : null;
        }
      } catch { size = 0; }
      collector.network.push({
        page: pageUrl,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response ? response.status() : null,
        durationMs: duration === null ? null : round1(duration),
        sizeBytes: Number.isFinite(size) ? size : 0,
        contentEncoding,
      });
    } catch { /* requête abandonnée */ }
  });
}

// Parcours multi-pages : un navigateur, une page par URL, captures agrégées.
async function browserMeasure(pw, urls) {
  const warnings = [];
  const collector = { network: [], console: [], pageErrors: [], failedRequests: [] };
  const vitalsByPage = {};
  const timingsByPage = {};
  const browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    for (const url of urls) {
      const page = await context.newPage();
      attachPageCapture(page, url, collector);
      await page.addInitScript(vitalsInitScript, LONG_TASK_THRESHOLD_MS);
      try {
        await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
        // Laisse le temps au LCP/CLS/INP de se stabiliser (borné).
        await page.waitForTimeout(1500);
        timingsByPage[url] = await page.evaluate(() => {
          const e = performance.getEntriesByType("navigation")[0] || {};
          return { ttfbMs: e.responseStart || null, domContentLoadedMs: e.domContentLoadedEventEnd || null, loadMs: e.loadEventEnd || null };
        });
        const v = await page.evaluate(() => window.__perfVitals || null);
        if (v) {
          vitalsByPage[url] = {
            lcpMs: v.lcpMs === null || v.lcpMs === undefined ? null : round1(v.lcpMs),
            inpMs: v.inpMs === null || v.inpMs === undefined ? null : round1(v.inpMs),
            cls: Math.round((v.cls || 0) * 1000) / 1000,
            longTasks: Array.isArray(v.longTasks) ? v.longTasks : [],
            longTasksMs: round1(v.longTasksMs || 0),
            jsExecMs: round1(v.jsExecMs || 0),
          };
        }
      } catch (e) {
        warnings.push(`Navigation en échec pour ${url} (${String((e && e.message) || e).slice(0, 200)}).`);
      } finally {
        try { await page.close(); } catch { /* ignore */ }
      }
    }
    await context.close();
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  const lastUrl = urls[urls.length - 1];
  return {
    pages: urls,
    network: collector.network,
    console: collector.console,
    pageErrors: collector.pageErrors,
    failedRequests: collector.failedRequests,
    timings: timingsByPage[lastUrl] || Object.values(timingsByPage)[0] || null,
    timingsByPage,
    vitals: aggregateVitals(vitalsByPage),
    vitalsByPage,
    warnings,
  };
}

// Repli SANS navigateur : parcours réseau via fetch (durées/statuts/tailles,
// compression) + erreurs réseau. Pas de console/JS (indisponibles sans navigateur).
async function fetchNetworkMeasure(urls) {
  const network = [], failedRequests = [];
  const timingsByPage = {};
  const warnings = [];
  for (const url of urls) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { redirect: "follow" });
      const body = await res.arrayBuffer();
      let enc = null;
      try { enc = res.headers.get("content-encoding"); } catch { enc = null; }
      const dur = round1(performance.now() - t0);
      network.push({ page: url, url, method: "GET", resourceType: "document", status: res.status, durationMs: dur, sizeBytes: body.byteLength, contentEncoding: enc });
      timingsByPage[url] = { ttfbMs: null, domContentLoadedMs: null, loadMs: dur };
    } catch (e) {
      const msg = String((e && e.message) || e);
      failedRequests.push({ page: url, url, method: "GET", resourceType: "document", errorText: msg });
      warnings.push(`Mesure fetch en échec pour ${url} (${msg.slice(0, 200)}).`);
    }
  }
  const lastUrl = urls[urls.length - 1];
  return {
    pages: urls,
    network,
    console: [],
    pageErrors: [],
    failedRequests,
    timings: timingsByPage[lastUrl] || Object.values(timingsByPage)[0] || null,
    timingsByPage,
    vitals: null,
    vitalsByPage: {},
    warnings,
  };
}

// --- A006. STRESS borné PAR ROUTE d'API (accès parallèles) -----------------
async function stressOneRoute(route, url, concurrency, requests) {
  const latencies = [];
  let ok = 0, errors = 0, issued = 0;
  const statusCounts = {};
  const started = Date.now();
  const worker = async () => {
    while (issued < requests) {
      issued += 1;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { redirect: "follow", method: route.method });
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
        if (res.ok) ok += 1; else errors += 1;
      } catch {
        latencies.push(performance.now() - t0);
        errors += 1;
        statusCounts.error = (statusCounts.error || 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
  const wallMs = Date.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : 0;
  return {
    route: route.name || route.path,
    path: route.path,
    method: route.method,
    url,
    requests,
    completed: latencies.length,
    ok,
    errors,
    errorRate: latencies.length ? Math.round((errors / latencies.length) * 1000) / 10 : 0,
    wallMs,
    rps: wallMs > 0 ? Math.round((latencies.length / (wallMs / 1000)) * 10) / 10 : 0,
    latencyMs: {
      avg: round1(avg),
      p50: round1(percentile(sorted, 0.5)),
      p95: round1(percentile(sorted, 0.95)),
      p99: round1(percentile(sorted, 0.99)),
      max: round1(sorted.length ? sorted[sorted.length - 1] : 0),
    },
    statusCounts,
    _latencies: latencies,
  };
}

// Stress par route + agrégat global. Le budget total `requests` est réparti sur
// les routes (borné à MAX_REQUESTS) ; les routes sont stressées séquentiellement
// (parallélisme borné par `concurrency`) pour ne pas dégrader la préprod.
async function stressRoutes(baseUrl, routes, concurrency, totalRequests) {
  const list = normalizeRoutes(routes);
  if (!list.length) return null;
  const perRoute = Math.max(1, Math.floor(totalRequests / list.length));
  const routeResults = [];
  const allLatencies = [];
  let gOk = 0, gErrors = 0, gCompleted = 0, gWall = 0, gRequests = 0;
  const gStatus = {};
  for (const route of list) {
    const url = resolveRouteUrl(baseUrl, route.path);
    let r;
    try {
      r = await stressOneRoute(route, url, concurrency, perRoute);
    } catch (e) {
      r = {
        route: route.name || route.path, path: route.path, method: route.method, url,
        requests: perRoute, completed: 0, ok: 0, errors: perRoute, errorRate: 100,
        wallMs: 0, rps: 0, latencyMs: { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        statusCounts: {}, _latencies: [], error: String((e && e.message) || e),
      };
    }
    allLatencies.push(...(r._latencies || []));
    gOk += r.ok; gErrors += r.errors; gCompleted += r.completed; gRequests += r.requests;
    gWall = Math.max(gWall, r.wallMs);
    for (const [s, c] of Object.entries(r.statusCounts || {})) gStatus[s] = (gStatus[s] || 0) + c;
    const { _latencies, ...pub } = r;
    routeResults.push(pub);
  }
  const sorted = [...allLatencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : 0;
  const global = {
    routeCount: list.length,
    requests: gRequests,
    completed: gCompleted,
    ok: gOk,
    errors: gErrors,
    errorRate: gCompleted ? Math.round((gErrors / gCompleted) * 1000) / 10 : 0,
    wallMs: gWall,
    rps: gWall > 0 ? Math.round((gCompleted / (gWall / 1000)) * 10) / 10 : 0,
    latencyMs: {
      avg: round1(avg),
      p50: round1(percentile(sorted, 0.5)),
      p95: round1(percentile(sorted, 0.95)),
      p99: round1(percentile(sorted, 0.99)),
      max: round1(sorted.length ? sorted[sorted.length - 1] : 0),
    },
    statusCounts: gStatus,
  };
  // `...global` conserve la rétrocompatibilité des lecteurs historiques
  // (`stress.requests`, `stress.rps`, `stress.latencyMs.p95`…).
  return { concurrency, requestsPerRoute: perRoute, routes: routeResults, global, ...global };
}

// --- A008. Synthèse + rapport markdown -------------------------------------
function buildSummary(report) {
  const parts = [];
  const t = report.timings;
  if (t && t.ttfbMs != null) parts.push(`TTFB ${round1(t.ttfbMs)}ms`);
  if (t && t.loadMs != null) parts.push(`load ${round1(t.loadMs)}ms`);
  const v = report.vitals;
  if (v && v.lcpMs != null) parts.push(`LCP ${v.lcpMs}ms${v.ratings && v.ratings.lcp ? ` (${v.ratings.lcp})` : ""}`);
  if (v && v.inpMs != null) parts.push(`INP ${v.inpMs}ms${v.ratings && v.ratings.inp ? ` (${v.ratings.inp})` : ""}`);
  if (v && v.cls != null) parts.push(`CLS ${v.cls}${v.ratings && v.ratings.cls ? ` (${v.ratings.cls})` : ""}`);
  const ne = report.networkErrors;
  if (ne && ne.total) parts.push(`erreurs réseau ${ne.total} (4xx ${ne.by4xx}, 5xx ${ne.by5xx}, DNS ${ne.dns}, timeout ${ne.timeouts})`);
  if (report.page && report.page.console && report.page.console.length) parts.push(`console ${report.page.console.length}`);
  if (report.page && report.page.pageErrors && report.page.pageErrors.length) parts.push(`exceptions JS ${report.page.pageErrors.length}`);
  if (report.stress && report.stress.global) parts.push(`stress ${report.stress.global.routeCount} route(s) ${report.stress.global.requests}@${report.stress.concurrency} → ${report.stress.global.rps} req/s, p95 ${report.stress.global.latencyMs.p95}ms, erreurs ${report.stress.global.errorRate}%`);
  return `${report.target.url} — ${parts.join(" · ") || "aucune mesure"}`;
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# Rapport de tests standard — ${report.target.url}`);
  lines.push("");
  lines.push(`- Démarré : ${report.startedAt}`);
  lines.push(`- Terminé : ${report.finishedAt} (${report.durationMs} ms)`);
  if (report.target.pages && report.target.pages.length > 1) lines.push(`- Parcours : ${report.target.pages.length} page(s)`);
  if (report.target.repoDir) lines.push(`- Checkout applicatif : \`${report.target.repoDir}\``);
  lines.push("");
  lines.push(`**Synthèse** : ${report.summary}`);
  lines.push("");
  lines.push("## Timings");
  if (report.timings) {
    lines.push(`- TTFB : ${report.timings.ttfbMs ?? "n/a"} ms`);
    lines.push(`- DOMContentLoaded : ${report.timings.domContentLoadedMs ?? "n/a"} ms`);
    lines.push(`- Load : ${report.timings.loadMs ?? "n/a"} ms`);
  } else { lines.push("- (indisponibles)"); }
  lines.push("");
  lines.push("## Core Web Vitals");
  if (report.vitals) {
    lines.push(`- LCP : ${report.vitals.lcpMs ?? "n/a"} ms${report.vitals.ratings && report.vitals.ratings.lcp ? ` (${report.vitals.ratings.lcp})` : ""} — seuil 2500 ms`);
    lines.push(`- INP : ${report.vitals.inpMs ?? "n/a"} ms${report.vitals.ratings && report.vitals.ratings.inp ? ` (${report.vitals.ratings.inp})` : ""} — seuil 200 ms`);
    lines.push(`- CLS : ${report.vitals.cls}${report.vitals.ratings && report.vitals.ratings.cls ? ` (${report.vitals.ratings.cls})` : ""} — seuil 0,1`);
    lines.push(`- Long tasks > 50 ms : ${report.vitals.longTasksCount ?? (report.vitals.longTasks || []).length} (${report.vitals.longTasksMs} ms) — temps d'exécution JS : ${report.vitals.jsExecMs} ms`);
  } else { lines.push("- (indisponibles — Playwright absent ou cible non navigable)"); }
  lines.push("");
  lines.push("## Réseau par type");
  const nt = report.networkByType || {};
  lines.push("| Type | Requêtes | Poids (o) | Durée cumulée (ms) |");
  lines.push("|---|---|---|---|");
  for (const [k, v] of Object.entries(nt)) lines.push(`| ${k} | ${v.count} | ${v.bytes} | ${v.durationMs} |`);
  if (!Object.keys(nt).length) lines.push("| - | - | - | - |");
  lines.push("");
  lines.push(`- Poids total chargé : ${report.totalBytes ?? 0} o`);
  const comp = report.compression || {};
  lines.push(`- Compression : ${comp.compressed ?? 0} compressée(s) · ${comp.uncompressed ?? 0} non compressée(s) · ${comp.unknown ?? 0} inconnue(s) (${comp.ratio ?? 0} %)`);
  lines.push("");
  lines.push("## Erreurs console & JavaScript");
  const consoleMsgs = (report.page && report.page.console) || [];
  const pageErrors = (report.page && report.page.pageErrors) || [];
  if (pageErrors.length) {
    lines.push(`**Exceptions JS non catchées (${pageErrors.length}) :**`);
    for (const e of pageErrors.slice(0, 50)) lines.push(`- [${e.page}] ${String(e.message).replace(/\n/g, " ")}`);
  }
  if (consoleMsgs.length) {
    lines.push(`**Console (warnings/erreurs) (${consoleMsgs.length}) :**`);
    for (const c of consoleMsgs.slice(0, 50)) lines.push(`- [${c.level}] [${c.page}] ${String(c.text).replace(/\n/g, " ")}`);
  }
  if (!pageErrors.length && !consoleMsgs.length) lines.push("- (aucune erreur console/JS capturée)");
  lines.push("");
  lines.push("## Erreurs réseau");
  const ne = report.networkErrors || { total: 0, items: [] };
  lines.push(`- Total : ${ne.total} (4xx ${ne.by4xx || 0} · 5xx ${ne.by5xx || 0} · DNS ${ne.dns || 0} · timeouts ${ne.timeouts || 0} · connexion ${ne.connection || 0} · autres ${ne.other || 0})`);
  if (ne.items && ne.items.length) {
    lines.push("| Catégorie | Statut | Méthode | Type | URL |");
    lines.push("|---|---|---|---|---|");
    for (const it of ne.items.slice(0, 100)) {
      lines.push(`| ${it.category} | ${it.status ?? (it.errorText || "-")} | ${it.method || "-"} | ${it.resourceType || "-"} | ${String(it.url).replace(/\|/g, "%7C")} |`);
    }
  }
  lines.push("");
  lines.push("## Requêtes réseau (durées par requête)");
  lines.push("| Statut | Type | Durée (ms) | Taille (o) | Compression | URL |");
  lines.push("|---|---|---|---|---|---|");
  for (const n of (report.network || []).slice(0, 200)) {
    lines.push(`| ${n.status ?? "-"} | ${n.resourceType || "-"} | ${n.durationMs ?? "-"} | ${n.sizeBytes ?? "-"} | ${n.contentEncoding ?? "-"} | ${String(n.url).replace(/\|/g, "%7C")} |`);
  }
  if (!(report.network || []).length) lines.push("| - | - | - | - | - | (aucune requête capturée) |");
  lines.push("");
  lines.push("## Stress test par route d'API (accès parallèles bornés)");
  const stress = report.stress;
  if (stress && stress.routes && stress.routes.length) {
    lines.push(`- Concurrence : ${stress.concurrency} — requêtes/route : ${stress.requestsPerRoute} — routes : ${stress.global.routeCount}`);
    lines.push("");
    lines.push("| Route | Méthode | Req | OK | Err | Err % | req/s | moy | p50 | p95 | p99 | max |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of stress.routes) {
      lines.push(`| ${String(r.route).replace(/\|/g, "%7C")} | ${r.method} | ${r.requests} | ${r.ok} | ${r.errors} | ${r.errorRate} | ${r.rps} | ${r.latencyMs.avg} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} |`);
    }
    lines.push("");
    const g = stress.global;
    lines.push(`**Agrégat global** — débit ${g.rps} req/s · latence moy ${g.latencyMs.avg} ms / p95 ${g.latencyMs.p95} ms / p99 ${g.latencyMs.p99} ms · erreurs ${g.errors} (${g.errorRate} %) · durée ${g.wallMs} ms`);
  } else { lines.push("- (non exécuté)"); }
  if (report.warnings && report.warnings.length) {
    lines.push("");
    lines.push("## Avertissements");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}

// --- A007. Assemblage du rapport (main) ------------------------------------
async function main() {
  const payloadFile = process.argv[2];
  if (!payloadFile) { console.error("usage: node perf-runner.mjs <payload.json>"); process.exit(1); }
  const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  const urls = normalizePages(payload);
  if (!urls.length) { console.error("url préprod requise (http/https)"); process.exit(2); }
  const url = urls[0];
  const concurrency = clampInt(payload.concurrency, 1, MAX_CONCURRENCY, 5);
  const requests = clampInt(payload.requests, 1, MAX_REQUESTS, 50);
  const repoDir = payload.repoDir ? String(payload.repoDir) : null;
  const outDir = payload.outDir ? String(payload.outDir) : join(dirname(payloadFile), "perf-out");
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings = [];

  // Parcours de pages : navigateur (Playwright) sinon repli fetch.
  let measured;
  const pw = await resolvePlaywright(repoDir);
  if (pw) {
    try {
      measured = await browserMeasure(pw, urls);
    } catch (e) {
      warnings.push(`Mesure navigateur en échec (${String((e && e.message) || e).slice(0, 200)}) — repli fetch.`);
      measured = await fetchNetworkMeasure(urls);
    }
  } else {
    warnings.push(repoDir
      ? `Playwright introuvable dans ${repoDir} — Core Web Vitals/console indisponibles, mesure réseau via fetch.`
      : "Aucun repoDir (Playwright) fourni — Core Web Vitals/console indisponibles, mesure réseau via fetch.");
    measured = await fetchNetworkMeasure(urls);
  }
  warnings.push(...(measured.warnings || []));

  const network = measured.network || [];
  const consoleMsgs = measured.console || [];
  const pageErrors = measured.pageErrors || [];
  const netSummary = summarizeNetwork(network);
  const netErrors = classifyNetworkErrors(network, measured.failedRequests || []);

  // Stress des routes d'API : routes fournies, sinon repli sur la page cible.
  const routes = normalizeRoutes(payload.routes);
  const stressTargets = routes.length ? routes : [{ path: url, method: "GET", name: url }];
  const baseUrl = payload.baseUrl || url;
  let stress = null;
  try {
    stress = await stressRoutes(baseUrl, stressTargets, concurrency, requests);
  } catch (e) {
    warnings.push(`Stress test en échec : ${String((e && e.message) || e).slice(0, 200)}`);
  }

  const finishedAt = new Date().toISOString();
  const report = {
    ok: true,
    target: { url, pages: urls, repoDir, baseUrl: payload.baseUrl || null },
    startedAt, finishedAt, durationMs: Date.now() - t0,
    // Parcours : réseau + erreurs console/réseau (preuves des tests standard).
    page: { pages: urls, network, console: consoleMsgs, pageErrors, networkErrors: netErrors.items },
    network,
    timings: measured.timings,
    timingsByPage: measured.timingsByPage,
    vitals: measured.vitals,
    vitalsByPage: measured.vitalsByPage,
    networkByType: netSummary.byType,
    networkSummary: netSummary,
    totalBytes: netSummary.totalBytes,
    compression: netSummary.compression,
    networkErrors: netErrors,
    stress,
    metrics: {
      pages: urls,
      networkCount: network.length,
      timings: measured.timings,
      timingsByPage: measured.timingsByPage,
      vitals: measured.vitals,
      vitalsByPage: measured.vitalsByPage,
      networkByType: netSummary.byType,
      totalBytes: netSummary.totalBytes,
      compression: netSummary.compression,
      networkErrors: netErrors,
      console: consoleMsgs,
      pageErrors,
      stress,
    },
    summary: buildSummary({ target: { url }, timings: measured.timings, vitals: measured.vitals, networkErrors: netErrors, page: { console: consoleMsgs, pageErrors }, stress }),
    warnings,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), buildMarkdown(report));
  process.stdout.write(JSON.stringify(report));
}

main().catch((e) => {
  try {
    const payload = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : {};
    const outDir = payload.outDir ? String(payload.outDir) : join(dirname(process.argv[2] || "."), "perf-out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.json"), JSON.stringify({ ok: false, error: String((e && e.message) || e) }, null, 2));
  } catch { /* ignore */ }
  console.error(String((e && e.stack) || e));
  process.exit(3);
});
