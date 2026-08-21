#!/usr/bin/env node
/**
 * rename-buyers.mjs — turn "decision-maker not a buyer" curated rows into sendable leads.
 *
 * The buyer-correlation gate (gates.mjs) holds thousands of rows whose named DM is the wrong
 * person for the role (CPO on a finance req, CEO at a 4,000-head company) or whose DM is a
 * title with no name ("VP of Finance"). This tool finds the RIGHT person per company+function:
 *   1. FREE: reuse a leader already named on another curated row of the same company.
 *   2. People-search API (same creds as linkedin-resolve.mjs): "Chief Financial Officer {Co}".
 *   3. Email: company's learned pattern first, then standard syntaxes, each confirmed through
 *      Reoon — ONLY status "safe" is accepted (same contract as the app's emailVerify.ts).
 *
 * Results land in an OVERLAY file (/data/snap_mpc_buyer_overrides_v1.json) applied by batch.mjs
 * at read time. The app's curation store is NEVER written here: its write lock is in-process
 * only, so a sidecar co-writer would race the 4-minute curation tick and lose rows.
 *
 * Idempotent: /out/renamed-buyers.jsonl ledger; a company+function that ended no_name/no_email
 * is not retried within RETRY_HOURS. Budgets stop the run cleanly, never mid-person:
 *   MPC_RENAME_PEOPLE_BUDGET  people-search calls this run (default 600)
 *   MPC_RENAME_REOON_BUDGET   Reoon credits this run (default 1500)
 */
