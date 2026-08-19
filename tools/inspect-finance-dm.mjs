import { readFileSync } from "node:fs";
const cur = JSON.parse(readFileSync("/data/snap_inmarket_curation_v1.json", "utf8"));
const arrs=[];const walk=o=>{if(Array.isArray(o)){if(o.length&&typeof o[0]==="object")arrs.push(o);}else if(o&&typeof o==="object")for(const v of Object.values(o))walk(v);};walk(cur);
const best=arrs.sort((a,b)=>b.length-a.length)[0]||[];
// find a record whose hiring roles include controller/cpa/accounting
const RE=/controller|cpa|accounting|comptroller/i;
const hits = best.filter(r => { const L=r.lead||r; return RE.test(((L.roles||[]).join(" ")+" "+(L.role||L.title||"")+" "+JSON.stringify(L.roleDetails||""))); });
console.log("accounting-hiring curation records:", hits.length);
if (hits.length) {
  const r = hits[0];
  console.log("\n=== FULL RECORD (top-level keys) ===", Object.keys(r).join(","));
  console.log("=== lead keys ===", r.lead?Object.keys(r.lead).join(","):"(no .lead)");
  // Dump the fields that matter for MPC rendering + contact
  const L = r.lead||r;
  console.log("company:", L.company);
  console.log("roles:", JSON.stringify(L.roles));
  console.log("roleDetails:", JSON.stringify(L.roleDetails).slice(0,300));
  console.log("location:", L.location, "| domain:", L.domain, "| sourceUrl:", L.sourceUrl?"yes":"no");
  console.log("contact/decisionMaker:", JSON.stringify(r.contact||r.decisionMaker||r.person||{}).slice(0,300));
  console.log("email anywhere:", r.email||L.email||(r.contact&&r.contact.email)||"NONE");
  console.log("mpc/mustHaves fields:", JSON.stringify({mustHaves:L.mustHaves||r.mustHaves, mpcContext:r.mpcContext, proof:L.proof||r.proof}).slice(0,300));
}
