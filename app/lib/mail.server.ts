import nodemailer from "nodemailer";

/**
 * Daily summary email. Configure SMTP_URL (smtp://user:pass@host:587) and MAIL_FROM.
 * If SMTP_URL is unset, emails are logged instead of sent (dev mode).
 */
export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM || "DerOps Backup <backup@derops.dev>";
  if (!url) {
    console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    return { sent: false };
  }
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({ from, to, subject, text, html });
  return { sent: true };
}

export function summaryEmail(p: {
  shopName: string;
  status: string;
  startedAt: Date;
  items: number;
  changed: number;
  bytes: number;
  failures: string[];
  perResource: Record<string, { count: number; error?: string }>;
  snapshotUrl?: string;
}) {
  const ok = p.status === "SUCCESS";
  const subject = ok
    ? `✓ ${p.shopName}: backup complete, ${p.changed} change${p.changed === 1 ? "" : "s"}`
    : `⚠ ${p.shopName}: backup ${p.status.toLowerCase()}`;

  const lines = [
    `${p.shopName} — ${p.startedAt.toUTCString()}`,
    `Status: ${p.status}`,
    `Items: ${p.items} · Changed since last backup: ${p.changed} · Written: ${formatBytes(p.bytes)}`,
    "",
    ...Object.entries(p.perResource).map(([r, v]) => `  ${r.padEnd(12)} ${v.error ? `FAILED: ${v.error}` : `${v.count} items`}`),
  ];
  if (p.failures.length) lines.push("", "Problems:", ...p.failures.map((f) => `  - ${f}`));
  if (p.snapshotUrl) lines.push("", `Open snapshot: ${p.snapshotUrl}`);
  lines.push("", "You receive this because daily summaries are on in DerOps Backup → Settings.");

  return { subject, text: lines.join("\n") };
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
