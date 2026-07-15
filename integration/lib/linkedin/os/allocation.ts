/**
 * RecruitersOS · LinkedIn OS
 * Fair capacity allocation: when Recruiting and BD both want the same
 * account's headroom, split what is actually available across the competing
 * campaigns/workflows by priority + weight, clamp to min/max, and release
 * anything a consumer does not need back to the pool (never hold unused
 * allocation hostage).
 */

import { PRIORITY_RANK } from "./types";
import type { AllocationSlice, LiPriority } from "./types";

export interface AllocationInput {
  key: string;
  name: string;
  businessUnit: "recruiting" | "bd";
  priority: LiPriority;
  weight: number;          // relative weight, defaults handled by callers
  minAllocation?: number;  // absolute action floor (optional)
  maxAllocation?: number;  // absolute action cap (optional)
  demand: number;          // pending actions wanting capacity today
  usedToday: number;       // already consumed today (for reporting)
}

/**
 * Split `available` actions across consumers. Two passes:
 *  1. Priority tiers: critical consumers drink first, then high, normal, low.
 *  2. Inside a tier: weighted proportional shares, clamped to demand and
 *     min/max, with iterative redistribution of anything unused, so a Critical
 *     campaign that only needs 5 actions releases the rest immediately.
 */
export function allocate(available: number, inputs: AllocationInput[]): AllocationSlice[] {
  const out: AllocationSlice[] = inputs.map((i) => ({
    key: i.key, name: i.name, businessUnit: i.businessUnit, priority: i.priority,
    weight: i.weight, demand: i.demand, allocated: 0, usedToday: i.usedToday,
  }));
  if (available <= 0) return out;

  const byKey = new Map(out.map((o) => [o.key, o]));
  let pool = available;

  const tiers = new Map<number, AllocationInput[]>();
  for (const i of inputs) {
    const rank = PRIORITY_RANK[i.priority];
    if (!tiers.has(rank)) tiers.set(rank, []);
    (tiers.get(rank) as AllocationInput[]).push(i);
  }

  for (const rank of [...tiers.keys()].sort((a, b) => a - b)) {
    if (pool <= 0) break;
    const tier = (tiers.get(rank) as AllocationInput[])
      .map((i) => ({
        input: i,
        want: Math.min(
          Math.max(0, i.demand),
          i.maxAllocation !== undefined ? Math.max(0, i.maxAllocation) : Number.MAX_SAFE_INTEGER,
        ),
        got: 0,
      }))
      .filter((t) => t.want > 0);
    if (!tier.length) continue;

    // Floors first (min allocations), bounded by want and by the pool.
    for (const t of tier) {
      const floor = Math.min(t.want, Math.max(0, t.input.minAllocation ?? 0), pool);
      t.got += floor;
      pool -= floor;
    }

    // Weighted proportional rounds until the tier is satisfied or pool is dry.
    for (let round = 0; round < 20 && pool > 0; round++) {
      const open = tier.filter((t) => t.got < t.want);
      if (!open.length) break;
      const totalWeight = open.reduce((s, t) => s + Math.max(0.0001, t.input.weight), 0);
      let grantedThisRound = 0;
      for (const t of open) {
        if (pool <= 0) break;
        const share = Math.max(1, Math.floor(pool * Math.max(0.0001, t.input.weight) / totalWeight));
        const grant = Math.min(share, t.want - t.got, pool);
        t.got += grant;
        pool -= grant;
        grantedThisRound += grant;
      }
      if (grantedThisRound === 0) break;
    }

    for (const t of tier) {
      const slice = byKey.get(t.input.key);
      if (slice) slice.allocated = t.got;
    }
  }
  return out;
}
