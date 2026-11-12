import { ZipArchive } from "archiver";
import { PassThrough, Readable } from "node:stream";
import type { Storage } from "../lib/storage.server";

export type ThemeFileRef = { shopifyGid: string; storageKey: string };

/**
 * Stream a theme's files out of storage into a .zip, in the layout Shopify expects
 * (layout/, templates/, assets/, ... at the root). Returns a readable stream.
 */
export function themeZipStream(storage: Storage, files: ThemeFileRef[]): Readable {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const out = new PassThrough();
  zip.pipe(out);

  (async () => {
    try {
      const sorted = [...files].sort((a, b) => a.shopifyGid.localeCompare(b.shopifyGid));
      const CONC = 8;
      for (let i = 0; i < sorted.length; i += CONC) {
        const batch = sorted.slice(i, i + CONC);
        const bufs = await Promise.all(batch.map((f) => storage.getFull(f.storageKey)));
        batch.forEach((f, j) => zip.append(bufs[j], { name: f.shopifyGid.split("#")[1] }));
      }
      await zip.finalize();
    } catch (e) {
      zip.destroy(e as Error);
      out.destroy(e as Error);
    }
  })();

  return out;
}

export async function themeZipBuffer(storage: Storage, files: ThemeFileRef[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of themeZipStream(storage, files)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
