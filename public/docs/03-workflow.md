# 03 — Workflow de bout en bout / End-to-end workflow

> Le narratif du flux : comment une demande devient une tâche, puis des plans, puis
> du code déployé et validé. C'est la section à lire pour comprendre le workflow.

---

## 1. Cycle de vie d'une tâche

```
queued → started → planning → awaiting_validation → planned → in_progress → done
                                                                          │
                                                              [cadrage]   ▼
                                          cadrage technique (v0.7) : pending → in_progress → done
                                          (session dédiée agent-cadrage → éléments de cadrage → « Terminer le cadrage »)
                                          └─→ nouvelles tâches (rework/bug/improvement/feature) liées à la tâche
```

| État | Signification | Qui le pose |
|---|---|---|
| `queued` | Tâche créée, en attente | panneau / orchestrator |
| `started` | Session lancée | panneau (bouton « Lancer ») |
| `planning` | Planner en cours | orchestrator (délègue à atomic-plan) |
| `awaiting_validation` | Plans à valider | orchestrator |
| `planned` | Plans validés | `decision_resolve` (agrégation auto) |
| `in_progress` | Plans en exécution | orchestrator |
| `rework` | Reprise après rejet (review) — **non terminal** depuis v0.2.1 | panneau/orchestrator |
| `done` | Tous les plans terminés | orchestrator |
| cadrage `pending/in_progress/done` | Cadrage technique (v0.7, ex-« recette » côté exécuteur, ADR-001) : pas fait → en cours (session `agent-cadrage`) → fait | auto à `done` + humain |

**Attente humaine visible** (v0.4.1) : une tâche avec une décision `validation`/
`review` en attente affiche un badge « ⏳ attente humaine » (le cadrage est suivi
via sa propre table, pas une décision — v0.7.5).

## 1bis. Cadrage technique (exécuteur) = phase distincte (v0.7.0)

> **ADR-001** — séparation de premier niveau : le **Cadrage technique** est un
> outil de l'**exécuteur** (analyse du code réel + contexte → liste de tâches
> techniques). Il est **distinct** de la page **« Recette »** de
> l'**évaluateur** (vérification produit, §1bis.ter). Côté UI, routes et prompt,
> l'exécuteur voit « Cadrage technique » et ses « **éléments de cadrage** ». Les
> tables (`cadrages`, `cadrage_*`) et l'historique sont **conservés** (renommage
> des surfaces, jamais des données).

- Le cadrage technique est un **objet de PROJET** (v0.8.0) : titre propre, session
  dédiée, couvrant **0..N tâches** (ou aucune — cadrage exploratoire). Créé
  depuis l'onglet **Cadrage technique** (exécuteur) / **Cadrages** (autres rôles)
  (projet + titre + tâches couvertes optionnelles).
- **Contexte du cadrage (sélecteurs multi-lignes, toutes cochées par défaut)** :
  **ADR** (`adrIds` → bloc « ADR de référence »), **Fonctionnalités** (`featureIds`
  → bloc « Fonctionnalités de référence ») et **Règles métier** (`ruleIds` → bloc
  « Règles métier de référence »). Les sélections sont **rattachées au cadrage**
  (`cadrage_adr` / `cadrage_fonctionnalites` / `cadrage_regles`) et **injectées
  dans le prompt** de la session `agent-cadrage`.
- Le panneau propose **« Session du cadrage »** : lance la session dédiée
  `agent-cadrage` (contexte réel : titre, projet, tâches couvertes, commits,
  artefacts, événements, plans). L'agent **enregistre les éléments de cadrage** avec
  **classification** (`rework` / `bug` / `improvement` / `feature`), **titre
  court**, **critère d'acceptation** et **scope** suggéré.
- **« Terminer le cadrage »** → synthèse consolidée → **confirmation** → création
  de **nouvelles tâches** via `task_register` (typées, `cadrage_class`,
  **liées** à la tâche initiale via `task_links`, scope transmis) → cadrage
  `done`. La tâche initiale reste `done` et **intacte**.
