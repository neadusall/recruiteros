// RecruitersOS · MPC · fleet NDR sweep (the bounce-visibility layer).
//
// Bounce notices go to the SENDING mailbox, and the campaign sends from ~560 Sending.ac boxes,
// so the unified inbox (recruiter reply boxes only) sees almost none of them. This is how a 15%
// bounce rate displayed as "1 bounce" on 2026-08-12. This sweep reads every box used by the
// campaign in the last 14 days through the Mailbox API, collects campaign NDRs, and maintains
// /data/snap_mpc_ndr_v1.json:
//   - bounced[]  : recipients whose mail bounced -> followup.mjs stop-list (never touch again)
//   - perDomain  : bounce counts per SENDING domain -> mpc-deliverability.mjs -> domain-rest.mjs
//                  (a bouncing domain now benches within a rota cycle, not never)
// Runs from mpc-ndr-sweep.timer on the HOST (survives app-container swaps). Fail-open: an API
// outage leaves the previous sidecar in place; bounced[] only ever grows (merge on write).
//
//   SENDINGAC_MAILBOX_API_KEY=... node ndr-sweep.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";

const KEY = process.env.SENDINGAC_MAILBOX_API_KEY;
if (!KEY) { console.error("SENDINGAC_MAILBOX_API_KEY not set"); process.exit(1); }
const BASE = "https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0";
const OUT = process.env.MPC_OUT_DIR || "/opt/recruiteros/mpc-out";
const SIDECAR = process.env.MPC_NDR_FILE || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_ndr_v1.json";
const LOOKBACK_DAYS = Number(process.env.NDR_LOOKBACK_DAYS || 7);
const SINCE = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

// Boxes + recipients + per-domain send counts from the send logs (last 14 days of files).
const boxes = new Map(); // from -> sends
const sentTo = new Set();
const sentByDomain = new Map();
// PROVENANCE (2026-08-20): belt-era send rows carry the rung that produced the address
// (email_source) and its proof tier. Joining bounces back to those fields is what lets the
// send fuse pause ONE bouncing rung instead of benching the domains it burned.
const sentMeta = new Map();   // rcpt -> { source, tier, at, from } (latest send wins)
const sentBySource = {};      // source -> real sends in the 14d window
const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (!r || !r.to_email || (r.at && r.at < cutoff)) continue;
    const rcptKey = String(r.to_email).toLowerCase();
    sentTo.add(rcptKey);
    if (r.email_source) {
      const prev = sentMeta.get(rcptKey);
      if (!prev || String(r.at || "") > String(prev.at || "")) sentMeta.set(rcptKey, { source: r.email_source, tier: r.tier || null, at: r.at || null, from: r.from || null });
      if (r.result && r.result.ok) sentBySource[r.email_source] = (sentBySource[r.email_source] || 0) + 1;
    }
    if (r.from) {
      boxes.set(r.from, (boxes.get(r.from) || 0) + 1);
      const d = String(r.from).split("@")[1];
      if (d) sentByDomain.set(d, (sentByDomain.get(d) || 0) + 1);
    }
  }
}
const boxList = [...boxes.keys()];
console.log(`sweeping ${boxList.length} boxes, NDRs since ${SINCE.slice(0, 10)}`);

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

const ndrs = [];
let errors = 0, swept = 0, i = 0;
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
          const rcpt = (String(m.bodyPreview || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [null])[0];
          ndrs.push({ box: email, rcpt, subj: subj.slice(0, 120), at: m.receivedDateTime, preview: String(m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300) });
        }
        url = d["@odata.nextLink"] || null;
        pages++;
      }
      swept++;
    } catch { errors++; }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
console.log(`swept ${swept}/${boxList.length} boxes (${errors} errors), ${ndrs.length} NDR notices`);

