/**
 * RecruitersOS · Owner · Client-portal statement charges (OWNER ONLY to write)
 *
 * The owner's approval-gated billing pass-through. From the owner console the
 * owner STAGES a monthly charge for an account (pulled from that account's
 * month-to-month price field), then APPROVES it. Only approved charges are ever
 * returned to the client-facing portal (app.lumesp.com "Spending" tab), so
 * nothing appears in front of a customer until the owner has explicitly signed
 * off on it.
 *
 * Two kinds of charge can be staged:
 *   - "monthly_price": the recurring subscription line. Its amount is locked to
 *     the account's month-to-month price (read server-side, never from the body),
 *     so an arbitrary recurring figure can never be pushed to a client portal.
 *   - "usage": a one-time line item the owner pushes from a real cost row in the
 *     owner console (Cost by category / Recent cost events), one row at a time.
 *     The amount comes from that actual usage row, not a free-typed number.
 *
 * One hard rule holds for both: a charge is invisible to the client until the
 * owner approves it (status === "approved").
 *
 * In-memory reference store + debounced Postgres snapshot, same pattern as the
 * billing ledger and account-meta store, so it survives restarts when
 * DATABASE_URL is set and runs purely in-memory otherwise.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export type ChargeStatus = "pending" | "approved";
export type ChargeCadence = "monthly" | "annual" | "one_time";
export type ChargeSource = "monthly_price" | "usage";

/**
 * The actual receipt behind a pushed usage line. When the owner forwards a
 * receipt off the Month-by-month grid, the charge carries enough of that
 * receipt's identity for the client portal to show it in full: who charged,
 * when, the invoice number, and — via receiptId — the invoice image itself,
 * served back to the client through the session-scoped image endpoint. Nothing
 * here is the amount (that stays on the charge); this is the proof beside it.
 */
export interface ChargeReceipt {
  /** Owner-vault receipt id. NEVER sent to the client; the image endpoint
   *  resolves it server-side from the approved charge so invoices stay scoped. */
  receiptId: string;
  vendor?: string;
  /** ISO date the charge posted (the receipt's own date). */
  chargedAt?: string;
  invoiceNumber?: string;
  /** A rendered PNG of the invoice exists on disk. */
  hasShot?: boolean;
  /** An original PDF/image (as the vendor sent it) exists on disk. */
  hasFile?: boolean;
}

export interface PortalCharge {
  id: string;
  workspaceId: string;
  /** What the customer sees on the line item, e.g. "Monthly subscription". */
  label: string;
  amountUsd: number;
  /** "monthly" = recurring subscription; "one_time" = a pushed usage line item. */
  cadence: ChargeCadence;
  /** Where the amount came from: the monthly-price field, or a real usage row. */
  source: ChargeSource;
  /** Client portal shows the row only when this is "approved". */
  status: ChargeStatus;
  /** The receipt this line was pushed from, when it was pushed from one. Carries
   *  the invoice image and its details through to the client's Spending page. */
  receipt?: ChargeReceipt;
  createdAt: string;
  approvedAt?: string;
}

const store = { charges: [] as PortalCharge[] };

