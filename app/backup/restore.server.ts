import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { storageFor } from "../lib/storage.server";
import { gql } from "./bulk.server";
import { themeZipBuffer } from "./themezip.server";

export type RestoreResult = { ok: true; message: string; shopifyId?: string } | { ok: false; message: string };

/**
 * Restore one SnapshotItem back into the store.
 * PRODUCT     -> productSet (updates in place if the product still exists, recreates it if deleted)
 * THEME_FILE  -> themeFilesUpsert into targetThemeId (defaults to the theme the file came from)
 */
export async function restoreItem(args: {
  shopDomain: string;
  snapshotItemId: string;
  targetThemeId?: string;
  log?: (m: string) => void;
}): Promise<RestoreResult> {
  const log = args.log ?? (() => {});
  const item = await prisma.snapshotItem.findUniqueOrThrow({
    where: { id: args.snapshotItemId },
    include: { snapshot: { include: { destination: true, shop: true } } },
  });
  if (item.snapshot.shop.domain !== args.shopDomain) throw new Error("Item does not belong to this shop");
  if (item.deleted) return { ok: false, message: "This item was already gone when the snapshot ran; pick an earlier snapshot." };

  const storage = storageFor(item.snapshot.destination);
  const { admin } = await unauthenticated.admin(args.shopDomain);

  switch (item.resource) {
    case "PRODUCT": {
      const obj = await readJsonlRecord(storage, item.storageKey, item.shopifyGid);
      if (!obj) return { ok: false, message: "Record not found in backup file" };
      return restoreProduct(admin, obj, log);
    }
    case "THEME_FILE": {
      const [themeId, filename] = item.shopifyGid.split("#");
      const data = await storage.getFull(item.storageKey);
      return restoreThemeFile(admin, args.targetThemeId || themeId, filename, data, log);
    }
    default:
      return { ok: false, message: `Restore for ${item.resource} is not available yet (export only).` };
  }
}

/** Scan a JSONL file for the line whose id matches. Files are per-resource, usually a few MB. */
async function readJsonlRecord(storage: ReturnType<typeof storageFor>, fullKey: string, gid: string) {
  const text = (await storage.getFull(fullKey)).toString("utf8");
  const needle = `"id":"${gid}"`;
  for (const line of text.split("\n")) {
    if (line.includes(needle)) {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.id === gid) return o;
    }
  }
  return null;
}

// ---------------------------------------------------------------- products

type BackedUpProduct = {
  id: string;
  handle: string;
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: string;
  tags?: string[];
  templateSuffix?: string | null;
  seo?: { title?: string | null; description?: string | null };
  options?: { name: string; position: number; values: string[] }[];
  variants?: {
    id: string;
    sku?: string | null;
    barcode?: string | null;
    price?: string;
    compareAtPrice?: string | null;
    position?: number;
    taxable?: boolean;
    taxCode?: string | null;
    inventoryPolicy?: string;
    selectedOptions?: { name: string; value: string }[];
    inventoryItem?: {
      tracked?: boolean;
      requiresShipping?: boolean;
      measurement?: { weight?: { value: number; unit: string } | null } | null;
      unitCost?: { amount: string } | null;
    };
  }[];
  metafields?: { namespace: string; key: string; type: string; value: string }[];
};

