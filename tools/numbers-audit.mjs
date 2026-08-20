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
import { execFileSync } from "node:child_process";

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
   4. THE REPLY CENTER'S SIGNAL. Warm-up chatter used to walk straight into the
   response store at ~1,200 rows a day and take the whole 3,000-row window;
   processInbound now tests every unproven email sender against the contacted
   set and drops what it cannot place, counting each one. So there are two
   ways this can go wrong, and they look nothing alike: nothing arriving at
   all (ingest is dead), or the filter dropping things it should keep.
   ========================================================================= */
{
  const inbox = readJson(`${VOL}/snap_inbox.json`);
  const items = (inbox && inbox.items) || [];
  const mine = items.filter((x) => (x.inbound || {}).workspaceId === WS);
  const real = mine.filter((x) => {
    const i = x.inbound || {};
    return i.prospectId || i.campaignId || i.verified;
  });
  const chatterByDay = ((inbox && inbox.chatter) || {})[WS] || {};
  const recentChatter = Object.keys(chatterByDay).sort().slice(-2).reduce((n, d) => n + (chatterByDay[d] || 0), 0);
  const filtering = Object.keys(chatterByDay).length > 0;
  const unverified = mine.length - real.length;

  // A dead ingest is the only real emergency: no rows AND nothing filtered means no mail is
  // being read at all. A store with few real replies is not a fault — nine people replied to
  // 2,223 sends, so a nearly-empty reply center is the honest shape of cold email.
  let status = "ok";
  let detail = "";
  if (!mine.length && !recentChatter) {
    status = "bad";
    detail = "Nothing is reaching the Reply center at all: no stored replies and no chatter filtered. Check the reply_sync and mpc_reply_ingest ticks.";
  } else if (!filtering && unverified > 500) {
    status = "warn";
    detail = "Unproven rows dominate the store and nothing is being filtered. The engine may not be publishing a contacted set (snap_mpc_contacted_v1.json), which is what lets the app tell a real reply from warm-up traffic.";
  } else if (unverified > 500) {
    status = "warn";
    detail = "The filter is running, but the store still holds the backlog that arrived before it. prune() drains it to the chatter quota on the watchdog tick.";
  }
  add("inboxsignal", "Reply center · real replies vs warm-up chatter", status,
    `${real.length} real / ${unverified} unproven held / ${recentChatter} chatter filtered (48h)`,
    detail);
}

