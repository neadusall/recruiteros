// Builds /data/snap_mpc_ndr_v1.json (tools-lane owned) from the fleet sweep results:
// the set of campaign recipients whose mail bounced + per-sending-domain counts.
// batch.mjs / followup.mjs / mpc-deliverability.mjs consume it; the NDR sweep timer refreshes it.
// Usage: node ndr-sidecar.mjs /tmp/sweep-results.json /var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_ndr_v1.json
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";

const [sweepFile, outFile] = process.argv.slice(2);
const OUT = "/opt/recruiteros/mpc-out";

const sentTo = new Set();
const sentByDomain = new Map();
for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r.to_email) sentTo.add(String(r.to_email).toLowerCase());
      const d = String(r.from || "").split("@")[1];
      if (d) sentByDomain.set(d, (sentByDomain.get(d) || 0) + 1);
    } catch {}
  }
}

const sweep = JSON.parse(readFileSync(sweepFile, "utf8"));
const bounced = new Set();
const perDomain = {};
let warmupNdrs = 0;
for (const n of sweep.ndrs) {
  const rcpt = String(n.rcpt || "").toLowerCase();
  const subjLower = n.subj.replace(/^undeliverable:\s*/i, "");
  const looksCampaign = subjLower === subjLower.toLowerCase() && /[a-z]/.test(subjLower);
  const isCampaign = (rcpt && sentTo.has(rcpt)) || looksCampaign;
  if (!isCampaign) { warmupNdrs++; continue; }
  if (rcpt && sentTo.has(rcpt)) bounced.add(rcpt);
  const d = n.box.split("@")[1];
  perDomain[d] = perDomain[d] || { bounces: 0, sent: sentByDomain.get(d) || 0 };
  perDomain[d].bounces++;
}

// Merge with any previous sidecar so a narrower future sweep never forgets old bounces.
if (existsSync(outFile)) {
  try {
    const prev = JSON.parse(readFileSync(outFile, "utf8"));
    for (const e of prev.bounced || []) bounced.add(e);
  } catch {}
}

const out = {
  generatedAt: new Date().toISOString(),
  source: "mailbox-api-ndr-sweep",
  boxesSwept: sweep.boxesSwept,
  warmupNdrs,
  bounced: [...bounced].sort(),
  perDomain,
};
const tmp = outFile + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, outFile);
console.log(`sidecar written: ${out.bounced.length} bounced recipients, ${Object.keys(perDomain).length} sending domains, boxes swept ${sweep.boxesSwept}`);
