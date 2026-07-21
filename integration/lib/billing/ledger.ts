/**
 * RecruitersOS · Billing · Usage ledger (OWNER ONLY)
 *
 * An append-only record of every cost we incur, per workspace, per motion. This
 * is the "track everything from a cost standpoint" spine: each enrichment call,
 * each batch of sends, each AI personalization, each SMS/voice minute, each
 * external provider invoice lands here as one immutable event with its real
 * USD cost. Rollups slice it by category, provider, motion, and workspace, and
 * (joined with the price an account pays) yield true gross margin.
 *
 * In-memory reference store + debounced Postgres snapshot, exactly like the
 * auth module, so it survives restarts when DATABASE_URL is set and runs purely
 * in-memory otherwise.
 */

import { rid, nowIso } from "../core/ids";
import type { Motion } from "../core/types";
import type { RateCategory } from "./rates";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface UsageEvent {
  id: string;
  workspaceId: string;
  motion: Motion;
  category: RateCategory | "other";
  /** Rate id (email_find, sms_segment, ...) or a free-form external type. */
  type: string;
  /** Provider / source that incurred the cost (rapidapi, telnyx, claude, ...). */
  source?: string;
  quantity: number;
  unitCostUsd: number;
  /** quantity * unitCostUsd unless explicitly overridden (e.g. an invoice). */
  costUsd: number;
  /** Free-form context (campaignId, batchId, invoice ref). */
  meta?: Record<string, unknown>;
  at: string;
}

const store = {
  events: [] as UsageEvent[],
};

