# 03 — Workflow de bout en bout / End-to-end workflow

> Le narratif du flux : comment une demande devient une tâche, puis des plans, puis
> du code déployé et validé. C'est la section à lire pour comprendre le workflow.

---

## 1. Cycle de vie d'une tâche

```
queued → started → planning → awaiting_validation → planned → in_progress → done
                                                                          │
                                                              [recette]   ▼
                                          recette auto-entrée (v0.7) : pending → in_progress → done
                                          (session dédiée agent-recette → éléments → « Terminer la recette »)
                                          └─→ nouvelles tâches (rework/bug/improvement/feature) liées à la tâche
```

| État | Signification | Qui le pose |
|---|---|---|
| `queued` | Tâche créée, en attente | panneau / orchestrator |
| `started` | Session lancée | panneau (bouton « Lancer ») |
| `planning` | Planner en cours | orchestrator (délègue à atomic-plan) |
| `awaiting_validation` | Plans à valider | orchestrator |
| `planned` | Plans validés | `decision_resolve` (agrégation auto) |
| `in_progress` | Plans en exécution | orchestrator |
| `rework` | Reprise après rejet (review) — **non terminal** depuis v0.2.1 | panneau/orchestrator |
| `done` | Tous les plans terminés | orchestrator |
| recette `pending/in_progress/done` | Opération de recette (v0.7) : pas faite → en cours (session `agent-recette`) → faite | auto à `done` + humain |

**Attente humaine visible** (v0.4.1) : une tâche avec une décision `validation`/
`review` en attente affiche un badge « ⏳ attente humaine » (la recette est suivie
via sa propre table, pas une décision — v0.7.5).

## 1bis. Recette = phase distincte (v0.7.0)

- La recette est un **objet de PROJET** (v0.8.0) : titre propre, session
  dédiée, couvrant **0..N tâches** (ou aucune — recette exploratoire). Créée
  depuis l'onglet **Recettes** (projet + titre + tâches couvertes optionnelles).
- Le panneau propose **« Session de recette »** : lance la session dédiée
  `agent-recette` (contexte réel : titre, projet, tâches couvertes, commits,
  artefacts, événements, plans). L'agent **enregistre les éléments** avec
  **classification** (`rework` / `bug` / `improvement` / `feature`), **titre
  court**, **critère d'acceptation** et **scope** suggéré.
- **« Terminer la recette »** → synthèse consolidée → **confirmation** → création
  de **nouvelles tâches** via `task_register` (typées, `recette_class`,
  **liées** à la tâche initiale via `task_links`, scope transmis) → recette
  `done`. La tâche initiale reste `done` et **intacte**.
