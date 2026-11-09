#!/usr/bin/env bash
# Terminal 2: background worker (bulk exports, uploads, restores).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! grep -q '^SHOPIFY_API_KEY=.\+' .env 2>/dev/null; then
  echo "SHOPIFY_API_KEY missing from .env — running: shopify app env pull"
  shopify app env pull
fi
npm run worker:dev
