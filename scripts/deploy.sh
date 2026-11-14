#!/usr/bin/env bash
# On the server: ~/derops-backup/scripts/deploy.sh  — pulls, rebuilds, restarts with zero config changes.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose -f docker-compose.prod.yml logs --tail=20 web worker
