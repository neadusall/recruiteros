/* Sales Navigator search-mode tests: URL parsing (query DSL + classic + saved-search),
   ICP derivation traps, and the merge-into-existing-list guarantees the feature sells
   (no duplicate people, blanks filled both ways).
   Run from integration/:  npx tsx scripts/test-salesnav.mts */
import { parseSalesNavUrl, icpFromSalesNav, searchKindOf } from "../lib/sourcing/salesNav";
import { mergeSourcingRuns } from "../lib/sourcing/mergeRuns";
import type { CandidateRow, SourcingRun } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

/* ---- 1. Sales Navigator query DSL: every filter bucket, multiple values ---- */
{
  const url = "https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled%3Atrue%2Ckeywords%3Aradiology%2Cfilters%3AList((type%3ATITLE%2Cvalues%3AList((id%3A1%2Ctext%3ADirector%2520of%2520Radiology%2CselectionType%3AINCLUDED)%2C(id%3A2%2Ctext%3AImaging%2520Manager%2CselectionType%3AINCLUDED)))%2C(type%3AGEOGRAPHY%2Cvalues%3AList((id%3A102571732%2Ctext%3ANew%2520York%2520City%2520Metropolitan%2520Area%2CselectionType%3AINCLUDED)))%2C(type%3ACURRENT_COMPANY%2Cvalues%3AList((text%3ANorthwell%2520Health)))))";
  const c = parseSalesNavUrl(url);
  ok(c.keywords.includes("radiology"), "dsl: keywords");
  // The `selectionType:` token contains "type:", so a naive split drops every value
  // after the first. Both titles must survive.
  ok(c.titles.length === 2 && c.titles.includes("Imaging Manager"), "dsl: ALL title values survive selectionType trap", c.titles);
  ok(c.geos[0] === "New York City Metropolitan Area", "dsl: geography");
  ok(c.companies[0] === "Northwell Health", "dsl: current company");
  // Numeric filter ids must never leak in as text values.
  ok(!c.geos.some((g) => /^\d+$/.test(g)) && !c.titles.some((t) => /^\d+$/.test(t)), "dsl: numeric ids dropped");
}

/* ---- 2. Classic people-search params ---- */
{
  const c = parseSalesNavUrl("https://www.linkedin.com/search/results/people/?keywords=nurse%20practitioner&titleFreeText=NP&company=Optum");
  ok(c.keywords[0] === "nurse practitioner", "classic: keywords");
  ok(c.titles[0] === "NP", "classic: titleFreeText");
  ok(c.companies[0] === "Optum", "classic: company");
}

/* ---- 3. Saved-search URL carries no inline filters: empty, not garbage ---- */
{
  const c = parseSalesNavUrl("https://www.linkedin.com/sales/search/people?savedSearchId=123456");
  ok(!c.titles.length && !c.geos.length && !c.companies.length && !c.keywords.length, "saved-search: clean empty criteria", c);
}

/* ---- 4. ICP derivation: URL filters win; profile backfill; seniority traps ---- */
{
  const icp = icpFromSalesNav(
    { keywords: ["radiology"], titles: ["Director of Radiology"], geos: ["New York City Metropolitan Area"], companies: ["Northwell Health"], industries: [] },
    [],
  );
  // "Director" contains "cto": a non-word-bounded exec regex misfiles every director.
  ok(icp.seniority === "director", "icp: 'Director of Radiology' is director, not exec", icp.seniority);
  ok(icp.titles[0] === "Director of Radiology" && icp.geos[0] === "New York City Metropolitan Area", "icp: URL filters drive titles/geos");

  const profiles: CandidateRow[] = [
    { fullName: "A", title: "Staff Nurse", location: "Dallas, TX, United States", company: "Baylor", fitScore: 0, fitReasons: [] },
    { fullName: "B", title: "Staff Nurse", location: "Dallas, TX", company: "Baylor", fitScore: 0, fitReasons: [] },
    { fullName: "C", title: "Charge Nurse", location: "Plano, TX", company: "THR", fitScore: 0, fitReasons: [] },
  ];
  const icp2 = icpFromSalesNav({ keywords: [], titles: [], geos: [], companies: [], industries: [] }, profiles);
  ok(icp2.titles[0] === "Staff Nurse", "icp backfill: most frequent profile title leads", icp2.titles);
  ok(icp2.geos.includes("Dallas, TX") && !icp2.geos.some((g) => /united states/i.test(g)), "icp backfill: country suffix stripped + deduped", icp2.geos);
  ok(icpFromSalesNav({ keywords: [], titles: ["Vice President of Sales"], geos: [], companies: [], industries: [] }, []).seniority === "vp", "icp: vice president is vp, not exec");
}

