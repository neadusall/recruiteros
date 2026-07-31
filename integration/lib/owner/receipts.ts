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
import { listSpendItems, type SpendItem } from "./spendRegister";
import {
  VENDOR_SOURCES, PROCESSOR_DOMAINS, GENERIC_SUBJECT_HINTS, NON_CHARGE_HINTS,
  vendorSourceFor, type VendorSource,
} from "./receiptSources";
import { resolveSpendItem, findDuplicates, mergeFields } from "./receiptMatch";

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
  /** A PNG of the receipt exists on disk (id.png) — this is what the console shows. */
  hasShot?: boolean;
  shotError?: string;
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
  /** Messages that looked like billing but could not be turned into a row, with why. */
  rejects: Array<{ subject: string; from: string; date: string; reason: string }>;
}

interface ReceiptStore {
  receipts: Receipt[];
  sweeps: SweepReport[];
  lastSweepAt?: string;
  /** Portal pullers, keyed by lowercased vendor. See PullerState. */
  pullers?: Record<string, PullerState>;
  /** When a puller sweep last reported in at all. */
  pullerReportAt?: string;
}

const SNAP_KEY = "owner_spend_receipts_v1";
const store: ReceiptStore = { receipts: [], sweeps: [], pullers: {} };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureReceiptsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<ReceiptStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s && Array.isArray(s.receipts)) store.receipts = s.receipts;
        if (s && Array.isArray(s.sweeps)) store.sweeps = s.sweeps;
        if (s?.lastSweepAt) store.lastSweepAt = s.lastSweepAt;
        if (s?.pullers) store.pullers = s.pullers;
        if (s?.pullerReportAt) store.pullerReportAt = s.pullerReportAt;
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
      const page = await browser.newPage({ viewport: { width: 820, height: 1100 }, deviceScaleFactor: 2 });

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
           </style><div style="padding:24px;max-width:780px">${html}</div>`,
          { waitUntil: "domcontentloaded", timeout: 20_000 },
        );
      }
      const png = await page.screenshot({ fullPage: true, type: "png" });
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

  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">
     <div id="pages"></div>
     <script type="module">
       import * as pdfjs from './pdf.mjs';
       try {
         pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';
         const doc = await pdfjs.getDocument({ url: './doc.pdf' }).promise;
         const host = document.getElementById('pages');
         for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
           const p = await doc.getPage(n);
           const vp = p.getViewport({ scale: 1.6 });
           const c = document.createElement('canvas');
           c.width = vp.width; c.height = vp.height; c.style.display = 'block';
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

async function toPng(bytes: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(bytes).png().toBuffer();
  } catch {
    return bytes;
  }
}

/** Small version for the month grid, so a 40-cell matrix is not 40 full-size PNGs. */
async function makeThumb(id: string): Promise<void> {
  try {
    const sharp = (await import("sharp")).default;
    const dir = receiptsDir();
    const src = await readFile(join(dir, `${id}.png`));
    const out = await sharp(src).resize({ width: 420, withoutEnlargement: true }).png({ quality: 80 }).toBuffer();
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
    if (hasPng && !opts?.force) {
      if (!r.hasShot) { r.hasShot = true; r.shotError = undefined; r.updatedAt = nowIso(); changed = true; }
      /* A PNG with no thumb happens when the thumbnailer failed on its own; the grid falls
         back to the full image, but it is 40 full-size PNGs, so mend it while we are here. */
      if (await fileSize(join(dir, `${r.id}.thumb.png`)) === 0) await makeThumb(r.id);
      out.alreadyOk += 1;
      continue;
    }

    const src = await readSourceDocument(r, dir);
    if (!src) {
      if (r.hasShot) { r.hasShot = false; r.updatedAt = nowIso(); changed = true; }
      out.noSource += 1;
      continue;
    }

    const shot = await renderShot(r.id, shotInputFor(src));
    r.hasShot = shot.ok;
    r.shotError = shot.error;
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

  const kind: ReceiptKind = /\brefund(ed)?\b|credit note|reversal/i.test(low)
    ? (/credit note/i.test(low) ? "credit_note" : "refund")
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

/** Is this message a paid charge, and if not, why not. */
export function classify(msg: MailMessage): { billing: boolean; reason?: string } {
  const hay = `${msg.subject} ${msg.fromName || ""} ${msg.from}`.toLowerCase();
  const body = (msg.text || "").toLowerCase().slice(0, 4000);
  for (const bad of NON_CHARGE_HINTS) {
    if (hay.includes(bad)) return { billing: false, reason: `not a charge: subject says "${bad}"` };
  }
  const domain = (msg.from.split("@")[1] || "").toLowerCase();
  const vendorHit = VENDOR_SOURCES.some((s) => s.from.some((f) => domain === f || domain.endsWith("." + f) || msg.from.toLowerCase() === f));
  const processorHit = PROCESSOR_DOMAINS.some((p) => domain === p || domain.endsWith("." + p));
  const subjectHit = GENERIC_SUBJECT_HINTS.some((h) => hay.includes(h));
  const bodyHit = /amount paid|total paid|payment received|you paid|amount charged|receipt #|invoice #/.test(body);
  if (subjectHit || ((vendorHit || processorHit) && bodyHit)) return { billing: true };
  return { billing: false, reason: "no billing signal in subject, sender or body" };
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

  const bySrc = VENDOR_SOURCES.find((s) => (s.merchant || []).some((mm) => hay.includes(mm)) || hay.includes(s.vendor.toLowerCase()));
  if (bySrc) return bind(bySrc.vendor, 0.7, `vendor named in the message`);

  const byReg = items.find((i) => i.vendor.length > 3 && hay.includes(i.vendor.toLowerCase()));
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

export interface MailboxCfg { user: string; pass: string; host: string; port: number; label: string; inherited?: boolean }

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
  if (!out.length) add(E.RESUME_INBOX_USER || "", E.RESUME_INBOX_PASS || "", E.RESUME_INBOX_HOST || "", E.RESUME_INBOX_PORT || "", true);
  return out;
}

/** Folders worth scanning. Gmail's All Mail catches anything already archived or filtered. */
const FOLDERS = ["INBOX", "Archive", "[Gmail]/All Mail", "Receipts", "Billing"];

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
export async function harvestMailbox(cfg: MailboxCfg, since: Date, opts: { renderShots?: boolean } = {}): Promise<SweepReport> {
  const report: SweepReport = {
    at: nowIso(), mailbox: cfg.user, ok: false, since: since.toISOString().slice(0, 10),
    scanned: 0, billingCandidates: 0, imported: 0, duplicates: 0, skippedNotCharge: 0,
    unparsedAmount: 0, shotsRendered: 0, shotFailures: 0, rejects: [],
  };
  await ensureReceiptsReady();
  const items = await listSpendItems();

  let client: import("imapflow").ImapFlow | null = null;
  try {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
    await client.connect();

    for (const folder of FOLDERS) {
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
          const res = await importMessage(mm, items, cfg.user, { renderShot: opts.renderShots !== false });
          if (res.status === "imported") { report.imported += 1; if (res.shot) report.shotsRendered += 1; if (res.shotError) report.shotFailures += 1; }
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
  opts: { renderShot: boolean },
): Promise<{ status: "imported" | "duplicate" | "rejected"; reason?: string; shot?: boolean; shotError?: string }> {
  const bodyText = mm.text || stripHtml(mm.html || "");
  const pdf = mm.attachments.find((a) => a.contentType.includes("pdf") || /\.pdf$/i.test(a.filename));
  const image = mm.attachments.find((a) => a.contentType.startsWith("image/") && !/^image\/(gif)$/.test(a.contentType) && (a.content?.length || 0) > 8_000);

  let parsed = parseReceiptText(bodyText);
  // Some vendors send an empty body and put everything in the PDF.
  if ((!parsed || !parsed.amountUsd) && pdf) {
    const pdfText = await pdfToText(pdf.content).catch(() => "");
    if (pdfText) parsed = parseReceiptText(pdfText) || parsed;
  }
  if (!parsed || !(parsed.amountUsd > 0)) {
    return { status: "rejected", reason: "no amount could be read from the message or its attachment" };
  }

  const chargedAt = parsed.chargedAt || mm.date.slice(0, 10);
  const period = parsed.period || chargedAt.slice(0, 7);
  /* The amount and the line-item label are what tell one of a vendor's listings from
     another, so the router gets them rather than the raw message alone. */
  const match = matchVendor(mm, items, { amountUsd: parsed.amountUsd, period, description: parsed.description });

  const fingerprint = createHash("sha1")
    .update([mm.messageId || "", match.vendor, parsed.amountUsd.toFixed(2), chargedAt, parsed.invoiceNumber || ""].join("|"))
    .digest("hex");
  // Same message, or the same charge arriving twice (invoice + payment confirmation).
  if (store.receipts.some((r) => fingerprintOf(r) === fingerprint)) return { status: "duplicate" };

  const id = rid("rcpt");
  let hasShot = false, shotError: string | undefined;
  if (opts.renderShot) {
    const shot = await renderShot(id, {
      image: image ? { bytes: image.content, mime: image.contentType } : undefined,
      pdf: !image && pdf ? pdf.content : undefined,
      html: !image && !pdf ? mm.html : undefined,
      text: !image && !pdf && !mm.html ? bodyText : undefined,
    });
    hasShot = shot.ok;
    shotError = shot.error;
    // Keep the original artifact too, so the PDF can be opened as the vendor sent it.
    const src = image || pdf;
    if (src) await saveArtifact(id, `src.${extFromMime(src.contentType, src.filename)}`, src.content).catch(() => {});
  }

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
    fileName: (image || pdf)?.filename,
    fileMime: (image || pdf)?.contentType,
    fileBytes: (image || pdf)?.content?.length,
    hasShot, shotError,
    excerpt: bodyText.replace(/\n{3,}/g, "\n\n").slice(0, 1200),
    confidence: Math.min(1, match.confidence * (parsed.approxFx ? 0.9 : 1)),
    matchedBy: match.matchedBy,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return { status: "imported", shot: hasShot, shotError };
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
    hasShot, shotError, confidence: 1, matchedBy: "entered by the owner", reviewed: true,
    notes: input.notes, createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return r;
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
   * The invoice number is the vendor's own identifier and settles it outright. Without one,
   * vendor + period ALONE is far too coarse: RapidAPI bills five listings inside a single
   * month, so that key made every charge after the first overwrite the one before it and a
   * $433.99 month would have filed as a single $75 row. Falling back to the charge date and
   * the amount keeps a re-run correcting the charge it actually re-read. */
  const chargedDay = (input.chargedAt || "").slice(0, 10);
  const amt = round2(input.amountUsd);
  const existing = store.receipts.find((r) => {
    if (r.source !== "portal" || r.vendor !== input.vendor || r.period !== input.period) return false;
    if (input.reference) return r.invoiceNumber === input.reference;
    if (r.invoiceNumber) return false;
    return (r.chargedAt || "").slice(0, 10) === chargedDay && Math.abs(round2(r.amountUsd)) === Math.abs(amt);
  });
  const id = existing?.id || rid("rcpt");

  /* The document goes to disk before the render is attempted. The render is the fragile
     half and the file is the valuable one: filing it first means a failed render is only
     ever a missing picture, and `renderMissingShots` can come back for it later. */
  await saveArtifact(id, `src.${extFromMime(input.file.mime, input.file.name)}`, input.file.bytes).catch(() => {});
  const shot = await renderShot(id, shotInputFor(input.file));

  const chargedAt = input.chargedAt || `${input.period}-01`;
  const amountUsd = round2(input.amountUsd);

  if (existing) {
    existing.amountUsd = amountUsd;
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
    existing.notes = input.notes ?? existing.notes;
    existing.updatedAt = nowIso();
    persist();
    return { receipt: existing, created: false };
  }

  const r: Receipt = {
    id, period: input.period, vendor: input.vendor,
    itemId: input.itemId || (await lineItemFor(input))?.id,
    description: input.description, amountUsd, currency: input.currency || "USD",
    nativeAmount: input.nativeAmount, invoiceNumber: input.reference,
    chargedAt, kind: input.amountUsd < 0 ? "refund" : "charge", source: "portal",
    fileName: input.file.name, fileMime: input.file.mime, fileBytes: input.file.bytes.length,
    hasShot: shot.ok, shotError: shot.error, confidence: 1,
    matchedBy: "downloaded from the vendor's billing page", reviewed: true,
    notes: input.notes, createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
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
  const n = store.receipts.length;
  store.receipts = store.receipts.filter((r) => r.id !== id);
  if (store.receipts.length === n) return false;
  await removeArtifacts(id);
  persist();
  return true;
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
  /** What moved, so the change is readable rather than something that just happened. */
  links: Array<{ id: string; vendor: string; description?: string; amountUsd: number; period: string; label: string; why: string }>;
  removed: Array<{ id: string; vendor: string; amountUsd: number; chargedAt: string; keptId: string; reason: string }>;
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
  const out: VaultRepair = { checked: 0, linked: 0, unlinked: 0, deduped: 0, links: [], removed: [] };
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
  return out;
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
export function startHarvest(monthsBack = 3): { started: boolean; reason?: string; mailboxes: string[] } {
  if (inFlight) return { started: false, reason: "a sweep is already running", mailboxes: inFlight.mailboxes };
  const boxes = billingMailboxes();
  if (!boxes.length) return { started: false, reason: "no billing mailbox is configured", mailboxes: [] };
  void harvestAll(monthsBack).catch(() => {});
  return { started: true, mailboxes: boxes.map((b) => b.user) };
}

/**
 * Run the sweep to completion and hand back what each mailbox produced. This is the
 * scheduler's entry point: a nightly tick means a month can never quietly pass without its
 * receipts, which a button someone has to remember to press cannot guarantee.
 */
export async function harvestAll(monthsBack = 3): Promise<{ ok: boolean; reason?: string; reports: SweepReport[] }> {
  if (inFlight) return { ok: false, reason: "a sweep is already running", reports: [] };
  const boxes = billingMailboxes();
  if (!boxes.length) return { ok: false, reason: "no billing mailbox is configured", reports: [] };

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - Math.max(1, Math.min(24, monthsBack)));
  since.setUTCDate(1);
  inFlight = { startedAt: nowIso(), monthsBack, mailboxes: boxes.map((b) => b.user) };

  const reports: SweepReport[] = [];
  try {
    for (const box of boxes) {
      reports.push(await harvestMailbox(box, since).catch((e: Error) => ({
        at: nowIso(), mailbox: box.user, ok: false, error: e?.message?.slice(0, 300) || "sweep failed",
        since: since.toISOString().slice(0, 10), scanned: 0, billingCandidates: 0, imported: 0,
        duplicates: 0, skippedNotCharge: 0, unparsedAmount: 0, shotsRendered: 0, shotFailures: 0, rejects: [],
      })));
    }
  } finally {
    inFlight = null;
  }
  return { ok: reports.some((r) => r.ok), reports };
}

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
