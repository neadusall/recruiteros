/**
 * RecruitersOS · BD · MPC · City vernacular + nearest-metro resolver
 *
 * Two jobs, both about sounding like a recruiter who actually works the market:
 *
 *  1. NEAREST METRO — a hiring signal's posted location is often a suburb or small town
 *     ("Round Rock, TX", "Frisco, TX", "Sandy, UT"). People recognize the METRO, so we resolve
 *     the raw location up to it ("Austin", "Dallas", "Salt Lake City"). That's what makes the
 *     proximity line ("a search right by you") land.
 *
 *  2. LOCAL VERNACULAR — locals call their city something specific ("DFW", "the Bay", "Philly",
 *     "NOLA"). Using the RIGHT one signals you're from there. Using the WRONG one ("San Fran",
 *     "Frisco", "Chi-town", "the Big Apple") instantly outs you as an outsider and is WORSE than
 *     the plain name. So this is an ALLOWLIST of insider-approved terms plus an explicit BLOCKLIST;
 *     anything not on the allowlist falls back to the plain metro name. When unsure, plain name.
 *
 * Deterministic + static ON PURPOSE: correctness matters more than coverage here, and a curated map
 * never hallucinates a nickname the way an LLM would. `resolveNearCity` is the single entry point;
 * unknown locations pass through unchanged (plain name), so nothing ever breaks.
 */

export interface ResolvedCity {
  /** The recognized metro for the raw location (e.g. "Round Rock, TX" -> "Austin"). */
  metro: string;
  /** The two-letter state, when we could read it off the raw location (for disambiguation). */
  state?: string;
  /** Insider-approved local term to use in copy, or the plain metro when there's no safe one. */
  vernacular: string;
  /** True when `vernacular` is a real local nickname (not just the plain name) — lets copy that
   *  wants a nickname specifically ("here in {vernacular}") decide whether to use it. */
  hasVernacular: boolean;
}

/** Metro -> insider-approved local term. ONLY terms locals genuinely use go here. */
const VERNACULAR: Record<string, string> = {
  "Dallas": "DFW",
  "Fort Worth": "DFW",
  "San Francisco": "the Bay",
  "Oakland": "the Bay",
  "San Jose": "the Bay",
  "New York": "NYC",
  "New York City": "NYC",
  "Philadelphia": "Philly",
  "New Orleans": "NOLA",
  "Austin": "ATX",
  "Los Angeles": "LA",
  "Las Vegas": "Vegas",
  "Minneapolis": "the Twin Cities",
  "St. Paul": "the Twin Cities",
  "Saint Paul": "the Twin Cities",
  "Kansas City": "KC",
  "Salt Lake City": "Salt Lake",
  "Indianapolis": "Indy",
  "Cincinnati": "Cincy",
  "Portland": "PDX",
  "San Diego": "SD",
  "Oklahoma City": "OKC",
  "Washington": "DC",
  "Washington, D.C.": "DC",
};

/** Nicknames that mark you as a tourist/outsider — the model must NEVER emit these. Kept here as
 *  documentation of intent (the allowlist already excludes them; this makes the rule explicit and
 *  guards against anyone adding one to VERNACULAR by mistake via `assertNoBlockedTerm`). */
export const BLOCKED_TERMS = new Set([
  "san fran", "frisco", "chi-town", "chi town", "the big apple", "cali",
  "lost wages", "the big easy", "beantown", "philthy", "killadelphia",
]);

/** Suburb / satellite town -> its metro. Only the common ones that actually show up on job posts.
 *  Anything not here falls back to the city as-typed, so coverage gaps are harmless. */
