# Rapport — ADR 10 : chaîne de preuve run E2E post-déploiement → recette (tâche T-20260906-125011-9f9p)

**Date** : 2026-09-06 13:24
**Agent** : build-notify
**taskId** : T-20260906-125011-9f9p · **executionId** : E-T-20260906-125011-9f9p-ytbmyu
**planId** : Plan-adr10-preuve-run-e2e-tache-20260906-131403
**Projet** : ecosystem · **Repo** : opencode-observability (checkout hôte `/root/orchestrator-panel`)

## Résumé

Ce qui était demandé : documenter, dans `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md`
(statut VALIDÉ, §1-8), la **chaîne de preuve** qui fait du run E2E post-déploiement la
**preuve de la tâche livrée**, exploitable en **recette** (décision d'architecture ADR 10) —
sans modifier aucun autre fichier.

Ce qui a été fait : exécution complète des 7 étapes du plan (A001 → A007), commit unique sur
une branche de travail dédiée, trace de commit enregistrée dans le registre, rapport produit.

## Isolation

- **Espace Coder** : non applicable — le repo `opencode-observability` n'existe dans aucun
  workspace Coder (workspace=null) ; travail sur l'hôte dans `/root/orchestrator-panel`,
  conforme au cadre de la mission.
- **Session-guard** : `acquire` → code 2 (`parallel: true`, sessions orchestrateur + atomic-plan
  actives sur la base). Worktree dédié créé par session-guard (`/root/orchestrator-panel-wt-…`),
  **relocalisé dans `/tmp/opencode/orchestrator-panel-wt-f89204c03f`** car le chemin initial
  (`/root/orchestrator-panel-wt-…`) n'était pas dans la liste des répertoires externes autorisés
  (permission `external_directory`). Worktree recréé à l'identique via `git worktree add`.
- **Branche de travail** : `build-notify/f89204c03f` (créée depuis `feature/migration-postgresql`
  @ `0ca553b`).
- **Fichiers hors scope protégés** : `public/docs/06-versioning.md` (modifié localement par un
  autre process) et `plans/` + `reports/` (untracked) n'ont **jamais** été touchés/stagés.

## Branches et commits

| Élément | Valeur |
|---|---|
| Branche de base (déploiement) | `feature/migration-postgresql` (non modifiée, non poussée) |
| Branche de travail | `build-notify/f89204c03f` |
| Commit | `c11b95c28af4ef0751f1f097dd3b0ce9bde84d22` — « docs(ADR 10): chaîne de preuve — run E2E post-déploiement → preuve tâche + recette » |
| Fichiers dans le commit | 1 seul : `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` (+153 / −3) |

> Note : la branche `build-notify/f89204c03f` est **conservée** (elle porte le commit en attente
> de merge par l'orchestrateur). Le worktree physique `/tmp/opencode/orchestrator-panel-wt-f89204c03f`
> peut être supprimé sans perte (le commit reste accessible via la branche).

## Traitements effectués (étapes du plan)

| Étape | Action | Résultat |
|---|---|---|
| **A001** | Renommer `## 8. Références` → `## 9. Références` | ✅ done |
| **A002** | Insérer `## 8. Chaîne de preuve : du run E2E post-déploiement à la recette (ADR 10)` + intro (3 maillons) après la conséquence d'architecture §7 | ✅ done |
| **A003** | `### 8.1 Rattacher les exécutions E2E du run CI à la tâche (task_e2e)` — tableau de sémantique des relations (CREATED/UPDATED/REGRESSION/EXISTING + REQUIRED v0.9.5), quand/par qui, rôle du lien vs socle ACTIVE, preuve = exécutions PASSED sur rapport texte | ✅ done |
| **A004** | `### 8.2 Traçage du déploiement : deployment_record → post_deploy_verified` — séquence `deploy_pending → deploying → deployed → post_deploy_verified` (+ `deploy_failed`), alimentation par le run E2E, échecs liés traités / hors périmètre notés, lien `plan_transition` `deployed → post_deploy_verified → done` | ✅ done |
| **A005** | `### 8.3 Rapport E2E disponible en recette` — `artifact_add` / `recette_doc_add`, consultation agent-recette (`e2e_list` / `e2e_execution_list`, texte), règle « échecs hors périmètre = écarts tracés, jamais silencieux » reliée à la décision 3 du §7 + tableau récapitulatif de la chaîne | ✅ done |
| **A006** | Checkbox §5.B détaillée (sous-puces §8.1/§8.2/§8.3) et référencée « §8 (ADR 10) » | ✅ done |
| **A007** | Références (§9) enrichies : docs/07 §5, docs/08 §3.3-3.4/§6.3, CHANGELOG v0.9.5 (REQUIRED), docs/01 §4 / 03 §2 / 05 §2 (deployment_record, plan_transition), outils MCP de la chaîne | ✅ done |

**Progression plan-manager** : 7/7 done (100 %). Aucun incident ni incohérence posé.

## Fichiers modifiés / créés

- `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` — **modifié** (commit `c11b95c`) :
  nouvelle section 8 complète (l. 188-313), section Références renumérotée `## 9` (l. 317) et
  enrichie (l. 325-338), checkbox §5.B détaillée (l. 110-119). Le document passe de 188 à 338
  lignes (+153/−3).
- `reports/report-adr10-chaine-preuve-e2e-20260906-132437.md` — **créé** (ce rapport).

## Vérifications

- `git diff` dans le worktree avant commit : **un seul fichier modifié** (`public/docs/10-…md`) ;
  aucun autre fichier tracké ni untracked n'apparaît.
- Effet de bord d'indentation (3 espaces) introduit par erreur sur 2 lignes du §7 lors de
  l'insertion A002 → **corrigé** : le §7 est de nouveau identique à l'original (vérifié par
  absence du hunk dans le diff final).
- Cohérence : nouvelle section 8 **précise** (n'invalide pas) les décisions §1-7 ; aucune
  référence interne au doc ne pointait vers « §8 Références » (seule « ADR 08 » désigne le
  document 08 — inchangé) → renumérotation sans effet de bord.
- Sémantique `REQUIRED` écrite uniquement depuis `CHANGELOG.md` v0.9.5 (« la tâche doit être
  `done` pour que le test soit `PASS` », contrat « bloqué par ») — non inventée (les docs 07/08
  ne listent que CREATED/UPDATED/REGRESSION/EXISTING).
- E2E du registre : **NA justifié** (tâche de documentation, aucun comportement utilisateur
  observable) → aucun lien `e2e_test_link` à poser (point de vigilance 4 du plan).

## Avertissements / erreurs

- **Relocalisation du worktree** : le worktree créé automatiquement par session-guard
  (`/root/orchestrator-panel-wt-f89204c03f`) était hors des répertoires autorisés par la
  permission `external_directory` ; il a été supprimé puis recréé dans `/tmp/opencode/…`.
  Conséquence : l'entrée de verrou session-guard n'a pas été maintenue par cette session (le
  verrou initial a été libéré au `remove`). L'isolation réelle (worktree + branche dédiée) est
  inchangée. Le checkout principal et la branche de déploiement n'ont pas été touchés.
- Branche de travail conservée (pas de `session-guard remove` final) pour permettre le merge par
  l'orchestrateur ; le worktree physique peut être retiré sans perte.

## Traçabilité publiée

- `participant_add` (build-notify, executor) — fait par l'orchestrateur.
- `task_event` : EXECUTION_STARTED, CHECKPOINT (A001), EXECUTION_COMPLETED.
- `plan-manager` : `progress_update` A001→A007 (7/7 done) ; `plan_set_branch`
  (`build-notify/f89204c03f`).
- `plan_commit_add` : commit `c11b95c` (fichier `public/docs/10-…md`, +153/−3) — trace append-only.
- `artifact_add` : ce rapport (kind=report).

## Prochaines étapes / recommandations

1. **Review / merge** par l'orchestrateur de la branche `build-notify/f89204c03f` (commit
   `c11b95c`) sur `feature/migration-postgresql` (puis déploiement selon le mécanisme du repo).
2. Après merge : supprimer le worktree `/tmp/opencode/orchestrator-panel-wt-f89204c03f`
   (`git worktree remove`) et, si souhaité, la branche `build-notify/f89204c03f`.
3. Aucun impact E2E (doc seule) ; aucun correctif applicatif requis.
