import { PublicPage } from "../lib/public-page";

export const loader = () => null;

export default function Support() {
  return (
    <PublicPage title="Support">
      <p>
        Email <a href="mailto:backup@derops.dev">backup@derops.dev</a>. Replies within one business day, usually faster.
        Include your store domain (<code>your-store.myshopify.com</code>) and, for backup problems, the time of the failed run.
      </p>

      <h2>Common questions</h2>
      <h3>Which bucket should I use?</h3>
      <p>Cloudflare R2 is the easiest: 10 GB free, no egress fees, S3-compatible. Create a bucket, then an R2 API token with Object Read &amp; Write scoped to that bucket, and paste the endpoint (<code>https://&lt;account-id&gt;.r2.cloudflarestorage.com</code>), bucket name and keys into Destinations.</p>

      <h3>"Test connection" fails</h3>
      <p>Check the endpoint has no bucket name or path on the end, the region is <code>auto</code> for R2 (the real region for AWS/B2/Wasabi), and the token has write permission on that bucket.</p>

      <h3>What does a restore change?</h3>
      <p>Restoring a product or a single theme file overwrites that one item with the backed-up version. Restoring a whole theme creates a new unpublished theme in Online Store → Themes; your live theme is untouched until you publish it.</p>

      <h3>Can I read the backups without the app?</h3>
      <p>Yes. Each snapshot is a folder in your bucket with a <code>manifest.json</code>, one <code>.jsonl</code> file per resource (one JSON object per line) and theme/file originals under <code>themes/</code> and <code>files/</code>.</p>

      <h3>How do I cancel?</h3>
      <p>Plans → Switch to Free, or uninstall the app. Your bucket and everything in it stays yours.</p>
    </PublicPage>
  );
}
