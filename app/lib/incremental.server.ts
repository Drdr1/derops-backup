import type { ResourceType } from "@prisma/client";
import { backupQueue, redis } from "./queue.server";

/**
 * Near-real-time backups. Shopify webhooks (products/*, collections/*, themes/*) call noteChange();
 * we remember which resource types were touched and schedule ONE incremental backup per shop,
 * DEBOUNCE_MS after the first change. Bursts of edits (a theme customizer session, a CSV import)
 * collapse into a single run. Unchanged items cost nothing thanks to content hashing.
 */
export const DEBOUNCE_MS = Number(process.env.INCREMENTAL_DEBOUNCE_MS || 5 * 60_000);

const key = (shopDomain: string) => `incr:${shopDomain}`;

export const TOPIC_RESOURCE: Record<string, ResourceType> = {
  "products/create": "PRODUCT",
  "products/update": "PRODUCT",
  "products/delete": "PRODUCT",
  "collections/create": "COLLECTION",
  "collections/update": "COLLECTION",
  "collections/delete": "COLLECTION",
  "themes/create": "THEME_FILE",
  "themes/update": "THEME_FILE",
  "themes/delete": "THEME_FILE",
  "themes/publish": "THEME_FILE",
};

export async function noteChange(shopDomain: string, resource: ResourceType) {
  const r = redis();
  await r.sadd(key(shopDomain), resource);
  await r.expire(key(shopDomain), 6 * 3600);
  // jobId makes this idempotent: while a debounced job is waiting, further calls are no-ops.
  await backupQueue().add(
    "incremental",
    { type: "INCREMENTAL_BACKUP", shopDomain },
    { jobId: `incr-${shopDomain.replace(/[^a-z0-9.-]/gi, "_")}`, delay: DEBOUNCE_MS, attempts: 1, removeOnComplete: true, removeOnFail: 50 },
  );
}

/** Pop the set of touched resources (empties it so the next change starts a new window). */
export async function takeChanges(shopDomain: string): Promise<ResourceType[]> {
  const r = redis();
  const members = (await r.smembers(key(shopDomain))) as ResourceType[];
  await r.del(key(shopDomain));
  return members;
}
