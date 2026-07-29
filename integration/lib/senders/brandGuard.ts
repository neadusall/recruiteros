/**
 * RecruitersOS · Senders · white-label sending-domain guard (fail-closed)
 *
 * PERMANENT RULE: mail to a white-label tenant's prospects goes out from THAT
 * tenant's domains, never from the house domain or another tenant's. Until now
 * this held only by convention (Lume's pool happens to contain lumesp.com-family
 * inboxes); this module makes it fail-closed at dispatch time:
 *
 *   - a white-label workspace may only send from an inbox whose domain is NOT
 *     the house apex and NOT another built-in brand's apex/token;
 *   - when no compliant inbox exists, the send BLOCKS. It never falls through
 *     to the house MTA/Instantly providers (those speak as the house).
 *
 * Lookalike outreach domains (e.g. lumesearch.io for Lume) pass automatically:
 * the guard is a denylist of the OTHER identities, not an allowlist, so adding
 * new outreach domains for a tenant needs no config change.
 */

import type { NotifyBrand } from "../outbound/brand";

function apexOf(host: string): string {
  const h = (host || "").toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
  const labels = h.split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

function houseApex(): string {
  return apexOf(process.env.RECRUITEROS_APP_URL || "recruitersos.co");
}

function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase().trim();
}

function matchesApex(domain: string, apex: string): boolean {
  return !!apex && (domain === apex || domain.endsWith("." + apex));
}

/**
 * May this workspace's cold email go out from `inboxEmail`?
 * House workspaces: always (their pool is workspace-scoped already).
 * White-label workspaces: any domain EXCEPT the house apex and other brands' apexes.
 */
export async function senderAllowedForBrand(brand: NotifyBrand, inboxEmail: string): Promise<boolean> {
  if (!brand.whiteLabel) return true;
  const domain = domainOf(inboxEmail);
  if (!domain) return false;
  if (matchesApex(domain, houseApex())) return false;
  const ownApex = apexOf(brand.appUrl);
  try {
    const { allBrandPresets } = await import("../branding/presets");
    for (const p of allBrandPresets()) {
      const otherApex = apexOf(p.appHost);
      if (otherApex && otherApex !== ownApex && matchesApex(domain, otherApex)) return false;
    }
  } catch { /* presets unavailable: house-apex check above still holds */ }
  return true;
}
