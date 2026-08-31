# 06 — Versioning de l'écosystème (v0.2.0)

> **FR** — Politique de versionnage de l'écosystème opencode : chaque version est
> traçable dans la doc (CHANGELOG), taguée git (`vX.Y.Z`) sur chaque dépôt, et
> correspond à un jalon cohérent du framework. **EN** — Versioning policy of the
> opencode ecosystem: each version is traceable in the docs (CHANGELOG), git-tagged
> (`vX.Y.Z`) on each repository, and maps to a coherent framework milestone.

## 1. Modèle de version

- **Semver** : `MAJOR.MINOR.PATCH`.
  - `MAJOR` : rupture de comportement/contrat (ex. : les agents ne peuvent plus
    envoyer d'email — v0.1.0).
  - `MINOR` : évolution compatible (nouvelle capacité, nouvel outil MCP).
  - `PATCH` : correctif sans changement de contrat.
- **Une version = un jalon** documenté dans `CHANGELOG.md`, avec :
  - l'**objectif** (pourquoi cette version) ;
  - la **liste des changements** par composant ;
  - les **règles de comportement** nouvelles (ex. périmètre de notification) ;
  - les **dépôts impactés**.

## 2. Traçabilité

1. Chaque dépôt de l'écosystème porte sa version dans son `package.json`
   (et/ou sa constante `version` du serveur MCP).
2. À chaque jalon, un **tag git `vX.Y.Z`** est posé sur **chaque dépôt impacté**.
3. Le `CHANGELOG.md` est la **source de vérité documentaire** du jalon ;
   il est servi sur `orchestrator.madatalk.fr/docs/CHANGELOG.md`.
4. Les docs opérationnelles (workflow, composants, reproduction) reflètent la
   version courante.

## 3. Repos & versions

| Dépôt | Chemin hôte | Version actuelle |
|---|---|---|
| `opencode-observability` (panneau + docs) | `/root/orchestrator-panel` | `0.5.0` |
| `opencode-agents` | `~/.config/opencode/agent` | `0.1.0` |
| `opencode-notifier` | `~/.config/opencode/notifier` | `0.1.0` |
| `opencode-mcp-task-orchestrator` | `~/.config/opencode/mcp/task-orchestrator` | `0.3.0` |
| `opencode-mcp-plan-manager` | `~/.config/opencode/mcp/plan-manager` | `0.1.0` |
| `opencode-mcp-audit-manager` | `~/.config/opencode/mcp/audit-manager` | `0.1.0` |
| `opencode-mcp-coder-workspaces` | `~/.config/opencode/mcp/coder-workspaces` | `0.1.0` |
| `opencode-scripts` | `~/.config/opencode/scripts` | `0.1.0` |
| `opencode-plugins` | `~/.config/opencode/plugins` | `0.1.0` |
| `opencode-skills` | `~/.config/opencode/skills` | `0.1.0` |

## 4. Processus de création d'une version

1. Définir l'objectif de la version et le périmètre des changements.
2. Appliquer les changements par repo (branche de travail dédiée si session
   parallèle, cf. `session-guard`).
3. Mettre à jour les versions (`package.json` / constantes MCP) et les docs
   (`CHANGELOG.md`, composants, workflow, reproduction).
4. Tester de bout en bout (dry-run du notifier, vérification des flux).
5. Committer par repo + poser le tag `vX.Y.Z` sur chaque dépôt impacté.
6. Déployer les composants (PM2 : panneau, notifier ; MCP : redémarrage des
   sessions qui les chargent).

## 5. Version actuelle

Voir [CHANGELOG.md](CHANGELOG.md) — dernière entrée : **v0.5.0** (2026-08-31,
Branche principale par projet, obligatoire pour déployer).
