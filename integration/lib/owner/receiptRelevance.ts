/**
 * RecruitersOS · Owner · Is this charge one of OURS? (OWNER ONLY)
 *
 * The receipt harvester reads a mailbox, and a mailbox belongs to a person. The first
 * live sweep of neadusall@gmail.com filed Anthropic and Hetzner invoices, which is the
 * point, alongside Little Caesars, Boost Mobile and a car-insurance excess, which is not.
 * Personal spending in a company's books is not a rounding error: it inflates the burn,
 * it puts private purchases on a page built to be shown to an accountant, and it buries
 * the handful of real vendors under a supermarket receipt.
 *
 * ── The rule, and why it is drawn here ──────────────────────────────────────────
 * A charge is OURS when something independent of the message says so: it resolved to a
 * row on the spend register, or the vendor is one the platform is catalogued as running
 * on. Both of those are lists the owner controls. Everything else is a stranger.
 *
 * ── What happens to a stranger, and why it is NOT simply dropped ────────────────
 * It is not filed, and it IS reported: vendor, amount, date and sender go into the sweep
 * report so they can be read on the console. That distinction is the whole design. A
 * vendor genuinely being paid but never registered is exactly the thing the books exist
 * to catch, and a filter that swallowed it would turn an unknown charge into no charge at
 * all, which reads as "nothing to see" rather than "look at this". So: kept out of the
 * money, kept in front of the owner.
 *
 * Set RECEIPTS_FILE_UNKNOWN_VENDORS=1 to go back to filing everything.
 */

import type { SpendItem } from "./spendRegister";
import { VENDOR_SOURCES } from "./receiptSources";

const norm = (s: string) => (s || "").trim().toLowerCase();

/**
 * The confidence at which the vendor was identified by something OUTSIDE the message
 * body: the sender's own domain (0.95), or the merchant named on a processor's receipt
 * (0.85 to 0.9). Below this, matchVendor is telling you it found the name in running
 * text, which is a guess and not evidence of who was paid.
 */
const NAMED_BY_SENDER = 0.85;

/** Vendors the platform is catalogued as running on, whether or not they are priced. */
let catalogued: Set<string> | null = null;
function cataloguedVendors(): Set<string> {
  if (!catalogued) catalogued = new Set(VENDOR_SOURCES.map((s) => norm(s.vendor)));
  return catalogued;
}

export interface Relevance {
  ours: boolean;
  /** Why, in words, for the sweep report and for anyone reading this decision later. */
  why: string;
}

/**
 * Decide whether a charge belongs in the company's books.
 *
 * `itemId` is the strongest answer available and is trusted outright: the router only
 * sets it when the charge could be attributed to one register row, so a vendor that has
 * been given a line has already been vouched for by the owner.
 *
 * A NAME match against the register is deliberately exact rather than fuzzy. Loose
 * matching here would be the worst of both worlds: "Sedgwick" is one edit away from
 * plenty of real vendor names, and letting a stranger in on a near-miss defeats the
 * filter while telling nobody it happened. The fuzzy work belongs in receiptMatch, where
 * a wrong answer surfaces as an unattached charge instead of as silent inclusion.
 */
export function relevanceOf(
  charge: { vendor: string; itemId?: string; confidence?: number },
  items: SpendItem[],
): Relevance {
  if (charge.itemId) return { ours: true, why: "it pays a line on the register" };

  const v = norm(charge.vendor);
  if (!v) return { ours: false, why: "the charge names no vendor" };

  /* ⚠️ HOW THE VENDOR WAS IDENTIFIED MATTERS AS MUCH AS WHICH VENDOR IT IS.
     matchVendor scores its evidence: the sender's own domain is 0.95, a merchant named
     on a processor receipt 0.85 to 0.9, and a name merely APPEARING SOMEWHERE IN THE
     BODY is 0.6 to 0.7. That last one is a guess, and letting a guess through here is
     what put a $50,000 marketing email in the books as AWS and a Gusto payroll notice in
     as LinkedIn: the vendor was a real vendor, so "is this one of ours" answered yes,
     and the charge was still fiction.
     A vendor is only vouched for by NAME when something outside the body said so. */
  const evidenced = charge.confidence === undefined || charge.confidence >= NAMED_BY_SENDER;
  if (!evidenced) {
    return { ours: false, why: `nothing but the body of the message says this is ${charge.vendor}` };
  }

  if (cataloguedVendors().has(v)) return { ours: true, why: "a vendor the platform runs on" };

  /* An active register row for this vendor that the charge could not be pinned to is
     still proof the vendor is ours: several rows of one vendor, or a price that has
     moved, is a routing problem rather than a relevance one. A CANCELLED row counts too,
     because a final invoice for something just turned off is real money. */
  const onRegister = items.some((i) => norm(i.vendor) === v);
  if (onRegister) return { ours: true, why: "this vendor has a row on the register" };

  return { ours: false, why: `${charge.vendor} is not a vendor on your register` };
}

/** The escape hatch: file everything, as the harvester did before this existed. */
export function filingUnknownVendors(): boolean {
  return process.env.RECEIPTS_FILE_UNKNOWN_VENDORS === "1";
}
