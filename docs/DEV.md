# Local development

## Services
```bash
docker compose up -d postgres redis
```

## Environment (.env)
```
DATABASE_URL="postgresql://derops:derops@localhost:5432/derops_backup"
REDIS_URL="redis://localhost:6379"
ENCRYPTION_KEY=<openssl rand -hex 32>        # encrypts merchant bucket keys at rest

# Written by `shopify app env pull` (needed by the worker, which runs outside `shopify app dev`):
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SCOPES=...
SHOPIFY_APP_URL=...
```

## Run
Terminal 1 — web app (Shopify CLI injects env, runs migrations, opens tunnel):
```bash
shopify app dev
```
Terminal 2 — background worker (bulk exports, uploads, restores):
```bash
shopify app env pull      # once, and again whenever the app config changes
npm run worker:dev
```

## Flow
1. Open the app in the dev store → **Destinations** → add an S3-compatible bucket (R2 works well: endpoint
   `https://<account-id>.r2.cloudflarestorage.com`, region `auto`). "Save and test" writes/reads/deletes a probe object.
2. **Backups** → **Back up now**. The web app enqueues a BullMQ job; the worker runs one Bulk Operation per resource,
   folds the JSONL back into whole objects, writes `<shop>/<timestamp>/{products,collections}.jsonl` + `manifest.json`
   to the bucket, and records `Snapshot` / `SnapshotItem` rows (content hash per item → `changed` flag).

## Layout
```
app/lib/crypto.server.ts     AES-256-GCM for destination secrets
app/lib/storage.server.ts    S3 client per destination + verifyDestination()
app/lib/queue.server.ts      BullMQ queue + Redis connection
app/lib/shop.server.ts       ensureShop() upsert on page load
app/backup/bulk.server.ts    runBulkQuery(), reassembleBulkJsonl()
app/backup/resources.server.ts  Phase 1 resource definitions (bulk GraphQL queries)
app/backup/snapshot.server.ts   runBackup(): orchestrates a snapshot
worker/index.ts              BullMQ worker process
schema.prisma                Session + Shop, Destination, Snapshot, SnapshotItem, Job
```

## Resources covered (Phase 1)
| Resource | Backup | Restore | Notes |
|---|---|---|---|
| Products (variants, options, metafields, media refs) | bulk → `products.jsonl` | `productSet` (update in place or recreate) | media not re-attached on restore yet |
| Collections | bulk → `collections.jsonl` | — (export only) | |
| Theme files (all themes except DEMO) | per-file objects under `themes/<id>/`, dedup by checksum | `themeFilesUpsert` into same theme | whole-theme restore to a new unpublished theme: next |
| Files (Content → Files) | `files.jsonl` + originals under `files/` for images & generic files | — | video/3D: metadata only |

Snapshot detail page: `/app/snapshots/<id>` — filter by resource / title / changed-only, "Restore this version" per item.

## Scheduling, retention, email (week 3)
- One BullMQ **job scheduler** per shop (`daily:<shopId>`), cron from `Shop.scheduleCron` in `Shop.timezone`. Re-synced by
  `syncShopSchedule()` whenever a destination is added/verified/removed, settings are saved, or the app is uninstalled.
- Scheduled run = backup → `pruneShop()` (deletes snapshots past retention + their unreferenced objects; always keeps the
  latest good snapshot) → optional summary email.
- Email: set `SMTP_URL=smtp://user:pass@host:587` and `MAIL_FROM`. Without `SMTP_URL` the worker logs the email instead.
- Settings page: `/app/settings` (hour, timezone, retention, notification email, daily summary toggle).
- To test the scheduler quickly: set the hour to the next full hour, or temporarily edit `scheduleCron` in Postgres to
  `*/5 * * * *` and call `syncShopSchedule` by saving Settings.

## Theme restore

Shopify granted the theme-write exemption (Nov 12 2026) for backup/restore use only.
- Single file: `themeFilesUpsert` into the original theme (overwrites that file).
- No whole-theme restore and no theme downloads (removed Nov 17 2026 after App Store review,
  requirement 1.1.3: themes may only be installed via the Theme Store). Theme files are never
  served to the browser; product/collection/file records can be downloaded as JSON.
- Per the exemption, the app must never install/distribute/upload themes other than the merchant's own backups.

## No tunnel? Run on localhost

If Cloudflare's quick tunnel fails, run the app without one:

```bash
sudo true   # cache sudo for mkcert
.shopify/mkcert -install -key-file .shopify/localhost-key.pem -cert-file .shopify/localhost.pem localhost   # first time only
shopify app dev --use-localhost -c local
```

`shopify.app.local.toml` is the same app without webhook subscriptions (Shopify
rejects localhost webhook URLs). Uninstall/compliance webhooks are not delivered
in this mode; everything else (backups, restores, scheduler) works.

## Dev vs production apps

`shopify.app.production.toml` = production (backup.derops.dev, exemption holder). Deploy with `shopify app deploy -c production`. Never run `app dev` with it.
`shopify.app.dev.toml` = dev app derops-backup-dev; `scripts/dev-web.sh` runs `shopify app dev -c dev`.
`shopify.app.local.toml` = same dev app without webhooks, for `shopify app dev --use-localhost -c local`.

## Billing (Shopify Billing API)

`/app/plans` creates recurring subscriptions with `appSubscriptionCreate` (7-day trial, test charges
on development stores or when `BILLING_TEST=1`), Shopify shows its approval page, then fires
`app_subscriptions/update`. `app/lib/billing.server.ts` maps the active subscription *name* to our
`Plan` enum (names contain "Basic", "Grow" or "Advanced"; anything else = FREE) and `PLANS` holds what
each plan allows. `syncPlan` also runs on every app page load as a safety net.
Optional: `SHOPIFY_MANAGED_PRICING=1` sends "Upgrade" to Shopify's hosted plan picker instead (needs an
App Store listing with the same plan names). `SHOPIFY_APP_HANDLE` defaults to `derops-backup`.

| Plan | $/mo | Resources | Schedule | Retention | Destinations | Manual/mo |
|---|---|---|---|---|---|---|
| Free | 0 | themes | weekly | 7 | 1 | 3 |
| Basic | 9 | all | daily | 7/30 | 1 | 30 |
| Grow | 19 | all | daily | 7/30/90/365 | 1 | unlimited |
| Advanced | 39 | all | daily | 7/30/90/365 | 5 | unlimited |

## Incremental backups (webhooks)

`products/*`, `collections/*`, `themes/*` webhooks hit `/webhooks/changes`, which records the touched
resource type in Redis (`incr:<shop>`) and enqueues one debounced `INCREMENTAL_BACKUP` job per shop
(`INCREMENTAL_DEBOUNCE_MS`, default 5 min; BullMQ jobId makes repeats no-ops). The worker runs
`runBackup(kind: INCREMENTAL, resources: <touched>)` — paid plans only; skipped if a backup is already
running. Files have no webhook; they are covered by the daily run.

## What changed (diff)

`/app/snapshots/:id/diff?item=` compares an item with its latest earlier version with a different
content hash: line diff (jsdiff) for text theme files, field-level table for JSONL resources, size
only for binaries. Context collapsed to 3 lines around changes; capped at 4,000 lines.
