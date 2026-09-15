// app.js — Logique du panneau de supervision.
let ME = null;
let IS_ADMIN = false;    // vrai si l'utilisateur courant est admin (écritures)
let REFRESH_S = 10;      // intervalle (s), surchargé par /api/config (min 10)
let refreshTimer = null;
let activeTab = 'overview';
let lastUpdated = null;
let taskFilter = '';     // tâche sélectionnée comme filtre ('' = aucune)
let SESSION_BASE_URL = 'https://dev.madatalk.fr'; // base des liens de session opencode
let groupRecetteEnabled = localStorage.getItem('panel_group_recette') === '1'; // persistant (onglets + rechargement)
let groupParallelEnabled = localStorage.getItem('panel_group_parallel') === '1'; // grouper par ordre/parallèle
let tasksProjectFilter = localStorage.getItem('panel_task_project') || ''; // filtre projet de l'onglet Tâches (persistant re-rendu)
let tasksStatusFilter = (() => { try { const v = JSON.parse(localStorage.getItem('panel_task_status') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(); // statuts affichés (multi-valeurs, persistant re-rendu)
const persistTasksStatus = () => localStorage.setItem('panel_task_status', JSON.stringify(tasksStatusFilter));
let tasksNeedRecette = localStorage.getItem('panel_task_recette') === '1'; // pré-filtre « À recetter » (recette_status != done)
let tasksActifOnly = localStorage.getItem('panel_task_actif') === '1';      // pré-filtre « Actif » (statut != done)
let tasksDateFrom = localStorage.getItem('panel_task_date_from') || '';      // filtre date de création — borne basse (YYYY-MM-DD)
let tasksDateTo = localStorage.getItem('panel_task_date_to') || '';          // filtre date de création — borne haute (YYYY-MM-DD)
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

function recetteBadge(st) {
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
  return `<span class="badge ${cls}" title="Recette : ${esc(label)}">${esc(label)}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- Navigation croisée + filtre par tâche --------------------------------
function switchTab(tab) {
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
  ['recettes', 'Recettes'],
  ['e2etests', 'Tests E2E'],
  ['deployments', 'Déploiements'],
  ['decisions', 'Décisions'],
  ['plans', 'Plans'],
  ['events', 'Événements'],
  ['artifacts', 'Documents'],
  ['e2esecrets', 'Vars & Secrets E2E'],
  ['archives', 'Archives'],
];

// Construit la barre d'onglets selon l'état (projet ouvert ou non).
function renderNav() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  const tabs = currentProject ? PROJECT_TABS : GLOBAL_TABS;
  const activeIsDefault = (ORGANIZATIONS.find((o) => o.id === currentOrg) || {}).isDefault === true;
  const buttons = tabs
    .filter(([t]) => t !== 'users' || IS_ADMIN)
    .filter(([t]) => t !== 'workspaces' || IS_ADMIN)
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
  switchTab('overview');
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
    try { await api(`/api/orgs/${encodeURIComponent(b.dataset.orgDel)}`, { method: 'DELETE' }); await loadOrganizations(); closeModal(); orgManageModal(); refreshActive(); }
    catch (e) { const m = document.getElementById('org-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
  }));
  const form = document.getElementById('org-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
    } catch (err) { if (m) { m.textContent = err.message || String(err); m.className = 'msg error'; } }
  });
  // --- Tokens git additionnels (v0.10) : add / delete ---
  document.querySelectorAll('#modal-backdrop [data-org-git-del]').forEach((b) => b.addEventListener('click', async () => {
    const tokenId = b.dataset.orgGitDel;
    const tokenName = b.dataset.orgGitDelName || tokenId;
    if (!confirm(`Supprimer le token git « ${tokenName} » ? Les liaisons repo↔projet qui le référençaient repassent au token par défaut.`)) return;
    try { await api(`/api/orgs/${encodeURIComponent(selectedOrgId)}/git-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }); await loadOrganizations(); closeModal(); orgManageModal(); }
    catch (e) { const m = document.getElementById('org-git-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
  }));
  const gitTokenForm = document.getElementById('org-git-token-form');
  if (gitTokenForm) gitTokenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = document.getElementById('org-git-msg');
    const nameVal = document.getElementById('org-git-token-name').value.trim();
    const tokenVal = document.getElementById('org-git-token-value').value.trim();
    if (!nameVal || !tokenVal) { if (m) { m.textContent = 'Libellé et token requis.'; m.className = 'msg error'; } return; }
    try {
      await api(`/api/orgs/${encodeURIComponent(selectedOrgId)}/git-tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameVal, token: tokenVal }) });
      await loadOrganizations(); closeModal(); orgManageModal();
    } catch (err) { if (m) { m.textContent = err.message || String(err); m.className = 'msg error'; } }
  });
}

function goToTab(tab, taskId) {
  taskFilter = taskId || '';
  switchTab(tab);
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

// URL d'une session opencode (réutilisée par sessionLink et le bouton recette).
function sessionHref(sid) {
  const encoded = btoa(SESSION_BASE_URL).replace(/=+$/, '');
  return `${SESSION_BASE_URL}/server/${encoded}/session/${encodeURIComponent(sid)}`;
}

// --- Vue d'ensemble --------------------------------------------------------
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
    `<div class="muted-sm">Registre : ${s.byStatus && Object.keys(s.byStatus).length ? 'connecté' : 'vide / non initialisé'}</div>`;
}

// --- Tâches ----------------------------------------------------------------
async function renderTasks() {
  // Projet ouvert → le filtre projet est verrouillé sur ce projet.
  if (currentProject) tasksProjectFilter = currentProject;
  const [data, plansData] = await Promise.all([api('/api/tasks'), api('/api/plans')]);
  const tasks = data.tasks || [];
  const plans = plansData.plans || [];
  const plansByTask = {};
  plans.forEach((p) => { if (p.task_id) (plansByTask[p.task_id] = plansByTask[p.task_id] || []).push(p); });
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
      <label class="muted filter-check"><input type="checkbox" id="f-group-recette" ${groupRecetteEnabled ? 'checked' : ''}> Grouper par recette</label>
      <label class="muted filter-check" id="f-group-parallel-wrap" hidden><input type="checkbox" id="f-group-parallel" ${groupParallelEnabled ? 'checked' : ''}> Grouper par tâches parallèles</label>
      <label class="muted filter-check" title="Tâches dont la recette n'est pas faite"><input type="checkbox" id="f-filter-recette" ${tasksNeedRecette ? 'checked' : ''}> À recetter</label>
      <label class="muted filter-check" title="Tâches dont le statut n'est pas « done »"><input type="checkbox" id="f-filter-actif" ${tasksActifOnly ? 'checked' : ''}> Actif</label>
      <span class="date-filter" title="Filtrer par date de création">
        <span class="tagfilter-label">Créée du</span>
        <input type="date" id="f-date-from" value="${esc(tasksDateFrom)}">
        <span class="tagfilter-label">au</span>
        <input type="date" id="f-date-to" value="${esc(tasksDateTo)}">
        <button type="button" class="ghost" id="f-date-clear" title="Effacer le filtre date" ${(tasksDateFrom || tasksDateTo) ? '' : 'hidden'}>✕</button>
      </span>
      <button id="new-task-btn" class="launch-btn">+ Nouvelle tâche</button>
    </div>
    <table><thead><tr><th></th><th>ID</th><th>Projet</th><th>Type</th><th>Priorité</th><th>Statut</th><th>Recette</th><th>E2E</th><th>Demande</th><th>Session</th><th>Actions</th></tr></thead>
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
  document.getElementById('new-task-btn').addEventListener('click', () => taskCreateModal());
  const apply = () => {
    const p = currentProject || (document.getElementById('f-project')?.value || '');
    const st = tasksStatusFilter;
    const groupRecette = document.getElementById('f-group-recette').checked;
    const groupParallel = document.getElementById('f-group-parallel').checked;
    const parallelWrap = document.getElementById('f-group-parallel-wrap');
    if (parallelWrap) parallelWrap.hidden = !groupRecette;
    const needRecette = document.getElementById('f-filter-recette').checked;
    const actifOnly = document.getElementById('f-filter-actif').checked;
    const dateFrom = document.getElementById('f-date-from').value; // YYYY-MM-DD
    const dateTo = document.getElementById('f-date-to').value;
    const dayOf = (t) => (t.created_at || '').slice(0, 10); // partie date ISO
    const rows = tasks.filter((t) =>
      (!p || t.project === p)
      && (!currentOrg || (t.organization_id || 'onirtech') === currentOrg)
      && (!st.length || st.includes(t.status || 'queued'))
      && (!needRecette || (t.recette_status || 'pending') !== 'done')
      && (!actifOnly || (t.status || 'queued') !== 'done')
      && (!dateFrom || dayOf(t) >= dateFrom)
      && (!dateTo || dayOf(t) <= dateTo));

    // Une ligne de tâche (avec ses plans en sous-lignes).
    const rowHtml = (t, recetteParent) => {
      const subs = plansByTask[t.id] || [];
      const toggle = subs.length ? `<button class="tree-toggle" data-toggle="${esc(t.id)}">▸</button>` : '';
      const recetteAttr = recetteParent ? ` data-recette-child="${esc(recetteParent)}"` : '';
      const recetteBadgeExtra = t.recette_class
        ? ` <span class="badge ${RECETTE_CLS_BADGE[t.recette_class] || 'queued'}" title="Issue de la recette (${RECETTE_CLS_LABEL[t.recette_class]})">recette</span>`
        : '';
      const orderBadge = t.recette_order != null
        ? ` <span class="badge order-badge" title="Ordre d'exécution recommandé (recette)">ordre ${esc(t.recette_order)}</span>`
        : '';
      const vigBadge = t.recette_vigilance
        ? ` <span class="badge danger vig-badge" title="Point de vigilance / écart sémantique : ${esc(t.recette_vigilance)}">⚠ vigilance</span>`
        : '';
      const parent = `<tr class="task-row"${recetteAttr}>
        <td>${toggle}</td>
        <td class="code">${esc(t.id)}</td>
        <td>${esc(t.project)}</td>
        <td>${esc(t.type)}</td>
        <td>${esc(t.priority)}</td>
        <td>${badge(t.status)}${t.waiting_human ? '<span class="badge waiting-human" title="Une décision humaine est en attente (validation / review)">⏳ attente humaine</span>' : ''}</td>
        <td>${recetteBadge(t.recette_status)}${recetteBadgeExtra}${orderBadge}${vigBadge}</td>
        <td>${e2eBadgeCell(t)}</td>
        <td><span title="${esc(t.request || '')}"><strong>${esc((t.title && t.title.trim()) ? t.title : (t.request || '').slice(0, 60))}</strong></span>${(t.title && t.title.trim()) && t.request ? `<span class="muted-sm"> — ${esc(t.request.slice(0, 40))}</span>` : ''}</td>
        <td>${sessionLink(t.session_id)}</td>
        <td>${detailsButtons(t)}</td>
      </tr>`;
      const children = subs.map((s) => `
        <tr class="subtask-row" data-child="${esc(t.id)}" hidden>
          <td></td>
          <td colspan="9">
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

    let html;
    if (groupRecette) {
      // Regroupe les tâches issues d'une recette sous leur recette source (titre si disponible).
      const bySource = {};
      const others = [];
      for (const t of rows) {
        if (t.recette_source) (bySource[t.recette_source] = bySource[t.recette_source] || []).push(t);
        else others.push(t);
      }
      const groupHtml = (sourceId, list) => {
        const sorted = [...list].sort((a, b) => (a.recette_order ?? 999) - (b.recette_order ?? 999) || String(a.id).localeCompare(String(b.id)));
        const title = sorted[0] && sorted[0].recette_source_title;
        const label = sourceId === '(sans recette)'
          ? 'Autres tâches'
          : (title ? `Recette — ${esc(title)}` : `Recette de ${esc(sourceId)}`);
        const cls = [...new Set(sorted.map((x) => x.recette_class).filter(Boolean))];
        const head = `<tr class="recette-group-head"><td colspan="12">
          <button class="tree-toggle" data-recette-toggle="${esc(sourceId)}">▸</button>
          <span class="code">${label}</span>
          <span class="muted-sm">— ${sorted.length} tâche(s)${cls.length ? ' · ' + cls.map((c) => RECETTE_CLS_LABEL[c]).join(' / ') : ''}</span>
        </td></tr>`;
        const members = () => {
          if (!groupParallel) return sorted.map((t) => rowHtml(t, sourceId)).join('');
          // Sous-groupes par ordre d'exécution (même ordre = parallèle).
          const byOrder = {};
          sorted.forEach((t) => { const o = t.recette_order ?? 999; (byOrder[o] = byOrder[o] || []).push(t); });
          return Object.keys(byOrder).sort((a, b) => Number(a) - Number(b)).map((o) => {
            const l = byOrder[o];
            const isParallel = l.length > 1;
            const subHead = `<tr class="recette-order-row" data-recette-child="${esc(sourceId)}"><td colspan="12">
              <span class="tree-branch">↳</span> <strong>Ordre ${o === '999' ? '— (non défini)' : esc(o)}</strong>${isParallel ? ` <span class="muted-sm">(${l.length} exécutables en parallèle)</span>` : ''}
            </td></tr>`;
            return subHead + l.map((t) => rowHtml(t, sourceId)).join('');
          }).join('');
        };
        return head + members();
      };
      const groups = Object.entries(bySource).sort((a, b) => b[0].localeCompare(a[0])).map(([s, l]) => groupHtml(s, l)).join('');
      const othersHtml = others.length ? groupHtml('(sans recette)', others) : '';
      html = (groups + othersHtml) || '<tr><td colspan="12" class="muted">Aucune tâche</td></tr>';
    } else {
      html = rows.map((t) => rowHtml(t, null)).join('') || '<tr><td colspan="12" class="muted">Aucune tâche</td></tr>';
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
      const src = b.dataset.recetteToggle;
      const children = document.querySelectorAll(`#tasks-body [data-recette-child="${src}"]`);
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
  const needRecetteBox = document.getElementById('f-filter-recette');
  if (needRecetteBox) needRecetteBox.addEventListener('change', () => {
    tasksNeedRecette = needRecetteBox.checked;
    localStorage.setItem('panel_task_recette', tasksNeedRecette ? '1' : '0');
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
  document.getElementById('f-group-recette').addEventListener('change', () => {
    groupRecetteEnabled = document.getElementById('f-group-recette').checked;
    localStorage.setItem('panel_group_recette', groupRecetteEnabled ? '1' : '0');
    if (!groupRecetteEnabled) { groupParallelEnabled = false; document.getElementById('f-group-parallel').checked = false; }
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
  // Actionnable = awaiting, hors recette, sans permission_id (canal B).
  const actionable = (d) => d.status === 'awaiting' && d.kind !== 'recette' && !d.permission_id;
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
      try {
        await resolveDecision(decisionId, st, resolution);
        refreshActive();
      } catch (err) { alert('Échec : ' + (err.message || err)); }
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
  const actionable = decision && decision.status === 'awaiting' && decision.kind !== 'recette' && !decision.permission_id;
  const canAct = IS_ADMIN && actionable;
  const [detailHtml, taskHtml] = await Promise.all([
    renderMarkdownInline(decision.detail),
    renderMarkdownInline(decision.task_request || ''),
  ]);
  const kindLabel = { validation: 'Validation', review: 'Review', permission: 'Permission', recette: 'Recette' }[decision.kind] || decision.kind;
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
    try {
      await resolveDecision(decision.decision_id, status, resolution);
      closeModal();
      if (back) back(); else refreshActive();
    } catch (err) { alert('Échec : ' + (err.message || err)); }
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
  const roleOpts = (sel) => `<select class="role-sel" data-user="${esc(sel.id)}">${['admin', 'supervisor', 'user'].map((rl) => `<option value="${rl}" ${sel.role === rl ? 'selected' : ''}>${rl === 'admin' ? 'admin' : rl === 'supervisor' ? 'superviseur' : 'utilisateur'}</option>`).join('')}</select>`;
  document.getElementById('pane-users').innerHTML = `
    <h2>Utilisateurs <span class="muted-sm">— organisation ${esc(currentOrg)}</span></h2>
    <p class="muted-sm">Rôles : <strong>admin</strong> (écriture, tous les projets de l'organisation) · <strong>superviseur</strong> (lecture seule, tous les projets) · <strong>utilisateur</strong> (peut créer/agir, ne voit que <em>ses propres créations</em>). L'accès aux <strong>projets</strong> est explicite (aucun par défaut ; l'admin a tous les projets).</p>
    <div class="eco-restart-bar"><button class="launch-btn" id="add-user-btn">Ajouter un utilisateur</button><span id="users-msg" class="muted-sm"></span></div>
    <table><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Organisations</th><th>Projets</th><th>opencode</th><th>Créé le</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${roleOpts(u)}</td><td><button class="ghost tiny" data-user-orgs="${u.id}" data-user-name="${esc(u.username)}">Gérer</button></td><td><button class="ghost tiny" data-user-projects="${u.id}" data-user-name="${esc(u.username)}">Gérer</button></td><td><button class="ghost tiny" data-user-oc="${u.id}" data-user-name="${esc(u.username)}">Accès</button></td><td class="code">${esc((u.created_at || '').replace('T', ' ').slice(0, 19))}</td>    <td><div class="icon-actions"><button class="ghost tiny" data-oc-restart="${esc(u.username)}" title="Redémarrer l'instance opencode@${esc(u.username)}.service">Redémarrer</button><button class="danger" data-del="${u.id}">Supprimer</button></div></td></tr>`).join('')}</tbody></table>`;
  document.getElementById('add-user-btn').addEventListener('click', () => userCreateModal());
  document.querySelectorAll('#pane-users [data-del]').forEach((b) => b.addEventListener('click', async () => {
    await fetch(`/api/users/${b.dataset.del}`, { method: 'DELETE' });
    renderUsers();
  }));
  document.querySelectorAll('#pane-users .role-sel').forEach((sel) => sel.addEventListener('change', async () => {
    const rr = await fetch(`/api/users/${sel.dataset.user}/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value }) });
    const msg = document.getElementById('users-msg');
    if (!rr.ok) msg.textContent = (await rr.json()).error || 'Erreur';
    renderUsers();
  }));
  document.querySelectorAll('#pane-users [data-user-orgs]').forEach((b) => b.addEventListener('click', () => userOrgsModal(Number(b.dataset.userOrgs), b.dataset.userName)));
  document.querySelectorAll('#pane-users [data-user-projects]').forEach((b) => b.addEventListener('click', () => userProjectsModal(Number(b.dataset.userProjects), b.dataset.userName)));
  document.querySelectorAll('#pane-users [data-user-oc]').forEach((b) => b.addEventListener('click', () => userOpencodeModal(Number(b.dataset.userOc), b.dataset.userName)));
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
            <option value="user">utilisateur</option>
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
    try {
      await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role, organizationId, projectIds }) });
      closeModal(); renderUsers();
    } catch (e) { m.textContent = e.message || String(e); m.className = 'msg error'; }
  };
}

