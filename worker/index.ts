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

const concurrency = Number(process.env.WORKER_CONCURRENCY || 2);

const worker = new Worker<BackupJobData>(
  QUEUE_NAME,
  async (job: BullJob<BackupJobData>) => {
    const data = job.data;
    const log = (msg: string) => {
      console.log(`[${data.type}] ${data.shopDomain}: ${msg}`);
      void job.log(msg);
    };

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
