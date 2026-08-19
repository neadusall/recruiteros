/**
 * RecruitersOS · LinkedIn Market Radar ("who is posting that they're hiring?")
 *
 * OTHER PEOPLE'S posts are the market (owner decision 2026-08-12: the radar
 * never scans the owner's own posts). Every tick (15 min by default):
 *
 *   1. one keyword search over Google's INDEX of linkedin.com/posts (Serper,
 *      then DataForSEO; rotating bank: "we are hiring", "looking to hire",
 *      ... - editable per workspace). The connected seat never runs the
 *      search (owner ask 2026-08-19); it only reads profiles and sends,
 *   2. every hit is gated: hiring intent in the text, a person (not a
 *      company page), decision-maker title, not a peer firm, DNC/cooldown,
 *   3. open-profile check picks the channel, and
 *   4. a hyper-targeted direct message is drafted off THEIR post.
 *
 * The commenter machinery below (replies/connects on items with kind
 * "commenter") remains for items already captured, but the scan no longer
 * creates them.
 *
 * NOTHING posts on its own: everything waits for one-tap approval in the
 * LinkedIn tab and goes out through requestLinkedInAction, so account caps,
 * health and the ledger all apply.
 *
 * HOT commenters (hiring decision-maker AND open roles) get BOTH a
 * connection-note draft and a reply draft, each independently one-tap
 * approvable; no forced ordering (owner decision 2026-08-12).
 *
 * SECOND LANE, "market scan" (owner decision 2026-08-12): keyword searches
 * across ALL of LinkedIn's posts (backend keyword bank, editable per
 * workspace) find hiring managers posting about talent they need. Each match
 * is gated (decision-maker title, hiring intent in the post, not a peer
 * firm, DNC) and then gets a hyper-targeted direct message built off their
 * post. Open profiles get it as a plain direct message (NEVER InMail); the
 * same personalized text goes as a connection note when their profile
 * cannot receive a stranger's DM.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso, rid } from "../core/ids";
import { classifyTitle } from "../signals/filters";
import { requestLinkedInAction } from "./os/engine";
import { listAccounts } from "./os/health";
import type { LiAccountState } from "./os/types";

const POSTS_TO_WATCH = 5;        // owner's most recent posts scanned per tick
const COMMENTS_PER_POST = 100;   // first page is plenty at this volume
const NEW_PER_TICK = 15;         // commenters fully processed per tick (rest next tick)
const SEEN_CAP = 8000;           // per-workspace dedupe memory
const ITEM_TTL_DAYS = 21;
// Market-scan pacing: one keyword search per tick (rotating through the
// bank), each hit costing a profile read, so the lane trickles steadily.
const MARKET_RESULTS_PER_SEARCH = 20;
const POSTER_NEW_PER_TICK = 8;   // DM drafts created per tick
const POSTER_RECHECK_DAYS = 7;   // never re-message the same author within a week
const CLOSED_PROFILE_DAYS = 30;  // remember closed profiles; no repeat profile reads
const MAX_POST_AGE_DAYS = 14;    // hard ceiling: never message about a stale post
const STATS_KEEP_DAYS = 14;      // hunt-economics history shown on the card

/** One day of hunt economics: what ran, what was spent, what the caches saved. */
export interface HuntDayStats {
  searches: number;       // discovery searches run (Unipile/Serper/DataForSEO)
  screened: number;       // posts screened by the free text gates
  profileReads: number;   // provider profile reads spent
  readsSaved: number;     // reads skipped by the closed-profile memory
  closedFound: number;    // fresh closed profiles discovered (now remembered)
  hiringChecks: number;   // job-board lookups spent (open profiles only)
  leads: number;          // decision-maker leads created with drafted DMs
  peersBlocked: number;   // recruiter/staffing posters vetoed by the wall
  comments?: number;      // public comments handed to the engine today
  bdHandoffs?: number;    // posters commented on that became BD prospects
}
const AUTO_PER_TICK = 10;        // autopilot approvals per tick (engine caps still apply)

/* ---------------- the public-comment lane (owner ask 2026-08-14) ---------
   A closed profile used to end the hunt: one profile read spent, the lead
   dropped, the person remembered as unreachable. Their POST is still open
   though, so this lane leaves a comment on it instead. The author gets the
   notification without us needing an open profile or a connection.

   A public comment is a different animal from a DM and is throttled like
   one. Three walls, all of them below the engine's own `interactions` cap:

     1. a per-day allowance that is JITTERED per workspace per day, so the
        desk never posts the same round number of comments two days running,
     2. a hard rolling 7-day ceiling that no jitter can lift, and
     3. a randomized minimum gap between comments, so a day's allowance can
        never go out as one burst.

   On top of that every draft is checked against the recent ones: near
   duplicate text across many posts is the single loudest automation tell,
   and it is the thing that gets comments silently hidden. */
// Owner spec 2026-08-15: 8 to 10 comments a day, every day. The jitter stays -
// a desk that posts the same round number daily is itself a pattern - but it is
// sized to land inside the asked-for band (9 +/- 15% = 8 to 10) rather than the
// wider 5-to-11 swing the old base carried.
const COMMENT_PER_DAY_DEFAULT = 9;     // before jitter
// The weekly ceiling has to clear seven days of the daily allowance or it, not
// the day, becomes the real limit: at the old 35 the lane could only sustain
// 5/day however high the daily number was set.
const COMMENT_PER_WEEK_DEFAULT = 63;   // hard rolling-7-day ceiling
const COMMENT_DAY_JITTER = 0.15;       // day allowance varies +/- 15%
const COMMENT_MIN_GAP_MIN = 24;        // floor of the randomized spacing
const COMMENT_MAX_GAP_MIN = 95;        // ceiling of the randomized spacing
const COMMENT_QUEUE_MULTIPLE = 2;      // draft at most 2 days of allowance
const COMMENT_LOG_KEEP_DAYS = 21;      // send log kept for the weekly window
const COMMENT_DUP_WINDOW = 25;         // recent comments checked for overlap
const COMMENT_DUP_RATIO = 0.6;         // >60% shared words = too similar
const MAX_COMMENT_CHARS = 400;         // well under LinkedIn's 1,250 ceiling
// Outcome tracking (owner ask 2026-08-19): how long a posted comment's thread
// is watched for the poster writing back, and how many threads each 15-min
// tick re-reads (round-robin, stalest first; at the lane's volume every live
// thread gets re-read well inside an hour).
const RESPONSE_WATCH_DAYS = 14;
const RESPONSE_CHECKS_PER_TICK = 6;

/** The keyword bank is the ROLES the desk places (owner decision 2026-08-13):
 *  each entry is a job title or phrase, searched against LinkedIn posts to
 *  find hiring managers posting that opening. The matched keyword becomes
 *  {job_title} in the MPC message. Editable on the card / keywords_set. */
// The desk is CFO / finance (owner decision 2026-08-15). Every keyword here is
// a finance leadership title, so both the hiring scenarios and the industry
// scenario below stay inside that market instead of reading as scattershot.
const DEFAULT_MARKET_KEYWORDS = [
  "CFO", "Chief Financial Officer", "Controller", "VP of Finance",
  "Director of Finance", "Assistant Controller", "FP&A Manager",
];

/**
 * The MPC DM bank: short, role-anchored, "my search just ended and the
 * runners-up are still warm" scripts. Deterministic fill ({job_title},
 * {first_name}), no AI in the hot path, each safely under the personal-DM
 * character threshold. House style: no em-dashes, no links, no exclamations.
 */
const MPC_DM_TEMPLATES = [
  // Owner's bank (2026-08-14): local-market proof anchored on {current_city},
  // pulled from the post itself, else the poster's profile location, else the
  // graceful "your market". House style: no em-dashes, no links.
  "{first_name}, saw your recent post for a {job_title} in {current_city} and thought I might be able to help. We filled a similar role there a few months back and still know a few strong candidates. Want me to reconnect with them?",
  "Saw your recent {job_title} post, {first_name}, and figured I'd reach out. We worked a similar search in {current_city} about 3 months ago and had a few great people we couldn't place. Happy to circle back with them.",
  "{first_name}, I came across your recent {job_title} post and thought I could help. We recently filled one in {current_city} and had several strong finalists. I can see if any are still open if that'd be useful.",
  "{first_name}, your {job_title} opening caught my eye. We filled a similar role in {current_city} a few months ago and met some really good people in the process. Want me to see who might still be open?",
  "We recently filled a {job_title} in {current_city}, so when I saw your opening I figured it was worth reaching out. I still know a couple strong candidates from that search. Want me to check their interest?",
  "Saw you're hiring a {job_title}, {first_name}. We just worked this market in {current_city} recently and had more good candidates than we could place. I'd be happy to reconnect with a few for you.",
  "{first_name}, saw your recent post and thought I might be able to save you some searching. We filled a similar {job_title} role in {current_city} recently and still have relationships with a few of the finalists. Interested?",
  "Your {job_title} post caught my attention. We were recruiting for a similar role in {current_city} a few months back, so we already know some of the talent in that market. Want me to make a few calls?",
  "{first_name}, we recently wrapped up a {job_title} search in {current_city}. A few candidates we really liked didn't get the final seat and may still be open. Happy to circle back with them for your role.",
  "Saw your recent post for a {job_title}, {first_name}. Coincidentally, we filled a similar role in {current_city} about 3 months ago. I can reach back out to a few people from that search and see who's still open.",
  "{first_name}, timing might actually be good here. We recently placed a {job_title} in {current_city} and still know a few strong people from that search. Want me to see if any would entertain your opportunity?",
  "We filled a similar {job_title} role in {current_city} recently, so we wouldn't exactly be starting from scratch on yours. I can reconnect with a few people we already know and see who's open. Worth doing?",
  "{first_name}, saw the {job_title} opening. We were just in the {current_city} market on a similar search and spoke with several people who could be worth revisiting. Want me to reach back out?",
  "Saw your recent hiring post and thought I'd reach out rather than send the usual recruiter pitch. We recently filled a {job_title} in {current_city} and still know a few strong people from that search. Want me to check?",
  "{first_name}, saw your post and thought this might actually be one we could help with quickly. We filled a similar {job_title} in {current_city} recently. I can reconnect with a few candidates from that search if useful.",
];
const MAX_DM_CHARS = 300;

/**
 * Search scenarios (owner ask 2026-08-13): suggested, pickable hunting
 * recipes shown as a dropdown on the card, plus custom phrases the owner
 * adds. Role-based scenarios run once per role keyword; the rest run as-is.
 */
export interface ScenarioPreset {
  id: string;
  label: string;
  hint: string;
  roleBased: boolean;
  /** The Google OR-group appended to the role / used standalone. */
  orGroup: string;
  /** Gate hits through HIRING_INTENT_RE (true) or accept any real post. */
  hiringIntent: boolean;
  dmBank: "mpc" | "growth";
  /** Role-based scenarios that are NOT about hiring pair the role with one of
   *  these topics for the Unipile post search, instead of "<role> hiring". */
  unipileTopics?: string[];
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "hiring_role", label: "Posting an opening for a role I place",
    hint: "They announced they are hiring one of your roles",
    roleBased: true, orGroup: `hiring OR "open role" OR "open position" OR "looking for" OR "join our team"`,
    hiringIntent: true, dmBank: "mpc",
  },
  {
    id: "urgent_backfill", label: "Urgent or backfill hires",
    hint: "Urgent, immediate, or backfill language on your roles",
    roleBased: true, orGroup: `urgent OR immediately OR backfill OR asap OR "start right away"`,
    hiringIntent: true, dmBank: "mpc",
  },
  {
    id: "struggling_to_fill", label: "Struggling to fill a role",
    hint: "Complaining a search is hard: your MPC lands best here",
    roleBased: true, orGroup: `"struggling to hire" OR "hard to fill" OR "hard to find" OR "cannot find" OR "third time posting"`,
    hiringIntent: false, dmBank: "mpc",
  },
  {
    id: "team_growth", label: "Announcing team growth",
    hint: "Growing, expanding, or doubling the team",
    roleBased: false, orGroup: `"growing our team" OR "expanding our team" OR "doubling our team" OR "scaling our team"`,
    hiringIntent: false, dmBank: "growth",
  },
  {
    id: "new_location", label: "Opening a new location",
    hint: "New office, clinic, or market: staffing follows",
    roleBased: false, orGroup: `("new office" OR "new clinic" OR "new location" OR "second location") (hiring OR "join our team" OR opening)`,
    hiringIntent: false, dmBank: "growth",
  },
  {
    id: "funding_growth", label: "Funding or rapid growth news",
    hint: "Raises and growth announcements: hiring comes next",
    roleBased: false, orGroup: `("we raised" OR "series a" OR "series b" OR "excited to announce" funding) (team OR hiring OR growing)`,
    hiringIntent: false, dmBank: "growth",
  },
  {
    // Owner ask 2026-08-15: comment on the industry conversation too, not only
    // on people advertising a job. Role-based, so it inherits the desk's own
    // keyword bank and cannot wander outside the market. No hiring intent is
    // required here - the point is to be a present peer on the posts finance
    // leaders actually write, which is also what stops the comment trail
    // reading as nothing but cold hiring-post replies.
    id: "industry_conversation", label: "Industry conversation in my market",
    hint: "Finance leaders talking shop: comment as a peer, no opening needed",
    roleBased: true,
    orGroup: `"close the books" OR "month end close" OR "month-end close" OR forecasting OR "audit season" OR "cash flow" OR budgeting OR "cost cutting" OR "board deck"`,
    hiringIntent: false, dmBank: "growth",
    unipileTopics: ["month end close", "forecasting", "cash flow", "budgeting", "audit season", "board deck", "cost cutting"],
  },
];
const DEFAULT_SCENARIOS = ["hiring_role", "urgent_backfill", "struggling_to_fill", "industry_conversation"];

/** Softer bank for growth/expansion scenarios where no specific opening was
 *  posted: still MPC-flavored, anchored on the desk's primary roles. */
const GROWTH_DM_TEMPLATES = [
  "Congrats on the growth. I recruit {job_title}s and usually have a couple of vetted people available. Happy to share profiles when hiring picks up.",
  "Saw the news about the team growing. If {job_title} hiring is on the roadmap, I have candidates worth meeting. Want a couple of profiles?",
  "Your growth post caught my eye. I keep a bench of vetted {job_title}s from active searches. Glad to send a few names when useful.",
];

/** Deterministic template pick + fill; trims to the DM threshold. */
function mpcDmFor(seed: string, jobTitle: string, firstName?: string, bank: "mpc" | "growth" = "mpc", city?: string): string {
  const pool = bank === "growth" ? GROWTH_DM_TEMPLATES : MPC_DM_TEMPLATES;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  let t = pool[h % pool.length];
  // No first name known: fall to a template that never mentions one.
  if (t.includes("{first_name}") && !firstName) {
    t = pool.find((x) => !x.includes("{first_name}")) ?? t.replace(/\{first_name\},?\s*/g, "");
  }
  const out = t
    .replace(/\{job_title\}/g, jobTitle)
    .replace(/\{first_name\}/g, firstName ?? "")
    .replace(/\{current_city\}/gi, city || "your market")
    .replace(/^,\s*/, "")
    .trim();
  return scrub(out).slice(0, MAX_DM_CHARS);
}

/* ---------------- {current_city} extraction (owner ask 2026-08-14) --------
   The city the role is IN, read from the post text first ("hiring a BCBA in
   Austin, TX"), else from the poster's profile location, else the graceful
   "your market" so no message ever ships with a hole or a wrong guess. ---- */

const CITY_STOPWORDS = new Set([
  "the", "our", "a", "an", "this", "that", "person", "healthcare", "health",
  "remote", "office", "clinic", "school", "person", "usa", "us", "america",
]);

/** Conservative post parse: only accept "in City, ST" / "in City, Statename"
 *  shapes - a bare "in Something" is too often not a place. */
export function cityFromPost(text: string): string | undefined {
  const m = /\bin\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*,\s*([A-Z]{2}\b|[A-Z][a-z]{3,})/.exec(text ?? "");
  if (!m) return undefined;
  const city = m[1].trim();
  if (CITY_STOPWORDS.has(city.toLowerCase())) return undefined;
  return city;
}

/** Profile location -> city: "Greater Chicago Area" -> "Chicago",
 *  "Austin, Texas Metropolitan Area" -> "Austin". */
export function cityFromLocation(location?: string): string | undefined {
  if (!location) return undefined;
  let c = location.split(",")[0].trim()
    .replace(/^Greater\s+/i, "")
    .replace(/\s+(Metropolitan\s+)?Area$/i, "")
    .replace(/\s+Metro(politan)?$/i, "");
  if (!c || c.length < 3 || /United States|Remote/i.test(c)) return undefined;
  return c;
}

/** Belt + suspenders on top of the keyword search: the post text itself must
 *  read like hiring intent, not just mention the keyword in passing. */
const HIRING_INTENT_RE = /\b(hiring|hire|open (role|position|req)|recruit(ing|er)?|looking for (a|an|someone)|join (our|the) team|growing (our|the) team|position (open|available)|role (open|available)|expanding (our|the) team|add(ing)? to (our|the) team)\b/i;

