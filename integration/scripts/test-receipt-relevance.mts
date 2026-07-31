/**
 * Personal spending stays out of the company's books: regression suite.
 * Run: npx tsx scripts/test-receipt-relevance.mts   (exits non-zero on failure)
 *
 * The first live sweep of a personal Gmail filed Anthropic and Hetzner invoices, which
 * is the point, alongside Little Caesars, Boost Mobile and a car-insurance excess, which
 * is not. This pins the line between them.
 *
 * The rule that matters most is the one about STRANGERS. A charge from a sender nobody
 * has registered is either personal spending or a vendor genuinely being paid that
 * nobody has written down, and the second is exactly what these books exist to catch. So
 * a stranger is kept out of the money and kept in front of the owner: this suite fails if
 * the filter ever becomes a silent drop.
 */

import { relevanceOf } from "../lib/owner/receiptRelevance";
import type { SpendItem } from "../lib/owner/spendRegister";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const now = "2026-07-01";
function item(id: string, vendor: string, label: string, status = "active"): SpendItem {
  return { id, vendor, label, category: "people", billing: "monthly", amountUsd: 10, at: now, status, createdAt: now, updatedAt: now } as unknown as SpendItem;
}

const REGISTER: SpendItem[] = [
  item("s1", "RapidAPI", "JSearch (Ultra)"),
  item("s2", "Zapmail", "Google Workspace mailboxes"),
  item("s3", "Sending.ac", "Mailbox slots", "cancelled"),
];

/* ---- ours ---- */

check("a charge already on a register row is ours",
  relevanceOf({ vendor: "Anything At All", itemId: "s1" }, REGISTER).ours, true);
check("and it says why", relevanceOf({ vendor: "x", itemId: "s1" }, REGISTER).why,
  "it pays a line on the register");

/* Anthropic and Hetzner are catalogued in receiptSources even before anyone prices them,
   which is what lets a real vendor through on its very first invoice. */
check("a catalogued vendor is ours", relevanceOf({ vendor: "Anthropic" }, REGISTER).ours, true);
check("Hetzner too", relevanceOf({ vendor: "Hetzner" }, REGISTER).ours, true);
check("case does not matter", relevanceOf({ vendor: "hetzner" }, REGISTER).ours, true);
check("nor does surrounding space", relevanceOf({ vendor: "  Anthropic " }, REGISTER).ours, true);

check("a vendor with a register row but no routing is still ours",
  relevanceOf({ vendor: "RapidAPI" }, REGISTER).ours, true);
/* A final invoice for something just switched off is real money that still has to be
   paid and reconciled, so a cancelled row does not make its vendor a stranger. */
check("a cancelled row still vouches for its vendor",
  relevanceOf({ vendor: "Sending.ac" }, REGISTER).ours, true);

/* ---- not ours ---- */

check("a pizza order is not ours", relevanceOf({ vendor: "Littlecaesars" }, REGISTER).ours, false);
check("nor a phone bill", relevanceOf({ vendor: "Boostmobile" }, REGISTER).ours, false);
check("nor an insurance claim", relevanceOf({ vendor: "Sedgwick" }, REGISTER).ours, false);
check("and the reason names the vendor",
  relevanceOf({ vendor: "Littlecaesars" }, REGISTER).why,
  "Littlecaesars is not a vendor on your register");
check("a charge naming no vendor is not ours", relevanceOf({ vendor: "" }, REGISTER).ours, false);

/* THE MATCH IS EXACT, ON PURPOSE. Loose matching would be the worst of both worlds: it
   defeats the filter on a near-miss and tells nobody it happened. The fuzzy work belongs
   in receiptMatch, where a wrong answer surfaces as an unattached charge. */
check("a near-miss on a register name does not sneak in",
  relevanceOf({ vendor: "RapidAPI Holdings LLC" }, REGISTER).ours, false);
check("nor a near-miss on a catalogued name",
  relevanceOf({ vendor: "Anthropic Inc" }, REGISTER).ours, false);

/* ---- the point of the whole thing ---- */

/* A stranger must come back with a REASON, because the caller reports it rather than
   dropping it. An empty reason would let a real unregistered vendor vanish among the
   groceries, which is the exact failure this filter must not introduce. */
const stranger = relevanceOf({ vendor: "Some New Tool" }, REGISTER);
check("a stranger is refused", stranger.ours, false);
check("a stranger always carries a reason", stranger.why.length > 0, true);
check("and the reason is about the register, not about spam",
  stranger.why.includes("not a vendor on your register"), true);

/* An empty register must not make every vendor a stranger: the catalogue still vouches. */
check("with an empty register the catalogue still lets real vendors through",
  relevanceOf({ vendor: "Telnyx" }, []).ours, true);
check("and still refuses a stranger", relevanceOf({ vendor: "Littlecaesars" }, []).ours, false);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
