/**
 * RecruitersOS · Owner · What a metered vendor says it billed us (OWNER ONLY)
 *
 * A pay-per-use line has no invoice to reconcile against, so the Spend master falls back to
 * the platform's OWN usage ledger for its monthly figure. That ledger is a record of what
 * this app *did* — messages sent, minutes spoken — priced at the rate the code was told.
 * It is not the bill. Telnyx is the case that proved it: twelve voice minutes recorded here
 * at a cent each read **$0.12 for June**, while Telnyx's own June invoice is $0.42 and its
 * May invoice is $34.58, because numbers, lookups and everything sent outside the metered
 * paths never touch the internal ledger at all.
 *
 * So where a vendor publishes a billing API, its figure is filed here, month by month, and
 * the console prefers it over the internal estimate. The two are never added: the vendor's
 * invoice already contains everything the ledger was guessing at, so adding would double it.
 *
 * This is deliberately NOT the receipt vault. A figure is not a document: a receipt carries
 * the vendor's own invoice and proves the money moved, while a row here only states what
 * the vendor's API says the month came to. Small months matter here precisely because they
 * are too small to be worth a receipt — under the materiality floor nothing is filed in the
 * vault, and without this store those months would land nowhere and the row would quietly
 * report the internal estimate instead.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface VendorMonth {
  /**
   * Usage-ledger key this figure stands in for, lowercased. Matches a spend row's
   * `link.ledgerSource` (or its vendor name), which is how the console pairs the two.
   */
  key: string;
  vendor: string;
  /** Billing month, YYYY-MM. */
  period: string;
  amountUsd: number;
  /** The vendor's own invoice id for the month, when it issues one. */
  reference?: string;
  /** False while the billing period is still running: a part-month figure, not a bill. */
  closed: boolean;
  /** Where the figure came from. Only a vendor's own billing API qualifies. */
  source: "api";
  note?: string;
  updatedAt: string;
}

interface VendorUsageStore {
  months: VendorMonth[];
}

const SNAP_KEY = "owner_vendor_usage_v1";
const store: VendorUsageStore = { months: [] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureVendorUsageReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<VendorUsageStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s && Array.isArray(s.months)) store.months = s.months;
      })
      .catch(() => {});
  }
  return hydrated;
}
void ensureVendorUsageReady();

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * File (or correct) one vendor month. Keyed on vendor key + period, so a closed month is
 * written once and the running part-month is overwritten on every pass.
 */
export async function recordVendorMonth(
  m: Omit<VendorMonth, "updatedAt" | "source"> & { source?: "api" },
): Promise<VendorMonth> {
  await ensureVendorUsageReady();
  const key = m.key.toLowerCase();
  const next: VendorMonth = {
    ...m,
    key,
    amountUsd: round2(m.amountUsd),
    source: m.source || "api",
    updatedAt: nowIso(),
  };
  const at = store.months.findIndex((x) => x.key === key && x.period === m.period);
  if (at >= 0) store.months[at] = next;
  else store.months.push(next);
  persist();
  return next;
}

/** Every month on file, newest first. */
export function listVendorUsage(): VendorMonth[] {
  return [...store.months].sort((a, b) => b.period.localeCompare(a.period) || a.key.localeCompare(b.key));
}

export function vendorMonthFor(key: string | undefined, period: string): VendorMonth | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase();
  return store.months.find((x) => x.key === k && x.period === period);
}

/**
 * The vendor's own figures shaped like the usage ledger's own `meteredByMonth()` output,
 * so one can stand in for the other.
 */
export function vendorUsageByMonth(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const m of store.months) {
    if (!/^\d{4}-\d{2}$/.test(m.period)) continue;
    const month = out[m.period] || (out[m.period] = {});
    month[m.key] = round2(m.amountUsd);
  }
  return out;
}

/**
 * Lay the vendor's own figures over the internal ledger's.
 *
 * REPLACE, never add. The vendor's invoice for a month already includes the traffic the
 * internal ledger priced itself, so summing them counts that traffic twice. A key the
 * vendor has said nothing about keeps the internal figure, which is the only one there is.
 *
 * Pure, so the reconciler's arithmetic can be pinned in a test without a store.
 */
export function mergeVendorUsage(
  metered: Record<string, Record<string, number>>,
  vendor: Record<string, Record<string, number>> = vendorUsageByMonth(),
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const periods = new Set([...Object.keys(metered), ...Object.keys(vendor)]);
  for (const period of periods) {
    out[period] = { ...(metered[period] || {}), ...(vendor[period] || {}) };
  }
  return out;
}

/**
 * The vendor's own figures cut to a trailing window, for the burn header, which reports a
 * rolling 30 days rather than calendar months.
 *
 * A month is APPORTIONED BY DAY across the window it overlaps. That is an assumption —
 * spend is not perfectly even inside a month — and it is stated wherever the number is
 * shown. It is exact when the window is a whole calendar month, and it is far closer to the
 * truth than the alternative, which was to leave the vendor's real cost out of the burn
 * altogether because it did not arrive in daily pieces.
 *
 * `days <= 0` means every month on file, unapportioned.
 */
export function vendorUsageWindow(days: number, now: number = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  const from = days > 0 ? now - days * 86_400_000 : 0;
  for (const m of store.months) {
    if (!/^\d{4}-\d{2}$/.test(m.period)) continue;
    const start = Date.parse(`${m.period}-01T00:00:00Z`);
    const [y, mo] = m.period.split("-").map(Number);
    const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1);
    const span = end - start;
    const overlap = Math.max(0, Math.min(end, now) - Math.max(start, from));
    if (overlap <= 0 || span <= 0) continue;
    const share = days > 0 ? Math.min(1, overlap / span) : 1;
    out[m.key] = round2((out[m.key] || 0) + m.amountUsd * share);
  }
  return out;
}

/**
 * How much the burn total is out by, per usage key, if it counts only the internal ledger.
 *
 * REPLACE, never add, for the same reason as `mergeVendorUsage`: the vendor's bill already
 * contains the traffic the internal ledger priced. So the delta is what has to be applied,
 * and it is negative whenever this platform over-estimated its own cost.
 */
export function vendorUsageDelta(
  bySource: Record<string, number>,
  days: number,
  now: number = Date.now(),
): { total: number; byKey: Record<string, number> } {
  const window = vendorUsageWindow(days, now);
  const byKey: Record<string, number> = {};
  let total = 0;
  for (const [key, amount] of Object.entries(window)) {
    const d = round2(amount - (bySource[key] || 0));
    if (d === 0) continue;
    byKey[key] = d;
    total = round2(total + d);
  }
  return { total, byKey };
}

/** Dev/tests only. */
export function devVendorUsage(): VendorUsageStore {
  return store;
}
