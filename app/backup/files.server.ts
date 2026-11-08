import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import type { Storage } from "../lib/storage.server";
import { runBulkQuery, reassembleBulkJsonl } from "./bulk.server";

/**
 * Shopify Files (Content > Files): images, videos, 3D models, generic files.
 * Metadata goes to files.jsonl via a bulk query. Originals are downloaded into
 * <folder>/files/<numericId>-<basename> only when the versioned CDN URL changed
 * since the previous snapshot (Shopify appends ?v=<timestamp> on every change).
 * Videos and 3D models: metadata only in Phase 1 (originals can be hundreds of MB each).
 */

const FILES_QUERY = `#graphql
{
  files {
    edges {
      node {
        id
        __typename
        alt
        createdAt
        updatedAt
        fileStatus
        ... on MediaImage {
          mimeType
          originalSource { fileSize url }
          image { url width height }
        }
        ... on GenericFile {
          mimeType
          originalFileSize
          url
        }
        ... on Video {
          duration
          originalSource { fileSize url mimeType }
        }
        ... on Model3d {
          originalSource { filesize url mimeType }
        }
      }
    }
  }
}`;

function originalUrl(o: Record<string, unknown>): string | undefined {
  const typename = o.__typename as string;
  if (typename === "GenericFile") return o.url as string | undefined;
  if (typename === "MediaImage") {
    const src = o.originalSource as { url?: string } | undefined;
    const img = o.image as { url?: string } | undefined;
    return src?.url ?? img?.url;
  }
  return undefined; // Video / Model3d: metadata only
}

function basenameFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split("/").pop() || "file");
  } catch {
    return "file";
  }
}

export async function backupFiles(p: {
  admin: AdminApiContext;
  storage: Storage;
  folder: string;
  snapshotId: string;
  previousSnapshotId?: string;
  log: (m: string) => void;
}) {
  const { admin, storage, folder, snapshotId, previousSnapshotId, log } = p;

  const { url } = await runBulkQuery(admin, FILES_QUERY);
  const raw = url ? await (await fetch(url)).text() : "";
  const objects = reassembleBulkJsonl(raw, {});

  const prevRows = previousSnapshotId
    ? await prisma.snapshotItem.findMany({
        where: { snapshotId: previousSnapshotId, resource: "FILE", deleted: false },
        select: { shopifyGid: true, contentHash: true, storageKey: true },
      })
    : [];
  const prev = new Map(prevRows.map((r) => [r.shopifyGid, r]));
  const seen = new Set<string>();

  const rows: Prisma.SnapshotItemCreateManyInput[] = [];
  const lines: string[] = [];
  let bytes = 0;
  let changed = 0;
  let downloaded = 0;

  for (const obj of objects) {
    const gid = String(obj.id);
    seen.add(gid);
    const src = originalUrl(obj);
    // Hash = the versioned URL when we have one (cheap, exact), else the metadata line.
    const hash = createHash("sha256").update(src ?? JSON.stringify(obj)).digest("hex");
    const before = prev.get(gid);
    const isChanged = !before || before.contentHash !== hash;

    let storageKey = storage.fullKey(`${folder}/files.jsonl`);
    let size = 0;

    if (src) {
      if (isChanged) {
        const numericId = gid.split("/").pop();
        const rel = `${folder}/files/${numericId}-${basenameFromUrl(src)}`;
        const res = await fetch(src);
        if (!res.ok || !res.body) throw new Error(`download failed ${res.status} for ${gid}`);
        const len = Number(res.headers.get("content-length") || 0);
        await storage.putStream(rel, Readable.fromWeb(res.body as never), res.headers.get("content-type") || undefined);
        storageKey = storage.fullKey(rel);
        size = len;
        bytes += len;
        downloaded++;
        (obj as Record<string, unknown>).__backupKey = storageKey;
      } else {
        storageKey = before!.storageKey;
        (obj as Record<string, unknown>).__backupKey = storageKey;
      }
    }
    if (isChanged) changed++;

    lines.push(JSON.stringify(obj));
    rows.push({
      snapshotId,
      resource: "FILE",
      shopifyGid: gid,
      title: ((obj.alt as string) || (src ? basenameFromUrl(src) : gid)).slice(0, 255),
      contentHash: hash,
      storageKey,
      sizeBytes: size,
      changed: isChanged,
    });
  }

  for (const [gid, before] of prev) {
    if (seen.has(gid)) continue;
    rows.push({
      snapshotId,
      resource: "FILE",
      shopifyGid: gid,
      contentHash: before.contentHash,
      storageKey: before.storageKey,
      sizeBytes: 0,
      changed: true,
      deleted: true,
    });
    changed++;
  }

  const body = lines.join("\n") + (lines.length ? "\n" : "");
  await storage.put(`${folder}/files.jsonl`, body, "application/x-ndjson");
  bytes += Buffer.byteLength(body);

  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.snapshotItem.createMany({ data: rows.slice(i, i + 1000) });
  }

  log(`files: ${objects.length} items, ${downloaded} originals downloaded`);
  return {
    items: objects.length,
    changed,
    bytes,
    manifestEntry: { file: "files.jsonl", count: objects.length, sha256: createHash("sha256").update(body).digest("hex") },
  };
}

