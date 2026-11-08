import { createHash } from "node:crypto";
import type { Prisma, ResourceType, SnapshotKind } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated, apiVersion } from "../shopify.server";
import { storageFor, verifyDestination } from "../lib/storage.server";
import { runBulkQuery, reassembleBulkJsonl } from "./bulk.server";
import { PHASE1_BULK_RESOURCES, type ResourceDef } from "./resources.server";
import { backupThemes } from "./themes.server";
import { backupFiles } from "./files.server";

export type RunBackupArgs = {
  shopDomain: string;
  destinationId: string;
  kind: SnapshotKind;
  jobId?: string;
  resources?: ResourceType[]; // subset; defaults to all Phase 1 bulk resources
  log?: (msg: string) => void;
};

/**
 * Full backup of a shop into one timestamped folder in the destination:
 *   <prefix>/<shop>/<2026-11-08T03-00-00Z>/manifest.json
 *                                      /products.jsonl
 *                                      /collections.jsonl
 * Every item gets a SnapshotItem row with its content hash; `changed=false` means identical to the previous snapshot.
 */
export async function runBackup(args: RunBackupArgs) {
  const log = args.log ?? (() => {});
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: args.shopDomain } });
  const destination = await prisma.destination.findUniqueOrThrow({ where: { id: args.destinationId } });
  if (destination.shopId !== shop.id) throw new Error("Destination does not belong to this shop");

  log(`verifying destination ${destination.label}`);
  await verifyDestination(destination);
  await prisma.destination.update({ where: { id: destination.id }, data: { verifiedAt: new Date(), lastError: null } });

  const { admin } = await unauthenticated.admin(args.shopDomain);
  const storage = storageFor(destination);

  const startedAt = new Date();
  const folder = `${shop.domain}/${startedAt.toISOString().replace(/[:.]/g, "-")}`;

  const snapshot = await prisma.snapshot.create({
    data: {
      shopId: shop.id,
      destinationId: destination.id,
      kind: args.kind,
      status: "RUNNING",
      startedAt,
      apiVersion,
    },
  });

  const previous = await prisma.snapshot.findFirst({
    where: { shopId: shop.id, status: { in: ["SUCCESS", "PARTIAL"] }, id: { not: snapshot.id } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  const defs = PHASE1_BULK_RESOURCES.filter((d) => !args.resources || args.resources.includes(d.type));
  const manifest: Manifest = {
    version: 1,
    app: "derops-backup",
    shop: shop.domain,
    snapshotId: snapshot.id,
    startedAt: startedAt.toISOString(),
    apiVersion,
    resources: {},
  };

  let bytes = 0n;
  let items = 0;
  let changed = 0;
  const failures: string[] = [];

  for (const def of defs) {
    try {
      log(`bulk export ${def.type}`);
      const result = await backupResource({ admin, def, storage, folder, snapshotId: snapshot.id, previousSnapshotId: previous?.id });
      manifest.resources[def.type] = result.manifestEntry;
      bytes += BigInt(result.bytes);
      items += result.items;
      changed += result.changed;
      log(`${def.type}: ${result.items} items, ${result.changed} changed, ${result.bytes} bytes`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${def.type}: ${msg}`);
      manifest.resources[def.type] = { file: def.file, count: 0, sha256: "", error: msg };
      log(`${def.type} FAILED: ${msg}`);
    }
  }

  // Non-bulk resources
  const extra: { type: ResourceType; run: () => Promise<{ items: number; changed: number; bytes: number; manifestEntry: Manifest["resources"][string] }> }[] = [
    { type: "THEME_FILE", run: () => backupThemes({ admin, storage, folder, snapshotId: snapshot.id, previousSnapshotId: previous?.id, log }) },
    { type: "FILE", run: () => backupFiles({ admin, storage, folder, snapshotId: snapshot.id, previousSnapshotId: previous?.id, log }) },
  ];
  const totalResources = defs.length + extra.filter((e) => !args.resources || args.resources.includes(e.type)).length;
  for (const e of extra) {
    if (args.resources && !args.resources.includes(e.type)) continue;
    try {
      log(`export ${e.type}`);
      const r = await e.run();
      manifest.resources[e.type] = r.manifestEntry;
      bytes += BigInt(r.bytes);
      items += r.items;
      changed += r.changed;
      log(`${e.type}: ${r.items} items, ${r.changed} changed, ${r.bytes} bytes`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${e.type}: ${msg}`);
      manifest.resources[e.type] = { file: "", count: 0, sha256: "", error: msg };
      log(`${e.type} FAILED: ${msg}`);
    }
  }

  manifest.finishedAt = new Date().toISOString();
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestKey = `${folder}/manifest.json`;
  await storage.put(manifestKey, manifestJson, "application/json");
  bytes += BigInt(Buffer.byteLength(manifestJson));

  const status = failures.length === 0 ? "SUCCESS" : failures.length >= totalResources ? "FAILED" : "PARTIAL";
  await prisma.snapshot.update({
    where: { id: snapshot.id },
    data: {
      status,
      finishedAt: new Date(),
      manifestKey: storage.fullKey(manifestKey),
      bytesWritten: bytes,
      itemCount: items,
      changedCount: changed,
      error: failures.length ? failures.join("\n") : null,
    },
  });

  return { snapshotId: snapshot.id, status, items, changed, bytes: Number(bytes), failures };
}

type Manifest = {
  version: 1;
  app: string;
  shop: string;
  snapshotId: string;
  startedAt: string;
  finishedAt?: string;
  apiVersion: string;
  resources: Record<string, { file: string; count: number; sha256: string; error?: string; themes?: Record<string, unknown> }>;
};

async function backupResource(p: {
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  def: ResourceDef;
  storage: ReturnType<typeof storageFor>;
  folder: string;
  snapshotId: string;
  previousSnapshotId?: string;
}) {
  const { admin, def, storage, folder, snapshotId, previousSnapshotId } = p;

  const { url } = await runBulkQuery(admin, def.query);
  // url is null when the shop has zero objects of this type
  const raw = url ? await (await fetch(url)).text() : "";
  const objects = reassembleBulkJsonl(raw, def.childKeys);

  // Previous hashes for dedup/change detection
  const prevRows = previousSnapshotId
    ? await prisma.snapshotItem.findMany({
        where: { snapshotId: previousSnapshotId, resource: def.type, deleted: false },
        select: { shopifyGid: true, contentHash: true, storageKey: true },
      })
    : [];
  const prev = new Map(prevRows.map((r) => [r.shopifyGid, r]));

  const lines: string[] = [];
  const rows: Prisma.SnapshotItemCreateManyInput[] = [];
  const fileKey = `${folder}/${def.file}`;
  const fullFileKey = storage.fullKey(fileKey);
  let changedCount = 0;
  const seen = new Set<string>();

  for (const obj of objects) {
    const line = JSON.stringify(obj);
    lines.push(line);
    const gid = String(obj.id);
    seen.add(gid);
    const hash = sha256(line);
    const before = prev.get(gid);
    const isChanged = !before || before.contentHash !== hash;
    if (isChanged) changedCount++;
    rows.push({
      snapshotId,
      resource: def.type,
      shopifyGid: gid,
      title: def.titleOf(obj)?.slice(0, 255),
      contentHash: hash,
      storageKey: fullFileKey,
      sizeBytes: Buffer.byteLength(line),
      changed: isChanged,
    });
  }

  // Items that existed before and are gone now
  for (const [gid, before] of prev) {
    if (seen.has(gid)) continue;
    rows.push({
      snapshotId,
      resource: def.type,
      shopifyGid: gid,
      contentHash: before.contentHash,
      storageKey: before.storageKey,
      sizeBytes: 0,
      changed: true,
      deleted: true,
    });
    changedCount++;
  }

  const body = lines.join("\n") + (lines.length ? "\n" : "");
  await storage.put(fileKey, body, "application/x-ndjson");

  // Insert in chunks; Postgres parameter limits bite above a few thousand rows.
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.snapshotItem.createMany({ data: rows.slice(i, i + 1000) });
  }

  return {
    items: objects.length,
    changed: changedCount,
    bytes: Buffer.byteLength(body),
    manifestEntry: { file: def.file, count: objects.length, sha256: sha256(body) },
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
