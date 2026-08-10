/**
 * RecruitersOS · JD Sourcing · STANDING SWEEPS: discovery that runs itself.
 *
 * WHY THIS EXISTS. Sourcing produces roughly 1,800 contactable people a day while the
 * sending side is being built toward 5,000. Every search today is hand-started, so the
 * supply is capped by how often somebody remembers to press a button, and the standing
 * book drains faster than it refills. The fix is not a bigger button: it is a set of
 * profiles the desk always recruits for, swept on a rota, unattended.
 *
 * A standing profile is deliberately the SAME shape as a hand-run search (a brief plus
 * a location plus the usual dials), because anything else would drift away from what the
 * interactive path does and rot. Seeding just puts an ordinary item on the overnight
 * queue, which already knows how to search, enrich, and deliver to Candidates and OS Text
 * without a browser tab. This module only decides WHICH profile runs and WHEN.
 *
 * Three properties make it safe to leave running:
 *
 *  1. FRESH-ONLY. A repeat sweep of the same profile excludes everyone earlier runs
 *     already surfaced, so the second pass returns job-changers and new profiles rather
 *     than re-buying the same people. Without this a rota would spend real money to
 *     rediscover its own back catalogue.
 *  2. A DAILY CEILING. Sweeps are paced against a per-workspace budget, so a long rota
 *     cannot dump a month of searching into one night. There is no point discovering
 *     more people per day than the sending side can mail.
 *  3. LEAST-RECENTLY-SWEPT FIRST. The rota is a queue, not a schedule: whatever has gone
 *     longest without attention runs next. A profile added later never starves, and a
 *     profile whose pool has dried up simply returns little and cycles on.
 *
 * Snapshot `sourcing_standing_profiles_v1`. Tested by scripts/test-sourcing-standing.mts.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso, rid } from "../core/ids";
import { addNightItem, listNightItems } from "./nightQueue";
import type { SearchBreadth } from "./types";

const KEY = "sourcing_standing_profiles_v1";

/** A role the desk recruits for continuously. */
export interface StandingProfile {
  id: string;
  workspaceId: string;
  /** What the recruiter calls it, and the stem of each swept list's name. */
  name: string;
  /** The brief, exactly as an interactive search would take it. */
  jd: string;
  /** "City, ST" (radius suffixes allowed, same as the typed box). */
  location?: string;
  breadth?: SearchBreadth;
  /** Rows per sweep. Kept modest by default: a rota's value is frequency, not one
   *  enormous pull that exhausts the pool and the budget in a single night. */
  cap?: number;
  radiusMi?: number;
  /** How often this profile should come round, in days. */
  cadenceDays: number;
  /** Off means it stays in the list but never seeds: the honest way to pause a desk
   *  that has gone quiet without losing its configuration. */
  active: boolean;
  /** Set when a sweep is seeded, which is what the rota orders by. */
  lastSweptAt?: string;
  /** Sweeps seeded so far, for the "is this thing working" readout. */
  sweeps?: number;
  /** Who to credit the resulting campaign to (the queue stamps it on the saved run). */
  createdBy?: { userId: string; name: string; email: string };
  createdAt: string;
  updatedAt: string;
}

interface Blob {
  profiles: StandingProfile[];
  /** `${workspaceId}:${YYYY-MM-DD}` -> sweeps seeded that day, for the daily ceiling. */
  seededPerDay?: Record<string, number>;
}

let store: Blob = { profiles: [], seededPerDay: {} };
let hydrated = false;
const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  const snap = await loadSnapshot<Blob>(KEY);
  if (snap && typeof snap === "object") {
    store = { profiles: Array.isArray(snap.profiles) ? snap.profiles : [], seededPerDay: snap.seededPerDay || {} };
  }
  hydrated = true;
}