import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync, appendFileSync } from "fs";
import {
  assessProspect, roleFamily, roleFunctionGroup, dmFunction, companyKeyOf,
} from "/tools/gates.mjs";
import { targetFor } from "/tools/orgchart.mjs";
import { searchPeople as apiSearchPeople, companyMatches } from "/tools/peopleapi.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const CREDS = process.env.MPC_CREDS_FILE || "/data/snap_integration_credentials_v1.json";
const OVR_FILE = process.env.MPC_BUYER_OVERRIDES || "/data/snap_mpc_buyer_overrides_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const LEDGER = `${OUT}/renamed-buyers.jsonl`;
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
const LUME_WS = "ws_mqf6o989003";
const PEOPLE_BUDGET = Number(process.env.MPC_RENAME_PEOPLE_BUDGET || 600);
const REOON_BUDGET = Number(process.env.MPC_RENAME_REOON_BUDGET || 1500);
const RETRY_HOURS = Number(process.env.MPC_RENAME_RETRY_HOURS || 20);
// PACING (raised 2026-08-21 after measuring the real constraint). The binding limit on this
// provider is PER MINUTE, not the 20,000/month quota: the plan answers "you have exceeded the rate
// limit per minute for your plan, PRO". At the old 800ms gate the tool asked for ~75 calls a
// minute and was refused for almost all of them, and because refusals were being read as "no owner
// exists" (see peopleapi.mjs) the run looked like it was working. A live test at 9s spacing
// answered 6 of 8. 5s is the compromise: a 600-call budget takes ~50 minutes, which is fine for a
// nightly job, and the client's backoff absorbs the rest.
const PACE_MS = Number(process.env.MPC_RENAME_PACE_MS || 5000);
const MAX_FN_PER_COMPANY = 2;
const REOON_KEY = (process.env.REOON_API_KEY || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* ---------------- people-search API (same wiring as linkedin-resolve.mjs) ---------------- */
function peopleApi() {
  const s = JSON.parse(readFileSync(CREDS, "utf8"));
  const k = (((s[LUME_WS] || {}).integrations || {}).jd_sourcing || {}).keys || {};
  if (!k.RAPIDAPI_KEY || !k.RAPIDAPI_PEOPLE_SEARCH_HOST) throw new Error("people API creds missing");
  return { key: k.RAPIDAPI_KEY, host: k.RAPIDAPI_PEOPLE_SEARCH_HOST, path: k.RAPIDAPI_PEOPLE_SEARCH_PATH || "/api/v1/search/people?name={query}&page={page}&limit=10" };
}
let peopleSpent = 0;
// Global rate gate: workers run concurrently but people-search calls stay PACE_MS apart —
// this API burst-limits (429) well before its monthly quota.
let nextPeopleAt = 0;
async function peopleGate() {
  const now = Date.now();
  const wait = Math.max(0, nextPeopleAt - now);
  nextPeopleAt = Math.max(now, nextPeopleAt) + PACE_MS;
  if (wait) await sleep(wait);
}
/**
 * Search, via the shared client so failures cannot be mistaken for absence.
 *
 * WHAT WAS WRONG (fixed 2026-08-21). This provider answers errors with HTTP 202 and
 * `{"success":false,"message":"Request failed with status 429..."}`. The old body of this function
 * checked `res.ok` (202 passes), read `j.data` (absent) and returned `[]` — which the caller then
 * recorded as `no_name`, i.e. "this company has no such leader". 1,286 company+function pairs
 * carry that verdict, and the `res.status === 429` backoff above could never fire because the
 * status was 202. Diagnosed at a 6.9% owner find-rate with 12,382 of 20,000 monthly requests
 * still available: the quota was fine, the provider's own scraper was throttled, and every refusal
 * still cost a credit.
 *
 * Returns the client's kind so the caller can tell the three cases apart:
 *   { kind: "people" | "empty" }      a real answer, safe to act on and to record
 *   { kind: "ratelimit"|"apifail"|"http" }  our problem, not the company's: record NOTHING
 * `null` still means the local budget is spent, which is also not a verdict about the company.
 */
async function searchPeople(api, query) {
  if (peopleSpent >= PEOPLE_BUDGET) return null; // people budget exhausted (pool-reuse jobs continue)
  await peopleGate();
  const r = await apiSearchPeople(api, query, { attempts: 3, baseDelayMs: 8000 });
  peopleSpent++;   // a throttled call still costs a credit, so it still counts against the budget
  if (Number.isFinite(r.remaining) && r.remaining <= 0) {
    console.log("people API: monthly quota exhausted, stopping the hunt");
    peopleSpent = PEOPLE_BUDGET;
  }
  return r;
}

/* ---------------- Reoon (contract mirrors integration/lib/inmarket/emailVerify.ts) -------- */
let reoonSpent = 0;
async function reoonVerify(email) {
  if (!REOON_KEY) throw new Error("REOON_API_KEY missing (pass .env.production through --env-file)");
  if (reoonSpent >= REOON_BUDGET) return { verdict: "budget" };
  reoonSpent++;
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(REOON_KEY)}&mode=power`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res || !res.ok) return { verdict: "transient" };
  const r = await res.json().catch(() => null);
  if (!r) return { verdict: "transient" };
  const status = String(r.status ?? "").toLowerCase();
  if (status === "safe") return { verdict: "safe" };
  if (status === "catch_all") return { verdict: "catch_all" };
  if (r.mx_accepts_mail === false) return { verdict: "domain_dead" };
  if (["invalid", "disabled", "disposable", "spamtrap"].includes(status)) return { verdict: "dead" };
  return { verdict: "unknown" };
}

/* ---------------- email pattern helpers --------------------------------------------------- */
const cleanName = (s) => String(s || "")
  .normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/,.*$/, "")                                  // ", CPA" / ", MBA" credentials
  .replace(/\b(jr|sr|ii|iii|iv|phd|mba|cpa|cfa)\b\.?/gi, "")
  .replace(/[^a-zA-Z\s'-]/g, " ").replace(/\s+/g, " ").trim();
function nameParts(fullName) {
  const t = cleanName(fullName).toLowerCase().split(" ").filter(Boolean);
  if (t.length < 2) return null;
  const first = t[0].replace(/[^a-z]/g, ""), last = t[t.length - 1].replace(/[^a-z]/g, "");
  if (first.length < 2 || last.length < 2) return null;
  return { first, last };
}
function addrFor(pattern, n, domain) {
  const map = {
    "first.last": `${n.first}.${n.last}`, "flast": `${n.first[0]}${n.last}`,
    "first": n.first, "firstlast": `${n.first}${n.last}`, "f.last": `${n.first[0]}.${n.last}`,
    "last.first": `${n.last}.${n.first}`, "first_last": `${n.first}_${n.last}`,
  };
  const local = map[pattern];
  return local ? `${local}@${domain}` : null;
}
/** Infer the company's pattern from a colleague we already hold (name + confirmed address). */
function inferPattern(fullName, email) {
  const n = nameParts(fullName); if (!n) return null;
  const local = String(email || "").split("@")[0]?.toLowerCase() || "";
  for (const p of ["first.last", "flast", "firstlast", "f.last", "first", "last.first", "first_last"]) {
    if (addrFor(p, n, "x")?.split("@")[0] === local) return p;
  }
  return null;
}

/* ---------------- which leader title do we hunt per function group ------------------------
 * FALLBACK ONLY as of 2026-08-21. The rung we hunt now comes from orgchart.targetFor(), which
 * reads the req's own seniority and the company's headcount, so a Staff Accountant opening hunts
 * an Accounting Manager and a Controller opening hunts a VP Finance or CFO. This table is what we
 * fall back to when the org chart has no titles for a function (an unmapped function group), and
 * it is also the list that decides which functions this tool will work at all.
 * ---------------------------------------------------------------------------------------- */
const HUNT = {
  "Finance": "Chief Financial Officer",
  "Sales": "Chief Revenue Officer",
  "Marketing": "Chief Marketing Officer",
  "Engineering": "VP of Engineering",
  "Product": "Chief Product Officer",
  "Operations": "Chief Operating Officer",
  "People / HR": "Chief People Officer",
  "Legal": "General Counsel",
  "Executive": "Chief Executive Officer",
};

/* ---------------- load state -------------------------------------------------------------- */
function loadArray(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(j)) return j;
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(j); arrs.sort((a, b) => b.length - a.length); return arrs[0] || [];
}
function sentEmails() {
  const out = new Set();
  if (!existsSync(OUT)) return out;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r?.to_email && r?.result?.ok) out.add(r.to_email.toLowerCase()); } catch { /* skip */ }
    }
  }
  return out;
}
function loadOverrides() {
  try { const j = JSON.parse(readFileSync(OVR_FILE, "utf8")); return (j && j.rows) || {}; } catch { return {}; }
}
let ovrRows = loadOverrides();
function saveOverrides() {
  const tmp = `${OVR_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), rows: ovrRows }, null, 0));
  renameSync(tmp, OVR_FILE);
}
function recentAttempts() {
  const m = new Map();
  if (!existsSync(LEDGER)) return m;
  const cutoff = Date.now() - RETRY_HOURS * 3600_000;
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try { const r = JSON.parse(s); if (Date.parse(r.ts) >= cutoff) m.set(`${r.companyKey}|${r.fn}`, r.outcome); } catch { /* skip */ }
  }
  return m;
}
const ledger = (rec) => appendFileSync(LEDGER, JSON.stringify({ ...rec, ts: new Date().toISOString() }) + "\n");

