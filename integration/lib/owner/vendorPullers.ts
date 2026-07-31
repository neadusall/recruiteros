/**
 * RecruitersOS · Owner · Vendor billing pullers (OWNER ONLY)
 *
 * Email is the channel that works for every vendor, but it is not the best one where a real
 * billing API exists — an API cannot be missed, filtered into spam, or deleted. This module
 * holds the exceptions.
 *
 * TELNYX (the only one found so far, confirmed live against the production key):
 *   GET /v2/invoices        one record per billing month: invoice id, period, paid flag.
 *                           This is the SPINE: a month is filed only once Telnyx has closed
 *                           and issued its invoice, so the console reads like a set of
 *                           month-end invoices rather than a live meter.
 *   GET /v2/usage_reports   per-product usage with a `cost` metric, summed over the closed
 *                           billing period to get the total Telnyx exposes nowhere else.
 *   GET /v2/balance         the account balance behind auto-recharge.
 *
 * TWO DIFFERENT THINGS COME OUT OF A PULL, and keeping them apart is the whole design:
 *
 *   the RECEIPT VAULT gets closed months only, and only above the materiality floor. A
 *   receipt is a filing of a bill, and nobody files one for four cents.
 *
 *   the VENDOR USAGE store (vendorUsage.ts) gets EVERY month, at whatever it came to,
 *   including the part-way month still running. Without it the books had nowhere to put a
 *   sub-floor month or a live one, so the console fell back to this platform's INTERNAL
 *   usage ledger — which knows only what the app priced itself. For Telnyx that read $0.12
 *   for June (twelve voice minutes at a cent) against a real May invoice of $34.58: numbers,
 *   lookups and everything sent outside the metered code paths never touch it.
 *
 * Everything filed by a puller is marked source "api": authoritative on the number, with no
 * invoice image behind it, and the console shows it that way instead of implying a receipt
 * that was never issued. The vendor's own PDF is a separate channel — Telnyx publishes it
 * on the portal only, so it arrives through the portal puller, and until it does a Telnyx
 * month honestly reads as costed but unproven.
 *
 * Still not here at all: the account top-ups in the portal's Payment History, which the API
 * does not expose in any form and which still arrive by email or by hand.
 */

import { recordApiReceipt, listReceipts, deleteReceipt } from "./receipts";
import { listSpendItems } from "./spendRegister";
import { recordVendorMonth, vendorMonthFor, ensureVendorUsageReady } from "./vendorUsage";

export interface PullReport {
  vendor: string;
  ok: boolean;
  error?: string;
  /** Months written, newest first. */
  months: Array<{ period: string; amountUsd: number; reference: string; created: boolean }>;
  /** Anything worth saying out loud about what the API could not provide. */
  notes: string[];
  /** The month still running, priced as far as it has gone. Never a receipt. */
  openMonth?: { period: string; amountUsd: number; through: string };
}

const TELNYX_API = "https://api.telnyx.com";

/**
 * The floor under which a month is not worth filing.
 *
 * A metered account issues an invoice every month whether or not anything happened on it,
 * so a quiet month arrives as one or two cents. Those are not spend anybody tracks, no
 * receipt is ever issued for them, and a year of them buries the months that do matter
 * under a row of pennies. Below this figure the month is counted by the usage ledger and
 * left out of the receipt vault.
 */
