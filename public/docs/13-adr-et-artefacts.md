# 13 — ADR structurées, famille MCP `adr_*`, gouvernance en recette & gestionnaire central d'artefacts

> Ce document décrit **le code réellement déployé** (MCP `task-orchestrator` +
> panneau `orchestrator-panel`, 2026-09-21) : le modèle d'ADR **structurée**, la
> famille d'outils MCP `adr_*`, la **gouvernance ADR** appliquée pendant une
> recette/un test, et le **gestionnaire central d'artefacts** (table polymorphe
> `artifacts`). Pour la **taxonomie** `doc_type`, la référence unique est
> [`nomenclature-doc-type.md`](nomenclature-doc-type.md) — elle n'est pas
> recopiée ici.

---

## 1. ADR structurées (modèle)

Une **ADR** (décision d'architecture) est un artefact dont `doc_type = 'adr'`
(équivalent historique de `docs.kind = 'adr-tech'`). Elle est stockée dans la
table polymorphe `artifacts` (cf. §4) et porte des **champs structurés dédiés** —
elle n'est pas un simple fichier pointé.

| Champ | Rôle |
|---|---|
| `title` | **Titre** lisible de l'ADR. |
| `status` | **Statut** : `Proposé` \| `Accepté` \| `Déprécié` \| `Remplacé`. |
| `context` | **Contexte** (le problème, les contraintes). |
| `decision` | **Décision** actée. |
| `consequences` | **Conséquences** (positives/négatives, dette). |
| `path` | Chemin du **fichier** de l'ADR (le contenu long vit dans le fichier que les agents lisent ; la base porte le structuré). |
| `replaced_by` | `artifact_id` de l'ADR qui **remplace** celle-ci (statut `Remplacé`). |
| `is_global` | `1` = **ADR globale** (rattachée à **tous** les repos du projet). |

### Rattachement projet + 1..N repos

Le rattachement est **N:N** et porté par deux tables d'association :

- `artifact_projects` — ADR ⇄ **projet** (produit) ;
- `artifact_repos` — ADR ⇄ **repos** (dépôts de code), **1..N**.

Une ADR peut donc viser **un projet** et **plusieurs repos** ; une **ADR globale**
(`is_global = 1`) est considérée comme rattachée à **tous les repos du projet**
(utile pour les règles transverses). Une ADR globale « correspond toujours » aux
filtres par repos (`adr_list({ repoIds })`).

### Pièces jointes 0..N

Une ADR peut porter **0..N pièces jointes** : ce sont des artefacts
`doc_type = 'adr_file'`, avec `content_id = <adrId>`. Trois **sources**
(`source`) : `registry` (document du registre), `import` (fichier importé, stocké
sous `storage/ref-docs`) ou `ref` (fichier référencé par chemin). Le `meta` peut
porter `{ "targetDocId": … }` lorsque la pièce jointe référence un document du
registre.

### Cycle de vie & acceptation humaine

Le **statut initial** d'une ADR créée par un agent est **`Proposé`**. Les
transitions autorisées (`ADR_TRANSITIONS`) sont :

```
Proposé  → Accepté | Déprécié
Accepté  → Déprécié | Remplacé
Déprécié → Remplacé
Remplacé → (terminal)
```

`Remplacé` **exige** `replacedBy` (docId de l'ADR qui remplace, existante et
différente). Toute autre transition est **refusée**. L'**acceptation** d'une ADR
est une **décision humaine** : un agent ne fait pas passer une ADR à `Accepté`
de lui-même.

## 2. Famille MCP `adr_*` (12 outils)

Sur-ensemble **structuré** du module `doc_*` (les outils `doc_*` restent
inchangés, rétrocompatibles, cf. §4). Regroupés par usage :

### Lecture / contexte (productivité agent)

| Outil | Rôle |
|---|---|
| `adr_list` | Vue **condensée** des ADR d'un projet — point d'entrée des agents. Filtres : `projectId`, `repoIds` (intersection ; une ADR globale correspond toujours), `status`, `search` (titre/contexte/décision/conséquences/chemin), `includeRepoDocs`. Retourne `{ count, adrs }`. |
| `adr_get` | Contenu **complet structuré** d'une ADR (titre, statut, contexte, décision, conséquences, `replacedBy`, repos, pièces jointes, chemin, + conflits ouverts). |
| `adr_search` | Recherche texte (titre/contexte/décision/conséquences/chemin), insensible casse/accents. Retourne `{ count, results }` avec extrait. |
| `adr_context` | Construit le bloc **« ## ADR de référence »** prêt à injecter dans un prompt. `adrIds` (sélection explicite) sinon les ADR **actives** (`Proposé`/`Accepté`) du projet ; filtrage par `scope` (chemins) ; `taskId` résout `projectId`/`scope`. |

### Cycle de vie (écriture tracée)

| Outil | Rôle |
|---|---|
| `adr_register` | Crée une ADR structurée — **statut initial `Proposé`** par défaut. `repoIds` (1..N), `global=true` (tous les repos du projet), `attachments[]` optionnels. `path` requis. |
| `adr_set_status` | Fait **transiter** une ADR selon les transitions ci-dessus ; `replacedBy` requis si `Remplacé`. Transition non permise → refus. |
| `adr_update` | Met à jour les champs structurés (`title`/`path`/`description`/`context`/`decision`/`consequences`/`replacedBy`) et les rattachements (`addRepoIds`, `setGlobal`). |
| `adr_attach` | Rattache un **repo** (`repoId`) et/ou une **pièce jointe** (`docId` = document du registre, ou `path` = fichier `import`/`ref`). `source` : `registry` \| `import` \| `ref`. |

### Signalement & vigilances

| Outil | Rôle |
|---|---|
| `adr_report_conflict` | Signale qu'une implémentation **contredit** une ADR → conflit persisté (`adr_conflicts`, `status='open'`) **même sans `taskId`** (aucune violation silencieuse). Avec `taskId`, crée une **décision humaine** (`kind='conflict'`) dont la résolution **clôt** le conflit. Avec `recetteId`, crée **en plus** un point de vigilance global bloquant. |
| `adr_report_missing` | Signale une **ADR manquante** pour une entité réellement discutée (recette ou test), après `adr_list`/`adr_search` négatifs. Exige `entity` + `description`. Contexte : `recetteId` (→ point global bloquant), `taskId` (test) ou `projectId`. |
| `adr_vigilance_list` | **Historique filtrable** (append-only, lecture seule) des vigilances : `type` (`missing`/`conflict`), `status` (`open`/`resolved`), `projectId`, `recetteId`, `from`/`to`, `limit`. Chaque point porte sa `reason` explicite. |
| `adr_vigilance_resolve` | **Lève** un point de vigilance. `resolution` (raison **tracée**) **obligatoire** ; `resolutionKind` ∈ `adr_created` \| `adr_deprecated` \| `manual` \| `decision` ; `adrId` optionnel (ADR liée). |

> **Rétrocompatibilité** : `doc_register`/`doc_update`/`doc_get`/`doc_list`
> (kind `adr-tech`, `specs-fonctionnelles`, `scenarios-gherkin`) et les pièces
> jointes `doc_attachment_*` restent disponibles et pointent le **même** stockage
> (`artifacts`).

## 3. Gouvernance ADR en recette / test

Pendant une **recette** (ou une session de **test**), un agent peut détecter
qu'une décision d'architecture est **manquante** ou **contredite**. Le framework
en fait un **point de vigilance global** qui **bloque la terminaison** de la
recette — jamais de validation silencieuse.

### Points de vigilance (`adr_vigilances`)

Un point est persisté dans la table `adr_vigilances` (append-only) :

| Colonne | Rôle |
|---|---|
| `vigilance_id` | PK (`adr-vig-<ts>-<rand>`). |
| `project`, `recette_id`, `task_id`, `session_id` | Contexte (projet, recette, tâche/test, session d'origine). |
| `type` | `missing` (**ADR manquante**) ou `conflict` (**conflit d'ADR**). |
| `status` | `open` \| `resolved`. |
| `entity`, `description` | Entité/constat concerné et description. |
| `adr_id`, `related_adr_id`, `conflict_id` | ADR concernée / proposée, ADR liée, conflit rattaché. |
| `resolution`, `resolution_kind`, `resolved_at`, `resolved_by` | Levée **tracée** (raison + nature + auteur). |

La `reason` exposée est explicite : **« ADR manquant pour [entité] »** ou
**« Conflit d'ADR : [ancienne] vs [nouvelle] »**.

### Blocage de `recette_confirm`

- **Registre (source de vérité)** : `recette_confirm` est **REFUSÉ** tant qu'un
  point de vigilance est **ouvert** sur la recette, avec la raison explicite de
  chaque point et l'invite à le lever via `adr_vigilance_resolve`.
- **Panneau (pré-check)** : avant toute création de tâches, `finishRecette`
  effectue le **même contrôle** et lève une erreur
  (« terminaison bloquée : … — résolvez chaque point … ou levez-le explicitement
  avec une raison tracée »). L'UI affiche les points ouverts et **bloque** le
  bouton de terminaison.

### Levée tracée (2 canaux)

1. **Levée explicite** : `adr_vigilance_resolve` (MCP) / `POST
   /api/adr-vigilances/<id>/resolve` (panneau, bouton « Lever ») — `resolution`
   obligatoire, `resolutionKind` = `adr_created` (une ADR a été créée),
   `adr_deprecated` (dépréciation actée), `decision` (décision explicite) ou
   `manual`.
2. **Par décision humaine** : un **conflit** signalé avec `taskId` crée une
   décision `kind='conflict'` ; sa **résolution** clôt le conflit
   (`adr_conflicts.status='resolved'`) et le point de vigilance associé (raison
   tracée « Conflit d'ADR résolu par décision humaine »).

> Le blocage n'est donc **jamais infini**, mais **jamais silencieux** : toute
> levée porte une raison.

### Historique append-only filtrable

- MCP : `adr_vigilance_list` (filtres `projectId`, `recetteId`, `type`, `status`,
  `from`/`to`, `limit`).
- Panneau : `GET /api/adr-vigilances` (mêmes filtres) alimente l'historique des
  vigilances ; **aucun bouton de suppression** (append-only).

### Conflits code ↔ ADR (`adr_conflicts`)

Un conflit est persisté dans `adr_conflicts` : `conflict_id`, `adr_id` (→
`artifacts`), `task_id` (nullable — hors tâche autorisé), `description`,
`status` (`open`/`resolved`), `decision_id` (décision humaine `kind='conflict'`),
`created_at`, `created_by`.

## 4. Gestionnaire central d'artefacts

### Table polymorphe `artifacts`

Tous les artefacts (documents/livrables) vivent dans **une seule table**,
identifiée par le couple **(`doc_type`, `content_id`)** :

| Colonne | Rôle |
|---|---|
| `artifact_id` | PK **stable** (`ART-…`, `doc-…`, `att-…`, `ART-REC-…`). |
| `doc_type` | **Type d'artefact** (taxonomie → [`nomenclature-doc-type.md`](nomenclature-doc-type.md)). |
| `content_id` | Identifiant de l'**entité porteuse** (taskId, recetteId, projectId, docId…). **Polymorphe, sans FK** : le nettoyage est assuré côté code, par famille. |
| `kind` | **NATURE** (`plan` \| `audit` \| `report` \| `autre`), **distincte** de `doc_type`. |
| `nature` | Liaison libre (« à quoi sert / comment exploiter » — recettes). |
| `source` | Domaine d'origine : `import` \| `artifact` \| `registry` \| `ref`. |
| `meta` | **JSONB** — champs propres à une famille. |
| `title`, `path`, `description` | Titre lisible, chemin (hôte/workspace) du fichier, description. |
| `status`, `context`, `decision`, `consequences`, `replaced_by`, `is_global` | **Champs ADR structurés** (cf. §1). |
| `organization_id`, `created_at`, `updated_at`, `created_by` | Tenant + traçabilité. |

> **`content_type` est un nom RÉSERVÉ** (futur « type d'artefact ») : il n'est
> **jamais** créé ni utilisé.

### Fusion des 3 silos

Le gestionnaire central **fusionne physiquement** les trois silos historiques
dans `artifacts` :

1. `artifacts` de **tâche** (liés par `task_id`) → familles `plan`,
   `task_synthese`, `task_report`, `audit_report`, `autre` ;
2. `recette_documents` → `recette_report`, `recette_doc` ;
3. `docs` **ADR-12** (documents de référence projet/repo) → `adr`, `specs`,
   `gherkin`, `project_doc`, `adr_file`.

Le rattachement projet/repo des documents ADR-12 passe par `artifact_projects` /
`artifact_repos` (qui remplacent `doc_projects` / `doc_repos`).

### Taxonomie

La liste **énumérée** des `doc_type` (13 familles nommées + `autre`) et la table
de **mapping de migration** 1:1 sont dans
[`nomenclature-doc-type.md`](nomenclature-doc-type.md) — **source de vérité
unique**, à ne pas dupliquer.

### Neutralisation `legacy_*`

Les tables historiques `docs`, `doc_projects`, `doc_repos`, `doc_attachments` et
`recette_documents` sont **migrées** (script `scripts/artifacts-fusion-migration.mjs`,
idempotent) puis **neutralisées** (renommées `legacy_*`) — **JAMAIS supprimées**.
Une base **neuve** ne les crée plus : la source logique unique est `artifacts`.

### Rétrocompatibilité

- `artifact_add` / `artifact_list(taskId)` : signatures conservées
  (`docType` + `contentId` + `kind` + `nature` + `source` + `meta` ; `taskId`
  seul reste accepté, `docType` dérivé de `kind`).
- `doc_*` et `adr_*` lisent/écrivent la **même** table `artifacts`
  (filtre `doc_type`).
- `recette_get` conserve `documents[]` (`documentId` entier = `artifacts.id`).
- Jointures E2E : `e2e_executions.report_artifact_id` / `video_url` pointent un
  `artifact_id` préservé.

## 5. Panneau

### Organisation des onglets

- **Onglets globaux** (aucun projet ouvert) : Projets, Vue d'ensemble,
  Écosystème, Workspaces (admin), Utilisateurs (admin).
- **Sous-onglets d'un projet ouvert** (`PROJECT_TABS`) : Vue d'ensemble, Tâches,
  Recettes, Tests E2E, Décisions, **Artefacts**, **ADR**, Vars & Secrets E2E,
  Archives.
- Les onglets **Déploiements**, **Événements** et **Plans** ne figurent plus dans
  la barre : ils restent accessibles via la section **« Consulter »** du **modal
  de détail d'une tâche** (boutons `data-goto` : Artefacts, Événements,
  Déploiements, Décisions, Plans).

### Onglet **ADR** (par projet)

`renderAdrs()` liste les ADR (`kind='adr-tech'`) du projet **et de ses repos
transverses** (`GET /api/docs?projectId=…&includeRepoDocs=1`, filtré
`kind='adr-tech'`). La table ADR affiche titre, badge de **statut**, chips
**repos**, badge **globale** et décision condensée, avec filtres statut/repo +
recherche.

### Onglet **Artefacts** (gestionnaire central)

`renderArtifacts()` liste **tous les artefacts, toutes entités confondues**
(tâche / recette / projet / ADR / E2E) : colonnes **Entité** (`content_id`
résolu), **Type** (`doc_type`), **Nature** (`kind`), Titre, Ajouté ; filtres
`docType` / `kind` / `contentId` / recherche, bouton « + Ajouter un artefact »,
actions « Regarder » (visionneuse markdown) et « Télécharger ». API :
`GET /api/artifacts`, `POST /api/artifacts`.

### Historique des vigilances ADR

Le panneau expose l'historique filtrable des points de vigilance ADR
(`GET /api/adr-vigilances`) et leur **levée tracée**
(`POST /api/adr-vigilances/<id>/resolve`). La liste des recettes affiche un badge
⚠ avec le **nombre de points ouverts** (terminaison bloquée).

### Documentation `/docs/…`

Les fichiers markdown de ce dossier sont servis par la route **`/docs/*.md`**
(accessible sans authentification) ; `/docs` redirige vers
`/docs/README.md`. Le présent document est donc servi à
`/docs/13-adr-et-artefacts.md`.

---

## English version

**1. Structured ADRs** — an ADR is an `artifacts` row with `doc_type='adr'`
(formerly `docs.kind='adr-tech'`) carrying dedicated structured fields: `title`,
`status` (`Proposed | Accepted | Deprecated | Replaced`), `context`, `decision`,
`consequences`, `replaced_by`, `is_global`. Project + 1..N repos attachment is
N:N via `artifact_projects` / `artifact_repos`; a **global** ADR (`is_global=1`)
applies to all repos of the project. **Attachments** (0..N) are `adr_file`
artifacts (`content_id=adrId`, `source` = `registry`/`import`/`ref`). Initial
status is `Proposed`; **acceptance is a human decision**. Allowed transitions:
`Proposed → Accepted|Deprecated`, `Accepted → Deprecated|Replaced`,
`Deprecated → Replaced`, `Replaced` terminal (`Replaced` requires `replacedBy`).

**2. `adr_*` MCP family (12 tools)** — read/context: `adr_list`, `adr_get`,
`adr_search`, `adr_context`; lifecycle: `adr_register`, `adr_set_status`,
`adr_update`, `adr_attach`; reporting/vigilances: `adr_report_conflict`,
`adr_report_missing`, `adr_vigilance_list`, `adr_vigilance_resolve`. The legacy
`doc_*` tools remain (same `artifacts` storage).

**3. ADR governance in acceptance/testing** — a missing/conflicting ADR becomes
an **open global vigilance** (`adr_vigilances`, `type` = `missing`/`conflict`)
that **blocks** `recette_confirm` (registry guard + panel pre-check) with an
explicit reason. It is lifted in a **traced** way (mandatory `resolution`;
`resolutionKind` = `adr_created`/`adr_deprecated`/`manual`/`decision`), or by
resolving the human `conflict` decision. History is **append-only** and
filterable (`adr_vigilance_list` / `GET /api/adr-vigilances`).

**4. Central artifact manager** — a single polymorphic `artifacts` table keyed by
(`doc_type`, `content_id`); `kind` is the **nature** (distinct from `doc_type`);
plus `nature`, `source`, `meta`. It physically **merges** the three former silos
(task artifacts, `recette_documents`, ADR-12 `docs`); taxonomy lives in
[`nomenclature-doc-type.md`](nomenclature-doc-type.md). Legacy tables are
**neutralized** as `legacy_*` (never dropped).

**5. Panel** — project sub-tabs are Overview, Tasks, Recettes, E2E Tests,
Decisions, **Artifacts**, **ADR**, E2E Vars & Secrets, Archives. The
Deployments/Events/Plans tabs were removed and are reachable from the **task
detail modal** ("Consulter"). Markdown docs are served by the `/docs/*.md` route.
