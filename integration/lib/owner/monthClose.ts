/**
 * RecruitersOS · the month closes itself
 *
 * Spend master can already say whether a month is fully receipted. What it could not do is
 * say so WITHOUT SOMEONE LOOKING. A nightly sweep that collects nothing, a browser session
 * that lapsed in week one, a vendor that stopped emailing: all three look identical to a
 * console nobody opened, and the first anyone hears of it is a quarter with no paperwork.
 *
 * So this closes each month on its own and speaks up only when a person is genuinely
 * needed. Every day it asks two questions:
 *
 *   1. Is the last CLOSED month fully proven? (settled / short / blocked)
 *   2. Is anything collecting at all, right now?
 *
 * Silence means the books are proven. That is the whole contract: no news is the good news,
 * and the only mail that arrives is mail that needs an answer.
 *
 * Two rules keep it from becoming noise, because an alert that arrives every morning gets
 * filtered within a week and then it may as well not exist:
 *
 *   - a month is only chased after a grace window, since vendors routinely bill days late;
 *   - the same picture is never reported twice. `digest` fingerprints the gaps, so a repeat
 *     only goes out when something CHANGED, or after a week of no movement.
 *
 * Nothing here decides what a gap means: the reasons and the fixes come straight from
 * `sourcingStatus`, so the console and the email can never disagree about what is wrong.
 */

import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { SpendMatrix, SourcingRow } from "./spendMatrix";

/* ============================ what a month owes ============================ */

export interface MonthGap {
  vendor: string;
  label: string;
  itemId?: string;
  /** What the register says this month should have cost. */
  expectedUsd: number;
  /** "missing" = no document at all. "mismatch" = a document that disagrees with the register. */
  kind: "missing" | "mismatch";
  /** Why it is not proven, in the same words the console uses. */
  reason: string;
  /** The one thing that would fix it, or absent when nobody has to do anything. */
  action?: string;
  /** True when the cause is that nothing is collecting for this vendor at all. */
  blocked: boolean;
}

export interface MonthClose {
  period: string;
  /** settled: every dollar proven. short: gaps, but collection is working. blocked: nothing is collecting. */
  state: "settled" | "short" | "blocked";
  expectedUsd: number;
  provenUsd: number;
  coveragePct: number;
  gaps: MonthGap[];
  /** Fingerprint of the gaps: an unchanged picture is never reported twice. */
  digest: string;
  checkedAt: string;
  /** Set when the mailbox channel itself is down, which stops every emailed receipt at once. */
  mailboxError?: string;
}

/** Stable, order-independent fingerprint. Two runs that found the same gaps agree. */
function digestOf(gaps: MonthGap[], mailboxError?: string): string {
  const parts = gaps
    .map((g) => `${g.vendor}|${g.label}|${g.kind}|${g.expectedUsd.toFixed(2)}|${g.blocked ? "b" : "-"}`)
    .sort();
  if (mailboxError) parts.push(`mailbox|${mailboxError}`);
  if (!parts.length) return "settled";
  let h = 0;
  for (const ch of parts.join("\n")) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return `${parts.length}:${(h >>> 0).toString(36)}`;
}

/**
 * What one month looks like once the sweep has run. Pure, so the whole decision can be
 * tested against a fixture instead of a mailbox and a browser.
 *
 * A gap is money the register expected and no document proves. The REASON comes from the
 * vendor's sourcing row, which already knows whether a puller is stalled, whether a browser
 * session was never set up, or whether everything is working and the vendor simply has not
 * published yet. That distinction is the difference between "wait" and "act", and it is the
 * only thing worth waking someone up for.
 */
