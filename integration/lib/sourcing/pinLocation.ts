/**
 * RecruitersOS · JD Sourcing
 * Pin the ICP's geography to the location the recruiter explicitly typed.
 *
 * The LLM parse is recall-biased and will happily emit a national metro list for a
 * senior role; the typed location is ground truth.
 *
 * TWO STRATEGIES, in order:
 *   1. MEASURED (preferred) — the recruiter picked a radius and the typed center
 *      geocodes, so geos become the real cities within N miles (see geoRadius.ts).
 *   2. TOKEN PIN (fallback) — no radius, or a center we cannot locate: keep only the
 *      parsed geos naming the same city or state. This is the historical behavior and
 *      is state-granular, i.e. looser than the radius the recruiter asked for.
 *
 * Still a pure function — no I/O, no network — so it stays unit-testable; the place
 * table it consults is a bundled constant.
 */

import type { CandidateICP } from "./types";
import { citiesWithinRadius, formatPlace, geocodeUsPlace, parseRadiusMi, stripRadiusSuffix } from "./geoRadius";

/** Compact US state name -> abbreviation map, for location token matching. */
const STATE_ABBREV: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
  tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

/**
 * Single-state metro / region nicknames a recruiter may type WITHOUT a state.
 * "Long Island" names no state to extract, so pinning collapsed to the literal
 * string and every real local ("Melville, NY") got marked out-of-area, letting the
 * never-empty rescue back-fill the list with out-of-area matches (a Long Island CFO
 * search that returned Louisiana waste-company people). Mapping a nickname to its
 * state lets the same-state parse geos survive, so "Long Island" behaves like
 * "Long Island, NY". Only unambiguous single-state regions belong here (skip
 * multi-state ones like "Tri-State" / "DMV").
 */
const METRO_STATE: Record<string, string> = {
  "long island": "ny", "new york city": "ny", nyc: "ny", "hudson valley": "ny",
  "silicon valley": "ca", "bay area": "ca", "sf bay area": "ca", "san francisco bay area": "ca",
  "inland empire": "ca", "central valley": "ca", "orange county": "ca",
  dfw: "tx", "dallas-fort worth": "tx", "dallas fort worth": "tx", metroplex: "tx",
  "twin cities": "mn", chicagoland: "il", "south florida": "fl", "central florida": "fl",
  "puget sound": "wa", "the triangle": "nc", "research triangle": "nc",
};

/** Full state name for an abbreviation, or undefined ("ny" -> "new york"). */
function fullStateName(ab: string): string | undefined {
  return Object.keys(STATE_ABBREV).find((k) => STATE_ABBREV[k] === ab);
}

/** Push a state's abbrev and full name onto the token list (deduped by caller's Set-free use). */
function addStateTokens(tokens: string[], ab: string): void {
  tokens.push(ab);
  const full = fullStateName(ab);
  if (full) tokens.push(full);
}

/** The US state an already-normalized location string names, as an abbrev, or null. */
function stateAbbrevIn(text: string): string | null {
  const t = " " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  for (const [full, ab] of Object.entries(STATE_ABBREV)) {
    if (t.includes(" " + full + " ") || t.includes(" " + ab + " ")) return ab;
  }
  return null;
}

/** Parse geos whose city or state token appears in the typed location's tokens. */
function localGeos(geos: string[] | undefined, tokens: string[]): string[] {
  return (geos || []).filter((g) => {
    const gn = " " + g.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
    return tokens.some((t) => gn.includes(" " + t + " ") || t.includes(gn.trim()));
  });
}

/**
 * Replace the parsed geo list with the places ACTUALLY inside the radius.
 *
 * The LLM parse is prompted to be generous ("list EVERY metro within roughly that
 * distance"), and the string-token pin below could only ever narrow that to "same state".
 * Together those made a +25mi search behave like a statewide one. When we can geocode the
 * typed center we no longer need either guess: the bundled place table knows exactly which
 * cities are within N miles, which is simultaneously tighter (it stops at the boundary)
 * and wider (it knows every suburb the LLM never thought to name) than the parse.
 *
 * Returns null when the center will not geocode, so the caller falls back to token pinning.
 */
