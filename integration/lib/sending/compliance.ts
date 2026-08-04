/**
 * RecruitersOS · Sending · CAN-SPAM body footer
 *
 * Every commercial email legally needs, IN THE BODY, a clear opt-out mechanism and
 * the sender's physical postal address (CAN-SPAM Act §5(a)(5)). The one-click
 * List-Unsubscribe header (lib/sending/unsubscribe) satisfies Gmail/Yahoo bulk-sender
 * rules but not the visible-footer requirement, so this module renders the footer
 * that gets appended to every cold send: brand name, postal address, and the same
 * signed unsubscribe link the header carries.
 *
 * Postal addresses are configured per brand, never invented:
 *   OUTREACH_POSTAL_ADDRESSES = {"<workspaceId or brand token or house>": "addr, city, ST zip"}
 *   OUTREACH_POSTAL_ADDRESS   = the house default (used only for non-white-label sends)
 *
 * WHITE-LABEL RULE (fail-closed, same as transactional mail): a white-label tenant's
 * footer NEVER falls back to the house address. If the tenant's address is not
 * configured, the footer ships with the brand + unsubscribe link only, and the
 * missing address is surfaced to the operator via footerAddressMissing().
 */

import { unsubUrl } from "./unsubscribe";

export interface FooterBrand {
  name: string;
  whiteLabel: boolean;
}

function addressBook(): Record<string, string> {
  try {
    const raw = process.env.OUTREACH_POSTAL_ADDRESSES;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function brandToken(name: string): string {
  return (name.split(/\s+/)[0] || "").toLowerCase();
}

/** The postal address for this workspace/brand, or null when none is configured.
 *  White-label brands never inherit the house address. */
export function postalAddressFor(workspaceId: string, brand: FooterBrand): string | null {
  const book = addressBook();
  const byWs = (book[workspaceId] || "").trim();
  if (byWs) return byWs;
  const byToken = (book[brandToken(brand.name)] || "").trim();
  if (byToken) return byToken;
  if (brand.whiteLabel) return null; // fail-closed: never the house address
  const house = (process.env.OUTREACH_POSTAL_ADDRESS || book["house"] || "").trim();
  return house || null;
}

/** True when a cold send for this workspace would ship without a postal address
 *  (a compliance gap the operator should fix by configuring the address). */
export function footerAddressMissing(workspaceId: string, brand: FooterBrand): boolean {
  return !postalAddressFor(workspaceId, brand);
}

export interface ComplianceFooter {
  html: string;
  text: string;
}

/** Render the footer for one recipient. Appended AFTER the message body on both
 *  the HTML and the text/plain parts. */
export function complianceFooter(workspaceId: string, recipientEmail: string, brand: FooterBrand): ComplianceFooter {
  const url = unsubUrl(workspaceId, recipientEmail);
  const address = postalAddressFor(workspaceId, brand);
  const identity = address ? `${brand.name} · ${address}` : brand.name;
  const html =
    `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e6e6e6;` +
    `font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#8a8a8a">` +
    escapeHtml(identity) +
    `<br><a href="${url}" style="color:#8a8a8a;text-decoration:underline">Unsubscribe</a>` +
    `</div>`;
  const text = `\n\n--\n${identity}\nUnsubscribe: ${url}`;
  return { html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
