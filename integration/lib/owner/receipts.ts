/**
 * RecruitersOS · Owner · Receipt vault + month-over-month spend (OWNER ONLY)
 *
 * The Spend master knows what each vendor is SUPPOSED to cost. This module holds proof of
 * what was actually charged: the receipt itself, as an image, filed to the month it belongs
 * to, with a running total per vendor and per month.
 *
 * WHY EMAIL IS THE SOURCE. Of the ~20 vendors this business pays, none exposes a usable
 * invoice API (see receiptSources.ts for the per-vendor findings). Every one of them emails
 * a receipt. So the pipeline is:
 *
 *   billing mailbox (IMAP, read-only)
 *        -> classify the message as a real CHARGE (not a dunning notice, not a trial nag)
 *        -> parse vendor, amount, currency, receipt number, charge date, billing period
 *        -> render the receipt to a PNG the owner can look at (this is the "screenshot")
 *        -> match it to a spend-register row, or park it as an UNMATCHED charge
 *        -> reconcile every month against what the register says should have been charged
 *
 * Nothing is ever deleted from the mailbox and nothing is marked read: the sweep opens the
 * folder read-only, so it can be re-run over any date range to backfill history.
 *
 * THE POINT OF THE RECONCILER: a month is only "reported" when a receipt exists for it. Any
 * month where a live subscription produced no receipt is raised as a gap, by name, with the
 * portal link to go download it by hand. That is what stops a month from quietly passing
 * unaccounted for.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { listSpendItems, setLearnedPrice, type SpendItem } from "./spendRegister";
import {
  VENDOR_SOURCES, PROCESSOR_DOMAINS, GENERIC_SUBJECT_HINTS, NON_CHARGE_HINTS,
  RECEIPT_SUBJECT_RE, PAYMENT_SUBJECT_RE, NOT_A_PAYMENT_SUBJECT_RE, STRONG_BODY_RE,
  vendorSourceFor, type VendorSource,
} from "./receiptSources";
import { resolveSpendItem, findDuplicates, mergeFields, isSameCharge, copyQuality } from "./receiptMatch";
import { pullEmailDocument, type FetchedDocument, type PullResult } from "./receiptLinks";
import { relevanceOf, filingUnknownVendors } from "./receiptRelevance";
import { getMsImapToken, msBillingMailboxes } from "./msOauth";

/* ============================ types ============================ */

export type ReceiptKind = "charge" | "refund" | "credit_note";
/** Where a figure came from. `api` is the vendor's own billing API: authoritative on the
 *  number, but there is no invoice image behind it, and the console says so rather than
 *  drawing a receipt that was never issued. */
export type ReceiptSource = "email" | "manual" | "api" | "portal";

export interface Receipt {
  id: string;
  /** Billing month this charge belongs to, YYYY-MM. */
  period: string;
  /** Vendor as matched to the spend register, or as read off the receipt. */
  vendor: string;
  /** Spend register row, when one matched. */
  itemId?: string;
  /** What the vendor called the thing bought. */
  description?: string;
  amountUsd: number;
  currency: string;
  /** Amount in the invoice currency when it was not USD. */
  nativeAmount?: number;
  invoiceNumber?: string;
  /** ISO date the charge posted (the receipt's own date, not the email's, when stated). */
  chargedAt: string;
  kind: ReceiptKind;
  source: ReceiptSource;

  /* provenance: enough to find the original message again */
  mailbox?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  /** Processor that sent it on the vendor's behalf (paddle, stripe, paypal). */
  processor?: string;

  /* the artifact */
  /** Original attachment (PDF/image) when the receipt came as one. */
  fileName?: string;
  fileMime?: string;
  fileBytes?: number;
  /**
   * When the vendor did not attach the document but linked to it, the link that was
   * followed to get it. Kept so the same invoice can be opened again at the source, and
   * so a vendor whose link shape changes can be found and fixed.
   */
  documentUrl?: string;
  /** Which of the link shapes it turned out to be ("Stripe hosted invoice", …). */
  documentVia?: string;
  /** Why no document could be fetched, when the message linked to one and it failed. */
  documentError?: string;
  /** What the card was charged, when prepaid credit made that less than the cost. */
  amountPaidUsd?: number;
  creditAppliedUsd?: number;
  /** Recurring or one-off, read off the invoice rather than inferred from the wording. */
  cadence?: "recurring" | "one_time" | "mixed";
  recurringUsd?: number;
  oneTimeUsd?: number;
  /** A PNG of the receipt exists on disk (id.png) — this is what the console shows. */
  hasShot?: boolean;
  shotError?: string;
  /** Which renderer drew that PNG. See SHOT_VERSION: below it, the picture is re-drawn. */
  shotVersion?: number;
  /** Everything the parser read, kept verbatim so a wrong figure can be traced. */
  excerpt?: string;

  /** 0-1. Below CONFIDENT the row is shown as needing a look. */
  confidence: number;
  matchedBy?: string;
  /** Owner has eyeballed it. */
  reviewed?: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** One vendor's charge history is only trustworthy if the sweep itself is healthy. */
export interface SweepReport {
  at: string;
  mailbox: string;
  ok: boolean;
  error?: string;
  /** How far back this sweep looked. */
  since: string;
  scanned: number;
  billingCandidates: number;
  imported: number;
  duplicates: number;
  skippedNotCharge: number;
  unparsedAmount: number;
  shotsRendered: number;
  shotFailures: number;
  /** Documents fetched from a link in the message rather than an attachment. */
  documentsLinked: number;
  /** Real charges from senders that are not this company's vendors: personal spending
   *  in a personal mailbox, and the occasional genuinely-new vendor. Counted and SHOWN
   *  rather than dropped, so the second kind cannot hide among the first. */
  skippedNotOurs: number;
  otherSpend: Array<{ vendor: string; amountUsd: number; chargedAt: string; from: string }>;
  /** Receipts filed, per folder. A receipt rescued from Spam is worth knowing about:
   *  it means a vendor's mail is being filtered, which would otherwise read as a month
   *  with no charge in it. */
  byFolder: Record<string, number>;
  /** Messages that linked to a document which could not be fetched, with the reason. */
  documentFailures: Array<{ subject: string; from: string; reason: string }>;
  /** Messages that looked like billing but could not be turned into a row, with why. */
  rejects: Array<{ subject: string; from: string; date: string; reason: string }>;
}

interface ReceiptStore {
  receipts: Receipt[];
  sweeps: SweepReport[];
  /**
   * Invoice fingerprints the owner deleted by hand.
   *
   * The sweep's only reason to skip an email is a receipt already in the store carrying
   * its fingerprint, so a delete removed that reason along with the row and the next pull
   * filed the same invoice again. These are remembered instead, and only a deliberate
   * "Pull receipts from the mailbox" clears them.
   */
  dismissed?: string[];
  lastSweepAt?: string;
  /** Portal pullers, keyed by lowercased vendor. See PullerState. */
  pullers?: Record<string, PullerState>;
  /** When a puller sweep last reported in at all. */
  pullerReportAt?: string;
  /**
   * When the one-time "collapse every cell to a single receipt" cleanup last ran. Set the
   * first time the Spend master grid is loaded after the feature shipped, so a vault that a
   * wide sweep left with stacked cells self-cleans exactly ONCE — never again, so it can
   * never eat a second charge the owner re-adds by hand afterwards. The manual button
   * ignores this and can be pressed any number of times.
   */
  onePerCellRunAt?: string;
  /** When the one-time "purge marketing filed as receipts" cleanup ran (same one-shot
   *  pattern: first grid load after it shipped, then never again). */
  junkPurgeRunAt?: string;
}

const SNAP_KEY = "owner_spend_receipts_v1";
const store: ReceiptStore = { receipts: [], sweeps: [], pullers: {}, dismissed: [] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureReceiptsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<ReceiptStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s && Array.isArray(s.receipts)) store.receipts = s.receipts;
        if (s && Array.isArray(s.sweeps)) store.sweeps = s.sweeps;
        if (s && Array.isArray(s.dismissed)) store.dismissed = s.dismissed;
        if (s?.lastSweepAt) store.lastSweepAt = s.lastSweepAt;
        if (s?.pullers) store.pullers = s.pullers;
        if (s?.pullerReportAt) store.pullerReportAt = s.pullerReportAt;
        if (s?.onePerCellRunAt) store.onePerCellRunAt = s.onePerCellRunAt;
        if (s?.junkPurgeRunAt) store.junkPurgeRunAt = s.junkPurgeRunAt;
      })
      .catch(() => {});
  }
  return hydrated;
}
void ensureReceiptsReady();

/* ============================ files on disk ============================ */

/** Durable dir for receipt artifacts. Mirrors the roleShot convention. */
function receiptsDir(): string {
  const base = process.env.ROS_DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : join(process.cwd(), ".data"));
  return join(base, "receipts");
}

