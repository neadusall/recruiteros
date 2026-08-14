// RecruitersOS · System Health collector (the checks-and-balances layer).
//
// Born 2026-08-14 after a week of silent failures: bounce notices nobody read, a validation
// service dead since July over a chmod, a curation tick suiciding on its own watchdog. Every one
// was visible in a log or snapshot; none was visible to the owner. This collector turns every
// layer into an explicit check with a status the Owner Console renders at a glance:
//   good  = verified working          amber = degraded / needs attention soon
//   bad   = broken or actively risky
// It runs on the HOST (systemd timer, q15min) so it can see systemd, the docker volume, and the
// network, and it writes /data/snap_system_health_v1.json for /api/owner/system-health.
// The UI treats a snapshot older than 30 min as a RED banner: the collector watching the
// watchers is itself watched by the page.
//
//   node /opt/recruiteros/tools/system-health.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const VOL = "/var/lib/docker/volumes/recruiteros_app_data/_data";
const OUT_FILE = `${VOL}/snap_system_health_v1.json`;
const MPC_OUT = "/opt/recruiteros/mpc-out";
const ENV_FILE = "/opt/recruiteros/.env.production";

const now = Date.now();
const checks = [];
function add(group, id, name, status, reading, detail) {
  checks.push({ group, id, name, status, reading: String(reading), detail: detail ? String(detail) : "", checkedAt: new Date().toISOString() });
}
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function envVal(key) {
  try { const m = readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${key}=(.*)$`, "m")); return m ? m[1].trim() : ""; } catch { return ""; }
}
function ageMin(iso) { const t = Date.parse(iso || 0); return Number.isFinite(t) ? Math.round((now - t) / 60000) : null; }
function fmtAge(min) { return min == null ? "never" : min < 60 ? `${min}m ago` : min < 2880 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`; }

/* ---------------- sent-log facts (today volume, per-domain) ---------------- */
const today = new Date().toISOString().slice(0, 10);
let sentToday = 0;
const sentTo = new Set();
for (const f of readdirSync(MPC_OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try { const r = JSON.parse(s); if (r.to_email) { sentTo.add(String(r.to_email).toLowerCase()); if ((r.at || "").slice(0, 10) === today) sentToday++; } } catch {}
  }
}

/* ---------------- Sending & domains ---------------- */
const GROUP_SEND = "Sending & domains";

// Volume vs governor cap (same formula as batch.mjs).
const placement = readJson(`${VOL}/snap_mpc_placement_v1.json`);
const plAge = placement ? ageMin(placement.checkedAt) : null;
const plTotal = placement ? (placement.gmail?.inbox || 0) + (placement.gmail?.spam || 0) : 0;
const plPass = placement && plAge != null && plAge <= 7 * 1440 && plTotal > 0 && (placement.gmail.spam || 0) / plTotal <= 0.3;
{
  const RAMP_START = Date.parse("2026-08-13");
  const weeks = Math.max(0, (now - RAMP_START) / (7 * 86400000));
  const cap = Math.min(1500, Math.round(450 * (plPass ? Math.pow(1.2, weeks) : 1)));
  const utc = new Date().getUTCHours();
  const st = sentToday > cap ? "bad" : (utc >= 18 && sentToday === 0) ? "amber" : "good";
  add(GROUP_SEND, "volume", "Daily send volume", st, `${sentToday} sent / cap ${cap}`,
    sentToday > cap ? "Over the governor cap: investigate immediately" :
    st === "amber" ? "Zero sends late in the day usually means the supply funnel is starved" :
    "Governor: 450/day base, +20%/week while the seed test passes");
}

// Domain rest ledger.
const rest = readJson(`${VOL}/snap_mpc_domain_rest_v1.json`);
{
  const doms = Object.entries(rest?.domains || {});
  const resting = doms.filter(([, v]) => v?.state === "resting" && (!v.until || Date.parse(v.until) > now));
  const names = resting.map(([d]) => d);
  const st = resting.length > 20 ? "bad" : resting.length > 8 ? "amber" : "good";
  add(GROUP_SEND, "resting", "Domains resting (circuit breaker)", st, `${resting.length} resting`,
    names.length ? `Benched, warm-up continues, auto-revive: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` +${names.length - 6} more` : ""}` : "No domain currently benched");
}

// Fresh bounce pressure + suppression from the NDR sidecar.
const ndr = readJson(`${VOL}/snap_mpc_ndr_v1.json`);
{
  const fresh = Object.values(ndr?.perDomain || {}).reduce((s, v) => s + (v.bounces || 0), 0);
  const st = fresh >= 30 ? "bad" : fresh >= 10 ? "amber" : "good";
  add(GROUP_SEND, "bounces", "Fresh bounce pressure", ndr ? st : "bad", ndr ? `${fresh} recent notices` : "no sweep data",
    ndr ? `${(ndr.bounced || []).length} addresses on the permanent suppression list` : "NDR sweep has never produced a sidecar");
}

// Auth + warm-up from the deliverability snapshot.
const deliv = readJson(`${VOL}/snap_mpc_deliverability_v1.json`);
{
  const o = deliv?.overall;
  if (!o) add(GROUP_SEND, "auth", "Domain authentication (SPF/DKIM/DMARC)", "bad", "no data", "Deliverability snapshot missing");
  else {
    const authed = o.domainsFullyAuthed ?? 0, sending = o.domainsSending ?? 0;
    add(GROUP_SEND, "auth", "Domain authentication (SPF/DKIM/DMARC)", authed >= sending ? "good" : "amber",
      `${authed}/${sending} sending domains fully authed`, authed < sending ? "dns-authfix should repair overnight; recheck tomorrow" : "");
    const rep = o.warmupReputationPct;
    add(GROUP_SEND, "warmup", "Warm-up reputation", rep == null ? "amber" : rep >= 95 ? "good" : rep >= 85 ? "amber" : "bad",
      rep == null ? "unavailable" : `${rep}% fleet average`, rep == null ? "Smartlead API not reachable on last refresh" : "");
  }
}

// Seed placement test.
add(GROUP_SEND, "placement", "Gmail inbox placement (seed test)",
  !placement ? "amber" : plPass && plAge <= 5 * 1440 ? "good" : plPass ? "amber" : "bad",
  !placement ? "never run" : `${placement.gmail.inbox} inbox / ${placement.gmail.spam} spam, ${fmtAge(plAge)}`,
  !placement ? "Volume growth stays locked until a passing test exists" :
  !plPass ? "Failing or stale: growth locked, google-hosted prospects deferred" :
  plAge > 5 * 1440 ? "Passing but aging: expires at 7 days and locks growth" : "Feeds the volume governor and the Google gate");

/* ---------------- Supply pipeline ---------------- */
const GROUP_SUPPLY = "Supply pipeline";

const eng = readJson(`${VOL}/snap_inmarket_engine_health_v1.json`);
{
  const okTick = eng?.lastCurationOk === true;
  const engAge = eng ? ageMin(eng.lastCurationAt) : null;
  add(GROUP_SUPPLY, "tick", "Curation tick (enrichment engine)",
    !eng ? "bad" : okTick && engAge <= 30 ? "good" : okTick ? "amber" : "bad",
    !eng ? "no engine health data" : okTick ? `completing, last ${fmtAge(engAge)}` : `FAILING: ${eng.lastCurationError || "unknown error"}`,
    okTick ? "" : "Nothing downstream (managers, emails, validation) advances while this fails");
}

// Curation funnel numbers.
const cur = readJson(`${VOL}/snap_inmarket_curation_v1.json`);
{
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(cur || {});
  const rows = (arrs.sort((a, b) => b.length - a.length)[0] || []).map((r) => r.lead || r);
  let curatedToday = 0, validatedToday = 0, backlog = 0, sendable = 0;
  for (const r of rows) {
    const day = String(r.curatedAt || "").slice(0, 10);
    if (day === today) { curatedToday++; if (r.emailValidated === true) validatedToday++; }
    if (r.likelyEmail && !r.emailInvalid) {
      if (r.emailValidated !== true) backlog++;
      else if (!sentTo.has(String(r.likelyEmail).toLowerCase())) sendable++;
    }
  }
  add(GROUP_SUPPLY, "inflow", "New prospects curated today", curatedToday >= 300 ? "good" : curatedToday >= 50 ? "amber" : "bad",
    `${curatedToday} today`, "Sourcing belt output: watchlists, JD feeds, signals");
  add(GROUP_SUPPLY, "validated", "Emails validated today", validatedToday >= 200 ? "good" : validatedToday >= 50 ? "amber" : "bad",
    `${validatedToday} today`, "Reoon inline validation inside the curation tick");
  add(GROUP_SUPPLY, "backlog", "Validation backlog", backlog < 500 ? "good" : backlog < 2500 ? "amber" : "bad",
    `${backlog} awaiting validation`, backlog >= 500 ? "Drains automatically while the curation tick completes" : "");
  add(GROUP_SUPPLY, "sendable", "Validated prospects ready to send", sendable >= 450 ? "good" : sendable >= 100 ? "amber" : "bad",
    `${sendable} sendable now`, "Validated, never contacted; the send engine draws from this pool");
}

/* ---------------- Watchers (are the safety nets alive?) ---------------- */
const GROUP_WATCH = "Watchers & fail-safes";

const TIMERS = [
  ["mpc-daily.timer", "Daily send rota", 26 * 60],
  ["recruiteros-sending-health.timer", "Hourly sending health", 2 * 60],
  ["mpc-ndr-sweep.timer", "Bounce sweep (4-hourly)", 5 * 60],
  ["mpc-monitor.timer", "Reply monitor bridge", 3 * 60],
  ["email-validate-batch.timer", "Nightly bulk validation", 26 * 60],
  ["mpc-seed-test.timer", "Weekly seed placement test", 8 * 24 * 60],
  ["recruiteros-signals-watch.timer", "Signal watchlists (q15m)", 60],
];
for (const [unit, label, staleMin] of TIMERS) {
  try {
    const svc = unit.replace(/\.timer$/, ".service");
    const out = execFileSync("systemctl", ["show", unit, svc, "-p", "LastTriggerUSec,Result,ActiveState,ExecMainStatus,Id"], { encoding: "utf8" });
    if (!/Id=/.test(out)) throw new Error("unit not found");
    const blocks = out.split("\n\n");
    const timerBlock = blocks.find((b) => b.includes(unit)) || "";
    const svcBlock = blocks.find((b) => b.includes(svc)) || "";
    const trig = (timerBlock.match(/LastTriggerUSec=(.*)/) || [])[1] || "";
    const lastMs = trig && trig !== "n/a" ? Date.parse(trig.replace(/^[A-Za-z]+ /, "")) : NaN;
    const mins = Number.isFinite(lastMs) ? Math.round((now - lastMs) / 60000) : null;
    const svcResult = (svcBlock.match(/Result=(.*)/) || [])[1] || "";
    const enabled = /ActiveState=active/.test(timerBlock);
    const failed = svcResult && svcResult !== "success";
    const stale = mins == null || mins > staleMin;
    add(GROUP_WATCH, unit, label,
      !enabled ? "bad" : failed ? "bad" : stale ? "amber" : "good",
      !enabled ? "timer not active" : `last run ${fmtAge(mins)}${failed ? `, FAILED (${svcResult})` : ", ok"}`,
      failed ? "Last run exited with an error: check journalctl -u " + svc : stale && enabled ? "Overdue for its cadence" : "");
  } catch {
    add(GROUP_WATCH, unit, label, unit === "mpc-seed-test.timer" ? "amber" : "bad", "not installed", "Install the timer to activate this layer");
  }
}

// Snapshot freshness: the data the breaker and follow-ups act on.
add(GROUP_WATCH, "ndr-fresh", "Bounce data freshness", !ndr ? "bad" : ageMin(ndr.generatedAt) <= 360 ? "good" : "bad",
  ndr ? `swept ${fmtAge(ageMin(ndr.generatedAt))}` : "never", "Stale bounce data means the circuit breaker is flying blind");
const rq = readJson(`${VOL}/snap_mpc_reply_queue_v1.json`);
add(GROUP_WATCH, "replies", "Reply bridge freshness", Array.isArray(rq) ? "good" : "amber",
  Array.isArray(rq) ? `${rq.length} bridged replies on file` : "no queue file", "Replies from all sending boxes bridge into the app inbox");

/* ---------------- API credits & providers ---------------- */
const GROUP_API = "API credits & providers";

async function probe(name, id, fn, readingOnOk) {
  try { const r = await fn(); add(GROUP_API, id, name, r.status, r.reading ?? readingOnOk, r.detail || ""); }
  catch (e) { add(GROUP_API, id, name, "bad", "unreachable", String(e.message || e).slice(0, 120)); }
}

const SENDING_KEY = envVal("SENDINGAC_MAILBOX_API_KEY");
const REOON_KEY = envVal("REOON_API_KEY");
const SMARTLEAD_KEY = envVal("SMARTLEAD_API_KEY");

await probe("Sending.ac mailbox API", "sendingac", async () => {
  if (!SENDING_KEY) return { status: "bad", reading: "no key configured" };
  const r = await fetch("https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0/users/" + encodeURIComponent("nead.ryan@lumepeople.com") + "/mailFolders",
    { headers: { Authorization: "Bearer " + SENDING_KEY }, signal: AbortSignal.timeout(15000) });
  return r.ok ? { status: "good", reading: "reachable, authenticated" } : { status: "bad", reading: `HTTP ${r.status}`, detail: "Sends and the bounce sweep both depend on this API" };
});

await probe("Reoon validation credits", "reoon", async () => {
  if (!REOON_KEY) return { status: "bad", reading: "no key configured" };
  try {
    const r = await fetch(`https://emailverifier.reoon.com/api/v1/check-account-balance/?key=${encodeURIComponent(REOON_KEY)}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const d = await r.json();
      const credits = d.remaining_credits ?? d.credits ?? d.balance;
      if (credits != null) return { status: credits < 2000 ? "amber" : "good", reading: `${credits} credits remaining`, detail: credits < 2000 ? "Running low: validation stops when credits hit zero" : "" };
    }
  } catch { /* fall through to key-presence */ }
  return { status: "amber", reading: "key set, balance unknown", detail: "Balance endpoint unavailable; watch validated-today instead" };
});

await probe("Smartlead warm-up API", "smartlead", async () => {
  if (!SMARTLEAD_KEY) return { status: "amber", reading: "no key configured" };
  const r = await fetch(`https://server.smartlead.ai/api/v1/email-accounts/?api_key=${SMARTLEAD_KEY}&offset=0&limit=1`, { signal: AbortSignal.timeout(15000) });
  return r.ok ? { status: "good", reading: "reachable, authenticated" } : { status: "bad", reading: `HTTP ${r.status}`, detail: "Warm-up reputation readings depend on this API" };
});

for (const [key, label] of [["ANTHROPIC_API_KEY", "Anthropic key (email writer)"], ["RESEND_API_KEY", "Resend key (owner alerts)"], ["PORKBUN_API_KEY", "Porkbun key (DNS auto-fix)"]]) {
  add(GROUP_API, key, label, envVal(key) ? "good" : "amber", envVal(key) ? "configured" : "missing",
    envVal(key) ? "" : "The dependent automation silently skips its job without this");
}

/* ---------------- write ---------------- */
const order = ["bad", "amber", "good"];
checks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
const summary = { good: checks.filter((c) => c.status === "good").length, amber: checks.filter((c) => c.status === "amber").length, bad: checks.filter((c) => c.status === "bad").length };
const out = { generatedAt: new Date().toISOString(), summary, groups: [GROUP_SEND, GROUP_SUPPLY, GROUP_WATCH, GROUP_API], checks };
const tmp = OUT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, OUT_FILE);
console.log(`system health: ${summary.good} good / ${summary.amber} amber / ${summary.bad} bad (${checks.length} checks)`);
