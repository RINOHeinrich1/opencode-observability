// auth.mjs — Session courant (cookie) : parse + résolution de l'utilisateur.
import { getSession, getUserById } from "./panel-db.mjs";

const COOKIE_NAME = "orchestrator_session";

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

// Renvoie l'utilisateur courant (ou null si non authentifié / session expirée).
export async function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = await getSession(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  const u = await getUserById(s.user_id);
  if (!u) return null;
  return { id: u.id, username: u.username, is_admin: !!u.is_admin };
}

export function cookieHeader(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${process.env.PANEL_SESSION_TTL_H || 24 * 3600}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