/* ---------------- durability ---------------- */
const SNAP_KEY = "owner_portal_charges";
function serialize() {
  return { charges: store.charges };
}
function hydrate(s: any) {
  if (s?.charges) store.charges = s.charges;
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensurePortalChargesReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensurePortalChargesReady();

/* ---------------- read ---------------- */

/** All charges for an account (owner view, any status), newest first. */
export function listCharges(workspaceId: string): PortalCharge[] {
  return store.charges
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Approved charges only (client-portal view), newest first. */
export function listApprovedCharges(workspaceId: string): PortalCharge[] {
  return listCharges(workspaceId).filter((c) => c.status === "approved");
}

/** Sum of approved recurring charges = what this account is billed per month. */
export function approvedMonthlyTotal(workspaceId: string): number {
  return round(
    listApprovedCharges(workspaceId)
      .filter((c) => (c.cadence || "monthly") === "monthly")
      .reduce((s, c) => s + c.amountUsd, 0),
  );
}

/** Sum of approved annual charges = what this account is billed per year for
 *  yearly-cadence lines (a domain renewal, an annual plan). Kept apart from the
 *  monthly run-rate so the client statement can show each at its true period. */
export function approvedAnnualTotal(workspaceId: string): number {
  return round(
    listApprovedCharges(workspaceId)
      .filter((c) => c.cadence === "annual")
      .reduce((s, c) => s + c.amountUsd, 0),
  );
}

/** Sum of approved one-time (usage) charges: pushed rows, billed once. */
export function approvedOneTimeTotal(workspaceId: string): number {
  return round(
    listApprovedCharges(workspaceId)
      .filter((c) => c.cadence === "one_time")
      .reduce((s, c) => s + c.amountUsd, 0),
  );
}

/* ---------------- write (owner only, guarded by the route) ---------------- */

/**
 * Stage a month-to-month charge for an account. The amount MUST be the account's
 * month-to-month price (passed in by the route from account meta); an amount of
 * 0 or less is rejected so you can't push an empty line. Always lands as
 * "pending" — it is invisible to the client until the owner approves it.
 */
export function stageMonthlyCharge(
  workspaceId: string,
  input: { amountUsd: number; label?: string },
): { charge?: PortalCharge; error?: string; duplicate?: boolean } {
  const amount = round(Number(input.amountUsd) || 0);
  if (!workspaceId) return { error: "missing_workspace" };
  if (amount <= 0) return { error: "no_monthly_price" };
  const charge: PortalCharge = {
    id: rid("chg"),
    workspaceId,
    label: (input.label || "Monthly subscription").trim().slice(0, 80),
    amountUsd: amount,
    cadence: "monthly",
    source: "monthly_price",
    status: "pending",
    createdAt: nowIso(),
  };
  store.charges.push(charge);
  persist();
  return { charge };
}

/**
 * Push a single real usage row (from the owner console's Cost-by-category or
 * Recent-cost-events tables) to the account's Spending tab as a one-time line
 * item. The amount is the actual cost of that row, not a free-typed figure. A
 * label is required and the amount must be positive. Lands as "pending" — it is
 * invisible to the client until the owner approves it.
 */
export function stageUsageCharge(
  workspaceId: string,
  input: { label: string; amountUsd: number; receipt?: ChargeReceipt; cadence?: ChargeCadence },
): { charge?: PortalCharge; error?: string; duplicate?: boolean } {
  const amount = round(Number(input.amountUsd) || 0);
  const label = String(input.label || "").trim().slice(0, 80);
  if (!workspaceId) return { error: "missing_workspace" };
  if (!label) return { error: "missing_label" };
  if (amount <= 0) return { error: "no_amount" };
  // A pushed receipt bills as the owner marked it: "monthly" and "annual" land in
  // the recurring sections of the client statement (per month / per year),
  // "one_time" as a one-off. The amount is still the real receipt figure either
  // way; only the section it shows in differs.
  const cadence: ChargeCadence =
    input.cadence === "monthly" ? "monthly" : input.cadence === "annual" ? "annual" : "one_time";
  const receipt = sanitizeReceipt(input.receipt);

  /* ⚠️ THE SAME INVOICE MUST NEVER LAND ON A CLIENT'S STATEMENT TWICE.
     Nothing stopped it before: every push created a new charge, so re-sending a row after
     adding one receipt to it re-sent all the others with it, and an accountant reconciling
     against the vendor's own numbers would find the same invoice charged two or three
     times with no way to tell which was real.
     The vendor's INVOICE NUMBER is the right key, because it is the vendor's own identity
     for that charge and it survives everything on our side: a re-parse, a corrected
     amount, a relabelled row, even the receipt being deleted and re-harvested under a new
     id. Where a vendor issued no number the receipt id is the fallback, which still covers
     the ordinary case of pressing Send twice. */
  const existing = findSameCharge(workspaceId, receipt);
  if (existing) return { charge: existing, duplicate: true };

  const charge: PortalCharge = {
    id: rid("chg"),
    workspaceId,
    label,
    amountUsd: amount,
    cadence,
    source: "usage",
    status: "pending",
    receipt,
    createdAt: nowIso(),
  };
  store.charges.push(charge);
  persist();
  return { charge };
}

/**
 * The charge already on this account for the same invoice, if there is one.
 *
 * Matched on the vendor's invoice number first and the receipt id second. Deliberately
 * NOT on vendor + amount + date: a client can genuinely be charged the same figure twice
 * in one month by one vendor (two domains at $12.99, two identical top-ups), and refusing
 * the second would silently understate their bill. Only an identity the VENDOR issued is
 * safe to treat as "this is the same charge".
 *
 * A charge the owner has since removed does not block a re-send: it is gone from the
 * store, so this finds nothing and the push goes through.
 */
export function findSameCharge(workspaceId: string, receipt?: ChargeReceipt): PortalCharge | undefined {
  if (!receipt) return undefined;
  const num = (receipt.invoiceNumber || "").trim().toLowerCase();
  const rid_ = (receipt.receiptId || "").trim();
  return store.charges.find((c) => {
    if (c.workspaceId !== workspaceId || !c.receipt) return false;
    const cn = (c.receipt.invoiceNumber || "").trim().toLowerCase();
    if (num && cn) return cn === num;
    return !!rid_ && c.receipt.receiptId === rid_;
  });
}

/** Every receipt id this workspace already holds, so the console can show what is sent. */
export function sentReceiptIds(workspaceId: string): { receiptIds: string[]; invoiceNumbers: string[] } {
  const receiptIds: string[] = [];
  const invoiceNumbers: string[] = [];
  for (const c of store.charges) {
    if (c.workspaceId !== workspaceId || !c.receipt) continue;
    if (c.receipt.receiptId) receiptIds.push(c.receipt.receiptId);
    if (c.receipt.invoiceNumber) invoiceNumbers.push(c.receipt.invoiceNumber.trim().toLowerCase());
  }
  return { receiptIds, invoiceNumbers };
}

/** Keep only the receipt fields we store, and only when a real receipt id is
 *  present. A usage push with no receipt (a metered line) stays receipt-less. */
function sanitizeReceipt(r?: ChargeReceipt): ChargeReceipt | undefined {
  const id = String(r?.receiptId || "").trim();
  if (!id) return undefined;
  return {
    receiptId: id.slice(0, 120),
    vendor: r?.vendor ? String(r.vendor).slice(0, 80) : undefined,
    chargedAt: r?.chargedAt ? String(r.chargedAt).slice(0, 40) : undefined,
    invoiceNumber: r?.invoiceNumber ? String(r.invoiceNumber).slice(0, 80) : undefined,
    hasShot: !!r?.hasShot,
    hasFile: !!r?.hasFile,
  };
}

/**
 * The vault receipt id behind an APPROVED charge for this workspace — the only
 * gate the client portal's invoice-image endpoint trusts. Returns null unless
 * the charge exists, belongs to this workspace, is approved, and carries a
 * receipt, so a client can never pull an invoice that isn't on their own live
 * statement.
 */
export function approvedChargeReceiptId(workspaceId: string, chargeId: string): string | null {
  const c = store.charges.find((x) => x.id === chargeId && x.workspaceId === workspaceId);
  if (!c || c.status !== "approved" || !c.receipt) return null;
  return c.receipt.receiptId || null;
}

/**
 * The vault id AND the naming details for one approved charge's receipt, gated exactly like
 * approvedChargeReceiptId. Used to build a human filename ("vendor-2026-07-01.pdf") when the
 * client downloads the real invoice, so a saved receipt is recognisable on disk rather than
 * a bare charge id.
 */
export function approvedChargeReceiptMeta(
  workspaceId: string,
  chargeId: string,
): { receiptId: string; vendor?: string; chargedAt?: string; invoiceNumber?: string } | null {
  const c = store.charges.find((x) => x.id === chargeId && x.workspaceId === workspaceId);
  if (!c || c.status !== "approved" || !c.receipt || !c.receipt.receiptId) return null;
  return {
    receiptId: c.receipt.receiptId,
    vendor: c.receipt.vendor,
    chargedAt: c.receipt.chargedAt,
    invoiceNumber: c.receipt.invoiceNumber,
  };
}

/** Approve a pending charge -> it becomes visible on the client portal. */
export function approveCharge(workspaceId: string, id: string): PortalCharge | null {
  const c = store.charges.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!c) return null;
  c.status = "approved";
  c.approvedAt = nowIso();
  persist();
  return c;
}

/** Pull an approved charge back off the client portal (revert to pending). */
export function unapproveCharge(workspaceId: string, id: string): PortalCharge | null {
  const c = store.charges.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!c) return null;
  c.status = "pending";
  c.approvedAt = undefined;
  persist();
  return c;
}

/** Remove a charge entirely. Returns true if one was deleted. */
export function deleteCharge(workspaceId: string, id: string): boolean {
  const before = store.charges.length;
  store.charges = store.charges.filter((x) => !(x.id === id && x.workspaceId === workspaceId));
  const removed = store.charges.length < before;
  if (removed) persist();
  return removed;
}

/** Hard-reset hook: drop every charge for a workspace. Returns count removed. */
export function purgeWorkspaceCharges(workspaceId: string): number {
  const before = store.charges.length;
  store.charges = store.charges.filter((c) => c.workspaceId !== workspaceId);
  const removed = before - store.charges.length;
  if (removed) persist();
  return removed;
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * f) / f;
}
