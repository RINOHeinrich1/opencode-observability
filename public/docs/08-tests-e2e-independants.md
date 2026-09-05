# 08 — Cadrage : tests E2E en entités de premier niveau (indépendants des tâches)

> **Statut : CADRAGE — aucune implémentation** (document de référence pour le futur
> plan atomic-plan). Dernière mise à jour : 2026-09-05.
>
> Périmètre documentaire : écosystème d'orchestration (opencode-observability /
> opencode-mcp-task-orchestrator / opencode-agents / opencode-scripts) + repos
> applicatifs cibles (Playwright). Ce document **remplace/étend** le modèle
> « tests adossés aux tâches » du cadrage `07-tests-e2e.md`.

---

## 1. Objectif

Les tests E2E deviennent des **entités de premier niveau du registre**,
**indépendantes des tâches** : ils couvrent des **comportements** (parfois
transverses à plusieurs projets) et vivent par eux-mêmes, avec leur propre
interface de gestion, leur propre historique d'exécution et leurs propres
paramètres.

> Aujourd'hui (07-tests-e2e), un test n'existe que par son rattachement à une
> tâche (`task_e2e`), ses exécutions sont rattachées à la tâche (`task_id` sur
> `e2e_executions`) et sa création est couplée au traitement d'une tâche. Cible :
> le test est une entité du registre qui **peut** être associée à zéro, une ou
> plusieurs tâches — sans que son existence ni ses exécutions en dépendent.

### Décisions actées (confirmation utilisateur 05/09)

