/**
 * RecruitersOS · Outreach · two more ways a "decision-maker" is not a buyer
 *
 * Both of these were found by reading the eleven messages that went out carrying
 * an invented growth claim (2026-08-21). Fixing the claim stopped the lie; it did
 * not stop us writing to the wrong people. These are the wrong people.
 *
 *  1. ADVISORY PRACTICES. A "Fractional CFO" or a "CFO Advisor for Small Business
 *     Owners" holds a C-level title and passes every seniority check we have. They
 *     also have no team, no req and no headcount budget: the finance work they
 *     post about is their CLIENTS'. One of the eleven had written about a CEO
 *     ringing THEM looking for a CFO, and we answered by offering to send them
 *     candidates.
 *
 *  2. FOREIGN POSTINGS FROM US-BASED PEOPLE. The market gate reads the POSTER's
 *     location, which is correct and was working. It cannot see that a US-based
 *     executive is announcing an office in Barcelona. The post-text screen that
 *     exists for exactly that matches COUNTRY names only, so "our new office in
 *     Barcelona" sailed through, as did a CFO at a company whose name ends "AB".
 *
 * Pure functions with no I/O so lib/linkedin/selftest.ts can hold them to the
 * collisions that make each one dangerous.
 */

/* ========================================================================== */
/* 1. Advisory / fractional practices                                          */
/* ========================================================================== */

/**
 * A fractional or interim engagement, or an advisory practice sold to owners.
 *
 * Anchored on the TITLE, never the company. "VP Finance at Acme Consulting" is a
 * real buyer at a consultancy; "Fractional CFO at Acme" is not a buyer at all.
 * Matching the company name would invert both.
 */
const ADVISORY_TITLE_RES: Array<{ re: RegExp; why: string }> = [
  {
    // "Fractional CFO", "Interim Controller", "Outsourced CFO", "Part-time CFO".
    re: /\b(?:fractional|interim|outsourced|part[-\s]?time)\s+(?:c[a-z]{1,2}o\b|chief\b|controller\b|vp\b|head\s+of\b|finance\s+director\b)/i,
    why: "runs a fractional or interim practice, so the team is a client's",
  },
  {
    // "CFO Advisor", "CFO Coach", "CFO Consultant", "Finance Consultant".
    re: /\b(?:c[a-z]{1,2}o|chief\s+financial\s+officer|controller|finance)\s+(?:advisor|advisory|consultant|coach|mentor)\b/i,
    why: "sells advisory services rather than running a finance team",
  },
  {
    // "Advisor to small business owners", "Consultant to founders / CEOs".
    re: /\b(?:advisor|advisory|consultant|coach)\s+(?:to|for)\s+(?:small\s+business|smb|business\s+owners?|founders?|ceos?|startups?|entrepreneurs?)\b/i,
    why: "advises other people's businesses rather than running one",
  },
  {
    re: /\bself[-\s]?employed\b/i,
    why: "is self-employed, so there is no team to hire into",
  },
  {
    // "I help business owners..." is the register of a solo practice, but only
    // when paired with a service word: plenty of real operators say "helping my
    // team", which must not match.
    re: /\bhelping\s+(?:small\s+business|business\s+owners?|founders?|ceos?|smbs?)\b/i,
    why: "markets a service to business owners",
  },
];

export interface AdvisoryInput {
  title?: string;
  headline?: string;
  /** Current roles as "Position at Company" strings, when known. */
  currentRoles?: string[];
}

/**
 * Returns why this person runs an advisory practice, or null.
 *
 * THE TRADE-OFF, STATED. Some fractional CFOs genuinely hire for their clients
 * and are real buyers. Blocking them costs those leads. Not blocking them costs
 * every advisor receiving a message about "your team growing", which is the exact
 * failure this file exists to stop, and which produces the reply that teaches a
 * recruiter to distrust the tool. Blocked, counted separately, and reversible by
 * deleting one call site.
 */
export function advisoryPracticeReason(input: AdvisoryInput): string | null {
  const fields = [input.title, input.headline, ...(input.currentRoles ?? [])];
  for (const raw of fields) {
    const text = (raw || "").trim();
    if (!text) continue;
    for (const p of ADVISORY_TITLE_RES) {
      if (p.re.test(text)) return p.why;
    }
  }
  return null;
}

