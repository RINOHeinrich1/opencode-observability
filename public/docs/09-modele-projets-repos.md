# 09 — Modèle Projets ↔ Repos : état des lieux & cible (ADR)

> **Statut : VALIDÉ (2026-09-06) — migration en cours par étapes.**
> Ce document décrit une confusion structurelle détectée dans le registre
> (l'entité `project` mélange « produit métier » et « dépôt de code ») et propose
> un modèle cible `Projet ⇄ Repo` (N:N), avec le mapping de l'existant et un plan
> de migration en étapes. Rien n'est modifié tant que le modèle n'est pas validé.

---

## 1. Le problème

Aujourd'hui **une seule entité `project`** porte à la fois :

- des données de **repo** (workspace Coder, `git_path`, `main_branch`,
  `e2e_repo_dir`, `e2e_base_url`),
- et sert d'**identifiant produit** référencé par `tasks`, `recettes`, `e2e_tests`.

Or la réalité métier est : **un projet (produit) utilise plusieurs repos**, et un
repo peut servir plusieurs projets. Le modèle « 1 projet = 1 workspace = 1 repo »
casse dès ce cas — qui est le cas général en développement.

### Constat sur les données réelles du registre

| `projects.id` | workspace | git_path / main_branch | Nature réelle |
|---|---|---|---|
| `mada-talk` | madatalk | repo mada-talk / `main` | **frontend client** SPA (produit + repo confondus) |
| `oniria` | — (null) | — (null) | **produit virtuel** : porte 52 tâches + 152 tests, mais aucun repo lié |
| `pbn` | ONIRIA | repo PBN / `main` | **repo ONIRIA** (console admin/backend, déployé sur branche `oniria-preprod`) |
| `onirtech-backend` | ONIRIA | référentiel onirtech backend | repo (outillage) |
| `onirtech-frontend` | ONIRIA | référentiel onirtech frontend | repo (outillage) |

**Incohérences concrètes**
- Le produit `oniria` n'a **ni workspace ni repo**, alors que son code vit dans le
  repo `pbn` (checkout `/root/oniria-preprod`, branche `oniria-preprod`).
- `mada-talk` est enregistré comme « projet » alors que c'est **un repo du produit
  Madatalk** (qui contient aussi le repo ONIRIA).
- Un test E2E « parcours client madatalk → console ONIRIA » doit lister les
  projets `mada-talk` **et** `oniria` en `coveredProjects` — témoin du mélange.

---

## 2. Modèle cible

```
Produit (Project) ──────── N:N ──────── Repo
  ex. Madatalk                       ex. mada-talk (frontend client)
  ex. ONIRIA                         ex. PBN (console admin / backend, branche oniria-preprod)
                                     ex. onirtech-* (outillage)
```

### Règles du modèle

1. **Projet / Project** = unité **métier/produit** (ex. `madatalk`, `oniria`).
   Les **tâches, recettes et tests E2E sont rattachés à un Projet**.
2. **Repo** = un **dépôt de code** physique + ses caractéristiques d'exécution :
   - workspace Coder (où vit le checkout),
   - `git_url` / `git_path`, branche(s) de référence (ex. `main`, `oniria-preprod`),
   - checkout hôte E2E (`e2e_repo_dir`) et URL de test (`e2e_base_url`).
3. **Association N:N Projet ⇄ Repo** : un projet liste ses repos ; un repo peut
   être partagé par plusieurs projets.
   - Exemple validé : le repo `pbn` (ONIRIA) est un repo **du projet `oniria`**
     **et** du projet `madatalk`.
4. **Point d'exécution d'une tâche** = un **repo** (choisi parmi ceux du projet,
   ou déduit du scope). La tâche reste attachée au **projet** ; le repo ciblé est
   une propriété d'exécution (worktree, merge, deploy).
5. **Le spec d'un test E2E vit dans un repo** (repo source) ; le test couvre un
   ou plusieurs **projets** (`coveredProjects` = produits dont le comportement est
   vérifié).

### Traduction de l'existant vers la cible

| Aujourd'hui (`projects`) | Devient `projects` (produit) | Devient `repos` | `project_repos` |
|---|---|---|---|
| `mada-talk` (produit+repo) | produit `mada-talk` | repo `mada-talk` (frontend client) | mada-talk → madatalk |
| `oniria` (fantôme) | produit `oniria` | — (les repos sont liés par `project_repos`) | — |
| `pbn` | — | repo `pbn` (ONIRIA) | pbn → oniria **et** pbn → madatalk |
| `onirtech-backend` | — | repo (outillage) | à rattacher au(x) produit(s) concerné(s) |
| `onirtech-frontend` | — | repo (outillage) | idem |

> Note de dénomination : le repo `pbn` correspond au produit ONIRIA. Selon la
> validation (point 5 infra), on peut renommer l'id repo en `oniria`/`oniria-app`
> pour la lisibilité, en conservant `git_path` = repo PBN.

---

## 3. Ce qui change / ce qui ne change pas

**Ne change pas (reste au niveau Projet)**
- `tasks.project`, `recettes.project` (+ `recette_projects`), `e2e_test_projects`
  (`coveredProjects`), filtres UI « projet » : tout cela reste **produit**.

**Change / est introduit**
- Nouvelle table `repos` + table d'association `project_repos` (N:N).
- Les colonnes *repo physiques* sortent de `projects` :
  `workspace`, `git_path`, `main_branch`, `e2e_repo_dir`, `e2e_base_url` → `repos`.
- L'exécution d'une tâche cible un **repo** (le worktree/merge/deploy se font sur
  le repo, pas sur le projet).
- Le test E2E garde un **repo source** pour son spec + son exécution
  (`e2e_repo_dir`), indépendant des projets couverts.
- UI / MCP / agents : ajout du choix de repo dans la création de tâche / de
  projet (au lieu du champ unique actuel), et liste des repos par projet.

---

## 4. Plan de migration (après validation)

Migrer **sans perte de données**, par étapes idempotentes :

1. **Créer `repos` + `project_repos`** (schéma), garder `projects` pour les produits.
2. **Backfill** depuis `projects` :
   - chaque ligne existante devient un **produit** (id conservé) ;
   - pour chaque ligne ayant des données repo (`workspace`/`git_path` non nuls) :
     création d'un **repo** dérivé (id = id projet ou dédié), rattaché au produit.
3. **Corrections ciblées** sur les cas connus :
   - `oniria` (produit) ← rattacher le repo `pbn` (dont `e2e_repo_dir =
     /root/oniria-preprod`, branche `oniria-preprod`) ;
   - `mada-talk` ← rattacher le repo frontend `mada-talk` ;
   - `project_repos` : repo `pbn` → produits `oniria` **et** `madatalk`.
4. **Bascule des références** : les colonnes repo sortent de `projects` ; le code
   (MCP db/index, panel server/UI, pilot, agents) lit les repos via `repos` +
   `project_repos` ; rétrocompat temporaire en lecture.
5. **UI** : onglet projet → liste des repos associés (créer/retirer/éditer un repo
   par projet) ; création de tâche → choix du projet + repo cible.
6. **Validation** : recette sur les flux projet/repo/tests avant de supprimer les
   colonnes legacy.

---

## 5. Décisions validées

> Réponses utilisateur (2026-09-06) — le modèle cible est **validé** ; la
> migration peut être exécutée par étapes.

1. **Produit frontend** : garder l'id produit `mada-talk` (pas de renommage) — il
   référence le repo `mada-talk` (frontend) **et** le repo `oniria` (partagé).
2. **ONIRIA** : produit `oniria` **distinct** conservé (tâches/recettes/tests
   propres) + le repo `oniria` (repo PBN, branche `oniria-preprod`) est rattaché
   au produit `oniria` **et** au produit `mada-talk`.
3. **Outillage** `onirtech-backend`/`onirtech-frontend` : repos conservés
   enregistrés, **non liés** à Madatalk/ONIRIA pour l'instant.
4. **Nommage** : le repo ONIRIA s'appelle **`oniria`** (git_path = repo PBN).
5. **Branche de déploiement par repo** : chaque repo porte sa (ses) branche(s)
   cible(s) (`main` pour mada-talk ; `oniria-preprod` pour oniria).
6. **Tâches multi-repos** : à la création, une tâche cible un projet + un repo ;
   le scope peut couvrir plusieurs repos (décision d'exécution).

### Cible d'associations `project_repos`

| Projet (produit) | Repos associés |
|---|---|
| `mada-talk` | `mada-talk` (frontend client) · `oniria` (console admin/backend, partagé) |
| `oniria` | `oniria` (repo PBN, branche `oniria-preprod`) |
| *(non lié)* | `onirtech-backend` · `onirtech-frontend` (outillage) |

### Table `repos` initiale

| `repos.id` | git_path | workspace | branche(s) cible | e2e_repo_dir | notes |
|---|---|---|---|---|---|
| `mada-talk` | repo mada-talk | madatalk | `main` | `/root/mada-talk-preprod` | frontend client |
| `oniria` | repo PBN | ONIRIA | `oniria-preprod` | `/root/oniria-preprod` | console admin/backend |
| `onirtech-backend` | référentiel onirtech backend | ONIRIA | `main` | — | outillage |
| `onirtech-frontend` | référentiel onirtech frontend | ONIRIA | `main` | — | outillage |

---

## 6. Plan de migration (validé — à exécuter par étapes)

> Règle d'or : migrer **sans perte de données**, par étapes idempotentes, et
> pouvoir rejouer chaque étape. La recette finale valide avant suppression des
> colonnes legacy.

1. **Schéma** : créer `repos` + `project_repos` (N:N) ; `projects` devient le
   registre des **produits** (les colonnes repo physiques y sont conservées en
   attendant la bascule).
2. **Backfill** : chaque `projects.*` existant devient un **produit** ; chaque
   ligne avec données repo (`workspace`/`git_path` non nuls) génère un **repo**
   rattaché à son produit.
3. **Corrections ciblées** :
   - produit `oniria` ← repo `oniria` (git_path = PBN, e2e_repo_dir =
     `/root/oniria-preprod`, branche `oniria-preprod`) ;
   - produit `mada-talk` ← repos `mada-talk` + `oniria` ;
   - `pbn` renommé `oniria` (références internes mises à jour si existantes).
4. **Bascule code** : MCP (db/index), pilot, panel (server + UI), agents lisent
   les repos via `repos` + `project_repos` ; lecture rétrocompat temporaire.
5. **UI** : liste des repos par projet (créer/éditer/retirer/rattacher) ; choix
   du repo à la création d'une tâche.
6. **Recette** : valider les flux projet/repo/tâches/tests, puis supprimer les
   colonnes repo physiques de `projects`.
