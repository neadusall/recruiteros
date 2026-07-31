/**
 * RecruitersOS · Owner · Month-over-month spend reconciliation (OWNER ONLY)
 *
 * The report that answers "what have we actually spent, month by month, and is any of it
 * unaccounted for". It takes three inputs that each know half the truth —
 *
 *   the spend register   what each vendor is SUPPOSED to charge
 *   the receipt vault    what a vendor PROVABLY charged (with the receipt image)
 *   the usage ledger     what pay-per-use actually cost inside the engine
 *
 * — and lays them on one grid: every service down the side, every month across the top,
 * a running total in both directions.
 *
 * THE RULE THAT MAKES IT USEFUL: a cell is only "paid" when a receipt backs it. A live
 * subscription with no receipt for an elapsed month is a GAP, reported by name with the
 * link to go download it. That is the difference between a spend dashboard and a set of
 * books: this one can tell you what it does not know.
 */

import type { SpendItem } from "./spendRegister";
import { monthlyEquivalent } from "./spendRegister";
import type { Receipt, PullerState } from "./receipts";
import { PULLER_STALE_DAYS } from "./receipts";
import { vendorSourceFor, VENDOR_SOURCES } from "./receiptSources";
import { meteredByMonth } from "../billing/ledger";
import { mergeVendorUsage, vendorMonthFor } from "./vendorUsage";

/* ============================ types ============================ */

export type CellStatus =
  | "paid"           // receipt on file and it matches what was expected
  | "mismatch"       // receipt on file but the figure is not what the register says
  | "missing"        // charge expected, month elapsed, no receipt anywhere
  | "pending"        // charge expected but the billing date has not passed yet
  | "unexpected"     // a charge with nothing in the register expecting it
  | "metered"        // pay-per-use: the ledger is the source of truth, no invoice per month
  | "prepaid"        // annual plan, already paid in its anniversary month
  | "none"           // nothing expected and nothing charged (credit top-ups, free tiers)
  | "before"         // predates the service
  | "cancelled";     // service is off

export interface ReceiptRef {
  id: string;
  amountUsd: number;
  chargedAt: string;
  invoiceNumber?: string;
  hasShot?: boolean;
  hasFile?: boolean;
  source: Receipt["source"];
  confidence: number;
  reviewed?: boolean;
  kind: Receipt["kind"];
  subject?: string;
  shotError?: string;
}

export interface MatrixCell {
  period: string;
  status: CellStatus;
  /** Receipted dollars (charges less refunds). */
  actualUsd: number;
  /** Ledger dollars for metered rows. */
  meteredUsd: number;
  /** What the register says this month should have cost. */
  expectedUsd: number;
  /** Best available truth for the running total: receipts when present, else metered,
   *  else the expected figure (flagged unverified so a total is never silently invented). */
  countedUsd: number;
  verified: boolean;
  runningUsd: number;
  /** Change against the previous month's counted figure. */
  deltaUsd: number | null;
  receipts: ReceiptRef[];
  note?: string;
}

export interface MatrixRow {
  itemId?: string;
  vendor: string;
  label: string;
  category: string;
  billing: string;
  status: string;
  monthlyUsd: number;
  /** What this line buys the business, shown on hover so a row explains itself. */
  purpose?: string;
  /** Bought outright: nothing renews, so nothing is ever due again. */
  lifetime?: boolean;
  /** On the register with no price yet: the month figures are unknown, not zero. */
  needsAmount?: boolean;
  /** Registrable name when this line is a domain. */
  domain?: string;
  /** How many register lines this row speaks for: >1 means one account, one bill. */
  foldedCount?: number;
  /** A charge that arrived with no line item in the register expecting it. */
  unregistered?: boolean;
  /** Pay-per-use read off the usage ledger, with no register row behind it. */
  ledgerOnly?: boolean;
  /** How this vendor's receipt is supposed to reach us. */
  channel?: string;
  portal?: string;
  /** Has a receipt for this vendor EVER arrived by email? */
  emailProven: boolean;
  cells: MatrixCell[];
  totalCountedUsd: number;
  totalVerifiedUsd: number;
  receiptCount: number;
  missingCount: number;
  lastReceiptAt?: string;
}

export interface MonthTotal {
  period: string;
  countedUsd: number;
  verifiedUsd: number;
  expectedUsd: number;
  meteredUsd: number;
  runningUsd: number;
  deltaUsd: number | null;
  receiptCount: number;
  missingCount: number;
  /** Share of the month's dollars that a receipt can prove. */
  coveragePct: number;
}

export type AnomalySeverity = "high" | "medium" | "low" | "info";

export interface Anomaly {
  severity: AnomalySeverity;
  kind:
    | "missing_receipt" | "amount_mismatch" | "price_change" | "duplicate_charge"
    | "unexpected_charge" | "unmatched_vendor" | "charged_after_cancel" | "no_price_on_file"
    | "refund" | "metered_spike" | "low_confidence" | "render_failed" | "never_receipted"
    | "inbox_unconfigured" | "gap_in_series" | "non_usd";
  period?: string;
  vendor: string;
  itemId?: string;
  receiptId?: string;
  amountUsd?: number;
  message: string;
  /** What to do about it, in one line. */
  fix?: string;
}

export interface SpendMatrix {
  months: string[];
  rows: MatrixRow[];
  monthTotals: MonthTotal[];
  /** Charges that matched no register row: uncatalogued spend. */
  unmatched: Array<{ vendor: string; totalUsd: number; count: number; receipts: ReceiptRef[]; periods: string[] }>;
  anomalies: Anomaly[];
  totals: {
    allTimeCountedUsd: number;
    allTimeVerifiedUsd: number;
    receiptCount: number;
    missingCount: number;
    coveragePct: number;
    currentMonthUsd: number;
    priorMonthUsd: number;
    avgMonthUsd: number;
  };
}

/* ============================ where the books begin ============================ */

/**
 * The first month these books cover. Anything charged before it is out of scope: the
 * register was not being kept then, so those months can never be reconciled, and a
 * half-collected column sitting next to fully receipted ones reads as a hole in the
 * books rather than as history nobody kept.
 *
 * The cut is applied once, at the top of the report, so every number on the page agrees
 * with it: no column, no receipt in the gallery, no anomaly and no total counts a month
 * the grid does not show. Move it with SPEND_REGISTER_START=YYYY-MM.
 */
