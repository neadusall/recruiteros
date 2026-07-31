/**
 * RecruitersOS · Owner · Portal receipt pullers (OWNER ONLY)
 *
 * The third channel, after email and the billing APIs. Some vendors never email a usable
 * receipt: Smartlead's Stripe receipts have never once arrived in the billing mailbox, so
 * every month it bills is a month the books cannot prove. Email cannot be fixed from this
 * side, and no invoice API exists. What does exist is the vendor's own billing page, which
 * has the invoice sitting on it. So we go and get it.
 *
 * A logged-in headless Chromium opens the billing page, reads the invoice table, and
 * downloads the real PDF the vendor issued. That file is filed as the receipt: the same
 * artifact a human would have downloaded by hand, not a reconstruction of one.
 *
 * WHAT MAKES THIS SAFE TO RUN UNATTENDED. Scraping someone else's UI is inherently brittle:
 * portals get redesigned, sessions lapse, a receipt renders as a page instead of a file. So
 * this module is built to fail LOUDLY rather than to never fail:
 *
 *   - every path returns a report; nothing here throws into the caller
 *   - every run is persisted the moment it ends, including catastrophic ones, so a vendor
 *     that stopped working shows the date it stopped and the reason
 *   - a whole-run watchdog means a hung page cannot wedge the nightly tick
 *   - failures are CLASSIFIED into something actionable ("sign in again" vs "the page moved")
 *   - a failed run saves a screenshot of whatever the browser was actually looking at, so a
 *     recipe that broke can be fixed by looking at it rather than by guessing
 *   - a month is never marked receipted on a partial success; if the file did not download,
 *     the gap stays open and the console keeps asking for it
 *
 * CREDENTIALS ARE NOT STORED HERE. This module never sees a password. It reads a browser
 * session that the owner mints themselves by signing in once (portal-login.mjs),
 * and when that session lapses it says so and stops. The session file is the only secret,
 * it lives on the server's data volume, and it can be revoked by signing out at the vendor.
 */

import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { recordPortalReceipt } from "./receipts";
import { listSpendItems } from "./spendRegister";

/* ============================ what can go wrong ============================ */

/**
 * Failure kinds exist so the console can tell the owner what to DO. "It broke" is not
 * actionable; "your Smartlead session expired, sign in again" is.
 */
export type PullFailure =
  /** No session file has ever been minted for this vendor. */
  | "no_session"
  /** There is a session but the portal bounced us to its login page. */
  | "session_expired"
  /** The page loaded but nothing on it looks like an invoice table. */
  | "portal_changed"
  /** The table was found and read, but it lists no charges at all. */
  | "no_rows"
  /** Rows were found; the receipt file behind them could not be retrieved. */
  | "download_failed"
  /** Chromium itself is missing or refused to start. */
  | "browser_unavailable"
  /** The run hit its watchdog. */
  | "timeout"
  | "unknown";

export interface PulledMonth {
  period: string;
  amountUsd: number;
  reference: string;
  chargedAt: string;
  /** False when the row was read but its PDF could not be saved. */
  receiptFiled: boolean;
  /** Present when the row was read but the document was not. */
  problem?: string;
  created: boolean;
}

export interface PortalPullReport {
  vendor: string;
  at: string;
  ok: boolean;
  failure?: PullFailure;
  error?: string;
  /** One line telling the owner exactly what to do about a failure. */
  fix?: string;
  /** Rows read off the billing page, whether or not their file came down. */
  months: PulledMonth[];
  /** How many receipts actually landed on disk this run. */
  filed: number;
  /** Rows seen on the page in total, before the month filter. */
  rowsSeen: number;
  /** Screenshot of what the browser was looking at when it failed. */
  shot?: string;
  finalUrl?: string;
  attempts: number;
  ms: number;
  notes: string[];
}

/* ============================ recipes ============================ */