/** Off-market posters. LinkedIn's post search has no geography filter, so a
 *  "CFO hiring" query returns the whole world: the first live batch on the
 *  finance desk was three-quarters India, and the drafts talked confidently
 *  about the Chennai and Vadodara markets.
 *
 *  This used to be a denylist of countries we do not work, which let anything
 *  ambiguous through. Owner mandate 2026-08-15 inverted it: this desk works
 *  the UNITED STATES ONLY, so a poster now has to prove they are in it. A
 *  location that names no country and no state no longer squeaks past - it is
 *  refused like any other unknown, because a public comment about "your market"
 *  written to someone in Manchester or Mumbai is exactly the failure this gate
 *  exists to stop. Set ROLE_HUNTER_US_ONLY=0 to fall back to the old
 *  denylist-only behaviour if the desk ever works outside the US again.
 *  ROLE_HUNTER_OFF_MARKET (comma separated) still adds extra hard denies, and
 *  ROLE_HUNTER_US_EXTRA (comma separated) adds location tokens that should
 *  count as US, e.g. a metro spelling this list does not know yet. */
const OFF_MARKET_DEFAULT = [
  "india", "pakistan", "bangladesh", "sri lanka", "nepal",
  "united kingdom", "england", "scotland", "wales", "northern ireland",
  "ireland", "germany", "france", "spain", "portugal", "italy",
  "netherlands", "belgium", "sweden", "norway", "denmark", "finland", "poland",
  "romania", "ukraine", "turkey", "greece", "switzerland", "austria",
  "canada", "mexico", "brazil", "argentina", "colombia", "chile", "peru",
  "australia", "new zealand", "singapore", "malaysia", "indonesia", "philippines",
  "vietnam", "thailand", "japan", "china", "hong kong", "taiwan", "south korea",
  "united arab emirates", "saudi arabia", "qatar", "israel", "egypt",
  "nigeria", "kenya", "ghana", "south africa", "morocco",
  // Canadian provinces, because "Toronto, ON" and "London, Ontario" never say
  // "Canada" and would otherwise sail through the state-abbreviation check.
  "ontario", "quebec", "british columbia", "alberta", "manitoba",
  "saskatchewan", "nova scotia", "new brunswick", "newfoundland",
  // Collides with the state of Georgia; the country's capital disambiguates.
  "tbilisi",
];

/** The 50 states plus DC, spelled out. */
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia", "puerto rico",
];

/** Postal codes, matched only as a standalone comma-delimited segment, so
 *  "Austin, TX" passes and the "in" inside "Berlin" does not. */
const US_ABBR = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
  "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc", "pr",
]);

const US_COUNTRY_RE = /(^|[\s,(])(united states(\s+of\s+america)?|u\.?s\.?a\.?|u\.?s\.?)(\s*$|[\s,)])/;

function envList(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** True when the location positively resolves to somewhere in the US.
 *
 *  The last resort is the bundled GeoNames table that JD Sourcing already
 *  ships (~169k US places, no network, no key): it is the thing that knows
 *  "Greater Cleveland Area", "Dallas-Fort Worth Metroplex" and "Long Island"
 *  are US without a state or a country anywhere in the string. Imported
 *  lazily so the 5MB place blob is only parsed on a desk that actually runs
 *  this lane. */
async function looksUnitedStates(loc: string): Promise<boolean> {
  if (US_COUNTRY_RE.test(loc)) return true;
  if (envList("ROLE_HUNTER_US_EXTRA").some((t) => loc.includes(t))) return true;
  // A bare state abbreviation is NOT taken as proof on its own, because half
  // of them are also ISO country codes: "Munich, DE", "Bengaluru, IN" and
  // "Vancouver, CA" all end in a valid US postal code. The gazetteer settles
  // it by resolving the CITY inside that state, and returns null when the two
  // do not belong together (probe-verified 2026-08-15), so the collisions die
  // here while "Austin, TX" and "Wilmington, DE" live.
  try {
    const { geocodeUsPlace } = await import("../sourcing/geoRadius");
    if (geocodeUsPlace(loc)) return true;
  } catch { /* gazetteer unavailable: fall through */ }
  // Last resort for a town the gazetteer does not carry: a state spelled out
  // in full. Full names only, never the two-letter codes above.
  return US_STATES.some((s) => loc.includes(s));
}

/** Exported for the US-gate selftest; the lane calls it internally. */
export async function offMarketReason(location?: string): Promise<string | null> {
  const loc = (location ?? "").toLowerCase().trim();
  const extraDenies = envList("ROLE_HUNTER_OFF_MARKET");
  const usOnly = (process.env.ROLE_HUNTER_US_ONLY ?? "1") !== "0";
  // Hard denies run first, so a state name sitting next to a foreign country
  // ("London, Ontario", "Washington, England") can never buy a pass, and so a
  // bare foreign city cannot be rescued by the gazetteer's US namesake.
  for (const country of extraDenies.length ? extraDenies : OFF_MARKET_DEFAULT) {
    if (loc && loc.includes(country)) return `poster is in ${country}, outside this desk's market`;
  }
  if (!usOnly) return null;
  if (!loc) return "the poster's location is not shown, and this desk only works the United States";
  // A two-letter tail that is not a US postal code is a foreign subdivision:
  // "Toronto, ON" and "Vancouver, BC" never spell out Canada, and the
  // gazetteer would happily match them to Toronto, Ohio.
  const segs = loc.split(",").map((s) => s.trim()).filter(Boolean);
  const tailCode = (segs[segs.length - 1] ?? "").replace(/\s+\d{5}(-\d{4})?$/, "").trim();
  if (segs.length > 1 && /^[a-z]{2}$/.test(tailCode) && !US_ABBR.has(tailCode)) {
    return `"${location}" ends in a non-US region code`;
  }
  if (!(await looksUnitedStates(loc))) return `"${location}" is not a United States location, and this desk only works the United States`;
  return null;
}

/** Post-text screen, run BEFORE the paid profile read: a post that names where
 *  the job is, and names somewhere outside the US, is dropped for free.
 *
 *  Deliberately narrow, because the expensive mistake here is the false
 *  positive: a US company mentioning its offshore team ("our engineering team
 *  in India supports the Dallas hire") is a lead, not a foreign post, and the
 *  first cut of this regex threw it away. So the country has to arrive either
 *  directly behind a hiring cue ("hiring in Germany") or behind a place and a
 *  comma ("Manchester, United Kingdom"). A bare "in <country>" no longer
 *  counts. */
const FOREIGN_COUNTRIES = OFF_MARKET_DEFAULT.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const FOREIGN_POST_RES = [
  new RegExp(`\\b(?:hiring|recruiting|role|roles|position|positions|job|jobs|opening|openings|vacancy|based|located|headquartered)\\s+in\\s+(${FOREIGN_COUNTRIES})\\b`, "i"),
  new RegExp(`[a-z][a-z .'-]{1,28},\\s*(${FOREIGN_COUNTRIES})\\b`, "i"),
];
export function foreignPostReason(text: string): string | null {
  for (const re of FOREIGN_POST_RES) {
    const m = re.exec(text || "");
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export type CommentTier = "hot" | "warm" | "community";

export interface CommentLeadItem {
  id: string;
  workspaceId: string;
  /**
   * "commenter" = someone commented on the owner's post (default for
   * pre-lane items). "poster" = a BD decision-maker posted on LinkedIn while
   * their company has open roles; we DM them instead of commenting publicly.
   */
  kind?: "commenter" | "poster";
  /** commenter: the owner's post. poster: THEIR post. */
  postId: string;
  postExcerpt: string;
  postAt?: string;
  /** Source provenance (owner ask 2026-08-14): the actual post URL so the
   *  team can open and verify the source before approving. */
  postUrl?: string;
  /** commenter lane only: the comment itself. */
  commentId: string;
  commentText: string;
  commentAt?: string;
  /** poster lane: BD prospect linkage + the direct-message draft. */
  prospectId?: string;
  openProfile?: boolean;
  /** The role keyword that matched their post; becomes {job_title} in the DM. */
  matchedRole?: string;
  /** Which connected seat found them and sends the DM (multi-account rota). */
  accountId?: string;
  dmText?: string;
  dmStatus?: "suggested" | "approved" | "skipped" | "blocked";
  /**
   * poster lane, CLOSED profiles: the public comment drafted for THEIR post.
   * Distinct from commentText above, which is a comment someone left on the
   * owner's post. This is the only lane that ever writes in public, so it
   * carries its own throttle and its own no-pitch copy rules.
   */
  commentDraft?: string;
  commentStatus?: "suggested" | "approved" | "skipped" | "blocked";
  /**
   * Outcome tracking for a posted comment (owner ask 2026-08-19): approved
   * items leave the queue but land in the "Comments posted" tracker, which
   * watches the thread for the poster writing back and stages a threaded
   * reply when they do.
   */
  /** Ledger record id of the comment_post action; how posting is confirmed. */
  commentActionId?: string;
  /** Stamped when the ledger shows the provider accepted the comment. */
  commentPostedAt?: string;
  /** Our posted comment's provider id (ledger providerMessageId). */
  commentProviderId?: string;
  /** pending = engine has it; posted = live, watching the thread;
   *  responded = the poster wrote back; no_response = watch window expired;
   *  failed = the engine could not post it. */
  responseStatus?: "pending" | "posted" | "responded" | "no_response" | "failed";
  responseText?: string;
  responseAt?: string;
  /** Their reply's comment id: the threading anchor for our follow-up. */
  responseCommentId?: string;
  /** Round-robin cursor so each tick polls the stalest threads first. */
  responseCheckedAt?: string;
  /** The staged in-thread follow-up once they respond. */
  followUpText?: string;
  followUpStatus?: "suggested" | "approved" | "skipped" | "blocked";
  /** The commenter. */
  authorProviderId?: string;
  authorName: string;
  authorHeadline?: string;
  authorPublicUrl?: string;
  networkDistance?: string;
  /** Poster's profile location, kept so the market gate can be re-checked at
   *  approval time and not only at capture. */
  posterLocation?: string;
  title?: string;
  company?: string;
  seniority?: string;
  jobFunction?: string;
  decisionMaker: boolean;
  /** Peer = another staffing/search firm; goodwill only, never pitched. */
  peer: boolean;
  hiring?: { checked: boolean; openRoles: number; sample: string[]; source?: string };
  tier: CommentTier;
  /** Keyword-classified industry (taxonomy key) for industry-scoped autopilot. */
  industry?: string;
  /** The reply draft + its gate. "none" = not drafted (community default). */
  replyText?: string;
  replyStatus: "none" | "suggested" | "approved" | "skipped" | "blocked";
  /** Hot tier: the connection note is the FIRST touch, staged at detection. */
  connectText?: string;
  connectStatus?: "suggested" | "approved" | "skipped" | "blocked";
  /** Legacy field from the reply-first flow; no longer set. */
  connectAfter?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentWatchStatus {
  active: boolean;
  engineReady: boolean;
  aiReady: boolean;
  paused: boolean;
  reasons: string[];
}

interface OwnProfile { accountId: string; providerId: string; publicIdentifier?: string; name?: string }

interface WatchState {
  items: CommentLeadItem[];
  /** ws -> comment ids already processed (bounded FIFO). */
  seen: Record<string, string[]>;
  /** ws -> resolved own profile for the connected account. */
  ownProfile: Record<string, OwnProfile>;
  /** ws -> author providerId -> last time the market lane touched them (weekly gate). */
  posterSeen: Record<string, Record<string, string>>;
  /** ws -> author ref/providerId -> when we learned the profile is closed.
   *  Closed profiles are skipped for CLOSED_PROFILE_DAYS without spending
   *  another profile read (owner ask 2026-08-14: save credit usage). */
  closedProfiles: Record<string, Record<string, string>>;
  /** ws -> YYYY-MM-DD -> hunt economics for the monitoring strip
   *  (owner ask 2026-08-14: a place to watch what the radar spends). */
  dayStats: Record<string, Record<string, HuntDayStats>>;
  /** ws -> industries whose leads send WITHOUT approval (set-and-forget
   *  autopilot, owner ask 2026-08-14). Empty = industry autopilot off. */
  autoIndustries: Record<string, string[]>;
  /** ws -> keyword bank override (backend defaults when unset). */
  marketKeywords: Record<string, string[]>;
  /** ws -> rotation cursor into the keyword bank (one search per tick). */
  keywordCursor: Record<string, number>;
  /** ws -> active scenario selection (preset ids + custom phrases). */
  scenarios: Record<string, { presets: string[]; custom: Array<{ label: string; phrase: string }> }>;
  /** ws -> ISO timestamps of public comments actually handed to the engine.
   *  The day / rolling-week / spacing throttle is counted off this log, so it
   *  measures what really went out, never what was merely drafted. */
  commentLog: Record<string, string[]>;
  /** ws -> the last COMMENT_DUP_WINDOW comment texts sent, for the
   *  near-duplicate guard that keeps the lane from looking templated. */
  commentRecent: Record<string, string[]>;
  /** ws -> throttle override for the public-comment lane. */
  commentLimits: Record<string, { enabled: boolean; perDay: number; perWeek: number; autoPost?: boolean }>;
  /** ws -> last discovery-engine failure, surfaced on the card (break layer). */
  lastError: Record<string, string>;
  /** ws -> owner switched the listener off. */
  paused: Record<string, boolean>;
  /**
   * ws -> explicit autopilot override. When unset, autopilot follows the
   * workspace's BD Autopilot opt-in (an active BD campaign with autoRun), the
   * same hands-off signal the cadence/nurture ticks key off.
   */
  autoMode: Record<string, boolean>;
  lastScan: Record<string, string>;
  /** ws -> last comment-copy epoch whose open drafts were rewritten. Bump
   *  COMMENT_COPY_EPOCH when the public-comment rules change materially and
   *  every workspace's pending queue is rewritten once on its next scan. */
  redraftEpoch: Record<string, number>;
}

/** Bumped 2026-08-19: drafts must close with a call to action (owner ask).
 *  Epoch 2 same day: the epoch-1 rewrite hard-sliced two overlong drafts
 *  mid-word ("Happy to compare not") and let one closing formula repeat
 *  across the queue; rewrite once more with the sentence-safe fit and the
 *  variety brief in place. */
const COMMENT_COPY_EPOCH = 2;

const KEY = "linkedin_comment_watch_v1";
let state: WatchState = { items: [], seen: {}, ownProfile: {}, posterSeen: {}, closedProfiles: {}, dayStats: {}, autoIndustries: {}, marketKeywords: {}, keywordCursor: {}, scenarios: {}, commentLog: {}, commentRecent: {}, commentLimits: {}, lastError: {}, paused: {}, autoMode: {}, lastScan: {}, redraftEpoch: {} };

/* ---------------- industry classification + set-and-forget autopilot ------
   Owner ask 2026-08-14: pick industries in the UI, have the choice stick,
   and let leads in those industries send WITHOUT approval. The classifier
   is deterministic keywords over company + headline + post text (no AI in
   the hot path); everything not matching a chosen industry still waits for
   a human. Engine caps, health, and pacing still gate every autopilot send. */

const INDUSTRY_MATCHERS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "healthcare", label: "Healthcare & Life Sciences", re: /\b(health|clinic|medical|hospital|hospice|nurse|nursing|bcba|rbt|aba\b|behavior|therap|dental|pharma|patient|physician|slp|speech|occupational|home care|senior care|md\b|telehealth)\w*/i },
  { key: "fintech", label: "Finance & Fintech", re: /\b(fintech|bank|payment|lending|loan|insur|capital|invest|account(ing|ant)|cpa\b|controller|audit|wealth|credit|treasury|financ)\w*/i },
  { key: "saas", label: "SaaS & Software", re: /\b(saas|software|platform|b2b\b|cloud|devops|app\b|apps\b|crm\b|api\b)\w*/i },
  { key: "ecommerce", label: "E-commerce & Retail", re: /\b(e-?commerce|retail|marketplace|dtc\b|d2c\b|shopify|cpg\b|consumer goods|merchandis)\w*/i },
  { key: "ai_ml", label: "AI & Machine Learning", re: /\b(ai\b|artificial intelligence|machine learning|ml\b|llm|data scien|deep learning)\w*/i },
  { key: "cybersecurity", label: "Cybersecurity", re: /\b(cyber|infosec|security operations|soc analyst|appsec|pentest)\w*/i },
  { key: "edtech", label: "Education & EdTech", re: /\b(edtech|education|school|university|k-?12|teacher|tutor|learning)\w*/i },
  { key: "logistics", label: "Logistics & Supply Chain", re: /\b(logistic|supply chain|freight|warehouse|trucking|3pl\b|fleet|shipping)\w*/i },
  { key: "gaming", label: "Gaming", re: /\b(gaming|game studio|esports|game dev)\w*/i },
  { key: "climate", label: "Climate & Energy", re: /\b(climate|solar|renewable|clean energy|sustainab|ev\b|battery|wind power)\w*/i },
];

export function industryOf(text: string): string {
  for (const m of INDUSTRY_MATCHERS) {
    if (m.re.test(text)) return m.key;
  }
  return "general";
}

export function autoIndustriesFor(workspaceId: string): string[] {
  return state.autoIndustries[workspaceId] ?? [];
}

export async function setAutoIndustries(workspaceId: string, industries: string[]): Promise<string[]> {
  await hydrate();
  const valid = new Set([...INDUSTRY_MATCHERS.map((m) => m.key), "general"]);
  state.autoIndustries[workspaceId] = [...new Set(industries.map((i) => String(i).trim()).filter((i) => valid.has(i)))];
  save();
  return autoIndustriesFor(workspaceId);
}

function huntStatsFor(workspaceId: string): HuntDayStats {
  const day = nowIso().slice(0, 10);
  const ws = state.dayStats[workspaceId] ?? (state.dayStats[workspaceId] = {});
  const s = ws[day] ?? (ws[day] = { searches: 0, screened: 0, profileReads: 0, readsSaved: 0, closedFound: 0, hiringChecks: 0, leads: 0, peersBlocked: 0, comments: 0 });
  // Backfill for day rows written by older builds (avoids NaN on +=).
  if (s.peersBlocked === undefined) s.peersBlocked = 0;
  if (s.comments === undefined) s.comments = 0;
  if (s.bdHandoffs === undefined) s.bdHandoffs = 0;
  return s;
}
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<WatchState>(KEY);
      if (snap && Array.isArray(snap.items)) {
        state = {
          items: snap.items,
          seen: snap.seen ?? {},
          ownProfile: snap.ownProfile ?? {},
          posterSeen: snap.posterSeen ?? {},
          closedProfiles: snap.closedProfiles ?? {},
          dayStats: snap.dayStats ?? {},
          autoIndustries: snap.autoIndustries ?? {},
          marketKeywords: snap.marketKeywords ?? {},
          keywordCursor: snap.keywordCursor ?? {},
          scenarios: snap.scenarios ?? {},
          commentLog: snap.commentLog ?? {},
          commentRecent: snap.commentRecent ?? {},
          commentLimits: snap.commentLimits ?? {},
          lastError: snap.lastError ?? {},
          paused: snap.paused ?? {},
          autoMode: snap.autoMode ?? {},
          lastScan: snap.lastScan ?? {},
          redraftEpoch: snap.redraftEpoch ?? {},
        };
      }
      hydrated = true;
    })();
  }
  return hydrating;
}