export const REGISTER_START_MONTH: string =
  /^\d{4}-\d{2}$/.test(process.env.SPEND_REGISTER_START || "")
    ? String(process.env.SPEND_REGISTER_START)
    : "2026-06";

/** Is this charge inside the period the books cover? */
export function withinRegister(r: { period?: string; chargedAt?: string }): boolean {
  const p = r.period || (r.chargedAt || "").slice(0, 7);
  return !/^\d{4}-\d{2}$/.test(p) || p >= REGISTER_START_MONTH;
}

/* ============================ helpers ============================ */

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

function monthKey(d: Date | string): string {
  const s = typeof d === "string" ? d : d.toISOString();
  return s.slice(0, 7);
}
function addMonths(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < 120 && cur <= to; i++) { out.push(cur); cur = addMonths(cur, 1); }
  return out;
}
function daysInto(period: string): number {
  const now = new Date();
  if (monthKey(now) !== period) return 32;
  return now.getUTCDate();
}

/* ============================ one account, one line ============================ */

/**
 * A vendor bills an ACCOUNT, not a thing.
 *
 * Zapmail is the case that forced this (owner, 2026-07-31: "there is only one. Sure, on
 * the backend there are several accounts, but we are only being charged as one account").
 * The register holds 33 Zapmail lines: the Google Workspace mailboxes plus one line per
 * domain Zapmail registered. Every one of those domain lines is a fact worth keeping: the
 * name, the registrar, the renewal date, and NOT ONE of them is a separate bill. Laid out
 * as 33 rows in a month-by-month ledger they read as 33 charges to chase, when there is one
 * monthly fee and the one-time charges that came with it. Same story at Dynadot (30 lines)
 * and Porkbun (16).
 *
 * So the grid folds a vendor's domain lines into that vendor's account line: one row, one
 * running total, receipts of every kind landing on it. Nothing is deleted and nothing moves
 * in the register itself: the Domains panel still shows every name with its own expiry,
 * which is where per-domain detail actually gets used.
 *
 * THE UNIT IS THE ACCOUNT, NEVER THE COUNT INSIDE IT (owner, 2026-07-31: "make sure it is
 * right based on accounts, not number of accounts in each account"). One domain folds for
 * exactly the same reason thirty-two do: the bill comes from the account, and how many
 * names, mailboxes or seats sit behind it changes nothing about how it reconciles. A rule
 * that folded only a big estate would leave a one-domain registrar drawn as two rows and
 * two gaps, which is the same error at a smaller size.
 *
 * Folding is by DATA, not by a vendor list: a vendor's domain lines fold into that vendor's
 * account line, whatever the number. Two Telnyx lines stay two rows because they are two
 * separate Telnyx accounts, and five RapidAPI listings stay five because RapidAPI invoices
 * each listing separately: the register already says so, and this reads the register.
 */
export interface AccountGroup {
  /** The row's identity: id, vendor, category, billing and the rest come from here. */
  display: SpendItem;
  /** Every register line this row speaks for, `display` included. */
  members: SpendItem[];
  label: string;
  purpose?: string;
  /** True when this row stands for more than one register line. */
  folded: boolean;
  domainCount: number;
  needsAmount: boolean;
}

const vkey = (v: string): string => String(v || "").trim().toLowerCase();

export function accountGroups(items: SpendItem[]): AccountGroup[] {
  /* Every vendor that registers domains. No threshold: one name is an account too. */
  const domainsBy = new Map<string, SpendItem[]>();
  for (const i of items) {
    if (!i.domain) continue;
    const k = vkey(i.vendor);
    domainsBy.set(k, [...(domainsBy.get(k) || []), i]);
  }

  /* The line the estate folds INTO: the vendor's own account row when it has one (the
     registrar's "Domain registrations" line, or Zapmail's mailbox line), otherwise the
     first domain itself stands in for the account so the money still has a home. */
  const hostFor = new Map<string, string>();
  for (const [k, rows] of domainsBy) {
    const accounts = items.filter((i) => vkey(i.vendor) === k && !i.domain);
    const host = accounts.find((a) => /domain/i.test(a.label)) || accounts[0] || rows[0];
    hostFor.set(k, host.id);
  }

  const out: AccountGroup[] = [];
  for (const item of items) {
    const k = vkey(item.vendor);
    const hostId = hostFor.get(k);
    if (hostId === item.id) {
      const domains = domainsBy.get(k) || [];
      const members = item.domain ? [...domains] : [item, ...domains];
      /* A vendor whose only line IS the one domain is already one row: it needs no fold
         and no explaining, so it keeps its own name. */
      const folded = members.length > 1;
      out.push({
        display: item,
        members,
        label: folded ? foldLabel(item, domains.length) : item.label,
        purpose: folded
          ? [item.purpose, foldNote(item.vendor, domains.length)].filter(Boolean).join(" ")
          : item.purpose,
        folded,
        domainCount: domains.length,
        needsAmount: members.some((m) => m.needsAmount && m.status === "active"),
      });
      continue;
    }
    if (item.domain && hostId) continue; // spoken for by the row above
    out.push({
      display: item, members: [item], label: item.label, purpose: item.purpose,
      folded: false, domainCount: item.domain ? 1 : 0, needsAmount: item.needsAmount,
    });
  }
  return out;
}

function foldLabel(host: SpendItem, domains: number): string {
  if (!domains) return host.label;
  const n = `${domains} ${domains > 1 ? "names" : "name"}`;
  return /domain/i.test(host.label) && !host.domain
    ? `${host.label} · ${n} on one account`
    : `${host.label} · plus ${n} on the same account`;
}

function foldNote(vendor: string, domains: number): string {
  if (!domains) return "";
  return `The ${domains} domain${domains > 1 ? "s" : ""} registered through ${vendor} sit on this line: ` +
    `one account, one bill, so it reconciles as one row. Every name, its registrar and its renewal date stay on the Domains panel.`;
}

/* ============================ the report ============================ */

