// RecruitersOS · MPC · LinkedIn URL resolver for contacted leads.
//
// Every lead we email should carry the decision-maker's LinkedIn URL (for the video follow-up +
// per-recruiter connect later in the week). The curation store records HOW a manager was found
// (managerVia) but never persists a profile URL, so this resolves them after the fact: for each
// SENT prospect without a URL yet, ONE people-search call (name + company), strict name match,
// result appended to /out/leads-linkedin.jsonl. Idempotent: found and no_match outcomes are final
// (never re-spend quota on the same lead); transient errors are retried on the next run.
//
//   node tools/linkedin-resolve.mjs              # resolve up to the per-run cap
//   MPC_LI_PER_RUN=100 node tools/linkedin-resolve.mjs
//
// Quota guard: per-run cap (default 60) + daily attempts cap (default 500) against the shared
// fresh-linkedin-scraper 20k/mo pool, + abort after 5 consecutive API errors.

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { searchPeople as apiSearchPeople } from "/tools/peopleapi.mjs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const LEDGER = `${OUT}/leads-linkedin.jsonl`;
const CREDS = process.env.MPC_CREDS_FILE || "/data/snap_integration_credentials_v1.json";
const LUME_WS = "ws_mqf6o989003";
const PER_RUN = Number(process.env.MPC_LI_PER_RUN || 60);
const DAILY = Number(process.env.MPC_LI_DAILY || 500);

function peopleApi() {
  const s = JSON.parse(readFileSync(CREDS, "utf8"));
  const k = (((s[LUME_WS] || {}).integrations || {}).jd_sourcing || {}).keys || {};
  if (!k.RAPIDAPI_KEY || !k.RAPIDAPI_PEOPLE_SEARCH_HOST) throw new Error("people API creds missing");
  return { key: k.RAPIDAPI_KEY, host: k.RAPIDAPI_PEOPLE_SEARCH_HOST, path: k.RAPIDAPI_PEOPLE_SEARCH_PATH || "/api/v1/search/people?name={query}&page={page}&limit=10" };
}

function sentLeads() {
  const rows = new Map();
  if (!existsSync(OUT)) return rows;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (r && r.to_email && r.result && r.result.ok && !rows.has(r.to_email.toLowerCase())) {
          rows.set(r.to_email.toLowerCase(), { to_email: r.to_email, to_name: r.to_name || "", to_title: r.to_title || "", company: r.company || "", role: r.role || "" });
        }
      } catch { /* skip */ }
    }
  }
  return rows;
}

function ledger() {
  const done = new Map(); let attemptsToday = 0;
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(LEDGER)) return { done, attemptsToday };
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try {
      const r = JSON.parse(s);
      if ((r.at || "").slice(0, 10) === today) attemptsToday++;
      if (r.status === "found" || r.status === "no_match") done.set(String(r.to_email).toLowerCase(), r);
    } catch { /* skip */ }
  }
  return { done, attemptsToday };
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

// The person is a match only when every part of the name we emailed appears in the candidate's
// name (order-free). Loose company echo is a bonus, never a requirement (titles/companies drift).
function nameMatches(wanted, got) {
  const w = norm(wanted).split(" ").filter(Boolean);
  const g = " " + norm(got) + " ";
  return w.length >= 2 && w.every((part) => g.includes(" " + part + " "));
}

function extractPeople(json) {
  const found = [];
  const walk = (o) => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (!o || typeof o !== "object") return;
    const url = o.url || o.linkedin_url || o.profile_url || o.public_profile_url || o.profileURL || "";
    const name = o.full_name || o.fullName || o.name || [o.first_name, o.last_name].filter(Boolean).join(" ");
    if (url && /linkedin\.com\/in\//i.test(url) && name) found.push({ name, url });
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return found;
}

// Emails of people who WATCHED their video: resolve these first so the auto-connect can fire on the
// very next tick, instead of waiting behind the whole contacted backlog.
function watcherEmails() {
  try {
    const s = JSON.parse(readFileSync((process.env.MPC_DATA_DIR || "/data") + "/snap_mpc_watchers_v1.json", "utf8"));
    return new Set((s.watchers || []).map((w) => String(w.email || "").toLowerCase()));
  } catch { return new Set(); }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const api = peopleApi();
  const leads = sentLeads();
  const { done, attemptsToday } = ledger();
  const watchers = watcherEmails();
  const pending = [...leads.values()]
    .filter((l) => l.to_name && !done.has(l.to_email.toLowerCase()))
    // Watchers to the front: engaged prospects get their profile (and their connection request) first.
    .sort((a, b) => (watchers.has(b.to_email.toLowerCase()) ? 1 : 0) - (watchers.has(a.to_email.toLowerCase()) ? 1 : 0));
  const budget = Math.min(PER_RUN, Math.max(0, DAILY - attemptsToday), pending.length);
  console.log(`[linkedin] contacted leads: ${leads.size} | resolved/final: ${done.size} | pending: ${pending.length} | today's attempts: ${attemptsToday}/${DAILY} | this run: ${budget}`);
  if (!budget) return;

  let errors = 0, found = 0, misses = 0;
  for (const lead of pending.slice(0, budget)) {
    if (errors >= 5) { console.log("[linkedin] 5 consecutive API errors; stopping this run"); break; }
    const query = `${lead.to_name} ${lead.company}`.trim();
    let row = { at: new Date().toISOString(), to_email: lead.to_email, to_name: lead.to_name, company: lead.company, role: lead.role };
    try {
      // Via the shared client (2026-08-21). This provider answers errors with HTTP 202 and
      // `success:false` in the body, so `!res.ok` never fired: a throttled call read as an empty
      // people list and was written to the ledger as `no_match`, i.e. "this person has no LinkedIn
      // profile". Only a genuine empty result is evidence about the person; everything else is
      // evidence about us, and must be retried rather than recorded.
      const r = await apiSearchPeople(api, query, { attempts: 3, baseDelayMs: 8000, timeoutMs: 20_000 });
      if (r.kind !== "people" && r.kind !== "empty") throw new Error(`${r.kind}: ${r.message || ""}`);
      errors = 0;
      const people = r.people.map((p) => ({ name: p.fullName, url: p.url, headline: p.headline }));
      const hit = people.find((p) => nameMatches(lead.to_name, p.name));
      if (hit) { row = { ...row, status: "found", linkedin_url: hit.url.split("?")[0], matched_name: hit.name }; found++; }
      else { row = { ...row, status: "no_match", candidates: people.length }; misses++; }
      appendFileSync(LEDGER, JSON.stringify(row) + "\n");
      console.log(`  ${row.status === "found" ? "FOUND" : "miss "} ${lead.to_name} @ ${lead.company}${row.linkedin_url ? " -> " + row.linkedin_url : ""}`);
    } catch (e) {
      errors++;
      console.log(`  ERROR ${lead.to_name} @ ${lead.company}: ${e.message} (will retry next run)`);
    }
    await new Promise((r) => setTimeout(r, 1100)); // stay polite on the shared quota
  }
  console.log(`[linkedin] run done: ${found} found, ${misses} no-match. Ledger: ${LEDGER}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
