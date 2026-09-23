# Changelog — Écosystème opencode

> Versionnage **semver** (`MAJOR.MINOR.PATCH`). Chaque version documente les
> évolutions du framework d'orchestration (agents, MCP, scripts, plugins,
> panneau, notifier). La version courante correspond à un tag git `vX.Y.Z` sur
> chaque dépôt de l'écosystème (voir `06-versioning.md`).

## 2026-09-23 · Onglet « Fournisseurs » — gestion multi-clés LLM par fournisseur (v0.9.75)

La page **Écosystème** gagne un second sous-onglet **« Fournisseurs »** (admin,
organisation par défaut) permettant d'enregistrer **N clés par fournisseur LLM**
(deepinfra/deepseek/opencode-go…), d'en désigner **une seule ACTIVE par
fournisseur**, avec **stockage chiffré AES-256-GCM** (module `secret-crypto`),
**migration automatique** de l'`auth.json` existant au premier déploiement,
**régénération + propagation** de l'`auth.json` de chaque instance puis
**redémarrage** des sessions. **La valeur d'une clé n'est jamais retournée en
clair** par l'API (seul un `fingerprint` sha256 tronqué non réversible est exposé).
Voir le nouveau doc [`19-fournisseurs-llm.md`](19-fournisseurs-llm.md).

- **Base** (`panel-db.mjs`) : table `provider_keys` (`provider`, `label`,
  `key_enc` chiffré, `is_active`) + **index unique partiel**
  `provider_keys_active_uniq ON provider_keys(provider) WHERE is_active = 1` (au
  plus une clé active par fournisseur, garanti par la base) ; fonctions CRUD
  transactionnelles `listProviderKeys` / `getActiveProviderKeys` /
  `addProviderKey` / `setActiveProviderKey` / `deleteProviderKey` (jamais de clé
  en clair retournée ; `delete` refuse la dernière clé d'un fournisseur).
- **Module** `provider-auth.mjs` : `renderAuthJson`, `writeAuthJson`,
  `regenerateAndPropagate`, `migrateFromAuthJson` — génération/propagation
  **idempotente** (skip si identique, anti-boucle du path-unit systemd), garde
  « aucune clé active ⇒ aucune écriture » (jamais de vidage de l'`auth.json`).
- **API** (`server.mjs`) : `GET /api/providers`, `POST /api/providers/keys`,
  `POST /api/providers/keys/:id/activate`, `DELETE /api/providers/keys/:id`,
  `POST /api/providers/apply` (admin + org par défaut) + migration au démarrage.
- **UI** (`public/app.js`, `public/style.css`) : sous-onglets « Agents » (contenu
  inchangé) / « Fournisseurs » (masqué aux non-admins), cartes par fournisseur,
  badge « actif », actions Activer/Supprimer, ajout de clé, « Appliquer &
  redémarrer ».
- **Scripts d'infra** (`opencode-user-provision.mjs`, `opencode-auth-sync.mjs`) :
  génération/régénération de l'`auth.json` depuis la clé ACTIVE (repli copie
  conservé pour ne jamais bloquer un provisioning).

## 2026-09-22 · Renommage des dossiers racines de stockage (`storage/`) — alignement ADR-004 (v0.9.74)

Les **dossiers racines** de `storage/` conservaient l'ancienne appellation
ADR-004 et étaient **trompeurs** : `storage/recette-docs/` contenait en réalité
les documents d'un **CADRAGE** et `storage/evaluation-docs/` les pièces d'une
**RECETTE**. Décision tracée : **renommer** les racines — voir le nouveau doc
[`17-convention-stockage.md`](17-convention-stockage.md). **Aucune suppression**
(renommage uniquement).

- **Racines renommées** (ordre imposé anti-collision) : `recette-docs →
  cadrage-docs` ; `evaluation-docs → recette-docs` ; `evaluation-maquettes →
  recette-maquettes` ; `evaluation-perf → recette-perf`. Racines inchangées :
  `ref-docs/`, `e2e/`.
- **Code aligné** : `server.mjs` (`RECETTE_DOC_DIR`, `RECETTE_MAQUETTE_DIR`,
  `RECETTE_PERF_DIR` + usages), `pilot.mjs` (`addCadrageDocument` →
  `cadrage-docs` ; `addRecetteDocument` → `recette-docs`), MCP `db.mjs`
  (`RECETTE_MAQUETTE_DIR`) et MCP `index.mjs` (`RECETTE_PERF_DIR`).
- **Compatibilité env** : les variables legacy `EVALUATION_MAQUETTE_DIR` /
  `EVALUATION_PERF_DIR` sont conservées en **fallback** une release ; les
  nouvelles `RECETTE_MAQUETTE_DIR` / `RECETTE_PERF_DIR` deviennent canoniques.
- **CLI `scripts/rename-storage-roots.mjs`** : **idempotent**, **réversible**
  (`--revert`), **audité** (journal JSON), **`--dry-run` par défaut**, **ordre
  imposé**. L'application effective (`--apply`) est une **décision humaine**.
- **`.gitignore`** aligné sur les 4 nouvelles racines (+ journal d'audit).
- **Fenêtre de maintenance** : renommage des racines + code doivent être déployés
  ensemble (redémarrage du panneau — acte d'orchestration).

## 2026-09-22 · Harmonisation de la prose des prompts d'agents (« recette » → « cadrage technique ») (v0.9.73)

Correction de la **prose** des définitions d'agents (`opencode-agents`) restée
sur l'ancienne nomenclature ADR-004 (voir v0.9.72 pour les **tokens**).
**Aucun changement de schéma** (`SCHEMA_VERSION` inchangé).

- **Reformulé en « cadrage technique »** : `orchestrator.md` (13 occ.),
  `agent-sprint.md` (5), `test-agent.md` (2), `build-notify.md` (4),
  `agent-migration.md` (3).
- **Conservé (valeurs de contrat vérifiées)** : `origin='recette'` (enum E2E,
  `index.mjs`), `task_sessions.kind='recette'` (`index.mjs`), `recette_*` de la
  recette évaluateur (`agent-recette.md`), tokens `recette_get`.
- **Signalé** : `orchestrator.md` l.444 (`decision_request kind="cadrage"`)
  contredit l.431 (kind déclaré obsolète) — incohérence préexistante, hors
  périmètre terminologie.

## 2026-09-22 · Alignement des définitions d'agents sur la nomenclature ADR-004 (v0.9.72)

Les **définitions d'agents** (`opencode-agents`) sont alignées sur la nomenclature
actée par **ADR-004** — voir
[`../adr/ADR-004-nomenclature-cadrage-technique-recette.md`](../adr/ADR-004-nomenclature-cadrage-technique-recette.md)
et l'entrée v0.9.71 ci-dessous. **Aucun changement de schéma** du registre
(`SCHEMA_VERSION` inchangé) : correction des **prompts d'agents** uniquement.

- **`agent-cadrage`** (cadrage technique) : outils canoniques **`cadrage_*`**
  (`cadrage_get`, `cadrage_item_add`/`_update`, `cadrage_feature_link`,
  `cadrage_adr_link`, `cadrage_link_task` — ex-`recette_tasks`), paramètres
  **`cadrageId`**, prose « cadrage technique » ; `origin="recette"` (enum E2E)
  conservé.
- **`agent-recette`** (évaluateur produit) : outils canoniques **`recette_*`**
  (`recette_get`, `recette_item_add`/`_update`/`_decision`, `recette_verdict_set`,
  `recette_doc_add`/`_remove`, `recette_maquette_add`, `recette_perf_run`) ; l'alias
  **`evaluation_*`** n'est plus mentionné que comme **compatibilité** ; interdiction
  corrigée (`cadrage_item_add` interdit) ; route maquette
  `/api/recettes/<recetteId>/maquette/…`.
- **`orchestrator`** : `cadrage_status`, table `cadrages`, `decision_request
  kind="cadrage"`, session `agent-cadrage`, `cadrageId`, « Terminer le cadrage ».
- **`agent-migration`** : table `cadrage_sprints` (ex-`recette_sprints`).
- **Vérification** : chaque outil cité **existe** dans `index.mjs` ; `skills` sans
  référence obsolète. Détail : [`02-composants.md`](02-composants.md) §3bis.

## 2026-09-22 · Nomenclature « Cadrage technique » (`CT-*`) / « Recette » (`RECT-*`) — ADR-004 (v0.9.71)

Alignement de la **nomenclature** et du **modèle de données** des deux objets de
premier niveau issus d'ADR-001 — voir
[`../adr/ADR-004-nomenclature-cadrage-technique-recette.md`](../adr/ADR-004-nomenclature-cadrage-technique-recette.md).

- **Identifiants** : **Cadrage technique = `CT-*`** ; **Recette (évaluateur) = `RECT-*`**
  (ex-`RECT-*` pour le cadrage, ex-`EVAL-*` pour la recette — correspondance conservée
  par la migration).
- **Objets et tables distincts** : `cadrages` + `cadrage_items` (cadrage, exécuteur) et
  `recettes` + `recette_items` (recette, évaluateur) ; liens `cadrage_*` et `recette_*`
  (ex-`recette_*` pour le cadrage, ex-`evaluation_*` pour la recette).
- **Contrats panneau** : routes canoniques `/api/cadrages*` (cadrage) et `/api/recettes*`
  (recette) — l'alias `/api/recettes*` du cadrage est **supprimé** (collision résolue) ;
  alias transitoire `/api/evaluations*` conservé pour la recette. `tasks.cadrage_id` /
  `batches.cadrage_id`, `decisions.kind='cadrage'`, doc_types `cadrage_doc`/`cadrage_report`
  (cadrage) et `recette_doc` (recette). ACL rôle-aware alignée.
- **Outils MCP** : `cadrage_*` (cadrage) et `recette_*` (recette) — alias `evaluation_*`
  conservés pour la transition.
- **UI** : onglets **Cadrage technique** (`cadrages`) et **Recette** (`recettes`) ;
  libellés et données alignés (`cadrage_status`/`cadrage_class`, `cadrageId`/`recetteId`).
- **Non renommés (contrats conservés)** : `task_recette`/`task_recette_reset`,
  `task_sessions.kind='recette'`, origine E2E `origin='recette'`, `verdict_by='agent-recette'`,
  répertoires runtime `storage/evaluation-*` (et `storage/recette-docs`).

## 2026-09-22 · Suppression du rôle « user » (migration vers exécuteur) (v0.9.70)

Le rôle `user` du panneau est **supprimé** (ADR-002), avec **migration tracée**
des comptes existants — voir le nouveau doc
[`16-migration-role-user.md`](16-migration-role-user.md).

- **Migration (Phase A, `panel-db.mjs`)** : table d'audit `user_role_migrations` +
  fonctions `migrateUserRole` / `revertUserRoleMigration` / `listUserRoleMigrations`
  (transaction, **idempotentes**, **réversibles**, **tracées**). Règle explicite
  **Ronald → executeur**, défaut → executeur.
- **CLI `scripts/migrate-user-role.mjs`** : `--dry-run` (**défaut**, aucune
  écriture) / `--apply` / `--revert` (`--all` | `--migration-id`) ; **aucune
  migration automatique** au démarrage du serveur. L'application effective
  (`--apply`) est une **décision humaine explicite**.
- **Retrait du rôle (Phase B)** : `panel-db.mjs` (`ROLES`, `normalizeRole`,
  `createUser`, `updateUserRole`, `DEFAULT`), `server.mjs` (login, création,
  validation rôle, garde d'écriture), `auth.mjs` (whitelist, `isUser`, `ownerScope`,
  `recetteOwnerScope`, `ROLE_PAGES`, `allowedPages`), `public/app.js` (libellés,
  options, whoami, bandeau). Le rôle n'est **plus proposé à la création**.
- **Invariants ACL préservés** (ADR-002) : supervisor lecture seule, évaluateur sur
  ses recettes, exécuteur sprint actif, admin plein accès. **Fail-safe legacy**
  `user` → `executeur` (normalizeRole/currentUser), `allowedPages` **fail-closed**.

## 2026-09-22 · Statuts non ambigus des Fonctionnalités (Intégration / Développement / Tests E2E) et des Règles (Respect) (v0.9.69)

Le statut du référentiel **Fonctionnalités / Règles** (jugé ambigu : « on a juste
État ») est **éclaté en axes distincts, non fusionnables** — voir le nouveau doc
[`15-statuts-fonctionnalites-regles.md`](15-statuts-fonctionnalites-regles.md).

- **Registre / MCP `task-orchestrator`** : colonnes **additives**
  `fonctionnalites.dev_status` / `dev_status_source` / `dev_status_note` /
  `dev_status_at` / `dev_status_by` (**statut de développement**, analyse du code)
  et `regles_metier.respect_status` / `respect_status_note` / `respect_status_at` /
  `respect_status_by` (**statut de RESPECT**) — `migrate()` **et** `schema.sql`,
  `SCHEMA_VERSION` bumpé `2026-09-22-feature-rule-statuses`. Constantes
  `DEV_STATUSES` / `DEV_STATUS_SOURCES` / `RESPECT_STATUSES` ; helpers
  `applyDevStatusQualification` / `applyRespectStatusQualification` (source
  **obligatoire**), fonctions `markFeatureDevStatus` / `markRuleRespectStatus` ;
  `updateFeature` / `updateRule` étendus. `feature_list` expose **`gherkinTests`**
  (liens E2E 1..N, **bulk, 0 N+1**) ; `feature_get` expose **`evaluationVerdicts`**
  (lecture seule, axe distinct). Nouveaux tools **`feature_dev_status_set`** /
  **`rule_respect_status_set`** ; descriptions `feature_get`/`feature_list`/
  `rule_get`/`rule_list` mises à jour. **Réutilisation** de l'existant :
  l'axe **Intégration** reste `implemented`/`implemented_origin` (**aucune colonne
  dupliquée**).
- **Panneau** : `pilot.updateFeature`/`updateRule` (passe-plats) + routes
  `PUT /api/features/:id` / `PUT /api/rules/:id` (relais des champs).
- **UI** : sous-onglet **Fonctionnalités** — colonnes **Intégration**,
  **Développement**, **Tests E2E** (liens **cliquables** `data-fr-e2e` →
  `e2eDetailModal`) + filtre `fr-f-dev` ; sous-onglet **Règles** — colonne
  **Respect** (remplace « État ») + filtre `fr-r-respect` ; modales
  création/édition (statut de développement + source/note ; statut de respect +
  note) et modales détail (axes + **verdicts d'évaluation** en lecture seule,
  distinction visible).
- **Tests** : `scripts/test-feature-rule-statuses.mjs` (repo MCP, **base
  PostgreSQL jetable**, 21 assertions) — pose/validation/effacement, **source
  obligatoire**, **rétrocompatibilité stricte** de `implemented`, exposition bulk
  `gherkinTests` et `evaluationVerdicts`.
- **Docs** : nouveau `15-statuts-fonctionnalites-regles.md` ; `05-reference.md`
  (colonnes + tools `*_status_set`), `02-composants.md` (onglet enrichi),
  `03-workflow.md` (distinction verdict ↔ statut de développement).

## 2026-09-22 · Workflow admin → exécuteur des éléments de recette évaluateur (v0.9.66)

Les éléments de recette de l'**évaluateur produit** (recommandations / problèmes)
**ne sont plus convertis automatiquement en tâches**. L'**admin** marque chaque
élément « **à traiter** » ou non (décision tracée, **distincte** du statut de
suivi) ; l'**exécuteur** n'accède **qu'aux éléments « à traiter »** et les
**reprend en contexte** d'un **cadrage technique** — c'est le cadrage qui produit
les tâches techniques (ADR-001/002).

- **Registre / MCP `task-orchestrator`** : `evaluation_items` gagne
  **`decision`** (`pending`/`a_traiter`/`non_retenu`), `decided_at`, `decided_by` ;
  nouvelle table **`cadrage_evaluation_items`** (reprise cadrage ↔ élément).
  Nouveaux tools : **`evaluation_item_decision`**, **`evaluation_items_treatable`**,
  **`cadrage_evaluation_item_link`**/`_unlink`/`_list` ; `evaluation_doc_add`
  accepte **`itemId`** (pièce par élément) ; `evaluation_get` expose
  `decision`/`decidedAt`/`decidedBy`/`reprisPar` et `cadrage_get` expose
  `evaluationItems`.
- **Panneau** : route **`POST /api/evaluations/:id/items/:itemId/decision`
  ADMIN-ONLY** (garde explicite `user.role !== "admin" → 403`, car le pattern
  d'écriture évaluateur matcherait sinon) ; **`GET /api/evaluations/treatable?project=`** ;
  **`POST|DELETE /api/recettes/:id/evaluation-items[/:itemId]`** (alias
  `/api/cadrages/...`) + ACL exécuteur ; `GET /api/evaluations/:id` **rôle-aware**
  (l'exécuteur ne reçoit que les éléments `a_traiter`) ; `treatable_count` sur la
  liste ; `evaluationItems` sur `GET /api/recettes/:id`.
- **UI** : badge de **décision admin** + boutons **À traiter / Non retenu** (admin) ;
  badge « **repris par le cadrage X** » ; **pièces par élément** ; section
  « **Éléments de recette à traiter** » dans la modale de cadrage (reprendre /
  retirer) ; onglet **Recette en lecture seule** pour l'exécuteur (compteur
  « à traiter »).
- **Prompt** : `buildRecettePrompt` injecte le bloc « **Éléments de recette
  évaluateur repris en contexte** » (catégorie, sévérité, contenu, pièces).
- **Docs** : `03-workflow.md` (§1bis.ter — workflow admin → exécuteur),
  `05-reference.md` (table `cadrage_evaluation_items`, décision, routes/tools).

## 2026-09-22 · Page « Recette » de l'évaluateur produit (onglet `evaluations`)

Nouvelle page **dédiée à l'évaluateur produit** (vérification produit : cohérence,
expérience utilisateur, design, performance), **objet de premier niveau distinct**
du Cadrage technique (ADR-001/002). L'évaluateur décrit le **parcours évalué**,
rattache **1..N fonctionnalités** (le **verdict** est porté par le lien, au niveau
de la fonctionnalité) + **1..N règles métier**, enregistre des **éléments**
(**recommandation** | **problème** : catégorie + sévérité + statut de suivi) et
**joint des pièces** (lien, document, photo, vidéo). Cycle de vie à 3 statuts
(`pending`/`in_progress`/`done`) — **aucune conversion en tâches**.

- **Identifiant de code DISTINCT `evaluations`** (libellé UI « Recette ») : ne
  réutilise pas l'entité/route `recettes` (ancre du **Cadrage technique** exécuteur).
  Routes `/api/evaluations*` **additives** (aucune collision avec
  `/api/recettes*` / `/api/cadrages*`).
- **Registre / MCP `task-orchestrator`** : 4 tables (`evaluations`,
  `evaluation_fonctionnalites` avec `verdict`/`verdict_comment`, `evaluation_regles`,
  `evaluation_items`) — DDL `schema.sql` + `migrate()` ; **`SCHEMA_VERSION`**
  incrémenté à `2026-09-22-recette-evaluateur` (apply une fois, idempotent). Famille
  de **14 tools `evaluation_*`** (`evaluation_start/list/get`, `item_add/update/delete`,
  `feature_link/unlink`, `rule_link/unlink`, `verdict_set`, `doc_add/remove`,
  `evaluation_confirm`). Pièces via `artifacts` (`doc_type='evaluation_doc'`, famille
  isolée — photo/vidéo autorisées, sans toucher la garde des pièces client).
- **Panneau** : routes `/api/evaluations*` (liste/détail/items/verdicts/documents/
  finish/file) + wrappers `pilot.mjs` (`createEvaluation`, `addEvaluationDocument`,
  `addEvaluationItem`, `updateEvaluationItem`, `removeEvaluationItem`,
  `setEvaluationVerdict`, `confirmEvaluation`).
- **ACL rôle-aware (ADR-002)** : l'**évaluateur** accède à `/api/evaluations*`
  (écriture limitée à **SES** recettes via `recetteOwnerScope` sur
  `evaluations.created_by`) ; `/api/recettes*` et `/api/cadrages*` lui sont
  **interdits** ; l'**exécuteur** voit les recettes évaluateur en **lecture seule** ;
  **admin/superviseur** voient tout (superviseur en lecture seule).
- **UI** : onglet **« Recette »** (id `evaluations`) — page liste + création
  (parcours, fonctionnalités, règles, pièces) + détail (éléments catégorisés,
  verdicts par fonctionnalité, pièces lien/document/photo/vidéo) ; filtre créateurs
  **masqué** pour l'évaluateur (il ne voit que ses recettes).
- **Docs** : `02-composants.md`, `03-workflow.md` (§1bis.ter), `05-reference.md`
  (modèle de données, familles MCP, endpoints) mis à jour.

## 2026-09-22 · Bump `SCHEMA_VERSION` + documentation du modèle Sprint / Fonctionnalités / Règles

Documentation d'écosystème mise à jour pour refléter le **code déployé** (MCP
`task-orchestrator` + panneau `orchestrator-panel`), et correctif du marqueur de
schéma.

- **`SCHEMA_VERSION`** (`db.mjs`) incrémenté de `2026-09-22-recette-regles-contexte`
  à **`2026-09-22-schema-sql-align-migrate`**, en cohérence avec le commit
  `f45c4ff` (alignement de `schema.sql` sur `migrate()` : colonnes d'état de
  `task_adr` + table `cardinality_signals`) qui n'avait pas incrémenté le
  marqueur. Seule la constante est modifiée (aucun DDL). Au premier appel,
  marqueur en base ≠ version → **apply complet une fois** (`schema.sql` +
  `migrate()` sous `pg_advisory_lock`) puis écriture du nouveau marqueur ;
  **2ᵉ appel = chemin rapide** (aucun DDL) ; idempotent.
- **`05-reference.md`** : modèle de données structuré (tables `sprints`,
  `fonctionnalites`, `regles_metier` + `roles`/`role_global`, `cardinality_signals`,
  `migrations`, `adr_conversions`, `recette_regles`, `task_adr.*`,
  `implemented`/`implemented_origin`, tables de liens N:N) + **`schema_meta` /
  `SCHEMA_VERSION`** + nouvelle section **Familles d'outils MCP** (`sprint_*`,
  `feature_*`, `rule_*`, `migration_*`, `adr_conversion_*`, `cardinality_*`,
  `recette_rule_link`/`unlink`, `feature_context`/`rule_context`, `*_delete`,
  `*_mark_implemented`).
