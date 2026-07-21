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
import { pruneDecision, DONE_LINGER_MS, DONE_MAX_MS } from "../lib/sourcing/nightQueue";

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
for (const stage of ["queued", "search", "kold", "koldDb", "laxis", "error"] as const) {
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
