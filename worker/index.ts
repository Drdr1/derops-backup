/**
 * Background worker. Run separately from the web process:
 *   npm run worker
 * Needs the same env as the app (SHOPIFY_API_KEY/SECRET, SCOPES, DATABASE_URL, REDIS_URL, ENCRYPTION_KEY).
 * In dev: `shopify app env pull` writes the Shopify vars into .env.
 */
import "./env";
import { Worker, type Job as BullJob } from "bullmq";
import prisma from "../app/db.server";
import { QUEUE_NAME, redis, type BackupJobData } from "../app/lib/queue.server";
import { runBackup } from "../app/backup/snapshot.server";
import { verifyDestination } from "../app/lib/storage.server";
import { restoreItem } from "../app/backup/restore.server";
import { pruneShop } from "../app/backup/retention.server";
import { sendMail, summaryEmail } from "../app/lib/mail.server";

const concurrency = Number(process.env.WORKER_CONCURRENCY || 2);

const worker = new Worker<BackupJobData>(
  QUEUE_NAME,
  async (job: BullJob<BackupJobData>) => {
    const data = job.data;
    const log = (msg: string) => {
      console.log(`[${data.type}] ${data.shopDomain}: ${msg}`);
      void job.log(msg);
    };

    if (data.type === "SCHEDULED_BACKUP") return runScheduledBackup(data.shopDomain, data.destinationId, log);

    await prisma.job.update({
      where: { id: data.jobId },
      data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
    });

    try {
      let result: unknown;
      switch (data.type) {
        case "BACKUP_FULL":
          result = await runBackup({
            shopDomain: data.shopDomain,
            destinationId: data.destinationId,
            kind: data.kind ?? "MANUAL",
            jobId: data.jobId,
            resources: data.resources as never,
            log,
          });
          break;
        case "RESTORE_ITEM": {
          const r = await restoreItem({
            shopDomain: data.shopDomain,
            snapshotItemId: data.snapshotItemId,
            targetThemeId: data.targetThemeId,
            log,
          });
          if (!r.ok) throw new Error(r.message);
          result = r;
          break;
        }
        case "VERIFY_DESTINATION": {
          const dest = await prisma.destination.findUniqueOrThrow({ where: { id: data.destinationId } });
          try {
            await verifyDestination(dest);
            await prisma.destination.update({ where: { id: dest.id }, data: { verifiedAt: new Date(), lastError: null } });
            result = { ok: true };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await prisma.destination.update({ where: { id: dest.id }, data: { lastError: msg } });
            throw e;
          }
          break;
        }
      }
      await prisma.job.update({
        where: { id: data.jobId },
        data: { status: "SUCCESS", finishedAt: new Date(), result: result as never },
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await prisma.job.update({
        where: { id: data.jobId },
        data: { status: final ? "FAILED" : "QUEUED", error: msg, finishedAt: final ? new Date() : null },
      });
      throw e;
    }
  },
  { connection: redis(), concurrency },
);

async function runScheduledBackup(shopDomain: string, destinationId: string, log: (m: string) => void) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain }, include: { destinations: true } });
  if (!shop || shop.uninstalledAt) {
    log("shop missing or uninstalled; skipping");
    return { skipped: true };
  }
  // The scheduler was created with a destination id; fall back to the first verified one if it was removed.
  const dest = shop.destinations.find((d) => d.id === destinationId) ?? shop.destinations.find((d) => d.verifiedAt);
  if (!dest) {
    log("no destination; skipping");
    return { skipped: true };
  }

  const row = await prisma.job.create({
    data: { shopId: shop.id, type: "BACKUP_FULL", status: "RUNNING", startedAt: new Date(), payload: { destinationId: dest.id, scheduled: true } },
  });

  let result: Awaited<ReturnType<typeof runBackup>> | undefined;
  let error: string | undefined;
  try {
    result = await runBackup({ shopDomain, destinationId: dest.id, kind: "FULL", jobId: row.id, log });
    await prisma.job.update({ where: { id: row.id }, data: { status: "SUCCESS", finishedAt: new Date(), result: result as never } });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    await prisma.job.update({ where: { id: row.id }, data: { status: "FAILED", finishedAt: new Date(), error } });
  }

  try {
    const pruned = await pruneShop(shop.id, log);
    if (pruned.deletedSnapshots) log(`retention: removed ${pruned.deletedSnapshots} snapshot(s), ${pruned.deletedObjects} object(s)`);
  } catch (e) {
    log(`retention failed: ${e instanceof Error ? e.message : e}`);
  }

  if (shop.notifyEmail && shop.emailDaily) {
    const snap = result ? await prisma.snapshot.findUnique({ where: { id: result.snapshotId } }) : null;
    const perResource: Record<string, { count: number; error?: string }> = {};
    if (snap) {
      const counts = await prisma.snapshotItem.groupBy({ by: ["resource"], where: { snapshotId: snap.id, deleted: false }, _count: { _all: true } });
      for (const c of counts) perResource[c.resource] = { count: c._count._all };
      for (const f of result?.failures ?? []) {
        const [r, ...rest] = f.split(": ");
        perResource[r] = { count: 0, error: rest.join(": ") };
      }
    }
    const mail = summaryEmail({
      shopName: shop.name ?? shop.domain,
      status: result?.status ?? "FAILED",
      startedAt: snap?.startedAt ?? new Date(),
      items: result?.items ?? 0,
      changed: result?.changed ?? 0,
      bytes: result?.bytes ?? 0,
      failures: error ? [error] : (result?.failures ?? []),
      perResource,
      snapshotUrl: snap ? `https://${shop.domain}/admin/apps/${process.env.SHOPIFY_APP_HANDLE || "derops-backup"}/app/snapshots/${snap.id}` : undefined,
    });
    try {
      await sendMail(shop.notifyEmail, mail.subject, mail.text);
    } catch (e) {
      log(`email failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (error) throw new Error(error);
  return result;
}

worker.on("ready", () => console.log(`worker ready on queue "${QUEUE_NAME}" (concurrency ${concurrency})`));
worker.on("failed", (job, err) => console.error(`job ${job?.id} failed: ${err.message}`));

async function shutdown() {
  console.log("worker shutting down");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
