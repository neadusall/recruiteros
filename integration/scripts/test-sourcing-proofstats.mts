/**
 * Any-industry evidence layer: extraction normalizing + measured-yield regression suite.
 *
 *   cd integration && npx tsx scripts/test-sourcing-proofstats.mts
 *
 * These are the rules that let generated vocabulary be trusted without a human curating
 * it. The properties that matter: a model's guess cannot enter a query without passing
 * the same filter a JD term passes; a term nobody's profile carries gets retired on
 * evidence; a term a HUMAN asserted never does; and rarity is never mistaken for
 * uselessness, because a rare credential is the best filter there is.
 */

import { normalizeExtracted, roleSignature } from "../lib/sourcing/proofExtract";
import {
  applyTermStats, isUnbiasedRow, MIN_SAMPLE, DEAD_YIELD, SATURATED_YIELD,
} from "../lib/sourcing/proofStats";
import { buildProofPlan } from "../lib/sourcing/proofPlan";
import type { ProofTerm } from "../lib/sourcing/proofTerms";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const term = (t: string, o: Partial<ProofTerm> = {}): ProofTerm =>
  ({ term: t, kind: "domain", weight: 2, ...o });

const icp = (o: Partial<CandidateICP> = {}): CandidateICP => ({
  label: "Aircraft Maintenance Technician", seniority: "ic", managesTeam: false,
  titles: ["Aircraft Maintenance Technician", "A&P Mechanic"],
  geos: ["Dallas, TX"], remoteOk: false, industries: ["Aviation"],
  targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: [], ...o,
});

/* ---- extraction normalizing: what a model returns must survive the same gate ---- */
ok("parses a clean response",
  normalizeExtracted('{"terms":[{"term":"A&P License","kind":"credential","weight":3}]}').length === 1);
ok("strips a code fence",
  normalizeExtracted('```json\n{"terms":[{"term":"FAR Part 145","kind":"domain","weight":3}]}\n```').length === 1);
ok("survives surrounding prose",
  normalizeExtracted('Here you go: {"terms":[{"term":"Borescope","kind":"system","weight":2}]} hope that helps').length === 1);
ok("malformed JSON degrades to nothing, never throws", normalizeExtracted("not json at all").length === 0);
ok("empty response degrades to nothing", normalizeExtracted("").length === 0);
ok("a soft skill from the model is rejected",
  normalizeExtracted('{"terms":[{"term":"strong communication skills","kind":"domain","weight":3}]}').length === 0);
ok("a JD-bullet sentence is rejected",
  normalizeExtracted('{"terms":[{"term":"ability to work in a fast paced environment","kind":"domain","weight":2}]}').length === 0);
ok("a degree requirement is rejected",
  normalizeExtracted('{"terms":[{"term":"Bachelor degree required","kind":"credential","weight":3}]}').length === 0);
ok("an unknown kind falls back to domain",
  normalizeExtracted('{"terms":[{"term":"Hydraulics","kind":"nonsense","weight":2}]}')[0].kind === "domain");
ok("an out-of-range weight is clamped to a sane default",
  normalizeExtracted('{"terms":[{"term":"Avionics","kind":"domain","weight":99}]}')[0].weight === 2);
ok("duplicate terms collapse",
  normalizeExtracted('{"terms":[{"term":"Avionics","weight":2},{"term":"avionics","weight":3}]}').length === 1);
ok("a short acronym gets the strict matcher so it cannot false-positive on prose",
  normalizeExtracted('{"terms":[{"term":"IFR","kind":"credential","weight":3}]}')[0].strict === true);
ok("the term list is bounded",
  normalizeExtracted(JSON.stringify({ terms: Array.from({ length: 60 }, (_, i) => ({ term: `System${i}`, weight: 2 })) })).length <= 24);
ok("aliases are carried through",
  (normalizeExtracted('{"terms":[{"term":"A&P","aliases":["Airframe and Powerplant"],"weight":3}]}')[0].aliases || []).length === 1);

/* ---- role signature: the cache key ---- */
ok("the same role hits the same cache entry", roleSignature(icp()) === roleSignature(icp()));
ok("title order does not change the key",
  roleSignature(icp({ titles: ["A&P Mechanic", "Aircraft Maintenance Technician"] })) === roleSignature(icp()));
ok("punctuation and case do not change the key",
  roleSignature(icp({ titles: ["aircraft maintenance technician!", "a&p mechanic"] })) === roleSignature(icp()));
ok("a different industry is a different vocabulary",
  roleSignature(icp({ industries: ["Aviation"] })) !== roleSignature(icp({ industries: ["Rail"] })));
ok("location is not part of the key (same job, different city, same evidence)",
  roleSignature(icp({ geos: ["Dallas, TX"] })) === roleSignature(icp({ geos: ["Miami, FL"] })));

/* ---- measured yield ---- */
const stats = (o: Record<string, [number, number]>) =>
  Object.fromEntries(Object.entries(o).map(([k, [seen, hits]]) => [k, { seen, hits, updatedAt: "" }]));

const vocab = [term("A&P", { weight: 3 }), term("FAR Part 145", { weight: 3 }), term("Fabricated Unicorn", { weight: 2 })];

