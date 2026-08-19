// RecruitersOS · MPC · touch-2 VIDEO follow-up (the second email: a personalized video).
//
// Touch 1 (batch.mjs) is a text cold email. Touch 2 is a SHORT note linking a personalized video
// already rendered for that prospect's exact company+role opening (the video fleet renders from the
// same in-market pool the finance engine sources, so every touch-1 recipient has a matching video).
//
// For each prospect emailed on a target date who has NOT replied/stopped and has a rendered video:
//   1. Look up the exact company+role videoKey in the autovideo map.
//   2. Mint a signed, expiring watch link (same HMAC scheme as lib/inmarket/shareSign.ts) on the
//      workspace's own host (Lume -> app.lumesp.com), so the landing page is Lume-branded.
//   3. Write a short video-follow-up from the SAME recruiter + SAME box that sent touch 1 (thread +
//      sending-domain continuity), copy-aligned ("a video about your <role> opening" is literally
//      true), no em-dash, no unsubscribe (cold), signed with the recruiter's own BD line.
//   4. Send via the Sending.ac Mailbox API and log a touch:2 row into the SAME sent-*.jsonl ledger
//      so per-recruiter stats, attribution, and the reply monitor all pick it up.
//
// Dry-run by default (prints cohort + a sample email + its watch link, sends nothing). --send to send.
//   node scripts/mpc/video-email2.mjs --owner ryan --date 2026-08-11            # dry-run
//   node scripts/mpc/video-email2.mjs --owner ryan --date 2026-08-11 --send     # send
//
// Flags: --owner <name|key> (default ryan) · --date YYYY-MM-DD (touch-1 date, default yesterday UTC)
//        --limit N · --per-box N (default 1; a box that sent touch 1 can carry one touch 2 today)

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHmac, createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";

const OUT = process.env.MPC_OUT_DIR || "/out";
const DATA = process.env.MPC_DATA_DIR || "/data";
const SENDERS = process.env.MPC_SENDERS_FILE || `${DATA}/snap_senders_v1.json`;
const INBOX_FILE = process.env.MPC_INBOX_FILE || `${DATA}/snap_inbox.json`;
const VIDEO_MAP = process.env.MPC_VIDEO_MAP || `${DATA}/snap_inmarket_autovideo_map_v1.json`;
const LUME_WS = process.env.MPC_LUME_WS || "ws_mqf6o989003";

// Domain rest fail-safe (same ledger batch.mjs and followup.mjs enforce): touch 2 goes out on
// the SAME box as touch 1, so while that box's domain is resting the video email simply waits
// and sends on a later run. Fail-open: no ledger means no domain is benched.
const REST_FILE = process.env.MPC_REST_FILE || `${DATA}/snap_mpc_domain_rest_v1.json`;
function restingDomains() {
  try {
    const r = JSON.parse(readFileSync(REST_FILE, "utf8"));
    const now = Date.now();
    return new Set(Object.entries(r.domains || {})
      .filter(([, v]) => v && v.state === "resting" && (!v.until || Date.parse(v.until) > now))
      .map(([d]) => d.toLowerCase()));
  } catch { return new Set(); }
}
const MODEL = process.env.MPC_WRITER_MODEL || "claude-haiku-4-5";

// Own-SMTP lane (Ariel's boxes), ported from batch.mjs so her sequence isn't touch-1-only:
// same MPC_SMTP_LANE=1 unlock as batch (the lane stays PARKED until her domains are warmed;
// parked rows are simply deferred, never lost), same AES-256-GCM password scheme.
const SMTP_LANE = process.env.MPC_SMTP_LANE === "1";
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
let _smtpBoxes = null;
function smtpBoxFor(emailLc) {
  if (!_smtpBoxes) {
    _smtpBoxes = new Map();
    try {
      const s = JSON.parse(readFileSync(SENDERS, "utf8"));
      for (const m of (s.inboxes || (s.state && s.state.inboxes) || [])) {
        if (m && m.provider === "own-smtp" && m.email && m.smtpPassEnc) {
          _smtpBoxes.set(m.email.toLowerCase(), { email: m.email, host: m.smtpHost, port: m.smtpPort || 587, secure: !!m.smtpSecure, user: m.smtpUser || m.email, passEnc: m.smtpPassEnc });
        }
      }
    } catch { /* no senders file: SMTP lane simply unavailable */ }
  }
  return _smtpBoxes.get(emailLc) || null;
}
const MAILBOX_BASE = (process.env.SENDINGAC_MAILBOX_API_BASE || "https://api.customers.ac/api/mailbox/v1alpha1").replace(/\/+$/, "") + "/azure/v1.0";
const APP_HOST = process.env.MPC_APP_HOST || "https://app.lumesp.com"; // Lume portal host (branded watch page)
const SHARE_SECRET = process.env.RECRUITEROS_SESSION_SECRET || process.env.RECRUITEROS_API_TOKEN || "ros-share-dev-secret";
const SHARE_TTL_DAYS = Math.max(0, Number(process.env.RECRUITEROS_SHARE_TTL_DAYS ?? "45") || 0);

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const SEND = args.includes("--send");
const OWNER = (flag("owner", "ryan") || "ryan").toLowerCase();
const yestUTC = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const DATE = flag("date", yestUTC);
const PER_BOX = Number(flag("per-box", "1")) || 1;
const LIMIT = Number(flag("limit", "")) || (SEND ? 100000 : 5);