- **`02-composants.md`** : état réel du panneau — Vue d'ensemble avec **cartes de
  cardinalité cliquables**, **onglet « Émergents » retiré**, **Fonctionnalités &
  Règles en 2 sous-onglets**, onglet **Sprints**, modale **Détail projet**
  = Projet/Repos/Pièces client **sans** « Documents de référence », filtres
  rôle/sprint/implémentation/émergence/lien, **sélecteurs de contexte** en création
  de recette (ADR + Fonctionnalités + Règles).
- **`03-workflow.md`** : cycle de vie sprint (durée paramétrable, clôture auto à
  l'échéance, reprise), émergence (**tracée, jamais rétroactive**), cardinalités
  heuristiques **non bloquantes**, lien ADR de tâche **proposé → validé**, sessions
  dédiées (**sprint** / **migration**), recette (contexte ADR + Fonctionnalités +
  Règles).
- **`12-documents-reference-projets-repos.md`** / **`13-adr-et-artefacts.md`** :
  cohérence avec le retrait de l'onglet « Documents de référence » de la modale
  projet (onglets **Projet / Repos / Pièces client**) et avec les sélecteurs de
  contexte (ADR en test ; ADR + Fonctionnalités + Règles en recette).

## 2026-09-21 · ADR structurées, famille `adr_*`, gestionnaire central d'artefacts & gouvernance ADR

Documentation d'écosystème mise à jour pour refléter le **code déployé** (MCP
`task-orchestrator` + panneau `orchestrator-panel`) :

- **ADR structurées** : `artifacts.doc_type='adr'` porte des champs dédiés
  (statut `Proposé`/`Accepté`/`Déprécié`/`Remplacé`, contexte, décision,
  conséquences, `replaced_by`, `is_global`), un rattachement projet + **1..N
  repos** (`artifact_projects`/`artifact_repos`), des **pièces jointes 0..N**
  (`adr_file`) et un cycle de vie gardé (`ADR_TRANSITIONS`).
- **Famille MCP `adr_*`** (12 outils) : lecture/contexte (`adr_list`, `adr_get`,
  `adr_search`, `adr_context`), cycle de vie (`adr_register`, `adr_set_status`,
  `adr_update`, `adr_attach`), signalement/vigilances (`adr_report_conflict`,
  `adr_report_missing`, `adr_vigilance_list`, `adr_vigilance_resolve`).
- **Gouvernance ADR en recette/test** : points de vigilance globaux
  (`adr_vigilances`) **bloquants** — `recette_confirm` refusé (+ pré-check
  panneau) avec raison explicite ; levée **tracée** (2 canaux) ; historique
  append-only filtrable.
- **Gestionnaire central d'artefacts** : table **polymorphe `artifacts`**
  (`doc_type`/`content_id`, `kind` = nature, `nature`, `source`, `meta`) —
  fusion physique des 3 silos (artefacts de tâche, `recette_documents`, `docs`
  ADR-12) ; tables legacy neutralisées en `legacy_*`.
- **Panneau** : onglet **ADR** du projet + onglet **Artefacts** ; retrait des
  onglets **Déploiements / Événements / Plans** (accès via le modal de détail
  d'une tâche).
- **Documentation** : nouveau doc `13-adr-et-artefacts.md` ; mises à jour de
  `01-architecture.md`, `02-composants.md`, `03-workflow.md`, `05-reference.md`,
  `09-modele-projets-repos.md`, `12-documents-reference-projets-repos.md`,
  `README.md`.

## 2026-09-17 · Email de notification par utilisateur (v0.9.65)

Les emails du daemon `opencode-notifier` partaient tous vers une adresse globale
(`NOTIFY_RECIPIENTS`). Chaque utilisateur peut désormais configurer **son** adresse.

- **`users.notify_email`** (colonne + migration idempotente), éditable depuis
  l'onglet **Utilisateurs** (bouton « Email notif. » → modale ; vide = repli
  global).
- **API** : `POST /api/users/:id/notify-email` (`setUserNotifyEmail`) ; l'email
  est renvoyé dans la liste des utilisateurs.
- **Résolution côté daemon** : le notifier relie `tasks.created_by` (username) à
  `users.notify_email` (base `panel`) et envoie l'email à cette adresse ; repli
  sur `NOTIFY_RECIPIENTS` si l'email est absent. Les notifications d'audit sont
  rattachées à l'utilisateur via l'artefact d'audit (audit_id → tâche → créateur).
- Voir aussi `opencode-notifier` (module `recipients.mjs`) et
  `send-mail.mjs --to`.

## 2026-09-17 · Sessions recette/batch — verrou anti-double-lancement (v0.9.64)

Sécurisation supplémentaire du bouton « Session d'orchestration » (et « Session
de la recette ») : un **verrou mémoire par entité** (`withLaunchLock`) sérialise
les lancements. Si deux appels arrivent en même temps (double-clic, deux onglets),
le second **attend** la fin du premier puis **relit** la session rattachée →
reprise au lieu d'une seconde session opencode. La lecture de l'entité est faite
**à l'intérieur** du verrou, donc l'état persisté est toujours vu. Vérifié :
appels concurrents sur une recette/batch déjà pourvus → `resumed: true` pour les
deux, aucune création.

## 2026-09-17 · IDE Coder — correctif cookie de session obsolète + cache (v0.9.63)

L'ouverture de l'IDE échouait encore pour certains utilisateurs (redirection
`/login`) alors que le cookie de session était bien posé :

- **Cause** : Coder lit le **premier** cookie `coder_session_token`. Un cookie
  **host-only obsolète** sur `ide.madatalk.fr` (Path=/) pouvait être envoyé avant
  le nôtre (même nom, même chemin, mais plus ancien) → Coder lisait le cookie
  périmé → `/login`. Vérifié : `STALE; VALID` échoue, `VALID; STALE` réussit.
- **Correctif** : le endpoint pose **deux** cookies `coder_session_token` — un
  `Path=/` (couverture) et un `Path=/@owner/name/apps/<app>` (chemin **plus
  long**). Le navigateur trie les cookies par longueur de chemin décroissante :
  le nôtre est donc prioritaire pour les requêtes de l'app, même en présence d'un
  cookie obsolète. Vérifié (jar avec cookie obsolète + cookie valide → app OK).
- **Cache** : `serveFile` renvoie désormais `Cache-Control: no-cache` — évite de
  servir un `app.js` obsolète (ancien lien IDE direct) après un correctif.

## 2026-09-17 · Workspaces — ouverture de l'IDE Coder sans compte Coder (v0.9.62)