const measured = applyTermStats(vocab, stats({
  "A&P": [MIN_SAMPLE * 2, 300],              // healthy, discriminating
  "FAR Part 145": [MIN_SAMPLE * 2, 12],      // rare but real
  "Fabricated Unicorn": [MIN_SAMPLE * 2, 0], // nobody has it: hallucinated
}));
ok("a term no real profile carries is retired", measured.dropped.includes("Fabricated Unicorn"));
ok("the retired term leaves the vocabulary", !measured.terms.some((t) => t.term === "Fabricated Unicorn"));
ok("a rare but real term is KEPT", measured.terms.some((t) => t.term === "FAR Part 145"));
ok("a rare but real term still gets a query slot", measured.queryTerms.some((t) => t.term === "FAR Part 145"));
ok("rarity outranks commonness for query slots, at equal weight",
  measured.queryTerms.findIndex((t) => t.term === "FAR Part 145") <
  measured.queryTerms.findIndex((t) => t.term === "A&P"));

const thin = applyTermStats(vocab, stats({ "Fabricated Unicorn": [MIN_SAMPLE - 1, 0] }));
ok("a thin sample never retires anything", thin.dropped.length === 0);
ok("an unmeasured term is kept and queryable", thin.queryTerms.length === vocab.length);

const oneLucky = applyTermStats([term("Barely There")], stats({ "Barely There": [MIN_SAMPLE * 5, 1] }));
ok("a single accidental match does not rescue a dead term",
  oneLucky.dropped.includes("Barely There"), `dead yield floor is ${DEAD_YIELD}`);

const saturated = applyTermStats([term("Aviation"), term("A&P", { weight: 3 })], stats({
  "Aviation": [MIN_SAMPLE * 2, Math.round(MIN_SAMPLE * 2 * (SATURATED_YIELD + 0.2))],
  "A&P": [MIN_SAMPLE * 2, 300],
}));
ok("a term everyone has stays for scoring", saturated.terms.some((t) => t.term === "Aviation"));
ok("a term everyone has loses its query slot", !saturated.queryTerms.some((t) => t.term === "Aviation"));

const protectedRun = applyTermStats([term("CPA", { weight: 3 })], stats({ CPA: [MIN_SAMPLE * 3, 0] }), new Set(["cpa"]));
ok("a human-asserted term is never retired by measurement", protectedRun.dropped.length === 0);
ok("the protected term survives in the vocabulary", protectedRun.terms.some((t) => t.term === "CPA"));

/* ---- the circularity guard ---- */
const row = (o: Partial<CandidateRow> = {}): CandidateRow => ({ fullName: "X", fitScore: 0, fitReasons: [], ...o });
ok("a row found by a broad search counts toward yield", isUnbiasedRow(row({ sourceGroup: "broad: Dallas, TX" })));
ok("a row found BY a proof query does not count", !isUnbiasedRow(row({ sourceGroup: "qualified: A&P" })));
ok("a row with no provenance counts", isUnbiasedRow(row()));

/* ---- the three layers merging ---- */
const derived = [term("A&P", { kind: "credential", weight: 3 }), term("FAR Part 145", { weight: 3 })];
const offBookPlan = buildProofPlan(icp(), "Aircraft maintenance technician for a Part 145 repair station", { derived });
ok("an industry with no curated shelf still gets a vocabulary", offBookPlan.terms.length >= 2);
ok("the derived terms are reported as derived", (offBookPlan.derived || []).includes("A&P"));
ok("an off-book role now produces real query groups", offBookPlan.queryGroups.length > 0);
ok("the query group carries the derived evidence", /A&P|FAR Part 145/.test(offBookPlan.queryGroups.join(" ")));

// Curated shelves must still win where they exist.
const curatedPlan = buildProofPlan(
  icp({ label: "Senior Tax Accountant", titles: ["Senior Tax Accountant"], industries: ["Public Accounting"] }),
  "Senior Tax Accountant, CPA preferred, ASC 740 provision work",
  { derived: [term("CPA", { kind: "domain", weight: 1 })] },
);
ok("a curated term is not replaced by a weaker derived one of the same name",
  (curatedPlan.terms.find((t) => t.term === "CPA")?.weight ?? 0) === 3);
ok("curated and derived do not duplicate each other",
  curatedPlan.terms.filter((t) => t.term.toLowerCase() === "cpa").length === 1);

// Measured stats reach the plan.
const learnedPlan = buildProofPlan(icp(), "", {
  derived: [...derived, term("Fabricated Unicorn")],
  stats: stats({ "Fabricated Unicorn": [MIN_SAMPLE * 2, 0] }),
});
ok("a retired term never reaches the query matrix",
  !/Fabricated Unicorn/.test(learnedPlan.queryGroups.join(" ")));
ok("the plan reports what it retired", (learnedPlan.dropped || []).includes("Fabricated Unicorn"));
ok("no stats at all is not an error", buildProofPlan(icp(), "", { derived }).queryGroups.length > 0);
ok("no derived terms and no shelf yields an empty plan, not a broken one",
  buildProofPlan(icp()).queryGroups.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