// Campaign NDRs only (recipient matches a logged send, or an all-lowercase campaign subject).
// FRESHNESS RULE for resting domains: a bench must be judged on bounces received AFTER it began.
// A resting domain sends nothing, so its pre-bench bounce count can only age, never improve; if
// those stale notices kept counting, revive-time "signals clean" could never pass and every
// 2-day bench would auto-extend to 7 then 14 days. Pre-bench notices still feed the suppression
// list (a dead address is dead forever); they just stop counting against the resting domain.
const REST_FILE = process.env.MPC_REST_FILE
  || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_domain_rest_v1.json";
const restSince = new Map(); // domain -> notices-count-from cutoff (ms)
try {
  const ledger = JSON.parse(readFileSync(REST_FILE, "utf8"));
  const nowMs = Date.now();
  for (const [d, v] of Object.entries(ledger.domains || {})) {
    if (!v) continue;
    if (v.state === "resting" && (!v.until || Date.parse(v.until) > nowMs) && v.since) {
      restSince.set(d.toLowerCase(), Date.parse(v.since));
    } else {
      // Cleared domains get the same courtesy: notices from BEFORE their last revival stay off
      // the books (they were served by the bench), or the 7-day window would re-bench a healthy
      // revived domain for its own history the moment it cleared.
      const revived = (v.history || []).filter((h) => h.event === "revived").map((h) => Date.parse(h.at)).filter(Number.isFinite).sort().pop();
      if (revived) restSince.set(d.toLowerCase(), revived);
    }
  }
} catch { /* no ledger: count everything */ }

// WHY each bounce happened, in the receiving server's own words. Persisted so the
// portal can say "21 dead addresses, 2 spam verdicts" instead of a bare count.
const REASON_RULES = [
  // OUR box's auth failing at its own server (O365 "not authorized to relay", SendAs
  // permission missing). The message never left the building: the recipient is unproven
  // and the domain's reputation is untouched, so these count NEITHER as bounced addresses
  // NOR toward domain-rest benching (the 8/18 false benches were exactly this class,
  // Mailbox-API failures booked as bounces). They surface in perBoxInfra instead, so a
  // box that cannot send gets fixed rather than quietly burning its domain's bench math.
  ["relay_auth",   /not authorized to relay|sender not authorized|permissions? to send as|sendas denied/i],
  ["blocklist",    /spamhaus|blocklist|blacklist|black list|listed at|banned sending ip|poor (ip|domain)? ?reputation|5\.7\.606|s3140|barracudacentral|sorbs|spamcop|rbl/i],
  ["spam_verdict", /suspect(ed)? ?(of being |as )?spam|considered spam|classified as spam|detected as spam|message looks like spam|spamcause|s3150|high probability of spam|content filter|5\.7\.1.*(spam|content)|bulk (mail|email)/i],
  ["auth_fail",    /dmarc|spf (check )?fail|dkim|not authenticated|authentication (failed|required)|5\.7\.2[0-9]/i],
  ["dead_address", /5\.1\.[01]|user unknown|recipient(?:'s)? (address )?(not found|rejected|invalid)|no such user|does ?n[o']?t exist|couldn'?t be found|recipientnotfound|unknown recipient|invalid recipient|no mailbox|address unknown|550 #5\.1\.0|wasn'?t found at|recipient unknown/i],
  ["mailbox_full", /mailbox (is )?full|over ?quota|5\.2\.2/i],
  ["gateway_hold", /proofpoint|mimecast|pphosted|messagelabs|moderation|held for review|quarantin/i],
  ["send_limit",   /5\.4\.316|sending limit|too many (messages|recipients)|rate limit|4\.7\.850|outbound spam/i],
];
function reasonOf(text) {
  for (const [k, re] of REASON_RULES) if (re.test(text)) return k;
  return "other";
}

