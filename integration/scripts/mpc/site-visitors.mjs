// RecruitersOS · MPC · site-visitor intelligence (who is on lumesp.com).
//
// First-party version of the Leadfeeder/RB2B play, no third party involved:
//   1. Read the Caddy JSON access log for lumesp.com (mounted read-only at /caddylog).
//   2. Keep only real page views (2xx/3xx HTML GETs, bot UAs dropped).
//   3. Resolve each visitor IP: reverse DNS + ASN org (offline ip2asn database,
//      downloaded once from iptoasn.com and cached in /out).
//   4. Match against the outbound send ledger: a visit from a company we emailed
//      names the EXACT people we emailed there (with recruiter + LinkedIn URL from
//      the linkedin-resolve ledger). That is the LinkedIn-connect shortlist.
//   5. Write snap_site_visitors_v1.json for the Dashboard card and append matched
//      people to /out/visitor-leads.jsonl (idempotent) for the connect pipeline.
//
// Honest limits, by design: IP resolution identifies COMPANIES (office/VPN
// egress), never individuals; residential/mobile/hosting IPs are classified and
// set aside instead of guessed at.
//
//   node scripts/mpc/site-visitors.mjs

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, appendFileSync, statSync } from "node:fs";
import { promises as dnsp } from "node:dns";

const LOG_DIR = process.env.VISITOR_LOG_DIR || "/caddylog/logs";
const OUT = process.env.MPC_OUT_DIR || "/out";
const SNAP = process.env.VISITOR_SNAP_FILE || "/data/snap_site_visitors_v1.json";
const CURSOR = `${OUT}/visitors-cursor.json`;
const LEADS = `${OUT}/visitor-leads.jsonl`;
const ASN_TSV = `${OUT}/ip2asn-v4.tsv`;
const ASN_URL = "https://iptoasn.com/data/ip2asn-v4.tsv.gz";
const WS = process.env.MPC_WORKSPACE_ID || "ws_mqf6o989003";
const KEEP_DAYS = Number(process.env.VISITOR_KEEP_DAYS || 30);

// ---------------------------------------------------------------- log intake
// Cursor = byte offset per log file, so each run only parses what is new.
function loadCursor() { try { return JSON.parse(readFileSync(CURSOR, "utf8")); } catch { return {}; } }
function saveCursor(c) { writeFileSync(CURSOR, JSON.stringify(c)); }

const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|httpx|scan|monitor|probe|fetch|preview|facebookexternal|headless/i;
const PAGE = (p) => !/\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|mp4|xml|txt|json)(\?|$)/i.test(p);

function newVisits(cursor) {
  const visits = [];
  if (!existsSync(LOG_DIR)) return visits;
  for (const f of readdirSync(LOG_DIR).filter((n) => /^lumesp-access\.log/.test(n) && !/\.gz$/.test(n))) {
    const file = `${LOG_DIR}/${f}`;
    const size = statSync(file).size;
    let from = cursor[f] || 0;
    if (from > size) from = 0; // rotated: start over on the fresh file
    if (from === size) continue;
    const chunk = readFileSync(file, "utf8").slice(from); // logs roll at 25mb, chunks stay small
    cursor[f] = size;
    for (const line of chunk.split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        const req = r.request || {};
        const ua = ((req.headers || {})["User-Agent"] || [""])[0] || "";
        const ip = String(req.remote_ip || req.client_ip || "").trim();
        const path = String(req.uri || "/").split("?")[0];
        if (!ip || ip.includes(":")) continue;               // v4 only (ASN db is v4)
        if (req.method !== "GET" || r.status >= 400) continue;
        if (BOT_UA.test(ua) || !PAGE(path)) continue;
        visits.push({ ip, path, at: new Date((r.ts || 0) * 1000).toISOString() });
      } catch { /* skip bad line */ }
    }
  }
  return visits;
}

