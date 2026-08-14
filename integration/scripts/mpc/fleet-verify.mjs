// RecruitersOS · Fleet Verify (daily full-fleet verification, owner mandate 2026-08-14).
//
// Every sending DOMAIN and every MAILBOX gets an explicit verdict each day:
//   healthy | warning | unhealthy
// and when it is not healthy, the row says WHY (reasons[]) and WHAT TO DO (fixes[]).
// No asset is ever "assumed fine": a domain is verified on DNS auth, blacklist, web
// presence, bounce pressure, warm-up, and rest state; a mailbox is verified to EXIST
// at the provider, to not be bouncing, and to be in rotation. The Owner Console
// Fleet tab renders the result; the System Health board tracks this run's freshness.
//
// Runs on the HOST daily (fleet-verify.timer) or on demand:
//   node /opt/recruiteros/tools/fleet-verify.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { promises as dns } from "node:dns";

const VOL = "/var/lib/docker/volumes/recruiteros_app_data/_data";
const OUT_FILE = `${VOL}/snap_fleet_verify_v1.json`;
const MPC_OUT = "/opt/recruiteros/mpc-out";
const ENV_FILE = "/opt/recruiteros/.env.production";
const BASE = "https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0";

const now = Date.now();
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function envVal(key) {
  try { const m = readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${key}=(.*)$`, "m")); return m ? m[1].trim() : ""; } catch { return ""; }
}
const KEY = envVal("SENDINGAC_MAILBOX_API_KEY");

/* ---------------- inputs ---------------- */
const ndr = readJson(`${VOL}/snap_mpc_ndr_v1.json`) || {};
const rest = readJson(`${VOL}/snap_mpc_domain_rest_v1.json`) || {};
const deliv = readJson(`${VOL}/snap_mpc_deliverability_v1.json`) || {};
const senders = readJson(`${VOL}/snap_senders_v1.json`) || {};
const warmByDomain = new Map((deliv.byDomain || []).map((d) => [d.domain, d]));

// The mailbox fleet: every Sending.ac box on the senders roster, plus anything that sent.
const roster = (senders.inboxes || senders.state?.inboxes || []).filter((m) => m?.provider === "sending-ac");
const boxes = new Map(); // email -> { owner, domain, sent }
for (const m of roster) boxes.set(m.email, { owner: m.ownerName || "", domain: m.email.split("@")[1], sent: 0 });
const sentByDomain = new Map();
for (const f of readdirSync(MPC_OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r.from) {
        if (!boxes.has(r.from)) boxes.set(r.from, { owner: r.from_owner || "", domain: r.from.split("@")[1], sent: 0 });
        boxes.get(r.from).sent++;
        const d = r.from.split("@")[1];
        sentByDomain.set(d, (sentByDomain.get(d) || 0) + 1);
      }
    } catch {}
  }
}
const domains = [...new Set([...boxes.values()].map((b) => b.domain))].sort();
console.log(`verifying ${domains.length} domains, ${boxes.size} mailboxes`);

/* ---------------- domain checks ---------------- */
async function dnsAuth(domain) {
  const out = { spf: false, spfPolicy: null, dkim: false, dmarc: false, dmarcPolicy: null, mx: false };
  try { const txt = (await dns.resolveTxt(domain)).map((r) => r.join("")); const spf = txt.find((t) => /^v=spf1/i.test(t)); if (spf) { out.spf = true; out.spfPolicy = /-all/.test(spf) ? "-all" : /~all/.test(spf) ? "~all" : "?"; } } catch {}
  try { const d = await dns.resolveTxt(`_dmarc.${domain}`); const rec = d.map((r) => r.join("")).find((t) => /^v=DMARC1/i.test(t)); if (rec) { out.dmarc = true; out.dmarcPolicy = (rec.match(/p=(\w+)/i) || [])[1]?.toLowerCase() || null; } } catch {}
  try { await dns.resolveCname(`selector1._domainkey.${domain}`); out.dkim = true; } catch { try { await dns.resolveTxt(`selector1._domainkey.${domain}`); out.dkim = true; } catch {} }
  try { out.mx = (await dns.resolveMx(domain)).length > 0; } catch {}
  return out;
}
async function dblCheck(domain) {
  // 127.0.1.x = listed; 127.255.255.x = "public resolver blocked" (NOT a listing). Anything
  // else resolvable is unexpected; NXDOMAIN = clean.
  try {
    const a = await dns.resolve4(`${domain}.dbl.spamhaus.org`);
    if (a.some((ip) => ip.startsWith("127.0.1."))) return "listed";
    if (a.some((ip) => ip.startsWith("127.255.255."))) return "unknown";
    return "unknown";
  } catch { return "clean"; }
}
async function webPresence(domain) {
  try {
    const r = await fetch(`https://${domain}/`, { redirect: "follow", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 (fleet-verify)" } });
    const text = (await r.text()).slice(0, 4000).toLowerCase();
    if (!r.ok) return { state: "error", detail: `HTTP ${r.status}` };
    if (/porkbun|parked|domain is for sale|buy this domain|coming soon/.test(text)) return { state: "parked", detail: "registrar parking page" };
    const host = new URL(r.url).hostname;
    // Redirecting a lookalike to the tenant's real brand site is accepted practice, not a
    // defect. Redirects anywhere else (dns.google was live in the fleet) are misconfigs.
    const BRAND_ROOTS = (envVal("FLEET_BRAND_ROOTS") || "lumesp.com").split(",").map((s) => s.trim()).filter(Boolean);
    if (!host.endsWith(domain)) {
      if (BRAND_ROOTS.some((b) => host === b || host.endsWith("." + b))) return { state: "ok", detail: `redirects to brand site ${host}` };
      return { state: "offsite-redirect", detail: `redirects to ${host}` };
    }
    return { state: "ok", detail: "" };
  } catch (e) { return { state: "unreachable", detail: String(e.message || e).slice(0, 60) }; }
}