/** An item the recruiter still needs to see: something is awaiting approval,
 *  or something went wrong (blocked never disappears silently). Approved and
 *  skipped items are done - they leave the card (owner ask 2026-08-13). */
function actionable(i: CommentLeadItem): boolean {
  return i.replyStatus === "suggested" || i.replyStatus === "blocked"
    || i.dmStatus === "suggested" || i.dmStatus === "blocked"
    || i.connectStatus === "suggested" || i.connectStatus === "blocked"
    || i.commentStatus === "suggested" || i.commentStatus === "blocked";
}

// 14 days (owner ask 2026-08-14): sent/skipped leads stay auditable - the
// team can trace any delivered message back to its source post well after
// the fact. They still leave the UI the moment they are resolved.
const RESOLVED_TTL_HOURS = 14 * 24;

function prune(): void {
  const cutoff = Date.now() - ITEM_TTL_DAYS * 86_400_000;
  // Resolved items (approved/skipped, nothing pending) are kept a day for
  // safety, then dropped; re-contact prevention lives in posterSeen/seen,
  // not here, so pruning them cannot cause a double touch.
  const resolvedCutoff = Date.now() - RESOLVED_TTL_HOURS * 3_600_000;
  // Community tier is retired (owner decision 2026-08-13): job seekers and
  // peers commenting on the owner's posts are noise, not leads. The radar
  // only surfaces people posting roles they need to fill; legacy community
  // items from older builds are dropped here.
  state.items = state.items.filter((i) => new Date(i.createdAt).getTime() >= cutoff && i.tier !== "community"
    && (actionable(i) || new Date(i.updatedAt).getTime() >= resolvedCutoff));
  // Closed-profile memory expires after CLOSED_PROFILE_DAYS: people do open
  // their profiles up or become connections; after a month we look again.
  const closedCutoff = Date.now() - CLOSED_PROFILE_DAYS * 86_400_000;
  for (const ws of Object.keys(state.closedProfiles)) {
    const m = state.closedProfiles[ws];
    for (const k of Object.keys(m)) {
      const raw = m[k];
      const iso = typeof raw === "string" && raw.startsWith("wall:") ? raw.slice(5) : raw;
      if (new Date(iso).getTime() < closedCutoff) delete m[k];
    }
  }
  // The comment send log only has to reach back one rolling week; a little
  // extra is kept so the card can show a short history without lying.
  const logCutoff = Date.now() - COMMENT_LOG_KEEP_DAYS * 86_400_000;
  for (const ws of Object.keys(state.commentLog)) {
    state.commentLog[ws] = state.commentLog[ws].filter((iso) => new Date(iso).getTime() >= logCutoff);
  }
  // Hunt-economics history: keep a rolling two weeks.
  const statsCutoff = new Date(Date.now() - STATS_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const ws of Object.keys(state.dayStats)) {
    const m = state.dayStats[ws];
    for (const day of Object.keys(m)) {
      if (day < statsCutoff) delete m[day];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Readiness                                                            */
/* ------------------------------------------------------------------ */

/** The Unipile account id to call the provider with: the executor's exact
 *  fallback chain. Live seats predate providerAccountId (seen null on ros
 *  2026-08-12, which held the radar in standby), so accountId is the id. */
function providerIdOf(a: LiAccountState): string | undefined {
  return a.providerAccountId || process.env.UNIPILE_ACCOUNT_ID || a.accountId || undefined;
}

async function connectedAccounts(workspaceId: string): Promise<LiAccountState[]> {
  try {
    const all = await listAccounts(workspaceId);
    return all.filter((a) => providerIdOf(a) && a.connected !== false && !a.killSwitch);
  } catch { return []; }
}

export async function commentWatchStatus(workspaceId: string): Promise<CommentWatchStatus> {
  await hydrate();
  const engineReady = (await connectedAccounts(workspaceId)).length > 0;
  const aiReady = !!process.env.ANTHROPIC_API_KEY;
  const paused = !!state.paused[workspaceId];
  const reasons: string[] = [];
  if (!engineReady) reasons.push("No LinkedIn account is connected to the engine yet.");
  if (!aiReady) reasons.push("The AI drafting key is not configured on the server.");
  if (paused) reasons.push("The listener is paused for this workspace.");
  return { active: engineReady && aiReady && !paused, engineReady, aiReady, paused, reasons };
}

export async function setCommentWatchPaused(workspaceId: string, paused: boolean): Promise<void> {
  await hydrate();
  state.paused[workspaceId] = paused;
  save();
}

/** Explicit on/off wins; otherwise the radar defaults to APPROVAL-FIRST
 *  (owner decision 2026-08-13: "I need to approve these first for now").
 *  The card's toggle turns hands-free sending on per workspace. */
export async function commentWatchAutopilot(workspaceId: string): Promise<{ enabled: boolean; source: "manual" | "default_on" | "off" }> {
  await hydrate();
  const manual = state.autoMode[workspaceId];
  if (typeof manual === "boolean") return { enabled: manual, source: manual ? "manual" : "off" };
  return { enabled: false, source: "off" };
}

export async function setCommentWatchAuto(workspaceId: string, on: boolean): Promise<void> {
  await hydrate();
  state.autoMode[workspaceId] = on;
  save();
}

/**
 * Autopilot: execute the open drafts hands-free through the shared engine
 * (caps, pacing, health, suppression all still apply there). Decision-makers
 * only: poster DMs first, then hot connects + replies, then warm replies.
 * Community items are never auto-sent.
 */
async function autoExecute(workspaceId: string): Promise<number> {
  const { enabled } = await commentWatchAutopilot(workspaceId);
  // Industry-scoped set-and-forget (owner ask 2026-08-14): leads classified
  // into a chosen industry send hands-free even when global autopilot is off.
  const inds = autoIndustriesFor(workspaceId);
  if (!enabled && !inds.length) return 0;
  const APPROVER = "comment-radar-autopilot";
  const rank = (i: CommentLeadItem): number =>
    i.kind === "poster" ? 0 : i.tier === "hot" ? 1 : i.tier === "warm" ? 2 : 3;
  const open = state.items
    .filter((i) => i.workspaceId === workspaceId && i.tier !== "community"
      && !wallForItem(i) // the recruiter wall: agency-side never auto-sends
      && (enabled || (i.industry !== undefined && inds.includes(i.industry)))
      && (i.dmStatus === "suggested" || i.replyStatus === "suggested" || i.connectStatus === "suggested"
        || i.commentStatus === "suggested"))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  let sent = 0;
  for (const item of open) {
    if (sent >= AUTO_PER_TICK) break;
    try {
      if (item.kind === "poster" && item.dmStatus === "suggested") {
        const r = await approveDm(workspaceId, "", APPROVER, item.id);
        if (r.accepted) sent++;
        continue;
      }
      if (item.commentStatus === "suggested") {
        // Autopilot does not post comments until the owner has switched it on
        // for this workspace, however wide open the rest of autopilot is. The
        // draft simply stays on the card waiting for a one-tap approval.
        if (!commentLimitsFor(workspaceId).autoPost) continue;
        // The throttle is re-read every time: one comment per tick at most,
        // and the spacing gate means the rest of a tick's backlog waits.
        // A refusal leaves the draft open for the next slot.
        if (commentThrottleFor(workspaceId).blockedReason) continue;
        const r = await approvePostComment(workspaceId, "", APPROVER, item.id);
        if (r.accepted) sent++;
        continue;
      }
      if (item.connectStatus === "suggested" && sent < AUTO_PER_TICK) {
        const r = await approveConnect(workspaceId, "", APPROVER, item.id);
        if (r.accepted) sent++;
      }
      if (item.replyStatus === "suggested" && sent < AUTO_PER_TICK) {
        const r = await approveReply(workspaceId, "", APPROVER, item.id);
        if (r.accepted) sent++;
      }
    } catch { /* next item */ }
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Public-comment throttle                                              */
/* ------------------------------------------------------------------ */

/** What the card shows and what approval checks against. */
export interface CommentThrottle {
  enabled: boolean;
  /** Whether autopilot may post these without a human approving each one.
   *  Off until the owner has read what the desk writes. */
  autoPost: boolean;
  /** The configured base. The allowance actually in force is jittered off it. */
  perDay: number;
  perWeek: number;
  /** Today's jittered allowance: stable for the whole day, different tomorrow. */
  todayAllowance: number;
  todayUsed: number;
  weekUsed: number;
  /** Set when spacing is the thing holding the next comment back. */
  nextSlotAt?: string;
  /** Set when a comment right now would be refused, and why. */
  blockedReason?: string;
}

function seedHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function commentLimitsFor(
  workspaceId: string,
): { enabled: boolean; perDay: number; perWeek: number; autoPost: boolean } {
  const c = state.commentLimits[workspaceId];
  return {
    enabled: c?.enabled ?? true,
    perDay: c?.perDay ?? COMMENT_PER_DAY_DEFAULT,
    perWeek: c?.perWeek ?? COMMENT_PER_WEEK_DEFAULT,
    // Auto-posting is the one thing here that defaults OFF (owner decision
    // 2026-08-15). A comment is public and cannot be deleted through the
    // client, so the first batch of a new desk is read before it goes out:
    // the lane drafts, the drafts wait on the card, and this switch is what
    // hands them to autopilot once the copy has been seen.
    autoPost: c?.autoPost ?? false,
  };
}

export async function setCommentLimits(
  workspaceId: string,
  next: { enabled?: boolean; perDay?: number; perWeek?: number; autoPost?: boolean },
): Promise<{ enabled: boolean; perDay: number; perWeek: number; autoPost: boolean }> {
  await hydrate();
  const cur = commentLimitsFor(workspaceId);
  const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  const perDay = int(next.perDay, 0, 40, cur.perDay);
  state.commentLimits[workspaceId] = {
    enabled: typeof next.enabled === "boolean" ? next.enabled : cur.enabled,
    perDay,
    // The week can never be tighter than a single day's base, or the day
    // allowance would be unreachable by construction.
    perWeek: Math.max(perDay, int(next.perWeek, 0, 200, cur.perWeek)),
    autoPost: typeof next.autoPost === "boolean" ? next.autoPost : cur.autoPost,
  };
  save();
  return commentLimitsFor(workspaceId);
}

/**
 * Today's allowance, jittered off the configured base. Seeded on workspace +
 * date so it is stable all day (the number on the card does not flap) and
 * different tomorrow: a desk that posts exactly 8 comments every single day
 * is a pattern, and patterns are what get looked at.
 */
function dayAllowanceFor(workspaceId: string, day: string): number {
  const { perDay } = commentLimitsFor(workspaceId);
  if (perDay <= 0) return 0;
  const r = (seedHash(`${workspaceId}:${day}:allow`) % 1000) / 1000;
  const factor = 1 - COMMENT_DAY_JITTER + r * 2 * COMMENT_DAY_JITTER;
  return Math.max(1, Math.round(perDay * factor));
}

/** The randomized spacing owed after the comment logged at `lastIso`. */
function gapMinutesFor(workspaceId: string, lastIso: string): number {
  const r = (seedHash(`${workspaceId}:${lastIso}:gap`) % 1000) / 1000;
  return Math.round(COMMENT_MIN_GAP_MIN + r * (COMMENT_MAX_GAP_MIN - COMMENT_MIN_GAP_MIN));
}

/** Day count, rolling-week count, and the most recent send. */
function commentUsage(workspaceId: string): { today: number; week: number; last?: string } {
  const log = state.commentLog[workspaceId] ?? [];
  const day = nowIso().slice(0, 10);
  const weekCutoff = Date.now() - 7 * 86_400_000;
  let today = 0;
  let week = 0;
  for (const iso of log) {
    if (iso.slice(0, 10) === day) today++;
    if (new Date(iso).getTime() >= weekCutoff) week++;
  }
  return { today, week, last: log.length ? log[log.length - 1] : undefined };
}

/**
 * The gate every public comment passes, autopilot and hand-approved alike.
 * Three walls in order of hardness: the rolling week, the jittered day, then
 * the randomized spacing. The engine's own `interactions` cap sits above all
 * of this and can still refuse after we say yes.
 */
export function commentThrottleFor(workspaceId: string): CommentThrottle {
  const limits = commentLimitsFor(workspaceId);
  const day = nowIso().slice(0, 10);
  const allowance = dayAllowanceFor(workspaceId, day);
  const use = commentUsage(workspaceId);
  const t: CommentThrottle = {
    enabled: limits.enabled,
    autoPost: limits.autoPost,
    perDay: limits.perDay,
    perWeek: limits.perWeek,
    todayAllowance: allowance,
    todayUsed: use.today,
    weekUsed: use.week,
  };
  if (!limits.enabled) {
    t.blockedReason = "The public-comment lane is switched off for this workspace.";
    return t;
  }
  if (use.week >= limits.perWeek) {
    t.blockedReason = `Weekly comment ceiling reached (${use.week} of ${limits.perWeek} in the last 7 days).`;
    return t;
  }
  if (use.today >= allowance) {
    t.blockedReason = `Today's comment allowance is used (${use.today} of ${allowance}).`;
    return t;
  }
  if (use.last) {
    const gap = gapMinutesFor(workspaceId, use.last);
    const readyAt = new Date(use.last).getTime() + gap * 60_000;
    if (Date.now() < readyAt) {
      t.nextSlotAt = new Date(readyAt).toISOString();
      t.blockedReason = `Spacing: the next comment is due in about ${Math.max(1, Math.round((readyAt - Date.now()) / 60_000))} minutes.`;
      return t;
    }
  }
  return t;
}

/** Log a comment that the engine accepted. Only accepted sends count. */
function recordComment(workspaceId: string, text: string): void {
  const log = state.commentLog[workspaceId] ?? (state.commentLog[workspaceId] = []);
  log.push(nowIso());
  const recent = state.commentRecent[workspaceId] ?? (state.commentRecent[workspaceId] = []);
  recent.push(text);
  if (recent.length > COMMENT_DUP_WINDOW) state.commentRecent[workspaceId] = recent.slice(-COMMENT_DUP_WINDOW);
  const stats = huntStatsFor(workspaceId);
  stats.comments = (stats.comments ?? 0) + 1;
  save();
}

/** Throttle internals, reachable from scripts/test-comment-throttle.mts so the
 *  day/week/spacing walls are testable without a live snapshot behind them. */
export const __throttleTestHooks = {
  dayAllowanceFor,
  tooSimilar,
  setLog: (workspaceId: string, log: string[]): void => { state.commentLog[workspaceId] = log; },
  setLimits: (workspaceId: string, l: { enabled: boolean; perDay: number; perWeek: number }): void => {
    state.commentLimits[workspaceId] = l;
  },
};

/** Everything a new draft must not read like: comments already posted, plus
 *  the ones still waiting for approval. */
function priorComments(workspaceId: string): string[] {
  const sent = state.commentRecent[workspaceId] ?? [];
  const queued = state.items
    .filter((i) => i.workspaceId === workspaceId && i.commentStatus === "suggested" && i.commentDraft)
    .map((i) => i.commentDraft as string);
  return sent.concat(queued);
}

/** Prompt-side variety steering. The dup guard rejects near-duplicates after
 *  the fact, but it cannot stop every draft closing on the same invitation
 *  ("Happy to compare notes...", seen 5 of 6 in the epoch-1 rewrite), because
 *  the observation carries the word-set while the closing formula repeats
 *  freely. Showing the model the most recent comments and telling it to shape
 *  its own differently kills the formula at the source. */
function varietyBrief(workspaceId: string, excluding?: string): string {
  const recent = priorComments(workspaceId).filter((t) => t !== excluding).slice(-4);
  if (!recent.length) return "";
  return `\n\nRECENT COMMENTS THIS ACCOUNT ALREADY LEFT (yours must open differently, be shaped differently, and close on a DIFFERENT invitation wording than every one of these):\n${recent.map((t) => `- ${t}`).join("\n")}`;
}

/** Fit a draft inside MAX_COMMENT_CHARS without ever cutting mid-word. The
 *  hard slice shipped "Happy to compare not" into the approval queue
 *  (2026-08-19); a chopped public comment reads as machine output, which is
 *  the one impression this lane must never give. Overlong drafts fall back to
 *  the last complete sentence that fits; when no full sentence fits, null,
 *  and the caller drops the draft rather than posting a fragment. */
function fitComment(text: string): string | null {
  if (text.length <= MAX_COMMENT_CHARS) return text;
  const head = text.slice(0, MAX_COMMENT_CHARS);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "),
    head.lastIndexOf(".\n"), head.lastIndexOf("?\n"), head.lastIndexOf("!\n"));
  if (cut < 60) return null;
  return head.slice(0, cut + 1).trim();
}

/** Content words only: the shape of the sentence, not its filler. */
function wordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
}

/**
 * The near-duplicate guard. Public comments that share most of their content
 * words across many posts are the loudest automation signal there is, and a
 * hidden comment gives no error back through the API, so this is checked
 * before a draft is ever stored rather than after it fails.
 */
function tooSimilar(text: string, recent: string[]): boolean {
  const a = wordSet(text);
  if (a.size < 4) return false;
  for (const prior of recent) {
    const b = wordSet(prior);
    if (b.size < 4) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    if (shared / Math.min(a.size, b.size) > COMMENT_DUP_RATIO) return true;
  }
  return false;
}

/** Belt on top of the prompt (owner ask 2026-08-15, loosened 2026-08-19).
 *  The original belt dropped ANY draft that made an offer or an ask, which
 *  produced comments so passive they gave the poster nothing to act on. Owner
 *  direction 2026-08-19: every draft should invite the poster to engage if
 *  they need help with the search, so offers and soft asks are now the POINT,
 *  not a leak. What still gets a draft dropped rather than queued (a bad
 *  public comment cannot be recalled after approval): hard-sell spam tells
 *  (scheduling links, guarantees, discount language), contact details, and
 *  any number nobody can stand behind. The post's own text is passed in
 *  because a figure the POSTER stated is fair to react to, while the same
 *  figure invented by us is not. */
const CTA_LEAK_RE = /\b(calendly|book (?:a|my|your) (?:call|meeting|demo|slot)|schedule a (?:call|meeting|demo)|guaranteed?|risk[- ]free|no[- ]obligation|free (?:trial|consultation|audit)|limited time|act now|special offer|discount|no placement,? no fee)\b/i;
const CONTACT_LEAK_RE = /(https?:\/\/|www\.|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b\d{3}[-.\s)]\s?\d{3}[-.\s]\d{4}\b)/i;

export function pitchLeakReason(text: string, postText: string): string | null {
  if (CTA_LEAK_RE.test(text)) return "reads as hard-sell spam";
  if (CONTACT_LEAK_RE.test(text)) return "carries a link or contact detail";
  // Every multi-digit number in the draft has to have come from their post.
  // Digit runs are compared rather than phrases, because the fabrication
  // arrives in any dress: "$178k", "40%", "92 days", "3 of the last 12". A
  // number the POSTER stated is fair to react to; anything else is a claim
  // this desk cannot stand behind in public. Spelled-out quantities ("four
  // months", "half your size") stay available and read better anyway.
  const postDigits = new Set((postText || "").match(/\d+/g) ?? []);
  for (const m of text.match(/\d[\d,.]*/g) ?? []) {
    const digits = m.replace(/[^\d]/g, "");
    if (digits.length >= 2 && !postDigits.has(digits)) return `invents a figure (${m.trim()})`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* LLM drafting                                                         */
/* ------------------------------------------------------------------ */

const MODEL = () =>
  process.env.RECRUITEROS_COMMENT_MODEL
  ?? process.env.RECRUITEROS_ENGAGE_MODEL
  ?? process.env.RECRUITEROS_LLM_MODEL
  ?? "claude-opus-4-8";

/** House style: no long dashes, no smart quotes, no leftover code fences. */
function scrub(text: string): string {
  return text
    .replace(/[—–]/g, ",")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^```[a-z]*\n?|```$/gm, "")
    .trim();
}

const REPLY_RULES = `You write replies to comments people leave on a recruiting agency owner's own LinkedIn posts. The reader must never suspect a machine wrote it.
Rules:
- Respond to the SUBSTANCE of their comment: extend their point with a concrete observation from recruiting/staffing, offer a short counterpoint, or ask them one genuine question back. Never restate their comment.
- 10 to 35 words. One or two sentences. No exclamation marks, no emoji, no hashtags, no long dashes.
- Address them by first name only when it reads naturally; skipping the name is fine.
- Banned openers: "Thanks for", "Great point", "Love this", "So true", "Appreciate you", "Couldn't agree more", "Spot on".
- Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align".
- If their comment touches hiring, an open role, or a search they are running, close with a short standing invitation to take it to messages: "happy to trade notes if you want a second set of eyes, just message me". An offer, never a demand.
- Otherwise never pitch services, never link, never suggest a call. The goal is one more genuine exchange in the thread. Never mention AI.
Return ONLY the reply text, nothing else.`;

const CONNECT_RULES = `You write short LinkedIn connection notes for a recruiting agency owner. The recipient just commented on one of the owner's posts; this note is the FIRST direct touch and arrives while their comment is still fresh. The reader must never suspect a machine wrote it.
Rules:
- Max 270 characters. Two sentences at most.
- Reference their comment naturally (their take under the post), not their profile or their company.
- One short clause noting the owner runs searches in their world and is glad to help if a search ever needs another set of eyes is allowed. Keep it an offer, not a pitch.
- No links, no "synergies", no emoji, no long dashes. Never mention AI.
Return ONLY the note text, nothing else.`;

const DM_RULES = `You write direct LinkedIn messages for a recruiting agency owner. The recipient is a hiring decision-maker who just published a LinkedIn post about a role they need to fill or talent they are looking for; this message goes straight to their inbox while the post is fresh. The reader must never suspect a machine wrote it.
Rules:
- Anchor the message in the SPECIFIC need from their post: the exact role, team, or hiring challenge they described, in their own framing. Never summarize their post back, never flatter.
- One low-key line that this exact kind of search is what the owner does all day.
- End with ONE clear, easy-to-answer call to action: offer to send over two or three strong profiles this week and ask if they want them, or ask if a ten-minute call about the search is worth their time. Make the ask direct enough that "yes" is a one-word reply. No links, no calendar links.
- 40 to 90 words. Short paragraphs. No exclamation marks, no emoji, no hashtags, no long dashes.
- Banned openers: "Great post", "Love this", "Hope you're well", "I came across", "I saw your post". Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align", "synergies".
- Never mention AI.
Return ONLY the message text, nothing else.`;

/**
 * The public-comment lane. Everything written under these rules is visible to
 * the poster's whole network, their own team, and every competing recruiter
 * watching that post.
 *
 * The pitch (owner ask 2026-08-15, strengthened 2026-08-19). The first cut of
 * this lane made no offer at all and left the profile click as the only next
 * step; the owner reviewed a queue of those drafts and called them too weak,
 * with nothing for a poster who actually needs help to act on. So the comment
 * now does two jobs in order: first it EARNS the right to offer by saying one
 * true, non-obvious thing about how that exact search actually behaves, in the
 * first person plural so the reader registers there is a desk behind it; then
 * it closes with one short, low-pressure invitation to engage if they want
 * help with the search. The invitation is a standing offer, never a demand,
 * because everyone on the thread can see it: a hard sell in public gets the
 * comment hidden and tells every competitor who is working the account.
 *
 * The failure mode to guard hardest is a fabricated statistic. A made-up comp
 * band or time-to-fill number, in public, under a hiring manager's post, is a
 * lie the desk cannot walk back and a competitor can disprove in one reply.
 * Numbers are therefore allowed ONLY when the post itself supplied them.
 */
const POST_COMMENT_RULES = `You write PUBLIC comments that a recruiting agency owner leaves on a stranger's LinkedIn post. Everyone can see this comment: the poster, their team, their network, and every competing recruiter watching the post. The reader must never suspect a machine wrote it, and must never read it as an advertisement.

Your goal is to make one hiring decision-maker think "this person actually runs these searches" and then give them one easy way to engage if they want help with the search: a reply, a message, a profile click. Everything below serves that.

Rules:
- Say ONE true, non-obvious thing about how their specific situation actually plays out, at the level of mechanism: where that talent is really sitting right now, which adjacent title converts and which one never does, what makes this search stall at the offer, what the counteroffer risk looks like, what the market reads into how the role is scoped. On a post about the work rather than a role, it is the same move applied to the problem they described. Never restate their post, never compliment it, never give generic hiring advice ("hiring is hard", "culture matters"). The line must be specific enough that it could be wrong.
- Write the observation as "we", once, as the quiet tell that a desk sits behind it: "we keep seeing", "the ones we watch close", "we stopped sourcing those from". The closing invitation may speak as "I" ("happy to", "my inbox is open") or use "we" one more time, never beyond that. Never name the firm, never say "my agency", "my clients", "our candidates", "our bench", or any placement you have made.
- NEVER invent a number. No comp bands, no time-to-fill, no counts, no percentages, unless the post itself stated them, in which case you may react to their number. If you have no specific fact, describe the pattern in words instead.
- Close with ONE short, low-pressure invitation to engage if they want help with this search. It is a standing offer they can take or leave: "happy to compare notes on where those candidates are actually sitting if useful", "if you want a candid read on who is movable at that level, my inbox is open", "glad to share what we are seeing on this exact search, just ask". Vary the phrasing; never copy these examples verbatim. On a post about the work rather than a role, the invitation is peer-to-peer instead, to trade notes on the problem they wrote about, with no mention of hiring or candidates.
- The invitation must never beg, pressure, or sell: no fees, no availability talk, no "before someone else does", no links, no phone numbers, no email, no calendar, no naming the firm.
- 20 to 55 words. Two or three sentences: the observation first, the invitation last.
- No emoji, no hashtags, no exclamation marks, no long dashes, no all-caps.
- Banned openers: "Great post", "Love this", "So true", "This is spot on", "Couldn't agree more", "Thanks for sharing", "Commenting for reach".
- Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align", "synergies", "reach out".
- Vary your sentence shape from comment to comment: do not settle into one formula. If nothing specific and true can be said about this post, ask the one question an operator who runs these searches weekly would ask, never a generic one.
- Never mention AI.
Return ONLY the comment text, nothing else.`;

/** The in-thread follow-up after a poster REPLIES to our public comment.
 *  This is the warmest moment the lane produces: they engaged in public, on
 *  their own hiring post, so the reply may move toward the search directly,
 *  but it is still visible to their whole network, so it stays classy. */
const FOLLOWUP_RULES = `You write a threaded LinkedIn reply for a recruiting agency owner. Earlier the owner left a public comment on a hiring decision-maker's post; the decision-maker has now REPLIED to that comment. You are writing the owner's reply back, in the same public thread on THEIR post. The reader must never suspect a machine wrote it.
Rules:
- Respond to the SUBSTANCE of what they said back. Extend the point, answer their question, or concede a nuance; never restate, never flatter, never thank them for replying.
- Close with ONE concrete, low-pressure step toward the search: offer to send over what you are seeing on this exact search, or invite them to connect or message you so you can share specifics privately. One clause, easy to take or leave.
- 15 to 45 words. One or two sentences. No exclamation marks, no emoji, no hashtags, no long dashes.
- NEVER invent a number; react only to figures they themselves stated. No links, no email addresses, no phone numbers, no calendar, no naming the firm, no fees.
- Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align", "synergies".
- Never mention AI.
Return ONLY the reply text, nothing else.`;

async function draft(system: string, user: string): Promise<string | null> {
  try {
    const { anthropicClient } = await import("../sourcing/anthropic");
    const res = await anthropicClient().messages.create({
      model: MODEL(),
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = res.content.find((b: { type: string }) => b.type === "text") as { text?: string } | undefined;
    const text = scrub(String(block?.text ?? ""));
    return text.length >= 8 ? text : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Enrichment + scoring                                                 */
/* ------------------------------------------------------------------ */

/** "VP Engineering at Acme | hiring" -> { title: "VP Engineering", company: "Acme" }. */
export function parseHeadline(headline?: string): { title?: string; company?: string } {
  const clean = (headline ?? "").split(/[|·]/)[0].trim();
  if (!clean) return {};
  const m = clean.split(/\s+(?:at|@)\s+/i);
  if (m.length >= 2) return { title: m[0].trim() || undefined, company: m.slice(1).join(" at ").trim() || undefined };
  return { title: clean || undefined };
}

/** Another staffing / search / recruiting shop = a peer, not a buyer. */
function looksLikePeer(title?: string, company?: string): boolean {
  const t = `${title ?? ""} ${company ?? ""}`;
  return /\b(staffing|recruit(er|ing|ment)?|talent acquisition|search firm|headhunt|rpo\b)/i.test(t)
    // TA leadership inside an operating company IS a buyer; only firms are peers.
    && /\b(staffing|search|recruit|talent|headhunt|rpo)\b/i.test(company ?? "");
}

/* ---------------- the recruiter wall (owner mandate 2026-08-14) -----------
   Nobody on the agency side of the desk ever gets a message: not from
   autopilot, not from a manual approve, not from a legacy draft. Three
   INDEPENDENT layers - any one is a veto:
     1. the person's title/headline reads recruiting or talent acquisition
     2. the company name reads staffing / search / RPO
     3. the post itself uses agency language ("our client is hiring")
   Enforced at capture (never drafted), at autopilot (never auto-sent), and
   at approve time (blocked with the reason, covering older items). -------- */

const PEER_TITLE_RE = /\b(recruiter|recruiting|recruitment|talent acquisition|talent partner|sourcer|sourcing specialist|headhunt\w*|staffing|executive search|search consultant|search firm|rpo)\b/i;
const PEER_COMPANY_RE = /\b(staffing|recruit\w*|headhunt\w*|rpo|employment agency|personnel|workforce solutions|\btalent\b|search (firm|group|partners|associates|consultants))\b/i;
const PEER_POST_RE = /\b(our client|my client|on behalf of (a|an|our|my) client|client (of ours )?is (hiring|looking|searching)|we (are|'re) a (staffing|recruiting|search|talent) (firm|agency|practice)|(direct hire|contract) (role|opportunity) (with|for) (a|our) client)\b/i;

/** Does the poster's own employer appear in the post text? Company names are
 *  normalized (Inc/LLC/punctuation stripped) and matched on their significant
 *  tokens, so "Meridian Health Systems, LLC" matches "here at Meridian". */
function companyMentionedInPost(company: string, postText: string): boolean {
  const clean = company.replace(/\b(inc|llc|ltd|corp|co|group|holdings|the)\b\.?/gi, " ").replace(/[^\w\s]/g, " ");
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const text = (postText ?? "").toLowerCase();
  return tokens.some((t) => text.includes(t.toLowerCase()));
}

/**
 * The recruiter wall, owner rule 2026-08-14: third-party recruiters and
 * agencies are NEVER messaged. A recruiter/TA-titled person is allowed ONLY
 * as verified in-house: their current company must be the company the post
 * is hiring for (the employer's name appears in the post). Unverifiable
 * recruiter-titled posters are treated as third-party - fail closed.
 */
function recruiterWall(o: { title?: string; headline?: string; company?: string; postText?: string }): string | null {
  if (PEER_COMPANY_RE.test(o.company ?? "")) return "their company reads staffing/search/talent firm";
  // The company name is parsed out of the headline, and plenty of headlines
  // never offer an "at <company>" to parse - emoji-separated founder headlines
  // especially. Testing the raw headline as well is what stops an
  // "HR Solutions" agency owner reading as a hiring manager (seen live
  // 2026-08-15, one draft away from a public comment).
  if (PEER_COMPANY_RE.test(o.headline ?? "") || /\bHR\s+(solutions?|services|consult\w*)\b/i.test(o.headline ?? "")) {
    return "their headline reads staffing/search/HR-services firm";
  }
  if (PEER_POST_RE.test(o.postText ?? "")) return "the post uses agency client language";
  const recruiterTitled = PEER_TITLE_RE.test(o.title ?? "") || PEER_TITLE_RE.test(o.headline ?? "");
  if (recruiterTitled) {
    const verifiedInHouse = !!o.company && companyMentionedInPost(o.company, o.postText ?? "");
    if (!verifiedInHouse) return "recruiter-titled and not verifiably hiring for their own company";
  }
  return null;
}

function wallForItem(i: CommentLeadItem): string | null {
  return recruiterWall({ title: i.title, headline: i.authorHeadline, company: i.company, postText: i.postExcerpt });
}

/** Deep verification (owner ask 2026-08-14): scan the poster's own profile -
 *  their summary and every CURRENT job - for recruiting-business signals the
 *  headline hides. "Avaia Talent" cases die here even with a clean headline:
 *  founders and owners describe the agency in their summary and experience. */
const SUMMARY_PEER_RE = /\b(recruit\w*|staffing|headhunt\w*|talent acquisition|executive search|search firm|direct.?hire|perm placement|placements?\b|(i|we) place\b|placing (top |great |exceptional )?(talent|candidates|professionals|people)|sourcing (candidates|talent)|helping (companies|clients|teams) (hire|find|build)|match(ing)? (candidates|talent)|rpo\b|contingency|retained search|bench of (candidates|talent))\b/i;

function deepRecruiterSignals(summary?: string, currentRoles?: string[]): string | null {
  for (const role of currentRoles ?? []) {
    if (PEER_TITLE_RE.test(role) || PEER_COMPANY_RE.test(role)) {
      return `current job reads recruiting (${role.slice(0, 60)})`;
    }
  }
  if (summary && SUMMARY_PEER_RE.test(summary)) return "profile summary reads recruiting";
  return null;
}

async function checkHiring(company: string): Promise<CommentLeadItem["hiring"]> {
  try {
    const { resolveCompanyRoles } = await import("../inmarket/companyRoles");
    const r = await resolveCompanyRoles(company);
    const roles = Array.isArray(r?.roles) ? r.roles : [];
    return {
      checked: true,
      openRoles: roles.length,
      sample: roles.slice(0, 3).map((x: { title: string }) => x.title).filter(Boolean),
      source: r?.source,
    };
  } catch {
    return { checked: false, openRoles: 0, sample: [] };
  }
}

function tierOf(decisionMaker: boolean, peer: boolean, openRoles: number): CommentTier {
  if (peer) return "community";
  if (decisionMaker && openRoles > 0) return "hot";
  if (decisionMaker) return "warm";
  return "community";
}

/* ------------------------------------------------------------------ */
/* Provider reads (defensive shapes: Unipile lists come as items|data)  */
/* ------------------------------------------------------------------ */

type Dict = Record<string, unknown>;
function listOf(raw: unknown): Dict[] {
  const any = raw as { items?: unknown[]; data?: unknown[]; dryRun?: boolean } | unknown[] | null;
  if (!any || (typeof any === "object" && !Array.isArray(any) && any.dryRun)) return [];
  const arr = Array.isArray(any) ? any : (any.items ?? any.data ?? []);
  return arr as Dict[];
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function ownProfileFor(workspaceId: string, account: LiAccountState): Promise<OwnProfile | null> {
  const provAccount = providerIdOf(account);
  if (!provAccount) return null;
  const cached = state.ownProfile[workspaceId];
  if (cached && cached.accountId === provAccount) return cached;
  try {
    const { unipile } = await import("../providers");
    const me = await unipile.getOwnProfile(provAccount) as Dict;
    const providerId = str(me.provider_id) ?? str(me.id);
    if (!providerId) return null;
    const own: OwnProfile = {
      accountId: provAccount,
      providerId,
      publicIdentifier: str(me.public_identifier),
      name: str(me.name) ?? (str(me.first_name) || str(me.last_name)
        ? [str(me.first_name), str(me.last_name)].filter(Boolean).join(" ")
        : undefined),
    };
    state.ownProfile[workspaceId] = own;
    save();
    return own;
  } catch { return null; }
}

interface RawComment {
  commentId: string;
  text: string;
  date?: string;
  authorName: string;
  authorProviderId?: string;
  authorHeadline?: string;
  authorPublicUrl?: string;
  networkDistance?: string;
}

function parseComment(c: Dict): RawComment | null {
  const commentId = str(c.id) ?? str(c.social_id) ?? str(c.comment_id);
  const text = str(c.text) ?? str(c.comment) ?? "";
  if (!commentId || !text) return null;
  const details = (typeof c.author_details === "object" && c.author_details ? c.author_details : (typeof c.author === "object" && c.author ? c.author : {})) as Dict;
  const authorName = str(c.author) ?? str(details.name)
    ?? str([str(details.first_name), str(details.last_name)].filter(Boolean).join(" "))
    ?? "LinkedIn member";
  return {
    commentId,
    text,
    date: str(c.date) ?? str(c.created_at),
    authorName,
    authorProviderId: str(details.id) ?? str(details.provider_id),
    authorHeadline: str(details.headline),
    authorPublicUrl: str(details.profile_url) ?? str(details.public_profile_url)
      ?? (str(details.public_identifier) ? `https://www.linkedin.com/in/${str(details.public_identifier)}` : undefined),
    networkDistance: str(details.network_distance),
  };
}

/** One profile read: provider id, headline, open-profile flag, distance.
 *  Accepts a provider id OR a public slug (linkedin.com/in/<slug>). */
async function fetchProfileLite(account: LiAccountState, identifier: string): Promise<{
  providerId?: string; name?: string; headline?: string; publicUrl?: string; openProfile?: boolean; networkDistance?: string; location?: string;
  summary?: string; currentRoles?: string[];
}> {
  try {
    const { unipileRequest } = await import("./provider");
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${providerIdOf(account)}`);
    // Deep-verification material (owner ask 2026-08-14): the same profile
    // read carries the summary and work history - free extra signal for the
    // recruiter wall. Current roles = entries with no end date.
    const rawExp = (Array.isArray(p.work_experience) ? p.work_experience
      : Array.isArray(p.experience) ? p.experience : []) as Array<Record<string, unknown>>;
    const currentRoles = rawExp
      .filter((e) => !str(e.end) || e.current === true)
      .map((e) => [str(e.position) ?? str(e.title) ?? "", str(e.company) ?? str(e.company_name) ?? ""].filter(Boolean).join(" at "))
      .filter(Boolean)
      .slice(0, 6);
    return {
      providerId: str(p.provider_id) ?? str(p.id),
      name: str(p.name) ?? ((str(p.first_name) || str(p.last_name))
        ? [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ")
        : undefined),
      headline: str(p.headline),
      publicUrl: str(p.public_identifier) ? `https://www.linkedin.com/in/${str(p.public_identifier)}` : undefined,
      openProfile: typeof p.is_open_profile === "boolean" ? p.is_open_profile : undefined,
      networkDistance: str(p.network_distance),
      location: str(p.location),
      summary: str(p.summary) ?? str(p.about),
      currentRoles,
    };
  } catch { return {}; }
}

function slugOf(url?: string): string | undefined {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}

/* ------------------------------------------------------------------ */
/* The scan                                                             */
/* ------------------------------------------------------------------ */

export async function scanWorkspace(workspaceId: string, adhoc?: ScanCombo): Promise<{ scanned: number; created: number; skipped: string | null }> {
  await hydrate();
  const status = await commentWatchStatus(workspaceId);
  if (!status.active) {
    console.log(`[comment-radar] ${workspaceId}: standby (${status.reasons.join(" | ") || "unknown"})`);
    return { scanned: 0, created: 0, skipped: "standby" };
  }

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts[0];

  // Best-effort own identity, ONLY so the market scan can skip the owner's
  // own posts in search results. Never a gate (owner decision 2026-08-12:
  // the radar hunts OTHER people's posts, not the owner's).
  try { await ownProfileFor(workspaceId, account); } catch { /* optional */ }

  // One-shot after a comment-copy rules change (owner ask 2026-08-19): drafts
  // written under the old no-ask rules are rewritten with the CTA close BEFORE
  // this tick's autopilot can post any of them. The epoch is stamped first so
  // a bad run can never turn into an every-tick LLM loop; whatever it keeps
  // stays approvable as-is and the queue's Redraft button remains the retry.
  if ((state.redraftEpoch[workspaceId] ?? 0) < COMMENT_COPY_EPOCH) {
    state.redraftEpoch[workspaceId] = COMMENT_COPY_EPOCH;
    save();
    try {
      const r = await redraftOpenComments(workspaceId);
      console.log(`[comment-radar] ${workspaceId}: copy epoch ${COMMENT_COPY_EPOCH}: rewritten=${r.redrafted} kept=${r.kept}`);
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: epoch redraft error (${e instanceof Error ? e.message : e})`);
    }
  }

  const scanned = 0;
  const created = 0;
  let dmCreated = 0;
  try { dmCreated = await scanPosters(workspaceId, accounts, adhoc); } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: market scan error (${e instanceof Error ? e.message : e})`);
  }

  // Autopilot: when armed, the fresh drafts go straight out through the engine.
  let sent = 0;
  try { sent = await autoExecute(workspaceId); } catch { /* drafts stay open for manual review */ }

  // The second step: comments posted a couple of days ago become BD rows.
  let handedOff = 0;
  try { handedOff = await handoffCommentedToBd(workspaceId); } catch (e) {
    console.log(`[comment-bd] ${workspaceId}: handoff error (${e instanceof Error ? e.message : e})`);
  }

  // Outcome tracking: confirm posts against the ledger, watch live threads
  // for the poster writing back, stage follow-up replies.
  let responses = 0;
  try { responses = await checkCommentResponses(workspaceId); } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: response check error (${e instanceof Error ? e.message : e})`);
  }

  state.lastScan[workspaceId] = nowIso();
  prune();
  save();
  console.log(`[comment-radar] ${workspaceId}: scanned=${scanned} created=${created + dmCreated} autopilot_sent=${sent} bd_handoff=${handedOff} replies_found=${responses}`);
  return { scanned, created: created + dmCreated, skipped: null };
}

/**
 * Hand every comment we actually posted, and have now let sit for the delay,
 * to BD as a prospect (owner direction 2026-08-15).
 *
 * The approved lane item IS the pending queue: it survives 14 days here, the
 * delay is hours, and stamping `prospectId` is what marks a poster done. So
 * this is idempotent with no extra store, and a poster whose handoff throws is
 * simply picked up by the next tick.
 */
async function handoffCommentedToBd(workspaceId: string): Promise<number> {
  const { handoffPoster, bdHandoffDelayHours } = await import("./commentToBd");
  const cutoff = Date.now() - bdHandoffDelayHours() * 3_600_000;
  let done = 0;
  for (const item of state.items) {
    if (item.workspaceId !== workspaceId) continue;
    if (item.kind !== "poster" || item.commentStatus !== "approved") continue;
    if (item.prospectId) continue;
    // updatedAt is the approval stamp: the moment the engine took the comment.
    if (new Date(item.updatedAt).getTime() > cutoff) continue;
    try {
      const prospectId = await handoffPoster(workspaceId, {
        id: item.id,
        authorName: item.authorName,
        authorPublicUrl: item.authorPublicUrl,
        authorHeadline: item.authorHeadline,
        company: item.company,
        title: item.title,
        posterLocation: item.posterLocation,
        postExcerpt: item.postExcerpt,
        postUrl: item.postUrl,
        commentDraft: item.commentDraft,
        openRoles: item.hiring?.openRoles,
      });
      if (!prospectId) continue;
      item.prospectId = prospectId;
      item.updatedAt = nowIso();
      const st = huntStatsFor(workspaceId);
      st.bdHandoffs = (st.bdHandoffs ?? 0) + 1;
      save();
      done++;
    } catch (e) {
      console.log(`[comment-bd] ${workspaceId}: ${item.authorName} handoff failed (${e instanceof Error ? e.message : e})`);
    }
  }
  return done;
}

/**
 * Outcome tracking for posted comments (owner ask 2026-08-19).
 *
 * Step 1: items the engine accepted ("pending") are confirmed against the
 * ledger: success stamps commentPostedAt plus our comment's provider id; a
 * terminal failure surfaces as "failed" in the tracker instead of silently
 * looking live forever.
 *
 * Step 2: live threads are re-read (round-robin, stalest first) looking for
 * a reply by the POSTER. Anything they write on their own post after our
 * comment counts: threading metadata is inconsistent across providers, and
 * a poster answering "thanks, will DM you" as a top-level comment is a
 * response by any useful definition. On a hit the in-thread follow-up is
 * drafted immediately and staged for one-tap approval while the thread is
 * still hot.
 *
 * Step 3: threads quiet past the watch window flip to "no_response". Those
 * people are already on the re-engagement path by then: the BD handoff put
 * them in the "Commented (Role Hunter)" email campaign at ~60 hours.
 */
async function checkCommentResponses(workspaceId: string): Promise<number> {
  const accounts = await connectedAccounts(workspaceId);
  if (!accounts.length) return 0;
  const tracked = state.items.filter((i) =>
    i.workspaceId === workspaceId && i.kind === "poster" && i.commentStatus === "approved"
    && (!i.responseStatus || i.responseStatus === "pending" || i.responseStatus === "posted"));
  if (!tracked.length) return 0;

  // Step 1: pending -> posted/failed, read off the engine's ledger. Items
  // approved before tracking existed carry no responseStatus; their ledger
  // record is recovered through the approval's idempotency key, so history
  // joins the tracker instead of sitting untracked forever.
  const pending = tracked.filter((i) => i.responseStatus === "pending" || (!i.responseStatus && i.commentStatus === "approved"));
  if (pending.length) {
    const { ledger } = await import("./os/store");
    const records = await ledger.all();
    for (const item of pending) {
      const rec = item.commentActionId
        ? records.find((r) => r.id === item.commentActionId)
        : records.find((r) => r.workspaceId === workspaceId && r.idempotencyKey === `licw_pubcomment_${item.id}`);
      if (!rec) {
        // Ledger record aged out of the capped store: assume the comment
        // posted at approval time so the thread still gets watched.
        item.responseStatus = "posted";
        item.commentPostedAt = item.commentPostedAt ?? item.updatedAt;
        continue;
      }
      item.commentActionId = rec.id;
      if (rec.status === "success" || rec.status === "submitted") {
        item.responseStatus = "posted";
        item.commentPostedAt = nowIso();
        item.commentProviderId = rec.providerReference;
        item.updatedAt = nowIso();
      } else if (rec.status === "failed" || rec.status === "cancelled" || rec.status === "suppressed") {
        item.responseStatus = "failed";
        item.reason = rec.statusReason || "The engine could not post this comment.";
        item.updatedAt = nowIso();
      }
      // Anything else (queued, scheduled, processing) stays pending.
    }
  }

  // Step 3 is cheap, so it runs every tick: expire quiet threads.
  const expiry = Date.now() - RESPONSE_WATCH_DAYS * 86_400_000;
  for (const item of tracked) {
    if (item.responseStatus === "posted" && item.commentPostedAt
      && new Date(item.commentPostedAt).getTime() < expiry) {
      item.responseStatus = "no_response";
      item.updatedAt = nowIso();
    }
  }

  // Step 2: re-read the stalest live threads.
  const live = tracked
    .filter((i) => i.responseStatus === "posted")
    .sort((a, b) => (a.responseCheckedAt ?? "").localeCompare(b.responseCheckedAt ?? ""))
    .slice(0, RESPONSE_CHECKS_PER_TICK);
  let found = 0;
  if (!live.length) return 0;
  const { unipile } = await import("../providers");
  for (const item of live) {
    item.responseCheckedAt = nowIso();
    const account = accounts.find((a) => a.accountId === item.accountId) ?? accounts[0];
    const provider = providerIdOf(account);
    if (!provider) continue;
    try {
      const comments = listOf(await unipile.listPostComments(provider, item.postId))
        .map(parseComment).filter((c): c is RawComment => !!c);
      const postedAt = item.commentPostedAt ? new Date(item.commentPostedAt).getTime() : 0;
      const reply = comments.find((c) =>
        c.commentId !== item.commentProviderId
        && (item.authorProviderId
          ? c.authorProviderId === item.authorProviderId
          : c.authorName.trim().toLowerCase() === item.authorName.trim().toLowerCase())
        // A minute of slack: comment timestamps and our posted stamp are from
        // different clocks. Undated replies are accepted; posters answering
        // their own post's comments are overwhelmingly answering the newest.
        && (!c.date || new Date(c.date).getTime() >= postedAt - 60_000));
      if (!reply) continue;
      item.responseStatus = "responded";
      item.responseText = reply.text.slice(0, 700);
      item.responseAt = reply.date ?? nowIso();
      item.responseCommentId = reply.commentId;
      item.updatedAt = nowIso();
      found++;
      console.log(`[comment-radar] ${workspaceId}: ${item.authorName} replied to our comment on their post`);
      // Stage the follow-up now. A model failure just leaves the Draft
      // button in the tracker; the response itself is already recorded.
      try {
        const text = await draft(FOLLOWUP_RULES, followUpBrief(item, reply.text));
        if (text) {
          item.followUpText = scrub(text).slice(0, MAX_COMMENT_CHARS);
          item.followUpStatus = "suggested";
        }
      } catch { /* draft on demand instead */ }
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: thread check failed for ${item.authorName} (${e instanceof Error ? e.message : e})`);
    }
  }
  return found;
}

function followUpBrief(item: CommentLeadItem, replyText: string): string {
  return `THEIR ORIGINAL POST:\n${(item.postExcerpt ?? "").slice(0, 600)}\n\n` +
    `OUR PUBLIC COMMENT:\n${item.commentDraft ?? ""}\n\n` +
    `THEIR REPLY (by ${item.authorName}${item.title ? `, ${item.title}` : ""}${item.company ? ` at ${item.company}` : ""}):\n${replyText.slice(0, 600)}\n\n` +
    `Write the owner's reply.`;
}

/** Draft (or re-draft) the in-thread follow-up for a responded tracker item. */
export async function draftFollowUp(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.responseStatus !== "responded" || item.followUpStatus === "approved") return null;
  const text = await draft(FOLLOWUP_RULES, followUpBrief(item, item.responseText ?? ""));
  if (!text) return null;
  item.followUpText = scrub(text).slice(0, MAX_COMMENT_CHARS);
  item.followUpStatus = "suggested";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Post the follow-up as a threaded reply to THEIR response on THEIR post.
 *  This is a live conversation, not a cold touch, so it spends none of the
 *  cold-comment allowance; engine account caps still apply. */
export async function approveFollowUp(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.followUpStatus !== "suggested" || !item.followUpText || !item.responseCommentId) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  if (editedText && scrub(editedText).length >= 2) item.followUpText = scrub(editedText).slice(0, MAX_COMMENT_CHARS);
  const accounts = await connectedAccounts(workspaceId);
  const account = accounts.find((a) => a.accountId === item.accountId)
    ?? accounts.find((a) => a.ownerUserId === userId)
    ?? accounts.find((a) => !a.ownerUserId)
    ?? accounts[0];
  if (!account) {
    item.followUpStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title,
        providerProfileId: item.authorProviderId, prospectId: item.prospectId,
      },
      actionType: "comment_post",
      payload: {
        postUrl: item.postId, commentId: item.responseCommentId, text: item.followUpText,
        providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl,
      },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `licw_followup_${item.id}`,
    });
    if (result.accepted) {
      item.followUpStatus = "approved"; item.reason = undefined;
    } else {
      item.followUpStatus = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.followUpStatus = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

export async function skipFollowUp(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.followUpStatus !== "suggested") return null;
  item.followUpStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/* ------------------------------------------------------------------ */
/* The market scan: keyword search across ALL LinkedIn posts finds      */
/* hiring managers posting about talent they need. No public comment;   */
/* a hyper-targeted direct message instead (plain DM to open profiles   */
/* and existing connections, connection note otherwise, never InMail).  */
/* ------------------------------------------------------------------ */

export function marketKeywordsFor(workspaceId: string): string[] {
  const custom = state.marketKeywords[workspaceId];
  return custom?.length ? custom : DEFAULT_MARKET_KEYWORDS;
}

export async function setMarketKeywords(workspaceId: string, keywords: string[]): Promise<string[]> {
  await hydrate();
  // Keep the casing the recruiter typed: the matched keyword becomes
  // {job_title} in the DM ("Controller", not "controller"). Dedupe is
  // case-insensitive; 2-char floor admits titles like QA and PM.
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const k of keywords) {
    const t = k.trim();
    if (t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(t.slice(0, 60));
    if (clean.length >= 40) break;
  }
  state.marketKeywords[workspaceId] = clean;
  save();
  return marketKeywordsFor(workspaceId);
}

/**
 * AI role-family expansion (owner ask 2026-08-13): feed any seed title in any
 * industry ("CPA") and get the adjacent titles a recruiter hunting that desk
 * would also watch ("Controller", "CFO", "Assistant Controller", ...). Pure
 * suggestion engine: returns the merged list for review, saves NOTHING.
 * Deterministic fallback: on any AI failure the seeds come back unchanged.
 */
export async function expandRoleFamily(seeds: string[]): Promise<{ roles: string[]; expanded: boolean; error?: string }> {
  const base = [...new Set(seeds.map((s) => s.trim()).filter((s) => s.length >= 2))].slice(0, 10);
  if (!base.length) return { roles: [], expanded: false, error: "No seed titles given." };
  if (!process.env.ANTHROPIC_API_KEY) return { roles: base, expanded: false, error: "AI key not configured on the server." };
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const resp = await client.messages.create(
      {
        model: process.env.ROLE_EXPAND_MODEL ?? "claude-haiku-4-5",
        max_tokens: 500,
        temperature: 0.3,
        system: "You expand recruiter search keywords. Given seed job titles, return the adjacent job titles a recruiter working that desk would also hunt: synonyms, common abbreviations, adjacent seniority levels from individual contributor to executive, and closely related functions in the same family. Any industry. Return ONLY a JSON array of title strings, no commentary. 10 to 18 titles, each 60 characters or fewer, no duplicates of the seeds.",
        messages: [{ role: "user", content: `Seed titles: ${base.join(", ")}` }],
      },
      { timeout: 15_000 },
    );
    const text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const m = /\[[\s\S]*\]/.exec(text);
    const parsed: unknown = m ? JSON.parse(m[0]) : [];
    const extras = (Array.isArray(parsed) ? parsed : [])
      .map((x) => String(x).trim().slice(0, 60))
      .filter((x) => x.length >= 2);
    const seen = new Set(base.map((b) => b.toLowerCase()));
    const merged = [...base];
    for (const e of extras) {
      if (seen.has(e.toLowerCase())) continue;
      seen.add(e.toLowerCase());
      merged.push(e);
      if (merged.length >= 40) break;
    }
    return { roles: merged, expanded: merged.length > base.length };
  } catch (e) {
    return { roles: base, expanded: false, error: e instanceof Error ? e.message : "AI expansion failed." };
  }
}

export function scenariosFor(workspaceId: string): { presets: string[]; custom: Array<{ label: string; phrase: string }> } {
  const sel = state.scenarios[workspaceId];
  return sel ?? { presets: [...DEFAULT_SCENARIOS], custom: [] };
}

export async function setScenarios(
  workspaceId: string,
  presets: string[],
  custom: Array<{ label?: string; phrase?: string }>,
  opts?: { allowClear?: boolean },
): Promise<void> {
  await hydrate();
  const validIds = new Set(SCENARIO_PRESETS.map((p) => p.id));
  const next = {
    presets: [...new Set(presets.filter((p) => validIds.has(p)))],
    custom: custom
      .map((c) => ({ label: String(c.label ?? c.phrase ?? "").trim().slice(0, 60), phrase: String(c.phrase ?? "").trim().slice(0, 120) }))
      .filter((c) => c.phrase.length >= 3)
      .slice(0, 40),
  };
  // Wipe guard (incident 2026-08-13): a stale tab posting an empty selection
  // erased 20 seeded hunts. Emptying everything now requires an explicit
  // clear from the UI; an empty save from old markup is treated as a no-op.
  const prev = state.scenarios[workspaceId];
  const prevCount = prev ? prev.presets.length + prev.custom.length : 0;
  if (!next.presets.length && !next.custom.length && prevCount > 0 && !opts?.allowClear) return;
  state.scenarios[workspaceId] = next;
  save();
}

/**
 * AI Search (owner ask 2026-08-13): the recruiter describes who they want to
 * find in plain language ("CFOs at Series B fintechs hiring accountants") and
 * this turns it into LinkedIn post hunts and runs them NOW, outside the
 * 15-minute rotation. Findings land in the same approval feed as every other
 * hunt. Fallback without AI: the raw ask runs as a single phrase hunt.
 */
export async function aiHunt(workspaceId: string, ask: string): Promise<{
  phrases: string[]; role?: string; created: number; error?: string;
}> {
  const q = ask.trim().slice(0, 300);
  if (q.length < 3) return { phrases: [], created: 0, error: "Describe who you want to find." };
  let phrases: string[] = [];
  let role: string | undefined;
  let error: string | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
      const resp = await client.messages.create(
        {
          model: process.env.ROLE_EXPAND_MODEL ?? "claude-haiku-4-5",
          max_tokens: 300,
          temperature: 0.3,
          system: 'You turn a recruiter\'s description of who they want to find into LinkedIn post search phrases. The targets are always on the HIRING side: people posting about roles they need to fill. Reply with strict JSON only: {"role": "<job title being hired, singular, for message templating>", "phrases": ["...", "..."]}. Each phrase is 2 to 6 words that would appear verbatim inside such a post ("hiring a Senior Accountant", "looking for a Controller", "growing our finance team"). Exactly 2 phrases, no hashtags, no quotation marks inside phrases.',
          messages: [{ role: "user", content: q }],
        },
        { timeout: 15_000 },
      );
      const text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const m = /\{[\s\S]*\}/.exec(text);
      const parsed = m ? JSON.parse(m[0]) as { role?: unknown; phrases?: unknown } : {};
      role = typeof parsed.role === "string" && parsed.role.trim() ? parsed.role.trim().slice(0, 60) : undefined;
      phrases = (Array.isArray(parsed.phrases) ? parsed.phrases : [])
        .map((p) => String(p).trim().replace(/["“”]/g, "")).filter((p) => p.length >= 3).slice(0, 2);
    } catch (e) {
      error = e instanceof Error ? e.message : "AI query builder failed.";
    }
  }
  if (!phrases.length) phrases = [q.slice(0, 120)];
  let created = 0;
  for (const p of phrases) {
    const combo: ScanCombo = {
      key: `AI hunt: ${p}`,
      role,
      serperQ: `site:linkedin.com/posts "${p}"`,
      unipileQ: p,
      hiringIntent: false,
      dmBank: "mpc",
    };
    try {
      const r = await scanWorkspace(workspaceId, combo);
      created += r.created;
      if (r.skipped === "standby") error = "The radar is on standby (no connected LinkedIn account).";
    } catch (e) {
      error = e instanceof Error ? e.message : "Hunt failed.";
    }
  }
  return { phrases, role, created, error };
}

/** One search per tick: the flattened (scenario x role) rotation. */
interface ScanCombo {
  key: string;
  /** Which SCENARIO_PRESETS entry produced this combo, so the drafting step can
   *  tell a hiring post from an industry post. */
  id?: string;
  role?: string;
  serperQ: string;
  unipileQ: string;
  hiringIntent: boolean;
  dmBank: "mpc" | "growth";
}

function scanCombos(workspaceId: string): ScanCombo[] {
  const roles = marketKeywordsFor(workspaceId);
  const sel = scenariosFor(workspaceId);
  const out: ScanCombo[] = [];
  for (const id of sel.presets) {
    const p = SCENARIO_PRESETS.find((x) => x.id === id);
    if (!p) continue;
    if (p.roleBased) {
      roles.forEach((role, i) => {
        // Role-based hiring scenarios all search "<role> hiring" on Unipile.
        // A scenario with its own topics is not about hiring at all, so it
        // pairs the role with one topic instead, rotated by role index so the
        // bank spreads across the market rather than asking the same question
        // seven times.
        const topic = p.unipileTopics?.length
          ? p.unipileTopics[i % p.unipileTopics.length]
          : undefined;
        out.push({
          key: `${p.label}: ${role}${topic ? ` (${topic})` : ""}`, id: p.id, role,
          serperQ: `site:linkedin.com/posts "${role}" (${p.orGroup})`,
          unipileQ: topic ? `${role} ${topic}` : `${role} hiring`,
          hiringIntent: p.hiringIntent, dmBank: p.dmBank,
        });
      });
    } else {
      out.push({
        key: p.label, id: p.id,
        serperQ: `site:linkedin.com/posts ${p.orGroup.startsWith("(") ? p.orGroup : `(${p.orGroup})`}`,
        unipileQ: p.orGroup.replace(/["()]|\bOR\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
        hiringIntent: p.hiringIntent, dmBank: p.dmBank,
      });
    }
  }
  for (const c of sel.custom) {
    out.push({
      key: `Custom: ${c.label || c.phrase}`,
      serperQ: `site:linkedin.com/posts "${c.phrase}"`,
      unipileQ: c.phrase,
      hiringIntent: false, dmBank: "growth",
    });
  }
  return out.length ? out : [{
    key: "Posting an opening (fallback)",
    serperQ: `site:linkedin.com/posts "${roles[0] ?? "hiring"}" (hiring OR "open role")`,
    unipileQ: `hiring ${roles[0] ?? ""}`.trim(),
    hiringIntent: true, dmBank: "mpc",
  }];
}

/** One hiring-post candidate, whichever engine found it. authorRef is a
 *  provider id or public slug - both resolvable by fetchProfileLite. */
interface MarketCandidate {
  postId: string;
  postUrl?: string;
  text: string;
  postAt?: string;
  authorRef: string;
  authorName?: string;
  headline?: string;
}

function candidatesFromUnipile(results: Dict[]): MarketCandidate[] {
  const out: MarketCandidate[] = [];
  for (const raw of results) {
    const postId = str(raw.social_id) ?? str(raw.share_url) ?? str(raw.url) ?? str(raw.id) ?? str(raw.post_id);
    const text = (str(raw.text) ?? str(raw.commentary) ?? str(raw.content) ?? "").trim();
    if (!postId) continue;
    const author = (typeof raw.author === "object" && raw.author ? raw.author : (typeof raw.author_details === "object" && raw.author_details ? raw.author_details : {})) as Dict;
    if (author.is_company === true || str(author.type) === "COMPANY" || str(author.type) === "organization") continue;
    const authorRef = str(author.id) ?? str(author.provider_id) ?? str(author.public_identifier);
    if (!authorRef) continue;
    out.push({
      postId, text,
      postUrl: str(raw.share_url) ?? str(raw.url),
      postAt: str(raw.date) ?? str(raw.parsed_datetime),
      authorRef,
      authorName: str(author.name) ?? str([str(author.first_name), str(author.last_name)].filter(Boolean).join(" ")),
      headline: str(author.headline),
    });
  }
  return out;
}

/** Fallback engine: Google's index of linkedin.com/posts via Serper (the
 *  live Unipile seat's LinkedIn content search returns zero items in every
 *  form - verified 2026-08-12 - while its people search works). Post URLs
 *  carry the author slug and the activity id; profile enrichment and the
 *  send still go through Unipile. */
async function candidatesFromSerper(query: string): Promise<{ items: MarketCandidate[]; error?: string }> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { items: [], error: "Serper key not configured on the server." };
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      // gl/hl pin the index to the US edition (owner mandate 2026-08-15):
      // cheaper than discovering a Manchester poster after a paid profile
      // read. DataForSEO already does this with location_code 2840.
      body: JSON.stringify({ q: query, num: MARKET_RESULTS_PER_SEARCH, tbs: "qdr:w", gl: "us", hl: "en" }),
    });
    if (!res.ok) {
      // Break layer: the card must say WHY discovery is dry, e.g. Serper's
      // "Not enough credits" (seen live 2026-08-13).
      let msg = `Serper ${res.status}`;
      try { const b = await res.json() as { message?: string }; if (b?.message) msg = `Search engine: ${b.message} (Serper)`; } catch { /* status only */ }
      return { items: [], error: msg };
    }
    const data = await res.json() as { organic?: Array<{ link?: string; title?: string; snippet?: string; date?: string }> };
    const out: MarketCandidate[] = [];
    for (const r of data.organic ?? []) {
      const link = r.link ?? "";
      const slugM = /linkedin\.com\/posts\/([^_/?#]+)_/i.exec(link);
      const idM = /activity-(\d{10,})/.exec(link);
      if (!slugM || !idM) continue;
      // Result titles read "Jane Doe on LinkedIn: <post start>".
      const title = r.title ?? "";
      const name = title.split(/\s+on LinkedIn/i)[0].trim();
      const afterColon = title.includes(":") ? title.slice(title.indexOf(":") + 1).trim() : "";
      const text = [afterColon, r.snippet ?? ""].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      out.push({
        postId: idM[1], postUrl: link, text,
        postAt: r.date,
        authorRef: slugM[1],
        authorName: name || undefined,
      });
    }
    return { items: out };
  } catch (e) { return { items: [], error: `Serper unreachable (${e instanceof Error ? e.message : e})` }; }
}

/** "meghan-edwards-01a63073" -> "Meghan Edwards" (post-URL author slugs). */
function nameFromSlug(slug: string): string | undefined {
  const parts = slug.split("-").filter((p) => p && !/\d/.test(p));
  if (parts.length < 2) return undefined;
  return parts.slice(0, 3).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

/** Second failover: DataForSEO. Verified live 2026-08-13 on the radar's exact
 *  site:linkedin.com/posts query: 20 organic hiring posts, $0.02/search,
 *  $50.90 balance on the account while Serper sat out of credits. */
async function candidatesFromDataForSeo(query: string): Promise<{ items: MarketCandidate[]; error?: string }> {
  const login = process.env.DATAFORSEO_LOGIN;
  const pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) return { items: [], error: "DataForSEO not configured." };
  try {
    const auth = Buffer.from(`${login}:${pass}`).toString("base64");
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: "en", depth: MARKET_RESULTS_PER_SEARCH }]),
    });
    if (!res.ok) return { items: [], error: `Search engine: DataForSEO ${res.status}` };
    const data = await res.json() as {
      tasks?: Array<{ result?: Array<{ items?: Array<{ type?: string; url?: string; title?: string; description?: string; timestamp?: string }> }> }>;
    };
    const rows = (data.tasks?.[0]?.result?.[0]?.items ?? []).filter((i) => i.type === "organic");
    const out: MarketCandidate[] = [];
    for (const r of rows) {
      const link = r.url ?? "";
      const slugM = /linkedin\.com\/posts\/([^_/?#]+)_/i.exec(link);
      const idM = /activity-(\d{10,})/.exec(link);
      if (!slugM || !idM) continue;
      const title = r.title ?? "";
      const afterColon = title.includes(":") ? title.slice(title.indexOf(":") + 1).trim() : title;
      const text = [afterColon, r.description ?? ""].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      out.push({
        postId: idM[1], postUrl: link, text,
        postAt: r.timestamp,
        authorRef: slugM[1],
        authorName: nameFromSlug(slugM[1]),
      });
    }
    return { items: out };
  } catch (e) { return { items: [], error: `DataForSEO unreachable (${e instanceof Error ? e.message : e})` }; }
}

async function scanPosters(workspaceId: string, accounts: LiAccountState[], adhoc?: ScanCombo): Promise<number> {
  // Multi-account rota: the search runs on the first seat, but each captured
  // lead is assigned round-robin across ALL connected seats, so profile reads
  // and DM sends spread over every recruiter's account limits.
  const account = accounts[0];
  let rota = state.keywordCursor[`${workspaceId}:rota`] ?? 0;
  const seenAuthors = state.posterSeen[workspaceId] ?? (state.posterSeen[workspaceId] = {});
  const seenArr = state.seen[workspaceId] ?? (state.seen[workspaceId] = []);
  const seenPosts = new Set(seenArr);
  const recheckCutoff = Date.now() - POSTER_RECHECK_DAYS * 86_400_000;
  const own = state.ownProfile[workspaceId];

  // One search per tick, rotating through the flattened (scenario x role)
  // combos; 96 ticks/day covers the whole rotation several times over. An
  // ad-hoc combo (AI Search) runs immediately and leaves the rotation alone.
  let combo: ScanCombo;
  if (adhoc) {
    combo = adhoc;
  } else {
    const combos = scanCombos(workspaceId);
    const idx = (state.keywordCursor[workspaceId] ?? 0) % combos.length;
    state.keywordCursor[workspaceId] = idx + 1;
    combo = combos[idx];
  }
  const keyword = combo.key;
  const roles = marketKeywordsFor(workspaceId);
  save();

  // Discovery is INDEXED-FIRST (owner ask 2026-08-19): Google's index of
  // linkedin.com/posts via Serper, then DataForSEO, so the connected seat
  // never runs post searches against LinkedIn itself. The seat is still used
  // where nothing else can do the job: profile reads on captured leads, and
  // the DMs/comments that go out. ROLE_HUNTER_UNIPILE_SEARCH=1 restores the
  // on-platform search as a LAST resort after both indexed engines come up
  // dry (note before flipping it back on: the live seat's post search has
  // returned zero items in every request shape since 2026-08-12).
  let source = "serper";
  let candidates: MarketCandidate[] = [];
  const r = await candidatesFromSerper(combo.serperQ);
  candidates = r.items;
  let engineError = r.error;
  // Second engine: DataForSEO absorbs the volume when Serper is dry
  // (out of credits, seen live 2026-08-13).
  if (!candidates.length) {
    source = "dataforseo";
    const d2 = await candidatesFromDataForSeo(combo.serperQ);
    candidates = d2.items;
    if (candidates.length) engineError = undefined;
    else engineError = [engineError, d2.error].filter(Boolean).join(" | ") || undefined;
  }
  if (!candidates.length && process.env.ROLE_HUNTER_UNIPILE_SEARCH === "1") {
    source = "unipile";
    try {
      const { unipile } = await import("../providers");
      candidates = candidatesFromUnipile(listOf(await unipile.searchPosts(providerIdOf(account)!, combo.unipileQ, MARKET_RESULTS_PER_SEARCH)));
      if (candidates.length) engineError = undefined;
    } catch (e) {
      console.log(`[comment-radar] unipile post search failed for "${keyword}" (${e instanceof Error ? e.message : e})`);
    }
  }
  // Break layer: engine failures surface on the card, not just in logs.
  if (engineError && !candidates.length) {
    state.lastError[workspaceId] = engineError;
    save();
    console.log(`[comment-radar] market "${keyword}": ${engineError}`);
  } else if (state.lastError[workspaceId]) {
    delete state.lastError[workspaceId];
    save();
  }

  let created = 0;
  // Per-gate counters so a zero-yield search names the gate that ate it.
  const g = { nopost: 0, seen: 0, intent: 0, weekly: 0, profile: 0, title: 0, dnc: 0, closed: 0, peer: 0, offMarket: 0, foreignPost: 0, commentFull: 0, commentDraft: 0, commentDupe: 0, commentLeak: 0 };
  const stats = huntStatsFor(workspaceId);
  // Public-comment lane: on/off, and how deep its approval queue may get.
  const commentLane = commentLimitsFor(workspaceId).enabled;
  const commentQueueCap = COMMENT_QUEUE_MULTIPLE * dayAllowanceFor(workspaceId, nowIso().slice(0, 10));
  let pendingComments = state.items.filter(
    (i) => i.workspaceId === workspaceId && i.commentStatus === "suggested",
  ).length;
  stats.searches += 1;
  stats.screened += candidates.length;
  for (const c of candidates) {
    if (created >= POSTER_NEW_PER_TICK) break;
    if (c.text.length < 40) { g.nopost++; continue; }
    // Post age is a HARD ceiling (owner ask 2026-08-14): a role posted more
    // than two weeks ago is stale - never messaged about. Serper already
    // filters to the past week; this gates the LinkedIn-search and
    // DataForSEO results, which carry no age limit of their own.
    if (c.postAt) {
      const age = Date.now() - new Date(c.postAt).getTime();
      if (Number.isFinite(age) && age > MAX_POST_AGE_DAYS * 86_400_000) { g.nopost++; continue; }
    }
    if (seenPosts.has(c.postId)) { g.seen++; continue; }
    seenPosts.add(c.postId); seenArr.push(c.postId);

    // Hiring-post scenarios require hiring intent in the text; broader
    // scenarios (growth, funding, custom phrases) accept any real post.
    if (combo.hiringIntent && !HIRING_INTENT_RE.test(c.text)) { g.intent++; continue; }

    // US only (owner mandate 2026-08-15). A post that says outright where the
    // job is, and says somewhere abroad, dies here: free, before the profile
    // read that would otherwise be spent finding that out. The poster's own
    // location is checked further down, after the read.
    const foreign = foreignPostReason(c.text);
    if (foreign) { g.foreignPost++; continue; }

    // One touch per author per week, whichever key we knew them by.
    const lastTouch = seenAuthors[c.authorRef];
    if (lastTouch && new Date(lastTouch).getTime() >= recheckCutoff) { g.weekly++; continue; }

    // Closed-profile memory (owner ask 2026-08-14): someone we already know
    // can't receive a DM is skipped for CLOSED_PROFILE_DAYS without spending
    // another profile read on them.
    //
    // Two kinds of entry live in this cache. Wall hits ("wall:" prefix) are
    // recruiters and always skip: we never want them. Plain entries only mean
    // "cannot receive a DM", which stopped being a dead end when the
    // public-comment lane came in (owner ask 2026-08-14) - their post is
    // still reachable, so those entries are ignored while the lane is on.
    const closedCache = state.closedProfiles[workspaceId] ?? (state.closedProfiles[workspaceId] = {});
    const closedCutoff = Date.now() - CLOSED_PROFILE_DAYS * 86_400_000;
    const cached = closedCache[c.authorRef];
    const wallCached = typeof cached === "string" && cached.startsWith("wall:");
    const cachedIso = wallCached ? cached.slice(5) : cached;
    if (cachedIso && new Date(cachedIso).getTime() >= closedCutoff && (wallCached || !commentLane)) {
      g.closed++; stats.readsSaved += 1; continue;
    }
    // NOTE (2026-08-15): the weekly stamp used to land HERE, before the read.
    // That marked every author we merely LOOKED at as "touched" for seven days,
    // so a poster who was screened once and never contacted was locked out of
    // the whole rotation. It starved the lane down to zero leads across 8/14
    // and 8/15 (45 searches, 117 screened, 0 leads). The stamp now happens only
    // when something is actually drafted for this person.
    //
    // The read budget is held by closedCache instead, and every rejection below
    // writes a "wall:" entry rather than a plain one: an unresolvable profile or
    // a non-decision-maker is a permanent disqualification, not the
    // "cannot receive a DM" fact that the comment lane is allowed to ignore.
    const markClosed = (providerId?: string) => {
      closedCache[c.authorRef] = `wall:${nowIso()}`;
      if (providerId) closedCache[providerId] = `wall:${nowIso()}`;
      save();
    };

    // Profile read on the seat that will send. Company pages fail here,
    // which is the point.
    const sendAccount = accounts[rota % accounts.length];
    stats.profileReads += 1;
    const prof = await fetchProfileLite(sendAccount, c.authorRef);
    if (!prof.providerId) { markClosed(); g.profile++; continue; }
    if (own && prof.providerId === own.providerId) { markClosed(prof.providerId); g.profile++; continue; }
    const lastById = seenAuthors[prof.providerId];
    if (lastById && new Date(lastById).getTime() >= recheckCutoff) { g.weekly++; continue; }

    // Which lane this poster belongs to. An open profile (or an existing
    // 1st-degree connection) takes the private DM, exactly as before.
    //
    // A closed profile used to end here (owner decision 2026-08-13). It no
    // longer does (owner ask 2026-08-14): their POST is public even when
    // their profile is not, so the lane below leaves a comment on it and the
    // author gets the notification without an open profile or a connection.
    // They still clear every wall an open profile clears - recruiter wall,
    // decision-maker title, DNC - because a public comment is seen by more
    // people than a DM, not fewer. With the lane switched off the old
    // behaviour returns: skip, remember, spend nothing on them again.
    //
    // Unipile returns FIRST_DEGREE, never DISTANCE_1 (probe-verified
    // 2026-08-15). Matching only the DISTANCE_n spelling meant no connection
    // ever counted as reachable, so 1st-degree posters - the people we can DM
    // for free, forever, with no credit at all - were routed to the public
    // comment lane instead of the private message they should have had.
    // Off-market posters die here, before any drafting: the profile read is
    // already spent, and a wrong-market comment is a permanent disqualification
    // rather than a "come back next week".
    const offMarket = await offMarketReason(prof.location);
    if (offMarket) { markClosed(prof.providerId); g.offMarket++; continue; }

    const firstDegree = prof.networkDistance === "FIRST_DEGREE" || prof.networkDistance === "DISTANCE_1";
    const direct = prof.openProfile === true || firstDegree;
    if (!direct) {
      stats.closedFound += 1;
      if (!commentLane) {
        closedCache[c.authorRef] = nowIso();
        if (prof.providerId) closedCache[prof.providerId] = nowIso();
        g.closed++; save(); continue;
      }
      // Queue depth: never stack up more comment drafts than the desk could
      // plausibly work through, or the approval list becomes a graveyard and
      // the drafts go stale against posts that have moved on.
      if (pendingComments >= commentQueueCap) { g.commentFull++; continue; }
    }

    // Decision-maker title, not a peer staffing firm.
    const headline = c.headline ?? prof.headline;
    const { title, company } = parseHeadline(headline);
    const intel = classifyTitle(title ?? headline ?? "");
    // The recruiter wall: agency-side posters are never captured at all.
    // Layer 4 (deep verification): their profile summary and current jobs,
    // read from the same profile call - no extra credits. Wall-hits join the
    // never-again cache so future hunts spend nothing on them.
    const wallHit = recruiterWall({ title, headline, company, postText: c.text })
      ?? deepRecruiterSignals(prof.summary, prof.currentRoles)
      ?? (looksLikePeer(title, company) ? "staffing peer" : null);
    if (wallHit) {
      // "wall:" marks a never-again entry: unlike a plain closed profile, a
      // recruiter stays skipped whether or not the comment lane is on.
      closedCache[c.authorRef] = `wall:${nowIso()}`;
      if (prof.providerId) closedCache[prof.providerId] = `wall:${nowIso()}`;
      g.peer++; stats.peersBlocked += 1; save(); continue;
    }
    // A title is not going to reclassify next week, so a non-decision-maker
    // joins the never-again cache too - otherwise dropping the pre-read stamp
    // would let the same individual contributor cost a fresh read every hunt.
    if (!intel.isDecisionMaker) { markClosed(prof.providerId); g.title++; continue; }

    const authorName = c.authorName ?? prof.name ?? "LinkedIn member";

    // Never message anyone on the do-not-contact list or inside the
    // cross-channel recency cooldown.
    try {
      const { checkContactable } = await import("../outreach/contactGuard");
      const dnc = await checkContactable(workspaceId,
        { fullName: authorName, company, linkedinUrl: prof.publicUrl },
        { checkRecency: true });
      if (!dnc.ok) { g.dnc++; continue; }
    } catch { g.dnc++; continue; }

    // Supporting evidence, never a gate: their own board's open roles.
    if (company) stats.hiringChecks += 1;
    const hiring = company ? await checkHiring(company) : undefined;

    const id = rid("licw");
    const jobTitle = combo.role ?? roles[0] ?? "candidate";
    const firstName = authorName.split(/\s+/)[0];
    // {current_city}: the post text names where the role is; the poster's
    // profile location is the fallback; "your market" when neither is known.
    const city = cityFromPost(c.text) ?? cityFromLocation(prof.location);

    // Open profile: the MPC script, deterministic template fill.
    // {job_title} = the matched role for role scenarios, or the desk's
    // primary role for broader ones.
    let dmText: string | undefined;
    let commentDraft: string | undefined;
    if (direct) {
      dmText = mpcDmFor(id, jobTitle, firstName && firstName !== "LinkedIn" ? firstName : undefined, combo.dmBank, city);
    } else {
      // Closed profile: a public comment, written fresh by the model for
      // THIS post. There is deliberately no template bank here. A bank is
      // safe in a private DM and dangerous in public, where the same fifteen
      // sentences appearing under hundreds of posts is precisely the pattern
      // that gets comments hidden. If the model is unavailable or the draft
      // reads too close to one we already posted, the lead is dropped rather
      // than filled with something repeatable.
      //
      // Two kinds of post reach this point and they need different framing. A
      // hiring post has a role to react to; an industry post has none, and
      // telling the model "the role they are hiring for is CFO" about someone
      // writing on month-end close invents a job that was never mentioned and
      // produces a comment that visibly misreads the post.
      const author = [authorName, title, company ? `at ${company}` : undefined].filter(Boolean).join(", ");
      const brief = combo.id === "industry_conversation"
        ? `They are not advertising a job here, so do NOT mention hiring, recruiting, candidates, or a search. React to the substance of what they wrote as a peer who works alongside ${jobTitle}s${city ? ` in ${city}` : ""} would, and make the closing invitation a peer one: an offer to trade notes on the problem they wrote about.`
        : `The role they are hiring for is ${jobTitle}${city ? ` in ${city}` : ""}.`;
      const drafted = await draft(POST_COMMENT_RULES,
        `THEIR POST (by ${author}):\n${c.text.slice(0, 900)}\n\n${brief} Write the comment.${varietyBrief(workspaceId)}`);
      if (!drafted) { g.commentDraft++; continue; }
      const candidate = fitComment(scrub(drafted));
      if (!candidate) { g.commentDraft++; continue; }
      const leak = pitchLeakReason(candidate, c.text);
      if (leak) { g.commentLeak++; console.log(`[comment-radar] draft dropped, ${leak}: ${candidate}`); continue; }
      // Compared against what was already posted AND what is still sitting in
      // the approval queue: a single tick drafting eight comments that rhyme
      // with each other is the same tell as posting eight that do.
      if (tooSimilar(candidate, priorComments(workspaceId))) { g.commentDupe++; continue; }
      commentDraft = candidate;
      pendingComments++;
    }

    state.items.push({
      id, workspaceId, kind: "poster",
      postId: c.postId, postExcerpt: c.text.slice(0, 700), postAt: c.postAt,
      postUrl: c.postUrl,
      commentId: "", commentText: "",
      openProfile: prof.openProfile,
      industry: industryOf([company ?? "", headline ?? "", c.text].join(" ")),
      matchedRole: combo.role ?? combo.key,
      accountId: sendAccount.accountId,
      authorProviderId: prof.providerId,
      authorName,
      authorHeadline: headline,
      authorPublicUrl: prof.publicUrl ?? c.postUrl,
      networkDistance: prof.networkDistance,
      posterLocation: prof.location,
      title: title ?? headline, company,
      seniority: intel.seniority, jobFunction: intel.function,
      decisionMaker: true, peer: false, hiring, tier: "hot",
      replyStatus: "none",
      ...(direct
        ? { dmText, dmStatus: "suggested" as const }
        : { commentDraft, commentStatus: "suggested" as const }),
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    // The weekly stamp, at the only point that earns it: a draft now exists for
    // this person - a DM or a comment - so nothing else may draft them again
    // for POSTER_RECHECK_DAYS.
    seenAuthors[c.authorRef] = nowIso();
    seenAuthors[prof.providerId] = nowIso();
    rota++;
    created++;
    stats.leads += 1;
    save();
  }

  state.keywordCursor[`${workspaceId}:rota`] = rota % 1_000_000;
  if (seenArr.length > SEEN_CAP) state.seen[workspaceId] = seenArr.slice(-SEEN_CAP);
  save();
  console.log(`[comment-radar] market "${keyword}" via ${source}: results=${candidates.length} created=${created} gates=${JSON.stringify(g)}`);
  return created;
}

/* ------------------------------------------------------------------ */
/* Reads + actions                                                      */
/* ------------------------------------------------------------------ */

export interface CommentWatchView {
  status: CommentWatchStatus;
  autopilot: { enabled: boolean; source: "manual" | "default_on" | "off" };
  /** The market-scan keyword bank in effect (backend defaults or override). */
  keywords: string[];
  /** Scenario picker: the suggestion menu + what is active for this workspace. */
  scenarioPresets: Array<{ id: string; label: string; hint: string }>;
  scenarios: { presets: string[]; custom: Array<{ label: string; phrase: string }> };
  /** Last discovery-engine failure (e.g. Serper out of credits), if any. */
  lastError?: string;
  lastScan?: string;
  items: CommentLeadItem[];
  /** Hunt economics for the monitoring strip: today + a short history. */
  stats: { today: HuntDayStats; days: Array<{ day: string } & HuntDayStats> };
  /** Set-and-forget: leads in these industries send without approval. */
  autoIndustries: string[];
  industryOptions: Array<{ key: string; label: string }>;
  /** The public-comment lane: its limits and where today stands against them. */
  commentThrottle: CommentThrottle;
  /** Outcome tracker: every posted comment still in its watch/retention
   *  window, plus the tallies the card leads with. */
  tracked: CommentLeadItem[];
  trackedTally: {
    /** Comments posted, all time (the throttle's own send log). */
    postedTotal: number;
    /** Posted in the trailing 7 days. */
    posted7d: number;
    /** Tracked items where the poster wrote back. */
    responded: number;
    /** Live threads still being watched. */
    watching: number;
    /** Watch window expired with no reply (already on the email path). */
    noResponse: number;
    /** Follow-up replies staged and waiting for approval. */
    followUpsOpen: number;
  };
}

const TIER_RANK: Record<CommentTier, number> = { hot: 0, warm: 1, community: 2 };

export async function commentWatchView(workspaceId: string): Promise<CommentWatchView> {
  await hydrate();
  const status = await commentWatchStatus(workspaceId);
  const autopilot = await commentWatchAutopilot(workspaceId);
  const items = state.items
    .filter((i) => i.workspaceId === workspaceId && i.tier !== "community" && actionable(i)
      // Wall-hits never reach the approval list, including ones captured
      // before the current wall tightened (they also cannot be approved).
      && !((i.dmStatus === "suggested" || i.commentStatus === "suggested") && wallForItem(i)))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.createdAt.localeCompare(a.createdAt));
  // The outcome tracker: posted comments, newest first, responded and
  // follow-up-ready threads pinned to the top.
  const trackRank = (i: CommentLeadItem): number =>
    i.followUpStatus === "suggested" ? 0
    : i.responseStatus === "responded" ? 1
    : i.responseStatus === "pending" || i.responseStatus === "posted" ? 2
    : i.responseStatus === "failed" ? 3 : 4;
  const tracked = state.items
    .filter((i) => i.workspaceId === workspaceId && i.kind === "poster" && i.commentStatus === "approved")
    .sort((a, b) => trackRank(a) - trackRank(b)
      || (b.commentPostedAt ?? b.updatedAt).localeCompare(a.commentPostedAt ?? a.updatedAt));
  return {
    status, autopilot,
    keywords: marketKeywordsFor(workspaceId),
    scenarioPresets: SCENARIO_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
    scenarios: scenariosFor(workspaceId),
    lastError: state.lastError[workspaceId],
    lastScan: state.lastScan[workspaceId],
    items,
    stats: {
      today: huntStatsFor(workspaceId),
      days: Object.entries(state.dayStats[workspaceId] ?? {})
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .slice(0, 7)
        .map(([day, s]) => ({ day, ...s })),
    },
    autoIndustries: autoIndustriesFor(workspaceId),
    industryOptions: INDUSTRY_MATCHERS.map((m) => ({ key: m.key, label: m.label })),
    commentThrottle: commentThrottleFor(workspaceId),
    tracked,
    trackedTally: {
      postedTotal: (state.commentLog[workspaceId] ?? []).length,
      posted7d: (state.commentLog[workspaceId] ?? [])
        .filter((t) => Date.now() - new Date(t).getTime() < 7 * 86_400_000).length,
      responded: tracked.filter((i) => i.responseStatus === "responded").length,
      watching: tracked.filter((i) => i.responseStatus === "pending" || i.responseStatus === "posted").length,
      noResponse: tracked.filter((i) => i.responseStatus === "no_response").length,
      followUpsOpen: tracked.filter((i) => i.followUpStatus === "suggested").length,
    },
  };
}

function findItem(workspaceId: string, id: string): CommentLeadItem | undefined {
  return state.items.find((i) => i.workspaceId === workspaceId && i.id === id);
}

export async function draftReply(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.replyStatus === "approved") return null;
  const persona = [item.authorName, item.title, item.company ? `at ${item.company}` : undefined].filter(Boolean).join(", ");
  const text = await draft(REPLY_RULES,
    `MY POST:\n${item.postExcerpt || "(no text)"}\n\nTHEIR COMMENT (by ${persona}):\n${item.commentText}\n\nWrite the reply.`);
  if (!text) return null;
  item.replyText = text;
  item.replyStatus = "suggested";
  item.updatedAt = nowIso();
  save();
  return item;
}

export async function editReply(workspaceId: string, id: string, text: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.replyStatus !== "suggested") return null;
  item.replyText = scrub(text).slice(0, 1200);
  item.updatedAt = nowIso();
  save();
  return item;
}

export async function skipReply(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.replyStatus !== "suggested") return null;
  item.replyStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Approve the reply: hand it to the shared engine (caps/health/ledger apply).
 *  HOT items are connect-first: the reply stays locked until the connection
 *  request went out (or was deliberately skipped). */
export async function approveReply(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.replyStatus !== "suggested" || !item.replyText) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  const replyWall = wallForItem(item);
  if (replyWall) {
    item.replyStatus = "blocked"; item.reason = `Recruiter/staffing firm: excluded by policy (${replyWall}).`; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  if (editedText && scrub(editedText).length >= 2) item.replyText = scrub(editedText).slice(0, 1200);

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts.find((a) => a.ownerUserId === userId) ?? accounts.find((a) => !a.ownerUserId) ?? accounts[0];
  if (!account) {
    item.replyStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title, providerProfileId: item.authorProviderId,
      },
      actionType: "comment_post",
      payload: {
        postUrl: item.postId, commentId: item.commentId, text: item.replyText,
        providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl,
      },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `licw_reply_${item.id}`,
    });
    if (result.accepted) {
      item.replyStatus = "approved"; item.reason = undefined;
    } else {
      item.replyStatus = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.replyStatus = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

export async function editDm(workspaceId: string, id: string, text: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.dmStatus !== "suggested") return null;
  const direct = item.openProfile === true || item.networkDistance === "DISTANCE_1";
  item.dmText = scrub(text).slice(0, direct ? 1200 : 280);
  item.updatedAt = nowIso();
  save();
  return item;
}

