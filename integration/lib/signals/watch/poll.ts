/**
 * RecruitersOS · Signal Watchlists · the poll tick
 *
 * The front of the belt. A scheduler hits /api/signals/watch every ~15 min; that fires
 * tickWatchlists(), which for every DUE active list:
 *
 *   previewJobFeed(query)         real hiring companies from JSearch (paid, budget-metered)
 *   -> drop companies already seen  only genuinely-new signals survive (BD hygiene: pitch once)
 *   -> curateFromPool(fresh)        3 decision-makers/company -> Clients tab   [free enrichment]
 *   -> mark seen + record stats
 *
 * From there the EXISTING timers carry each signal the rest of the way (autofill -> enroll ->
 * first email + PiP video -> prospectReadiness -> Send Queue -> send). This tick optionally kicks
 * runAutofill so a hot signal doesn't idle waiting for the next 5-min autofill cycle.
 *
 * WHY the HTTP route, not the in-process scheduler: instrumentation.ts is a separate bundle whose
 * modules get their own instances, so a tick run there would hold a stale copy of the watchlist
 * store and clobber UI-created lists on save (the exact trap the JD Sourcing night queue documents).
 * Ticking through the request module graph keeps the tick and the CRUD route on ONE store instance.
 *
 * Stability guarantees:
 *  - single-flight tick mutex + a PER-LIST in-flight guard, so an overlapping timer hit or a manual
 *    "Run now" on a list already being polled is a no-op instead of a double fetch/curate/seen race;
 *  - a per-tick work ceiling + oldest-first ordering, so a tick can't run for many minutes and
 *    starve the timer, and every list gets a fair turn;
 *  - a per-day feed-fetch budget (spend cap) with a one-shot retry on a transient fetch blip;
 *  - a company is marked "seen" only AFTER its curate succeeds, so a failed poll retries cleanly;
 *  - a persisted heartbeat (lastTickAt / errors) a watchdog can read to detect a dead or sick tick.
 */

import { nowIso } from "../../core/ids";
import { previewJobFeed, jobFeedEnabled } from "../../inmarket/jobFeed";
import { curateFromPool } from "../../inmarket/curation";
import type { InMarketLead } from "../../inmarket";
import {
  listWatchlists, getWatchlist, recordPollResult,
  getSeenCompanies, addSeenCompanies, reserveFetches, fetchBudgetRemaining, recordTickHealth,
  type Watchlist,
} from "./store";

const JOBS_PER_PAGE = 10; // JSearch bills ~per page; a poll reserves ceil(limit/10) fetches

export interface PollOutcome {
  id: string;
  name: string;
  found: number;        // companies the feed returned
  fresh: number;        // net-new companies handed to curation
  contactable: number;  // contactable decision-makers curated
  skipped?: string;     // reason this list did no work (busy / no budget / feed off)
  error?: string;
}

/** The JSearch keyword string: Job Title + Industry combined (either may be blank, not both). */
function effectiveQuery(w: Watchlist): string {
  return [w.query, w.industry].map((s) => (s || "").trim()).filter(Boolean).join(" ").trim();
}

function isDue(w: Watchlist, now: number): boolean {
  if (!w.active) return false;
  if (!effectiveQuery(w)) return false;   // nothing to search on
  if (!w.lastPolledAt) return true;
  const last = Date.parse(w.lastPolledAt) || 0;
  return now - last >= w.everyMinutes * 60_000;
}

/**
 * PER-LIST in-flight guard. The tick is single-flight, but the manual "Run now" button
 * (pollWatchlistNow) bypasses that mutex, so without this a click during a tick could poll the same
 * list twice at once and both would fetch + curate before either marked the company seen. This set
 * makes the second caller a no-op.
 */
const inFlight = new Set<string>();

/** One quick retry on a transient feed blip, so a momentary hiccup doesn't cost a whole cadence. */
async function fetchLeads(w: Watchlist): Promise<InMarketLead[]> {
  const opts = {
    query: effectiveQuery(w),
    location: w.location,
    datePosted: w.datePosted,
    employmentTypes: w.employmentTypes,
    remoteOnly: w.remoteOnly,
    limit: w.limit ?? 30,
  };
  try {
    return (await previewJobFeed(opts)).leads;
  } catch (e1) {
    try {
      return (await previewJobFeed(opts)).leads;
    } catch (e2) {
      throw e2 instanceof Error ? e2 : new Error(String(e2));
    }
  }
}

