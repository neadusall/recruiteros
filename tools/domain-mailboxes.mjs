import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("/data/snap_senders_v1.json", "utf8"));
const inboxes = s.inboxes || (s.state && s.state.inboxes) || [];
const lume = inboxes.filter(m => m.workspaceId === "ws_mqf6o989003" && m.provider === "sending-ac");
const byDomain = {};
for (const m of lume) {
  const d = (m.email || "").split("@")[1];
  if (!d) continue;
  if (!byDomain[d]) byDomain[d] = { count: 0, sample: m.email };
  byDomain[d].count++;
}
// print each domain + one sample mailbox, so we can test Mailbox API ownership
for (const [d, v] of Object.entries(byDomain).sort()) console.log(d + "|" + v.count + "|" + v.sample);
