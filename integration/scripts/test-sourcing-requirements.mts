/**
 * Regression suite for requirement matching and the domain component of the scorer.
 *
 *   npx tsx scripts/test-sourcing-requirements.mts     (from integration/)
 *
 * Every requirement string below is a VERBATIM mustHave/niceToHave value taken off the
 * desk's real production runs on 2026-08-07. That matters: the bug was invisible to a
 * unit test written against tidy invented inputs like "CPA", because "CPA" happens to
 * phrase-match fine. It only appears against the sentences the JD parser actually emits.
 */

import { requirementTerms, requirementMet, requirementCoverage, shortenRequirement } from "../lib/sourcing/requirements";
import { scoreCandidate } from "../lib/sourcing/score";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error("  FAIL:", name); }
}

/* --- real production requirement strings ---------------------------------- */

const POWER_BI = "Hands-on Power BI development including report/dashboard authoring, DAX, and data modeling";
const ADF = "Hands-on Azure Data Factory experience building and managing ETL/ELT pipelines";
const NETSUITE = "Active, hands-on NetSuite experience (not legacy-only ERP)";
const CLOSE = "Ownership of month-end or year-end close process";
const JD_LAW = "J.D. from an accredited law school";
const CLOSING = "Proven track record of personally closing new business (individual contributor selling)";
const ASC606 = "Revenue recognition experience (ASC 606)";
const P21 = "ERP system experience (any platform — Epicor P21 / Prophet 21 strongly preferred)";

/* --- term extraction ------------------------------------------------------ */

const pbiTerms = requirementTerms(POWER_BI);
check("Power BI requirement yields terms", pbiTerms.length > 0);
check("Power BI requirement yields the pair 'power bi'", pbiTerms.includes("power bi"));
check("Power BI requirement yields 'dax'", pbiTerms.includes("dax"));
check("filler word 'experience' is never a term", !requirementTerms(ADF).includes("experience"));
check("filler word 'hands' is never a term", !pbiTerms.includes("hands"));
check("filler word 'proven' is never a term", !requirementTerms(CLOSING).includes("proven"));
check("filler word 'track' is never a term", !requirementTerms(CLOSING).includes("track"));
check("'netsuite' survives extraction", requirementTerms(NETSUITE).includes("netsuite"));
check("'azure data' pair survives extraction", requirementTerms(ADF).includes("azure data"));
check("a bare number is never a lone term", !requirementTerms(ASC606).includes("606"));
check("'asc 606' survives as a pair", requirementTerms(ASC606).includes("asc 606"));
check("term list is capped so a wordy requirement gets no extra shots", requirementTerms(P21).length <= 12);
check("empty requirement yields nothing", requirementTerms("").length === 0);
check("a requirement of pure filler yields nothing", requirementTerms("Proven experience and strong skills").length === 0);

/* --- THE BUG: whole-sentence matching could never fire --------------------- */

const REAL_HEADLINE = "Senior Data Analyst at Contoso | Power BI, DAX, Azure Data Factory";
// The old scorer did the equivalent of this, and it is false for every real profile.
const wholeSentenceHit = (" " + REAL_HEADLINE.toLowerCase() + " ").includes(" " + POWER_BI.toLowerCase() + " ");
check("REGRESSION: whole-sentence matching does NOT fire on a real headline", !wholeSentenceHit);
check("term-based matching DOES fire on the same headline", requirementMet(REAL_HEADLINE, POWER_BI));
check("term-based matching fires for the second requirement too", requirementMet(REAL_HEADLINE, ADF));

const ACCOUNTANT = "Accounting Manager at Acme | NetSuite, month-end close, ASC 606";
check("NetSuite requirement met", requirementMet(ACCOUNTANT, NETSUITE));
check("close-process requirement met", requirementMet(ACCOUNTANT, CLOSE));
check("ASC 606 requirement met", requirementMet(ACCOUNTANT, ASC606));
check("an unrelated requirement is NOT met", !requirementMet(ACCOUNTANT, JD_LAW));
check("a lawyer requirement does not match an accountant", !requirementMet(ACCOUNTANT, CLOSING));

/* --- coverage counts, it does not stop at the first hit -------------------- */

