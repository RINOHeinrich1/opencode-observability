# Changelog — Écosystème opencode

> Versionnage **semver** (`MAJOR.MINOR.PATCH`). Chaque version documente les
> évolutions du framework d'orchestration (agents, MCP, scripts, plugins,
> panneau, notifier). La version courante correspond à un tag git `vX.Y.Z` sur
> chaque dépôt de l'écosystème (voir `06-versioning.md`).

## v0.8.41 — 2026-09-04 · Recette + E2E : agent-recette vérifie et déclenche les tests

- agents v0.4.12 : agent-recette utilise e2e_list / e2e_execution_list
  (rapport TEXTE) pour confronter scénario E2E ↔ comportement réel des tâches
  couvertes ; signale les divergences en éléments avec référence ; peut
  déclencher un run via e2e_run. Jamais d'interprétation de vidéo.
- mcp v0.7.2 : outil e2e_run (runner E2E_EXTERNAL sur repoDir + import auto,
  creds compte de test dans /root/.config/opencode/e2e.env root-only).
- SPA madatalk : scaffold Playwright + spec login authentifié PASS (préprod) sur
  branche build-notify/e2e-playwright + workflow e2e.yml.

## v0.8.40 — 2026-09-04 · E2E : exécution directe, runner CI, lifecycle & docs (cadrage 07)

- Agents v0.4.11 : analyse d'impact E2E en exécution DIRECTE (sans atomic-plan)
  + trace événements E2E_* ; gate « pas de done sans E2E PASS ou NA justifié ».
- opencode-scripts v0.2.0 : e2e-runner.mjs (instance éphémère Playwright →
  manifest + vidéos pour le collecteur).
- Docs 07-tests-e2e.md : contrat du manifest CI + état d'implémentation.
- Statut E2E séparé du statut tâche ; vidéo = preuve humaine ; humain sollicité
  via decision_request (awaiting_validation) en cas d'échec non résolu.

## v0.8.39 — 2026-09-04 · Panel : badge E2E en table + lecteur vidéo + téléchargements

- Table des tâches : colonne « E2E » avec badge agrégé E2E ✓ / ✗ / … (ou — si
  aucun test associé) ; agrégat serveur (dernier statut par test lié).
- Détail tâche : lecteur vidéo INTÉGRÉ (0.25x/0.5x/1x/1.5x/2x) ; téléchargement
  d'une vidéo et de TOUTES les vidéos de la tâche en ZIP
  (GET /api/tasks/:id/e2e/videos.zip, CLI zip). Rapport texte toujours dispo.

## v0.8.38 — 2026-09-04 · Panel : section « Tests E2E » dans le détail de tâche

Affichage (lecture) des E2E associés à une tâche : id, scénario, spec file,
relation (créé/modifié/régression/existant), statut de la dernière exécution,
durée, itération (i/3), synthèse textuelle, boutons « Rapport (texte) » et
« ▶ Voir la vidéo » (stream restreint storage/e2e via /api/e2e/file). Rempli
async depuis GET /api/tasks/:id/e2e ; masqué si aucun test associé.

## v0.8.37 — 2026-09-04 · Tests E2E : collecteur hôte + lecture (début d'intégration cadrage 07)

Première tranche de l'intégration E2E (cadrage 07-tests-e2e.md) côté orchestration :
- MCP task-orchestrator v0.7.0 : registre e2e_tests (1/test()), liens task_e2e
  (N:N, relation+reason), exécutions e2e_executions (rapport texte partagé
  IA+humain, vidéo humaine) + outils e2e_test_register/link/unlink, e2e_list,
  e2e_execution_record/update/list.
- Panel : collecteur hôte pilot.collectE2EResults(runId) — importe un run CI
  (storage/e2e/inbox/<runId>/manifest.json + résultats) vers le registre,
  conserve rapports (texte) et vidéos (humain) sous storage/e2e/runs/ ;
  rétention mensuelle pruneE2EVideos(days).
- Endpoints : POST /api/e2e/collect, POST /api/e2e/prune (admin),
  GET /api/tasks/:id/e2e (tests + exécutions), GET /api/e2e/file (stream
  rapport/vidéo, accès restreint). .gitignore storage/e2e.

## v0.8.36 — 2026-09-02 · Recette : rattacher/détacher des tâches couvertes après création

- **MCP task-orchestrator v0.6.11** : outil `recette_unlink_task` ; garde sur
  `recette_link_task` — la tâche ajoutée doit appartenir à l'un des projets
  rattachés à la recette.
- **Panel v0.8.36** : endpoints `POST /api/recettes/:id/tasks` et
  `DELETE /api/recettes/:id/tasks/:taskId` ; modale de détail d'une recette non
  faite : **✕ retirer** sur chaque tâche couverte et sélecteur **« + Ajouter une
  tâche couverte… »** (candidates des projets rattachés, non déjà couvertes).

Dépôts : `opencode-observability` (v0.8.36) · `opencode-mcp-task-orchestrator`
(v0.6.11).

---

## v0.8.35 — 2026-09-02 · Recette : ajouter/retirer un projet rattaché à une recette existante

Suite multi-projets — gestion des projets **après création** :
- **MCP task-orchestrator v0.6.10** : outils `recette_project_add` /
  `recette_project_remove` (refus du dernier projet ; refus si la recette
  couvre encore des tâches de ce projet ; `recettes.project` legacy bascule sur
  le 1er projet restant).
- **Panel v0.8.35** : endpoints `POST /api/recettes/:id/projects` et
  `DELETE /api/recettes/:id/projects/:project` (pilot) ; dans la modale de
  détail d'une recette non faite : **ajouter** un projet (liste des projets
  connus non rattachés) et **retirer** un projet (×, masqué si un seul projet).

Dépôts : `opencode-observability` (v0.8.35) · `opencode-mcp-task-orchestrator`
(v0.6.10).

---

## v0.8.34 — 2026-09-02 · agent-recette : prompt multi-projets sans ambiguïté

Correctif de cohérence du prompt `agent-recette` (v0.4.9) après l'introduction
des recettes multi-projets : suppression des formulations mono-projet
contradictoires restantes (« rattaché à un PROJET »), alignement du contexte
(`recette_get` → `projects[]`, pas de projet principal), **projet cible** affiché
dans la liste consolidée de clôture, et règle de lecture FS bornée aux projets
couverts.

