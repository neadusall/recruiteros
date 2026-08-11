// RecruitersOS · MPC · autonomous DNS authentication remediation (Porkbun).
//
// Closes DMARC gaps on its own. Reads the deliverability audit, finds every SENDING domain that is
// authenticated on SPF + DKIM but whose DMARC is missing or p=none, and publishes an enforcing
// DMARC record via the Porkbun API. Idempotent and SAFE: it only ever creates/updates the ONE
// `_dmarc` TXT record, never touches SPF, DKIM, MX, or a DMARC that is already enforcing, and it
// verifies over DNS afterward. Dry-run by default; --apply writes.
//
//   PORKBUN_API_KEY=pk1_... PORKBUN_SECRET_KEY=sk1_... node scripts/mpc/dns-authfix.mjs          # plan only
//   PORKBUN_API_KEY=pk1_... PORKBUN_SECRET_KEY=sk1_... node scripts/mpc/dns-authfix.mjs --apply  # publish
//
// Credentials: Porkbun's DNS API is off by default. One-time unlock (owner): Account -> API Access,
// enable it + generate a key pair, then toggle "API Access" ON for each domain. Drop the pk1_/sk1_
// pair in as PORKBUN_API_KEY / PORKBUN_SECRET_KEY and this runs unattended from the daily rota.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { promises as dns } from "node:dns";

const DELIV_FILE = process.env.MPC_DELIVERABILITY_FILE || "/data/snap_mpc_deliverability_v1.json";
const OUT_FILE = process.env.MPC_DNSFIX_FILE || "/data/snap_mpc_dnsfix_v1.json";
const OUT_DIR = process.env.MPC_OUT_DIR || "/out";
const API = process.env.PORKBUN_API_BASE || "https://api.porkbun.com/api/json/v3";
const APPLY = process.argv.includes("--apply");
const DMARC_POLICY = process.env.MPC_DMARC_POLICY || "quarantine"; // quarantine (safe default) or reject

const apikey = process.env.PORKBUN_API_KEY || "";
const secretapikey = process.env.PORKBUN_SECRET_KEY || "";

function log(msg) { console.log(msg); try { mkdirSync(OUT_DIR, { recursive: true }); appendFileSync(`${OUT_DIR}/dnsfix-${new Date().toISOString().slice(0, 10)}.log`, `${new Date().toISOString()} ${msg}\n`); } catch { /* best-effort */ } }

async function pb(path, body = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apikey, secretapikey, ...body }),
    signal: AbortSignal.timeout(25_000),
  });
  let data = null; try { data = await res.json(); } catch { /* non-json */ }
  return { httpOk: res.ok, status: res.status, data };
}

// The gap set: sending domains with SPF+DKIM present but DMARC missing or p=none. Read straight from
// the deliverability audit so this and the panel always agree on what needs fixing.
function gapDomains() {
  const argv = process.argv.find((a) => a.startsWith("--domains="));
  if (argv) return argv.slice("--domains=".length).split(",").map((s) => s.trim()).filter(Boolean);
  if (!existsSync(DELIV_FILE)) return [];
  const d = JSON.parse(readFileSync(DELIV_FILE, "utf8"));
  return (d.byDomain || [])
    .filter((x) => x.sent > 0 && x.auth && x.auth.spf && x.auth.dkim && (!x.auth.dmarc || x.auth.dmarcPolicy === "none"))
    .map((x) => x.domain);
}

const desiredValue = (domain) => `v=DMARC1; p=${DMARC_POLICY}; rua=mailto:postmaster@${domain}`;

async function verifyDmarc(domain) {
  try {
    const recs = (await dns.resolveTxt(`_dmarc.${domain}`)).map((r) => r.join(""));
    const rec = recs.find((t) => /^v=DMARC1/i.test(t));
    if (!rec) return { present: false };
    const p = rec.match(/p=(\w+)/i);
    return { present: true, policy: p ? p[1].toLowerCase() : null, enforcing: !!p && p[1].toLowerCase() !== "none" };
  } catch { return { present: false }; }
}

