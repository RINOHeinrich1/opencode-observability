# Synthèse de planification — ADR 10 (relier le run E2E post-déploiement à la tâche)

Générée le 2026-09-06 par `atomic-plan` pour la tâche `T-20260906-125011-9f9p`
(projet `ecosystem`, repo `opencode-observability`, checkout hôte
`/root/orchestrator-panel`, branche `feature/migration-postgresql`).

## Objectif unique (1 objectif → 1 plan)

Documenter dans `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` la
chaîne qui fait du **run E2E post-déploiement** la **preuve de la tâche livrée**
et la rend exploitable en **recette** : `task_e2e` (`REGRESSION`/`REQUIRED`),
`deployment_record post_deploy_verified`, rapport E2E disponible en recette.

## Plans générés

| Plan | Fichier | Étapes | Vérification |
|---|---|---|---|
| `Plan-adr10-preuve-run-e2e-tache-20260906-131403` | `plans/Plan-adr10-preuve-run-e2e-tache-20260906-131403.md` | A001 → A007 | VALID (intra-plan) |

## Résumé des modifications documentaires prévues

1. **Nouvelle section 8** — « Chaîne de preuve : du run E2E post-déploiement à la
   recette (ADR 10) », avec 3 sous-sections :
   - §8.1 Rattachement des exécutions E2E du run CI à la tâche (`task_e2e`
     `REGRESSION`/`REQUIRED`, quand/par qui, sémantique REQUIRED « bloqué par ») ;
   - §8.2 Traçage du déploiement (`deployment_record` `deploy_pending →
     deploying → deployed → post_deploy_verified`, lien `plan_transition`
     `deployed → post_deploy_verified → done`) ;
   - §8.3 Rapport E2E disponible en recette (`artifact_add`/`recette_doc_add`,
     consultation agent-recette, règle « écarts tracés, jamais silencieux » §7.3).
2. **Renommage** `## 8. Références` → `## 9. Références`.
3. **Checkbox §5.B** détaillée et reliée à la section 8.
4. **Références enrichies** (docs 07/08, CHANGELOG v0.9.5 `REQUIRED`,
   `deployment_record`/`plan_transition`).

## Vérifications de cohérence

- **Intra-plan** : aucune contradiction (aucun couple « supprimer + modifier »
  ni « créer + renommer » sur un même élément ; dépendances orientées
  A002→A003/A004/A005, A001→A007). Couverture 100 % (table Exigence → Étape).
- **Globale (inter-plans)** : un seul plan pour un seul objectif → aucune
  incohérence inter-plans à signaler.

## Points de vigilance

- La relation `task_e2e.REQUIRED` n'est **pas listée** dans docs/07 §5 ni
  docs/08 §3.4 (qui listent `CREATED | UPDATED | REGRESSION | EXISTING`) ; sa
  définition provient de `CHANGELOG.md` v0.9.5 et du MCP `e2e_test_link`. Le plan
  s'appuie sur cette source et la référence explicitement.
- `§7.3` désigne la **décision 3** de la section 7 (l. 153-160), la section 7 ne
  portant pas de sous-titres `7.1/7.2/7.3` explicites.
- Aucune référence interne ne pointe « §8 Références » → le renommage A001 est
  sans effet de bord.
- **E2E = NA** : tâche de documentation sans comportement utilisateur observable.
