// RecruitersOS · MPC · seed the Targeted Search Queue with a MULTI-VERTICAL hiring-pain bank.
//
// Complements seed-finance-searches.mjs (which owns the finance rota). This bank targets the
// roles employers struggle hardest to fill across EVERY function the multi-vertical gates accept:
// revenue-critical sales seats, skilled/technical engineering, ops + supply chain, HR, marketing,
// product, legal. A company posting these roles this week is in active hiring pain = the buyer
// most likely to answer a recruiting-services email.
//
// Every query below is chosen so gates.mjs roleFamily() classifies it into a sendable family
// (never "Other"), so what we source is what can send. Same queue file + idempotent re-queue
// semantics as the finance seeder: existing names are RE-QUEUED, never duplicated.
//
//   node /tools/seed-pain-searches.mjs

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE = process.env.MPC_QUEUE_FILE || "/data/snap_inmarket_search_queue_v1.json";
const DATE = process.env.MPC_SEARCH_DATE || "week";
const LIMIT = Math.min(Math.max(Number(process.env.MPC_SEARCH_LIMIT || 50), 10), 80);

// National pass: every family the gates accept. Queries phrased so JSearch matches real postings
// AND roleFamily() buckets them correctly (checked against gates.mjs regexes).
const ROLES = [
  // Sales (revenue-critical, chronically hard to fill)
  "Sales Manager", "Account Executive", "Business Development Manager", "Sales Director",
  "Regional Sales Manager", "Account Manager", "Sales Development Representative",
  // Marketing
  "Marketing Manager", "Marketing Director", "Demand Generation Manager", "Growth Marketing Manager",
  // Engineering (skilled/technical = highest pain)
  "Software Engineer", "Senior Software Engineer", "Mechanical Engineer", "Electrical Engineer",
  "Manufacturing Engineer", "Controls Engineer", "DevOps Engineer", "Data Engineer", "Maintenance Engineer",
  // Product
  "Product Manager", "Senior Product Manager",
  // Operations / supply chain
  "Operations Manager", "Supply Chain Manager", "Logistics Manager", "Procurement Manager",
  "Director of Operations",
  // People / HR (a company hiring HR is scaling headcount)
  "Human Resources Manager", "HR Business Partner", "Talent Acquisition Manager", "HR Director",
  // Legal
  "Corporate Counsel", "General Counsel", "Compliance Officer",
];

// Highest-pain roles get a per-metro pass (volume + a real city for the writer to pair).
const CORE_ROLES = [
  "Sales Manager", "Account Executive", "Software Engineer", "Operations Manager",
  "Human Resources Manager", "Marketing Manager", "Supply Chain Manager", "Manufacturing Engineer",
];

const METROS = [
  "New York, NY", "Los Angeles, CA", "Chicago, IL", "Dallas, TX", "Houston, TX",
  "Atlanta, GA", "Boston, MA", "San Francisco, CA", "Washington, DC", "Philadelphia, PA",
  "Phoenix, AZ", "Denver, CO", "Seattle, WA", "Miami, FL", "Minneapolis, MN", "Charlotte, NC",
  "San Diego, CA", "Austin, TX", "Tampa, FL", "Nashville, TN",
  "St. Louis, MO", "Baltimore, MD", "Detroit, MI", "Orlando, FL",
];

const specs = [];
for (const role of ROLES) specs.push({ name: `${role} (national)`, query: role, location: "United States" });
for (const role of CORE_ROLES) for (const metro of METROS) specs.push({ name: `${role} - ${metro}`, query: role, location: metro });

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
    const row = {
      id: "sq_pain_" + i + "_" + Date.now().toString(36),
      name: spec.name, query: spec.query, location: spec.location, datePosted: DATE,
      employmentTypes: ["FULLTIME"], remoteOnly: false, limit: LIMIT,
      createdAt: now, updatedAt: now, runs: 0, status: "draft", run,
    };
    rows.unshift(row); byName.set(spec.name.toLowerCase(), row); added++;
  }
}

save(rows);
console.log(`pain bank: ${specs.length} searches (${ROLES.length} national + ${CORE_ROLES.length}x${METROS.length} metro) | added ${added}, re-queued ${requeued} | window=${DATE} limit=${LIMIT}`);
console.log(`queue now ${rows.length} rows at ${FILE}`);
