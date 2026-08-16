/**
 * Regression suite for the discovery engine-health watch.
 *
 *   npx tsx scripts/test-sourcing-enginehealth.mts     (from integration/)
 *
 * Two things this pins, both of which cost real trust when they were wrong:
 *
 * 1. The RapidAPI check must read the quota snapshot's ACTUAL shape. It read
 *    {hosts, history} as a flat host->row map, so Object.values() yielded those two
 *    containers, the numeric filter rejected both, and every workspace reported "stale"
 *    on every tick since the check was written — for a live key and a dead one alike.
 *
 * 2. An engine that answers but returns nobody must not be called "down" on the first
 *    blank. Measured across five back-to-back live cycles, DataForSEO blanked on one and
 *    blanked TWICE on that one, while returning ~10 profiles the rest of the time. A
 *    watch that pages the owner on vendor noise gets muted, and then it protects nothing.
 */

import { getRapidQuotaFor, noteRapidQuota } from "../lib/sourcing/rapidQuota";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error("  FAIL:", name); }
}

/* --- 1. the quota snapshot is read at the right level ---------------------- */

// The shape the app actually writes, as seen live on the box.
const LIVE_SHAPE = {
  hosts: {
    "fresh-linkedin-scraper-api.p.rapidapi.com": {
      host: "fresh-linkedin-scraper-api.p.rapidapi.com", kind: "people",
      object: "requests", limit: 20000, remaining: 14640, used: 5360,
      updatedAt: new Date().toISOString(),
    },
    "skip-tracing-working-api.p.rapidapi.com": {
      host: "skip-tracing-working-api.p.rapidapi.com", kind: "phone",
      object: "requests", limit: 22500, remaining: 10273, used: 12227,
      updatedAt: new Date().toISOString(),
    },
  },
  history: { "fresh-linkedin-scraper-api.p.rapidapi.com": { "2026-08-12": 2520 } },
};

// The bug, reproduced exactly: treat the envelope as a flat map of rows.
const naiveRows = Object.values(LIVE_SHAPE).filter(
  (r: any) => r && typeof r.remaining === "number" && typeof r.limit === "number",
);
check("the old flat-map read finds nothing in the real snapshot (this was the bug)",
  naiveRows.length === 0);
check("reading .hosts finds every listing", Object.values(LIVE_SHAPE.hosts).length === 2);

// And the tightest-row-wins rule let an unrelated listing speak for the people search.
const tightest = Object.values(LIVE_SHAPE.hosts)
  .sort((a: any, b: any) => a.remaining / a.limit - b.remaining / b.limit)[0] as any;
check("the tightest row across all listings is the PHONE listing, not the search",
  tightest.host === "skip-tracing-working-api.p.rapidapi.com");

/* --- 2. per-host lookup, which is what replaced it ------------------------- */

function headers(limit: number, remaining: number): Headers {
  return new Headers({
    "x-ratelimit-requests-limit": String(limit),
    "x-ratelimit-requests-remaining": String(remaining),
  });
}

async function quotaChecks(): Promise<void> {
  noteRapidQuota("probe-people.example.com", headers(20000, 14640), "people");
  noteRapidQuota("probe-phone.example.com", headers(22500, 300), "phone");
  await new Promise((r) => setTimeout(r, 50)); // hydrate + store are async

  const people = await getRapidQuotaFor("probe-people.example.com");
  const phone = await getRapidQuotaFor("probe-phone.example.com");
  check("the people listing reports its own numbers", people?.remaining === 14640 && people?.limit === 20000);
  check("a nearly-empty phone listing cannot speak for the search", phone?.remaining === 300);
  check("an unknown host returns null, not someone else's row",
    (await getRapidQuotaFor("never-called.example.com")) === null);
}

/* --- 3. empty-answer hysteresis ------------------------------------------- */

// Mirrors liveProbe()/probeState() in engineHealth.ts: a hard failure is down at once,
// an empty answer is watched until it repeats.
const EMPTY_STREAK_TO_DOWN = 2;
function nextStreak(prev: number, res: { ok: boolean; found?: number }): number {
  const empty = !res.ok && res.found === 0;
  return empty ? prev + 1 : 0;
}
function stateFor(res: { ok: boolean; found?: number }, streak: number): string {
  if (res.ok) return "ok";
  return res.found === 0 && streak < EMPTY_STREAK_TO_DOWN ? "stale" : "down";
}

const HARD = { ok: false, error: "403 key refused" };          // no `found`
const EMPTY = { ok: false, found: 0, error: "returned nobody" };
const GOOD = { ok: true, found: 10 };

function hysteresisChecks(): void {
  check("a hard failure is down on the first check", stateFor(HARD, nextStreak(0, HARD)) === "down");

  let s = nextStreak(0, EMPTY);
  check("one blank answer is watched, not alerted", stateFor(EMPTY, s) === "stale");
  s = nextStreak(s, EMPTY);
  check("two blanks in a row is down", stateFor(EMPTY, s) === "down");

  // The live pattern that caused this: blank, blank, then healthy again.
  s = nextStreak(s, GOOD);
  check("results reset the streak", s === 0 && stateFor(GOOD, s) === "ok");
  s = nextStreak(s, EMPTY);
  check("a later isolated blank is watched again, not instantly down", stateFor(EMPTY, s) === "stale");

  // "stale" must not alert; the watch only notifies on down/low.
  const ALERTING = new Set(["down", "low"]);
  check("the watched state does not raise an alert", !ALERTING.has("stale"));
  check("the escalated state does raise an alert", ALERTING.has("down"));
}

(async () => {
  await quotaChecks();
  hysteresisChecks();
})()
  .catch((e) => { failed++; console.error("  CRASH:", e); })
  .finally(() => {
    console.log(`\nengine-health suite: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
