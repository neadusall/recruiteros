// RecruitersOS · MPC · Deliverability tracker (the "are they actually landing?" layer).
//
// Documents REAL, per-domain deliverability numbers over time so we never guess. Reads the actual
// send results (accepted vs hard-failed), the inbox (bounce/complaint DSNs), and Smartlead's live
// per-domain warm-up reputation (a real inbox-placement signal measured against the warm-up seed
// network). Appends a daily rollup to a rolling 30-day history and writes a snapshot the cockpit
// reads. No assumptions, just numbers.
//
//   SMARTLEAD_API_KEY=... node scripts/mpc/mpc-deliverability.mjs
//
// Honest scope: acceptance + hard-fail + bounce + complaint + warm-up reputation are all directly
// measured. TRUE inbox-vs-spam placement for real prospects (whose mailboxes we can't see) is
// approximated by Smartlead warm-up reputation; a dedicated seed-inbox test can be layered in later
// via the `placement.seedTest` slot (left null until seeds exist).

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { promises as dns } from "node:dns";

const OUT_DIR = process.env.MPC_OUT_DIR || "/out";
const INBOX_FILE = process.env.MPC_INBOX_FILE || "/data/snap_inbox.json";
const STATS_FILE = process.env.MPC_STATS_FILE || "/data/snap_mpc_stats_v1.json";
const OUT_FILE = process.env.MPC_DELIVERABILITY_FILE || "/data/snap_mpc_deliverability_v1.json";

function domainOf(email) {
  const m = String(email || "").split("@")[1];
  return m ? m.toLowerCase().trim() : "";
}

// 1) Send results from the real logs, bucketed per SENDING domain AND per SENDING BOX.
//
// The per-box tally exists because nothing else could produce one. This sender is a host
// script; it never calls back into the app, so every Email ID in the registry carried
// sent=0 forever while the bounce sweep happily wrote bounced=N onto the same row. That
// is not a cosmetic gap: a per-mailbox bounce RATE is uncomputable without a denominator,
// so the health guard's bounce rule could never fire on this lane, and the board rendered
// a blank that reads like a clean bill. The send log has always known which box sent what;
// it just was not being counted. Now it is, and the app reconciles the registry from it.
function sendFacts() {
  const byDomain = new Map(); // domain -> { sent, accepted, failed }
  const byBox = new Map();    // from address -> { sent, accepted, failed, lastAt, sentToday }
  let total = 0, accepted = 0, failed = 0, infra = 0, firstAt = null, lastAt = null;
  const today = new Date().toISOString().slice(0, 10);
  let sentToday = 0, acceptedToday = 0;
  if (existsSync(OUT_DIR)) {
    for (const f of readdirSync(OUT_DIR).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
      for (const line of readFileSync(`${OUT_DIR}/${f}`, "utf8").split("\n")) {
        const s = line.trim(); if (!s) continue;
        let r; try { r = JSON.parse(s); } catch { continue; }
        if (!r || !r.to_email) continue;
        const d = domainOf(r.from);
        const ok = !!(r.result && r.result.ok);
        // Mailbox-API-side failures (404 "No such mailbox", 429 burst limiting): no mail ever
        // reached a receiving server, so these are infrastructure events, NOT deliverability
        // signals. Counting them as hard-fails is what benched 14 healthy domains on 8/15
        // (ariel@ follow-ups replayed against Sending.ac, where her boxes don't exist).
        if (!ok && /^(404|429):/.test(String((r.result && r.result.error) || ""))) { infra++; continue; }
        total++; if (ok) accepted++; else failed++;
        const at = r.at || "";
        if (at) { if (!firstAt || at < firstAt) firstAt = at; if (!lastAt || at > lastAt) lastAt = at; }
        if (at.slice(0, 10) === today) { sentToday++; if (ok) acceptedToday++; }
        if (d) { const e = byDomain.get(d) || { sent: 0, accepted: 0, failed: 0 }; e.sent++; ok ? e.accepted++ : e.failed++; byDomain.set(d, e); }
        const box = String(r.from || "").toLowerCase().trim();
        if (box) {
          const b = byBox.get(box) || { sent: 0, accepted: 0, failed: 0, lastAt: null, sentToday: 0 };
          b.sent++; ok ? b.accepted++ : b.failed++;
          if (at && (!b.lastAt || at > b.lastAt)) b.lastAt = at;
          if (at.slice(0, 10) === today) b.sentToday++;
          byBox.set(box, b);
        }
      }
    }
  }
  return { total, accepted, failed, infra, firstAt, lastAt, sentToday, acceptedToday, byDomain, byBox };
}

