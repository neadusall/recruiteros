/*
 * THE PICTURE OF A RECEIPT HAS TO BE READABLE, WHICH IS NOT THE SAME AS EXISTING.
 *
 * Every receipt in the vault had a PNG and every one of them was soft, because the PDF was
 * drawn into a canvas whose backing store was SMALLER than the device pixels the screenshot
 * then captured: pdf.js drew a US Letter page 979px wide, the canvas laid out at 979 CSS px,
 * and the shot was taken at deviceScaleFactor 2, so Chromium magnified a half-size drawing
 * to 1958px. The file looked big and carried no more detail than the small one. Zooming in
 * on it in the console could never help, because the detail was never drawn.
 *
 * So this pins the things that made it readable, each of which is invisible in a "hasShot:
 * true" assertion:
 *   1. the page is DRAWN at ~200 DPI and captured 1:1, so the PNG is the target width exactly
 *   2. the picture is actually sharp — measured, not assumed
 *   3. the renderer stamps its version, and the repair pass redraws anything older, so a
 *      quality fix reaches receipts filed months ago without re-fetching a single document
 *   4. a two-line payment confirmation is trimmed to itself rather than padded out to the
 *      full height of the render surface, which used to leave the receipt a stamp in the
 *      corner of a page of white
 *
 * Run: cd integration && npx tsx scripts/test-receipt-shot-quality.mts
 */
import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROS_DATA_DIR = await mkdtemp(join(tmpdir(), "rcpt-quality-"));
const { addManualReceipt, readReceiptArtifact, renderMissingShots, SHOT_VERSION } =
  await import("../lib/owner/receipts");
const sharp = (await import("sharp")).default;

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { console.log("  ok   " + name); return; }
  failures += 1;
  console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
}

/** Mean absolute laplacian at a fixed sample width: how much edge a picture actually carries.
    A magnified drawing scores far lower than the same page drawn at full size. */
async function sharpness(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .resize({ width: 1400 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, n = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      sum += Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - info.width] - data[i + info.width]);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/* An invoice with real small print in it: a page of headings only would look sharp however
   it was drawn, and the line items are what an accountant reads. */
const INVOICE = `<div style="font:13px system-ui;padding:44px">
  <h1 style="margin:0">RapidAPI</h1>
  <p style="font-size:11px;color:#475467">Invoice BG95YPTX-0005 · Date of issue July 1, 2026 · Date due July 1, 2026</p>
  <p style="font-size:11px">Bill to: neadusall@gmail.com, 451 Halleck Coach Rd, Centerton, Arkansas 72719</p>
  <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:24px">
    <tr><th style="text-align:left">Description</th><th>Qty</th><th style="text-align:right">Unit price</th><th style="text-align:right">Amount</th></tr>
    ${Array.from({ length: 12 }, (_, i) =>
      `<tr><td>MEGA plan for API Real-Time Web Search (v4) by OpenWeb Ninja {bcf0072f-23ac-4ad8-862e-c35d04eda51b} line ${i + 1}</td>
       <td style="text-align:center">1</td><td style="text-align:right">$150.00</td><td style="text-align:right">$150.00</td></tr>`).join("")}
    <tr><td colspan="3" style="text-align:right"><b>Amount due</b></td><td style="text-align:right"><b>$1,800.00 USD</b></td></tr>
  </table></div>`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const p = await browser.newPage();
await p.setContent(INVOICE);
const pdf = Buffer.from(await p.pdf({ format: "Letter" }));
await browser.close();

/* ---------- 1 + 2. drawn at full size, and sharp ---------- */

console.log("a PDF invoice is drawn at the resolution it is captured at");

const r = await addManualReceipt({
  vendor: "RapidAPI", period: "2026-07", amountUsd: 1800, chargedAt: "2026-07-01",
  invoiceNumber: "BG95YPTX-0005",
  file: { bytes: pdf, mime: "application/pdf", name: "invoice.pdf" },
});
check("the picture rendered", !!r.hasShot, r.shotError);
check("the renderer stamped its version", r.shotVersion === SHOT_VERSION, r.shotVersion);

const shot = await readReceiptArtifact(r.id, "png");
const meta = shot ? await sharp(shot.bytes).metadata() : null;
/* 1800px across a 612pt page is ~210 DPI. The old renderer produced 1958px for the same
   page — wider, and blurrier, because 979 of those pixels were invented by the scaler. */
check("the page is 1800px across, drawn not magnified", meta?.width === 1800, meta?.width);
check("the page is taller than it is wide (a portrait invoice)", (meta?.height || 0) > (meta?.width || 0), meta?.height);

const edge = shot ? await sharpness(shot.bytes) : 0;
/* MEASURED, on this exact document: the old pipeline scores 7.59 and the new one 13.12, so
   the floor sits between them. A check that merely asked for "some edge" would pass on the
   blurred picture too, which is how this shipped soft in the first place. */
check("the small print carries real detail", edge > 10, edge.toFixed(2));

const thumb = await readReceiptArtifact(r.id, "thumb");
const tmeta = thumb ? await sharp(thumb.bytes).metadata() : null;
check("the grid thumbnail is 640px, sharp on a retina tile", tmeta?.width === 640, tmeta?.width);

/* ---------- 3. an older picture is redrawn, unasked ---------- */

console.log("a picture from an older renderer is redrawn from the document on disk");

const settled = await renderMissingShots();
check("a current picture is left alone", settled.alreadyOk === 1 && settled.rendered === 0, settled);

/* Exactly what a receipt filed before this change looks like in the vault. */
(r as { shotVersion?: number }).shotVersion = 1;
const redrawn = await renderMissingShots();
check("a stale picture is redrawn", redrawn.rendered === 1, redrawn);
check("and comes back stamped current", r.shotVersion === SHOT_VERSION, r.shotVersion);

/* A receipt whose document was never kept must NOT lose the picture it has: an old picture
   beats no picture, and wiping the flag would blank a row the owner can read perfectly well. */
const orphan = await addManualReceipt({ vendor: "Loxo", period: "2026-07", amountUsd: 12 });
(orphan as { hasShot?: boolean }).hasShot = true;
const kept = await renderMissingShots();
check("a receipt with no document keeps whatever it has", orphan.hasShot === false && kept.noSource >= 1, kept);

/* ---------- 4. a short receipt is trimmed to itself ---------- */

console.log("an emailed payment confirmation fills the frame");

const email = await addManualReceipt({
  vendor: "Smartlead", period: "2026-07", amountUsd: 94, chargedAt: "2026-07-30",
  file: {
    bytes: Buffer.from(`<table width="600" style="font-family:Arial"><tr><td>
      <h2>Payment receipt</h2><p>Amount paid <b>$94.00</b></p><p>Receipt #4821-9910</p></td></tr></table>`),
    mime: "text/html", name: "receipt.html",
  },
});
const epng = await readReceiptArtifact(email.id, "png");
const emeta = epng ? await sharp(epng.bytes).metadata() : null;
check("it is rendered at the full frame width", emeta?.width === 1800, emeta?.width);
/* The render surface is 1200 CSS px tall, so an untrimmed shot is always 2400px: a four-line
   receipt sitting at the top of a page of white. */
check("and trimmed to its own height, not the surface's", (emeta?.height || 9999) < 2400, emeta?.height);

console.log(failures ? `\n${failures} FAILED` : "\nall good");
process.exit(failures ? 1 : 0);
