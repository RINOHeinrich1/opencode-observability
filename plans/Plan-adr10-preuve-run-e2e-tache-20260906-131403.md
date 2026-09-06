# Plan — ADR 10 : relier le run E2E post-déploiement à la tâche (preuve + recette)

## Objectif

Documenter, dans `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md`, la
**chaîne de preuve** qui fait du **run E2E post-déploiement** la **preuve de la
tâche livrée** et la rend **exploitable en recette** : (1) rattachement des
exécutions E2E du run CI à la tâche (`task_e2e` `REGRESSION`/`REQUIRED`),
(2) traçage du déploiement jusqu'à `post_deploy_verified` (`deployment_record` +
`plan_transition`), (3) disponibilité du rapport E2E en recette.

## Contexte & raison d'être

Le fichier `10-cadrage-maj-packages-e2e-postdeploiement.md` (statut VALIDÉ,
§1 à §8) documente la mise à jour automatique des packages ONIRIA + l'E2E
post-déploiement. La chaîne qui relie le run E2E post-déploiement à la tâche
livrée n'y est aujourd'hui **qu'esquissée** : la checkbox §5.B (« Relier le run
à la tâche en recette… ») et la « conséquence d'architecture » du §7 la
mentionnent sans la détailler. Cette tâche documente précisément cette chaîne
(décision d'architecture ADR 10), **sans** modifier le code applicatif ni aucun
autre fichier.

Le contenu s'appuie sur la sémantique réelle du registre :
- relations `task_e2e` : `CREATED | UPDATED | REGRESSION | EXISTING`
  (docs/07-tests-e2e.md §5, docs/08-tests-e2e-independants.md §3.4) **+**
  `REQUIRED` (introduite v0.9.5 — cf. `CHANGELOG.md` : « la tâche doit être
  `done` pour que le test soit PASS ») ;
- `deployment_record` : `deploy_pending → deploying → deployed →
  post_deploy_verified` (+ `deploy_failed`) — cf. docs/01-architecture.md §4,
  docs/03-workflow.md §2, docs/05-reference.md §2 ;
- `plan_transition` : `… → deployed → post_deploy_verified → done`.

## Tableau de synthèse des actions

| ID | Action | Élément textuel | Fichier (source = cible) | Raison | Livrable attendu |
|---|---|---|---|---|---|
| A001 | Renommer le titre de section `## 8. Références` en `## 9. Références` | Titre de section (l. 180) | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Libérer la numérotation pour insérer la nouvelle section 8 sans renuméroter tout le document | Titre « ## 9. Références » |
| A002 | Insérer le titre + intro de la nouvelle section `## 8. Chaîne de preuve… (ADR 10)` | Nouveau bloc inséré après la fin de la conséquence d'architecture §7 (l. 176) et avant le `---` (l. 178) | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Poser la section dédiée qui documente l'ADR 10 | Section 8 introduite (titre + paragraphe intro) |
| A003 | Insérer la sous-section `### 8.1 Rattacher les exécutions E2E du run CI à la tâche (task_e2e)` | Sous-section dans la section 8 | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Documenter le rattachement des exécutions à la tâche (`REGRESSION`/`REQUIRED`) + quand/par qui + sémantique REQUIRED | §8.1 rédigé |
| A004 | Insérer la sous-section `### 8.2 Traçage du déploiement : deployment_record → post_deploy_verified` | Sous-section dans la section 8 | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Documenter la séquence de transitions + lien plan_transition `deployed → post_deploy_verified → done` | §8.2 rédigé |
| A005 | Insérer la sous-section `### 8.3 Rapport E2E disponible en recette` | Sous-section dans la section 8 | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Documenter le rattachement du rapport + consultation recette + règle « écarts tracés, jamais silencieux » | §8.3 rédigé |
| A006 | Réécrire/détailler la checkbox §5.B (l. 110-111) | Checkbox « Relier le run à la tâche en recette… » | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Rendre la checkbox explicite et la lier à la nouvelle section 8 | Checkbox §5.B détaillée + référence croisée §8 |
| A007 | Enrichir la section Références (renommée §9) avec les références de la sémantique exacte | Liste de références (après l. 188) | `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Tracer les sources de la sémantique (task_e2e REQUIRED, deployment_record, plan_transition) | Références complétées |

## Fichiers concernés

| Fichier | Type de modification |
|---|---|
| `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` | Modification (ajout section 8 + renumérotation Références + détail checkbox §5.B + enrichissement références) |

Aucun autre fichier n'est touché (contrainte de scope).

## Livrables attendus

- `public/docs/10-cadrage-maj-packages-e2e-postdeploiement.md` enrichi :
  - nouvelle section `## 8. Chaîne de preuve : du run E2E post-déploiement à la recette (ADR 10)` avec 3 sous-sections (§8.1 `task_e2e`, §8.2 `deployment_record`, §8.3 rapport en recette) ;
  - section Références renumérotée `## 9` et complétée (docs 07/08, CHANGELOG v0.9.5, deployment_record/plan_transition) ;
  - checkbox §5.B détaillée et reliée à la section 8 ;
  - aucune contradiction introduite avec les §1-8 validés.

## Ordre & dépendances

```
A001 ──► A007
A002 ──► A003 ──► A004 ──► A005
A002 ──► A006
```

- **A001** (renommer Références) est indépendant ; il doit précéder **A007** (qui insère dans la section renommée).
- **A002** (insérer le titre/intro de la section 8) doit précéder **A003**, **A004**, **A005** (sous-sections insérées dans la section 8) et **A006** (référence croisée vers §8).
- **A003 → A004 → A005** : sous-sections insérées dans l'ordre de numérotation au sein de la section 8.
- Enchaînement recommandé : `A001 → A002 → A003 → A004 → A005 → A006 → A007`.

## Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|---|---|---|
| Rattacher les exécutions E2E du run CI à la tâche (`task_e2e` `REGRESSION`/`REQUIRED`), préciser quand/par qui et la sémantique `REQUIRED` (« bloqué par ») | A003 (+ A006, A007) | ✅ Oui |
| `deployment_record post_deploy_verified` : séquence `deploy_pending → deploying → deployed → post_deploy_verified` + lien `plan_transition` `deployed → post_deploy_verified → done` | A004 (+ A007) | ✅ Oui |
| Rapport E2E dispo en recette : rattachement (artifact_add / recette_doc_add), consultation agent-recette, règle « échecs hors périmètre = écarts tracés, jamais silencieux » | A005 | ✅ Oui |
| Ne modifier que le fichier `10-cadrage-…md` (pas de code, pas d'autre fichier) | A001–A007 | ✅ Oui |
| Cohérence avec les §1-8 déjà validés (aucune contradiction) | A001, A002, A006, A007 | ✅ Oui |

## Vérification de cohérence

- **A001** (renommer `## 8. Références`) et **A002** (insérer `## 8. Chaîne de preuve`) ciblent des éléments **distincts** (titre existant vs nouveau bloc) → pas de conflit.
- **A003/A004/A005** sont insérés **dans** la section créée par A002 (éléments distincts entre eux, ordre géré par les dépendances) → pas de conflit.
- **A006** modifie les lignes 110-111 (checkbox §5.B), **A007** ajoute des lignes après la l. 188 (Références) → aucun chevauchement.
- Aucune paire « supprimer + modifier/renommer » sur un même élément ; aucune paire « créer + renommer » sur le même élément. Aucune étape ne lit/modifie un élément créé par une étape ultérieure (les dépendances sont orientées A002→A003/A004/A005, A001→A007).
- **Cohérence globale (inter-plans)** : un seul plan pour un seul objectif → pas de plan concurrent sur ce fichier.
- **Cohérence avec l'existant** : la nouvelle section 8 **précise** (n'invalide pas) la conséquence d'architecture §7 et la checkbox §5.B ; les §1-7 restent intacts.

**Résultat : VALID** (aucune contradiction, couverture 100 %, étapes atomiques).

## Risques & notes (points de vigilance)

1. **Sémantique `REQUIRED` absente des docs 07/08** : docs/07 §5 et docs/08 §3.4 ne listent que `CREATED | UPDATED | REGRESSION | EXISTING`. La relation `REQUIRED` n'est documentée que dans `CHANGELOG.md` v0.9.5 et le MCP `e2e_test_link`. Le plan s'appuie donc sur cette source pour la définition exacte de `REQUIRED` (« la tâche doit être `done` pour que le test soit PASS », contrat « bloqué par ») et référence le CHANGELOG en A007. Ne pas « inventer » une sémantique REQUIRED absente des docs 07/08.
2. **§7.3** : la règle « échecs hors périmètre = écarts tracés, jamais silencieux » correspond au **point 3** de la section 7 (l. 153-160). La référence `§7.3` dans la nouvelle section désigne ce point (la section 7 numérote ses décisions 1-4, sans sous-titres `7.1/7.2/7.3` explicites).
3. **Renommage Références** : aucune référence interne au document ne pointe « §8 Références » ; seule « ADR 08 » (l. 188) désigne le document 08, pas la section 8 — le renommage A001 est donc sans effet de bord.
4. **E2E = NA** : tâche de documentation sans comportement utilisateur observable → pas de lien `e2e_test_link` à poser (pas de stratégie E2E).