// 2) Bounce + complaint DSNs from our own inboxes (real post-send failures the receiver reported).
function inboxSignals() {
  let bounces = 0, complaints = 0;
  const perDomain = new Map(); // sending domain referenced in the DSN -> bounce count (best-effort)
  try {
    const ib = JSON.parse(readFileSync(INBOX_FILE, "utf8"));
    for (const x of (ib.items || [])) {
      const node = x.inbound || x;
      const text = ((node.text || "") + " " + (node.subject || "")).toLowerCase();
      if (/delivery.*(failed|status notification)|undeliverable|mailbox.*full|does not exist|user unknown|\b(550|554|5\.1\.1)\b|address rejected/.test(text)) {
        bounces++;
        // best-effort: attribute to whichever sending domain is named in the DSN body
        for (const m of text.matchAll(/lume[a-z]*\.com/g)) { const d = m[0]; perDomain.set(d, (perDomain.get(d) || 0) + 1); }
      }
      if (/spam|abuse|complaint|feedback loop|unsubscribe me|stop emailing/.test(text)) complaints++;
    }
  } catch { /* no inbox yet */ }
  // Fleet NDR sweep sidecar (2026-08-12): real bounce counts read from ALL sending mailboxes
  // via the Mailbox API. The inbox snapshot above only sees recruiter reply boxes, which is how
  // a 15% bounce rate showed as "1 bounce". Sidecar counts are per SENDING domain already.
  try {
    const n = JSON.parse(readFileSync(process.env.MPC_NDR_FILE || "/data/snap_mpc_ndr_v1.json", "utf8"));
    for (const [d, v] of Object.entries(n.perDomain || {})) {
      perDomain.set(d, Math.max(perDomain.get(d) || 0, (v && v.bounces) || 0));
    }
    bounces = Math.max(bounces, (n.bounced || []).length);
  } catch { /* no sweep yet */ }
  return { bounces, complaints, perDomain };
}

// 3) Smartlead per-domain warm-up reputation — a REAL inbox-placement signal (measured by landing
//    warm-up mail in the seed network's inbox vs spam). Grouped by the SENDING domain.
async function warmupByDomain() {
  const key = process.env.SMARTLEAD_API_KEY;
  const byDomain = new Map(); // domain -> { boxes, reps:[], active }
  if (!key) return { byDomain, available: false };
  try {
    for (let off = 0; off < 3000; off += 100) {
      const r = await fetch(`https://server.smartlead.ai/api/v1/email-accounts/?api_key=${key}&offset=${off}&limit=100`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) break; const d = await r.json(); if (!Array.isArray(d) || !d.length) break;
      for (const a of d) {
        const dm = domainOf(a.from_email || a.username || ""); if (!dm) continue;
        const w = a.warmup_details || {};
        const rep = parseFloat(String(w.warmup_reputation || a.warmup_reputation || "").replace("%", ""));
        const e = byDomain.get(dm) || { boxes: 0, reps: [], active: 0 };
        e.boxes++;
        if (Number.isFinite(rep)) e.reps.push(rep);
        if (/active|warming|running/i.test(w.status || a.warmup_status || a.status || "")) e.active++;
        byDomain.set(dm, e);
      }
      if (d.length < 100) break;
    }
    return { byDomain, available: true };
  } catch { return { byDomain, available: false }; }
}

