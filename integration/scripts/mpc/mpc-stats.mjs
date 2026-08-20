// RecruitersOS · MPC · stats aggregator (the BD cockpit data layer).
//
// The finance engine runs OUTSIDE the app's native pipeline (Sending.ac sends via tool logs in
// /out, free ATS sourcing + reply bridge in /data), so the portal Dashboard can't see it. This
// rolls all of it into ONE snapshot the app reads (snap_mpc_stats_v1.json), so the BD cockpit
// shows real activity: sends, reply rate BY VARIANT (what's working), replies by sentiment, clean
// supply ready, and free boards discovered. One source of truth, no double-counting.
//
// Reads only already-produced data (send logs + the reply ledger + the bridged inbox + curation),
// no API calls.
//   node /opt/recruiteros/tools/mpc-stats.mjs

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

// ===========================================================================
// WHO REPLIED - two sources, one truth.
//
// THE DURABLE RECORD is /out/replies-*.jsonl, appended by monitor.mjs on every sweep. A row
// lands there only when an inbound sender EXACTLY matches an address that same box emailed, so
// warm-up network chatter can never enter it, and it stays on disk forever.
//
// THE UNIFIED INBOX (snap_inbox.json) is a live, mutable, capped UI store that ALSO carries
// hundreds of warm-up messages a day. A real reply can be deleted from it by a recruiter or
// crowded out of it entirely. Reading replies from the inbox alone is exactly what made this
// Dashboard report "0 replies / 0%" against 2,177 sends while nine people had actually written
// back: not one identity-verified row survived in the inbox.
//
// So the LEDGER decides WHO replied, and the inbox only supplies the sentiment label for the
// rows it still holds.
// ===========================================================================

// Free sentiment heuristics, a deliberate MIRROR of fastPath() in
// integration/lib/response/classify.ts - same patterns, same order - so a reply reads the same
// on the Dashboard as it does in the Reply center. No model call: this tool stays free and
// offline, and anything the heuristics do not recognise stays "unclassified" rather than being
// guessed into a hot label. Only the reply SUBJECT is available here, which is enough to catch
// the out-of-office family that dominates cold-email replies.
const RX_OPT_OUT = /\b(stop|unsubscribe|do not contact|remove me|opt[\s-]?out|take me off)\b/;
const RX_BOOKED = /\b(booked|calendly\.com|cal\.com\/|i picked|just grabbed a slot)\b/;
const RX_OOO = /\b(out of (the )?office|on vacation|annual leave|parental leave|maternity leave|paternity leave|automatic reply|auto[\s-]?repl(y|ied)|autoreply|away from (my )?(email|desk)|limited access to (my )?email|currently (out|away|traveling|travelling)|(will|i'll) (respond|reply|return) (when|on|upon)|delayed response)\b/;
function fastClass(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return "unclassified";
  if (RX_OPT_OUT.test(t)) return "stop";
  if (RX_BOOKED.test(t)) return "positive";
  if (RX_OOO.test(t.slice(0, 300))) return "auto_reply";
  return "unclassified";
}

// Identity-verified replies from the durable ledger: email -> newest sighting.
// Every sweep re-writes the matches it can still see, so one person appears across many files;
// keeping the newest sighting counts them exactly once.
function ledgerReplies() {
  const map = new Map();
  if (!existsSync(OUT)) return map;
  for (const f of readdirSync(OUT).filter((n) => /^replies-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        const email = String(r.to_email || "").toLowerCase().trim();
        if (!email) continue;
        const at = String(r.reply_at || "");
        const prev = map.get(email);
        if (!prev || at > prev.at) map.set(email, { at, subject: String(r.reply_subject || ""), variant: String(r.variant || "") });
      } catch { /* skip */ }
    }
  }
  return map;
}

// Bridged campaign replies already in the unified inbox: email -> sentiment class.
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
const ledger = ledgerReplies();
const inboxCls = inboxReplies();
// The reply set: everyone the ledger proves wrote back, plus anything the inbox bridged that the
// ledger has not seen. Where the inbox still holds the row, its real classification wins over the
// subject-line heuristic.
const replies = new Map();
for (const [email, hit] of ledger) replies.set(email, fastClass(hit.subject));
for (const [email, cls] of inboxCls) replies.set(email, cls);

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
    sentToday: 0, sentTotal: 0, repliesTotal: 0,
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
  // variant.replied = "sends of this angle that earned a reply", the leaderboard's own metric.
  // It is NOT the reply count: a person on touch 3 carries the same reply across three sends.
  if (replies.has(email)) s.replied++;
  const owner = canonOwner(r.from_owner || ownerByBox.get(String(r.from || "").toLowerCase().trim()) || "Unattributed");
  const rec = recFor(side, owner);
  rec.sentTotal++;
  if (isToday) rec.sentToday++;
  side.lastSenderByLead.set(email, owner);
  lastMotionByLead.set(email, motionOf(r));
}
// One reply = one person, counted once, on the side that last touched them. A reply whose send
// row is not in this ledger at all (a job blast, which the app sends and records itself) is
// placed by the ledger row's own variant; the app's /mpc-stats route then folds the matching
// portal-native SENDS into the same side, so the rate has a real denominator.
for (const [email, cls] of replies) {
  const known = lastMotionByLead.get(email);
  const fallback = String((ledger.get(email) || {}).variant || "") === "job_blast" ? "recruiting" : "bd";
  const side = sides[known || fallback];
  side.repliesTotal++;
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
  return {
    sentToday: side.sentToday, sentTotal: side.sentTotal, repliesTotal: side.repliesTotal,
    replyRate: side.sentTotal ? Math.round((side.repliesTotal / side.sentTotal) * 1000) / 10 : 0,
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
const totalReplied = bdSlice.repliesTotal + recruitingSlice.repliesTotal;

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
  // Where each reply number came from, so the daily audit (and a human) can tell a genuine
  // zero from a broken pipe without re-deriving anything.
  replySources: { ledger: ledger.size, inbox: inboxCls.size, counted: replies.size },
  // The BD/Recruiting split of THIS engine's ledger. The app's /mpc-stats route folds the
  // portal-native recruiting sends (job blasts, campaign cadences) into motions.recruiting,
  // so the Dashboard's Recruiting tab covers both paths.
  motions: { bd: bdSlice, recruiting: recruitingSlice },
};

const tmp = STATS_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(stats, null, 2));
renameSync(tmp, STATS_FILE);
console.log(`mpc-stats -> sent ${totalSent} (today ${sentToday}), replies ${totalReplied} (${stats.replyRate}%), supplyReady ${sendableNow}, boards ${boards}`);
console.log(`reply sources: ledger ${ledger.size} + inbox ${inboxCls.size} -> ${replies.size} distinct people`);
console.log(`by motion: BD today ${bdSlice.sentToday} / total ${bdSlice.sentTotal} / replies ${bdSlice.repliesTotal} | Recruiting today ${recruitingSlice.sentToday} / total ${recruitingSlice.sentTotal} / replies ${recruitingSlice.repliesTotal}`);
console.log("by variant:", variantRows.map((v) => `${v.variant} ${v.replied}/${v.sent} (${v.rate}%)`).join(" | "));
console.log("by recruiter:", recruiterRows.map((r) => `${r.name} today ${r.sentToday} / total ${r.sentTotal} / replies ${r.replies}`).join(" | "));
