#!/usr/bin/env bash
# Terminal 1: dependencies + web app. Press `p` when ready to open the app.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm install
docker compose up -d postgres redis
# wait for Postgres
for i in $(seq 1 20); do
  docker compose exec -T postgres pg_isready -U derops >/dev/null 2>&1 && break
  sleep 1
done
shopify app dev
