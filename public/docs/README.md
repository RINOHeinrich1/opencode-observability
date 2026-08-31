# Framework d'orchestration opencode — Documentation

> **FR** — Documentation exhaustive du framework d'orchestration d'agents IA
> (panneau web + orchestrator + sous-agents + MCP/Skills + Coder + Git/CI-CD +
> **observabilité/KPI**). **EN** — Exhaustive documentation of the AI-agents
> orchestration framework.

---

## Table des matières / Table of contents

| # | Fichier | Sujet / Topic |
|---|---|---|
| 1 | [01-architecture.md](01-architecture.md) | Vue d'ensemble, concepts, architecture / Overview, concepts, architecture |
| 2 | [02-composants.md](02-composants.md) | Les composants (panneau, orchestrator, agents, notifier, MCP, Coder, Git) |
| 3 | [03-workflow.md](03-workflow.md) | Workflow de bout en bout (tâche + plan + décisions + notifications) |
| 4 | [04-reproduction.md](04-reproduction.md) | Guide de reproduction pas-à-pas / Step-by-step setup guide |
| 5 | [05-reference.md](05-reference.md) | Modèle de données, machines à états, config, glossaire |
| 6 | [06-versioning.md](06-versioning.md) | Versioning de l'écosystème / Ecosystem versioning (v0.1.0) |
| — | [CHANGELOG.md](CHANGELOG.md) | Historique des versions / Version history |

## À qui s'adresse ce document / Who this is for

- **FR** — À un développeur qui veut **comprendre** le framework (workflow, enjeux)
  et, le cas échéant, **reproduire** un écosystème opencode semblable.
- **EN** — For a developer who wants to **understand** the framework (workflow,
  stakes) and, if needed, **reproduce** a similar opencode ecosystem.

## Comment le lire / How to read it

1. **Comprendre** : lire `01` (architecture) puis `03` (workflow).
2. **Approfondir** : lire `02` (composants) et `05` (référence).
3. **Reproduire** : lire `04` (guide de mise en place).

## Écosystème (dépôts) / Ecosystem (repositories)

| Dépôt | Contenu |
|---|---|
| `opencode-observability` | Panneau web (centre de pilotage) |
| `opencode-mcp-task-orchestrator` | Registre de tâches + machines à états |
| `opencode-mcp-plan-manager` | Persistance des plans d'action |
| `opencode-mcp-audit-manager` | Traitement des rapports d'audit |
| `opencode-mcp-coder-workspaces` | Découverte des workspaces Coder |
| `opencode-mcp-oniria-arch` | Audit d'architecture backend (hexagonale) |
| `opencode-mcp-react-arch` | Audit d'architecture frontend (feature-based) |
| `opencode-agents` | Agents (orchestrator, atomic-plan, build-notify, auditeurs) |
| `opencode-notifier` | Daemon de notification email (observe les changements d'état du registre) |
| `opencode-skills` | Skills (task-execution, plan-manager, audit-manager, …) |
| `opencode-scripts` | Scripts d'infra (session-guard, send-mail, load-env, …) |
| `opencode-plugins` | Plugins opencode (permission-hook, session-env) |
