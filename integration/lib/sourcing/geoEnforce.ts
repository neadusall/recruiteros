/**
 * RecruitersOS · JD Sourcing · the radius stays enforced AFTER the search.
 *
 * WHY THIS EXISTS
 * ---------------
 * runDiscovery measures every row against the recruiter's mileage. That was the only
 * place the radius was ever checked — so anything that put rows into a saved list by
 * some OTHER route walked straight past it:
 *
 *   - the same-role auto-combine folds duplicate searches for one role into one list,
 *     and it deliberately strips "+50mi" out of the match key. A "+25mi" list and a
 *     "+100mi" list for the same role are the same ROLE, so they merged — and the 25mi
 *     recruiter inherited the 100mi people;
 *   - a Sales Navigator pull applied to an existing list runs with strictGeo off (a
 *     pasted URL carries its own filters), then merges into a list that had a radius;
 *   - enrichment fills in a stated location AFTER the search. A row kept as "location
 *     unreadable" could turn out to be three states away, and nothing looked again.
 *
 * So the check lives here instead, as a pass over a SAVED run that can be re-run at any
 * point in the list's life. The run itself carries the recruiter's typed location and
 * mileage, so the list's own dials are the authority — never the dials of whatever
 * process is touching it.
 *
 * DESIGN RULES (the same ones geoRadius.ts holds to)
 * -------------------------------------------------
 *  - Nothing is deleted. Rows that fail are MARKED `outOfArea`, which moves them into
 *    the clearly separated block and keeps them out of the delivery lane. The recruiter
 *    can still see them, and can still promote them deliberately.
 *  - A row we cannot measure is never marked out. Unmeasurable stays unmeasurable.
 *  - Idempotent and pure-ish: safe to call on every merge, every enrichment finish, and
 *    twice in a row.
 */

import type { CandidateRow, SourcingRun } from "./types";
import {
  distanceFromCenter, enforcedRadiusMi, geocodeUsPlace, parseRadiusMi, stateOfPlace,
  statesWithinRadius, stripRadiusSuffix, withinRadius,
} from "./geoRadius";
import { isRemoteRun } from "./remoteMode";

export interface GeoEnforceResult {
  /** Rows newly marked out-of-area by this pass. */
  marked: number;
  /** Rows that were out-of-area and, re-measured, turn out to be inside after all. */
  cleared: number;
  /** The radius actually enforced, in miles (Exact resolves to its numeric meaning). */
  radiusMi: number;
  /** False when the list has no usable center, so nothing could be enforced. */
  enforced: boolean;
}

/** The geo dials a list was created with. `location` carries the "+25mi" suffix. */
export interface RunGeo {
  location?: string;
  radiusMi?: number;
}

/**
 * Re-measure every row against the list's own location + mileage.
 *
 * Mutates the rows in place and returns what changed; the CALLER persists the run (same
 * contract as gapFillContacts, so a merge can enforce and save once).
 */
export function enforceGeo(rows: CandidateRow[], geo: RunGeo): GeoEnforceResult {
  const picked = parseRadiusMi(geo.radiusMi, geo.location);
  const radiusMi = enforcedRadiusMi(picked);
  const label = stripRadiusSuffix(geo.location || "");
  const center = label ? geocodeUsPlace(label) : null;
  // No typed location, or one we cannot place: there is no circle to enforce. Leave every
  // row exactly as it is rather than inventing a verdict.
  if (!center) return { marked: 0, cleared: 0, radiusMi, enforced: false };

  const states = statesWithinRadius(center, radiusMi);
  let marked = 0;
  let cleared = 0;

  for (const r of rows) {
    // Keep the displayed distance honest against THIS list's center, whatever run the
    // row arrived from (a merged donor measured its miles from a different pin).
    r.milesFromTarget = distanceFromCenter(r.location, center);

    const measured = withinRadius(r.location, center, radiusMi);
    if (measured === true) {
      r.geoUnverified = undefined;
      // A row a wider donor list marked out-of-area can be genuinely inside THIS list's
      // radius; measurement decides, not the label it arrived wearing.
      if (r.outOfArea) { r.outOfArea = undefined; cleared++; }
      continue;
    }
    if (measured === false) {
      r.geoUnverified = undefined;
      if (!r.outOfArea) { r.outOfArea = true; marked++; }
      continue;
    }
    // Unmeasurable: fall back one level of precision, exactly as discovery does. A row
    // whose STATE the circle never touches is out; anything vaguer stays in and stays
    // flagged, so the next enrichment gets another chance to settle it.
    const st = stateOfPlace(r.location);
    if (st && !states.includes(st)) {
      r.geoUnverified = undefined;
      if (!r.outOfArea) { r.outOfArea = true; marked++; }
    } else {
      r.geoUnverified = true;
    }
  }
  return { marked, cleared, radiusMi, enforced: true };
}

/** Same pass, reading the dials off a saved run. The caller saves. */
export function enforceRunGeo(run: SourcingRun): GeoEnforceResult {
  // A REMOTE list has no center by definition, so there is nothing to enforce and
  // everyone on it is exactly where they should be. The label would not geocode anyway
  // and this would no-op, but a national list must never depend on a place-name lookup
  // FAILING in order to keep its people — say it outright instead.
  if (isRemoteRun(run)) return { marked: 0, cleared: 0, radiusMi: 0, enforced: false };
  return enforceGeo(run.candidates, { location: run.location, radiusMi: run.radiusMi });
}