// PROVIDER-BLOCK RADAR (see ndr-sweep-imap.mjs for the twin on the internal/Gmail lanes).
// Receiver-side "your server is not welcome" signatures, scanned across EVERY notice
// INCLUDING warm-up traffic: a burned server shows there first, and the 2026-08 Gmail
// block sat invisible for weeks because campaign-only counters never saw the warm-up
// rejections. Detection here; policy in the consumers (app rotation + batch.mjs).
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
// Receivers name OUR sending IP in the rejection, and often the public blocklist they
// consulted (mirrors ndr-sweep-imap.mjs). Narrow patterns only: a bare "[1.2.3.4]" is
// usually the RECEIVER's own host, so only client-side phrasings count.
const OUR_IP_PATTERNS = [
  /client host \[?((?:\d{1,3}\.){3}\d{1,3})\]?/i,
  /reputation of ((?:\d{1,3}\.){3}\d{1,3})/i,
  /sending ip \[?((?:\d{1,3}\.){3}\d{1,3})\]?/i,
  /\[((?:\d{1,3}\.){3}\d{1,3})(?:\s+\d+)?\]\s*(?:gmail|our system|this)/i,
  /ip \[?((?:\d{1,3}\.){3}\d{1,3})\]?\s*(?:is |was )?(?:listed|blocked|banned)/i,
];
const BLOCKLIST_RE = /\b(spamhaus|barracuda|spamcop|sorbs|psbl|uceprotect|invaluement|senderscore)\b/i;
function ourIpIn(text) { for (const re of OUR_IP_PATTERNS) { const m = text.match(re); if (m) return m[1]; } return null; }
const providerBlocks = {};
function noteBlock(fleet, text, at) {
  if (!BLOCK_RE.test(text)) return;
  // Classify the receiver from the window around the block signature (quoted headers
  // can mention every provider; the rejection line names the one that matters).
  const hit = text.search(BLOCK_RE);
  const windowText = text.slice(Math.max(0, hit - 300), hit + 300);
  const rcv = receiverOf(windowText) || receiverOf(text);
  if (!rcv) return;
  const key = `${fleet}|${rcv}`;
  const b = providerBlocks[key] || (providerBlocks[key] = { fleet, provider: rcv, count: 0, lastSeen: null, sample: null, blockedIp: null, blocklist: null });
  b.count++;
  const seen = at || new Date().toISOString();
  if (!b.lastSeen || seen > b.lastSeen) b.lastSeen = seen;
  // Sample CENTERED on the rejection so the ledger's evidence is readable.
  if (!b.sample) b.sample = text.slice(Math.max(0, hit - 90), hit + 190);
  if (!b.blockedIp) b.blockedIp = ourIpIn(windowText);
  if (!b.blocklist) { const m = windowText.match(BLOCKLIST_RE); if (m) b.blocklist = m[1].toLowerCase(); }
}

const bounced = new Set();
const perDomain = {};
const perBox = {};
const perBoxInfra = {};
const byReason = {};
const reasonExamples = {};
const warmupPerBox = {};
// The send fuse's inputs: every campaign bounce in the window as a timestamped notice (fleet
// 24h ratio), and bounce counts per address rung (per-source breakers). relay_auth never lands
// here (no mail left the building).
const notices = [];
const perSource = {};
for (const [src, n] of Object.entries(sentBySource)) perSource[src] = { sent: n, bounces: 0 };
let warmupNdrs = 0, staleSkipped = 0, infraNdrs = 0;
for (const n of ndrs) {
  const rcpt = String(n.rcpt || "").toLowerCase();
  const subjLower = n.subj.replace(/^undeliverable:\s*/i, "");
  const looksCampaign = subjLower === subjLower.toLowerCase() && /[a-z]/.test(subjLower);
  const isCampaign = (rcpt && sentTo.has(rcpt)) || looksCampaign;
  noteBlock("sendingac", n.subj + " :: " + (n.preview || ""), n.at);
  if (!isCampaign) { warmupNdrs++; warmupPerBox[n.box] = (warmupPerBox[n.box] || 0) + 1; continue; }
  const d = n.box.split("@")[1];
  const benchStart = restSince.get(d);
  if (benchStart && Date.parse(n.at || 0) < benchStart) { staleSkipped++; continue; }
  const reason = reasonOf(n.subj + " :: " + (n.preview || ""));
  byReason[reason] = (byReason[reason] || 0) + 1;
  const ex = reasonExamples[reason] || (reasonExamples[reason] = []);
  if (ex.length < 3) ex.push({ box: n.box, rcpt: rcpt || null, text: (n.preview || n.subj).slice(0, 220), at: n.at });
  if (reason === "relay_auth") {
    // See REASON_RULES: no send happened, so no dead address and no reputation hit.
    infraNdrs++;
    perBoxInfra[n.box] = (perBoxInfra[n.box] || 0) + 1;
    continue;
  }
  if (rcpt && sentTo.has(rcpt)) bounced.add(rcpt);
  perDomain[d] = perDomain[d] || { bounces: 0, sent: sentByDomain.get(d) || 0 };
  perDomain[d].bounces++;
  perBox[n.box] = (perBox[n.box] || 0) + 1; // per-mailbox counts for the daily fleet verifier
  const meta = rcpt ? sentMeta.get(rcpt) : null;
  notices.push({ at: n.at, rcpt: rcpt || null, box: n.box, domain: d, reason, source: meta ? meta.source : null, tier: meta ? meta.tier : null });
  if (meta) { const ps = perSource[meta.source] || (perSource[meta.source] = { sent: 0, bounces: 0 }); ps.bounces++; }
}
if (staleSkipped) console.log(`freshness rule: ${staleSkipped} pre-bench notices excluded from resting domains' counts`);
if (infraNdrs) console.log(`relay-auth rule: ${infraNdrs} our-box auth failures kept OFF the reputation books (boxes: ${Object.keys(perBoxInfra).join(", ")})`);

