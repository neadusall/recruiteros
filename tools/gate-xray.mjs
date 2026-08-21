// RecruitersOS · MPC · GATE X-RAY (read-only analysis; sends nothing, writes nothing).
// Mirrors batch.mjs's selection loop exactly, but records EVERY failure per row instead of
// bucketing by first-match. Answers: which gate is the real binding constraint, and how many
// rows would unlock if we loosened each one INDEPENDENTLY.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { assessProspect, dmFunction, roleFamily, roleFunctionGroup, buildCompanyKnowledge, companyKeyOf, isSeniorHire } from "./gates.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";

function loadArray(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const arrs = [];
  const walk = (o) => {
    if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); }
    else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v);
  };
  walk(s);
  return arrs.sort((a, b) => b.length - a.length)[0] || [];
}

function alreadyEmailed() {
  const seen = new Set();
  if (!existsSync(OUT)) return seen;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email) seen.add(String(r.to_email).toLowerCase().trim()); } catch { /* skip */ }
    }
  }
  return seen;
}

const curatedAll = loadArray(CURATION);
const curated = curatedAll.filter((r) => String((r.lead || r).curatedAt || "") >= SINCE);

try {
  const ovr = (JSON.parse(readFileSync(process.env.MPC_BUYER_OVERRIDES || "/data/snap_mpc_buyer_overrides_v1.json", "utf8")) || {}).rows || {};
  for (const r of curated) { const p = r.lead || r; if (p.id && ovr[p.id]) Object.assign(p, ovr[p.id]); }
} catch { /* absent overlay is fine */ }

