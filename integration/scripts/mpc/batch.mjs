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
//   node scripts/mpc/batch.mjs                 # dry-run: gate + write + show, send nothing
//   node scripts/mpc/batch.mjs --limit 25      # cap how many to draft
//   node scripts/mpc/batch.mjs --send          # send the drafts that passed every gate
//
// Read-only against the curated store; writes ONLY its own files under /out.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { assessProspect, metroOf, checkRenderedEmail, cohortKeyOf, dmFunction, roleFamily, roleFunctionGroup } from "./gates.mjs";
import { writeEmail, signature, footer, greetingName, recruiterFor } from "./writer.mjs";
import { pickVariant } from "./variants.mjs";
import { classifyEmails } from "./mxclass.mjs";

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
const SENDERS = process.env.MPC_SENDERS_FILE || "/data/snap_senders_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const LUME_WS = "ws_mqf6o989003";
const MAILBOX_BASE = (process.env.SENDINGAC_MAILBOX_API_BASE || "https://api.customers.ac/api/mailbox/v1alpha1").replace(/\/+$/, "") + "/azure/v1.0";

const args = process.argv.slice(2);
const SEND = args.includes("--send");
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
const GOOGLE_RAMP = String(process.env.MPC_GOOGLE_RAMP || "8,14,20")
  .split(",").map((n) => Math.max(1, Number(n) || 0)).filter(Boolean);
function recruiterBoxes() {
  const s = JSON.parse(readFileSync(SENDERS, "utf8"));
  const rows = s.inboxes || (s.state && s.state.inboxes) || [];
  const byOwner = new Map();
  const add = (key, box) => { if (!byOwner.has(key)) byOwner.set(key, []); byOwner.get(key).push(box); };
  for (const m of rows) {
    if (!m || m.workspaceId !== LUME_WS) continue;
    if (m.provider === "sending-ac" && !m.smtpPassEnc && OWNER_PATTERN.test(m.ownerName || "")) {
      add(String(m.ownerName).toLowerCase(), { kind: "api", email: m.email, owner: m.ownerName });
    } else if (SMTP_LANE && m.provider === "own-smtp" && m.smtpPassEnc && /ariel/i.test(m.ownerName || m.email.split("@")[0])) {
      // noGoogle: Gmail 550-rejects the Mailcow server's IP (UnsolicitedMessageError,
      // 2026-08-19), so internal boxes never draw google-hosted recipients; those go
      // via the Sending.ac / Gmail-lane boxes, which Gmail's IP filter cannot touch.
      add("ariel", { kind: "smtp", noGoogle: true, email: m.email, owner: "Ariel Grosser", host: m.smtpHost, port: m.smtpPort || 587, secure: !!m.smtpSecure, user: m.smtpUser || m.email, passEnc: m.smtpPassEnc, dailyCap: m.dailyCap || 2 });
    } else if (GOOGLE_LANE && m.status === "active" && m.smtpPassEnc && /^smtp\.gmail\.com$/i.test(m.smtpHost || "") && OWNER_PATTERN.test(m.email.split("@")[0] || "")) {
      const local = String(m.email.split("@")[0] || "");
      const key = (local.match(OWNER_PATTERN) || ["ryan"])[0].toLowerCase();
      add(key, { kind: "smtp", google: true, email: m.email, owner: m.ownerName || local, host: m.smtpHost, port: m.smtpPort || 587, secure: !!m.smtpSecure, user: m.smtpUser || m.email, passEnc: m.smtpPassEnc, dailyCap: m.dailyCap || 2 });
    }
  }
  const pools = [...byOwner.values()];
  const out = [];
  for (let i = 0; pools.some(p => i < p.length); i++) for (const p of pools) if (i < p.length) out.push(p[i]);
  return out;
}

