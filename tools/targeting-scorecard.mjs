/**
 * RecruitersOS · TARGETING SCORECARD — what is actually working in cold outreach.
 *
 * The org chart (tools/orgchart.mjs) is a BELIEF until this file measures it. It asserts that a
 * Director replies more than a CEO and that a junior req belongs to a Manager. Published benchmarks
 * say so; this tool says whether it is true for OUR list, OUR copy and OUR desk.
 *
 * It joins the send ledgers to the reply ledgers and cuts reply rate by every targeting decision we
 * make: the seniority of the person we picked, the size tier of their employer, the function of the
 * req, the address rung that found them, and whether the prospect could also be called. Then it
 * appends today's numbers to a rolling history so the question "did the change help" has an answer
 * instead of an opinion.
 *
 *   node tools/targeting-scorecard.mjs                  # print + publish
 *   node tools/targeting-scorecard.mjs --days 30        # window (default 60)
 *   node tools/targeting-scorecard.mjs --no-publish     # print only
 *
 * TWO HONESTY RULES, both learned from this codebase's own history:
 *
 * 1. AN AUTO-REPLY IS NOT A REPLY. The reply ledger contains "Automatic reply: ..." rows. Counting
 *    an out-of-office as interest would make every change look like it worked, and would flatter
 *    exactly the C-suite targeting we are trying to test (busy people have OOO on). They are
 *    counted separately as `auto`, never in `replies`.
 *
 * 2. SMALL SAMPLES ARE NOT SIGNALS. Every bucket carries its own `sends`, and anything under
 *    MIN_SAMPLE is marked `thin: true`. A 100% reply rate on two sends is noise, and a scorecard
 *    that presents it next to a 3.1% rate on 800 sends teaches the reader to trust noise.
 */

import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { roleFamily, roleFunctionGroup } from "./gates.mjs";
import { levelOf, tierOf, LEVEL_NAME } from "./orgchart.mjs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const SNAP = process.env.MPC_TARGETING_SNAPSHOT || "/data/snap_mpc_targeting_v1.json";
const SIZE_SNAP = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
const PHONE_SNAP = process.env.MPC_PHONE_SNAPSHOT || "/data/snap_inmarket_company_phone_v1.json";
const REST_SNAP = process.env.MPC_DOMAIN_REST || "/data/snap_mpc_domain_rest_v1.json";
const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const WINDOW_DAYS = Number(arg("--days", 60));
const PUBLISH = !argv.includes("--no-publish");
const MIN_SAMPLE = Number(process.env.MPC_SCORECARD_MIN_SAMPLE || 25);
const HISTORY_MAX = 180;

const AUTO_REPLY = /^(automatic reply|auto[- ]?reply|out of office|ooo\b|away from|autoresponse|automatic response|undeliverable|delivery (status|has failed)|mail delivery)/i;

const norm = (s) => String(s || "").toLowerCase().trim();
const day = (iso) => String(iso || "").slice(0, 10);

