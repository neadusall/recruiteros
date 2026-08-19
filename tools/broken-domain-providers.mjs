import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("/data/snap_senders_v1.json", "utf8"));
const inboxes = s.inboxes || (s.state && s.state.inboxes) || [];
const broken = process.argv.slice(2);
for (const d of broken) {
  const rows = inboxes.filter(m => (m.email || "").split("@")[1] === d);
  const provs = {};
  for (const m of rows) provs[(m.provider || "?") + "/" + (m.smtpHost || "?")] = (provs[(m.provider || "?") + "/" + (m.smtpHost || "?")] || 0) + 1;
  console.log(d + " -> " + (rows.length ? Object.entries(provs).map(([k, v]) => v + "x " + k).join(", ") : "NO mailboxes in fleet"));
}
