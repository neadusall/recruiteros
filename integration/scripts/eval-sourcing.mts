/**
 * RecruitersOS · JD Sourcing — free eval harness
 *
 * A fixed set of JD/candidate fixtures that lock in the behavior of the two
 * deterministic, free layers of sourcing:
 *   1. scoreCandidate() — the rule-based triage scorer (score.ts)
 *   2. parseVetResult() — the deep-vet JSON parser (vetParse.ts)
 *
 * Neither calls a model or a network, so the whole suite runs in milliseconds for $0.
 * Run it after ANY change to the scorer weights or the vet prompt/parsing to catch
 * regressions before they reach a paid run:
 *
 *     npm run eval        (from integration/)
 *     # or: node scripts/eval-sourcing.mts
 *
 * Node 23.6+ runs this file directly (type stripping); the modules it imports have
 * type-only internal imports, so nothing else loads. Exits non-zero on any failure.
 *
 * Adding a case: append a block below. Keep expectations as ranges / orderings, not
 * brittle exact scores, so honest tuning doesn't trip the suite.
 */

import { scoreCandidate } from "../lib/sourcing/score.ts";
import { parseVetResult } from "../lib/sourcing/vetParse.ts";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types.ts";

/* ------------------------------------------------------------------ */
/* tiny assert harness                                                 */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; }
  else { failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* ------------------------------------------------------------------ */
/* fixture builders                                                    */
/* ------------------------------------------------------------------ */

function mkIcp(p: Partial<CandidateICP> = {}): CandidateICP {
  return {
    label: "Sourcing profile", seniority: "vp", managesTeam: true,
    titles: ["VP Sales", "CRO", "Head of Sales"], geos: ["New York"], remoteOk: true,
    industries: ["procurement"], targetCompanies: ["Coupa"], sellsTo: ["CFO"],
    verticals: [], mustHave: [], niceToHave: ["SaaS"], disqualifiers: [], ...p,
  };
}
function mkRow(p: Partial<CandidateRow> = {}): CandidateRow {
  return { fullName: "Jane Doe", fitScore: 0, fitReasons: [], ...p };
}
/** True only for a POSITIVE exact function match ("Function match: …") — not the
 *  "No function match" or "Partial function match" reasons. */
function exactFnMatch(reasons: string[]): boolean {
  return reasons.some((r) => r.startsWith("Function match"));
}
function reasonsHave(reasons: string[], needle: string): boolean {
  return reasons.some((r) => r.toLowerCase().includes(needle.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* 1. Scorer fixtures (deterministic, $0)                              */
/* ------------------------------------------------------------------ */

const salesIcp = mkIcp();

// (a) Bullseye: right function, seniority, company, and geo → high score.
{
  const r = mkRow({ title: "VP Sales", company: "Coupa", location: "New York", headline: "VP Sales at Coupa — SaaS procurement" });
  const { fitScore, fitReasons } = scoreCandidate(r, salesIcp);
  check("bullseye candidate scores high (>=80)", fitScore >= 80, `got ${fitScore}`);
  check("bullseye credits the function match", exactFnMatch(fitReasons));
}

// (b) Token boundary: a "Salesforce Administrator" must NOT match a "Sales" function.
{
  const r = mkRow({ title: "Salesforce Administrator", company: "Acme", location: "Denver" });
  const { fitReasons } = scoreCandidate(r, salesIcp);
  check("'Salesforce' does not count as 'Sales' (no function match)", !exactFnMatch(fitReasons));
}

// (c) Wrong family: "VP of Engineering" shares the word VP but not the function.
{
  const r = mkRow({ title: "VP of Engineering", company: "Acme", location: "Austin" });
  const { fitScore, fitReasons } = scoreCandidate(r, salesIcp);
  check("VP Engineering is not a function match for VP Sales", !exactFnMatch(fitReasons));
  check("VP Engineering stays modest (<55)", fitScore < 55, `got ${fitScore}`);
}

// (d) Hard disqualifier zeroes the row.
{
  const icp = mkIcp({ disqualifiers: ["agency"] });
  const r = mkRow({ title: "Recruiter", headline: "Recruiter at a staffing agency", company: "StaffCo" });
  const { fitScore, fitReasons } = scoreCandidate(r, icp);
  check("disqualifier zeroes the score", fitScore === 0, `got ${fitScore}`);
  check("disqualifier is explained", reasonsHave(fitReasons, "Disqualified"));
}

// (e) No title → can't assess; capped low even with company + geo.
{
  const r = mkRow({ company: "Coupa", location: "New York" });
  const { fitScore, fitReasons } = scoreCandidate(r, salesIcp);
  check("no-title row is capped (<=25)", fitScore <= 25, `got ${fitScore}`);
  check("no-title row says so", reasonsHave(fitReasons, "No title"));
}

// (f) Ordering: a strong candidate must outrank a weak/transient one.
{
  const strong = scoreCandidate(mkRow({ title: "VP Sales", company: "Coupa", location: "New York" }), salesIcp).fitScore;
  const weak = scoreCandidate(mkRow({ title: "Sales Intern", company: "Unknown", location: "Boise" }), salesIcp).fitScore;
  check("strong candidate outranks the intern", strong > weak, `strong=${strong} weak=${weak}`);
  check("intern hit a soft negative (low score <40)", weak < 40, `got ${weak}`);
}

// (g) Score is always a clean 0..100 integer.
{
  const { fitScore } = scoreCandidate(mkRow({ title: "VP Sales", company: "Coupa", location: "New York" }), salesIcp);
  check("score is an integer in [0,100]", Number.isInteger(fitScore) && fitScore >= 0 && fitScore <= 100, `got ${fitScore}`);
}

/* ------------------------------------------------------------------ */
/* 2. Vet-parse fixtures (deterministic, $0)                           */
/* ------------------------------------------------------------------ */

// (a) Clean JSON parses to the right fields.
{
  const v = parseVetResult(JSON.stringify({
    verifiedScore: 82, verdict: "strong", yearsRelevant: 9,
    strengths: ["ran a $40M book"], gaps: ["no public-sector exposure"], flags: [], rationale: "Strong, relevant tenure.",
  }));
  check("clean JSON: score", v.verifiedScore === 82, `got ${v.verifiedScore}`);
  check("clean JSON: verdict", v.verdict === "strong");
  check("clean JSON: years", v.yearsRelevant === 9);
  check("clean JSON: strengths", v.strengths.length === 1 && v.strengths[0] === "ran a $40M book");
}

// (b) Prose around the object is tolerated.
{
  const v = parseVetResult('Here is the verdict:\n{"verifiedScore": 60, "verdict": "possible"}\nThanks!');
  check("prose-wrapped JSON still parses", v.verifiedScore === 60 && v.verdict === "possible");
}

// (c) Out-of-range scores are clamped.
{
  check("score above 100 clamps to 100", parseVetResult('{"verifiedScore":150,"verdict":"strong"}').verifiedScore === 100);
  check("negative score clamps to 0", parseVetResult('{"verifiedScore":-20,"verdict":"no"}').verifiedScore === 0);
  check("non-numeric score → 0", parseVetResult('{"verifiedScore":"high","verdict":"weak"}').verifiedScore === 0);
}

// (d) An invalid verdict falls back to "possible".
{
  check("garbage verdict → possible", parseVetResult('{"verifiedScore":50,"verdict":"banana"}').verdict === "possible");
}

// (e) Unparseable input degrades to a flagged "no" rather than throwing.
{
  const v = parseVetResult("the model refused and wrote prose with no json");
  check("unparseable → verdict no", v.verdict === "no");
  check("unparseable → parse_error flag", v.flags.includes("parse_error"));
  check("unparseable → score 0", v.verifiedScore === 0);
}

// (f) Runaway arrays are capped (defends the UI + token budget downstream).
{
  const many = Array.from({ length: 20 }, (_, i) => `item ${i}`);
  const v = parseVetResult(JSON.stringify({ verifiedScore: 50, verdict: "possible", strengths: many, gaps: many, flags: many }));
  check("strengths capped at 8", v.strengths.length === 8, `got ${v.strengths.length}`);
  check("flags capped at 8", v.flags.length === 8, `got ${v.flags.length}`);
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length) {
  console.error(`\nJD Sourcing eval: ${passed}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error("  " + f);
  console.error("");
  process.exitCode = 1; // let Node unwind cleanly (avoid a hard exit mid-warning)
} else {
  console.log(`\nJD Sourcing eval: all ${total} checks passed ✓ (scorer + vet parser, $0)\n`);
}
