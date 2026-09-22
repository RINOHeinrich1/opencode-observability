# Nomenclature `doc_type` — gestionnaire central d'artefacts

> Référentiel **central partagé** (MCP `task-orchestrator` + panneau `orchestrator-panel`).
> Source de vérité de la taxonomie `doc_type` et du mapping de migration
> (tâche `T-20260920-162801-jxtr`, plan `Plan-artefacts-fusion-polymorphe-20260921-060112`).
> Accessible via `/docs/nomenclature-doc-type.md`.

## 1. Modèle polymorphe

Une **SEULE table** `artifacts` porte tous les artefacts. Elle est identifiée par le
couple **(`doc_type`, `content_id`)** :

| Colonne | Rôle |
|---------|------|
| `doc_type` | **Type d'artefact** (taxonomie ci-dessous, énumérée). |
| `content_id` | Identifiant de l'**entité porteuse** (taskId, cadrageId, recetteId, projectId, docId/artifactId). |
| `kind` | **NATURE** de l'artefact (`plan` \| `audit` \| `report` \| `autre`), **distincte** de `doc_type`. |
| `nature` | Liaison libre (« à quoi sert le document / comment l'exploiter » — cadrages). |
| `source` | Domaine d'origine : `import` \| `artifact` \| `registry` \| `ref`. |
| `meta` | **JSONB** — champs propres à une famille (ex. `{ "artifactId": … }`, `{ "targetDocId": … }`). |
| `artifact_id` | PK **stable** (ex. `ART-…`, `doc-…`, `att-…`, `ART-REC-…`) — jamais réattribuée. |
| `id` | IDENTITY (ordre d'insertion) — exposé en `documentId` entier pour la famille cadrage. |

**`content_type` est un nom RÉSERVÉ** (futur « type d'artefact ») : il n'est **jamais**
créé ni utilisé. Ne pas l'ajouter.

### Champs ADR structurés (préservés dans la table polymorphe)

`status` (Proposé \| Accepté \| Déprécié \| Remplacé), `context`, `decision`,
`consequences`, `replaced_by`, `is_global` restent des colonnes dédiées ; le
rattachement N:N ADR ↔ projet/repo est porté par `artifact_projects` /
`artifact_repos`.

## 2. Taxonomie `doc_type` (15 familles nommées + `autre`)

| `doc_type` | Définition | Exemple |
|------------|-----------|---------|
| `adr` | Décision d'architecture technique (ADR). | `docs.kind='adr-tech'` → `ADR — Architecture madatalk` |
| `specs` | Specs fonctionnelles / User stories / règles métier. | `docs.kind='specs-fonctionnelles'` |
| `gherkin` | Scénarios BDD. | `docs.kind='scenarios-gherkin'` |
| `project_doc` | Document générique du projet. | notes d'architecture diverses |
| `adr_file` | Fichier / annexe / pièce jointe d'une ADR. | `doc_attachments` (`source='registry'|'import'|'ref'`) |
| `plan` | Plan d'action atomique (`Plan-*.md`). | artefact tâche `kind='plan'` |
| `task_synthese` | Synthèse de tâche / de planification. | artefact `kind='report'` produit par `atomic-plan` |
| `task_report` | Rapport de fin de tâche. | rapport `build-notify` (`report-<scope>-<ts>.md`) |
| `audit_report` | Rapport d'audit d'architecture. | artefact tâche `kind='audit'` |
| `cadrage_report` | Rapport / constat de cadrage. | `recette_documents` (legacy) lié à un artefact `kind='report'` |
| `cadrage_doc` | Document d'appui de cadrage (importé ou lié, `nature` conservée). | `recette_documents` (legacy) importé |
| `recette_doc` | **Pièce** d'une recette évaluateur (lien/document/photo/vidéo/maquette/performance, `nature` conservée). `content_id = recetteId`. | `recette_doc_add` / `recette_maquette_add` / `recette_perf_run` |
| `e2e_report` | Rapport TEXTE de run E2E Playwright. | `e2e_executions.report_artifact_id` |
| `e2e_video` | Vidéo de preuve E2E (**preuve HUMAINE**, jamais analysée par l'IA). | `e2e_executions.video_url` / `storage/e2e` |
| `piece` | **Pièce client** d'un projet — **matière première des sprints** : `markdown` \| `pdf` \| `docx` \| `lien` externe public (Drive). `content_id = projectId`. | `piece_add` ; docs ADR-12 requalifiés (`meta.piece_client`) |
| `autre` | Type inconnu / non encore formalisé (**garde-fou**). | tout artefact non classé |

> Règle : toute **nouvelle** valeur passe **d'abord** par `autre`, puis est formalisée ici
> (et dans la constante `DOC_TYPES` de `db.mjs`). Ne jamais inventer une valeur hors liste.

## 3. Table de mapping 1:1 source → cible

| Source (legacy) | `doc_type` | `content_id` | `kind` | `nature` | `source` | `meta` |
|-----------------|-----------|--------------|--------|----------|----------|--------|
| `artifacts.kind='plan'` | `plan` | `task_id` | `plan` | — | `import` | — |
| `artifacts.kind='audit'` | `audit_report` | `task_id` | `audit` | — | `import` | — |
| `artifacts.kind='report'` | `task_report` | `task_id` | `report` | — | `import` | — |
| `artifacts.kind='autre'` | `autre` | `task_id` | `autre` | — | `import` | — |
| `recette_documents` (legacy, lié artefact `kind='report'`) | `cadrage_report` | `cadrage_id` | `report` | `nature` | `source` | `{ legacyId, artifactId }` |
| `recette_documents` (legacy, autre) | `cadrage_doc` | `cadrage_id` | `report` | `nature` | `source` | `{ legacyId, artifactId }` |
| `docs.kind='adr-tech'` | `adr` | `docs.id` | `autre` | — | `registry` | `meta` |
| `docs.kind='specs-fonctionnelles'` | `specs` | `docs.id` | `autre` | — | `registry` | `meta` |
| `docs.kind='scenarios-gherkin'` | `gherkin` | `docs.id` | `autre` | — | `registry` | `meta` |
| `doc_attachments` | `adr_file` | `doc_id` | `kind` | `nature` | `source` | `{ targetDocId }` |
| `e2e_executions.report_artifact_id` | `e2e_report` | `e2e_test_id` | `autre` | — | `artifact` | — |
| `e2e_executions.video_url` | `e2e_video` | `e2e_test_id` | `autre` | — | `artifact` | `{ videoUrl }` |
| **pièce client** (nouvelle) | `piece` | `projectId` | `autre` | — | `import` (fichier) \| `ref` (lien/URL) | `{ piece_nature, url, filename, emergent, emergent_origin, sprint_id, security_note }` |
| **doc ADR-12 requalifié** (pièce client) | **conservé** (`adr`/`specs`/`gherkin`/`project_doc`) | **conservé** (`docId`) | conservé (`autre`) | — | conservé (`registry`) | `+ { piece_client: true, piece_nature, requalified_at, requalified_from_doc_type }` |

## 4. Domaines `source`

| `source` | Sens |
|----------|------|
| `import` | Fichier importé (stocké sous `storage/ref-docs` pour les docs ; `storage/pieces` pour les pièces client). |
| `artifact` | Artefact du registre lié par `artifact_id`. |
| `registry` | Document du registre (ADR-12 : `path` pointe le fichier). |
| `ref` | Fichier référencé par chemin (workspace / checkout). |

## 5. Comportement `ON DELETE` par famille

`content_id` est **polymorphe, sans FK** : le nettoyage est assuré **côté code**, par famille.

| Famille | Déclencheur | Comportement |
|---------|-------------|--------------|
| **task** (`plan`, `task_synthese`, `task_report`, `audit_report`, `autre`) | `deleteTask(taskId)` | `DELETE FROM artifacts WHERE content_id = $1 AND doc_type = ANY(TASK_DOC_TYPES)` |
| **docs** (`adr`, `specs`, `gherkin`, `project_doc`, `adr_file`) | `deleteDoc(docId)` | Supprime l'artefact + ses pièces jointes (`adr_file` avec `content_id = docId`) + liens `artifact_projects`/`artifact_repos` (CASCADE) |
| **e2e** (`e2e_report`, `e2e_video`) | `updateE2EExecution` | Upsert idempotent par (`content_id`, `path`) — pas de suppression |
| **cadrage** (`cadrage_doc`, `cadrage_report`) | `removeCadrageDocument(documentId)` | `DELETE FROM artifacts WHERE id = $1 AND doc_type = ANY(CADRAGE_DOC_TYPES)` |
| **recette** (`recette_doc`) | `removeRecetteDocument(documentId)` | `DELETE FROM artifacts WHERE id = $1 AND doc_type = ANY(RECETTE_DOC_TYPES)` |
| **projet** (`project_doc`) | — | **Aucun chemin de suppression** aujourd'hui (pas de `deleteProject` nettoyant). Si un chemin est ajouté, il devra nettoyer cette famille. |
| **pièce client** (`piece`) | `removePiece(pieceId)` (`piece_delete`) | `DELETE FROM artifacts WHERE artifact_id = $1 AND doc_type = 'piece'` — les liens `artifact_projects` et `sprint_pieces` suivent en **CASCADE**. |

> **Pièces client & docs ADR-12 requalifiés** : la requalification (`piece_requalify` /
> `requalify-pieces-client.mjs`) **ne supprime rien** et **ne change pas** `doc_type`,
> `content_id`, `path` ni les liens : elle n'écrit qu'un marqueur dans `meta`
> (`piece_client`, `piece_nature`, `requalified_at`, `requalified_from_doc_type`).
> Un doc requalifié reste donc lisible par `doc_list` / `doc_get` / `adr_list`.

## 6. Rétrocompatibilité

- `artifact_list(taskId)` → `WHERE content_id = $1 AND doc_type = ANY(TASK_DOC_TYPES)` (4 agents + panneau).
- `cadrage_get` → `documents[]` conserve `documentId` **entier** (= `artifacts.id`).
- `doc_list(includeRepoDocs)` / `doc_get` / `doc_register` / `doc_update` / `adr_list` / `adr_get` : signatures **inchangées** (stockage unifié).
- Jointures E2E : `e2e_executions.report_artifact_id` et `video_url` pointent toujours un `artifact_id` **préservé** par la migration.
