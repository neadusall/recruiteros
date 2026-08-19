/**
 * RecruitersOS · Senders · recipient-aware fleet guard.
 *
 * Gmail 550-rejects the internal SMTP server's outbound IP (UnsolicitedMessageError,
 * observed 2026-08-19), so internal-fleet (own-smtp) inboxes must never draw a
 * Google-hosted recipient: the send would hard-bounce and deepen the IP's bad
 * reputation. The host-side cold sender already routes this way (batch.mjs
 * noGoogle); this brings the app's sender-pool rotation to the same behavior.
 *
 * A recipient counts as Google-hosted when the address is gmail.com/googlemail.com
 * or its domain's MX points at Google. MX lookups are cached and FAIL-OPEN: an
 * unresolvable domain is treated as not-Google (the recipient may be unreachable
 * for other reasons, but this guard only encodes the known Gmail/IP conflict).
 *
 * INTERNAL_SMTP_NO_GOOGLE=0 disables the guard once the server sends from an IP
 * Gmail accepts (new IP cutover); default is ON.
 */
import { resolveMx } from "node:dns/promises";
import type { SenderInbox } from "./types";

const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MX_TTL_MS = 6 * 60 * 60_000;
const MX_CACHE_MAX = 5000;
const mxCache = new Map<string, { at: number; google: boolean }>();

function guardEnabled(): boolean {
  return process.env.INTERNAL_SMTP_NO_GOOGLE !== "0";
}

function recipientDomain(email: string): string {
  const i = email.indexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : "";
}

/** True when the recipient's mail is handled by Google (gmail.com or Google-MX workspace). */
export async function googleHostedRecipient(email: string): Promise<boolean> {
  const domain = recipientDomain(email);
  if (!domain) return false;
  if (GOOGLE_DOMAINS.has(domain)) return true;
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < MX_TTL_MS) return hit.google;
  let google = false;
  try {
    const mx = await resolveMx(domain);
    google = mx.some((r) => /(^|\.)google(mail)?\.com$/i.test((r.exchange || "").replace(/\.$/, "")));
  } catch { /* fail-open: unresolvable = not-Google here */ }
  if (mxCache.size >= MX_CACHE_MAX) mxCache.clear();
  mxCache.set(domain, { at: Date.now(), google });
  return google;
}

/** False only for the known-bad pairing: internal-fleet inbox + Google-hosted recipient. */
export async function inboxAllowedForRecipient(m: SenderInbox, recipientEmail: string): Promise<boolean> {
  if (!guardEnabled()) return true;
  if (m.provider !== "own-smtp") return true;
  return !(await googleHostedRecipient(recipientEmail));
}
