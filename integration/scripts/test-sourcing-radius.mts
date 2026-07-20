/**
 * RecruitersOS · JD Sourcing · radius regression suite
 *
 *   npx tsx scripts/test-sourcing-radius.mts       (from integration/)
 *
 * Pinned on the real complaint: "with the searches it seems to be going out of the geo
 * radius". Every case below is a way an out-of-radius person used to reach the results
 * list, plus the safety cases that must KEEP working (never-empty mandate: we only ever
 * hard-drop someone we positively located and positively measured too far away).
 */

import {
  geocodeUsPlace, haversineMi, withinRadius, citiesWithinRadius, parseRadiusMi,
  radiusBudgetMi, statesWithinRadius, stateOfPlace,
} from "../lib/sourcing/geoRadius";
import { pinIcpLocation } from "../lib/sourcing/pinLocation";
import { generateQueries } from "../lib/sourcing/generateQueries";
import { geoChips } from "../lib/sourcing/koldinfoDiscovery";
import { scoreCandidate } from "../lib/sourcing/score";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { pass++; return; }
  fails.push(label);
}

/* ---------------- 1. Geocoding the shapes recruiters actually type ---------------- */

ok(!!geocodeUsPlace("Fair Lawn, NJ"), "geocodes 'City, ST'");
ok(!!geocodeUsPlace("Garfield Heights OH"), "geocodes comma-less 'City ST' (the real typo-run input)");
ok(!!geocodeUsPlace("Melville, New York"), "geocodes a full state name");
ok(!!geocodeUsPlace("Greater Cleveland Area"), "geocodes a 'Greater X Area' label");
ok(!!geocodeUsPlace("Long Island"), "geocodes a state-less metro nickname");
ok(!!geocodeUsPlace("Dallas-Fort Worth Metroplex"), "geocodes a hyphenated metro");
ok(!!geocodeUsPlace("St. Louis, MO"), "geocodes Saint/St. spelling drift");
ok(geocodeUsPlace("New Jersey") === null, "a bare STATE has no honest center, so it declines");
ok(geocodeUsPlace("Springfield") === null, "an ambiguous bare city declines rather than guessing");
ok(geocodeUsPlace("") === null && geocodeUsPlace(undefined) === null, "empty input is null, not a crash");

/* ---------------- 1b. Dirty snippet locations (caught by the e2e, not by unit tests) --------------- */

// Rows harvested from search snippets carry prose glued to the location. The first cut of
// this module scanned such a string for any two-letter state code, and half of those are
// ordinary English words: " in " read as Indiana, so "Freehold, NJ. 15 years in healthcare
// operations" was looked up in INDIANA. Freehold vanished (dropping a real local) and
// Camden matched Camden, Indiana, measuring a 50-mile person at 647 miles.
const dirty = "Freehold, NJ. 15 years in healthcare operations.";
const dirtyPt = geocodeUsPlace(dirty);
ok(!!dirtyPt, "geocodes a location with snippet prose glued to it");
ok(dirtyPt?.state === "NJ", "prose containing ' in ' does NOT read as Indiana");
ok(stateOfPlace(dirty) === "NJ", "state is read positionally, not by scanning free text");
ok(
  Math.round(haversineMi(geocodeUsPlace("Howell, NJ")!, geocodeUsPlace("Camden, NJ. 15 years in ops.")!)) < 60,
  "a dirty 'Camden, NJ' measures ~50mi, not 647mi via Camden, Indiana",
);
ok(stateOfPlace("Portland, OR") === "OR", "a real trailing state code still reads correctly");
ok(stateOfPlace("VP of Operations in healthcare") === undefined, "prose with no location names no state");
ok(!!geocodeUsPlace("St. Louis, MO. Regional lead."), "the sentence cut does not break 'St.' names");

/* ---------------- 2. The bug: distance is now measured ---------------- */

const howell = geocodeUsPlace("Howell, NJ")!;
ok(Math.round(haversineMi(howell, geocodeUsPlace("Freehold, NJ")!)) < 15, "Freehold is a near neighbour of Howell");
ok(Math.round(haversineMi(howell, geocodeUsPlace("Newark, NJ")!)) > 35, "Newark is far from Howell");