// ---------------------------------------------------------------- IP -> org
// Offline ASN database (free, keyless): ip_start\tip_end\tasn\tcountry\torg.
async function ensureAsnDb() {
  if (existsSync(ASN_TSV) && Date.now() - statSync(ASN_TSV).mtimeMs < 30 * 864e5) return;
  const res = await fetch(ASN_URL);
  if (!res.ok) { if (!existsSync(ASN_TSV)) throw new Error(`asn db download failed: ${res.status}`); return; }
  const gz = Buffer.from(await res.arrayBuffer());
  const { gunzipSync } = await import("node:zlib");
  writeFileSync(ASN_TSV + ".tmp", gunzipSync(gz));
  renameSync(ASN_TSV + ".tmp", ASN_TSV);
}
const ip4 = (s) => s.split(".").reduce((n, o) => n * 256 + (+o), 0) >>> 0;
function loadAsn() {
  const rows = [];
  for (const line of readFileSync(ASN_TSV, "utf8").split("\n")) {
    const p = line.split("\t");
    if (p.length >= 5) rows.push([ip4(p[0]), ip4(p[1]), p[3], p[4]]);
  }
  return rows; // sorted by range start already
}
function asnFor(rows, ip) {
  const n = ip4(ip);
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] > n) hi = mid - 1;
    else if (rows[mid][1] < n) lo = mid + 1;
    else return { country: rows[mid][2], org: rows[mid][3] };
  }
  return { country: "", org: "" };
}
const ISPY = /comcast|verizon|at&t|att-|t-mobile|sprint|spectrum|charter|cox\b|centurylink|lumen|frontier|windstream|vodafone|telstra|telecom|cellular|mobile|wireless|broadband|residential|dsl|fios|cable|google\s*(llc|fiber)|cloudflare|akamai|fastly|amazon|aws|microsoft|azure|oracle|ovh|hetzner|digitalocean|linode|vultr|leaseweb|m247|datacamp|proton|nord|express.?vpn|mullvad|tor\b/i;

async function rdns(ip) {
  try { const h = await Promise.race([dnsp.reverse(ip), new Promise((_, rj) => setTimeout(rj, 2500))]); return (h && h[0]) || ""; }
  catch { return ""; }
}

// ------------------------------------------------------- send-ledger matching
function loadLedger() {
  const byDomain = new Map(); // email domain -> { company, people: Map(email -> person) }
  if (!existsSync(OUT)) return byDomain;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (!r || !r.result || !r.result.ok || !r.to_email) continue;
        const dom = String(r.to_email).toLowerCase().split("@")[1];
        if (!dom) continue;
        const e = byDomain.get(dom) || { company: r.company || dom, people: new Map() };
        e.people.set(String(r.to_email).toLowerCase(), {
          name: r.to_name || "", title: r.to_title || "", email: String(r.to_email).toLowerCase(),
          recruiter: r.from_owner || "", lastEmailed: r.at || "",
        });
        byDomain.set(dom, e);
      } catch { /* skip */ }
    }
  }
  // LinkedIn URLs from the resolve ledger, keyed by lead email.
  try {
    for (const line of readFileSync(`${OUT}/leads-linkedin.jsonl`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        const email = String(r.email || r.to_email || "").toLowerCase();
        const url = r.linkedinUrl || r.url || "";
        if (!email || !url || r.status === "no_match") continue;
        const dom = email.split("@")[1];
        const e = byDomain.get(dom);
        if (e && e.people.has(email)) e.people.get(email).linkedin = url;
      } catch { /* skip */ }
    }
  } catch { /* resolve ledger not there yet */ }
  return byDomain;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|technology|solutions|services)\b/g, "").replace(/[^a-z0-9]/g, "");