function readJsonl(prefix) {
  const rows = [];
  let files = [];
  try { files = readdirSync(OUT).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")); } catch { return rows; }
  for (const f of files) {
    let text = "";
    try { text = readFileSync(`${OUT}/${f}`, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* a truncated line never invalidates the file */ }
    }
  }
  return rows;
}
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

/* ── reference data ───────────────────────────────────────────────────────────────────────────── */

const sizeRaw = readJson(SIZE_SNAP) || {};
const sizeMap = sizeRaw.companies || sizeRaw.data || sizeRaw;
const headcountOf = (company) => {
  const e = sizeMap[norm(company)];
  return e && typeof e.count === "number" && e.count > 0 ? e.count : null;
};

const phoneRaw = readJson(PHONE_SNAP) || {};
const phoneMap = phoneRaw.data || phoneRaw;
const dialable = new Set();
for (const [d, row] of Object.entries(phoneMap)) {
  if (row && row.ok && row.phone && String(row.phone).startsWith("+1")) dialable.add(norm(d));
}
const attemptedDomains = new Set(Object.keys(phoneMap).map(norm));

/* ── the join ─────────────────────────────────────────────────────────────────────────────────── */

const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
const sends = readJsonl("sent-").filter((r) => r && r.to_email && (Date.parse(r.at) || 0) >= cutoff);

// A prospect can be mailed more than once (touch 1, then follow-ups). Key by address and keep the
// FIRST send: the reply is credited to the targeting decision that opened the conversation, not to
// whichever follow-up happened to land last.
const firstSend = new Map();
for (const r of sends) {
  const k = norm(r.to_email);
  const t = Date.parse(r.at) || 0;
  const cur = firstSend.get(k);
  if (!cur || t < cur._t) firstSend.set(k, { ...r, _t: t });
}

const replies = readJsonl("replies-");
const replied = new Map();   // email -> { auto:boolean, at }
for (const r of replies) {
  if (!r || !r.to_email) continue;
  const k = norm(r.to_email);
  const auto = AUTO_REPLY.test(String(r.reply_subject || ""));
  const prev = replied.get(k);
  // A real reply always outranks an auto-reply for the same person: an OOO followed by a genuine
  // answer is a genuine answer, and taking the first row would have thrown that away.
  if (!prev || (prev.auto && !auto)) replied.set(k, { auto, at: r.reply_at });
}

/* ── bucketing ────────────────────────────────────────────────────────────────────────────────── */

const buckets = new Map();   // dimension -> key -> { sends, replies, auto }
function bump(dim, key, hasReply, isAuto) {
  if (key == null || key === "") key = "unknown";
  if (!buckets.has(dim)) buckets.set(dim, new Map());
  const m = buckets.get(dim);
  const b = m.get(key) || { sends: 0, replies: 0, auto: 0 };
  b.sends++;
  if (hasReply) { if (isAuto) b.auto++; else b.replies++; }
  m.set(key, b);
}

let totalSends = 0, totalReplies = 0, totalAuto = 0, pairedSends = 0;
for (const r of firstSend.values()) {
  const rep = replied.get(norm(r.to_email));
  // Only count a reply that arrived AFTER we wrote: the ledgers span months and an unrelated older
  // thread to the same address must not be credited to this send.
  const hasReply = !!rep && (Date.parse(rep.at) || 0) >= (r._t || 0);
  const isAuto = hasReply && rep.auto;
  totalSends++;
  if (hasReply) { if (isAuto) totalAuto++; else totalReplies++; }

  const lvl = levelOf(r.to_title);
  const head = headcountOf(r.company);
  const tier = tierOf(head);
  const fam = roleFamily(r.role || "");
  const fnGroup = roleFunctionGroup(fam);
  const domain = norm(String(r.to_email).split("@")[1] || "");
  const paired = dialable.has(domain);
  if (paired) pairedSends++;

  bump("buyerLevel", LEVEL_NAME[lvl] || "unknown", hasReply, isAuto);
  bump("sizeTier", tier ? tier.label : "size unknown", hasReply, isAuto);
  bump("function", fnGroup || "Other", hasReply, isAuto);
  bump("emailSource", r.email_source || "unknown", hasReply, isAuto);
  bump("callable", paired ? "email + callable" : "email only", hasReply, isAuto);
  // The single cut the org chart exists to justify.
  bump("levelXTier", `${LEVEL_NAME[lvl] || "?"} @ ${tier ? tier.key : "unknown"}`, hasReply, isAuto);
}

function dimOut(dim) {
  const m = buckets.get(dim) || new Map();
  return [...m.entries()]
    .map(([key, b]) => ({
      key, sends: b.sends, replies: b.replies, auto: b.auto,
      rate: b.sends ? Math.round((b.replies / b.sends) * 10000) / 10000 : 0,
      thin: b.sends < MIN_SAMPLE,
    }))
    .sort((a, b) => b.sends - a.sends);
}

/* ── the three watch items ────────────────────────────────────────────────────────────────────── */

// Tracked as first-class metrics with history because they were the open questions on 2026-08-21
// and "read it again in a week" only works if something is writing the number down every day.
const rest = readJson(REST_SNAP) || {};
const restDomains = rest.domains || rest;
let resting = 0, domainsTotal = 0;
if (restDomains && typeof restDomains === "object") {
  for (const v of Object.values(restDomains)) {
    domainsTotal++;
    if (v && (v.state === "resting" || v.status === "resting")) resting++;
  }
}

const curRaw = readJson(CURATION);
const curated = Array.isArray(curRaw) ? curRaw : (curRaw?.rows || curRaw?.prospects || []);
const curatedDomains = new Set();
for (const r of curated) { const d = norm((r.lead || r).domain); if (d) curatedDomains.add(d); }
let curatedWithPhone = 0, curatedUnattempted = 0;
for (const d of curatedDomains) {
  if (dialable.has(d)) curatedWithPhone++;
  if (!attemptedDomains.has(d)) curatedUnattempted++;
}

// Owner-search yield by the rung we hunted, from the rename ledger. This is the org chart's real
// test on the SUPPLY side: if hunting Managers misses far more often than hunting CFOs, the model
// is aiming at people we cannot actually name and needs a two-step instead.
const renameOutcomes = {};
try {
  const latest = new Map();
  for (const line of readFileSync(`${OUT}/renamed-buyers.jsonl`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (!r || !r.companyKey || !r.fn) continue;
      const t = Date.parse(r.ts) || 0;
      const k = `${r.companyKey}|${r.fn}`;
      const cur = latest.get(k);
      if (!cur || t >= cur.t) latest.set(k, { t, outcome: r.outcome });
    } catch { /* skip */ }
  }
  for (const v of latest.values()) renameOutcomes[v.outcome] = (renameOutcomes[v.outcome] || 0) + 1;
} catch { /* no ledger yet */ }
const hunted = Object.values(renameOutcomes).reduce((a, b) => a + b, 0);
const found = renameOutcomes.fixed || 0;
const noName = renameOutcomes.no_name || 0;

const watch = {
  fleet: { restingDomains: resting, knownDomains: domainsTotal },
  phone: {
    curatedDomains: curatedDomains.size,
    withPhone: curatedWithPhone,
    unattempted: curatedUnattempted,
    coverage: curatedDomains.size ? Math.round((curatedWithPhone / curatedDomains.size) * 1000) / 1000 : 0,
    pairedSendShare: totalSends ? Math.round((pairedSends / totalSends) * 1000) / 1000 : 0,
  },
  ownerSearch: {
    pairsHunted: hunted,
    found,
    noName,
    findRate: hunted ? Math.round((found / hunted) * 1000) / 1000 : 0,
    outcomes: renameOutcomes,
  },
};

/* ── publish + print ──────────────────────────────────────────────────────────────────────────── */

const today = {
  date: day(new Date().toISOString()),
  windowDays: WINDOW_DAYS,
  sends: totalSends,
  replies: totalReplies,
  auto: totalAuto,
  rate: totalSends ? Math.round((totalReplies / totalSends) * 10000) / 10000 : 0,
  watch,
};

const payload = {
  version: 1,
  at: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  minSample: MIN_SAMPLE,
  totals: { sends: totalSends, replies: totalReplies, auto: totalAuto, rate: today.rate },
  byBuyerLevel: dimOut("buyerLevel"),
  bySizeTier: dimOut("sizeTier"),
  byFunction: dimOut("function"),
  byEmailSource: dimOut("emailSource"),
  byCallable: dimOut("callable"),
  byLevelAndTier: dimOut("levelXTier"),
  watch,
  history: [],
};

if (PUBLISH) {
  let prior = [];
  if (existsSync(SNAP)) {
    const old = readJson(SNAP);
    if (old && Array.isArray(old.history)) prior = old.history;
  }
  // One row per day, last write wins, so re-running the tool never inflates the trend.
  prior = prior.filter((h) => h && h.date !== today.date);
  prior.push(today);
  payload.history = prior.slice(-HISTORY_MAX);
  writeFileSync(SNAP + ".tmp", JSON.stringify(payload));
  renameSync(SNAP + ".tmp", SNAP);
}

const pct = (x) => (x * 100).toFixed(2) + "%";
const line = (r) => `  ${String(r.key).padEnd(28)} ${String(r.sends).padStart(6)} sends  ${String(r.replies).padStart(5)} replies  ${pct(r.rate).padStart(8)}${r.thin ? "   (thin sample)" : ""}`;

console.log(`\nTARGETING SCORECARD · last ${WINDOW_DAYS} days`);
console.log("=".repeat(78));
console.log(`  ${totalSends} prospects mailed, ${totalReplies} real replies (${pct(today.rate)}), ${totalAuto} auto-replies excluded\n`);
for (const [label, dim] of [
  ["REPLY RATE BY WHO WE PICKED (the org chart's test)", "byBuyerLevel"],
  ["BY COMPANY SIZE", "bySizeTier"],
  ["BY FUNCTION", "byFunction"],
  ["BY ADDRESS RUNG", "byEmailSource"],
  ["EMAIL ONLY vs ALSO CALLABLE", "byCallable"],
]) {
  console.log(label);
  for (const r of payload[dim]) console.log(line(r));
  console.log("");
}
console.log("WATCH ITEMS");
console.log(`  fleet          ${watch.fleet.restingDomains} of ${watch.fleet.knownDomains} domains resting`);
console.log(`  phone coverage ${pct(watch.phone.coverage)} of ${watch.phone.curatedDomains} curated employer domains, ${watch.phone.unattempted} never looked up`);
console.log(`  owner search   ${pct(watch.ownerSearch.findRate)} of ${watch.ownerSearch.pairsHunted} company+function hunts found a person (${watch.ownerSearch.noName} came back with no name)`);
console.log("=".repeat(78));
if (PUBLISH) console.log(`published -> ${SNAP} (${payload.history.length} days of history)\n`);
