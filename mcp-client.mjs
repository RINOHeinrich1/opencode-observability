// mcp-client.mjs — Client MCP stdio minimal (JSON-RPC ligne-à-ligne).
//
// Sert de pont entre le panneau (écriture) et les MCP (source de vérité unique).
// Un process MCP PERSISTANT est spawn paresseusement par couple (serveur, lane)
// puis RÉUTILISÉ pour tous les appels : le spawn, le bootstrap des tools et le
// pool PG sont amortis sur la vie du panneau. Aucun cache de RÉSULTAT de tool :
// chaque appel lit le registre (source de vérité unique).
//
// Jamais d'écriture directe dans registry.db : tout passe par ces MCP.

import { spawn } from "node:child_process";

// Chemins des serveurs MCP — surchargeables par env (utile pour tester le MCP
// d'un worktree sans toucher au checkout principal) ; DÉFAUT INCHANGÉ.
const MCP_SERVERS = {
  "task-orchestrator": ["node", process.env.MCP_TASK_ORCHESTRATOR_PATH || "/root/.config/opencode/mcp/task-orchestrator/index.mjs"],
  "coder-workspaces": ["node", process.env.MCP_CODER_WORKSPACES_PATH || "/root/.config/opencode/mcp/coder-workspaces/index.mjs"],
};

const PROTOCOL_VERSION = "2025-11-25";
const CALL_TIMEOUT_MS = 30000;
// e2e_run lance réellement Playwright (instances + navigation) : un run peut
// légitimement durer plusieurs minutes (timeout runner 15 min). On lui donne
// un timeout dédié bien supérieur au défaut de 30 s.
const LONG_CALL_TIMEOUT_MS = 20 * 60 * 1000;
const LONG_CALL_TOOLS = new Set(["e2e_run", "e2e_sync_repo", "evaluation_perf_run"]);

// Les outils du socle renvoient un contenu texte (souvent JSON sérialisé) ;
// les erreurs sont signalées par `isError` ou un préfixe "ERREUR : ".
function parseToolResult(result) {
  if (result && result.isError) {
    const txt = (result.content || []).map((c) => c.text || "").join("\n").trim();
    throw new Error(txt.replace(/^ERREUR\s*:\s*/, "") || "erreur MCP");
  }
  const text = (result && Array.isArray(result.content))
    ? result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
    : "";
  const t = String(text).trim();
  if (!t) return result;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// --- Clients MCP PERSISTANTS ------------------------------------------------
// key = `${serveur}::${lane}`. Lane `main` = canal partagé ; lane `long` dédiée
// aux appels longs (`e2e_run`/`e2e_sync_repo`) pour ne pas bloquer le canal
// principal pendant un run Playwright de plusieurs minutes.
const clients = new Map();

function clientKey(server, lane) { return `${server}::${lane}`; }

function createClient(server, lane) {
  const cmd = MCP_SERVERS[server];
  if (!cmd) throw new Error(`serveur MCP inconnu : ${server}`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const client = {
    server, lane, child, buf: "", nextId: 0, pending: new Map(),
    ready: null, dead: false, send: null, request: null,
  };

  child.stdout.on("data", (chunk) => {
    client.buf += chunk.toString();
    let idx;
    while ((idx = client.buf.indexOf("\n")) >= 0) {
      const line = client.buf.slice(0, idx).trim();
      client.buf = client.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && client.pending.has(msg.id)) {
        const p = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  });
  child.stderr.on("data", () => {});

  // Process mort (exit/error) : on rejette les appels en vol et on oublie le
  // client pour qu'un respawn propre ait lieu au prochain appel.
  const onDead = () => {
    if (client.dead) return;
    client.dead = true;
    for (const p of client.pending.values()) p.reject(new Error(`process MCP ${server} (${lane}) terminé`));
    client.pending.clear();
    if (clients.get(clientKey(server, lane)) === client) clients.delete(clientKey(server, lane));
  };
  child.on("error", onDead);
  child.on("exit", onDead);

  client.send = (method, params, id) => {
    const m = { jsonrpc: "2.0", method, params };
    if (id !== undefined) m.id = id;
    try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {}
  };

  // Requête avec timeout : sur dépassement on TUE le process (partagé) pour ne
  // pas laisser un canal bloqué ; les appels en vol échouent et le prochain
  // appel respawn un process neuf.
  client.request = (method, params, timeoutMs) => {
    const id = ++client.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        if (!client.pending.has(id)) return;
        client.pending.delete(id);
        try { child.kill(); } catch {}
        reject(new Error(`timeout MCP (${server}.${method}) après ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs) : null;
      client.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      client.send(method, params, id);
    });
  };

  // Handshake initialisé UNE seule fois par client.
  client.ready = (async () => {
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "orchestrator-panel", version: "1.0.0" },
    }, CALL_TIMEOUT_MS);
    client.send("notifications/initialized", {});
  })();

  return client;
}

function getClient(server, lane) {
  const key = clientKey(server, lane);
  const existing = clients.get(key);
  if (existing && !existing.dead) return existing;
  const client = createClient(server, lane);
  clients.set(key, client);
  return client;
}

export async function callTool(server, tool, args = {}) {
  if (!MCP_SERVERS[server]) throw new Error(`serveur MCP inconnu : ${server}`);
  const lane = LONG_CALL_TOOLS.has(tool) ? "long" : "main";
  const timeoutMs = lane === "long" ? LONG_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
  const client = getClient(server, lane);
  try {
    await client.ready;
  } catch (e) {
    try { client.child.kill(); } catch {}
    if (clients.get(clientKey(server, lane)) === client) clients.delete(clientKey(server, lane));
    throw e;
  }
  try {
    const result = await client.request("tools/call", { name: tool, arguments: args }, timeoutMs);
    return parseToolResult(result); // peut lever (isError) → propagé tel quel
  } catch (e) {
    // Client mort ou timeout ⇒ on l'oublie pour forcer un respawn.
    if (client.dead || /timeout MCP/.test(String(e && e.message))) {
      try { client.child.kill(); } catch {}
      if (clients.get(clientKey(server, lane)) === client) clients.delete(clientKey(server, lane));
    }
    throw e;
  }
}

// Arrêt propre : tue tous les process MCP persistants (aucun orphelin).
export function closeAllMcpClients() {
  const closed = [];
  for (const [key, client] of clients) {
    client.dead = true;
    try { client.child.kill(); } catch {}
    clients.delete(key);
    closed.push(key);
  }
  return Promise.resolve(closed);
}

// Filet de sécurité : kill SYNCHRONE à la sortie du process Node.
process.on("exit", () => {
  for (const client of clients.values()) {
    try { client.child.kill(); } catch {}
  }
  clients.clear();
});

export const taskOrchestrator = (tool, args) => callTool("task-orchestrator", tool, args);
export const coderWorkspaces = (tool, args) => callTool("coder-workspaces", tool, args);
