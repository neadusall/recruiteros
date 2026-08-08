/* Matched self-test: Hire Signals (job feed) vs News feed, same cap, same night.
 *
 * Answers the only question that matters before a weekend scrape: if I ask each front
 * end for N companies, how many do I actually get, and how many of those are CURATABLE
 * (named company + at least one role, which is what curateFromPool requires to find a
 * decision-maker)? A lead that is not curatable never becomes an email, so raw discovery
 * counts flatter both arms.
 *
 * Run:  npx tsx scripts/selftest-arms.mts
 * Retarget without editing: SEGMENTS="a,b" JOB_QUERIES="VP Ops" CAP=200 npx tsx ...
 */
import { readFileSync } from "node:fs";
import { discoverFromNews, type NewsSignal } from "../lib/signals/watch/newsDiscover";
import { previewJobFeed, jobFeedEnabled } from "../lib/inmarket/jobFeed";
import { companyKey } from "../lib/inmarket/jobFeed";
import type { InMarketLead } from "../lib/inmarket";

/* A bare tsx script gets none of Next's env loading, and the job feed answers an
 * unconfigured key with an empty list rather than an error. Without this the whole
 * paid arm reports a clean, believable zero. Load .env.local, then refuse to run. */
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* env file optional — the guard below is what actually enforces this */ }
if (!jobFeedEnabled()) {
  console.error("ABORT: job feed not configured (RAPID_JOBS_KEY / RAPID_JOBS_HOST missing).\n" +
    "The paid arm would report 0 companies with no error, which is indistinguishable from a quiet market.");
  process.exit(1);
}

const CAP = Number(process.env.CAP || 200);
const SEGMENTS = (process.env.SEGMENTS || "supply chain software,logistics technology,warehouse automation,freight technology")
  .split(",").map((s) => s.trim()).filter(Boolean);
const JOB_QUERIES = (process.env.JOB_QUERIES || "VP of Operations,Director of Supply Chain,Warehouse Manager")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SIGNALS = (process.env.NEWS_SIGNALS || "funding_round,exec_hire,office_expansion,acquisition")
  .split(",").map((s) => s.trim()) as NewsSignal[];
const WINDOW = Number(process.env.WINDOW_DAYS || 7);

const curatable = (l: InMarketLead) => !!(l.company || "").trim() && (l.roles ?? []).length > 0;

function stats(label: string, leads: InMarketLead[], extra: Record<string, unknown>) {
  const keys = new Set(leads.map((l) => companyKey(l.company || "")));
  const ok = leads.filter(curatable);
  const scores = leads.map((l) => Number(l.score) || 0).sort((a, b) => b - a);
  const med = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  const withDomain = leads.filter((l) => !!l.domain).length;
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify({
    ...extra,
    leads: leads.length,
    distinctCompanies: keys.size,
    curatable: ok.length,
    curatablePct: leads.length ? +((ok.length / leads.length) * 100).toFixed(1) : 0,
    withDomain,
    scoreMax: scores[0] ?? 0,
    scoreMedian: med,
    rolesPerLead: leads.length ? +(leads.reduce((s, l) => s + (l.roles?.length || 0), 0) / leads.length).toFixed(2) : 0,
  }, null, 2));
  console.log("  top 8:");
  for (const l of leads.slice(0, 8)) {
    console.log(`   [${String(l.score).padStart(3)}] ${l.company}  ${l.domain ? "(" + l.domain + ")" : "(no domain yet)"}`);
    console.log(`         ${(l.reason || "").slice(0, 130)}`);
    console.log(`         roles: ${(l.roles ?? []).join(", ") || "NONE — would be dropped by curateFromPool"}`);
  }
  return keys;
}

/* ---------------- NEWS ARM ---------------- */
const perSeg = Math.ceil(CAP / SEGMENTS.length);
const newsLeads: InMarketLead[] = [];
let queries = 0, headlines = 0, named = 0;
const newsWarn: string[] = [];
const t0 = Date.now();
for (const segment of SEGMENTS) {
  const r = await discoverFromNews({ segment, signals: SIGNALS, windowDays: WINDOW, limit: perSeg, timeboxMs: 60_000 });
  queries += r.queries; headlines += r.headlines; named += r.named;
  if (r.warnings.length) newsWarn.push(`${segment}: ${r.warnings.join("; ")}`);
  newsLeads.push(...r.leads);
  console.log(`  news/${segment}: queries=${r.queries} headlines=${r.headlines} named=${r.named} leads=${r.leads.length}`);
}
const newsMs = Date.now() - t0;
const newsKeys = stats("NEWS FEED (Google News RSS, $0)", newsLeads, {
  segments: SEGMENTS, signals: SIGNALS, windowDays: WINDOW,
  feedsPulled: queries, headlinesSeen: headlines, headlinesNamed: named,
  namedPct: headlines ? +((named / headlines) * 100).toFixed(1) : 0,
  elapsedSec: +(newsMs / 1000).toFixed(1), warnings: newsWarn,
});

/* ---------------- JOB ARM ---------------- */
const perQ = Math.ceil(CAP / JOB_QUERIES.length);
const jobLeads: InMarketLead[] = [];
let jobsSeen = 0;
const jobWarn: string[] = [];
const t1 = Date.now();
for (const query of JOB_QUERIES) {
  try {
    const r = await previewJobFeed({ query, datePosted: "week", limit: perQ });
    jobsSeen += r.jobs;
    jobLeads.push(...r.leads);
    console.log(`  jobs/${query}: companies=${r.companies} jobs=${r.jobs}`);
  } catch (e) {
    jobWarn.push(`${query}: ${(e as Error).message}`);
    console.log(`  jobs/${query}: FAILED ${(e as Error).message}`);
  }
}
const jobMs = Date.now() - t1;
const jobKeys = stats("HIRE SIGNALS (JSearch job feed, paid)", jobLeads, {
  queries: JOB_QUERIES, datePosted: "week",
  jobPostingsSeen: jobsSeen, elapsedSec: +(jobMs / 1000).toFixed(1), warnings: jobWarn,
});

/* ---------------- OVERLAP ---------------- */
const overlap = [...newsKeys].filter((k) => k && jobKeys.has(k));
console.log(`\n===== OVERLAP (the pitch-once guarantee) =====`);
console.log(JSON.stringify({
  newsOnly: newsKeys.size - overlap.length,
  jobsOnly: jobKeys.size - overlap.length,
  inBoth: overlap.length,
  note: "companies in both are ONE company to the seen set — first arm to touch keeps attribution",
  examples: overlap.slice(0, 5),
}, null, 2));