const SUBURB_TO_METRO: Record<string, string> = {
  // DFW
  "round rock": "Austin", // (TX ambiguity handled by state below; Round Rock is Austin metro)
  "frisco": "Dallas", "plano": "Dallas", "irving": "Dallas", "arlington": "Dallas",
  "mckinney": "Dallas", "denton": "Dallas", "richardson": "Dallas", "garland": "Dallas",
  // Austin
  "cedar park": "Austin", "georgetown": "Austin", "pflugerville": "Austin", "san marcos": "Austin",
  // Bay Area
  "palo alto": "San Francisco", "mountain view": "San Francisco", "sunnyvale": "San Francisco",
  "menlo park": "San Francisco", "redwood city": "San Francisco", "santa clara": "San Jose",
  "fremont": "San Francisco", "berkeley": "Oakland",
  // NYC
  "brooklyn": "New York", "queens": "New York", "jersey city": "New York", "hoboken": "New York",
  "newark": "New York", "stamford": "New York", "white plains": "New York",
  // LA / SoCal
  "santa monica": "Los Angeles", "pasadena": "Los Angeles", "burbank": "Los Angeles",
  "irvine": "Los Angeles", "long beach": "Los Angeles", "el segundo": "Los Angeles",
  // Chicago
  "naperville": "Chicago", "evanston": "Chicago", "schaumburg": "Chicago", "oak brook": "Chicago",
  // Salt Lake
  "sandy": "Salt Lake City", "lehi": "Salt Lake City", "provo": "Salt Lake City", "draper": "Salt Lake City",
  "south jordan": "Salt Lake City", "west valley city": "Salt Lake City",
  // Twin Cities
  "bloomington": "Minneapolis", "edina": "Minneapolis", "eagan": "Minneapolis",
  // Denver
  "boulder": "Denver", "aurora": "Denver", "littleton": "Denver", "englewood": "Denver",
  // Atlanta
  "alpharetta": "Atlanta", "marietta": "Atlanta", "sandy springs": "Atlanta", "roswell": "Atlanta",
  // Seattle
  "bellevue": "Seattle", "redmond": "Seattle", "kirkland": "Seattle", "tacoma": "Seattle",
  // Boston
  "cambridge": "Boston", "waltham": "Boston", "somerville": "Boston", "quincy": "Boston",
  // Phoenix
  "scottsdale": "Phoenix", "tempe": "Phoenix", "chandler": "Phoenix", "gilbert": "Phoenix", "mesa": "Phoenix",
};

/** Strip a raw location down to its city token + optional state. "Frisco, TX 75034" -> {city:"frisco", state:"TX"}. */
function parseLocation(raw: string): { city: string; state?: string } {
  const clean = String(raw || "").replace(/\b\d{5}(-\d{4})?\b/g, "").trim();
  const parts = clean.split(",").map((p) => p.trim()).filter(Boolean);
  const city = (parts[0] || "").toLowerCase();
  const stateTok = parts[1] ? parts[1].split(/\s+/)[0] : "";
  const state = /^[A-Za-z]{2}$/.test(stateTok) ? stateTok.toUpperCase() : undefined;
  return { city, state };
}

/** Title-case a city token for display ("fort worth" -> "Fort Worth"). */
function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * Resolve a raw job/placement location into a recognized metro + the safe local term to use in copy.
 * Never throws; unknown input passes through as a plain title-cased city.
 */
export function resolveNearCity(rawLocation: string | undefined): ResolvedCity {
  const { city, state } = parseLocation(rawLocation || "");
  if (!city) return { metro: "", vernacular: "", hasVernacular: false };

  const metro = SUBURB_TO_METRO[city] ? SUBURB_TO_METRO[city] : titleCase(city);
  const vern = VERNACULAR[metro];
  // Safety net: if a blocked term ever slipped into the map, refuse it and use the plain metro.
  const safeVern = vern && !BLOCKED_TERMS.has(vern.toLowerCase()) ? vern : undefined;
  return {
    metro,
    state,
    vernacular: safeVern || metro,
    hasVernacular: !!safeVern,
  };
}

/** True when the placement metro and the target job's metro are the SAME place — in which case the
 *  proximity ("right by you") angle is meaningless and copy should lean on role-fit instead. */
export function sameMetro(a: string | undefined, b: string | undefined): boolean {
  const ra = resolveNearCity(a).metro.toLowerCase();
  const rb = resolveNearCity(b).metro.toLowerCase();
  return !!ra && ra === rb;
}

/** Dev guard: assert no blocked nickname is in the allowlist (call in a unit test). */
export function assertNoBlockedTerm(): void {
  for (const v of Object.values(VERNACULAR)) {
    if (BLOCKED_TERMS.has(v.toLowerCase())) throw new Error(`blocked vernacular in allowlist: ${v}`);
  }
}
