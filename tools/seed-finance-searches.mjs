// RecruitersOS · MPC · seed the Targeted Search Queue with a finance-role bank (scaled for volume).
//
// THE THROUGHPUT ENGINE. The daily send is only as big as the CLEAN finance pool. This loads the
// in-market Targeted Search Queue with accounting/finance role searches, nationwide AND per-metro,
// each marked "queued". The app's in-process runner (4s tick) scrapes each via JSearch and merges
// companies into the pool; the 4-min curation tick resolves the finance decision-maker and
// Reoon-validates the email (INMARKET_REQUIRE_VALIDATED=1, so only validated enrolls).
//
// SIZING NOTES (learned the hard way):
//  - JSearch aggregates `num_pages = ceil(limit/10)` pages in ONE call under a 30s timeout. limit>~80
//    times out ("jobfeed_unreachable"). So per-search LIMIT is kept small (default 50 = 5 pages) and
//    we get VOLUME from MANY searches instead of few fat ones.
//  - Per-metro searches for the core roles both multiply supply AND give the sender a real city to
//    pair (hyper-local targeting). National searches catch remote + everything else.
//  - JSearch quota is 50k calls/month; ~148 searches x 5 pages = ~740 calls/run, comfortably under.
//
// Idempotent: a search already in the queue is RE-QUEUED (fresh pull), never duplicated, so this is
// also the standing-rota re-trigger. Writes the queue snapshot the app reads, atomically.
//
//   node scripts/mpc/seed-finance-searches.mjs

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE = process.env.MPC_QUEUE_FILE || "/data/snap_inmarket_search_queue_v1.json";
const DATE = process.env.MPC_SEARCH_DATE || "week";                  // rolling window; "3days" for daily re-runs
const LIMIT = Math.min(Math.max(Number(process.env.MPC_SEARCH_LIMIT || 50), 10), 80); // keep <=80 so JSearch doesn't time out

// Every query maps to the sender's ACCOUNTING_ROLE gate, so what we source is what can send.
const ROLES = [
  "Controller", "Assistant Controller", "Corporate Controller", "Divisional Controller",
  "Accounting Manager", "Senior Accountant", "Staff Accountant", "Senior Accounting Manager",
  "CPA", "Tax Manager", "Tax Director", "Audit Manager",
  "FP&A Manager", "FP&A Analyst", "Financial Planning and Analysis Manager", "Finance Manager",
  "Director of Finance", "VP Finance", "Cost Accountant", "Revenue Accountant",
];

// Highest-volume roles get a per-metro pass too (volume + a real city to pair for personalization).
const CORE_ROLES = [
  "Controller", "Assistant Controller", "Accounting Manager",
  "Senior Accountant", "Staff Accountant", "Finance Manager",
  "FP&A Manager", "Tax Manager",
];

// Top US metros by finance employment (JSearch reads "<role> in <metro>" natively).
const METROS = [
  "New York, NY", "Los Angeles, CA", "Chicago, IL", "Dallas, TX", "Houston, TX",
  "Atlanta, GA", "Boston, MA", "San Francisco, CA", "Washington, DC", "Philadelphia, PA",
  "Phoenix, AZ", "Denver, CO", "Seattle, WA", "Miami, FL", "Minneapolis, MN", "Charlotte, NC",
  "San Diego, CA", "Austin, TX", "Tampa, FL", "Nashville, TN",
  "St. Louis, MO", "Baltimore, MD", "Detroit, MI", "Orlando, FL",
];

// NON-FINANCE VERTICALS (added 2026-08-18). gates.mjs roleFamily() and the function-aware writer
// already handle Sales/Marketing/Engineering/Product/Operations/HR/Legal end to end (role:0
// rejections in the 8/18 run), so sourcing them turns straight into sendable supply. Every role
// below was checked against the roleFamily() regexes so nothing lands in "Other".
// Quota math: +24 national +2x24 metro = +72 searches ~= +11k JSearch calls/mo on top of ~32k.
const VERTICAL_ROLES = [
  "Sales Manager", "Account Executive", "Sales Director", "Business Development Manager", "Account Manager",
  "Marketing Manager", "Marketing Director", "Demand Generation Manager", "Content Marketing Manager",
  "Software Engineer", "Senior Software Engineer", "Engineering Manager", "DevOps Engineer", "Data Engineer",
  "Product Manager", "Senior Product Manager",
  "Operations Manager", "Supply Chain Manager", "Logistics Manager", "Procurement Manager",
  "HR Manager", "HR Business Partner", "Human Resources Director",
  "Corporate Counsel",
];
// Only the two highest-volume verticals get the per-metro multiplier, to protect the quota.
const VERTICAL_CORE = ["Sales Manager", "Software Engineer"];

// Build the full search spec list: national for every role, plus core roles x every metro.
const specs = [];
for (const role of ROLES) specs.push({ name: `${role} (national)`, query: role, location: "United States" });
for (const role of CORE_ROLES) for (const metro of METROS) specs.push({ name: `${role} - ${metro}`, query: role, location: metro });
for (const role of VERTICAL_ROLES) specs.push({ name: `${role} (national)`, query: role, location: "United States" });
for (const role of VERTICAL_CORE) for (const metro of METROS) specs.push({ name: `${role} - ${metro}`, query: role, location: metro });

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

for (let i = 0; i < specs.length; i++) {
  const spec = specs[i];
  const run = { state: "queued", phase: "queued", progress: 0, queuedAt: now };
  const existing = byName.get(spec.name.toLowerCase());
  if (existing) {
    existing.run = run; existing.query = spec.query; existing.location = spec.location;
    existing.datePosted = DATE; existing.limit = LIMIT; existing.updatedAt = now; requeued++;
  } else {
    rows.unshift({
      id: "sq_fin_" + i + "_" + Date.now().toString(36),
      name: spec.name, query: spec.query, location: spec.location, datePosted: DATE,
      employmentTypes: ["FULLTIME"], remoteOnly: false, limit: LIMIT,
      createdAt: now, updatedAt: now, runs: 0, status: "draft", run,
    });
    added++;
  }
}
save(rows);
console.log(`finance search bank -> +${added} added, ${requeued} re-queued, ${rows.length} total queued`);
console.log(`roles=${ROLES.length}+${VERTICAL_ROLES.length} national + (${CORE_ROLES.length}+${VERTICAL_CORE.length})x${METROS.length} metro = ${specs.length} searches | datePosted=${DATE} limit=${LIMIT} (num_pages=${Math.ceil(LIMIT / 10)})`);
console.log("the app's 4s runner scrapes these into the pool; curation (4min) enriches + Reoon-validates.");
