/**
 * A paused subscription is not a missing receipt. Regression suite.
 * Run: npx tsx scripts/test-spend-pause.mts   (exits non-zero on failure)
 *
 * Sending.ac's billing page on 2026-07-31: $599.00/mo (1,500 Mailbox Slots at $1.00 less a
 * $901.00 bulk discount), one invoice paid 2026-06-24, "Your service is paused", and the
 * next period named as 2026-08-24 to 2026-09-24. July was never charged.
 *
 * Without a pause the register would post $599 of "no receipt on file" against a charge the
 * vendor never made, and the coverage figure, the anomaly list and the burn header would
 * all repeat it. What is pinned here:
 *   - a paused month expects nothing and says PAUSED, naming the date it comes back;
 *   - it raises no missing-receipt anomaly, and the month before it still does;
 *   - the resume month expects the fee again, so an August charge is looked for, not
 *     ignored, and a charge that lands DURING a pause is still reported rather than hidden;
 *   - a pause with no end date runs on; clearing the fields restores the old behaviour
 *     exactly, so nothing on the other 35 rows moves.
 */

import { buildSpendMatrix, pausedIn } from "../lib/owner/spendMatrix";
import { SEED } from "../lib/owner/spendRegister";
import type { SpendItem } from "../lib/owner/spendRegister";
import type { Receipt } from "../lib/owner/receipts";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T = "2026-07-01T00:00:00.000Z";
let seq = 0;
function item(over: Partial<SpendItem> = {}): SpendItem {
  return {
    id: `sp_${++seq}`, vendor: "Sending.ac", label: "Managed mailboxes (tal + lume domains)",
    category: "email", billing: "monthly", amountUsd: 599, at: "2026-06-24",
    status: "active", verified: true, seeded: true, createdAt: T, updatedAt: T,
    ...over,
  } as SpendItem;
}
/** Receipts carry the row they paid for, exactly as receiptMatch files them in the vault:
 *  an unlinked charge is a different question, and it has its own suite. */
function receipt(period: string, amountUsd: number, over: Partial<Receipt> = {}): Receipt {
  return {
    id: `rc_${++seq}`, vendor: "Sending.ac", period, amountUsd,
    chargedAt: `${period}-24T00:00:00.000Z`, currency: "USD", kind: "charge",
    source: "manual", confidence: 1, hasShot: false, createdAt: T, updatedAt: T,
    ...over,
  } as Receipt;
}

const paused = { pausedFrom: "2026-07", resumesAt: "2026-08-24" };
function cellAt(items: SpendItem[], receipts: Receipt[], period: string) {
  const m = buildSpendMatrix(items, receipts, { months: 24 });
  const row = m.rows.find((r) => r.vendor === "Sending.ac");
  return { m, row, cell: row?.cells.find((c) => c.period === period) };
}

/* ---- 1. the window under test is actually in the report ---------------------------- */
{
  const { m } = cellAt([item(paused)], [], "2026-07");
  check("July is inside the reported window", m.months.includes("2026-07"), true);
}

/* ---- 2. a paused month expects nothing and says so --------------------------------- */
{
  const { cell } = cellAt([item(paused)], [], "2026-07");
  check("paused month status", cell?.status, "paused");
  check("paused month expects nothing", cell?.expectedUsd, 0);
  check("paused month counts nothing", cell?.countedUsd, 0);
  check("paused month names the resume date", cell?.note, "paused, billing again 24 Aug");
}

/* ---- 3. no missing-receipt anomaly for a month nobody was charged for --------------- */
{
  const { m } = cellAt([item(paused)], [], "2026-07");
  const missing = m.anomalies.filter((a) => a.kind === "missing_receipt" && a.period === "2026-07");
  check("no missing_receipt raised for the paused month", missing.length, 0);
  const july = m.monthTotals.find((p) => p.period === "2026-07");
  check("paused month adds nothing to the month total", july?.countedUsd, 0);
}

/* ---- 4. the month BEFORE the pause is still chased ---------------------------------- */
{
  const { cell } = cellAt([item(paused)], [], "2026-06");
  check("June still expects the fee", cell?.expectedUsd, 599);
  check("June with no receipt is still a gap", cell?.status, "missing");
}
{
  const row = item(paused);
  const { cell } = cellAt([row], [receipt("2026-06", 599, { itemId: row.id })], "2026-06");
  check("June with its invoice reads paid", cell?.status, "paid");
  check("June counts the invoice", cell?.countedUsd, 599);
}

/* ---- 5. the resume month expects the fee again -------------------------------------- */
{
  // Same shape as Sending.ac, moved back a month so the resume month is inside the window
  // whatever today's date is: paused for June, billing again on 10 July.
  const back = item({ at: "2026-05-24", pausedFrom: "2026-06", resumesAt: "2026-07-10" });
  check("paused in the paused month", pausedIn(back, "2026-06"), true);
  check("not paused in the resume month", pausedIn(back, "2026-07"), false);
  const { cell } = cellAt([back], [], "2026-07");
  check("resume month expects the fee again", cell?.expectedUsd, 599);
}

/* ---- 6. a charge that lands during a pause is reported, never swallowed -------------- */
{
  const row = item(paused);
  const { cell, m } = cellAt([row], [receipt("2026-07", 599, { itemId: row.id })], "2026-07");
  check("a charge inside a pause still shows its money", cell?.actualUsd, 599);
  check("and is flagged rather than accepted quietly", cell?.status, "unexpected");
  check("it counts toward the month", cell?.countedUsd, 599);
  check(
    "and raises an unexpected charge",
    m.anomalies.some((a) => a.kind === "unexpected_charge" && a.period === "2026-07"),
    true,
  );
}

/* ---- 7. a pause with no end date runs on -------------------------------------------- */
{
  const open = item({ pausedFrom: "2026-07" });
  check("open-ended pause covers the month it began", pausedIn(open, "2026-07"), true);
  check("open-ended pause covers later months", pausedIn(open, "2027-01"), true);
  check("open-ended pause does not reach backwards", pausedIn(open, "2026-06"), false);
}

/* ---- 8. no pause on file changes nothing -------------------------------------------- */
{
  const plain = item();
  check("a row with no pause is never paused", pausedIn(plain, "2026-07"), false);
  const { cell } = cellAt([plain], [], "2026-07");
  check("and July reads exactly as it did before", cell?.status, "missing");
  check("expecting the full fee", cell?.expectedUsd, 599);
  // Cleared through the drawer: empty strings mean "no pause", not "paused since nothing".
  const cleared = item({ pausedFrom: undefined, resumesAt: undefined });
  check("cleared fields end the pause", pausedIn(cleared, "2026-07"), false);
}

/* ---- 9. the documented Sending.ac facts are on the seed ----------------------------- */
{
  const s = SEED.find((x) => x.vendor === "Sending.ac");
  check("Sending.ac is seeded", !!s, true);
  check("at the figure on the billing page", s?.amountUsd, 599);
  check("read off the vendor, so verified", s?.verified, true);
  check("no longer asking for a price", s?.needsAmount, undefined);
  check("starting from its first invoice", s?.at, "2026-06-24");
  check("paused from July", s?.pausedFrom, "2026-07");
  check("billing again on 24 August", s?.resumesAt, "2026-08-24");
  check("carrying the vendor's own product name", s?.vendorLabel, "Mailbox Slot");
  const notes = String(s?.notes || "");
  for (const fact of ["1,500", "$1.00", "$901.00", "2026-06-24", "2026-08-24", "1024"]) {
    check(`notes record ${fact}`, notes.includes(fact), true);
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