// Domain rest fail-safe. A domain the rest ledger (domain-rest.mjs, daily rota) has benched
// sends NOTHING from any of its boxes until it revives: cold volume through a domain that is
// bouncing or reputation-damaged is how a domain gets burned for good. Warm-up keeps running
// elsewhere, so resting costs days, not the domain. Fail-open by design: a missing or
// unreadable ledger never stops the engine, it only means no domain is benched.
const REST_FILE = process.env.MPC_REST_FILE || "/data/snap_mpc_domain_rest_v1.json";
function restingDomains() {
  try {
    const r = JSON.parse(readFileSync(REST_FILE, "utf8"));
    const now = Date.now();
    return new Set(Object.entries(r.domains || {})
      .filter(([, v]) => v && v.state === "resting" && (!v.until || Date.parse(v.until) > now))
      .map(([d]) => d.toLowerCase()));
  } catch { return new Set(); }
}

// When each box made its FIRST cold send ever (from the ledgers). This anchors the Google
// lane's ramp: a box's cap grows by weeks since ITS OWN first send, so a box added later
// starts its own gentle curve instead of inheriting the fleet's.
function firstSendByBox() {
  const first = new Map();
  if (!existsSync(OUT)) return first;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (r && r.from && r.at && (!first.has(r.from) || r.at < first.get(r.from))) first.set(r.from, r.at);
      } catch { /* skip */ }
    }
  }
  return first;
}

