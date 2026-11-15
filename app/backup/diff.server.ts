import { diffLines } from "diff";
import prisma from "../db.server";
import { storageFor, type Storage } from "../lib/storage.server";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };
export type FieldChange = { path: string; before: string | null; after: string | null };

export type ItemDiff =
  | { mode: "text"; lines: DiffLine[]; added: number; removed: number; truncated: boolean }
  | { mode: "fields"; changes: FieldChange[] }
  | { mode: "binary"; beforeBytes: number; afterBytes: number }
  | { mode: "new" }
  | { mode: "deleted" };

const TEXT_EXT = /\.(liquid|json|js|css|scss|svg|txt|html|md|csv|xml)$/i;
const MAX_LINES = 4000;

/** Compare a SnapshotItem with the most recent earlier version of the same object. */
export async function diffItem(snapshotItemId: string, shopId: string): Promise<{ title: string; previousAt: Date | null; diff: ItemDiff }> {
  const item = await prisma.snapshotItem.findFirstOrThrow({
    where: { id: snapshotItemId, snapshot: { shopId } },
    include: { snapshot: { include: { destination: true } } },
  });
  const prev = await prisma.snapshotItem.findFirst({
    where: {
      snapshot: { shopId, startedAt: { lt: item.snapshot.startedAt }, status: { in: ["SUCCESS", "PARTIAL"] } },
      shopifyGid: item.shopifyGid,
      resource: item.resource,
      deleted: false,
      contentHash: { not: item.contentHash },
    },
    orderBy: { snapshot: { startedAt: "desc" } },
    include: { snapshot: { include: { destination: true } } },
  });
  const title = item.title ?? item.shopifyGid;

  if (item.deleted) return { title, previousAt: prev?.snapshot.startedAt ?? null, diff: { mode: "deleted" } };
  if (!prev) return { title, previousAt: null, diff: { mode: "new" } };

  const [after, before] = await Promise.all([loadContent(item), loadContent(prev)]);

  if (item.resource === "THEME_FILE") {
    const filename = item.shopifyGid.split("#")[1] ?? "";
    if (!TEXT_EXT.test(filename)) {
      return { title, previousAt: prev.snapshot.startedAt, diff: { mode: "binary", beforeBytes: before.byteLength, afterBytes: after.byteLength } };
    }
    return { title, previousAt: prev.snapshot.startedAt, diff: textDiff(before.toString("utf8"), after.toString("utf8")) };
  }

  // JSONL-backed resources: field-level comparison
  const a = JSON.parse(before.toString("utf8")) as unknown;
  const b = JSON.parse(after.toString("utf8")) as unknown;
  return { title, previousAt: prev.snapshot.startedAt, diff: { mode: "fields", changes: fieldChanges(a, b) } };
}

async function loadContent(item: { resource: string; storageKey: string; shopifyGid: string; snapshot: { destination: Parameters<typeof storageFor>[0] } }): Promise<Buffer> {
  const storage: Storage = storageFor(item.snapshot.destination);
  if (item.resource === "THEME_FILE" || item.resource === "FILE") return storage.getFull(item.storageKey);
  const text = (await storage.getFull(item.storageKey)).toString("utf8");
  const needle = `"id":"${item.shopifyGid}"`;
  for (const line of text.split("\n")) {
    if (line.includes(needle)) {
      const o = JSON.parse(line) as { id?: string };
      if (o.id === item.shopifyGid) return Buffer.from(line, "utf8");
    }
  }
  throw new Error("Record not found in backup file");
}

export function textDiff(before: string, after: string): ItemDiff {
  const parts = diffLines(before, after);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    const kind: DiffLine["kind"] = p.added ? "add" : p.removed ? "del" : "same";
    const ls = p.value.replace(/\n$/, "").split("\n");
    if (kind === "add") added += ls.length;
    if (kind === "del") removed += ls.length;
    for (const text of ls) lines.push({ kind, text });
  }
  // Collapse long unchanged runs to 3 lines of context on each side.
  const out: DiffLine[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== "same") {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "same") j++;
    const run = lines.slice(i, j);
    if (run.length > 8) {
      out.push(...run.slice(0, 3), { kind: "same", text: `… ${run.length - 6} unchanged lines …` }, ...run.slice(-3));
    } else out.push(...run);
    i = j;
  }
  return { mode: "text", lines: out.slice(0, MAX_LINES), added, removed, truncated: out.length > MAX_LINES };
}

/** Flatten two JSON values and list the paths whose values differ. Arrays of objects with ids are matched by id. */
export function fieldChanges(a: unknown, b: unknown): FieldChange[] {
  const fa = new Map<string, string>();
  const fb = new Map<string, string>();
  flatten(a, "", fa);
  flatten(b, "", fb);
  const paths = new Set([...fa.keys(), ...fb.keys()]);
  const out: FieldChange[] = [];
  for (const p of [...paths].sort()) {
    const x = fa.get(p) ?? null;
    const y = fb.get(p) ?? null;
    if (x !== y) out.push({ path: p, before: x, after: y });
  }
  return out;
}

function flatten(v: unknown, prefix: string, out: Map<string, string>) {
  if (Array.isArray(v)) {
    const byId = v.every((e) => e && typeof e === "object" && "id" in (e as object));
    v.forEach((e, i) => {
      const k = byId ? `[${String((e as { id: unknown }).id).split("/").pop()}]` : `[${i}]`;
      flatten(e, prefix + k, out);
    });
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "id" || k === "__parentId" || k === "updatedAt") continue;
      flatten(val, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.set(prefix, v === null || v === undefined ? "" : String(v));
}