L'IDE web Coder n'était ouvrable que par le propriétaire (Rino) : les autres
utilisateurs tombaient sur `/login` (pas de compte Coder, partage de workspace
non supporté pour l'IDE web).

- **Nouveau endpoint `GET /api/coder/ide?url=<ideUrl>`** (auth panneau requise) :
  valide que l'URL appartient bien au serveur Coder de l'organisation, pose le
  cookie de session Coder sur le domaine partagé puis redirige (302).
- **Cookie `coder_session_token`** = token d'API Coder de l'organisation (celui
  déjà renouvelé chaque semaine par `coder-token-rotate.mjs`), `Domain` =
  `PANEL_COOKIE_DOMAIN` (`.madatalk.fr`), `HttpOnly; Secure; SameSite=Lax`,
  `Max-Age` 12 h. Coder accepte un token d'API comme valeur de ce cookie
  (vérifié : l'app répond au lieu de rediriger vers `/login`).
- **Liens IDE** (badge de la liste + bouton « Ouvrir l'IDE » du détail) passent
  désormais par ce endpoint : ouverture directe, sans authentification Coder ni
  paramétrage de partage.
- **Contrôle d'accès** : un utilisateur restreint à ses projets ne peut ouvrir
  que les workspaces de ses projets ; les admins voient tous les workspaces.

## 2026-09-17 · Retour visuel des boutons (anti double-clic) (v0.9.61)

Les actions du parcours recette ne restaient pas silencieuses pendant leur
traitement, invitant au double-clic (création de plusieurs sessions, clôtures
répétées…) :

- Helper générique `setBtnBusy(btn, label)` : bouton **désactivé + spinner +
  libellé « … »** (réutilise les styles `ws-busy` / `ws-spinner`).
- Appliqué à **« Session de la recette »** (carte recette et détail de tâche),
  **« Session d'orchestration »** des batches, **« Confirmer & terminer »** et
  **« Terminer sans créer de tâches »** (les deux boutons de clôture sont
  désactivés ensemble), ainsi qu'à **« Enregistrer »** et **« ✕ supprimer »** des
  éléments. En cas d'erreur, le bouton est rétabli.

## 2026-09-17 · Sessions de recette / batch — reprise fiable (v0.9.60)

Correction du bug « une nouvelle session à chaque clic sur Session de la recette » :

- **Cause** : la session était ancrée sur `projects.gitPath` (champ legacy) — `null`
  pour un projet enregistré uniquement via des repos liés (ex. `myxmax`) → aucune
  option `--dir` → session créée dans le projet opencode **`global`** (`directory
  "/"`). La reprise s'appuyait sur `opencode session list`, **scopé par
  répertoire/projet**, qui ne voit jamais une session d'un autre projet → `false`
  → nouvelle session à chaque clic.
- **Ancrage déterministe** : `projectAnchorDir` résout le répertoire via le
  `gitPath` du projet, sinon le `repoDir` d'un repo lié (ADR 09, en croisant
  `project.repos` — `repo_list` renvoyant tous les repos).
- **Vérification par identifiant** : `sessionExistsById` interroge le serveur
  opencode (`GET /session/:id`, basic auth) — fiable indépendamment du projet ;
  repli sur `session list` si le serveur est injoignable. Appliqué à
  `launchRecetteSession` et `launchBatchSession`.
- Résultat : la reprise fonctionne pour toute recette/batch, y compris les
  sessions existantes créées dans `global` et les projets sans `gitPath`.

## 2026-09-17 · Recette — clôture sans tâches + édition/suppression des éléments (v0.9.59)

Dans la modale **« Terminer la recette »** (onglet Recettes) :

- **Terminer sans créer de tâches** : nouveau bouton qui clôt la recette (`done`)
  **sans** `task_register` ; les éléments relevés restent consultables dans le
  détail de la recette (utile pour une recette exploratoire ou des constats déjà
  traités ailleurs). Le endpoint `POST /api/recettes/:id/finish` accepte
  `createTasks: false` (`pilot.finishRecette`).
- **Modifier / supprimer les éléments avant clôture** : chaque élément devient
  éditable en ligne (classification, titre, contenu, critère d'acceptation,
  scope, ordre d'exécution, vigilance) via le nouveau
  `POST /api/recettes/:id/items/:itemId` (`pilot.updateRecetteItem` →
  `recette_item_update`), et supprimable (`recette_item_delete`). Les corrections
  sont persistées en base avant la clôture ; un élément en cours d'édition doit
  être enregistré ou annulé avant de terminer.
- **MCP task-orchestrator** : `recette_item_update` accepte désormais `content`
  (l'édition du contenu d'un élément était jusqu'ici impossible).

## 2026-09-15 · Panneau — accès direct à l'IDE web Coder depuis les Workspaces (v0.9.58)

Depuis la page **Workspaces**, un badge **IDE** permet d'ouvrir **directement le
VS Code web Coder** (app `code-server`) du workspace dans un nouvel onglet :

- **URL construite serveur** (`pilot.listWorkspaces`) : `{coder_url}/@{owner}/{name}/apps/{slug}/`
  — le `slug` est extrait des `apps` de la découverte Coder (`coder list
  --output json`) ; champ `ideUrl` exposé par workspace.
- **Table** : badge « IDE » cliquable dans la colonne IDE (workspaces `running`
  uniquement, « — » sinon).
- **Modale de détail** (`coder show`) : bouton « Ouvrir l'IDE » en tête de modale
  pour les workspaces démarrés.
- Aucune authentification supplémentaire : le navigateur de l'utilisateur doit
  déjà être connecté au serveur Coder (session Coder).

## 2026-09-15 · Panneau — gestion CRUD des Workspaces Coder (v0.9.57)

Page dédiée **Workspaces** (onglet réservé aux admins) sur le panneau :

- **Liste** : tous les workspaces découverts (Docker) enrichis du **statut Coder
  réel** (`coder list --output json`) — `running` / `stopped` / `failed` et les
  **transitions** (`starting`, `stopping`, `restarting`, `deleting`).
- **Actions en arrière-plan** : `start` / `stop` / `restart` / `delete` sont
  lancés **sans bloquer** (`spawn`, réponse immédiate `{queued:true}`) car
  `coder stop|restart|delete` exigent `--yes` en non-interactif (sinon `EOF`).
- **Mise à jour sans rechargement** : après une action, la table **re-poll toutes
  les 3 s** (`followWorkspaces`) jusqu'à stabilisation de la transition — plus
  besoin d'actualiser la page pour voir le statut changer.
- **Retour visuel sur les boutons** : au clic, le bouton se désactive avec un
  **spinner** + libellé « Start…/Stop…/… » (rétabli en cas d'erreur) ; pendant
  une transition les actions sont désactivées.
- **Détail** : `GET /api/workspaces/:name` (`coder show`) en modale.
- **Création** : modale de création (org, nom, dépôt à cloner) via
  `scripts/workspace-create.mjs` ; org par défaut `body.org || activeOrganizationId || "onirtech"`.
- **Auth** : routes + onglet **admin uniquement** (403 pour les superviseurs).

## 2026-09-08 · Création de workspace Coder + clone git + rotation du token (v0.9.56)

Automatisation de l'infrastructure Coder pour un projet :

- **`scripts/workspace-create.mjs`** : crée un workspace Coder
  (`coder create <owner>/<name> --template <t> --preset none --yes
  --use-parameter-defaults`), puis **clone** optionnellement le remote git dans
  le workspace (auth via le token git d'org) et **masque** le token
  (credential helper). Config (URL, template, token) + token git lus depuis le
  **secret d'organisation**.
- **`scripts/workspace-git-setup.mjs`** : masque le token git (remote propre +
  helper `~/.config/git-token` 0600).
- **`scripts/coder-token-rotate.mjs` + job pm2 `coder-token-rotate`** : le serveur
  Coder plafonne la durée des tokens à **168 h (7 j)** → **rotation auto** (vérifie
  toutes les 12 h ; recrée le token si < 48 h restantes) et met à jour le secret
  d'organisation. Le token n'est jamais affiché.
- **Template Coder** : `ONIRTECH` (paramétrable par org — `organizations.coder_template`).
- **Routes panel (admin)** : `POST /api/workspaces` (créer + cloner) et
  `POST /api/workspaces/:container/git-setup` (masquer).
- **Token Coder** de l'org `onirtech` renseigné (chiffré) + token git (chiffré).

## 2026-09-08 · Token git masqué dans les workspaces + remote git par repo (v0.9.55 / MCP v0.8.36)

- **Masquage du token git** (`scripts/workspace-git-setup.mjs`) : retire le token
  de l'**URL du remote** (`https://user:TOKEN@…`) et le fournit via un
  **credential helper** lisant un fichier `$HOME/.config/git-token` (0600). Le
  token n'est plus lisible dans `git remote -v` / `.git/config`, mais reste
  exploité (fetch/push). Appliqué à **ONIRIA** (`/home/coder/oniria`) et
  **madatalk** (`/home/coder/mada-talk`).
- **Route panel** `POST /api/workspaces/:container/git-setup` (admin) : masque le
  token d'un dépôt dans un workspace (extrait le token du remote, ou fourni).
- **Token git par organisation** : `organizations.git_token_enc` (chiffré) —
  saisissable dans *Organisations → Configurer*. Le token n'est jamais réaffiché.
- **Template Coder par organisation** : `organizations.coder_template`.
- **Remote git par repo** : champ **remote git** dans les formulaires de repo
  (création + édition) → stocké dans `repos.git_url`.
- Config Coder/git désormais **100 % paramétrable par organisation** (URL,
  template, token Coder, token git) — plus de configuration statique.

## 2026-09-08 · Config Coder paramétrable par organisation (URL + token chiffré) (v0.9.54 / MCP v0.8.35)

La configuration Coder n'est plus statique : elle est **propre à chaque
organisation** et paramétrable depuis le panneau.

- **`organizations.coder_url`** + **`organizations.coder_token_enc`** : l'URL du
  serveur Coder (seed `https://ide.madatalk.fr`) et le **token chiffré**
  (AES-256-GCM via `secret-crypto`, même mécanisme que les secrets E2E).
- **MCP** : `org_register` accepte `coderUrl` + `coderToken` (chiffré, absent =
  inchangé) ; `org_list`/`org_get` exposent `coderUrl` + `hasCoderToken` — **le
  token n'est JAMAIS renvoyé**. `getOrganizationCoderConfig` (interne) le déchiffre.
- **Panel** : gestion des organisations → chaque org affiche son URL Coder + l'état
  du token (🔒 défini / non défini) + bouton **Configurer** (URL + token en champ
  masqué, laisser vide = inchangé).

## 2026-09-08 · En-tête : libellé court + superviseur peut ouvrir un projet (v0.9.53)

- **Bandeau de rôle raccourci** : « Superviseur » / « Utilisateur » (le détail est
  en infobulle) — évite le débordement de l'en-tête avec un texte long.
- **Bouton « Ouvrir » d'un projet visible en lecture seule** : il était masqué
  (classe `launch-btn`) pour le superviseur/utilisateur ; c'est une **navigation**
  (non une écriture), donc il est désormais accessible à tous.

## 2026-09-08 · Accès par projet + écriture limitée à ses données (v0.9.52)

Deux gardes d'isolation supplémentaires :

- **Accès par PROJET** (N:N `user_projects`) : par défaut un utilisateur n'a
  accès à **aucun** projet (peu importe son rôle). L'**admin** a accès à **tous**
  les projets de l'organisation. Les projets accessibles sont **sélectionnés à la
  création** de l'utilisateur (multi-sélection) et **modifiables** (onglet
  Utilisateurs → « Projets » → cases à cocher).
  - Filtre serveur par projet accessible : projets, tâches, recettes, tests E2E,
    vue d'ensemble.
  - **Backfill** : `Gonzague` → accès au projet `mada-talk`.
- **Écriture limitée aux propres données (rôle `user`)** : toute écriture
  (`POST/PUT/DELETE`) sur `/api/{tasks|recettes|e2e-tests}/:id` exige
  `created_by = soi-même`. La création reste permise (attribuée à l'utilisateur).

## 2026-09-08 · Rôle « utilisateur » : peut créer, ne voit que ses créations (v0.9.51)

Le rôle `user` peut désormais **écrire** (créer/agir) — il n'est plus en lecture
seule stricte (réservée au `supervisor`).

- **admin** : écriture, toutes les données de l'organisation.
- **supervisor** : **lecture seule stricte** (toutes les données de l'org).
- **user** : **peut créer/agir**, mais ne **voit que ses propres créations**
  (`created_by = soi-même`) dans l'organisation active.
- `auth.isReadOnly` = `supervisor` uniquement ; `ownerScope` = username si `user`.
- Écritures du panneau attribuées à l'utilisateur + à l'**organisation active**
  (`activeOrganizationId`), pas à son org « legacy ».
- **Projets/repos** restent visibles à tous les membres de l'org (ressources
  partagées) — seuls les **travaux** (tâches, recettes, tests E2E, stats) sont
  filtrés par propriétaire pour un `user`.
- **Gestion des organisations** réservée aux **admins** (`POST/DELETE /api/orgs`,
  `POST /api/orgs/:id/default`).
- UI : bandeau « Utilisateur — vous ne voyez que vos créations » (boutons de
  création visibles) ; aide Utilisateurs mise à jour.

## 2026-09-08 · Rôle « utilisateur » — lecture seule limitée à ses créations (v0.9.50)

Le rôle `user` prend un sens distinct du rôle `supervisor` (avant, les deux
étaient strictement identiques : lecture seule).

- **`admin`** : écriture, **toutes** les données de l'organisation active.
- **`supervisor`** : lecture seule, **toutes** les données de l'organisation.
- **`user`** : lecture seule, **uniquement ses propres créations**
  (`created_by = son username`) dans l'organisation active.
- Implémentation : `auth.ownerScope = username` si rôle `user`, sinon `null` ;
  filtre serveur `created_by = ownerScope` sur tâches, vue d'ensemble (stats),
  projets, repos, recettes, tests E2E.
- UI : bandeau adapté (« Utilisateur — vos données uniquement » vs « Superviseur —
  toutes les données ») ; profil `(utilisateur)` ; aide de l'onglet Utilisateurs
  précisée.

## 2026-09-08 · Multi-organisation : N:N utilisateur↔org + isolation serveur (v0.9.49 / MCP v0.8.34)

Modèle multi-tenant complet : un utilisateur peut appartenir à **plusieurs**
organisations ; il choisit son organisation après connexion ; l'isolation est
appliquée **côté serveur**.

- **Appartenance N:N** : table `user_organizations` (panel.db), backfill depuis
  l'org unique. L'admin gère les organisations d'un utilisateur (onglet
  Utilisateurs → bouton « Gérer » → cases à cocher).
- **Organisation active = session** : `sessions.active_organization_id`. À la
  connexion, si l'utilisateur a **plusieurs** orgs et n'en a pas choisi →
  **écran de choix** (`orgPickerModal`). Si une seule → entrée directe. Route
  `POST /api/session/organization` (contrôle d'appartenance).
- **Isolation serveur** : les listes sont filtrées par l'organisation **active de
  la session** (pas le client) — tâches, vue d'ensemble (`/api/stats`), projets,
  repos, utilisateurs (membres de l'org). Writes : org active.
- **Organisation par défaut** : flag `organizations.is_default` (ONIRTECH ★).
  L'onglet **Écosystème** n'est accessible **que** si l'org active est la défaut
  (`/api/ecosystem` → 403 sinon ; onglet masqué). `org_set_default` (MCP).
- **MCP** : `org_set_default`, `isDefault` sur `org_list/get`, `organizationId`
  exposé sur `project_list`/`repo_list`/`task_get`.

## 2026-09-08 · Fix isolation organisation à la création (v0.9.48)

Correction d'un bug d'isolation : un projet (et d'autres entités) créé depuis le
panneau alors qu'une organisation est sélectionnée dans l'en-tête partait dans
l'organisation par défaut (ONIRTECH) au lieu de l'organisation active.

- **Cause** : `organizationId` n'était **pas propagé** par les fonctions `pilot`
  (`createProject`, `registerRepo`, `registerDoc`, `registerDocUpload`,
  `createE2ETest`, `createRecette`) — le MCP retombait sur l'organisation par
  défaut. Le front n'envoyait pas non plus l'organisation active.
- **Correctif** : les fonctions `pilot` acceptent et transmettent
  `organizationId` ; le panneau envoie `organizationId = currentOrg` (organisation
  du sélecteur d'en-tête) sur **toutes** les créations (projet, repo, tâche,
  recette, test E2E, document) ; les routes serveur transmettent `createdBy` +
  `organizationId`.
- **Résultat** : une donnée créée avec « HAVET DIGITALE » sélectionnée est bien
  rattachée à `havetdigital`.

## 2026-09-08 · Multi-organisation + attribution utilisateur (v0.9.47 / MCP v0.8.33)

Alignement des **données** et des **fonctions** : toute donnée créée depuis le
panneau est désormais **rattachée à un utilisateur** et à une **organisation**.

- **Table `organizations`** (tenant de premier niveau) : `id` (slug), `name`,
  `description`. Seed **ONIRTECH** (`onirtech`). CRUD via MCP (`org_register/
  list/get/delete`) et routes panel (`GET/POST /api/orgs`, `DELETE /api/orgs/:id`).
- **`organization_id`** sur les entités de 1er niveau : `projects`, `repos`,
  `recettes`, `tasks`, `e2e_tests`, `docs`, `artifacts`. Backfill → `onirtech`.
  Les sous-éléments (plans, événements, exécutions) héritent via leur parent.
- **`created_by`** (username) sur toutes ces entités. Backfill → **Rino** (toutes
  les données existantes lui appartiennent). Les écritures du panneau posent
  désormais `createdBy = user.username` (tâches, projets, repos, recettes, docs).
- **Users** : `panel.db users.organization_id` (backfill `onirtech`) ; l'onglet
  Utilisateurs affiche et permet de changer l'organisation ; création d'utilisateur
  avec organisation.
- **Panel** : **sélecteur d'organisation** en en-tête (filtre global : projets,
  tâches, vue d'ensemble) + bouton **Organisations** (gestion nom/description).
- **MCP** : `org_*`, `organizationId`/`createdBy` sur `task_register`,
  `project_register`, `repo_register`, `doc_register`, `recette_start`,
  `e2e_test_register` ; `project_list`/`task_get` exposent `organizationId`.

## 2026-09-08 · Panel — carte projet épurée + modale détail UNIQUE (v0.9.46)

- **Carte projet épurée** : ne garde que le **titre**, le bouton **Ouvrir**, le
  bouton **Détail** et les **badges des repos associés**. Tout le reste (identité,
  repos détaillés, documents) est déplacé dans la modale détail.
- **Une SEULE modale détail** (`projectDetailModal`), responsive, avec **onglets
  internes** — plus aucune sous-modale :
  - **Projet** : nom (modifiable) + suppression du projet ;
  - **Repos** : liste détaillée (workspace, branche, déploiement, répertoire, E2E),
    édition inline d'un repo, association d'un repo existant, création + association
    d'un nouveau repo, retrait d'un repo ;
  - **Documents** : liste des docs de référence (ADR/specs/Gherkin), ajout (import
    PC ou chemin), lecture, suppression.
  - Toutes les actions re-rendent la modale (pas de fermeture/réouverture).
- **Code mort supprimé** : `repoFormModal`, `projectDocsModal`, `repoLinkModal`,
  `repoUnlinkModal`, `projectDeleteModal` (remplacées par la modale unique).

## 2026-09-08 · Panel — navigation centrée projet (v0.9.45)

Refonte de la navigation : **l'accueil = la liste des projets** ; **ouvrir un
projet** scope toutes les vues à ce projet.

- **Nav dynamique à 2 états** (`renderNav`) :
  - aucun projet ouvert → onglets **globaux** (Projets, Vue d'ensemble,
    Écosystème, Utilisateurs[admin]) ;
  - projet ouvert → **sous-onglets du projet** : Vue d'ensemble, Tâches,
    Recettes, Tests E2E, Déploiements, Décisions, Plans, Événements, Documents,
    Vars & Secrets E2E, Archives — + bouton **← Projets** et **bandeau projet**.
- **Bouton « Ouvrir »** sur chaque carte projet (`openProject` / `closeProject`,
  projet courant mémorisé dans localStorage).
- **Filtre projet propagé aux endpoints** : `?project=` ajouté à `deployments`,
  `decisions`, `plans`, `events`, `artifacts`, `stats` (join `tasks.project`) ;
  `tasks`, `recettes`, `e2e-tests`, `e2e-vars` déjà filtrables. Les vues
  réutilisées (tâches, recettes, tests E2E, secrets) **verrouillent** leur
  sélecteur projet sur le projet ouvert.
- **Vue d'ensemble projet** : `/api/stats?project=` (compteurs scopés).

## 2026-09-08 · Filtre par date de création dans la liste des tâches (v0.9.44)

L'onglet **Tâches** dispose d'un filtre par **date de création** : deux champs
`du` / `au` (dates inclusives) + bouton d'effacement. Persistant (localStorage),
combinable avec les filtres projet/statut/recette/actif. Filtre sur
`created_at` (partie date `YYYY-MM-DD`).

## 2026-09-08 · « Attente humaine » masquée sur les tâches done + rétro-soldage (v0.9.43)

Une tâche **terminée (`done`)** n'a plus d'attente humaine : le badge « ⏳ attente
humaine » et le bloc « Validation (décisions en attente) » ne s'affichent plus
pour elle, même si une décision résiduelle traîne en base.

- **Liste des tâches** (`registryTasks`) : `waiting_human` exclut désormais les
  tâches `done` (jointure au statut d'exécution courant).
- **Détail d'une tâche** (panel) : le bloc « Validation (décisions en attente) »
  n'apparaît que si la tâche n'est **pas** `done`.
- **Overview** : le compteur « Décisions ouvertes » exclut les décisions des
  tâches `done`.
- **Rétro-soldage** : les décisions `awaiting` résiduelles de tâches `done`
  (13 reliquats antérieurs) ont été soldées `approved` / « résolu en session »
  + événement `DECISIONS_RESOLVED_IN_SESSION`.

## 2026-09-08 · Soldage des décisions « résolu en session » à la clôture (MCP v0.8.32)

Quand une tâche passe **`done`**, les décisions/permissions encore `awaiting` qui
lui sont rattachées sont **soldées** : marquées `approved` avec la résolution
**« résolu en session »**.

Pourquoi : l'utilisateur répond parfois **directement dans le chat** (session
agent) au lieu du panneau — aucune décision `permission.replied` n'est alors émise
et la décision restait `awaiting` pour toujours, alors que la tâche est terminée
(= le parcours a été validé).

- **`applyTransition` → `to="done"`** : dans la même transaction, solde toutes les
  décisions `awaiting` de la tâche (`approved`, `resolution='résolu en session'`).
- Trace : événement **`DECISIONS_RESOLVED_IN_SESSION`** (nb de décisions soldées).
- Couvre tous les `kind` : `validation`, `permission`, `review`… (une décision de
  `recette` n'est pas concernée : elle se résout via le flux recette).

## 2026-09-08 · Mode « Session unique » : la session d'orchestration par batch (v0.9.42)

Le mode `launch_mode='session'` (choisi à la clôture d'une recette) est câblé :
**une session orchestrateur unique pilote toutes les tâches du batch** avec
l'intelligence d'orchestration (ordonnancement, conflits, préparation croisée).

- **`buildBatchSessionPrompt`** (session-bridge) : prompt de mission batch — le
  batch, ses tâches, les règles d'orchestration (plafond `max_parallel`, readiness,
  préparation croisée, portes humaines, complétion).
- **`pilot.launchBatchSession`** : ouvre (ou reprend, anti-doublon) la session
  orchestrateur du batch, ancrée sur le gitPath du projet ; rattache `batch.session_id`.
- **Routes HTTP** : `GET /api/batches` (liste), `GET /api/batches/:id`,
  `POST /api/batches/:id/session` (lancer/reprendre), `POST /api/batches/:id/status`.
- **Panel — onglet Recettes** : section « Batches d'orchestration actifs » (cartes
  avec mode + bouton Lancer/Reprendre la session) + modale détail (readiness,
  conflits fichiers, bouton session).
- **agent `orchestrator.md`** : section « MODE SESSION BATCH » — détection de la
  mission, boucle d'orchestration (readiness → plafond → délégation), **préparation
  croisée** (bloqué ≠ perdu : on prépare ce qui est préparable), portes humaines
  intactes, complétion du batch. L'orchestrateur ne dépasse jamais `max_parallel`,
  n'ouvre pas de session par tâche, n'édite pas le code.
- Rappel des modes : `batch` (worker auto) | `session` (cette session unique) |
  `manual` (pilote humain).

## 2026-09-08 · Recette — 3 modes de lancement à la clôture (v0.9.41)

À la clôture d'une recette, l'utilisateur choisit **comment lancer les tâches
créées** (fondation ; le mode `session` sera câblé à la session orchestrateur
unique dans une étape suivante).

- **`batches.launch_mode`** : `batch` (défaut — le worker `batch-pilot` lance les
  tâches prêtes auto, session par tâche) | `session` (une session orchestrateur
  unique doit piloter le batch — déclenchement à venir) | `manual` (aucun
  auto-lancement, l'utilisateur pilote chaque tâche comme avant).
- **Panel — modale « Terminer la recette »** : sélecteur à 3 radios (Batch /
  Session unique / Manuel), le choix est transmis à `finishRecette` et stocké sur
  le batch créé.
- **Worker `batch-pilot`** : ne pilote **que** les batches `active AND
  launch_mode='batch'` — les modes `session`/`manual` sont ignorés (aucune session
  auto-lancée, pas de complétion auto).
- **MCP** : `batch_register(launchMode)`, `batch_set_launch_mode`, `batch_get`/
  `batch_list` exposent `launchMode`. task-orchestrator v0.8.31.
- Le mode `session` (session orchestrateur unique qui pilote tout le batch avec
  l'intelligence d'orchestration : DAG, conflits, préparation croisée) est
  **la prochaine étape** — le worker reste en file de sécurité.

## 2026-09-08 · Recette — raisonner sur les DOCUMENTS de référence + capture `docIntent` (v0.9.40)

L'agent de recette ne se contente plus de lire les documents ADR-12 comme simple
référence de comparaison : il **diagnostique le sens de l'écart** (code faux vs
**document dépassé**) et capture structuré le besoin de faire évoluer les
documents du projet suite aux décisions de recette.

- **agent-recette.md — section « Raisonner sur les DOCUMENTS de référence du
  projet »** : pour chaque constat, l'agent distingue « le code est faux » (rework/
  bug, la doc reste la référence) de « **la règle a changé / le document est
  dépassé / une règle émerge** » → le document doit être **mis à jour / obsolété /
  créé** (`docIntent`). Il ne modifie **jamais** les documents (lecture seule) :
  il capture le besoin, notifié à l'utilisateur et transmis à la tâche créée.
  Croisement test↔doc signalé quand pertinent.
- **Capture structurée `docIntent`** sur les éléments de recette
  (`recette_items.doc_intent`, JSON) : `{ action: create|update|obsolete,
  docType: adr-tech|specs-fonctionnelles|scenarios-gherkin, target, summary,
  reason }`. Outils `recette_item_add` / `recette_item_update` acceptent
  `docIntent` ; `recette_get` le renvoie.
- **Clôture** (`finishRecette`) : un item avec `docIntent` crée une tâche marquée
  `[ADR]/[SPECS]/[GHERKIN] mettre à jour…` (ou documenter / obsoléter) + critère
  d'acceptation orienté document si absent.
- **Panel** : badge « 📄 intention doc » (type ADR/SPECS/GHERKIN + action + cible)
  sur les éléments (détail, items, section recette d'une tâche).
- **MCP** : task-orchestrator v0.8.30.

## 2026-09-08 · Recette — raisonner sur les TESTS du projet + capture `testIntent` (v0.9.39)

L'agent de recette ne se contente plus de lire les tests comme **preuve** : il
**raisonne sur le cycle de vie des tests** du projet (unitaires + E2E) et capture
structuré le besoin d'évolution.

- **agent-recette.md — section « Raisonner sur les TESTS du projet »** : pour
  chaque constat (bug/rework/feature/changement de comportement), l'agent
  questionne la couverture par les tests et décide si un test doit être
  **créé** (bug non couvert → test de non-régression ; nouveau comportement →
  nouveau test), **adapté** (comportement livré ≠ voulu → test à corriger) ou
  **obsolété** (comportement supprimé). Il ne rédige **jamais** les specs
  (lecture seule) : il capture le besoin, traité ensuite par **test-agent**.
- **Capture structurée `testIntent`** sur les éléments de recette
  (`recette_items.test_intent`, JSON) : `{ action: create|update|obsolete,
  testType: unit|e2e, target, scenario, reason }`. Outils `recette_item_add` /
  `recette_item_update` acceptent `testIntent` ; `recette_get` le renvoie.
- **Clôture** (`finishRecette`) : un item avec `testIntent` crée une tâche
  **marquée** `[E2E TEST] créer…` / `[TEST] …` (+ critère d'acceptation orienté
  test si absent), pour être traitée par **test-agent**.
- **Panel** : badge « intention test » (type + action + cible) sur les éléments
  (détail, items, section recette d'une tâche).
- **MCP** : task-orchestrator v0.8.29.

## 2026-09-08 · Batch d'orchestration — Phase 4 : auto-avancement sur dépendances (v0.9.38)

Les tâches séquentielles d'un batch s'enchaînent **automatiquement** : une tâche
dépendante démarre seule dès que ses prérequis sont terminés, sans intervention
humaine. C'est la concrétisation du « traité automatiquement quand les
dépendances sont traitées ».

- **Propagation execOrder → dependencies** (`finishRecette`) : à la clôture d'une
  recette, les tâches créées héritent de la **précédence** de leurs items.
  Items de **même `execOrder`** = parallèles (aucune dépendance) ; un numéro
  **supérieur** = dépend des inférieurs (`task.dependencies`). Le worker
  `batch-pilot` lance alors la 2e vague **seule quand la 1re est `done`**.
- **Readiness corrigée (deps hors batch)** (`batch_readiness`) : une dépendance
  est satisfaite si la tâche référencée est `done`/`deployed`/
  `post_deploy_verified` — **qu'elle soit dans le batch ou non** (une tâche qui
  dépend d'un prérequis déjà fait ailleurs ne reste pas bloquée).
- **MCP** : task-orchestrator v0.8.28 (readiness deps hors batch).
- Portes humaines **inchangées** : validation de plan, merge, déploiement
  restent des décisions humaines (Phase 2). L'auto-avancement ne concerne que le
  **lancement séquentiel** des tâches prêtes du batch.

## 2026-09-08 · Batch d'orchestration — Phase 3 : interleaving fin au niveau ÉTAPE (v0.9.37)

La granularité de la coordination descend des **tâches** aux **étapes de plan** :
c'est la brique qui permet qu'une étape de la tâche A tourne pendant que la tâche
B attend (ex. un déploiement), sans conflit.

- **`plan_steps.files` (Phase 3)** : chaque étape atomic-plan déclare les fichiers
  qu'elle touche. Extraction depuis le tableau du Plan-*.md (colonne fichier
  détectée par contenu — le tableau a 6 ou 7 colonnes selon le plan), filtre
  strict (vrais chemins de fichiers, pas les commandes `npm run`/`git push`).
  Backfill idempotent des plans existants (`backfillStepFiles`, ~919 étapes
  remplies). Exposé dans `plan_get`/`getPlanSteps` (`stepFiles`/`files`).
- **Matrice de conflit au niveau étape** (`batch_conflict_matrix`) : paires de
  tâches dont des **étapes** se chevauchent (fichiers déclarés) **+** chevauchement
  de **fichiers réels de commits** quand non couvert par les déclarés.
- **Readiness affinée** (`batch_readiness`) : une tâche est `ready` si **aucune de
  ses étapes todo** ne chevauche une étape active/done d'une autre tâche ; expose
  `blockedSteps` (étapes qui attendent un fichier occupé) et `interleavableWith`.
- **MCP** : task-orchestrator v0.8.27 (readiness/matrice étape), plan-manager
  v0.1.1 (`files` par étape + backfill).
- Le worker `batch-pilot` (Phase 2) continue de lancer les tâches `ready` — la
  Phase 3 affine **quand** une tâche est prête (par étape, pas par tâche entière).

## 2026-09-08 · Batch d'orchestration — Phase 2 : auto-avancement contrôlé (v0.9.36)

Le **pilote de batch** (`batch-pilot.mjs`, process pm2 dédié) applique le
principe « une orchestration, N tâches séquencées sans conflit » : dès qu'un
créneau se libère dans un batch `active`, la tâche suivante **prête** démarre
automatiquement (≤ `max_parallel` écrivains simultanés).

- **Worker `batch-pilot`** (fork pm2, verrou advisory PostgreSQL = un seul
  pilote actif ; polling ~20 s + LISTEN/NOTIFY `registry_changed`) : pour chaque
  batch `active`, `batch_get` → readiness → lance les tâches `ready` non lancées
  (via `pilot.launchTask`, garde `queued` + trace `task_sessions`) ; quand toutes
  les tâches sont `done` → batch `completed` automatiquement.
- **Périmètre de sûreté** : le worker ne lance QUE les tâches `ready` encore
  `queued`. Les **portes humaines restent humaines** (validation de plan, merge,
  déploiement) — le worker ne les franchit jamais. La continuation post-décision
  est déjà assurée par `resolveDecision` (injection dans la session orchestrateur).
- **Agent `orchestrator`** : rappel des règles batch dans le pipeline.

### Phase 1 (v0.9.35) — rappel
Nouvelle entité **`batch`** (1er niveau) + outils MCP `batch_*` (v0.8.26) :
`register/get/list/add_task/remove_task/set_session/set_status/readiness/
conflict_matrix`. Readiness calculée (deps + conflits) + **matrice de conflit
fichiers** (déclarés via plans + réels via plan_commits). Recette = batch naturel
(les tâches créées à la clôture d'une recette forment un batch). Phase 1 =
visibilité, aucun automatisme.

## 2026-09-08 · Recette = 1 projet unique + repos transverses du projet (v0.9.34)

Correction d'une **erreur de conception** dans la recette : le modèle multi-projets
(1 recette = 1..N projets, table `recette_projects`) est abandonné au profit du
modèle validé **« 1 projet + repos transverses »** (cohérent avec ADR 11).

- **1 recette = 1 PROJET (produit)** — `recettes.project`. Sa portée réelle est
  couverte par les **repos transverses du projet** (`project_repos`) : ex. le
  projet `mada-talk` traverse les repos `mada-talk` **et** `oniria`.
- **Table `recette_projects`** = **légacy** (historique des anciennes recettes
  multi-projets) : plus écrite ni lue par la logique. `recette_get` / `recette_list`
  renvoient désormais `project` + `repos[]` (au lieu de `projects[]`).
- **Garde tâches couvertes** : une tâche ne peut être couverte que si elle
  appartient au **projet de la recette**.
- **Garde éléments** : `recette_item_add` impose le projet de la recette (les
  repos transverses ne sont pas des projets).
- **MCP** : `recette_start(project)` (projet requis, refus si `projects[]` > 1) ;
  outils `recette_project_add` / `recette_project_remove` **retirés**.
- **Panel** : création de recette = **sélecteur UNIQUE de projet** + affichage des
  repos transverses du projet ; carte/détail/clôture affichent le projet et ses
  repos (`chip-repo`), suppression de la gestion « projets rattachés (1..N) ».
- **agents** : `agent-recette.md` — recette = 1 projet, `project` obligatoire
  (`recette.project`), repos transverses lus via `recette.repos` ; prompt de
  session (`buildRecettePrompt`) aligné (projet + repos, ADR 11).

## 2026-09-06 · Synthèse — référentiel documentaire des PROJETS (ADR-12) + couverture E2E

Cette session a fait émerger un **référentiel documentaire par projet** (ADR-12),
alimenté par la documentation du produit **Madatalk** (backend ONIRIA
`madatalk-requests`/`chatbot-management` + SPA client `mada-talk`). Contexte :
les tests E2E et la recette avaient besoin de l'**architecture**, des **règles
métier** et des **scénarios** du produit en contexte — pas seulement des specs de
test.

### Référentiel documentaire (ADR-12) — mécanique
- Registre générique **`docs` N:N** ⇄ projets ET/OU repos ; un document =
  `path` (fichier lu par l'agent), **jamais de contenu en base**.
- 3 kinds : `adr-tech` (architecture technique) · `specs-fonctionnelles`
  (User stories + règles métier) · `scenarios-gherkin` (scénarios BDD).
- **Import depuis le PC** (fichiers `.md/.txt/.feature…`, max 2 Mo) stockés dans
  `storage/ref-docs`, ou référence d'un chemin existant ; aperçu intégré.
- Docs exposés sur `project_list/project_get`, `repo_list/repo_get`,
  `e2e_test_get` (`test.docs`) ; outils MCP `doc_*`.
- **Contexte agents** (cases à cocher, tout coché par défaut, 3 catégories
  toujours visibles) : sessions **test-agent** (création/MAJ + libre) et
  **recette** → chemins injectés dans le prompt (`buildTestPrompt`,
  `buildFreeTestPrompt`, `buildRecettePrompt`) ; docs des projets couverts
  rattachés à la recette (`recette_documents`, nature `[kind]`).

### Documentation produit Madatalk produite et rattachée au projet
Trois documents (`mada-talk/docs/*`, mergés sur main, enregistrés ADR-12 sur le
projet + repo `mada-talk`) :

1. **`adr-architecture-madatalk.md`** (`adr-tech`) — architecture **réelle** du
   code : packages ONIRIA (`chatbot-management`, `madatalk-requests` v0.2.33),
   frontières inter-package (intentions/transactions, provisionnement auto du bot
   à `A traiter`), machines à états, endpoints `.client.*`, back-office
   (clients/opérateurs-havet/chatbots/livrables), SPA React/Vite. + **12bis
   « architecture cible »** : interactions → **Conversations**.
2. **`specification-fonctionnelle-madatalk.md`** (`specs-fonctionnelles`) —
   catalogue **règles métier RM-xxxx** + **user stories** par rôle (O/A/C-US)
   référencées + index croisé + arbitrages actés (« A traiter » canonique,
   opérateur ne voit pas `Nouveau`, pause/résiliation client = approbation admin,
   résilié = supprimé, annuaire clients/opérateurs CRUD+invitation).
3. **`scenarios-gherkin-madatalk.md`** (`scenarios-gherkin`) — scénarios BDD dont
   **parcours transverses multi-rôles** (SPA client → console ONIRIA) + règles
   par rôle ; **matrice de couverture E2E** (§0) liant les tests actifs
   (`E2E-MADA-TALK-15gjc53`=S1, `E2E-MADA-TALK-vjja3p`=S2) aux scénarios
   `[E2E couvert]` vs `[E2E — à implémenter]`.

### Évolutions E2E connexes
- Rapport texte **transcript horodaté** par étape (StepReporter + runner/import) ;
  `skip_reason` persisté ; correction de bugs de spec S2 (race sur la liste
  clients, description contenant le botName).
- Repos de code associés au test (`repoIds`) définis à la création = couverture
  lisible par la recette (ADR 11 complété).
- Session **test-agent libre** + page Tests E2E (filtre « actif » par défaut).

Dépôts/tags : `opencode-mcp-task-orchestrator` v0.8.22→v0.8.24 ·
`opencode-observability` v0.9.20→v0.9.27 · `opencode-agents` v0.6.9→v0.6.11 ·
`opencode-scripts` v0.2.3 · repo applicatif `mada-talk` (documents de référence).

---

## v0.9.33 — 2026-09-06 · Vidéo narrée : respiration allongée + sous-titres gravés

Amélioration de la vidéo narrée (prototype v0.9.32) :
- **Respiration allongée** entre étapes : padding après la voix passé à ~1,1 s
  (freeze prolongé) → la vidéo est plus étendue (S1 ~50 s au lieu de ~44 s),
  expérience de lecture plus agréable.
- **Sous-titres gravés dans la version narrée** : après montage de la narration,
  toutes les lignes horodatées du rapport sont **remappées sur la timeline
  finale** (en tenant compte des extensions par freeze) puis gravées en passe
  finale (`ass=`) — on garde donc le sous-titrage (couleurs) tout en écoutant la
  voix.

Dépôt : `opencode-observability` (v0.9.33).

## v0.9.32 — 2026-09-06 · Vidéo E2E narrée (voix TTS + extension par freeze) — prototype

Prototype à la demande : à côté de la vidéo sous-titrée, bouton « 🔊 Vidéo narrée
(voix) » dans le lecteur vidéo d'une exécution. Une voix **synthétise** les étapes
(`[STEP]`) + le résultat, et la vidéo est **étendue (freeze-frame de la fin d'une
étape)** quand la lecture vocale dépasse sa durée réelle — pour que la voix soit
entièrement audible.

- **TTS léger** : `espeak-ng` (voix `fr-fr`, ~150 mots/min), installé côté serveur.
- **Montage** : découpage en tranches aux bornes des `[STEP]/[RESULT]` ; pour
  chaque tranche narrée, génération de l'audio + extension vidéo si besoin
  (`trim` + `fps=25` + `tpad stop_mode=clone`) ; concaténation MPEG-TS → `.mp4`
  (H.264 + AAC). Les tranches entre étapes restent muettes à durée réelle.
- **Endpoint** `POST /api/e2e/narrated { executionId }` (admin, cache) ; la modale
  vidéo propose les deux enrichissements (sous-titres / narration), bascule le
  lecteur et adapte le téléchargement.

Dépôt : `opencode-observability` (v0.9.32). Dépendance : `espeak-ng`.

## v0.9.31 — 2026-09-06 · Vidéo E2E avec sous-titres (génération à la demande, hors pipeline)

À partir du **détail d'une exécution** (lecteur vidéo), bouton « Générer la vidéo
avec sous-titres » : grave les **sous-titres dans la vidéo** (fichier téléchargeable),
produits depuis le **rapport texte horodaté** (chaque `[TYPE] +MM:SS.mmm …` = un
sous-titre à la même position temporelle que la vidéo).

- **Couleurs par type** : `[STEP]` blanc · `[PASS]` vert · `[FAIL]` rouge ·
  `[GAP]` orange · `[SKIPPED]` gris · `[INFO]` gris clair · `[RESULT]` coloré
  selon le statut global du run (vert/rouge/gris).
- **Endpoint** `POST /api/e2e/subtitled { executionId }` (admin) : lit rapport +
  vidéo (mêmes origines temporelles), construit un ASS, `ffmpeg -vf ass=…`
  (libass) → `storage/e2e/subtitled/<exec>.webm` (VP8, même durée). **Cache** :
  réutilise si déjà généré.
- **UI** : le bouton « ▶ Voir la vidéo » porte l'executionId ; la modale vidéo
  propose « 🎬 Générer la vidéo avec sous-titres », puis bascule le lecteur sur la
  vidéo sous-titrée + offre le téléchargement.
- Dépendance système ajoutée : `ffmpeg` (avec libass).

Dépôt : `opencode-observability` (v0.9.31).

## v0.9.30 — 2026-09-06 · Vue dédiée d'approbation (décision lisible, plein écran)

Les décisions humaines à approuver étaient affichées dans de petits espaces
(onglet Décisions en tableau / modal Actions de tâche) — difficile à lire, donc
souvent approuvées sans réellement examiner.

- **Vue d'approbation dédiée** (`decisionReviewModal`) : plein écran, responsive
  (mobile = 100dvh), scrollable — en-tête décision (id/type/statut/tâche/plan/
  échéance), section **Tâche** (request), section **Détail de la demande**,
  résolution, zone de remarques, actions collantes (Approuver / Rejeter) en bas.
  Le détail/request est **rendu en markdown** (endpoint GET `/api/render-md`).
- **Bouton « Examiner »** : dans l'onglet **Décisions** et dans le **modal Actions**
  (section Validation) — ouvre la vue. Approuver/Rejeter restent dispo en un clic ;
  un rejet sans remarque demande confirmation.
- API `/api/decisions` enrichie (`task_title`/`task_project`/`task_request` par
  JOIN) ; résolution centralisée (`resolveDecision`).
- Séparation : la liste des approbations reste dans l'onglet Décisions (filtrable
  par tâche) et le modal Actions pointe vers la vue d'examen au lieu de tout
  entasser.

Dépôt : `opencode-observability` (v0.9.30).

## v0.9.29 — 2026-09-06 · Rôle « superviseur » (lecture seule) sur le panneau

Nouveau rôle d'accès au centre de pilotage : **superviseur** = **lecture seule**
(vue d'ensemble, tâches, recettes, tests E2E, documents, décisions, projets,
repos, Vars & Secrets en lecture). **Observabilité omise en v1.** Aucune action
d'écriture ; aucune session IA (test-agent / recette) ; agents IA et écosystème
non touchés.

- **Base** : colonne `users.role` (`admin` | `supervisor` | `user`), migration
  rétrocompat `is_admin=1 → role='admin'` ; `listUsers`/`createUser`/
  `updateUserRole` exposent le rôle.
- **Auth** : `currentUser` renvoie `role`/`isSupervisor`/`isReadOnly`.
- **Garde serveur** : tout utilisateur non-admin n'a accès qu'aux **GET** — toute
  méthode d'écriture (POST/PUT/DELETE) refusée 403 (protection côté serveur,
  jamais l'UI).
- **Gestion utilisateurs (admin)** : création avec rôle + bascule de rôle par
  ligne (admin/superviseur/utilisateur).
- **UI** : bandeau « Superviseur (lecture seule) », onglets observabilité /
  archives / users masqués, actions d'écriture masquées via CSS
  (`body.readonly …`).

Dépôt : `opencode-observability` (v0.9.29).

## v0.9.28 — 2026-09-06 · Documents de référence : bouton « Regarder » pour lire le contenu

Les documents de référence (ADR/specs/Gherkin) rattachés à un projet/repo
étaient lisibles seulement pour les fichiers **importés** ; les documents
**référencés par chemin** (workspace/checkout) n'avaient aucun bouton de lecture.

- **Endpoint `GET /api/docs/:id/content`** : lit le fichier au chemin enregistré
  (workspace/checkout OU storage/ref-docs) et le rend (markdown / feature /
  texte brut) — restreint aux paths enregistrés.
- **Bouton « Regarder »** disponible pour **tous** les documents de référence :
  sur la **carte projet** (chaque doc listé) et dans la modale « 📄 Docs de
  référence » (remplace l'ancien « Voir » limité aux imports).
- Pilot : `docGet` (wrapper `doc_get`).

Dépôt : `opencode-observability` (v0.9.28).

## v0.9.27 — 2026-09-06 · Session test-agent libre : docs du projet + confirmation vars/secrets

La modale « Session test-agent » (page Tests E2E) proposait seulement projet +
message — sans les documents de référence ni la confirmation des variables.

- **Documents de référence (ADR-12)** : dès qu'un projet est choisi, les 3
  catégories (ADR technique / User stories+règles métier / scénarios Gherkin)
  sont affichées, cochées par défaut ; la sélection (`docIds`) est transmise à la
  session et injectée dans `buildFreeTestPrompt` (chemins à lire par l'agent).
- **Confirmation variables & secrets E2E** : liste des vars (kind variable |
  secret, purpose, valeur pour les non-sensibles) du projet choisi — l'utilisateur
  vérifie ce qui sera injecté au run.
- Backend : `launchFreeTestSession` résout les docs du projet (+ ses repos) et
  honore une sélection `docIds` (vide = aucun) ; route POST /api/e2e/agent-sessions.

Dépôt : `opencode-observability` (v0.9.27).

## v0.9.26 — 2026-09-06 · Session test-agent libre (accès agent sans créer de test)

Sur la page **Tests E2E**, bouton **« Session test-agent »** : accéder à l'agent
de test sans forcément créer un test.

- **Reprendre une session existante** : liste les sessions test-agent ouvertes
  (rattachées à un test via `e2e_tests.session_id`, ou au titre explicite
  création/MAJ test / session test-agent), agrégées depuis les répertoires des
  projets/repos (`session list` est scopé par répertoire) — bouton « Reprendre ».
- **Ouvrir une nouvelle session** : choix du projet (contexte/workspace) +
  message optionnel → session test-agent libre (aucun test créé), ouverte dans
  le navigateur.

Backend : `listTestAgentSessions` / `launchFreeTestSession` /
`continueFreeTestSession` (pilot) + routes `/api/e2e/agent-sessions`
(GET list, POST new/continue) ; `buildFreeTestPrompt` (session-bridge).

Dépôt : `opencode-observability` (v0.9.26).

## v0.9.25 — 2026-09-06 · Tests E2E : filtre de statut « actif » par défaut

La page **Tests E2E** filtrait par défaut sur « tous les statuts » (y compris
OBSOLETE/DRAFT), noyant les tests actifs. Le filtre de statut est désormais
**`actif` par défaut** (options : tous / actif / obsolète / quarantaine /
brouillon). Message de liste vide adapté au filtre en cours.

Dépôt : `opencode-observability` (v0.9.25).

## v0.9.24 — 2026-09-06 · Documents de référence : sélection visible par défaut dans les modales

Les fieldset « Documents de référence » des modales **création de test E2E**
(via agent) et **création de recette** étaient masqués tant qu'aucun document
n'était enregistré — l'utilisateur ne voyait aucune option de contexte.

- Le fieldset est **toujours affiché** et liste les **3 catégories** (ADR /
  User stories + règles métier / Gherkin), **toutes cochées par défaut** ; les
  documents enregistrés du (des) projet(s) apparaissent sous leur catégorie
  (cochés) ; une catégorie vide reste visible (rappel de gestion).
- Case catégorie = coche/décoche ses documents ; une sélection **entièrement
  décochée = aucun document** en contexte (plus de repli « tous »).

Dépôt : `opencode-observability` (v0.9.24).

## v0.9.23 — 2026-09-06 · Documents de référence : import depuis le PC

Les documents de référence (ADR-12 : `adr-tech`, `specs-fonctionnelles`,
`scenarios-gherkin`) pouvaient être référencés par chemin mais pas importés
depuis le poste de l'utilisateur.

- Modal « 📄 Docs de référence » (projet/repo) : mode **« Importer depuis mon
  PC »** — fichier (`.md/.markdown/.txt/.feature/.adoc`, max 2 Mo) stocké dans
  `storage/ref-docs/` puis enregistré comme doc rattaché au projet/repo ; le
  mode « Référencer un chemin existant » reste disponible.
- Aperçu du contenu importé (rendu markdown / feature / texte) via
  `/api/docs/file?p=…` + bouton « Voir » dans la liste des docs.
- Backend : `registerDocUpload` (pilot) + route POST /api/docs (upload vs path).

Dépôt : `opencode-observability` (v0.9.23). Doc : ADR-12 §5.

## v0.9.22 — 2026-09-06 · Documents de référence projets/repos (ADR-12)

Un projet (produit) et un repo peuvent être associés à des **documents de
référence** : ADR technique (`adr-tech` — stack, archi cible, composants,
design patterns, structure de dossiers), specs fonctionnelles (`specs-
fonctionnelles` — User stories + règles métier), scénarios Gherkin
(`scenarios-gherkin`). Pas de contenu en base : `path` pointe le fichier que
les agents **lisent en contexte**.

- **Registre** : tables `docs` + `doc_projects` + `doc_repos` (N:N) ; MCP
  `doc_register/update/delete/get/list` ; docs exposées sur `project_list`/
  `project_get`, `repo_list`/`repo_get`, `e2e_test_get` (`test.docs`).
- **Contexte agents (chemins, cases à cocher)** : création/MAJ de test E2E —
  les modales proposent les documents du projet (cochés par défaut) →
  injectés dans `buildTestPrompt` ; recette — les documents des projets
  couverts sont proposés à la création et rattachés à la recette
  (`recette_documents`, nature `[kind]`) + liste dans `buildRecettePrompt`.
- **Panel** : onglet Projets — bouton « 📄 Docs de référence » (gestion par
  projet/repo) ; cases à cocher dans la création de test via agent et la
  création de recette ; bloc documents dans le détail d'un test E2E.
- **Agents** : `test-agent` lit les docs fournis avant d'écrire un spec ;
  `agent-recette` lit les documents rattachés (ADR/specs/Gherkin) pour
  confronter le constat.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.24) · `opencode-observability`
(v0.9.22) · `opencode-agents` (v0.6.11). Doc : ADR-12.

## v0.9.21 — 2026-09-06 · Rapport E2E texte RICHE : transcript horodaté des étapes (PASSED / SKIPPED / FAILED)

Le « rapport texte » d'une exécution E2E n'est plus un JSON squelettique
(`runId`/`status`/`duration`) : il trace **chaque étape du test, horodatée**,
quel que soit le statut. L'agent de recette (et l'humain) sait précisément ce
qui s'est passé, et POURQUOI (raison d'un SKIP, échec d'une étape).

- **StepReporter** (dépôt applicatif) : chaque ligne `[STEP]/[INFO]/[PASS]/
  [FAIL]/[GAP]/[RESULT]` porte un **horodatage** `+MM:SS.mmm` (temps écoulé
  depuis le début du test, même origine que la ligne de temps de la vidéo) +
  l'heure murale `(HH:MM:SS.mmm)` — préparation au sous-titrage texte ↔ vidéo.
- **e2e-runner** : extrait l'attachment « rapport-e2e-texte » (body du JSON
  Playwright) → écrit `report-<runId>-<n>.txt` ; lit l'annotation `test.skip`
  → `skipReason` ; compose `[REPORT-TEXTE]/[SCENARIO]/[SPEC]/[STATUS]` +
  transcript + `[SKIPPED] raison` / `[FAILED] erreur` + `[DURATION]`.
- **Registre** : `e2e_executions.skip_reason` (colonne) ; import copie le
  `.txt` comme artefact (`logsUrl` → rapport texte), summary = dernières
  lignes du transcript + raison ; `e2e_execution_update` accepte `skipReason`.
- **Panel** : exécutions d'un test & bloc E2E d'une tâche affichent la raison
  SKIPPED en clair ; « Rapport (texte) » ouvre le transcript complet.

Dépôts : `opencode-scripts` (v0.2.3) · `opencode-mcp-task-orchestrator`
(v0.8.23) · `opencode-observability` (v0.9.21) · applicatif mada-talk
(StepReporter horodaté).

## v0.9.20 — 2026-09-06 · Test E2E : repos de code associés définis à la création (couverture)

Un test E2E ne se contente plus d'un projet : ses **repos de code associés**
(`repoIds` = repos traversés, ADR 11) sont maintenant **définissables dès la
création** — ils constituent la **couverture** du test, lisible par l'agent de
recette dès le départ (ex. S1 traverse `mada-talk` ET `oniria`).

- **MCP** (`e2e_test_register` / `e2e_test_update`) : paramètre `repoIds` exposé
  (remplace le `coveredProjects` obsolète) ; registre sans `repoIds` → défaut =
  tous les repos du projet. `e2e_list(taskId)` renvoie désormais les `repos` de
  chaque test (la couverture, pour l'agent de recette).
- **Panel** : les modales de création de test (« enregistrer un test existant »
  et « créer via test-agent ») affichent un **sélecteur de repos de code
  associés** (repos du projet, tous cochés par défaut). La table et le détail
  du test affichent ces repos.
- **Tâche requise depuis un test** : la tâche créée (`+ Créer une tâche
  (requise)`) **hérite des repos du test** → la couverture est visible sur la
  tâche aussi.
- **Agents** : `test-agent` renseigne `repoIds` (couverture, repos traversés) à
  l'enregistrement ; `agent-recette` lit `test.repos` pour connaître la couverture
  d'un test associé (où regarder / quoi vérifier).

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.22) · `opencode-observability`
(v0.9.20) · `opencode-agents` (v0.6.9).

## INCO-012 (résolution, 2026-09-06) — run E2E CI rejeté (repoDir absent)

Écart tracé par la tâche B ADR 10 (étape CI finale E2E) : au 1er déclenchement
réel, le step CI « Run E2E recette » exécutait `e2e-run-ci.mjs` mais `e2e_run`
rejetait l'appel (`repoDir: expected string, received undefined`) — le script
(corrigé ADR 11) ne passe plus `repoDir`, le MCP l'exigeait.

**Résolu (MCP v0.8.21)** : `e2e_run` rend `repoDir` **optionnel** quand
`e2eTestId` est fourni et résout le repo d'exécution depuis les repos traversés
du test (celui dont `e2eRepoDir` contient le spec). Validé : run sans `repoDir`
fonctionne. Détail : ADR 10 §10.

## v0.9.17 — 2026-09-06 · Mécanisme de déploiement CI/CD par repo (champ `deploy`)

Le mécanisme de déploiement n'est plus une instruction d'agent éparse : il vit au
niveau du **repo** et est fourni en contexte à l'orchestrateur au traitement.

- `repos.deploy` (texte libre) : workflows CI/CD, branches de déclenchement,
  cibles de CE repo. Renseigné pour `mada-talk` (preprod-deploy.yml sur main →
  /var/www/preprod-client.madatalk.fr) et `oniria` (core-build-deploy.yml sur
  oniria-preprod + package-build-deploy.yml via branches `packages/*`, PM2).
- `task_get` → `task.repos[].deploy` ; `buildLaunchPrompt` injecte le mécanisme
  de chaque repo dans le prompt orchestrateur (« déploiement repo par repo via
  son CI/CD, jamais manuel »).
- Panel : modale repo (champ « Mécanisme de déploiement CI/CD ») + carte projet
  (résumé par repo).

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.18) · `opencode-observability`
(v0.9.17) · `opencode-agents` (v0.6.7).

## v0.9.15 — 2026-09-06 · Tâches émergentes (demande hors scope → nouvelle tâche liée)

Quand un agent reçoit, pendant sa tâche, une demande utilisateur **hors scope**,
il crée une **tâche émergente** : nouvelle tâche dédiée, liée à sa source.

- `task_links.relation_type` : `linked` (défaut) | `emergent`.
- `task_register` accepte `originTaskId` (+ `originReason`) → crée la tâche +
  lien **émergent → source** (`relation_type='emergent'`). `task_link_add`
  accepte `relationType`.
- `task_get` renvoie `emergentFrom` (tâches émergentes créées depuis cette
  tâche) et `linkedTasks` avec `relationType`.
- Panel : détail tâche — badge « émergente » sur les liens + section
  « Tâches émergentes créées depuis cette tâche » (avec Ouvrir).
- Agents v0.6.6 : règle orchestrateur — ne pas dévier la tâche courante ; créer
  la tâche émergente liée à la source ; informer ; continuer.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.17) · `opencode-observability`
(v0.9.15) · `opencode-agents` (v0.6.6).

## v0.9.12 — 2026-09-06 · ADR 09 : Projets ⇄ Repos (N:N) + tâches multi-repos

Le registre confondait « le projet (produit métier) » et « le dépôt de code » dans une seule
entité `project` (oniria sans repo, mada-talk = repo, pbn = vrai repo ONIRIA…).
Modèle cible validé (doc `09-modele-projets-repos.md`) :

- **Projet** : porteur des tâches/recettes/tests (produit métier).
- **Repo** : dépôt de code physique (workspace Coder, **répertoire du dépôt** =
  ancien `git_path`, **branche(s) de déploiement**, `e2e_repo_dir`/url) —
  rattaché à 1..N projets (N:N).
- **Tâches multi-repos** : une tâche = ≥1 projet ; elle travaille sur 1..N repos
  (défaut = tous ceux du projet) ; peut patcher plusieurs repos (éventuellement
  dans des workspaces différents).

Livré :
- Tables `repos` + `project_repos` (N:N) + `task_repos` ; backfill idempotent
  (n'élargit jamais une sélection restreinte).
- Fusions : repo `pbn` → `oniria` (données git PBN) ; projet `pbn` supprimé ;
  projet `mada-talk` → repos `[mada-talk, oniria]` ; branche de déploiement
  ONIRIA = `oniria-preprod` ; `git_path` exposé comme `repoDir` (répertoire du
  dépôt).
- MCP v0.8.15 : `repo_register/get/list/delete`, `project_repo_link/unlink`,
  `task_register/update` acceptent `repoIds`, `task_get` renvoie `task.repos`,
  `project_list` renvoie les repos par projet.
- Panel v0.9.12 : onglet Projets = le projet + gestion de ses repos (chaque repo :
  workspace / répertoire du dépôt / branche / e2e) ; création de tâche avec
  sélection des repos (défaut tous) ; détail tâche affiche les repos ; prompt
  d'orchestrateur multi-repos.
- Agents v0.6.5 : orchestrateur travaille repo par repo (worktree par repo,
  branche de déploiement par repo).

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.15) · `opencode-observability`
(v0.9.12) · `opencode-agents` (v0.6.5).

## v0.9.8 — 2026-09-06 · Pré-vol E2E : spec absent du checkout → run via worktree temporaire (git)

Solution long terme au problème du « test fantôme » et des runs vides : quand le
spec d'un test n'est pas dans le checkout d'exécution (branche de travail non
mergée, spec purgé de main mais vivant dans l'historique), le lancement ne part
plus à l'aveugle.

- **Pré-vol (MCP v0.8.11)** : `e2e_run` vérifie que le spec cible existe dans le
  `repoDir` avant de lancer Playwright.
  - Absent + `runFromRef` → création d'un **worktree temporaire** au commit
    (`/root/test-E2E/<projet>-<ts>-<sha>`, spec + helpers + config au commit,
    node_modules partagé), run isolé, **nettoyage auto** — rien restauré dans main.
  - Absent sans `runFromRef` → erreur structurée `SPEC_NOT_IN_CHECKOUT` listant
    les commits où le spec EXISTE (git log --all + cat-file : création et
    modifications, même après purge), avec branche / sha / date / sujet.
- **Panneau v0.9.8** : à l'échec pré-vol, modale « Test introuvable mais
  récupérable via git » → bouton « Lancer depuis ce commit » (relance avec
  `runFromRef`). Rappel visuel que rien n'est modifié dans main.
- **Agents v0.6.4** : test-agent relance avec `runFromRef` quand il reçoit
  `SPEC_NOT_IN_CHECKOUT`.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.11) · `opencode-observability`
(v0.9.8) · `opencode-agents` (v0.6.4).

## v0.9.7 — 2026-09-06 · Module Vars & Secrets E2E unifié (retour utilisateur)

Les « paramètres de test » (sensibles ou non) étaient source de confusion. On
généralise : **des variables d'env par PROJET**, un seul modèle, 2 types.

- **Table `e2e_vars(project, name, kind, value, value_enc, purpose)`** :
  `kind='variable'` (non sensible, en clair) | `kind='secret'` (chiffré
  AES-256-GCM). L'ancienne table `e2e_secrets` (v0.8.6) est migrée puis droppée.
- **Onglet « Vars & Secrets E2E »** : filtre par type (tous / variables /
  secrets), création/édition/suppression. Valeur des variables visible et
  éditable ; secrets jamais affichés.
- **Détail d'un test** : section « Variables & secrets du projet » + params
  historiques marqués dépréciés.
- **Modale de lancement** : variables projet = champs éditables (injectées
  d'office, édition = surcharge du run) ; secrets = cases à cocher (injectés si
  sélectionnés). Fini les params kind=secret / secretRef fantômes.
- **Injection run (MCP)** : variables auto → surcharges paramValues → secrets
  sélectionnés ; un secret n'est jamais surchargeable en clair.
- Outils MCP `e2e_var_set / e2e_var_list(kind) / e2e_var_delete` ; `e2e_secret_*`
  conservés en alias rétrocompat.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.10) · `opencode-observability`
(v0.9.7) · `opencode-agents` (v0.6.3).

## v0.9.6 — 2026-09-06 · Run E2E asynchrone + module Secrets E2E (retour utilisateur)

Le lancement d'un test E2E depuis le panneau tournait en rond (modale synchrone
bloquante, aucun feedback) et créait un test fantôme « (aucun test exécuté) » à
chaque run sans spec trouvé ; les « secrets » renseignés à la création n'étaient
jamais résolus.

- **Run ASYNCHRONE** : `POST /api/e2e-tests/:id/run` répond immédiatement
  (202 + jobId) ; un worker détaché (`e2e-run-worker.mjs`) relaie l'appel MCP
  e2e_run (jusqu'à 15 min) ; `GET /api/e2e/jobs/:jobId` suit l'état. La modale
  affiche « Run lancé (job …) » puis le détail s'ouvre au polling (4 s).
- **Module Secrets E2E** : variables d'env par PROJET (ex. `E2E_ADMIN_PASSWORD`),
  valeur chiffrée AES-256-GCM (MCP, clé root-only hors registre). Onglet
  « Secrets E2E » : CRUD (valeur saisie en password, jamais ré-affichée).
  Sélection par NOM dans la modale de lancement. Un secret ne peut pas être
  forcé via paramValues.
- **Anti-fantôme** : le runner n'émet plus d'entrée « (aucun test exécuté) » ;
  un run sans test renvoie une erreur explicite et trace (si ciblé) une
  exécution ERROR sur le test — pas de nouvelle entité.
- **Anti-doublon** : un run ciblé rattache l'exécution au test existant (plus de
  doublon spec relatif vs canonique).
- **Paramètres** : les anciens params `kind=secret` (secretRef fantômes) sont
  retirés ; les params ne portent que des valeurs non sensibles.
- **Grain test()** : sync alignée (scénario = titre du `test()`, pas du
  `describe`) — la création manuelle via test-agent produit le même grain.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.8) · `opencode-observability`
(v0.9.6) · `opencode-scripts` (v0.2.2) · `opencode-agents` (v0.6.2).

## v0.9.5 — 2026-09-06 · Contrat BDD/TDD : créer une tâche depuis un test + Gherkin + REQUIRED

Le test E2E devient un **contrat de comportement** (BDD/TDD) : rédigé par
test-agent avec une formalisation **Gherkin**, indépendant de l'état
d'implémentation, il peut **générer des tâches requises** à traiter avant d'être
PASS (ex. « bouton Traiter », « permission dashboard opérateur »).

- **MCP task-orchestrator v0.8.5** : `e2e_tests.gherkin` (Given/When/Then du
  comportement, description = demande libre) + relation `task_e2e.REQUIRED`
  (« la tâche doit être done pour que le test soit PASS »).
- **Panel v0.9.5** :
  - Détail d'un test : affiche le Gherkin, badge « ⚠ bloqué par N tâches
    REQUIRED non terminées » (avec liste + « Ouvrir la tâche »), bouton
    « + Créer une tâche (requise) » ;
  - Modale de création de tâche depuis un test (pré-remplie : projet = repo
    source, titre, demande = en-tête + description + Gherkin ; type
    feature/debug ; scope ; exécution directe) ;
  - Endpoint `POST /api/e2e-tests/:id/create-task` (création + lien REQUIRED) ;
  - Labels relation REQUIRED (« requis (bloquant) »).
- **Agents v0.6.1** : test-agent produit le Gherkin, signale les écarts
  (comportement non implémenté) comme tâches requises potentielles.
- **Cohérence checkouts** : `/root/mada-talk-preprod` (checkout hôte E2E) était
  en retard sur `origin/main` → resync marquait tout OBSOLETE. Mis à jour sur
  main + resync : mada-talk 18 ACTIVE. Purge totale E2E oniria assumée (152
  OBSOLETE) — tests oniria à recréer via test-agent.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.5) · `opencode-agents` (v0.6.1) ·
`opencode-observability` (v0.9.5).

## v0.9.4 — 2026-09-06 · Création de test E2E via session test-agent (flux Oui/Non)

Problème UX : « Nouveau test » enregistrait une entité dans le registre sans
créer le spec Playwright. Décision : distinguer « test déjà existant » et
« nouveau test à créer », la création passant par une **session test-agent**
rattachée au test (comme les sessions le sont aux tâches/recettes).

- **MCP task-orchestrator v0.8.4** : `e2e_tests.session_id` (session de
  création/mise à jour du test) + statut DRAFT (entité créée, spec en cours de
  rédaction). Outils `e2e_test_draft`, `e2e_test_session_set`.
- **Agents v0.6.0** : nouvel agent **test-agent** — cycle de vie complet des
  tests E2E (créer/MAJ/supprimer le spec, enregistrer entité + paramètres +
  projets couverts, lier des tâches, run de vérification sur rapport texte).
  Travaille dans le workspace Coder du repo source, branche de travail.
- **Panel v0.9.4** :
  - Modale « Nouveau test » : « le spec existe-t-il déjà ? » → **Oui**
    (enregistrement, champs requis) / **Non** (création via agent : projet +
    comportement/description → entité DRAFT puis session test-agent ouverte).
  - Détail d'un test : section « Session de création / mise à jour » (reprise
    si session rattachée, « Nouvelle session » pour forcer).
  - Endpoint `POST /api/e2e-tests/:id/session` (reprise/force) ; `handleE2ECreate`
    gère `viaAgent` (spec_file dérivé du titre, DRAFT + launch session).
  - pilot `launchTestSession` + `buildTestPrompt` (session-bridge).