const normCoName = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|co|company|group|holdings)\b/g, " ").replace(/[^a-z0-9]+/g, "").trim();
const sizeByName = new Map();
try {
  const snap = JSON.parse(readFileSync(process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json", "utf8"));
  for (const [k, v] of Object.entries((snap && (snap.data || snap)) || {})) {
    if (v && typeof v.count === "number" && v.count > 0) sizeByName.set(normCoName(k), v.count);
  }
} catch { /* cache absent */ }

const know = buildCompanyKnowledge(curated.map((r) => r.lead || r));
const ownerKey = (co, fn) => `${companyKeyOf(co)}|${fn}`;
const owners = new Map();
for (const r of curated) {
  const p = r.lead || r;
  if (!p.managerName || !p.managerTitle || !p.likelyEmail) continue;
  const fn = dmFunction(p.managerTitle);
  if (!fn || fn === "universal") continue;
  const k = ownerKey(p.company, fn);
  const score = (p.emailValidated ? 2 : 0) - (p.emailCatchAll ? 1 : 0) - (p.emailInvalid ? 5 : 0);
  const cur = owners.get(k);
  if (!cur || score > cur.score) {
    owners.set(k, { score, name: p.managerName, title: p.managerTitle, email: p.likelyEmail, emailValidated: !!p.emailValidated, emailCatchAll: !!p.emailCatchAll, emailInvalid: !!p.emailInvalid });
  }
}

const exhausted = new Set();
try {
  const days = Number(process.env.MPC_OWNER_EXHAUSTED_DAYS || 60);
  const cutoff = Date.now() - days * 864e5;
  const latest = new Map();
  for (const line of readFileSync(`${OUT}/renamed-buyers.jsonl`, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (!r || !r.companyKey || !r.fn) continue;
      const ts = Date.parse(r.ts) || 0;
      const cur = latest.get(`${r.companyKey}|${r.fn}`);
      if (!cur || ts >= cur.ts) latest.set(`${r.companyKey}|${r.fn}`, { ts, outcome: r.outcome });
    } catch { /* truncated line */ }
  }
  for (const [k, v] of latest) if (v.outcome === "no_name" && v.ts >= cutoff) exhausted.add(k);
} catch { /* no ledger */ }

const sent = alreadyEmailed();

function famOf(f) {
  if (/is not a professional hire|accounting\/finance hire/.test(f)) return "role";
  if (/employee target band|size for .* is unconfirmed/.test(f)) return "size";
  if (/decision-maker|different company/.test(f)) return "dm";
  if (/email/.test(f)) return "email";
  return "other";
}

function emailSub(f) {
  if (/no email/.test(f)) return "no address at all";
  if (/not validated/.test(f)) return "never validated (Reoon clears these)";
  if (/catch-all guess/.test(f)) return "catch-all domain (person unconfirmed)";
  if (/undeliverable/.test(f)) return "known undeliverable";
  if (/role\/shared inbox/.test(f)) return "role inbox (info@, hr@)";
  if (/parsed artifact|mangled-encoding/.test(f)) return "parsed junk local-part";
  if (/!=/.test(f)) return "email domain != company domain";
  return "other email";
}

const famCount = {}, emailSubCount = {}, sizeBuckets = {}, soloBlocked = {}, dmTitles = {}, dmMsgs = {}, emailOnlyBlocks = {};
let eligible = 0, eligibleFresh = 0;
const sizeOnlyFresh = [], dmOnlyFresh = [], validateOnlyFresh = [], mismatchSamples = [], foreignSamples = [];

for (const r of curated) {
  const p = r.lead || r;
  p.companyBuyerRow = /_buyer_/.test(String(r.id || p.id || ""));
  if (p.employeeCount == null) { const c = sizeByName.get(normCoName(p.company)); if (c != null) p.employeeCount = c; }
  const roleFnForOwner = roleFunctionGroup(roleFamily(p.role));
  const ck = companyKeyOf(p.company);
  const k = know.get(ck);
  p.ownerKnownAtCompany = owners.has(ownerKey(p.company, roleFnForOwner)) || !!(k && k.fnLeaders.has(roleFnForOwner));
  p.ownerSearchExhausted = exhausted.has(`${ck}|${roleFnForOwner}`);
  const roleFn = roleFnForOwner, curFn = dmFunction(p.managerTitle);
  const alreadyOwner = curFn && curFn !== "universal" && curFn === roleFn;
  if (!alreadyOwner && roleFn !== "Executive" && !isSeniorHire(p.role)) {
    const o = owners.get(ownerKey(p.company, roleFn));
    if (o && o.name.trim().toLowerCase() !== String(p.managerName || "").trim().toLowerCase()) {
      p.managerName = o.name; p.managerTitle = o.title; p.likelyEmail = o.email;
      p.emailValidated = o.emailValidated; p.emailCatchAll = o.emailCatchAll; p.emailInvalid = o.emailInvalid;
      p.companyBuyerRow = false;
    }
  }
  const res = assessProspect(p);
  const fresh = !sent.has(String(p.likelyEmail || "").toLowerCase().trim());
  if (res.eligible) { eligible++; if (fresh) eligibleFresh++; continue; }

  const fams = new Set(res.failures.map(famOf));
  for (const f of fams) famCount[f] = (famCount[f] || 0) + 1;
  if (fams.has("email")) {
    for (const f of res.failures.filter((x) => famOf(x) === "email")) { const s = emailSub(f); emailSubCount[s] = (emailSubCount[s] || 0) + 1; }
  }
  if (fams.has("size")) {
    const n = p.employeeCount;
    const b = n == null ? "unconfirmed" : n < 25 ? "<25" : n < 100 ? "25-99" : n <= 1000 ? "100-1000" : n <= 2500 ? "1001-2500" : n <= 5000 ? "2501-5000" : n <= 25000 ? "5001-25000" : ">25000";
    sizeBuckets[b] = (sizeBuckets[b] || 0) + 1;
  }
  if (fams.size === 1) {
    const only = [...fams][0];
    soloBlocked[only] = (soloBlocked[only] || 0) + 1;
    if (fresh && only === "size") sizeOnlyFresh.push(p);
    if (fresh && only === "dm") {
      dmOnlyFresh.push(p);
      const msg = res.failures.filter((f) => famOf(f) === "dm").join(" ~ ").replace(/"[^"]*"/g, "<X>").slice(0, 120);
      if (/different company/.test(msg)) foreignSamples.push(p);
      dmMsgs[msg] = (dmMsgs[msg] || 0) + 1;
      const t = String(p.managerTitle || "(none)").toLowerCase().replace(/[^a-z& ]/g, "").trim();
      dmTitles[t] = (dmTitles[t] || 0) + 1;
    }
    if (only === "email") {
      const subs = res.failures.filter((f) => famOf(f) === "email").map(emailSub).sort().join(" + ");
      const key = fresh ? `FRESH  ${subs}` : `contacted  ${subs}`;
      if (fresh && subs === "email domain != company domain") mismatchSamples.push(p);
      emailOnlyBlocks[key] = (emailOnlyBlocks[key] || 0) + 1;
    }
    if (fresh && only === "email" && res.failures.every((f) => /not validated/.test(f))) validateOnlyFresh.push(p);
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n=== GATE X-RAY  (finance-era rows since ${SINCE}) ===`);
console.log(`curated rows: ${curated.length} | pass every gate: ${eligible} | of those never contacted: ${eligibleFresh}\n`);
console.log(`-- rows touched by each gate (a row can fail several) --`);
for (const [k, v] of Object.entries(famCount).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 8)} ${String(v).padStart(6)}  (${(v / curated.length * 100).toFixed(1)}%)`);
console.log(`\n-- rows blocked by that gate ALONE (fix it and the row sends) --`);
for (const [k, v] of Object.entries(soloBlocked).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 8)} ${String(v).padStart(6)}`);
console.log(`\n-- headcount of every size-gated row --`);
for (const [k, v] of Object.entries(sizeBuckets).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 12)} ${String(v).padStart(6)}`);
console.log(`\n-- why the email gate fires --`);
for (const [k, v] of Object.entries(emailSubCount).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 38)} ${String(v).padStart(6)}`);
console.log(`\n=== WHAT EACH LOOSENING WOULD UNLOCK (fresh, never-contacted rows) ===`);
const band = (lo, hi) => sizeOnlyFresh.filter((p) => p.employeeCount != null && p.employeeCount >= lo && p.employeeCount <= hi).length;
console.log(`  widen band down to 50                +${band(50, 99)}`);
console.log(`  widen band down to 25                +${band(25, 99)}`);
console.log(`  widen band up to 2500 (all rows)     +${band(1001, 2500)}`);
console.log(`  widen band up to 5000                +${band(1001, 5000)}`);
console.log(`  widen band up to 25000               +${band(1001, 25000)}`);
console.log(`  no upper bound at all                +${sizeOnlyFresh.filter((p) => p.employeeCount != null && p.employeeCount > 1000).length}`);
console.log(`  validate the never-validated (Reoon) +${validateOnlyFresh.length}`);
console.log(`  relax decision-maker title gate      +${dmOnlyFresh.length}`);
console.log(`\n-- ACTUAL decision-maker failure messages (dm-only fresh blocks) --`);
for (const [k, v] of Object.entries(dmMsgs).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\n-- top titles the decision-maker gate rejects (dm-only blocks) --`);
for (const [k, v] of Object.entries(dmTitles).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\n-- the 2,490 email-ONLY blocks, by exact reason --`);
for (const [k, v] of Object.entries(emailOnlyBlocks).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\n-- sample: domain-mismatch-ONLY fresh rows --`);
let n=0; for (const p of mismatchSamples.slice(0,18)) console.log(`  ${String(p.company).slice(0,34).padEnd(35)} co-domain=${String(p.domain).padEnd(28)} email=${p.likelyEmail}`);
console.log(`\n-- sample: foreignAffiliation rejections (title -> company) --`);
for (const p of foreignSamples.slice(0,20)) console.log(`  title=${JSON.stringify(String(p.managerTitle||"").slice(0,52)).padEnd(56)} company=${p.company}`);
