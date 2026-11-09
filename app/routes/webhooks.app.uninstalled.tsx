import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncShopSchedule } from "../lib/schedule.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  // Keep snapshots/destinations rows (merchant may reinstall); just mark the shop closed.
  await db.shop.updateMany({ where: { domain: shop }, data: { uninstalledAt: new Date() } });
  const row = await db.shop.findUnique({ where: { domain: shop }, select: { id: true } });
  if (row) await syncShopSchedule(row.id).catch(() => {});

  return new Response();
};
