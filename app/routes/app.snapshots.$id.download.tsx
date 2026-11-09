import type { LoaderFunctionArgs } from "react-router";
import * as archiverNs from "archiver";
const archiver = (archiverNs as unknown as { default?: typeof archiverNs }).default ?? archiverNs;
import { PassThrough, Readable } from "node:stream";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storageFor } from "../lib/storage.server";

/**
 * GET /app/snapshots/:id/download?theme=gid://shopify/OnlineStoreTheme/123   -> theme as .zip (upload in Online Store > Themes)
 * GET /app/snapshots/:id/download?item=<snapshotItemId>                     -> one theme file / product JSON
 *
 * This is the restore path that needs no Shopify theme-write exemption: the merchant uploads the zip themselves.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const snapshot = await prisma.snapshot.findFirst({
    where: { id: params.id, shopId: shop.id },
    include: { destination: true },
  });
  if (!snapshot) throw new Response("Not found", { status: 404 });
  const storage = storageFor(snapshot.destination);
  const url = new URL(request.url);

  const itemId = url.searchParams.get("item");
  if (itemId) {
    const item = await prisma.snapshotItem.findFirst({ where: { id: itemId, snapshotId: snapshot.id } });
    if (!item) throw new Response("Not found", { status: 404 });
    if (item.resource === "THEME_FILE") {
      const filename = item.shopifyGid.split("#")[1];
      const data = await storage.getFull(item.storageKey);
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename.split("/").pop()}"`,
        },
      });
    }
    // JSONL-backed resources: return the single record as pretty JSON
    const text = (await storage.getFull(item.storageKey)).toString("utf8");
    const line = text.split("\n").find((l) => l.includes(`"id":"${item.shopifyGid}"`));
    if (!line) throw new Response("Record not found", { status: 404 });
    return new Response(JSON.stringify(JSON.parse(line), null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${item.resource.toLowerCase()}-${item.shopifyGid.split("/").pop()}.json"`,
      },
    });
  }

  const themeGid = url.searchParams.get("theme");
  if (themeGid) {
    const files = await prisma.snapshotItem.findMany({
      where: { snapshotId: snapshot.id, resource: "THEME_FILE", deleted: false, shopifyGid: { startsWith: `${themeGid}#` } },
      select: { shopifyGid: true, storageKey: true, title: true },
    });
    if (files.length === 0) throw new Response("No files for this theme", { status: 404 });

    const themeName = (files[0].title ?? "theme").split(" / ")[0].replace(/[^\w.-]+/g, "_");
    const stamp = snapshot.startedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-");

    const zip = archiver("zip", { zlib: { level: 6 } });
    const out = new PassThrough();
    zip.pipe(out);

    // Pull files from storage with modest concurrency, append in deterministic order.
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

    return new Response(Readable.toWeb(out) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${themeName}-${stamp}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  }

  throw new Response("Specify ?theme= or ?item=", { status: 400 });
};
