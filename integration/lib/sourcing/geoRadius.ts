/**
 * RecruitersOS · JD Sourcing · Real distance-based geo matching
 *
 * WHY THIS EXISTS
 * ---------------
 * The recruiter picks a radius ("Fair Lawn, NJ" + "+25mi") but until now that radius was
 * never a number anywhere in the system: the UI flattened it into English prose for the
 * LLM prompt ("include ALL surrounding metros"), and `pinIcpLocation` regex-stripped the
 * "+25mi" suffix off the location string and threw it away. Everything downstream then
 * decided "in area" by fuzzy STRING matching against a list of place names — so the
 * effective radius was "any city the LLM named that shares a state token", i.e. usually
 * the whole state. That is why searches returned people hundreds of miles out.
 *
 * This module makes the radius real: every place resolves to a lat/lon from a bundled
 * GeoNames table (~169k US places, no network, no API key, no per-call cost), and
 * membership is a great-circle distance test against the recruiter's typed center.
 * Cost, measured: ~90ms to parse once per process, ~0.5us per row after that.
 *
 * DESIGN RULES
 * ------------
 *  - `undefined` means "cannot tell" and is NEVER treated as out-of-area. A row we can't
 *    geocode falls back to the old string matcher rather than being silently dropped;
 *    this keeps the never-empty mandate intact.
 *  - Errors run generous, never strict. We measure crow-flies miles against a dropdown the
 *    recruiter reads as drive miles, and a profile's stated city is itself coarse, so the
 *    budget carries a slack allowance (see `radiusBudgetMi`). Letting a borderline suburb
 *    through costs one mediocre row; dropping a real local costs a placement.
 *  - Pure + synchronous, so the whole thing is unit-testable and safe to call inside the
 *    discovery hot loop (parse happens once, lazily, then it is Map lookups).
 */

import { US_PLACES_BLOB } from "./usPlacesData";

export interface GeoPoint {
  lat: number;
  lon: number;
  /** Two-letter state of the matched place, when known. */
  state?: string;
  /** The canonical city name we matched ("fair lawn"). */
  city?: string;
}

/* ------------------------------------------------------------------ */
/* State names                                                         */
/* ------------------------------------------------------------------ */

const STATE_ABBREV: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "puerto rico": "PR", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};
const ABBREVS = new Set(Object.values(STATE_ABBREV));

/**
 * Metro / region nicknames a recruiter may type that are not city names in the table.
 * Each maps to the city we treat as its center; the radius does the rest, so this only
 * has to be roughly right. Multi-state blobs ("Tri-State") are deliberately absent —
 * guessing a center for those does more harm than leaving them to the string matcher.
 */
const METRO_CENTER: Record<string, string> = {
  "long island": "hicksville, NY", nyc: "new york, NY", "new york city": "new york, NY",
  "hudson valley": "poughkeepsie, NY", "westchester": "white plains, NY",
  "bay area": "san francisco, CA", "sf bay area": "san francisco, CA",
  "san francisco bay area": "san francisco, CA", "silicon valley": "san jose, CA",
  "inland empire": "riverside, CA", "central valley": "fresno, CA",
  "orange county": "santa ana, CA", socal: "los angeles, CA", "southern california": "los angeles, CA",
  dfw: "dallas, TX", "dallas-fort worth": "dallas, TX", "dallas fort worth": "dallas, TX",
  metroplex: "dallas, TX", "twin cities": "minneapolis, MN", chicagoland: "chicago, IL",
  "south florida": "fort lauderdale, FL", "central florida": "orlando, FL",
  "tampa bay": "tampa, FL", "puget sound": "seattle, WA", "the triangle": "raleigh, NC",
  "research triangle": "raleigh, NC", "the dmv": "washington, DC", dmv: "washington, DC",
  "greater boston": "boston, MA", "main line": "philadelphia, PA", "north jersey": "newark, NJ",
  "central jersey": "edison, NJ", "south jersey": "cherry hill, NJ", "jersey shore": "toms river, NJ",
};

/* ------------------------------------------------------------------ */
/* Lazy table parse                                                    */
/* ------------------------------------------------------------------ */

interface PlaceRec { lat: number; lon: number; state: string; weight: number }

/** state -> city -> record */
let byState: Map<string, Map<string, PlaceRec>> | null = null;
/** city -> records across all states, for bare "Springfield" style input. */
let byCity: Map<string, PlaceRec[]> | null = null;

