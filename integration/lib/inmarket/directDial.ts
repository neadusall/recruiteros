/**
 * RecruiterOS · In-Market · Verified direct-dial resolver (opt-in)
 *
 * Resolves the SPECIFIC person's OWN direct line, with two hard guarantees:
 *   1. PERSON-DIRECT, never a switchboard — the Apify "Direct Dials" actor (PDL-backed)
 *      rejects company/HQ numbers, so we only ever get the individual's own line.
 *   2. LANDLINE or VoIP ONLY, never a mobile — every found number is confirmed with Telnyx
 *      line-type lookup; a mobile (or an unconfirmable/toll-free line) is dropped.
 *
 * This is the $0.10 model: pay-per-result $0.10 per number FOUND (a no-find is free), plus
 * ~$0.0025 to classify. It is OPT-IN — only runs when the Hire Signals "Find direct dials"
 * setting is on for a push, so it never fires automatically. Needs APIFY_TOKEN + PDL_API_KEY;
 * without them it returns null (no number) rather than a scraped company line.
 */

import { apifyDirectDialFinder } from "../signals/apify";
import { classifyLine } from "../signals/phoneClassify";
import { recordUsage } from "../billing/ledger";
import type { Motion } from "../core/types";

export interface DirectDialResult {
  /** The verified person-direct landline/VoIP number, or null when none qualified. */
  phone: string | null;
  /** Line type when a number came back (so a rejected mobile is visible). */
  lineType?: "landline" | "voip" | "mobile" | "toll_free" | "unknown";
  /** USD spent this attempt (the $0.10 find when billed + the classify). */
  costUsd: number;
  /** Why we have no usable number: "no_find" (free), "mobile"/"switchboard"/"unconfirmed". */
  reason?: "no_find" | "mobile" | "unconfirmed" | "not_configured";
}

interface DialSubject {
  fullName?: string;
  company?: string;
  companyName?: string;
  domain?: string;
  email?: string;
  title?: string;
  linkedinUrl?: string;
}

/**
 * Find one person's verified direct landline/VoIP. Returns `{ phone: null }` (with a reason)
 * on a miss, a mobile, or an unconfirmed line — the caller keeps whatever it already had.
 */
export async function resolveDirectDial(
  workspaceId: string,
  motion: Motion,
  subject: DialSubject,
): Promise<DirectDialResult> {
  // Needs the Apify actor configured (APIFY_TOKEN; PDL_API_KEY for real person numbers).
  if (!apifyDirectDialFinder.isConfigured()) return { phone: null, costUsd: 0, reason: "not_configured" };

  let outcome;
  try {
    outcome = await apifyDirectDialFinder.lookup({
      subject: subject as Record<string, unknown>,
      field: "landlinePhone",
      resolved: {},
    });
  } catch {
    return { phone: null, costUsd: 0, reason: "no_find" };
  }
  // A no-find is FREE (pay-per-result) — nothing billed, nothing kept.
  if (outcome.status !== "hit" || !outcome.value) return { phone: null, costUsd: 0, reason: "no_find" };

  const number = String(outcome.value).trim();
  // We are billed $0.10 for the FOUND number regardless of its line type — meter it.
  recordUsage({
    workspaceId,
    motion,
    category: "enrichment",
    type: "apify_direct_dial",
    source: "apify",
    quantity: 1,
    unitCostUsd: 0.1,
    meta: { number },
  });

  // Confirm the carrier line type; accept ONLY landline/VoIP (drop mobile + unconfirmed).
  const c = await classifyLine(number, { workspaceId, motion });
  const cost = +(0.1 + (c.costUsd || 0)).toFixed(4);
  if (c.lineType === "landline" || c.lineType === "voip") {
    return { phone: number, lineType: c.lineType, costUsd: cost };
  }
  return {
    phone: null,
    lineType: c.lineType,
    costUsd: cost,
    reason: c.lineType === "mobile" ? "mobile" : "unconfirmed",
  };
}
