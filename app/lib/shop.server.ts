import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

/**
 * Make sure a Shop row exists for this session's store and refresh its name/plan.
 * Called from the app loader on every page view (cheap: one upsert).
 */
export async function ensureShop(shopDomain: string, admin: AdminApiContext) {
  const existing = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (existing && !existing.uninstalledAt) return existing;

  let name: string | undefined;
  let shopifyPlan: string | undefined;
  let timezone: string | undefined;
  let email: string | undefined;
  try {
    const res = await admin.graphql(
      `#graphql
      query shopInfo { shop { name email ianaTimezone plan { displayName } } }`,
    );
    const body = (await res.json()) as {
      data?: { shop: { name: string; email: string; ianaTimezone: string; plan: { displayName: string } } };
    };
    name = body.data?.shop.name;
    email = body.data?.shop.email;
    timezone = body.data?.shop.ianaTimezone;
    shopifyPlan = body.data?.shop.plan.displayName;
  } catch {
    // non-fatal; we can live without the display name
  }

  return prisma.shop.upsert({
    where: { domain: shopDomain },
    create: { domain: shopDomain, name, shopifyPlan, timezone: timezone ?? "UTC", notifyEmail: email },
    update: { name, shopifyPlan, uninstalledAt: null, timezone: timezone ?? undefined },
  });
}
