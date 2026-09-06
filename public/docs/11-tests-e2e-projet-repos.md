# 11 — Tests E2E : rattachement à un PROJET unique + repos traversés (correction modèle)

> **Statut : VALIDÉ (2026-09-06) — implémenté (MCP v0.8.22 / panel v0.9.20).**
> Correction sémantique du modèle des tests E2E (ADR 08) suite au retour
> utilisateur : un test vérifie le comportement d'**UN projet** (produit), et
> peut traverser **1..N repos**. Le modèle précédent (« un test peut couvrir
> plusieurs projets ») était faux.
>
> **Retour utilisateur (v0.9.20)** : les repos de code associés au test doivent
> être **définissables à la création** du test — ils constituent la **couverture**
> que l'agent de recette lit dès le départ (ex. S1 traverse `mada-talk` ET
> `oniria`). Implémenté : `e2e_test_register`/`e2e_test_update` acceptent
> `repoIds`, les modales de création du panneau exposent un sélecteur de repos du
> projet, `e2e_list(taskId)` renvoie les repos, et la tâche requise créée depuis
> un test hérite de ses repos.

---

## 1. Le problème

Aujourd'hui (`e2e_tests` / `e2e_test_projects`) :
- `e2e_tests.project` = **repo source** (où vit le spec) — abus : ça porte l'id
  d'un projet utilisé comme repo ;
- `e2e_test_projects` (N:N) = « projets couverts » par le comportement.

Conséquence fausse : un test « parcours client madatalk → console ONIRIA » listait
les projets `madatalk` **et** `oniria` en coveredProjects — comme si le test
« appartenait » à deux projets.

**Réalité (retour utilisateur)** : un test n'appartient qu'à **UN projet** (le
produit dont on vérifie le comportement), mais son exécution peut traverser
**un ou plusieurs repos** (ex. le front `mada-talk` + la console `oniria`).

---

## 2. Modèle cible

```
Test E2E  ──▶  project : UN PROJET (produit)          ex. madatalk
Test E2E  ──▶  repos   : 1..N REPOS traversés (N:N)    ex. [mada-talk, oniria]
Test E2E  ──▶  spec_file : chemin du spec (vit dans un de ces repos)
```

Règles :
1. **`e2e_tests.project` = LE projet (produit)** dont le comportement est vérifié
   (`madatalk`, `oniria`, …). Un test = un seul projet.
2. **`e2e_test_repos` (N:N)** = les repos que le comportement traverse
   (`mada-talk` front, `oniria` console, …). **Ces repos = la COUVERTURE code du
   test**, définie à la création (`repoIds` sur `e2e_test_register`/update ou
   sélecteur du panneau) et lue par l'agent de recette (`e2e_list` →
   `test.repos`). Défaut si absents : tous les repos du projet.
3. **Repo du spec / exécution** : déduit parmi les repos du test — c'est le repo
   qui contient le `spec_file` (le repo « source » du spec). `e2e_run`/sync le
   résolvent ainsi.
4. **Sélection du run (ADR 10)** : le run post-déploiement sélectionne les tests
   dont `project` = le projet de la tâche livrée (ex. tâche projet `madatalk` →
   tests `project=madatalk`), quel que soit leur repo.
5. **Tâche requise issue d'un test** (`+ Créer une tâche (requise)`) : la tâche
   créée hérite des repos du test (couverture visible sur la tâche).

### Exemples
| Test (comportement) | project | repos traversés | spec vit dans |
|---|---|---|---|
| Parcours client madatalk → console ONIRIA | `madatalk` | `[mada-talk, oniria]` | repo `mada-talk` (le spec est dans le front) |
| Console admin : traitement demande (pur ONIRIA) | `oniria` | `[oniria]` | repo `oniria` |
| Login SPA client | `madatalk` | `[mada-talk]` | repo `mada-talk` |

---

## 3. Ce qui change / ne change pas

**Ne change pas**
- `spec_file` + `scenario` (grain `test()`), statuts (ACTIVE/OBSOLETE/…),
  exécutions (`e2e_executions`), liens `task_e2e`, Gherkin, vars de run.

**Change**
- `e2e_tests.project` : de « repo source » → « projet (produit) ».
- `e2e_test_projects` (N:N projets) → **`e2e_test_repos`** (N:N repos).
- Résolution du repo d'exécution : le repo contenant le spec parmi `repos`.
- Filtres/UI/agents : sélection par projet du comportement + repos traversés.

---

## 4. Migration des données existantes

Le registre est quasi vide (3 ACTIVE madatalk, ~150 OBSOLETE oniria). Migration :
1. **Ajouter `e2e_test_repos`** ; conserver `project` sur `e2e_tests`.
2. Pour chaque test existant :
   - `project` ← le projet actuel (`project` historique = le repo/projet) ;
   - `repos` ← [repo correspondant au `project` historique] (par défaut) ; à
     ajuster manuellement pour les tests transverses.
3. Les tests OBSOLETE sont conservés (historique) ; la migration ne les réactive
   pas.
4. `e2e_test_projects` n'est plus alimenté (lecture rétrocompat temporaire) puis
   supprimé.

---

## 5. Plan d'implémentation (étapes)

1. **Schéma** : table `e2e_test_repos` + backfill depuis l'existant (le repo du
   `project` historique). `project` reste (sémantique = projet produit).
2. **MCP** : outils `e2e_test_register/update/get` acceptent `repos` (ids) ;
   `e2e_list` filtre par `project` (produit) ; résolution repo-du-spec pour
   `e2e_run` + `e2e_sync_repo`.
3. **e2e_run** : sélectionner/ancrer le repo d'exécution = repo contenant le
   spec ; injecter les vars/secrets du bon projet.
4. **e2e_sync_repo** : en sync, un spec trouvé dans un repo → test rattaché au
   projet du repo (via project_repos) + repos traversés.
5. **Panel UI** : détail test — project (produit) + repos traversés ; filtres.
6. **ADR 10 run** : sélection par `project` de la tâche.
7. **Agents/docs** : test-agent (vocabulaire projet/repos) + ADR 08 révisé.

---

## 6. Points de vigilance

- **project ≠ repo** : après migration, `e2e_tests.project=madatalk` ne veut pas
  dire « le spec est dans le repo madatalk » — le repo du spec est un des
  `e2e_test_repos`.
- Cas transverse : un spec vit dans le repo front `mada-talk` mais le projet est
  `madatalk` → résolution repo-du-spec = `mada-talk` (contient le spec_file).
- Un repo peut porter des specs de tests de plusieurs projets (ex. le repo oniria
  sert la console du projet oniria ET est traversé par les tests madatalk).