export async function skipDm(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.dmStatus !== "suggested") return null;
  item.dmStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Approve the market-radar message. OPEN PROFILES ONLY (plus existing
 *  1st-degree connections): a plain direct message, never an InMail. Closed
 *  profiles are never messaged and never connect-noted from this lane. */
export async function approveDm(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.kind !== "poster" || item.dmStatus !== "suggested" || !item.dmText) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  const dmWall = wallForItem(item);
  if (dmWall) {
    item.dmStatus = "blocked"; item.reason = `Recruiter/staffing firm: excluded by policy (${dmWall}).`; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  const direct = item.openProfile === true || item.networkDistance === "DISTANCE_1";
  if (!direct) {
    item.dmStatus = "skipped"; item.reason = "Open profiles only: closed profiles are never messaged from this lane.";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  if (editedText && scrub(editedText).length >= 2) item.dmText = scrub(editedText).slice(0, 1200);

  const accounts = await connectedAccounts(workspaceId);
  // The seat that scouted this lead sends the DM (multi-account rota).
  const account = accounts.find((a) => a.accountId === item.accountId)
    ?? accounts.find((a) => a.ownerUserId === userId)
    ?? accounts.find((a) => !a.ownerUserId)
    ?? accounts[0];
  if (!account) {
    item.dmStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  // Always a plain "message": open profiles take a DM with no connection
  // needed. Never "inmail", never "connect_note" from this lane.
  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title,
        providerProfileId: item.authorProviderId, prospectId: item.prospectId,
      },
      actionType: "message",
      payload: {
        text: item.dmText,
        providerProfileId: item.authorProviderId,
        linkedinUrl: item.authorPublicUrl,
        // Not a connection: route over the free open-profile InMail lane.
        openProfile: item.openProfile === true && item.networkDistance !== "DISTANCE_1",
        subject: item.matchedRole && !item.matchedRole.includes(":") ? `Your ${item.matchedRole} opening` : "Your hiring post",
      },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `licw_dm_${item.id}`,
    });
    if (result.accepted) {
      item.dmStatus = "approved"; item.reason = undefined;
    } else {
      item.dmStatus = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.dmStatus = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

/* ---------------- the public-comment lane: edit, skip, approve ---------- */

export async function editPostComment(workspaceId: string, id: string, text: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.commentStatus !== "suggested") return null;
  item.commentDraft = scrub(text).slice(0, MAX_COMMENT_CHARS);
  item.updatedAt = nowIso();
  save();
  return item;
}