function matchCompany(ledger, rdnsHost, asOrg) {
  const host = String(rdnsHost || "").toLowerCase();
  for (const [dom, e] of ledger) {
    if (host === dom || host.endsWith("." + dom)) return { dom, e, how: "reverse-dns", sure: true };
  }
  const org = norm(asOrg);
  if (org.length >= 5) {
    for (const [dom, e] of ledger) {
      const c = norm(e.company);
      if (c.length >= 5 && (org.includes(c) || c.includes(org))) return { dom, e, how: "network-owner", sure: false };
    }
  }
  return null;
}

// ------------------------------------------------------------------- run
const cursor = loadCursor();
const fresh = newVisits(cursor);
const prior = (() => { try { const s = JSON.parse(readFileSync(SNAP, "utf8")); return s.workspaceId === WS ? s : null; } catch { return null; } })();

if (!fresh.length && prior) {
  saveCursor(cursor);
  console.log("site-visitors -> no new traffic since last run");
  process.exit(0);
}

await ensureAsnDb();
const asnRows = loadAsn();
const ledger = loadLedger();

// Group new visits per IP, resolve each IP once.
const byIp = new Map();
for (const v of fresh) {
  const e = byIp.get(v.ip) || { ip: v.ip, pages: [], first: v.at, last: v.at };
  e.pages.push(v.path); e.last = v.at > e.last ? v.at : e.last;
  byIp.set(v.ip, e);
}
const matched = new Map((prior?.companies || []).map((c) => [c.domain, c]));
const unmatchedCorp = new Map((prior?.corporate || []).map((u) => [u.ip, u]));
let residential = prior?.residentialCount || 0;

for (const e of byIp.values()) {
  const { country, org } = asnFor(asnRows, e.ip);
  const host = await rdns(e.ip);
  const hit = matchCompany(ledger, host, org);
  if (hit) {
    const c = matched.get(hit.dom) || {
      company: hit.e.company, domain: hit.dom, visits: 0, lastVisit: "", pages: [], via: hit.how, confident: hit.sure,
      people: [...hit.e.people.values()].sort((a, b) => (b.lastEmailed || "").localeCompare(a.lastEmailed || "")),
    };
    c.visits += e.pages.length;
    c.lastVisit = e.last > c.lastVisit ? e.last : c.lastVisit;
    c.pages = [...new Set(c.pages.concat(e.pages))].slice(0, 12);
    if (hit.sure) c.confident = true;
    matched.set(hit.dom, c);
    for (const p of c.people) {
      appendFileSync(LEADS, JSON.stringify({ at: e.last, company: c.company, domain: c.domain, via: hit.how, ...p }) + "\n");
    }
  } else if (org && !ISPY.test(org) && !ISPY.test(host)) {
    const u = unmatchedCorp.get(e.ip) || { ip: e.ip, org, rdns: host, country, visits: 0, lastVisit: "", pages: [] };
    u.visits += e.pages.length;
    u.lastVisit = e.last > u.lastVisit ? e.last : u.lastVisit;
    u.pages = [...new Set(u.pages.concat(e.pages))].slice(0, 8);
    unmatchedCorp.set(e.ip, u);
  } else {
    residential += 1;
  }
}

const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
const snap = {
  workspaceId: WS,
  generatedAt: new Date().toISOString(),
  companies: [...matched.values()].filter((c) => c.lastVisit >= cutoff).sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)).slice(0, 100),
  corporate: [...unmatchedCorp.values()].filter((u) => u.lastVisit >= cutoff).sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)).slice(0, 60),
  residentialCount: residential,
};
writeFileSync(SNAP + ".tmp", JSON.stringify(snap, null, 2));
renameSync(SNAP + ".tmp", SNAP);
saveCursor(cursor);
console.log(`site-visitors -> ${fresh.length} new page views, ${byIp.size} unique IPs | matched companies ${snap.companies.length} | corporate unmatched ${snap.corporate.length} | residential/hosting ${residential}`);
for (const c of snap.companies.slice(0, 5)) console.log(`  ${c.company} (${c.via}) -> ${c.people.map((p) => p.name).join(", ")}`);
