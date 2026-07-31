/**
 * RecruitersOS · Owner · Vendor billing pullers (OWNER ONLY)
 *
 * Email is the channel that works for every vendor, but it is not the best one where a real
 * billing API exists — an API cannot be missed, filtered into spam, or deleted. This module
 * holds the exceptions.
 *
 * TELNYX (the only one found so far, confirmed live against the production key):
 *   GET /v2/invoices        one record per billing month: invoice id, period, paid flag.
 *                           No amount and no downloadable PDF, so the invoice alone cannot
 *                           report a month.
 *   GET /v2/usage_reports   per-product usage with a `cost` metric. Summed across products
 *                           for the month, this IS the billed usage, straight from Telnyx.
 *   GET /v2/balance         the account balance behind auto-recharge.
 * Payments (the account top-ups shown in the portal's Payment History) are NOT exposed by
 * the API at all. Those still arrive by email or get attached by hand, which is why the
 * figure filed here is labelled as billed usage rather than cash paid.
 *
 * Everything filed by a puller is marked source "api": authoritative on the number, with no
 * invoice image behind it, and the console shows it that way instead of implying a receipt
 * that was never issued.
 */

import { recordApiReceipt } from "./receipts";
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

async function telnyx<T>(path: string, key: string): Promise<T> {
  const res = await fetch(TELNYX_API + path, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
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
 * The reporting window for one month, with the end CLAMPED TO NOW. Telnyx rejects a window
 * that ends in the future, and a rejected window is an excluded product: asking for the
 * current month with an end of the 1st of next month silently dropped messaging, which is
 * the largest line on the account.
 */
function monthWindow(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m, 1));
  const now = new Date();
  const end = monthEnd.getTime() > now.getTime() ? now : monthEnd;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: iso(start), end: iso(end) };
}

/** Run `work` over `items` a few at a time: 36 products across several months is hundreds
 *  of calls, and serially that is minutes of wall clock for no reason. */
async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  }
  return out;
}

/**
 * Pull Telnyx's own billed usage for the last `monthsBack` months and file one figure per
 * month. Products are queried one at a time because that is the only shape the usage API
 * accepts; a product that errors is skipped and named in the report rather than silently
 * dropping its cost.
 */
export async function pullTelnyx(monthsBack = 3): Promise<PullReport> {
  const report: PullReport = { vendor: "Telnyx", ok: false, months: [], notes: [] };
  const key = process.env.TELNYX_API_KEY || "";
  if (!key) { report.error = "TELNYX_API_KEY is not set on the server"; return report; }

  const items = await listSpendItems();
  const item = items.find((i) => i.vendor.toLowerCase() === "telnyx");

  let products: TelnyxProduct[];
  try {
    products = await telnyxProducts(key);
  } catch (e) {
    report.error = (e as Error).message;
    return report;
  }

  /* The invoice list is what says a month was actually billed and settled. */
  let invoices: Array<{ invoice_id: string; period_start: string; period_end: string; paid: boolean }> = [];
  try {
    const j = await telnyx<{ data?: typeof invoices }>("/v2/invoices?page[size]=24&page[number]=1", key);
    invoices = j.data || [];
  } catch (e) {
    report.notes.push(`Invoice list unavailable (${(e as Error).message}); months are still priced from the usage API.`);
  }

  const now = new Date();
  const periods: string[] = [];
  for (let i = 0; i < Math.max(1, Math.min(24, monthsBack)); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(d.toISOString().slice(0, 7));
  }

  const failed: string[] = [];
  for (const period of periods) {
    const { start, end } = monthWindow(period);
    const perProduct = await inBatches(products, 6, async ({ product, dimension }) => {
      const base = `/v2/usage_reports?product=${encodeURIComponent(product)}&metrics=cost&start_date=${start}&end_date=${end}`;
      /* Dimension first, then a bare metrics-only call: a product that rejects every
         dimension still reports its total, and only a genuine failure is dropped. */
      for (const q of [`${base}&dimensions=${encodeURIComponent(dimension)}`, base]) {
        try {
          const j = await telnyx<{ data?: Array<{ cost?: number | string }> }>(q, key);
          return (j.data || []).reduce((sum, row) => sum + Number(row.cost || 0), 0);
        } catch { /* try the next shape */ }
      }
      if (!failed.includes(product)) failed.push(product);
      return null;
    });
    let total = perProduct.reduce((sum: number, v) => sum + (v || 0), 0);
    total = Math.round(total * 100) / 100;
    if (total <= 0) continue;

    const inv = invoices.find((v) => (v.period_start || "").slice(0, 7) === period);
    const { created } = await recordApiReceipt({
      vendor: "Telnyx",
      itemId: item?.id,
      period,
      amountUsd: total,
      reference: inv?.invoice_id || `usage-${period}`,
      description: "Billed usage across every Telnyx product",
      chargedAt: inv?.period_end || undefined,
      notes: inv
        ? `Telnyx invoice ${inv.invoice_id} for ${inv.period_start} to ${inv.period_end}, ${inv.paid ? "settled" : "unpaid"}. Amount summed from the Telnyx usage API; Telnyx does not expose an invoice total or a downloadable PDF.`
        : "Amount summed from the Telnyx usage API. No invoice record for this month yet, so this is the running figure.",
    });
    report.months.push({ period, amountUsd: total, reference: inv?.invoice_id || `usage-${period}`, created });
  }

  if (failed.length) report.notes.push(`${failed.length} product feeds did not answer and are excluded: ${failed.slice(0, 6).join(", ")}.`);
  try {
    const b = await telnyx<{ data?: { balance?: string; available_credit?: string } }>("/v2/balance", key);
    if (b.data?.balance != null) report.notes.push(`Account balance is $${b.data.balance}; auto-recharge tops this up, and those payments are not in the API.`);
  } catch { /* balance is a nicety */ }

  report.ok = true;
  return report;
}

/** Run every vendor that has a real billing API. */
export async function pullVendorApis(monthsBack = 3): Promise<PullReport[]> {
  return [await pullTelnyx(monthsBack)];
}