// Redémarrage de l'instance systemd opencode@<user>.service d'un utilisateur (admin).
async function restartOpencodeSession(username) {
  if (!confirm(`Redémarrer la session opencode de « ${username} » ?\nL'instance systemd opencode@${username}.service sera relancée (recharge la config des agents : modèles, permissions, skills, MCP).`)) return;
  const msg = document.getElementById('users-msg');
  const btn = [...document.querySelectorAll('#pane-users [data-oc-restart]')].find((x) => x.dataset.ocRestart === username);
  const prevLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'redémarrage…'; }
  try {
    const r = await fetch(`/api/opencode/restart-user/${encodeURIComponent(username)}`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    if (msg) { msg.textContent = `Session opencode « ${username} » redémarrée.`; msg.className = 'msg'; }
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevLabel; }
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
    const m = document.getElementById('oc-msg');
    try { m.textContent = 'Provisionnement…'; m.className = 'msg'; await api(`/api/users/${userId}/opencode`, { method: 'POST' }); closeModal(); userOpencodeModal(userId, username); }
    catch (e) { if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
  };
  const dep = document.getElementById('oc-deprov');
  if (dep) dep.onclick = async () => {
    if (!confirm('Déprovisionner l\'instance opencode de cet utilisateur ?')) return;
    try { await api(`/api/users/${userId}/opencode`, { method: 'DELETE' }); closeModal(); userOpencodeModal(userId, username); }
    catch (e) { const m = document.getElementById('oc-msg'); if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
  };
}

// Modale d'accès par PROJET d'un utilisateur (admin). Aucun par défaut.
async function userProjectsModal(userId, username) {
  let all = [];
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
    const m = document.getElementById('up-msg');
    try {
      await api(`/api/users/${userId}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectIds: ids }) });
      closeModal(); renderUsers();
    } catch (e) { if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
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
    const m = document.getElementById('uo-msg');
    try {
      await api(`/api/users/${userId}/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationIds: ids }) });
      closeModal(); renderUsers();
    } catch (e) { if (m) { m.textContent = e.message || String(e); m.className = 'msg error'; } }
  };
}