/**
 * Rewrite every OPEN public-comment draft under the current copy rules.
 *
 * Exists for rule changes (owner ask 2026-08-19: drafts now close with an
 * invitation to engage): drafting happens once at capture, so a queue built
 * under the old rules would otherwise sit there reading exactly like the
 * copy the owner just rejected. Only "suggested" items are touched; anything
 * approved, skipped, or blocked keeps its history. A failed or leaky redraft
 * keeps the existing text rather than losing the lead.
 */
export async function redraftOpenComments(workspaceId: string): Promise<{ redrafted: number; kept: number }> {
  await hydrate();
  const open = state.items.filter((i) =>
    i.workspaceId === workspaceId && i.kind === "poster" && i.commentStatus === "suggested" && i.commentDraft);
  let redrafted = 0, kept = 0;
  for (const item of open) {
    const author = [item.authorName, item.title, item.company ? `at ${item.company}` : undefined].filter(Boolean).join(", ");
    const role = item.matchedRole ?? "candidate";
    const city = cityFromPost(item.postExcerpt ?? "") ?? cityFromLocation(item.posterLocation);
    // The scenario that captured the item is not stored on it, so hiring vs
    // industry framing is re-read from the post itself, same regex as capture.
    const brief = HIRING_INTENT_RE.test(item.postExcerpt ?? "")
      ? `The role they are hiring for is ${role}${city ? ` in ${city}` : ""}.`
      : `They are not advertising a job here, so do NOT mention hiring, recruiting, candidates, or a search. React to the substance of what they wrote as a peer would, and make the closing invitation a peer one: an offer to trade notes on the problem they wrote about.`;
    const drafted = await draft(POST_COMMENT_RULES,
      `THEIR POST (by ${author}):\n${(item.postExcerpt ?? "").slice(0, 900)}\n\n${brief} Write the comment.${varietyBrief(workspaceId, item.commentDraft)}`);
    if (!drafted) { kept++; continue; }
    const candidate = fitComment(scrub(drafted));
    // The dup check excludes the item's OWN current draft: a rewrite of the
    // same post legitimately shares most of its content words with the text
    // it is replacing, and comparing against it would freeze every draft in
    // whatever state (including a truncated one) it already has.
    const priors = priorComments(workspaceId).filter((t) => t !== item.commentDraft);
    if (!candidate || pitchLeakReason(candidate, item.postExcerpt ?? "") || tooSimilar(candidate, priors)) { kept++; continue; }
    item.commentDraft = candidate;
    item.updatedAt = nowIso();
    redrafted++;
  }
  if (redrafted) save();
  return { redrafted, kept };
}