/* ---------------- main --------------------------------------------------------------------- */
const rows = loadArray(CURATION).map((r) => r.lead || r).filter((p) => String(p.curatedAt || "") >= SINCE);

// HEADCOUNT (2026-08-21). This tool ran assessProspect and the people-search WITHOUT ever attaching
// a company size, which made it blind in two ways that both point the search at the wrong person:
// the band gate saw every company as "unconfirmed", and the org chart defaulted to the widest tier
// and therefore hunted a C-level title for every req. Same source and normalisation as batch.mjs so
// the tool that FINDS the buyer and the tool that SENDS to them read one number.
{
  const SIZE_SNAP = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
  const normCo = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|co|company|group|holdings)\b/g, " ").replace(/[^a-z0-9]+/g, "").trim();
  const byName = new Map();
  try {
    const snap = JSON.parse(readFileSync(SIZE_SNAP, "utf8"));
    for (const [k, v] of Object.entries((snap && (snap.data || snap)) || {})) {
      if (v && typeof v.count === "number" && v.count > 0) byName.set(normCo(k), v.count);
    }
  } catch { /* no cache: sizes stay unknown and the chart falls back to its widest band */ }
  let stamped = 0;
  for (const p of rows) {
    if (p.employeeCount != null) continue;
    const n = byName.get(normCo(p.company));
    if (n != null) { p.employeeCount = n; stamped++; }
  }
  if (stamped) console.log(`headcounts attached: ${stamped} rows (drives both the band gate and which rung we hunt)`);
}
const seen = sentEmails();
const attempted = recentAttempts();
console.log(`finance-era rows: ${rows.length} | prior overrides: ${Object.keys(ovrRows).length} | recent attempts skipped: ${attempted.size}`);

