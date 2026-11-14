import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Plan, ResourceType, Shop } from "@prisma/client";
import prisma from "../db.server";
import { syncShopSchedule, cronForHour, hourFromCron } from "./schedule.server";

/**
 * Billing = Shopify managed pricing. Plans are defined in the Dev Dashboard (Distribution → Pricing);
 * Shopify hosts the plan picker and charges the merchant. We only read the active subscription and
 * map its name to our Plan enum. Plan names in the dashboard must contain "Basic", "Grow" or
 * "Advanced" (case-insensitive); anything else, or no subscription, is FREE.
 */

const ALL_RESOURCES: ResourceType[] = ["PRODUCT", "COLLECTION", "THEME_FILE", "FILE"];

export type PlanFeatures = {
  label: string;
  priceUsd: number;
  resources: ResourceType[];
  schedule: "weekly" | "daily";
  retentionOptions: number[];
  maxDestinations: number;
  manualBackupsPerMonth: number; // Infinity = unlimited
  blurb: string;
};

export const PLANS: Record<Plan, PlanFeatures> = {
  FREE: {
    label: "Free",
    priceUsd: 0,
    resources: ["THEME_FILE"],
    schedule: "weekly",
    retentionOptions: [7],
    maxDestinations: 1,
    manualBackupsPerMonth: 3,
    blurb: "Weekly theme backup, 7-day history, 3 manual backups a month.",
  },
  BASIC: {
    label: "Basic",
    priceUsd: 9,
    resources: ALL_RESOURCES,
    schedule: "daily",
    retentionOptions: [7, 30],
    maxDestinations: 1,
    manualBackupsPerMonth: 30,
    blurb: "Products, collections, themes and files. Daily backups, 30-day history.",
  },
  GROW: {
    label: "Grow",
    priceUsd: 19,
    resources: ALL_RESOURCES,
    schedule: "daily",
    retentionOptions: [7, 30, 90, 365],
    maxDestinations: 1,
    manualBackupsPerMonth: Infinity,
    blurb: "Everything in Basic, 1-year history, unlimited manual backups.",
  },
  ADVANCED: {
    label: "Advanced",
    priceUsd: 39,
    resources: ALL_RESOURCES,
    schedule: "daily",
    retentionOptions: [7, 30, 90, 365],
    maxDestinations: 5,
    manualBackupsPerMonth: Infinity,
    blurb: "Everything in Grow, up to 5 destinations, priority support.",
  },
};

export function planFromSubscriptionName(name: string | null | undefined): Plan {
  const n = (name ?? "").toLowerCase();
  if (n.includes("advanced")) return "ADVANCED";
  if (n.includes("grow")) return "GROW";
  if (n.includes("basic")) return "BASIC";
  return "FREE";
}

/** Shopify-hosted plan picker for managed pricing. Opens outside the iframe (target="_top"). */
export function pricingUrl(shopDomain: string) {
  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  const handle = process.env.SHOPIFY_APP_HANDLE || "derops-backup";
  return `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`;
}

/**
 * Read the active subscription from Shopify and apply the resulting plan to the shop:
 * clamps retention, switches the schedule between weekly/daily and re-syncs the scheduler.
 * Cheap (one GraphQL query); called from the app layout loader and the subscription webhook.
 */
export async function syncPlan(shop: Shop, admin: AdminApiContext): Promise<Shop> {
  let plan: Plan = "FREE";
  try {
    const res = await admin.graphql(
      `#graphql
      query activeSubs { currentAppInstallation { activeSubscriptions { name status test } } }`,
    );
    const body = (await res.json()) as {
      data?: { currentAppInstallation: { activeSubscriptions: { name: string; status: string; test: boolean }[] } };
    };
    const active = body.data?.currentAppInstallation.activeSubscriptions.find((s) => s.status === "ACTIVE");
    plan = planFromSubscriptionName(active?.name);
  } catch {
    return shop; // keep what we have rather than downgrading on a transient API error
  }
  if (plan === shop.plan) return shop;
  return applyPlan(shop, plan);
}

export async function applyPlan(shop: Shop, plan: Plan): Promise<Shop> {
  const f = PLANS[plan];
  const retentionDays = f.retentionOptions.includes(shop.retentionDays)
    ? shop.retentionDays
    : Math.max(...f.retentionOptions.filter((d) => d <= shop.retentionDays), f.retentionOptions[0]);
  const scheduleCron = cronForHour(hourFromCron(shop.scheduleCron), 0, f.schedule);
  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: { plan, retentionDays, scheduleCron },
  });
  await syncShopSchedule(shop.id).catch(() => {});
  return updated;
}

export function allowedResources(plan: Plan, requested?: ResourceType[]): ResourceType[] {
  const allowed = PLANS[plan].resources;
  return requested ? requested.filter((r) => allowed.includes(r)) : allowed;
}

/** Manual backups used this calendar month (UTC). */
export async function manualBackupsThisMonth(shopId: string) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return prisma.snapshot.count({ where: { shopId, kind: "MANUAL", startedAt: { gte: start } } });
}
