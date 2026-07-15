/**
 * RecruitersOS · Outbound Performance · goals & thresholds
 *
 * Target configuration with proper inheritance: GLOBAL -> ROLE -> USER. Each
 * tier stores only what it overrides; resolution merges downward. Role presets
 * ship sensible defaults per function (a dedicated recruiter is not judged on
 * BD email volume). All admin writes go through setGoals(), which audit-logs
 * the change (audit.ts).
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import type {
  Band, ChannelGoals, GoalRole, GoalsPatch, NotifyCategory,
  OutboundGoalsConfig, ResolvedGoals, TriggerThresholds,
} from "./types";

const KEY = "outbound_goals_v1";
let state: Record<string, OutboundGoalsConfig> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, OutboundGoalsConfig>>(KEY);
      if (snap && typeof snap === "object") state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

/* ------------------------------ defaults -------------------------------- */

const band = (min: number, target: number, max: number): Band => ({ min, target, max });

/** Company-wide defaults (the GLOBAL tier when the admin has set nothing). */
export const DEFAULT_CHANNELS: ChannelGoals = {
  bdEmails: band(20, 50, 125),
  recruitingEmails: band(20, 50, 125),
  liConnections: band(10, 20, 30),
  liMessages: band(10, 25, 50),
  liVoiceNotes: band(0, 3, 10),
  liProfileViews: band(10, 25, 50),
  smsMessages: band(10, 30, 75),
  followUps: band(10, 25, 60),
  liPostsPerWeek: band(1, 3, 7),
};

export const DEFAULT_TRIGGERS: TriggerThresholds = {
  emailUtilNoonPct: 40,
  emailUtilAfternoonPct: 70,
  linkedinUtilPct: 60,
  smsReplyWaitMinutes: 60,
  noPostDays: 7,
  bounceRatePct: 5,
  optOutRatePct: 2,
  responseDropPct: 30,
  activityDropPct: 35,
  notLoggedInDays: 2,
  underutilizedDays: 5,
  managerUtilFloorPct: 50,
};

/** Role presets: multipliers over the global channel bands. */
const ROLE_PRESETS: Record<GoalRole, Partial<Record<keyof ChannelGoals, number>>> = {
  recruiter:             { bdEmails: 0, recruitingEmails: 1.2, smsMessages: 1.2 },
  senior_recruiter:      { bdEmails: 0.4, recruitingEmails: 1 },
  recruiting_manager:    { bdEmails: 0.4, recruitingEmails: 0.5, liPostsPerWeek: 1.3 },
  business_development:  { recruitingEmails: 0, bdEmails: 1.2, liPostsPerWeek: 1.3 },
  account_executive:     { recruitingEmails: 0, bdEmails: 1 },
  recruiting_operations: { bdEmails: 0.2, recruitingEmails: 0.2, liConnections: 0.3, smsMessages: 0.3, liPostsPerWeek: 0.3 },
  administrator:         { bdEmails: 0.3, recruitingEmails: 0.3, liConnections: 0.5, smsMessages: 0.3 },
};

export const GOAL_ROLES: GoalRole[] = [
  "recruiter", "senior_recruiter", "recruiting_manager",
  "business_development", "account_executive", "recruiting_operations", "administrator",
];

/* ------------------------------- store ---------------------------------- */

function empty(workspaceId: string): OutboundGoalsConfig {
  return { workspaceId, global: {}, byRole: {}, byUser: {}, userRoles: {}, userPhones: {}, updatedAt: nowIso() };
}

export async function getGoalsConfig(workspaceId: string): Promise<OutboundGoalsConfig> {
  await hydrate();
  return state[workspaceId] ?? empty(workspaceId);
}

export async function putGoalsConfig(workspaceId: string, next: OutboundGoalsConfig): Promise<OutboundGoalsConfig> {
  await hydrate();
  next.workspaceId = workspaceId;
  next.updatedAt = nowIso();
  state[workspaceId] = next;
  save();
  return next;
}

/* ----------------------------- resolution ------------------------------- */

function scaleBand(b: Band, f: number): Band {
  return { min: Math.round(b.min * f), target: Math.round(b.target * f), max: Math.round(b.max * f) };
}

function mergeBand(base: Band, patch?: Partial<Band>): Band {
  if (!patch) return base;
  return {
    min: patch.min ?? base.min,
    target: patch.target ?? base.target,
    max: patch.max ?? base.max,
  };
}

function applyPatch(base: ResolvedGoals, p?: GoalsPatch): ResolvedGoals {
  if (!p) return base;
  const channels = { ...base.channels };
  if (p.channels) {
    for (const k of Object.keys(p.channels) as Array<keyof ChannelGoals>) {
      channels[k] = mergeBand(channels[k], p.channels[k]);
    }
  }
  return {
    ...base,
    channels,
    triggers: { ...base.triggers, ...(p.triggers ?? {}) },
    workingDays: p.workingDays ?? base.workingDays,
    workHoursStart: p.workHoursStart ?? base.workHoursStart,
    workHoursEnd: p.workHoursEnd ?? base.workHoursEnd,
    timezone: p.timezone ?? base.timezone,
    morningHour: p.morningHour ?? base.morningHour,
    middayHour: p.middayHour ?? base.middayHour,
    eodHour: p.eodHour ?? base.eodHour,
    smsEnabled: p.smsEnabled ?? base.smsEnabled,
    requiredCategories: p.requiredCategories ?? base.requiredCategories,
  };
}

/** Map an auth role to a default goal role when the admin has not assigned one. */
export function defaultGoalRole(authRole: string): GoalRole {
  if (authRole === "owner" || authRole === "admin") return "administrator";
  return "recruiter";
}

/** Fully-resolved goals for one user: defaults -> global -> role -> user. */
export async function resolveGoals(workspaceId: string, userId: string, authRole = "member"): Promise<ResolvedGoals> {
  const cfg = await getGoalsConfig(workspaceId);
  const role: GoalRole = cfg.userRoles[userId] ?? defaultGoalRole(authRole);

  // Base = shipped defaults with the role preset multipliers applied.
  const preset = ROLE_PRESETS[role] ?? {};
  const channels = { ...DEFAULT_CHANNELS };
  for (const k of Object.keys(channels) as Array<keyof ChannelGoals>) {
    const f = preset[k];
    if (typeof f === "number") channels[k] = scaleBand(DEFAULT_CHANNELS[k], f);
  }

  let resolved: ResolvedGoals = {
    role,
    channels,
    triggers: { ...DEFAULT_TRIGGERS },
    workingDays: [1, 2, 3, 4, 5],
    workHoursStart: 8,
    workHoursEnd: 18,
    timezone: "America/New_York",
    morningHour: 8,
    middayHour: 12,
    eodHour: 17,
    smsEnabled: false,
    requiredCategories: ["system"] as NotifyCategory[],
  };
  resolved = applyPatch(resolved, cfg.global);
  resolved = applyPatch(resolved, cfg.byRole[role]);
  resolved = applyPatch(resolved, cfg.byUser[userId]);
  return resolved;
}

/** The user's local YYYY-MM-DD reporting day. */
export function localDay(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(at);
  }
}

/** The user's local hour 0-23. */
export function localHour(tz: string, at: Date = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", hour12: false }).format(at)) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/** Local day-of-week 0=Sun..6=Sat. */
export function localDow(tz: string, at: Date = new Date()): number {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  try {
    const d = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", weekday: "short" }).format(at);
    return Math.max(0, names.indexOf(d.slice(0, 3)));
  } catch {
    return at.getUTCDay();
  }
}
