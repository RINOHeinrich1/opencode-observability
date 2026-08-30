// ecosystem.mjs — Découverte DYNAMIQUE de l'écosystème OpenCode.
// Analyse à la demande le répertoire de configuration OpenCode (agents, MCP,
// skills, plugins) sans rien coder en dur : le panneau reflète l'état réel.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

export const OPENCODE_DIR = process.env.OPENCODE_DIR || join(homedir(), ".config", "opencode");
const CONFIG_FILE = join(OPENCODE_DIR, "opencode.jsonc");

// --- Lecture utilitaire -----------------------------------------------------
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Supprime les commentaires d'un fichier JSONC (// et /* */) en respectant les chaînes.
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += n; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function readJsonc(path) {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Renvoie le corps markdown situé APRÈS le frontmatter (le "prompt" réel d'un
// agent ou le contenu d'un skill), sans les délimiteurs `---`.
function bodyAfterFrontmatter(text) {
  const m = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?([\s\S]*)$/.exec(text);
  return m ? m[1].replace(/\s+$/, "") : "";
}

// Analyseur minimal du frontmatter YAML (clés scalaires, blocs pliés `>-`/`|`,
// et cartes imbriquées à 2 espaces comme `permission:`).
function parseFrontmatter(text) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1];
    const raw = keyMatch[2].trim();

    if (raw === ">-" || raw === ">" || raw === "|-" || raw === "|") {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
        if (lines[j].trim() !== "") block.push(lines[j].replace(/^\s+/, ""));
        j++;
      }
      const joined = raw.startsWith("|") ? block.join("\n") : block.join(" ").replace(/\s+/g, " ");
      fm[key] = joined.trim();
      i = j;
      continue;
    }

    if (raw === "" || raw === "{}") {
      const block = [];
      let j = i + 1;
      while (j < lines.length && /^\s/.test(lines[j]) && lines[j].trim() !== "") {
        block.push(lines[j].replace(/^\s+/, ""));
        j++;
      }
      fm[key] = block.length ? block.join("\n") : true;
      i = j;
      continue;
    }

    fm[key] = raw;
    i++;
  }
  return fm;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// Liste les fichiers *.md d'un dossier (et agent.md des sous-dossiers si nested).
function listMdFiles(dir, nested = false) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isFile(full) && entry.endsWith(".md")) out.push(full);
    else if (nested && isDir(full)) {
      const inner = join(full, "agent.md");
      if (isFile(inner)) out.push(inner);
    }
  }
  return out;
}

// Compte les outils exposés par un serveur MCP en scannant ses sources.
function listTools(dir) {
  if (!existsSync(dir)) return [];
  const tools = [];
  const re = /server\.(?:registerTool|tool)\(\s*"([^"]+)"/g;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules") continue;
      const full = join(d, entry);
      if (isDir(full)) walk(full);
      else if (/\.(mjs|js|ts|tsx|cjs)$/.test(entry)) {
        let src;
        try { src = readFileSync(full, "utf8"); } catch { continue; }
        let m;
        while ((m = re.exec(src))) tools.push(m[1]);
      }
    }
  };
  walk(dir);
  return [...new Set(tools)];
}

function readDescription(pkg) {
  const d = (pkg && pkg.description) || "";
  return typeof d === "string" ? d : "";
}

// Réduit le bloc `permission:` (objet ou texte brut dédenté) à une liste de
// couples { tool, value } lisibles : value vaut "allow/ask/deny" pour un
// scalaire, sinon une chaîne compacte "… (règles)".
function summarizePermission(permission) {
  if (!permission) return [];
  const items = [];
  if (typeof permission === "string") {
    const re = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm;
    let m;
    while ((m = re.exec(permission))) {
      const value = m[2].trim();
      items.push({ tool: m[1], value: value || "rules" });
    }
    return items;
  }
  if (typeof permission === "object") {
    for (const [tool, value] of Object.entries(permission)) {
      items.push({ tool, value: typeof value === "string" && value ? value : "rules" });
    }
  }
  return items;
}