// --- Documents (artifacts liés aux demandes) ------------------------------
async function renderArtifacts() {
  const data = await api('/api/artifacts' + taskQuery());
  const arts = data.artifacts || [];
  document.getElementById('pane-artifacts').innerHTML = `
    <h2>Documents liés aux demandes</h2>
    ${filterBar()}
    <table><thead><tr><th>Tâche</th><th>Type</th><th>Document</th><th>Ajouté</th><th></th></tr></thead>
    <tbody>${arts.map((a) => `<tr><td class="code">${esc(a.task_id)}</td><td>${badge(a.kind)}</td><td>${esc(a.title || a.path)}</td><td class="code">${esc((a.created_at || '').replace('T', ' ').slice(0, 19))}</td><td>${/\.md$/i.test(a.path || '') ? `<a class="ghost" href="/view-md.html?task=${encodeURIComponent(a.task_id)}&art=${encodeURIComponent(a.artifact_id)}">Regarder</a> ` : ''}<a class="btn-dl" href="/api/tasks/${encodeURIComponent(a.task_id)}/artifacts/${encodeURIComponent(a.artifact_id)}/download" download>Télécharger</a></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun document</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

// --- Recettes (v0.8.0) : objet de projet -----------------------------------
const RECETTE_STATUS_LABEL = { pending: 'pas faite', in_progress: 'en cours', done: 'faite' };

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

// Projet unique d'une recette + ses repos transverses (portée réelle, ADR 11).
function recetteScopeChips(rec) {
  const project = (rec && rec.project) ? rec.project : '';
  const repos = (rec && Array.isArray(rec.repos)) ? rec.repos : [];
  const projChip = project ? `<code class="chip-project" title="Projet (produit) de la recette">${esc(project)}</code>` : '';
  const repoChips = repos.length
    ? repos.map((rp) => `<code class="chip-repo" title="Repo transverse du projet (portée)">${esc(rp.repoId || rp.id || rp)}</code>`).join(' ')
    : '';
  return [projChip, repoChips ? `<span class="muted-sm" style="font-size:11px">repos : ${repoChips}</span>` : ''].filter(Boolean).join(' ') || '<span class="muted-sm">—</span>';
}

// ===========================================================================
// Tests E2E (v0.9.0) — entités de 1er niveau, indépendantes des tâches
// ===========================================================================
const E2E_TEST_STATUS_LABEL = { ACTIVE: 'actif', OBSOLETE: 'obsolète', QUARANTINE: 'quarantaine', DRAFT: 'brouillon' };
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
  const cls = { ACTIVE: 'approved', OBSOLETE: 'queued', QUARANTINE: 'danger', DRAFT: 'queued' }[st] || 'queued';
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
  const tests = data.tests || [];
  const projects = [...new Set([
    ...((projsRes.projects || []).map((p) => p.id).filter(Boolean)),
    ...tests.map((t) => t.project).filter(Boolean),
  ])].sort();
  if (e2eFilterProject && !projects.includes(e2eFilterProject)) projects.push(e2eFilterProject);
  document.getElementById('pane-e2etests').innerHTML = `
    <h2>Tests E2E <span class="muted-sm">— entités de 1er niveau</span></h2>
    <p class="muted-sm">Un test Playwright est enregistré indépendamment des tâches ; les exécutions lui appartiennent (origine tâche / recette / CI / manuelle).</p>
    ${filterBar()}
    <div class="filters">
      ${currentProject ? '' : `<select id="e2e-f-project" title="Filtrer par projet couvert"><option value="">Tous les projets</option>${projects.map((p) => `<option value="${esc(p)}" ${e2eFilterProject === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`}
      <select id="e2e-f-status" title="Filtrer par statut du test"><option value="">Tous les statuts</option>${E2E_STATUS_OPTIONS}</select>
      <input id="e2e-f-search" placeholder="recherche (titre / scénario / spec)…" value="${esc(e2eFilterSearch)}">
      <button id="agent-session-btn" class="ghost" title="Ouvrir l'agent de test — reprendre une session existante ou en ouvrir une nouvelle (sans forcément créer un test)">Session test-agent</button>
      <button id="new-e2e-btn" class="launch-btn">+ Nouveau test</button>
    </div>
    <table><thead><tr><th>Titre / Comportement</th><th>Projet</th><th>Repos traversés</th><th>Scénario</th><th>Statut</th><th>Dernier run</th><th>Actions</th></tr></thead>
    <tbody>${tests.map(e2eTableRow).join('') || `<tr><td colspan="7" class="muted">${taskFilter ? 'Aucun test E2E associé à la tâche <code>' + esc(taskFilter) + '</code>.' : (e2eFilterStatus ? 'Aucun test E2E ' + esc((E2E_TEST_STATUS_LABEL[e2eFilterStatus] || e2eFilterStatus)) + ' (changez le filtre de statut).' : 'Aucun test E2E enregistré.')}</td></tr>`}</tbody></table>`;
  bindTaskFilter();
  const e2eProjSel = document.getElementById('e2e-f-project');
  if (e2eProjSel) e2eProjSel.addEventListener('change', (ev) => { e2eFilterProject = ev.target.value; refreshActive(); });
  const statusSel = document.getElementById('e2e-f-status');
  statusSel.value = e2eFilterStatus;
  statusSel.addEventListener('change', (ev) => { e2eFilterStatus = ev.target.value; refreshActive(); });
  const searchInp = document.getElementById('e2e-f-search');
  searchInp.addEventListener('change', () => { e2eFilterSearch = searchInp.value; refreshActive(); });
  document.getElementById('new-e2e-btn').addEventListener('click', () => e2eCreateModal());
  document.getElementById('agent-session-btn').addEventListener('click', () => agentSessionModal());
  document.querySelectorAll('#pane-e2etests [data-e2e-detail]').forEach((b) => b.addEventListener('click', () => e2eDetailModal(b.dataset.e2eDetail)));
  document.querySelectorAll('#pane-e2etests [data-e2e-run]').forEach((b) => b.addEventListener('click', () => e2eRunModal(b.dataset.e2eRun)));
  document.querySelectorAll('#pane-e2etests [data-e2e-obsolete]').forEach((b) => b.addEventListener('click', () => e2eObsoleteModal(b.dataset.e2eObsolete)));
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
    <td>${IS_ADMIN
      ? `<div class="icon-actions">
          <button class="icon-btn" data-e2e-detail="${esc(t.e2eTestId)}" title="Voir le détail du test (exécutions, vidéo, rapport)">Détail</button>
          <button class="icon-btn" data-e2e-run="${esc(t.e2eTestId)}" title="Lancer une exécution">▶ Lancer</button>
          ${t.status === 'ACTIVE' ? `<button class="icon-btn danger-btn" data-e2e-obsolete="${esc(t.e2eTestId)}" title="Marquer obsolète (spec disparu)">⚠ Obsolète</button>` : ''}
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
          <fieldset id="as-docs-fieldset" class="pilot-fieldset">
            <legend>Documents de référence — contexte de l'agent <span class="muted-sm">(ADR technique, User stories + règles métier, scénarios Gherkin). Tous cochés par défaut.</span></legend>
            <div id="as-docs-list"><p class="muted-sm">Sélectionnez un projet pour afficher ses documents de référence.</p></div>
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

  // --- Projet → documents de référence + variables/secrets ---
  const docsList = document.getElementById('as-docs-list');
  const varsList = document.getElementById('as-vars-list');
  const projSel = document.getElementById('as-project');
  const KINDS = DOC_KIND_ORDER;
  const renderDocs = (docs) => {
    const byKind = {};
    for (const d of docs) (byKind[d.kind] = byKind[d.kind] || []).push(d);
    docsList.innerHTML = KINDS.map((k) => {
      const items = byKind[k] || [];
      const inner = items.length
        ? `<div style="padding-left:22px">${items.map((d) => `<label class="filter-check"><input type="checkbox" class="as-doc" data-kind="${esc(k)}" value="${esc(d.docId)}" checked title="${esc(d.path)}"> ${esc(d.title || d.docId)} <span class="muted-sm" style="font-size:11px">${esc(d.path)}</span></label>`).join('')}</div>`
        : `<p class="muted-sm" style="font-size:11px;padding-left:22px">Aucun document enregistré de ce type — ajoutez-le via <em>Projets → 📄 Docs de référence</em>.</p>`;
      return `<div><label class="filter-check"><input type="checkbox" class="as-kind" data-kind="${esc(k)}" checked> <code class="chip">${esc(docKindLabel(k))}</code> ${esc(docKindLabelLong(k))}</label>${inner}</div>`;
    }).join('');
    document.querySelectorAll('#modal-backdrop .as-kind').forEach((cb) => cb.addEventListener('change', () => {
      document.querySelectorAll(`#modal-backdrop .as-doc[data-kind="${cb.dataset.kind}"]`).forEach((d) => { d.checked = cb.checked; });
    }));
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
      docsList.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour afficher ses documents de référence.</p>';
      varsList.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour confirmer ses variables &amp; secrets.</p>';
      return;
    }
    docsList.innerHTML = '<p class="muted-sm">Chargement…</p>';
    varsList.innerHTML = '<p class="muted-sm">Chargement…</p>';
    try {
      const [dd, vd] = await Promise.all([
        api(`/api/docs?projectId=${encodeURIComponent(pid)}&includeRepoDocs=1`).catch(() => ({ docs: [] })),
        api(`/api/e2e-vars?project=${encodeURIComponent(pid)}`).catch(() => ({ vars: [] })),
      ]);
      renderDocs(dd.docs || []);
      renderVars(vd.vars || []);
    } catch (e) { docsList.innerHTML = '<p class="muted-sm">Erreur de chargement.</p>'; }
  };
  projSel.addEventListener('change', reloadProject);

  document.getElementById('agent-session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('agent-session-msg');
    msg.textContent = 'Ouverture de la session…'; msg.className = 'msg';
    try {
      const project = document.getElementById('as-project').value;
      const docIds = [...document.querySelectorAll('#modal-backdrop .as-doc:checked')].map((c) => c.value);
      const r = await api('/api/e2e/agent-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'new', project: project || undefined,
        docIds, // toujours un tableau (vide = aucun doc)
        message: document.getElementById('as-message').value.trim() || undefined,
      }) });
      if (r && r.sessionId && /^ses_/.test(r.sessionId)) {
        closeModal();
        window.open(sessionHref(r.sessionId), '_blank');
      } else {
        msg.textContent = r.error || 'Session ouverte (id inconnu).'; msg.className = 'msg error';
      }
    } catch (err) { msg.textContent = err.message || String(err); msg.className = 'msg error'; }
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
      <div class="actions-section">
        <div class="project-kv"><span class="lbl">Projet</span><code class="muted-sm">${esc(test.project || '—')}</code></div>
        <div class="project-kv"><span class="lbl">Repos traversés</span><span>${testRepos.length ? testRepos.map((r) => `<code class="chip">${esc(r.id)}${r.workspace ? ' · ' + esc(r.workspace) : ''}</code>`).join(' ') : '<span class="muted-sm">—</span>'}</span></div>
        <div class="project-kv"><span class="lbl">Spec file</span><code class="muted-sm">${esc(test.specFile || '—')}</code></div>
        <div class="project-kv"><span class="lbl">Scénario</span><span class="muted-sm">${esc(test.scenario || '—')}</span></div>
        <div class="project-kv"><span class="lbl">Suivi</span><span class="muted-sm">vu depuis ${esc(fmtTS(test.firstSeenAt))} · màj ${esc(fmtTS(test.updatedAt))} · ${(test.taskCount != null ? test.taskCount : linked.length)} tâche(s) liée(s)</span></div>
      </div>
      ${(test.docs && test.docs.length) ? `<div class="actions-section"><h3>Documents de référence du projet (contexte test-agent / recette)</h3>
        <div class="recette-list">${test.docs.map((d) => `<div class="recette-item">
          <code class="chip">${esc(docKindLabel(d.kind))}</code> <strong>${esc(d.title || d.docId)}</strong>
          <span class="muted-sm">${esc(d.path)}</span>
        </div>`).join('')}</div>
        <p class="muted-sm">Ces documents (ADR technique, specs, Gherkin) sont fournis en contexte lors des sessions de création / recette — voir l'onglet Projets → 📄 Docs de référence pour les gérer.</p>
      </div>` : ''}
      ${test.description ? `<div class="modal-request">${esc(test.description)}</div>` : ''}
      ${test.gherkin ? `<div class="actions-section"><h3>Comportement (Gherkin)</h3>
        <pre style="background:rgba(255,255,255,0.05);padding:12px;border-radius:6px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5">${esc(test.gherkin)}</pre>
      </div>` : ''}
      ${(test.requiredOpen != null && test.requiredOpen > 0) ? `<div class="actions-section">
        <p class="badge danger" style="display:inline-block">⚠ bloqué par ${test.requiredOpen} tâche(s) REQUIRED non terminée(s) — le test ne sera PASS qu'une fois ces tâches done.</p>
        <div class="recette-list">${(test.requiredOpenTasks || []).map((rt) => `<div class="recette-item">
          <code class="muted-sm">${esc(rt.taskId)}</code>
          <span class="muted-sm">${esc(rt.title || '')}</span>
          <button type="button" class="ghost" data-e2e-task-goto="${esc(rt.taskId)}">Ouvrir la tâche</button>
        </div>`).join('')}</div>
      </div>` : ''}
      <div class="actions-buttons">
        <button type="button" class="ghost" data-e2e-create-task="${esc(test.e2eTestId || e2eTestId)}" title="Créer une tâche requise pour que ce test passe (contrat BDD/TDD)">+ Créer une tâche (requise)</button>
      </div>
      ${(test.status === 'DRAFT' || test.sessionId) ? `<div class="actions-section"><h3>Session de création / mise à jour</h3>
        <p class="muted-sm">${test.status === 'DRAFT' ? 'Test en DRAFT : le spec est en cours de rédaction par la session test-agent.' : 'Une session test-agent est rattachée à ce test (création / mise à jour).'}</p>
        <div class="actions-buttons">
          <button type="button" class="launch-btn" data-e2e-session="${esc(test.e2eTestId || e2eTestId)}" title="${test.sessionId ? 'Reprendre la session de création en cours' : 'Ouvrir une session de création (test-agent)'}">${test.sessionId ? 'Reprendre la session' : 'Session de création'}</button>
          <button type="button" class="ghost" data-e2e-session-force="${esc(test.e2eTestId || e2eTestId)}" title="Démarrer une NOUVELLE session test-agent (force)">Nouvelle session</button>
        </div>
      </div>` : ''}
      ${params.length ? `<div class="actions-section"><h3>Params historiques (${params.length})</h3>
        <p class="muted-sm">Anciens « paramètres de test » — migrés vers des variables de projet (onglet Vars &amp; Secrets E2E).</p>
        <div class="table-scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Défaut</th></tr></thead>
        <tbody>${params.map((p) => `<tr>
          <td class="code">${esc(p.name)}</td>
          <td>${esc(p.kind)}</td>
          <td>${p.kind === 'secret' ? '<span class="muted-sm">—</span>' : esc(p.defaultValue ?? '—')}</td>
        </tr>`).join('')}</tbody></table></div></div>` : ''}
      ${((test.projectVars || []).length || (test.projectSecrets || []).length) ? `<div class="actions-section"><h3>Variables &amp; secrets du projet (injectés au run)</h3>
        <div class="recette-list">${[...(test.projectVars || []).map((v) => ({ ...v, kind: 'variable' })), ...(test.projectSecrets || [])].map((s) => `<div class="recette-item">
          <code>${esc(s.name)}</code>
          ${s.kind === 'secret' ? '<span class="badge rejected">secret</span>' : `<span class="badge approved">variable</span><span class="muted-sm"> · ${esc((s.value ?? s.defaultValue) || '—')}</span>`}
          <span class="muted-sm">${esc(s.purpose || '')}</span>
        </div>`).join('')}</div>
        <p class="muted-sm"><a href="#" onclick="goToTab('e2esecrets'); return false;">Gérer les variables &amp; secrets (onglet Vars &amp; Secrets E2E)</a></p>
      </div>` : ''}
      <div class="actions-section"><h3>Tâches liées (${linked.length})</h3>
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
        <button class="launch-btn" id="e2e-launch-btn" title="Lancer une exécution sur ce test">Lancer une exécution</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('e2e-launch-btn').onclick = () => { closeModal(); e2eRunModal(e2eTestId); };
  document.querySelectorAll('#modal-backdrop [data-e2e-session]').forEach((b) => b.addEventListener('click', () => openTestSession(b.dataset.e2eSession, false)));
  document.querySelectorAll('#modal-backdrop [data-e2e-session-force]').forEach((b) => b.addEventListener('click', () => openTestSession(b.dataset.e2eSessionForce, true)));
  document.querySelectorAll('#modal-backdrop [data-e2e-create-task]').forEach((b) => b.addEventListener('click', () => e2eCreateTaskModal(b.dataset.e2eCreateTask)));
  document.querySelectorAll('#modal-backdrop [data-e2e-task-goto]').forEach((b) => b.addEventListener('click', () => { closeModal(); taskActionsModal(b.dataset.e2eTaskGoto); }));
  document.querySelectorAll('#modal-backdrop [data-e2e-video]').forEach((b) => b.addEventListener('click', () => openE2EVideoModal(b.dataset.e2eVideo, b.dataset.title, b.dataset.exec)));
}