/* =========================================================================
   5. ONE COPY OF EACH TOOL. The mechanism behind fault #2 was that every MPC
   tool existed twice: integration/scripts/mpc/<x> in the repo, and tools/<x>,
   which is the copy systemd actually runs. Both carried "keep both in sync"
   comments, and they were not in sync: the stale copy silently unshipped the
   Dashboard motion split for two days. That tree was deleted on 2026-08-20 and
   tools/ is now the only copy. This check keeps it that way, because the
   cheapest moment to stop it coming back is the day someone recreates it.

   It also catches the other half of the same fault: a tool RUNNING in prod that
   no commit has ever captured, which any rebuild would silently lose.
   ========================================================================= */
{
  const ghost = `${REPO}/integration/scripts/mpc`;
  let ghostFiles = [];
  try { ghostFiles = readdirSync(ghost); } catch { /* correctly absent */ }
  add("toolcopies", "Engine · one copy of each tool, and it is the one that runs",
    ghostFiles.length ? "bad" : "ok",
    ghostFiles.length ? `a second tool tree is back (${ghostFiles.length} files)` : "single tree",
    ghostFiles.length
      ? "integration/scripts/mpc/ has returned. Only tools/ is ever executed, so a change landing in that tree ships nothing. Delete it and make the change in tools/."
      : "");

  // Untracked-but-running: a tool systemd invokes that git has never seen.
  let untracked = [];
  try {
    untracked = execFileSync("git", ["-C", REPO, "ls-files", "--others", "--exclude-standard", "tools/"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^tools[/][^/]+[.](mjs|sh)$/.test(l));
  } catch { /* not a checkout, or git unavailable */ }
  add("toolstracked", "Engine · every running tool is in the repo", untracked.length ? "bad" : "ok",
    untracked.length ? `${untracked.length} untracked` : "all tracked",
    untracked.length
      ? `These run in production but no commit contains them, so a rebuild loses them: ${untracked.slice(0, 6).join(", ")}${untracked.length > 6 ? `, +${untracked.length - 6} more` : ""}`
      : "");
}

/* =========================================================================
   6. VIDEO. Two different numbers that are easy to confuse, so both are here.

   PRODUCTION is whether the engine can still make a video at all. Every video
   needs a REAL capture of the role's own posting — the synthetic role card was
   made opt-in on 2026-08-14 by owner mandate, so a page it cannot reach is a
   video that does not get made. Real captures have only ever succeeded ~11% of
   attempts, so this can quietly fall to zero without anything erroring.

   ENGAGEMENT is whether anyone watched. A quiet spell there is legitimate; a
   quiet spell that is really a production stoppage is not, and the two look
   identical from the engagement number alone. That is why production is read
   first: an empty board with nothing being produced is a supply problem.
   ========================================================================= */
{
  const since = new Date(now - 7 * 86400000).toISOString();
  const fails = readJson(`${VOL}/snap_inmarket_autovideo_fails_v1.json`) || {};
  const vids = readJson(`${VOL}/snap_inmarket_videos_v1.json`) || {};
  const failRecent = Object.values(fails).filter((v) => String((v || {}).at || "") >= since).length;
  const madeRecent = Object.values(vids).filter((v) => String((v || {}).at || "") >= since).length;
  const attempts = failRecent + madeRecent;
  const pct = attempts ? Math.round((100 * madeRecent) / attempts) : 0;
  // Reasons matter: a wall of "role not found" is a reachability problem worth acting on,
  // where scattered failures are just the long tail of the open web.
  const reasons = {};
  for (const v of Object.values(fails)) {
    if (String((v || {}).at || "") < since) continue;
    const r = String((v || {}).reason || "unknown").slice(0, 60);
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  const prodStatus = !attempts ? "warn" : madeRecent === 0 ? "bad" : pct < 10 ? "warn" : "ok";
  add("videoproduction", "PiP Studio · videos actually being produced", prodStatus,
    attempts ? `${madeRecent} made of ${attempts} attempts (${pct}%) in 7d` : "no attempts in 7d",
    prodStatus === "ok" ? ""
      : !attempts ? "The video engine has not tried to build anything this week."
      : `Every attempt failed. Videos require a real capture of the role's own posting (the synthetic role card is opt-in since 2026-08-14), so a pool of aggregator links produces nothing.${top ? ` Leading reason: ${top[0]} (${top[1]}).` : ""}`);

  const age = mtimeMin(`${VOL}/snap_inmarket_video_stats_v1.json`);
  // Engagement can only be judged when something was actually sent to be watched.
  // Judge engagement only once enough videos went out to expect a watch. Three videos in a
  // week producing no opens says nothing, and reporting it as a tracking fault would send the
  // reader hunting a broken beacon when the real story is upstream in production.
  const enoughToJudge = madeRecent >= 10;
  const engStatus = !enoughToJudge ? "ok" : age == null ? "warn" : age <= 3 * 1440 ? "ok" : "warn";
  add("videostats", "PiP Studio · video opens, visits, watchers", engStatus,
    `last engagement event ${fmtAge(age)}`,
    engStatus === "ok"
      ? (enoughToJudge ? "" : `Only ${madeRecent} video${madeRecent === 1 ? "" : "s"} went out this week, too few to read anything into the silence. The production row above is the one to act on.`)
      : "Videos are going out but nothing is being watched. Check that the watch links and the tracking beacon still resolve.");
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
