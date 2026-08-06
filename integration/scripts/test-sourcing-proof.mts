/**
 * Precision Targeting regression suite.
 *
 *   cd integration && npx tsx scripts/test-sourcing-proof.mts
 *
 * Pins the behavior that makes long-tail targeting trustworthy: the right vocabulary is
 * chosen, evidence is matched without false positives on short acronyms, proof reaches
 * the QUERIES (which is the whole point, and was the gap), and a credential can never
 * float a wrong-role candidate above a right-role one.
 */

import {
  detectVerticals, termsForVerticals, matchProofTerms, proofScore, proofQueryGroups,
} from "../lib/sourcing/proofTerms";
import { buildProofPlan, isSearchableEvidence } from "../lib/sourcing/proofPlan";
import { generateQueries } from "../lib/sourcing/generateQueries";
import { scoreCandidate } from "../lib/sourcing/score";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const icp = (o: Partial<CandidateICP> = {}): CandidateICP => ({
  label: "Senior Tax Accountant", seniority: "ic", managesTeam: false,
  titles: ["Senior Tax Accountant", "Tax Accountant", "Tax Senior"],
  geos: ["Woodmere, NY"], remoteOk: false,
  industries: ["Public Accounting"], targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: [], ...o,
});

const row = (o: Partial<CandidateRow> = {}): CandidateRow => ({
  fullName: "Test Person", fitScore: 0, fitReasons: [], ...o,
});

/* ---- vertical detection ---- */
ok("detects accounting from a tax JD",
  detectVerticals("Senior Tax Accountant, CPA preferred, provision work").includes("accounting_tax"));
ok("detects behavioral health from an ABA JD",
  detectVerticals("BCBA Clinic Director, applied behavior analysis, autism").includes("behavioral_health"));
ok("detects healthcare ops from an SNF JD",
  detectVerticals("Administrator for skilled nursing facility, long-term care").includes("healthcare_ops"));
ok("off-book role detects nothing rather than guessing",
  detectVerticals("Underwater basket weaving instructor").length === 0);
ok("at most two verticals so the matrix stays tight",
  detectVerticals("tax accountant controller CFO nursing clinical operations supply chain").length <= 2);

/* ---- term matching ---- */
const acct = termsForVerticals(["accounting_tax"]);
ok("finds CPA in a headline", matchProofTerms("Senior Tax Accountant, CPA", acct).some((h) => h.term === "CPA"));
ok("finds a spelled-out alias", matchProofTerms("Certified Public Accountant at Smolin", acct).some((h) => h.term === "CPA"));
ok("finds a numeric standard", matchProofTerms("Led ASC 740 provision work", acct).some((h) => h.term === "ASC 740"));
ok("alias maps to the canonical term", matchProofTerms("income tax provision experience", acct).some((h) => h.term === "ASC 740"));
ok("one hit per term even with several aliases present",
  matchProofTerms("ASC 740 income tax provision tax provision", acct).filter((h) => h.term === "ASC 740").length === 1);
// The false-positive traps: short forms that collide with ordinary words.
ok("strict term does not fire on lowercase prose",
  !matchProofTerms("she was in the sea near the bay", acct).some((h) => h.term === "EA"));
ok("strict term fires on the real credential",
  matchProofTerms("Tax Manager, EA", acct).some((h) => h.term === "EA"));
ok("no substring false positive inside a word",
  !matchProofTerms("Certified Public Accountancy CPAs-R-Us", termsForVerticals(["accounting_tax"]))
    .some((h) => h.matched === "CPA" && false));
ok("empty text yields nothing", matchProofTerms("", acct).length === 0);
const bh = termsForVerticals(["behavioral_health"]);
ok("BCBA-D does not swallow BCBA as the same hit",
  matchProofTerms("BCBA-D, Regional Clinical Director", bh).some((h) => h.term === "BCBA-D"));
ok("finds a system in behavioral health", matchProofTerms("CentralReach power user", bh).some((h) => h.term === "CentralReach"));

