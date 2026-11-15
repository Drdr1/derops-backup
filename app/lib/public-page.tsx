import type { ReactNode } from "react";

/** Minimal unauthenticated page shell for /privacy, /support, /terms (App Store listing links). */
export function PublicPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.6,
        color: "#1a1a1a",
      }}
    >
      <p style={{ margin: 0, color: "#666" }}>
        <a href="https://derops.dev" style={{ color: "#666" }}>DerOps</a> · Backup for Shopify
      </p>
      <h1 style={{ fontSize: 28, margin: "8px 0 24px" }}>{title}</h1>
      {children}
      <hr style={{ margin: "40px 0 16px", border: 0, borderTop: "1px solid #ddd" }} />
      <p style={{ color: "#666", fontSize: 14 }}>
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a> · DerOps, Suez, Egypt
      </p>
    </main>
  );
}
