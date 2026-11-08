import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { backupQueue } from "../lib/queue.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin);

  const [destinations, snapshots, runningJobs] = await Promise.all([
    prisma.destination.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "asc" } }),
    prisma.snapshot.findMany({
      where: { shopId: shop.id },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: { destination: { select: { label: true } } },
    }),
    prisma.job.count({ where: { shopId: shop.id, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);

  return {
    shop: { name: shop.name, domain: shop.domain, plan: shop.plan, shopifyPlan: shop.shopifyPlan },
    destinations: destinations.map((d) => ({ id: d.id, label: d.label, kind: d.kind, verifiedAt: d.verifiedAt, lastError: d.lastError })),
    snapshots: snapshots.map((s) => ({
      id: s.id,
      kind: s.kind,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      itemCount: s.itemCount,
      changedCount: s.changedCount,
      bytesWritten: Number(s.bytesWritten),
      destination: s.destination.label,
      error: s.error,
    })),
    runningJobs,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();
  const destinationId = String(form.get("destinationId") || "");

  const destination = await prisma.destination.findFirst({ where: { id: destinationId, shopId: shop.id } });
  if (!destination) return { ok: false, error: "Pick a destination first." };

  const job = await prisma.job.create({
    data: { shopId: shop.id, type: "BACKUP_FULL", status: "QUEUED", payload: { destinationId } },
  });
  await backupQueue().add("backup", {
    type: "BACKUP_FULL",
    shopDomain: shop.domain,
    jobId: job.id,
    destinationId,
    kind: "MANUAL",
  });
  return { ok: true, jobId: job.id };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";

  // Poll while a job is queued/running so the snapshot list updates itself.
  useEffect(() => {
    if (data.runningJobs === 0) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [data.runningJobs, revalidator]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Backup queued");
    else if (fetcher.data && !fetcher.data.ok) shopify.toast.show(fetcher.data.error ?? "Failed", { isError: true });
  }, [fetcher.data, shopify]);

  const defaultDest = data.destinations.find((d) => d.verifiedAt) ?? data.destinations[0];

  return (
    <s-page heading="Backups">
      {data.destinations.length === 0 ? (
        <s-section heading="Where should backups go?">
          <s-paragraph>
            Connect your own S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, Wasabi) and every backup is written
            there as plain JSON you can read without this app.
          </s-paragraph>
          <s-button variant="primary" href="/app/destinations">
            Add a destination
          </s-button>
        </s-section>
      ) : (
        <s-section heading="Back up now">
          <fetcher.Form method="post">
            <input type="hidden" name="destinationId" value={defaultDest.id} />
            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary" {...(busy || data.runningJobs > 0 ? { loading: true } : {})}>
                Back up now
              </s-button>
              <s-text>
                to <b>{defaultDest.label}</b>
                {defaultDest.verifiedAt ? "" : " (not verified yet)"}
              </s-text>
            </s-stack>
          </fetcher.Form>
          {data.runningJobs > 0 && <s-paragraph>{data.runningJobs} job(s) in progress…</s-paragraph>}
        </s-section>
      )}

      <s-section heading="Recent snapshots">
        {data.snapshots.length === 0 ? (
          <s-paragraph>No snapshots yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Started</s-table-header>
              <s-table-header>Kind</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header>Changed</s-table-header>
              <s-table-header>Size</s-table-header>
              <s-table-header>Destination</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.snapshots.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell><s-link href={`/app/snapshots/${s.id}`}>{new Date(s.startedAt).toLocaleString()}</s-link></s-table-cell>
                  <s-table-cell>{s.kind}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={s.status === "SUCCESS" ? "success" : s.status === "RUNNING" ? "info" : "critical"}>
                      {s.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{s.itemCount}</s-table-cell>
                  <s-table-cell>{s.changedCount}</s-table-cell>
                  <s-table-cell>{formatBytes(s.bytesWritten)}</s-table-cell>
                  <s-table-cell>{s.destination}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {data.snapshots.find((s) => s.error) && (
          <s-paragraph>
            <s-text tone="critical">{data.snapshots.find((s) => s.error)!.error}</s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Store">
        <s-paragraph>{data.shop.name ?? data.shop.domain}</s-paragraph>
        <s-paragraph>
          Shopify plan: {data.shop.shopifyPlan ?? "unknown"} · App plan: {data.shop.plan}
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

