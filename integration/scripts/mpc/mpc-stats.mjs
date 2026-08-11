// RecruitersOS · MPC · stats aggregator (the BD cockpit data layer).
//
// The finance engine runs OUTSIDE the app's native pipeline (Sending.ac sends via tool logs in
// /out, free ATS sourcing + reply bridge in /data), so the portal Dashboard can't see it. This
// rolls all of it into ONE snapshot the app reads (snap_mpc_stats_v1.json), so the BD cockpit
// shows real activity: sends, reply rate BY VARIANT (what's working), replies by sentiment, clean
// supply ready, and free boards discovered. One source of truth, no double-counting.
//
// Reads only already-produced data (send logs + the bridged inbox + curation), no API calls.
//   node scripts/mpc/mpc-stats.mjs

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { assessProspect } from "./gates.mjs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const INBOX_FILE = process.env.MPC_INBOX_FILE || "/data/snap_inbox.json";
const EXT_SLUGS = process.env.ATS_EXT_FILE || "/data/snap_inmarket_ats_slugs_ext_v1.json";
const STATS_FILE = process.env.MPC_STATS_FILE || "/data/snap_mpc_stats_v1.json";
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const today = new Date().toISOString().slice(0, 10);

function loadSent() {
  const rows = [];
  if (!existsSync(OUT)) return rows;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.result && r.result.ok && r.to_email) rows.push(r); } catch { /* skip */ }
    }
  }
  return rows;
}
function loadArray(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
    walk(s); return arrs.sort((a, b) => b.length - a.length)[0] || [];
  } catch { return []; }
}

// Bridged finance-campaign replies already in the unified inbox: email -> sentiment class.
function inboxReplies() {
  const map = new Map();
  try {
    const s = JSON.parse(readFileSync(INBOX_FILE, "utf8"));
    const items = s.items || (Array.isArray(s) ? s : []);
    for (const x of items) {
      const i = x.inbound || x;
      if (i.workspaceId !== WS || i.campaignId !== "mpc-finance") continue;
      const email = String(i.fromHandle || "").toLowerCase().trim();
      if (email) map.set(email, (x.classification && x.classification.class) || "unclassified");
    }
  } catch { /* inbox not readable */ }
  return map;
}

const sent = loadSent();
const replies = inboxReplies();

// Per-variant sent + replied + sentiment, keyed off the send log (variant lives there).
const variants = new Map();
const bump = (v) => { const s = variants.get(v) || { variant: v, sent: 0, replied: 0 }; variants.set(v, s); return s; };
let sentToday = 0;
const contacted = new Set();
for (const r of sent) {
  const v = r.variant || "unknown";
  const s = bump(v); s.sent++;
  const email = String(r.to_email || "").toLowerCase().trim();
  contacted.add(email);
  if ((r.at || "").slice(0, 10) === today) sentToday++;
  if (replies.has(email)) s.replied++;
}

// Replies by sentiment (positive / timing / not_interested / ...), across the campaign.
const bySentiment = {};
for (const cls of replies.values()) bySentiment[cls] = (bySentiment[cls] || 0) + 1;

// Clean supply: finance-era, passes every gate, not yet contacted = ready to send.
const curated = loadArray(CURATION).filter((r) => String((r.lead || r).curatedAt || "") >= SINCE);
let sendableNow = 0;
for (const r of curated) {
  const p = r.lead || r;
  if (assessProspect(p).eligible && !contacted.has(String(p.likelyEmail || "").toLowerCase().trim())) sendableNow++;
}

// Free boards discovered (ext directory) + a rough seed baseline.
let boards = 0;
try { const a = JSON.parse(readFileSync(EXT_SLUGS, "utf8")); if (Array.isArray(a)) boards = a.length; } catch { /* none yet */ }

const variantRows = [...variants.values()]
  .map((s) => ({ ...s, rate: s.sent ? Math.round((s.replied / s.sent) * 1000) / 10 : 0 }))
  .sort((a, b) => b.rate - a.rate || b.replied - a.replied);

const totalSent = sent.length;
const totalReplied = [...variants.values()].reduce((n, s) => n + s.replied, 0);

const stats = {
  generatedAt: new Date().toISOString(),
  workspaceId: WS,
  sentTotal: totalSent,
  sentToday,
  repliesTotal: totalReplied,
  replyRate: totalSent ? Math.round((totalReplied / totalSent) * 1000) / 10 : 0,
  repliesBySentiment: bySentiment,
  variants: variantRows,          // ranked by reply rate = what's working
  supplyReady: sendableNow,
  freeBoards: boards,
};

const tmp = STATS_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(stats, null, 2));
renameSync(tmp, STATS_FILE);
console.log(`mpc-stats -> sent ${totalSent} (today ${sentToday}), replies ${totalReplied} (${stats.replyRate}%), supplyReady ${sendableNow}, boards ${boards}`);
console.log("by variant:", variantRows.map((v) => `${v.variant} ${v.replied}/${v.sent} (${v.rate}%)`).join(" | "));