async function fixDomain(domain) {
  const want = desiredValue(domain);
  // What Porkbun currently holds for _dmarc TXT (source of truth for the edit vs create decision).
  const cur = await pb(`/dns/retrieveByNameType/${domain}/TXT/_dmarc`);
  if (!cur.httpOk || !cur.data || cur.data.status !== "SUCCESS") {
    const msg = (cur.data && cur.data.message) || `http ${cur.status}`;
    if (/api access|not been enabled|edit permission/i.test(msg)) return { domain, action: "blocked", detail: "API access not enabled for this domain in Porkbun" };
    return { domain, action: "error", detail: msg };
  }
  const existing = (cur.data.records || []).find((r) => /^v=DMARC1/i.test(r.content || ""));
  const already = existing && /p=(quarantine|reject)/i.test(existing.content || "");
  if (already) return { domain, action: "skip", detail: "DMARC already enforcing" };
  if (!APPLY) return { domain, action: existing ? "would-update" : "would-create", detail: want };
  const write = existing
    ? await pb(`/dns/editByNameType/${domain}/TXT/_dmarc`, { content: want, ttl: "600" })
    : await pb(`/dns/create/${domain}`, { name: "_dmarc", type: "TXT", content: want, ttl: "600" });
  if (!write.httpOk || !write.data || write.data.status !== "SUCCESS") {
    return { domain, action: "error", detail: (write.data && write.data.message) || `http ${write.status}` };
  }
  return { domain, action: existing ? "updated" : "created", detail: want };
}

async function main() {
  const domains = gapDomains();
  log(`dns-authfix: ${domains.length} DMARC-gap domain(s) ${APPLY ? "to FIX" : "(dry-run, no writes)"}`);
  if (!apikey || !secretapikey) {
    log("PORKBUN_API_KEY / PORKBUN_SECRET_KEY not set. One-time unlock: Porkbun -> Account -> API Access (enable + generate key), then toggle API Access ON per domain. Planned records:");
    for (const d of domains) log(`  would set _dmarc.${d} = ${desiredValue(d)}`);
    writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), ready: false, reason: "no PORKBUN api keys", gapDomains: domains, results: [] }, null, 2));
    return;
  }
  const ping = await pb("/ping");
  if (!ping.httpOk || !ping.data || ping.data.status !== "SUCCESS") { log(`Porkbun auth failed: ${(ping.data && ping.data.message) || ping.status}. Check the key pair + that API access is enabled.`); return; }
  log(`Porkbun auth OK (egress IP ${ping.data.yourIp}).`);

  const results = [];
  for (const d of domains) {
    try {
      const r = await fixDomain(d);
      if (APPLY && (r.action === "created" || r.action === "updated")) { await new Promise((s) => setTimeout(s, 1500)); r.verify = await verifyDmarc(d); }
      results.push(r);
      log(`  ${d}: ${r.action}${r.detail ? " (" + r.detail + ")" : ""}${r.verify ? " -> now " + (r.verify.enforcing ? "enforcing (" + r.verify.policy + ")" : "policy " + r.verify.policy) : ""}`);
    } catch (e) { results.push({ domain: d, action: "error", detail: e.message }); log(`  ${d}: error ${e.message}`); }
  }
  const fixed = results.filter((r) => r.action === "created" || r.action === "updated").length;
  const blocked = results.filter((r) => r.action === "blocked").map((r) => r.domain);
  const out = { generatedAt: new Date().toISOString(), ready: true, applied: APPLY, policy: DMARC_POLICY, gapDomains: domains, fixed, blocked, results };
  const tmp = OUT_FILE + ".tmp"; writeFileSync(tmp, JSON.stringify(out, null, 2)); renameSync(tmp, OUT_FILE);
  log(`dns-authfix: ${APPLY ? fixed + " domain(s) fixed" : "planned " + results.filter((r) => /would/.test(r.action)).length}${blocked.length ? "; " + blocked.length + " blocked (enable API access per domain): " + blocked.join(", ") : ""}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
