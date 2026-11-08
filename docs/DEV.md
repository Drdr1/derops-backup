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
