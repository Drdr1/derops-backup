import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storageFor } from "../lib/storage.server";

/**
 * GET /app/snapshots/:id/download?item=<snapshotItemId>  -> one product / collection / file record as JSON.
 *
 * Theme files are never downloadable (Shopify App Store requirement 1.1.3: themes may only be
 * installed via the Theme Store). They can only be restored in place into the theme they came from.
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
    if (item.resource === "THEME_FILE") throw new Response("Theme files cannot be downloaded", { status: 403 });
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

  throw new Response("Specify ?item=", { status: 400 });
};
