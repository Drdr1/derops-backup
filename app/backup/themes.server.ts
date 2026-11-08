import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import type { Storage } from "../lib/storage.server";
import { gql } from "./bulk.server";

/**
 * Theme backup. Not a bulk operation: themes are read page by page (250 files per page).
 * Each file becomes one object in storage: <folder>/themes/<themeId>/<filename>
 * Unchanged files (same checksum as the previous snapshot) are NOT re-uploaded; their
 * SnapshotItem points at the previous snapshot's object. This is where real dedup pays off:
 * a theme has 300–600 files and almost none change day to day.
 */

type ThemeNode = { id: string; name: string; role: string; processing: boolean; updatedAt: string };

type ThemeFileNode = {
  filename: string;
  size: number;
  checksumMd5: string | null;
  contentType: string;
  body:
    | { __typename: "OnlineStoreThemeFileBodyText"; content: string }
    | { __typename: "OnlineStoreThemeFileBodyBase64"; contentBase64: string }
    | { __typename: "OnlineStoreThemeFileBodyUrl"; url: string };
};

export async function listThemes(admin: AdminApiContext): Promise<ThemeNode[]> {
  const res = await gql<{ themes: { nodes: ThemeNode[] } }>(
    admin,
    `#graphql
    query themes { themes(first: 50) { nodes { id name role processing updatedAt } } }`,
  );
  return res.themes.nodes;
}

async function* themeFiles(admin: AdminApiContext, themeId: string): AsyncGenerator<ThemeFileNode> {
  let after: string | null = null;
  for (;;) {
    const res: {
      theme: {
        files: {
          nodes: ThemeFileNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          userErrors: { filename: string; code: string }[];
        } | null;
      } | null;
    } = await gql(
      admin,
      `#graphql
      query themeFiles($id: ID!, $after: String) {
        theme(id: $id) {
          files(first: 250, after: $after) {
            nodes {
              filename size checksumMd5 contentType
              body {
                __typename
                ... on OnlineStoreThemeFileBodyText { content }
                ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
                ... on OnlineStoreThemeFileBodyUrl { url }
              }
            }
            pageInfo { hasNextPage endCursor }
            userErrors { filename code }
          }
        }
      }`,
      { id: themeId, after },
    );
    const files = res.theme?.files;
    if (!files) return;
    for (const f of files.nodes) yield f;
    if (!files.pageInfo.hasNextPage) return;
    after = files.pageInfo.endCursor;
  }
}

export async function backupThemes(p: {
  admin: AdminApiContext;
  storage: Storage;
  folder: string;
  snapshotId: string;
  previousSnapshotId?: string;
  log: (m: string) => void;
}) {
  const { admin, storage, folder, snapshotId, previousSnapshotId, log } = p;

  const themes = (await listThemes(admin)).filter((t) => !t.processing && t.role !== "DEMO");
  log(`themes: ${themes.length} (${themes.map((t) => `${t.name}[${t.role}]`).join(", ")})`);

  const prevRows = previousSnapshotId
    ? await prisma.snapshotItem.findMany({
        where: { snapshotId: previousSnapshotId, resource: "THEME_FILE", deleted: false },
        select: { shopifyGid: true, contentHash: true, storageKey: true },
      })
    : [];
  const prev = new Map(prevRows.map((r) => [r.shopifyGid, r]));
  const seen = new Set<string>();

  const rows: Prisma.SnapshotItemCreateManyInput[] = [];
  let bytes = 0;
  let changed = 0;
  let uploaded = 0;
  const index: Record<string, { name: string; role: string; files: number }> = {};

  for (const theme of themes) {
    const themeNumericId = theme.id.split("/").pop()!;
    let count = 0;

    for await (const f of themeFiles(admin, theme.id)) {
      count++;
      const gid = `${theme.id}#${f.filename}`;
      seen.add(gid);

      // Resolve body -> bytes
      let data: Buffer;
      if (f.body.__typename === "OnlineStoreThemeFileBodyText") data = Buffer.from(f.body.content, "utf8");
      else if (f.body.__typename === "OnlineStoreThemeFileBodyBase64") data = Buffer.from(f.body.contentBase64, "base64");
      else data = Buffer.from(await (await fetch(f.body.url)).arrayBuffer());

      const hash = f.checksumMd5 ?? createHash("sha256").update(data).digest("hex");
      const before = prev.get(gid);
      const isChanged = !before || before.contentHash !== hash;

      let storageKey: string;
      if (isChanged) {
        const rel = `${folder}/themes/${themeNumericId}/${f.filename}`;
        await storage.put(rel, data, f.contentType || "application/octet-stream");
        storageKey = storage.fullKey(rel);
        uploaded++;
        changed++;
        bytes += data.byteLength;
      } else {
        storageKey = before!.storageKey; // dedup: reuse previous object
      }

      rows.push({
        snapshotId,
        resource: "THEME_FILE",
        shopifyGid: gid,
        title: `${theme.name} / ${f.filename}`.slice(0, 255),
        contentHash: hash,
        storageKey,
        sizeBytes: data.byteLength,
        changed: isChanged,
      });
    }
    index[theme.id] = { name: theme.name, role: theme.role, files: count };
    log(`theme ${theme.name}: ${count} files`);
  }

  for (const [gid, before] of prev) {
    if (seen.has(gid)) continue;
    rows.push({
      snapshotId,
      resource: "THEME_FILE",
      shopifyGid: gid,
      contentHash: before.contentHash,
      storageKey: before.storageKey,
      sizeBytes: 0,
      changed: true,
      deleted: true,
    });
    changed++;
  }

  // themes.json: which themes existed and their roles at snapshot time (needed to restore a whole theme later)
  const indexJson = JSON.stringify({ themes: index }, null, 2);
  await storage.put(`${folder}/themes/themes.json`, indexJson, "application/json");
  bytes += Buffer.byteLength(indexJson);

  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.snapshotItem.createMany({ data: rows.slice(i, i + 1000) });
  }

  return {
    items: rows.filter((r) => !r.deleted).length,
    changed,
    uploaded,
    bytes,
    manifestEntry: { file: "themes/", count: rows.filter((r) => !r.deleted).length, sha256: "", themes: index },
  };
}
