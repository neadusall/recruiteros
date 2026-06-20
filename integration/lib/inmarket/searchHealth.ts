/**
 * RecruitersOS · In-Market · search-source health + sustainability
 *
 * The free naming finder scrapes public search-engine result titles (DuckDuckGo, Bing). That is
 * sustainable WHEN spread across the egress IP rotation, but engines can still throttle under load.
 * This module is the safety system around it:
 *   - records every search outcome per engine (ok / empty / throttled) in a rolling window,
 *   - computes a live status (healthy | degraded | throttled) the UI can show, and
 *   - drives exponential back-off so a throttled engine is rested instead of hammered.
 *
 * It's in-memory (the accumulator + the API run in one process) with a periodic snapshot so the
 * status survives a restart. Zero cost, and it's what lets us "run it hard" safely.
 */

import { saveSnapshot, loadSnapshot } from "../db";

export type SearchOutcome = "ok" | "empty" | "throttled";
export type SearchStatus = "healthy" | "degraded" | "throttled" | "idle";

const WINDOW = 40;                       // rolling outcomes kept per engine
const BACKOFF_BASE_MS = 60_000;          // first throttle rests the engine 1 min…
const BACKOFF_MAX_MS = 15 * 60_000;      // …doubling up to 15 min on repeated throttles

interface EngineState {
  recent: SearchOutcome[];               // ring of the last WINDOW outcomes
  consecThrottle: number;                // grows the back-off
  backoffUntil: number;                  // epoch ms; 0 = available
  lastThrottleAt?: number;
  lastOkAt?: number;
  totalRequests: number;
  totalThrottled: number;
}

const engines: Record<string, EngineState> = {};
const KEY = "inmarket_search_health_v1";
let dirtyAt = 0;

function st(engine: string): EngineState {
  return (engines[engine] ??= {
    recent: [], consecThrottle: 0, backoffUntil: 0, totalRequests: 0, totalThrottled: 0,
  });
}

/** Record one search outcome and update back-off. */
export function recordSearch(engine: string, outcome: SearchOutcome, now = Date.now()): void {
  const s = st(engine);
  s.recent.push(outcome);
  if (s.recent.length > WINDOW) s.recent.shift();
  s.totalRequests++;
  if (outcome === "throttled") {
    s.totalThrottled++;
    s.consecThrottle++;
    s.lastThrottleAt = now;
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (s.consecThrottle - 1), BACKOFF_MAX_MS);
    s.backoffUntil = now + wait;
  } else {
    if (outcome === "ok") s.lastOkAt = now;
    s.consecThrottle = 0;
    s.backoffUntil = 0;
  }
  // Persist at most every 15s so we never thrash the store.
  if (now - dirtyAt > 15_000) {
    dirtyAt = now;
    void saveSnapshot(KEY, snapshot()).catch(() => undefined);
  }
}

/** Ms an engine should rest before its next request (0 = available now). */
export function backoffMs(engine: string, now = Date.now()): number {
  return Math.max(0, st(engine).backoffUntil - now);
}

/** True when the engine is OK to query right now. */
export function isAvailable(engine: string, now = Date.now()): boolean {
  return backoffMs(engine, now) === 0;
}

function rate(s: EngineState, kind: SearchOutcome): number {
  if (!s.recent.length) return 0;
  return s.recent.filter((o) => o === kind).length / s.recent.length;
}

function engineStatus(s: EngineState, now: number): SearchStatus {
  if (!s.recent.length) return "idle";
  if (s.backoffUntil > now) return "throttled";
  const thr = rate(s, "throttled");
  if (thr >= 0.25) return "degraded";
  return "healthy";
}

export interface SearchHealth {
  status: SearchStatus;                  // overall (best engine wins)
  healthy: boolean;
  engines: Array<{
    engine: string;
    status: SearchStatus;
    okRate: number;
    throttleRate: number;
    emptyRate: number;
    backoffSec: number;
    requests: number;
    lastOkAt?: string;
  }>;
}

const RANK: Record<SearchStatus, number> = { healthy: 3, degraded: 2, idle: 1, throttled: 0 };

/** The live health view for the API + UI pill. */
export function searchHealth(now = Date.now()): SearchHealth {
  const list = Object.keys(engines).map((engine) => {
    const s = engines[engine];
    return {
      engine,
      status: engineStatus(s, now),
      okRate: round(rate(s, "ok")),
      throttleRate: round(rate(s, "throttled")),
      emptyRate: round(rate(s, "empty")),
      backoffSec: Math.round(backoffMs(engine, now) / 1000),
      requests: s.totalRequests,
      lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : undefined,
    };
  });
  // Overall = the BEST engine (we only need one healthy source to keep naming flowing).
  const overall: SearchStatus = list.length
    ? list.reduce((best, e) => (RANK[e.status] > RANK[best] ? e.status : best), "throttled" as SearchStatus)
    : "idle";
  return { status: overall, healthy: overall === "healthy" || overall === "idle", engines: list };
}

function snapshot(): SearchHealth {
  return searchHealth();
}

/** Hydrate the persisted status on boot so the UI isn't blank right after a restart. */
export async function hydrateSearchHealth(): Promise<void> {
  try {
    const saved = await loadSnapshot<SearchHealth>(KEY);
    if (!saved?.engines) return;
    for (const e of saved.engines) {
      const s = st(e.engine);
      if (!s.recent.length && e.requests) {
        s.totalRequests = e.requests;
        // seed a rough recent window from the saved rates so the first render is sensible
        const okN = Math.round((e.okRate ?? 0) * WINDOW);
        const thrN = Math.round((e.throttleRate ?? 0) * WINDOW);
        s.recent = [
          ...Array(okN).fill("ok" as SearchOutcome),
          ...Array(thrN).fill("throttled" as SearchOutcome),
        ].slice(0, WINDOW);
      }
    }
  } catch {
    /* best-effort */
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
