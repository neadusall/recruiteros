// RecruitersOS · one-off, READ-ONLY radar forensics.
// Answers one question: are the provider-block ledger's pairs REAL receiver-side
// blocks, or is the detector over-triggering? Reads a small sample of raw NDRs from
// internal-fleet boxes and prints the exact text around each block-signature match,
// grouped by the receiver the radar would name. Writes nothing.
import { readFileSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";

const { ImapFlow } = createRequire("/app/integration/package.json")("imapflow");
const SENDERS = "/data/snap_senders_v1.json";
const SINCE = new Date(Date.now() - 3 * 86_400_000);
const BOX_LIMIT = Number(process.env.RV_BOXES || 6);
const PER_BOX = Number(process.env.RV_PER_BOX || 25);

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

// EXACT copies of the live radar's rules (ndr-sweep-imap.mjs).
const BLOCK_RE = /unsolicited ?message ?error|banned sending ip|poor (ip|domain) reputation|low reputation|reputation of \d+\.\d+\.\d+\.\d+|blocked using|listed (at|on|in) [a-z0-9 .-]*(spamhaus|barracuda|spamcop|sorbs|psbl)|5\.7\.606|\bs3140\b|likely unsolicited|message (?:is |was |has been )?(?:likely )?blocked|sending ip [^.]{0,40}(blocked|denied|banned)/i;
const RECEIVER_PATTERNS = [
  ["google", /gmail|google/i],
  ["microsoft", /outlook|office ?365|\.protection\.|microsoft|5\.7\.606|\bs3140\b/i],
  ["mailspamprotection", /mailspamprotection/i],
  ["proofpoint", /proofpoint|pphosted/i],
  ["mimecast", /mimecast/i],
  ["barracuda", /barracuda/i],
];
function receiverOf(t) { for (const [k, re] of RECEIVER_PATTERNS) if (re.test(t)) return k; return null; }

const snap = JSON.parse(readFileSync(SENDERS, "utf8"));
const boxes = (snap.inboxes || snap.state?.inboxes || [])
  .filter((m) => m.provider === "own-smtp" && m.smtpPassEnc && m.status !== "paused")
  .slice(0, BOX_LIMIT);
console.log(`radar forensics: sampling ${boxes.length} internal boxes, up to ${PER_BOX} recent messages each\n`);

const NDR_FROM = /postmaster@|mailer-daemon@/i;
const NDR_SUBJ = /^(undeliverable|delivery has failed|mail delivery failed|delivery status notification|message not delivered|failure notice|delivery failure|returned mail|mail delivery system)/i;

const byReceiver = new Map();
let scanned = 0, matched = 0;

for (const m of boxes) {
  const pass = decryptSecret(m.smtpPassEnc);
  if (!pass) continue;
  const client = new ImapFlow({
    host: m.imapHost || m.smtpHost, port: m.imapPort || 993, secure: true,
    auth: { user: m.imapUser || m.smtpUser || m.email, pass }, logger: false, socketTimeout: 30000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since: SINCE });
      for await (const msg of client.fetch((uids || []).slice(-PER_BOX), { envelope: true, source: { maxLength: 6144 } })) {
        const from = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
        const subj = String(msg.envelope?.subject || "");
        if (!(NDR_FROM.test(from) || NDR_SUBJ.test(subj))) continue;
        scanned++;
        const text = (msg.source ? msg.source.toString("utf8") : "").replace(/\s+/g, " ");
        const full = subj + " :: " + text;
        if (!BLOCK_RE.test(full)) continue;
        matched++;
        const hit = full.search(BLOCK_RE);
        const windowText = full.slice(Math.max(0, hit - 300), hit + 300);
        const rcv = receiverOf(windowText) || receiverOf(full) || "UNCLASSIFIED";
        const centered = full.slice(Math.max(0, hit - 90), hit + 190);
        const arr = byReceiver.get(rcv) || [];
        if (arr.length < 3) { arr.push(centered); byReceiver.set(rcv, arr); }
        else byReceiver.set(rcv, arr);
        byReceiver.get(rcv).total = (byReceiver.get(rcv).total || 0) + 1;
      }
    } finally { lock.release(); }
    await client.logout().catch(() => {});
  } catch (e) {
    console.log(`  (skip ${m.email}: ${String(e.message || e).slice(0, 80)})`);
    try { await client.logout(); } catch {}
  }
}

console.log(`\nscanned ${scanned} NDR notices, ${matched} matched a block signature\n`);
for (const [rcv, arr] of byReceiver) {
  console.log(`===== ${rcv} (${arr.total || arr.length} matches in sample) =====`);
  arr.forEach((t, i) => console.log(`  [${i + 1}] ...${t}...\n`));
}