const RECRUITER_INFO = {
  "ryan":           { name: "Ryan Nead",      phone: "929-543-0608" },
  "ryan nead":      { name: "Ryan Nead",      phone: "929-543-0608" },
  "sam wagner":     { name: "Sam Wagner",     phone: "929-401-0849" },
  "josh gurin":     { name: "Josh Gurin",     phone: "929-532-0756" },
  "noah wilkowski": { name: "Noah Wilkowski", phone: "929-543-0584" },
  // Ariel's boxes are the own-SMTP lane; the Mailbox API send below can't carry them yet, so
  // her runs will report failures rather than sends until an SMTP path is added here.
  "ariel grosser":  { name: "Ariel Grosser",  phone: "929-695-9010" },
};
// First-name aliases so `--owner josh` reaches Josh's cohort (the 2026-08-12 bug: only "ryan"
// was aliased, so every other recruiter's run silently resolved to an empty cohort and their
// touch-1 recipients never got the video email).
const OWNER_ALIAS = { ryan: "ryan nead", josh: "josh gurin", noah: "noah wilkowski", sam: "sam wagner", ariel: "ariel grosser" };
const canonOwnerKey = (o) => { const t = String(o || "").trim().toLowerCase(); return OWNER_ALIAS[t] || t; };

// box email -> owner name (backfills touch-1 rows that predate from_owner)
let _boxOwner = null;
function boxOwnerName(email) {
  if (!_boxOwner) {
    _boxOwner = new Map();
    try {
      const s = JSON.parse(readFileSync(SENDERS, "utf8"));
      for (const m of (s.inboxes || (s.state && s.state.inboxes) || [])) {
        if (m && m.workspaceId === LUME_WS && m.email && m.ownerName) _boxOwner.set(m.email.toLowerCase(), m.ownerName.trim());
      }
    } catch { /* no senders file */ }
  }
  return _boxOwner.get(String(email || "").toLowerCase()) || "";
}
const ownerOf = (r) => canonOwnerKey(r.from_owner || boxOwnerName(r.from) || "");

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
// Anyone who replied (any sentiment) or is in the inbox => STOP (never video-follow a live thread).
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

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function loadVideoMap() {
  const byCR = new Map();
  try {
    const map = JSON.parse(readFileSync(VIDEO_MAP, "utf8"));
    for (const v of Object.values(map)) if (v && v.videoKey) byCR.set(norm(v.company) + "|" + norm(v.role), v);
  } catch { /* no map */ }
  return byCR;
}
function watchLink(videoKey, recipientEmail) {
  const exp = SHARE_TTL_DAYS > 0 ? Date.now() + Math.round(SHARE_TTL_DAYS * 86400000) : 0;
  const sig = createHmac("sha256", SHARE_SECRET).update(`share:${videoKey}:${exp}`).digest("base64url").slice(0, 24);
  // rcpt attributes every watch (open/play/complete) to THIS exact person, so the watchers
  // read + the LinkedIn connect-on-watch key off who we emailed, not just the shared company+role.
  const rcpt = recipientEmail ? `&rcpt=${encodeURIComponent(String(recipientEmail).toLowerCase())}` : "";
  return `${APP_HOST}/watch?k=${encodeURIComponent(videoKey)}&exp=${exp}&sig=${sig}${rcpt}`;
}

const stripDash = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").trim();
function greetingName(name) { const n = (name || "there").trim().split(/\s+/)[0] || "there"; return n.charAt(0).toUpperCase() + n.slice(1); }

