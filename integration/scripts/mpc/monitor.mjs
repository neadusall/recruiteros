// RecruitersOS · MPC · reply monitor + per-variant leaderboard.
//
// Closes the loop. batch.mjs stamps every send with the variant (lead angle) it used and logs
// it to /out/sent-*.jsonl. This reads those logs, then reads each sending box's inbox back
// through the SAME Sending.ac Mailbox API, matches inbound mail from the people we emailed,
// and reports REPLY RATE PER VARIANT so we can see what actually pulls a decision-maker into a
// conversation. Read-only against the mailboxes (never sends), safe to run on a timer.
//
//   node scripts/mpc/monitor.mjs            # scan inboxes, print the leaderboard, write matches
//
// A "reply" = an inbound message, in the box we sent from, whose sender is the exact recipient
// we emailed, received at or after our send. Conservative on purpose (no fuzzy matching).

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, renameSync } from "node:fs";

const OUT = process.env.MPC_OUT_DIR || "/out";
// The bridge: matched real replies (warm-up excluded) are written here for the app's scheduler to
// ingest into the unified inbox (processInbound). Needs the /data volume mounted on this run.
const QUEUE_FILE = process.env.MPC_REPLY_QUEUE_FILE || "/data/snap_mpc_reply_queue_v1.json";
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003"; // Lume workspace
const MAILBOX_BASE = (process.env.SENDINGAC_MAILBOX_API_BASE || "https://api.customers.ac/api/mailbox/v1alpha1").replace(/\/+$/, "") + "/azure/v1.0";
const KEY = process.env.SENDINGAC_MAILBOX_API_KEY;
const SKEW_MS = 60_000; // allow a minute of clock skew on the "received after we sent" test

function loadSent() {
  if (!existsSync(OUT)) return [];
  const rows = [];
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (r && r.result && r.result.ok && r.to_email && r.from) rows.push(r);
      } catch { /* skip bad line */ }
    }
  }
  return rows;
}

async function inboxOf(boxEmail) {
  // Pull recent messages (the /messages collection is the route the Mailbox API exposes; a named
  // mailFolders/Inbox path 404s). We match client-side: a real reply is FROM the person we emailed,
  // so sent-items (from us) never false-match, no need to scope to a folder.
  const url = `${MAILBOX_BASE}/users/${encodeURIComponent(boxEmail)}/messages?$top=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return (data.value || []).map((m) => ({
    id: m.id || "",
    from: (m.from && m.from.emailAddress && m.from.emailAddress.address || "").toLowerCase().trim(),
    received: Date.parse(m.receivedDateTime || "") || 0,
    subject: m.subject || "",
    bodyPreview: m.bodyPreview || "",
  }));
}

async function main() {
  if (!KEY) { console.error("SENDINGAC_MAILBOX_API_KEY not set"); process.exitCode = 1; return; }
  const sent = loadSent();
  if (!sent.length) { console.log("no sends logged yet (no /out/sent-*.jsonl). Nothing to monitor."); return; }

  const boxes = [...new Set(sent.map((s) => s.from))];
  console.log(`monitoring ${sent.length} sends across ${boxes.length} boxes...\n`);

  // Fetch each box's inbox once (paced under the 60/min limit).
  const inbox = new Map();
  for (const b of boxes) {
    try { inbox.set(b, await inboxOf(b)); }
    catch (e) { console.log(`  (could not read inbox ${b}: ${e.message})`); inbox.set(b, []); }
    await new Promise((r) => setTimeout(r, 1100));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchFile = `${OUT}/replies-${stamp}.jsonl`;
  const stats = new Map(); // variant -> { sent, replied }
  const bump = (v, k) => { const s = stats.get(v) || { sent: 0, replied: 0 }; s[k]++; stats.set(v, s); };

  let repliedTotal = 0;
  const queue = [];          // rows for the inbox bridge (deduped by reply message id)
  const seenMsg = new Set();
  for (const s of sent) {
    const v = s.variant || "unknown";
    bump(v, "sent");
    const sentAt = Date.parse(s.at || "") || 0;
    const box = inbox.get(s.from) || [];
    const hit = box.find((m) => m.from === s.to_email.toLowerCase().trim() && m.received >= sentAt - SKEW_MS);
    if (hit) {
      bump(v, "replied");
      repliedTotal++;
      appendFileSync(matchFile, JSON.stringify({ to_email: s.to_email, company: s.company, variant: v, from_box: s.from, sent_at: s.at, reply_subject: hit.subject, reply_at: new Date(hit.received).toISOString() }) + "\n");
      // Bridge row: a REAL prospect reply (sender == someone we emailed => never warm-up traffic).
      const msgId = hit.id || `mpc-${s.from}-${s.to_email}-${hit.received}`;
      if (!seenMsg.has(msgId)) {
        seenMsg.add(msgId);
        queue.push({ ws: WS, fromEmail: s.to_email.toLowerCase().trim(), messageId: msgId, fromName: s.to_name || undefined, text: hit.bodyPreview || hit.subject || "", receivedAt: new Date(hit.received).toISOString(), box: s.from, subject: hit.subject || undefined });
      }
    }
  }

  // Write the bridge queue for the app's scheduler to ingest into the unified inbox. Best-effort:
  // if /data isn't mounted (e.g. a standalone leaderboard run), skip silently.
  try {
    const tmp = QUEUE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(queue));
    renameSync(tmp, QUEUE_FILE);
    if (queue.length) console.log(`bridged ${queue.length} real replies -> ${QUEUE_FILE} (portal inbox)`);
  } catch (e) {
    console.log(`(reply bridge skipped: ${e.message})`);
  }

  // Leaderboard, best reply-rate first.
  const rows = [...stats.entries()]
    .map(([variant, s]) => ({ variant, sent: s.sent, replied: s.replied, rate: s.sent ? s.replied / s.sent : 0 }))
    .sort((a, b) => b.rate - a.rate || b.replied - a.replied);

  console.log("===== VARIANT LEADERBOARD (by reply rate) =====");
  console.log("variant".padEnd(18), "sent".padStart(6), "replies".padStart(9), "rate".padStart(8));
  for (const r of rows) {
    console.log(r.variant.padEnd(18), String(r.sent).padStart(6), String(r.replied).padStart(9), (`${(r.rate * 100).toFixed(1)}%`).padStart(8));
  }
  console.log("-".repeat(44));
  console.log("TOTAL".padEnd(18), String(sent.length).padStart(6), String(repliedTotal).padStart(9), (`${(repliedTotal / sent.length * 100).toFixed(1)}%`).padStart(8));
  if (repliedTotal) console.log(`\nreply details written to ${matchFile}`);
  console.log("\nTip: send a few days across all variants before trusting the ranking (small samples lie).");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
