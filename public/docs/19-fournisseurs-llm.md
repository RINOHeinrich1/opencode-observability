# 19 — Fournisseurs LLM : clés multiples par fournisseur avec clé active

> Onglet **« Fournisseurs »** de la page **Écosystème** (panneau), **réservé aux
> administrateurs** de l'**organisation par défaut**. Permet d'enregistrer
> **plusieurs clés par fournisseur LLM** (deepinfra, deepseek, opencode-go…),
> d'en désigner **une seule ACTIVE par fournisseur**, et de **régénérer /
> propager** l'`auth.json` de chaque instance opencode puis de **redémarrer** les
> sessions. **La valeur d'une clé n'est jamais retournée en clair** par l'API.

## 1. Modèle de données

Table PostgreSQL `provider_keys` (base **`panel`**, `panel-db.mjs`) :

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | identity | identifiant |
| `provider` | text | fournisseur (`deepinfra`, `deepseek`, `opencode-go`, …) |
| `label` | text | libellé libre (« clé perso », « clé équipe »…) |
| `key_enc` | text | clé **chiffrée** AES-256-GCM (`iv:tag:ciphertext`, base64url) |
| `is_active` | integer | `1` = clé ACTIVE du fournisseur |
| `created_at` / `updated_at` | text | horodatages ISO |

**Contrainte d'unicité de la clé active** — index unique partiel :

```sql
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_active_uniq
  ON provider_keys(provider) WHERE is_active = 1;
```

La base garantit donc **au plus une clé active par fournisseur** (même en cas de
course concurrente). Les fonctions CRUD vivent dans `panel-db.mjs`
(`listProviderKeys`, `getActiveProviderKeys`, `addProviderKey`,
`setActiveProviderKey`, `deleteProviderKey`) ; `setActive`/`delete` sont
**transactionnels**. `delete` **refuse** la **dernière** clé d'un fournisseur et
**ré-active** une autre clé si la clé supprimée était active.

## 2. Chiffrement

Le chiffrement réutilise le module partagé
`/root/.config/opencode/mcp/task-orchestrator/secret-crypto.mjs`
(**AES-256-GCM**), dont la clé vit hors registre/repo
(`/root/.config/opencode/e2e-secrets.key`, `0600`). Aucune crypto n'est
dupliquée. La clé en clair n'est **jamais** stockée : `key_enc` contient
uniquement le chiffré.

## 3. API (admin + organisation par défaut)

| Méthode | Route | Rôle |
|---------|-------|------|
| `GET` | `/api/providers` | liste `{ providers: [{ provider, keys: [{ id, label, isActive, hasKey, fingerprint, createdAt, updatedAt }] }], authPath }` |
| `POST` | `/api/providers/keys` | ajoute une clé `{ provider, label, key }` (chiffrée ; active si 1ʳᵉ du fournisseur) |
| `POST` | `/api/providers/keys/:id/activate` | désigne la clé ACTIVE → régénération + propagation + redémarrage |
| `DELETE` | `/api/providers/keys/:id` | supprime une clé (garde « dernière clé ») |
| `POST` | `/api/providers/apply` | réapplique l'état courant : régénération + propagation + redémarrage |

**Sécurité** : aucune route ne retourne la valeur d'une clé. `GET /api/providers`
expose seulement un **`fingerprint`** = `sha256` tronqué (12 hex) du **chiffré**,
**non réversible**. Les routes sont réservées à `user.is_admin` **et** à
l'organisation par défaut (mêmes règles que `/api/ecosystem`) ; l'ACL
fail-closed `enforceRoleAcl` exclut déjà `evaluateur`/`exécuteur` (aucune entrée
ajoutée → refus 403 par défaut).

## 4. `auth.json` : fichier DÉRIVÉ, généré

L'`auth.json` natif opencode a le format `{ "<provider>": { "type": "api", "key": "…" } }`.
Il est **généré** depuis la clé ACTIVE de chaque fournisseur par le module
`provider-auth.mjs` (`renderAuthJson`, `writeAuthJson`,
`regenerateAndPropagate`, `migrateFromAuthJson`) :

- **Fichier de référence** : `/root/.local/share/opencode/auth.json` (`SHARED_AUTH`) ;
- **Instances utilisateur** : `<usersDir>/<user>/data/opencode/auth.json`
  (`XDG_DATA_HOME` isolé par utilisateur), écrits en **`0600`**.

**Idempotence (anti-boucle)** : l'écriture est *skippée* si le contenu est
identique (comparaison `sha256`). L'unité systemd `opencode-auth-sync.path`
surveille `SHARED_AUTH` ; sans ce garde-fou, une réécriture relancerait la
synchronisation en boucle.

**Garde-fou « pas de clé active »** : sans aucune clé active,
`regenerateAndPropagate` **n'écrit rien** (l'`auth.json` existant n'est **jamais
vidé**).

**`auth.json` ne doit JAMAIS être édité à la main** : il est régénéré.

## 5. Migration au premier déploiement

Au démarrage du panneau, après `await openDb()`, `migrateFromAuthJson()` importe
les fournisseurs de l'`auth.json` existant (1 clé ACTIVE par fournisseur) dans
`provider_keys`. La migration est **idempotente** : elle ne fait **rien** si la
table est déjà peuplée (aucun écrasement d'une gestion en place).

## 6. Provisioning & synchronisation des instances

- `opencode-user-provision.mjs` (repo `opencode-scripts`) **génère** l'`auth.json`
  de la nouvelle instance depuis les clés actives (au lieu d'une copie statique),
  avec **repli** sur la copie de l'instance de référence si le module/la base est
  indisponible (le provisioning n'est jamais bloqué).
- `opencode-auth-sync.mjs` **régénère et propage** depuis `provider_keys` (repli
  sur la recopie fichier → fichiers si le module est indisponible). Sortie
  conservée : `{ synced, skipped, errors }`.

## 7. Application d'un changement de clé

Un changement de clé ACTIVE ne prend effet qu'après **redémarrage** des
instances : `POST …/activate` et `POST /api/providers/apply` régénèrent/propagent
l'`auth.json` puis redémarrent toutes les unités `opencode@<user>.service`
(+ `opencode.service`) via `listOpencodeUnits()` + `systemctl restart`. La réponse
renvoie `{ restarted, failed }`.

## 8. Rôles / ADR

Conforme à l'ADR « Rôles utilisateurs du panneau » (onglet Fournisseurs **admin
uniquement**) et à l'ADR « Outils d'évaluation produit » (tests E2E = entités de
1ᵉʳ niveau — cf. `07-tests-e2e.md`).