async function restoreProduct(admin: AdminApiContext, raw: Record<string, unknown>, log: (m: string) => void): Promise<RestoreResult> {
  const p = raw as unknown as BackedUpProduct;

  // Does the product still exist? If yes we update in place and keep variant ids that still exist.
  const existing = await gql<{ product: { id: string; variants: { nodes: { id: string }[] } } | null }>(
    admin,
    `#graphql
    query existing($id: ID!) { product(id: $id) { id variants(first: 250) { nodes { id } } } }`,
    { id: p.id },
  );
  const exists = !!existing.product;
  const liveVariantIds = new Set(existing.product?.variants.nodes.map((v) => v.id) ?? []);
  log(exists ? `product ${p.id} exists → update in place` : `product ${p.id} is gone → recreate`);

  const input: Record<string, unknown> = {
    ...(exists ? { id: p.id } : {}),
    title: p.title,
    handle: p.handle,
    descriptionHtml: p.descriptionHtml ?? "",
    vendor: p.vendor ?? "",
    productType: p.productType ?? "",
    status: p.status ?? "ACTIVE",
    tags: p.tags ?? [],
    templateSuffix: p.templateSuffix ?? null,
    seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
    productOptions: (p.options ?? []).map((o) => ({
      name: o.name,
      position: o.position,
      values: o.values.map((v) => ({ name: v })),
    })),
    variants: (p.variants ?? []).map((v) => ({
      ...(exists && liveVariantIds.has(v.id) ? { id: v.id } : {}),
      optionValues: (v.selectedOptions ?? []).map((so) => ({ optionName: so.name, name: so.value })),
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? null,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      taxable: v.taxable ?? true,
      taxCode: v.taxCode ?? null,
      inventoryPolicy: v.inventoryPolicy ?? "DENY",
      position: v.position,
      inventoryItem: {
        tracked: v.inventoryItem?.tracked ?? false,
        requiresShipping: v.inventoryItem?.requiresShipping ?? true,
        ...(v.inventoryItem?.measurement?.weight
          ? { measurement: { weight: { value: v.inventoryItem.measurement.weight.value, unit: v.inventoryItem.measurement.weight.unit } } }
          : {}),
        ...(v.inventoryItem?.unitCost ? { cost: v.inventoryItem.unitCost.amount } : {}),
      },
    })),
    metafields: (p.metafields ?? []).map((m) => ({ namespace: m.namespace, key: m.key, type: m.type, value: m.value })),
  };

  const res = await gql<{
    productSet: { product: { id: string; title: string } | null; userErrors: { field: string[] | null; message: string; code: string }[] };
  }>(
    admin,
    `#graphql
    mutation restoreProduct($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id title }
        userErrors { field message code }
      }
    }`,
    { input },
  );

  const errs = res.productSet.userErrors;
  if (errs.length) {
    return { ok: false, message: errs.map((e) => `${e.field?.join(".") ?? ""} ${e.message}`.trim()).join("; ") };
  }
  const prod = res.productSet.product!;
  return {
    ok: true,
    shopifyId: prod.id,
    message: `${exists ? "Updated" : "Recreated"} "${prod.title}" (${p.variants?.length ?? 0} variants, ${p.metafields?.length ?? 0} metafields). Images/media are not restored in this version.`,
  };
}

// ---------------------------------------------------------------- theme files

const TEXT_EXT = /\.(liquid|json|js|css|scss|svg|txt|html|md|csv|xml)$/i;

async function restoreThemeFile(
  admin: AdminApiContext,
  themeId: string,
  filename: string,
  data: Buffer,
  log: (m: string) => void,
): Promise<RestoreResult> {
  const isText = TEXT_EXT.test(filename);
  const body = isText
    ? { type: "TEXT", value: data.toString("utf8") }
    : { type: "BASE64", value: data.toString("base64") };
  log(`themeFilesUpsert ${filename} → ${themeId} (${isText ? "text" : "base64"}, ${data.byteLength} bytes)`);

  const res = await gql<{
    themeFilesUpsert: {
      upsertedThemeFiles: { filename: string }[] | null;
      job: { id: string; done: boolean } | null;
      userErrors: { filename: string | null; code: string | null; message: string }[];
    };
  }>(
    admin,
    `#graphql
    mutation restoreThemeFile($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
      themeFilesUpsert(themeId: $themeId, files: $files) {
        upsertedThemeFiles { filename }
        job { id done }
        userErrors { filename code message }
      }
    }`,
    { themeId, files: [{ filename, body }] },
  );

  const errs = res.themeFilesUpsert.userErrors;
  if (errs.length) return { ok: false, message: errs.map((e) => e.message).join("; ") };
  return { ok: true, shopifyId: themeId, message: `Restored ${filename} into theme ${themeId.split("/").pop()}` };
}