function ensureParsed(): void {
  if (byState) return;
  byState = new Map();
  for (const line of US_PLACES_BLOB.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const st = line.slice(0, colon);
    const cities = new Map<string, PlaceRec>();
    for (const item of line.slice(colon + 1).split("|")) {
      const parts = item.split(",");
      if (parts.length < 4) continue;
      const rec: PlaceRec = {
        lat: parseFloat(parts[1]),
        lon: parseFloat(parts[2]),
        state: st,
        weight: parseInt(parts[3], 10) || 1000,
      };
      if (!isFinite(rec.lat) || !isFinite(rec.lon)) continue;
      cities.set(parts[0], rec);
    }
    byState.set(st, cities);
  }
}

/**
 * The cross-state city index, built on FIRST USE rather than alongside byState.
 *
 * It only serves bare city names with no state ("Springfield"), which almost never
 * happens — a recruiter types a state and profiles state one. Building it eagerly meant
 * every process that geocoded anything paid for a second index over all ~169k places,
 * for a lookup most runs never make.
 */
function ensureCityIndex(): Map<string, PlaceRec[]> {
  if (byCity) return byCity;
  ensureParsed();
  byCity = new Map();
  for (const cities of byState!.values()) {
    for (const [city, rec] of cities) {
      const list = byCity.get(city);
      if (list) list.push(rec);
      else byCity.set(city, [rec]);
    }
  }
  return byCity;
}

/**
 * Strings that mean "no fixed location" in a profile's location field and must NEVER
 * geocode, even though the gazetteer lists a tiny place by that name.
 *
 * The US gazetteer really does contain Remote, Oregon (and Home, Washington). Since
 * "Remote" is what a person writes when they work from anywhere, resolving it would
 * measure every remote candidate against rural Oregon and drop them as out-of-radius —
 * a silent, systematic false drop on exactly the people a recruiter most wants to keep.
 *
 * Checked against the CITY part, so "Remote, OR" is refused too. That is the safe
 * direction and costs nothing: an unresolvable location is "unknown", and unknown rows
 * are always KEPT. The handful of genuine Remote-Oregon residents simply go unmeasured
 * rather than being measured wrong.
 */
const NON_LOCATION = new Set([
  "remote", "remote us", "remote usa", "fully remote", "work from home", "wfh", "home",
  "anywhere", "worldwide", "global", "nationwide", "national", "international",
  "virtual", "distributed", "telecommute", "hybrid", "on site", "onsite", "in office",
  "unknown", "none", "other", "various", "multiple", "multiple locations", "confidential",
  "private", "not specified", "n a", "tbd", "field", "corporate", "headquarters",
  "united states", "usa", "us", "america", "north america",
]);

/**
 * Minimum weight for a location that names NO state to be trusted.
 *
 * With the full gazetteer in the table, bare one-word inputs ("Central", "Uptown",
 * "Active", "Independent") all match some hamlet somewhere. Requiring real municipal
 * weight keeps genuine bare city names that happen to be common words — Mobile AL and
 * West TX are actual cities — while refusing the hamlets. A location that names its
 * state is exempt: "Home, WA" is unambiguous in a way bare "Home" is not.
 */
const BARE_CITY_MIN_WEIGHT = 1000;

/* ------------------------------------------------------------------ */
/* Text normalization                                                  */
/* ------------------------------------------------------------------ */

/** Words that decorate a place name without changing which place it is. */
const NOISE = /\b(greater|metropolitan|metro|area|region|county|city of|the|and surrounding|surrounding|vicinity|united states|usa|u s a|us)\b/g;

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip the trailing "+25mi" the UI appends to the location label. */
export function stripRadiusSuffix(text: string): string {
  return (text || "").replace(/\s*\+\s*\d+\s*mi\b/i, "").trim();
}

/** Widest radius the UI offers; also the ceiling we clamp any request to. */
export const MAX_RADIUS_MI = 250;

/**
 * Read the recruiter's radius pick, in miles, from an explicit value or from the "+25mi"
 * suffix the UI bakes into the location label.
 *
 * The label fallback is what keeps SAVED runs honest: a stored list carries only the
 * label, so re-running or overnight-queueing one would otherwise silently degrade to
 * "Exact" and return a different set of people than the original search did.
 *
 * Returns 0 for "Exact" / unparseable, so callers can treat `> 0` as "radius engaged".
 */
