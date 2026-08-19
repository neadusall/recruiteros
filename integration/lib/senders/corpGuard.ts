/**
 * RecruitersOS · Senders · corporate-identity send guard.
 *
 * A tenant's REAL corporate domain (the one their recruiters log in with,
 * e.g. lumesp.com) must never carry cold or bulk volume. Cold mail lives on
 * the lookalike sender fleet; the corporate domain carries only 1:1
 * white-label mail (booking invites, resume requests, auth mail). This guard
 * makes that rule structural instead of situational: rotation never picks a
 * box on a member-identity domain, and both send transports refuse one
 * outright, so a corporate mailbox added to the sender fleet by mistake can
 * never be mass-sent through.
 *
 * Protected domains are derived live from the auth store (the workspace's
 * tenant domain plus every member's login domain, minus public mail
 * providers), so the guard follows tenants as they are added without any
 * hardcoded list.
 */

const PUBLIC_MAIL_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com",
]);

function domainOf(email: string): string {
  return (String(email || "").split("@")[1] || "").trim().toLowerCase();
}

/** Email domains carrying this workspace's corporate identity. Cached briefly
 *  so per-send checks stay cheap under a batch loop. */
const cache = new Map<string, { at: number; domains: Set<string> }>();
const CACHE_MS = 60_000;

export async function corpIdentityDomains(workspaceId: string): Promise<Set<string>> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.domains;
  const out = new Set<string>();
  try {
    const auth = await import("../auth");
    const tenant = await auth.workspaceTenantDomain(workspaceId);
    if (tenant && !PUBLIC_MAIL_PROVIDERS.has(tenant)) out.add(tenant);
    for (const e of auth.workspaceMemberEmails(workspaceId)) {
      const d = domainOf(e);
      if (d && !PUBLIC_MAIL_PROVIDERS.has(d)) out.add(d);
    }
  } catch {
    // The guard must never take sending infra down with it; an unreadable
    // auth store just means no domains to protect on this call.
  }
  cache.set(workspaceId, { at: Date.now(), domains: out });
  return out;
}

/** Non-null = refuse this send: the inbox lives on the tenant's corporate
 *  identity domain. The string is the log-ready reason. */
export async function corpSendRefusal(
  m: { workspaceId: string; email: string },
): Promise<string | null> {
  const d = domainOf(m.email);
  if (!d) return null;
  const corp = await corpIdentityDomains(m.workspaceId);
  if (!corp.has(d)) return null;
  return `corp_identity_domain: ${m.email} is on ${d}, a corporate identity domain of workspace ${m.workspaceId}; bulk/cold sends never leave the tenant's real domain`;
}
