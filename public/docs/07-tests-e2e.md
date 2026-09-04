# 07 — Cadrage : intégration native des tests E2E Playwright dans le cycle de vie des tâches

> **Statut : CADRAGE — aucune implémentation** (document de référence pour le futur
> plan atomic-plan). Dernière mise à jour : 2026-09-04.
>
> Périmètre documentaire : écosystème d'orchestration (opencode-observability /
> opencode-mcp-task-orchestrator / opencode-agents) + repos applicatifs cibles
> (Playwright).

---

## 1. Objectif

Toute demande de développement ou de correction **à impact fonctionnel
observable** doit avoir une **stratégie de preuve E2E associée** : identifier les
tests Playwright concernés (créer / modifier / supprimer / conserver), les
exécuter pendant le traitement de la tâche, et rattacher la **preuve
d'exécution** à la tâche.

> Une tâche n'est **pas validée** sur le seul fait que le code est écrit : elle
> l'est sur la **réussite des tests associés + preuves disponibles**.

Deux règles cœur complémentaires :

1. **Règle métier** : pour toute tâche de développement ou de correction ayant un
   impact fonctionnel observable, l'orchestrateur doit identifier les scénarios
   E2E concernés, maintenir le référentiel Playwright en conséquence et exécuter
   les tests associés lors du traitement. Leur réussite et leurs preuves
   constituent une preuve de validation.
2. **Règle d'analyse** : à chaque nouvelle demande, l'orchestrateur analyse
   l'impact sur le référentiel E2E existant (create / update / delete / keep) —
   jamais de création de tests « en aveugle » sans regarder l'existant.

---

## 2. Périmètre

### Concerné (tâches à impact fonctionnel observable)
- Création de fonctionnalité ;
- Modification de fonctionnalité ;
- Correction de bug ;
- Modification du comportement métier ;
- Modification importante de l'interface ;
- Modification d'un parcours utilisateur.

