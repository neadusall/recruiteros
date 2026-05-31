/**
 * RecruiterOS · Owner · Account metadata store (OWNER ONLY)
 *
 * Owner-private bookkeeping that doesn't belong on the customer-facing Workspace
 * object: the monthly price an account pays (so we can compute true margin), its
 * tier label, free-form notes, and the timestamp of the last hard reset. Kept in
 * its own snapshot so it never leaks into the normal auth payload.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface AccountMeta {
  workspaceId: string;
  /** What this account pays us per month (drives gross margin). */
  monthlyPriceUsd: number;
  /** Free-form tier label ("5k", "10k", "20k", "custom"). */
  tier?: string;
  notes?: string;
  lastResetAt?: string;
  updatedAt: string;
}

const store = { meta: new Map<string, AccountMeta>() };

const SNAP_KEY = "owner_account_meta";
function serialize() {
  return { meta: [...store.meta.entries()] };
}
function hydrate(s: any) {
  if (s?.meta) store.meta = new Map(s.meta);
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureOwnerMetaReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureOwnerMetaReady();

export function getAccountMeta(workspaceId: string): AccountMeta {
  return (
    store.meta.get(workspaceId) ?? {
      workspaceId,
      monthlyPriceUsd: 0,
      updatedAt: nowIso(),
    }
  );
}

export function setAccountMeta(
  workspaceId: string,
  patch: Partial<Pick<AccountMeta, "monthlyPriceUsd" | "tier" | "notes" | "lastResetAt">>,
): AccountMeta {
  const cur = getAccountMeta(workspaceId);
  const next: AccountMeta = { ...cur, ...patch, workspaceId, updatedAt: nowIso() };
  store.meta.set(workspaceId, next);
  persist();
  return next;
}

export function deleteAccountMeta(workspaceId: string): void {
  store.meta.delete(workspaceId);
  persist();
}

/** Sum of monthly price across all accounts = platform MRR. */
export function totalMrr(): number {
  let mrr = 0;
  for (const m of store.meta.values()) mrr += m.monthlyPriceUsd || 0;
  return Math.round(mrr * 100) / 100;
}
