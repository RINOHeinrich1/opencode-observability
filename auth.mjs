// auth.mjs — Session courant (cookie) : parse + résolution de l'utilisateur.
import { getSession, getUserById, listUserOrganizations, setSessionOrganization, listUserProjects } from "./panel-db.mjs";

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
  // Rôle effectif : admin (is_admin rétrocompat) > supervisor > evaluateur > executeur > user.
  let role = u.role && ["admin", "supervisor", "evaluateur", "executeur", "user"].includes(u.role) ? u.role : "user";
  if (u.is_admin) role = "admin";
  // Appartenance N:N + organisation ACTIVE (stockée dans la session).
  let organizations = await listUserOrganizations(u.id);
  if (!organizations.length && u.organization_id) organizations = [u.organization_id];
  let activeOrganizationId = s.active_organization_id || null;
  if (activeOrganizationId && !organizations.includes(activeOrganizationId)) activeOrganizationId = null;
  // Auto-sélection si une seule organisation (pas d'écran de choix nécessaire).
  if (!activeOrganizationId && organizations.length === 1) {
    activeOrganizationId = organizations[0];
    try { await setSessionOrganization(token, activeOrganizationId); } catch {}
  }
  return {
    id: u.id, username: u.username, is_admin: role === "admin", role,
    organizationId: u.organization_id || "onirtech",
    organizations, activeOrganizationId,
    isSupervisor: role === "supervisor", isUser: role === "user",
    isEvaluateur: role === "evaluateur",
    isExecutor: role === "executeur",
    // Périmètre propriétaire : un rôle `user` ne voit QUE ses propres créations
    // (created_by = son username) dans l'organisation active. `supervisor`/`admin`
    // voient toutes les données de l'organisation (ownerScope = null).
    ownerScope: role === "user" ? u.username : null,
    // Périmètre des RECETTES (ADR-002) : l'`evaluateur` ne voit QUE ses propres
    // recettes ; `admin`/`supervisor` voient toutes les recettes (null). Le rôle
    // `user` conserve son comportement historique (couvert ici pour ne rien casser).
    recetteOwnerScope: role === "evaluateur" || role === "user" ? u.username : null,
    // Accès par PROJET : `admin` = tous les projets (null) ; les autres = liste
    // explicite (aucun par défaut).
    projectAccess: role === "admin" ? null : await listUserProjects(u.id),
    // Lecture seule STRICTE : uniquement le superviseur. Un `user` peut écrire
    // (créer/agir) mais ne voit/écrit que ses propres créations.
    isReadOnly: role === "supervisor",
  };
}

// Helpers ACL. `isReadOnly` = rôle `supervisor` uniquement (lecture stricte).
// L'`evaluateur` n'est PAS en lecture seule globale : il écrit sur SES recettes,
// lance des tests E2E et dépose des pièces (périmètre appliqué côté serveur).
export const isReadOnly = (user) => !!(user && user.role === "supervisor");
export const canWrite = (user) => !!(user && !isReadOnly(user));

// Pages autorisées par rôle (source UNIQUE UI + serveur, ADR-002). L'`evaluateur`
// n'accède qu'à Fonctionnalités & Règles, Tests E2E et Recette (page
// `evaluations` — SA page, distincte du Cadrage technique) (+ Projets pour
// choisir un projet). L'`executeur` accède à Vue d'ensemble, Tâches, Cadrage
// technique (onglet `recettes`), Recette évaluateur (`evaluations`, lecture
// seule), Tests E2E, Fonctionnalités & Règles, Décisions, ADR et Workspaces
// (+ Projets pour choisir un projet) ; les onglets Sprints, Artefacts, Vars &
// Secrets, Archives et Écosystème/Utilisateurs sont masqués. Les Déploiements
// restent accessibles via le modal de détail de tâche (`data-goto="deployments"`)
// — pas d'onglet dédié. `admin`/`supervisor`/`user` conservent toutes les pages.
export const ROLE_PAGES = {
  admin: ["projects", "overview", "tasks", "recettes", "evaluations", "e2etests", "decisions", "artifacts", "adr", "sprints", "features", "e2esecrets", "archives", "ecosystem", "workspaces", "users"],
  supervisor: ["projects", "overview", "tasks", "recettes", "evaluations", "e2etests", "decisions", "artifacts", "adr", "sprints", "features", "e2esecrets", "archives", "ecosystem", "workspaces", "users"],
  evaluateur: ["projects", "features", "e2etests", "evaluations"],
  executeur: ["projects", "overview", "tasks", "recettes", "evaluations", "e2etests", "decisions", "adr", "features", "workspaces"],
  user: ["projects", "overview", "tasks", "recettes", "evaluations", "e2etests", "decisions", "artifacts", "adr", "sprints", "features", "e2esecrets", "archives", "ecosystem", "workspaces", "users"],
};
export function allowedPages(role) {
  return ROLE_PAGES[role] || ROLE_PAGES.user;
}

export function cookieHeader(token) {
  // Domaine partagé (ex. .madatalk.fr) pour que le cookie du panneau soit envoyé
  // aux sous-domaines (ex. dev.madatalk.fr → auth_request opencode). Optionnel.
  const domain = process.env.PANEL_COOKIE_DOMAIN ? `; Domain=${process.env.PANEL_COOKIE_DOMAIN}` : "";
  return `${COOKIE_NAME}=${token}; Path=/${domain}; HttpOnly; SameSite=Lax; Max-Age=${process.env.PANEL_SESSION_TTL_H || 24 * 3600}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
