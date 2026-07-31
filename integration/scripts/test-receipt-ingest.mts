/**
 * A charge is filed ONCE, however many times the puller pushes it.
 * Run: npx tsx scripts/test-receipt-ingest.mts   (exits non-zero on failure)
 *
 * On 2026-07-31 the same eight RapidAPI invoices were pushed twice: once by the ledger
 * path, which knew their numbers (BG95YPTX-0001..0009), and once by the sweep, which did
 * not send any. Ingest matched an incoming charge to one already on file only when NEITHER
 * side carried an invoice number, so the second push matched nothing and the vault ended up
 * holding all eight charges twice. Every RapidAPI line on Spend master then read double:
 * Skip Tracing $120 against a $60 register row, Fresh LinkedIn $98 against $49.
 *
 * What this pins:
 *   - the same invoice number is the same charge, whatever else changed;
 *   - a push with no number still recognises a charge already on file, and vice versa;
 *   - the number a push knows is stamped onto a row that was filed without one;
 *   - two genuinely different invoices on one day at one price stay two charges;
 *   - after any order of pushes, the duplicate sweep finds nothing left to remove.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "ros-ingest-"));

const { recordPortalReceipt, recordApiReceipt, listReceipts } = await import("../lib/owner/receipts");
const { findDuplicates } = await import("../lib/owner/receiptMatch");

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

/* The eight invoices actually on file, off the PDFs themselves. */
const FILED = [
  { inv: "BG95YPTX-0001", at: "2026-06-16", amt: 99.99, what: "Realtime LinkedIn Data Scraper" },
  { inv: "BG95YPTX-0002", at: "2026-06-19", amt: 49, what: "Fresh LinkedIn Scraper API" },
  { inv: "BG95YPTX-0004", at: "2026-06-24", amt: 75, what: "JSearch" },
  { inv: "BG95YPTX-0005", at: "2026-07-01", amt: 150, what: "Real-Time Web Search" },
  { inv: "BG95YPTX-0006", at: "2026-07-16", amt: 99.99, what: "Realtime LinkedIn Data Scraper" },
  { inv: "BG95YPTX-0007", at: "2026-07-19", amt: 49, what: "Fresh LinkedIn Scraper API" },
  { inv: "BG95YPTX-0008", at: "2026-07-20", amt: 60, what: "Skip Tracing Working API" },
  { inv: "BG95YPTX-0009", at: "2026-07-24", amt: 75, what: "JSearch" },
];

/* A stand-in document. The render will fail on it and that is deliberate: filing a charge
   must not depend on the picture, only on the vendor having handed over bytes. */
const pdf = (name: string) => ({
  bytes: Buffer.from(`%PDF-1.4 ${name}`),
  mime: "application/pdf",
  name: `${name}.pdf`,
});

async function file(o: { at: string; amt: number; what: string; inv?: string; vendor?: string; period?: string }) {
  return recordPortalReceipt({
    vendor: o.vendor || "RapidAPI",
    /* An invoice is usually issued after the month it bills for, so the period is not
       always the charge date's month. */
    period: o.period || o.at.slice(0, 7),
    chargedAt: o.at,
    amountUsd: o.amt,
    reference: o.inv,
    description: o.what,
    notes: "downloaded from the vendor portal by spend-ledger",
    file: pdf(`${o.at}-${o.what.toLowerCase().replace(/\W+/g, "-")}`),
  });
}

/* ---- 1. the push that knows the numbers ---- */
let created = 0;
for (const f of FILED) created += (await file(f)).created ? 1 : 0;
check("eight invoices file as eight charges", created, 8);
check("...and the vault holds eight", (await listReceipts()).length, 8);

/* ---- 2. the push that does not: the exact second run that doubled the books ---- */
let again = 0;
for (const f of FILED) again += (await file({ ...f, inv: undefined })).created ? 1 : 0;
check("a push with no invoice numbers files nothing new", again, 0);
check("the vault still holds eight", (await listReceipts()).length, 8);
check(
  "and every invoice number survived the anonymous push",
  (await listReceipts()).filter((r) => r.invoiceNumber).length,
  8,
);
check(
  "Skip Tracing is one $60 charge, not two",
  (await listReceipts()).filter((r) => r.description === "Skip Tracing Working API").map((r) => r.amountUsd),
  [60],
);

