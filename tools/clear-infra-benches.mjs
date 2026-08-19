// RecruitersOS · MPC · one-time repair (2026-08-18): un-bench domains condemned by API errors.
//
// Aug 15: followup.mjs replayed own-SMTP-lane follow-ups (ariel@) against the Sending.ac
// Mailbox API, where those boxes don't exist. Every attempt logged an HTTP 404 (plus some
// 429 burst limits) as result.ok=false, mpc-deliverability.mjs booked them as domain
// hard-fails, and domain-rest.mjs benched 14 healthy domains. No real mail was involved.
//
// This clears the rest ledger ONLY for domains that pass a hard safety check against the
// actual send ledgers: every single failed row for the domain is a 404/429 Mailbox-API
// error, and the domain has no real (SMTP/DSN class) failure at all. Anything with even
// one genuine failure is left resting. Run inside the app image:
//   docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//     -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app /tools/clear-infra-benches.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";

const REST_FILE = "/data/snap_mpc_domain_rest_v1.json";
const OUT_DIR = "/out";
const INFRA = /^(404|429):/;

// Tally per-domain failures from the send ledgers, split infra vs real.
const perDomain = new Map(); // domain -> { infraFails, realFails, ok }
for (const f of readdirSync(OUT_DIR).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${OUT_DIR}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (!r || !r.to_email || !r.from) continue;
    const d = String(r.from.split("@")[1] || "").toLowerCase(); if (!d) continue;
    const e = perDomain.get(d) || { infraFails: 0, realFails: 0, ok: 0 };
    if (r.result && r.result.ok) e.ok++;
    else if (INFRA.test(String((r.result && r.result.error) || ""))) e.infraFails++;
    else e.realFails++;
    perDomain.set(d, e);
  }
}

if (!existsSync(REST_FILE)) { console.log("no rest ledger; nothing to do"); process.exit(0); }
const ledger = JSON.parse(readFileSync(REST_FILE, "utf8"));
const domains = ledger.domains || {};
let cleared = 0;
for (const [d, v] of Object.entries(domains)) {
  if (!v || v.state !== "resting") continue;
  const t = perDomain.get(d.toLowerCase());
  // Safety: only clear when the ledgers show ZERO genuine failures for this domain and at
  // least one infra failure (i.e. the bench was manufactured entirely by 404/429 rows).
  if (!t || t.realFails > 0 || t.infraFails === 0) {
    console.log(`  keep resting ${d} (real fails: ${t ? t.realFails : "no rows"}, infra: ${t ? t.infraFails : 0})`);
    continue;
  }
  v.state = "cleared";
  v.until = null;
  v.history = [...(v.history || []), {
    at: new Date().toISOString(), event: "cleared",
    reason: `manual repair: all ${t.infraFails} failures were Mailbox-API 404/429 (no mail sent); domain reputation untouched`,
  }].slice(-20);
  cleared++;
  console.log(`  CLEARED ${d} (${t.infraFails} infra-only failures, ${t.ok} genuine accepts)`);
}
if (cleared) {
  const tmp = `${REST_FILE}.repair.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, REST_FILE);
}
console.log(`clear-infra-benches: ${cleared} domain(s) cleared, ledger ${cleared ? "written" : "untouched"}`);
