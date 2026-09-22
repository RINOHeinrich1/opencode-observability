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
| `artifacts` | **Gestionnaire central polymorphe** (tous artefacts) | `artifact_id`, `doc_type`, `content_id`, `kind` (nature), `nature`, `source`, `meta`, `title`, `path`, + champs ADR (`status`, `context`, `decision`, `consequences`, `replaced_by`, `is_global`) |
| `artifact_projects` / `artifact_repos` | Rattachement N:N artefact ⇄ projet / repo | `artifact_id`, `project_id` / `repo_id` |
| `worktrees` | Worktrees (legacy) | `worktree_id`, `project`, `status` |
| `plans` | Plans d'action | `id`, `task_id`, `objective`, `branch` |
| `plan_steps` | Étapes d'un plan | `plan_id`, `step_id`, `status` |
| `plan_incidents` / `plan_inconsistencies` | Incidents / incohérences | `plan_id`, `status` |
| `plan_counters` | Compteurs INC-/INCO- | `name`, `value` |
| `scope_conflicts` | Conflits de scope persistés (v0.3.0) | `project`, `scope`, `conflicting_task_id`, `worktree_id`, `status` |
| `recettes` | Recette = objet de PROJET (v0.8.0) | `recette_id`, `project`, `title`, `session_id`, `status` (pending/in_progress/done), `confirmed_at` |
| `recette_items` | Éléments de recette | `recette_id`, `content`, `classification` (rework/bug/improvement/feature), `title`, `acceptance`, `scope`, `status`, `created_task_id` |
| `evaluations` | **Recette de l'ÉVALUATEUR produit** (v0.9.42, objet distinct du cadrage) | `evaluation_id` (`EVAL-…`), `project`, `title`, `description` (**parcours évalué**), `status` (pending/in_progress/done), `confirmed_at`, `created_by` (propriétaire — filtre évaluateur) |
| `evaluation_fonctionnalites` | Fonctionnalités évaluées (1..N) — **le VERDICT est porté par le lien** | `evaluation_id`, `fonctionnalite_id`, `verdict` (conforme/non_conforme/a_ameliorer), `verdict_comment` |
| `evaluation_regles` | Règles métier évaluées (1..N) | `evaluation_id`, `regle_id` |
| `evaluation_items` | Éléments de la recette évaluateur (**recommandation** \| **problème**) | `id`, `evaluation_id`, `content`, `category` (recommandation/probleme), `severity` (low/medium/high/critical), `discussion`, `status` (open/treated/dismissed), **`decision`** (pending/a_traiter/non_retenu — décision admin, v0.9.66), `decided_at`, `decided_by` |
| `cadrage_evaluation_items` | **Reprise** d'un élément de recette évaluateur par un **cadrage technique** (traçage « repris par le cadrage X », v0.9.66) | `recette_id` (cadrage), `evaluation_item_id`, `created_at`, `taken_by` — unicité `(recette_id, evaluation_item_id)` |
| `notifier_state` | High-water marks du notifier (v0.1.0) | `stream`, `last_id`, `last_ts` |
| `notifier_dedup` | Déduplication des envois (v0.1.0) | `stream`, `key`, `sent_at` |
| `audit_notifications` | Miroir des incidents/incohérences d'audit (v0.1.0) | `id`, `kind`, `audit_id`, `status`, `resolved_at` |
| `adr_conflicts` | Conflits code ↔ ADR (persistés, « pas de violation silencieuse ») | `conflict_id`, `adr_id` (→ `artifacts`), `task_id` (nullable), `description`, `status` (open/resolved), `decision_id` (décision `kind='conflict'`) |
| `adr_vigilances` | Points de vigilance ADR en recette/test (append-only, bloquants) | `vigilance_id`, `project`, `recette_id`, `task_id`, `session_id`, `type` (missing/conflict), `status` (open/resolved), `entity`, `description`, `adr_id`, `related_adr_id`, `conflict_id`, `resolution`, `resolution_kind`, `resolved_at`, `resolved_by` |
| `schema_meta` | Marqueur de version **logique** du schéma | `key`, `value`, `updated_at` — clé `schema_version` = `SCHEMA_VERSION` (`db.mjs`) ; permet à `ensureSchema()` de **sauter** le rejeu de `schema.sql` + `migrate()` (chemin rapide) et de le déclencher UNE fois sinon (sous `pg_advisory_lock`). **À incrémenter à chaque évolution DDL** (convention `AAAA-MM-JJ-<description>`) |

