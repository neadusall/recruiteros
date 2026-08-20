// RecruitersOS · MPC · one-time repair (2026-08-20): un-bench domains condemned by a
// wrong-selector DKIM probe.
//
// Aug 19-20: mpc-deliverability.mjs checked only selector1._domainkey (the Microsoft 365
// selector). The Zapmail Google Workspace domains publish DKIM at google._domainkey, so
// every one of them audited as "authentication broken (DKIM missing)" and domain-rest.mjs
// benched 15 healthy domains (0 bounces, 100% warm-up reputation). The probe is fixed in
// the same commit to try the real selector list.
//
// This clears the rest ledger ONLY for domains that pass a hard safety check: the bench
// reason is the DKIM-auth signal, a live DNS probe finds a real DKIM record on some
// selector, and the current deliverability audit shows no other burn signal (no bounce
// surge, no hard-fail surge, no reputation collapse). Anything else is left resting.
// Run inside the app image:
//   docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//     --entrypoint node recruiteros-app /tools/clear-dkim-false-benches.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import dns from "node:dns/promises";

const REST_FILE = "/data/snap_mpc_domain_rest_v1.json";
const DELIV_FILE = "/data/snap_mpc_deliverability_v1.json";

const DKIM_SELECTORS = ["selector1", "selector2", "google", "dkim", "default", "s1", "s2", "k1"];
async function dkimLive(domain) {
  for (const sel of DKIM_SELECTORS) {
    try { await dns.resolveCname(`${sel}._domainkey.${domain}`); return sel; } catch { /* try TXT */ }
    try { const t = (await dns.resolveTxt(`${sel}._domainkey.${domain}`)).map((r) => r.join("")); if (t.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) return sel; } catch { /* next */ }
  }
  return null;
}

if (!existsSync(REST_FILE)) { console.log("no rest ledger; nothing to do"); process.exit(0); }
const ledger = JSON.parse(readFileSync(REST_FILE, "utf8"));
const audit = existsSync(DELIV_FILE) ? JSON.parse(readFileSync(DELIV_FILE, "utf8")) : { byDomain: [] };
const auditRow = new Map((audit.byDomain || []).map((r) => [String(r.domain || "").toLowerCase(), r]));

let cleared = 0;
for (const [d, v] of Object.entries(ledger.domains || {})) {
  if (!v || v.state !== "resting") continue;
  if (!/DKIM/i.test(String(v.reason || ""))) continue;
  const row = auditRow.get(d.toLowerCase());
  // Safety: any independent burn signal keeps the domain resting.
  const otherSignal = row && ((row.bounces >= 5 && row.bounces > (row.sent || 0) * 0.05) ||
    ((row.sent || 0) >= 20 && (row.hardFailRatePct || 0) > 5) ||
    (row.warmupReputationPct != null && row.warmupReputationPct < 70));
  if (otherSignal) { console.log(`  keep resting ${d} (independent burn signal present)`); continue; }
  const sel = await dkimLive(d);
  if (!sel) { console.log(`  keep resting ${d} (no DKIM record found on any selector — bench is real)`); continue; }
  v.state = "cleared";
  v.until = null;
  v.history = [...(v.history || []), {
    at: new Date().toISOString(), event: "cleared",
    reason: `manual repair: DKIM exists at ${sel}._domainkey; bench came from a wrong-selector probe, domain reputation untouched`,
  }].slice(-20);
  cleared++;
  console.log(`  CLEARED ${d} (DKIM live at ${sel}._domainkey)`);
}

if (cleared) {
  ledger.updatedAt = new Date().toISOString();
  const tmp = `${REST_FILE}.repair.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, REST_FILE);
}
console.log(`done: ${cleared} cleared`);
