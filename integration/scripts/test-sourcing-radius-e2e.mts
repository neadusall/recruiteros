/**
 * RecruitersOS · JD Sourcing · radius END-TO-END check
 *
 *   npx tsx scripts/test-sourcing-radius-e2e.mts      (from integration/)
 *
 * The unit suite (test-sourcing-radius.mts) proves the geo primitives are right. This one
 * proves the WIRING: it drives the real `runDiscovery` with a stubbed Serper engine and a
 * fixed cast of people, then asserts the out-of-radius ones do not come back. The original
 * bug was never a broken matcher, it was a radius that never reached the filter, so a test
 * that calls the filter directly would have passed against the buggy build too.
 *
 * Everything network-facing is stubbed: no keys, no credits, no calls leave the process.
 */

import { runDiscovery } from "../lib/sourcing/discovery";
import { pinIcpLocation } from "../lib/sourcing/pinLocation";
import { generateQueries } from "../lib/sourcing/generateQueries";
import type { CandidateICP } from "../lib/sourcing/types";

/* ---------------- the cast: same title, same state, different distances ---------------- */

const PEOPLE = [
  { name: "Local Linda",    city: "Freehold, NJ",   miles: 8 },
  { name: "Nearby Ned",     city: "Toms River, NJ", miles: 13 },
  { name: "Edge Eddie",     city: "Trenton, NJ",    miles: 28 },
  { name: "Far Fred",       city: "Newark, NJ",     miles: 41 },
  { name: "Distant Dana",   city: "Camden, NJ",     miles: 50 },
  { name: "Crosstate Chris", city: "Philadelphia, PA", miles: 52 },
  { name: "Coastal Cal",    city: "San Diego, CA",  miles: 2400 },
  { name: "Unknown Uma",    city: "",               miles: -1 },
];

/** Serper's response shape, carrying the location in the snippet the way real results do. */
function serperPayload() {
  return {
    organic: PEOPLE.map((p, i) => ({
      title: `${p.name} - VP of Operations - Acme Health | LinkedIn`,
      link: `https://www.linkedin.com/in/${p.name.toLowerCase().replace(/\s+/g, "-")}-${i}`,
      snippet: p.city
        ? `VP of Operations at Acme Health. Location: ${p.city}. 15 years in healthcare operations.`
        : `VP of Operations at Acme Health. 15 years in healthcare operations.`,
    })),
  };
}

/* ---------------- stub the world ---------------- */

process.env.SERPER_API_KEY = "test-key-not-a-real-credential";
let serperCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const href = String(url);
  if (href.includes("serper.dev")) {
    serperCalls++;
    return new Response(JSON.stringify(serperPayload()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // Anything else in a test run is a mistake worth failing loudly on.
  throw new Error(`unexpected network call in e2e test: ${href}`);
}) as typeof fetch;

/* ---------------- run ---------------- */

const icpSeed = (): CandidateICP => ({
  label: "VP Operations", seniority: "vp", managesTeam: true,
  titles: ["VP of Operations"],
  geos: ["Howell, NJ", "Newark, NJ", "Camden, NJ", "Philadelphia, PA"],
  remoteOk: false, industries: ["Healthcare"], targetCompanies: [], sellsTo: [],
  verticals: [], mustHave: [], niceToHave: [], disqualifiers: [],
});

const LOCATION = "Howell, NJ +25mi";
const RADIUS = 25;

const icp = pinIcpLocation(icpSeed(), LOCATION, RADIUS);
const queries = generateQueries(icp, { breadth: "focused", radiusMi: RADIUS });

const result = await runDiscovery(queries, icp, {
  cap: 100,
  minFit: 1,
  engines: ["serper"],
  strictGeo: true,
  radiusMi: RADIUS,
  geoCenter: LOCATION,
});

globalThis.fetch = realFetch;

/* ---------------- assert ---------------- */

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string) => { cond ? pass++ : fails.push(label); };

const names = result.candidates.map((c) => c.fullName);
const has = (n: string) => names.some((x) => x.includes(n.split(" ")[0]));

ok(serperCalls > 0, "the stubbed engine actually ran (the test is exercising real discovery)");
ok(result.candidates.length > 0, "the run returned people");

// The bug, end to end.
ok(!has("Far"), "Newark (41mi) is NOT in a +25mi result");
ok(!has("Distant"), "Camden (50mi) is NOT in a +25mi result");
ok(!has("Crosstate"), "Philadelphia (52mi) is NOT in a +25mi result");
ok(!has("Coastal"), "San Diego is NOT in a +25mi result");

// The other half of correct: locals must survive.
ok(has("Local"), "Freehold (8mi) IS in the result");
ok(has("Nearby"), "Toms River (13mi) IS in the result");
ok(has("Edge"), "Trenton (28mi) survives via the boundary slack");

// Never-empty mandate: an unplaceable person is not silently discarded.
ok(has("Unknown"), "a person with no stated location is KEPT, not dropped");

// The distance is stamped for the UI readout.
const linda = result.candidates.find((c) => c.fullName.includes("Local"));
ok(typeof linda?.milesFromTarget === "number", "in-radius rows carry a measured distance");
ok((linda?.milesFromTarget ?? 99) < 20, "the stamped distance is plausible for Freehold");
const uma = result.candidates.find((c) => c.fullName.includes("Unknown"));
ok(uma?.milesFromTarget === undefined, "an unplaceable row has NO distance (not a fake zero)");

// Widening the dial must actually widen the result set, which it never used to.
const wide = await (async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("serper.dev")) {
      return new Response(JSON.stringify(serperPayload()), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected");
  }) as typeof fetch;
  const wIcp = pinIcpLocation(icpSeed(), "Howell, NJ +50mi", 50);
  const r = await runDiscovery(generateQueries(wIcp, { breadth: "focused", radiusMi: 50 }), wIcp, {
    cap: 100, minFit: 1, engines: ["serper"], strictGeo: true, radiusMi: 50, geoCenter: "Howell, NJ +50mi",
  });
  globalThis.fetch = realFetch;
  return r;
})();
const wideNames = wide.candidates.map((c) => c.fullName).join(" ");
ok(/Far/.test(wideNames), "+50mi DOES reach Newark (the dial is real)");
ok(!/Coastal/.test(wideNames), "+50mi still excludes San Diego");

console.log(`\nradius e2e: ${pass}/${pass + fails.length} checks passed`);
console.log(`  returned at +25mi: ${names.join(", ") || "(none)"}`);
console.log(`  returned at +50mi: ${wide.candidates.map((c) => c.fullName).join(", ") || "(none)"}`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  x " + f);
  process.exit(1);
}
console.log("all green\n");