/* ========================================================================== */
/* 2. Foreign postings                                                         */
/* ========================================================================== */

/**
 * Non-US business cities, chosen for LOW COLLISION with US place names.
 *
 * The omissions are the point. Manchester, Birmingham, Dublin, Naples, Rome,
 * Athens, Bristol, Vienna, Geneva, Valencia, Warsaw, Wellington, Melbourne,
 * Odessa, Lima and Vancouver are all substantial US cities as well, and a desk
 * that works the United States cannot afford to throw away a Manchester, New
 * Hampshire lead to catch a Manchester, England one. Their countries are already
 * covered by the country list; only the bare city name is ambiguous, so the bare
 * city name is what gets left out.
 */
const FOREIGN_CITIES = [
  "barcelona", "madrid", "seville", "bilbao", "lisbon", "porto",
  "london", "edinburgh", "glasgow", "leeds", "cardiff", "belfast",
  "paris", "lyon", "marseille", "toulouse",
  "berlin", "munich", "hamburg", "frankfurt", "cologne", "stuttgart", "dusseldorf", "düsseldorf",
  "amsterdam", "rotterdam", "utrecht", "the hague", "eindhoven",
  "brussels", "antwerp", "luxembourg",
  "zurich", "zürich", "basel", "bern", "lausanne",
  "milan", "turin", "bologna", "florence",
  "copenhagen", "stockholm", "gothenburg", "malmo", "malmö", "oslo", "helsinki", "reykjavik",
  "prague", "budapest", "bratislava", "ljubljana", "zagreb", "bucharest", "sofia",
  "kyiv", "kiev", "istanbul", "ankara",
  "toronto", "montreal", "ottawa", "calgary", "edmonton", "winnipeg", "mississauga",
  "mexico city", "guadalajara", "monterrey",
  "sao paulo", "são paulo", "rio de janeiro", "brasilia", "bogota", "bogotá",
  "medellin", "medellín", "buenos aires", "montevideo", "quito",
  "bangalore", "bengaluru", "mumbai", "hyderabad", "pune", "chennai", "gurgaon",
  "gurugram", "noida", "kolkata", "ahmedabad", "new delhi",
  "karachi", "lahore", "islamabad", "dhaka", "colombo", "kathmandu",
  "dubai", "abu dhabi", "doha", "riyadh", "jeddah", "tel aviv", "haifa",
  "cairo", "casablanca", "nairobi", "lagos", "accra", "johannesburg", "cape town",
  "tokyo", "osaka", "kyoto", "yokohama", "seoul", "busan",
  "shanghai", "beijing", "shenzhen", "guangzhou", "taipei",
  "manila", "cebu", "jakarta", "bangkok", "kuala lumpur", "ho chi minh", "hanoi",
  "sydney", "brisbane", "perth", "adelaide", "auckland", "christchurch",
];

/**
 * Foreign legal entity forms, matched only where a legal form actually appears:
 * at the END of the company name.
 *
 * ANCHORING IS THE WHOLE SAFETY MARGIN. Several of these letter pairs are the
 * start of perfectly American company names -- SL Green Realty is a New York
 * REIT, SAS Institute is in North Carolina -- and NV is also the postal
 * abbreviation for Nevada. Matched anywhere in the string, this list would
 * quietly delete good domestic leads, which is the failure that leaves no trace.
 * Matched only as a trailing suffix, "Einride AB" is Swedish and "SAS Institute"
 * is not. The selftest pins those collisions.
 */
