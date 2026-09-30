#!/usr/bin/env bash
# Levanta el server, corre la prueba end-to-end por WebSocket y lo baja.
# El server se mata por PID: un pkill -f con un patrón presente en esta misma
# línea de comandos mataría al propio shell que lo ejecuta.
set -eu
cd "$(dirname "$0")/../../.."

# export y no asignación simple: el hijo necesita recibir la variable.
export PORT="${PORT:-3111}"
node --import ./apps/server/test/fast-config.mjs apps/server/dist/index.js > /tmp/dungeon-e2e-server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null && break
  sleep 0.25
done

kill -0 "$SRV"
curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null
BASE="http://127.0.0.1:${PORT}" node apps/server/test/e2e.mjs
