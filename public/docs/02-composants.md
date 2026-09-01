# 02 — Composants / Components

> Détail des composants du framework. Chaque section couvre : rôle, responsabilités,
> interactions et fichiers clés.

---

## 1. Le panneau web (centre de pilotage)

**Rôle** : interface web (`orchestrator.madatalk.fr`) pour **superviser** et **piloter**
les tâches, sans jamais écrire directement dans le registre.

**Caractéristiques** :
- Process PM2 (`orchestrator-panel`), port 4000, derrière un reverse-proxy.
- Authentification (users/sessions, admin), base dédiée `panel` (PostgreSQL).
- **Lecture seule** du registre (`task_registry`), via `pg` directement.
- **Écritures** via le MCP `task-orchestrator` (spawn d'un process par appel).
- **Écosystème** : l'onglet Écosystème liste les agents et permet d'éditer leur `model`
  globalement (relu au lancement de session via `--model`).

**Onglets** : Vue d'ensemble, **Observabilité** (v0.2.0+), Projets, Tâches,
Événements, Déploiements, Décisions, Documents, Plans, Archives, Écosystème,
Utilisateurs.

**Observabilité** (v0.2.0 → v0.4.0) : dashboard KPI système (Flow ·
Orchestration · Agents · Quality) — KPI cards (Lead Time P50/moyen/P95, Cycle
Time, Success Rate = done + recette approuvée, Throughput, Rework), graphiques
Chart.js (vendu localement), waterfall des phases, blocages par raison,
table de performance des agents, coûts/tokens, funnel qualité. Endpoints :
`GET /api/metrics/*` (voir `05-reference.md` §3).

**Fonctions de pilotage** (`pilot.mjs`) :
| Fonction | Rôle |
|---|---|
| `createTask` | Créer une tâche (statut `queued`) |
| `launchTask` | Lancer : `queued → started` + session orchestrator |
| `reworkTask` | Reprise après rejet (continuer / nouvelle session, session + remarques préremplies) |
| `killTaskSession` | Tuer la session + abandonner la tâche |
| `relaunchTask` | Relancer une tâche abandonnée |
| `resolveRecette` | Valider/rejeter la recette |
| `resolveDecision` | Approuver/rejeter une décision (**réveille la session orchestrateur**) |
| `createProject` | Créer un projet (**branche principale obligatoire** + répertoire créé dans le workspace) |
| `launchRecetteSession` | Lancer/rejoindre la session dédiée `agent-recette` (v0.7.0) |
| `finishRecette` | « Terminer la recette » : créer les tâches (par élément classifié) + confirmer |

**Session bridge** (`session-bridge.mjs`) : lance une session opencode détachée
(`opencode run --agent <agent> --model <model> --attach http://127.0.0.1:4096`) et
capture son `sessionId`. Le `--model` est relu depuis la définition de l'agent (pour
forcer le modèle malgré la mise en cache des définitions par opencode).

## 2. L'agent orchestrator

**Rôle** : le **seul propriétaire des transitions d'état** des tâches. Il coordonne
les agents, ne modifie jamais le code du projet lui-même.

**Pipeline** (résumé — voir `03-workflow.md`) :
1. Enregistrer la tâche (`task_register`) ou la récupérer (panneau).
2. Résoudre le workspace Coder (`coder-workspaces`).
3. Détecter les conflits de scope.
4. Déléguer à `atomic-plan` (planification).
5. Validation humaine des plans (`decision_request` kind `validation`).
6. Déléguer à `build-notify` (exécution, par plan).
7. Review humaine (`decision_request` kind `review`).
8. Merge + déploiement CI/CD (par plan).
9. Clôture + recette.

**Principes** : mission ≠ méthode ; il décide des transitions, les agents publient des
événements ; il pilote **par plan** (`plan_transition`) pour le cycle fin.

## 3. Les sous-agents

| Agent | Rôle | Permissions |
|---|---|---|
| `atomic-plan` | Planification à granularité atomique (produit des `Plan-*.md`) | read-only (édition restreinte à plans/reports) |
| `build-notify` | Exécution des plans + traçabilité (événements, artefacts, commits) | pleine (isolation Coder + worktree) |
| `agent-recette` | Recette : accompagne la vérification, enregistre les éléments (classifiés), prépare la synthèse (v0.7.0) | read-only (inspection) |
| `hexagonal-architecture-auditor` | Audit architecture backend (hexagonale/DDD) | read-only |
| `clean-arch-detector-react` | Audit architecture frontend (feature-based) | read-only |

Les agents read-only ont des permissions `bash` restreintes (commandes de lecture +
`git` read-only) et n'écrivent jamais dans le code.

Les auditeurs sont délégués selon la **cible** de la tâche (`audit_target`) :
`backend` → hexagonal-architecture-auditor, `frontend` → clean-arch-detector-react,
`both` → les deux. `build-notify` publie en fin de sous-tâche la trace de ses commits
via `plan_commit_add` (sha + fichiers + diff).

## 4. Le registre de tâches (MCP task-orchestrator + PostgreSQL)

**Rôle** : source de vérité **logique** de l'orchestration. L'état **physique** reste
Git.

- Base PostgreSQL `task_registry` (migrée depuis SQLite).
- Tables : `tasks`, `projects`, `executions`, `task_sessions`, `worktrees`, `events`,
  `deployments`, `decisions`, `participants`, `artifacts`, `plans`, `plan_steps`,
  `plan_incidents`, `plan_inconsistencies`, `plan_counters`, `plan_executions`,
  `plan_commits`.
- **Machines à états** : tâche (phases grossières) + plan (cycle complet) — voir
  `05-reference.md`.