// Ouvre la session de création/mise à jour d'un test (agent test-agent).
// Reprend la session rattachée si elle existe ; `force = true` en démarre une.
async function openTestSession(e2eTestId, force) {
  try {
    const r = await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || 'Aucune session test-agent disponible.');
    closeModal();
    refreshActive();
  } catch (e) { alert('Échec de la session test-agent : ' + (e.message || e)); }
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
    } catch (err) { msg.textContent = err.message || String(err); msg.className = 'msg error'; }
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
          <input id="er-pwconfig" placeholder="ex: playwright.madatalk-requests.recette.config.ts">
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
      const m = err && err.message ? String(err.message) : String(err);
      msg.textContent = 'Échec du lancement : ' + m;
      msg.className = 'msg error';
      return;
    }
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
    } catch (err) { msg.textContent = 'Échec : ' + (err.message || err); msg.className = 'msg error'; }
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
    const msg = document.getElementById('e2e-obsolete-msg');
    try {
      await api(`/api/e2e-tests/${encodeURIComponent(e2eTestId)}/obsolete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      closeModal();
      refreshActive();
    } catch (e) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
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
// du test — lus par l'agent de recette dès la création.
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
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  });
}

// --- Cas « Non » : le test n'existe pas → création via session test-agent ---
// Champs minimaux : projet (produit) + titre/comportement. Le spec file et
// scénario seront définis pendant la session test-agent. Les repos de code
// associés (couverture) et les documents de référence (ADR/specs/Gherkin,
// ADR-12) sont choisis dès maintenant (transmis au test-agent).
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
        <fieldset id="ea-docs-fieldset" class="pilot-fieldset">
          <legend>Documents de référence — contexte du test-agent <span class="muted-sm">(ADR technique, User stories + règles métier, scénarios Gherkin). Tous cochés par défaut.</span></legend>
          <div id="ea-docs-list"></div>
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
  const docsFieldset = document.getElementById('ea-docs-fieldset');
  const docsList = document.getElementById('ea-docs-list');
  const projSel = document.getElementById('ea-project');
  docsList.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour afficher ses documents de référence (ADR technique, User stories + règles métier, scénarios Gherkin).</p>';
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
  const renderDocChecks = async () => {
    const KINDS = DOC_KIND_ORDER;
    docsList.innerHTML = KINDS.map(() => `<p class="muted-sm">Chargement des documents de référence…</p>`).join('');
    const pid = projSel.value;
    if (!pid) { docsList.innerHTML = '<p class="muted-sm">Sélectionnez un projet pour lister ses documents de référence.</p>'; return; }
    let docs = [];
    try { const dr = await api(`/api/docs?projectId=${encodeURIComponent(pid)}&includeRepoDocs=1`); docs = dr.docs || []; } catch { docs = []; }
    const byKind = {};
    for (const d of docs) (byKind[d.kind] = byKind[d.kind] || []).push(d);
    docsList.innerHTML = KINDS.map((k) => {
      const items = byKind[k] || [];
      const inner = items.length
        ? `<div style="padding-left:22px">${items.map((d) => `<label class="filter-check"><input type="checkbox" class="ea-doc" data-kind="${esc(k)}" value="${esc(d.docId)}" checked title="${esc(d.path)}"> ${esc(d.title || d.docId)} <span class="muted-sm" style="font-size:11px">${esc(d.path)}</span></label>`).join('')}</div>`
        : `<p class="muted-sm" style="font-size:11px;padding-left:22px">Aucun document enregistré de ce type — ajoutez-le via <em>Projets → 📄 Docs de référence</em>.</p>`;
      return `<div><label class="filter-check"><input type="checkbox" class="ea-kind" data-kind="${esc(k)}" checked> <code class="chip">${esc(docKindLabel(k))}</code> ${esc(docKindLabelLong(k))}</label>${inner}</div>`;
    }).join('');
    bindKindToggle();
  };
  // Coche/décoche tous les docs d'une catégorie quand sa case kind change.
  const bindKindToggle = () => {
    document.querySelectorAll('#modal-backdrop .ea-kind').forEach((cb) => cb.addEventListener('change', () => {
      document.querySelectorAll(`#modal-backdrop .ea-doc[data-kind="${cb.dataset.kind}"]`).forEach((d) => { d.checked = cb.checked; });
    }));
  };
  projSel.addEventListener('change', () => {
    const pid = projSel.value;
    if (pid) projRepoIds[pid] = selectedRepoIds();
    renderRepoChecks(pid);
    renderDocChecks();
  });
  const selectedDocIds = () => [...document.querySelectorAll('#modal-backdrop .ea-doc:checked')].map((c) => c.value);
  document.getElementById('e2e-agent-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('ea-msg');
    const project = document.getElementById('ea-project').value;
    const title = document.getElementById('ea-title').value.trim();
    if (!project || !title) { msg.textContent = 'project et comportement (titre) sont requis.'; msg.className = 'msg error'; return; }
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
        docIds: selectedDocIds(), // toujours un tableau (vide = aucun doc en contexte)
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
    } catch (err) { msg.textContent = err.message || String(err); msg.className = 'msg error'; }
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

// Ouvre la session de recette : reprend la session rattachée si elle existe
// (jamais de doublon) ; `force = true` démarre une nouvelle session.
async function openRecetteSession(recetteId, force) {
  try {
    const r = await api(`/api/recettes/${encodeURIComponent(recetteId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || (force ? 'Impossible de lancer une nouvelle session de recette.' : 'Aucune session de recette disponible.'));
    refreshActive();
  } catch (e) { alert('Échec de la session de recette : ' + (e.message || e)); }
}

function recetteCard(r) {
  const canSession = r.status === 'pending' || r.status === 'in_progress';
  const canFinish = r.status === 'in_progress';
  return `<article class="project-card">
    <div class="project-card-head"><strong class="recette-title" data-rec-detail="${esc(r.recette_id)}" title="Voir le détail">${esc(r.title || r.recette_id)}</strong> <span class="rec-card-projs">${recetteScopeChips(r)}</span> ${badge(r.status)}</div>
    <div class="project-card-body">
      ${r.description ? `<div class="project-kv"><span class="lbl">Description</span><span class="muted-sm">${esc(r.description.slice(0, 100))}${r.description.length > 100 ? '…' : ''}</span></div>` : ''}
      <div class="project-kv"><span class="lbl">Tâches couvertes</span><span>${r.tasks_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Éléments</span><span>${r.items_count || 0}</span></div>
      ${r.confirmed_at ? `<div class="project-kv"><span class="lbl">Confirmée</span><span class="muted-sm">${esc((r.confirmed_at || '').replace('T', ' ').slice(0, 16))}</span></div>` : ''}
    </div>
    <div class="project-card-actions">
      <button class="ghost" data-rec-docs="${esc(r.recette_id)}">Documents (${r.documents_count || 0})</button>
      ${canSession ? `<button class="launch-btn" data-rec-session="${esc(r.recette_id)}" title="${r.session_id ? 'Reprendre la session de recette en cours' : 'Démarrer la session de recette (une recette = une session)'}">Session de la recette</button>` : ''}
      ${canFinish ? `<button class="approve" data-rec-finish="${esc(r.recette_id)}">Terminer la recette</button>` : ''}
      ${r.status === 'done' ? `<button class="ghost" data-rec-items="${esc(r.recette_id)}">Détail de la recette</button>` : ''}
    </div>
  </article>`;
}

async function renderRecettes() {
  const [data, bdata] = await Promise.all([
    api('/api/recettes' + (currentProject ? `?project=${encodeURIComponent(currentProject)}` : '')),
    api('/api/batches' + (currentProject ? `?project=${encodeURIComponent(currentProject)}` : '')).catch(() => ({ batches: [] })),
  ]);
  const recs = data.recettes || [];
  const batches = (bdata.batches || []).filter((b) => b.status === 'active');
  document.getElementById('pane-recettes').innerHTML = `
    <h2>Recettes</h2>
    <p class="muted-sm">Opérations de vérification — chaque recette couvre UN projet (produit) et 0..N tâches de ce projet ; les repos transverses du projet sont sa portée réelle. Titre et session dédiée.</p>
    ${batches.length ? `<div class="actions-section"><h3>Batches d'orchestration actifs <span class="muted-sm">(${batches.length})</span></h3><div class="project-cards">${batches.map(batchCard).join('')}</div></div>` : ''}
    <div class="filters"><button id="new-recette-btn" class="launch-btn">+ Nouvelle recette</button></div>
    <div class="project-cards">${recs.map(recetteCard).join('') || '<p class="muted">Aucune recette.</p>'}</div>`;
  document.getElementById('new-recette-btn').addEventListener('click', () => recetteCreateModal());
  document.querySelectorAll('#pane-recettes [data-rec-session]').forEach((b) => b.addEventListener('click', () => openRecetteSession(b.dataset.recSession, false)));
  document.querySelectorAll('#pane-recettes [data-rec-finish]').forEach((b) => b.addEventListener('click', () => finishRecetteModal(b.dataset.recFinish)));
  document.querySelectorAll('#pane-recettes [data-rec-items]').forEach((b) => b.addEventListener('click', () => recetteDetailItemsModal(b.dataset.recItems)));
  document.querySelectorAll('#pane-recettes [data-rec-docs]').forEach((b) => b.addEventListener('click', () => recetteDocsModal(b.dataset.recDocs)));
  document.querySelectorAll('#pane-recettes [data-rec-detail]').forEach((b) => b.addEventListener('click', () => recetteDetailModal(b.dataset.recDetail)));
  document.querySelectorAll('#pane-recettes [data-batch-session]').forEach((b) => b.addEventListener('click', () => openBatchSession(b.dataset.batchSession)));
  document.querySelectorAll('#pane-recettes [data-batch-detail]').forEach((b) => b.addEventListener('click', () => batchDetailModal(b.dataset.batchDetail)));
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

async function openBatchSession(batchId) {
  try {
    const r = await api(`/api/batches/${encodeURIComponent(batchId)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: false }) });
    if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
    else alert(r.error || 'Impossible de lancer la session d\'orchestration du batch.');
    refreshActive();
  } catch (e) { alert('Échec : ' + (e.message || e)); }
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

