/**
 * RecruitersOS · JD Sourcing
 * RapidAPI credit meter: remembers the quota headers every RapidAPI response carries.
 *
 * RapidAPI reports subscription usage ONLY in response headers (x-ratelimit-<object>-limit /
 * -remaining / -reset, one set per quota object); there is no usage endpoint to query.
 * So every people-search and profile call records its headers here, and the JD Sourcing
 * tab reads the latest snapshot to show "credits used / left this month" beside the saved
 * lists. Snapshots are keyed by listing host: each listing is its own subscription with
 * its own monthly quota (the people-search listing and the profile listing differ).
 *
 * Same hydrate-once / snapshot pattern as the sourcing runs store, but saves are
 * debounced: captures fire on every API call during a run, and losing the very last
 * header reading to a crash costs nothing (the next call rewrites it).
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { nowIso } from "../core/ids";

const KEY = "rapidapi_quota_v1";

/** Which product surface a listing's spend belongs to, so each UI meter shows only its
 *  own subscriptions: "people" = JD Sourcing's people-search/profile listings, "jobs" =
 *  the Hire Signals job feed (JSearch). Older stored snapshots predate this field and
 *  are treated as "people" (they could only have come from the sourcing listings). */
export type RapidQuotaKind = "people" | "jobs";

export interface RapidQuotaSnapshot {
  /** The RapidAPI listing host this subscription belongs to. */
  host: string;
  /** Which meter this listing belongs on (absent on old snapshots = "people"). */
  kind?: RapidQuotaKind;
  /** Which quota object the listing reports (usually "requests" = the monthly plan). */
  object: string;
  /** Plan size for the current window. */
  limit: number;
  /** Requests still available in the current window. */
  remaining: number;
  /** Requests already spent this window (limit - remaining). */
  used: number;
  /** When the quota window resets (from the reset-seconds header), ISO. */
  resetAt?: string;
  /** When this reading was captured, ISO. */
  updatedAt: string;
}

let store: Record<string, RapidQuotaSnapshot> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, RapidQuotaSnapshot>>(KEY);
      if (snap && typeof snap === "object") store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSnapshot(KEY, store).catch(() => { /* next capture retries */ });
  }, 2000);
  if (typeof saveTimer.unref === "function") saveTimer.unref();
}

/**
 * Parse the x-ratelimit-* family out of one response and remember the monthly quota.
 * A listing usually reports several quota objects at once (the plan's "requests" pool
 * plus small per-minute rate limits); we keep the plan pool: the "requests" object when
 * present, otherwise the object with the largest limit. No usable headers = no-op, so
 * calling this on every response (including errors, 429s still carry them) is safe.
 */
export function noteRapidQuota(host: string, headers: Headers, kind: RapidQuotaKind = "people"): void {
  if (!host) return;
  const objects: Record<string, { limit?: number; remaining?: number; reset?: number }> = {};
  headers.forEach((value, name) => {
    const m = /^x-ratelimit-(.+)-(limit|remaining|reset)$/i.exec(name);
    if (!m) return;
    const obj = m[1].toLowerCase();
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return;
    (objects[obj] = objects[obj] || {})[m[2].toLowerCase() as "limit" | "remaining" | "reset"] = n;
  });
  let picked: string | undefined;
  if (objects["requests"] && typeof objects["requests"].limit === "number") picked = "requests";
  else {
    for (const k of Object.keys(objects)) {
      const o = objects[k];
      if (typeof o.limit !== "number" || typeof o.remaining !== "number") continue;
      if (/hard-limit/.test(k)) continue; // the infra kill-switch pool, not the plan
      if (!picked || o.limit > (objects[picked].limit as number)) picked = k;
    }
  }
  if (!picked) return;
  const o = objects[picked];
  if (typeof o.limit !== "number" || typeof o.remaining !== "number") return;
  const snap: RapidQuotaSnapshot = {
    host,
    kind,
    object: picked,
    limit: o.limit,
    remaining: o.remaining,
    used: Math.max(0, o.limit - o.remaining),
    resetAt: typeof o.reset === "number" ? new Date(Date.now() + o.reset * 1000).toISOString() : undefined,
    updatedAt: nowIso(),
  };
  void hydrate().then(() => {
    store[host] = snap;
    scheduleSave();
  });
}

/** Latest reading per listing host, newest first. Pass a kind so each credit meter
 *  shows only its own subscriptions (JD Sourcing = "people", Hire Signals = "jobs");
 *  omit it to get everything. */
export async function getRapidQuota(kind?: RapidQuotaKind): Promise<RapidQuotaSnapshot[]> {
  await hydrate();
  return Object.values(store)
    .filter((s) => !kind || (s.kind || "people") === kind)
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}
