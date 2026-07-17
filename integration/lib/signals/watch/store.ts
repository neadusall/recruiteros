/**
 * RecruitersOS · Signal Watchlists · durable store
 *
 * A Watchlist is a saved "target job / target audience" (a JSearch query + filters). A
 * scheduler tick (lib/signals/watch/poll) polls each active list on its cadence, keeps only
 * genuinely-new hiring companies, and hands them to the existing In-Market curation spine
 * (curateFromPool → 3 decision-makers → Clients tab → emails → Send Queue). This file owns
 * everything PERSISTED: the watchlist definitions, the cross-poll "seen" set that guarantees a
 * company is actioned once, and the per-day RapidAPI fetch budget that caps spend.
 *
 * Durability mirrors the sourcing stores: a single JSON blob per key on the durable snapshot
 * layer (Postgres if DATABASE_URL, else the /data volume), awaited on every mutate so a redeploy
 * mid-tick can't lose a definition. Writes are serialized through an in-process lock because the
 * poll tick and the CRUD route are independent full-blob writers (same hazard curation.ts guards).
 */

import { rid, nowIso } from "../../core/ids";
import { loadSnapshot, saveSnapshot } from "../../db";

/* ------------------------------------------------------------------ */
/* Watchlist definition                                                */
/* ------------------------------------------------------------------ */

export interface WatchStats {
  /** Total polls run against this list. */
  polls: number;
  /** Companies the feed returned on the LAST poll (before dedupe). */
  lastFound: number;
  /** Net-new companies actioned on the LAST poll (after dedupe). */
  lastFresh: number;
  /** Contactable decision-makers curated on the LAST poll. */
  lastContactable: number;
  /** Lifetime net-new companies actioned. */
  totalFresh: number;
  /** Lifetime contactable decision-makers curated. */
  totalContactable: number;
  /** Last poll's error, if any (cleared on the next clean poll). */
  lastError?: string;
  /** When the last poll that FOUND at least one fresh company ran (ISO). */
  lastHitAt?: string;
}

export interface Watchlist {
  id: string;
  workspaceId: string;
  /** Human name, e.g. "VP Sales · SaaS · US remote". */
  name: string;
  /* ---- the query (what the feed searches) ---- */
  query: string;                 // JSearch query (role / keywords), REQUIRED by the feed
  industry?: string;             // optional market/industry, folded into the query at poll time
  location?: string;             // folded into the query as "<query> in <location>"
  remoteOnly?: boolean;
  employmentTypes?: string[];    // FULLTIME | PARTTIME | CONTRACTOR | INTERN
  /** JSearch date window. Default "today" so frequent polls surface only fresh postings. */
  datePosted?: "all" | "today" | "3days" | "week" | "month";
  /** Jobs to pull per poll (feed cost scales with this). */
  limit?: number;
  /** Only curate companies scoring at/above this hiring-intent threshold. */
  minScore?: number;
  /** Cap net-new companies actioned per poll, so one hot list can't flood the belt. */
  perPollCompanyCap?: number;
  /* ---- scheduling ---- */
  active: boolean;
  everyMinutes: number;          // poll cadence; 15 = "hottest"
  createdAt: string;
  updatedAt: string;
  lastPolledAt?: string;
  stats: WatchStats;
}

const KEY = "signals_watchlists_v1";

let store: Watchlist[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Watchlist[]>(KEY);
      if (Array.isArray(snap)) store = snap.map(normalize);
      hydrated = true;
    })();
  }
  return hydrating;
}

/** Serialize every full-blob write (tick + CRUD) so interleaved saves never clobber. */
let writeChain: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

function emptyStats(): WatchStats {
  return { polls: 0, lastFound: 0, lastFresh: 0, lastContactable: 0, totalFresh: 0, totalContactable: 0 };
}

