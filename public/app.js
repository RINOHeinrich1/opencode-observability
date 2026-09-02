// app.js — Logique du panneau de supervision.
let ME = null;
let REFRESH_S = 10;      // intervalle (s), surchargé par /api/config (min 10)
let refreshTimer = null;
let activeTab = 'overview';
let lastUpdated = null;
let taskFilter = '';     // tâche sélectionnée comme filtre ('' = aucune)
let SESSION_BASE_URL = 'https://dev.madatalk.fr'; // base des liens de session opencode
let groupRecetteEnabled = localStorage.getItem('panel_group_recette') === '1'; // persistant (onglets + rechargement)
let groupParallelEnabled = localStorage.getItem('panel_group_parallel') === '1'; // grouper par ordre/parallèle
let tasksProjectFilter = localStorage.getItem('panel_task_project') || ''; // filtre projet de l'onglet Tâches (persistant re-rendu)
let tasksStatusFilter = localStorage.getItem('panel_task_status') || '';   // filtre statut de l'onglet Tâches (persistant re-rendu)

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
  return taskFilter ? `?taskId=${encodeURIComponent(taskFilter)}` : '';
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
  const s = await api('/api/stats');
  const cards = [['Tâches', s.tasks]];
  for (const [st, n] of Object.entries(s.byStatus || {})) cards.push([st, n]);
  cards.push(['Décisions ouvertes', s.openDecisions], ['Archivées', s.archived || 0]);
  document.getElementById('pane-overview').innerHTML =
    `<div class="cards">${cards.map(([l, n]) => `<div class="card"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('')}</div>` +
    `<div class="muted-sm">Registre : ${s.byStatus && Object.keys(s.byStatus).length ? 'connecté' : 'vide / non initialisé'}</div>`;
}

// --- Tâches ----------------------------------------------------------------
async function renderTasks() {
  const [data, plansData] = await Promise.all([api('/api/tasks'), api('/api/plans')]);
  const tasks = data.tasks || [];
  const plans = plansData.plans || [];
  const plansByTask = {};
  plans.forEach((p) => { if (p.task_id) (plansByTask[p.task_id] = plansByTask[p.task_id] || []).push(p); });
  const projects = [...new Set(tasks.map((t) => t.project).filter(Boolean))];
  document.getElementById('pane-tasks').innerHTML = `
    <h2>Tâches</h2>
    <div class="filters">
      <select id="f-project"><option value="">Tous les projets</option>${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>
      <select id="f-status"><option value="">Tous les statuts</option></select>
      <label class="muted filter-check"><input type="checkbox" id="f-group-recette" ${groupRecetteEnabled ? 'checked' : ''}> Grouper par recette</label>
      <label class="muted filter-check" id="f-group-parallel-wrap" hidden><input type="checkbox" id="f-group-parallel" ${groupParallelEnabled ? 'checked' : ''}> Grouper par tâches parallèles</label>
      <button id="new-task-btn" class="launch-btn">+ Nouvelle tâche</button>
    </div>
    <table><thead><tr><th></th><th>ID</th><th>Projet</th><th>Type</th><th>Priorité</th><th>Statut</th><th>Recette</th><th>Demande</th><th>Session</th><th>Actions</th></tr></thead>
    <tbody id="tasks-body"></tbody></table>`;
  const statuses = [...new Set(tasks.map((t) => t.status || 'queued'))];
  const projectSel = document.getElementById('f-project');
  const statusSel = document.getElementById('f-status');
  // Restaure les filtres projet/statut (perdus lors d'un re-rendu : polling, retour d'onglet…).
  if (tasksProjectFilter && !projects.includes(tasksProjectFilter)) projects.push(tasksProjectFilter);
  projectSel.innerHTML = `<option value="">Tous les projets</option>` + projects.map((p) => `<option>${esc(p)}</option>`).join('');
  projectSel.value = [...projectSel.options].some((o) => o.value === tasksProjectFilter) ? tasksProjectFilter : '';
  if (tasksStatusFilter && !statuses.includes(tasksStatusFilter)) statuses.push(tasksStatusFilter);
  statusSel.innerHTML = `<option value="">Tous les statuts</option>` + statuses.map((s) => `<option>${esc(s)}</option>`).join('');
  statusSel.value = [...statusSel.options].some((o) => o.value === tasksStatusFilter) ? tasksStatusFilter : '';
  document.getElementById('new-task-btn').addEventListener('click', () => taskCreateModal());
  const apply = () => {
    const p = document.getElementById('f-project').value;
    const st = document.getElementById('f-status').value;
    const groupRecette = document.getElementById('f-group-recette').checked;
    const groupParallel = document.getElementById('f-group-parallel').checked;
    const parallelWrap = document.getElementById('f-group-parallel-wrap');
    if (parallelWrap) parallelWrap.hidden = !groupRecette;
    const rows = tasks.filter((t) => (!p || t.project === p) && (!st || (t.status || 'queued') === st));

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
        const head = `<tr class="recette-group-head"><td colspan="11">
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
            const subHead = `<tr class="recette-order-row" data-recette-child="${esc(sourceId)}"><td colspan="11">
              <span class="tree-branch">↳</span> <strong>Ordre ${o === '999' ? '— (non défini)' : esc(o)}</strong>${isParallel ? ` <span class="muted-sm">(${l.length} exécutables en parallèle)</span>` : ''}
            </td></tr>`;
            return subHead + l.map((t) => rowHtml(t, sourceId)).join('');
          }).join('');
        };
        return head + members();
      };
      const groups = Object.entries(bySource).sort((a, b) => b[0].localeCompare(a[0])).map(([s, l]) => groupHtml(s, l)).join('');
      const othersHtml = others.length ? groupHtml('(sans recette)', others) : '';
      html = (groups + othersHtml) || '<tr><td colspan="11" class="muted">Aucune tâche</td></tr>';
    } else {
      html = rows.map((t) => rowHtml(t, null)).join('') || '<tr><td colspan="11" class="muted">Aucune tâche</td></tr>';
    }

    document.getElementById('tasks-body').innerHTML = html;
    document.querySelectorAll('#tasks-body [data-actions]').forEach((b) => b.addEventListener('click', () => taskActionsModal(b.dataset.actions)));
    document.querySelectorAll('#tasks-body [data-commits]').forEach((b) => b.addEventListener('click', () => renderPlanCommitsModal(b.dataset.commits)));
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
  document.getElementById('f-project').addEventListener('change', () => {
    tasksProjectFilter = document.getElementById('f-project').value;
    localStorage.setItem('panel_task_project', tasksProjectFilter);
    apply();
  });
  document.getElementById('f-status').addEventListener('change', () => {
    tasksStatusFilter = document.getElementById('f-status').value;
    localStorage.setItem('panel_task_status', tasksStatusFilter);
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
  document.getElementById('pane-decisions').innerHTML = `
    <h2>Décisions humaines</h2>
    ${filterBar()}
    <table><thead><tr><th>Tâche</th><th>Type</th><th>Statut</th><th>Détail</th><th>Échéance</th><th>Résolution</th></tr></thead>
    <tbody>${dec.map((d) => `<tr><td class="code">${esc(d.task_id)}</td><td>${esc(d.kind)}</td><td>${badge(d.status)}</td><td>${esc(d.detail || '—')}</td><td class="code">${esc((d.expires_at || '—').replace('T', ' ').slice(0, 19))}</td><td>${esc(d.resolution || '—')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune décision</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

// --- Utilisateurs (admin) --------------------------------------------------
async function renderUsers() {
  const r = await fetch('/api/users');
  if (r.status === 403) { document.getElementById('pane-users').innerHTML = '<p class="muted">Réservé aux administrateurs.</p>'; return; }
  const data = await r.json();
  const users = data.users || [];
  document.getElementById('pane-users').innerHTML = `
    <h2>Utilisateurs</h2>
    <div class="user-form">
      <input id="new-username" placeholder="nom d'utilisateur">
      <input id="new-password" type="password" placeholder="mot de passe">
      <label><input type="checkbox" id="new-admin"> admin</label>
      <button id="add-user">Ajouter</button>
    </div>
    <table><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Créé le</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.is_admin ? 'admin' : 'utilisateur'}</td><td class="code">${esc((u.created_at || '').replace('T', ' ').slice(0, 19))}</td><td><button class="danger" data-del="${u.id}">Supprimer</button></td></tr>`).join('')}</tbody></table>
    <div id="users-msg" class="error"></div>`;
  document.getElementById('add-user').addEventListener('click', async () => {
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const isAdmin = document.getElementById('new-admin').checked;
    const rr = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, isAdmin }) });
    const msg = document.getElementById('users-msg');
    if (rr.ok) { msg.textContent = ''; renderUsers(); }
    else msg.textContent = (await rr.json()).error || 'Erreur';
  });
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await fetch(`/api/users/${b.dataset.del}`, { method: 'DELETE' });
    renderUsers();
  }));
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

function recetteCard(r) {
  const canSession = r.status === 'pending' || r.status === 'in_progress';
  const canFinish = r.status === 'in_progress';
  return `<article class="project-card">
    <div class="project-card-head"><strong class="recette-title" data-rec-detail="${esc(r.recette_id)}" title="Voir le détail">${esc(r.title || r.recette_id)}</strong> <code class="muted-sm">${esc(r.project)}</code> ${badge(r.status)}</div>
    <div class="project-card-body">
      ${r.description ? `<div class="project-kv"><span class="lbl">Description</span><span class="muted-sm">${esc(r.description.slice(0, 100))}${r.description.length > 100 ? '…' : ''}</span></div>` : ''}
      <div class="project-kv"><span class="lbl">Tâches couvertes</span><span>${r.tasks_count || 0}</span></div>
      <div class="project-kv"><span class="lbl">Éléments</span><span>${r.items_count || 0}</span></div>
      ${r.confirmed_at ? `<div class="project-kv"><span class="lbl">Confirmée</span><span class="muted-sm">${esc((r.confirmed_at || '').replace('T', ' ').slice(0, 16))}</span></div>` : ''}
    </div>
    <div class="project-card-actions">
      <button class="ghost" data-rec-docs="${esc(r.recette_id)}">Documents (${r.documents_count || 0})</button>
      ${canSession ? `<button class="launch-btn" data-rec-session="${esc(r.recette_id)}">Session de recette</button>` : ''}
      ${canFinish ? `<button class="approve" data-rec-finish="${esc(r.recette_id)}">Terminer la recette</button>` : ''}
      ${r.status === 'done' ? `<button class="ghost" data-rec-items="${esc(r.recette_id)}">Détail de la recette</button>` : ''}
    </div>
  </article>`;
}

async function renderRecettes() {
  const data = await api('/api/recettes');
  const recs = data.recettes || [];
  document.getElementById('pane-recettes').innerHTML = `
    <h2>Recettes</h2>
    <p class="muted-sm">Opérations de vérification par projet — couvrent 0..N tâches, avec titre et session dédiée.</p>
    <div class="filters"><button id="new-recette-btn" class="launch-btn">+ Nouvelle recette</button></div>
    <div class="project-cards">${recs.map(recetteCard).join('') || '<p class="muted">Aucune recette.</p>'}</div>`;
  document.getElementById('new-recette-btn').addEventListener('click', () => recetteCreateModal());
  document.querySelectorAll('#pane-recettes [data-rec-session]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/recettes/${encodeURIComponent(b.dataset.recSession)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
      else alert('Aucune session de recette disponible.');
      refreshActive();
    } catch (e) { alert('Échec de la session de recette : ' + (e.message || e)); }
  }));
  document.querySelectorAll('#pane-recettes [data-rec-finish]').forEach((b) => b.addEventListener('click', () => finishRecetteModal(b.dataset.recFinish)));
  document.querySelectorAll('#pane-recettes [data-rec-items]').forEach((b) => b.addEventListener('click', () => recetteDetailItemsModal(b.dataset.recItems)));
  document.querySelectorAll('#pane-recettes [data-rec-docs]').forEach((b) => b.addEventListener('click', () => recetteDocsModal(b.dataset.recDocs)));
  document.querySelectorAll('#pane-recettes [data-rec-detail]').forEach((b) => b.addEventListener('click', () => recetteDetailModal(b.dataset.recDetail)));
}

// Détail d'une recette en modale (titre court + description longue + périmètre).
async function recetteDetailModal(recetteId) {
  let d;
  try { d = await api(`/api/recettes/${encodeURIComponent(recetteId)}`); } catch (e) { alert('Impossible de charger la recette : ' + (e.message || e)); return; }
  const rec = d.recette || {};
  const tasks = rec.tasks || [];
  const items = rec.items || [];
  showModal(`
    <div class="modal modal-wide">
      <h2>${esc(rec.title || recetteId)}</h2>
      <p class="muted">${badge(rec.status)} · Projet <span class="code">${esc(rec.project || '')}</span>${rec.confirmed_at ? ` · confirmée ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${rec.description ? `<p class="modal-request">${esc(rec.description)}</p>` : ''}
      ${tasks.length ? `<div class="actions-section"><h3>Tâches couvertes (${tasks.length})</h3><div class="recette-list">${tasks.map((t) => {
        const tid = (t && typeof t === 'object') ? (t.taskId || t.task_id || '') : (t || '');
        const ttl = (t && typeof t === 'object') ? (t.title || '') : '';
        const req = (t && typeof t === 'object') ? (t.request || '') : '';
        return `<div class="recette-item"><code class="muted-sm">${esc(tid)}</code><div class="recette-task"><strong>${esc(ttl)}</strong>${req ? `<p class="muted-sm">${esc(req)}</p>` : ''}</div></div>`;
      }).join('')}</div></div>` : '<p class="muted-sm">Aucune tâche couverte (recette exploratoire).</p>'}
      ${items.length ? `<div class="actions-section"><h3>Éléments (${items.length})</h3><div class="recette-list">${items.map((it) => `<div class="recette-item"><span class="badge ${RECETTE_CLS_BADGE[it.classification] || 'queued'}">${RECETTE_CLS_LABEL[it.classification] || it.classification}</span>${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution">ordre ${esc(it.execOrder)}</span>` : ''}${it.vigilance ? `<span class="badge danger" title="${esc(it.vigilance)}">⚠ vigilance</span>` : ''}<span>${esc(it.title || it.content.slice(0, 80))}</span></div>`).join('')}</div></div>` : ''}
      <div class="modal-actions"><button class="ghost" id="modal-cancel">Fermer</button></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
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
  showModal(`
    <div class="modal modal-wide">
      <h2>Nouvelle recette</h2>
      <form id="recette-modal-form" class="pilot-form">
        <select id="rm-project" required><option value="">— projet —</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('')}</select>
        <input id="rm-title" placeholder="titre court (ex: Recette du module chatbot)" required>
        <textarea id="rm-description" class="modal-textarea" placeholder="description longue (détail du périmètre vérifié) — optionnel"></textarea>
        <label class="modal-field">Tâches couvertes <span class="muted-sm">(0..N — tâches non encore recettées)</span></label>
        <div id="rm-candidates" class="recette-candidates"><p class="muted-sm">Sélectionnez un projet pour charger les tâches disponibles.</p></div>
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
  const loadCandidates = async () => {
    const proj = document.getElementById('rm-project').value;
    candBox.innerHTML = '<p class="muted-sm">Chargement…</p>';
    if (!proj) { candBox.innerHTML = '<p class="muted-sm">Sélectionnez un projet.</p>'; return; }
    try {
      const d = await api(`/api/recettes/candidates?project=${encodeURIComponent(proj)}`);
      const c = d.candidates || [];
      candBox.innerHTML = c.length
        ? `<div class="recette-cand-list">${c.map((t) => `
            <label class="recette-cand">
              <input type="checkbox" class="rm-cand" value="${esc(t.id)}">
              <span><strong>${esc(t.title || (t.request || '').slice(0, 60))}</strong> <code class="muted-sm">${esc(t.id)}</code> ${badge(t.status || 'queued')}</span>
            </label>`).join('')}</div>`
        : '<p class="muted-sm">Aucune tâche non recettée dans ce projet.</p>';
    } catch (e) { candBox.innerHTML = '<p class="muted-sm">Erreur de chargement : ' + esc(e.message || e) + '</p>'; }
  };
  document.getElementById('rm-project').addEventListener('change', loadCandidates);

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
        project: document.getElementById('rm-project').value,
        title: document.getElementById('rm-title').value.trim(),
        description: document.getElementById('rm-description').value.trim() || undefined,
        taskIds,
        documents,
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
      <div class="recette-task">
        <strong>${esc(it.title || it.content.slice(0, 60))}</strong>
        ${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution">ordre ${esc(it.execOrder)}</span>` : ''}
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
  showModal(`
    <div class="modal modal-wide modal-finish" id="finish-modal">
      <div class="finish-head"><h2 style="margin:0">${readOnly ? 'Détail de la recette' : 'Terminer la recette'}</h2>
        <button class="ghost" id="finish-fullscreen" title="Plein écran">⛶</button></div>
      <p class="muted">${esc(rec.title || recetteId)} — <span class="code">${esc(rec.project)}</span>${readOnly && rec.confirmed_at ? ` · clôturée le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}</p>
      ${intro}
      ${items.length ? `<div class="recette-list">${items.map(itemCard).join('')}</div>` : ''}
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
      const r = await api(`/api/recettes/${encodeURIComponent(recetteId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: payload }) });
      msg.textContent = r.created && r.created.length
        ? 'Tâches créées : ' + r.created.map((c) => `${c.taskId} (${RECETTE_CLS_LABEL[c.classification]})`).join(', ')
        : 'Recette terminée (aucune tâche créée).';
      msg.className = 'msg ok';
      closeModal();
      alert(msg.textContent);
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
  const archives = data.archives || [];
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
    ${section('Agents', e.agents.length, e.agents.map(agentCard).join('') || '<p class="muted">Aucun agent</p>')}
    ${section('Serveurs MCP', e.mcp.length, e.mcp.map(mcpCard).join('') || '<p class="muted">Aucun serveur MCP</p>')}
    ${section('Skills', e.skills.length, e.skills.map(skillCard).join('') || '<p class="muted">Aucun skill</p>')}
    ${section('Plugins', e.plugins.length, e.plugins.map(pluginCard).join('') || '<p class="muted">Aucun plugin</p>')}`;
  document.querySelectorAll('#pane-ecosystem [data-eco]').forEach((b) => b.addEventListener('click', () => openEcoModal(b.dataset.eco)));
  document.querySelectorAll('#pane-ecosystem [data-edit-model]').forEach((b) => b.addEventListener('click', () => editAgentModelModal(b.dataset.editModel, b.dataset.model)));
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
  const projects = projs.projects || [];
  document.getElementById('pane-projects').innerHTML = `
    <h2>Projets</h2>
    <div class="projects-toolbar">
      <button id="new-project-btn" class="launch-btn">+ Nouveau projet</button>
    </div>
    <div class="project-cards">
      ${projects.map((p) => `
        <article class="project-card">
          <div class="project-card-head">
            <strong>${esc(p.name || p.id)}</strong>
            <code class="muted-sm">${esc(p.id)}</code>
          </div>
          <div class="project-card-body">
            <div class="project-kv"><span class="lbl">Workspace Coder</span><span>${esc(p.workspace || '—')}</span></div>
            <div class="project-kv"><span class="lbl">Branche git principale</span>${p.mainBranch ? `<code class="muted-sm">${esc(p.mainBranch)}</code>` : '<span class="badge danger">manquante — déploiement bloqué</span>'}</div>
            <div class="project-kv"><span class="lbl">Chemin git</span><code class="muted-sm">${esc(p.gitPath || '—')}</code></div>
            <div class="project-kv"><span class="lbl">Créé le</span><span class="muted-sm">${esc((p.createdAt || '').replace('T', ' ').slice(0, 19))}</span></div>
          </div>
          <div class="project-card-actions">
            <button class="ghost" data-edit-project="${esc(p.id)}">Modifier</button>
            <button class="danger" data-del-project="${esc(p.id)}">Supprimer</button>
          </div>
        </article>`).join('') || '<p class="muted">Aucun projet enregistré.</p>'}
    </div>`;
  document.getElementById('new-project-btn').addEventListener('click', () => projectFormModal(null));
  document.querySelectorAll('[data-edit-project]').forEach((b) => {
    b.addEventListener('click', () => projectFormModal(projects.find((x) => x.id === b.dataset.editProject)));
  });
  document.querySelectorAll('[data-del-project]').forEach((b) => {
    b.addEventListener('click', () => projectDeleteModal(b.dataset.delProject));
  });
}

async function projectFormModal(project) {
  let wsNames = [];
  try { wsNames = ((await api('/api/workspaces')).workspaces || []).map((w) => w.name); } catch {}
  const editing = !!project;
  showModal(`
    <div class="modal">
      <h2>${editing ? 'Modifier le projet' : 'Nouveau projet'}</h2>
      <form id="project-modal-form" class="pilot-form">
        <input id="pm-id" placeholder="identifiant (ex: oniria)" value="${esc(project?.id || '')}" ${editing ? 'readonly' : ''} required>
        <input id="pm-name" placeholder="nom lisible" value="${esc(project?.name || '')}" required>
        <select id="pm-workspace">
          <option value="">— workspace Coder —</option>
          ${wsNames.map((w) => `<option value="${esc(w)}" ${project?.workspace === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}
        </select>
        <input id="pm-gitpath" placeholder="chemin du dépôt sur disque (ex: /home/coder/oniria)" value="${esc(project?.gitPath || '')}">
        <label class="modal-field">Branche git principale <span class="muted-sm">(obligatoire pour déployer)</span>
          <input id="pm-main-branch" placeholder="ex: main, oniria-preprod" value="${esc(project?.mainBranch || '')}" required>
        </label>
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">${editing ? 'Enregistrer' : 'Créer'}</button>
        </div>
      </form>
      <div id="project-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('project-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('project-modal-msg');
    try {
      await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: document.getElementById('pm-id').value.trim(),
        name: document.getElementById('pm-name').value.trim(),
        workspace: document.getElementById('pm-workspace').value,
        gitPath: document.getElementById('pm-gitpath').value.trim() || undefined,
        mainBranch: document.getElementById('pm-main-branch').value.trim(),
      }) });
      closeModal();
      refreshActive();
    } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  });
}

