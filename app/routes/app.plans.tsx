import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Plan } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS, TRIAL_DAYS, applyPlan, cancelSubscriptions, createSubscription, isTestShop, pricingUrl, syncPlan } from "../lib/billing.server";

const ORDER: Plan[] = ["FREE", "BASIC", "GROW", "ADVANCED"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  let shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  shop = await syncPlan(shop, admin); // picks up a just-approved subscription on return from Shopify
  return {
    // Managed pricing: Shopify hosts plan selection; our buttons just open its page.
    managedUrl: process.env.SHOPIFY_MANAGED_PRICING === "1" ? pricingUrl(shop.domain) : null,
    current: shop.plan,
    test: isTestShop(shop),
    trialDays: TRIAL_DAYS,
    plans: ORDER.map((p) => ({ id: p, ...PLANS[p], manual: Number.isFinite(PLANS[p].manualBackupsPerMonth) ? PLANS[p].manualBackupsPerMonth : null })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();
  const plan = String(form.get("plan")) as Plan;
  if (!ORDER.includes(plan)) return { ok: false, error: "Unknown plan" };

  if (plan === "FREE") {
    await cancelSubscriptions(admin);
    await applyPlan(shop, "FREE");
    return { ok: true, message: "Switched to Free. Your backups are kept; only the limits changed." };
  }

  const store = shop.domain.replace(/\.myshopify\.com$/, "");
  const handle = process.env.SHOPIFY_APP_HANDLE || "derops-backup";
  const returnUrl = `https://admin.shopify.com/store/${store}/apps/${handle}/app/plans`;
  try {
    const confirmationUrl = await createSubscription(admin, shop, plan, returnUrl);
    return { ok: true, confirmationUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export default function PlansPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error ?? "Failed", { isError: true });
      return;
    }
    if ("confirmationUrl" in fetcher.data && fetcher.data.confirmationUrl) {
      // Shopify's approval page must load outside the admin iframe.
      window.open(fetcher.data.confirmationUrl, "_top");
    } else if ("message" in fetcher.data) {
      shopify.toast.show(fetcher.data.message ?? "Done");
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Plans">
      <s-section>
        <s-paragraph>
          Billed through Shopify on your regular invoice. Paid plans start with a {data.trialDays}-day free trial; change or
          cancel any time. Your backups stay in your bucket whatever happens to the plan.
          {data.test ? " (Development store: charges are test charges, nothing is billed.)" : ""}
        </s-paragraph>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {data.plans.map((p) => {
            const current = p.id === data.current;
            return (
              <s-box key={p.id} padding="base" borderWidth="base" borderRadius="base" background={current ? "subdued" : undefined}>
                <s-stack direction="block" gap="small-200">
                  <s-heading>{p.label}</s-heading>
                  <s-text>
                    <b>{p.priceUsd === 0 ? "Free" : `$${p.priceUsd}/month`}</b>
                  </s-text>
                  <s-text>{p.resources.length === 1 ? "Theme files only" : "Products, collections, themes, files"}</s-text>
                  <s-text>{p.schedule === "weekly" ? "Weekly" : "Daily"} automatic backups</s-text>
                  <s-text>{Math.max(...p.retentionOptions)}-day history</s-text>
                  <s-text>{p.manual === null ? "Unlimited" : p.manual} manual backups / month</s-text>
                  <s-text>
                    {p.maxDestinations} destination{p.maxDestinations > 1 ? "s" : ""}
                  </s-text>
                  {current ? (
                    <s-badge tone="success">Current plan</s-badge>
                  ) : (
                    <s-button
                      variant={p.id === "GROW" ? "primary" : "secondary"}
                      disabled={busy ? true : undefined}
                      onClick={() => {
                        if (data.managedUrl) {
                          window.open(data.managedUrl, "_top");
                          return;
                        }
                        if (p.id === "FREE" && !confirm("Downgrade to Free? Daily backups become weekly and only themes are backed up.")) return;
                        fetcher.submit({ plan: p.id }, { method: "post" });
                      }}
                    >
                      {ORDER.indexOf(p.id) > ORDER.indexOf(data.current) ? "Upgrade" : "Switch"}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
