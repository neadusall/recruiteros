/* Breadth tests: title-chunk query fan-out + snippet location parsing.
   Run from integration/: npx tsx scripts/test-sourcing-breadth.mts */
import { generateQueries, geoVariants } from "../lib/sourcing/generateQueries";
import { locationFromSnippet } from "../lib/sourcing/discovery";
import { inTargetGeo } from "../lib/sourcing/score";
import type { CandidateICP } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const icp: CandidateICP = {
  label: "Director of Nursing", seniority: "director", managesTeam: true,
  titles: [
    "Director of Nursing", "DON", "Nursing Director", "Director of Nursing Services",
    "Director of Clinical Services", "Clinical Director", "Nurse Administrator",
    "Director of Patient Care Services", "Chief Nursing Officer", "Assistant Director of Nursing",
    "Director of Resident Care", "Health Services Director",
  ],
  geos: ["Fair Lawn, NJ", "Paramus, NJ", "Hackensack, NJ"], remoteOk: false,
  industries: ["healthcare", "long-term care"], targetCompanies: ["Genesis Healthcare", "Atria"],
  sellsTo: [], verticals: [], mustHave: ["RN"], niceToHave: [], disqualifiers: [],
};

/* ---- 1. Query fan-out by breadth ---- */
const focused = generateQueries(icp, { breadth: "focused" });
const balanced = generateQueries(icp, { breadth: "balanced" });
const wide = generateQueries(icp, { breadth: "wide" });

ok(balanced.length > focused.length, "balanced fans out more queries than focused", { f: focused.length, b: balanced.length });
ok(wide.length > balanced.length, "wide fans out more queries than balanced", { b: balanced.length, w: wide.length });

// Focused = the old behavior: only the first titleCap titles ever ride in a Boolean.
ok(!focused.some((q) => q.xray.includes("Clinical Director")), "focused sticks to the lead title chunk");
// Balanced runs the later title variants the parser produced (the old recall killer).
ok(balanced.some((q) => q.xray.includes("Clinical Director")), "balanced runs title chunk 2 (5th-8th titles)");
ok(balanced.some((q) => q.xray.includes("Director of Resident Care")), "balanced runs title chunk 3 (9th-12th titles)");

// Every balanced/wide query still carries site:linkedin.com/in (X-ray shape intact).
ok(wide.every((q) => q.xray.startsWith("site:linkedin.com/in")), "every query stays a linkedin.com/in X-ray");

// Wide adds the geo-free deep pass; balanced/focused must not.
ok(wide.some((q) => q.group === "broad: beyond location wording"), "wide adds the geo-free deep pass");
ok(!balanced.some((q) => q.group === "broad: beyond location wording"), "balanced has no geo-free pass");
const deep = wide.filter((q) => q.group === "broad: beyond location wording");
ok(deep.every((q) => !q.xray.includes("Fair Lawn")), "deep-pass queries carry no location term");

// Per-geo queries ride the metro-synonym OR-group.
ok(balanced.some((q) => q.group === "broad: Fair Lawn, NJ" && q.xray.includes("Greater Fair Lawn Area")),
  "per-geo query includes the Greater-area wording");

// Company poaching queries are unchanged in count (one per company, lead chunk only).
ok(wide.filter((q) => q.group === "Genesis Healthcare").length === 1, "one query per target company, all breadths");

/* ---- 2. Metro synonyms ---- */
ok(geoVariants("Dallas, TX").includes("Dallas-Fort Worth Metroplex"), "Dallas expands to DFW Metroplex");
ok(geoVariants("Boston, MA").includes("Greater Boston"), "Boston expands to Greater Boston");
ok(geoVariants("Fair Lawn, NJ").includes("Greater Fair Lawn Area"), "unknown metros get the generic Greater-area form");
ok(geoVariants("San Francisco Bay Area").length === 1, "already-metro wording is not double-expanded");

/* ---- 3. Snippet location parsing (what keeps the wide pass honest) ---- */
ok(locationFromSnippet("Location: Dallas, Texas · 500+ connections · VP Sales at Acme") === "Dallas, Texas",
  "explicit Location: field wins");
ok(locationFromSnippet("Jane Doe · Sales Director at Acme · Hackensack, NJ, United States · 500+ connections") === "Hackensack, NJ",
  "City, ST, United States fragment parses");
ok(locationFromSnippet("Experienced Director of Nursing. Greater Chicago Area. 300 connections.") === "Greater Chicago Area",
  "Greater-area wording parses");
ok(locationFromSnippet("Vice President, Georgia Market at BigCo") === undefined,
  "title text like 'President, Georgia' is NOT a location");
ok(locationFromSnippet("VP Sales at Salesforce | quota crusher") === undefined,
  "no location stated stays undefined (neutral)");
ok(locationFromSnippet("Director at University of Georgia, Athens · Atlanta, Georgia") === "Atlanta, Georgia",
  "an invalid fragment does not mask a real one later");
ok(locationFromSnippet(undefined) === undefined, "empty snippet stays undefined");

// Parsed locations must round-trip through the strict-geo gate correctly.
ok(inTargetGeo(locationFromSnippet("Jane · RN Director · Fair Lawn, NJ, United States"), icp.geos) === true,
  "parsed in-area location passes the geo gate");
ok(inTargetGeo(locationFromSnippet("Jane · RN Director · Location: Phoenix, Arizona"), icp.geos) === false,
  "parsed out-of-area location is caught by the geo gate");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
