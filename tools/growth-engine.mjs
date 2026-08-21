// RecruitersOS · Growth OS · the engine that PUSHES growth (overlay, not a second CRM).
//
// Reads the existing RecruitersOS data (in-market curation = companies/contacts/signals, MPC send
// logs = contacted set) and does what a person would otherwise have to remember to do:
//   1) find UNTOUCHED, clean, in-ICP prospects sitting idle,
//   2) score each opportunity,
//   3) group them into CAMPAIGN COHORTS (industry x role-family x metro),
//   4) measure the GROWTH GAP (idle eligible demand vs today's safe send capacity),
//   5) name the BINDING CONSTRAINT (supply vs capacity) and the growth move to clear it,
//   6) write campaign PROPOSALS the Dashboard surfaces and nags on until acted upon.
//
// Deterministic + honest: it only recommends "launch now" when safe capacity can support the touches.
//   node scripts/mpc/growth-engine.mjs

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { assessProspect, metroOf, cohortKeyOf, roleFamily } from "./gates.mjs";
import { tierOf } from "./fuse.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const PROPOSALS_FILE = process.env.MPC_GROWTH_FILE || "/data/snap_growth_proposals_v1.json";
const DECISIONS_FILE = process.env.MPC_DECISIONS_FILE || "/data/snap_growth_decisions_v1.json";
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const COLD_CAP_FILE = process.env.MPC_COLD_CAP_FILE || "/data/snap_mpc_cold_capacity_v1.json";

/**
 * Today's REAL cold ceiling, read from the ledger batch.mjs writes from the live fleet.
 *
 * WHY THIS IS NOT A CONSTANT ANY MORE (2026-08-21). This was `MPC_SAFE_CAPACITY || MPC_DAILY_CAP ||
 * 400`, and neither env var is set, so the Dashboard has been reasoning about growth against a
 * hardcoded 400 dating from before the fleet grew. On 08-21 the true ceiling was 832 with 802 left.
 * Understating capacity by half is what made the growth gap blame CAPACITY and tell the owner to
 * "warm up more sending domains" on a day when 802 sends went unused. The cold-capacity ledger is
 * the single source of truth for this number (owner call, cold-capacity-ledger); fall back to the
 * old constant only when it cannot be read, and say so.
 */
function coldCapacity() {
  try {
    const c = JSON.parse(readFileSync(COLD_CAP_FILE, "utf8"));
    if (c && Number.isFinite(c.ceiling) && c.ceiling > 0) {
      return { ceiling: c.ceiling, sentToday: Number(c.sentToday) || 0, live: true, usableBoxes: Number(c.usableBoxes) || 0, benchedBoxes: Number(c.benchedBoxes) || 0 };
    }
  } catch { /* ledger absent: fall through to the env/constant floor */ }
  const fallback = Number(process.env.MPC_SAFE_CAPACITY || process.env.MPC_DAILY_CAP || 400);
  return { ceiling: fallback, sentToday: 0, live: false, usableBoxes: 0, benchedBoxes: 0 };
}
const CAP = coldCapacity();
const SAFE_CAPACITY = CAP.ceiling;

function loadArray(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
    walk(s); return arrs.sort((a, b) => b.length - a.length)[0] || [];
  } catch { return []; }
}
function contactedSet() {
  const seen = new Set();
  if (!existsSync(OUT)) return seen;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email) seen.add(String(r.to_email).toLowerCase().trim()); } catch { /* skip */ }
    }
  }
  return seen;
}
function sentToday() {
  const today = new Date().toISOString().slice(0, 10); let n = 0;
  if (!existsSync(OUT)) return 0;
  for (const f of readdirSync(OUT).filter((x) => /^sent-.*\.jsonl$/.test(x))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email && (r.at || "").slice(0, 10) === today) n++; } catch { /* skip */ }
    }
  }
  return n;
}