// The headline regression: same state, way outside the radius.
ok(withinRadius("Newark, NJ", howell, 25) === false, "+25mi REJECTS same-state Newark (40mi out)");
ok(withinRadius("Camden, NJ", howell, 25) === false, "+25mi rejects same-state Camden (50mi out)");
ok(withinRadius("New York, NY", howell, 25) === false, "+25mi rejects NYC");
ok(withinRadius("Freehold, NJ", howell, 25) === true, "+25mi keeps a genuine local");
ok(withinRadius("Toms River, NJ", howell, 25) === true, "+25mi keeps a nearby town");
// Widening the dial actually widens the result, which it never did before.
ok(withinRadius("Newark, NJ", howell, 50) === true, "+50mi now reaches Newark");

/* ---------------- 3. Unknown NEVER means out (never-empty mandate) ---------------- */

ok(withinRadius(undefined, howell, 25) === undefined, "no stated location is 'unknown', not 'out'");
ok(withinRadius("Remote", howell, 25) === undefined, "an unresolvable location is 'unknown', not 'out'");
ok(withinRadius("Freehold, NJ", null, 25) === undefined, "an unlocatable CENTER disables the filter entirely");
ok(withinRadius("Freehold, NJ", howell, 0) === undefined, "radius 0 ('Exact') disables the distance filter");
ok(radiusBudgetMi(25) > 25, "the budget is generous, never stricter than what was asked for");

/* ---------------- 4. Radius parsing, incl. saved-run labels ---------------- */

ok(parseRadiusMi(25, undefined) === 25, "explicit number wins");
ok(parseRadiusMi(undefined, "Fair Lawn, NJ +25mi") === 25, "reads the radius back off a saved label");
ok(parseRadiusMi(undefined, "Fair Lawn, NJ") === 0, "no suffix means Exact");
ok(parseRadiusMi(99999, undefined) === 250, "clamps to the dropdown ceiling");
ok(parseRadiusMi("junk", undefined) === 0, "garbage is Exact, not NaN");

/* ---------------- 5. pinIcpLocation no longer widens to the whole state ---------------- */

const baseIcp = (): CandidateICP => ({
  label: "VP Operations", seniority: "vp", managesTeam: true,
  titles: ["VP of Operations", "Director of Operations"],
  // Exactly the failure mode: an LLM parse that sprayed the whole state and beyond.
  geos: ["Howell, NJ", "Newark, NJ", "Camden, NJ", "Jersey City, NJ", "Philadelphia, PA", "New York, NY"],
  remoteOk: false, industries: ["Healthcare"], targetCompanies: [], sellsTo: [],
  verticals: [], mustHave: [], niceToHave: [], disqualifiers: [],
});

const pinned = pinIcpLocation(baseIcp(), "Howell, NJ +25mi", 25);
const pinnedText = pinned.geos.join(" | ");
ok(pinned.geos[0] === "Howell, NJ", "the typed location leads the pinned geos");
ok(!/Camden/i.test(pinnedText), "pinning DROPS same-state Camden (50mi out)");
ok(!/Philadelphia/i.test(pinnedText), "pinning drops out-of-state Philadelphia");
ok(pinned.geos.length > 1, "pinning still supplies real neighbouring towns to search");
ok(
  pinned.geos.every((g) => {
    const p = geocodeUsPlace(g);
    return !p || haversineMi(howell, p) <= radiusBudgetMi(25);
  }),
  "EVERY pinned geo is genuinely inside the radius",
);

// A radius the label carries but the caller forgot to pass must still pin correctly,
// otherwise saved-run re-runs and the overnight queue silently search a different area.
const pinnedFromLabel = pinIcpLocation(baseIcp(), "Howell, NJ +25mi");
ok(!/Camden/i.test(pinnedFromLabel.geos.join(" | ")), "label-only radius still pins (saved runs / night queue)");

// No radius at all keeps the historical token pin rather than silently tightening.
const pinnedNoRadius = pinIcpLocation(baseIcp(), "Howell, NJ");
ok(pinnedNoRadius.geos.length > 1, "no radius falls back to the legacy same-state pin");

// A center we cannot locate must not wipe the geos out.
const pinnedUnknown = pinIcpLocation(baseIcp(), "Nowheresville, ZZ +25mi", 25);
ok(pinnedUnknown.geos.length > 0, "an unlocatable center falls back instead of emptying the geos");

/* ---------------- 6. Query fan-out stops advertising the whole region ---------------- */

const tightQ = generateQueries(pinned, { breadth: "wide", radiusMi: 25 });
const tightText = tightQ.map((q) => `${q.xray} ${q.keyword}`).join(" ");
ok(!/Greater Howell Area/i.test(tightText), "a tight radius stops inventing 'Greater <City> Area'");
ok(!tightQ.some((q) => q.group === "broad: beyond location wording"), "a tight radius skips the geo-free nationwide pass");