/**
 * Run one watchlist: fetch -> dedupe -> curate -> mark seen -> record. Returns an outcome either
 * way; throws only on a truly unexpected fault (the tick catches it). Guarded so the same list is
 * never polled concurrently.
 */
export async function pollOne(w: Watchlist, todayIso: string): Promise<PollOutcome> {
  const base: PollOutcome = { id: w.id, name: w.name, found: 0, fresh: 0, contactable: 0 };

  if (inFlight.has(w.id)) return { ...base, skipped: "busy" };
  inFlight.add(w.id);
  try {
    if (!jobFeedEnabled()) {
      await recordPollResult(w.id, { found: 0, fresh: 0, contactable: 0, error: "job feed not configured (RAPID_JOBS_KEY/HOST)" });
      return { ...base, skipped: "feed_off" };
    }

    // Reserve the paid fetches for this poll against the daily ceiling.
    const pages = Math.max(1, Math.ceil((w.limit ?? 30) / JOBS_PER_PAGE));
    const granted = await reserveFetches(pages, todayIso);
    if (granted <= 0) {
      await recordPollResult(w.id, { found: 0, fresh: 0, contactable: 0, error: "daily feed budget reached" });
      return { ...base, skipped: "no_budget" };
    }

    // 1) Pull real postings for this target audience (pure, no side effects, no pool write).
    let leads: InMarketLead[] = [];
    try {
      leads = await fetchLeads(w);
    } catch (e) {
      const error = (e as Error)?.message?.slice(0, 160) || "feed fetch failed";
      await recordPollResult(w.id, { found: 0, fresh: 0, contactable: 0, error });
      return { ...base, error };
    }

    // 2) Keep only companies we've never actioned (global, company-level: pitch a company once).
    const seenSet = await getSeenCompanies();
    const minScore = w.minScore ?? 0;
    const fresh = leads
      .filter((l) => l.company && l.id && (l.score ?? 0) >= minScore && !seenSet.has(l.id))
      .slice(0, w.perPollCompanyCap ?? 25);

    if (!fresh.length) {
      await recordPollResult(w.id, { found: leads.length, fresh: 0, contactable: 0 });
      return { ...base, found: leads.length };
    }

    // 3) Enrich 3 decision-makers per company and write them to the Clients-tab curation store.
    //    curateFromPool is idempotent + free; InMarketLead is a structural superset of its input.
    let contactable = 0;
    try {
      const report = await curateFromPool(fresh, {
        limit: fresh.length,
        concurrency: 4,
        minScore,
        nowIso: todayIso,
      });
      contactable = report.contactable;
    } catch (e) {
      // Curate failed for the whole batch, do NOT mark seen, so the next tick retries these.
      const error = (e as Error)?.message?.slice(0, 160) || "curation failed";
      await recordPollResult(w.id, { found: leads.length, fresh: 0, contactable: 0, error });
      return { ...base, found: leads.length, error };
    }

    // 4) Only now mark them seen, a company that made it into curation won't be re-actioned.
    await addSeenCompanies(fresh.map((l) => l.id));
    await recordPollResult(w.id, { found: leads.length, fresh: fresh.length, contactable });
    return { ...base, found: leads.length, fresh: fresh.length, contactable };
  } finally {
    inFlight.delete(w.id);
  }
}

let ticking = false;

export interface TickSummary {
  ran: boolean;            // false when a tick was already in flight
  due: number;
  polled: number;
  freshTotal: number;
  contactableTotal: number;
  budgetRemaining: number;
  outcomes: PollOutcome[];
}