/** Fill defaults on a loaded/incoming row so older snapshots and partial inputs are always valid. */
function normalize(w: Partial<Watchlist>): Watchlist {
  const now = nowIso();
  return {
    id: w.id || rid("wl"),
    workspaceId: w.workspaceId || "default",
    name: (w.name || "Untitled watchlist").trim(),
    query: (w.query || "").trim(),
    industry: w.industry?.trim() || undefined,
    location: w.location?.trim() || undefined,
    remoteOnly: w.remoteOnly ?? undefined,
    employmentTypes: Array.isArray(w.employmentTypes) && w.employmentTypes.length ? w.employmentTypes : undefined,
    datePosted: w.datePosted || "today",
    limit: clampInt(w.limit, 1, 200, 30),
    minScore: clampInt(w.minScore, 0, 100, 0),
    perPollCompanyCap: clampInt(w.perPollCompanyCap, 1, 500, 25),
    active: w.active ?? true,
    everyMinutes: clampInt(w.everyMinutes, 5, 1440, 15),
    createdAt: w.createdAt || now,
    updatedAt: w.updatedAt || now,
    lastPolledAt: w.lastPolledAt,
    stats: { ...emptyStats(), ...(w.stats || {}) },
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listWatchlists(workspaceId?: string): Promise<Watchlist[]> {
  await hydrate();
  const all = store.slice();
  return workspaceId ? all.filter((w) => w.workspaceId === workspaceId) : all;
}

export async function getWatchlist(id: string): Promise<Watchlist | undefined> {
  await hydrate();
  return store.find((w) => w.id === id);
}

export type WatchlistInput = Partial<Omit<Watchlist, "stats" | "createdAt" | "updatedAt">>;

/** Create (no id) or update (id matches an existing row). Stats/lifecycle are preserved on update. */
export async function upsertWatchlist(workspaceId: string, input: WatchlistInput): Promise<Watchlist> {
  await hydrate();
  return withStoreLock(async () => {
    const now = nowIso();
    const existing = input.id ? store.find((w) => w.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, normalize({ ...existing, ...input, workspaceId: existing.workspaceId }), {
        id: existing.id,
        createdAt: existing.createdAt,
        stats: existing.stats,          // never reset counters on an edit
        updatedAt: now,
      });
      await saveSnapshot(KEY, store);
      return existing;
    }
    const row = normalize({ ...input, workspaceId, id: undefined, stats: emptyStats() });
    store.push(row);
    await saveSnapshot(KEY, store);
    return row;
  });
}

export async function setWatchlistActive(id: string, active: boolean): Promise<boolean> {
  await hydrate();
  return withStoreLock(async () => {
    const w = store.find((x) => x.id === id);
    if (!w) return false;
    w.active = active;
    w.updatedAt = nowIso();
    await saveSnapshot(KEY, store);
    return true;
  });
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  await hydrate();
  return withStoreLock(async () => {
    const i = store.findIndex((x) => x.id === id);
    if (i < 0) return false;
    store.splice(i, 1);
    await saveSnapshot(KEY, store);
    return true;
  });
}

/** Record the outcome of one poll on a list (called by the tick). Always advances lastPolledAt. */
export async function recordPollResult(
  id: string,
  r: { found: number; fresh: number; contactable: number; error?: string },
): Promise<void> {
  await hydrate();
  await withStoreLock(async () => {
    const w = store.find((x) => x.id === id);
    if (!w) return;
    const now = nowIso();
    w.lastPolledAt = now;
    w.stats.polls += 1;
    w.stats.lastFound = r.found;
    w.stats.lastFresh = r.fresh;
    w.stats.lastContactable = r.contactable;
    w.stats.totalFresh += r.fresh;
    w.stats.totalContactable += r.contactable;
    w.stats.lastError = r.error;
    if (r.fresh > 0) w.stats.lastHitAt = now;
    await saveSnapshot(KEY, store);
  });
}

/* ------------------------------------------------------------------ */
/* Cross-poll "seen" set, a company is actioned ONCE                  */
/* ------------------------------------------------------------------ */
/*
 * Keyed by the feed's company id (jobfeed_<slug>), GLOBAL scope. Two reasons it's company-level
 * and global, not per-list: (1) it makes 15-min polling cheap, a company already in Clients is
 * skipped instead of re-researched every quarter hour; (2) it's the right BD hygiene, the same
 * company must not be pitched three times because it matched three watchlists. FIFO-capped like
 * the sourcing seen store so it can't grow without bound.
 */

const SEEN_KEY = "signals_watch_seen_v1";
const SEEN_MAX = 200_000;

let seen: string[] = [];
let seenHydrated = false;
let seenHydrating: Promise<void> | null = null;

async function hydrateSeen(): Promise<void> {
  if (seenHydrated) return;
  if (!seenHydrating) {
    seenHydrating = (async () => {
      const snap = await loadSnapshot<string[]>(SEEN_KEY);
      if (Array.isArray(snap)) seen = snap;
      seenHydrated = true;
    })();
  }
  return seenHydrating;
}

export async function getSeenCompanies(): Promise<Set<string>> {
  await hydrateSeen();
  return new Set(seen);
}

export async function addSeenCompanies(keys: string[]): Promise<void> {
  await hydrateSeen();
  if (!keys.length) return;
  await withStoreLock(async () => {
    const set = new Set(seen);
    let changed = false;
    for (const k of keys) {
      if (k && !set.has(k)) { set.add(k); seen.push(k); changed = true; }
    }
    if (!changed) return;
    if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
    await saveSnapshot(SEEN_KEY, seen);
  });
}

/* ------------------------------------------------------------------ */
/* Daily RapidAPI fetch budget, hard ceiling on feed spend           */
/* ------------------------------------------------------------------ */
/*
 * The paid part of a poll is the JSearch fetch. 15-min polling × many lists can burn calls fast,
 * so every fetch is counted against a per-UTC-day ceiling. When the ceiling is hit the tick stops
 * fetching until the day rolls over, a runaway can't drain the RapidAPI budget. Enrichment
 * (curateFromPool) is free, so it is NOT metered here.
 */

const BUDGET_KEY = "signals_watch_budget_v1";
const DEFAULT_DAILY_CAP = 500;

interface Budget { day: string; used: number }

function dayStamp(iso: string): string {
  return (iso || nowIso()).slice(0, 10); // YYYY-MM-DD (UTC)
}
function dailyCap(): number {
  const n = Number(process.env.SIGNALS_WATCH_DAILY_FETCH_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}

/** Remaining feed fetches allowed today. Reads (and rolls over) the persisted counter. */
export async function fetchBudgetRemaining(todayIso: string): Promise<number> {
  const b = (await loadSnapshot<Budget>(BUDGET_KEY)) || { day: "", used: 0 };
  const today = dayStamp(todayIso);
  const used = b.day === today ? b.used : 0;
  return Math.max(0, dailyCap() - used);
}

/** Reserve `n` fetches for today, returning how many were actually granted (may be fewer near the cap). */
export async function reserveFetches(n: number, todayIso: string): Promise<number> {
  if (n <= 0) return 0;
  return withStoreLock(async () => {
    const today = dayStamp(todayIso);
    const b = (await loadSnapshot<Budget>(BUDGET_KEY)) || { day: today, used: 0 };
    const used = b.day === today ? b.used : 0;
    const grant = Math.max(0, Math.min(n, dailyCap() - used));
    if (grant > 0) await saveSnapshot(BUDGET_KEY, { day: today, used: used + grant });
    return grant;
  });
}

export function dailyFetchCap(): number {
  return dailyCap();
}
