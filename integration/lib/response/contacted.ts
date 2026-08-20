/**
 * RecruitersOS · Response · "did we email this person?"
 *
 * THE PROBLEM THIS SOLVES. The sender pool warms through Smartlead, and warm-up mail is built
 * to be indistinguishable from real business mail — same shapes, same headers, no marker of any
 * kind (verified on 2026-08-20 by reading the raw headers off a live box: nothing identifies it).
 * replySync only recognises this system's OWN warm-up tag, so every Smartlead exchange went
 * straight into the unified inbox: ~1,200 rows a day, which filled the 3,000-row response store
 * in under three days and left it holding zero identity-verified replies.
 *
 * There is no header to filter on, so filter on the only fact that actually separates the two:
 * a real reply comes from someone we emailed. A warm-up partner never is.
 *
 * TWO SOURCES, because outbound leaves this system by two different roads and a reply that
 * matched only one of them would be thrown away:
 *
 *   1. The MPC engine sends from the host, and its ledger lives in /out where this container
 *      cannot see it — so tools/mpc-stats.mjs publishes the contacted set to a snapshot.
 *   2. The portal sends its own mail (job blasts, campaign cadences) and records every recipient
 *      in the outreach contact ledger.
 *
 * Missing (2) is not hypothetical: of the ten people who had replied by 2026-08-20, eight were
 * in the engine's ledger and two — both job-blast recipients — were only in the portal's. Under
 * a one-source test those two genuine replies would have been dropped as chatter.
 */

import { loadSnapshot } from "../db";

const MPC_KEY = "mpc_contacted_v1";
const APP_KEY = "outreach_contact_ledger_v1";
const TTL_MS = 5 * 60_000;

export type ContactProof = "address" | "domain";

interface MpcSnapshot {
  generatedAt?: string;
  byWorkspace?: Record<string, { emails?: string[]; domains?: string[] }>;
}
interface AppLedger {
  byWorkspace?: Record<string, Record<string, { at?: string; channel?: string }>>;
}

interface Loaded {
  at: number;
  byWorkspace: Map<string, { emails: Set<string>; domains: Set<string> }>;
}

/** One cold email to a gmail.com address must never bless every gmail sender alive, so consumer
 *  mail hosts are barred from the DOMAIN test. Exact addresses at them still verify normally.
 *  Mirrors the list in tools/mpc-stats.mjs, which applies the same rule at publish time. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net",
  "charter.net", "earthlink.net",
]);

let cache: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
  const [mpc, app] = await Promise.all([
    loadSnapshot<MpcSnapshot>(MPC_KEY).catch(() => null),
    loadSnapshot<AppLedger>(APP_KEY).catch(() => null),
  ]);
  const byWorkspace = new Map<string, { emails: Set<string>; domains: Set<string> }>();
  const bucket = (ws: string) => {
    let b = byWorkspace.get(ws);
    if (!b) { b = { emails: new Set(), domains: new Set() }; byWorkspace.set(ws, b); }
    return b;
  };

  const mpcWs: Record<string, { emails?: string[]; domains?: string[] }> = mpc?.byWorkspace ?? {};
  for (const [ws, v] of Object.entries(mpcWs)) {
    const b = bucket(ws);
    for (const e of v.emails || []) { const x = e.toLowerCase().trim(); if (x) b.emails.add(x); }
    for (const d of v.domains || []) { const x = d.toLowerCase().trim(); if (x) b.domains.add(x); }
  }
  const appWs: Record<string, Record<string, unknown>> = app?.byWorkspace ?? {};
  for (const [ws, rows] of Object.entries(appWs)) {
    const b = bucket(ws);
    for (const key of Object.keys(rows || {})) {
      const x = key.toLowerCase().trim();
      if (!x.includes("@")) continue;              // the ledger also carries non-email handles
      b.emails.add(x);
      const d = x.split("@")[1];
      if (d && !FREE_MAIL.has(d)) b.domains.add(d);
    }
  }
  return { at: Date.now(), byWorkspace };
}

async function current(): Promise<Loaded> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  // One read at a time: a burst of inbound would otherwise each start their own.
  if (!inflight) {
    inflight = load()
      .then((l) => { cache = l; return l; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Has this workspace emailed this address, or anyone at its domain?
 *
 * Returns null when it has not — OR when no contacted set exists yet. That second case matters:
 * a workspace with no published set must not have every inbound treated as chatter, so callers
 * are required to read null as "unknown, keep it" rather than "fake, drop it". `hasContactedSet`
 * is how a caller tells the two apart.
 */
export async function wasContacted(workspaceId: string, email: string | undefined | null): Promise<ContactProof | null> {
  const e = String(email || "").toLowerCase().trim();
  if (!e || !e.includes("@")) return null;
  const w = (await current()).byWorkspace.get(workspaceId);
  if (!w) return null;
  if (w.emails.has(e)) return "address";
  const domain = e.split("@")[1];
  if (domain && w.domains.has(domain)) return "domain";
  return null;
}

/** True when this workspace has a contacted set at all, i.e. the test above is meaningful. */
export async function hasContactedSet(workspaceId: string): Promise<boolean> {
  const w = (await current()).byWorkspace.get(workspaceId);
  return !!w && w.emails.size > 0;
}

/** How many addresses/domains back the test, for the daily audit and the health board. */
export async function contactedSetSize(workspaceId: string): Promise<{ emails: number; domains: number }> {
  const w = (await current()).byWorkspace.get(workspaceId);
  return { emails: w?.emails.size ?? 0, domains: w?.domains.size ?? 0 };
}

/** Drop the cache (tests, and after a fresh publish). */
export function resetContactedCache(): void {
  cache = null;
}