// Détail d'une recette en modale (titre court + description longue + périmètre).
async function recetteDetailModal(recetteId) {
  let d;
  try { d = await api(`/api/recettes/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const rec = d.recette || {};
  const tasks = rec.tasks || [];
  const items = rec.items || [];
  const project = rec.project || '';
  showModal(`
    <div class="modal modal-wide">
      <h2>${esc(rec.title || recetteId)}</h2>
      <p class="muted">${badge(rec.status)} · ${recetteScopeChips(rec)}${rec.confirmed_at ? ` · confirmée ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${rec.description ? `<p class="modal-request">${esc(rec.description)}</p>` : ''}
      ${tasks.length ? `<div class="actions-section"><h3>Tâches couvertes (${tasks.length})</h3><div class="recette-list">${tasks.map((t) => {
        const tid = (t && typeof t === 'object') ? (t.taskId || t.task_id || '') : (t || '');
        const ttl = (t && typeof t === 'object') ? (t.title || '') : '';
        const req = (t && typeof t === 'object') ? (t.request || '') : '';
        const tproj = (t && typeof t === 'object') ? (t.project || '') : '';
        return `<div class="recette-item"><code class="muted-sm">${esc(tid)}</code><div class="recette-task">${tproj ? `<code class="chip-project">${esc(tproj)}</code>` : ''}<strong>${esc(ttl)}</strong>${req ? `<p class="muted-sm">${esc(req)}</p>` : ''}</div>${rec.status !== 'done' ? `<button type="button" class="ghost rec-task-del" data-rec-task-del="${esc(tid)}" title="Détacher cette tâche (elle reste intacte)">✕ retirer</button>` : ''}</div>`;
      }).join('')}</div>${rec.status !== 'done' ? `<div class="rec-tasks-add"><select id="rec-task-add"><option value="">+ Ajouter une tâche couverte…</option></select></div>` : ''}</div></div>` : '<p class="muted-sm">Aucune tâche couverte (recette exploratoire).</p>'}
      ${items.length ? `<div class="actions-section"><h3>Éléments (${items.length})</h3><div class="recette-list">${items.map((it) => `<div class="recette-item"><span class="badge ${RECETTE_CLS_BADGE[it.classification] || 'queued'}">${RECETTE_CLS_LABEL[it.classification] || it.classification}</span>${it.project ? `<code class="chip-project">${esc(it.project)}</code>` : ''}${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution">ordre ${esc(it.execOrder)}</span>` : ''}${testIntentBadge(it)}${docIntentBadge(it)}${it.vigilance ? `<span class="badge danger" title="${esc(it.vigilance)}">⚠ vigilance</span>` : ''}<span>${esc(it.title || it.content.slice(0, 80))}</span>${rec.status !== 'done' && it.status !== 'task_created' ? `<button type="button" class="ghost rec-item-del" data-rec-item-del="${it.id}" title="Retirer cet élément (fusion/consolidation)">✕</button>` : ''}</div>`).join('')}</div></div>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  if (rec.status !== 'done') {
    // Gestion des tâches couvertes : ajout (candidates du projet) + retrait.
    const coveredIds = new Set((tasks || []).map((t) => (t && (t.taskId || t.task_id)) || t));
    const taskAddSel = document.getElementById('rec-task-add');
    if (taskAddSel) {
      (async () => {
        try {
          const d = await api(`/api/recettes/candidates?project=${encodeURIComponent(project)}`);
          const cands = (d.candidates || []).filter((c) => !coveredIds.has(c.id));
          taskAddSel.innerHTML = `<option value="">+ Ajouter une tâche couverte…</option>` + cands.map((c) => `<option value="${esc(c.id)}">[${esc(c.project)}] ${esc((c.title || c.request || c.id).slice(0, 70))}</option>`).join('');
        } catch {}
        taskAddSel.addEventListener('change', async () => {
          const t = taskAddSel.value;
          if (!t) return;
          try {
            await api(`/api/recettes/${encodeURIComponent(recetteId)}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: t }) });
            closeModal(); recetteDetailModal(recetteId);
          } catch (e) { alert('Échec : ' + (e.message || e)); taskAddSel.value = ''; }
        });
      })();
    }
    document.querySelectorAll('#modal-backdrop [data-rec-task-del]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/recettes/${encodeURIComponent(recetteId)}/tasks/${encodeURIComponent(b.dataset.recTaskDel)}`, { method: 'DELETE' });
        closeModal(); recetteDetailModal(recetteId);
      } catch (e) { alert('Échec : ' + (e.message || e)); }
    }));
    document.querySelectorAll('#modal-backdrop [data-rec-item-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Retirer cet élément de recette ? (utilisé pour la fusion/consolidation d\'éléments)')) return;
      try {
        await api(`/api/recettes/${encodeURIComponent(recetteId)}/items/${b.dataset.recItemDel}`, { method: 'DELETE' });
        closeModal(); recetteDetailModal(recetteId);
      } catch (e) { alert('Échec : ' + (e.message || e)); }
    }));
  }
}

// Documents d'une recette : liste, ajout (import / artefact), lecture, retrait.
async function recetteDocsModal(recetteId) {
  let d;
  try { d = await api(`/api/recettes/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const rec = d.recette || {};
  const docs = rec.documents || [];
  showModal(`
    <div class="modal modal-wide">
      <h2>Documents de la recette</h2>
      <p class="muted">${esc(rec.title || recetteId)} — <span class="code">${esc(rec.project || '')}</span></p>
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
  document.getElementById('rec-doc-add').onclick = () => recetteDocAddModal(recetteId);
  document.querySelectorAll('#modal-backdrop [data-doc-del]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/recettes/${encodeURIComponent(recetteId)}/documents/${b.dataset.docDel}`, { method: 'DELETE' });
      closeModal(); recetteDocsModal(recetteId);
    } catch (e) { alert('Échec : ' + (e.message || e)); }
  }));
  document.querySelectorAll('#modal-backdrop [data-doc-view]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const v = await api(`/api/recettes/${encodeURIComponent(recetteId)}/documents/${b.dataset.docView}/view`);
      showModal(`<div class="modal modal-wide modal-md"><div class="md-head"><strong>${esc(v.title || 'Document')}</strong></div><div class="md-body markdown-view">${v.html}</div><div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div></div>`);
      document.getElementById('modal-cancel').onclick = closeModal;
    } catch (e) { alert('Impossible d\'ouvrir le document : ' + (e.message || e)); }
  }));
}

async function recetteDocAddModal(recetteId) {
  let arts = [];
  try { arts = ((await api('/api/artifacts')).artifacts || []); } catch {}
  showModal(`
    <div class="modal">
      <h2>Ajouter un document à la recette</h2>
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
      await api(`/api/recettes/${encodeURIComponent(recetteId)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      recetteDocsModal(recetteId);
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  });
}

async function recetteCreateModal() {
  let projects = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  const projOptions = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') || '<option value="">— aucun projet enregistré —</option>';
  showModal(`
    <div class="modal modal-wide">
      <h2>Nouvelle recette</h2>
      <form id="recette-modal-form" class="pilot-form">
        <fieldset class="pilot-fieldset">
          <legend>Projet <span class="muted-sm">(1 recette = 1 projet produit — ses repos transverses sont la portée réelle, ADR 11)</span></legend>
          <select id="rm-project">${projOptions}</select>
          <div id="rm-repos-hint" class="muted-sm" style="margin-top:6px"></div>
          <button type="button" class="ghost" id="rm-load-cands">Charger les tâches disponibles</button>
        </fieldset>
        <fieldset id="rm-docs-ref-fieldset" class="pilot-fieldset">
          <legend>Documents de référence — contexte de l'agent de recette <span class="muted-sm">(ADR technique, User stories + règles métier, scénarios Gherkin — ADR-12). Tous cochés par défaut.</span></legend>
          <div id="rm-docs-ref-list"><p class="muted-sm">Choisissez un projet pour afficher ses documents de référence.</p></div>
        </fieldset>
        <input id="rm-title" placeholder="titre court (ex: Recette du module chatbot)" required>
        <textarea id="rm-description" class="modal-textarea" placeholder="description longue (détail du périmètre vérifié) — optionnel"></textarea>
        <label class="modal-field">Tâches couvertes <span class="muted-sm">(0..N — tâches non encore recettées du projet)</span></label>
        <div id="rm-candidates" class="recette-candidates"><p class="muted-sm">Choisissez un projet puis « Charger les tâches disponibles ».</p></div>
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
  const projectSel = document.getElementById('rm-project');
  const reposHint = document.getElementById('rm-repos-hint');
  const currentProject = () => projectSel.value;
  const kept = new Set(); // tâches déjà cochées, conservées entre rechargements
  const loadCandidates = async () => {
    const proj = currentProject();
    candBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    if (!proj) { candBox.innerHTML = '<p class="muted-sm">Choisissez un projet.</p>'; return; }
    try {
      const d = await api(`/api/recettes/candidates?project=${encodeURIComponent(proj)}`);
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
  const refDocsBox = document.getElementById('rm-docs-ref-list');
  const selectedRefDocIds = () => [...document.querySelectorAll('#modal-backdrop .rm-refdoc:checked')].map((c) => c.value);
  const renderRefDocs = (docs) => {
    const KINDS = DOC_KIND_ORDER;
    const byKind = {};
    for (const d of docs) (byKind[d.kind] = byKind[d.kind] || []).push(d);
    refDocsBox.innerHTML = KINDS.map((k) => {
      const items = byKind[k] || [];
      const inner = items.length
        ? `<div style="padding-left:22px">${items.map((d) => `<label class="filter-check"><input type="checkbox" class="rm-refdoc" data-kind="${esc(k)}" value="${esc(d.docId)}" checked title="${esc(d.path)}"> ${esc(d.title || d.docId)} <span class="muted-sm" style="font-size:11px">${esc(d.path)}</span></label>`).join('')}</div>`
        : `<p class="muted-sm" style="font-size:11px;padding-left:22px">Aucun document enregistré de ce type pour ce projet — ajoutez-le via <em>Projets → 📄 Docs de référence</em>.</p>`;
      return `<div><label class="filter-check"><input type="checkbox" class="rm-refkind" data-kind="${esc(k)}" checked> <code class="chip">${esc(docKindLabel(k))}</code> ${esc(docKindLabelLong(k))}</label>${inner}</div>`;
    }).join('');
    document.querySelectorAll('#modal-backdrop .rm-refkind').forEach((cb) => cb.addEventListener('change', () => {
      document.querySelectorAll(`#modal-backdrop .rm-refdoc[data-kind="${cb.dataset.kind}"]`).forEach((d) => { d.checked = cb.checked; });
    }));
  };
  const loadRefDocs = async () => {
    const proj = currentProject();
    if (!proj) { refDocsBox.innerHTML = '<p class="muted-sm">Choisissez un projet pour afficher ses documents de référence.</p>'; return; }
    refDocsBox.innerHTML = '<p class="muted-sm">Chargement des documents de référence…</p>';
    const seen = new Map();
    try {
      const d = await api(`/api/docs?projectId=${encodeURIComponent(proj)}&includeRepoDocs=1`);
      for (const doc of (d.docs || [])) if (!seen.has(doc.docId)) seen.set(doc.docId, doc);
    } catch {}
    renderRefDocs([...seen.values()]);
  };
  const renderReposHint = () => {
    const proj = projects.find((p) => p.id === currentProject());
    const repos = (proj && proj.repos) || [];
    reposHint.innerHTML = repos.length
      ? `Repos transverses du projet (portée réelle) : ${repos.map((r) => `<code class="chip-repo">${esc(r.repoId || r)}</code>`).join(' ')}`
      : 'Aucun repo rattaché à ce projet.';
  };
  projectSel.addEventListener('change', () => {
    candBox.innerHTML = '<p class="muted-sm">Choisissez un projet puis « Charger les tâches disponibles ».</p>';
    renderReposHint();
    loadRefDocs();
  });
  renderReposHint();

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

  document.getElementById('recette-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('recette-modal-msg');
    try {
      const proj = currentProject();
      if (!proj) throw new Error('Choisissez un projet.');
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
      await api('/api/recettes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: proj,
        title: document.getElementById('rm-title').value.trim(),
        description: document.getElementById('rm-description').value.trim() || undefined,
        taskIds,
        documents,
        docIds: selectedRefDocIds(), // toujours un tableau (vide = aucun doc en contexte)
        organizationId: currentOrg || undefined,
      }) });
      closeModal();
      refreshActive();
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  });
}