function radiusGeos(typed: string, radiusMi: number): string[] | null {
  const center = geocodeUsPlace(typed);
  if (!center) return null;
  const near = citiesWithinRadius(center, radiusMi, 24, 0);
  if (!near.length) return null;
  // The typed location leads, then the most prominent in-radius places. These become the
  // query targets, so prominence (not proximity) is the right sort: we want the city names
  // people actually put on a LinkedIn profile.
  const out = [typed];
  for (const c of near) {
    const label = formatPlace(c.city, c.state);
    if (label.toLowerCase() !== typed.toLowerCase()) out.push(label);
  }
  return out.slice(0, 12);
}

export function pinIcpLocation(icp: CandidateICP, location?: string, radiusMi?: number): CandidateICP {
  const raw = stripRadiusSuffix(location || "");
  if (!raw) return icp;

  // Radius defaults to whatever the location LABEL says ("Fair Lawn, NJ +25mi"), so
  // callers that only have the label — saved-run re-runs, the overnight queue, plan —
  // pin exactly the same way the original search did.
  const miles = parseRadiusMi(radiusMi, location);

  // Radius-first: when the recruiter picked a distance and we can locate the center,
  // measured geography beats every heuristic below it.
  if (miles > 0) {
    const measured = radiusGeos(raw, miles);
    if (measured) {
      icp.geos = measured;
      return icp;
    }
  }
  // "Exact": the typed place only. Requires an explicit 0 AND a locatable place — a
  // caller that simply passed no radius still gets the legacy token pin below.
  if (radiusMi === 0 && !/\+\s*\d+\s*mi\b/i.test(location || "") && geocodeUsPlace(raw)) {
    icp.geos = [raw];
    return icp;
  }

  const tokens: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter((t) => t.length > 1)) {
    tokens.push(part);
    if (STATE_ABBREV[part]) tokens.push(STATE_ABBREV[part]);            // "new york" -> also "ny"
    const full = Object.keys(STATE_ABBREV).find((k) => STATE_ABBREV[k] === part);
    if (full) tokens.push(full);                                        // "ny" -> also "new york"
    // Comma-less "City ST" / "City Statename": recruiters often type "Garfield
    // Heights OH". Without splitting off the trailing state, the whole string was
    // one unmatchable token, every same-state metro the parse suggested got
    // filtered out, and the pinned geo list collapsed to just the typed string.
    const words = part.split(/\s+/);
    const abbrevOf = (t: string) =>
      STATE_ABBREV[t] ? STATE_ABBREV[t] : Object.values(STATE_ABBREV).includes(t) ? t : null;
    const tail2 = words.slice(-2).join(" ");
    const tail1 = words[words.length - 1];
    const tail = words.length > 2 && abbrevOf(tail2) ? tail2 : words.length > 1 && abbrevOf(tail1) ? tail1 : null;
    if (tail) {
      const ab = abbrevOf(tail)!;
      const city = part.slice(0, part.length - tail.length).trim();
      if (city.length > 1) tokens.push(city);
      addStateTokens(tokens, ab);
    }
  }

  // Anchor state: a state named in the typed text (handled above) OR, for a
  // state-less metro nickname, its state. Without this a bare "Long Island" keeps
  // only geos literally containing "long island", dropping every metro town.
  let anchorState = stateAbbrevIn(raw) || METRO_STATE[raw.toLowerCase().trim()] || null;
  if (anchorState) addStateTokens(tokens, anchorState);

  let local = localGeos(icp.geos, tokens);

  // Still no state? Infer one from the parse geos that matched the typed CITY
  // (e.g. typed "Melville" -> parse "Melville, NY" -> NY), but only when those
  // matches agree on a single state, then re-pin so same-state metros survive too.
  if (!anchorState) {
    const states = local.map((g) => stateAbbrevIn(g)).filter((s): s is string => Boolean(s));
    if (states.length && states.every((s) => s === states[0])) {
      anchorState = states[0];
      addStateTokens(tokens, anchorState);
      local = localGeos(icp.geos, tokens);
    }
  }

  icp.geos = [raw, ...local.filter((g) => g.trim().toLowerCase() !== raw.toLowerCase())].slice(0, 8);
  return icp;
}
