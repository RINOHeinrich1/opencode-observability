# 15 — Statuts des Fonctionnalités & Règles métier (v0.9.69)

> **FR** — Modèle de statut **non ambigu** du référentiel Fonctionnalités /
> Règles métier : une **fonctionnalité** expose **trois axes** distincts
> (**Intégration**, **Tests E2E**, **Statut de développement**) + les **verdicts
> d'évaluation** en lecture seule ; une **règle métier** expose un **statut de
> RESPECT** (distinct d'un statut de développement). **EN** — Unambiguous status
> model for the Features / Business rules referential.

Ce document est le **garde-fou sémantique** : il fixe la **séparation des axes**
pour éviter toute re-fusion ultérieure. Il complète
[`05-reference.md`](05-reference.md) (modèle de données + familles MCP) et
[`03-workflow.md`](03-workflow.md) (recette évaluateur).

## 1. Pourquoi — le statut historique était ambigu

Le référentiel n'exposait qu'un **« État »** (implémentée / émergente), jugé
**ambigu** (« on a juste État »). Or plusieurs notions distinctes coexistent :

| Notion | Question à laquelle elle répond | Nature |
|---|---|---|
| **Intégration** | La fonctionnalité est-elle implémentée, et **par qui** (écosystème ou hors écosystème) ? | Fait de rattachement |
| **Tests E2E** | Quels **scénarios E2E** couvrent le comportement (1..N) ? | Preuve liée |
| **Statut de développement** | Où en est le **code** (complet / partiel / non démarré / incohérent) ? | **Analyse du code** |
| **Verdict d'évaluation** | L'**évaluateur produit** juge-t-il le comportement conforme ? | **Conformité produit** |
| **Respect** (règle) | La règle métier est-elle **respectée** ou non ? | **Respect** |

Ces notions sont **indépendantes** : elles ne doivent **jamais** être fusionnées
dans un champ unique.

## 2. Les axes d'une FONCTIONNALITÉ

### 2.1 Axe 1 — Intégration (`implemented` / `implemented_origin`)

**Réutilisation de l'existant** (aucune colonne dupliquée) : l'axe « Intégration »
est porté par `fonctionnalites.implemented` (`0`/`1`) et
`implemented_origin` ∈ `{ ecosystem, hors_ecosystem }`, avec traçabilité
`implemented_at` / `implemented_by` / `implemented_note`.

- `ecosystem` : implémentée par une/des **tâche(s) de l'écosystème**.
- `hors_ecosystem` : implémentée **en dehors** de l'écosystème (IDE/agents des
  devs), **sans** tâche liée.
- `implemented = 0` : **non implémentée**.

> L'UI et les docs **renomment** cet axe « **Intégration** » (l'ancien libellé
> « État » disparaît des tables). Le **filtre** existant reste inchangé.

### 2.2 Axe 2 — Tests E2E (`gherkinTests`)

Les tests E2E liés proviennent de la table de liens **`fonctionnalite_gherkin`**
→ `e2e_tests` (les scénarios Gherkin vivent dans `e2e_tests.gherkin`, ADR-003).
Une fonctionnalité peut être associée à **1..N** tests.

- **Lecture bulk** : `feature_list` expose `gherkinTests`
  (`[{ e2eTestId, title, status }]`) en **UNE requête** (`= ANY($1::text[])`) —
  **0 N+1**.
- **Détail** : `feature_get` expose `gherkin` (scénario + statut + Gherkin).
- **UI** : colonne « **Tests E2E** » avec **un lien cliquable par test**
  (`data-fr-e2e` → modale de détail du test).

### 2.3 Axe 3 — Statut de développement (`devStatus`)

**Issu de l'ANALYSE DU CODE**, porté par 5 colonnes additives sur
`fonctionnalites` :

| Colonne | Rôle |
|---|---|
| `dev_status` | `complet` \| `non_demarre` \| `partiel` \| `incoherent` (`NULL` = non évalué) |
| `dev_status_source` | **Qui alimente** le statut : `analyse_code` \| `evaluateur` \| `agent` \| `humain` |
| `dev_status_note` | Motif / note libre |
| `dev_status_at` | Horodatage de la qualification |
| `dev_status_by` | Acteur de la qualification |

**Vocabulaires validés à l'écriture** (source unique : constantes `db.mjs`
`DEV_STATUSES` / `DEV_STATUS_SOURCES`). La **source est OBLIGATOIRE** pour poser
un statut → **jamais de statut orphelin non tracé** (vigilance de la décision de
recette).

> **`incoherent` réutilise le signal évaluateur** `e2e_tests.status='INCOHERENT'`
> (ADR-003) comme **source** : le lien est **documentaire / lecture**, jamais une
> **écriture croisée** sur `e2e_tests`.

