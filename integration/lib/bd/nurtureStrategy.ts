/**
 * RecruitersOS · BD · Nurture STRATEGY A/B (orthogonal to the mpc/consultative axis)
 *
 * Two structurally different 24-month nurture strategies run head to head on a
 * deterministic 50/50 split, stratified only by the stable hash of the prospect id:
 *   - "authority"     The Authority Engine: a regular ~2x/month value cadence
 *                     (content-led, segment-level). Wins through top-of-mind volume
 *                     of genuinely useful intelligence.
 *   - "inner_circle"  The Inner Circle: mostly trigger-only (job change, company
 *                     news, a post they wrote) plus a light quarterly floor. Wins
 *                     through precision and intimacy on higher-value contacts.
 *
 * This is a SEPARATE axis from lib/bd/experiment.ts (mpc vs consultative, which is
 * the MESSAGE FRAMING). A prospect therefore sits in a 2x2 cell: {strategy} x
 * {variant}. We keep this as its own module + store so neither axis perturbs the
 * other, and so book-rate can pick a winning STRATEGY independent of framing.
 *
 * Durable like the other stores (SNAP_KEY "bd_nurture_strategy").
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export type Strategy = "authority" | "inner_circle";
export type StrategyOutcome = "enrolled" | "engaged" | "booked";

/** Deterministic 50/50 by prospect id (FNV-1a). Env can force a strategy for testing. */
export function strategyFor(prospectId: string): Strategy {
  const forced = (process.env.RECRUITEROS_NURTURE_FORCE_STRATEGY || "").toLowerCase();
  if (forced === "authority" || forced === "inner_circle") return forced as Strategy;
  let h = 2166136261;
  for (let i = 0; i < prospectId.length; i++) {
    h ^= prospectId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0 ? "authority" : "inner_circle";
}

const store = {
  assigned: {} as Record<string, Strategy>,
  events: {} as Record<string, Partial<Record<StrategyOutcome, string>>>,
};
const SNAP_KEY = "bd_nurture_strategy";
function hydrate(s: any) {
  if (!s) return;
  store.assigned = s.assigned ?? {};
  store.events = s.events ?? {};
}
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureStrategyReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureStrategyReady();

/** Assign (and remember) the strategy for a prospect at enrollment time. */
export function assignStrategy(prospectId: string): Strategy {
  const s = store.assigned[prospectId] ?? strategyFor(prospectId);
  if (store.assigned[prospectId] !== s) {
    store.assigned[prospectId] = s;
    persist();
  }
  return s;
}

/** The strategy a prospect is in (stable even if never explicitly assigned). */
export function strategyOf(prospectId: string): Strategy {
  return store.assigned[prospectId] ?? strategyFor(prospectId);
}

/** Record a funnel outcome once per prospect+outcome (idempotent). */
export function recordStrategyOutcome(prospectId: string, outcome: StrategyOutcome): void {
  if (!store.assigned[prospectId]) store.assigned[prospectId] = strategyFor(prospectId);
  const ev = (store.events[prospectId] ??= {});
  if (!ev[outcome]) {
    ev[outcome] = nowIso();
    persist();
  }
}

export interface StrategyReport {
  enrolled: number;
  engaged: number;
  booked: number;
  engageRatePct: number;
  bookRatePct: number;
}

/** Per-strategy funnel + book-rate — the metric that picks the winning strategy. */
export function report(): { strategies: Record<Strategy, StrategyReport>; winner: Strategy | "tie" | "insufficient_data" } {
  const base: Record<Strategy, { enrolled: number; engaged: number; booked: number }> = {
    authority: { enrolled: 0, engaged: 0, booked: 0 },
    inner_circle: { enrolled: 0, engaged: 0, booked: 0 },
  };
  for (const [pid, ev] of Object.entries(store.events)) {
    const s = store.assigned[pid] ?? strategyFor(pid);
    if (ev.enrolled) base[s].enrolled++;
    if (ev.engaged) base[s].engaged++;
    if (ev.booked) base[s].booked++;
  }
  const pct = (n: number, d: number) => (d ? Number(((n / d) * 100).toFixed(1)) : 0);
  const strategies: Record<Strategy, StrategyReport> = {
    authority: { ...base.authority, engageRatePct: pct(base.authority.engaged, base.authority.enrolled), bookRatePct: pct(base.authority.booked, base.authority.enrolled) },
    inner_circle: { ...base.inner_circle, engageRatePct: pct(base.inner_circle.engaged, base.inner_circle.enrolled), bookRatePct: pct(base.inner_circle.booked, base.inner_circle.enrolled) },
  };
  const enough = base.authority.enrolled >= 30 && base.inner_circle.enrolled >= 30;
  let winner: Strategy | "tie" | "insufficient_data" = "insufficient_data";
  if (enough) {
    if (strategies.authority.bookRatePct > strategies.inner_circle.bookRatePct) winner = "authority";
    else if (strategies.inner_circle.bookRatePct > strategies.authority.bookRatePct) winner = "inner_circle";
    else winner = "tie";
  }
  return { strategies, winner };
}