// Modal de recette (items) : 'finish' = clôture avec confirmation (in_progress) ;
// 'detail' = lecture seule (recette terminée) — même présentation, sans action de clôture.
async function recetteItemsModal(recetteId, mode = 'finish') {
  const readOnly = mode === 'detail';
  let d;
  try { d = await api(`/api/recettes/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const rec = d.recette || {};
  const items = rec.items || [];
  const itemCard = (it) => {
    const full = it.content || '';
    const truncated = full.length > 120;
    const show = truncated ? full.slice(0, 120) + '…' : full;
    return `<div class="recette-item finish-item">
      <span class="badge ${RECETTE_CLS_BADGE[it.classification] || 'queued'}">${RECETTE_CLS_LABEL[it.classification] || it.classification}</span>
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
    </div>`;
  };
  const intro = readOnly
    ? (items.length
      ? '<p>Éléments relevés lors de la recette (lecture seule) :</p>'
      : '<p class="muted-sm">Aucun élément relevé.</p>')
    : (items.length
      ? '<p>Éléments relevés — ils seront transformés en <strong>nouvelles tâches</strong> (titre + demande + critère d\'acceptation) :</p>'
      : '<p class="muted-sm">Aucun élément relevé : la recette sera clôturée sans créer de tâche.</p>');
  const launchModeBlock = readOnly ? '' : `
    <fieldset class="pilot-fieldset" style="margin-top:12px">
      <legend>Lancement des tâches créées</legend>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><input type="radio" name="rec-launch-mode" value="batch" checked style="margin-top:2px"><span><strong>Batch</strong> — le worker lance automatiquement les tâches prêtes (≤ maxParallel), chacune avec sa session.</span></label>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><input type="radio" name="rec-launch-mode" value="session" style="margin-top:2px"><span><strong>Session unique</strong> — une session d'orchestration pilote tout le batch (ordonnancement + préparation croisée).</span></label>
      <label class="filter-check" style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="rec-launch-mode" value="manual" style="margin-top:2px"><span><strong>Manuel</strong> — aucun auto-lancement : tu pilotes chaque tâche toi-même, comme avant.</span></label>
    </fieldset>`;
  showModal(`
    <div class="modal modal-wide modal-finish" id="finish-modal">
      <div class="finish-head"><h2 style="margin:0">${readOnly ? 'Détail de la recette' : 'Terminer la recette'}</h2>
        <button class="ghost" id="finish-fullscreen" title="Plein écran">⛶</button></div>
      <p class="muted">${esc(rec.title || recetteId)} — ${recetteScopeChips(rec)}${readOnly && rec.confirmed_at ? ` · clôturée le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${intro}
      ${items.length ? `<div class="recette-list">${items.map(itemCard).join('')}</div>` : ''}
      ${launchModeBlock}
      <div class="modal-actions">
        ${readOnly
          ? '<button class="ghost" id="modal-cancel">Fermer</button>'
          : '<button class="ghost" id="modal-cancel">Annuler</button><button class="approve" id="modal-confirm">Confirmer & terminer</button>'}
      </div>
      <div id="recette-finish-msg" class="msg"></div>
    </div>`);
  const finishModal = document.getElementById('finish-modal');
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('finish-fullscreen').onclick = () => {
    const fs = finishModal.classList.toggle('finish-full');
    document.getElementById('finish-fullscreen').textContent = fs ? '⤢ rétrécir' : '⛶ plein écran';
  };
  finishModal.querySelectorAll('.finish-more').forEach((b) => b.addEventListener('click', () => {
    const p = b.parentElement.querySelector('.finish-desc');
    const full = p.dataset.full || '';
    const collapsed = p.textContent.endsWith('…');
    p.textContent = collapsed ? full : (full.slice(0, 120) + '…');
    b.textContent = collapsed ? 'Réduire' : 'Voir en entier';
  }));
  if (readOnly) return;
  document.getElementById('modal-confirm').onclick = async () => {
    const msg = document.getElementById('recette-finish-msg');
    try {
      const payload = items.map((it) => ({ itemId: it.id, content: it.content, classification: it.classification, title: it.title, acceptance: it.acceptance, scope: it.scope }));
      const launchMode = (document.querySelector('input[name="rec-launch-mode"]:checked') || {}).value || 'batch';
      const r = await api(`/api/recettes/${encodeURIComponent(recetteId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: payload, launchMode }) });
      msg.textContent = r.created && r.created.length
        ? 'Tâches créées : ' + r.created.map((c) => `${c.taskId} (${RECETTE_CLS_LABEL[c.classification]})`).join(', ')
        : 'Recette terminée (aucune tâche créée).';
      msg.className = 'msg ok';
      closeModal();
      const modeLabel = { batch: 'Batch', session: 'Session unique', manual: 'Manuel' }[launchMode] || launchMode;
      alert(`${msg.textContent}\nMode de lancement : ${modeLabel}`);
      refreshActive();
    } catch (e) { msg.textContent = e.message || e; msg.className = 'msg error'; }
  };
}

function finishRecetteModal(recetteId) { return recetteItemsModal(recetteId, 'finish'); }
function recetteDetailItemsModal(recetteId) { return recetteItemsModal(recetteId, 'detail'); }

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
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
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
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/restore`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
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
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/delete`, { method: 'POST' });
      closeModal();
      refreshActive();
    } catch (e) {
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
    <button class="ghost eco-model-btn" data-edit-model="${esc(a.name)}" data-model="${esc(a.model || '')}">Modifier</button>
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
  const projectsList = (w) => (w.projects || []).filter((p) => p.isDir).map((p) => `<code class="chip-repo">${esc(p.name)}</code>`).join(' ');
  const ideBadge = (w) => w.ideUrl ? `<a class="badge running ws-ide" href="${esc(w.ideUrl)}" target="_blank" rel="noopener" title="Ouvrir l'IDE web Coder">IDE</a>` : '';
  document.getElementById('pane-workspaces').innerHTML = `
    <h2>Workspaces Coder <span class="muted-sm">— ${wsList.length} workspace(s)</span></h2>
    <div class="eco-restart-bar"><button class="launch-btn" id="ws-create-btn">Créer un workspace</button><span id="ws-msg" class="muted-sm"></span></div>
    <table><thead><tr><th>Workspace</th><th>Propriétaire</th><th>Statut</th><th>IDE</th><th>Conteneur</th><th>Volume</th><th>Projets</th><th>Actions</th></tr></thead>
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
      <td>${projectsList(w) || '<span class="muted-sm">—</span>'}</td>
      <td class="icon-actions">
        <button class="ghost tiny" data-ws-detail="${esc(w.name)}" data-ws-ide="${esc(w.ideUrl || '')}" title="Détails du workspace">Détail</button>
        ${running
          ? `<button class="ghost tiny" data-ws-stop="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Arrêter le workspace">Stop</button>
             <button class="ghost tiny" data-ws-restart="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Redémarrer le workspace">Restart</button>`
          : `<button class="ghost tiny" data-ws-start="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Démarrer le workspace">Start</button>`}
        <button class="danger tiny" data-ws-delete="${esc(w.name)}" ${busy ? 'disabled' : ''} title="Supprimer le workspace">Supprimer</button>
      </td>
    </tr>`;
    }).join('')}</tbody></table>`;
  // Événements
  document.getElementById('ws-create-btn').addEventListener('click', () => workspaceCreateModal());
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

// Indication visuelle sur le bouton cliqué : désactivé + spinner + libellé "…".
function setWSActionBusy(btn, action) {
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('ws-busy');
  btn.innerHTML = `<span class="ws-spinner"></span> ${esc(action)}…`;
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
  const ideBtn = ideUrl ? `<a class="badge running ws-ide" href="${esc(ideUrl)}" target="_blank" rel="noopener" style="margin-left:8px">Ouvrir l'IDE</a>` : '';
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
    const msg = document.getElementById('ws-create-msg');
    const org = document.getElementById('ws-create-org').value;
    const name = document.getElementById('ws-create-name').value.trim();
    if (!name) { msg.textContent = 'Nom requis'; return; }
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
    } catch (e) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  });
}

// Redémarrage de TOUTES les instances systemd opencode (admin) — recharge la
// config des agents sur chaque instance opencode@<user>.service + opencode.service.
async function restartAllOpencodeSessions() {
  if (!confirm('Redémarrer toutes les sessions opencode ?\nChaque instance systemd opencode@<user>.service (et opencode.service) sera relancée. Les sessions en cours seront interrompues.')) return;
  const btn = document.getElementById('eco-restart-all');
  const msg = document.getElementById('eco-restart-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'redémarrage…'; }
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
    if (btn) { btn.disabled = false; btn.textContent = 'Redémarrer toutes les sessions opencode'; }
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
    const model = document.getElementById('agent-model-select').value;
    const msg = document.getElementById('model-msg');
    try {
      await api(`/api/agents/${encodeURIComponent(name)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      closeModal();
      refreshActive();
    } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; }
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
            <button class="ghost" data-open-project="${esc(p.id)}" title="Ouvrir le projet : tâches, recettes, tests E2E, déploiements, décisions, plans, archives…">Ouvrir</button>
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
// Documents de référence (ajouter/voir/supprimer). Aucune sous-modale.
// ===========================================================================
async function projectDetailModal(projectId, tab = 'projet') {
  let projects = [], repos = [], allDocs = [];
  try { projects = ((await api('/api/projects')).projects || []); } catch {}
  try { repos = ((await api(`/api/repos?project=${encodeURIComponent(projectId)}`)).repos || []); } catch {}
  const p0 = projects.find((x) => x.id === projectId);
  if (!p0) { alert('Projet introuvable'); return; }

  const loadDocs = async () => {
    try { allDocs = ((await api(`/api/docs?projectId=${encodeURIComponent(projectId)}&includeRepoDocs=1`)).docs || []); }
    catch { allDocs = []; }
  };
  await loadDocs();

  const kindOpts = `<option value="adr-tech">ADR — Architecture technique</option><option value="specs-fonctionnelles">Specs fonctionnelles</option><option value="scenarios-gherkin">Scénarios (Gherkin)</option>`;
  const repoMap = () => new Map(repos.map((r) => [r.id, r]));

  const render = () => {
    const p = projects.find((x) => x.id === projectId) || p0;
    const rm = repoMap();
    const pRepos = (p.repos || []).map((rid) => rm.get(rid)).filter(Boolean);
    const pDocs = allDocs;
    const tabs = [
      ['projet', 'Projet'],
      ['repos', `Repos (${pRepos.length})`],
      ['docs', `Documents (${pDocs.length})`],
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
    else panel.innerHTML = docsTabHtml(p, pDocs);
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

  // --- Onglet DOCUMENTS : ajouter / voir / supprimer ------------------------
  const docsTabHtml = (p, pDocs) => {
    const rm = repoMap();
    const targets = [{ v: 'project:' + p.id, l: 'Projet ' + (p.name || p.id) }, ...(p.repos || []).map((rid) => { const r = rm.get(rid); return { v: 'repo:' + rid, l: 'Repo ' + (r ? (r.name || r.id) : rid) }; })];
    return `
      <p class="muted-sm">ADR-12 — documents (adr-tech / specs-fonctionnelles / scenarios-gherkin) fournis en contexte aux agents. Importez un fichier ou référencez un chemin existant.</p>
      <div id="pd-list" class="recette-list" style="max-height:30vh;overflow:auto">
        ${pDocs.length ? pDocs.map((d) => `<div class="recette-item">
          <div><code class="chip">${esc(docKindLabel(d.kind))}</code> <strong>${esc(d.title || d.docId)}</strong>
            <span class="muted-sm">${d.projects && d.projects.length ? '· projets ' + esc(d.projects.join(', ')) : ''}${d.repos && d.repos.length ? '· repos ' + esc(d.repos.join(', ')) : ''}</span></div>
          <div class="muted-sm">${esc(d.path)}</div>
          <div class="e2e-actions"><button type="button" class="ghost tiny" data-pd-view-doc="${esc(d.docId)}">Regarder</button><button type="button" class="ghost tiny danger-text" data-pd-del-doc="${esc(d.docId)}">Supprimer</button></div>
        </div>`).join('') : '<p class="muted-sm">Aucun document de référence.</p>'}
      </div>
      <form id="pd-doc-form" class="pilot-form" style="border-top:1px solid var(--border);padding-top:10px">
        <div class="pd-inline">
          <select id="pd-d-kind">${kindOpts}</select>
          <select id="pd-d-target">${targets.map((t) => `<option value="${esc(t.v)}">${esc(t.l)}</option>`).join('')}</select>
        </div>
        <input id="pd-d-title" placeholder="titre (ex. ADR — Architecture madatalk)">
        <div class="pd-inline">
          <select id="pd-d-mode"><option value="upload">Importer depuis mon PC</option><option value="path">Référencer un chemin</option></select>
          <input id="pd-d-file" type="file" accept=".md,.markdown,.txt,.feature,.adoc">
          <input id="pd-d-path" placeholder="chemin existant (ex. /home/coder/mada-talk/docs/adr.md)" hidden>
        </div>
        <div class="actions-buttons"><button type="submit" class="launch-btn">+ Ajouter le document</button></div>
      </form>`;
  };

  // --- Wiring des actions (re-render après chaque mutation) -----------------
  const wire = () => {
    const panel = document.getElementById('pd-panel');
    // PROJET : enregistrer / supprimer.
    const pForm = document.getElementById('pd-projet-form');
    if (pForm) pForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p0.id, name: document.getElementById('pd-p-name').value.trim() }) });
        projects = ((await api('/api/projects')).projects || []);
        msg('Projet enregistré.'); render();
      } catch (err) { msg(err.message || String(err), false); }
    });
    const pDel = document.getElementById('pd-p-del');
    if (pDel) pDel.addEventListener('click', async () => {
      if (!confirm(`Supprimer le projet ${p0.id} ? Les tâches conservent leur référence.`)) return;
      try { await api(`/api/projects/${encodeURIComponent(p0.id)}`, { method: 'DELETE' }); closeModal(); refreshActive(); }
      catch (err) { msg(err.message || String(err), false); }
    });
    // REPOS : associer / retirer / éditer / créer.
    const linkGo = document.getElementById('pd-link-go');
    if (linkGo) linkGo.addEventListener('click', async () => {
      const repoId = document.getElementById('pd-link-repo').value;
      const role = document.getElementById('pd-link-role').value.trim() || undefined;
      const gitTokenIdEl = document.getElementById('pd-link-git-token');
      const gitTokenId = gitTokenIdEl && gitTokenIdEl.value.trim() || undefined;
      try {
        await api(`/api/projects/${encodeURIComponent(p0.id)}/repos/${encodeURIComponent(repoId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, gitTokenId }) });
        await refreshDetailData();
        const rr = repoMap().get(repoId);
        if (rr && !rr.workspace) {
          msg('Repo associé — aucun workspace Coder : provisionnement possible.');
          if (IS_ADMIN) provisionRepoModal(rr, { projectId: p0.id, gitTokenId, onProvisioned: async (pr) => { await refreshDetailData(); render(); msg('Repo associé et workspace provisionné : ' + pr.workspace); } });
        } else { msg('Repo associé.'); render(); }
      } catch (err) { msg(err.message || String(err), false); }
    });
    panel.querySelectorAll('[data-pd-unlink-repo]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Retirer le repo ${b.dataset.pdUnlinkRepo} du projet ? Le repo reste enregistré.`)) return;
      try {
        await api(`/api/projects/${encodeURIComponent(p0.id)}/repos/${encodeURIComponent(b.dataset.pdUnlinkRepo)}`, { method: 'DELETE' });
        await refreshDetailData(); msg('Repo retiré.'); render();
      } catch (err) { msg(err.message || String(err), false); }
    }));
    panel.querySelectorAll('[data-pd-edit-repo]').forEach((b) => b.addEventListener('click', () => editRepoInline(b.dataset.pdEditRepo)));
    panel.querySelectorAll('[data-pd-provision-repo]').forEach((b) => b.addEventListener('click', () => {
      const rr = repoMap().get(b.dataset.pdProvisionRepo); if (!rr) return;
      provisionRepoModal(rr, { projectId: p0.id, gitTokenId: b.dataset.pdProvisionGitToken || undefined, onProvisioned: async (pr) => { await refreshDetailData(); render(); msg('Workspace provisionné : ' + pr.workspace + ' · ' + (pr.repoDir || '')); } });
    }));
    const rForm = document.getElementById('pd-repo-form');
    if (rForm) rForm.addEventListener('submit', async (e) => {
      e.preventDefault();
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
      } catch (err) { msg(err.message || String(err), false); }
    });
    // DOCUMENTS : ajouter / voir / supprimer.
    const dMode = document.getElementById('pd-d-mode');
    if (dMode) {
      const fileEl = document.getElementById('pd-d-file');
      const pathEl = document.getElementById('pd-d-path');
      const sync = () => { const up = dMode.value === 'upload'; fileEl.hidden = !up; pathEl.hidden = up; fileEl.required = up; pathEl.required = !up; };
      dMode.addEventListener('change', sync); sync();
    }
    const dForm = document.getElementById('pd-doc-form');
    if (dForm) dForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const [tt, tid] = document.getElementById('pd-d-target').value.split(':');
        const body = { kind: document.getElementById('pd-d-kind').value, title: document.getElementById('pd-d-title').value.trim() || undefined, organizationId: currentOrg || undefined };
        if (tt === 'project') body.projectId = tid; else body.repoId = tid;
        if (dMode.value === 'upload') {
          const f = document.getElementById('pd-d-file').files[0];
          if (!f) throw new Error('Choisissez un fichier.');
          if (f.size > 2 * 1024 * 1024) throw new Error('Fichier trop volumineux (max 2 Mo).');
          const buf = await f.arrayBuffer();
          body.filename = f.name; body.dataBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        } else {
          body.path = document.getElementById('pd-d-path').value.trim();
          if (!body.path) throw new Error('Chemin requis.');
        }
        await api('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await loadDocs(); msg('Document enregistré.'); render();
      } catch (err) { msg(err.message || String(err), false); }
    });
    panel.querySelectorAll('[data-pd-view-doc]').forEach((b) => b.addEventListener('click', () => viewRefDoc(b.dataset.pdViewDoc)));
    panel.querySelectorAll('[data-pd-del-doc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce document de référence ?')) return;
      try { await api(`/api/docs/${encodeURIComponent(b.dataset.pdDelDoc)}`, { method: 'DELETE' }); await loadDocs(); msg('Document supprimé.'); render(); }
      catch (err) { msg(err.message || String(err), false); }
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
      } catch (err) { msg(err.message || String(err), false); }
    });
  };

  const refreshDetailData = async () => {
    try { projects = ((await api('/api/projects')).projects || []); } catch {}
    try { repos = ((await api('/api/repos')).repos || []); } catch {}
    await loadDocs();
  };

  render();
}

