/**
 * Autoflow decision logic: regression suite.
 * Run: npx tsx lib/sourcing/autoflow.test.ts   (exits non-zero on failure)
 *
 * Pins THE PARITY GUARANTEE (2026-07-20): everything JD Sourcing holds flows to
 * Candidates + OS Text, with nothing stranded by the fresh-window sweeper's
 * scope guards. Born from three real stranding paths:
 *   1) lists idle past FRESH_MS (pre-autoflow era, or aged-out failures) were
 *      skipped forever;
 *   2) runs parked by MAX_ATTEMPTS never retried;
 *   3) a Sales Nav merge wipes laxisProgress to re-open the chain — if the
 *      driving tab died right then, no sweeper branch restarted enrichment for
 *      a ledger-less run, so the new rows never got phones or an OS Text push.
 */

import { due, parityDue } from "./autoflow";
import type { SourcingRun } from "./types";

const NOW = Date.parse("2026-07-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

function run(over: Partial<SourcingRun>): SourcingRun {
  return {
    id: "r1", workspaceId: "ws1", name: "Test list", motion: "recruiting",
    jd: "", icp: { label: "", titles: [], geos: [], mustHave: [], niceToHave: [] } as SourcingRun["icp"],
    queries: [], candidates: [], warnings: [],
    createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

const cand = (o: Record<string, unknown> = {}) =>
  ({ fullName: "Pat Doe", ...o }) as SourcingRun["candidates"][number];
const enriched = () => cand({ email: "p@x.com", phone: "+15551230000" });

/* --- fresh-window lane: chain state without a ledger ----------------------- */

// Never-started chain with unenriched rows: PARITY FIRST — deliver what it has
// now AND queue the chain-finishing resume in the same tick (top-up sends the
// rest later). Previously such runs force-sent unenriched with no resume at all.
check("unsent ledger-less run with enrichable rows, idle 46min -> resume-send",
  due(run({ candidates: [cand()], updatedAt: new Date(NOW - 46 * MIN).toISOString() }), NOW), "resume-send");

// With the resume already queued (send leg must have failed), keep sending.
check("...same run, resume already queued -> send",
  due(run({
    candidates: [cand()], updatedAt: new Date(NOW - 46 * MIN).toISOString(),
    autoflow: { phonesAtSend: 0, attempts: 0, resumedAt: new Date(NOW - 5 * MIN).toISOString() },
  }), NOW), "send");

// Orphaned in-flight chain (job refs untouched past STUCK_MS) on a NEVER-SENT
// list: parity first — resume the chain AND send now, not after a grace window.
const stuckJobs = { laxisJob: { jobId: "j1", submittedAt: new Date(NOW - 2 * HOUR).toISOString(), count: 10 } as never };
check("unsent list with jobs stuck 61min -> resume-send",
  due(run({ ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 61 * MIN).toISOString() }), NOW), "resume-send");
check("...same but resume already queued -> send (no 2h grace)",
  due(run({
    ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 61 * MIN).toISOString(),
    autoflow: { phonesAtSend: 0, attempts: 0, resumedAt: new Date(NOW - 10 * MIN).toISOString() },
  }), NOW), "send");
// A SENT list with an orphaned chain still gets the chain finished server-side:
// with first-sight delivery every list is sent almost immediately, and top-up
// only fires on finds — a dead chain finds nothing, so it must be resumed.
check("...same but already SENT -> resume (dead chain would never top up)",
  due(run({
    ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 61 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - HOUR).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), "resume");
check("...sent + stuck but resume already queued -> no action",
  due(run({
    ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 61 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - HOUR).toISOString(), phonesAtSend: 1, attempts: 1, resumedAt: new Date(NOW - 10 * MIN).toISOString() },
  }), NOW), null);
// FIRST-SIGHT DELIVERY (2026-07-21): a healthy live chain no longer delays the
// FIRST send — the list ships now and enrichment finds ride the top-up rule.
check("...same but jobs only 30min stale and never sent -> send (first sight)",
  due(run({ ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 30 * MIN).toISOString() }), NOW), "send");