- **Création de tâche** : on peut lier des **tâches associées** (v0.6.0) avec une
  **nature de liaison** (« c'est là que le package a été créé ») — exploitées par
  atomic-plan (commits, plans, docs).

## 2. Cycle de vie d'un plan (sous-tâche)

Chaque plan suit **son propre cycle**, en parallèle des autres :

```
planned → in_progress → validating → review → approved/rejected
        → merge_pending → merged → deploy_pending → deploying → deployed
        → post_deploy_verified → done
```

- **Approbation indépendante par plan** : un plan peut être `approved` pendant qu'un
  autre est `rejected → rework`.
- `decision_resolve` (review) transitionne le **plan** (`review → approved/rejected`),
  pas la tâche.
- La tâche reste `in_progress` jusqu'à ce que **tous** les plans soient `done`.

## 3. Les décisions humaines

| kind | Quand | Résolution → effet |
|---|---|---|
| `validation` | Après la planification | acceptée → tâche `planned` ; rejetée → tâche `aborted` (agrégation auto) |
| `review` | Avant merge (par plan) | approuvée/rejetée → **plan** `approved/rejected` |
| `recette` | Après `done` | approuvée/rejetée → colonne `recette_status` (sans toucher l'exécution) |
| `permission` | Demande de permission opencode | tracée (sans transition) |

Chaque décision a : `kind`, `detail`, `planId` (si lié à un plan), `status`
(`awaiting` → `approved`/`rejected`), `resolution` (remarques).

## 4. Notifications (v0.1.0 — centralisées, sans email des agents)

Depuis la **v0.1.0**, les agents et MCP **n'envoient plus d'email**. Le daemon
`opencode-notifier` observe les changements d'état du registre PostgreSQL et
signale l'utilisateur avec les données de la base :

| État observé | Notification |
|---|---|
| Décision humaine `awaiting` (validation/review/permission/recette) | « Décision requise » (pièce jointe : plan si validation) |
| Décision résolue (`approved`/`rejected`) | « Décision approuvée/rejetée » |
| Décision expirée | « Décision expirée » (escalade) |
| Tâche `blocked`/`failed`/`aborted`/`crashed`, événement `BLOCKED` | « Tâche <statut> » |
| Tâche `done`, événement `TASK_COMPLETED` | « Tâche terminée » (rapport en pièce jointe via `artifacts`) |
| Audit terminé (`AUDIT_COMPLETED`) | « Audit terminé » (rapport en pièce jointe via `artifacts`) |
| Déploiement `deploy_failed` | « Déploiement échec » (lien pipeline) |
| Déploiement `post_deploy_verified` | « Déploiement vérifié » |
| Incident/incohérence de plan (`plan_incidents`, `plan_inconsistencies`) | « Incident/Incohérence » (+ résolution) |
| Incident/incohérence d'audit (miroir `audit_notifications`) | « Incident/Incohérence d'audit » (+ résolution) |

Mécanisme : **hybride** — triggers PostgreSQL `LISTEN/NOTIFY` (réactivité) +
polling de rattrapage (`notifier_state` = high-water marks, reprise propre).
Envoi via l'unique primitives SMTP `scripts/send-mail.mjs`. Aucun agent n'appelle
plus ce script ; l'outil MCP `notify` a été retiré des serveurs.

## 4bis. Branche principale & déploiement (v0.5.0)

- Chaque projet définit une **branche principale** (`main_branch`), **obligatoire
  depuis le panneau** (Projets → Modifier). Sans elle, **aucun déploiement n'est
  autorisé** (l'orchestrateur passe la tâche en `blocked`).
- **Avant de pousser** vers git, on **pull depuis la branche principale**
  (`git pull --rebase origin <mainBranch>`) pour intégrer les derniers
  changements (consigne orchestrateur §7-8/§12 + exécuteur build-notify).
- **Décisions depuis le panneau** (v0.4.1) : approuver/rejeter une décision
  réveille la session orchestrateur (`injectMessage`) — pas besoin de retaper le
  verdict.
- **Création de projet** (v0.4.1) : le répertoire est créé automatiquement dans
  le workspace Coder (`mkdir` + `git init`).

## 5. Séquence type (exemple à 2 plans)

```
humain ──créer tâche──▶ panneau ──Lancer──▶ started
orchestrator ──▶ planning ──délègue──▶ atomic-plan (2 plans)
orchestrator ──▶ awaiting_validation ──decision_request(validation) x2
humain ──valide les 2 plans──▶ planned (auto)
orchestrator ──▶ in_progress ──délègue──▶ build-notify (2 sous-tâches parallèles)
build-notify ──▶ (worktree, code, commit) ──▶ validating → review (par plan)
humain ──review par plan──▶ plan approved/rejected (indépendant)
orchestrator ──▶ merge_pending → merged → deploy… → done (par plan)
orchestrator ──▶ task done (tous les plans done)
humain ──Valider la recette──▶ recette approved/rejected
```

## 6. Traçabilité fine : commits + sessions

- **Commits par sous-tâche** : à la fin de chaque plan, `build-notify` publie la trace
  de ses commits (`plan_commit_add` : sha, branche, message, auteur, fichiers + diff).
  Le panneau affiche le nombre de commits par plan et leur diff (bouton « commits »).
  La trace est append-only (les commits d'un rework s'ajoutent, rien n'est effacé).
- **Sessions par tâche** : chaque session opencode lancée (`launch`/`rework`/`relaunch`)
  est liée à la tâche (`task_link_session`). La consommation (tokens + coût) est
  calculée via `opencode export <sessionId>` et affichée dans l'onglet Tâches.

---

## English version

**1. Task lifecycle** — `queued → started → planning → awaiting_validation → planned →
in_progress → done`, then acceptance (`recette`: `pending → approved/rejected`).
Who sets each state: `queued` (panel/orchestrator), `started` (panel "Launch"),
`planning` (orchestrator delegates to atomic-plan), `awaiting_validation`
(orchestrator), `planned` (automatic via `decision_resolve` aggregation),
`in_progress` (orchestrator), `done` (orchestrator when all plans are done), recette
(human via "Validate acceptance").

**2. Plan (sub-task) lifecycle** — each plan follows its own cycle, in parallel:
`planned → in_progress → validating → review → approved/rejected → merge_pending →
merged → deploy_pending → deploying → deployed → post_deploy_verified → done`.
Approval is **independent per plan** (one can be `approved` while another is
`rejected → rework`). `decision_resolve` (review) transitions the **plan**, not the
task; the task stays `in_progress` until all plans are `done`.

**3. Human decisions** — `validation` (after planning → task `planned`/`aborted`),
`review` (before merge → plan `approved`/`rejected`), `recette` (after `done` →
`recette_status` column), `permission` (opencode permission, traced only). Each
decision has `kind`, `detail`, `planId`, `status`, `resolution`.

**4. Notifications (v0.1.0)** — centralized: the `opencode-notifier` daemon
watches registry state changes (events, decisions, deployments, incidents) and
emails the user with database data. Agents never send emails; the MCP `notify`
tool was removed.

**5. Example sequence (2 plans)** — human creates task → panel launches (`started`) →
orchestrator plans (`planning`) → atomic-plan produces 2 plans → `awaiting_validation`
→ human validates both → `planned` (auto) → `in_progress` → build-notify executes 2
parallel sub-tasks → `validating` → `review` → human approves/rejects each plan
(independently) → merge/deploy per plan → task `done` → human validates acceptance.

**6. Fine-grained traceability: commits + sessions** — at the end of each plan,
`build-notify` publishes its commit trace (`plan_commit_add`: sha, branch, message,
author, files + diff); the panel shows the commit count per plan and their diff
("commits" button); the trace is append-only (rework commits are added, never erased).
Each opencode session (`launch`/`rework`/`relaunch`) is linked to the task
(`task_link_session`); consumption (tokens + cost) is computed via
`opencode export <sessionId>` and shown in the Tasks tab.
