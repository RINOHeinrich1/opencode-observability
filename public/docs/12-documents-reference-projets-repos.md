# 12 — Documents de référence projets/repos (ADR technique, specs fonctionnelles, scénarios Gherkin)

> **Statut : VALIDÉ (2026-09-06).**
> Un projet peut être associé à **un ou plusieurs documents de référence**, de
> même qu'un repo. Il n'y a PAS de contenu en base : un document est un **chemin
> de fichier** (workspace Coder / checkout) que les agents LISENT en contexte
> (test-agent à la création d'un test E2E, agent-cadrage en début de cadrage).

---

## 1. Le besoin

Créer / vérifier un test E2E sans le contexte du projet est aveugle :
- **architecture** inconnue → le test-agent ne sait pas où le spec vit, quels
  composants sont en jeu, quelle structure de dossiers est cible ;
- **spécifications fonctionnelles** inconnues (User stories + règles métier) →
  impossible de savoir si le comportement couvert est le bon ;
- **scénarios Gherkin** existants inconnus → risque de doublons ou de scénarios
  qui contredisent la couverture.

## 2. Modèle

```
DOCUMENT de référence  (kind, titre, chemin)   ── N:N ──▶ PROJET (produit)
                                                   N:N ──▶ REPO (dépôt de code)
```

**Stockage** : ces documents sont des artefacts de la table **polymorphe
`artifacts`** — `doc_type` ∈ {`adr`, `specs`, `gherkin`, `project_doc`},
`content_id` = identifiant du document (`docId`), `kind` = **nature**
(`autre` pour cette famille). Les rattachements N:N sont portés par
**`artifact_projects`** / **`artifact_repos`** (qui remplacent
`doc_projects` / `doc_repos`). Le fichier est lu **au chemin indiqué** par
l'agent — jamais stocké/copié en base. Voir
[`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §4 et la taxonomie dans
[`nomenclature-doc-type.md`](nomenclature-doc-type.md).

### Kinds (vocabulaire)
- `adr-tech` — **Architecture technique** du projet/repo : stack, architectures
  cibles, composants, design patterns s'ils existent, structure de dossiers
  cible. (Un fichier par projet et par repo — « l'ADR » du projet.)
- `specs-fonctionnelles` — User stories + règles métier.
- `scenarios-gherkin` — scénarios Gherkin (parcours couverts / à couvrir).

> **Multi-fichiers par kind (décision conservée)** : le modèle est **générique**
> (`doc_projects`/`doc_repos` en N:N) et permet **1..N documents par kind** pour un
> projet/repo. Aujourd'hui madatalk a 1 fichier par kind, mais un kind pourra
> accueillir plusieurs fichiers (ex. plusieurs ADR, specs par périmètre, plusieurs
> fichiers `.feature`) sans changement de schéma. C'est pourquoi l'UI regroupe
> toujours par **catégorie** avec chaque document cochable individuellement.

Un projet peut être associé à un ou plusieurs ADR (le sien + ceux de ses repos) ;
un repo peut être associé à son ADR.

### Couverture E2E vs scénarios
Le Gherkin d'un projet porte une **matrice de couverture E2E** (§0 des scénarios
Gherkin madatalk) reliant chaque test E2E **actif** du registre (`e2e_tests`) à un
scénario marqué `[E2E couvert]` ; les autres scénarios sont `[E2E — à implémenter]`.
La **vérité opérationnelle** (statut ACTIVE/FAIL/date) reste dans le registre E2E —
le document ne porte que des liens stables scénario ↔ test, pas d'état volatile.

## 3. Où ces chemins sont-ils fournis en contexte ?

Les documents sont **fournis en contexte aux agents**, paramétrables par cases à
cocher au lancement :

1. **Création / MAJ d'un test E2E** (session test-agent) : la modale propose un
   **sélecteur ADR multi-lignes** (ADR du projet + de ses repos, toutes cochées par
   défaut) → bloc **« ADR de référence »** injecté dans le prompt de session ; le
   test-agent **lit** les fichiers ADR avant d'écrire le spec. Les documents
   ADR-12 (specs/Gherkin) restent consultables via `doc_list`.
2. **Cadrage** (session agent-cadrage) : à la création d'un cadrage, **trois
   sélecteurs de contexte** multi-lignes (toutes les options cochées par défaut) —
   **ADR** (`adrIds`), **Fonctionnalités** (`featureIds`) et **Règles métier**
   (`ruleIds`). Les sélections sont **rattachées au cadrage**
   (`cadrage_adr` / `cadrage_fonctionnalites` / `cadrage_regles`) et injectées dans
   le prompt (blocs « ADR de référence » / « Fonctionnalités de référence » /
   « Règles métier de référence ») ; l'agent-cadrage les lit pour confronter le
   constat réel à l'architecture et aux règles. Il peut aussi les consulter via
   `adr_list` / `feature_list` / `rule_list`.

## 4. MCP / données

- `doc_register({ kind, title, path, projectId?, repoId?, repoIds?, global? })`,
  `doc_update`, `doc_delete`, `doc_get`,
  `doc_list({ kind?, status?, projectId?, repoId?, includeRepoDocs })` — tous
  **rebasés sur la table polymorphe `artifacts`** (`doc_type` = `adr` | `specs` |
  `gherkin` | `project_doc`).
- Famille ADR **structurée** (sur-ensemble, mêmes données) :
  `adr_list` / `adr_get` / `adr_search` / `adr_context` (lecture),
  `adr_register` / `adr_set_status` / `adr_update` / `adr_attach` (cycle de vie),
  `adr_report_conflict` / `adr_report_missing` / `adr_vigilance_list` /
  `adr_vigilance_resolve` (signalement & vigilances) — voir
  [`13-adr-et-artefacts.md`](13-adr-et-artefacts.md) §2.
- `project_list` / `project_get` → `projects[].docs` (docs du projet + de ses
  repos) ; `repo_get` / `repo_list` → `repos[].docs` ; `e2e_test_get` →
  `test.docs` (docs du projet du test).
- `cadrage_doc_add` accepte un `path` existant (les docs de référence sélectionnés
  y sont attachés ; stockés en `artifacts`, `doc_type` = `cadrage_doc` /
  `cadrage_report`).

## 5. Panel

- Onglet **Projets** : la gestion des documents de référence (ADR-12) passe
  désormais par les **pièces client** — onglet **Artefacts** ou onglet
  **Pièces client** de la modale « Détail projet » — et par l'onglet **ADR**
  pour les ADR. L'onglet « 📄 Docs de référence » de la modale projet a été
  retiré (doublon avec « Pièces client ») : la modale n'expose plus que
  **Projet / Repos / Pièces client**.
- Création de test via agent : **sélecteur ADR** multi-lignes (contexte
  « ADR de référence »).
- Création de recette : **sélecteurs ADR + Fonctionnalités + Règles métier**
  multi-lignes (contexte de l'`agent-cadrage`).

### Sélection du contexte (sélecteurs multi-lignes)

Dans la **création/MAJ de test E2E** (session test-agent), le contexte est le
**sélecteur ADR** (ADR du projet + repos, toutes cochées par défaut ; filtres
statut/repo + recherche). Dans la **création de recette**, trois sélecteurs —
**ADR**, **Fonctionnalités**, **Règles métier** — **tous cochés par défaut**.
Décocher une ligne l'exclut du contexte injecté dans le prompt de la session.

Les documents ADR-12 eux-mêmes (`doc_type` ∈ {`adr`, `specs`, `gherkin`,
`project_doc`}) restent enregistrables et consultables via `doc_*` ; les anciens
docs ont été **requalifiés en pièces client** (`piece_requalify`) et se gèrent via
l'onglet **Artefacts** / **Pièces client** du projet ou l'onglet **ADR**.

### Import depuis le PC (fichiers locaux)

Chaque doc peut être **importé depuis le PC de l'utilisateur** (bouton
« Importer depuis mon PC ») : le fichier (`.md`, `.markdown`, `.txt`,
`.feature`, `.adoc` — max 2 Mo) est **stocké côté serveur**
(`storage/ref-docs/`) puis enregistré comme doc de référence rattaché au projet
ou repo choisi. Le chemin stocké est fourni en contexte aux agents comme un
chemin « existant » (lecture directe) ; le panneau offre un **aperçu** du
contenu (`/api/docs/file?p=…`, rendu markdown/feature/texte). Le mode
« Référencer un chemin existant » reste disponible pour pointer un fichier déjà
présent dans le workspace/checkout.

## 6. Points de vigilance

- **Contenu jamais en base** : le chemin doit pointer un fichier réellement
  présent dans le workspace/checkout lu par l'agent (chemin absolu hôte ou
  `/home/coder/...`).
- **Un « ADR » ≠ ADR du framework** : `adr-tech` désigne l'architecture technique
  du produit (madatalk, oniria…), distinct des ADR 08-11 du framework
  d'orchestration.
- **Couverture : document ≠ registre** : la matrice de couverture du Gherkin est
  **contractuelle** (quels scénarios doivent être couverts / le sont par quel
  test) ; l'**état réel** (ACTIVE/OBSOLETE, PASS/FAIL, exécutions, date) se lit
  **uniquement dans le registre E2E** — ne pas dupliquer de statuts volatiles
  dans les documents.
- **Affichage « doublon »** : chaque document apparaît une fois en base, mais
  rattaché au projet ET au repo ; l'UI groupe par catégorie (en-tête) puis liste
  le(s) document(s) — le libellé de catégorie peut visuellement ressembler au
  titre du document (ce n'est pas un doublon).
- Le chemin est un **contexte**, pas une exigence de build : l'agent lit ce qui
  existe, signale un chemin mort (fichier absent) comme écart.