// Merge: bounced[] never shrinks (a narrower sweep must not forget old bounces).
if (existsSync(SIDECAR)) {
  try {
    const prev = JSON.parse(readFileSync(SIDECAR, "utf8"));
    for (const e of prev.bounced || []) bounced.add(e);
  } catch {}
}

// OWN-SMTP lane: fold in the IMAP sweep's sidecar (ndr-sweep-imap.mjs reads the
// Mailcow boxes this API sweep cannot see). One combined ledger means the
// deliverability -> domain-rest bench chain protects both lanes identically.
// Stale (>24h) IMAP data is skipped rather than double-counted forever.
const IMAP_SIDECAR = process.env.MPC_NDR_IMAP_FILE
  || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_ndr_imap_v1.json";
try {
  if (existsSync(IMAP_SIDECAR)) {
    const im = JSON.parse(readFileSync(IMAP_SIDECAR, "utf8"));
    const fresh = im.generatedAt && Date.now() - Date.parse(im.generatedAt) < 24 * 3600_000;
    if (fresh) {
      for (const e of im.bounced || []) bounced.add(e);
      for (const [d, v] of Object.entries(im.perDomain || {})) {
        perDomain[d] = perDomain[d] || { bounces: 0, sent: sentByDomain.get(d) || v.sent || 0 };
        perDomain[d].bounces += v.bounces || 0;
      }
      for (const [b, n] of Object.entries(im.perBox || {})) perBox[b] = (perBox[b] || 0) + n;
      for (const [b, n] of Object.entries(im.perBoxInfra || {})) perBoxInfra[b] = (perBoxInfra[b] || 0) + n;
      for (const [b, n] of Object.entries(im.warmupPerBox || {})) warmupPerBox[b] = (warmupPerBox[b] || 0) + n;
      for (const nt of im.notices || []) notices.push(nt);
      for (const [src, v] of Object.entries(im.perSource || {})) {
        const ps = perSource[src] || (perSource[src] = { sent: sentBySource[src] || 0, bounces: 0 });
        ps.bounces += (v && v.bounces) || 0;
      }
      for (const [key, b] of Object.entries(im.providerBlocks || {})) {
        const dst = providerBlocks[key];
        if (!dst) { providerBlocks[key] = b; continue; }
        dst.count += b.count || 0;
        if (b.lastSeen && (!dst.lastSeen || b.lastSeen > dst.lastSeen)) dst.lastSeen = b.lastSeen;
        if (!dst.sample) dst.sample = b.sample;
        if (!dst.blockedIp) dst.blockedIp = b.blockedIp || null;
        if (!dst.blocklist) dst.blocklist = b.blocklist || null;
      }
      infraNdrs += im.infraNdrs || 0;
      for (const [k, n] of Object.entries(im.byReason || {})) byReason[k] = (byReason[k] || 0) + n;
      for (const [k, ex] of Object.entries(im.reasonExamples || {})) {
        const dst = reasonExamples[k] || (reasonExamples[k] = []);
        for (const e of ex) if (dst.length < 3) dst.push(e);
      }
      console.log(`merged imap sidecar: +${Object.keys(im.perDomain || {}).length} own-smtp domains, ${im.boxesSwept || 0} boxes swept over IMAP`);
    } else {
      console.log("imap sidecar present but stale (>24h): skipped");
    }
  }
} catch (e) { console.log(`imap sidecar merge skipped: ${e.message}`); }
const out = {
  generatedAt: new Date().toISOString(),
  source: "mailbox-api-ndr-sweep",
  boxesSwept: swept,
  warmupNdrs,
  warmupPerBox,    // per-box warm-up bounce counts (both lanes): the graduation gate reads this
  bounced: [...bounced].sort(),
  perDomain,
  perBox,
  infraNdrs,       // our-box auth failures (relay_auth): sends that never left, off the reputation books
  perBoxInfra,     // which boxes cannot send (SendAs/relay auth broken) — fix these, don't bench their domains
  byReason,        // this sweep's window: bounce counts by the receiver's stated reason
  reasonExamples,  // up to 3 real notice texts per reason, for the portal's details view
  notices: notices.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-5000), // send fuse: timestamped campaign bounces (7d window)
  perSource,       // send fuse: per address-rung sends (14d) + bounces (7d) -> source breakers
};
const tmp = SIDECAR + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, SIDECAR);
console.log(`sidecar: ${out.bounced.length} bounced recipients, ${Object.keys(perDomain).length} domains with bounces`);