const wideQ = generateQueries(pinIcpLocation(baseIcp(), "Newark, NJ +100mi", 100), { breadth: "wide", radiusMi: 100 });
ok(wideQ.some((q) => q.group === "broad: beyond location wording"), "a wide radius keeps the deep pass");

const noRadiusQ = generateQueries(baseIcp(), { breadth: "wide" });
ok(noRadiusQ.some((q) => q.group === "broad: beyond location wording"), "no radius keeps the historical wide behavior");

/* ---------------- 7. KoldInfo DB chips are no longer statewide ---------------- */

// The worker ANDs the city and state rules, so an EMPTY city list meant "anyone in the
// state" — the single widest way out-of-radius people entered a geo'd run.
const stateOnly = geoChips(["New Jersey"]);
ok(stateOnly.cities.length === 0 && stateOnly.states.length > 0, "baseline: a bare state geo yields a statewide chip set");

const measuredChips = geoChips(["New Jersey"], { location: "Howell, NJ", radiusMi: 25 });
ok(measuredChips.cities.length > 0, "with a radius, a bare state geo becomes REAL city chips");
// The DB filter takes city chips and state chips as SEPARATE rules, so a chip is only
// ever a city NAME; pair each against the states the radius actually covers.
ok(
  measuredChips.cities.every((c) =>
    measuredChips.states.some((st) => {
      const p = geocodeUsPlace(`${c}, ${st}`);
      return p && haversineMi(howell, p) <= radiusBudgetMi(25);
    }),
  ),
  "every KoldInfo city chip resolves to a place inside the radius",
);
ok(measuredChips.states.includes("NY"), "a radius crossing a state line contributes that state's chips too");
ok(!measuredChips.cities.some((c) => /camden/i.test(c)), "KoldInfo chips exclude the far same-state city");

/* ---------------- 8. Scoring prefers the nearer candidate ---------------- */

const mkRow = (over: Partial<CandidateRow>): CandidateRow => ({
  fullName: "Test Person", title: "VP of Operations", company: "Acme Health",
  location: "Freehold, NJ", linkedinUrl: "https://linkedin.com/in/test",
  fitScore: 0, fitReasons: [], ...over,
} as CandidateRow);

const near = scoreCandidate(mkRow({ location: "Freehold, NJ", milesFromTarget: 8 }), pinned, { radiusMi: 25, geoLabel: "Howell, NJ" });
const edge = scoreCandidate(mkRow({ location: "Trenton, NJ", milesFromTarget: 24 }), pinned, { radiusMi: 25, geoLabel: "Howell, NJ" });
const far = scoreCandidate(mkRow({ location: "Newark, NJ", milesFromTarget: 41 }), pinned, { radiusMi: 25, geoLabel: "Howell, NJ" });
ok(near.fitScore > edge.fitScore, "a closer candidate outranks one at the edge of the radius");
ok(edge.fitScore > far.fitScore, "an in-radius candidate outranks an out-of-radius one");
ok(far.fitReasons.some((r) => /outside the 25 mi radius/.test(r)), "the out-of-radius reason names the actual radius");
ok(near.fitReasons.some((r) => /8 mi from Howell, NJ/.test(r)), "the in-radius reason reads as plain distance");
ok(!near.fitReasons.concat(far.fitReasons).some((r) => r.includes("—")), "no em-dashes in recruiter-facing reasons");

// No radius picked: the scorer must fall back to the name matcher, not to zero credit.
const legacy = scoreCandidate(mkRow({ location: "Howell, NJ" }), pinned, {});
ok(legacy.fitReasons.some((r) => /In-target geo/.test(r)), "with no radius the name-based geo credit still applies");

/* ---------------- 9. Cross-state radii and helper sanity ---------------- */

const nyc = geocodeUsPlace("New York, NY")!;
ok(statesWithinRadius(nyc, 25).includes("NJ"), "a radius straddling a state line reports both states");
ok(citiesWithinRadius(nyc, 25, 10).length === 10, "citiesWithinRadius honours its limit");
ok(citiesWithinRadius(null, 25).length === 0, "no center yields no cities");
ok(citiesWithinRadius(nyc, 0).length === 0, "radius 0 yields no cities");

/* ---------------- report ---------------- */

console.log(`\nradius suite: ${pass}/${pass + fails.length} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  x " + f);
  process.exit(1);
}
console.log("all green\n");
