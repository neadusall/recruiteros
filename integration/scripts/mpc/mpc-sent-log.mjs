// RecruitersOS · MPC · sent-message log (the audit / confidence view feed).
//
// Rolls the real sent emails (from the tool send logs, which carry the full body) into one snapshot
// the portal reads, so the operator can see exactly what went out in their name: recipient, company,
// role, subject, the full message, which angle, which mailbox, and when. Newest first.
//
//   node scripts/mpc/mpc-sent-log.mjs

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const SENT_FILE = process.env.MPC_SENT_FILE || "/data/snap_mpc_sent_v1.json";
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const KEEP = Number(process.env.MPC_SENT_KEEP || 300); // most-recent messages retained for the view

const rows = [];
if (existsSync(OUT)) {
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (!r || !r.result || !r.result.ok || !r.to_email || !r.subject) continue;
        rows.push({
          at: r.at, to_email: r.to_email, to_name: r.to_name || "", company: r.company || "",
          role: r.role || "", variant: r.variant || "", from: r.from || "",
          touch: r.touch || 1, subject: r.subject, body: r.body || "",
        });
      } catch { /* skip bad line */ }
    }
  }
}
rows.sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0));

const out = {
  workspaceId: WS,
  generatedAt: new Date().toISOString(),
  total: rows.length,
  messages: rows.slice(0, KEEP),
};
const tmp = SENT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out));
renameSync(tmp, SENT_FILE);
console.log(`mpc-sent-log -> ${rows.length} sent messages (keeping newest ${out.messages.length}) -> ${SENT_FILE}`);
if (rows[0]) console.log(`  newest: ${rows[0].at} ${rows[0].to_email} "${rows[0].subject}"`);
