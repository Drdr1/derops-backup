/**
 * Loaded first by the worker. `shopify app dev` injects SHOPIFY_* into the web process only,
 * so the worker reads .env (written by `shopify app env pull`) and fills harmless defaults
 * for values the worker never actually uses for API calls.
 */
import "dotenv/config";

process.env.SHOPIFY_APP_URL ||= "https://localhost";

const required = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "DATABASE_URL", "ENCRYPTION_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `worker: missing env ${missing.join(", ")}. Run \`shopify app env pull\` and set ENCRYPTION_KEY (openssl rand -hex 32) in .env`,
  );
  process.exit(1);
}
