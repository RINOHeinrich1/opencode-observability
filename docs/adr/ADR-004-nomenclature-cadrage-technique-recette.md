# ADR-004 — Nomenclature et modèle de données : « Cadrage technique » (`CT-*`) et « Recette » (`RECT-*`)

- **Statut** : Proposé
- **Date** : 2026-09-22
- **Projet** : ecosystem
- **Repos** : opencode-mcp-task-orchestrator, opencode-observability
- **Complète** : ADR-001 (séparation Recette / Cadrage technique), ADR-002 (rôles)

## Contexte

L'ADR-001 a séparé deux objets :

1. **Cadrage technique** — l'ancienne entité « Recette » : analyse (contexte + code réel + fonctionnalités/règles/ADR) produisant des **tâches techniques**. Réalisé par les **exécuteurs**.
2. **Recette** — évaluation produit par l'**évaluateur** : parcours évalué, recommandations/problèmes, verdicts au niveau des fonctionnalités. Non convertible en tâches.

La livraison (batch `BATCH-mucif34l-4w8l`) a laissé des **incohérences de nomenclature** :

- l'entité historique `recettes` (cadrage technique) génère des identifiants **`RECT-*`** alors que son libellé UI est « Cadrage technique » ;
- la nouvelle entité `evaluations` (recette) génère des identifiants **`EVAL-*`** alors que son libellé UI est « Recette » ;
- les contrats techniques (`tasks.recette_id`, `batches.recette_id`, `decisions kind='recette'`, outils `recette_*`, routes `/api/recettes*`) désignent le **cadrage technique**, ce qui entretient la confusion avec la recette de l'évaluateur.

Conséquence observée : un cadrage technique (`RECT-…`) n'apparaît pas dans l'onglet « Recette » (qui liste les évaluations) ; l'utilisateur cherche « sa recette » et ne la trouve pas.

## Décision

1. **Nomenclature des identifiants**
   - **Cadrage technique** → préfixe **`CT-*`** (ex. `CT-mucf1s9n-qdmv`).
   - **Recette (évaluateur)** → préfixe **`RECT-*`** (ex. `RECT-mucf1s9n-qdmv`).

2. **Objets de premier niveau distincts, chacun avec ses propres tables PostgreSQL et sa propre table d'éléments**

   | Objet | Table principale | Table d'éléments | Préfixe |
   |---|---|---|---|
   | **Cadrage technique** (exécuteur) | `cadrages` | `cadrage_items` — **éléments de cadrage** (convertis en tâches) | `CT-*` |
   | **Recette** (évaluateur) | `recettes` | `recette_items` — **éléments de recette** (recommandations / problèmes, jamais convertis en tâches) | `RECT-*` |

   Tables de liens propres à chaque objet : `cadrage_*` (fonctionnalités, règles, ADR, sprints, projets, tâches, documents, reprise d'éléments de recette) et `recette_*` (fonctionnalités, règles, pièces).

3. **Renommages à opérer** (l'existant est conservé le temps de la migration, alias pendant la transition)
   - `recettes` → **`cadrages`** ; `recette_items` → **`cadrage_items`** ; tables de liens `recette_*` → `cadrage_*` ; identifiants `RECT-*` existants → **`CT-*`**.
   - `evaluations` → **`recettes`** ; `evaluation_items` → **`recette_items`** ; tables de liens `evaluation_*` → `recette_*` ; identifiants `EVAL-*` existants → **`RECT-*`**.

4. **Contrats alignés**
   - `tasks.cadrage_id` / `batches.cadrage_id` (ex-`recette_id`) pour le cadrage technique ; `decisions.kind='cadrage'` (ex-`'recette'`).
   - Outils MCP canoniques `cadrage_*` (les alias `recette_*` historiques restent le temps de la transition) ; **route panneau canonique du cadrage = `/api/cadrages*` uniquement**.
     > **Collision résolue** : l'`/api/recettes*` NE peut PAS servir d'alias transitoire au cadrage — il devient la route **canonique de la recette** (évaluateur). L'alias `/api/recettes*` pour le cadrage est donc **supprimé**.
   - Côté recette : outils `recette_*` (ex-`evaluation_*`), routes `/api/recettes*` (ex-`/api/evaluations*`) — canoniques.

5. **Migration** : script idempotent, réversible, avec **table d'audit**, `--dry-run` par défaut (même patron que `migrate-user-role.mjs`). Les renommages de tables se font par `ALTER TABLE … RENAME` (préservation des données), les préfixes d'identifiants par `UPDATE` des clés + `UPDATE` des références.

## Conséquences

- **Clarté** : plus d'ambiguïté entre « cadrage technique » (`CT-*`) et « recette » (`RECT-*`) dans l'UI, les identifiants et les contrats.
- **Coût** : renommages de tables + mise à jour des routes/tools/UI/champs (`recette_id` → `cadrage_id`, `kind='recette'` → `'cadrage'`) ; fenêtre de transition avec alias.
- **Traçabilité** : la migration doit conserver l'historique (aucune perte) et être auditée ; les anciens identifiants sont conservés en correspondance.
- **Risque** : toute rupture de contrat (batch, décisions, tâches, artefacts `content_id`) doit être traitée dans la même livraison ; ne pas laisser de références orphelines.
