# 05 — Référence / Reference

> Référence technique : modèle de données, machines à états, configuration, glossaire.

---

## 1. Modèle de données (PostgreSQL)

Base `task_registry` :

| Table | Rôle | Colonnes clés |
|---|---|---|
| `tasks` | Tâche (le « quoi ») | `id`, `request`, `project`, `type`, `audit_target`, `priority`, `scope`, `recette_status` (pending/in_progress/done), `recette_class` (si issue d'une recette), `version` |
| `projects` | Projet enregistré | `id`, `name`, `workspace`, `git_path`, `main_branch` (obligatoire pour déployer) |
| `executions` | Exécution de la tâche (statut grossier) | `execution_id`, `task_id`, `attempt`, `status` |
| `task_sessions` | Sessions opencode liées à une tâche (append-only) | `task_id`, `session_id`, `kind` (launch/rework/relaunch/recette), `created_at` |
| `task_links` | Tâches liées (v0.6.0) | `task_id`, `linked_task_id`, `description` (nature de la liaison) |
| `plan_executions` | Exécution d'un plan (cycle complet) | `plan_id`, `attempt`, `status` |
| `plan_commits` | Commits d'un plan (trace append-only, fichiers + diff) | `plan_id`, `sha`, `message`, `files`, `created_at` |
| `events` | Journal append-only | `event_id`, `task_id`, `type`, `by`, `detail` (dont `TRANSITION`, `TRANSITION_ERROR`, `BLOCKED`, `AUDIT_COMPLETED`, `WAITING_VALIDATION`…) |
| `deployments` | Suivi CI/CD | `deployment_id`, `task_id`, `status` |
| `decisions` | Décisions humaines | `decision_id`, `task_id`, `kind`, `status`, `plan_id`, `resolution` |
| `participants` | Agents participants | `task_id`, `agent`, `role` |
| `artifacts` | Documents liés | `artifact_id`, `task_id`, `kind`, `path` |
| `worktrees` | Worktrees (legacy) | `worktree_id`, `project`, `status` |
| `plans` | Plans d'action | `id`, `task_id`, `objective`, `branch` |
| `plan_steps` | Étapes d'un plan | `plan_id`, `step_id`, `status` |
| `plan_incidents` / `plan_inconsistencies` | Incidents / incohérences | `plan_id`, `status` |
| `plan_counters` | Compteurs INC-/INCO- | `name`, `value` |
| `scope_conflicts` | Conflits de scope persistés (v0.3.0) | `project`, `scope`, `conflicting_task_id`, `worktree_id`, `status` |
| `recettes` | Recette = objet de PROJET (v0.8.0) | `recette_id`, `project`, `title`, `session_id`, `status` (pending/in_progress/done), `confirmed_at` |
| `recette_items` | Éléments de recette | `recette_id`, `content`, `classification` (rework/bug/improvement/feature), `title`, `acceptance`, `scope`, `status`, `created_task_id` |
| `notifier_state` | High-water marks du notifier (v0.1.0) | `stream`, `last_id`, `last_ts` |
| `notifier_dedup` | Déduplication des envois (v0.1.0) | `stream`, `key`, `sent_at` |
| `audit_notifications` | Miroir des incidents/incohérences d'audit (v0.1.0) | `id`, `kind`, `audit_id`, `status`, `resolved_at` |

Base `panel` : `users`, `sessions`, `archives`.

## 2. Machines à états

**Tâche** (`TASK_TRANSITIONS`) — phases grossières :
```
queued → started → planning → awaiting_validation → planned → in_progress → done
(+ blocked / failed / aborted / crashed ; done → rework)
rework → planned / in_progress / blocked / failed / aborted / done   (v0.2.1 : rework NON terminal)
```

**Plan** (`PLAN_TRANSITIONS`) — cycle complet :
```
planned → in_progress → validating → review → approved → merge_pending → merged
        → deploy_pending → deploying → deployed → post_deploy_verified → done
(+ rejected → rework ; rework → in_progress ; blocked / failed / aborted)
```

**Recette** (colonne `recette_status` + table `recettes`, v0.7.0) : la recette est
une **opération de vérification** distincte — `pending` (pas faite) →
`in_progress` (session dédiée `agent-recette` lancée) → `done` (faite, après
« Terminer la recette » + confirmation). La tâche initiale reste `done` et
intacte ; les travaux découverts deviennent de **nouvelles tâches** typées
(`recette_class` : rework/bug/improvement/feature) liées à la tâche
(`task_links`). `approved`/`rejected` (legacy) sont gérés en lecture.

## 3. Endpoints observabilité (panneau, v0.2.0 → v0.7.4)

`GET /api/metrics/*` (authentifié) — dashboard « Observabilité » :
`summary` · `status` · `throughput` · `leadtime` · `agents` · `costs` · `phases` ·
`timeline?taskId=` · `blocked` · `successfailure` · `quality` · `rework` ·
`costvsthroughput` · `hardening` · **`recette`** (statuts, éléments par classe,
tâches générées, durée moyenne). Consommation : `GET /api/tasks/<id>/consumption`.
Recette : `POST /api/tasks/<id>/recette-session` · `POST /api/tasks/<id>/recette-finish`.

## 4. Configuration

**`~/.config/opencode/.env`** :
```
DATABASE_URL=postgres://…/task_registry
PANEL_DATABASE_URL=postgres://…/panel
OPENCODE_SERVER_PASSWORD=…
```

**`~/.config/opencode/opencode.jsonc`** : déclare les MCP (task-orchestrator,
plan-manager, audit-manager, coder-workspaces, oniria-arch, react-arch) et les plugins
(permission-hook, session-env).

**Agents (`~/.config/opencode/agent/*.md`)** : chaque agent déclare `model`, `mode`,
`permission`. Le modèle peut être surchargé depuis l'onglet **Écosystème** du panneau ;
au lancement, `session-bridge` force `--model` (opencode met les définitions d'agents
en cache au démarrage, le `--model` explicite garantit la prise en compte).

**`docker-compose.yml`** : PostgreSQL (voir `04-reproduction.md`).

## 5. Glossaire

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
| Branche principale | `main_branch` d'un projet — obligatoire pour autoriser le déploiement (pull avant push). |

---

## English version

**1. Data model (PostgreSQL)** — database `task_registry`:

| Table | Role | Key columns |
|---|---|---|
| `tasks` | Task (the "what") | `id`, `request`, `project`, `type`, `audit_target`, `priority`, `scope`, `recette_status` (pending/in_progress/done), `recette_class` (if from a recette), `version` |
| `projects` | Registered project | `id`, `name`, `workspace`, `git_path`, `main_branch` (required to deploy) |
| `executions` | Task execution (coarse status) | `execution_id`, `task_id`, `attempt`, `status` |
| `task_sessions` | opencode sessions linked to a task (append-only) | `task_id`, `session_id`, `kind` (launch/rework/relaunch/recette), `created_at` |
| `task_links` | Linked tasks (v0.6.0) | `task_id`, `linked_task_id`, `description` |
| `plan_executions` | Plan execution (full cycle) | `plan_id`, `attempt`, `status` |
| `plan_commits` | Plan commits (append-only trace, files + diff) | `plan_id`, `sha`, `message`, `files`, `created_at` |
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
| `scope_conflicts` | Persisted scope conflicts (v0.3.0) | `project`, `scope`, `conflicting_task_id`, `worktree_id`, `status` |
| `recettes` | Recette operation (v0.7.0) | `recette_id`, `task_id`, `session_id`, `status`, `confirmed_at` |
| `recette_items` | Recette items | `recette_id`, `content`, `classification`, `title`, `acceptance`, `scope`, `status`, `created_task_id` |
| `notifier_state` | Notifier high-water marks (v0.1.0) | `stream`, `last_id`, `last_ts` |
| `notifier_dedup` | Send dedup (v0.1.0) | `stream`, `key`, `sent_at` |
| `audit_notifications` | Audit incidents/inconsistencies mirror (v0.1.0) | `id`, `kind`, `audit_id`, `status`, `resolved_at` |

Database `panel`: `users`, `sessions`, `archives`.

**2. State machines** — **Task** (coarse): `queued → started → planning →
awaiting_validation → planned → in_progress → done` (+ `blocked`/`failed`/`aborted`/
`crashed`; `done → rework`; since v0.2.1 `rework` is **non-terminal**:
`rework → planned / in_progress / blocked / failed / aborted / done`). **Plan** (full):
`planned → in_progress → validating → review → approved → merge_pending → merged →
deploy_pending → deploying → deployed → post_deploy_verified → done` (+ `rejected →
rework`). **Acceptance** (`recette_status`): `pending → approved/rejected`, independent
of execution status.

**3. Observability endpoints** (panel, v0.2.0 → v0.4.0) — authenticated
`GET /api/metrics/*`: `summary` · `status` · `throughput` · `leadtime` · `agents` ·
`costs` · `phases` · `timeline?taskId=` · `blocked` · `successfailure` · `quality` ·
`rework` · `costvsthroughput` · `hardening`. Consumption:
`GET /api/tasks/<id>/consumption`.

**3. Configuration** — `~/.config/opencode/.env` (`DATABASE_URL`, `PANEL_DATABASE_URL`,
`OPENCODE_SERVER_PASSWORD`), `opencode.jsonc` (MCP servers + plugins), agent `.md` files
(each declares `model`/`mode`/`permission`; the model can be overridden from the panel's
**Ecosystem** tab, and `session-bridge` forces `--model` at launch since opencode caches
agent definitions at startup), `docker-compose.yml` (PostgreSQL).

**4. Glossary** — Task, Plan/sub-task, Decision, Acceptance (recette), Session,
Worktree, State, Aggregation.
