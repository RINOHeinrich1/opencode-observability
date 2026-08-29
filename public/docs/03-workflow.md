# 03 — Workflow de bout en bout / End-to-end workflow

> Le narratif du flux : comment une demande devient une tâche, puis des plans, puis
> du code déployé et validé. C'est la section à lire pour comprendre le workflow.

---

## 1. Cycle de vie d'une tâche

```
queued → started → planning → awaiting_validation → planned → in_progress → done
                                                                          │
                                                              [recette]   ▼
                                                     pending → approved / rejected
```

| État | Signification | Qui le pose |
|---|---|---|
| `queued` | Tâche créée, en attente | panneau / orchestrator |
| `started` | Session lancée | panneau (bouton « Lancer ») |
| `planning` | Planner en cours | orchestrator (délègue à atomic-plan) |
| `awaiting_validation` | Plans à valider | orchestrator |
| `planned` | Plans validés | `decision_resolve` (agrégation auto) |
| `in_progress` | Plans en exécution | orchestrator |
| `done` | Tous les plans terminés | orchestrator |
| recette `pending/approved/rejected` | Acceptation humaine après déploiement | humain (bouton « Valider la recette ») |

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

## 4. Notifications (emails)

Moments obligatoires (script `send-mail.mjs`) :
1. Avant toute question/décision humaine.
2. Avant une action nécessitant une permission.
3. À la fin de la tâche (rapport en pièce jointe).

Vérifier toujours le code de sortie (`0` = succès).

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

**4. Notifications** — mandatory emails (`send-mail.mjs`): before any human
question/decision, before a permission-requiring action, at task completion (report
attached). Always check exit code `0`.

**5. Example sequence (2 plans)** — human creates task → panel launches (`started`) →
orchestrator plans (`planning`) → atomic-plan produces 2 plans → `awaiting_validation`
→ human validates both → `planned` (auto) → `in_progress` → build-notify executes 2
parallel sub-tasks → `validating` → `review` → human approves/rejects each plan
(independently) → merge/deploy per plan → task `done` → human validates acceptance.