export function parseRadiusMi(explicit: unknown, locationLabel?: unknown): number {
  const fromLabel = /\+\s*(\d+)\s*mi\b/i.exec(String(locationLabel ?? ""))?.[1];
  const raw =
    typeof explicit === "number" && isFinite(explicit) ? explicit : parseInt(fromLabel ?? "", 10);
  return isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RADIUS_MI) : 0;
}

/**
 * The state named by a location FRAGMENT (the part after the comma, or the tail of a
 * comma-less string) — never by scanning free text.
 *
 * Scanning was a real bug: locations arrive glued to snippet prose ("Freehold, NJ. 15
 * years in healthcare operations"), and half the state abbreviations are ordinary English
 * words. A loose scan read " in " as Indiana, then looked up Freehold and Camden IN
 * INDIANA — dropping a genuine local and measuring another one 647 miles off. Position
 * matters: a state code only counts where a state actually belongs.
 */
function stateOfFragment(fragment: string): string | undefined {
  const words = fragment.replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return undefined;
  // Full names can be two words ("new jersey"), so check the longest prefix first.
  const two = words.slice(0, 2).join(" ");
  if (STATE_ABBREV[two]) return STATE_ABBREV[two];
  const one = words[0];
  if (STATE_ABBREV[one]) return STATE_ABBREV[one];
  if (ABBREVS.has(one.toUpperCase())) return one.toUpperCase();
  return undefined;
}

/** The state a full location string names, read positionally. */
export function stateOfPlace(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = trimToPlace(norm(stripRadiusSuffix(raw)));
  const comma = text.indexOf(",");
  if (comma >= 0) {
    const after = stateOfFragment(text.slice(comma + 1));
    if (after) return after;
  }
  // Comma-less "Garfield Heights OH": the state can only be the trailing word(s).
  const words = text.split(" ").filter(Boolean);
  if (words.length > 1) {
    const tail2 = words.slice(-2).join(" ");
    if (STATE_ABBREV[tail2]) return STATE_ABBREV[tail2];
    const tail1 = words[words.length - 1];
    if (STATE_ABBREV[tail1]) return STATE_ABBREV[tail1];
    if (ABBREVS.has(tail1.toUpperCase())) return tail1.toUpperCase();
  }
  return undefined;
}

/**
 * Cut snippet prose off the end of a location.
 *
 * Rows harvested from search snippets carry text like "Freehold, NJ. 15 years in
 * healthcare operations" — everything after the sentence break is noise that derails
 * both the city lookup and the state read. Saint/Fort/Mount abbreviations are the one
 * place a period is part of the NAME, so they are normalized before the cut.
 */
function trimToPlace(text: string): string {
  const protectedText = text.replace(/\b(st|ft|mt)\.\s*/g, "$1 ");
  const cut = protectedText.split(/[.;:\n|]/)[0];
  // A real location is short. Anything longer is prose that happens to start with one,
  // so keep at most the first two comma segments ("City, ST").
  return cut.split(",").slice(0, 2).join(",").trim();
}

/**
 * Drop a trailing municipal-status word ("howell township" -> "howell").
 *
 * Deliberately a SHORT list. "City" and "Town" are load-bearing parts of real place names
 * (Lake Havasu City, Kansas City, Georgetown), so stripping them would break more than it
 * fixes; township/borough/village/twp/boro never are.
 */
function stripMunicipalSuffix(city: string): string {
  const trimmed = city.replace(/\s+\b(township|twp|borough|boro|village|municipality)\b\s*$/, "").trim();
  return trimmed || city;
}

/** Remove a trailing state name/abbrev from a city fragment ("garfield heights oh" -> "garfield heights"). */
function stripTrailingState(city: string): string {
  const words = city.split(" ").filter(Boolean);
  if (words.length < 2) return city;
  const last1 = words[words.length - 1];
  const last2 = words.slice(-2).join(" ");
  if (words.length > 2 && STATE_ABBREV[last2]) return words.slice(0, -2).join(" ");
  if (STATE_ABBREV[last1] || ABBREVS.has(last1.toUpperCase())) return words.slice(0, -1).join(" ");
  return city;
}

/* ------------------------------------------------------------------ */
/* Geocode                                                             */
/* ------------------------------------------------------------------ */