// 4) REAL authentication audit per sending domain (DNS): SPF, DKIM, DMARC, MX. This is the #1
//    determinant of inbox placement, and unlike warm-up reputation it is a hard, verifiable fact.
//    Not a proxy: a domain that publishes SPF -all + DKIM + DMARC enforcing IS authenticated.
async function authForDomain(domain) {
  const out = { spf: false, spfPolicy: null, dkim: false, dmarc: false, dmarcPolicy: null, mx: false };
  try { const txt = (await dns.resolveTxt(domain)).map((r) => r.join("")); const spf = txt.find((t) => /^v=spf1/i.test(t)); if (spf) { out.spf = true; out.spfPolicy = /-all/.test(spf) ? "-all" : /~all/.test(spf) ? "~all" : "?"; } } catch { /* none */ }
  try { const d = await dns.resolveTxt(`_dmarc.${domain}`); const rec = d.map((r) => r.join("")).find((t) => /^v=DMARC1/i.test(t)); if (rec) { out.dmarc = true; const p = rec.match(/p=(\w+)/i); out.dmarcPolicy = p ? p[1].toLowerCase() : null; } } catch { /* none */ }
  // Selector varies by mail host: Microsoft 365 publishes selector1/selector2 (CNAME),
  // Google Workspace publishes google (TXT), mailcow defaults to dkim. Probing only one
  // selector false-flags every domain on a different host as "DKIM missing".
  const DKIM_SELECTORS = ["selector1", "selector2", "google", "dkim", "default", "s1", "s2", "k1"];
  for (const sel of DKIM_SELECTORS) {
    try { await dns.resolveCname(`${sel}._domainkey.${domain}`); out.dkim = true; break; } catch { /* try TXT */ }
    try { const t = (await dns.resolveTxt(`${sel}._domainkey.${domain}`)).map((r) => r.join("")); if (t.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) { out.dkim = true; break; } } catch { /* next selector */ }
  }
  try { const mx = await dns.resolveMx(domain); out.mx = mx.length > 0; } catch { /* none */ }
  out.fullyAuthed = out.spf && out.dkim && out.dmarc && out.mx && out.dmarcPolicy !== "none";
  return out;
}
async function authByDomain(domains) {
  const map = new Map();
  await Promise.all(domains.map(async (d) => { map.set(d, await authForDomain(d)); }));
  return map;
}

function avg(a) { return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null; }
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }

