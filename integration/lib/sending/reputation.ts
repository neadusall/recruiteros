/**
 * RecruiterOS · Reputation ingestion
 * Pulls sender reputation from the free authorities and writes a Reputation
 * snapshot onto each domain, which the governor reads:
 *
 *   - Microsoft SNDS  — automated data via a keyed URL (SNDS_KEY). Real fetch.
 *   - Google Postmaster — requires OAuth + verified domains; left as a config
 *     seam (POSTMASTER_*) that throws not_configured until wired.
 *
 * Best-effort: a fetch failure leaves prior reputation intact.
 */

import { allDomains, listServers, saveDomain } from "./store";
import type { Reputation, SendingDomain } from "./types";

/* ---------------- Microsoft SNDS ---------------- */

/**
 * Fetch SNDS automated data (CSV of per-IP stats) and map the complaint/trap
 * signal onto a tier for each domain on that IP. `ipToDomains` restricts which
 * domains update. Set SNDS_KEY from your SNDS automated-data URL.
 */
async function ingestSnds(ipToDomains: Map<string, SendingDomain[]>): Promise<number> {
  const key = process.env.SNDS_KEY;
  if (!key || ipToDomains.size === 0) return 0;
  let updated = 0;
  try {
    const res = await fetch(`https://sendersupport.olc.protection.outlook.com/snds/data.aspx?key=${encodeURIComponent(key)}`);
    if (!res.ok) return 0;
    const csv = await res.text();
    for (const line of csv.split(/\r?\n/)) {
      const cols = line.split(",");
      const ip = cols[0]?.trim();
      if (!ip || !ipToDomains.has(ip)) continue;
      const trapHits = parseInt(cols[8] || "0", 10) || 0;
      const band = (cols[9] || "").toUpperCase();
      const tier: Reputation["tier"] = band.includes("RED") ? "bad" : band.includes("YELLOW") ? "low" : "high";
      for (const d of ipToDomains.get(ip) || []) {
        d.reputation = { source: "snds", tier, trapHits, at: new Date().toISOString() };
        await saveDomain(d);
        updated++;
      }
    }
  } catch { /* leave prior reputation intact */ }
  return updated;
}

/* ---------------- Google Postmaster (seam) ---------------- */

export function postmasterConfigured(): boolean {
  return !!(process.env.POSTMASTER_CLIENT_ID && process.env.POSTMASTER_REFRESH_TOKEN);
}

/**
 * Pull Google Postmaster domain reputation. Requires an OAuth client + refresh
 * token for an account with the domains verified in Postmaster Tools. Throws
 * until configured — wire the OAuth exchange + GET
 * gmailpostmastertools.googleapis.com/v1/domains/{domain}/trafficStats here.
 */
export async function ingestPostmaster(_workspaceId: string): Promise<number> {
  if (!postmasterConfigured()) throw Object.assign(new Error("postmaster_not_configured"), { status: 503 });
  return 0; // TODO: OAuth + trafficStats → domain.reputation
}

/** Daily refresh for a workspace: map server IPs → domains, pull SNDS. */
export async function refreshReputation(workspaceId: string): Promise<number> {
  const domains = await allDomains(workspaceId);
  const servers = await listServers(workspaceId);
  const ipMap = new Map<string, SendingDomain[]>();
  for (const s of servers) {
    if (!s.ip) continue;
    const ds = domains.filter((d) => d.serverId === s.id);
    if (ds.length) ipMap.set(s.ip, ds);
  }
  return ingestSnds(ipMap);
}

export function reputationConfigured(): { snds: boolean; postmaster: boolean } {
  return { snds: !!process.env.SNDS_KEY, postmaster: postmasterConfigured() };
}