/* ---------------- durability ---------------- */
const SNAP_KEY = "billing_ledger";
function serialize() {
  return { events: store.events };
}
function hydrate(s: any) {
  if (s?.events) store.events = s.events;
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureLedgerReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureLedgerReady();

/* ---------------- write ---------------- */

export interface RecordUsageInput {
  workspaceId: string;
  motion: Motion;
  category: UsageEvent["category"];
  type: string;
  source?: string;
  quantity: number;
  unitCostUsd: number;
  /** Override the computed cost (for flat invoices / external spend). */
  costUsd?: number;
  meta?: Record<string, unknown>;
}

/** Append one cost event. Returns the stored event. */
export function recordUsage(input: RecordUsageInput): UsageEvent {
  const cost = input.costUsd ?? round(input.quantity * input.unitCostUsd);
  const ev: UsageEvent = {
    id: rid("use"),
    workspaceId: input.workspaceId,
    motion: input.motion,
    category: input.category,
    type: input.type,
    source: input.source,
    quantity: input.quantity,
    unitCostUsd: input.unitCostUsd,
    costUsd: cost,
    meta: input.meta,
    at: nowIso(),
  };
  store.events.push(ev);
  persist();
  return ev;
}

/** Record an external provider invoice / lump spend (no per-unit math). */
export function recordExternalSpend(input: {
  workspaceId: string;
  motion?: Motion;
  source: string;
  costUsd: number;
  type?: string;
  meta?: Record<string, unknown>;
}): UsageEvent {
  return recordUsage({
    workspaceId: input.workspaceId,
    motion: input.motion ?? "recruiting",
    category: "other",
    type: input.type ?? "external_spend",
    source: input.source,
    quantity: 1,
    unitCostUsd: input.costUsd,
    costUsd: input.costUsd,
    meta: input.meta,
  });
}

/** Hard-reset hook: drop all cost history for a workspace. Returns count removed. */
export function purgeWorkspaceUsage(workspaceId: string): number {
  const before = store.events.length;
  store.events = store.events.filter((e) => e.workspaceId !== workspaceId);
  persist();
  return before - store.events.length;
}

/* ---------------- read / rollup ---------------- */

export type SpendWindow = "today" | "7d" | "30d" | "all";

function windowStart(window: SpendWindow): number {
  if (window === "all") return 0;
  const now = Date.now();
  if (window === "today") return now - 24 * 3600 * 1000;
  if (window === "7d") return now - 7 * 24 * 3600 * 1000;
  return now - 30 * 24 * 3600 * 1000;
}

export interface SpendRollup {
  window: SpendWindow;
  totalCostUsd: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  byMotion: Record<string, number>;
  byWorkspace: Array<{ workspaceId: string; costUsd: number; events: number }>;
  events: number;
}

/** Roll the ledger up for a window, sliced every way the console needs. */
export function spendRollup(window: SpendWindow = "30d"): SpendRollup {
  const since = windowStart(window);
  const rows = store.events.filter((e) => Date.parse(e.at) >= since);
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byMotion: Record<string, number> = {};
  const byWs = new Map<string, { costUsd: number; events: number }>();
  let total = 0;
  for (const e of rows) {
    total += e.costUsd;
    byCategory[e.category] = round((byCategory[e.category] ?? 0) + e.costUsd);
    if (e.source) bySource[e.source] = round((bySource[e.source] ?? 0) + e.costUsd);
    byMotion[e.motion] = round((byMotion[e.motion] ?? 0) + e.costUsd);
    const w = byWs.get(e.workspaceId) ?? { costUsd: 0, events: 0 };
    w.costUsd = round(w.costUsd + e.costUsd);
    w.events += 1;
    byWs.set(e.workspaceId, w);
  }
  return {
    window,
    totalCostUsd: round(total),
    byCategory,
    bySource,
    byMotion,
    byWorkspace: [...byWs.entries()]
      .map(([workspaceId, v]) => ({ workspaceId, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    events: rows.length,
  };
}

/** Cost incurred by one workspace within a window. */
export function workspaceCost(workspaceId: string, window: SpendWindow = "30d"): number {
  const since = windowStart(window);
  return round(
    store.events
      .filter((e) => e.workspaceId === workspaceId && Date.parse(e.at) >= since)
      .reduce((s, e) => s + e.costUsd, 0),
  );
}

/** Recent raw events for a workspace (account detail drill-down). */
export function workspaceEvents(workspaceId: string, limit = 100): UsageEvent[] {
  return store.events
    .filter((e) => e.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

/** Per-category cost for one workspace within a window (detail panel). */
export function workspaceCostByCategory(workspaceId: string, window: SpendWindow = "30d"): Record<string, number> {
  const since = windowStart(window);
  const out: Record<string, number> = {};
  for (const e of store.events) {
    if (e.workspaceId !== workspaceId || Date.parse(e.at) < since) continue;
    out[e.category] = round((out[e.category] ?? 0) + e.costUsd);
  }
  return out;
}

/* ---------------- per-recruiter attribution ---------------- */

export interface UserSpendRow {
  /** Recruiter identity as stamped on the event meta ("" = unattributed). */
  userEmail: string;
  userId?: string;
  costUsd: number;
  events: number;
  /** Billable lookups across the events. */
  quantity: number;
  /** Results delivered (meta.found), where the event type reports one. */
  found: number;
}

/**
 * Spend grouped by the recruiter who triggered it (events carrying meta.userEmail /
 * meta.userId), optionally filtered to one event type. Powers the "who is spending
 * what on paid enrichment" analytics for admins and the self view for recruiters.
 */
export function userSpendRollup(
  workspaceId: string,
  window: SpendWindow = "30d",
  type?: string,
): { rows: UserSpendRow[]; totalUsd: number; window: SpendWindow } {
  const since = windowStart(window);
  const byUser = new Map<string, UserSpendRow>();
  let total = 0;
  for (const e of store.events) {
    if (e.workspaceId !== workspaceId || Date.parse(e.at) < since) continue;
    if (type && e.type !== type) continue;
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    const email = String(meta.userEmail ?? "").toLowerCase();
    const row = byUser.get(email) ?? {
      userEmail: email, userId: typeof meta.userId === "string" ? meta.userId : undefined,
      costUsd: 0, events: 0, quantity: 0, found: 0,
    };
    row.costUsd = round(row.costUsd + e.costUsd);
    row.events += 1;
    row.quantity += e.quantity;
    row.found += Number(meta.found) || 0;
    if (!row.userId && typeof meta.userId === "string") row.userId = meta.userId;
    byUser.set(email, row);
    total = round(total + e.costUsd);
  }
  return {
    rows: [...byUser.values()].sort((a, b) => b.costUsd - a.costUsd),
    totalUsd: total,
    window,
  };
}

/**
 * One recruiter's spend on one event type since the start of the current calendar
 * month (UTC). This is the number the per-recruiter monthly budget caps check
 * against: unlike the rolling windows above, it resets on the 1st, matching how
 * the budget is granted. Events with no matching meta.userEmail never count, so
 * unattributed legacy spend cannot eat anyone's budget.
 */
export function userMonthSpend(workspaceId: string, userEmail: string, type: string): number {
  const email = userEmail.trim().toLowerCase();
  if (!email) return 0;
  const now = new Date();
  const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const e of store.events) {
    if (e.workspaceId !== workspaceId || e.type !== type || Date.parse(e.at) < since) continue;
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    if (String(meta.userEmail ?? "").trim().toLowerCase() !== email) continue;
    total += e.costUsd;
  }
  return round(total);
}

/** The whole workspace's spend on one event type this calendar month (UTC):
 *  feeds plan-allowance readouts ("used X of the plan's Y requests"), so it
 *  counts every recruiter, attributed or not. 4-decimal precision because
 *  plan-priced events cost fractions of a cent each. */
export function workspaceMonthSpend(workspaceId: string, type: string): number {
  const now = new Date();
  const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const e of store.events) {
    if (e.workspaceId !== workspaceId || e.type !== type || Date.parse(e.at) < since) continue;
    total += e.costUsd;
  }
  return round(total, 4);
}

/** One recruiter's own slice of the rollup (self-scoped analytics). */
export function userSpend(
  workspaceId: string,
  userEmail: string,
  window: SpendWindow = "30d",
  type?: string,
): UserSpendRow {
  const email = userEmail.toLowerCase();
  const hit = userSpendRollup(workspaceId, window, type).rows.find((r) => r.userEmail === email);
  return hit ?? { userEmail: email, costUsd: 0, events: 0, quantity: 0, found: 0 };
}

/** Dev/tests only. */
export function devLedger() {
  return store;
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