// Opportunity score 0-100: fresh hiring signal, a real validated decision-maker, a pairable metro,
// and role seniority all raise the odds this lead converts. Tunable weights = the ICP scoring layer.
function score(p) {
  let s = 45;
  if (p.signalReason) s += 15;                                  // active hiring signal
  if (p.emailValidated) s += 15;                                // reachable, verified DM
  if (metroOf(p)) s += 10;                                      // metro to pair (hyper-local)
  if (/\b(cfo|chief|vp|vice president|head|director)\b/i.test(p.managerTitle || "")) s += 10; // senior buyer
  if (p.emailCatchAll) s -= 15;
  return Math.max(0, Math.min(100, s));
}
// Recruiter decisions on cohorts, and the LEARNING each reject reason encodes.
function loadDecisions() {
  try { const s = JSON.parse(readFileSync(DECISIONS_FILE, "utf8")); return (s && s.decisions) || {}; }
  catch { return {}; }
}
const now = Date.now();
const decisions = loadDecisions();
// A cohort is OFF the board (not proposed, not sent) when suppressed, wrong-market-rejected, or
// still snoozed. Everything else stays proposable; a "messaging" reject keeps the cohort but marks
// it for a fresh angle so the planner re-proposes it differently rather than dropping the demand.
function cohortStatus(key) {
  const d = decisions[key];
  if (!d) return { blocked: false };
  if (d.state === "suppressed") return { blocked: true, state: "suppressed" };
  if (d.state === "rejected" && d.reason === "wrong_market") return { blocked: true, state: "wrong_market" };
  if (d.state === "snoozed" && d.snoozeUntil && Date.parse(d.snoozeUntil) > now) return { blocked: true, state: "snoozed" };
  if (d.state === "approved") return { blocked: false, state: "approved" };
  if (d.state === "rejected" && d.reason === "messaging") return { blocked: false, state: "rewrite", needsRewrite: true };
  return { blocked: false, state: d.state };
}

const contacted = contactedSet();
const curated = loadArray(CURATION).filter((r) => String((r.lead || r).curatedAt || "") >= SINCE);

// UNTOUCHED + clean + in-ICP = the idle demand the firm is leaving on the table.
//
// THE COUNT MUST MATCH WHAT THE SENDER WILL ACTUALLY MAIL (2026-08-21). This loop used to stop at
// assessProspect().eligible, which is only the FIRST of the sender's filters. batch.mjs then applies
// two more that remove most of what survives, so the Dashboard was reporting 431 "idle clean leads"
// on a day the sender could find 21, and 5 after live re-verification:
//   1. the no-guessing rule — an address that was DERIVED from a pattern, not FOUND on a record,
//      never sends (permanent owner rule); 115 rows were held for this on 08-21 alone,
//   2. one buyer per req — several curated rows can name different buyers for the SAME opening, and
//      only the best-fit one is mailed; 511 were collapsed on 08-21.
// Counting those as idle demand is what made the growth gap point at capacity. A number the owner
// reads as "people we could email today" has to survive the same rules the sender enforces.
const cohorts = new Map();
let untouchedClean = 0, blockedLeads = 0, heldGuessed = 0, collapsedDupes = 0;
const seenReq = new Set();
const reqKeyOf = (p) => `${String(p.company || "").toLowerCase().replace(/[^a-z0-9]+/g, "")}|${String(p.role || "").toLowerCase().trim()}`;
for (const r of curated) {
  const p = r.lead || r;
  const email = String(p.likelyEmail || "").toLowerCase().trim();
  if (!email || contacted.has(email)) continue;
  if (!assessProspect(p).eligible) continue;
  // (1) no-guessing: derived addresses are held until a finder returns a real record.
  if (tierOf(p.emailSource) !== "found") { heldGuessed++; continue; }
  // (2) one buyer per req: the sender mails a single person per opening.
  const rk = reqKeyOf(p);
  if (seenReq.has(rk)) { collapsedDupes++; continue; }
  seenReq.add(rk);
  const key = cohortKeyOf(p);
  const st = cohortStatus(key);
  if (st.blocked) { blockedLeads++; continue; }   // suppressed / wrong-market / snoozed = decided off
  untouchedClean++;
  const c = cohorts.get(key) || { key, industry: (p.industry || "General").trim(), family: roleFamily(p.role), metro: metroOf(p) || "Remote / National", companies: new Set(), prospects: 0, scoreSum: 0, state: st.state, needsRewrite: st.needsRewrite };
  c.companies.add((p.domain || p.company || "").toLowerCase());
  c.prospects++; c.scoreSum += score(p);
  cohorts.set(key, c);
}

