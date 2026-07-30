/* Proves the PDF branch: make a PDF invoice with Chromium, then feed it back through the
   receipt renderer (pdf.js inside the same browser) and check a PNG comes out. */
import { chromium } from "playwright";
import { addManualReceipt, listReceipts } from "../lib/owner/receipts";

const INVOICE = `<div style="font:14px system-ui;padding:40px">
<h1>Hetzner Cloud</h1><h2>Invoice R0026489234</h2>
<p>Invoice date: 01.07.2026</p><p>Service period: 01.06.2026 - 30.06.2026</p>
<table style="width:100%;border-collapse:collapse">
<tr><td>ubuntu-8gb-ash-1 (CCX13)</td><td style="text-align:right">EUR 26.09</td></tr>
<tr><td>recruiteros-worker-2 (CPX11)</td><td style="text-align:right">EUR 5.18</td></tr>
<tr><td><b>Total amount due</b></td><td style="text-align:right"><b>EUR 31.27</b></td></tr>
</table></div>`;

const b = await chromium.launch({ args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setContent(INVOICE);
const pdf = await p.pdf({ format: "A4" });
await b.close();
console.log("made a", pdf.length, "byte PDF");

const r = await addManualReceipt({
  vendor: "Hetzner", itemId: "spend_hz", period: "2026-06", amountUsd: 33.77,
  chargedAt: "2026-07-01", invoiceNumber: "R0026489234",
  file: { bytes: Buffer.from(pdf), mime: "application/pdf", name: "hetzner.pdf" },
});
console.log("pdf receipt:", { id: r.id, hasShot: r.hasShot, shotError: r.shotError });
console.log("on file:", (await listReceipts()).length);
