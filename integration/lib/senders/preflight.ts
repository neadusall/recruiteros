/**
 * RecruitersOS · Senders · universal pre-send safeguard (owner mandate 2026-08-19).
 *
 * Every outbound email, whatever lane it takes, passes this gate right before
 * transmit: the recipient must not be a known hard-bouncer, and the sending
 * identity must be healthy (not paused/errored, domain not benched by the rest
 * ledger). The host-side MPC tools already enforce both on their own lanes;
 * this brings the app's lanes (sender pool, MTA, transactional) to the same bar.
 *
 * Sources (both owned by host scripts; the app only ever READS them, so there
 * is no hydration-trap risk):
 *   - snap_mpc_ndr_v1.json         bounced[] = recipients receivers reported dead
 *   - snap_mpc_domain_rest_v1.json domains{} = sending domains resting after burn signals
 *
 * Fail-open by design: a missing or unreadable ledger never blocks mail, it only
 * means nothing is suppressed. OUTREACH_PREFLIGHT=0 disables the whole gate.
 * Thread replies (In-Reply-To set) skip the domain-rest check: answering a live
 * conversation is engagement, not cold volume, and helps a benched domain heal.
 */
import { loadSnapshot } from "../db";

export type PreflightVerdict = { ok: true } | { ok: false; reason: string };

const TTL_MS = 5 * 60_000;
let ndrCache: { at: number; set: Set<string> } | null = null;
let restCache: { at: number; set: Set<string> } | null = null;
let fuseCache: { at: number; fuse: FuseState | null } | null = null;

/** The send fuse ledger (tools/fuse.mjs, host-owned): a latched fleet-wide stop that a person clears. */
type FuseState = { tripped: boolean; scope?: "fleet" | "all"; domains?: string[]; reason?: string; since?: string; by?: string };

async function sendFuse(): Promise<FuseState | null> {
  if (fuseCache && Date.now() - fuseCache.at < TTL_MS) return fuseCache.fuse;
  let fuse: FuseState | null = null;
  try {
    const snap = await loadSnapshot<{ fleet?: FuseState }>("mpc_send_fuse_v1");
    fuse = snap?.fleet ?? null;
  } catch { /* fail-open */ }
  fuseCache = { at: Date.now(), fuse };
  return fuse;
}

/**
 * True when the send fuse is tripped for this sending identity. Scope "all" (a manual trip)
 * stops every cold send; scope "fleet" (an automatic trip on the cold fleet's bounce ratio)
 * stops the domains the fuse was measured over, leaving unrelated pools (a recruiter's own
 * mailbox, candidate job blasts from another fleet) alone.
 */
export async function isSendFuseTripped(fromEmail?: string): Promise<{ tripped: boolean; reason?: string }> {
  const f = await sendFuse();
  if (!f || !f.tripped) return { tripped: false };
  if (f.scope === "all") return { tripped: true, reason: f.reason };
  const d = String((fromEmail || "").split("@")[1] || "").toLowerCase();
  if (d && (f.domains || []).map((x) => String(x).toLowerCase()).includes(d)) return { tripped: true, reason: f.reason };
  return { tripped: false };
}

async function ndrBounced(): Promise<Set<string>> {
  if (ndrCache && Date.now() - ndrCache.at < TTL_MS) return ndrCache.set;
  const set = new Set<string>();
  try {
    const snap = await loadSnapshot<{ bounced?: string[] }>("mpc_ndr_v1");
    for (const e of snap?.bounced || []) set.add(String(e).toLowerCase());
  } catch { /* fail-open */ }
  ndrCache = { at: Date.now(), set };
  return set;
}

async function restingDomains(): Promise<Set<string>> {
  if (restCache && Date.now() - restCache.at < TTL_MS) return restCache.set;
  const set = new Set<string>();
  try {
    const snap = await loadSnapshot<{ domains?: Record<string, { state?: string; until?: string }> }>("mpc_domain_rest_v1");
    const now = Date.now();
    for (const [d, v] of Object.entries(snap?.domains || {})) {
      if (v?.state === "resting" && (!v.until || Date.parse(v.until) > now)) set.add(d.toLowerCase());
    }
  } catch { /* fail-open */ }
  restCache = { at: Date.now(), set };
  return set;
}

/** True when the receivers have already told us this address is dead. */
export async function isKnownHardBounce(email: string): Promise<boolean> {
  const to = String(email || "").toLowerCase().trim();
  if (!to) return false;
  return (await ndrBounced()).has(to);
}

export async function preflightOutbound(opts: {
  /** Sending identity, for the domain-rest + status checks. */
  fromEmail?: string;
  fromStatus?: string;
  /** Recipient address. */
  to: string;
  /** Set for replies inside an existing thread (In-Reply-To present). */
  threadReply?: boolean;
}): Promise<PreflightVerdict> {
  if (process.env.OUTREACH_PREFLIGHT === "0") return { ok: true };
  if (await isKnownHardBounce(opts.to)) return { ok: false, reason: "recipient_hard_bounced" };
  if (opts.fromStatus === "paused" || opts.fromStatus === "error") return { ok: false, reason: `sender_${opts.fromStatus}` };
  if (!opts.threadReply) {
    // Send fuse (owner mandate 2026-08-20): when the cold fleet is bouncing, or a person pulled
    // the fuse by hand, app lanes stop with the host lanes. Replies in a live thread still go.
    const fuse = await isSendFuseTripped(opts.fromEmail);
    if (fuse.tripped) return { ok: false, reason: "send_fuse_tripped" };
  }
  if (!opts.threadReply && opts.fromEmail) {
    const d = String(opts.fromEmail.split("@")[1] || "").toLowerCase();
    if (d && (await restingDomains()).has(d)) return { ok: false, reason: "sender_domain_resting" };
  }
  return { ok: true };
}
