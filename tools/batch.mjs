// RecruitersOS · MPC · the batch pipeline (Ryan / CPA-Controller).
//
// The solid model end to end, self-contained so it never touches the app's fragile state
// files: SOURCE (read curated) -> ROLE GATE -> DECISION-MAKER GATE -> EMAIL GATE ->
// AI-WRITE (per prospect) -> RENDER GATE -> QUEUE. It is DRY-RUN by default (writes drafts
// to a file + prints samples, sends nothing). Only `--send` actually sends, via the proven
// Sending.ac Mailbox API for Ryan/Josh/Noah/Sam and direct SMTP for Ariel's own-SMTP boxes,
// signing each email as the box's owner, and logs every send. A hard per-box daily cap keeps
// every mailbox at safe cold volume.
//
// 2026-08-20 safeguards (after the 8/19 fleet burn): the SEND FUSE is evaluated first (fleet-wide
// bounce ratio + per-source breakers; latched, person-cleared), cold sends HOLD without fresh
// bounce data, every address passes the VERIFICATION BELT (verdict on file or a live Reoon check,
// canary sample of older verdicts), and pattern-derived addresses only leave the blast-radius slice.
//
//   node scripts/mpc/batch.mjs                 # dry-run: gate + write + show, send nothing
//   node scripts/mpc/batch.mjs --limit 25      # cap how many to draft
//   node scripts/mpc/batch.mjs --send          # send the drafts that passed every gate
//
// Read-only against the curated store; writes ONLY its own files under /out.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { assessProspect, metroOf, checkRenderedEmail, cohortKeyOf, dmFunction, roleFamily, roleFunctionGroup, buildCompanyKnowledge, buyerFit, companyKeyOf, isSeniorHire, isTalentBuyer } from "./gates.mjs";
import { writeEmail, signature, footer, greetingName, recruiterFor } from "./writer.mjs";
import { pickVariant } from "./variants.mjs";
import { classifyEmails } from "./mxclass.mjs";
// VERIFICATION BELT + SEND FUSE (owner mandate 2026-08-20, after the 8/19 fleet burn): every
// address must carry a verifier verdict the sender can read back (or gets re-verified live right
// here), a sample of older verdicts is canary-checked before each run, weaker-proof addresses ride
// a fixed slice of the fleet, and a fleet-wide fuse / per-source breakers stop a bad run while it
// is happening. See verify.mjs + fuse.mjs; both ship with tests (test-verify.mjs, test-fuse.mjs).
import { loadVerifyCache, saveVerifyCache, proofOf, verifyMany } from "./verify.mjs";
import { loadFuseLedger, writeFuseLedger, evaluateFuse, loadSentRows, loadNdr, ndrAgeHours, tripFleet, notifyOwner, tierOf, canarySlice } from "./fuse.mjs";

// Recruiter decisions from the Growth cockpit: a suppressed / wrong-market / still-snoozed cohort
// is OFF, so the autopilot never sends it. This is what makes the "Suppress" button have teeth.
const DECISIONS_FILE = process.env.MPC_DECISIONS_FILE || "/data/snap_growth_decisions_v1.json";
function loadBlockedCohorts() {
  const blocked = new Set(); const now = Date.now();
  try {
    const s = JSON.parse(readFileSync(DECISIONS_FILE, "utf8"));
    for (const [key, d] of Object.entries((s && s.decisions) || {})) {
      if (!d) continue;
      if (d.state === "suppressed") blocked.add(key);
      else if (d.state === "rejected" && d.reason === "wrong_market") blocked.add(key);
      else if (d.state === "snoozed" && d.snoozeUntil && Date.parse(d.snoozeUntil) > now) blocked.add(key);
    }
  } catch { /* no decisions yet */ }
  return blocked;
}

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const SUPPLY_SNAP = process.env.MPC_SUPPLY_SNAPSHOT || "/data/snap_mpc_supply_v1.json";
const PHONE_SNAP = process.env.MPC_PHONE_SNAPSHOT || "/data/snap_inmarket_company_phone_v1.json";
const SENDERS = process.env.MPC_SENDERS_FILE || "/data/snap_senders_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const LUME_WS = "ws_mqf6o989003";
const MAILBOX_BASE = (process.env.SENDINGAC_MAILBOX_API_BASE || "https://api.customers.ac/api/mailbox/v1alpha1").replace(/\/+$/, "") + "/azure/v1.0";

const args = process.argv.slice(2);
const SEND = args.includes("--send");
// Read-only capacity readout. Publishes the cold-lane ledger the portal reads and exits
// before any curation, drafting or API call, so the monitor can refresh the number every
// tick for free. `--capacity --json` prints the ledger for scripts.
const CAPACITY_ONLY = args.includes("--capacity");
const LIMIT = Number((args.find(a => a.startsWith("--limit")) || "").split(/[=\s]/)[1] || (args.includes("--limit") ? args[args.indexOf("--limit") + 1] : "")) || (SEND ? 20 : 10);

function loadArray(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const arrs = []; const walk = o => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(s); return arrs.sort((a, b) => b.length - a.length)[0] || [];
}

// Everyone we have already emailed (any prior run), so an unattended daily job NEVER
// double-contacts a decision-maker. Reads its own send logs; deterministic and self-contained.
function alreadyEmailed() {
  const seen = new Set();
  if (!existsSync(OUT)) return seen;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email) seen.add(String(r.to_email).toLowerCase().trim()); } catch { /* skip */ }
    }
  }
  return seen;
}

// Addresses the fleet NDR sweep has seen hard-bounce (snap_mpc_ndr_v1.json, refreshed by
// mpc-ndr-sweep.timer). Consulted at the send gate so a known-dead address can never cold-send
// again, even when the curation row still carries emailValidated:true from before the 8/19
// validation-rung fix. Same stop-list followup.mjs already uses; fail-open if the file is absent.
function bouncedStopList() {
  const stop = new Set();
  try {
    const n = JSON.parse(readFileSync(process.env.MPC_NDR_FILE || "/data/snap_mpc_ndr_v1.json", "utf8"));
    for (const e of n.bounced || []) stop.add(String(e).toLowerCase());
  } catch { /* no sweep yet; nothing to suppress */ }
  return stop;
}

// The sending fleet. OWNER CALL 2026-08-11: cold sends go through Sending.ac boxes ONLY
// (Ryan/Josh/Noah/Sam via the Mailbox API, credential-less). The own-SMTP lookalike boxes
// (ariel@lumerecruity.com etc., mail.lumesp.com) stay OUT of rotation until that fleet is
// properly warmed; set MPC_SMTP_LANE=1 to bring them back in. Ariel has no Sending.ac boxes,
// so until hers are provisioned (or the SMTP lane is unlocked) she does not send.
// Pools are interleaved by owner so volume splits evenly.
const OWNER_PATTERN = /ryan|josh|noah|sam|ariel/i;
const SMTP_LANE = process.env.MPC_SMTP_LANE === "1";
// Google lane: warm-ready Zapmail Gmail boxes (active + working smtp.gmail.com credentials)
// join cold rotation on a RECEIVER-FRIENDLY RAMP (owner order 2026-08-19, same day as the
// short hold): each box's cold volume steps up weekly from ITS OWN first cold send, so what
// Google sees from any one mailbox is a slow, organic growth curve on top of its continuing
// warm-up, never a day-one volume spike. Steps are per-box/day by week since first send
// (MPC_GOOGLE_RAMP; last value = permanent ceiling). Defaults set 2026-08-19 from the
// owner's call + industry research: 8/day week 1, 14 week 2, 20/day ceiling week 3+
// (consensus safe band for warmed Workspace inboxes is 20-50/day with 2-3 boxes per
// domain; our domains are ~3 weeks old, so we ride the conservative edge and let the
// health guard + domain-rest breaker veto anything that degrades).
// MPC_GOOGLE_LANE=0 parks the lane again.
const GOOGLE_LANE = process.env.MPC_GOOGLE_LANE !== "0";
// GUESSED ADDRESSES DO NOT SEND (owner mandate 2026-08-20). Off by default; see the
// no-guessing gate in main(), where the bounce evidence for it is recorded.
const PATTERN_LANE = process.env.MPC_PATTERN_LANE === "1";

