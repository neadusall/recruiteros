// RecruitersOS · MPC · IMAP NDR sweep (bounce visibility for the OWN-SMTP lane).
//
// The fleet NDR sweep reads Sending.ac boxes through the Mailbox API; the internal
// SMTP boxes (Mailcow, mail.lumesp.com) are invisible to it, so their bounce notices
// would land unseen - the exact blind spot that hid a 15% bounce rate on 2026-08-12.
// This sweep is the same idea over IMAP: connect to every own-smtp box with stored
// credentials, read recent INBOX mail, keep campaign NDRs, classify each by the
// receiving server's stated reason, and write /data/snap_mpc_ndr_imap_v1.json.
// The host ndr-sweep.mjs merges that sidecar into the combined snap_mpc_ndr_v1, so
// deliverability -> domain-rest benching protects both lanes identically.
//
// Run (host): docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//   -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app /tools/ndr-sweep-imap.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";

const { ImapFlow } = createRequire("/app/integration/package.json")("imapflow");

const OUT = process.env.MPC_OUT_DIR || "/out";
const SIDECAR = process.env.MPC_NDR_IMAP_FILE || "/data/snap_mpc_ndr_imap_v1.json";
const SENDERS = process.env.SENDERS_FILE || "/data/snap_senders_v1.json";
const REST_FILE = process.env.MPC_REST_FILE || "/data/snap_mpc_domain_rest_v1.json";
const LOOKBACK_DAYS = Number(process.env.NDR_LOOKBACK_DAYS || 7);
const SINCE = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

// Same scheme as the app's lib/senders/crypto.ts (and batch.mjs).
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

// Campaign recipients + per-domain send counts from the send ledgers (14 days).
const sentTo = new Set();
const sentByDomain = new Map();
const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
try {
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      let r; try { r = JSON.parse(s); } catch { continue; }
      if (!r || !r.to_email || (r.at && r.at < cutoff)) continue;
      sentTo.add(String(r.to_email).toLowerCase());
      const d = String(r.from || "").split("@")[1];
      if (d) sentByDomain.set(d, (sentByDomain.get(d) || 0) + 1);
    }
  }
} catch { /* no ledgers yet: sweep still runs, campaign matching just narrows */ }

// Freshness rule (same as the API sweep): a resting domain is judged on bounces
// received AFTER its bench began, or its own history keeps it benched forever.
const restSince = new Map();
try {
  const ledger = JSON.parse(readFileSync(REST_FILE, "utf8"));
  const nowMs = Date.now();
  for (const [d, v] of Object.entries(ledger.domains || {})) {
    if (!v) continue;
    if (v.state === "resting" && (!v.until || Date.parse(v.until) > nowMs) && v.since) {
      restSince.set(d.toLowerCase(), Date.parse(v.since));
    } else {
      const revived = (v.history || []).filter((h) => h.event === "revived").map((h) => Date.parse(h.at)).filter(Number.isFinite).sort().pop();
      if (revived) restSince.set(d.toLowerCase(), revived);
    }
  }
} catch { /* no ledger: count everything */ }

