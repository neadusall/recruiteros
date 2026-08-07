/* Regression suite for the enrichment progress stamp (2026-08-06).
 *
 * Run from integration/:  npx tsx scripts/test-sourcing-jobprogress.mts
 *
 * The KoldInfo DB rung sweeps a list in 15-row batches and merges ALL-OR-NOTHING at
 * the end. Before this stamp existed the run record sat untouched for the whole pass,
 * so the saved-list card had nothing to draw but a modelled clock: a live browser and
 * a dead one looked identical ("cracking away and going nowhere"), and the only stall
 * signal was a 90-minute timer on the submit stamp.
 *
 * The stamp travels a chain that spans two codebases — worker phase string ->
 * jobRowsDone() -> KoldJobRef.done/progressAt -> the journey card — and every link is
 * a place it can silently rot. This pins all three:
 *   1. jobRowsDone parses the phase shapes the worker ACTUALLY emits (read out of
 *      laxis-worker/koldinfo-db-flow.js, so a rename there fails here, not in prod).
 *   2. It refuses the shapes that are NOT a row count (discovery's running total has
 *      no denominator and would otherwise read as progress against the wrong scale).
 *   3. The journey card reads the stamp: real rows on the live stop, and a stall clock
 *      anchored to last MOVEMENT rather than to submit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { jobRowsDone } from "../lib/sourcing/laxis";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

/* --- 1. the shapes the worker really emits -------------------------------- */

check("counts rows from a mid-pass phase", jobRowsDone("processing:120/500") === 120);
check("zero rows done is a real answer, not 'unknown'", jobRowsDone("processing:0/500") === 0);
check("the last batch reads as complete", jobRowsDone("processing:500/500") === 500);
check("tolerates surrounding whitespace", jobRowsDone("  processing:45/60  ") === 45);

/* --- 2. everything that is NOT a row count stays null ---------------------- */

check("word-only phase -> null", jobRowsDone("processing") === null);
check("terminal phase -> null", jobRowsDone("exported") === null);
check("discovery's denominator-less total -> null", jobRowsDone("processing:340") === null);
check("missing phase -> null", jobRowsDone(undefined) === null);
check("empty phase -> null", jobRowsDone("") === null);

/* --- 3. the worker still emits what we parse ------------------------------- */
// Cross-repo pin: the app's regex and the worker's setPhase call are one contract,
// and nothing else would notice if the worker started saying something else.
const flow = path.join(here, "..", "..", "laxis-worker", "koldinfo-db-flow.js");
if (!fs.existsSync(flow)) {
  check("laxis-worker/koldinfo-db-flow.js is readable (cross-repo pin)", false);
} else {
  const src = fs.readFileSync(flow, "utf8");
  const emits = /setPhase\("processing:" \+ seen \+ "\/" \+ total\)/.test(src);
  check("worker still emits processing:<done>/<total>", emits);
}

/* --- 4. the card actually reads the stamp ---------------------------------- */
// The stamp is only worth writing if the journey strip uses it; before the fix the
// live stop fell back to "working…" for the whole database pass.
const cmd = path.join(here, "..", "..", "assets", "js", "command.js");
if (!fs.existsSync(cmd)) {
  check("assets/js/command.js is readable", false);
} else {
  const src = fs.readFileSync(cmd, "utf8");
  check("live stop reads the ref's row count",
    /jRefDone\s*=\s*\(jJobRef && typeof jJobRef\.done === "number"\)/.test(src));
  check("live stop no longer hard-codes the ledger as its only source",
    /liveDone\s*=\s*ep\s*\?\s*epDone\s*:\s*jRefDone/.test(src));
  check("stall clock prefers last movement over submit",
    /jMoved\s*=\s*jJobRef && jJobRef\.progressAt/.test(src));
  check("stall threshold shortens once movement is readable",
    /jStallMin\s*=\s*jMoved\s*\?\s*25\s*:/.test(src));
  check("the database-pass ETA is measured when rows are known",
    /kdPer\s*=\s*\(now - kdAt\) \/ kdDone/.test(src));
}

console.log(fail ? `FAILED: ${fail} of ${pass + fail}` : `PASS: all ${pass} checks`);
process.exit(fail ? 1 : 0);
