/**
 * RecruiterOS · In-Market · US-only geo filter
 *
 * The recruiter only works United States roles, so the pool, the live search, and the
 * background accumulator all filter to US locations — anything we can't positively confirm
 * as US (bare "Remote", "Worldwide", "Anywhere", or any non-US city/country) is dropped.
 *
 * Strategy: exclude on a strong NON-US marker first (this also resolves the ambiguous
 * comma-codes — "Toronto, CA" is caught by "toronto" before the ", CA" state test, "Berlin,
 * DE" by "berlin"), then include on a positive US marker (United States / USA / a US state
 * name or ", ST" abbreviation). No marker either way → excluded (we don't guess).
 */

const US_STATE_ABBR = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

const US_STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky",
  "louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi",
  "missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico",
  "new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania",
  "rhode island","south carolina","south dakota","tennessee","texas","utah","vermont",
  "virginia","west virginia","wisconsin","wyoming","district of columbia",
];

// Non-US markers (countries, regions, and the most common non-US cities in these feeds).
const NON_US = [
  "canada","canadian","toronto","vancouver","montreal","ottawa","calgary","edmonton","quebec",
  "united kingdom","u.k.","uk","england","scotland","wales","britain","london","manchester",
  "birmingham","leeds","glasgow","edinburgh","ireland","dublin","cork",
  "germany","deutschland","berlin","munich","munchen","münchen","hamburg","frankfurt","cologne","stuttgart",
  "france","paris","lyon","spain","madrid","barcelona","valencia","portugal","lisbon","porto",
  "netherlands","amsterdam","rotterdam","belgium","brussels","luxembourg","italy","rome","milan",
  "switzerland","zurich","geneva","austria","vienna","sweden","stockholm","norway","oslo",
  "denmark","copenhagen","finland","helsinki","poland","warsaw","krakow","czech","prague",
  "romania","bucharest","hungary","budapest","greece","athens","turkey","istanbul",
  "india","bangalore","bengaluru","mumbai","delhi","hyderabad","pune","chennai","gurgaon","noida",
  "pakistan","bangladesh","sri lanka","singapore","hong kong","malaysia","kuala lumpur","indonesia","jakarta",
  "philippines","manila","vietnam","thailand","bangkok","japan","tokyo","osaka","korea","seoul",
  "china","shanghai","beijing","shenzhen","taiwan","australia","sydney","melbourne","brisbane","perth",
  "new zealand","auckland","brazil","sao paulo","são paulo","rio de janeiro","mexico","guadalajara",
  "argentina","buenos aires","colombia","bogota","bogotá","chile","santiago","peru","lima",
  "south africa","johannesburg","cape town","nigeria","lagos","kenya","nairobi","egypt","cairo",
  "uae","dubai","abu dhabi","qatar","saudi","israel","tel aviv",
  "europe","european","emea","apac","latam","latin america","asia","africa","middle east","oceania",
  "worldwide","anywhere","global","international",
];

const US_SOURCE_CONNECTORS = new Set(["usaspending", "edgar", "warn_notice", "warn"]);

function hasWord(haystackLower: string, needle: string): boolean {
  const re = new RegExp("(^|[^a-z])" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)");
  return re.test(haystackLower);
}

/** Is this location text positively a United States location? */
export function isUsLocation(textRaw?: string): boolean {
  const t = (textRaw || "").trim();
  if (!t) return false;
  const low = t.toLowerCase();
  // 1) Strong non-US marker → out (also disambiguates ", CA"/", DE" via city names).
  for (const m of NON_US) if (hasWord(low, m)) return false;
  // 2) Positive US markers.
  if (/united states|u\.s\.a\.?|\busa\b/i.test(t)) return true;
  if (/\bUS\b/.test(t) || /\(US\)/i.test(t) || /\bU\.S\.?\b/.test(t)) return true;
  const m = t.match(/,\s*([A-Za-z]{2})(?:[^A-Za-z]|$)/);
  if (m && US_STATE_ABBR.has(m[1].toUpperCase())) return true;
  if (US_STATE_NAMES.some((s) => low.includes(s))) return true;
  return false;
}

/** Gather every location string attached to a signal (company HQ, hiring locations, evidence). */
function signalLocationText(s: any): string {
  const parts: string[] = [];
  const c = s?.company;
  if (c?.hqLocation?.raw) parts.push(String(c.hqLocation.raw));
  if (Array.isArray(c?.hiringLocations)) for (const h of c.hiringLocations) if (h?.raw) parts.push(String(h.raw));
  const ev = s?.evidence || {};
  if (typeof ev.location === "string") parts.push(ev.location);
  return parts.join(" | ");
}

/** US gate for a raw signal: a known-US source (federal/SEC/WARN) passes; otherwise the
 *  location must positively resolve to the US. */
export function isUsSignal(s: any): boolean {
  const connectors = Array.isArray(s?.sources) ? s.sources.map((x: any) => x?.connector) : [];
  if (connectors.some((c: string) => US_SOURCE_CONNECTORS.has(c))) return true;
  return isUsLocation(signalLocationText(s));
}

/** US gate for an InMarketLead (used at search time + pool purge). */
export function isUsLead(lead: { location?: string }): boolean {
  return isUsLocation(lead?.location);
}