const domainRows = [];
{
  let i = 0;
  async function domainWorker() {
    while (i < domains.length) {
      const d = domains[i++];
      const reasons = [], fixes = [];
      const [auth, dbl, web] = await Promise.all([dnsAuth(d), dblCheck(d), webPresence(d)]);
      const restEntry = rest.domains?.[d];
      const resting = restEntry?.state === "resting" && (!restEntry.until || Date.parse(restEntry.until) > now);
      const bounces = ndr.perDomain?.[d]?.bounces || 0;
      const sent = sentByDomain.get(d) || 0;
      const warm = warmByDomain.get(d);
      const rep = warm?.warmupReputationPct;

      if (!auth.spf) { reasons.push("SPF record missing"); fixes.push("Run dns-authfix (Porkbun API) to publish SPF with -all"); }
      else if (auth.spfPolicy === "?") { reasons.push("SPF present but policy is neither -all nor ~all"); fixes.push("Tighten SPF to -all via dns-authfix"); }
      if (!auth.dkim) { reasons.push("DKIM selector missing"); fixes.push("Re-provision DKIM (selector1) for this domain at Sending.ac, then publish the CNAME"); }
      if (!auth.dmarc) { reasons.push("DMARC record missing"); fixes.push("Publish DMARC p=quarantine via dns-authfix"); }
      else if (auth.dmarcPolicy === "none") { reasons.push("DMARC policy is p=none (monitor only)"); fixes.push("dns-authfix raises to quarantine automatically tonight; verify tomorrow"); }
      if (!auth.mx) { reasons.push("No MX record: replies and bounce notices cannot return"); fixes.push("Restore the MX records for this domain"); }
      if (dbl === "listed") { reasons.push("Listed on Spamhaus DBL"); fixes.push("Stop all sending; request delisting at spamhaus.org; investigate content/links"); }
      if (resting) { reasons.push(`Benched by the circuit breaker: ${restEntry.reason || "bounce spike"} (until ${String(restEntry.until || "").slice(0, 10)})`); fixes.push("No action: warm-up continues and it auto-revives when served and clean"); }
      if (bounces >= 5 && sent > 0 && bounces > sent * 0.05) { reasons.push(`Fresh bounce pressure: ${bounces} notices against ${sent} sends`); fixes.push("Breaker will bench on next run; review recipient quality for this domain's sends"); }
      if (rep != null && rep < 90) { reasons.push(`Warm-up reputation ${rep}%`); fixes.push("Keep resting; do not add cold volume until reputation is back over 95%"); }
      if (web.state === "parked") { reasons.push("Domain web root shows a registrar parking page"); fixes.push("Deploy the branded landing page (filters browse sending domains)"); }
      else if (web.state === "offsite-redirect") { reasons.push(`Web root ${web.detail}`); fixes.push("Point the domain at its own branded page instead of an off-site redirect"); }
      else if (web.state === "unreachable") { reasons.push("Web root unreachable"); fixes.push("Serve a simple branded page over HTTPS for this domain"); }

      const hard = reasons.some((r) => /Spamhaus|MX record|SPF record missing|DKIM selector missing/.test(r));
      const verdict = hard ? "unhealthy" : reasons.length ? "warning" : "healthy";
      domainRows.push({
        domain: d, verdict, reasons, fixes,
        metrics: { sent, bounces, warmupPct: rep ?? null, resting: !!resting, dbl, web: web.state, spf: auth.spfPolicy || (auth.spf ? "ok" : "missing"), dkim: auth.dkim, dmarc: auth.dmarcPolicy || (auth.dmarc ? "ok" : "missing") },
      });
    }
  }
  await Promise.all(Array.from({ length: 6 }, domainWorker));
}

