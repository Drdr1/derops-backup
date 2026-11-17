# App Store listing — copy and assets

Paste-ready text for Partner Dashboard → derops-backup → Distribution → Create listing.
Shopify's rules: no superlatives you can't prove, no "best/#1", no mention of other apps by name,
no pricing in the description body, screenshots must be real app UI.

## Basics
- **App name:** DerOps Backup
- **Tagline (≤ 62 chars):** Backups to your own S3 bucket. Restore products and themes.
- **Primary category:** Store management → Backup / data export (pick "Backups" if offered)
- **Languages:** English
- **App icon:** 1200×1200 PNG, flat, no text. Concept: a rounded square in DerOps teal with a white
  "return/undo" arrow wrapping a small bucket outline. Keep ≥ 10 % padding. (Make in Figma/Canva; export PNG.)
- **Support email:** backup@derops.dev · **Privacy:** https://backup.derops.dev/privacy ·
  **Terms:** https://backup.derops.dev/terms · **Support URL:** https://backup.derops.dev/support

## Description (≤ 2,800 chars)

Your store's content is one bad import, one theme edit or one deleted product away from gone.
Shopify keeps your data safe from hardware failure, not from mistakes — there is no undo for a
product overwritten by a CSV upload or a theme file saved with a typo.

DerOps Backup copies your products, collections, theme files and uploaded files to a storage bucket
that you own — Cloudflare R2, Amazon S3, Backblaze B2, Wasabi or any S3-compatible service — every
day, within minutes of a change on paid plans, and whenever you press "Back up now".

**Restore what broke, not everything.** Open any snapshot, find the product or theme file, see
exactly what changed line by line, and restore that one item back into the store.

**Your bucket, your data.** Backups live in storage you own and control, in an open JSON Lines
format. If you ever uninstall, your backup history stays where it is.
Credentials for your bucket are encrypted; we never see your customers or orders.

**Only pays for what changed.** Unchanged files are never uploaded twice, so a 1,500-file theme
costs kilobytes a day, not megabytes.

**Know it ran.** A short email after each scheduled backup, an alert if one fails, and a dashboard
that shows item counts, changes and size for every run.

What is backed up: products (variants, options, metafields), collections, every theme file of every
theme, and uploaded files/media. Restore: individual products and individual theme files, back into the store.
Customers and orders are not accessed.

Setup takes five minutes: create a bucket, paste an access key, press Back up now.

## Feature bullets (listing "key benefits", ≤ 80 chars each)
1. Daily and near-real-time backups to an S3 bucket you own
2. Restore a single product or theme file in one click
3. Line-by-line "what changed" view for every backed-up item
4. Open format: JSON Lines plus original files, readable without the app
5. Email summary after every run and an alert when a backup fails

## Pricing (enter in the listing's pricing section; mirrors the app)
| Plan | Price | Trial | Features line |
|---|---|---|---|
| Free | $0 | — | Weekly theme backup · 7-day history · 3 manual backups/month · 1 bucket |
| Basic | $9/mo | 7 days | Products, collections, themes, files · daily + change-triggered backups · 30-day history · 1 bucket |
| Grow | $19/mo | 7 days | Everything in Basic · 1-year history · unlimited manual backups |
| Advanced | $39/mo | 7 days | Everything in Grow · up to 5 buckets · priority support |

## Screenshots (1600×900 PNG, real UI, no browser chrome; 3–6 of them)
1. Home — snapshot list with SUCCESS rows, items/changed/size columns, "Back up now".
2. Snapshot → Theme files tab with "What changed" / "Restore this version" buttons (no download controls).
3. "What changed" diff of a liquid file (green/red lines).
4. Destinations — verified R2 bucket card + "Why your own bucket?" aside.
5. Settings — schedule, retention, notification email.
6. Plans page.
Caption each in ≤ 60 chars, e.g. "Every run, at a glance", "Restore one file, not the whole theme".

## Demo / review notes (the "Testing instructions" box)
Test store: derops-backup-dev.myshopify.com (add reviewer as staff if requested).
Steps: Install → Destinations → add bucket (test credentials provided below) → Test connection →
Home → Back up now (≈1 min) → open snapshot → Theme files → pick a file → What changed / Restore.
Theme files are never downloadable and whole themes are never created or installed by the app
(requirement 1.1.3); a theme file can only be restored in place into the theme it was backed up from.
Provide: a throwaway R2 bucket + read/write token for the reviewer (create a separate token; revoke after review).

## Required for submission checklist
- [ ] Partner account App Store registration ($19, one-time)
- [ ] App icon 1200×1200
- [ ] 3–6 screenshots 1600×900
- [ ] Listing text above
- [ ] Privacy / terms / support URLs live (they are)
- [ ] GDPR webhooks respond 200 (they do: /webhooks/compliance)
- [ ] Billing via Billing API with test charges verified (done Nov 15)
- [ ] Emergency developer contact email + phone in Partner settings
- [ ] Reviewer bucket credentials in testing instructions
