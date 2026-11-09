import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { cronForHour, describeCron, syncShopSchedule } from "../lib/schedule.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: session.shop },
    include: { destinations: { where: { verifiedAt: { not: null } }, select: { id: true } } },
  });
  const hourMatch = shop.scheduleCron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  return {
    hour: hourMatch ? Number(hourMatch[2]) : 3,
    timezone: shop.timezone,
    retentionDays: shop.retentionDays,
    notifyEmail: shop.notifyEmail ?? "",
    emailDaily: shop.emailDaily,
    scheduleText: describeCron(shop.scheduleCron),
    hasDestination: shop.destinations.length > 0,
    plan: shop.plan,
  };
};

const RETENTION_BY_PLAN: Record<string, number[]> = {
  FREE: [7, 30], // until billing lands; default retention is 30
  BASIC: [7, 30],
  GROW: [7, 30, 90, 365],
  ADVANCED: [7, 30, 90, 365],
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();

  const hour = Math.min(23, Math.max(0, Number(form.get("hour") ?? 3)));
  const timezone = String(form.get("timezone") || shop.timezone || "UTC").trim();
  const retentionDays = Number(form.get("retentionDays") ?? shop.retentionDays);
  const notifyEmail = String(form.get("notifyEmail") || "").trim() || null;
  const emailDaily = form.get("emailDaily") === "1";

  try {
    // Validate the timezone the way BullMQ/cron will interpret it
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { ok: false, error: `Unknown timezone "${timezone}". Use an IANA name like Africa/Cairo or America/New_York.` };
  }
  const allowed = RETENTION_BY_PLAN[shop.plan] ?? [7];
  if (!allowed.includes(retentionDays)) {
    return { ok: false, error: `Retention of ${retentionDays} days is not available on the ${shop.plan} plan.` };
  }
  if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
    return { ok: false, error: "That email address doesn't look valid." };
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { scheduleCron: cronForHour(hour), timezone, retentionDays, notifyEmail, emailDaily },
  });
  const sync = await syncShopSchedule(shop.id);
  return {
    ok: true,
    message: sync.scheduled
      ? `Saved. Backups run ${describeCron(cronForHour(hour))} (${timezone}).`
      : "Saved. Add and verify a destination to start scheduled backups.",
  };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message ?? "Saved");
    else shopify.toast.show(fetcher.data.error ?? "Failed", { isError: true, duration: 8000 });
  }, [fetcher.data, shopify]);

  const retentionOptions = RETENTION_BY_PLAN[data.plan] ?? [7];

  return (
    <s-page heading="Settings">
      <s-section heading="Schedule">
        <s-paragraph>
          {data.hasDestination
            ? `Automatic backups run ${data.scheduleText} (${data.timezone}).`
            : "Scheduled backups start once a destination is added and verified."}
        </s-paragraph>
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-select label="Daily backup time" name="hour" value={String(data.hour)}>
              {Array.from({ length: 24 }, (_, h) => (
                <s-option key={h} value={String(h)}>
                  {`${String(h).padStart(2, "0")}:00`}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              label="Timezone"
              name="timezone"
              value={data.timezone}
              details="IANA name, e.g. Europe/London. Pre-filled from your store settings."
            />
            <s-select label="Keep snapshots for" name="retentionDays" value={String(data.retentionDays)}>
              {retentionOptions.map((d) => (
                <s-option key={d} value={String(d)}>
                  {d === 365 ? "1 year" : `${d} days`}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              label="Notification email"
              name="notifyEmail"
              value={data.notifyEmail}
              details="Daily summary and failure alerts. Pre-filled with the store owner email."
            />
            <s-checkbox label="Send a daily summary after each scheduled backup" name="emailDaily" value="1" {...(data.emailDaily ? { checked: true } : {})} />
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              Save
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="How retention works">
        <s-paragraph>
          Snapshots older than the retention window are deleted, including their files in your bucket. The most recent
          successful snapshot is always kept. Files shared with newer snapshots (unchanged theme files, images) are never
          removed while still referenced.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