const three = [POWER_BI, ADF, NETSUITE];
const one = requirementCoverage("Data Analyst | Power BI reporting", three);
const two = requirementCoverage(REAL_HEADLINE, three);
check("one-of-three counted as 1", one.met === 1);
check("two-of-three counted as 2", two.met === 2);
check("total is reported", two.total === 3);
check("REGRESSION: two-of-three outranks one-of-three", two.ratio > one.ratio);
check("ratio is 0..1", two.ratio > 0 && two.ratio <= 1);
check("matched requirements are returned for the reason line", two.matched.length === 2);
check("nothing matched gives ratio 0", requirementCoverage("Chef at a bakery", three).ratio === 0);
check("empty requirement list is assessable-as-nothing", requirementCoverage(REAL_HEADLINE, []).total === 0);
check("a list of pure filler is not assessable", requirementCoverage(REAL_HEADLINE, ["Strong experience"]).total === 0);

/* --- reason line copy ----------------------------------------------------- */

check("short requirement is left alone", shortenRequirement("CPA license") === "CPA license");
const short = shortenRequirement(POWER_BI);
check("long requirement is shortened", short.length <= 46);
check("shortening ends on a word boundary", !/\s\w{1,3}\.\.\.$/.test(short) || short.endsWith("..."));
check("no em-dash introduced by shortening", !shortenRequirement(P21).includes("—") || P21.includes("—"));

/* --- end to end through the real scorer ----------------------------------- */

function icp(over: Partial<CandidateICP> = {}): CandidateICP {
  return {
    label: "Data Analyst", seniority: "ic", titles: ["Data Analyst"], industries: [],
    targetCompanies: [], geos: [], mustHave: [], niceToHave: [], disqualifiers: [],
    managesTeam: false, remoteOk: true, ...over,
  } as CandidateICP;
}
function row(headline: string): CandidateRow {
  return { fullName: "A Person", title: "Data Analyst", headline, fitScore: 0, fitReasons: [] } as CandidateRow;
}

const noReqs = scoreCandidate(row(REAL_HEADLINE), icp());
const withReqs = scoreCandidate(row(REAL_HEADLINE), icp({ mustHave: [POWER_BI, ADF] }));
check("REGRESSION: meeting the must-haves now scores HIGHER than having none stated",
  withReqs.fitScore > noReqs.fitScore);
check("the reason line names the coverage", withReqs.fitReasons.some((r) => /must-have/i.test(r)));

const metOne = scoreCandidate(row("Data Analyst | Power BI"), icp({ mustHave: [POWER_BI, ADF, NETSUITE] }));
const metAll = scoreCandidate(row("Data Analyst | Power BI, DAX, Azure Data Factory, NetSuite"),
  icp({ mustHave: [POWER_BI, ADF, NETSUITE] }));
check("REGRESSION: meeting all must-haves beats meeting one", metAll.fitScore > metOne.fitScore);
check("meeting one still scores something (floor)", metOne.fitScore > noReqs.fitScore);

// The domain component must stay inside its 15-point budget however many requirements hit.
const manyReqs = icp({ mustHave: [POWER_BI, ADF, NETSUITE], niceToHave: [ASC606, CLOSE, P21], industries: ["data"] });
const loaded = scoreCandidate(
  row("Data Analyst | Power BI DAX Azure Data Factory NetSuite ASC 606 month-end close Epicor P21 data"),
  manyReqs,
);
check("a fully-loaded profile never exceeds 100", loaded.fitScore <= 100);
const baseline = scoreCandidate(row("Data Analyst"), icp());
check("domain component stays within its 15-point budget", loaded.fitScore - baseline.fitScore <= 15 + 24 + 1);

// Someone in the wrong role family must not be floated by requirement keywords alone.
const wrongRole = scoreCandidate(
  { fullName: "B", title: "Truck Driver", headline: "Truck Driver | Power BI hobbyist", fitScore: 0, fitReasons: [] } as CandidateRow,
  icp({ mustHave: [POWER_BI] }),
);
check("a wrong-role person with a keyword still scores below the outreach bar", wrongRole.fitScore < 45);

console.log(`\nrequirements suite: ${passed}/${passed + failed} checks passed`);
if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
console.log("all green");
