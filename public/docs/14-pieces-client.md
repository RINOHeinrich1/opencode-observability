# 14 — Pièces client par projet

> **ADR-001 (item 4)** — Les **pièces client** sont la **matière première des sprints** :
> l'agent de session sprint en extrait les **fonctionnalités** (`US-xxx`) et les
> **règles métier** (`RM-xxxx`). Ce document décrit les natures admises, la garde
> photo/vidéo, la requalification des documents ADR-12, l'émergence et le traçage.
>
> Implémentation : MCP `task-orchestrator` (`db.mjs`, `index.mjs`), script
> `requalify-pieces-client.mjs`, panneau `orchestrator-panel` (`pilot.mjs`,
> `server.mjs`, `public/app.js`).

## 1. Modèle : une pièce = un artefact

Une pièce client est un **artefact** de la table polymorphe `artifacts`
(cf. [`nomenclature-doc-type.md`](./nomenclature-doc-type.md)) :

| Champ | Valeur |
|-------|--------|
| `doc_type` | `piece` |
| `content_id` | **`projectId`** (le projet est l'entité porteuse — traçage par projet) |
| `kind` | `autre` |
| `source` | `import` (fichier stocké) \| `ref` (lien externe / chemin référencé) |
| `path` | chemin du fichier importé **ou URL du lien** |
| `meta` (JSONB) | `piece_nature`, `url`, `filename`, `emergent`, `emergent_origin`, `sprint_id`, `security_note` |

Le rattachement projet est aussi posé dans `artifact_projects` (N:N), ce qui rend
la pièce visible par les lectures existantes du gestionnaire central d'artefacts.

## 2. Natures admises (et refusées)

| Nature | Définition | Extensions |
|--------|-----------|------------|
| `markdown` | Document texte markdown. | `.md`, `.markdown` |
| `pdf` | Document PDF. | `.pdf` |
| `docx` | Document Word. | `.docx` |
| `lien` | **Lien externe public** (ex. Google Drive), mis en **public** par l'utilisateur ; l'agent lit le contenu via l'URL. | URL `http(s)` |

**PHOTO et VIDÉO sont REFUSÉES**, à l'import **et** pour les liens externes :

- extensions photo refusées : `.jpg .jpeg .png .gif .webp .heic .bmp .tiff` ;
- extensions vidéo refusées : `.mp4 .mov .avi .mkv .webm .m4v` ;
- hôtes vidéo connus refusés pour les liens : `youtube.com`, `youtu.be`,
  `vimeo.com`, `dailymotion.com`, `twitch.tv`, `tiktok.com`.

La garde est **autoritative côté MCP** (`assertPieceAllowed`, `db.mjs`) et
**dupliquée côté panneau** (`pilot.mjs`) en **défense en profondeur**, appelée
**avant toute écriture disque** (la route `POST /api/pieces` refuse en HTTP 400
sans écrire de fichier).

## 3. ⚠️ Limite de sécurité du lien Drive public

> **Dans un premier temps, le lien Drive est mis en PUBLIC par l'utilisateur.**
> L'URL est directement accessible : **toute personne qui la possède accède au
> contenu**. C'est un **risque de sécurité assumé** (ADR-001), le temps qu'un
> mécanisme plus strict soit décidé.

Conséquences opérationnelles :

- **ne jamais** déposer de contenu sensible (données personnelles, secrets,
  contrats confidentiels) derrière un lien public ;
- l'URL est stockée dans `meta.url` **et** dans `path` (localisation), et
  affichée dans le panneau avec un **avertissement** ;
- un mécanisme d'accès restreint (compte de service, URL signée, partage ciblé)
  est prévu **ultérieurement** — la pièce reste un lien, seul le mode d'accès
  changera.

## 4. Requalification SANS PERTE des documents ADR-12

Les documents ADR-12 existants (`adr`, `specs`, `gherkin`, `project_doc`) sont
**CONSERVÉS** et **requalifiés** en pièces client du projet : ils deviennent une
**source** (matière première), et **plus une référence normative exclusive**.

La requalification (`requalifyDocsAsPieces` / tool `piece_requalify` / script
`requalify-pieces-client.mjs`) :

- n'écrit **que** `meta` : `piece_client=true`, `piece_nature`, `requalified_at`,
  `requalified_from_doc_type` ;
- **ne change jamais** `doc_type`, `content_id`, `path`, ni les liens
  `artifact_projects` / `artifact_repos` ;
- **ne supprime rien** (le modèle ADR et `doc_list` / `doc_get` / `adr_list`
  restent intacts) ;
- est **idempotente** (un second passage requalifie 0 document).

Exécution opérationnelle :

```bash
node /root/.config/opencode/scripts/requalify-pieces-client.mjs --project <projectId>
node /root/.config/opencode/scripts/requalify-pieces-client.mjs --all
```

## 5. Émergence (pièce reçue après l'initialisation d'un sprint)

À l'ajout d'une pièce, le MCP détecte l'état de sprint du projet
(`detectOpenSprint`, table `sprints`) :

| Situation | `meta.emergent` | `meta.emergent_origin` | `sprint_id` | lien `sprint_pieces` |
|-----------|-----------------|------------------------|-------------|----------------------|
| Aucun sprint | `false` | — | — | — |
| Sprint ouvert | `true` | `apres_init_sprint` | sprint ouvert | posé |
| Dernier sprint clôturé | `true` | `apres_cloture` | dernier sprint | posé |

Le marquage est **tracé et NON bloquant** : une pièce émergente est toujours
acceptée (aucune exception levée). Elle est signalée dans le panneau
(badge « émergente »).

## 6. Tools MCP

| Tool | Rôle |
|------|------|
| `piece_add` | Ajoute une pièce (`projectId`, `nature?`, `title?`, `path?`, `url?`, `filename?`). Garde photo/vidéo incluse. |
| `piece_list` | Liste les pièces d'un projet (nouvelles + docs requalifiés). Filtres `nature`, `emergent`, `includeRequalified`. |
| `piece_requalify` | Requalifie sans perte les docs ADR-12 (idempotent). |
| `piece_delete` | Retire une pièce (`doc_type='piece'` uniquement). |

## 7. Panneau (API + onglet)

| Route | Rôle |
|-------|------|
| `GET /api/pieces?projectId=&nature=&emergent=&includeRequalified=` | Liste unifiée des pièces d'un projet. |
| `POST /api/pieces` | Ajout : import (`filename`+`dataBase64` → `storage/pieces`), lien (`url`) ou chemin (`path`). Garde photo/vidéo **avant écriture**. |
| `DELETE /api/pieces/:id` | Retire une pièce. |
| `GET /api/pieces/file?path=` | Télécharge un fichier de pièce **importé** (restreint à `storage/pieces`). |

Onglet **« Pièces client »** (modale *Détail projet*) : liste les pièces avec
nature, émergence, URL Drive (+ avertissement de sécurité) et permet d'ajouter /
supprimer / télécharger.

## 8. Tests E2E

**NA** — le comportement est interne (MCP + panneau), non observable par un
parcours Playwright (aucun `playwright.config.*` dans les repos concernés).
Vérification par appels MCP (`piece_add` refus photo/vidéo, `piece_list`,
`piece_requalify`) et par l'onglet panneau.
