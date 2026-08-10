/**
 * RecruitersOS · JD Sourcing · REMOTE ROLES (search the whole country).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every geography path in JD Sourcing assumes the recruiter typed a city and a radius.
 * That is correct for a role someone has to drive to, and wrong for a remote one: there
 * is no center to measure from, so the honest answer to "who could do this job?" is
 * "anyone in the country who fits the brief".
 *
 * Leaving the location box EMPTY was never that answer. With no typed location the LLM
 * parse invents its own metro list (that is the recall bias `pinIcpLocation` exists to
 * correct), the queries then carry those invented metros as hard AND terms, and the run
 * quietly becomes "this role in whichever eight cities the model happened to name". A
 * remote search has to say so explicitly, which is what this module is for.
 *
 * TWO THINGS MAKE A NATIONAL SEARCH ACTUALLY WORK
 * -----------------------------------------------
 *  1. REMOTE WORDING. A remote worker usually says so — "Remote", "United States
 *     (Remote)", "Work From Home" in the location field, "remote-first" or "distributed
 *     team" in the headline. Those are the highest-signal rows in a national pull, and a
 *     geo-free query never targets them specifically. `REMOTE_PHRASES` does.
 *  2. A METRO ROTA. Search engines cap results per query, so ONE nationwide query does
 *     not return the nation — it returns the first page of it, which skews to whoever
 *     ranks highest. Real national coverage comes from fanning the same title Boolean
 *     across many metros and unioning the results. `nationalGeoTargets` is that rota:
 *     the country's largest professional workforces, biggest first, sliced by breadth.
 *
 * Everything here is pure and free (no model call, no network) so it can run inside the
 * discovery hot loop and be unit-tested.
 */

import type { CandidateICP, CandidateRow, SearchBreadth } from "./types";

/* ------------------------------------------------------------------ */
/* Remote wording                                                      */
/* ------------------------------------------------------------------ */

/**
 * The phrases people actually put on a profile when they work from anywhere, in the
 * order they are worth searching. These ride as an OR-group inside the remote queries,
 * so they widen the search rather than narrowing it.
 *
 * Deliberately short: each extra term in an X-ray is another AND against a two-line
 * snippet, and a bloated OR-group gets truncated by the engine before it is honored.
 */
export const REMOTE_PHRASES = [
  "Remote",
  "Remote, United States",
  "United States (Remote)",
  "Work From Home",
  "Fully Remote",
  "Remote Work",
];

/**
 * Wordings that mean "this person is not tied to an office", checked against a row's
 * stated location and its headline/snippet text.
 *
 * `remote` alone is safe on the LOCATION field (nobody lists the hamlet of Remote,
 * Oregon) but not on free text, where "remote monitoring" and "remote patient care" are
 * ordinary job duties. So the headline pass requires one of the compound phrases.
 */
const REMOTE_LOCATION_WORDS = [
  "remote", "anywhere", "nationwide", "work from home", "wfh", "virtual", "distributed",
  "telecommute", "united states", "usa", "us based",
];
const REMOTE_HEADLINE_PHRASES = [
  "fully remote", "remote first", "remote-first", "works remotely", "working remotely",
  "remote role", "remote position", "remote team", "work from home", "wfh",
  "distributed team", "location independent", "digital nomad", "100% remote",
];

