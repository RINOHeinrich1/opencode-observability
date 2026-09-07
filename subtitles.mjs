// subtitles.mjs — Génère une vidéo E2E « avec sous-titres » gravés.
//
// Principe (hors pipeline, à la demande) : le rapport texte E2E est horodaté
// (`[TYPE] +MM:SS.mmm …`) avec la MÊME origine temporelle que la vidéo. On
// transforme chaque ligne horodatée en sous-titre (ASS, couleurs par type) puis
// on grave les sous-titres DANS la vidéo via ffmpeg (libass) → un nouveau
// .webm téléchargeable.
//
// Couleurs (par type de ligne du rapport) :
//   [STEP]      blanc        — action exécutée
//   [PASS]      vert         — assertion vérifiée
//   [FAIL]      rouge        — échec / bug constaté
//   [GAP]       orange       — écart comportement voulu vs actuel
//   [SKIPPED]   gris         — étape ignorée
//   [INFO]      gris clair   — contexte
//   [RESULT]    vert/rouge/gris selon le statut global du run
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 0
PlayResY: 0
WrapStyle: 0
ScaledBorderAndShadow: no

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: step,DejaVu Sans,22,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1.2,0,2,18,18,32,1
Style: pass,DejaVu Sans,22,&H0030E24C,&H0030E24C,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1.2,0,2,18,18,32,1
Style: fail,DejaVu Sans,22,&H004E5CFF,&H004E5CFF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,1.2,0,2,18,18,32,1
Style: gap,DejaVu Sans,22,&H0000A6FF,&H0000A6FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1.2,0,2,18,18,32,1
Style: skip,DejaVu Sans,22,&H00AAAAAA,&H00AAAAAA,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1.2,0,2,18,18,32,1
Style: info,DejaVu Sans,18,&H00CCCCCC,&H00CCCCCC,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1.0,0,2,18,18,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const TYPE_STYLE = {
  STEP: "step",
  PASS: "pass",
  FAIL: "fail",
  GAP: "gap",
  SKIPPED: "skip",
  INFO: "info",
  RESULT: "pass", // surchargé selon statut global
};

// Parcourt les lignes horodatées du rapport texte. Retourne
// [{ atMs, text, style }] triés par temps croissant.
function parseTimedLines(reportText) {
  const out = [];
  const re = /^\[([A-Z]+)(?:\s+\d+)?\]\s+\+(\d+):(\d+)\.(\d+)\s*\([^)]*\)\s+(.*)$/;
  for (const raw of String(reportText).split("\n")) {
    const m = re.exec(raw);
    if (!m) continue;
    const kind = m[1];
    if (!TYPE_STYLE[kind]) continue;
    const atMs = (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + parseInt(m[4].padEnd(3, "0").slice(0, 3), 10);
    const text = m[5].trim();
    if (!text) continue;
    out.push({ atMs, text, kind, style: TYPE_STYLE[kind] });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

// Durée d'affichage d'un sous-titre : jusqu'au temps de la ligne suivante
// (min 1s, max 8s). Le dernier s'affiche jusqu'à la fin.
function assignDurations(lines, videoDurationMs) {
  for (let i = 0; i < lines.length; i++) {
    const next = i + 1 < lines.length ? lines[i + 1].atMs : videoDurationMs;
    let dur = Math.max(1000, Math.min(8000, next - lines[i].atMs));
    if (i === lines.length - 1) dur = Math.max(1000, videoDurationMs - lines[i].atMs);
    lines[i].dur = dur;
  }
  return lines;
}

function assTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const cs = Math.floor((t % 1000) / 10);
  const s = Math.floor(t / 1000) % 60;
  const m = Math.floor(t / 60000) % 60;
  const h = Math.floor(t / 3600000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAss(text) {
  return String(text)
    .replace(/\{/g, "（").replace(/\}/g, "）")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\N")
    .slice(0, 220);
}

// Construit le contenu ASS à partir du rapport texte + statut global + durée vidéo.
export function buildAss(reportText, status, videoDurationMs) {
  let lines = parseTimedLines(reportText);
  if (!lines.length) return null;
  // RESULT : couleur selon le statut global du run.
  const resStyle = status === "PASSED" ? "pass" : (status === "FAILED" || status === "ERROR" ? "fail" : "skip");
  lines = lines.map((l) => (l.kind === "RESULT" ? { ...l, style: resStyle } : l));
  lines = assignDurations(lines, videoDurationMs);
  const events = lines.map((l) =>
    `Dialogue: 0,${assTime(l.atMs)},${assTime(l.atMs + l.dur)},${l.style},,0,0,0,,${escapeAss(l.text)}`,
  ).join("\n");
  return ASS_HEADER + events + "\n";
}

// Durée vidéo (ms) via ffprobe.
export function probeDurationMs(videoPath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ], { encoding: "utf8", timeout: 20000 });
    const s = parseFloat((out || "").trim());
    return isFinite(s) ? Math.round(s * 1000) : 0;
  } catch {
    return 0;
  }
}

// Génère la vidéo sous-titrée (gravée) à partir du rapport texte + la vidéo.
// Retourne le chemin du fichier .webm généré, ou null si impossible.
export function generateSubtitledVideo({ reportText, status, videoPath, outPath }) {
  if (!existsSync(videoPath)) return null;
  const durationMs = probeDurationMs(videoPath) || 20000;
  const ass = buildAss(reportText, status, durationMs);
  if (!ass) return null;
  mkdirSync(path.dirname(outPath), { recursive: true });
  const workDir = path.dirname(outPath);
  const assName = `_subs-${path.basename(outPath, path.extname(outPath))}.ass`;
  const assFile = path.join(workDir, assName);
  writeFileSync(assFile, ass, "utf8");
  try {
    // Grave les sous-titres ASS (libass) → sortie VP8 .webm (mêmes codec/conteneur).
    execFileSync("ffmpeg", [
      "-y", "-i", videoPath,
      "-vf", `ass=${assName}`,
      "-c:v", "libvpx", "-crf", "32", "-b:v", "0",
      "-an", path.basename(outPath),
    ], { cwd: workDir, encoding: "utf8", timeout: 240000, stdio: "pipe" });
    return existsSync(outPath) ? outPath : null;
  } catch {
    try { execFileSync("rm", ["-f", outPath], { stdio: "ignore" }); } catch {}
    return null;
  }
}