async function saveArtifact(id: string, ext: string, bytes: Buffer): Promise<void> {
  const dir = receiptsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.${ext}`), bytes);
}

/** Read one artifact: "png" (the screenshot), "thumb.png", or "file" (the original). */
export async function readReceiptArtifact(
  id: string,
  which: "png" | "thumb" | "file",
): Promise<{ bytes: Buffer; mime: string } | null> {
  await ensureReceiptsReady();
  const r = store.receipts.find((x) => x.id === id);
  if (!r) return null;
  const dir = receiptsDir();
  try {
    if (which === "png") return { bytes: await readFile(join(dir, `${id}.png`)), mime: "image/png" };
    if (which === "thumb") {
      try { return { bytes: await readFile(join(dir, `${id}.thumb.png`)), mime: "image/png" }; }
      catch { return { bytes: await readFile(join(dir, `${id}.png`)), mime: "image/png" }; }
    }
    const ext = extFromMime(r.fileMime || "", r.fileName || "");
    return { bytes: await readFile(join(dir, `${id}.src.${ext}`)), mime: r.fileMime || "application/octet-stream" };
  } catch {
    return null;
  }
}

function extFromMime(mime: string, name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  if (m) return m[1].toLowerCase();
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
}

/* ============================ rendering the receipt ============================ */

/**
 * The renderer that drew a picture. Bump it whenever a change makes the picture materially
 * better, and every receipt below it is re-drawn from the document still on disk by the
 * repair pass — nothing has to be fetched from the vendor again.
 *
 * 2: draw at the screen's real pixels. Version 1 rendered each PDF page into a canvas whose
 *    backing store was SMALLER than the device pixels the screenshot then captured, so
 *    Chromium magnified every invoice ~2x on the way out and 8pt invoice type came back as
 *    mush. The picture was always a blow-up of a half-size drawing, which is why zooming in
 *    on it never helped.
 */
export const SHOT_VERSION = 2;

/** CSS size of the render surface, and its device-pixel ratio. */
const SHOT_WIDTH = 900;
const SHOT_HEIGHT = 1200;
const SHOT_DPR = 2;
/**
 * Device pixels across one rendered PDF page. A US Letter page is 612pt wide, so 1800px is
 * ~210 DPI: enough that the line items on an invoice stay sharp when the viewer zooms in,
 * without writing a 20MB PNG for a one-page receipt.
 */
const PDF_TARGET_PX = 1800;
const PDF_MAX_PAGES = 4;

/**
 * Turn a receipt into a PNG the owner can actually look at. Three inputs, in order of
 * fidelity: an image attachment (already a picture), a PDF attachment (rendered page 1
 * through pdf.js inside the same headless Chromium the role screenshots use), or the
 * email's own HTML body (which is what most processors send).
 *
 * A render failure is recorded on the row rather than dropping the receipt: the money is
 * still counted, the console just says the picture is missing and why.
 */
async function renderShot(
  id: string,
  input: { html?: string; text?: string; pdf?: Buffer; image?: { bytes: Buffer; mime: string } },
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (input.image) {
      await saveArtifact(id, "png", await toPng(input.image.bytes));
      await makeThumb(id);
      return { ok: true };
    }
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT }, deviceScaleFactor: SHOT_DPR });

      if (input.pdf) {
        await renderPdfPage(page, input.pdf);
      } else {
        // Receipts are self-contained; block outbound fetches so a dead tracking pixel or a
        // blocked CDN can never hang the render. Inline and data: images still show.
        await page.route("**/*", (route) => {
          const u = route.request().url();
          return u.startsWith("data:") || u.startsWith("about:") ? route.continue() : route.abort();
        });
        const html = input.html
          ? input.html
          : `<pre style="white-space:pre-wrap;font:13px/1.6 ui-monospace,Menlo,monospace;padding:28px">${escapeHtml(input.text || "")}</pre>`;
        await page.setContent(
          `<!doctype html><meta charset="utf-8"><style>
             body{margin:0;background:#fff;color:#111;font:14px/1.55 -apple-system,Segoe UI,Inter,Arial,sans-serif}
             img{max-width:100%}table{max-width:100%}
           </style><div id="rcpt" style="padding:24px;max-width:852px">${html}</div>`,
          { waitUntil: "domcontentloaded", timeout: 20_000 },
        );
        await fillFrame(page);
      }
      /* fullPage grows the shot to the content but never SHRINKS it below the viewport, so a
         two-line payment confirmation used to come back as a stamp at the top of a page of
         white — and "fit the width" then fits mostly nothing. Clip to what was actually
         drawn whenever that is shorter. */
      const drawn = await contentHeight(page);
      const png = drawn && drawn < SHOT_HEIGHT
        ? await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SHOT_WIDTH, height: drawn } })
        : await page.screenshot({ fullPage: true, type: "png" });
      await saveArtifact(id, "png", Buffer.from(png));
      await makeThumb(id);
      await page.close().catch(() => {});
      return { ok: true };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message?.slice(0, 200) || "render failed" };
  }
}

/**
 * Draw a PDF invoice into the page with pdf.js.
 *
 * The library is read off disk and SERVED to the page rather than imported, so the bundler
 * never sees it (the app already treats pdfjs as an external package for the same reason).
 * The page is given a real https origin that exists only inside the route interception:
 * an `about:blank` document cannot resolve a module URL or start a worker, which is exactly
 * how the first version of this failed. Nothing leaves the machine — every request on that
 * origin is fulfilled from memory and everything else is aborted.
 */
const PDF_ORIGIN = "https://receipt.local";

/**
 * `require` as seen from the app root, for reading pdf.js off disk.
 *
 * THIS IS WHY EVERY PDF INVOICE SHOWED "no image". The obvious spelling —
 * `const { createRequire } = await import("node:module")` — silently yields `undefined` in
 * the compiled server bundle. Webpack builds the namespace object for an external by
 * copying the export's own property names, and that loop only runs when the export is an
 * OBJECT. `node:module` exports the Module *function*, so nothing is copied and the
 * namespace has exactly one key: `default`. Destructuring got undefined, calling it threw
 * "x is not a function", and `renderShot` recorded that as a render failure on every single
 * PDF receipt while the document itself sat perfectly readable on disk.
 *
 * So: read it off `default` when the namespace is bare. Any `await import()` of a module
 * whose export is a function — `node:module`, `sharp` — has the same trap, and the fix is
 * always to go through `default`.
 */
type CreateRequire = (path: string) => NodeRequire;

async function appRequire(): Promise<NodeRequire> {
  const ns = (await import("node:module")) as unknown as
    { createRequire?: CreateRequire; default?: { createRequire?: CreateRequire } };
  const createRequire =
    typeof ns.createRequire === "function" ? ns.createRequire
      : typeof ns.default?.createRequire === "function" ? ns.default.createRequire
        : null;
  if (!createRequire) throw new Error("node:module.createRequire unavailable in this runtime");
  return createRequire(join(process.cwd(), "noop.js"));
}

async function renderPdfPage(page: import("playwright").Page, pdf: Buffer): Promise<void> {
  // Resolve from the app root rather than import.meta.url: the compiled server bundle is
  // CJS, where import.meta is not available.
  const require_ = await appRequire();
  const pdfPath = require_.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const workerPath = require_.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const [lib, worker] = await Promise.all([readFile(pdfPath, "utf8"), readFile(workerPath, "utf8")]);

  /*
   * THE CANVAS IS DRAWN IN DEVICE PIXELS AND LAID OUT IN CSS PIXELS, AND THE TWO ARE NOT THE
   * SAME NUMBER. The page is captured at deviceScaleFactor 2, so a canvas given a CSS width
   * equal to its own backing store is photographed at twice the resolution it was drawn at —
   * Chromium interpolates, and a crisp vector invoice comes out of the pipe as a blur that no
   * amount of zooming can recover. So: draw the page at `scale` (its backing store), then
   * pin the element's CSS width to `scale / DPR` of it. One drawn pixel, one captured pixel.
   */
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">
     <div id="pages"></div>
     <script type="module">
       import * as pdfjs from './pdf.mjs';
       const TARGET = ${PDF_TARGET_PX}, DPR = ${SHOT_DPR}, MAX = ${PDF_MAX_PAGES};
       try {
         pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';
         const doc = await pdfjs.getDocument({ url: './doc.pdf' }).promise;
         const host = document.getElementById('pages');
         for (let n = 1; n <= Math.min(doc.numPages, MAX); n++) {
           const p = await doc.getPage(n);
           /* Scale off this page's own size: an A4 invoice, a Letter one and the odd
              half-height receipt all land at the same readable width. */
           const base = p.getViewport({ scale: 1 });
           const scale = Math.max(1.5, Math.min(4, TARGET / base.width));
           const vp = p.getViewport({ scale });
           const c = document.createElement('canvas');
           c.width = Math.round(vp.width);
           c.height = Math.round(vp.height);
           c.style.display = 'block';
           c.style.width = (c.width / DPR) + 'px';
           c.style.height = (c.height / DPR) + 'px';
           if (n > 1) c.style.marginTop = '10px';
           host.appendChild(c);
           await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
         }
         document.title = 'ready';
       } catch (e) { document.title = 'failed: ' + (e && e.message); }
     </script></body>`;

  /* ONE handler for every request. Two overlapping route globs is what made the first
     attempt fall through to a real DNS lookup for receipt.local: the catch-all matched,
     continued, and the request left the machine. Nothing here ever continues. */
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith(PDF_ORIGIN)) return route.abort();
    const path = new URL(url).pathname;
    if (path === "/" || path === "/index.html") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    if (path === "/pdf.mjs") return route.fulfill({ contentType: "text/javascript", body: lib });
    if (path === "/pdf.worker.mjs") return route.fulfill({ contentType: "text/javascript", body: worker });
    if (path === "/doc.pdf") return route.fulfill({ contentType: "application/pdf", body: pdf });
    return route.abort();
  });

  await page.goto(`${PDF_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForFunction("document.title === 'ready' || document.title.startsWith('failed')", null, { timeout: 30_000 });
  const title = await page.title();
  if (title.startsWith("failed")) throw new Error(title);
}

/**
 * Most emailed receipts are a 600px-wide table, which leaves a third of the frame white and
 * spends only two thirds of the pixels on the receipt itself. Scaling the page up before the
 * capture re-lays the text out at the larger size — it is drawn bigger, not blown up, so it
 * gets sharper rather than softer. Capped at 1.6x: past that a narrow receipt starts to look
 * like a poster, and a receipt already using the full width is left alone.
 */
async function fillFrame(page: import("playwright").Page): Promise<void> {
  try {
    const width = await page.evaluate(() => {
      const host = document.getElementById("rcpt");
      if (!host) return 0;
      let w = 0;
      for (const el of Array.from(host.querySelectorAll<HTMLElement>("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width > w && r.height > 0) w = r.width;
      }
      return Math.round(Math.max(w, host.getBoundingClientRect().width * 0.4));
    });
    if (!width || width <= 0) return;
    const zoom = Math.min(1.6, (SHOT_WIDTH - 48) / width);
    if (zoom <= 1.02) return;
    await page.evaluate((z) => { document.body.style.zoom = String(z); }, zoom);
    /* One frame for the re-layout to settle before the shutter. */
    await page.waitForTimeout(120);
  } catch { /* the unscaled render is still a perfectly good picture */ }
}

/** How tall the drawn receipt actually is, in CSS pixels. 0 when it cannot be measured. */
async function contentHeight(page: import("playwright").Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const b = document.body, d = document.documentElement;
      /* The rendered thing itself when there is one (a canvas stack, or the receipt wrapper),
         so a stray margin on the body does not add a strip of white to every receipt. */
      const host = document.getElementById("rcpt") || document.getElementById("pages");
      const own = host ? Math.ceil(host.getBoundingClientRect().bottom) : 0;
      return Math.max(own, 0) || Math.ceil(Math.max(b.scrollHeight, d.scrollHeight));
    });
  } catch {
    return 0;
  }
}

async function toPng(bytes: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(bytes).png().toBuffer();
  } catch {
    return bytes;
  }
}

/**
 * Small version for the month grid, so a 40-cell matrix is not 40 full-size PNGs. Wide
 * enough (640) that a tile face is still sharp on a retina screen, where a 190px tile is
 * 380 real pixels and the old 420px thumb was being stretched to cover it.
 */
async function makeThumb(id: string): Promise<void> {
  try {
    const sharp = (await import("sharp")).default;
    const dir = receiptsDir();
    const src = await readFile(join(dir, `${id}.png`));
    const out = await sharp(src).resize({ width: 640, withoutEnlargement: true }).png({ quality: 90 }).toBuffer();
    await writeFile(join(dir, `${id}.thumb.png`), out);
  } catch { /* thumb is an optimisation; the full PNG is the fallback */ }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

/* ==================== repairing receipts that lost their picture ==================== */

export interface ShotRepair {
  checked: number;
  /** Rendered from the vendor's own document on this run. */
  rendered: number;
  /** Picture already on disk. */
  alreadyOk: number;
  /** No document to render: an API figure, or an email whose body was never kept. */
  noSource: number;
  failed: number;
  failures: Array<{ id: string; vendor: string; period: string; error: string }>;
}

/**
 * Give every receipt back the picture of its own document.
 *
 * A render can fail long after the document is safely filed — a bad bundle (see
 * `appRequire`), a missing Chromium, a PDF that took too long — and when it does the row
 * says "no image" forever, because nothing ever looked at it again. The document is still
 * sitting in `/data/receipts/<id>.src.<ext>`, so the picture is always recoverable: this
 * walks the vault, finds every receipt whose document is on disk but whose PNG is not, and
 * renders it from that document. The console then shows the vendor's real invoice, not a
 * placeholder.
 *
 * It also settles `hasShot` against what is actually on disk in both directions, so the
 * flag can never claim a picture that is not there or hide one that is. Safe to run on
 * every tick: a receipt with its PNG in place costs one `stat`.
 *
 * A picture drawn by a renderer older than SHOT_VERSION is treated the same as a missing
 * one, so a quality fix reaches receipts filed months ago without anyone going back to the
 * vendor for the document a second time.
 */
export async function renderMissingShots(opts?: { force?: boolean; limit?: number }): Promise<ShotRepair> {
  await ensureReceiptsReady();
  const dir = receiptsDir();
  const limit = Math.max(1, Math.min(500, opts?.limit || 200));
  const out: ShotRepair = { checked: 0, rendered: 0, alreadyOk: 0, noSource: 0, failed: 0, failures: [] };
  let changed = false;

  for (const r of store.receipts) {
    if (out.rendered + out.failed >= limit) break;
    out.checked += 1;

    const hasPng = await fileSize(join(dir, `${r.id}.png`)) > 0;
    /* A picture drawn by an older renderer counts as missing: the document is still on disk,
       so it is re-drawn at the current quality rather than left blurry forever. */
    const current = (r.shotVersion || 0) >= SHOT_VERSION;
    if (hasPng && current && !opts?.force) {
      if (!r.hasShot) { r.hasShot = true; r.shotError = undefined; r.updatedAt = nowIso(); changed = true; }
      /* A PNG with no thumb happens when the thumbnailer failed on its own; the grid falls
         back to the full image, but it is 40 full-size PNGs, so mend it while we are here. */
      if (await fileSize(join(dir, `${r.id}.thumb.png`)) === 0) await makeThumb(r.id);
      out.alreadyOk += 1;
      continue;
    }

    const src = await readSourceDocument(r, dir);
    if (!src) {
      /* Nothing to draw from. An old picture already on disk STAYS: it is worse than a fresh
         render and better than nothing, and wiping the flag here would blank a receipt that
         the owner can see perfectly well. It comes back the day the document is attached. */
      if (!!r.hasShot !== hasPng) { r.hasShot = hasPng; r.updatedAt = nowIso(); changed = true; }
      out.noSource += 1;
      continue;
    }

    const shot = await renderShot(r.id, shotInputFor(src));
    r.hasShot = shot.ok;
    r.shotError = shot.error;
    if (shot.ok) r.shotVersion = SHOT_VERSION;
    r.updatedAt = nowIso();
    changed = true;
    if (shot.ok) out.rendered += 1;
    else {
      out.failed += 1;
      out.failures.push({ id: r.id, vendor: r.vendor, period: r.period, error: shot.error || "render failed" });
    }
  }

  if (changed) persist();
  return out;
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

/**
 * The original document for a receipt, off disk. The recorded mime/name is tried first,
 * then every extension the vault writes: a row whose `fileMime` was never set (an early
 * puller push) still has its PDF sitting there under a predictable name.
 */
async function readSourceDocument(
  r: Receipt, dir: string,
): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  const exts: string[] = [];
  if (r.fileMime || r.fileName) exts.push(extFromMime(r.fileMime || "", r.fileName || ""));
  for (const e of ["pdf", "png", "jpg", "jpeg", "webp", "html", "htm", "txt", "bin"]) {
    if (!exts.includes(e)) exts.push(e);
  }
  for (const ext of exts) {
    try {
      const bytes = await readFile(join(dir, `${r.id}.src.${ext}`));
      if (bytes.length) return { bytes, mime: r.fileMime || mimeFromExt(ext), name: r.fileName || `receipt.${ext}` };
    } catch { /* next extension */ }
  }
  return null;
}

function mimeFromExt(ext: string): string {
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "txt") return "text/plain";
  return "application/octet-stream";
}

/** Pick the render input a document deserves. Same ladder the portal push uses. */
function shotInputFor(file: { bytes: Buffer; mime: string; name: string }) {
  const isPdf = file.mime.includes("pdf") || /\.pdf$/i.test(file.name);
  const isImage = file.mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  const isHtml = file.mime.includes("html") || /\.html?$/i.test(file.name);
  if (isPdf) return { pdf: file.bytes };
  if (isImage) return { image: { bytes: file.bytes, mime: file.mime } };
  if (isHtml) return { html: file.bytes.toString("utf8") };
  return { text: file.bytes.toString("utf8").slice(0, 20_000) };
}

/* ============================ parsing a receipt ============================ */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Currency symbol / code -> ISO code. */
const CURRENCIES: Array<[RegExp, string]> = [
  [/US\$|\$|USD/i, "USD"], [/€|EUR/i, "EUR"], [/£|GBP/i, "GBP"], [/₹|INR/i, "INR"], [/CA\$|CAD/i, "CAD"],
];

/**
 * Rough conversion so a EUR invoice still lands in a USD total instead of being dropped.
 * Deliberately a constant, and flagged on the row: an approximate figure that is visibly
 * approximate beats a missing month.
 */
const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, INR: 0.012 };

export interface ParsedReceipt {
  amount: number;
  currency: string;
  amountUsd: number;
  approxFx: boolean;
  chargedAt?: string;
  period?: string;
  invoiceNumber?: string;
  description?: string;
  kind: ReceiptKind;
  /** Per-line breakdown when the receipt itemises (RapidAPI/Hetzner style). */
  lines: Array<{ label: string; amountUsd: number }>;
}

/**
 * Read the money out of a receipt body. The winning figure is the one nearest a total
 * phrase ("amount paid", "total", "you paid"); a bare largest-number heuristic is the last
 * resort, and it lowers the row's confidence so the console asks for a look.
 */
export function parseReceiptText(raw: string): ParsedReceipt | null {
  const text = raw.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const low = text.toLowerCase();

  /* A refund has to be STATED, not merely mentioned: "Refund Policy" in an order email's
     footer is not a refund, and treating it as one filed real GoDaddy and Namecheap orders
     as negative amounts. */
  const kind: ReceiptKind = /credit note/i.test(low)
    ? "credit_note"
    : /your refund|refund (?:issued|processed|completed|confirmation|receipt|of\s*[$€£])|has been refunded|we(?:'ve| have) refunded|was refunded|amount refunded|payment reversal/i.test(low)
      ? "refund"
      : "charge";

  /* --- amount --- */
  const TOTAL_PHRASES = [
    "amount paid", "total paid", "you paid", "amount charged", "total charged", "payment received",
    "grand total", "total due", "amount due", "invoice total", "order total", "total amount", "total",
    "amount",
  ];
  const moneyRe = /(US\$|\$|€|£|₹|USD|EUR|GBP|CAD|INR)\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{2}))\s?(USD|EUR|GBP|CAD|INR)/gi;
  interface Cand { value: number; currency: string; index: number; score: number }
  const cands: Cand[] = [];
  let m: RegExpExecArray | null;
  while ((m = moneyRe.exec(text))) {
    const symbol = (m[1] || m[4] || "$").toString();
    const numStr = (m[2] || m[3] || "").replace(/,/g, "");
    const value = Number(numStr);
    if (!Number.isFinite(value) || value <= 0) continue;
    let currency = "USD";
    for (const [re, code] of CURRENCIES) if (re.test(symbol)) { currency = code; break; }
    // Score by how close a total phrase sits in front of the figure.
    const before = low.slice(Math.max(0, m.index - 60), m.index);
    let score = 0;
    TOTAL_PHRASES.forEach((p, rank) => { if (before.includes(p)) score = Math.max(score, TOTAL_PHRASES.length - rank); });
    cands.push({ value, currency, index: m.index, score });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.value - a.value);
  const best = cands[0];
  const fx = FX_TO_USD[best.currency] ?? 1;

  /* --- itemised lines: "Serper API $50.00", "JSearch (Ultra) $75.00" --- */
  const lines: ParsedReceipt["lines"] = [];
  for (const ln of text.split("\n")) {
    const lm = /^\s*(.{3,60}?)\s+(?:US\$|\$|€|£)\s?([0-9][0-9,]*(?:\.[0-9]{2})?)\s*$/.exec(ln);
    if (!lm) continue;
    const label = lm[1].trim();
    if (/^(total|subtotal|amount|sales tax|tax|vat|balance|payment)/i.test(label)) continue;
    const v = Number(lm[2].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0) lines.push({ label, amountUsd: round2(v * fx) });
  }

  /* --- date: prefer the receipt's own stated date over the email's --- */
  const chargedAt = parseDateNear(text, ["receipt date", "invoice date", "date paid", "payment date", "date of issue", "billed on", "date"]) || undefined;

  /* --- explicit service period, e.g. "Jul 1, 2026 – Jul 31, 2026" --- */
  let period: string | undefined;
  const pm = /(?:service period|billing period|period|for the period)[:\s]*([a-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i.exec(text);
  if (pm) period = isoMonth(parseLooseDate(pm[1]) || "");
  if (!period && chargedAt) period = chargedAt.slice(0, 7);

  /* --- receipt / invoice number --- */
  const inv = /(?:receipt|invoice|order|transaction)\s*(?:#|no\.?|number|id)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9._-]{3,40})/i.exec(text);

  /* --- what was bought --- */
  const desc = lines.length ? lines[0].label : undefined;

  return {
    amount: best.value,
    currency: best.currency,
    amountUsd: round2(best.value * fx),
    approxFx: best.currency !== "USD",
    chargedAt,
    period,
    invoiceNumber: inv ? inv[1] : undefined,
    description: desc,
    kind,
    lines,
  };
}

/** Find a date written near one of the given labels, else the first date in the text. */
function parseDateNear(text: string, labels: string[]): string | null {
  const low = text.toLowerCase();
  for (const label of labels) {
    let idx = low.indexOf(label);
    while (idx >= 0) {
      const chunk = text.slice(idx, idx + 120);
      const d = firstDate(chunk);
      if (d) return d;
      idx = low.indexOf(label, idx + 1);
    }
  }
  return firstDate(text.slice(0, 4000));
}

function firstDate(s: string): string | null {
  const pats = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{4})\b/,          // 30th July 2026
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/,     // July 30, 2026
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,                                   // 07/30/2026
  ];
  for (let i = 0; i < pats.length; i++) {
    const m = pats[i].exec(s);
    if (!m) continue;
    if (i === 0) return `${m[1]}-${m[2]}-${m[3]}`;
    if (i === 1) { const mo = MONTHS.indexOf(m[2].toLowerCase()); if (mo >= 0) return ymd(Number(m[3]), mo + 1, Number(m[1])); }
    if (i === 2) { const mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))); if (mo >= 0) return ymd(Number(m[3]), mo + 1, Number(m[2])); }
    if (i === 3) return ymd(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  return null;
}
function parseLooseDate(s: string): string | null { return firstDate(s); }
function ymd(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function isoMonth(d: string): string | undefined { return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : undefined; }
/** YYYY-MM-DD plus n days, UTC, for sanity-bounding parsed dates against the mail's own date. */
function addDays(day: string, n: number): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/* ============================ classifying + matching ============================ */

export interface MailMessage {
  subject: string;
  from: string;
  fromName?: string;
  date: string;
  messageId?: string;
  text: string;
  html?: string;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}

/** Is this message a paid charge, and if not, why not.
 *
 * ⚠️ THE SUBJECT TEST MUST NEVER LOOK AT THE SENDER ADDRESS. The old haystack was
 * subject + fromName + from, and every vendor's hint list starts with its own name — so
 * EVERY mail from linkedin.com contained "linkedin", every mail from tidycal.com contained
 * "tidycal", and one nightly sweep filed 165 job alerts, Prime Day promotions and AppSumo
 * deal blasts as vendor charges (a $100,000 salary in a job title became a $100,000
 * LinkedIn receipt). A vendor's name on a message only says who SENT it; whether it is a
 * RECEIPT has to be said by receipt words, and those live in the subject and body alone.
 */
export function classify(msg: MailMessage): { billing: boolean; reason?: string } {
  const subject = (msg.subject || "").toLowerCase();
  /* fromName rides along for the veto only: "LinkedIn Job Alerts" in a display name is a
     reason to doubt a message, never a reason to file one. */
  const subjectHay = `${subject} ${(msg.fromName || "").toLowerCase()}`;
  /* Read the HTML too, stripped to text. Most vendor receipts — registrars especially —
     are HTML-only, so looking at msg.text alone saw an EMPTY body and skipped a mail whose
     whole receipt (the $ line items, the total) was sitting in the markup. That one omission
     is why every Dynadot "Order Finished" was invisible. */
  const body = `${msg.text || ""} ${stripHtml(msg.html || "")}`.toLowerCase().slice(0, 8000);
  for (const bad of NON_CHARGE_HINTS) {
    if (subjectHay.includes(bad)) return { billing: false, reason: `not a charge: subject says "${bad}"` };
  }
  /* An invoice being generated/issued is not money moving; the payment confirmation for
     the same charge follows and is the one that files. Counting both double-bills the
     month, and counting an invoice that is never paid books money that never left. */
  if (NOT_A_PAYMENT_SUBJECT_RE.test(msg.subject || "")) {
    return { billing: false, reason: "an invoice being issued, not a payment; the payment confirmation is the charge" };
  }
  const domain = (msg.from.split("@")[1] || "").toLowerCase();
  const from = msg.from.toLowerCase();
  const vendorSrc = VENDOR_SOURCES.find((s) => s.from.some((f) => domain === f || domain.endsWith("." + f) || from === f));
  const processorHit = PROCESSOR_DOMAINS.some((p) => domain === p || domain.endsWith("." + p));
  /* A sender we KNOW bills us: one of our vendors, or a payment processor. */
  const known = !!vendorSrc || processorHit;

  /* A subject that STATES a completed charge: "Your receipt from…", "Invoice 086…",
     "Order Received", "Payment Confirmation", "Order - Thank You". This is the signal that
     files. Whether the vendor is one of OURS is a separate question that relevanceOf
     answers afterwards, so a personal order still classifies as billing here and is then
     reported as a stranger instead of filed. */
  const subjectStrong = RECEIPT_SUBJECT_RE.test(msg.subject || "") || PAYMENT_SUBJECT_RE.test(msg.subject || "");
  /* Body phrases that state a completed charge — NOT bare "receipt"/"invoice", which any
     marketing email about a billing product also contains. */
  const bodyStrong = STRONG_BODY_RE.test(body);
  /* The vendor's own document, attached: a PDF, or a file named like a receipt/invoice, IS
     a receipt on its own — this is the "actually has an invoice attached" half of the rule. */
  const hasInvoiceDoc = (msg.attachments || []).some((a) => {
    const name = (a.filename || "").toLowerCase();
    const type = (a.contentType || "").toLowerCase();
    return type.includes("pdf") || name.endsWith(".pdf") || /receipt|invoice|statement|order/.test(name);
  });
  /* Weak corroboration for a known sender carrying a document: generic billing vocabulary
     in the SUBJECT (not the sender), or this vendor's own words minus its identity — a
     vendor's name and merchant strings are excluded because they are on every mail it
     sends, receipts and newsletters alike. */
  const identity = new Set(
    [vendorSrc?.vendor || "", ...(vendorSrc?.merchant || [])].map((s) => s.toLowerCase()).filter(Boolean),
  );
  const weakHit =
    GENERIC_SUBJECT_HINTS.some((h) => subject.includes(h)) ||
    (vendorSrc ? vendorSrc.subject.some((h) => !identity.has(h) && subject.includes(h)) : false);

  if (subjectStrong) return { billing: true };
  /* A known biller whose body states the charge ("Amount paid $50.00", "Order Total") —
     but only when the SUBJECT carries a billing word too. A known sender's body alone is
     not enough, because known senders relay other people's words: a forwarded LinkedIn
     InMail quoting a demand letter's "Total Paid: $11,900" filed itself as an $11,900
     LinkedIn charge on exactly this rung. */
  if (known && bodyStrong && weakHit) return { billing: true };
  /* A known biller that attached the invoice itself, with at least a billing word in the
     subject: the document is the receipt. */
  if (known && hasInvoiceDoc && (weakHit || bodyStrong)) return { billing: true };
  /* An unknown sender needs the strong subject AND a body that agrees. */
  if (weakHit && bodyStrong) return { billing: true };
  const hasMoney = /(?:us\$|\$|€|£|₹)\s?\d[\d,]*(?:[.,]\d{1,2})?|\d[\d,]*[.,]\d{2}\s?(?:usd|eur|gbp|cad|inr)/i.test(body);
  return {
    billing: false,
    reason: hasMoney
      ? "carries a dollar amount but nothing states a completed charge; marketing and notices carry prices too"
      : "no billing signal in subject, sender or body",
  };
}

/**
 * Is this vendor's name actually SAID in the message, as a word?
 *
 * ⚠️ THIS WAS A PLAIN `includes()` AND IT PUT PHANTOM CHARGES IN THE BOOKS. "aws" is a
 * substring of draws, laws, saws and flaws; "resend" of "please resend"; "hume" of
 * humectant. A marketing email full of the word "draws" was filed as an AWS invoice for
 * $50,000, a Gusto payroll notice became a LinkedIn charge for $1,206.33, and a Wise
 * email became AWS for $122. Every one of them then passed the relevance filter, because
 * AWS and LinkedIn ARE real vendors here - the vendor was real, the charge was not.
 *
 * So: word boundaries, and a floor on how short a name may be before a body mention
 * counts at all. A three-letter acronym in running text is not evidence of anything, and
 * a vendor whose name is that short has to be identified by the sender domain or by the
 * merchant name on a processor receipt, both of which are checked before this.
 */
const MIN_NAMED_LEN = 4;

export function namedIn(hay: string, name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  if (n.length < MIN_NAMED_LEN) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /* \b does not fire next to a dot or a plus, so "serper.dev" and "sending.ac" would
     never match with a bare \b on both ends. Anchor on a non-word character instead. */
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
}

export interface VendorMatch {
  vendor: string;
  itemId?: string;
  processor?: string;
  confidence: number;
  matchedBy: string;
}

/**
 * Work out who was actually paid. Sender domain is the strongest signal; a processor
 * receipt names the merchant in the display name ("Serper (via Paddle.com)") or the body
 * ("Receipt from Serper"); failing both, look for a register vendor named anywhere in the
 * message. An unmatched charge is still recorded — an uncatalogued vendor is exactly the
 * thing this report exists to surface.
 */
export function matchVendor(
  msg: MailMessage,
  items: SpendItem[],
  charge: { amountUsd?: number; period?: string; description?: string } = {},
): VendorMatch {
  const domain = (msg.from.split("@")[1] || "").toLowerCase();
  const hay = `${charge.description || ""} ${msg.subject} ${msg.fromName || ""} ${msg.text || ""}`.toLowerCase();
  const processor = PROCESSOR_DOMAINS.find((p) => domain === p || domain.endsWith("." + p));

  const bind = (vendor: string, confidence: number, matchedBy: string): VendorMatch => {
    const item = pickItem(vendor, hay, items, charge.amountUsd, charge.period);
    return { vendor, itemId: item?.id, processor, confidence, matchedBy };
  };

  if (!processor) {
    const direct = VENDOR_SOURCES.find((s) => s.from.some((f) => domain === f || domain.endsWith("." + f)));
    if (direct) return bind(direct.vendor, 0.95, `sender domain ${domain}`);
  }

  // "Serper (via Paddle.com)" / "Receipt from Serper" / "your Serper subscription"
  const viaName = /^(.+?)\s*\(via\s+[^)]+\)\s*$/i.exec(msg.fromName || "");
  const receiptFrom = /receipt from ([a-z0-9][a-z0-9 .&-]{1,40})/i.exec(msg.subject) || /receipt from ([a-z0-9][a-z0-9 .&-]{1,40})/i.exec(msg.text || "");
  const named = (viaName?.[1] || receiptFrom?.[1] || "").trim();
  if (named) {
    const src = VENDOR_SOURCES.find((s) =>
      s.vendor.toLowerCase() === named.toLowerCase() ||
      (s.merchant || []).some((mm) => named.toLowerCase().includes(mm)));
    if (src) return bind(src.vendor, 0.9, `merchant "${named}" via ${processor || "receipt"}`);
    const reg = items.find((i) => i.vendor.toLowerCase() === named.toLowerCase());
    if (reg) return bind(reg.vendor, 0.85, `merchant "${named}"`);
    return { vendor: titleCase(named), processor, confidence: 0.55, matchedBy: `merchant "${named}", no register row` };
  }

  const bySrc = VENDOR_SOURCES.find((s) => (s.merchant || []).some((mm) => namedIn(hay, mm)) || namedIn(hay, s.vendor));
  if (bySrc) return bind(bySrc.vendor, 0.7, `vendor named in the message`);

  const byReg = items.find((i) => namedIn(hay, i.vendor));
  if (byReg) return bind(byReg.vendor, 0.6, "register vendor named in the message");

  const fallback = domain.split(".").slice(-2)[0] || "Unknown";
  return { vendor: titleCase(fallback), processor, confidence: 0.3, matchedBy: `unrecognised sender ${domain}` };
}

/**
 * A vendor can own several register rows (RapidAPI owns five, one per listing, each billed
 * separately). Which row a charge belongs to is decided by `resolveSpendItem`: the name
 * the vendor printed on the invoice against the names we hold for each row, with the price
 * as the tie-break.
 *
 * It returns nothing when the charge does not clearly belong to any of them, and that is
 * the point: an unattached charge is reported as spend with no line item behind it, which
 * is true. The previous rule handed an ambiguous charge to the most expensive active row,
 * which quietly credited one listing with another listing's money.
 */
function pickItem(vendor: string, hay: string, items: SpendItem[], amountUsd?: number, period?: string): SpendItem | undefined {
  return resolveSpendItem({ vendor, hay, amountUsd, period }, items)?.item;
}

function titleCase(s: string): string {
  return s.replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/* ============================ the mailbox ============================ */

export interface MailboxCfg {
  user: string; pass: string; host: string; port: number; label: string; inherited?: boolean;
  /** Authenticate with an OAuth2 access token (XOAUTH2) instead of a password. Set for
   *  Microsoft 365 work mailboxes, where basic-auth IMAP is disabled and only OAuth works. */
  oauth?: boolean;
}

function guessHost(user: string): string {
  const d = (user.split("@")[1] || "").toLowerCase();
  if (d === "gmail.com" || d === "googlemail.com") return "imap.gmail.com";
  if (["outlook.com", "hotmail.com", "live.com", "office365.com"].includes(d)) return "outlook.office365.com";
  if (d === "yahoo.com") return "imap.mail.yahoo.com";
  return d ? "outlook.office365.com" : "";
}

/**
 * Which mailboxes to sweep. BILLING_INBOX_* is the dedicated one; up to three more can be
 * numbered (BILLING_INBOX_2_USER…). With none configured it falls back to the resume
 * inbox's credentials, because that mailbox (ryan@lumesp.com) is where the vendor receipts
 * already land — the fallback is read-only and never deletes, so sharing it is safe.
 */
export function billingMailboxes(): MailboxCfg[] {
  const out: MailboxCfg[] = [];
  const add = (user: string, pass: string, host: string, port: string, inherited = false) => {
    if (!user || !pass) return;
    const h = host || guessHost(user);
    if (!h) return;
    if (out.some((x) => x.user.toLowerCase() === user.toLowerCase())) return;
    out.push({ user, pass, host: h, port: Number(port) || 993, label: user, inherited });
  };
  const E = process.env;
  add(E.BILLING_INBOX_USER || "", E.BILLING_INBOX_PASS || "", E.BILLING_INBOX_HOST || "", E.BILLING_INBOX_PORT || "");
  for (const n of [2, 3, 4]) {
    add(E[`BILLING_INBOX_${n}_USER`] || "", E[`BILLING_INBOX_${n}_PASS`] || "", E[`BILLING_INBOX_${n}_HOST`] || "", E[`BILLING_INBOX_${n}_PORT`] || "");
  }
  /* Microsoft 365 work mailboxes (e.g. ryan@lumesp.com): no password can reach them because
     Microsoft disabled basic-auth IMAP, so they connect over OAuth2 with a token minted at
     sweep time. Configured by MS_BILLING_MAILBOXES + the Entra app creds (see msOauth.ts). */
  for (const user of msBillingMailboxes()) {
    if (out.some((x) => x.user.toLowerCase() === user.toLowerCase())) continue;
    out.push({ user, pass: "", host: E.MS_IMAP_HOST || "outlook.office365.com", port: 993, label: user, oauth: true });
  }
  if (!out.length) add(E.RESUME_INBOX_USER || "", E.RESUME_INBOX_PASS || "", E.RESUME_INBOX_HOST || "", E.RESUME_INBOX_PORT || "", true);
  return out;
}

/**
 * Folders worth scanning. Anything not on this list is not read, and a folder a provider
 * does not have is skipped without complaint.
 *
 * ── Why Spam and Trash are on it ────────────────────────────────────────────────
 * Gmail's All Mail catches everything archived or filtered EXCEPT those two, which it
 * excludes by design. That leaves the two ways a real invoice most often goes missing:
 *
 *   SPAM is the serious one. A vendor's receipt caught by a filter is invisible, and a
 *   month with a filtered receipt looks exactly like a month with no charge. The books
 *   would report a gap that does not exist, and no amount of staring at the console
 *   would ever say why.
 *
 *   TRASH is the ordinary one. People delete a receipt email once the card has cleared;
 *   the invoice behind it is still real and still has to be accounted for. Gmail keeps
 *   deleted mail for 30 days, so this only ever recovers the recent past, which is
 *   exactly the window the nightly sweep works in.
 *
 * Reading them is safe in a way that is worth stating: every folder is opened READ-ONLY,
 * so nothing is un-deleted, nothing is marked as read, nothing is moved out of Spam and
 * no filter is trained by this. And a charge found twice in two folders is not filed
 * twice: `isSameCharge` settles it, the same test the duplicate sweep uses.
 *
 * Names differ per provider, so both dialects are listed: Gmail brackets its special
 * folders, Microsoft 365 spells them out.
 */
const FOLDERS = [
  "INBOX", "Archive", "[Gmail]/All Mail", "Receipts", "Billing",
  /* the two All Mail leaves out */
  "[Gmail]/Spam", "[Gmail]/Trash", "Junk", "Junk Email", "Deleted Items", "Trash", "Spam",
];

/**
 * What actually went wrong, in words the owner can act on.
 *
 * IMAP reports a refused password as "Command failed", which reads like a bug in this code
 * and is indistinguishable from the server being unreachable. Since a refused password is
 * by far the most common cause (Gmail and Microsoft 365 both reject the account password
 * over IMAP and want an app password), the console says so, names the mailbox, and gives
 * the command that fixes it.
 */
function mailboxError(e: unknown, cfg: MailboxCfg): string {
  const err = e as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
  const msg = err?.message || "";
  const rejected = err?.authenticationFailed || /auth/i.test(msg) || /^Command failed$/i.test(msg);
  if (rejected) {
    const said = (err.responseText || "").slice(0, 80);
    return `${cfg.user} refused the sign-in${said ? ` (${said})` : ""}. ` +
      `Gmail and Microsoft 365 both reject the account password over IMAP: issue an app password, then run ` +
      `set-billing-inbox.sh ${cfg.user} '<app-password>' on the server.`;
  }
  if (/timeout|ETIMEOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg + (err?.code || ""))) {
    return `Could not reach ${cfg.host}:${cfg.port} for ${cfg.user}. This is the connection, not the password: check the host and port.`;
  }
  return msg.slice(0, 300) || "mailbox error";
}

/**
 * Sweep one mailbox for receipts back to `since`. Read-only: the folder is opened without
 * write access, so nothing is deleted and nothing is marked read. Safe to re-run, which is
 * what makes backfilling two months of history a button rather than a project.
 */
export async function harvestMailbox(
  cfg: MailboxCfg,
  since: Date,
  /** `followLinks: false` reads attachments only — a dry, offline sweep. */
  opts: { renderShots?: boolean; followLinks?: boolean } = {},
): Promise<SweepReport> {
  const report: SweepReport = {
    at: nowIso(), mailbox: cfg.user, ok: false, since: since.toISOString().slice(0, 10),
    scanned: 0, billingCandidates: 0, imported: 0, duplicates: 0, skippedNotCharge: 0,
    unparsedAmount: 0, shotsRendered: 0, shotFailures: 0,
    documentsLinked: 0, documentFailures: [], skippedNotOurs: 0, otherSpend: [], byFolder: {}, rejects: [],
  };
  await ensureReceiptsReady();
  const items = await listSpendItems();

  let client: import("imapflow").ImapFlow | null = null;
  try {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    /* OAuth mailboxes (Microsoft 365) authenticate with a bearer token; the rest with a
       password. The token is minted per sweep and cached, so this is one HTTP call at most. */
    const auth = cfg.oauth
      ? { user: cfg.user, accessToken: await getMsImapToken() }
      : { user: cfg.user, pass: cfg.pass };
    client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth, logger: false });
    await client.connect();

    /* WHICH FOLDERS TO ACTUALLY OPEN. The hardcoded FOLDERS list is a guess at each
       provider's folder names, and a receipt hiding in a folder it did not name (a
       registrar's confirmation sitting in Microsoft 365's "Deleted Items") is invisible.
       So ask the server what it really has:
         - Gmail keeps everything except Spam/Trash inside "[Gmail]/All Mail", so INBOX +
           All Mail + Spam + Trash covers the account without re-reading every label.
         - Everything else (Microsoft 365, custom IMAP) is swept folder by folder, skipping
           only outgoing and non-mail folders — so Deleted Items, Junk, Archive and any
           custom folder are all read. Falls back to the curated names if listing fails. */
    let folders: string[] = FOLDERS;
    try {
      const paths = (await client.list()).map((f) => f.path).filter(Boolean);
      if (paths.length) {
        const isGmail = paths.some((p) => /^\[Gmail\]\/All Mail$/i.test(p));
        if (isGmail) {
          folders = ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"]
            .filter((f) => paths.some((p) => p.toLowerCase() === f.toLowerCase()));
        } else {
          const skip = /^(?:sent items|sent|sent mail|drafts|outbox|notes|calendar|contacts|tasks|journal|sync issues|conversation history|rss feeds|rss subscriptions)(?:\/|$)/i;
          folders = paths.filter((p) => !skip.test(p));
          if (!folders.some((p) => p.toLowerCase() === "inbox")) folders.unshift("INBOX");
        }
      }
    } catch {
      /* server would not list folders — fall back to the curated names */
    }

    for (const folder of folders) {
      let lock: { release: () => void } | null = null;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true } as never);
      } catch {
        continue; // folder does not exist on this provider
      }
      try {
        for await (const msg of client.fetch({ since }, { source: true, uid: true, envelope: true })) {
          report.scanned += 1;
          const parsed = await simpleParser(msg.source as Buffer).catch(() => null);
          if (!parsed) continue;
          const mm: MailMessage = {
            subject: parsed.subject || "",
            from: (parsed.from?.value?.[0]?.address || "").toLowerCase(),
            fromName: parsed.from?.value?.[0]?.name || "",
            date: (parsed.date || new Date()).toISOString(),
            messageId: parsed.messageId || undefined,
            text: (parsed.text || "").slice(0, 40_000),
            html: typeof parsed.html === "string" ? parsed.html : undefined,
            attachments: (parsed.attachments || []).map((a) => ({
              filename: a.filename || "", contentType: (a.contentType || "").toLowerCase(), content: a.content as Buffer,
            })),
          };
          const c = classify(mm);
          if (!c.billing) { report.skippedNotCharge += 1; continue; }
          report.billingCandidates += 1;
          const res = await importMessage(mm, items, cfg.user, {
            renderShot: opts.renderShots !== false,
            followLinks: opts.followLinks,
          });
          /* A link that failed is worth reporting whatever became of the message: a
             receipt filed from body text alone still has no invoice behind it. */
          if (res.documentError && report.documentFailures.length < 20) {
            report.documentFailures.push({ subject: mm.subject.slice(0, 120), from: mm.from, reason: res.documentError });
          }
          /* Not ours: counted, and a sample kept with its figures so the console can
             show it. A genuinely new vendor must not hide among the personal charges. */
          if (res.notOurs) {
            report.skippedNotOurs += 1;
            if (res.other && report.otherSpend.length < 30) report.otherSpend.push(res.other);
            continue;
          }
          if (res.status === "imported") {
            report.imported += 1;
            report.byFolder[folder] = (report.byFolder[folder] || 0) + 1;
            if (res.linked) report.documentsLinked += 1;
            if (res.shot) report.shotsRendered += 1;
            if (res.shotError) report.shotFailures += 1;
          }
          else if (res.status === "duplicate") report.duplicates += 1;
          else {
            if (res.reason?.includes("amount")) report.unparsedAmount += 1;
            if (report.rejects.length < 40) {
              report.rejects.push({ subject: mm.subject.slice(0, 120), from: mm.from, date: mm.date.slice(0, 10), reason: res.reason || "rejected" });
            }
          }
        }
      } finally {
        lock.release();
      }
    }
    report.ok = true;
  } catch (e) {
    report.error = mailboxError(e, cfg);
  } finally {
    await client?.logout().catch(() => {});
  }

  store.sweeps.unshift(report);
  store.sweeps = store.sweeps.slice(0, 30);
  store.lastSweepAt = report.at;
  persist();
  return report;
}

/** Turn one classified message into a stored receipt (idempotent per message). */
async function importMessage(
  mm: MailMessage,
  items: SpendItem[],
  mailbox: string,
  opts: { renderShot: boolean; followLinks?: boolean },
): Promise<{
  status: "imported" | "duplicate" | "rejected";
  reason?: string;
  shot?: boolean;
  shotError?: string;
  /** A document was fetched from a link rather than an attachment. */
  linked?: boolean;
  /** The message linked to a document and it could not be fetched. */
  documentError?: string;
  /** A real charge, from a sender that is not one of this company's vendors. */
  notOurs?: boolean;
  other?: { vendor: string; amountUsd: number; chargedAt: string; from: string };
}> {
  const bodyText = mm.text || stripHtml(mm.html || "");
  const pdf = mm.attachments.find((a) => a.contentType.includes("pdf") || /\.pdf$/i.test(a.filename));
  const image = mm.attachments.find((a) => a.contentType.startsWith("image/") && !/^image\/(gif)$/.test(a.contentType) && (a.content?.length || 0) > 8_000);

  /* MOST VENDORS LINK TO THE DOCUMENT RATHER THAN ATTACHING IT. When nothing is
     attached, follow the "View invoice" / "Download receipt" button and fetch what a
     person clicking it would have got. That link is its own credential, which is why
     this needs no password and works for vendors nobody has a portal session with.
     Skipped entirely when an attachment is present: the vendor's own attached file is
     already the best answer, and a network round trip for it would be waste. */
  let linked: FetchedDocument | undefined;
  let documentError: string | undefined;
  if (!pdf && !image && opts.followLinks !== false) {
    const pull: PullResult = await pullEmailDocument({ html: mm.html, text: bodyText }).catch((e) => ({
      attempts: [], skipped: 0, reason: (e as Error)?.message?.slice(0, 200) || "the link could not be followed",
    }));
    linked = pull.document;
    /* A message that links to nothing is ordinary and silent. A message that linked to
       something which then failed is a fault, and it is reported so the shape can be
       fixed rather than the vendor looking like it never billed. */
    if (!linked && pull.attempts.length) documentError = pull.reason;
  }

  /** The document behind this receipt, whether it arrived attached or was fetched. */
  const docPdf = pdf?.content || (linked?.mime === "application/pdf" ? linked.bytes : undefined);
  const docImage = image
    ? { bytes: image.content, mime: image.contentType }
    : linked && linked.mime.startsWith("image/") ? { bytes: linked.bytes, mime: linked.mime } : undefined;

  let parsed = parseReceiptText(bodyText);
  // Some vendors send an empty body and put everything in the PDF.
  if ((!parsed || !parsed.amountUsd) && docPdf) {
    const pdfText = await pdfToText(docPdf).catch(() => "");
    if (pdfText) parsed = parseReceiptText(pdfText) || parsed;
  }

  /* WHAT STRIPE STATED BEATS WHAT THE EMAIL SAID. A hosted invoice names its own
     number, total, payment date and — per line — whether that line recurs. Read off the
     invoice those are facts; read out of the covering email they are a guess at best,
     and a marketing line like "you saved $50" is exactly the kind of number a text
     parser picks up by mistake. It is also the only way to know a one-off purchase is
     one, which is what keeps it out of the monthly run rate. */
  const st = linked?.stripe;
  if (st && (st.amountUsd || 0) > 0) {
    parsed = {
      amount: st.amountUsd!, currency: st.currency || "USD", amountUsd: st.amountUsd!, approxFx: false,
      chargedAt: st.paidOn || parsed?.chargedAt,
      period: (st.paidOn || parsed?.chargedAt || "").slice(0, 7) || parsed?.period,
      invoiceNumber: st.invoiceNumber || parsed?.invoiceNumber,
      description: parsed?.description,
      kind: "charge",
      lines: parsed?.lines || [],
    };
  }

  if (!parsed || !(parsed.amountUsd > 0)) {
    const why = documentError ? `; the document it links to could not be read (${documentError})` : "";
    return { status: "rejected", reason: `no amount could be read from the message or its attachment${why}`, documentError };
  }

  /* A charge cannot postdate the email that reports it by more than a few days: a date
     parsed out of the body that lands months ahead is a domain EXPIRY or a next-renewal
     date, not the charge date (a GoDaddy order filed itself into 2028 this way). */
  const mailDay = mm.date.slice(0, 10);
  let chargedAt = parsed.chargedAt || mailDay;
  if (mailDay && chargedAt > addDays(mailDay, 7)) chargedAt = mailDay;
  let period = parsed.period || chargedAt.slice(0, 7);
  if (period > addDays(mailDay, 40).slice(0, 7)) period = chargedAt.slice(0, 7);
  /* The amount and the line-item label are what tell one of a vendor's listings from
     another, so the router gets them rather than the raw message alone. */
  const match = matchVendor(mm, items, { amountUsd: parsed.amountUsd, period, description: parsed.description });

  /* A MAILBOX BELONGS TO A PERSON, AND THE BOOKS DO NOT. The first live sweep filed
     Anthropic and Hetzner invoices alongside a pizza order and a phone bill. A stranger
     is not filed, and it is not silently dropped either: it comes back with its figures
     so the sweep can report it, because a vendor genuinely being paid and never
     registered is exactly what these books exist to catch. */
  const rel = relevanceOf({ vendor: match.vendor, itemId: match.itemId, confidence: match.confidence }, items);
  if (!rel.ours && !filingUnknownVendors()) {
    return {
      status: "rejected", reason: rel.why, notOurs: true,
      other: { vendor: match.vendor, amountUsd: parsed.amountUsd, chargedAt, from: mm.from },
    };
  }

  const fingerprint = createHash("sha1")
    .update([mm.messageId || "", match.vendor, parsed.amountUsd.toFixed(2), chargedAt, parsed.invoiceNumber || ""].join("|"))
    .digest("hex");
  // Same message, or the same charge arriving twice (invoice + payment confirmation).
  if (store.receipts.some((r) => fingerprintOf(r) === fingerprint)) return { status: "duplicate" };
  // Deleted by hand: the email is still in the mailbox, but the owner has already said
  // this one does not belong in the books.
  if (isReceiptDismissed(fingerprint, store.dismissed || [])) return { status: "duplicate" };

  const id = rid("rcpt");
  let hasShot = false, shotError: string | undefined;
  if (opts.renderShot) {
    /* The document wins over the email that carried it: the picture on file should be
       the vendor's invoice, not a screenshot of a covering note with a button on it. */
    const shot = await renderShot(id, {
      image: docImage,
      pdf: !docImage && docPdf ? docPdf : undefined,
      html: !docImage && !docPdf ? mm.html : undefined,
      text: !docImage && !docPdf && !mm.html ? bodyText : undefined,
    });
    hasShot = shot.ok;
    shotError = shot.error;
    // Keep the original artifact too, so the PDF can be opened as the vendor issued it.
    const src = image || pdf
      ? { content: (image || pdf)!.content, contentType: (image || pdf)!.contentType, filename: (image || pdf)!.filename }
      : linked
        ? { content: linked.bytes, contentType: linked.mime, filename: linked.fileName }
        : null;
    if (src) await saveArtifact(id, `src.${extFromMime(src.contentType, src.filename)}`, src.content).catch(() => {});
  }

  const attached = image || pdf;

  const r: Receipt = {
    id, period, vendor: match.vendor, itemId: match.itemId,
    description: parsed.description,
    amountUsd: parsed.kind === "charge" ? parsed.amountUsd : -Math.abs(parsed.amountUsd),
    currency: parsed.currency,
    nativeAmount: parsed.currency === "USD" ? undefined : parsed.amount,
    invoiceNumber: parsed.invoiceNumber,
    chargedAt, kind: parsed.kind, source: "email",
    mailbox, messageId: mm.messageId, subject: mm.subject.slice(0, 200), from: mm.from,
    processor: match.processor,
    fileName: attached?.filename || linked?.fileName,
    fileMime: attached?.contentType || linked?.mime,
    fileBytes: attached?.content?.length || linked?.bytes.length,
    documentUrl: linked?.url,
    documentVia: linked?.via,
    documentError,
    /* The card figure and the cost differ when prepaid credit covered part of the bill,
       and the register wants the cost. Both are kept so a bank statement still ties out. */
    amountPaidUsd: st?.amountPaidUsd,
    creditAppliedUsd: st?.creditAppliedUsd,
    cadence: st?.cadence,
    recurringUsd: st?.recurringUsd ?? undefined,
    oneTimeUsd: st?.oneTimeUsd ?? undefined,
    hasShot, shotError, shotVersion: hasShot ? SHOT_VERSION : undefined,
    excerpt: bodyText.replace(/\n{3,}/g, "\n\n").slice(0, 1200),
    confidence: Math.min(1, match.confidence * (parsed.approxFx ? 0.9 : 1)),
    matchedBy: match.matchedBy,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return { status: "imported", shot: hasShot, shotError, linked: !!linked, documentError };
}

function fingerprintOf(r: Receipt): string {
  return createHash("sha1")
    .update([r.messageId || "", r.vendor, Math.abs(r.amountUsd).toFixed(2), r.chargedAt, r.invoiceNumber || ""].join("|"))
    .digest("hex");
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(td|tr|div|p|br|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]{2,}/g, " ");
}

async function pdfToText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return ((await parser.getText())?.text || "").trim(); }
  finally { try { await (parser as unknown as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* best effort */ } }
}

/* ============================ tying a charge to its line ============================ */

/**
 * Which register row a charge belongs to, for the three channels that arrive with no
 * message to read: a hand-attached invoice, a figure off a billing API, and a document a
 * portal puller downloaded.
 *
 * None of them used to resolve one at all, which is why eight RapidAPI invoices (five
 * separate listings, five separate charges, five register rows waiting for exactly those
 * receipts) piled up under one "not on the register" heading while every one of the rows
 * said "no receipt".
 */
async function lineItemFor(input: {
  vendor: string; description?: string; amountUsd?: number; period?: string; notes?: string;
}): Promise<SpendItem | undefined> {
  const items = await listSpendItems().catch(() => [] as SpendItem[]);
  return resolveSpendItem({
    vendor: input.vendor,
    description: input.description,
    hay: input.notes,
    amountUsd: input.amountUsd,
    period: input.period,
  }, items)?.item;
}

/* ============================ manual entry ============================ */

/** Attach a receipt the owner downloaded by hand (the backfill path for portal-only vendors). */
export async function addManualReceipt(input: {
  vendor: string; itemId?: string; period: string; amountUsd: number; chargedAt?: string;
  invoiceNumber?: string; description?: string; notes?: string;
  file?: { bytes: Buffer; mime: string; name: string };
}): Promise<Receipt> {
  await ensureReceiptsReady();
  const id = rid("rcpt");
  let hasShot = false, shotError: string | undefined;
  if (input.file) {
    /* Route by what the file actually is: a picture is already the receipt, a PDF gets
       rendered, and anything else (a saved HTML receipt, a text export) is laid out as a
       page first — feeding non-image bytes to the image branch produced an unopenable file
       the first time round. */
    await saveArtifact(id, `src.${extFromMime(input.file.mime, input.file.name)}`, input.file.bytes).catch(() => {});
    const shot = await renderShot(id, shotInputFor(input.file));
    hasShot = shot.ok; shotError = shot.error;
  }
  const chargedAt = input.chargedAt || `${input.period}-01`;
  const itemId = input.itemId || (await lineItemFor(input))?.id;
  const r: Receipt = {
    id, period: input.period, vendor: input.vendor, itemId,
    description: input.description, amountUsd: round2(input.amountUsd), currency: "USD",
    invoiceNumber: input.invoiceNumber, chargedAt, kind: input.amountUsd < 0 ? "refund" : "charge",
    source: "manual", fileName: input.file?.name, fileMime: input.file?.mime, fileBytes: input.file?.bytes.length,
    hasShot, shotError, shotVersion: hasShot ? SHOT_VERSION : undefined,
    confidence: 1, matchedBy: "entered by the owner", reviewed: true,
    notes: input.notes, createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return r;
}

/**
 * Give an existing receipt the document it never had.
 *
 * The vault is full of charges that are real and proven by the figure but carry no
 * picture: a vendor that emails a plain-text confirmation, one whose invoice sits behind
 * a login, a month pulled from a billing API where no document was ever issued. Until now
 * the only way to put a document against one of those was to attach a NEW receipt beside
 * it, which left the books showing the same charge twice and made the coverage figure
 * lie in the other direction.
 *
 * So this replaces the artifact on a row that already exists: same id, same figures, same
 * line item, same place in the grid. The row keeps whatever the owner has already
 * corrected; only the document and the picture drawn from it change.
 *
 * A failed render is not a failed attach. The vendor's own file is written to disk BEFORE
 * the render is attempted, so a PDF that Chromium chokes on still leaves the real document
 * downloadable and reports the reason, rather than losing the upload entirely.
 */
export async function attachDocument(
  id: string,
  file: { bytes: Buffer; mime: string; name: string },
): Promise<{ ok: boolean; receipt?: Receipt; error?: string }> {
  await ensureReceiptsReady();
  const r = store.receipts.find((x) => x.id === id);
  if (!r) return { ok: false, error: "not_found" };

  /* Replacing a document means the old picture is wrong. Clear it first so a failed
     render can never leave the previous invoice's image sitting under the new file. */
  await removeArtifacts(id).catch(() => {});
  await saveArtifact(id, `src.${extFromMime(file.mime, file.name)}`, file.bytes).catch(() => {});
  const shot = await renderShot(id, shotInputFor(file));

  r.fileName = file.name;
  r.fileMime = file.mime;
  r.fileBytes = file.bytes.length;
  r.hasShot = shot.ok;
  r.shotError = shot.error;
  r.shotVersion = shot.ok ? SHOT_VERSION : undefined;
  /* An owner who went and fetched the invoice by hand has reviewed this row by doing it. */
  r.reviewed = true;
  r.updatedAt = nowIso();
  persist();
  return { ok: true, receipt: r };
}

/**
 * File (or refresh) a figure pulled straight from a vendor's billing API. Keyed on
 * vendor + period + reference so re-running a puller corrects the month in place instead
 * of stacking duplicates: a mid-month pull is a running figure that the next pull
 * finalises. Never claims to have a receipt image, because no receipt was issued.
 */
export async function recordApiReceipt(input: {
  vendor: string; itemId?: string; period: string; amountUsd: number;
  reference: string; description?: string; chargedAt?: string; notes?: string;
}): Promise<{ receipt: Receipt; created: boolean }> {
  await ensureReceiptsReady();
  const existing = store.receipts.find(
    (r) => r.source === "api" && r.vendor === input.vendor && r.period === input.period && r.invoiceNumber === input.reference,
  );
  if (existing) {
    existing.amountUsd = round2(input.amountUsd);
    existing.description = input.description ?? existing.description;
    existing.notes = input.notes ?? existing.notes;
    existing.updatedAt = nowIso();
    persist();
    return { receipt: existing, created: false };
  }
  const r: Receipt = {
    id: rid("rcpt"), period: input.period, vendor: input.vendor,
    itemId: input.itemId || (await lineItemFor(input))?.id,
    description: input.description, amountUsd: round2(input.amountUsd), currency: "USD",
    invoiceNumber: input.reference, chargedAt: input.chargedAt || `${input.period}-01`,
    kind: "charge", source: "api", hasShot: false, confidence: 1,
    matchedBy: "pulled from the vendor's billing API", notes: input.notes,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return { receipt: r, created: true };
}

/**
 * File the document a portal puller downloaded from a vendor's billing page.
 *
 * The third channel, after email and the handful of real billing APIs: a browser
 * session, signed in once by the owner, that opens the vendor's own billing page on
 * the day it charges and takes whatever invoice it offers. That covers the vendors
 * that email nothing and have no API, which is most of them.
 *
 * Keyed on vendor + period + invoice number so re-running a puller corrects the month
 * in place rather than stacking duplicates. The bytes are the vendor's own file, so
 * this goes through the same render path as a hand-attached receipt and the console
 * shows the real document. A puller that came back empty must not call this at all:
 * a row here means a document exists.
 */
export async function recordPortalReceipt(input: {
  vendor: string; itemId?: string; period: string; amountUsd: number;
  reference?: string; description?: string; chargedAt?: string; notes?: string;
  currency?: string; nativeAmount?: number;
  file: { bytes: Buffer; mime: string; name: string };
}): Promise<{ receipt: Receipt; created: boolean }> {
  await ensureReceiptsReady();

  /* Which row already holds this charge, if any.
   *
   * The invoice number is the vendor's own identifier and settles it outright, wherever the
   * charge landed: a re-read that corrects the date or the figure is still that invoice.
   *
   * Everything else goes through the SAME test the duplicate sweep uses (`isSameCharge`:
   * one vendor, one amount, one day, and nothing on either row proving they are separate).
   * Ingest used to have its own weaker rule - vendor + period + day + amount, but ONLY
   * against rows that carried no invoice number - and that exception is what filed all
   * eight RapidAPI invoices twice on 2026-07-31: the second push omitted the numbers, so
   * it matched nothing and doubled every line ($60 Skip Tracing read $120). A charge
   * already on file is updated, never filed again, whichever push knows its number. */
  const chargedDay = (input.chargedAt || "").slice(0, 10);
  const amt = round2(input.amountUsd);
  const incoming = {
    id: "", vendor: input.vendor, amountUsd: amt, chargedAt: chargedDay,
    period: input.period, invoiceNumber: input.reference, itemId: input.itemId,
  };
  const mine = store.receipts.filter(
    (r) => r.vendor === input.vendor && (r.source === "portal" || r.source === "api"),
  );
  const existing = (input.reference && mine.find((r) => r.invoiceNumber === input.reference))
    || mine.find((r) => r.source === "portal" && isSameCharge(r, incoming))
    /* THE VENDOR'S OWN PDF FOR A MONTH ITS BILLING API ALREADY PRICED IS THAT FIGURE'S
       DOCUMENT, NOT A SECOND CHARGE. An `api` row is a month-end statement by construction
       (pullVendorApis writes one per billing month), so the document belongs on it and the
       row is upgraded in place. Filing it separately would double the vendor — Telnyx would
       have read twice its real cost the day its portal puller first ran, which is exactly
       how RapidAPI came to show $120 against a $60 line. The two never agree on a day (the
       API dates a month to its period end, the invoice to its issue date) and rarely on an
       invoice number, so `isSameCharge` cannot catch this one on its own. */
    || mine.find((r) => r.source === "api" && r.period === input.period);
  const id = existing?.id || rid("rcpt");

  /* The document goes to disk before the render is attempted. The render is the fragile
     half and the file is the valuable one: filing it first means a failed render is only
     ever a missing picture, and `renderMissingShots` can come back for it later. */
  await saveArtifact(id, `src.${extFromMime(input.file.mime, input.file.name)}`, input.file.bytes).catch(() => {});
  const shot = await renderShot(id, shotInputFor(input.file));

  const chargedAt = input.chargedAt || `${input.period}-01`;
  const amountUsd = round2(input.amountUsd);

  if (existing) {
    /* The document's own figure wins — it is the bill, where the API total was a sum of
       usage feeds. But a puller that could not read an amount reports 0, and a 0 must never
       erase a figure that is already on file. */
    existing.amountUsd = amountUsd !== 0 || existing.amountUsd === 0 ? amountUsd : existing.amountUsd;
    if (existing.source === "api") {
      /* Upgraded from a stated figure to a filed document. */
      existing.source = "portal";
      existing.matchedBy = "the vendor's own invoice, downloaded from their billing page";
      existing.reviewed = true;
      existing.confidence = 1;
    }
    existing.chargedAt = chargedAt;
    existing.itemId = existing.itemId || input.itemId || (await lineItemFor(input))?.id;
    existing.description = input.description ?? existing.description;
    existing.invoiceNumber = input.reference ?? existing.invoiceNumber;
    existing.currency = input.currency || existing.currency;
    existing.nativeAmount = input.nativeAmount ?? existing.nativeAmount;
    existing.fileName = input.file.name;
    existing.fileMime = input.file.mime;
    existing.fileBytes = input.file.bytes.length;
    existing.hasShot = shot.ok;
    existing.shotError = shot.error;
    existing.shotVersion = shot.ok ? SHOT_VERSION : existing.shotVersion;
    existing.notes = input.notes ?? existing.notes;
    existing.updatedAt = nowIso();
    persist();
    /* A receipt that answers what its row was asking answers it now, not at the next
       nightly tick: the console is usually being read the moment a pull finishes. */
    await learnPriceFor(existing.itemId);
    return { receipt: existing, created: false };
  }

  const r: Receipt = {
    id, period: input.period, vendor: input.vendor,
    itemId: input.itemId || (await lineItemFor(input))?.id,
    description: input.description, amountUsd, currency: input.currency || "USD",
    nativeAmount: input.nativeAmount, invoiceNumber: input.reference,
    chargedAt, kind: input.amountUsd < 0 ? "refund" : "charge", source: "portal",
    fileName: input.file.name, fileMime: input.file.mime, fileBytes: input.file.bytes.length,
    hasShot: shot.ok, shotError: shot.error, shotVersion: shot.ok ? SHOT_VERSION : undefined,
    confidence: 1, matchedBy: "downloaded from the vendor's billing page", reviewed: true,
    notes: input.notes, createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  await learnPriceFor(r.itemId);
  return { receipt: r, created: true };
}

/* ====================== the pullers themselves ====================== */

/**
 * What each portal puller last did. This is the half the console cannot infer from the
 * receipts alone: a vendor with no receipts on file looks identical whether its puller
 * ran and found nothing or was never set up at all. The distinction is the whole point,
 * so the pullers report it explicitly and silence is read as "not set up".
 */
export interface PullerState {
  /** Matches the vendor name in the spend register. */
  vendor: string;
  /** True when something can fetch this vendor's receipt with nobody present. */
  ready: boolean;
  /** api = a real invoice API; portal = a signed-in browser session. */
  route: "api" | "api + portal" | "portal";
  state: "setup-needed" | "error" | "missing" | "never-run" | "waiting" | "no-charges" | "ok";
  lastRunAt?: string;
  /** Charges seen in the period checked, and how many had a document. */
  charges?: number;
  receipted?: number;
  /** Charges the vendor billed but published no document for. */
  missing?: Array<{ date?: string; amount?: number; reason: string }>;
  error?: string;
  /** What the owner has to do once, if anything. */
  action?: string;
  /** Machine this puller runs on, so a dead sweep can be traced to a box. */
  host?: string;
  updatedAt: string;
}

/** A sweep older than this has stopped running, whatever it last reported. */
export const PULLER_STALE_DAYS = 3;

export function pullerStates(): PullerState[] {
  return Object.values(store.pullers || {}).sort((a, b) => a.vendor.localeCompare(b.vendor));
}

export function pullerStateFor(vendor: string): PullerState | undefined {
  const key = vendor.toLowerCase();
  return Object.values(store.pullers || {}).find((p) => p.vendor.toLowerCase() === key);
}

export function lastPullerReportAt(): string | undefined {
  return store.pullerReportAt;
}

/** Record what a sweep just did. Replaces each named vendor's line, leaves the rest. */
export function recordPullerStates(input: { host?: string; pullers: Array<Partial<PullerState> & { vendor: string }> }): PullerState[] {
  if (!store.pullers) store.pullers = {};
  for (const p of input.pullers) {
    if (!p.vendor) continue;
    store.pullers[p.vendor.toLowerCase()] = {
      vendor: p.vendor,
      ready: Boolean(p.ready),
      route: p.route || "portal",
      state: p.state || "never-run",
      lastRunAt: p.lastRunAt,
      charges: p.charges,
      receipted: p.receipted,
      missing: Array.isArray(p.missing) ? p.missing.slice(0, 25) : [],
      error: p.error?.slice(0, 300),
      action: p.action?.slice(0, 400),
      host: p.host || input.host,
      updatedAt: nowIso(),
    };
  }
  store.pullerReportAt = nowIso();
  persist();
  return pullerStates();
}

export async function listReceipts(): Promise<Receipt[]> {
  await ensureReceiptsReady();
  return store.receipts.slice().sort((a, b) => (b.chargedAt || "").localeCompare(a.chargedAt || ""));
}

export async function updateReceipt(id: string, patch: Partial<Receipt>): Promise<Receipt | null> {
  await ensureReceiptsReady();
  const r = store.receipts.find((x) => x.id === id);
  if (!r) return null;
  for (const k of ["period", "vendor", "itemId", "description", "invoiceNumber", "chargedAt", "notes"] as const) {
    if (patch[k] != null) (r as unknown as Record<string, unknown>)[k] = String(patch[k]);
  }
  if (patch.amountUsd != null) r.amountUsd = round2(Number(patch.amountUsd));
  if (patch.reviewed != null) { r.reviewed = !!patch.reviewed; r.confidence = patch.reviewed ? 1 : r.confidence; }
  r.updatedAt = nowIso();
  persist();
  return r;
}

export async function deleteReceipt(id: string): Promise<boolean> {
  await ensureReceiptsReady();
  const going = store.receipts.find((r) => r.id === id);
  if (!going) return false;
  /* Remember the invoice, not the row. The harvester skips anything whose fingerprint is
     already in the store, so deleting a receipt also deleted the only reason the sweep
     had to leave that email alone, and the next pull filed it straight back. The owner
     deleted a RackNerd receipt and watched it return. */
  dismissFingerprint(fingerprintOf(going));
  store.receipts = store.receipts.filter((r) => r.id !== id);
  await removeArtifacts(id);
  persist();
  return true;
}

/* ---- deletions the mailbox sweep must not undo --------------------------
   Pure and exported so scripts/test-receipt-dismiss.mts can pin the rule, the same way
   the spend register's is pinned. */

/** Has this invoice been deleted by hand? */
export function isReceiptDismissed(fingerprint: string, dismissed: string[]): boolean {
  return dismissed.indexOf(fingerprint) >= 0;
}

/** Pressing "Pull receipts from the mailbox" is the owner asking for the mailbox again,
 *  which is the one thing allowed to overrule an earlier delete. The NIGHTLY sweep calls
 *  harvestAll() directly and never comes through here, so a receipt removed by hand stays
 *  removed in between. Returns how many deletions were forgotten. */
export function forgetReceiptDismissals(): number {
  const n = (store.dismissed || []).length;
  if (n) { store.dismissed = []; persist(); }
  return n;
}

function dismissFingerprint(fp: string): void {
  if (!fp) return;
  if (!store.dismissed) store.dismissed = [];
  if (store.dismissed.indexOf(fp) < 0) store.dismissed.push(fp);
}

/**
 * Take out charges that were harvested from a mailbox but are not this company's.
 *
 * The relevance filter stops NEW ones being filed; this is for the ones already in from
 * before it existed. A personal mailbox put a pizza order and a phone bill in the books,
 * and they have to come out for the burn figure to mean anything.
 *
 * Deliberately narrow, because this deletes:
 *   - EMAIL receipts only. A portal or API receipt was fetched from a vendor's own
 *     billing page, so it is by definition a vendor of ours and can never be personal.
 *   - never one the owner has touched. `reviewed` means a person looked at this row and
 *     kept it, which outranks any rule here.
 *   - never one tied to a register row, which `relevanceOf` already guarantees, and
 *     which is asserted again rather than assumed.
 *
 * `dryRun` reports exactly what would go without touching anything, and the caller is
 * expected to look before it does not.
 */
export async function purgeNotOurs(opts: { dryRun?: boolean } = {}): Promise<{
  removed: number;
  kept: number;
  charges: Array<{ id: string; vendor: string; amountUsd: number; chargedAt: string; from?: string; why: string }>;
}> {
  await ensureReceiptsReady();
  const items = await listSpendItems();
  const doomed: Array<{ id: string; vendor: string; amountUsd: number; chargedAt: string; from?: string; why: string }> = [];

  for (const r of store.receipts) {
    if (r.source !== "email") continue;
    if (r.reviewed) continue;
    if (r.itemId) continue;
    const rel = relevanceOf({ vendor: r.vendor, itemId: r.itemId, confidence: r.confidence }, items);
    if (rel.ours) continue;
    doomed.push({ id: r.id, vendor: r.vendor, amountUsd: r.amountUsd, chargedAt: r.chargedAt, from: r.from, why: rel.why });
  }

  if (!opts.dryRun && doomed.length) {
    const gone = new Set(doomed.map((d) => d.id));
    store.receipts = store.receipts.filter((r) => !gone.has(r.id));
    for (const d of doomed) await removeArtifacts(d.id).catch(() => {});
    persist();
  }
  return { removed: opts.dryRun ? 0 : doomed.length, kept: store.receipts.length, charges: doomed };
}

/* ---- taking the marketing back out of the books --------------------------------------

   The relevance filter asks "is this vendor ours?" — and the junk sweeps of 2026-08-02/03
   sailed through it, because the vendors WERE ours. Job alerts filed as LinkedIn charges,
   Prime Day promotions as AWS, AppSumo deal blasts as TidyCal, "payment unsuccessful"
   notices as Anthropic: real vendor, fictional charge, 180+ rows of it. The classifier now
   refuses those MESSAGES; this sweep applies the same judgement to what is already filed. */

export interface JunkPurgeEntry {
  id: string; vendor: string; amountUsd: number; period: string; chargedAt: string;
  subject?: string; from?: string; why: string;
}

/** The message-level verdict on a receipt already in the vault. Null means it stands.
 *  `items` is the live spend register, for the vendor-relevance rung: a receipt whose
 *  vendor the owner has retired from BOTH the register and the source catalogue (AWS,
 *  TidyCal) has no line left to prove and goes with the marketing. */
export function junkWhy(r: Receipt, all: Receipt[], items: SpendItem[] = []): string | null {
  /* Rebuild what classify() needs from what the receipt kept of its message. The excerpt
     is the first 1,200 chars of the body text, which is where every strong billing phrase
     lives; a receipt that arrived with the vendor's own document gets that counted too. */
  const msg: MailMessage = {
    subject: r.subject || "",
    from: r.from || "",
    date: r.chargedAt || "",
    text: r.excerpt || "",
    attachments: r.fileName
      ? [{ filename: r.fileName, contentType: r.fileMime || "", content: Buffer.alloc(0) }]
      : [],
  };
  const c = classify(msg);
  if (!c.billing) return c.reason || "not a record of a completed charge";

  /* The message is receipt-shaped — is it from somewhere that can speak for this vendor?
     amazon.com used to be listed under AWS and appsumo.com under TidyCal, so every retail
     order and marketplace deal wore a real vendor's name. A kept receipt must be from a
     domain the vendor still claims, from a payment processor, or must actually NAME the
     vendor in its subject or body. */
  const domain = ((r.from || "").split("@")[1] || "").toLowerCase();
  const src = vendorSourceFor(r.vendor);
  const claimed = !!domain && !!src && src.from.some((f) => domain === f || domain.endsWith("." + f));
  const viaProcessor = !!domain && PROCESSOR_DOMAINS.some((p) => domain === p || domain.endsWith("." + p));
  if (domain) {
    const hay = `${r.subject || ""} ${r.excerpt || ""}`.toLowerCase();
    const named = namedIn(hay, r.vendor) || (src?.merchant || []).some((mm) => namedIn(hay, mm));
    if (!claimed && !viaProcessor && !named) {
      return `sent from ${domain}, which does not identify ${r.vendor}, and the message never names them`;
    }
  }

  /* The vendor's own invoice, pulled from their portal or API, outranks the email that
     announced the same charge: keeping both counts the money twice (Zapmail's July was on
     file twice this way — the Stripe receipt email AND the portal invoice). An email copy
     of a charge a portal/api receipt already proves is the copy that goes. */
  const dup = all.some((o) => {
    if (o.id === r.id || (o.source !== "portal" && o.source !== "api")) return false;
    if (o.vendor.toLowerCase() !== r.vendor.toLowerCase() || o.period !== r.period) return false;
    if (Math.abs(Math.abs(o.amountUsd) - Math.abs(r.amountUsd)) < 0.01) return true;
    if (o.amountPaidUsd != null && Math.abs(o.amountPaidUsd - Math.abs(r.amountUsd)) < 0.01) return true;
    /* The amounts can legitimately differ between the two records of ONE charge: the email
       carries what the card was billed, the portal invoice the full cost before applied
       credit (Zapmail: $391.66 charged of a $441.66 invoice). The vendor's own invoice
       number settles it — when the email's attached document or text carries the portal
       receipt's invoice number, they are the same charge. */
    const inv = (o.invoiceNumber || "").toLowerCase();
    if (inv.length >= 6) {
      const hay = `${r.fileName || ""} ${r.subject || ""} ${r.excerpt || ""}`.toLowerCase();
      if (hay.includes(inv)) return true;
    }
    return false;
  });
  if (dup) return "the vendor's own invoice for this charge is already on file from the portal";

  /* A receipt-shaped message from a vendor the owner has retired everywhere is still not
     this company's money. The stored vendor is used as-is (never re-guessed, which could
     downgrade a processor receipt), and an itemId only counts while its row still exists:
     trusting a pointer at a deleted row would keep a retired vendor's receipts forever.
     A sender the vendor's own catalogue claims (or a payment processor) is evidence from
     OUTSIDE the body, so the stored confidence is not second-guessed for those: a repair
     that marked a row "ask for a look" over a date must not read as doubt about WHO was
     paid. */
  const itemId = r.itemId && items.some((i) => i.id === r.itemId) ? r.itemId : undefined;
  const rel = relevanceOf(
    { vendor: r.vendor, itemId, confidence: claimed || viaProcessor ? undefined : r.confidence },
    items,
  );
  if (!rel.ours && !filingUnknownVendors()) return rel.why;

  return null;
}

/**
 * Re-judge every email-harvested receipt under the current classifier and take out the
 * ones that were never receipts. Portal/api/manual rows are never touched (they came from
 * a vendor's own billing page), nor is anything the owner has marked reviewed. Each
 * removal is fingerprint-dismissed so neither the nightly sweep nor a manual pull can
 * refile the same message. Survivors get two repairs: a "refund" that never stated one
 * goes back to being a positive charge, and a charge date parsed off a domain-expiry
 * line (years in the future) is pulled back to when the mail actually arrived.
 */
export async function purgeJunkEmail(opts: { dryRun?: boolean } = {}): Promise<{
  removed: number; repaired: number; kept: number; charges: JunkPurgeEntry[];
}> {
  await ensureReceiptsReady();
  const doomed: JunkPurgeEntry[] = [];
  let repaired = 0;

  for (const r of store.receipts) {
    if (r.source !== "email" || r.reviewed) continue;
    const why = junkWhy(r, store.receipts);
    if (why) {
      doomed.push({
        id: r.id, vendor: r.vendor, amountUsd: r.amountUsd, period: r.period,
        chargedAt: r.chargedAt, subject: r.subject, from: r.from, why,
      });
      continue;
    }
    if (opts.dryRun) continue;
    /* Sign repair: negative money must be a STATED refund, not a "Refund Policy" footer. */
    const says = `${r.subject || ""} ${r.excerpt || ""}`.toLowerCase();
    const statedRefund = /your refund|refund (?:issued|processed|completed|confirmation|receipt|of\s*[$€£])|has been refunded|we(?:'ve| have) refunded|was refunded|amount refunded|credit note|payment reversal/.test(says);
    if (r.amountUsd < 0 && !statedRefund) {
      r.amountUsd = Math.abs(r.amountUsd); r.kind = "charge"; r.updatedAt = nowIso(); repaired++;
    }
    /* Date repair: a charge cannot postdate the sweep that filed it. The vendor confidence
       is left alone on purpose: this repair doubts the DATE, not who was paid, and lowering
       confidence here once made the relevance rung read a repaired row as junk on the next
       pass. */
    const filedDay = (r.createdAt || "").slice(0, 10);
    if (filedDay && r.chargedAt > filedDay) {
      r.chargedAt = filedDay;
      r.period = filedDay.slice(0, 7);
      r.updatedAt = nowIso(); repaired++;
    }
  }

  if (!opts.dryRun && doomed.length) {
    const gone = new Set(doomed.map((d) => d.id));
    for (const r of store.receipts) if (gone.has(r.id)) dismissFingerprint(fingerprintOf(r));
    store.receipts = store.receipts.filter((r) => !gone.has(r.id));
    for (const d of doomed) await removeArtifacts(d.id).catch(() => {});
  }
  if (!opts.dryRun && (doomed.length || repaired)) persist();
  return { removed: opts.dryRun ? 0 : doomed.length, repaired, kept: store.receipts.length, charges: doomed };
}

/**
 * Run the junk purge ONCE, on the next grid load after this ships, then remember it did —
 * same shape as collapseToOnePerCellOnce, and for the same reason: the cleanup needs no
 * button press and no SSH, and being one-shot it can never re-delete something the owner
 * later re-adds by hand. The nightly sweep cannot refile any of it, because the same
 * classifier that judged it here now refuses those messages at the door.
 */
export async function purgeJunkEmailOnce(): Promise<{ removed: number; repaired: number; ran: boolean }> {
  await ensureReceiptsReady();
  if (store.junkPurgeRunAt) return { removed: 0, repaired: 0, ran: false };
  const res = await purgeJunkEmail();
  store.junkPurgeRunAt = nowIso();
  persist();
  return { removed: res.removed, repaired: res.repaired, ran: true };
}

/** Every file a receipt owns: the picture, the thumbnail, and the vendor's own document. */
async function removeArtifacts(id: string): Promise<void> {
  const dir = receiptsDir();
  const names = [`${id}.png`, `${id}.thumb.png`];
  for (const e of ["pdf", "png", "jpg", "jpeg", "webp", "html", "htm", "txt", "bin"]) names.push(`${id}.src.${e}`);
  for (const f of names) await unlink(join(dir, f)).catch(() => {});
}

export function lastSweeps(): SweepReport[] { return store.sweeps.slice(0, 10); }
export function lastSweepAt(): string | undefined { return store.lastSweepAt; }

/* ==================== putting every charge on its own line ==================== */

export interface VaultRepair {
  checked: number;
  /** Charges newly tied to the register row they actually paid for. */
  linked: number;
  /** Charges that still belong to no row, so they report as unregistered spend. */
  unlinked: number;
  /** Copies of a charge that was already on file, removed. */
  deduped: number;
  /** Rows that stopped asking for a price because their own receipts answered it. */
  priced: Array<{ itemId: string; label: string; amountUsd: number; periods: string[] }>;
  /** What moved, so the change is readable rather than something that just happened. */
  links: Array<{ id: string; vendor: string; description?: string; amountUsd: number; period: string; label: string; why: string }>;
  removed: Array<{ id: string; vendor: string; amountUsd: number; chargedAt: string; keptId: string; reason: string }>;
}

/**
 * The recurring price a row's own receipts prove, or null.
 *
 * Two receipts for the same figure in two DIFFERENT periods is the test. One charge only
 * proves that money moved once, and taking it as the price would enshrine a first-month
 * proration or a one-off setup fee as the standing rate. Two identical ones a period apart
 * is a rate, which is exactly what the register row is missing.
 *
 * Where a plan's price has changed, the most recently charged figure wins: that is the one
 * still being billed, and the older rate is history.
 */
function provenPrice(itemId: string): { amountUsd: number; periods: string[] } | null {
  const periodsByAmount = new Map<number, Set<string>>();
  for (const r of store.receipts) {
    if (r.itemId !== itemId || r.kind === "refund" || !(r.amountUsd > 0)) continue;
    const key = round2(r.amountUsd);
    const seen = periodsByAmount.get(key) || new Set<string>();
    seen.add(r.period);
    periodsByAmount.set(key, seen);
  }
  const proven = [...periodsByAmount.entries()]
    .map(([amountUsd, ps]) => ({ amountUsd, periods: [...ps].sort() }))
    .filter((p) => p.periods.length >= 2)
    .sort((a, b) => b.periods[b.periods.length - 1].localeCompare(a.periods[a.periods.length - 1]));
  return proven[0] || null;
}

/**
 * Let the receipts answer the price question the register is asking.
 *
 * Only rows still asking are touched, and `setLearnedPrice` is the one that enforces that,
 * so a figure the owner typed cannot be moved from here however many receipts arrive.
 */
async function learnPriceFor(
  itemId: string | undefined,
  { dryRun = false, label }: { dryRun?: boolean; label?: string } = {},
): Promise<VaultRepair["priced"][number] | null> {
  if (!itemId) return null;
  const proven = provenPrice(itemId);
  if (!proven) return null;
  const entry = { itemId, label: label || itemId, ...proven };
  if (dryRun) return entry;
  const item = await setLearnedPrice(
    itemId,
    proven.amountUsd,
    `Priced at $${proven.amountUsd.toFixed(2)} from the vendor's own receipts, which charged`
      + ` exactly that in ${proven.periods.join(" and ")}. Correct it here if the plan is not what`
      + ` those months were billed at.`,
  ).catch(() => null);
  return item ? { ...entry, label: label || `${item.vendor} · ${item.label}` } : null;
}