// PROVIDER-BLOCK LEDGER -> per-fleet avoid sets. The NDR sweeps detect receiver-side
// "your server is not welcome" signatures (Gmail's UnsolicitedMessageError, "low
// reputation" deferrals, blocklist rejections) across ALL traffic including warm-up,
// and persist fleet x provider pairs to this ledger. Here that becomes routing: a box
// never draws a recipient whose host is currently rejecting that box's fleet. A pair
// is live while fresh (seen <7d) and material (count >= MPC_BLOCK_MIN); a healed
// provider ages out and the lane reopens with no code change. The internal fleet also
// carries a hardcoded "google" seed until the new-IP cutover proves Gmail accepts the
// server (MPC_INTERNAL_NO_GOOGLE=0 removes the seed; the ledger stays authoritative).
const BLOCKS_CANDIDATES = [
  process.env.MPC_BLOCKS_FILE,
  "/data/snap_provider_blocks_v1.json",
  "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_provider_blocks_v1.json",
].filter(Boolean);
function blockedProviders(fleet) {
  for (const f of BLOCKS_CANDIDATES) {
    try {
      const led = JSON.parse(readFileSync(f, "utf8"));
      const out = new Set();
      for (const b of Object.values(led.blocks || {})) {
        if (!b || b.fleet !== fleet) continue;
        if (!b.lastSeen || Date.now() - Date.parse(b.lastSeen) > 7 * 86_400_000) continue;
        if ((b.count || 0) < Number(process.env.MPC_BLOCK_MIN || 20)) continue;
        out.add(b.provider);
      }
      return out;
    } catch { /* try next path; missing ledger = no ledger blocks (seed below still applies) */ }
  }
  return new Set();
}
const AVOID = {
  internal: new Set([...(process.env.MPC_INTERNAL_NO_GOOGLE === "0" ? [] : ["google"]), ...blockedProviders("internal")]),
  sendingac: blockedProviders("sendingac"),
  google: blockedProviders("google"),
};
// CORPORATE-IDENTITY GUARD (owner mandate 2026-08-19): the tenant's REAL corporate
// domain (the one recruiters log in with, e.g. lumesp.com) never carries cold volume.
// Cold mail lives on the lookalike fleet; the corporate domain is for the recruiters'
// own 1:1 mail and nothing else. Domains are derived live from the auth snapshot's
// member logins (minus public providers), so no hardcoded list to drift. Fail-open:
// an unreadable auth snapshot protects nothing rather than stopping the engine.
const AUTH_FILE = process.env.MPC_AUTH_FILE || "/data/snap_auth.json";
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);
function corpIdentityDomains() {
  try {
    const s = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    const users = new Map(s.users || []);
    const out = new Set();
    for (const m of s.memberships || []) {
      if (m.workspaceId !== LUME_WS) continue;
      const u = users.get(m.userId);
      const d = (((u && u.email) || "").split("@")[1] || "").toLowerCase();
      if (d && !PUBLIC_MAIL.has(d)) out.add(d);
    }
    return out;
  } catch { return new Set(); }
}
function recruiterBoxes() {
  const s = JSON.parse(readFileSync(SENDERS, "utf8"));
  const rows = s.inboxes || (s.state && s.state.inboxes) || [];
  const byOwner = new Map();
  const add = (key, box) => { if (!byOwner.has(key)) byOwner.set(key, []); byOwner.get(key).push(box); };
  const corp = corpIdentityDomains();
  let corpSkipped = 0;
  for (const m of rows) {
    if (!m || m.workspaceId !== LUME_WS) continue;
    if (corp.has((String(m.email || "").split("@")[1] || "").toLowerCase())) { corpSkipped++; continue; }
    if (m.provider === "sending-ac" && !m.smtpPassEnc && OWNER_PATTERN.test(m.ownerName || "")) {
      add(String(m.ownerName).toLowerCase(), { kind: "api", fleet: "sendingac", email: m.email, owner: m.ownerName });
    } else if (SMTP_LANE && m.provider === "own-smtp" && m.smtpPassEnc && /ariel/i.test(m.ownerName || m.email.split("@")[0])) {
      // fleet "internal": AVOID.internal keeps these boxes away from any provider that
      // is currently rejecting the internal server (ledger-driven; "google" seeded until
      // the new-IP cutover). Recipients steer to the Sending.ac / Gmail-lane boxes instead.
      add("ariel", { kind: "smtp", fleet: "internal", email: m.email, owner: "Ariel Grosser", host: m.smtpHost, port: m.smtpPort || 587, secure: !!m.smtpSecure, user: m.smtpUser || m.email, passEnc: m.smtpPassEnc, dailyCap: m.dailyCap || 2 });
    } else if (GOOGLE_LANE && m.status === "active" && m.smtpPassEnc && /^smtp\.gmail\.com$/i.test(m.smtpHost || "") && OWNER_PATTERN.test(m.email.split("@")[0] || "")) {
      const local = String(m.email.split("@")[0] || "");
      const key = (local.match(OWNER_PATTERN) || ["ryan"])[0].toLowerCase();
      add(key, { kind: "smtp", google: true, fleet: "google", email: m.email, owner: m.ownerName || local, host: m.smtpHost, port: m.smtpPort || 587, secure: !!m.smtpSecure, user: m.smtpUser || m.email, passEnc: m.smtpPassEnc, dailyCap: m.dailyCap || 2 });
    }
  }
  if (corpSkipped) console.log(`corp-identity guard: excluded ${corpSkipped} box(es) on ${[...corp].join(", ")} (the corporate domain never carries cold volume)`);
  const pools = [...byOwner.values()];
  const out = [];
  for (let i = 0; pools.some(p => i < p.length); i++) for (const p of pools) if (i < p.length) out.push(p[i]);
  return out;
}


// When each box made its FIRST cold send ever (from the ledgers). This anchors the Google
// lane's ramp: a box's cap grows by weeks since ITS OWN first send, so a box added later
// starts its own gentle curve instead of inheriting the fleet's.

// How many sends each box has already made TODAY (across all runs + follow-ups), so the
// rotation can hold every mailbox to a hard per-box daily cap no matter how often runs fire.

// ============================================================================
// COLD-LANE CAPACITY (single source of truth, owner mandate 2026-08-19/08-20)
//
// These caps used to live inside main()'s send path, so the ONLY way to know what
// the fleet could carry today was to run a send. Every other surface (the Senders
// tab, the Send Queue gauge, the story card) re-derived it from the senders store's
// provider labels and got a different, much larger number: on 2026-08-20 the portal
// advertised 1,422 cold sends/day against a fleet whose real ceiling was ~800, because
// 54 Zapmail boxes carried provider:"other" and were run up the generic 15/day warm-up
// ramp, and 60 internal boxes were counted while their lane was parked.
//
// Hoisted to module scope so `--capacity` can publish exactly what the sender enforces:
// same boxes, same per-box caps, same rest ledger, same per-domain ceiling. The app reads
// the published snapshot; it never recomputes any of this from provider strings.
// ============================================================================
// Per-box caps, the ledger scans and the rest ledger live in boxcaps.mjs so the follow-up
// lane enforces the SAME mailbox budget this one does (it had none until 2026-08-20).
import { PER_BOX, GOOGLE_RAMP, domOf, restingDomains, sentTodayByBox, firstSendByBox, capForBox } from "./boxcaps.mjs";
// Per-DOMAIN ceiling for the Google lane (research: keep a domain's total cold volume
// under ~50-60/day once 2-3 boxes share it; every box on a domain shares its reputation).
const GOOGLE_DOMAIN_CAP = Number(process.env.MPC_GOOGLE_DOMAIN_DAILY || 50);
const COLD_CAP_FILE = process.env.MPC_COLD_CAP_FILE || "/data/snap_mpc_cold_capacity_v1.json";


/**
 * What the cold lane can actually carry today, and how much of it is already spent.
 * Read-only: touches no API and spends nothing, so it is safe to run every tick.
 *
 * `ceiling` is the honest number for the UI: the sum of each usable box's own cap,
 * clamped by the Google lane's per-domain ceiling. Boxes on resting domains and boxes
 * in a parked lane are reported separately and NEVER folded into it.
 */
