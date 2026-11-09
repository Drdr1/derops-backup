import prisma from "../db.server";
import { storageFor } from "../lib/storage.server";

/**
 * Delete snapshots older than Shop.retentionDays, including their objects in the destination.
 * Safety rules:
 *  - never delete the most recent SUCCESS/PARTIAL snapshot, whatever its age
 *  - an object is only deleted if NO remaining snapshot still references it (dedup keeps pointers to old objects)
 *  - the merchant's bucket may not grant delete permission; we record what we couldn't delete and move on
 */
export async function pruneShop(shopId: string, log: (m: string) => void = () => {}) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const cutoff = new Date(Date.now() - shop.retentionDays * 24 * 3600 * 1000);

  const latestGood = await prisma.snapshot.findFirst({
    where: { shopId, status: { in: ["SUCCESS", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  const expired = await prisma.snapshot.findMany({
    where: { shopId, startedAt: { lt: cutoff }, ...(latestGood ? { id: { not: latestGood.id } } : {}) },
    include: { destination: true },
    orderBy: { startedAt: "asc" },
  });
  if (expired.length === 0) return { deletedSnapshots: 0, deletedObjects: 0, skippedObjects: 0 };

  let deletedObjects = 0;
  let skippedObjects = 0;

  for (const snap of expired) {
    const storage = storageFor(snap.destination);
    const items = await prisma.snapshotItem.findMany({
      where: { snapshotId: snap.id },
      select: { storageKey: true },
      distinct: ["storageKey"],
    });
    const keys = items.map((i) => i.storageKey);
    if (snap.manifestKey) keys.push(snap.manifestKey);

    for (const key of keys) {
      // Still referenced by a snapshot we are keeping?
      const stillUsed = await prisma.snapshotItem.count({
        where: { storageKey: key, snapshot: { shopId, id: { notIn: expired.map((e) => e.id) } } },
      });
      if (stillUsed > 0) {
        skippedObjects++;
        continue;
      }
      try {
        await storage.del(stripPrefix(key, storage.prefix));
        deletedObjects++;
      } catch (e) {
        skippedObjects++;
        log(`could not delete ${key}: ${e instanceof Error ? e.message : e}`);
      }
    }

    await prisma.snapshot.delete({ where: { id: snap.id } }); // cascades SnapshotItem rows
    log(`pruned snapshot ${snap.id} from ${snap.startedAt.toISOString()}`);
  }

  return { deletedSnapshots: expired.length, deletedObjects, skippedObjects };
}

/** SnapshotItem.storageKey is stored prefixed; Storage.del() re-applies the prefix, so strip it first. */
function stripPrefix(fullKey: string, prefix: string): string {
  return prefix && fullKey.startsWith(prefix + "/") ? fullKey.slice(prefix.length + 1) : fullKey;
}