// PROVIDER-BLOCK LEDGER: the one file every router reads to keep a rejecting receiver
// away from the fleet it is rejecting (app sender rotation via recipientGuard, MPC lane
// via batch.mjs). Merge rule: a pair seen this window replaces its own numbers but keeps
// firstSeen; a pair NOT seen keeps its record untouched so consumers age it out by
// lastSeen (freshness + count thresholds are THEIRS, not this file's); pairs silent for
// 30 days drop off the file. Nothing here blocks traffic by itself: detection is data,
// policy lives in the consumers, and a healed provider releases automatically.
const BLOCKS_FILE = process.env.MPC_BLOCKS_FILE
  || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_provider_blocks_v1.json";
try {
  let prev = {};
  try { prev = JSON.parse(readFileSync(BLOCKS_FILE, "utf8")).blocks || {}; } catch { /* first run */ }
  const mergedBlocks = { ...prev };
  for (const [key, b] of Object.entries(providerBlocks)) {
    mergedBlocks[key] = { ...b, firstSeen: prev[key]?.firstSeen || b.lastSeen || new Date().toISOString() };
  }
  for (const [key, b] of Object.entries(mergedBlocks)) {
    if (b.lastSeen && Date.now() - Date.parse(b.lastSeen) > 30 * 86_400_000) delete mergedBlocks[key];
  }
  const ledgerOut = { generatedAt: new Date().toISOString(), source: "ndr-sweep provider-block radar", blocks: mergedBlocks };
  const ltmp = BLOCKS_FILE + ".tmp";
  writeFileSync(ltmp, JSON.stringify(ledgerOut, null, 1));
  renameSync(ltmp, BLOCKS_FILE);
  const active = Object.values(mergedBlocks).filter((b) => b.lastSeen && Date.now() - Date.parse(b.lastSeen) < 7 * 86_400_000);
  console.log(`provider-block ledger: ${Object.keys(mergedBlocks).length} pair(s) on file, ${active.length} fresh: ${active.map((b) => `${b.fleet}x${b.provider}(${b.count})`).join(", ") || "none"}`);
} catch (e) { console.log(`provider-block ledger write skipped: ${e.message}`); }
