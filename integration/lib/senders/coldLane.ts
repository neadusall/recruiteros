/**
 * RecruitersOS · Senders · Cold-lane capacity (the ONE number for "what can we send today")
 *
 * WHY THIS EXISTS. Capacity had four answers on 2026-08-20, all rendered in the portal at
 * the same time:
 *
 *   Senders tab / Send Queue   1,422/day, 0 sent   sendCapacity() summed the senders store by
 *                                                  raw `provider`, ran 54 Zapmail boxes labelled
 *                                                  "other" up the generic 15/day warm-up ramp,
 *                                                  and counted 60 internal boxes whose cold lane
 *                                                  is parked. `sentToday` never moved because the
 *                                                  MPC sender is a host tool that never calls
 *                                                  recordSend().
 *   Fleet monitor              1,200/day           fleets.ts mirrored a week-1 Google step for
 *                                                  all 100 Google boxes, warming ones included.
 *   Story card                 540/day, 505 left   the reputation ramp, which the inflated fleet
 *                                                  ceiling never clamped.
 *   The actual sender            832/day, 62 sent  batch.mjs, the only one that transmits.
 *
 * The sender is the only surface that can be right, because it is the one applying the caps.
 * So it now publishes what it enforces (`batch.mjs --capacity` -> snap_mpc_cold_capacity_v1)
 * and every read-only surface reports THAT. Per CLAUDE.md rules 6-8 nothing here recomputes a
 * capacity number; this module only reads, types and ages the ledger.
 */

import { loadSnapshot } from "../db";

export interface ColdLane {
  lane: string;                 // sendingac | google | internal | other
  boxes: number;
  usableBoxes: number;
  benchedBoxes: number;
  ceiling: number;              // cold sends/day this lane carries today
  benchedCeiling: number;
  sentToday: number;
  boxesWithHeadroom: number;
}

/** The reputation ramp: how much volume our sending reputation currently ALLOWS,
 *  independent of how many mailboxes exist. Grows 20%/week only while the Gmail seed
 *  test keeps passing. */
export interface RampCap {
  cap: number;
  base: number;
  ceiling: number;
  growthUnlocked: boolean;
}

export interface ColdCapacity {
  at: string;
  workspaceId: string;
  perBox: number;
  googleRamp: number[];
  googleDomainCap: number;
  lanesParked: string[];        // lanes contributing 0 today (MPC_SMTP_LANE / MPC_GOOGLE_LANE)
  boxes: number;
  usableBoxes: number;
  benchedBoxes: number;
  boxesWithHeadroom: number;
  restingDomains: string[];
  ceiling: number;              // THE number: cold sends/day the fleet can carry today
  sentToday: number;
  remaining: number;
  benchedCeiling: number;       // held by resting domains, never blended into `ceiling`
  lanes: ColdLane[];
  /** Minutes since the sender last published. The monitor refreshes every 20 min, so
   *  anything past an hour means the send loop is not running and the number is history. */
  ageMinutes: number;
  stale: boolean;
  /** TWO ceilings bind, and both belong in the same object so no surface can show one
   *  without the other: `ceiling` is what the mailboxes can physically carry, `ramp` is
   *  what reputation allows. `capToday` is the lower one, and it is the only number that
   *  answers "what can we send today". Keeping the ramp in the story card alone is how the
   *  Senders tab and the story card ended up quoting 832 and 540 for the same afternoon. */
  ramp: RampCap;
  capToday: number;
  remainingToday: number;
  /** Which ceiling is binding right now, for a surface that wants to say why. */
  boundBy: "fleet" | "reputation" | "both";
}

interface PlacementSnap { checkedAt?: string; gmail?: { inbox?: number; spam?: number } }

const DAY = 86_400_000;

/**
 * The reputation ramp. Base volume grows 20% a week from MPC_RAMP_START, but ONLY while a
 * Gmail seed test inside the last 7 days shows <=30% spam placement; a failing or stale test
 * freezes it at base. Lives here rather than in the story route so every surface reads one
 * implementation.
 */
