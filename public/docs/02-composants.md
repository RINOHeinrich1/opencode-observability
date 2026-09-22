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

**Onglets** — *globaux* (aucun projet ouvert, `GLOBAL_TABS`) : Projets,
Vue d'ensemble, Écosystème, Workspaces (admin), Utilisateurs (admin). *D'un
projet ouvert* (`PROJECT_TABS`) : Vue d'ensemble, Tâches, Recettes, **Recette**
(évaluateur — id de code `evaluations`), Tests E2E, Décisions, **Artefacts**,
**ADR**, **Sprints**, **Fonctionnalités & Règles**, Vars & Secrets E2E, Archives.

> **Deux entités distinctes** (ADR-001) : l'onglet **Recettes** (`recettes`) porte
> le **Cadrage technique** (exécuteur) ; le nouvel onglet **Recette**
> (id de code **`evaluations`**, libellé UI « Recette ») porte la **recette de
> l'ÉVALUATEUR PRODUIT** — objet de premier niveau distinct, sans conversion en
> tâches. Ne pas confondre les identifiants de code (`recettes` vs `evaluations`).

> Les onglets **Déploiements**, **Événements** et **Plans** ne figurent plus dans
> la barre : ils sont accessibles via la section **« Consulter »** du **modal de
> détail d'une tâche** (boutons `data-goto`). Voir
> [`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §5.

**Modèle Sprint / Fonctionnalités / Règles (ADR-001)** :
- Onglet **Vue d'ensemble** : **cartes de cardinalité cliquables** (`CARDINALITY_CARDS`)
  — 10 indicateurs (Tâches/Recettes sans ADR, sans fonctionnalité, sans sprint ;
  ADR sans fonctionnalité ; Sprints sans fonctionnalité, sans règle ; Éléments
  émergents). Un clic ouvre l'onglet cible avec le **filtre pré-appliqué**. Le
  panneau lit l'agrégat `GET /api/cardinality` (source de vérité = registre) et
  **ne recalcule jamais** l'émergence. L'ancien **onglet « Émergents » a été
  retiré** (restitué en carte + filtre « lien manquant »).
- Onglet **Sprints** : liste des sprints (statut, dates, `is_default`), création
  (**durée paramétrable** synchronisée avec l'échéance), **clôture** (manuelle ou
  auto à l'échéance), **reprise**, rattachement de pièces client, **session de
  sprint** (`agent-sprint`), **session de migration**, rapport de sprint, suppression
  (refusée pour le sprint par défaut).
- Onglet **Fonctionnalités & Règles** : **2 sous-onglets** (`frSubTab`) —
  **Fonctionnalités** (`US-xxx`) et **Règles métier** (`RM-xxxx`) — chacun avec ses
  propres **filtres** (recherche, **rôle**, **sprint**, **émergence**,
  **implémentation**, **lien manquant**) et son CRUD. Le sous-onglet
  **Fonctionnalités** expose **3 axes de statut distincts** : **Intégration**
  (implémentée `ecosystem`/`hors_ecosystem`), **Développement**
  (`complet`/`partiel`/`non_demarre`/`incoherent`, analyse du code, **source**
  tracée) et **Tests E2E** (liens **cliquables** 1..N) — plus les **verdicts
  d'évaluation** en lecture seule (axe distinct, voir
  [`15-statuts-fonctionnalites-regles.md`](15-statuts-fonctionnalites-regles.md)) ;
  filtre `fr-f-dev` par statut de développement. Le sous-onglet **Règles métier**
  expose le **statut de RESPECT** (`respectee`/`non_respectee`, colonne
  « Respect », filtre `fr-r-respect`) — **distinct** d'un statut de développement —
  et gère l'**association explicite de rôles** (`roles`) et le **rôle global**
  (`role_global`).

**Modale « Détail projet »** : onglets **Projet / Repos / Pièces client**
uniquement. L'onglet **« Documents de référence » a été retiré** (doublon avec
« Pièces client », les documents ADR-12 étant requalifiés en pièces client) — tout
deep-link `docs` retombe sur « Projet ». Voir
[`12-documents-reference-projets-repos.md`](12-documents-reference-projets-repos.md) §5.

**Création de recette — sélecteurs de contexte** : la modale propose des
sélecteurs multi-lignes (toutes les options cochées par défaut) pour les **ADR**
(`adrIds` → bloc « ADR de référence »), les **Fonctionnalités** (`featureIds` →
bloc « Fonctionnalités de référence ») et les **Règles métier** (`ruleIds` → bloc
« Règles métier de référence ») ; ils sont rattachés à la recette et injectés dans
le prompt de la session `agent-recette`.

**Page « Recette » de l'évaluateur produit (v0.9.42, onglet `evaluations`)** :
page **dédiée** à l'**évaluateur** (`ROLE_ACL.evaluateur`), **distincte** du
Cadrage technique. L'évaluateur y **décrit le parcours évalué**, **rattache 1..N
fonctionnalités** (le **verdict** — `conforme` / `non_conforme` / `a_ameliorer` —
est porté par le lien, au niveau de la fonctionnalité) **et 1..N règles métier**,
**enregistre des éléments** (recommandation | problème, catégorie + sévérité +
statut de suivi) et **joint des pièces** (lien, document, photo, vidéo). Cycle de
vie conservé : `pending` → `in_progress` → `done` — **aucune conversion en
tâches**. **Visibilité** (ADR-002) : l'évaluateur ne voit que **SES** recettes
(filtre `recetteOwnerScope` sur `evaluations.created_by`) ; admin/superviseur
voient **toutes** les recettes (superviseur en lecture seule) ; l'**exécuteur**
les voit en **lecture seule** (`/api/evaluations` en GET). Modales : création
(parcours + fonctionnalités + règles + pièces), détail (éléments + verdicts +
pièces), élément, pièces.

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

- Base PostgreSQL `task_registry` (migrée depuis SQLite) ; **version logique du
  schéma** marquée dans `schema_meta` (`SCHEMA_VERSION`, `db.mjs`) — `ensureSchema()`
  saute le rejeu quand le marqueur est à jour.
- Tables (principales) : `tasks`, `projects`, `repos`, `project_repos`, `task_repos`,
  `executions`, `task_sessions`, `task_links`, `worktrees`, `events`,
  `deployments`, `decisions`, `participants`, **`artifacts`** (gestionnaire central
  polymorphe) + `artifact_projects` / `artifact_repos`, `plans`, `plan_steps`,
  `plan_incidents`, `plan_inconsistencies`, `plan_counters`, `plan_executions`,
  `plan_commits`, `recettes`, `recette_items`, `recette_tasks`, `e2e_tests`,
  **`evaluations`**, **`evaluation_fonctionnalites`** (verdict par fonctionnalité),
  **`evaluation_regles`**, **`evaluation_items`** (recommandation/problème),
  `e2e_test_projects` / `e2e_test_repos` / `e2e_test_params` / `e2e_vars`,
  `task_e2e`, `e2e_executions`, **`adr_conflicts`**, **`adr_vigilances`**,
  **`sprints`**, **`fonctionnalites`**, **`regles_metier`**, **`cardinality_signals`**,
  **`migrations`**, **`adr_conversions`**, **`recette_regles`**, **`task_adr`**,
  `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces`, `fonctionnalite_regles`
  / `fonctionnalite_gherkin` / `fonctionnalite_adr`, `task_sprints` /
  `task_fonctionnalites`, `recette_sprints` / `recette_fonctionnalites` / `recette_adr`.
- **Machines à états** : tâche (phases grossières) + plan (cycle complet) + **ADR**
  (`Proposé → Accepté → Déprécié → Remplacé`) — voir `05-reference.md`.

**Outils MCP clés** : `task_register`, `task_transition`, `plan_transition`,
`task_event`, `decision_request`, `decision_resolve`, `task_recette`, `task_get`,
`task_link_session`, `plan_commit_add`, `plan_commits_list`, **`artifact_add` /
`artifact_list`** (gestionnaire central d'artefacts), **famille `adr_*`**
(ADR structurées : `adr_list`, `adr_get`, `adr_search`, `adr_context`,
`adr_register`, `adr_set_status`, `adr_update`, `adr_attach`,
`adr_report_conflict`, `adr_report_missing`, `adr_vigilance_list`,
`adr_vigilance_resolve`), `doc_*` (documents de référence).

**Familles MCP du modèle sprint/fonctionnalités/règles** (détail : `05-reference.md` §1bis) :
`sprint_*` (dont `sprint_start`, `sprint_close`, `sprint_reopen`, `sprint_report`,
`sprint_session_set`, `sprint_delete`, `sprint_migrate_elements`),
`feature_*` (CRUD + `feature_mark_implemented`, `feature_context`, liens
règle/gherkin/adr/sprint), `rule_*` (CRUD + `rule_mark_implemented`, `rule_context`,
lien sprint, `roles`/`role_global`), `migration_*` (`migration_start`/`_get`/`_list`/
`_finish`/`_session_set`), `adr_conversion_*` (`adr_convert`,
`adr_conversion_link`, `adr_conversion_list`), `cardinality_*`
(`cardinality_report`, `cardinality_signals_list`, `cardinality_signal_resolve`),
`recette_rule_link`/`recette_rule_unlink` (et `recette_feature_link` /
`recette_adr_link` / `recette_sprint_link`). Voir
[`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §2 et §4.

**Famille MCP `evaluation_*`** (recette évaluateur, v0.9.42) : `evaluation_start`,
`evaluation_list`, `evaluation_get`, `evaluation_item_add` / `_update` / `_delete`,
`evaluation_feature_link` / `_unlink`, `evaluation_rule_link` / `_unlink`,
`evaluation_verdict_set`, `evaluation_doc_add` / `_remove`, `evaluation_confirm`
(clôture **sans** conversion en tâches). Détail : `05-reference.md` §1bis.

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
- **Ouverture de l'IDE web** depuis le panneau sans compte Coder : le lien passe
  par `GET /api/coder/ide?url=…`, qui pose le cookie de session Coder (token
  d'organisation renouvelé automatiquement) sur le domaine partagé puis redirige.
  Évite le partage de workspace Coder (non supporté pour l'IDE web).

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
through the MCP `task-orchestrator`. Tabs — *global* (no project open): Projects,
Overview, Ecosystem, Workspaces (admin), Users (admin); *project sub-tabs*
(`PROJECT_TABS`): Overview, Tasks, Recettes, E2E Tests, Decisions, **Artifacts**,
**ADR**, **Sprints**, **Features & Rules**, E2E Vars & Secrets, Archives. The
Deployments/Events/Plans tabs were removed and are reachable from the **task detail
modal** ("Consulter"). **Sprint / Features / Rules model (ADR-001)**: the Overview
shows **clickable cardinality cards** (10 indicators, from `GET /api/cardinality` —
the panel never recomputes emergence; the former **"Emergents" tab was removed**);
the **Sprints** tab handles the sprint lifecycle (configurable duration, auto-close,
reopen, pieces, sprint/migration sessions, report); the **Features & Rules** tab has
**2 sub-tabs** (Features `US-xxx` / Business rules `RM-xxxx`) each with its own
filters (search, **role**, **sprint**, **emergence**, **implementation**, **missing
link**). The **Project detail modal** has only **Project / Repos / Client pieces**
tabs — the **"Reference documents" tab was removed** (deep-link `docs` falls back to
"Project"). Recette creation offers context selectors (**ADR** + **Features** +
**Rules**). The **Ecosystem** tab lists agents and lets you edit their `model`
globally. Pilot functions:
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
Tables: `tasks`, `projects`, `repos`, `project_repos`, `task_repos`, `executions`,
`task_sessions`, `task_links`, `worktrees`, `events`, `deployments`, `decisions`,
`participants`, **`artifacts`** (central polymorphic manager) + `artifact_projects` /
`artifact_repos`, `plans`, `plan_steps`, `plan_incidents`, `plan_inconsistencies`,
`plan_counters`, `plan_executions`, `plan_commits`, `recettes`, `recette_items`,
`recette_tasks`, `e2e_tests`, `e2e_test_*`, `task_e2e`, `e2e_executions`,
**`adr_conflicts`**, **`adr_vigilances`**, **`sprints`**, **`fonctionnalites`**,
**`regles_metier`**, **`cardinality_signals`**, **`migrations`**, **`adr_conversions`**,
**`recette_regles`**, **`task_adr`** + the N:N link tables. The **logical schema
version** is marked in `schema_meta` (`SCHEMA_VERSION`, `db.mjs`). State machines:
task (coarse phases) + plan (full cycle) + **ADR** (`Proposed → Accepted →
Deprecated → Replaced`). Key tools: `task_register`, `task_transition`,
`plan_transition`, `task_event`, `decision_request`, `decision_resolve`,
`task_recette`, `task_get`, `task_link_session`, `plan_commit_add`,
`plan_commits_list`, **`artifact_add`/`artifact_list`**, the **`adr_*` family**,
`doc_*`, plus the **`sprint_*` / `feature_*` / `rule_*` / `migration_*` /
`adr_conversion_*` / `cardinality_*`** families and `recette_rule_link`/`_unlink`
(see `05-reference.md` §1bis).

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
