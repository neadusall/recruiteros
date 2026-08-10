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

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { assessProspect, metroOf, checkRenderedEmail } from "./gates.mjs";
import { writeEmail, signature, footer, greetingName } from "./writer.mjs";

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
  const curated = loadArray(CURATION);

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

  const batch = gated.slice(0, LIMIT);
  console.log(`\nwriting ${batch.length} emails (${SEND ? "SEND" : "DRY-RUN"})...\n`);

  const drafts = [];
  for (const p of batch) {
    const metro = metroOf(p);
    let email;
    try { email = await writeEmail(p, { metro }); }
    catch (e) { console.log(`  SKIP (writer) ${p.company}: ${e.message}`); continue; }
    const check = checkRenderedEmail(email.subject, email.body);
    if (!check.ok) { console.log(`  SKIP (render gate) ${p.company}: ${check.problems.join(", ")}`); continue; }
    // Greeting built deterministically: "Hi <Capitalized First Name>," then a blank line, then the message.
    const fullBody = `Hi ${greetingName(p.managerName)},\n\n${email.body}` + signature() + footer();
    drafts.push({ company: p.company, role: p.role, metro: metro || "remote", to_name: p.managerName, to_title: p.managerTitle, to_email: p.likelyEmail, subject: email.subject, body: fullBody });
  }

  const draftFile = `${OUT}/drafts-${stamp}.json`;
  writeFileSync(draftFile, JSON.stringify(drafts, null, 2));
  console.log(`\n${drafts.length} drafts passed every gate. Written to ${draftFile}`);
  console.log("\n===== SAMPLES =====");
  for (const d of drafts.slice(0, 3)) {
    console.log(`\n--- ${d.company} | ${d.role} | ${d.metro} ---`);
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