**Outils MCP clés** : `task_register`, `task_transition`, `plan_transition`,
`task_event`, `decision_request`, `decision_resolve`, `task_recette`, `task_get`,
`task_link_session`, `plan_commit_add`, `plan_commits_list`, …

## 5. MCP métier & Skills

**MCP** :
| MCP | Rôle |
|---|---|
| `plan-manager` | Persistance + suivi des plans (progression, incidents, incohérences) |
| `audit-manager` | Traitement des rapports d'audit (fichiers `audits/.audit-manager`) |
| `coder-workspaces` | Découverte/résolution des workspaces Coder + exécution non-root |
| `oniria-arch` | Audit d'architecture backend (règles hexagonales/DDD) |
| `react-arch` | Audit d'architecture frontend (feature-based) |

**Skills** : `task-execution`, `plan-manager`, `audit-manager`, `coder-workspace-locations`,
`oniria-package-deploiement`, `customize-opencode`.

## 6. Le workspace Coder

- Un **workspace Coder** par projet (ex. `ONIRIA`), volume Docker monté sur l'hôte.
- Les agents **lisent** le code via `workspace_resolve` (chemin hôte) et **exécutent**
  via `workspace_exec` en **non-root** (utilisateur `coder`, uid 1000).
- **Jamais** d'exécution du code projet sur l'hôte.

## 7. Git & CI/CD

- Un dépôt par composant (voir `README.md`).
- Branches `feature/*` ; **merge sur `main` uniquement après validation humaine**.
- Isolation des sessions concurrentes via `session-guard` (worktree dédié).
- **Déploiement** : uniquement via pipeline CI/CD (`gh workflow run` ou skill
  `oniria-package-deploiement`) — jamais manuel.

---

## English version

**1. Web panel (control center)** — web interface (`orchestrator.madatalk.fr`) to
supervise and pilot tasks, never writing directly to the registry. PM2 process, port
4000, behind a reverse proxy. Auth (users/sessions), dedicated `panel` database
(PostgreSQL). Read-only access to the registry (`task_registry`, via `pg`); writes go
through the MCP `task-orchestrator`. Tabs: Overview, Projects, Tasks, Events,
Deployments, Decisions, Documents, Plans, Archives, Ecosystem, Users. The **Ecosystem**
tab lists agents and lets you edit their `model` globally. Pilot functions:
`createTask`, `launchTask` (`queued → started` + orchestrator session), `reworkTask`,
`killTaskSession`, `relaunchTask`, `resolveRecette`, `resolveDecision`. The session
bridge (`session-bridge.mjs`) launches a detached opencode session
(`opencode run --agent <agent> --model <model> --attach http://127.0.0.1:4096`), forcing
`--model` from the agent definition (opencode caches agent definitions at startup).

**2. Orchestrator agent** — the **single owner of task state transitions**; it
coordinates agents and never edits project code. Pipeline: register task → resolve
Coder workspace → detect scope conflicts → delegate to `atomic-plan` → human validation
→ delegate to `build-notify` (per plan) → human review → merge + CI/CD deploy (per
plan) → closure + acceptance. Principles: mission ≠ method; it decides transitions,
agents publish events; it pilots **per plan** (`plan_transition`).

**3. Sub-agents** — `atomic-plan` (atomic-grained planning, read-only),
`build-notify` (executes plans, publishes events/artifacts/commit trace via
`plan_commit_add`), `hexagonal-architecture-auditor` (backend audit),
`clean-arch-detector-react` (frontend audit). Auditors are delegated according to the
task's `audit_target` (`backend`/`frontend`/`both`). Read-only agents have restricted
`bash` permissions (read-only commands + git read-only). Sub-agents never send emails:
notifications are centralized in the `opencode-notifier` daemon (see §8).

**4. Notifier daemon (`opencode-notifier`, v0.1.0)** — the **only** component that
sends emails. It watches the registry (events, decisions, deployments,
`plan_incidents`, `plan_inconsistencies`, `audit_notifications`) via hybrid
LISTEN/NOTIFY + polling (high-water marks in `notifier_state`, dedup in
`notifier_dedup`) and emails the user with database data via
`scripts/send-mail.mjs`. The MCP `notify` tools were removed.

**5. Task registry** (MCP `task-orchestrator` + PostgreSQL) — logical source of truth.
Tables: `tasks`, `projects`, `executions`, `task_sessions`, `worktrees`, `events`,
`deployments`, `decisions`, `participants`, `artifacts`, `plans`, `plan_steps`,
`plan_incidents`, `plan_inconsistencies`, `plan_counters`, `plan_executions`,
`plan_commits`. Two state machines: task (coarse phases) + plan (full cycle). Key
tools: `task_register`, `task_transition`, `plan_transition`, `task_event`,
`decision_request`, `decision_resolve`, `task_recette`, `task_get`, `task_link_session`,
`plan_commit_add`, `plan_commits_list`.

**6. Business MCP & Skills** — `plan-manager` (plans persistence/tracking),
`audit-manager` (audit reports treatment, file-based), `coder-workspaces` (Coder
discovery + non-root exec), `oniria-arch`/`react-arch` (architecture audits) + skills
(`task-execution`, `plan-manager`, `audit-manager`, `coder-workspace-locations`,
`oniria-package-deploiement`, `customize-opencode`).

**7. Coder workspace** — one workspace per project, Docker volume mounted on the host.
Agents read via `workspace_resolve` (host path) and execute via `workspace_exec`
(non-root, user `coder`). Never run project code on the host.

**8. Git & CI/CD** — one repo per component, `feature/*` branches, merge to `main`
only after human validation, session isolation via `session-guard` (dedicated
worktree), deployment only via CI/CD pipeline (`gh workflow run` or
`oniria-package-deploiement`) — never manual.
