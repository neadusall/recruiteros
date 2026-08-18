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
const SENDERS = process.env.MPC_SENDERS_FILE || "/data/snap_senders_v1.json";
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
      // Any MPC-bridged campaign counts (mpc-finance = the BD lane; a recruiting lane
      // bridges under its own mpc-* id). The send ledger's motion decides the side.
      if (i.workspaceId !== WS || !/^mpc-/.test(String(i.campaignId || ""))) continue;
      const email = String(i.fromHandle || "").toLowerCase().trim();
      if (email) map.set(email, (x.classification && x.classification.class) || "unclassified");
    }
  } catch { /* inbox not readable */ }
  return map;
}

const sent = loadSent();
const replies = inboxReplies();

// Sending mailbox -> owning recruiter, from the senders store snapshot. Newer send rows carry
// from_owner directly; this map back-fills the pre-fleet rows (which all went out on owned boxes
// that the snapshot still attributes), so attribution covers the whole ledger.
const ownerByBox = new Map();
try {
  const s = JSON.parse(readFileSync(SENDERS, "utf8"));
  for (const m of s.inboxes || (s.state && s.state.inboxes) || []) {
    if (m && m.email && m.ownerName) ownerByBox.set(String(m.email).toLowerCase().trim(), String(m.ownerName).trim());
  }
} catch { /* no senders snapshot: from_owner on the rows still attributes the fleet era */ }

// The senders store labels Ryan's boxes just "Ryan"; every identity elsewhere is the full name.
// One display name per person, or the roster splits into two rows.
const CANON_OWNER = { ryan: "Ryan Nead" };
const canonOwner = (o) => { const t = String(o || "").trim(); return CANON_OWNER[t.toLowerCase()] || t; };

// BD vs Recruiting split: both motions ride the SAME mailbox fleet, so the only truth
// about which side a send belongs to is the `motion` stamped on its ledger row (batch.mjs /
// followup.mjs). Rows that predate the stamp are all BD (this engine was BD-only then).
// Every stat below accumulates per side; the legacy top-level fields stay as the combined
// totals so nothing that reads the old shape breaks.
const motionOf = (r) => (r.motion === "recruiting" ? "recruiting" : "bd");
function newSide() {
  return {
    variants: new Map(), recruiters: new Map(), bySentiment: {},
    lastSenderByLead: new Map(), // lead email -> recruiter who last emailed them (gets the reply credit)
    sentToday: 0, sentTotal: 0,
  };
}
const sides = { bd: newSide(), recruiting: newSide() };
const bump = (side, v) => { const s = side.variants.get(v) || { variant: v, sent: 0, replied: 0 }; side.variants.set(v, s); return s; };
const recFor = (side, name) => { const s = side.recruiters.get(name) || { name, sentToday: 0, sentTotal: 0, replies: 0 }; side.recruiters.set(name, s); return s; };
const lastMotionByLead = new Map(); // lead email -> side of the last touch (a reply belongs to that side)
const contacted = new Set();
for (const r of sent) {
  const side = sides[motionOf(r)];
  const s = bump(side, r.variant || "unknown"); s.sent++;
  side.sentTotal++;
  const email = String(r.to_email || "").toLowerCase().trim();
  contacted.add(email);
  const isToday = (r.at || "").slice(0, 10) === today;
  if (isToday) side.sentToday++;
  if (replies.has(email)) s.replied++;
  const owner = canonOwner(r.from_owner || ownerByBox.get(String(r.from || "").toLowerCase().trim()) || "Unattributed");
  const rec = recFor(side, owner);
  rec.sentTotal++;
  if (isToday) rec.sentToday++;
  side.lastSenderByLead.set(email, owner);
  lastMotionByLead.set(email, motionOf(r));
}
for (const [email, cls] of replies) {
  const side = sides[lastMotionByLead.get(email) || "bd"];
  side.bySentiment[cls] = (side.bySentiment[cls] || 0) + 1;
  const owner = side.lastSenderByLead.get(email);
  if (owner) recFor(side, owner).replies++;
}
function sideRollup(side) {
  const variantRows = [...side.variants.values()]
    .map((s) => ({ ...s, rate: s.sent ? Math.round((s.replied / s.sent) * 1000) / 10 : 0 }))
    .sort((a, b) => b.rate - a.rate || b.replied - a.replied);
  const recruiterRows = [...side.recruiters.values()]
    .map((s) => ({ ...s, replyRate: s.sentTotal ? Math.round((s.replies / s.sentTotal) * 1000) / 10 : 0 }))
    .sort((a, b) => b.sentToday - a.sentToday || b.sentTotal - a.sentTotal);
  const repliesTotal = variantRows.reduce((n, v) => n + v.replied, 0);
  return {
    sentToday: side.sentToday, sentTotal: side.sentTotal, repliesTotal,
    replyRate: side.sentTotal ? Math.round((repliesTotal / side.sentTotal) * 1000) / 10 : 0,
    repliesBySentiment: side.bySentiment, variants: variantRows, recruiters: recruiterRows,
  };
}
const bdSlice = sideRollup(sides.bd);
const recruitingSlice = sideRollup(sides.recruiting);
const sentToday = sides.bd.sentToday + sides.recruiting.sentToday;