Dépôt : `opencode-agents` (v0.4.9) · docs `opencode-observability` (v0.8.34).

---

## v0.8.33 — 2026-09-02 · Recette multi-projets (1..N) + item rattaché à un projet

Une recette peut désormais être rattachée à **un ou plusieurs projets** (plus
aucun « projet principal » métier) et chaque élément relevé cible **un projet**
(celui où la tâche sera créée à la clôture).

- **MCP task-orchestrator v0.6.9** : table `recette_projects` (recette_id,
  project) + colonne `recette_items.project` ; `recette_start(projects≥1)`,
  `recette_item_add/update(project)`, retours enrichis (`projects`, items avec
  `project`) ; migration idempotente + backfill des recettes/items existants
  (projet legacy = 1er projet).
- **Panel v0.8.33** : création multi-projets **en une étape** (cocher les
  projets → « Charger les tâches disponibles » tous projets, tâches étiquetées
  par projet) ; puces projet sur les cartes recettes, détail, section recette du
  détail tâche et sur chaque item ; à la clôture chaque tâche est créée dans le
  **projet de son item** (fallback 1er projet) ; `/api/recettes/candidates`
  multi-projets (`?project=a&project=b`), liste/filtre recettes via
  `recette_projects`, détail enrichi.
- **Agent-recette v0.4.8** : `project` obligatoire par item (parmi les projets
  de la recette) ; prompt de session multi-projets (`buildRecettePrompt`).

Dépôts : `opencode-observability` (v0.8.33) · `opencode-mcp-task-orchestrator`
(v0.6.9) · `opencode-agents` (v0.4.8).

---

## v0.8.32 — 2026-09-02 · Décisions humaines « canal B » visibles et actionnables dans le panneau

Deux canaux de décision coexistaient mais étaient confondus : les **permissions
d'outil** (bash/edit…, `permission_id` présent, résolues **dans la session de
l'agent**) et les **décisions humaines « besoin »** (prérequis infra,
autorisations hors commande — demandées par un agent via `decision_request`,
**sans `permission_id`**). Les secondes, souvent typées `kind=permission`,
étaient **invisibles et non actionnables** (ni en session, ni au panneau).

Correctif — critère unique et fiable : **`awaiting` + `permission_id IS NULL`
+ `kind <> 'recette'`** =
« décision humaine actionnable » (canal B), quel que soit le `kind`.
- détail de tâche : la section « Validation (décisions en attente) » inclut
  désormais ces décisions (fini l'exclusion par `kind='permission'`) ;
- **onglet « Décisions humaines »** : colonne d'action (remarques + Approuver /
  Rejeter) sur les décisions canal B — l'onglet n'est plus lecture seule ;
- badge « ⏳ attente humaine » de la table des tâches étendu au canal B.
- Les permissions d'outil (`permission_id` présent) restent réservées à la
  session de l'agent (non actionnables au panneau).

Dépôt : `opencode-observability` (v0.8.32).

---

## v0.8.31 — 2026-09-02 · atomic-plan : exploration lecture seule sans friction headless

Correctif d'infrastructure suite au blocage de la planification
`T-20260903-115954-xrcy` (frontend SPA madatalk) : la décision enregistrée
comme « permission rejetée » était en réalité un **auto-deny du runtime
opencode** (fail-closed ~17 ms) sur une commande bash composée (segment
`xargs grep`) non couverte par les permissions d'atomic-plan, dans une
sous-session headless sans approbateur interactif.

- `opencode-agents` v0.4.7 : permissions bash lecture seule étendues
  (`xargs grep*`, `xargs -0 grep*`, `git ls-tree*`, `git cat-file*`,
  `git show-ref*`, `git for-each-ref*`, `node -e*`) + règle de conduite
  « privilégier read/grep/glob et les commandes simples ; éviter les pipelines
  composés » ;
- registre : événement `PERMISSION_CONTEXT_CORRECTED` tracé sur la tâche
  (auto-deny, pas un rejet humain).

Dépôts : `opencode-agents` (v0.4.7) · `opencode-observability` (docs v0.8.31).

---

## v0.8.30 — 2026-09-02 · Recettes : une recette = une session (boutons simplifiés) + cartes responsives

Suite au retour utilisateur sur la v0.8.28, l'UI recette est **simplifiée** :
- suppression des boutons « Continuer la session » et « Nouvelle session » ;
- **une recette = une session** : le bouton **« Session de la recette »** reprend
  la session en cours (ou en crée une la première fois) ; **« Terminer la
  recette »** clôture et reste bien visible quand la recette est `in_progress` ;
- **cartes recette responsives** : `.project-card-actions` passe en `flex-wrap`
  (et boutons pleine largeur empilés en mobile) — corrige le débordement qui
  pouvait masquer « Terminer la recette » et rendait le card non responsive.

L'option API `force` (nouvelle session explicite) reste disponible côté serveur,
simplement plus exposée dans l'interface.

Dépôt : `opencode-observability` (v0.8.30).

---

## v0.8.29 — 2026-09-02 · Onglet Tâches : pré-filtres « À recetter » et « Actif »

Deux filtres rapides (cases à cocher, cumulables en ET avec le filtre projet et
les tags de statuts) sur la table des tâches :
- **« À recetter »** : ne garde que les tâches dont la recette n'est pas faite
  (`recette_status != done`, inclut pending jamais recettées + legacy approved).
- **« Actif »** : ne garde que les tâches dont le statut d'exécution n'est pas
  `done` (tout statut intermédiaire ou terminal non-done : queued, in_progress,
  failed, aborted…).