// Libellé court d'un kind de document (ADR-12).
function docKindLabel(kind) {
  return { 'adr-tech': 'ADR tech', 'specs-fonctionnelles': 'Specs fonct.', 'scenarios-gherkin': 'Gherkin' }[kind] || kind;
}
function docKindLabelLong(kind) {
  return { 'adr-tech': 'ADR — Architecture technique', 'specs-fonctionnelles': 'Spécifications fonctionnelles (User stories / règles métier)', 'scenarios-gherkin': 'Scénarios (Gherkin)' }[kind] || kind;
}
const DOC_KIND_ORDER = ['adr-tech', 'specs-fonctionnelles', 'scenarios-gherkin'];

// Lecture du contenu d'un document de référence (ADR-12) par docId : rendu
// markdown / feature / texte brut. Fonctionne pour tout doc (importé OU référencé
// par chemin dans le workspace).
async function viewRefDoc(docId) {
  try {
    const d = await api(`/api/docs/${encodeURIComponent(docId)}/content`);
    const html = d.html
      ? `<div style="background:rgba(255,255,255,.04);padding:14px;border-radius:8px;max-height:70vh;overflow:auto">${d.html}</div>`
      : `<pre style="background:rgba(255,255,255,.04);padding:14px;border-radius:8px;max-height:70vh;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px">${esc(d.raw || '')}</pre>`;
    const kindTag = d.kind ? `<code class="chip">${esc(docKindLabel(d.kind))}</code> ` : '';
    showModal(`<div class="modal modal-wide"><h3>${kindTag}${esc(d.title || 'Document')}</h3><p class="muted-sm">${esc(d.path || '')}</p>${html}<div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div></div>`);
    document.getElementById('modal-cancel').onclick = closeModal;
  } catch (e) { alert('Lecture impossible : ' + (e.message || e)); }
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
    const btn = e.target.querySelector('button[type=submit]');
    const msgEl = document.getElementById('prov-msg');
    btn.disabled = true;
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
      btn.disabled = false;
    }
  });
}

// Modale documents de référence (ADR-12) d'un projet ou d'un repo : liste les
// docs + ajout (kind/titre/chemin) rattaché à un projet ou un repo.
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
    } catch (err) { msg.textContent = err.message || String(err); msg.className = 'msg error'; }
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
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  });
}