function normalize(text: string | undefined): string {
  return " " + (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

/** Does this row's STATED LOCATION say "no fixed office"? */
export function locationSaysRemote(location: string | undefined): boolean {
  if (!location) return false;
  const t = normalize(location);
  return REMOTE_LOCATION_WORDS.some((w) => t.includes(" " + w.replace(/[^a-z0-9]+/g, " ") + " "));
}

/**
 * Does anything about this row say "remote"?
 *
 * Used for RANKING only, never for dropping: a remote job can obviously be done by
 * someone who has always worked on site, and a profile that never mentions remote is a
 * perfectly good candidate. This just floats the people who already work this way.
 */
export function rowSaysRemote(row: Pick<CandidateRow, "location" | "headline" | "title">): boolean {
  if (locationSaysRemote(row.location)) return true;
  const t = normalize([row.headline, row.title].filter(Boolean).join(" "));
  return REMOTE_HEADLINE_PHRASES.some((p) => t.includes(" " + p.replace(/[^a-z0-9]+/g, " ") + " "));
}

/* ------------------------------------------------------------------ */
/* The national metro rota                                             */
/* ------------------------------------------------------------------ */

/**
 * US metros in rough order of professional workforce size.
 *
 * This is a SEARCH ROTA, not a filter: nobody is dropped for living somewhere that is
 * not on it (a remote run drops nobody on location at all). Its only job is to give the
 * engines enough distinct places to page through that the union approaches national
 * coverage instead of one crowded first page.
 *
 * Written as "City, ST" so it feeds `geoVariants` and the metro-synonym table exactly
 * the way a recruiter-typed location does.
 */
export const NATIONAL_METROS = [
  "New York, NY", "Los Angeles, CA", "Chicago, IL", "Dallas, TX", "Houston, TX",
  "Washington, DC", "Atlanta, GA", "Philadelphia, PA", "Phoenix, AZ", "Boston, MA",
  "San Francisco, CA", "Miami, FL", "Seattle, WA", "Detroit, MI", "Minneapolis, MN",
  "Denver, CO", "Charlotte, NC", "Tampa, FL", "San Diego, CA", "Austin, TX",
  "Baltimore, MD", "Nashville, TN", "St. Louis, MO", "Portland, OR", "Orlando, FL",
  "Hartford, CT", "Columbus, OH", "Indianapolis, IN", "Kansas City, MO", "Raleigh, NC",
  "Salt Lake City, UT", "Pittsburgh, PA", "Cincinnati, OH", "Cleveland, OH",
  "San Antonio, TX", "Sacramento, CA", "Las Vegas, NV", "Milwaukee, WI",
  "Jacksonville, FL", "Richmond, VA",
];

/**
 * How many metros the rota runs at each breadth.
 *
 * Every metro multiplies the query count by the number of title chunks, and each query
 * costs an engine call, so this is the main spend dial on a national run. Balanced is
 * sized to cover the metros holding roughly two thirds of US professional employment.
 */
const METRO_ROTA: Record<SearchBreadth, number> = { focused: 6, balanced: 14, wide: 26 };

/** The metros a national run fans out across at this breadth, deduped, biggest first. */
export function nationalGeoTargets(breadth: SearchBreadth = "balanced"): string[] {
  const out: string[] = [];
  for (const m of NATIONAL_METROS) {
    if (!out.some((x) => x.toLowerCase() === m.toLowerCase())) out.push(m);
    if (out.length >= METRO_ROTA[breadth]) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ICP shaping                                                         */
/* ------------------------------------------------------------------ */

/**
 * Strip the geography out of a parsed profile for a remote run.
 *
 * `pinIcpLocation` is the pin for a typed location; this is its opposite number, and a
 * remote run must call exactly one of the two. Clearing `geos` is the load-bearing part:
 * an empty list means no geo term is ANDed into any query, no rerank/deep-vet prompt
 * asks the model to prefer a city, and the strict-location drop has nothing to match on
 * even if some caller leaves it switched on.
 *
 * Mutates and returns the same object, matching `pinIcpLocation`'s contract.
 */
export function applyRemoteIcp(icp: CandidateICP): CandidateICP {
  icp.geos = [];
  icp.remoteOk = true;
  return icp;
}

/** The label a remote run carries in place of "Fair Lawn, NJ +25mi". */
export const REMOTE_LABEL = "Remote · United States";

/**
 * Was this run a national remote pull?
 *
 * Reads the explicit flag first and falls back to the label, so lists saved before the
 * flag existed (and any client that only sends the label) still render and re-run as
 * remote instead of silently reverting to a pinned search.
 */
export function isRemoteRun(run: { remote?: boolean; location?: string } | undefined): boolean {
  if (!run) return false;
  if (run.remote === true) return true;
  return normalize(run.location).includes(" remote ");
}