Choix persistés (localStorage) et conservés après re-rendu (polling / retour
d'onglet) comme les autres filtres.

Dépôt : `opencode-observability` (v0.8.29).

---

## v0.8.28 — 2026-09-02 · Bouton « Session de la recette » : reprise systématique (fini les doublons)

Bug général corrigé : cliquer sur « Session de la recette » créait une **nouvelle
session à chaque clic** au lieu de continuer l'ancienne. Cause : la reprise
dépendait d'une détection `opencode session list` scopée au répertoire — or ce
répertoire (cwd du serveur au lancement) varie selon les redémarrages pm2 et le
`git_path` du projet peut être NULL (`mada-talk`) → faux négatif → nouvelle
session + écrasement de `recettes.session_id`.

Correctif :
- **reprise systématique** dès qu'une session `ses_…` est rattachée à la recette
  (plus aucun doublon automatique) ;
- bouton principal renommé **« Continuer la session »** quand une session existe ;
- nouveau bouton **« Nouvelle session »** (carte Recettes + section Recette du
  détail tâche) pour repartir de zéro explicitement (`POST …/session {force:true}`),
  l'ancienne session restant consultable.

Dépôt : `opencode-observability` (v0.8.28).

---

## v0.8.27 — 2026-09-02 · Onglet Tâches : filtre statut multi-valeurs (tag input)

Le combo « statut » à valeur unique est remplacé par un **filtre à valeurs
multiples** : des **puces (tags)** pour chaque statut affiché + un sélecteur
« + Ajouter… » pour en ajouter d'autres. La liste montre les tâches dont le
statut correspond à **l'un des statuts sélectionnés** (cumulable avec le filtre
projet). Chaque puce se retire d'un clic (×) ; bouton « tout afficher » pour
vider. Choix **persisté** (localStorage, conservé après re-rendu polling / retour
d'onglet) et **responsive** (le tag-input passe en pleine largeur et les puces
se répartissent sur plusieurs lignes en mobile).

Dépôt : `opencode-observability` (v0.8.27).

---

## v0.8.26 — 2026-09-02 · Onglet Tâches : filtres projet/statut conservés après re-rendu

Les filtres **projet** et **statut** de l'onglet Tâches étaient perdus à chaque
re-rendu de la liste (polling périodique, retour d'onglet navigateur via
`visibilitychange`). Ils sont désormais **persistés** (état + `localStorage`,
comme les cases « Grouper par recette / tâches parallèles ») et **restaurés**
après reconstruction des `<select>` ; l'option filtrée est conservée même si
aucune tâche ne correspond temporairement.

Dépôt : `opencode-observability` (v0.8.26).

---

## v0.8.25 — 2026-09-02 · Recette faite : bouton « Détail de la recette » (modal items lecture seule)

Quand une recette est **terminée** (`done`), le bouton « Terminer la recette »
disparaît (normal) — à la place un bouton **« Détail de la recette »** apparaît :
- dans la **section Recette** du détail de tâche (onglet Tâches) ;
- sur la **carte de l'onglet Recettes**.

Il ouvre le **même modal que « Terminer »** mais en **lecture seule** (aucune
action de clôture) : liste des items avec classification, ordre d'exécution,
badge ⚠ vigilance, lien `→ T-…` vers la tâche créée, contenu (« Voir en
entier »), critère d'acceptation, scope — plein écran et défilement conservés.
`finishRecetteModal` refactoré en `recetteItemsModal(recetteId, 'finish'|'detail')`.

Dépôt : `opencode-observability` (v0.8.25).

---

## v0.8.24 — 2026-09-02 · Recette : titre dans la table des tâches, ordre d'exécution, points de vigilance, modal de clôture complet

Les **4 améliorations recette** demandées :

1. **Titre de la recette** affiché dans la table des tâches : le groupement
   « Grouper par recette » affiche `Recette — <titre>` (au lieu de l'id
   technique `RECT-…`) quand la recette a un titre.