/* ---- 5. Merge-into-existing-list guarantees (the salesNav action path) ---- */
{
  const mk = (over: Partial<CandidateRow> & { fullName: string }): CandidateRow =>
    ({ fitScore: 50, fitReasons: [], ...over });
  const runOf = (id: string, candidates: CandidateRow[]): SourcingRun => ({
    id, workspaceId: "ws", name: "Existing list", motion: "recruiting", jd: "",
    icp: { label: "x", seniority: "ic", managesTeam: false, titles: ["T"], geos: [], remoteOk: true, industries: [], targetCompanies: [], sellsTo: [], verticals: [], mustHave: [], niceToHave: [], disqualifiers: [] },
    queries: [], candidates, warnings: [], createdAt: "2026-07-20T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  });
  // Existing under-enriched list: has an email, no phone/title for Pat.
  const existing = runOf("old", [
    mk({ fullName: "Pat Jones", linkedinUrl: "https://linkedin.com/in/patj", email: "pat@x.com" }),
    mk({ fullName: "Sam Lee", linkedinUrl: "https://linkedin.com/in/samlee/", phone: "+15551112222" }),
  ]);
  // Sales Nav pull: Pat again (with title + company, no email), plus one new person.
  const incoming = runOf("salesnav_incoming", [
    mk({ fullName: "Pat Jones", linkedinUrl: "https://LinkedIn.com/in/patj/", title: "Director of Radiology", company: "Northwell", fitScore: 55 }),
    mk({ fullName: "New Person", linkedinUrl: "https://linkedin.com/in/newp", fitScore: 55 }),
  ]);
  const { candidates, overlap } = mergeSourcingRuns([existing, incoming]);
  ok(candidates.length === 3, "merge: no duplicate people (3, not 4)", candidates.length);
  ok(overlap === 1, "merge: overlap counted");
  const pat = candidates.find((c) => c.fullName === "Pat Jones")!;
  ok(pat.email === "pat@x.com" && pat.title === "Director of Radiology", "merge: blanks filled BOTH ways (kept email, gained title)", pat);
  ok(candidates.some((c) => c.fullName === "New Person"), "merge: new person added");
}

/* ---- 6. LinkedIn Recruiter URLs ---- */
{
  // Legacy smartsearch spells its filters as plain params, with OR-packed alternates.
  const c = parseSalesNavUrl(
    "https://www.linkedin.com/recruiter/smartsearch?searchKeywords=ICU%20Nurse&title=Registered%20Nurse%20OR%20RN&locations=Dallas%2C%20Texas&companies=HCA%20Healthcare",
  );
  ok(c.keywords.includes("ICU Nurse"), "recruiter legacy: searchKeywords", c.keywords);
  ok(c.titles.length === 2 && c.titles.includes("RN") && c.titles.includes("Registered Nurse"), "recruiter legacy: OR-packed titles split", c.titles);
  ok(c.geos[0] === "Dallas, Texas", "recruiter legacy: locations", c.geos);
  ok(c.companies[0] === "HCA Healthcare", "recruiter legacy: companies", c.companies);
}
{
  // Modern /talent/ URLs usually carry only opaque ids: clean empty criteria, no garbage.
  const c = parseSalesNavUrl(
    "https://www.linkedin.com/talent/search?searchContextId=8f2f0a&searchHistoryId=123456789&searchRequestId=abcdef",
  );
  ok(!c.titles.length && !c.geos.length && !c.companies.length && !c.keywords.length, "recruiter modern: opaque ids parse to clean empty", c);
}
{
  // A talent URL that DOES carry readable params still yields criteria.
  const c = parseSalesNavUrl("https://www.linkedin.com/talent/search?keywords=Clinic%20Director&locations=Wichita%2C%20Kansas");
  ok(c.keywords[0] === "Clinic Director", "recruiter modern: keywords param", c.keywords);
  ok(c.geos[0] === "Wichita, Kansas", "recruiter modern: locations param", c.geos);
}
{
  ok(searchKindOf("https://www.linkedin.com/talent/search?x=1") === "LinkedIn Recruiter", "kind: /talent/ is Recruiter");
  ok(searchKindOf("https://www.linkedin.com/recruiter/smartsearch?x=1") === "LinkedIn Recruiter", "kind: /recruiter/ is Recruiter");
  ok(searchKindOf("https://www.linkedin.com/sales/search/people?x=1") === "Sales Navigator", "kind: /sales/ is Sales Navigator");
  ok(searchKindOf("https://www.linkedin.com/search/results/people/?keywords=x") === "LinkedIn", "kind: people search is LinkedIn");
}
{
  // ICP label fallback carries the surface name when the URL taught us nothing else.
  const icp = icpFromSalesNav({ keywords: [], titles: [], geos: [], companies: [], industries: [] }, [], "LinkedIn Recruiter");
  ok(icp.label.startsWith("LinkedIn Recruiter search"), "recruiter: ICP label fallback", icp.label);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
