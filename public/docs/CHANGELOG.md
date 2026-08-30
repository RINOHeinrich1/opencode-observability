# Changelog — Écosystème opencode

> Versionnage **semver** (`MAJOR.MINOR.PATCH`). Chaque version documente les
> évolutions du framework d'orchestration (agents, MCP, scripts, plugins,
> panneau, notifier). La version courante correspond à un tag git `vX.Y.Z` sur
> chaque dépôt de l'écosystème (voir `06-versioning.md`).

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
