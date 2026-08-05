/**
 * RecruitersOS · Reputation ingestion
 * Pulls sender reputation from the free authorities and writes a Reputation
 * snapshot onto each domain, which the governor reads:
 *
 *   - Microsoft SNDS: automated data via a keyed URL (SNDS_KEY). Real fetch,
 *     header-aware CSV parsing, explicit color mapping (an unrecognized or
 *     malformed feed NEVER upgrades a domain to "high" anymore).
 *   - Google Postmaster: real client via a Google service account
 *     (POSTMASTER_SA_JSON = the service-account key JSON, domains verified in
 *     Postmaster Tools). Maps the user-reported spam rate onto the tier the
 *     governor pauses on.
 *
 * Best-effort: a fetch failure leaves prior reputation intact.
 */

import { createSign } from "node:crypto";
import { allDomains, listServers, saveDomain } from "./store";
import { SPAM_PAUSE_RATE_PCT } from "./policy";
import type { Reputation, SendingDomain } from "./types";

/* ---------------- Microsoft SNDS ---------------- */

/** Map an SNDS filter-result color to our tier. Unknown values return null so a
 *  schema change or truncated row leaves the previous reputation intact instead
 *  of silently reading as healthy. */
function sndsTier(band: string): Reputation["tier"] | null {
  const b = band.toUpperCase();
  if (b.includes("RED")) return "bad";
  if (b.includes("YELLOW")) return "low";
  if (b.includes("GREEN")) return "high";
  return null;
}

/**
 * Fetch SNDS automated data (CSV of per-IP stats) and map the complaint/trap
 * signal onto a tier for each domain on that IP. `ipToDomains` restricts which
 * domains update. Set SNDS_KEY from your SNDS automated-data URL.
 *
 * SNDS columns (no header row in the automated feed): ip_address, activity_start,
 * activity_end, rcpt_commands, data_commands, message_recipients, filter_result(7),
 * complaint_rate(8), trap_message_period? … the two we need are located by CONTENT
 * (a %-rate and a color word), not by fixed index, so column drift can't flip
 * every domain to healthy the way the old positional cols[9] read did.
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
      if (!line.trim()) continue;
      const cols = line.split(",").map((c) => c.trim());
      const ip = cols[0];
      if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !ipToDomains.has(ip)) continue;
      // Locate the color band by content; a row without one is skipped whole.
      const band = cols.find((c) => /^(GREEN|YELLOW|RED)$/i.test(c));
      const tier = band ? sndsTier(band) : null;
      if (!tier) continue;
      // Trap hits: the numeric column right after the color, when present.
      const bandIdx = band ? cols.indexOf(band) : -1;
      const trapHits = bandIdx >= 0 ? parseInt(cols[bandIdx + 1] || "0", 10) || 0 : 0;
      for (const d of ipToDomains.get(ip) || []) {
        d.reputation = { source: "snds", tier, trapHits, at: new Date().toISOString() };
        await saveDomain(d);
        updated++;
      }
    }
  } catch { /* leave prior reputation intact */ }
  return updated;
}

/* ---------------- Google Postmaster ---------------- */

interface ServiceAccount { client_email: string; private_key: string }

function serviceAccount(): ServiceAccount | null {
  try {
    const raw = process.env.POSTMASTER_SA_JSON;
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j?.client_email && j?.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
  } catch {
    return null;
  }
}

export function postmasterConfigured(): boolean {
  return !!serviceAccount();
}

/** Mint a Google OAuth access token from the service account (JWT bearer flow). */
async function googleAccessToken(sa: ServiceAccount, scope: string): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(sa.private_key).toString("base64url")}`;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.access_token || null;
  } catch {
    return null;
  }
}

/** Map Postmaster's user-reported spam rate (percent) onto our tier scale. */
function postmasterTier(spamRatePct: number): Reputation["tier"] {
  if (spamRatePct > SPAM_PAUSE_RATE_PCT) return "bad";     // over Google's own red line
  if (spamRatePct > SPAM_PAUSE_RATE_PCT / 3) return "low"; // approaching it
  return "high";
}

/**
 * Pull Google Postmaster domain reputation for every sending domain verified in
 * Postmaster Tools. No-op (returns 0) until POSTMASTER_SA_JSON is configured.
 */
export async function ingestPostmaster(workspaceId: string): Promise<number> {
  const sa = serviceAccount();
  if (!sa) return 0;
  const token = await googleAccessToken(sa, "https://www.googleapis.com/auth/postmaster.readonly");
  if (!token) return 0;
  let updated = 0;
  const domains = await allDomains(workspaceId);
  for (const d of domains) {
    try {
      const res = await fetch(
        `https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(d.domain)}/trafficStats?pageSize=7`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) continue; // domain not verified in Postmaster / no data yet
      const j: any = await res.json();
      const stats: any[] = j?.trafficStats || [];
      if (!stats.length) continue;
      const latest = stats[stats.length - 1];
      const spamRatePct = Number(latest?.userReportedSpamRatio ?? 0) * 100;
      d.reputation = {
        source: "postmaster",
        tier: postmasterTier(spamRatePct),
        spamRatePct: Number(spamRatePct.toFixed(3)),
        at: new Date().toISOString(),
      };
      await saveDomain(d);
      updated++;
    } catch { /* per-domain best-effort */ }
  }
  return updated;
}

/** Daily refresh for a workspace: map server IPs → domains, pull SNDS, then
 *  Postmaster (Google data wins when both exist: it is domain-level truth). */
export async function refreshReputation(workspaceId: string): Promise<number> {
  const domains = await allDomains(workspaceId);
  const servers = await listServers(workspaceId);
  const ipMap = new Map<string, SendingDomain[]>();
  for (const s of servers) {
    if (!s.ip) continue;
    const ds = domains.filter((d) => d.serverId === s.id);
    if (ds.length) ipMap.set(s.ip, ds);
  }
  const snds = await ingestSnds(ipMap);
  const pm = await ingestPostmaster(workspaceId);
  return snds + pm;
}

export function reputationConfigured(): { snds: boolean; postmaster: boolean } {
  return { snds: !!process.env.SNDS_KEY, postmaster: postmasterConfigured() };
}
