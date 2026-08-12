// RecruitersOS · MPC · video watchers -> LinkedIn connect worklist.
//
// Closes the loop the owner asked for: "who opened/watched the video, so we send them a LinkedIn
// connection request." The watch page beacon records open/play/complete per videoKey WITH the
// recipient email (rcpt) we stamped on each link. This joins those events to the video-email ledger
// (who we emailed, which recruiter, company/role) and the LinkedIn-resolve ledger (their profile
// URL), then writes ONE snapshot the BD Reports UI reads + a connect action can fire from.
//
// Read-only over already-produced data (video-stats snapshot + send ledgers). No sends here; the
// actual connection request is fired by /api/mpc-connect (manual button) or the auto sweep below.
//
//   node scripts/mpc/mpc-watchers.mjs
//
// Output: /data/snap_mpc_watchers_v1.json  (person, company, role, recruiter, email, linkedin,
//         strongest event open<play<complete, watchedAt, connect status from /out/watch-connects.jsonl)

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const DATA = process.env.MPC_DATA_DIR || "/data";
const STATS = `${DATA}/snap_inmarket_video_stats_v1.json`;
// The connect ACTION is fired by the app (/api/mpc-connect), which records status to this snapshot
// in the shared /data store; the resolver reads it back for the UI's status column.
const CONNECTS = `${DATA}/snap_mpc_connects_v1.json`;
const SNAP = process.env.MPC_WATCHERS_FILE || `${DATA}/snap_mpc_watchers_v1.json`;
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const KEEP_DAYS = Number(process.env.MPC_WATCHERS_KEEP_DAYS || 30);

const lc = (s) => String(s || "").toLowerCase().trim();
const strength = { open: 1, play: 2, complete: 3 };

// Who we emailed a video to: email -> { name, title, company, role, recruiter, videoKey, at }.
// Both touch-2 video sends (kind:video2) and, as a fallback, the videoKey->company/role from touch 1.
function loadEmailed() {
  const byEmail = new Map();
  if (!existsSync(OUT)) return byEmail;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (!r || !r.to_email) continue;
        const isVideo = r.kind === "video2" || r.touch === 2 || r.videoKey;
        if (!isVideo) continue;
        byEmail.set(lc(r.to_email), {
          name: r.to_name || "", title: r.to_title || "", company: r.company || "", role: r.role || "",
          recruiter: r.from_owner || "", videoKey: r.videoKey || "", emailedAt: r.at || "",
        });
      } catch { /* skip */ }
    }
  }
  return byEmail;
}

// LinkedIn profile URL per emailed person, from the resolve ledger.
function loadLinkedIn() {
  const byEmail = new Map();
  try {
    for (const line of readFileSync(`${OUT}/leads-linkedin.jsonl`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        const email = lc(r.email || r.to_email);
        const url = r.linkedin_url || r.linkedinUrl || r.url || "";
        if (email && url && r.status !== "no_match") byEmail.set(email, url);
      } catch { /* skip */ }
    }
  } catch { /* no resolve ledger yet */ }
  return byEmail;
}

// Connect status per email, from the app-written connects snapshot (latest wins).
function loadConnectStatus() {
  const byEmail = new Map();
  try {
    const s = JSON.parse(readFileSync(CONNECTS, "utf8"));
    for (const r of (s.items || [])) {
      if (r && r.email) byEmail.set(lc(r.email), { status: r.status || "sent", at: r.at, by: r.by || "" });
    }
  } catch { /* none yet */ }
  return byEmail;
}

function loadWatchEvents() {
  // email -> { strongest event, lastAt }. Reads the video-stats recent-events feed.
  const byEmail = new Map();
  let st;
  try { st = JSON.parse(readFileSync(STATS, "utf8")); } catch { return byEmail; }
  for (const ev of (st.feed || [])) {
    const rcpt = lc(ev.recipient);
    if (!rcpt || rcpt.indexOf("@") < 0) continue; // only person-attributed events
    if (!["open", "play", "complete"].includes(ev.type)) continue;
    const cur = byEmail.get(rcpt) || { event: "open", at: ev.at, strength: 0 };
    const sN = strength[ev.type] || 0;
    if (sN >= cur.strength) { cur.event = ev.type; cur.strength = sN; }
    if ((ev.at || "") > (cur.at || "")) cur.at = ev.at;
    byEmail.set(rcpt, cur);
  }
  return byEmail;
}

const emailed = loadEmailed();
const linkedin = loadLinkedIn();
const connectSt = loadConnectStatus();
const watches = loadWatchEvents();

const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
const rows = [];
for (const [email, w] of watches) {
  if ((w.at || "") < cutoff) continue;
  const e = emailed.get(email);
  if (!e) continue; // watched but not one of our video-email recipients (shared link forward, etc.)
  const cs = connectSt.get(email);
  rows.push({
    email, name: e.name, title: e.title, company: e.company, role: e.role,
    recruiter: e.recruiter, linkedin: linkedin.get(email) || "",
    event: w.event, watchedAt: w.at,
    connectStatus: cs ? cs.status : (linkedin.get(email) ? "ready" : "no_profile"),
    connectAt: cs ? cs.at : "",
  });
}
// Strongest engagement + most recent first.
rows.sort((a, b) => (strength[b.event] - strength[a.event]) || (b.watchedAt || "").localeCompare(a.watchedAt || ""));

const summary = {
  watched: rows.length,
  played: rows.filter((r) => r.event === "play" || r.event === "complete").length,
  completed: rows.filter((r) => r.event === "complete").length,
  connectSent: rows.filter((r) => ["sent", "accepted"].includes(r.connectStatus)).length,
  accepted: rows.filter((r) => r.connectStatus === "accepted").length,
  readyNoProfile: rows.filter((r) => r.connectStatus === "no_profile").length,
};
const snap = { workspaceId: WS, generatedAt: new Date().toISOString(), summary, watchers: rows.slice(0, 300) };
writeFileSync(SNAP + ".tmp", JSON.stringify(snap, null, 2));
renameSync(SNAP + ".tmp", SNAP);
console.log(`mpc-watchers -> ${rows.length} watchers (played ${summary.played}, completed ${summary.completed}) | connect sent ${summary.connectSent}, accepted ${summary.accepted}`);
for (const r of rows.slice(0, 5)) console.log(`  ${r.name || r.email} · ${r.company} · ${r.event} · via ${r.recruiter} · ${r.connectStatus}`);
