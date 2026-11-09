import prisma from "../db.server";
import { backupQueue } from "./queue.server";

/**
 * One BullMQ repeatable job per shop, keyed by shop id, firing at Shop.scheduleCron in Shop.timezone.
 * Re-syncing is idempotent: we remove any existing scheduler for the shop and add the current one.
 * Called when a shop installs, changes settings, picks a destination, or is uninstalled.
 */
export async function syncShopSchedule(shopId: string) {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    include: { destinations: { where: { verifiedAt: { not: null } }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const q = backupQueue();
  const key = `daily:${shop.id}`;

  await q.removeJobScheduler(key);

  if (shop.uninstalledAt || shop.destinations.length === 0) return { scheduled: false };

  await q.upsertJobScheduler(
    key,
    { pattern: shop.scheduleCron, tz: shop.timezone || "UTC" },
    {
      name: "scheduled-backup",
      data: {
        type: "SCHEDULED_BACKUP" as const,
        shopDomain: shop.domain,
        destinationId: shop.destinations[0].id,
      },
      opts: { attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 100, removeOnFail: 200 },
    },
  );
  return { scheduled: true, cron: shop.scheduleCron, tz: shop.timezone };
}

/** Human-readable "daily at 03:00" from a cron like "0 3 * * *". */
export function describeCron(cron: string): string {
  const m = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (!m) return cron;
  return `daily at ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
}

export function cronForHour(hour: number, minute = 0): string {
  return `${minute} ${hour} * * *`;
}