// ---------------------------------------------------------------- whole themes

/**
 * Restore a theme from a snapshot as a NEW unpublished theme (never touches the live theme).
 * Flow: zip the snapshot's files → put the zip in the merchant's bucket → hand Shopify a
 * 1-hour presigned URL via themeCreate → wait until Shopify finishes processing → delete the zip.
 * Requires Shopify's theme-write exemption (granted for backup/restore use only).
 */
export async function restoreTheme(args: {
  shopDomain: string;
  snapshotId: string;
  themeGid: string;
  log?: (m: string) => void;
}): Promise<RestoreResult> {
  const log = args.log ?? (() => {});
  const snapshot = await prisma.snapshot.findUniqueOrThrow({
    where: { id: args.snapshotId },
    include: { destination: true, shop: true },
  });
  if (snapshot.shop.domain !== args.shopDomain) throw new Error("Snapshot does not belong to this shop");

  const files = await prisma.snapshotItem.findMany({
    where: { snapshotId: snapshot.id, resource: "THEME_FILE", deleted: false, shopifyGid: { startsWith: `${args.themeGid}#` } },
    select: { shopifyGid: true, storageKey: true, title: true },
  });
  if (files.length === 0) return { ok: false, message: "No files for this theme in the snapshot" };

  const storage = storageFor(snapshot.destination);
  const { admin } = await unauthenticated.admin(args.shopDomain);

  const themeName = (files[0].title ?? "theme").split(" / ")[0];
  const stamp = snapshot.startedAt.toISOString().slice(0, 16).replace("T", " ");
  const newName = `${themeName} (restored ${stamp})`.slice(0, 50); // Shopify caps theme names at 50 chars

  log(`zipping ${files.length} files of "${themeName}"`);
  const zip = await themeZipBuffer(storage, files);
  const tmpKey = `_restore/${args.themeGid.split("/").pop()}-${Date.now()}.zip`;
  await storage.put(tmpKey, zip, "application/zip");
  const source = await storage.presignGet(tmpKey, 3600);
  log(`zip ${zip.byteLength} bytes at ${tmpKey}; calling themeCreate`);
  let keepZip = false;

  try {
    const res = await gql<{
      themeCreate: {
        theme: { id: string; name: string; processing: boolean } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      admin,
      `#graphql
      mutation restoreTheme($source: URL!, $name: String!) {
        themeCreate(source: $source, name: $name) {
          theme { id name processing }
          userErrors { field message }
        }
      }`,
      { source, name: newName },
    );
    const errs = res.themeCreate.userErrors;
    if (errs.length) return { ok: false, message: errs.map((e) => e.message).join("; ") };
    const theme = res.themeCreate.theme!;

    // Shopify downloads and unpacks the zip asynchronously; poll until done (or give up after ~5 min).
    let processing = theme.processing;
    for (let i = 0; processing && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const t = await gql<{ theme: { processing: boolean; processingFailed: boolean } | null }>(
        admin,
        `#graphql
        query themeStatus($id: ID!) { theme(id: $id) { processing processingFailed } }`,
        { id: theme.id },
      );
      if (!t.theme) return { ok: false, message: "Theme disappeared while Shopify was processing it" };
      if (t.theme.processingFailed) return { ok: false, message: "Shopify failed to process the theme zip" };
      processing = t.theme.processing;
    }
    if (processing) {
      keepZip = true; // Shopify may still be fetching it; the zip is small and lives in the merchant's own bucket
      return { ok: true, shopifyId: theme.id, message: `Created "${theme.name}"; Shopify is still processing it — check Online Store → Themes.` };
    }
    return {
      ok: true,
      shopifyId: theme.id,
      message: `Restored as new unpublished theme "${theme.name}" (${files.length} files). Preview it in Online Store → Themes, then publish when ready.`,
    };
  } finally {
    if (!keepZip) await storage.del(tmpKey).catch((e) => log(`could not delete ${tmpKey}: ${e}`));
  }
}
