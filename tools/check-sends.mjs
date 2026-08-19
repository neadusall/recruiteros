import { readFileSync, readdirSync } from "node:fs";
// Ryan's boxes: any sends today?
const sn = JSON.parse(readFileSync("/data/snap_senders_v1.json", "utf8"));
const inboxes = sn.inboxes || (sn.state && sn.state.inboxes) || [];
const ryan = inboxes.filter(m => m.workspaceId === "ws_mqf6o989003" && /ryan/i.test(m.ownerName||"") && m.provider==="sending-ac");
const sentToday = ryan.filter(m => (m.sentToday||0) > 0);
const everSent = ryan.filter(m => (m.sent||0) > 0 || m.lastSendAt);
console.log("Ryan boxes:", ryan.length, "| with sentToday>0:", sentToday.length, "| ever sent:", everSent.length);
for (const m of sentToday.slice(0,5)) console.log("  SENT:", m.email, "sentToday=", m.sentToday, "last=", m.lastSendAt);
// Campaign prospects: any with a Day-0 send/fired marker?
const CID = "cmp_lume_cpa_controller";
let sentProspects = 0, total = 0;
for (const f of readdirSync("/data").filter(x => /core/i.test(x) && x.endsWith(".json"))) {
  let s; try { s = JSON.parse(readFileSync("/data/"+f,"utf8")); } catch { continue; }
  const walk = o => { if(!o||typeof o!=="object")return;
    if(o.campaignId===CID){ total++; if(o.lastEmailAt||o.firedAt||o.sentAt||(o.touchesFired&&o.touchesFired.length)||o.status==="contacted") sentProspects++; }
    if(Array.isArray(o))o.forEach(walk); else for(const v of Object.values(o))walk(v); };
  walk(s);
}
console.log("campaign prospects:", total, "| with a send marker:", sentProspects);