async function taskActionsModal(taskId) {
  let detail;
  try { detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`); }
  catch (e) { alert(e.message); return; }
  const task = detail.task || {};
  const execs = detail.executions || [];
  const status = execs[0]?.status || task.status || 'queued';
  const recette = task.recette_status || 'pending';
  const decisions = detail.decisions || [];
  // Décisions humaines ACTIONNABLES = awaiting sans permission_id (canal B :
  // besoin/prérequis/validation demandés par un agent) — les permissions d'outil
  // (permission_id présent) restent résolues dans la session de l'agent.
  // Une tâche `done` n'a PLUS d'attente humaine : on ne propose aucune action.
  const awaiting = status === 'done' ? [] : decisions.filter((d) => d.status === 'awaiting' && d.kind !== 'recette' && !d.permission_id);
  const linked = detail.linkedTasks || [];

  showModal(`
    <div class="modal modal-wide">
      <h2>Actions — <span class="code">${esc(taskId)}</span></h2>
      <p class="muted-sm"><strong>Titre :</strong> ${esc((task.title && task.title.trim()) ? task.title : '—')}</p>
      <div class="modal-request">${esc(task.request || '—')}</div>
      ${(() => { let c = ''; try { const a = typeof task.acceptance_criteria === 'string' ? JSON.parse(task.acceptance_criteria) : (task.acceptance_criteria || []); c = Array.isArray(a) ? a.join(' · ') : String(a || ''); } catch { c = String(task.acceptance_criteria || ''); } return c ? `<p class="muted-sm"><strong>Critère d'acceptation :</strong> ${esc(c)}</p>` : ''; })()}
      <p class="muted-sm">Projet <span class="code">${esc(task.project)}</span> · Type <span class="code">${esc(task.type)}</span> · ${badge(status)} · Recette ${recetteBadge(recette)}</p>
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

      ${status === 'done' ? recetteSectionHtml(recette, detail) : ''}

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
          <button class="ghost" data-goto="artifacts">Documents</button>
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
  const recetteSession = document.getElementById('act-recette-session');
  if (recetteSession) recetteSession.onclick = () => openRecetteSession(recetteSession.dataset.recId, false);
  const recetteFinish = document.getElementById('act-recette-finish');
  if (recetteFinish) recetteFinish.onclick = () => { closeModal(); finishRecetteModal(recetteFinish.dataset.recId); };
  const recetteDetail = document.getElementById('act-recette-detail');
  if (recetteDetail) recetteDetail.onclick = () => { closeModal(); recetteDetailItemsModal(recetteDetail.dataset.recId); };
  const archive = document.getElementById('act-archive');
  if (archive) archive.onclick = () => { closeModal(); openArchiveConfirm(taskId); };
  document.querySelectorAll('#modal-backdrop [data-goto-task]').forEach((b) => b.addEventListener('click', () => { const tid = b.dataset.gotoTask; closeModal(); taskActionsModal(tid); refreshActive(); }));
  const consumption = document.getElementById('act-consumption');
  if (consumption) consumption.onclick = () => { closeModal(); renderConsumptionModal(taskId); };
  const kill = document.getElementById('act-kill');
  if (kill) kill.onclick = () => {
    if (!confirm('Arrêter la session ? (process arrêté — la session reste consultable — tâche abandonnée)')) return;
    closeModal();
    api(`/api/tasks/${encodeURIComponent(taskId)}/kill-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then((r) => { alert('Session arrêtée.' + (r.aborted ? ' Tâche abandonnée.' : '')); refreshActive(); })
      .catch((e) => alert('Échec : ' + (e.message || e)));
  };
  const relaunch = document.getElementById('act-relaunch');
  if (relaunch) relaunch.onclick = () => {
    if (!confirm('Relancer la tâche ? (réinitialisation + nouvelle session orchestrateur)')) return;
    closeModal();
    api(`/api/tasks/${encodeURIComponent(taskId)}/relaunch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then((r) => { alert('Tâche relancée : ' + (r.sessionId || '—')); refreshActive(); })
      .catch((e) => alert('Échec : ' + (e.message || e)));
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
      try {
        await resolveDecision(decisionId, st, resolution);
        closeModal();
        refreshActive();
      } catch (err) { alert('Échec : ' + (err.message || err)); }
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
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
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
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/launch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      closeModal();
      alert('Session lancée : ' + (r.sessionId || '—'));
      refreshActive();
    } catch (e) { alert('Échec du lancement : ' + (e.message || e)); }
  };
}

async function reworkTaskModal(taskId) {
  // Bug 5/6 — préremplir la session courante et les remarques (rejet de recette).
  let latestSession = '';
  let defaultRemarks = '';
  try {
    const d = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    const sessions = (d.sessions && d.sessions.length) ? d.sessions : [];
    if (sessions.length) latestSession = sessions[sessions.length - 1].sessionId || '';
    const rejectedRecette = (d.decisions || []).filter((x) => x.kind === 'recette' && x.status === 'rejected');
    if (rejectedRecette.length) defaultRemarks = rejectedRecette[rejectedRecette.length - 1].resolution || '';
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
    } catch (e) { alert('Échec de la reprise : ' + (e.message || e)); }
  };
}

// --- Recette (v0.7.0) : section + clôture -----------------------------------
const RECETTE_CLS_LABEL = { rework: 'Rework', bug: 'Bug', improvement: 'Improvement', feature: 'Feature' };
const RECETTE_CLS_BADGE = { rework: 'danger', bug: 'danger', improvement: 'approve', feature: 'ghost' };

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

function recetteItemRow(it) {
  return `<div class="recette-item">
    <code class="muted-sm">#${it.id || it.itemId}</code>
    <span class="badge ${RECETTE_CLS_BADGE[it.classification] || 'queued'}">${RECETTE_CLS_LABEL[it.classification] || it.classification}</span>
    ${it.project ? `<code class="chip-project">${esc(it.project)}</code>` : ''}
    ${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution (même numéro = parallèle)">ordre ${esc(it.execOrder)}</span>` : ''}
    ${testIntentBadge(it)}
    ${docIntentBadge(it)}
    ${it.vigilance ? `<span class="badge danger" title="Point de vigilance / écart sémantique : ${esc(it.vigilance)}">⚠ vigilance</span>` : ''}
    <span>${esc(it.content)}</span>
    ${it.status === 'task_created' && it.created_task_id ? `<code class="muted-sm">→ ${esc(it.created_task_id)}</code>` : ''}
  </div>`;
}

function recetteSectionHtml(recetteStatus, detail) {
  const rec = detail && detail.recette;
  if (!rec) {
    return `<div class="actions-section"><h3>Recette</h3>
      <p class="muted-sm">Cette tâche n'est couverte par aucune recette. Créez une recette (onglet <a href="#" onclick="goToTab('recettes'); return false;">Recettes</a>) pour couvrir plusieurs tâches d'un même périmètre (1 recette = 1 projet).</p>
    </div>`;
  }
  const st = rec.status;
  const title = rec.title || rec.recetteId;
  const items = rec.items || [];
  const btns = (st === 'in_progress' || st === 'pending') ? `
    <div class="actions-buttons">
      <button class="launch-btn" id="act-recette-session" data-rec-id="${esc(rec.recetteId)}" title="${rec.sessionId ? 'Reprendre la session de recette en cours' : 'Démarrer la session de recette (une recette = une session)'}">Session de la recette</button>
      ${st === 'in_progress' ? `<button class="approve" id="act-recette-finish" data-rec-id="${esc(rec.recetteId)}">Terminer la recette</button>` : ''}
    </div>` : (st === 'done' ? `
    <div class="actions-buttons">
      <button class="ghost" id="act-recette-detail" data-rec-id="${esc(rec.recetteId)}">Détail de la recette</button>
    </div>` : '');
  const statusTxt = st === 'done' ? `faite${rec.confirmed_at ? ` le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}` : RECETTE_STATUS_LABEL[st] || st;
  return `<div class="actions-section"><h3>Recette — ${statusTxt}</h3>
    <p class="muted-sm"><strong>${esc(title)}</strong> ${recetteScopeChips(rec)}</p>
    ${items.length ? `<div class="recette-list">${items.map(recetteItemRow).join('')}</div>` : '<p class="muted-sm">Aucun élément relevé.</p>'}
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
    const [summary, statusData, throughputData, leadtimeData, agentsData, costsData, phasesData, blockedData, successfailureData, hardeningData, qualityData, reworkData, cvtData, recetteData] = await Promise.all([
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
      api('/api/metrics/recette'),
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
        ${kpiCard('Success Rate', (summary.successRate ?? 0) + ' %', `${summary.successCount}/${summary.completed} done + recette approuvée`)}
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
        <h3>Recette (v0.7) — éléments détectés &amp; tâches générées</h3>
        <div class="kpi-grid">
          ${kpiCard('Recettes', (summary.recette?.statuses || []).reduce((a, s) => a + s.count, 0), 'opérations')}
          ${kpiCard('En cours', (summary.recette?.statuses || []).find((s) => s.status === 'in_progress')?.count || 0, 'recette active')}
          ${kpiCard('Éléments détectés', summary.recette?.itemsTotal || 0, 'remarques/constats')}
          ${kpiCard('Tâches générées', summary.recette?.tasksGenerated || 0, 'issues de recette')}
          ${kpiCard('Durée moyenne', fmtMin(summary.recette?.avgDurationMin), 'par recette')}
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
      // Phase D — recette : éléments par classification + tâches générées.
      const recByClass = summary.recette?.byClass || { rework: 0, bug: 0, improvement: 0, feature: 0 };
      const recGen = summary.recette?.byGeneratedClass || { rework: 0, bug: 0, improvement: 0, feature: 0 };
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
    try { await api(`/api/e2e-vars?project=${encodeURIComponent(selected)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' }); refreshActive(); }
    catch (e) { alert('Échec suppression : ' + (e.message || e)); }
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
    msg.textContent = isEdit ? 'Remplacement…' : 'Création…';
    msg.className = 'msg';
    try {
      await api('/api/e2e-vars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeModal();
      refreshActive();
    } catch (e) { msg.textContent = e.message || String(e); msg.className = 'msg error'; }
  });
}

const RENDER = {
  overview: renderOverview, observability: renderObservability, projects: renderProjects, tasks: renderTasks, e2etests: renderE2ETests, e2esecrets: renderE2ESecrets, recettes: renderRecettes,
  events: renderEvents, deployments: renderDeployments, decisions: renderDecisions, artifacts: renderArtifacts, plans: renderPlans, archives: renderArchives, ecosystem: renderEcosystem, workspaces: renderWorkspaces, users: renderUsers,
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
    document.getElementById('whoami').textContent = ME.username + (ME.is_admin ? ' (admin)' : (ME.role === 'supervisor' ? ' (superviseur)' : (ME.role === 'user' ? ' (utilisateur)' : '')));
    // Bandeau : libellé COURT (évite le débordement d'en-tête).
    const roBanner = document.querySelector('.readonly-banner');
    if (roBanner) {
      if (ME.role === 'user') {
        roBanner.textContent = 'Utilisateur';
        roBanner.title = "Rôle utilisateur : vous pouvez créer/agir, mais vous ne voyez que les données que vous avez créées dans l'organisation active.";
        roBanner.style.display = 'inline-block';
      } else if (ME.role === 'supervisor') {
        roBanner.textContent = 'Superviseur';
        roBanner.title = "Rôle superviseur : lecture seule sur toutes les données de l'organisation active.";
      }
    }
    // Rôle SUPERVISOR / lecture seule stricte : classe body (masque les actions
    // d'écriture via CSS). Un `user` peut écrire (boutons visibles).
    if (ME.role === 'supervisor') {
      document.body.classList.add('readonly');
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