// Combined legacy views (both motions), same shapes as before the split.
const bySentiment = {};
for (const cls of replies.values()) bySentiment[cls] = (bySentiment[cls] || 0) + 1;
const variants = new Map();
for (const side of [sides.bd, sides.recruiting]) {
  for (const [k, v] of side.variants) {
    const s = variants.get(k) || { variant: k, sent: 0, replied: 0 };
    s.sent += v.sent; s.replied += v.replied; variants.set(k, s);
  }
}
const recruiters = new Map();
for (const side of [sides.bd, sides.recruiting]) {
  for (const [k, v] of side.recruiters) {
    const s = recruiters.get(k) || { name: k, sentToday: 0, sentTotal: 0, replies: 0 };
    s.sentToday += v.sentToday; s.sentTotal += v.sentTotal; s.replies += v.replies; recruiters.set(k, s);
  }
}
const recruiterRows = [...recruiters.values()]
  .map((s) => ({ ...s, replyRate: s.sentTotal ? Math.round((s.replies / s.sentTotal) * 1000) / 10 : 0 }))
  .sort((a, b) => b.sentToday - a.sentToday || b.sentTotal - a.sentTotal);

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
  recruiters: recruiterRows,      // who sent it: per-recruiter sends + reply credit
  supplyReady: sendableNow,
  freeBoards: boards,
  // The BD/Recruiting split of THIS engine's ledger. The app's /mpc-stats route folds the
  // portal-native recruiting sends (job blasts, campaign cadences) into motions.recruiting,
  // so the Dashboard's Recruiting tab covers both paths.
  motions: { bd: bdSlice, recruiting: recruitingSlice },
};

const tmp = STATS_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(stats, null, 2));
renameSync(tmp, STATS_FILE);
console.log(`mpc-stats -> sent ${totalSent} (today ${sentToday}), replies ${totalReplied} (${stats.replyRate}%), supplyReady ${sendableNow}, boards ${boards}`);
console.log(`by motion: BD today ${bdSlice.sentToday} / total ${bdSlice.sentTotal} / replies ${bdSlice.repliesTotal} | Recruiting today ${recruitingSlice.sentToday} / total ${recruitingSlice.sentTotal} / replies ${recruitingSlice.repliesTotal}`);
console.log("by variant:", variantRows.map((v) => `${v.variant} ${v.replied}/${v.sent} (${v.rate}%)`).join(" | "));
console.log("by recruiter:", recruiterRows.map((r) => `${r.name} today ${r.sentToday} / total ${r.sentTotal} / replies ${r.replies}`).join(" | "));