function coldCapacityLedger() {
  const firstSend = firstSendByBox();
  const boxCounts = sentTodayByBox();
  const resting = restingDomains();
  const allBoxes = recruiterBoxes();
  const byLane = new Map();
  const lane = (k) => {
    let l = byLane.get(k);
    if (!l) { l = { lane: k, boxes: 0, usableBoxes: 0, benchedBoxes: 0, ceiling: 0, benchedCeiling: 0, sentToday: 0, boxesWithHeadroom: 0 }; byLane.set(k, l); }
    return l;
  };
  // Per-domain spend so the Google lane's shared-reputation ceiling clamps the total the
  // same way it clamps the sender's own pick list.
  const domSpent = new Map();
  for (const [from, n] of boxCounts) { const d = domOf(from); if (d) domSpent.set(d, (domSpent.get(d) || 0) + n); }
  const domRoom = new Map();

  let ceiling = 0, benchedCeiling = 0, sentToday = 0, usableBoxes = 0, benchedBoxes = 0, withHeadroom = 0;
  for (const b of allBoxes) {
    const l = lane(b.fleet || "other");
    const cap = capForBox(b, firstSend);
    const used = boxCounts.get(b.email) || 0;
    const d = domOf(b.email);
    l.boxes++;
    l.sentToday += used; sentToday += used;
    if (resting.has(d)) { l.benchedBoxes++; l.benchedCeiling += cap; benchedBoxes++; benchedCeiling += cap; continue; }
    // The Google lane's per-domain ceiling is a real limit on the fleet's total, not just
    // on box selection: three 20/day boxes on one domain carry 50/day, not 60.
    let eff = cap;
    if (b.google) {
      const room = domRoom.has(d) ? domRoom.get(d) : Math.max(0, GOOGLE_DOMAIN_CAP - (domSpent.get(d) || 0));
      eff = Math.min(cap, room);
      domRoom.set(d, Math.max(0, room - eff));
    }
    l.usableBoxes++; usableBoxes++;
    l.ceiling += eff; ceiling += eff;
    if (used < cap) { l.boxesWithHeadroom++; withHeadroom++; }
  }
  const lanes = [...byLane.values()].sort((a, b) => b.ceiling - a.ceiling);
  return {
    version: 1,
    at: new Date().toISOString(),
    workspaceId: LUME_WS,
    perBox: PER_BOX,
    googleRamp: GOOGLE_RAMP,
    googleDomainCap: GOOGLE_DOMAIN_CAP,
    lanesParked: [...(SMTP_LANE ? [] : ["internal"]), ...(GOOGLE_LANE ? [] : ["google"])],
    boxes: allBoxes.length,
    usableBoxes,
    benchedBoxes,
    boxesWithHeadroom: withHeadroom,
    restingDomains: [...resting].sort(),
    ceiling,
    sentToday,
    remaining: Math.max(0, ceiling - sentToday),
    benchedCeiling,
    lanes,
  };
}

/** Publish the ledger where the app reads it. Best-effort: a failed write must never
 *  stop a send run, it only leaves the UI showing the previous tick's number. */
