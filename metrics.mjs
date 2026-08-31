// metrics.mjs — Agrégations KPI / observabilité du système d'orchestration.
// Lit le registre PostgreSQL `task_registry` (pool passé en argument).
// Phase 1 (v0.2.0) : summary, leadtime (P50/moyen/P95 + histogramme), status,
// throughput, agents (exécution), coûts (via usage.mjs).
import { globalUsage, sessionUsage } from "./usage.mjs";

// Statuts "en cours" (toute exécution non terminale hors done/blocked/failed/aborted/crashed).
const ACTIVE = ["queued", "started", "planning", "awaiting_validation", "planned", "in_progress", "validating", "review", "merge_pending", "merged", "deploy_pending", "deploying", "deployed", "post_deploy_verified"];
const TERMINAL_BAD = ["blocked", "failed", "aborted", "crashed"];
// Agents exécutants pertinents pour les métriques "agents" (exclut orchestrator/humains).
const EXEC_EXCLUDE = ["orchestrator", "human", "Rino"];

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function minutes(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

// --- Requête de base : tâche + statut courant + done_at + start_at ----------
async function baseTasks(pool) {
  const rows = (await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (task_id) task_id, status FROM executions ORDER BY task_id, attempt DESC
    ),
    done_ev AS (
      SELECT task_id, MAX(ts) AS done_at FROM events
      WHERE type = 'TRANSITION' AND (detail::jsonb->>'to') = 'done'
      GROUP BY task_id
    ),
    start_ev AS (
      SELECT task_id, MIN(ts) AS start_at FROM events
      WHERE type = 'TRANSITION' AND (detail::jsonb->>'to') = 'in_progress'
      GROUP BY task_id
    )
    SELECT t.id, t.created_at, t.recette_status, l.status, d.done_at, s.start_at
    FROM tasks t
    LEFT JOIN latest l ON l.task_id = t.id
    LEFT JOIN done_ev d ON d.task_id = t.id
    LEFT JOIN start_ev s ON s.task_id = t.id
  `)).rows;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    recetteStatus: r.recette_status || "pending",
    status: r.status || "queued",
    doneAt: r.done_at,
    startAt: r.start_at,
    leadMin: minutes(r.created_at, r.done_at),
    cycleMin: minutes(r.start_at, r.done_at),
  }));
}

// --- 1. Résumé (8 KPI cards) -------------------------------------------------
export async function summary(pool) {
  const tasks = await baseTasks(pool);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "done").length;
  const inProgress = tasks.filter((t) => ACTIVE.includes(t.status)).length;
  const leads = tasks.map((t) => t.leadMin).filter((v) => v != null);
  const cycles = tasks.map((t) => t.cycleMin).filter((v) => v != null);
  const success = tasks.filter((t) => t.status === "done" && t.recetteStatus === "approved").length;
  const rework = tasks.filter((t) => t.recetteStatus === "rejected").length;
  const reworkCount = (await pool.query("SELECT COUNT(*)::int AS n FROM (SELECT task_id FROM executions WHERE rework_count > 0 GROUP BY task_id) x")).rows[0].n;
  // Phase 4 — durcissement
  const nowIso = new Date().toISOString();
  const expiredDecisions = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM decisions WHERE status = 'awaiting' AND expires_at IS NOT NULL AND expires_at < $1",
    [nowIso],
  )).rows[0].n;
  let scopeConflicts = { total: 0, open: 0 };
  try {
    const c = (await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='open')::int AS open FROM scope_conflicts")).rows[0];
    scopeConflicts = { total: c.total, open: c.open };
  } catch {}
  const now = new Date();
  const done7 = tasks.filter((t) => t.doneAt && now - new Date(t.doneAt) <= 7 * 86400000).length;
  return {
    total,
    completed,
    inProgress,
    blocked: tasks.filter((t) => TERMINAL_BAD.includes(t.status)).length,
    leadTimeAvg: avg(leads),
    leadTimeP95: pct(leads, 95),
    cycleTimeAvg: avg(cycles),
    successRate: completed ? Math.round((success / completed) * 1000) / 10 : 0,
    successCount: success,
    throughput: Math.round((done7 / 7) * 10) / 10,
    reworkRate: total ? Math.round(((reworkCount + rework) / total) * 1000) / 10 : 0,
    expiredDecisions,
    scopeConflicts,
  };
}

// --- 2. Lead time : série P50/moyen/P95 + histogramme ------------------------
export async function leadtime(pool, days = 14) {
  const tasks = await baseTasks(pool);
  const done = tasks.filter((t) => t.leadMin != null);
  const start = new Date(Date.now() - days * 86400000);
  const series = [];
  const byDay = new Map();
  for (const t of done) {
    const d = new Date(t.doneAt);
    if (d < start) continue;
    const key = d.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t.leadMin);
  }
  const keys = [...byDay.keys()].sort();
  for (const k of keys) {
    const arr = byDay.get(k);
    series.push({ day: k, p50: pct(arr, 50), avg: avg(arr), p95: pct(arr, 95), count: arr.length });
  }
  const hist = [
    { label: "<10 min", min: 0, max: 10, count: 0 },
    { label: "10-30 min", min: 10, max: 30, count: 0 },
    { label: "30-60 min", min: 30, max: 60, count: 0 },
    { label: ">60 min", min: 60, max: Infinity, count: 0 },
  ];
  for (const v of done.map((t) => t.leadMin)) {
    const h = hist.find((x) => v >= x.min && v < x.max);
    if (h) h.count++;
  }
  return { series, histogram: hist, total: done.length };
}

// --- 3. Répartition des statuts ----------------------------------------------
export async function status(pool) {
  const rows = (await pool.query(`
    SELECT l.status, COUNT(*) AS n FROM (
      SELECT DISTINCT ON (task_id) task_id, status FROM executions ORDER BY task_id, attempt DESC
    ) l GROUP BY l.status ORDER BY n DESC
  `)).rows;
  return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
}

// --- 4. Throughput (done par jour) -------------------------------------------
export async function throughput(pool, days = 14) {
  const rows = (await pool.query(`
    SELECT to_char(date_trunc('day', ts::timestamptz)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS done
    FROM events
    WHERE type = 'TRANSITION' AND (detail::jsonb->>'to') = 'done'
      AND ts::timestamptz >= now() - ($1 || ' days')::interval
    GROUP BY 1 ORDER BY 1
  `, [days])).rows;
  return rows.map((r) => ({ day: r.day, done: Number(r.done) }));
}

// --- 5. Performance des agents (exécution) -----------------------------------
export async function agents(pool) {
  const events = (await pool.query(`
    SELECT task_id, by, type, ts FROM events
    WHERE by IS NOT NULL
  `)).rows;
  const tasks = (await pool.query("SELECT id, recette_status FROM tasks")).rows;
  const recetteMap = new Map(tasks.map((t) => [t.id, t.recette_status || "pending"]));
  const latest = (await pool.query(`
    SELECT DISTINCT ON (task_id) task_id, status FROM executions ORDER BY task_id, attempt DESC
  `)).rows;
  const statusMap = new Map(latest.map((r) => [r.task_id, r.status]));

  // Regroupe par agent (hors orchestrateur / humains).
  const byAgent = new Map();
  const taskIdsOf = (agent) => {
    const set = new Set();
    for (const e of events) if (e.by === agent) set.add(e.task_id);
    return set;
  };

  for (const e of events) {
    if (EXEC_EXCLUDE.includes(e.by)) continue;
    if (!byAgent.has(e.by)) byAgent.set(e.by, { agent: e.by, tasks: new Set(), starts: 0, durations: [], blocks: 0 });
  }
  for (const agent of byAgent.keys()) {
    const agg = byAgent.get(agent);
    const startsByTask = new Map();
    // Durée par (agent, tâche) : intervalle EXECUTION_STARTED→COMPLETED quand
    // disponible, sinon premier→dernier événement de l'agent sur la tâche
    // (couvre planners via PLANNING_STARTED→PLAN_CREATED et auditeurs via
    // AUDIT_STARTED→AUDIT_COMPLETED).
    const spanByTask = new Map();
    for (const e of events) {
      if (e.by !== agent) continue;
      agg.tasks.add(e.task_id);
      const span = spanByTask.get(e.task_id) || { first: null, last: null, started: null, completed: null };
      if (!span.first || e.ts < span.first) span.first = e.ts;
      if (!span.last || e.ts > span.last) span.last = e.ts;
      if (e.type === "EXECUTION_STARTED") {
        startsByTask.set(e.task_id, (startsByTask.get(e.task_id) || 0) + 1);
        if (!span.started || e.ts < span.started) span.started = e.ts;
      }
      if (e.type === "EXECUTION_COMPLETED") {
        if (!span.completed || e.ts > span.completed) span.completed = e.ts;
      }
      if (e.type === "BLOCKED") agg.blocks++;
      spanByTask.set(e.task_id, span);
    }
    for (const n of startsByTask.values()) agg.starts += Math.max(0, n - 1); // retries
    for (const span of spanByTask.values()) {
      const from = span.started && span.completed ? span.started : span.first;
      const to = span.started && span.completed ? span.completed : span.last;
      const m = minutes(from, to);
      if (m != null) agg.durations.push(m);
    }
  }

  const out = [];
  for (const agg of byAgent.values()) {
    const tasksIds = [...agg.tasks];
    const success = tasksIds.filter((id) => statusMap.get(id) === "done" && recetteMap.get(id) === "approved").length;
    const failed = tasksIds.filter((id) => TERMINAL_BAD.includes(statusMap.get(id))).length;
    const label = agg.agent === "agent" ? "agent (non attribué)" : agg.agent;
    out.push({
      agent: label,
      rawAgent: agg.agent,
      tasks: tasksIds.length,
      successRate: tasksIds.length ? Math.round((success / tasksIds.length) * 1000) / 10 : 0,
      success,
      failed,
      retry: agg.starts,
      blocks: agg.blocks,
      avgDuration: avg(agg.durations),
      p95Duration: pct(agg.durations, 95),
    });
  }
  return out.sort((a, b) => b.tasks - a.tasks || b.avgDuration - a.avgDuration);
}

// --- 6. Coûts / tokens -------------------------------------------------------
export async function costs(pool) {
  return globalUsage(pool);
}

// ---------------------------------------------------------------------------
// Phase 2 — où passe le temps, où sont les blocages
// ---------------------------------------------------------------------------

// Regroupement des statuts en phases pour le waterfall.
const PHASE_OF_STATE = {
  queued: "attente",
  started: "planning",
  planning: "planning",
  awaiting_validation: "attente-validation",
  planned: "planning",
  in_progress: "execution",
  validating: "execution",
  review: "attente-review",
  approved: "finalisation",
  merge_pending: "finalisation",
  merged: "finalisation",
  deploy_pending: "deploiement",
  deploying: "deploiement",
  deployed: "deploiement",
  post_deploy_verified: "deploiement",
  blocked: "bloque",
  aborted: "echec",
  failed: "echec",
  crashed: "echec",
};

const PHASE_LABEL = {
  attente: "Attente (queue)",
  planning: "Planification",
  "attente-validation": "Attente validation",
  execution: "Exécution",
  "attente-review": "Attente review",
  finalisation: "Finalisation",
  deploiement: "Déploiement",
  bloque: "Bloqué",
  echec: "Échec / abandon",
  autre: "Autre",
};

async function taskTransitions(pool, taskId) {
  const rows = (await pool.query(
    `SELECT ts, by, detail FROM events
     WHERE task_id = $1 AND type = 'TRANSITION' AND detail IS NOT NULL ORDER BY seq ASC`,
    [taskId],
  )).rows;
  return rows.map((r) => {
    const d = JSON.parse(r.detail);
    return { ts: r.ts, from: d.from, to: d.to, note: d.note || null };
  });
}

/** Waterfall d'une tâche : durée par phase. */
export async function timeline(pool, taskId) {
  const t = (await pool.query("SELECT id, created_at FROM tasks WHERE id = $1", [taskId])).rows[0];
  if (!t) return { error: "tâche inconnue", taskId };
  const transitions = await taskTransitions(pool, taskId);
  const leadStart = t.created_at;
  const phases = {};
  let current = "queued";
  let t0 = leadStart;
  const add = (state, from, to) => {
    if (!from || !to) return;
    const phase = PHASE_OF_STATE[state] || "autre";
    phases[phase] = (phases[phase] || 0) + Math.round((new Date(to) - new Date(from)) / 60000);
  };
  for (const tr of transitions) {
    add(current, t0, tr.ts);
    current = tr.to;
    t0 = tr.ts;
  }
  // Queue jusqu'au dernier événement (tâches non terminées).
  const nowIso = new Date().toISOString();
  if (current && !["done", "aborted", "failed", "crashed", "blocked"].includes(current)) {
    add(current, t0, nowIso);
  }
  const ordered = Object.entries(phases)
    .map(([phase, minutes]) => ({ phase, label: PHASE_LABEL[phase] || phase, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
  const total = ordered.reduce((a, b) => a + b.minutes, 0);
  return { taskId, total, phases: ordered, transitions: transitions.length };
}

/** Répartition moyenne du temps par phase (toutes tâches terminées). */
export async function phases(pool) {
  const tasks = await baseTasks(pool);
  const done = tasks.filter((t) => t.doneAt && t.status === "done");
  const agg = {};
  let grandTotal = 0;
  for (const t of done) {
    const w = await timeline(pool, t.id);
    for (const p of w.phases || []) {
      agg[p.label] = (agg[p.label] || 0) + p.minutes;
      grandTotal += p.minutes;
    }
  }
  return {
    total: done.length,
    phases: Object.entries(agg)
      .map(([label, minutes]) => ({ label, minutes, pct: grandTotal ? Math.round((minutes / grandTotal) * 1000) / 10 : 0 }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

/** Blocages par raison catégorisée. */
export async function blocked(pool, days = 14) {
  const rows = (await pool.query(`
    SELECT task_id, ts, type, by, detail FROM events
    WHERE (type = 'BLOCKED' OR (type = 'TRANSITION' AND (detail::jsonb->>'to') = 'blocked'))
      AND ts::timestamptz >= now() - ($1 || ' days')::interval
    ORDER BY ts DESC
  `, [days])).rows;
  const categorize = (text) => {
    const s = String(text || "").toLowerCase();
    if (/mcp|serveur mcp/.test(s)) return "MCP / outil";
    if (/permission|autorisation/.test(s)) return "Permission";
    if (/worktree|conflit de scope|scope/.test(s)) return "Worktree / scope";
    if (/build|échec|fail|compile|test/.test(s)) return "Build / tests";
    if (/github|pipeline|ci\/cd|réseau|network/.test(s)) return "Externe / CI";
    if (/agent/.test(s)) return "Agent";
    return "Autre";
  };
  const out = {};
  for (const r of rows) {
    const detail = r.detail ? JSON.parse(r.detail) : {};
    const text = detail.cause || detail.reason || detail.note || detail.agent || "";
    const cat = categorize(text);
    out[cat] = (out[cat] || 0) + 1;
  }
  return Object.entries(out).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/** Success / Failure par jour (done vs blocked/failed/aborted/crashed). */
export async function successfailure(pool, days = 14) {
  const rows = (await pool.query(`
    SELECT to_char(date_trunc('day', ts::timestamptz)::date, 'YYYY-MM-DD') AS day,
           (detail::jsonb->>'to') AS to_state, COUNT(*) AS n
    FROM events
    WHERE type = 'TRANSITION' AND ts::timestamptz >= now() - ($1 || ' days')::interval
    GROUP BY 1, 2 ORDER BY 1
  `, [days])).rows;
  const map = {};
  const BAD = new Set(["blocked", "failed", "aborted", "crashed"]);
  for (const r of rows) {
    const day = map[r.day] || (map[r.day] = { day: r.day, success: 0, failure: 0 });
    if (r.to_state === "done") day.success += Number(r.n);
    else if (BAD.has(r.to_state)) day.failure += Number(r.n);
  }
  return Object.values(map).sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Phase 4 — durcissement : décisions expirées + conflits de scope
// ---------------------------------------------------------------------------
export async function hardening(pool) {
  const nowIso = new Date().toISOString();
  const expired = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM decisions WHERE status = 'awaiting' AND expires_at IS NOT NULL AND expires_at < $1",
    [nowIso],
  )).rows[0].n;
  let conflicts = { total: 0, open: 0 };
  try {
    const c = (await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='open')::int AS open FROM scope_conflicts")).rows[0];
    conflicts = { total: c.total, open: c.open };
  } catch {}
  let transitionErrors = 0;
  try {
    transitionErrors = (await pool.query("SELECT COUNT(*)::int AS n FROM events WHERE type = 'TRANSITION_ERROR'")).rows[0].n;
  } catch {}
  return { expiredDecisions: expired, scopeConflicts: conflicts, transitionErrors };
}

// ---------------------------------------------------------------------------
// Phase 3 (hors worktree) — qualité : funnel, rework trend, cost vs throughput
// ---------------------------------------------------------------------------

/** Funnel qualité : Completed → Audited → Accepted → Sans rework. */
export async function quality(pool) {
  const tasks = await baseTasks(pool);
  const done = tasks.filter((t) => t.status === "done");
  const auditedSet = new Set(
    (await pool.query("SELECT DISTINCT task_id FROM events WHERE type = 'AUDIT_COMPLETED'")).rows.map((r) => r.task_id),
  );
  const reworkedSet = new Set(
    (await pool.query("SELECT DISTINCT task_id FROM executions WHERE rework_count > 0")).rows.map((r) => r.task_id),
  );
  const rejectedSet = new Set(
    (await pool.query("SELECT DISTINCT task_id FROM decisions WHERE kind = 'recette' AND status = 'rejected'")).rows.map((r) => r.task_id),
  );
  const completed = done.length;
  const audited = done.filter((t) => auditedSet.has(t.id)).length;
  const accepted = done.filter((t) => t.recetteStatus === "approved").length;
  const noRework = done.filter((t) => t.recetteStatus === "approved" && !reworkedSet.has(t.id) && !rejectedSet.has(t.id)).length;
  return {
    funnel: { completed, audited, accepted, noRework },
    auditRate: completed ? Math.round((audited / completed) * 1000) / 10 : 0,
    acceptanceRate: completed ? Math.round((accepted / completed) * 1000) / 10 : 0,
    cleanRate: completed ? Math.round((noRework / completed) * 1000) / 10 : 0,
  };
}

/** Rework dans le temps : reworks (plan + recette rejetée) par jour + taux. */
export async function rework(pool, days = 14) {
  const planRw = (await pool.query(`
    SELECT to_char(date_trunc('day', ts::timestamptz)::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
    FROM events WHERE type = 'TRANSITION' AND (detail::jsonb->>'to') = 'rework'
      AND ts::timestamptz >= now() - ($1 || ' days')::interval
    GROUP BY 1
  `, [days])).rows;
  const recRej = (await pool.query(`
    SELECT to_char(date_trunc('day', resolved_at::timestamptz)::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
    FROM decisions WHERE kind = 'recette' AND status = 'rejected' AND resolved_at IS NOT NULL
      AND resolved_at::timestamptz >= now() - ($1 || ' days')::interval
    GROUP BY 1
  `, [days])).rows;
  const map = {};
  for (const r of planRw) map[r.day] = (map[r.day] || 0) + r.n;
  for (const r of recRej) map[r.day] = (map[r.day] || 0) + r.n;
  const donePerDay = new Map((await throughput(pool, days)).map((d) => [d.day, d.done]));
  return Object.keys(map).sort()
    .map((day) => {
      const done = donePerDay.get(day) || 0;
      return { day, rework: map[day], rate: done ? Math.round((map[day] / done) * 1000) / 10 : 0 };
    });
}

/** Coût journalier (sessions) vs throughput (done / jour). */
export async function costvsthroughput(pool, days = 14) {
  const sessions = (await pool.query("SELECT session_id, created_at FROM task_sessions WHERE session_id IS NOT NULL ORDER BY id ASC")).rows;
  const costByDay = {};
  for (const s of sessions) {
    const day = s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : null;
    if (!day) continue;
    const u = sessionUsage(s.session_id);
    costByDay[day] = (costByDay[day] || 0) + (u.cost || 0);
  }
  const tp = await throughput(pool, days);
  const tpMap = new Map(tp.map((d) => [d.day, d.done]));
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const daysList = [...new Set([...Object.keys(costByDay), ...tpMap.keys()])].filter((d) => d >= start).sort();
  return daysList.map((day) => ({
    day,
    cost: Math.round((costByDay[day] || 0) * 100000) / 100000,
    done: tpMap.get(day) || 0,
  }));
}