/** Default sweeps per workspace per day. Overridable per call by the tick. */
export const DEFAULT_DAILY_SWEEPS = 6;

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listStandingProfiles(workspaceId: string): Promise<StandingProfile[]> {
  await hydrate();
  return store.profiles.filter((p) => p.workspaceId === workspaceId);
}

export interface StandingInput {
  name: string;
  jd: string;
  location?: string;
  breadth?: SearchBreadth;
  cap?: number;
  radiusMi?: number;
  cadenceDays?: number;
  active?: boolean;
  createdBy?: { userId: string; name: string; email: string };
}

export async function addStandingProfile(workspaceId: string, input: StandingInput): Promise<StandingProfile> {
  await hydrate();
  const p: StandingProfile = {
    id: rid("sp"),
    workspaceId,
    name: (input.name || "Standing search").slice(0, 120),
    jd: input.jd || "",
    location: input.location,
    breadth: input.breadth ?? "balanced",
    // 500 is the interactive default and a sane night's work for one profile.
    cap: Math.max(50, Math.min(input.cap ?? 500, 3000)),
    radiusMi: input.radiusMi,
    // Weekly by default: long enough that a pool refills with real movement, short
    // enough that a live desk is never more than a few days from fresh names.
    cadenceDays: Math.max(1, Math.min(input.cadenceDays ?? 7, 90)),
    active: input.active !== false,
    sweeps: 0,
    createdBy: input.createdBy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.profiles.push(p);
  save();
  return p;
}

export async function updateStandingProfile(
  workspaceId: string,
  id: string,
  patch: Partial<StandingInput>,
): Promise<StandingProfile | null> {
  await hydrate();
  const p = store.profiles.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!p) return null;
  if (patch.name !== undefined) p.name = patch.name.slice(0, 120);
  if (patch.jd !== undefined) p.jd = patch.jd;
  if (patch.location !== undefined) p.location = patch.location;
  if (patch.breadth !== undefined) p.breadth = patch.breadth;
  if (patch.cap !== undefined) p.cap = Math.max(50, Math.min(patch.cap, 3000));
  if (patch.radiusMi !== undefined) p.radiusMi = patch.radiusMi;
  if (patch.cadenceDays !== undefined) p.cadenceDays = Math.max(1, Math.min(patch.cadenceDays, 90));
  if (patch.active !== undefined) p.active = patch.active;
  p.updatedAt = nowIso();
  save();
  return p;
}

export async function removeStandingProfile(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = store.profiles.findIndex((x) => x.id === id && x.workspaceId === workspaceId);
  if (i < 0) return false;
  store.profiles.splice(i, 1);
  save();
  return true;
}

/* ------------------------------------------------------------------ */
/* The rota                                                            */
/* ------------------------------------------------------------------ */

/** UTC day key. Sweeps are paced per calendar day, and the box runs on UTC. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Is this profile due, and how overdue?
 *
 * A never-swept profile is maximally overdue, so a freshly added desk starts producing
 * on the next tick rather than waiting out a full cadence.
 */
export function overdueBy(p: StandingProfile, now: Date): number {
  if (!p.active) return -1;
  if (!p.lastSweptAt) return Number.MAX_SAFE_INTEGER;
  const last = new Date(p.lastSweptAt).getTime();
  if (!Number.isFinite(last)) return Number.MAX_SAFE_INTEGER;
  const dueAt = last + p.cadenceDays * 86_400_000;
  return now.getTime() - dueAt;
}

/**
 * Choose what to sweep now. Pure, so the suite can pin the rota without a store.
 *
 * `slots` is what remains of today's ceiling; `inFlight` is how many sweeps this
 * workspace already has moving through the overnight queue. The second guard is the
 * one that matters in practice: a profile whose sweep is still enriching must not be
 * seeded again on the next tick, or a slow night compounds into a pile-up.
 */