// Company map: fixable dm-held rows per company+fn; company-level blockers respected.
const companies = new Map(); // companyKey -> { company, blocked, colleagues:[], buckets: Map(fn -> rows[]) }
for (const p of rows) {
  const ck = companyKeyOf(p.company); if (!ck) continue;
  let c = companies.get(ck);
  if (!c) companies.set(ck, (c = { company: p.company, blocked: false, colleagues: [], buckets: new Map(), pattern: null, domain: null }));
  if (p.emailPattern && !c.pattern) c.pattern = p.emailPattern;
  if (p.domain && !c.domain) c.domain = String(p.domain).toLowerCase();
  if (p.managerName && p.likelyEmail) c.colleagues.push({ name: p.managerName, email: p.likelyEmail, title: p.managerTitle || "" });
  if (ovrRows[p.id]) { c.blocked = "overridden"; continue; }  // company already has a fixed buyer
  const res = assessProspect(p);
  if (res.eligible) { c.blocked = "has_eligible"; continue; }             // company already has a clean buyer
  if (p.likelyEmail && seen.has(String(p.likelyEmail).toLowerCase())) { c.blocked = "contacted"; continue; }
  const f = res.failures.join(" | ");
  const dmIssue = /decision-maker|no named decision-maker|different company/.test(f);
  const roleIssue = /is not a professional hire|staffing\/recruiting firm/.test(f);
  if (!dmIssue || roleIssue) continue;
  const fn = roleFunctionGroup(roleFamily(p.role));
  if (!HUNT[fn]) continue;
  if (!c.buckets.has(fn)) c.buckets.set(fn, []);
  c.buckets.get(fn).push(p);
}

// Work list: unblocked companies, biggest buckets first (a fix there unlocks the most rows),
// pattern-known companies first within a size tier (cheapest, highest-yield email step).
const work = [];
for (const [ck, c] of companies) {
  if (c.blocked || !c.buckets.size) continue;
  const fns = [...c.buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_FN_PER_COMPANY);
  for (const [fn, list] of fns) {
    if (attempted.has(`${ck}|${fn}`)) continue;
    work.push({ ck, c, fn, list });
  }
}
// Pattern-known companies first (their email step confirms in ~1 credit), then biggest buckets.
work.sort((a, b) => ((b.c.pattern ? 1 : 0) - (a.c.pattern ? 1 : 0)) || (b.list.length - a.list.length));
console.log(`companies to hunt: ${new Set(work.map(w => w.ck)).size} | company+fn jobs: ${work.length}`);
console.log(`budgets: people ${PEOPLE_BUDGET} calls | reoon ${REOON_BUDGET} credits`);

const api = peopleApi();
const CONCURRENCY = Number(process.env.MPC_RENAME_CONCURRENCY || 8);
let named = 0, rowsFixed = 0, freeReuse = 0, deadDomains = 0, stop = false;
const domainBad = new Map(); // domain -> catch_all | domain_dead (memo across jobs)
const t0 = Date.now();

