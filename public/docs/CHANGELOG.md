# Changelog — Écosystème opencode

> Versionnage **semver** (`MAJOR.MINOR.PATCH`). Chaque version documente les
> évolutions du framework d'orchestration (agents, MCP, scripts, plugins,
> panneau, notifier). La version courante correspond à un tag git `vX.Y.Z` sur
> chaque dépôt de l'écosystème (voir `06-versioning.md`).

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