2. **Ordre d'exécution** par élément de recette (`recette_items.exec_order`) :
   l'agent-recette renseigne un **ordre numérique** (obligatoire) — éléments
   **indépendants = même numéro** (exécutables en **parallèle**), élément
   dépendant = numéro supérieur. Nouvelle option **« Grouper par tâches
   parallèles »** dans la table (sous-groupes « Ordre N » + mention du nombre
   d'exécutions parallèles) ; badge `ordre N` sur les tâches issues de recette.
3. **Point de vigilance** par élément (`recette_items.vigilance`) : l'agent-recette
   signale les écarts sémantiques / zones fragiles ; badge `⚠ vigilance` (avec
   le détail en infobulle) dans la table, le détail de tâche, le détail de
   recette et le modal de clôture.
4. **Modal « Terminer la recette »** amélioré : défilement interne, bouton
   **plein écran** ⛶, **« Voir en entier »** pour les contenus tronqués, détail
   complet non tronqué (contenu + critère + vigilance + scope), rendu mobile.

Dépôts : `opencode-observability` (v0.8.24) · `opencode-mcp-task-orchestrator`
(v0.6.8) · `opencode-agents` (v0.4.6).

---

## v0.8.6 — 2026-09-01 · Titres de recette dérivés des titres des tâches

Les recettes legacy (« Recette de T-… ») sont **retitrées** avec le **titre court de la tâche couverte** (préfixe « issu de la recette » retiré, tronqué à 60). La modale de détail affiche les **titres des tâches couvertes** (plus d'IDs seuls).

Dépôt : `opencode-observability`.

---

## v0.8.5 — 2026-09-01 · Recette : titre court affiché + description longue en modale

L'onglet Recettes affiche le **titre court** (plus d'ID barbare) ; cliquer dessus ouvre une **modale de détail** (description longue, projet, statut, tâches couvertes, éléments). Champ « description » ajouté à la création (recettes.description). Purge des recettes orphelines (transition v0.8.0).

Dépôts : `opencode-observability` (v0.8.5) · `opencode-mcp-task-orchestrator` (v0.6.3).

---

## v0.8.4 — 2026-09-01 · Documents dans la modale de création de recette

La modale « Nouvelle recette » permet de **rattacher des documents dès la création** (importer un fichier ou lier un artefact) avec la **nature de liaison**. Titre par défaut = nom du fichier importé.

Dépôt : `opencode-observability`.

---

## v0.8.3 — 2026-09-01 · Documents rattachés aux recettes (import / artefact + nature)

**Recettes** : on peut rattacher un document (importé par upload, ou lien vers un artefact existant) avec la **nature de la liaison** (à quoi sert / comment l'exploiter). Bouton « Documents » sur chaque recette ; visionneuse markdown ; retrait.

- MCP v0.6.2 : `recette_doc_add` / `recette_doc_remove`, `recette_get` renvoie les documents.
- Panneau v0.8.3 : upload (base64 → `storage/recette-docs/`), lien artefact, liste, Regarder (md), Retirer.
- Agent-recette v0.4.1 : exploite les documents de la recette.

---

## v0.8.2 — 2026-09-01 · Modification des tâches en statut queued

**UX** : bouton « Modifier » dans la modale Actions pour une tâche `queued` — édite titre court, demande, critère d'acceptation, scope, priorité (MCP `task_update`, refusé si la tâche n'est plus queued).

Dépôts : `opencode-observability` (v0.8.2) · `opencode-mcp-task-orchestrator` (v0.6.1).

---

## v0.8.1 — 2026-09-01 · Sélecteur de tâches non recettées (création de recette)

**UX** : plus de saisie d'IDs à la main — la modale « Nouvelle recette » liste les **tâches non encore recettées** du projet (titre court + id + statut, cases à cocher, liste défilante). Endpoint `GET /api/recettes/candidates?project=`.

Dépôt impacté : `opencode-observability`.

---

## v0.8.0 — 2026-09-01 · Recette = objet de projet (titre, 0..N tâches) + titre/critère des tâches

**Objectif** : la recette devient un **objet métier de premier niveau** rattaché
au **projet** (titre propre, session dédiée, historique propre), couvrant
**0..N tâches** — plus besoin d'une session de recette par tâche. Les tâches
portent désormais un **titre court** et un **critère d'acceptation**.

### Changements

- **MCP `task-orchestrator` (v0.6.0)** :
  - `recettes` = projet + titre (0..N tâches via `recette_tasks`) ; colonnes
    `tasks.title`, `tasks.recette_id` ; `recette_items.title`/`acceptance` ;
  - **plus d'auto-création** de recette par tâche à `done` ;
  - `recette_start(project, title, taskIds)` · `recette_list(project)` ·
    `recette_get` · `recette_link_task` · `recette_session_set` ;
  - `recette_confirm` marque **toutes les tâches couvertes** `recette_status='done'` ;
  - `task_register` accepte `title`, `recetteId` ; `acceptance_criteria`.
- **Panneau (v0.8.0)** :
  - nouvel onglet **« Recettes »** : créer (projet + titre + tâches 0..N),
    lister, session, terminer la recette (synthèse → confirmation → tâches) ;
  - formulaire tâche : **Titre** + **Critère d'acceptation** obligatoires ;
  - liste des tâches : affiche le titre court ;
  - section recette du détail = la recette couvrant la tâche.
- **Agent `agent-recette` (v0.4.0)** : contexte projet (recette_get, tâches
  couvertes), éléments avec titre court + critère d'acceptation + scope.
- **Migration** : recettes existantes → projet + titre dérivé + tâche couverte ;
  titres des tâches backfillés (dérivés de la demande).

### Dépôts impactés

`opencode-observability` (v0.8.0) · `opencode-mcp-task-orchestrator` (v0.6.0) ·
`opencode-agents` (v0.4.0).

---

## v0.7.7 — 2026-09-01 · Liste des tâches : groupement par recette

**Objectif** : dans l'onglet Tâches, pouvoir **grouper les tâches par recette**
(dépliable/repliable) pour voir d'un coup d'œil toutes les tâches générées par
chaque recette.

### Changements (`opencode-observability` v0.7.7)

- **`/api/tasks`** renvoie `recette_source` (tâche recette source) pour chaque
  tâche issue d'une recette (via `task_links` « Issu de la recette »).
- **Onglet Tâches** : case **« Grouper par recette »** → les tâches issues d'une
  recette sont regroupées sous un en-tête « Recette de <tâche> » (nb de tâches +
  classifications), **dépliable/repliable** ; les autres sous « Autres tâches ».
  Badge « recette » sur les tâches issues d'une recette.

### Dépôts impactés

`opencode-observability` (v0.7.7).

---

## v0.7.6 — 2026-09-01 · Docs opérationnelles synchronisées (état v0.7.5)

Synchronisation des docs de référence avec le framework recette et les évolutions
récentes (v0.6.0 → v0.7.5) :

- **01-architecture** : concept « Recette » mis à jour (opération distincte,
  session dédiée, éléments, nouvelles tâches).
- **02-composants** : agent `agent-recette` ajouté ; fonctions de pilotage
  (`launchRecetteSession`, `finishRecette`).
- **03-workflow** : cycle de vie avec phase recette (`pending/in_progress/done`),
  section « Recette = phase distincte », tâches liées (v0.6.0).
- **04-reproduction** : framework recette + agent-recette.
- **05-reference** : tables `task_links`, `recettes`, `recette_items` ;
  `recette_class`/`scope` sur tasks ; sémantique recette ; endpoint
  `/api/metrics/recette` ; miroir EN.

Dépôt impacté : `opencode-observability` (docs).

---

## v0.7.5 — 2026-09-01 · « Attente humaine » ne compte plus les décisions recette legacy

**Problème** : des tâches (ex. T-20260831-174431) affichaient encore le badge
« ⏳ attente humaine » alors que la recette était terminée — causé par des
**décisions `recette` legacy restées `awaiting`** (ancien flux
`decision_request(kind="recette")`, que la clôture v0.7 ne résolvait pas).

**Correctifs** :
- **Panneau (v0.7.5)** : `waiting_human` ne compte plus que les décisions
  `validation`/`review` (la recette est désormais suivie via la table
  `recettes`, pas via une décision).
- **MCP `task-orchestrator` (v0.5.3)** : `recette_confirm` résout désormais les
  décisions `recette` legacy encore `awaiting` de la tâche.
- **Agent orchestrateur (v0.3.6)** : §13 mis à jour — la recette est entrée
  automatiquement à `done`, **plus aucune** `decision_request(kind="recette")`
  (obsolète) ; l'humain utilise la session dédiée `agent-recette` + « Terminer
  la recette ».
- Nettoyage des décisions recette stale existantes.

### Dépôts impactés

`opencode-observability` (v0.7.5) · `opencode-mcp-task-orchestrator` (v0.5.3) ·
`opencode-agents` (v0.3.6).

---

## v0.7.4 — 2026-09-01 · Observabilité alignée sur le framework recette (Phase D)

**Objectif** : aligner les KPI sur le nouveau modèle recette (opération
pending/in_progress/done, éléments classés, tâches générées) — l'observabilité
utilisait encore l'ancienne sémantique (approved/rejected).

### Changements (`opencode-observability` v0.7.4)

- **`summary`** : « Success » = `done` + recette **faite** (`done` nouveau /
  `approved` legacy) ; **taux de rework redéfini** = éléments de recette classés
  `rework` / total éléments ; `recette` stats incluses.
- **Nouveau `GET /api/metrics/recette`** : recettes par statut, nb d'éléments et
  répartition (rework/bug/improvement/feature), nb de tâches générées par
  classe, durée moyenne de recette.
- **Funnel qualité** : « Accepté » = recette `done`/`approved` ; « Sans rework »
  exclut aussi les tâches dont une tâche fille classée `rework` existe.
- **Rework dans le temps** : intègre les éléments de recette `rework` par jour
  (en plus des transitions plan rework et rejets legacy).
- **Dashboard** : nouveau panneau « Recette » (KPI cards + 2 graphiques : éléments
  par classification, tâches générées par classification).

### Dépôts impactés

`opencode-observability` (v0.7.4).

---

## v0.7.3 — 2026-09-01 · Scope des tâches issues de recette (rempli par l'agent-recette)

**Objectif** : le **scope** (périmètre) des tâches issues de la recette est
déterminé par l'**agent-recette** (renseigné sur chaque élément de recette), puis
**transmis à `task_register`** à la confirmation → l'orchestrateur peut
**sérialiser** les tâches parallèles qui se chevauchent.

### Changements

- **MCP `task-orchestrator` (v0.5.2)** : colonne `recette_items.scope` ;
  `recette_item_add` / `recette_item_update` acceptent `scope[]` ; renvoyé dans
  `task_get`/`recette`.
- **Panneau (v0.7.3)** : `finishRecette` transmet `scope` à `task_register`.
- **Agent `agent-recette` (v0.3.2)** : détermine et renseigne le `scope` de
  chaque élément (basé sur commits, tâches liées, chemins d'artefacts, plans).
- **Application immédiate** : scopes posés sur les 4 tâches issues de la recette
  de `T-20260831-174431` (`packages/p7-ecosystem/src/extensions/
  madatalk-requests/`, `apps/admin-next/` pour les tâches admin) → lancement
  parallèle sérialisé par la détection de conflits de scope.

### Dépôts impactés

`opencode-observability` (v0.7.3) · `opencode-mcp-task-orchestrator` (v0.5.2) ·
`opencode-agents` (v0.3.2).

---

## v0.7.2 — 2026-09-01 · Correctif « Session de recette »

**Problème** : le bouton « Session de recette » affichait « session existante »
sans ouvrir la session, car la recette portait un `session_id` **invalide**
(non `ses_…`, hérité d'un échec de lancement) — et aucune redirection n'était
faite vers la session.

**Correctif** (`opencode-observability` v0.7.2) :
- `launchRecetteSession` ne reprend une session que si l'id est valide (`ses_…`)
  **et** que la session existe réellement (`sessionExists`) ; sinon, lance une
  nouvelle session `agent-recette` (message d'erreur explicite si l'agent est
  indisponible).
- Le bouton **ouvre la session dans un nouvel onglet** (`window.open`) au lieu
  d'une simple alerte.
- Purge des `session_id` invalides dans la table `recettes`.

Dépôt impacté : `opencode-observability`.

---

## v0.7.1 — 2026-09-01 · Correctif session de recette

- **`task_link_session` accepte le kind `recette`** (MCP v0.5.1) — corrige
  « Échec de lancement de la recette : Invalid arguments … kind » au clic
  « Session de recette ».
- Nettoyage d'une tâche de test résiduelle (`T-20260901-075803`).

Dépôts impactés : `opencode-mcp-task-orchestrator` (v0.5.1).

---

## v0.7.0 — 2026-09-01 · Framework Recette (session dédiée, items, création de tâches)

**Objectif** : considérer la **recette** comme une phase distincte du cycle de
vie. Une tâche terminée n'est **plus modifiée** pendant sa recette : une session
**dédiée** (agent `agent-recette`), des **éléments consolidés** (remarques,
demandes, constats), une **classification** (rework / bug / improvement /
feature), puis — après **confirmation** — la **création de nouvelles tâches**
rattachées à la tâche initiale.

### Changements

- **Registre / MCP `task-orchestrator` (v0.5.0)** :
  - tables `recettes` (opération : pending/in_progress/done) et `recette_items`
    (contenu, classification, statut, tâche créée) ; colonne `tasks.recette_class`.
  - **entrée en recette automatique** dès que la tâche passe `done` ;
  - outils : `recette_start`, `recette_item_add`, `recette_item_update`,
    `recette_confirm` ; `task_get` renvoie la recette + ses items ;
  - `task_register` accepte `recetteClass` ; `newTaskId` **unique** (suffixe
    aléatoire — corrige la collision sur créations rapprochées) ;
  - gardes : tâche avec recette en cours/terminée = clôturée (aucune transition,
    aucune nouvelle décision).
- **Panneau (v0.7.0)** :
  - remplacement du bouton « Valider la recette » par la section **Recette** :
    « Session de recette » (lance/rejoint la session `agent-recette`) et
    « Terminer la recette » ;
  - « Terminer la recette » → **synthèse consolidée** (éléments + type + action)
    → **confirmation** → création des tâches via `task_register` (typées
    bug→debug, sinon feature), **liées** à la tâche initiale, `recette_class`
    renseignée, éléments marqués `task_created`, recette clôturée.
- **Nouvel agent `agent-recette` (opencode-agents v0.3.0)** : contexte réel
  (task_get, linkedTasks, commits, artefacts, événements, plans), accompagnement,
  enregistrement des items, classification, regroupement, préparation de la
  synthèse — **aucune création prématurée de tâches**, **aucune transition** sur
  la tâche initiale.

### Dépôts impactés

`opencode-observability` (v0.7.0) · `opencode-mcp-task-orchestrator` (v0.5.0) ·
`opencode-agents` (v0.3.0, nouveau `agent-recette.md`).

---

## v0.6.3 — 2026-09-01 · Sessions conservées (stop process, aucune suppression)

**Problème** : le correctif v0.5.2 supprimait les sessions à l'approbation de la
recette (`killSession` → `opencode session delete`) — le lien « session » et la
consommation devenaient indisponibles (tracabilité perdue).

**Correctif** (`opencode-observability` v0.6.3) :
- `killSession` ne supprime **plus jamais** l'enregistrement de session : il
  **arrête seulement les processus** `opencode run` (SIGTERM/SIGKILL) ; la
  session persiste sur disque → lien consultable + `opencode export` (consommation)
  valides (vérifié sur une session réelle : recette approuvée, process absent,
  export OK).
- Appliqué **partout** : approbation de recette **et** bouton « Tuer la session »
  (Actions).

> ⚠️ Les sessions supprimées avant v0.6.3 sont perdues définitivement (non
> récupérables). À partir de cette version, plus aucune suppression.

Dépôt impacté : `opencode-observability`.

---

## v0.6.2 — 2026-09-01 · Whitelist commandes d'inspection (planning)

**Problème** : une commande composée de lecture (`ls` + `echo` + `test -f`)
déclenchait une demande de permission (le segment `test` n'était pas dans la
liste blanche d'atomic-plan) et pouvait être rejetée, bloquant la planification.

**Correctif** (`opencode-agents` v0.2.2) : ajout à la liste blanche bash
d'atomic-plan des commandes d'inspection en lecture seule : `test`, `printf`,
`sha256sum`, `cut`, `xxd`, `base64`, `command -v`, `node --version`, `diff`,
`cmp`, `du`.

Dépôt impacté : `opencode-agents`.

---

## v0.6.1 — 2026-08-31 · Attente de validation quand un agent est bloqué par l'humain

**Règle métier** : quand un agent s'arrête parce qu'il **attend une validation
humaine** (permission refusée ou en attente, question posée, décision requise),
la tâche doit passer en **`awaiting_validation`** — jamais rester figée à
l'état précédent (`planning`, `in_progress`, …).

### Changements (`opencode-agents` v0.2.1)

- **Orchestrateur** : distinction explicite dans la règle « ne laisse jamais une
  tâche bloquée silencieusement » :
  - attend l'humain → `task_transition(to="awaiting_validation")` +
    `task_event(WAITING_VALIDATION, …)` ;
  - autre blocage (MCP, erreur) → `blocked`/`failed` + `task_event`.
  - + vérification à **chaque tour** (décision `permission` refusée ou
    sous-agent signalant une attente humaine → appliquer immédiatement).
- **atomic-plan** : s'il est bloqué par une permission refusée / question en
  attente → publie `task_event(WAITING_VALIDATION)` (si taskId) et revient avec
  un message explicite « bloqué — attente de validation humaine » (sans
  prétendre la planification terminée).

### Dépôts impactés

`opencode-agents` (v0.2.1). Aucun changement de machine à états (la transition
`planning → awaiting_validation` existait déjà).

---

## v0.6.0 — 2026-08-31 · Tâches liées (associées) + nature de liaison

**Objectif** : à la création d'une tâche, définir **une ou plusieurs tâches
associées** (liées) avec la **nature de la liaison** (ex. « c'est là que le
package a été créé »), exploitables par `atomic-plan` pour traiter la nouvelle
tâche (commits, étapes de plan, docs attachées).

### Changements

- **Registre / MCP `task-orchestrator` (v0.4.0)** :
  - table `task_links` (task_id, linked_task_id, description, created_at,
    dédupliqué par couple) ;
  - `task_register` accepte `linkedTasks[]` ({taskId, description}) ;
  - outils `task_link_add` / `task_link_remove` ;
  - `task_get` renvoie `linkedTasks` **enrichies** (request, statut, nb de
    plans, nb d'artefacts de la tâche liée).
- **Panneau (v0.6.0)** :
  - formulaire « Nouvelle tâche » : éditeur dynamique de **tâches liées**
    (taskId + nature de la liaison, lignes ajoutables/retirables) ;
  - détail de tâche (modale Actions) : section **« Tâches liées »** ;
  - `createTask` (pilot) transmet `linkedTasks`.
- **Planner `atomic-plan` (v0.2.0)** : à la planification, `task_get` →
  `linkedTasks` ; pour chaque tâche liée, exploiter **commits**
  (`plan_commits_list`/`task_get`), **étapes de plan** (`plan_get`/
  `progress_get`), **docs/résumés** (`artifact_list`), **déroulé**
  (`events_list`) pour situer les fichiers, réutiliser les conventions et
  justifier les étapes « en continuité de la tâche liée ».

### Dépôts impactés

`opencode-observability` (v0.6.0) · `opencode-mcp-task-orchestrator` (v0.4.0) ·
`opencode-agents` (v0.2.0).

---

## v0.5.2 — 2026-08-31 · Garde « recette validée = tâche clôturée »

**Problème** : après l'approbation de la recette, la session orchestrateur
restait vivante et continuait d'accepter de nouvelles demandes (relance
d'exécution, nouvelles décisions validation/review/recette) sur une tâche déjà
clôturée — l'utilisateur ne pouvait plus valider.

**Correctifs (défense en profondeur)** :

- **Prompt orchestrateur** (`opencode-agents`) : à **chaque tour**, `task_get`
  → si `recette_status='approved'`, la tâche est **clôturée** : aucune nouvelle
  demande, décision, transition, exécution ou déploiement.
- **Panneau** (`pilot.resolveRecette`) : à l'**approbation** de la recette, la
  session orchestrateur est **tuée** (`killSession`) — elle ne peut plus
  accepter de requêtes. (Non tuée en cas de rejet : le rework en a besoin.)
- **MCP `task-orchestrator`** (gardes dures) : `task_transition`,
  `plan_transition` et `decision_request` refusent toute opération sur une tâche
  dont la recette est déjà validée (erreur explicite + `TRANSITION_ERROR` pour
  les transitions).

**Dépôts impactés** : `opencode-observability` (v0.5.2) ·
`opencode-mcp-task-orchestrator` (v0.3.1) · `opencode-agents` (v0.1.5).

---

## v0.5.1 — 2026-08-31 · Docs opérationnelles synchronisées (état v0.5.0)

Synchronisation de la documentation de référence avec l'état courant :

- **02-composants** : onglet « Observabilité », fonctions de pilotage à jour
  (`createProject` avec branche principale, `resolveDecision` qui réveille la
  session), charting Chart.js local.
- **03-workflow** : statut `rework` non terminal, badge « attente humaine »,
  section « Branche principale & déploiement » (garde + pull avant push),
  décisions → réveil de session, création de projet.
- **04-reproduction** : guide mis à jour (métriques `/api/metrics/*`,
  branche principale obligatoire, rework, observabilité).
- **05-reference** : modèle de données (`projects.main_branch`,
  `scope_conflicts`), machines à états (rework non terminal), section
  « Endpoints observabilité ».
- **README** : mention de l'observabilité.

Dépôt impacté : `opencode-observability` (docs uniquement).

---

## v0.5.0 — 2026-08-31 · Branche principale par projet (obligatoire pour déployer)

**Objectif** : chaque projet définit une **branche principale** (obligatoire
depuis le panneau). Sans elle, **aucun déploiement n'est autorisé** ; avant de
pousser, on **pull depuis la branche principale**.

### Changements

- **Registre / MCP `task-orchestrator` (v0.3.0)** :
  - colonne `projects.main_branch` (migration idempotente) ;
  - `project_register` accepte `mainBranch` ; `project_get`/`project_list`
    l'exposent.
- **Panneau (v0.5.0)** :
  - formulaire projet : champ **« Branche principale » obligatoire** (création
    et modification) ;
  - refus côté API si `mainBranch` absente (« branche principale requise ») ;
  - carte projet : affiche la branche principale, ou un badge
    **« manquante — déploiement bloqué »**.
- **Orchestrateur (prompt §7-8, §12)** :
  - récupère `mainBranch` via `project_get` ;
  - **garde de déploiement** : pas de déploiement sans `mainBranch`
    (→ `blocked` + événement + info utilisateur) ;
  - **pull depuis la branche principale** avant de pousser vers git.
- **Exécuteur (prompt `build-notify`)** : `git pull --rebase origin
  <mainBranch>` avant tout push.
- Le projet **oniria** a été seedé avec `mainBranch=main` (à ajuster dans le
  panneau si besoin).

### Dépôts impactés

`opencode-observability` (v0.5.0) · `opencode-mcp-task-orchestrator` (v0.3.0) ·
`opencode-agents` (prompts).

---

## v0.4.1 — 2026-08-31 · Correctifs (7 bugs d'utilisation)

### Corrections

1. **Création automatique du projet** : `createProject` crée désormais le
   répertoire (+ `git init`) dans le workspace Coder via `workspace_exec`
   (non bloquant, avertissement si workspace injoignable).
2. **Attente humaine visible** : les tâches avec une décision en attente
   (validation/review/recette) affichent un badge « ⏳ attente humaine » dans la
   liste des tâches (drapeau `waiting_human` ajouté à `/api/tasks`).
3. **Consommation** : régression v0.2.0 corrigée — `taskConsumption(taskId,
   registry())` (l'appel omettait la connexion DB, d'où « Aucune session
   enregistrée »).
4. **Décisions → réveil de la session** : après approbation/rejet depuis le
   panneau, un message est injecté dans la session orchestrateur pour qu'elle
   continue automatiquement (`injectMessage`, non bloquant).
5. **Rework — session préremplie** : la modale « Reprendre » préremplit la
   session courante (dernière session de la tâche).
6. **Rework — remarques préremplies** : la remarque de reprise reprend par défaut
   la remarque de rejet de la recette.
7. **Rework bloqué** : la machine à états TÂCHE accepte désormais
   `rework → planned/in_progress/…/done` (état non terminal) ; le panneau
   affiche « Reprendre » et « Tuer la session » pour le statut `rework` ; le
   prompt orchestrateur documente la reprise (`rework → in_progress → done →
   ré-ouverture recette`).

### Dépôts impactés

`opencode-observability` (v0.4.1) · `opencode-mcp-task-orchestrator` (v0.2.1,
statemachine) · `opencode-agents` (prompt orchestrateur §13).

---

## v0.4.0 — 2026-08-30 · Observabilité Phase 3 (qualité, rework, coût)

**Objectif** : compléter le dashboard avec les dimensions **Qualité** et
**Coût vs Productivité** (les KPI worktree/ressources restent abandonnés).

### Dashboard (panneau `opencode-observability`)

- **Funnel qualité** : Completed → Audited → Accepted → Sans rework (barres
  proportionnelles + taux d'audit / d'acceptation / de propreté).
- **Rework dans le temps** (30 j) : reworks (transition plan `rework` +
  recettes rejetées) par jour, avec taux rapporté au done du jour.
- **Coût vs Throughput** (30 j) : coût journalier (sessions `opencode export`)
  en barres + tâches done en ligne (double axe).
- Endpoints : `/api/metrics/{quality,rework,costvsthroughput}`.

### Dépôts impactés

`opencode-observability` (v0.4.0). Aucune migration de schéma.

---

## v0.3.0 — 2026-08-30 · Observabilité Phase 2 + durcissement (Phase 4)

**Objectif** : enrichir le dashboard avec « où passe le temps » et « où sont
les blocages », et durcir la qualité des données (conflits de scope, erreurs de
transition, attribution des agents).

### Dashboard (panneau `opencode-observability`)

- **Répartition du temps par phase** (waterfall) : moyenne par phase sur toutes
  les tâches terminées (attente queue, planification, attente validation,
  exécution, attente review, finalisation, déploiement, bloqué, échec) +
  détail par tâche (`GET /api/metrics/timeline?taskId=`).
- **Blocages par raison catégorisée** (30 j) : MCP/outil, permission,
  worktree/scope, build/tests, externe/CI, agent, autre.
- **Success / Failure par jour** : barres empilées (done vs
  blocked/failed/aborted/crashed).
- **Durcissement** : cartes « Décisions expirées », « Conflits de scope »,
  « Erreurs de transition ».
- Endpoints : `/api/metrics/{phases,timeline,blocked,successfailure,hardening}`.

### Durcissement des données (MCP `task-orchestrator` v0.2.0, prompts)

- **Conflits de scope persistés** : nouvelle table `scope_conflicts` ; le tool
  `scope_conflict` enregistre désormais les conflits détectés (tâches actives +
  worktrees réservés).
- **Erreurs de transition tracées** : `task_transition` et `plan_transition`
  enregistrent un événement `TRANSITION_ERROR` (from/to/raison) quand la machine
  à états refuse.
- **Attribution stricte des agents** : les prompts (`build-notify`,
  `atomic-plan`, `orchestrator`, auditeurs) renseignent désormais explicitement
  `by="<nom agent>"` dans `task_event` et `by`/`requestedBy` dans
  `decision_request` — fiabilise les métriques par agent.
- Les KPI **worktree / ressources** sont abandonnés (usage peu fiable).

### Dépôts impactés

`opencode-observability` (v0.3.0) · `opencode-mcp-task-orchestrator` (v0.2.0) ·
`opencode-agents` (attribution).

---

## v0.2.0 — 2026-08-30 · Dashboard Observabilité (KPI Phase 1)

**Objectif** : répondre en quelques secondes à « combien de tâches ? À quelle
vitesse ? Avec quelle qualité ? Quels agents posent problème ? Quel coût ? »
via un dashboard système **Flow + Orchestration + Agents + Quality**.

### Changements (panneau `opencode-observability`)

- **Nouvel onglet « Observabilité »** dans le panneau :
  - **9 KPI cards** : tâches, terminées, en cours, Lead Time moyen / P95,
    Cycle Time moyen, **Success Rate** (définition : `done` **ET** recette
    approuvée), Throughput (tâches done / jour), Rework Rate.
  - **4 graphiques Chart.js** : évolution du Lead Time (P50 / moyen / P95),
    histogramme de répartition du Lead Time, statut des tâches (bar chart
    horizontal), Throughput (aire).
  - **Table de performance des agents** : tâches, succès %, durée moyenne / P95,
    retries, blocages, échecs (attribution via `events.by`, partielle sur
    l'historique — événements génériques regroupés « non attribué »).
  - **Coûts & tokens** : totaux + coût/tokens par tâche et par agent
    (via `opencode export`, déjà utilisé par le panneau).
- **Backend** : module `metrics.mjs` (agrégations SQL sur `task_registry`) +
  endpoints `GET /api/metrics/{summary,status,throughput,leadtime,agents,costs}` ;
  refactor du calcul d'usage dans `usage.mjs` (réutilisé par `server.mjs`).
- **Chart.js v4.4.3 vendu localement** (`public/vendor/chart.umd.js`) — aucune
  dépendance CDN.
- Critères : `Success = done ET recette approved` ; tâches `done` sans recette
  = « non évaluées ».

### Dépôts impactés

`opencode-observability` (panneau + docs). Aucune migration de schéma requise.

---

## v0.1.0 — 2026-08-30 · Notification centralisée par changements d'état

**Objectif** : les agents et sous-agents n'envoient **plus d'email directement**
et leurs prompts ne contiennent **plus aucune instruction d'email**. À la place,
un daemon central observe les changements d'état du registre PostgreSQL et
signale l'utilisateur avec les données de la base.

### Changements

- **Nouveau composant `opencode-notifier`** (v0.1.0) : daemon de notification
  email, **unique émetteur** de l'écosystème.
  - Observe le registre `task_registry` : `events`, `decisions`, `deployments`,
    `plan_incidents`, `plan_inconsistencies`, `audit_notifications`.
  - Mécanisme **hybride** : triggers PostgreSQL `LISTEN/NOTIFY` (réactivité) +
    **polling de rattrapage/secours** toutes les `NOTIFIER_POLL_MS` ms.
  - High-water marks persistés (`notifier_state`) + déduplication (`notifier_dedup`)
    → un email par changement d'état, reprise propre après redémarrage.
  - Baseline au premier démarrage (aucune notification rétroactive).
  - Envoi via l'unique primitives SMTP `scripts/send-mail.mjs` ; pièces jointes
    (plans, audits, rapports) issues de la table `artifacts`.
  - Mode `NOTIFIER_DRY_RUN=1` pour valider sans envoyer.
- **Retrait des envois d'email directs** :
  - MCP `task-orchestrator` : outil `notify` supprimé (et `sendMail`).
  - MCP `plan-manager` : outil `notify` supprimé ; incidents/incohérences
    persistés sans email.
  - MCP `audit-manager` : outil `notify` supprimé ; incidents/incohérences
    **reflétés** dans la table `audit_notifications` (observable par le notifier).
  - Script `record-permission.mjs` : la décision `permission` reste tracée, plus
    d'email.
- **Prompts agents** (`opencode-agents`) : suppression de toutes les instructions
  d'email (sections « Script email », « Notification d'intervention », contrats
  de fin avec email) dans `build-notify`, `atomic-plan`, `orchestrator`,
  `hexagonal-architecture-auditor`, `clean-arch-detector-react`. Les agents
  **écrivent des états** (`task_event`, `artifact_add`, `decision_request`,
  `deployment_record`, incidents/incohérences) qui déclenchent les notifications.
- **Skills** : `task-execution`, `plan-manager`, `audit-manager` mis à jour
  (aucune mention d'email ; rôle du notifier documenté).
- **Docs panneau** : `02-composants`, `03-workflow`, `04-reproduction`, `README`
  mis à jour ; ajout de `06-versioning.md` et de ce `CHANGELOG.md`.

### Règles de notification (périmètre « action humaine + états finaux »)

| État | Notification |
|---|---|
| Décision `awaiting` / résolue / expirée | Décision requise / approuvée·rejetée / expirée |
| Tâche `blocked`/`failed`/`aborted`/`crashed`/`done` | Tâche <statut> / terminée |
| `AUDIT_COMPLETED` | Audit terminé (+ rapport) |
| Déploiement `deploy_failed` / `post_deploy_verified` | Échec / vérifié |
| Incident/incohérence de plan ou d'audit (création/résolution) | Incident/Incohérence |

Pas de notification pour : `CHECKPOINT`, transitions mineures de planning,
heartbeats.

### Dépôts impactés

`opencode-notifier` (nouveau) · `opencode-agents` · `opencode-mcp-task-orchestrator`
· `opencode-mcp-plan-manager` · `opencode-mcp-audit-manager` · `opencode-scripts`
· `opencode-plugins` · `opencode-skills` · `opencode-observability` (docs).