### 2.4 Verdicts d'évaluation (`evaluationVerdicts`) — LECTURE SEULE

Les **verdicts de la recette évaluateur** (`conforme` / `non_conforme` /
`a_ameliorer`) sont **portés par le lien** `recette_fonctionnalites` (ADR-001),
**au niveau des fonctionnalités**. `feature_get` les expose en **LECTURE SEULE**
sous `evaluationVerdicts` :

```
evaluationVerdicts: [{ evaluationId, title, status, verdict, verdictComment }]
```

> **AXE STRICTEMENT DISTINCT** du statut de développement : le verdict juge la
> **conformité produit**, le statut de développement décrit l'**état du code**.
> `evaluationVerdicts` **n'écrit jamais** `fonctionnalites.*` et **ne se substitue
> pas** au statut de développement.

### 2.5 Axe distinct — Émergence (inchangé)

`emergent` / `emergent_origin` restent un axe **inchangé** : aucun de ces statuts
ne l'écrit.

## 3. Le statut d'une RÈGLE MÉTIER — RESPECT

Une règle métier ne porte **pas** de statut de développement : elle porte un
**statut de RESPECT** (le **respect** de la règle), sur 4 colonnes additives de
`regles_metier` :

| Colonne | Rôle |
|---|---|
| `respect_status` | `respectee` \| `non_respectee` (`NULL` = non évalué) |
| `respect_status_note` | Motif / note libre |
| `respect_status_at` | Horodatage |
| `respect_status_by` | Acteur |

L'axe d'**implémentation** (`implemented` / `implemented_origin`) reste disponible
sur les règles (modèle symétrique), mais il est **distinct** du **respect**.

## 4. Contrat de lecture (MCP)

| Entité | Champs de statut |
|---|---|
| Fonctionnalité | `implemented` / `implementedOrigin` (**Intégration**), `gherkinTests` (**Tests E2E** 1..N), `devStatus` / `devStatusSource` / `devStatusNote` / `devStatusAt` / `devStatusBy` (**Développement**), `evaluationVerdicts` (lecture seule, **axe distinct**) |
| Règle métier | `implemented` / `implementedOrigin`, `respectStatus` / `respectStatusNote` / `respectStatusAt` / `respectStatusBy` (**Respect**) |

**Écriture** : `feature_update` / `rule_update` (champs fournis uniquement) +
raccourcis explicites **`feature_dev_status_set`** / **`rule_respect_status_set`**.

## 5. Règles d'écriture (registre)

- **Champs fournis uniquement** : un `updateFeature`/`updateRule` partiel ne
  touche que les champs transmis.
- **Statut vide** (`""`/`null`) ⇒ **déqualification** (reset complet de l'axe +
  traçabilité).
- **`devStatus` posé ⇒ `devStatusSource` requis** (sinon erreur explicite).
- **Vocabulaires stricts** : toute valeur hors vocabulaire ⇒ erreur.
- **Idempotent** : re-qualifier écrase proprement (`*_at` re-stampé).
- **Migration additive** : `ADD COLUMN IF NOT EXISTS` dans `migrate()` **et**
  `schema.sql`, `SCHEMA_VERSION` bumpé (`2026-09-22-feature-rule-statuses`).
  Valeurs `NULL` = « non évalué » — **aucune donnée altérée**.

## 6. Panneau (UI)

- **Sous-onglet Fonctionnalités** : colonnes **Intégration** | **Développement**
  | **Tests E2E** (liens cliquables), filtres `fr-f-dev` (statut de développement)
  et `fr-f-impl` (intégration).
- **Sous-onglet Règles métier** : colonne **Respect** (remplace « État »), filtre
  `fr-r-respect`.
- **Modales** création/édition : statut de développement (+ source + note) et
  statut de respect (+ note) ; **modales détail** : axes + verdicts d'évaluation
  (lecture seule, distinction visible).

## 7. Non-régression

`scripts/test-feature-rule-statuses.mjs` (repo
`opencode-mcp-task-orchestrator`, **base PostgreSQL jetable**) : pose /
validation / effacement des statuts, **source obligatoire**, **rétrocompatibilité
stricte** de `implemented` (les axes sont indépendants), exposition
`gherkinTests` (bulk) et `evaluationVerdicts` (lecture seule).

## Voir aussi

- [`05-reference.md`](05-reference.md) — modèle de données, familles MCP.
- [`03-workflow.md`](03-workflow.md) — recette évaluateur, distinction verdict ↔
  statut de développement.
- [`02-composants.md`](02-composants.md) — onglet Fonctionnalités & Règles.
- [`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) — ADR structurées.
