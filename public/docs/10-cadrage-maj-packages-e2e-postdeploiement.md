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
- [ ] Relier le run à la tâche en recette (`deployment_record` / `task_e2e`
  REGRESSION/REQUIRED) pour la preuve.

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
3. **L'agent ne traite QUE les résultats rattachés à son travail** : parmi les
   résultats du run E2E, il ignore les erreurs hors de sa portée (les écarts
   hors scope sont signalés, pas traités par lui).
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
- L'agent (orchestrateur/build-notify) reçoit le rapport E2E et ne retient que
  les échecs **liés à son travail** ; le reste est ignoré (ou signalé hors scope).

---

## 8. Références

- `docs/regles-tests-ci-cd-e2e-oniria.md` (repo oniria) — E2E niveau 2 non
  bloquant, post mise à jour active, référence composite de la preuve.
- `docs/future-outillage-packages-oniria.md` — install ≠ compilation ; étape
  d'installation distincte ; activation = version servie.
- `scripts/{deploy-package.mjs, build-package.mjs, p7-package-*.ts}`,
  `apps/admin-next/lib/oniria/packages/package-lifecycle-service.ts`.
- Registre e2e (ADR 08) : `e2e_run`, `e2e_list`, `task_e2e`.
