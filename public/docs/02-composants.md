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

**Onglets** : Vue d'ensemble, Projets, Tâches, Événements, Déploiements, Décisions,
Documents, Plans, Archives, Écosystème, Utilisateurs.

**Fonctions de pilotage** (`pilot.mjs`) :
| Fonction | Rôle |
|---|---|
| `createTask` | Créer une tâche (statut `queued`) |
| `launchTask` | Lancer : `queued → started` + session orchestrator |
| `reworkTask` | Reprise après rejet (continuer / nouvelle session) |
| `killTaskSession` | Tuer la session + abandonner la tâche |
| `relaunchTask` | Relancer une tâche abandonnée |
| `resolveRecette` | Valider/rejeter la recette |
| `resolveDecision` | Approuver/rejeter une décision |

**Session bridge** (`session-bridge.mjs`) : lance une session opencode détachée
(`opencode run --agent orchestrator --attach http://127.0.0.1:4096`) et capture son
`sessionId`.

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
| `build-notify` | Exécution des plans + notifications email | pleine (isolation Coder + worktree) |
| `hexagonal-architecture-auditor` | Audit architecture backend (hexagonale/DDD) | read-only |
| `clean-arch-detector-react` | Audit architecture frontend (feature-based) | read-only |

Les agents read-only ont des permissions `bash` restreintes (commandes de lecture +
`git` read-only) et n'écrivent jamais dans le code.

## 4. Le registre de tâches (MCP task-orchestrator + PostgreSQL)

**Rôle** : source de vérité **logique** de l'orchestration. L'état **physique** reste
Git.

- Base PostgreSQL `task_registry` (migrée depuis SQLite).
- Tables : `tasks`, `projects`, `executions`, `worktrees`, `events`, `deployments`,
  `decisions`, `participants`, `artifacts`, `plans`, `plan_steps`, `plan_incidents`,
  `plan_inconsistencies`, `plan_counters`, `plan_executions`.
- **Machines à états** : tâche (phases grossières) + plan (cycle complet) — voir
  `05-reference.md`.

**Outils MCP clés** : `task_register`, `task_transition`, `plan_transition`,
`task_event`, `decision_request`, `decision_resolve`, `task_recette`, `task_get`, …

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
