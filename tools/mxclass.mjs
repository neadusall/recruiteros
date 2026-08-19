// RecruitersOS · MPC · recipient MX classification (self-contained, no app imports).
//
// The enterprise-deliverability layer for the tools lane. Every recipient domain's MX
// answers two questions the sender must not guess at:
//
//   family - who hosts their mailbox: google | microsoft | custom | unknown. All MPC
//            cold volume leaves Azure/Outlook infrastructure (Sending.ac), so
//            microsoft-hosted recipients are our best-matched sends (Outlook
//            blacklists by IP; same-infrastructure mail lands best) and go FIRST.
//   seg    - the secure email gateway fronting the domain (Proofpoint, Mimecast,
//            Barracuda, IronPort...). Hitting an SEG from a young sending domain is
//            how fleets end up on shared blacklists, so SEG-protected recipients are
//            DEFERRED until the fleet qualifies (MPC_SEG_SEND=1 turns them on).
//
// Results cache durably in ${MPC_OUT_DIR}/mx-class.json (14-day TTL, 1-day for
// failures) so an unattended daily job does at most one DNS lookup per domain per day.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { promises as dns } from "node:dns";

const OUT = process.env.MPC_OUT_DIR || "/out";
const CACHE_FILE = `${OUT}/mx-class.json`;
const OK_TTL_MS = 14 * 86_400_000;
const ERR_TTL_MS = 1 * 86_400_000;
const TIMEOUT_MS = 4000;

const SEG_SUFFIXES = [
  ["pphosted.com", "proofpoint"],
  ["ppe-hosted.com", "proofpoint"],
  ["gpphosted.com", "proofpoint"],
  ["mimecast.com", "mimecast"],
  ["mimecast-offshore.com", "mimecast"],
  ["barracudanetworks.com", "barracuda"],
  ["ess.barracuda.com", "barracuda"],
  ["iphmx.com", "ironport"],
  ["mxlogic.net", "mxlogic"],
  ["messagelabs.com", "messagelabs"],
  ["mailcontrol.com", "forcepoint"],
];
const GOOGLE = ["aspmx.l.google.com", "googlemail.com", "smtp.google.com"];
const MICROSOFT = ["protection.outlook.com", "protection.office365.us", "eo.outlook.com"];

const matches = (host, suffix) => host === suffix || host.endsWith("." + suffix);

// Pure classification of MX hostnames (exported for tests).
export function classifyMxHosts(hosts) {
  const hs = hosts.map((h) => String(h).toLowerCase().replace(/\.$/, ""));
  let seg = null;
  outer: for (const h of hs) for (const [suffix, vendor] of SEG_SUFFIXES) {
    if (matches(h, suffix)) { seg = vendor; break outer; }
  }
  let family = hs.length ? "custom" : "none";
  if (hs.some((h) => GOOGLE.some((s) => matches(h, s)))) family = "google";
  else if (hs.some((h) => MICROSOFT.some((s) => matches(h, s)))) family = "microsoft";
  return { family, seg };
}

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveCache(cache) {
  try {
    const tmp = CACHE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, CACHE_FILE);
  } catch { /* cache is an optimization, never a blocker */ }
}
function freshEntry(e) {
  if (!e || !e.at) return false;
  const age = Date.now() - Date.parse(e.at);
  return Number.isFinite(age) && age < (e.family === "none" ? ERR_TTL_MS : OK_TTL_MS);
}

async function resolveOne(domain) {
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return classifyMxHosts(mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange));
  } catch {
    return { family: "none", seg: null }; // no MX or resolver trouble; caller decides
  }
}

/**
 * Classify a list of email addresses. Returns Map(lowercased email -> {family, seg}).
 * family "none" = the domain resolved no MX right now (likely to bounce).
 */
export async function classifyEmails(emails, { concurrency = 12 } = {}) {
  const cache = loadCache();
  const byDomain = new Map();
  for (const e of emails) {
    const d = String(e || "").toLowerCase().split("@")[1];
    if (d && !byDomain.has(d)) byDomain.set(d, null);
  }
  const todo = [...byDomain.keys()].filter((d) => !freshEntry(cache[d]));
  for (let i = 0; i < todo.length; i += concurrency) {
    const slice = todo.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(resolveOne));
    slice.forEach((d, j) => { cache[d] = { ...results[j], at: new Date().toISOString() }; });
  }
  if (todo.length) saveCache(cache);
  const out = new Map();
  for (const e of emails) {
    const key = String(e || "").toLowerCase().trim();
    const d = key.split("@")[1];
    const c = d && cache[d] ? cache[d] : { family: "unknown", seg: null };
    out.set(key, { family: c.family, seg: c.seg || null });
  }
  return out;
}
