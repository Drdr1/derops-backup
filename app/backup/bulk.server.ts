import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type Admin = AdminApiContext;

/**
 * Run a Shopify Bulk Operation query and return the JSONL download URL.
 * Shopify allows ONE running bulk query per shop; callers run resources sequentially.
 */
export async function runBulkQuery(admin: Admin, query: string, opts: { pollMs?: number; timeoutMs?: number } = {}) {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;

  const start = await gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    admin,
    `#graphql
    mutation runBulk($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query },
  );

  const errs = start.bulkOperationRunQuery.userErrors;
  if (errs.length) {
    // Most common: another bulk op already running. Wait for it, then retry once.
    if (errs.some((e) => /already in progress/i.test(e.message))) {
      await waitForCurrent(admin, pollMs, timeoutMs);
      return runBulkQuery(admin, query, opts);
    }
    throw new Error(`bulkOperationRunQuery: ${errs.map((e) => e.message).join("; ")}`);
  }

  const id = start.bulkOperationRunQuery.bulkOperation!.id;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const res = await gql<{
      node: {
        id: string;
        status: string;
        errorCode: string | null;
        objectCount: string;
        url: string | null;
        partialDataUrl: string | null;
      } | null;
    }>(
      admin,
      `#graphql
      query bulkStatus($id: ID!) {
        node(id: $id) {
          ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
        }
      }`,
      { id },
    );
    const op = res.node;
    if (!op) throw new Error(`Bulk operation ${id} disappeared`);
    if (op.status === "COMPLETED") {
      return { url: op.url, objectCount: Number(op.objectCount) };
    }
    if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
      throw new Error(`Bulk operation ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`);
    }
  }
  throw new Error(`Bulk operation ${id} timed out after ${timeoutMs / 1000}s`);
}

async function waitForCurrent(admin: Admin, pollMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await gql<{ currentBulkOperation: { status: string } | null }>(
      admin,
      `#graphql
      query { currentBulkOperation(type: QUERY) { status } }`,
    );
    const s = res.currentBulkOperation?.status;
    if (!s || ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(s)) return;
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for a previous bulk operation to finish");
}

/**
 * Shopify bulk JSONL flattens nested connections into separate lines carrying __parentId.
 * Parents always precede their children. This folds children back under their parent
 * using the `__typename` to pick the array name (Variant -> variants, etc.).
 */
export function reassembleBulkJsonl(
  jsonl: string,
  childKeyByTypename: Record<string, string>,
): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown> & { id?: string; __parentId?: string; __typename?: string };
    const parentId = obj.__parentId;
    delete obj.__parentId;
    if (obj.id) byId.set(obj.id, obj);

    if (!parentId) {
      roots.push(obj);
      continue;
    }
    const parent = byId.get(parentId);
    if (!parent) continue; // orphan; should not happen
    const key = childKeyByTypename[obj.__typename ?? ""] ?? "children";
    const arr = (parent[key] as unknown[] | undefined) ?? [];
    arr.push(obj);
    parent[key] = arr;
  }
  return roots;
}

export async function gql<T>(admin: Admin, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("GraphQL response had no data");
  return body.data;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