### Non concerné (statut E2E `NA` justifié)
- Tâches de type **AUDIT** ;
- Tâches purement techniques ne produisant **aucun comportement utilisateur
  observable** (justification `reason` tracée, vérifiée par l'auditor).

---

## 3. Cycle de vie intégré

```
Nouvelle demande
      │
      ▼
Analyse de la demande
      ├──► Décomposition en tâches (atomic-plan)
      └──► Analyse d'impact E2E          ← atomic-plan (ou orchestrateur en direct)
              ├── create    (nouveaux scénarios)
              ├── update    (scénarios à modifier)
              ├── delete    (scénarios obsolètes)
              └── keep      (scénarios inchangés / non-régression)
      │
      ▼
Création des tâches  +  association tâche ↔ tests (task_e2e)
      │
      ▼
Exécution de la tâche (build-notify) : code + tests unitaires/intégration
      │
      ▼
CI/CD (auto-hébergé) : déploiement préprod de branche
      │
      ▼
Exécution des tests E2E associés   ← à chaque déploiement
      │
      ├── PASS → preuve (rapport texte) rattachée à la tâche
      └── FAIL → boucle de correction (max 3 itérations) ; au-delà → suspension + humain
      │
      ▼
Résultat visible dans l'orchestrateur (section « Tests E2E » + badge)
      │
      ▼
Validation (recette/auditor/humain)
```

### Exécution directe (sans atomic-plan)
Même enchaînement avec une **analyse d'impact E2E allégée** portée par
l'orchestrateur puis confirmée par build-notify avant exécution.

### Répartition par agent
| Phase | Agent |
|---|---|
| Analyse d'impact E2E + association | `atomic-plan` (ou orchestrateur en direct) |
| Implémentation + itérations de correction | `build-notify` |
| Exécution des tests | CI/CD auto-hébergé (jamais Playwright dans build-notify) |
| Verdict E2E (sur rapport **texte uniquement**) | `build-notify` |
| Cohérence tâche ↔ tests ↔ preuves | `auditor` |
| Constats / non-régression | `agent-recette` (texte uniquement) |

---

## 4. Décisions actées

| # | Sujet | Décision |
|---|---|---|
| D1 | Granularité du référentiel | **1 enregistrement par `test()` Playwright** (scénario) |
| D2 | Déclenchement | **À chaque déploiement** : scan/import des spec files (registre central) **et** exécution des tests associés de la branche |
| D3 | Environnement d'exécution | **CI/CD auto-hébergé**, après déploiement **préprod de branche** |
| D4 | Verdict / échec | Boucle autonome : FAIL → l'agent corrige et relance (**3 itérations max**) ; **rien d'échoué ne part en préprod** ; au-delà de 3 → **suspension + information humaine** ; suspension aussi si la résolution exige autorisation/intervention humaine |
| D5 | Rôle de la vidéo | **Preuve pour l'HUMAIN uniquement** ; l'IA ne traite que le **rapport textuel** |
| D6 | Rapport textuel | Artefact **partagé** : disponible pour l'IA **et** l'humain (visionnage + téléchargement) |
| D7 | Rétention vidéos | **Mensuelle** (fenêtre glissante) + **téléchargement** : une vidéo seule ou **plusieurs dans un ZIP** |
| D8 | Audits / tâches techniques | **Non concernés** (E2E `NA` justifié) |
| D9 | Affichage | Section « Tests E2E » + badge colonne + lecteur vidéo intégré (voir §9) |

---

## 5. Modèle de données (proposition)

Adossé aux primitives existantes (`artifacts`, `deployments`, `executions`,
`events`) — pas de concept parallèle.

```
e2e_tests
  id             TEXT PK            -- E2E-<PROJ>-<slug>-NNN
  project        TEXT NOT NULL      -- projet/dépôt applicatif
  spec_file      TEXT NOT NULL      -- tests/e2e/auth/login.spec.ts
  scenario       TEXT NOT NULL      -- titre du test() (un enregistrement par test)
  title          TEXT
  status         TEXT               -- ACTIVE | OBSOLETE | QUARANTINE | DRAFT
  version        INTEGER
  meta           JSONB              -- tags, owners, liens éventuels
  first_seen_at / updated_at

task_e2e                          -- N:N tâche ↔ test (relation typée)
  task_id        TEXT NOT NULL
  e2e_test_id    TEXT NOT NULL
  relation_type  TEXT              -- CREATED | UPDATED | REGRESSION | EXISTING
  reason         TEXT              -- justification (obligatoire, tracée)
  PRIMARY KEY (task_id, e2e_test_id)

e2e_executions
  id             TEXT PK           -- EXE-<ts>-<rand>
  e2e_test_id    TEXT NOT NULL
  task_id        TEXT
  plan_id        TEXT
  deployment_id  TEXT              -- rattachée au déploiement préprod de branche
  env            TEXT              -- preprod-<branche> / …
  commit_sha     TEXT
  branch         TEXT
  pipeline_ref   TEXT
  status         TEXT              -- PENDING | RUNNING | PASSED | FAILED | ERROR | SKIPPED | FLAKY
  duration_ms    INTEGER
  attempts       INTEGER           -- itération de correction (1..3)
  executed_at    TEXT
  report_artifact_id  TEXT         -- artefact TEXTE (IA + humain)
  logs_url       TEXT
  video_url      TEXT              -- preuve HUMAINE (hors IA)
  summary        TEXT              -- verdict/synthèse textuelle
  verdict_by     TEXT              -- build-notify | human
```

### Preuves (mapping artefacts)
| Artefact | Contenu | Consommateur |
|---|---|---|
| `report` (texte/JSON synthétisé + logs) | résultat, étapes, erreurs, snapshot textuel | **IA + Humain** |
| `video` (URL/fichier) | capture Playwright | **Humain uniquement** |

### Statut E2E (distinct du statut tâche)
`PENDING` → `RUNNING` → `PASSED` / `FAILED` / `ERROR` / `SKIPPED`, + `FLAKY`
(quarantaine) + `NA` (justifié : audit / technique).

Le statut principal de la tâche n'est **pas** pollué : l'état E2E vit à côté et
alimente un badge dédié.

---

## 6. Registre central scanné

- Source de vérité : **PostgreSQL central (multi-projets)**.
- Alimentation : à **chaque déploiement**, le CI **scanne** les spec files du
  dépôt applicatif, **importe/mets à jour** les entités `e2e_tests` (par
  `test()`), puis exécute les tests associés à la tâche.
- Règles d'import (à préciser au plan) :
  - création si inconnu, mise à jour si le titre/chemin change, `OBSOLETE` si un
    scénario disparaît du code (référentiel = reflet du repo) ;
  - **jamais de suppression** d'un historique d'exécution lié ;
  - idempotent (même spec + même test → même `e2e_test_id`).

---

## 7. Verdict et boucle de correction

```
Tâche (build-notify) → code livré sur la branche
        │
        ▼
CI : déploiement préprod de branche (uniquement si les gates antérieures passent)
        │
        ▼
Exécution E2E associés
        │
        ├── PASS ─────────────► preuve texte rattachée → tâche exécutable à la suite
        │
        └── FAIL ──► build-notify analyse le RAPPORT TEXTUEL
                        ├── corrigible par l'agent  → correction + relance (itération i+1)
                        ├── i > 3  → SUSPENSION + décision humaine
                        └── non explicable par le texte → état « nécessite analyse
                            humaine (vidéo) » (pas d'auto-diagnostic)
```

- **Rien d'échoué ne part en préprod stable.**
- Flakiness : **1 retry automatique** avant verdict ; test instable répété →
  marquage `FLAKY` + quarantaine (hors blocage).
- Toute suspension est tracée (événement + décision humaine `decision_request`).

---

## 8. Couverture fonctionnelle E2E

Pas de « couverture de code » : **couverture fonctionnelle de la demande** =
nombre de scénarios E2E couverts / scénarios prévus pour la demande (ex.
modifier l'email : succès, email invalide, email déjà utilisé, annulation → 4/4).
La déclaration des scénarios (D1) rend ce comptage possible.

---

## 9. Affichage dans l'orchestrateur

### Détail de la tâche — section « Tests E2E »
- Liste des tests associés : id, titre, relation (`CREATED/UPDATED/REGRESSION/…`),
  statut de la **dernière exécution**, durée, commit/pipeline ;
- actions par exécution : **« Voir le rapport »** (texte, IA + humain),
  **« Télécharger le rapport »**, **« ▶ Voir la vidéo »** (humain),
  **« Télécharger la vidéo »** ;
- indicateur de boucle : `itération i/3` ; état « suspension » si atteint ;
- en FAIL non expliqué : avertissement « analyse humaine requise (vidéo) ».

### Table des tâches
Badge compact : `E2E ✓` (PASS récent) / `E2E ✗` (FAIL) / `E2E …` (en attente ou
en cours) / `E2E —` (NA justifié) ; tooltip = détail (itération, dernière
exécution).

### Lecteur vidéo intégré (humain)
HTML5 dans le panneau : lecture/pause, volume, vitesses **0.25 / 0.5 / 1 /
1.5 / 2**, téléchargement **d'une** vidéo ou **de plusieurs en ZIP**.

---

## 10. Règle IA / vidéo

- L'IA (`build-notify`, `auditor`, `agent-recette`, `atomic-plan`) n'analyse
  **que le rapport textuel** (JSON + logs + sortie + snapshot textuel).
- La vidéo / les screenshots sont des **preuves pour l'humain** ; elles ne sont
  jamais interprétées par l'IA et ne portent aucun verdict.
- En cas de FAIL non explicable par le texte, l'agent **n'invente pas** de
  diagnostic : état « nécessite analyse humaine », l'humain disposant du rapport
  ET de la vidéo.

---

## 11. Points ouverts (à trancher au moment du plan)

1. Outil exact du scan/import (script dédié dans le dépôt applicatif vs étape CI
   générique de l'orchestrateur) et montée en charge (volume de spec files).
2. Cible d'exécution précise par type de dépôt : où vit le déploiement
   « préprod de branche » pour chaque projet (runner auto-hébergé existant,
   env dev partagé le cas échéant) ; gestion des secrets/env de test.
3. Durée/parallélisme (workers Playwright), budget temps par itération.
4. Rétention des rapports texte (au-delà des vidéos mensuelles).
5. Intégration fine avec l'existant : point d'accroche exact dans la machine à
   états (déploiement → E2E), mapping aux `deployments`/`executions`, traçage
   d'événements `E2E_*`, jonction avec la recette (constats « bug » porteurs de
   tests) et l'auditor (règle de cohérence).
6. Marque « preuve de validation » formelle sur la tâche (champ/vue dédié) vs
   simple badge.

---

## 12. Glossaire

- **Test E2E** : scénario Playwright (`test()`), entité `e2e_test_id`.
- **Référentiel E2E** : registre central `e2e_tests`, reflet des spec files.
- **Exécution E2E** : passage CI d'un test (`e2e_executions`), avec preuves.
- **Preuve** : artefact rattaché à une exécution (rapport texte partagé ; vidéo
  humaine).
- **Couverture E2E** : scénarios exécutés et passés / scénarios prévus pour la
  demande (fonctionnel, pas de code).