async function main() {
  const send = sendFacts();
  const inbox = inboxSignals();
  const warm = await warmupByDomain();
  // Authenticate only the domains that actually send (keeps DNS lookups bounded).
  // Per-box bounce counts from the fleet NDR sweep (campaign bounces only; warm-up NDRs
  // are tracked separately and must never be charged against a mailbox's cold rate).
  const ndrPerBox = new Map();
  try {
    const n = JSON.parse(readFileSync(process.env.MPC_NDR_FILE || "/data/snap_mpc_ndr_v1.json", "utf8"));
    for (const [box, v] of Object.entries(n.perBox || {})) {
      ndrPerBox.set(String(box).toLowerCase(), typeof v === "number" ? v : ((v && v.bounces) || 0));
    }
  } catch { /* no sweep yet: sends still publish, bounces read 0 */ }

  const auth = await authByDomain([...send.byDomain.keys()]);

  let replyRate = null, repliesTotal = null;
  try { const st = JSON.parse(readFileSync(STATS_FILE, "utf8")); replyRate = st.replyRate ?? null; repliesTotal = st.repliesTotal ?? null; } catch { /* none */ }

  // Per-domain roll-up with an honest verdict.
  const domains = new Set([...send.byDomain.keys(), ...warm.byDomain.keys()]);
  const byDomain = [...domains].map((d) => {
    const s = send.byDomain.get(d) || { sent: 0, accepted: 0, failed: 0 };
    const w = warm.byDomain.get(d) || { boxes: 0, reps: [], active: 0 };
    const rep = avg(w.reps);
    const failRate = pct(s.failed, s.sent) ?? 0;
    const bounces = inbox.perDomain.get(d) || 0;
    let verdict = "healthy";
    if (w.boxes === 0) verdict = "NOT WARMED";
    else if (rep != null && rep < 90) verdict = "warm-up low";
    else if (failRate > 2) verdict = "failures high";
    else if (bounces > s.sent * 0.02) verdict = "bounces high";
    const a = auth.get(d) || null;
    return {
      domain: d, sent: s.sent, accepted: s.accepted, failed: s.failed,
      acceptanceRatePct: pct(s.accepted, s.sent), hardFailRatePct: failRate,
      bounces, warmedBoxes: w.boxes, warmingActive: w.active, warmupReputationPct: rep, auth: a, verdict,
    };
  }).sort((a, b) => b.sent - a.sent);

  const ageDays = send.firstAt ? Math.round((Date.now() - Date.parse(send.firstAt)) / 86_400_000 * 10) / 10 : null;
  const allReps = byDomain.filter((d) => d.warmupReputationPct != null).map((d) => d.warmupReputationPct);
  const overall = {
    sent: send.total, accepted: send.accepted, failed: send.failed, infraApiErrors: send.infra,
    acceptanceRatePct: pct(send.accepted, send.total), hardFailRatePct: pct(send.failed, send.total) ?? 0,
    bounces: inbox.bounces, complaints: inbox.complaints,
    warmupReputationPct: avg(allReps), domainsWarmed: byDomain.filter((d) => d.warmedBoxes > 0).length, domainsTotal: byDomain.length,
    domainsSending: [...send.byDomain.keys()].length,
    domainsFullyAuthed: byDomain.filter((d) => d.auth && d.auth.fullyAuthed).length,
    replyRatePct: replyRate, repliesTotal, campaignAgeDays: ageDays, sentToday: send.sentToday,
  };

  // Rolling 30-day daily history (upsert today).
  let history = [];
  if (existsSync(OUT_FILE)) { try { history = (JSON.parse(readFileSync(OUT_FILE, "utf8")).history) || []; } catch { /* reset */ } }
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = {
    date: today, sentToday: send.sentToday, acceptedToday: send.acceptedToday,
    acceptanceRatePct: pct(send.acceptedToday, send.sentToday),
    hardFailRatePct: overall.hardFailRatePct, bounces: inbox.bounces, complaints: inbox.complaints,
    warmupReputationPct: overall.warmupReputationPct,
  };
  history = history.filter((h) => h.date !== today);
  history.push(todayRow);
  history = history.slice(-30);

  const out = {
    generatedAt: new Date().toISOString(),
    overall,
    byDomain,
    // Per-mailbox truth: sends from the send log, bounces from the NDR sweep, so a rate
    // is finally computable. The app reconciles its registry counters from this.
    byBox: [...send.byBox.entries()].map(([email, b]) => ({
      email,
      sent: b.sent, accepted: b.accepted, failed: b.failed,
      sentToday: b.sentToday, lastAt: b.lastAt,
      bounces: ndrPerBox.get(email) || 0,
      bounceRatePct: b.sent > 0 ? Math.round(((ndrPerBox.get(email) || 0) / b.sent) * 1000) / 10 : null,
    })).sort((a, b) => b.sent - a.sent),
    history,
    placement: {
      method: "smartlead-warmup-proxy",
      note: "Acceptance, hard-fail, bounce and complaint are directly measured from send logs and our inboxes. Inbox-vs-spam placement for real prospects is approximated by Smartlead warm-up reputation (measured against the warm-up seed network). A dedicated seed-inbox placement test can be added via placement.seedTest.",
      smartleadAvailable: warm.available,
      seedTest: null,
    },
  };
  const tmp = OUT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, OUT_FILE);
  console.log(`mpc-deliverability -> ${overall.sent} sent | acceptance ${overall.acceptanceRatePct}% | hard-fail ${overall.hardFailRatePct}% | bounces ${overall.bounces} | complaints ${overall.complaints} | warm-up ${overall.warmupReputationPct}% | ${overall.domainsWarmed}/${overall.domainsTotal} domains warmed`);
  for (const d of byDomain) console.log(`  ${d.domain.padEnd(26)} sent ${String(d.sent).padStart(4)} | accept ${d.acceptanceRatePct ?? "n/a"}% | fail ${d.hardFailRatePct}% | bounce ${d.bounces} | warm-up ${d.warmupReputationPct ?? "n/a"}% | ${d.verdict}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