interface PortalRecipe {
  /** Must match SpendItem.vendor / VENDOR_SOURCES.vendor. */
  vendor: string;
  /** The page holding the invoice history. */
  billingUrl: string;
  /** Where the owner signs in when minting a session. */
  loginUrl: string;
  /** Substrings that mean "we got bounced to a login wall". */
  loginMarkers?: string[];
  /**
   * Anything that must be clicked before the invoice table renders (a "Billing" tab, an
   * "Invoice history" accordion). Tried in order, failures ignored: a portal that shows the
   * table outright should not fail because an optional tab was not there.
   */
  reveal?: string[];
  /** Extra wait once the page settles, for tables that fill in late. */
  settleMs?: number;
  currency?: string;
  note?: string;
}

/**
 * Vendors worth pulling. The bar for being here is that email has demonstrably failed and
 * the invoice is reachable behind a normal login. Everything else stays on the mailbox
 * sweep, which is cheaper and less brittle.
 */
const RECIPES: PortalRecipe[] = [
  {
    vendor: "Smartlead",
    billingUrl: "https://app.smartlead.ai/app/settings/billing",
    loginUrl: "https://app.smartlead.ai/login",
    loginMarkers: ["/login", "/signin", "sign in to your account"],
    reveal: ["text=Invoice history", "text=Billing history", "text=Invoices", "[role=tab]:has-text('Billing')"],
    settleMs: 2500,
    note: "Stripe receipts for this account have never reached the billing mailbox, so the invoice history page is the only place the document exists.",
  },
];

export const PORTAL_PULLER_VENDORS: string[] = RECIPES.map((r) => r.vendor);

export function portalRecipeFor(vendor: string): { vendor: string; billingUrl: string; loginUrl: string; note?: string } | undefined {
  const v = (vendor || "").trim().toLowerCase();
  const r = RECIPES.find((x) => x.vendor.toLowerCase() === v);
  return r && { vendor: r.vendor, billingUrl: r.billingUrl, loginUrl: r.loginUrl, note: r.note };
}

/* ============================ where things live ============================ */

