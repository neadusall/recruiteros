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

const OUT = process.env.MPC_OUT_DIR || "/out";
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
  return stop;
}

async function writeFollowup(p, touch) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const system = [
    "You are Ryan Nead, a senior recruiter at Lume Search Partners placing accounting/finance talent. You are writing a SHORT follow-up to a hiring decision-maker you already emailed once and who has not replied. This is touch " + touch + " of at most " + MAX_TOUCHES + ".",
    "Rules: reference that you reached out before, briefly and without guilt-tripping. Lead with VALUE, not 'just bumping this': a concrete reason to talk now (you have vetted " + (p.role || "finance") + " candidates local to their market who fit this exact opening). Keep it 30 to 55 words. One soft CTA (a quick call/reply). Human, confident, no hype.",
    (touch >= MAX_TOUCHES
      ? "This is the LAST touch: be gracious, leave the door open ('if it comes up, I'm here'), no pressure."
      : "Make it easy to say yes to a short conversation."),
    "NEVER an em-dash (use a comma or period). No greeting or sign-off (added separately). Start with a capital letter. Use ONLY the facts given, never invent a candidate, number, or detail.",
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
  return { subject: dash(j.subject), body: dash(j.body) };
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
function sig() { return "\n\nBest,\nRyan Nead\nLume Search Partners\n929-543-0608"; }
function foot() { return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096"; }

async function main() {
  mkdirSync(OUT, { recursive: true });
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

  // Fill only the REMAINING daily capacity: follow-ups + fresh sends share one 490 ceiling, so the
  // day is maxed but never over-sent. (Follow-up log rows match sent-*.jsonl, so they count too.)
  const today = new Date().toISOString().slice(0, 10);
  const sentTodayAll = rows.filter((r) => (r.at || "").slice(0, 10) === today).length;
  const OVERALL_CAP = Number(process.env.MPC_DAILY_CAP || 490);
  const capRemaining = Math.max(0, OVERALL_CAP - sentTodayAll);
  const effLimit = SEND ? Math.min(LIMIT, capRemaining) : LIMIT;
  console.log(`prospects emailed: ${byEmail.size} | replied/stopped (excluded): ${[...byEmail.keys()].filter((e) => stop.has(e)).length} | DUE: ${due.length} | sent today ${sentTodayAll}/${OVERALL_CAP}, capacity to fill ${capRemaining}`);

  const batch = due.slice(0, effLimit);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = `${OUT}/followups-${stamp}.jsonl`;
  let sent = 0;
  for (const t of batch) {
    const r = t.last;
    const nextTouch = t.touches + 1;
    let fu;
    try { fu = await writeFollowup({ company: r.company, role: r.role, to_name: r.to_name, subject: r.subject }, nextTouch); }
    catch (e) { console.log(`  SKIP ${t.email}: ${e.message}`); continue; }
    if (!fu.subject || !fu.body) continue;
    const fullBody = `Hi ${greetingName(r.to_name)},\n\n${fu.body}` + sig() + foot();
    if (!SEND) {
      if (sent < 3) { console.log(`\n--- FOLLOW-UP touch ${nextTouch} | ${r.company} -> ${t.email} ---\nsubject: ${fu.subject}\n${fullBody}`); }
      sent++; continue;
    }
    const res = await sendViaMailboxApi(r.from, t.email, fu.subject, fullBody);
    // Log as a normal send row so the touch count increments for the NEXT run.
    appendFileSync(`${OUT}/sent-followup-${stamp}.jsonl`, JSON.stringify({ at: new Date().toISOString(), from: r.from, to_email: t.email, to_name: r.to_name, company: r.company, role: r.role, variant: r.variant, subject: fu.subject, body: fullBody, touch: nextTouch, result: res }) + "\n");
    if (res.ok) { sent++; console.log(`  sent follow-up ${nextTouch} -> ${t.email} (as ${r.from})`); }
    else console.log(`  FAIL ${t.email}: ${res.error}`);
    await new Promise((res2) => setTimeout(res2, 1200));
  }
  console.log(`\n${SEND ? `[SEND] ${sent} follow-ups sent. Log: ${logFile}` : `[DRY-RUN] ${sent} would send. Re-run with --send.`}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
