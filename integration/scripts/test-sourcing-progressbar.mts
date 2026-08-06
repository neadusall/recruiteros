/* Regression suite for the JD Sourcing progress bar's single-owner contract.
 *
 * Run from integration/:  npx tsx scripts/test-sourcing-progressbar.mts
 *
 * Guards the fix shipped in main 5f2031d: revisiting the JD Sourcing tab
 * rebuilds the whole view, and before the fix the previous visit's 200ms
 * ticker survived navigation, found the rebuilt #jdProgress by id, and fought
 * the new visit's ticker over the % and ETA (the bar visibly jumped between
 * two readings). The contract asserted here, against the REAL progress block
 * extracted from command.js:
 *   1. Starting a new bar always kills the previous ticker (one writer ever).
 *   2. A stale flow's finishProgress cannot slam the live bar to 100%.
 *   3. A stale flow's setProgPhase cannot relabel the live bar.
 *   4. A stale flow's hideProgress cannot hide the live bar.
 *   5. The owning flow's finishProgress still completes its own bar.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.COMMAND_JS || path.join(here, "..", "public", "assets", "js", "command.js");
const src = fs.readFileSync(file, "utf8");

const start = src.indexOf("    var prog = { timer: null");
const end = src.indexOf("    /** ETA seconds for a discovery run");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the progress block in " + file);
  process.exit(1);
}
const block = src.slice(start, end);

let passed = 0, failed = 0;
function check(ok: boolean, label: string) {
  if (ok) { passed++; console.log("  ok - " + label); }
  else { failed++; console.log("  FAIL - " + label); }
}

// ---- minimal DOM stubs (shared page, per-visit view) ----
(globalThis as any).window = {};
let hostEl: any = null; // the current #jdProgress
function makeEl() {
  const kids: any = {};
  for (const k of ["jd-prog-fill", "jd-prog-pct", "jdProgPhase", "jdProgEta", "jdProgTitle"]) {
    kids[k] = { style: {}, _t: "", writes: [] as string[] };
    Object.defineProperty(kids[k], "textContent", {
      get() { return this._t; },
      set(v: string) { this._t = v; this.writes.push(v); }
    });
  }
  return {
    dataset: {} as Record<string, string>, style: {} as any,
    classList: { add() {}, remove() {} }, _kids: kids, innerHTML: "",
    querySelector(sel: string) { return kids[sel.replace(/^[.#]/, "")] || null; }
  };
}
const viewTimers: any[] = [];
function makeVisit() {
  // One call = one renderJdSourcing render (fresh closure over a fresh prog).
  const $ = (id: string) => (id === "#jdProgress" ? hostEl : (hostEl ? hostEl.querySelector(id) : null));
  const esc = (s: any) => String(s == null ? "" : s);
  // The break layer (assets/js/command.js) hands the live bar a way to fail it when a
  // request breaks; the block under test assigns to it. Module scope is strict, so an
  // undeclared assignment is a ReferenceError rather than an implicit global — declare
  // it here or this whole suite dies on the first eval.
  let activeProgressFail: any = null;
  const api: any = {};
  // eslint-disable-next-line no-eval
  eval(block + "\napi.showProgress = showProgress; api.finishProgress = finishProgress;" +
    " api.setProgPhase = setProgPhase; api.hideProgress = hideProgress; api.prog = prog;");
  void $; void esc; void viewTimers; void activeProgressFail; // referenced from inside the eval'd block
  return api;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("progress-bar single-owner suite against " + path.relative(process.cwd(), file));

  // Visit 1: a long enrichment bar starts its ticker.
  hostEl = makeEl();
  const visitA = makeVisit();
  visitA.showProgress('Enriching "big list"', 4620, "Working…");
  await sleep(500);

  // Navigate away and back with NO router cleanup (worst case), new search bar.
  hostEl = makeEl();
  const visitB = makeVisit();
  visitB.showProgress("Finding candidates", 280, "Working…");
  await sleep(700);

  // 1. Single writer: ~700ms at 200ms/tick = at most ~5 writes (+1 initial).
  //    Two live tickers would have produced roughly double.
  const pctWrites = hostEl._kids["jd-prog-pct"].writes as string[];
  check(pctWrites.length <= 6, "one writer only (" + pctWrites.length + " pct writes in 700ms)");
  check(pctWrites.every(w => parseInt(w, 10) <= 5), "no foreign %: all writes are the young bar's (" + pctWrites.join(" ") + ")");

  // 2. Stale finish must not slam the live bar.
  visitA.finishProgress("Enrichment done");
  const lastPct = pctWrites[pctWrites.length - 1];
  const lastPhase = (hostEl._kids["jdProgPhase"].writes.slice(-1)[0] || "") as string;
  check(lastPct !== "100%" && !/done/i.test(lastPhase), "stale finishProgress ignored");

  // 3. Stale phase writes must not land.
  visitA.setProgPhase("The enrichment worker restarted…");
  const ph = (hostEl._kids["jdProgPhase"].writes.slice(-1)[0] || "") as string;
  check(!/restarted/.test(ph), "stale setProgPhase ignored");

  // 4. Stale hide must not hide the live bar.
  visitA.hideProgress();
  check(hostEl.style.display !== "none", "stale hideProgress ignored");

  // 5. The owner can still finish its own bar, and that stops the ticker.
  visitB.finishProgress("Done");
  check(pctWrites[pctWrites.length - 1] === "100%", "owner finishProgress completes the bar");
  const countAtFinish = pctWrites.length;
  await sleep(500);
  check(pctWrites.length === countAtFinish, "ticker fully stopped after finish");

  console.log(failed ? "FAILED: " + failed + " of " + (passed + failed) : "PASS: all " + passed + " checks");
  process.exit(failed ? 1 : 0);
}
main();
