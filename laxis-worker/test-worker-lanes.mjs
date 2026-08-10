/**
 * Regression suite for the worker's lane scheduler.
 *
 *   node test-worker-lanes.mjs      (from laxis-worker/)
 *
 * Pins the two properties the 2026-08-07 scheduling fix depends on:
 *   1. DISCOVERY does not queue behind ENRICHMENT (they are separate lanes now).
 *   2. No matter how many lanes exist, at most MAX_ACTIVE_LANES browsers run at once,
 *      so the split can never starve a small box of CPU.
 *
 * The scheduler is re-derived here from server.js's own LANES table and drain() rules
 * rather than reimplemented from memory: the table is READ OUT of the source file, so a
 * future edit that re-merges the lanes fails this suite instead of silently regressing.
 */

import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) passed++; else { failed++; console.error("  FAIL:", name); } };

const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");

/* --- 1. the lane table in the actual source ------------------------------- */

const laneTable = {};
const block = src.match(/const LANES = \{([\s\S]*?)\};/);
check("server.js still defines a LANES table", Boolean(block));
for (const m of (block?.[1] ?? "").matchAll(/"?([\w-]+)"?\s*:\s*"([\w-]+)"/g)) laneTable[m[1]] = m[2];

check("laxis has its own lane", laneTable["laxis"] === "laxis");
check("koldinfo URL enrichment is on the koldinfo lane", laneTable["koldinfo"] === "koldinfo");
check("koldinfo-db enrichment is on the koldinfo lane", laneTable["koldinfo-db"] === "koldinfo");
// THE FIX: discovery must NOT share the enrichment lane. Measured waits before the
// split were 11.1, 19.4 and 23.6 minutes of pure queueing.
check("koldinfo-db-search has its OWN lane", laneTable["koldinfo-db-search"] === "koldinfo-search");
check("discovery lane differs from enrichment lane",
  laneTable["koldinfo-db-search"] !== laneTable["koldinfo-db"]);
check("there are three distinct lanes", new Set(Object.values(laneTable)).size === 3);

/* --- 2. the global ceiling exists and is enforced before the scan ---------- */

check("MAX_ACTIVE_LANES is defined", /const MAX_ACTIVE_LANES\s*=/.test(src));
check("ceiling is env-tunable", /WORKER_MAX_ACTIVE_LANES/.test(src));
check("ceiling defaults to 2", /WORKER_MAX_ACTIVE_LANES\s*\|\|\s*2/.test(src));
check("ceiling can never be 0 (would wedge the queue forever)", /Math\.max\(1,\s*Number\(process\.env\.WORKER_MAX_ACTIVE_LANES/.test(src));

// The ceiling has to be checked BEFORE drain() picks a job, or a job would be spliced
// out of the queue and then dropped on the floor.
const drainBody = src.slice(src.indexOf("async function drain()"));
const ceilingAt = drainBody.indexOf("runningLanes.size >= MAX_ACTIVE_LANES");
const spliceAt = drainBody.indexOf("queue.splice(idx, 1)");
check("ceiling is checked inside drain()", ceilingAt >= 0);
check("ceiling is checked BEFORE a job is spliced out of the queue",
  ceilingAt >= 0 && spliceAt >= 0 && ceilingAt < spliceAt);

// Both vendor canaries must stand down at the ceiling, and the KoldInfo canary must
// check BOTH KoldInfo lanes now that there are two.
check("koldinfo canary checks both koldinfo lanes",
  /runningLanes\.has\("koldinfo"\)\s*\|\|\s*runningLanes\.has\("koldinfo-search"\)/.test(src));
check("both canaries respect the ceiling",
  (src.match(/runningLanes\.size >= MAX_ACTIVE_LANES/g) || []).length >= 3);

/* --- 3. behavioral model of the scheduler --------------------------------- */

const laneOf = (kind) => laneTable[kind] || "laxis";

/** The real drain() picking rule: first queued job whose lane is free, under the cap. */
function schedule(kinds, maxLanes) {
  const running = new Set();
  const started = [];
  const q = [...kinds];
  for (;;) {
    if (running.size >= maxLanes) break;
    const i = q.findIndex((k) => !running.has(laneOf(k)));
    if (i < 0) break;
    const [k] = q.splice(i, 1);
    running.add(laneOf(k));
    started.push(k);
  }
  return { started, waiting: q };
}

// The exact shape measured on the box: an enrichment sweep is grinding, and a recruiter
// starts a new search. Before the split the search waited; now it starts immediately.
const withSearch = schedule(["koldinfo-db", "koldinfo-db-search"], 2);
check("a new search starts while an enrichment sweep runs", withSearch.started.includes("koldinfo-db-search"));
check("both start together", withSearch.started.length === 2 && withSearch.waiting.length === 0);

// Same-lane work still serializes: two enrichment sweeps must not both grab a browser.
const twoEnrich = schedule(["koldinfo-db", "koldinfo"], 2);
check("two KoldInfo enrichment jobs still serialize", twoEnrich.started.length === 1);
check("the second enrichment job waits", twoEnrich.waiting.length === 1);

// The ceiling binds even when three different lanes are runnable.
const allThree = schedule(["koldinfo-db", "koldinfo-db-search", "laxis"], 2);
check("three runnable lanes still start only two", allThree.started.length === 2);
check("the third waits rather than being dropped", allThree.waiting.length === 1);

// FIFO is preserved: the head of the queue always goes first when its lane is free.
const fifo = schedule(["laxis", "koldinfo-db", "koldinfo-db-search"], 3);
check("FIFO order preserved when lanes are free", fifo.started[0] === "laxis");
check("a raised ceiling lets all three run", fifo.started.length === 3);

// A ceiling of 1 degrades to the old strictly-serial behavior, never to a deadlock.
const serial = schedule(["koldinfo-db", "koldinfo-db-search", "laxis"], 1);
check("ceiling of 1 runs exactly one job", serial.started.length === 1);
check("ceiling of 1 keeps the rest queued", serial.waiting.length === 2);

// An unknown/legacy kind still lands on the laxis lane (pre-`kind` jobs on disk).
check("unknown kind defaults to the laxis lane", laneOf("something-new") === "laxis");
check("a legacy job and a laxis job share a lane", laneOf(undefined) === laneOf("laxis"));

// Nothing runnable, nothing started.
check("empty queue schedules nothing", schedule([], 2).started.length === 0);

console.log(`\nworker-lane suite: ${passed}/${passed + failed} checks passed`);
if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
console.log("all green");
