/**
 * Overnight-queue lifecycle regression suite.
 * Run from integration/:  npx tsx scripts/test-sourcing-nightqueue.mts
 *
 * Pins the rules that keep the queue a WORKING queue that never wedges:
 *  - pruneDecision: done items linger, then clear once delivered (autoflow.sentAt),
 *    undelivered items clear after a day, error/active items are never pruned,
 *    bad timestamps never cause a drop.
 *  - tick latch constants: the steal window exists and is meaningfully shorter
 *    than the host watchdog's stall window (code heals before the big hammer).
 */
import { pruneDecision, boostEntryStage, DONE_LINGER_MS, DONE_MAX_MS } from "../lib/sourcing/nightQueue";

let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { createdAt: ago(3 * 60 * 60 * 1000), updatedAt: ago(2 * 60 * 60 * 1000) };

// ---- fresh done items linger, whatever the delivery state ----
check("done 5min ago, delivered: keeps (linger)",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(5 * 60 * 1000) }, true, NOW) === "keep");
check("done 5min ago, undelivered: keeps (linger)",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(5 * 60 * 1000) }, false, NOW) === "keep");
check("done exactly at linger boundary: keeps (boundary is inclusive)",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(DONE_LINGER_MS) }, true, NOW) === "keep");

// ---- past linger: delivery decides ----
check("done 2h ago, delivered: drops",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(2 * 60 * 60 * 1000) }, true, NOW) === "drop");
check("done 2h ago, undelivered: keeps (delivery may still be sweeping)",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(2 * 60 * 60 * 1000) }, false, NOW) === "keep");

// ---- the day-old fallback clears even undelivered items ----
check("done 25h ago, undelivered: drops (day-old fallback)",
  pruneDecision({ ...base, stage: "done", finishedAt: ago(DONE_MAX_MS + 60 * 60 * 1000) }, false, NOW) === "drop");

// ---- non-done stages are untouchable, however old ----
for (const stage of ["queued", "search", "kold", "koldDb", "laxis", "boost", "error"] as const) {
  check(`stage "${stage}" 3 days old: keeps (never pruned)`,
    pruneDecision({ createdAt: ago(3 * DONE_MAX_MS), updatedAt: ago(3 * DONE_MAX_MS), stage }, true, NOW) === "keep");
}

// ---- timestamp fallbacks and bad data ----
check("done, no finishedAt: falls back to updatedAt (2h ago, delivered -> drops)",
  pruneDecision({ ...base, stage: "done" }, true, NOW) === "drop");
check("done, unparseable timestamps: keeps (never drop on bad data)",
  pruneDecision({ stage: "done", finishedAt: "not-a-date", updatedAt: "also-bad", createdAt: "nope" }, true, NOW) === "keep");

// ---- the guardrail ladder must stay ordered: item linger (1h) < undelivered
// fallback (24h), and the in-code latch steal must fire well before the host
// watchdog's 45-min stall restart, so the cheap heal always gets first try. ----
check("linger < day-old fallback", DONE_LINGER_MS < DONE_MAX_MS);
const nightQueueSrc = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../lib/sourcing/nightQueue.ts", import.meta.url), "utf8"));
const steal = nightQueueSrc.match(/TICK_STEAL_MS = (\d+) \* 60 \* 1000/);
check("tick latch steal window exists in source", Boolean(steal));
check("latch steal (code) fires before the 45-min host watchdog restart",
  Boolean(steal) && Number(steal![1]) < 45);
check("latch clears in a finally block (queue can never freeze on a save throw)",
  /finally\s*\{[\s\S]{0,400}ticking = false/.test(nightQueueSrc));

// ---- boost items enter the machine at the right rung (enrich-first rules):
// resume what is parked, finish an unfinished chain, run the whole free chain on
// a never-enriched list, and only a provably finished chain goes straight to
// buying. A wrong entry either re-spends vendor tokens or buys rows the free
// rungs would have filled. ----
const job = { jobId: "j1", submittedAt: ago(60 * 1000), count: 5 } as any;
const ledger = (nextStart: number | null) =>
  ({ doneOffsets: [0], total: 400, nextStart, updatedAt: ago(60 * 1000) }) as any;
check('boost entry: parked KoldInfo job resumes at "kold"',
  boostEntryStage({ koldJob: job }) === "kold");
check('boost entry: parked KoldInfo-DB job resumes at "koldDb"',
  boostEntryStage({ koldDbJob: job }) === "koldDb");
check('boost entry: parked Laxis job resumes at "laxis"',
  boostEntryStage({ laxisJob: job }) === "laxis");
check('boost entry: unfinished chunk ledger re-enters the final pass',
  boostEntryStage({ laxisProgress: ledger(200) }) === "laxis");
check("boost entry: never-enriched list runs the whole free chain first",
  boostEntryStage({}) === "kold");
check("boost entry: fully enriched list goes straight to buying",
  boostEntryStage({ laxisProgress: ledger(null) }) === "boost");
check("boost entry: delivered list with no chunk ledger (old runs) goes straight to buying",
  boostEntryStage({ autoflow: { sentAt: ago(60 * 1000) } as any }) === "boost");
check("boost entry: promoted-only evidence also counts as enriched",
  boostEntryStage({ promotedCount: 12 }) === "boost");
check("boost entry: a parked job wins over a finished ledger (resume beats buy)",
  boostEntryStage({ koldJob: job, laxisProgress: ledger(null) }) === "kold");

// ---- boost stage source guarantees: what keeps queued spending safe ----
check("boost stage: counters persist every batch (a crash cannot forget bought rows)",
  /boost\.costUsd = [\s\S]{0,600}?await save\(\)/.test(nightQueueSrc));
check("boost stage: a held recruiter lock waits instead of failing the item",
  /already in progress[\s\S]{0,300}?touch\(item/.test(nightQueueSrc));
check("boost stage: batches never exceed 20 rows",
  /max: Math\.min\(20, remainingWanted\)/.test(nightQueueSrc));
check("boost stage: budget stop finishes done with a readout; config errors finish as error",
  /budgetExhausted[\s\S]{0,300}?finishBoost/.test(nightQueueSrc) &&
  /stoppedEarly[\s\S]{0,700}?finish\(item, "error"/.test(nightQueueSrc));
check("boost stage: a no-progress batch bails instead of spinning",
  /made no progress/.test(nightQueueSrc));
check("boost stage: the in-tick batch loop yields well before the latch-steal window",
  /deadline = Date\.now\(\) \+ 3 \* 60 \* 1000/.test(nightQueueSrc) && Boolean(steal) && 3 < Number(steal![1]));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