### Modèle structuré Sprints / Fonctionnalités / Règles métier (ADR-001)

| Table | Rôle | Colonnes clés |
|---|---|---|
| `sprints` | **Sprint** = unité de temps du projet | `id` (`SPRINT-…`), `project`, `title`, `start_date`, `end_date` (échéance → clôture **auto** si `auto_close`), `status` (`open`/`close`), `is_default` (au plus 1 par projet, index partiel unique), `auto_close`, `closed_at`, `close_reason` (`auto_echeance`/`manuel`), `reopened_at`, `session_id` (session IA `agent-sprint`) |
| `fonctionnalites` | **Fonctionnalité** (`US-xxx`) | `id` (`FEAT-…`), `project`, `ref` (unique par projet), `role`, `user_story`, `sourced_piece_id` (pièce client source), `emergent`/`emergent_origin`, `implemented`/`implemented_origin`/`implemented_at`/`implemented_by`/`implemented_note` |
| `regles_metier` | **Règle métier** (`RM-xxxx`) | `id` (`RMET-…`), `project`, `ref` (unique par projet), `content`, `sourced_piece_id`, `emergent`/`emergent_origin`, `implemented*`, **`roles`** (`TEXT[]`, association explicite 1..N), **`role_global`** (1 = s'applique à tous les rôles) |
| `cardinality_signals` | **Signaux de cardinalité heuristiques** (T6, append-only, **NON bloquants**) | `signal_id`, `project`, `entity_type` (recette/task/adr/sprint), `entity_id`, `missing`, `detail`, `status` (`open`/`resolved`), `origin`, `resolution`, `resolved_at`, `resolved_by` — index partiel unique « **1 seul signal open par entité** » |
| `migrations` | **Session de migration** des anciens sprints (ADR-001 §6) | `migration_id`, `project` (unique), `sprint_id` (= **sprint par défaut** / ancien sprint), `session_id`, `status` (`open`/`in_progress`/`done`/`aborted`), `title`, `finished_at` |
| `adr_conversions` | Lien **historique** ADR monolithique d'origine ↔ ADR atomique convertie (N converties pour 1 origine) | `conversion_id`, `original_adr_id`, `converted_adr_id`, unique par couple |
| `recette_regles` | Recette ⇄ règle métier (N:N) | `recette_id`, `regle_id` |
| `task_adr` | **Lien ADR d'une tâche — workflow PROPOSÉ → VALIDÉ** | `task_id`, `adr_id`, `status` (`propose` = proposé par l'agent, **non effectif** / `valide` = validé par l'humain, **effectif**), `proposed_by`/`proposed_at`, `validated_by`/`validated_at`, `reason` |
| `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces` | Rattachement sprint ⇄ fonctionnalité / règle / pièce client (N:N) | `sprint_id` + `fonctionnalite_id` / `regle_id` / `piece_id` |
| `fonctionnalite_regles` / `fonctionnalite_gherkin` / `fonctionnalite_adr` | Liens fonctionnalité ⇄ règle métier / scénario Gherkin (`e2e_tests`) / ADR (`artifacts`) (N:N) | `fonctionnalite_id` + cible ; **une ADR garde ≥1 fonctionnalité** (trigger `trg_fonctionnalite_adr_min`) |
| `task_sprints` / `task_fonctionnalites` | Rattachement tâche ⇄ sprint / fonctionnalité (N:N) | `task_id` + cible |
| `recette_sprints` / `recette_fonctionnalites` / `recette_adr` | Rattachement recette ⇄ sprint / fonctionnalité / ADR (N:N) | `recette_id` + cible |

> **`SCHEMA_VERSION`** (`db.mjs`, ~l.33) est le marqueur logique reflété en base
> (`schema_meta.schema_version`). Toute évolution de `schema.sql` **ou** de
> `migrate()` doit l'**incrémenter** ; `ensureSchema()` compare le marqueur en
> base à la constante : identique → **chemin rapide** (aucun DDL) ; différent →
> apply complet **une fois** (`schema.sql` + `migrate()`) sous verrou advisory,
> puis écriture du nouveau marqueur. L'idempotence est garantie (toutes les DDL
> sont `IF NOT EXISTS`).