check("...healthy in-flight chain on an already-SENT list -> no action",
  due(run({
    ...stuckJobs, candidates: [enriched(), cand()], updatedAt: new Date(NOW - 30 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - HOUR).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), null);

// Fully-enriched ledger-less run (e.g. born of a merge of enriched lists):
// nothing left to enrich, so it sends without a resume detour.
check("unsent ledger-less run, every row enriched, settled 6min -> send",
  due(run({ candidates: [enriched()], updatedAt: new Date(NOW - 6 * MIN).toISOString() }), NOW), "send");

// FIRST-SIGHT DELIVERY: a brand-new never-sent list sends on the very next
// sweep — no settle, no idle wait. The chain (live tab) keeps enriching and
// tops the campaign up; the resume decision keeps its own IDLE_MS clock so the
// night queue never double-drives a chain a live tab is about to continue.
check("unsent run saved 1min ago, chain not started -> send (first sight, no resume yet)",
  due(run({ candidates: [enriched(), cand()], updatedAt: new Date(NOW - 1 * MIN).toISOString() }), NOW), "send");

// SENT list that a Sales Nav merge just reopened (ledger wiped, resumedAt
// cleared by the merge handler), tab died: sweeper queues the resume (gap 3).
check("sent list reopened by merge (ledger wiped), settled 6min -> resume",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 6 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - 2 * DAY).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), "resume");

// The one-resume rule still holds: with resumedAt present, no resume loop.
check("...same but resumedAt already stamped -> no action",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 6 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - 2 * DAY).toISOString(), phonesAtSend: 1, attempts: 1, resumedAt: new Date(NOW - 5 * MIN).toISOString() },
  }), NOW), null);

// Top-up is untouched: more phones than at send -> topup.
check("sent list, enrichment later found a phone -> topup",
  due(run({
    candidates: [enriched(), enriched()],
    updatedAt: new Date(NOW - 6 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - 2 * DAY).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), "topup");

// ...but debounced: a send 2 minutes ago waits for the live Boost/gap-fill run
// to accumulate more finds instead of re-pushing the whole list every tick.
check("sent 2 min ago, one more phone found -> wait out the debounce",
  due(run({
    candidates: [enriched(), enriched()],
    updatedAt: new Date(NOW - 1 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - 2 * MIN).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), null);

// NEW PEOPLE top up too (2026-07-21): a Sales Nav / pasted-search merge can add
// people who hold no phone yet — they still belong in Candidates. Phones equal,
// people grew -> topup (after the same debounce).
check("sent list, merge added a phoneless person -> topup",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 6 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 2, nextStart: null, updatedAt: new Date(NOW - 6 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 2 * DAY).toISOString(), phonesAtSend: 1, peopleAtSend: 1, attempts: 1 },
  }), NOW), "topup");
check("...same but sent 2 min ago -> wait out the debounce",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 1 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 2, nextStart: null, updatedAt: new Date(NOW - 1 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 2 * MIN).toISOString(), phonesAtSend: 1, peopleAtSend: 1, attempts: 1 },
  }), NOW), null);
// Stamps written before peopleAtSend existed fall back to the phones-only
// trigger: people growth alone must NOT re-send every pre-existing list once
// this deploys.
check("old stamp without peopleAtSend, people grew, phones didn't -> no topup",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 6 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 2, nextStart: null, updatedAt: new Date(NOW - 6 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 2 * DAY).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), null);

// ostext_not_connected self-heal (2026-07-20 Lume incident): a FRESH sent list
// stamped not-connected retries through the fresh lane. The tick loop gates the
// actual send on ostextConfiguredFor(ws), so returning ostext-retry while the
// workspace is still unconnected costs one cheap check, never a send loop.
check("fresh sent list stamped ostext_not_connected, holds phones -> ostext-retry",
  due(run({
    candidates: [enriched()],
    updatedAt: new Date(NOW - 20 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 1, nextStart: null, updatedAt: new Date(NOW - 20 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 20 * MIN).toISOString(), phonesAtSend: 1, attempts: 1, error: "ostext_not_connected: sent to Candidates only" },
  }), NOW), "ostext-retry");

// ...but a phoneless list has nothing to retry with (top-up covers it later).
check("...same but zero phones -> no action",
  due(run({
    candidates: [cand({ email: "p@x.com" })],
    updatedAt: new Date(NOW - 20 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 1, nextStart: null, updatedAt: new Date(NOW - 20 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 20 * MIN).toISOString(), phonesAtSend: 0, attempts: 1, error: "ostext_not_connected: sent to Candidates only" },
  }), NOW), null);

