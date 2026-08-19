import { readFileSync } from "node:fs";
const cur = JSON.parse(readFileSync("/data/snap_inmarket_curation_v1.json", "utf8"));
const arrs=[];const walk=o=>{if(Array.isArray(o)){if(o.length&&typeof o[0]==="object")arrs.push(o);}else if(o&&typeof o==="object")for(const v of Object.values(o))walk(v);};walk(cur);
const best=arrs.sort((a,b)=>b.length-a.length)[0]||[];
const RE=/controller|cpa|accounting|comptroller|\bfinance\b/i;
const hits = best.filter(r => RE.test((r.role||"")+" "+(r.managerTitle||"")) && r.likelyEmail && r.managerName);
console.log("ready CPA/Controller records (role match + manager + email):", hits.length);
for (const r of hits.slice(0,4)) {
  console.log("---");
  console.log("company:", r.company, "| industry:", r.industry);
  console.log("hiring role:", r.role, "| location:", r.jobLocation);
  console.log("decision-maker:", r.managerName, "-", r.managerTitle);
  console.log("email:", r.likelyEmail, "| validated:", r.emailValidated, "| catchAll:", r.emailCatchAll);
  console.log("signalReason:", (r.signalReason||"").slice(0,140));
  console.log("jobUrl:", r.jobUrl);
}
