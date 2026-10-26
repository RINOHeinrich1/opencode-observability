# Installation du socle « orchestrateur » sur un nouveau serveur

> **Objet** : état exact du versioning Git de l'écosystème au 2026-10-26, puis
> procédure cible pour monter l'orchestrateur **à vide** (sans les données
> actuelles) sur un nouveau serveur, avec **domaines paramétrables**.
>
> **Périmètre** : panneau + PostgreSQL + OpenCode + MCP + PM2 + nginx/TLS.
> Coder est traité comme **installation** (configuration prête), pas comme
> migration de données.
>
> **Hors périmètre** : migration des tâches/plans/sessions, workspaces Coder,
> applications métier (onir-cms, livekit…), runners CI.

---

## 0. Synthèse

1. **12 dépôts Git** couvrent le code, mais **3 zones ne sont pas versionnées** :
   la configuration racine OpenCode (`opencode.jsonc`, `AGENTS.md`, `.env`,
   `users/*.env`), l'infrastructure hôte (systemd, nginx, TLS) et Coder.
2. **5 dépôts sont en dérive** (commits non poussés ou modifications locales) :
   l'état actuel **n'est pas reconstructible depuis Git** en l'état.
3. **Un PAT GitHub est en clair dans 9 URLs de remote** → à révoquer avant tout.
4. Le montage **à vide** est déjà largement possible : les schémas se créent
   automatiquement (task-orchestrator et panneau), l'admin est bootstrapé, le
   provisioning des instances OpenCode est scripté.
5. La solution recommandée est un **dépôt « socle »** (templates + `install.sh`
   + `versions.lock`) qui installe des **versions épinglées** sans données, avec
   les domaines rendus depuis un fichier `socle.env`.

---

## 0.1 État d'exécution (2026-10-26, après régularisation)

**P1 — fait.** Commits, merges et tag `socle-2026.10` :

- panneau `747ab6b` ; `task-orchestrator` `554a1ca` (`.gitignore` `plans/` +
  `reports/`, worktrees résiduels supprimés) ;
- `plan-manager` `c7ca85c` (merge `feature/migration-postgresql` → `main`) ;
- `agents` `7bd9872` (merge `feature/per-plan` → `main`) ;
- `skills` `87f9a54`, `plugins` `0afe039`, `scripts` `1e02295` ;
- `audit-manager`, `coder-workspaces`, `oniria-arch`, `react-arch`, `notifier`
  tagués (aucun changement de code).
- Les URLs de remote ne contiennent plus de token. Credential scoped :
  `credential.https://github.com.helper=store` +
  `credential.https://github.com.username=rinoheinrich1`.
- ⚠ Le PAT reste **valide** dans `~/.git-credentials` : le révoquer sur GitHub
  puis mettre à jour le store (ou passer en SSH avec une clé ayant write).

