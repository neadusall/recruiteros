// RecruitersOS · MPC · the batch pipeline (Ryan / CPA-Controller).
//
// The solid model end to end, self-contained so it never touches the app's fragile state
// files: SOURCE (read curated) -> ROLE GATE -> DECISION-MAKER GATE -> EMAIL GATE ->
// AI-WRITE (per prospect) -> RENDER GATE -> QUEUE. It is DRY-RUN by default (writes drafts
// to a file + prints samples, sends nothing). Only `--send` actually sends, via the proven
// Sending.ac Mailbox API, rotating across Ryan's Lume boxes, and logs every send.
//
//   node scripts/mpc/batch.mjs                 # dry-run: gate + write + show, send nothing
//   node scripts/mpc/batch.mjs --limit 25      # cap how many to draft
//   node scripts/mpc/batch.mjs --send          # send the drafts that passed every gate
//
// Read-only against the curated store; writes ONLY its own files under /out.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { assessProspect, metroOf, checkRenderedEmail, cohortKeyOf } from "./gates.mjs";
import { writeEmail, signature, footer, greetingName } from "./writer.mjs";
import { pickVariant } from "./variants.mjs";

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

function ryanBoxes() {
  const s = JSON.parse(readFileSync(SENDERS, "utf8"));
  const rows = s.inboxes || (s.state && s.state.inboxes) || [];
  return rows
    .filter(m => m && m.workspaceId === LUME_WS && /ryan/i.test(m.ownerName || "") && m.provider === "sending-ac" && !m.smtpPassEnc)
    .map(m => m.email);
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

  // Stage 1-3: role + decision-maker + email gates.
  const gated = [];
  const rejected = { role: 0, dm: 0, email: 0, other: 0 };
  for (const r of curated) {
    const p = r.lead || r;
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

  // Suppression: never re-email anyone we've already contacted (makes daily autopilot safe),
  // AND dedupe within this run so a duplicate curated row can't double-send in one batch.
  const seen = alreadyEmailed();
  const blocked = loadBlockedCohorts();
  const runSeen = new Set();
  const fresh = [];
  let skippedBlocked = 0;
  for (const p of gated) {
    const e = String(p.likelyEmail || "").toLowerCase().trim();
    if (!e || seen.has(e) || runSeen.has(e)) continue;
    if (blocked.size && blocked.has(cohortKeyOf(p))) { skippedBlocked++; continue; } // recruiter said "no" to this cohort
    runSeen.add(e);
    fresh.push(p);
  }
  console.log(`already emailed: ${seen.size} | blocked-cohort skipped: ${skippedBlocked} | fresh & ready: ${fresh.length}`);

  // Cheap supply check: gates only, no AI spend. Use it to watch the finance pool fill.
  if (args.includes("--count")) {
    console.log(`\n[COUNT] clean & not-yet-contacted (ready to send): ${fresh.length}`);
    return;
  }

  // Continuous-autopilot daily cap: count what already went out TODAY across all runs and never
  // exceed the safe daily max. This lets the sender run every cycle (draining ready leads to
  // capacity) instead of once a day, without ever over-sending.
  const DAILY_CAP = Number(process.env.MPC_DAILY_CAP || 490);
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

  const batch = fresh.slice(0, effLimit);
  console.log(`\nwriting ${batch.length} emails (${SEND ? "SEND" : "DRY-RUN"})...\n`);

  const drafts = [];
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    const metro = metroOf(p);
    const variant = pickVariant(i); // even, reproducible rotation of the tested lead angles
    let email;
    try { email = await writeEmail(p, { metro, variant }); }
    catch (e) { console.log(`  SKIP (writer) ${p.company}: ${e.message}`); continue; }
    const check = checkRenderedEmail(email.subject, email.body);
    if (!check.ok) { console.log(`  SKIP (render gate) ${p.company}: ${check.problems.join(", ")}`); continue; }
    // Greeting built deterministically: "Hi <Capitalized First Name>," then a blank line, then the message.
    const fullBody = `Hi ${greetingName(p.managerName)},\n\n${email.body}` + signature() + footer();
    drafts.push({ company: p.company, role: p.role, metro: metro || "remote", variant: variant.id, variant_label: variant.label, to_name: p.managerName, to_title: p.managerTitle, to_email: p.likelyEmail, subject: email.subject, body: fullBody });
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

  const boxes = ryanBoxes();
  if (!boxes.length) { console.log("no Ryan sending boxes found; aborting send"); return; }
  console.log(`\n[SEND] rotating across ${boxes.length} Ryan boxes...`);
  const logFile = `${OUT}/sent-${stamp}.jsonl`;
  let sent = 0, failed = 0;
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const from = boxes[i % boxes.length];
    const r = await sendViaMailboxApi(from, d.to_email, d.subject, d.body);
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), from, ...d, result: r }) + "\n");
    if (r.ok) { sent++; console.log(`  sent ${d.to_email} (as ${from})${r.note ? " [" + r.note + "]" : ""}`); }
    else { failed++; console.log(`  FAIL ${d.to_email}: ${r.error}`); }
    await new Promise(res => setTimeout(res, 1200)); // pace under 60/min
  }
  console.log(`\n[SEND] done: ${sent} sent, ${failed} failed. Log: ${logFile}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
