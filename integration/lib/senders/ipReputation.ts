/**
 * RecruitersOS · Senders · sending-IP reputation alarm.
 *
 * The most dangerous state a sending server can reach is a PUBLIC BLOCKLIST listing:
 * it stops mail at many receivers at once (2026-08-20: one Spamhaus listing on the
 * internal server's outbound IP took Outlook offline for that fleet the same night
 * Gmail was already refusing it) and, left running, it trains domain-level reputation
 * against the sending domains - which are the asset that cannot be replaced. An IP is
 * cheap; a burned domain portfolio is not.
 *
 * Ground truth comes from the receivers themselves: their rejection text names the IP
 * they refused and usually the list they consulted, and the NDR sweeps record both on
 * the provider-block ledger. That beats self-probing, because public resolvers refuse
 * Spamhaus queries outright (they answer 127.255.255.254, "open resolver") - the exact
 * reason a self-check would have reported "clean" all through the incident.
 *
 * This raises the alarm ONCE per distinct listing state (a repeat tick is silent), and
 * routes through the owner-notice channel (Resend), never a pool inbox, so an alert can
 * never consume sending capacity or ride a compromised fleet.
 */
import { loadSnapshot, saveSnapshot } from "../db";

interface LedgerBlock {
  fleet?: string; provider?: string; count?: number; lastSeen?: string;
  blockedIp?: string | null; blocklist?: string | null; sample?: string | null;
}
interface Ledger { blocks?: Record<string, LedgerBlock> }
interface AlarmSnap { notifiedKey?: string; at?: string; listings?: Listing[] }

export interface Listing { ip: string; blocklist: string; receivers: string[]; fleets: string[]; lastSeen: string }
export interface IpReputationReport { listings: Listing[]; refusedIps: string[]; notified: boolean }

const ACTIVE_WINDOW_MS = 7 * 86_400_000;
const SNAP_KEY = "sender_ip_reputation_v1";

function blockMin(): number {
  const n = Number(process.env.SENDER_BLOCK_MIN);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/**
 * Read the ledger, group fresh + material blocks into per-IP listings, alert the owner
 * when the listing state changes. Never throws: a monitoring layer must not be able to
 * break the maintenance tick it runs inside.
 */
export async function checkSendingIpReputation(): Promise<IpReputationReport> {
  const led = await loadSnapshot<Ledger>("provider_blocks_v1");
  const fresh = Object.values(led?.blocks || {}).filter(
    (b) => b?.lastSeen && Date.now() - Date.parse(b.lastSeen) < ACTIVE_WINDOW_MS && (b.count || 0) >= blockMin(),
  );

  const byKey = new Map<string, Listing>();
  for (const b of fresh) {
    if (!b.blocklist || !b.blockedIp) continue;
    const key = `${b.blockedIp}|${b.blocklist}`;
    const cur = byKey.get(key) || { ip: b.blockedIp, blocklist: b.blocklist, receivers: [], fleets: [], lastSeen: b.lastSeen! };
    if (b.provider && !cur.receivers.includes(b.provider)) cur.receivers.push(b.provider);
    if (b.fleet && !cur.fleets.includes(b.fleet)) cur.fleets.push(b.fleet);
    if (b.lastSeen! > cur.lastSeen) cur.lastSeen = b.lastSeen!;
    byKey.set(key, cur);
  }
  const listings = [...byKey.values()].sort((a, b) => a.ip.localeCompare(b.ip));
  const refusedIps = [...new Set(fresh.map((b) => b.blockedIp).filter((x): x is string => !!x))];

  const prev = (await loadSnapshot<AlarmSnap>(SNAP_KEY)) || {};
  const key = listings.map((l) => `${l.ip}:${l.blocklist}`).sort().join(",");
  let notified = false;
  let notifiedKey = prev.notifiedKey;

  if (listings.length && key !== prev.notifiedKey) {
    try {
      const { notifyOwner, noticeConfigured } = await import("../owner/ownerNotice");
      if (noticeConfigured()) {
        const lines = listings.map(
          (l) => `- ${l.ip} is listed on ${l.blocklist}. Refused by: ${l.receivers.join(", ")}. Affects the ${l.fleets.join(", ")} sending fleet.`,
        );
        const res = await notifyOwner({
          subject: `Sending IP blocklisted (${listings.map((l) => l.ip).join(", ")})`,
          body:
            `A receiving provider has refused mail and named a public blocklist:\n\n${lines.join("\n")}\n\n` +
            `What this means: a public listing stops mail at many receivers at once, and every further attempt trains reputation against the sending DOMAINS, which matter far more than the IP.\n\n` +
            `What is already automatic: recipients hosted by the refusing providers are routed to other sending fleets, so campaigns keep running on healthy infrastructure.\n\n` +
            `What needs a person: stop that server's outbound volume including warm-up, then request delisting at https://check.spamhaus.org once the behaviour that caused it has stopped, or cut the server over to a clean IP.`,
        });
        notified = !!res?.ok;
        if (notified) notifiedKey = key;
      }
    } catch { /* alerting is best-effort; the health board still shows it */ }
  }
  // A cleared listing re-arms the alarm, so the NEXT listing pages again.
  if (!listings.length && prev.notifiedKey) notifiedKey = undefined;

  await saveSnapshot(SNAP_KEY, { notifiedKey, at: new Date().toISOString(), listings } satisfies AlarmSnap);
  return { listings, refusedIps, notified };
}
