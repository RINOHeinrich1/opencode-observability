#!/usr/bin/env bash
# Lanceur du panneau orchestrator pour pm2.
#
# Objectif : rendre le démarrage RÉSILIENT au reboot. Au redémarrage, pm2
# ressuscite les process AVANT que le conteneur Postgres (orchestrator-postgres,
# port 5432) soit prêt → `openDb()` échoue → le panneau reste « online » mais
# n'écoute jamais (page 502). On attend donc la disponibilité du port 5432 (borné
# à ~3 min) avant de lancer le serveur, puis on `exec` pour que node reçoive
# directement les signaux de pm2 (SIGINT sur restart/stop).
set -u

DB_HOST="${PANEL_DB_HOST:-127.0.0.1}"
DB_PORT="${PANEL_DB_PORT:-5432}"
WAIT_MAX="${PANEL_DB_WAIT_SECONDS:-180}"
INTERVAL=2

waited=0
while [ "$waited" -lt "$WAIT_MAX" ]; do
  if (exec 3<>"/dev/tcp/${DB_HOST}/${DB_PORT}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    break
  fi
  sleep "$INTERVAL"
  waited=$((waited + INTERVAL))
done

if [ "$waited" -ge "$WAIT_MAX" ]; then
  echo "[start-panel] WARN: ${DB_HOST}:${DB_PORT} indisponible après ${WAIT_MAX}s — démarrage quand même (le serveur réessaiera au prochain restart pm2)." >&2
fi

exec /usr/bin/node /root/orchestrator-panel/server.mjs