function dataDir(): string {
  return process.env.ROS_DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : join(process.cwd(), ".data"));
}
function sessionPath(vendor: string): string {
  return join(dataDir(), "portal-sessions", `${vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
}
function shotDir(): string {
  return join(dataDir(), "portal-pulls");
}

/** Session files are the one secret here, so report on them without ever reading them out. */
export async function portalSessionState(vendor: string): Promise<{ present: boolean; mintedAt?: string; path: string }> {
  const path = sessionPath(vendor);
  try {
    const raw = await readFile(path, "utf8");
    const j = JSON.parse(raw) as { mintedAt?: string };
    return { present: true, mintedAt: j.mintedAt, path };
  } catch {
    return { present: false, path };
  }
}

/* ============================ the report store ============================ */

interface PullStore { runs: PortalPullReport[] }
const SNAP_KEY = "owner_portal_pulls_v1";
const store: PullStore = { runs: [] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensurePortalPullsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<PullStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => { if (s && Array.isArray(s.runs)) store.runs = s.runs; })
      .catch(() => {});
  }
  return hydrated;
}
void ensurePortalPullsReady();

/** Newest run per vendor: what the console shows as "is this working". */
export function lastPortalPulls(): PortalPullReport[] {
  const seen = new Set<string>();
  const out: PortalPullReport[] = [];
  for (const r of store.runs) {
    if (seen.has(r.vendor)) continue;
    seen.add(r.vendor);
    out.push(r);
  }
  return out;
}

export function portalPullHistory(vendor: string, limit = 10): PortalPullReport[] {
  return store.runs.filter((r) => r.vendor.toLowerCase() === vendor.toLowerCase()).slice(0, limit);
}

async function fileReport(report: PortalPullReport): Promise<void> {
  await ensurePortalPullsReady();
  store.runs.unshift(report);
  /* Keep a season of history per vendor, not forever: enough to see "it broke on the 3rd". */
  if (store.runs.length > 200) store.runs.length = 200;
  persist();
}

export async function readPullShot(name: string): Promise<Buffer | null> {
  /* Name comes off a report we wrote, but treat it as untrusted anyway. */
  if (!/^[a-z0-9._-]+\.png$/i.test(name)) return null;
  try {
    return await readFile(join(shotDir(), name));
  } catch {
    return null;
  }
}

/** Failure screenshots are diagnostic, not archival: keep the recent ones only. */
async function pruneShots(keep = 40): Promise<void> {
  try {
    const dir = shotDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await unlink(join(dir, f)).catch(() => {});
    }
  } catch { /* nothing to prune */ }
}

/* ============================ reading the page ============================ */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Dates on billing pages come in every shape. Parse the common ones explicitly rather than
 * handing the string to `new Date()`, which silently reads 03/04/2026 as March in one locale
 * and April in another. An ambiguous numeric date is rejected instead of guessed, because a
 * charge filed to the wrong month is worse than a charge flagged as unreadable.
 */
function parseRowDate(text: string): string | undefined {
  const t = text.replace(/ /g, " ").trim();

  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  /* "Jul 26, 2026" / "26 July 2026" / "July 26 2026" */
  const named = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/)
    || t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/);
  if (named) {
    const monthWord = /^[A-Za-z]/.test(named[1]) ? named[1] : named[2];
    const dayStr = /^[A-Za-z]/.test(named[1]) ? named[2] : named[1];
    const m = MONTHS[monthWord.slice(0, 3).toLowerCase()];
    if (m) return `${named[3]}-${String(m).padStart(2, "0")}-${String(Number(dayStr)).padStart(2, "0")}`;
  }
  return undefined;
}

function parseAmount(text: string): { amount: number; currency: string } | undefined {
  const m = text.match(/(?:(US)?\$|USD\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/i)
    || text.match(/(\d{1,3}(?:,\d{3})*\.\d{2})\s*(USD)/i);
  if (!m) return undefined;
  const raw = (m[2] || m[1] || "").replace(/,/g, "");
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { amount, currency: "USD" };
}

/** A row that says the charge did not go through is not a receipt. */
const UNPAID = /\b(fail|declin|refus|unpaid|past due|void|open|draft|pending)\b/i;
const PAID = /\b(paid|succeed|success|complete)\b/i;

interface RawRow {
  text: string;
  date?: string;
  amountUsd?: number;
  reference?: string;
  description?: string;
  paid: boolean;
  /** Absolute hrefs on the row that might be the document. */
  links: string[];
}

/**
 * Read anything table-shaped off the page. Deliberately structure-agnostic: match on what
 * the row SAYS (a date, a currency amount, a paid marker) rather than on class names, so a
 * restyle does not break the pull. Class names change constantly; "$174.00" does not.
 */
async function readRows(page: import("playwright").Page): Promise<RawRow[]> {
  return page.evaluate(() => {
    const out: Array<{ text: string; links: string[] }> = [];
    const seen = new Set<Element>();

    const push = (el: Element) => {
      if (seen.has(el)) return;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < 6 || text.length > 400) return;
      seen.add(el);
      const links: string[] = [];
      el.querySelectorAll("a[href]").forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        if (href && !href.startsWith("javascript:")) links.push(href);
      });
      out.push({ text, links });
    };

    document.querySelectorAll("tbody tr, table tr").forEach(push);
    /* Portals that build "tables" out of divs still mark them up for screen readers. */
    document.querySelectorAll('[role="row"], [role="listitem"], li').forEach(push);
    return out;
  }).then((rows) =>
    rows.map((r): RawRow => {
      const date = parseRowDate(r.text);
      const amt = parseAmount(r.text);
      const ref = r.text.match(/\b((?:INV|HAWF|RCPT)[A-Z0-9-]{4,}|[A-Z0-9]{4,}-\d{3,})\b/)?.[1];
      return {
        text: r.text,
        date,
        amountUsd: amt?.amount,
        reference: ref,
        description: r.text.slice(0, 160),
        paid: PAID.test(r.text) || !UNPAID.test(r.text),
        links: r.links,
      };
    }),
  );
}

const DOC_LINK = /invoice|receipt|\.pdf|billing_?portal|download|charge|in_[a-z0-9]{10,}/i;

/**
 * Get the actual document behind a row.
 *
 * Three ways, in descending fidelity: fetch the vendor's own PDF over the logged-in session;
 * follow the link and print whatever page it lands on; give up and say so. The third is a
 * real outcome, not an error to swallow, because a row without a document is a month we
 * still cannot prove.
 */
async function fetchDocument(
  ctx: import("playwright").BrowserContext,
  page: import("playwright").Page,
  row: RawRow,
): Promise<{ bytes: Buffer; mime: string; name: string } | { problem: string }> {
  const candidates = row.links.filter((h) => DOC_LINK.test(h));
  const tried: string[] = [];

  for (const href of candidates.slice(0, 4)) {
    tried.push(href);
    /* The API request shares the context's cookies, so this is the same fetch the browser
       would make, minus the rendering. A PDF comes back as a PDF. */
    try {
      const res = await ctx.request.get(href, { timeout: 45_000 });
      if (res.ok()) {
        const mime = (res.headers()["content-type"] || "").split(";")[0].trim();
        const bytes = Buffer.from(await res.body());
        if (mime.includes("pdf") || bytes.subarray(0, 4).toString() === "%PDF") {
          return { bytes, mime: "application/pdf", name: "invoice.pdf" };
        }
        if (mime.startsWith("image/")) return { bytes, mime, name: "invoice" };
        /* An HTML receipt page: open it properly so it prints with its styles. */
        if (mime.includes("html")) {
          const printed = await printPage(ctx, href);
          if ("bytes" in printed) return printed;
        }
      }
    } catch { /* fall through to the next candidate */ }
  }

  /* Nothing linked out. Some portals open the receipt from a menu instead, so try clicking
     the row and catching whatever download or tab it produces. */
  const clicked = await clickForDownload(page, row);
  if ("bytes" in clicked) return clicked;

  return {
    problem: candidates.length
      ? `the row's ${candidates.length} link(s) returned no document`
      : "no invoice link on the row",
  };
}