async function learnPrices(items: SpendItem[], dryRun = false): Promise<VaultRepair["priced"]> {
  const priced: VaultRepair["priced"] = [];
  for (const item of items) {
    if (!item.needsAmount) continue;
    const got = await learnPriceFor(item.id, { dryRun, label: `${item.vendor} · ${item.label}` });
    if (got) priced.push(got);
  }
  return priced;
}

/**
 * Put every charge on the line it paid for, and take out the copies.
 *
 * Two jobs the vault cannot do at the moment a receipt lands: a charge filed before the
 * register knew about that listing, and the same charge arriving twice through different
 * channels. Both only become visible with the whole vault in view, so this is a sweep, not
 * an ingest rule, and it runs on the nightly tick.
 *
 * It never overrules a person. A charge whose row was set by hand (anything `reviewed`,
 * anything already pointing at a row that still exists) is left exactly where it is; only
 * the unattached and the dangling get routed. Dry-run reports without touching anything.
 */
export async function repairVault(opts: { dryRun?: boolean } = {}): Promise<VaultRepair> {
  await ensureReceiptsReady();
  const items = await listSpendItems().catch(() => [] as SpendItem[]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: VaultRepair = { checked: 0, linked: 0, unlinked: 0, deduped: 0, priced: [], links: [], removed: [] };
  let changed = false;

  /* ---- 1. every charge on its own line ---- */
  for (const r of store.receipts) {
    out.checked += 1;
    /* Already on a row that exists, or the owner put it there: nothing to do. */
    if (r.itemId && byId.has(r.itemId)) continue;
    if (r.reviewed && r.itemId) continue;

    const hit = resolveSpendItem({
      vendor: r.vendor,
      description: r.description,
      hay: [r.subject, r.notes, r.excerpt].filter(Boolean).join(" \n "),
      amountUsd: r.amountUsd,
      period: r.period,
    }, items);

    if (!hit) { out.unlinked += 1; continue; }

    out.linked += 1;
    out.links.push({
      id: r.id, vendor: r.vendor, description: r.description, amountUsd: r.amountUsd,
      period: r.period, label: hit.item.label, why: hit.matchedBy,
    });
    if (!opts.dryRun) {
      r.itemId = hit.item.id;
      r.matchedBy = hit.matchedBy;
      r.updatedAt = nowIso();
      changed = true;
    }
  }

  /* ---- 2. the same charge, filed twice ---- */
  for (const g of findDuplicates(store.receipts)) {
    for (const d of g.drop) {
      out.deduped += 1;
      out.removed.push({
        id: d.id, vendor: d.vendor, amountUsd: d.amountUsd, chargedAt: d.chargedAt,
        keptId: g.keep.id, reason: g.reason,
      });
    }
    if (opts.dryRun) continue;
    /* Anything the discarded copies knew that the keeper does not is carried across before
       they go, so removing a duplicate never loses an invoice number. */
    Object.assign(g.keep, mergeFields(g.keep, g.drop));
    g.keep.updatedAt = nowIso();
    const gone = new Set(g.drop.map((d) => d.id));
    store.receipts = store.receipts.filter((r) => !gone.has(r.id));
    for (const id of gone) await removeArtifacts(id);
    changed = true;
  }

  if (changed) persist();

  /* ---- 3. the price the receipts prove ----
     Last, because it reads what the two steps above just settled: a charge only counts
     towards a row's price once it is ON that row and the copies of it are gone. */
  out.priced = await learnPrices(items, opts.dryRun).catch(() => []);

  return out;
}

/**
 * Collapse every vendor-month CELL down to a single receipt, keeping the best copy.
 *
 * The month-by-month grid is one row per line item, one column per month; a cell is their
 * intersection. A wide sweep can leave a stack of receipts in one cell — an invoice and its
 * payment confirmation, a portal pull and an emailed copy, a re-send, plus genuinely
 * separate charges the vendor billed in the same month. This keeps the ONE best copy per
 * cell and drops the rest, leaving a clean skeleton of one receipt per cell that the owner
 * can top up by hand where a month really did carry more than one charge.
 *
 * The keeper is chosen by the same rule the duplicate sweep uses (copyQuality: the vendor's
 * own document over a bare figure, a rendered shot over a raw file, a portal/email source
 * over an API line), ties broken by the earliest filed so the result is stable. Anything a
 * dropped copy carried that the keeper lacks — an invoice number, a line-item link — is
 * merged onto the keeper first, so no detail is lost with the copy.
 *
 * This is DELIBERATE and destructive across genuinely separate charges too, not just exact
 * duplicates, so it only ever runs from an explicit owner press — never on a page load, or
 * it would eat the second charge the owner just re-added by hand.
 */
export async function collapseToOnePerCell(): Promise<{ removed: number; cells: number }> {
  await ensureReceiptsReady();
  /* Group by the cell the grid would draw the receipt in: its line item when it has one,
     otherwise its vendor, crossed with its billing month. */
  const buckets = new Map<string, Receipt[]>();
  for (const r of store.receipts) {
    const month = r.period && /^\d{4}-\d{2}$/.test(r.period)
      ? r.period
      : String(r.chargedAt || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const key = (r.itemId ? "item:" + r.itemId : "vendor:" + String(r.vendor || "").trim().toLowerCase()) + "|" + month;
    buckets.set(key, [...(buckets.get(key) || []), r]);
  }

  let removed = 0, cells = 0, changed = false;
  for (const [, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const ranked = bucket.slice().sort((a, b) => copyQuality(b) - copyQuality(a) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const keep = ranked[0];
    const drop = ranked.slice(1);
    Object.assign(keep, mergeFields(keep, drop));
    keep.updatedAt = nowIso();
    const gone = new Set(drop.map((d) => d.id));
    store.receipts = store.receipts.filter((r) => !gone.has(r.id));
    for (const id of gone) await removeArtifacts(id);
    removed += drop.length;
    cells += 1;
    changed = true;
  }
  if (changed) persist();
  return { removed, cells };
}

/**
 * Run the one-per-cell collapse ONCE, ever, then remember it did. The Spend master grid
 * calls this on load so a vault a wide sweep left stacked cleans itself the first time the
 * owner opens the page after this shipped — no button press, no SSH. The flag makes it a
 * one-shot: every later load is a no-op, so a second charge the owner re-adds by hand is
 * never touched. Returns what it removed (zero on every run after the first).
 */
export async function collapseToOnePerCellOnce(): Promise<{ removed: number; cells: number; ran: boolean }> {
  await ensureReceiptsReady();
  if (store.onePerCellRunAt) return { removed: 0, cells: 0, ran: false };
  const res = await collapseToOnePerCell();
  store.onePerCellRunAt = nowIso();
  persist();
  return { ...res, ran: true };
}

/** What the console needs to know about whether the vault is tidy, without changing it. */
export async function vaultHealth(): Promise<{ unlinked: number; duplicates: number; linkable: number }> {
  const dry = await repairVault({ dryRun: true });
  return { unlinked: dry.unlinked, duplicates: dry.deduped, linkable: dry.linked };
}

/* ============================ running the sweep ============================ */

/**
 * A sweep reads a mailbox and renders a screenshot per receipt, so it takes minutes, not
 * milliseconds. It runs detached and the console polls: one sweep at a time, and the last
 * report is kept either way (including the failure, which is the useful case).
 */
let inFlight: { startedAt: string; monthsBack: number; mailboxes: string[] } | null = null;

export function harvestState(): { running: boolean; startedAt?: string; mailboxes?: string[] } {
  return inFlight ? { running: true, startedAt: inFlight.startedAt, mailboxes: inFlight.mailboxes } : { running: false };
}

/** Kick off a backfill over the last `monthsBack` calendar months. Returns immediately. */
export function startHarvest(monthsBack = 3): { started: boolean; reason?: string; mailboxes: string[]; readopted?: number } {
  if (inFlight) return { started: false, reason: "a sweep is already running", mailboxes: inFlight.mailboxes };
  const boxes = billingMailboxes();
  if (!boxes.length) return { started: false, reason: "no billing mailbox is configured", mailboxes: [] };
  /* Asking for the mailbox by hand outranks an earlier delete: this is the only way a
     deleted receipt can come back, and it is a deliberate press rather than a timer. */
  const readopted = forgetReceiptDismissals();
  void harvestAll(monthsBack).catch(() => {});
  return { started: true, mailboxes: boxes.map((b) => b.user), readopted };
}

/**
 * Run the sweep to completion and hand back what each mailbox produced. This is the
 * scheduler's entry point: a nightly tick means a month can never quietly pass without its
 * receipts, which a button someone has to remember to press cannot guarantee.
 */
export async function harvestAll(
  monthsBack = 3,
): Promise<{ ok: boolean; reason?: string; reports: SweepReport[]; vault?: VaultRepair | null; shots?: ShotRepair }> {
  if (inFlight) return { ok: false, reason: "a sweep is already running", reports: [] };
  const boxes = billingMailboxes();
  if (!boxes.length) return { ok: false, reason: "no billing mailbox is configured", reports: [] };

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - Math.max(1, Math.min(24, monthsBack)));
  since.setUTCDate(1);
  inFlight = { startedAt: nowIso(), monthsBack, mailboxes: boxes.map((b) => b.user) };

  const reports: SweepReport[] = [];
  let vault: VaultRepair | null = null;
  let shots: ShotRepair = { checked: 0, rendered: 0, alreadyOk: 0, noSource: 0, failed: 0, failures: [] };
  try {
    for (const box of boxes) {
      reports.push(await harvestMailbox(box, since).catch((e: Error) => ({
        at: nowIso(), mailbox: box.user, ok: false, error: e?.message?.slice(0, 300) || "sweep failed",
        since: since.toISOString().slice(0, 10), scanned: 0, billingCandidates: 0, imported: 0,
        duplicates: 0, skippedNotCharge: 0, unparsedAmount: 0, shotsRendered: 0, shotFailures: 0,
        documentsLinked: 0, documentFailures: [], skippedNotOurs: 0, otherSpend: [], byFolder: {}, rejects: [],
      })));
    }

    /* Every sweep ends the same way, however it was started. Put each charge on the line it
       actually paid for and drop any copy already on file, then draw the picture of any
       receipt whose document is on disk but whose PNG is not. This used to live only in the
       synchronous cron path, so a detached sweep (wait=0, which is how the box runs it to
       dodge Caddy's timeout) imported the receipts and stopped there — the console then said
       "no image" over an invoice already sitting on disk, and charges stayed stacked under
       one vendor name instead of on the row each one paid for. Held inside the in-flight
       lock so the grid the owner opens next is finished, not half-swept. */
    vault = await repairVault().catch(() => null);
    shots = await renderMissingShots().catch((e: Error) => ({
      checked: 0, rendered: 0, alreadyOk: 0, noSource: 0, failed: 0,
      failures: [{ id: "-", vendor: "-", period: "-", error: e?.message || "render failed" }],
    }));
  } finally {
    inFlight = null;
  }
  return { ok: reports.some((r) => r.ok), reports, vault, shots };
}

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
