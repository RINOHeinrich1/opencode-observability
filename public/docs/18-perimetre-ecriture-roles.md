# 18 — Périmètre d'écriture interdit par rôle (phase 1 : prompts stricts)

> **FR** — Règle de **périmètre d'écriture** applicable aux sessions opencode
> **NON-ADMIN** lancées par le panneau (exécuteur, évaluateur produit, agent de
> sprint, agent de migration, agent de test E2E). Phase 1 = **consignes
> textuelles strictes** dans les prompts de session ; aucun mécanisme technique
> (sandbox, garde serveur, ACL) n'est mis en place à ce stade.
> **EN** — Write-scope rule for **NON-ADMIN** opencode sessions launched by the
> panel. Phase 1 = **strict textual instructions** in session prompts.

---

## 1. Règle

Un rôle **NON-ADMIN** n'a **AUCUN droit d'écriture** hors du/des **repo(s) du
PROJET cible de sa tâche**.

- **LECTURE autorisée** (inspection) : lire ces composants pour comprendre le
  contexte reste permis.
- **ÉCRITURE interdite** : création, édition, suppression, déplacement,
  `git add/commit/push`, script, `sed -i`, `cat >`, `tee`, `npm`, … sur tout
  composant hors périmètre.
- En cas de **demande** (utilisateur ou agent) visant une cible interdite :
  **REFUSER** puis **SIGNALER** — jamais exécuter, même partiellement, même
  « pour tester », même via une commande bash.

## 2. Cibles STRICTEMENT INTERDITES à la modification

| Cible | Chemin | Nature |
|---|---|---|
| Panneau d'orchestration | `/root/orchestrator-panel` | code, `public/docs`, `docs/`, `storage/`, base de données |
| Définitions d'agents | `/root/.config/opencode/agent` | agents opencode |
| Skills | `/root/.config/opencode/skills` | skills opencode |
| MCP `task-orchestrator` | `/root/.config/opencode/mcp/task-orchestrator` | MCP de l'écosystème |
| Tout autre MCP / composant écosystème | `/root/.config/opencode/…` | outillage opencode |
| Tout dépôt/dossier/fichier hors du PROJET cible | — | hors périmètre de la tâche |

Ces composants relèvent de l'**ADMINISTRATEUR** / de l'**orchestrateur** : leur
évolution ne passe **jamais** par une session non-admin. Elle se fait par
l'administrateur / l'orchestrateur, dans une **tâche dédiée du projet
`ecosystem`**.

## 3. Procédure en cas de demande hors périmètre

1. **REFUSER** — ne jamais exécuter la demande, même partiellement.
2. **SIGNALER** — remonter la demande refusée à l'utilisateur ; si un `taskId`
   est fourni, publier `task_event(type="BLOCKED", detail={reason, target})`.
3. **RENVOYER** au bon canal — l'évolution de ces composants se fait par
   l'administrateur / l'orchestrateur, dans une tâche dédiée du projet
   `ecosystem`.

## 4. Rôles concernés & mapping (niveau « prompt de session »)

La consigne est injectée par `buildWriteScopeNotice(role)` dans
`session-bridge.mjs` (source unique, rôle-aware) :

| Builder (`session-bridge.mjs`) | Agent lancé | Libellé de rôle injecté |
|---|---|---|
| `buildCadragePrompt` | `agent-cadrage` | `l'EXÉCUTEUR (cadrage technique)` |
| `buildRecettePrompt` | `agent-recette` | `l'ÉVALUATEUR PRODUIT` |
| `buildSprintPrompt` | `agent-sprint` | `l'AGENT DE SPRINT` |
| `buildMigrationPrompt` | `agent-migration` | `l'AGENT DE MIGRATION` |
| `buildTestPrompt` | `test-agent` | `l'AGENT DE TEST E2E` |
| `buildFreeTestPrompt` | `test-agent` | `l'AGENT DE TEST E2E` |

### Builders ADMIN — inchangés (capacités préservées)

`buildBatchSessionPrompt`, `buildLaunchPrompt`, `buildReworkPrompt`
(agent `orchestrator`) **ne portent pas** cette consigne : l'administrateur /
l'orchestrateur conserve ses capacités d'écriture.

## 5. Défense en profondeur (niveaux)

La consigne est portée aux **deux niveaux** (redondance voulue) :

1. **Définitions d'agents** (`/root/.config/opencode/agent/*.md`) — au minimum
   `agent-cadrage.md` (exécuteur) et `agent-recette.md` (évaluateur).
2. **Prompts de session** construits par le panneau (`session-bridge.mjs`) —
   présents dans le contexte dès l'ouverture de session, indépendamment de la
   définition d'agent.

## 6. Références

- **ADR-001** — Séparation Recette (évaluateur) / Cadrage technique (exécuteur).
- **ADR-002** — Rôles utilisateurs du panneau (Évaluateur, Exécuteur,
  Supervisor, Admin) : fonde la distinction rôle-aware et le fait que
  l'ADMIN/orchestrateur conserve ses capacités.
- **ADR-003** — Outils d'évaluation produit : l'évaluateur LIT le code réel
  (lecture autorisée, écriture bornée).

## 7. Limites assumées (phase 1)

La règle est **textuelle** : un agent déterminé pourrait l'ignorer, et les
sous-agents génériques ne la portent pas. Les mécanismes **déterministes**
(sandbox, garde serveur, ACL) sont **hors périmètre** de cette phase et prévus
ultérieurement.