| # | Sujet | Décision |
|---|---|---|
| T1 | Rattachement projet | Un test peut toucher **plusieurs projets** (ex. « faire une demande côté frontend madatalk client → la retrouver dans ONIRIA » = 2 projets). Le spec Playwright vit dans **un repo source** (là où est écrit le code de test), l'entité est associée à **N projets** (N:N). |
| T2 | Propriétaire des exécutions | L'exécution appartient **au TEST**. La tâche (ou recette / CI / manuel) devient une **origine optionnelle tracée** (champ `origin` + `task_id` optionnel), jamais obligatoire. |
| T3 | Création d'un test | **Entité enregistrée dès qu'un spec existe** (écrit par une tâche feature **ou** par une session de création dédiée). Pas de création « en aveugle » : l'agent regarde l'existant (create/update/delete/keep). |
| T4 | Session de création | Depuis l'onglet Tests, « créer un test » lance une **session agent opencode** de rédaction du spec ; cette session reçoit les **tâches liées en contexte** (comme `linkedTasks` à la création d'une tâche) pour situer fichiers/conventions. |
| T5 | Paramètres variables | Chaque test déclare des **paramètres** (URL, compte, token…) avec **valeur par défaut**, **surchargeables à chaque exécution**. Les valeurs secrètes (token/mot de passe) restent **hors registre** (refs `e2e.env` / secrets), seuls nom + défaut non sensible vivent dans le registre. |
| T6 | Colonne E2E (table tâches) | Conservée : badge visible **seulement si la tâche a des tests associés** ; le clic **redirige vers l'onglet Tests E2E pré-filtré** sur les tests de cette tâche. |
| T7 | Modale d'actions d'une tâche | La **liste des tests est retirée** de la modale d'actions ; remplacée par un lien « Voir les tests E2E » (→ onglet filtré). |
| T8 | Backfill | Migrer vers le nouveau modèle : entités `e2e_tests`/exécutions déjà en registre + runs de recette récents (T-…9xkf) + runs CI orphelins de l'inbox. (Hors périmètre : scan des specs legacy non enregistrés des repos.) |
| T9 | Gate à la clôture (tâche) | **Gate DOUX** : à la clôture d'une tâche ayant des tests liés non `PASSED` (ou jamais exécutés), l'orchestrateur pose une **décision humaine** (« tests en échec/non exécutés, clore quand même ? ») au lieu de clore en silence. Aucun blocage automatique (pas de gate dur). |
| T10 | Synchronisation registre ↔ repo | **Oui — synchronisation AUTOMATIQUE** du registre `e2e_tests` : le registre est un **reflet du repo**. Un spec créé/modifié/supprimé dans un repo applicatif met à jour le registre (création, `OBSOLETE` si disparu) — via scan/import à chaque déploiement (mécanique à préciser au plan : étape CI du repo ou script collecteur). |
| T11 | Exécution multi-projets | **Une SEULE exécution** `e2e_executions` couvre le comportement transverse (ex. mada-talk → ONIRIA) : les paramètres (baseURL par projet/cible) sont portés par le même run via `param_values`. Pas de sous-exécutions par projet. |
| T12 | Workflow E2E ONIRIA | **Hors périmètre de ce chantier** (inexistant aujourd'hui — ignoré, ne pas le créer ici). |

---

## 2. Concepts clés

Terme | Définition
---|---
**Test E2E** | Entité de premier niveau décrivant un **comportement** vérifié par un scénario Playwright (1 enregistrement par `test()`). Peut couvrir plusieurs projets.
**Repo source** | Le dépôt applicatif où vit le spec file Playwright (le code du test).
**Projets couverts** | Les projets dont le comportement est vérifié (N:N) — ex. `mada-talk` + `oniria`.
**Paramètre de test** | Variable déclarée (nom, valeur par défaut non sensible) surchargeable à l'exécution.
**Exécution** | Passage du test sur une cible déployée (préprod/…), avec preuves (rapport texte partagé ; vidéo humaine). Appartient au test ; origine tracée (tâche/recette/CI/manuel).
**Origine** | Traçabilité de ce qui a déclenché l'exécution (`task`+`task_id`, `recette`, `ci`, `manual`, `session`).

---

## 3. Modèle de données (proposition)

### 3.1 Tests — entité de premier niveau

```
e2e_tests
  id               TEXT PK           -- E2E-<slug>-<hash> (stable, déterministe)
  repo_project     TEXT NOT NULL     -- projet du REPO SOURCE (où vit le spec)
  spec_file        TEXT NOT NULL     -- chemin du spec (ex. tests/playwright/x.spec.ts)
  scenario         TEXT NOT NULL     -- titre du test() (1 enregistrement par test)
  title            TEXT              -- titre court (behavior)
  description      TEXT              -- comportement couvert (optionnel)
  status           TEXT              -- ACTIVE | OBSOLETE | QUARANTINE | DRAFT
  version          INTEGER
  meta             JSONB             -- tags, owners, liens éventuels
  first_seen_at / updated_at
  CONSTRAINT uq (repo_project, spec_file, scenario)   -- idempotence du reflet repo
```

- **Le spec vit dans `repo_project`** ; c'est la source de vérité du code.
- Un même comportement multi-projets = **une** entité (le spec qui l'exécute vit dans
  un des repos) associée à N projets.

```
e2e_test_projects                 -- N:N test ↔ projets couverts
  e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE
  project       TEXT NOT NULL     -- projet dont le comportement est vérifié
  PRIMARY KEY (e2e_test_id, project)
```

### 3.2 Paramètres de test (variables)

```
e2e_test_params
  e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE
  name          TEXT NOT NULL     -- ex. baseUrl, compte, token
  kind          TEXT              -- url | string | secret | int | bool
  default_value TEXT              -- valeur par défaut NON sensible
  secret_ref    TEXT              -- si secret : ref vers e2e.env/secrets (jamais la valeur)
  required      BOOLEAN DEFAULT false
  PRIMARY KEY (e2e_test_id, name)
```

- À l'exécution, l'appelant peut **surcharger** une valeur (par ex. une autre cible).
- Résolution finale au run : valeur passée > défaut du test > env/profil projet.
- **Règle** : aucune valeur secrète persistée dans le registre ni dans les docs.

### 3.3 Exécutions — propriété du test

```
e2e_executions
  id                 TEXT PK       -- EXE-<ts>-<rand>
  e2e_test_id        TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE
  origin             TEXT          -- task | recette | ci | manual | session
  task_id            TEXT          -- OPTIONNEL : tâche origine (si origin=task/recette)
  deployment_id      TEXT
  plan_id            TEXT
  env                TEXT          -- description cible (preprod-<branche> / …)
  param_values       JSONB         -- valeurs effectives utilisées au run (noms + défauts/surcharges ; secrets référencés, jamais en clair)
  status             TEXT          -- PENDING | RUNNING | PASSED | FAILED | ERROR | SKIPPED | FLAKY
  duration_ms        INTEGER
  attempts           INTEGER       -- itération de correction (1..3)
  executed_at        TEXT
  report_artifact_id TEXT          -- artefact TEXTE (IA + humain)
  logs_url           TEXT
  video_url          TEXT          -- preuve HUMAINE
  summary            TEXT
  verdict_by         TEXT          -- build-notify | human | agent-recette
  created_at         TEXT NOT NULL
```

### 3.4 Lien tâche ↔ test (conservé, mais pure association)

```
task_e2e                          -- N:N tâche ↔ test (relation typée)
  task_id        TEXT NOT NULL
  e2e_test_id    TEXT NOT NULL
  relation_type  TEXT              -- CREATED | UPDATED | REGRESSION | EXISTING
  reason         TEXT              -- justification (obligatoire, tracée)
  PRIMARY KEY (task_id, e2e_test_id)
```

- Sert uniquement à : colonne/badge E2E d'une tâche + filtre « tests de cette tâche ».
- Un test peut exister sans aucun lien `task_e2e`.

---

## 4. Interface (panneau)

### 4.1 Nouvel onglet « Tests E2E » (entre Tâches et Recettes)

`index.html` : bouton `<button data-tab="e2etests">Tests E2E</button>` + pane
`#pane-e2etests`.

Vue principale (liste) :
- colonnes : titre/comportement, projets couverts (puces), repo source + spec file,
  scénario, statut du test, **dernier statut d'exécution** (badge ✓/✗/…/—), actions.
- filtres : projet, statut, texte libre.
- bouton **« Nouveau test »** → ouvre une modale de création (projets couverts,
  tâches liées, description) → lance la **session de rédaction** (T4).

Détail d'un test (clic sur une ligne) :
- infos (comportement, projets, repo/spec/scenario, statut) ;
- **paramètres** : liste nom/défaut/surcharge, édition ;
- **tâches associées** (task_e2e) avec navigation ;
- **historique des exécutions** du test (panneau dédié) : statut, durée, origine,
  itération, preuves — boutons « Voir le rapport (texte) », « Télécharger »,
  « ▶ Voir la vidéo », « Télécharger la vidéo (1/ZIP) » ;
- bouton **« Lancer une exécution »** : formulaire cible + surcharge des
  paramètres (T5) → `e2e_run` (origine = `manual` ou tâche si liée).

### 4.2 Colonne E2E (table Tâches) — comportement

- Badge E2E affiché **uniquement** si la tâche a des tests associés (`task_e2e`).
- Clic sur le badge → `goToTab('e2etests')` avec **filtre pré-rempli** sur cette
  tâche (query param ex. `?task=T-…`), liste restreinte aux tests liés.

### 4.3 Modale d'actions d'une tâche — retrait de la liste

- La section liste « Tests E2E » est **retirée** de la modale d'actions.
- Remplacée par un lien « Voir les tests E2E associés » → onglet pré-filtré (4.2).

---

## 5. Outils MCP (opencode-mcp-task-orchestrator)

### Création / gestion des tests (entités 1er niveau)

| Outil | Rôle |
|---|---|
| `e2e_test_register` | (étendu) enregistre/réactive un test **indépendamment** de toute tâche : `repoProject`, `specFile`, `scenario`, `title`, `description`, `projects[]` (couverts). Retourne `e2eTestId`. |
| `e2e_test_update` | modifier titre/description/statut/projets/params d'un test. |
| `e2e_test_projects_set` | associer/retirer les projets couverts (N:N). |
| `e2e_test_param_set` / `_unset` | déclarer/retirer un paramètre (nom, kind, défaut non sensible, secret_ref, required). |
| `e2e_test_link_task` / `_unlink_task` | (ex `e2e_test_link`/`unlink`) associer un test à une tâche (relation + raison) sans que le test dépende de la tâche. |
| `e2e_list` | liste des tests (filtres : project, taskId, status). |
| `e2e_get` | détail d'un test : infos, projets, params, tâches liées, dernières exécutions. |

### Exécutions (rattachées au test, origine tracée)

| Outil | Rôle |
|---|---|
| `e2e_execution_record` | début d'exécution : `e2eTestId`, `origin`, `taskId` (optionnel), env, cible. |
| `e2e_execution_update` | verdict + preuves (inchangé, + `verdictBy` peut être `agent-recette`). |
| `e2e_execution_list` | filtrable par `e2eTestId` (historique du test) et/ou `taskId`. |
| `e2e_run` | (adapté) lancer un run **par test** (`e2eTestId` ou spec) sur une cible + surcharge params ; origine tracée (manual/task/recette) ; import auto. Le `project` registre reste utilisé pour résoudre le repo source. |

---

## 6. Flux agents

### 6.1 Enregistrement dès qu'un spec existe

- `atomic-plan` (planification) et `build-notify` (exécution directe) :
  lorsqu'une tâche produit/modifie un spec, **enregistrent l'entité test**
  (`e2e_test_register` avec `repoProject` + `projects[]` couverts) **puis**
  `e2e_test_link_task` pour associer à la tâche traitée. Analyse d'impact
  create/update/delete/keep conservée (jamais en aveugle).
- Le test reste enregistré même si la tâche est annulée/abandonnée.

### 6.2 Session de création dédiée (depuis l'onglet Tests)

- « Nouveau test » → panneau lance une session opencode (`agent-recette`-like ou
  agent de rédaction de specs) avec contexte : `projects[]` couverts + **tâches
  liées** (commits, plans, docs des tâches associées — même mécanique que
  atomic-plan v0.6.0) + référentiel existant pour éviter les doublons.
- L'agent rédige le spec dans le repo source, enregistre l'entité + params,
  associe les projets.

### 6.3 Exécution

- `build-notify` : quand une tâche a des tests liés, exécute **par test**
  (`e2e_run`/CI), verdict depuis le registre, boucle 3 itérations, origine `task`.
- `agent-recette` : vérifie le comportement via `e2e_list`/`e2e_execution_list`,
  peut déclencher `e2e_run` par test (origine `recette`), verdict lu sur le
  **rapport texte uniquement**.
- La vidéo reste une **preuve humaine** (jamais interprétée par l'IA).

### 6.4 Gate doux à la clôture d'une tâche (T9)

Quand l'orchestrateur s'apprête à clore une tâche (`done`) qui a des tests liés :
- tests tous `PASSED` (ou `NA` justifié) → clôture normale ;
- tests en échec / jamais exécutés → l'orchestrateur pose une **décision humaine**
  (`decision_request`, kind `validation`) « tests E2E non passés — clore quand
  même ? » avec le détail (tests, statuts) ; clôture seulement après résolution
  humaine (jamais de blocage automatique).

### 6.5 Synchronisation automatique registre ↔ repo (T10)

À chaque déploiement d'un repo applicatif, un **scan/import** met à jour le
registre pour refléter le repo : création des tests dont le spec existe, passage
`OBSOLETE` des tests dont le spec a disparu, mise à jour titre/chemin si besoin —
sans jamais supprimer l'historique d'exécution. Les entités ainsi créées/raffraîchies
portent leur repo source + projets couverts ; un test **sans** lien tâche est un
test autonome valide (visible dans l'onglet Tests).

---

## 7. Rétrocompatibilité & migration

- `07-tests-e2e.md` : marquer comme **remplacé/étendu** par le présent cadrage
  pour la partie « modèle de données adossé aux tâches » ; les règles de preuve
  (texte IA / vidéo humain) et le cycle FAIL/3 itérations restent valides.
- `task_e2e` : sémantique conservée (association pure) ; la colonne existante et
  le détail tâche continuent de fonctionner via ce lien.
- `e2e_executions.task_id` : passe en optionnel (colonne `origin` ajoutée) ;
  l'existant garde `origin='task'`.

---

## 8. Backfill (T8)

Sources à migrer vers le nouveau modèle :

1. **Entités `e2e_tests` / `e2e_executions` déjà en registre** (specs C1..C13,
   exécutions liées aux tâches) → créer les entités 1er niveau, associer les
   projets couverts (repo source + autres projets selon le spec), migrer les
   exécutions vers l'origine `task`, conserver les liens `task_e2e`.
2. **Runs de recette récents sur T-…9xkf** (run-1788597272259 →
   run-1788597987039) → rattachés aux entités de test correspondantes
   (origine `recette`), conservés dans l'historique.
3. **Runs CI orphelins de l'inbox** (mada-talk, run-1788521549…run-1788548688,
   `taskId null`) → collectés et rattachés aux tests correspondants
   (origine `ci`), ce qui comble le trou de collecte (M4 du constat).

Hors périmètre (décision T12) : création d'un workflow E2E GitHub Actions pour le
repo ONIRIA (inexistant — ignoré dans ce chantier). Hors périmètre aussi : le
scan/import des spec files legacy des repos non encore enregistrés **en tant
qu'action manuelle de backfill** — ce besoin est couvert à terme par la
**synchronisation automatique** (T10, §6.5), qui reflettera le repo à chaque
déploiement (constat T-20260904-121806-vvia).

---

## 9. Points ouverts (à trancher au plan)

Résolus en cadrage (T1-T12) : gate doux (T9), sync auto registre (T10), une seule
exécution multi-projets (T11), workflow E2E ONIRIA hors périmètre (T12).

1. **Onglet Tests : droits** (qui peut créer/lancer/modifier — admin vs
   utilisateurs) et interactions avec l'écran Écosystème/agents.
2. **Formats des paramètres** : typage (url/string/secret/int/bool), expression
   des défauts multi-projets, jeton de substitution dans les spec files
   (`process.env` mappés par le runner).
3. **Rétention** : historique d'exécution d'un test indépendant (durée de
   conservation, archive), vidéos mensuelles (inchangé).
4. **Point d'accroche de la sync auto (T10)** : étape CI par repo vs script
   collecteur générique ; montée en charge ; cas des specs transverses (le même
   spec enregistré sous le repo source, projets couverts renseignés).

---

## 10. Règle IA / vidéo (rappel — inchangée)

- L'IA (`build-notify`, `agent-recette`, `atomic-plan`) n'analyse **que le
  rapport textuel** ; la vidéo est une **preuve humaine** jamais interprétée.
- Statut E2E séparé du statut tâche ; `NA` justifié pour audits / tâches sans
  comportement observable.

---

## 11. Glossaire

- **Test E2E** : entité 1er niveau (comportement) — `e2e_test_id`.
- **Repo source** : dépôt où vit le spec.
- **Projets couverts** : comportements transverses vérifiés (N:N).
- **Exécution** : passage du test (appartient au test), origine tracée.
- **Paramètre** : variable du test (défaut + surcharge au run).
- **Preuve** : rapport texte (IA+humain) ; vidéo (humain).
