// Create the Lume CPA/Controller sourcing watchlist in prod. Idempotent by id.
// Writes /data/snap_signals_watchlists_v1.json; the app normalizes it on next boot.
// Sourcing only - this finds hiring companies + verified contacts. It sends nothing.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILE = "/data/snap_signals_watchlists_v1.json";
const now = new Date().toISOString();

const watchlist = {
  id: "wl_lume_cpa_controller",
  workspaceId: "ws_mqf6o989003",             // Lume
  name: "CPA / Controller · Accounting & Finance · US",
  source: "jobs",
  query: "Controller",                        // JSearch: companies posting Controller roles
  industry: "Accounting",                     // folded into the query at poll time
  // location omitted = national (US)
  datePosted: "week",                         // fresh postings, national volume
  limit: 25,                                  // jobs pulled per poll (feed cost scales with this)
  minScore: 0,
  perPollCompanyCap: 20,                       // cap net-new companies per poll so it can't flood
  targetRoles: ["Controller", "CPA", "Assistant Controller", "Accounting Manager", "Finance Director"],
  active: true,
  everyMinutes: 30,                            // moderate cadence to start (tunable)
  createdAt: now,
  updatedAt: now,
  stats: {},                                   // normalize() fills the rest on load
};

let list = [];
if (existsSync(FILE)) {
  try { const j = JSON.parse(readFileSync(FILE, "utf8")); if (Array.isArray(j)) list = j; } catch { /* start fresh */ }
}

const idx = list.findIndex((w) => w && w.id === watchlist.id);
if (idx >= 0) { list[idx] = { ...list[idx], ...watchlist }; console.log("updated existing watchlist"); }
else { list.push(watchlist); console.log("added new watchlist"); }

writeFileSync(FILE, JSON.stringify(list, null, 2));
console.log("watchlists in file now:", list.length);
console.log("wrote", FILE);
for (const w of list) console.log("  -", w.workspaceId, "|", w.name, "| active:", w.active !== false);