async function processJob(job) {
  const { ck, c, fn, list } = job;
  const sample = list[0];

  const domain = c.domain || (c.colleagues[0]?.email || "").split("@")[1]?.toLowerCase();
  if (!domain) { ledger({ companyKey: ck, company: c.company, fn, outcome: "no_domain" }); return; }
  if (domainBad.has(domain)) { ledger({ companyKey: ck, company: c.company, fn, outcome: `domain_${domainBad.get(domain)}` }); return; }

  // (1) FREE reuse: another curated row at this company already names a leader who owns this fn.
  let person = null;
  const existing = c.colleagues.find((col) => dmFunction(col.title) === fn && nameParts(col.name));
  if (existing) { person = { fullName: existing.name, headline: existing.title, via: "pool" }; freeReuse++; }

  // (2) People search: "{leader title} {company}", strict company + function match on the headline.
  //
  // WHICH TITLE WE HUNT (2026-08-21). This used to be a fixed C-level per function — "Chief
  // Financial Officer {Company}" for every finance req, whatever the req was or however big the
  // company. That is the same mis-targeting the org chart exists to stop, except here it was
  // manufacturing it: the search could only ever return a CFO, so a Staff Accountant opening at a
  // 2,000-person company was always going to end up aimed at one. Now the rung comes from
  // orgchart.targetFor(), best rung first, and we walk UP the chain only if the ideal rung yields
  // nobody. The probe below still re-runs the full gate, so a hit that is too senior for the req is
  // rejected on the spot rather than being written into the overlay.
  if (!person) {
    const band = targetFor({ role: sample.role, functionGroup: fn, headcount: sample.employeeCount });
    const hunts = band.titles.length ? [...new Set(band.titles)] : [HUNT[fn]];
    // Walk the rungs until one ANSWERS. A refusal is not an answer: recording it would write a
    // false "no owner exists" for this company and, since 2026-08-21, would also unlock the
    // C-suite fallback in gates.mjs on evidence that never existed.
    let hits = [];
    let refusal = null;
    for (const huntTitle of hunts) {
      const r = await searchPeople(api, `${huntTitle} ${c.company}`);
      if (r === null) { ledger({ companyKey: ck, company: c.company, fn, outcome: "people_budget" }); return; }
      if (r.kind === "people") { hits = r.people; refusal = null; break; }
      if (r.kind === "empty") { hits = []; refusal = null; continue; }
      refusal = r;   // ratelimit / apifail / http: try the next rung, but remember why
    }
    if (refusal) {
      ledger({ companyKey: ck, company: c.company, fn, outcome: refusal.kind === "ratelimit" ? "api_ratelimit" : "api_error", detail: String(refusal.message || "").slice(0, 120) });
      return;
    }
    for (const h of hits) {
      // COMPANY MATCH via the shared matcher, which compares against the EMPLOYER named in the
      // headline rather than scanning the whole string. The old squashed-substring test accepted
      // "Director Of Media Relations at Magna Carta Records" as a match for "Carta", because
      // "carta" sits inside "magnacartarecords". Caught in the live run on 2026-08-21; a false
      // company match is worse than a miss, since it aims outreach at a stranger.
      if (!companyMatches(c.company, h.headline)) continue;
      const title = h.headline.split("|")[0].trim().slice(0, 90);
      const dmFn = dmFunction(title);
      const fnOk = fn === "Executive" ? dmFn === "universal" : dmFn === fn;
      if (!fnOk || !nameParts(h.fullName)) continue;
      // Dry-run the gate with this person before spending a single Reoon credit.
      const probeRow = { ...sample, managerName: cleanName(h.fullName), managerTitle: title, likelyEmail: `x.y@${domain}`, emailValidated: true, emailInvalid: false, emailCatchAll: false };
      const probe = assessProspect(probeRow);
      const dmClean = !probe.failures.some((x) => /decision-maker|different company/.test(x));
      if (dmClean) { person = { fullName: cleanName(h.fullName), headline: title, via: "people-api" }; break; }
    }
  }
  if (!person) { ledger({ companyKey: ck, company: c.company, fn, outcome: "no_name" }); return; }

  // (3) Email: pattern-first syntax walk through Reoon; only "safe" survives.
  const n = nameParts(person.fullName);
  const learned = c.pattern || (c.colleagues.map((col) => inferPattern(col.name, col.email)).find(Boolean));
  const tryPatterns = [...new Set([learned, "first.last", "flast", "first", "firstlast", "f.last"].filter(Boolean))].slice(0, learned ? 4 : 3);
  let goodEmail = null, personDead = false;
  for (const pat of tryPatterns) {
    const addr = addrFor(pat, n, domain); if (!addr) continue;
    const v = await reoonVerify(addr);
    if (v.verdict === "safe") { goodEmail = addr; if (!c.pattern) c.pattern = pat; break; }
    if (v.verdict === "catch_all" || v.verdict === "domain_dead") { personDead = v.verdict; domainBad.set(domain, v.verdict); break; }
    if (v.verdict === "budget") { personDead = v.verdict; stop = true; break; }
    // dead / unknown / transient — try the next syntax
  }
  if (personDead === "domain_dead") deadDomains++;
  if (!goodEmail) { ledger({ companyKey: ck, company: c.company, fn, outcome: personDead || "no_email", name: person.fullName, via: person.via }); return; }

  named++;
  const nowIso = new Date().toISOString();
  for (const p of list) {
    ovrRows[p.id] = {
      managerName: person.fullName, managerTitle: person.headline,
      likelyEmail: goodEmail, emailValidated: true, emailInvalid: false, emailCatchAll: false,
      emailSource: "validated_external", validatedAt: nowIso, managerVia: `rename-buyers:${person.via}`,
    };
    rowsFixed++;
  }
  saveOverrides();
  ledger({ companyKey: ck, company: c.company, fn, outcome: "fixed", name: person.fullName, email: goodEmail, via: person.via, rows: list.length });
  if (named % 25 === 0) console.log(`progress: ${named} buyers fixed (${rowsFixed} rows) | people ${peopleSpent}/${PEOPLE_BUDGET} | reoon ${reoonSpent}/${REOON_BUDGET} | ${Math.round((Date.now() - t0) / 1000)}s`);
}

let idx = 0;
async function worker() {
  while (!stop && idx < work.length && reoonSpent < REOON_BUDGET) {
    const job = work[idx++];
    try { await processJob(job); } catch (e) { ledger({ companyKey: job.ck, company: job.c.company, fn: job.fn, outcome: "error", error: String(e && e.message || e).slice(0, 120) }); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

console.log(`\nDONE: buyers fixed ${named} (rows unlocked ${rowsFixed}, free pool-reuse ${freeReuse}) | dead domains ${deadDomains}`);
console.log(`spend: people-search ${peopleSpent} calls | reoon ${reoonSpent} credits | overrides total ${Object.keys(ovrRows).length}`);
