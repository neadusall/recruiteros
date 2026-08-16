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
 *
 * DAILY HISTORY: the reading above is a single point in time, which answers "how much is
 * left" but not "when did we burn it". Every capture therefore also stamps the running
 * `used` count against today's date, giving the Owner Console a per-listing usage curve
 * without a second data source. One number per host per day, 120 days kept.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { nowIso } from "../core/ids";

const KEY = "rapidapi_quota_v1";
/** Days of per-listing usage history retained for the Owner Console sparklines. */
const HISTORY_DAYS = 120;

/** Which product surface a listing's spend belongs to, so each UI meter shows only its
 *  own subscriptions: "people" = JD Sourcing's people-search/profile listings, "jobs" =
 *  the Hire Signals job feed (JSearch), "search" = the paid SERP behind decision-maker
 *  naming, "phone" = the recruiter-triggered skip-trace phone rung. Older stored
 *  snapshots predate this field and are treated as "people" (they could only have come
 *  from the sourcing listings). */
export type RapidQuotaKind = "people" | "jobs" | "search" | "phone";

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

/** host -> { "YYYY-MM-DD": cumulative `used` at the last reading that day }. */
export type RapidQuotaHistory = Record<string, Record<string, number>>;

interface QuotaStore {
  hosts: Record<string, RapidQuotaSnapshot>;
  history: RapidQuotaHistory;
}

let store: QuotaStore = { hosts: {}, history: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Accept both shapes: the current {hosts,history} envelope and the original bare
 *  host->snapshot map, so this upgrade lands without losing an existing reading. */
function adopt(snap: unknown): void {
  if (!snap || typeof snap !== "object") return;
  const s = snap as Partial<QuotaStore> & Record<string, unknown>;
  if (s.hosts && typeof s.hosts === "object") {
    store.hosts = s.hosts as Record<string, RapidQuotaSnapshot>;
    store.history = (s.history && typeof s.history === "object" ? s.history : {}) as RapidQuotaHistory;
    return;
  }
  const legacy: Record<string, RapidQuotaSnapshot> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === "object" && typeof (v as RapidQuotaSnapshot).host === "string") {
      legacy[k] = v as RapidQuotaSnapshot;
    }
  }
  store.hosts = legacy;
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      adopt(await loadSnapshot<unknown>(KEY));
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

/** Stamp today's closing `used` for a host and trim past the retention window. */
function noteHistory(host: string, used: number): void {
  const days = (store.history[host] = store.history[host] || {});
  days[nowIso().slice(0, 10)] = used;
  const keys = Object.keys(days);
  if (keys.length > HISTORY_DAYS) {
    keys.sort();
    for (const k of keys.slice(0, keys.length - HISTORY_DAYS)) delete days[k];
  }
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
  if (!picked) {
    // No plan headers on this response, but the call still happened: keep the
    // "last active" clock honest so the console can tell silent from unwired.
    noteRapidCall(host, kind);
    return;
  }
  const o = objects[picked];
  if (typeof o.limit !== "number" || typeof o.remaining !== "number") {
    noteRapidCall(host, kind);
    return;
  }
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
    store.hosts[host] = snap;
    noteHistory(host, snap.used);
    scheduleSave();
  });
}

/**
 * Record that a listing was CALLED when the response carried no usable quota headers
 * (some listings omit them; a network-level failure has none at all). Without this the
 * Owner Console cannot tell a silent-but-working subscription from an unwired one.
 */
export function noteRapidCall(host: string, kind: RapidQuotaKind = "people"): void {
  if (!host) return;
  void hydrate().then(() => {
    const prev = store.hosts[host];
    store.hosts[host] = prev
      ? { ...prev, kind: prev.kind || kind, updatedAt: nowIso() }
      : { host, kind, object: "unreported", limit: 0, remaining: 0, used: 0, updatedAt: nowIso() };
    scheduleSave();
  });
}

/** Latest reading per listing host, newest first. Pass a kind so each credit meter
 *  shows only its own subscriptions (JD Sourcing = "people", Hire Signals = "jobs");
 *  omit it to get everything. */
export async function getRapidQuota(kind?: RapidQuotaKind): Promise<RapidQuotaSnapshot[]> {
  await hydrate();
  return Object.values(store.hosts)
    .filter((s) => !kind || (s.kind || "people") === kind)
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

/**
 * Latest reading for ONE listing host, or null if that listing has never answered.
 *
 * The engine-health watch needs this rather than getRapidQuota(): it must judge the
 * people-search subscription on its OWN meter. Reading the snapshot generically and
 * taking the tightest row let an unrelated listing (the skip-trace phone rung, the
 * JSearch job feed) decide whether JD Sourcing's search was healthy.
 */
export async function getRapidQuotaFor(host: string): Promise<RapidQuotaSnapshot | null> {
  if (!host) return null;
  await hydrate();
  return store.hosts[host] ?? null;
}

/**
 * Per-day usage for one listing, oldest first, as DELTAS (requests spent that day)
 * rather than the raw cumulative reading. A negative delta means the plan's monthly
 * window rolled between readings, so that day's spend is the new reading itself.
 */
export async function getRapidQuotaHistory(host: string, days = 30): Promise<Array<{ date: string; used: number }>> {
  await hydrate();
  const series = store.history[host];
  if (!series) return [];
  const out: Array<{ date: string; used: number }> = [];
  let prev: number | null = null;
  for (const date of Object.keys(series).sort()) {
    const cum = series[date];
    out.push({ date, used: Math.max(0, prev == null ? cum : cum - prev) });
    prev = cum;
  }
  return out.slice(-days);
}
