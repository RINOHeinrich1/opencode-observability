// app.js — Logique du panneau de supervision.
let ME = null;
let REFRESH_S = 10;      // intervalle (s), surchargé par /api/config (min 10)
let refreshTimer = null;
let activeTab = 'overview';
let lastUpdated = null;
let taskFilter = '';     // tâche sélectionnée comme filtre ('' = aucune)
let SESSION_BASE_URL = 'https://dev.madatalk.fr'; // base des liens de session opencode

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
  const map = { approved: ['approved', 'validée'], rejected: ['rejected', 'rejetée'], pending: ['queued', 'en attente'] };
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
  const encoded = btoa(SESSION_BASE_URL).replace(/=+$/, '');
  const href = `${SESSION_BASE_URL}/server/${encoded}/session/${encodeURIComponent(sid)}`;
  return `<a class="code" href="${href}" target="_blank" rel="noopener" title="${esc(sid)}">${esc(short)}</a>`;
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
      <button id="new-task-btn" class="launch-btn">+ Nouvelle tâche</button>
    </div>
    <table><thead><tr><th></th><th>ID</th><th>Projet</th><th>Type</th><th>Priorité</th><th>Statut</th><th>Recette</th><th>Branche</th><th>Demande</th><th>Session</th><th>Actions</th></tr></thead>
    <tbody id="tasks-body"></tbody></table>`;
  const statuses = [...new Set(tasks.map((t) => t.status || 'queued'))];
  document.getElementById('f-status').innerHTML = `<option value="">Tous les statuts</option>` + statuses.map((s) => `<option>${esc(s)}</option>`).join('');
  document.getElementById('new-task-btn').addEventListener('click', () => taskCreateModal());
  const apply = () => {
    const p = document.getElementById('f-project').value;
    const st = document.getElementById('f-status').value;
    const rows = tasks.filter((t) => (!p || t.project === p) && (!st || (t.status || 'queued') === st));
    const html = rows.map((t) => {
      const subs = plansByTask[t.id] || [];
      const toggle = subs.length ? `<button class="tree-toggle" data-toggle="${esc(t.id)}">▸</button>` : '';
      const parent = `<tr class="task-row">
        <td>${toggle}</td>
        <td class="code">${esc(t.id)}</td>
        <td>${esc(t.project)}</td>
        <td>${esc(t.type)}</td>
        <td>${esc(t.priority)}</td>
        <td>${badge(t.status)}</td>
        <td>${recetteBadge(t.recette_status)}</td>
        <td class="code">${esc((t.branches || []).join(', ') || '—')}</td>
        <td>${esc((t.request || '').slice(0, 70))}</td>
        <td>${sessionLink(t.session_id)}</td>
        <td>${detailsButtons(t)}</td>
      </tr>`;
      const children = subs.map((s) => `
        <tr class="subtask-row" data-child="${esc(t.id)}" hidden>
          <td></td>
          <td colspan="10">
            <div class="subtask">
              <span class="tree-branch">↳</span>
              <code>${esc(s.planId)}</code>
              <span class="muted-sm">${esc(s.objective || '')}</span>
              ${progressBar(s.pct)}
              ${s.branch ? `<code class="muted-sm">${esc(s.branch)}</code>` : '<span class="muted-sm">—</span>'}
              ${badge(s.status)}
            </div>
          </td>
        </tr>`).join('');
      return parent + children;
    }).join('') || '<tr><td colspan="11" class="muted">Aucune tâche</td></tr>';
    document.getElementById('tasks-body').innerHTML = html;
    document.querySelectorAll('#tasks-body [data-actions]').forEach((b) => b.addEventListener('click', () => taskActionsModal(b.dataset.actions)));
    document.querySelectorAll('#tasks-body [data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.toggle;
      const children = document.querySelectorAll(`#tasks-body [data-child="${id}"]`);
      const expanded = b.textContent === '▾';
      children.forEach((c) => { c.hidden = expanded; });
      b.textContent = expanded ? '▸' : '▾';
    }));
  };
  document.getElementById('f-project').addEventListener('change', apply);
  document.getElementById('f-status').addEventListener('change', apply);
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
    <tbody>${arts.map((a) => `<tr><td class="code">${esc(a.task_id)}</td><td>${badge(a.kind)}</td><td>${esc(a.title || a.path)}</td><td class="code">${esc((a.created_at || '').replace('T', ' ').slice(0, 19))}</td><td><a class="btn-dl" href="/api/tasks/${encodeURIComponent(a.task_id)}/artifacts/${encodeURIComponent(a.artifact_id)}/download" download>Télécharger</a></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun document</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

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
    <table><thead><tr><th>Plan</th><th>Tâche</th><th>Objectif</th><th>Avancement</th><th>Livrables</th></tr></thead>
    <tbody>${plans.map((p) => `<tr><td class="code">${esc(p.planId)}</td><td class="code">${esc(p.task_id || '—')}</td><td>${esc(p.objective)}</td><td>${progressBar(p.pct)}</td><td>${esc((p.deliverables || []).join(', '))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun plan</td></tr>'}</tbody></table>`;
  bindTaskFilter();
}

// --- Archivage / restauration ---------------------------------------------
function snapshotList(snap) {
  const items = [
    ['Exécutions', snap.executions],
    ['Événements', snap.events],
    ['Documents', snap.artifacts],
    ['Plans', snap.plans],
    ['Worktrees', snap.worktrees],
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
  if (snap.worktrees) parts.push(`${snap.worktrees} WT`);
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
    <p class="muted-sm">Une tâche archivée masque aussi tous les éléments qui lui sont rattachés (événements, documents, worktrees, déploiements, décisions).</p>
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
    a.model ? `<span class="code muted-sm">${esc(a.model)}</span>` : '',
  ].filter(Boolean).join(' ');
  const full = [a.description, a.body].filter(Boolean).join('\n\n');
  return `<article class="eco-card">
    <div class="eco-card-head"><strong>${esc(a.name)}</strong>${meta}</div>
    ${descBlock(a.name, a.description, full)}
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
        <input id="pm-gitpath" placeholder="chemin git (ex: /home/coder/oniria)" value="${esc(project?.gitPath || '')}">
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
        <textarea id="tm-request" placeholder="description de la tâche" required></textarea>
        <input id="tm-scope" placeholder="scope (chemins, séparés par des virgules)">
        <div class="modal-actions">
          <button type="button" class="ghost" id="modal-cancel">Annuler</button>
          <button type="submit" class="launch-btn">Créer</button>
        </div>
      </form>
      <div id="task-modal-msg" class="msg"></div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('task-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('task-modal-msg');
    const scopeRaw = document.getElementById('tm-scope').value.trim();
    try {
      await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project: document.getElementById('tm-project').value,
        type: document.getElementById('tm-type').value,
        request: document.getElementById('tm-request').value.trim(),
        scope: scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
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
  const branches = (detail.worktree || []).map((w) => w.branch).filter(Boolean);

  showModal(`
    <div class="modal modal-wide">
      <h2>Actions — <span class="code">${esc(taskId)}</span></h2>
      <p class="muted">${esc(task.request || '')}</p>
      <p class="muted-sm">Projet <span class="code">${esc(task.project)}</span> · Type <span class="code">${esc(task.type)}</span> · ${badge(status)} · Recette ${recetteBadge(recette)}</p>
      <p class="muted-sm">Branches : <span class="code">${esc(branches.join(', ') || '—')}</span></p>

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

      ${status === 'done' ? `
      <div class="actions-section">
        <h3>Recette (acceptation humaine après déploiement)</h3>
        ${recette === 'pending' ? `
        <p class="muted-sm">Testez la fonctionnalité/fix sur la plateforme, puis approuvez ou rejetez la recette.</p>
        <button class="approve" id="act-recette">Valider la recette</button>` : ''}
        ${recette === 'approved' ? `<p class="muted-sm">Recette <strong>validée</strong>. La tâche est clôturée.</p>` : ''}
        ${recette === 'rejected' ? `<p class="muted-sm">Recette <strong>rejetée</strong>. Utilisez « Reprendre » pour relancer une correction (nouvelle session ou continuer).</p>` : ''}
      </div>` : ''}

      <div class="actions-section">
        <h3>Opérations</h3>
        <div class="actions-buttons">
          ${status === 'queued' ? `<button class="launch-btn" id="act-launch">Lancer</button>` : ''}
          ${status === 'aborted' ? `<button class="launch-btn" id="act-relaunch">Relancer</button>` : ''}
          ${(status === 'rejected' || status === 'failed' || (status === 'done' && recette === 'rejected')) ? `<button id="act-rework">Reprendre</button>` : ''}
          ${['started','planning','in_progress','validating','review','merge_pending','merged','deploy_pending','deploying','deployed','post_deploy_verified','blocked'].includes(status) ? `<button class="danger" id="act-kill">Tuer la session</button>` : ''}
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
        </div>
      </div>

      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Fermer</button>
      </div>
    </div>`);

  document.getElementById('modal-cancel').onclick = closeModal;
  const launch = document.getElementById('act-launch');
  if (launch) launch.onclick = () => { closeModal(); launchTaskModal(taskId); };
  const rework = document.getElementById('act-rework');
  if (rework) rework.onclick = () => { closeModal(); reworkTaskModal(taskId); };
  const recetteBtn = document.getElementById('act-recette');
  if (recetteBtn) recetteBtn.onclick = () => { closeModal(); recetteTaskModal(taskId); };
  const archive = document.getElementById('act-archive');
  if (archive) archive.onclick = () => { closeModal(); openArchiveConfirm(taskId); };
  const kill = document.getElementById('act-kill');
  if (kill) kill.onclick = () => {
    if (!confirm('Arrêter la session ? (process tué + session supprimée + tâche abandonnée + worktree libéré)')) return;
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

async function launchTaskModal(taskId) {
  showModal(`
    <div class="modal">
      <h2>Lancer la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <p>Une session de l'agent orchestrateur sera ouverte (mission + cadre). Le worktree et la branche sont gérés en interne par l'orchestrateur.</p>
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
  showModal(`
    <div class="modal">
      <h2>Reprendre la tâche</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <textarea id="rework-remarks" class="modal-textarea" placeholder="remarques de reprise"></textarea>
      <label class="modal-field">Mode
        <select id="rework-mode">
          <option value="fresh">Nouvelle session vierge (choix 3)</option>
          <option value="continue">Continuer la session courante (choix 1)</option>
        </select>
      </label>
      <div id="rework-session-wrap" hidden>
        <label class="modal-field">Session courante
          <input id="rework-session" placeholder="ses_…">
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

async function recetteTaskModal(taskId) {
  showModal(`
    <div class="modal">
      <h2>Valider la recette</h2>
      <p class="muted">Tâche <span class="code">${esc(taskId)}</span></p>
      <p class="muted-sm">Après test sur la plateforme : approuvez la recette, ou rejetez-la en précisant ce qui manque (la tâche pourra alors être reprise).</p>
      <textarea id="recette-remarks" class="modal-textarea" placeholder="remarques (ce qui manque en cas de rejet)"></textarea>
      <div class="modal-actions">
        <button class="ghost" id="modal-cancel">Annuler</button>
        <button class="approve" id="recette-approve">Approuver la recette</button>
        <button class="danger" id="recette-reject">Rejeter la recette</button>
      </div>
    </div>`);
  document.getElementById('modal-cancel').onclick = closeModal;
  const submit = async (status) => {
    const resolution = document.getElementById('recette-remarks').value.trim();
    if (status === 'rejected' && !resolution) {
      if (!confirm('Rejeter la recette sans préciser ce qui manque ?')) return;
    }
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/recette`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, resolution }),
      });
      closeModal();
      refreshActive();
    } catch (e) { alert('Échec : ' + (e.message || e)); }
  };
  document.getElementById('recette-approve').onclick = () => submit('approved');
  document.getElementById('recette-reject').onclick = () => submit('rejected');
}

// --- Navigation ------------------------------------------------------------
const RENDER = {
  overview: renderOverview, projects: renderProjects, tasks: renderTasks,
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