export function assessMonth(
  period: string,
  matrix: SpendMatrix,
  sourcing: SourcingRow[],
  opts: { mailboxError?: string } = {},
): MonthClose {
  const byVendor = new Map(sourcing.map((s) => [s.vendor.toLowerCase(), s]));
  const gaps: MonthGap[] = [];
  let expectedUsd = 0;
  let provenUsd = 0;

  for (const row of matrix.rows) {
    const cell = row.cells.find((c) => c.period === period);
    if (!cell) continue;
    /* The denominator is money we KNOW ABOUT, not money the register predicted. A charge
       proven by an invoice against a row with no price on file is still spend that month,
       and counting only the prediction produced coverage over 100% on the real books. */
    const proven = cell.verified ? Math.abs(cell.actualUsd || 0) : 0;
    expectedUsd += Math.max(cell.expectedUsd || 0, proven);
    provenUsd += proven;

    if (cell.status !== "missing" && cell.status !== "mismatch") continue;
    /* A row with no price on file is a hole in the register, not an uncollected receipt.
       It shows on the console in its own right; chasing a document for an unknown figure
       would be chasing nothing. */
    if (row.needsAmount && cell.status === "missing") continue;

    const src = byVendor.get(row.vendor.toLowerCase());
    const blocked = src?.state === "portal_unset" || Boolean(src?.puller?.stalled) || Boolean(opts.mailboxError);
    gaps.push({
      vendor: row.vendor,
      label: row.label,
      itemId: row.itemId,
      expectedUsd: cell.expectedUsd || row.monthlyUsd || 0,
      kind: cell.status === "mismatch" ? "mismatch" : "missing",
      reason: cell.note || src?.advice || "no receipt has arrived for this charge",
      action: blocked ? src?.puller?.action || src?.advice : undefined,
      blocked,
    });
  }

  const state: MonthClose["state"] = !gaps.length
    ? "settled"
    : gaps.some((g) => g.blocked)
      ? "blocked"
      : "short";

  return {
    period,
    state,
    expectedUsd: round2(expectedUsd),
    provenUsd: round2(provenUsd),
    coveragePct: expectedUsd > 0 ? Math.round((provenUsd / expectedUsd) * 100) : 100,
    gaps: gaps.sort((a, b) => b.expectedUsd - a.expectedUsd),
    digest: digestOf(gaps, opts.mailboxError),
    checkedAt: new Date().toISOString(),
    mailboxError: opts.mailboxError,
  };
}

/* ============================ is anything collecting ============================ */

export interface CollectorHealth {
  /** True when at least one channel could bring in a document today. */
  collecting: boolean;
  /** Vendors being charged with nothing fetching their receipt, dearest first. */
  blockedVendors: Array<{ vendor: string; advice: string; monthlyUsd: number }>;
  mailboxError?: string;
  /** Days since any puller last reported, or null when none ever has. */
  pullerSilentDays: number | null;
  digest: string;
}

/**
 * The early warning, and the reason this is not just a month-end job.
 *
 * A lapsed session on the 2nd is four weeks of lost paperwork by the time the month closes.
 * Asked daily, this catches it on the 2nd.
 */
export function assessCollectors(
  sourcing: SourcingRow[],
  opts: { mailboxError?: string; monthlyByVendor?: Record<string, number> } = {},
): CollectorHealth {
  /* Ordered by what it costs to keep ignoring. A list of a dozen vendors is read top-down
     and abandoned halfway, so the $71/mo box has to be above the $0 row nobody has priced. */
  const monthly = (v: string) => opts.monthlyByVendor?.[v.toLowerCase()] || 0;
  const blockedVendors = sourcing
    .filter((s) => s.state === "portal_unset" || (s.puller?.stalled && s.state !== "not_billed" && s.state !== "lifetime"))
    .map((s) => ({ vendor: s.vendor, advice: s.puller?.action || s.advice, monthlyUsd: monthly(s.vendor) }))
    .sort((a, b) => b.monthlyUsd - a.monthlyUsd || a.vendor.localeCompare(b.vendor));

  const ran = sourcing.map((s) => s.puller?.ranDaysAgo).filter((n): n is number => typeof n === "number");
  const pullerSilentDays = ran.length ? Math.min(...ran) : null;

  /* An API vendor collects itself, so a working one means the books are not blind even when
     every browser session has lapsed. */
  const working = sourcing.some((s) => s.state === "api" || s.state === "portal" || s.state === "auto");

  const parts = [
    ...blockedVendors.map((b) => b.vendor.toLowerCase()).sort(),
    opts.mailboxError ? "mailbox" : "",
    pullerSilentDays !== null && pullerSilentDays > 8 ? `silent${Math.min(pullerSilentDays, 99)}` : "",
  ].filter(Boolean);

  return {
    collecting: working && !opts.mailboxError,
    blockedVendors,
    mailboxError: opts.mailboxError,
    pullerSilentDays,
    digest: parts.length ? parts.join(",") : "ok",
  };
}