export function rampCap(placement: PlacementSnap | null): RampCap {
  const base = Number(process.env.MPC_RAMP_BASE ?? 450);
  const start = Date.parse(process.env.MPC_RAMP_START || "2026-08-13");
  const envCap = Number(process.env.MPC_DAILY_CAP || 1800);
  const ceiling = Math.min(1500, envCap);
  let passes = false;
  if (placement?.checkedAt && Date.now() - Date.parse(placement.checkedAt) <= 7 * DAY) {
    const g = placement.gmail || {};
    const total = (g.inbox || 0) + (g.spam || 0);
    if (total > 0) passes = (g.spam || 0) / total <= 0.3;
  }
  if (!(base > 0) || !Number.isFinite(start)) return { cap: envCap, base, ceiling, growthUnlocked: passes };
  const weeks = Math.max(0, (Date.now() - start) / (7 * DAY));
  const cap = Math.min(ceiling, Math.round(base * (passes ? Math.pow(1.2, weeks) : 1)));
  return { cap: Math.min(envCap, cap), base, ceiling, growthUnlocked: passes };
}

/** How old the ledger may be before a surface must say so rather than show it as current. */
const STALE_MINUTES = 60;

/**
 * The published cold-lane ledger, or null when the sender has never run. A caller that
 * gets null must say "not published yet" — it must NOT fall back to a hand-rolled sum,
 * which is the exact failure this module exists to end.
 */
export async function coldCapacity(workspaceId: string): Promise<ColdCapacity | null> {
  const [snap, placement] = await Promise.all([
    loadSnapshot<Partial<ColdCapacity>>("mpc_cold_capacity_v1"),
    loadSnapshot<PlacementSnap>("mpc_placement_v1"),
  ]);
  if (!snap || typeof snap.ceiling !== "number" || !snap.at) return null;
  // The sender publishes for the Lume workspace only; another tenant must never be shown
  // Lume's fleet numbers.
  if (snap.workspaceId && workspaceId && snap.workspaceId !== workspaceId) return null;
  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(snap.at)) / 60_000));
  const ramp = rampCap(placement);
  const sentToday = snap.sentToday ?? 0;
  // Whichever ceiling is lower is the real one: mailboxes we cannot use and reputation we
  // have not earned are both hard stops, and quoting either alone overstates.
  const capToday = Math.min(ramp.cap, snap.ceiling);
  return {
    at: snap.at,
    workspaceId: snap.workspaceId || workspaceId,
    perBox: snap.perBox ?? 2,
    googleRamp: snap.googleRamp ?? [],
    googleDomainCap: snap.googleDomainCap ?? 0,
    lanesParked: snap.lanesParked ?? [],
    boxes: snap.boxes ?? 0,
    usableBoxes: snap.usableBoxes ?? 0,
    benchedBoxes: snap.benchedBoxes ?? 0,
    boxesWithHeadroom: snap.boxesWithHeadroom ?? 0,
    restingDomains: snap.restingDomains ?? [],
    ceiling: snap.ceiling,
    sentToday: snap.sentToday ?? 0,
    remaining: snap.remaining ?? Math.max(0, snap.ceiling - (snap.sentToday ?? 0)),
    benchedCeiling: snap.benchedCeiling ?? 0,
    lanes: snap.lanes ?? [],
    ageMinutes,
    stale: ageMinutes > STALE_MINUTES,
    ramp,
    capToday,
    remainingToday: Math.max(0, capToday - sentToday),
    boundBy: ramp.cap === snap.ceiling ? "both" : ramp.cap < snap.ceiling ? "reputation" : "fleet",
  };
}

/** Human label for a lane key, matching the fleet cards. */
export const COLD_LANE_NAMES: Record<string, string> = {
  sendingac: "Sending.ac",
  google: "Google (Zapmail)",
  internal: "Internal server (mail.lumesp.com)",
  other: "Other",
};
