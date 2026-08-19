import { readFileSync } from "node:fs";
// 1) A real campaign's exact structure (to mirror so the app won't reject a new one)
const core = JSON.parse(readFileSync("/data/snap_core.json", "utf8"));
const real = core.campaigns.find(c => c.model && c.model.touches && c.model.touches.length) || core.campaigns[0];
console.log("=== REAL CAMPAIGN KEYS ===");
console.log(Object.keys(real).join(", "));
console.log("motion:", real.motion, "| status:", real.status, "| autoRun:", real.autoRun, "| approved:", real.outreachApproved);
console.log("icp keys:", real.icp ? Object.keys(real.icp).join(",") : "none", "| channels:", JSON.stringify(real.channels));
console.log("model.engine:", real.model && real.model.engine, "| touches:", real.model ? real.model.touches.length : 0);

// 2) The sourced CPA/Controller data — is it real?
console.log("\n=== SOURCED DATA ===");
const pool = JSON.parse(readFileSync("/data/snap_inmarket_pool_v1.json", "utf8"));
const arrs = []; const walk = o => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
walk(pool);
const best = arrs.sort((a,b)=>b.length-a.length)[0] || [];
console.log("pool records:", best.length, "| sample record keys:", best[0] ? Object.keys(best[0]).slice(0,25).join(",") : "none");
// show a few with the fields the user cares about
let shown = 0;
for (const r of best) {
  const co = r.company || r.companyName, role = r.role || r.openRole || r.title, name = r.name || r.contactName || r.decisionMaker, email = r.email, url = r.jobUrl || r.url || r.sourceUrl || r.postingUrl;
  if ((co || role) && shown < 6) { console.log(`  co=${co||"?"} | role=${role||"?"} | dm=${name||"?"} | email=${email?"yes":"no"} | jobUrl=${url?"yes":"no"}`); shown++; }
}