const proposals = [...cohorts.values()]
  .map((c) => ({
    key: c.key, industry: c.industry, family: c.family, metro: c.metro,
    companies: c.companies.size, prospects: c.prospects,
    projectedTouches: c.prospects, // one first-touch email per DM
    avgScore: c.prospects ? Math.round(c.scoreSum / c.prospects) : 0,
    state: c.state || "open", needsRewrite: !!c.needsRewrite,
  }))
  .sort((a, b) => (b.avgScore * b.prospects) - (a.avgScore * a.prospects))
  .slice(0, 6);

const sent = sentToday();
const safeRemaining = Math.max(0, SAFE_CAPACITY - sent);
// The growth gap: idle eligible demand the firm could be touching today, and what's stopping it.
const constraint = untouchedClean === 0
  ? (safeRemaining > 0 ? "supply" : "capacity")
  : (untouchedClean <= safeRemaining ? "ready" : "capacity");
// Name what is ACTUALLY scarce. When the constraint is supply, the useful number is not "there are
// no leads" but WHERE they died, because those are three different jobs: hold-for-guessed is an
// address-finding problem, collapsed duplicates are already-counted reqs, and a genuinely empty
// pool is a sourcing problem. Saying "warm more domains" while sends go unused sent the owner after
// the one resource that was never short.
const heldNote = heldGuessed || collapsedDupes
  ? ` Held back: ${heldGuessed} lead(s) whose address was derived rather than found (they wait on the finder, never on a guess)${collapsedDupes ? `, plus ${collapsedDupes} duplicate buyer row(s) on reqs already counted` : ""}.`
  : "";
const capNote = CAP.live ? `${SAFE_CAPACITY}/day across ${CAP.usableBoxes} usable boxes` : `${SAFE_CAPACITY}/day (estimated: cold-capacity ledger unreadable)`;
const constraintMsg = {
  ready: `Capacity supports launching all ${untouchedClean} idle leads today (${capNote}, ${safeRemaining} sends left).`,
  supply: `${safeRemaining} of today's ${capNote} are unused and there are no sendable idle leads: the constraint is SUPPLY, not sending capacity.${heldNote} Find more addresses on named owners at in-band companies; more domains would not add a single send today.`,
  capacity: `${untouchedClean} sendable idle leads but only ${safeRemaining} safe sends left today (${capNote}): the constraint is CAPACITY. Warm up more sending domains to unlock them.${heldNote}`,
}[constraint];

// Mark whether each proposal can launch now within remaining safe capacity.
let budget = safeRemaining;
for (const p of proposals) { p.launchable = p.projectedTouches <= budget; if (p.launchable) budget -= p.projectedTouches; }

const out = {
  generatedAt: new Date().toISOString(),
  workspaceId: WS,
  growthGap: { untouchedClean, blockedLeads, heldGuessed, collapsedDupes, sentToday: sent, safeCapacity: SAFE_CAPACITY, safeRemaining, capacityLive: CAP.live, usableBoxes: CAP.usableBoxes, benchedBoxes: CAP.benchedBoxes, constraint, message: constraintMsg },
  proposals,
};
const tmp = PROPOSALS_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 2));
renameSync(tmp, PROPOSALS_FILE);
console.log(`growth-engine -> untouchedClean ${untouchedClean}, sentToday ${sent}, safeRemaining ${safeRemaining}, constraint ${constraint}${CAP.live ? "" : " (capacity ESTIMATED: ledger unreadable)"}`);
if (heldGuessed || collapsedDupes) console.log(`  held back -> guessed-address ${heldGuessed}, duplicate-buyer rows ${collapsedDupes}`);
console.log(`  ${constraintMsg}`);
console.log(`proposals (${proposals.length}):`);
for (const p of proposals) console.log(`  ${p.launchable ? "LAUNCH" : "queue "} ${p.key} | ${p.companies} co, ${p.prospects} DMs, avg score ${p.avgScore}`);