## 1bis. Familles d'outils MCP (registre)

| Famille | Outils | Objet |
|---|---|---|
| `sprint_*` | `sprint_start`, `sprint_list`, `sprint_get`, `sprint_close`, `sprint_reopen`, `sprint_report`, `sprint_attach_pieces`, `sprint_session_set`, `sprint_delete`, `sprint_migrate_elements` | Cycle de vie du sprint (durée paramétrable, clôture auto à l'échéance, reprise), rattachement de pièces, session `agent-sprint`, rapport, migration des éléments hérités (sans faux émergent) |
| `feature_*` | `feature_register`, `feature_list`, `feature_get`, `feature_update`, `feature_delete`, `feature_mark_implemented`, `feature_context`, `feature_rule_link`/`_unlink`, `feature_gherkin_link`/`_unlink`, `feature_adr_link`/`_unlink`, `feature_sprint_link`/`_unlink` | CRUD fonctionnalités + liens N:N (règles, Gherkin, ADR, sprint), qualification d'implémentation (`ecosystem`/`hors_ecosystem`), bloc de contexte |
| `rule_*` | `rule_register`, `rule_list`, `rule_get`, `rule_update`, `rule_delete`, `rule_mark_implemented`, `rule_context`, `rule_sprint_link`/`_unlink` | CRUD règles métier (dont `roles`/`role_global`) + liens sprint, qualification d'implémentation, bloc de contexte |
| `migration_*` | `migration_start`, `migration_get`, `migration_list`, `migration_finish`, `migration_session_set` | Session de migration des anciens sprints (idempotente : 1 par projet), rattachement de la session IA |
| `adr_conversion_*` | `adr_convert`, `adr_conversion_link`, `adr_conversion_list` | Conversion ADR monolithique → ADR atomique (l'origine reste intacte) + lien historique |
| `cardinality_*` | `cardinality_report`, `cardinality_signals_list`, `cardinality_signal_resolve` | Agrégat de traçage des cardinalités heuristiques (vues « sans ADR / sans fonctionnalité / sans sprint », émergents) + signaux (clôture **tracée**, raison obligatoire) |
| `recette_rule_link` / `recette_rule_unlink` | (idem `recette_feature_link`/`_unlink`, `recette_adr_link`/`_unlink`, `recette_sprint_link`/`_unlink`) | Rattachement d'une recette à ses règles / fonctionnalités / ADR / sprints (contexte de la session `agent-recette`) |
| `evaluation_*` | `evaluation_start`, `evaluation_list`, `evaluation_get`, `evaluation_item_add`/`_update`/`_delete`, `evaluation_item_decision`, `evaluation_items_treatable`, `cadrage_evaluation_item_link`/`_unlink`/`_list`, `evaluation_feature_link`/`_unlink`, `evaluation_rule_link`/`_unlink`, `evaluation_verdict_set`, `evaluation_doc_add`/`_remove`, `evaluation_maquette_add`, **`evaluation_perf_run`** (tests standard), `evaluation_confirm` | **Recette de l'évaluateur produit** (v0.9.42 ; workflow admin → exécuteur v0.9.66 ; **tests standard** v0.9.68) — objet distinct du cadrage : parcours évalué, fonctionnalités (verdict au niveau du lien) + règles métier, éléments recommandation/problème, **décision admin « à traiter »** + **reprise en cadrage technique**, pièces (lien/document/photo/vidéo/**maquette**/**performance**), **tests standard** (parcours + erreurs console/réseau + Core Web Vitals + stress routes d'API, ADR-003) **distincts** des tests E2E, clôture **sans** conversion en tâches |
| `*_delete` | `sprint_delete`, `feature_delete`, `rule_delete` (aussi `project_delete`, `repo_delete`, `doc_delete`, `piece_delete`, `task_delete`) | Suppression explicite (le `sprint_delete` est refusé sur le sprint par défaut ; cascade ADR sur double confirmation) |
| `*_mark_implemented` | `feature_mark_implemented`, `rule_mark_implemented` | Qualification d'implémentation avec **origine** requise (`ecosystem` / `hors_ecosystem`) — idempotent, n'écrit jamais l'émergence |

> **Règle d'or** : à la création, l'agent **propose** (`featureIds`, `adrIds` en
> `propose`) ; la **validation est HUMAINE** (en recette). Aucune auto-validation,
> aucune création systématique d'ADR.

> **Tables legacy neutralisées** (`legacy_*`, jamais supprimées) : `docs`,
> `doc_projects`, `doc_repos`, `doc_attachments`, `recette_documents` — fusionnées
> dans `artifacts` par `scripts/artifacts-fusion-migration.mjs` puis renommées
> `legacy_*`. Voir [`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §4.

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

**Évaluation** (recette évaluateur, table `evaluations`, v0.9.42) : cycle de vie à
**3 statuts** — `pending` (créée) → `in_progress` (évaluation en cours) → `done`
(`evaluation_confirm` / `POST /api/evaluations/:id/finish`). **Aucune conversion
en tâches** : les éléments restent attachés à l'évaluation.

**ADR** (`ADR_TRANSITIONS`) — cycle de vie **structuré** (table `artifacts`,
`doc_type='adr'`) :
```
Proposé  → Accepté | Déprécié
Accepté  → Déprécié | Remplacé
Déprécié → Remplacé
Remplacé → (terminal)
```
Statut initial **`Proposé`** ; l'**acceptation est une décision humaine**.
`Remplacé` exige `replacedBy` (docId existant, ≠ l'ADR). Voir
[`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §1.

## 3. Endpoints observabilité (panneau, v0.2.0 → v0.7.4)

`GET /api/metrics/*` (authentifié) — dashboard « Observabilité » :
`summary` · `status` · `throughput` · `leadtime` · `agents` · `costs` · `phases` ·
`timeline?taskId=` · `blocked` · `successfailure` · `quality` · `rework` ·
`costvsthroughput` · `hardening` · **`recette`** (statuts, éléments par classe,
tâches générées, durée moyenne). Consommation : `GET /api/tasks/<id>/consumption`.
Recette : `POST /api/tasks/<id>/recette-session` · `POST /api/tasks/<id>/recette-finish`.

**Recette évaluateur** (v0.9.42 ; workflow admin → exécuteur v0.9.66) — routes
`/api/evaluations*` (ACL rôle-aware) :
`GET /api/evaluations` (liste — filtre `recetteOwnerScope` : l'évaluateur ne voit
que **ses** recettes ; champ **`treatable_count`**), `POST /api/evaluations`
(création), `GET /api/evaluations/:id` (détail : éléments + verdicts + règles +
pièces ; **rôle-aware** — l'exécuteur ne reçoit que les éléments `a_traiter`, avec
`decision`/`decidedAt`/`decidedBy`, `reprisPar` et `itemId` sur les pièces),
`GET /api/evaluations/treatable?project=` (éléments « à traiter » — entrée de
contexte d'un cadrage), `POST|PATCH|DELETE /api/evaluations/:id/items[/:itemId]`,
`POST /api/evaluations/:id/items/:itemId/decision` (**ADMIN-ONLY** — décision
`a_traiter`/`non_retenu`), `POST /api/evaluations/:id/verdicts`,
`POST|DELETE /api/evaluations/:id/documents[/:docId]` (`itemId` optionnel : pièce
par élément), `GET /api/evaluations/:id/documents/:docId/view`,
`GET /api/evaluations/file` (binaire + range, `storage/evaluation-docs`),
`POST /api/evaluations/:id/finish` (clôture **sans** tâches).
**Reprise en cadrage** : `POST|DELETE /api/recettes/:id/evaluation-items[/:itemId]`
(alias `/api/cadrages/:id/evaluation-items[/:itemId]`) — `evaluationItems` exposé
sur `GET /api/recettes/:id`.

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
| ADR structurée | Décision d'architecture (`artifacts.doc_type='adr'`) à champs structurés (statut/contexte/décision/conséquences), rattachée à un projet + 1..N repos, avec 0..N pièces jointes. |
| Artefact | Document/livrable polymorphe de la table `artifacts`, identifié par (`doc_type`, `content_id`) ; `kind` = nature. |
| Point de vigilance ADR | Constat **bloquant** remonté en recette/test (ADR manquante ou conflit), levé de façon **tracée** (raison obligatoire). |

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
| `artifacts` | **Central polymorphic manager** (all artifacts) | `artifact_id`, `doc_type`, `content_id`, `kind` (nature), `nature`, `source`, `meta`, `title`, `path`, + ADR fields (`status`, `context`, `decision`, `consequences`, `replaced_by`, `is_global`) |
| `artifact_projects` / `artifact_repos` | Artifact ⇄ project / repo N:N attachment | `artifact_id`, `project_id` / `repo_id` |
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
| `adr_conflicts` | Code ↔ ADR conflicts (persisted, "no silent violation") | `conflict_id`, `adr_id` (→ `artifacts`), `task_id` (nullable), `description`, `status` (open/resolved), `decision_id` (decision `kind='conflict'`) |
| `adr_vigilances` | ADR vigilance points in acceptance/test (append-only, blocking) | `vigilance_id`, `project`, `recette_id`, `task_id`, `session_id`, `type` (missing/conflict), `status` (open/resolved), `entity`, `description`, `adr_id`, `related_adr_id`, `conflict_id`, `resolution`, `resolution_kind`, `resolved_at`, `resolved_by` |
| `schema_meta` | **Logical** schema version marker | `key`, `value`, `updated_at` — key `schema_version` = `SCHEMA_VERSION` (`db.mjs`) ; lets `ensureSchema()` **skip** the `schema.sql` + `migrate()` replay (fast path) and run it once otherwise (under `pg_advisory_lock`). **Bump on every DDL change** (convention `YYYY-MM-DD-<description>`) |

### Structured model: Sprints / Features / Business rules (ADR-001)

| Table | Role | Key columns |
|---|---|---|
| `sprints` | **Sprint** = the project's unit of time | `id` (`SPRINT-…`), `project`, `title`, `start_date`, `end_date` (deadline → **auto** close if `auto_close`), `status` (`open`/`close`), `is_default` (at most 1 per project), `auto_close`, `closed_at`, `close_reason` (`auto_echeance`/`manuel`), `reopened_at`, `session_id` (`agent-sprint` session) |
| `fonctionnalites` | **Feature** (`US-xxx`) | `id` (`FEAT-…`), `project`, `ref` (unique per project), `role`, `user_story`, `sourced_piece_id`, `emergent`/`emergent_origin`, `implemented`/`implemented_origin`/`implemented_at`/`implemented_by`/`implemented_note` |
| `regles_metier` | **Business rule** (`RM-xxxx`) | `id` (`RMET-…`), `project`, `ref`, `content`, `sourced_piece_id`, `emergent`/`emergent_origin`, `implemented*`, **`roles`** (`TEXT[]`), **`role_global`** (1 = applies to all roles) |
| `cardinality_signals` | **Heuristic cardinality signals** (append-only, **non-blocking**) | `signal_id`, `project`, `entity_type` (recette/task/adr/sprint), `entity_id`, `missing`, `detail`, `status` (`open`/`resolved`), `origin`, `resolution`, `resolved_at`, `resolved_by` — partial unique index "**one open signal per entity**" |
| `migrations` | **Migration session** of legacy sprints (ADR-001 §6) | `migration_id`, `project` (unique), `sprint_id` (= default/legacy sprint), `session_id`, `status` (`open`/`in_progress`/`done`/`aborted`), `title`, `finished_at` |
| `adr_conversions` | **Historical** link monolithic ADR ↔ converted atomic ADR | `conversion_id`, `original_adr_id`, `converted_adr_id`, unique per pair |
| `recette_regles` | Acceptance ⇄ business rule (N:N) | `recette_id`, `regle_id` |
| `task_adr` | **Task ADR link — PROPOSED → VALIDATED** | `task_id`, `adr_id`, `status` (`propose` = agent-proposed, **not effective** / `valide` = human-validated, **effective**), `proposed_by`/`proposed_at`, `validated_by`/`validated_at`, `reason` |
| `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces` | Sprint ⇄ feature / rule / client piece (N:N) | `sprint_id` + target |
| `fonctionnalite_regles` / `fonctionnalite_gherkin` / `fonctionnalite_adr` | Feature ⇄ business rule / Gherkin scenario (`e2e_tests`) / ADR (`artifacts`) (N:N) | `fonctionnalite_id` + target ; **an ADR keeps ≥1 feature** (trigger `trg_fonctionnalite_adr_min`) |
| `task_sprints` / `task_fonctionnalites` | Task ⇄ sprint / feature (N:N) | `task_id` + target |
| `recette_sprints` / `recette_fonctionnalites` / `recette_adr` | Acceptance ⇄ sprint / feature / ADR (N:N) | `recette_id` + target |

> **`SCHEMA_VERSION`** (`db.mjs`) is the logical marker mirrored in the DB
> (`schema_meta.schema_version`). Bump it on every change to `schema.sql` **or**
> `migrate()`: matching marker → **fast path** (no DDL); different → full apply
> **once** under an advisory lock, then the new marker is written. Idempotent
> (all DDL is `IF NOT EXISTS`).

**1bis. MCP tool families (registry)** — `sprint_*` (start/list/get/close/reopen/
report/attach_pieces/session_set/delete/migrate_elements), `feature_*` (CRUD +
`feature_mark_implemented`, `feature_context`, links rule/gherkin/adr/sprint),
`rule_*` (CRUD + `rule_mark_implemented`, `rule_context`, sprint link, `roles`/
`role_global`), `migration_*` (start/get/list/finish/session_set),
`adr_conversion_*` (`adr_convert`, `adr_conversion_link`, `adr_conversion_list`),
`cardinality_*` (report/signals_list/signal_resolve), `recette_rule_link`/
`recette_rule_unlink` (and `recette_feature_link`/`recette_adr_link`/…), `*_delete`,
`*_mark_implemented`. Agents **propose**, humans **validate** (never auto-validated).

> **Legacy tables neutralized** (`legacy_*`, never dropped): `docs`,
> `doc_projects`, `doc_repos`, `doc_attachments`, `recette_documents` — merged
> into `artifacts` by `scripts/artifacts-fusion-migration.mjs` then renamed
> `legacy_*`.

Database `panel`: `users`, `sessions`, `archives`.

**2. State machines** — **Task** (coarse): `queued → started → planning →
awaiting_validation → planned → in_progress → done` (+ `blocked`/`failed`/`aborted`/
`crashed`; `done → rework`; since v0.2.1 `rework` is **non-terminal**:
`rework → planned / in_progress / blocked / failed / aborted / done`). **Plan** (full):
`planned → in_progress → validating → review → approved → merge_pending → merged →
deploy_pending → deploying → deployed → post_deploy_verified → done` (+ `rejected →
rework`). **Acceptance** (`recette_status`): `pending → approved/rejected`, independent
of execution status. **ADR** (`ADR_TRANSITIONS`): `Proposed → Accepted|Deprecated`,
`Accepted → Deprecated|Replaced`, `Deprecated → Replaced`, `Replaced` terminal
(`Replaced` requires `replacedBy`); initial status `Proposed`, acceptance is a human
decision.

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
Worktree, State, Aggregation, Structured ADR, Artifact, ADR vigilance point.