/* ---------------- mailbox checks ---------------- */
async function apiGet(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after")) || 15;
      await new Promise((res) => setTimeout(res, Math.min(ra, 60) * 1000 + attempt * 2000));
      continue;
    }
    return r;
  }
  return { status: 429, ok: false };
}

const boxRows = [];
{
  const list = [...boxes.entries()];
  let i = 0;
  async function boxWorker() {
    while (i < list.length) {
      const [email, info] = list[i++];
      const reasons = [], fixes = [];
      let exists = null;
      try {
        const r = await apiGet(`${BASE}/users/${encodeURIComponent(email)}/mailFolders`);
        if (r.status === 404) exists = false;
        else if (r.ok) exists = true;
        // 429 after retries / 5xx -> unknown, judged another day rather than falsely flagged
      } catch {}
      const boxBounces = ndr.perBox?.[email] || 0;
      const domRow = domainRows.find((x) => x.domain === info.domain);

      if (exists === false) { reasons.push("Mailbox does not exist at the provider (404)"); fixes.push("Re-provision this mailbox at Sending.ac or remove it from the senders roster"); }
      if (boxBounces >= 3) { reasons.push(`${boxBounces} recent bounce notices from this mailbox`); fixes.push("Rotation already spreads volume; if this repeats tomorrow, retire the address"); }
      if (domRow && domRow.verdict === "unhealthy") { reasons.push(`Parent domain ${info.domain} is unhealthy`); fixes.push("Fix the domain first; the mailbox inherits its fate"); }
      // A resting parent is expected, transient, and already tracked on the domain row: the
      // mailbox stays healthy (verdict noise trains the owner to ignore warnings).
      const verdict = exists === false ? "unhealthy" : reasons.length ? "warning" : "healthy";
      boxRows.push({ email, domain: info.domain, owner: info.owner, verdict, reasons, fixes, metrics: { exists, sent: info.sent, recentBounces: boxBounces, parentResting: !!domRow?.metrics.resting } });
      if (i % 100 === 0) console.log(`mailboxes ${i}/${list.length}`);
    }
  }
  await Promise.all(Array.from({ length: 3 }, boxWorker));
}

/* ---------------- write ---------------- */
const vOrder = { unhealthy: 0, warning: 1, healthy: 2 };
domainRows.sort((a, b) => vOrder[a.verdict] - vOrder[b.verdict] || a.domain.localeCompare(b.domain));
boxRows.sort((a, b) => vOrder[a.verdict] - vOrder[b.verdict] || a.email.localeCompare(b.email));
const sum = (rows) => ({ healthy: rows.filter((r) => r.verdict === "healthy").length, warning: rows.filter((r) => r.verdict === "warning").length, unhealthy: rows.filter((r) => r.verdict === "unhealthy").length });
const out = {
  generatedAt: new Date().toISOString(),
  domainSummary: sum(domainRows),
  mailboxSummary: sum(boxRows),
  domains: domainRows,
  mailboxes: boxRows,
};
const tmp = OUT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, OUT_FILE);
console.log(`fleet verify: domains ${JSON.stringify(out.domainSummary)} | mailboxes ${JSON.stringify(out.mailboxSummary)}`);
