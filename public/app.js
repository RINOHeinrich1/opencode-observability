// app.js — Logique du panneau de supervision.
let ME = null;
let IS_ADMIN = false;    // vrai si l'utilisateur courant est admin (écritures)
let IS_EVALUATEUR = false; // vrai si rôle « évaluateur » (ADR-002 : périmètre restreint)
let IS_EXECUTEUR = false;  // vrai si rôle « exécuteur » (ADR-001/002 : périmètre restreint)
let IS_SUPERVISOR = false; // vrai si rôle « superviseur » (ADR-002 : lecture seule stricte, TOUS les onglets)
let REFRESH_S = 10;      // intervalle (s), surchargé par /api/config (min 10)
let refreshTimer = null;
let activeTab = 'overview';
let lastUpdated = null;
let taskFilter = '';     // tâche sélectionnée comme filtre ('' = aucune)
let SESSION_BASE_URL = 'https://dev.madatalk.fr'; // base des liens de session opencode
let groupCadrageEnabled = localStorage.getItem('panel_group_cadrage') === '1'; // persistant (onglets + rechargement)
let groupParallelEnabled = localStorage.getItem('panel_group_parallel') === '1'; // grouper par ordre/parallèle
let groupUserEnabled = localStorage.getItem('panel_group_user') === '1'; // grouper par utilisateur (créateur)
let tasksProjectFilter = localStorage.getItem('panel_task_project') || ''; // filtre projet de l'onglet Tâches (persistant re-rendu)
let tasksSprintFilter = localStorage.getItem('panel_task_sprint') || ''; // filtre sprint Tâches (exécuteur : '' = sprint actif ; sinon traçage lecture seule)
let tasksStatusFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_task_status') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(); // statuts affichés (multi-valeurs, persistant re-rendu)
const persistTasksStatus = () => localStorage.setItem('panel_task_status', JSON.stringify(tasksStatusFilter));
let tasksUserFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_task_users') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(); // créateurs sélectionnés (multi-valeurs)
const persistTasksUsers = () => localStorage.setItem('panel_task_users', JSON.stringify(tasksUserFilter));
let cadragesUserFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_cadrage_users') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
const persistCadragesUsers = () => localStorage.setItem('panel_cadrage_users', JSON.stringify(cadragesUserFilter));
let e2eUserFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_e2e_users') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
const persistE2EUsers = () => localStorage.setItem('panel_e2e_users', JSON.stringify(e2eUserFilter));
let tasksNeedCadrage = localStorage.getItem('panel_task_recette') === '1'; // pré-filtre « À cadrer » (cadrage_status != done)
let tasksActifOnly = localStorage.getItem('panel_task_actif') === '1';      // pré-filtre « Actif » (hors TASK_INACTIVE_STATES : done, aborted, failed, blocked, crashed, rejected)
let tasksDateFrom = localStorage.getItem('panel_task_date_from') || '';      // filtre date de création — borne basse (YYYY-MM-DD)
let tasksDateTo = localStorage.getItem('panel_task_date_to') || '';          // filtre date de création — borne haute (YYYY-MM-DD)
// Filtres CIBLES « sans lien » (id-set de la cardinalité) — pré-appliqués par un
// clic sur une carte de la Vue d'ensemble, valeur du <select> visible de la page.
let tasksMissingFilter = localStorage.getItem('panel_task_missing') || '';    // '' | tache_sans_adr | tache_sans_fonctionnalite | tache_sans_sprint | emergents
let cadragesMissingFilter = localStorage.getItem('panel_cadrage_missing') || ''; // '' | cadrage_sans_adr | cadrage_sans_fonctionnalite | cadrage_sans_sprint
let sprintsMissingFilter = localStorage.getItem('panel_sprint_missing') || '';   // '' | sprint_sans_fonctionnalite | sprint_sans_regle
// Filtre « créateurs » de la page Recette ÉVALUATEUR (masqué pour l'évaluateur :
// il ne voit que SES recettes, le filtre n'a pas de sens).
let recettesUserFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_recette_users') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
const persistRecettesUsers = () => localStorage.setItem('panel_recette_users', JSON.stringify(recettesUserFilter));
const persistTasksMissing = () => { if (tasksMissingFilter) localStorage.setItem('panel_task_missing', tasksMissingFilter); else localStorage.removeItem('panel_task_missing'); };
const persistCadragesMissing = () => { if (cadragesMissingFilter) localStorage.setItem('panel_cadrage_missing', cadragesMissingFilter); else localStorage.removeItem('panel_cadrage_missing'); };
const persistSprintsMissing = () => { if (sprintsMissingFilter) localStorage.setItem('panel_sprint_missing', sprintsMissingFilter); else localStorage.removeItem('panel_sprint_missing'); };
const persistAdrMissing = () => { if (adrFilters && adrFilters.missingFeature) localStorage.setItem('panel_adr_missing', adrFilters.missingFeature); else localStorage.removeItem('panel_adr_missing'); };
// Navigation CENTRÉE PROJET : quand un projet est ouvert, toutes les vues sont
// scopées à ce projet (bandeau + sous-onglets). Vide = accueil (liste projets).
let currentProject = localStorage.getItem('panel_current_project') || '';
const setCurrentProject = (id) => { currentProject = id || ''; if (currentProject) localStorage.setItem('panel_current_project', currentProject); else localStorage.removeItem('panel_current_project'); };
// Organisation active (tenant) : filtre global du panneau.
let currentOrg = localStorage.getItem('panel_current_org') || '';
let ORGANIZATIONS = [];

// Agents mobilisés par type de tâche (affichage read-only au lancement).
const AGENTS_BY_TYPE = {
  feature: [
    { name: 'atomic-plan', role: 'Planner — planification' },
    { name: 'build-notify', role: 'Executor — exécution' },
  ],
  debug: [
    { name: 'atomic-plan', role: 'Planner — planification' },
    { name: 'build-notify', role: 'Executor — exécution' },
  ],
  audit: [
    { name: 'hexagonal-architecture-auditor', role: 'Audit backend (hexagonal)' },
    { name: 'clean-arch-detector-react', role: 'Audit frontend (React)' },
  ],
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

function badge(status) {
  return `<span class="badge ${status || 'queued'}">${status || 'queued'}</span>`;
}

function cadrageBadge(st) {
  // Nouveau modèle (v0.8) : pending = pas faite, in_progress = en cours, done = faite.
  // Legacy : approved = validée, rejected = rejetée.
  const map = {
    done: ['done', 'faite'],
    approved: ['approved', 'validée'],
    in_progress: ['in_progress', 'en cours'],
    rejected: ['rejected', 'rejetée'],
    pending: ['queued', 'pas faite'],
  };
  const [cls, label] = map[st] || ['queued', st || '—'];
  return `<span class="badge ${cls}" title="Cadrage : ${esc(label)}">${esc(label)}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- Navigation croisée + filtre par tâche --------------------------------
// Crée à la demande (et UNE seule fois) la <section class="pane"> d'un onglet
// absent du DOM statique (index.html hors périmètre). Idempotent : ne recrée
// jamais une section déjà présente.
function ensurePane(tab) {
  if (!tab || document.getElementById('pane-' + tab)) return;
  const main = document.querySelector('main');
  if (!main) return;
  const s = document.createElement('section');
  s.id = 'pane-' + tab;
  s.className = 'pane';
  main.appendChild(s);
}

function switchTab(tab) {
  // Rôle évaluateur : repli sur la page autorisée si l'onglet est hors périmètre
  // (deep-link / état résiduel) — défense UI, la garde serveur reste la référence.
  if (IS_EVALUATEUR && !EVALUATEUR_ALLOWED_TABS.includes(tab)) tab = 'features';
  // Rôle exécuteur : repli sur Vue d'ensemble si l'onglet est hors périmètre
  // (deep-link / état résiduel) — défense UI, la garde serveur reste la référence.
  else if (IS_EXECUTEUR && !EXECUTEUR_ALLOWED_TABS.includes(tab)) tab = 'overview';
  ensurePane(tab);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tab));
  activeTab = tab;
}

// --- Navigation CENTRÉE PROJET ---------------------------------------------
// Onglets GLOBAUX (aucun projet ouvert) : accueil = liste des projets.
const GLOBAL_TABS = [
  ['projects', 'Projets'],
  ['overview', "Vue d'ensemble"],
  ['ecosystem', 'Écosystème'],
  ['workspaces', 'Workspaces'], // admin uniquement
  ['users', 'Utilisateurs'], // admin uniquement
];
// Sous-onglets d'un PROJET ouvert : toutes les données du projet.
const PROJECT_TABS = [
  ['overview', "Vue d'ensemble"],
  ['tasks', 'Tâches'],
  ['cadrages', 'Cadrage technique'],
  ['recettes', 'Recette'],
  ['e2etests', 'Tests E2E'],
  ['decisions', 'Décisions'],
  ['artifacts', 'Artefacts'],
  ['adr', 'ADR'],
  ['sprints', 'Sprints'],
  ['features', 'Fonctionnalités & Règles'],
  ['e2esecrets', 'Vars & Secrets E2E'],
  ['archives', 'Archives'],
];

// Rôle ÉVALUATEUR (ADR-002) : onglets restreints. Global = Projets (pour choisir
// un projet) ; projet ouvert = Fonctionnalités & Règles, Tests E2E, Recette
// (`recettes` — SA page, distincte du Cadrage technique exécuteur).
// La page d'atterrissage est `features` (jamais `overview`).
const EVALUATEUR_GLOBAL_TABS = [
  ['projects', 'Projets'],
];
const EVALUATEUR_PROJECT_TABS = [
  ['features', 'Fonctionnalités & Règles'],
  ['e2etests', 'Tests E2E'],
  ['recettes', 'Recette'],
];
const EVALUATEUR_ALLOWED_TABS = ['projects', 'features', 'e2etests', 'recettes'];

// Rôle EXÉCUTEUR (ADR-001/002) : Vue d'ensemble, Tâches, Cadrage technique
// (onglet `cadrages`), Tests E2E, Fonctionnalités & Règles, Décisions, ADR et
// Workspaces (+ Projets pour choisir un projet). Les Déploiements restent
// accessibles via le modal de détail de tâche (`data-goto="deployments"`).
const EXECUTEUR_GLOBAL_TABS = [
  ['projects', 'Projets'],
  ['workspaces', 'Workspaces'],
];
const EXECUTEUR_PROJECT_TABS = [
  ['overview', "Vue d'ensemble"],
  ['tasks', 'Tâches'],
  ['cadrages', 'Cadrage technique'],
  ['recettes', 'Recette'],
  ['e2etests', 'Tests E2E'],
  ['features', 'Fonctionnalités & Règles'],
  ['decisions', 'Décisions'],
  ['adr', 'ADR'],
];
const EXECUTEUR_ALLOWED_TABS = ['projects', 'overview', 'tasks', 'cadrages', 'recettes', 'e2etests', 'features', 'decisions', 'adr', 'workspaces'];

// --- Terminologie « Cadrage technique » (ADR-001) --------------------------
// L'entité historique « Recette » est un « Cadrage technique » (onglet
// `cadrages`) et ses éléments convertibles en tâches sont des « éléments de
// cadrage ». Terminologie UNIQUE pour TOUS les rôles (admin / superviseur /
// évaluateur / exécuteur) : plus aucune branche conditionnelle par rôle.
// La page « Recette » de l'ÉVALUATEUR est DISTINCTE (`recettes`) et garde sa
// terminologie propre (aucun terme ici ne la concerne).
function cadrageTerms() {
  return {
    entity: 'Cadrage technique',
    entityLower: 'cadrage technique',
    theEntity: 'le cadrage technique',
    entities: 'Cadrages techniques',
    entitiesLower: 'cadrages techniques',
    newEntity: 'Nouveau cadrage',
    empty: 'Aucun cadrage.',
    finish: 'Terminer le cadrage',
    detail: 'Détail du cadrage',
    session: 'Session du cadrage',
    sessionHint: 'Démarrer la session de cadrage (un cadrage = une session)',
    sessionResume: 'Reprendre la session de cadrage en cours',
    element: 'élément de cadrage',
    elements: 'éléments de cadrage',
    elementsCap: 'Éléments de cadrage',
    docTitle: 'Documents du cadrage',
    docAddTitle: 'Ajouter un document au cadrage',
    docTo: 'au cadrage technique',
    doneNoTasks: 'Cadrage terminé (aucune tâche créée).',
  };
}

// Base des routes du CADRAGE TECHNIQUE : `/api/cadrages` est la route canonique
// (ADR-004) pour tous les rôles — plus d'alias `/api/recettes` (réaffecté à la
// recette évaluateur).
function cadragesApiBase() {
  return '/api/cadrages';
}

// Fieldset « Projet » EN LECTURE SEULE pour les modales de création (cadrage
// technique / recette évaluateur). Le projet de création est TOUJOURS le projet
// actuellement ouvert (`currentProject`, ADR-001/ADR-004 — 1 objet = 1 projet) :
// aucun combo de secours n'est proposé. Sans projet ouvert, un message explicite
// est rendu (la garde de création est posée par `applyNoProjectGuard`).
function projectReadonlyFieldsetHtml(projects) {
  const legend = '<legend>Projet <span class="muted-sm">(projet ouvert — non modifiable)</span></legend>';
  if (!currentProject) {
    return `<fieldset class="pilot-fieldset">${legend}<p class="muted-sm">Aucun projet ouvert — ouvrez un projet avant de créer.</p></fieldset>`;
  }
  const p = (projects || []).find((x) => x.id === currentProject);
  const name = (p && (p.name || p.id)) || currentProject;
  return `<fieldset class="pilot-fieldset">${legend}<div class="proj-readonly"><strong>${esc(name)}</strong> <code class="chip-project" title="Projet (produit) de création">${esc(currentProject)}</code></div></fieldset>`;
}

// Sprint ACTIF (nominal) d'un projet : `status='open'` et NON `isDefault` (le
// sprint par défaut est l'ancre de traçage des anciens sprints). Renvoie '' si
// aucun sprint nominal n'est ouvert : aucune restriction de sprint à appliquer.
// Miroir client de `activeSprintId` (server.mjs) pour pré-régler les filtres.
function activeSprintFor(sprints) {
  const open = (sprints || []).filter((s) => s.status === 'open' && !s.isDefault);
  if (!open.length) return '';
  open.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  return open[0].id;
}

// Construit la barre d'onglets selon l'état (projet ouvert ou non).
function renderNav() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  const tabs = IS_EVALUATEUR
    ? (currentProject ? EVALUATEUR_PROJECT_TABS : EVALUATEUR_GLOBAL_TABS)
    : IS_EXECUTEUR
      ? (currentProject ? EXECUTEUR_PROJECT_TABS : EXECUTEUR_GLOBAL_TABS)
      : (currentProject ? PROJECT_TABS : GLOBAL_TABS);
  const activeIsDefault = (ORGANIZATIONS.find((o) => o.id === currentOrg) || {}).isDefault === true;
  const buttons = tabs
    .filter(([t]) => t !== 'users' || IS_ADMIN)
    .filter(([t]) => t !== 'ecosystem' || activeIsDefault)
    .map(([t, label]) => `<button data-tab="${t}">${esc(label)}</button>`)
    .join('');
  const back = currentProject
    ? `<button data-nav="back" class="nav-back" title="Revenir à la liste des projets">← Projets</button>`
    : '';
  nav.innerHTML = back + buttons;
  nav.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => {
    taskFilter = '';
    switchTab(b.dataset.tab);
    refreshActive();
  }));
  const backBtn = nav.querySelector('button[data-nav="back"]');
  if (backBtn) backBtn.addEventListener('click', () => closeProject());
  // Bandeau projet.
  const banner = document.getElementById('project-banner');
  if (banner) {
    if (currentProject) {
      banner.hidden = false;
      banner.innerHTML = `<span class="pb-label">Projet</span> <strong>${esc(currentProject)}</strong>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
}

// Ouvre un projet : toutes les vues deviennent scopées à ce projet.
function openProject(id) {
  if (!id) return;
  setCurrentProject(id);
  renderNav();
  // L'évaluateur atterrit sur une page autorisée (Fonctionnalités & Règles).
  switchTab(IS_EVALUATEUR ? 'features' : 'overview');
  refreshActive();
}

// Ferme le projet courant : retour à l'accueil (liste des projets).
function closeProject() {
  setCurrentProject('');
  renderNav();
  switchTab('projects');
  refreshActive();
}

// --- Organisations (tenant) : sélecteur global + gestion --------------------
async function loadOrganizations() {
  let all = [];
  try { all = ((await api('/api/orgs')).organizations || []); } catch { all = []; }
  // Un utilisateur ne voit que les organisations auxquelles il appartient.
  const mine = (ME && Array.isArray(ME.organizations) && ME.organizations.length) ? ME.organizations : all.map((o) => o.id);
  ORGANIZATIONS = all.filter((o) => mine.includes(o.id));
  if (ME && ME.activeOrganizationId) currentOrg = ME.activeOrganizationId;
  if (!currentOrg || !ORGANIZATIONS.some((o) => o.id === currentOrg)) {
    currentOrg = (ORGANIZATIONS[0] && ORGANIZATIONS[0].id) || '';
  }
  renderOrgSelector();
  renderNav();
}
function renderOrgSelector() {
  const sel = document.getElementById('org-select');
  if (!sel) return;
  sel.innerHTML = ORGANIZATIONS.map((o) => `<option value="${esc(o.id)}" ${o.id === currentOrg ? 'selected' : ''}>${esc(o.name || o.id)}${o.isDefault ? ' ★' : ''}</option>`).join('') || '<option value="">—</option>';
  sel.value = currentOrg;
}
// Écran de choix d'organisation après connexion (si l'utilisateur en a plusieurs).
function orgPickerModal() {
  showModal(`
    <div class="modal">
      <h2>Choisir une organisation</h2>
      <p class="muted-sm">Vous appartenez à plusieurs organisations. Sélectionnez celle dans laquelle entrer — vous ne verrez que ses données.</p>
      <div class="recette-list">${ORGANIZATIONS.map((o) => `<button class="launch-btn" style="display:block;width:100%;text-align:left;margin-bottom:6px" data-org-pick="${esc(o.id)}">${esc(o.name || o.id)}${o.isDefault ? ' ★' : ''} <span class="muted-sm">${esc(o.description || '')}</span></button>`).join('')}</div>
    </div>`);
  document.querySelectorAll('#modal-backdrop [data-org-pick]').forEach((b) => b.addEventListener('click', async () => {
    await switchOrganization(b.dataset.orgPick);
    closeModal();
  }));
}
async function switchOrganization(orgId) {
  try {
    await api('/api/session/organization', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId: orgId }) });
    currentOrg = orgId;
    localStorage.setItem('panel_current_org', currentOrg);
    await loadOrganizations();
    closeProject();
  } catch (e) { alert('Échec : ' + (e.message || e)); }
}
async function orgManageModal() {
  const orgs = ORGANIZATIONS;
  const isAdmin = !!IS_ADMIN;
  const rows = orgs.map((o) => `<div class="recette-item">
    <code class="chip">${esc(o.id)}</code>
    <strong>${esc(o.name)}</strong>
    <span class="muted-sm" style="flex:1">${esc(o.description || '')}${o.coderUrl ? ` · Coder <code>${esc(o.coderUrl)}</code>` : ''}${o.coderTemplate ? ` (${esc(o.coderTemplate)})` : ''} ${o.hasCoderToken ? '· 🔒 Coder token' : '· Coder token ∅'} ${o.gitTokens && o.gitTokens.length ? '· 🔒 ' + o.gitTokens.length + ' git token' + (o.gitTokens.length > 1 ? 's' : '') : (o.hasGitToken ? '· 🔒 git token (défaut)' : '· git token ∅')}</span>
    ${isAdmin ? `<button class="ghost tiny" data-org-edit="${esc(o.id)}" data-org-name="${esc(o.name)}" data-org-desc="${esc(o.description || '')}" data-org-url="${esc(o.coderUrl || '')}" data-org-tpl="${esc(o.coderTemplate || '')}">Configurer</button><button class="ghost tiny danger-text" data-org-del="${esc(o.id)}">Supprimer</button>` : ''}
  </div>`).join('') || '<p class="muted-sm">Aucune organisation.</p>';
  // Tokens git de l'org sélectionnée (éditée).
  const selectedOrgId = (orgs.find((o) => o.id === document.getElementById('org-id') && document.getElementById('org-id').value) || orgs[0] || {}).id || '';
  const selectedOrg = orgs.find((o) => o.id === selectedOrgId) || orgs[0] || {};
  const tokens = (selectedOrg && selectedOrg.gitTokens) || [];
  showModal(`
    <div class="modal modal-wide">
      <h2>Organisations</h2>
      <p class="muted-sm">Tenant de premier niveau. Toutes les données sont rattachées à une organisation. La <strong>config Coder</strong> (URL + template + token) et les <strong>tokens git</strong> sont propres à chaque organisation — les tokens sont stockés <strong>chiffrés</strong> et jamais réaffichés. <span class="muted-sm">Un token git par défaut est le token 'classique' de l'organisation (champ token git du formulaire ci-dessous). Les tokens additionnels (PAT multiples) sont gérés dans la section dédiée.</span></p>
      <div class="recette-list">${rows}</div>
      ${isAdmin ? `<form id="org-form" class="pilot-form" style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
        <div class="pd-inline">
          <input id="org-id" placeholder="identifiant (ex. onirtech)" required value="${esc(selectedOrgId)}">
          <input id="org-name" placeholder="nom lisible (ex. ONIRTECH)" required value="${esc(selectedOrg.name || '')}">
        </div>
        <input id="org-desc" placeholder="description" value="${esc(selectedOrg.description || '')}">
        <input id="org-coder-url" placeholder="URL du serveur Coder (ex. https://ide.madatalk.fr)" value="${esc(selectedOrg.coderUrl || '')}">
        <input id="org-coder-template" placeholder="template Coder (ex. docker-ubuntu)" value="${esc(selectedOrg.coderTemplate || '')}">
        <input id="org-coder-token" type="password" placeholder="token Coder (vide = inchangé ; stocké chiffré)">
        <input id="org-git-token" type="password" placeholder="token git par défaut / PAT (vide = inchangé ; stocké chiffré)">
        <div class="actions-buttons"><button type="submit" class="launch-btn">+ Créer / mettre à jour</button></div>
      </form>` : ''}
      ${isAdmin && selectedOrgId ? `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px" class="org-git-tokens-section">
        <h3>Tokens git additionnels — <code>${esc(selectedOrgId)}</code></h3>
        <p class="muted-sm">PAT multiples rattachés à cette organisation. Le token utilisé pour chaque repo est choisi lors de l'association repo → projet (onglet Repos du détail projet). Absent = fallback sur le token par défaut de l'organisation (champ ci-dessus).</p>
        <div class="recette-list" id="org-git-tokens-list">${tokens.length ? tokens.map((t) => `<div class="recette-item">
          <strong>${esc(t.name)}</strong> <code class="muted-sm" style="font-size:0.75rem">${esc(t.id)}</code>
          <span class="muted-sm" style="flex:1">· ${t.hasToken ? '🔒 stocké' : '∅'}</span>
          <button class="ghost tiny danger-text" data-org-git-del="${esc(t.id)}" data-org-git-del-name="${esc(t.name)}">Supprimer</button>
        </div>`).join('') : '<p class="muted-sm">Aucun token additionnel. Le token par défaut (formulaire ci-dessus) est utilisé pour tous les repos.</p>'}</div>
        <form id="org-git-token-form" class="pilot-form" style="margin-top:8px">
          <div class="pd-inline">
            <input id="org-git-token-name" placeholder="libellé (ex. PAT GitHub Rino)" required>
            <input id="org-git-token-value" type="password" placeholder="PAT / token git (stocké chiffré)" required>
            <button type="submit" class="launch-btn">+ Ajouter</button>
          </div>
        </form>
        <div id="org-git-msg" class="msg"></div>
      </div>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
      <div id="org-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  // Pré-remplit le formulaire pour configurer une organisation existante.
  document.querySelectorAll('#modal-backdrop [data-org-edit]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById('org-id').value = b.dataset.orgEdit;
    document.getElementById('org-name').value = b.dataset.orgName || '';
    document.getElementById('org-desc').value = b.dataset.orgDesc || '';
    document.getElementById('org-coder-url').value = b.dataset.orgUrl || '';
    document.getElementById('org-coder-template').value = b.dataset.orgTpl || '';
    document.getElementById('org-coder-token').value = '';
    document.getElementById('org-git-token').value = '';
    document.getElementById('org-coder-token').focus();
    // Re-render pour afficher les tokens de l'org sélectionnée.
    orgManageModal();
  }));
  document.querySelectorAll('#modal-backdrop [data-org-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Supprimer l'organisation ${b.dataset.orgDel} ?`)) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try { await api(`/api/orgs/${encodeURIComponent(b.dataset.orgDel)}`, { method: 'DELETE' }); await loadOrganizations(); closeModal(); orgManageModal(); refreshActive(); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      const m = document.getElementById('org-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  }));
  const form = document.getElementById('org-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Enregistrement');
    const m = document.getElementById('org-msg');
    try {
      await api('/api/orgs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: document.getElementById('org-id').value.trim(),
        name: document.getElementById('org-name').value.trim(),
        description: document.getElementById('org-desc').value.trim() || undefined,
        coderUrl: document.getElementById('org-coder-url').value.trim() || undefined,
        coderTemplate: document.getElementById('org-coder-template').value.trim() || undefined,
        coderToken: document.getElementById('org-coder-token').value.trim() || undefined,
        gitToken: document.getElementById('org-git-token').value.trim() || undefined,
      }) });
      await loadOrganizations(); closeModal(); orgManageModal(); refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      if (m) { m.textContent = err.message || String(err); m.className = 'msg error'; }
    }
  });
  // --- Tokens git additionnels (v0.10) : add / delete ---
  document.querySelectorAll('#modal-backdrop [data-org-git-del]').forEach((b) => b.addEventListener('click', async () => {
    const tokenId = b.dataset.orgGitDel;
    const tokenName = b.dataset.orgGitDelName || tokenId;
    if (!confirm(`Supprimer le token git « ${tokenName} » ? Les liaisons repo↔projet qui le référençaient repassent au token par défaut.`)) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try { await api(`/api/orgs/${encodeURIComponent(selectedOrgId)}/git-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }); await loadOrganizations(); closeModal(); orgManageModal(); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      const m = document.getElementById('org-git-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  }));
  const gitTokenForm = document.getElementById('org-git-token-form');
  if (gitTokenForm) gitTokenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    const m = document.getElementById('org-git-msg');
    const nameVal = document.getElementById('org-git-token-name').value.trim();
    const tokenVal = document.getElementById('org-git-token-value').value.trim();
    if (!nameVal || !tokenVal) { if (m) { m.textContent = 'Libellé et token requis.'; m.className = 'msg error'; } return; }
    setBtnBusy(btn, 'Ajout');
    try {
      await api(`/api/orgs/${encodeURIComponent(selectedOrgId)}/git-tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameVal, token: tokenVal }) });
      await loadOrganizations(); closeModal(); orgManageModal();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      if (m) { m.textContent = err.message || String(err); m.className = 'msg error'; }
    }
  });
}

function goToTab(tab, taskId) {
  taskFilter = taskId || '';
  switchTab(tab);
  refreshActive();
}

// Clic sur une CARTE de cardinalité (Vue d'ensemble) : ouvre l'onglet cible avec
// le FILTRE pré-appliqué et VISIBLE (le <select> de la page porte la valeur),
// puis re-rend la page (la liste est réellement filtrée par id-set). Les
// variables de filtre sont persistées comme les filtres existants.
function openCardinalityTarget(view) {
  const card = CARDINALITY_CARDS.find((c) => c.view === view);
  if (!card) return;
  if (card.tab === 'tasks') {
    tasksMissingFilter = card.filter;
    persistTasksMissing();
  } else if (card.tab === 'cadrages') {
    cadragesMissingFilter = card.filter;
    persistCadragesMissing();
  } else if (card.tab === 'sprints') {
    sprintsMissingFilter = card.filter;
    persistSprintsMissing();
  } else if (card.tab === 'adr') {
    adrFilters.missingFeature = card.filter;
    persistAdrMissing();
  }
  switchTab(card.tab);
  refreshActive();
}

function filterBar() {
  return `<div class="filter-bar">
    <label for="f-task">Tâche</label>
    <input id="f-task" placeholder="T-… (vide = toutes)" value="${esc(taskFilter)}">
    ${taskFilter ? `<button id="clear-task-filter" class="ghost" type="button">Effacer</button>` : ''}
  </div>`;
}

function bindTaskFilter() {
  const inp = document.getElementById('f-task');
  if (!inp) return;
  inp.addEventListener('change', () => { taskFilter = inp.value.trim(); refreshActive(); });
  const clr = document.getElementById('clear-task-filter');
  if (clr) clr.addEventListener('click', () => { taskFilter = ''; refreshActive(); });
}

function taskQuery() {
  const q = new URLSearchParams();
  if (taskFilter) q.set('taskId', taskFilter);
  if (currentProject) q.set('project', currentProject);
  const s = q.toString();
  return s ? '?' + s : '';
}

function detailsButtons(t) {
  return `<button class="icon-btn" title="Actions sur la tâche" data-actions="${esc(t.id)}">Actions</button>`;
}

function sessionLink(sid) {
  if (!sid) return '<span class="muted">—</span>';
  const short = sid.length > 26 ? sid.slice(0, 12) + '…' + sid.slice(-8) : sid;
  const href = sessionHref(sid);
  return `<a class="code" href="${href}" target="_blank" rel="noopener" title="${esc(sid)}">${esc(short)}</a>`;
}

// URL d'une session opencode (réutilisée par sessionLink et le bouton cadrage).
function sessionHref(sid) {
  const encoded = btoa(SESSION_BASE_URL).replace(/=+$/, '');
  return `${SESSION_BASE_URL}/server/${encoded}/session/${encodeURIComponent(sid)}`;
}

// --- Vue d'ensemble --------------------------------------------------------
// Filtres persistants de l'historique des vigilances ADR (item 126) — append-only.
let adrVigFilters = { project: '', cadrageId: '', type: '', status: 'open', from: '', to: '' };
let adrVigProjectsCache = null;

// Charge/rafraîchit l'historique FILTRABLE des points de vigilance ADR des
// cadrages (ADR manquante / conflit). Aucun bouton de suppression (append-only) ;
// seul un bouton « Lever » (raison tracée obligatoire) est proposé sur les ouverts.
async function loadAdrVigilances() {
  const box = document.getElementById('adr-vig-results');
  if (!box) return;
  const q = new URLSearchParams();
  const proj = currentProject || adrVigFilters.project;
  if (proj) q.set('project', proj);
  if (adrVigFilters.cadrageId) q.set('cadrageId', adrVigFilters.cadrageId.trim());
  if (adrVigFilters.type) q.set('type', adrVigFilters.type);
  if (adrVigFilters.status) q.set('status', adrVigFilters.status);
  if (adrVigFilters.from) q.set('from', adrVigFilters.from);
  if (adrVigFilters.to) q.set('to', adrVigFilters.to + 'T23:59:59.999Z');
  box.innerHTML = '<div class="muted-sm">Chargement…</div>';
  let data;
  try { data = await api('/api/adr-vigilances' + (q.toString() ? '?' + q.toString() : '')); }
  catch (e) { box.innerHTML = `<div class="muted-sm">Erreur : ${esc(e.message || e)}</div>`; return; }
  const list = data.vigilancess || [];
  if (!list.length) { box.innerHTML = '<div class="muted-sm">Aucun point de vigilance ADR pour ces filtres.</div>'; return; }
  const rows = list.map((v) => {
    const target = v.type === 'conflict'
      ? `${esc(v.adrId || '?')}${v.relatedAdrId ? ' vs ' + esc(v.relatedAdrId) : ''}`
      : esc(v.entity || '—');
    return `<tr class="${v.status === 'open' ? 'adr-vig-open' : ''}">
      <td class="muted-sm">${esc((v.createdAt || '').replace('T', ' ').slice(0, 16))}</td>
      <td>${esc(v.project || '—')}</td>
      <td class="code">${v.cadrageId ? esc(v.cadrageId) : '<span class="muted">—</span>'}</td>
      <td><span class="badge ${v.type === 'conflict' ? 'adr-vig-type-conflict' : 'adr-vig-type-missing'}">${v.type === 'conflict' ? 'conflit' : 'manquant'}</span></td>
      <td class="muted-sm">${target}</td>
      <td class="adr-vig-reason">${esc(v.reason || v.description || '')}</td>
      <td><span class="badge ${v.status === 'open' ? 'adr-vig-status-open' : 'adr-vig-status-resolved'}">${v.status === 'open' ? 'ouvert' : 'résolu'}</span></td>
      <td class="muted-sm">${v.resolvedAt ? esc((v.resolvedAt || '').replace('T', ' ').slice(0, 16)) + (v.resolution ? `<br><span class="adr-vig-res">${esc(v.resolution)}</span>` : '') : '<span class="muted">—</span>'}</td>
      <td>${v.status === 'open' ? `<button class="ghost" data-adr-vig-resolve="${esc(v.vigilanceId)}">Lever</button>` : ''}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="adr-vig-list"><thead><tr>
      <th>Détection</th><th>Projet</th><th>Cadrage</th><th>Type</th><th>Entité / ADR</th><th>Raison</th><th>Statut</th><th>Résolution</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll('[data-adr-vig-resolve]').forEach((b) => {
    b.addEventListener('click', async () => {
      const reason = prompt('Raison de la levée (tracée, obligatoire) :');
      if (!reason || !reason.trim()) return;
      const original = b.innerHTML;
      setBtnBusy(b, 'Levée');
      try {
        await api('/api/adr-vigilances/' + encodeURIComponent(b.dataset.adrVigResolve) + '/resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolution: reason.trim(), resolutionKind: 'manual' }),
        });
        await loadAdrVigilances();
      } catch (e) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec de la levée : ' + (e.message || e));
      }
    });
  });
}

// Barre de filtres de l'historique (projet, cadrage, type, statut, dates).
async function wireAdrVigFilters() {
  const sel = document.getElementById('adv-project');
  if (sel) {
    if (!adrVigProjectsCache) {
      try { adrVigProjectsCache = ((await api('/api/projects')).projects || []).map((p) => p.id).filter(Boolean); }
      catch { adrVigProjectsCache = []; }
    }
    sel.innerHTML = '<option value="">Tous les projets</option>' + adrVigProjectsCache.map((p) => `<option value="${esc(p)}" ${p === adrVigFilters.project ? 'selected' : ''}>${esc(p)}</option>`).join('');
    sel.addEventListener('change', () => { adrVigFilters.project = sel.value; loadAdrVigilances(); });
  }
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('adv-type', adrVigFilters.type);
  setVal('adv-status', adrVigFilters.status);
  const read = () => {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    adrVigFilters.cadrageId = g('adv-cadrage');
    adrVigFilters.type = g('adv-type');
    adrVigFilters.status = g('adv-status');
    adrVigFilters.from = g('adv-from');
    adrVigFilters.to = g('adv-to');
  };
  const apply = document.getElementById('adv-apply');
  if (apply) apply.addEventListener('click', () => { read(); loadAdrVigilances(); });
  ['adv-type', 'adv-status', 'adv-from', 'adv-to'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { read(); loadAdrVigilances(); }); });
  const rec = document.getElementById('adv-cadrage');
  if (rec) rec.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { read(); loadAdrVigilances(); } });
}

async function renderOverview() {
  const params = [];
  if (currentProject) params.push('project=' + encodeURIComponent(currentProject));
  if (currentOrg) params.push('org=' + encodeURIComponent(currentOrg));
  const s = await api('/api/stats' + (params.length ? '?' + params.join('&') : ''));
  const cards = [['Tâches', s.tasks]];
  for (const [st, n] of Object.entries(s.byStatus || {})) cards.push([st, n]);
  cards.push(['Décisions ouvertes', s.openDecisions], ['Archivées', s.archived || 0]);
  document.getElementById('pane-overview').innerHTML =
    `${currentProject ? `<h2>Vue d'ensemble — ${esc(currentProject)}</h2>` : ''}` +
    `<div class="cards">${cards.map(([l, n]) => `<div class="card"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('')}</div>` +
    `<div class="muted-sm">Registre : ${s.byStatus && Object.keys(s.byStatus).length ? 'connecté' : 'vide / non initialisé'}</div>` +
    cardinalitySectionHtml() +
    `<div class="section adr-vig-section">
      <h3>Vigilances ADR (cadrages techniques)</h3>
      <div class="muted-sm">Historique append-only des ADR manquantes / conflits remontés par les cadrages techniques et les tests. Un point OUVERT bloque « Terminer le cadrage ».</div>
      <div class="filters adr-vig-filters">
        ${currentProject ? '' : '<select id="adv-project" title="Filtrer par projet"></select>'}
        <input id="adv-cadrage" placeholder="Cadrage (CT-…)" value="${esc(adrVigFilters.cadrageId)}">
        <select id="adv-type"><option value="">Type : tous</option><option value="missing">manquant</option><option value="conflict">conflit</option></select>
        <select id="adv-status"><option value="">Statut : tous</option><option value="open">ouvert</option><option value="resolved">résolu</option></select>
        <span class="date-filter"><span class="tagfilter-label">Détecté du</span><input type="date" id="adv-from" value="${esc(adrVigFilters.from)}"><span class="tagfilter-label">au</span><input type="date" id="adv-to" value="${esc(adrVigFilters.to)}"></span>
        <button class="ghost" id="adv-apply">Filtrer</button>
      </div>
      <div id="adr-vig-results"><div class="muted-sm">Chargement…</div></div>
    </div>`;
  wireAdrVigFilters();
  loadAdrVigilances();
  wireCardinalityOverview();
}

// --- Tâches ----------------------------------------------------------------
// États de tâche NON actifs (filtre « Actif ») : une tâche dans l'un de ces états
// n'est plus « à traiter / en cours ». Blocklist volontaire plutôt qu'une liste
// d'inclusion : tout état futur ajouté au registre sera considéré actif par
// défaut, ce qui est le comportement sûr pour un filtre nommé « Actif ».
// Partition de VALID_STATES (statemachine.mjs) : 23 = 17 actifs + 6 non actifs.
const TASK_INACTIVE_STATES = ['done', 'aborted', 'failed', 'blocked', 'crashed', 'rejected'];
async function renderTasks() {
  // Projet ouvert → le filtre projet est verrouillé sur ce projet.
  if (currentProject) tasksProjectFilter = currentProject;
  // Exécuteur : le serveur restreint à son sprint actif → lui transmettre le
  // projet (résolution du sprint actif) et, s'il trace, `?sprint=<id>`.
  const tasksQs = new URLSearchParams();
  if (currentProject) tasksQs.set('project', currentProject);
  if (IS_EXECUTEUR && tasksSprintFilter) tasksQs.set('sprint', tasksSprintFilter);
  const tasksUrl = '/api/tasks' + (tasksQs.toString() ? `?${tasksQs.toString()}` : '');
  const [data, plansData] = await Promise.all([api(tasksUrl), api('/api/plans')]);
  // Exécuteur : liste des sprints du projet pour le filtre de traçage.
  let sprintList = [];
  if (IS_EXECUTEUR && currentProject) {
    try { sprintList = ((await api(`/api/sprints?projectId=${encodeURIComponent(currentProject)}`)).sprints || []); } catch { sprintList = []; }
  }
  const tasks = data.tasks || [];
  const plans = plansData.plans || [];
  const plansByTask = {};
  plans.forEach((p) => { if (p.task_id) (plansByTask[p.task_id] = plansByTask[p.task_id] || []).push(p); });
  // Filtre CIBLE « sans lien » : id-set de la vue de cardinalité correspondante
  // (source = registre). `null` = filtre inactif ou indisponible → liste non filtrée.
  const missingIds = tasksMissingFilter ? await cardinalityIdSetFor(tasksMissingFilter, 'task') : null;
  const projects = [...new Set(tasks.map((t) => t.project).filter(Boolean))];
  document.getElementById('pane-tasks').innerHTML = `
    <h2>Tâches</h2>
    <div class="filters">
      ${currentProject ? '' : `<select id="f-project"><option value="">Tous les projets</option>${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>`}
      <div class="status-tagfilter" id="status-tagfilter" title="Afficher les tâches dont le statut est sélectionné (multi)">
        <span class="tagfilter-label">Statuts :</span>
        <span class="tagfilter-tags" id="f-status-tags"></span>
        <select id="f-status-add" title="Ajouter un statut à afficher"><option value="">+ Ajouter…</option></select>
        <button type="button" class="ghost tagfilter-clear" id="f-status-clear" hidden>tout afficher</button>
      </div>
      <div class="status-tagfilter" id="user-tagfilter" title="Afficher les tâches des utilisateurs sélectionnés (multi)">
        <span class="tagfilter-label">Créateurs :</span>
        <span class="tagfilter-tags" id="f-user-tags"></span>
        <select id="f-user-add" title="Ajouter un créateur à filtrer"><option value="">+ Ajouter…</option></select>
        <button type="button" class="ghost tagfilter-clear" id="f-user-clear" hidden>tout afficher</button>
      </div>
      <label class="muted filter-check"><input type="checkbox" id="f-group-cadrage" ${groupCadrageEnabled ? 'checked' : ''}> Grouper par cadrage</label>
      <label class="muted filter-check"><input type="checkbox" id="f-group-user" ${groupUserEnabled ? 'checked' : ''}> Grouper par utilisateur</label>
      <label class="muted filter-check" id="f-group-parallel-wrap" hidden><input type="checkbox" id="f-group-parallel" ${groupParallelEnabled ? 'checked' : ''}> Grouper par tâches parallèles</label>
      <label class="muted filter-check" title="Tâches dont le cadrage n'est pas faite"><input type="checkbox" id="f-filter-cadrage" ${tasksNeedCadrage ? 'checked' : ''}> À cadrer</label>
      <label class="muted filter-check" title="Tâches réellement actives (hors done, aborted, failed, blocked, crashed, rejected)"><input type="checkbox" id="f-filter-actif" ${tasksActifOnly ? 'checked' : ''}> Actif</label>
      <span class="date-filter" title="Filtrer par date de création">
        <span class="tagfilter-label">Créée du</span>
        <input type="date" id="f-date-from" value="${esc(tasksDateFrom)}">
        <span class="tagfilter-label">au</span>
        <input type="date" id="f-date-to" value="${esc(tasksDateTo)}">
        <button type="button" class="ghost" id="f-date-clear" title="Effacer le filtre date" ${(tasksDateFrom || tasksDateTo) ? '' : 'hidden'}>✕</button>
      </span>
      <select id="f-missing" title="Filtrer par lien manquant (cardinalité : source registre)">
        <option value="">Sans lien : tous</option>
        <option value="tache_sans_adr">Sans ADR</option>
        <option value="tache_sans_fonctionnalite">Sans fonctionnalité</option>
        <option value="tache_sans_sprint">Sans sprint</option>
        <option value="emergents">Émergentes</option>
      </select>
      ${IS_EXECUTEUR && currentProject ? `<select id="f-sprint" title="Sprint — l'exécuteur travaille dans le sprint actif ; sélectionner un autre sprint = traçage (lecture seule)">
        <option value="">Sprint actif</option>
        ${sprintList.map((s) => `<option value="${esc(s.id)}" ${tasksSprintFilter === s.id ? 'selected' : ''}>${esc(s.title || s.id)}${s.status !== 'open' ? ' (clôturé)' : ''}</option>`).join('')}
      </select>` : ''}
      <button id="new-task-btn" class="launch-btn">+ Nouvelle tâche</button>
    </div>
    <table><thead><tr><th></th><th>ID</th><th>Projet</th><th>Type</th><th>Priorité</th><th>Statut</th><th>Cadrage</th><th>E2E</th><th>Demande</th><th>Session</th><th>Créée par</th><th>Actions</th></tr></thead>
    <tbody id="tasks-body"></tbody></table>`;
  const statuses = [...new Set(tasks.map((t) => t.status || 'queued'))];
  const projectSel = document.getElementById('f-project');
  if (projectSel) {
    // Restaure le filtre projet (perdu lors d'un re-rendu : polling, retour d'onglet…).
    if (tasksProjectFilter && !projects.includes(tasksProjectFilter)) projects.push(tasksProjectFilter);
    projectSel.innerHTML = `<option value="">Tous les projets</option>` + projects.map((p) => `<option>${esc(p)}</option>`).join('');
    projectSel.value = [...projectSel.options].some((o) => o.value === tasksProjectFilter) ? tasksProjectFilter : '';
  }
  // Filtre statut MULTI-VALEURS : puces + sélecteur d'ajout (pas un combo à valeur unique).
  const tagsBox = document.getElementById('f-status-tags');
  const statusSelAdd = document.getElementById('f-status-add');
  const statusClear = document.getElementById('f-status-clear');
  const allStatuses = [...new Set([...statuses, ...tasksStatusFilter])]; // conserve les puces choisies
  const renderStatusUI = () => {
    tagsBox.innerHTML = tasksStatusFilter.length
      ? tasksStatusFilter.map((s) => `<span class="status-chip"><span class="chip-txt">${esc(s)}</span><button type="button" class="chip-x" data-status="${esc(s)}" title="Retirer « ${esc(s)} »">×</button></span>`).join('')
      : '<span class="tagfilter-empty">tous les statuts</span>';
    statusSelAdd.innerHTML = `<option value="">+ Ajouter…</option>` + allStatuses.filter((s) => !tasksStatusFilter.includes(s)).map((s) => `<option>${esc(s)}</option>`).join('');
    statusClear.hidden = !tasksStatusFilter.length;
  };
  renderStatusUI();
  const setStatusFilter = (next) => {
    tasksStatusFilter = [...new Set(next)];
    persistTasksStatus();
    renderStatusUI();
    apply();
  };
  // Filtre créateur MULTI-VALEURS (même mécanisme que les statuts).
  const userTagsBox = document.getElementById('f-user-tags');
  const userSelAdd = document.getElementById('f-user-add');
  const userClear = document.getElementById('f-user-clear');
  const allCreators = [...new Set([...tasks.map((t) => t.created_by || '—').filter(Boolean), ...tasksUserFilter])];
  const renderUserUI = () => {
    userTagsBox.innerHTML = tasksUserFilter.length
      ? tasksUserFilter.map((u) => `<span class="status-chip"><span class="chip-txt">${esc(u)}</span><button type="button" class="chip-x" data-user="${esc(u)}" title="Retirer « ${esc(u)} »">×</button></span>`).join('')
      : '<span class="tagfilter-empty">tous les créateurs</span>';
    userSelAdd.innerHTML = `<option value="">+ Ajouter…</option>` + allCreators.filter((u) => !tasksUserFilter.includes(u)).map((u) => `<option>${esc(u)}</option>`).join('');
    userClear.hidden = !tasksUserFilter.length;
  };
  renderUserUI();
  const setUserFilter = (next) => {
    tasksUserFilter = [...new Set(next)];
    persistTasksUsers();
    renderUserUI();
    apply();
  };
  document.getElementById('new-task-btn').addEventListener('click', () => taskCreateModal());
  const apply = () => {
    const p = currentProject || (document.getElementById('f-project')?.value || '');
    const st = tasksStatusFilter;
    const groupCadrage = document.getElementById('f-group-cadrage').checked;
    const groupUser = document.getElementById('f-group-user').checked;
    const groupParallel = document.getElementById('f-group-parallel').checked;
    const parallelWrap = document.getElementById('f-group-parallel-wrap');
    if (parallelWrap) parallelWrap.hidden = !groupCadrage;
    const needCadrage = document.getElementById('f-filter-cadrage').checked;
    const actifOnly = document.getElementById('f-filter-actif').checked;
    const dateFrom = document.getElementById('f-date-from').value; // YYYY-MM-DD
    const dateTo = document.getElementById('f-date-to').value;
    const dayOf = (t) => (t.created_at || '').slice(0, 10); // partie date ISO
    const uf = tasksUserFilter;
    const rows = tasks.filter((t) =>
      (!p || t.project === p)
      && (!currentOrg || (t.organization_id || 'onirtech') === currentOrg)
      && (!st.length || st.includes(t.status || 'queued'))
      && (!uf.length || uf.includes(t.created_by || '—'))
      && (!needCadrage || (t.cadrage_status || 'pending') !== 'done')
      && (!actifOnly || !TASK_INACTIVE_STATES.includes(t.status || 'queued'))
      && (!tasksMissingFilter || !missingIds || missingIds.has(t.id))
      && (!dateFrom || dayOf(t) >= dateFrom)
      && (!dateTo || dayOf(t) <= dateTo));

    // Une ligne de tâche (avec ses plans en sous-lignes).
    const rowHtml = (t, cadrageParent, userGroup) => {
      const subs = plansByTask[t.id] || [];
      const toggle = subs.length ? `<button class="tree-toggle" data-toggle="${esc(t.id)}">▸</button>` : '';
      const cadrageAttr = cadrageParent ? ` data-recette-child="${esc(cadrageParent)}"` : '';
      const userAttr = userGroup ? ` data-user-child="${esc(userGroup)}"` : '';
      const cadrageBadgeExtra = t.cadrage_class
        ? ` <span class="badge ${CADRAGE_CLS_BADGE[t.cadrage_class] || 'queued'}" title="Issue du cadrage (${CADRAGE_CLS_LABEL[t.cadrage_class]})">cadrage</span>`
        : '';
      const orderBadge = t.cadrage_order != null
        ? ` <span class="badge order-badge" title="Ordre d'exécution recommandé (cadrage)">ordre ${esc(t.cadrage_order)}</span>`
        : '';
      const vigBadge = t.cadrage_vigilance
        ? ` <span class="badge danger vig-badge" title="Point de vigilance / écart sémantique : ${esc(t.cadrage_vigilance)}">⚠ vigilance</span>`
        : '';
      const parent = `<tr class="task-row"${cadrageAttr}${userAttr}>
        <td>${toggle}</td>
        <td class="code">${esc(t.id)}</td>
        <td>${esc(t.project)}</td>
        <td>${esc(t.type)}</td>
        <td>${esc(t.priority)}</td>
        <td>${badge(t.status)}${t.waiting_human ? '<span class="badge waiting-human" title="Une décision humaine est en attente (validation / review)">⏳ attente humaine</span>' : ''}</td>
        <td>${cadrageBadge(t.cadrage_status)}${cadrageBadgeExtra}${orderBadge}${vigBadge}</td>
        <td>${e2eBadgeCell(t)}</td>
        <td><span title="${esc(t.request || '')}"><strong>${esc((t.title && t.title.trim()) ? t.title : (t.request || '').slice(0, 60))}</strong></span>${(t.title && t.title.trim()) && t.request ? `<span class="muted-sm"> — ${esc(t.request.slice(0, 40))}</span>` : ''}</td>
        <td>${sessionLink(t.session_id)}</td>
        <td>${esc(t.created_by || '—')}</td>
        <td>${detailsButtons(t)}</td>
      </tr>`;
      const children = subs.map((s) => `
        <tr class="subtask-row" data-child="${esc(t.id)}"${cadrageAttr}${userAttr} hidden>
          <td></td>
          <td colspan="11">
            <div class="subtask">
              <span class="tree-branch">↳</span>
              <code>${esc(s.planId)}</code>
              <span class="muted-sm">${esc(s.objective || '')}</span>
              ${progressBar(s.pct)}
              ${s.branch ? `<code class="muted-sm">${esc(s.branch)}</code>` : '<span class="muted-sm">—</span>'}
              ${s.execution_status ? badge(s.execution_status) : '<span class="muted-sm">non exécuté</span>'}
              ${badge(s.status)}
              <button class="commit-btn" data-commits="${esc(s.planId)}" title="Voir les commits et leurs diffs">commits (${s.commit_count || 0})</button>
            </div>
          </td>
        </tr>`).join('');
      return parent + children;
    };

    // Groupement par cadrage (factorisé pour être réutilisé à l'intérieur d'un groupe utilisateur).
    const renderCadrageGroups = (list, userGroup) => {
      const bySource = {};
      const others = [];
      for (const t of list) {
        if (t.cadrage_source) (bySource[t.cadrage_source] = bySource[t.cadrage_source] || []).push(t);
        else others.push(t);
      }
      const cadrageKey = (sourceId) => userGroup ? `${userGroup}:${sourceId}` : sourceId;
      const groupHtml = (sourceId, list) => {
        const sorted = [...list].sort((a, b) => (a.cadrage_order ?? 999) - (b.cadrage_order ?? 999) || String(a.id).localeCompare(String(b.id)));
        const title = sorted[0] && sorted[0].cadrage_source_title;
        const label = sourceId === '(sans cadrage)'
          ? 'Autres tâches'
          : (title ? `Cadrage — ${esc(title)}` : `Cadrage de ${esc(sourceId)}`);
        const cls = [...new Set(sorted.map((x) => x.cadrage_class).filter(Boolean))];
        const rKey = cadrageKey(sourceId);
        const userAttr = userGroup ? ` data-user-child="${esc(userGroup)}"` : '';
        const head = `<tr class="recette-group-head"${userAttr}><td colspan="12">
          <button class="tree-toggle" data-recette-toggle="${esc(rKey)}">▸</button>
          <span class="code">${label}</span>
          <span class="muted-sm">— ${sorted.length} tâche(s)${cls.length ? ' · ' + cls.map((c) => CADRAGE_CLS_LABEL[c]).join(' / ') : ''}</span>
        </td></tr>`;
        const members = () => {
          if (!groupParallel) return sorted.map((t) => rowHtml(t, rKey, userGroup)).join('');
          // Sous-groupes par ordre d'exécution (même ordre = parallèle).
          const byOrder = {};
          sorted.forEach((t) => { const o = t.cadrage_order ?? 999; (byOrder[o] = byOrder[o] || []).push(t); });
          return Object.keys(byOrder).sort((a, b) => Number(a) - Number(b)).map((o) => {
            const l = byOrder[o];
            const isParallel = l.length > 1;
            const subHead = `<tr class="recette-order-row" data-recette-child="${esc(rKey)}"${userAttr}><td colspan="12">
              <span class="tree-branch">↳</span> <strong>Ordre ${o === '999' ? '— (non défini)' : esc(o)}</strong>${isParallel ? ` <span class="muted-sm">(${l.length} exécutables en parallèle)</span>` : ''}
            </td></tr>`;
            return subHead + l.map((t) => rowHtml(t, rKey, userGroup)).join('');
          }).join('');
        };
        return head + members();
      };
      const groups = Object.entries(bySource).sort((a, b) => b[0].localeCompare(a[0])).map(([s, l]) => groupHtml(s, l)).join('');
      const othersHtml = others.length ? groupHtml('(sans cadrage)', others) : '';
      return (groups + othersHtml) || '<tr><td colspan="12" class="muted">Aucune tâche</td></tr>';
    };

    let html;
    if (groupUser) {
      const byUser = {};
      for (const t of rows) {
        const u = t.created_by || '(sans utilisateur)';
        (byUser[u] = byUser[u] || []).push(t);
      }
      html = Object.entries(byUser).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([user, list]) => {
        const head = `<tr class="recette-group-head"><td colspan="12">
          <button class="tree-toggle" data-user-toggle="${esc(user)}">▸</button>
          <span class="code">${esc(user)}</span>
          <span class="muted-sm">— ${list.length} tâche(s)</span>
        </td></tr>`;
        const body = groupCadrage ? renderCadrageGroups(list, user) : list.map((t) => rowHtml(t, null, user)).join('') || '<tr><td colspan="12" class="muted">Aucune tâche</td></tr>';
        return head + body;
      }).join('');
    } else if (groupCadrage) {
      html = renderCadrageGroups(rows, null);
    } else {
      html = rows.map((t) => rowHtml(t, null, null)).join('') || '<tr><td colspan="12" class="muted">Aucune tâche</td></tr>';
    }

    document.getElementById('tasks-body').innerHTML = html;
    document.querySelectorAll('#tasks-body [data-actions]').forEach((b) => b.addEventListener('click', () => taskActionsModal(b.dataset.actions)));
    document.querySelectorAll('#tasks-body [data-commits]').forEach((b) => b.addEventListener('click', () => renderPlanCommitsModal(b.dataset.commits)));
    document.querySelectorAll('#tasks-body [data-goto-e2e]').forEach((b) => b.addEventListener('click', () => goToTab('e2etests', b.dataset.gotoE2e)));
    document.querySelectorAll('#tasks-body [data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.toggle;
      const children = document.querySelectorAll(`#tasks-body [data-child="${id}"]`);
      const expanded = b.textContent === '▾';
      children.forEach((c) => { c.hidden = expanded; });
      b.textContent = expanded ? '▸' : '▾';
    }));
    document.querySelectorAll('#tasks-body [data-recette-toggle]').forEach((b) => b.addEventListener('click', () => {
      const src = b.dataset.cadrageToggle;
      const children = document.querySelectorAll(`#tasks-body [data-recette-child="${src}"]`);
      const expanded = b.textContent === '▾';
      children.forEach((c) => { c.hidden = expanded; });
      b.textContent = expanded ? '▸' : '▾';
    }));
    document.querySelectorAll('#tasks-body [data-user-toggle]').forEach((b) => b.addEventListener('click', () => {
      const user = b.dataset.userToggle;
      const children = document.querySelectorAll(`#tasks-body [data-user-child="${user}"]`);
      const expanded = b.textContent === '▾';
      children.forEach((c) => { c.hidden = expanded; });
      b.textContent = expanded ? '▸' : '▾';
    }));
  };
  const fProjEl = document.getElementById('f-project');
  if (fProjEl) fProjEl.addEventListener('change', () => {
    tasksProjectFilter = fProjEl.value;
    localStorage.setItem('panel_task_project', tasksProjectFilter);
    apply();
  });
  // Filtre SPRINT (exécuteur) : change le périmètre CÔTÉ SERVEUR → re-fetch.
  const fSprintEl = document.getElementById('f-sprint');
  if (fSprintEl) fSprintEl.addEventListener('change', () => {
    tasksSprintFilter = fSprintEl.value;
    if (tasksSprintFilter) localStorage.setItem('panel_task_sprint', tasksSprintFilter);
    else localStorage.removeItem('panel_task_sprint');
    refreshActive();
  });
  // Filtre cible « sans lien » : valeur pré-appliquée (clic carte) + persistance.
  const fMissingEl = document.getElementById('f-missing');
  if (fMissingEl) {
    fMissingEl.value = tasksMissingFilter || '';
    fMissingEl.addEventListener('change', () => {
      tasksMissingFilter = fMissingEl.value;
      persistTasksMissing();
      refreshActive();
    });
  }
  statusSelAdd.addEventListener('change', () => {
    const v = statusSelAdd.value;
    if (v && !tasksStatusFilter.includes(v)) setStatusFilter([...tasksStatusFilter, v]);
    statusSelAdd.value = '';
  });
  tagsBox.addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (x) setStatusFilter(tasksStatusFilter.filter((s) => s !== x.dataset.status));
  });
  statusClear.addEventListener('click', () => setStatusFilter([]));
  userSelAdd.addEventListener('change', () => {
    const v = userSelAdd.value;
    if (v && !tasksUserFilter.includes(v)) setUserFilter([...tasksUserFilter, v]);
    userSelAdd.value = '';
  });
  userTagsBox.addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (x) setUserFilter(tasksUserFilter.filter((u) => u !== x.dataset.user));
  });
  userClear.addEventListener('click', () => setUserFilter([]));
  const needCadrageBox = document.getElementById('f-filter-cadrage');
  if (needCadrageBox) needCadrageBox.addEventListener('change', () => {
    tasksNeedCadrage = needCadrageBox.checked;
    localStorage.setItem('panel_task_recette', tasksNeedCadrage ? '1' : '0');
    apply();
  });
  const actifBox = document.getElementById('f-filter-actif');
  if (actifBox) actifBox.addEventListener('change', () => {
    tasksActifOnly = actifBox.checked;
    localStorage.setItem('panel_task_actif', tasksActifOnly ? '1' : '0');
    apply();
  });
  const dateFromEl = document.getElementById('f-date-from');
  const dateToEl = document.getElementById('f-date-to');
  const dateClearEl = document.getElementById('f-date-clear');
  const syncDateClear = () => { if (dateClearEl) dateClearEl.hidden = !(dateFromEl.value || dateToEl.value); };
  if (dateFromEl) dateFromEl.addEventListener('change', () => {
    tasksDateFrom = dateFromEl.value;
    localStorage.setItem('panel_task_date_from', tasksDateFrom);
    syncDateClear();
    apply();
  });
  if (dateToEl) dateToEl.addEventListener('change', () => {
    tasksDateTo = dateToEl.value;
    localStorage.setItem('panel_task_date_to', tasksDateTo);
    syncDateClear();
    apply();
  });
  if (dateClearEl) dateClearEl.addEventListener('click', () => {
    tasksDateFrom = ''; tasksDateTo = '';
    localStorage.removeItem('panel_task_date_from');
    localStorage.removeItem('panel_task_date_to');
    dateFromEl.value = ''; dateToEl.value = '';
    syncDateClear();
    apply();
  });
  document.getElementById('f-group-cadrage').addEventListener('change', () => {
    groupCadrageEnabled = document.getElementById('f-group-cadrage').checked;
    localStorage.setItem('panel_group_cadrage', groupCadrageEnabled ? '1' : '0');
    if (!groupCadrageEnabled) { groupParallelEnabled = false; document.getElementById('f-group-parallel').checked = false; }
    apply();
  });
  const userBox = document.getElementById('f-group-user');
  if (userBox) userBox.addEventListener('change', () => {
    groupUserEnabled = userBox.checked;
    localStorage.setItem('panel_group_user', groupUserEnabled ? '1' : '0');
    apply();
  });
  const parallelBox = document.getElementById('f-group-parallel');
  if (parallelBox) parallelBox.addEventListener('change', () => {
    groupParallelEnabled = parallelBox.checked;
    localStorage.setItem('panel_group_parallel', groupParallelEnabled ? '1' : '0');
    apply();
  });
  apply();
}

// --- Événements ------------------------------------------------------------
async function renderEvents() {
  const data = await api('/api/events' + taskQuery());
  const ev = data.events || [];
  document.getElementById('pane-events').innerHTML = `
    <h2>Événements (derniers ${ev.length})</h2>
    ${filterBar()}
    <table><thead><tr><th>#</th><th>Tâche</th><th>Type</th><th>Par</th><th>Date</th></tr></thead>
    <tbody>${ev.map((e) => `<tr><td class="code">${e.seq}</td><td class="code">${esc(e.task_id)}</td><td>${badge(e.type)}</td><td>${esc(e.by)}</td><td class="code">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun événement</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

// --- Déploiements ----------------------------------------------------------
async function renderDeployments() {
  const data = await api('/api/deployments' + taskQuery());
  const dep = data.deployments || [];
  document.getElementById('pane-deployments').innerHTML = `
    <h2>Déploiements</h2>
    ${filterBar()}
    <table><thead><tr><th>Tâche</th><th>Statut</th><th>Pipeline</th><th>Déclenché</th></tr></thead>
    <tbody>${dep.map((d) => `<tr><td class="code">${esc(d.task_id)}</td><td>${badge(d.status)}</td><td class="code">${esc(d.pipeline_url || '—')}</td><td class="code">${esc((d.triggered_at || '').replace('T', ' ').slice(0, 19))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun déploiement</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

// --- Décisions -------------------------------------------------------------
async function renderDecisions() {
  const data = await api('/api/decisions' + taskQuery());
  const dec = data.decisions || [];
  // Actionnable = awaiting, hors cadrage, sans permission_id (canal B).
  const actionable = (d) => d.status === 'awaiting' && d.kind !== 'cadrage' && !d.permission_id;
  document.getElementById('pane-decisions').innerHTML = `
    <h2>Décisions humaines</h2>
    ${filterBar()}
    <table><thead><tr><th>Tâche</th><th>Type</th><th>Statut</th><th>Détail</th><th>Échéance</th><th></th></tr></thead>
    <tbody>${dec.map((d) => `<tr class="decision-row">
      <td class="code">${esc(d.task_id)}</td><td>${esc(d.kind)}</td><td>${badge(d.status)}</td>
      <td class="decision-detail">${esc((d.detail || '—').slice(0, 120))}${(d.detail || '').length > 120 ? '…' : ''}</td>
      <td class="code">${esc((d.expires_at || '—').replace('T', ' ').slice(0, 19))}</td>
      <td>${actionable(d) ? `<div class="dec-act">
        <button class="ghost" data-review="${esc(d.decision_id)}" title="Examiner la décision en grand (markdown, plein écran)">Examiner</button>
        <button class="approve" data-approve="${esc(d.decision_id)}">Approuver</button>
        <button class="danger" data-reject="${esc(d.decision_id)}">Rejeter</button>
      </div>` : (d.resolution ? `<span class="muted-sm">${esc((d.resolution || '').slice(0, 60))}</span>` : '<span class="muted-sm">—</span>')}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune décision</td></tr>'}</tbody></table>`;
  bindTaskFilter();
  const findDecision = (id) => dec.find((x) => x.decision_id === id);
  document.querySelectorAll('#pane-decisions [data-review]').forEach((b) => b.addEventListener('click', () => decisionReviewModal(findDecision(b.dataset.review), () => refreshActive())));
  document.querySelectorAll('#pane-decisions [data-approve], #pane-decisions [data-reject]').forEach((b) => {
    b.addEventListener('click', async () => {
      const decisionId = b.dataset.approve || b.dataset.reject;
      const st = b.dataset.approve ? 'approved' : 'rejected';
      const input = b.closest('.decision-row').querySelector('.decision-remarks');
      const resolution = input ? input.value.trim() : '';
      const original = b.innerHTML;
      setBtnBusy(b, st === 'approved' ? 'Approbation' : 'Rejet');
      try {
        await resolveDecision(decisionId, st, resolution);
        refreshActive();
      } catch (err) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec : ' + (err.message || err));
      }
    });
  });
}

// Résolution d'une décision humaine (approuver / rejeter) — centralisée.
async function resolveDecision(decisionId, status, resolution) {
  await api(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, resolution }),
  });
}

// Rendu markdown côté serveur (GET, lecture) → HTML.
async function renderMarkdownInline(text) {
  if (!text || !text.trim()) return '';
  try { const r = await api('/api/render-md?text=' + encodeURIComponent(text.slice(0, 60000))); return (r && r.html) || ''; }
  catch { return ''; }
}

// Vue DÉDIÉE d'approbation (plein écran, lisible) : décision à prendre avec son
// contexte. Détail/request en markdown interprété, espacement large, scrollable,
// actions (Approuver / Rejeter) collantes en bas. Approuver n'est proposé que si
// l'utilisateur a les droits (admin) et si la décision est actionnable.
async function decisionReviewModal(decision, back) {
  const actionable = decision && decision.status === 'awaiting' && decision.kind !== 'cadrage' && !decision.permission_id;
  const canAct = IS_ADMIN && actionable;
  const [detailHtml, taskHtml] = await Promise.all([
    renderMarkdownInline(decision.detail),
    renderMarkdownInline(decision.task_request || ''),
  ]);
  const kindLabel = { validation: 'Validation', review: 'Review', permission: 'Permission', cadrage: 'Cadrage' }[decision.kind] || decision.kind;
  const statusLabel = { awaiting: 'En attente', approved: 'Approuvée', rejected: 'Rejetée', expired: 'Expirée' }[decision.status] || decision.status;
  showModal(`
    <div class="decision-review">
      <header class="dr-head">
        <div>
          <h2>Décision à prendre</h2>
          <p class="muted-sm"><span class="code">${esc(decision.decision_id)}</span> · <span class="badge ${decision.status === 'approved' ? 'approved' : decision.status === 'rejected' ? 'rejected' : 'awaiting'}">${esc(statusLabel)}</span>
            · <span class="badge queued">${esc(kindLabel)}</span>
            ${decision.task_id ? `· Tâche <span class="code">${esc(decision.task_id)}</span>` : ''}
            ${decision.plan_id ? `· Plan <span class="code">${esc(decision.plan_id)}</span>` : ''}
            ${decision.requested_by ? `· demandée par <span class="code">${esc(decision.requested_by)}</span>` : ''}
            ${decision.expires_at ? `· échéance ${esc((decision.expires_at || '').replace('T', ' ').slice(0, 19))}` : ''}
          </p>
        </div>
        <button type="button" class="ghost" data-dr-close title="Fermer">✕</button>
      </header>

      <div class="dr-body">
        ${decision.task_id ? `
        <section class="dr-section">
          <h3>Tâche</h3>
          <div class="project-kv"><span class="lbl">Id</span><code>${esc(decision.task_id)}</code></div>
          ${decision.task_title ? `<div class="project-kv"><span class="lbl">Titre</span><span>${esc(decision.task_title)}</span></div>` : ''}
          ${decision.task_project ? `<div class="project-kv"><span class="lbl">Projet</span><code>${esc(decision.task_project)}</code></div>` : ''}
          ${taskHtml ? `<div class="md-body markdown-view">${taskHtml}</div>` : (decision.task_request ? `<pre class="dr-pre">${esc(decision.task_request)}</pre>` : '')}
        </section>` : ''}

        <section class="dr-section">
          <h3>Détail de la demande d'approbation</h3>
          ${detailHtml ? `<div class="md-body markdown-view">${detailHtml}</div>` : (decision.detail ? `<pre class="dr-pre">${esc(decision.detail)}</pre>` : '<p class="muted-sm">(aucun détail)</p>')}
        </section>

        ${decision.session_id ? `<section class="dr-section"><h3>Session</h3><p class="muted-sm"><code>${esc(decision.session_id)}</code></p></section>` : ''}
        ${decision.resolution ? `<section class="dr-section"><h3>Résolution</h3><div class="md-body markdown-view">${esc(decision.resolution)}</div></section>` : ''}

        ${canAct ? `
        <section class="dr-section">
          <h3>Votre décision</h3>
          <textarea id="dr-remarks" class="dr-remarks" rows="3" placeholder="Remarques (optionnel — explicitez un rejet)"></textarea>
          <p class="muted-sm">La décision est transmise et la tâche/le plan évolue en conséquence (approbation → suite du cycle ; rejet → rework avec vos remarques).</p>
        </section>` : ''}
      </div>

      <footer class="dr-foot">
        ${canAct ? `
        <button type="button" class="ghost" data-dr-close>Fermer</button>
        <button type="button" class="approve dr-act" data-dr-resolve="approved">✔ Approuver</button>
        <button type="button" class="danger dr-act" data-dr-resolve="rejected">✖ Rejeter</button>
        ` : `<button type="button" class="ghost" data-dr-close>Fermer</button>`}
      </footer>
    </div>`);
  document.querySelectorAll('[data-dr-close]').forEach((b) => b.addEventListener('click', closeModal));
  const resolveBtn = document.querySelector('[data-dr-resolve]');
  if (resolveBtn) resolveBtn.addEventListener('click', async () => {
    const status = resolveBtn.dataset.drResolve;
    const resolution = document.getElementById('dr-remarks') ? document.getElementById('dr-remarks').value.trim() : '';
    if (status === 'rejected' && !resolution) { alert('Pour rejeter, merci d\'indiquer une remarque (sera transmise en rework).'); return; }
    const original = resolveBtn.innerHTML;
    setBtnBusy(resolveBtn, status === 'approved' ? 'Approbation' : 'Rejet');
    try {
      await resolveDecision(decision.decision_id, status, resolution);
      closeModal();
      if (back) back(); else refreshActive();
    } catch (err) {
      resolveBtn.disabled = false; resolveBtn.classList.remove('ws-busy'); resolveBtn.innerHTML = original;
      alert('Échec : ' + (err.message || err));
    }
  });
}

// --- Utilisateurs (admin) --------------------------------------------------
async function renderUsers() {
  const r = await fetch('/api/users');
  if (r.status === 403) { document.getElementById('pane-users').innerHTML = '<p class="muted">Réservé aux administrateurs.</p>'; return; }
  const data = await r.json();
  const users = data.users || [];
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  const ROLE_LABELS = { admin: 'admin', supervisor: 'superviseur', evaluateur: 'évaluateur', executeur: 'exécuteur' };
  const roleOpts = (sel) => `<select class="role-sel" data-user="${esc(sel.id)}">${['admin', 'supervisor', 'evaluateur', 'executeur'].map((rl) => `<option value="${rl}" ${sel.role === rl ? 'selected' : ''}>${ROLE_LABELS[rl]}</option>`).join('')}</select>`;
  document.getElementById('pane-users').innerHTML = `
    <h2>Utilisateurs <span class="muted-sm">— organisation ${esc(currentOrg)}</span></h2>
    <p class="muted-sm">Rôles : <strong>admin</strong> (écriture, tous les projets de l'organisation) · <strong>superviseur</strong> (lecture seule stricte : TOUTES les pages et tous les projets de l'organisation, y compris les nouveaux onglets Cadrage technique et Recette évaluateur — toutes les tâches, toutes les recettes) · <strong>évaluateur</strong> (pages Fonctionnalités & Règles, Tests E2E, Recette ; écrit sur <em>ses propres recettes</em>, lance les tests E2E et dépose des pièces) · <strong>exécuteur</strong> (Vue d'ensemble, Tâches, Cadrage technique, Recette évaluateur en lecture seule, Tests E2E, Fonctionnalités & Règles, Décisions, ADR, Workspaces ; travaille dans le <em>sprint actif</em> du projet et crée/lance les cadrages techniques). L'accès aux <strong>projets</strong> est explicite (aucun par défaut ; l'admin et le superviseur ont tous les projets).</p>
    <div class="eco-restart-bar"><button class="launch-btn" id="add-user-btn">Ajouter un utilisateur</button><span id="users-msg" class="muted-sm"></span></div>
    <table><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Organisations</th><th>Projets</th><th>opencode</th><th>Email notif.</th><th>Créé le</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${roleOpts(u)}</td><td><button class="ghost tiny" data-user-orgs="${u.id}" data-user-name="${esc(u.username)}">Gérer</button></td><td><button class="ghost tiny" data-user-projects="${u.id}" data-user-name="${esc(u.username)}">Gérer</button></td><td><button class="ghost tiny" data-user-oc="${u.id}" data-user-name="${esc(u.username)}">Accès</button></td><td><button class="ghost tiny" data-user-email="${u.id}" data-user-name="${esc(u.username)}" data-user-email-val="${esc(u.notifyEmail || '')}" title="Configurer l'email de notification">${u.notifyEmail ? esc(u.notifyEmail) : '—'}</button></td><td class="code">${esc((u.created_at || '').replace('T', ' ').slice(0, 19))}</td>    <td><div class="icon-actions"><button class="ghost tiny" data-oc-restart="${esc(u.username)}" title="Redémarrer l'instance opencode@${esc(u.username)}.service">Redémarrer</button><button class="danger" data-del="${u.id}">Supprimer</button></div></td></tr>`).join('')}</tbody></table>`;
  document.getElementById('add-user-btn').addEventListener('click', () => userCreateModal());
  document.querySelectorAll('#pane-users [data-del]').forEach((b) => b.addEventListener('click', async () => {
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try {
      await fetch(`/api/users/${b.dataset.del}`, { method: 'DELETE' });
      renderUsers();
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      const msg = document.getElementById('users-msg'); if (msg) msg.textContent = e.message || String(e);
    }
  }));
  document.querySelectorAll('#pane-users .role-sel').forEach((sel) => sel.addEventListener('change', async () => {
    sel.disabled = true;
    const rr = await fetch(`/api/users/${sel.dataset.user}/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value }) });
    const msg = document.getElementById('users-msg');
    if (!rr.ok) msg.textContent = (await rr.json()).error || 'Erreur';
    renderUsers();
  }));
  document.querySelectorAll('#pane-users [data-user-orgs]').forEach((b) => b.addEventListener('click', () => userOrgsModal(Number(b.dataset.userOrgs), b.dataset.userName)));
  document.querySelectorAll('#pane-users [data-user-projects]').forEach((b) => b.addEventListener('click', () => userProjectsModal(Number(b.dataset.userProjects), b.dataset.userName)));
  document.querySelectorAll('#pane-users [data-user-oc]').forEach((b) => b.addEventListener('click', () => userOpencodeModal(Number(b.dataset.userOc), b.dataset.userName)));
  document.querySelectorAll('#pane-users [data-user-email]').forEach((b) => b.addEventListener('click', () => userNotifyEmailModal(Number(b.dataset.userEmail), b.dataset.userName, b.dataset.userEmailVal)));
  document.querySelectorAll('#pane-users [data-oc-restart]').forEach((b) => b.addEventListener('click', () => restartOpencodeSession(b.dataset.ocRestart)));
}

// Modale de création d'utilisateur (multi-sélection projets).
async function userCreateModal() {
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  const orgOpts = ORGANIZATIONS.map((o) => `<option value="${esc(o.id)}" ${o.id === currentOrg ? 'selected' : ''}>${esc(o.name || o.id)}</option>`).join('');
  showModal(`
    <div class="modal">
      <h2>Créer un utilisateur</h2>
      <div class="modal-form">
        <label>Utilisateur
          <input id="uc-username" placeholder="nom d'utilisateur" autocomplete="off" autofocus>
        </label>
        <label>Mot de passe
          <input id="uc-password" type="password" placeholder="mot de passe">
        </label>
        <label>Rôle
          <select id="uc-role">
            <option value="executeur">exécuteur</option>
            <option value="evaluateur">évaluateur</option>
            <option value="supervisor">superviseur</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>Organisation
          <select id="uc-org">${orgOpts}</select>
        </label>
        <div class="uc-proj-block">
          <span class="uc-proj-label">Projets accessibles</span>
          <p class="muted-sm">Aucun par défaut. Les administrateurs ont accès à tous les projets de l'organisation.</p>
          <div class="uc-proj-list">
            ${projects.map((p) => `<label class="filter-check"><input type="checkbox" class="uc-proj" value="${esc(p.id)}"> ${esc(p.name || p.id)} <code class="muted-sm">${esc(p.id)}</code></label>`).join('') || '<p class="muted-sm">Aucun projet dans cette organisation.</p>'}
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="uc-create">Créer</button>
      </div>
      <div id="uc-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('uc-create').onclick = async () => {
    const username = document.getElementById('uc-username').value.trim();
    const password = document.getElementById('uc-password').value;
    const role = document.getElementById('uc-role').value;
    const organizationId = document.getElementById('uc-org').value;
    const projectIds = [...document.querySelectorAll('#modal-backdrop .uc-proj:checked')].map((c) => c.value);
    const m = document.getElementById('uc-msg');
    if (!username) { m.textContent = 'Le nom d\'utilisateur est requis.'; m.className = 'msg error'; return; }
    const btn = document.getElementById('uc-create');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Création');
    try {
      await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role, organizationId, projectIds }) });
      closeModal(); renderUsers();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      m.textContent = e.message || String(e); m.className = 'msg error';
    }
  };
}

// Redémarrage de l'instance systemd opencode@<user>.service d'un utilisateur (admin).
async function restartOpencodeSession(username) {
  if (!confirm(`Redémarrer la session opencode de « ${username} » ?\nL'instance systemd opencode@${username}.service sera relancée (recharge la config des agents : modèles, permissions, skills, MCP).`)) return;
  const msg = document.getElementById('users-msg');
  const btn = [...document.querySelectorAll('#pane-users [data-oc-restart]')].find((x) => x.dataset.ocRestart === username);
  const prevHtml = btn ? btn.innerHTML : '';
  setBtnBusy(btn, 'Redémarrage');
  try {
    const r = await fetch(`/api/opencode/restart-user/${encodeURIComponent(username)}`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    if (msg) { msg.textContent = `Session opencode « ${username} » redémarrée.`; msg.className = 'msg'; }
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = prevHtml; }
  }
}

// Modale accès opencode dédié d'un utilisateur (identité par utilisateur).
async function userOpencodeModal(userId, username) {
  let d = {};
  try { d = await api(`/api/users/${userId}/opencode`); } catch {}
  showModal(`
    <div class="modal">
      <h2>Accès opencode — ${esc(username || userId)}</h2>
      <p class="muted-sm">Chaque utilisateur dispose d'une instance opencode <strong>dédiée</strong> (sessions isolées, config partagée) exposée sur <code>&lt;user&gt;.dev.madatalk.fr</code>. Son identité est ainsi garantie, même hors panneau. L'instance partagée <code>dev.madatalk.fr</code> reste disponible en secours.</p>
      ${d.provisioned ? `<div class="recette-list">
        <div class="recette-item"><span class="lbl">URL</span><code>${esc(d.url || ('https://' + (username || '') + '.dev.madatalk.fr'))}</code></div>
        <div class="recette-item"><span class="lbl">Mot de passe</span><code>${esc(d.password || '')}</code> <button class="ghost tiny" data-copy-oc="${esc(d.password || '')}">copier</button></div>
        <div class="recette-item"><span class="lbl">Port interne</span><code>${esc(String(d.port || ''))}</code></div>
      </div>` : '<p class="muted-sm">Aucune instance provisionnée.</p>'}
      <div class="modal-actions">
        ${d.provisioned ? '<button class="danger" id="oc-deprov">Déprovisionner</button>' : ''}
        <button class="ghost" id="modal-cancel">Fermer</button>
        <button class="launch-btn" id="oc-prov">${d.provisioned ? 'Régénérer / redémarrer' : 'Provisionner'}</button>
      </div>
      <div id="oc-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.querySelectorAll('#modal-backdrop [data-copy-oc]').forEach((b) => b.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copyOc); }));
  document.getElementById('oc-prov').onclick = async () => {
    const btn = document.getElementById('oc-prov');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Provisionnement');
    const m = document.getElementById('oc-msg');
    try { m.textContent = 'Provisionnement…'; m.className = 'msg'; await api(`/api/users/${userId}/opencode`, { method: 'POST' }); closeModal(); userOpencodeModal(userId, username); }
    catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  };
  const dep = document.getElementById('oc-deprov');
  if (dep) dep.onclick = async () => {
    if (!confirm('Déprovisionner l\'instance opencode de cet utilisateur ?')) return;
    const original = dep.innerHTML;
    setBtnBusy(dep, 'Déprovisionnement');
    try { await api(`/api/users/${userId}/opencode`, { method: 'DELETE' }); closeModal(); userOpencodeModal(userId, username); }
    catch (e) {
      dep.disabled = false; dep.classList.remove('ws-busy'); dep.innerHTML = original;
      const m = document.getElementById('oc-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  };
}

// Modale « email de notification » d'un utilisateur (admin). Le daemon
// opencode-notifier envoie les notifications à cette adresse (résolue via
// tasks.created_by = username). Vide → repli sur NOTIFY_RECIPIENTS global.
async function userNotifyEmailModal(userId, username, current) {
  showModal(`
    <div class="modal">
      <h2>Email de notification — ${esc(username || userId)}</h2>
      <p class="muted-sm">Adresse utilisée par le daemon <code>opencode-notifier</code> pour notifier cet utilisateur (statut de tâche, décision requise, incident, déploiement…). Laisse vide pour retomber sur le destinataire global.</p>
      <label class="modal-field">Adresse email
        <input id="une-email" type="email" placeholder="prenom.nom@exemple.com" value="${esc(current || '')}" autocomplete="off">
      </label>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="une-clear">Vider</button>
        <button class="launch-btn" id="une-save">Enregistrer</button>
      </div>
      <div id="une-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const save = async (email) => {
    const m = document.getElementById('une-msg');
    const btn = document.getElementById('une-save');
    const orig = btn ? btn.innerHTML : null;
    try {
      if (btn) setBtnBusy(btn, 'Enregistrement');
      await api(`/api/users/${userId}/notify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      closeModal(); renderUsers();
    } catch (e) {
      if (btn && orig != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = orig; }
      if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  };
  document.getElementById('une-save').onclick = () => save(document.getElementById('une-email').value.trim());
  document.getElementById('une-clear').onclick = () => save('');
}

// Modale d'accès par PROJET d'un utilisateur (admin). Aucun par défaut.
async function userProjectsModal(userId, username) {  let all = [];
  try { all = ((await api('/api/projects')).projects || []); } catch {}
  let mine = [];
  try { const r = await api(`/api/users/${userId}/projects`); mine = (r && r.projects) || []; } catch {}
  showModal(`
    <div class="modal">
      <h2>Projets accessibles à ${esc(username || userId)}</h2>
      <p class="muted-sm">Par défaut, un utilisateur n'a accès à <strong>aucun</strong> projet. Les administrateurs ont accès à tous les projets de l'organisation.</p>
      <div class="recette-list">${all.map((p) => `<label class="filter-check"><input type="checkbox" class="up-proj" value="${esc(p.id)}" ${mine.includes(p.id) ? 'checked' : ''}> ${esc(p.name || p.id)} <code class="muted-sm">${esc(p.id)}</code></label>`).join('') || '<p class="muted-sm">Aucun projet dans cette organisation.</p>'}</div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="up-save">Enregistrer</button>
      </div>
      <div id="up-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('up-save').onclick = async () => {
    const ids = [...document.querySelectorAll('#modal-backdrop .up-proj:checked')].map((c) => c.value);
    const btn = document.getElementById('up-save');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Enregistrement');
    const m = document.getElementById('up-msg');
    try {
      await api(`/api/users/${userId}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectIds: ids }) });
      closeModal(); renderUsers();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  };
}

// Modale d'appartenance d'un utilisateur aux organisations (admin).
async function userOrgsModal(userId, username) {
  let all = [];
  try { all = ((await api('/api/orgs')).organizations || []); } catch {}
  let mine = [];
  try { const r = await api(`/api/users/${userId}/organizations`); mine = (r && r.organizations) || []; } catch {}
  showModal(`
    <div class="modal">
      <h2>Organisations de ${esc(username || userId)}</h2>
      <p class="muted-sm">Un utilisateur peut appartenir à plusieurs organisations. Au moins une requise.</p>
      <div class="recette-list">${all.map((o) => `<label class="filter-check"><input type="checkbox" class="uo-org" value="${esc(o.id)}" ${mine.includes(o.id) ? 'checked' : ''}> ${esc(o.name || o.id)}${o.isDefault ? ' ★' : ''}</label>`).join('')}</div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="uo-save">Enregistrer</button>
      </div>
      <div id="uo-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('uo-save').onclick = async () => {
    const ids = [...document.querySelectorAll('#modal-backdrop .uo-org:checked')].map((c) => c.value);
    const btn = document.getElementById('uo-save');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Enregistrement');
    const m = document.getElementById('uo-msg');
    try {
      await api(`/api/users/${userId}/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationIds: ids }) });
      closeModal(); renderUsers();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; }
    }
  };
}

// --- Artefacts : gestionnaire central (toutes entités) ---------------------
// Taxonomie doc_type (source de vérité : /docs/nomenclature-doc-type.md).
const DOC_TYPE_LIST = ['adr', 'specs', 'gherkin', 'project_doc', 'adr_file', 'plan', 'task_synthese',
  'task_report', 'audit_report', 'cadrage_report', 'cadrage_doc', 'e2e_report', 'e2e_video', 'piece', 'autre'];
const ARTIFACT_KIND_LIST = ['plan', 'audit', 'report', 'autre'];
let artFilters = { docType: '', contentId: '', kind: '', q: '' };

function artRow(a) {
  const isMd = /\.md$/i.test(a.path || '');
  return `<tr>
    <td><span class="art-entity"><span class="badge art-entity-kind">${esc(a.entity_kind || 'entity')}</span> ${esc(a.entity_label || a.content_id || '')}</span><br><code class="muted-sm">${esc(a.content_id || '')}</code></td>
    <td><span class="badge art-type">${esc(a.doc_type || '—')}</span></td>
    <td><span class="badge art-nature">${esc(a.kind || '—')}</span>${a.nature ? ` <span class="badge" title="Nature du document">${esc(a.nature)}</span>` : ''}</td>
    <td>${esc(a.title || (a.path || '').split('/').pop() || a.artifact_id)}<br><span class="muted-sm">${esc(a.path || '')}</span></td>
    <td class="code">${esc((a.created_at || '').replace('T', ' ').slice(0, 19))}</td>
    <td class="art-actions">${isMd ? `<button class="ghost" data-art-view="${esc(a.artifact_id)}">Regarder</button> ` : ''}<button class="btn-dl" data-art-dl="${esc(a.artifact_id)}">Télécharger</button></td>
  </tr>`;
}

async function renderArtifacts() {
  const pane = document.getElementById('pane-artifacts');
  const dtOpts = ['', ...DOC_TYPE_LIST].map((v) => `<option value="${esc(v)}"${artFilters.docType === v ? ' selected' : ''}>${v ? esc(v) : '— tous types —'}</option>`).join('');
  const kOpts = ['', ...ARTIFACT_KIND_LIST].map((v) => `<option value="${esc(v)}"${artFilters.kind === v ? ' selected' : ''}>${v ? esc(v) : '— toutes natures —'}</option>`).join('');
  pane.innerHTML = `
    <h2>Artefacts — gestionnaire central</h2>
    <p class="muted-sm">Tous les artefacts, toutes entités confondues (tâche / cadrage / projet / ADR / E2E). Type = <code>doc_type</code>, Nature = <code>kind</code>.</p>
    ${filterBar()}
    <div class="art-filters">
      <select id="art-f-doctype" title="Type (doc_type)">${dtOpts}</select>
      <select id="art-f-kind" title="Nature (kind)">${kOpts}</select>
      <input id="art-f-content" placeholder="Entité (content_id)" value="${esc(artFilters.contentId)}">
      <input id="art-f-q" placeholder="Recherche (titre / chemin)" value="${esc(artFilters.q)}">
      <button class="ghost" id="art-f-reset" type="button">Réinitialiser</button>
      <button class="launch-btn" id="art-add" type="button">+ Ajouter un artefact</button>
    </div>
    <div id="art-list"><p class="muted-sm">Chargement…</p></div>`;

  const readFilters = () => {
    artFilters.docType = document.getElementById('art-f-doctype').value;
    artFilters.kind = document.getElementById('art-f-kind').value;
    artFilters.contentId = document.getElementById('art-f-content').value.trim();
    artFilters.q = document.getElementById('art-f-q').value.trim();
  };
  const reload = async () => {
    const q = new URLSearchParams();
    if (artFilters.docType) q.set('docType', artFilters.docType);
    if (artFilters.kind) q.set('kind', artFilters.kind);
    if (artFilters.contentId) q.set('contentId', artFilters.contentId);
    if (artFilters.q) q.set('q', artFilters.q);
    if (taskFilter) q.set('taskId', taskFilter);
    if (currentProject) q.set('project', currentProject);
    let arts = [];
    try { arts = ((await api('/api/artifacts?' + q.toString())).artifacts || []); } catch (e) { /* liste vide */ }
    document.getElementById('art-list').innerHTML = arts.length
      ? `<table class="art-manager"><thead><tr><th>Entité</th><th>Type</th><th>Nature</th><th>Titre</th><th>Ajouté</th><th></th></tr></thead><tbody>${arts.map(artRow).join('')}</tbody></table>`
      : (taskFilter
        ? `<p class="muted-sm">Aucun artefact pour la tâche <code>${esc(taskFilter)}</code>.</p>`
        : '<p class="muted-sm">Aucun artefact pour ces filtres.</p>');
    document.querySelectorAll('#art-list [data-art-view]').forEach((b) => b.addEventListener('click', () => artViewModal(b.dataset.artView)));
    document.querySelectorAll('#art-list [data-art-dl]').forEach((b) => b.addEventListener('click', () => {
      window.location.href = `/api/artifacts/${encodeURIComponent(b.dataset.artDl)}/download`;
    }));
  };
  document.getElementById('art-f-doctype').addEventListener('change', () => { readFilters(); reload(); });
  document.getElementById('art-f-kind').addEventListener('change', () => { readFilters(); reload(); });
  document.getElementById('art-f-content').addEventListener('change', () => { readFilters(); reload(); });
  document.getElementById('art-f-q').addEventListener('change', () => { readFilters(); reload(); });
  document.getElementById('art-f-reset').addEventListener('click', () => { artFilters = { docType: '', contentId: '', kind: '', q: '' }; taskFilter = ''; renderArtifacts(); });
  document.getElementById('art-add').addEventListener('click', () => artAddModal(reload));
  bindTaskFilter();
  await reload();
}

// Visionneuse markdown in-app (évite de dépendre de view-md.html).
async function artViewModal(artifactId) {
  try {
    const v = await api(`/api/artifacts/${encodeURIComponent(artifactId)}/view`);
    showModal(`<div class="modal modal-wide modal-md">
      <div class="md-head"><strong>${esc(v.title || 'Artefact')}</strong> <span class="badge art-type">${esc(v.docType || '')}</span> <span class="badge art-nature">${esc(v.kind || '')}</span></div>
      <div class="md-body markdown-view">${v.html}</div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div></div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) { alert('Impossible d\'ouvrir l\'artefact : ' + (e.message || e)); }
}

// Modale « Ajouter un artefact » (toute entité) → POST /api/artifacts.
async function artAddModal(onSaved) {
  const dtOpts = DOC_TYPE_LIST.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  const kOpts = ARTIFACT_KIND_LIST.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  // Autocomplétion des entités (tâches / cadrages / projets / docs).
  const entities = [];
  try { for (const t of ((await api('/api/tasks')).tasks || [])) entities.push({ id: t.id, label: `${t.id} — ${(t.title || t.request || '').slice(0, 50)}` }); } catch {}
  try { for (const r of ((await api(cadragesApiBase())).cadrages || [])) entities.push({ id: r.cadrage_id, label: `${r.cadrage_id} — ${(r.title || '').slice(0, 50)}` }); } catch {}
  try { for (const p of ((await api('/api/projects')).projects || [])) entities.push({ id: p.id, label: `${p.id} — ${p.name || ''}` }); } catch {}
  const dlOpts = entities.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join('');
  showModal(`<div class="modal">
    <h2>Ajouter un artefact</h2>
    <form id="art-add-form" class="pilot-form">
      <label class="modal-field">Type (doc_type)</label><select id="aa-doctype">${dtOpts}</select>
      <label class="modal-field">Entité porteuse (content_id)</label>
      <input id="aa-content" list="aa-entities" placeholder="T-… / RECT-… / projet / doc-…" required>
      <datalist id="aa-entities">${dlOpts}</datalist>
      <label class="modal-field">Nature (kind)</label><select id="aa-kind">${kOpts}</select>
      <input id="aa-title" placeholder="titre (optionnel)">
      <input id="aa-path" placeholder="chemin absolu du fichier" required>
      <textarea id="aa-nature" class="modal-textarea" placeholder="nature / à quoi sert ce document (optionnel)"></textarea>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">Ajouter</button>
      </div>
    </form>
    <div id="art-add-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('art-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Ajout');
    const msg = document.getElementById('art-add-msg');
    try {
      const body = {
        docType: document.getElementById('aa-doctype').value,
        contentId: document.getElementById('aa-content').value.trim(),
        kind: document.getElementById('aa-kind').value,
        title: document.getElementById('aa-title').value.trim() || undefined,
        path: document.getElementById('aa-path').value.trim(),
        nature: document.getElementById('aa-nature').value.trim() || undefined,
      };
      await api('/api/artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      msg('Artefact ajouté.');
      if (onSaved) await onSaved();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// --- Cadrages (v0.8.0) : objet de projet -----------------------------------
const CADRAGE_STATUS_LABEL = { pending: 'pas faite', in_progress: 'en cours', done: 'faite' };

// URL d'accès à un fichier de preuve E2E (storage/e2e) — rapport texte ou vidéo.
function e2eFileUrl(absPath) {
  if (!absPath) return '';
  const i = absPath.indexOf('/storage/e2e/');
  const rel = i >= 0 ? absPath.slice(i + '/storage/e2e/'.length) : absPath;
  return `/api/e2e/file?p=${encodeURIComponent(rel)}`;
}

// Rendu de la section « Tests E2E » du détail de tâche (rempli async).
async function renderTaskE2EBlock(taskId, box) {
  if (!box) return;
  let d;
  try { d = await api(`/api/tasks/${encodeURIComponent(taskId)}/e2e`); } catch { return; }
  const tests = d.tests || [];
  if (!tests.length) { box.innerHTML = ''; return; }
  const execById = {};
  (d.executions || []).forEach((x) => { if (!execById[x.id]) execById[x.id] = x; });
  const hasVideo = (d.executions || []).some((x) => x.videoUrl);
  box.innerHTML = `<h3>Tests E2E ${hasVideo ? `<a class="ghost" download href="/api/tasks/${encodeURIComponent(taskId)}/e2e/videos.zip" title="Télécharger toutes les vidéos (zip)">⭳ zip vidéos</a>` : ''}</h3><div class="recette-list">${tests.map((t) => {
    const ex = execById[t.lastExecutionId];
    const st = t.lastStatus || '—';
    const relBadge = { CREATED: 'créé', UPDATED: 'modifié', REGRESSION: 'régression', EXISTING: 'existant' }[t.relationType] || (t.relationType || '').toLowerCase();
    const vUrl = ex && ex.videoUrl ? e2eFileUrl(ex.videoUrl) : '';
    return `<div class="recette-item finish-item"><div class="recette-task">
      <strong><code class="e2e-id">${esc(t.e2eTestId)}</code> ${esc(t.scenario || t.title || '')}</strong>
      <span class="muted-sm">${esc(t.specFile)} · relation : ${esc(relBadge)}</span>
      <div class="e2e-rowline">Statut : ${badge(st)}${ex ? ` · ${esc(ex.durationMs != null ? (ex.durationMs / 1000).toFixed(1) + ' s' : '')} · itération ${esc(ex.attempts || 1)}/3${ex.branch ? ' · ' + esc(ex.branch) : ''}` : ''}</div>
      ${ex && ex.summary ? `<p class="muted-sm e2e-summary">${esc((ex.summary || '').slice(0, 220))}${(ex.summary || '').length > 220 ? '…' : ''}</p>` : ''}
      ${ex && ex.skipReason ? `<p class="e2e-skipreason"><span class="badge rejected">SKIPPED</span> <span class="muted-sm">${esc(ex.skipReason)}</span></p>` : ''}
      <div class="e2e-actions">${ex && ex.logsUrl ? `<a class="ghost" href="${esc(e2eFileUrl(ex.logsUrl))}" target="_blank">Rapport (texte)</a>` : ''}${vUrl ? `<button type="button" class="ghost e2e-video-btn" data-url="${esc(vUrl)}" data-exec="${esc(ex.id || '')}" data-title="${esc(t.e2eTestId + ' — ' + (t.scenario || ''))}">▶ Voir la vidéo</button><a class="ghost" download href="${esc(vUrl)}" title="Télécharger cette vidéo">⭳</a>` : ''}${t.reason ? `<span class="muted-sm" title="${esc(t.reason)}">ℹ raison</span>` : ''}</div>
    </div></div>`;
  }).join('')}</div>`;
  box.querySelectorAll('.e2e-video-btn').forEach((b) => b.addEventListener('click', () => openE2EVideoModal(b.dataset.url, b.dataset.title, b.dataset.exec)));
}

// Lecteur vidéo E2E (preuve HUMAINE) : lecture + vitesses + téléchargement.
// Lecteur vidéo E2E (preuve HUMAINE) : lecture + vitesses + téléchargement.
// `execId` (optionnel) permet de générer à la demande :
//   - vidéo SOUS-TITRÉE (sous-titres gravés depuis le rapport horodaté) ;
//   - vidéo NARRÉE (voix TTS lisant les étapes ; la vidéo est étendue par
//     freeze-frame pour laisser le temps de lecture).
async function openE2EVideoModal(url, title, execId) {
  const canGen = execId && IS_ADMIN;
  showModal(`
    <div class="modal modal-wide">
      <h3>${esc(title || 'Vidéo E2E')}</h3>
      <video id="e2e-video" controls preload="metadata" style="width:100%; max-height:70vh; border-radius:8px" src="${esc(url)}"></video>
      <div class="e2e-speedrow"><span class="muted-sm">Vitesse :</span>${[0.25, 0.5, 1, 1.5, 2].map((s) => `<button type="button" class="ghost e2e-speed" data-speed="${s}">${s}x</button>`).join('')}</div>
      ${canGen ? `
      <div class="subtitled-gen">
        <button type="button" class="launch-btn" data-gen-video="subtitled">🎬 Vidéo avec sous-titres</button>
        <button type="button" class="launch-btn" data-gen-video="narrated">🔊 Vidéo narrée (voix)</button>
      </div>
      <p class="muted-sm" id="gen-video-msg" style="margin:6px 0 0">Sous-titres gravés depuis le rapport horodaté (vert = réussi, rouge = échec, gris = ignoré). Narration : voix lisant les étapes — la vidéo est étendue (freeze) si la lecture dépasse l'étape. Prototype, hors pipeline.</p>
      ` : ''}
      <div class="modal-actions">
        <a class="launch-btn" id="dl-original" download href="${esc(url)}">Télécharger la vidéo</a>
        <button class="ghost" id="modal-cancel">Fermer</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const video = document.getElementById('e2e-video');
  const msg = document.getElementById('gen-video-msg');
  const dlOriginal = document.getElementById('dl-original');
  document.querySelectorAll('.e2e-speed').forEach((b) => b.addEventListener('click', () => {
    video.playbackRate = Number(b.dataset.speed);
    [...document.querySelectorAll('.e2e-speed')].forEach((x) => x.classList.toggle('active', x === b));
  }));
  if (canGen) {
    const genBtn = (kind) => document.querySelector(`#modal-backdrop [data-gen-video="${kind}"]`);
    const labels = { subtitled: 'Vidéo sous-titrée', narrated: 'Vidéo narrée' };
    document.querySelectorAll('#modal-backdrop [data-gen-video]').forEach((btn) => btn.addEventListener('click', async () => {
      const kind = btn.dataset.genVideo;
      const otherKind = kind === 'subtitled' ? 'narrated' : 'subtitled';
      const otherBtn = genBtn(otherKind);
      const busyMsg = kind === 'subtitled'
        ? 'Génération des sous-titres en cours… (ré-encodage vidéo)'
        : 'Génération de la narration en cours… (voix + extension de la vidéo, peut prendre un moment)';
      msg.textContent = busyMsg;
      msg.className = 'muted-sm';
      btn.disabled = true;
      if (otherBtn) otherBtn.disabled = true;
      try {
        const r = await api(`/api/e2e/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionId: execId }) });
        if (!r || !r.url) throw new Error((r && r.error) || 'échec de génération');
        const outUrl = r.url;
        msg.textContent = (r.cached ? labels[kind] + ' (déjà générée) prête. ' : labels[kind] + ' générée. ') + 'Lecture ci-dessous ou téléchargement.';
        msg.className = 'msg';
        video.src = outUrl;
        video.load();
        video.play().catch(() => {});
        if (dlOriginal) {
          dlOriginal.href = outUrl;
          dlOriginal.textContent = '⬇ Télécharger ' + (kind === 'subtitled' ? 'la vidéo sous-titrée' : 'la vidéo narrée');
        }
      } catch (e) {
        msg.textContent = 'Erreur : ' + (e.message || e);
        msg.className = 'msg error';
      } finally {
        btn.disabled = false;
        if (otherBtn) otherBtn.disabled = false;
      }
    }));
  }
}
// Badge E2E compact pour la table des tâches (état agrégé côté serveur : t.e2e).
// Cliquable quand des tests sont associés → onglet Tests E2E pré-filtré sur la tâche.
function e2eBadgeCell(t) {
  const e = t.e2e;
  if (!e || !e.count) return '<span class="muted-sm" title="Aucun test E2E associé">—</span>';
  const icon = e.state === 'pass' ? '✓' : (e.state === 'fail' ? '✗' : '…');
  const cls = e.state === 'pass' ? 'approve' : (e.state === 'fail' ? 'danger' : 'queued');
  const label = e.state === 'pass' ? 'PASS' : (e.state === 'fail' ? 'FAIL' : (e.state === 'pending' ? 'en attente/en cours' : e.state));
  return `<button type="button" class="badge ${cls} e2e-badge-goto" data-goto-e2e="${esc(t.id)}" title="E2E : ${e.done}/${e.count} test(s) exécuté(s) — ${label}. Cliquer pour ouvrir les tests">E2E ${icon}</button>`;
}

// Projet unique d'un cadrage + ses repos transverses (portée réelle, ADR 11).
function cadrageScopeChips(rec) {
  const project = (rec && rec.project) ? rec.project : '';
  const repos = (rec && Array.isArray(rec.repos)) ? rec.repos : [];
  const projChip = project ? `<code class="chip-project" title="Projet (produit) du cadrage">${esc(project)}</code>` : '';
  const repoChips = repos.length
    ? repos.map((rp) => `<code class="chip-repo" title="Repo transverse du projet (portée)">${esc(rp.repoId || rp.id || rp)}</code>`).join(' ')
    : '';
  return [projChip, repoChips ? `<span class="muted-sm" style="font-size:11px">repos : ${repoChips}</span>` : ''].filter(Boolean).join(' ') || '<span class="muted-sm">—</span>';
}

// ===========================================================================
// Tests E2E (v0.9.0) — entités de 1er niveau, indépendantes des tâches
// ===========================================================================
const E2E_TEST_STATUS_LABEL = { ACTIVE: 'actif', OBSOLETE: 'obsolète', QUARANTINE: 'quarantaine', DRAFT: 'brouillon', INCOHERENT: 'incohérent' };
const E2E_STATUS_OPTIONS = Object.entries(E2E_TEST_STATUS_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
const E2E_REL_BADGE = { CREATED: 'approved', UPDATED: 'in_progress', REGRESSION: 'danger', EXISTING: 'queued', REQUIRED: 'awaiting' };
const E2E_REL_LABEL = { CREATED: 'créé', UPDATED: 'modifié', REGRESSION: 'régression', EXISTING: 'existant', REQUIRED: 'requis (bloquant)' };
let e2eFilterProject = '';   // filtre projet couvert (listé) de l'onglet
let e2eFilterStatus = 'ACTIVE'; // filtre statut du test — défaut : actifs
let e2eFilterSearch = '';    // recherche texte (titre / scénario / spec)

function fmtTS(s) {
  const t = String(s || '');
  return t ? t.replace('T', ' ').slice(0, 19) : '—';
}

function e2eQuery() {
  const q = new URLSearchParams();
  if (taskFilter) q.set('taskId', taskFilter);
  if (e2eFilterProject) q.set('project', e2eFilterProject);
  if (e2eFilterStatus) q.set('status', e2eFilterStatus);
  if (e2eFilterSearch.trim()) q.set('search', e2eFilterSearch.trim());
  const s = q.toString();
  return s ? '?' + s : '';
}

function e2eTestStatusBadge(st) {
  const cls = { ACTIVE: 'approved', OBSOLETE: 'queued', QUARANTINE: 'danger', DRAFT: 'queued', INCOHERENT: 'danger' }[st] || 'queued';
  return `<span class="badge ${cls}" title="Statut du test">${esc(E2E_TEST_STATUS_LABEL[st] || st || '—')}</span>`;
}

// Badge d'un run E2E (statuts Playwright) — classes CSS existantes.
function e2eRunBadge(st) {
  const cls = { PASSED: 'approved', FAILED: 'rejected', ERROR: 'rejected', SKIPPED: 'queued', FLAKY: 'awaiting', RUNNING: 'in_progress', PENDING: 'queued' }[st] || 'queued';
  return `<span class="badge ${cls}">${esc(st || '—')}</span>`;
}

function e2eOriginLabel(o) {
  return { task: 'tâche', recette: 'recette', ci: 'CI', manual: 'manuelle', session: 'session' }[o] || o || '—';
}

// Étape 3 — la modale d'actions d'une tâche ne liste PLUS les tests E2E : un
// simple lien renvoie vers l'onglet Tests E2E pré-filtré sur la tâche.
async function renderTaskE2ELink(taskId) {
  const hint = document.getElementById('e2e-actions-hint');
  if (!hint) return;
  let n = 0;
  try { const d = await api(`/api/tasks/${encodeURIComponent(taskId)}/e2e`); n = (d.tests || []).length; } catch {}
  if (!n) { const section = hint.closest('.actions-section'); if (section) section.hidden = true; return; }
  const label = `Voir les tests E2E associés (${n})`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = label;
  btn.title = `${n} test(s) E2E associé(s) à cette tâche — ouvrir l'onglet Tests E2E filtré`;
  btn.addEventListener('click', () => { closeModal(); goToTab('e2etests', taskId); });
  hint.replaceWith(btn);
}

async function renderE2ETests() {
  // Projet ouvert → filtre projet verrouillé sur ce projet.
  if (currentProject) e2eFilterProject = currentProject;
  const [data, projsRes] = await Promise.all([
    api('/api/e2e-tests' + e2eQuery()),
    api('/api/projects').catch(() => ({ projects: [] })),
  ]);
  let tests = data.tests || [];
  const projects = [...new Set([
    ...((projsRes.projects || []).map((p) => p.id).filter(Boolean)),
    ...tests.map((t) => t.project).filter(Boolean),
  ])].sort();
  if (e2eFilterProject && !projects.includes(e2eFilterProject)) projects.push(e2eFilterProject);
  const allCreators = [...new Set([...tests.map((t) => t.createdBy || '—').filter(Boolean), ...e2eUserFilter])];
  const renderUserUI = () => {
    const box = document.getElementById('e2e-user-tags');
    const sel = document.getElementById('e2e-user-add');
    const clear = document.getElementById('e2e-user-clear');
    if (!box) return;
    box.innerHTML = e2eUserFilter.length
      ? e2eUserFilter.map((u) => `<span class="status-chip"><span class="chip-txt">${esc(u)}</span><button type="button" class="chip-x" data-user="${esc(u)}" title="Retirer « ${esc(u)} »">×</button></span>`).join('')
      : '<span class="tagfilter-empty">tous les créateurs</span>';
    sel.innerHTML = `<option value="">+ Ajouter…</option>` + allCreators.filter((u) => !e2eUserFilter.includes(u)).map((u) => `<option>${esc(u)}</option>`).join('');
    clear.hidden = !e2eUserFilter.length;
  };
  const setUserFilter = (next) => {
    e2eUserFilter = [...new Set(next)];
    persistE2EUsers();
    refreshActive();
  };
  tests = tests.filter((t) => !e2eUserFilter.length || e2eUserFilter.includes(t.createdBy || '—'));
  document.getElementById('pane-e2etests').innerHTML = `
    <h2>Tests E2E <span class="muted-sm">— entités de 1er niveau</span></h2>
    <p class="muted-sm">Un test Playwright est enregistré indépendamment des tâches ; les exécutions lui appartiennent (origine tâche / recette / CI / manuelle).</p>
    ${filterBar()}
    <div class="filters">
      ${currentProject ? '' : `<select id="e2e-f-project" title="Filtrer par projet couvert"><option value="">Tous les projets</option>${projects.map((p) => `<option value="${esc(p)}" ${e2eFilterProject === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`}
      <select id="e2e-f-status" title="Filtrer par statut du test"><option value="">Tous les statuts</option>${E2E_STATUS_OPTIONS}</select>
      <input id="e2e-f-search" placeholder="recherche (titre / scénario / spec)…" value="${esc(e2eFilterSearch)}">
      <div class="status-tagfilter" id="e2e-user-tagfilter" title="Afficher les tests des utilisateurs sélectionnés (multi)">
        <span class="tagfilter-label">Créateurs :</span>
        <span class="tagfilter-tags" id="e2e-user-tags"></span>
        <select id="e2e-user-add" title="Ajouter un créateur à filtrer"><option value="">+ Ajouter…</option></select>
        <button type="button" class="ghost tagfilter-clear" id="e2e-user-clear" hidden>tout afficher</button>
      </div>
      <button id="agent-session-btn" class="ghost" title="Ouvrir l'agent de test — reprendre une session existante ou en ouvrir une nouvelle (sans forcément créer un test)">Session test-agent</button>
      <button id="new-e2e-btn" class="launch-btn">+ Nouveau test</button>
    </div>
    <table><thead><tr><th>Titre / Comportement</th><th>Projet</th><th>Repos traversés</th><th>Scénario</th><th>Statut</th><th>Dernier run</th><th>Créé par</th><th>Actions</th></tr></thead>
    <tbody>${tests.map(e2eTableRow).join('') || `<tr><td colspan="8" class="muted">${taskFilter ? 'Aucun test E2E associé à la tâche <code>' + esc(taskFilter) + '</code>.' : (e2eFilterStatus ? 'Aucun test E2E ' + esc((E2E_TEST_STATUS_LABEL[e2eFilterStatus] || e2eFilterStatus)) + ' (changez le filtre de statut).' : 'Aucun test E2E enregistré.')}</td></tr>`}</tbody></table>`;
  renderUserUI();
  bindTaskFilter();
  const e2eProjSel = document.getElementById('e2e-f-project');
  if (e2eProjSel) e2eProjSel.addEventListener('change', (ev) => { e2eFilterProject = ev.target.value; refreshActive(); });
  const statusSel = document.getElementById('e2e-f-status');
  statusSel.value = e2eFilterStatus;
  statusSel.addEventListener('change', (ev) => { e2eFilterStatus = ev.target.value; refreshActive(); });
  const searchInp = document.getElementById('e2e-f-search');
  searchInp.addEventListener('change', () => { e2eFilterSearch = searchInp.value; refreshActive(); });
  const e2eUserSel = document.getElementById('e2e-user-add');
  if (e2eUserSel) e2eUserSel.addEventListener('change', () => {
    const v = e2eUserSel.value;
    if (v && !e2eUserFilter.includes(v)) setUserFilter([...e2eUserFilter, v]);
    e2eUserSel.value = '';
  });
  const e2eUserTags = document.getElementById('e2e-user-tags');
  if (e2eUserTags) e2eUserTags.addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (x) setUserFilter(e2eUserFilter.filter((u) => u !== x.dataset.user));
  });
  const e2eUserClear = document.getElementById('e2e-user-clear');
  if (e2eUserClear) e2eUserClear.addEventListener('click', () => setUserFilter([]));
  document.getElementById('new-e2e-btn').addEventListener('click', () => e2eCreateModal());
  document.getElementById('agent-session-btn').addEventListener('click', () => agentSessionModal());
  document.querySelectorAll('#pane-e2etests [data-e2e-detail]').forEach((b) => b.addEventListener('click', () => e2eDetailModal(b.dataset.e2eDetail)));
  document.querySelectorAll('#pane-e2etests [data-e2e-run]').forEach((b) => b.addEventListener('click', () => e2eRunModal(b.dataset.e2eRun)));
  document.querySelectorAll('#pane-e2etests [data-e2e-obsolete]').forEach((b) => b.addEventListener('click', () => e2eObsoleteModal(b.dataset.e2eObsolete)));
  document.querySelectorAll('#pane-e2etests [data-e2e-incoherent]').forEach((b) => b.addEventListener('click', () => e2eIncoherentModal(b.dataset.e2eIncoherent)));
}

function e2eTableRow(t) {
  const title = (t.title && t.title.trim()) ? t.title : (t.scenario || t.e2eTestId);
  const lastRun = t.lastStatus
    ? `${e2eRunBadge(t.lastStatus)}<span class="muted-sm"> · ${esc(e2eOriginLabel(t.lastOrigin))}${t.lastRunAt ? ' · ' + esc(fmtTS(t.lastRunAt)) : ''}</span>`
    : '<span class="muted-sm">—</span>';
  return `<tr>
    <td><strong>${esc(title)}</strong><div><code class="e2e-id">${esc(t.e2eTestId)}</code></div></td>
    <td><span class="badge approved">${esc(t.project || '—')}</span></td>
    <td class="code muted-sm">${(t.repos && t.repos.length ? t.repos.map((rid) => `<code class="chip">${esc(rid)}</code>`).join(' ') : '<span class="muted-sm">—</span>')}<div class="muted-sm">${esc(t.specFile || '')}</div></td>
    <td class="muted-sm">${esc(t.scenario || '—')}</td>
    <td>${e2eTestStatusBadge(t.status)}</td>
    <td>${lastRun}</td>
    <td>${esc(t.createdBy || '—')}</td>
    <td>${IS_ADMIN
      ? `<div class="icon-actions">
          <button class="icon-btn" data-e2e-detail="${esc(t.e2eTestId)}" title="Voir le détail du test (exécutions, vidéo, rapport)">Détail</button>
          <button class="icon-btn" data-e2e-run="${esc(t.e2eTestId)}" title="Lancer une exécution">▶ Lancer</button>
          ${t.status === 'ACTIVE' ? `<button class="icon-btn danger-btn" data-e2e-obsolete="${esc(t.e2eTestId)}" title="Marquer obsolète (spec disparu)">⚠ Obsolète</button>` : ''}
        </div>`
      : IS_EVALUATEUR
        ? `<div class="e2e-actions">
            <button class="ghost tiny" data-e2e-detail="${esc(t.e2eTestId)}" title="Voir le détail du test (exécutions, vidéo, rapport)">Détail</button>
            <button class="ghost tiny" data-e2e-run="${esc(t.e2eTestId)}" title="Lancer une exécution du test (tel qu'enregistré)">▶ Lancer</button>
            <button class="ghost tiny danger-btn" data-e2e-incoherent="${esc(t.e2eTestId)}" title="Marquer le test « incohérent » (comportement réel ≠ scénario)">⚠ Incohérent</button>
          </div>`
        : `<div class="e2e-actions"><button class="ghost tiny" data-e2e-detail="${esc(t.e2eTestId)}" title="Voir le détail du test (exécutions, vidéo, rapport)">Détail</button></div>`}
    </td>
  </tr>`;
}

// Modale « Session test-agent » : accéder à l'agent de test SANS forcément créer
// un test — reprendre une session existante OU en ouvrir une nouvelle. Comme en
// création de test : sélection des documents de référence du projet (ADR-12) +
// confirmation des variables & secrets E2E disponibles.
async function agentSessionModal() {
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  let sessions = [];
  try { const d = await api('/api/e2e/agent-sessions'); sessions = d.sessions || []; } catch {}
  const openSid = (sid) => { if (sid && /^ses_/.test(sid)) window.open(sessionHref(sid), '_blank'); };
  const sessRows = sessions.slice(0, 25).map((s) => `
    <div class="recette-item">
      <div class="recette-task">
        <strong>${esc(s.title || s.sessionId)}</strong>
        <span class="muted-sm">${s.boundToTest ? '<span class="badge approved">lié à un test</span> ' : ''}${s.inRepo ? '<span class="badge queued">dans un dépôt projet</span> ' : ''}${s.directory ? '<span class="muted-sm">' + esc(String(s.directory).split('/').pop()) + '</span>' : ''}${s.updated ? ' · ' + esc(fmtTS(s.updated)) : ''}</span>
      </div>
      <div class="e2e-actions"><button type="button" class="launch-btn" data-reopen-session="${esc(s.sessionId)}">Reprendre la session</button></div>
    </div>`).join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>Session test-agent</h2>
      <p class="muted-sm">Accéder à l'agent de test (création / mise à jour / diagnostic de tests E2E) <strong>sans forcément créer un test</strong>. Vous pouvez <strong>reprendre une session existante</strong> ou <strong>en ouvrir une nouvelle</strong>.</p>

      <div class="actions-section">
        <h3>1 · Reprendre une session existante</h3>
        ${sessions.length ? `<div class="recette-list" style="max-height:28vh;overflow:auto">${sessRows}</div>`
          : '<p class="muted-sm">Aucune session ouverte actuellement — ouvrez-en une nouvelle.</p>'}
      </div>

      <div class="actions-section">
        <h3>2 · Ouvrir une nouvelle session</h3>
        <form id="agent-session-form" class="pilot-form">
          <label class="modal-field">Projet (contexte) <span class="muted-sm">— ancre la session, liste les documents &amp; variables du projet</span>
            <select id="as-project"><option value="">— aucun —</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('')}</select>
          </label>
          <fieldset id="as-adr-fieldset" class="pilot-fieldset">
            <legend>ADR en contexte — décisions d'architecture <span class="muted-sm">(sélection multi-lignes ; le bloc « ADR de référence » est injecté dans le prompt). Toutes cochées par défaut.</span></legend>
            <div id="as-adr-pick"><p class="muted-sm">Sélectionnez un projet pour afficher ses ADR.</p></div>
          </fieldset>
          <fieldset id="as-vars-fieldset" class="pilot-fieldset">
            <legend>Variables &amp; secrets E2E disponibles <span class="muted-sm">(confirmés au run — injectés automatiquement selon leur type)</span></legend>
            <div id="as-vars-list"><p class="muted-sm">Sélectionnez un projet pour confirmer ses variables &amp; secrets.</p></div>
          </fieldset>
          <label class="modal-field">Message / demande (optionnel)
            <textarea id="as-message" class="modal-textarea" rows="3" placeholder="ex. aide-moi à préparer un test pour … / explique-moi le référentiel E2E / diagnostique un écart"></textarea>
          </label>
          <div class="modal-actions">
            <button type="button" class="ghost" id="modal-cancel">Fermer</button>
            <button type="submit" class="launch-btn">Ouvrir la session</button>
          </div>
        </form>
        <div id="agent-session-msg" class="msg"></div>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.querySelectorAll('#modal-backdrop [data-reopen-session]').forEach((b) => b.addEventListener('click', () => openSid(b.dataset.reopenSession)));

  // --- Projet → ADR en contexte + variables/secrets ---
  const adrBox = document.getElementById('as-adr-pick');
  const varsList = document.getElementById('as-vars-list');
  const projSel = document.getElementById('as-project');
  const reposForProject = (pid) => { const p = projects.find((x) => x.id === pid); return (p && p.repos) || []; };
  const renderAdrs = (adrs, pid) => {
    adrBox.innerHTML = adrSelectorHtml(adrs, { prefix: 'as-adr-pick', repos: reposForProject(pid) });
    bindAdrSelector('as-adr-pick');
  };
  const renderVars = (vars) => {
    if (!vars.length) { varsList.innerHTML = '<p class="muted-sm">Aucune variable ni secret déclaré pour ce projet — les comptes par défaut (e2e.env) s\'appliquent.</p>'; return; }
    varsList.innerHTML = `<div class="recette-list" style="max-height:24vh;overflow:auto">${vars.map((v) => `<div class="recette-item">
      <code>${esc(v.name)}</code>
      ${v.kind === 'secret' ? '<span class="badge rejected">secret</span>' : `<span class="badge approved">variable</span>${v.value != null && v.value !== '' ? `<span class="muted-sm"> · ${esc(v.value)}</span>` : ''}`}
      <span class="muted-sm">${esc(v.purpose || '')}</span>
    </div>`).join('')}</div>`;
  };
  const reloadProject = async () => {
    const pid = projSel.value;
    if (!pid) {
      adrBox.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour afficher ses ADR.</p>';
      varsList.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour confirmer ses variables &amp; secrets.</p>';
      return;
    }
    adrBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    varsList.innerHTML = '<p class="muted-sm">Chargement…</p>';
    try {
      const [dd, vd] = await Promise.all([
        api(`/api/docs?projectId=${encodeURIComponent(pid)}&includeRepoDocs=1`).catch(() => ({ docs: [] })),
        api(`/api/e2e-vars?project=${encodeURIComponent(pid)}`).catch(() => ({ vars: [] })),
      ]);
      renderAdrs((dd.docs || []).filter((d) => d && d.kind === 'adr-tech'), pid);
      renderVars(vd.vars || []);
    } catch (e) { adrBox.innerHTML = '<p class="muted-sm">Erreur de chargement.</p>'; }
  };
  projSel.addEventListener('change', reloadProject);

  document.getElementById('agent-session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Ouverture');
    const msg = document.getElementById('agent-session-msg');
    msg.textContent = 'Ouverture de la session…'; msg.className = 'msg';
    try {
      const project = document.getElementById('as-project').value;
      const adrIds = selectedAdrIds('as-adr-pick'); // toujours un tableau (vide = aucune ADR)
      const r = await api('/api/e2e/agent-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'new', project: project || undefined,
        adrIds, // ADR sélectionnées → bloc « ADR de référence » injecté
        message: document.getElementById('as-message').value.trim() || undefined,
      }) });
      if (r && r.sessionId && /^ses_/.test(r.sessionId)) {
        closeModal();
        window.open(sessionHref(r.sessionId), '_blank');
      } else {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        msg.textContent = r.error || 'Session ouverte (id inconnu).'; msg.className = 'msg error';
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

async function e2eDetailModal(e2eTestId) {
  let d;
  try { d = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}`); }
  catch (e) { alert('Impossible de charger le test : ' + (e.message || e)); return; }
  const test = d.test || {};
  const execs = d.executions || [];
  const testRepos = test.repos || [];
  const params = test.params || [];
  const linked = test.linkedTasks || [];
  const execHtml = execs.map((x) => e2eExecItem(x, test)).join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>${esc(test.title || test.scenario || e2eTestId)}</h2>
      <p class="muted"><code class="e2e-id">${esc(test.e2eTestId || e2eTestId)}</code> · ${e2eTestStatusBadge(test.status)} · Projet <span class="badge approved">${esc(test.project || '—')}</span></p>
      ${test.status === 'INCOHERENT' ? `<div class="actions-section e2e-incoherent-block">
        <h3>⚠ Incohérence signalée</h3>
        <p class="muted-sm"><strong>Comportement réel ≠ scénario / règle</strong>${test.incoherentBy ? ' — signalé par ' + esc(test.incoherentBy) : ''}${test.incoherentAt ? ' le ' + esc(fmtTS(test.incoherentAt)) : ''}</p>
        <div class="modal-request">${esc(test.incoherentRemarks || '')}</div>
      </div>` : ''}
      <div class="actions-section">
        <div class="project-kv"><span class="lbl">Projet</span><code class="muted-sm">${esc(test.project || '—')}</code></div>
        <div class="project-kv"><span class="lbl">Repos traversés</span><span>${testRepos.length ? testRepos.map((r) => `<code class="chip">${esc(r.id)}${r.workspace ? ' · ' + esc(r.workspace) : ''}</code>`).join(' ') : '<span class="muted-sm">—</span>'}</span></div>
        <div class="project-kv"><span class="lbl">Spec file</span><code class="muted-sm">${esc(test.specFile || '—')}</code></div>
        <div class="project-kv"><span class="lbl">Scénario</span><span class="muted-sm">${esc(test.scenario || '—')}</span></div>
        <div class="project-kv"><span class="lbl">Suivi</span><span class="muted-sm">vu depuis ${esc(fmtTS(test.firstSeenAt))} · màj ${esc(fmtTS(test.updatedAt))} · ${(test.taskCount != null ? test.taskCount : linked.length)} tâche(s) liée(s)</span></div>
      </div>
      ${(test.docs && test.docs.length) ? `<div class="actions-section" data-e2e-tech><h3>Documents de référence du projet (contexte test-agent / cadrage)</h3>
        <div class="recette-list">${test.docs.map((d) => `<div class="recette-item">
          <code class="chip">${esc(docKindLabel(d.kind))}</code> <strong>${esc(d.title || d.docId)}</strong>
          <span class="muted-sm">${esc(d.path)}</span>
        </div>`).join('')}</div>
        <p class="muted-sm">Ces documents (ADR technique, specs, Gherkin) sont fournis en contexte lors des sessions de création / cadrage. Les documents de référence (ADR-12) sont désormais des <strong>pièces client</strong> : gérez-les via l'onglet <strong>Artefacts</strong> ou l'onglet <strong>Pièces client</strong> du projet ; les ADR via l'onglet <strong>ADR</strong>.</p>
      </div>` : ''}
      ${test.description ? `<div class="modal-request">${esc(test.description)}</div>` : ''}
      ${test.gherkin ? `<div class="actions-section"><h3>Comportement (Gherkin)</h3>
        <pre style="background:rgba(255,255,255,0.05);padding:12px;border-radius:6px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5">${esc(test.gherkin)}</pre>
      </div>` : ''}
      ${(test.requiredOpen != null && test.requiredOpen > 0) ? `<div class="actions-section" data-e2e-tech>
        <p class="badge danger" style="display:inline-block">⚠ bloqué par ${test.requiredOpen} tâche(s) REQUIRED non terminée(s) — le test ne sera PASS qu'une fois ces tâches done.</p>
        <div class="recette-list">${(test.requiredOpenTasks || []).map((rt) => `<div class="recette-item">
          <code class="muted-sm">${esc(rt.taskId)}</code>
          <span class="muted-sm">${esc(rt.title || '')}</span>
          <button type="button" class="ghost" data-e2e-task-goto="${esc(rt.taskId)}">Ouvrir la tâche</button>
        </div>`).join('')}</div>
      </div>` : ''}
      <div class="actions-buttons" data-e2e-tech>
        <button type="button" class="ghost" data-e2e-create-task="${esc(test.e2eTestId || e2eTestId)}" title="Créer une tâche requise pour que ce test passe (contrat BDD/TDD)">+ Créer une tâche (requise)</button>
      </div>
      ${(test.status === 'DRAFT' || test.sessionId) ? `<div class="actions-section" data-e2e-tech><h3>Session de création / mise à jour</h3>
        <p class="muted-sm">${test.status === 'DRAFT' ? 'Test en DRAFT : le spec est en cours de rédaction par la session test-agent.' : 'Une session test-agent est rattachée à ce test (création / mise à jour).'}</p>
        <div class="actions-buttons">
          <button type="button" class="launch-btn" data-e2e-session="${esc(test.e2eTestId || e2eTestId)}" title="${test.sessionId ? 'Reprendre la session de création en cours' : 'Ouvrir une session de création (test-agent)'}">${test.sessionId ? 'Reprendre la session' : 'Session de création'}</button>
          <button type="button" class="ghost" data-e2e-session-force="${esc(test.e2eTestId || e2eTestId)}" title="Démarrer une NOUVELLE session test-agent (force)">Nouvelle session</button>
        </div>
      </div>` : ''}
      ${params.length ? `<div class="actions-section" data-e2e-tech><h3>Params historiques (${params.length})</h3>
        <p class="muted-sm">Anciens « paramètres de test » — migrés vers des variables de projet (onglet Vars &amp; Secrets E2E).</p>
        <div class="table-scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Défaut</th></tr></thead>
        <tbody>${params.map((p) => `<tr>
          <td class="code">${esc(p.name)}</td>
          <td>${esc(p.kind)}</td>
          <td>${p.kind === 'secret' ? '<span class="muted-sm">—</span>' : esc(p.defaultValue ?? '—')}</td>
        </tr>`).join('')}</tbody></table></div></div>` : ''}
      ${((test.projectVars || []).length || (test.projectSecrets || []).length) ? `<div class="actions-section" data-e2e-tech><h3>Variables &amp; secrets du projet (injectés au run)</h3>
        <div class="recette-list">${[...(test.projectVars || []).map((v) => ({ ...v, kind: 'variable' })), ...(test.projectSecrets || [])].map((s) => `<div class="recette-item">
          <code>${esc(s.name)}</code>
          ${s.kind === 'secret' ? '<span class="badge rejected">secret</span>' : `<span class="badge approved">variable</span><span class="muted-sm"> · ${esc((s.value ?? s.defaultValue) || '—')}</span>`}
          <span class="muted-sm">${esc(s.purpose || '')}</span>
        </div>`).join('')}</div>
        <p class="muted-sm"><a href="#" onclick="goToTab('e2esecrets'); return false;">Gérer les variables &amp; secrets (onglet Vars &amp; Secrets E2E)</a></p>
      </div>` : ''}
      <div class="actions-section" data-e2e-tech><h3>Tâches liées (${linked.length})</h3>
        ${linked.length ? `<div class="recette-list">${linked.map((l) => `<div class="recette-item">
          <code class="muted-sm">${esc(l.taskId)}</code>
          <span class="badge ${E2E_REL_BADGE[l.relationType] || 'queued'}" title="Relation : ${esc(l.relationType || '')}">${esc(E2E_REL_LABEL[l.relationType] || l.relationType || 'lié')}</span>
          ${l.reason ? `<span class="muted-sm" title="${esc(l.reason)}">${esc((l.reason || '').slice(0, 70))}</span>` : ''}
          <button type="button" class="ghost" data-e2e-task-goto="${esc(l.taskId)}">Ouvrir la tâche</button>
        </div>`).join('')}</div>` : '<p class="muted-sm">Aucune tâche associée — le test est indépendant (association pure N:N).</p>'}
      </div>
      <div class="actions-section"><h3>Exécutions — historique (${execs.length})</h3>
        ${execs.length ? `<div class="recette-list">${execHtml}</div>` : '<p class="muted-sm">Aucune exécution enregistrée pour ce test.</p>'}
      </div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Fermer</button>
        ${(IS_EVALUATEUR || IS_ADMIN) ? `<button class="ghost danger-btn" id="e2e-incoherent-btn" title="Signaler que le comportement réel ne correspond pas au scénario / à la règle">⚠ Marquer incohérent</button>` : ''}
        <button class="launch-btn" id="e2e-launch-btn" title="Lancer une exécution sur ce test">Lancer une exécution</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('e2e-launch-btn').onclick = () => { closeModal(); e2eRunModal(e2eTestId); };
  const e2eIncBtn = document.getElementById('e2e-incoherent-btn');
  if (e2eIncBtn) e2eIncBtn.onclick = () => e2eIncoherentModal(e2eTestId, () => e2eDetailModal(e2eTestId));
  document.querySelectorAll('#modal-backdrop [data-e2e-session]').forEach((b) => b.addEventListener('click', () => openTestSession(b.dataset.e2eSession, false, b)));
  document.querySelectorAll('#modal-backdrop [data-e2e-session-force]').forEach((b) => b.addEventListener('click', () => openTestSession(b.dataset.e2eSessionForce, true, b)));
  document.querySelectorAll('#modal-backdrop [data-e2e-create-task]').forEach((b) => b.addEventListener('click', () => e2eCreateTaskModal(b.dataset.e2eCreateTask)));
  document.querySelectorAll('#modal-backdrop [data-e2e-task-goto]').forEach((b) => b.addEventListener('click', () => { closeModal(); taskActionsModal(b.dataset.e2eTaskGoto); }));
  document.querySelectorAll('#modal-backdrop [data-e2e-video]').forEach((b) => b.addEventListener('click', () => openE2EVideoModal(b.dataset.e2eVideo, b.dataset.title, b.dataset.exec)));
}

// Ouvre la session de création/mise à jour d'un test (agent test-agent).
// Reprend la session rattachée si elle existe ; `force = true` en démarre une.
async function openTestSession(e2eTestId, force, btn) {
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Ouverture');
  try {
    const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) {
      window.open(sessionHref(r.sessionId), '_blank');
      closeModal();
      refreshActive();
    } else {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      alert(r.error || 'Aucune session test-agent disponible.');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Échec de la session test-agent : ' + (e.message || e));
  }
}

// Crée une tâche requise depuis un test (contrat BDD/TDD) — lien REQUIRED auto.
async function e2eCreateTaskModal(e2eTestId) {
  let test = {};
  try { const d = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}`); test = d.test || {}; }
  catch (e) { alert('Impossible de charger le test : ' + (e.message || e)); return; }
  const reqHead = `[Test E2E requis — ${test.specFile || '?'} :: ${test.scenario || test.title || e2eTestId}]`;
  const gherkin = test.gherkin || '';
  showModal(`
    <div class="modal modal-wide">
      <h2>Créer une tâche requise (contrat BDD/TDD)</h2>
      <p class="muted">Test <code class="e2e-id">${esc(test.e2eTestId || e2eTestId)}</code> · ${esc(test.title || test.scenario || '')} <span class="muted-sm">· Projet : <code>${esc(test.project || '—')}</code></span></p>
      <p class="muted-sm">La tâche sera créée sur le projet <strong>${esc(test.project || '—')}</strong> et liée au test en relation <strong>REQUIRED</strong> (le test ne sera PASS qu'une fois cette tâche done).</p>
      <form id="e2e-ct-form" class="pilot-form">
        <label class="modal-field">Titre court <span class="muted-sm">— requis</span>
          <input id="ct-title" required value="${esc(test.scenario || test.title || 'Implémenter le comportement E2E')}">
        </label>
        <label class="modal-field">Type
          <select id="ct-type"><option value="feature">feature</option><option value="debug">debug</option><option value="audit">audit</option></select>
        </label>
        <label class="modal-field">Demande <span class="muted-sm">— requis</span>
          <textarea id="ct-request" class="modal-textarea" rows="5" required>${esc(reqHead)}
${esc(test.description || 'Implémenter le comportement couvert par ce test (contrat BDD/TDD).')}
${gherkin ? '\nGherkin (comportement cible) :\n' + esc(gherkin) : ''}</textarea>
        </label>
        <label class="modal-field">Scope <span class="muted-sm">— optionnel, chemins</span>
          <input id="ct-scope" placeholder="ex: packages/..., apps/...">
        </label>
        <label class="filter-check" title="Exécution directe par build-notify (sans plan)"><input type="checkbox" id="ct-direct"> exécution directe</label>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer la tâche</button>
        </div>
      </form>
      <div id="ct-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('e2e-ct-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('ct-msg');
    const title = document.getElementById('ct-title').value.trim();
    const request = document.getElementById('ct-request').value.trim();
    if (!title || !request) { msg.textContent = 'Titre et demande requis.'; msg.className = 'msg error'; return; }
    const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    msg.textContent = 'Création de la tâche…';
    msg.className = 'msg';
    const scopeRaw = document.getElementById('ct-scope').value.trim();
    try {
      const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/create-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title,
        request,
        type: document.getElementById('ct-type').value,
        scope: scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        directExecution: document.getElementById('ct-direct').checked,
      }) });
      closeModal();
      if (r && r.taskId) { alert('Tâche créée : ' + r.taskId + ' — liée au test en REQUIRED.'); goToTab('tasks'); }
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

function e2eExecItem(x, test) {
  const vUrl = x.videoUrl ? e2eFileUrl(x.videoUrl) : '';
  const lUrl = x.logsUrl ? e2eFileUrl(x.logsUrl) : '';
  const dur = x.durationMs != null ? (x.durationMs / 1000).toFixed(1) + ' s' : '';
  const raw = x.summary || '';
  const summary = raw.slice(0, 160);
  const title = (test && (test.title || test.scenario)) || x.e2eTestId || 'Exécution E2E';
  return `<div class="recette-item finish-item"><div class="recette-task">
    <div class="e2e-rowline">${e2eRunBadge(x.status)}
      <span class="muted-sm">origine ${esc(e2eOriginLabel(x.origin))}</span>
      <span class="muted-sm">${esc(fmtTS(x.createdAt))}</span>
      ${dur ? `<span class="muted-sm">· durée ${dur}</span>` : ''}
      ${x.attempts ? `<span class="muted-sm">· itération ${esc(x.attempts)}</span>` : ''}
      ${x.taskId ? `<code class="muted-sm">· ${esc(x.taskId)}</code>` : ''}
      ${x.verdictBy ? `<span class="muted-sm">· verdict ${esc(x.verdictBy)}</span>` : ''}
    </div>
    ${summary ? `<p class="muted-sm e2e-summary">${esc(summary)}${raw.length > 160 ? '…' : ''}</p>` : ''}
    ${x.skipReason ? `<p class="e2e-skipreason"><span class="badge rejected">SKIPPED</span> <span class="muted-sm">${esc(x.skipReason)}</span></p>` : ''}
    <div class="e2e-actions">
      ${lUrl ? `<a class="ghost" href="${esc(lUrl)}" target="_blank" rel="noopener" title="Rapport texte (IA + humain)">Rapport (texte)</a>` : ''}
      ${vUrl ? `<button type="button" class="ghost" data-e2e-video="${esc(vUrl)}" data-exec="${esc(x.id || x.executionId || '')}" data-title="${esc(title + ' — ' + fmtTS(x.createdAt))}">▶ Voir la vidéo</button><a class="ghost" download href="${esc(vUrl)}" title="Télécharger la vidéo (preuve humaine)">⭳</a>` : ''}
    </div>
  </div></div>`;
}

async function e2eRunModal(e2eTestId) {
  let test = {};
  try { const d = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}`); test = d.test || {}; }
  catch (e) { alert('Impossible de charger le test : ' + (e.message || e)); return; }
  // --- Branche ÉVALUATEUR (ADR-003) : run minimal, SANS réglages techniques ---
  // L'évaluateur exécute le test TEL QU'ENREGISTRÉ (spec + paramètres + vars du
  // projet résolus côté serveur). Aucune saisie repoDir / config Playwright /
  // specPattern / pwArgs / origine / taskId / vars / secrets, et AUCUN appel à
  // `/api/e2e-vars` (hors périmètre évaluateur — cf. allowlist serveur).
  if (IS_EVALUATEUR) return e2eRunModalEvaluateur(e2eTestId, test);
  // ADR 11 : repo d'exécution par défaut = un des repos traversés du test (celui
  // qui a un checkout E2E, de préférence contenant le spec). Le serveur résout
  // aussi le repo d'exécution si on laisse le champ vide.
  const repoProject = test.project || '';
  const testRepos = test.repos || [];
  const execRepo = testRepos.find((r) => r.e2eRepoDir) || {};
  const defRepoDir = execRepo.e2eRepoDir || `/root/${repoProject}-preprod`;
  const defBaseUrl = execRepo.e2eBaseUrl || '';
  // Variables & secrets du PROJET (module vars unifié) :
  //  - kind='variable' : champs texte ÉDITABLES pré-remplis (injectées d'office ;
  //    surcharge éventuelle saisie ici → paramValues) ;
  //  - kind='secret'   : cases à cocher (injectées si sélectionnées).
  let projVars = [];
  let projSecrets = [];
  try {
    const d = await api(`/api/e2e-vars?project=${encodeURIComponent(repoProject)}`);
    const all = (d && d.vars) || [];
    projVars = all.filter((v) => v.kind !== 'secret');
    projSecrets = all.filter((v) => v.kind === 'secret');
  } catch {}
  const varFields = projVars.map((v) => `
    <label class="modal-field">${esc(v.name)} <span class="muted-sm">(variable projet — éditée ici = surcharge du run)</span>
      <input type="text" data-pv="${esc(v.name)}" value="${esc(v.value ?? '')}" placeholder="(défaut projet)">
    </label>`).join('');
  const secretChecks = projSecrets.map((s) => `
    <label class="filter-check" title="Secret projet ${esc(repoProject)} — injecté comme variable d'env au run">
      <input type="checkbox" class="sec-sel" value="${esc(s.name)}" checked> <code>${esc(s.name)}</code>
    </label>`).join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>Lancer une exécution</h2>
      <p class="muted"><code class="e2e-id">${esc(test.e2eTestId || e2eTestId)}</code> · ${esc(test.scenario || test.title || '')} <span class="muted-sm">· Projet : <code>${esc(repoProject)}</code></span></p>
      <form id="e2e-run-form" class="pilot-form">
        <label class="modal-field">Dépôt applicatif (repoDir) <span class="muted-sm">— pré-rempli depuis le projet (${esc(repoProject)}) ; corrigeable</span>
          <input id="er-repodir" value="${esc(defRepoDir)}" required>
        </label>
        <label class="modal-field">URL cible (baseUrl) <span class="muted-sm">— pré-remplie depuis le projet ; défaut sinon e2e.env</span>
          <input id="er-baseurl" value="${esc(defBaseUrl)}" placeholder="ex: https://preprod.madatalk.fr">
        </label>
        <div class="actions-buttons" style="align-items:flex-end">
          <label class="modal-field" style="flex:1">Origine du run
            <select id="er-origin"><option value="manual">manuelle</option><option value="task">tâche</option><option value="recette">recette</option></select>
          </label>
          <label class="modal-field" style="flex:2">Tâche origine (taskId) <span class="muted-sm">— optionnel</span>
            <input id="er-taskid" placeholder="T-…">
          </label>
        </div>
        <label class="modal-field">Config Playwright dédiée (playwrightConfig) <span class="muted-sm">— optionnel</span>
          <input id="er-pwconfig" placeholder="ex: playwright.madatalk-requests.cadrage.config.ts">
        </label>
        <label class="modal-field">Filtre de spec (specPattern) <span class="muted-sm">— défaut : spec du test</span>
          <input id="er-specpattern" placeholder="regex Playwright">
        </label>
        <label class="modal-field">Arguments Playwright (pwArgs) <span class="muted-sm">— optionnels, séparés par des espaces</span>
          <input id="er-pwargs" placeholder="ex: --project=authenticated --retries=1">
        </label>
        ${projVars.length ? `<fieldset class="pilot-fieldset"><legend>Variables du projet (injectées d'office) <span class="muted-sm">— édition = surcharge pour ce run</span></legend>${varFields}</fieldset>` : ''}
        ${secretChecks ? `<fieldset class="pilot-fieldset"><legend>Secrets du projet à injecter <span class="muted-sm">(valeurs chiffrées déchiffrées côté serveur — jamais affichées)</span></legend>${secretChecks}</fieldset>` : ''}
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Lancer</button>
        </div>
      </form>
      <div id="e2e-run-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('e2e-run-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('e2e-run-msg');
    const paramValues = {};
    document.querySelectorAll('#modal-backdrop [data-pv]').forEach((inp) => {
      const v = inp.value.trim();
      if (v) paramValues[inp.dataset.pv] = v;
    });
    const secretNames = [...document.querySelectorAll('#modal-backdrop .sec-sel:checked')].map((c) => c.value).filter(Boolean);
    const pwRaw = document.getElementById('er-pwargs').value.trim();
    const pwArgs = pwRaw ? pwRaw.split(/\s+/).filter(Boolean) : [];
    // Capture des valeurs AVANT fermeture (le modal est vidé par closeModal).
    const runBody = {
      repoDir: document.getElementById('er-repodir').value.trim() || undefined,
      baseUrl: document.getElementById('er-baseurl').value.trim() || undefined,
      origin: document.getElementById('er-origin').value,
      taskId: document.getElementById('er-taskid').value.trim() || undefined,
      specPattern: document.getElementById('er-specpattern').value.trim() || undefined,
      playwrightConfig: document.getElementById('er-pwconfig').value.trim() || undefined,
      pwArgs,
      paramValues,
      secretNames,
    };
    // Run ASYNCHRONE : le POST répond immédiatement (worker détaché) ; on suit le
    // job en polling puis on ouvre l'historique du test quand il est terminé.
    const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Lancement');
    msg.textContent = 'Lancement du run en arrière-plan…';
    msg.className = 'msg';
    let jobId = null;
    try {
      const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runBody),
      });
      if (r && r.jobId) {
        jobId = r.jobId;
        msg.textContent = `Run lancé (job ${jobId}) — suivi en cours… le résultat apparaîtra dans l'historique du test.`;
        msg.className = 'msg';
      } else {
        msg.textContent = (r && r.message) || (r && r.error) || 'Run terminé (réponse directe).';
        msg.className = r && r.error ? 'msg error' : 'msg';
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      const m = err && err.message ? String(err.message) : String(err);
      msg.textContent = 'Échec du lancement : ' + m;
      msg.className = 'msg error';
      return;
    }
    // POST terminé : le suivi du job se fait hors bouton → restaurer immédiatement.
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    // Polling du job : tant qu'il est RUNNING on attend ; à la fin on ouvre le détail.
    let pollTries = 0;
    let cancelled = false;
    const cancelBtn = document.getElementById('modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { cancelled = true; });
    const pollJob = async () => {
      if (cancelled) return;
      pollTries++;
      if (pollTries > 180) { // ~12 min max d'attente ; au-delà on laisse l'utilisateur suivre manuellement
        closeModal();
        alert('Le run est toujours en cours en arrière-plan. Suivez l\'avancement via l\'historique du test (Détail) qui se rafraîchit — relancez si rien n\'apparaît après plusieurs minutes.');
        e2eDetailModal(e2eTestId);
        return;
      }
      try {
        const st = await api(`/api/e2e/jobs/${encodeURIComponent(jobId)}`);
        if (st && st.status === 'DONE') {
          closeModal();
          e2eDetailModal(e2eTestId);
          return;
        }
        if (st && st.status === 'ERROR') {
          // Pré-vol : spec absent du checkout mais récupérable depuis git →
          // proposer un run via worktree temporaire au commit choisi.
          let pre = null;
          const rawErr = (st && st.error) || '';
          try { pre = JSON.parse(String(rawErr).replace(/^ERREUR\s*:\s*/, '').trim()); } catch {}
          if (pre && pre.code === 'SPEC_NOT_IN_CHECKOUT' && Array.isArray(pre.candidates) && pre.candidates.length) {
            e2eRunFromGitModal(e2eTestId, pre);
            return;
          }
          closeModal();
          alert('Le run a échoué : ' + ((st && st.error) || 'erreur worker'));
          e2eDetailModal(e2eTestId);
          return;
        }
      } catch {}
      setTimeout(pollJob, 4000);
    };
    setTimeout(pollJob, 3000);
  });
}

// Run ÉVALUATEUR (ADR-003) : modale minimale — le test est exécuté TEL
// QU'ENREGISTRÉ. Aucun réglage technique exposé, aucun appel à `/api/e2e-vars`.
async function e2eRunModalEvaluateur(e2eTestId, test) {
  const t = test || {};
  showModal(`
    <div class="modal">
      <h2>Lancer une exécution</h2>
      <p class="muted"><code class="e2e-id">${esc(t.e2eTestId || e2eTestId)}</code> · ${esc(t.scenario || t.title || '')} <span class="muted-sm">· Projet : <code>${esc(t.project || '')}</code></span></p>
      <p class="muted-sm">Le test sera exécuté <strong>tel qu'enregistré</strong> : le dépôt, la configuration Playwright, le spec, les paramètres et les variables du projet sont résolus automatiquement. Aucun réglage technique n'est modifiable.</p>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="button" class="launch-btn" id="e2e-run-go">▶ Lancer</button>
      </div>
      <div id="e2e-run-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('e2e-run-go').onclick = async () => {
    const btn = document.getElementById('e2e-run-go');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Lancement');
    const msg = document.getElementById('e2e-run-msg');
    msg.textContent = 'Lancement du run en arrière-plan…';
    msg.className = 'msg';
    try {
      const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'manual' }),
      });
      closeModal();
      if (r && r.jobId) e2eRunJobWait(e2eTestId, r.jobId);
      else alert((r && r.message) || (r && r.error) || 'Run terminé.');
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = 'Échec : ' + (e.message || e); msg.className = 'msg error';
    }
  };
}

// Modale « spec absent du checkout » — le test existe dans l'historique git.
// Propose de relancer via un WORKTREE temporaire au commit choisi (spec +
// helpers + config complets au commit ; rien n'est restauré dans main).
function e2eRunFromGitModal(e2eTestId, pre) {
  const short = (s) => String(s || '').slice(0, 10);
  const msgLine = String(pre.message || '').slice(0, 260);
  showModal(`
    <div class="modal modal-wide">
      <h2>Test introuvable dans le checkout — mais récupérable via git</h2>
      <p class="muted">Test <code class="e2e-id">${esc(e2eTestId)}</code></p>
      <p class="muted-sm">${esc(msgLine)}</p>
      <p class="muted-sm"><strong>Ce spec existe dans l'historique git</strong> (création / modification). Vous pouvez lancer le run depuis un <strong>worktree temporaire</strong> au commit choisi : le spec + ses helpers + la config Playwright sont pris au commit, exécutés dans un dossier isolé (<code>/root/test-E2E/…</code>), puis nettoyés. Rien n'est modifié dans la branche <code>${esc(pre.repoDir || '')}</code>.</p>
      <div class="actions-section"><h3>Choisir une origine (commit où le spec existe)</h3>
        <div class="recette-list">${(pre.candidates || []).map((c) => `<div class="recette-item">
          <code>${esc(c.branch || 'historique')} @ ${esc(c.short)}</code>
          <span class="muted-sm">${esc(fmtTS(c.date))}</span>
          <span class="muted-sm">${esc((c.subject || '').slice(0, 80))}</span>
          <button type="button" class="launch-btn" data-run-ref="${esc(c.sha)}">▶ Lancer depuis ce commit</button>
        </div>`).join('')}</div>
      </div>
      <p class="muted-sm">Alternative : <strong>merger d'abord la branche</strong> contenant ce spec sur main puis relancer (le run s'exécutera alors normalement dans le checkout).</p>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
      <div id="git-run-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.querySelectorAll('#modal-backdrop [data-run-ref]').forEach((b) => b.addEventListener('click', async () => {
    const msg = document.getElementById('git-run-msg');
    const sha = b.dataset.runRef;
    const original = b.innerHTML;
    setBtnBusy(b, 'Lancement');
    const runBody = { origin: 'manual', runFromRef: sha };
    msg.textContent = `Création d'un worktree temporaire au commit ${short(sha)} puis lancement… (peut prendre plusieurs minutes)`;
    msg.className = 'msg';
    try {
      const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(runBody),
      });
      closeModal();
      if (r && r.jobId) e2eRunJobWait(e2eTestId, r.jobId);
      else alert((r && r.message) || 'Run terminé.');
    } catch (err) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      msg.textContent = 'Échec : ' + (err.message || err); msg.className = 'msg error';
    }
  }));
}

// Attend un job asynchrone puis ouvre le détail (réutilisé par la modale run).
function e2eRunJobWait(e2eTestId, jobId) {
  let tries = 0;
  const t = () => {
    tries++;
    if (tries > 180) { alert('Le run est toujours en cours en arrière-plan — consultez l\'historique du test (Détail).'); e2eDetailModal(e2eTestId); return; }
    api(`/api/e2e/jobs/${encodeURIComponent(jobId)}`).then((st) => {
      if (st && st.status === 'DONE') { e2eDetailModal(e2eTestId); return; }
      if (st && st.status === 'ERROR') {
        let pre = null;
        try { pre = JSON.parse(String(st.error || '').replace(/^ERREUR\s*:\s*/, '').trim()); } catch {}
        if (pre && pre.code === 'SPEC_NOT_IN_CHECKOUT') { alert('Le commit choisi ne contient pas le spec — choisissez une autre origine.'); e2eRunFromGitModal(e2eTestId, pre); return; }
        alert('Le run a échoué : ' + (st.error || 'erreur worker'));
        e2eDetailModal(e2eTestId);
        return;
      }
      setTimeout(t, 4000);
    }).catch(() => setTimeout(t, 4000));
  };
  setTimeout(t, 3000);
}

function e2eObsoleteModal(e2eTestId) {
  showModal(`
    <div class="modal">
      <h2>Marquer le test obsolète</h2>
      <p class="muted">Test <span class="code">${esc(e2eTestId)}</span></p>
      <p>Le test passera au statut <strong>OBSOLETE</strong> (spec disparu du repo). Son historique est conservé ; un nouvel enregistrement du même spec le réactivera.</p>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="modal-confirm">Marquer obsolète</button>
      </div>
      <div id="e2e-obsolete-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Obsolète');
    const msg = document.getElementById('e2e-obsolete-msg');
    try {
      await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/obsolete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      closeModal();
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = e.message || String(e); msg.className = 'msg error';
    }
  };
}

// Modale « Marquer incohérent » (évaluateur, ADR-003) : signal comportement réel
// ≠ scénario. Remarques OBLIGATOIRES ; l'évaluateur ne modifie PAS le code de
// test (spec / formalisation). `onDone` permet de re-rendre la vue d'origine.
function e2eIncoherentModal(e2eTestId, onDone) {
  showModal(`
    <div class="modal">
      <h2>Marquer le test « incohérent »</h2>
      <p class="muted">Test <span class="code">${esc(e2eTestId)}</span></p>
      <p class="muted-sm">Signalez que le <strong>comportement réel ne correspond pas au scénario / à la règle</strong> du test. Le statut passe à <strong>INCOHERENT</strong> et vos remarques sont conservées. Vous ne modifiez ni le spec ni la formalisation du test.</p>
      <label class="modal-field">Remarques <span class="muted-sm">(obligatoire — décrivez l'écart constaté)</span>
        <textarea id="e2e-incoherent-remarks" class="modal-textarea" rows="4" placeholder="ex. : la règle X n'est pas appliquée lorsque…"></textarea>
      </label>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="modal-confirm">Marquer incohérent</button>
      </div>
      <div id="e2e-incoherent-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    const msg = document.getElementById('e2e-incoherent-msg');
    const remarks = (document.getElementById('e2e-incoherent-remarks').value || '').trim();
    if (!remarks) { msg.textContent = 'Remarques obligatoires : décrivez l\'incohérence constatée.'; msg.className = 'msg error'; return; }
    setBtnBusy(btn, 'Signalement');
    try {
      await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/incoherent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remarks }) });
      closeModal();
      if (typeof onDone === 'function') onDone(); else refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = e.message || String(e); msg.className = 'msg error';
    }
  };
}

async function e2eCreateModal() {
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  const projOpts = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') || '<option value="">— aucun projet enregistré —</option>';

  // --- Étape 1 : le spec existe-t-il déjà ? ---
  showModal(`
    <div class="modal">
      <h2>Nouveau test E2E</h2>
      <p class="muted-sm">Le <strong>spec Playwright</strong> de ce test existe-t-il déjà dans le dépôt ?</p>
      <div class="actions-buttons" style="margin-top:12px">
        <button type="button" class="approve" id="ec-existing">Oui — enregistrer un test existant</button>
        <button type="button" class="launch-btn" id="ec-new">Non — créer le test (session test-agent)</button>
      </div>
      <div class="modal-actions"><button type="button" class="ghost" id="modal-cancel">Annuler</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('ec-existing').addEventListener('click', () => e2eRegisterModal(projects, projOpts));
  document.getElementById('ec-new').addEventListener('click', () => e2eCreateViaAgentModal(projects, projOpts));
}

// --- Cas « Oui » : le spec existe déjà → enregistrement (champs obligatoires) ---
// Les repos de code associés (repos traversés, ADR 11) définissent la COUVERTURE
// du test — lus par l'agent de cadrage dès la création.
async function e2eRegisterModal(projects, projOpts) {
  const reposRes = await api('/api/repos').catch(() => ({ repos: [] }));
  const reposById = new Map((reposRes.repos || []).map((r) => [r.id, r]));
  const reposOf = (pid) => {
    const p = projects.find((x) => x.id === pid);
    return (p && p.repos || []).map((rid) => reposById.get(rid)).filter(Boolean);
  };
  const selectedRepoIds = () => [...document.querySelectorAll('#modal-backdrop .er-repo:checked')].map((c) => c.value);
  showModal(`
    <div class="modal modal-wide">
      <h2>Enregistrer un test E2E existant</h2>
      <p class="muted-sm">Le spec Playwright est déjà écrit dans un repo du projet — on l'enregistre comme entité (projet + scénario + <strong>repos de code couverts</strong>).</p>
      <form id="e2e-register-form" class="pilot-form">
        <label class="modal-field">Projet <span class="muted-sm">— produit dont le comportement est vérifié — requis</span>
          <select id="er-project" required><option value="">— projet —</option>${projOpts}</select>
        </label>
        <fieldset id="er-repos-fieldset" class="pilot-fieldset" hidden>
          <legend>Repos de code associés <span class="muted-sm">— couverture du test, repos traversés par le comportement (ex. S1 traverse mada-talk ET oniria). Défaut : tous les repos du projet.</span></legend>
          <div id="er-repos-list"></div>
        </fieldset>
        <label class="modal-field">Spec file <span class="muted-sm">— requis</span>
          <input id="er-specfile" placeholder="ex: tests/e2e/auth/login.spec.ts" required>
        </label>
        <label class="modal-field">Scénario <span class="muted-sm">— titre du test() — requis</span>
          <input id="er-scenario" placeholder="ex: connexion réussie" required>
        </label>
        <label class="modal-field">Titre court / comportement (optionnel)
          <input id="er-title" placeholder="ex: Connexion — parcours nominal">
        </label>
        <label class="modal-field">Description (optionnel)
          <textarea id="er-description" class="modal-textarea" rows="2" placeholder="comportement vérifié"></textarea>
        </label>
        <div class="links-editor">
          <div class="links-head"><label class="modal-field" style="margin:0">Paramètres <span class="muted-sm">(défauts NON sensibles — secret = secretRef uniquement)</span></label>
          <button type="button" class="ghost" id="er-add-param">+ Ajouter</button></div>
          <div id="er-params-list"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="approve">Enregistrer</button>
        </div>
      </form>
      <div id="er-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  bindE2EParamEditor('er');
  // Binding projet → repos de code associés (défaut : tous cochés).
  const reposList = document.getElementById('er-repos-list');
  const reposFieldset = document.getElementById('er-repos-fieldset');
  const projSel = document.getElementById('er-project');
  const projRepoIds = {};
  const renderRepoChecks = (pid) => {
    const reps = reposOf(pid);
    if (!reps.length) { reposFieldset.hidden = true; reposList.innerHTML = ''; return; }
    reposFieldset.hidden = false;
    const saved = projRepoIds[pid];
    reposList.innerHTML = reps.map((r) => `
      <label class="filter-check"><input type="checkbox" class="er-repo" value="${esc(r.id)}"
        ${!saved || saved.includes(r.id) ? 'checked' : ''}>
        <code>${esc(r.id)}</code>${r.workspace ? ` <span class="muted-sm">· ${esc(r.workspace)}</span>` : ''}${r.mainBranch ? ` <span class="muted-sm">· ${esc(r.mainBranch)}</span>` : ''}
      </label>`).join('');
  };
  projSel.addEventListener('change', () => {
    const pid = projSel.value;
    if (pid) projRepoIds[pid] = selectedRepoIds();
    renderRepoChecks(pid);
  });
  document.getElementById('e2e-register-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('er-msg');
    const project = document.getElementById('er-project').value;
    const specFile = document.getElementById('er-specfile').value.trim();
    const scenario = document.getElementById('er-scenario').value.trim();
    if (!project || !specFile || !scenario) { msg.textContent = 'project, specFile et scenario sont requis pour un test existant.'; msg.className = 'msg error'; return; }
    const params = collectE2EParams('er', msg);
    if (params === null) return;
    const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Enregistrement');
    const pid = document.getElementById('er-project').value;
    projRepoIds[pid] = selectedRepoIds();
    try {
      await api('/api/e2e-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project, specFile, scenario,
        title: document.getElementById('er-title').value.trim() || undefined,
        description: document.getElementById('er-description').value.trim() || undefined,
        params,
        repoIds: projRepoIds[pid] && projRepoIds[pid].length ? projRepoIds[pid] : undefined,
        organizationId: currentOrg || undefined,
      }) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// --- Cas « Non » : le test n'existe pas → création via session test-agent ---
// Champs minimaux : projet (produit) + titre/comportement. Le spec file et
// scénario seront définis pendant la session test-agent. Les repos de code
// associés (couverture) et les ADR en contexte (sélection multi-lignes, item 125
// → bloc « ADR de référence ») sont choisis dès maintenant (transmis au test-agent).
async function e2eCreateViaAgentModal(projects, projOpts) {
  const reposRes = await api('/api/repos').catch(() => ({ repos: [] }));
  const reposById = new Map((reposRes.repos || []).map((r) => [r.id, r]));
  const reposOf = (pid) => {
    const p = projects.find((x) => x.id === pid);
    return (p && p.repos || []).map((rid) => reposById.get(rid)).filter(Boolean);
  };
  const selectedRepoIds = () => [...document.querySelectorAll('#modal-backdrop .ea-repo:checked')].map((c) => c.value);
  const projRepoIds = {};

  showModal(`
    <div class="modal modal-wide">
      <h2>Créer un test E2E (via test-agent)</h2>
      <p class="muted-sm">Le spec n'existe pas encore : on crée l'entité (DRAFT) sur le <strong>projet</strong> puis on ouvre une <strong>session test-agent</strong> qui rédige le spec (dans un repo du projet, workspace Coder, branche de travail).</p>
      <form id="e2e-agent-form" class="pilot-form">
        <label class="modal-field">Projet <span class="muted-sm">— produit dont le comportement sera vérifié — requis</span>
          <select id="ea-project" required><option value="">— projet —</option>${projOpts}</select>
        </label>
        <fieldset id="ea-repos-fieldset" class="pilot-fieldset" hidden>
          <legend>Repos de code associés <span class="muted-sm">— couverture du test : repos traversés par le comportement (ex. parcours client + console = mada-talk ET oniria). Le test-agent écrira le spec dans l'un d'eux. Défaut : tous les repos du projet.</span></legend>
          <div id="ea-repos-list"></div>
        </fieldset>
        <fieldset id="ea-adr-fieldset" class="pilot-fieldset">
          <legend>ADR en contexte — décisions d'architecture <span class="muted-sm">(sélection multi-lignes ; le bloc « ADR de référence » est injecté dans le prompt). Toutes cochées par défaut.</span></legend>
          <div id="ea-adr-pick"></div>
        </fieldset>
        <label class="modal-field">Comportement à tester (titre) <span class="muted-sm">— requis</span>
          <input id="ea-title" placeholder="ex: Connexion puis création d'une demande de chatbot" required>
        </label>
        <label class="modal-field">Description <span class="muted-sm">— optionnel, guide l'agent</span>
          <textarea id="ea-description" class="modal-textarea" rows="3" placeholder="parcours à couvrir, préconditions, données, ce qui doit être vérifié…"></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer + ouvrir la session test-agent</button>
        </div>
      </form>
      <div id="ea-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const reposList = document.getElementById('ea-repos-list');
  const reposFieldset = document.getElementById('ea-repos-fieldset');
  const adrBox = document.getElementById('ea-adr-pick');
  const projSel = document.getElementById('ea-project');
  adrBox.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour afficher ses ADR (décisions d\'architecture).</p>';
  const renderRepoChecks = (pid) => {
    const reps = reposOf(pid);
    if (!reps.length) { reposFieldset.hidden = true; reposList.innerHTML = ''; return; }
    reposFieldset.hidden = false;
    const saved = projRepoIds[pid];
    reposList.innerHTML = reps.map((r) => `
      <label class="filter-check"><input type="checkbox" class="ea-repo" value="${esc(r.id)}"
        ${!saved || saved.includes(r.id) ? 'checked' : ''}>
        <code>${esc(r.id)}</code>${r.workspace ? ` <span class="muted-sm">· ${esc(r.workspace)}</span>` : ''}${r.mainBranch ? ` <span class="muted-sm">· ${esc(r.mainBranch)}</span>` : ''}
      </label>`).join('');
  };
  // ADR en contexte (item 125) : sélection multi-lignes des ADR du projet.
  const renderAdrs = async () => {
    const pid = projSel.value;
    if (!pid) { adrBox.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour lister ses ADR.</p>'; return; }
    adrBox.innerHTML = '<p class="muted-sm">Chargement des ADR…</p>';
    let adrs = [];
    try {
      const dr = await api(`/api/docs?projectId=${encodeURIComponent(pid)}&includeRepoDocs=1`);
      adrs = (dr.docs || []).filter((d) => d && d.kind === 'adr-tech');
    } catch { adrs = []; }
    adrBox.innerHTML = adrSelectorHtml(adrs, { prefix: 'ea-adr-pick', repos: reposOf(pid) });
    bindAdrSelector('ea-adr-pick');
  };
  projSel.addEventListener('change', () => {
    const pid = projSel.value;
    if (pid) projRepoIds[pid] = selectedRepoIds();
    renderRepoChecks(pid);
    renderAdrs();
  });
  document.getElementById('e2e-agent-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('ea-msg');
    const project = document.getElementById('ea-project').value;
    const title = document.getElementById('ea-title').value.trim();
    if (!project || !title) { msg.textContent = 'project et comportement (titre) sont requis.'; msg.className = 'msg error'; return; }
    const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    msg.textContent = 'Création de l\'entité + lancement de la session test-agent… (peut prendre quelques secondes).';
    msg.className = 'msg';
    const pid = document.getElementById('ea-project').value;
    projRepoIds[pid] = selectedRepoIds();
    try {
      const r = await api('/api/e2e-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project, title,
        description: document.getElementById('ea-description').value.trim() || undefined,
        viaAgent: true,
        repoIds: projRepoIds[pid] && projRepoIds[pid].length ? projRepoIds[pid] : undefined,
        adrIds: selectedAdrIds('ea-adr-pick'), // toujours un tableau (vide = aucune ADR en contexte)
        organizationId: currentOrg || undefined,
      }) });
      closeModal();
      if (r && r.session && r.session.sessionId && /^ses_/.test(r.session.sessionId)) {
        window.open(sessionHref(r.session.sessionId), '_blank');
      } else {
        const eid = r && r.test && (r.test.e2eTestId || r.test.id);
        if (eid) e2eDetailModal(eid);
        alert((r.session && r.session.error) ? ('Test DRAFT créé mais session indisponible : ' + r.session.error) : 'Test créé (DRAFT).');
      }
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

// Éditeur de paramètres partagé (cas « Oui »). Renvoie null si erreur (message posé).
function bindE2EParamEditor(prefix) {
  const paramsList = document.getElementById(prefix + '-params-list');
  const addRow = () => {
    const row = document.createElement('div');
    row.className = 'link-row ec-param-row';
    row.innerHTML = `
      <input type="text" class="${prefix}-p-name" placeholder="nom (ex: baseUrl)" style="flex:1;min-width:110px">
      <select class="${prefix}-p-kind" style="width:105px">
        <option value="string">string</option><option value="url">url</option><option value="int">int</option>
        <option value="bool">bool</option><option value="secret">secret</option>
      </select>
      <input type="text" class="${prefix}-p-default" placeholder="défaut" style="flex:1;min-width:110px">
      <input type="text" class="${prefix}-p-secretref" placeholder="secretRef (secret)" style="flex:1;min-width:110px" hidden>
      <label class="filter-check" title="Paramètre requis pour l'exécution"><input type="checkbox" class="${prefix}-p-required"> requis</label>
      <button type="button" class="ghost ${prefix}-p-del" title="Retirer">✕</button>`;
    const kindSel = row.querySelector('.' + prefix + '-p-kind');
    const defaultInp = row.querySelector('.' + prefix + '-p-default');
    const refInp = row.querySelector('.' + prefix + '-p-secretref');
    const sync = () => {
      const isSecret = kindSel.value === 'secret';
      refInp.hidden = !isSecret;
      defaultInp.placeholder = isSecret ? '— secret : valeur via secretRef —' : 'défaut (vide = aucun)';
      if (isSecret) defaultInp.value = '';
    };
    kindSel.addEventListener('change', sync);
    sync();
    row.querySelector('.' + prefix + '-p-del').addEventListener('click', () => row.remove());
    paramsList.appendChild(row);
  };
  document.getElementById(prefix + '-add-param').addEventListener('click', addRow);
}

function collectE2EParams(prefix, msg) {
  const params = [];
  const paramsList = document.getElementById(prefix + '-params-list');
  for (const row of paramsList.querySelectorAll('.ec-param-row')) {
    const name = row.querySelector('.' + prefix + '-p-name').value.trim();
    if (!name) continue;
    const kind = row.querySelector('.' + prefix + '-p-kind').value;
    const defaultValue = row.querySelector('.' + prefix + '-p-default').value.trim();
    const secretRef = row.querySelector('.' + prefix + '-p-secretref').value.trim();
    if (kind === 'secret' && defaultValue) {
      msg.textContent = 'Paramètre secret « ' + name + ' » : aucune valeur en clair (secretRef uniquement).';
      msg.className = 'msg error';
      return null;
    }
    params.push({ name, kind, defaultValue: defaultValue || undefined, secretRef: secretRef || undefined, required: row.querySelector('.' + prefix + '-p-required').checked });
  }
  return params;
}

// Ouvre la session de cadrage : reprend la session rattachée si elle existe
// (jamais de doublon) ; `force = true` démarre une nouvelle session.
async function openCadrageSession(cadrageId, force, btn) {
  const T = cadrageTerms();
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Ouverture');
  try {
    const r = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || (force ? `Impossible de lancer une nouvelle session de ${T.entityLower}.` : `Aucune session de ${T.entityLower} disponible.`));
    refreshActive();
  } catch (e) {
    if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert(`Échec de la session de ${T.entityLower} : ` + (e.message || e));
  }
}

// Ouvre la SESSION du recette ÉVALUATEUR (agent-recette) : reprend la
// session rattachée si elle existe (jamais de doublon) ; `force = true` démarre
// une nouvelle session. Miroir de `openCadrageSession` (route
// POST /api/recettes/:id/session, ADR-001/003).
async function openRecetteSession(recetteId, force, btn) {
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Ouverture');
  try {
    const r = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || (force ? "Impossible de lancer une nouvelle session de recette." : "Aucune session de recette disponible."));
    refreshActive();
  } catch (e) {
    if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert("Échec de la session de recette : " + (e.message || e));
  }
}

function cadrageCard(r) {
  const T = cadrageTerms();
  const canSession = r.status === 'pending' || r.status === 'in_progress';
  const canFinish = r.status === 'in_progress';
  return `<article class="project-card">
    <div class="project-card-head"><strong class="recette-title" data-rec-detail="${esc(r.cadrage_id)}" title="Voir le détail">${esc(r.title || r.cadrage_id)}</strong> <span class="rec-card-projs">${cadrageScopeChips(r)}</span> ${badge(r.status)} ${Number(r.adr_vigilances_count || 0) > 0 ? `<span class="badge danger" title="${Number(r.adr_vigilances_count)} point(s) de vigilance ADR ouvert(s) — terminaison bloquée">⚠ ADR (${Number(r.adr_vigilances_count)})</span>` : ''}</div>
    <div class="project-card-body">
      ${r.description ? `<div class="project-kv"><span class="lbl">Description</span><span class="muted-sm">${esc(r.description.slice(0, 100))}${r.description.length > 100 ? '…' : ''}</span></div>` : ''}
      <div class="project-kv"><span class="lbl">Tâches couvertes</span><span>${r.tasks_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">${T.elementsCap}</span><span>${r.items_count || 0}</span></div>
      ${r.confirmed_at ? `<div class="project-kv"><span class="lbl">Confirmée</span><span class="muted-sm">${esc((r.confirmed_at || '').replace('T', ' ').slice(0, 16))}</span></div>` : ''}
      <div class="project-kv"><span class="lbl">Créée par</span><span>${esc(r.created_by || '—')}</span></div>
    </div>
    <div class="project-card-actions">
      <button class="ghost" data-rec-docs="${esc(r.cadrage_id)}">Documents (${r.documents_count || 0})</button>
      ${canSession ? `<button class="launch-btn" data-rec-session="${esc(r.cadrage_id)}" title="${r.session_id ? T.sessionResume : T.sessionHint}">${T.session}</button>` : ''}
      ${canFinish ? `<button class="approve" data-rec-finish="${esc(r.cadrage_id)}">${T.finish}</button>` : ''}
      ${r.status === 'done' ? `<button class="ghost" data-rec-items="${esc(r.cadrage_id)}">${T.detail}</button>` : ''}
      ${IS_ADMIN ? `<button class="ghost danger-text" data-rec-del="${esc(r.cadrage_id)}" data-rec-title="${esc(r.title || r.cadrage_id)}" title="Supprimer ${T.theEntity} (admin) — irréversible">Supprimer</button>` : ''}
    </div>
  </article>`;
}

async function renderCadrages() {
  const T = cadrageTerms();
  const [data, bdata] = await Promise.all([
    api(cadragesApiBase() + (currentProject ? `?project=${encodeURIComponent(currentProject)}` : '')),
    api('/api/batches' + (currentProject ? `?project=${encodeURIComponent(currentProject)}` : '')).catch(() => ({ batches: [] })),
  ]);
  let recs = data.cadrages || [];
  const batches = (bdata.batches || []).filter((b) => b.status === 'active');
  const allCreators = [...new Set([...recs.map((r) => r.created_by || '—').filter(Boolean), ...cadragesUserFilter])];
  const renderUserUI = () => {
    const box = document.getElementById('rec-user-tags');
    const sel = document.getElementById('rec-user-add');
    const clear = document.getElementById('rec-user-clear');
    if (!box) return;
    box.innerHTML = cadragesUserFilter.length
      ? cadragesUserFilter.map((u) => `<span class="status-chip"><span class="chip-txt">${esc(u)}</span><button type="button" class="chip-x" data-user="${esc(u)}" title="Retirer « ${esc(u)} »">×</button></span>`).join('')
      : '<span class="tagfilter-empty">tous les créateurs</span>';
    sel.innerHTML = `<option value="">+ Ajouter…</option>` + allCreators.filter((u) => !cadragesUserFilter.includes(u)).map((u) => `<option>${esc(u)}</option>`).join('');
    clear.hidden = !cadragesUserFilter.length;
  };
  const setUserFilter = (next) => {
    cadragesUserFilter = [...new Set(next)];
    persistCadragesUsers();
    refreshActive();
  };
  recs = recs.filter((r) => !cadragesUserFilter.length || cadragesUserFilter.includes(r.created_by || '—'));
  // Filtre CIBLE « sans lien » (id-set de la cardinalité, source registre).
  if (cadragesMissingFilter) {
    const missingIds = await cardinalityIdSetFor(cadragesMissingFilter, 'cadrage');
    if (missingIds) recs = recs.filter((r) => missingIds.has(r.cadrage_id));
  }
  document.getElementById('pane-cadrages').innerHTML = `
    <h2>${T.entities}</h2>
    <p class="muted-sm">Cadrages techniques — chaque cadrage couvre UN projet (produit) et 0..N tâches de ce projet ; les repos transverses du projet sont sa portée réelle. Titre et session dédiée.</p>
    ${batches.length ? `<div class="actions-section"><h3>Batches d'orchestration actifs <span class="muted-sm">(${batches.length})</span></h3><div class="project-cards">${batches.map(batchCard).join('')}</div></div>` : ''}
    <div class="filters">
      ${IS_EVALUATEUR ? '' : `<div class="status-tagfilter" id="rec-user-tagfilter" title="Afficher les ${T.entitiesLower} des utilisateurs sélectionnés (multi)">
        <span class="tagfilter-label">Créateurs :</span>
        <span class="tagfilter-tags" id="rec-user-tags"></span>
        <select id="rec-user-add" title="Ajouter un créateur à filtrer"><option value="">+ Ajouter…</option></select>
        <button type="button" class="ghost tagfilter-clear" id="rec-user-clear" hidden>tout afficher</button>
      </div>`}
      <select id="rec-missing" title="Filtrer par lien manquant (cardinalité : source registre)">
        <option value="">Sans lien : tous</option>
        <option value="cadrage_sans_adr">Sans ADR</option>
        <option value="cadrage_sans_fonctionnalite">Sans fonctionnalité</option>
        <option value="cadrage_sans_sprint">Sans sprint</option>
      </select>
      <button id="new-cadrage-btn" class="launch-btn">+ ${T.newEntity}</button>
    </div>
    <div class="project-cards">${recs.map(cadrageCard).join('') || `<p class="muted">${T.empty}</p>`}</div>`;
  renderUserUI();
  const sel = document.getElementById('rec-user-add');
  if (sel) sel.addEventListener('change', () => {
    const v = sel.value;
    if (v && !cadragesUserFilter.includes(v)) setUserFilter([...cadragesUserFilter, v]);
    sel.value = '';
  });
  const box = document.getElementById('rec-user-tags');
  if (box) box.addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (x) setUserFilter(cadragesUserFilter.filter((u) => u !== x.dataset.user));
  });
  const clear = document.getElementById('rec-user-clear');
  if (clear) clear.addEventListener('click', () => setUserFilter([]));
  // Filtre cible « sans lien » : valeur pré-appliquée (clic carte) + persistance.
  const recMissingEl = document.getElementById('rec-missing');
  if (recMissingEl) {
    recMissingEl.value = cadragesMissingFilter || '';
    recMissingEl.addEventListener('change', () => {
      cadragesMissingFilter = recMissingEl.value;
      persistCadragesMissing();
      refreshActive();
    });
  }
  document.getElementById('new-cadrage-btn').addEventListener('click', () => cadrageCreateModal());
  document.querySelectorAll('#pane-cadrages [data-rec-session]').forEach((b) => b.addEventListener('click', () => openCadrageSession(b.dataset.recSession, false, b)));
  document.querySelectorAll('#pane-cadrages [data-rec-finish]').forEach((b) => b.addEventListener('click', () => finishCadrageModal(b.dataset.recFinish)));
  document.querySelectorAll('#pane-cadrages [data-rec-items]').forEach((b) => b.addEventListener('click', () => cadrageDetailItemsModal(b.dataset.recItems)));
  document.querySelectorAll('#pane-cadrages [data-rec-docs]').forEach((b) => b.addEventListener('click', () => cadrageDocsModal(b.dataset.recDocs)));
  document.querySelectorAll('#pane-cadrages [data-rec-detail]').forEach((b) => b.addEventListener('click', () => cadrageDetailModal(b.dataset.recDetail)));
  document.querySelectorAll('#pane-cadrages [data-rec-del]').forEach((b) => b.addEventListener('click', () => deleteCadrageFlow(b.dataset.recDel, b.dataset.recTitle, refreshActive, b)));
  document.querySelectorAll('#pane-cadrages [data-batch-session]').forEach((b) => b.addEventListener('click', () => openBatchSession(b.dataset.batchSession, b)));
  document.querySelectorAll('#pane-cadrages [data-batch-detail]').forEach((b) => b.addEventListener('click', () => batchDetailModal(b.dataset.batchDetail)));
}

// ===========================================================================
// Page « Cadrage » de l'ÉVALUATEUR PRODUIT (T-20260922-100650-sbc1) — onglet
// `recettes`. Objet DISTINCT du Cadrage technique (`cadrages`). L'évaluateur
// décrit le PARCOURS ÉVALUÉ, rattache fonctionnalités (verdict) + règles métier,
// enregistre des recommandations/problèmes et joint des pièces. Aucune
// conversion en tâches. L'évaluateur ne voit que SES recettes.
// ===========================================================================
function recettesApiBase() { return '/api/recettes'; }

// Icône d'une pièce d'évaluation selon sa nature (dont `maquette`/`performance`).
function evalNatureIcon(nature) {
  return nature === 'lien' ? '🔗' : nature === 'photo' ? '🖼' : nature === 'video' ? '🎬'
    : nature === 'maquette' ? '🧩' : nature === 'performance' ? '⚡' : '📄';
}

// `meta` d'une pièce (JSONB renvoyé tel quel par l'API).
function evalDocMeta(doc) {
  return doc && doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
}

// Détails d'une pièce d'évaluation : bouton « Ouvrir la maquette » (URL servie
// par le panneau) ou synthèse des métriques de performance. Vide sinon.
function evalDocDetailsHtml(doc) {
  const meta = evalDocMeta(doc);
  if (doc.nature === 'maquette' && meta.url) {
    return `<a class="ghost" href="${esc(meta.url)}" target="_blank" rel="noopener" title="Ouvrir la maquette (page statique servie par le panneau)">Ouvrir la maquette</a>`;
  }
  if (doc.nature === 'performance') {
    const m = meta.metrics || {};
    const bits = [];
    if (meta.summary) bits.push(meta.summary);
    else {
      if (m.timings && m.timings.ttfbMs != null) bits.push(`TTFB ${Math.round(m.timings.ttfbMs)}ms`);
      const v = m.vitals || {};
      if (v.lcpMs != null) bits.push(`LCP ${v.lcpMs}ms${v.ratings && v.ratings.lcp ? ` (${v.ratings.lcp})` : ''}`);
      if (v.inpMs != null) bits.push(`INP ${v.inpMs}ms`);
      if (v.cls != null) bits.push(`CLS ${v.cls}`);
      if (m.networkErrors && m.networkErrors.total) bits.push(`erreurs réseau ${m.networkErrors.total}`);
      if (Array.isArray(m.console) && m.console.length) bits.push(`console ${m.console.length}`);
      if (m.stress && m.stress.global) bits.push(`stress ${m.stress.global.routeCount || (m.stress.routes ? m.stress.routes.length : 1)} route(s) → ${m.stress.global.rps} req/s, p95 ${m.stress.global.latencyMs.p95}ms, ${m.stress.global.errorRate}% err`);
    }
    // Preuves des tests standard : erreurs console/réseau + stress par route.
    const pageErrors = Array.isArray(m.pageErrors) ? m.pageErrors : [];
    const consoleMsgs = Array.isArray(m.console) ? m.console : [];
    const neItems = m.networkErrors && Array.isArray(m.networkErrors.items) ? m.networkErrors.items : [];
    const stressRoutes = m.stress && Array.isArray(m.stress.routes) ? m.stress.routes : [];
    let details = '';
    if (pageErrors.length || consoleMsgs.length || neItems.length || stressRoutes.length) {
      const blocks = [];
      if (pageErrors.length) blocks.push(`<div><strong>Exceptions JS (${pageErrors.length})</strong><ul>${pageErrors.slice(0, 10).map((x) => `<li>${esc(x.message || '')}</li>`).join('')}</ul></div>`);
      if (consoleMsgs.length) blocks.push(`<div><strong>Console (${consoleMsgs.length})</strong><ul>${consoleMsgs.slice(0, 10).map((c) => `<li>[${esc(c.level)}] ${esc(c.text || '')}</li>`).join('')}</ul></div>`);
      if (neItems.length) blocks.push(`<div><strong>Erreurs réseau (${m.networkErrors.total})</strong><ul>${neItems.slice(0, 10).map((i) => `<li>${esc(i.category)} — ${esc(i.status != null ? i.status : (i.errorText || ''))} — ${esc(i.url || '')}</li>`).join('')}</ul></div>`);
      if (stressRoutes.length) blocks.push(`<div><strong>Stress par route</strong><ul>${stressRoutes.slice(0, 10).map((r) => `<li>${esc(r.route)} — ${r.rps} req/s · p95 ${r.latencyMs ? r.latencyMs.p95 : '-'}ms · ${r.errorRate}% err</li>`).join('')}</ul></div>`);
      details = `<details class="eval-perf-details"><summary>Détails des tests standard</summary>${blocks.join('')}</details>`;
    }
    const summaryHtml = bits.length ? `<span class="muted-sm" title="Résumé des tests standard">${esc(bits.join(' · '))}</span>` : '';
    if (summaryHtml || details) return `${summaryHtml}${details}`;
  }
  return '';
}

// Suit l'état d'un job de PERFORMANCE asynchrone jusqu'à DONE/ERROR, puis
// recharge le cadrage (le rapport est alors rattaché comme pièce `performance`).
async function pollRecettePerfJob(recetteId, jobId, outEl, msgEl, tries = 0) {
  try {
    const r = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/perf-jobs/${encodeURIComponent(jobId)}`);
    if (r.status === 'RUNNING') {
      if (tries > 200) { if (outEl) outEl.textContent = 'Toujours en cours (suivi interrompu).'; return; }
      setTimeout(() => pollRecettePerfJob(recetteId, jobId, outEl, msgEl, tries + 1), 3000);
      return;
    }
    if (r.status === 'DONE') {
      if (msgEl) { msgEl.textContent = 'Test de performance terminé — rapport rattaché au cadrage.'; msgEl.className = 'msg'; }
      if (outEl) outEl.textContent = (r.result && r.result.report && r.result.report.summary) || 'Terminé.';
      setTimeout(() => recetteDetailModal(recetteId), 1200);
    } else {
      if (msgEl) { msgEl.textContent = 'Échec du test : ' + (r.error || (r.result && r.result.error) || 'inconnu'); msgEl.className = 'msg error'; }
    }
  } catch (e) {
    if (outEl) outEl.textContent = 'Suivi interrompu : ' + (e.message || e);
  }
}

// Badge de statut d'une évaluation (3 statuts : pending | in_progress | done).
function recetteStatusBadge(st) {
  const map = {
    done: ['done', 'faite'],
    in_progress: ['in_progress', 'en cours'],
    pending: ['queued', 'pas faite'],
  };
  const [cls, label] = map[st] || ['queued', st || '—'];
  return `<span class="badge ${cls}" title="Recette : ${esc(label)}">${esc(label)}</span>`;
}
const EVAL_CATEGORY_LABELS = { recommandation: 'Recommandation', probleme: 'Problème' };
const EVAL_SEVERITY_LABELS = { low: 'faible', medium: 'moyenne', high: 'élevée', critical: 'critique' };
const EVAL_VERDICT_LABELS = { conforme: 'conforme', non_conforme: 'non conforme', a_ameliorer: 'à améliorer' };
const EVAL_ITEM_STATUS_LABELS = { open: 'ouvert', treated: 'traité', dismissed: 'écarté' };
// DÉCISION ADMIN (distincte du statut de suivi) : l'admin marque « à traiter »
// ou « non retenu » ; l'exécuteur n'accède qu'aux éléments « à traiter ».
const EVAL_ITEM_DECISION_LABELS = { pending: 'non décidé', a_traiter: 'à traiter', non_retenu: 'non retenu' };
function evalDecisionBadge(d) {
  const cls = d === 'a_traiter' ? 'in_progress' : d === 'non_retenu' ? 'rejected' : 'queued';
  return `<span class="badge ${cls}" title="Décision admin (à traiter / non retenu)">${esc(EVAL_ITEM_DECISION_LABELS[d] || d || '—')}</span>`;
}
function evalCategoryBadge(c) { return `<span class="badge ${c === 'probleme' ? 'danger' : 'awaiting'}">${esc(EVAL_CATEGORY_LABELS[c] || c || '—')}</span>`; }
function evalSeverityBadge(s) { return `<span class="badge eval-sev-${esc(s || 'medium')}" title="Sévérité">${esc(EVAL_SEVERITY_LABELS[s] || s || '—')}</span>`; }
function evalVerdictBadge(v) {
  if (!v) return '<span class="muted-sm">verdict non posé</span>';
  const cls = v === 'conforme' ? 'done' : v === 'non_conforme' ? 'rejected' : 'in_progress';
  return `<span class="badge ${cls}">${esc(EVAL_VERDICT_LABELS[v] || v)}</span>`;
}

// Carte d'une recette évaluateur.
function recetteCard(e) {
  const canFinish = e.status !== 'done';
  return `<article class="project-card">
    <div class="project-card-head">
      <strong class="recette-title" data-eval-detail="${esc(e.recette_id)}" title="Voir le détail">${esc(e.title || e.recette_id)}</strong>
      <span class="rec-card-projs">${(e.repos || []).map((r) => `<code class="chip-repo">${esc(r.repoId || r)}</code>`).join(' ')}</span>
      ${recetteStatusBadge(e.status)}
    </div>
    <div class="project-card-body">
      ${e.description ? `<div class="project-kv"><span class="lbl">Parcours évalué</span><span class="muted-sm">${esc(e.description.slice(0, 120))}${e.description.length > 120 ? '…' : ''}</span></div>` : ''}
      <div class="project-kv"><span class="lbl">Fonctionnalités</span><span>${e.features_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Règles métier</span><span>${e.rules_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Éléments</span><span>${e.items_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">À traiter</span><span>${e.treatable_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Pièces</span><span>${e.documents_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Créée par</span><span>${esc(e.created_by || '—')}</span></div>
    </div>
    <div class="project-card-actions">
      <button class="ghost" data-eval-detail="${esc(e.recette_id)}">Détail</button>
      <button class="ghost" data-eval-pieces="${esc(e.recette_id)}">Pièces (${e.documents_count || 0})</button>
      ${canFinish && !IS_EXECUTEUR && !IS_SUPERVISOR ? `<button class="launch-btn" data-eval-session="${esc(e.recette_id)}" title="${e.session_id ? 'Reprendre la session rattachée' : "Ouvrir une session d'évaluation"}">Session de la recette</button>` : ''}
      ${canFinish && !IS_EXECUTEUR && !IS_SUPERVISOR ? `<button class="approve" data-eval-finish="${esc(e.recette_id)}">Terminer la recette</button>` : ''}
    </div>
  </article>`;
}

async function renderRecettes() {
  const data = await api(recettesApiBase() + (currentProject ? `?project=${encodeURIComponent(currentProject)}` : ''));
  let evals = data.recettes || [];
  const allCreators = [...new Set([...evals.map((e) => e.created_by || '—').filter(Boolean), ...recettesUserFilter])];
  const renderUserUI = () => {
    const box = document.getElementById('eval-user-tags');
    const sel = document.getElementById('eval-user-add');
    const clear = document.getElementById('eval-user-clear');
    if (!box) return;
    box.innerHTML = recettesUserFilter.length
      ? recettesUserFilter.map((u) => `<span class="status-chip"><span class="chip-txt">${esc(u)}</span><button type="button" class="chip-x" data-user="${esc(u)}" title="Retirer « ${esc(u)} »">×</button></span>`).join('')
      : '<span class="tagfilter-empty">tous les créateurs</span>';
    sel.innerHTML = `<option value="">+ Ajouter…</option>` + allCreators.filter((u) => !recettesUserFilter.includes(u)).map((u) => `<option>${esc(u)}</option>`).join('');
    clear.hidden = !recettesUserFilter.length;
  };
  const setUserFilter = (next) => { recettesUserFilter = [...new Set(next)]; persistRecettesUsers(); refreshActive(); };
  // D012 : l'évaluateur ne voit que SES recettes → le filtre créateurs est masqué.
  // L'exécuteur accède à la page en LECTURE SEULE (ADR-002) : pas de filtre créateurs.
  evals = (IS_EVALUATEUR || IS_EXECUTEUR) ? evals : evals.filter((e) => !recettesUserFilter.length || recettesUserFilter.includes(e.created_by || '—'));
  const evalReadOnly = IS_EXECUTEUR || IS_SUPERVISOR;
  const treatableTotal = evals.reduce((n, e) => n + (Number(e.treatable_count) || 0), 0);
  // Libellé d'accès : l'exécuteur ne voit que les éléments « à traiter » ; le
  // superviseur voit TOUTES les recettes (évaluateur + cadrages) en lecture seule.
  const evalReadOnlyHint = IS_EXECUTEUR
    ? `Lecture seule — vous n'accédez qu'aux éléments <strong>à traiter</strong> (${treatableTotal}).`
    : IS_SUPERVISOR
      ? `Lecture seule — vous voyez toutes les recettes (${evals.length}).`
      : IS_EVALUATEUR ? 'Vous ne voyez que vos recettes.' : 'Admin/superviseur voient toutes les recettes.';
  document.getElementById('pane-recettes').innerHTML = `
    <h2>Recettes</h2>
    <p class="muted-sm">Recette de l'<strong>évaluateur produit</strong> — décrit le parcours évalué, rattache des fonctionnalités (verdict) et des règles métier, enregistre des recommandations/problèmes et joint des pièces (lien, document, photo, vidéo). ${evalReadOnlyHint}</p>
    <div class="filters">
      ${(IS_EVALUATEUR || IS_EXECUTEUR) ? '' : `<div class="status-tagfilter" id="eval-user-tagfilter" title="Afficher les recettes des évaluateurs sélectionnés (multi)">
        <span class="tagfilter-label">Créateurs :</span>
        <span class="tagfilter-tags" id="eval-user-tags"></span>
        <select id="eval-user-add" title="Ajouter un créateur à filtrer"><option value="">+ Ajouter…</option></select>
        <button type="button" class="ghost tagfilter-clear" id="eval-user-clear" hidden>tout afficher</button>
      </div>`}
      ${evalReadOnly ? '' : `<button id="new-recette-btn" class="launch-btn">+ Nouvelle recette</button>`}
    </div>
    <div class="project-cards">${evals.map(recetteCard).join('') || '<p class="muted">Aucune recette.</p>'}</div>`;
  renderUserUI();
  const sel = document.getElementById('eval-user-add');
  if (sel) sel.addEventListener('change', () => { const v = sel.value; if (v && !recettesUserFilter.includes(v)) setUserFilter([...recettesUserFilter, v]); sel.value = ''; });
  const box = document.getElementById('eval-user-tags');
  if (box) box.addEventListener('click', (ev) => { const x = ev.target.closest('.chip-x'); if (x) setUserFilter(recettesUserFilter.filter((u) => u !== x.dataset.user)); });
  const clear = document.getElementById('eval-user-clear');
  if (clear) clear.addEventListener('click', () => setUserFilter([]));
  const newEvalBtn = document.getElementById('new-recette-btn');
  if (newEvalBtn) newEvalBtn.addEventListener('click', () => recetteCreateModal());
  document.querySelectorAll('#pane-recettes [data-eval-detail]').forEach((b) => b.addEventListener('click', () => recetteDetailModal(b.dataset.evalDetail)));
  document.querySelectorAll('#pane-recettes [data-eval-pieces]').forEach((b) => b.addEventListener('click', () => recettePiecesModal(b.dataset.evalPieces)));
  document.querySelectorAll('#pane-recettes [data-eval-session]').forEach((b) => b.addEventListener('click', () => openRecetteSession(b.dataset.evalSession, false, b)));
  document.querySelectorAll('#pane-recettes [data-eval-finish]').forEach((b) => b.addEventListener('click', () => recetteFinishConfirm(b.dataset.evalFinish, b)));
}

// Modale de CRÉATION : parcours évalué + fonctionnalités + règles + pièces.
async function recetteCreateModal() {
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  let allArtifacts = [];
  try { allArtifacts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  showModal(`
    <div class="modal modal-wide">
      <h2>Nouvelle recette (évaluateur)</h2>
      <form id="eval-modal-form" class="pilot-form">
        ${projectReadonlyFieldsetHtml(projects)}
        <div id="em-repos-hint" class="muted-sm" style="margin-top:6px"></div>
        <input id="em-title" placeholder="titre court (ex: Recette du parcours d'inscription)" required>
        <textarea id="em-description" class="modal-textarea" placeholder="parcours évalué — ce que l'évaluateur a observé et vérifié (expérience utilisateur, design, performance)" required></textarea>
        <fieldset class="pilot-fieldset">
          <legend>Fonctionnalités évaluées <span class="muted-sm">(1..N — le verdict se pose ensuite sur chaque fonctionnalité)</span></legend>
          <div id="em-feature-pick"><p class="muted-sm">Aucun projet ouvert — fonctionnalités indisponibles.</p></div>
        </fieldset>
        <fieldset class="pilot-fieldset">
          <legend>Règles métier évaluées <span class="muted-sm">(1..N)</span></legend>
          <div id="em-rule-pick"><p class="muted-sm">Aucun projet ouvert — règles métier indisponibles.</p></div>
        </fieldset>
        <div class="links-editor">
          <div class="links-head"><label class="modal-field" style="margin:0">Pièces <span class="muted-sm">(lien, document, photo, vidéo)</span></label>
          <button type="button" class="ghost" id="em-add-piece">+ Ajouter</button></div>
          <div id="em-pieces-list"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer</button>
        </div>
      </form>
      <div id="eval-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const reposHint = document.getElementById('em-repos-hint');
  const featureBox = document.getElementById('em-feature-pick');
  const ruleBox = document.getElementById('em-rule-pick');
  const renderReposHint = () => {
    const proj = projects.find((p) => p.id === currentProject);
    const repos = (proj && proj.repos) || [];
    reposHint.innerHTML = repos.length
      ? `Repos transverses du projet (portée réelle) : ${repos.map((r) => `<code class="chip-repo">${esc(r.repoId || r)}</code>`).join(' ')}`
      : 'Aucun repo rattaché à ce projet.';
  };
  const loadFeaturesRules = async () => {
    const proj = currentProject;
    if (!proj) { featureBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>'; ruleBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>'; return; }
    featureBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    ruleBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    let features = []; let rules = [];
    try {
      const [fd, rd] = await Promise.all([
        api(`/api/features?projectId=${encodeURIComponent(proj)}`),
        api(`/api/rules?projectId=${encodeURIComponent(proj)}`),
      ]);
      features = (fd && fd.features) || [];
      rules = (rd && rd.rules) || [];
    } catch {}
    const roles = [...new Set([...features.map((x) => x.role).filter(Boolean), ...rules.flatMap((x) => x.roles || [])])].sort();
    featureBox.innerHTML = frSelectorHtml('feature', features, { prefix: 'em-feature-pick', roles, selected: [], projectId: proj, fromRecette: true });
    bindFrSelector('em-feature-pick', { projectId: proj, projectRoles: roles });
    ruleBox.innerHTML = frSelectorHtml('rule', rules, { prefix: 'em-rule-pick', roles, selected: [], projectId: proj, fromRecette: true });
    bindFrSelector('em-rule-pick', { projectId: proj, projectRoles: roles });
  };
  // Chargement AUTOMATIQUE des listes dépendantes du projet ouvert (plus de
  // combo projet : aucun « change » à attendre).
  renderReposHint();
  loadFeaturesRules();

  const piecesList = document.getElementById('em-pieces-list');
  const addPieceRow = () => {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <div class="rd-head">
        <select class="ep-nature">
          <option value="lien">Lien</option>
          <option value="document">Document</option>
          <option value="photo">Photo</option>
          <option value="video">Vidéo</option>
        </select>
        <input class="ep-title" placeholder="titre (optionnel)">
        <button type="button" class="ghost ep-del" title="Retirer">✕</button>
      </div>
      <select class="ep-mode">
        <option value="link">Lien (URL)</option>
        <option value="import">Importer un fichier</option>
        <option value="artifact">Lier un artefact</option>
      </select>
      <input class="ep-url" placeholder="https://… (mode lien)">
      <input class="ep-file" type="file" hidden>
      <select class="ep-art" hidden><option value="">— artefact existant —</option>${allArtifacts.map((a) => `<option value="${esc(a.artifact_id)}">${esc((a.title || a.path).slice(0, 60))}</option>`).join('')}</select>`;
    const modeSel = row.querySelector('.ep-mode');
    const urlEl = row.querySelector('.ep-url');
    const fileEl = row.querySelector('.ep-file');
    const artEl = row.querySelector('.ep-art');
    const sync = () => {
      const m = modeSel.value;
      urlEl.hidden = m !== 'link';
      fileEl.hidden = m !== 'import';
      artEl.hidden = m !== 'artifact';
    };
    modeSel.addEventListener('change', sync);
    sync();
    row.querySelector('.ep-del').addEventListener('click', () => row.remove());
    piecesList.appendChild(row);
  };
  document.getElementById('em-add-piece').addEventListener('click', addPieceRow);

  // Sans projet ouvert : création DÉSACTIVÉE + message explicite (aucun combo de
  // secours — le projet de création est le projet ouvert).
  applyNoProjectGuard('eval-modal-form', 'eval-modal-msg');

  document.getElementById('eval-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    const msg = document.getElementById('eval-modal-msg');
    try {
      const proj = currentProject;
      if (!proj) throw new Error('Aucun projet ouvert.');
      const documents = [];
      for (const row of piecesList.querySelectorAll('.link-row')) {
        const mode = row.querySelector('.ep-mode').value;
        const nature = row.querySelector('.ep-nature').value;
        const title = row.querySelector('.ep-title').value.trim() || undefined;
        if (mode === 'link') {
          const url = row.querySelector('.ep-url').value.trim();
          if (url) documents.push({ mode: 'link', url, nature, title });
        } else if (mode === 'import') {
          const f = row.querySelector('.ep-file').files[0];
          if (f) {
            const buf = await f.arrayBuffer();
            documents.push({ mode: 'import', filename: f.name, dataBase64: arrayBufferToBase64(buf), nature, title });
          }
        } else {
          const art = row.querySelector('.ep-art').value;
          if (art) documents.push({ mode: 'artifact', artifactId: art, nature, title });
        }
      }
      await api(recettesApiBase(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: proj,
        title: document.getElementById('em-title').value.trim(),
        description: document.getElementById('em-description').value.trim() || undefined,
        featureIds: selectedFrIds('feature', 'em-feature-pick'),
        ruleIds: selectedFrIds('rule', 'em-rule-pick'),
        documents,
        organizationId: currentOrg || undefined,
      }) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Modale de DÉTAIL : éléments + verdicts fonctionnalités + règles + pièces.
async function recetteDetailModal(recetteId) {
  let d;
  try { d = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const ev = d.recette || {};
  const editable = ev.status !== 'done';
  // Écritures : l'évaluateur (propriétaire) et l'admin ; l'exécuteur ET le
  // superviseur sont en LECTURE SEULE (ADR-002) — leurs POST seraient refusés
  // côté serveur (garde `isReadOnly`).
  const canWrite = editable && !IS_EXECUTEUR && !IS_SUPERVISOR;
  const items = ev.items || [];
  const feats = ev.fonctionnalites || [];
  const rules = ev.regles || [];
  // Tests E2E du projet (ADR-003) : depuis une recette évaluateur, on peut
  // EXÉCUTER un test et lire ses preuves (détail, vidéos, rapport). Le test
  // reste en lecture seule — seul le marquage « incohérent » est ouvert.
  let projectTests = [];
  try {
    const td = await api(`/api/e2e-tests?project=${encodeURIComponent(ev.project || '')}`);
    projectTests = (td && td.tests) || [];
  } catch {}
  // Rattachement / création d'une fonctionnalité ou règle manquante : ADMIN
  // uniquement (ADR-001 — « création administrateur si manquant, marquée
  // émergente »). On liste les éléments du projet non encore rattachés.
  const canLink = IS_ADMIN && editable;
  let projFeatures = [];
  let projRules = [];
  if (canLink) {
    try {
      const [fd, rd] = await Promise.all([
        api(`/api/features?projectId=${encodeURIComponent(ev.project || '')}`),
        api(`/api/rules?projectId=${encodeURIComponent(ev.project || '')}`),
      ]);
      projFeatures = (fd && fd.features) || [];
      projRules = (rd && rd.rules) || [];
    } catch {}
  }
  const attachableFeatures = projFeatures.filter((f) => !feats.some((x) => x.id === f.id));
  const attachableRules = projRules.filter((r) => !rules.some((x) => x.id === r.id));
  // Pièces rattachées à un élément précis (`document.itemId`).
  const docsByItem = new Map();
  for (const doc of (ev.documents || [])) {
    if (doc.itemId === null || doc.itemId === undefined) continue;
    const k = Number(doc.itemId);
    if (!docsByItem.has(k)) docsByItem.set(k, []);
    docsByItem.get(k).push(doc);
  }
  const verdictOptions = (cur) => ['', 'conforme', 'non_conforme', 'a_ameliorer'].map((v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${v ? esc(EVAL_VERDICT_LABELS[v]) : '— verdict —'}</option>`).join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>Détail de la recette</h2>
      <p class="muted">${esc(ev.title || recetteId)} — <code>${esc(ev.project || '')}</code> ${recetteStatusBadge(ev.status)}</p>
      ${ev.description ? `<div class="eval-block"><span class="lbl">Parcours évalué</span><div class="muted-sm" style="white-space:pre-wrap">${esc(ev.description)}</div></div>` : ''}
      <h3>Éléments <span class="muted-sm">(recommandations / problèmes)</span></h3>
      <div class="recette-list" id="eval-items-list">
        ${items.map((it) => {
          const repris = (it.reprisPar || []).map((x) => `<span class="badge awaiting" title="Repris par le cadrage ${esc(x.cadrageId)}${x.takenBy ? ` (${esc(x.takenBy)})` : ''}">repris par ${esc(x.title || x.cadrageId)}</span>`).join(' ');
          const pieces = docsByItem.get(Number(it.itemId)) || [];
          const pieceLine = pieces.length ? `<div class="muted-sm eval-item-pieces">${pieces.map((doc) => `<span>${evalNatureIcon(doc.nature)} ${esc(doc.title || (doc.path || '').split('/').pop())}</span>`).join(' · ')}</div>` : '';
          const decideBtns = IS_ADMIN ? `<button class="ghost" data-eval-item-decide="${it.itemId}" data-decision="a_traiter" title="Marquer « à traiter » (visible par l'exécuteur)">À traiter</button><button class="ghost" data-eval-item-decide="${it.itemId}" data-decision="non_retenu" title="Marquer « non retenu »">Non retenu</button>` : '';
          return `<div class="recette-item eval-item">
          ${evalCategoryBadge(it.category)} ${evalSeverityBadge(it.severity)} ${evalDecisionBadge(it.decision)}
          <span class="eval-item-content">${esc(it.content)}</span>
          <span class="badge ${it.status === 'treated' ? 'done' : it.status === 'dismissed' ? 'queued' : 'in_progress'}">${esc(EVAL_ITEM_STATUS_LABELS[it.status] || it.status)}</span>
          ${repris}
          ${decideBtns}
          ${canWrite ? `<button class="ghost" data-eval-item-piece="${it.itemId}" title="Joindre une pièce à cet élément">+ pièce</button>` : ''}
          ${canWrite ? `<button class="ghost" data-eval-item-edit="${it.itemId}">Éditer</button><button class="danger" data-eval-item-del="${it.itemId}">Retirer</button>` : ''}
          ${pieceLine}
        </div>`;
        }).join('') || '<p class="muted-sm">Aucun élément.</p>'}
      </div>
      ${canWrite ? '<div class="actions-buttons"><button class="launch-btn" id="eval-item-add">+ Ajouter un élément</button></div>' : ''}
      <h3>Verdicts par fonctionnalité</h3>
      <div class="recette-list">
        ${feats.map((f) => `<div class="recette-item eval-verdict-row">
          <span class="adr-pick-head"><strong>${esc(f.ref || f.id)}</strong> ${f.role ? `<span class="badge">${esc(f.role)}</span>` : ''}</span>
          <span class="muted-sm">${esc((f.userStory || '').slice(0, 90))}</span>
          ${canWrite
            ? `<select class="eval-verdict-sel" data-eval-verdict="${esc(f.id)}">${verdictOptions(f.verdict)}</select>`
            : evalVerdictBadge(f.verdict)}
        </div>`).join('') || '<p class="muted-sm">Aucune fonctionnalité rattachée.</p>'}
      </div>
      ${canLink ? `<div class="rec-tasks-add">
        <select id="eval-attach-feature"><option value="">+ Rattacher une fonctionnalité existante…</option>${attachableFeatures.map((f) => `<option value="${esc(f.id)}">${esc(f.ref || f.id)} — ${esc((f.userStory || '').slice(0, 60))}</option>`).join('')}</select>
        <button type="button" class="ghost" data-eval-create="feature" title="Créer une fonctionnalité manquante (marquée émergente, rattachée à la recette)">＋ Créer une fonctionnalité manquante</button>
      </div>` : ''}
      <h3>Règles métier évaluées</h3>
      <div class="recette-list">
        ${rules.map((r) => `<div class="recette-item"><strong>${esc(r.ref || r.id)}</strong> <span class="muted-sm">${esc((r.content || '').slice(0, 120))}</span></div>`).join('') || '<p class="muted-sm">Aucune règle métier rattachée.</p>'}
      </div>
      ${canLink ? `<div class="rec-tasks-add">
        <select id="eval-attach-rule"><option value="">+ Rattacher une règle métier existante…</option>${attachableRules.map((r) => `<option value="${esc(r.id)}">${esc(r.ref || r.id)} — ${esc((r.content || '').slice(0, 60))}</option>`).join('')}</select>
        <button type="button" class="ghost" data-eval-create="rule" title="Créer une règle métier manquante (marquée émergente, rattachée à la recette)">＋ Créer une règle métier manquante</button>
      </div>` : ''}
      <h3>Pièces</h3>
      <div class="recette-list">
        ${(ev.documents || []).map((doc) => `<div class="recette-item">
          <code class="muted-sm">${evalNatureIcon(doc.nature)}</code>
          <span><strong>${esc(doc.title || (doc.path || '').split('/').pop())}</strong></span>
          ${doc.nature ? `<span class="muted-sm">${esc(doc.nature)}</span>` : ''}
          ${evalDocDetailsHtml(doc)}
        </div>`).join('') || '<p class="muted-sm">Aucune pièce rattachée.</p>'}
      </div>
      <h3>Tests E2E du projet</h3>
      <p class="muted-sm">Exécutez un test E2E et consultez ses preuves (détails, vidéos, rapport) — preuve du comportement réel. Vous ne modifiez pas le test : seul le statut <strong>incohérent</strong> vous est ouvert.</p>
      <div class="recette-list">
        ${projectTests.length ? projectTests.map((t) => `<div class="recette-item">
          ${e2eTestStatusBadge(t.status)}
          <span><strong>${esc(t.title || t.scenario || t.e2eTestId)}</strong></span>
          <span class="muted-sm">${esc(t.specFile || '')}</span>
          <button class="ghost" data-e2e-detail="${esc(t.e2eTestId)}" title="Voir le détail (exécutions, vidéos, rapport)">Détail</button>
          ${!IS_SUPERVISOR ? `<button class="ghost" data-e2e-run="${esc(t.e2eTestId)}" title="Lancer une exécution du test (tel qu'enregistré)">▶ Lancer</button>` : ''}
          ${(IS_EVALUATEUR || IS_ADMIN) ? `<button class="ghost danger-btn" data-e2e-incoherent="${esc(t.e2eTestId)}" title="Marquer le test « incohérent » (comportement réel ≠ scénario)">⚠ Incohérent</button>` : ''}
        </div>`).join('') : '<p class="muted-sm">Aucun test E2E pour ce projet.</p>'}
      </div>
      ${canWrite ? `
      <h3>Tests standard (parcours + stress routes API)</h3>
      <p class="muted-sm">Parcours de pages avec informations réseau (durées/requêtes/types/tailles, compression), capture des <strong>erreurs console</strong> (warnings, exceptions JS) et <strong>réseau</strong> (4xx/5xx, DNS, timeouts), Core Web Vitals (LCP/INP/CLS, long tasks) et <strong>stress test des routes d'API</strong> (accès parallèles bornés : débit, latence p95/p99, taux d'erreurs). Distinct des tests E2E, qui se lancent depuis la page <strong>Tests E2E</strong>.</p>
      <form id="eval-perf-form" class="pilot-form">
        <input id="epf-url" placeholder="https://preprod.exemple.fr (URL cible / 1re page)" required>
        <input id="epf-pages" placeholder="autres pages du parcours (URLs séparées par des virgules) — optionnel">
        <input id="epf-routes" placeholder="routes d'API à stresser (ex. /api/health, /api/users — séparées par des virgules) — optionnel">
        <input id="epf-repo" placeholder="checkout applicatif avec Playwright (ex. /root/mada-talk-preprod) — optionnel">
        <div class="perf-options">
          <label class="muted-sm">Concurrence <input id="epf-conc" type="number" min="1" max="10" value="5"></label>
          <label class="muted-sm">Requêtes <input id="epf-req" type="number" min="1" max="200" value="50"></label>
        </div>
        <div class="modal-actions"><button type="submit" class="launch-btn">Lancer les tests standard</button></div>
      </form>
      <div id="epf-msg" class="msg"></div>
      <div id="epf-result" class="muted-sm"></div>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  // ADMIN : rattacher un élément EXISTANT (POST /api/links) ou en CRÉER un
  // manquant (marqué émergent d'origine `cadrage`) puis le rattacher aussitôt.
  if (canLink) {
    const linkToEval = async (kind, targetId) => {
      if (!targetId) { recetteDetailModal(recetteId); return; }
      try {
        await api('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kind === 'rule' ? 'recette_rule' : 'recette_feature', a: recetteId, b: targetId }) });
      } catch (e) { alert('Rattachement impossible : ' + (e.message || e)); }
      recetteDetailModal(recetteId);
    };
    const attachF = document.getElementById('eval-attach-feature');
    if (attachF) attachF.addEventListener('change', () => linkToEval('feature', attachF.value));
    const attachR = document.getElementById('eval-attach-rule');
    if (attachR) attachR.addEventListener('change', () => linkToEval('rule', attachR.value));
    document.querySelectorAll('#modal-backdrop [data-eval-create]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.evalCreate === 'rule' ? 'rule' : 'feature';
      const onSaved = async (created) => {
        const ent = kind === 'rule' ? (created && created.rule) : (created && created.feature);
        await linkToEval(kind, ent && ent.id);
      };
      if (kind === 'rule') ruleFormModal(null, [], onSaved, [], { projectId: ev.project, fromRecette: true });
      else featureFormModal(null, [], onSaved, { projectId: ev.project, fromRecette: true });
    }));
  }
  // Tests E2E du projet (ADR-003) : exécuter / lire les preuves depuis la recette.
  document.querySelectorAll('#modal-backdrop [data-e2e-detail]').forEach((b) => b.addEventListener('click', () => e2eDetailModal(b.dataset.e2eDetail)));
  document.querySelectorAll('#modal-backdrop [data-e2e-run]').forEach((b) => b.addEventListener('click', () => e2eRunModal(b.dataset.e2eRun)));
  document.querySelectorAll('#modal-backdrop [data-e2e-incoherent]').forEach((b) => b.addEventListener('click', () => e2eIncoherentModal(b.dataset.e2eIncoherent, () => recetteDetailModal(recetteId))));
  const addBtn = document.getElementById('eval-item-add');
  if (addBtn) addBtn.onclick = () => recetteItemModal(recetteId, null);
  document.querySelectorAll('#modal-backdrop [data-eval-item-edit]').forEach((b) => b.addEventListener('click', () => {
    const it = items.find((x) => String(x.itemId) === String(b.dataset.evalItemEdit));
    recetteItemModal(recetteId, it);
  }));
  document.querySelectorAll('#modal-backdrop [data-eval-item-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Retirer cet élément ?')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try { await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/items/${b.dataset.evalItemDel}`, { method: 'DELETE' }); recetteDetailModal(recetteId); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec : ' + (e.message || e));
    }
  }));
  // Décision ADMIN (« à traiter » / « non retenu ») — route admin-only côté serveur.
  document.querySelectorAll('#modal-backdrop [data-eval-item-decide]').forEach((b) => b.addEventListener('click', async () => {
    const original = b.innerHTML;
    setBtnBusy(b, 'Décision');
    try {
      await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/items/${b.dataset.evalItemDecide}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: b.dataset.decision }) });
      recetteDetailModal(recetteId);
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec de la décision : ' + (e.message || e));
    }
  }));
  // Pièces portées par un élément (`itemId`).
  document.querySelectorAll('#modal-backdrop [data-eval-item-piece]').forEach((b) => b.addEventListener('click', () => recetteItemPieceModal(recetteId, Number(b.dataset.evalItemPiece))));
  document.querySelectorAll('#modal-backdrop [data-eval-verdict]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/verdicts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fonctionnaliteId: sel.dataset.evalVerdict, verdict: sel.value || null }) });
    } catch (e) { alert('Échec du verdict : ' + (e.message || e)); }
  }));
  // TESTS STANDARD (préprod) : POST asynchrone → suivi du job jusqu'au
  // rapport rattaché à la recette (pièce `performance`).
  const perfForm = document.getElementById('eval-perf-form');
  if (perfForm) perfForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    const msg = document.getElementById('epf-msg');
    const out = document.getElementById('epf-result');
    msg.textContent = ''; msg.className = 'msg';
    const targetUrl = document.getElementById('epf-url').value.trim();
    if (!targetUrl) { msg.textContent = 'URL préprod requise'; msg.className = 'msg error'; return; }
    setBtnBusy(btn, 'Tests en cours');
    const pages = document.getElementById('epf-pages').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const routes = document.getElementById('epf-routes').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      const r = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/perf-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          pages: pages.length ? pages : undefined,
          routes: routes.length ? routes : undefined,
          repoDir: document.getElementById('epf-repo').value.trim() || undefined,
          concurrency: Number(document.getElementById('epf-conc').value) || undefined,
          requests: Number(document.getElementById('epf-req').value) || undefined,
        }),
      });
      msg.textContent = `Tests standard lancés (job ${r.jobId})…`;
      out.textContent = 'En cours — parcours + capture erreurs + stress. Cela peut prendre plusieurs minutes.';
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      pollRecettePerfJob(recetteId, r.jobId, out, msg);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Modale AJOUT / ÉDITION d'un élément (recommandation | problème).
function recetteItemModal(recetteId, item) {
  const isEdit = !!(item && item.itemId);
  const cat = (item && item.category) || 'recommandation';
  const sev = (item && item.severity) || 'medium';
  const status = (item && item.status) || 'open';
  showModal(`
    <div class="modal">
      <h2>${isEdit ? 'Éditer l\'élément' : 'Nouvel élément'}</h2>
      <form id="eval-item-form" class="pilot-form">
        <label class="modal-field">Catégorie
          <select id="ei-category">
            ${['recommandation', 'probleme'].map((c) => `<option value="${c}" ${cat === c ? 'selected' : ''}>${esc(EVAL_CATEGORY_LABELS[c])}</option>`).join('')}
          </select>
        </label>
        <label class="modal-field">Sévérité
          <select id="ei-severity">
            ${['low', 'medium', 'high', 'critical'].map((s) => `<option value="${s}" ${sev === s ? 'selected' : ''}>${esc(EVAL_SEVERITY_LABELS[s])}</option>`).join('')}
          </select>
        </label>
        <textarea id="ei-content" class="modal-textarea" placeholder="la recommandation ou le problème observé" required>${esc((item && item.content) || '')}</textarea>
        <textarea id="ei-discussion" class="modal-textarea" rows="2" placeholder="échanges / précisions (optionnel)">${esc((item && item.discussion) || '')}</textarea>
        ${isEdit ? `<label class="modal-field">Statut de suivi
          <select id="ei-status">${['open', 'treated', 'dismissed'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${esc(EVAL_ITEM_STATUS_LABELS[s])}</option>`).join('')}</select>
        </label>` : ''}
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">${isEdit ? 'Enregistrer' : 'Ajouter'}</button>
        </div>
      </form>
      <div id="eval-item-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('eval-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, isEdit ? 'Enregistrement' : 'Ajout');
    const msg = document.getElementById('eval-item-msg');
    try {
      const body = {
        category: document.getElementById('ei-category').value,
        severity: document.getElementById('ei-severity').value,
        content: document.getElementById('ei-content').value.trim(),
        discussion: document.getElementById('ei-discussion').value.trim() || undefined,
      };
      if (isEdit) {
        body.status = document.getElementById('ei-status').value;
        await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/items/${item.itemId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      recetteDetailModal(recetteId);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Modale PIÈCES d'un ÉLÉMENT : liste + ajout (lien / document / photo / vidéo).
// La pièce est rattachée à l'élément via `itemId` (contrat `recette_doc_add`).
async function recetteItemPieceModal(recetteId, itemId) {
  let d;
  try { d = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const ev = d.recette || {};
  const item = (ev.items || []).find((x) => Number(x.itemId) === Number(itemId)) || {};
  const pieces = (ev.documents || []).filter((doc) => Number(doc.itemId) === Number(itemId));
  // Lecture seule stricte du superviseur (ADR-002) : ni ajout ni retrait de pièce.
  const canEdit = ev.status !== 'done' && !IS_SUPERVISOR;
  let allArtifacts = [];
  try { allArtifacts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  showModal(`
    <div class="modal modal-wide">
      <h2>Pièces de l'élément</h2>
      <p class="muted">${evalCategoryBadge(item.category)} ${evalSeverityBadge(item.severity)} ${esc(item.content || '')}</p>
      <div class="recette-list">
        ${pieces.map((doc) => `<div class="recette-item">
          <code class="muted-sm">${evalNatureIcon(doc.nature)}</code>
          <span><strong>${esc(doc.title || (doc.path || '').split('/').pop())}</strong></span>
          ${doc.nature ? `<span class="muted-sm">${esc(doc.nature)}</span>` : ''}
          ${evalDocDetailsHtml(doc)}
          ${canEdit ? `<button class="danger" data-eval-item-doc-del="${esc(doc.documentId || doc.id)}">Retirer</button>` : ''}
        </div>`).join('') || '<p class="muted-sm">Aucune pièce rattachée à cet élément.</p>'}
      </div>
      ${canEdit ? `<form id="eval-item-piece-form" class="pilot-form">
        <div class="links-head"><label class="modal-field" style="margin:0">Ajouter une pièce à cet élément</label></div>
        <select id="eip-nature">
          <option value="lien">Lien</option>
          <option value="document">Document</option>
          <option value="photo">Photo</option>
          <option value="video">Vidéo</option>
        </select>
        <input id="eip-title" placeholder="titre (optionnel)">
        <select id="eip-mode">
          <option value="link">Lien (URL)</option>
          <option value="import">Importer un fichier</option>
          <option value="artifact">Lier un artefact</option>
        </select>
        <input id="eip-url" placeholder="https://… (mode lien)">
        <input id="eip-file" type="file" hidden>
        <select id="eip-art" hidden><option value="">— artefact existant —</option>${allArtifacts.map((a) => `<option value="${esc(a.artifact_id)}">${esc((a.title || a.path).slice(0, 60))}</option>`).join('')}</select>
        <div class="modal-actions"><button type="submit" class="launch-btn">Ajouter</button></div>
      </form>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
      <div id="eval-item-piece-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeSel = document.getElementById('eip-mode');
  if (modeSel) {
    const sync = () => {
      const m = modeSel.value;
      document.getElementById('eip-url').hidden = m !== 'link';
      document.getElementById('eip-file').hidden = m !== 'import';
      document.getElementById('eip-art').hidden = m !== 'artifact';
    };
    modeSel.addEventListener('change', sync); sync();
  }
  document.querySelectorAll('#modal-backdrop [data-eval-item-doc-del]').forEach((b) => b.addEventListener('click', async () => {
    const original = b.innerHTML;
    setBtnBusy(b, 'Retrait');
    try { await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/documents/${b.dataset.evalItemDocDel}`, { method: 'DELETE' }); recetteItemPieceModal(recetteId, itemId); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec : ' + (e.message || e));
    }
  }));
  const itemPieceForm = document.getElementById('eval-item-piece-form');
  if (itemPieceForm) itemPieceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Ajout');
    const msg = document.getElementById('eval-item-piece-msg');
    try {
      const mode = modeSel.value;
      const body = { mode, nature: document.getElementById('eip-nature').value, title: document.getElementById('eip-title').value.trim() || undefined, itemId: Number(itemId) };
      if (mode === 'link') {
        body.url = document.getElementById('eip-url').value.trim();
        if (!body.url) throw new Error('URL requise');
      } else if (mode === 'import') {
        const f = document.getElementById('eip-file').files[0];
        if (!f) throw new Error('fichier requis');
        const buf = await f.arrayBuffer();
        body.filename = f.name; body.dataBase64 = arrayBufferToBase64(buf);
      } else {
        body.artifactId = document.getElementById('eip-art').value;
        if (!body.artifactId) throw new Error('artefact requis');
      }
      await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      recetteItemPieceModal(recetteId, itemId);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Modale PIÈCES : liste + ajout (lien / document / photo / vidéo).
async function recettePiecesModal(recetteId) {
  let d;
  try { d = await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const ev = d.recette || {};
  // Lecture seule stricte du superviseur (ADR-002) : pas d'ajout ni de retrait.
  const editable = ev.status !== 'done' && !IS_SUPERVISOR;
  let allArtifacts = [];
  try { allArtifacts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  showModal(`
    <div class="modal modal-wide">
      <h2>Pièces de la recette</h2>
      <p class="muted">${esc(ev.title || recetteId)}</p>
      <div class="recette-list">
        ${(ev.documents || []).map((doc) => `<div class="recette-item">
          <code class="muted-sm">${evalNatureIcon(doc.nature)}</code>
          <span><strong>${esc(doc.title || (doc.path || '').split('/').pop())}</strong></span>
          ${doc.nature ? `<span class="muted-sm">${esc(doc.nature)}</span>` : ''}
          ${evalDocDetailsHtml(doc)}
          ${editable ? `<button class="danger" data-eval-doc-del="${esc(doc.documentId || doc.id)}">Retirer</button>` : ''}
        </div>`).join('') || '<p class="muted-sm">Aucune pièce rattachée.</p>'}
      </div>
      ${editable ? `<form id="eval-piece-form" class="pilot-form">
        <div class="links-head"><label class="modal-field" style="margin:0">Ajouter une pièce</label></div>
        <select id="ep2-nature">
          <option value="lien">Lien</option>
          <option value="document">Document</option>
          <option value="photo">Photo</option>
          <option value="video">Vidéo</option>
        </select>
        <input id="ep2-title" placeholder="titre (optionnel)">
        <select id="ep2-mode">
          <option value="link">Lien (URL)</option>
          <option value="import">Importer un fichier</option>
          <option value="artifact">Lier un artefact</option>
        </select>
        <input id="ep2-url" placeholder="https://… (mode lien)">
        <input id="ep2-file" type="file" accept="image/*,video/*,.md,.markdown,.pdf,.docx" hidden>
        <select id="ep2-art" hidden><option value="">— artefact existant —</option>${allArtifacts.map((a) => `<option value="${esc(a.artifact_id)}">${esc((a.title || a.path).slice(0, 60))}</option>`).join('')}</select>
        <div class="modal-actions"><button type="submit" class="launch-btn">Ajouter</button></div>
      </form>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
      <div id="eval-piece-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeSel = document.getElementById('ep2-mode');
  if (modeSel) {
    const sync = () => {
      const m = modeSel.value;
      document.getElementById('ep2-url').hidden = m !== 'link';
      document.getElementById('ep2-file').hidden = m !== 'import';
      document.getElementById('ep2-art').hidden = m !== 'artifact';
    };
    modeSel.addEventListener('change', sync); sync();
  }
  document.querySelectorAll('#modal-backdrop [data-eval-doc-del]').forEach((b) => b.addEventListener('click', async () => {
    const original = b.innerHTML;
    setBtnBusy(b, 'Retrait');
    try { await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/documents/${b.dataset.evalDocDel}`, { method: 'DELETE' }); recettePiecesModal(recetteId); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec : ' + (e.message || e));
    }
  }));
  const form = document.getElementById('eval-piece-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Ajout');
    const msg = document.getElementById('eval-piece-msg');
    try {
      const mode = modeSel.value;
      const body = { mode, nature: document.getElementById('ep2-nature').value, title: document.getElementById('ep2-title').value.trim() || undefined };
      if (mode === 'link') {
        body.url = document.getElementById('ep2-url').value.trim();
        if (!body.url) throw new Error('URL requise');
      } else if (mode === 'import') {
        const f = document.getElementById('ep2-file').files[0];
        if (!f) throw new Error('fichier requis');
        const buf = await f.arrayBuffer();
        body.filename = f.name; body.dataBase64 = arrayBufferToBase64(buf);
      } else {
        body.artifactId = document.getElementById('ep2-art').value;
        if (!body.artifactId) throw new Error('artefact requis');
      }
      await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      recettePiecesModal(recetteId);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Clôture d'une recette évaluateur (aucune tâche créée).
async function recetteFinishConfirm(recetteId, btn) {
  if (!confirm('Terminer cette recette ? (aucune tâche ne sera créée)')) return;
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Clôture');
  try {
    await api(`${recettesApiBase()}/${encodeURIComponent(recetteId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    refreshActive();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Échec : ' + (e.message || e));
  }
}

// --- Batches d'orchestration (v0.9.41) : mode session unique / manuel ---------
function batchCard(b) {
  const modeLabel = b.launchMode === 'session' ? 'Session unique' : b.launchMode === 'manual' ? 'Manuel' : 'Batch';
  const modeBadge = `<span class="badge ${b.launchMode === 'session' ? 'awaiting' : b.launchMode === 'manual' ? 'queued' : 'in_progress'}">${modeLabel}</span>`;
  const canSession = b.launchMode === 'session' || b.launchMode === 'batch';
  return `<article class="project-card">
    <div class="project-card-head"><strong data-batch-detail="${esc(b.batchId)}" style="cursor:pointer" title="Voir le batch">${esc(b.title || b.batchId)}</strong> ${modeBadge} <code class="muted-sm">${esc(b.batchId)}</code></div>
    <div class="project-card-body">
      <div class="project-kv"><span class="lbl">Projet</span><span>${esc(b.project)}</span></div>
      <div class="project-kv"><span class="lbl">Tâches</span><span>${b.tasksCount || 0} · parallélisme max ${b.maxParallel || 2}</span></div>
      ${b.sessionId ? `<div class="project-kv"><span class="lbl">Session</span><span class="muted-sm">${esc(b.sessionId)}</span></div>` : ''}
    </div>
    <div class="project-card-actions">
      ${canSession ? `<button class="launch-btn" data-batch-session="${esc(b.batchId)}" title="${b.sessionId ? 'Reprendre la session d\'orchestration du batch' : 'Lancer la session d\'orchestration unique (pilote toutes les tâches)'}">${b.sessionId ? 'Reprendre la session' : 'Lancer la session d\'orchestration'}</button>` : ''}
      <button class="ghost" data-batch-detail="${esc(b.batchId)}">Détail</button>
    </div>
  </article>`;
}

async function openBatchSession(batchId, btn) {
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Ouverture');
  try {
    const r = await api(`/api/batches/${encodeURIComponent(batchId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: false }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || 'Impossible de lancer la session d\'orchestration du batch.');
    refreshActive();
  } catch (e) {
    if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Échec : ' + (e.message || e));
  }
}

async function batchDetailModal(batchId) {
  let d;
  try { d = await api(`/api/batches/${encodeURIComponent(batchId)}`); } catch (e) { alert('Erreur : ' + (e.message || e)); return; }
  const b = d.batch || {};
  const modeLabel = { session: 'Session unique', manual: 'Manuel', batch: 'Batch' }[b.launchMode] || b.launchMode;
  const rd = b.readiness || [];
  const row = (r) => {
    const deps = (r.unsatisfiedDeps || []).length ? ` · ⛔ attend : ${r.unsatisfiedDeps.join(', ')}` : '';
    const blocked = (r.blockedSteps || []).length ? ` · 🔒 étapes bloquées : ${r.blockedSteps.length}` : '';
    return `<div class="recette-item"><code class="chip-project">${esc(r.done ? 'done' : r.active ? 'en cours' : '—')}</code><code class="muted-sm">${esc(r.taskId)}</code>${deps}${blocked}${r.ready && !r.active ? ' · ✅ prête' : ''}</div>`;
  };
  showModal(`
    <div class="modal modal-wide">
      <h2>Batch ${esc(b.title || batchId)}</h2>
      <p class="muted">${badge(b.status)} · ${modeLabel} · projet ${esc(b.project)} · parallélisme max ${b.maxParallel || 2}${b.sessionId ? ` · session ${esc(b.sessionId)}` : ''}</p>
      <div class="actions-section"><h3>Readiness (${rd.length})</h3><div class="recette-list">${rd.map(row).join('') || '<p class="muted-sm">Aucune tâche.</p>'}</div></div>
      ${b.conflictMatrix && b.conflictMatrix.length ? `<div class="actions-section"><h3>Conflits fichiers (${b.conflictMatrix.length})</h3><div class="recette-list">${b.conflictMatrix.map((c) => `<div class="recette-item"><code class="muted-sm">${esc(c.taskA)}</code> ↔ <code class="muted-sm">${esc(c.taskB)}</code><span class="muted-sm">${(c.stepConflicts || []).length} étape(s) en conflit</span></div>`).join('')}</div></div>` : ''}
      <div class="modal-actions">
        ${b.launchMode !== 'manual' && b.status === 'active' ? `<button class="launch-btn" id="batch-modal-session">${b.sessionId ? 'Reprendre la session' : 'Lancer la session d\'orchestration'}</button>` : ''}
        <button class="ghost" id="modal-cancel">Fermer</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const btn = document.getElementById('batch-modal-session');
  if (btn) btn.onclick = async () => {
    closeModal();
    await openBatchSession(batchId);
  };
}

// Détail d'un cadrage en modale (titre court + description longue + périmètre).
async function cadrageDetailModal(cadrageId) {
  const T = cadrageTerms();
  let d;
  try { d = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`); } catch (e) { alert(`Impossible de charger ${T.theEntity} : ` + (e.message || e)); return; }
  const rec = d.cadrage || {};
  const tasks = rec.tasks || [];
  const items = rec.items || [];
  const project = rec.project || '';
  // Fonctionnalités / règles métier rattachées au cadrage (ADR-001), exposées par
  // GET /api/cadrages/:id (B006). L'émergence est affichée (origine `cadrage`).
  const recFeatures = rec.fonctionnalites || [];
  const recRules = rec.regles || [];
  // A004 — ADR de ce cadrage + tâches générées depuis les éléments, exposées par
  // GET /api/cadrages/:id (A001/A002). Lecture additive : aucune écriture.
  const recAdrs = rec.adrs || [];
  const genTasks = rec.generatedTasks || [];
  // Écritures du cadrage : masquées au superviseur (lecture seule stricte, ADR-002)
  // — le contenu de LECTURE reste affiché.
  const canEditRec = rec.status !== 'done' && !IS_SUPERVISOR;
  // Rattachement / création d'un élément manquant : ADMIN uniquement (ADR-001).
  const canLinkRec = IS_ADMIN && canEditRec;
  let projFeaturesRec = [];
  let projRulesRec = [];
  if (canLinkRec) {
    try {
      const [fd, rd] = await Promise.all([
        api(`/api/features?projectId=${encodeURIComponent(project)}`),
        api(`/api/rules?projectId=${encodeURIComponent(project)}`),
      ]);
      projFeaturesRec = (fd && fd.features) || [];
      projRulesRec = (rd && rd.rules) || [];
    } catch {}
  }
  showModal(`
    <div class="modal modal-wide" id="cadrage-detail-modal">
      <div class="finish-head"><h2>${esc(rec.title || cadrageId)}</h2>
        <button class="ghost" id="cadrage-detail-fullscreen" title="Plein écran">⛶</button></div>
      <p class="muted">${badge(rec.status)} · ${cadrageScopeChips(rec)}${rec.confirmed_at ? ` · confirmée ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${rec.description ? `<p class="modal-request">${esc(rec.description)}</p>` : ''}
      ${tasks.length ? `<div class="actions-section"><h3>Tâches couvertes (${tasks.length})</h3><div class="recette-list">${tasks.map((t) => {
        const tid = (t && typeof t === 'object') ? (t.taskId || t.task_id || '') : (t || '');
        const ttl = (t && typeof t === 'object') ? (t.title || '') : '';
        const req = (t && typeof t === 'object') ? (t.request || '') : '';
        const tproj = (t && typeof t === 'object') ? (t.project || '') : '';
        return `<div class="recette-item"><code class="muted-sm">${esc(tid)}</code><div class="recette-task">${tproj ? `<code class="chip-project">${esc(tproj)}</code>` : ''}<strong>${esc(ttl)}</strong>${req ? `<p class="muted-sm">${esc(req)}</p>` : ''}</div>${canEditRec ? `<button type="button" class="ghost rec-task-del" data-rec-task-del="${esc(tid)}" title="Détacher cette tâche (elle reste intacte)">✕ retirer</button>` : ''}</div>`;
      }).join('')}</div>${canEditRec ? `<div class="rec-tasks-add"><select id="rec-task-add"><option value="">+ Ajouter une tâche couverte…</option></select></div>` : ''}</div></div>` : `<p class="muted-sm">Aucune tâche couverte (${T.entityLower} exploratoire).</p>`}
      ${items.length ? `<div class="actions-section"><h3>${T.elementsCap} (${items.length})</h3><div class="recette-list">${items.map((it) => `<div class="recette-item"><span class="badge ${CADRAGE_CLS_BADGE[it.classification] || 'queued'}">${CADRAGE_CLS_LABEL[it.classification] || it.classification}</span>${it.project ? `<code class="chip-project">${esc(it.project)}</code>` : ''}${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution">ordre ${esc(it.execOrder)}</span>` : ''}${testIntentBadge(it)}${docIntentBadge(it)}${it.vigilance ? `<span class="badge danger" title="${esc(it.vigilance)}">⚠ vigilance</span>` : ''}<span>${esc(it.title || it.content.slice(0, 80))}</span>${canEditRec && it.status !== 'task_created' ? `<button type="button" class="ghost rec-item-del" data-rec-item-del="${it.id}" title="Retirer cet élément (fusion/consolidation)">✕</button>` : ''}</div>`).join('')}</div></div>` : ''}
      ${(IS_EXECUTEUR || IS_ADMIN || IS_SUPERVISOR) ? `<div class="actions-section"><h3>Éléments évaluateur à traiter</h3><div class="recette-list">${(rec.recetteItems || []).map((it) => `<div class="recette-item">${evalCategoryBadge(it.category)} ${evalSeverityBadge(it.severity)}<span>${esc(it.content)}</span><span class="muted-sm">repris par ce cadrage</span>${canEditRec ? `<button type="button" class="ghost rec-eval-item-del" data-rec-eval-item-del="${it.itemId}" title="Retirer la reprise (l'élément reste « à traiter »)">✕ retirer</button>` : ''}</div>`).join('') || '<p class="muted-sm">Aucun élément évaluateur repris dans ce cadrage.</p>'}</div>${canEditRec ? `<div class="rec-tasks-add"><select id="rec-eval-item-add"><option value="">+ Reprendre un élément « à traiter »…</option></select></div>` : ''}</div>` : ''}
      <div class="actions-section"><h3>Fonctionnalités &amp; règles métier rattachées</h3>
        <div class="recette-list">
          ${recFeatures.map((f) => `<div class="recette-item"><code class="chip">${esc(f.ref || f.id)}</code>${f.emergent ? ` <span class="chip" title="Créé depuis ${T.theEntity} — marqué émergent">émergent</span>` : ''}<span>${esc((f.userStory || '').slice(0, 90))}</span></div>`).join('') || '<p class="muted-sm">Aucune fonctionnalité rattachée.</p>'}
        </div>
        <div class="recette-list">
          ${recRules.map((r) => `<div class="recette-item"><code class="chip">${esc(r.ref || r.id)}</code>${r.emergent ? ` <span class="chip" title="Créée depuis ${T.theEntity} — marquée émergente">émergent</span>` : ''}<span class="muted-sm">${esc((r.content || '').slice(0, 120))}</span></div>`).join('') || '<p class="muted-sm">Aucune règle métier rattachée.</p>'}
        </div>
        ${canLinkRec ? `<div class="rec-tasks-add">
          <select id="rec-attach-feature"><option value="">+ Rattacher une fonctionnalité existante…</option>${projFeaturesRec.filter((f) => !recFeatures.some((x) => x.id === f.id)).map((f) => `<option value="${esc(f.id)}">${esc(f.ref || f.id)} — ${esc((f.userStory || '').slice(0, 60))}</option>`).join('')}</select>
          <button type="button" class="ghost" data-rec-create="feature" title="Créer une fonctionnalité manquante (marquée émergente, rattachée à ce cadrage)">＋ Créer une fonctionnalité manquante</button>
        </div>
        <div class="rec-tasks-add">
          <select id="rec-attach-rule"><option value="">+ Rattacher une règle métier existante…</option>${projRulesRec.filter((r) => !recRules.some((x) => x.id === r.id)).map((r) => `<option value="${esc(r.id)}">${esc(r.ref || r.id)} — ${esc((r.content || '').slice(0, 60))}</option>`).join('')}</select>
          <button type="button" class="ghost" data-rec-create="rule" title="Créer une règle métier manquante (marquée émergente, rattachée à ce cadrage)">＋ Créer une règle métier manquante</button>
        </div>` : ''}
      </div>
      <div class="actions-section"><h3>ADR de ce cadrage (${recAdrs.length})</h3>
        <div class="recette-list">
          ${recAdrs.length ? recAdrs.map((a) => `<div class="recette-item">${adrStatusBadge(a.status)}<code class="muted-sm">${esc(a.adrId)}</code><span>${esc(a.title || a.path || a.adrId)}</span><button type="button" class="ghost tiny" data-cadr-adr-view="${esc(a.adrId)}" title="Voir le contenu de l'ADR">Regarder</button></div>`).join('') : '<p class="muted-sm">Aucune ADR rattachée à ce cadrage.</p>'}
        </div>
      </div>
      <div class="actions-section"><h3>Tâches générées depuis les éléments (${genTasks.length})</h3>
        <div class="recette-list">
          ${genTasks.length ? genTasks.map((g) => `<div class="recette-item">${badge(g.status || 'queued')}<code class="muted-sm">${esc(g.taskId)}</code>${g.project ? `<code class="chip-project">${esc(g.project)}</code>` : ''}<span>${esc(g.title || g.itemTitle || g.taskId)}</span></div>`).join('') : '<p class="muted-sm">Aucune tâche générée depuis les éléments de ce cadrage.</p>'}
        </div>
      </div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  // A007 — « Regarder » d'une ADR du cadrage → modale de lecture du contenu
  // (motif `data-*-view` + `viewRefDoc`, réutilisé tel quel — non modifié ici).
  document.querySelectorAll('#cadrage-detail-modal [data-cadr-adr-view]').forEach((b) => b.addEventListener('click', () => viewRefDoc(b.getAttribute('data-cadr-adr-view'))));
  document.getElementById('cadrage-detail-fullscreen').onclick = () => {
    const fs = document.getElementById('cadrage-detail-modal').classList.toggle('modal-full');
    document.getElementById('cadrage-detail-fullscreen').textContent = fs ? '⤢ rétrécir' : '⛶ plein écran';
  };
  // ADMIN : rattacher un élément EXISTANT (POST /api/links) ou en CRÉER un
  // manquant (émergent origine `cadrage`) puis le rattacher aussitôt.
  if (canLinkRec) {
    const linkToRec = async (kind, targetId) => {
      if (!targetId) { closeModal(); cadrageDetailModal(cadrageId); return; }
      try {
        await api('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kind === 'rule' ? 'cadrage_rule' : 'cadrage_feature', a: cadrageId, b: targetId }) });
      } catch (e) { alert('Rattachement impossible : ' + (e.message || e)); }
      closeModal(); cadrageDetailModal(cadrageId);
    };
    const aF = document.getElementById('rec-attach-feature');
    if (aF) aF.addEventListener('change', () => linkToRec('feature', aF.value));
    const aR = document.getElementById('rec-attach-rule');
    if (aR) aR.addEventListener('change', () => linkToRec('rule', aR.value));
    document.querySelectorAll('#modal-backdrop [data-rec-create]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.recCreate === 'rule' ? 'rule' : 'feature';
      const onSaved = async (created) => {
        const ent = kind === 'rule' ? (created && created.rule) : (created && created.feature);
        await linkToRec(kind, ent && ent.id);
      };
      if (kind === 'rule') ruleFormModal(null, [], onSaved, [], { projectId: project, fromCadrage: true, cadrageId });
      else featureFormModal(null, [], onSaved, { projectId: project, fromCadrage: true, cadrageId });
    }));
  }
  if (canEditRec) {
    // Gestion des tâches couvertes : ajout (candidates du projet) + retrait.
    const coveredIds = new Set((tasks || []).map((t) => (t && (t.taskId || t.task_id)) || t));
    const taskAddSel = document.getElementById('rec-task-add');
    if (taskAddSel) {
      (async () => {
        try {
          const d = await api(`${cadragesApiBase()}/candidates?project=${encodeURIComponent(project)}`);
          const cands = (d.candidates || []).filter((c) => !coveredIds.has(c.id));
          taskAddSel.innerHTML = `<option value="">+ Ajouter une tâche couverte…</option>` + cands.map((c) => `<option value="${esc(c.id)}">[${esc(c.project)}] ${esc((c.title || c.request || c.id).slice(0, 70))}</option>`).join('');
        } catch {}
        taskAddSel.addEventListener('change', async () => {
          const t = taskAddSel.value;
          if (!t) return;
          try {
            await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: t }) });
            closeModal(); cadrageDetailModal(cadrageId);
          } catch (e) { alert('Échec : ' + (e.message || e)); taskAddSel.value = ''; }
        });
      })();
    }
    document.querySelectorAll('#modal-backdrop [data-rec-task-del]').forEach((b) => b.addEventListener('click', async () => {
      const original = b.innerHTML;
      setBtnBusy(b, 'Retrait');
      try {
        await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/tasks/${encodeURIComponent(b.dataset.recTaskDel)}`, { method: 'DELETE' });
        closeModal(); cadrageDetailModal(cadrageId);
      } catch (e) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec : ' + (e.message || e));
      }
    }));
    document.querySelectorAll('#modal-backdrop [data-rec-item-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Retirer cet ${T.element} ? (utilisé pour la fusion/consolidation d'éléments)`)) return;
      const original = b.innerHTML;
      setBtnBusy(b, 'Retrait');
      try {
        await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/items/${b.dataset.recItemDel}`, { method: 'DELETE' });
        closeModal(); cadrageDetailModal(cadrageId);
      } catch (e) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec : ' + (e.message || e));
      }
    }));
    // Reprise d'un ÉLÉMENT DE CADRAGE ÉVALUATEUR « à traiter » (sélection en
    // contexte) — traçage « repris par le cadrage X ».
    const evalItemAddSel = document.getElementById('rec-eval-item-add');
    if (evalItemAddSel) {
      (async () => {
        try {
          const dd = await api(`/api/recettes/treatable?project=${encodeURIComponent(project)}`);
          const already = new Set((rec.recetteItems || []).map((x) => Number(x.itemId)));
          const cands = (dd.items || []).filter((c) => !already.has(Number(c.itemId)));
          evalItemAddSel.innerHTML = `<option value="">+ Reprendre un élément « à traiter »…</option>` + cands.map((c) => `<option value="${c.itemId}">[${esc(c.recetteTitle || c.recetteId || '')}] ${esc((c.content || '').slice(0, 70))}</option>`).join('');
        } catch {}
        evalItemAddSel.addEventListener('change', async () => {
          const v = evalItemAddSel.value;
          if (!v) return;
          try {
            await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/recette-items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: Number(v) }) });
            closeModal(); cadrageDetailModal(cadrageId);
          } catch (e) { alert('Échec : ' + (e.message || e)); evalItemAddSel.value = ''; }
        });
      })();
    }
    document.querySelectorAll('#modal-backdrop [data-rec-eval-item-del]').forEach((b) => b.addEventListener('click', async () => {
      const original = b.innerHTML;
      setBtnBusy(b, 'Retrait');
      try {
        await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/recette-items/${b.dataset.recEvalItemDel}`, { method: 'DELETE' });
        closeModal(); cadrageDetailModal(cadrageId);
      } catch (e) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec : ' + (e.message || e));
      }
    }));
  }
}

// Documents d'un cadrage : liste, ajout (import / artefact), lecture, retrait.
async function cadrageDocsModal(cadrageId) {
  const T = cadrageTerms();
  let d;
  try { d = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`); } catch (e) { alert(`Impossible de charger ${T.theEntity} : ` + (e.message || e)); return; }
  const rec = d.cadrage || {};
  const docs = rec.documents || [];
  showModal(`
    <div class="modal modal-wide">
      <h2>${T.docTitle}</h2>
      <p class="muted">${esc(rec.title || cadrageId)} — <span class="code">${esc(rec.project || '')}</span></p>
      <div class="recette-list">
        ${docs.map((doc) => `<div class="recette-item">
          <code class="muted-sm">${doc.source === 'artifact' ? '🔗' : '📄'}</code>
          <span><strong>${esc(doc.title || (doc.path || '').split('/').pop())}</strong></span>
          ${doc.nature ? `<span class="muted-sm">${esc(doc.nature.slice(0, 90))}</span>` : ''}
          ${doc.source === 'artifact' ? `<code class="muted-sm">${esc(doc.artifact_task || '')}</code>` : ''}
          ${/\.md$/i.test(doc.path || '') ? `<button class="ghost" data-doc-view="${esc(doc.documentId || doc.id)}">Regarder</button>` : ''}
          <button class="danger" data-doc-del="${esc(doc.documentId || doc.id)}">Retirer</button>
        </div>`).join('') || '<p class="muted-sm">Aucun document rattaché.</p>'}
      </div>
      <div class="actions-buttons"><button class="launch-btn" id="rec-doc-add">+ Ajouter un document</button></div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('rec-doc-add').onclick = () => cadrageDocAddModal(cadrageId);
  document.querySelectorAll('#modal-backdrop [data-doc-del]').forEach((b) => b.addEventListener('click', async () => {
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try {
      await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/documents/${b.dataset.docDel}`, { method: 'DELETE' });
      closeModal(); cadrageDocsModal(cadrageId);
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec : ' + (e.message || e));
    }
  }));
  document.querySelectorAll('#modal-backdrop [data-doc-view]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const v = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/documents/${b.dataset.docView}/view`);
      showModal(`<div class="modal modal-wide modal-md"><div class="md-head"><strong>${esc(v.title || 'Document')}</strong></div><div class="md-body markdown-view">${v.html}</div><div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div></div>`);
      document.getElementById('modal-cancel').onclick = closeModal;
    } catch (e) { alert('Impossible d\'ouvrir le document : ' + (e.message || e)); }
  }));
}

async function cadrageDocAddModal(cadrageId) {
  const T = cadrageTerms();
  let arts = [];
  try { arts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  showModal(`
    <div class="modal">
      <h2>${T.docAddTitle}</h2>
      <form id="rec-doc-form" class="pilot-form">
        <select id="rd-mode">
          <option value="import">Importer un fichier</option>
          <option value="artifact">Lier un document existant (artefact)</option>
        </select>
        <input id="rd-title" placeholder="titre (défaut : nom du fichier)">
        <textarea id="rd-nature" class="modal-textarea" placeholder="nature de la liaison — à quoi sert le document, comment l'exploiter (ex: spec à respecter, contexte du parcours)"></textarea>
        <div id="rd-import-wrap"><input type="file" id="rd-file" required></div>
        <div id="rd-artifact-wrap" hidden>
          <select id="rd-artifact"><option value="">— artefact existant —</option>${arts.map((a) => `<option value="${esc(a.artifact_id)}">${esc((a.title || a.path).slice(0, 70))} (${esc(a.task_id)})</option>`).join('')}</select>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Ajouter</button>
        </div>
      </form>
      <div id="rec-doc-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeSel = document.getElementById('rd-mode');
  modeSel.addEventListener('change', () => {
    const m = modeSel.value;
    document.getElementById('rd-import-wrap').hidden = m !== 'import';
    document.getElementById('rd-artifact-wrap').hidden = m !== 'artifact';
  });
  document.getElementById('rec-doc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Ajout');
    const msg = document.getElementById('rec-doc-msg');
    try {
      const mode = modeSel.value;
      const body = { mode, title: document.getElementById('rd-title').value.trim() || undefined, nature: document.getElementById('rd-nature').value.trim() || undefined };
      if (mode === 'import') {
        const f = document.getElementById('rd-file').files[0];
        if (!f) throw new Error('fichier requis');
        const buf = await f.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        body.filename = f.name; body.dataBase64 = b64;
      } else {
        body.artifactId = document.getElementById('rd-artifact').value;
        if (!body.artifactId) throw new Error('artefact requis');
      }
      await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}


async function cadrageCreateModal() {
  const T = cadrageTerms();
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  showModal(`
    <div class="modal modal-wide">
      <h2>${T.newEntity}</h2>
      <form id="recette-modal-form" class="pilot-form">
        ${projectReadonlyFieldsetHtml(projects)}
        <div id="rm-repos-hint" class="muted-sm" style="margin-top:6px"></div>
        <button type="button" class="ghost" id="rm-load-cands">Charger les tâches disponibles</button>
        <fieldset id="rm-adr-fieldset" class="pilot-fieldset">
          <legend>ADR rattachées ${T.docTo} — contexte de l'agent <span class="muted-sm">(sélection multi-lignes ; rattachées ${T.docTo} + bloc « ADR de référence » injecté). Toutes cochées par défaut.</span></legend>
          <div id="rm-adr-pick"><p class="muted-sm">Aucun projet ouvert — ADR indisponibles.</p></div>
        </fieldset>
        <fieldset id="rm-feature-fieldset" class="pilot-fieldset">
          <legend>Fonctionnalités rattachées ${T.docTo} — contexte de l'agent <span class="muted-sm">(sélection multi-lignes ; bloc « Fonctionnalités de référence » injecté). Toutes cochées par défaut.</span></legend>
          <div id="rm-feature-pick"><p class="muted-sm">Aucun projet ouvert — fonctionnalités indisponibles.</p></div>
        </fieldset>
        <fieldset id="rm-rule-fieldset" class="pilot-fieldset">
          <legend>Règles métier rattachées ${T.docTo} — contexte de l'agent <span class="muted-sm">(sélection multi-lignes ; bloc « Règles métier de référence » injecté). Toutes cochées par défaut.</span></legend>
          <div id="rm-rule-pick"><p class="muted-sm">Aucun projet ouvert — règles métier indisponibles.</p></div>
        </fieldset>
        ${(IS_ADMIN || IS_EXECUTEUR) ? `<fieldset id="rm-eval-item-fieldset" class="pilot-fieldset">
          <legend>Éléments de recette évaluateur à traiter <span class="muted-sm">(sélection multi-lignes ; les éléments cochés sont repris par le cadrage créé — traçage « repris par ce cadrage »).</span></legend>
          <div id="rm-eval-item-pick"><p class="muted-sm">Aucun projet ouvert — éléments « à traiter » indisponibles.</p></div>
        </fieldset>` : ''}
        <input id="rm-title" placeholder="titre court (ex: Cadrage technique du module chatbot)" required>
        <textarea id="rm-description" class="modal-textarea" placeholder="description longue (détail du périmètre vérifié) — optionnel"></textarea>
        <label class="modal-field">Tâches couvertes <span class="muted-sm">(0..N — tâches non encore recettées du projet)</span></label>
        <div id="rm-candidates" class="recette-candidates"><p class="muted-sm">Cliquez sur « Charger les tâches disponibles » pour lister les tâches couvertes du projet ouvert.</p></div>
        <div class="links-editor">
          <div class="links-head"><label class="modal-field" style="margin:0">Documents <span class="muted-sm">(importés ou liés, avec nature)</span></label>
          <button type="button" class="ghost" id="rm-add-doc">+ Ajouter</button></div>
          <div id="rm-docs-list"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer</button>
        </div>
      </form>
      <div id="recette-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const candBox = document.getElementById('rm-candidates');
  const reposHint = document.getElementById('rm-repos-hint');
  const kept = new Set(); // tâches déjà cochées, conservées entre rechargements
  const loadCandidates = async () => {
    const proj = currentProject;
    candBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    if (!proj) { candBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>'; return; }
    try {
      const d = await api(`${cadragesApiBase()}/candidates?project=${encodeURIComponent(proj)}`);
      const c = d.candidates || [];
      candBox.innerHTML = c.length
        ? `<div class="recette-cand-list">${c.map((t) => `
            <label class="recette-cand">
              <input type="checkbox" class="rm-cand" value="${esc(t.id)}" ${kept.has(t.id) ? 'checked' : ''}>
              <span><code class="muted-sm">${esc(t.project)}</code> <strong>${esc(t.title || (t.request || '').slice(0, 60))}</strong> <code class="muted-sm">${esc(t.id)}</code> ${badge(t.status || 'queued')}</span>
            </label>`).join('')}</div>`
        : '<p class="muted-sm">Aucune tâche non recettée dans ce projet.</p>';
      candBox.querySelectorAll('.rm-cand').forEach((x) => x.addEventListener('change', () => {
        if (x.checked) kept.add(x.value); else kept.delete(x.value);
      }));
    } catch (e) { candBox.innerHTML = '<p class="muted-sm">Erreur de chargement : ' + esc(e.message || e) + '</p>'; }
  };
  document.getElementById('rm-load-cands').addEventListener('click', loadCandidates);
  // ADR rattachées au cadrage (item 125) : sélection multi-lignes des ADR du
  // projet (+ repos transverses). Les ADR cochées sont rattachées au cadrage
  // (cadrage_doc_add côté pilot) ET leur bloc est injecté dans le prompt.
  const adrBox = document.getElementById('rm-adr-pick');
  const reposForProject = (pid) => { const p = projects.find((x) => x.id === pid); return (p && p.repos) || []; };
  const loadAdrs = async () => {
    const proj = currentProject;
    if (!proj) { adrBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>'; return; }
    adrBox.innerHTML = '<p class="muted-sm">Chargement des ADR…</p>';
    const seen = new Map();
    try {
      const d = await api(`/api/docs?projectId=${encodeURIComponent(proj)}&includeRepoDocs=1`);
      for (const doc of (d.docs || [])) if (doc && doc.kind === 'adr-tech' && !seen.has(doc.docId)) seen.set(doc.docId, doc);
    } catch {}
    adrBox.innerHTML = adrSelectorHtml([...seen.values()], { prefix: 'rm-adr-pick', repos: reposForProject(proj) });
    bindAdrSelector('rm-adr-pick');
  };
  // Fonctionnalités + Règles métier (T-20260922-070103-ncs1) : 1 appel par liste
  // (routes existantes, listes déjà enrichies) — 0 N+1. Les rôles proposés au
  // filtre = union des rôles du projet (features[].role + rules[].roles).
  const featureBox = document.getElementById('rm-feature-pick');
  const ruleBox = document.getElementById('rm-rule-pick');
  const loadFeaturesRules = async () => {
    const proj = currentProject;
    if (!proj) {
      featureBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>';
      ruleBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>';
      return;
    }
    featureBox.innerHTML = '<p class="muted-sm">Chargement des fonctionnalités…</p>';
    ruleBox.innerHTML = '<p class="muted-sm">Chargement des règles métier…</p>';
    let features = [];
    let rules = [];
    try {
      const [fd, rd] = await Promise.all([
        api(`/api/features?projectId=${encodeURIComponent(proj)}`),
        api(`/api/rules?projectId=${encodeURIComponent(proj)}`),
      ]);
      features = (fd && fd.features) || [];
      rules = (rd && rd.rules) || [];
    } catch {}
    const roles = [...new Set([
      ...features.map((x) => x.role).filter(Boolean),
      ...rules.flatMap((x) => x.roles || []),
    ])].sort();
    featureBox.innerHTML = frSelectorHtml('feature', features, { prefix: 'rm-feature-pick', roles, projectId: proj, fromCadrage: true, entityWord: 'cadrage' });
    bindFrSelector('rm-feature-pick', { projectId: proj, projectRoles: roles, entityWord: 'cadrage' });
    ruleBox.innerHTML = frSelectorHtml('rule', rules, { prefix: 'rm-rule-pick', roles, projectId: proj, fromCadrage: true, entityWord: 'cadrage' });
    bindFrSelector('rm-rule-pick', { projectId: proj, projectRoles: roles, entityWord: 'cadrage' });
  };
  // Éléments de recette évaluateur « à traiter » (T-20260922-141007-p4dc) :
  // candidats du projet sélectionné chargés via GET /api/recettes/treatable
  // (garde `decision='a_traiter'` portée par le registre). Rafraîchi au
  // changement de projet, comme les fieldsets ADR / Fonctionnalités / Règles.
  const evalItemBox = document.getElementById('rm-eval-item-pick');
  const loadEvalItems = async () => {
    if (!evalItemBox) return;
    const proj = currentProject;
    if (!proj) { evalItemBox.innerHTML = '<p class="muted-sm">Aucun projet ouvert.</p>'; return; }
    evalItemBox.innerHTML = '<p class="muted-sm">Chargement des éléments « à traiter »…</p>';
    let items = [];
    try {
      const d = await api(`/api/recettes/treatable?project=${encodeURIComponent(proj)}`);
      items = (d && d.items) || [];
    } catch (e) {
      evalItemBox.innerHTML = '<p class="muted-sm">Erreur de chargement : ' + esc(e.message || e) + '</p>';
      return;
    }
    evalItemBox.innerHTML = evalItemSelectorHtml(items, { prefix: 'rm-eval-item-pick' });
    bindEvalItemSelector('rm-eval-item-pick');
  };
  const renderReposHint = () => {
    const proj = projects.find((p) => p.id === currentProject);
    const repos = (proj && proj.repos) || [];
    reposHint.innerHTML = repos.length
      ? `Repos transverses du projet (portée réelle) : ${repos.map((r) => `<code class="chip-repo">${esc(r.repoId || r)}</code>`).join(' ')}`
      : 'Aucun repo rattaché à ce projet.';
  };
  // Chargement AUTOMATIQUE des listes dépendantes du projet ouvert (plus de
  // combo projet : aucun « change » à attendre). Les éléments de recette
  // évaluateur « à traiter » sont chargés en même temps (admin/exécuteur).
  renderReposHint();
  loadAdrs();
  loadFeaturesRules();
  loadEvalItems();

  // Éditeur de documents (import / artefact + nature).
  let allArtifacts = [];
  try { allArtifacts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  const docsList = document.getElementById('rm-docs-list');
  const addDocRow = () => {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <div class="rd-head">
        <select class="rd-mode">
          <option value="import">Importer</option>
          <option value="artifact">Lier artefact</option>
        </select>
        <input class="rd-title" placeholder="titre (défaut : nom du fichier)">
        <button type="button" class="ghost rd-del" title="Retirer">✕</button>
      </div>
      <input class="rd-file" type="file">
      <select class="rd-art" hidden><option value="">— artefact existant —</option>${allArtifacts.map((a) => `<option value="${esc(a.artifact_id)}">${esc((a.title || a.path).slice(0, 60))} (${esc(a.task_id)})</option>`).join('')}</select>
      <textarea class="rd-nature" rows="2" placeholder="nature de la liaison (à quoi sert le document, comment l'exploiter)"></textarea>`;
    const modeSel = row.querySelector('.rd-mode');
    const fileEl = row.querySelector('.rd-file');
    const artEl = row.querySelector('.rd-art');
    const sync = () => {
      const m = modeSel.value;
      fileEl.hidden = m !== 'import';
      artEl.hidden = m !== 'artifact';
      if (m === 'import') fileEl.required = true; else { fileEl.required = false; artEl.required = true; }
    };
    modeSel.addEventListener('change', sync);
    sync();
    row.querySelector('.rd-del').addEventListener('click', () => row.remove());
    docsList.appendChild(row);
  };
  document.getElementById('rm-add-doc').addEventListener('click', addDocRow);

  // Sans projet ouvert : création DÉSACTIVÉE + message explicite (aucun combo de
  // secours — le projet de création est le projet ouvert).
  applyNoProjectGuard('recette-modal-form', 'recette-modal-msg');

  document.getElementById('recette-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    const msg = document.getElementById('recette-modal-msg');
    try {
      const proj = currentProject;
      if (!proj) throw new Error('Aucun projet ouvert.');
      const taskIds = [...candBox.querySelectorAll('.rm-cand:checked')].map((x) => x.value);
      const documents = [];
      for (const row of docsList.querySelectorAll('.link-row')) {
        const mode = row.querySelector('.rd-mode').value;
        const title = row.querySelector('.rd-title').value.trim() || undefined;
        const nature = row.querySelector('.rd-nature').value.trim() || undefined;
        if (mode === 'import') {
          const f = row.querySelector('.rd-file').files[0];
          if (f) {
            const buf = await f.arrayBuffer();
            documents.push({ mode: 'import', filename: f.name, dataBase64: btoa(String.fromCharCode(...new Uint8Array(buf))), title, nature });
          }
        } else {
          const art = row.querySelector('.rd-art').value;
          if (art) documents.push({ mode: 'artifact', artifactId: art, title, nature });
        }
      }
      const created = await api(cadragesApiBase(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: proj,
        title: document.getElementById('rm-title').value.trim(),
        description: document.getElementById('rm-description').value.trim() || undefined,
        taskIds,
        documents,
        adrIds: selectedAdrIds('rm-adr-pick'), // toujours un tableau (vide = aucune ADR en contexte)
        featureIds: selectedFrIds('feature', 'rm-feature-pick'), // toujours un tableau (vide = aucune fonctionnalité)
        ruleIds: selectedFrIds('rule', 'rm-rule-pick'), // toujours un tableau (vide = aucune règle métier)
        organizationId: currentOrg || undefined,
      }) });
      // Reprise des ÉLÉMENTS DE CADRAGE ÉVALUATEUR cochés (T-20260922-141007-p4dc) :
      // le cadrage est créé (comportement inchangé) PUIS les éléments cochés sont
      // rattachés via POST /api/cadrages/:id/recette-items. Erreurs NON
      // bloquantes mais reportées dans le message de la modale.
      const createdId = created && created.cadrage && (created.cadrage.cadrageId || created.cadrage.id);
      const evalItemIds = selectedEvalItemIds('rm-eval-item-pick');
      const linkErrors = [];
      if (createdId && evalItemIds.length) {
        for (const itemId of evalItemIds) {
          try {
            await api(`${cadragesApiBase()}/${encodeURIComponent(createdId)}/recette-items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: Number(itemId) }) });
          } catch (err) { linkErrors.push(`#${itemId} : ${err.message || err}`); }
        }
      }
      if (linkErrors.length) {
        msg.textContent = `Cadrage ${createdId} créé, mais ${linkErrors.length} élément(s) non repris : ${linkErrors.join(' ; ')}`;
        msg.className = 'msg error';
        // Empêche une double création si le formulaire est renvoyé.
        if (btn) btn.disabled = true;
        refreshActive();
        return;
      }
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

// Modal de cadrage (items) : 'finish' = clôture avec confirmation (in_progress) ;
// 'detail' = lecture seule (cadrage terminée) — même présentation, sans action de clôture.
// En mode 'finish', chaque élément est modifiable/supprimable avant clôture, et la
// cadrage peut être terminée AVEC ou SANS génération de tâches.
async function cadrageItemsModal(cadrageId, mode = 'finish') {
  const T = cadrageTerms();
  const readOnly = mode === 'detail';
  const CLASS_OPTS = ['rework', 'bug', 'improvement', 'feature'];
  let d;
  try { d = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`); } catch (e) { alert(`Impossible de charger ${T.theEntity} : ` + (e.message || e)); return; }
  const rec = d.cadrage || {};
  // Points de vigilance ADR (item 126) : un point OUVERT BLOQUE la terminaison.
  if (!Array.isArray(rec.adrVigilancesOpen)) rec.adrVigilancesOpen = (rec.adrVigilances || []).filter((v) => v.status === 'open');
  const vigList = () => rec.adrVigilancesOpen || [];
  const vigReasonsHtml = () => vigList().map((v) => `<li>${esc(v.reason || (v.type === 'conflict' ? `Conflit d'ADR : ${v.adrId || '?'} vs ${v.relatedAdrId || '?'}` : `ADR manquant pour ${v.entity || '?'}`))}${v.description ? ` — <span class="muted-sm">${esc(v.description)}</span>` : ''} <button type="button" class="ghost adr-vig-raise" data-vig-id="${esc(v.vigilanceId)}">Lever</button></li>`).join('');
  let items = rec.items || [];
  const itemCard = (it) => {
    const full = it.content || '';
    const truncated = full.length > 120;
    const show = truncated ? full.slice(0, 120) + '…' : full;
    return `<div class="recette-item finish-item" data-item-id="${it.id}">
      <span class="badge ${CADRAGE_CLS_BADGE[it.classification] || 'queued'}">${CADRAGE_CLS_LABEL[it.classification] || it.classification}</span>
      ${it.project ? `<code class="chip-project">${esc(it.project)}</code>` : ''}
      <div class="recette-task">
        <strong>${esc(it.title || it.content.slice(0, 60))}</strong>
        ${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution">ordre ${esc(it.execOrder)}</span>` : ''}
        ${testIntentBadge(it)}
        ${docIntentBadge(it)}
        ${it.vigilance ? `<span class="badge danger" title="Point de vigilance">⚠ vigilance</span>` : ''}
        ${it.status === 'task_created' && it.createdTaskId ? `<code class="muted-sm">→ ${esc(it.createdTaskId)}</code>` : ''}
        <p class="muted-sm finish-desc" data-full="${esc(full)}">${esc(show)}</p>
        ${truncated ? `<button type="button" class="ghost finish-more">Voir en entier</button>` : ''}
        ${it.acceptance ? `<p class="muted-sm"><strong>✓ Critère :</strong> ${esc(it.acceptance)}</p>` : ''}
        ${it.vigilance ? `<p class="muted-sm warn"><strong>⚠ Point de vigilance :</strong> ${esc(it.vigilance)}</p>` : ''}
        ${it.scope && it.scope.length ? `<p class="muted-sm"><strong>Scope :</strong> ${esc(it.scope.join(', '))}</p>` : ''}
      </div>
      ${!readOnly && it.status !== 'task_created' ? `<div class="finish-item-actions">
        <button type="button" class="ghost" data-item-edit="${it.id}" title="Modifier cet élément">✎ modifier</button>
        <button type="button" class="ghost rec-item-del" data-item-del="${it.id}" title="Supprimer cet élément">✕ supprimer</button>
      </div>` : ''}
    </div>`;
  };
  const editForm = (it) => `<div class="recette-item finish-item finish-item-edit" data-item-id="${it.id}">
    <div class="recette-task">
      <div class="finish-field"><span>Classification</span>
        <select class="fe-classification">${CLASS_OPTS.map((c) => `<option value="${c}" ${it.classification === c ? 'selected' : ''}>${CADRAGE_CLS_LABEL[c]}</option>`).join('')}</select></div>
      <div class="finish-field"><span>Titre court (titre de la tâche créée)</span>
        <input class="fe-title" value="${esc(it.title || '')}"></div>
      <div class="finish-field"><span>Contenu (remarque / demande / constat)</span>
        <textarea class="fe-content modal-textarea" rows="3">${esc(it.content || '')}</textarea></div>
      <div class="finish-field"><span>Critère d'acceptation</span>
        <textarea class="fe-acceptance modal-textarea" rows="2">${esc(it.acceptance || '')}</textarea></div>
      <div class="finish-field"><span>Scope (chemins, séparés par des virgules)</span>
        <input class="fe-scope" value="${esc((it.scope || []).join(', '))}" placeholder="ex: src/features/x, src/shared/y"></div>
      <div class="finish-field"><span>Ordre d'exécution (même n° = parallèle)</span>
        <input class="fe-execorder" type="number" min="0" value="${it.execOrder != null ? esc(it.execOrder) : ''}"></div>
      <div class="finish-field"><span>Point de vigilance / écart sémantique</span>
        <textarea class="fe-vigilance modal-textarea" rows="2">${esc(it.vigilance || '')}</textarea></div>
      <div class="finish-item-actions">
        <button type="button" class="approve" data-item-save="${it.id}">Enregistrer</button>
        <button type="button" class="ghost" data-item-cancel="${it.id}">Annuler</button>
      </div>
      <div class="msg" data-item-msg="${it.id}"></div>
    </div>
  </div>`;
  const intro = readOnly
    ? (items.length
      ? '<p>Éléments relevés lors du cadrage technique (lecture seule) :</p>'
      : '<p class="muted-sm">Aucun élément relevé.</p>')
    : (items.length
      ? '<p>Éléments relevés — tu peux les <strong>modifier</strong> ou les <strong>supprimer</strong> avant de clôturer. À la confirmation, ils sont transformés en <strong>nouvelles tâches</strong> (titre + demande + critère d\'acceptation) — ou termine le cadrage sans créer de tâche.</p>'
      : '<p class="muted-sm">Aucun élément relevé : le cadrage sera clôturé sans créer de tâche.</p>');
  const launchModeBlock = readOnly ? '' : `
    <fieldset class="pilot-fieldset" style="margin-top:12px">
      <legend>Lancement des tâches créées</legend>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><input type="radio" name="rec-launch-mode" value="batch" checked style="margin-top:2px"><span><strong>Batch</strong> — le worker lance automatiquement les tâches prêtes (≤ maxParallel), chacune avec sa session.</span></label>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><input type="radio" name="rec-launch-mode" value="session" style="margin-top:2px"><span><strong>Session unique</strong> — une session d'orchestration pilote tout le batch (ordonnancement + préparation croisée).</span></label>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="rec-launch-mode" value="manual" style="margin-top:2px"><span><strong>Manuel</strong> — aucun auto-lancement : tu pilotes chaque tâche toi-même, comme avant.</span></label>
      <div id="rec-max-parallel-block" style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label for="rec-max-parallel" style="margin:0"><strong>Parallélisme max</strong> — nombre maximum de tâches lancées en parallèle (1..8).</label>
        <input type="number" id="rec-max-parallel" name="rec-max-parallel" min="1" max="8" step="1" value="2" style="width:70px">
      </div>
    </fieldset>`;
  showModal(`
    <div class="modal modal-wide modal-finish" id="finish-modal">
      <div class="finish-head"><h2 style="margin:0">${readOnly ? T.detail : T.finish}</h2>
        <button class="ghost" id="finish-fullscreen" title="Plein écran">⛶</button></div>
      <p class="muted">${esc(rec.title || cadrageId)} — ${cadrageScopeChips(rec)}${readOnly && rec.confirmed_at ? ` · clôturée le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${!readOnly && vigList().length ? `<div class="adr-vig-block" id="adr-vig-block">
        <strong>⚠ Terminaison bloquée — points de vigilance ADR ouverts :</strong>
        <ul class="adr-vig-reasons">${vigReasonsHtml()}</ul>
        <div class="muted-sm">Résous l'ADR (création / dépréciation actée) ou lève chaque point avec une raison tracée pour pouvoir terminer.</div>
      </div>` : ''}
      <div id="finish-intro">${intro}</div>
      <div class="recette-list" id="finish-items"></div>
      ${launchModeBlock}
      <div class="modal-actions">
        ${readOnly
          ? '<button class="ghost" id="modal-cancel">Fermer</button>'
          : `<button class="ghost" id="modal-cancel">Annuler</button>
             <button class="ghost" id="modal-finish-notasks" title="Clôturer le cadrage sans générer de tâches">Terminer sans créer de tâches</button>
             <button class="approve" id="modal-confirm">Confirmer & terminer</button>`}
      </div>
      <div id="recette-finish-msg" class="msg"></div>
    </div>`);
  const finishModal = document.getElementById('finish-modal');
  const itemsBox = () => document.getElementById('finish-items');
  const bindItems = (root = itemsBox()) => {
    root.querySelectorAll('.finish-more').forEach((b) => b.addEventListener('click', () => {
      const p = b.parentElement.querySelector('.finish-desc');
      const full = p.dataset.full || '';
      const collapsed = p.textContent.endsWith('…');
      p.textContent = collapsed ? full : (full.slice(0, 120) + '…');
      b.textContent = collapsed ? 'Réduire' : 'Voir en entier';
    }));
    if (readOnly) return;
    root.querySelectorAll('[data-item-edit]').forEach((b) => b.addEventListener('click', () => {
      const it = items.find((x) => String(x.id) === b.dataset.itemEdit);
      if (!it) return;
      const card = root.querySelector(`[data-item-id="${b.dataset.itemEdit}"]`);
      if (!card) return;
      card.outerHTML = editForm(it);
      bindItems(itemsBox().querySelector(`[data-item-id="${b.dataset.itemEdit}"]`));
    }));
    root.querySelectorAll('[data-item-cancel]').forEach((b) => b.addEventListener('click', renderItems));
    root.querySelectorAll('[data-item-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Supprimer définitivement cet ${T.element} ?`)) return;
      const original = b.innerHTML;
      setBtnBusy(b, 'Suppression');
      try {
        await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/items/${b.dataset.itemDel}`, { method: 'DELETE' });
        await reloadItems();
      } catch (e) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec de la suppression : ' + (e.message || e));
      }
    }));
    root.querySelectorAll('[data-item-save]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.itemSave;
      const form = root.querySelector(`[data-item-id="${id}"]`);
      const msg = form.querySelector(`[data-item-msg="${id}"]`);
      const content = form.querySelector('.fe-content').value.trim();
      if (!content) { msg.textContent = 'Le contenu est requis.'; msg.className = 'msg error'; return; }
      const execRaw = form.querySelector('.fe-execorder').value.trim();
      const fields = {
        content,
        classification: form.querySelector('.fe-classification').value,
        title: form.querySelector('.fe-title').value.trim() || null,
        acceptance: form.querySelector('.fe-acceptance').value.trim() || null,
        scope: form.querySelector('.fe-scope').value.split(',').map((s) => s.trim()).filter(Boolean),
        execOrder: execRaw === '' ? null : Number(execRaw),
        vigilance: form.querySelector('.fe-vigilance').value.trim() || null,
      };
      try {
        setBtnBusy(b, 'Enregistrement');
        await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/items/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
        await reloadItems();
      } catch (e) {
        msg.textContent = e.message || e;
        msg.className = 'msg error';
        b.disabled = false; b.classList.remove('ws-busy'); b.textContent = 'Enregistrer';
      }
    }));
  };
  const renderItems = () => {
    const box = itemsBox();
    box.innerHTML = items.length ? items.map(itemCard).join('') : '<p class="muted-sm">Aucun élément relevé.</p>';
    bindItems(box);
  };
  const reloadItems = async () => {
    try {
      const dd = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`);
      items = (dd.cadrage && dd.cadrage.items) || [];
    } catch { /* conserve l'état courant */ }
    renderItems();
  };
  renderItems();
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('finish-fullscreen').onclick = () => {
    const fs = finishModal.classList.toggle('finish-full');
    document.getElementById('finish-fullscreen').textContent = fs ? '⤢ rétrécir' : '⛶ plein écran';
  };
  if (readOnly) return;
  const hasOpenEdit = () => !!document.querySelector('#finish-items .finish-item-edit');
  const confirmBtn = document.getElementById('modal-confirm');
  const noTasksBtn = document.getElementById('modal-finish-notasks');
  // Levée tracée d'un point de vigilance ADR (raison obligatoire) — puis
  // rafraîchit le bloc et ré-active « Terminer » quand il ne reste plus de point.
  const wireVigBlock = () => {
    document.querySelectorAll('#adr-vig-block .adr-vig-raise').forEach((b) => {
      b.addEventListener('click', async () => {
        const reason = prompt('Raison de la levée (tracée, obligatoire) :');
        if (!reason || !reason.trim()) return;
        const original = b.innerHTML;
        setBtnBusy(b, 'Levée');
        try {
          await api('/api/adr-vigilances/' + encodeURIComponent(b.dataset.vigId) + '/resolve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution: reason.trim(), resolutionKind: 'manual' }),
          });
          const dd = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`);
          rec.adrVigilances = (dd.cadrage && dd.cadrage.adrVigilances) || [];
          rec.adrVigilancesOpen = (dd.cadrage && dd.cadrage.adrVigilancesOpen) || rec.adrVigilances.filter((v) => v.status === 'open');
          const blk = document.getElementById('adr-vig-block');
          if (vigList().length) {
            if (blk) { blk.querySelector('.adr-vig-reasons').innerHTML = vigReasonsHtml(); wireVigBlock(); }
          } else {
            if (blk) blk.remove();
            if (confirmBtn) confirmBtn.disabled = false;
            if (noTasksBtn) noTasksBtn.disabled = false;
          }
        } catch (e) {
          b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
          alert('Échec de la levée : ' + (e.message || e));
        }
      });
    });
  };
  wireVigBlock();
  // Le champ « Parallélisme max » n'a de sens qu'avec un auto-lancement : il est
  // proposé pour Batch et Session unique, masqué en mode Manuel. Visible par
  // défaut (Batch coché).
  const maxParallelBlock = document.getElementById('rec-max-parallel-block');
  const syncMaxParallelVisibility = () => {
    if (!maxParallelBlock) return;
    const lm = (document.querySelector('input[name="rec-launch-mode"]:checked') || {}).value || 'batch';
    maxParallelBlock.style.display = lm === 'manual' ? 'none' : '';
  };
  document.querySelectorAll('input[name="rec-launch-mode"]').forEach((r) => r.addEventListener('change', syncMaxParallelVisibility));
  syncMaxParallelVisibility();
  // Tant qu'un point de vigilance ADR est OUVERT, la terminaison est BLOQUÉE
  // (le serveur/registre refuse de toute façon — ici on l'affiche et on désactive).
  if (vigList().length) {
    confirmBtn.disabled = true;
    if (noTasksBtn) noTasksBtn.disabled = true;
  }
  confirmBtn.onclick = async () => {
    const msg = document.getElementById('recette-finish-msg');
    if (hasOpenEdit()) { msg.textContent = 'Un élément est en cours d\'édition : enregistre-le ou annule-le avant de terminer.'; msg.className = 'msg error'; return; }
    const original = confirmBtn.innerHTML;
    setBtnBusy(confirmBtn, 'Clôture');
    if (noTasksBtn) noTasksBtn.disabled = true;
    try {
      const payload = items.map((it) => ({ itemId: it.id, content: it.content, classification: it.classification, title: it.title, acceptance: it.acceptance, scope: it.scope, execOrder: it.execOrder }));
      const launchMode = (document.querySelector('input[name="rec-launch-mode"]:checked') || {}).value || 'batch';
      // Garde UI : la valeur est re-clampée côté pilote (finishCadrage) et par le registre.
      const maxParallelRaw = (document.querySelector('input[name="rec-max-parallel"]') || {}).value;
      const maxParallel = Math.max(1, Math.min(8, Number(maxParallelRaw) || 2));
      const r = await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: payload, launchMode, maxParallel, createTasks: true }) });
      msg.textContent = r.created && r.created.length
        ? 'Tâches créées : ' + r.created.map((c) => `${c.taskId} (${CADRAGE_CLS_LABEL[c.classification]})`).join(', ')
        : T.doneNoTasks;
      msg.className = 'msg ok';
      closeModal();
      const modeLabel = { batch: 'Batch', session: 'Session unique', manual: 'Manuel' }[launchMode] || launchMode;
      alert(`${msg.textContent}\nMode de lancement : ${modeLabel}`);
      refreshActive();
    } catch (e) {
      msg.textContent = e.message || e;
      msg.className = 'msg error';
      confirmBtn.disabled = false; confirmBtn.classList.remove('ws-busy'); confirmBtn.innerHTML = original;
      if (noTasksBtn) noTasksBtn.disabled = false;
    }
  };
  noTasksBtn.onclick = async () => {
    const msg = document.getElementById('recette-finish-msg');
    if (hasOpenEdit()) { msg.textContent = 'Un élément est en cours d\'édition : enregistre-le ou annule-le avant de terminer.'; msg.className = 'msg error'; return; }
    if (!confirm(`Clôturer ${T.theEntity} SANS générer de tâches ?\n\nLes éléments relevés restent consultables dans le détail du cadrage.`)) return;
    const original = noTasksBtn.innerHTML;
    setBtnBusy(noTasksBtn, 'Clôture');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createTasks: false }) });
      closeModal();
      alert(T.doneNoTasks);
      refreshActive();
    } catch (e) {
      msg.textContent = e.message || e;
      msg.className = 'msg error';
      noTasksBtn.disabled = false; noTasksBtn.classList.remove('ws-busy'); noTasksBtn.innerHTML = original;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  };
}

function finishCadrageModal(cadrageId) { return cadrageItemsModal(cadrageId, 'finish'); }
function cadrageDetailItemsModal(cadrageId) { return cadrageItemsModal(cadrageId, 'detail'); }

// --- Plans (plans d'action, persistance SQLite) ----------------------------
function progressBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="progress-bar"><div class="progress-fill" style="width:${p}%"></div></div><span class="muted-sm">${p}%</span>`;
}

async function renderPlans() {
  const data = await api('/api/plans' + taskQuery());
  const plans = data.plans || [];
  document.getElementById('pane-plans').innerHTML = `
    <h2>Plans d'action</h2>
    ${filterBar()}
    <table><thead><tr><th>Plan</th><th>Tâche</th><th>Objectif</th><th>Avancement</th><th>Commits</th><th>Livrables</th></tr></thead>
    <tbody>${plans.map((p) => `<tr><td class="code">${esc(p.planId)}</td><td class="code">${esc(p.task_id || '—')}</td><td>${esc(p.objective)}</td><td>${progressBar(p.pct)}</td><td><button class="commit-btn" data-commits="${esc(p.planId)}" title="Voir les commits et leurs diffs">${p.commit_count || 0}</button></td><td>${esc((p.deliverables || []).join(', '))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun plan</td></tr>'}</tbody></table>`;
  bindTaskFilter();
  document.querySelectorAll('#pane-plans [data-commits]').forEach((b) => b.addEventListener('click', () => renderPlanCommitsModal(b.dataset.commits)));
}

// --- Commits (trace par sous-tâche, avec fichiers + diff) -------------------
function fileStatusBadge(status) {
  const map = { added: ['approved', 'ajouté'], modified: ['in_progress', 'modifié'], deleted: ['rejected', 'supprimé'], renamed: ['awaiting', 'renommé'] };
  const [cls, label] = map[status] || ['queued', status || '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function fileStatLabel(f) {
  const a = Number(f.additions) || 0;
  const d = Number(f.deletions) || 0;
  return `<span class="stat-add">+${a}</span> <span class="stat-del">−${d}</span>`;
}

function renderDiff(diffText) {
  if (!diffText) return '<div class="diff"><div class="diff-line muted">(pas de diff)</div></div>';
  const lines = String(diffText).split('\n');
  const html = lines.map((ln) => {
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ')) return `<div class="diff-line diff-hdr">${esc(ln)}</div>`;
    if (ln.startsWith('@@')) return `<div class="diff-line diff-hunk">${esc(ln)}</div>`;
    if (ln.startsWith('+')) return `<div class="diff-line diff-add">${esc(ln)}</div>`;
    if (ln.startsWith('-')) return `<div class="diff-line diff-del">${esc(ln)}</div>`;
    return `<div class="diff-line">${esc(ln)}</div>`;
  }).join('');
  return `<div class="diff">${html}</div>`;
}

function commitCard(c) {
  const files = c.files || [];
  const date = (c.committedAt || c.createdAt || '').replace('T', ' ').slice(0, 19);
  return `<div class="commit-card">
    <div class="commit-head">
      <code class="commit-sha">${esc((c.sha || '').slice(0, 8))}</code>
      <span class="commit-msg">${esc(c.message || '')}</span>
      ${c.author ? `<span class="muted-sm">${esc(c.author)}</span>` : ''}
      ${date ? `<span class="muted-sm">${esc(date)}</span>` : ''}
      ${c.branch ? `<code class="muted-sm">${esc(c.branch)}</code>` : ''}
    </div>
    <div class="commit-files">
      ${files.map((f, i) => `
        <div class="commit-file">
          <div class="file-head">
            <button class="file-toggle" data-file-toggle="diff-${c.id}-${i}">▸</button>
            ${fileStatusBadge(f.status)}
            <code class="file-path">${esc(f.path)}</code>
            ${fileStatLabel(f)}
          </div>
          <div id="diff-${c.id}-${i}" hidden>${renderDiff(f.diff)}</div>
        </div>`).join('') || '<div class="muted-sm commit-file">Aucun fichier référencé</div>'}
    </div>
  </div>`;
}

async function renderPlanCommitsModal(planId) {
  let data;
  try { data = await api(`/api/plans/${encodeURIComponent(planId)}/commits`); }
  catch (e) { alert('Impossible de charger les commits : ' + (e.message || e)); return; }
  const commits = data.commits || [];
  showModal(`
    <div class="modal modal-wide">
      <h2>Commits — <span class="code">${esc(planId)}</span></h2>
      <p class="muted-sm">${commits.length} commit(s) — trace intégrale conservée (y compris les reworks).</p>
      <div class="commit-list">${commits.length ? commits.map(commitCard).join('') : '<p class="muted">Aucun commit enregistré pour ce plan.</p>'}</div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.querySelectorAll('[data-file-toggle]').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(b.dataset.fileToggle);
    if (!el) return;
    el.hidden = !el.hidden;
    b.textContent = el.hidden ? '▸' : '▾';
  }));
}

// --- Consommation (usage par session et par modèle) -------------------------
const KIND_LABEL = { launch: 'Lancement', rework: 'Reprise (nouvelle session)', relaunch: 'Relance' };

function fmtNum(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}
function fmtCost(n) {
  return '$' + Number(n || 0).toFixed(2);
}
function tokenChips(t, cost) {
  const t_ = t || {};
  const chip = (lbl, v, cls) => `<span class="metric ${cls || ''}"><span class="lbl">${lbl}</span><span class="val">${v}</span></span>`;
  return chip('input', fmtNum(t_.input)) + chip('output', fmtNum(t_.output)) + chip('reasoning', fmtNum(t_.reasoning)) + chip('cache', fmtNum(t_.cacheRead)) + chip('coût', fmtCost(cost), 'cost');
}

async function renderConsumptionModal(taskId) {
  let data;
  try { data = await api(`/api/tasks/${encodeURIComponent(taskId)}/consumption`); }
  catch (e) { alert('Impossible de charger la consommation : ' + (e.message || e)); return; }
  const total = data.total || { tokens: {}, cost: 0 };
  const sessions = data.sessions || [];
  const sessionRows = sessions.map((s) => `
    <div class="cons-session">
      <div class="cons-head">
        <strong>${esc(KIND_LABEL[s.kind] || s.kind || 'Session')}</strong>
        <code class="muted-sm">${esc(s.sessionId || '—')}</code>
        ${s.createdAt ? `<span class="muted-sm">${esc((s.createdAt || '').replace('T', ' ').slice(0, 19))}</span>` : ''}
      </div>
      <div class="cons-chips">${tokenChips(s.tokens, s.cost)}</div>
      ${(s.models && s.models.length) ? `<div class="cons-models">${s.models.map((m) => `<div class="cons-model-row"><code>${esc(m.model)}</code><span class="muted-sm">in ${fmtNum(m.input)} · out ${fmtNum(m.output)} · reason ${fmtNum(m.reasoning)} · cache ${fmtNum(m.cacheRead)} · ${fmtCost(m.cost)}</span></div>`).join('')}</div>` : '<div class="muted-sm">aucune donnée de modèle</div>'}
    </div>`).join('') || '<p class="muted">Aucune session enregistrée pour cette tâche.</p>';
  showModal(`
    <div class="modal modal-wide">
      <h2>Consommation — <span class="code">${esc(taskId)}</span></h2>
      <div class="cons-total">
        <strong>Total (toutes sessions)</strong>
        <div class="cons-chips">${tokenChips(total.tokens, total.cost)}</div>
      </div>
      <div class="commit-list">${sessionRows}</div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
}

// --- Archivage / restauration ---------------------------------------------
function snapshotList(snap) {
  const items = [
    ['Exécutions', snap.executions],
    ['Événements', snap.events],
    ['Documents', snap.artifacts],
    ['Plans', snap.plans],
    ['Déploiements', snap.deployments],
    ['Décisions', snap.decisions],
  ];
  return items.map(([lbl, n]) => `<div class="archive-item"><span>${esc(lbl)}</span><strong>${n}</strong></div>`).join('');
}

function snapshotSummary(snap) {
  const parts = [];
  if (snap.executions) parts.push(`${snap.executions} exéc`);
  if (snap.events) parts.push(`${snap.events} évt`);
  if (snap.artifacts) parts.push(`${snap.artifacts} doc`);
  if (snap.plans) parts.push(`${snap.plans} plans`);
  if (snap.deployments) parts.push(`${snap.deployments} dép`);
  if (snap.decisions) parts.push(`${snap.decisions} déc`);
  return parts.join(' · ') || '—';
}

function showModal(innerHtml) {
  const bd = document.getElementById('modal-backdrop');
  bd.innerHTML = innerHtml;
  bd.hidden = false;
}

function closeModal() {
  const bd = document.getElementById('modal-backdrop');
  bd.hidden = true;
  bd.innerHTML = '';
}

// Garde commune « aucun projet ouvert » des modales de création (cadrage
// technique / recette évaluateur) : sans projet ouvert, la création est
// DÉSACTIVÉE (bouton submit désactivé) et un message explicite est affiché —
// jamais de combo de secours. Retourne l'état (true = un projet est ouvert).
function applyNoProjectGuard(formId, msgId) {
  const hasProject = !!currentProject;
  const form = document.getElementById(formId);
  if (form) {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = !hasProject;
  }
  if (!hasProject) {
    const msg = document.getElementById(msgId);
    if (msg) { msg.textContent = 'Aucun projet ouvert — ouvrez un projet avant de créer.'; msg.className = 'msg error'; }
  }
  return hasProject;
}

async function openArchiveConfirm(taskId) {
  let snap;
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/archive-preview`);
    snap = r.snapshot || {};
  } catch (e) {
    alert('Impossible de préparer l\'archivage : ' + (e.message || e));
    return;
  }
  showModal(`
    <div class="modal">
      <h2>Archiver la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <p>L'archivage masquera la tâche <strong>et tous les éléments qui lui sont rattachés</strong> du panneau. Rien n'est supprimé : la restauration ramène l'ensemble.</p>
      <div class="archive-list">${snapshotList(snap)}</div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="modal-confirm">Archiver</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Archivage');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      alert('Échec de l\'archivage : ' + (e.message || e));
    }
  };
}

function openRestoreConfirm(taskId, archive) {
  const snap = (archive && archive.snapshot) || {};
  showModal(`
    <div class="modal">
      <h2>Restaurer la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <p>La restauration réaffichera la tâche et tous les éléments archivés avec elle dans le panneau.</p>
      <div class="archive-list">${snapshotList(snap)}</div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="restore-btn" id="modal-confirm">Restaurer</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Restauration');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/restore`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      alert('Échec de la restauration : ' + (e.message || e));
    }
  };
}

function openDeleteConfirm(taskId, archive) {
  const snap = (archive && archive.snapshot) || {};
  showModal(`
    <div class="modal">
      <h2>Supprimer définitivement</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <p class="warn">Cette action est <strong>irréversible</strong>. La tâche et tous les éléments qui lui sont rattachés seront <strong>supprimés définitivement</strong> du registre (aucune restauration possible).</p>
      <div class="archive-list">${snapshotList(snap)}</div>
      <p class="muted-sm">Pour confirmer, saisissez l'identifiant de la tâche :</p>
      <input id="delete-confirm-input" class="confirm-input" placeholder="T-…" autocomplete="off">
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="modal-confirm" disabled>Supprimer définitivement</button>
      </div>
    </div>`);
  const input = document.getElementById('delete-confirm-input');
  const btn = document.getElementById('modal-confirm');
  input.addEventListener('input', () => { btn.disabled = input.value.trim() !== taskId; });
  document.getElementById('modal-cancel').onclick = closeModal;
  btn.onclick = async () => {
    if (input.value.trim() !== taskId) return;
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Suppression');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/delete`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      alert('Échec de la suppression : ' + (e.message || e));
    }
  };
}

async function renderArchives() {
  const data = await api('/api/archives');
  const all = data.archives || [];
  const archives = currentProject ? all.filter((a) => (a.task && a.task.project) === currentProject) : all;
  document.getElementById('pane-archives').innerHTML = `
    <h2>Archives</h2>
    <p class="muted-sm">Une tâche archivée masque aussi tous les éléments qui lui sont rattachés (événements, documents, déploiements, décisions).</p>
    <table><thead><tr><th>Tâche</th><th>Projet</th><th>Type</th><th>Demande</th><th>Contenu archivé</th><th>Archivée le</th><th>Par</th><th></th></tr></thead>
    <tbody>${archives.map((a) => `<tr><td class="code">${esc(a.task_id)}</td><td>${esc(a.task?.project || '—')}</td><td>${esc(a.task?.type || '—')}</td><td>${esc((a.task?.request || '').slice(0, 70))}</td><td class="muted-sm">${esc(snapshotSummary(a.snapshot))}</td><td class="code">${esc((a.archived_at || '').replace('T', ' ').slice(0, 19))}</td><td>${esc(a.archived_by || '—')}</td><td>${ME && ME.is_admin ? `<div class="icon-actions"><button class="icon-btn" data-restore="${esc(a.task_id)}">Restaurer</button><button class="icon-btn danger-btn" data-delete="${esc(a.task_id)}">Supprimer</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune tâche archivée</td></tr>'}</tbody></table>`;
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => openRestoreConfirm(b.dataset.restore, archives.find((a) => a.task_id === b.dataset.restore))));
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => openDeleteConfirm(b.dataset.delete, archives.find((a) => a.task_id === b.dataset.delete))));
}

// --- Écosystème OpenCode (agents, MCP, skills, plugins) ---------------------
const TRUNCATE = 170;

// Texte complet conservé hors du DOM (évite d'embarquer de gros contenus dans
// les attributs HTML) : la carte n'affiche qu'un extrait, la modale le tout.
const ECO_TEXTS = new Map();
let ecoSeq = 0;
function ecoStore(title, text) {
  const key = 'eco' + (++ecoSeq);
  ECO_TEXTS.set(key, { title, text: String(text ?? '') });
  return key;
}

function truncate(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  return t.slice(0, n).trimEnd() + '…';
}

function permBadge(value) {
  const cls = { allow: 'approved', deny: 'rejected', ask: 'awaiting' }[value] || 'queued';
  return `<span class="badge ${cls}">${esc(value)}</span>`;
}

// Extrait tronqué affiché dans la carte ; "Voir plus" ouvre la modale complète.
function descBlock(title, cardText, fullText) {
  const card = String(cardText || '');
  const full = String(fullText ?? card);
  if (!card) return '';
  if (full.length <= TRUNCATE) return `<p class="eco-desc">${esc(card)}</p>`;
  const key = ecoStore(title, full);
  return `<p class="eco-desc">${esc(truncate(card, TRUNCATE))} <button class="eco-more" data-eco="${key}">Voir plus</button></p>`;
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    done(ok);
  } catch { done(false); }
}

function openEcoModal(key) {
  const data = ECO_TEXTS.get(key) || { title: 'Détail', text: '' };
  showModal(`
    <div class="modal modal-wide">
      <h2>${esc(data.title)}</h2>
      <pre class="eco-modal-body">${esc(data.text)}</pre>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Fermer</button>
        <button id="modal-copy">Copier</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-copy').onclick = () => {
    const mark = (ok) => {
      const b = document.getElementById('modal-copy');
      if (!b) return;
      b.textContent = ok ? 'Copié ✓' : 'Copie impossible';
      setTimeout(() => { if (b) b.textContent = 'Copier'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data.text).then(() => mark(true), () => fallbackCopy(data.text, mark));
    } else {
      fallbackCopy(data.text, mark);
    }
  };
}

function agentCard(a) {
  const perms = (a.permission || []).map((p) => `<span class="perm" title="${esc(p.value)}">${esc(p.tool)} ${permBadge(p.value)}</span>`).join('');
  const meta = [
    a.mode ? `<span class="badge">${esc(a.mode)}</span>` : '',
  ].filter(Boolean).join(' ');
  const full = [a.description, a.body].filter(Boolean).join('\n\n');
  const modelRow = `<div class="eco-model-row">
    <span class="muted-sm">Modèle</span>
    <code class="muted-sm">${esc(a.model || '—')}</code>
    ${IS_ADMIN ? `<button class="ghost eco-model-btn" data-edit-model="${esc(a.name)}" data-model="${esc(a.model || '')}">Modifier</button>` : ''}
  </div>`;
  return `<article class="eco-card">
    <div class="eco-card-head"><strong>${esc(a.name)}</strong>${meta}</div>
    ${descBlock(a.name, a.description, full)}
    ${modelRow}
    ${perms ? `<div class="eco-perms">${perms}</div>` : ''}
  </article>`;
}

function mcpCard(m) {
  const state = m.enabled === false ? '<span class="badge rejected">désactivé</span>' : (m.enabled === true ? '<span class="badge approved">actif</span>' : '<span class="badge queued">inconnu</span>');
  const tools = m.tools.length ? `<div class="eco-tools"><span class="muted-sm">${m.tools.length} outils</span><div>${m.tools.map((t) => `<code>${esc(t)}</code>`).join('')}</div></div>` : '';
  const full = [m.description, m.command ? `Commande : ${m.command}` : ''].filter(Boolean).join('\n\n');
  return `<article class="eco-card">
    <div class="eco-card-head"><strong>${esc(m.name)}</strong>${state}${m.version ? `<span class="code muted-sm">v${esc(m.version)}</span>` : ''}</div>
    ${descBlock(m.name, m.description, full)}
    ${tools}
    ${m.command ? `<div class="eco-cmd muted-sm">${esc(m.command)}</div>` : ''}
  </article>`;
}

function skillCard(s) {
  const full = [s.description, s.body].filter(Boolean).join('\n\n');
  return `<article class="eco-card">
    <div class="eco-card-head"><strong>${esc(s.name)}</strong></div>
    ${descBlock(s.name, s.description, full)}
  </article>`;
}

function pluginCard(p) {
  const state = p.enabled ? '<span class="badge approved">actif</span>' : '<span class="badge queued">non référencé</span>';
  return `<article class="eco-card">
    <div class="eco-card-head"><strong class="code">${esc(p.name)}</strong>${state}</div>
  </article>`;
}

async function renderEcosystem() {
  const e = await api('/api/ecosystem');
  const section = (title, count, cards) =>
    `<section class="eco-section"><h2>${esc(title)} <span class="muted-sm">${count}</span></h2><div class="eco-grid">${cards}</div></section>`;
  document.getElementById('pane-ecosystem').innerHTML = `
    <div class="eco-summary muted-sm">Écosystème découvert dynamiquement depuis <code>${esc(e.dir || '~/.config/opencode')}</code></div>
    ${ME && ME.is_admin ? `<div class="eco-restart-bar"><button class="launch-btn" id="eco-restart-all" title="Redémarre chaque instance systemd opencode@&lt;user&gt;.service (+ opencode.service) pour recharger la config des agents">Redémarrer toutes les sessions opencode</button><span id="eco-restart-msg"></span></div>` : ''}
    ${section('Agents', e.agents.length, e.agents.map(agentCard).join('') || '<p class="muted">Aucun agent</p>')}
    ${section('Serveurs MCP', e.mcp.length, e.mcp.map(mcpCard).join('') || '<p class="muted">Aucun serveur MCP</p>')}
    ${section('Skills', e.skills.length, e.skills.map(skillCard).join('') || '<p class="muted">Aucun skill</p>')}
    ${section('Plugins', e.plugins.length, e.plugins.map(pluginCard).join('') || '<p class="muted">Aucun plugin</p>')}`;
  document.querySelectorAll('#pane-ecosystem [data-eco]').forEach((b) => b.addEventListener('click', () => openEcoModal(b.dataset.eco)));
  document.querySelectorAll('#pane-ecosystem [data-edit-model]').forEach((b) => b.addEventListener('click', () => editAgentModelModal(b.dataset.editModel, b.dataset.model)));
  const ecoRestartBtn = document.getElementById('eco-restart-all');
  if (ecoRestartBtn) ecoRestartBtn.onclick = restartAllOpencodeSessions;
}

// --- Workspaces Coder (admin) ------------------------------------------------
async function renderWorkspaces() {
  const r = await fetch('/api/workspaces');
  if (r.status === 403) { document.getElementById('pane-workspaces').innerHTML = '<p class="muted">Réservé aux administrateurs.</p>'; return; }
  const data = await r.json();
  const wsList = data.workspaces || data.discovered || [];
  const stateLabel = (w) => {
    if (w.transitioning && w.coderTransition) {
      const map = { start: 'starting', stop: 'stopping', restart: 'restarting', delete: 'deleting' };
      return map[w.coderTransition] || `${w.coderTransition}…`;
    }
    if (w.coderStatus) return w.coderStatus;
    return w.running ? 'running' : (w.status || 'stopped');
  };
  const isRunning = (w) => {
    if (w.coderStatus) return w.coderStatus === 'running';
    return !!w.running;
  };
  const statusBadge = (w) => {
    const s = stateLabel(w);
    const cls = ['starting', 'stopping', 'restarting', 'deleting', 'pending', 'building'].includes(s) ? 'queued' : s;
    return `<span class="badge ${cls}">${esc(s)}</span>`;
  };
  const attachedProjectsList = (w) => (w.attachedProjects || []).length
    ? w.attachedProjects.map((p) => `<code class="chip-repo">${esc(p)}</code>`).join(' ')
    : '<span class="muted-sm">—</span>';
  const ideBadge = (w) => w.ideUrl ? `<a class="badge running ws-ide" href="/api/coder/ide?url=${encodeURIComponent(w.ideUrl)}" target="_blank" rel="noopener" title="Ouvrir l'IDE web Coder (session Coder posée automatiquement)">IDE</a>` : '';
  document.getElementById('pane-workspaces').innerHTML = `
    <h2>Workspaces Coder <span class="muted-sm">— ${wsList.length} workspace(s)</span></h2>
    ${IS_ADMIN ? `<div class="eco-restart-bar"><button class="launch-btn" id="ws-create-btn">Créer un workspace</button><span id="ws-msg" class="muted-sm"></span></div>` : ''}
    <table><thead><tr><th>Workspace</th><th>Propriétaire</th><th>Statut</th><th>IDE</th><th>Conteneur</th><th>Volume</th><th>Projets</th>${IS_ADMIN ? '<th>Actions</th>' : ''}</tr></thead>
    <tbody>${wsList.map((w) => {
      const busy = !!(w.transitioning);
      const running = isRunning(w);
      return `<tr>
      <td><strong>${esc(w.name)}</strong></td>
      <td>${esc(w.owner || '—')}</td>
      <td>${statusBadge(w)}</td>
      <td>${running ? ideBadge(w) : '<span class="muted-sm">—</span>'}</td>
      <td><code class="muted-sm">${esc(w.container || '—')}</code></td>
      <td><code class="muted-sm">${esc((w.volume || '').slice(0, 30))}</code></td>
      <td>${attachedProjectsList(w)}</td>
      ${IS_ADMIN ? `<td class="icon-actions">
        <button class="ghost tiny" data-ws-detail="${esc(w.name)}" data-ws-ide="${esc(w.ideUrl || '')}" title="Détails du workspace">Détail</button>
        ${running
          ? `<button class="ghost tiny" data-ws-stop="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Arrêter le workspace">Stop</button>
             <button class="ghost tiny" data-ws-restart="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Redémarrer le workspace">Restart</button>`
          : `<button class="ghost tiny" data-ws-start="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Démarrer le workspace">Start</button>`}
        <button class="danger tiny" data-ws-delete="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Supprimer le workspace">Supprimer</button>
      </td>` : ''}
    </tr>`;
    }).join('')}</tbody></table>`;
  // Événements
  const createBtn = document.getElementById('ws-create-btn');
  if (createBtn) createBtn.addEventListener('click', () => workspaceCreateModal());
  document.querySelectorAll('#pane-workspaces [data-ws-detail]').forEach((b) => b.addEventListener('click', () => workspaceDetailModal(b.dataset.wsDetail, b.dataset.wsIde || null)));
  document.querySelectorAll('#pane-workspaces [data-ws-start]').forEach((b) => b.addEventListener('click', (ev) => workspaceAction(b.dataset.wsStart, 'start', ev.currentTarget)));
  document.querySelectorAll('#pane-workspaces [data-ws-stop]').forEach((b) => b.addEventListener('click', (ev) => workspaceAction(b.dataset.wsStop, 'stop', ev.currentTarget)));
  document.querySelectorAll('#pane-workspaces [data-ws-restart]').forEach((b) => b.addEventListener('click', (ev) => workspaceAction(b.dataset.wsRestart, 'restart', ev.currentTarget)));
  document.querySelectorAll('#pane-workspaces [data-ws-delete]').forEach((b) => b.addEventListener('click', (ev) => workspaceDelete(b.dataset.wsDelete, ev.currentTarget)));
}

async function workspaceAction(name, action, trigger) {
  const labels = { start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' };
  if (!confirm(`${labels[action] || action} le workspace « ${name} » ?`)) return;
  setWSActionBusy(trigger, labels[action] || action);
  const msg = document.getElementById('ws-msg');
  if (msg) { msg.textContent = `${labels[action] || action} « ${name} »…`; msg.className = 'muted-sm'; }
  try {
    const r = await fetch(`/api/workspaces/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    if (msg) { msg.textContent = `${labels[action] || action} « ${name} » lancé.`; msg.className = 'msg'; }
    followWorkspaces(name);
  } catch (e) {
    if (trigger) { trigger.disabled = false; trigger.innerHTML = labels[action] || action; }
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  }
}

async function workspaceDelete(name, trigger) {
  if (!confirm(`Supprimer le workspace « ${name} » ?\nCette action est irréversible (conteneur + volume supprimés).`)) return;
  setWSActionBusy(trigger, 'Suppression');
  const msg = document.getElementById('ws-msg');
  if (msg) { msg.textContent = `Suppression de « ${name} »…`; msg.className = 'muted-sm'; }
  try {
    const r = await fetch(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    if (msg) { msg.textContent = `Workspace « ${name} » supprimé (en cours).`; msg.className = 'msg'; }
    followWorkspaces(name);
  } catch (e) {
    if (trigger) { trigger.disabled = false; trigger.innerHTML = 'Supprimer'; }
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  }
}

// Indication visuelle générique sur un bouton cliqué : désactivé + spinner + libellé "…".
// Évite les double-clics (l'action peut être longue : session, clôture, suppression…).
function setBtnBusy(btn, label) {
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('ws-busy');
  btn.innerHTML = `<span class="ws-spinner"></span> ${esc(label || 'en cours')}…`;
}

// Indication visuelle sur le bouton cliqué : désactivé + spinner + libellé "…".
function setWSActionBusy(btn, action) {
  setBtnBusy(btn, action);
}

// Suit l'évolution du statut après une action : re-rendu périodique de la table
// jusqu'à ce que le workspace disparaisse (delete) ou que sa transition se stabilise.
function followWorkspaces(name) {
  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    try { await renderWorkspaces(); } catch { /* pane requête échouée */ }
    const row = [ ...(document.querySelectorAll('#pane-workspaces [data-ws-detail]') || []) ].find((b) => b.dataset.wsDetail === name);
    const gone = !row;
    let stable = false;
    if (row) {
      const tr = row.closest('tr');
      const cell = tr && tr.querySelector('.badge');
      const label = cell ? cell.textContent.trim() : '';
      stable = cell && !/starting|stopping|restarting|deleting|pending|building/.test(label);
    }
    if (gone || stable || polls >= 20) { clearInterval(timer); }
  }, 3000);
}

async function workspaceDetailModal(name, ideUrl) {
  let detail = null, error = null;
  try { detail = await api(`/api/workspaces/${encodeURIComponent(name)}`); } catch (e) { error = e.message || String(e); }
  const output = detail ? (detail.output || '') : error || 'Aucune donnée';
  const ideBtn = ideUrl ? `<a class="badge running ws-ide" href="/api/coder/ide?url=${encodeURIComponent(ideUrl)}" target="_blank" rel="noopener" style="margin-left:8px">Ouvrir l'IDE</a>` : '';
  showModal(`
    <div class="modal">
      <h2>Workspace — ${esc(name)}${ideBtn}</h2>
      <pre class="modal-pre">${esc(output)}</pre>
      <div class="modal-actions"><button class="ghost" onclick="closeModal()">Fermer</button></div>
    </div>`);
}

function workspaceCreateModal() {
  const orgOpts = ORGANIZATIONS.map((o) => `<option value="${esc(o.id)}" ${o.id === currentOrg ? 'selected' : ''}>${esc(o.name || o.id)}</option>`).join('');
  showModal(`
    <div class="modal">
      <h2>Créer un workspace Coder</h2>
      <p class="muted-sm">Crée un workspace via le template de l'organisation, clone le repo distant et masque le token git.</p>
      <label class="modal-field">Organisation
        <select id="ws-create-org">${orgOpts}</select>
      </label>
      <label class="modal-field">Nom du workspace
        <input id="ws-create-name" placeholder="mon-workspace">
      </label>
      <label class="modal-field">Propriétaire (optionnel — laisser vide pour défaut)
        <input id="ws-create-owner" placeholder="ex: rino">
      </label>
      <label class="modal-field">Template (optionnel — utilise le template par défaut de l'org si vide)
        <input id="ws-create-template" placeholder="ex: debase">
      </label>
      <label class="modal-field">Remote git à cloner (optionnel)
        <input id="ws-create-clone" placeholder="https://github.com/org/repo.git">
      </label>
      <label class="modal-field">Chemin du dépôt dans le workspace (optionnel)
        <input id="ws-create-repo" placeholder="ex: /home/coder/mon-workspace/repo">
      </label>
      <div id="ws-create-msg" class="error"></div>
      <div class="modal-actions">
        <button class="ghost" onclick="closeModal()">Annuler</button>
        <button class="launch-btn" id="ws-create-go">Créer</button>
      </div>
    </div>`);
  document.getElementById('ws-create-go').addEventListener('click', async () => {
    const btn = document.getElementById('ws-create-go');
    const original = btn.innerHTML;
    const msg = document.getElementById('ws-create-msg');
    const org = document.getElementById('ws-create-org').value;
    const name = document.getElementById('ws-create-name').value.trim();
    if (!name) { msg.textContent = 'Nom requis'; return; }
    setBtnBusy(btn, 'Création');
    const body = {
      name,
      org,
      owner: document.getElementById('ws-create-owner').value.trim() || undefined,
      template: document.getElementById('ws-create-template').value.trim() || undefined,
      clone: document.getElementById('ws-create-clone').value.trim() || undefined,
      repo: document.getElementById('ws-create-repo').value.trim() || undefined,
    };
    msg.textContent = 'Création en cours…'; msg.className = 'muted-sm';
    try {
      const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      msg.textContent = ''; closeModal(); renderWorkspaces();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = e.message || String(e); msg.className = 'msg error';
    }
  });
}

// Redémarrage de TOUTES les instances systemd opencode (admin) — recharge la
// config des agents sur chaque instance opencode@<user>.service + opencode.service.
async function restartAllOpencodeSessions() {
  if (!confirm('Redémarrer toutes les sessions opencode ?\nChaque instance systemd opencode@<user>.service (et opencode.service) sera relancée. Les sessions en cours seront interrompues.')) return;
  const btn = document.getElementById('eco-restart-all');
  const msg = document.getElementById('eco-restart-msg');
  const prevHtml = btn ? btn.innerHTML : '';
  setBtnBusy(btn, 'Redémarrage');
  if (msg) { msg.textContent = ''; msg.className = ''; }
  try {
    const r = await fetch('/api/opencode/restart-all', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    const restarted = (d.restarted || []).join(', ') || 'aucune';
    const failed = (d.failed || []);
    let html = `Redémarrées : <code>${esc(restarted)}</code>`;
    if (d.notice) html += `<br><span class="muted-sm">${esc(d.notice)}</span>`;
    if (failed.length) html += `<br><span class="error">Échecs : ${failed.map((f) => `<code>${esc(f.unit)}</code> — ${esc(f.error)}`).join('<br>')}</span>`;
    if (msg) { msg.innerHTML = html; msg.className = failed.length ? 'msg error' : 'msg'; }
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = prevHtml; }
  }
}

// --- Édition globale du modèle d'un agent (Écosystème) ----------------------
async function editAgentModelModal(name, currentModel) {
  let models = [];
  try { models = (await api('/api/models')).models || []; } catch {}
  let opts = models.map((m) => `<option value="${esc(m)}" ${m === currentModel ? 'selected' : ''}>${esc(m)}</option>`).join('');
  if (currentModel && !models.includes(currentModel)) {
    opts = `<option value="${esc(currentModel)}" selected>${esc(currentModel)}</option>` + opts;
  }
  showModal(`
    <div class="modal">
      <h2>Modèle — <span class="code">${esc(name)}</span></h2>
      <p class="muted-sm">Modification <strong>globale</strong> du modèle de cet agent (s'applique à toutes les tâches futures).</p>
      <select id="agent-model-select" class="model-select">${opts}</select>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="modal-confirm">Enregistrer</button>
      </div>
      <div id="model-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Enregistrement');
    const model = document.getElementById('agent-model-select').value;
    const msg = document.getElementById('model-msg');
    try {
      await api(`/api/agents/${encodeURIComponent(name)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      closeModal();
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = e.message; msg.className = 'msg error';
    }
  };
}

// --- Projets (cartes + CRUD) ----------------------------------------------
async function renderProjects() {
  const projs = await api('/api/projects');
  const projects = (projs.projects || []).filter((p) => !currentOrg || (p.organizationId || 'onirtech') === currentOrg);
  const repos = await api('/api/repos').catch(() => ({ repos: [] }));
  const repoMap = new Map((repos.repos || []).map((r) => [r.id, r]));
  document.getElementById('pane-projects').innerHTML = `
    <h2>Projets <span class="muted-sm">${currentOrg ? '— ' + esc(currentOrg) : ''}</span></h2>
    <div class="projects-toolbar">
      <button id="new-project-btn" class="launch-btn">+ Nouveau projet</button>
    </div>
    <div class="project-cards">
      ${projects.map((p) => {
        const pRepos = (p.repos || []).map((rid) => repoMap.get(rid)).filter(Boolean);
        const repoBadges = pRepos.length
          ? pRepos.map((r) => `<code class="chip-repo" title="Repo associé">${esc(r.id)}</code>`).join(' ')
          : '<span class="muted-sm">aucun repo</span>';
        return `
        <article class="project-card project-card-compact">
          <div class="project-card-head">
            <strong class="project-title" data-project-detail="${esc(p.id)}" title="Voir le détail du projet">${esc(p.name || p.id)}</strong>
            <code class="muted-sm">${esc(p.id)}</code>
          </div>
          <div class="project-card-body">
            <div class="project-kv"><span class="lbl">Repos</span><div class="repo-badges">${repoBadges}</div></div>
          </div>
          <div class="project-card-actions">
            <button class="ghost" data-open-project="${esc(p.id)}" title="Ouvrir le projet : tâches, cadrages, tests E2E, déploiements, décisions, plans, archives…">Ouvrir</button>
            <button class="ghost" data-project-detail="${esc(p.id)}" title="Détails du projet (modifier, repos, documents…)">Détail</button>
          </div>
        </article>`;
      }).join('') || '<p class="muted">Aucun projet enregistré.</p>'}
    </div>`;
  document.getElementById('new-project-btn').addEventListener('click', () => projectFormModal(null));
  document.querySelectorAll('[data-open-project]').forEach((b) => b.addEventListener('click', () => openProject(b.dataset.openProject)));
  document.querySelectorAll('[data-project-detail]').forEach((b) => b.addEventListener('click', () => projectDetailModal(b.dataset.projectDetail)));
}

// ===========================================================================
// Modale DÉTAIL PROJET UNIQUE (responsive, bon UX) : regroupe TOUT en onglets
// internes — Projet (modifier/supprimer), Repos (associer/éditer/retirer),
// Pièces client (ajouter/supprimer/télécharger). Aucune sous-modale.
// (L'onglet « Documents de référence » a été retiré : doublon avec « Pièces
//  client », les documents ADR-12 étant désormais requalifiés en pièces client.)
// ===========================================================================
async function projectDetailModal(projectId, tab = 'projet') {
  // Onglets valides après retrait de « Documents de référence » : tout onglet
  // inconnu (ex. ancien deep-link 'docs') retombe sur « projet ».
  if (!['projet', 'repos', 'pieces'].includes(tab)) tab = 'projet';
  let projects = [], repos = [], allPieces = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  try { repos = ((await api(`/api/repos?project=${encodeURIComponent(projectId)}`)).repos || []); } catch {}
  const p0 = projects.find((x) => x.id === projectId);
  if (!p0) { alert('Projet introuvable'); return; }

  const loadPieces = async () => {
    try { allPieces = ((await api(`/api/pieces?projectId=${encodeURIComponent(projectId)}`)).pieces || []); }
    catch { allPieces = []; }
  };
  await loadPieces();

  const repoMap = () => new Map(repos.map((r) => [r.id, r]));

  const render = () => {
    const p = projects.find((x) => x.id === projectId) || p0;
    const rm = repoMap();
    const pRepos = (p.repos || []).map((rid) => rm.get(rid)).filter(Boolean);
    const pPieces = allPieces;
    const tabs = [
      ['projet', 'Projet'],
      ['repos', `Repos (${pRepos.length})`],
      ['pieces', `Pièces client (${pPieces.length})`],
    ];
    showModal(`
      <div class="modal modal-wide modal-project-detail">
        <div class="finish-head"><h2 style="margin:0">${esc(p.name || p.id)}</h2>
          <code class="chip">${esc(p.id)}</code></div>
        <div class="pd-tabs">
          ${tabs.map(([t, l]) => `<button type="button" class="pd-tab ${t === tab ? 'active' : ''}" data-pd-tab="${t}">${esc(l)}</button>`).join('')}
        </div>
        <div class="pd-panel" id="pd-panel"></div>
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
        <div id="pd-msg" class="msg"></div>
      </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
    document.querySelectorAll('.pd-tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.pdTab; render(); }));
    const panel = document.getElementById('pd-panel');
    if (tab === 'projet') panel.innerHTML = projetTabHtml(p);
    else if (tab === 'repos') panel.innerHTML = reposTabHtml(p, pRepos);
    else if (tab === 'pieces') panel.innerHTML = piecesTabHtml(p, pPieces);
    else panel.innerHTML = projetTabHtml(p);
    wire();
  };

  const msg = (text, ok = true) => { const m = document.getElementById('pd-msg'); if (m) { m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'error'); } };

  // --- Onglet PROJET : identité (modifier) + suppression --------------------
  const projetTabHtml = (p) => `
    <form id="pd-projet-form" class="pilot-form">
      <label class="modal-field">Identifiant <span class="muted-sm">— non modifiable</span>
        <input id="pd-p-id" value="${esc(p.id)}" readonly>
      </label>
      <label class="modal-field">Nom lisible
        <input id="pd-p-name" value="${esc(p.name || '')}" required>
      </label>
      <div class="muted-sm">Créé le ${esc((p.createdAt || '').replace('T', ' ').slice(0, 19))}</div>
      <div class="actions-buttons">
        <button type="submit" class="launch-btn">Enregistrer</button>
        <button type="button" class="danger" id="pd-p-del">Supprimer le projet</button>
      </div>
    </form>`;

  // --- Onglet REPOS : associer / éditer / retirer ---------------------------
  const reposTabHtml = (p, pRepos) => {
    const rm = repoMap();
    const linked = new Set(pRepos.map((r) => r.id));
    const available = [...rm.values()].filter((r) => !linked.has(r.id));
    const orgId = p.organizationId || currentOrg || 'onirtech';
    const orgInfo = ORGANIZATIONS.find((o) => o.id === orgId) || {};
    const gitTokens = (orgInfo.gitTokens || []);
    return `
      <div class="actions-section"><h3>Repos associés (${pRepos.length})</h3>
        ${pRepos.length ? `<div class="repo-detail-list">${pRepos.map((r) => {
          const assocGitTokenId = r.gitTokenId || null;
          const assocGitTokenName = assocGitTokenId ? (gitTokens.find((t) => t.id === assocGitTokenId) || {}).name || assocGitTokenId : null;
          return `
          <div class="repo-detail">
            <div class="repo-detail-head"><strong>${esc(r.name || r.id)}</strong> <code class="chip-repo">${esc(r.id)}</code>
              ${r.workspace ? `<span class="muted-sm">· ws <code>${esc(r.workspace)}</code></span>` : ''}
              ${r.mainBranch ? `<span class="muted-sm">· branche <code>${esc(r.mainBranch)}</code></span>` : ''}
              ${assocGitTokenName ? `<span class="muted-sm">· 🔑 <code>${esc(assocGitTokenName)}</code></span>` : ''}
            </div>
            ${r.description ? `<div class="muted-sm">${esc(r.description)}</div>` : ''}
            ${r.deploy ? `<div class="muted-sm"><strong>Déploiement :</strong> ${esc(String(r.deploy).replace(/\s+/g, ' ').slice(0, 140))}</div>` : ''}
            ${r.repoDir ? `<div class="muted-sm">Répertoire : <code>${esc(r.repoDir)}</code></div>` : ''}
            ${r.e2eBaseUrl ? `<div class="muted-sm">E2E : <code>${esc(r.e2eBaseUrl)}</code>${r.e2eRepoDir ? ' · ' + esc(r.e2eRepoDir) : ''}</div>` : ''}
            <div class="repo-mini-actions">
              <button class="ghost tiny" data-pd-edit-repo="${esc(r.id)}">Modifier</button>
              ${!r.workspace ? `<button class="ghost tiny" data-pd-provision-repo="${esc(r.id)}" data-pd-provision-git-token="${esc(r.gitTokenId || '')}" title="Aucun workspace Coder — créer le workspace associé (clone + tokens)">Provisionner</button>` : ''}
              <button class="ghost tiny danger-text" data-pd-unlink-repo="${esc(r.id)}">Retirer</button>
            </div>
          </div>`;
        }).join('')}</div>` : '<p class="muted-sm">Aucun repo associé.</p>'}
      </div>
      <div class="actions-section"><h3>Associer un repo existant</h3>
        ${available.length ? `<div class="pd-inline">
          <select id="pd-link-repo">${available.map((r) => `<option value="${esc(r.id)}">${esc(r.name || r.id)}</option>`).join('')}</select>
          <input id="pd-link-role" placeholder="rôle (frontend, backend…)">
          ${gitTokens.length ? `<select id="pd-link-git-token"><option value="">— token par défaut —</option>${gitTokens.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>` : ''}
          <button type="button" class="launch-btn" id="pd-link-go">Associer</button>
        </div>` : '<p class="muted-sm">Tous les repos enregistrés sont déjà associés.</p>'}
      </div>
      <div class="actions-section"><h3>Nouveau repo</h3>
        <form id="pd-repo-form" class="pilot-form">
          <input id="pd-r-id" placeholder="identifiant (ex: mada-talk)" required>
          <input id="pd-r-name" placeholder="nom lisible">
          <input id="pd-r-repodir" placeholder="répertoire du dépôt (ex: /var/lib/docker/volumes/coder-…/_data/mada-talk)">
          <input id="pd-r-giturl" placeholder="remote git (ex: https://github.com/org/repo.git)">
          <input id="pd-r-ws" placeholder="workspace Coder (ex: madatalk)">
          <input id="pd-r-branch" placeholder="branche de déploiement (ex: main)">
          <input id="pd-r-e2e-url" placeholder="URL E2E (ex: https://preprod-client.madatalk.fr)">
          <div class="actions-buttons"><button type="submit" class="ghost">+ Créer et associer</button></div>
        </form>
      </div>`;
  };

  // --- Onglet PIÈCES CLIENT (ADR-001, item 4) : ajouter / voir / supprimer ---
  // Natures admises : markdown | pdf | docx | lien Drive public. PHOTO/VIDÉO
  // refusées (garde MCP + garde miroir serveur). Lien public = avertissement.
  const piecesTabHtml = (p, pPieces) => {
    const natLabel = (n) => ({ markdown: 'Markdown', pdf: 'PDF', docx: 'DOCX', lien: 'Lien (Drive public)' }[n] || n || '—');
    const newPieces = pPieces.filter((x) => !x.requalified);
    const requalified = pPieces.filter((x) => x.requalified);
    const row = (d) => `
      <div class="recette-item">
        <div><code class="chip">${esc(natLabel(d.nature))}</code> <strong>${esc(d.title || d.pieceId)}</strong>
          ${d.emergent ? `<span class="chip" title="reçue après l'initialisation d'un sprint (${esc(d.emergentOrigin || '')})">émergente${d.sprintId ? ' · ' + esc(d.sprintId) : ''}</span>` : ''}
          ${d.requalified ? '<span class="chip" title="Document ADR-12 requalifié pièce client (source, plus référence normative exclusive)">requalifiée</span>' : ''}
        </div>
        ${d.url ? `<div class="muted-sm">🔗 <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a></div>` : ''}
        ${d.path ? `<div class="muted-sm">${esc(d.path)}</div>` : ''}
        ${d.securityNote ? `<div class="muted-sm" title="limite de sécurité du lien public">⚠️ ${esc(d.securityNote)}</div>` : ''}
        <div class="e2e-actions">
          ${d.path && !d.url ? `<button type="button" class="ghost tiny" data-piece-dl="${esc(d.path)}">Télécharger</button>` : ''}
          ${!d.requalified ? `<button type="button" class="ghost tiny danger-text" data-piece-del="${esc(d.pieceId)}">Supprimer</button>` : ''}
        </div>
      </div>`;
    return `
      <p class="muted-sm">Pièces client — <strong>matière première des sprints</strong>. Natures admises : <strong>markdown, pdf, docx, lien Drive public</strong>. Les <strong>photos et vidéos sont refusées</strong>. Un lien doit être <strong>public</strong> (l'agent lit le contenu via l'URL) : toute personne disposant de l'URL y accède — <strong>limite de sécurité assumée</strong>, ne jamais y placer de contenu sensible.</p>
      <div id="pd-list" class="recette-list" style="max-height:28vh;overflow:auto">
        ${newPieces.length ? newPieces.map(row).join('') : '<p class="muted-sm">Aucune pièce client.</p>'}
      </div>
      ${requalified.length ? `<div class="muted-sm" style="margin-top:8px">Documents ADR-12 requalifiés en pièces client (${requalified.length}) — conservés (chemins, projets/repos, nature).</div>
      <div class="recette-list" style="max-height:20vh;overflow:auto">${requalified.map(row).join('')}</div>` : ''}
      <form id="pd-piece-form" class="pilot-form" style="border-top:1px solid var(--border);padding-top:10px">
        <div class="pd-inline">
          <select id="pd-pc-mode"><option value="upload">Importer un fichier (md/pdf/docx)</option><option value="url">Lien externe public (Drive…)</option><option value="path">Référencer un chemin</option></select>
          <select id="pd-pc-nature"><option value="">nature (auto)</option><option value="markdown">Markdown</option><option value="pdf">PDF</option><option value="docx">DOCX</option><option value="lien">Lien</option></select>
        </div>
        <input id="pd-pc-title" placeholder="titre (ex. Specs fonctionnelles client)">
        <input id="pd-pc-url" placeholder="URL publique (ex. https://drive.google.com/…)" hidden>
        <input id="pd-pc-file" type="file" accept=".md,.markdown,.pdf,.docx">
        <input id="pd-pc-path" placeholder="chemin existant (ex. /home/coder/…/specs.md)" hidden>
        <textarea id="pd-pc-desc" class="modal-textarea" rows="2" placeholder="description (optionnel)"></textarea>
        <div class="actions-buttons"><button type="submit" class="launch-btn">+ Ajouter la pièce</button></div>
      </form>`;
  };

  // --- Wiring des actions (re-render après chaque mutation) -----------------
  const wire = () => {
    const panel = document.getElementById('pd-panel');
    const p = projects.find((x) => x.id === projectId) || p0;
    const pRepos = (p.repos || []).map((rid) => repoMap().get(rid)).filter(Boolean);
    // PROJET : enregistrer / supprimer.
    const pForm = document.getElementById('pd-projet-form');
    if (pForm) pForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button[type="submit"]');
      const original = btn ? btn.innerHTML : null;
      setBtnBusy(btn, 'Enregistrement');
      try {
        await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p0.id, name: document.getElementById('pd-p-name').value.trim() }) });
        projects = ((await api('/api/projects')).projects || []);
        msg('Projet enregistré.'); render();
      } catch (err) {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        msg(err.message || String(err), false);
      }
    });
    const pDel = document.getElementById('pd-p-del');
    if (pDel) pDel.addEventListener('click', async () => {
      if (!confirm(`Supprimer le projet ${p0.id} ? Les tâches conservent leur référence.`)) return;
      const original = pDel.innerHTML;
      setBtnBusy(pDel, 'Suppression');
      try { await api(`/api/projects/${encodeURIComponent(p0.id)}`, { method: 'DELETE' }); closeModal(); refreshActive(); }
      catch (err) {
        pDel.disabled = false; pDel.classList.remove('ws-busy'); pDel.innerHTML = original;
        msg(err.message || String(err), false);
      }
    });
    // REPOS : associer / retirer / éditer / créer.
    const linkGo = document.getElementById('pd-link-go');
    if (linkGo) linkGo.addEventListener('click', async () => {
      const repoId = document.getElementById('pd-link-repo').value;
      const role = document.getElementById('pd-link-role').value.trim() || undefined;
      const gitTokenIdEl = document.getElementById('pd-link-git-token');
      const gitTokenId = gitTokenIdEl && gitTokenIdEl.value.trim() || undefined;
      const original = linkGo.innerHTML;
      setBtnBusy(linkGo, 'Association');
      try {
        await api(`/api/projects/${encodeURIComponent(p0.id)}/repos/${encodeURIComponent(repoId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, gitTokenId }) });
        await refreshDetailData();
        const rr = repoMap().get(repoId);
        if (rr && !rr.workspace) {
          msg('Repo associé — aucun workspace Coder : provisionnement possible.');
          if (IS_ADMIN) provisionRepoModal(rr, { projectId: p0.id, gitTokenId, onProvisioned: async (pr) => { await refreshDetailData(); render(); msg('Repo associé et workspace provisionné : ' + pr.workspace); } });
        } else { msg('Repo associé.'); render(); }
      } catch (err) {
        linkGo.disabled = false; linkGo.classList.remove('ws-busy'); linkGo.innerHTML = original;
        msg(err.message || String(err), false);
      }
    });
    panel.querySelectorAll('[data-pd-unlink-repo]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Retirer le repo ${b.dataset.pdUnlinkRepo} du projet ? Le repo reste enregistré.`)) return;
      const original = b.innerHTML;
      setBtnBusy(b, 'Retrait');
      try {
        await api(`/api/projects/${encodeURIComponent(p0.id)}/repos/${encodeURIComponent(b.dataset.pdUnlinkRepo)}`, { method: 'DELETE' });
        await refreshDetailData(); msg('Repo retiré.'); render();
      } catch (err) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        msg(err.message || String(err), false);
      }
    }));
    panel.querySelectorAll('[data-pd-edit-repo]').forEach((b) => b.addEventListener('click', () => editRepoInline(b.dataset.pdEditRepo)));
    panel.querySelectorAll('[data-pd-provision-repo]').forEach((b) => b.addEventListener('click', () => {
      const rr = repoMap().get(b.dataset.pdProvisionRepo); if (!rr) return;
      provisionRepoModal(rr, { projectId: p0.id, gitTokenId: b.dataset.pdProvisionGitToken || undefined, onProvisioned: async (pr) => { await refreshDetailData(); render(); msg('Workspace provisionné : ' + pr.workspace + ' · ' + (pr.repoDir || '')); } });
    }));
    const rForm = document.getElementById('pd-repo-form');
    if (rForm) rForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button[type="submit"]');
      const original = btn ? btn.innerHTML : null;
      setBtnBusy(btn, 'Création');
      try {
        const body = {
          id: document.getElementById('pd-r-id').value.trim(),
          name: document.getElementById('pd-r-name').value.trim() || undefined,
          repoDir: document.getElementById('pd-r-repodir').value.trim() || undefined,
          gitUrl: document.getElementById('pd-r-giturl').value.trim() || undefined,
          workspace: document.getElementById('pd-r-ws').value.trim() || undefined,
          mainBranch: document.getElementById('pd-r-branch').value.trim() || undefined,
          e2eBaseUrl: document.getElementById('pd-r-e2e-url').value.trim() || undefined,
          organizationId: currentOrg || undefined,
        };
        await api('/api/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await api(`/api/projects/${encodeURIComponent(p0.id)}/repos/${encodeURIComponent(body.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        await refreshDetailData();
        const nrr = repoMap().get(body.id);
        if (body.gitUrl && nrr && !nrr.workspace) {
          msg('Repo créé et associé — aucun workspace Coder : provisionnement possible.');
          if (IS_ADMIN) provisionRepoModal(nrr, { onProvisioned: async (pr) => { await refreshDetailData(); render(); msg('Repo créé, associé et workspace provisionné : ' + pr.workspace); } });
          else render();
        } else { msg('Repo créé et associé.'); render(); }
      } catch (err) {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        msg(err.message || String(err), false);
      }
    });
    // PIÈCES CLIENT : mode + ajout / suppression / téléchargement.
    const pcMode = document.getElementById('pd-pc-mode');
    if (pcMode) {
      const fileEl = document.getElementById('pd-pc-file');
      const urlEl = document.getElementById('pd-pc-url');
      const pathEl = document.getElementById('pd-pc-path');
      const sync = () => {
        const m = pcMode.value;
        fileEl.hidden = m !== 'upload'; urlEl.hidden = m !== 'url'; pathEl.hidden = m !== 'path';
        fileEl.required = m === 'upload'; urlEl.required = m === 'url'; pathEl.required = m === 'path';
      };
      pcMode.addEventListener('change', sync); sync();
    }
    const pcForm = document.getElementById('pd-piece-form');
    if (pcForm) pcForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button[type="submit"]');
      const original = btn ? btn.innerHTML : null;
      setBtnBusy(btn, 'Ajout');
      try {
        const body = {
          projectId: p0.id,
          title: document.getElementById('pd-pc-title').value.trim() || undefined,
          nature: document.getElementById('pd-pc-nature').value || undefined,
          description: document.getElementById('pd-pc-desc').value.trim() || undefined,
        };
        const m = document.getElementById('pd-pc-mode').value;
        if (m === 'upload') {
          const f = document.getElementById('pd-pc-file').files[0];
          if (!f) throw new Error('Choisissez un fichier.');
          if (f.size > 5 * 1024 * 1024) throw new Error('Fichier trop volumineux (max 5 Mo).');
          const bytes = new Uint8Array(await f.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          body.filename = f.name; body.dataBase64 = btoa(bin);
        } else if (m === 'url') {
          body.url = document.getElementById('pd-pc-url').value.trim();
          if (!body.url) throw new Error('URL requise.');
        } else {
          body.path = document.getElementById('pd-pc-path').value.trim();
          if (!body.path) throw new Error('Chemin requis.');
        }
        await api('/api/pieces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await loadPieces(); msg('Pièce ajoutée.'); render();
      } catch (err) {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        msg(err.message || String(err), false);
      }
    });
    panel.querySelectorAll('[data-piece-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Supprimer cette pièce client ?')) return;
      const original = b.innerHTML;
      setBtnBusy(b, 'Suppression');
      try { await api(`/api/pieces/${encodeURIComponent(b.dataset.pieceDel)}`, { method: 'DELETE' }); await loadPieces(); msg('Pièce supprimée.'); render(); }
      catch (err) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        msg(err.message || String(err), false);
      }
    }));
    panel.querySelectorAll('[data-piece-dl]').forEach((b) => b.addEventListener('click', () => {
      window.open(`/api/pieces/file?path=${encodeURIComponent(b.dataset.pieceDl)}`, '_blank');
    }));
  };

  // Édition inline d'un repo (dans l'onglet Repos) : remplace la liste par un formulaire.
  const editRepoInline = (repoId) => {
    const r = repoMap().get(repoId); if (!r) return;
    const panel = document.getElementById('pd-panel');
    panel.innerHTML = `
      <form id="pd-edit-repo-form" class="pilot-form">
        <h3>Modifier le repo <code>${esc(r.id)}</code></h3>
        <input id="pe-id" value="${esc(r.id)}" readonly>
        <input id="pe-name" placeholder="nom lisible" value="${esc(r.name || '')}">
        <input id="pe-description" placeholder="description" value="${esc(r.description || '')}">
        <textarea id="pe-deploy" class="modal-textarea" rows="3" placeholder="mécanisme de déploiement CI/CD">${esc(r.deploy || '')}</textarea>
        <input id="pe-ws" placeholder="workspace Coder" value="${esc(r.workspace || '')}">
        <input id="pe-repodir" placeholder="répertoire du dépôt" value="${esc(r.repoDir || '')}">
        <input id="pe-giturl" placeholder="remote git (ex: https://github.com/org/repo.git)" value="${esc(r.gitUrl || '')}">
        <input id="pe-branch" placeholder="branche de déploiement" value="${esc(r.mainBranch || '')}">
        <input id="pe-e2e-dir" placeholder="checkout E2E (e2eRepoDir)" value="${esc(r.e2eRepoDir || '')}">
        <input id="pe-e2e-url" placeholder="URL E2E (e2eBaseUrl)" value="${esc(r.e2eBaseUrl || '')}">
        <div class="actions-buttons">
          <button type="submit" class="launch-btn">Enregistrer</button>
          <button type="button" class="ghost" id="pe-cancel">Annuler</button>
        </div>
      </form>`;
    document.getElementById('pe-cancel').onclick = () => render();
    document.getElementById('pd-edit-repo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button[type="submit"]');
      const original = btn ? btn.innerHTML : null;
      setBtnBusy(btn, 'Enregistrement');
      try {
        await api('/api/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          id: r.id,
          name: document.getElementById('pe-name').value.trim() || undefined,
          description: document.getElementById('pe-description').value.trim() || undefined,
          deploy: document.getElementById('pe-deploy').value.trim() || undefined,
          workspace: document.getElementById('pe-ws').value.trim() || undefined,
          repoDir: document.getElementById('pe-repodir').value.trim() || undefined,
          gitUrl: document.getElementById('pe-giturl').value.trim() || undefined,
          mainBranch: document.getElementById('pe-branch').value.trim() || undefined,
          e2eRepoDir: document.getElementById('pe-e2e-dir').value.trim() || undefined,
          e2eBaseUrl: document.getElementById('pe-e2e-url').value.trim() || undefined,
        }) });
        await refreshDetailData(); render();
      } catch (err) {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        msg(err.message || String(err), false);
      }
    });
  };

  const refreshDetailData = async () => {
    try { projects = ((await api('/api/projects')).projects || []); } catch {}
    try { repos = ((await api('/api/repos')).repos || []); } catch {}
    await loadPieces();
  };

  render();
}

// Libellé court d'un kind de document (ADR-12).
function docKindLabel(kind) {
  return {
    'adr-tech': 'ADR tech', 'specs-fonctionnelles': 'Specs fonct.', 'scenarios-gherkin': 'Gherkin',
    // doc_type (taxonomie polymorphe — nomenclature-doc-type.md)
    adr: 'ADR tech', specs: 'Specs fonct.', gherkin: 'Gherkin', project_doc: 'Doc projet',
    adr_file: 'Pièce jointe ADR',
  }[kind] || kind;
}
function docKindLabelLong(kind) {
  return {
    'adr-tech': 'ADR — Architecture technique', 'specs-fonctionnelles': 'Spécifications fonctionnelles (User stories / règles métier)', 'scenarios-gherkin': 'Scénarios (Gherkin)',
    adr: 'ADR — Architecture technique', specs: 'Spécifications fonctionnelles (User stories / règles métier)', gherkin: 'Scénarios (Gherkin)',
    project_doc: 'Document de référence du projet',
  }[kind] || kind;
}
const DOC_KIND_ORDER = ['adr-tech', 'specs-fonctionnelles', 'scenarios-gherkin'];

// ===========================================================================
// Onglet ADR (ADR-12 structurée) : référentiel de statuts (miroir de
// ADR_STATUS du registre MCP) + helpers de rendu de la table structurée.
// ===========================================================================
const ADR_STATUS = ['Proposé', 'Accepté', 'Déprécié', 'Remplacé'];

// Badge de statut ADR (réutilise les classes .badge existantes).
function adrStatusBadge(status) {
  const cls = { 'Proposé': 'queued', 'Accepté': 'done', 'Déprécié': 'aborted', 'Remplacé': 'awaiting' }[status] || 'queued';
  return `<span class="badge ${cls}" title="Statut ADR">${esc(status || '—')}</span>`;
}

// Badge « globale » : ADR rattachée à TOUS les repos du projet (isGlobal).
function adrGlobalBadge(d) {
  if (!d || !d.isGlobal) return '';
  return `<span class="badge done" title="ADR globale — rattachée à tous les repos du projet">globale</span>`;
}

// Cellule texte compacte (tronquée + info-bulle complète).
function adrCellText(v, max = 140) {
  if (v === undefined || v === null || String(v).trim() === '') return '<span class="muted-sm">—</span>';
  const s = String(v).replace(/\s+/g, ' ').trim();
  const short = s.length > max ? s.slice(0, max - 1) + '…' : s;
  return `<span title="${esc(s)}">${esc(short)}</span>`;
}

// Badge de source d'une pièce jointe d'ADR (item 122).
function adrAttSourceBadge(source) {
  const map = {
    import: ['importé', 'done'],
    ref: ['référencé', 'awaiting'],
    registry: ['registre', 'queued'],
  };
  const [label, cls] = map[source] || [source || '—', 'queued'];
  return `<span class="badge ${cls}" title="Source de la pièce jointe">${esc(label)}</span>`;
}

// Cellule « Pièces jointes » (item 122) : lit d.attachments (0..N, produit par
// le registre). Par pièce : libellé + badge de source + téléchargement (fichier
// importé/référencé) ou lecture du document du registre + bouton de retrait.
// Bouton « + Joindre » toujours présent (le cas 0 pièce joint → « — »).
// `prefix` paramètre les attributs data-* : le défaut « pd-adr » conserve le
// câblage de la modale projet ; l'onglet ADR du projet passe « adr ».
function adrAttachmentsCell(d, prefix = 'pd-adr') {
  const docId = d && d.docId;
  const list = (d && Array.isArray(d.attachments)) ? d.attachments : [];
  const items = list.map((a) => {
    const name = a.title || a.path || a.targetDocId || 'pièce';
    const badge = adrAttSourceBadge(a.source);
    let link;
    if (a.source === 'registry') {
      link = `<a href="#" data-${prefix}-att-view="${esc(a.targetDocId || '')}" title="Voir le document du registre">${esc(name)}</a>`;
    } else {
      const href = `/api/docs/${encodeURIComponent(docId)}/attachments/${encodeURIComponent(a.attachmentId)}/download`;
      link = `<a href="${esc(href)}" title="Télécharger ${esc(name)}">${esc(name)}</a>`;
    }
    const del = `<button type="button" class="ghost tiny danger-text" data-${prefix}-att-del="${esc(a.attachmentId)}" data-${prefix}-att-doc="${esc(docId)}" title="Retirer la pièce jointe">×</button>`;
    return `<span style="display:inline-flex;gap:4px;align-items:center;margin:1px 0">${badge} ${link} ${del}</span>`;
  });
  const addBtn = docId
    ? `<button type="button" class="ghost tiny" data-${prefix}-att-add="${esc(docId)}" title="Joindre un document ou un fichier">+ Joindre</button>`
    : '';
  const body = items.length ? items.join('<br>') : '<span class="muted-sm">—</span>';
  return `<div style="display:flex;flex-direction:column;gap:3px">${body}<div>${addBtn}</div></div>`;
}

// Encode un ArrayBuffer en base64 par blocs (évite le dépassement du nombre
// d'arguments de String.fromCharCode pour les fichiers > ~64 Ko).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Lecture du contenu d'un document de référence (ADR-12) par docId : rendu
// markdown / feature / texte brut. Fonctionne pour tout doc (importé OU référencé
// par chemin dans le workspace).
async function viewRefDoc(docId) {
  try {
    const d = await api(`/api/docs/${encodeURIComponent(docId)}/content`);
    const html = d.html
      ? `<div class="doc-view-body markdown-view">${d.html}</div>`
      : `<pre class="doc-view-body doc-view-pre">${esc(d.raw || '')}</pre>`;
    const kindTag = d.kind ? `<code class="chip">${esc(docKindLabel(d.kind))}</code> ` : '';
    const dlUrl = `/api/docs/${encodeURIComponent(docId)}/download`;
    // A007 — Bandeau explicite quand le contenu provient du repli « champs
    // structurés du registre » (fichier `path` absent du disque) : la lecture
    // reste possible, jamais de 404 « fichier introuvable ».
    const fallbackBanner = d.source === 'structured'
      ? `<div class="doc-view-fallback-banner" style="margin:0 0 10px;padding:8px 10px;border-radius:6px;background:#3a2f12;border:1px solid #8a6d1f;color:#f0d48a;font-size:12px">Fichier absent — contenu du registre (contexte / décision / conséquences)</div>`
      : '';
    showModal(`
      <div class="modal modal-doc-fullscreen">
        <div class="doc-view-head">
          <div class="doc-view-title">
            <h3>${kindTag}${esc(d.title || 'Document')}</h3>
            <p class="muted-sm">${esc(d.path || '')}</p>
          </div>
          <div class="doc-view-actions">
            <a class="btn-dl" href="${dlUrl}" download title="Télécharger le document">Télécharger</a>
            <button class="ghost" id="modal-cancel">Fermer</button>
          </div>
        </div>
        ${fallbackBanner}
        ${html}
      </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) {
    // A007 — Message explicite : ni fichier ni champs structurés → contenu
    // indisponible (l'alerte ambiguë « Lecture impossible » est supprimée).
    alert('Contenu indisponible : ' + (e.message || e));
  }
}

// ===========================================================================
// Table ADR MUTUALISÉE (onglet projet). Rend les ADR du projet courant
// (incl. repos transverses) : Titre, Statut, Contexte, Décision, Conséquences,
// Repos rattachés (+ badge « globale »), Pièces jointes, Actions. Filtres
// statut/repo + recherche (client). `ctx = { projectId, adrs, repos, filter,
// prefix }`. `filter = { status, repo, q }`. Aucune duplication : le câblage
// (CRUD + pièces jointes + filtres) est assuré par bindAdrTable.
// ===========================================================================
// Prédicat de filtrage ADR — partagé par le rendu (adrTableHtml) et le câblage
// live (bindAdrTable). `attrs` = { status, repos (chips espacées), search }.
function adrRowVisible(attrs, q, status, repo) {
  if (status && (attrs.status || '') !== status) return false;
  if (repo && !(attrs.repos || '').split(/\s+/).includes(repo)) return false;
  if (q && !(attrs.search || '').includes(q)) return false;
  return true;
}

function adrTableHtml(ctx = {}) {
  const prefix = ctx.prefix || 'adr';
  const f = ctx.filter || {};
  const repos = ctx.repos || [];
  const list = ctx.adrs || [];
  // Filtre CIBLE « ADR sans fonctionnalité » : id-set de la vue de cardinalité
  // (source registre). `null` = ensemble indisponible → filtre inactif.
  const missingIds = ctx.missingFeatureIds || null;
  const missingActive = !!f.missingFeature && !!missingIds;
  const repoName = (rid) => { const r = repos.find((x) => x.id === rid); return r ? (r.name || r.id) : rid; };
  const q = (f.q || '').trim().toLowerCase();
  const statusOpts = ['', ...ADR_STATUS]
    .map((s) => `<option value="${esc(s)}" ${f.status === s ? 'selected' : ''}>${s ? esc(s) : '— tous les statuts —'}</option>`).join('');
  const repoIds = [...new Set(list.flatMap((d) => (Array.isArray(d.repos) ? d.repos : [])))];
  const repoOpts = ['', ...repoIds]
    .map((r) => `<option value="${esc(r)}" ${f.repo === r ? 'selected' : ''}>${r ? esc(repoName(r)) : '— tous les repos —'}</option>`).join('');
  let visible = 0;
  const rows = list.map((d) => {
    const dRepos = Array.isArray(d.repos) ? d.repos : [];
    const chips = dRepos.map((rid) => `<code class="chip-repo" title="Repo rattaché">${esc(repoName(rid))}</code>`).join(' ');
    const attrs = {
      status: d.status || '',
      repos: dRepos.join(' '),
      search: [d.title, d.context, d.decision, d.consequences, d.path, dRepos.join(' ')].filter(Boolean).join(' ').toLowerCase(),
    };
    const isMissingFeature = missingIds ? missingIds.has(d.docId) : false;
    const show = adrRowVisible(attrs, q, f.status || '', f.repo || '') && (!missingActive || isMissingFeature);
    if (show) visible++;
    const targetHtml = (d.isGlobal || chips)
      ? `<div>${[adrGlobalBadge(d), chips].filter(Boolean).join(' ')}</div>`
      : '<span class="muted-sm">—</span>';
    // A008 — « Regarder » désactivé (avec titre explicite) quand l'ADR n'a NI
    // fichier NI champs structurés (`contentAvailable === false`, annoncé par
    // GET /api/docs) ; inchangé sinon (aucune régression pour les ADR lisibles).
    const viewBtn = d.contentAvailable === false
      ? `<button type="button" class="ghost tiny" disabled title="Aucun contenu disponible (ni fichier ni champs structurés)">Regarder</button>`
      : `<button type="button" class="ghost tiny" data-${prefix}-view="${esc(d.docId)}" title="Voir le document">Regarder</button>`;
    return `<tr data-status="${esc(attrs.status)}" data-repos="${esc(attrs.repos)}" data-search="${esc(attrs.search)}" data-missing="${isMissingFeature ? '1' : '0'}"${show ? '' : ' hidden'}>
      <td><strong>${esc(d.title || d.docId)}</strong>${d.description ? `<div class="muted-sm">${esc(d.description)}</div>` : ''}</td>
      <td>${adrStatusBadge(d.status)}</td>
      <td>${adrCellText(d.context)}</td>
      <td>${adrCellText(d.decision)}</td>
      <td>${adrCellText(d.consequences)}</td>
      <td>${targetHtml}</td>
      <td>${adrAttachmentsCell(d, prefix)}</td>
      <td class="adr-actions">
        <button type="button" class="ghost tiny" data-${prefix}-edit="${esc(d.docId)}" title="Éditer l'ADR">Éditer</button>
        ${viewBtn}
        <button type="button" class="ghost tiny danger-text" data-${prefix}-del="${esc(d.docId)}" title="Supprimer l'ADR">Supprimer</button>
      </td>
    </tr>`;
  }).join('');
  return `
    <div class="adr-pane-filters">
      <input type="search" id="${esc(prefix)}-search" class="adr-search" placeholder="Rechercher (titre, contexte, décision…)" value="${esc(f.q || '')}">
      <select id="${esc(prefix)}-status-filter" title="Filtrer par statut">${statusOpts}</select>
      <select id="${esc(prefix)}-repo-filter" title="Filtrer par repo rattaché">${repoOpts}</select>
      <select id="${esc(prefix)}-missing-filter" title="Filtrer par lien manquant (cardinalité : source registre)">
        <option value="">Sans lien : tous</option>
        <option value="adr_sans_fonctionnalite" ${f.missingFeature === 'adr_sans_fonctionnalite' ? 'selected' : ''}>Sans fonctionnalité</option>
      </select>
      <span class="muted-sm" id="${esc(prefix)}-count">${visible} / ${list.length} ADR</span>
      <button type="button" class="launch-btn" id="${esc(prefix)}-new" title="Créer une ADR">+ Nouvelle ADR</button>
    </div>
    <div class="adr-table-wrap">
      <table class="adr-table">
        <thead><tr>
          <th>Titre</th><th>Statut</th><th>Contexte</th><th>Décision</th><th>Conséquences</th>
          <th>Repos rattachés</th><th>Pièces jointes</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted-sm" style="padding:10px">Aucune ADR pour ce projet.</td></tr>'}</tbody>
      </table>
    </div>`;
}

// Câblage MUTUALISÉ de la table ADR : CRUD + pièces jointes + filtres.
// `ctx = { prefix, projectId, project, docs, repos, filter, onChange }` ;
// `rootEl` borne les sélecteurs au conteneur de l'onglet. Réutilise
// adrFormModal / adrAttachmentModal / viewRefDoc / api (aucune duplication).
function bindAdrTable(rootEl, ctx = {}) {
  const root = rootEl || document;
  const prefix = ctx.prefix || 'adr';
  const docs = () => ctx.docs || [];
  const repos = ctx.repos || [];
  const project = ctx.project || { id: ctx.projectId };
  const filter = ctx.filter || {};
  const onChange = typeof ctx.onChange === 'function' ? ctx.onChange : () => {};
  const attr = (el, suffix) => el.getAttribute(`data-${prefix}-${suffix}`);

  // CRUD.
  const newBtn = root.querySelector(`#${prefix}-new`);
  if (newBtn) newBtn.addEventListener('click', () => adrFormModal(project, repos, null, onChange));
  root.querySelectorAll(`[data-${prefix}-edit]`).forEach((b) => b.addEventListener('click', () => {
    const adr = docs().find((d) => d.docId === attr(b, 'edit'));
    if (!adr) return;
    adrFormModal(project, repos, adr, onChange);
  }));
  root.querySelectorAll(`[data-${prefix}-view]`).forEach((b) => b.addEventListener('click', () => viewRefDoc(attr(b, 'view'))));
  root.querySelectorAll(`[data-${prefix}-del]`).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Supprimer cette ADR ?')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try { await api(`/api/docs/${encodeURIComponent(attr(b, 'del'))}`, { method: 'DELETE' }); await onChange(); }
    catch (err) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Suppression impossible : ' + (err.message || err));
    }
  }));

  // Pièces jointes : ajout / retrait / lecture d'un document du registre.
  root.querySelectorAll(`[data-${prefix}-att-add]`).forEach((b) => b.addEventListener('click', () => {
    adrAttachmentModal(attr(b, 'att-add'), docs(), onChange);
  }));
  root.querySelectorAll(`[data-${prefix}-att-del]`).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Retirer cette pièce jointe ?')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Retrait');
    try {
      await api(`/api/docs/${encodeURIComponent(attr(b, 'att-doc'))}/attachments/${encodeURIComponent(attr(b, 'att-del'))}`, { method: 'DELETE' });
      await onChange();
    } catch (err) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Retrait impossible : ' + (err.message || err));
    }
  }));
  root.querySelectorAll(`[data-${prefix}-att-view]`).forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const id = attr(b, 'att-view');
    if (id) viewRefDoc(id);
  }));

  // Filtres statut / repo / recherche — filtrage CLIENT sur les lignes rendues
  // (aucune requête, aucun re-render : la saisie conserve le focus). L'état est
  // conservé dans `ctx.filter` pour survivre aux re-rendus (CRUD).
  const searchEl = root.querySelector(`#${prefix}-search`);
  const statusEl = root.querySelector(`#${prefix}-status-filter`);
  const repoEl = root.querySelector(`#${prefix}-repo-filter`);
  const missingEl = root.querySelector(`#${prefix}-missing-filter`);
  const countEl = root.querySelector(`#${prefix}-count`);
  const rows = [...root.querySelectorAll('.adr-table tbody tr[data-status]')];
  const apply = () => {
    const q = ((searchEl && searchEl.value) || '').trim().toLowerCase();
    const st = (statusEl && statusEl.value) || '';
    const rp = (repoEl && repoEl.value) || '';
    const mf = (missingEl && missingEl.value) || '';
    filter.status = st; filter.repo = rp; filter.q = (searchEl && searchEl.value) || ''; filter.missingFeature = mf;
    let visible = 0;
    for (const row of rows) {
      const show = adrRowVisible(
        { status: row.getAttribute('data-status'), repos: row.getAttribute('data-repos'), search: row.getAttribute('data-search') },
        q, st, rp,
      ) && (!mf || row.getAttribute('data-missing') === '1');
      row.hidden = !show;
      if (show) visible++;
    }
    if (countEl) countEl.textContent = `${visible} / ${rows.length} ADR`;
  };
  if (searchEl) searchEl.addEventListener('input', apply);
  if (statusEl) statusEl.addEventListener('change', apply);
  if (repoEl) repoEl.addEventListener('change', apply);
  if (missingEl) missingEl.addEventListener('change', () => { apply(); if (prefix === 'adr') persistAdrMissing(); });
  apply();
}

// ===========================================================================
// Onglet ADR DU PROJET — rendu dédié (carte RENDER.adr). Table des ADR du
// projet courant + filtres statut/repo + recherche + CRUD + pièces jointes.
// Mutualise adrTableHtml + bindAdrTable (aucune duplication).
// ===========================================================================
let adrFilters = { status: '', repo: '', q: '', missingFeature: localStorage.getItem('panel_adr_missing') || '' };

async function renderAdrs() {
  const pane = document.getElementById('pane-adr');
  if (!pane) return;
  if (!currentProject) {
    pane.innerHTML = '<h2>ADR</h2><p class="muted-sm">Ouvrez un projet pour voir ses ADR.</p>';
    return;
  }
  pane.innerHTML = `<h2>ADR — architecture du projet</h2><p class="muted-sm">Chargement…</p>`;
  let adrs = [], repos = [], projects = [];
  try { adrs = (((await api(`/api/docs?projectId=${encodeURIComponent(currentProject)}&includeRepoDocs=1`)).docs) || []).filter((d) => d.kind === 'adr-tech'); } catch { adrs = []; }
  try { repos = ((await api(`/api/repos?project=${encodeURIComponent(currentProject)}`)).repos || []); } catch { repos = []; }
  try { projects = ((await api('/api/projects')).projects || []); } catch { projects = []; }
  const project = projects.find((p) => p.id === currentProject) || { id: currentProject };
  // Filtre CIBLE « ADR sans fonctionnalité » : id-set de la vue de cardinalité
  // (source registre). Chargé seulement si le filtre est actif.
  const missingFeatureIds = adrFilters.missingFeature ? await cardinalityIdSetFor('adr_sans_fonctionnalite') : null;
  pane.innerHTML = `
    <h2>ADR — architecture du projet <span class="muted-sm">${esc(project.name || currentProject)}</span></h2>
    <p class="muted-sm">Décisions d'architecture (<code>adr-tech</code>) du projet et de ses repos transverses.</p>
    <div id="adr-table-wrap">${adrTableHtml({ projectId: currentProject, adrs, repos, filter: adrFilters, prefix: 'adr', missingFeatureIds })}</div>`;
  bindAdrTable(pane, { prefix: 'adr', projectId: currentProject, project, docs: adrs, repos, filter: adrFilters, onChange: renderAdrs });
}

// ===========================================================================
// ONGLET SPRINTS (ADR-001) — liste par projet (titre, dates, statut),
// création à DURÉE PARAMÉTRABLE, CLÔTURER / REPRENDRE, rattachement des pièces
// client, RAPPORT DE SPRINT téléchargeable. Toutes les écritures passent par
// /api/sprints* (→ MCP `sprint_*`) : le panneau n'écrit jamais en base.
// La clôture (bouton ou échéance auto) est l'action OFFICIELLE qui bascule la
// garde d'émergence ; le panneau affiche l'état renvoyé par le registre.
// ===========================================================================

const SPRINT_STATUS_BADGE = { open: ['running', 'ouvert'], close: ['done', 'clôturé'] };
function sprintStatusBadge(status) {
  const [cls, label] = SPRINT_STATUS_BADGE[status] || ['queued', status || '—'];
  return `<span class="badge ${cls}" title="Statut du sprint">${esc(label)}</span>`;
}
function fmtDateTime(v) {
  return v ? esc(String(v).replace('T', ' ').slice(0, 16)) : '<span class="muted-sm">—</span>';
}
function fmtDay(v) {
  return v ? esc(String(v).slice(0, 10)) : '—';
}
// `YYYY-MM-DD` (saisie) → ISO 8601 complet (registre) ; `end=true` → fin de journée.
function dayToIso(day, end) {
  if (!day) return undefined;
  return new Date(`${day}T${end ? '23:59:59' : '00:00:00'}Z`).toISOString();
}

// Création d'un sprint — durée PARAMÉTRABLE (jours) synchronisée avec l'échéance.
function sprintFormModal(pieces, onSaved) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const start = iso(today);
  const end = iso(new Date(today.getTime() + 14 * 86400000));
  const pieceOpts = (pieces || []).map((p) => `<label style="display:inline-flex;gap:4px;align-items:center;margin:2px 10px 2px 0"><input type="checkbox" class="sp-piece" value="${esc(p.pieceId)}"> ${esc(p.title || p.pieceId)}</label>`).join('');
  showModal(`<div class="modal modal-wide">
    <h2>Nouveau sprint</h2>
    <p class="muted-sm">Projet <code>${esc(currentProject)}</code> — la clôture (bouton ou échéance) est l'action officielle qui bascule la garde d'émergence.</p>
    <form id="sp-form" class="pilot-form">
      <label class="modal-field">Titre <input id="sp-title" placeholder="ex. Sprint 2026-09" required></label>
      <div class="pd-inline">
        <label class="modal-field">Début <input id="sp-start" type="date" value="${start}"></label>
        <label class="modal-field">Durée (jours) <input id="sp-days" type="number" min="1" value="14"></label>
        <label class="modal-field">Échéance <input id="sp-end" type="date" value="${end}"></label>
      </div>
      <label class="modal-field" style="flex-direction:row;align-items:center;gap:6px">
        <input type="checkbox" id="sp-autoclose" checked> <span>Clôture automatique à l'échéance</span>
      </label>
      <label class="modal-field">Pièces client rattachées à la création (non émergentes)
        <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">${pieceOpts || '<span class="muted-sm">Aucune pièce client disponible.</span>'}</div>
      </label>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">Créer le sprint</button>
      </div>
    </form>
    <div id="sp-msg" class="msg"></div>
  </div>`);
  const msg = (t, ok = true) => { const m = document.getElementById('sp-msg'); if (m) { m.textContent = t; m.className = 'msg ' + (ok ? 'ok' : 'error'); } };
  document.getElementById('modal-cancel').onclick = closeModal;
  const syncEnd = () => {
    const s = document.getElementById('sp-start').value;
    const days = Number(document.getElementById('sp-days').value) || 0;
    if (s && days > 0) {
      const d = new Date(`${s}T00:00:00`);
      d.setDate(d.getDate() + days);
      document.getElementById('sp-end').value = iso(d);
    }
  };
  document.getElementById('sp-days').addEventListener('input', syncEnd);
  document.getElementById('sp-start').addEventListener('change', syncEnd);
  document.getElementById('sp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    try {
      const body = {
        projectId: currentProject,
        title: document.getElementById('sp-title').value.trim(),
        startDate: dayToIso(document.getElementById('sp-start').value, false),
        endDate: dayToIso(document.getElementById('sp-end').value, true),
        autoClose: document.getElementById('sp-autoclose').checked,
        pieces: [...document.querySelectorAll('.sp-piece:checked')].map((c) => c.value),
      };
      if (!body.title) throw new Error('Titre requis.');
      await api('/api/sprints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg(err.message || String(err), false);
    }
  });
}

// Rattachement de pièces client à un sprint (émergentes si reçues après l'init).
function sprintPiecesModal(sprintId, pieces, onSaved) {
  const opts = (pieces || []).map((p) => `<label style="display:inline-flex;gap:4px;align-items:center;margin:2px 10px 2px 0"><input type="checkbox" class="sp-att-piece" value="${esc(p.pieceId)}"> ${esc(p.title || p.pieceId)} <span class="muted-sm">(${esc(p.nature || '')})</span></label>`).join('');
  showModal(`<div class="modal modal-wide">
    <h2>Rattacher des pièces client</h2>
    <p class="muted-sm">Sprint <code>${esc(sprintId)}</code> — une pièce reçue après l'initialisation du sprint est marquée <strong>émergente</strong> (traçage, non bloquant).</p>
    <div style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">${opts || '<span class="muted-sm">Aucune pièce client pour ce projet.</span>'}</div>
    <label class="modal-field" style="flex-direction:row;align-items:center;gap:6px;margin-top:8px">
      <input type="checkbox" id="sp-att-init"> <span>Rattachement à la création du sprint (non émergent)</span>
    </label>
    <div class="modal-actions">
      <button type="button" class="ghost" id="modal-cancel">Annuler</button>
      <button type="button" class="launch-btn" id="sp-att-go">Rattacher</button>
    </div>
    <div id="sp-att-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('sp-att-go').onclick = async () => {
    const btn = document.getElementById('sp-att-go');
    const original = btn.innerHTML;
    const msg = document.getElementById('sp-att-msg');
    const pieceIds = [...document.querySelectorAll('.sp-att-piece:checked')].map((c) => c.value);
    if (!pieceIds.length) { msg.textContent = 'Sélectionnez au moins une pièce.'; msg.className = 'msg error'; return; }
    setBtnBusy(btn, 'Rattachement');
    try {
      await api(`/api/sprints/${encodeURIComponent(sprintId)}/pieces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceIds, atInit: document.getElementById('sp-att-init').checked }),
      });
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg.textContent = e.message || String(e); msg.className = 'msg error';
    }
  };
}

async function renderSprints() {
  const pane = document.getElementById('pane-sprints');
  if (!pane) return;
  if (!currentProject) {
    pane.innerHTML = '<h2>Sprints</h2><p class="muted-sm">Ouvrez un projet pour voir ses sprints.</p>';
    return;
  }
  pane.innerHTML = `<h2>Sprints <span class="muted-sm">${esc(currentProject)}</span></h2><p class="muted-sm">Chargement…</p>`;
  let sprints = [], pieces = [];
  try { sprints = ((await api(`/api/sprints?projectId=${encodeURIComponent(currentProject)}`)).sprints || []); } catch { sprints = []; }
  try { pieces = ((await api(`/api/pieces?projectId=${encodeURIComponent(currentProject)}`)).pieces || []); } catch { pieces = []; }
  // Filtre CIBLE « sans lien » (id-set de la cardinalité, source registre).
  if (sprintsMissingFilter) {
    const missingIds = await cardinalityIdSetFor(sprintsMissingFilter, 'sprint');
    if (missingIds) sprints = sprints.filter((s) => missingIds.has(s.id));
  }
  const rows = sprints.map((s) => `<tr>
    <td><strong>${esc(s.title || s.id)}</strong>${s.isDefault ? ' <span class="badge queued" title="sprint par défaut">défaut</span>' : ''}<br><code class="muted-sm">${esc(s.id)}</code></td>
    <td>${sprintStatusBadge(s.status)}</td>
    <td>${fmtDay(s.startDate)}</td>
    <td>${fmtDay(s.endDate)}</td>
    <td>${s.autoClose ? '<span class="badge done" title="clôture auto à l\'échéance">auto</span>' : '<span class="muted-sm">manuel</span>'}</td>
    <td>${s.closeReason ? `<span class="muted-sm">${esc(s.closeReason)}</span>` : '<span class="muted-sm">—</span>'}</td>
    <td class="e2e-actions">
      <button type="button" class="ghost tiny" data-sp-detail="${esc(s.id)}">Détail</button>
      <button type="button" class="ghost tiny" data-sp-report="${esc(s.id)}">Rapport</button>
      <button type="button" class="ghost tiny" data-sp-pieces="${esc(s.id)}">Pièces</button>
      <button type="button" class="launch-btn tiny" data-sp-session="${esc(s.id)}" title="${s.sessionId ? 'Reprendre la session de sprint en cours' : 'Démarrer la session de sprint (agent-sprint : pièces → discussion → fonctionnalités/règles)'}">Session de sprint</button>
      ${s.status === 'open'
        ? `<button type="button" class="ghost tiny danger-text" data-sp-close="${esc(s.id)}">CLÔTURER</button>`
        : `<button type="button" class="ghost tiny" data-sp-reopen="${esc(s.id)}">REPRENDRE</button>`}
      ${s.isDefault ? '' : `<button type="button" class="ghost tiny danger-text" data-sp-del="${esc(s.id)}" title="Supprimer le sprint">Supprimer</button>`}
    </td>
  </tr>`).join('');
  pane.innerHTML = `
    <h2>Sprints <span class="muted-sm">${esc(currentProject)}</span></h2>
    <p class="muted-sm">Un sprint est l'unité de temps du projet. La <strong>clôture</strong> (bouton ou échéance) est l'action officielle qui bascule la garde d'émergence ; <strong>REPRENDRE</strong> la suspend. Le rapport est généré par le registre.</p>
    <div class="adr-pane-filters">
      <span class="muted-sm">${sprints.length} sprint(s)</span>
      <select id="sp-missing" title="Filtrer par lien manquant (cardinalité : source registre)">
        <option value="">Sans lien : tous</option>
        <option value="sprint_sans_fonctionnalite">Sans fonctionnalité</option>
        <option value="sprint_sans_regle">Sans règle métier</option>
      </select>
      <button type="button" class="launch-btn" id="sp-new">+ Nouveau sprint</button>
      <button type="button" class="launch-btn" data-mg-session="1" title="Migrer les anciens sprints : convertir les ADR monolithiques en ADR atomiques (validation utilisateur avant écriture) et rattacher les éléments hérités à l'ancien sprint — sans faux émergent">Session de migration</button>
    </div>
    <div class="adr-table-wrap"><table class="adr-table">
      <thead><tr><th>Titre</th><th>Statut</th><th>Début</th><th>Échéance</th><th>Clôture</th><th>Motif</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted-sm" style="padding:10px">Aucun sprint pour ce projet.</td></tr>'}</tbody>
    </table></div>`;
  document.getElementById('sp-new').addEventListener('click', () => sprintFormModal(pieces, renderSprints));
  // Filtre cible « sans lien » : valeur pré-appliquée (clic carte) + persistance.
  const spMissingEl = document.getElementById('sp-missing');
  if (spMissingEl) {
    spMissingEl.value = sprintsMissingFilter || '';
    spMissingEl.addEventListener('change', () => {
      sprintsMissingFilter = spMissingEl.value;
      persistSprintsMissing();
      refreshActive();
    });
  }
  pane.querySelectorAll('[data-mg-session]').forEach((b) => b.addEventListener('click', () => openMigrationSession(b)));
  pane.querySelectorAll('[data-sp-detail]').forEach((b) => b.addEventListener('click', () => sprintDetailModal(b.dataset.spDetail)));
  pane.querySelectorAll('[data-sp-report]').forEach((b) => b.addEventListener('click', () => sprintReportModal(b.dataset.spReport)));
  pane.querySelectorAll('[data-sp-pieces]').forEach((b) => b.addEventListener('click', () => sprintPiecesModal(b.dataset.spPieces, pieces, renderSprints)));
  pane.querySelectorAll('[data-sp-session]').forEach((b) => b.addEventListener('click', () => openSprintSession(b.dataset.spSession, false, b)));
  pane.querySelectorAll('[data-sp-close]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Clôturer ce sprint ? Les éléments suivants seront marqués émergents (traçage, non bloquant).')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Clôture');
    try {
      await api(`/api/sprints/${encodeURIComponent(b.dataset.spClose)}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await renderSprints();
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Clôture impossible : ' + (e.message || e));
    }
  }));
  pane.querySelectorAll('[data-sp-reopen]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Reprendre (rouvrir) ce sprint ? La garde d\'émergence est suspendue.')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Reprise');
    try {
      await api(`/api/sprints/${encodeURIComponent(b.dataset.spReopen)}/reopen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await renderSprints();
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Reprise impossible : ' + (e.message || e));
    }
  }));
  // Suppression d'un sprint (bouton masqué pour le sprint par défaut) :
  // confirmation → DELETE ; le registre refuse (409) le sprint par défaut ou
  // portant tâches/cadrages → message explicite affiché tel quel.
  pane.querySelectorAll('[data-sp-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Supprimer ce sprint ? Ses liens (fonctionnalités, règles, pièces) seront détachés ; les entités restent au projet.')) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try {
      await api(`/api/sprints/${encodeURIComponent(b.dataset.spDel)}`, { method: 'DELETE' });
      await renderSprints();
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Suppression impossible : ' + ((e && e.message) || e));
    }
  }));
}

async function sprintDetailModal(sprintId) {
  try {
    const d = await api(`/api/sprints/${encodeURIComponent(sprintId)}`);
    const s = d.sprint || {};
    const sec = (title, arr, fmt) => `<div style="margin:8px 0"><strong>${esc(title)}</strong> (${(arr || []).length})<div class="recette-list" style="max-height:22vh;overflow:auto">${(arr || []).length ? arr.map((x) => `<div class="recette-item"><div>${fmt(x)}</div></div>`).join('') : '<p class="muted-sm">Aucun élément.</p>'}</div></div>`;
    showModal(`<div class="modal modal-wide">
      <div class="md-head"><strong>${esc(s.title || sprintId)}</strong> ${sprintStatusBadge(s.status)} <span class="badge queued">${esc(s.id || '')}</span></div>
      <p class="muted-sm">Période ${fmtDay(s.startDate)} → ${fmtDay(s.endDate)}${s.closedAt ? ` · clôturé le ${fmtDateTime(s.closedAt)} (${esc(s.closeReason || '')})` : ''}</p>
      ${sec('Pièces client', d.pieces, (p) => `${esc(p.title || p.pieceId)} <span class="muted-sm">(${esc(p.nature || '')})</span>${p.emergent ? ' <span class="chip">émergente</span>' : ''}`)}
      ${sec('Fonctionnalités', d.fonctionnalites, (f) => `<code class="chip">${esc(f.ref)}</code> ${esc(f.userStory || '')}${f.emergent ? ' <span class="chip">émergente</span>' : ''}`)}
      ${sec('Règles métier', d.regles, (r) => `<code class="chip">${esc(r.ref)}</code> ${esc(r.content || '')}${r.emergent ? ' <span class="chip">émergente</span>' : ''}`)}
      ${sec('Tâches', d.tasks, (t) => `<code class="chip">${esc(t.id)}</code> ${esc(t.title || t.request || '')} ${badge(t.status)}${t.emergent ? ' <span class="chip">émergente</span>' : ''}`)}
      ${sec('Cadrages', d.cadrages, (r) => `<code class="chip">${esc(r.cadrageId)}</code> ${esc(r.title || '')}`)}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) { alert('Détail indisponible : ' + (e.message || e)); }
}

// RAPPORT DE SPRINT (A010) — affiché (markdown) puis téléchargeable. Le contenu
// est généré par le registre (`sprint_report`), jamais recalculé côté panneau.
async function sprintReportModal(sprintId) {
  try {
    const r = await api(`/api/sprints/${encodeURIComponent(sprintId)}/report`);
    const md = (r && r.markdown) || '';
    const html = await renderMarkdownInline(md);
    const dlUrl = `/api/sprints/${encodeURIComponent(sprintId)}/report?download=1`;
    showModal(`<div class="modal modal-doc-fullscreen">
      <div class="doc-view-head">
        <div class="doc-view-title"><h3>Rapport de sprint</h3><p class="muted-sm">${esc(sprintId)} — généré par le registre</p></div>
        <div class="doc-view-actions">
          <a class="btn-dl" href="${dlUrl}" download title="Télécharger le rapport">Télécharger</a>
          <button class="ghost" id="modal-cancel">Fermer</button>
        </div>
      </div>
      ${html ? `<div class="doc-view-body markdown-view">${html}</div>` : `<pre class="doc-view-body doc-view-pre">${esc(md)}</pre>`}
    </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) { alert('Rapport indisponible : ' + (e.message || e)); }
}

// Ouvre la SESSION DE MIGRATION DES ANCIENS SPRINTS (agent-migration) du projet
// courant. Démarre (ou résout, idempotent) la migration via POST /api/migrations
// — le registre l'ancre sur le SPRINT PAR DÉFAUT (= l'ancien sprint) — puis
// lance/reprend la session IA (route POST /api/migrations/:id/session). La
// conversion des ADR et le rattachement des éléments hérités sont proposés par
// l'agent PUIS validés par l'utilisateur dans la session ; AUCUN faux émergent.
async function openMigrationSession(btn) {
  if (!currentProject) { alert('Ouvrez un projet.'); return; }
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Migration');
  try {
    const mig = await api('/api/migrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject }) });
    const m = (mig && mig.migration) || {};
    const s = (mig && mig.sprint) || m.sprint || {};
    const target = `Ancien sprint cible (sprint par défaut) : « ${s.title || s.id || '?'} »${s.startDate || s.endDate ? ` — ${fmtDay(s.startDate)} → ${fmtDay(s.endDate)}` : ''}`;
    const ok = confirm(
      `Session de migration des anciens sprints — projet ${currentProject}.\n\n${target}\n\n` +
      `L'agent va LIRE les ADR monolithiques, PROPOSER un découpage en ADR atomiques (détails en pièces jointes) et rattacher les éléments hérités à cet ancien sprint. ` +
      `VALIDATION UTILISATEUR OBLIGATOIRE avant toute écriture. AUCUN faux émergent.\n\nOuvrir la session ?`,
    );
    if (!ok) { if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; } return; }
    const r = await api(`/api/migrations/${encodeURIComponent(m.migrationId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: false }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || 'Aucune session de migration disponible.');
    refreshActive();
  } catch (e) {
    if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Échec de la session de migration : ' + (e.message || e));
  }
}

// Ouvre la session de sprint (agent-sprint) : reprend la session rattachée au
// sprint si elle existe (jamais de doublon) ; `force = true` en démarre une
// nouvelle. Miroir de `openCadrageSession` (route POST /api/sprints/:id/session).
async function openSprintSession(sprintId, force, btn) {
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Ouverture');
  try {
    const r = await api(`/api/sprints/${encodeURIComponent(sprintId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || (force ? 'Impossible de lancer une nouvelle session de sprint.' : 'Aucune session de sprint disponible.'));
    refreshActive();
  } catch (e) {
    if (btn && original != null) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Échec de la session de sprint : ' + (e.message || e));
  }
}

// ===========================================================================
// ONGLET FONCTIONNALITÉS / RÈGLES MÉTIER (ADR-001, T5) — table structurée
// (Ref / rôle / user story), règles métier, liens fonctionnalité↔règle /
// ↔scénario Gherkin / ↔ADR, visibilité des rattachements sprint/tâches/cadrages,
// CRUD (création / modification : l'agent propose, l'humain valide/ajuste).
// ===========================================================================

// Sous-onglet ACTIF (« features » | « rules ») + filtres PROPRES à chaque
// sous-onglet. États module → ils survivent au polling `refreshActive()` (comme
// `adrFilters`) : le sous-onglet actif n'est pas réinitialisé à chaque
// rafraîchissement. Le sous-onglet est en plus persisté (localStorage) pour
// survivre à un rechargement de page.
let frSubTab = localStorage.getItem('panel_fr_subtab') === 'rules' ? 'rules' : 'features';
let frFeatureFilters = { q: '', role: '', sprint: '', emergent: '', link: '', impl: '', dev: '' };
let frRuleFilters = { q: '', role: '', sprint: '', emergent: '', link: '', impl: '', respect: '' };
const persistFrSubTab = () => { localStorage.setItem('panel_fr_subtab', frSubTab); };

// Relations affichables/créables depuis une fonctionnalité ou une règle.
// `side` = position de l'entité courante dans le couple (a,b) du dispatcher.
const LINK_PRESETS = {
  feature: {
    feature_rule:    { side: 'a', other: 'rule',    label: 'Fonctionnalité ↔ Règle métier' },
    feature_gherkin: { side: 'a', other: 'gherkin', label: 'Fonctionnalité ↔ Scénario Gherkin' },
    feature_adr:     { side: 'a', other: 'adr',     label: 'Fonctionnalité ↔ ADR' },
    feature_sprint:  { side: 'a', other: 'sprint',  label: 'Fonctionnalité ↔ Sprint' },
    task_feature:    { side: 'b', other: 'task',    label: 'Tâche ↔ Fonctionnalité' },
    cadrage_feature: { side: 'b', other: 'cadrage', label: 'Cadrage ↔ Fonctionnalité' },
  },
  rule: {
    feature_rule: { side: 'b', other: 'feature', label: 'Fonctionnalité ↔ Règle métier' },
    rule_sprint:  { side: 'a', other: 'sprint',  label: 'Règle métier ↔ Sprint' },
  },
};

function linkModal(preset, entityId, refs, onSaved) {
  const kindOpts = Object.keys(preset).map((k) => `<option value="${esc(k)}">${esc(preset[k].label)}</option>`).join('');
  showModal(`<div class="modal">
    <h2>Créer un lien</h2>
    <p class="muted-sm">Entité <code>${esc(entityId)}</code> — le registre valide les deux extrémités (idempotent).</p>
    <form id="lk-form" class="pilot-form">
      <label class="modal-field">Relation <select id="lk-kind">${kindOpts}</select></label>
      <label class="modal-field">Cible <input id="lk-target" list="lk-targets" placeholder="identifiant de l'autre extrémité" required></label>
      <datalist id="lk-targets"></datalist>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">Lier</button>
      </div>
    </form>
    <div id="lk-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const fillTargets = () => {
    const kind = document.getElementById('lk-kind').value;
    const other = preset[kind] && preset[kind].other;
    const list = (refs && refs[other]) || [];
    document.getElementById('lk-targets').innerHTML = list.map((o) => `<option value="${esc(o.id)}">${esc(o.label || o.id)}</option>`).join('');
  };
  document.getElementById('lk-kind').addEventListener('change', fillTargets);
  fillTargets();
  document.getElementById('lk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Liaison');
    const msg = document.getElementById('lk-msg');
    const kind = document.getElementById('lk-kind').value;
    const target = document.getElementById('lk-target').value.trim();
    const side = preset[kind].side;
    const a = side === 'a' ? entityId : target;
    const b = side === 'a' ? target : entityId;
    try {
      await api('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, a, b }) });
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

function featureFormModal(feature, pieces, onSaved, opts = {}) {
  const isEdit = !!(feature && feature.id);
  // Contexte de création : projet explicite + signal d'émergence `cadrage`
  // (création depuis une recette évaluateur / un cadrage). `opts` est OPTIONNEL :
  // la création standard (onglet Fonctionnalités & Règles) reste inchangée.
  const proj = opts.projectId || currentProject;
  const pieceIds = (pieces || []).map((p) => p.pieceId);
  const curImpl = feature && feature.implemented ? (feature.implementedOrigin || 'ecosystem') : '';
  // Statut de développement (axe 3, T-20260922-100651-m6va).
  const curDev = (feature && feature.devStatus) || '';
  const curDevSrc = (feature && feature.devStatusSource) || '';
  showModal(`<div class="modal">
    <h2>${isEdit ? 'Éditer la fonctionnalité' : 'Nouvelle fonctionnalité'}</h2>
    <p class="muted-sm">Projet <code>${esc(proj)}</code> — référence <code>US-xxx</code>.</p>
    <form id="feat-form" class="pilot-form">
      <label class="modal-field">Référence <input id="feat-ref" value="${esc((feature && feature.ref) || '')}" placeholder="US-xxx" required></label>
      <label class="modal-field">Rôle / acteur <input id="feat-role" value="${esc((feature && feature.role) || '')}" placeholder="ex. client, opérateur"></label>
      <label class="modal-field">User story <textarea id="feat-us" class="modal-textarea" rows="3" placeholder="En tant que …, je veux …, afin de …" required>${esc((feature && feature.userStory) || '')}</textarea></label>
      <label class="modal-field">Pièce client source (optionnel) <input id="feat-piece" list="feat-pieces" value="${esc((feature && feature.sourcedPieceId) || '')}" placeholder="pieceId"><datalist id="feat-pieces">${pieceIds.map((id) => `<option value="${esc(id)}">`).join('')}</datalist></label>
      <label class="modal-field">Implémentation <select id="feat-impl">
        <option value="" ${curImpl === '' ? 'selected' : ''}>Non implémentée</option>
        <option value="ecosystem" ${curImpl === 'ecosystem' ? 'selected' : ''}>Implémentée · dans l'écosystème</option>
        <option value="hors_ecosystem" ${curImpl === 'hors_ecosystem' ? 'selected' : ''}>Implémentée · hors écosystème</option>
      </select></label>
      <label class="modal-field">Motif d'implémentation (optionnel) <input id="feat-impl-note" value="${esc((feature && feature.implementedNote) || '')}" placeholder="ex. développé dans l'IDE avant rattachement"></label>
      <div class="modal-field">
        <div class="muted-sm" style="margin-bottom:4px">Statut de DÉVELOPPEMENT (analyse du code) — axe distinct de l'intégration</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="modal-field" style="flex:1">Statut <select id="feat-dev-status">
            <option value="" ${curDev === '' ? 'selected' : ''}>Non évalué</option>
            <option value="complet" ${curDev === 'complet' ? 'selected' : ''}>Complet</option>
            <option value="partiel" ${curDev === 'partiel' ? 'selected' : ''}>Partiel</option>
            <option value="non_demarre" ${curDev === 'non_demarre' ? 'selected' : ''}>Non démarré</option>
            <option value="incoherent" ${curDev === 'incoherent' ? 'selected' : ''}>Incohérent</option>
          </select></label>
          <label class="modal-field" style="flex:1">Source <select id="feat-dev-source">
            <option value="" ${curDevSrc === '' ? 'selected' : ''}>— (requis si statut posé)</option>
            <option value="analyse_code" ${curDevSrc === 'analyse_code' ? 'selected' : ''}>Analyse du code</option>
            <option value="evaluateur" ${curDevSrc === 'evaluateur' ? 'selected' : ''}>Évaluateur</option>
            <option value="agent" ${curDevSrc === 'agent' ? 'selected' : ''}>Agent</option>
            <option value="humain" ${curDevSrc === 'humain' ? 'selected' : ''}>Humain</option>
          </select></label>
        </div>
      </div>
      <label class="modal-field">Note de développement (optionnel) <input id="feat-dev-note" value="${esc((feature && feature.devStatusNote) || '')}" placeholder="ex. endpoints manquants"></label>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
    <div id="feat-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('feat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, isEdit ? 'Enregistrement' : 'Création');
    const msg = document.getElementById('feat-msg');
    const impl = document.getElementById('feat-impl').value;
    const implNote = document.getElementById('feat-impl-note').value.trim();
    // Statut de développement (axe 3) : statut + source OBLIGATOIRE (garde UI miroir du registre).
    const devStatus = document.getElementById('feat-dev-status').value;
    const devStatusSource = document.getElementById('feat-dev-source').value;
    const devStatusNote = document.getElementById('feat-dev-note').value.trim();
    if (devStatus && !devStatusSource) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = 'Statut de développement : la source est obligatoire (analyse code / évaluateur / agent / humain).';
      msg.className = 'msg error';
      return;
    }
    const body = {
      ref: document.getElementById('feat-ref').value.trim(),
      role: document.getElementById('feat-role').value.trim(),
      userStory: document.getElementById('feat-us').value.trim(),
      sourcedPieceId: document.getElementById('feat-piece').value.trim(),
    };
    // Qualification d'implémentation (T-20260921-133134-yz2i) — envoyée dans le
    // body PUT/POST. `feature_register` (POST) ne porte pas l'état : si une
    // origine est choisie à la création, la qualification est appliquée par un
    // PUT juste après (mêmes routes, aucun tool supplémentaire).
    if (impl) { body.implemented = true; body.implementedOrigin = impl; }
    else if (isEdit) { body.implemented = false; }
    body.implementedNote = implNote;
    // Statut de développement (même mécanique : PUT après création).
    if (devStatus) { body.devStatus = devStatus; body.devStatusSource = devStatusSource; body.devStatusNote = devStatusNote; }
    else if (isEdit) { body.devStatus = ''; }
    try {
      let result = null;
      if (isEdit) {
        result = await api(`/api/features/${encodeURIComponent(feature.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        // Création en contexte cadrage/cadrage : `fromCadrage` (émergence origine
        // `cadrage`) + `cadrageId` transmis au registre (réservé admin côté serveur).
        const createBody = { projectId: proj, ...body };
        if (opts.fromCadrage) createBody.fromCadrage = true;
        if (opts.cadrageId) createBody.cadrageId = opts.cadrageId;
        const created = await api('/api/features', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createBody) });
        result = created;
        const newId = created && created.feature && created.feature.id;
        const post = {};
        if (impl) { post.implemented = true; post.implementedOrigin = impl; post.implementedNote = implNote; }
        if (devStatus) { post.devStatus = devStatus; post.devStatusSource = devStatusSource; post.devStatusNote = devStatusNote; }
        if (newId && Object.keys(post).length) {
          await api(`/api/features/${encodeURIComponent(newId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
        }
      }
      closeModal();
      if (typeof onSaved === 'function') await onSaved(result);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

function ruleFormModal(rule, pieces, onSaved, projectRoles, opts = {}) {
  const isEdit = !!(rule && rule.id);
  // Contexte de création (miroir de featureFormModal) : `opts` OPTIONNEL.
  const proj = opts.projectId || currentProject;
  const pieceIds = (pieces || []).map((p) => p.pieceId);
  const curImpl = rule && rule.implemented ? (rule.implementedOrigin || 'ecosystem') : '';
  // Statut de RESPECT (axe dédié, T-20260922-100651-m6va) — distinct du développement.
  const curRespect = (rule && rule.respectStatus) || '';
  // Association EXPLICITE de rôles (T-20260922-064200-e0yw).
  const curRoles = (rule && Array.isArray(rule.roles)) ? rule.roles : [];
  const curGlobal = !!(rule && rule.roleGlobal);
  const roleVocab = Array.isArray(projectRoles) ? projectRoles : [];
  showModal(`<div class="modal">
    <h2>${isEdit ? 'Éditer la règle métier' : 'Nouvelle règle métier'}</h2>
    <p class="muted-sm">Projet <code>${esc(proj)}</code> — référence <code>RM-xxxx</code>.</p>
    <form id="rule-form" class="pilot-form">
      <label class="modal-field">Référence <input id="rule-ref" value="${esc((rule && rule.ref) || '')}" placeholder="RM-xxxx" required></label>
      <label class="modal-field">Contenu <textarea id="rule-content" class="modal-textarea" rows="4" placeholder="Formulation de la règle métier" required>${esc((rule && rule.content) || '')}</textarea></label>
      <label class="modal-field">Pièce client source (optionnel) <input id="rule-piece" list="rule-pieces" value="${esc((rule && rule.sourcedPieceId) || '')}" placeholder="pieceId"><datalist id="rule-pieces">${pieceIds.map((id) => `<option value="${esc(id)}">`).join('')}</datalist></label>
      <div class="modal-field">
        <div class="muted-sm" style="margin-bottom:4px">Rôles associés (1..N) — ou cochez « Rôle global »</div>
        <div id="rule-roles" class="fr-role-picker">
          ${roleVocab.length
            ? roleVocab.map((role) => `<label class="fr-role-item"><input type="checkbox" class="rule-role-cb" value="${esc(role)}" ${curRoles.includes(role) ? 'checked' : ''}> ${esc(role)}</label>`).join('')
            : '<span class="muted-sm">Aucun rôle connu dans ce projet — cochez « Rôle global ».</span>'}
        </div>
      </div>
      <label class="modal-field"><input type="checkbox" id="rule-role-global" ${curGlobal ? 'checked' : ''}> Rôle global (tous les rôles)</label>
      <label class="modal-field">Implémentation <select id="rule-impl">
        <option value="" ${curImpl === '' ? 'selected' : ''}>Non implémentée</option>
        <option value="ecosystem" ${curImpl === 'ecosystem' ? 'selected' : ''}>Implémentée · dans l'écosystème</option>
        <option value="hors_ecosystem" ${curImpl === 'hors_ecosystem' ? 'selected' : ''}>Implémentée · hors écosystème</option>
      </select></label>
      <label class="modal-field">Motif d'implémentation (optionnel) <input id="rule-impl-note" value="${esc((rule && rule.implementedNote) || '')}" placeholder="ex. développé dans l'IDE avant rattachement"></label>
      <label class="modal-field">Statut de RESPECT (respect de la règle) <select id="rule-respect">
        <option value="" ${curRespect === '' ? 'selected' : ''}>Non évalué</option>
        <option value="respectee" ${curRespect === 'respectee' ? 'selected' : ''}>Respectée</option>
        <option value="non_respectee" ${curRespect === 'non_respectee' ? 'selected' : ''}>Non respectée</option>
      </select></label>
      <label class="modal-field">Note de respect (optionnel) <input id="rule-respect-note" value="${esc((rule && rule.respectStatusNote) || '')}" placeholder="ex. écart constaté sur …"></label>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
    <div id="rule-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  // « Rôle global » dispense de sélection : on désactive alors les cases de rôles.
  const globalCb = document.getElementById('rule-role-global');
  const syncRoleDisabled = () => {
    const on = !!(globalCb && globalCb.checked);
    document.querySelectorAll('.rule-role-cb').forEach((c) => { c.disabled = on; });
  };
  if (globalCb) globalCb.addEventListener('change', syncRoleDisabled);
  syncRoleDisabled();
  document.getElementById('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, isEdit ? 'Enregistrement' : 'Création');
    const msg = document.getElementById('rule-msg');
    const impl = document.getElementById('rule-impl').value;
    const implNote = document.getElementById('rule-impl-note').value.trim();
    // Statut de respect (axe dédié) — sélecteur + note.
    const respectStatus = document.getElementById('rule-respect').value;
    const respectStatusNote = document.getElementById('rule-respect-note').value.trim();
    // Association EXPLICITE : ≥1 rôle OU rôle global (garde UI miroir du registre).
    const roleGlobal = !!(document.getElementById('rule-role-global') || {}).checked;
    const roles = roleGlobal ? [] : Array.from(document.querySelectorAll('.rule-role-cb:checked')).map((c) => c.value);
    if (!roleGlobal && !roles.length) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = 'Association requise : sélectionnez au moins 1 rôle ou cochez « Rôle global (tous les rôles) ».';
      msg.className = 'msg error';
      return;
    }
    const body = {
      ref: document.getElementById('rule-ref').value.trim(),
      content: document.getElementById('rule-content').value.trim(),
      sourcedPieceId: document.getElementById('rule-piece').value.trim(),
      roles,
      roleGlobal,
    };
    // Qualification d'implémentation (T-20260921-133134-yz2i) — cf. featureFormModal.
    if (impl) { body.implemented = true; body.implementedOrigin = impl; }
    else if (isEdit) { body.implemented = false; }
    body.implementedNote = implNote;
    // Statut de respect (axe dédié) — même mécanique (PUT après création).
    if (respectStatus) { body.respectStatus = respectStatus; body.respectStatusNote = respectStatusNote; }
    else if (isEdit) { body.respectStatus = ''; }
    try {
      let result = null;
      if (isEdit) {
        result = await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        // Création en contexte cadrage/cadrage (miroir de featureFormModal).
        const createBody = { projectId: proj, ...body };
        if (opts.fromCadrage) createBody.fromCadrage = true;
        if (opts.cadrageId) createBody.cadrageId = opts.cadrageId;
        const created = await api('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createBody) });
        result = created;
        const newId = created && created.rule && created.rule.id;
        const post = {};
        if (impl) { post.implemented = true; post.implementedOrigin = impl; post.implementedNote = implNote; }
        if (respectStatus) { post.respectStatus = respectStatus; post.respectStatusNote = respectStatusNote; }
        if (newId && Object.keys(post).length) {
          await api(`/api/rules/${encodeURIComponent(newId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
        }
      }
      closeModal();
      if (typeof onSaved === 'function') await onSaved(result);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

async function featureDetailModal(featureId) {
  try {
    const d = await api(`/api/features/${encodeURIComponent(featureId)}`);
    const f = d.feature || {};
    const sec = (t, arr, fmt) => `<div style="margin:8px 0"><strong>${esc(t)}</strong> (${(arr || []).length})<div class="recette-list" style="max-height:20vh;overflow:auto">${(arr || []).length ? arr.map((x) => `<div class="recette-item"><div>${fmt(x)}</div></div>`).join('') : '<p class="muted-sm">Aucun élément.</p>'}</div></div>`;
    showModal(`<div class="modal modal-wide">
      <div class="md-head"><strong>${esc(f.ref || featureId)}</strong>${f.emergent ? ' <span class="chip">émergent</span>' : ''} ${frImplBadge(f)} <span class="badge queued">${esc(f.id || '')}</span></div>
      <p class="muted-sm"><strong>Rôle :</strong> ${esc(f.role || '—')}</p>
      <p class="muted-sm"><strong>Implémentation :</strong> ${frImplBadge(f)}${f.implementedAt ? ` — qualifiée le ${esc(f.implementedAt)}${f.implementedBy ? ` par ${esc(f.implementedBy)}` : ''}` : ''}${f.implementedNote ? ` — ${esc(f.implementedNote)}` : ''}</p>
      <p class="muted-sm"><strong>Développement :</strong> ${frDevStatusBadge(f)}${f.devStatusAt ? ` — qualifié le ${esc(f.devStatusAt)}${f.devStatusBy ? ` par ${esc(f.devStatusBy)}` : ''}` : ''}${f.devStatusSource ? ` — source : ${esc(FR_DEV_STATUS_SOURCE_LABELS[f.devStatusSource] || f.devStatusSource)}` : ''}${f.devStatusNote ? ` — ${esc(f.devStatusNote)}` : ''}</p>
      <p>${esc(f.userStory || '')}</p>
      ${sec('Règles métier', f.regles, (r) => `<code class="chip">${esc(r.ref)}</code> ${esc(r.content || '')}`)}
      <div style="margin:8px 0"><strong>Tests E2E liés</strong> (${(f.gherkin || []).length})<div class="recette-list" style="max-height:20vh;overflow:auto">${(f.gherkin || []).length ? f.gherkin.map((g) => `<div class="recette-item"><div><button type="button" class="chip fr-e2e-link" data-fr-e2e="${esc(g.e2eTestId)}" title="${esc(g.title || g.scenario || '')}">${esc(g.title || g.scenario || g.e2eTestId)}</button> <code class="chip">${esc(g.status || '')}</code></div></div>`).join('') : '<p class="muted-sm">Aucun test E2E lié.</p>'}</div></div>
      <div style="margin:8px 0"><strong>Verdicts d'évaluation</strong> (${(f.recetteVerdicts || []).length}) <span class="muted-sm">— lecture seule, axe distinct du statut de développement</span><div class="recette-list" style="max-height:20vh;overflow:auto">${(f.recetteVerdicts || []).length ? f.recetteVerdicts.map((v) => `<div class="recette-item"><div><code class="chip">${esc(v.recetteId)}</code> ${esc(v.title || '')} — <strong>${esc(v.verdict || 'sans verdict')}</strong>${v.verdictComment ? ` — ${esc(v.verdictComment)}` : ''}</div></div>`).join('') : '<p class="muted-sm">Aucun verdict d\'évaluation.</p>'}</div></div>
      ${sec('ADR', f.adrs, (a) => `<code class="chip">${esc(a.adrId)}</code> ${esc(a.title || '')}`)}
      ${sec('Sprints', f.sprints, (s) => `<code class="chip">${esc(s.id)}</code> ${esc(s.title || '')} ${sprintStatusBadge(s.status)}`)}
      ${sec('Tâches', f.tasks, (t) => `<code class="chip">${esc(t.id)}</code> ${esc(t.title || t.request || '')}`)}
      ${sec('Cadrages', f.cadrages, (r) => `<code class="chip">${esc(r.cadrageId)}</code> ${esc(r.title || '')}`)}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
    document.querySelectorAll('.modal [data-fr-e2e]').forEach((b) => b.addEventListener('click', () => e2eDetailModal(b.dataset.frE2e)));
  } catch (e) { alert('Détail indisponible : ' + (e.message || e)); }
}

async function ruleDetailModal(ruleId) {
  try {
    const d = await api(`/api/rules/${encodeURIComponent(ruleId)}`);
    const r = d.rule || {};
    const sec = (t, arr, fmt) => `<div style="margin:8px 0"><strong>${esc(t)}</strong> (${(arr || []).length})<div class="recette-list" style="max-height:20vh;overflow:auto">${(arr || []).length ? arr.map((x) => `<div class="recette-item"><div>${fmt(x)}</div></div>`).join('') : '<p class="muted-sm">Aucun élément.</p>'}</div></div>`;
    showModal(`<div class="modal modal-wide">
      <div class="md-head"><strong>${esc(r.ref || ruleId)}</strong>${r.emergent ? ' <span class="chip">émergente</span>' : ''} ${frImplBadge(r)} ${frRespectBadge(r)} <span class="badge queued">${esc(r.id || '')}</span></div>
      <p class="muted-sm"><strong>Implémentation :</strong> ${frImplBadge(r)}${r.implementedAt ? ` — qualifiée le ${esc(r.implementedAt)}${r.implementedBy ? ` par ${esc(r.implementedBy)}` : ''}` : ''}${r.implementedNote ? ` — ${esc(r.implementedNote)}` : ''}</p>
      <p class="muted-sm"><strong>Respect :</strong> ${frRespectBadge(r)}${r.respectStatusAt ? ` — qualifié le ${esc(r.respectStatusAt)}${r.respectStatusBy ? ` par ${esc(r.respectStatusBy)}` : ''}` : ''}${r.respectStatusNote ? ` — ${esc(r.respectStatusNote)}` : ''}</p>
      <p>${esc(r.content || '')}</p>
      ${sec('Fonctionnalités liées', r.fonctionnalites, (f) => `<code class="chip">${esc(f.ref)}</code> ${esc(f.userStory || '')}`)}
      ${sec('Sprints', r.sprints, (s) => `<code class="chip">${esc(s.id)}</code> ${esc(s.title || '')} ${sprintStatusBadge(s.status)}`)}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) { alert('Détail indisponible : ' + (e.message || e)); }
}

// Index DÉTERMINISTE des liens par entité, dérivé du PAYLOAD des listes
// (`feature_list`/`rule_list` renvoient `links` = compteurs calculés en UNE
// requête bulk côté registre). PLUS AUCUN appel réseau ici : les 55 appels
// `/api/features/:id` + `/api/rules/:id` (N+1) ont disparu. L'index alimente À
// LA FOIS la colonne « Liens » (`frLinkCellHtml`) ET les filtres « sans lien »
// (`frFilter*`).
// Structure : { features: { id: { rules, gherkin, adrs, sprints, tasks, cadrages } },
//               rules:    { id: { features, sprints } } }.
// Repli non bloquant : une entité SANS `links` (registre non encore déployé) est
// ABSENTE de l'index → ses liens s'affichent `—`/« aucun lien », jamais
// d'exception remontée.
let frLinkWarned = false;
function buildFeatureRuleLinkIndex(features, rules) {
  const index = { features: {}, rules: {} };
  (features || []).forEach((f) => { if (f && f.id && f.links) index.features[f.id] = f.links; });
  (rules || []).forEach((r) => { if (r && r.id && r.links) index.rules[r.id] = r.links; });
  return index;
}

// Cellule « Liens » d'une entité construite depuis l'index (AUCUN appel réseau).
// `kind` = 'feature' | 'rule'.
function frLinkCellHtml(kind, id, linkIndex) {
  const bucket = (linkIndex && (kind === 'feature' ? linkIndex.features : linkIndex.rules)) || {};
  const o = bucket[id];
  if (!o) return '<span class="muted-sm">—</span>';
  const parts = [];
  if (kind === 'feature') {
    if (o.rules) parts.push(`${o.rules} règle(s)`);
    if (o.gherkin) parts.push(`${o.gherkin} Gherkin`);
    if (o.adrs) parts.push(`${o.adrs} ADR`);
    if (o.sprints) parts.push(`${o.sprints} sprint(s)`);
    if (o.tasks) parts.push(`${o.tasks} tâche(s)`);
    if (o.cadrages) parts.push(`${o.cadrages} cadrage(s)`);
  } else {
    if (o.features) parts.push(`${o.features} fonctionnalité(s)`);
    if (o.sprints) parts.push(`${o.sprints} sprint(s)`);
  }
  return parts.length ? parts.map((p) => `<span class="chip">${esc(p)}</span>`).join(' ') : '<span class="muted-sm">aucun lien</span>';
}

// ===========================================================================
// ÉTAT D'IMPLÉMENTATION + ORIGINE (T-20260921-133134-yz2i) — badge, qualification.
// L'émergence reste un AXE DISTINCT : ces helpers n'écrivent jamais `emergent`.
// ===========================================================================

// Badge d'état d'une fonctionnalité/règle. Priorité : implémentée (origine) >
// émergente > « — ».
function frImplBadge(o) {
  const x = o || {};
  if (x.implemented) {
    const label = x.implementedOrigin === 'hors_ecosystem' ? 'hors écosystème' : 'écosystème';
    const title = `implémentée (${label})${x.implementedNote ? ' — ' + x.implementedNote : ''}`;
    return `<span class="chip" title="${esc(title)}">implémentée · ${esc(label)}</span>`;
  }
  if (x.emergent) return '<span class="chip" title="émergente">émergente</span>';
  return '<span class="muted-sm">—</span>';
}

// STATUT DE DÉVELOPPEMENT d'une fonctionnalité (axe 3, analyse du code,
// T-20260922-100651-m6va) — DISTINCT de l'intégration (`frImplBadge`) et du
// verdict d'évaluation. La SOURCE (qui alimente) est exposée en infobulle.
const FR_DEV_STATUS_LABELS = { complet: 'complet', non_demarre: 'non démarré', partiel: 'partiel', incoherent: 'incohérent' };
const FR_DEV_STATUS_SOURCE_LABELS = { analyse_code: 'analyse code', evaluateur: 'évaluateur', agent: 'agent', humain: 'humain' };
function frDevStatusBadge(o) {
  const x = o || {};
  if (!x.devStatus) return '<span class="muted-sm">—</span>';
  const label = FR_DEV_STATUS_LABELS[x.devStatus] || x.devStatus;
  const src = x.devStatusSource ? ` (${FR_DEV_STATUS_SOURCE_LABELS[x.devStatusSource] || x.devStatusSource})` : '';
  const title = `développement : ${label}${src}${x.devStatusNote ? ' — ' + x.devStatusNote : ''}`;
  const cls = x.devStatus === 'incoherent' ? 'chip danger-text' : 'chip';
  return `<span class="${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

// STATUT DE RESPECT d'une règle métier (axe dédié, distinct du développement).
const FR_RESPECT_LABELS = { respectee: 'respectée', non_respectee: 'non respectée' };
function frRespectBadge(o) {
  const x = o || {};
  if (!x.respectStatus) return '<span class="muted-sm">—</span>';
  const label = FR_RESPECT_LABELS[x.respectStatus] || x.respectStatus;
  const title = `respect : ${label}${x.respectStatusNote ? ' — ' + x.respectStatusNote : ''}`;
  const cls = x.respectStatus === 'non_respectee' ? 'chip danger-text' : 'chip';
  return `<span class="${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

// Cellule « Tests E2E » d'une fonctionnalité : liens 1..N CLIQUABLES vers le
// détail du test E2E (`data-fr-e2e` → `e2eDetailModal`). Alimentée par le champ
// bulk `gherkinTests` du payload liste (0 N+1).
function frGherkinCellHtml(f) {
  const list = (f && f.gherkinTests) || [];
  if (!list.length) return '<span class="muted-sm">—</span>';
  return list.map((t) => `<button type="button" class="chip fr-e2e-link" data-fr-e2e="${esc(t.e2eTestId)}" title="${esc(t.title || t.e2eTestId)}">${esc(t.title || t.e2eTestId)}</button>`).join(' ');
}

// Modale de QUALIFICATION d'implémentation (dans / hors écosystème) — écrit via
// les routes PUT existantes (`/api/features/:id`, `/api/rules/:id`).
function frQualifyModal(kind, id, current, onSaved) {
  const isFeature = kind === 'feature';
  const cur = current || {};
  const path = isFeature ? `/api/features/${encodeURIComponent(id)}` : `/api/rules/${encodeURIComponent(id)}`;
  showModal(`<div class="modal">
    <h2>Qualifier l'implémentation</h2>
    <p class="muted-sm"><code>${esc(id)}</code> — l'émergence reste un axe distinct (inchangée).</p>
    <form id="frq-form" class="pilot-form">
      <label class="modal-field">État <select id="frq-impl">
        <option value="">Non implémentée</option>
        <option value="ecosystem" ${cur.implementedOrigin === 'ecosystem' ? 'selected' : ''}>Implémentée · dans l'écosystème</option>
        <option value="hors_ecosystem" ${cur.implementedOrigin === 'hors_ecosystem' ? 'selected' : ''}>Implémentée · hors écosystème</option>
      </select></label>
      <label class="modal-field">Motif (optionnel) <input id="frq-note" value="${esc(cur.implementedNote || '')}" placeholder="ex. développé dans l'IDE avant rattachement"></label>
      <div class="modal-actions">
        <button type="button" class="ghost" id="modal-cancel">Annuler</button>
        <button type="submit" class="launch-btn">Enregistrer</button>
      </div>
    </form>
    <div id="frq-msg" class="msg"></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('frq-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Enregistrement');
    const msg = document.getElementById('frq-msg');
    const val = document.getElementById('frq-impl').value;
    const note = document.getElementById('frq-note').value.trim();
    const body = val
      ? { implemented: true, implementedOrigin: val, implementedNote: note }
      : { implemented: false, implementedNote: '' };
    try {
      await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

// Filtrage CLIENT du sous-onglet Fonctionnalités (pur, sans effet de bord).
// `filter` = { q, role, sprint, emergent, link, impl } ; `role` ∈ '' | <rôle> | __none__
// (__none__ = « Sans rôle », homogène avec le sous-onglet Règles) ;
// `sprint` ∈ '' | <sprintId> | __none__ (__none__ = « Sans sprint », via `sprintIds`) ;
// `link` ∈ '' | sans_regle | sans_gherkin | sans_adr | sans_sprint (index A003) ;
// `impl` ∈ '' | yes | no | ecosystem | hors_ecosystem (état d'implémentation) ;
// `dev` ∈ '' | complet | non_demarre | partiel | incoherent | __none__ (statut de
// développement, axe 3 — distinct de l'intégration).
function frFilterFeatures(features, filter, linkIndex) {
  const f = filter || {};
  const q = (f.q || '').trim().toLowerCase();
  const idx = (linkIndex && linkIndex.features) || {};
  return (features || []).filter((x) => {
    const hay = `${x.ref || ''} ${x.userStory || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (f.role === '__none__') { if ((x.role || '') !== '') return false; }
    else if (f.role && (x.role || '') !== f.role) return false;
    if (f.sprint === '__none__') { if ((x.sprintIds || []).length) return false; }
    else if (f.sprint && !(x.sprintIds || []).includes(f.sprint)) return false;
    if (f.emergent === 'yes' && !x.emergent) return false;
    if (f.emergent === 'no' && x.emergent) return false;
    if (f.impl === 'yes' && !x.implemented) return false;
    if (f.impl === 'no' && x.implemented) return false;
    if (f.impl === 'ecosystem' && !(x.implemented && x.implementedOrigin !== 'hors_ecosystem')) return false;
    if (f.impl === 'hors_ecosystem' && !(x.implemented && x.implementedOrigin === 'hors_ecosystem')) return false;
    if (f.dev === '__none__') { if (x.devStatus) return false; }
    else if (f.dev && x.devStatus !== f.dev) return false;
    if (f.link) {
      const l = idx[x.id] || {};
      if (f.link === 'sans_regle' && l.rules) return false;
      if (f.link === 'sans_gherkin' && l.gherkin) return false;
      if (f.link === 'sans_adr' && l.adrs) return false;
      if (f.link === 'sans_sprint' && l.sprints) return false;
    }
    return true;
  });
}

// Filtrage CLIENT du sous-onglet Règles métier (pur, sans effet de bord).
// `filter` = { q, role, sprint, emergent, link, impl } ; le rôle d'une règle est son
// ASSOCIATION EXPLICITE (`roles` 1..N / `roleGlobal`) ; `role` ∈ '' | <rôle> | __global__ | __none__.
// Sémantique « Global » (une règle globale s'applique à TOUS les rôles) : une règle
// `roleGlobal` est retenue par tout filtre rôle SPÉCIFIQUE et par « Global » ; elle
// n'est PAS « Sans rôle ». `sprint` ∈ '' | <sprintId> | __none__ (via `sprintIds`) ;
// `link` ∈ '' | sans_fonctionnalite | sans_sprint ;
// `impl` ∈ '' | yes | no | ecosystem | hors_ecosystem ;
// `respect` ∈ '' | respectee | non_respectee | __none__ (statut de RESPECT, axe dédié).
function frFilterRules(rules, filter, linkIndex) {
  const f = filter || {};
  const q = (f.q || '').trim().toLowerCase();
  const idx = (linkIndex && linkIndex.rules) || {};
  return (rules || []).filter((x) => {
    const hay = `${x.ref || ''} ${x.content || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (f.role === '__global__') { if (!x.roleGlobal) return false; }
    else if (f.role === '__none__') { if (x.roleGlobal || (x.roles || []).length) return false; }
    else if (f.role && !(x.roleGlobal || (x.roles || []).includes(f.role))) return false;
    if (f.sprint === '__none__') { if ((x.sprintIds || []).length) return false; }
    else if (f.sprint && !(x.sprintIds || []).includes(f.sprint)) return false;
    if (f.emergent === 'yes' && !x.emergent) return false;
    if (f.emergent === 'no' && x.emergent) return false;
    if (f.impl === 'yes' && !x.implemented) return false;
    if (f.impl === 'no' && x.implemented) return false;
    if (f.impl === 'ecosystem' && !(x.implemented && x.implementedOrigin !== 'hors_ecosystem')) return false;
    if (f.impl === 'hors_ecosystem' && !(x.implemented && x.implementedOrigin === 'hors_ecosystem')) return false;
    if (f.respect === '__none__') { if (x.respectStatus) return false; }
    else if (f.respect && x.respectStatus !== f.respect) return false;
    if (f.link) {
      const l = idx[x.id] || {};
      if (f.link === 'sans_fonctionnalite' && l.features) return false;
      if (f.link === 'sans_sprint' && l.sprints) return false;
    }
    return true;
  });
}

// Suppression d'une FONCTIONNALITÉ depuis le panneau : confirmation → DELETE.
// Si le registre refuse (`[ADR_LAST_FEATURE]` : l'ADR perdrait sa dernière
// fonctionnalité), une 2ᵉ confirmation propose la cascade ADR
// (`?cascadeAdrs=1`). Aucune suppression silencieuse d'ADR.
async function deleteFeatureFlow(featureId, onDone, btn) {
  if (!featureId) return;
  if (!confirm('Supprimer cette fonctionnalité ? Ses liens (règles, Gherkin, ADR, sprints, tâches, cadrages) seront détachés.')) return;
  const original = btn ? btn.innerHTML : null;
  const del = (cascade) => api(`/api/features/${encodeURIComponent(featureId)}${cascade ? '?cascadeAdrs=1' : ''}`, { method: 'DELETE' });
  setBtnBusy(btn, 'Suppression');
  try {
    await del(false);
    if (typeof onDone === 'function') await onDone();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    const msg = String((e && e.message) || e);
    if (msg.includes('ADR_LAST_FEATURE')) {
      if (!confirm(`${msg}\n\nSupprimer AUSSI l'ADR (cascade) ? Cette action est définitive.`)) return;
      if (btn) setBtnBusy(btn, 'Suppression');
      try { await del(true); if (typeof onDone === 'function') await onDone(); }
      catch (e2) {
        if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
        alert('Suppression impossible : ' + ((e2 && e2.message) || e2));
      }
    } else {
      alert('Suppression impossible : ' + msg);
    }
  }
}

// Suppression d'une RÈGLE MÉTIER depuis le panneau : confirmation → DELETE
// (liens `fonctionnalite_regles` / `sprint_regles` détachés en CASCADE).
async function deleteRuleFlow(ruleId, onDone, btn) {
  if (!ruleId) return;
  if (!confirm('Supprimer cette règle métier ? Ses liens (fonctionnalités, sprints) seront détachés.')) return;
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Suppression');
  try {
    await api(`/api/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    if (typeof onDone === 'function') await onDone();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Suppression impossible : ' + ((e && e.message) || e));
  }
}

// Suppression d'une CADRAGE ENTIÈRE (cadrage technique) depuis le panneau —
// ADMIN uniquement. DOUBLE confirmation (action IRRÉVERSIBLE) → DELETE
// `/api/cadrages/:id` (nettoyage en CASCADE côté registre : éléments, liens de
// tâches, documents/artefacts, points de vigilance ADR liés, liens
// sprint/fonctionnalité/règle/ADR/projet, signaux de cardinalité ouverts). Les
// tâches et éléments de recette évaluateur rattachés RESTENT au registre.
async function deleteCadrageFlow(cadrageId, title, onDone, btn) {
  if (!cadrageId) return;
  const label = title || cadrageId;
  if (!confirm(`Supprimer DÉFINITIVEMENT ${label} ?\n\nToute sa famille sera nettoyée (éléments, liens de tâches, documents, points de vigilance ADR, liens sprint/fonctionnalité/règle/ADR). Les tâches et éléments de recette évaluateur rattachés restent au registre.`)) return;
  if (!confirm(`Confirmer la suppression IRRÉVERSIBLE de ${cadrageId} ?`)) return;
  const original = btn ? btn.innerHTML : null;
  setBtnBusy(btn, 'Suppression');
  try {
    await api(`${cadragesApiBase()}/${encodeURIComponent(cadrageId)}`, { method: 'DELETE' });
    if (typeof onDone === 'function') await onDone();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    alert('Suppression impossible : ' + ((e && e.message) || e));
  }
}

// Table ISOLÉE du sous-onglet Fonctionnalités (US-xxx) — Ref (badge émergent),
// Intégration (implémentation interne/hors écosystème), Développement (statut
// d'analyse du code), Tests E2E (liens cliquables 1..N), Rôle, User story,
// Liens (index A003), Actions. Aucune règle métier ici.
function frFeatureTableHtml(features, linkIndex) {
  const rows = (features || []).map((f) => `<tr>
    <td><strong>${esc(f.ref)}</strong>${f.emergent ? ' <span class="chip" title="émergent">émergent</span>' : ''}</td>
    <td>${frImplBadge(f)}</td>
    <td>${frDevStatusBadge(f)}</td>
    <td class="fr-e2e-cell">${frGherkinCellHtml(f)}</td>
    <td>${esc(f.role || '—')}</td>
    <td>${adrCellText(f.userStory, 200)}</td>
    <td class="fr-links">${frLinkCellHtml('feature', f.id, linkIndex)}</td>
    <td class="e2e-actions">
      <button type="button" class="ghost tiny" data-fr-impl="${esc(f.id)}" title="Qualifier l'implémentation">Qualifier</button>
      <button type="button" class="ghost tiny" data-fr-edit="${esc(f.id)}">Éditer</button>
      <button type="button" class="ghost tiny" data-fr-detail="${esc(f.id)}">Détail</button>
      <button type="button" class="ghost tiny" data-fr-link="${esc(f.id)}">Lier</button>
      <button type="button" class="ghost tiny danger-text" data-fr-del="${esc(f.id)}" title="Supprimer la fonctionnalité">Supprimer</button>
    </td>
  </tr>`).join('');
  return `<div class="adr-table-wrap"><table class="adr-table">
    <thead><tr><th>Ref</th><th>Intégration</th><th>Développement</th><th>Tests E2E</th><th>Rôle</th><th>User story</th><th>Liens</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="muted-sm" style="padding:10px">Aucune fonctionnalité pour ce projet.</td></tr>'}</tbody>
  </table></div>`;
}

// Badges de l'ASSOCIATION EXPLICITE de rôles d'une règle métier :
// `roleGlobal` → chip « Global » (tous les rôles) ; sinon un chip par rôle ;
// aucun rôle et non global → « — » (Sans rôle).
function frRuleRolesBadges(r) {
  if (!r) return '<span class="muted-sm">—</span>';
  if (r.roleGlobal) return '<span class="chip" title="s\'applique à tous les rôles">Global</span>';
  const roles = r.roles || [];
  if (!roles.length) return '<span class="muted-sm">—</span>';
  return roles.map((x) => `<span class="chip">${esc(x)}</span>`).join(' ');
}

// Table ISOLÉE du sous-onglet Règles métier (RM-xxxx) — Ref (badge émergente),
// Respect (statut de RESPECT, axe dédié — distinct du développement), Rôles,
// Contenu, Pièce source, Liens (index A003), Actions. Aucune fonctionnalité ici.
function frRuleTableHtml(rules, linkIndex) {
  const rows = (rules || []).map((r) => `<tr>
    <td><strong>${esc(r.ref)}</strong>${r.emergent ? ' <span class="chip" title="émergente">émergente</span>' : ''}</td>
    <td>${frRespectBadge(r)}</td>
    <td>${frRuleRolesBadges(r)}</td>
    <td>${adrCellText(r.content, 220)}</td>
    <td>${r.sourcedPieceId ? `<code class="chip">${esc(r.sourcedPieceId)}</code>` : '<span class="muted-sm">—</span>'}</td>
    <td class="fr-links">${frLinkCellHtml('rule', r.id, linkIndex)}</td>
    <td class="e2e-actions">
      <button type="button" class="ghost tiny" data-rule-impl="${esc(r.id)}" title="Qualifier l'implémentation">Qualifier</button>
      <button type="button" class="ghost tiny" data-rule-edit="${esc(r.id)}">Éditer</button>
      <button type="button" class="ghost tiny" data-rule-detail="${esc(r.id)}">Détail</button>
      <button type="button" class="ghost tiny" data-rule-link="${esc(r.id)}">Lier</button>
      <button type="button" class="ghost tiny danger-text" data-rule-del="${esc(r.id)}" title="Supprimer la règle métier">Supprimer</button>
    </td>
  </tr>`).join('');
  return `<div class="adr-table-wrap"><table class="adr-table">
    <thead><tr><th>Ref</th><th>Respect</th><th>Rôles</th><th>Contenu</th><th>Pièce source</th><th>Liens</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted-sm" style="padding:10px">Aucune règle métier pour ce projet.</td></tr>'}</tbody>
  </table></div>`;
}

// Sous-panneau FONCTIONNALITÉS : toolbar de filtres PROPRES (recherche ref/user
// story, rôle, émergence, sans règle/Gherkin/ADR/sprint) + table isolée +
// bouton « + Nouvelle fonctionnalité ». Le filtrage est CLIENT : seule la table
// est re-rendue au changement de filtre (la saisie de recherche garde le focus).
function renderFrFeaturePanel(features, refs, pieces, linkIndex, sprints) {
  const panel = document.getElementById('fr-subpanel');
  if (!panel) return;
  const f = frFeatureFilters;
  // Exécuteur : pré-régler le filtre sprint sur le sprint ACTIF (traçage des
  // anciens sprints possible via le sélecteur). Sans sprint nominal ouvert,
  // `activeSprintFor` renvoie '' → aucun pré-réglage (anti sur-restriction).
  if (IS_EXECUTEUR && !f.sprint) f.sprint = activeSprintFor(sprints);
  const roles = [...new Set((features || []).map((x) => x.role).filter(Boolean))].sort();
  const sprintOpts = (sprints || []).map((s) => `<option value="${esc(s.id)}" ${f.sprint === s.id ? 'selected' : ''}>${esc(s.title || s.id)}</option>`).join('');
  const filtered = frFilterFeatures(features, f, linkIndex);
  panel.innerHTML = `
    <div class="adr-pane-filters fr-filters">
      <span class="muted-sm" id="fr-f-count">${filtered.length} / ${(features || []).length} fonctionnalité(s)</span>
      <input type="search" id="fr-f-q" class="adr-search" placeholder="Rechercher (ref, user story…)" value="${esc(f.q || '')}">
      <select id="fr-f-role" title="Filtrer par rôle">
        <option value="">Rôle : tous</option>
        ${roles.map((r) => `<option value="${esc(r)}" ${f.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        <option value="__none__" ${f.role === '__none__' ? 'selected' : ''}>Sans rôle</option>
      </select>
      <select id="fr-f-sprint" title="Filtrer par sprint">
        <option value="">Sprint : tous</option>
        ${sprintOpts}
        <option value="__none__" ${f.sprint === '__none__' ? 'selected' : ''}>Sans sprint</option>
      </select>
      <select id="fr-f-emergent" title="Filtrer par émergence">
        <option value="">Émergence : toutes</option>
        <option value="yes" ${f.emergent === 'yes' ? 'selected' : ''}>Émergentes</option>
        <option value="no" ${f.emergent === 'no' ? 'selected' : ''}>Non émergentes</option>
      </select>
      <select id="fr-f-impl" title="Filtrer par implémentation">
        <option value="">Implémentation : toutes</option>
        <option value="yes" ${f.impl === 'yes' ? 'selected' : ''}>Implémentées</option>
        <option value="ecosystem" ${f.impl === 'ecosystem' ? 'selected' : ''}>Écosystème</option>
        <option value="hors_ecosystem" ${f.impl === 'hors_ecosystem' ? 'selected' : ''}>Hors écosystème</option>
        <option value="no" ${f.impl === 'no' ? 'selected' : ''}>Non implémentées</option>
      </select>
      <select id="fr-f-dev" title="Filtrer par statut de développement (analyse du code)">
        <option value="">Développement : tous</option>
        <option value="complet" ${f.dev === 'complet' ? 'selected' : ''}>Complet</option>
        <option value="partiel" ${f.dev === 'partiel' ? 'selected' : ''}>Partiel</option>
        <option value="non_demarre" ${f.dev === 'non_demarre' ? 'selected' : ''}>Non démarré</option>
        <option value="incoherent" ${f.dev === 'incoherent' ? 'selected' : ''}>Incohérent</option>
        <option value="__none__" ${f.dev === '__none__' ? 'selected' : ''}>Non évalué</option>
      </select>
      <select id="fr-f-link" title="Filtrer par lien manquant (index des liens)">
        <option value="">Liens : tous</option>
        <option value="sans_regle" ${f.link === 'sans_regle' ? 'selected' : ''}>Sans règle métier</option>
        <option value="sans_gherkin" ${f.link === 'sans_gherkin' ? 'selected' : ''}>Sans Gherkin</option>
        <option value="sans_adr" ${f.link === 'sans_adr' ? 'selected' : ''}>Sans ADR</option>
        <option value="sans_sprint" ${f.link === 'sans_sprint' ? 'selected' : ''}>Sans sprint</option>
      </select>
      <button type="button" class="launch-btn" id="fr-new-feat">+ Nouvelle fonctionnalité</button>
    </div>
    <div id="fr-feat-table">${frFeatureTableHtml(filtered, linkIndex)}</div>`;
  const wireRows = () => {
    panel.querySelectorAll('[data-fr-impl]').forEach((b) => b.addEventListener('click', () => frQualifyModal('feature', b.dataset.frImpl, features.find((x) => x.id === b.dataset.frImpl), renderFeaturesRules)));
    panel.querySelectorAll('[data-fr-edit]').forEach((b) => b.addEventListener('click', () => featureFormModal(features.find((x) => x.id === b.dataset.frEdit), pieces, renderFeaturesRules)));
    panel.querySelectorAll('[data-fr-detail]').forEach((b) => b.addEventListener('click', () => featureDetailModal(b.dataset.frDetail)));
    panel.querySelectorAll('[data-fr-link]').forEach((b) => b.addEventListener('click', () => linkModal(LINK_PRESETS.feature, b.dataset.frLink, refs, renderFeaturesRules)));
    panel.querySelectorAll('[data-fr-del]').forEach((b) => b.addEventListener('click', () => deleteFeatureFlow(b.dataset.frDel, renderFeaturesRules, b)));
    // Liens E2E cliquables → détail du test E2E (entité de 1er niveau).
    panel.querySelectorAll('[data-fr-e2e]').forEach((b) => b.addEventListener('click', () => e2eDetailModal(b.dataset.frE2e)));
  };
  const rerender = () => {
    frFeatureFilters = {
      q: (document.getElementById('fr-f-q') || {}).value || '',
      role: (document.getElementById('fr-f-role') || {}).value || '',
      sprint: (document.getElementById('fr-f-sprint') || {}).value || '',
      emergent: (document.getElementById('fr-f-emergent') || {}).value || '',
      impl: (document.getElementById('fr-f-impl') || {}).value || '',
      dev: (document.getElementById('fr-f-dev') || {}).value || '',
      link: (document.getElementById('fr-f-link') || {}).value || '',
    };
    const list = frFilterFeatures(features, frFeatureFilters, linkIndex);
    const table = document.getElementById('fr-feat-table');
    if (table) table.innerHTML = frFeatureTableHtml(list, linkIndex);
    const cnt = document.getElementById('fr-f-count');
    if (cnt) cnt.textContent = `${list.length} / ${(features || []).length} fonctionnalité(s)`;
    wireRows();
  };
  ['fr-f-q', 'fr-f-role', 'fr-f-sprint', 'fr-f-emergent', 'fr-f-impl', 'fr-f-dev', 'fr-f-link'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(id === 'fr-f-q' ? 'input' : 'change', rerender);
  });
  const newBtn = document.getElementById('fr-new-feat');
  if (newBtn) newBtn.addEventListener('click', () => featureFormModal(null, pieces, renderFeaturesRules));
  wireRows();
}

// Sous-panneau RÈGLES MÉTIER : toolbar de filtres PROPRES (recherche ref/content,
// rôle [union des rôles des fonctionnalités liées], émergence, sans
// fonctionnalité/sprint) + table isolée + bouton « + Nouvelle
// règle ». Même mécanique de filtrage CLIENT que le sous-panneau Fonctionnalités.
function renderFrRulePanel(rules, refs, pieces, linkIndex, sprints, projectRoles) {
  const panel = document.getElementById('fr-subpanel');
  if (!panel) return;
  const f = frRuleFilters;
  // Exécuteur : pré-régler le filtre sprint sur le sprint ACTIF (cf. features).
  if (IS_EXECUTEUR && !f.sprint) f.sprint = activeSprintFor(sprints);
  // Vocabulaire = RÔLES DISTINCTS DU PROJET (union fonctionnalités + règles), fourni
  // par l'appelant (0 appel réseau supplémentaire) — cf. décision (b) du plan.
  const roles = (projectRoles || []).slice().sort();
  const sprintOpts = (sprints || []).map((s) => `<option value="${esc(s.id)}" ${f.sprint === s.id ? 'selected' : ''}>${esc(s.title || s.id)}</option>`).join('');
  const filtered = frFilterRules(rules, f, linkIndex);
  panel.innerHTML = `
    <div class="adr-pane-filters fr-filters">
      <span class="muted-sm" id="fr-r-count">${filtered.length} / ${(rules || []).length} règle(s)</span>
      <input type="search" id="fr-r-q" class="adr-search" placeholder="Rechercher (ref, contenu…)" value="${esc(f.q || '')}">
      <select id="fr-r-role" title="Filtrer par rôle (association explicite)">
        <option value="">Rôle : tous</option>
        ${roles.map((r) => `<option value="${esc(r)}" ${f.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        <option value="__global__" ${f.role === '__global__' ? 'selected' : ''}>Global (tous les rôles)</option>
        <option value="__none__" ${f.role === '__none__' ? 'selected' : ''}>Sans rôle</option>
      </select>
      <select id="fr-r-sprint" title="Filtrer par sprint">
        <option value="">Sprint : tous</option>
        ${sprintOpts}
        <option value="__none__" ${f.sprint === '__none__' ? 'selected' : ''}>Sans sprint</option>
      </select>
      <select id="fr-r-emergent" title="Filtrer par émergence">
        <option value="">Émergence : toutes</option>
        <option value="yes" ${f.emergent === 'yes' ? 'selected' : ''}>Émergentes</option>
        <option value="no" ${f.emergent === 'no' ? 'selected' : ''}>Non émergentes</option>
      </select>
      <select id="fr-r-impl" title="Filtrer par implémentation">
        <option value="">Implémentation : toutes</option>
        <option value="yes" ${f.impl === 'yes' ? 'selected' : ''}>Implémentées</option>
        <option value="ecosystem" ${f.impl === 'ecosystem' ? 'selected' : ''}>Écosystème</option>
        <option value="hors_ecosystem" ${f.impl === 'hors_ecosystem' ? 'selected' : ''}>Hors écosystème</option>
        <option value="no" ${f.impl === 'no' ? 'selected' : ''}>Non implémentées</option>
      </select>
      <select id="fr-r-respect" title="Filtrer par statut de respect">
        <option value="">Respect : tous</option>
        <option value="respectee" ${f.respect === 'respectee' ? 'selected' : ''}>Respectées</option>
        <option value="non_respectee" ${f.respect === 'non_respectee' ? 'selected' : ''}>Non respectées</option>
        <option value="__none__" ${f.respect === '__none__' ? 'selected' : ''}>Non évaluées</option>
      </select>
      <select id="fr-r-link" title="Filtrer par lien manquant (index des liens)">
        <option value="">Liens : tous</option>
        <option value="sans_fonctionnalite" ${f.link === 'sans_fonctionnalite' ? 'selected' : ''}>Sans fonctionnalité</option>
        <option value="sans_sprint" ${f.link === 'sans_sprint' ? 'selected' : ''}>Sans sprint</option>
      </select>
      <button type="button" class="launch-btn" id="fr-new-rule">+ Nouvelle règle</button>
    </div>
    <div id="fr-rule-table">${frRuleTableHtml(filtered, linkIndex)}</div>`;
  const wireRows = () => {
    panel.querySelectorAll('[data-rule-impl]').forEach((b) => b.addEventListener('click', () => frQualifyModal('rule', b.dataset.ruleImpl, rules.find((x) => x.id === b.dataset.ruleImpl), renderFeaturesRules)));
    panel.querySelectorAll('[data-rule-edit]').forEach((b) => b.addEventListener('click', () => ruleFormModal(rules.find((x) => x.id === b.dataset.ruleEdit), pieces, renderFeaturesRules, roles)));
    panel.querySelectorAll('[data-rule-detail]').forEach((b) => b.addEventListener('click', () => ruleDetailModal(b.dataset.ruleDetail)));
    panel.querySelectorAll('[data-rule-link]').forEach((b) => b.addEventListener('click', () => linkModal(LINK_PRESETS.rule, b.dataset.ruleLink, refs, renderFeaturesRules)));
    panel.querySelectorAll('[data-rule-del]').forEach((b) => b.addEventListener('click', () => deleteRuleFlow(b.dataset.ruleDel, renderFeaturesRules, b)));
  };
  const rerender = () => {
    frRuleFilters = {
      q: (document.getElementById('fr-r-q') || {}).value || '',
      role: (document.getElementById('fr-r-role') || {}).value || '',
      sprint: (document.getElementById('fr-r-sprint') || {}).value || '',
      emergent: (document.getElementById('fr-r-emergent') || {}).value || '',
      impl: (document.getElementById('fr-r-impl') || {}).value || '',
      respect: (document.getElementById('fr-r-respect') || {}).value || '',
      link: (document.getElementById('fr-r-link') || {}).value || '',
    };
    const list = frFilterRules(rules, frRuleFilters, linkIndex);
    const table = document.getElementById('fr-rule-table');
    if (table) table.innerHTML = frRuleTableHtml(list, linkIndex);
    const cnt = document.getElementById('fr-r-count');
    if (cnt) cnt.textContent = `${list.length} / ${(rules || []).length} règle(s)`;
    wireRows();
  };
  ['fr-r-q', 'fr-r-role', 'fr-r-sprint', 'fr-r-emergent', 'fr-r-impl', 'fr-r-respect', 'fr-r-link'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(id === 'fr-r-q' ? 'input' : 'change', rerender);
  });
  const newBtn = document.getElementById('fr-new-rule');
  if (newBtn) newBtn.addEventListener('click', () => ruleFormModal(null, pieces, renderFeaturesRules, roles));
  wireRows();
}

// Dispatch du sous-onglet actif (A007 / A008) dans le panneau `#fr-subpanel`.
// `sprints`/`projectRoles` = options des filtres + vocabulaire du formulaire règle
// (calculés une fois dans `renderFeaturesRules`, 0 appel réseau supplémentaire).
function renderFrSubpanel(features, rules, refs, pieces, linkIndex, sprints, projectRoles) {
  if (frSubTab === 'rules') renderFrRulePanel(rules, refs, pieces, linkIndex, sprints, projectRoles);
  else renderFrFeaturePanel(features, refs, pieces, linkIndex, sprints);
}

async function renderFeaturesRules() {
  const pane = document.getElementById('pane-features');
  if (!pane) return;
  if (!currentProject) {
    pane.innerHTML = '<h2>Fonctionnalités & Règles</h2><p class="muted-sm">Ouvrez un projet.</p>';
    return;
  }
  pane.innerHTML = `<h2>Fonctionnalités & Règles métier <span class="muted-sm">${esc(currentProject)}</span></h2><p class="muted-sm">Chargement…</p>`;
  const [featRes, ruleRes, docRes, e2eRes, sprintRes, taskRes, recRes, pieceRes] = await Promise.all([
    api(`/api/features?projectId=${encodeURIComponent(currentProject)}`).catch(() => ({ features: [] })),
    api(`/api/rules?projectId=${encodeURIComponent(currentProject)}`).catch(() => ({ rules: [] })),
    api(`/api/docs?projectId=${encodeURIComponent(currentProject)}&includeRepoDocs=1`).catch(() => ({ docs: [] })),
    api(`/api/e2e-tests?project=${encodeURIComponent(currentProject)}`).catch(() => ({ tests: [] })),
    api(`/api/sprints?projectId=${encodeURIComponent(currentProject)}`).catch(() => ({ sprints: [] })),
    api('/api/tasks').catch(() => ({ tasks: [] })),
    api(`${cadragesApiBase()}?project=${encodeURIComponent(currentProject)}`).catch(() => ({ cadrages: [] })),
    api(`/api/pieces?projectId=${encodeURIComponent(currentProject)}`).catch(() => ({ pieces: [] })),
  ]);
  const features = featRes.features || [];
  const rules = ruleRes.rules || [];
  const pieces = pieceRes.pieces || [];
  const refs = {
    rule: rules.map((r) => ({ id: r.id, label: `${r.ref} — ${(r.content || '').slice(0, 60)}` })),
    feature: features.map((f) => ({ id: f.id, label: `${f.ref} — ${(f.userStory || '').slice(0, 60)}` })),
    gherkin: (e2eRes.tests || []).map((t) => ({ id: t.id, label: `${t.id} — ${(t.scenario || t.title || '').slice(0, 60)}` })),
    adr: (docRes.docs || []).filter((d) => d.kind === 'adr-tech').map((d) => ({ id: d.docId, label: `${d.title || d.docId}` })),
    sprint: (sprintRes.sprints || []).map((s) => ({ id: s.id, label: `${s.title || s.id} (${s.status})` })),
    task: (taskRes.tasks || []).filter((t) => !t.project || t.project === currentProject).map((t) => ({ id: t.id, label: `${t.id} — ${(t.title || t.request || '').slice(0, 50)}` })),
    cadrage: (recRes.cadrages || []).map((r) => ({ id: r.cadrage_id, label: `${r.cadrage_id} — ${(r.title || '').slice(0, 50)}` })),
  };
  // Index DÉTERMINISTE des liens : alimente la colonne « Liens » ET les filtres
  // « sans lien » des DEUX sous-onglets — désormais SANS appel réseau (dérivé du
  // payload des listes qui portent `links`, calculés en 1 requête bulk).
  const linkIndex = buildFeatureRuleLinkIndex(features, rules);
  // Options du filtre SPRINT = sprints du projet courant (déjà chargés) + « Sans sprint ».
  const sprints = sprintRes.sprints || [];
  // Vocabulaire des rôles = RÔLES DISTINCTS DU PROJET (union `fonctionnalites.role`
  // + rôles explicitement associés aux règles) — décision (b) du plan, 0 référentiel.
  const projectRoles = [...new Set([
    ...features.map((x) => x.role).filter(Boolean),
    ...rules.flatMap((x) => x.roles || []),
  ])].sort();
  if (features.length && !features[0].links && !frLinkWarned) {
    frLinkWarned = true;
    console.warn('[orchestrator-panel] feature_list/rule_list ne renvoient pas `links` : colonne « Liens » en repli — le registre MCP n\'est probablement pas déployé.');
  }
  const subtabBtn = (tab, label, count) => `<button type="button" class="pd-tab ${frSubTab === tab ? 'active' : ''}" data-fr-subtab="${tab}">${esc(label)} <span class="muted-sm">(${count})</span></button>`;
  pane.innerHTML = `
    <h2>Fonctionnalités & Règles métier <span class="muted-sm">${esc(currentProject)}</span></h2>
    <p class="muted-sm">Deux natures d'entités, deux sous-onglets : <strong>Fonctionnalités</strong> (<code>US-xxx</code>) et <strong>Règles métier</strong> (<code>RM-xxxx</code>). Chacun a ses propres filtres et son CRUD. L'agent propose, l'humain valide/ajuste.</p>
    <div class="pd-tabs fr-subtabs">
      ${subtabBtn('features', 'Fonctionnalités', features.length)}
      ${subtabBtn('rules', 'Règles métier', rules.length)}
    </div>
    <div class="pd-panel fr-subpanel" id="fr-subpanel"></div>`;
  pane.querySelectorAll('[data-fr-subtab]').forEach((b) => b.addEventListener('click', () => {
    frSubTab = b.dataset.frSubtab === 'rules' ? 'rules' : 'features';
    persistFrSubTab();
    pane.querySelectorAll('[data-fr-subtab]').forEach((x) => x.classList.toggle('active', x.dataset.frSubtab === frSubTab));
    renderFrSubpanel(features, rules, refs, pieces, linkIndex, sprints, projectRoles);
  }));
  renderFrSubpanel(features, rules, refs, pieces, linkIndex, sprints, projectRoles);
}

// ===========================================================================
// CARDINALITÉS & ÉMERGENCE (ADR-001 §5, T6/T7) — restituées en CARTES
// statistiques CLIQUABLES dans la Vue d'ensemble (l'onglet « Émergents » a été
// retiré). Compteurs + ensembles d'ids proviennent de la route existante
// `GET /api/cardinality` (source de vérité = registre ; le panneau ne recalcule
// JAMAIS l'émergence). Les signaux (clôture TRACÉE, résolution obligatoire)
// restent accessibles via un point d'entrée DISCRET (modale), sans table
// volumineuse affichée en permanence.
// ===========================================================================

// 10 indicateurs = 10 vues du registre. `tab`/`filter` = cible du clic :
// onglet à ouvrir + valeur du filtre pré-appliqué (select visible) de la page.
const CARDINALITY_CARDS = [
  { view: 'tache_sans_adr',              label: 'Tâches sans ADR',               tab: 'tasks',    filter: 'tache_sans_adr' },
  { view: 'tache_sans_fonctionnalite',   label: 'Tâches sans fonctionnalité',    tab: 'tasks',    filter: 'tache_sans_fonctionnalite' },
  { view: 'tache_sans_sprint',           label: 'Tâches sans sprint',            tab: 'tasks',    filter: 'tache_sans_sprint' },
  { view: 'cadrage_sans_adr',            label: 'Cadrages sans ADR',             tab: 'cadrages', filter: 'cadrage_sans_adr' },
  { view: 'cadrage_sans_fonctionnalite', label: 'Cadrages sans fonctionnalité',  tab: 'cadrages', filter: 'cadrage_sans_fonctionnalite' },
  { view: 'cadrage_sans_sprint',         label: 'Cadrages sans sprint',          tab: 'cadrages', filter: 'cadrage_sans_sprint' },
  { view: 'adr_sans_fonctionnalite',     label: 'ADR sans fonctionnalité',       tab: 'adr',      filter: 'adr_sans_fonctionnalite' },
  { view: 'sprint_sans_fonctionnalite',  label: 'Sprints sans fonctionnalité',   tab: 'sprints',  filter: 'sprint_sans_fonctionnalite' },
  { view: 'sprint_sans_regle',           label: 'Sprints sans règle métier',     tab: 'sprints',  filter: 'sprint_sans_regle' },
  { view: 'emergents',                   label: 'Éléments émergents',            tab: 'tasks',    filter: 'emergents' },
];

// Cache client (15 s) de l'agrégat `/api/cardinality` : évite de refetcher à
// chaque rendu (polling). En cas d'échec, l'appelant dégrade proprement (liste
// non filtrée / message muted) — jamais d'exception qui casse l'onglet.
const CARDINALITY_CACHE_MS = 15000;
let cardinalityCache = { projectId: null, at: 0, rep: null, promise: null };

async function cardinalityReportCached(projectId) {
  const pid = projectId || currentProject;
  if (!pid) return null;
  const fresh = cardinalityCache.projectId === pid && cardinalityCache.rep && (Date.now() - cardinalityCache.at) < CARDINALITY_CACHE_MS;
  if (fresh) return cardinalityCache.rep;
  if (cardinalityCache.projectId === pid && cardinalityCache.promise) return cardinalityCache.promise;
  const p = api(`/api/cardinality?projectId=${encodeURIComponent(pid)}`)
    .then((rep) => { cardinalityCache = { projectId: pid, at: Date.now(), rep, promise: null }; return rep; })
    .catch((e) => { cardinalityCache = { projectId: pid, at: 0, rep: null, promise: null }; throw e; });
  cardinalityCache = { projectId: pid, at: 0, rep: null, promise: p };
  return p;
}

// Ensemble d'ids d'une vue de cardinalité (éventuellement restreint à un
// `entityType` : la vue `emergents` agrège tâches/fonctionnalités/règles/pièces).
function cardinalityIdSet(rep, view, entityType) {
  const items = (rep && rep.views && rep.views[view] && rep.views[view].items) || [];
  const list = entityType ? items.filter((it) => it.entityType === entityType) : items;
  return new Set(list.map((it) => it.id).filter(Boolean));
}

// Ensemble d'ids prêt à l'emploi pour un filtre cible. `null` = filtre INACTIF
// (pas de projet, ou appel en échec → liste NON filtrée, jamais vide).
async function cardinalityIdSetFor(view, entityType) {
  if (!currentProject || !view) return null;
  try {
    const rep = await cardinalityReportCached(currentProject);
    if (!rep) return null;
    return cardinalityIdSet(rep, view, entityType);
  } catch { return null; }
}

// --- Cartes de la Vue d'ensemble (compteurs + point d'entrée signaux) ------
// Rendues uniquement quand un projet est ouvert. Les compteurs sont remplis
// ensuite par `wireCardinalityOverview` (dégradation `—` si l'appel échoue).
function cardinalitySectionHtml() {
  if (!currentProject) return '';
  const cards = CARDINALITY_CARDS.map((c) => `<button type="button" class="card card-link" data-card-view="${esc(c.view)}" title="Ouvrir : ${esc(c.label)} (filtre pré-appliqué)">
    <div class="num" data-card-count="${esc(c.view)}">…</div>
    <div class="lbl">${esc(c.label)}</div>
  </button>`).join('');
  return `<div class="section card-stats-section">
    <h3>Cardinalités &amp; émergence</h3>
    <div class="muted-sm">Indicateurs de traçage du projet (renvoyés par le registre, <strong>non bloquant</strong>). Cliquez une carte pour ouvrir la page cible avec le filtre pré-appliqué.</div>
    <div class="cards">${cards}</div>
    <div class="muted-sm card-signals-entry"><button type="button" class="ghost tiny" id="card-signals-open" title="Signaux de cardinalité — clôture tracée (résolution obligatoire)">Signaux de cardinalité — <span id="card-signals-count">…</span></button></div>
  </div>`;
}

async function wireCardinalityOverview() {
  const pane = document.getElementById('pane-overview');
  if (!pane) return;
  pane.querySelectorAll('[data-card-view]').forEach((b) => b.addEventListener('click', () => openCardinalityTarget(b.dataset.cardView)));
  const sigBtn = document.getElementById('card-signals-open');
  if (sigBtn) sigBtn.addEventListener('click', () => cardinalitySignalsModal());
  if (!currentProject) return;
  let rep = null;
  try { rep = await cardinalityReportCached(currentProject); } catch { rep = null; }
  if (!rep) {
    pane.querySelectorAll('[data-card-count]').forEach((el) => { el.textContent = '—'; });
    const cnt = document.getElementById('card-signals-count');
    if (cnt) cnt.textContent = 'indisponibles';
    return;
  }
  const counts = rep.counts || {};
  pane.querySelectorAll('[data-card-count]').forEach((el) => {
    const v = el.dataset.cardCount;
    el.textContent = counts[v] == null ? '—' : String(counts[v]);
  });
  const cnt = document.getElementById('card-signals-count');
  if (cnt) cnt.textContent = `${(rep.signals && rep.signals.open) || 0} ouvert(s) / ${(rep.signals && rep.signals.total) || 0}`;
}

// Modale DISCRÈTE des signaux de cardinalité — la table n'est plus affichée en
// permanence. Clôture TRACÉE : la résolution est OBLIGATOIRE (prompt non vide).
async function cardinalitySignalsModal() {
  if (!currentProject) { alert('Ouvrez un projet pour voir ses signaux de cardinalité.'); return; }
  showModal(`<div class="modal modal-wide">
    <h2>Signaux de cardinalité <span class="muted-sm">${esc(currentProject)}</span></h2>
    <p class="muted-sm">Manques de cardinalité détectés par le registre (<strong>non bloquant</strong>). La clôture d'un signal exige une résolution tracée.</p>
    <div id="card-signals-body"><div class="muted-sm">Chargement…</div></div>
    <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
  </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  let rep = null, err = '';
  try { rep = await cardinalityReportCached(currentProject); } catch (e) { err = e.message || String(e); }
  const body = document.getElementById('card-signals-body');
  if (!body) return;
  if (!rep) { body.innerHTML = `<p class="msg error">${esc(err || 'Signaux indisponibles')}</p>`; return; }
  const signals = (rep.signals && rep.signals.items) || [];
  const rows = signals.map((s) => `<tr>
    <td><code class="chip">${esc(s.signalId)}</code></td>
    <td>${esc(s.entityType || '')}</td>
    <td><code class="muted-sm">${esc(s.entityId || '')}</code></td>
    <td>${(s.missing || []).map((m) => `<span class="chip">${esc(m)}</span>`).join(' ') || '—'}</td>
    <td>${s.status === 'open' ? '<span class="badge awaiting">ouvert</span>' : '<span class="badge done">résolu</span>'}${s.stale ? ' <span class="chip" title="manques comblés depuis">stale</span>' : ''}</td>
    <td class="e2e-actions">${s.status === 'open' ? `<button type="button" class="ghost tiny" data-card-resolve="${esc(s.signalId)}">Clôturer</button>` : `<span class="muted-sm">${esc(s.resolution || '')}</span>`}</td>
  </tr>`).join('');
  body.innerHTML = `
    <div class="adr-pane-filters">
      <span class="muted-sm">Généré : ${esc(String(rep.generatedAt || '').replace('T', ' ').slice(0, 19))}</span>
      <span class="muted-sm">Signaux : ${(rep.signals && rep.signals.open) || 0} ouvert(s) / ${(rep.signals && rep.signals.total) || 0}</span>
    </div>
    <div class="adr-table-wrap"><table class="adr-table">
      <thead><tr><th>Signal</th><th>Entité</th><th>Id</th><th>Manques</th><th>Statut</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted-sm" style="padding:10px">Aucun signal.</td></tr>'}</tbody>
    </table></div>`;
  body.querySelectorAll('[data-card-resolve]').forEach((b) => b.addEventListener('click', async () => {
    const resolution = prompt('Résolution (raison tracée obligatoire) :');
    if (!resolution || !resolution.trim()) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Clôture');
    try {
      await api(`/api/cardinality/signals/${encodeURIComponent(b.dataset.cardResolve)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: resolution.trim() }) });
      cardinalityCache = { projectId: null, at: 0, rep: null, promise: null };
      await cardinalitySignalsModal();
    } catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Clôture impossible : ' + (e.message || e));
    }
  }));
}

// ===========================================================================
// Sélecteur ADR multi-lignes (item 125) — remplace l'ancienne liste BRUTE de
// documents (.as-doc / .ea-doc / .rm-refdoc). Lignes COMPACTES et structurées :
// case à cocher + titre + badge de statut + chips repos + badge globale +
// décision condensée. Filtres statut/repo + recherche. Réutilise ADR_STATUS,
// adrStatusBadge, adrGlobalBadge, adrCellText.
//   adrs : docs kind='adr-tech' (adr_list ou GET /api/docs filtré kind)
//   opts : { prefix, repos, selected } — prefix = id du bloc ; selected = ids
//          cochés (null/absent = toutes cochées) ; repos = repos du projet (noms).
// L'appelant lit la sélection via selectedAdrIds(prefix).
// ===========================================================================
function adrSelectorHtml(adrs, opts = {}) {
  const prefix = opts.prefix || 'adr-pick';
  const repos = opts.repos || [];
  const repoName = (rid) => {
    const r = repos.find((x) => (x && (x.id || x.repoId || x)) === rid);
    return r ? (r.name || r.id || r.repoId || rid) : rid;
  };
  const selected = Array.isArray(opts.selected) ? opts.selected : null; // null = toutes cochées
  const list = adrs || [];
  const statusOpts = ['', ...ADR_STATUS]
    .map((s) => `<option value="${esc(s)}">${s ? esc(s) : '— tous les statuts —'}</option>`).join('');
  const repoIds = [...new Set(list.flatMap((d) => (Array.isArray(d.repos) ? d.repos : [])))];
  const repoOpts = ['', ...repoIds]
    .map((r) => `<option value="${esc(r)}">${r ? esc(repoName(r)) : '— tous les repos —'}</option>`).join('');
  const rows = list.map((d) => {
    const id = d.adrId || d.docId;
    const checked = (!selected || selected.includes(id)) ? 'checked' : '';
    const chips = (Array.isArray(d.repos) ? d.repos : [])
      .map((rid) => `<code class="chip-repo" title="Repo rattaché">${esc(repoName(rid))}</code>`).join(' ');
    const meta = [adrStatusBadge(d.status), d.isGlobal ? adrGlobalBadge(d) : '', chips].filter(Boolean).join(' ');
    const dec = d.decision ? adrCellText(d.decision, 120) : '<span class="muted-sm">—</span>';
    const hay = [d.title, d.status, (d.repos || []).join(' '), d.decision, d.path].filter(Boolean).join(' ').toLowerCase();
    return `<label class="adr-pick-row" data-search="${esc(hay)}" data-status="${esc(d.status || '')}" data-repos="${esc((d.repos || []).join(' '))}">
      <input type="checkbox" class="adr-pick-cb" value="${esc(id)}" ${checked} title="${esc(d.path || '')}">
      <span class="adr-pick-head"><strong>${esc(d.title || id)}</strong> ${meta}</span>
      <span class="adr-pick-meta">${dec}</span>
    </label>`;
  }).join('');
  return `
    <div class="adr-pick" id="${esc(prefix)}">
      <div class="adr-pick-filters">
        <input type="search" class="adr-pick-search" placeholder="Rechercher une ADR…">
        <select class="adr-pick-status">${statusOpts}</select>
        <select class="adr-pick-repo">${repoOpts}</select>
        <span class="muted-sm adr-pick-count">${list.length} ADR</span>
      </div>
      <div class="adr-pick-list">${rows || '<p class="muted-sm">Aucune ADR pour ce projet — créez-en une via l\'onglet ADR du projet.</p>'}</div>
    </div>`;
}

// Sélection courante (ids cochés) du sélecteur ADR de préfixe `prefix`.
function selectedAdrIds(prefix = 'adr-pick') {
  return [...document.querySelectorAll(`#modal-backdrop #${prefix} .adr-pick-cb:checked`)].map((c) => c.value);
}

// Câble les filtres (recherche + statut + repo) du sélecteur ADR — à appeler
// après insertion du HTML dans la modale.
function bindAdrSelector(prefix = 'adr-pick') {
  const root = document.getElementById(prefix);
  if (!root) return;
  const search = root.querySelector('.adr-pick-search');
  const status = root.querySelector('.adr-pick-status');
  const repo = root.querySelector('.adr-pick-repo');
  const count = root.querySelector('.adr-pick-count');
  const rows = [...root.querySelectorAll('.adr-pick-row')];
  const apply = () => {
    const q = ((search && search.value) || '').trim().toLowerCase();
    const st = (status && status.value) || '';
    const rp = (repo && repo.value) || '';
    let visible = 0;
    for (const row of rows) {
      const okQ = !q || (row.dataset.search || '').includes(q);
      const okS = !st || row.dataset.status === st;
      const okR = !rp || (row.dataset.repos || '').split(/\s+/).includes(rp);
      const show = okQ && okS && okR;
      row.hidden = !show;
      if (show) visible++;
    }
    if (count) count.textContent = `${visible} / ${rows.length} ADR`;
  };
  [search, status, repo].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  apply();
}

// ===========================================================================
// Sélecteurs multi-lignes FONCTIONNALITÉS / RÈGLES MÉTIER (T-20260922-070103-ncs1)
// — helper GÉNÉRIQUE réutilisant les classes CSS `.adr-pick*` (aucun CSS ajouté).
// Lignes : case + ref + badge (rôle / « Global ») + texte condensé. Filtres :
// recherche libre + rôle (options = rôles distincts du projet ; + « Global » pour
// les règles). TOUT COCHÉ par défaut ; décocher tout est permis (0 sélection).
//   frSelectorHtml('feature'|'rule', items, { prefix, roles, selected })
//   selectedFrIds(kind, prefix) → tableau d'ids cochés (vide si rien de coché)
//   bindFrSelector(prefix) → câble recherche + filtre rôle
// ===========================================================================
function frSelectorHtml(kind, items, opts = {}) {
  const isRule = kind === 'rule';
  const prefix = opts.prefix || (isRule ? 'rule-pick' : 'feature-pick');
  const selected = Array.isArray(opts.selected) ? opts.selected : null; // null = tout coché
  const list = items || [];
  const roles = Array.isArray(opts.roles) ? opts.roles.filter(Boolean) : [];
  const roleOpts = ['', ...roles, ...(isRule ? ['__global__'] : [])]
    .map((r) => `<option value="${esc(r)}">${r === '' ? '— tous les rôles —' : (r === '__global__' ? 'Global (tous les rôles)' : esc(r))}</option>`).join('');
  const rows = list.map((it) => {
    const id = it.id;
    const checked = (!selected || selected.includes(id)) ? 'checked' : '';
    const ref = it.ref || id;
    let badgeHtml = '';
    let meta = '';
    let hay = '';
    let roleData = '';
    if (isRule) {
      const rolesTxt = Array.isArray(it.roles) ? it.roles.filter(Boolean) : [];
      badgeHtml = it.roleGlobal
        ? '<span class="badge">Global</span>'
        : (rolesTxt.length ? rolesTxt.map((r) => `<span class="badge">${esc(r)}</span>`).join(' ') : '<span class="muted-sm">sans rôle</span>');
      meta = it.content ? adrCellText(it.content, 120) : '<span class="muted-sm">—</span>';
      hay = [it.ref, it.content, rolesTxt.join(' '), it.roleGlobal ? 'global' : ''].filter(Boolean).join(' ').toLowerCase();
      roleData = it.roleGlobal ? '__global__' : rolesTxt.join(' ');
    } else {
      badgeHtml = it.role ? `<span class="badge">${esc(it.role)}</span>` : '<span class="muted-sm">sans rôle</span>';
      meta = it.userStory ? adrCellText(it.userStory, 120) : '<span class="muted-sm">—</span>';
      hay = [it.ref, it.role, it.userStory].filter(Boolean).join(' ').toLowerCase();
      roleData = it.role || '';
    }
    return `<label class="adr-pick-row" data-search="${esc(hay)}" data-role="${esc(roleData)}">
      <input type="checkbox" class="adr-pick-cb" value="${esc(id)}" ${checked}>
      <span class="adr-pick-head"><strong>${esc(ref)}</strong> ${badgeHtml}</span>
      <span class="adr-pick-meta">${meta}</span>
    </label>`;
  }).join('');
  const label = isRule ? 'règle métier' : 'fonctionnalité';
  const unit = isRule ? 'règles' : 'fonctionnalités';
  // Contexte de création : projet explicite (sinon projet courant) + signal
  // d'émergence `cadrage` (création depuis une recette évaluateur / un cadrage).
  const createProject = opts.projectId || currentProject || '';
  // Bouton « ＋ Créer une … manquante » : ADMIN uniquement (ADR-001). Le clic est
  // câblé par `bindFrSelector` (ouvre la modale de création puis coche l'élément).
  const createBtn = IS_ADMIN
    ? `<button type="button" class="ghost" data-fr-create="${isRule ? 'rule' : 'feature'}" title="Créer une ${label} manquante (marquée émergente, rattachée à ${opts.entityWord ? `ce ${opts.entityWord}` : 'le cadrage/cadrage'})">＋ Créer une ${label} manquante</button>`
    : '';
  return `
    <div class="adr-pick" id="${esc(prefix)}" data-unit="${esc(unit)}" data-project-id="${esc(createProject)}" data-from-cadrage="${opts.fromCadrage ? '1' : '0'}" data-recette-id="${esc(opts.cadrageId || '')}">
      <div class="adr-pick-filters">
        <input type="search" class="adr-pick-search" placeholder="Rechercher une ${label}…">
        <select class="adr-pick-role">${roleOpts}</select>
        <span class="muted-sm adr-pick-count">${list.length} ${unit}</span>
        ${createBtn}
      </div>
      <div class="adr-pick-list">${rows || `<p class="muted-sm">Aucune ${label} pour ce projet — créez-en via l\'onglet « Fonctionnalités & Règles ».</p>`}</div>
    </div>`;
}

// Sélection courante (ids cochés) d'un sélecteur Fonctionnalités/Règles de
// préfixe `prefix`. Retourne TOUJOURS un tableau (vide = 0 sélection).
function selectedFrIds(kind, prefix) {
  return [...document.querySelectorAll(`#modal-backdrop #${prefix} .adr-pick-cb:checked`)].map((c) => c.value);
}

// Câble recherche + filtre rôle du sélecteur Fonctionnalités/Règles `prefix`.
// `opts` (optionnel) : `{ pieces, projectRoles, onCreated(kind, newId, entity) }`.
// Si le bouton admin « ＋ Créer une … manquante » est présent, son clic ouvre la
// modale de création (contexte projet + émergence `cadrage`), puis la nouvelle
// ligne est insérée COCHÉE dans la liste et `onCreated` est appelé (rattachement).
function bindFrSelector(prefix, opts = {}) {
  const root = document.getElementById(prefix);
  if (!root) return;
  const search = root.querySelector('.adr-pick-search');
  const role = root.querySelector('.adr-pick-role');
  const count = root.querySelector('.adr-pick-count');
  const rows = [...root.querySelectorAll('.adr-pick-row')];
  let total = rows.length;
  const unit = root.dataset.unit || '';
  const apply = () => {
    const q = ((search && search.value) || '').trim().toLowerCase();
    const rp = (role && role.value) || '';
    let visible = 0;
    for (const row of rows) {
      const okQ = !q || (row.dataset.search || '').includes(q);
      const okR = !rp || (row.dataset.role || '').split(/\s+/).includes(rp);
      const show = okQ && okR;
      row.hidden = !show;
      if (show) visible++;
    }
    if (count) count.textContent = `${visible} / ${total} ${unit}`.trim();
  };
  [search, role].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  // Insertion d'une ligne (nouvel élément créé) COCHÉE, puis rafraîchissement.
  const appendRow = (kind, it) => {
    const list = root.querySelector('.adr-pick-list');
    if (!list || !it || !it.id) return;
    const isRule = kind === 'rule';
    const ref = it.ref || it.id;
    const meta = isRule ? (it.content || '') : (it.userStory || '');
    const badge = isRule
      ? (it.roleGlobal ? '<span class="badge">Global</span>' : '')
      : (it.role ? `<span class="badge">${esc(it.role)}</span>` : '');
    const row = document.createElement('label');
    row.className = 'adr-pick-row';
    row.dataset.search = [it.ref, meta].join(' ').toLowerCase();
    row.dataset.role = isRule ? (it.roleGlobal ? '__global__' : (Array.isArray(it.roles) ? it.roles.join(' ') : '')) : (it.role || '');
    row.innerHTML = `<input type="checkbox" class="adr-pick-cb" value="${esc(it.id)}" checked><span class="adr-pick-head"><strong>${esc(ref)}</strong> ${badge} <span class="chip" title="Élément créé depuis ${opts.entityWord ? `ce ${opts.entityWord}` : 'le cadrage/cadrage'}">émergent</span></span><span class="adr-pick-meta">${meta ? adrCellText(meta, 120) : '<span class="muted-sm">—</span>'}</span>`;
    const placeholder = list.querySelector('p.muted-sm');
    if (placeholder) placeholder.remove();
    list.prepend(row);
    rows.push(row);
    total += 1;
    apply();
  };
  const createBtn = root.querySelector('[data-fr-create]');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const kind = createBtn.dataset.frCreate === 'rule' ? 'rule' : 'feature';
      const projectId = root.dataset.projectId || currentProject;
      const fromCadrage = root.dataset.fromCadrage === '1';
      const cadrageId = root.dataset.cadrageId || '';
      const onSaved = async (created) => {
        const entity = kind === 'rule' ? (created && created.rule) : (created && created.feature);
        const newId = entity && entity.id;
        if (entity) appendRow(kind, entity);
        if (typeof opts.onCreated === 'function') await opts.onCreated(kind, newId, entity);
      };
      if (kind === 'rule') ruleFormModal(null, opts.pieces || [], onSaved, opts.projectRoles || [], { projectId, fromCadrage, cadrageId });
      else featureFormModal(null, opts.pieces || [], onSaved, { projectId, fromCadrage, cadrageId });
    });
  }
  apply();
}

// ===========================================================================
// Sélecteur multi-lignes ÉLÉMENTS DE CADRAGE ÉVALUATEUR « à traiter »
// (T-20260922-141007-p4dc) — réutilise les classes CSS `.adr-pick*` (aucun CSS
// ajouté), comme les sélecteurs ADR / Fonctionnalités / Règles. Les candidats
// proviennent de `GET /api/recettes/treatable?project=…` : uniquement les
// éléments `decision='a_traiter'` (garde portée par le registre). AUCUN coché
// par défaut (la reprise est un choix explicite).
//   evalItemSelectorHtml(items, { prefix }) → HTML (message explicite si vide)
//   selectedEvalItemIds(prefix) → tableau d'itemId cochés (vide si rien)
//   bindEvalItemSelector(prefix) → câble le filtre recherche + le compteur
// ===========================================================================
function evalItemSelectorHtml(items, opts = {}) {
  const prefix = opts.prefix || 'eval-item-pick';
  const list = items || [];
  const rows = list.map((it) => {
    const id = it.itemId;
    const origin = it.recetteTitle || it.recetteId || `#${id}`;
    const repris = (Array.isArray(it.reprisPar) && it.reprisPar.length)
      ? `<span class="muted-sm" title="Déjà repris par un cadrage">· déjà repris par ${esc(it.reprisPar.map((r) => r.title || r.cadrageId).join(', '))}</span>`
      : '';
    const hay = [origin, it.content, it.category, it.severity].filter(Boolean).join(' ').toLowerCase();
    return `<label class="adr-pick-row" data-search="${esc(hay)}">
      <input type="checkbox" class="eval-item-cb" value="${esc(id)}">
      <span class="adr-pick-head"><strong>${esc(origin)}</strong> ${evalCategoryBadge(it.category)} ${evalSeverityBadge(it.severity)} ${repris}</span>
      <span class="adr-pick-meta">${esc((it.content || '').slice(0, 140))}</span>
    </label>`;
  }).join('');
  return `
    <div class="adr-pick" id="${esc(prefix)}" data-unit="élément(s)">
      <div class="adr-pick-filters">
        <input type="search" class="adr-pick-search" placeholder="Rechercher un élément « à traiter »…">
        <span class="muted-sm adr-pick-count">${list.length} élément(s)</span>
      </div>
      <div class="adr-pick-list">${rows || '<p class="muted-sm">Aucun élément « à traiter » pour ce projet.</p>'}</div>
    </div>`;
}

// Sélection courante (itemId cochés) du sélecteur Éléments évaluateur `prefix`.
// Retourne TOUJOURS un tableau (vide = 0 sélection).
function selectedEvalItemIds(prefix = 'eval-item-pick') {
  return [...document.querySelectorAll(`#modal-backdrop #${prefix} .eval-item-cb:checked`)].map((c) => c.value);
}

// Câble le filtre recherche + le compteur du sélecteur `prefix`.
function bindEvalItemSelector(prefix = 'eval-item-pick') {
  const root = document.getElementById(prefix);
  if (!root) return;
  const search = root.querySelector('.adr-pick-search');
  const count = root.querySelector('.adr-pick-count');
  const rows = [...root.querySelectorAll('.adr-pick-row')];
  const apply = () => {
    const q = ((search && search.value) || '').trim().toLowerCase();
    let visible = 0;
    for (const row of rows) {
      const show = !q || (row.dataset.search || '').includes(q);
      row.hidden = !show;
      if (show) visible++;
    }
    if (count) count.textContent = `${visible} / ${rows.length} élément(s)`;
  };
  if (search) search.addEventListener('input', apply);
  apply();
}

// ===========================================================================
// Modale CRÉATION / ÉDITION d'une ADR (kind=adr-tech) rattachée au projet.
// - création : POST /api/docs (import fichier OU chemin) + repoIds 1..N ou global
// - édition  : PUT /api/docs/:id (champs ADR + addRepoIds + setGlobal)
// Le retrait d'un repo précis n'est pas exposé par l'interface registre (additif).
// ===========================================================================
function adrFormModal(p, repos, adr, onSaved) {
  const isEdit = !!(adr && adr.docId);
  const projRepos = repos || [];
  const currentRepos = (adr && Array.isArray(adr.repos)) ? adr.repos : [];
  const curStatus = (adr && adr.status) || 'Proposé';
  const statusOpts = ADR_STATUS.map((s) => `<option value="${esc(s)}" ${curStatus === s ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const repoChecks = projRepos.length
    ? projRepos.map((r) => {
        const checked = currentRepos.includes(r.id) ? 'checked' : '';
        return `<label style="display:inline-flex;gap:4px;align-items:center;margin:2px 10px 2px 0"><input type="checkbox" class="pd-adr-repo" value="${esc(r.id)}" ${checked}> ${esc(r.name || r.id)}</label>`;
      }).join('')
    : '<span class="muted-sm">Aucun repo associé à ce projet.</span>';
  const globalChecked = !!(adr && adr.isGlobal);
  showModal(`
    <div class="modal modal-wide">
      <h2>${isEdit ? 'Éditer l\'ADR' : 'Nouvelle ADR'}</h2>
      <p class="muted-sm">Projet <code>${esc(p.id)}</code> — ADR (architecture technique) structurée.</p>
      <label class="modal-field">Titre
        <input id="adr-title" value="${esc((adr && adr.title) || '')}" placeholder="ex. ADR — Architecture du module X" required>
      </label>
      <label class="modal-field">Statut
        <select id="adr-status">${statusOpts}</select>
      </label>
      <label class="modal-field">Contexte
        <textarea id="adr-context" class="modal-textarea" rows="3" placeholder="Contexte / problème">${esc((adr && adr.context) || '')}</textarea>
      </label>
      <label class="modal-field">Décision
        <textarea id="adr-decision" class="modal-textarea" rows="3" placeholder="Décision">${esc((adr && adr.decision) || '')}</textarea>
      </label>
      <label class="modal-field">Conséquences
        <textarea id="adr-consequences" class="modal-textarea" rows="3" placeholder="Conséquences">${esc((adr && adr.consequences) || '')}</textarea>
      </label>
      <label class="modal-field">Repos rattachés ${isEdit ? '<span class="muted-sm">— ajout uniquement (le retrait nécessite une évolution du registre)</span>' : '<span class="muted-sm">— cochez 1..N repos, ou « tous » ci-dessous</span>'}
        <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">${repoChecks}</div>
      </label>
      <label class="modal-field" style="flex-direction:row;align-items:center;gap:6px">
        <input type="checkbox" id="adr-global" ${globalChecked ? 'checked' : ''}>
        <span>Tous les repos du projet (ADR <strong>globale</strong>)</span>
      </label>
      ${isEdit ? `
      <label class="modal-field">Document (chemin)
        <input id="adr-path" value="${esc((adr && adr.path) || '')}" placeholder="/home/coder/…/adr.md">
      </label>` : `
      <div class="pd-inline" style="margin:10px 0">
        <select id="adr-doc-mode"><option value="upload">Importer depuis mon PC</option><option value="path">Référencer un chemin</option></select>
      </div>
      <input id="adr-file" type="file" accept=".md,.markdown,.txt,.feature,.adoc">
      <input id="adr-path" placeholder="chemin existant (ex. /home/coder/…/adr.md)" hidden>`}
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="adr-save">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
      <div id="adr-msg" class="msg"></div>
    </div>`);
  const msg = (t, ok = true) => { const m = document.getElementById('adr-msg'); if (m) { m.textContent = t; m.className = 'msg ' + (ok ? 'ok' : 'error'); } };
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeEl = document.getElementById('adr-doc-mode');
  if (modeEl) {
    const fileEl = document.getElementById('adr-file');
    const pathEl = document.getElementById('adr-path');
    const sync = () => { const up = modeEl.value === 'upload'; fileEl.hidden = !up; pathEl.hidden = up; };
    modeEl.addEventListener('change', sync); sync();
  }
  document.getElementById('adr-save').onclick = async () => {
    const btn = document.getElementById('adr-save');
    const original = btn.innerHTML;
    setBtnBusy(btn, isEdit ? 'Enregistrement' : 'Création');
    try {
      const body = {
        kind: 'adr-tech',
        title: document.getElementById('adr-title').value.trim() || undefined,
        status: document.getElementById('adr-status').value || undefined,
        context: document.getElementById('adr-context').value,
        decision: document.getElementById('adr-decision').value,
        consequences: document.getElementById('adr-consequences').value,
      };
      const isGlobal = document.getElementById('adr-global').checked;
      const checkedRepos = [...document.querySelectorAll('.pd-adr-repo:checked')].map((c) => c.value);
      if (isEdit) {
        const path = document.getElementById('adr-path').value.trim();
        if (path) body.path = path;
        body.setGlobal = isGlobal;
        const toAdd = checkedRepos.filter((r) => !currentRepos.includes(r));
        if (toAdd.length) body.addRepoIds = toAdd;
        await api(`/api/docs/${encodeURIComponent(adr.docId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        body.projectId = p.id;
        if (isGlobal) body.global = true;
        else if (checkedRepos.length) body.repoIds = checkedRepos;
        if (modeEl && modeEl.value === 'upload') {
          const f = document.getElementById('adr-file').files[0];
          if (!f) throw new Error('Choisissez un fichier.');
          if (f.size > 2 * 1024 * 1024) throw new Error('Fichier trop volumineux (max 2 Mo).');
          const buf = await f.arrayBuffer();
          body.filename = f.name; body.dataBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        } else {
          const path = document.getElementById('adr-path').value.trim();
          if (!path) throw new Error('Chemin requis.');
          body.path = path;
        }
        await api('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg(e.message || String(e), false);
    }
  };
}

// ===========================================================================
// Modale AJOUT d'une pièce jointe à une ADR (item 122). 3 modes :
//  - import : fichier du PC (base64, max 2 Mo) → storage/ref-docs (source import)
//  - ref    : chemin référencé (workspace/checkout)         (source ref)
//  - registry : document du registre existant (targetDocId) (source registry)
// POST /api/docs/<docId>/attachments puis onSaved().
// ===========================================================================
function adrAttachmentModal(docId, docs, onSaved) {
  const options = (docs || [])
    .filter((d) => d && d.docId && d.docId !== docId)
    .map((d) => `<option value="${esc(d.docId)}">${esc(d.title || d.docId)} — ${esc(docKindLabel(d.kind))}</option>`)
    .join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>Joindre une pièce</h2>
      <p class="muted-sm">ADR <code>${esc(docId)}</code> — document du registre, fichier importé ou chemin référencé.</p>
      <div class="pd-inline" style="margin:10px 0">
        <select id="adr-att-mode">
          <option value="upload">Importer un fichier depuis mon PC</option>
          <option value="ref">Référencer un chemin</option>
          <option value="registry">Document du registre</option>
        </select>
      </div>
      <div id="adr-att-upload">
        <input id="adr-att-file" type="file">
        <label class="modal-field">Titre (optionnel)<input id="adr-att-title" placeholder="libellé de la pièce jointe"></label>
      </div>
      <div id="adr-att-ref" hidden>
        <input id="adr-att-path" placeholder="chemin (ex. /home/coder/…/annexe.md)">
        <label class="modal-field">Titre (optionnel)<input id="adr-att-title2" placeholder="libellé de la pièce jointe"></label>
      </div>
      <div id="adr-att-registry" hidden>
        <label class="modal-field">Document du registre
          <select id="adr-att-target">${options || '<option value="">Aucun autre document disponible</option>'}</select>
        </label>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="adr-att-save">Joindre</button>
      </div>
      <div id="adr-att-msg" class="msg"></div>
    </div>`);
  const msg = (t, ok = true) => { const m = document.getElementById('adr-att-msg'); if (m) { m.textContent = t; m.className = 'msg ' + (ok ? 'ok' : 'error'); } };
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeEl = document.getElementById('adr-att-mode');
  const sync = () => {
    document.getElementById('adr-att-upload').hidden = modeEl.value !== 'upload';
    document.getElementById('adr-att-ref').hidden = modeEl.value !== 'ref';
    document.getElementById('adr-att-registry').hidden = modeEl.value !== 'registry';
  };
  modeEl.addEventListener('change', sync); sync();
  document.getElementById('adr-att-save').onclick = async () => {
    const btn = document.getElementById('adr-att-save');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Ajout');
    try {
      let body;
      if (modeEl.value === 'upload') {
        const f = document.getElementById('adr-att-file').files[0];
        if (!f) throw new Error('Choisissez un fichier.');
        if (f.size > 2 * 1024 * 1024) throw new Error('Fichier trop volumineux (max 2 Mo).');
        const buf = await f.arrayBuffer();
        body = { filename: f.name, dataBase64: arrayBufferToBase64(buf), title: document.getElementById('adr-att-title').value.trim() || undefined };
      } else if (modeEl.value === 'ref') {
        const path = document.getElementById('adr-att-path').value.trim();
        if (!path) throw new Error('Chemin requis.');
        body = { path, title: document.getElementById('adr-att-title2').value.trim() || undefined };
      } else {
        const targetDocId = document.getElementById('adr-att-target').value;
        if (!targetDocId) throw new Error('Choisissez un document du registre.');
        body = { targetDocId };
      }
      await api(`/api/docs/${encodeURIComponent(docId)}/attachments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      msg(e.message || String(e), false);
    }
  };
}

// ===========================================================================
// Provisionnement d'un workspace Coder pour un repo (ADR 09). Modal qui demande
// le nom du workspace + (si l'organisation n'en a pas) les tokens Coder et git,
// puis appelle POST /api/repos/:id/provision → workspace-create.mjs (clone du
// remote + masquage du token) et enregistre workspace/repoDir sur le repo.
// ===========================================================================
function orgHasCoderToken(orgId) {
  return !!(ORGANIZATIONS.find((o) => o.id === (orgId || currentOrg)) || {}).hasCoderToken;
}
function orgHasGitToken(orgId) {
  const o = ORGANIZATIONS.find((x) => x.id === (orgId || currentOrg)) || {};
  return !!(o.hasGitToken) || (Array.isArray(o.gitTokens) && o.gitTokens.length > 0);
}

function provisionRepoModal(repo, opts = {}) {
  const org = opts.org || currentOrg;
  const orgInfo = ORGANIZATIONS.find((o) => o.id === org) || {};
  const needCoder = !orgHasCoderToken(org);
  const hasGitTokens = (orgInfo.gitTokens || []).length > 0;
  const needGit = !orgHasGitToken(org) && !hasGitTokens && !opts.gitTokenId;
  const hasGit = !!(repo.gitUrl || repo.repoDir);
  const wsDefault = String(repo.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const missing = [needCoder ? 'token Coder' : null, needGit ? 'token git' : null].filter(Boolean);
  // Sélection du token git à utiliser pour le clone.
  const orgTokens = (orgInfo.gitTokens || []);
  const selectedGitTokenId = opts.gitTokenId || '';
  const showGitSelect = orgTokens.length > 0;
  showModal(`
    <div class="modal modal-wide">
      <h2>Provisionner un workspace Coder</h2>
      <p class="muted">Repo <code class="chip-repo">${esc(repo.id)}</code>${repo.workspace ? ` · ws actuel <code>${esc(repo.workspace)}</code>` : ''}</p>
      ${!hasGit ? '<p class="msg error">Aucun remote git connu pour ce repo — renseignez l\'URL du dépôt (champ ci-dessous).</p>' : ''}
      <form id="prov-form" class="pilot-form">
        <label class="modal-field">Nom du workspace Coder <span class="muted-sm">— créé via le template ${esc(orgInfo.coderTemplate || 'de l\'organisation')}</span>
          <input id="prov-ws" value="${esc(wsDefault)}" placeholder="ex: ia-crm" required>
        </label>
        <label class="modal-field">Remote git (clone dans le workspace)
          <input id="prov-giturl" value="${esc(repo.gitUrl || '')}" placeholder="https://github.com/org/repo.git" ${hasGit ? '' : 'required'}>
        </label>
        <div class="pd-inline">
          <input id="prov-owner" placeholder="owner Coder (défaut : courant)">
          <input id="prov-template" placeholder="template Coder" value="${esc(orgInfo.coderTemplate || '')}">
        </div>
        ${showGitSelect ? `<label class="modal-field">Token git à utiliser pour le clone
          <select id="prov-git-token-id">
            <option value="">— token par défaut de l'organisation —</option>
            ${orgTokens.map((t) => `<option value="${esc(t.id)}" ${t.id === selectedGitTokenId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </label>` : ''}
        ${missing.length
          ? `<p class="muted-sm">L'organisation <code>${esc(org)}</code> n'a pas ${missing.join(' et ')} enregistré${missing.length > 1 ? 's' : ''} — ils seront mémorisés chiffrés <strong>sur l'organisation</strong> pour les prochains provisionnements.</p>`
          : '<p class="muted-sm">L\'organisation a déjà ses tokens (Coder + git) — rien à saisir.</p>'}
        ${needCoder ? `<label class="modal-field">Token Coder <span class="muted-sm">(${esc((orgInfo.coderUrl || 'ide.madatalk.fr'))})</span>
          <input id="prov-coder-token" type="password" placeholder="token Coder" required>
        </label>` : ''}
        ${needGit ? `<label class="modal-field">Token git (PAT) <span class="muted-sm">— accès au clone</span>
          <input id="prov-git-token" type="password" placeholder="personal access token" required>
        </label>` : ''}
        <div class="actions-buttons">
          <button type="submit" class="launch-btn">Créer le workspace</button>
          <button type="button" class="ghost" id="prov-cancel">Annuler</button>
        </div>
      </form>
      <div id="prov-msg" class="msg"></div>
    </div>`);
  document.getElementById('prov-cancel').onclick = closeModal;
  document.getElementById('prov-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    const msgEl = document.getElementById('prov-msg');
    msgEl.textContent = 'Création du workspace Coder… (clone du remote + masquage du token)';
    msgEl.className = 'msg ok';
    try {
      const gitTokenIdEl = document.getElementById('prov-git-token-id');
      const gitTokenId = gitTokenIdEl ? gitTokenIdEl.value.trim() || undefined : undefined;
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceName: document.getElementById('prov-ws').value.trim(),
          gitUrl: document.getElementById('prov-giturl').value.trim() || undefined,
          repoDir: repo.repoDir || undefined,
          owner: document.getElementById('prov-owner').value.trim() || undefined,
          template: document.getElementById('prov-template').value.trim() || undefined,
          gitTokenId: gitTokenId || opts.gitTokenId || undefined,
          coderToken: needCoder ? document.getElementById('prov-coder-token').value : undefined,
          gitToken: needGit ? document.getElementById('prov-git-token').value : undefined,
        }),
      });
      closeModal();
      if (opts.onProvisioned) await opts.onProvisioned(r);
    } catch (err) {
      msgEl.textContent = (err.message || String(err));
      msgEl.className = 'msg error';
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
    }
  });
}

// Modale de création / édition d'un projet : identifiant + nom lisible
// (l'organisation courante est appliquée). Les repos s'associent ensuite
// depuis la modale « Détail » du projet.
async function projectFormModal(project) {
  const editing = !!project;
  showModal(`
    <div class="modal">
      <h2>${editing ? 'Modifier le projet' : 'Nouveau projet'}</h2>
      <p class="muted-sm">Un <strong>projet</strong> porte un nom et référence un ou plusieurs <strong>repos</strong> (workspace Coder + répertoire du dépôt + branches + e2e). Créez le projet puis associez-lui ses repos depuis « Détail ».</p>
      <form id="project-modal-form" class="pilot-form">
        <label class="modal-field">Identifiant <span class="muted-sm">— ex: madatalk, oniria</span>
          <input id="pm-id" placeholder="identifiant" value="${esc(project?.id || '')}" ${editing ? 'readonly' : ''} required>
        </label>
        <label class="modal-field">Nom lisible
          <input id="pm-name" placeholder="nom lisible" value="${esc(project?.name || '')}" required>
        </label>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">${editing ? 'Enregistrer' : 'Créer le projet'}</button>
        </div>
      </form>
      <div id="project-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('project-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, editing ? 'Enregistrement' : 'Création');
    const msg = document.getElementById('project-modal-msg');
    try {
      const body = {
        id: document.getElementById('pm-id').value.trim(),
        name: document.getElementById('pm-name').value.trim(),
        organizationId: currentOrg || undefined,
      };
      await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message || String(err); msg.className = 'msg error';
    }
  });
}

async function taskCreateModal() {
  const projs = await api('/api/projects');
  const projects = projs.projects || [];
  const reposRes = await api('/api/repos').catch(() => ({ repos: [] }));
  const reposById = new Map((reposRes.repos || []).map((r) => [r.id, r]));
  // Sélection de repos par projet (mémorisée).
  const projRepoIds = {};
  const selectedRepoIds = () => [...document.querySelectorAll('#modal-backdrop .tr-repo:checked')].map((c) => c.value);
  const reposOf = (pid) => {
    const p = projects.find((x) => x.id === pid);
    return (p && p.repos || []).map((rid) => reposById.get(rid)).filter(Boolean);
  };
  showModal(`
    <div class="modal">
      <h2>Nouvelle tâche</h2>
      <form id="task-modal-form" class="pilot-form">
        <select id="tm-project" required>
          <option value="">— projet —</option>
          ${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('')}
        </select>
        <fieldset id="tm-repos-fieldset" class="pilot-fieldset" hidden>
          <legend>Repos concernés <span class="muted-sm">— par défaut : tous les repos du projet (ADR 09)</span></legend>
          <div id="tm-repos-list"></div>
        </fieldset>
        <select id="tm-type" required>
          <option value="feature">feature</option>
          <option value="debug">debug</option>
          <option value="audit">audit</option>
        </select>
        <select id="tm-audit-target" hidden>
          <option value="backend">Audit backend (hexagonal/DDD)</option>
          <option value="frontend">Audit frontend (React)</option>
          <option value="both">Les deux (backend + frontend)</option>
        </select>
        <select id="tm-mode" hidden>
          <option value="plan">Avec planification (atomic-plan)</option>
          <option value="direct">Exécution directe (build-notify)</option>
        </select>
        <textarea id="tm-request" placeholder="description de la tâche" required></textarea>
        <input id="tm-title" placeholder="titre court (ex: Ajouter le filtrage des tâches)" required>
        <textarea id="tm-acceptance" rows="2" placeholder="critère d'acceptation / livrable attendu" required></textarea>
        <input id="tm-scope" placeholder="scope (chemins, séparés par des virgules)">
        <div class="links-editor">
          <div class="links-head"><label class="modal-field" style="margin:0">Tâches liées <span class="muted-sm">(associées, exploitables par le planner)</span></label>
          <button type="button" class="ghost" id="tm-add-link">+ Ajouter</button></div>
          <div id="tm-links-list"></div>
          <p class="muted-sm">Ex. tâche liée : <code>T-20260831-105029</code> — nature : « c'est là que le package a été créé ».</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer</button>
        </div>
      </form>
      <div id="task-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const typeSel = document.getElementById('tm-type');
  const targetSel = document.getElementById('tm-audit-target');
  const modeSel = document.getElementById('tm-mode');
  const syncTarget = () => {
    const isAudit = typeSel.value === 'audit';
    targetSel.hidden = !isAudit;
    modeSel.hidden = isAudit;   // mode planification/direct pour feature & debug
  };
  typeSel.addEventListener('change', syncTarget);
  syncTarget();

  // Éditeur de tâches liées (combo tâches + nature de la liaison).
  const linksList = document.getElementById('tm-links-list');
  let allTasks = [];
  try { allTasks = (await api('/api/tasks')).tasks || []; } catch {}
  const taskOptions = `<option value="">— tâche associée (titre) —</option>` + allTasks
    .map((t) => `<option value="${esc(t.id)}">${esc((t.title || t.request || '').slice(0, 70))} — ${esc(t.id)}</option>`).join('');
  const addLinkRow = (taskId = '', description = '') => {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <select class="link-task" style="flex:1; min-width:160px;">${taskOptions.replace(`value="${esc(taskId)}"`, `value="${esc(taskId)}" selected`)}</select>
      <input class="link-desc" style="flex:2; min-width:160px;" placeholder="nature de la liaison (ex: c'est là que le package a été créé)" value="${esc(description)}">
      <button type="button" class="ghost link-del" title="Retirer">✕</button>`;
    row.querySelector('.link-del').addEventListener('click', () => row.remove());
    linksList.appendChild(row);
  };
  document.getElementById('tm-add-link').addEventListener('click', () => addLinkRow());
  addLinkRow(); // une ligne par défaut

  // Binding projet → repos (défaut : tous cochés ; mémorise les choix par projet).
  const repoList = document.getElementById('tm-repos-list');
  const fieldset = document.getElementById('tm-repos-fieldset');
  const projSel = document.getElementById('tm-project');
  const renderRepoChecks = (pid) => {
    const reps = reposOf(pid);
    if (!reps.length) { fieldset.hidden = true; repoList.innerHTML = ''; return; }
    fieldset.hidden = false;
    const saved = projRepoIds[pid];
    repoList.innerHTML = reps.map((r) => `
      <label class="filter-check"><input type="checkbox" class="tr-repo" value="${esc(r.id)}"
        ${!saved || saved.includes(r.id) ? 'checked' : ''}>
        <code>${esc(r.id)}</code>${r.workspace ? ` <span class="muted-sm">· ${esc(r.workspace)}</span>` : ''}${r.mainBranch ? ` <span class="muted-sm">· ${esc(r.mainBranch)}</span>` : ''}
      </label>`).join('');
  };
  projSel.addEventListener('change', () => {
    const pid = projSel.value;
    if (pid) projRepoIds[pid] = selectedRepoIds();
    renderRepoChecks(pid);
  });

  document.getElementById('task-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('task-modal-msg');
    const scopeRaw = document.getElementById('tm-scope').value.trim();
    const type = typeSel.value;
    const linkedTasks = [...linksList.querySelectorAll('.link-row')]
      .map((r) => ({ taskId: r.querySelector('.link-task').value.trim(), description: r.querySelector('.link-desc').value.trim() }))
      .filter((l) => l.taskId);
    const pid = projSel.value;
    projRepoIds[pid] = selectedRepoIds();
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Création');
    try {
      await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: pid,
        type,
        auditTarget: type === 'audit' ? targetSel.value : undefined,
        directExecution: type !== 'audit' && modeSel.value === 'direct',
        request: document.getElementById('tm-request').value.trim(),
        title: document.getElementById('tm-title').value.trim(),
        acceptanceCriteria: [document.getElementById('tm-acceptance').value.trim()],
        scope: scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        linkedTasks,
        repoIds: projRepoIds[pid] && projRepoIds[pid].length ? projRepoIds[pid] : undefined,
        organizationId: currentOrg || undefined,
      }) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

async function taskActionsModal(taskId) {
  let detail;
  try { detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`); }
  catch (e) { alert(e.message); return; }
  const task = detail.task || {};
  const execs = detail.executions || [];
  const status = execs[0]?.status || task.status || 'queued';
  const cadrage = task.cadrage_status || 'pending';
  const decisions = detail.decisions || [];
  // Décisions humaines ACTIONNABLES = awaiting sans permission_id (canal B :
  // besoin/prérequis/validation demandés par un agent) — les permissions d'outil
  // (permission_id présent) restent résolues dans la session de l'agent.
  // Une tâche `done` n'a PLUS d'attente humaine : on ne propose aucune action.
  const awaiting = status === 'done' ? [] : decisions.filter((d) => d.status === 'awaiting' && d.kind !== 'cadrage' && !d.permission_id);
  const linked = detail.linkedTasks || [];

  showModal(`
    <div class="modal modal-wide">
      <h2>Actions — <span class="code">${esc(taskId)}</span></h2>
      <p class="muted-sm"><strong>Titre :</strong> ${esc((task.title && task.title.trim()) ? task.title : '—')}</p>
      <div class="modal-request">${esc(task.request || '—')}</div>
      ${(() => { let c = ''; try { const a = typeof task.acceptance_criteria === 'string' ? JSON.parse(task.acceptance_criteria) : (task.acceptance_criteria || []); c = Array.isArray(a) ? a.join(' · ') : String(a || ''); } catch { c = String(task.acceptance_criteria || ''); } return c ? `<p class="muted-sm"><strong>Critère d'acceptation :</strong> ${esc(c)}</p>` : ''; })()}
      <p class="muted-sm">Projet <span class="code">${esc(task.project)}</span> · Type <span class="code">${esc(task.type)}</span> · ${badge(status)} · Cadrage ${cadrageBadge(cadrage)}</p>
      ${(task.repos && task.repos.length) ? `<p class="muted-sm"><strong>Repos ciblés (${task.repos.length}) :</strong> ${task.repos.map((r) => `<code class="chip">${esc(r.id)}${r.mainBranch ? ' · ' + esc(r.mainBranch) : ''}</code>`).join(' ')}</p>` : ''}

      ${linked.length ? `
      <div class="actions-section">
        <h3>Tâches liées (${linked.length})</h3>
        ${linked.map((l) => `
          <div class="link-item">
            <code>${esc(l.linked_task_id || l.linkedTaskId)}</code>
            ${(l.relationType || l.relation_type) === 'emergent' ? '<span class="badge danger" title="Tâche émergente — créée hors scope, liée à sa source">émergente</span>' : ''}
            <span class="muted-sm">${esc((l.description || '').slice(0, 90) || '—')}</span>
            <span class="muted-sm">${esc((l.linked_request || '').slice(0, 50))}${l.linked_status ? ` · ${esc(l.linked_status)}` : ''}</span>
          </div>`).join('')}
      </div>` : ''}

      ${(detail.emergentFrom && detail.emergentFrom.length) ? `
      <div class="actions-section">
        <h3>Tâches émergentes créées depuis cette tâche (${detail.emergentFrom.length})</h3>
        <p class="muted-sm">Demandes utilisateur hors scope reçues pendant cette tâche → créées comme nouvelles tâches liées (source).</p>
        ${detail.emergentFrom.map((e) => `
          <div class="link-item">
            <code>${esc(e.task_id)}</code>
            <span class="badge danger">émergente</span>
            <span class="muted-sm">${esc((e.title || '').slice(0, 60))} ${e.status ? `· ${esc(e.status)}` : ''}</span>
            ${e.reason ? `<span class="muted-sm" title="${esc(e.reason)}">${esc((e.reason || '').slice(0, 70))}</span>` : ''}
            <button type="button" class="ghost" data-goto-task="${esc(e.task_id)}">Ouvrir</button>
          </div>`).join('')}
      </div>` : ''}

      ${awaiting.length ? `
      <div class="actions-section">
        <h3>Validation (décisions en attente)</h3>
        ${awaiting.map((d) => `
          <div class="decision-row">
            <code class="muted-sm">${esc(d.decision_id)}</code>
            <span class="muted-sm">${esc(d.kind)} — ${esc((d.detail || '').slice(0, 140))}${(d.detail || '').length > 140 ? '…' : ''}</span>
            <button type="button" class="ghost" data-review-dec="${esc(d.decision_id)}" title="Examiner la décision en grand (plein écran, markdown)">Examiner</button>
            <button class="approve" data-approve="${esc(d.decision_id)}">Approuver</button>
            <button class="danger" data-reject="${esc(d.decision_id)}">Rejeter</button>
          </div>`).join('')}
      </div>` : ''}

      ${status === 'done' ? cadrageSectionHtml(cadrage, detail) : ''}

      <div class="actions-section">
        <h3>Tests E2E</h3>
        <p class="muted-sm" id="e2e-actions-hint">Chargement…</p>
      </div>

      <div class="actions-section">
        <h3>Opérations</h3>
        <div class="actions-buttons">
          ${status === 'queued' ? `<button class="launch-btn" id="act-launch">Lancer</button>` : ''}
          ${status === 'queued' ? `<button class="ghost" id="act-edit">Modifier</button>` : ''}
          ${status === 'aborted' ? `<button class="launch-btn" id="act-relaunch">Relancer</button>` : ''}
          ${(status === 'rejected' || status === 'failed' || status === 'rework') ? `<button id="act-rework">Reprendre</button>` : ''}
          ${['started','planning','awaiting_validation','planned','in_progress','rework','blocked'].includes(status) ? `<button class="danger" id="act-kill">Tuer la session</button>` : ''}
          ${ME && ME.is_admin ? `<button class="danger" id="act-archive">Archiver</button>` : ''}
        </div>
      </div>

      <div class="actions-section">
        <h3>Consulter</h3>
        <div class="actions-buttons">
          <button class="ghost" data-goto="artifacts">Artefacts</button>
          <button class="ghost" data-goto="events">Événements</button>
          <button class="ghost" data-goto="deployments">Déploiements</button>
          <button class="ghost" data-goto="decisions">Décisions</button>
          <button class="ghost" data-goto="plans">Plans</button>
          <button class="ghost" id="act-consumption">Consommation</button>
        </div>
      </div>

      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Fermer</button>
      </div>
    </div>`);

  document.getElementById('modal-cancel').onclick = closeModal;
  const launch = document.getElementById('act-launch');
  if (launch) launch.onclick = () => { closeModal(); launchTaskModal(taskId); };
  const editBtn = document.getElementById('act-edit');
  if (editBtn) editBtn.onclick = () => { closeModal(); taskEditModal(taskId, detail); };
  const rework = document.getElementById('act-rework');
  if (rework) rework.onclick = () => { closeModal(); reworkTaskModal(taskId); };
  const cadrageSession = document.getElementById('act-recette-session');
  if (cadrageSession) cadrageSession.onclick = () => openCadrageSession(cadrageSession.dataset.recId, false, cadrageSession);
  const cadrageFinish = document.getElementById('act-recette-finish');
  if (cadrageFinish) cadrageFinish.onclick = () => { closeModal(); finishCadrageModal(cadrageFinish.dataset.recId); };
  const cadrageDetail = document.getElementById('act-recette-detail');
  if (cadrageDetail) cadrageDetail.onclick = () => { closeModal(); cadrageDetailItemsModal(cadrageDetail.dataset.recId); };
  const archive = document.getElementById('act-archive');
  if (archive) archive.onclick = () => { closeModal(); openArchiveConfirm(taskId); };
  document.querySelectorAll('#modal-backdrop [data-goto-task]').forEach((b) => b.addEventListener('click', () => { const tid = b.dataset.gotoTask; closeModal(); taskActionsModal(tid); refreshActive(); }));
  const consumption = document.getElementById('act-consumption');
  if (consumption) consumption.onclick = () => { closeModal(); renderConsumptionModal(taskId); };
  const kill = document.getElementById('act-kill');
  if (kill) kill.onclick = () => {
    if (!confirm('Arrêter la session ? (process arrêté — la session reste consultable — tâche abandonnée)')) return;
    const original = kill.innerHTML;
    setBtnBusy(kill, 'Arrêt');
    closeModal();
    api(`/api/tasks/${encodeURIComponent(taskId)}/kill-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then((r) => { alert('Session arrêtée.' + (r.aborted ? ' Tâche abandonnée.' : '')); refreshActive(); })
      .catch((e) => { kill.disabled = false; kill.classList.remove('ws-busy'); kill.innerHTML = original; alert('Échec : ' + (e.message || e)); });
  };
  const relaunch = document.getElementById('act-relaunch');
  if (relaunch) relaunch.onclick = () => {
    if (!confirm('Relancer la tâche ? (réinitialisation + nouvelle session orchestrateur)')) return;
    const original = relaunch.innerHTML;
    setBtnBusy(relaunch, 'Relance');
    closeModal();
    api(`/api/tasks/${encodeURIComponent(taskId)}/relaunch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then((r) => { alert('Tâche relancée : ' + (r.sessionId || '—')); refreshActive(); })
      .catch((e) => { relaunch.disabled = false; relaunch.classList.remove('ws-busy'); relaunch.innerHTML = original; alert('Échec : ' + (e.message || e)); });
  };
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { closeModal(); goToTab(b.dataset.goto, taskId); }));
  const decById = {}; awaiting.forEach((d) => { decById[d.decision_id] = d; });
  // enrichit la décision avec le contexte tâche (titre/projet/request) pour la vue.
  const enrich = (d) => ({ ...d, task_title: d.task_title || task.title || null, task_project: d.task_project || task.project || null, task_request: d.task_request || task.request || null });
  document.querySelectorAll('[data-review-dec]').forEach((b) => b.addEventListener('click', () => decisionReviewModal(enrich(decById[b.dataset.reviewDec]), () => { closeModal(); refreshActive(); })));
  document.querySelectorAll('[data-approve], [data-reject]').forEach((b) => {
    b.addEventListener('click', async () => {
      const decisionId = b.dataset.approve || b.dataset.reject;
      const st = b.dataset.approve ? 'approved' : 'rejected';
      const resolution = '';
      if (st === 'rejected' && !confirm('Rejeter sans remarque ? (recommandé d\'expliquer via « Examiner »)')) return;
      const original = b.innerHTML;
      setBtnBusy(b, st === 'approved' ? 'Approbation' : 'Rejet');
      try {
        await resolveDecision(decisionId, st, resolution);
        closeModal();
        refreshActive();
      } catch (err) {
        b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
        alert('Échec : ' + (err.message || err));
      }
    });
  });
  renderTaskE2ELink(taskId);
}

async function taskEditModal(taskId, detail) {
  const task = (detail && detail.task) || {};
  // scope et acceptance_criteria sont stockés en JSON (chaînes) — parser avant affichage.
  let scopeVal = '';
  try {
    const sArr = typeof task.scope === 'string' ? JSON.parse(task.scope) : (task.scope || []);
    scopeVal = Array.isArray(sArr) ? sArr.join(', ') : String(sArr || '');
  } catch { scopeVal = String(task.scope || ''); }
  let crit = '';
  try {
    const arr = typeof task.acceptance_criteria === 'string' ? JSON.parse(task.acceptance_criteria) : (task.acceptance_criteria || []);
    crit = Array.isArray(arr) ? arr.join(', ') : String(arr || '');
  } catch { crit = String(task.acceptance_criteria || ''); }
  showModal(`
    <div class="modal modal-wide">
      <h2>Modifier la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span> · statut <code>queued</code></p>
      <form id="task-edit-form" class="pilot-form">
        <label class="modal-field">Titre court <input id="te-title" value="${esc(task.title || '')}" required></label>
        <label class="modal-field">Description de la tâche <textarea id="te-request" rows="4" required>${esc(task.request || '')}</textarea></label>
        <label class="modal-field">Critère d'acceptation / livrable attendu <textarea id="te-acceptance" rows="2" required>${esc(crit)}</textarea></label>
        <label class="modal-field">Scope (chemins, séparés par des virgules) <input id="te-scope" value="${esc(scopeVal)}"></label>
        <label class="modal-field">Priorité
          <select id="te-priority">
            ${['low','normal','high','critical'].map((p) => `<option value="${p}" ${(task.priority || 'normal') === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </label>
        <label class="modal-field">Mode d'exécution
          <select id="te-mode">
            <option value="plan" ${task.directExecution ? '' : 'selected'}>Avec planification (atomic-plan)</option>
            <option value="direct" ${task.directExecution ? 'selected' : ''}>Exécution directe (build-notify)</option>
          </select>
        </label>
        <div class="links-editor">
          <div class="links-head"><label class="modal-field" style="margin:0">Tâches associées (liées)</label>
          <button type="button" class="ghost" id="te-add-link">+ Ajouter</button></div>
          <div id="te-links-list"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Enregistrer</button>
        </div>
      </form>
      <div id="task-edit-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;

  // Éditeur de tâches associées (combo par titre + nature), prérempli depuis detail.linkedTasks.
  const teLinksList = document.getElementById('te-links-list');
  let teAllTasks = [];
  try { teAllTasks = (await api('/api/tasks')).tasks || []; } catch {}
  const teOptions = `<option value="">— tâche associée (titre) —</option>` + teAllTasks
    .map((t) => `<option value="${esc(t.id)}">${esc((t.title || t.request || '').slice(0, 70))} — ${esc(t.id)}</option>`).join('');
  const teAddRow = (taskId = '', description = '') => {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <select class="te-link-task" style="flex:1; min-width:160px;">${teOptions.replace(`value="${esc(taskId)}"`, `value="${esc(taskId)}" selected`)}</select>
      <input class="te-link-desc" style="flex:2; min-width:160px;" placeholder="nature de la liaison" value="${esc(description)}">
      <button type="button" class="ghost te-link-del" title="Retirer">✕</button>`;
    row.querySelector('.te-link-del').addEventListener('click', () => row.remove());
    teLinksList.appendChild(row);
  };
  document.getElementById('te-add-link').addEventListener('click', () => teAddRow());
  const currentLinks = (detail && detail.linkedTasks) || [];
  currentLinks.forEach((l) => teAddRow(l.linked_task_id || l.linkedTaskId, l.description || ''));

  document.getElementById('task-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('task-edit-msg');
    const scopeRaw = document.getElementById('te-scope').value.trim();
    const linkedTasks = [...teLinksList.querySelectorAll('.link-row')]
      .map((r) => ({ taskId: r.querySelector('.te-link-task').value.trim(), description: r.querySelector('.te-link-desc').value.trim() }))
      .filter((l) => l.taskId);
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, 'Enregistrement');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: document.getElementById('te-title').value.trim(),
        request: document.getElementById('te-request').value.trim(),
        acceptanceCriteria: [document.getElementById('te-acceptance').value.trim()],
        scope: scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
        priority: document.getElementById('te-priority').value,
        directExecution: document.getElementById('te-mode').value === 'direct',
        linkedTasks,
      }) });
      closeModal();
      refreshActive();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = err.message; msg.className = 'msg error';
    }
  });
}

async function launchAgents(type) {
  let eco = { agents: [] };
  try { eco = await api('/api/ecosystem'); } catch {}
  const byName = {};
  (eco.agents || []).forEach((a) => { byName[a.name] = a; });
  const list = [{ name: 'orchestrator', role: 'Coordinateur (orchestration)' }, ...(AGENTS_BY_TYPE[type] || [])];
  return list.map((n) => ({ name: n.name, role: n.role, model: byName[n.name] ? byName[n.name].model : null }));
}

async function launchTaskModal(taskId) {
  let task = {}, agents = [];
  try {
    const d = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    task = d.task || {};
    agents = await launchAgents(task.type);
  } catch {}
  const rows = agents.map((a) => `
    <div class="agent-model-row">
      <code>${esc(a.name)}</code>
      <span class="muted-sm">${esc(a.role || '')}</span>
      <span class="muted-sm">→</span>
      <code class="muted-sm">${esc(a.model || '—')}</code>
    </div>`).join('') || '<p class="muted-sm">Aucun agent identifié pour ce type.</p>';
  showModal(`
    <div class="modal">
      <h2>Lancer la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span> · type <span class="code">${esc(task.type || '—')}</span></p>
      <div class="actions-section">
        <h3>Agents mobilisés et modèles (read-only)</h3>
        ${rows}
      </div>
      <p>Une session de l'agent orchestrateur sera ouverte (mission + cadre).</p>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="modal-confirm">Lancer</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Lancement');
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/launch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      closeModal();
      alert('Session lancée : ' + (r.sessionId || '—'));
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      alert('Échec du lancement : ' + (e.message || e));
    }
  };
}

async function reworkTaskModal(taskId) {
  // Bug 5/6 — préremplir la session courante et les remarques (rejet de cadrage).
  let latestSession = '';
  let defaultRemarks = '';
  try {
    const d = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    const sessions = (d.sessions && d.sessions.length) ? d.sessions : [];
    if (sessions.length) latestSession = sessions[sessions.length - 1].sessionId || '';
    const rejectedCadrage = (d.decisions || []).filter((x) => x.kind === 'cadrage' && x.status === 'rejected');
    if (rejectedCadrage.length) defaultRemarks = rejectedCadrage[rejectedCadrage.length - 1].resolution || '';
  } catch { /* valeurs par défaut vides */ }

  showModal(`
    <div class="modal">
      <h2>Reprendre la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <label class="modal-field">Remarques de reprise
        <textarea id="rework-remarks" class="modal-textarea" placeholder="remarques de reprise">${esc(defaultRemarks)}</textarea>
      </label>
      <label class="modal-field">Mode
        <select id="rework-mode">
          <option value="fresh">Nouvelle session vierge (choix 3)</option>
          <option value="continue" ${latestSession ? '' : 'disabled'}>Continuer la session courante (choix 1)${latestSession ? '' : ' — aucune session active'}</option>
        </select>
      </label>
      <div id="rework-session-wrap" hidden>
        <label class="modal-field">Session courante
          <input id="rework-session" placeholder="ses_…" value="${esc(latestSession)}">
        </label>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="launch-btn" id="modal-confirm">Reprendre</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const modeSel = document.getElementById('rework-mode');
  modeSel.addEventListener('change', () => {
    document.getElementById('rework-session-wrap').hidden = modeSel.value !== 'continue';
  });
  document.getElementById('modal-confirm').onclick = async () => {
    const btn = document.getElementById('modal-confirm');
    const original = btn.innerHTML;
    setBtnBusy(btn, 'Reprise');
    try {
      const mode = modeSel.value;
      const remarks = document.getElementById('rework-remarks').value.trim();
      const sessionId = document.getElementById('rework-session').value.trim();
      const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/rework`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, remarks, sessionId: mode === 'continue' ? sessionId : undefined }),
      });
      closeModal();
      alert(mode === 'continue' ? 'Remarques injectées dans la session.' : 'Nouvelle session lancée : ' + (r.sessionId || '—'));
      refreshActive();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original;
      alert('Échec de la reprise : ' + (e.message || e));
    }
  };
}

// --- Cadrage (v0.7.0) : section + clôture -----------------------------------
const CADRAGE_CLS_LABEL = { rework: 'Rework', bug: 'Bug', improvement: 'Improvement', feature: 'Feature' };
const CADRAGE_CLS_BADGE = { rework: 'danger', bug: 'danger', improvement: 'approve', feature: 'ghost' };

function testIntentBadge(it) {
  const t = it && it.testIntent;
  if (!t || !t.action) return '';
  const actionLabel = t.action === 'create' ? 'créer un test' : t.action === 'update' ? 'adapter un test' : 'obsoléter un test';
  const typeLabel = t.testType === 'e2e' ? 'E2E' : 'unitaire';
  const target = t.target ? ` · ${t.target}` : '';
  return `<span class="badge" style="background:rgba(255,180,60,.16);color:#ffb43c;border:1px solid rgba(255,180,60,.35)" title="Intention test : ${esc(t.action)} (${typeLabel})${t.scenario ? ' — ' + esc(t.scenario) : ''}${t.reason ? ' — ' + esc(t.reason) : ''}">${esc(typeLabel)} : ${esc(actionLabel)}${esc(target)}</span>`;
}

function docIntentBadge(it) {
  const d = it && it.docIntent;
  if (!d || !d.action) return '';
  const actionLabel = d.action === 'create' ? 'documenter' : d.action === 'update' ? 'mettre à jour' : 'obsoléter';
  const typeLabel = d.docType === 'adr-tech' ? 'ADR' : d.docType === 'specs-fonctionnelles' ? 'SPECS' : d.docType === 'scenarios-gherkin' ? 'GHERKIN' : 'DOC';
  const target = d.target ? ` · ${d.target}` : '';
  return `<span class="badge" style="background:rgba(140,190,255,.16);color:#8cbeff;border:1px solid rgba(140,190,255,.35)" title="Intention doc : ${esc(d.action)} (${typeLabel})${d.summary ? ' — ' + esc(d.summary) : ''}${d.reason ? ' — ' + esc(d.reason) : ''}">📄 ${esc(typeLabel)} : ${esc(actionLabel)}${esc(target)}</span>`;
}

function cadrageItemRow(it) {
  return `<div class="recette-item">
    <code class="muted-sm">#${it.id || it.itemId}</code>
    <span class="badge ${CADRAGE_CLS_BADGE[it.classification] || 'queued'}">${CADRAGE_CLS_LABEL[it.classification] || it.classification}</span>
    ${it.project ? `<code class="chip-project">${esc(it.project)}</code>` : ''}
    ${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution (même numéro = parallèle)">ordre ${esc(it.execOrder)}</span>` : ''}
    ${testIntentBadge(it)}
    ${docIntentBadge(it)}
    ${it.vigilance ? `<span class="badge danger" title="Point de vigilance / écart sémantique : ${esc(it.vigilance)}">⚠ vigilance</span>` : ''}
    <span>${esc(it.content)}</span>
    ${it.status === 'task_created' && it.created_task_id ? `<code class="muted-sm">→ ${esc(it.created_task_id)}</code>` : ''}
  </div>`;
}

function cadrageSectionHtml(cadrageStatus, detail) {
  const T = cadrageTerms();
  const rec = detail && detail.cadrage;
  if (!rec) {
    return `<div class="actions-section"><h3>${T.entity}</h3>
      <p class="muted-sm">Cette tâche n'est couverte par aucun cadrage. Créez un cadrage (onglet <a href="#" onclick="goToTab('cadrages'); return false;">Cadrage technique</a>) pour couvrir plusieurs tâches d'un même périmètre (1 ${T.entityLower} = 1 projet).</p>
    </div>`;
  }
  const st = rec.status;
  const title = rec.title || rec.cadrageId;
  const items = rec.items || [];
  const btns = (st === 'in_progress' || st === 'pending') ? `
    <div class="actions-buttons">
      <button class="launch-btn" id="act-recette-session" data-rec-id="${esc(rec.cadrageId)}" title="${rec.sessionId ? T.sessionResume : T.sessionHint}">${T.session}</button>
      ${st === 'in_progress' ? `<button class="approve" id="act-recette-finish" data-rec-id="${esc(rec.cadrageId)}">${T.finish}</button>` : ''}
    </div>` : (st === 'done' ? `
    <div class="actions-buttons">
      <button class="ghost" id="act-recette-detail" data-rec-id="${esc(rec.cadrageId)}">${T.detail}</button>
    </div>` : '');
  const statusTxt = st === 'done' ? `faite${rec.confirmed_at ? ` le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}` : CADRAGE_STATUS_LABEL[st] || st;
  return `<div class="actions-section"><h3>${T.entity} — ${statusTxt}</h3>
    <p class="muted-sm"><strong>${esc(title)}</strong> ${cadrageScopeChips(rec)}</p>
    ${items.length ? `<div class="recette-list">${items.map(cadrageItemRow).join('')}</div>` : '<p class="muted-sm">Aucun élément relevé.</p>'}
    ${btns}
  </div>`;
}


// --- Navigation ------------------------------------------------------------
// --- Observabilité / KPI (v0.2.0) --------------------------------------------
const obsCharts = {}; // instances Chart.js à détruire avant re-rendu

function fmtMin(m) {
  if (m == null || isNaN(m)) return '—';
  if (m < 60) return Math.round(m) + ' min';
  return (m / 60).toFixed(1).replace('.', ',') + ' h';
}

function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
}

function fmtTokens(v) {
  if (v == null || isNaN(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' K';
  return String(v);
}

function destroyObsCharts() {
  for (const k of Object.keys(obsCharts)) {
    try { obsCharts[k].destroy(); } catch {}
    delete obsCharts[k];
  }
}

function obsCanvas(id) {
  return `<div class="chart-box"><canvas id="${id}" height="220"></canvas></div>`;
}

// Funnel qualité : barres horizontales proportionnelles à la 1re étape.
function obsFunnel(f) {
  if (!f) return '<p class="muted">Aucune donnée</p>';
  const max = Math.max(1, f.completed || 0);
  const stages = [
    ['Completed', f.completed], ['Audited', f.audited], ['Accepted', f.accepted], ['Sans rework', f.noRework],
  ];
  return `<div class="funnel">${stages.map(([label, val]) => `
    <div class="funnel-row"><span class="funnel-label">${esc(label)}</span>
      <div class="funnel-bar"><div class="funnel-fill" style="width:${Math.round((val / max) * 100)}%"></div></div>
      <span class="funnel-val">${val}</span>
    </div>`).join('')}</div>`;
}

function kpiCard(label, value, sub, cls) {
  return `<div class="kpi-card${cls ? ' ' + cls : ''}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(String(value))}</div>${sub ? `<div class="kpi-sub">${esc(String(sub))}</div>` : ''}</div>`;
}

async function renderObservability() {
  const pane = document.getElementById('pane-observability');
  pane.innerHTML = `<h2>Observabilité — KPI du système</h2><p class="muted">Flow · Orchestration · Agents · Quality (Phase 1 — v0.2.0)</p><p class="muted">Chargement…</p>`;
  try {
    const [summary, statusData, throughputData, leadtimeData, agentsData, costsData, phasesData, blockedData, successfailureData, hardeningData, qualityData, reworkData, cvtData, cadrageData] = await Promise.all([
      api('/api/metrics/summary'),
      api('/api/metrics/status'),
      api('/api/metrics/throughput?days=14'),
      api('/api/metrics/leadtime?days=14'),
      api('/api/metrics/agents'),
      api('/api/metrics/costs'),
      api('/api/metrics/phases'),
      api('/api/metrics/blocked?days=30'),
      api('/api/metrics/successfailure?days=14'),
      api('/api/metrics/hardening'),
      api('/api/metrics/quality'),
      api('/api/metrics/rework?days=30'),
      api('/api/metrics/costvsthroughput?days=30'),
      api('/api/metrics/cadrage'),
    ]);

    destroyObsCharts();
    pane.innerHTML = `
      <h2>Observabilité — KPI du système</h2>

      <div class="kpi-grid">
        ${kpiCard('Tâches', summary.total, 'au total')}
        ${kpiCard('Terminées', summary.completed, 'statut done')}
        ${kpiCard('En cours', summary.inProgress, summary.blocked ? `dont ${summary.blocked} bloquée(s)` : 'aucune bloquée')}
        ${kpiCard('Lead Time moyen', fmtMin(summary.leadTimeAvg), 'demande → terminé')}
        ${kpiCard('Lead Time P95', fmtMin(summary.leadTimeP95), 'expérience des tâches lentes')}
        ${kpiCard('Cycle Time moyen', fmtMin(summary.cycleTimeAvg), 'exécution → terminé')}
        ${kpiCard('Success Rate', (summary.successRate ?? 0) + ' %', `${summary.successCount}/${summary.completed} done + cadrage approuvée`)}
        ${kpiCard('Throughput', summary.throughput, 'tâches / jour (7 j)')}
        ${kpiCard('Rework Rate', (summary.reworkRate ?? 0) + ' %', 'reprises / rejets')}
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Évolution du Lead Time (P50 / moyen / P95, min)</h3>
          ${obsCanvas('obs-leadtime')}
        </div>
        <div class="obs-panel">
          <h3>Répartition du Lead Time</h3>
          ${obsCanvas('obs-hist')}
        </div>
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Statut des tâches</h3>
          ${obsCanvas('obs-status')}
        </div>
        <div class="obs-panel">
          <h3>Throughput (tâches done / jour)</h3>
          ${obsCanvas('obs-throughput')}
        </div>
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Où passe le temps ? (moyenne par phase, toutes tâches)</h3>
          ${obsCanvas('obs-phases')}
          <p class="muted">Phase 2 — l'attente (validation/review) et la planification dominent souvent le Lead Time.</p>
        </div>
        <div class="obs-panel">
          <h3>Blocages par raison (30 j)</h3>
          ${obsCanvas('obs-blocked')}
        </div>
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Success / Failure par jour</h3>
          ${obsCanvas('obs-sf')}
        </div>
        <div class="obs-panel">
          <h3>Durcissement — traçabilité</h3>
          <div class="kpi-grid">
            ${kpiCard('Décisions expirées', hardeningData.expiredDecisions, 'sans réponse')}
            ${kpiCard('Conflits de scope', hardeningData.scopeConflicts?.total || 0, `${hardeningData.scopeConflicts?.open || 0} ouverts`)}
            ${kpiCard('Erreurs de transition', hardeningData.transitionErrors || 0, 'machine à états refusée')}
          </div>
          <p class="muted">Phase 4 — conflits de scope persistés (scope_conflicts) et erreurs de transition tracées (TRANSITION_ERROR) par le MCP task-orchestrator.</p>
        </div>
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Funnel qualité</h3>
          ${obsFunnel(qualityData.funnel)}
          <p class="muted">« Audité » = tâche avec un événement AUDIT_COMPLETED (audits explicites). Taux : audit ${qualityData.auditRate ?? 0} % · acceptation ${qualityData.acceptanceRate ?? 0} % · sans rework ${qualityData.cleanRate ?? 0} %.</p>
        </div>
        <div class="obs-panel">
          <h3>Durcissement — traçabilité</h3>
          <div class="kpi-grid">
            ${kpiCard('Décisions expirées', hardeningData.expiredDecisions, 'sans réponse')}
            ${kpiCard('Conflits de scope', hardeningData.scopeConflicts?.total || 0, `${hardeningData.scopeConflicts?.open || 0} ouverts`)}
            ${kpiCard('Erreurs de transition', hardeningData.transitionErrors || 0, 'machine à états refusée')}
          </div>
          <p class="muted">Phase 4 — conflits de scope persistés (scope_conflicts) et erreurs de transition tracées (TRANSITION_ERROR) par le MCP task-orchestrator.</p>
        </div>
      </div>

      <div class="obs-row">
        <div class="obs-panel">
          <h3>Rework dans le temps (30 j)</h3>
          ${obsCanvas('obs-rework')}
        </div>
        <div class="obs-panel">
          <h3>Coût vs Throughput (30 j)</h3>
          ${obsCanvas('obs-cvt')}
        </div>
      </div>

      <div class="obs-panel">
        <h3>Cadrage (v0.7) — éléments détectés &amp; tâches générées</h3>
        <div class="kpi-grid">
          ${kpiCard('Cadrages', (summary.cadrage?.statuses || []).reduce((a, s) => a + s.count, 0), 'opérations')}
          ${kpiCard('En cours', (summary.cadrage?.statuses || []).find((s) => s.status === 'in_progress')?.count || 0, 'cadrage active')}
          ${kpiCard('Éléments détectés', summary.cadrage?.itemsTotal || 0, 'remarques/constats')}
          ${kpiCard('Tâches générées', summary.cadrage?.tasksGenerated || 0, 'issues de cadrage')}
          ${kpiCard('Durée moyenne', fmtMin(summary.cadrage?.avgDurationMin), 'par cadrage')}
          ${kpiCard('Taux de rework', (summary.reworkRate ?? 0) + ' %', 'éléments rework / total')}
        </div>
        <div class="obs-row" style="margin:8px 0 0">
          <div class="obs-panel">
            <h4>Éléments par classification</h4>
            ${obsCanvas('obs-rec-class')}
          </div>
          <div class="obs-panel">
            <h4>Tâches générées par classification</h4>
            ${obsCanvas('obs-rec-gen')}
          </div>
        </div>
      </div>

      <div class="obs-panel">
        <h3>Performance des agents</h3>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Agent</th><th>Tâches</th><th>Succès</th><th>Durée moy.</th><th>P95</th><th>Retries</th><th>Blocages</th><th>Échecs</th></tr></thead>
          <tbody>${agentsData.map((a) => `<tr>
            <td>${esc(a.agent)}</td><td>${a.tasks}</td>
            <td>${a.successRate} %</td>
            <td>${fmtMin(a.avgDuration)}</td>
            <td>${fmtMin(a.p95Duration)}</td>
            <td>${a.retry}</td><td>${a.blocks}</td><td>${a.failed}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune donnée</td></tr>'}</tbody>
        </table>
        </div>
        <p class="muted">Attribution partielle sur l'historique (événements génériques regroupés sous « agent (non attribué) »). Durée = intervalle entre le 1er et le dernier événement de l'agent sur la tâche.</p>
      </div>

      <div class="obs-panel">
        <h3>Coûts &amp; tokens</h3>
        <div class="kpi-grid">
          ${kpiCard('Tokens consommés', fmtTokens((costsData.total?.tokens?.input || 0) + (costsData.total?.tokens?.output || 0)), 'entrée + sortie')}
          ${kpiCard('Coût total', fmtMoney(costsData.total?.cost), '')}
          ${kpiCard('Coût / tâche', fmtMoney(costsData.avgPerTask?.cost), `${costsData.perTask?.length || 0} tâche(s)`) }
          ${kpiCard('Tokens / tâche', fmtTokens(costsData.avgPerTask?.tokens), '')}
        </div>
        ${(costsData.byAgent || []).length ? `<div class="table-scroll"><table>
          <thead><tr><th>Agent</th><th>Tokens</th><th>Coût</th></tr></thead>
          <tbody>${costsData.byAgent.map((a) => `<tr><td>${esc(a.agent)}</td><td>${fmtTokens(a.input + a.output)}</td><td>${fmtMoney(a.cost)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Aucun coût mesuré (opencode export indisponible).</p>'}
      </div>
    `;

    // --- Graphiques Chart.js ---
    if (window.Chart) {
      const labels = leadtimeData.series.map((d) => d.day.slice(5));
      obsCharts.leadtime = new Chart(document.getElementById('obs-leadtime'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'P50', data: leadtimeData.series.map((d) => d.p50), borderColor: '#2f9e44', tension: 0.3 },
            { label: 'Moyenne', data: leadtimeData.series.map((d) => d.avg), borderColor: '#1971c2', tension: 0.3 },
            { label: 'P95', data: leadtimeData.series.map((d) => d.p95), borderColor: '#e8590c', tension: 0.3 },
          ],
        },
        options: { plugins: { legend: { labels: { boxWidth: 12 } } }, scales: { y: { title: { display: true, text: 'minutes' } } } },
      });
      obsCharts.hist = new Chart(document.getElementById('obs-hist'), {
        type: 'bar',
        data: { labels: leadtimeData.histogram.map((h) => h.label), datasets: [{ label: 'Tâches', data: leadtimeData.histogram.map((h) => h.count), backgroundColor: '#4dabf7' }] },
        options: { plugins: { legend: { display: false } } },
      });
      obsCharts.status = new Chart(document.getElementById('obs-status'), {
        type: 'bar',
        data: { labels: statusData.map((s) => s.status), datasets: [{ label: 'Tâches', data: statusData.map((s) => s.count), backgroundColor: '#40c057' }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false } } },
      });
      obsCharts.throughput = new Chart(document.getElementById('obs-throughput'), {
        type: 'line',
        data: { labels: throughputData.map((d) => d.day.slice(5)), datasets: [{ label: 'done / jour', data: throughputData.map((d) => d.done), borderColor: '#7048e8', backgroundColor: 'rgba(112,72,232,0.15)', fill: true, tension: 0.3 }] },
        options: { plugins: { legend: { display: false } } },
      });
      // Phase 2 : répartition du temps par phase (waterfall horizontal).
      obsCharts.phases = new Chart(document.getElementById('obs-phases'), {
        type: 'bar',
        data: { labels: phasesData.phases.map((p) => p.label), datasets: [{ label: 'minutes', data: phasesData.phases.map((p) => p.minutes), backgroundColor: '#f76707' }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'minutes' } } } },
      });
      // Phase 2 : blocages par raison.
      obsCharts.blocked = new Chart(document.getElementById('obs-blocked'), {
        type: 'bar',
        data: { labels: blockedData.map((b) => b.reason), datasets: [{ label: 'blocages', data: blockedData.map((b) => b.count), backgroundColor: '#e03131' }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false } } },
      });
      // Phase 2 : success/failure empilés par jour.
      obsCharts.sf = new Chart(document.getElementById('obs-sf'), {
        type: 'bar',
        data: {
          labels: successfailureData.map((d) => d.day.slice(5)),
          datasets: [
            { label: 'Succès', data: successfailureData.map((d) => d.success), backgroundColor: '#2f9e44' },
            { label: 'Échecs', data: successfailureData.map((d) => d.failure), backgroundColor: '#e03131' },
          ],
        },
        options: { scales: { x: { stacked: true }, y: { stacked: true } } },
      });
      // Phase 3 : rework dans le temps.
      obsCharts.rework = new Chart(document.getElementById('obs-rework'), {
        type: 'line',
        data: { labels: reworkData.map((d) => d.day.slice(5)), datasets: [
          { label: 'Reworks', data: reworkData.map((d) => d.rework), borderColor: '#e8590c', tension: 0.3 },
          { label: 'Taux (%)', data: reworkData.map((d) => d.rate), borderColor: '#5f3dc4', tension: 0.3, yAxisID: 'y1' },
        ] },
        options: {
          scales: { y: { title: { display: true, text: 'reworks' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '%' } } },
        },
      });
      // Phase 3 : coût vs throughput.
      obsCharts.cvt = new Chart(document.getElementById('obs-cvt'), {
        type: 'bar',
        data: {
          labels: cvtData.map((d) => d.day.slice(5)),
          datasets: [
            { label: 'Coût (€)', data: cvtData.map((d) => d.cost), backgroundColor: '#f59f00', yAxisID: 'y' },
            { label: 'Done', data: cvtData.map((d) => d.done), type: 'line', borderColor: '#1971c2', tension: 0.3, yAxisID: 'y1' },
          ],
        },
        options: { scales: { y: { position: 'left', title: { display: true, text: '€' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'tâches' } } } },
      });
      // Phase D — cadrage : éléments par classification + tâches générées.
      const recByClass = summary.cadrage?.byClass || { rework: 0, bug: 0, improvement: 0, feature: 0 };
      const recGen = summary.cadrage?.byGeneratedClass || { rework: 0, bug: 0, improvement: 0, feature: 0 };
      obsCharts.recClass = new Chart(document.getElementById('obs-rec-class'), {
        type: 'bar',
        data: { labels: ['Rework', 'Bug', 'Improvement', 'Feature'], datasets: [{ label: 'éléments', data: [recByClass.rework, recByClass.bug, recByClass.improvement, recByClass.feature], backgroundColor: ['#e03131', '#f76707', '#1971c2', '#2f9e44'] }] },
        options: { plugins: { legend: { display: false } } },
      });
      obsCharts.recGen = new Chart(document.getElementById('obs-rec-gen'), {
        type: 'bar',
        data: { labels: ['Rework', 'Bug', 'Improvement', 'Feature'], datasets: [{ label: 'tâches', data: [recGen.rework, recGen.bug, recGen.improvement, recGen.feature], backgroundColor: ['#e03131', '#f76707', '#1971c2', '#2f9e44'] }] },
        options: { plugins: { legend: { display: false } } },
      });
    }
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    pane.innerHTML = `<h2>Observabilité — KPI du système</h2><p class="danger">Erreur de chargement : ${esc(e.message || e)}</p>`;
  }
}

// --- Onglet Vars & Secrets E2E (module vars/secrets unifié) — variables d'env
// par projet. kind='variable' (clair, éditable) | 'secret' (chiffré AES-256-GCM,
// jamais de clair). Filtre par type ; deux vues cohérentes d'une même table.
let __secCache = []; // cache des vars du projet courant (purpose, kind…)
let e2eVarsKind = ''; // '' | variable | secret
function secretsFind(project, name) { return __secCache.find((s) => s.name === name) || null; }
async function renderE2ESecrets() {
  const pane = document.getElementById('pane-e2esecrets');
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  if (currentProject) e2eFilterProject = currentProject;
  let selected = e2eFilterProject || (projects[0] && projects[0].id) || '';
  let vars = [];
  __secCache = [];
  let projErr = '';
  if (selected) {
    const qs = `/api/e2e-vars?project=${encodeURIComponent(selected)}${e2eVarsKind ? '&kind=' + encodeURIComponent(e2eVarsKind) : ''}`;
    try { const d = await api(qs); vars = (d && d.vars) || []; __secCache = vars; }
    catch (e) { projErr = e.message || String(e); }
  }
  const isSecretView = e2eVarsKind === 'secret';
  const title = e2eVarsKind === 'secret' ? 'Secrets E2E' : (e2eVarsKind === 'variable' ? 'Variables E2E' : 'Variables & Secrets E2E');
  pane.innerHTML = `
    <h2>${title} <span class="muted-sm">— variables d'env par projet, injectées au run</span></h2>
    <p class="muted-sm">Chaque entrée = une variable d'environnement du run (ex. <code>E2E_ADMIN_EMAIL</code>, <code>E2E_ADMIN_PASSWORD</code>) lue par les specs via <code>process.env</code>. Les <strong>variables</strong> (non sensibles) sont en clair et injectées d'office ; les <strong>secrets</strong> sont chiffrés (AES-256-GCM) et sélectionnés au lancement.</p>
    <div class="filters">
      <select id="sec-project" title="Projet">${projects.map((p) => `<option value="${esc(p.id)}" ${selected === p.id ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}</select>
      <select id="sec-kind" title="Filtrer par type">
        <option value="" ${!e2eVarsKind ? 'selected' : ''}>Tous</option>
        <option value="variable" ${e2eVarsKind === 'variable' ? 'selected' : ''}>Variables (non sensibles)</option>
        <option value="secret" ${e2eVarsKind === 'secret' ? 'selected' : ''}>Secrets (chiffrés)</option>
      </select>
      <button id="new-secret-btn" class="launch-btn">+ ${isSecretView ? 'Nouveau secret' : (e2eVarsKind === 'variable' ? 'Nouvelle variable' : 'Nouvelle variable / secret')}</button>
      <span class="muted-sm">${vars.length} entrée(s)</span>
    </div>
    ${projErr ? `<p class="danger">${esc(projErr)}</p>` : ''}
    <table><thead><tr><th>Variable d'env</th><th>Type</th>${e2eVarsKind !== 'secret' ? '<th>Valeur</th>' : ''}<th>Usage (purpose)</th><th>Créé</th><th>Actions</th></tr></thead>
    <tbody>${vars.map((v) => `
      <tr>
        <td class="code"><strong>${esc(v.name)}</strong></td>
        <td>${v.kind === 'secret' ? '<span class="badge rejected">secret</span>' : '<span class="badge approved">variable</span>'}</td>
        ${e2eVarsKind !== 'secret' ? `<td class="muted-sm">${v.kind === 'secret' ? '<span>•••••••• (chiffré)</span>' : esc(v.value ?? '—')}</td>` : ''}
        <td class="muted-sm">${esc(v.purpose || '—')}</td>
        <td class="muted-sm">${esc(fmtTS(v.createdAt))}</td>
        <td><div class="icon-actions">
          <button class="icon-btn" data-secret-update="${esc(v.name)}" title="Remplacer la valeur">↻ MAJ</button>
          <button class="icon-btn danger-btn" data-secret-delete="${esc(v.name)}" title="Supprimer (définitif)">🗑 Supprimer</button>
        </div></td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">Aucune entrée pour ce projet (filtre : ${esc(e2eVarsKind || 'tous')}).</td></tr>`}</tbody></table>`;
  const sel = document.getElementById('sec-project');
  if (sel) sel.addEventListener('change', (ev) => { e2eFilterProject = ev.target.value; refreshActive(); });
  const kindSel = document.getElementById('sec-kind');
  if (kindSel) kindSel.addEventListener('change', (ev) => { e2eVarsKind = ev.target.value; refreshActive(); });
  document.getElementById('new-secret-btn').addEventListener('click', () => e2eVarModal(selected, projects, null));
  document.querySelectorAll('#pane-e2esecrets [data-secret-update]').forEach((b) => b.addEventListener('click', () => e2eVarModal(selected, projects, b.dataset.secretUpdate)));
  document.querySelectorAll('#pane-e2esecrets [data-secret-delete]').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.secretDelete;
    if (!confirm(`Supprimer « ${name} » (projet ${selected}) ? Définitif.`)) return;
    const original = b.innerHTML;
    setBtnBusy(b, 'Suppression');
    try { await api(`/api/e2e-vars?project=${encodeURIComponent(selected)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' }); refreshActive(); }
    catch (e) {
      b.disabled = false; b.classList.remove('ws-busy'); b.innerHTML = original;
      alert('Échec suppression : ' + (e.message || e));
    }
  }));
}

// Modale création / mise à jour d'une variable OU secret de projet.
function e2eVarModal(project, projects, existingName) {
  const isEdit = !!existingName;
  const existing = secretsFind(project, existingName) || {};
  const kind = isEdit ? existing.kind : (e2eVarsKind === 'secret' ? 'secret' : 'variable');
  const isSecret = kind === 'secret';
  const projOpts = projects.map((p) => `<option value="${esc(p.id)}" ${project === p.id ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('');
  showModal(`
    <div class="modal modal-wide">
      <h2>${isEdit ? `Remplacer ${isSecret ? 'le secret' : 'la variable'} <code>${esc(existingName)}</code>` : (isSecret ? 'Nouveau secret E2E' : 'Nouvelle variable E2E')}</h2>
      <p class="muted-sm">${isSecret
        ? 'Stockée chiffrée (AES-256-GCM, clé root-only hors registre) — jamais affichée en clair. Injectée au run si sélectionnée.'
        : 'Valeur non sensible, stockée en clair. Injectée automatiquement au run (défaut projet), surchargeable dans la modale de lancement.'}</p>
      <form id="sec-form" class="pilot-form">
        <label class="modal-field">Projet
          <select id="sec-f-project" ${isEdit ? 'disabled' : ''}>${projOpts}</select>
        </label>
        <label class="modal-field">Type
          <select id="sec-f-kind" ${isEdit ? 'disabled' : ''}>
            <option value="variable" ${kind === 'variable' ? 'selected' : ''}>variable (non sensible)</option>
            <option value="secret" ${kind === 'secret' ? 'selected' : ''}>secret (chiffré)</option>
          </select>
        </label>
        <label class="modal-field">Nom (variable d'env) <span class="muted-sm">— ex. E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, lu par les specs via process.env</span>
          <input id="sec-f-name" value="${esc(existingName || '')}" ${isEdit ? 'disabled' : ''} placeholder="E2E_ADMIN_PASSWORD" required>
        </label>
        <label class="modal-field">Valeur ${isEdit ? '<span class="muted-sm">— nouvelle valeur (écrase)</span>' : ''}
          <input id="sec-f-value" type="${isSecret ? 'password' : 'text'}" autocomplete="new-password" required placeholder="${isSecret ? '••••••••' : 'valeur (en clair, non sensible)'}">
        </label>
        <label class="modal-field">Usage <span class="muted-sm">— optionnel</span>
          <input id="sec-f-purpose" value="${esc(existing.purpose || '')}" placeholder="ex. compte admin console ONIRIA préprod">
        </label>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">${isEdit ? 'Remplacer la valeur' : (isSecret ? 'Créer le secret' : 'Créer la variable')}</button>
        </div>
      </form>
      <div id="sec-msg" class="msg"></div>
    </div>`);
  document.getElementById('sec-f-kind').addEventListener('change', (ev) => {
    const isS = ev.target.value === 'secret';
    const inp = document.getElementById('sec-f-value');
    if (inp) inp.type = isS ? 'password' : 'text';
  });
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('sec-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('sec-msg');
    const body = {
      project: document.getElementById('sec-f-project').value,
      name: document.getElementById('sec-f-name').value.trim(),
      value: document.getElementById('sec-f-value').value,
      kind: document.getElementById('sec-f-kind').value,
      purpose: document.getElementById('sec-f-purpose').value.trim() || undefined,
    };
    if (!body.project || !body.name || !body.value) { msg.textContent = 'Projet, nom et valeur requis.'; msg.className = 'msg error'; return; }
    const btn = ev.submitter || ev.target.querySelector('button[type="submit"]');
    const original = btn ? btn.innerHTML : null;
    setBtnBusy(btn, isEdit ? 'Remplacement' : 'Création');
    msg.textContent = isEdit ? 'Remplacement…' : 'Création…';
    msg.className = 'msg';
    try {
      await api('/api/e2e-vars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      refreshActive();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.classList.remove('ws-busy'); btn.innerHTML = original; }
      msg.textContent = e.message || String(e); msg.className = 'msg error';
    }
  });
}

const RENDER = {
  overview: renderOverview, observability: renderObservability, projects: renderProjects, tasks: renderTasks, e2etests: renderE2ETests, e2esecrets: renderE2ESecrets, cadrages: renderCadrages,
  recettes: renderRecettes,
  events: renderEvents, deployments: renderDeployments, decisions: renderDecisions, artifacts: renderArtifacts, adr: renderAdrs, plans: renderPlans, archives: renderArchives, ecosystem: renderEcosystem, workspaces: renderWorkspaces, users: renderUsers,
  sprints: renderSprints, features: renderFeaturesRules,
};

// --- Rafraîchissement automatique (polling, min 10 s) ----------------------
function updateLastUpdated() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = lastUpdated ? 'MAJ ' + lastUpdated.toLocaleTimeString() : '—';
}

// Enveloppe les tables dans un conteneur à défilement horizontal (mobile).
function tableScroll() {
  document.querySelectorAll('.pane.active table').forEach((t) => {
    if (t.parentElement && !t.parentElement.classList.contains('table-scroll')) {
      const w = document.createElement('div');
      w.className = 'table-scroll';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    }
  });
}

async function refreshActive() {
  try {
    await RENDER[activeTab]();
    tableScroll();
    lastUpdated = new Date();
    updateLastUpdated();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    console.error('refresh error', e);
  }
}

function startPolling() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (!REFRESH_S || REFRESH_S < 10) return; // manuel / intervalle désactivé
  refreshTimer = setInterval(() => { if (!document.hidden && activeTab !== 'pilot') refreshActive(); }, REFRESH_S * 1000);
}

async function init() {
  try {
    const me = await api('/api/me');
    ME = me.user;
    IS_ADMIN = !!(ME && ME.is_admin);
    IS_EVALUATEUR = !!(ME && ME.role === 'evaluateur');
    IS_EXECUTEUR = !!(ME && ME.role === 'executeur');
    IS_SUPERVISOR = !!(ME && ME.role === 'supervisor');
    document.getElementById('whoami').textContent = ME.username + (ME.is_admin ? ' (admin)' : (ME.role === 'supervisor' ? ' (superviseur)' : (ME.role === 'evaluateur' ? ' (évaluateur)' : (ME.role === 'executeur' ? ' (exécuteur)' : ''))));
    // Bandeau : libellé COURT (évite le débordement d'en-tête).
    const roBanner = document.querySelector('.readonly-banner');
    if (roBanner) {
      if (ME.role === 'supervisor') {
        roBanner.textContent = 'Superviseur';
        roBanner.title = "Rôle superviseur : lecture seule stricte sur TOUTES les pages et toutes les données de l'organisation active (toutes les tâches, toutes les recettes — évaluateur et cadrages techniques). Aucune écriture possible.";
      } else if (ME.role === 'evaluateur') {
        roBanner.textContent = 'Évaluateur produit';
        roBanner.title = "Rôle évaluateur : accès limité aux pages Fonctionnalités & Règles, Tests E2E et Recette ; vous ne voyez que vos propres recettes (écriture sur vos recettes, lancement de tests E2E, dépôt de pièces).";
        roBanner.style.display = 'inline-block';
      } else if (ME.role === 'executeur') {
        roBanner.textContent = 'Exécuteur';
        roBanner.title = "Rôle exécuteur : Vue d'ensemble, Tâches, Cadrage technique, Tests E2E, Fonctionnalités & Règles, Décisions, ADR, Workspaces. Vous travaillez dans le sprint ACTIF du projet ; le filtre sprint sert uniquement au traçage des anciens sprints (lecture seule).";
        roBanner.style.display = 'inline-block';
      }
    }
    // Rôle SUPERVISOR / lecture seule stricte : classe body (masque les actions
    // d'écriture via CSS).
    if (IS_SUPERVISOR) {
      document.body.classList.add('readonly');
    }
    // Rôle ÉVALUATEUR : classe body dédiée (masque les écritures hors périmètre
    // Features/Règles et E2E — cf. style.css `body.evaluateur`).
    if (ME.role === 'evaluateur') {
      document.body.classList.add('evaluateur');
    }
  } catch { return; }

  try {
    const cfg = await api('/api/config');
    REFRESH_S = Math.max(10, Number(cfg.refreshSeconds) || 10);
    if (cfg.sessionBaseUrl) SESSION_BASE_URL = cfg.sessionBaseUrl;
  } catch {}

  const sel = document.getElementById('refresh-select');
  const saved = localStorage.getItem('panel_refresh');
  if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  else if ([...sel.options].some((o) => Number(o.value) === REFRESH_S)) sel.value = String(REFRESH_S);

  const applyInterval = () => {
    const v = Number(sel.value);
    if (v === 0) {
      REFRESH_S = 0; // Manuel
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    } else {
      REFRESH_S = Math.max(10, v);
      startPolling();
    }
    localStorage.setItem('panel_refresh', sel.value);
  };
  sel.addEventListener('change', applyInterval);

  document.getElementById('refresh-btn').addEventListener('click', refreshActive);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeTab !== 'pilot') refreshActive();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // Organisations : charge la liste, peuple le sélecteur global, câble les actions.
  await loadOrganizations();
  const orgSel = document.getElementById('org-select');
  if (orgSel) orgSel.addEventListener('change', () => switchOrganization(orgSel.value));
  const orgBtn = document.getElementById('org-manage-btn');
  if (orgBtn) orgBtn.addEventListener('click', () => orgManageModal());
  // Écran de choix si l'utilisateur appartient à plusieurs orgs et n'en a pas choisi.
  if (ME && Array.isArray(ME.organizations) && ME.organizations.length > 1 && !ME.activeOrganizationId) {
    orgPickerModal();
  }

  // Navigation dynamique : accueil = liste des projets ; si un projet est
  // mémorisé, on le rouvre directement sur sa vue d'ensemble.
  renderNav();
  if (currentProject) switchTab('overview');
  else switchTab('projects');

  // Fermer la modale en cliquant sur le fond.
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  applyInterval();   // démarre le polling
  refreshActive();   // premier rendu immédiat
}

init();
