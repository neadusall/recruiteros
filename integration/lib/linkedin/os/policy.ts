/**
 * RecruitersOS · LinkedIn OS
 * Account utilization policies: visible, configurable, never hardcoded into
 * the send paths. Presets are RECOMMENDED STARTING POLICIES for an operating
 * mode; nothing here is ever presented as a limit LinkedIn guarantees.
 * Values change at runtime through the Limits & Policies UI (PUT), so limits
 * move without a code deployment.
 */

import { nowIso } from "../../core/ids";
import { policies, withEngineLock } from "./store";
import type {
  AccountPolicy, CategoryPolicy, LiCapCategory, PolicyMode, PressureConfig,
} from "./types";

const CATEGORIES: LiCapCategory[] = [
  "connections", "messages", "voice_notes", "inmails", "profile_views", "interactions",
];

function cat(dailyTarget: number, hardCeiling: number, weeklyTarget: number): CategoryPolicy {
  return { dailyTarget, hardCeiling, weeklyTarget };
}

function pressureDefaults(mode: PolicyMode): PressureConfig {
  const base: PressureConfig = {
    windowDays: 7,
    maxTouches: 5,
    weights: {
      email: 1, connection: 1, linkedin_message: 1,
      voice_note: 2, inmail: 2, voicemail: 2, sms: 2,
    },
    elevatedThreshold: 5,
    highThreshold: 8,
    elevatedAction: "increase_spacing",
    highAction: "pause_review",
  };
  if (mode === "conservative") return { ...base, maxTouches: 4, elevatedThreshold: 4, highThreshold: 6 };
  if (mode === "aggressive") return { ...base, maxTouches: 7, elevatedThreshold: 7, highThreshold: 10 };
  return base;
}

/** Recommended starting policies per operating mode. */
export function presetFor(mode: PolicyMode): Omit<AccountPolicy, "workspaceId" | "accountId" | "updatedAt"> {
  switch (mode) {
    case "conservative":
      return {
        mode,
        categories: {
          connections: cat(12, 20, 60),
          messages: cat(30, 45, 150),
          voice_notes: cat(8, 15, 40),
          inmails: cat(3, 6, 15),
          profile_views: cat(30, 50, 150),
          interactions: cat(10, 20, 50),
        },
        pacing: {
          minDelayMinutes: 8, maxDelayMinutes: 25,
          randomizedTiming: true, burstProtection: true,
          autoCooldown: true, capacityReallocation: true,
        },
        workingHours: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] },
        timezone: "UTC",
        pressure: pressureDefaults(mode),
      };
    case "aggressive":
      return {
        mode,
        categories: {
          connections: cat(30, 40, 150),
          messages: cat(70, 90, 350),
          voice_notes: cat(20, 30, 100),
          inmails: cat(8, 12, 40),
          profile_views: cat(60, 90, 300),
          interactions: cat(25, 40, 120),
        },
        pacing: {
          minDelayMinutes: 3, maxDelayMinutes: 10,
          randomizedTiming: true, burstProtection: true,
          autoCooldown: true, capacityReallocation: true,
        },
        workingHours: { startHour: 8, endHour: 19, days: [1, 2, 3, 4, 5] },
        timezone: "UTC",
        pressure: pressureDefaults(mode),
      };
    case "balanced":
    case "custom":
    default:
      return {
        mode: mode === "custom" ? "custom" : "balanced",
        categories: {
          connections: cat(20, 30, 100),
          messages: cat(50, 70, 250),
          voice_notes: cat(15, 25, 75),
          inmails: cat(5, 10, 25),
          profile_views: cat(45, 70, 220),
          interactions: cat(15, 30, 80),
        },
        pacing: {
          minDelayMinutes: 4, maxDelayMinutes: 17,
          randomizedTiming: true, burstProtection: true,
          autoCooldown: true, capacityReallocation: true,
        },
        workingHours: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] },
        timezone: "UTC",
        pressure: pressureDefaults("balanced"),
      };
  }
}

/** All four presets, for the Limits & Policies UI. */
export function policyPresets(): Record<PolicyMode, ReturnType<typeof presetFor>> {
  return {
    conservative: presetFor("conservative"),
    balanced: presetFor("balanced"),
    aggressive: presetFor("aggressive"),
    custom: presetFor("custom"),
  };
}

/** Effective policy for an account: stored, else the balanced starting policy. */
export async function getPolicy(workspaceId: string, accountId: string): Promise<AccountPolicy> {
  const all = await policies.all();
  const found = all.find((p) => p.workspaceId === workspaceId && p.accountId === accountId);
  if (found) return withDefaults(found);
  return { workspaceId, accountId, updatedAt: nowIso(), ...presetFor("balanced") };
}