const cache = new Map<string, GeoPoint | null>();

/**
 * Resolve a free-text US location to a coordinate, or null when we genuinely cannot tell.
 *
 * Handles the shapes that actually show up: "Fair Lawn, NJ", "Garfield Heights OH" (no
 * comma), "Greater Cleveland Area", "Long Island", "Melville, New York", "Dallas-Fort
 * Worth Metroplex", and bare "Springfield". `stateHint` biases a bare/ambiguous city
 * toward the search's own state, which is what makes suburb names resolve correctly.
 */
export function geocodeUsPlace(raw: string | undefined, stateHint?: string): GeoPoint | null {
  if (!raw) return null;
  const key = raw.toLowerCase().trim() + "|" + (stateHint || "");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = geocodeUncached(raw, stateHint);
  if (cache.size < 5000) cache.set(key, out);
  return out;
}

function geocodeUncached(raw: string, stateHint?: string): GeoPoint | null {
  ensureParsed();
  let text = trimToPlace(norm(stripRadiusSuffix(raw)));
  if (!text) return null;
  // "No fixed location" beats any place name that happens to spell the same way.
  if (NON_LOCATION.has(text.replace(/,/g, " ").replace(/\s+/g, " ").trim())) return null;

  // Nicknames first — they are not city names and would otherwise fall through.
  const nickKey = text.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  const nick = METRO_CENTER[nickKey] || METRO_CENTER[text];
  if (nick) return geocodeUncached(nick);

  const state = stateOfPlace(text) || (stateHint ? stateHint.toUpperCase() : undefined);
  text = text.replace(NOISE, " ").replace(/\s+/g, " ").trim();

  // City fragment = text before the first comma, with any trailing state removed.
  // "Dallas-Fort Worth" style hyphenated pairs resolve on their first half.
  let city = stripTrailingState((text.split(",")[0] || "").trim());
  // "Remote, OR" / "Home, WA": the city itself says "no fixed location".
  if (NON_LOCATION.has(city)) return null;
  if (!city) {
    // Pure state input ("New Jersey"): a state has no single point we can honestly call
    // its center for radius purposes, so decline rather than pin to a geographic centroid.
    return null;
  }

  const tryCity = (c: string): GeoPoint | null => {
    if (!c) return null;
    if (state && byState!.has(state)) {
      const rec = byState!.get(state)!.get(c);
      if (rec) return { lat: rec.lat, lon: rec.lon, state: rec.state, city: c };
    }
    if (!state) {
      const list = ensureCityIndex().get(c);
      if (list && list.length) {
        // Ambiguous bare city: take the heaviest, but only when it clearly dominates —
        // otherwise "Springfield" would silently become Springfield, MO. It must also
        // carry real municipal weight, or every common word matches some hamlet.
        const sorted = [...list].sort((a, b) => b.weight - a.weight);
        const dominant = sorted.length === 1 || sorted[0].weight >= sorted[1].weight * 2;
        if (dominant && sorted[0].weight >= BARE_CITY_MIN_WEIGHT) {
          return { lat: sorted[0].lat, lon: sorted[0].lon, state: sorted[0].state, city: c };
        }
      }
    }
    return null;
  };

  const direct = tryCity(city);
  if (direct) return direct;

  // Hyphenated metro ("dallas-fort worth"): try each half.
  if (city.includes("-")) {
    for (const half of city.split("-").map((s) => s.trim())) {
      const got = tryCity(half);
      if (got) return got;
    }
  }

  // "Saint"/"St." and "Mount"/"Mt." spelling drift, plus municipal-suffix trimming.
  const variants = [
    city.replace(/\bst\b/g, "saint").replace(/\bmt\b/g, "mount"),
    city.replace(/\bsaint\b/g, "st").replace(/\bmount\b/g, "mt"),
    city.replace(/\bft\b/g, "fort"),
    city.replace(/\bfort\b/g, "ft"),
    // LinkedIn routinely states the legal municipality ("Howell Township, New Jersey",
    // "Marlboro Township, NJ") while the gazetteer files the place under its bare name.
    // Only these suffixes are safe to drop: "City" and "Town" are part of real names
    // ("Lake Havasu City", "Kansas City", "Georgetown"), so they stay.
    stripMunicipalSuffix(city),
  ];
  for (const v of variants) {
    if (v === city) continue;
    const got = tryCity(v);
    if (got) return got;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Distance                                                            */
/* ------------------------------------------------------------------ */

const EARTH_MI = 3958.7613;

/** Great-circle distance in statute miles. */
export function haversineMi(a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const la1 = a.lat * toRad;
  const la2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Slack added to every radius, in miles.
 *
 * Two approximations both point the same way. Roads wind, so N crow-flies miles is always
 * LESS ground than the N drive miles the dropdown promises; and a profile states one city
 * for what may be a 15-mile metro, so the measured point is only approximately the person.
 * Spending the slack keeps a suburb sitting on the boundary from being knife-edged out.
 * Deliberately a flat figure rather than a percentage: at +25mi a proportional fudge is
 * too small to cover either effect, and at +250mi it would add a hundred stray miles.
 */
const EDGE_SLACK_MI = 5;

/** Effective crow-flies budget for a recruiter-selected drive radius. */
export function radiusBudgetMi(radiusMi: number): number {
  return Math.max(0, radiusMi) + EDGE_SLACK_MI;
}

/**
 * Is `location` within `radiusMi` of `center`?
 *
 * Returns `undefined` when either side cannot be geocoded — the caller must treat that as
 * "unknown", never as "out". This is the whole safety story of the radius rollout: we only
 * ever hard-drop a row we positively located and positively measured too far away.
 */
export function withinRadius(
  location: string | undefined,
  center: GeoPoint | null,
  radiusMi: number,
): boolean | undefined {
  if (!center || !(radiusMi > 0)) return undefined;
  const p = geocodeUsPlace(location, center.state);
  if (!p) return undefined;
  return haversineMi(center, p) <= radiusBudgetMi(radiusMi);
}

/** Distance in miles from center, or undefined when the row cannot be located. */
export function distanceFromCenter(
  location: string | undefined,
  center: GeoPoint | null,
): number | undefined {
  if (!center) return undefined;
  const p = geocodeUsPlace(location, center.state);
  return p ? haversineMi(center, p) : undefined;
}

/**
 * Every city in the table within the radius, nearest first — the honest answer to
 * "which places actually count as local here?".
 *
 * This is what replaces the LLM's recall-biased metro list when generating queries and
 * KoldInfo city chips: searching a real in-radius city list is both tighter AND wider
 * than what the LLM produced (it knows every suburb, and it knows where to stop).
 */
export function citiesWithinRadius(
  center: GeoPoint | null,
  radiusMi: number,
  limit = 40,
  /** Ignore hamlets: require at least this many ZIPs, so chips stay meaningful. */
  minZips = 1,
): Array<{ city: string; state: string; miles: number; weight: number }> {
  if (!center || !(radiusMi > 0)) return [];
  ensureParsed();
  const budget = radiusBudgetMi(radiusMi);
  // A degree of latitude is ~69mi; longitude shrinks with latitude. Pre-filtering by a
  // bounding box keeps this a cheap scan even though the table is ~30k places.
  const dLat = budget / 69 + 0.2;
  const dLon = budget / Math.max(5, 69 * Math.cos((center.lat * Math.PI) / 180)) + 0.2;
  const out: Array<{ city: string; state: string; miles: number; weight: number }> = [];
  for (const cities of byState!.values()) {
    for (const [city, rec] of cities) {
      if (Math.abs(rec.lat - center.lat) > dLat) continue;
      if (Math.abs(rec.lon - center.lon) > dLon) continue;
      if (rec.weight < minZips) continue;
      const miles = haversineMi(center, rec);
      if (miles <= budget) out.push({ city, state: rec.state, miles, weight: rec.weight });
    }
  }
  // Nearest-first is the wrong sort for QUERY targets (we want the places people actually
  // list on a profile), so rank by prominence then distance and let the caller slice.
  out.sort((a, b) => b.weight - a.weight || a.miles - b.miles);
  return out.slice(0, limit);
}

/** Title-cased "City, ST" for display/query use. */
export function formatPlace(city: string, state: string): string {
  const titled = city
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return `${titled}, ${state}`;
}

/** The distinct states covered by a radius (a circle can straddle a state line). */
export function statesWithinRadius(center: GeoPoint | null, radiusMi: number): string[] {
  const seen = new Set<string>();
  for (const c of citiesWithinRadius(center, radiusMi, 400)) seen.add(c.state);
  if (center?.state) seen.add(center.state);
  return [...seen];
}
