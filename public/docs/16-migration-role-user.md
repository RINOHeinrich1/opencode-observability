# 16 — Migration et suppression du rôle « user » (v0.9.70)

> **FR** — Décision et règle de **suppression du rôle `user`** du panneau :
> migration **idempotente, réversible et tracée** des comptes existants vers
> `executeur` (règle explicite **Ronald → executeur**, défaut → executeur), puis
> **retrait du rôle** du parcours de création/proposition sans casser les
> invariants ACL. **EN** — Migration and removal of the panel's `user` role.
>
> Décision d'architecture : **ADR-002** (Accepté) — « Rôles utilisateurs du
> panneau : Évaluateur, Exécuteur, Supervisor, Admin (suppression du rôle user) ».
> Complète [`05-reference.md`](05-reference.md) et [`02-composants.md`](02-composants.md).

## 1. Pourquoi — le rôle `user` est ambigu

ADR-002 a introduit **quatre rôles** (`admin`, `supervisor`, `evaluateur`,
`executeur`). Le rôle historique `user` (ni évaluateur, ni exécuteur) est devenu
**ambigu** : il « peut créer/agir » et ne voit que ses propres créations, sans
recouvrir un périmètre fonctionnel clair. La recette `RECT-mucf1s9n-qdmv` a acté
sa suppression **à terme**, avec **migration obligatoire** des comptes existants
— notamment **Ronald → Exécuteur**.

## 2. Règle de migration

| Élément | Règle |
|---|---|
| Compte **Ronald** | migré explicitement vers **`executeur`** |
| Tout autre compte `role='user'` | migré vers **`executeur`** (défaut) |
| Rôle cible valide | `admin` \| `supervisor` \| `evaluateur` \| `executeur` (jamais `user`) |

La migration est **explicite** : elle n'est **jamais** déclenchée par
`normalizeRole` (le vecteur de normalisation n'écrit pas d'audit). Elle passe
exclusivement par le CLI `scripts/migrate-user-role.mjs`.

## 3. Mécanisme (idempotent, réversible, tracé)

### 3.1 Table d'audit `user_role_migrations`

| Colonne | Rôle |
|---|---|
| `id` | identifiant de la ligne d'audit |
| `user_id`, `username` | compte migré |
| `from_role`, `to_role` | `user` → rôle cible |
| `rule` | `explicit` (règle nommée) \| `default` |
| `migrated_at`, `migrated_by` | horodatage + acteur |
| `reverted_at`, `reverted_by` | annulation (l'audit est **conservé**, jamais supprimé) |

### 3.2 Fonctions (`panel-db.mjs`)

- `migrateUserRole({ targetRole='executeur', rules={Ronald:'executeur'}, by })`
  — sélectionne `WHERE role='user'` (`FOR UPDATE`) en **transaction**,
  met à jour `users.role` et écrit une ligne d'audit par compte.
- `revertUserRoleMigration({ migrationIds, all, by })`
  — restaure `from_role` et pose `reverted_at`/`reverted_by`.
- `listUserRoleMigrations()` — lecture de l'audit (tri `migrated_at DESC`).

### 3.3 CLI `scripts/migrate-user-role.mjs`

```
node scripts/migrate-user-role.mjs [--dry-run] [--json]      # défaut : DRY-RUN
node scripts/migrate-user-role.mjs --apply [--by=<acteur>]   # écriture + audit
node scripts/migrate-user-role.mjs --revert (--all | --migration-id=<id> ...)
```

**`--dry-run` est le mode PAR DÉFAUT** : aucune écriture sans `--apply`
explicite. Le script **n'est pas appelé par `ensureReady()`** — **aucune
migration automatique au démarrage du serveur**.

### 3.4 Idempotence & réversibilité

- **Idempotente** : le filtre `WHERE role='user'` fait qu'une seconde exécution
  ne migre plus rien (aucune double ligne d'audit).
- **Réversible (données)** : `--revert` restaure `from_role` depuis l'audit.
- **Réversibilité fonctionnelle** : après le retrait du code (Phase B), un
  `--revert` restaure `role='user'` **en base**, mais `normalizeRole`/`currentUser`
  le **re-coercent en `executeur`** (fail-safe legacy). Un rollback fonctionnel
  complet nécessite donc **aussi** un `git revert` du retrait.

## 4. Retrait du rôle (parcours de création/proposition)

Le rôle `user` est retiré des **sources uniques** du panneau :

| Source | Avant | Après |
|---|---|---|
| `panel-db.mjs` `ROLES` | `…, "executeur", "user"` | `…, "executeur"` |
| `panel-db.mjs` `normalizeRole` (repli) | `"user"` | `"executeur"` (fail-safe) |
| `panel-db.mjs` `createUser` / `updateUserRole` (défaut) | `"user"` | `"executeur"` |
| Schéma `users.role DEFAULT` | `'user'` | `'executeur'` |
| `server.mjs` login / création / validation rôle | accepte `user` | refuse `user` (400) |
| `server.mjs` garde d'écriture `role === "user"` | présente | retirée |
| `auth.mjs` whitelist / `isUser` / `ownerScope` / `recetteOwnerScope` | `user` | retiré (fail-safe `executeur`) |
| `auth.mjs` `ROLE_PAGES.user` / `allowedPages` (repli) | `ALL_PAGES` | retiré / **fail-closed** (`[]`) |
| `public/app.js` libellés, options, whoami, bandeau | `user` | retirés |

### Invariants ACL préservés (ADR-002)

- **supervisor** : lecture seule stricte (inchangé).
- **evaluateur** : écrivain sur **ses propres recettes** uniquement
  (`recetteOwnerScope`).
- **executeur** : périmètre **sprint actif** du projet (inchangé).
- **admin** : plein accès (inchangé).

### Fail-safe legacy `user` → `executeur`

Un enregistrement **legacy** `role='user'` non migré n'est **jamais** exposé tel
quel : `normalizeRole` (serveur) et `currentUser` (session) le résolvent en
**`executeur`**. `allowedPages` est **fail-closed** (rôle inconnu → `[]`). Ainsi,
retirer le rôle du code **avant** l'application effective de la migration ne
casse aucun compte.

## 5. Fenêtre de dépréciation & ordre d'application

1. **Phase A (données)** : table d'audit + fonctions + CLI + **preuve dry-run**.
2. **Application de la migration (`--apply`)** : **décision humaine explicite**
   (le plan ne l'automatise pas). Tant qu'elle n'est pas appliquée, le
   **fail-safe** couvre les comptes `user`.
3. **Phase B (code)** : retrait du rôle du parcours de création/proposition,
   invariants ACL préservés.
4. **`--revert`** reste possible (audit conservé).

## 6. Vérifications

- **C001** — plus aucune occurrence de **rôle** `user` (hors usages génériques
  `username`/`user_id`/`user_projects`…).
- **C002** — fail-safe : un enregistrement legacy `role='user'` → `role:
  executeur` (jamais `user`).
- **C003** — non-régression : `admin`, `supervisor`, `evaluateur`, `executeur`
  (login + `/api/me` + pages) inchangés.

## 7. Portée

- **Repo** : `opencode-observability` (panneau).
- **Hors périmètre (suivi)** : la plomberie `ownerScope` (`registryStats`,
  `registryTasks`, `registryE2ETests`) reste en place mais **inactive**
  (`ownerScope` toujours `null`) — nettoyage complet à planifier séparément.
- **E2E** : **NA** — le repo ne contient aucune configuration Playwright ni test
  instrumenté ; vérification par `grep` + smoke `GET /api/me`.
