/**
 * A metered line reports what the VENDOR billed, not what this app guessed. Regression suite.
 * Run: npx tsx scripts/test-vendor-usage.mts   (exits non-zero on failure)
 *
 * The bug this pins, found on the live console 2026-07-31: the Telnyx row read
 * "$0.12 metered, $0 proven" for June. $0.12 was twelve voice minutes the app had priced
 * into its own usage ledger at a cent each. Telnyx's own June invoice is $0.42, its May
 * invoice $34.58, and neither figure could reach the grid — May was filed as a receipt but
 * June fell under the receipt vault's $1 materiality floor, so it landed nowhere and the
 * console silently fell back to the internal estimate.
 *
 * The rules:
 *   - the vendor's figure REPLACES the internal one for that month, never adds to it
 *     (the invoice already contains the traffic the ledger was pricing);
 *   - a key the vendor has said nothing about keeps the internal figure;
 *   - a month too small to be worth a receipt still lands in the books;
 *   - the month still running is carried, labelled as part of a month, and never proven;
 *   - a figure is not proof: a vendor-API month counts toward burn and stays unproven
 *     until the vendor's own invoice is on file.
 */

import { mergeVendorUsage, vendorUsageWindow, vendorUsageDelta, recordVendorMonth, devVendorUsage } from "../lib/owner/vendorUsage";
import type { SpendItem } from "../lib/owner/spendRegister";
import type { Receipt } from "../lib/owner/receipts";

/* The books normally begin at 2026-06 and the grid honours that cut, which would drop the
   fixture months this test needs. Set before the module is loaded, hence the late import. */
process.env.SPEND_REGISTER_START = "2020-01";
const { buildSpendMatrix } = await import("../lib/owner/spendMatrix");

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T = "2026-07-01T00:00:00.000Z";

/* ============================ 1. merge: replace, never add ============================ */
{
  const internal = { "2026-06": { telnyx: 0.12, rapidapi_skiptrace: 41.5 } };
  const vendor = { "2026-06": { telnyx: 0.42 } };
  const merged = mergeVendorUsage(internal, vendor);
  check("the vendor's figure wins", merged["2026-06"].telnyx, 0.42);
  check("and does not add to ours", merged["2026-06"].telnyx === 0.54, false);
  check("a key the vendor never mentioned is untouched", merged["2026-06"].rapidapi_skiptrace, 41.5);
}
{
  const merged = mergeVendorUsage({}, { "2026-05": { telnyx: 34.58 } });
  check("a month only the vendor knows about still appears", merged["2026-05"].telnyx, 34.58);
}
{
  const merged = mergeVendorUsage({ "2026-04": { telnyx: 5 } }, {});
  check("with nothing from the vendor, ours stands", merged["2026-04"].telnyx, 5);
}

/* ============================ 2. the trailing window ============================ */
{
  devVendorUsage().months = [];
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: "2026-06", amountUsd: 30, closed: true });
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: "2026-07", amountUsd: 31, closed: false });

  /* Standing at the very end of July: a 31-day window is all of July and none of June. */
  const endOfJuly = Date.UTC(2026, 7, 1);
  check("a whole calendar month inside the window counts whole", vendorUsageWindow(31, endOfJuly).telnyx, 31);
  check("a 30-day window over a 31-day month takes 30 days of it", vendorUsageWindow(30, endOfJuly).telnyx, 30);

  /* Standing halfway through July: 15 days of July, 15 of June. */
  const midJuly = Date.UTC(2026, 6, 16);
  const mid = vendorUsageWindow(30, midJuly);
  const half = Math.round((30 * (15 / 30) + 31 * (15 / 31)) * 100) / 100;
  check("a window spanning two months is apportioned by day", mid.telnyx, half);

  const all = vendorUsageWindow(0, midJuly);
  check("window 0 means every month on file, whole", all.telnyx, 61);
}

