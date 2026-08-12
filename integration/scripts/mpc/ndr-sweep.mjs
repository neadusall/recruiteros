// RecruitersOS · MPC · fleet NDR sweep (the bounce-visibility layer).
//
// Bounce notices go to the SENDING mailbox, and the campaign sends from ~560 Sending.ac boxes,
// so the unified inbox (recruiter reply boxes only) sees almost none of them. This is how a 15%
// bounce rate displayed as "1 bounce" on 2026-08-12. This sweep reads every box used by the
// campaign in the last 14 days through the Mailbox API, collects campaign NDRs, and maintains
// /data/snap_mpc_ndr_v1.json:
//   - bounced[]  : recipients whose mail bounced -> followup.mjs stop-list (never touch again)
//   - perDomain  : bounce counts per SENDING domain -> mpc-deliverability.mjs -> domain-rest.mjs
//                  (a bouncing domain now benches within a rota cycle, not never)
// Runs from mpc-ndr-sweep.timer on the HOST (survives app-container swaps). Fail-open: an API
// outage leaves the previous sidecar in place; bounced[] only ever grows (merge on write).
//
//   SENDINGAC_MAILBOX_API_KEY=... node ndr-sweep.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";

const KEY = process.env.SENDINGAC_MAILBOX_API_KEY;
if (!KEY) { console.error("SENDINGAC_MAILBOX_API_KEY not set"); process.exit(1); }
const BASE = "https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0";
const OUT = process.env.MPC_OUT_DIR || "/opt/recruiteros/mpc-out";
const SIDECAR = process.env.MPC_NDR_FILE || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_ndr_v1.json";
const LOOKBACK_DAYS = Number(process.env.NDR_LOOKBACK_DAYS || 7);
const SINCE = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

// Boxes + recipients + per-domain send counts from the send logs (last 14 days of files).
const boxes = new Map(); // from -> sends
const sentTo = new Set();
const sentByDomain = new Map();
const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (!r || !r.to_email || (r.at && r.at < cutoff)) continue;
    sentTo.add(String(r.to_email).toLowerCase());
    if (r.from) {
      boxes.set(r.from, (boxes.get(r.from) || 0) + 1);
      const d = String(r.from).split("@")[1];
      if (d) sentByDomain.set(d, (sentByDomain.get(d) || 0) + 1);
    }
  }
}
const boxList = [...boxes.keys()];
console.log(`sweeping ${boxList.length} boxes, NDRs since ${SINCE.slice(0, 10)}`);

async function get(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after")) || 15;
      await new Promise((res) => setTimeout(res, Math.min(ra, 60) * 1000 + attempt * 2000));
      continue;
    }
    if (!r.ok) return { error: r.status };
    return r.json();
  }
  return { error: 429 };
}

const ndrs = [];
let errors = 0, swept = 0, i = 0;
async function worker() {
  while (i < boxList.length) {
    const email = boxList[i++];
    const enc = encodeURIComponent(email);
    try {
      let url = `${BASE}/users/${enc}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${SINCE}`)}&$select=from,subject,receivedDateTime,bodyPreview&$top=100`;
      let pages = 0;
      while (url && pages < 5) {
        const d = await get(url);
        if (d.error) { errors++; break; }
        for (const m of d.value || []) {
          const from = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || "").toLowerCase();
          const subj = String(m.subject || "");
          if (!(/postmaster@|mailer-daemon@/i.test(from) ||
                /^(undeliverable|delivery has failed|mail delivery failed|delivery status notification|message not delivered|failure notice|delivery failure)/i.test(subj))) continue;
          const rcpt = (String(m.bodyPreview || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [null])[0];
          ndrs.push({ box: email, rcpt, subj: subj.slice(0, 120), at: m.receivedDateTime });
        }
        url = d["@odata.nextLink"] || null;
        pages++;
      }
      swept++;
    } catch { errors++; }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
console.log(`swept ${swept}/${boxList.length} boxes (${errors} errors), ${ndrs.length} NDR notices`);

// Campaign NDRs only (recipient matches a logged send, or an all-lowercase campaign subject).
// FRESHNESS RULE for resting domains: a bench must be judged on bounces received AFTER it began.
// A resting domain sends nothing, so its pre-bench bounce count can only age, never improve; if
// those stale notices kept counting, revive-time "signals clean" could never pass and every
// 2-day bench would auto-extend to 7 then 14 days. Pre-bench notices still feed the suppression
// list (a dead address is dead forever); they just stop counting against the resting domain.
const REST_FILE = process.env.MPC_REST_FILE
  || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_domain_rest_v1.json";
const restSince = new Map(); // domain -> bench start (ms) while resting
try {
  const ledger = JSON.parse(readFileSync(REST_FILE, "utf8"));
  const nowMs = Date.now();
  for (const [d, v] of Object.entries(ledger.domains || {})) {
    if (v && v.state === "resting" && (!v.until || Date.parse(v.until) > nowMs) && v.since) {
      restSince.set(d.toLowerCase(), Date.parse(v.since));
    }
  }
} catch { /* no ledger: count everything */ }

const bounced = new Set();
const perDomain = {};
let warmupNdrs = 0, staleSkipped = 0;
for (const n of ndrs) {
  const rcpt = String(n.rcpt || "").toLowerCase();
  const subjLower = n.subj.replace(/^undeliverable:\s*/i, "");
  const looksCampaign = subjLower === subjLower.toLowerCase() && /[a-z]/.test(subjLower);
  const isCampaign = (rcpt && sentTo.has(rcpt)) || looksCampaign;
  if (!isCampaign) { warmupNdrs++; continue; }
  if (rcpt && sentTo.has(rcpt)) bounced.add(rcpt);
  const d = n.box.split("@")[1];
  const benchStart = restSince.get(d);
  if (benchStart && Date.parse(n.at || 0) < benchStart) { staleSkipped++; continue; }
  perDomain[d] = perDomain[d] || { bounces: 0, sent: sentByDomain.get(d) || 0 };
  perDomain[d].bounces++;
}
if (staleSkipped) console.log(`freshness rule: ${staleSkipped} pre-bench notices excluded from resting domains' counts`);

// Merge: bounced[] never shrinks (a narrower sweep must not forget old bounces).
if (existsSync(SIDECAR)) {
  try {
    const prev = JSON.parse(readFileSync(SIDECAR, "utf8"));
    for (const e of prev.bounced || []) bounced.add(e);
  } catch {}
}
const out = {
  generatedAt: new Date().toISOString(),
  source: "mailbox-api-ndr-sweep",
  boxesSwept: swept,
  warmupNdrs,
  bounced: [...bounced].sort(),
  perDomain,
};
const tmp = SIDECAR + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, SIDECAR);
console.log(`sidecar: ${out.bounced.length} bounced recipients, ${Object.keys(perDomain).length} domains with bounces`);