- Badge DRAFT (« brouillon ») géré.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.4) · `opencode-agents` (v0.6.0) ·
`opencode-observability` (v0.9.4).

## v0.9.3 — 2026-09-06 · Nettoyage specs E2E ONIRIA legacy + fix obsolescence e2e_sync_repo

Décision utilisateur : supprimer les tests ONIRIA dont le spec a été créé
(commit git) **avant le 10/08/2026** — jugés obsolètes, perte de couverture
assumée. Le but est aussi de vérifier l'efficacité du resync automatique (T10).

- **Registre** : suppression de 156 tests ONIRIA créés < 10/08 (+ 213 exécutions,
  38 liens task_e2e en cascade). Le resync a d'abord recréé 51 tests car leurs
  specs existaient encore dans le repo → preuve que le registre reflète le repo.
- **Repo ONIRIA (branche core/suppression-specs-e2e-legacy, gate CI vert +
  déployée + mergée sur oniria-preprod)** : retrait de 18 spec files legacy
  (chatbot-management-v3-*, group-access-control, hello-world-v3-hot-plug,
  infomaniak-provider-v3, p22-access-management, pbn-network-autonomous,
  runtime-jobs-audit-history, v2-*…). Adaptations : playwright.config.ts
  (authenticatedSpecs réduit aux specs conservés), package.json (retrait des
  scripts test:e2e:runtime-smoke et test:e2e:p7-runtime), tests unitaires
  e2e-auth-harness et v2-access-form-ux recentrés sur le socle conservé,
  commentaire v3-view-hot-plug mis à jour. Le socle d'authentification
  (auth.setup.ts/e2e-auth.ts) et les specs madatalk-requests C1-C13 sont
  conservés.
