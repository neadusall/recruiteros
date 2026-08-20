// RecruitersOS · Numbers audit — does every number on the portal still tell the truth?
//
// WHY THIS EXISTS. On 2026-08-20 the Dashboard on app.lumesp.com reported "0 replies, 0% reply
// rate" against 2,177 sends. Nine people had actually written back. Nothing was broken loudly:
// the stats snapshot refreshed every 20 minutes, on time, with a confident zero in it. Two silent
// faults did it —
//   1. the reply count was read from the unified inbox, a capped UI store that warm-up traffic
//      fills at ~1,200 rows a day, so every identity-verified reply had been crowded out of it;
//   2. the BD/Recruiting split shipped in the app on 2026-08-18 but the copy of mpc-stats.mjs
//      that actually RUNS on the box was older than the repo's, so the `motions` field it needed
//      was never written and the Recruiting tab read empty.
// Both were invisible because nothing ever checked a portal number against the ground truth
// underneath it. This does, once a day, and says so out loud when they disagree.
//
// Runs on the HOST (systemd timer) so it can see the docker volume, the tool output logs, and
// the repo checkout. Writes /data/snap_numbers_audit_v1.json for the System Health board, and
// emails the owner ONLY when the verdict gets worse than the last run (a standing problem must
// not mail every day, or the alert stops being read).
//
//   node /opt/recruiteros/tools/numbers-audit.mjs

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, renameSync } from "node:fs";

const VOL = process.env.ROS_VOLUME || "/var/lib/docker/volumes/recruiteros_app_data/_data";
const MPC_OUT = process.env.MPC_OUT_DIR || "/opt/recruiteros/mpc-out";
const REPO = process.env.ROS_REPO_DIR || "/opt/recruiteros";
const OUT_FILE = `${VOL}/snap_numbers_audit_v1.json`;
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const OWNER_TO = process.env.OWNER_EMAIL || "neadusall@gmail.com";
const MAIL_FROM = process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>";
const RESEND_KEY = process.env.RESEND_API_KEY || "";