export async function skipPostComment(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.commentStatus !== "suggested") return null;
  item.commentStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/**
 * Approve the public comment on a closed profile's hiring post.
 *
 * This is the only lane that writes where everyone can see it, so it carries
 * gates the DM lane does not: the recruiter wall (as everywhere), the
 * day/week/spacing throttle, and the near-duplicate check against what this
 * workspace has already posted. A throttle refusal leaves the draft OPEN, not
 * skipped: the comment is still worth posting, just not this minute.
 */
export async function approvePostComment(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.commentStatus !== "suggested" || !item.commentDraft) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  const wall = wallForItem(item);
  if (wall) {
    item.commentStatus = "blocked"; item.reason = `Recruiter/staffing firm: excluded by policy (${wall}).`;
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  // Re-checked here as well as at capture, so a draft taken under an older
  // market list cannot be approved into a public comment about the wrong one.
  const offMarket = await offMarketReason(item.posterLocation);
  if (offMarket) {
    item.commentStatus = "blocked"; item.reason = `Outside this desk's market: ${offMarket}.`;
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  if (editedText && scrub(editedText).length >= 2) item.commentDraft = scrub(editedText).slice(0, MAX_COMMENT_CHARS);

  // The throttle. Refusals do NOT consume the draft: it stays in the list and
  // can go out in the next slot.
  const throttle = commentThrottleFor(workspaceId);
  if (throttle.blockedReason) {
    return { item, accepted: false, reason: throttle.blockedReason };
  }
  if (tooSimilar(item.commentDraft, state.commentRecent[workspaceId] ?? [])) {
    return { item, accepted: false, reason: "This reads too close to a comment already posted from this account. Edit it before approving." };
  }

  const accounts = await connectedAccounts(workspaceId);
  // The seat that scouted the post comments on it (multi-account rota).
  const account = accounts.find((a) => a.accountId === item.accountId)
    ?? accounts.find((a) => a.ownerUserId === userId)
    ?? accounts.find((a) => !a.ownerUserId)
    ?? accounts[0];
  if (!account) {
    item.commentStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title,
        providerProfileId: item.authorProviderId, prospectId: item.prospectId,
      },
      actionType: "comment_post",
      payload: {
        postUrl: item.postId, text: item.commentDraft,
        providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl,
      },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `licw_pubcomment_${item.id}`,
    });
    if (result.accepted) {
      item.commentStatus = "approved"; item.reason = undefined;
      // Outcome tracking starts here: the ledger record is how the response
      // checker learns the comment actually posted (and its provider id).
      item.commentActionId = result.record?.id;
      item.responseStatus = "pending";
      // Only an accepted action counts against the day and the week.
      recordComment(workspaceId, item.commentDraft);
    } else {
      item.commentStatus = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.commentStatus = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

export async function skipConnect(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.connectStatus !== "suggested") return null;
  item.connectStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Approve the staged connection note: the FIRST touch for a hot commenter. */
export async function approveConnect(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.connectStatus !== "suggested" || !item.connectText) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  const connWall = wallForItem(item);
  if (connWall) {
    item.connectStatus = "blocked"; item.reason = `Recruiter/staffing firm: excluded by policy (${connWall}).`; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
  if (editedText && scrub(editedText).length >= 2) item.connectText = scrub(editedText).slice(0, 280);

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts.find((a) => a.ownerUserId === userId) ?? accounts.find((a) => !a.ownerUserId) ?? accounts[0];
  if (!account) {
    item.connectStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title, providerProfileId: item.authorProviderId,
      },
      actionType: "connect_note",
      payload: {
        note: item.connectText,
        providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl,
      },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `licw_conn_${item.id}`,
    });
    if (result.accepted) {
      item.connectStatus = "approved"; item.reason = undefined;
    } else {
      item.connectStatus = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.connectStatus = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler tick                                                       */
/* ------------------------------------------------------------------ */

/** Scan every workspace with a connected LinkedIn account. */
export async function tickCommentWatch(): Promise<void> {
  await hydrate();
  const { accounts } = await import("./os/store");
  const all = await accounts.all();
  const workspaces = [...new Set(all.filter((a) => providerIdOf(a) && a.connected !== false).map((a) => a.workspaceId))];
  if (!workspaces.length) console.log(`[comment-radar] tick: no connected workspaces (${all.length} account records)`);
  for (const ws of workspaces) {
    try { await scanWorkspace(ws); } catch (e) {
      console.log(`[comment-radar] ${ws}: scan error (${e instanceof Error ? e.message : e})`);
    }
  }
}
