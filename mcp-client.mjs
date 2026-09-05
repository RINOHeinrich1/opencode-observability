// mcp-client.mjs — Client MCP stdio minimal (JSON-RPC ligne-à-ligne).
//
// Sert de pont entre le panneau (écriture) et les MCP (source de vérité unique).
// Chaque appel spawn un process MCP dédié (fréquence faible d'un panneau de
// contrôle) : initialize + notifications/initialized + tools/call, puis fermeture.
//
// Jamais d'écriture directe dans registry.db : tout passe par ces MCP.

import { spawn } from "node:child_process";

const MCP_SERVERS = {
  "task-orchestrator": ["node", "/root/.config/opencode/mcp/task-orchestrator/index.mjs"],
  "coder-workspaces": ["node", "/root/.config/opencode/mcp/coder-workspaces/index.mjs"],
};

const PROTOCOL_VERSION = "2025-11-25";
const CALL_TIMEOUT_MS = 30000;
// e2e_run lance réellement Playwright (instances + navigation) : un run peut
// légitimement durer plusieurs minutes (timeout runner 15 min). On lui donne
// un timeout dédié bien supérieur au défaut de 30 s.
const LONG_CALL_TIMEOUT_MS = 20 * 60 * 1000;
const LONG_CALL_TOOLS = new Set(["e2e_run", "e2e_sync_repo"]);

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

export function callTool(server, tool, args = {}) {
  const cmd = MCP_SERVERS[server];
  if (!cmd) return Promise.reject(new Error(`serveur MCP inconnu : ${server}`));
  const timeoutMs = (LONG_CALL_TOOLS.has(tool) ? LONG_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });

    let buf = "";
    let nextId = 0;
    const pending = new Map();
    let settled = false;

    const finishError = (e) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(e);
    };
    const timer = setTimeout(() => finishError(new Error(`timeout MCP (${server}.${tool}) après ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", finishError);

    const send = (method, params, id) => {
      const m = { jsonrpc: "2.0", method, params };
      if (id !== undefined) m.id = id;
      try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {}
    };
    const request = (method, params) => {
      const id = ++nextId;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        send(method, params, id);
      });
    };

    (async () => {
      try {
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "orchestrator-panel", version: "1.0.0" },
        });
        send("notifications/initialized", {});
        const result = await request("tools/call", { name: tool, arguments: args });
        const parsed = parseToolResult(result); // peut lever (isError) → catch → reject
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve(parsed);
      } catch (e) {
        finishError(e);
      }
    })();
  });
}

export const taskOrchestrator = (tool, args) => callTool("task-orchestrator", tool, args);
export const coderWorkspaces = (tool, args) => callTool("coder-workspaces", tool, args);