/* ---- 3. the other order: filed blind first, numbered afterwards ---- */
{
  const blind = await file({ at: "2026-07-28", amt: 20, what: "Some Listing" });
  check("a charge with no number on the document still files", blind.created, true);
  const named = await file({ at: "2026-07-28", amt: 20, what: "Some Listing", inv: "BG95YPTX-0011" });
  check("the number arriving later lands on the same row", named.created, false);
  check("...and is stamped onto it", named.receipt.invoiceNumber, "BG95YPTX-0011");
  check("...on the same id", named.receipt.id, blind.receipt.id);
}

/* ---- 4. two real charges that look alike are still two ---- */
{
  const a = await file({ at: "2026-07-29", amt: 75, what: "JSearch", inv: "BG95YPTX-0012" });
  const b = await file({ at: "2026-07-29", amt: 75, what: "JSearch", inv: "BG95YPTX-0013" });
  check("two invoice numbers on one day at one price are two charges", b.created, true);
  check("...on two rows", a.receipt.id === b.receipt.id, false);
}

/* ---- 5. a re-issued invoice corrects its own row ---- */
{
  const fixed = await file({ at: "2026-07-30", amt: 88, what: "Corrected", inv: "BG95YPTX-0014" });
  const redo = await file({ at: "2026-07-31", amt: 90, what: "Corrected", inv: "BG95YPTX-0014" });
  check("the same invoice number is the same charge, re-dated", redo.created, false);
  check("...and carries the corrected figure", redo.receipt.amountUsd, 90);
  check("...on the row it was already on", redo.receipt.id, fixed.receipt.id);
}

/* ---- 6. a vendor's PDF lands ON its own API figure, not beside it ----
 *
 * Telnyx is priced from its usage API (a figure, no document) and its invoice PDF exists
 * only on the portal. Both describe ONE bill. Filed as two rows, Telnyx would have read
 * twice its real cost the first night the portal puller ran — the RapidAPI bug above,
 * wearing different clothes. The API dates a month to its period end and the invoice to its
 * issue date, so `isSameCharge` cannot catch this pair on its own.
 */
{
  await recordApiReceipt({
    vendor: "Telnyx", period: "2026-06", amountUsd: 0.42, reference: "63776a02",
    chargedAt: "2026-06-30", description: "Month-end invoice",
  });
  const pulled = await file({
    vendor: "Telnyx", at: "2026-07-01", amt: 0.42, what: "Telnyx invoice", inv: "INV-0042", period: "2026-06",
  });
  const telnyx = (await listReceipts()).filter((r) => r.vendor === "Telnyx" && r.period === "2026-06");
  check("the document joins the figure instead of doubling the month", telnyx.length, 1);
  check("...on the row that was already there", pulled.created, false);
  check("...now a filed document, not a stated figure", telnyx[0].source, "portal");
  check("...carrying the vendor's own invoice number", telnyx[0].invoiceNumber, "INV-0042");
}
{
  await recordApiReceipt({
    vendor: "Telnyx", period: "2026-05", amountUsd: 34.11, reference: "b29695cc", chargedAt: "2026-05-31",
  });
  const pulled = await file({
    vendor: "Telnyx", at: "2026-06-01", amt: 34.58, what: "Telnyx invoice", inv: "INV-0041", period: "2026-05",
  });
  check("the invoice corrects a figure summed from usage feeds", pulled.receipt.amountUsd, 34.58);
}
{
  await recordApiReceipt({
    vendor: "Telnyx", period: "2026-04", amountUsd: 12.5, reference: "a8edbdd6", chargedAt: "2026-04-30",
  });
  const pulled = await file({
    vendor: "Telnyx", at: "2026-05-01", amt: 0, what: "Telnyx invoice", inv: "INV-0040", period: "2026-04",
  });
  check("a puller that could not read an amount never erases one", pulled.receipt.amountUsd, 12.5);
}
{
  await recordApiReceipt({
    vendor: "Telnyx", period: "2026-03", amountUsd: 9, reference: "d96fd661", chargedAt: "2026-03-31",
  });
  await file({ vendor: "Telnyx", at: "2026-04-02", amt: 9, what: "Telnyx invoice", inv: "INV-0039", period: "2026-04" });
  const march = (await listReceipts()).filter((r) => r.vendor === "Telnyx" && r.period === "2026-03");
  check("a different month is still its own charge", march.length, 1);
  check("...and keeps its stated figure", march[0].source, "api");
}

/* ---- 7. nothing for the duplicate sweep to clean up afterwards ---- */
{
  const dupes = findDuplicates(await listReceipts());
  check("the duplicate sweep finds nothing to remove", dupes.map((d) => d.reason), []);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