- **MCP task-orchestrator v0.8.3** : fix `e2e_sync_repo` — l'obsolescence ne se
  déclenchait jamais (itération sur `known.tests` alors que `listE2ETests`
  renvoie un tableau). Après fix : 99 tests ONIRIA passés OBSOLETE ; le registre
  (52 ACTIVE) correspond exactement aux 9 spec files restants du repo.
- **Observabilité de la sync** : le registre `e2e_tests` reflète désormais
  fidèlement le repo (création des specs présents, OBSOLETE des disparus).

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.3) · repo applicatif `RINOHeinrich1/PBN`
(branche `oniria-preprod`) · `opencode-observability` (docs v0.9.3).

## v0.9.2 — 2026-09-05 · Runs E2E longs — timeout MCP dédié 20 min + flux UI vers l'historique

Le message « run trop long — vérifier dans l'historique » était un échec réel :
le client MCP du panel plafonnait tous les appels à 30 s et tuait le process MCP
(`child.kill`) pendant un `e2e_run` réel (plusieurs minutes) → le run
n'aboutissait jamais, l'import auto ne se faisait pas, l'historique restait vide.

- `mcp-client.mjs` : timeout dédié 20 min pour `e2e_run` / `e2e_sync_repo`
  (le reste reste à 30 s) + message de timeout avec la durée.
