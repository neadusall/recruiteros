/**
 * RecruiterOS · BD · Outreach A/B experiment
 *
 * Two outreach models run head to head on a deterministic 50/50 split:
 *   - "mpc"          Most Placeable Candidate: forward, leads with a specific
 *                    high-caliber candidate we represent who fits their open role.
 *   - "consultative" advisory: earns attention with role/industry insight, asks
 *                    to understand their needs.
 *
 * A prospect's variant is a stable hash of their id, so every touch they ever get
 * (opener, nurture, the earned ask) stays in the SAME model — no mixing mid-funnel.
 * We log enrolled -> engaged -> booked per variant so book-rate decides the winner.
 *
 * Durable like the other stores (SNAP_KEY "bd_experiment").
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export type Variant = "mpc" | "consultative";
export type Outcome = "enrolled" | "engaged" | "booked";

/** Deterministic 50/50 by prospect id (FNV-1a). Env can force a variant for testing. */
export function variantFor(prospectId: string): Variant {
  const forced = (process.env.RECRUITEROS_BD_FORCE_VARIANT || "").toLowerCase();
  if (forced === "mpc" || forced === "consultative") return forced as Variant;
  let h = 2166136261;
  for (let i = 0; i < prospectId.length; i++) {
    h ^= prospectId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0 ? "mpc" : "consultative";
}

const store = {
  assigned: {} as Record<string, Variant>,
  events: {} as Record<string, Partial<Record<Outcome, string>>>,
};
const SNAP_KEY = "bd_experiment";
function hydrate(s: any) {
  if (!s) return;
  store.assigned = s.assigned ?? {};
  store.events = s.events ?? {};
}
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureExperimentReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureExperimentReady();

/** Assign (and remember) the variant for a prospect at enrollment time. */
export function assignVariant(prospectId: string): Variant {
  const v = store.assigned[prospectId] ?? variantFor(prospectId);
  if (store.assigned[prospectId] !== v) {
    store.assigned[prospectId] = v;
    persist();
  }
  return v;
}

/** The variant a prospect is in (stable even if never explicitly assigned). */
export function variantOf(prospectId: string): Variant {
  return store.assigned[prospectId] ?? variantFor(prospectId);
}

/** Record a funnel outcome once per prospect+outcome (idempotent). */
export function recordOutcome(prospectId: string, outcome: Outcome): void {
  if (!store.assigned[prospectId]) store.assigned[prospectId] = variantFor(prospectId);
  const ev = (store.events[prospectId] ??= {});
  if (!ev[outcome]) {
    ev[outcome] = nowIso();
    persist();
  }
}

export interface VariantReport {
  enrolled: number;
  engaged: number;
  booked: number;
  engageRatePct: number;
  bookRatePct: number;
}

/** Per-variant funnel + book-rate — the metric that picks the winner. */
export function report(): { variants: Record<Variant, VariantReport>; winner: Variant | "tie" | "insufficient_data" } {
  const base: Record<Variant, { enrolled: number; engaged: number; booked: number }> = {
    mpc: { enrolled: 0, engaged: 0, booked: 0 },
    consultative: { enrolled: 0, engaged: 0, booked: 0 },
  };
  for (const [pid, ev] of Object.entries(store.events)) {
    const v = store.assigned[pid] ?? variantFor(pid);
    if (ev.enrolled) base[v].enrolled++;
    if (ev.engaged) base[v].engaged++;
    if (ev.booked) base[v].booked++;
  }
  const pct = (n: number, d: number) => (d ? Number(((n / d) * 100).toFixed(1)) : 0);
  const variants: Record<Variant, VariantReport> = {
    mpc: { ...base.mpc, engageRatePct: pct(base.mpc.engaged, base.mpc.enrolled), bookRatePct: pct(base.mpc.booked, base.mpc.enrolled) },
    consultative: { ...base.consultative, engageRatePct: pct(base.consultative.engaged, base.consultative.enrolled), bookRatePct: pct(base.consultative.booked, base.consultative.enrolled) },
  };
  const enough = base.mpc.enrolled >= 30 && base.consultative.enrolled >= 30;
  let winner: Variant | "tie" | "insufficient_data" = "insufficient_data";
  if (enough) {
    if (variants.mpc.bookRatePct > variants.consultative.bookRatePct) winner = "mpc";
    else if (variants.consultative.bookRatePct > variants.mpc.bookRatePct) winner = "consultative";
    else winner = "tie";
  }
  return { variants, winner };
}
