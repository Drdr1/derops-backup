import { PublicPage } from "../lib/public-page";

export const loader = () => null;

export default function Terms() {
  return (
    <PublicPage title="Terms of service">
      <p><em>Last updated: 15 November 2026</em></p>
      <p>By installing DerOps Backup you agree to these terms. Short version: the app copies your store content to storage you control; we do our best to make every backup complete and every restore accurate, and we tell you plainly when something isn't covered.</p>

      <h2>Service</h2>
      <ul>
        <li>Backups cover the resources listed in the app for your plan. Anything not listed (for example customers and orders) is not backed up.</li>
        <li>Restores write to your store through the Shopify API. A restore of a single item overwrites that item's current version; a whole-theme restore creates a new unpublished theme and never changes your live theme.</li>
        <li>Images and media attached to products are backed up as files; re-attaching them to products on restore is not yet supported and is labelled as such in the app.</li>
      </ul>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Provide working storage credentials and keep the bucket available. Backups cannot run to a bucket we cannot reach; the app will tell you.</li>
        <li>Keep a copy of your storage credentials and bucket outside the app. Your backups belong to you and remain readable without us.</li>
      </ul>

      <h2>Billing</h2>
      <p>Paid plans are billed by Shopify on your regular Shopify invoice, monthly, with a 7-day free trial. You can change or cancel plans at any time from the app; cancelling moves you to the Free plan and does not delete anything from your bucket.</p>

      <h2>Limitations</h2>
      <p>The app is provided as is. We are not liable for indirect or consequential loss. Our total liability for any claim is limited to the fees you paid for the app in the three months before the claim. Nothing here limits liability that cannot be limited by law.</p>

      <h2>Changes and contact</h2>
      <p>We may update these terms; material changes are announced in the app. Contact: <a href="mailto:backup@derops.dev">backup@derops.dev</a>.</p>
    </PublicPage>
  );
}
