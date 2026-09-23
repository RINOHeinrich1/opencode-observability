# ADR-005 — Sélection des modèles d'exécution des sessions du panneau (cohérence clé active fournisseur ↔ frontmatter des agents)

- **Statut** : Accepté
- **Date** : 2026-09-23
- **Périmètre** : projet `ecosystem` — repo `opencode-observability`
- **Origine** : cadrage `CT-mudra9eh-tgqa` (constat 13, élément 162)
- **Modèle de référence** : le modèle **déclaré dans le frontmatter** de l'agent (source unique de vérité, résolu dynamiquement) — aujourd'hui `deepseek/deepseek-v4-pro` pour l'agent `orchestrator`. La référence n'est **jamais** une version figée : elle suit le frontmatter.

## Contexte

Le panneau lance des sessions opencode (tâche, reprise, recette, cadrage, sprint, migration, batch, test) via `session-bridge.mjs` qui force `--model = readAgentModel(agent)`, lu depuis le frontmatter de l'agent (ex. `orchestrator → deepseek/deepseek-v4-pro`, `orchestrator.md` — modèle réellement déclaré, susceptible d'évoluer). En parallèle, le panneau gère des clés fournisseur actives (table `provider_keys`, `provider-auth.mjs`) : l'activation d'une clé détermine quel fournisseur sert réellement les appels. Aucun contrôle de cohérence n'existe entre le catalogue servi par la clé active et le modèle déclaré par chaque agent.

Constat recette du 23/09/2026 (item 13, HIGH) : après changement de la clé active (deepseek), le batch d'orchestration en mode session unique ne démarre plus — la clé active ne sert plus le modèle déclaré par le frontmatter (qui a évolué) — avec un échec silencieux côté panneau (timeout 20 s puis throw générique « orchestrator indisponible »).

## Décision

La résolution du modèle d'exécution des sessions lancées par le panneau DOIT être cohérente avec la clé active du fournisseur.

- **(a)** À l'activation ou la création d'une clé (et à l'édition du modèle d'un agent), vérifier le catalogue de modèles servi et signaler explicitement les agents dont le modèle déclaré n'est pas servi (proposition de mise à jour du frontmatter ou avertissement non bloquant).
- **(b)** Au lancement d'une session, **politique A PAR DÉFAUT** : si le modèle déclaré (frontmatter) n'est pas servi par la clé active, la session **ÉCHOUE EXPLICITEMENT** avec une raison lisible dans l'UI (modèle demandé + fournisseur de la clé active + catalogue servi) — jamais de blocage silencieux ni de timeout muet. La **politique B** (fallback vers un modèle compatible servi par la clé active) n'est autorisée qu'en **opt-in EXPLICITE et tracé** dans l'événement de session (règle documentée, jamais implicite).

Le modèle par défaut reste celui **déclaré dans le frontmatter** de l'agent ; le workflow de lancement doit capturer la sortie du process (`child.stderr`) pour remonter la vraie cause au lieu du timeout 20 s générique.

## Conséquences

- Toutes les sessions lancées par le panneau sont concernées (la correction ne doit pas se limiter au batch).
- Le workflow de lancement doit capturer la sortie du process (`stderr`) pour remonter la vraie cause au lieu du timeout générique.
- L'interface Fournisseurs (feature livrée `T-20260922-181529-e3vb`) doit porter le contrôle de cohérence clé active ↔ modèles déclarés (catalogue réel ou repli : liste des modèles des frontmatters).
- Impact attendu : fin des échecs silencieux de lancement de session après changement de clé.
- **Non-périssabilité** : l'ADR et les oracles E2E ne doivent pas figer une version de modèle ; ils résolvent le modèle **déclaré** (dynamiquement) et ne citent une version qu'à titre d'exemple.
