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
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { listSpendItems, type SpendItem, monthlyEquivalent } from "./spendRegister";
import {
  VENDOR_SOURCES, PROCESSOR_DOMAINS, GENERIC_SUBJECT_HINTS, NON_CHARGE_HINTS,
  vendorSourceFor, type VendorSource,
} from "./receiptSources";

/* ============================ types ============================ */

export type ReceiptKind = "charge" | "refund" | "credit_note";
/** Where a figure came from. `api` is the vendor's own billing API: authoritative on the
 *  number, but there is no invoice image behind it, and the console says so rather than
 *  drawing a receipt that was never issued. `portal` is the vendor's own PDF, downloaded
 *  from their billing page by a logged-in browser: the same document a human would have
 *  fetched by hand, so it carries a real image and counts as proof. */
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
}

const SNAP_KEY = "owner_spend_receipts_v1";
const store: ReceiptStore = { receipts: [], sweeps: [] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureReceiptsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<ReceiptStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s && Array.isArray(s.receipts)) store.receipts = s.receipts;
        if (s && Array.isArray(s.sweeps)) store.sweeps = s.sweeps;
        if (s?.lastSweepAt) store.lastSweepAt = s.lastSweepAt;
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

async function renderPdfPage(page: import("playwright").Page, pdf: Buffer): Promise<void> {
  const { createRequire } = await import("node:module");
  // Resolve from the app root rather than import.meta.url: the compiled server bundle is
  // CJS, where import.meta is not available.
  const require_ = createRequire(join(process.cwd(), "noop.js"));
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
export function matchVendor(msg: MailMessage, items: SpendItem[]): VendorMatch {
  const domain = (msg.from.split("@")[1] || "").toLowerCase();
  const hay = `${msg.subject} ${msg.fromName || ""} ${msg.text || ""}`.toLowerCase();
  const processor = PROCESSOR_DOMAINS.find((p) => domain === p || domain.endsWith("." + p));

  const bind = (vendor: string, confidence: number, matchedBy: string): VendorMatch => {
    const item = pickItem(vendor, hay, items);
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
    if (reg) return { vendor: reg.vendor, itemId: reg.id, processor, confidence: 0.85, matchedBy: `merchant "${named}"` };
    return { vendor: titleCase(named), processor, confidence: 0.55, matchedBy: `merchant "${named}", no register row` };
  }

  const bySrc = VENDOR_SOURCES.find((s) => (s.merchant || []).some((mm) => hay.includes(mm)) || hay.includes(s.vendor.toLowerCase()));
  if (bySrc) return bind(bySrc.vendor, 0.7, `vendor named in the message`);

  const byReg = items.find((i) => i.vendor.length > 3 && hay.includes(i.vendor.toLowerCase()));
  if (byReg) return { vendor: byReg.vendor, itemId: byReg.id, processor, confidence: 0.6, matchedBy: "register vendor named in the message" };

  const fallback = domain.split(".").slice(-2)[0] || "Unknown";
  return { vendor: titleCase(fallback), processor, confidence: 0.3, matchedBy: `unrecognised sender ${domain}` };
}

/**
 * A vendor can own several register rows (RapidAPI owns five). Prefer the row whose label
 * is actually named in the receipt; otherwise the most expensive active row, which is the
 * safest default because it is the one an owner would notice being wrong.
 */
function pickItem(vendor: string, hay: string, items: SpendItem[]): SpendItem | undefined {
  const own = items.filter((i) => i.vendor.toLowerCase() === vendor.toLowerCase());
  if (!own.length) return undefined;
  if (own.length === 1) return own[0];
  const named = own.find((i) => {
    const core = i.label.replace(/\(.*?\)/g, "").trim().toLowerCase();
    return core.length > 3 && hay.includes(core);
  });
  if (named) return named;
  return own.slice().sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a))[0];
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
    report.error = (e as Error)?.message?.slice(0, 300) || "mailbox error";
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

  const match = matchVendor(mm, items);
  const chargedAt = parsed.chargedAt || mm.date.slice(0, 10);
  const period = parsed.period || chargedAt.slice(0, 7);

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
    const isPdf = input.file.mime.includes("pdf") || /\.pdf$/i.test(input.file.name);
    const isImage = input.file.mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(input.file.name);
    const isHtml = input.file.mime.includes("html") || /\.html?$/i.test(input.file.name);
    const shot = await renderShot(id, isPdf
      ? { pdf: input.file.bytes }
      : isImage
        ? { image: { bytes: input.file.bytes, mime: input.file.mime } }
        : isHtml
          ? { html: input.file.bytes.toString("utf8") }
          : { text: input.file.bytes.toString("utf8").slice(0, 20_000) });
    hasShot = shot.ok; shotError = shot.error;
    await saveArtifact(id, `src.${extFromMime(input.file.mime, input.file.name)}`, input.file.bytes).catch(() => {});
  }
  const chargedAt = input.chargedAt || `${input.period}-01`;
  const r: Receipt = {
    id, period: input.period, vendor: input.vendor, itemId: input.itemId,
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
    id: rid("rcpt"), period: input.period, vendor: input.vendor, itemId: input.itemId,
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
 * File a receipt downloaded from a vendor's own billing page by the portal puller.
 *
 * Unlike an API figure, this HAS a document behind it: the vendor's PDF, saved as-is and
 * rendered like any hand-attached receipt, so the console shows the real invoice.
 *
 * Keyed on vendor + period + reference so the nightly run is idempotent: the same invoice
 * re-read next week updates its row instead of stacking a duplicate. An existing row is
 * never downgraded — if the picture already rendered, a later run that arrives without one
 * leaves it alone rather than replacing proof with a blank.
 */
export async function recordPortalReceipt(input: {
  vendor: string; itemId?: string; period: string; amountUsd: number;
  reference: string; chargedAt?: string; description?: string; notes?: string;
  file?: { bytes: Buffer; mime: string; name: string };
}): Promise<{ receipt: Receipt; created: boolean }> {
  await ensureReceiptsReady();
  const existing = store.receipts.find(
    (r) => r.source === "portal" && r.vendor === input.vendor && r.period === input.period && r.invoiceNumber === input.reference,
  );

  const id = existing?.id || rid("rcpt");
  let hasShot = existing?.hasShot || false;
  let shotError = existing?.shotError;

  /* Render only when there is something new to render: a re-run over a month already on
     file should cost nothing. */
  if (input.file && !hasShot) {
    const isPdf = input.file.mime.includes("pdf") || /\.pdf$/i.test(input.file.name);
    const isImage = input.file.mime.startsWith("image/");
    const shot = await renderShot(id, isPdf
      ? { pdf: input.file.bytes }
      : isImage
        ? { image: { bytes: input.file.bytes, mime: input.file.mime } }
        : { html: input.file.bytes.toString("utf8").slice(0, 400_000) });
    hasShot = shot.ok;
    shotError = shot.error;
    await saveArtifact(id, `src.${extFromMime(input.file.mime, input.file.name)}`, input.file.bytes).catch(() => {});
  }

  if (existing) {
    existing.amountUsd = round2(input.amountUsd);
    existing.description = input.description ?? existing.description;
    existing.chargedAt = input.chargedAt || existing.chargedAt;
    existing.notes = input.notes ?? existing.notes;
    existing.hasShot = hasShot;
    existing.shotError = shotError;
    if (input.file) {
      existing.fileName = input.file.name;
      existing.fileMime = input.file.mime;
      existing.fileBytes = input.file.bytes.length;
    }
    existing.updatedAt = nowIso();
    persist();
    return { receipt: existing, created: false };
  }

  const r: Receipt = {
    id, period: input.period, vendor: input.vendor, itemId: input.itemId,
    description: input.description, amountUsd: round2(input.amountUsd), currency: "USD",
    invoiceNumber: input.reference, chargedAt: input.chargedAt || `${input.period}-01`,
    kind: input.amountUsd < 0 ? "refund" : "charge", source: "portal",
    fileName: input.file?.name, fileMime: input.file?.mime, fileBytes: input.file?.bytes.length,
    hasShot, shotError, confidence: 1,
    matchedBy: "downloaded from the vendor's billing page",
    notes: input.notes, createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.receipts.push(r);
  persist();
  return { receipt: r, created: true };
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
  const dir = receiptsDir();
  for (const f of [`${id}.png`, `${id}.thumb.png`]) await unlink(join(dir, f)).catch(() => {});
  persist();
  return true;
}

export function lastSweeps(): SweepReport[] { return store.sweeps.slice(0, 10); }
export function lastSweepAt(): string | undefined { return store.lastSweepAt; }

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
