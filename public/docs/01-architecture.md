# 01 — Architecture & concepts / Architecture & concepts

> Ce fichier pose le vocabulaire et le « pourquoi ». C'est le point d'entrée pour
> comprendre le framework. / This file sets the vocabulary and the "why". It is the
> entry point to understand the framework.

---

## 1. Objectif & enjeux / Objective & stakes

**FR** — Le framework orchestre des **agents IA** (planification, exécution, audit)
pour traiter des **tâches** sur des **projets**, avec des garanties fortes :

- **Traçabilité** : chaque tâche, plan, décision, événement, commit (fichiers + diff)
  et session (consommation tokens/coût) est persisté en base.
- **Validation humaine** : des points de contrôle obligatoires (validation de plan,
  review avant merge, recette après déploiement, permissions).
- **Isolation** : les agents exécutent dans un *workspace Coder* (jamais l'hôte),
  en *non-root*, chacun dans son *worktree*.
- **CI/CD** : déploiement via pipeline (jamais manuel).
- **Concurrence** : une tâche peut être découpée en plusieurs *plans* (sous-tâches)
  exécutés **en parallèle**, chacun avec son propre cycle de vie.

**EN** — The framework orchestrates **AI agents** (planning, execution, audit) to
process **tasks** on **projects**, with strong guarantees: traceability (everything
persisted: tasks, plans, decisions, events, commits with files+diff, sessions with
consumption), human validation (mandatory checkpoints), isolation (Coder workspace,
non-root, worktrees), CI/CD (pipeline-only deploys), concurrency (a task can split
into several **plans** executed in parallel, each with its own lifecycle).

## 2. Concepts clés / Key concepts

| Terme (FR) | EN | Définition |
|---|---|---|
| **Tâche** | Task | Unité de travail (demande) enregistrée dans le registre, avec un statut d'exécution grossier. |
| **Plan** (sous-tâche) | Plan (sub-task) | Un découpage d'une tâche en objectif indépendant. Porte son **propre** cycle d'exécution (review/merge/déploiement). |
| **Décision** | Decision | Un point de validation humaine (validation de plan, review, recette, permission). |
| **Session** | Session | Une session opencode (agent) lancée/détachée pour traiter la tâche. |
| **Worktree** | Worktree | Un checkout git isolé, créé/supprimé par l'agent exécutant (via `session-guard`). |
| **Recette** | Acceptance | Opération de vérification d'une tâche terminée (v0.7.0) : session dédiée `agent-recette`, éléments consolidés (rework/bug/improvement/feature), confirmation → nouvelles tâches liées. La tâche initiale reste intacte. |
| **État** | State | Statut d'exécution (tâche = phases grossières ; plan = cycle complet). |

## 3. Architecture en couches / Layered architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Panneau web (centre de pilotage)  — orchestrator.madatalk.fr │
│  lecture du registre + actions (lancer, rework, kill, recette)│
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP (stdin/stdout)
┌──────────────────────────────▼──────────────────────────────┐
│  MCP task-orchestrator  —  registre de tâches + machines à états │
│  (source de vérité logique — PostgreSQL)                        │
└───────┬───────────────────────────────────────────────┬──────┘
        │                                               │
┌───────▼────────┐  ┌───────────────┐  ┌───────────────▼───────────┐
│  Agent          │  │  Agents        │  │  MCP métier               │
│  orchestrator   │→ │  atomic-plan    │  │  plan-manager, audit-     │
│  (propriétaire  │  │  build-notify   │  │  manager, coder-          │
│  des transitions)│ │  auditeurs      │  │  workspaces, oniria/react │
└───────┬────────┘  └───────┬────────┘  └────────────────────────────┘
        │ délègue           │ exécute/audite
┌───────▼────────────────────▼────────────────────────────────────┐
│  Workspace Coder (volume Docker) + Git (branches/worktrees)      │
│  + CI/CD (pipeline de déploiement)                               │
└──────────────────────────────────────────────────────────────────┘
```

**FR** — Trois principes :
1. **Source de vérité unique** : le registre de tâches (PostgreSQL) — le code, les
   plans, les audits ont chacun leur source (Git, plan-manager, audit-manager).
2. **Séparation des rôles** : l'**orchestrator** décide des transitions ; les
   **agents de fond** (planner/exécuteur/auditeur) publient des **événements**.
3. **Mission ≠ méthode** : l'orchestrator transmet la mission et le cadre, jamais la
   méthode d'exécution.

**EN** — Three principles:
1. **Single source of truth**: the task registry (PostgreSQL); code/plans/audits each
   have their own source (Git, plan-manager, audit-manager).
2. **Separation of roles**: the **orchestrator** decides transitions; **background
   agents** (planner/executor/auditor) publish **events**.
3. **Mission ≠ method**: the orchestrator passes the mission and the frame, never the
   execution method.

## 4. Flux global / Global flow

```
tâche:  queued → started → planning → awaiting_validation → planned
        → in_progress → done  → [recette : pending → approved/rejected]

plan:   planned → in_progress → validating → review → approved/rejected
        → merge_pending → merged → deploy_pending → deploying → deployed
        → post_deploy_verified → done
```

Voir `03-workflow.md` pour le détail de bout en bout.