export function buildSpendMatrix(
  items: SpendItem[],
  allReceipts: Receipt[],
  opts: { months?: number; inboxConfigured?: boolean } = {},
): SpendMatrix {
  const nowMonth = monthKey(new Date());
  const span = Math.max(2, Math.min(24, opts.months || 12));

  /* Charges from before the books begin are dropped here, once, so the rows, the totals,
     the coverage percentage and the anomaly list are all talking about the same period. */
  const receipts = allReceipts.filter(withinRegister);

  /* Window: far enough back to cover the oldest thing on record, capped at `span`, and
     never earlier than the month the books begin. */
  const earliestCandidates = [
    ...items.map((i) => (i.at || "").slice(0, 7)),
    ...receipts.map((r) => r.period),
  ].filter((p) => /^\d{4}-\d{2}$/.test(p)).sort();
  const floor = addMonths(nowMonth, -(span - 1));
  const wanted = earliestCandidates.length && earliestCandidates[0] > floor ? earliestCandidates[0] : floor;
  const start = wanted < REGISTER_START_MONTH ? REGISTER_START_MONTH : wanted;
  const months = monthsBetween(start, nowMonth);

  /* The platform's own usage ledger, with the vendor's own billed figure laid over it
     wherever a billing API has reported one. The internal ledger only knows what this app
     priced itself: for Telnyx that was twelve voice minutes, $0.12, against a real invoice
     of $34.58 in the same window. Where the vendor has spoken, the vendor is right. */
  const metered = mergeVendorUsage(meteredByMonth());
  const byItem = new Map<string, Receipt[]>();
  const byVendor = new Map<string, Receipt[]>();
  for (const r of receipts) {
    if (r.itemId) byItem.set(r.itemId, [...(byItem.get(r.itemId) || []), r]);
    const v = r.vendor.toLowerCase();
    byVendor.set(v, [...(byVendor.get(v) || []), r]);
  }

  const anomalies: Anomaly[] = [];
  const rows: MatrixRow[] = [];

  /* Every `source` tag the usage ledger recorded in this window. A pay-per-use row whose
     vendor IS one of those but which nobody remembered to link reads $0 every month while
     the money is plainly going out, so the vendor's own name counts as the link. */
  const ledgerKeys = new Set<string>();
  for (const period of months) for (const k of Object.keys(metered[period] || {})) ledgerKeys.add(k.toLowerCase());
  const ledgerKeyFor = (i: SpendItem): string | undefined => {
    if (i.link?.ledgerSource) return i.link.ledgerSource;
    if (i.billing !== "metered") return undefined;
    const byName = i.vendor.toLowerCase();
    return ledgerKeys.has(byName) ? byName : undefined;
  };

  /* Receipts a folded row has taken for its own, so the unmatched list below does not
     report them as money with nowhere to go and count them a second time. */
  const claimedReceiptIds = new Set<string>();

  for (const group of accountGroups(items)) {
    const item = group.display;
    const members = group.members;
    const src = vendorSourceFor(item.vendor);
    const ledgerKey = ledgerKeyFor(item);
    const mine: Receipt[] = [];
    for (const m of members) for (const r of byItem.get(m.id) || []) mine.push(r);
    /* One account, one line: a charge from this vendor that never got tied to a specific
       row has exactly one row it can belong to, so it belongs to this one. Only ever done
       for a folded row, where that reasoning holds. */
    if (group.folded) {
      for (const r of byVendor.get(vkey(item.vendor)) || []) {
        if (r.itemId || claimedReceiptIds.has(r.id)) continue;
        claimedReceiptIds.add(r.id);
        mine.push(r);
      }
    }
    const cancelled = members.every((m) => m.status === "cancelled");
    const startMonth = members.map((m) => (m.at || "").slice(0, 7)).filter(Boolean).sort()[0] || "";
    const emailProven = mine.some((r) => r.source === "email");
    let running = 0;
    let prevCounted: number | null = null;
    let prevReceiptAmount: number | null = null;
    let prevReceiptCount = 0;
    const cells: MatrixCell[] = [];

    for (const period of months) {
      const inMonth = mine.filter((r) => r.period === period);
      const actual = round2(inMonth.reduce((s, r) => s + r.amountUsd, 0));
      const meteredUsd = ledgerKey ? round2(metered[period]?.[ledgerKey] || 0) : 0;
      /* What the whole account is due this month: the recurring fee plus any renewal or
         one-time buy the folded lines put in this month. */
      const expected = round2(members.reduce((s, m) => s + expectedFor(m, period), 0));

      let status: CellStatus;
      let note: string | undefined;
      let counted = 0;
      let verified = false;

      if (startMonth && period < startMonth) {
        status = "before";
      } else if (item.billing === "metered") {
        status = "metered";
        counted = actual !== 0 ? actual : meteredUsd;
        /* A figure is not proof. The vendor's API is authoritative on the number and still
           leaves the month unproven until its own invoice is on file, which is exactly why
           a metered line can read its true cost and $0 proven at the same time. */
        verified = actual !== 0;
        const said = vendorMonthFor(ledgerKey, period);
        if (said && !said.closed) {
          note = `${item.vendor} so far this month, still running`;
        } else if (said && actual === 0) {
          note = `${item.vendor}'s own figure for the month`;
        } else if (actual !== 0 && meteredUsd > 0 && Math.abs(actual - meteredUsd) >= 0.01) {
          note = `ledger says ${meteredUsd.toFixed(2)}`;
        }
      } else if (cancelled && actual === 0) {
        status = "cancelled";
      } else if (actual !== 0) {
        counted = actual; verified = true;
        const off = expected > 0 && Math.abs(actual - expected) > Math.max(1, expected * 0.02);
        /* An account that pays a monthly fee AND buys things is not "the wrong amount":
           one of the charges IS the fee and the rest are one-time. Said in the note, so a
           month with an extra purchase in it does not read as a billing error. */
        const feePaid = off && group.folded && inMonth.some(
          (r) => Math.abs(r.amountUsd - expected) <= Math.max(1, expected * 0.02),
        );
        if (off && feePaid) {
          status = "paid";
          note = `$${expected.toFixed(2)} recurring plus $${round2(actual - expected).toFixed(2)} one-time on the same account`;
        } else if (off) {
          status = "mismatch";
          note = `register says ${expected.toFixed(2)}`;
        } else if (expected === 0) {
          status = "unexpected";
          if (group.needsAmount) note = "no price on file for this account yet";
        } else {
          status = "paid";
        }
        if (inMonth.length > 1 && group.folded) {
          note = note || `${inMonth.length} charges on this account in ${period}`;
        }
        /* Two charges in one month on a single-line monthly plan is worth a look. On a
           folded account row it is just an account: a fee and a purchase, or two purchases. */
        if (inMonth.length > 1 && item.billing === "monthly" && !group.folded) {
          anomalies.push({
            severity: "medium", kind: "duplicate_charge", period, vendor: item.vendor, itemId: item.id,
            amountUsd: actual,
            message: `${inMonth.length} separate charges from ${item.vendor} in ${period} totalling $${actual.toFixed(2)} on a monthly plan.`,
            fix: "Confirm this is a top-up or a second seat rather than a double charge.",
          });
        }
      } else if (expected > 0) {
        const due = src?.billingDay ?? 1;
        if (period === nowMonth && daysInto(period) <= due + 3) {
          status = "pending";
          note = `charge expected around the ${ordinal(due)}`;
        } else {
          status = "missing";
          counted = expected; verified = false;
          note = "no receipt on file";
        }
      } else if (item.billing === "annual") {
        status = "prepaid";
      } else {
        status = "none";
      }

      running = round2(running + counted);
      const delta = prevCounted == null ? null : round2(counted - prevCounted);

      /* Price movement between two months that BOTH have receipts is a real price change,
         not a reconciliation artefact — worth saying out loud. */
      /* On a folded account row, only compare a single-charge month against another
         single-charge month: a month that also carried a one-time buy is a different
         question, and calling it a price rise would be false. */
      const comparable = !group.folded || (inMonth.length === 1 && prevReceiptCount === 1);
      if (actual !== 0 && prevReceiptAmount != null && prevReceiptAmount !== 0 && comparable) {
        const diff = actual - prevReceiptAmount;
        if (Math.abs(diff) > Math.max(1, Math.abs(prevReceiptAmount) * 0.05)) {
          anomalies.push({
            severity: diff > 0 ? "medium" : "info", kind: "price_change", period, vendor: item.vendor, itemId: item.id,
            amountUsd: round2(diff),
            message: `${item.vendor} · ${group.label} ${diff > 0 ? "went up" : "went down"} $${Math.abs(diff).toFixed(2)} in ${period} ($${prevReceiptAmount.toFixed(2)} → $${actual.toFixed(2)}).`,
            fix: diff > 0 ? "Check the invoice for a plan change or added seats." : undefined,
          });
        }
      }
      if (actual !== 0) { prevReceiptAmount = actual; prevReceiptCount = inMonth.length; }
      prevCounted = counted;

      cells.push({
        period, status, actualUsd: actual, meteredUsd, expectedUsd: round2(expected),
        countedUsd: round2(counted), verified, runningUsd: running, deltaUsd: delta,
        receipts: inMonth.map(toRef), note,
      });
    }

    const missingCount = cells.filter((c) => c.status === "missing").length;
    rows.push({
      itemId: item.id, vendor: item.vendor, label: group.label, category: item.category,
      billing: item.billing, status: item.status,
      monthlyUsd: round2(members.reduce((s, m) => s + monthlyEquivalent(m), 0)),
      purpose: group.purpose, lifetime: item.lifetime, needsAmount: group.needsAmount,
      domain: group.folded ? undefined : item.domain,
      foldedCount: group.folded ? members.length : undefined,
      channel: src?.channel, portal: src?.portal, emailProven, cells,
      totalCountedUsd: round2(cells.reduce((s, c) => s + c.countedUsd, 0)),
      totalVerifiedUsd: round2(cells.reduce((s, c) => s + (c.verified ? c.countedUsd : 0), 0)),
      receiptCount: mine.length,
      missingCount,
      lastReceiptAt: mine.map((r) => r.chargedAt).sort().slice(-1)[0],
    });

    /* ---- per-item anomalies, named as the row is named ---- */
    collectItemAnomalies(
      group.folded ? { ...item, label: group.label, needsAmount: group.needsAmount } : item,
      mine, cells, src, anomalies, nowMonth,
    );
  }

  rows.sort((a, b) => b.totalCountedUsd - a.totalCountedUsd || a.vendor.localeCompare(b.vendor));

  /* ---- unmatched charges: money leaving with no register row behind it ---- */
  const unmatchedMap = new Map<string, Receipt[]>();
  for (const r of receipts) {
    if (r.itemId || claimedReceiptIds.has(r.id)) continue;
    unmatchedMap.set(r.vendor, [...(unmatchedMap.get(r.vendor) || []), r]);
  }
  const unmatched = [...unmatchedMap.entries()].map(([vendor, rs]) => ({
    vendor,
    totalUsd: round2(rs.reduce((s, r) => s + r.amountUsd, 0)),
    count: rs.length,
    periods: [...new Set(rs.map((r) => r.period))].sort(),
    receipts: rs.map(toRef),
  })).sort((a, b) => b.totalUsd - a.totalUsd);

  for (const u of unmatched) {
    anomalies.push({
      severity: u.totalUsd >= 50 ? "high" : "medium", kind: "unmatched_vendor", vendor: u.vendor,
      amountUsd: u.totalUsd,
      message: `$${u.totalUsd.toFixed(2)} paid to ${u.vendor} across ${u.count} receipt${u.count > 1 ? "s" : ""} with no line item in the spend register.`,
      fix: "Add it as a line item so it shows up in the monthly burn, or tie the receipt to an existing row.",
    });
  }

  /* ---- everything else that is money out, as its own row ------------------------------
   *
   * The month-by-month table is the ledger, not a subscriptions report: a one-time buy, a
   * credit top-up, a domain renewal and a pay-per-use bill are all spend and all belong in
   * the same grid, distinguished by a label rather than exiled to a section of their own.
   * Register lines are already covered above (every billing type, no filter). These two
   * loops add the spend that has no register line at all:
   *
   *   unregistered  a receipt arrived and nothing in the register expected it
   *   ledgerOnly    pay-per-use the usage ledger recorded against a vendor with no row
   *
   * Both were previously counted in the month totals but shown nowhere in the grid, so a
   * column could exceed the rows above it with no way to see why. */
  for (const u of unmatched) {
    const rs = unmatchedMap.get(u.vendor) || [];
    let running = 0;
    let prev: number | null = null;
    const cells: MatrixCell[] = months.map((period) => {
      const inMonth = rs.filter((r) => r.period === period);
      const actual = round2(inMonth.reduce((s, r) => s + r.amountUsd, 0));
      running = round2(running + actual);
      const delta = prev == null ? null : round2(actual - prev);
      prev = actual;
      return {
        period, status: (actual !== 0 ? "unexpected" : "none") as CellStatus,
        actualUsd: actual, meteredUsd: 0, expectedUsd: 0, countedUsd: actual,
        verified: actual !== 0, runningUsd: running, deltaUsd: delta,
        receipts: inMonth.map(toRef),
      };
    });
    rows.push({
      vendor: u.vendor, label: "Not on the register", category: "other", billing: "one_time",
      status: "active", monthlyUsd: 0, unregistered: true, emailProven: rs.some((r) => r.source === "email"),
      cells,
      totalCountedUsd: round2(cells.reduce((s, c) => s + c.countedUsd, 0)),
      totalVerifiedUsd: round2(cells.reduce((s, c) => s + (c.verified ? c.countedUsd : 0), 0)),
      receiptCount: rs.length, missingCount: 0,
      lastReceiptAt: rs.map((r) => r.chargedAt).sort().slice(-1)[0],
    });
  }

  /* A ledger source is "claimed" when some register row already reports it, either by an
     explicit link or by carrying the vendor's name; anything left over is real money with
     nowhere to appear, so it gets a row of its own rather than inflating the total from
     off-screen. */
  const claimed = new Set<string>();
  for (const i of items) {
    const k = ledgerKeyFor(i);
    if (k) claimed.add(k.toLowerCase());
    claimed.add(i.vendor.toLowerCase());
  }
  const ledgerSources = new Set<string>();
  for (const period of months) for (const s of Object.keys(metered[period] || {})) ledgerSources.add(s);
  for (const source of [...ledgerSources].sort()) {
    if (claimed.has(source.toLowerCase())) continue;
    let running = 0;
    let prev: number | null = null;
    const cells: MatrixCell[] = months.map((period) => {
      const used = round2(metered[period]?.[source] || 0);
      running = round2(running + used);
      const delta = prev == null ? null : round2(used - prev);
      prev = used;
      return {
        period, status: (used !== 0 ? "metered" : "none") as CellStatus,
        actualUsd: 0, meteredUsd: used, expectedUsd: 0, countedUsd: used,
        verified: false, runningUsd: running, deltaUsd: delta, receipts: [],
      };
    });
    const total = round2(cells.reduce((s, c) => s + c.countedUsd, 0));
    if (total === 0) continue;
    rows.push({
      vendor: source, label: "Pay per use, not on the register", category: "other", billing: "metered",
      status: "active", monthlyUsd: 0, ledgerOnly: true, emailProven: false, cells,
      totalCountedUsd: total, totalVerifiedUsd: 0, receiptCount: 0, missingCount: 0,
    });
  }

  rows.sort((a, b) => b.totalCountedUsd - a.totalCountedUsd || a.vendor.localeCompare(b.vendor));

  /* ---- month totals + running total across everything ---- */
  const monthTotals: MonthTotal[] = [];
  let grandRunning = 0;
  let prevMonthCounted: number | null = null;
  for (let idx = 0; idx < months.length; idx++) {
    const period = months[idx];
    const cellsAt = rows.map((r) => r.cells[idx]);
    /* Unregistered charges and ledger-only usage are rows of their own now, so the totals
       come straight off the grid: what the columns add up to is what the rows show. */
    const counted = round2(cellsAt.reduce((s, c) => s + c.countedUsd, 0));
    const verifiedUsd = round2(cellsAt.reduce((s, c) => s + (c.verified ? c.countedUsd : 0), 0));
    const expectedUsd = round2(cellsAt.reduce((s, c) => s + c.expectedUsd, 0));
    const meteredUsd = round2(Object.values(metered[period] || {}).reduce((s, n) => s + n, 0));
    grandRunning = round2(grandRunning + counted);
    monthTotals.push({
      period, countedUsd: counted, verifiedUsd, expectedUsd, meteredUsd,
      runningUsd: grandRunning,
      deltaUsd: prevMonthCounted == null ? null : round2(counted - prevMonthCounted),
      receiptCount: cellsAt.reduce((s, c) => s + c.receipts.length, 0),
      missingCount: cellsAt.filter((c) => c.status === "missing").length,
      coveragePct: counted > 0 ? Math.round((verifiedUsd / counted) * 1000) / 10 : 100,
    });
    prevMonthCounted = counted;
  }

  /* ---- metered spikes: a pay-per-use line doubling is a spend event with no invoice ---- */
  const sources = new Set<string>();
  Object.values(metered).forEach((m) => Object.keys(m).forEach((s) => sources.add(s)));
  for (const s of sources) {
    for (let i = 1; i < months.length; i++) {
      const prev = metered[months[i - 1]]?.[s] || 0;
      const cur = metered[months[i]]?.[s] || 0;
      if (prev >= 20 && cur > prev * 1.5) {
        anomalies.push({
          severity: "medium", kind: "metered_spike", period: months[i], vendor: s,
          amountUsd: round2(cur - prev),
          message: `${s} metered cost rose from $${prev.toFixed(2)} to $${cur.toFixed(2)} in ${months[i]}.`,
          fix: "Pay-per-use has no invoice to catch this: check what ran that month.",
        });
      }
    }
  }

  /* ---- receipts that could not be turned into a picture, and shaky matches ---- */
  for (const r of receipts) {
    if (r.shotError) {
      anomalies.push({
        severity: "low", kind: "render_failed", period: r.period, vendor: r.vendor, receiptId: r.id,
        message: `The receipt image for ${r.vendor} ${r.period} could not be rendered (${r.shotError}). The amount is still counted.`,
        fix: "Open the original from the receipt drawer, or attach a screenshot by hand.",
      });
    }
    if (r.confidence < 0.6 && !r.reviewed) {
      anomalies.push({
        severity: "medium", kind: "low_confidence", period: r.period, vendor: r.vendor, receiptId: r.id,
        amountUsd: r.amountUsd,
        message: `$${r.amountUsd.toFixed(2)} from "${r.subject || r.vendor}" was matched to ${r.vendor} with low confidence (${r.matchedBy || "weak signal"}).`,
        fix: "Open it and confirm the vendor and amount, or reassign it.",
      });
    }
    if (r.currency !== "USD") {
      anomalies.push({
        severity: "low", kind: "non_usd", period: r.period, vendor: r.vendor, receiptId: r.id,
        message: `${r.vendor} invoiced ${r.nativeAmount?.toFixed(2)} ${r.currency}; converted at a fixed rate to $${r.amountUsd.toFixed(2)}.`,
        fix: "Enter the exact figure your card was charged if the total has to tie out to the statement.",
      });
    }
    if (r.kind !== "charge") {
      anomalies.push({
        severity: "info", kind: "refund", period: r.period, vendor: r.vendor, receiptId: r.id,
        amountUsd: r.amountUsd,
        message: `${r.vendor} ${r.kind === "refund" ? "refunded" : "issued a credit note for"} $${Math.abs(r.amountUsd).toFixed(2)} in ${r.period}.`,
      });
    }
  }

  if (opts.inboxConfigured === false) {
    anomalies.unshift({
      severity: "high", kind: "inbox_unconfigured", vendor: "Billing mailbox",
      message: "No billing mailbox is wired up, so no receipt can arrive on its own. Every figure on this page is the register's estimate, not proof.",
      fix: "Point the console at the mailbox the vendors already email (see the sourcing panel below).",
    });
  }

  const totalCounted = round2(monthTotals.reduce((s, m) => s + m.countedUsd, 0));
  const totalVerified = round2(monthTotals.reduce((s, m) => s + m.verifiedUsd, 0));
  const current = monthTotals[monthTotals.length - 1];
  const prior = monthTotals[monthTotals.length - 2];
  const closed = monthTotals.slice(0, -1);

  anomalies.sort((a, b) => sev(b.severity) - sev(a.severity) || (b.amountUsd || 0) - (a.amountUsd || 0));

  return {
    months, rows, monthTotals, unmatched, anomalies,
    totals: {
      allTimeCountedUsd: totalCounted,
      allTimeVerifiedUsd: totalVerified,
      receiptCount: receipts.length,
      missingCount: monthTotals.reduce((s, m) => s + m.missingCount, 0),
      coveragePct: totalCounted > 0 ? Math.round((totalVerified / totalCounted) * 1000) / 10 : 100,
      currentMonthUsd: current?.countedUsd || 0,
      priorMonthUsd: prior?.countedUsd || 0,
      avgMonthUsd: closed.length ? round2(closed.reduce((s, m) => s + m.countedUsd, 0) / closed.length) : 0,
    },
  };
}

