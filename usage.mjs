// usage.mjs — Calcul de consommation opencode par session / tâche / agent.
// Extrait de server.mjs pour être réutilisé par le dashboard d'observabilité
// (metrics.mjs). `opencode export <sessionId>` fournit tokens, coût, modèles et
// agents par message ; le résultat est mis en cache 60 s par session.
import { execFileSync } from "node:child_process";
import { readFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OPENCODE_BIN = process.env.OPENCODE_BIN || "/root/.opencode/bin/opencode";

const _exportCache = new Map();

function computeSessionUsage(sessionId) {
  const empty = { sessionId, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, cost: 0, models: [], agents: [] };
  if (!sessionId) return empty;
  // NB : `opencode export` écrit un gros JSON sur stdout. En pipe, Node tronque
  // l'écriture (~212 Ko) ; on redirige donc stdout vers un fichier temporaire.
  const tmp = join(tmpdir(), `oc-export-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  let fd = -1;
  let j;
  try {
    fd = openSync(tmp, "w");
    execFileSync(OPENCODE_BIN, ["export", sessionId], { stdio: ["ignore", fd, "ignore"], timeout: 60000 });
    closeSync(fd);
    fd = -1;
    j = JSON.parse(readFileSync(tmp, "utf8"));
  } catch {
    return empty;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
  }
  const info = j.info || {};
  const tokens = info.tokens || {};
  const models = {};
  const agents = {};
  for (const m of j.messages || []) {
    const mi = m.info || {};
    if (mi.role !== "assistant") continue;
    const model = (mi.providerID && mi.modelID)
      ? `${mi.providerID}/${mi.modelID}`
      : (info.model ? `${info.model.providerID}/${info.model.modelID || info.model.id}` : "unknown");
    const cost = Number(mi.cost) || 0;
    const tk = mi.tokens || {};
    const input = Number(tk.input) || 0;
    const output = Number(tk.output) || 0;
    const reasoning = Number(tk.reasoning) || 0;
    const cacheRead = tk.cache ? Number(tk.cache.read) || 0 : 0;
    const mm = models[model] || (models[model] = { model, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 });
    mm.input += input; mm.output += output; mm.reasoning += reasoning; mm.cacheRead += cacheRead; mm.cost += cost;
    const agent = mi.agent || "unknown";
    const aa = agents[agent] || (agents[agent] = { agent, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 });
    aa.input += input; aa.output += output; aa.reasoning += reasoning; aa.cacheRead += cacheRead; aa.cost += cost;
  }
  return {
    sessionId,
    tokens: {
      input: Number(tokens.input) || 0,
      output: Number(tokens.output) || 0,
      reasoning: Number(tokens.reasoning) || 0,
      cacheRead: tokens.cache ? Number(tokens.cache.read) || 0 : 0,
    },
    cost: Number(info.cost) || 0,
    models: Object.values(models),
    agents: Object.values(agents),
  };
}

/** Consommation d'une session, cache 60 s. */
export function sessionUsage(sessionId) {
  const cached = _exportCache.get(sessionId);
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.data;
  const data = computeSessionUsage(sessionId);
  _exportCache.set(sessionId, { at: Date.now(), data });
  return data;
}

/** Consommation agrégée d'une tâche (toutes ses sessions liées). */
export async function taskConsumption(taskId, db) {
  let sessions = [];
  try {
    const res = await db.query("SELECT * FROM task_sessions WHERE task_id = $1 ORDER BY id ASC", [taskId]);
    sessions = res.rows;
  } catch { sessions = []; }
  // Fallback : tâches antérieures à la table task_sessions (une seule session).
  if (!sessions.length) {
    try {
      const t = (await db.query("SELECT session_id FROM tasks WHERE id = $1", [taskId])).rows[0];
      if (t && t.session_id) sessions = [{ session_id: t.session_id, kind: "launch", created_at: null }];
    } catch {}
  }
  const perSession = sessions.map((s) => ({
    sessionId: s.session_id,
    kind: s.kind,
    createdAt: s.created_at,
    ...sessionUsage(s.session_id),
  }));
  const total = { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, cost: 0 };
  const modelsAgg = {};
  const agentsAgg = {};
  const add = (acc, key, o, val) => {
    const a = acc[key] || (acc[key] = { [key]: o[key], input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 });
    a.input += o.input; a.output += o.output; a.reasoning += o.reasoning; a.cacheRead += o.cacheRead; a.cost += o.cost;
  };
  for (const s of perSession) {
    total.tokens.input += s.tokens.input;
    total.tokens.output += s.tokens.output;
    total.tokens.reasoning += s.tokens.reasoning;
    total.tokens.cacheRead += s.tokens.cacheRead;
    total.cost += s.cost;
    for (const m of s.models) add(modelsAgg, "model", m);
    for (const ag of s.agents) add(agentsAgg, "agent", ag);
  }
  return {
    taskId,
    sessions: perSession,
    total,
    models: Object.values(modelsAgg),
    agents: Object.values(agentsAgg),
  };
}

/** Coûts globaux + agrégation par agent (toutes tâches/sessions). */
export async function globalUsage(db) {
  const tasks = (await db.query("SELECT id FROM tasks ORDER BY created_at DESC")).rows;
  const perTask = [];
  let total = { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, cost: 0 };
  const byAgent = {};
  for (const t of tasks) {
    const c = await taskConsumption(t.id, db);
    perTask.push({ taskId: t.id, total: c.total });
    total.tokens.input += c.total.tokens.input;
    total.tokens.output += c.total.tokens.output;
    total.tokens.reasoning += c.total.tokens.reasoning;
    total.tokens.cacheRead += c.total.tokens.cacheRead;
    total.cost += c.total.cost;
    for (const ag of c.agents) {
      const a = byAgent[ag.agent] || (byAgent[ag.agent] = { agent: ag.agent, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 });
      a.input += ag.input; a.output += ag.output; a.reasoning += ag.reasoning; a.cacheRead += ag.cacheRead; a.cost += ag.cost;
    }
  }
  return {
    total,
    byAgent: Object.values(byAgent).sort((a, b) => b.cost - a.cost),
    perTask,
    avgPerTask: perTask.length ? {
      tokens: Math.round((total.tokens.input + total.tokens.output) / perTask.length),
      cost: total.cost / perTask.length,
    } : { tokens: 0, cost: 0 },
  };
}