function minInvoiceUsd(): number {
  const n = Number(process.env.OWNER_MIN_RECEIPT_USD);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * THIS BUSINESS RUNS MORE THAN ONE TELNYX ACCOUNT, AND THEY ARE SEPARATE BOOKS.
 *
 * The house account carries RecruitersOS's own numbers and the BD Phone; Lume's white-label
 * account carries its five per-recruiter 929 lines and everything its recruiters send, on
 * its own invoices. One key reads ONE account, so the house key showed the house account and
 * the tenant's spend was simply absent — not small, absent. Each account is pulled with its
 * own key onto its own register row and its own usage key, so neither can ever be read as
 * the other's.
 *
 * Adding a third is one entry here plus the env key.
 */
interface TelnyxAccount {
  /** Usage key the register row links by (`link.ledgerSource`). */
  usageKey: string;
  /** Env var holding this account's API key. */
  envKey: string;
  /** How the receipt names it, so two accounts never merge into one charge. */
  vendorLabel: string;
  /** Which register row it pays for, when the row carries no explicit link yet. */
  matchLabel?: RegExp;
  /** What to say when the key is missing. */
  what: string;
}

const TELNYX_ACCOUNTS: TelnyxAccount[] = [
  {
    usageKey: "telnyx", envKey: "TELNYX_API_KEY", vendorLabel: "Telnyx",
    matchLabel: /sms, voice/i,
    what: "the house account: RecruitersOS numbers, the BD Phone and the cell check",
  },
  {
    usageKey: "telnyx_lume", envKey: "TELNYX_API_KEY_LUME", vendorLabel: "Telnyx · Lume",
    matchLabel: /lume/i,
    what: "Lume's white-label account: its per-recruiter 929 lines and everything its recruiters send",
  },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One Telnyx call, with a backoff on rate limiting. The usage API throttles hard: firing
 * six product queries at once turned 13 failed feeds into 25 and emptied every month, so
 * a 429 is waited out rather than counted as "this product has no cost".
 */
async function telnyx<T>(path: string, key: string, attempt = 0): Promise<T> {
  const res = await fetch(TELNYX_API + path, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(600 * Math.pow(2, attempt));
    return telnyx<T>(path, key, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

interface TelnyxProduct { product: string; dimension: string }

/**
 * Every product Telnyx can report a COST for, each with a dimension it will actually accept.
 * The dimension matters: `date` is valid for most products but not all, and asking for the
 * wrong one returns a 400 that silently drops that product's spend from the month. The API
 * publishes the legal dimensions per product, so take them from there rather than guessing.
 */
async function telnyxProducts(key: string): Promise<TelnyxProduct[]> {
  const j = await telnyx<{ data?: Array<{ product?: string; product_metrics?: string[]; product_dimensions?: string[] }> }>(
    "/v2/usage_reports/options", key,
  );
  return (j.data || [])
    .filter((d) => (d.product_metrics || []).includes("cost") && d.product)
    .map((d) => {
      const dims = d.product_dimensions || [];
      const dimension = dims.includes("date") ? "date" : dims.includes("date_time") ? "date_time" : (dims[0] || "date");
      return { product: String(d.product), dimension };
    });
}



/**
 * Pull Telnyx month by month, driven by its INVOICE LIST.
 *
 * The Spend master is a record of what was billed, not a live meter: one line per closed
 * month, the way an invoice reads. So the invoice list is the spine — a month appears here
 * only once Telnyx has closed and issued it — and the current, part-way month is left out
 * entirely. Daily movement belongs on the usage dashboards, not in the books.
 *
 * The amount still has to be summed from the usage API because Telnyx exposes no invoice
 * total and no PDF, but a closed month's window is fixed, so the figure is stable once
 * written and is not re-summed on later runs unless `force` says otherwise.
 */
export async function pullTelnyx(
  monthsBack = 6,
  opts: { force?: boolean } = {},
  account: TelnyxAccount = TELNYX_ACCOUNTS[0],
): Promise<PullReport> {
  const TELNYX_KEY = account.usageKey;
  const VENDOR = account.vendorLabel;
  const report: PullReport = { vendor: VENDOR, ok: false, months: [], notes: [] };
  const key = process.env[account.envKey] || "";
  if (!key) {
    report.error = `${account.envKey} is not set on the server, so ${account.what} is not being read at all`;
    return report;
  }

  const [items, onFile] = await Promise.all([listSpendItems(), listReceipts(), ensureVendorUsageReady()]);
  /* The row this account pays for: the explicit link first, because that is the only thing
     that can tell two accounts of the same vendor apart. */
  const item = items.find((i) => (i.link?.ledgerSource || "").toLowerCase() === TELNYX_KEY)
    || (account.matchLabel
      ? items.find((i) => i.vendor.toLowerCase() === "telnyx" && account.matchLabel!.test(i.label))
      : undefined);
  if (!item) {
    report.notes.push("No register row is linked to this account yet, so its months are recorded but not tied to a line.");
  }

  const floor = minInvoiceUsd();

  /* EVERY FIGURE THIS PULLER EVER FILED AS A RECEIPT IS REMOVED, and none is filed again.
     They were month-end USAGE sums entered as though they were charges, and on a prepaid
     account that is wrong twice over: the money left on a top-up, not on the invoice, so
     counting the usage as spend counts the same dollar a second time; and the sum is not
     even the whole invoice, because Telnyx's usage API prices traffic only — no number
     rentals, no 10DLC. The month is still recorded, as CONSUMPTION, next door.
     Only this puller's own rows are touched: an emailed, hand-attached or portal-downloaded
     receipt is a real document and is never removed by a pull. */
  const stale = onFile.filter((r) => r.source === "api" && r.vendor === VENDOR);
  for (const r of stale) await deleteReceipt(r.id);
  if (stale.length) {
    report.notes.push(
      `${stale.length} usage figure${stale.length > 1 ? "s were" : " was"} removed from the receipt vault: ` +
      "on a prepaid account the spend is the top-up, and usage is what it was spent ON. " +
      "The figures are kept as consumption against their months.",
    );
  }

  let products: TelnyxProduct[];
  try {
    products = await telnyxProducts(key);
  } catch (e) {
    report.error = (e as Error).message;
    return report;
  }

  let invoices: Array<{ invoice_id: string; period_start: string; period_end: string; paid: boolean }> = [];
  try {
    const j = await telnyx<{ data?: typeof invoices }>("/v2/invoices?page[size]=24&page[number]=1", key);
    invoices = j.data || [];
  } catch (e) {
    report.error = `invoice list unavailable: ${(e as Error).message}`;
    return report;
  }

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - Math.max(1, Math.min(24, monthsBack)));
  const cutoffMonth = cutoff.toISOString().slice(0, 7);

  const closed = invoices
    .filter((v) => v.period_start && v.period_end)
    .filter((v) => v.period_end < today)                      // the month has actually ended
    .filter((v) => v.period_start.slice(0, 7) >= cutoffMonth)
    .sort((a, b) => b.period_start.localeCompare(a.period_start));

  if (!closed.length) {
    report.notes.push("Telnyx has not closed an invoice inside this window yet.");
    report.ok = true;
    return report;
  }

  const failed: string[] = [];
  const lastError: Record<string, string> = {};
  let skipped = 0;

  /**
   * What Telnyx billed over one window, summed across every product that reports a cost.
   * Split out because the OPEN month is priced exactly like a closed one — the only
   * difference is that the window ends at now rather than at the period end.
   */
  const sumWindow = async (start: string, end: string): Promise<number> => {
    let total = 0;
    for (const { product, dimension } of products) {
      const base = `/v2/usage_reports?product=${encodeURIComponent(product)}&metrics=cost&start_date=${start}&end_date=${end}`;
      let answered = false;
      for (const q of [`${base}&dimensions=${encodeURIComponent(dimension)}`, base]) {
        try {
          const j = await telnyx<{ data?: Array<{ cost?: number | string }> }>(q, key);
          total += (j.data || []).reduce((sum, row) => sum + Number(row.cost || 0), 0);
          answered = true;
          break;
        } catch (e) {
          lastError[product] = (e as Error).message;
        }
      }
      if (!answered && !failed.includes(product)) failed.push(product);
    }
    return Math.round(total * 100) / 100;
  };

  for (const inv of closed) {
    const period = inv.period_start.slice(0, 7);

    /* A closed month's usage cannot change, so once it is on file it is left alone. That
       keeps a nightly run to the open month plus anything new, instead of re-summing the
       year at 25 rate-limited product queries per month. */
    const said = vendorMonthFor(TELNYX_KEY, period);
    if (!opts.force && said?.closed && said.reference === inv.invoice_id) {
      skipped += 1;
      continue;
    }

    const total = await sumWindow(
      `${inv.period_start}T00:00:00Z`,
      `${nextDay(inv.period_end)}T00:00:00Z`,   // period_end is inclusive
    );

    /* Recorded as CONSUMPTION, never as spend and never as a receipt. It is what the credit
       was spent on, and it is worth having beside the month — it is the only per-month
       usage figure that exists — but the money left the bank when the account was topped
       up. It is also incomplete by construction: traffic only. */
    await recordVendorMonth({
      key: TELNYX_KEY, vendor: VENDOR, period, amountUsd: total,
      reference: inv.invoice_id, closed: true, kind: "consumption",
      note: `Usage summed from the Telnyx API across ${inv.period_start} to ${inv.period_end}. Traffic only: number rentals and 10DLC fees are not in that API, so the real invoice is higher.`,
    });
    report.months.push({ period, amountUsd: total, reference: inv.invoice_id, created: false });
  }

  if (skipped) report.notes.push(`${skipped} closed month${skipped > 1 ? "s were" : " was"} already on file and left untouched.`);
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => lastError[f]).filter(Boolean))].slice(0, 3).join(", ");
    report.notes.push(
      `${failed.length} of ${products.length} product feeds did not answer and are excluded: ${failed.slice(0, 6).join(", ")}` +
      (reasons ? ` (HTTP ${reasons})` : "") + ".",
    );
  }
  /* The month still running. No invoice exists for it, so nothing is FILED — the vault
     stays a record of closed months, as intended. But leaving it out of the books entirely
     is what made a live pay-per-use line read $0 in the current column on days money was
     plainly going out, so the running figure is carried as usage and the console labels it
     as part of a month rather than a bill.

     The window ends five minutes ago, not now: Telnyx rejects an end_date in the future
     outright, and a clock a second or two ahead of theirs is enough to lose the whole
     query — which is how a real $21 month once read $13. */
  const open = invoices.find((v) => v.period_end >= today);
  const openStart = open?.period_start || `${today.slice(0, 7)}-01`;
  const openPeriod = openStart.slice(0, 7);
  const through = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19) + "Z";
  const openTotal = await sumWindow(`${openStart}T00:00:00Z`, through);
  await recordVendorMonth({
    key: TELNYX_KEY, vendor: VENDOR, period: openPeriod, amountUsd: openTotal,
    reference: open?.invoice_id, closed: false, kind: "consumption",
    note: `Usage so far this month, ${openStart} through ${through.slice(0, 10)}. Traffic only, and drawn against credit already paid in.`,
  });
  report.openMonth = { period: openPeriod, amountUsd: openTotal, through: through.slice(0, 10) };
  report.notes.push(
    `${openPeriod} is still open and stands at $${openTotal.toFixed(2)} through ${through.slice(0, 10)}. ` +
    "It is carried as a running figure, never as a receipt: Telnyx has issued no invoice for it.",
  );
  try {
    const b = await telnyx<{ data?: { balance?: string } }>("/v2/balance", key);
    if (b.data?.balance != null) report.notes.push(`Account balance is $${b.data.balance}; auto-recharge top-ups are not exposed by the API.`);
  } catch { /* balance is a nicety */ }

  report.ok = true;
  return report;
}

/** The day after an inclusive period end, for an exclusive query window. */
function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Run every vendor that has a real billing API, and every ACCOUNT within one. `force`
 *  re-sums months already on file, which is what corrects a figure written by an older,
 *  wronger version of a puller.
 *
 *  Serial on purpose: the accounts share nothing but Telnyx's rate limiter, and two
 *  accounts querying 25 products each in parallel is how a month comes back half-read. */
export async function pullVendorApis(monthsBack = 3, opts: { force?: boolean } = {}): Promise<PullReport[]> {
  const out: PullReport[] = [];
  for (const account of TELNYX_ACCOUNTS) {
    /* An account with no key is REPORTED, not skipped in silence. A missing key and a quiet
       month look identical on the page otherwise, and this is exactly how Lume's whole
       account sat at $0 without anyone being told it was never being read. */
    out.push(await pullTelnyx(monthsBack, opts, account));
  }
  return out;
}
