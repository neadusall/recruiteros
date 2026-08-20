/**
 * RecruitersOS · Senders · recipient-aware fleet guard.
 *
 * A sending fleet must never draw a recipient whose mail host is currently
 * rejecting that fleet's server: the send would hard-bounce AND log more bad
 * behavior against the server (this is how the internal SMTP IP got burned in
 * 2026-08 while every dashboard read green). The rotation calls this guard and
 * simply rotates past an incompatible inbox, so the send reroutes instead of
 * burning.
 *
 * WHICH pairs are blocked is DATA, not code: the host NDR sweeps scan every
 * bounce notice (campaign AND warm-up traffic) for receiver-side block
 * signatures and persist fleet x provider pairs to the provider-block ledger
 * (snap_provider_blocks_v1, host-owned; the app only reads it, no hydration
 * risk). A pair counts here only while fresh (seen within 7 days) and material
 * (count >= SENDER_BLOCK_MIN, default 20); a healed provider ages out and the
 * lane reopens by itself. Never hardcode a new receiver block in code - teach
 * the sweep's signatures instead, so detection, routing, and the health board
 * all learn it at once.
 *
 * One seeded exception: internal fleet x google stays blocked until the new-IP
 * cutover proves Gmail accepts the server (INTERNAL_SMTP_NO_GOOGLE=0 removes
 * the seed; the ledger stays authoritative either way). SENDER_PROVIDER_GUARD=0
 * disables the whole guard.
 *
 * Recipient classification is MX-based with cached lookups and FAIL-OPEN: an
 * unresolvable domain matches no provider, so this guard can steer traffic but
 * never strand a send over resolver trouble.
 */
import { resolveMx } from "node:dns/promises";
import { loadSnapshot } from "../db";
import type { SenderInbox } from "./types";

type FleetKey = "internal" | "sendingac" | "google" | "other";

interface LedgerBlock { fleet?: string; provider?: string; count?: number; lastSeen?: string }
interface Ledger { blocks?: Record<string, LedgerBlock> }

const ACTIVE_WINDOW_MS = 7 * 86_400_000;
const LEDGER_TTL_MS = 5 * 60_000;
const MX_TTL_MS = 6 * 60 * 60_000;
const MX_CACHE_MAX = 5000;

const mxCache = new Map<string, { at: number; providers: string[] }>();
let ledgerCache: { at: number; byFleet: Map<string, Set<string>> } | null = null;

function guardEnabled(): boolean {
  return process.env.SENDER_PROVIDER_GUARD !== "0";
}
function blockMin(): number {
  const n = Number(process.env.SENDER_BLOCK_MIN);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** The same fleet vocabulary the ledger and the fleet cards use. */
export function fleetKeyOf(m: Pick<SenderInbox, "provider" | "smtpHost">): FleetKey {
  if (m.provider === "sending-ac") return "sendingac";
  if (m.provider === "google" || /^smtp\.gmail\.com$/i.test(m.smtpHost || "")) return "google";
  if (m.provider === "own-smtp") return "internal";
  return "other";
}

// MX hostname -> the ledger's provider vocabulary. Gateways (proofpoint etc.)
// are matchable too: domains behind them carry the gateway in their MX.
const MX_PROVIDER_PATTERNS: Array<[string, RegExp]> = [
  ["google", /(^|\.)google(mail)?\.com$|(^|\.)aspmx\./i],
  ["microsoft", /protection\.outlook\.com$|(^|\.)outlook\.com$/i],
  ["mailspamprotection", /(^|\.)mailspamprotection\.com$/i],
  ["proofpoint", /(^|\.)pphosted\.com$|(^|\.)proofpoint\.com$/i],
  ["mimecast", /(^|\.)mimecast\.[a-z.]+$/i],
  ["barracuda", /(^|\.)barracudanetworks\.com$|(^|\.)ess\.barracuda/i],
];
const FAST_PATH: Record<string, string[]> = {
  "gmail.com": ["google"],
  "googlemail.com": ["google"],
  "outlook.com": ["microsoft"],
  "hotmail.com": ["microsoft"],
  "live.com": ["microsoft"],
};

function recipientDomain(email: string): string {
  const i = email.indexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : "";
}

/** Ledger vocabulary providers handling this recipient's mail (usually 0 or 1). */
export async function recipientProviders(email: string): Promise<string[]> {
  const domain = recipientDomain(email);
  if (!domain) return [];
  if (FAST_PATH[domain]) return FAST_PATH[domain];
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < MX_TTL_MS) return hit.providers;
  const providers: string[] = [];
  try {
    const mx = await resolveMx(domain);
    for (const [key, re] of MX_PROVIDER_PATTERNS) {
      if (mx.some((r) => re.test((r.exchange || "").replace(/\.$/, "")))) providers.push(key);
    }
  } catch { /* fail-open: unresolvable = no provider match */ }
  if (mxCache.size >= MX_CACHE_MAX) mxCache.clear();
  mxCache.set(domain, { at: Date.now(), providers });
  return providers;
}

/** Fleet -> providers currently rejecting it: fresh + material ledger pairs, plus the seed. */
export async function activeBlocks(): Promise<Map<string, Set<string>>> {
  if (ledgerCache && Date.now() - ledgerCache.at < LEDGER_TTL_MS) return ledgerCache.byFleet;
  const byFleet = new Map<string, Set<string>>();
  try {
    const led = await loadSnapshot<Ledger>("provider_blocks_v1");
    for (const b of Object.values(led?.blocks || {})) {
      if (!b?.fleet || !b.provider) continue;
      if (!b.lastSeen || Date.now() - Date.parse(b.lastSeen) > ACTIVE_WINDOW_MS) continue;
      if ((b.count || 0) < blockMin()) continue;
      const set = byFleet.get(b.fleet) || new Set<string>();
      set.add(b.provider);
      byFleet.set(b.fleet, set);
    }
  } catch { /* fail-open on ledger trouble: seed below still applies */ }
  if (process.env.INTERNAL_SMTP_NO_GOOGLE !== "0") {
    const set = byFleet.get("internal") || new Set<string>();
    set.add("google");
    byFleet.set("internal", set);
  }
  ledgerCache = { at: Date.now(), byFleet };
  return byFleet;
}

/** False when the inbox's fleet is currently rejected by the recipient's mail host. */
export async function inboxAllowedForRecipient(m: SenderInbox, recipientEmail: string): Promise<boolean> {
  if (!guardEnabled()) return true;
  const blocked = (await activeBlocks()).get(fleetKeyOf(m));
  if (!blocked || !blocked.size) return true;
  const providers = await recipientProviders(recipientEmail);
  return !providers.some((p) => blocked.has(p));
}
