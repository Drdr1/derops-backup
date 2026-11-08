import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Destination } from "@prisma/client";
import type { Readable } from "node:stream";
import { decrypt } from "./crypto.server";

/**
 * One S3-compatible interface for every destination kind.
 * MANAGED = our bucket (env MANAGED_S3_*), S3 = merchant's own bucket (AWS, R2, B2, Wasabi, MinIO).
 */
export type Storage = {
  bucket: string;
  prefix: string; // always ends without trailing slash
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  putStream(key: string, body: Readable, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  getText(key: string): Promise<string>;
  /** Read by an already-prefixed key, e.g. SnapshotItem.storageKey */
  getFull(fullKey: string): Promise<Buffer>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  fullKey(relative: string): string;
};

function clientFor(dest: Destination): { client: S3Client; bucket: string; prefix: string } {
  if (dest.kind === "MANAGED") {
    const endpoint = process.env.MANAGED_S3_ENDPOINT;
    const bucket = process.env.MANAGED_S3_BUCKET;
    const accessKeyId = process.env.MANAGED_S3_ACCESS_KEY;
    const secretAccessKey = process.env.MANAGED_S3_SECRET_KEY;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("MANAGED_S3_* env vars are not configured");
    }
    return {
      client: new S3Client({
        endpoint,
        region: process.env.MANAGED_S3_REGION || "auto",
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      }),
      bucket,
      prefix: dest.prefix || "",
    };
  }

  if (!dest.endpoint || !dest.bucket || !dest.accessKeyEnc || !dest.secretKeyEnc) {
    throw new Error(`Destination ${dest.id} is missing S3 configuration`);
  }
  return {
    client: new S3Client({
      endpoint: dest.endpoint,
      region: dest.region || "auto",
      credentials: {
        accessKeyId: decrypt(dest.accessKeyEnc),
        secretAccessKey: decrypt(dest.secretKeyEnc),
      },
      // Path-style works for R2, B2, MinIO and AWS; virtual-hosted breaks on several providers.
      forcePathStyle: true,
    }),
    bucket: dest.bucket,
    prefix: dest.prefix || "",
  };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function storageFor(dest: Destination): Storage {
  const { client, bucket, prefix } = clientFor(dest);
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const fullKey = (rel: string) => (cleanPrefix ? `${cleanPrefix}/${rel}` : rel);

  return {
    bucket,
    prefix: cleanPrefix,
    fullKey,
    async put(key, body, contentType = "application/octet-stream") {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: fullKey(key), Body: body, ContentType: contentType }),
      );
    },
    async putStream(key, body, contentType = "application/octet-stream") {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: fullKey(key), Body: body, ContentType: contentType },
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
      });
      await upload.done();
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
      return streamToBuffer(res.Body as Readable);
    },
    async getText(key) {
      return (await this.get(key)).toString("utf8");
    },
    async getFull(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return streamToBuffer(res.Body as Readable);
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
    },
    async list(rel) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: fullKey(rel), ContinuationToken: token }),
        );
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

/**
 * Write, read back, delete a probe object. Throws with a readable message on failure.
 * Used when a merchant saves a destination and before every backup run.
 */
export async function verifyDestination(dest: Destination): Promise<void> {
  const s = storageFor(dest);
  const probeKey = `.derops-backup-probe-${Date.now()}`;
  const payload = `probe ${new Date().toISOString()}`;
  try {
    const { client, bucket } = clientFor(dest);
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (e) {
    throw new Error(`Bucket not reachable: ${describe(e)}`);
  }
  try {
    await s.put(probeKey, payload, "text/plain");
  } catch (e) {
    throw new Error(`Write failed (check write permission): ${describe(e)}`);
  }
  try {
    const back = await s.getText(probeKey);
    if (back !== payload) throw new Error("read-back mismatch");
  } catch (e) {
    throw new Error(`Read failed (check read permission): ${describe(e)}`);
  }
  try {
    await s.del(probeKey);
  } catch {
    // Delete permission is optional; retention pruning will just be skipped for this destination.
  }
}

function describe(e: unknown): string {
  if (e && typeof e === "object" && "name" in e) {
    const err = e as { name: string; message?: string; $metadata?: { httpStatusCode?: number } };
    return `${err.name}${err.$metadata?.httpStatusCode ? ` (HTTP ${err.$metadata.httpStatusCode})` : ""}${err.message ? `: ${err.message}` : ""}`;
  }
  return String(e);
}
