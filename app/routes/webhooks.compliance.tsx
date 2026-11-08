import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  // Phase 1 stores no customer data; acknowledge and log.
  console.log(`[compliance] ${topic} for ${shop}`);
  return new Response();
};