// How many sends each box has already made TODAY (across all runs + follow-ups), so the
// rotation can hold every mailbox to a hard per-box daily cap no matter how often runs fire.
function sentTodayByBox() {
  const counts = new Map();
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(OUT)) return counts;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.from && (r.at || "").slice(0, 10) === today) counts.set(r.from, (counts.get(r.from) || 0) + 1); } catch { /* skip */ }
    }
  }
  return counts;
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
  // START FRESH: ignore the pre-finance firehose backlog entirely. Only work records curated on or
  // after the finance-approach cutoff (all records carry an ISO curatedAt). Override with MPC_CURATED_SINCE.
  const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
  const curatedAll = loadArray(CURATION);
  const curated = SINCE ? curatedAll.filter((r) => String((r.lead || r).curatedAt || "") >= SINCE) : curatedAll;
  console.log(`curated total: ${curatedAll.length} | finance-era (since ${SINCE}): ${curated.length}`);

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

  // Stage 1-3: role + decision-maker + email gates.
  const gated = [];
  const rejected = { role: 0, dm: 0, email: 0, other: 0 };
  for (const r of curated) {
    const p = r.lead || r;
    if (p.employeeCount == null) {
      const c = sizeByName.get(normCoName(p.company));
      if (c != null) p.employeeCount = c;
    }
    const res = assessProspect(p);
    if (res.eligible) { gated.push(p); continue; }
    const f = res.failures.join(" ");
    if (/accounting\/finance hire/.test(f)) rejected.role++;
    else if (/decision-maker|different company/.test(f)) rejected.dm++;
    else if (/email/.test(f)) rejected.email++;
    else rejected.other++;
  }
  console.log(`curated: ${curated.length} | passed all gates: ${gated.length}`);
  console.log(`rejected -> role:${rejected.role} decision-maker:${rejected.dm} email:${rejected.email} other:${rejected.other}`);

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
    if (fn === null) return 1;
    if (fn === "universal") return 2;
    return 3;
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
    runSeen.add(e);
    fresh.push(p);
  }
  console.log(`already emailed: ${seen.size} | known-bounced suppressed: ${skippedBounced} | blocked-cohort skipped: ${skippedBlocked} | unvalidated/invalid held: ${skippedUnvalidated} | fresh & ready: ${fresh.length}`);

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
  const ordered = googleHeld
    ? [...buckets.microsoft, ...buckets.custom, ...buckets.unknown]
    : [...buckets.microsoft, ...buckets.custom, ...buckets.unknown, ...buckets.google];
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

  const batch = ordered.slice(0, effLimit);
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
    drafts.push({ company: p.company, role: p.role, metro: metro || "remote", variant: variant.id, variant_label: variant.label, to_name: p.managerName, to_title: p.managerTitle, to_email: p.likelyEmail, subject: email.subject, body: baseBody });
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

  const PER_BOX = Number(process.env.MPC_PER_BOX_DAILY || 2);
  const firstSend = firstSendByBox();
  const googleCapFor = (b) => {
    const at = firstSend.get(b.email);
    const week = at ? Math.floor(Math.max(0, Date.now() - Date.parse(at)) / (7 * 86_400_000)) : 0;
    return GOOGLE_RAMP[Math.min(week, GOOGLE_RAMP.length - 1)];
  };
  const capFor = (b) => (b.google ? googleCapFor(b) : b.kind === "smtp" ? Math.min(PER_BOX, b.dailyCap || PER_BOX) : PER_BOX);
  const allBoxes = recruiterBoxes();
  if (!allBoxes.length) { console.log("no recruiter sending boxes found; aborting send"); return; }
  const resting = restingDomains();
  const fleet = resting.size ? allBoxes.filter(b => !resting.has(String(b.email.split("@")[1] || "").toLowerCase())) : allBoxes;
  if (allBoxes.length > fleet.length) console.log(`  domain rest: ${allBoxes.length - fleet.length} box(es) benched (resting: ${[...resting].join(", ")})`);
  if (!fleet.length) { console.log("every sending box belongs to a resting domain; nothing sends until a domain revives"); return; }
  const boxCounts = sentTodayByBox();
  const avail = fleet.filter(b => (boxCounts.get(b.email) || 0) < capFor(b));
  const apiBoxes = fleet.filter(b => b.kind !== "smtp").length;
  console.log(`\n[SEND] fleet ${fleet.length} boxes (api ${apiBoxes} + smtp ${fleet.length - apiBoxes}${SMTP_LANE ? "" : "; own-SMTP lane parked"}${GOOGLE_LANE ? "" : "; google lane parked"}) | under per-box cap (${PER_BOX}/day): ${avail.length}`);
  const logFile = `${OUT}/sent-${stamp}.jsonl`;
  // Provider-compatible routing: a google-hosted recipient must never be assigned to a
  // noGoogle box (Gmail rejects that server's IP outright; every attempt is a burned send
  // AND more bad behavior on the IP). classifyEmails is domain-cached, so this is free.
  const clsSend = await classifyEmails(drafts.map((d) => d.to_email));
  const isGoogleRcpt = (to) => (clsSend.get(String(to || "").toLowerCase().trim()) || {}).family === "google";
  let sent = 0, failed = 0, idx = 0, googleRouted = 0, googleDeferred = 0;
  for (const d of drafts) {
    if (!avail.length) { console.log("  every box is at its per-box daily cap; stopping (deliverability guard)"); break; }
    let pos = idx % avail.length;
    if (isGoogleRcpt(d.to_email)) {
      let hops = 0;
      while (hops < avail.length && avail[pos].noGoogle) { pos = (pos + 1) % avail.length; hops++; }
      if (hops >= avail.length) { googleDeferred++; continue; } // only internal boxes left: not logged as sent, re-enters next run
      if (hops > 0) googleRouted++;
    }
    const box = avail[pos];
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
    if ((boxCounts.get(box.email) || 0) >= capFor(box)) avail.splice(pos, 1); else idx++;
    if (r.ok) { sent++; console.log(`  sent ${d.to_email} (as ${box.email} / ${rec.name})${r.note ? " [" + r.note + "]" : ""}`); }
    else { failed++; console.log(`  FAIL ${d.to_email}: ${r.error}`); }
    await new Promise(res => setTimeout(res, 1200)); // pace under 60/min
  }
  if (googleRouted || googleDeferred) console.log(`  google routing: ${googleRouted} steered off internal boxes, ${googleDeferred} deferred (no compatible box this run)`);
  console.log(`\n[SEND] done: ${sent} sent, ${failed} failed. Log: ${logFile}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