function sev(s: AnomalySeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
}
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}


/** What the register says a given month should cost for one line item. */
function expectedFor(item: SpendItem, period: string): number {
  if (item.status !== "active") return 0;
  const startMonth = (item.at || "").slice(0, 7);
  if (startMonth && period < startMonth) return 0;
  if (item.billing === "monthly") return item.amountUsd;
  if (item.billing === "annual") {
    if (!startMonth) return 0;
    const monthsSince = monthDiff(startMonth, period);
    return monthsSince >= 0 && monthsSince % 12 === 0 ? item.amountUsd : 0;
  }
  // one-time and credit purchases are expected only in the month they were made; metered
  // has no expected figure at all (the ledger carries it).
  if (item.billing === "one_time" || item.billing === "credit") return startMonth === period ? item.amountUsd : 0;
  return 0;
}
function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function toRef(r: Receipt): ReceiptRef {
  return {
    id: r.id, amountUsd: r.amountUsd, chargedAt: r.chargedAt, invoiceNumber: r.invoiceNumber,
    hasShot: r.hasShot, hasFile: !!r.fileMime, source: r.source, confidence: r.confidence,
    reviewed: r.reviewed, kind: r.kind, subject: r.subject, shotError: r.shotError,
  };
}

/** Everything that can be wrong with ONE line item's history. */
function collectItemAnomalies(
  item: SpendItem,
  mine: Receipt[],
  cells: MatrixCell[],
  src: ReturnType<typeof vendorSourceFor>,
  out: Anomaly[],
  nowMonth: string,
): void {
  const missing = cells.filter((c) => c.status === "missing");
  if (missing.length) {
    const periods = missing.map((c) => c.period);
    out.push({
      severity: missing.length > 1 ? "high" : "medium", kind: "missing_receipt",
      period: periods[periods.length - 1], vendor: item.vendor, itemId: item.id,
      amountUsd: round2(missing.reduce((s, c) => s + c.expectedUsd, 0)),
      message: `${item.vendor} · ${item.label}: no receipt for ${periods.length} month${periods.length > 1 ? "s" : ""} (${periods.join(", ")}), $${round2(missing.reduce((s, c) => s + c.expectedUsd, 0)).toFixed(2)} unaccounted for.`,
      fix: src?.portal ? `Download the invoice from ${src.portal} and attach it, or forward the receipt email to the billing mailbox.` : "Forward the receipt email to the billing mailbox, or attach the invoice by hand.",
    });
  }

  const mismatches = cells.filter((c) => c.status === "mismatch");
  for (const c of mismatches) {
    out.push({
      severity: "medium", kind: "amount_mismatch", period: c.period, vendor: item.vendor, itemId: item.id,
      amountUsd: round2(c.actualUsd - c.expectedUsd),
      message: `${item.vendor} · ${item.label} charged $${c.actualUsd.toFixed(2)} in ${c.period}; the register says $${c.expectedUsd.toFixed(2)}.`,
      fix: "Update the register price, or find out what changed on the invoice.",
    });
  }

  /* A charge against a row that has no price on file is not a surprise charge: it is the
     price arriving. The one thing to say about that row is already said, once, by
     no_price_on_file below. */
  const unexpected = item.needsAmount ? [] : cells.filter((c) => c.status === "unexpected");
  for (const c of unexpected) {
    out.push({
      severity: "low", kind: "unexpected_charge", period: c.period, vendor: item.vendor, itemId: item.id,
      amountUsd: c.actualUsd,
      message: `${item.vendor} · ${item.label} charged $${c.actualUsd.toFixed(2)} in ${c.period} with nothing expected that month.`,
      fix: item.billing === "credit" ? "Normal for a credit top-up." : "Check whether the billing cycle moved.",
    });
  }

  if (item.status === "cancelled") {
    const after = cells.filter((c) => c.actualUsd > 0 && c.period >= nowMonth);
    if (after.length) {
      out.push({
        severity: "high", kind: "charged_after_cancel", period: after[0].period, vendor: item.vendor, itemId: item.id,
        amountUsd: after.reduce((s, c) => s + c.actualUsd, 0),
        message: `${item.vendor} · ${item.label} is marked cancelled but still charged in ${after.map((c) => c.period).join(", ")}.`,
        fix: "Cancel it at the vendor, or mark the line item active again.",
      });
    }
  }

  /* A hole in the middle of an otherwise clean series is the easiest thing to miss. */
  const paidIdx = cells.map((c, i) => (c.receipts.length ? i : -1)).filter((i) => i >= 0);
  if (paidIdx.length >= 2) {
    for (let i = paidIdx[0]; i < paidIdx[paidIdx.length - 1]; i++) {
      if (!cells[i].receipts.length && cells[i].status !== "prepaid" && cells[i].status !== "none") {
        out.push({
          severity: "medium", kind: "gap_in_series", period: cells[i].period, vendor: item.vendor, itemId: item.id,
          message: `${item.vendor} · ${item.label} has receipts either side of ${cells[i].period} but none for it.`,
          fix: "The receipt exists somewhere: search the mailbox for that month or pull it from the vendor portal.",
        });
        break;
      }
    }
  }

  /* A paid-once licence has no recurring charge, so neither "no price on file" nor "never
     receipted" is a fault: there is nothing further to collect. It is reported as settled
     in the sourcing panel rather than raised as a gap here. */
  if (item.lifetime) {
    // nothing to chase
  } else if (item.needsAmount && !mine.length && item.status === "active" && item.billing !== "metered") {
    out.push({
      severity: "high", kind: "no_price_on_file", vendor: item.vendor, itemId: item.id,
      message: `${item.vendor} · ${item.label} has no price on file and no receipt has ever arrived, so it is invisible in the monthly burn.`,
      fix: src?.portal ? `Pull one invoice from ${src.portal} to establish the figure.` : "Enter the invoice figure, or forward one receipt to the billing mailbox.",
    });
  } else if (item.needsAmount && mine.length && item.status === "active" && item.billing !== "metered") {
    /* The receipts prove what was charged; the register still expects nothing, so every
       month without a receipt reads $0 instead of reading as a gap. */
    const last = mine.map((r) => r.amountUsd).slice(-1)[0] || 0;
    out.push({
      severity: "medium", kind: "no_price_on_file", vendor: item.vendor, itemId: item.id,
      amountUsd: round2(last),
      message: `${item.vendor} · ${item.label} has receipts on file but no price in the register, so any month without one reads as $0 rather than as a gap.`,
      fix: `Set the recurring amount from the invoice (the last one was $${round2(last).toFixed(2)}).`,
    });
  } else if (!mine.length && item.status === "active" && item.billing !== "metered" && monthlyEquivalent(item) > 0) {
    out.push({
      severity: "medium", kind: "never_receipted", vendor: item.vendor, itemId: item.id,
      amountUsd: monthlyEquivalent(item),
      message: `${item.vendor} · ${item.label} costs $${monthlyEquivalent(item).toFixed(2)}/mo but not one receipt has ever been captured for it.`,
      fix: src?.channel === "portal_only"
        ? "This vendor does not email receipts: download one from the portal and attach it."
        : "Add the billing mailbox to this vendor's account so its receipts start arriving.",
    });
  }
}

