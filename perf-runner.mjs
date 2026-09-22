// perf-runner.mjs — Moteur de TEST DE PERFORMANCE (préprod) du panneau.
//
// Mesure, sur une cible PRÉPROD (URL) :
//   1. RÉSEAU  — durées/statuts/types/tailles des requêtes (type onglet Network) ;
//   2. TIMINGS — TTFB, DOMContentLoaded, load ;
//   3. VITALS  — Core Web Vitals accessibles : LCP, CLS, long tasks (INP non
//                instrumenté sans interactions réelles) ;
//   4. STRESS  — accès PARALLÈLES bornés (débit req/s, latence moy/p50/p95/p99,
//                taux d'erreurs).
//
// Le navigateur (Playwright) est résolu depuis le CHECKOUT APPLICATIF `repoDir`
// (ex. /root/mada-talk-preprod) — le panneau n'embarque pas Playwright. Si aucun
// Playwright n'est disponible, la mesure réseau/stress se fait SANS navigateur
// (fetch) et les Core Web Vitals sont marqués indisponibles (avertissement).
//
// Usage : node perf-runner.mjs <payload.json>
//   payload = { evaluationId?, url, repoDir?, baseUrl?, concurrency?, requests?, outDir? }
// Sortie : écrit `report.json` + `report.md` dans `outDir` et imprime le JSON
//          du rapport sur stdout. BORNÉ : concurrency ≤ 10, requests ≤ 200.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const MAX_CONCURRENCY = 10;
const MAX_REQUESTS = 200;
const NAV_TIMEOUT_MS = 45000;

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

// Résout Playwright depuis le checkout applicatif (puis, à défaut, depuis le
// panneau lui-même). Retourne { chromium } ou null.
async function resolvePlaywright(repoDir) {
  const candidates = [];
  if (repoDir) candidates.push(join(String(repoDir), "package.json"));
  candidates.push(join(dirname(new URL(import.meta.url).pathname), "package.json"));
  for (const pkg of candidates) {
    try {
      const req = createRequire(pkg);
      const resolved = req.resolve("playwright");
      const mod = await import(pathToFileURL(resolved).href);
      const pw = mod.default || mod;
      if (pw && pw.chromium) return pw;
    } catch { /* tente le suivant */ }
    try {
      const req = createRequire(pkg);
      const resolved = req.resolve("playwright-core");
      const mod = await import(pathToFileURL(resolved).href);
      const pw = mod.default || mod;
      if (pw && pw.chromium) return pw;
    } catch { /* tente le suivant */ }
  }
  return null;
}

// --- 1/2/3. Mesure navigateur : réseau + timings + Core Web Vitals ----------
async function browserMeasure(pw, url) {
  const warnings = [];
  const browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const network = [];
    page.on("requestfinished", async (request) => {
      try {
        const response = await request.response();
        const timing = request.timing();
        const duration = timing && timing.responseEnd >= timing.startTime ? timing.responseEnd - timing.startTime : null;
        let size = 0;
        try { const cl = response && response.headers()["content-length"]; size = cl ? Number(cl) : 0; } catch { size = 0; }
        network.push({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          status: response ? response.status() : null,
          durationMs: duration === null ? null : round1(duration),
          sizeBytes: Number.isFinite(size) ? size : 0,
        });
      } catch { /* requête abandonnée */ }
    });
    await page.addInitScript(() => {
      window.__perfVitals = { lcpMs: null, cls: 0, longTasks: 0, longTasksMs: 0 };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__perfVitals.lcpMs = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) window.__perfVitals.cls += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__perfVitals.longTasks += 1;
            window.__perfVitals.longTasksMs += e.duration;
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    });
    await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    // Laisse le temps au LCP/CLS de se stabiliser (borné).
    await page.waitForTimeout(1500);
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType("navigation")[0] || {};
      return {
        ttfbMs: e.responseStart || null,
        domContentLoadedMs: e.domContentLoadedEventEnd || null,
        loadMs: e.loadEventEnd || null,
      };
    });
    const v = await page.evaluate(() => window.__perfVitals || null);
    await context.close();
    return {
      network,
      timings: nav,
      vitals: v ? { lcpMs: v.lcpMs === null ? null : round1(v.lcpMs), cls: Math.round((v.cls || 0) * 1000) / 1000, longTasks: v.longTasks || 0, longTasksMs: round1(v.longTasksMs || 0) } : null,
      warnings,
    };
  } finally {
    try { await browser.close(); } catch {}
  }
}

// Repli SANS navigateur : mesure réseau via fetch (durées/statuts/tailles).
async function fetchNetworkMeasure(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: "follow" });
    const body = await res.arrayBuffer();
    return {
      network: [{ url, method: "GET", resourceType: "document", status: res.status, durationMs: round1(performance.now() - t0), sizeBytes: body.byteLength }],
      timings: { ttfbMs: null, domContentLoadedMs: null, loadMs: round1(performance.now() - t0) },
      vitals: null,
    };
  } catch (e) {
    return { network: [], timings: null, vitals: null, error: String((e && e.message) || e) };
  }
}

