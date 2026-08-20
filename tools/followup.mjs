// RecruitersOS · MPC · follow-up engine (the relationship multiplier).
//
// One cold email is one shot; most replies come from touches 2-4. This finds prospects we emailed
// who HAVEN'T replied and are due for the next touch, writes a short, value-led follow-up from the
// SAME lume box, and sends it. Best-practice + relationship-safe by construction:
//   - HARD STOP on any reply (never follow-up a live conversation) or suppression/bounce.
//   - Max 3 total touches (initial + 2 follow-ups); spaced FOLLOWUP_DAYS apart.
//   - Follow-ups are shorter and value-first, not "just bumping this".
// Dry-run by default (prints who's due + sample copy, sends nothing). --send to send.
//
//   node scripts/mpc/followup.mjs            # dry-run
//   node scripts/mpc/followup.mjs --send     # send due follow-ups
//
// Forward-looking: nothing is due until the first touch is FOLLOWUP_DAYS old, so it's safe to wire
// into the daily rota now, it simply kicks in as today's sends age.

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
// Send fuse + bounce-visibility hold (owner mandate 2026-08-20): follow-ups are cold volume too.
// batch.mjs evaluates and writes the fuse ledger right before this runs in the same tick; this
// lane only has to honor it. See fuse.mjs.
import { loadFuseLedger, loadNdr, ndrAgeHours } from "./fuse.mjs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const SENDERS = process.env.MPC_SENDERS_FILE || "/data/snap_senders_v1.json";
// PER-BOX CAP. Touch 2 spends the same mailbox budget as touch 1; see tools/boxcaps.mjs.
import { capByEmail, sentTodayByBox } from "./boxcaps.mjs";
import { tierOf } from "./fuse.mjs";
// Guessed addresses do not send, on any touch. Off by default; the cold lane carries the
// bounce evidence (found 1.4% vs pattern 21.6% across every send the fleet has made).
const PATTERN_LANE = process.env.MPC_PATTERN_LANE === "1";