- Modale « Lancer » : fermeture immédiate + ouverture du Détail (historique) du
  test pendant le run ; re-rendu après import ; message explicite en cas de
  timeout. Capture des valeurs AVANT fermeture du modal.

Dépôt : `opencode-observability` (v0.9.2).

## v0.9.1 — 2026-09-05 · Modale « Lancer » E2E — pré-remplissage repoDir/baseUrl par projet

Cause racine : un test ONIRIA lancé depuis l'onglet Tests E2E partait dans le
mauvais checkout quand le repoDir saisi était erroné (spec inexistant → dump
config / ERR_CONNECTION_REFUSED sur le fallback 127.0.0.1:3000).

- Mapping E2E par projet : colonnes `projects.e2e_repo_dir` + `e2e_base_url`
  (MCP task-orchestrator v0.8.2), éditables dans Projets (« Checkout E2E » /
  « URL de test »). Renseigné : oniria → /root/oniria-preprod +
  https://preprod.madatalk.fr ; mada-talk → /root/mada-talk-preprod +
  https://preprod-client.madatalk.fr.
- Modale « Lancer » : pré-remplit repoDir + baseUrl depuis le projet du test
  (repli convention /root/<projet>-preprod).
- Fallback serveur handleE2ERun : dérive repoDir/baseUrl du projet si absents.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.2) · `opencode-observability`
(v0.9.1).

## v0.9.0 — 2026-09-05 · Tests E2E en entités de 1er niveau — implémentation (cadrage 08)

Mise en œuvre du cadrage `08-tests-e2e-independants.md` : les tests E2E sont des
entités indépendantes des tâches (multi-projets, exécutions propriété du test,
paramètres, onglet dédié).

- **MCP task-orchestrator v0.8.0** : schéma + outils — `e2e_tests` (+description),
  `e2e_test_projects` (projets couverts N:N, fallback repo source),
  `e2e_test_params` (kind url/string/secret/int/bool, default non sensible,
  secretRef hors registre), `e2e_executions` propriété du test (`origin`
  task|recette|ci|manual|session, task_id optionnel, param_values). Outils :
  `e2e_test_register` enrichi (coveredProjects/description), `e2e_test_update`/
  `get`/`obsolete`/`param_set`, `e2e_list` global (taskId/project/status/search),
  exécutions avec origin, `e2e_run` par `e2eTestId` (+ résolution spec/params,
  origin dérivé), `e2e_collect` origin=ci.
- **MCP task-orchestrator v0.8.1** : `e2e_sync_repo` (T10) — scan des spec files
  Playwright → upsert ACTIVE / OBSOLETE si disparu ; idempotent, historique
  conservé. Validé mada-talk (unchanged) + oniria-preprod (14 tests legacy créés).
- **Panel v0.9.0** : onglet **« Tests E2E »** — liste (projets couverts, dernier
  run, filtres projet/statut/recherche + pré-filtre par tâche), détail (infos,
  paramètres, tâches liées, historique + preuves texte/vidéo), créer/lancer/
  obsolète/lier-détacher une tâche. Colonne E2E de la table Tâches cliquable →
  onglet pré-filtré ; **liste retirée** de la modale d'actions (lien « Voir les
  tests E2E associés (N) »). Endpoints REST lecture SQL + écritures MCP ;
  sécurité : secrets jamais renvoyés ni surchargeables en clair.
- **Agents v0.5.0** : atomic-plan/build-notify enregistrent le test dès qu'un
  spec existe (`coveredProjects`, params, lien tâche en association) ; exécution
  par test avec origine ; orchestrateur §13 **gate doux** (T9) — décision humaine
  à la clôture si tests liés non PASSED ; agent-recette par `e2eTestId`
  (origin=recette).
- **Backfill (T8)** : origin posé sur les 342 exécutions historiques (290 task,
  52 recette) ; 265 tests ACTIVE backfillés `e2e_test_projects`.
- Doc `07-tests-e2e.md` marqué SUPERSÉDÉ par `08` pour le modèle d'entités.

Dépôts : `opencode-mcp-task-orchestrator` (v0.8.0, v0.8.1) ·
`opencode-observability` (v0.9.0) · `opencode-agents` (v0.5.0).

## v0.8.44 — 2026-09-05 · Cadrage : tests E2E en entités de premier niveau (indépendants des tâches)

Document de conception `08-tests-e2e-independants.md` (pas d'implémentation) :
les tests E2E deviennent des entités 1er niveau du registre, **indépendantes des
tâches**, couvrant des comportements parfois transverses à **plusieurs projets**
(N:N). Points actés avec l'utilisateur :

- **Exécutions = propriété du test** ; la tâche/recette/CI/manuel devient une
  **origine optionnelle tracée** (`origin` + `task_id` optionnel).
- **Création** : entité enregistrée dès qu'un spec existe (tâche feature ou
  session de création dédiée depuis l'onglet Tests) ; la session reçoit les
  **tâches liées en contexte**.
- **Paramètres de test** (URL, compte, token…) : valeur par défaut + surcharge à
  l'exécution ; secrets hors registre (refs e2e.env).
- **UI** : nouvel onglet « Tests E2E » (liste, lancer, historique + preuves vidéo/
  texte, créer) ; colonne E2E de la table Tâches conservée → clic = onglet
  pré-filtré sur les tests de la tâche ; **liste retirée** de la modale d'actions.
- **Backfill** : entités/exécutions enregistrées + runs de recette récents
  (T-…9xkf) + runs CI orphelins de l'inbox.
- Décisions complémentaires : **gate doux** à la clôture (décision humaine si
  tests liés non passés), **synchronisation automatique** registre↔repo,
  **une seule exécution** multi-projets, workflow E2E ONIRIA **hors périmètre**.
- Points ouverts restants : droits de l'onglet Tests, formats des paramètres,
  rétention, point d'accroche de la sync auto.

Dépôt : `opencode-observability` (docs v0.8.44).

## v0.8.43 — 2026-09-05 · Correctif outillage e2e_run (cible ONIRIA + specPattern/config Playwright)

Constat recette 05/09 : le run run-1788593835619 a exécuté la config Playwright
complète du dépôt ONIRIA (36 tests) contre `http://127.0.0.1:3000` (défaut) au
lieu des specs ciblées et de la cible déployée voulue → 36 exécutions non
représentatives importées sur T-20260904-121804-9xkf. Trois défauts dans
`e2e_run` (MCP task-orchestrator), corrigés :

- **Environnement du run** : `ONIRIA_E2E_BASE_URL` est désormais injecté avec la
  même valeur que la cible (`E2E_BASE_URL` reste posée — rétrocompat mada-talk).
  Les configs Playwright du dépôt ONIRIA lisent `ONIRIA_E2E_BASE_URL` (défaut
  `http://localhost:3000` sinon) → plus de run qui vise `127.0.0.1:3000` quand
  une `baseUrl` externe est passée. Propagation des secrets `ONIRIA_E2E_*`
  présents dans l'e2e.env (sans écraser `process.env`).
- **`specPattern` réellement transmis** : il était déclaré dans le schéma mais
  jamais passé au runner — désormais placé après le séparateur `--` (args
  positionnels Playwright) → run ciblé au lieu de la config complète du dépôt.
- **`playwrightConfig` + `pwArgs[]`** : nouvelle sélection de config Playwright
  dédiée (`--config=playwright.madatalk-requests.recette.config.ts`) et args
  Playwright supplémentaires (ex. `--project=authenticated`) via `--`, sans
  collision avec le `--project` du registre ni avec la config.
- Runner `opencode-scripts` v0.2.1 : trace `pwArgs` + `e2eBaseUrl` dans le
  manifest (le runner propage déjà tout ce qui suit `--` à `npx playwright test` ;
  aucune adaptation `--config` nécessaire).

Le run témoin INVALIDE run-1788593835619 (36 exécutions) est écarté/documenté
comme non représentatif sur la tâche liée.

Dépôts : `opencode-mcp-task-orchestrator` (v0.7.4) · `opencode-scripts` (v0.2.1) · `opencode-observability` (docs v0.8.43).

## v0.8.42 — 2026-09-04 · Recette : retirer un élément (recette_item_delete / bouton panneau)

- MCP v0.7.3 : outil recette_item_delete (itemId) — utilisé pour fusionner /
  consolider des éléments (ex. regrouper des doublons en un seul élément).
  Garde : refus si une tâche a déjà été créée depuis l'élément (task_created).
- Panel : bouton « ✕ » par élément dans la modale de détail d'une recette NON
  faite (masqué si item task_created) + endpoint DELETE /api/recettes/:id/items/:itemId.

## v0.8.41 — 2026-09-04 · Recette + E2E : agent-recette vérifie et déclenche les tests

- agents v0.4.12 : agent-recette utilise e2e_list / e2e_execution_list
  (rapport TEXTE) pour confronter scénario E2E ↔ comportement réel des tâches
  couvertes ; signale les divergences en éléments avec référence ; peut
  déclencher un run via e2e_run. Jamais d'interprétation de vidéo.
- mcp v0.7.2 : outil e2e_run (runner E2E_EXTERNAL sur repoDir + import auto,
  creds compte de test dans /root/.config/opencode/e2e.env root-only).
- SPA madatalk : scaffold Playwright + spec login authentifié PASS (préprod) sur
  branche build-notify/e2e-playwright + workflow e2e.yml.

## v0.8.40 — 2026-09-04 · E2E : exécution directe, runner CI, lifecycle & docs (cadrage 07)

- Agents v0.4.11 : analyse d'impact E2E en exécution DIRECTE (sans atomic-plan)
  + trace événements E2E_* ; gate « pas de done sans E2E PASS ou NA justifié ».
- opencode-scripts v0.2.0 : e2e-runner.mjs (instance éphémère Playwright →
  manifest + vidéos pour le collecteur).
- Docs 07-tests-e2e.md : contrat du manifest CI + état d'implémentation.
- Statut E2E séparé du statut tâche ; vidéo = preuve humaine ; humain sollicité
  via decision_request (awaiting_validation) en cas d'échec non résolu.

## v0.8.39 — 2026-09-04 · Panel : badge E2E en table + lecteur vidéo + téléchargements

- Table des tâches : colonne « E2E » avec badge agrégé E2E ✓ / ✗ / … (ou — si
  aucun test associé) ; agrégat serveur (dernier statut par test lié).
- Détail tâche : lecteur vidéo INTÉGRÉ (0.25x/0.5x/1x/1.5x/2x) ; téléchargement
  d'une vidéo et de TOUTES les vidéos de la tâche en ZIP
  (GET /api/tasks/:id/e2e/videos.zip, CLI zip). Rapport texte toujours dispo.

## v0.8.38 — 2026-09-04 · Panel : section « Tests E2E » dans le détail de tâche

Affichage (lecture) des E2E associés à une tâche : id, scénario, spec file,
relation (créé/modifié/régression/existant), statut de la dernière exécution,
durée, itération (i/3), synthèse textuelle, boutons « Rapport (texte) » et
« ▶ Voir la vidéo » (stream restreint storage/e2e via /api/e2e/file). Rempli
async depuis GET /api/tasks/:id/e2e ; masqué si aucun test associé.

## v0.8.37 — 2026-09-04 · Tests E2E : collecteur hôte + lecture (début d'intégration cadrage 07)

Première tranche de l'intégration E2E (cadrage 07-tests-e2e.md) côté orchestration :
- MCP task-orchestrator v0.7.0 : registre e2e_tests (1/test()), liens task_e2e
  (N:N, relation+reason), exécutions e2e_executions (rapport texte partagé
  IA+humain, vidéo humaine) + outils e2e_test_register/link/unlink, e2e_list,
  e2e_execution_record/update/list.
- Panel : collecteur hôte pilot.collectE2EResults(runId) — importe un run CI
  (storage/e2e/inbox/<runId>/manifest.json + résultats) vers le registre,
  conserve rapports (texte) et vidéos (humain) sous storage/e2e/runs/ ;
  rétention mensuelle pruneE2EVideos(days).
- Endpoints : POST /api/e2e/collect, POST /api/e2e/prune (admin),
  GET /api/tasks/:id/e2e (tests + exécutions), GET /api/e2e/file (stream
  rapport/vidéo, accès restreint). .gitignore storage/e2e.

## v0.8.36 — 2026-09-02 · Recette : rattacher/détacher des tâches couvertes après création

- **MCP task-orchestrator v0.6.11** : outil `recette_unlink_task` ; garde sur
  `recette_link_task` — la tâche ajoutée doit appartenir à l'un des projets
  rattachés à la recette.
- **Panel v0.8.36** : endpoints `POST /api/recettes/:id/tasks` et
  `DELETE /api/recettes/:id/tasks/:taskId` ; modale de détail d'une recette non
  faite : **✕ retirer** sur chaque tâche couverte et sélecteur **« + Ajouter une
  tâche couverte… »** (candidates des projets rattachés, non déjà couvertes).

Dépôts : `opencode-observability` (v0.8.36) · `opencode-mcp-task-orchestrator`
(v0.6.11).

---

## v0.8.35 — 2026-09-02 · Recette : ajouter/retirer un projet rattaché à une recette existante

Suite multi-projets — gestion des projets **après création** :
- **MCP task-orchestrator v0.6.10** : outils `recette_project_add` /
  `recette_project_remove` (refus du dernier projet ; refus si la recette
  couvre encore des tâches de ce projet ; `recettes.project` legacy bascule sur
  le 1er projet restant).
- **Panel v0.8.35** : endpoints `POST /api/recettes/:id/projects` et
  `DELETE /api/recettes/:id/projects/:project` (pilot) ; dans la modale de
  détail d'une recette non faite : **ajouter** un projet (liste des projets
  connus non rattachés) et **retirer** un projet (×, masqué si un seul projet).

Dépôts : `opencode-observability` (v0.8.35) · `opencode-mcp-task-orchestrator`
(v0.6.10).

---

## v0.8.34 — 2026-09-02 · agent-recette : prompt multi-projets sans ambiguïté

Correctif de cohérence du prompt `agent-recette` (v0.4.9) après l'introduction
des recettes multi-projets : suppression des formulations mono-projet
contradictoires restantes (« rattaché à un PROJET »), alignement du contexte
(`recette_get` → `projects[]`, pas de projet principal), **projet cible** affiché
dans la liste consolidée de clôture, et règle de lecture FS bornée aux projets
couverts.

Dépôt : `opencode-agents` (v0.4.9) · docs `opencode-observability` (v0.8.34).

---

## v0.8.33 — 2026-09-02 · Recette multi-projets (1..N) + item rattaché à un projet

Une recette peut désormais être rattachée à **un ou plusieurs projets** (plus
aucun « projet principal » métier) et chaque élément relevé cible **un projet**
(celui où la tâche sera créée à la clôture).

- **MCP task-orchestrator v0.6.9** : table `recette_projects` (recette_id,
  project) + colonne `recette_items.project` ; `recette_start(projects≥1)`,
  `recette_item_add/update(project)`, retours enrichis (`projects`, items avec
  `project`) ; migration idempotente + backfill des recettes/items existants
  (projet legacy = 1er projet).
- **Panel v0.8.33** : création multi-projets **en une étape** (cocher les
  projets → « Charger les tâches disponibles » tous projets, tâches étiquetées
  par projet) ; puces projet sur les cartes recettes, détail, section recette du
  détail tâche et sur chaque item ; à la clôture chaque tâche est créée dans le
  **projet de son item** (fallback 1er projet) ; `/api/recettes/candidates`
  multi-projets (`?project=a&project=b`), liste/filtre recettes via
  `recette_projects`, détail enrichi.
- **Agent-recette v0.4.8** : `project` obligatoire par item (parmi les projets
  de la recette) ; prompt de session multi-projets (`buildRecettePrompt`).

Dépôts : `opencode-observability` (v0.8.33) · `opencode-mcp-task-orchestrator`
(v0.6.9) · `opencode-agents` (v0.4.8).

---

## v0.8.32 — 2026-09-02 · Décisions humaines « canal B » visibles et actionnables dans le panneau

Deux canaux de décision coexistaient mais étaient confondus : les **permissions
d'outil** (bash/edit…, `permission_id` présent, résolues **dans la session de
l'agent**) et les **décisions humaines « besoin »** (prérequis infra,
autorisations hors commande — demandées par un agent via `decision_request`,
**sans `permission_id`**). Les secondes, souvent typées `kind=permission`,
étaient **invisibles et non actionnables** (ni en session, ni au panneau).

Correctif — critère unique et fiable : **`awaiting` + `permission_id IS NULL`
+ `kind <> 'recette'`** =
« décision humaine actionnable » (canal B), quel que soit le `kind`.
- détail de tâche : la section « Validation (décisions en attente) » inclut
  désormais ces décisions (fini l'exclusion par `kind='permission'`) ;
- **onglet « Décisions humaines »** : colonne d'action (remarques + Approuver /
  Rejeter) sur les décisions canal B — l'onglet n'est plus lecture seule ;
- badge « ⏳ attente humaine » de la table des tâches étendu au canal B.
- Les permissions d'outil (`permission_id` présent) restent réservées à la
  session de l'agent (non actionnables au panneau).

Dépôt : `opencode-observability` (v0.8.32).

---

## v0.8.31 — 2026-09-02 · atomic-plan : exploration lecture seule sans friction headless