// ...and the unfinished-chain resume still runs first (retry fires next sweep,
// once resumedAt is stamped).
check("...same with unfinished chain and no resume yet -> resume wins",
  due(run({
    candidates: [enriched(), cand()],
    updatedAt: new Date(NOW - 20 * MIN).toISOString(),
    autoflow: { sentAt: new Date(NOW - 20 * MIN).toISOString(), phonesAtSend: 1, attempts: 1, error: "ostext_not_connected: sent to Candidates only" },
  }), NOW), "resume");

// ...top-up outranks the retry: new phones re-send anyway, one send not two.
check("...same but phones grew after send -> topup",
  due(run({
    candidates: [enriched(), enriched()],
    updatedAt: new Date(NOW - 20 * MIN).toISOString(),
    laxisProgress: { doneOffsets: [0], total: 2, nextStart: null, updatedAt: new Date(NOW - 20 * MIN).toISOString() } as SourcingRun["laxisProgress"],
    autoflow: { sentAt: new Date(NOW - 20 * MIN).toISOString(), phonesAtSend: 1, attempts: 1, error: "ostext_not_connected: sent to Candidates only" },
  }), NOW), "topup");

// BD lists still never ride to OS Text.
check("bd-motion run -> no action",
  due(run({ motion: "bd", candidates: [enriched()] }), NOW), null);

/* --- parity lane: what the fresh-window lane won't touch ------------------- */

// Gap 1: a never-sent recruiting list idle past FRESH_MS is parity-due.
check("never-sent list idle 30 days -> parity due",
  parityDue(run({ candidates: [enriched()], updatedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW), true);

// A stale list already fully sent is in parity: leave it alone.
check("sent list idle 30 days, phones unchanged -> not parity due",
  parityDue(run({
    candidates: [enriched()], updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    autoflow: { sentAt: new Date(NOW - 30 * DAY).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), false);

// A stale sent list whose rows hold phones OS Text never got is parity-due.
check("sent list idle 30 days, phones grew after send -> parity due",
  parityDue(run({
    candidates: [enriched(), enriched()], updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    autoflow: { sentAt: new Date(NOW - 30 * DAY).toISOString(), phonesAtSend: 1, attempts: 1 },
  }), NOW), true);

// ...and one whose PEOPLE grew (phoneless merge adds) is parity-due too.
check("sent list idle 30 days, people grew after send -> parity due",
  parityDue(run({
    candidates: [enriched(), cand()], updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    autoflow: { sentAt: new Date(NOW - 30 * DAY).toISOString(), phonesAtSend: 1, peopleAtSend: 1, attempts: 1 },
  }), NOW), true);

// Gap 2: MAX_ATTEMPTS-parked runs re-enter through the parity lane...
check("fresh but parked at 20 attempts -> parity due",
  parityDue(run({ candidates: [enriched()], autoflow: { phonesAtSend: 0, attempts: 20 } }), NOW), true);

// ...but at most once per day.
check("...parked run parity-tried 2h ago -> not parity due",
  parityDue(run({
    candidates: [enriched()],
    autoflow: { phonesAtSend: 0, attempts: 20, parityAt: new Date(NOW - 2 * HOUR).toISOString() },
  }), NOW), false);

// Fresh unparked runs belong to the fresh-window lane, not parity.
check("fresh never-sent run -> not parity due (fresh lane owns it)",
  parityDue(run({ candidates: [enriched()] }), NOW), false);

// BD and empty lists never parity-flow.
check("stale bd list -> not parity due",
  parityDue(run({ motion: "bd", candidates: [enriched()], updatedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW), false);
check("stale empty list -> not parity due",
  parityDue(run({ updatedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW), false);

// ostext_not_connected healing reaches stale lists too.
check("stale sent-with-ostext_not_connected list holding phones -> parity due",
  parityDue(run({
    candidates: [enriched()], updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    autoflow: { sentAt: new Date(NOW - 30 * DAY).toISOString(), phonesAtSend: 1, attempts: 1, error: "ostext_not_connected: sent to Candidates only" },
  }), NOW), true);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall green");
