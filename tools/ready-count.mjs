import { readFileSync } from "node:fs";
const cur = JSON.parse(readFileSync("/data/snap_inmarket_curation_v1.json", "utf8"));
const arrs=[];const walk=o=>{if(Array.isArray(o)){if(o.length&&typeof o[0]==="object")arrs.push(o);}else if(o&&typeof o==="object")for(const v of Object.values(o))walk(v);};walk(cur);
const best=arrs.sort((a,b)=>b.length-a.length)[0]||[];
const RE=/controller|cpa|accounting|finance|comptroller|bookkeep|audit/i;
let withEmail=0, acctRelevant=0, acctWithEmail=0, dmTitleFinance=0;
for(const r of best){
  const L=r.lead||r;
  const email=r.email||L.email||(r.contact&&r.contact.email);
  const roleText=((L.roles||[]).join(" ")+" "+(L.roleDetails?JSON.stringify(L.roleDetails):"")+" "+(L.role||L.title||""));
  const dmTitle=(r.title||r.role||(r.contact&&r.contact.title)||"");
  if(email)withEmail++;
  if(RE.test(roleText)){acctRelevant++; if(email)acctWithEmail++;}
  if(/cfo|controller|vp.*financ|finance|accounting|comptroller/i.test(dmTitle))dmTitleFinance++;
}
console.log("curation records:",best.length);
console.log("with email:",withEmail);
console.log("accounting/finance HIRING signal:",acctRelevant,"| of those with email:",acctWithEmail);
console.log("decision-maker title is finance (CFO/Controller/VP Fin):",dmTitleFinance);