/* ============================ per-vendor sourcing status ============================ */

export interface SourcingRow {
  vendor: string;
  channel: string;
  from: string[];
  portal?: string;
  api?: string;
  setup?: string;
  /** Receipts captured for this vendor, and how. */
  emailCount: number;
  manualCount: number;
  /** Figures pulled straight from the vendor's own billing API. */
  apiCount: number;
  /** Documents a signed-in browser session took off the vendor's billing page. */
  portalCount: number;
  lastAt?: string;
  /** What the owner still has to do, if anything. */
  state: "api" | "portal" | "auto" | "manual" | "portal_unset" | "unproven" | "lifetime" | "not_billed";
  advice: string;
  /** The puller's own last word, when one has been set up for this vendor. */
  puller?: {
    ready: boolean;
    route: string;
    state: string;
    lastRunAt?: string;
    /** Days since it last ran, or null when it never has. */
    ranDaysAgo: number | null;
    /** True when the puller has stopped reporting, whatever it last said. */
    stalled: boolean;
    charges?: number;
    receipted?: number;
    missing?: Array<{ date?: string; amount?: number; reason: string }>;
    error?: string;
    action?: string;
    /** Machine the puller runs on, so a dead sweep can be traced to a box. */
    host?: string;
  };
}

/**
 * The panel that keeps the report honest going forward: for every vendor in the register,
 * whether receipts are arriving on their own, and if not, exactly what to do about it.
 */