const REASON_RULES = [
  // OUR box's auth failing at its own server: no send happened, so no dead address and
  // no reputation hit. Kept off bounced[]/perDomain, surfaced in perBoxInfra (mirrors
  // ndr-sweep.mjs; the API-lane merge folds both ledgers into one).
  ["relay_auth",   /not authorized to relay|sender not authorized|permissions? to send as|sendas denied/i],
  ["blocklist",    /spamhaus|blocklist|blacklist|black list|listed at|banned sending ip|poor (ip|domain)? ?reputation|5\.7\.606|s3140|barracudacentral|sorbs|spamcop|rbl/i],
  ["spam_verdict", /suspect(ed)? ?(of being |as )?spam|considered spam|classified as spam|detected as spam|message looks like spam|spamcause|s3150|high probability of spam|content filter|5\.7\.1.*(spam|content)|bulk (mail|email)/i],
  ["auth_fail",    /dmarc|spf (check )?fail|dkim|not authenticated|authentication (failed|required)|5\.7\.2[0-9]/i],
  ["dead_address", /5\.1\.[01]|user unknown|recipient(?:'s)? (address )?(not found|rejected|invalid)|no such user|does ?n[o']?t exist|couldn'?t be found|recipientnotfound|unknown recipient|invalid recipient|no mailbox|address unknown|550 #5\.1\.0/i],
  ["mailbox_full", /mailbox (is )?full|over ?quota|5\.2\.2/i],
  ["gateway_hold", /proofpoint|mimecast|pphosted|messagelabs|moderation|held for review|quarantin/i],
  ["send_limit",   /5\.4\.316|sending limit|too many (messages|recipients)|rate limit|4\.7\.850|outbound spam/i],
];
function reasonOf(text) {
  for (const [k, re] of REASON_RULES) if (re.test(text)) return k;
  return "other";
}

// Own-SMTP boxes with IMAP-reachable credentials, from the senders store snapshot.
let inboxes = [];
try {
  const snap = JSON.parse(readFileSync(SENDERS, "utf8"));
  // Own-SMTP boxes always; Gmail boxes once the operator activates them (the Google
  // cold lane, 2026-08-19). Gmail serves IMAP on imap.gmail.com with the same app
  // password, so the one sweep covers both lanes' bounce notices.
  inboxes = (snap.inboxes || snap.state?.inboxes || []).filter((m) =>
    m.status !== "paused" && m.status !== "error" &&
    (m.imapHost || m.smtpHost) && (m.imapPassEnc || m.smtpPassEnc) &&
    (m.provider === "own-smtp" || (m.status === "active" && /^smtp\.gmail\.com$/i.test(m.smtpHost || ""))));
} catch (e) {
  console.error(`cannot read senders store: ${e.message}`);
  process.exit(1);
}
console.log(`imap ndr sweep: ${inboxes.length} boxes (own-smtp + active gmail), NDRs since ${SINCE.toISOString().slice(0, 10)}`);

// Which fleet each swept box belongs to, for the provider-block radar below: a
// rejection pressure signature is only actionable per SENDING fleet (the internal
// server's IP being blocked says nothing about the Gmail-lane boxes, and vice versa).
const fleetByBox = new Map(inboxes.map((m) => [m.email, m.provider === "own-smtp" ? "internal" : "google"]));

const NDR_FROM = /postmaster@|mailer-daemon@/i;
const NDR_SUBJ = /^(undeliverable|delivery has failed|mail delivery failed|delivery status notification|message not delivered|failure notice|delivery failure|returned mail|mail delivery system)/i;

const ndrs = [];
let swept = 0, errors = 0, i = 0;
async function worker() {
  while (i < inboxes.length) {
    const m = inboxes[i++];
    const pass = decryptSecret(m.imapPassEnc || m.smtpPassEnc);
    if (!pass) { errors++; continue; }
    const client = new ImapFlow({
      host: m.imapHost || (/^smtp\.gmail\.com$/i.test(m.smtpHost || "") ? "imap.gmail.com" : m.smtpHost),
      port: m.imapPort || 993,
      secure: true,
      auth: { user: m.imapUser || m.smtpUser || m.email, pass },
      logger: false,
      socketTimeout: 30_000,
    });
    // ImapFlow surfaces socket/auth trouble as an async "error" event too; without a
    // listener one bad mailbox crashes the whole process and the sidecar never writes.
    client.on("error", () => {});
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ since: SINCE });
        const recent = (uids || []).slice(-200); // bound per box; NDR volume is tiny
        for await (const msg of client.fetch(recent, { envelope: true, source: { maxLength: 6144 } })) {
          const from = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
          const subj = String(msg.envelope?.subject || "");
          if (!(NDR_FROM.test(from) || NDR_SUBJ.test(subj))) continue;
          const text = (msg.source ? msg.source.toString("utf8") : "").replace(/\s+/g, " ");
          const rcpt = (text.match(/(?:failed[- ]recipients?|final-rcpt|original-recipient|to)[:;][^@]{0,60}?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i) || text.match(/([a-z0-9._%+-]+@(?!.*\b(?:lumesp|mailcow|googlemail|google|gmail)\b)[a-z0-9.-]+\.[a-z]{2,})/i) || [null, null])[1];
          ndrs.push({ box: m.email, rcpt: rcpt ? rcpt.toLowerCase() : null, subj: subj.slice(0, 120), at: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null, preview: text.slice(0, 400) });
        }
      } finally { lock.release(); }
      await client.logout().catch(() => {});
      swept++;
    } catch (e) {
      errors++;
      try { await client.logout(); } catch { /* already gone */ }
      console.log(`  (could not sweep ${m.email}: ${String(e.message || e).slice(0, 120)})`);
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
console.log(`swept ${swept}/${inboxes.length} boxes (${errors} errors), ${ndrs.length} NDR notices`);

// PROVIDER-BLOCK RADAR. Receiver-side "your server is not welcome" signatures, scanned
// across EVERY notice INCLUDING warm-up traffic: a burned IP shows there first, and the
// 2026-08 Gmail block sat invisible for weeks because campaign-only counters never saw
// the warm-up rejections. Detection lives here; POLICY lives in the consumers (the app's
// sender rotation and batch.mjs read the merged ledger and steer traffic away while a
// pair stays fresh). A pair heals by silence: no matches for a week and routers release it.
const BLOCK_RE = /unsolicited ?message ?error|banned sending ip|poor (ip|domain) reputation|low reputation|reputation of \d+\.\d+\.\d+\.\d+|blocked using|listed (at|on|in) [a-z0-9 .-]*(spamhaus|barracuda|spamcop|sorbs|psbl)|5\.7\.606|\bs3140\b|likely unsolicited|message (?:is |was |has been )?(?:likely )?blocked|sending ip [^.]{0,40}(blocked|denied|banned)/i;
const RECEIVER_PATTERNS = [
  ["google", /gmail|google/i],
  ["microsoft", /outlook|office ?365|\.protection\.|microsoft|5\.7\.606|\bs3140\b/i],
  ["mailspamprotection", /mailspamprotection/i],
  ["proofpoint", /proofpoint|pphosted/i],
  ["mimecast", /mimecast/i],
  ["barracuda", /barracuda/i],
];
function receiverOf(text) { for (const [k, re] of RECEIVER_PATTERNS) if (re.test(text)) return k; return null; }
const providerBlocks = {};
function noteBlock(fleet, text, at) {
  if (!BLOCK_RE.test(text)) return;
  const rcv = receiverOf(text);
  if (!rcv) return;
  const key = `${fleet}|${rcv}`;
  const b = providerBlocks[key] || (providerBlocks[key] = { fleet, provider: rcv, count: 0, lastSeen: null, sample: null });
  b.count++;
  const seen = at || new Date().toISOString();
  if (!b.lastSeen || seen > b.lastSeen) b.lastSeen = seen;
  if (!b.sample) b.sample = text.slice(0, 220);
}

const bounced = new Set();
const perDomain = {};
const perBox = {};
const byReason = {};
const reasonExamples = {};
const perBoxInfra = {};
const warmupPerBox = {};
let warmupNdrs = 0, staleSkipped = 0, infraNdrs = 0;
for (const n of ndrs) {
  const rcpt = String(n.rcpt || "").toLowerCase();
  const subjLower = n.subj.replace(/^undeliverable:\s*/i, "");
  const looksCampaign = subjLower === subjLower.toLowerCase() && /[a-z]/.test(subjLower);
  const isCampaign = (rcpt && sentTo.has(rcpt)) || looksCampaign;
  noteBlock(fleetByBox.get(n.box) || "internal", n.subj + " :: " + (n.preview || ""), n.at);
  if (!isCampaign) { warmupNdrs++; warmupPerBox[n.box] = (warmupPerBox[n.box] || 0) + 1; continue; }
  const d = n.box.split("@")[1];
  const benchStart = restSince.get(d);
  if (benchStart && Date.parse(n.at || 0) < benchStart) { staleSkipped++; continue; }
  const reason = reasonOf(n.subj + " :: " + (n.preview || ""));
  byReason[reason] = (byReason[reason] || 0) + 1;
  const ex = reasonExamples[reason] || (reasonExamples[reason] = []);
  if (ex.length < 3) ex.push({ box: n.box, rcpt: rcpt || null, text: (n.preview || n.subj).slice(0, 220), at: n.at });
  if (reason === "relay_auth") {
    infraNdrs++;
    perBoxInfra[n.box] = (perBoxInfra[n.box] || 0) + 1;
    continue;
  }
  if (rcpt && sentTo.has(rcpt)) bounced.add(rcpt);
  perDomain[d] = perDomain[d] || { bounces: 0, sent: sentByDomain.get(d) || 0 };
  perDomain[d].bounces++;
  perBox[n.box] = (perBox[n.box] || 0) + 1;
}
if (staleSkipped) console.log(`freshness rule: ${staleSkipped} pre-bench notices excluded`);
if (infraNdrs) console.log(`relay-auth rule: ${infraNdrs} our-box auth failures kept OFF the reputation books (boxes: ${Object.keys(perBoxInfra).join(", ")})`);

// bounced[] never shrinks.
if (existsSync(SIDECAR)) {
  try { for (const e of JSON.parse(readFileSync(SIDECAR, "utf8")).bounced || []) bounced.add(e); } catch { /* rebuild */ }
}
const out = {
  generatedAt: new Date().toISOString(),
  source: "imap-ndr-sweep",
  boxesSwept: swept,
  sweepErrors: errors,
  warmupNdrs,
  warmupPerBox,     // per-box warm-up bounce counts: the graduation gate holds boxes under rejection pressure
  providerBlocks,   // fleet x receiving-provider block signatures seen this window (merged into the ledger by ndr-sweep.mjs)
  infraNdrs,
  perBoxInfra,
  bounced: [...bounced].sort(),
  perDomain,
  perBox,
  byReason,
  reasonExamples,
};
const tmp = SIDECAR + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, SIDECAR);
console.log(`imap sidecar: ${out.bounced.length} bounced recipients, ${Object.keys(perDomain).length} domains with bounces, reasons ${JSON.stringify(byReason)}`);
