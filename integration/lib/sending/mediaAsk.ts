/**
 * RecruitersOS · Sending · media-host cert gate
 *
 * When OUTREACH_MEDIA_HOST_PATTERN is set (e.g. "vid.{domain}"), outgoing video links ride
 * vid.<sending-domain> instead of the app origin (see mediaHost.ts). Caddy's on-demand TLS
 * then needs permission to mint certificates for those hosts, and /api/caddyask is the only
 * gate. This module answers: is this host one of OUR media hosts? A host qualifies only when
 * it matches the configured pattern AND its base domain is one we send from — an MTA-fleet
 * sending domain or the domain of a pooled sender inbox. Anything else stays locked out, so
 * the gate cannot be used to mint certs for domains we don't control.
 */

import { listSendingWorkspaceIds, findDomainByName } from "./store";
import { allInboxDomains } from "../senders/store";

/**
 * The fleet base domain a host claims under the media-host pattern, or null when the
 * pattern is unset or the host doesn't match it. Pure string logic, no store access.
 */
export function mediaHostBaseDomain(host: string): string | null {
  const pattern = (process.env.OUTREACH_MEDIA_HOST_PATTERN || "").trim().toLowerCase();
  if (!pattern || !pattern.includes("{domain}")) return null;
  const [prefix, suffix] = pattern.split("{domain}");
  const h = (host || "").trim().toLowerCase();
  if (h.length <= prefix.length + suffix.length) return null;
  if (!h.startsWith(prefix) || (suffix && !h.endsWith(suffix))) return null;
  const base = suffix ? h.slice(prefix.length, h.length - suffix.length) : h.slice(prefix.length);
  if (!base || !base.includes(".") || /[^a-z0-9.-]/.test(base)) return null;
  return base;
}

/** True when the host is a media host for a domain we actually send from. */
export async function isApprovedMediaHost(host: string): Promise<boolean> {
  const base = mediaHostBaseDomain(host);
  if (!base) return false;
  for (const ws of await listSendingWorkspaceIds()) {
    if (await findDomainByName(ws, base)) return true;
  }
  return (await allInboxDomains()).has(base);
}