/* ============================ what has already been said ============================ */

interface Said {
  digest: string;
  at: string;
  count: number;
}

interface CloseStore {
  /** Per closed month: the last assessment and what was reported about it. */
  months: Record<string, { state: MonthClose["state"]; digest: string; firstSeenAt: string; checkedAt: string; settledAt?: string; said?: Said; settledSaid?: boolean }>;
  /** The collector alert, which is not tied to a month. */
  collectors?: Said;
}

const SNAP_KEY = "owner_receipt_close_v1";
const store: CloseStore = { months: {} };
let hydrated: Promise<void> | null = null;
const persist = debouncedSaver(SNAP_KEY, () => store);

export function ensureCloseReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<CloseStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s?.months) store.months = s.months;
        if (s?.collectors) store.collectors = s.collectors;
      })
      .catch(() => {});
  }
  return hydrated;
}
void ensureCloseReady();

/** Everything the console needs to show that the books are closing themselves. */
export function closeHistory(): Array<{ period: string; state: string; checkedAt: string; settledAt?: string; reportedAt?: string }> {
  return Object.entries(store.months)
    .map(([period, m]) => ({ period, state: m.state, checkedAt: m.checkedAt, settledAt: m.settledAt, reportedAt: m.said?.at }))
    .sort((a, b) => b.period.localeCompare(a.period));
}

/**
 * Should this be reported, and why not if not.
 *
 * The bar is deliberately high. Something that mails every morning is filtered inside a
 * week, and a filtered alert is worse than none: it looks like cover while providing none.
 */
export function shouldReport(prev: Said | undefined, digest: string, now: Date, quietDays = 7): { report: boolean; why: string } {
  if (digest === "settled" || digest === "ok") return { report: false, why: "nothing is wrong" };
  if (!prev) return { report: true, why: "first time this has been seen" };
  if (prev.digest !== digest) return { report: true, why: "what is wrong has changed" };
  const days = (now.getTime() - new Date(prev.at).getTime()) / 86400000;
  if (days >= quietDays) return { report: true, why: `unchanged for ${Math.floor(days)} days` };
  return { report: false, why: `already reported ${Math.floor(days)}d ago and nothing has changed` };
}

/** Record what a run found, and whether it was reported. */
export function recordClose(close: MonthClose, reported: boolean, now = new Date()): void {
  const prev = store.months[close.period];
  const m = store.months[close.period] = {
    state: close.state,
    digest: close.digest,
    firstSeenAt: prev?.firstSeenAt || now.toISOString(),
    checkedAt: close.checkedAt,
    settledAt: close.state === "settled" ? prev?.settledAt || now.toISOString() : undefined,
    said: prev?.said,
    settledSaid: prev?.settledSaid,
  };
  if (reported) m.said = { digest: close.digest, at: now.toISOString(), count: (prev?.said?.count || 0) + 1 };
  persist();
}

export function lastSaid(period: string): Said | undefined { return store.months[period]?.said; }
export function settledAlreadySaid(period: string): boolean { return Boolean(store.months[period]?.settledSaid); }
export function markSettledSaid(period: string): void {
  const m = store.months[period];
  if (m) { m.settledSaid = true; persist(); }
}
export function collectorsSaid(): Said | undefined { return store.collectors; }
export function recordCollectors(digest: string, now = new Date()): void {
  store.collectors = { digest, at: now.toISOString(), count: (store.collectors?.count || 0) + 1 };
  persist();
}

/* ============================ which month is being closed ============================ */

/**
 * The most recent month whose charges have all landed, or null when the new one is too
 * young to judge. Vendors bill days late as a matter of course, so a month is not short
 * until the grace window has passed; declaring it short on the 1st would report a gap that
 * fills itself on the 3rd, every single month, and teach the reader to ignore it.
 */