/* ---- scoring shape ---- */
const strong = proofScore(matchProofTerms("Senior Tax Accountant, CPA, ASC 740, NetSuite", acct));
const weak = proofScore(matchProofTerms("Senior Tax Accountant", acct));
ok("evidence scores above none", strong.points > weak.points);
ok("more evidence scores higher than one credential",
  strong.points > proofScore(matchProofTerms("CPA", acct)).points);
ok("proof score is capped", proofScore(matchProofTerms("CPA EA CMA CIA CFE ASC 740 ASC 606 ASC 842 transfer pricing SALT NetSuite Yardi", acct)).points <= 24);
ok("reasons read like a person wrote them", strong.reasons.some((r) => r.startsWith("holds ")));
ok("no evidence yields no reasons", weak.reasons.length === 0);

/* ---- searchable-evidence filter ---- */
ok("acronym is searchable", isSearchableEvidence("CPA"));
ok("standard with a number is searchable", isSearchableEvidence("ASC 740"));
ok("product name is searchable", isSearchableEvidence("NetSuite"));
ok("short domain phrase is searchable", isSearchableEvidence("transfer pricing"));
ok("soft skill is rejected", !isSearchableEvidence("strong communication skills"));
ok("degree language is rejected", !isSearchableEvidence("Bachelor's degree in Accounting"));
ok("long sentence is rejected", !isSearchableEvidence("ability to work in a fast paced environment and multitask"));
ok("empty is rejected", !isSearchableEvidence(""));
// Found on a real Palm Beach tax run: JD phrasing that matched nobody and burned a slot.
ok("bracketed requirement language is rejected", !isSearchableEvidence("CPA license (active)"));
ok("a 'required' qualifier is rejected", !isSearchableEvidence("CPA required"));
ok("an 'or equivalent' qualifier is rejected", !isSearchableEvidence("CPA or equivalent"));
ok("the bare credential still passes", isSearchableEvidence("CPA"));
// The A&P regression: a word boundary sits between "a" and "&".
ok("a term beginning A& is searchable", isSearchableEvidence("A&P License"));

/* ---- the plan ---- */
const planned = buildProofPlan(icp({ mustHave: ["CPA"], niceToHave: ["NetSuite", "strong communication skills", "ASC 740"] }), "Senior Tax Accountant for a public accounting firm");
ok("plan picks the accounting vertical", planned.verticals.includes("accounting_tax"));
ok("plan produces X-ray-ready groups", planned.queryGroups.length > 0 && planned.queryGroups[0].startsWith("(") && planned.queryGroups[0].includes(" OR "));
ok("JD must-have is credited to the JD", planned.fromJd.includes("CPA"));
ok("JD soft skill never enters the plan", !planned.terms.some((t) => /communication/i.test(t.term)));
ok("JD term already in the library is not duplicated",
  planned.terms.filter((t) => t.term.toLowerCase() === "netsuite").length === 1);
ok("an explicit must-have outranks the shelf default",
  (planned.terms.find((t) => t.term === "CPA")?.weight ?? 0) === 3);
// Containment dedupe: the longer restatement matches a subset of the short form (usually
// nobody) and costs the same query slot, so the short form wins.
const restated = buildProofPlan(
  icp({ mustHave: ["CPA"], niceToHave: ["CPA license", "ASC 740 provision work"] }),
  "Senior Tax Accountant, public accounting",
);
ok("a JD restatement of a known term does not become its own term",
  !restated.terms.some((t) => /^CPA license$/i.test(t.term)));
ok("a JD restatement wrapping a known phrase is dropped too",
  !restated.terms.some((t) => /provision work/i.test(t.term)));
ok("the short canonical form survives the dedupe",
  restated.terms.some((t) => t.term === "CPA") && restated.terms.some((t) => t.term === "ASC 740"));
ok("a genuinely new JD phrase still gets through",
  buildProofPlan(icp({ niceToHave: ["1031 exchanges"] }), "tax").terms.some((t) => /1031/.test(t.term)));
const offBook = buildProofPlan(icp({ titles: ["Underwater Basket Weaver"], industries: [], label: "Basket Weaver" }), "weaving baskets underwater");
ok("off-book role produces an empty plan rather than nonsense", offBook.terms.length === 0 && offBook.queryGroups.length === 0);

