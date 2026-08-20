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
 * The app cannot see the send ledger — it lives in /out on the host, outside this container — so
 * tools/mpc-stats.mjs publishes the contacted set to a snapshot every 20 minutes and this reads
 * it. Cached in memory with a short TTL: the check runs on every inbound, and the file is a few
 * thousand strings.
 */

import { loadSnapshot } from "../db";

const KEY = "mpc_contacted_v1";
const TTL_MS = 5 * 60_000;

export type ContactProof = "address" | "domain";

interface ContactedSnapshot {
  generatedAt?: string;
  byWorkspace?: Record<string, { emails?: string[]; domains?: string[] }>;
}

interface Loaded {
  at: number;
  generatedAt: string;
  byWorkspace: Map<string, { emails: Set<string>; domains: Set<string> }>;
}

let cache: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
  const snap = (await loadSnapshot<ContactedSnapshot>(KEY)) || {};
  const byWorkspace = new Map<string, { emails: Set<string>; domains: Set<string> }>();
  for (const [ws, v] of Object.entries(snap.byWorkspace || {})) {
    byWorkspace.set(ws, {
      emails: new Set((v.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean)),
      domains: new Set((v.domains || []).map((d) => d.toLowerCase().trim()).filter(Boolean)),
    });
  }
  return { at: Date.now(), generatedAt: snap.generatedAt || "", byWorkspace };
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
 * Returns null when it has not — OR when no contacted set has been published yet. That second
 * case matters: a workspace whose engine does not publish one must not have every inbound
 * treated as chatter, so callers are required to treat null as "unknown, keep it" rather than
 * "fake, drop it". `hasSet()` is how a caller tells the two apart.
 */
export async function wasContacted(workspaceId: string, email: string | undefined | null): Promise<ContactProof | null> {
  const e = String(email || "").toLowerCase().trim();
  if (!e || !e.includes("@")) return null;
  const l = await current();
  const w = l.byWorkspace.get(workspaceId);
  if (!w) return null;
  if (w.emails.has(e)) return "address";
  const domain = e.split("@")[1];
  if (domain && w.domains.has(domain)) return "domain";
  return null;
}

/** True when this workspace has a published contacted set, i.e. the test above is meaningful. */
export async function hasContactedSet(workspaceId: string): Promise<boolean> {
  const l = await current();
  const w = l.byWorkspace.get(workspaceId);
  return !!w && w.emails.size > 0;
}

/** Drop the cache (tests, and after a fresh publish). */
export function resetContactedCache(): void {
  cache = null;
}