async function printPage(
  ctx: import("playwright").BrowserContext,
  url: string,
): Promise<{ bytes: Buffer; mime: string; name: string } | { problem: string }> {
  let page: import("playwright").Page | null = null;
  try {
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return { bytes: Buffer.from(pdf), mime: "application/pdf", name: "invoice.pdf" };
  } catch (e) {
    return { problem: `could not print the receipt page (${(e as Error).message.slice(0, 90)})` };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** Last resort: click the row's own control and catch a download event. */
async function clickForDownload(
  page: import("playwright").Page,
  row: RawRow,
): Promise<{ bytes: Buffer; mime: string; name: string } | { problem: string }> {
  try {
    const anchor = row.reference || row.date;
    if (!anchor) return { problem: "no anchor text to click" };
    const scope = page.locator(`tr:has-text("${anchor}"), [role="row"]:has-text("${anchor}")`).first();
    if (!(await scope.count())) return { problem: "row not clickable" };

    const trigger = scope.locator('a, button, [role="button"]').filter({ hasText: /invoice|receipt|download|pdf|view/i }).first();
    if (!(await trigger.count())) return { problem: "no receipt control on the row" };

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      trigger.click({ timeout: 10_000 }),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return { problem: "the download was empty" };
    return { bytes, mime: "application/pdf", name: download.suggestedFilename() || "invoice.pdf" };
  } catch (e) {
    return { problem: `clicking the row produced no file (${(e as Error).message.slice(0, 90)})` };
  }
}

/* ============================ one vendor, one run ============================ */

const RUN_BUDGET_MS = 240_000;

function periodsBack(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, Math.min(24, n)); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function failReport(vendor: string, failure: PullFailure, error: string, fix: string, started: number, attempts = 1): PortalPullReport {
  return {
    vendor, at: nowIso(), ok: false, failure, error, fix,
    months: [], filed: 0, rowsSeen: 0, attempts, ms: Date.now() - started, notes: [],
  };
}

/**
 * Pull one vendor. Returns a report in every case, including when the browser will not
 * start: the caller's job is to record what happened, never to handle an exception.
 */
export async function pullPortal(vendor: string, opts: { monthsBack?: number; retries?: number } = {}): Promise<PortalPullReport> {
  const started = Date.now();
  const recipe = RECIPES.find((r) => r.vendor.toLowerCase() === vendor.toLowerCase());
  if (!recipe) return failReport(vendor, "unknown", `no portal recipe for ${vendor}`, "This vendor is not set up for portal pulls.", started);

  const session = await portalSessionState(recipe.vendor);
  if (!session.present) {
    return failReport(
      recipe.vendor, "no_session", "no saved browser session for this vendor",
      `Sign in once with: node portal-login.mjs ${recipe.vendor.toLowerCase()}`,
      started,
    );
  }

  const maxAttempts = Math.max(1, Math.min(3, (opts.retries ?? 2)));
  let last: PortalPullReport | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const report = await attemptPull(recipe, session.path, opts.monthsBack ?? 3, attempt, started);
    last = report;
    if (report.ok) break;
    /* Only transient classes are worth another go. A lapsed session or a moved page will
       fail identically three times in a row and just delay the report. */
    if (report.failure !== "timeout" && report.failure !== "unknown" && report.failure !== "browser_unavailable") break;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 4000));
  }

  const report = last || failReport(recipe.vendor, "unknown", "no attempt ran", "Run the pull again.", started);
  await fileReport(report);
  await pruneShots();
  return report;
}

