import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAME = "derops-backup";

export type BackupJobData =
  | { type: "BACKUP_FULL"; shopDomain: string; jobId: string; destinationId: string; resources?: string[]; kind?: "FULL" | "MANUAL" }
  | { type: "VERIFY_DESTINATION"; shopDomain: string; jobId: string; destinationId: string }
  | { type: "RESTORE_ITEM"; shopDomain: string; jobId: string; snapshotItemId: string; targetThemeId?: string };

let connection: IORedis | undefined;
export function redis(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return connection;
}

let queue: Queue<BackupJobData> | undefined;
export function backupQueue(): Queue<BackupJobData> {
  if (!queue) {
    queue = new Queue<BackupJobData>(QUEUE_NAME, {
      connection: redis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }
  return queue;
}