Correctif d'infrastructure suite au blocage de la planification
`T-20260903-115954-xrcy` (frontend SPA madatalk) : la décision enregistrée
comme « permission rejetée » était en réalité un **auto-deny du runtime
opencode** (fail-closed ~17 ms) sur une commande bash composée (segment
`xargs grep`) non couverte par les permissions d'atomic-plan, dans une
sous-session headless sans approbateur interactif.

- `opencode-agents` v0.4.7 : permissions bash lecture seule étendues
  (`xargs grep*`, `xargs -0 grep*`, `git ls-tree*`, `git cat-file*`,
  `git show-ref*`, `git for-each-ref*`, `node -e*`) + règle de conduite
  « privilégier read/grep/glob et les commandes simples ; éviter les pipelines
  composés » ;
- registre : événement `PERMISSION_CONTEXT_CORRECTED` tracé sur la tâche
  (auto-deny, pas un rejet humain).

Dépôts : `opencode-agents` (v0.4.7) · `opencode-observability` (docs v0.8.31).

---

## v0.8.30 — 2026-09-02 · Recettes : une recette = une session (boutons simplifiés) + cartes responsives

Suite au retour utilisateur sur la v0.8.28, l'UI recette est **simplifiée** :
- suppression des boutons « Continuer la session » et « Nouvelle session » ;
- **une recette = une session** : le bouton **« Session de la recette »** reprend
  la session en cours (ou en crée une la première fois) ; **« Terminer la
  recette »** clôture et reste bien visible quand la recette est `in_progress` ;
- **cartes recette responsives** : `.project-card-actions` passe en `flex-wrap`
  (et boutons pleine largeur empilés en mobile) — corrige le débordement qui
  pouvait masquer « Terminer la recette » et rendait le card non responsive.

L'option API `force` (nouvelle session explicite) reste disponible côté serveur,
simplement plus exposée dans l'interface.

Dépôt : `opencode-observability` (v0.8.30).

---

## v0.8.29 — 2026-09-02 · Onglet Tâches : pré-filtres « À recetter » et « Actif »

Deux filtres rapides (cases à cocher, cumulables en ET avec le filtre projet et
les tags de statuts) sur la table des tâches :
- **« À recetter »** : ne garde que les tâches dont la recette n'est pas faite
  (`recette_status != done`, inclut pending jamais recettées + legacy approved).
- **« Actif »** : ne garde que les tâches dont le statut d'exécution n'est pas
  `done` (tout statut intermédiaire ou terminal non-done : queued, in_progress,
  failed, aborted…).

Choix persistés (localStorage) et conservés après re-rendu (polling / retour
d'onglet) comme les autres filtres.

Dépôt : `opencode-observability` (v0.8.29).

---

## v0.8.28 — 2026-09-02 · Bouton « Session de la recette » : reprise systématique (fini les doublons)

Bug général corrigé : cliquer sur « Session de la recette » créait une **nouvelle
session à chaque clic** au lieu de continuer l'ancienne. Cause : la reprise
dépendait d'une détection `opencode session list` scopée au répertoire — or ce
répertoire (cwd du serveur au lancement) varie selon les redémarrages pm2 et le
`git_path` du projet peut être NULL (`mada-talk`) → faux négatif → nouvelle
session + écrasement de `recettes.session_id`.

Correctif :
- **reprise systématique** dès qu'une session `ses_…` est rattachée à la recette
  (plus aucun doublon automatique) ;
- bouton principal renommé **« Continuer la session »** quand une session existe ;
- nouveau bouton **« Nouvelle session »** (carte Recettes + section Recette du
  détail tâche) pour repartir de zéro explicitement (`POST …/session {force:true}`),
  l'ancienne session restant consultable.

Dépôt : `opencode-observability` (v0.8.28).

---

## v0.8.27 — 2026-09-02 · Onglet Tâches : filtre statut multi-valeurs (tag input)

Le combo « statut » à valeur unique est remplacé par un **filtre à valeurs
multiples** : des **puces (tags)** pour chaque statut affiché + un sélecteur
« + Ajouter… » pour en ajouter d'autres. La liste montre les tâches dont le
statut correspond à **l'un des statuts sélectionnés** (cumulable avec le filtre
projet). Chaque puce se retire d'un clic (×) ; bouton « tout afficher » pour
vider. Choix **persisté** (localStorage, conservé après re-rendu polling / retour
d'onglet) et **responsive** (le tag-input passe en pleine largeur et les puces
se répartissent sur plusieurs lignes en mobile).

Dépôt : `opencode-observability` (v0.8.27).

---

## v0.8.26 — 2026-09-02 · Onglet Tâches : filtres projet/statut conservés après re-rendu

Les filtres **projet** et **statut** de l'onglet Tâches étaient perdus à chaque
re-rendu de la liste (polling périodique, retour d'onglet navigateur via
`visibilitychange`). Ils sont désormais **persistés** (état + `localStorage`,
comme les cases « Grouper par recette / tâches parallèles ») et **restaurés**
après reconstruction des `<select>` ; l'option filtrée est conservée même si
aucune tâche ne correspond temporairement.

Dépôt : `opencode-observability` (v0.8.26).

---

## v0.8.25 — 2026-09-02 · Recette faite : bouton « Détail de la recette » (modal items lecture seule)

Quand une recette est **terminée** (`done`), le bouton « Terminer la recette »
disparaît (normal) — à la place un bouton **« Détail de la recette »** apparaît :
- dans la **section Recette** du détail de tâche (onglet Tâches) ;
- sur la **carte de l'onglet Recettes**.

Il ouvre le **même modal que « Terminer »** mais en **lecture seule** (aucune
action de clôture) : liste des items avec classification, ordre d'exécution,
badge ⚠ vigilance, lien `→ T-…` vers la tâche créée, contenu (« Voir en
entier »), critère d'acceptation, scope — plein écran et défilement conservés.
`finishRecetteModal` refactoré en `recetteItemsModal(recetteId, 'finish'|'detail')`.

Dépôt : `opencode-observability` (v0.8.25).

---

## v0.8.24 — 2026-09-02 · Recette : titre dans la table des tâches, ordre d'exécution, points de vigilance, modal de clôture complet

Les **4 améliorations recette** demandées :

1. **Titre de la recette** affiché dans la table des tâches : le groupement
   « Grouper par recette » affiche `Recette — <titre>` (au lieu de l'id
   technique `RECT-…`) quand la recette a un titre.