export function monthToClose(now = new Date(), graceDays = 3): string | null {
  if (now.getUTCDate() <= graceDays) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ============================ what the email says ============================ */

const CONSOLE = "https://recruitersos.co/owner-console#burn";

function money(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

function monthName(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

/**
 * The month-end email. Written to be actionable from a phone screen: what is unproven,
 * in dollars, and the one command that fixes it. No dashboard tour, no metrics.
 */
export function monthReport(close: MonthClose): { subject: string; body: string } {
  const short = close.gaps.reduce((n, g) => n + g.expectedUsd, 0);
  const name = monthName(close.period);
  const subject = close.state === "blocked"
    ? `${name}: ${money(short)} unproven, and nothing is collecting it`
    : `${name}: ${money(short)} has no receipt yet`;

  const lines: string[] = [];
  lines.push(
    close.state === "blocked"
      ? `${name} closed with ${money(short)} that no document proves, and the reason is that nothing is fetching those receipts. This will repeat every month until it is fixed.`
      : `${name} closed with ${money(short)} that no document proves yet. Collection is working, so this may still arrive on its own.`,
  );
  lines.push("");
  lines.push(`Proven: ${money(close.provenUsd)} of ${money(close.expectedUsd)} (${close.coveragePct}%).`);
  lines.push("");

  if (close.mailboxError) {
    lines.push("The billing mailbox is refusing sign-in, which stops every emailed receipt at once:");
    lines.push(`  ${close.mailboxError}`);
    lines.push("");
  }

  lines.push("Not proven:");
  for (const g of close.gaps) {
    lines.push(`  ${g.vendor} · ${g.label}: ${money(g.expectedUsd)}${g.kind === "mismatch" ? " (the receipt disagrees with the register)" : ""}`);
    lines.push(`      ${g.action || g.reason}`);
  }

  lines.push("");
  lines.push(`Everything else in ${name} is filed with the vendor's own invoice.`);
  lines.push(CONSOLE);
  return { subject, body: lines.join("\n") };
}

/** The all-clear, sent once per month. Proof the checking is happening, not just the alarms. */
export function settledReport(close: MonthClose): { subject: string; body: string } {
  const name = monthName(close.period);
  return {
    subject: `${name} closed: every charge has its invoice`,
    body: [
      `${name} is fully receipted. ${money(close.provenUsd)} of spend, every dollar with the vendor's own document behind it.`,
      "",
      "Nothing needs doing. This is the only mail you get in a month that closes cleanly.",
      CONSOLE,
    ].join("\n"),
  };
}

/**
 * The early warning, sent mid-month rather than at month end.
 *
 * A session that lapsed on the 2nd costs four weeks of paperwork if the first anyone hears
 * of it is the month-end report.
 */
export function collectorReport(health: CollectorHealth): { subject: string; body: string } {
  const lines: string[] = [];
  const n = health.blockedVendors.length;
  const subject = health.mailboxError
    ? "Receipt collection is down: the billing mailbox is refusing sign-in"
    : `Receipt collection has stopped for ${n} vendor${n === 1 ? "" : "s"}`;

  lines.push("Charges are still going through, but nothing is collecting the invoices for them. Left alone this becomes a month with no paperwork.");
  lines.push("");
  if (health.mailboxError) {
    lines.push(`Billing mailbox: ${health.mailboxError}`);
    lines.push("");
  }
  if (health.pullerSilentDays !== null && health.pullerSilentDays > 8) {
    lines.push(`The receipt sweep has not reported for ${health.pullerSilentDays} days. It runs on your machine, so it needs that machine on and signed in.`);
    lines.push("");
  }
  /* Capped on purpose. A dozen vendors in one mail reads as a project and gets deferred;
     the dearest few read as a task and get done. The rest are on the console. */
  const SHOWN = 6;
  const priced = health.blockedVendors.filter((b) => b.monthlyUsd > 0);
  const shown = (priced.length ? priced : health.blockedVendors).slice(0, SHOWN);
  for (const b of shown) {
    lines.push(`  ${b.vendor}${b.monthlyUsd ? `, ${money(b.monthlyUsd)}/mo` : ""}`);
    lines.push(`      ${b.advice}`);
  }
  const rest = health.blockedVendors.length - shown.length;
  if (rest > 0) lines.push(`  ...and ${rest} more, listed on the console.`);
  lines.push("");
  lines.push(CONSOLE);
  return { subject, body: lines.join("\n") };
}

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
