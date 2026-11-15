import { PublicPage } from "../lib/public-page";

export const loader = () => null;

export default function Privacy() {
  return (
    <PublicPage title="Privacy policy">
      <p><em>Last updated: 15 November 2026</em></p>
      <p>
        DerOps Backup ("the app") is operated by Ahmed Darder, trading as DerOps (Suez, Egypt). This policy explains what
        the app accesses, where it goes, and what we keep.
      </p>

      <h2>What the app does</h2>
      <p>
        The app copies your store's content — products, collections, theme files and uploaded files — into a storage
        bucket <strong>that you own</strong> (Amazon S3, Cloudflare R2, Backblaze B2, Wasabi or any S3-compatible service),
        on a schedule and on demand, and lets you restore items from those copies.
      </p>

      <h2>Data we access</h2>
      <ul>
        <li>Store content via the Shopify Admin API: products, variants, collections, theme files, files/media, metafields on those objects.</li>
        <li>Basic store details: store name, primary domain, owner email, timezone and Shopify plan name — used to label backups and send notifications.</li>
      </ul>
      <p>
        <strong>We do not request access to customers or orders.</strong> No personal data about your customers is read, stored
        or transferred by the app.
      </p>

      <h2>Where your data goes</h2>
      <p>
        Backup contents are written only to the destination bucket you configure, using credentials you provide. We
        do not keep a copy of your products, themes or files on our servers; they pass through our worker in memory
        while a backup or restore runs and are not retained.
      </p>

      <h2>What we store on our servers</h2>
      <ul>
        <li>Your store domain, settings (schedule, retention, notification email) and plan.</li>
        <li>Your bucket's endpoint, bucket name and access keys. Access keys are encrypted at rest (AES-256-GCM) and used only to read and write your backups.</li>
        <li>A catalogue of each backup: item IDs, titles, content hashes, sizes and object paths — enough to show history and dedupe, not the content itself.</li>
        <li>Standard server logs (timestamps, request paths, errors) kept for 30 days.</li>
      </ul>
      <p>Our servers are hosted in the EU (Hetzner, Germany).</p>

      <h2>Emails</h2>
      <p>If enabled in Settings, we send a summary after scheduled backups and an alert when a backup fails, to the address you choose. No marketing email.</p>

      <h2>Uninstalling</h2>
      <p>
        When you uninstall, Shopify notifies us and we delete your settings, bucket credentials and backup catalogue
        within 48 hours. The backups in your own bucket are yours and are not touched — delete them yourself whenever you like.
      </p>

      <h2>Shopify compliance requests</h2>
      <p>
        We support Shopify's <code>customers/data_request</code>, <code>customers/redact</code> and <code>shop/redact</code> webhooks.
        Because we hold no customer data, the first two are acknowledged with nothing to return or erase; <code>shop/redact</code> removes the store's records described above.
      </p>

      <h2>Sub-processors</h2>
      <ul>
        <li>Hetzner Online GmbH — application hosting (Germany)</li>
        <li>Your chosen storage provider — holds your backups under your own account and terms</li>
        <li>Email delivery provider — only the notification address and summary counts</li>
      </ul>

      <h2>Contact</h2>
      <p>Questions or deletion requests: <a href="mailto:backup@derops.dev">backup@derops.dev</a>. We answer within two business days.</p>
    </PublicPage>
  );
}
