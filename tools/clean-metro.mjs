import { readFileSync } from "node:fs";
const cur = JSON.parse(readFileSync("/data/snap_inmarket_curation_v1.json", "utf8"));
const arrs=[];const walk=o=>{if(Array.isArray(o)){if(o.length&&typeof o[0]==="object")arrs.push(o);}else if(o&&typeof o==="object")for(const v of Object.values(o))walk(v);};walk(cur);
const best=arrs.sort((a,b)=>b.length-a.length)[0]||[];
// STRICT: the HIRING ROLE itself is accounting (not just a finance-titled manager)
const ROLE=/controller|cpa|comptroller|accountant|accounting|bookkeep|regulatory report|audit|tax\b/i;
const isMetro = s => s && /,\s*[A-Z]{2}\b/.test(s) && !/remote/i.test(s);  // "City, ST" and not remote
const clean = best.filter(r => ROLE.test(r.role||"") && r.likelyEmail && r.emailValidated === true);
const cleanMetro = clean.filter(r => isMetro(r.jobLocation));
console.log("STRICT accounting-role + VALIDATED email:", clean.length);
console.log("  of those with a real metro (City, ST):", cleanMetro.length);
console.log("  the rest are remote/national:", clean.length - cleanMetro.length);
console.log("\n=== sample clean + metro ===");
for (const r of cleanMetro.slice(0,5)) console.log(`  ${r.company} | ${r.role} | ${r.jobLocation} | ${r.managerName} (${r.managerTitle}) | ${r.likelyEmail}`);
console.log("\n=== sample clean + remote ===");
for (const r of clean.filter(r=>!isMetro(r.jobLocation)).slice(0,3)) console.log(`  ${r.company} | ${r.role} | ${r.jobLocation} | ${r.managerName} (${r.managerTitle})`);
