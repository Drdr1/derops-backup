import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyPlan, planFromSubscriptionName } from "../lib/billing.server";

/**
 * app_subscriptions/update — fired by Shopify managed pricing when a merchant picks, changes or
 * cancels a plan. Payload: { app_subscription: { name, status, ... } }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop: shopDomain } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shopDomain}`);

  const sub = (payload as { app_subscription?: { name?: string; status?: string } }).app_subscription;
  const plan = sub?.status === "ACTIVE" ? planFromSubscriptionName(sub.name) : "FREE";

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop && shop.plan !== plan) await applyPlan(shop, plan);
  return new Response();
};
