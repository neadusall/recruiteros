/**
 * RecruitersOS · Owner Console · Boost phones (paid skip-trace) usage.
 *
 * Two numbers the operator needs and could not previously see in one place:
 *
 *   1. WHAT WE SPENT — rolled up from the billing ledger's premium_phone_boost
 *      events, per workspace, with lookups bought and phones actually found. The
 *      ledger is already the system of record (every Boost press writes one
 *      event attributed to the recruiter); this only reshapes it.
 *
 *   2. WHAT THE PLAN HAS LEFT — the live RapidAPI quota for the skip-trace
 *      listing, read straight off the response headers (x-ratelimit-requests-*).
 *      RapidAPI exposes no consumer API for plan/quota data, so a real request
 *      is the only way to learn the balance. That makes the probe itself cost a
 *      request, hence the cache below.
 *
 * The probe is deliberately cheap and rate-limited: one call per PROBE_TTL_MS
 * per host, shared by every viewer, so a console left open all day costs a
 * couple of dozen requests out of a 22,500 plan rather than one per refresh.
 */

import { listUsageByType } from "./ledger";
import { resolvedKeys } from "../connected/credentials";

export const BOOST_TYPE = "premium_phone_boost";

export interface BoostWorkspaceRow {
  workspaceId: string;
  /** Boost runs (one per press of the button). */
  events: number;
  /** People looked up (what the plan is billed for). */
  lookups: number;
  /** Phones the lookups actually returned. */
  found: number;
  costUsd: number;
  /** found / lookups, the workspace's real hit rate. */
  hitRatePct: number;
  lastAt: string | null;
}

export interface BoostQuota {
  host: string;
  /** Requests the plan allows per cycle, from the live header. */
  limit: number | null;
  remaining: number | null;
  /** Seconds until the plan's quota resets. */
  resetSec: number | null;
  checkedAt: string;
  /** Set when the probe could not read a balance (unsubscribed, no key, network). */
  error?: string;
}

export interface BoostUsage {
  totals: { events: number; lookups: number; found: number; costUsd: number; hitRatePct: number };
  byWorkspace: BoostWorkspaceRow[];
  quota: BoostQuota | null;
}

function rate(found: number, lookups: number): number {
  return lookups > 0 ? Math.round((found / lookups) * 1000) / 10 : 0;
}

/** Ledger rollup of every Boost run, newest activity first. */
export function boostRollup(): Omit<BoostUsage, "quota"> {
  const rows = listUsageByType(BOOST_TYPE);
  const by = new Map<string, BoostWorkspaceRow>();
  const totals = { events: 0, lookups: 0, found: 0, costUsd: 0, hitRatePct: 0 };

  for (const e of rows) {
    const ws = e.workspaceId || "(unattributed)";
    const row =
      by.get(ws) ??
      { workspaceId: ws, events: 0, lookups: 0, found: 0, costUsd: 0, hitRatePct: 0, lastAt: null };
    const found = Number((e.meta as Record<string, unknown> | undefined)?.found ?? 0) || 0;
    row.events += 1;
    row.lookups += Number(e.quantity ?? 0) || 0;
    row.found += found;
    row.costUsd += Number(e.costUsd ?? 0) || 0;
    if (!row.lastAt || String(e.at) > row.lastAt) row.lastAt = String(e.at);
    by.set(ws, row);

    totals.events += 1;
    totals.lookups += Number(e.quantity ?? 0) || 0;
    totals.found += found;
    totals.costUsd += Number(e.costUsd ?? 0) || 0;
  }

  const byWorkspace = [...by.values()]
    .map((r) => ({ ...r, costUsd: Math.round(r.costUsd * 100) / 100, hitRatePct: rate(r.found, r.lookups) }))
    .sort((a, b) => b.lookups - a.lookups);

  totals.costUsd = Math.round(totals.costUsd * 100) / 100;
  totals.hitRatePct = rate(totals.found, totals.lookups);
  return { totals, byWorkspace };
}

/* ------------------------------------------------------------------ */
/* Live plan quota                                                     */
/* ------------------------------------------------------------------ */

const PROBE_TTL_MS = 30 * 60 * 1000; // 30 min: ~48 probe requests/day, worst case
const cache = new Map<string, { at: number; value: BoostQuota }>();

/** A request cheap enough to be a probe but real enough to return plan headers. */
function probePath(pathTemplate: string): string {
  return pathTemplate
    .replace(/\{name\}/g, "John%20Smith")
    .replace(/\{first\}/g, "John")
    .replace(/\{last\}/g, "Smith")
    .replace(/\{citystatezip\}/g, "Dallas,%20TX")
    .replace(/\{city\}/g, "Dallas")
    .replace(/\{state\}/g, "TX")
    .replace(/\{company\}/g, "")
    .replace(/\{location\}/g, "Dallas,%20TX");
}

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the skip-trace listing's remaining quota for a workspace's own key.
 * Returns null when the workspace has not configured the rung at all (nothing
 * to report), and a row carrying `error` when it is configured but unreadable -
 * "not subscribed" is a real answer the operator needs to see, not an absence.
 */
export async function skiptraceQuota(workspaceId: string): Promise<BoostQuota | null> {
  let keys: Record<string, string> = {};
  try {
    keys = await resolvedKeys(workspaceId);
  } catch {
    return null;
  }
  const host = (keys.RAPIDAPI_SKIPTRACE_HOST || "").trim();
  const key = (keys.RAPIDAPI_KEY || "").trim();
  if (!host) return null;

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

  const base: BoostQuota = { host, limit: null, remaining: null, resetSec: null, checkedAt: new Date().toISOString() };
  if (!key) {
    const v = { ...base, error: "No RapidAPI key on this account" };
    cache.set(host, { at: Date.now(), value: v });
    return v;
  }

  const path = probePath((keys.RAPIDAPI_SKIPTRACE_PATH || "/search/byname?name={name}&citystatezip={citystatezip}&page=1").trim());
  let value: BoostQuota;
  try {
    const res = await fetch("https://" + host + (path.startsWith("/") ? path : "/" + path), {
      headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
    });
    const limit = num(res.headers.get("x-ratelimit-requests-limit"));
    const remaining = num(res.headers.get("x-ratelimit-requests-remaining"));
    value = {
      ...base,
      limit,
      remaining,
      resetSec: num(res.headers.get("x-ratelimit-requests-reset")),
      // 403 with no headers is the "you are not subscribed" shape; say so plainly
      // rather than rendering an empty card that looks like a bug.
      ...(limit == null && remaining == null
        ? { error: res.status === 403 ? "Not subscribed to this API" : "Plan headers not returned (HTTP " + res.status + ")" }
        : {}),
    };
  } catch (err) {
    value = { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  cache.set(host, { at: Date.now(), value });
  return value;
}

/** Ledger rollup + the live plan balance for the workspace that owns the rung. */
export async function boostUsage(quotaWorkspaceId?: string): Promise<BoostUsage> {
  const roll = boostRollup();
  // Probe the workspace the caller asked about, else the heaviest Boost user -
  // the one whose plan is actually being drawn down.
  const ws = (quotaWorkspaceId || roll.byWorkspace[0]?.workspaceId || "").trim();
  const quota = ws && ws !== "(unattributed)" ? await skiptraceQuota(ws).catch(() => null) : null;
  return { ...roll, quota };
}