async function attemptPull(
  recipe: PortalRecipe,
  sessionFile: string,
  monthsBack: number,
  attempt: number,
  started: number,
): Promise<PortalPullReport> {
  const report: PortalPullReport = {
    vendor: recipe.vendor, at: nowIso(), ok: false, months: [], filed: 0,
    rowsSeen: 0, attempts: attempt, ms: 0, notes: [],
  };
  const done = () => { report.ms = Date.now() - started; return report; };

  let browser: import("playwright").Browser | null = null;
  let ctx: import("playwright").BrowserContext | null = null;

  /* The watchdog is the difference between a slow night and a wedged cron. */
  let watchdog: NodeJS.Timeout | null = null;
  const budget = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error("run exceeded its time budget")), RUN_BUDGET_MS);
  });

  try {
    const work = (async () => {
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (e) {
        report.failure = "browser_unavailable";
        report.error = (e as Error).message.slice(0, 200);
        report.fix = "Playwright is not installed in this image.";
        return;
      }

      try {
        browser = await chromium.launch({
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
      } catch (e) {
        report.failure = "browser_unavailable";
        report.error = (e as Error).message.slice(0, 200);
        report.fix = "Chromium would not start on the server; check the Playwright browser install.";
        return;
      }

      ctx = await browser.newContext({
        storageState: sessionFile,
        viewport: { width: 1400, height: 1000 },
        acceptDownloads: true,
      });
      ctx.setDefaultTimeout(30_000);
      const page = await ctx.newPage();

      await page.goto(recipe.billingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(recipe.settleMs ?? 2000);

      /* Did the portal bounce us to a login wall? Check the URL and the page both: some
         apps keep the URL and swap the body. */
      const url = page.url();
      report.finalUrl = url;
      const bodyText = ((await page.textContent("body").catch(() => "")) || "").toLowerCase();
      const bounced =
        (recipe.loginMarkers || ["/login", "/signin"]).some((m) => url.toLowerCase().includes(m) || bodyText.includes(m))
        || (await page.locator('input[type="password"]').count()) > 0;
      if (bounced) {
        report.failure = "session_expired";
        report.error = `the portal redirected to a sign-in page (${url})`;
        report.fix = `The saved session has lapsed. Re-run: node portal-login.mjs ${recipe.vendor.toLowerCase()}`;
        report.shot = await captureShot(page, recipe.vendor);
        return;
      }

      for (const sel of recipe.reveal || []) {
        await page.locator(sel).first().click({ timeout: 3000 }).catch(() => {});
      }
      await page.waitForTimeout(1200);

      const rows = await readRows(page);
      const charges = rows.filter((r) => r.date && r.amountUsd && r.paid);
      report.rowsSeen = charges.length;

      if (!charges.length) {
        /* Distinguish "the page is not what we expected" from "there genuinely are no
           charges". Both are reported, but only one needs a code change. */
        const looksLikeBilling = /invoice|billing|receipt|payment/i.test(bodyText);
        report.failure = looksLikeBilling ? "no_rows" : "portal_changed";
        report.error = looksLikeBilling
          ? "the billing page lists no paid charges"
          : "no invoice table was found on the billing page";
        report.fix = looksLikeBilling
          ? "Nothing to file. If you know this month was billed, download it by hand and attach it."
          : `The portal layout changed. Open ${recipe.billingUrl} and check where the invoice list moved to.`;
        report.shot = await captureShot(page, recipe.vendor);
        return;
      }

      const wanted = new Set(periodsBack(monthsBack));
      const items = await listSpendItems().catch(() => []);
      const item = items.find((i) => i.vendor.toLowerCase() === recipe.vendor.toLowerCase());

      for (const row of charges) {
        const period = row.date!.slice(0, 7);
        if (!wanted.has(period)) continue;

        const doc = await fetchDocument(ctx, page, row);
        const reference = row.reference || `${recipe.vendor.toLowerCase()}-${row.date}`;

        if ("problem" in doc) {
          /* The charge is real and we read it, but the proof did not come down. File the
             row as seen and leave the month open: the console keeps asking. */
          report.months.push({
            period, amountUsd: row.amountUsd!, reference, chargedAt: row.date!,
            receiptFiled: false, problem: doc.problem, created: false,
          });
          continue;
        }

        const { created } = await recordPortalReceipt({
          vendor: recipe.vendor,
          itemId: item?.id,
          period,
          amountUsd: row.amountUsd!,
          reference,
          chargedAt: row.date!,
          description: row.description,
          file: doc,
          notes: `Downloaded from ${recipe.vendor}'s billing page on ${new Date().toISOString().slice(0, 10)}. This is the vendor's own document.`,
        });
        report.months.push({ period, amountUsd: row.amountUsd!, reference, chargedAt: row.date!, receiptFiled: true, created });
        report.filed++;
      }

      const unfiled = report.months.filter((m) => !m.receiptFiled);
      if (report.months.length && unfiled.length === report.months.length) {
        report.failure = "download_failed";
        report.error = `read ${report.months.length} charge(s) but could not download any receipt`;
        report.fix = `Open ${recipe.billingUrl} and download the invoice by hand, then attach it here.`;
        report.shot = await captureShot(page, recipe.vendor);
        return;
      }

      if (unfiled.length) {
        report.notes.push(`${unfiled.length} charge(s) were read but their document did not come down; those months stay open.`);
      }
      if (!report.months.length) {
        report.notes.push(`${charges.length} charge(s) on the page, none inside the last ${monthsBack} month(s).`);
      }
      report.ok = true;
    })();

    await Promise.race([work, budget]);
    return done();
  } catch (e) {
    const msg = (e as Error)?.message || "unknown failure";
    report.failure = /time budget|timeout|Timeout/i.test(msg) ? "timeout" : "unknown";
    report.error = msg.slice(0, 300);
    report.fix = report.failure === "timeout"
      ? "The portal did not respond in time. The next scheduled run will try again."
      : `Unexpected failure while reading ${recipe.billingUrl}.`;
    return done();
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/** A picture of what the browser was actually looking at. Worth more than any error string. */
async function captureShot(page: import("playwright").Page, vendor: string): Promise<string | undefined> {
  try {
    const name = `${vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}.png`;
    const dir = shotDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), await page.screenshot({ fullPage: true, type: "png" }));
    return name;
  } catch {
    return undefined;
  }
}

/* ============================ the scheduled entry point ============================ */

/**
 * Run every configured portal. Vendors run one at a time on purpose: each one starts a
 * Chromium, and the app server has better things to do with its memory than run four.
 */
export async function pullAllPortals(monthsBack = 3): Promise<PortalPullReport[]> {
  const out: PortalPullReport[] = [];
  for (const r of RECIPES) {
    out.push(await pullPortal(r.vendor, { monthsBack }).catch((e) => ({
      vendor: r.vendor, at: nowIso(), ok: false, failure: "unknown" as PullFailure,
      error: (e as Error)?.message?.slice(0, 200) || "unknown", fix: "Run the pull again.",
      months: [], filed: 0, rowsSeen: 0, attempts: 1, ms: 0, notes: [],
    })));
  }
  return out;
}