- **Modification / suppression des éléments à la clôture** (v0.9.59) : dans la
  modale « Terminer le cadrage », chaque élément est **éditable** (classification,
  titre, contenu, critère d'acceptation, scope, ordre d'exécution, vigilance) et
  **supprimable** avant confirmation ; les corrections sont persistées
  (`cadrage_item_update` / `cadrage_item_delete`). Un élément en cours d'édition
  doit être enregistré ou annulé avant de terminer.
- **Clôture sans génération de tâches** (v0.9.59) : le bouton **« Terminer sans
  créer de tâches »** clôt le cadrage (`done`) **sans** `task_register` ; les
  éléments relevés restent consultables dans le détail du cadrage. Utile pour
  un cadrage exploratoire ou des constats déjà traités ailleurs.
- **Création de tâche** : on peut lier des **tâches associées** (v0.6.0) avec une
  **nature de liaison** (« c'est là que le package a été créé ») — exploitées par
  atomic-plan (commits, plans, docs).

### Gouvernance ADR en cadrage technique (points de vigilance bloquants)

Un cadrage technique peut révéler qu'une **décision d'architecture est manquante** ou
**contredite**. Le framework en fait un **point de vigilance global** qui **bloque
la terminaison** du cadrage — jamais de validation silencieuse :

- **Signalement** : `adr_report_missing` (ADR manquante pour une entité
  réellement discutée) ou `adr_report_conflict` (conflit code ↔ ADR, `cadrageId`
  fourni) → point persisté dans `adr_vigilances` (`type` = `missing`/`conflict`,
  `status` = `open`, `reason` explicite).
- **Blocage** : `cadrage_confirm` est **REFUSÉ** tant qu'un point est `open`, avec
  la **raison explicite** (« ADR manquant pour [entité] » / « Conflit d'ADR :
  [ancienne] vs [nouvelle] »). Le panneau effectue le **même pré-check** avant
  toute création de tâches et **bloque** le bouton « Terminer le cadrage ».
- **Levée tracée (2 canaux)** : `adr_vigilance_resolve` (raison **obligatoire**,
  `resolutionKind` = `adr_created`/`adr_deprecated`/`decision`/`manual`), ou la
  résolution de la **décision humaine** `kind='conflict'` (qui clôt le conflit).
- **Historique append-only filtrable** : `adr_vigilance_list` /
  `GET /api/adr-vigilances` (projet, cadrage, type, statut, dates).

Voir [`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §3.

## 1bis.ter. Recette de l'évaluateur produit = phase distincte (v0.9.42)

> **ADR-001/002** — la **Recette de l'évaluateur** est un **objet de premier
> niveau distinct** du Cadrage technique. Identifiant de code **`recettes`**
> (libellé UI **« Recette »**) : elle ne réutilise **pas** l'entité/route
> `cadrages` (ancre du Cadrage technique exécuteur). Tables dédiées
> `recettes` / `recette_fonctionnalites` / `recette_regles` /
> `recette_items`.

- **Rôle** : l'**évaluateur** vérifie la **cohérence produit**, l'**expérience
  réelle des utilisateurs**, le **design** et la **performance** — il ne se soucie
  pas de *comment* c'est développé.
- **Contenu** : l'évaluateur **décrit le parcours évalué** (`description`),
  **rattache 1..N fonctionnalités** + **1..N règles métier**, **enregistre des
  éléments** — **recommandations** ou **problèmes** (catégorie, **sévérité**
  `low|medium|high|critical`, statut de suivi `open|treated|dismissed`) — et
  **joint des pièces** : **lien**, **document**, **photo**, **vidéo**.
- **Verdicts au niveau des fonctionnalités** : le verdict (`conforme` /
  `non_conforme` / `a_ameliorer`) est **porté par le lien**
  `recette_fonctionnalites` (il n'altère pas la table `fonctionnalites`).
- **Distinction verdict ↔ statut de développement** : le **verdict d'évaluation**
  (conformité **produit**) et le **statut de développement**
  (`complet`/`partiel`/`non_demarre`/`incoherent`, **analyse du code**, colonne
  `fonctionnalites.dev_status`) sont **DEUX AXES DISTINCTS** — jamais fusionnés.
  `feature_get` expose les verdicts en **lecture seule** (`recetteVerdicts`) à
  côté du statut de développement ; voir
  [`15-statuts-fonctionnalites-regles.md`](15-statuts-fonctionnalites-regles.md).
- **Cycle de vie** : 3 statuts — `pending` → `in_progress` → `done`
  (`recette_confirm`). **AUCUNE conversion directe en tâches** : les éléments
  restent attachés au cadrage.
- **Visibilité** (ADR-002) : l'évaluateur ne voit que **SES** recettes (filtre
  `recetteOwnerScope` sur `recettes.created_by`) ; **admin/superviseur** voient
  **toutes** les recettes (superviseur en **lecture seule**) ; l'**exécuteur** les
  voit en **lecture seule** (`/api/recettes` en GET).
- **Routes** : `/api/recettes*` (liste, création, détail, `items`, `verdicts`,
  `documents`, `finish`, `file`) — **additives**, sans collision avec
  `/api/cadrages*`.
- **MCP** : famille `recette_*` (voir `05-reference.md` §1bis).

### Workflow admin → exécuteur des éléments de recette (v0.9.66)

> **ADR-001/002** — les éléments de recette de l'évaluateur (recommandations /
> problèmes) **ne sont plus convertis automatiquement en tâches**. L'**admin**
> marque chaque élément « **à traiter** » (décision tracée, **distincte** du statut
> de suivi) ; l'**exécuteur** n'accède **qu'aux éléments « à traiter »**, qu'il
> **reprend en contexte** d'un **cadrage technique** — c'est le cadrage qui produit
> les tâches techniques.

- **Décision admin** : `POST /api/recettes/:id/items/:itemId/decision`
  (**ADMIN-ONLY**, 403 sinon) → tool `recette_item_decision`
  (`pending` | `a_traiter` | `non_retenu`), `decided_at`/`decided_by` tracés.
  L'évaluateur **informe** (il ne décide pas) ; le **statut de suivi**
  (`open`/`treated`/`dismissed`) reste **distinct** de la **décision**.
- **Exécuteur (lecture seule, ADR-002)** : la page « Recette » lui est accessible
  en **lecture seule** (onglet `recettes`) ; `GET /api/recettes/:id` **filtre
  côté serveur** les éléments pour ne renvoyer que `decision='a_traiter'`. La liste
  `GET /api/recettes` expose `treatable_count` (compteur « à traiter ») et
  `GET /api/recettes/treatable?project=` liste les éléments à traiter (entrée de
  sélection d'un cadrage).
- **Reprise en cadrage technique** : `POST /api/cadrages/:id/recette-items` rattache un élément « à traiter »
  au cadrage ; `DELETE …/recette-items/:itemId` le détache. La **garde
  « a_traiter »** est portée par le registre (un élément non « à traiter » est
  refusé). Le cadrage expose ses éléments repris (`recetteItems` sur
  `GET /api/cadrages/:id`) et le traçage « **repris par le cadrage X** »
  (`reprisPar` par élément dans le détail de l'évaluation).
- **Pièces par élément** : `POST /api/recettes/:id/documents` accepte `itemId`
  (pièce rattachée à un **élément** précis — `meta.itemId`), sans table nouvelle.
- **Prompt de cadrage** : `buildCadragePrompt` injecte un bloc « **Éléments de
  recette évaluateur repris en contexte** » (itemId, catégorie, sévérité, contenu,
  pièces) + la consigne que c'est **le cadrage** qui définit les tâches techniques.
- **MCP** : `recette_item_decision`, `recette_items_treatable`,
  `cadrage_recette_item_link`/`_unlink`/`_list` (voir `05-reference.md` §1bis).

### Périmètre E2E de l'évaluateur (v0.9.67)

> **ADR-003** — depuis sa **recette** (`recettes`), l'évaluateur peut
> **exécuter les tests E2E du projet**, **lire les preuves** rattachées aux
> exécutions (détails, **vidéos**, rapport texte) et — **unique écriture
> permise** — **marquer un test « incohérent »** avec des **remarques
> obligatoires** (signal « comportement réel ≠ scénario / règle »). Il ne
> **crée**, ne **modifie** ni n'**obsolète** un test, et n'accède à **aucun
> réglage technique**.

- **Exécution** : `POST /api/e2e-tests/:id/run` (déjà autorisé) ; l'évaluateur
  lance le test **tel qu'enregistré** (dépôt, config Playwright, spec, paramètres
  et variables du projet résolus côté serveur) — **modale minimale**, sans saisie
  de `repoDir`, config, `specPattern`, `pwArgs`, origine, `taskId`, vars ni secrets.
- **Lecture** : `GET /api/e2e-tests`, `GET /api/e2e-tests/:id`,
  `GET /api/e2e/file` (rapport/vidéo), `GET /api/e2e/jobs/:jobId`. Le **détail**
  renvoyé à l'évaluateur est **épuré** : ni `params`, ni `projectVars` /
  `projectSecrets`, ni `docs` (ADR), ni `linkedTasks` / `requiredOpenTasks`.
- **Unique écriture** : `POST /api/e2e-tests/:id/incoherent` `{ remarks }` →
  statut **`INCOHERENT`** + `incoherent_remarks` / `incoherent_by` /
  `incoherent_at` persistés (MCP `e2e_test_incoherent`). Les remarques sont
  **obligatoires** ; le spec et la formalisation du test ne sont **jamais**
  modifiés.
- **Hors périmètre (403)** : `e2e_test_register` / `update` / `param_set` /
  `session` / `obsolete` (création/modification/obsolescence) et les **réglages
  techniques** (`/api/e2e-vars`, `/api/e2e-secrets`) — retirés de l'allowlist
  évaluateur. Les sections techniques du détail sont masquées côté UI
  (`[data-e2e-tech]`, défense en profondeur).
- **Statut `INCOHERENT`** : valeur supplémentaire de `e2e_tests.status`
  (`ACTIVE | OBSOLETE | QUARANTINE | DRAFT | INCOHERENT`), exposée par
  `e2e_test_get` / `e2e_list` (filtre `status`). Un test **re-synchronisé**
  (`upsertE2ETest` / `reactivateE2ETest`) repasse `ACTIVE` mais **conserve** ses
  remarques (trace historique).

### Tests standard de l'évaluateur (parcours + erreurs console/réseau + stress routes API) (v0.9.68)

> **ADR-003** — les **TESTS STANDARD** sont des outils de l'évaluateur **distincts
> des tests E2E Playwright** : parcours de pages avec informations réseau ET
> capture des erreurs console/réseau, métriques Core Web Vitals, et **stress test
> des routes d'API**. Ils produisent des **pièces `performance`** rattachables
> au cadrage (et à un élément via `itemId`), à côté des recommandations/problèmes.

- **Outil** : `recette_perf_run` (MCP) / `POST /api/recettes/:id/perf-run`
  (panneau, **asynchrone** → job suivi via `GET …/perf-jobs/:jobId`). La page
  Recette expose la section « **Tests standard (parcours + stress routes API)** ».
- **Parcours de pages** : `pages` (URLs supplémentaires, ≤ 10 ; défaut `url`) —
  informations réseau (durées/requêtes/types/tailles, **compression**, timings
  TTFB/DCL/load) + **erreurs console** (warnings, exceptions JS) et **réseau**
  (4xx/5xx, DNS, timeouts, requêtes échouées), catégorisées.
- **Métriques** : Core Web Vitals **LCP < 2,5 s / INP < 200 ms / CLS < 0,1**
  (+ ratings good/needs-improvement/poor), long tasks > 50 ms, temps d'exécution
  JS, réseau par type (documents/JS/CSS/images/fonts/XHR), poids total.
- **Stress des routes d'API** : `routes` (relatives à `baseUrl` ou absolues,
  ≤ 20 ; défaut `url`) — accès **parallèles bornés** par route : débit req/s,
  latence moy/p50/p95/p99, taux d'erreurs + **agrégat global**.
- **Bornes** (anti-dégradation préprod) : pages ≤ 10, routes ≤ 20,
  concurrency ≤ 10, requests ≤ 200 (budget réparti sur les routes).
- **Playwright** : résolu depuis `repoDir` (checkout applicatif) pour les Core
  Web Vitals et la capture console ; sans Playwright, mesure réseau/stress via
  `fetch` (vitals/console indisponibles, avertissement explicite).
- **Preuves** : le rapport (résumé + erreurs console/réseau + stress par route)
  est enregistré comme pièce `recette_doc` `nature='performance'` (famille
  `recettes*`, **aucune table neuve**) ; l'UI affiche le détail dépliable.
- **Distinct des tests E2E** : aucune fusion — les tests E2E restent les entités
  Playwright (§1bis.ter « Périmètre E2E de l'évaluateur »).

## 1ter. Sprints, émergence et cardinalités (ADR-001)

### Cycle de vie d'un sprint

Un **sprint** est l'unité de temps d'un projet (table `sprints`). Cycle :
`open → close` (reprise `close → open`).

- **Création** (`sprint_start`) : titre + **durée paramétrable** (jours, synchronisée
  avec l'échéance `end_date`) + `autoClose` (défaut vrai) + pièces client rattachées
  à la création (non émergentes).
- **Clôture** : **manuelle** (`sprint_close`, `close_reason='manuel'`) ou
  **automatique à l'échéance** (`autoClose`, `close_reason='auto_echeance'`, balayage
  `autoCloseExpiredSprints`). La clôture est l'action officielle qui **bascule la
  garde d'émergence**.
- **Reprise** (`sprint_reopen`) : repasse `open`, prolonge l'échéance ; elle
  **suspend** la garde d'émergence (les éléments suivants ne sont plus émergents).
- **Rapport** (`sprint_report`) : agrégation du registre (fonctionnalités/règles
  implémentées ventilées écosystème / hors écosystème, tâches, pièces, cadrages).
- Un **sprint par défaut** (`is_default`, au plus 1 par projet) porte les « anciens
  sprints » (migration).

### Émergence (tracée, JAMAIS rétroactive)

Un élément (tâche, fonctionnalité, règle, pièce) **créé hors sprint** (`hors_sprint`)
ou **après la clôture du dernier sprint** (`apres_cloture`) est marqué
**émergent** (`emergent=1` + `emergent_origin`). L'émergence est **tracée** mais
**jamais rétroactive** : la migration des éléments existants vers le sprint par
défaut (`sprint_migrate_elements`) **n'écrit aucun marqueur d'émergence** (pas de
faux émergent). Un sprint rouvert **suspend** la règle.

### Cardinalités heuristiques (NON bloquantes)

Le framework **signale** (sans jamais bloquer) les manques de cardinalité d'une
entité : tâche/cadrage **sans ADR / sans fonctionnalité / sans sprint**, ADR **sans
fonctionnalité**, sprint **sans fonctionnalité / sans règle**, éléments **émergents**.

- **Agrégat** : `cardinality_report({ projectId })` (+ `GET /api/cardinality`) ;
  restitué en **cartes cliquables** dans la Vue d'ensemble du panneau.
- **Signaux append-only** (`cardinality_signals`) : `cardinality_signals_list`
  (historique filtrable) et `cardinality_signal_resolve` — la clôture exige une
  **raison tracée** (jamais de clôture silencieuse) ; l'index partiel unique garantit
  **un seul signal `open` par entité**. Un signal `open` devenu obsolète est marqué
  `stale`.
- **Règle d'or** : ce sont des **signaux à traiter** (en cadrage / par une tâche
  dédiée), **jamais** des blocages.

### Lien ADR d'une tâche — proposé → validé

Le lien entre une tâche et une ADR (`task_adr`) suit un workflow **à deux temps** :

- `task_adr_propose({ taskId, adrId, reason })` — action **agent** → `status='propose'`
  (**NON effectif** ; idempotent, ne rétrograde jamais un lien validé).
- `task_adr_validate({ taskId, adrId })` — action **HUMAINE** (en cadrage) →
  `status='valide'` (**EFFECTIF**).
- `task_adr_list` expose l'état (`effective`), `task_adr_unlink` détache.
- **L'agent ne valide JAMAIS lui-même** ; il **propose** (`adrIds` à la création de
  la tâche) et signale un manque (`adr_report_missing`) plutôt que de créer une ADR
  d'office.

### Sessions dédiées : sprint & migration

- **Session de sprint** (`sprint_session_set`, bouton « Session de sprint ») : session
  IA `agent-sprint` rattachée au sprint (pièces → discussion → fonctionnalités/règles).
  Elle **ne touche pas** au statut `open`/`close` (garde d'émergence inchangée).
- **Session de migration** (`migration_start` / `migration_session_set`, bouton
  « Session de migration ») : session IA dédiée qui **convertit les ADR monolithiques
  en ADR atomiques** (`adr_convert`, validation utilisateur avant écriture) et
  **rattache les éléments hérités** à l'ancien sprint **sans faux émergent**.
  Idempotente : **une migration par projet** (`migrations.project` unique), ancrée sur
  le **sprint par défaut**. Cycle : `open → in_progress → done`/`aborted`
  (`migration_finish`).

## 2. Cycle de vie d'un plan (sous-tâche)

Chaque plan suit **son propre cycle**, en parallèle des autres :

```
planned → in_progress → validating → review → approved/rejected
        → merge_pending → merged → deploy_pending → deploying → deployed
        → post_deploy_verified → done
```

- **Approbation indépendante par plan** : un plan peut être `approved` pendant qu'un
  autre est `rejected → rework`.
- `decision_resolve` (review) transitionne le **plan** (`review → approved/rejected`),
  pas la tâche.
- La tâche reste `in_progress` jusqu'à ce que **tous** les plans soient `done`.

## 3. Les décisions humaines

| kind | Quand | Résolution → effet |
|---|---|---|
| `validation` | Après la planification | acceptée → tâche `planned` ; rejetée → tâche `aborted` (agrégation auto) |
| `review` | Avant merge (par plan) | approuvée/rejetée → **plan** `approved/rejected` |
| `cadrage` | Après `done` | approuvée/rejetée → colonne `cadrage_status` (sans toucher l'exécution) |
| `permission` | Demande de permission opencode | tracée (sans transition) |

Chaque décision a : `kind`, `detail`, `planId` (si lié à un plan), `status`
(`awaiting` → `approved`/`rejected`), `resolution` (remarques).

## 4. Notifications (v0.1.0 — centralisées, sans email des agents)

Depuis la **v0.1.0**, les agents et MCP **n'envoient plus d'email**. Le daemon
`opencode-notifier` observe les changements d'état du registre PostgreSQL et
signale l'utilisateur avec les données de la base :

| État observé | Notification |
|---|---|
| Décision humaine `awaiting` (validation/review/permission/cadrage) | « Décision requise » (pièce jointe : plan si validation) |
| Décision résolue (`approved`/`rejected`) | « Décision approuvée/rejetée » |
| Décision expirée | « Décision expirée » (escalade) |
| Tâche `blocked`/`failed`/`aborted`/`crashed`, événement `BLOCKED` | « Tâche <statut> » |
| Tâche `done`, événement `TASK_COMPLETED` | « Tâche terminée » (rapport en pièce jointe via `artifacts`) |
| Audit terminé (`AUDIT_COMPLETED`) | « Audit terminé » (rapport en pièce jointe via `artifacts`) |
| Déploiement `deploy_failed` | « Déploiement échec » (lien pipeline) |
| Déploiement `post_deploy_verified` | « Déploiement vérifié » |
| Incident/incohérence de plan (`plan_incidents`, `plan_inconsistencies`) | « Incident/Incohérence » (+ résolution) |
| Incident/incohérence d'audit (miroir `audit_notifications`) | « Incident/Incohérence d'audit » (+ résolution) |

Mécanisme : **hybride** — triggers PostgreSQL `LISTEN/NOTIFY` (réactivité) +
polling de rattrapage (`notifier_state` = high-water marks, reprise propre).
Envoi via l'unique primitives SMTP `scripts/send-mail.mjs`. Aucun agent n'appelle
plus ce script ; l'outil MCP `notify` a été retiré des serveurs.

## 4bis. Branche principale & déploiement (v0.5.0)

- Chaque projet définit une **branche principale** (`main_branch`), **obligatoire
  depuis le panneau** (Projets → Modifier). Sans elle, **aucun déploiement n'est
  autorisé** (l'orchestrateur passe la tâche en `blocked`).
- **Avant de pousser** vers git, on **pull depuis la branche principale**
  (`git pull --rebase origin <mainBranch>`) pour intégrer les derniers
  changements (consigne orchestrateur §7-8/§12 + exécuteur build-notify).
- **Décisions depuis le panneau** (v0.4.1) : approuver/rejeter une décision
  réveille la session orchestrateur (`injectMessage`) — pas besoin de retaper le
  verdict.
- **Création de projet** (v0.4.1) : le répertoire est créé automatiquement dans
  le workspace Coder (`mkdir` + `git init`).

## 5. Séquence type (exemple à 2 plans)

```
humain ──créer tâche──▶ panneau ──Lancer──▶ started
orchestrator ──▶ planning ──délègue──▶ atomic-plan (2 plans)
orchestrator ──▶ awaiting_validation ──decision_request(validation) x2
humain ──valide les 2 plans──▶ planned (auto)
orchestrator ──▶ in_progress ──délègue──▶ build-notify (2 sous-tâches parallèles)
build-notify ──▶ (worktree, code, commit) ──▶ validating → review (par plan)
humain ──review par plan──▶ plan approved/rejected (indépendant)
orchestrator ──▶ merge_pending → merged → deploy… → done (par plan)
orchestrator ──▶ task done (tous les plans done)
humain ──Valider le cadrage──▶ cadrage approved/rejected
```

## 6. Traçabilité fine : commits + sessions

- **Commits par sous-tâche** : à la fin de chaque plan, `build-notify` publie la trace
  de ses commits (`plan_commit_add` : sha, branche, message, auteur, fichiers + diff).
  Le panneau affiche le nombre de commits par plan et leur diff (bouton « commits »).
  La trace est append-only (les commits d'un rework s'ajoutent, rien n'est effacé).
- **Sessions par tâche** : chaque session opencode lancée (`launch`/`rework`/`relaunch`)
  est liée à la tâche (`task_link_session`). La consommation (tokens + coût) est
  calculée via `opencode export <sessionId>` et affichée dans l'onglet Tâches.

---

## English version

**1. Task lifecycle** — `queued → started → planning → awaiting_validation → planned →
in_progress → done`, then acceptance (`cadrage`: `pending → approved/rejected`).
Who sets each state: `queued` (panel/orchestrator), `started` (panel "Launch"),
`planning` (orchestrator delegates to atomic-plan), `awaiting_validation`
(orchestrator), `planned` (automatic via `decision_resolve` aggregation),
`in_progress` (orchestrator), `done` (orchestrator when all plans are done), cadrage
(human via "Validate acceptance").

**2. Plan (sub-task) lifecycle** — each plan follows its own cycle, in parallel:
`planned → in_progress → validating → review → approved/rejected → merge_pending →
merged → deploy_pending → deploying → deployed → post_deploy_verified → done`.
Approval is **independent per plan** (one can be `approved` while another is
`rejected → rework`). `decision_resolve` (review) transitions the **plan**, not the
task; the task stays `in_progress` until all plans are `done`.

**3. Human decisions** — `validation` (after planning → task `planned`/`aborted`),
`review` (before merge → plan `approved`/`rejected`), `cadrage` (after `done` →
`cadrage_status` column), `permission` (opencode permission, traced only). Each
decision has `kind`, `detail`, `planId`, `status`, `resolution`.

**4. Notifications (v0.1.0)** — centralized: the `opencode-notifier` daemon
watches registry state changes (events, decisions, deployments, incidents) and
emails the user with database data. Agents never send emails; the MCP `notify`
tool was removed.

**4bis. ADR governance in acceptance** — a missing/conflicting architecture
decision detected during a cadrage/test becomes an **open global vigilance**
(`adr_vigilances`, `type` = `missing`/`conflict`) that **blocks** `cadrage_confirm`
(registry guard + panel pre-check) with an explicit reason. It is lifted in a
**traced** way (mandatory `resolution` via `adr_vigilance_resolve`, or by
resolving the human `conflict` decision). History is append-only and filterable.

**4ter. Sprints, emergence, cardinalities (ADR-001)** — a **sprint** (the project's
time unit) goes `open → close`: creation sets a **configurable duration** and
`autoClose` (closure at the deadline); **reopen** resumes it and **suspends** the
emergence guard. **Emergence** is traced but **never retroactive**
(`sprint_migrate_elements` writes no emergence marker → no false emergence).
**Heuristic cardinalities** are **non-blocking**: `cardinality_report` (+ clickable
Overview cards) and append-only `cardinality_signals` (closing requires a **traced
reason**; a partial unique index guarantees one open signal per entity). The **task
ADR link** follows **proposed → validated**: `task_adr_propose` (agent, **not
effective**) → `task_adr_validate` (human, **effective**) — agents never
self-validate. **Dedicated sessions**: sprint session (`agent-sprint`; does not touch
`open`/`close`) and migration session (converts monolithic ADRs to atomic ones +
attaches legacy elements without false emergence; one per project). Cadrage creation
injects **ADR + Features + Rules** context into the `agent-cadrage` prompt.

**5. Example sequence (2 plans)** — human creates task → panel launches (`started`) →
orchestrator plans (`planning`) → atomic-plan produces 2 plans → `awaiting_validation`
→ human validates both → `planned` (auto) → `in_progress` → build-notify executes 2
parallel sub-tasks → `validating` → `review` → human approves/rejects each plan
(independently) → merge/deploy per plan → task `done` → human validates acceptance.

**6. Fine-grained traceability: commits + sessions** — at the end of each plan,
`build-notify` publishes its commit trace (`plan_commit_add`: sha, branch, message,
author, files + diff); the panel shows the commit count per plan and their diff
("commits" button); the trace is append-only (rework commits are added, never erased).
Each opencode session (`launch`/`rework`/`relaunch`) is linked to the task
(`task_link_session`); consumption (tokens + cost) is computed via
`opencode export <sessionId>` and shown in the Tasks tab.
