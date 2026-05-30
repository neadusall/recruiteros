/**
 * RecruiterOS · LinkedIn Engine
 * Account-safety rate limiter.
 *
 * The fastest way to lose a LinkedIn seat is to behave like a bot. This module
 * enforces three protections before any action runs:
 *   1. Per-action daily caps (token buckets keyed by account + action + day).
 *   2. Working-hours windows in the account's local timezone.
 *   3. Human-like jitter between actions (randomized spacing).
 *
 * The counter store is pluggable. The default is in-memory for local/dev; in
 * production wire `setUsageStore()` to Redis or your RecruiterOS DB so caps are
 * shared across workers.
 */

import type { LinkedInAccount, LinkedInActionType } from "./types";

export interface UsageStore {
  /** Increment + return the new count for (key) within the current day. */
  incr(key: string): Promise<number>;
  /** Current count without incrementing. */
  get(key: string): Promise<number>;
}

// --- default in-memory store (replace in production) ---------------------
const memory = new Map<string, { day: string; count: number }>();
function today(tz: string): string {
  // YYYY-MM-DD in the account timezone
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}
const memoryStore: UsageStore = {
  async incr(key) {
    const [, , tz] = key.split("|");
    const d = today(tz || "UTC");
    const cur = memory.get(key);
    if (!cur || cur.day !== d) {
      memory.set(key, { day: d, count: 1 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  },
  async get(key) {
    const [, , tz] = key.split("|");
    const d = today(tz || "UTC");
    const cur = memory.get(key);
    return cur && cur.day === d ? cur.count : 0;
  },
};

let store: UsageStore = memoryStore;
export function setUsageStore(s: UsageStore): void {
  store = s;
}

function capFor(account: LinkedInAccount, action: LinkedInActionType): number {
  const l = account.limits;
  switch (action) {
    case "connect": return l.invitesPerDay;
    case "message":
    case "voice_note": return l.messagesPerDay;
    case "inmail": return l.inmailsPerDay;
    case "profile_view":
    case "endorse": return l.profileViewsPerDay;
    // withdraw is housekeeping, not outreach: no cap
    case "withdraw_invite": return Number.MAX_SAFE_INTEGER;
    default: return 0;
  }
}

export interface GateResult {
  allowed: boolean;
  reason?: "cap_reached" | "outside_hours" | "account_unavailable";
  /** ISO time the caller should retry, when deferred. */
  retryAt?: string;
}

function nextWorkingWindow(account: LinkedInAccount): string {
  // Returns ISO of the next acceptable moment (start of the next working window).
  const { startHour, days } = account.limits.workingHours;
  const now = new Date();
  for (let add = 0; add < 8; add++) {
    const probe = new Date(now.getTime() + add * 86_400_000);
    const localDay = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: account.timezone, weekday: "short" })
        .format(probe)
        .replace(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/, (m) =>
          String(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(m) + 1)),
    );
    if (days.includes(localDay)) {
      const start = new Date(probe);
      start.setHours(startHour, Math.floor(Math.random() * 15), 0, 0);
      if (add === 0 && start <= now) continue;
      return start.toISOString();
    }
  }
  return new Date(now.getTime() + 86_400_000).toISOString();
}

function withinWorkingHours(account: LinkedInAccount): boolean {
  const { startHour, endHour, days } = account.limits.workingHours;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: account.timezone,
    hour: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(fmt.find((p) => p.type === "hour")?.value ?? "0");
  const wd = fmt.find((p) => p.type === "weekday")?.value ?? "Mon";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd) + 1;
  return days.includes(day) && hour >= startHour && hour < endHour;
}

/**
 * Check (and reserve) capacity for an action. Call this immediately before
 * executing. If it returns `allowed:false`, schedule a retry at `retryAt`.
 */
export async function gate(
  account: LinkedInAccount,
  action: LinkedInActionType,
): Promise<GateResult> {
  if (account.status === "restricted" || account.status === "disconnected") {
    return { allowed: false, reason: "account_unavailable" };
  }
  if (action !== "withdraw_invite" && !withinWorkingHours(account)) {
    return { allowed: false, reason: "outside_hours", retryAt: nextWorkingWindow(account) };
  }
  const cap = capFor(account, action);
  const key = `${account.id}|${action}|${account.timezone}`;
  const used = await store.get(key);
  if (used >= cap) {
    return { allowed: false, reason: "cap_reached", retryAt: nextWorkingWindow(account) };
  }
  await store.incr(key);
  return { allowed: true };
}

/**
 * Human-like spacing between consecutive actions on the same account.
 * Returns a jittered delay (ms). Defaults to roughly 45s..150s.
 */
export function humanJitterMs(minSec = 45, maxSec = 150): number {
  const span = (maxSec - minSec) * 1000;
  return minSec * 1000 + Math.floor(Math.random() * span);
}

/** Account-safe default limits for a standard (non-Sales-Nav) seat. */
export function defaultLimits(): LinkedInAccount["limits"] {
  return {
    invitesPerDay: 20,        // deliberately conservative
    messagesPerDay: 80,
    inmailsPerDay: 10,
    profileViewsPerDay: 60,
    workingHours: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] },
  };
}