function publishColdCapacity() {
  const led = coldCapacityLedger();
  try {
    const tmp = `${COLD_CAP_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(led));
    renameSync(tmp, COLD_CAP_FILE);
  } catch (e) { console.log(`  cold-capacity snapshot not written: ${e?.message || e}`); }
  return led;
}

// Ariel's SMTP lane. Passwords sit AES-256-GCM-encrypted in the senders store (same scheme as
// the app's lib/senders/crypto.ts: scrypt key from SENDERS_ENCRYPTION_KEY/APP_ENCRYPTION_KEY,
// falling back to the app's built-in default when neither is set, which matches this prod box).
import { createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
let cachedKey = null;
function cryptoKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SENDERS_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "ros-senders-dev-key-do-not-use-in-prod";
  cachedKey = scryptSync(secret, "ros-senders-salt-v1", 32);
  return cachedKey;
}
function decryptSecret(stored) {
  if (!stored) return "";
  if (!stored.startsWith("v1:")) return stored;
  try {
    const raw = Buffer.from(stored.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", cryptoKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}
let mailerMod = null;
function nodemailer() {
  if (!mailerMod) mailerMod = createRequire("/app/integration/package.json")("nodemailer");
  return mailerMod;
}
async function sendViaSmtp(box, fromName, to, subject, body) {
  const pass = decryptSecret(box.passEnc);
  if (!pass) return { ok: false, error: "smtp password would not decrypt" };
  try {
    const t = nodemailer().createTransport({ host: box.host, port: box.port, secure: box.secure, auth: { user: box.user, pass }, connectionTimeout: 20_000, socketTimeout: 30_000 });
    await t.sendMail({ from: `"${fromName}" <${box.email}>`, to, subject, text: body });
    t.close();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 160) }; }
}

async function sendViaMailboxApi(fromEmail, to, subject, body) {
  const key = process.env.SENDINGAC_MAILBOX_API_KEY;
  const res = await fetch(`${MAILBOX_BASE}/users/${encodeURIComponent(fromEmail)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 202 || res.status === 200) return { ok: true };
  if (res.status === 502) return { ok: true, note: "502 ambiguous" };
  return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 160)}` };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // ===== CAPACITY READOUT (read-only; nothing below this point runs) =====
  // The portal's cold-send numbers come from HERE, not from the senders store's provider
  // labels, so "what can we send today" has exactly one answer across the log, the Senders
  // tab, the Send Queue gauge and the story card.
  if (CAPACITY_ONLY) {
    const led = publishColdCapacity();
    if (args.includes("--json")) { console.log(JSON.stringify(led, null, 1)); return; }
    console.log(`cold ceiling today : ${led.ceiling}/day`);
    console.log(`already sent       : ${led.sentToday}`);
    console.log(`remaining          : ${led.remaining}`);
    console.log(`usable boxes       : ${led.usableBoxes} of ${led.boxes} (${led.boxesWithHeadroom} still under their own cap)`);
    console.log(`benched            : ${led.benchedBoxes} boxes on ${led.restingDomains.length} resting domains, holding ${led.benchedCeiling}/day`);
    if (led.lanesParked.length) console.log(`parked lanes       : ${led.lanesParked.join(", ")} (contribute 0)`);
    for (const l of led.lanes) {
      console.log(`  ${l.lane.padEnd(10)} ${String(l.ceiling).padStart(5)}/day across ${l.usableBoxes} usable (${l.sentToday} sent, ${l.benchedBoxes} benched holding ${l.benchedCeiling}/day)`);
    }
    console.log(`snapshot           : ${COLD_CAP_FILE}`);
    return;
  }

  // ===== SEND FUSE + BOUNCE VISIBILITY (evaluated before a single credit or token is spent) =====
  // Fail-CLOSED by design (owner mandate 2026-08-20): without fresh bounce data the fleet is
  // flying blind, so cold sends wait for the next NDR sweep instead of guessing. The fleet fuse
  // latches on a bounce spike (or a failed canary) and only a person clears it.
  const ndr = loadNdr();
  const NDR_MAX_AGE_H = Number(process.env.MPC_NDR_MAX_AGE_H || 12);
  const ndrAge = ndrAgeHours(ndr);
  let fuse = loadFuseLedger();
  const fuseEval = evaluateFuse({ ledger: fuse, sentRows: loadSentRows(OUT, 14), ndr });
  fuse = fuseEval.ledger;
  try { writeFuseLedger(fuse); } catch (e) { console.log(`fuse ledger not writable: ${e.message}`); }
  for (const c of fuseEval.changes) console.log(`  fuse: ${c.text}`);
  if (fuseEval.changes.length) await notifyOwner(fuseEval.changes);
  if (fuse.fleet.tripped) {
    console.log(`HOLD: the send fuse is TRIPPED (${fuse.fleet.by}: ${fuse.fleet.reason}; since ${fuse.fleet.since}). Nothing sends until a person clears it: bash /opt/recruiteros/tools/send-fuse.sh --clear`);
    return;
  }
  if (SEND && (ndrAge == null || ndrAge > NDR_MAX_AGE_H)) {
    console.log(`HOLD: bounce data is ${ndrAge == null ? "missing" : `${ndrAge.toFixed(1)}h old`} (limit ${NDR_MAX_AGE_H}h). Cold sends wait for a fresh NDR sweep (mpc-ndr-sweep.timer); set MPC_NDR_MAX_AGE_H to widen.`);
    return;
  }
  const pausedSources = new Set(Object.entries(fuse.sources || {}).filter(([, s]) => s && s.paused).map(([k]) => k));
  if (pausedSources.size) console.log(`  fuse: source breaker(s) open: ${[...pausedSources].join(", ")} (those rungs' addresses are held this run)`);
  const fw = fuse.window || {};
  console.log(`send fuse: armed | ${fw.available === false ? "bounce notices not yet in the sweep" : `${fw.bounces ?? 0} bounces / ${fw.sends ?? 0} sends in ${fw.windowH ?? 24}h`} | NDR data ${ndrAge == null ? "missing" : `${ndrAge.toFixed(1)}h old`}`);
  // START FRESH: ignore the pre-finance firehose backlog entirely. Only work records curated on or
  // after the finance-approach cutoff (all records carry an ISO curatedAt). Override with MPC_CURATED_SINCE.
  const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
  const curatedAll = loadArray(CURATION);
  const curated = SINCE ? curatedAll.filter((r) => String((r.lead || r).curatedAt || "") >= SINCE) : curatedAll;

  // BUYER OVERRIDES (2026-08-21). rename-buyers.mjs re-targets rows whose named decision-maker is
  // the wrong person for the req, and writes them to an overlay file rather than co-writing the
  // app's curation store (that store's write lock is in-process only, so a sidecar writer would
  // race the 4-minute curation tick). Its header has always said the overlay is "applied by
  // batch.mjs at read time" — it never was. Only inspect-supply.mjs applied it, which is why the
  // inspector cheerfully reported "buyer overrides applied: 242" while the sender ignored every
  // one of them: 2,411 buyers renamed on 2026-08-12 had never influenced a single send.
  // Apply by row id BEFORE the gates run, exactly as the inspector does, so the two agree.
  const OVR_FILE = process.env.MPC_BUYER_OVERRIDES || "/data/snap_mpc_buyer_overrides_v1.json";
  let ovrApplied = 0;
  try {
    const ovr = (JSON.parse(readFileSync(OVR_FILE, "utf8")) || {}).rows || {};
    for (const r of curated) {
      const p = r.lead || r;
      if (p.id && ovr[p.id]) { Object.assign(p, ovr[p.id]); ovrApplied++; }
    }
  } catch { /* absent overlay is fine: nothing has been re-targeted yet */ }
  console.log(`curated total: ${curatedAll.length} | finance-era (since ${SINCE}): ${curated.length}${ovrApplied ? ` | buyer overrides applied: ${ovrApplied}` : ""}`);

  // Attach company headcount from the app's free size cache (Wikidata-backed, in the same /data
  // volume) so the universal-buyer seniority gate in gates.mjs has real numbers to bite on.
  // Coverage is partial (Wikidata only knows established companies); unknown stays unknown and
  // the gate warns instead of failing.
  const SIZE_SNAP = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
  const normCoName = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|co|company|group|holdings)\b/g, " ").replace(/[^a-z0-9]+/g, "").trim();
  const sizeByName = new Map();
  try {
    const snap = JSON.parse(readFileSync(SIZE_SNAP, "utf8"));
    for (const [k, v] of Object.entries((snap && (snap.data || snap)) || {})) {
      if (v && typeof v.count === "number" && v.count > 0) sizeByName.set(normCoName(k), v.count);
    }
  } catch { /* cache absent: sizes stay unknown */ }
  if (sizeByName.size) console.log(`company-size cache: ${sizeByName.size} known headcounts`);

  // COMPANY KNOWLEDGE (restored 2026-08-20; it was wired in on 08-12 and lost in the block-ledger
  // rewrite). Built from EVERY curated row, including ungated and unnamed ones, so a hold can say
  // whether the right owner is already named at that company or has yet to be found. buyerFit reads
  // it below to write the hold reasons.
  const know = buildCompanyKnowledge(curated.map((r) => r.lead || r));

  // OWNER RE-POINTING (owner decision 2026-08-20: "utilize the data we have and leverage it").
  //
  // The store is full of rows that carry the RIGHT COMPANY and the RIGHT REQ but the WRONG PERSON —
  // a CEO, or a company-level buyer row — while a different row at that SAME company already names
  // the leader of the function the req sits in, with a validated address. Holding those rows throws
  // away work we already paid for. Instead of discarding them, we swap in the owner we already know
  // and send to THEM about that req. Nothing is written back to the store; this is selection-time
  // only, so it is fully reversible and re-derives itself every run.
  const ownerKey = (co, fn) => `${companyKeyOf(co)}|${fn}`;
  const owners = new Map();
  for (const r of curated) {
    const p = r.lead || r;
    if (!p.managerName || !p.managerTitle || !p.likelyEmail) continue;
    const fn = dmFunction(p.managerTitle);
    if (!fn || fn === "universal") continue;              // only a real function leader can be an owner
    const k = ownerKey(p.company, fn);
    // Prefer the best-evidenced address: validated beats unknown, and a catch-all guess is last.
    const score = (p.emailValidated ? 2 : 0) - (p.emailCatchAll ? 1 : 0) - (p.emailInvalid ? 5 : 0);
    const cur = owners.get(k);
    if (!cur || score > cur.score) {
      owners.set(k, {
        score, name: p.managerName, title: p.managerTitle, email: p.likelyEmail,
        emailValidated: !!p.emailValidated, emailCatchAll: !!p.emailCatchAll, emailInvalid: !!p.emailInvalid,
      });
    }
  }
  if (owners.size) console.log(`owner index: ${owners.size} named function leaders across the pool`);

  // Stage 1-3: role + decision-maker + size + email gates.
  const gated = [];
  const rejected = { role: 0, dm: 0, size: 0, email: 0, other: 0 };
  const buyerHolds = [];
  let retargeted = 0;
  for (const r of curated) {
    const p = r.lead || r;
    // A company-level buyer row (id "cp_<company>_buyer_<person>") is the Head of People / C-suite
    // the curation pass mines ONCE per company. Those people were never resolved against this req,
    // so under the owner-only mandate they are not a legitimate target for it.
    p.companyBuyerRow = /_buyer_/.test(String(r.id || p.id || ""));
    if (p.employeeCount == null) {
      const c = sizeByName.get(normCoName(p.company));
      if (c != null) p.employeeCount = c;
    }
    // Re-point to the req's real owner when this row is aimed at someone else and the pool already
    // knows who owns that function here. Executive searches are left alone: the CEO IS their buyer.
    {
      const roleFn = roleFunctionGroup(roleFamily(p.role));
      const curFn = dmFunction(p.managerTitle);
      const alreadyOwner = curFn && curFn !== "universal" && curFn === roleFn;
      if (!alreadyOwner && roleFn !== "Executive" && !isSeniorHire(p.role)) {
        const o = owners.get(ownerKey(p.company, roleFn));
        if (o && o.name.trim().toLowerCase() !== String(p.managerName || "").trim().toLowerCase()) {
          p.retargetedFrom = `${p.managerName || "?"} (${p.managerTitle || "?"})`;
          p.managerName = o.name;
          p.managerTitle = o.title;
          p.likelyEmail = o.email;
          p.emailValidated = o.emailValidated;
          p.emailCatchAll = o.emailCatchAll;
          p.emailInvalid = o.emailInvalid;
          p.companyBuyerRow = false;   // this row now targets the owner of the req, not a stray buyer
          retargeted++;
        }
      }
    }
    const res = assessProspect(p);
    if (res.eligible) { gated.push(p); continue; }
    const f = res.failures.join(" ");
    if (/is not a professional hire|accounting\/finance hire/.test(f)) rejected.role++;
    else if (/employee target band|size for .* is unconfirmed/.test(f)) rejected.size++;
    else if (/decision-maker|different company/.test(f)) rejected.dm++;
    else if (/email/.test(f)) rejected.email++;
    else rejected.other++;
    // Record WHY a buyer was held, so the misses are recoverable work rather than silent loss.
    if (p.managerName && /decision-maker/.test(f)) {
      const bf = buyerFit(p, know);
      if (!bf.ok) buyerHolds.push({ company: p.company, role: p.role, held: p.managerName, title: p.managerTitle, why: bf.why });
    }
  }
  console.log(`curated: ${curated.length} | passed all gates: ${gated.length}`);
  console.log(`rejected -> role:${rejected.role} decision-maker:${rejected.dm} size:${rejected.size} email:${rejected.email} other:${rejected.other}`);
  if (retargeted) console.log(`re-pointed to the req's real owner: ${retargeted} (rows that were aimed at a CEO or a company-level buyer)`);
  console.log(`targeting mode: ${(process.env.MPC_TARGETING_MODE || "transition").toLowerCase()} | size mode: ${(process.env.MPC_SIZE_MODE || "known-bad-only").toLowerCase()}`);
  if (buyerHolds.length) {
    const f = `${OUT}/buyer-holds-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    try { writeFileSync(f, JSON.stringify(buyerHolds, null, 1)); console.log(`buyer holds written: ${buyerHolds.length} -> ${f}`); } catch {}
    const knownOwner = buyerHolds.filter((h) => /already names a/.test(h.why || "")).length;
    if (knownOwner) console.log(`  of those, ${knownOwner} are companies where the right function owner is ALREADY named (re-target, do not re-source)`);
  }

  // ONE BUYER PER REQ (the 2026-08-12 Ping Identity leak: the same Lead Accountant req carried
  // both a FOUNDER & CEO row and a VP row, and the CEO row got the email). When several curated
  // rows target the same company+role, keep the one whose buyer best fits the role's function:
  // the exec who OWNS the function first, then the ambiguous senior (a VP/Director the resolver
  // targeted for this role), and a whole-company exec (CEO/founder/owner) only when nobody
  // better was ever named for the req.
  const reqKey = (p) => `${String(p.company || "").toLowerCase().replace(/[^a-z0-9]+/g, "")}|${String(p.role || "").toLowerCase().trim()}`;
  const dmRank = (p) => {
    const fn = dmFunction(p.managerTitle);
    if (fn && fn !== "universal" && fn === roleFunctionGroup(roleFamily(p.role))) return 0;
    // The talent leader owns hiring for every function, so they outrank an ambiguous senior
    // and a whole-company exec for a recruiting pitch, while never displacing the req's own
    // function owner above (gates.isTalentBuyer, owner call 2026-08-20).
    if (isTalentBuyer(p.managerTitle)) return 1;
    if (fn === null) return 2;
    if (fn === "universal") return 3;
    return 4;
  };
  const bestByReq = new Map();
  for (const p of gated) {
    const k = reqKey(p);
    const cur = bestByReq.get(k);
    if (!cur || dmRank(p) < dmRank(cur)) bestByReq.set(k, p);
  }
  const preferred = [...bestByReq.values()];
  if (preferred.length < gated.length) {
    console.log(`same-req duplicate buyers collapsed: ${gated.length - preferred.length} (kept the best-fit buyer per req)`);
  }
  // SEND THE OWNERS FIRST. In transition mode a whole-company exec can still pass the gate, so the
  // daily cap must not be spent on those while genuine function owners wait in the queue. Ordering
  // by buyer rank means the cap is always consumed best-first, and the weaker fallbacks only ever
  // use capacity the owners did not need. Ties keep their existing order (highest score first).
  preferred.sort((a, b) => dmRank(a) - dmRank(b));
  const rankMix = preferred.reduce((acc, p) => { acc[dmRank(p)] = (acc[dmRank(p)] || 0) + 1; return acc; }, {});
  console.log(`buyer mix -> role owner:${rankMix[0] || 0} ambiguous senior:${rankMix[1] || 0} whole-company exec:${rankMix[2] || 0} other:${rankMix[3] || 0}`);

  // Suppression: never re-email anyone we've already contacted (makes daily autopilot safe),
  // AND dedupe within this run so a duplicate curated row can't double-send in one batch.
  const seen = alreadyEmailed();
  const blocked = loadBlockedCohorts();
  const ndrStop = bouncedStopList();
  const runSeen = new Set();
  const fresh = [];
  let skippedBlocked = 0;
  let skippedUnvalidated = 0;
  let skippedBounced = 0;
  let skippedSourcePaused = 0;
  let skippedPattern = 0;
  // VALIDATION BELT (2026-08-12 deliverability audit). The app-side enroll gate requires a
  // Reoon-validated address, but curated rows reach this lane directly, so the same rule holds
  // here: a known-invalid address never sends, and an unvalidated one waits for the nightly
  // validation batch instead of bouncing off a real company and burning the sending domain.
  // MPC_REQUIRE_VALIDATED=0 restores the old accept-unvalidated behavior.
  const REQUIRE_VALIDATED = process.env.MPC_REQUIRE_VALIDATED !== "0";
  for (const p of preferred) {
    const e = String(p.likelyEmail || "").toLowerCase().trim();
    if (!e || seen.has(e) || runSeen.has(e)) continue;
    if (ndrStop.has(e)) { skippedBounced++; continue; } // receiver already told us this address is dead
    if (blocked.size && blocked.has(cohortKeyOf(p))) { skippedBlocked++; continue; } // recruiter said "no" to this cohort
    if (p.emailInvalid || (REQUIRE_VALIDATED && p.emailValidated !== true)) { skippedUnvalidated++; continue; }
    if (pausedSources.size && pausedSources.has(p.emailSource || "guess")) { skippedSourcePaused++; continue; } // that rung is bouncing: held, not dropped
    runSeen.add(e);
    // NO GUESSED ADDRESSES (owner mandate 2026-08-20). A "pattern" address is one we DERIVED
    // — a syntax guessed from a name and a domain — however many validators later blessed it.
    // A "found" address is one a finder record actually returned for that person. Measured
    // across every send the fleet has ever made:
    //
    //     found     140 sent    2 bounced    1.4%
    //     pattern  1246 sent  269 bounced   21.6%
    //
    // Pattern rungs produced 269 of the fleet's 271 bounces. The slice below used to contain
    // that damage to 25% of the domains; containing it is not the same as not doing it, and
    // a 21.6% rung has no business on any domain. Guessing is now OUT of the send path
    // entirely: these rows are HELD, not dropped, and the KoldInfo finder converts them into
    // found-tier addresses that come back through this gate legitimately.
    // MPC_PATTERN_LANE=1 re-opens it; that is a deliberate act, not a default.
    if (!PATTERN_LANE && tierOf(p.emailSource) !== "found") { skippedPattern++; continue; }
    fresh.push(p);
  }
  console.log(`already emailed: ${seen.size} | known-bounced suppressed: ${skippedBounced} | blocked-cohort skipped: ${skippedBlocked} | unvalidated/invalid held: ${skippedUnvalidated} | paused-source held: ${skippedSourcePaused}${skippedPattern ? ` | GUESSED addresses held: ${skippedPattern}` : ""} | fresh & ready: ${fresh.length}`);
  if (skippedPattern) console.log(`  no-guessing: ${skippedPattern} row(s) held because their address was derived, not found. They wait for the KoldInfo finder to return a real record (MPC_PATTERN_LANE=1 re-opens the rung).`);
  // PUBLISH TODAY'S SUPPLY FUNNEL (2026-08-21). Same principle as the cold-capacity ledger: the
  // stage that ENFORCES a number is the stage that publishes it, so no surface can invent its own.
  // Until now the funnel existed only as console lines in mpc-out/monitor-*.log, which meant the
  // single most important question about this business — "why did only 4 emails go out today?" —
  // could only be answered by SSHing to the box and reading a log. Nothing alerted, because
  // nothing had a number to alert on: the send fuse was armed, capacity read 832/day, and every
  // dashboard was green while the top of the funnel had been dry for days.
  //
  // Ordering note: the buckets below are EXCLUSIVE and measured at the point each one bites, so
  // they do not sum to `curated` (a row rejected at the gate is never tested for an address).
  // `freshReady` is the only number that means "could have been sent this run".
  // VOICE PAIRING on the send side (2026-08-21). Outreach is coupled: the same prospect should get
  // the cold email AND a voice drop to their employer's switchboard, so the sender reports how many
  // of the rows it is ABOUT TO MAIL can also be dialled. The app's funnel reports the same idea
  // across the whole store; this one is the send-time slice, which is the number that decides how
  // much of today's batch the dialer can actually follow.
  // Phones are cached per DOMAIN (positive 90d, negative 14d) and only a +1 number is dialable on
  // this deployment, matching isDialableHere() on the app side.
  let phonePairable = 0, phoneGated = 0, phoneDomains = 0;
  try {
    const raw = JSON.parse(readFileSync(PHONE_SNAP, "utf8"));
    const pmap = (raw && (raw.data || raw)) || {};
    const dialable = new Set();
    for (const [d, row] of Object.entries(pmap)) {
      if (row && row.ok && row.phone && String(row.phone).startsWith("+1")) dialable.add(d.toLowerCase());
    }
    phoneDomains = dialable.size;
    const has = (p) => { const d = (p.domain || "").toLowerCase().trim(); return !!d && dialable.has(d); };
    phonePairable = fresh.filter(has).length;
    phoneGated = gated.filter(has).length;
  } catch { /* no phone cache yet: report zeros rather than break the run */ }
  if (fresh.length) {
    console.log(`  voice pairing: ${phonePairable} of ${fresh.length} sendable rows also have a dialable corporate number (${Math.round((phonePairable / fresh.length) * 100)}%)`);
  }

  try {
    const supply = {
      version: 1,
      at: new Date().toISOString(),
      curatedTotal: curatedAll.length,
      curatedSince: curated.length,
      buyerOverridesApplied: ovrApplied,
      passedGates: gated.length,
      buyerHolds: buyerHolds.length,
      alreadyEmailed: seen.size,
      heldBounced: skippedBounced,
      heldBlockedCohort: skippedBlocked,
      heldUnvalidated: skippedUnvalidated,
      heldSourcePaused: skippedSourcePaused,
      heldGuessed: skippedPattern,
      freshReady: fresh.length,
      // Voice Drops pairing: what the dialer can follow the email with.
      voicePairable: phonePairable,
      voicePairableOfGated: phoneGated,
      voiceDialableDomains: phoneDomains,
    };
    writeFileSync(SUPPLY_SNAP, JSON.stringify(supply, null, 1));
  } catch { /* never let a reporting write break a send run */ }

  // PROVIDER-AWARE ORDERING + SEG PHASE (the enterprise-deliverability layer, mxclass.mjs).
  // All MPC volume leaves Azure/Outlook infrastructure, so Outlook-hosted recipients are our
  // best-matched sends and go first; Google-hosted recipients go last within the batch.
  // SEG-protected recipients (Proofpoint/Mimecast/Barracuda/IronPort) are the sends that get
  // young fleets blacklisted, so they are DEFERRED entirely until the fleet has 90+ day
  // domains and the owner flips MPC_SEG_SEND=1. Deferred prospects are never logged as sent,
  // so they re-enter this pipeline automatically the day SEG sends turn on. Recipients whose
  // domain resolves no MX right now would only bounce and are skipped (retried on later runs
  // via the 1-day cache expiry, in case it was resolver trouble).
  const cls = await classifyEmails(fresh.map((p) => p.likelyEmail));
  const SEG_SEND = process.env.MPC_SEG_SEND === "1";
  const buckets = { microsoft: [], custom: [], unknown: [], google: [], seg: [], nomx: [] };
  for (const p of fresh) {
    const c = cls.get(String(p.likelyEmail).toLowerCase().trim()) || { family: "unknown", seg: null };
    if (c.seg && !SEG_SEND) { buckets.seg.push(p); continue; }
    if (c.family === "none") { buckets.nomx.push(p); continue; }
    (buckets[c.family] || buckets.unknown).push(p);
  }
  // GMAIL PLACEMENT GATE (owner mandate 2026-08-12): if the latest seed test shows Gmail filing
  // us to spam, google-hosted prospects are DEFERRED like SEG targets: never logged as sent, so
  // they re-enter the pipeline automatically once a passing test lands. Microsoft-hosted targets
  // (where all engagement is coming from) carry the volume meanwhile.
  let googleHeld = false;
  try {
    const pl = JSON.parse(readFileSync(process.env.MPC_PLACEMENT_FILE || "/data/snap_mpc_placement_v1.json", "utf8"));
    const g = (pl && pl.gmail) || {};
    const total = (g.inbox || 0) + (g.spam || 0);
    const fresh = pl && Date.now() - Date.parse(pl.checkedAt || 0) <= 7 * 86_400_000;
    if (fresh && total > 0 && (g.spam || 0) / total > 0.3) googleHeld = true;
  } catch { /* no seed test yet: google still sends, but the ramp governor holds base volume */ }
  // OWNERS FIRST, INSIDE EACH PROVIDER BUCKET. The provider grouping above is a deliverability
  // decision and has to stay the outer ordering, but it is built by concatenating buckets, which
  // silently discarded the buyer-rank sort applied earlier: the 2026-08-20 19:50 run went out
  // 18/31 to CEOs even though 125 role owners were queued ahead of 90 execs. Sorting inside each
  // bucket is what actually makes the daily cap get spent on the people who own the req.
  for (const b of Object.values(buckets)) {
    if (Array.isArray(b)) b.sort((a, z) => dmRank(a) - dmRank(z));
  }
  const ordered = googleHeld
    ? [...buckets.microsoft, ...buckets.custom, ...buckets.unknown]
    : [...buckets.microsoft, ...buckets.custom, ...buckets.unknown, ...buckets.google];
  const orderedMix = ordered.reduce((acc, p) => { acc[dmRank(p)] = (acc[dmRank(p)] || 0) + 1; return acc; }, {});
  console.log(`sendable, owners first -> role owner:${orderedMix[0] || 0} ambiguous senior:${orderedMix[1] || 0} whole-company exec:${orderedMix[2] || 0}`);
  if (googleHeld) console.log(`placement gate: Gmail seed test failing, ${buckets.google.length} google-hosted prospects deferred`);
  console.log(`provider mix -> outlook-hosted ${buckets.microsoft.length} | custom ${buckets.custom.length} | unknown ${buckets.unknown.length} | google ${buckets.google.length} | SEG deferred ${buckets.seg.length}${SEG_SEND ? " (SEG sends ON)" : ""} | no-MX skipped ${buckets.nomx.length}`);

  // Cheap supply check: gates + MX mix, no AI spend. Use it to watch the finance pool fill.
  if (args.includes("--count")) {
    console.log(`\n[COUNT] clean & not-yet-contacted (sendable now): ${ordered.length} (+${buckets.seg.length} SEG-deferred)`);
    return;
  }

  // Continuous-autopilot daily cap: count what already went out TODAY across all runs and never
  // exceed the safe daily max. This lets the sender run every cycle (draining ready leads to
  // capacity) instead of once a day, without ever over-sending.
  // Fleet ceiling: 900 boxes x 2 cold/day (Sending.ac's safe flat rate) = 1800. The per-box
  // cap below is the real enforcer; this daily total is the belt on top of those suspenders.
  const DAILY_CAP_ENV = Number(process.env.MPC_DAILY_CAP || 1800);
  // VOLUME RAMP GOVERNOR (owner mandate 2026-08-12, after the bounce audit): the young fleet
  // rebuilds reputation on ~450/day from 2026-08-13. Growth (+20%/week toward the 1500 ceiling)
  // unlocks ONLY while a fresh (<=7 day old) seed placement test shows Gmail inboxing
  // (snap_mpc_placement_v1.json, written by run-seed-test). No test or a failing test holds the
  // base rate: reputation rebuilds are judged by measured placement, not the calendar alone.
  // The domain-rest breaker separately benches any domain that starts bouncing again.
  // Overrides: MPC_RAMP_START (ISO date), MPC_RAMP_BASE (0 disables the governor).
  const RAMP_START = Date.parse(process.env.MPC_RAMP_START || "2026-08-13");
  const RAMP_BASE = Number(process.env.MPC_RAMP_BASE ?? 450);
  const PLACEMENT_FILE = process.env.MPC_PLACEMENT_FILE || "/data/snap_mpc_placement_v1.json";
  function gmailPlacementPasses() {
    try {
      const pl = JSON.parse(readFileSync(PLACEMENT_FILE, "utf8"));
      if (!pl || Date.now() - Date.parse(pl.checkedAt || 0) > 7 * 86_400_000) return null; // stale/absent
      const g = pl.gmail || {};
      const total = (g.inbox || 0) + (g.spam || 0);
      if (!total) return null;
      return (g.spam || 0) / total <= 0.3;
    } catch { return null; } // no seed test yet
  }
  let rampCap = Infinity;
  if (RAMP_BASE > 0 && Number.isFinite(RAMP_START)) {
    const weeks = Math.max(0, (Date.now() - RAMP_START) / (7 * 86_400_000));
    const growth = gmailPlacementPasses() === true ? Math.pow(1.2, weeks) : 1;
    rampCap = Math.min(1500, Math.round(RAMP_BASE * growth));
  }
  const DAILY_CAP = Math.min(DAILY_CAP_ENV, rampCap);
  if (rampCap < DAILY_CAP_ENV) console.log(`volume ramp: cap ${DAILY_CAP} today (base ${RAMP_BASE}; growth unlocked only by a fresh passing seed test)`);
  let sentToday = 0;
  if (SEND && existsSync(OUT)) {
    const today = new Date().toISOString().slice(0, 10);
    for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
      for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
        const s = line.trim(); if (!s) continue;
        try { const r = JSON.parse(s); if (r && r.to_email && (r.at || "").slice(0, 10) === today) sentToday++; } catch { /* skip */ }
      }
    }
  }
  const dailyRemaining = SEND ? Math.max(0, DAILY_CAP - sentToday) : LIMIT;
  const effLimit = SEND ? Math.min(LIMIT, dailyRemaining) : LIMIT;
  if (SEND) console.log(`daily cap ${DAILY_CAP} | already sent today ${sentToday} | room left ${dailyRemaining}`);

  // ===== VERIFICATION BELT: a verdict on file, or a live re-check, before anything is written =====
  // emailValidated:true is a flag; the belt wants the verifier's WORD (emailVerifyStatus on the row,
  // or this belt's own cache from an earlier live check). No word, an inconclusive word, or a proven
  // word older than MPC_VERIFY_MAX_AGE_D days -> one live Reoon check now (concurrency-bounded, the
  // result cached + folded back into the store by the app's hourly cron). Dead / catch-all / role
  // verdicts never send. Transport errors hold the row for the next run and cache nothing.
  // Spend is bounded: at most 3x the batch size of candidates are examined per run.
  const cache = loadVerifyCache();
  const VERIFY_MAX_AGE_D = Number(process.env.MPC_VERIFY_MAX_AGE_D || 30);
  const REVERIFY = process.env.MPC_REVERIFY !== "0" && !!process.env.REOON_API_KEY;
  if (!REVERIFY) console.log(process.env.MPC_REVERIFY === "0" ? "  belt: live re-verification disabled by MPC_REVERIFY=0 (only addresses with a proven verdict on file can send)" : "  belt: REOON_API_KEY not set; only addresses with a proven verdict on file can send");
  const belt = { at: new Date().toISOString(), candidates: 0, provenOnFile: 0, reverified: 0, provenLive: 0, dead: 0, catchAll: 0, role: 0, inconclusive: 0, heldNoVerifier: 0 };
  const proven = [];
  const POOL_LIMIT = Math.min(ordered.length, Math.max(effLimit, 1) * 3);
  let cursor = 0;
  while (proven.length < effLimit && cursor < POOL_LIMIT) {
    const chunk = ordered.slice(cursor, Math.min(POOL_LIMIT, cursor + (effLimit - proven.length)));
    cursor += chunk.length;
    belt.candidates += chunk.length;
    const needLive = [];
    for (const p of chunk) {
      const pr = proofOf(p, cache, { maxAgeDays: VERIFY_MAX_AGE_D });
      if (pr.state === "proven") { p.__proof = pr; proven.push(p); belt.provenOnFile++; }
      else if (pr.state === "dead") belt.dead++;
      else if (pr.state === "catch_all") belt.catchAll++;
      else if (pr.state === "role") belt.role++;
      else needLive.push(p); // unproven or stale
    }
    if (!needLive.length) continue;
    if (!REVERIFY) { belt.heldNoVerifier += needLive.length; continue; }
    const res = await verifyMany(needLive.map((p) => p.likelyEmail), { concurrency: Number(process.env.MPC_VERIFY_CONCURRENCY || 6) });
    const at = new Date().toISOString();
    for (const p of needLive) {
      const e = String(p.likelyEmail).toLowerCase().trim();
      const v = res.get(e);
      belt.reverified++;
      if (!v || v.error) { belt.inconclusive++; continue; } // transient: held for the next run, nothing cached
      cache.entries[e] = { at, verdict: v.verdict, status: v.status, source: p.emailSource || "guess" };
      if (v.verdict === "proven") { p.__proof = { state: "proven", via: "live", at: Date.parse(at), status: v.status }; proven.push(p); belt.provenLive++; }
      else if (v.verdict === "dead") belt.dead++;
      else if (v.verdict === "catch_all") belt.catchAll++;
      else if (v.verdict === "role") belt.role++;
      else belt.inconclusive++;
    }
  }

  // ===== CANARY: re-check a sample of the addresses we are about to trust on an OLDER verdict =====
  // If previously-proven addresses have gone bad in bulk, something upstream is lying (a verifier
  // change, a rung bug, a stale import). The sample costs a few credits; a failed sample latches
  // the fleet fuse and nothing sends until a person looks.
  const CANARY_PCT = Number(process.env.MPC_CANARY_PCT || 5);
  const CANARY_MIN = Number(process.env.MPC_CANARY_MIN || 8);
  const CANARY_TRIP_MIN = Number(process.env.MPC_CANARY_TRIP_MIN || 2);
  const CANARY_TRIP_RATIO = Number(process.env.MPC_CANARY_TRIP_RATIO || 0.15);
  const trusted = proven.filter((p) => p.__proof.via !== "live");
  let canary = null;
  if (REVERIFY && trusted.length) {
    const n = Math.min(trusted.length, Math.max(CANARY_MIN, Math.ceil((trusted.length * CANARY_PCT) / 100)));
    const sample = [...trusted].sort(() => Math.random() - 0.5).slice(0, n);
    const res = await verifyMany(sample.map((p) => p.likelyEmail), { concurrency: Number(process.env.MPC_VERIFY_CONCURRENCY || 6) });
    const at = new Date().toISOString();
    canary = { at, sample: n, invalid: 0, inconclusive: 0, tripped: false, examples: [] };
    for (const p of sample) {
      const e = String(p.likelyEmail).toLowerCase().trim();
      const v = res.get(e);
      if (!v || v.error) { canary.inconclusive++; continue; }
      cache.entries[e] = { at, verdict: v.verdict, status: v.status, source: p.emailSource || "guess" };
      if (v.verdict === "dead") { canary.invalid++; p.__hold = true; if (canary.examples.length < 5) canary.examples.push({ email: e, status: v.status, source: p.emailSource || "guess", via: p.__proof.via }); }
      else if (v.verdict !== "proven") p.__hold = true; // catch-all / role / inconclusive now: not this run
    }
    const judged = n - canary.inconclusive;
    if (judged > 0 && canary.invalid >= CANARY_TRIP_MIN && canary.invalid / judged >= CANARY_TRIP_RATIO) canary.tripped = true;
  }
  try { saveVerifyCache(cache); } catch (e) { console.log(`verify cache not writable: ${e.message}`); }
  fuse.belt = { ...belt, canary: canary ? { sample: canary.sample, invalid: canary.invalid, inconclusive: canary.inconclusive, tripped: canary.tripped } : null };
  if (canary) fuse.canary = canary;
  if (canary && canary.tripped) {
    const why = `canary: ${canary.invalid} of ${canary.sample} previously-verified addresses now verify INVALID (${canary.examples.map((x) => `${x.email} [${x.source}]`).join(", ")})`;
    tripFleet(fuse, { by: "canary", reason: why, scope: "fleet" });
    try { writeFuseLedger(fuse); } catch { /* logged above */ }
    await notifyOwner([{ kind: "fleet_tripped", text: `FUSE TRIPPED by the canary: ${why}. Addresses the store calls verified are failing a fresh check, so every cold send is stopped until a person looks.` }]);
    console.log(`HOLD: ${why}. Fleet fuse tripped; nothing sends until cleared.`);
    return;
  }
  try { writeFuseLedger(fuse); } catch { /* logged above */ }
  const batch = proven.filter((p) => !p.__hold);
  console.log(`verification belt: ${belt.candidates} candidates -> ${belt.provenOnFile} proven on file, ${belt.reverified} re-verified live (${belt.provenLive} proven, ${belt.dead} dead, ${belt.catchAll} catch-all, ${belt.role} role, ${belt.inconclusive} inconclusive)${belt.heldNoVerifier ? `, ${belt.heldNoVerifier} held (no verifier)` : ""}${canary ? ` | canary ${canary.invalid}/${canary.sample} invalid` : ""} -> ${batch.length} cleared`);
  console.log(`\nwriting ${batch.length} emails (${SEND ? "SEND" : "DRY-RUN"})...\n`);

  const drafts = [];
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    const metro = metroOf(p);
    const variant = pickVariant(i); // even, reproducible rotation of the tested lead angles
    let email;
    try { email = await writeEmail(p, { metro, variant }); }
    catch (e) { console.log(`  SKIP (writer) ${p.company}: ${e.message}`); continue; }
    const check = checkRenderedEmail(email.subject, email.body, { remote: !metro });
    if (!check.ok) { console.log(`  SKIP (render gate) ${p.company}: ${check.problems.join(", ")}`); continue; }
    // Greeting built deterministically: "Hi <Capitalized First Name>," then a blank line, then the
    // message. Signature + footer are appended at SEND time, once we know which recruiter's box
    // the email leaves from, so every send signs as its actual sender.
    const baseBody = `Hi ${greetingName(p.managerName)},\n\n${email.body}`;
    // Provenance travels with the send: which rung produced the address, what the verifier said and
    // when. The NDR sweep joins bounces back to these fields (per-source breakers) and the tier
    // decides which slice of the fleet may carry it.
    drafts.push({
      company: p.company, role: p.role, metro: metro || "remote", variant: variant.id, variant_label: variant.label,
      to_name: p.managerName, to_title: p.managerTitle, to_email: p.likelyEmail, subject: email.subject, body: baseBody,
      email_source: p.emailSource || "guess", tier: tierOf(p.emailSource),
      verify_status: p.__proof.status, verify_via: p.__proof.via, verified_at: new Date(p.__proof.at).toISOString(),
    });
  }

  const draftFile = `${OUT}/drafts-${stamp}.json`;
  writeFileSync(draftFile, JSON.stringify(drafts, null, 2));
  console.log(`\n${drafts.length} drafts passed every gate. Written to ${draftFile}`);
  console.log("\n===== SAMPLES =====");
  for (const d of drafts.slice(0, 5)) {
    console.log(`\n--- ${d.company} | ${d.role} | ${d.metro} | variant: ${d.variant} (${d.variant_label}) ---`);
    console.log(`to: ${d.to_name} (${d.to_title}) <${d.to_email}>`);
    console.log(`subject: ${d.subject}`);
    console.log(d.body);
  }

  if (!SEND) {
    console.log(`\n[DRY-RUN] nothing sent. Review ${draftFile}. Re-run with --send to send these.`);
    return;
  }

  // Caps come from boxcaps.mjs, so `--capacity`, this send path and the follow-up lane all
  // enforce and report the same mailbox budget.
  const firstSend = firstSendByBox();
  const capFor = (b) => capForBox(b, firstSend);
  const domCounts = new Map();
  const allBoxes = recruiterBoxes();
  if (!allBoxes.length) { console.log("no recruiter sending boxes found; aborting send"); return; }
  const resting = restingDomains();
  const fleet = resting.size ? allBoxes.filter(b => !resting.has(String(b.email.split("@")[1] || "").toLowerCase())) : allBoxes;
  if (allBoxes.length > fleet.length) console.log(`  domain rest: ${allBoxes.length - fleet.length} box(es) benched (resting: ${[...resting].join(", ")})`);
  if (!fleet.length) { console.log("every sending box belongs to a resting domain; nothing sends until a domain revives"); return; }
  const boxCounts = sentTodayByBox();
  for (const [from, n] of boxCounts) { const d = domOf(from); if (d) domCounts.set(d, (domCounts.get(d) || 0) + n); }
  const avail = fleet.filter(b => (boxCounts.get(b.email) || 0) < capFor(b) && !(b.google && (domCounts.get(domOf(b.email)) || 0) >= GOOGLE_DOMAIN_CAP));
  const apiBoxes = fleet.filter(b => b.kind !== "smtp").length;
  // The ceiling THIS fleet carries today, from the same ledger the portal reads, so the
  // log line and the UI can never tell two stories. Printing one flat "(2/day)" here was
  // how the Google lane's own 8-20/day ramp stayed invisible.
  const coldCap = publishColdCapacity();
  console.log(`\n[SEND] fleet ${fleet.length} boxes (api ${apiBoxes} + smtp ${fleet.length - apiBoxes}${SMTP_LANE ? "" : "; own-SMTP lane parked"}${GOOGLE_LANE ? "" : "; google lane parked"}) | with headroom: ${avail.length}`);
  console.log(`  cold ceiling today: ${coldCap.ceiling}/day across ${coldCap.usableBoxes} usable boxes (${coldCap.lanes.map((l) => `${l.lane} ${l.ceiling}`).join(" + ")}) | ${coldCap.sentToday} spent, ${coldCap.remaining} left | ${coldCap.benchedBoxes} boxes benched holding ${coldCap.benchedCeiling}/day`);
  const logFile = `${OUT}/sent-${stamp}.jsonl`;
  // Provider-compatible routing: a recipient must never be assigned to a box whose fleet
  // the recipient's mail host is currently rejecting (every attempt is a burned send AND
  // more bad behavior logged against that fleet's server). Which pairs are live comes
  // from the provider-block ledger (AVOID, computed above); classifyEmails is
  // domain-cached, so the family lookup is free.
  const clsSend = await classifyEmails(drafts.map((d) => d.to_email));
  const famOf = (to) => (clsSend.get(String(to || "").toLowerCase().trim()) || {}).family || "unknown";
  const boxAvoids = (b, fam) => !!(b.fleet && AVOID[b.fleet] && AVOID[b.fleet].has(fam));
  const liveAvoids = Object.entries(AVOID).filter(([, s]) => s.size).map(([f, s]) => `${f} avoids ${[...s].join("+")}`);
  if (liveAvoids.length) console.log(`  provider-block routing: ${liveAvoids.join(" | ")}`);
  // BLAST-RADIUS SLICE (owner mandate 2026-08-20). Weaker-proof ("pattern") addresses, the rungs
  // that derived a syntax and had a verifier bless it, only ever leave a fixed ~MPC_PATTERN_SLICE_PCT
  // (25%) slice of the fleet's domains, chosen by hash over ALL fleet domains (resting included) so it
  // never migrates onto clean domains as others rest. Found-tier addresses (a finder returned a
  // record) prefer the other 75% and borrow slice boxes only when nothing else is free
  // (MPC_STRICT_SLICE=1 forbids even that). A rung that goes bad can burn the slice, never the fleet.
  // With the pattern rung closed, nothing reaches here that needs containing — the slice
  // stays wired so that re-opening MPC_PATTERN_LANE restores the blast-radius limit with it,
  // rather than letting guessed volume loose across the whole fleet.
  const SLICE_PCT = Number(process.env.MPC_PATTERN_SLICE_PCT || 25);
  const slice = canarySlice(allBoxes.map((b) => domOf(b.email)), SLICE_PCT);
  const sliceLive = [...new Set(fleet.map((b) => domOf(b.email)))].filter((d) => slice.has(d));
  if (PATTERN_LANE) console.log(`  blast-radius slice: ${slice.size} domain(s) carry pattern-tier sends (${sliceLive.length} of them not resting: ${sliceLive.join(", ") || "none; pattern-tier drafts wait"})`);
  else console.log(`  no-guessing: every draft in this run carries a FOUND address (derived addresses never reach the fleet)`);
  const pickBox = (d) => {
    const fam = famOf(d.to_email);
    const ok = (b) => !boxAvoids(b, fam);
    const inSlice = (b) => slice.has(domOf(b.email));
    let pool;
    if (d.tier === "pattern") pool = avail.filter((b) => inSlice(b) && ok(b));
    else {
      pool = avail.filter((b) => !inSlice(b) && ok(b));
      if (!pool.length && process.env.MPC_STRICT_SLICE !== "1") pool = avail.filter(ok);
    }
    if (!pool.length) return null;
    return pool[idx++ % pool.length];
  };
  let sent = 0, failed = 0, idx = 0, sliceDeferred = 0, blockDeferred = 0, patternSent = 0;
  for (const d of drafts) {
    // Google-lane domain ceiling: evict boxes whose domain hit today's cap before picking
    // (the draft is then tried against the remaining boxes, never dropped).
    for (let i = avail.length - 1; i >= 0; i--) {
      const c = avail[i];
      if (c.google && (domCounts.get(domOf(c.email)) || 0) >= GOOGLE_DOMAIN_CAP) avail.splice(i, 1);
    }
    if (!avail.length) { console.log("  every box is at its per-box or per-domain daily cap; stopping (deliverability guard)"); break; }
    const box = pickBox(d);
    if (!box) { if (d.tier === "pattern") sliceDeferred++; else blockDeferred++; continue; } // not logged as sent: re-enters next run
    const rec = recruiterFor(box.owner);
    const body = d.body + signature(rec) + footer();
    const r = box.kind === "smtp"
      ? await sendViaSmtp(box, rec.name, d.to_email, d.subject, body)
      : await sendViaMailboxApi(box.email, d.to_email, d.subject, body);
    // motion: BD vs Recruiting share the same box fleet, so every ledger row carries its
    // side. This engine is the BD lane; a recruiting lane through the same tools sets
    // MPC_MOTION=recruiting. mpc-stats splits the cockpit on this field.
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), motion: process.env.MPC_MOTION || "bd", from: box.email, from_owner: rec.name, lane: box.kind || "api", ...d, body, result: r }) + "\n");
    boxCounts.set(box.email, (boxCounts.get(box.email) || 0) + 1);
    if (box.google) { const bd = domOf(box.email); domCounts.set(bd, (domCounts.get(bd) || 0) + 1); }
    if ((boxCounts.get(box.email) || 0) >= capFor(box)) { const i = avail.indexOf(box); if (i >= 0) avail.splice(i, 1); }
    if (d.tier === "pattern") patternSent++;
    if (r.ok) { sent++; console.log(`  sent ${d.to_email} (as ${box.email} / ${rec.name}; ${d.tier}/${d.email_source}, ${d.verify_status} via ${d.verify_via})${r.note ? " [" + r.note + "]" : ""}`); }
    else { failed++; console.log(`  FAIL ${d.to_email}: ${r.error}`); }
    await new Promise(res => setTimeout(res, 1200)); // pace under 60/min
  }
  if (sliceDeferred || blockDeferred) console.log(`  routing: ${sliceDeferred} pattern-tier draft(s) waited for a slice box, ${blockDeferred} deferred (no provider-compatible box this run)`);
  console.log(`\n[SEND] done: ${sent} sent (${patternSent} pattern-tier on the slice), ${failed} failed. Log: ${logFile}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
