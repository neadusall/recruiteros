// RecruitersOS · MPC · NDR forensics (one-off diagnostic; read-only).
// Reads the actual bounce notices from the sending boxes and classifies each by the
// receiving server's own words: WHO rejected (Microsoft/Google/security gateway) and
// WHY (dead address, spam verdict, blocklist, auth). Prints a reason x sending-domain
// matrix plus real example texts, so a fix can target the actual failure mode.
//   SENDINGAC_MAILBOX_API_KEY=... node ndr-diagnose.mjs
import { readFileSync, readdirSync } from "node:fs";

const KEY = process.env.SENDINGAC_MAILBOX_API_KEY;
if (!KEY) { console.error("SENDINGAC_MAILBOX_API_KEY not set"); process.exit(1); }
const BASE = "https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0";
const OUT = process.env.MPC_OUT_DIR || "/opt/recruiteros/mpc-out";
const SINCE = new Date(Date.now() - Number(process.env.NDR_LOOKBACK_DAYS || 7) * 86_400_000).toISOString();

const boxes = new Map();
const sentTo = new Set();
const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (!r || !r.to_email || (r.at && r.at < cutoff)) continue;
    sentTo.add(String(r.to_email).toLowerCase());
    if (r.from) boxes.set(r.from, 1);
  }
}
const boxList = [...boxes.keys()];
console.error(`diagnosing NDRs across ${boxList.length} boxes since ${SINCE.slice(0, 10)}...`);

async function get(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after")) || 15;
      await new Promise((res) => setTimeout(res, Math.min(ra, 60) * 1000 + attempt * 2000));
      continue;
    }
    if (!r.ok) return { error: r.status };
    return r.json();
  }
  return { error: 429 };
}

// Reason classifier: the receiving server's own words, most specific first.
const RULES = [
  ["blocklist",     /spamhaus|blocklist|blacklist|black list|listed at|banned sending ip|poor (ip|domain)? ?reputation|5\.7\.606|s3140|barracudacentral|sorbs|spamcop|rbl/i],
  ["spam_verdict",  /suspect(ed)? ?(of being |as )?spam|considered spam|classified as spam|detected as spam|message looks like spam|spamcause|s3150|high probability of spam|content filter|5\.7\.1.*(spam|content)|bulk (mail|email)/i],
  ["auth_fail",     /dmarc|spf (check )?fail|dkim|not authenticated|authentication (failed|required)|5\.7\.2[0-9]/i],
  ["user_unknown",  /5\.1\.[01]|user unknown|recipient(?:'s)? (address )?(not found|rejected|invalid)|no such user|does ?n[o']?t exist|couldn'?t be found|recipientnotfound|unknown recipient|invalid recipient|no mailbox|address unknown|5\.4\.1.*recipient|550 #5\.1\.0/i],
  ["mailbox_full",  /mailbox (is )?full|over ?quota|5\.2\.2/i],
  ["gateway_hold",  /proofpoint|mimecast|pphosted|messagelabs|moderation|held for review|quarantin/i],
  ["send_limit",    /5\.4\.316|sending limit|too many (messages|recipients)|rate limit|4\.7\.850|outbound spam/i],
];
function classify(text) {
  for (const [k, re] of RULES) if (re.test(text)) return k;
  return "other";
}
function receiverOf(text, rcpt) {
  if (/outlook|office365|microsoft|protection\.outlook/i.test(text)) return "microsoft";
  if (/google|gmail|googlemail/i.test(text)) return "google";
  if (/proofpoint|pphosted/i.test(text)) return "proofpoint";
  if (/mimecast/i.test(text)) return "mimecast";
  if (/barracuda/i.test(text)) return "barracuda";
  const d = (rcpt || "").split("@")[1] || "";
  return d ? "other:" + d.split(".").slice(-2).join(".") : "unknown";
}

const byReason = new Map();          // reason -> count
const byReasonDomain = new Map();    // reason -> {sendingDomain: n}
const byReceiver = new Map();        // receiver -> count
const examples = new Map();          // reason -> [{box, rcpt, text}]
let total = 0, campaign = 0, errors = 0, i = 0;

async function worker() {
  while (i < boxList.length) {
    const email = boxList[i++];
    const enc = encodeURIComponent(email);
    try {
      let url = `${BASE}/users/${enc}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${SINCE}`)}&$select=from,subject,receivedDateTime,bodyPreview&$top=100`;
      let pages = 0;
      while (url && pages < 5) {
        const d = await get(url);
        if (d.error) { errors++; break; }
        for (const m of d.value || []) {
          const from = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || "").toLowerCase();
          const subj = String(m.subject || "");
          if (!(/postmaster@|mailer-daemon@/i.test(from) ||
                /^(undeliverable|delivery has failed|mail delivery failed|delivery status notification|message not delivered|failure notice|delivery failure)/i.test(subj))) continue;
          total++;
          const preview = String(m.bodyPreview || "");
          const rcpt = (preview.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [""])[0].toLowerCase();
          if (rcpt && !sentTo.has(rcpt)) continue; // warm-up / non-campaign noise
          campaign++;
          const text = subj + " :: " + preview;
          const reason = classify(text);
          const recv = receiverOf(text, rcpt);
          byReason.set(reason, (byReason.get(reason) || 0) + 1);
          byReceiver.set(recv, (byReceiver.get(recv) || 0) + 1);
          const sd = email.split("@")[1] || "?";
          const rd = byReasonDomain.get(reason) || {};
          rd[sd] = (rd[sd] || 0) + 1;
          byReasonDomain.set(reason, rd);
          const ex = examples.get(reason) || [];
          if (ex.length < 4) { ex.push({ box: email, rcpt, text: preview.replace(/\s+/g, " ").slice(0, 260) }); examples.set(reason, ex); }
        }
        url = d["@odata.nextLink"] || null;
        pages++;
      }
    } catch { errors++; }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));

console.log(JSON.stringify({
  sweptBoxes: boxList.length, apiErrors: errors, noticesTotal: total, campaignNdrs: campaign,
  byReason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
  byReceiver: Object.fromEntries([...byReceiver.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)),
  byReasonDomain: Object.fromEntries([...byReasonDomain.entries()].map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 10))])),
  examples: Object.fromEntries(examples),
}, null, 2));