/** Bound how many companies one tick may curate, so a tick stays short and the timer never starves. */
function maxCuratePerTick(): number {
  const n = Number(process.env.SIGNALS_WATCH_MAX_CURATE_PER_TICK);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

/**
 * Advance every DUE active watchlist one poll, oldest-waiting first. Single-flight (overlapping
 * timer hits are no-ops). Long work runs inside the tick, so the HTTP caller should fire-and-forget.
 */
export async function tickWatchlists(): Promise<TickSummary> {
  const today = nowIso();
  const empty: TickSummary = { ran: false, due: 0, polled: 0, freshTotal: 0, contactableTotal: 0, budgetRemaining: await fetchBudgetRemaining(today), outcomes: [] };
  if (ticking) return empty;
  ticking = true;
  const startedMs = Date.parse(today) || 0;
  try {
    const now = Date.now();
    const all = await listWatchlists();
    // Oldest-waiting first, so no list can be perpetually starved by busier ones ahead of it.
    const due = all
      .filter((w) => isDue(w, now))
      .sort((a, b) => (Date.parse(a.lastPolledAt || "") || 0) - (Date.parse(b.lastPolledAt || "") || 0));
    const maxLists = Math.max(1, Number(process.env.SIGNALS_WATCH_MAX_LISTS_PER_TICK) || 50);
    const curateCap = maxCuratePerTick();

    const outcomes: PollOutcome[] = [];
    let curatedThisTick = 0;
    for (const w of due) {
      if (outcomes.length >= maxLists) break;               // list-count ceiling
      if (curatedThisTick >= curateCap) break;              // work ceiling: leave the rest due for next tick
      try {
        const o = await pollOne(w, today);
        outcomes.push(o);
        curatedThisTick += o.fresh;
      } catch (e) {
        outcomes.push({ id: w.id, name: w.name, found: 0, fresh: 0, contactable: 0, error: (e as Error)?.message?.slice(0, 160) || "poll crashed" });
      }
    }

    const freshTotal = outcomes.reduce((s, o) => s + o.fresh, 0);
    const contactableTotal = outcomes.reduce((s, o) => s + o.contactable, 0);
    const errors = outcomes.filter((o) => o.error).length;

    // Kick the existing send-queue autofill so freshly-curated contactable rows enroll now, rather
    // than waiting up to 5 min for the next autofill cycle. Best-effort: never let it fault the tick.
    if (freshTotal > 0 && process.env.SIGNALS_WATCH_KICK_AUTOFILL !== "0" && !autofillKicking) {
      autofillKicking = true;
      try {
        const { runAutofill } = await import("../../sending/autofill");
        await runAutofill(today).catch(() => {});
      } catch { /* autofill not wired / not applicable, the 5-min timer will pick it up */ }
      finally { autofillKicking = false; }
    }

    // Heartbeat: a tick counts as "errored" only if it did work and EVERYTHING errored (a real
    // outage), not when it simply had nothing due or every list was cleanly up to date.
    const errored = outcomes.length > 0 && errors === outcomes.length;
    await recordTickHealth({
      lastTickAt: nowIso(),
      lastTickMs: Math.max(0, Date.now() - startedMs),
      lastDue: due.length,
      lastPolled: outcomes.length,
      lastFreshTotal: freshTotal,
      errored,
      lastError: errored ? (outcomes.find((o) => o.error)?.error || "all polls failed") : undefined,
    });

    return {
      ran: true,
      due: due.length,
      polled: outcomes.length,
      freshTotal,
      contactableTotal,
      budgetRemaining: await fetchBudgetRemaining(today),
      outcomes,
    };
  } catch (e) {
    // A fault in the tick machinery itself (not a per-list error) still updates the heartbeat, so a
    // watchdog sees a sick tick rather than a silent one.
    await recordTickHealth({ lastTickAt: nowIso(), lastTickMs: Math.max(0, Date.now() - startedMs), errored: true, lastError: (e as Error)?.message?.slice(0, 160) || "tick crashed" }).catch(() => {});
    throw e;
  } finally {
    ticking = false;
  }
}

/** Guard so the autofill kick can't be fired by two overlapping ticks at once. */
let autofillKicking = false;

/** Run a single list immediately regardless of its cadence (the UI "Run now" / test button). */
export async function pollWatchlistNow(id: string): Promise<PollOutcome | null> {
  const w = await getWatchlist(id);
  if (!w) return null;
  return pollOne(w, nowIso());
}
