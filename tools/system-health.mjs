// RecruitersOS · System Health collector (the checks-and-balances layer).
//
// Born 2026-08-14 after a week of silent failures; tightened same day after the first review:
// readings must survive an adversarial audit against ground truth, or the board is theater.
//   good  = verified working          amber = degraded / needs attention soon
//   bad   = broken or actively risky
// Runs on the HOST (systemd timer, q15min) so it can see systemd, the docker volume, and the
// network; writes /data/snap_system_health_v1.json for /api/owner/system-health. The UI treats
// a snapshot older than 30 min as a RED banner: the collector is itself watched.
//
//   node /opt/recruiteros/tools/system-health.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from "node:fs";
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

/* ---------------- sent-log facts (today volume, contacted set) ---------------- */
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

// Volume vs governor cap — same knobs batch.mjs honors (env-aware, no silent formula drift).
const placement = readJson(`${VOL}/snap_mpc_placement_v1.json`);
const plAge = placement ? ageMin(placement.checkedAt) : null;
const plTotal = placement ? (placement.gmail?.inbox || 0) + (placement.gmail?.spam || 0) : 0;
const plPass = placement && plAge != null && plAge <= 7 * 1440 && plTotal > 0 && (placement.gmail.spam || 0) / plTotal <= 0.3;
{
  const CAP_ENV = Number(envVal("MPC_DAILY_CAP") || 1800);
  const RAMP_START = Date.parse(envVal("MPC_RAMP_START") || "2026-08-13");
  const RAMP_BASE = envVal("MPC_RAMP_BASE") === "" ? 450 : Number(envVal("MPC_RAMP_BASE"));
  let cap = CAP_ENV;
  if (RAMP_BASE > 0 && Number.isFinite(RAMP_START)) {
    const weeks = Math.max(0, (now - RAMP_START) / (7 * 86400000));
    cap = Math.min(cap, Math.min(1500, Math.round(RAMP_BASE * (plPass ? Math.pow(1.2, weeks) : 1))));
  }
  const utc = new Date().getUTCHours();
  const st = sentToday > cap ? "bad" : (utc >= 18 && sentToday === 0) ? "amber" : "good";
  add(GROUP_SEND, "volume", "Daily send volume", st, `${sentToday} sent / cap ${cap}`,
    sentToday > cap ? "Over the governor cap: investigate immediately" :
    st === "amber" ? "Zero sends late in the day usually means the sendable pool is empty" :
    plPass ? "Governor: growth unlocked by the passing seed test" : "Governor holding base volume until a passing seed test exists");
}