// --- 4. STRESS borné (accès parallèles) ------------------------------------
async function stressTest(url, concurrency, requests) {
  const latencies = [];
  let ok = 0, errors = 0, issued = 0;
  const started = Date.now();
  const worker = async () => {
    while (issued < requests) {
      issued += 1;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { redirect: "follow" });
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        if (res.ok) ok += 1; else errors += 1;
      } catch {
        latencies.push(performance.now() - t0);
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
  const wallMs = Date.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : 0;
  return {
    concurrency,
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
  };
}

function buildSummary(target, timings, vitals, stress) {
  const parts = [];
  if (timings && timings.ttfbMs != null) parts.push(`TTFB ${round1(timings.ttfbMs)}ms`);
  if (timings && timings.loadMs != null) parts.push(`load ${round1(timings.loadMs)}ms`);
  if (vitals && vitals.lcpMs != null) parts.push(`LCP ${vitals.lcpMs}ms`);
  if (vitals && vitals.cls != null) parts.push(`CLS ${vitals.cls}`);
  if (stress) parts.push(`stress ${stress.requests}@${stress.concurrency} → ${stress.rps} req/s, p95 ${stress.latencyMs.p95}ms, erreurs ${stress.errorRate}%`);
  return `${target} — ${parts.join(" · ") || "aucune mesure"}`;
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# Rapport de performance — ${report.target.url}`);
  lines.push("");
  lines.push(`- Démarré : ${report.startedAt}`);
  lines.push(`- Terminé : ${report.finishedAt} (${report.durationMs} ms)`);
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
    lines.push(`- LCP : ${report.vitals.lcpMs ?? "n/a"} ms`);
    lines.push(`- CLS : ${report.vitals.cls}`);
    lines.push(`- Long tasks : ${report.vitals.longTasks} (${report.vitals.longTasksMs} ms)`);
  } else { lines.push("- (indisponibles — Playwright absent ou cible non navigable)"); }
  lines.push("");
  lines.push("## Réseau (durées par requête)");
  lines.push("| Statut | Type | Durée (ms) | Taille (o) | URL |");
  lines.push("|---|---|---|---|---|");
  for (const n of report.network.slice(0, 200)) {
    lines.push(`| ${n.status ?? "-"} | ${n.resourceType || "-"} | ${n.durationMs ?? "-"} | ${n.sizeBytes ?? "-"} | ${String(n.url).replace(/\|/g, "%7C")} |`);
  }
  if (!report.network.length) lines.push("| - | - | - | - | (aucune requête capturée) |");
  lines.push("");
  lines.push("## Stress test (accès parallèles bornés)");
  if (report.stress) {
    lines.push(`- Concurrence : ${report.stress.concurrency} — requêtes : ${report.stress.requests} (complétées : ${report.stress.completed})`);
    lines.push(`- Débit : ${report.stress.rps} req/s — durée : ${report.stress.wallMs} ms`);
    lines.push(`- Latence : moy ${report.stress.latencyMs.avg} ms · p50 ${report.stress.latencyMs.p50} ms · p95 ${report.stress.latencyMs.p95} ms · p99 ${report.stress.latencyMs.p99} ms · max ${report.stress.latencyMs.max} ms`);
    lines.push(`- Erreurs : ${report.stress.errors} (${report.stress.errorRate} %)`);
  } else { lines.push("- (non exécuté)"); }
  if (report.warnings && report.warnings.length) {
    lines.push("");
    lines.push("## Avertissements");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const payloadFile = process.argv[2];
  if (!payloadFile) { console.error("usage: node perf-runner.mjs <payload.json>"); process.exit(1); }
  const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  const url = String(payload.url || "");
  if (!/^https?:\/\//i.test(url)) { console.error("url préprod requise (http/https)"); process.exit(2); }
  const concurrency = clampInt(payload.concurrency, 1, MAX_CONCURRENCY, 5);
  const requests = clampInt(payload.requests, 1, MAX_REQUESTS, 50);
  const repoDir = payload.repoDir ? String(payload.repoDir) : null;
  const outDir = payload.outDir ? String(payload.outDir) : join(dirname(payloadFile), "perf-out");
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings = [];
  let network = [], timings = null, vitals = null;

  const pw = await resolvePlaywright(repoDir);
  if (pw) {
    try {
      const m = await browserMeasure(pw, url);
      network = m.network; timings = m.timings; vitals = m.vitals;
      warnings.push(...(m.warnings || []));
    } catch (e) {
      warnings.push(`Mesure navigateur en échec (${String((e && e.message) || e).slice(0, 200)}) — repli fetch.`);
      const m = await fetchNetworkMeasure(url);
      network = m.network; timings = m.timings; vitals = m.vitals;
    }
  } else {
    warnings.push(repoDir
      ? `Playwright introuvable dans ${repoDir} — Core Web Vitals indisponibles, mesure réseau via fetch.`
      : "Aucun repoDir (Playwright) fourni — Core Web Vitals indisponibles, mesure réseau via fetch.");
    const m = await fetchNetworkMeasure(url);
    network = m.network; timings = m.timings; vitals = m.vitals;
  }

  let stress = null;
  try {
    stress = await stressTest(url, concurrency, requests);
  } catch (e) {
    warnings.push(`Stress test en échec : ${String((e && e.message) || e).slice(0, 200)}`);
  }

  const finishedAt = new Date().toISOString();
  const report = {
    ok: true,
    target: { url, repoDir, baseUrl: payload.baseUrl || null },
    startedAt, finishedAt, durationMs: Date.now() - t0,
    network, timings, vitals, stress,
    metrics: {
      networkCount: network.length,
      timings, vitals, stress,
    },
    summary: buildSummary(url, timings, vitals, stress),
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
  } catch {}
  console.error(String((e && e.stack) || e));
  process.exit(3);
});