export function sourcingStatus(items: SpendItem[], receipts: Receipt[], pullers: PullerState[] = []): SourcingRow[] {
  const vendors = [...new Set(items.map((i) => i.vendor))];
  for (const r of receipts) if (!vendors.includes(r.vendor)) vendors.push(r.vendor);
  /* A puller reporting on a vendor that is not in the register yet still has to show up.
     Otherwise the one case that matters most, a vendor being paid that nothing is
     collecting for, would be the one case invisible on this page. */
  for (const p of pullers) if (!vendors.some((v) => v.toLowerCase() === p.vendor.toLowerCase())) vendors.push(p.vendor);

  const pullerByVendor = new Map(pullers.map((p) => [p.vendor.toLowerCase(), p]));

  return vendors.map((vendor) => {
    const src = vendorSourceFor(vendor) || VENDOR_SOURCES.find((s) => vendor.toLowerCase().includes(s.vendor.toLowerCase()));
    const mine = receipts.filter((r) => r.vendor.toLowerCase() === vendor.toLowerCase());
    const emailCount = mine.filter((r) => r.source === "email").length;
    const manualCount = mine.filter((r) => r.source === "manual").length;
    const apiCount = mine.filter((r) => r.source === "api").length;
    const portalCount = mine.filter((r) => r.source === "portal").length;
    const own = items.filter((i) => i.vendor === vendor);
    const pull = pullerRow(pullerByVendor.get(vendor.toLowerCase()));
    /* A vendor a puller reports on is one we pay, whether or not the register lists it
       yet, so its charges count as billed. Without this a vendor that is missing from the
       register would be reported as "nothing is billed here", which is exactly backwards
       when the reason there are no figures is that nothing is collecting them. */
    const billed = own.some((i) => i.status === "active" && (i.amountUsd > 0 || i.billing === "metered" || i.needsAmount))
      || Boolean(pull && ((pull.charges ?? 0) > 0 || !pull.ready));
    /* Bought outright: every live row for this vendor is a paid-once licence, so there is
       no recurring charge in existence to receipt. Checked FIRST, because "no receipt has
       ever arrived" is only a problem when something is actually being charged. */
    const live = own.filter((i) => i.status === "active");
    const lifetime = live.length > 0 && live.every((i) => i.lifetime);

    /* A browser session is the answer when the vendor emails nothing at all, so email
       harvesting can never work for it, or when one has already been set up. */
    const pullerIsTheRoute = src?.channel === "portal_only" || Boolean(pull);
    const pullerWorking = Boolean(
      pull && pull.ready && !pull.stalled && pull.state !== "setup-needed" && pull.state !== "error",
    );
    const needsPuller = billed && pullerIsTheRoute && !pullerWorking;

    let state: SourcingRow["state"];
    let advice: string;
    if (lifetime) {
      state = "lifetime";
      advice = `Paid once, outright: no subscription, no monthly fee, and nothing recurring to receipt. ` +
        (mine.length
          ? `${mine.length} purchase receipt${mine.length > 1 ? "s are" : " is"} on file. `
          : `The original purchase predates this register, so no receipt is expected. `) +
        `If growth ever forces a credit top-up, the receipt for that purchase is captured here automatically.`;
    } else if (apiCount > 0) {
      state = "api";
      advice = `Pulled straight from the vendor's billing API every night (${apiCount} month${apiCount > 1 ? "s" : ""} on file)${emailCount ? `, plus ${emailCount} emailed receipt${emailCount > 1 ? "s" : ""}` : ""}. This one cannot go unreported.`;
    } else if (portalCount > 0 && !pull?.stalled) {
      state = "portal";
      advice = `A signed-in browser session takes the invoice off ${src?.portal || "the vendor's billing page"} on the day it charges (${portalCount} on file)` +
        `${emailCount ? `, plus ${emailCount} emailed receipt${emailCount > 1 ? "s" : ""}` : ""}.` +
        (pull?.missing?.length ? ` ${pull.missing.length} charge${pull.missing.length > 1 ? "s are" : " is"} still waiting on the vendor to publish a document.` : "");
    } else if (!billed) {
      state = "not_billed";
      advice = "Nothing is billed here, so no receipt is expected.";
    } else if (needsPuller) {
      /* Charged money, no email channel that works, and no browser session collecting it.
         This is the hole: nothing is fetching this vendor's receipt, and saying so is the
         only thing that gets it fixed. */
      state = "portal_unset";
      advice = !pull
        ? `Nothing is collecting this vendor's receipt. It emails none and has no billing API, so it needs a browser session signed in once: run "node receipts.mjs login ${pullerSlug(vendor)}" in the spend-ledger tool, then let the daily sweep take the invoice off ${src?.portal || "their billing page"} on the day it charges.`
        : pull.stalled
          ? `The puller for this vendor has not reported in ${pull.ranDaysAgo ?? "several"} days, so nothing has been collected since. Check the scheduled sweep${pull.host ? ` on ${pull.host}` : ""}.`
          : pull.action || `The puller for this vendor is set up but is not collecting: ${pull.error || "it has not run yet"}.`;
    } else if (emailCount > 0) {
      state = "auto";
      advice = `Receipts arrive by email and are captured automatically (${emailCount} on file).`;
    } else if (manualCount > 0) {
      state = "manual";
      advice = `Only hand-attached receipts so far. Add the billing mailbox to this vendor's account so it reports itself.`;
    } else {
      state = "unproven";
      advice = src?.channel === "portal_only"
        ? `No email receipt exists for this vendor. Download invoices from ${src.portal || "the vendor portal"} and attach them each month.`
        : `No receipt has ever arrived. Add the billing mailbox as a billing contact at ${src?.portal || "the vendor"}, then re-run the sweep over the last two months.`;
    }

    return {
      vendor,
      channel: src?.channel || "email_vendor",
      from: src?.from || [],
      portal: src?.portal,
      api: src?.api,
      setup: src?.setup,
      emailCount, manualCount, apiCount, portalCount,
      lastAt: mine.map((r) => r.chargedAt).sort().slice(-1)[0],
      state, advice,
      puller: pull,
    };
  }).sort((a, b) => rank(a.state) - rank(b.state) || a.vendor.localeCompare(b.vendor));
}