// Non-person guard: touch-1 sourcing occasionally parses a newsletter/role/company string into a
// "contact" ("Trending Topics", "Founder/Managing Partner, Abstract Ventures"). A video email that
// opens "Hi Trending" burns sender reputation, so those rows are dropped from touch 2.
const GENERIC_LOCALPART = /^(info|contact|hello|team|careers?|jobs?|hr|recruit(ing|er)?|hiring|talent|admin|sales|support|press|media|marketing|news|office|accounts?|billing|noreply|no-reply|trending|founder|foundermanaging|general|help|inquir)/i;
const GENERIC_FIRST = new Set(["trending","founder","co-founder","cofounder","managing","info","team","careers","career","hr","recruiting","recruiter","hiring","talent","admin","sales","support","press","media","marketing","news","office","accounts","billing","general","hello","contact","the","dept","department","group","staff"]);
function nonPerson(r) {
  const name = String(r.to_name || "").trim();
  const first = (name.split(/\s+/)[0] || "").toLowerCase().replace(/[^a-z-]/g, "");
  const local = String(r.to_email || "").split("@")[0] || "";
  if (!name) return "no-name";
  if (/[\/,]/.test(name)) return "role-or-company-name"; // "Founder/Managing Partner, Abstract Ventures"
  if (GENERIC_FIRST.has(first)) return "generic-first-name";
  if (GENERIC_LOCALPART.test(local)) return "generic-mailbox";
  if (!/^[a-z][a-z.'-]+$/i.test(first)) return "unparseable-name";
  return null;
}

async function writeVideoNote(p, rec) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const role = stripDash(p.role || "this opening");
  const system = [
    `You are ${rec.name}, a senior recruiter at Lume Search Partners placing accounting and finance talent. You already sent this hiring decision-maker one short email about their open ${role} and they have not replied. This is touch 2: a SHORT note pointing them to a personalized video you recorded about candidates for THIS exact opening.`,
    "Rules: 25 to 45 words. Reference your earlier note briefly, no guilt. State that you recorded a quick video walking through a few vetted candidates for their " + role + " opening, local to their market. The video link is inserted AFTER your text, so end on a natural lead-in to it (do not write the URL yourself). One soft CTA. Human, warm, confident, no hype.",
    "NEVER an em-dash (use a comma or period). No greeting or sign-off (added separately). Start with a capital letter. Use ONLY the facts given, never invent a candidate, number, or detail.",
    'Return STRICT JSON only: {"subject": string, "body": string}. Subject short, lowercase, may echo the original thread about the ' + role + " opening.",
  ].join("\n");
  const facts = { company: p.company, open_role: role, decision_maker: p.to_name, prior_subject: p.subject || null };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 320, system, messages: [{ role: "user", content: "Facts:\n" + JSON.stringify(facts, null, 2) + "\n\nWrite touch 2 as strict JSON." }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { subject: stripDash(j.subject), body: stripDash(j.body) };
}

function assemble(p, rec, note, link) {
  const body =
    `Hi ${greetingName(p.to_name)},\n\n` +
    note.body + "\n\n" +
    `Here is the video: ${link}\n\n` +
    `Best,\n${rec.name}\nLume Search Partners\n${rec.phone}\n\n` +
    `Lume Search Partners · 148 Doughty Blvd, Inwood, NY 11096`;
  return { subject: note.subject, body };
}

async function sendViaMailboxApi(fromEmail, to, subject, body) {
  const key = process.env.SENDINGAC_MAILBOX_API_KEY;
  if (!key) throw new Error("SENDINGAC_MAILBOX_API_KEY not set");
  const res = await fetch(`${MAILBOX_BASE}/users/${encodeURIComponent(fromEmail)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 202 || res.status === 200 || res.status === 502) return { ok: true };
  return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 140)}` };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const rows = loadSentRows();
  const stop = repliedOrStopped();
  const videoByCR = loadVideoMap();
  const recInfo = RECRUITER_INFO[canonOwnerKey(OWNER)] || RECRUITER_INFO["ryan nead"];

  // Touch-1 rows for this owner on the target date. First (earliest) touch per recipient is touch 1.
  const firstTouch = new Map();
  for (const r of rows) {
    if (ownerOf(r) !== canonOwnerKey(OWNER)) continue;
    if ((r.at || "").slice(0, 10) !== DATE) continue;
    const e = String(r.to_email).toLowerCase().trim();
    const cur = firstTouch.get(e);
    if (!cur || (r.at || "") < (cur.at || "")) firstTouch.set(e, r);
  }
  // Who already has ANY touch-2 (video) so re-runs never double-send.
  const alreadyV2 = new Set(rows.filter((r) => r.touch === 2 || r.touch2 || r.kind === "video2").map((r) => String(r.to_email).toLowerCase().trim()));

  const cohort = [];
  const skips = { replied: 0, already_v2: 0, no_video: 0, non_person: 0 };
  for (const [email, r] of firstTouch) {
    if (stop.has(email)) { skips.replied++; continue; }
    if (alreadyV2.has(email)) { skips.already_v2++; continue; }
    if (nonPerson(r)) { skips.non_person++; continue; }
    const v = videoByCR.get(norm(r.company) + "|" + norm(r.role));
    if (!v) { skips.no_video++; continue; }
    cohort.push({ r, video: v });
  }

  console.log(`video-email2 · owner=${recInfo.name} · touch-1 date=${DATE}`);
  console.log(`  touch-1 recipients: ${firstTouch.size} | eligible with video: ${cohort.length} | skipped: replied ${skips.replied}, already-v2 ${skips.already_v2}, non-person ${skips.non_person}, no-video ${skips.no_video}`);

  // Per-box daily cap (deliverability): a box may carry at most MPC_PER_BOX_DAILY sends TODAY, across
  // this run AND today's fresh sends. Seed the counter from today's existing ledger so we never push
  // a box over its 2/day floor even when the always-on tick is also sending.
  const PER_BOX_DAILY = Number(process.env.MPC_PER_BOX_DAILY || "2");
  const today = new Date().toISOString().slice(0, 10);
  const boxCount = new Map();
  for (const r of rows) {
    if ((r.at || "").slice(0, 10) !== today) continue;
    const from = String(r.from || "").toLowerCase();
    boxCount.set(from, (boxCount.get(from) || 0) + 1);
  }
  let sent = 0, failed = 0, done = 0;
  const outFile = `${OUT}/sent-video2-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  const resting = restingDomains();
  let capped = 0, deferredRest = 0, parkedLane = 0;
  for (const item of cohort) {
    if (sent + failed >= LIMIT && SEND) break;
    if (done >= LIMIT && !SEND) break;
    const r = item.r, from = r.from, fromLc = String(from).toLowerCase();
    if (resting.has(fromLc.split("@")[1] || "")) { deferredRest++; continue; } // domain resting: touch 2 waits
    if ((boxCount.get(fromLc) || 0) >= PER_BOX_DAILY) { capped++; continue; } // box at its daily floor
    const smtpBox = smtpBoxFor(fromLc);
    if (smtpBox && !SMTP_LANE) { parkedLane++; continue; } // own-SMTP lane parked until warmed; row stays due
    const link = watchLink(item.video.videoKey, r.to_email);
    let note;
    try { note = await writeVideoNote(r, recInfo); }
    catch (e) { console.log(`  ! writer failed for ${r.to_email}: ${e.message}`); continue; }
    const msg = assemble(r, recInfo, note, link);
    if (/[—–]/.test(msg.subject + msg.body)) { console.log(`  ! em-dash guard tripped for ${r.to_email}, skipping`); continue; }

    if (!SEND) {
      if (done < (Number(flag("limit", "")) || 5)) {
        console.log(`\n----- SAMPLE ${done + 1}: ${r.to_name} <${r.to_email}> · ${r.company} / ${stripDash(r.role)} · from ${from}`);
        console.log(`SUBJECT: ${msg.subject}`);
        console.log(msg.body);
      }
      done++; boxCount.set(fromLc, (boxCount.get(fromLc) || 0) + 1);
      continue;
    }

    const res = smtpBox
      ? await sendViaSmtp(smtpBox, recInfo.name, r.to_email, msg.subject, msg.body)
      : await sendViaMailboxApi(from, r.to_email, msg.subject, msg.body);
    const rec = {
      at: new Date().toISOString(), from, from_owner: recInfo.name, lane: smtpBox ? "smtp" : "api", touch: 2, kind: "video2",
      company: r.company, role: r.role, metro: r.metro || "", videoKey: item.video.videoKey, watch: link,
      to_name: r.to_name, to_title: r.to_title || "", to_email: r.to_email, subject: msg.subject, body: msg.body, result: res,
    };
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    if (res.ok) { sent++; } else { failed++; console.log(`  ! send failed ${r.to_email}: ${res.error}`); }
    done++; boxCount.set(fromLc, (boxCount.get(fromLc) || 0) + 1);
    await new Promise((r) => setTimeout(r, 250)); // gentle pacing
  }

  if (deferredRest) console.log(`  domain rest: ${deferredRest} touch-2 email(s) deferred (resting: ${[...resting].join(", ")})`);
  if (SEND) console.log(`\nvideo-email2 -> sent ${sent}, failed ${failed}, held-by-box-cap ${capped}, parked-smtp-lane ${parkedLane} (ledger ${outFile})`);
  else console.log(`\n(dry run) ${done} would send now; ${capped} held by the 2/box/day cap (go tomorrow); ${parkedLane} parked with the own-SMTP lane (set MPC_SMTP_LANE=1 when warmed). Re-run with --send to send.`);
}

main().catch((e) => { console.error("video-email2 fatal:", e.message); process.exit(1); });
