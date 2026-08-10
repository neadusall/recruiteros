/**
 * The paid naming rung must never invent a decision-maker: regression suite.
 * Run: npx tsx scripts/test-paid-naming-affinity.mts   (exits non-zero on failure)
 *
 * WHY THIS EXISTS. The rung is DARK in production (it no-ops until RAPID_NAMING_KEY is set), so a
 * regression here is invisible until the day someone switches it on and trusts what comes out.
 * On 2026-08-07 it was probed against the subscribed listing for the first time and had two
 * defects that together would have written real people's names into curated rows for companies
 * they have never worked at, after which cold email would have addressed them as that company's
 * decision-maker:
 *
 *   1. JOB TITLES WERE NEVER READ. These listings return the job title in a field named `title`,
 *      which NAME_KEYS claimed, so TITLE_KEYS always resolved to "" and the leadership-title check
 *      could not reject anybody. Every person the API returned was accepted.
 *   2. NO COMPANY AFFINITY. The search is one loose keyword string with no binding to the company
 *      asked about: "VP of Marketing Carta" returned an SVP at PriceSmart, and "Director of
 *      Operations Gusto" returned a manager at a restaurant called "gusto! fresh bowls & wraps".
 *
 * The fixtures below are REAL responses captured from fresh-linkedin-scraper-api on 2026-08-07,
 * trimmed to the fields the extractor reads. No network: this must stay runnable in CI and on a
 * box with no API key.
 *
 * The load-bearing assertion is that CONTAINMENT IS NOT ENOUGH. "gusto! fresh bowls & wraps"
 * contains "gusto"; only whole-segment equality tells the restaurant apart from the payroll
 * company. If someone loosens worksAtCompany() back to a substring test, the Gusto case fails here.
 */

import { extractPeople } from "../lib/inmarket/paidNaming";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : `\n      got  ${g}\n      want ${w}`}`);
}
const names = (data: unknown, company: string): string[] =>
  extractPeople(data, company).map((p) => p.fullName);

/* Real capture: GET /api/v1/search/people?name=VP%20of%20Marketing%20Carta */
const CARTA = {
  success: true,
  data: [
    { full_name: "Kelly Kipkalov", title: "Vice President, Product and Customer Marketing at Carta", location: "Portola Valley, CA" },
    { full_name: "Juliana Correa Monteiro", title: "Senior Vice President Member Experience and Marketing at PriceSmart", location: "Miami, FL" },
    { full_name: "Locke Jillson", title: "Vice President of Executive Talent at Lightspeed Venture Partners" },
    { full_name: "David Shin", title: "Senior Vice President, Chief Legal Officer & Corporate Secretary at Accuray | SaaS, Digital Health & Data Enabled Solutions" },
    { full_name: "Nicole Baer", title: "Chief Marketing Officer @ Carta | Investor" },
  ],
};

/* Real capture: GET /api/v1/search/people?name=Director%20of%20Operations%20Gusto */
const GUSTO = {
  success: true,
  data: [
    { full_name: "Todd Smith", title: "Senior Director of Operations - gusto!" },
    { full_name: "Marquince Wilder", title: "Director of Operations at gusto! fresh bowls & wraps" },
    { full_name: "Saumya Chopra", title: "Sr Director, People Ops Services & Tech @ Gusto" },
    { full_name: "Zeena K.", title: "Product Operations at Gusto" },
    { full_name: "Kristen Offringa", title: "Business Operations at Gusto" },
    { full_name: "Thomas Sullivan", title: "Director of Operations at Gusto" },
  ],
};

console.log("— company affinity —");
check("keeps only the people actually at Carta", names(CARTA, "Carta"), ["Kelly Kipkalov", "Nicole Baer"]);
check("the PriceSmart SVP is not Carta's decision-maker", names(CARTA, "Carta").includes("Juliana Correa Monteiro"), false);
check("a VC's talent lead is not the portfolio company's", names(CARTA, "Carta").includes("Locke Jillson"), false);
check("a wholly unrelated company matches nobody", names(CARTA, "Globex"), []);

console.log("— containment is not enough —");
check("the restaurant is not Gusto the payroll company", names(GUSTO, "Gusto").includes("Marquince Wilder"), false);
check("real Gusto leaders survive", names(GUSTO, "Gusto").includes("Thomas Sullivan") && names(GUSTO, "Gusto").includes("Saumya Chopra"), true);
// KNOWN, ACCEPTED GAP - pinned so it stays a known gap rather than a surprise. "Senior Director of
// Operations - gusto!" gives an employer segment that normalizes to exactly "gusto", so it is
// indistinguishable from Gusto the payroll company using the response alone. Whoever tightens this
// (a domain check against the row, say) should flip this expectation deliberately.
check("KNOWN GAP: an employer named exactly 'gusto!' still passes", names(GUSTO, "Gusto").includes("Todd Smith"), true);

console.log("— the title check can actually fire —");
check("non-leadership staff are dropped", names(GUSTO, "Gusto").includes("Kristen Offringa"), false);
check("a person with no title at all is dropped", names({ data: [{ full_name: "Pat Quinn" }] }, "Acme"), []);
check("a leadership title alone, with no employer, is not proof", names({ data: [{ full_name: "Pat Quinn", title: "Chief Technology Officer" }] }, "Acme"), []);

console.log("— other response shapes still work —");
check("structured company field, legal suffix stripped",
  names({ results: [{ full_name: "Ann Lee", headline: "Head of Talent", company: "Acme Technologies" }] }, "Acme"), ["Ann Lee"]);
check("structured company field of a DIFFERENT firm is rejected",
  names({ results: [{ full_name: "Ann Lee", headline: "Head of Talent", company: "Initech" }] }, "Acme"), []);
check("SERP-style result line, employer in the tail",
  names({ items: [{ title: "Jane Doe - VP Engineering - Acme" }] }, "Acme"), ["Jane Doe"]);
check("SERP-style line naming someone else's employer",
  names({ items: [{ title: "Jane Doe - VP Engineering - Initech" }] }, "Acme"), []);
check("trailing noise after the employer is harmless",
  names({ data: [{ full_name: "Sam Ray", title: "Head of People at Acme | We're hiring!" }] }, "Acme"), ["Sam Ray"]);

console.log("— guards that must not be quietly removed —");
check("a company name too short to verify matches nobody",
  names({ data: [{ full_name: "Ann Lee", title: "Head of Talent at X" }] }, "X"), []);
check("nothing is invented from an empty response", names({ data: [] }, "Acme"), []);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
