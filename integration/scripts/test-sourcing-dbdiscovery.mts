/* KoldInfo DB-discovery tests: spec building, geo chips, result parsing.
   Run from integration/: npx tsx scripts/test-sourcing-dbdiscovery.mts */
import { buildDbDiscoverySpecCsv, parseDbDiscoveryCsv, geoChips } from "../lib/sourcing/koldinfoDiscovery";
import { inTargetGeo } from "../lib/sourcing/score";
import type { CandidateICP } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const icp: CandidateICP = {
  label: "Director of Nursing", seniority: "director", managesTeam: true,
  titles: ["Director of Nursing", "Nursing Director", "DON"],
  geos: ["Fair Lawn, NJ", "Paramus, NJ"], remoteOk: false,
  industries: ["healthcare"], targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: [],
};

/* ---- 1. geo chips ---- */
const chips = geoChips(icp.geos);
ok(chips.cities.includes("Fair Lawn") && chips.cities.includes("Paramus"), "cities parsed from City, ST geos", chips);
ok(chips.states.includes("NJ") && chips.states.includes("New Jersey"), "state rides as BOTH abbrev and full-name chips (Contains matches neither from the other)", chips);
ok(geoChips(["New Jersey"]).states.includes("NJ"), "bare full-state geo yields the abbrev chip too");
ok(geoChips(["Greater Boston Area"]).cities.includes("Boston"), "metro wording strips to the plain city chip");
ok(geoChips([]).cities.length === 0 && geoChips([]).states.length === 0, "no geos, no chips (nationwide sweep)");

/* ---- 2. spec CSV ---- */
const spec = buildDbDiscoverySpecCsv(icp, 300);
ok(!!spec && spec.startsWith("titles,cities,states,limit"), "spec CSV header shape", spec);
ok(!!spec && spec.includes("Director of Nursing|Nursing Director|DON"), "titles pipe-joined in one cell");
ok(!!spec && spec.includes(",300"), "limit carried");
ok(buildDbDiscoverySpecCsv({ ...icp, titles: [] }, 300) === null, "no titles, no sweep (geo-only would be noise)");
ok(!!buildDbDiscoverySpecCsv(icp, 9999)?.includes(",1000"), "limit clamped to 1000");

/* ---- 3. result parsing ---- */
const resultCsv = [
  "full_name,title,company,email,email_status,phone,seniority,city,state,linkedin_url",
  'Jane Doe,Director of Nursing,Acme Care,jane@acme.com,Verified,+12015550123,director,Fair Lawn,New Jersey,https://linkedin.com/in/janedoe',
  'Jim Poe,Nursing Director,Beta Health,jim@beta.com,Unavailable,,director,Paramus,NJ,',
  ',Director of Nursing,NoName Co,x@y.com,Verified,,,,,',
].join("\n") + "\n";
const rows = parseDbDiscoveryCsv(resultCsv);
ok(rows.length === 2, "rows without a name are dropped", rows.length);
ok(rows[0].email === "jane@acme.com" && rows[0].phone === "+12015550123", "verified email + phone carried");
ok(rows[0].location === "Fair Lawn, New Jersey" && rows[0].provider === "koldinfo", "location + provider stamped");
ok(rows[1].email === undefined, "vendor-flagged (Unavailable) email is NOT carried into outreach");
ok(rows[1].fullName === "Jim Poe" && rows[1].location === "Paramus, NJ", "flagged-email row itself is kept");

// Parsed rows must flow through the strict-geo gate as in-area for the pinned cities.
ok(inTargetGeo(rows[0].location, icp.geos) === true, "DB row location passes the geo gate for its own pinned city");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
