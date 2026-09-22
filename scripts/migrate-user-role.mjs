#!/usr/bin/env node
// migrate-user-role.mjs — Migration EXPLICITE du rôle `user` (ADR-002, doc 16).
//
// Supprime à terme le rôle `user` en migrant les comptes existants vers
// `executeur` (règle explicite : Ronald → executeur ; défaut → executeur).
// Idempotent (WHERE role='user'), réversible (--revert, audit conservé) et
// TRACÉ (table user_role_migrations).
//
// IMPORTANT : ce script n'est JAMAIS exécuté automatiquement au démarrage du
// serveur. `--dry-run` est le mode PAR DÉFAUT : aucune écriture sans `--apply`
// explicite.
//
// Usage :
//   node scripts/migrate-user-role.mjs [--dry-run] [--json]
//   node scripts/migrate-user-role.mjs --apply [--by <acteur>] [--target-role <role>] [--rule <user=role> ...]
//   node scripts/migrate-user-role.mjs --revert (--all | --migration-id=<id> ...) [--by <acteur>]
//
// Options :
//   --dry-run            (défaut) liste les comptes `user` et la cible planifiée, sans écrire.
//   --apply              applique la migration (écriture + audit).
//   --revert             annule des migrations (--all ou --migration-id).
//   --all                avec --revert : annule TOUTES les migrations non annulées.
//   --migration-id=<id>  avec --revert : annule la migration d'audit <id> (répétable).
//   --target-role=<r>    rôle cible par défaut (admin|supervisor|evaluateur|executeur ; défaut executeur).
//   --rule=<user=role>   règle explicite par username (répétable ; défaut Ronald=executeur).
//   --by=<acteur>        acteur tracé (défaut : $USER || 'cli').
//   --json               sortie JSON (preuve machine).
//   --help               aide.

import { openDb, migrateUserRole, revertUserRoleMigration, listUserRoleMigrations } from "../panel-db.mjs";

const TARGETS = ["admin", "supervisor", "evaluateur", "executeur"];

function parseArgs(argv) {
  const out = { dryRun: true, apply: false, revert: false, all: false, ids: [], rules: {}, targetRole: "executeur", by: process.env.USER || "cli", json: false, help: false };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") { out.apply = true; out.dryRun = false; }
    else if (a === "--revert") out.revert = true;
    else if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--migration-id=")) out.ids.push(a.slice("--migration-id=".length));
    else if (a.startsWith("--target-role=")) out.targetRole = a.slice("--target-role=".length);
    else if (a.startsWith("--by=")) out.by = a.slice("--by=".length);
    else if (a.startsWith("--rule=")) {
      const [u, r] = a.slice("--rule=".length).split("=");
      if (u && r) out.rules[u] = r;
    } else {
      console.error(`option inconnue : ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const HELP = `Migration du rôle "user" (ADR-002, doc 16) — dry-run par défaut.

  node scripts/migrate-user-role.mjs [--dry-run] [--json]
  node scripts/migrate-user-role.mjs --apply [--by=<acteur>] [--target-role=<r>] [--rule=<user=role> ...]
  node scripts/migrate-user-role.mjs --revert (--all | --migration-id=<id> ...) [--by=<acteur>]

Règle par défaut : Ronald -> executeur ; tout autre compte "user" -> executeur.
Aucune écriture sans --apply explicite.`;

function printHuman(o) {
  if (o.mode === "dry-run") {
    console.log(`[dry-run] comptes role='user' à migrer : ${o.accounts.length}`);
    for (const a of o.accounts) console.log(`  - ${a.username} (id ${a.id}) : user -> ${a.targetRole}  [${a.rule}]`);
    if (!o.accounts.length) console.log("  (aucun compte — rien à migrer)");
    console.log("Aucune écriture effectuée. Relancer avec --apply pour appliquer.");
  } else if (o.mode === "apply") {
    console.log(`[apply] migrations appliquées : ${o.migrations.length}`);
    for (const m of o.migrations) console.log(`  - audit #${m.id} : ${m.username} : ${m.from_role} -> ${m.to_role} [${m.rule}] par ${m.migrated_by} @ ${m.migrated_at}`);
    if (!o.migrations.length) console.log("  (aucun compte — rien à migrer)");
  } else if (o.mode === "revert") {
    console.log(`[revert] migrations annulées : ${o.reverted.length}`);
    for (const m of o.reverted) console.log(`  - audit #${m.id} : ${m.username} : ${m.to_role} -> ${m.from_role} restauré par ${m.reverted_by} @ ${m.reverted_at}`);
    if (!o.reverted.length) console.log("  (aucune migration à annuler)");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.apply && args.revert) { console.error("--apply et --revert sont exclusifs"); process.exit(2); }

  const pool = await openDb();

  if (args.revert) {
    if (!args.all && !args.ids.length) { console.error("--revert requiert --all ou au moins un --migration-id=<id>"); process.exit(2); }
    const reverted = await revertUserRoleMigration({ migrationIds: args.ids, all: args.all, by: args.by });
    const o = { mode: "revert", reverted };
    console.log(args.json ? JSON.stringify(o, null, 2) : "");
    if (!args.json) printHuman(o);
    return;
  }

  const rules = Object.keys(args.rules).length ? args.rules : { Ronald: "executeur" };

  if (args.apply) {
    const migrations = await migrateUserRole({ targetRole: args.targetRole, rules, by: args.by });
    const o = { mode: "apply", migrations };
    if (args.json) console.log(JSON.stringify(o, null, 2)); else printHuman(o);
    return;
  }

  // DRY-RUN (défaut) : lecture brute du rôle en base (pas de normalisation), aucun écrit.
  const rows = (await pool.query("SELECT id, username, role FROM users WHERE role = 'user' ORDER BY id")).rows;
  const fallback = TARGETS.includes(args.targetRole) ? args.targetRole : "executeur";
  const accounts = rows.map((u) => {
    const explicit = Object.prototype.hasOwnProperty.call(rules, u.username);
    const rawTarget = explicit ? rules[u.username] : fallback;
    const targetRole = TARGETS.includes(rawTarget) ? rawTarget : fallback;
    return { id: u.id, username: u.username, fromRole: u.role, targetRole, rule: explicit ? "explicit" : "default" };
  });
  const audit = await listUserRoleMigrations();
  const o = { mode: "dry-run", generatedAt: new Date().toISOString(), targetRole: fallback, rules, accounts, auditCount: audit.length };
  if (args.json) console.log(JSON.stringify(o, null, 2)); else printHuman(o);
}

main().catch((e) => { console.error("ERREUR :", (e && e.message) || e); process.exit(1); });
