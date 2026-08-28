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
  let html = `<div class="icon-actions">` +
    `<button class="icon-btn" title="Documents" data-goto="artifacts" data-task="${esc(t.id)}">Doc</button>` +
    `<button class="icon-btn" title="Événements" data-goto="events" data-task="${esc(t.id)}">Évt</button>` +
    `<button class="icon-btn" title="Worktree" data-goto="worktrees" data-task="${esc(t.id)}">WT</button>` +
    `<button class="icon-btn" title="Déploiements" data-goto="deployments" data-task="${esc(t.id)}">Dép</button>` +
    `<button class="icon-btn" title="Décisions" data-goto="decisions" data-task="${esc(t.id)}">Déc</button>` +
    `<button class="icon-btn" title="Plans" data-goto="plans" data-task="${esc(t.id)}">Plans</button>`;
  if (ME && ME.is_admin) {
    html += `<button class="icon-btn danger-btn" title="Archiver la tâche et tout ce qui lui est rattaché" data-archive="${esc(t.id)}">Archiver</button>`;
  }
  html += `</div>`;
  return html;
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
  cards.push(['Worktrees', s.worktrees], ['Décisions ouvertes', s.openDecisions], ['Archivées', s.archived || 0]);
  document.getElementById('pane-overview').innerHTML =
    `<div class="cards">${cards.map(([l, n]) => `<div class="card"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('')}</div>` +
    `<div class="muted-sm">Registre : ${s.byStatus && Object.keys(s.byStatus).length ? 'connecté' : 'vide / non initialisé'}</div>`;
}

// --- Tâches ----------------------------------------------------------------
async function renderTasks() {
  const data = await api('/api/tasks');
  const tasks = data.tasks || [];
  const projects = [...new Set(tasks.map((t) => t.project).filter(Boolean))];
  document.getElementById('pane-tasks').innerHTML = `
    <h2>Tâches</h2>
    <div class="filters">
      <select id="f-project"><option value="">Tous les projets</option>${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>
      <select id="f-status"><option value="">Tous les statuts</option></select>
    </div>
    <table><thead><tr><th>ID</th><th>Projet</th><th>Type</th><th>Priorité</th><th>Statut</th><th>Demande</th><th>Session</th><th>Détails</th></tr></thead>
    <tbody id="tasks-body"></tbody></table>`;
  const statuses = [...new Set(tasks.map((t) => t.status || 'queued'))];
  document.getElementById('f-status').innerHTML = `<option value="">Tous les statuts</option>` + statuses.map((s) => `<option>${esc(s)}</option>`).join('');
  const apply = () => {
    const p = document.getElementById('f-project').value;
    const st = document.getElementById('f-status').value;
    const rows = tasks.filter((t) => (!p || t.project === p) && (!st || (t.status || 'queued') === st));
    document.getElementById('tasks-body').innerHTML = rows.map((t) =>
      `<tr><td class="code">${esc(t.id)}</td><td>${esc(t.project)}</td><td>${esc(t.type)}</td><td>${esc(t.priority)}</td><td>${badge(t.status)}</td><td>${esc((t.request || '').slice(0, 90))}</td><td>${sessionLink(t.session_id)}</td><td>${detailsButtons(t)}</td></tr>`,
    ).join('') || '<tr><td colspan="8" class="muted">Aucune tâche</td></tr>';
    document.querySelectorAll('#tasks-body [data-goto]').forEach((b) => b.addEventListener('click', () => goToTab(b.dataset.goto, b.dataset.task)));
    document.querySelectorAll('#tasks-body [data-archive]').forEach((b) => b.addEventListener('click', () => openArchiveConfirm(b.dataset.archive)));
  };
  document.getElementById('f-project').addEventListener('change', apply);
  document.getElementById('f-status').addEventListener('change', apply);
  apply();
}

// --- Worktrees -------------------------------------------------------------
async function renderWorktrees() {
  const data = await api('/api/worktrees' + taskQuery());
  const wt = data.worktrees || [];
  document.getElementById('pane-worktrees').innerHTML = `
    <h2>Worktrees</h2>
    ${filterBar()}
    <table><thead><tr><th>ID</th><th>Projet</th><th>Branche</th><th>Statut</th><th>Agent</th><th>Tâche</th><th>Lease jusqu'à</th></tr></thead>
    <tbody>${wt.map((w) => `<tr><td class="code">${esc(w.worktree_id)}</td><td>${esc(w.project)}</td><td class="code">${esc(w.branch)}</td><td>${badge(w.status)}${w.leaseExpired ? ' <span class="badge crashed">expiré</span>' : ''}</td><td>${esc(w.agent)}</td><td class="code">${esc(w.task_id)}</td><td>${esc((w.lease_until || '').replace('T', ' ').replace('Z', ''))}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aucun worktree</td></tr>'}</tbody></table>`;
  bindTaskFilter();
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

// --- Navigation ------------------------------------------------------------
const RENDER = {
  overview: renderOverview, tasks: renderTasks, worktrees: renderWorktrees,
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
  refreshTimer = setInterval(() => { if (!document.hidden) refreshActive(); }, REFRESH_S * 1000);
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
    if (!document.hidden) refreshActive();
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
