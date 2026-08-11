// RecruitersOS · MPC · seed the Targeted Search Queue with a finance-role bank.
//
// THE THROUGHPUT FIX. The daily send is only as big as the CLEAN finance pool, and the pool was
// a generic hiring firehose (97% of records were non-finance roles the gate rightly dropped).
// This loads the in-market Targeted Search Queue with exact accounting/finance role searches,
// nationwide, each marked "queued". The app's in-process runner (4s tick) then scrapes each via
// JSearch and merges the companies into the pool; the 4-min curation tick resolves the finance
// decision-maker and Reoon-validates the email. Result: the pool goes finance-DENSE, so the same
// strict gates yield hundreds of clean prospects instead of ~40.
//
// Writes the queue snapshot the app reads (/data/snap_inmarket_search_queue_v1.json) directly and
// atomically. Idempotent: a role already in the queue is RE-QUEUED (fresh pull), never duplicated,
// so this doubles as the standing-rota re-trigger.
//
//   node scripts/mpc/seed-finance-searches.mjs

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE = process.env.MPC_QUEUE_FILE || "/data/snap_inmarket_search_queue_v1.json";
const LOCATION = process.env.MPC_SEARCH_LOCATION || "United States"; // national, per Ryan's scope
const DATE = process.env.MPC_SEARCH_DATE || "month";                 // wide window to build supply
const LIMIT = Math.min(Math.max(Number(process.env.MPC_SEARCH_LIMIT || 200), 50), 5000);

// Every query maps to the sender's ACCOUNTING_ROLE gate, so what we source is what can send.
const ROLES = [
  "Controller", "Assistant Controller", "Corporate Controller",
  "Accounting Manager", "Senior Accountant", "Staff Accountant",
  "CPA", "Tax Manager", "Audit Manager",
  "FP&A Manager", "Financial Planning and Analysis Analyst", "Finance Manager",
  "Director of Finance", "Cost Accountant", "Revenue Accountant",
];

function load() {
  try { const a = JSON.parse(readFileSync(FILE, "utf8")); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function save(rows) {
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(rows));
  renameSync(tmp, FILE); // atomic swap so the runner never reads a half-written file
}

const now = new Date().toISOString();
const rows = load();
const byName = new Map(rows.map((r) => [String(r.name || "").toLowerCase(), r]));
let added = 0, requeued = 0;

for (let i = 0; i < ROLES.length; i++) {
  const role = ROLES[i];
  const name = `${role} (national)`;
  const run = { state: "queued", phase: "queued", progress: 0, queuedAt: now };
  const existing = byName.get(name.toLowerCase());
  if (existing) {
    existing.run = run; existing.updatedAt = now; requeued++;
  } else {
    rows.unshift({
      id: "sq_fin_" + i + "_" + Date.now().toString(36),
      name, query: role, location: LOCATION, datePosted: DATE,
      employmentTypes: ["FULLTIME"], remoteOnly: false, limit: LIMIT,
      createdAt: now, updatedAt: now, runs: 0, status: "draft", run,
    });
    added++;
  }
}
save(rows);
console.log(`finance search bank -> +${added} added, ${requeued} re-queued, ${rows.length} total queued`);
console.log(`location="${LOCATION}" datePosted=${DATE} limit=${LIMIT} roles=${ROLES.length}`);
console.log("the app's 4s runner will scrape these into the pool; curation (4min) enriches + validates.");
