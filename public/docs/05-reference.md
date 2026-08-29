# 05 — Référence / Reference

> Référence technique : modèle de données, machines à états, configuration, glossaire.

---

## 1. Modèle de données (PostgreSQL)

Base `task_registry` :

| Table | Rôle | Colonnes clés |
|---|---|---|
| `tasks` | Tâche (le « quoi ») | `id`, `request`, `project`, `type`, `priority`, `scope`, `recette_status`, `version` |
| `projects` | Projet enregistré | `id`, `name`, `workspace`, `git_path` |
| `executions` | Exécution de la tâche (statut grossier) | `execution_id`, `task_id`, `attempt`, `status` |
| `plan_executions` | Exécution d'un plan (cycle complet) | `plan_id`, `attempt`, `status` |
| `events` | Journal append-only | `event_id`, `task_id`, `type`, `by`, `detail` |
| `deployments` | Suivi CI/CD | `deployment_id`, `task_id`, `status` |
| `decisions` | Décisions humaines | `decision_id`, `task_id`, `kind`, `status`, `plan_id`, `resolution` |
| `participants` | Agents participants | `task_id`, `agent`, `role` |
| `artifacts` | Documents liés | `artifact_id`, `task_id`, `kind`, `path` |
| `worktrees` | Worktrees (legacy) | `worktree_id`, `project`, `status` |
| `plans` | Plans d'action | `id`, `task_id`, `objective`, `branch` |
| `plan_steps` | Étapes d'un plan | `plan_id`, `step_id`, `status` |
| `plan_incidents` / `plan_inconsistencies` | Incidents / incohérences | `plan_id`, `status` |
| `plan_counters` | Compteurs INC-/INCO- | `name`, `value` |

Base `panel` : `users`, `sessions`, `archives`.

## 2. Machines à états

**Tâche** (`TASK_TRANSITIONS`) — phases grossières :
```
queued → started → planning → awaiting_validation → planned → in_progress → done
(+ blocked / failed / aborted / crashed ; done → rework)
```

**Plan** (`PLAN_TRANSITIONS`) — cycle complet :
```
planned → in_progress → validating → review → approved → merge_pending → merged
        → deploy_pending → deploying → deployed → post_deploy_verified → done
(+ rejected → rework ; blocked / failed / aborted)
```

**Recette** (colonne `recette_status`) : `pending → approved/rejected`, indépendante du
statut d'exécution.

## 3. Configuration

**`~/.config/opencode/.env`** :
```
DATABASE_URL=postgres://…/task_registry
PANEL_DATABASE_URL=postgres://…/panel
OPENCODE_SERVER_PASSWORD=…
```

**`~/.config/opencode/opencode.jsonc`** : déclare les MCP (task-orchestrator,
plan-manager, audit-manager, coder-workspaces, oniria-arch, react-arch) et les plugins
(permission-hook, session-env).

**`docker-compose.yml`** : PostgreSQL (voir `04-reproduction.md`).

## 4. Glossaire

| Terme | Définition |
|---|---|
| Tâche / Task | Unité de travail enregistrée, statut grossier. |
| Plan / sous-tâche | Découpage d'une tâche, cycle d'exécution indépendant. |
| Décision | Point de validation humaine (validation/review/recette/permission). |
| Recette | Acceptation humaine finale après déploiement. |
| Session | Session opencode (agent) lancée pour traiter la tâche. |
| Worktree | Checkout git isolé, créé/supprimé par l'agent exécutant. |
| État / State | Statut d'exécution (tâche ou plan). |
| Agrégation | Transition de tâche déclenchée quand toutes les décisions d'un type sont résolues. |

---

## English version

**1. Data model (PostgreSQL)** — database `task_registry`:

| Table | Role | Key columns |
|---|---|---|
| `tasks` | Task (the "what") | `id`, `request`, `project`, `type`, `priority`, `scope`, `recette_status`, `version` |
| `projects` | Registered project | `id`, `name`, `workspace`, `git_path` |
| `executions` | Task execution (coarse status) | `execution_id`, `task_id`, `attempt`, `status` |
| `plan_executions` | Plan execution (full cycle) | `plan_id`, `attempt`, `status` |
| `events` | Append-only journal | `event_id`, `task_id`, `type`, `by`, `detail` |
| `deployments` | CI/CD tracking | `deployment_id`, `task_id`, `status` |
| `decisions` | Human decisions | `decision_id`, `task_id`, `kind`, `status`, `plan_id`, `resolution` |
| `participants` | Participating agents | `task_id`, `agent`, `role` |
| `artifacts` | Linked documents | `artifact_id`, `task_id`, `kind`, `path` |
| `worktrees` | Worktrees (legacy) | `worktree_id`, `project`, `status` |
| `plans` | Action plans | `id`, `task_id`, `objective`, `branch` |
| `plan_steps` | Plan steps | `plan_id`, `step_id`, `status` |
| `plan_incidents` / `plan_inconsistencies` | Incidents / inconsistencies | `plan_id`, `status` |
| `plan_counters` | INC-/INCO- counters | `name`, `value` |

Database `panel`: `users`, `sessions`, `archives`.

**2. State machines** — **Task** (coarse): `queued → started → planning →
awaiting_validation → planned → in_progress → done` (+ `blocked`/`failed`/`aborted`/
`crashed`; `done → rework`). **Plan** (full): `planned → in_progress → validating →
review → approved → merge_pending → merged → deploy_pending → deploying → deployed →
post_deploy_verified → done` (+ `rejected → rework`). **Acceptance**
(`recette_status`): `pending → approved/rejected`, independent of execution status.

**3. Configuration** — `~/.config/opencode/.env` (`DATABASE_URL`, `PANEL_DATABASE_URL`,
`OPENCODE_SERVER_PASSWORD`), `opencode.jsonc` (MCP servers + plugins), `docker-compose.yml`
(PostgreSQL).

**4. Glossary** — Task, Plan/sub-task, Decision, Acceptance (recette), Session,
Worktree, State, Aggregation.
