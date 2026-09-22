# 17 — Convention de nommage du stockage (`storage/`) (v0.9.74)

> **FR** — Décision et **convention de nommage des dossiers racines de stockage**
> du panneau (`/root/orchestrator-panel/storage/`) : alignement sur la
> nomenclature **ADR-004** (« Cadrage technique » = `CT-*` / « Recette » =
> `RECT-*`). Renommage des racines historiques `evaluation-*` et de l'ancienne
> racine `recette-docs` (qui portait en réalité les documents de **cadrage**).
> **EN** — Storage root folders naming convention aligned on ADR-004.
>
> Décision d'architecture : **ADR-004** (`doc-mucrrj8i-1t7q`, **Accepté**) —
> « Nomenclature et modèle de données : Cadrage technique (`CT-*`) et Recette
> (`RECT-*`) ». Complète [`05-reference.md`](05-reference.md) et
> [`06-versioning.md`](06-versioning.md).

## 1. Décision tracée — renommer les dossiers racines

Le **point 4 du suivi ADR-004** a révisé le report acté lors de la livraison
précédente (qui conservait les répertoires runtime `storage/evaluation-*` et
`storage/recette-docs` « au nom historique »). Ce report est aujourd'hui
**trompeur** :

- `storage/recette-docs/` contenait en réalité les documents d'un **CADRAGE**
  (`pilot.mjs` → `addCadrageDocument`) ;
- `storage/evaluation-docs/` contenait les pièces binaires d'une **RECETTE**
  (`pilot.mjs` → `addRecetteDocument`).

**Décision** (validation humaine) : **renommer** les quatre dossiers racines pour
porter le nom de l'objet réellement stocké, puis **aligner le code** des deux
dépôts (panneau + MCP) qui référence ces chemins.

| Racine historique | Contenu réel | Racine cible | Référencée par (code) |
|---|---|---|---|
| `storage/recette-docs/` | documents de **cadrage** (`cadrage_doc`) | **`storage/cadrage-docs/`** | `pilot.mjs` (`addCadrageDocument`) |
| `storage/evaluation-docs/` | pièces binaires de **recette** (`recette_doc`) | **`storage/recette-docs/`** | `server.mjs` (`RECETTE_DOC_DIR`), `pilot.mjs` (`addRecetteDocument`) |
| `storage/evaluation-maquettes/` | **maquettes** de recette (`recette_doc`/maquette) | **`storage/recette-maquettes/`** | `server.mjs` (`RECETTE_MAQUETTE_DIR`), MCP `db.mjs` (`RECETTE_MAQUETTE_DIR`) |
| `storage/evaluation-perf/` | rapports/jobs de **performance** de recette | **`storage/recette-perf/`** | `server.mjs` (`RECETTE_PERF_DIR`), MCP `index.mjs` (`RECETTE_PERF_DIR`) |

Racines **inchangées** (hors périmètre ADR-004) :

| Racine | Contenu | Remarque |
|---|---|---|
| `storage/ref-docs/` | documents de référence (ADR-12) | inchangé |
| `storage/e2e/` | runs E2E (`EXE-*`) | inchangé (hors nomenclature ADR-004) |

## 2. Ordre de renommage IMPOSÉ (anti-collision)

Le renommage `evaluation-docs → recette-docs` **entre en collision** avec
l'ancienne racine `recette-docs`. L'ordre suivant est donc **obligatoire** :

1. `recette-docs` → **`cadrage-docs`** ;
2. `evaluation-docs` → **`recette-docs`** ;
3. `evaluation-maquettes` → **`recette-maquettes`** ;
4. `evaluation-perf` → **`recette-perf`**.

Le script `scripts/rename-storage-roots.mjs` applique cet ordre et refuse toute
exécution qui le violerait (idempotent : une racine déjà renommée est ignorée).

## 3. Arborescence cible de `storage/`

```
storage/
├── cadrage-docs/        # documents de cadrage technique (cadrage_doc / cadrage_report)
├── recette-docs/        # pièces binaires de recette évaluateur (recette_doc)
├── recette-maquettes/   # maquettes HTML/CSS/JS servies par le panneau (recette_doc/maquette)
├── recette-perf/        # rapports + jobs de tests standard (performance)
│   └── jobs/
├── ref-docs/            # documents de référence projets/repos (ADR-12) — inchangé
└── e2e/                 # runs E2E Playwright (inbox/ runs/) — inchangé
```

## 4. Règle de nommage des identifiants

Les **identifiants** des objets de premier niveau sont actés par ADR-004 :

| Objet | Préfixe | Exemple |
|---|---|---|
| Cadrage technique | `CT-*` | `CT-mtmoh3k0-wz17` |
| Recette (évaluateur) | `RECT-*` | `RECT-mucugeoc-xajc` |
| Exécution E2E | `EXE-*` | — |

Correspondance historique (migration ADR-004, conservée pour la traçabilité) :

| Objet | Ancien préfixe | Nouveau préfixe |
|---|---|---|
| Cadrage technique | `RECT-*` | `CT-*` |
| Recette (évaluateur) | `EVAL-*` | `RECT-*` |

**Nommage des fichiers** dans les racines de stockage :
`<id>-<timestamp-ms>-<libellé-assaini>.<ext>` (ex.
`CT-mtmoh3k0-wz17-1788510942713-revue-scenarios-e2e.md`). Le renommage des
**fichiers** portant un ancien identifiant (et l'alignement des `artifacts.path`
/ `meta.url` associés) relève du plan frère « renommer-stockage-ids »
(`scripts/migrate-nomenclature-stockage.mjs`, `--align-paths`).

## 5. Variables d'environnement

Les nouvelles variables deviennent **canoniques** ; les anciennes sont conservées
en **fallback** le temps d'une release (transition) :

| Variable canonique | Fallback legacy (transition) | Usage |
|---|---|---|
| `RECETTE_MAQUETTE_DIR` | `EVALUATION_MAQUETTE_DIR` | maquettes de recette (panneau **et** MCP — même chemin) |
| `RECETTE_PERF_DIR` | `EVALUATION_PERF_DIR` | rapports/jobs de performance (panneau **et** MCP) |

Sans variable d'environnement, le défaut est
`/root/orchestrator-panel/storage/recette-maquettes` (resp. `…/recette-perf`).

## 6. Outil de migration — `scripts/rename-storage-roots.mjs`

Script **idempotent**, **réversible** (`--revert`), **audité** (journal JSON) et
**`--dry-run` par défaut** (patron `scripts/migrate-user-role.mjs`) :

```bash
node scripts/rename-storage-roots.mjs            # dry-run (défaut) : planifie, n'écrit rien
node scripts/rename-storage-roots.mjs --json     # dry-run + sortie JSON
node scripts/rename-storage-roots.mjs --apply    # renomme (ordre imposé) — décision humaine
node scripts/rename-storage-roots.mjs --revert   # renomme en sens inverse
```

Aucune suppression : uniquement des `fs.rename`. Le journal d'audit est écrit sous
`storage/.rename-storage-roots/audit-<horodatage>.json` (hors versioning).

## 7. Fenêtre de maintenance

Le renommage des racines **et** l'alignement du code doivent être **déployés
ensemble** (redémarrage du panneau) : un déploiement partiel casserait le service
(404 sur les maquettes / pièces). Le redémarrage est un **acte d'orchestration**
(jamais déclenché par le script).
