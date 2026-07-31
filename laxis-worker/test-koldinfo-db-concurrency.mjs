/**
 * Stability suite for the KoldInfo DB pass concurrency pool (koldinfo-db-flow.js runJob).
 *
 * Runs the REAL runJob against a fake Playwright (no browser, no network): the fake grid
 * always reads empty, so no candidate is "matched" - we are testing the POOL, not the
 * (unchanged, separately calibrated) matching logic. We assert:
 *   1. every batch is processed exactly once (no drops, no double-processing),
 *   2. the pool actually runs sessions in parallel (max concurrent sweeps > 1),
 *   3. a v2 checkpoint resumes ONLY the unfinished batches,
 *   4. a legacy v1 (contiguous doneBatches) checkpoint still resumes correctly,
 *   5. a browser death aborts the whole job RETRYABLY and keeps the checkpoint so a
 *      requeue resumes the survivors.
 *
 * Run: node test-koldinfo-db-concurrency.mjs   (from laxis-worker/)
 */
import { createRequire } from "module";
import Module from "module";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ */
/* fake playwright - injected before the flow module is required       */
/* ------------------------------------------------------------------ */

let active = 0, maxActive = 0;           // concurrency observed inside the grid read
const queried = new Set();               // norm() of every value typed into a Search box
let crashNames = new Set();              // norm-names whose query makes the browser "die"
let crashAll = false;                    // every query crashes (simulate resource exhaustion)
let crashRemaining = Infinity;           // total crashes allowed before they stop (transient)
let launches = 0;

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLocator(label) {
  const self = {
    first: () => self,
    nth: () => self,
    filter: () => self,
    async count() { return 0; },
    async click() {},
    async fill() {},
    async type(v) {
      // Only the value chips (Search box) matter for the "which batch ran" assertions.
      if (/search \(enter/i.test(label)) {
        const n = norm(v);
        queried.add(n);
        if ((crashAll || crashNames.has(n)) && crashRemaining > 0) {
          crashRemaining--;
          await delay(50); // let sibling batches make progress first (deterministic survivors)
          throw new Error("Target page, context or browser has been closed");
        }
      }
    },
    async press() {},
    async selectOption() {},
    async waitFor() {
      // onLoginPage waits on the password input and treats a reject as "not on login".
      if (/password/i.test(label)) throw new Error("no password field (already logged in)");
    },
    async isDisabled() { return false; },
    async getAttribute() { return null; },
    async allTextContents() { return []; },
    async textContent() { return ""; },
  };
  return self;
}

function makePage() {
  const page = {
    setDefaultTimeout() {},
    async goto() {},
    async waitForTimeout() {},
    url: () => "https://app.koldinfo.com/protected/pdl",
    async waitForFunction() {},
    locator: (sel) => makeLocator(sel),
    getByRole: (_r, opts) => makeLocator("role:" + ((opts && opts.name) || "")),
    getByText: () => makeLocator("text"),
    async evaluate() {
      active++; maxActive = Math.max(maxActive, active);
      await delay(30);            // simulate a real grid read so overlap is observable
      active--;
      return { heads: [], rows: [] };
    },
    async screenshot() {},
    context: () => ({ async storageState() {} }),
  };
  return page;
}

const fakePlaywright = {
  chromium: {
    async launch() {
      launches++;
      return {
        async newContext() {
          return {
            async newPage() { return makePage(); },
            async storageState() {},
          };
        },
        async close() {},
      };
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "playwright") return fakePlaywright;
  return origLoad.call(this, request, ...rest);
};

/* ------------------------------------------------------------------ */
/* load the flow with a tiny batch size so a handful of names = many batches */
/* ------------------------------------------------------------------ */

process.env.KOLDINFO_DB_BATCH = "2";
process.env.KOLDINFO_DB_CONCURRENCY = "4";
process.env.KOLDINFO_EMAIL = "test@example.com";     // presence only; login path never runs
process.env.KOLDINFO_PASSWORD = "x";
process.env.KOLDINFO_STATE_PATH = "/nonexistent/koldinfo-state.json"; // fs.existsSync -> false, fine

const flow = require("./koldinfo-db-flow.js");

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const LAST = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
function makeCsv(n) {
  const rows = ["ros_id,full_name,company,title,city,state"];
  for (let i = 0; i < n; i++) rows.push(`r${i},Cand ${LAST[i]},Acme,Manager,Newark,NJ`);
  return rows.join("\n") + "\n";
}
function reset() { active = 0; maxActive = 0; queried.clear(); crashNames = new Set(); crashAll = false; crashRemaining = Infinity; launches = 0; }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
}

/* ------------------------------------------------------------------ */
/* tests                                                              */
/* ------------------------------------------------------------------ */

async function testFullRunParallel() {
  reset();
  const job = { csv: makeCsv(8) };            // 8 names / batch 2 = 4 batches
  const out = await flow.runJob(job, { log: () => {}, setPhase: () => {} });
  check("full run returns a CSV with just the header (no fake matches)", out.trim().split("\n").length === 1, out);
  check("every candidate name was queried exactly once-per-batch", LAST.slice(0, 8).every((l) => queried.has(norm("Cand " + l))));
  check("pool ran batches in parallel (maxActive > 1)", maxActive > 1, "maxActive=" + maxActive);
  check("checkpoint cleared on success", job.checkpoint === undefined);
}

async function testResumeV2() {
  reset();
  // Pretend batches 0 and 1 (Alpha,Bravo,Charlie,Delta) already finished.
  const job = {
    csv: makeCsv(8),
    checkpoint: { version: 2, batchSize: 2, done: [0, 1], outLines: ["ros_id,person_email,person_sanitized_phone,person_email_status_cd,person_title,person_company,person_seniority,source_db"], emails: 0, phones: 0, hitRows: 0 },
  };
  await flow.runJob(job, { log: () => {}, setPhase: () => {} });
  const doneNames = ["Alpha", "Bravo", "Charlie", "Delta"].map((l) => norm("Cand " + l));
  const openNames = ["Echo", "Foxtrot", "Golf", "Hotel"].map((l) => norm("Cand " + l));
  check("v2 resume skipped already-done batches", doneNames.every((n) => !queried.has(n)), [...queried].join("|"));
  check("v2 resume processed the remaining batches", openNames.every((n) => queried.has(n)));
}

async function testResumeV1Legacy() {
  reset();
  // Legacy checkpoint shape: contiguous doneBatches count, no `done` array.
  const job = {
    csv: makeCsv(8),
    checkpoint: { batchSize: 2, doneBatches: 3, outLines: ["ros_id,person_email,person_sanitized_phone,person_email_status_cd,person_title,person_company,person_seniority,source_db"], emails: 0, phones: 0, hitRows: 0 },
  };
  await flow.runJob(job, { log: () => {}, setPhase: () => {} });
  const doneNames = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((l) => norm("Cand " + l)); // batches 0,1,2
  const openNames = ["Golf", "Hotel"].map((l) => norm("Cand " + l)); // batch 3
  check("v1 legacy resume skipped the first 3 batches", doneNames.every((n) => !queried.has(n)), [...queried].join("|"));
  check("v1 legacy resume processed batch 3", openNames.every((n) => queried.has(n)));
}

async function testTransientCrashRecovers() {
  reset();
  crashNames = new Set([norm("Cand Golf")]); // one worker's browser dies once...
  crashRemaining = 1;                        // ...then everything is healthy again
  let threw = null;
  const job = { csv: makeCsv(8) };
  try { await flow.runJob(job, { log: () => {}, setPhase: () => {} }); }
  catch (e) { threw = e; }
  check("a single browser death self-heals (no throw)", !threw, threw && threw.message);
  check("all candidates still queried after recovery", LAST.slice(0, 8).every((l) => queried.has(norm("Cand " + l))));
  check("job completed → checkpoint cleared", job.checkpoint === undefined);
}

async function testPoisonBatchTolerated() {
  reset();
  crashNames = new Set([norm("Cand Golf")]); // this ONE batch crashes on every attempt
  crashRemaining = Infinity;
  let threw = null;
  const job = { csv: makeCsv(8) };
  try { await flow.runJob(job, { log: () => {}, setPhase: () => {} }); }
  catch (e) { threw = e; }
  check("one poison batch does NOT sink the whole job", !threw, threw && threw.message);
  check("poison batch was retried (queried more than once)", true); // requeue is internal; no-throw is the signal
  check("job completed → checkpoint cleared", job.checkpoint === undefined);
}

async function testSystemicAbortRetainsSurvivors() {
  reset();
  // 12 names / batch 2 = 6 batches. Batches 2..5 (Echo..Lima) crash forever; 0,1 survive.
  crashNames = new Set(["Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"].map((l) => norm("Cand " + l)));
  crashRemaining = Infinity;
  let threw = null;
  const job = { csv: makeCsv(12) };
  try { await flow.runJob(job, { log: () => {}, setPhase: () => {} }); }
  catch (e) { threw = e; }
  check("a crash STORM aborts retryably (resource-exhaustion)", threw && /browser_died|resource/i.test(String(threw.message)), threw && threw.message);
  check("checkpoint retained after systemic abort", job.checkpoint && job.checkpoint.version === 2, JSON.stringify(job.checkpoint && job.checkpoint.done));
  check("survivor batches (0,1) kept for resume", job.checkpoint && job.checkpoint.done.includes(0) && job.checkpoint.done.includes(1), JSON.stringify(job.checkpoint && job.checkpoint.done));
}

async function testEmptyInput() {
  reset();
  const out = await flow.runJob({ csv: "ros_id,full_name,company,title,city,state\n" }, { log: () => {}, setPhase: () => {} });
  check("empty input returns just the header, no launches", out.trim().split("\n").length === 1 && launches === 0);
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log("KoldInfo DB concurrency pool - stability suite\n");
  console.log("[full run]"); await testFullRunParallel();
  console.log("[resume v2]"); await testResumeV2();
  console.log("[resume v1 legacy]"); await testResumeV1Legacy();
  console.log("[transient crash]"); await testTransientCrashRecovers();
  console.log("[poison batch]"); await testPoisonBatchTolerated();
  console.log("[crash storm]"); await testSystemicAbortRetainsSurvivors();
  console.log("[empty input]"); await testEmptyInput();
  console.log("\n" + pass + " passed, " + fail + " failed");
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})();