2. **Ordre d'exécution** par élément de recette (`recette_items.exec_order`) :
   l'agent-recette renseigne un **ordre numérique** (obligatoire) — éléments
   **indépendants = même numéro** (exécutables en **parallèle**), élément
   dépendant = numéro supérieur. Nouvelle option **« Grouper par tâches
   parallèles »** dans la table (sous-groupes « Ordre N » + mention du nombre
   d'exécutions parallèles) ; badge `ordre N` sur les tâches issues de recette.
3. **Point de vigilance** par élément (`recette_items.vigilance`) : l'agent-recette
   signale les écarts sémantiques / zones fragiles ; badge `⚠ vigilance` (avec
   le détail en infobulle) dans la table, le détail de tâche, le détail de
   recette et le modal de clôture.
4. **Modal « Terminer la recette »** amélioré : défilement interne, bouton
   **plein écran** ⛶, **« Voir en entier »** pour les contenus tronqués, détail
   complet non tronqué (contenu + critère + vigilance + scope), rendu mobile.

Dépôts : `opencode-observability` (v0.8.24) · `opencode-mcp-task-orchestrator`
(v0.6.8) · `opencode-agents` (v0.4.6).

---

## v0.8.6 — 2026-09-01 · Titres de recette dérivés des titres des tâches

Les recettes legacy (« Recette de T-… ») sont **retitrées** avec le **titre court de la tâche couverte** (préfixe « issu de la recette » retiré, tronqué à 60). La modale de détail affiche les **titres des tâches couvertes** (plus d'IDs seuls).

Dépôt : `opencode-observability`.

---

## v0.8.5 — 2026-09-01 · Recette : titre court affiché + description longue en modale

L'onglet Recettes affiche le **titre court** (plus d'ID barbare) ; cliquer dessus ouvre une **modale de détail** (description longue, projet, statut, tâches couvertes, éléments). Champ « description » ajouté à la création (recettes.description). Purge des recettes orphelines (transition v0.8.0).

Dépôts : `opencode-observability` (v0.8.5) · `opencode-mcp-task-orchestrator` (v0.6.3).

---

## v0.8.4 — 2026-09-01 · Documents dans la modale de création de recette

La modale « Nouvelle recette » permet de **rattacher des documents dès la création** (importer un fichier ou lier un artefact) avec la **nature de liaison**. Titre par défaut = nom du fichier importé.

Dépôt : `opencode-observability`.

---

## v0.8.3 — 2026-09-01 · Documents rattachés aux recettes (import / artefact + nature)

**Recettes** : on peut rattacher un document (importé par upload, ou lien vers un artefact existant) avec la **nature de la liaison** (à quoi sert / comment l'exploiter). Bouton « Documents » sur chaque recette ; visionneuse markdown ; retrait.

- MCP v0.6.2 : `recette_doc_add` / `recette_doc_remove`, `recette_get` renvoie les documents.
- Panneau v0.8.3 : upload (base64 → `storage/recette-docs/`), lien artefact, liste, Regarder (md), Retirer.
- Agent-recette v0.4.1 : exploite les documents de la recette.

---

## v0.8.2 — 2026-09-01 · Modification des tâches en statut queued

**UX** : bouton « Modifier » dans la modale Actions pour une tâche `queued` — édite titre court, demande, critère d'acceptation, scope, priorité (MCP `task_update`, refusé si la tâche n'est plus queued).

Dépôts : `opencode-observability` (v0.8.2) · `opencode-mcp-task-orchestrator` (v0.6.1).

---

## v0.8.1 — 2026-09-01 · Sélecteur de tâches non recettées (création de recette)

**UX** : plus de saisie d'IDs à la main — la modale « Nouvelle recette » liste les **tâches non encore recettées** du projet (titre court + id + statut, cases à cocher, liste défilante). Endpoint `GET /api/recettes/candidates?project=`.

Dépôt impacté : `opencode-observability`.

---

## v0.8.0 — 2026-09-01 · Recette = objet de projet (titre, 0..N tâches) + titre/critère des tâches

**Objectif** : la recette devient un **objet métier de premier niveau** rattaché
au **projet** (titre propre, session dédiée, historique propre), couvrant
**0..N tâches** — plus besoin d'une session de recette par tâche. Les tâches
portent désormais un **titre court** et un **critère d'acceptation**.

### Changements

- **MCP `task-orchestrator` (v0.6.0)** :
  - `recettes` = projet + titre (0..N tâches via `recette_tasks`) ; colonnes
    `tasks.title`, `tasks.recette_id` ; `recette_items.title`/`acceptance` ;
  - **plus d'auto-création** de recette par tâche à `done` ;
  - `recette_start(project, title, taskIds)` · `recette_list(project)` ·
    `recette_get` · `recette_link_task` · `recette_session_set` ;
  - `recette_confirm` marque **toutes les tâches couvertes** `recette_status='done'` ;
  - `task_register` accepte `title`, `recetteId` ; `acceptance_criteria`.
- **Panneau (v0.8.0)** :
  - nouvel onglet **« Recettes »** : créer (projet + titre + tâches 0..N),
    lister, session, terminer la recette (synthèse → confirmation → tâches) ;
  - formulaire tâche : **Titre** + **Critère d'acceptation** obligatoires ;
  - liste des tâches : affiche le titre court ;
  - section recette du détail = la recette couvrant la tâche.
- **Agent `agent-recette` (v0.4.0)** : contexte projet (recette_get, tâches
  couvertes), éléments avec titre court + critère d'acceptation + scope.
- **Migration** : recettes existantes → projet + titre dérivé + tâche couverte ;
  titres des tâches backfillés (dérivés de la demande).

### Dépôts impactés

`opencode-observability` (v0.8.0) · `opencode-mcp-task-orchestrator` (v0.6.0) ·
`opencode-agents` (v0.4.0).

---

## v0.7.7 — 2026-09-01 · Liste des tâches : groupement par recette

**Objectif** : dans l'onglet Tâches, pouvoir **grouper les tâches par recette**
(dépliable/repliable) pour voir d'un coup d'œil toutes les tâches générées par
chaque recette.

### Changements (`opencode-observability` v0.7.7)

- **`/api/tasks`** renvoie `recette_source` (tâche recette source) pour chaque
  tâche issue d'une recette (via `task_links` « Issu de la recette »).
- **Onglet Tâches** : case **« Grouper par recette »** → les tâches issues d'une
  recette sont regroupées sous un en-tête « Recette de <tâche> » (nb de tâches +
  classifications), **dépliable/repliable** ; les autres sous « Autres tâches ».
  Badge « recette » sur les tâches issues d'une recette.

### Dépôts impactés

`opencode-observability` (v0.7.7).

---

## v0.7.6 — 2026-09-01 · Docs opérationnelles synchronisées (état v0.7.5)

Synchronisation des docs de référence avec le framework recette et les évolutions
récentes (v0.6.0 → v0.7.5) :

- **01-architecture** : concept « Recette » mis à jour (opération distincte,
  session dédiée, éléments, nouvelles tâches).
- **02-composants** : agent `agent-recette` ajouté ; fonctions de pilotage
  (`launchRecetteSession`, `finishRecette`).
- **03-workflow** : cycle de vie avec phase recette (`pending/in_progress/done`),
  section « Recette = phase distincte », tâches liées (v0.6.0).
- **04-reproduction** : framework recette + agent-recette.
- **05-reference** : tables `task_links`, `recettes`, `recette_items` ;
  `recette_class`/`scope` sur tasks ; sémantique recette ; endpoint
  `/api/metrics/recette` ; miroir EN.

Dépôt impacté : `opencode-observability` (docs).

---

## v0.7.5 — 2026-09-01 · « Attente humaine » ne compte plus les décisions recette legacy

**Problème** : des tâches (ex. T-20260831-174431) affichaient encore le badge
« ⏳ attente humaine » alors que la recette était terminée — causé par des
**décisions `recette` legacy restées `awaiting`** (ancien flux
`decision_request(kind="recette")`, que la clôture v0.7 ne résolvait pas).

**Correctifs** :
- **Panneau (v0.7.5)** : `waiting_human` ne compte plus que les décisions
  `validation`/`review` (la recette est désormais suivie via la table
  `recettes`, pas via une décision).
- **MCP `task-orchestrator` (v0.5.3)** : `recette_confirm` résout désormais les
  décisions `recette` legacy encore `awaiting` de la tâche.
- **Agent orchestrateur (v0.3.6)** : §13 mis à jour — la recette est entrée
  automatiquement à `done`, **plus aucune** `decision_request(kind="recette")`
  (obsolète) ; l'humain utilise la session dédiée `agent-recette` + « Terminer
  la recette ».
- Nettoyage des décisions recette stale existantes.

### Dépôts impactés

`opencode-observability` (v0.7.5) · `opencode-mcp-task-orchestrator` (v0.5.3) ·
`opencode-agents` (v0.3.6).

---

## v0.7.4 — 2026-09-01 · Observabilité alignée sur le framework recette (Phase D)

**Objectif** : aligner les KPI sur le nouveau modèle recette (opération
pending/in_progress/done, éléments classés, tâches générées) — l'observabilité
utilisait encore l'ancienne sémantique (approved/rejected).

### Changements (`opencode-observability` v0.7.4)

- **`summary`** : « Success » = `done` + recette **faite** (`done` nouveau /
  `approved` legacy) ; **taux de rework redéfini** = éléments de recette classés
  `rework` / total éléments ; `recette` stats incluses.
- **Nouveau `GET /api/metrics/recette`** : recettes par statut, nb d'éléments et
  répartition (rework/bug/improvement/feature), nb de tâches générées par
  classe, durée moyenne de recette.
- **Funnel qualité** : « Accepté » = recette `done`/`approved` ; « Sans rework »
  exclut aussi les tâches dont une tâche fille classée `rework` existe.
- **Rework dans le temps** : intègre les éléments de recette `rework` par jour
  (en plus des transitions plan rework et rejets legacy).
- **Dashboard** : nouveau panneau « Recette » (KPI cards + 2 graphiques : éléments
  par classification, tâches générées par classification).

### Dépôts impactés

`opencode-observability` (v0.7.4).

---

## v0.7.3 — 2026-09-01 · Scope des tâches issues de recette (rempli par l'agent-recette)

**Objectif** : le **scope** (périmètre) des tâches issues de la recette est
déterminé par l'**agent-recette** (renseigné sur chaque élément de recette), puis
**transmis à `task_register`** à la confirmation → l'orchestrateur peut
**sérialiser** les tâches parallèles qui se chevauchent.

### Changements

- **MCP `task-orchestrator` (v0.5.2)** : colonne `recette_items.scope` ;
  `recette_item_add` / `recette_item_update` acceptent `scope[]` ; renvoyé dans
  `task_get`/`recette`.
- **Panneau (v0.7.3)** : `finishRecette` transmet `scope` à `task_register`.
- **Agent `agent-recette` (v0.3.2)** : détermine et renseigne le `scope` de
  chaque élément (basé sur commits, tâches liées, chemins d'artefacts, plans).
- **Application immédiate** : scopes posés sur les 4 tâches issues de la recette
  de `T-20260831-174431` (`packages/p7-ecosystem/src/extensions/
  madatalk-requests/`, `apps/admin-next/` pour les tâches admin) → lancement
  parallèle sérialisé par la détection de conflits de scope.

### Dépôts impactés

`opencode-observability` (v0.7.3) · `opencode-mcp-task-orchestrator` (v0.5.2) ·
`opencode-agents` (v0.3.2).

---

## v0.7.2 — 2026-09-01 · Correctif « Session de recette »

**Problème** : le bouton « Session de recette » affichait « session existante »
sans ouvrir la session, car la recette portait un `session_id` **invalide**
(non `ses_…`, hérité d'un échec de lancement) — et aucune redirection n'était
faite vers la session.

**Correctif** (`opencode-observability` v0.7.2) :
- `launchRecetteSession` ne reprend une session que si l'id est valide (`ses_…`)
  **et** que la session existe réellement (`sessionExists`) ; sinon, lance une
  nouvelle session `agent-recette` (message d'erreur explicite si l'agent est
  indisponible).
- Le bouton **ouvre la session dans un nouvel onglet** (`window.open`) au lieu
  d'une simple alerte.
- Purge des `session_id` invalides dans la table `recettes`.

Dépôt impacté : `opencode-observability`.

---

## v0.7.1 — 2026-09-01 · Correctif session de recette

- **`task_link_session` accepte le kind `recette`** (MCP v0.5.1) — corrige
  « Échec de lancement de la recette : Invalid arguments … kind » au clic
  « Session de recette ».
- Nettoyage d'une tâche de test résiduelle (`T-20260901-075803`).

Dépôts impactés : `opencode-mcp-task-orchestrator` (v0.5.1).

---

## v0.7.0 — 2026-09-01 · Framework Recette (session dédiée, items, création de tâches)

**Objectif** : considérer la **recette** comme une phase distincte du cycle de
vie. Une tâche terminée n'est **plus modifiée** pendant sa recette : une session
**dédiée** (agent `agent-recette`), des **éléments consolidés** (remarques,
demandes, constats), une **classification** (rework / bug / improvement /
feature), puis — après **confirmation** — la **création de nouvelles tâches**
rattachées à la tâche initiale.

### Changements

- **Registre / MCP `task-orchestrator` (v0.5.0)** :
  - tables `recettes` (opération : pending/in_progress/done) et `recette_items`
    (contenu, classification, statut, tâche créée) ; colonne `tasks.recette_class`.
  - **entrée en recette automatique** dès que la tâche passe `done` ;
  - outils : `recette_start`, `recette_item_add`, `recette_item_update`,
    `recette_confirm` ; `task_get` renvoie la recette + ses items ;
  - `task_register` accepte `recetteClass` ; `newTaskId` **unique** (suffixe
    aléatoire — corrige la collision sur créations rapprochées) ;
  - gardes : tâche avec recette en cours/terminée = clôturée (aucune transition,
    aucune nouvelle décision).
- **Panneau (v0.7.0)** :
  - remplacement du bouton « Valider la recette » par la section **Recette** :
    « Session de recette » (lance/rejoint la session `agent-recette`) et
    « Terminer la recette » ;
  - « Terminer la recette » → **synthèse consolidée** (éléments + type + action)
    → **confirmation** → création des tâches via `task_register` (typées
    bug→debug, sinon feature), **liées** à la tâche initiale, `recette_class`
    renseignée, éléments marqués `task_created`, recette clôturée.
- **Nouvel agent `agent-recette` (opencode-agents v0.3.0)** : contexte réel
  (task_get, linkedTasks, commits, artefacts, événements, plans), accompagnement,
  enregistrement des items, classification, regroupement, préparation de la
  synthèse — **aucune création prématurée de tâches**, **aucune transition** sur
  la tâche initiale.

### Dépôts impactés

`opencode-observability` (v0.7.0) · `opencode-mcp-task-orchestrator` (v0.5.0) ·
`opencode-agents` (v0.3.0, nouveau `agent-recette.md`).

---

## v0.6.3 — 2026-09-01 · Sessions conservées (stop process, aucune suppression)

**Problème** : le correctif v0.5.2 supprimait les sessions à l'approbation de la
recette (`killSession` → `opencode session delete`) — le lien « session » et la
consommation devenaient indisponibles (tracabilité perdue).

**Correctif** (`opencode-observability` v0.6.3) :
- `killSession` ne supprime **plus jamais** l'enregistrement de session : il
  **arrête seulement les processus** `opencode run` (SIGTERM/SIGKILL) ; la
  session persiste sur disque → lien consultable + `opencode export` (consommation)
  valides (vérifié sur une session réelle : recette approuvée, process absent,
  export OK).
- Appliqué **partout** : approbation de recette **et** bouton « Tuer la session »
  (Actions).

> ⚠️ Les sessions supprimées avant v0.6.3 sont perdues définitivement (non
> récupérables). À partir de cette version, plus aucune suppression.

Dépôt impacté : `opencode-observability`.

---

## v0.6.2 — 2026-09-01 · Whitelist commandes d'inspection (planning)

**Problème** : une commande composée de lecture (`ls` + `echo` + `test -f`)
déclenchait une demande de permission (le segment `test` n'était pas dans la
liste blanche d'atomic-plan) et pouvait être rejetée, bloquant la planification.

**Correctif** (`opencode-agents` v0.2.2) : ajout à la liste blanche bash
d'atomic-plan des commandes d'inspection en lecture seule : `test`, `printf`,
`sha256sum`, `cut`, `xxd`, `base64`, `command -v`, `node --version`, `diff`,
`cmp`, `du`.

Dépôt impacté : `opencode-agents`.

---

## v0.6.1 — 2026-08-31 · Attente de validation quand un agent est bloqué par l'humain

**Règle métier** : quand un agent s'arrête parce qu'il **attend une validation
humaine** (permission refusée ou en attente, question posée, décision requise),
la tâche doit passer en **`awaiting_validation`** — jamais rester figée à
l'état précédent (`planning`, `in_progress`, …).

### Changements (`opencode-agents` v0.2.1)

- **Orchestrateur** : distinction explicite dans la règle « ne laisse jamais une
  tâche bloquée silencieusement » :
  - attend l'humain → `task_transition(to="awaiting_validation")` +
    `task_event(WAITING_VALIDATION, …)` ;
  - autre blocage (MCP, erreur) → `blocked`/`failed` + `task_event`.
  - + vérification à **chaque tour** (décision `permission` refusée ou
    sous-agent signalant une attente humaine → appliquer immédiatement).
- **atomic-plan** : s'il est bloqué par une permission refusée / question en
  attente → publie `task_event(WAITING_VALIDATION)` (si taskId) et revient avec
  un message explicite « bloqué — attente de validation humaine » (sans
  prétendre la planification terminée).

### Dépôts impactés

`opencode-agents` (v0.2.1). Aucun changement de machine à états (la transition
`planning → awaiting_validation` existait déjà).

---

## v0.6.0 — 2026-08-31 · Tâches liées (associées) + nature de liaison

**Objectif** : à la création d'une tâche, définir **une ou plusieurs tâches
associées** (liées) avec la **nature de la liaison** (ex. « c'est là que le
package a été créé »), exploitables par `atomic-plan` pour traiter la nouvelle
tâche (commits, étapes de plan, docs attachées).

### Changements

- **Registre / MCP `task-orchestrator` (v0.4.0)** :
  - table `task_links` (task_id, linked_task_id, description, created_at,
    dédupliqué par couple) ;
  - `task_register` accepte `linkedTasks[]` ({taskId, description}) ;
  - outils `task_link_add` / `task_link_remove` ;
  - `task_get` renvoie `linkedTasks` **enrichies** (request, statut, nb de
    plans, nb d'artefacts de la tâche liée).
- **Panneau (v0.6.0)** :
  - formulaire « Nouvelle tâche » : éditeur dynamique de **tâches liées**
    (taskId + nature de la liaison, lignes ajoutables/retirables) ;
  - détail de tâche (modale Actions) : section **« Tâches liées »** ;
  - `createTask` (pilot) transmet `linkedTasks`.
- **Planner `atomic-plan` (v0.2.0)** : à la planification, `task_get` →
  `linkedTasks` ; pour chaque tâche liée, exploiter **commits**
  (`plan_commits_list`/`task_get`), **étapes de plan** (`plan_get`/
  `progress_get`), **docs/résumés** (`artifact_list`), **déroulé**
  (`events_list`) pour situer les fichiers, réutiliser les conventions et
  justifier les étapes « en continuité de la tâche liée ».

### Dépôts impactés

`opencode-observability` (v0.6.0) · `opencode-mcp-task-orchestrator` (v0.4.0) ·
`opencode-agents` (v0.2.0).

---

## v0.5.2 — 2026-08-31 · Garde « recette validée = tâche clôturée »

**Problème** : après l'approbation de la recette, la session orchestrateur
restait vivante et continuait d'accepter de nouvelles demandes (relance
d'exécution, nouvelles décisions validation/review/recette) sur une tâche déjà
clôturée — l'utilisateur ne pouvait plus valider.

**Correctifs (défense en profondeur)** :

- **Prompt orchestrateur** (`opencode-agents`) : à **chaque tour**, `task_get`
  → si `recette_status='approved'`, la tâche est **clôturée** : aucune nouvelle
  demande, décision, transition, exécution ou déploiement.
- **Panneau** (`pilot.resolveRecette`) : à l'**approbation** de la recette, la
  session orchestrateur est **tuée** (`killSession`) — elle ne peut plus
  accepter de requêtes. (Non tuée en cas de rejet : le rework en a besoin.)
- **MCP `task-orchestrator`** (gardes dures) : `task_transition`,
  `plan_transition` et `decision_request` refusent toute opération sur une tâche
  dont la recette est déjà validée (erreur explicite + `TRANSITION_ERROR` pour
  les transitions).

**Dépôts impactés** : `opencode-observability` (v0.5.2) ·
`opencode-mcp-task-orchestrator` (v0.3.1) · `opencode-agents` (v0.1.5).

---

## v0.5.1 — 2026-08-31 · Docs opérationnelles synchronisées (état v0.5.0)

Synchronisation de la documentation de référence avec l'état courant :

- **02-composants** : onglet « Observabilité », fonctions de pilotage à jour
  (`createProject` avec branche principale, `resolveDecision` qui réveille la
  session), charting Chart.js local.
- **03-workflow** : statut `rework` non terminal, badge « attente humaine »,
  section « Branche principale & déploiement » (garde + pull avant push),
  décisions → réveil de session, création de projet.
- **04-reproduction** : guide mis à jour (métriques `/api/metrics/*`,
  branche principale obligatoire, rework, observabilité).
- **05-reference** : modèle de données (`projects.main_branch`,
  `scope_conflicts`), machines à états (rework non terminal), section
  « Endpoints observabilité ».
- **README** : mention de l'observabilité.

Dépôt impacté : `opencode-observability` (docs uniquement).

---

## v0.5.0 — 2026-08-31 · Branche principale par projet (obligatoire pour déployer)

**Objectif** : chaque projet définit une **branche principale** (obligatoire
depuis le panneau). Sans elle, **aucun déploiement n'est autorisé** ; avant de
pousser, on **pull depuis la branche principale**.

### Changements

- **Registre / MCP `task-orchestrator` (v0.3.0)** :
  - colonne `projects.main_branch` (migration idempotente) ;
  - `project_register` accepte `mainBranch` ; `project_get`/`project_list`
    l'exposent.
- **Panneau (v0.5.0)** :
  - formulaire projet : champ **« Branche principale » obligatoire** (création
    et modification) ;
  - refus côté API si `mainBranch` absente (« branche principale requise ») ;
  - carte projet : affiche la branche principale, ou un badge
    **« manquante — déploiement bloqué »**.
- **Orchestrateur (prompt §7-8, §12)** :
  - récupère `mainBranch` via `project_get` ;
  - **garde de déploiement** : pas de déploiement sans `mainBranch`
    (→ `blocked` + événement + info utilisateur) ;
  - **pull depuis la branche principale** avant de pousser vers git.
- **Exécuteur (prompt `build-notify`)** : `git pull --rebase origin
  <mainBranch>` avant tout push.
- Le projet **oniria** a été seedé avec `mainBranch=main` (à ajuster dans le
  panneau si besoin).

### Dépôts impactés

`opencode-observability` (v0.5.0) · `opencode-mcp-task-orchestrator` (v0.3.0) ·
`opencode-agents` (prompts).

---

## v0.4.1 — 2026-08-31 · Correctifs (7 bugs d'utilisation)

### Corrections

1. **Création automatique du projet** : `createProject` crée désormais le
   répertoire (+ `git init`) dans le workspace Coder via `workspace_exec`
   (non bloquant, avertissement si workspace injoignable).
2. **Attente humaine visible** : les tâches avec une décision en attente
   (validation/review/recette) affichent un badge « ⏳ attente humaine » dans la
   liste des tâches (drapeau `waiting_human` ajouté à `/api/tasks`).
3. **Consommation** : régression v0.2.0 corrigée — `taskConsumption(taskId,
   registry())` (l'appel omettait la connexion DB, d'où « Aucune session
   enregistrée »).
4. **Décisions → réveil de la session** : après approbation/rejet depuis le
   panneau, un message est injecté dans la session orchestrateur pour qu'elle
   continue automatiquement (`injectMessage`, non bloquant).
5. **Rework — session préremplie** : la modale « Reprendre » préremplit la
   session courante (dernière session de la tâche).
6. **Rework — remarques préremplies** : la remarque de reprise reprend par défaut
   la remarque de rejet de la recette.
7. **Rework bloqué** : la machine à états TÂCHE accepte désormais
   `rework → planned/in_progress/…/done` (état non terminal) ; le panneau
   affiche « Reprendre » et « Tuer la session » pour le statut `rework` ; le
   prompt orchestrateur documente la reprise (`rework → in_progress → done →
   ré-ouverture recette`).

### Dépôts impactés

`opencode-observability` (v0.4.1) · `opencode-mcp-task-orchestrator` (v0.2.1,
statemachine) · `opencode-agents` (prompt orchestrateur §13).

---

## v0.4.0 — 2026-08-30 · Observabilité Phase 3 (qualité, rework, coût)

**Objectif** : compléter le dashboard avec les dimensions **Qualité** et
**Coût vs Productivité** (les KPI worktree/ressources restent abandonnés).

### Dashboard (panneau `opencode-observability`)

- **Funnel qualité** : Completed → Audited → Accepted → Sans rework (barres
  proportionnelles + taux d'audit / d'acceptation / de propreté).
- **Rework dans le temps** (30 j) : reworks (transition plan `rework` +
  recettes rejetées) par jour, avec taux rapporté au done du jour.
- **Coût vs Throughput** (30 j) : coût journalier (sessions `opencode export`)
  en barres + tâches done en ligne (double axe).
- Endpoints : `/api/metrics/{quality,rework,costvsthroughput}`.

### Dépôts impactés

`opencode-observability` (v0.4.0). Aucune migration de schéma.

---

## v0.3.0 — 2026-08-30 · Observabilité Phase 2 + durcissement (Phase 4)

**Objectif** : enrichir le dashboard avec « où passe le temps » et « où sont
les blocages », et durcir la qualité des données (conflits de scope, erreurs de
transition, attribution des agents).

### Dashboard (panneau `opencode-observability`)

- **Répartition du temps par phase** (waterfall) : moyenne par phase sur toutes
  les tâches terminées (attente queue, planification, attente validation,
  exécution, attente review, finalisation, déploiement, bloqué, échec) +
  détail par tâche (`GET /api/metrics/timeline?taskId=`).
- **Blocages par raison catégorisée** (30 j) : MCP/outil, permission,
  worktree/scope, build/tests, externe/CI, agent, autre.
- **Success / Failure par jour** : barres empilées (done vs
  blocked/failed/aborted/crashed).
- **Durcissement** : cartes « Décisions expirées », « Conflits de scope »,
  « Erreurs de transition ».
- Endpoints : `/api/metrics/{phases,timeline,blocked,successfailure,hardening}`.

### Durcissement des données (MCP `task-orchestrator` v0.2.0, prompts)

- **Conflits de scope persistés** : nouvelle table `scope_conflicts` ; le tool
  `scope_conflict` enregistre désormais les conflits détectés (tâches actives +
  worktrees réservés).
- **Erreurs de transition tracées** : `task_transition` et `plan_transition`
  enregistrent un événement `TRANSITION_ERROR` (from/to/raison) quand la machine
  à états refuse.
- **Attribution stricte des agents** : les prompts (`build-notify`,
  `atomic-plan`, `orchestrator`, auditeurs) renseignent désormais explicitement
  `by="<nom agent>"` dans `task_event` et `by`/`requestedBy` dans
  `decision_request` — fiabilise les métriques par agent.
- Les KPI **worktree / ressources** sont abandonnés (usage peu fiable).

### Dépôts impactés

`opencode-observability` (v0.3.0) · `opencode-mcp-task-orchestrator` (v0.2.0) ·
`opencode-agents` (attribution).

---

## v0.2.0 — 2026-08-30 · Dashboard Observabilité (KPI Phase 1)

**Objectif** : répondre en quelques secondes à « combien de tâches ? À quelle
vitesse ? Avec quelle qualité ? Quels agents posent problème ? Quel coût ? »
via un dashboard système **Flow + Orchestration + Agents + Quality**.

### Changements (panneau `opencode-observability`)

- **Nouvel onglet « Observabilité »** dans le panneau :
  - **9 KPI cards** : tâches, terminées, en cours, Lead Time moyen / P95,
    Cycle Time moyen, **Success Rate** (définition : `done` **ET** recette
    approuvée), Throughput (tâches done / jour), Rework Rate.
  - **4 graphiques Chart.js** : évolution du Lead Time (P50 / moyen / P95),
    histogramme de répartition du Lead Time, statut des tâches (bar chart
    horizontal), Throughput (aire).
  - **Table de performance des agents** : tâches, succès %, durée moyenne / P95,
    retries, blocages, échecs (attribution via `events.by`, partielle sur
    l'historique — événements génériques regroupés « non attribué »).
  - **Coûts & tokens** : totaux + coût/tokens par tâche et par agent
    (via `opencode export`, déjà utilisé par le panneau).
- **Backend** : module `metrics.mjs` (agrégations SQL sur `task_registry`) +
  endpoints `GET /api/metrics/{summary,status,throughput,leadtime,agents,costs}` ;
  refactor du calcul d'usage dans `usage.mjs` (réutilisé par `server.mjs`).
- **Chart.js v4.4.3 vendu localement** (`public/vendor/chart.umd.js`) — aucune
  dépendance CDN.
- Critères : `Success = done ET recette approved` ; tâches `done` sans recette
  = « non évaluées ».

### Dépôts impactés

`opencode-observability` (panneau + docs). Aucune migration de schéma requise.

---

## v0.1.0 — 2026-08-30 · Notification centralisée par changements d'état

**Objectif** : les agents et sous-agents n'envoient **plus d'email directement**
et leurs prompts ne contiennent **plus aucune instruction d'email**. À la place,
un daemon central observe les changements d'état du registre PostgreSQL et
signale l'utilisateur avec les données de la base.

### Changements

- **Nouveau composant `opencode-notifier`** (v0.1.0) : daemon de notification
  email, **unique émetteur** de l'écosystème.
  - Observe le registre `task_registry` : `events`, `decisions`, `deployments`,
    `plan_incidents`, `plan_inconsistencies`, `audit_notifications`.
  - Mécanisme **hybride** : triggers PostgreSQL `LISTEN/NOTIFY` (réactivité) +
    **polling de rattrapage/secours** toutes les `NOTIFIER_POLL_MS` ms.
  - High-water marks persistés (`notifier_state`) + déduplication (`notifier_dedup`)
    → un email par changement d'état, reprise propre après redémarrage.
  - Baseline au premier démarrage (aucune notification rétroactive).
  - Envoi via l'unique primitives SMTP `scripts/send-mail.mjs` ; pièces jointes
    (plans, audits, rapports) issues de la table `artifacts`.
  - Mode `NOTIFIER_DRY_RUN=1` pour valider sans envoyer.
- **Retrait des envois d'email directs** :
  - MCP `task-orchestrator` : outil `notify` supprimé (et `sendMail`).
  - MCP `plan-manager` : outil `notify` supprimé ; incidents/incohérences
    persistés sans email.
  - MCP `audit-manager` : outil `notify` supprimé ; incidents/incohérences
    **reflétés** dans la table `audit_notifications` (observable par le notifier).
  - Script `record-permission.mjs` : la décision `permission` reste tracée, plus
    d'email.
- **Prompts agents** (`opencode-agents`) : suppression de toutes les instructions
  d'email (sections « Script email », « Notification d'intervention », contrats
  de fin avec email) dans `build-notify`, `atomic-plan`, `orchestrator`,
  `hexagonal-architecture-auditor`, `clean-arch-detector-react`. Les agents
  **écrivent des états** (`task_event`, `artifact_add`, `decision_request`,
  `deployment_record`, incidents/incohérences) qui déclenchent les notifications.
- **Skills** : `task-execution`, `plan-manager`, `audit-manager` mis à jour
  (aucune mention d'email ; rôle du notifier documenté).
- **Docs panneau** : `02-composants`, `03-workflow`, `04-reproduction`, `README`
  mis à jour ; ajout de `06-versioning.md` et de ce `CHANGELOG.md`.

### Règles de notification (périmètre « action humaine + états finaux »)

| État | Notification |
|---|---|
| Décision `awaiting` / résolue / expirée | Décision requise / approuvée·rejetée / expirée |
| Tâche `blocked`/`failed`/`aborted`/`crashed`/`done` | Tâche <statut> / terminée |
| `AUDIT_COMPLETED` | Audit terminé (+ rapport) |
| Déploiement `deploy_failed` / `post_deploy_verified` | Échec / vérifié |
| Incident/incohérence de plan ou d'audit (création/résolution) | Incident/Incohérence |

Pas de notification pour : `CHECKPOINT`, transitions mineures de planning,
heartbeats.

### Dépôts impactés

`opencode-notifier` (nouveau) · `opencode-agents` · `opencode-mcp-task-orchestrator`
· `opencode-mcp-plan-manager` · `opencode-mcp-audit-manager` · `opencode-scripts`
· `opencode-plugins` · `opencode-skills` · `opencode-observability` (docs).
