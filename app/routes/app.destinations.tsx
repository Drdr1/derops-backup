import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/crypto.server";
import { verifyDestination } from "../lib/storage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const destinations = await prisma.destination.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "asc" } });
  return {
    destinations: destinations.map((d) => ({
      id: d.id,
      label: d.label,
      kind: d.kind,
      endpoint: d.endpoint,
      bucket: d.bucket,
      prefix: d.prefix,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      lastError: d.lastError,
    })),
  };
};

const PRESETS: Record<string, { endpoint: string; region: string; hint: string }> = {
  r2: { endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto", hint: "Cloudflare R2 → Manage API tokens → Object Read & Write" },
  aws: { endpoint: "https://s3.<REGION>.amazonaws.com", region: "us-east-1", hint: "IAM user with s3:PutObject, GetObject, DeleteObject, ListBucket on this bucket" },
  b2: { endpoint: "https://s3.<REGION>.backblazeb2.com", region: "us-west-004", hint: "Backblaze B2 → Application Keys, restricted to this bucket" },
  wasabi: { endpoint: "https://s3.<REGION>.wasabisys.com", region: "us-east-1", hint: "Wasabi access key pair" },
  other: { endpoint: "https://", region: "auto", hint: "Any S3-compatible endpoint (MinIO, DigitalOcean Spaces, Hetzner Object Storage…)" },
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();
  const intent = String(form.get("intent") || "create");

  if (intent === "delete") {
    const id = String(form.get("id"));
    await prisma.destination.deleteMany({ where: { id, shopId: shop.id } });
    return { ok: true, message: "Destination removed" };
  }

  if (intent === "verify") {
    const id = String(form.get("id"));
    const dest = await prisma.destination.findFirst({ where: { id, shopId: shop.id } });
    if (!dest) return { ok: false, error: "Not found" };
    try {
      await verifyDestination(dest);
      await prisma.destination.update({ where: { id }, data: { verifiedAt: new Date(), lastError: null } });
      return { ok: true, message: "Bucket verified: write, read and delete all work" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.destination.update({ where: { id }, data: { lastError: msg } });
      return { ok: false, error: msg };
    }
  }

  // create
  const label = String(form.get("label") || "").trim();
  const endpoint = String(form.get("endpoint") || "").trim().replace(/\/+$/, "");
  const region = String(form.get("region") || "auto").trim();
  const bucket = String(form.get("bucket") || "").trim();
  const prefix = String(form.get("prefix") || "").trim().replace(/^\/+|\/+$/g, "");
  const accessKey = String(form.get("accessKey") || "").trim();
  const secretKey = String(form.get("secretKey") || "").trim();

  if (!label || !endpoint || !bucket || !accessKey || !secretKey) {
    return { ok: false, error: "Label, endpoint, bucket, access key and secret key are required." };
  }
  if (!/^https:\/\/[^<>\s]+$/.test(endpoint)) {
    return { ok: false, error: "Endpoint must be an https:// URL with the placeholders replaced." };
  }

  const dest = await prisma.destination.create({
    data: {
      shopId: shop.id,
      kind: "S3",
      label,
      endpoint,
      region,
      bucket,
      prefix: prefix || null,
      accessKeyEnc: encrypt(accessKey),
      secretKeyEnc: encrypt(secretKey),
      isDefault: true,
    },
  });

  try {
    await verifyDestination(dest);
    await prisma.destination.update({ where: { id: dest.id }, data: { verifiedAt: new Date() } });
    return { ok: true, message: "Destination saved and verified" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.destination.update({ where: { id: dest.id }, data: { lastError: msg } });
    return { ok: false, error: `Saved, but verification failed: ${msg}` };
  }
};

export default function Destinations() {
  const { destinations } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message ?? "Done");
    else shopify.toast.show(fetcher.data.error ?? "Failed", { isError: true, duration: 8000 });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Destinations">
      <s-section heading="Your buckets">
        {destinations.length === 0 ? (
          <s-paragraph>No destination yet. Add one below.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {destinations.map((d) => (
              <s-box key={d.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-heading>{d.label}</s-heading>
                  <s-text>
                    {d.endpoint} / {d.bucket}
                    {d.prefix ? ` / ${d.prefix}` : ""}
                  </s-text>
                  {d.verifiedAt ? (
                    <s-badge tone="success">Verified {new Date(d.verifiedAt).toLocaleString()}</s-badge>
                  ) : (
                    <s-badge tone="warning">Not verified</s-badge>
                  )}
                  {d.lastError && <s-text tone="critical">{d.lastError}</s-text>}
                  <s-stack direction="inline" gap="base">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="verify" />
                      <input type="hidden" name="id" value={d.id} />
                      <s-button type="submit" {...(busy ? { loading: true } : {})}>
                        Test connection
                      </s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={d.id} />
                      <s-button type="submit" tone="critical" variant="tertiary">
                        Remove
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Add an S3-compatible bucket">
        <s-paragraph>
          Backups are written to your bucket as JSON Lines files you can open without this app. Keys are encrypted at rest;
          a token limited to one bucket with read + write is enough.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-text-field label="Label" name="label" placeholder="My R2 bucket" required />
            <s-text-field
              label="S3 endpoint"
              name="endpoint"
              placeholder={PRESETS.r2.endpoint}
              details="R2: https://<account-id>.r2.cloudflarestorage.com · AWS: https://s3.<region>.amazonaws.com · B2: https://s3.<region>.backblazeb2.com"
              required
            />
            <s-text-field label="Region" name="region" value="auto" details="R2 uses 'auto'. AWS/B2/Wasabi need the real region." />
            <s-text-field label="Bucket name" name="bucket" required />
            <s-text-field label="Key prefix (optional)" name="prefix" placeholder="shopify-backups" />
            <s-text-field label="Access key ID" name="accessKey" required />
            <s-password-field label="Secret access key" name="secretKey" required />
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              Save and test
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Why your own bucket?">
        <s-paragraph>
          If this app disappears tomorrow, your backups are still in your account, readable as plain files. Nothing is
          held hostage.
        </s-paragraph>
        <s-paragraph>Cloudflare R2 gives 10 GB free, enough for most stores for years.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
