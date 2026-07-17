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

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