export function pickDueProfiles(
  profiles: StandingProfile[],
  now: Date,
  slots: number,
  inFlightNames: Set<string> = new Set(),
): StandingProfile[] {
  if (slots <= 0) return [];
  return profiles
    .map((p) => ({ p, over: overdueBy(p, now) }))
    .filter((x) => x.over >= 0)
    .filter((x) => !inFlightNames.has(x.p.name))
    // Most overdue first: the rota self-levels without anyone maintaining a calendar.
    .sort((a, b) => b.over - a.over)
    .slice(0, slots)
    .map((x) => x.p);
}

/** The name a swept list gets. Dated so a rota's lists are self-describing in the UI
 *  and never collide with each other or with a hand-run search of the same desk. */
export function sweepName(p: StandingProfile, now: Date): string {
  return `${p.name} · ${dayKey(now)}`;
}

/**
 * Seed today's due sweeps for one workspace onto the overnight queue.
 *
 * Returns what it seeded (and why it stopped), so the tick can log something a person
 * can read. Errors on a single profile never abort the rest: one malformed brief must
 * not take the whole rota down.
 */
export async function seedStandingSweeps(
  workspaceId: string,
  opts: { now?: Date; dailyLimit?: number } = {},
): Promise<{ seeded: string[]; skipped: number; remaining: number }> {
  await hydrate();
  const now = opts.now ?? new Date();
  const limit = Math.max(0, opts.dailyLimit ?? DEFAULT_DAILY_SWEEPS);
  const key = `${workspaceId}:${dayKey(now)}`;
  const usedToday = store.seededPerDay?.[key] ?? 0;
  const slots = Math.max(0, limit - usedToday);
  if (slots <= 0) return { seeded: [], skipped: 0, remaining: 0 };

  const mine = store.profiles.filter((p) => p.workspaceId === workspaceId);
  // A sweep still working its way through search/enrich counts against the rota, so a
  // slow night throttles the next one instead of stacking.
  const live = await listNightItems(workspaceId);
  const inFlight = new Set(
    live.filter((i) => i.stage !== "done" && i.stage !== "error").map((i) => i.name),
  );
  // Match on the profile name rather than the dated list name: any sweep of this desk
  // still in flight should hold the next one, whichever day it was seeded.
  const inFlightStems = new Set<string>();
  for (const n of inFlight) inFlightStems.add(String(n).split(" · ")[0]);

  const due = pickDueProfiles(mine, now, slots, inFlightStems);
  const seeded: string[] = [];
  let skipped = 0;
  for (const p of due) {
    try {
      await addNightItem(workspaceId, {
        kind: "search",
        name: sweepName(p, now),
        jd: p.jd,
        location: p.location,
        breadth: p.breadth,
        cap: p.cap,
        radiusMi: p.radiusMi,
        // THE property that makes a rota economical: never re-surface people earlier
        // sweeps already found.
        freshOnly: true,
        createdBy: p.createdBy,
      });
      p.lastSweptAt = nowIso();
      p.sweeps = (p.sweeps ?? 0) + 1;
      p.updatedAt = nowIso();
      seeded.push(p.name);
    } catch {
      // A profile that cannot be queued (bad brief, store hiccup) is skipped and left
      // un-stamped, so it comes round again on the next tick rather than being lost.
      skipped++;
    }
  }
  if (seeded.length) {
    store.seededPerDay = store.seededPerDay || {};
    store.seededPerDay[key] = usedToday + seeded.length;
    // Keep the pacing ledger small: yesterday's counts have no further use.
    for (const k of Object.keys(store.seededPerDay)) {
      if (k.split(":")[1] < dayKey(new Date(now.getTime() - 3 * 86_400_000))) delete store.seededPerDay[k];
    }
    save();
  }
  return { seeded, skipped, remaining: Math.max(0, slots - seeded.length) };
}

/** Every workspace holding at least one active profile, for the cron tick. */
export async function workspacesWithStandingProfiles(): Promise<string[]> {
  await hydrate();
  return [...new Set(store.profiles.filter((p) => p.active).map((p) => p.workspaceId))];
}
