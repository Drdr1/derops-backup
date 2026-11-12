import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ResourceType } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { backupQueue } from "../lib/queue.server";

const PAGE = 200;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const url = new URL(request.url);
  const resource = (url.searchParams.get("resource") || "PRODUCT") as ResourceType;
  const q = url.searchParams.get("q")?.trim() || "";
  const changedOnly = url.searchParams.get("changed") === "1";

  const snapshot = await prisma.snapshot.findFirst({
    where: { id: params.id, shopId: shop.id },
    include: { destination: { select: { label: true } } },
  });
  if (!snapshot) throw new Response("Not found", { status: 404 });

  const counts = await prisma.snapshotItem.groupBy({
    by: ["resource"],
    where: { snapshotId: snapshot.id, deleted: false },
    _count: { _all: true },
  });

  const items = await prisma.snapshotItem.findMany({
    where: {
      snapshotId: snapshot.id,
      resource,
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      ...(changedOnly ? { changed: true } : {}),
    },
    orderBy: [{ deleted: "asc" }, { title: "asc" }],
    take: PAGE,
  });

  // Themes present in this snapshot (for "Download theme as .zip")
  const themeFiles = await prisma.snapshotItem.findMany({
    where: { snapshotId: snapshot.id, resource: "THEME_FILE", deleted: false },
    select: { shopifyGid: true, title: true },
  });
  const themesMap = new Map<string, { gid: string; name: string; files: number }>();
  for (const f of themeFiles) {
    const gid = f.shopifyGid.split("#")[0];
    const name = (f.title ?? "").split(" / ")[0] || gid.split("/").pop()!;
    const t = themesMap.get(gid) ?? { gid, name, files: 0 };
    t.files++;
    themesMap.set(gid, t);
  }

  const recentRestores = await prisma.job.findMany({
    where: { shopId: shop.id, type: { in: ["RESTORE_ITEM", "RESTORE_THEME"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return {
    snapshot: {
      id: snapshot.id,
      startedAt: snapshot.startedAt.toISOString(),
      status: snapshot.status,
      kind: snapshot.kind,
      destination: snapshot.destination.label,
      manifestKey: snapshot.manifestKey,
      error: snapshot.error,
    },
    counts: Object.fromEntries(counts.map((c) => [c.resource, c._count._all])) as Record<string, number>,
    resource,
    q,
    changedOnly,
    items: items.map((i) => ({
      id: i.id,
      gid: i.shopifyGid,
      title: i.title ?? i.shopifyGid,
      changed: i.changed,
      deleted: i.deleted,
      sizeBytes: i.sizeBytes,
    })),
    truncated: items.length === PAGE,
    themes: [...themesMap.values()],
    recentRestores: recentRestores.map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt.toISOString(),
      error: j.error,
      result: j.result as { message?: string } | null,
    })),
    pendingRestores: recentRestores.filter((j) => j.status === "QUEUED" || j.status === "RUNNING").length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();

  if (form.get("intent") === "restoreTheme") {
    const snapshotId = String(form.get("snapshotId") || "");
    const themeGid = String(form.get("themeGid") || "");
    const snap = await prisma.snapshot.findFirst({ where: { id: snapshotId, shopId: shop.id }, select: { id: true } });
    if (!snap || !themeGid.startsWith("gid://shopify/OnlineStoreTheme/")) return { ok: false, error: "Theme not found" };
    const job = await prisma.job.create({
      data: { shopId: shop.id, type: "RESTORE_THEME", status: "QUEUED", payload: { snapshotId, themeGid } },
    });
    await backupQueue().add(
      "restore-theme",
      { type: "RESTORE_THEME", shopDomain: shop.domain, jobId: job.id, snapshotId, themeGid },
      { attempts: 1 },
    );
    return { ok: true };
  }

  const snapshotItemId = String(form.get("snapshotItemId") || "");

  const item = await prisma.snapshotItem.findFirst({
    where: { id: snapshotItemId, snapshot: { shopId: shop.id } },
  });
  if (!item) return { ok: false, error: "Item not found" };
  if (item.resource !== "PRODUCT" && item.resource !== "THEME_FILE") {
    return { ok: false, error: `Restore for ${item.resource} is export-only in this version` };
  }

  const job = await prisma.job.create({
    data: { shopId: shop.id, type: "RESTORE_ITEM", status: "QUEUED", payload: { snapshotItemId } },
  });
  await backupQueue().add(
    "restore",
    { type: "RESTORE_ITEM", shopDomain: shop.domain, jobId: job.id, snapshotItemId },
    { attempts: 1 },
  );
  return { ok: true };
};

const RESOURCE_LABELS: Record<string, string> = {
  PRODUCT: "Products",
  COLLECTION: "Collections",
  THEME_FILE: "Theme files",
  FILE: "Files",
};

export default function SnapshotPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show("Restore queued");
    else shopify.toast.show(fetcher.data.error ?? "Failed", { isError: true });
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (data.pendingRestores === 0) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [data.pendingRestores, revalidator]);

  const restoreTheme = (themeGid: string, name: string) => {
    if (!confirm(`Restore "${name}" from this snapshot as a new unpublished theme?`)) return;
    fetcher.submit({ intent: "restoreTheme", snapshotId: data.snapshot.id, themeGid }, { method: "post" });
  };

  // Downloads are plain GETs to an app route; attach a fresh session token so authenticate.admin accepts them.
  const download = async (query: string) => {
    const token = await shopify.idToken();
    const a = document.createElement("a");
    a.href = `/app/snapshots/${data.snapshot.id}/download?${query}&id_token=${encodeURIComponent(token)}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <s-page heading={`Snapshot · ${new Date(data.snapshot.startedAt).toLocaleString()}`}>
      <s-section>
        <s-stack direction="inline" gap="base">
          {Object.entries(RESOURCE_LABELS).map(([key, label]) => (
            <s-button key={key} variant={data.resource === key ? "primary" : "secondary"} href={`?resource=${key}`}>
              {label} ({data.counts[key] ?? 0})
            </s-button>
          ))}
        </s-stack>
        <form method="get">
          <input type="hidden" name="resource" value={data.resource} />
          <s-stack direction="inline" gap="base">
            <s-text-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              name="q"
              placeholder="Filter by title or filename"
              value={data.q}
            />
            <s-checkbox label="Changed in this snapshot only" name="changed" value="1" {...(data.changedOnly ? { checked: true } : {})} />
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </form>
      </s-section>

      {data.resource === "THEME_FILE" && data.themes.length > 0 && (
        <s-section heading="Restore a whole theme">
          <s-paragraph>
            Restore creates a <b>new unpublished theme</b> from this snapshot — your live theme is never modified. Preview it in
            Online Store → Themes and publish when you are happy. Or download the .zip and keep it anywhere.
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {data.themes.map((t) => (
              <s-stack key={t.gid} direction="inline" gap="base" alignItems="center">
                <s-text>
                  <b>{t.name}</b> · {t.files} files
                </s-text>
                <s-button
                  variant="primary"
                  disabled={data.pendingRestores > 0 ? true : undefined}
                  onClick={() => restoreTheme(t.gid, t.name)}
                >
                  Restore as new theme
                </s-button>
                <s-button variant="tertiary" onClick={() => download(`theme=${encodeURIComponent(t.gid)}`)}>
                  Download .zip
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading={`${RESOURCE_LABELS[data.resource] ?? data.resource} · ${data.items.length}${data.truncated ? "+" : ""}`}>
        {data.items.length === 0 ? (
          <s-paragraph>Nothing here.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Item</s-table-header>
              <s-table-header>State</s-table-header>
              <s-table-header>Size</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.items.map((i) => (
                <s-table-row key={i.id}>
                  <s-table-cell>
                    <s-text>{i.title}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {i.deleted ? (
                      <s-badge tone="critical">deleted</s-badge>
                    ) : i.changed ? (
                      <s-badge tone="info">changed</s-badge>
                    ) : (
                      <s-badge>unchanged</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>{i.sizeBytes ? `${(i.sizeBytes / 1024).toFixed(1)} KB` : ""}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                    {!i.deleted && (
                      <s-button variant="tertiary" onClick={() => download(`item=${i.id}`)}>
                        Download
                      </s-button>
                    )}
                    {(data.resource === "PRODUCT" || data.resource === "THEME_FILE") && !i.deleted && (
                      <fetcher.Form method="post">
                        <input type="hidden" name="snapshotItemId" value={i.id} />
                        <s-button
                          type="submit"
                          variant="tertiary"
                          onClick={(e: Event) => {
                            if (!confirm(`Restore "${i.title}" to the version from this snapshot? The current version will be overwritten.`)) {
                              e.preventDefault();
                            }
                          }}
                        >
                          Restore this version
                        </s-button>
                      </fetcher.Form>
                    )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {data.truncated && <s-paragraph>Showing the first {PAGE}. Use the search box to narrow down.</s-paragraph>}
      </s-section>

      <s-section slot="aside" heading="Snapshot">
        <s-paragraph>
          {data.snapshot.kind} · <s-badge tone={data.snapshot.status === "SUCCESS" ? "success" : "critical"}>{data.snapshot.status}</s-badge>
        </s-paragraph>
        <s-paragraph>Destination: {data.snapshot.destination}</s-paragraph>
        {data.snapshot.manifestKey && (
          <s-paragraph>
            <s-text tone="neutral">Manifest: {data.snapshot.manifestKey}</s-text>
          </s-paragraph>
        )}
        {data.snapshot.error && <s-text tone="critical">{data.snapshot.error}</s-text>}
      </s-section>

      {data.recentRestores.length > 0 && (
        <s-section slot="aside" heading="Recent restores">
          <s-stack direction="block" gap="small-200">
            {data.recentRestores.map((j) => (
              <s-box key={j.id}>
                <s-badge tone={j.status === "SUCCESS" ? "success" : j.status === "FAILED" ? "critical" : "info"}>{j.status}</s-badge>{" "}
                <s-text>{new Date(j.createdAt).toLocaleTimeString()}</s-text>
                <s-paragraph>
                  <s-text tone={j.status === "FAILED" ? "critical" : "neutral"}>{j.error ?? j.result?.message ?? ""}</s-text>
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