function projectDeleteModal(projectId) {
  showModal(`
    <div class="modal">
      <h2>Supprimer le projet</h2>
      <p class="warn">Supprimer le projet <span class="code">${esc(projectId)}</span> du registre ?</p>
      <p class="muted-sm">Les tâches existantes conservent leur référence de projet.</p>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="danger" id="modal-confirm">Supprimer</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = async () => {
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      closeModal();
      refreshActive();
    } catch (e) { alert('Échec : ' + (e.message || e)); }
  };
}

async function taskCreateModal() {
  const projs = await api('/api/projects');
  const projects = projs.projects || [];
  showModal(`
    <div class="modal">
      <h2>Nouvelle tâche</h2>
      <form id="task-modal-form" class="pilot-form">
        <select id="tm-project" required>
          <option value="">— projet —</option>
          ${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('')}
        </select>
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

  document.getElementById('task-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('task-modal-msg');
    const scopeRaw = document.getElementById('tm-scope').value.trim();
    const type = typeSel.value;
    const linkedTasks = [...linksList.querySelectorAll('.link-row')]
      .map((r) => ({ taskId: r.querySelector('.link-task').value.trim(), description: r.querySelector('.link-desc').value.trim() }))
      .filter((l) => l.taskId);    try {
      await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: document.getElementById('tm-project').value,
        type,
        auditTarget: type === 'audit' ? targetSel.value : undefined,
        directExecution: type !== 'audit' && modeSel.value === 'direct',
        request: document.getElementById('tm-request').value.trim(),
        title: document.getElementById('tm-title').value.trim(),
        acceptanceCriteria: [document.getElementById('tm-acceptance').value.trim()],
        scope: scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        linkedTasks,
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
  const awaiting = decisions.filter((d) => d.status === 'awaiting' && d.kind !== 'permission' && d.kind !== 'recette');
  const linked = detail.linkedTasks || [];

  showModal(`
    <div class="modal modal-wide">
      <h2>Actions — <span class="code">${esc(taskId)}</span></h2>
      <p class="muted-sm"><strong>Titre :</strong> ${esc((task.title && task.title.trim()) ? task.title : '—')}</p>
      <div class="modal-request">${esc(task.request || '—')}</div>
      ${(() => { let c = ''; try { const a = typeof task.acceptance_criteria === 'string' ? JSON.parse(task.acceptance_criteria) : (task.acceptance_criteria || []); c = Array.isArray(a) ? a.join(' · ') : String(a || ''); } catch { c = String(task.acceptance_criteria || ''); } return c ? `<p class="muted-sm"><strong>Critère d'acceptation :</strong> ${esc(c)}</p>` : ''; })()}
      <p class="muted-sm">Projet <span class="code">${esc(task.project)}</span> · Type <span class="code">${esc(task.type)}</span> · ${badge(status)} · Recette ${recetteBadge(recette)}</p>

      ${linked.length ? `
      <div class="actions-section">
        <h3>Tâches liées (${linked.length})</h3>
        ${linked.map((l) => `
          <div class="link-item">
            <code>${esc(l.linked_task_id || l.linkedTaskId)}</code>
            <span class="muted-sm">${esc((l.description || '').slice(0, 90) || '—')}</span>
            <span class="muted-sm">${esc((l.linked_request || '').slice(0, 50))}${l.linked_status ? ` · ${esc(l.linked_status)}` : ''}</span>
          </div>`).join('')}
      </div>` : ''}

      ${awaiting.length ? `
      <div class="actions-section">
        <h3>Validation (décisions en attente)</h3>
        ${awaiting.map((d) => `
          <div class="decision-row">
            <code class="muted-sm">${esc(d.decision_id)}</code>
            <span class="muted-sm">${esc(d.kind)} — ${esc(d.detail || '')}</span>
            <input class="decision-remarks" placeholder="remarques">
            <button class="approve" data-approve="${esc(d.decision_id)}">Approuver</button>
            <button class="danger" data-reject="${esc(d.decision_id)}">Rejeter</button>
          </div>`).join('')}
      </div>` : ''}

      ${status === 'done' ? recetteSectionHtml(recette, detail) : ''}

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
  if (recetteSession) recetteSession.onclick = async () => {
    const rid = recetteSession.dataset.recId;
    try {
      const r = await api(`/api/recettes/${encodeURIComponent(rid)}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.sessionId && /^ses_/.test(r.sessionId)) window.open(sessionHref(r.sessionId), '_blank');
      else alert(r.error || 'Aucune session de recette disponible.');
      closeModal();
      refreshActive();
    } catch (e) { alert('Échec du lancement de la recette : ' + (e.message || e)); }
  };
  const recetteFinish = document.getElementById('act-recette-finish');
  if (recetteFinish) recetteFinish.onclick = () => { closeModal(); finishRecetteModal(recetteFinish.dataset.recId); };
  const recetteDetail = document.getElementById('act-recette-detail');
  if (recetteDetail) recetteDetail.onclick = () => { closeModal(); recetteDetailItemsModal(recetteDetail.dataset.recId); };
  const archive = document.getElementById('act-archive');
  if (archive) archive.onclick = () => { closeModal(); openArchiveConfirm(taskId); };
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
  document.querySelectorAll('[data-approve], [data-reject]').forEach((b) => {
    b.addEventListener('click', async () => {
      const decisionId = b.dataset.approve || b.dataset.reject;
      const st = b.dataset.approve ? 'approved' : 'rejected';
      const input = b.closest('.decision-row').querySelector('.decision-remarks');
      const resolution = input ? input.value.trim() : '';
      try {
        await api(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: st, resolution }),
        });
        closeModal();
        refreshActive();
      } catch (err) { alert('Échec : ' + (err.message || err)); }
    });
  });
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

function recetteItemRow(it) {
  return `<div class="recette-item">
    <code class="muted-sm">#${it.id || it.itemId}</code>
    <span class="badge ${RECETTE_CLS_BADGE[it.classification] || 'queued'}">${RECETTE_CLS_LABEL[it.classification] || it.classification}</span>
    ${it.execOrder != null ? `<span class="badge order-badge" title="Ordre d'exécution (même numéro = parallèle)">ordre ${esc(it.execOrder)}</span>` : ''}
    ${it.vigilance ? `<span class="badge danger" title="Point de vigilance / écart sémantique : ${esc(it.vigilance)}">⚠ vigilance</span>` : ''}
    <span>${esc(it.content)}</span>
    ${it.status === 'task_created' && it.created_task_id ? `<code class="muted-sm">→ ${esc(it.created_task_id)}</code>` : ''}
  </div>`;
}

function recetteSectionHtml(recetteStatus, detail) {
  const rec = detail && detail.recette;
  if (!rec) {
    return `<div class="actions-section"><h3>Recette</h3>
      <p class="muted-sm">Cette tâche n'est couverte par aucune recette. Créez une recette (onglet <a href="#" onclick="goToTab('recettes'); return false;">Recettes</a>) pour couvrir plusieurs tâches d'un même périmètre.</p>
    </div>`;
  }
  const st = rec.status;
  const title = rec.title || rec.recetteId;
  const items = rec.items || [];
  const btns = (st === 'in_progress' || st === 'pending') ? `
    <div class="actions-buttons">
      <button class="launch-btn" id="act-recette-session" data-rec-id="${esc(rec.recetteId)}">Session de recette</button>
      ${st === 'in_progress' ? `<button class="approve" id="act-recette-finish" data-rec-id="${esc(rec.recetteId)}">Terminer la recette</button>` : ''}
    </div>` : (st === 'done' ? `
    <div class="actions-buttons">
      <button class="ghost" id="act-recette-detail" data-rec-id="${esc(rec.recetteId)}">Détail de la recette</button>
    </div>` : '');
  const statusTxt = st === 'done' ? `faite${rec.confirmed_at ? ` le ${esc((rec.confirmed_at || '').replace('T', ' ').slice(0, 16))}` : ''}` : RECETTE_STATUS_LABEL[st] || st;
  return `<div class="actions-section"><h3>Recette — ${statusTxt}</h3>
    <p class="muted-sm"><strong>${esc(title)}</strong> <span class="code">${esc(rec.project || '')}</span></p>
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

const RENDER = {
  overview: renderOverview, observability: renderObservability, projects: renderProjects, tasks: renderTasks, recettes: renderRecettes,
  events: renderEvents, deployments: renderDeployments, decisions: renderDecisions, artifacts: renderArtifacts, plans: renderPlans, archives: renderArchives, ecosystem: renderEcosystem, users: renderUsers,
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
    document.getElementById('whoami').textContent = ME.username + (ME.is_admin ? ' (admin)' : '');
    if (ME.is_admin) document.getElementById('tab-users').hidden = false;
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

  document.querySelectorAll('#tabs button').forEach((btn) => btn.addEventListener('click', () => {
    taskFilter = '';   // navigation manuelle : réinitialiser le filtre tâche
    switchTab(btn.dataset.tab);
    refreshActive();
  }));

  // Fermer la modale en cliquant sur le fond.
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  applyInterval();   // démarre le polling
  refreshActive();   // premier rendu immédiat
}

init();
