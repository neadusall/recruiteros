import { readFileSync, readdirSync } from "node:fs";
const CID = "cmp_lume_cpa_controller";
let found = [];
for (const f of readdirSync("/data").filter(x => /prospect|core|inmarket|campaign/i.test(x) && x.endsWith(".json"))) {
  let s; try { s = JSON.parse(readFileSync("/data/" + f, "utf8")); } catch { continue; }
  const walk = o => {
    if (!o || typeof o !== "object") return;
    if (o.campaignId === CID && (o.email || o.firstName || o.company)) found.push({ f, p: o });
    if (Array.isArray(o)) o.forEach(walk); else for (const v of Object.values(o)) walk(v);
  };
  walk(s);
}
console.log("prospects enrolled in campaign:", found.length);
for (const { f, p } of found.slice(0, 6)) {
  console.log(`  [${f}] ${p.firstName||"?"} ${p.lastName||""} | title="${p.title||"?"}" | company="${p.company||"?"}" | loc="${p.location||"?"}" | email=${p.email?"yes":"no"} | mpcCtx=${p.mpcContext?"yes":"no"}`);
}
if (!found.length) console.log("(none enrolled yet - auto-enroll runs every 5 min; prospects need email-verified decision-makers first)");
