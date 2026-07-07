/**
 * RecruitersOS · Sending · List-Unsubscribe (RFC 2369 + RFC 8058 one-click)
 *
 * Cold email at volume needs a working unsubscribe header: Gmail/Yahoo bulk-sender rules
 * require one-click unsubscribe, and honoring it protects the domains. Every pooled cold
 * send carries:
 *
 *   List-Unsubscribe: <https://…/api/unsubscribe?w=…&e=…&s=…>, <mailto:inbox@domain?subject=unsubscribe>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The URL is HMAC-signed so only links we minted can suppress an address (an unsigned
 * guess must not become a "suppress anyone" oracle). The endpoint (app/api/unsubscribe)
 * adds the address to the durable DNC list and flips the prospect to do_not_contact —
 * the same treatment as a STOP reply.
 */

import { createHmac } from "crypto";

function secret(): string {
  // Dedicated secret preferred; falls back to the cron/API secrets so the header works
  // out of the box. The final literal keeps dev functional but should never reach prod.
  return (
    process.env.RECRUITEROS_UNSUB_SECRET ||
    process.env.RECRUITEROS_CRON_SECRET ||
    process.env.RECRUITEROS_API_TOKEN ||
    "recruitersos-unsubscribe-dev"
  );
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

/** Signature binding this workspace + address, so links can't be forged or reused across tenants. */
export function unsubSignature(workspaceId: string, email: string): string {
  return createHmac("sha256", secret()).update(`${workspaceId}|${norm(email)}`).digest("base64url").slice(0, 24);
}

export function verifyUnsubSignature(workspaceId: string, email: string, sig: string): boolean {
  return !!sig && sig === unsubSignature(workspaceId, email);
}

/** The signed one-click unsubscribe URL for one recipient. */
export function unsubUrl(workspaceId: string, email: string): string {
  const base = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
  const e = Buffer.from(norm(email)).toString("base64url");
  return `${base}/api/unsubscribe?w=${encodeURIComponent(workspaceId)}&e=${e}&s=${unsubSignature(workspaceId, email)}`;
}

/** Headers for one outbound cold email. `mailtoAddr` (the sending inbox) adds the mailto variant. */
export function unsubscribeHeaders(workspaceId: string, email: string, mailtoAddr?: string): Record<string, string> {
  const targets = [`<${unsubUrl(workspaceId, email)}>`];
  if (mailtoAddr) targets.push(`<mailto:${mailtoAddr}?subject=unsubscribe>`);
  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