const FOREIGN_ENTITY_SUFFIXES: Array<{ re: RegExp; where: string }> = [
  { re: /\bAB$/, where: "Sweden" },
  { re: /\bA\/S$/i, where: "Denmark" },
  { re: /\bASA$/, where: "Norway" },
  { re: /\bOyj?$/i, where: "Finland" },
  { re: /\bGmbH(?:\s*&\s*Co\.?\s*KG)?$/i, where: "Germany" },
  { re: /\bB\.?V\.?$/, where: "the Netherlands" },
  { re: /\bN\.?V\.?$/, where: "the Netherlands or Belgium" },
  { re: /\bS\.?A\.?S\.?$/, where: "France" },
  { re: /\bS\.?A\.?R\.?L\.?$/i, where: "France" },
  { re: /\bS\.?p\.?A\.?$/, where: "Italy" },
  { re: /\bS\.?L\.?$/, where: "Spain" },
  { re: /\bSp\.?\s?z\s?o\.?o\.?$/i, where: "Poland" },
  { re: /\bPLC$/i, where: "the United Kingdom" },
  { re: /\bPty\.?\s?Ltd\.?$/i, where: "Australia" },
  { re: /\bPte\.?\s?Ltd\.?$/i, where: "Singapore" },
  { re: /\bK\.?K\.?$/, where: "Japan" },
  { re: /\bAG$/, where: "Germany or Switzerland" },
];

/**
 * Does this post name somewhere in the United States?
 *
 * The abbreviations are matched CASE-SENSITIVELY and that is not a detail. Half
 * of them are ordinary English words - IN, OR, ME, OK, HI, DE, LA, MS, MA, MT -
 * so a case-insensitive test makes the phrase "hiring in Bengaluru" contain the
 * state of Indiana, and every foreign posting reads as domestic. The selftest
 * caught exactly that before this shipped. Full state names are safe to match
 * loosely; two-letter codes are only a state when written as one.
 */
const US_ABBR_RE = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_STATE_NAME_RE = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

function namesUsPlace(text: string): boolean {
  return US_ABBR_RE.test(text) || US_STATE_NAME_RE.test(text);
}

const LOCATION_CUE =
  "hiring|recruiting|role|roles|position|positions|job|jobs|opening|openings|vacancy|based|located|headquartered|office|offices|team|hub|expanding|launching|opened|opening up";

export interface ForeignPostInput {
  /** The post text, or whatever excerpt we have of it. */
  text?: string;
  /** The poster's company, checked for a foreign legal-entity suffix. */
  company?: string;
  /** Extra city tokens to treat as foreign (per-workspace tuning). */
  extraCities?: string[];
  /** Country names, passed in so this module does not own the market list. */
  countries?: string[];
}

/**
 * Why this POST is about somewhere we do not work, or null.
 *
 * A city only counts when a location cue puts it there ("office in Barcelona",
 * "hiring in Bengaluru"), never on a bare mention, because people name cities
 * for a hundred reasons. And nothing counts when a US state marker is present:
 * "our Dallas and London teams" is a domestic post that happens to mention
 * London, and dropping it would be the expensive mistake.
 */
export function foreignPostingReason(input: ForeignPostInput): string | null {
  const text = (input.text || "").trim();
  const company = (input.company || "").trim();

  // A foreign legal form on the employer is decisive on its own: it is a fact
  // about the company, not a guess about the post.
  if (company) {
    // Trim trailing punctuation so "Einride AB." still reads as a suffix.
    const co = company.replace(/[\s.,;:]+$/, "");
    for (const suffix of FOREIGN_ENTITY_SUFFIXES) {
      if (suffix.re.test(co)) return `${company} is registered in ${suffix.where}`;
    }
  }

  if (!text) return null;

  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Countries: allowed to match behind a cue, or as "City, Country".
  const countries = (input.countries ?? []).map(escape).join("|");
  if (countries) {
    const cueCountry = new RegExp(`\\b(?:${LOCATION_CUE})\\s+in\\s+(${countries})\\b`, "i");
    const cityComma = new RegExp(`[a-z][a-z .'-]{1,28},\\s*(${countries})\\b`, "i");
    const m = cueCountry.exec(text) ?? cityComma.exec(text);
    if (m) return `the post places the work in ${m[1].toLowerCase()}`;
  }

  // Cities: cue-anchored only, and never when the post also names a US state.
  const cities = [...FOREIGN_CITIES, ...(input.extraCities ?? [])].map(escape).join("|");
  const cueCity = new RegExp(`\\b(?:${LOCATION_CUE})\\s+(?:in|out\\s+of)\\s+(${cities})\\b`, "i");
  const hit = cueCity.exec(text);
  if (hit && !namesUsPlace(text)) {
    return `the post places the work in ${hit[1].toLowerCase()}`;
  }

  return null;
}
