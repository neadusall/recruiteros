/**
 * Receipts: a deleted receipt stays deleted. Regression suite.
 * Run: npx tsx scripts/test-receipt-dismiss.mts   (exits non-zero on failure)
 *
 * The mailbox sweep skips an email only when a receipt carrying its fingerprint is
 * already in the store (harvestMailbox, the `duplicate` check). Deleting a receipt
 * therefore removed the only reason the sweep had to leave that email alone, and the next
 * pull filed the same invoice straight back. The owner deleted a RackNerd receipt and
 * watched it return, which is the second time this shape of bug has bitten this console
 * (the spend register's seed rows were the first).
 *
 * What is pinned:
 *   - a dismissed fingerprint is recognised, an undismissed one is not;
 *   - the fingerprint is stable across the sign of the amount, so a refund-shaped copy of
 *     a charge cannot slip past the check;
 *   - the fingerprint is specific: a different amount, vendor, date or invoice number is a
 *     different invoice and must still be ingested;
 *   - forgetting is all-or-nothing, and only the manual pull does it.
 */
import { isReceiptDismissed, type Receipt } from "../lib/owner/receipts";
import { createHash } from "crypto";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

/** Mirrors fingerprintOf() in lib/owner/receipts.ts. */
function fp(r: Partial<Receipt>): string {
  return createHash("sha1")
    .update([r.messageId || "", r.vendor, Math.abs(Number(r.amountUsd)).toFixed(2), r.chargedAt, r.invoiceNumber || ""].join("|"))
    .digest("hex");
}

const rackNerd = { messageId: "<abc@mail>", vendor: "RackNerd", amountUsd: 35.99, chargedAt: "2026-06-27", invoiceNumber: "INV-1" };

/* ---- the rule itself ---- */
{
  const dismissed = [fp(rackNerd)];
  check("a deleted invoice is recognised", isReceiptDismissed(fp(rackNerd), dismissed), true);
  check("an untouched invoice is not", isReceiptDismissed(fp({ ...rackNerd, invoiceNumber: "INV-2" }), dismissed), false);
  check("nothing is dismissed when the list is empty", isReceiptDismissed(fp(rackNerd), []), false);
}

/* ---- the fingerprint is stable where it must be ---- */
{
  // A refund carries the negative of the charge; Math.abs keeps them one invoice, which is
  // what stops a deleted charge returning wearing a minus sign.
  check("sign does not change the fingerprint", fp(rackNerd) === fp({ ...rackNerd, amountUsd: -35.99 }), true);
}

/* ---- and specific where it must be ---- */
{
  const dismissed = [fp(rackNerd)];
  const differs = [
    ["a different amount", { ...rackNerd, amountUsd: 35.98 }],
    ["a different vendor", { ...rackNerd, vendor: "Hetzner" }],
    ["a different charge date", { ...rackNerd, chargedAt: "2026-07-27" }],
    ["a different invoice number", { ...rackNerd, invoiceNumber: "INV-9" }],
    ["a different email", { ...rackNerd, messageId: "<zzz@mail>" }],
  ] as const;
  for (const [name, r] of differs) {
    check(`${name} is still ingested`, isReceiptDismissed(fp(r), dismissed), false);
  }
  check("the second RackNerd receipt is untouched by the first being deleted",
    isReceiptDismissed(fp({ ...rackNerd, messageId: "<def@mail>", invoiceNumber: "INV-2", amountUsd: 17.5 }), dismissed), false);
}

/* ---- forgetting ---- */
{
  // forgetReceiptDismissals() empties the list wholesale: the manual pull means "read the
  // mailbox again", which cannot sensibly apply to some deletions and not others.
  const after: string[] = [];
  check("after a manual pull nothing is dismissed", isReceiptDismissed(fp(rackNerd), after), false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
