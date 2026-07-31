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
 * What is deliberately NOT here: the current, part-way month (daily movement belongs on a
 * usage dashboard, not in the books) and the account top-ups in the portal's Payment
 * History, which the API does not expose at all and which still arrive by email or by hand.
 *
 * Everything filed by a puller is marked source "api": authoritative on the number, with no
 * invoice image behind it, and the console shows it that way instead of implying a receipt
 * that was never issued.
 */

import { recordApiReceipt, listReceipts } from "./receipts";
import { listSpendItems } from "./spendRegister";

export interface PullReport {
  vendor: string;
  ok: boolean;
  error?: string;
  /** Months written, newest first. */
  months: Array<{ period: string; amountUsd: number; reference: string; created: boolean }>;
  /** Anything worth saying out loud about what the API could not provide. */
  notes: string[];
}

const TELNYX_API = "https://api.telnyx.com";

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
export async function pullTelnyx(monthsBack = 6, opts: { force?: boolean } = {}): Promise<PullReport> {
  const report: PullReport = { vendor: "Telnyx", ok: false, months: [], notes: [] };
  const key = process.env.TELNYX_API_KEY || "";
  if (!key) { report.error = "TELNYX_API_KEY is not set on the server"; return report; }

  const [items, onFile] = await Promise.all([listSpendItems(), listReceipts()]);
  const item = items.find((i) => i.vendor.toLowerCase() === "telnyx");

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

  for (const inv of closed) {
    const period = inv.period_start.slice(0, 7);
    /* A closed month cannot change, so once its figure is on file it is left alone. That
       keeps the nightly run to one month of work instead of re-summing the year. */
    const already = onFile.find(
      (r) => r.source === "api" && r.vendor === "Telnyx" && r.invoiceNumber === inv.invoice_id && r.amountUsd > 0,
    );
    if (already && !opts.force) { skipped += 1; continue; }

    const start = `${inv.period_start}T00:00:00Z`;
    const end = `${nextDay(inv.period_end)}T00:00:00Z`;   // period_end is inclusive
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
    total = Math.round(total * 100) / 100;
    if (total <= 0 && !already) continue;

    const { created } = await recordApiReceipt({
      vendor: "Telnyx",
      itemId: item?.id,
      period,
      amountUsd: total,
      reference: inv.invoice_id,
      description: `Month-end invoice, ${inv.period_start} to ${inv.period_end}`,
      chargedAt: inv.period_end,
      notes: `Telnyx invoice ${inv.invoice_id}, ${inv.paid ? "settled" : "unpaid"}. Total summed from the Telnyx usage API for the closed billing period: Telnyx exposes neither an invoice total nor a downloadable PDF.`,
    });
    report.months.push({ period, amountUsd: total, reference: inv.invoice_id, created });
  }

  if (skipped) report.notes.push(`${skipped} closed month${skipped > 1 ? "s were" : " was"} already on file and left untouched.`);
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => lastError[f]).filter(Boolean))].slice(0, 3).join(", ");
    report.notes.push(
      `${failed.length} of ${products.length} product feeds did not answer and are excluded: ${failed.slice(0, 6).join(", ")}` +
      (reasons ? ` (HTTP ${reasons})` : "") + ".",
    );
  }
  const open = invoices.find((v) => v.period_end >= today);
  report.notes.push(
    open
      ? `The current period (${open.period_start} onward) is still open, so it is deliberately not filed: this view records closed months only.`
      : "The current month has no invoice yet, so it is not filed: this view records closed months only.",
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

/** Run every vendor that has a real billing API. */
export async function pullVendorApis(monthsBack = 3): Promise<PullReport[]> {
  return [await pullTelnyx(monthsBack)];
}
