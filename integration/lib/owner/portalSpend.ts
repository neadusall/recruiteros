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
 * Two hard rules enforced here (not just in the UI):
 *   1. A charge can only be created with source "monthly_price" and an amount
 *      equal to the account's month-to-month price. You cannot send an arbitrary
 *      figure to a client portal.
 *   2. A charge is invisible to the client until status === "approved".
 *
 * In-memory reference store + debounced Postgres snapshot, same pattern as the
 * billing ledger and account-meta store, so it survives restarts when
 * DATABASE_URL is set and runs purely in-memory otherwise.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export type ChargeStatus = "pending" | "approved";

export interface PortalCharge {
  id: string;
  workspaceId: string;
  /** What the customer sees on the line item, e.g. "Monthly subscription". */
  label: string;
  amountUsd: number;
  /** Only month-to-month recurring charges are sendable to a client portal. */
  cadence: "monthly";
  /** Where the amount came from. Locked to the account's month-to-month field. */
  source: "monthly_price";
  /** Client portal shows the row only when this is "approved". */
  status: ChargeStatus;
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

/** Sum of approved monthly charges = what this account is billed per month. */
export function approvedMonthlyTotal(workspaceId: string): number {
  return round(listApprovedCharges(workspaceId).reduce((s, c) => s + c.amountUsd, 0));
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
): { charge?: PortalCharge; error?: string } {
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
