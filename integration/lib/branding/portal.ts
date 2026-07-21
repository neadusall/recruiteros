/**
 * RecruitersOS · Portal isolation (host <-> tenant binding)
 *
 * recruitersos.co and each white-label portal (e.g. app.lumesp.com) belong to
 * SEPARATE companies. The host a request arrives on decides which company's
 * workspace it may operate in, full stop:
 *
 *   - On a tenant's portal host, only that tenant's workspace exists. A session
 *     pointing anywhere else is re-scoped to the tenant workspace (if the user
 *     is a member) or rejected.
 *   - On the house portal, a workspace that has its own white-label portal is
 *     invisible: sessions pointing at one are re-scoped to the user's own
 *     house-side workspace or rejected.
 *
 * This is what keeps a search run on recruitersos.co from ever landing in (or
 * even being visible from) a customer's portal, and vice versa - the wall is
 * applied per-request in lib/api context(), upstream of every route.
 *
 * Tenant resolution is deliberately TWO-source, mirroring notifyBrand():
 *   1) a VERIFIED/LIVE custom domain saved in the workspace's branding record;
 *   2) the built-in flagship presets (e.g. *.lumesp.com -> Lume), matched via
 *      the workspace's own corporate domain, so isolation holds even before
 *      the tenant ever touches Setup -> Branding.
 */

import { devAuthStore } from "../auth";
import { presetForHost } from "./presets";
import { brandingRecordSync, isReservedHouseHost, normalizeDomain, workspaceForDomainSync } from "./index";

/** The bare lowercase host a request arrived on (proxy-aware, port stripped). */
export function requestHost(req: Request): string {
  const raw = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return normalizeDomain(raw.split(",")[0].trim().replace(/:\d+$/, ""));
}

/** The tenant workspace SERVED at this host, or null for the house portal. */
export function tenantWorkspaceForHost(host: string): string | null {
  const h = normalizeDomain((host || "").replace(/:\d+$/, ""));
  if (!h || isReservedHouseHost(h)) return null;
  const byBrand = workspaceForDomainSync(h);
  if (byBrand) return byBrand;
  const preset = presetForHost(h);
  if (!preset) return null;
  for (const ws of devAuthStore().workspaces.values()) {
    if (ws.domain && presetForHost(ws.domain) === preset) return ws.id;
  }
  return null;
}

/** True when this workspace is a white-label tenant with its OWN portal, and
 *  therefore must never be read or written from the house portal. */
export function isTenantWorkspace(workspaceId: string): boolean {
  const b = brandingRecordSync(workspaceId);
  if (b?.customDomain && (b.domainStatus === "verified" || b.domainStatus === "live")) return true;
  const dom = devAuthStore().workspaces.get(workspaceId)?.domain;
  return Boolean(dom && presetForHost(dom));
}