/** Hydrate-time defaulting so older snapshots survive shape evolution. */
function withDefaults(p: AccountPolicy): AccountPolicy {
  const base = presetFor(p.mode ?? "balanced");
  const categories = { ...base.categories } as AccountPolicy["categories"];
  for (const c of CATEGORIES) {
    categories[c] = { ...base.categories[c], ...(p.categories?.[c] ?? {}) };
  }
  return {
    ...base,
    ...p,
    categories,
    pacing: { ...base.pacing, ...(p.pacing ?? {}) },
    workingHours: { ...base.workingHours, ...(p.workingHours ?? {}) },
    pressure: {
      ...base.pressure,
      ...(p.pressure ?? {}),
      weights: { ...base.pressure.weights, ...(p.pressure?.weights ?? {}) },
    },
  };
}

const int = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fb;
};

/**
 * Merge-patch an account policy. Sanitizes every numeric field; a hard ceiling
 * can never sink below its daily target (the ceiling is the outer wall).
 * Selecting a non-custom mode with no field overrides applies that preset.
 */
export async function putPolicy(
  workspaceId: string,
  accountId: string,
  patch: Partial<AccountPolicy> & { applyPreset?: PolicyMode },
): Promise<AccountPolicy> {
  return withEngineLock(async () => {
    const all = await policies.all();
    let current = all.find((p) => p.workspaceId === workspaceId && p.accountId === accountId);
    const base = current ? withDefaults(current) : { workspaceId, accountId, updatedAt: nowIso(), ...presetFor("balanced") };

    let next: AccountPolicy = { ...base };
    if (patch.applyPreset) {
      next = { workspaceId, accountId, updatedAt: nowIso(), ...presetFor(patch.applyPreset) };
    }
    if (patch.mode && ["conservative", "balanced", "aggressive", "custom"].includes(patch.mode)) {
      next.mode = patch.mode;
    }
    if (patch.categories) {
      for (const c of CATEGORIES) {
        const inc = (patch.categories as Record<string, Partial<CategoryPolicy>>)[c];
        if (!inc) continue;
        const cur = next.categories[c];
        const dailyTarget = int(inc.dailyTarget, 0, 500, cur.dailyTarget);
        const hardCeiling = Math.max(dailyTarget, int(inc.hardCeiling, 0, 1000, cur.hardCeiling));
        const weeklyTarget = int(inc.weeklyTarget, 0, 5000, cur.weeklyTarget);
        next.categories[c] = { dailyTarget, hardCeiling, weeklyTarget };
        if (!patch.applyPreset) next.mode = patch.mode ?? "custom";
      }
    }
    if (patch.pacing) {
      const p = patch.pacing as Partial<AccountPolicy["pacing"]>;
      const minDelayMinutes = int(p.minDelayMinutes, 1, 240, next.pacing.minDelayMinutes);
      next.pacing = {
        minDelayMinutes,
        maxDelayMinutes: Math.max(minDelayMinutes, int(p.maxDelayMinutes, 1, 480, next.pacing.maxDelayMinutes)),
        randomizedTiming: p.randomizedTiming ?? next.pacing.randomizedTiming,
        burstProtection: p.burstProtection ?? next.pacing.burstProtection,
        autoCooldown: p.autoCooldown ?? next.pacing.autoCooldown,
        capacityReallocation: p.capacityReallocation ?? next.pacing.capacityReallocation,
      };
    }
    if (patch.workingHours) {
      const w = patch.workingHours as Partial<AccountPolicy["workingHours"]>;
      const startHour = int(w.startHour, 0, 23, next.workingHours.startHour);
      next.workingHours = {
        startHour,
        endHour: Math.max(startHour + 1, int(w.endHour, 1, 24, next.workingHours.endHour)),
        days: Array.isArray(w.days) && w.days.length
          ? w.days.map((d) => int(d, 1, 7, 1)).filter((d, i, a) => a.indexOf(d) === i)
          : next.workingHours.days,
      };
    }
    if (typeof patch.timezone === "string" && patch.timezone.trim()) {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: patch.timezone.trim() });
        next.timezone = patch.timezone.trim();
      } catch { /* invalid tz: keep current */ }
    }
    if (patch.pressure) {
      const pr = patch.pressure as Partial<PressureConfig>;
      const elevated = int(pr.elevatedThreshold, 1, 100, next.pressure.elevatedThreshold);
      next.pressure = {
        windowDays: int(pr.windowDays, 1, 90, next.pressure.windowDays),
        maxTouches: int(pr.maxTouches, 1, 100, next.pressure.maxTouches),
        weights: { ...next.pressure.weights, ...(pr.weights ?? {}) },
        elevatedThreshold: elevated,
        highThreshold: Math.max(elevated + 1, int(pr.highThreshold, 2, 200, next.pressure.highThreshold)),
        elevatedAction: pr.elevatedAction ?? next.pressure.elevatedAction,
        highAction: pr.highAction ?? next.pressure.highAction,
      };
    }
    next.updatedAt = nowIso();

    if (current) {
      Object.assign(current, next);
    } else {
      all.push(next);
      current = next;
    }
    policies.save();
    return next;
  });
}