// --- Scan de l'écosystème ----------------------------------------------------
export function scanEcosystem() {
  const config = readJsonc(CONFIG_FILE) || {};
  const configuredMcp = (config.mcp && typeof config.mcp === "object") ? config.mcp : {};
  const configuredPlugins = Array.isArray(config.plugin) ? config.plugin : [];

  const result = {
    dir: OPENCODE_DIR,
    agents: [],
    mcp: [],
    skills: [],
    plugins: [],
  };

  // --- Agents ---
  const agentDir = join(OPENCODE_DIR, "agent");
  for (const file of listMdFiles(agentDir, true)) {
    const name = basename(file, ".md") === "agent" ? basename(dirname(file)) : basename(file, ".md");
    const raw = readFileSync(file, "utf8");
    const fm = parseFrontmatter(raw);
    result.agents.push({
      name,
      file,
      description: typeof fm.description === "string" ? fm.description : "",
      body: bodyAfterFrontmatter(raw),
      mode: typeof fm.mode === "string" ? fm.mode : null,
      model: typeof fm.model === "string" ? fm.model : null,
      permission: summarizePermission(fm.permission),
    });
  }
  result.agents.sort((a, b) => a.name.localeCompare(b.name));

  // --- MCP ---
  const mcpRoot = join(OPENCODE_DIR, "mcp");
  if (existsSync(mcpRoot)) {
    for (const entry of readdirSync(mcpRoot).sort()) {
      const dir = join(mcpRoot, entry);
      if (!isDir(dir)) continue;
      const pkg = readJson(join(dir, "package.json"));
      const cfg = configuredMcp[entry] || {};
      result.mcp.push({
        name: entry,
        description: readDescription(pkg),
        version: (pkg && pkg.version) || null,
        enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : null,
        command: (cfg.command && Array.isArray(cfg.command)) ? cfg.command.join(" ") : null,
        tools: listTools(dir),
      });
    }
  }

  // --- Skills ---
  const skillsRoot = join(OPENCODE_DIR, "skills");
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot).sort()) {
      const skillFile = join(skillsRoot, entry, "SKILL.md");
      if (!isFile(skillFile)) continue;
      const raw = readFileSync(skillFile, "utf8");
      const fm = parseFrontmatter(raw);
      result.skills.push({
        name: typeof fm.name === "string" ? fm.name : entry,
        description: typeof fm.description === "string" ? fm.description : "",
        body: bodyAfterFrontmatter(raw),
      });
    }
  }

  // --- Plugins ---
  const pluginsDir = join(OPENCODE_DIR, "plugins");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir).sort()) {
      const full = join(pluginsDir, entry);
      if (!isFile(full) || !/\.(mjs|cjs|js)$/.test(entry)) continue;
      result.plugins.push({
        name: entry,
        enabled: configuredPlugins.some((p) => typeof p === "string" && p.includes(entry)),
      });
    }
  }

  return result;
}

// --- Édition globale du modèle d'un agent -----------------------------------

// Retrouve le chemin du fichier frontmatter d'un agent à partir de son nom.
export function findAgentFile(name) {
  const agentDir = join(OPENCODE_DIR, "agent");
  for (const file of listMdFiles(agentDir, true)) {
    const n = basename(file, ".md") === "agent" ? basename(dirname(file)) : basename(file, ".md");
    if (n === name) return file;
  }
  return null;
}

// Remplace (ou insère) une clé scalaire dans le frontmatter YAML d'un fichier.
function setFrontmatterField(text, key, value) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const fm = m[1];
  const lineRe = new RegExp(`^([ \\t]*)${key}:[ \\t]*[^\\r\\n]*$`, "m");
  const newFm = lineRe.test(fm)
    ? fm.replace(lineRe, `$1${key}: ${value}`)
    : `${key}: ${value}\n` + fm;
  return text.replace(fm, newFm);
}

// Met à jour globalement le modèle d'un agent (réécrit `model:` dans son frontmatter).
export function updateAgentModel(name, model) {
  const file = findAgentFile(name);
  if (!file) throw new Error(`agent inconnu : ${name}`);
  const raw = readFileSync(file, "utf8");
  const updated = setFrontmatterField(raw, "model", model);
  if (updated === raw) throw new Error(`frontmatter introuvable pour l'agent : ${name}`);
  writeFileSync(file, updated);
  return { name, model, file };
}
