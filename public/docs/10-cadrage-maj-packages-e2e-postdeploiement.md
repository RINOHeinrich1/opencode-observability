# 10 — Cadrage : mise à jour automatique des packages ONIRIA + E2E post-déploiement (ADR)

> **Statut : VALIDÉ (2026-09-06) — décisions actées (§7). À implémenter.**
> Objectif : supprimer l'intervention humaine pour mettre à jour un package
> (actuellement l'admin active via `/v2/packages`) en réutilisant **le même
> mécanisme**, afin que la voie normale du panel reste garantie ; puis exécuter
> **automatiquement les tests E2E de recette post-déploiement** sur la préprod.

---

## 1. Contexte & problème

**Aujourd'hui (docs/regles-tests-ci-cd-e2e-oniria.md §4), pour qu'un comportement
livré par un package soit testable en E2E :**
1. Le pipeline `package-build-deploy.yml` (branche `packages/<nom>`) **stages**
   les assets dans `var/oniria/packages/<id>/<version>/` — **sans**
   installation/activation en base ;
2. **L'administrateur met à jour / active le package dans `/v2/packages`**
   (opération manuelle, hors pipeline) ;
3. Approbation humaine + run E2E.

**Problèmes :**
- La mise à jour (étape 2) est **manuelle** → goulot, risque d'oubli, la chaîne
  « livrer → tester » est cassée ;
- Les **tests E2E de recette post-déploiement** ne s'exécutent pas
  automatiquement une fois la version active sur la préprod.

**Note cœur vs package :** le **cœur ONIRIA** (`core-build-deploy.yml`) n'a pas
de notion de version de package : une fois poussé sur `oniria-preprod`, les E2E
sont exécutables **directement** (pas de mise à jour nécessaire).

---

## 2. Décisions validées (utilisateur)

1. **Package : ingestion + activation AUTOMATIQUES** dans le pipeline
   `package-build-deploy.yml`, en réutilisant **exactement le mécanisme de
   `/v2/packages`** (les mêmes fonctions/scripts que la voie admin) — pour
   garantir qu'une mise à jour faite ensuite depuis le panel s'installe sans
   souci (même chemin de code).
2. **Cœur : rien à changer côté « mise à jour »** — les tests E2E sont
   exécutables directement après push sur `oniria-preprod`.
3. **Run E2E automatique post-activation** (non bloquant pour le déploiement).

---

## 3. Le mécanisme de la « voie normale » `/v2/packages` (à réutiliser tel quel)

Chaîne identifiée dans le code (repo oniria) :
- **Build** → archive immutable + `ui.integrity` (`build-package.mjs`,
  `check-package-integrity.mjs`) ;
- **Stage** : `stageV3PackageAssets` → `var/oniria/packages/<id>/<version>/`
  (assets hydratés, jamais de compilation à l'installation) ;
- **Ingestion/installation** : `installOrUpdateV3Package` /
  `installOrUpdateSignedV3PackageArchive` (service admin-next
  `package-lifecycle-service.ts`) ; scripts `p7-package-ingest.ts`
  (archive signée + checksum), `p7-package-install.ts` (SQL + assets) ;
- **Activation** : release `active` (RPC lifecycle — `startAndCheckV3PackageRelease`,
  `oniria_package_releases.status='active'`), scripts `p7-package-activation.ts`
  / `p7-package-lifecycle.ts`.

**Principe normatif (docs/future-outillage-packages-oniria.md) :**
> « Ne jamais déclencher l'installation depuis la CI de build **sans étape
> distincte**. » → l'automatisation sera une **étape distincte** du workflow,
> après le stage, qui appelle l'installateur réel (pas un raccourci de build).

**Garantie demandée :** utiliser les **mêmes fonctions** que `/v2/packages`
(et non un chemin « spécial CI ») → un utilisateur qui met à jour via le panel
passe exactement par le code déjà validé par la CI.

---

## 4. Cible

```
branche packages/<nom> (push)
   │
   ▼  job test (ubuntu) : build + integrity + validate   [gate Niveau 1]
   │
   ▼  job deploy (runner preprod-vm, push only)
       1. deploy-package.mjs : merge packages/<nom> dans oniria-preprod
       2. build + STAGE  → var/oniria/packages/<id>/<version>/
       3. [NOUVEAU] INGESTION + ACTIVATION AUTO  (étape distincte, mécanisme /v2/packages)
       4. [NOUVEAU] run E2E de recette post-activation (non bloquant, registre e2e)
```

- **Cœur** : push sur `oniria-preprod` → (déploiement) → **run E2E direct**
  (pas d'activation de package).
- Les E2E restent **non bloquants** pour le déploiement (un échec E2E n'annule
  pas le déploiement) ; ils alimentent la recette de la tâche.

---

## 5. Plan d'implémentation (à découper en sous-tâches)

### A. Repo oniria (PBN) — automatiser la mise à jour package
- [ ] **Étape d'ingestion + activation** dans `package-build-deploy.yml` (job
  deploy, après le stage) : appeler l'installateur `/v2/packages` réel
  (script dédié : `p7-package-ingest` ou un runner qui réutilise
  `installOrUpdateSignedV3PackageArchive`, puis `promote` active), **étape
  distincte**, jamais un raccourci de build.
- [ ] (Cœur) aucune modification de mise à jour ; vérifier seulement que le run
  E2E cœur post-push est câblé.

### B. Registre / orchestration — run E2E post-déploiement automatique
- [ ] Un déclencheur « post-déploiement » (notifier ou script CI) exécute le
  run E2E de recette depuis le registre `e2e_tests` (`origin=ci`), contre la
  cible préprod, une fois la version **active** (référence composite : version
  active + SHA cœur/package — cf. §4 doc E2E oniria).
- [ ] Relier le run à la tâche en recette pour la preuve — chaîne détaillée au
  **§8 (ADR 10)** :
      - `e2e_test_link` (`task_e2e` `REGRESSION`/`REQUIRED`) : désigner, parmi
        le socle ACTIVE exécuté, les tests qui font preuve pour la tâche
        (§8.1) ;
      - `deployment_record` : tracer `deploy_pending → deploying → deployed →
        post_deploy_verified`, le run E2E alimentant `post_deploy_verified`
        (§8.2) ;
      - rapport E2E rattaché (`artifact_add` / `recette_doc_add`) et consultable
        en recette via `e2e_list` / `e2e_execution_list` (§8.3).

### C. Tests E2E (recette)
- [ ] Recréer/activer les tests E2E madatalk + oniria pertinents (le registre
  est vide après la purge) — socle E2E post-déploiement.

### D. Recette finale
- [ ] Valider la chaîne complète : push package → stage → **activation auto** →
  **E2E auto** → preuve rattachée.

---

## 6. Risques & points de vigilance

- **Single Supabase préprod partagée** : séquencer les runs (un seul à la fois) ;
  données des runs identifiables/nettoyables.
- **Pas de run contre un comportement non actif** (faux négatif) → si
  l'activation a échoué, état bloqué + demande humaine, jamais de run d'office.
- **Règle stricte §2.6 retirée** (l'agent ne gérait jamais l'activation) —
  remplacée par ta règle cible : *mise à jour automatique du package en base
  avec exactement les mêmes fonctions que v2/packages*, pour que la mise à jour
  depuis le panel s'installe pareil.
- **Installation ≠ compilation** : l'étape d'ingestion n'exécute jamais
  npm/tsc/webpack (les assets sont déjà construits/stagés).
- **Dépôt ≠ activation** : ne pas confondre le stage (fichiers dispo) et
  l'activation (version servie) ; c'est l'activation auto qui rend la version
  visible, avant le run E2E.
- L'E2E n'est **jamais un gate** du déploiement (Niveau 1 seul l'est).

---

## 7. Décisions finales (utilisateur — 2026-09-06)

1. **Ingestion + activation auto = installateur LOCAL du repo** : l'étape
   distincte du workflow appelle l'installateur du dépôt
   (`installOrUpdateV3Package` / promote `active`), **sans générer d'archive
   signée en CI** — exactement les mêmes fonctions que la voie admin `/v2/packages`.
2. **Run E2E post-déploiement = TOUT le socle ACTIVE** du registre :
   le CI/CD se connecte au registre `e2e_tests` et récupère les tests **ACTIVE**
   des projets couverts (plus large, plus fidèle à « après déploiement, la
   préprod doit être saine »). Périmètre cible : projets `madatalk` (front) et
   `oniria` (console).
3. **L'agent ne TRAITE QUE les résultats rattachés à son travail** : parmi les
   résultats du run E2E, il **corrige** uniquement les échecs liés à son
   périmètre. Les échecs **hors périmètre ne sont pas corrigés par lui, MAIS
   DOIVENT ÊTRE NOTÉS** : il les consigne comme **écarts tracés** (constat
   visible, ex. `task_event`/synthèse de recette, ou mention explicite au
   rapport) — jamais silencieux. Selon le contexte, il peut en proposer le
   traitement (ex. tâche émergente ou élément de recette) sans l'exécuter
   lui-même.
4. **Déclencheur = étape CI finale** appelant le registre (`origin=ci`) : le
   workflow (runner auto-hébergé, qui a accès à l'hôte et donc au MCP
   task-orchestrator) lance, en dernière étape non bloquante, un run E2E qui
   résout les tests ACTIVE du registre et les exécute contre la préprod.

**Conséquence d'architecture (pipeline ↔ registre) :**
- Le runner auto-hébergé préprod exécute un script d'infra (repo
  `opencode-scripts`) qui appelle le MCP `e2e_run` (`origin=ci`) avec la liste
  des tests ACTIVE résolus via `e2e_list(status=ACTIVE)` du registre.
- Le déploiement n'est **jamais bloqué** par l'E2E (Niveau 1 = gate seul) ;
  le run E2E alimente la recette/preuve de la tâche (`deployment_record`,
  `task_e2e`).
- L'agent (orchestrateur/build-notify) reçoit le rapport E2E et ne retient pour
  **traitement** que les échecs **liés à son travail** ; les échecs **hors
  périmètre sont notés** (consignés comme écarts tracés — jamais silencieux),
  sans être corrigés par lui.

---

## 8. Chaîne de preuve : du run E2E post-déploiement à la recette (ADR 10)

Cette section détaille la **chaîne de preuve** qui fait du **run E2E
post-déploiement** (§5.B, §7) la **preuve de la tâche livrée**, exploitable en
**recette**. Elle repose sur trois maillons :

1. le **rattachement des exécutions E2E du run CI à la tâche** via `task_e2e`
   (`REGRESSION`/`REQUIRED`) — §8.1 ;
2. le **traçage du déploiement** jusqu'à `post_deploy_verified`
   (`deployment_record` + `plan_transition`) — §8.2 ;
3. la **disponibilité du rapport E2E en recette** — §8.3.

Cette section **précise** les décisions §1-7 (en particulier la **décision 3 du
§7** : échecs hors périmètre notés, jamais silencieux) **sans les invalider** :
le run E2E reste non bloquant pour le déploiement (Niveau 1 = seul gate) et
l'agent ne traite que les résultats rattachés à son travail.

### 8.1 Rattacher les exécutions E2E du run CI à la tâche (`task_e2e`)

Le run CI post-déploiement exécute **tout le socle ACTIVE** du registre
(décision 2 du §7). Pour qu'il devienne la **preuve d'une tâche livrée**, les
tests dont les résultats comptent pour cette tâche doivent lui être
**rattachés** dans le registre via `task_e2e` (N:N tâche ↔ test) — outil
`e2e_test_link` (MCP task-orchestrator).

**Sémantique des relations** (docs/07 §5, docs/08 §3.4, CHANGELOG v0.9.5) :

| Relation | Sens |
|---|---|
| `CREATED` | test créé par la tâche (spec produit — « create » de l'analyse d'impact) |
| `UPDATED` | test modifié par la tâche (scénario adapté — « update ») |
| `REGRESSION` | test de **non-régression** : comportement existant que la livraison peut casser (« keep ») |
| `EXISTING` | test existant simplement associé à la tâche |
| `REQUIRED` | contrat « bloqué par » (v0.9.5) : **la tâche doit être `done` pour que le test soit `PASS`** — le test formalise le comportement attendu que la tâche doit livrer |

**Quand / par qui** : le rattachement est posé au fil de la tâche par l'agent
qui la traite (`atomic-plan` en exécution planifiée, `build-notify` en exécution
directe — cf. docs/08 §6.1), dès qu'un test pertinent est identifié ou
enregistré ; il est **vérifié / ajusté** au moment de rattacher le run
post-déploiement à la tâche. Chaque lien porte une `reason` (justification
tracée, obligatoire).

**Pour le run post-déploiement** : le lien `task_e2e` ne change pas le périmètre
du run (toujours le socle ACTIVE, décision 2 du §7) — il **désigne**, parmi les
résultats du run, ceux qui font **preuve pour la tâche** :

- `REGRESSION` pour les tests protégeant les comportements que la livraison
  touche (non-régression) ;
- `REQUIRED` pour les tests contractuels du comportement livré : `PASS` attendu
  une fois la tâche terminée (donc après le déploiement de sa version).

Les exécutions du run CI appartiennent au **test** (`e2e_executions`,
`origin=ci`, docs/08 §3.3) ; elles sont consultables par tâche
(`e2e_execution_list(taskId=…)`). La **preuve de la tâche** = pour chaque test
lié, l'exécution du run post-déploiement est `PASSED` (verdict posé sur le
**rapport texte**, docs/08 §6.3).

### 8.2 Traçage du déploiement : `deployment_record` → `post_deploy_verified`

Le déploiement est tracé dans le registre via `deployment_record` — séquence
`deploy_pending → deploying → deployed → post_deploy_verified` (+
`deploy_failed`) — et **relie le cycle du plan** (`plan_transition`) à la preuve
E2E (docs/01 §4, docs/03 §2, docs/05 §2).

**Séquence :**

1. **`deploy_pending`** — le plan est `merged` (branche de déploiement à jour) ;
   le déploiement est attendu.
2. **`deploying` → `deployed`** — le pipeline déploie (merge de la branche dans
   la cible, ingestion + activation auto → version active servie sur la
   préprod). `deployed` n'est posé qu'une fois la version **active**. En cas
   d'échec du pipeline (ex. activation impossible) → `deploy_failed`, état
   bloqué + demande humaine, **jamais de run d'office** sur un comportement non
   actif (§6).
3. **Run E2E post-déploiement** — étape CI finale **non bloquante** (décision 4
   du §7) : `e2e_run` (`origin=ci`) contre la préprod. Ses résultats (rapports
   texte) **alimentent le passage à `post_deploy_verified`** :
   - tests liés `PASSED` → déploiement vérifié ;
   - échecs **liés au périmètre** de la tâche → traitement agent (correction +
     relance, 3 itérations max — docs/08 §6.3), puis `post_deploy_verified` si
     résolu ; sinon **décision humaine** (`decision_request`) — jamais de
     validation silencieuse ;
   - échecs **hors périmètre** → **notés** en écarts tracés (décision 3 du §7,
     cf. §8.3) : ils n'empêchent pas `post_deploy_verified`, mais ne sont jamais
     silencieux.
4. **Lien `plan_transition`** : le plan suit `… → merged → deploy_pending →
   deploying → deployed → post_deploy_verified → done` (docs/01 §4, docs/03 §2,
   docs/05 §2). L'orchestrateur transitionne le plan vers `post_deploy_verified`
   quand la vérification post-déploiement (dont le run E2E) est traitée, puis
   vers `done`. La tâche ne passe `done` que lorsque **tous** ses plans sont
   `done` (docs/03 §2).

C'est ainsi que le run E2E est **ancré dans la machine à états** : il n'est pas
un artefact à part, il **conditionne l'avancement du plan** vers la fin du cycle
(`post_deploy_verified → done`).

### 8.3 Rapport E2E disponible en recette

Chaque exécution E2E produit un **rapport texte** (`report_artifact_id`) —
preuve partagée IA + humain (la vidéo reste une preuve **humaine**, jamais
interprétée par l'IA — docs/07 §7, docs/08 §6.3). Pour qu'une recette puisse
s'appuyer dessus :

- **rattachement** : `artifact_add` (kind=`report`, chemin du rapport) sur la
  tâche, puis `recette_doc_add` pour lier le rapport à la recette couvrant la
  tâche (nature : « preuve E2E du run post-déploiement ») ;
- **consultation par `agent-recette`** : via `e2e_list(taskId=…)` /
  `e2e_execution_list` — lecture du **rapport texte uniquement** ; l'agent peut
  aussi relancer un test si besoin (`e2e_run`, `origin=recette`) ; verdict posé
  sur le rapport texte (docs/08 §6.3) ;
- **règle « échecs hors périmètre = écarts tracés, jamais silencieux »**
  (décision 3 du §7) : tout échec hors périmètre constaté dans le rapport est
  **consigné** (constat visible : `task_event`, mention explicite au rapport /
  synthèse de recette, voire **élément de recette** `recette_item_add` ou tâche
  émergente **proposée**) — il n'est ni corrigé par l'agent (hors périmètre), ni
  passé sous silence. La recette humaine tranche in fine
  (`recette approved` / `rejected`), éclairée par ces écarts tracés.

**Récapitulatif de la chaîne de preuve :**

| Maillon | Outil / registre | Résultat |
|---|---|---|
| Rattacher le run à la tâche | `e2e_test_link` (`task_e2e` `REGRESSION`/`REQUIRED`) | tests « preuve » identifiés pour la tâche |
| Tracer le déploiement | `deployment_record` (`deploy_pending → deploying → deployed → post_deploy_verified`) | état du déploiement visible ; le run E2E alimente `post_deploy_verified` |
| Clore le plan / la tâche | `plan_transition` (`deployed → post_deploy_verified → done`) | plan `done` → tâche `done` (tous plans done) |
| Prouver en recette | `artifact_add` / `recette_doc_add` + `e2e_list` / `e2e_execution_list` | rapport texte consultable par `agent-recette` et l'humain |

---

## 9. Références

- `docs/regles-tests-ci-cd-e2e-oniria.md` (repo oniria) — E2E niveau 2 non
  bloquant, post mise à jour active, référence composite de la preuve.
- `docs/future-outillage-packages-oniria.md` — install ≠ compilation ; étape
  d'installation distincte ; activation = version servie.
- `scripts/{deploy-package.mjs, build-package.mjs, p7-package-*.ts}`,
  `apps/admin-next/lib/oniria/packages/package-lifecycle-service.ts`.
- Registre e2e (ADR 08) : `e2e_run`, `e2e_list`, `task_e2e`.
- `docs/07-tests-e2e.md` §5 et `docs/08-tests-e2e-independants.md` §3.3-§3.4,
  §6.3 — modèle `task_e2e` (relations `CREATED | UPDATED | REGRESSION |
  EXISTING`), exécutions par test (`origin`), verdict sur **rapport texte**,
  consultation recette (`e2e_list` / `e2e_execution_list`).
- `CHANGELOG.md` v0.9.5 — relation `task_e2e.REQUIRED` (« la tâche doit être
  `done` pour que le test soit `PASS` », contrat « bloqué par »).
- `docs/01-architecture.md` §4, `docs/03-workflow.md` §2,
  `docs/05-reference.md` §2 — `deployment_record` (`deploy_pending → deploying →
  deployed → post_deploy_verified`, + `deploy_failed`) et `plan_transition`
  (`… → deployed → post_deploy_verified → done`).
- MCP task-orchestrator — outils de la chaîne de preuve : `e2e_test_link`,
  `deployment_record`, `plan_transition`, `artifact_add`, `recette_doc_add`,
  `e2e_list`, `e2e_execution_list`.