const now = Date.now();
const findings = [];
/** status: "ok" | "warn" | "bad". `surface` is what a human would point at in the portal. */
function add(id, surface, status, reading, detail) {
  findings.push({ id, surface, status, reading: String(reading), detail: detail ? String(detail) : "" });
}
const RANK = { ok: 0, warn: 1, bad: 2 };

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function mtimeMin(p) { try { return Math.round((now - statSync(p).mtimeMs) / 60000); } catch { return null; } }
function fmtAge(min) { return min == null ? "never written" : min < 60 ? `${min}m ago` : min < 2880 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`; }

/* =========================================================================
   1. FRESHNESS — every snapshot a portal number is drawn from.
   The window is the writer's own cadence plus room for one missed run, so a
   single skipped tick is quiet and a stopped writer is loud.
   ========================================================================= */
const SURFACES = [
  ["mpc_stats_v1",            "Dashboard · sends, reply rate, per-recruiter roster", 90,        "mpc-monitor.timer (20m) -> tools/mpc-stats.mjs"],
  ["mpc_sent_v1",             "Sent · the real messages the engine sent",            90,        "mpc-monitor.timer (20m) -> tools/mpc-sent-log.mjs"],
  ["growth_proposals_v1",     "Dashboard · Growth, idle demand + proposals",         90,        "mpc-monitor.timer (20m) -> tools/growth-engine.mjs"],
  ["site_visitors_v1",        "Dashboard · Who is on your site",                     90,        "mpc-monitor.timer (20m) -> tools/site-visitors.mjs"],
  ["mpc_schedule_v1",         "Dashboard · next/last send times",                    90,        "mpc-monitor.timer (20m) -> tools/publish-send-schedule.sh"],
  ["mpc_deliverability_v1",   "Dashboard · Deliverability, are they landing?",       26 * 60,   "mpc-monitor.timer + mpc-daily -> tools/mpc-deliverability.mjs"],
  ["outbound_rollups_v1",     "Outbound Performance · per-user daily rollups",       60,        "app scheduler, outbound tick (10m)"],
  ["system_health_v1",        "Admin · System Health board",                         45,        "system-health.timer (15m)"],
  // The advisor is one LLM read of the engine; the daily runner now writes it every day, but a
  // weekend-only gap was normal before, so the window stays generous rather than crying wolf.
  ["mpc_advisor_v1",          "Dashboard · Advisor, how to move the needle",         3 * 1440,  "recruiteros-numbers.timer (daily) -> tools/mpc-advisor.mjs"],
];
for (const [key, surface, maxMin, writer] of SURFACES) {
  const p = `${VOL}/snap_${key}.json`;
  const age = mtimeMin(p);
  const status = age == null ? "bad" : age <= maxMin ? "ok" : age <= maxMin * 3 ? "warn" : "bad";
  add(`fresh:${key}`, surface, status, fmtAge(age),
    status === "ok" ? "" : `Expected a refresh at least every ${maxMin < 60 ? `${maxMin}m` : `${Math.round(maxMin / 60)}h`}. Writer: ${writer}`);
}

/* =========================================================================
   2. SENDS — the Dashboard's number vs the send ledger it claims to summarise.
   ========================================================================= */
function sentLedger() {
  const rows = [];
  if (!existsSync(MPC_OUT)) return rows;
  for (const f of readdirSync(MPC_OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.result && r.result.ok && r.to_email) rows.push(r); } catch { /* skip */ }
    }
  }
  return rows;
}
/** Distinct people who wrote back, straight from the durable reply ledger:
 *  email -> the EARLIEST time we saw them reply (so an "as of the snapshot" count is exact). */
function ledgerRepliers() {
  const map = new Map();
  if (!existsSync(MPC_OUT)) return map;
  for (const f of readdirSync(MPC_OUT).filter((n) => /^replies-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        const e = String(r.to_email || "").toLowerCase().trim(); if (!e) continue;
        const at = String(r.reply_at || "");
        const prev = map.get(e);
        if (prev === undefined || at < prev) map.set(e, at);
      } catch { /* skip */ }
    }
  }
  return map;
}

const stats = readJson(`${VOL}/snap_mpc_stats_v1.json`);
const sent = sentLedger();
const repliers = ledgerRepliers();

if (!stats) {
  add("sends", "Dashboard · Sent today / Sent total", "bad", "no stats snapshot", "tools/mpc-stats.mjs has never produced a snapshot.");
} else {
  const claimed = Number(stats.sentTotal || 0);
  // Compare like with like. The engine keeps sending between the snapshot being written and this
  // audit reading the ledger, so the raw ledger is legitimately AHEAD; counting only the sends
  // that had already happened when the snapshot was stamped removes that lag entirely, and any
  // difference left over is a real fault in the aggregator rather than the clock.
  const asOf = String(stats.generatedAt || "");
  const truth = asOf ? sent.filter((r) => String(r.at || "") <= asOf).length : sent.length;
  const drift = Math.abs(claimed - truth);
  const status = truth === 0 ? "warn" : drift <= 2 ? "ok" : drift <= Math.max(5, truth * 0.01) ? "warn" : "bad";
  add("sends", "Dashboard · Sent today / Sent total", status,
    `${claimed} shown / ${truth} in the ledger as of the snapshot${sent.length !== truth ? ` (${sent.length} sent since)` : ""}`,
    status === "ok" ? "" : truth === 0 ? "No successful sends in /out at all: this is a sending problem, not a counting one."
      : `The Dashboard is off by ${drift} sends. tools/mpc-stats.mjs reads the same /out/sent-*.jsonl files this audit did.`);
}

/* =========================================================================
   3. REPLIES — the fault that started all this. A zero here must be a real
   zero, never a broken pipe. The reply ledger is the ground truth: a row
   lands in it only when an inbound sender matches an address that same box
   emailed, so it cannot be inflated by warm-up traffic.
   ========================================================================= */
if (stats) {
  const claimed = Number(stats.repliesTotal || 0);
  // Same as-of rule as the send count: only people who had already replied when the snapshot was
  // stamped can be expected to appear in it.
  const asOfR = String(stats.generatedAt || "");
  const truth = asOfR ? [...repliers.values()].filter((at) => at <= asOfR).length : repliers.size;
  const status = claimed === truth ? "ok" : (claimed === 0 && truth > 0) ? "bad" : "warn";
  add("replies", "Dashboard · Reply rate, replies by sentiment, variant leaderboard", status,
    `${claimed} shown / ${truth} in the reply ledger`,
    status === "ok" ? ""
      : claimed === 0
        ? `REPLY TRACKING IS DARK: ${truth} people wrote back and the portal shows none. Every reply-rate number on the Dashboard is a false zero.`
        : `The Dashboard and the reply ledger disagree by ${Math.abs(claimed - truth)}.`);

  // The BD/Recruiting split: present, or the Recruiting tab silently reads empty.
  const m = stats.motions;
  const okSplit = !!(m && m.bd && m.recruiting);
  add("motions", "Dashboard · Business dev vs Recruiting tabs", okSplit ? "ok" : "bad",
    okSplit ? `BD ${m.bd.sentTotal} sent / ${m.bd.repliesTotal} replies · Recruiting ${m.recruiting.sentTotal} / ${m.recruiting.repliesTotal}` : "no motions field",
    okSplit ? "" : "The stats snapshot carries no motion split, so the Recruiting tab shows the app's own sends only and none of the engine's. The running tools/mpc-stats.mjs is older than the app that reads it.");
}

/* =========================================================================
   4. THE INBOX FLOOD — the condition that hid the replies. Warm-up chatter in
   the response store is expected; a store with NO identity-verified reply left
   in it means the reply center is showing a recruiter nothing but noise.
   ========================================================================= */
{
  const inbox = readJson(`${VOL}/snap_inbox.json`);
  const items = (inbox && inbox.items) || [];
  const mine = items.filter((x) => (x.inbound || {}).workspaceId === WS);
  const real = mine.filter((x) => (x.inbound || {}).prospectId || (x.inbound || {}).campaignId);
  const pct = mine.length ? Math.round((100 * real.length) / mine.length) : 0;
  // BAD is reserved for "nothing is arriving at all", which means ingest itself has died. A store
  // dominated by warm-up chatter is a known, understood condition: replySync only recognises this
  // system's own warm-up tag, and the fleet warms through Smartlead, whose traffic carries no such
  // tag. It is worth saying every day, but it is not an outage, and a permanent red on this board
  // would only teach the operator to stop reading it.
  const status = !mine.length ? "bad" : real.length === 0 || pct < 2 ? "warn" : "ok";
  add("inboxsignal", "Reply center · real replies vs warm-up chatter", status,
    `${real.length} identity-verified of ${mine.length} rows (${pct}%)`,
    status === "ok" ? ""
      : !mine.length
        ? "The response store is empty: nothing is reaching the Reply center at all. Check the reply_sync and mpc_reply_ingest ticks."
        : real.length === 0
          ? "Not one identity-verified reply is left in the response store; warm-up traffic fills the whole window. The Dashboard no longer depends on this (it counts from the durable reply ledger), but the Reply center itself is showing a recruiter mostly chatter."
          : "Warm-up traffic dominates the response store. Real replies are protected from eviction, but the recruiter's view is mostly chatter.");
}

/* =========================================================================
   5. TOOL DRIFT — the mechanism behind fault #2. Every MPC tool exists twice:
   integration/scripts/mpc/<x> in the repo, and tools/<x>, which is the copy
   systemd actually runs. When they differ, a shipped feature may never have
   run in production. Cheap to check, and it is exactly what went unnoticed.
   ========================================================================= */
{
  const A = `${REPO}/tools`, B = `${REPO}/integration/scripts/mpc`;
  const drifted = [];
  let compared = 0;
  try {
    for (const f of readdirSync(B)) {
      const a = `${A}/${f}`, b = `${B}/${f}`;
      if (!existsSync(a)) continue;
      compared++;
      try { if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) drifted.push(f); } catch { /* unreadable */ }
    }
  } catch { /* one of the trees is absent */ }
  // Drift is not automatically wrong (tools/ is usually the newer, live copy), but every
  // instance is a place where "shipped" and "running" can quietly diverge.
  const status = !compared ? "warn" : drifted.length === 0 ? "ok" : "warn";
  add("tooldrift", "Engine · the tool that runs vs the tool in the repo", status,
    compared ? `${drifted.length} of ${compared} duplicated tools differ` : "could not compare the two trees",
    drifted.length ? `Only tools/ runs. Check the direction of each difference before trusting a feature to be live: ${drifted.slice(0, 8).join(", ")}${drifted.length > 8 ? `, +${drifted.length - 8} more` : ""}` : "");
}

/* =========================================================================
   6. VIDEO ENGAGEMENT — PiP Studio's numbers are event-driven, so a quiet spell
   is legitimate. Long silence usually means renders stopped, not that nobody
   watched, so it is reported rather than assumed.
   ========================================================================= */
{
  const age = mtimeMin(`${VOL}/snap_inmarket_video_stats_v1.json`);
  const status = age == null ? "warn" : age <= 3 * 1440 ? "ok" : "warn";
  add("videostats", "PiP Studio · video opens, visits, watchers", status, `last engagement event ${fmtAge(age)}`,
    status === "ok" ? "" : "No video engagement recorded for days. Check whether video emails are still rendering and going out before reading this as low interest.");
}

/* ---------------- verdict, snapshot, edge-triggered owner alert ---------------- */
const worst = findings.reduce((w, f) => (RANK[f.status] > RANK[w] ? f.status : w), "ok");
const summary = {
  ok: findings.filter((f) => f.status === "ok").length,
  warn: findings.filter((f) => f.status === "warn").length,
  bad: findings.filter((f) => f.status === "bad").length,
};
const prev = readJson(OUT_FILE);
const prevWorst = prev && prev.verdict ? prev.verdict : "ok";
const out = { generatedAt: new Date().toISOString(), workspaceId: WS, verdict: worst, summary, findings };
const tmp = OUT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, OUT_FILE);
console.log(`numbers-audit -> ${worst.toUpperCase()} (${summary.ok} ok / ${summary.warn} warn / ${summary.bad} bad)`);
for (const f of findings) if (f.status !== "ok") console.log(`  [${f.status}] ${f.surface}: ${f.reading}${f.detail ? ` -- ${f.detail}` : ""}`);

async function mailOwner() {
  const troubled = findings.filter((f) => f.status !== "ok");
  const subject = worst === "bad"
    ? `RecruitersOS: a portal number is wrong (${summary.bad} broken)`
    : `RecruitersOS: a portal number needs a look (${summary.warn} degraded)`;
  const text = [
    worst === "bad"
      ? "One or more numbers on the portal do not match the data underneath them. Until this is fixed, treat the affected figures as unreliable rather than as a real result."
      : "One or more numbers on the portal are going stale or drifting from their source.",
    "",
    ...troubled.map((f) => `${f.status.toUpperCase()} · ${f.surface}\n  ${f.reading}${f.detail ? `\n  ${f.detail}` : ""}`),
    "",
    "Full detail: Admin > System Health, group \"Numbers & tracking\".",
    "This email is sent only when the verdict gets worse, so a known problem will not repeat it daily.",
  ].join("\n");
  if (!RESEND_KEY) { console.log(`RESEND_API_KEY not set; owner email skipped (${subject})`); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [OWNER_TO], subject, text }),
      signal: AbortSignal.timeout(20_000),
    });
    console.log(r.ok ? `owner emailed: ${subject}` : `owner email failed: http ${r.status}`);
  } catch (e) { console.log(`owner email failed: ${e?.message || e}`); }
}

// Edge-triggered: mail only on a step DOWN in verdict. A standing amber stays quiet after the
// first notice; a recovery is silent too, because the board already shows it.
if (RANK[worst] > RANK[prevWorst]) await mailOwner();
else if (worst !== "ok") console.log(`verdict ${worst} unchanged from last run; owner not re-emailed`);
