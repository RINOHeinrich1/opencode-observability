# 04 — Reproduction / Reproduction guide

> **FR** — Guide pas-à-pas pour remonter un écosystème opencode semblable, avec les
> commandes exactes et des **prompts opencode** pour l'IA.
> **EN** — Step-by-step guide to rebuild a similar opencode ecosystem, with exact
> commands and **opencode prompts**.

---

## 0. Vue d'ensemble des composants à créer

1. **PostgreSQL** (2 bases : `task_registry`, `panel`).
2. **MCP `task-orchestrator`** (registre + machines à états).
3. **MCP métier** (`plan-manager`, `audit-manager`, `coder-workspaces`, arch).
4. **Agents** (`orchestrator`, `atomic-plan`, `build-notify`, auditeurs).
5. **Panneau web** (`orchestrator-panel`).
6. **Workspace Coder** (projets).
7. **Scripts + plugins** (`session-guard`, `send-mail`, `permission-hook`, …).

> 💡 **Prompt opencode global** (démarrage assisté) :
> ```
> Monte un framework d'orchestration d'agents IA opencode :
> 1) PostgreSQL en Docker (bases task_registry et panel) ;
> 2) un MCP task-orchestrator (registre de tâches + machine à états) ;
> 3) un MCP plan-manager, un MCP audit-manager, un MCP coder-workspaces ;
> 4) des agents : orchestrator, atomic-plan, build-notify, et deux auditeurs d'architecture ;
> 5) un panneau web de supervision (Node) qui lit le registre et pilote les sessions.
> Respecte : source de vérité unique (registre), isolation Coder (non-root), traçabilité (emails).
> ```

## 1. Prérequis

- Node.js ≥ 20, Docker + Docker Compose, `git`, un compte GitHub, un token GitHub.
- `opencode` installé (binaire + config dans `~/.config/opencode/`).

## 2. Étape 1 — PostgreSQL

`docker-compose.yml` :
```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: orchestrator
      POSTGRES_PASSWORD: orchestrator
      POSTGRES_DB: task_registry
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init:/docker-entrypoint-initdb.d:ro
volumes:
  pgdata:
```

`docker/init/01-create-databases.sql` :
```sql
CREATE DATABASE panel;
```

`.env` (global `~/.config/opencode/.env`) :
```
DATABASE_URL=postgres://orchestrator:orchestrator@localhost:5432/task_registry
PANEL_DATABASE_URL=postgres://orchestrator:orchestrator@localhost:5432/panel
```

## 3. Étape 2 — Registre de tâches (MCP task-orchestrator)

Composants : `schema.sql` (tables), `statemachine.mjs` (machines à états), `db.mjs`
(accès `pg`), `index.mjs` (outils MCP).

**Prompt opencode** :
> ```
> Crée un MCP `task-orchestrator` (Node, MCP SDK, PostgreSQL via `pg`) exposant :
> task_register, task_get, task_list, task_transition, plan_transition,
> task_event, events_list, decision_request, decision_resolve, task_recette,
> participant_add, artifact_add, project_register/list/delete, task_delete,
> task_link_session, plan_commit_add, plan_commits_list.
> Tables : tasks (avec audit_target), projects, executions, task_sessions, worktrees,
> events, deployments, decisions, participants, artifacts, plans, plan_steps,
> plan_incidents, plan_inconsistencies, plan_counters, plan_executions, plan_commits.
> Deux machines à états : tâche (queued→started→planning→awaiting_validation→planned
> →in_progress→done) et plan (planned→in_progress→validating→review→approved→
> merge_pending→merged→deploy…→done).
> ```

## 4. Étape 3 — MCP métier + skills

- `plan-manager` : persistance des plans (tables `plans*`), outils `plan_register`,
  `progress_update`, `incident_create`, `inconsistency_create`, …
- `audit-manager` : traitement de rapports d'audit (fichiers, pas de base).
- `coder-workspaces` : `workspace_list`, `workspace_resolve`, `workspace_exec` (non-root).
- `oniria-arch` / `react-arch` : catalogues de règles + outils `check_*` + `generate_report`.

## 5. Étape 4 — Agents

Fichiers `.md` dans `~/.config/opencode/agent/` avec `mode`, `model`, `permission`
(read-only pour planner/auditeurs) et le corps d'instructions.

**Prompt opencode** :
> ```
> Crée les agents opencode suivants (fichiers .md) :
> - orchestrator (mode primary) : seul propriétaire des transitions, coordonne les agents ;
> - atomic-plan : planification atomique, read-only ;
> - build-notify : exécution des plans + notifications email ;
> - hexagonal-architecture-auditor, clean-arch-detector-react : audits read-only.
> ```

## 6. Étape 5 — Panneau web

Node (`server.mjs` + `pilot.mjs` + `session-bridge.mjs` + `public/`), PM2.

- Lecture seule du registre (`pg`), écritures via MCP.
- `session-bridge` : `opencode run --agent orchestrator --attach http://127.0.0.1:4096`.

**Prompt opencode** :
> ```
> Crée un panneau web Node de supervision d'orchestrateur : lecture seule du registre
> PostgreSQL, endpoints REST (tasks, plans, decisions, deployments, events, artifacts,
> archives, consommation par session, modèles d'agents), auth par cookie, et pilotage
> (lancer/rework/kill/relaunch/recette) via MCP.
> ```

## 7. Étape 6 — Workspace Coder + scripts/plugins

- Workspace Coder par projet ; `workspace_exec` en non-root.
- Scripts : `session-guard.mjs` (verrou + worktree par session), `send-mail.mjs`,
  `load-env.mjs`, `record-permission.mjs`, `resolve-permission.mjs`,
  `collect-git-commits.mjs` (trace des commits d'un plan).
- Plugins : `permission-hook.mjs`, `session-env.mjs`.

## 8. Étape 7 — Vérification de bout en bout

1. Démarrer PostgreSQL, le registre, le panneau.
2. Créer un projet + une tâche, lancer : `queued → started → planning → …`.
3. Vérifier la validation/review par plan, le déploiement, la recette.
4. Vérifier les emails + la traçabilité (événements, décisions).

---

## Récapitulatif des prompts opencode (liste)

1. **Global** (voir §0).
2. **task-orchestrator** (voir §3).
3. **Agents** (voir §5).
4. **Panneau** (voir §6).

> Pour un écosystème complet, enchaîner ces prompts et ajuster les `.env` /
> `docker-compose` / `opencode.jsonc` (référencer les MCP et plugins).