/* ============================ 3. the burn delta ============================ */
{
  devVendorUsage().months = [];
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: "2026-07", amountUsd: 21.17, closed: false });
  const endOfJuly = Date.UTC(2026, 7, 1);
  const d = vendorUsageDelta({ telnyx: 0.12, rapidapi_skiptrace: 41.5 }, 31, endOfJuly);
  check("burn moves by the difference, not the whole figure", d.total, 21.05);
  check("and only for the key the vendor spoke about", Object.keys(d.byKey), ["telnyx"]);
}
{
  devVendorUsage().months = [];
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: "2026-07", amountUsd: 4, closed: true });
  const d = vendorUsageDelta({ telnyx: 10 }, 31, Date.UTC(2026, 7, 1));
  check("an over-estimate corrects downward", d.total, -6);
}

/* ============================ 4. the grid, end to end ============================ */

/* Months relative to the clock, because the grid's window always ends at the current one:
   OPEN = the month running now, SMALL = last month, INVOICED = the one before it. */
const monthAgo = (n: number): string => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 7);
};
const OPEN = monthAgo(0), SMALL = monthAgo(1), INVOICED = monthAgo(2);

function telnyxRow(): SpendItem {
  return {
    id: "sp_telnyx", vendor: "Telnyx", label: "SMS, voice and numbers", category: "messaging",
    billing: "metered", amountUsd: 0, at: `${INVOICED}-01`, status: "active", seeded: true,
    link: { ledgerSource: "telnyx", envKeys: ["TELNYX_API_KEY"], integrationId: "telnyx" },
    createdAt: T, updatedAt: T,
  } as SpendItem;
}
function invoicedReceipt(): Receipt {
  return {
    id: "rcpt_1", period: INVOICED, vendor: "Telnyx", itemId: "sp_telnyx", amountUsd: 34.58,
    currency: "USD", kind: "charge", source: "api", invoiceNumber: "b29695cc",
    chargedAt: `${INVOICED}-28`, createdAt: T, updatedAt: T,
  } as Receipt;
}

{
  devVendorUsage().months = [];
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: INVOICED, amountUsd: 34.58, reference: "b29695cc", closed: true });
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: SMALL, amountUsd: 0.42, reference: "63776a02", closed: true });
  await recordVendorMonth({ key: "telnyx", vendor: "Telnyx", period: OPEN, amountUsd: 13.33, closed: false });

  const m = buildSpendMatrix([telnyxRow()], [invoicedReceipt()], { months: 4, inboxConfigured: true });
  const row = m.rows.find((r) => r.vendor === "Telnyx");
  if (!row) { console.log("FAIL no Telnyx row"); failures++; }
  const cell = (p: string) => row!.cells.find((c) => c.period === p)!;

  check("the below-floor month reports the invoice, not our estimate", cell(SMALL).countedUsd, 0.42);
  check("and says whose figure it is", cell(SMALL).note, "Telnyx's own figure for the month");
  check("the month still running is carried", cell(OPEN).countedUsd, 13.33);
  check("labelled as part of a month", cell(OPEN).note, "Telnyx so far this month, still running");
  check("a figure alone is never proof", cell(OPEN).verified, false);
  check("the month with a real invoice is proven", cell(INVOICED).verified, true);
  check("and reads the invoice figure", cell(INVOICED).countedUsd, 34.58);
  check("no double-count where receipt and API agree", cell(INVOICED).note, undefined);
  check("the row totals every month Telnyx billed", row!.totalCountedUsd, 48.33);
  check("of which only the invoiced month is proven", row!.totalVerifiedUsd, 34.58);
}

/* A live pay-per-use line with nothing from the vendor keeps behaving exactly as before. */
{
  devVendorUsage().months = [];
  const m = buildSpendMatrix([telnyxRow()], [invoicedReceipt()], { months: 4, inboxConfigured: true });
  const row = m.rows.find((r) => r.vendor === "Telnyx")!;
  check("with no vendor figure, only the receipt counts", row.totalCountedUsd, 34.58);
  check("and no month is labelled as the vendor's", row.cells.filter((c) => /own figure|still running/.test(c.note || "")).length, 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