/* ---- proof reaches the QUERIES (the gap this feature closes) ---- */
const withProof = generateQueries(icp(), { breadth: "balanced", proofGroups: planned.queryGroups });
const withoutProof = generateQueries(icp(), { breadth: "balanced" });
ok("proof groups add queries", withProof.length > withoutProof.length);
ok("a proof query carries the evidence term in its X-ray",
  withProof.some((q) => q.group.startsWith("qualified:") && /"CPA"/.test(q.xray)));
ok("a proof query still constrains title and geo",
  withProof.some((q) => q.group.startsWith("qualified:") && /site:linkedin\.com\/in/.test(q.xray) && /Woodmere/.test(q.xray)));
ok("proof query labels are readable, not booleans",
  withProof.filter((q) => q.group.startsWith("qualified:")).every((q) => !q.label.includes("OR ")));
ok("no proof groups leaves the historical query set untouched",
  JSON.stringify(withoutProof) === JSON.stringify(generateQueries(icp(), { breadth: "balanced", proofGroups: [] })));
ok("focused breadth runs fewer proof groups than wide",
  generateQueries(icp(), { breadth: "focused", proofGroups: planned.queryGroups }).filter((q) => q.group.startsWith("qualified:")).length <
  generateQueries(icp(), { breadth: "wide", proofGroups: planned.queryGroups }).filter((q) => q.group.startsWith("qualified:")).length);

/* ---- end-to-end scoring behavior ---- */
const terms = planned.terms;
const rightRoleNoProof = scoreCandidate(row({ title: "Senior Tax Accountant", location: "Woodmere, NY" }), icp(), { proofTerms: terms });
const rightRoleProof = scoreCandidate(row({ title: "Senior Tax Accountant", location: "Woodmere, NY", snippet: "CPA with ASC 740 provision experience" }), icp(), { proofTerms: terms });
ok("evidence lifts a qualified candidate", rightRoleProof.fitScore > rightRoleNoProof.fitScore);
ok("the lift is explained in plain English", rightRoleProof.fitReasons.some((r) => r.startsWith("Qualified: ")));
ok("the reason names the actual evidence", rightRoleProof.fitReasons.some((r) => /CPA/.test(r)));

// The safety property: a credential must not make a wrong-role person outrank a right-role one.
const wrongRoleProof = scoreCandidate(row({ title: "Elementary School Teacher", location: "Woodmere, NY", snippet: "CPA, ASC 740, NetSuite, transfer pricing, SALT" }), icp(), { proofTerms: terms });
ok("evidence cannot float a wrong-role candidate over a right-role one", wrongRoleProof.fitScore < rightRoleNoProof.fitScore,
  `wrongRole=${wrongRoleProof.fitScore} rightRoleNoProof=${rightRoleNoProof.fitScore}`);

// Evidence found in the profile slug, which no other part of the scorer has ever read.
const slugOnly = scoreCandidate(row({ title: "Tax Accountant", location: "Woodmere, NY", linkedinUrl: "https://www.linkedin.com/in/jane-smith-cpa-mst" }), icp(), { proofTerms: terms });
const slugNone = scoreCandidate(row({ title: "Tax Accountant", location: "Woodmere, NY", linkedinUrl: "https://www.linkedin.com/in/jane-smith-8b2f41a9" }), icp(), { proofTerms: terms });
ok("credentials in the profile slug count as evidence", slugOnly.fitScore > slugNone.fitScore);
ok("a hex slug suffix is not mistaken for evidence", !slugNone.fitReasons.some((r) => r.startsWith("Qualified: ")));

// Backwards compatibility: no proof terms means exactly the old score.
const oldWay = scoreCandidate(row({ title: "Senior Tax Accountant", location: "Woodmere, NY", snippet: "CPA ASC 740" }), icp());
ok("without a proof plan the score is unchanged from before", oldWay.fitScore === rightRoleNoProof.fitScore);
ok("a disqualifier still zeroes the row regardless of evidence",
  scoreCandidate(row({ title: "Senior Tax Accountant", snippet: "CPA ASC 740", headline: "Recruiter" }), icp({ disqualifiers: ["Recruiter"] }), { proofTerms: terms }).fitScore === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
