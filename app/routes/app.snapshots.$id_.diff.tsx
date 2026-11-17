import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { diffItem } from "../backup/diff.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const itemId = new URL(request.url).searchParams.get("item") || "";
  const item = await prisma.snapshotItem.findFirst({ where: { id: itemId, snapshotId: params.id, snapshot: { shopId: shop.id } } });
  if (!item) throw new Response("Not found", { status: 404 });
  const result = await diffItem(item.id, shop.id);
  return { snapshotId: params.id!, resource: item.resource, ...result, previousAt: result.previousAt?.toISOString() ?? null };
};

const colors = { add: "#e6ffed", del: "#ffeef0", same: "transparent" } as const;
const marks = { add: "+", del: "−", same: " " } as const;

export default function DiffPage() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading={`What changed · ${d.title}`}>
      <s-section>
        <s-paragraph>
          <s-link href={`/app/snapshots/${d.snapshotId}?resource=${d.resource}`}>← Back to snapshot</s-link>
        </s-paragraph>
        {d.diff.mode === "new" && <s-paragraph>This is the first version of this item in your backups — nothing earlier to compare with.</s-paragraph>}
        {d.diff.mode === "deleted" && <s-paragraph>This item was gone from the store when this snapshot ran. Restore it from an earlier snapshot.</s-paragraph>}
        {d.diff.mode === "binary" && (
          <s-paragraph>
            Binary file changed: {(d.diff.beforeBytes / 1024).toFixed(1)} KB → {(d.diff.afterBytes / 1024).toFixed(1)} KB.
          </s-paragraph>
        )}
        {d.previousAt && <s-paragraph>Compared with the version from {new Date(d.previousAt).toLocaleString()}.</s-paragraph>}

        {d.diff.mode === "fields" && (
          d.diff.changes.length === 0 ? (
            <s-paragraph>No field differences (ordering or metadata only).</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Field</s-table-header>
                <s-table-header>Before</s-table-header>
                <s-table-header>After</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.diff.changes.map((c) => (
                  <s-table-row key={c.path}>
                    <s-table-cell><code>{c.path}</code></s-table-cell>
                    <s-table-cell><span style={{ background: colors.del }}>{c.before ?? <em>(none)</em>}</span></s-table-cell>
                    <s-table-cell><span style={{ background: colors.add }}>{c.after ?? <em>(removed)</em>}</span></s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )
        )}

        {d.diff.mode === "text" && (
          <>
            <s-paragraph>
              <s-badge tone="success">+{d.diff.added}</s-badge> <s-badge tone="critical">−{d.diff.removed}</s-badge>
              {d.diff.truncated ? " (diff truncated)" : ""}
            </s-paragraph>
            <pre style={{ fontSize: 12, lineHeight: 1.5, overflowX: "auto", border: "1px solid #e3e3e3", borderRadius: 8, padding: 8, margin: 0 }}>
              {d.diff.lines.map((l, i) => (
                <div key={i} style={{ background: colors[l.kind], whiteSpace: "pre" }}>
                  <span style={{ color: "#999", userSelect: "none" }}>{marks[l.kind]} </span>
                  {l.text}
                </div>
              ))}
            </pre>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