/** emailSource per address, for threads whose send row predates provenance logging. */
function sourceByEmail() {
  const m = new Map();
  try {
    const cur = JSON.parse(readFileSync(process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json", "utf8"));
    const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
    walk(cur);
    for (const rr of (arrs.sort((a, b) => b.length - a.length)[0] || [])) {
      const r = rr.lead || rr;
      const e = String(r.likelyEmail || r.email || "").toLowerCase().trim();
      if (e && r.emailSource) m.set(e, r.emailSource);
    }
  } catch { /* no curation store */ }
  return m;
}
const LUME_WS = process.env.MPC_LUME_WS || "ws_mqf6o989003";

// Domain rest fail-safe (same ledger batch.mjs enforces): a follow-up goes out on the SAME box
// as touch 1, so while that box's domain is resting the follow-up simply waits. Deferring costs
// nothing: the prospect stays due and sends on the next run after the domain revives. Fail-open:
// no ledger means no domain is benched.
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
// Follow-ups must sign as WHOEVER sent touch 1, never a fixed name. Resolve the recruiter from the
// send row's `recruiter` key (new sends carry it) or, for older rows, by mapping the sending mailbox
// back to its owner in the senders snapshot.
const RECRUITER_INFO = {
  "ryan":           { name: "Ryan Nead",      phone: "929-543-0608" },
  "sam wagner":     { name: "Sam Wagner",     phone: "929-401-0849" },
  "josh gurin":     { name: "Josh Gurin",     phone: "929-532-0756" },
  "noah wilkowski": { name: "Noah Wilkowski", phone: "929-543-0584" },
};
let _boxOwner = null;
function boxOwner(email) {
  if (!_boxOwner) {
    _boxOwner = new Map();
    try {
      const s = JSON.parse(readFileSync(SENDERS, "utf8"));
      for (const m of (s.inboxes || (s.state && s.state.inboxes) || [])) {
        if (!m || m.workspaceId !== LUME_WS || !m.email) continue;
        const info = RECRUITER_INFO[(m.ownerName || "").trim().toLowerCase()];
        if (info) _boxOwner.set(m.email.toLowerCase(), info);
      }
    } catch { /* no senders file */ }
  }
  return _boxOwner.get(String(email || "").toLowerCase()) || null;
}
function recruiterFor(row) {
  return RECRUITER_INFO[String(row.recruiter || "").toLowerCase()] || boxOwner(row.from) || RECRUITER_INFO.ryan;
}
const INBOX_FILE = process.env.MPC_INBOX_FILE || "/data/snap_inbox.json";
const MAILBOX_BASE = (process.env.SENDINGAC_MAILBOX_API_BASE || "https://api.customers.ac/api/mailbox/v1alpha1").replace(/\/+$/, "") + "/azure/v1.0";
const MODEL = process.env.MPC_WRITER_MODEL || "claude-haiku-4-5";
const MAX_TOUCHES = Number(process.env.MPC_MAX_TOUCHES || 3);
const FOLLOWUP_DAYS = Number(process.env.MPC_FOLLOWUP_DAYS || 3);
const DAILY_CAP = Number(process.env.MPC_FOLLOWUP_DAILY_CAP || 200);
const args = process.argv.slice(2);
const SEND = args.includes("--send");
const LIMIT = Number((args.find((a) => a.startsWith("--limit")) || "").split(/[=\s]/)[1] || "") || (SEND ? DAILY_CAP : 8);

function loadSentRows() {
  const rows = [];
  if (!existsSync(OUT)) return rows;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.result && r.result.ok && r.to_email && r.from) rows.push(r); } catch { /* skip */ }
    }
  }
  return rows;
}
// Anyone who replied (any sentiment) or was suppressed => the sequence STOPS. Read the unified
// inbox: a bridged MPC reply means they're in a conversation, so no more cold follow-ups.
function repliedOrStopped() {
  const stop = new Set();
  try {
    const s = JSON.parse(readFileSync(INBOX_FILE, "utf8"));
    for (const x of (s.items || (Array.isArray(s) ? s : []))) {
      const i = x.inbound || x;
      const email = String(i.fromHandle || "").toLowerCase().trim();
      if (email) stop.add(email);
    }
  } catch { /* no inbox */ }
  // NDR guard (2026-08-12 deliverability audit): never follow up an address whose touch 1
  // bounced. The fleet NDR sweep maintains /data/snap_mpc_ndr_v1.json from the bounce notices
  // sitting in ALL sending mailboxes (the unified inbox only covers recruiter reply boxes).
  try {
    const n = JSON.parse(readFileSync(process.env.MPC_NDR_FILE || "/data/snap_mpc_ndr_v1.json", "utf8"));
    for (const e of n.bounced || []) stop.add(String(e).toLowerCase());
  } catch { /* no sweep yet */ }
  // VERDICT GUARD (2026-08-20). The NDR sweep only knows an address is dead once a receiver
  // has told us so; the verifier and the row store can know it sooner. The cold lane has
  // refused to send on anything but a `proven` verdict since the belt shipped, and touch 2
  // must not be the hole that lets a known-dead address through: a follow-up to a dead
  // mailbox is the same bounce as touch 1, arriving on a domain we just brought back from
  // rest. Cheap and credit-free — reads verdicts already on file, never verifies live.
  try {
    const cur = JSON.parse(readFileSync(process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json", "utf8"));
    const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
    walk(cur);
    const rows = arrs.sort((a, b) => b.length - a.length)[0] || [];
    let n = 0;
    for (const rr of rows) {
      const r = rr.lead || rr;
      if (!r?.emailInvalid) continue;
      const e = String(r.likelyEmail || r.email || "").toLowerCase().trim();
      if (e && !stop.has(e)) { stop.add(e); n++; }
    }
    if (n) console.log(`  verdict guard: ${n} address(es) held as known-invalid on the row (not yet in the bounce sweep)`);
  } catch { /* no curation store */ }
  try {
    const vc = JSON.parse(readFileSync(process.env.MPC_VERIFY_CACHE_FILE || "/data/snap_mpc_verify_cache_v1.json", "utf8"));
    let n = 0;
    for (const [e, v] of Object.entries(vc.entries || {})) {
      if (v?.verdict !== "dead") continue;
      const k = String(e).toLowerCase();
      if (!stop.has(k)) { stop.add(k); n++; }
    }
    if (n) console.log(`  verdict guard: ${n} address(es) held on a dead verifier verdict`);
  } catch { /* belt cache not written yet */ }
  return stop;
}

async function writeFollowup(p, touch, rec) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const who = (rec && rec.name) || "Ryan Nead";
  const system = [
    "You are " + who + ", a senior recruiter at Lume Search Partners placing accounting/finance talent. You are writing a SHORT follow-up to a hiring decision-maker you already emailed once and who has not replied. This is touch " + touch + " of at most " + MAX_TOUCHES + ".",
    "Rules: reference that you reached out before, briefly and without guilt-tripping. Lead with VALUE, not 'just bumping this': a concrete reason to talk now (you have vetted " + (p.role || "finance") + " candidates local to their market who fit this exact opening). Keep it 30 to 55 words. One soft CTA (a quick call/reply). Human, confident, no hype.",
    (touch >= MAX_TOUCHES
      ? "This is the LAST touch: be gracious, leave the door open ('if it comes up, I'm here'), no pressure."
      : "Make it easy to say yes to a short conversation."),
    "NEVER an em-dash (use a comma or period). NO greeting, NO 'Hi <name>', and NEVER open with or address them by their name anywhere in the body (a greeting with their name is added separately, so a name in the body reads twice). Start with a capital letter. Use ONLY the facts given, never invent a candidate, number, or detail.",
    'Return STRICT JSON only: {"subject": string, "body": string}. Subject short, lowercase; may echo the original thread.',
  ].join("\n");
  const facts = { company: p.company, open_role: p.role, decision_maker: p.to_name, prior_subject: p.subject || null, touch };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 350, system, messages: [{ role: "user", content: "Facts:\n" + JSON.stringify(facts, null, 2) + "\n\nWrite the follow-up as strict JSON." }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const dash = (s) => String(s || "").replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ").trim();
  // The greeting "Hi <name>," is prepended at send time, so a body that also opens with the
  // name reads twice ("Hi Scott, / Scott, I checked in..."). Strip any leading name the model adds.
  const stripLeadName = (s) => {
    let t = String(s || "").trim();
    const name = String(p.to_name || "").trim();
    if (name) {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const n of [name, name.split(/\s+/)[0]]) {
        if (!n) continue;
        t = t.replace(new RegExp("^(?:hi|hey|hello)?[\\s,]*" + esc(n) + "\\s*[,.!:;]\\s*", "i"), "");
      }
      t = t.charAt(0).toUpperCase() + t.slice(1);
    }
    return t;
  };
  return { subject: dash(j.subject), body: stripLeadName(dash(j.body)) };
}

async function sendViaMailboxApi(fromEmail, to, subject, body) {
  const key = process.env.SENDINGAC_MAILBOX_API_KEY;
  const res = await fetch(`${MAILBOX_BASE}/users/${encodeURIComponent(fromEmail)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 202 || res.status === 200 || res.status === 502) return { ok: true };
  return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 140)}` };
}

function greetingName(name) { const n = (name || "there").trim().split(/\s+/)[0] || "there"; return n.charAt(0).toUpperCase() + n.slice(1); }
function sig(rec) { return "\n\nBest,\n" + ((rec && rec.name) || "Ryan Nead") + "\nLume Search Partners\n" + ((rec && rec.phone) || "929-543-0608"); }
function foot() { return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096"; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  // ===== SEND FUSE + BOUNCE VISIBILITY (fail-closed, same rules as batch.mjs) =====
  const fuse = loadFuseLedger();
  if (fuse.fleet && fuse.fleet.tripped) {
    console.log(`HOLD: the send fuse is TRIPPED (${fuse.fleet.by}: ${fuse.fleet.reason}; since ${fuse.fleet.since}). Follow-ups wait until a person clears it: bash /opt/recruiteros/tools/send-fuse.sh --clear`);
    return;
  }
  const ndrAge = ndrAgeHours(loadNdr());
  const NDR_MAX_AGE_H = Number(process.env.MPC_NDR_MAX_AGE_H || 12);
  if (SEND && (ndrAge == null || ndrAge > NDR_MAX_AGE_H)) {
    console.log(`HOLD: bounce data is ${ndrAge == null ? "missing" : `${ndrAge.toFixed(1)}h old`} (limit ${NDR_MAX_AGE_H}h). Follow-ups wait for a fresh NDR sweep.`);
    return;
  }
  const rows = loadSentRows();
  const stop = repliedOrStopped();
  const now = Date.now();

  // Build per-prospect touch history from the send log (each row = one touch).
  const byEmail = new Map();
  for (const r of rows) {
    const e = String(r.to_email).toLowerCase().trim();
    const t = byEmail.get(e) || { email: e, touches: 0, lastAt: 0, last: r };
    t.touches++;
    const at = Date.parse(r.at || "") || 0;
    if (at >= t.lastAt) { t.lastAt = at; t.last = r; }
    byEmail.set(e, t);
  }

  // Due = not replied/stopped, under the touch cap, and last touch older than FOLLOWUP_DAYS.
  const due = [];
  for (const t of byEmail.values()) {
    if (stop.has(t.email)) continue;
    if (t.touches >= MAX_TOUCHES) continue;
    if (now - t.lastAt < FOLLOWUP_DAYS * 86_400_000) continue;
    due.push(t);
  }
  due.sort((a, b) => a.lastAt - b.lastAt); // oldest waiting first

  // Resting domains: their follow-ups defer, they do not send. Filtered AFTER the due list is
  // built so the deferred prospects stay visible in the count and simply come back next run.
  const resting = restingDomains();
  let deferred = 0, smtpParked = 0;
  const sendable = due.filter((t) => {
    // Touch 1 sent on the own-SMTP lane has NO Sending.ac mailbox behind it; firing its
    // follow-up at the Mailbox API just 404s ("No such mailbox") and those failures were
    // being booked as domain hard-fails (benched 14 healthy domains on 8/15). While the
    // SMTP lane is parked, its follow-ups park with it.
    if (t.last.lane === "smtp" && process.env.MPC_SMTP_LANE !== "1") { smtpParked++; return false; }
    const d = String((t.last.from || "").split("@")[1] || "").toLowerCase();
    if (d && resting.has(d)) { deferred++; return false; }
    return true;
  });
  if (smtpParked) console.log(`  smtp lane parked: ${smtpParked} follow-up(s) held until MPC_SMTP_LANE=1`);
  if (deferred) console.log(`  domain rest: ${deferred} follow-up(s) deferred (resting: ${[...resting].join(", ")})`);

  // Fill only the REMAINING daily capacity: follow-ups + fresh sends share one 490 ceiling, so the
  // day is maxed but never over-sent. (Follow-up log rows match sent-*.jsonl, so they count too.)
  const today = new Date().toISOString().slice(0, 10);
  const sentTodayAll = rows.filter((r) => (r.at || "").slice(0, 10) === today).length;
  const OVERALL_CAP = Number(process.env.MPC_DAILY_CAP || 490);
  const capRemaining = Math.max(0, OVERALL_CAP - sentTodayAll);
  const effLimit = SEND ? Math.min(LIMIT, capRemaining) : LIMIT;
  console.log(`prospects emailed: ${byEmail.size} | replied/stopped (excluded): ${[...byEmail.keys()].filter((e) => stop.has(e)).length} | DUE: ${due.length} | sent today ${sentTodayAll}/${OVERALL_CAP}, capacity to fill ${capRemaining}`);

  // PER-BOX DAILY CAP (2026-08-20). Until now this lane had none: it sent as whoever sent
  // touch 1, bounded only by the global daily number, so follow-up volume alone pushed 12 of
  // 45 live boxes past their 2/day cap. The queued backlog on the resting domains was worse
  // (up to 13 waiting on a single mailbox), and all of it fires the day the domain revives —
  // on a domain that was benched for bouncing. Same ledgers and same cap function the cold
  // lane uses, so the two can never disagree about what a mailbox has left.
  // NO GUESSED ADDRESSES ON TOUCH 2 EITHER (owner mandate 2026-08-20). Touch 1 having been
  // accepted is not proof the mailbox exists: a catch-all domain accepts anything, and the
  // catch-all rungs are exactly where the derived addresses live. Same rule as the cold lane,
  // read off the provenance touch 1 recorded (email_source), so a thread that started on a
  // guess stops rather than spending another send on it. Rows are HELD, not dropped: when the
  // finder returns a real record for that person the sequence resumes.
  const patternHeld = [];
  const srcByEmail = PATTERN_LANE ? new Map() : sourceByEmail();
  if (!PATTERN_LANE) {
    for (let i = sendable.length - 1; i >= 0; i--) {
      const src = sendable[i].last?.email_source;
      // Threads that predate provenance logging carry no source. They are NOT assumed clean:
      // the curated row is consulted, and an unknown row is treated as derived.
      const resolved = src || srcByEmail.get(String(sendable[i].email || "").toLowerCase()) || "";
      if (tierOf(resolved) !== "found") patternHeld.push(...sendable.splice(i, 1));
    }
  }
  if (patternHeld.length) console.log(`  no-guessing: ${patternHeld.length} follow-up(s) held, touch 1 went to a derived address (MPC_PATTERN_LANE=1 re-opens the rung)`);
  const { capOf } = capByEmail();
  const boxSpend = sentTodayByBox();
  const capped = [];
  let heldByBoxCap = 0;
  for (const t of sendable) {
    const from = String(t.last?.from || "").toLowerCase();
    const cap = capOf(from);
    const used = boxSpend.get(from) || 0;
    if (used >= cap) { heldByBoxCap++; continue; }
    boxSpend.set(from, used + 1); // reserve the slot so one run cannot overshoot either
    capped.push(t);
  }
  if (heldByBoxCap) console.log(`  per-box cap: ${heldByBoxCap} follow-up(s) held, their mailbox is at its daily limit (they keep their place for tomorrow)`);
  const batch = capped.slice(0, effLimit);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = `${OUT}/followups-${stamp}.jsonl`;
  let sent = 0;
  for (const t of batch) {
    const r = t.last;
    const nextTouch = t.touches + 1;
    const rec = recruiterFor(r); // sign + write as whoever sent touch 1
    let fu;
    try { fu = await writeFollowup({ company: r.company, role: r.role, to_name: r.to_name, subject: r.subject }, nextTouch, rec); }
    catch (e) { console.log(`  SKIP ${t.email}: ${e.message}`); continue; }
    if (!fu.subject || !fu.body) continue;
    const fullBody = `Hi ${greetingName(r.to_name)},\n\n${fu.body}` + sig(rec) + foot();
    if (!SEND) {
      if (sent < 3) { console.log(`\n--- FOLLOW-UP touch ${nextTouch} | ${r.company} -> ${t.email} ---\nsubject: ${fu.subject}\n${fullBody}`); }
      sent++; continue;
    }
    const res = await sendViaMailboxApi(r.from, t.email, fu.subject, fullBody);
    // Log as a normal send row so the touch count increments for the NEXT run.
    // Provenance carries over from touch 1 so a bounce on touch 2/3 still attributes to its rung.
    appendFileSync(`${OUT}/sent-followup-${stamp}.jsonl`, JSON.stringify({ at: new Date().toISOString(), from: r.from, to_email: t.email, to_name: r.to_name, company: r.company, role: r.role, variant: r.variant, subject: fu.subject, body: fullBody, touch: nextTouch, email_source: r.email_source, tier: r.tier, verify_status: r.verify_status, result: res }) + "\n");
    if (res.ok) { sent++; console.log(`  sent follow-up ${nextTouch} -> ${t.email} (as ${r.from})`); }
    else console.log(`  FAIL ${t.email}: ${res.error}`);
    await new Promise((res2) => setTimeout(res2, 1200));
  }
  console.log(`\n${SEND ? `[SEND] ${sent} follow-ups sent. Log: ${logFile}` : `[DRY-RUN] ${sent} would send. Re-run with --send.`}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