/** The id the spend-ledger tool knows this vendor by, for the commands shown to the owner. */
function pullerSlug(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Fold a puller's raw report into what the console needs, including the one judgement
 * the puller cannot make about itself: whether it has stopped reporting. A puller that
 * last said "ok" a fortnight ago is not ok, it is dead, and the row has to say so.
 */
function pullerRow(p?: PullerState): SourcingRow["puller"] {
  if (!p) return undefined;
  const ms = p.lastRunAt ? Date.now() - Date.parse(p.lastRunAt) : NaN;
  const ranDaysAgo = isFinite(ms) ? Math.floor(ms / 86400000) : null;
  return {
    ready: p.ready,
    route: p.route,
    state: p.state,
    lastRunAt: p.lastRunAt,
    ranDaysAgo,
    stalled: ranDaysAgo != null && ranDaysAgo > PULLER_STALE_DAYS,
    charges: p.charges,
    receipted: p.receipted,
    missing: p.missing,
    error: p.error,
    action: p.action,
    host: p.host,
  };
}

/** Sort order = how much the owner still has to do about it. Settled rows sink. */
function rank(s: SourcingRow["state"]): number {
  return s === "portal_unset" ? 0 : s === "unproven" ? 1 : s === "manual" ? 2
    : s === "auto" ? 3 : s === "portal" ? 4 : s === "api" ? 5 : s === "lifetime" ? 6 : 7;
}
