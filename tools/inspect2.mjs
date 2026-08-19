import { readFileSync } from "node:fs";
const core = JSON.parse(readFileSync("/data/snap_core.json", "utf8"));
console.log("=== campaigns container type ===");
console.log("campaigns[0] is array?", Array.isArray(core.campaigns[0]), "| campaigns[0].length:", core.campaigns[0] && core.campaigns[0].length);
const entry = core.campaigns[0];
if (Array.isArray(entry) && entry.length === 2) {
  console.log("FORMAT: [id, campaign] pairs. id =", entry[0]);
  const camp = entry[1];
  console.log("campaign fields:", Object.keys(camp).join(", "));
  console.log("motion:", camp.motion, "| status:", camp.status, "| autoRun:", camp.autoRun, "| approved:", camp.outreachApproved, "| recruiterId:", camp.recruiterId);
  console.log("model:", camp.model ? ("engine=" + camp.model.engine + " touches=" + camp.model.touches.length) : "none");
  if (camp.model && camp.model.touches[0]) console.log("touch0 keys:", Object.keys(camp.model.touches[0]).join(","));
}
console.log("\n=== real sourced records (from .lead) ===");
const pool = JSON.parse(readFileSync("/data/snap_inmarket_pool_v1.json", "utf8"));
const arrs = []; const walk = o => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
walk(pool);
const best = arrs.sort((a,b)=>b.length-a.length)[0] || [];
console.log("records:", best.length, "| lead keys:", best[0] && best[0].lead ? Object.keys(best[0].lead).join(",") : "?");
let n = 0;
for (const r of best) {
  const L = r.lead || r;
  const co = L.company||L.companyName, role = L.role||L.openRole||L.roleTitle, dm = L.name||L.contactName||L.dmName||L.fullName, email = L.email, url = L.jobUrl||L.url||L.sourceUrl||L.postingUrl||L.jobPostingUrl;
  if (co && n < 8) { console.log(`  ${co} | role=${role||"?"} | dm=${dm||"?"} | email=${email||"none"} | jobURL=${url?"Y":"n"}`); n++; }
}