**P2 — fait.** Dépôt privé :
<https://github.com/RINOHeinrich1/opencode-socle> — `install.sh`, `verify.sh`,
`versions.lock`, templates systemd/nginx/Coder, `socle.env.example`, seed.
Copie de travail de la session : `/tmp/opencode/opencode-socle` (le chemin
`/root/opencode-socle` est refusé par la policy de cette session ; cloner le
dépôt à l'emplacement voulu sur la cible).

**Reste P3** : dry-run sur une VM vierge.

---

## 1. Matrice de versioning (état **avant** régularisation)

> État courant après P1 : voir §0.1 (`socle-2026.10`).

| Composant | Dépôt GitHub | Branche | HEAD | Sales | Version | État |
|---|---|---|---|---|---|---|
| Panneau | `RINOHeinrich1/opencode-observability` | `main` | `0d030ea` (2026-10-13) | 0 | 0.9.65 | **Propre** |
| Agents | `RINOHeinrich1/opencode-agents` | `feature/per-plan` | `5b95c77` (2026-09-22) | 10 (8 M + 1 ??) | — | **En dérive** |
| Skills | `RINOHeinrich1/opencode-skills` | `main` | `784e271` (2026-09-07) | 4 (??) | — | **En dérive** |
| Plugins | `RINOHeinrich1/opencode-plugins` | `main` | `1e3fe78` (2026-08-30) | 1 (M) | — | **En dérive** |
| Scripts | `RINOHeinrich1/opencode-scripts` | `main` | `625a850` (2026-10-18) | 1 (??) | — | **En dérive** |
| Notifier | `RINOHeinrich1/opencode-notifier` | `main` | `e971b4d` (2026-09-17) | 0 | — | **Propre** |
| MCP task-orchestrator | `RINOHeinrich1/opencode-mcp-task-orchestrator` | `main` | `77b07b5` (2026-09-23) | 136 (??) | 0.8.36 | **En dérive** |
| MCP plan-manager | `RINOHeinrich1/opencode-mcp-plan-manager` | `feature/migration-postgresql` | `69582e5` (2026-08-30) | 3 (M) | 0.1.1 | **Critique** |
| MCP audit-manager | `RINOHeinrich1/opencode-mcp-audit-manager` | `main` | `8743b0e` (2026-08-30) | 0 | 0.1.0 | **Propre** |
| MCP coder-workspaces | `RINOHeinrich1/opencode-mcp-coder-workspaces` | `main` | `1f224de` (2026-08-29) | 0 | 0.1.0 | **Propre** |
| MCP oniria-arch | `RINOHeinrich1/opencode-mcp-oniria-arch` | `main` | `4672251` (2026-08-29) | 0 | 0.1.0 | **Propre** |
| MCP react-arch | `RINOHeinrich1/opencode-mcp-react-arch` | `main` | `123ace8` (2026-08-29) | 0 | 0.1.0 | **Propre** |

### 1.1 Détail des dérives

- **plan-manager** : `db.mjs` (+84), `index.mjs` (+37), `package.json` (0.1.0→0.1.1)
  sont **modifiés mais non commités**, sur une branche `feature/migration-postgresql`
  **non mergée dans `main`**. C'est le code PostgreSQL réellement exécuté : sans
  commit, un clone de `main` ne reproduit pas le comportement actuel.
- **task-orchestrator** : 136 fichiers non suivis, essentiellement
  `plans/*.md` (données de travail). Le code (`schema.sql`, `db.mjs`, `index.mjs`)
  est suivi ; il manque seulement un `.gitignore` pour `plans/` et `reports/`.
- **agents** : 8 fichiers modifiés + `queen-build-agent.md` non suivi, sur
  `feature/per-plan` (pas `main`).
- **skills** : 4 dossiers non suivis (`fastapi-dev`, `git-linux-ops`,
  `nextjs-dev`, `supabase-dev`).
- **plugins** : `session-env.mjs` modifié non commité.
- **scripts** : `omniroute-start.sh` non suivi.
- **worktrees MCP** : `mcp/task-orchestrator-wt-*` (2 copies) sont des worktrees
  résiduels ; à nettoyer.

### 1.2 Non versionné (angle mort)

| Élément | Emplacement actuel | Impact pour un nouveau serveur |
|---|---|---|
| Configuration OpenCode racine | `~/.config/opencode/opencode.jsonc`, `AGENTS.md`, `package.json` | **Bloquant** : sans lui, pas de MCP/agents/modèles |
| Env OpenCode | `~/.config/opencode/.env`, `users/*.env` | **Bloquant** (secrets + ports) |
| Docs socle | `~/.config/opencode/docs/` | Non bloquant |
| Units systemd | `opencode.service`, `opencode@.service`, `opencode-auth-sync.*`, `pm2-root.service`, `pm2-prod.service` | **Bloquant** |
| nginx + TLS | `/etc/nginx/sites-enabled/*`, `/etc/letsencrypt` | **Bloquant** (accès web) |
| Coder | `/etc/coder.d/coder.env`, templates, DB/keys | **Bloquant** pour l'installation Coder |
| PM2 dump | `~/.pm2/dump.pm2`, `~/.pm2-prod/dump.pm2` | Reconstructible via `ecosystem.mjs` + commandes |
| Secrets E2E | `e2e.env`, `e2e-secrets.key` | À régénérer |
| Tokens | `.git-credentials`, `.ssh`, tokens LLM (`auth.json`) | À régénérer |

### 1.3 Sécurité — action immédiate

Les 9 remotes des dépôts `opencode-*` contiennent un **PAT GitHub en clair**
(`https://RINOHeinrich1:ghp_…@github.com/...`). Il doit être :

1. **révoqué** sur GitHub ;
2. remplacé par un **deploy key SSH** ou un credential helper ;
3. retiré des URLs : `git remote set-url origin https://github.com/<owner>/<repo>.git`.

---

## 2. Ce qui est déjà favorable pour une installation à vide

- **task-orchestrator** : `ensureSchema()` applique `schema.sql` + `migrate()` au
  premier accès et pose un marqueur de version. Base neuve = schéma complet.
- **Panneau** : `panel-db.mjs` crée ses tables en `IF NOT EXISTS`, puis
  `bootstrapAdmin()` crée `admin` avec `PANEL_ADMIN_PASSWORD` (défaut
  `changeme`). Une base `panel` vide suffit.
- **PostgreSQL** : `docker-compose.yml` + `docker/init/01-create-databases.sql`
  créent `task_registry` et `panel`.
- **Instances OpenCode** : `scripts/opencode-user-provision.mjs` génère le
  template systemd, le fichier d'env et le data dir isolé par utilisateur.
- **Coder** : le MCP `coder-workspaces` découvre les workspaces par Docker ;
  aucune donnée à migrer.
- **Notifier / auth-sync** : scripts et units fournis dans les dépôts
  `opencode-scripts` (les units `coder-token-rotate.*` y sont déjà).

---

## 3. Architecture cible du socle

### 3.1 Principe : séparer 4 couches

| Couche | Contenu | Où |
|---|---|---|
| **Code** | panneau, MCP, agents, skills, plugins, scripts, notifier | Git (versions épinglées) |
| **Configuration** | `opencode.jsonc`, `AGENTS.md`, templates systemd/nginx, `socle.env` | Git |
| **Secrets** | mots de passe, tokens, clés | **générés sur la cible**, jamais en Git |
| **Données** | tâches, plans, sessions, users, Coder | **base neuve** (facultatif : `seed.json` de configuration) |

### 3.2 Nouveau dépôt `opencode-socle`

```
opencode-socle/
├── socle.env.example          # domaines, ports, org, chemins
├── versions.lock              # repo + ref épinglée de chaque composant
├── install.sh                 # montage complet (idempotent)
├── verify.sh                  # contrôles post-installation
├── seed.example.json          # org / projets / repos (config, sans données)
├── config/
│   ├── opencode.jsonc.tpl
│   ├── AGENTS.md
│   └── env/
│       ├── opencode.env.example
│       ├── panel.env.example
│       └── user.env.tpl
├── templates/
│   ├── systemd/               # opencode.service, opencode@.service, auth-sync, pm2
│   ├── nginx/                 # orchestrator.conf.tpl, oc-user.conf.tpl, coder.conf.tpl
│   └── coder/                 # coder.env.example
└── lib/
    ├── render.sh              # rendu des templates depuis socle.env
    └── secrets.sh             # génération des secrets
```

`versions.lock` (exemple) :

```ini
PANEL_REPO=https://github.com/RINOHeinrich1/opencode-observability.git
PANEL_REF=0d030ea
TO_REPO=https://github.com/RINOHeinrich1/opencode-mcp-task-orchestrator.git
TO_REF=77b07b5
PLAN_REPO=https://github.com/RINOHeinrich1/opencode-mcp-plan-manager.git
PLAN_REF=<sha après merge>
AGENTS_REF=<sha après merge>
SKILLS_REF=<sha après commit>
...
OPENCODE_VERSION=1.18.21
POSTGRES_IMAGE=postgres:16
CODER_VERSION=2.36.1
```

> **Règle** : `install.sh` refuse de démarrer si une ref n'est pas un SHA
> complet ou un tag signé. Pas de `main` mobile.

---

## 4. Procédure de montage (à vide, domaines paramétrables)

### Étape 0 — Prérequis serveur

- Ubuntu 22.04/24.04, root, 4 vCPU / 8 Go RAM / 40 Go disque minimum.
- Docker + Compose, Node 20 (panneau/MCP) **et** Node 22 (OmniRoute si utilisé).
- `git`, `nginx`, `certbot`, `sqlite3`, `curl`, `jq`.
- DNS : `orchestrator.<domaine>`, `ide.<domaine>`, `dev.<domaine>`,
  `<user>.dev.<domaine>` (un A par utilisateur) pointés vers le serveur.

### Étape 1 — Récupérer le socle et rendre la configuration

```bash
git clone https://github.com/RINOHeinrich1/opencode-socle.git /opt/opencode-socle
cd /opt/opencode-socle
cp socle.env.example socle.env
$EDITOR socle.env          # BASE_DOMAIN, hôtes, ports, org, e-mail admin
./install.sh --check       # vérifie prérequis + DNS, ne modifie rien
```

### Étape 2 — Installer les binaires

```bash
./install.sh --binaries
# - Node 20 + PM2
# - opencode <OPENCODE_VERSION> dans /root/.opencode
# - Coder <CODER_VERSION>
# - docker compose pull postgres:16
```

### Étape 3 — Cloner les composants aux versions épinglées

```bash
./install.sh --code
# clone dans :
#   /root/orchestrator-panel
#   /root/.config/opencode/{agent,skills,plugins,scripts,notifier}
#   /root/.config/opencode/mcp/{task-orchestrator,plan-manager,audit-manager,coder-workspaces,oniria-arch,react-arch}
# puis npm ci dans chaque package Node
```

### Étape 4 — Démarrer PostgreSQL (bases neuves)

```bash
cd /root/orchestrator-panel
POSTGRES_PASSWORD="$(openssl rand -hex 24)" docker compose up -d
# attendre pg_isready ; les bases task_registry + panel sont créées
```

### Étape 5 — Générer les secrets et rendre les env

```bash
./install.sh --env
# génère : POSTGRES_PASSWORD, PANEL_ADMIN_PASSWORD, OPENCODE_SERVER_PASSWORD,
#          mots de passe par utilisateur, E2E secrets key
# écrit  : /root/.config/opencode/.env, /root/orchestrator-panel/.env,
#          /root/.config/opencode/users/<user>.env
```

Variables clés (rendues depuis `socle.env`) :

```bash
DATABASE_URL=postgres://orchestrator:<pg>@127.0.0.1:5432/task_registry
PANEL_DATABASE_URL=postgres://orchestrator:<pg>@127.0.0.1:5432/panel
PANEL_ADMIN_PASSWORD=<généré>
PANEL_COOKIE_DOMAIN=.<base_domain>
SESSION_BASE_URL=https://rino.dev.<base_domain>
OPENCODE_SERVER_URL=http://127.0.0.1:4204
OPENCODE_DATA_HOME=/root/.config/opencode/users/Rino/data
```

### Étape 6 — Installer la configuration OpenCode

```bash
./install.sh --opencode
# copie opencode.jsonc rendu (aucun domaine en dur), AGENTS.md
# installe opencode.service + opencode@.service + opencode-auth-sync.{service,path}
# active les units
```

### Étape 7 — Provisionner les instances utilisateur

```bash
for u in admin Anjary Rino Ronald; do
  node /root/.config/opencode/scripts/opencode-user-provision.mjs \
    --user "$u" --port "$(port_for "$u")" --password "$(secret_for "$u")"
  systemctl enable --now "opencode@$u"
done
```

### Étape 8 — Démarrer le panneau (PM2)

```bash
pm2 start /root/orchestrator-panel/ecosystem.mjs
pm2 save
systemctl enable --now pm2-root
# vérifier : curl -fsS http://127.0.0.1:4000/healthz
```

### Étape 9 — nginx + TLS

```bash
./install.sh --nginx
# rend orchestrator.<domain>, dev.<domain>, ide.<domain>
# + un vhost par utilisateur : oc-<user>.conf pour <user>.dev.<domain>
#   (écrit par opencode-user-provision.mjs, qui lance aussi certbot)
certbot --nginx -d orchestrator.<domain> -d dev.<domain> -d rino.dev.<domain> ...
```

### Étape 10 — Coder (installation, pas migration)

Voir §5. Puis enregistrer l'organisation dans le panneau :

```text
org_register(id="<org>", name="<ORG>", coderUrl="https://ide.<domain>", coderToken="<token>")
org_set_default(id="<org>")
```

### Étape 11 — Seed de configuration (facultatif, sans données)

`seed.example.json` permet de recréer **la configuration** (pas les données) :

```json
{
  "organization": { "id": "onirtech", "name": "ONIRTECH" },
  "projects": [{ "id": "mada-talk", "name": "MadaTalk", "mainBranch": "main" }],
  "repos": [{ "id": "mada-talk", "gitUrl": "git@github.com:...", "repoDir": "/home/coder/mada-talk" }],
  "users": [{ "username": "Rino", "role": "admin" }]
}
```

Appliqué via les outils MCP (`org_register`, `project_register`,
`repo_register`, `project_repo_link`) — **jamais** par insertion SQL directe.

### Étape 12 — Vérifier

```bash
./verify.sh
# - pg : count(tasks)=0, tables présentes
# - panneau : /healthz, login admin
# - opencode : 4096 + ports utilisateurs
# - MCP : task_list, org_list
# - Coder : coder workspaces list
# - nginx : 200 sur chaque hôte, certificats valides
```

---

## 5. Coder — installation simplifiée

> Objectif : **configuration prête**, aucune donnée reprise. Le
> `/etc/coder.d/coder.env` actuel n'étant pas versionné, première action =
> en extraire un `coder.env.example` assaini.

```bash
# 1. Binaire + service
curl -L https://coder.com/install.sh | sh

# 2. Base PostgreSQL dédiée (recommandé)
docker run -d --name coder-pg -e POSTGRES_USER=coder \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" -e POSTGRES_DB=coder \
  -p 127.0.0.1:5437:5432 postgres:16

# 3. /etc/coder.d/coder.env
cat >/etc/coder.d/coder.env <<EOF
CODER_ACCESS_URL=https://ide.<base_domain>
CODER_HTTP_ADDRESS=127.0.0.1:3000
CODER_PG_CONNECTION_URL=postgres://coder:<pg>@127.0.0.1:5437/coder?sslmode=disable
CODER_PROVISIONER_DAEMONS=0
EOF
systemctl enable --now coder

# 4. Créer le premier admin via l'UI (https://ide.<base_domain>)

# 5. Template Docker « socle »
coder templates init /opt/coder-templates      # starter Docker
# adapter : image, volumes persistants (/home/coder), ressources
coder templates push docker -d /opt/coder-templates/docker

# 6. Token pour le panneau
coder tokens create --name panel -u admin

# 7. Workspaces (un par projet)
coder create mada-talk --template docker -u <user>
```

Points d'attention :

- Les workspaces doivent exposer `/home/coder` sur un **volume Docker nommé**
  (`coder-<uuid>-home`), condition du MCP `coder-workspaces`.
- Ne pas réutiliser les UUID des workspaces actuels : installation neuve.
- Le guard d'ownership (`/usr/local/sbin/coder-ownership-guard.sh`) est une
  configuration hôte à versionner dans le socle.

---

## 6. Paramétrage générique (`socle.env.example`)

```bash
# Domaine
BASE_DOMAIN=example.com
PANEL_HOST=orchestrator.${BASE_DOMAIN}
CODER_HOST=ide.${BASE_DOMAIN}
OPENCODE_HOST=dev.${BASE_DOMAIN}
PANEL_COOKIE_DOMAIN=.${BASE_DOMAIN}

# Chemins (recommandé : identiques à l'existant pour éviter toute réécriture)
OPENCODE_HOME=/root/.config/opencode
PANEL_HOME=/root/orchestrator-panel
OPENCODE_BIN=/root/.opencode/bin/opencode

# Ports
PANEL_PORT=4000
OPENCODE_SHARED_PORT=4096
OPENCODE_USER_PORTS="admin:4201 Anjary:4202 Ronald:4203 Rino:4204"

# Organisation / admin
DEFAULT_ORG=onirtech
DEFAULT_ORG_NAME=ONIRTECH
ADMIN_EMAIL=admin@example.com

# Versions
OPENCODE_VERSION=1.18.21
NODE_MAJOR=20
POSTGRES_IMAGE=postgres:16
CODER_VERSION=2.36.1
```

---

## 7. Plan d'action avant toute migration

### P0 — Sécurité (immédiat) — partiellement fait

1. ✅ URLs de remote nettoyées : plus aucun token dans les 13 dépôts.
2. ⏳ **Révoquer le PAT** encore valide dans `~/.git-credentials`, puis mettre à
   jour le credential store (ou passer en SSH avec une clé ayant write).
3. ✅ Secrets : générés sur la cible par `install.sh --env`, jamais réutilisés.

### P1 — Régulariser Git — ✅ fait (`socle-2026.10`)

1. ✅ `plan-manager` : merge `feature/migration-postgresql` → `main` (`c7ca85c`).
2. ✅ `agent` : commit + merge `feature/per-plan` → `main` (`7bd9872`).
3. ✅ `skills` : 4 nouveaux skills (`87f9a54`).
4. ✅ `plugins` : `session-env.mjs` (`0afe039`).
5. ✅ `scripts` : `omniroute-start.sh` (`1e02295`).
6. ✅ `task-orchestrator` : `.gitignore` + worktrees supprimés (`554a1ca`).
7. ✅ Tags `socle-2026.10` sur les 12 dépôts + `versions.lock`.

### P2 — Créer le dépôt socle — ✅ fait

1. ✅ <https://github.com/RINOHeinrich1/opencode-socle> : `install.sh`,
   `verify.sh`, `versions.lock`, `socle.env.example`, seed.
2. ✅ Templates versionnés : `opencode.jsonc`, `AGENTS.md`, env, units systemd,
   vhosts nginx, `coder.env.example` (le guard d'ownership reste à extraire).
3. ✅ Domaine/ports/org rendus depuis `socle.env` (`render.sh`).

### P3 — Valider sur une VM blanche

1. `install.sh` complet sur une VM neuve.
2. `verify.sh` vert.
3. Seulement ensuite : bascule du nouveau serveur.

---

## 8. Estimation

| Lot | Effort |
|---|---|
| Régularisation Git (P1) | 0,5 j |
| Dépôt socle + templates + scripts (P2) | 2–3 j |
| Dry-run VM blanche (P3) | 0,5–1 j |
| **Installation réelle** | **30–60 min** |

**Critère de réussite** : sur une VM vierge, `install.sh` + `seed` + DNS/TLS
donnent un panneau fonctionnel (login, MCP, instances OpenCode, Coder) sans
copier aucune donnée ni aucun secret de l'ancien serveur.

---

## Annexe A — Secrets à générer sur la cible

- [ ] `POSTGRES_PASSWORD`
- [ ] `PANEL_ADMIN_PASSWORD`
- [ ] `OPENCODE_SERVER_PASSWORD` (instance partagée)
- [ ] mot de passe par utilisateur OpenCode
- [ ] token Coder (panneau ↔ Coder)
- [ ] deploy key SSH GitHub (remplace le PAT)
- [ ] clé `e2e-secrets.key`
- [ ] token SMTP / mailing (notifier)
- [ ] clés fournisseurs LLM (via le panneau, table `provider_keys`)
- [ ] certificats TLS (certbot)

## Annexe B — Valeurs codées en dur à paramétrer

- `panel-db.mjs` : organisation par défaut `onirtech` (`COALESCE(organization_id,'onirtech')`)
  et backfill `Gonzague` → `mada-talk` → à rendre conditionnels.
- `opencode.jsonc` : chemins `/root/...` et produit Infomaniak `106700`
  → template.
- `start-panel.sh` : `/usr/bin/node` et `/root/orchestrator-panel`
  → variables `NODE_BIN` / `PANEL_HOME`.
- `ecosystem.mjs` : `homedir()` (portable) — OK.
- nginx : `server_name`, `proxy_pass`, cookie domain → templates.
- `SESSION_BASE_URL` / `OPENCODE_SERVER_URL` : par utilisateur → rendus.
- `coder-workspaces` : préfixe de volume `coder-` (convention Coder) — OK.

## Annexe C — Pièges

1. **PostgreSQL** : ne jamais copier le volume à chaud ; `pg_dump`/volume neuf.
2. **SQLite OpenCode** : `opencode.db` en WAL ; utiliser `.backup`, pas `cp`.
   (Sans données : ignorer.)
3. **Chemins absolus** : conserver `/root/...` sur la cible évite une passe de
   réécriture (DB `artifact.path`, `e2eRepoDir`, pm2 `cwd`).
4. **UID/GID des volumes Docker** : un `tar` en root conserve les droits ; ne pas
   utiliser `--no-same-owner`.
5. **DNS/TLS** : basculer les enregistrements **après** validation en local
   (`curl -H 'Host: …'`), puis certbot.
6. **Runners GitHub** : les ré-enregistrer (token) plutôt que copier leur état.
7. **PM2** : `pm2 resurrect` dépend de `~/.pm2/dump.pm2` ; préférer
   `ecosystem.mjs` + `pm2 save` pour un socle reproductible.
