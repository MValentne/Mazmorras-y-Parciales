#!/usr/bin/env bash
# Requiere npm run build y Chromium instalado por Playwright o CHROMIUM_PATH.
set -eu
cd "$(dirname "$0")/../../.."
export PORT="${PORT:-3113}"
node --import ./apps/web/test/config.mjs apps/server/dist/index.js > /tmp/dungeon-ui-server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null && break
  sleep 0.25
done
kill -0 "$SRV"
curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null
BASE="http://127.0.0.1:${PORT}" node apps/web/test/ui.mjs
