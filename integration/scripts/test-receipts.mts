/* Offline proof of the receipt pipeline: parse a real-shaped receipt, match its vendor,
   render it to a PNG, and reconcile a month grid out of it. No mailbox required. */
import { parseReceiptText, classify, matchVendor, addManualReceipt, listReceipts, type MailMessage } from "../lib/owner/receipts";
import { buildSpendMatrix, sourcingStatus } from "../lib/owner/spendMatrix";
import type { SpendItem } from "../lib/owner/spendRegister";

const SERPER_HTML = `
<div><h1>Your Serper subscription receipt</h1>
<p>Receipt # 81150972-168496165</p>
<table>
<tr><td>Amount Paid</td><td>Receipt Date</td><td>Payment Method</td></tr>
<tr><td>$50.00</td><td>30th July 2026</td><td>amex ending in 1024</td></tr>
</table>
<table>
<tr><td>Serper API</td><td>$50.00</td></tr>
<tr><td>50,000 credits</td><td>$50.00</td></tr>
<tr><td>Sales Tax (0%)</td><td>$0.00</td></tr>
<tr><td>Amount Paid</td><td>$50.00</td></tr>
</table>
<p>The $50.00 payment will appear on your bank/card statement as: PADDLE.NET* SERPER</p></div>`;

const SERPER_TEXT = `Your Serper subscription receipt
Receipt # 81150972-168496165
Amount Paid $50.00
Receipt Date 30th July 2026
Payment Method amex ending in 1024
Serper API $50.00
50,000 credits $50.00
Sales Tax (0%) $0.00
Amount Paid $50.00
The $50.00 payment will appear on your bank/card statement as: PADDLE.NET* SERPER`;

const msg: MailMessage = {
  subject: "Your Serper receipt",
  from: "help@paddle.com",
  fromName: "Serper (via Paddle.com)",
  date: "2026-07-30T15:30:00.000Z",
  messageId: "<test-serper@paddle.com>",
  text: SERPER_TEXT,
  html: SERPER_HTML,
  attachments: [],
};

const items: SpendItem[] = [
  { id: "spend_serper", vendor: "Serper.dev", label: "Google SERP credits", category: "search", billing: "credit",
    amountUsd: 50, at: "2026-07-01", status: "active", createdAt: "", updatedAt: "" },
  { id: "spend_js", vendor: "RapidAPI", label: "JSearch (Ultra)", category: "search", billing: "monthly",
    amountUsd: 75, at: "2026-06-01", status: "active", createdAt: "", updatedAt: "" },
  { id: "spend_hz", vendor: "Hetzner", label: "App server (ubuntu-8gb-ash-1, CCX13)", category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active", createdAt: "", updatedAt: "" },
] as SpendItem[];

console.log("classify:", classify(msg));
const parsed = parseReceiptText(SERPER_TEXT);
console.log("parsed:", JSON.stringify(parsed, null, 1));
console.log("vendor:", matchVendor(msg, items));

/* Render path: the manual entry route exercises the same renderShot() the sweep uses. */
process.env.ROS_DATA_DIR = process.env.TEST_DATA_DIR;
const r = await addManualReceipt({
  vendor: "Serper.dev", itemId: "spend_serper", period: "2026-07", amountUsd: 50,
  chargedAt: "2026-07-30", invoiceNumber: "81150972-168496165",
  file: { bytes: Buffer.from(SERPER_HTML), mime: "text/html", name: "receipt.html" },
});
console.log("manual receipt:", { id: r.id, hasShot: r.hasShot, shotError: r.shotError });

const receipts = await listReceipts();
const matrix = buildSpendMatrix(items, receipts, { months: 4, inboxConfigured: true });
console.log("months:", matrix.months);
console.log("rows:", matrix.rows.map((x) => x.vendor + " | " + x.cells.map((c) => c.period + ":" + c.status + ":" + c.countedUsd).join(" ")));
console.log("monthTotals:", matrix.monthTotals.map((m) => `${m.period} counted=${m.countedUsd} running=${m.runningUsd} cov=${m.coveragePct}%`));
console.log("totals:", matrix.totals);
console.log("anomalies:");
for (const a of matrix.anomalies) console.log(`  [${a.severity}] ${a.kind}: ${a.message}`);
console.log("sourcing:", sourcingStatus(items, receipts).map((s) => `${s.vendor}=${s.state}`).join(", "));
