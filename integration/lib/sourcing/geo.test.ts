/**
 * Geo pinning + strict-location matcher: regression suite.
 * Run: npx tsx lib/sourcing/geo.test.ts   (exits non-zero on failure)
 *
 * Born from a real run: a recruiter typed "Gairfield Heights OH +50mi" (comma-less
 * AND a one-letter typo of Garfield Heights). The exact-phrase matcher then geo-
 * dropped every real local, so 56 search credits bought 18 mostly-unknown-location
 * rows. These tests pin the fix: comma-less "City ST" parses, one-typo city names
 * still count as local (state-guarded), and clearly different places still drop.
 */

import { inTargetGeo } from "./score";
import { pinIcpLocation } from "./pinLocation";
import type { CandidateICP } from "./types";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };

/* ---- inTargetGeo: the strict-location gate ---- */

// THE bug: typo'd, comma-less pin vs the real stated location.
ok(inTargetGeo("Garfield Heights, Ohio", ["Gairfield Heights OH"]) === true,
  "one-typo city (Gairfield~Garfield) with comma-less pin counts as local");
ok(inTargetGeo("Garfield Heights, Ohio, United States", ["Gairfield Heights OH"]) === true,
  "same, with a full LinkedIn-style location string");

// Comma-less pin without any typo used to fail too (state word glued to the city).
ok(inTargetGeo("Garfield Heights, Ohio", ["Garfield Heights OH"]) === true,
  "comma-less 'City ST' pin matches the comma'd stated location");

// Different places still drop.
ok(inTargetGeo("Cleveland, Ohio", ["Gairfield Heights OH"]) === false,
  "a different city in the same state still drops");
ok(inTargetGeo("Phoenix, AZ", ["Garfield Heights OH"]) === false,
  "a different state still drops");

// Fuzzy is state-guarded and short-word-guarded.
ok(inTargetGeo("Springfeld, IL", ["Springfield MO"]) === false,
  "a typo'd city never fuzz-matches across DIFFERENT states");
ok(inTargetGeo("Yark, NY", ["York NY"]) === false,
  "short city names (<5 chars) must match exactly, no fuzz");

// Pre-fix behavior that must keep working.
ok(inTargetGeo("Dallas, TX", ["Dallas-Fort Worth Metroplex"]) === true,
  "metro-name containment still matches (Dallas in DFW Metroplex)");
ok(inTargetGeo(undefined, ["Garfield Heights OH"]) === undefined,
  "no stated location stays neutral (undefined)");
ok(inTargetGeo("Brooklyn, NY", ["New York"]) === true,
  "state-abbrev expansion still matches (Brooklyn NY in New York)");

/* ---- pinIcpLocation: comma-less input keeps same-state metros ---- */

const icp = {
  label: "Director of Ops", seniority: "director", managesTeam: true,
  titles: ["Director of Operations"],
  geos: ["Cleveland, Ohio", "Akron, Ohio", "Columbus, Ohio", "Chicago, Illinois"],
  remoteOk: false, industries: [], targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: [],
} as CandidateICP;

const pinned = pinIcpLocation({ ...icp, geos: [...icp.geos] }, "Gairfield Heights OH +50mi");
ok(pinned.geos[0] === "Gairfield Heights OH", "typed location (radius stripped) leads the pinned geos");
ok(pinned.geos.some((g) => g.toLowerCase().includes("cleveland")),
  "comma-less 'City ST' keeps same-state metros (Cleveland survives the pin)");
ok(!pinned.geos.some((g) => g.toLowerCase().includes("chicago")),
  "other-state metros are still pinned away (Chicago dropped)");

/* ---- pinIcpLocation: state-less metro nickname keeps its metro (Long Island) ---- */

// THE bug: a recruiter typed "Long Island" (no state). Pinning collapsed to the
// literal string, every real local ("Melville, NY") was marked out-of-area, and the
// never-empty rescue back-filled the list with out-of-area matches — a Long Island
// CFO search that returned Louisiana waste-company people.
const liIcp = {
  label: "CFO", seniority: "exec", managesTeam: true, titles: ["CFO"],
  geos: ["Long Island, NY", "Nassau County, NY", "Suffolk County, NY", "Melville, NY",
    "Hauppauge, NY", "New York City Metropolitan Area", "New Orleans, LA", "Metairie, LA"],
  remoteOk: false, industries: [], targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: [],
} as CandidateICP;

const li = pinIcpLocation({ ...liIcp, geos: [...liIcp.geos] }, "Long Island");
ok(li.geos[0] === "Long Island", "typed 'Long Island' leads the pinned geos");
ok(li.geos.some((g) => g.toLowerCase().includes("nassau")),
  "state-less nickname 'Long Island' keeps same-state metros (Nassau survives)");
ok(li.geos.some((g) => g.toLowerCase().includes("melville")),
  "same-state metro town Melville survives the pin (was the one that got rescued out)");
ok(!li.geos.some((g) => g.toLowerCase().includes("orleans") || g.toLowerCase().includes("metairie")),
  "Louisiana geos are pinned away for a Long Island search");

// The rescued locals must now actually pass the strict-location gate.
ok(inTargetGeo("Melville, NY", li.geos) === true,
  "a real Long Islander (Melville, NY) now counts as in-area under the pinned geos");
ok(inTargetGeo("New Orleans, LA", li.geos) === false,
  "a Louisiana location still drops under the pinned geos");

// Typing the state must keep working exactly as before.
const liState = pinIcpLocation({ ...liIcp, geos: [...liIcp.geos] }, "Long Island, NY");
ok(liState.geos.some((g) => g.toLowerCase().includes("nassau")),
  "'Long Island, NY' still keeps same-state metros");

// City-only inference: typed a real town with no state -> infer state from the parse.
const inf = pinIcpLocation({
  ...liIcp, geos: ["Melville, NY", "Hauppauge, NY", "Chicago, IL"],
}, "Melville");
ok(inf.geos.some((g) => g.toLowerCase().includes("hauppauge")),
  "state-less city 'Melville' infers NY from the parse and keeps same-state metros");
ok(!inf.geos.some((g) => g.toLowerCase().includes("chicago")),
  "inference stays in-state (Chicago dropped for a 'Melville' search)");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
