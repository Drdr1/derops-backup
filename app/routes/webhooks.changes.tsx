import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { TOPIC_RESOURCE, noteChange } from "../lib/incremental.server";

/** products/*, collections/*, themes/* → schedule a debounced incremental backup. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  const resource = TOPIC_RESOURCE[topic.toLowerCase().replace("_", "/")] ?? TOPIC_RESOURCE[topic];
  if (resource) {
    try {
      await noteChange(shop, resource);
    } catch (e) {
      console.error(`[webhook ${topic}] could not schedule incremental backup for ${shop}: ${e}`);
    }
  }
  return new Response();
};
