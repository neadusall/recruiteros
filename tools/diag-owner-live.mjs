/**
 * LIVE TEST · what the owner search actually does now the failure envelope is read correctly.
 *
 * Runs the REAL fixed client against REAL companies from the curated pool and instruments every
 * stage, so the answer to "can we find the hiring manager" is measured rather than argued:
 *
 *   call outcome        people / empty / ratelimit / apifail   <- was previously all collapsed to "empty"
 *   people returned     how many humans the API actually gave us
 *   survive company     the headline must contain the company name (squashed)
 *   survive function    dmFunction(title) must equal the req's function
 *   survive the gate    assessProspect must not reject the person
 *
 * Each stage that eats people is a different fix, and until now every one of them was invisible
 * behind a single `no_name`.
 *
 *   node tools/diag-owner-live.mjs [--limit 12]
 */

import { readFileSync } from "node:fs";
import { assessProspect, roleFamily, roleFunctionGroup, dmFunction } from "/tools/gates.mjs";
import { targetFor } from "/tools/orgchart.mjs";
import { searchPeople, peopleApiFrom, companyMatches } from "/tools/peopleapi.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const CREDS = process.env.MPC_CREDS_FILE || "/data/snap_integration_credentials_v1.json";
const SIZE_SNAP = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
const LUME_WS = "ws_mqf6o989003";
const LIMIT = Number(process.argv[process.argv.indexOf("--limit") + 1] || 12);
// Paced for a PER-MINUTE plan limit: this is the constraint, not the monthly quota.
const PACE = Number(process.argv[process.argv.indexOf("--pace") + 1] || 7000);

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const sizeRaw = (() => { try { return JSON.parse(readFileSync(SIZE_SNAP, "utf8")); } catch { return {}; } })();
const sizeMap = sizeRaw.companies || sizeRaw.data || sizeRaw;
const headcountOf = (c) => { const e = sizeMap[String(c || "").toLowerCase().trim()]; return e && e.count > 0 ? e.count : null; };

const rows = (() => {
  const j = JSON.parse(readFileSync(CURATION, "utf8"));
  return (Array.isArray(j) ? j : (j.rows || j.prospects || [])).map((r) => r.lead || r);
})();

// Real work: in-band companies whose row is currently held for a decision-maker reason. These are
// exactly the rows the owner search exists to rescue.
const jobs = [];
const seen = new Set();
for (const p of rows) {
  if (!p.company || !p.role || !p.domain) continue;
  const head = headcountOf(p.company);
  if (!(head && head >= 100 && head <= 2500)) continue;
  const fn = roleFunctionGroup(roleFamily(p.role));
  if (fn === "Other") continue;
  const key = `${p.company}|${fn}`;
  if (seen.has(key)) continue;
  const res = assessProspect({ ...p, employeeCount: head });
  if (res.eligible) continue;
  if (!res.failures.some((f) => /decision-maker|no named decision-maker|different company|core band/.test(f))) continue;
  seen.add(key);
  jobs.push({ company: p.company, fn, head, sample: { ...p, employeeCount: head } });
  if (jobs.length >= LIMIT) break;
}

console.log(`LIVE OWNER SEARCH TEST\n${"=".repeat(78)}`);
console.log(`${jobs.length} in-band companies whose rows are held on a decision-maker reason\n`);

const api = peopleApiFrom(JSON.parse(readFileSync(CREDS, "utf8")), LUME_WS);
const kinds = {};
const stage = { returned: 0, company: 0, fn: 0, gate: 0, elig: 0 };
const found = [];
const dropExamples = [];
let remaining = null;

for (const job of jobs) {
  const band = targetFor({ role: job.sample.role, functionGroup: job.fn, headcount: job.head });
  const hunt = band.titles[0] || job.fn;
  const q = `${hunt} ${job.company}`;
  await new Promise(r => setTimeout(r, PACE));
  const r = await searchPeople(api, q, { attempts: 4, baseDelayMs: 20000 });
  kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  if (Number.isFinite(r.remaining)) remaining = r.remaining;

  if (r.kind !== "people" && r.kind !== "empty") {
    console.log(`  ${r.kind.toUpperCase().padEnd(10)} ${q}`);
    continue;
  }
  stage.returned += r.people.length;

  const coSq = squash(job.company);
  let co = 0, fnOk = 0, gate = 0, elig = 0, hitName = "";
  for (const h of r.people) {
    if (!companyMatches(job.company, h.headline)) {
      if (dropExamples.length < 10) dropExamples.push(`company-filter  "${h.headline.slice(0, 62)}"  (wanted ${job.company})`);
      continue;
    }
    co++;
    const title = h.headline.split("|")[0].trim().slice(0, 90);
    const dmFn = dmFunction(title);
    if (dmFn !== job.fn) {
      if (dropExamples.length < 10) dropExamples.push(`function-filter "${title.slice(0, 50)}" reads ${dmFn || "null"}, wanted ${job.fn}`);
      continue;
    }
    fnOk++;
    const probe = assessProspect({ ...job.sample, managerName: h.fullName, managerTitle: title, likelyEmail: `x.y@${job.sample.domain}`, emailValidated: true, emailInvalid: false, emailCatchAll: false });
    const bad = probe.failures.find((x) => /decision-maker|different company|core band|org chart/.test(x));
    if (bad) {
      if (dropExamples.length < 10) dropExamples.push(`buyer-rules     "${title.slice(0, 44)}" -> ${bad.slice(0, 60)}`);
      continue;
    }
    gate++;
    // PRODUCTION now demands FULL eligibility before spending a Reoon credit (the stricter probe
    // from the 18:36 box commit), so report that separately: it is the number that decides whether
    // a hunt actually converts into a contactable person.
    if (probe.eligible) { elig++; if (!hitName) hitName = `${h.fullName} (${title})`; }
    else if (dropExamples.length < 10) dropExamples.push(`full-gate       "${title.slice(0, 40)}" -> ${(probe.failures[0]||"").slice(0, 58)}`);
  }
  stage.company += co; stage.fn += fnOk; stage.gate += gate; stage.elig += elig;
  console.log(`  ${String(r.people.length).padStart(2)} people -> ${co} co -> ${fnOk} fn -> ${gate} gate  | ${q}${hitName ? `  => ${hitName}` : ""}`);
  if (hitName) found.push(`${job.company}: ${hitName}`);
}

console.log(`\n${"=".repeat(78)}\nCALL OUTCOMES  ${JSON.stringify(kinds)}`);
const answered = (kinds.people || 0) + (kinds.empty || 0);
const refused = jobs.length - answered;
console.log(`  answered by the API : ${answered} of ${jobs.length}`);
console.log(`  refused (retry, not a verdict): ${refused}   <- these used to be written as "no owner exists"`);
console.log(`\nFUNNEL over the ${answered} answered`);
console.log(`  people returned   ${stage.returned}`);
console.log(`  survive company   ${stage.company}`);
console.log(`  survive function  ${stage.fn}`);
console.log(`  pass buyer rules  ${stage.gate}`);
console.log(`  FULLY eligible    ${stage.elig}   <- what production will spend a credit on`);
console.log(`  owners named      ${found.length} of ${answered} answered  (${answered ? Math.round((found.length / answered) * 100) : 0}%)`);
if (remaining != null) console.log(`\nAPI quota remaining: ${remaining}`);
if (found.length) { console.log(`\nOWNERS FOUND:`); for (const f of found) console.log("  " + f); }
if (dropExamples.length) { console.log(`\nWHERE PEOPLE WERE DROPPED:`); for (const d of dropExamples) console.log("  " + d); }