// Domain rest ledger.
const rest = readJson(`${VOL}/snap_mpc_domain_rest_v1.json`);
{
  const doms = Object.entries(rest?.domains || {});
  const resting = doms.filter(([, v]) => v?.state === "resting" && (!v.until || Date.parse(v.until) > now));
  const names = resting.map(([d]) => d);
  const nextUp = resting.map(([, v]) => Date.parse(v.until || 0)).filter(Number.isFinite).sort()[0];
  const inMin = nextUp ? Math.round((nextUp - now) / 60000) : null;
  const nextTxt = inMin == null ? "n/a" : inMin <= 0 ? "due now (next breaker run)" : inMin < 60 ? `in ${inMin}m` : `in ${Math.round(inMin / 60)}h`;
  const st = resting.length > 20 ? "bad" : resting.length > 8 ? "amber" : "good";
  add(GROUP_SEND, "resting", "Domains resting (circuit breaker)", st, `${resting.length} resting`,
    names.length ? `Warm-up continues; next auto-revive ${nextTxt}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5} more` : ""}` : "No domain currently benched");
}

// Fresh bounce pressure + suppression from the NDR sidecar.
const ndr = readJson(`${VOL}/snap_mpc_ndr_v1.json`);
{
  const fresh = Object.values(ndr?.perDomain || {}).reduce((s, v) => s + (v.bounces || 0), 0);
  const st = fresh >= 30 ? "bad" : fresh >= 10 ? "amber" : "good";
  add(GROUP_SEND, "bounces", "Fresh bounce pressure", ndr ? st : "bad", ndr ? `${fresh} recent notices` : "no sweep data",
    ndr ? `${(ndr.bounced || []).length} addresses on the permanent suppression list` : "NDR sweep has never produced a sidecar");
}

// Google cold lane (Zapmail Gmail boxes): active fleet + today's throughput + failure rate.
{
  const snd = readJson(`${VOL}/snap_senders_v1.json`);
  const rows = snd?.inboxes || snd?.state?.inboxes || [];
  const gmail = rows.filter((m) => m && m.status === "active" && m.smtpPassEnc && /^smtp\.gmail\.com$/i.test(m.smtpHost || ""));
  const gset = new Set(gmail.map((m) => m.email));
  let gSent = 0, gFail = 0;
  for (const f of readdirSync(MPC_OUT).filter((n) => n.startsWith("sent-") && n.includes(today))) {
    for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r.from && gset.has(r.from) && (r.at || "").slice(0, 10) === today) { if (r.result?.ok) gSent++; else gFail++; } } catch {}
    }
  }
  const failPct = gSent + gFail ? Math.round((gFail / (gSent + gFail)) * 100) : 0;
  const st = !gmail.length ? "amber" : gSent + gFail >= 5 && failPct > 20 ? "bad" : "good";
  add(GROUP_SEND, "googlelane", "Google cold lane (Gmail boxes)", st,
    gmail.length ? `${gmail.length} boxes active · ${gSent} sent today${gFail ? `, ${gFail} failed` : ""}` : "no active Gmail boxes",
    !gmail.length ? "Lane is built but no Gmail box is active with working credentials" :
    gSent + gFail >= 5 && failPct > 20 ? "High failure rate: check Gmail SMTP auth (534/454) and the ramp caps" :
    "Per-box weekly ramp 8/14/20 with a 50/day per-domain ceiling; follow-ups share the caps");
}

// IMAP bounce sweep: the only bounce visibility for Gmail + internal-SMTP boxes.
{
  const im = readJson(`${VOL}/snap_mpc_ndr_imap_v1.json`);
  const age = im ? ageMin(im.generatedAt) : null;
  const st = !im ? "bad" : age <= 8 * 60 ? "good" : age <= 24 * 60 ? "amber" : "bad";
  add(GROUP_SEND, "imapsweep", "IMAP bounce sweep (Gmail + internal)", st,
    im ? `${im.boxesSwept ?? "?"} boxes swept ${fmtAge(age)}` : "never ran",
    st === "good" ? "" : "Without this sweep, bounces landing in Gmail/Mailcow inboxes are invisible to the stop-list and the domain breaker");
}

// Provider-block radar: fleet x receiving-provider pairs currently rejecting our servers.
// An active pair is NOT itself an alarm (routing already steers around it); the alarm is
// a MISSING or stale ledger, which would mean the radar went blind like pre-2026-08-19.
{
  const led = readJson(`${VOL}/snap_provider_blocks_v1.json`);
  const age = led ? ageMin(led.generatedAt) : null;
  const active = Object.values(led?.blocks || {}).filter((b) => b?.lastSeen && now - Date.parse(b.lastSeen) < 7 * 86400000);
  const st = !led ? "bad" : age > 26 * 60 ? "amber" : active.length ? "amber" : "good";
  add(GROUP_SEND, "providerblocks", "Provider-block radar (rejection pressure)", st,
    !led ? "no ledger" : active.length ? `${active.length} active: ${active.map((b) => `${b.fleet} blocked by ${b.provider}`).join(", ")}` : "no provider currently rejecting any fleet",
    !led ? "NDR sweeps have not written the block ledger; routing is flying blind on receiver-side blocks" :
    age > 26 * 60 ? "Ledger is stale (sweep not running?); routing may be steering on old data" :
    active.length ? "Routing steers these recipients to other fleets automatically; pairs release after 7 quiet days" :
    "Sweeps scan every bounce notice (campaign + warm-up) for IP/reputation block signatures");
}

// New Email ID onboarding audit: every imported sender is vetted (login, DNS posture,
// blocklists) before it can matter. Failures alert the owner and hold here until fixed.
{
  const ob = readJson(`${VOL}/snap_sender_onboarding_v1.json`);
  const last = ob?.runs?.[0];
  const fails = last?.failures?.length || 0;
  const st = !ob ? "amber" : fails ? "amber" : "good";
  add(GROUP_SEND, "onboarding", "New sender onboarding audit", st,
    !ob ? "no audits yet" : `last run ${fmtAge(ageMin(last?.at))}: ${last?.checked ?? 0} checked, ${fails} with problems`,
    !ob ? "No Email IDs have been imported since the audit layer shipped; first import will populate this" :
    fails ? `Problems: ${last.failures.slice(0, 3).map((f) => `${f.subject}: ${f.problems[0]}`).join(" | ")}` :
    "Imports are vetted for SMTP login, encoded-password traps, SPF/DMARC/MX posture, and blocklists");
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

// Candidate job blasts (Candidates tab): an active blast with people still queued
// must be moving; a blast that hasn't sent in over a day during the week means its
// clock or its inbox pool is broken.
{
  const blasts = readJson(`${VOL}/snap_job_blasts_v1.json`);
  if (Array.isArray(blasts) && blasts.length) {
    const active = blasts.filter((b) => b && b.status === "sending");
    const stuck = active.filter((b) => {
      const queued = (b.recipients || []).some((r) => r && r.status === "queued");
      const lastMin = ageMin(b.lastSendAt || b.updatedAt || b.createdAt);
      const weekday = ![0, 6].includes(new Date().getUTCDay());
      return queued && weekday && (lastMin == null || lastMin > 26 * 60);
    });
    add(GROUP_SEND, "jobblasts", "Candidate job blasts",
      stuck.length ? "amber" : "good",
      `${active.length} active / ${blasts.length} total${stuck.length ? `, ${stuck.length} stalled` : ""}`,
      stuck.length ? "A blast with queued candidates has not sent in over a day: check the sending cron and the recruiter's inbox pool" : "");
  }
}

/* ---------------- Supply pipeline ---------------- */
const GROUP_SUPPLY = "Supply pipeline";

const eng = readJson(`${VOL}/snap_inmarket_engine_health_v1.json`);
{
  const okTick = eng?.lastCurationOk === true;
  const engAge = eng ? ageMin(eng.lastCurationAt) : null;
  const bootAge = eng ? ageMin(eng.bootAt) : null;
  const warmingUp = !okTick && bootAge != null && bootAge <= 15;
  add(GROUP_SUPPLY, "tick", "Curation tick (enrichment engine)",
    !eng ? "bad" : okTick && engAge <= 30 ? "good" : warmingUp ? "amber" : okTick ? "amber" : "bad",
    !eng ? "no engine health data" :
    warmingUp ? `app restarted ${fmtAge(bootAge)}, first tick pending` :
    okTick ? `completing, last ${fmtAge(engAge)}` : `FAILING: ${eng.lastCurationError || "unknown error"}`,
    okTick || warmingUp ? "" : "Nothing downstream (managers, emails, validation) advances while this fails");
}

// Curation funnel numbers: rolling 24h windows (calendar-day counts lie at 1am),
// validatedAt for validation (a row curated Tuesday can validate Thursday).
const cur = readJson(`${VOL}/snap_inmarket_curation_v1.json`);
let gatesNote = "";
{
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(cur || {});
  const rows = (arrs.sort((a, b) => b.length - a.length)[0] || []).map((r) => r.lead || r);
  const h24 = now - 24 * 3600000;
  let curated24 = 0, validated24 = 0, backlog = 0;
  const candidates = [];
  for (const r of rows) {
    if (Date.parse(r.curatedAt || 0) >= h24) curated24++;
    if (Date.parse(r.validatedAt || 0) >= h24 && r.emailValidated === true) validated24++;
    if (r.likelyEmail && !r.emailInvalid) {
      if (r.emailValidated !== true) backlog++;
      else if (!sentTo.has(String(r.likelyEmail).toLowerCase())) candidates.push(r);
    }
  }
  // The honest "ready to send" number applies the SAME quality gates the sender applies —
  // the earlier version skipped them and read thousands while the real pool was 36.
  let passGates = 0, segDeferred = 0, gateRejected = 0;
  try {
    const g = await import("/opt/recruiteros/tools/gates.mjs");
    const mx = readJson(`${MPC_OUT}/mx-class.json`) || {};
    for (const r of candidates) {
      if (!g.assessProspect(r).eligible) { gateRejected++; continue; }
      const dom = String(r.likelyEmail).split("@")[1]?.toLowerCase();
      if (mx[dom]?.seg) { segDeferred++; continue; }
      passGates++;
    }
    gatesNote = `${gateRejected} fail quality gates, ${segDeferred} gateway-deferred`;
  } catch (e) {
    passGates = candidates.length;
    gatesNote = `gates module unavailable (${String(e.message).slice(0, 40)}): count is pre-gate`;
  }
  add(GROUP_SUPPLY, "inflow", "New prospects curated (24h)", curated24 >= 300 ? "good" : curated24 >= 50 ? "amber" : "bad",
    `${curated24} in 24h`, "Sourcing belt output: watchlists, JD feeds, signals");
  add(GROUP_SUPPLY, "validated", "Emails validated (24h)", validated24 >= 200 ? "good" : validated24 >= 50 ? "amber" : "bad",
    `${validated24} in 24h`, "Reoon inline validation inside the curation tick");
  add(GROUP_SUPPLY, "backlog", "Validation backlog", backlog < 500 ? "good" : backlog < 2500 ? "amber" : "bad",
    `${backlog} awaiting validation`, backlog >= 500 ? "Drains automatically while the curation tick completes" : "");
  add(GROUP_SUPPLY, "sendable", "Prospects ready to send (all gates applied)", passGates >= 450 ? "good" : passGates >= 100 ? "amber" : "bad",
    `${passGates} sendable now`, `Validated, never contacted, gate-passing. Of the rest: ${gatesNote}`);
}

/* ---------------- Watchers (are the safety nets alive?) ---------------- */
const GROUP_WATCH = "Watchers & fail-safes";

function unitProps(unit) {
  const out = execFileSync("systemctl", ["show", unit, "-p", "LastTriggerUSec,Result,ActiveState,SubState,ExecMainStatus,Id"], { encoding: "utf8" });
  const props = {};
  for (const line of out.split("\n")) { const i = line.indexOf("="); if (i > 0) props[line.slice(0, i)] = line.slice(i + 1); }
  return props;
}
const TIMERS = [
  ["mpc-daily.timer", "Daily send rota", 26 * 60],
  ["recruiteros-sending-health.timer", "Hourly sending health", 2 * 60],
  ["mpc-ndr-sweep.timer", "Bounce sweep (4-hourly)", 5 * 60],
  ["mpc-monitor.timer", "Reply monitor bridge", 3 * 60],
  ["email-validate-batch.timer", "Nightly bulk validation", 26 * 60],
  ["mpc-seed-test.timer", "Weekly seed placement test", 8 * 24 * 60],
  ["recruiteros-signals-watch.timer", "Signal watchlists (q15m)", 60],
  ["fleet-verify.timer", "Daily fleet verification", 26 * 60],
  ["system-health.timer", "This health collector", 45],
];
for (const [unit, label, staleMin] of TIMERS) {
  try {
    const t = unitProps(unit);
    if (!t.Id) throw new Error("unit not found");
    const s = unitProps(unit.replace(/\.timer$/, ".service"));
    const enabled = t.ActiveState === "active";
    const running = s.ActiveState === "activating" || s.ActiveState === "active";
    const trig = t.LastTriggerUSec && t.LastTriggerUSec !== "n/a" ? Date.parse(t.LastTriggerUSec.replace(/^[A-Za-z]{3} /, "")) : NaN;
    const mins = Number.isFinite(trig) ? Math.round((now - trig) / 60000) : null;
    const failed = !running && s.Result && s.Result !== "success";
    const stale = mins == null || mins > staleMin;
    add(GROUP_WATCH, unit, label,
      !enabled ? "bad" : failed ? "bad" : running ? "good" : stale ? "amber" : "good",
      !enabled ? "timer not active" :
      running ? `running now (triggered ${fmtAge(mins)})` :
      mins == null ? "never run yet" :
      `last run ${fmtAge(mins)}${failed ? `, FAILED (${s.Result})` : ", ok"}`,
      failed ? "Last run exited with an error: journalctl -u " + unit.replace(/\.timer$/, ".service") :
      !running && stale && enabled ? "Overdue for its cadence" : "");
  } catch {
    add(GROUP_WATCH, unit, label, unit === "system-health.timer" || unit === "mpc-seed-test.timer" ? "amber" : "bad",
      "not installed", "Install the timer to activate this layer");
  }
}

// Snapshot freshness: the data the breaker and follow-ups act on.
add(GROUP_WATCH, "ndr-fresh", "Bounce data freshness", !ndr ? "bad" : ageMin(ndr.generatedAt) <= 360 ? "good" : "bad",
  ndr ? `swept ${fmtAge(ageMin(ndr.generatedAt))}` : "never", "Stale bounce data means the circuit breaker is flying blind");

// Health guard + warm graduation heartbeat: the layer that auto-activates ready inboxes
// and benches sick ones. Runs from the hourly sending cron.
{
  const g = readJson(`${VOL}/snap_sender_health_guard_v1.json`);
  const rep = g?.lastReport;
  const age = rep ? ageMin(rep.at) : null;
  const hasGrad = !!rep && Object.prototype.hasOwnProperty.call(rep, "graduated");
  const st = !rep ? "bad" : age > 12 * 60 ? "bad" : age > 3 * 60 ? "amber" : "good";
  add(GROUP_WATCH, "graduation", "Health guard + warm graduation", st,
    rep ? `last run ${fmtAge(age)} · ${rep.holding ?? 0} on hold · ${(rep.graduated || []).length} graduated last run` : "never ran",
    !rep ? "Guard has never persisted a report" :
    !hasGrad ? "App predates the graduation feature: redeploy the app" :
    "Warming boxes auto-activate at 14d (provider) / 30d (internal) once reputation holds 95%+");
}

// Daily fleet verification results (the Fleet tab's data).
{
  const fleet = readJson(`${VOL}/snap_fleet_verify_v1.json`);
  const fAge = fleet ? ageMin(fleet.generatedAt) : null;
  const dU = fleet?.domainSummary?.unhealthy || 0, mU = fleet?.mailboxSummary?.unhealthy || 0;
  add(GROUP_WATCH, "fleet", "Fleet verification results",
    !fleet ? "amber" : fAge > 26 * 60 ? "bad" : dU + mU > 0 ? "amber" : "good",
    !fleet ? "never run" : `${dU} domains + ${mU} mailboxes unhealthy, swept ${fmtAge(fAge)}`,
    !fleet ? "Run once or install fleet-verify.timer" : dU + mU > 0 ? "Open the Fleet tab for each asset's reason and fix" : "");

  // Google warm-up pool (Zapmail) health, from the same daily verification.
  const w = fleet?.warmup;
  if (w) {
    const notWarming = w.summary?.unhealthy || 0;
    add(GROUP_SEND, "warmpool", "Google warm-up pool (Zapmail)",
      notWarming > 0 ? "bad" : (w.summary?.warning || 0) > 0 ? "amber" : "good",
      `${w.summary?.healthy || 0}/${w.poolSize} warming`,
      notWarming > 0 ? `${notWarming} fell out of warm-up: Fleet tab has the box list and fix` : `${w.byConn?.oauth || 0} via OAuth, ${w.byConn?.appPassword || 0} via app-password`);
  }
}

// Reply bridge: the monitor log is written as it scans, so its mtime is the honest heartbeat.
{
  const logs = readdirSync(MPC_OUT).filter((n) => /^monitor-.*\.log$/.test(n)).sort();
  const newest = logs[logs.length - 1];
  const mtimeMin = newest ? Math.round((now - statSync(`${MPC_OUT}/${newest}`).mtimeMs) / 60000) : null;
  add(GROUP_WATCH, "replies", "Reply bridge heartbeat", mtimeMin == null ? "bad" : mtimeMin <= 120 ? "good" : "amber",
    mtimeMin == null ? "no monitor log" : `scanning, last activity ${fmtAge(mtimeMin)}`,
    "Reads every sending box for replies; a full pass takes 40-60 min under API rate limits");
}

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
  const r = await fetch(`https://emailverifier.reoon.com/api/v1/check-account-balance/?key=${encodeURIComponent(REOON_KEY)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { status: "amber", reading: `balance HTTP ${r.status}`, detail: "Key may be fine; watch validated-24h instead" };
  const d = await r.json();
  const instant = Number(d.remaining_instant_credits);
  const daily = Number(d.remaining_daily_credits);
  if (!Number.isFinite(instant)) return { status: "amber", reading: "balance response unrecognized", detail: JSON.stringify(d).slice(0, 100) };
  return {
    status: instant < 500 ? "bad" : instant < 5000 ? "amber" : "good",
    reading: `${instant.toLocaleString("en-US")} instant credits (+${Number.isFinite(daily) ? daily.toLocaleString("en-US") : "?"} daily)`,
    detail: instant < 5000 ? "Running low: validation stops when credits hit zero" : "",
  };
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
const summary = { good: checks.filter((c) => c.status === "good").length, amber: checks.filter((c) => c.status === "amber").length, bad: checks.filter((c) => c.status === "bad").length };
const out = { generatedAt: new Date().toISOString(), summary, groups: [GROUP_SEND, GROUP_SUPPLY, GROUP_WATCH, GROUP_API], checks };
const tmp = OUT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, OUT_FILE);
console.log(`system health: ${summary.good} good / ${summary.amber} amber / ${summary.bad} bad (${checks.length} checks)`);
