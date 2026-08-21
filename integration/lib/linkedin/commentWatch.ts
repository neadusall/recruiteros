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
import { jobSeekerReason } from "../outreach/jobSeeker";
import { employmentVerdict, notABuyerReason, type WorkEntry } from "../outreach/employment";
import { requestLinkedInAction } from "./os/engine";
import { ensureAccount, listAccounts } from "./os/health";
import { putPolicy } from "./os/policy";
import { seatsForWorkspace, markSeatChecked } from "./seats";
import { unipileRequest, UnipileError } from "./provider";
import { listMembers } from "../auth/team";
import { readIntent, commentBrief, THRESHOLDS } from "./hiringIntent";
import { recordSignal, rankAccounts, pruneLedger, type IntentLedger, type RankedAccount } from "./intentLedger";
import type { LiAccountState } from "./os/types";

const POSTS_TO_WATCH = 5;        // owner's most recent posts scanned per tick
const COMMENTS_PER_POST = 100;   // first page is plenty at this volume
const NEW_PER_TICK = 15;         // commenters fully processed per tick (rest next tick)
const SEEN_CAP = 8000;           // per-workspace dedupe memory
const ITEM_TTL_DAYS = 21;
// Market-scan pacing: one keyword search per tick (rotating through the
// bank), each hit costing a profile read, so the lane trickles steadily.
const MARKET_RESULTS_PER_SEARCH = 20;
// Discovery BREADTH (owner mandate 2026-08-20: five seats, 14 to 16 posted
// comments a day EACH). One search a tick could not feed that. The bank is 20+
// roles across 7 scenarios, so a single rotating search revisited the same
// combo several times a day and its results died in the `seen` gate: 8/20 ran
// 99 searches, screened 792 posts and created 9 drafts, against a desk that
// needs ~70. Several combos now run per tick, and a combo coming round again
// asks Google for its NEXT page instead of re-reading the same twenty links.
const MARKET_SEARCHES_PER_TICK = Math.max(1, Number(process.env.ROLE_HUNTER_SEARCHES_PER_TICK ?? 4));
const MARKET_PAGE_DEPTH = Math.max(1, Number(process.env.ROLE_HUNTER_PAGE_DEPTH ?? 3));
// How far back the index is asked to look. The post-age gate below is the real
// ceiling; this only decides how much corpus Google offers up in the first
// place, and at one week the narrow site: queries were returning ~8 results.
const MARKET_TIME_WINDOW = process.env.ROLE_HUNTER_TIME_WINDOW ?? "qdr:m";
// A reachable poster normally takes the private DM. With this on (the
// default) they take the comment lane instead whenever the desk is short of
// comment drafts for the day: the DM bank is not the scarce resource here,
// drafted comments are. ROLE_HUNTER_COMMENT_FIRST=0 restores DM-first.
const COMMENT_FIRST = process.env.ROLE_HUNTER_COMMENT_FIRST !== "0";
const POSTER_NEW_PER_TICK = 8;   // drafts created per combo
const POSTER_NEW_PER_SCAN = Math.max(POSTER_NEW_PER_TICK, Number(process.env.ROLE_HUNTER_NEW_PER_SCAN ?? 24));
// THE budget that actually matters. Search credits are a tenth of a cent; a
// recruiter's LinkedIn account is not replaceable, and profile views are the
// thing LinkedIn counts. Widening discovery made every result a fresh one,
// which turned ~0.5 reads per search into ~7 - so the whole scan now stops
// when the tick's read budget is gone, before the next search is even paid
// for. At 14 a tick that is ~1,300 reads a day across the desk: FEWER per
// seat than the two-seat desk was already running on 8/19 (540 over two), and
// it still clears the ~70 drafts a day five seats need, because roughly one
// read in four becomes a draft.
// Dropped 14 -> 3 on 2026-08-21. Fourteen reads fired inside 22 seconds and
// then the account went silent for fourteen and a half minutes, ninety-six
// times a day, on a 15-minute grid - and because the seat rota only advanced
// when a DRAFT was created, almost the whole burst landed on ONE recruiter.
// Every source on LinkedIn enforcement says the same thing: shape gets you
// caught before volume does. Three reads a tick, dealt one per seat by
// readRota, is one profile view per account every fifteen minutes.
const POSTER_READS_PER_SCAN = Math.max(1, Number(process.env.ROLE_HUNTER_READS_PER_SCAN ?? 3));
// Even three in a row is a burst if they land in the same second.
const READ_GAP_MIN_MS = Math.max(0, Number(process.env.ROLE_HUNTER_READ_GAP_MIN_MS ?? 2_000));
const READ_GAP_MAX_MS = Math.max(READ_GAP_MIN_MS, Number(process.env.ROLE_HUNTER_READ_GAP_MAX_MS ?? 9_000));
// How long an indexed profile hint stays good. A headline does not change
// weekly, and a cached hint costs nothing at all.
const PROFILE_HINT_TTL_DAYS = 14;
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
// Five seats each taking their comment slot in one tick, plus the DM, connect
// and reply approvals that share this budget: at 10 the comment lane was the
// thing that got cut off (owner mandate 2026-08-20).
const AUTO_PER_TICK = 18;        // autopilot approvals per tick (engine caps still apply)

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
// Catch-up floor. The ordinary 24-95 spread averages an hour, which only just
// fits 14-16 sends into a WHOLE day: a seat that sat idle half of it (nothing
// queued for it, a late reconnect, an adoption mid-afternoon) could never
// reach its allowance again, which is exactly what left three of Lume's five
// seats on zero on 8/20. So the spacing is paced: when what is left of the day
// no longer fits what is left of the allowance it compresses toward this floor
// - four an hour at the very hardest, still a cadence a person keeps - and it
// relaxes the moment the seat is back on pace.
const COMMENT_CATCHUP_GAP_MIN = Math.max(8, Number(process.env.ROLE_HUNTER_CATCHUP_GAP_MIN ?? 14));
const COMMENT_QUEUE_MULTIPLE = 2;      // draft at most 2 days of allowance
const COMMENT_LOG_KEEP_DAYS = 21;      // send log kept for the weekly window
const COMMENT_DUP_WINDOW = 25;         // recent comments checked for overlap
const COMMENT_DUP_RATIO = 0.6;         // >60% shared words = too similar
// Well under LinkedIn's 1,250 ceiling. 400 until 2026-08-19; raised so a
// full-length observation plus its closing invitation fits without either
// getting truncated (the CTA is appended, not folded in, on redrafts).
const MAX_COMMENT_CHARS = 340;
// Outcome tracking (owner ask 2026-08-19): how long a posted comment's thread
// is watched for the poster writing back, and how many threads each 15-min
// tick re-reads (round-robin, stalest first; at the lane's volume every live
// thread gets re-read well inside an hour).
const RESPONSE_WATCH_DAYS = 14;
const RESPONSE_CHECKS_PER_TICK = 6;
// Replies whose alert never fired, worked off a few per tick: a catch-up must
// not land as a dozen simultaneous texts on one recruiter's phone.
const REPLY_REFLEX_CATCHUP_PER_TICK = 3;

/** The keyword bank is the ROLES the desk places (owner decision 2026-08-13):
 *  each entry is a job title or phrase, searched against LinkedIn posts to
 *  find hiring managers posting that opening. The matched keyword becomes
 *  {job_title} in the MPC message. Editable on the card / keywords_set. */
// The desk is CFO / finance (owner decision 2026-08-15). Every keyword here is
// a finance leadership title, so both the hiring scenarios and the industry
// scenario below stay inside that market instead of reading as scattershot.
// Widened 2026-08-20 from seven titles: at seven, three scenarios made 21
// search combos, which 96 searches a day walked five times over, so nearly
// every result was one the `seen` gate had already rejected. Every entry is
// still a finance or accounting seat this desk actually places.
const DEFAULT_MARKET_KEYWORDS = [
  "CFO", "Chief Financial Officer", "Controller", "VP of Finance",
  "Director of Finance", "Assistant Controller", "FP&A Manager",
  "Corporate Controller", "Head of Finance", "Finance Director",
  "VP Finance", "Director of FP&A", "FP&A Director", "Finance Manager",
  "Chief Accounting Officer", "Accounting Manager", "Accounting Director",
  "Tax Manager", "Audit Manager", "Treasury Manager",
  "Senior Accountant", "Revenue Manager",
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
  /**
   * Which DM bank this scenario may draw from.
   *
   * This is a CLAIM budget, not a tone setting. "growth" templates assert a fact
   * about the reader ("saw the news about the team growing"), so only a scenario
   * whose own match establishes that fact may use it - `team_growth`,
   * `new_location` and `funding_growth` all require the announcement in the post
   * text. "peer" asserts nothing at all and is the correct bank for a scenario
   * that matched on subject matter rather than on an event.
   *
   * Getting this wrong is what produced "Saw the news about the team growing" to
   * a man who had posted about cash-flow reporting (2026-08-21). He had
   * announced nothing; we told him he had. See assertScenarioBanks().
   */
  dmBank: "mpc" | "growth" | "peer";
  /** Role-based scenarios that are NOT about hiring pair the role with one of
   *  these topics for the Unipile post search, instead of "<role> hiring". */
  unipileTopics?: string[];
  /**
   * May the PUBLIC COMMENT lane act on this scenario? (owner decision 2026-08-21)
   *
   * Comments are now restricted to posts from people who are ACTIVELY HIRING one of our roles,
   * and nothing else. This is deliberately its own flag rather than a reuse of `hiringIntent`:
   * that field means "require hiring language in the post text before accepting the candidate"
   * and is false on `struggling_to_fill`, which is unmistakably a hiring post ("third time
   * posting", "hard to fill"). Overloading it would have silently dropped the single best
   * scenario this desk has.
   *
   * The other scenarios keep earning their place in DISCOVERY and in the DM lane - a funding
   * round or a new location really is a hiring signal, just not an advertised opening. What they
   * no longer do is put a public comment under a post that never mentioned a job, which is what
   * made the comment trail read as a desk commenting on everything.
   */
  commentEligible?: boolean;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "hiring_role", label: "Posting an opening for a role I place",
    hint: "They announced they are hiring one of your roles",
    roleBased: true, orGroup: `hiring OR "open role" OR "open position" OR "looking for" OR "join our team"`,
    hiringIntent: true, dmBank: "mpc", commentEligible: true,
  },
  {
    id: "urgent_backfill", label: "Urgent or backfill hires",
    hint: "Urgent, immediate, or backfill language on your roles",
    roleBased: true, orGroup: `urgent OR immediately OR backfill OR asap OR "start right away"`,
    hiringIntent: true, dmBank: "mpc", commentEligible: true,
  },
  {
    id: "struggling_to_fill", label: "Struggling to fill a role",
    hint: "Complaining a search is hard: your MPC lands best here",
    roleBased: true, orGroup: `"struggling to hire" OR "hard to fill" OR "hard to find" OR "cannot find" OR "third time posting"`,
    hiringIntent: false, dmBank: "mpc", commentEligible: true,
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
    // "peer", not "growth": this scenario matches somebody discussing their
    // CRAFT, which tells us nothing about whether they are growing or hiring.
    hiringIntent: false, dmBank: "peer",
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

/**
 * Peer bank: for scenarios that matched on SUBJECT MATTER, where all we can
 * honestly say is that we read their post and we recruit in their function.
 *
 * Every line here is constrained to two facts we actually hold: their post
 * exists (we matched it), and this is the role we place. Nothing about their
 * company, their team, or their plans - because at this point we know none of it.
 */
const PEER_DM_TEMPLATES = [
  "Your post came up in my feed and it is the same thing I hear from finance leaders all week. I recruit {job_title}s, so if hiring ever comes up, happy to share who is genuinely good and available.",
  "Good post, and a fair point. I run {job_title} searches for a living, so if you ever want a read on what the market looks like for that seat, just ask.",
  "Read your post. I place {job_title}s, so I get a decent view of who is out there. Happy to be a resource if it is ever useful, no pitch either way.",
];

/**
 * A scenario may only draw from a bank whose claims its own match establishes.
 *
 * This runs as a test rather than at import time so that a bad pairing fails a
 * build instead of a live tick. The rule it encodes: a scenario that does not
 * require an announcement in the post text cannot use templates that reference
 * one. Exported so lib/linkedin/selftest.ts can assert it.
 */
export function assertScenarioBanks(): string[] {
  const problems: string[] = [];
  const assertsEvent = (id: string) => id === "growth";
  // Scenarios whose orGroup literally requires the announcement being referenced.
  const establishesEvent = new Set(["team_growth", "new_location", "funding_growth"]);
  for (const p of SCENARIO_PRESETS) {
    if (assertsEvent(p.dmBank) && !establishesEvent.has(p.id)) {
      problems.push(`${p.id} uses the "growth" bank, whose templates claim the reader announced growth, but its match does not establish that.`);
    }
  }
  return problems;
}

/** Deterministic template pick + fill; trims to the DM threshold. */
function mpcDmFor(seed: string, jobTitle: string, firstName?: string, bank: "mpc" | "growth" | "peer" = "mpc", city?: string): string {
  const pool = bank === "growth" ? GROWTH_DM_TEMPLATES : bank === "peer" ? PEER_DM_TEMPLATES : MPC_DM_TEMPLATES;
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
  /** When the ENGINE reserved a slot for this comment. A reservation is not a
   *  send: the engine schedules it into the seat's working-hours window and
   *  posts it later. Counted as in-flight by the throttle, never as posted. */
  commentReservedAt?: string;
  /** When this comment was counted against the seat's day/week, which happens
   *  once, on the engine confirming it actually went out. */
  commentCountedAt?: string;
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
  /** Stamped the first time a reply is seen, which is also the only time the
   *  recruiter is told about it. Its presence is what makes the alert
   *  once-ever rather than once-per-tick. */
  replyAlertAt?: string;
  /** The invitation this reply triggered, from the seat that commented. */
  replyConnectStatus?: "queued" | "skipped";
  replyConnectReason?: string;
  /** The owner's OWN in-thread reply once the poster responds. Never
   *  machine-drafted (owner ask 2026-08-19); "suggested" only survives on
   *  legacy items staged before that decision and is ignored by the UI. */
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
  /** ws -> the predictive hiring-intent account ledger: every scored post recorded against
   *  its company, so three separate weak signals from one employer outrank one loud signal from
   *  a company we never hear from again. See lib/linkedin/intentLedger.ts. */
  intentLedger: Record<string, IntentLedger>;
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
  /** ws -> the env-carried owner mandate to enable comment auto-posting has
   *  been applied once. The stamp, not the setting, is what makes it one-shot:
   *  an owner who later flips the switch off in the UI stays off. */
  autopostMandate: Record<string, boolean>;
  /** ws -> the exact limits directive already applied (see
   *  RECRUITEROS_COMMENT_LIMITS_MANDATE). Same one-shot-by-stamp contract:
   *  a directive applies once, later UI edits win, a NEW directive value
   *  applies once again. */
  limitsMandate: Record<string, string>;
  /** ws -> the per-seat send logs were rebuilt once from posted items when
   *  the throttle went per-seat (2026-08-20). Without this backfill a seat
   *  that already posted today would start from a zero count and could run
   *  its full fresh allowance on top of what it actually sent. */
  seatLogBuilt: Record<string, boolean>;
  /** ws -> the exact scenario directive already applied (see
   *  ROLE_HUNTER_SCENARIOS_MANDATE). Same one-shot-by-stamp contract as the
   *  limits mandate: it applies once, a later UI edit wins, and a NEW
   *  directive value applies once again. */
  scenarioMandate: Record<string, string>;
  /** ws -> the exact engine-capacity directive already applied (see
   *  ROLE_HUNTER_INTERACTIONS_MANDATE). One-shot by value, like the others. */
  interactionsMandate: Record<string, string>;
  /** ws -> the send log has been rebuilt from engine-confirmed posts, once.
   *  Before 2026-08-21 it was written at reservation time and so counted
   *  comments that had not gone out (and, for three seats, never had). */
  sendLogTruthBuilt: Record<string, boolean>;
  /** ws -> slug -> what Google's index knows about that person. The cheap
   *  half of the screen: a headline read out of the index costs $0.0005 and
   *  no LinkedIn action at all, where the same fact read off the platform
   *  costs a profile view on a recruiter's own account. */
  profileHints: Record<string, Record<string, { at: string; found: boolean; headline?: string; snippet?: string }>>;
  /** ws -> the exact profile-view capacity directive already applied. */
  profileViewsMandate: Record<string, string>;
}

/** Bumped 2026-08-19: drafts must close with a call to action (owner ask).
 *  Epoch 2 same day: the epoch-1 rewrite hard-sliced two overlong drafts
 *  mid-word ("Happy to compare not") and let one closing formula repeat
 *  across the queue; rewrite once more with the sentence-safe fit and the
 *  variety brief in place. Epoch 3: epoch 2's variety push made the model
 *  drop the invitation entirely (13 of 18 shipped observation-only) and one
 *  greeting post drew a meta-refusal; the invitation is now enforced with a
 *  corrective retry, contentless posts SKIP out of the queue, and used
 *  closings are banned by wording. Epoch 4: epoch 3's full rewrites lost to
 *  their own guards (3 of 18 landed); the pass is now surgical - append the
 *  missing invitation to a sound observation, full-rewrite only meta text,
 *  leave drafts that already close with an ask untouched. */
const COMMENT_COPY_EPOCH = 5;

const KEY = "linkedin_comment_watch_v1";
let state: WatchState = { items: [], seen: {}, ownProfile: {}, posterSeen: {}, closedProfiles: {}, dayStats: {}, autoIndustries: {}, marketKeywords: {}, keywordCursor: {}, scenarios: {}, intentLedger: {}, commentLog: {}, commentRecent: {}, commentLimits: {}, lastError: {}, paused: {}, autoMode: {}, lastScan: {}, redraftEpoch: {}, autopostMandate: {}, limitsMandate: {}, seatLogBuilt: {}, scenarioMandate: {}, interactionsMandate: {}, sendLogTruthBuilt: {}, profileHints: {}, profileViewsMandate: {} };

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
          intentLedger: snap.intentLedger ?? {},
          commentLog: snap.commentLog ?? {},
          commentRecent: snap.commentRecent ?? {},
          commentLimits: snap.commentLimits ?? {},
          lastError: snap.lastError ?? {},
          paused: snap.paused ?? {},
          autoMode: snap.autoMode ?? {},
          lastScan: snap.lastScan ?? {},
          redraftEpoch: snap.redraftEpoch ?? {},
          autopostMandate: snap.autopostMandate ?? {},
          limitsMandate: snap.limitsMandate ?? {},
          seatLogBuilt: snap.seatLogBuilt ?? {},
          scenarioMandate: snap.scenarioMandate ?? {},
          interactionsMandate: snap.interactionsMandate ?? {},
          sendLogTruthBuilt: snap.sendLogTruthBuilt ?? {},
          profileHints: snap.profileHints ?? {},
          profileViewsMandate: snap.profileViewsMandate ?? {},
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

/**
 * Seats the owner has parked, carried in env as "ws:accountId" pairs.
 *
 * The engine's kill switch is the real control and the portal toggle is the
 * normal way to reach it. This exists because the account store hydrates ONCE
 * per process: editing the snapshot on disk does nothing to a running app and
 * gets overwritten by the next save, so there is no server-side way to park a
 * seat without a session. An env pause is declarative, survives a redeploy,
 * and is visible to anyone reading the config.
 */
function seatPaused(workspaceId: string, accountId: string): boolean {
  const list = (process.env.ROLE_HUNTER_PAUSED_SEATS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return list.includes(`${workspaceId}:${accountId}`);
}

async function connectedAccounts(workspaceId: string): Promise<LiAccountState[]> {
  try {
    const all = await listAccounts(workspaceId);
    return all.filter((a) => providerIdOf(a) && a.connected !== false && !a.killSwitch
      && !seatPaused(workspaceId, a.accountId));
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
  const commentedSeats = new Set<string>();
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
        // The throttle is per SEAT (owner mandate 2026-08-20: every recruiter
        // runs the lane on their own walls): the item's assigned seat is the
        // one gated, so five connected recruiters can each take their slot in
        // the same tick while any one seat still posts at most once per tick,
        // and its spacing gate holds the rest of that seat's backlog.
        // A refusal leaves the draft open for the next slot.
        const seatId = item.accountId;
        if (!seatId || commentedSeats.has(seatId)) continue;
        if (commentThrottleFor(workspaceId, seatId).blockedReason) continue;
        const r = await approvePostComment(workspaceId, "", APPROVER, item.id);
        if (r.accepted) { sent++; commentedSeats.add(seatId); }
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
  /** Committed today: confirmed sends PLUS reservations still in the engine. */
  todayUsed: number;
  /** Confirmed out on LinkedIn today. The honest number. */
  todaySent: number;
  /** Reserved with the engine today and not yet confirmed out. */
  todayQueued: number;
  weekUsed: number;
  /** Set when spacing is the thing holding the next comment back. */
  nextSlotAt?: string;
  /** Set when a comment right now would be refused, and why. */
  blockedReason?: string;
  /** Aggregate view only: how many connected seats the totals span. The
   *  perDay/perWeek fields stay the PER-SEAT configuration. */
  seats?: number;
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
 *
 * PER SEAT since 2026-08-20 (owner mandate: every recruiter runs the lane):
 * pass the seat's accountId and the limits, allowance, and jitter seed are
 * that RECRUITER's, so five connected seats each carry their own 12-16/day
 * rather than splitting one workspace budget. Without an accountId the
 * legacy workspace-wide numbers come back (kept for display fallback and
 * old tests; the posting gates always pass the seat).
 */
function dayAllowanceFor(workspaceId: string, day: string, accountId?: string): number {
  const { perDay } = commentLimitsFor(workspaceId);
  if (perDay <= 0) return 0;
  const r = (seedHash(`${workspaceId}:${accountId ? `${accountId}:` : ""}${day}:allow`) % 1000) / 1000;
  const factor = 1 - COMMENT_DAY_JITTER + r * 2 * COMMENT_DAY_JITTER;
  return Math.max(1, Math.round(perDay * factor));
}

/**
 * THE LINKEDIN ENGINE'S OWN CAPACITY, mirrored once per scan.
 *
 * The lane used to carry its own idea of how many comments a seat could post
 * in a day (a jittered 14-16) while the engine carried a different one (a
 * daily target of 10 for the `interactions` category, hard ceiling 20). The
 * engine wins every argument, because it is the thing that actually posts, so
 * the disagreement did not show up as an error - it showed up as 22 comments
 * refused for one seat on 8/21 while the card read green.
 *
 * There is one source of capacity now and it is the engine's. This mirror
 * exists only because commentThrottleFor is synchronous and reachable from
 * the view; it is refreshed at the top of every scan, before anything is
 * approved. An empty mirror means "not read yet" and clamps nothing, so a
 * cold start behaves exactly as before rather than blocking the whole lane.
 */
interface SeatCategoryRoom { target: number; ceiling: number; committed: number }
interface SeatEngineRoom { day: string; target: number; ceiling: number; committed: number; views?: SeatCategoryRoom }
const engineRoom = new Map<string, SeatEngineRoom>();
/** Profile views spent THIS UTC day, per seat, by the scan itself. The engine
 *  cannot count these for us: fetchProfileLite talks to the provider directly,
 *  because the scan needs the answer inside the loop and the engine's queue
 *  hands answers back minutes later. So the lane keeps the tally and checks it
 *  against the engine's OWN profile_views policy - one authority for the
 *  number, even though the action does not run through the queue. */
const seatViews = new Map<string, { day: string; used: number }>();

function viewsUsedToday(workspaceId: string, accountId: string): number {
  const k = seatLogKey(workspaceId, accountId);
  const day = nowIso().slice(0, 10);
  const cur = seatViews.get(k);
  if (!cur || cur.day !== day) { seatViews.set(k, { day, used: 0 }); return 0; }
  return cur.used;
}

function noteProfileView(workspaceId: string, accountId: string): void {
  const k = seatLogKey(workspaceId, accountId);
  const day = nowIso().slice(0, 10);
  const cur = seatViews.get(k);
  if (!cur || cur.day !== day) seatViews.set(k, { day, used: 1 });
  else cur.used += 1;
}

/** Has this seat any profile-view room left under the engine's own policy? */
function seatMayRead(workspaceId: string, accountId: string): boolean {
  const room = engineRoom.get(seatLogKey(workspaceId, accountId));
  if (!room?.views) return true; // mirror not read yet: behave as before
  const cap = Math.max(0, Math.min(room.views.target, room.views.ceiling));
  return viewsUsedToday(workspaceId, accountId) + room.views.committed < cap;
}

async function refreshEngineRoom(workspaceId: string, accounts: LiAccountState[]): Promise<void> {
  try {
    const [{ getPolicy }, { capacityFactor }, store, { categoryCounts, policyDay }] = await Promise.all([
      import("./os/policy"), import("./os/health"), import("./os/store"), import("./os/ledger"),
    ]);
    const all = await store.ledger.all();
    const states = await store.accounts.all();
    for (const a of accounts) {
      const policy = await getPolicy(workspaceId, a.accountId);
      const acctState = states.find((x) => x.workspaceId === workspaceId && x.accountId === a.accountId) ?? null;
      const factor = capacityFactor(acctState);
      const day = policyDay(policy.timezone);
      const c = categoryCounts(all, a.accountId, "interactions", day);
      const v = categoryCounts(all, a.accountId, "profile_views", day);
      engineRoom.set(seatLogKey(workspaceId, a.accountId), {
        day,
        target: Math.floor(policy.categories.interactions.dailyTarget * factor),
        ceiling: policy.categories.interactions.hardCeiling,
        committed: c.used + c.reserved,
        views: {
          target: Math.floor(policy.categories.profile_views.dailyTarget * factor),
          ceiling: policy.categories.profile_views.hardCeiling,
          committed: v.used + v.reserved,
        },
      });
    }
  } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: engine capacity read failed (${e instanceof Error ? e.message : e})`);
  }
}

/** Per-seat send-log key. The bare workspace key stays the all-seats log. */
function seatLogKey(workspaceId: string, accountId: string): string {
  return `${workspaceId}::${accountId}`;
}

/** How many comment drafts are queued against each seat right now. */
function pendingCommentsBySeat(workspaceId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of state.items) {
    if (i.workspaceId !== workspaceId || i.commentStatus !== "suggested" || !i.accountId) continue;
    out[i.accountId] = (out[i.accountId] ?? 0) + 1;
  }
  return out;
}

/** What a seat could still post today after what it has already sent and what
 *  is already waiting on it. */
function seatRoomToday(workspaceId: string, accountId: string, day: string, pendingBySeat?: Record<string, number>): number {
  return dayAllowanceFor(workspaceId, day, accountId)
    - commentUsage(workspaceId, accountId).today
    - (pendingBySeat?.[accountId] ?? 0);
}

/**
 * The same room as a SHARE of the seat's own allowance, which is what work
 * should actually be dealt on. Allowances are jittered per seat per day, so
 * comparing raw room hands everything to whoever drew the biggest number that
 * morning: a seat on 16 outbids a seat on 13 four times over before they tie,
 * and the seat on 13 sits idle meanwhile. Shares put every seat on the same
 * scale, so all five start moving in the same tick.
 */
function seatShareLeft(workspaceId: string, accountId: string, day: string, pendingBySeat?: Record<string, number>): number {
  const allowance = dayAllowanceFor(workspaceId, day, accountId);
  if (allowance <= 0) return -1;
  return seatRoomToday(workspaceId, accountId, day, pendingBySeat) / allowance;
}

/**
 * Which seat a newly captured lead is assigned to. A flat round robin was
 * fair only if every seat had been connected the whole time: Lume adopted
 * three seats mid-day on 2026-08-20 and the rota kept handing work to the two
 * long-seeded ones, which is how the desk finished the day 16/5/0/0/0. The
 * pick is now the seat with the most unmet allowance left today (sends
 * already made AND drafts already queued both count against it), starting the
 * sweep at the rota so equal seats still take turns.
 */
/**
 * Which seat spends the profile view.
 *
 * Separate from pickSendSeat on purpose. The send rota advances only when a
 * DRAFT is created, and 83% of candidates are rejected after the read - so the
 * send rota barely moved inside a tick and one account absorbed the whole
 * burst. This one advances on every read and skips any seat that is out of
 * profile-view room under the engine's policy. Returns null when NO seat has
 * room left, which ends the scan rather than borrowing against tomorrow.
 */
function pickReadSeat(workspaceId: string, accounts: LiAccountState[], readRota: number): LiAccountState | null {
  for (let n = 0; n < accounts.length; n++) {
    const a = accounts[(readRota + n) % accounts.length];
    if (seatMayRead(workspaceId, a.accountId)) return a;
  }
  return null;
}

function pickSendSeat(
  workspaceId: string,
  accounts: LiAccountState[],
  day: string,
  pendingBySeat: Record<string, number>,
  rota: number,
): LiAccountState {
  if (accounts.length <= 1) return accounts[0];
  let best = accounts[rota % accounts.length];
  let bestRoom = -Infinity;
  for (let n = 0; n < accounts.length; n++) {
    const a = accounts[(rota + n) % accounts.length];
    const room = seatShareLeft(workspaceId, a.accountId, day, pendingBySeat);
    if (room > bestRoom) { bestRoom = room; best = a; }
  }
  return best;
}

/**
 * Move waiting comment drafts onto the seats that can still post today.
 *
 * A draft is written for a POST, not for a recruiter: nothing in the text
 * belongs to the seat that happened to scout it, so a backlog stranded on one
 * capped seat while four others sit idle is pure waste. Run every scan, before
 * autopilot picks: it is deterministic, it never touches anything already
 * posted, and it stops as soon as no seat has room left.
 */
function rebalanceCommentQueue(workspaceId: string, accounts: LiAccountState[]): number {
  if (accounts.length <= 1) return 0;
  const day = nowIso().slice(0, 10);
  const room: Record<string, number> = {};
  const allowance: Record<string, number> = {};
  for (const a of accounts) {
    allowance[a.accountId] = Math.max(1, dayAllowanceFor(workspaceId, day, a.accountId));
    room[a.accountId] = seatRoomToday(workspaceId, a.accountId, day);
  }
  const pending = state.items.filter(
    (i) => i.workspaceId === workspaceId && i.commentStatus === "suggested" && !wallForItem(i),
  );
  let moved = 0;
  for (const item of pending) {
    let best = "";
    let bestShare = -Infinity;
    // Dealt by SHARE of each seat's own allowance, not by raw room: see
    // seatShareLeft. Raw room gave every draft to whichever seat drew the
    // biggest jittered allowance that day and left the rest waiting.
    for (const a of accounts) {
      const share = room[a.accountId] / allowance[a.accountId];
      if (share > bestShare) { bestShare = share; best = a.accountId; }
    }
    if (!best || room[best] <= 0) break;
    if (item.accountId !== best) { item.accountId = best; item.updatedAt = nowIso(); moved++; }
    room[best] -= 1;
  }
  if (moved) save();
  return moved;
}

/** Minutes left in the current UTC day, which is the day the allowance and
 *  the send log are both counted in. */
function minutesLeftInDay(): number {
  const now = Date.now();
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, (end - now) / 60_000);
}

/**
 * The randomized spacing owed after the comment logged at `lastIso`.
 *
 * PACED since 2026-08-20: pass how many sends the seat still owes today and
 * the window narrows to what actually fits. On pace, nothing changes and the
 * full 24-95 spread stands. Behind pace, the ceiling drops to the even spacing
 * that would still land the day, and once even THAT is under the ordinary
 * floor the range compresses to the catch-up band. Without the argument the
 * old unpaced spread comes back (kept for the desk-wide display fallback).
 */
function gapMinutesFor(workspaceId: string, lastIso: string, remaining?: number): number {
  const r = (seedHash(`${workspaceId}:${lastIso}:gap`) % 1000) / 1000;
  let lo = COMMENT_MIN_GAP_MIN;
  let hi = COMMENT_MAX_GAP_MIN;
  if (remaining !== undefined && remaining > 0) {
    const even = minutesLeftInDay() / remaining;
    if (even < hi) {
      hi = Math.max(lo + 5, Math.round(even));
      if (even < lo) {
        lo = COMMENT_CATCHUP_GAP_MIN;
        hi = Math.max(COMMENT_CATCHUP_GAP_MIN + 6, Math.round(even));
      }
    }
  }
  return Math.round(lo + r * (hi - lo));
}

/** Comments this seat has RESERVED with the engine and that have not been
 *  confirmed out yet. They are real commitments against LinkedIn - the engine
 *  will post them - so every wall has to see them, even though none of them
 *  may be counted as posted. */
function inflightReservations(workspaceId: string, accountId?: string): string[] {
  const out: string[] = [];
  for (const i of state.items) {
    if (i.workspaceId !== workspaceId) continue;
    if (i.commentStatus !== "approved" || i.responseStatus !== "pending") continue;
    if (accountId && i.accountId !== accountId) continue;
    const at = i.commentReservedAt ?? i.updatedAt;
    if (at) out.push(at);
  }
  return out.sort();
}

/**
 * Day count, rolling-week count, and the most recent commitment. With an
 * accountId the counts are that seat's own; without, the whole desk's.
 *
 * `today`/`week` count CONFIRMED sends plus RESERVATIONS still in flight.
 * Both halves are needed and they are needed for different reasons: counting
 * only confirmed sends lets the lane re-approve into a queue it has already
 * filled (which is how one seat ended 8/21 with 22 comments refused against
 * the engine's own ceiling), and counting reservations as sends is the lie
 * this whole change exists to stop. `sent` is the honest number for display.
 */
function commentUsage(workspaceId: string, accountId?: string): { today: number; week: number; sent: number; queued: number; last?: string } {
  const log = state.commentLog[accountId ? seatLogKey(workspaceId, accountId) : workspaceId] ?? [];
  const day = nowIso().slice(0, 10);
  const weekCutoff = Date.now() - 7 * 86_400_000;
  let today = 0;
  let week = 0;
  for (const iso of log) {
    if (iso.slice(0, 10) === day) today++;
    if (new Date(iso).getTime() >= weekCutoff) week++;
  }
  const sent = today;
  let queued = 0;
  const inflight = inflightReservations(workspaceId, accountId);
  for (const iso of inflight) {
    if (iso.slice(0, 10) === day) { today++; queued++; }
    if (new Date(iso).getTime() >= weekCutoff) week++;
  }
  const lastLog = log.length ? log[log.length - 1] : undefined;
  const lastRes = inflight.length ? inflight[inflight.length - 1] : undefined;
  const last = [lastLog, lastRes].filter(Boolean).sort().pop();
  return { today, week, sent, queued, last };
}

/**
 * The gate every public comment passes, autopilot and hand-approved alike.
 * Three walls in order of hardness: the rolling week, the jittered day, then
 * the randomized spacing. The engine's own `interactions` cap sits above all
 * of this and can still refuse after we say yes.
 */
export function commentThrottleFor(workspaceId: string, accountId?: string): CommentThrottle {
  const limits = commentLimitsFor(workspaceId);
  const day = nowIso().slice(0, 10);
  const use = commentUsage(workspaceId, accountId);
  // The seat's own jittered allowance, then CLAMPED to what the engine will
  // actually accept today. Asking for more than the engine's target does not
  // produce more comments, it produces refusals - and, before this, a card
  // that counted the refusals as posted.
  const room = accountId ? engineRoom.get(seatLogKey(workspaceId, accountId)) : undefined;
  const own = dayAllowanceFor(workspaceId, day, accountId);
  const allowance = room ? Math.min(own, Math.max(0, room.target)) : own;
  const t: CommentThrottle = {
    enabled: limits.enabled,
    autoPost: limits.autoPost,
    perDay: limits.perDay,
    perWeek: limits.perWeek,
    todayAllowance: allowance,
    todayUsed: use.today,
    todaySent: use.sent,
    todayQueued: use.queued,
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
  if (room && room.committed >= room.ceiling) {
    t.blockedReason = `LinkedIn engine hard ceiling reached for this seat (${room.committed} of ${room.ceiling} interactions today).`;
    return t;
  }
  if (room && room.committed >= room.target) {
    t.blockedReason = `LinkedIn engine daily target reached for this seat (${room.committed} of ${room.target} interactions today).`;
    return t;
  }
  if (use.today >= allowance) {
    t.blockedReason = use.queued
      ? `Today's comment allowance is committed (${use.sent} posted, ${use.queued} waiting in the engine, of ${allowance}).`
      : `Today's comment allowance is used (${use.today} of ${allowance}).`;
    return t;
  }
  if (use.last) {
    const gap = gapMinutesFor(
      accountId ? seatLogKey(workspaceId, accountId) : workspaceId,
      use.last,
      Math.max(0, allowance - use.today),
    );
    const readyAt = new Date(use.last).getTime() + gap * 60_000;
    if (Date.now() < readyAt) {
      t.nextSlotAt = new Date(readyAt).toISOString();
      t.blockedReason = `Spacing: the next comment is due in about ${Math.max(1, Math.round((readyAt - Date.now()) / 60_000))} minutes.`;
      return t;
    }
  }
  return t;
}

/**
 * The near-duplicate window, written at RESERVATION time.
 *
 * Text and delivery are counted at different moments on purpose. A draft is
 * spoken for the instant the engine takes it, so the next draft must already
 * be checked against it - otherwise two seats write the same observation while
 * the first one sits in the engine's queue, and both go out an hour apart.
 */
function noteCommentText(workspaceId: string, text: string): void {
  const recent = state.commentRecent[workspaceId] ?? (state.commentRecent[workspaceId] = []);
  recent.push(text);
  if (recent.length > COMMENT_DUP_WINDOW) state.commentRecent[workspaceId] = recent.slice(-COMMENT_DUP_WINDOW);
  save();
}

/**
 * Log a comment the engine CONFIRMED it posted. This is the only thing that
 * counts as a comment, anywhere: the day and week walls, the card's numbers,
 * the daily stats.
 *
 * It used to fire the moment `requestLinkedInAction` returned accepted - and
 * accepted means RESERVED, not sent. The engine reserves a slot, schedules it
 * inside the seat's working-hours window, and posts it later; three of Lume's
 * five seats spent 2026-08-21 with a full "posted" count on the card and
 * nothing whatsoever on LinkedIn. Verified against the posts themselves:
 * every ledger `success` was there, every `scheduled` was not. Numbers that
 * report intent as achievement are worse than no numbers.
 */
function recordComment(workspaceId: string, accountId?: string): void {
  const log = state.commentLog[workspaceId] ?? (state.commentLog[workspaceId] = []);
  log.push(nowIso());
  if (accountId) {
    const seatLog = state.commentLog[seatLogKey(workspaceId, accountId)] ?? (state.commentLog[seatLogKey(workspaceId, accountId)] = []);
    seatLog.push(nowIso());
  }
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
  /** Stage reserved-but-unsent comments: approved with the engine, awaiting
   *  its confirmation. The whole point of the 2026-08-21 accounting split. */
  setReservations: (workspaceId: string, accountId: string, at: string[]): void => {
    state.items = state.items.filter((i) => i.workspaceId !== workspaceId);
    for (const iso of at) {
      state.items.push({
        id: rid("licw"), workspaceId, kind: "poster", postId: "0", postExcerpt: "",
        commentId: "", commentText: "", openProfile: false, accountId,
        authorProviderId: "", authorName: "", decisionMaker: true, peer: false,
        tier: "hot", replyStatus: "none", commentStatus: "approved",
        responseStatus: "pending", commentReservedAt: iso,
        createdAt: iso, updatedAt: iso,
      } as CommentLeadItem);
    }
  },
  setEngineRoom: (workspaceId: string, accountId: string, room: { target: number; ceiling: number; committed: number; views?: { target: number; ceiling: number; committed: number } } | null): void => {
    const k = seatLogKey(workspaceId, accountId);
    if (room) engineRoom.set(k, { day: nowIso().slice(0, 10), ...room });
    else engineRoom.delete(k);
  },
  /** The voice guards (2026-08-21): the machine tells, and what counts as a
   *  closing invitation now that the drafts are meant to sound spoken. */
  robotTellReason,
  hasClosingInvite,
  /** The indexed pre-read screen and the read rota (2026-08-21). */
  preReadVeto,
  pickReadSeat,
  seatMayRead,
  noteProfileView,
  resetViews: (): void => { seatViews.clear(); },
};

/** Count a confirmed comment against its seat's day and week, exactly once
 *  however many ticks re-read the same ledger row. */
function countCommentOnce(workspaceId: string, item: CommentLeadItem): void {
  if (item.commentCountedAt) return;
  item.commentCountedAt = nowIso();
  recordComment(workspaceId, item.accountId);
}

/**
 * The tells that give a machine away, enforced where a prompt cannot be
 * trusted to hold. Every one of these was measured in what actually went out:
 * "we keep seeing" opened nine of the last ten comments, and the hedging stack
 * turned every observation into the same diplomatic non-claim. A draft that
 * trips this is dropped, exactly like a pitch leak.
 */
const ROBOT_TELLS: Array<[RegExp, string]> = [
  [/\bwe keep seeing\b/i, 'the "we keep seeing" tic'],
  [/\bwe (?:stopped|watch|tend|see)\b/i, "the institutional we"],
  [/\btends? to\b/i, 'hedged with "tends to"'],
  [/\bin my experience\b/i, '"in my experience"'],
  [/\bit(?:'s| is) worth noting\b/i, '"it is worth noting"'],
  [/\bcandid read\b/i, 'the "candid read" formula'],
  [/\bjust say the word\b/i, 'the "just say the word" formula'],
  [/\bmy inbox is open\b/i, 'the "my inbox is open" formula'],
  [/\bhappy to compare notes\b/i, 'the "happy to compare notes" formula'],
];

/** Which tell a draft trips, or null. */
function robotTellReason(text: string): string | null {
  for (const [re, why] of ROBOT_TELLS) if (re.test(text)) return why;
  // A comment of any length with no contraction at all is written, not spoken.
  if (text.length > 140 && !/\w'(?:s|t|re|ll|ve|d|m)\b/i.test(text)) return "no contractions: reads written, not spoken";
  return null;
}

/** Everything a new draft must not read like: comments already posted, plus
 *  the ones still waiting for approval. */
function priorComments(workspaceId: string): string[] {
  const sent = state.commentRecent[workspaceId] ?? [];
  const queued = state.items
    .filter((i) => i.workspaceId === workspaceId && i.commentStatus === "suggested" && i.commentDraft)
    .map((i) => i.commentDraft as string);
  return sent.concat(queued);
}

/** Does the draft end on an actual invitation to engage? The owner rule
 *  (2026-08-19) is that every public comment closes with a low-pressure
 *  offer of help; the epoch-2 rewrite showed the model quietly dropping it
 *  when pushed hard on variety (13 of 18 drafts shipped observation-only),
 *  so presence is enforced with a check and one corrective retry, not by
 *  the prompt alone. Heuristic on the final stretch of the text. */
/**
 * What counts as a closing invitation.
 *
 * WIDENED 2026-08-21, and it had to be widened in the same change that made
 * the drafts sound spoken, not after. Every phrasing the new rules ask for -
 * "Want me to map it?", "Want a couple of names?", "Curious what you're
 * seeing" - failed this regex, and a draft that fails it gets one retry and is
 * then DROPPED. Shipping the new voice against the old gate would have killed
 * most of the queue, which is exactly what happened in the epoch-3 rewrite
 * (3 of 18 survived). A written offer and a spoken one are both invitations.
 */
const INVITE_RE = /\b(happy to|glad to|worth (comparing|trading|a chat|a conversation|swapping)|if (you|it) (want|ever|need|would|'d)|just (ask|say the word|reach)|inbox is open|my inbox|door is open|open to (comparing|trading|sharing|swapping)|second (set of eyes|perspective|opinion)|compare notes|trade notes|swap notes|can share what we|happy either way|want me to|want the |want a |want an |want to (hear|know|see)|curious (what|how|which|whether|if)|let me know|(i )?can send|i'?ll send|shall i|should i send|if (that|it) helps|if useful|if that'?s useful|say the word|give me a shout|drop me a)\b/i;
function hasClosingInvite(text: string): boolean {
  return INVITE_RE.test(text.slice(-240));
}

/** Prompt-side variety steering. The dup guard rejects near-duplicates after
 *  the fact, but it cannot stop every draft closing on the same invitation
 *  ("Happy to compare notes...", seen 5 of 6 in the epoch-1 rewrite), because
 *  the observation carries the word-set while the closing formula repeats
 *  freely. Showing the model the most recent comments, plus every closing
 *  wording already in use, kills the formula at the source, and the brief
 *  restates that the invitation itself is NOT optional: epoch 2 proved that
 *  "close differently" alone reads to the model as permission to not close
 *  at all. */
function varietyBrief(workspaceId: string, excluding?: string): string {
  const priors = priorComments(workspaceId).filter((t) => t !== excluding);
  const recent = priors.slice(-4);
  if (!recent.length) return "";
  const closings = [...new Set(priors
    .map((t) => t.trim().split(/(?<=[.?!])\s+/).pop() ?? "")
    .filter((s) => s.length >= 15 && INVITE_RE.test(s)))].slice(-8);
  return `\n\nRECENT COMMENTS THIS ACCOUNT ALREADY LEFT. Yours must open differently and be shaped differently, and it still ENDS with its own short, low-pressure invitation to engage (that rule always stands), worded unlike any of these:\n${recent.map((t) => `- ${t}`).join("\n")}`
    + (closings.length ? `\n\nCLOSING INVITATIONS ALREADY USED (write a fresh one, never reuse these wordings):\n${closings.map((s) => `- ${s}`).join("\n")}` : "");
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
    // "--" is the model dodging the long-dash ban with ASCII; same rule applies.
    .replace(/\s+--+\s+/g, ", ")
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
const POST_COMMENT_RULES = `You write PUBLIC comments that one recruiter leaves on a stranger's LinkedIn post. Everyone can see it: the poster, their team, their network, and every competing recruiter watching. It has to read like a person who does this work typed it on their phone between calls.

Your goal: one hiring decision-maker reads it and thinks "this person actually knows my market", then has one easy way to reply.

VOICE - this is most of the job:
- Write as "I", not "we". One person with an opinion, not a firm with a position.
- Use contractions. "don't", "won't", "they're", "here's", "that's". Always.
- SHORT SENTENCES. Most under fifteen words. Fragments are fine. A three-word sentence is fine.
- Say the thing straight. No hedging stack: not "tends to", not "usually", not "often", not "generally", not "in my experience", not "it is worth noting".
- Never open two comments the same way. Never use a phrase you would use as a formula.
- Lead with the sharpest thing you know, not with a wind-up.

SUBSTANCE:
- Say ONE specific, non-obvious, falsifiable thing about THEIR situation: where that talent actually sits, which adjacent title converts and which never does, what kills this search at the offer, what the market reads into how they scoped it.
- Specific beats hedged. "Plant Controllers won't move to Medford" beats "candidates in this market tend to show relocation reluctance". Name the place, the title, the adjacent industry, the actual objection.
- Never restate their post. Never compliment it. Never give generic hiring advice.
- NEVER invent a number. No comp bands, no time-to-fill, no percentages, unless their post stated one, in which case you may react to it.
- Never name your firm, your clients, your candidates, your bench, or a placement.

SHAPE - pick the one that fits, and do not settle into a single pattern:
  (a) the flat call: say what will happen, then offer to help.
  (b) the correction: they framed it one way, the market reads it another.
  (c) the question: ask the one thing an operator who runs these weekly would ask.
  (d) the two-profiles: this role pulls two kinds of people and they look identical on paper.

CLOSE: one short invitation, and it must sound spoken. "Want me to tell you who's actually movable?" "Happy to send you two names." "Want the honest read on that market?" Never the same wording twice. Never beg, never sell: no fees, no availability, no links, no calendar, no "before someone else does".

LENGTH: 15 to 45 words. One to three sentences. Shorter is better. If you can say it in one sentence and a question, do that.

NEVER: emoji, hashtags, exclamation marks, long dashes, all-caps, "insightful", "resonate", "leverage", "delve", "align", "synergies", "reach out", "we keep seeing", "great post", "love this", "so true", "spot on", "couldn't agree more", "thanks for sharing".

If the post offers nothing to genuinely engage with (a holiday greeting, a bare celebration, an announcement with no substance), return exactly SKIP. Never write about these rules. Never mention AI.
Return ONLY the comment text, nothing else.`;

// NOTE deliberately absent: there is no FOLLOWUP_RULES prompt. When a poster
// replies to our comment, the owner reads their words and writes the answer
// themselves (owner ask 2026-08-19); the machine never drafts that reply.

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
  summary?: string; currentRoles?: string[]; openToWork?: boolean; work?: WorkEntry[];
}> {
  try {
    const { unipileRequest } = await import("./provider");
    // `linkedin_sections=*` IS LOAD-BEARING, do not drop it.
    //
    // Without it the response carries no work_experience, no education and no
    // summary at all (verified against the live API 2026-08-21: 26 keys without
    // the parameter, 42 with it). The deep-verification block below has been
    // reading `p.work_experience` since it was written and has therefore ALWAYS
    // produced an empty array, which quietly made deepRecruiterSignals() a no-op
    // and left us with no way to tell whether a poster still had a job.
    // It is the same single request, so it costs the same one profile view.
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${providerIdOf(account)}&linkedin_sections=*`);
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
      // LinkedIn's own "I am looking for work" badge, returned by the SAME call
      // that gives us the headline. Dropping it here is what let us pitch
      // candidates to a Finance Director who was job-hunting (2026-08-21).
      openToWork: typeof p.is_open_to_work === "boolean" ? p.is_open_to_work : undefined,
      networkDistance: str(p.network_distance),
      location: str(p.location),
      summary: str(p.summary) ?? str(p.about),
      currentRoles,
      // The structured history, kept alongside the display strings: the dates
      // are what decide whether somebody currently holds a job, and a joined
      // "Position at Company" string throws them away.
      work: rawExp.map((e) => ({
        company: str(e.company) ?? str(e.company_name),
        position: str(e.position) ?? str(e.title),
        start: str(e.start) ?? str(e.start_date),
        end: str(e.end) ?? str(e.end_date),
        status: str(e.status),
      })),
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
      console.log(`[comment-radar] ${workspaceId}: copy epoch ${COMMENT_COPY_EPOCH}: rewritten=${r.redrafted} kept=${r.kept} skipped=${r.skipped}`);
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: epoch redraft error (${e instanceof Error ? e.message : e})`);
    }
  }

  // Owner mandate 2026-08-19 ("approve these automatically and send them
  // yourself"): comment auto-posting switches ON for the workspaces named in
  // RECRUITEROS_COMMENT_AUTOPOST_WS (comma-separated ids; env-carried so no
  // tenant id lives in code). One-shot by stamp, not by setting: an owner who
  // later flips the switch off in the UI stays off. Everything downstream is
  // unchanged - the engine's caps, the recruiter wall, the US gate, and the
  // day/week/spacing throttle still gate every autopilot post.
  const mandateWs = (process.env.RECRUITEROS_COMMENT_AUTOPOST_WS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (mandateWs.includes(workspaceId) && !state.autopostMandate[workspaceId]) {
    state.autopostMandate[workspaceId] = true;
    await setCommentLimits(workspaceId, { autoPost: true });
    console.log(`[comment-radar] ${workspaceId}: comment auto-posting enabled (owner mandate via env)`);
  }

  // Owner mandate 2026-08-20: hold the lane at 12-15 posted comments a day.
  // RECRUITEROS_COMMENT_LIMITS_MANDATE carries comma-separated
  // "wsId:perDay:perWeek" directives. One-shot per directive VALUE: the stamp
  // remembers exactly what was applied, so the same directive never fights a
  // later UI edit, while a changed directive applies once on its next scan.
  for (const m of (process.env.RECRUITEROS_COMMENT_LIMITS_MANDATE ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [ws, dayStr, weekStr] = m.split(":");
    if (ws !== workspaceId || state.limitsMandate[workspaceId] === m) continue;
    const perDay = Number(dayStr);
    const perWeek = Number(weekStr);
    if (!Number.isFinite(perDay) || !Number.isFinite(perWeek)) continue;
    state.limitsMandate[workspaceId] = m;
    await setCommentLimits(workspaceId, { perDay, perWeek });
    console.log(`[comment-radar] ${workspaceId}: comment limits set to ${perDay}/day base, ${perWeek}/week (owner mandate via env)`);
  }

  // Owner mandate 2026-08-20: hunt the WHOLE market, not three scenarios.
  // ROLE_HUNTER_SCENARIOS_MANDATE carries "wsId:id1|id2|id3" directives. Same
  // one-shot-by-stamp contract as the limits mandate above: it applies once,
  // a later UI edit wins, and a changed directive applies once again. It is
  // the supply side of the 14-16-a-day-per-seat ask: three scenarios over a
  // seven-title bank made 21 search combos, few enough that a day's searches
  // walked the whole rotation five times and read the same links each pass.
  for (const m of (process.env.ROLE_HUNTER_SCENARIOS_MANDATE ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const at = m.indexOf(":");
    if (at < 0) continue;
    const ws = m.slice(0, at);
    if (ws !== workspaceId || state.scenarioMandate[workspaceId] === m) continue;
    const ids = m.slice(at + 1).split("|").map((x) => x.trim()).filter(Boolean);
    if (!ids.length) continue;
    state.scenarioMandate[workspaceId] = m;
    try {
      const cur = scenariosFor(workspaceId);
      await setScenarios(workspaceId, [...new Set([...cur.presets, ...ids])], cur.custom);
      console.log(`[comment-radar] ${workspaceId}: scenarios set to ${ids.join(", ")} (owner mandate via env)`);
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: scenario mandate failed (${e instanceof Error ? e.message : e})`);
    }
  }

  // The engine's profile_views policy is the authority for how many profiles a
  // seat may read in a day, exactly as its interactions policy is the authority
  // for comments. ROLE_HUNTER_PROFILE_VIEWS_MANDATE carries
  // "wsId:dailyTarget:hardCeiling:weeklyTarget", one-shot by directive value.
  for (const m of (process.env.ROLE_HUNTER_PROFILE_VIEWS_MANDATE ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [ws, dayStr, ceilStr, weekStr] = m.split(":");
    if (ws !== workspaceId || state.profileViewsMandate[workspaceId] === m) continue;
    const dailyTarget = Number(dayStr);
    const hardCeiling = Number(ceilStr);
    const weeklyTarget = Number(weekStr);
    if (![dailyTarget, hardCeiling, weeklyTarget].every(Number.isFinite)) continue;
    state.profileViewsMandate[workspaceId] = m;
    save();
    try {
      const { putPolicy } = await import("./os/policy");
      for (const a of accounts) {
        await putPolicy(workspaceId, a.accountId, {
          categories: { profile_views: { dailyTarget, hardCeiling, weeklyTarget } },
        } as Parameters<typeof putPolicy>[2]);
      }
      console.log(`[comment-radar] ${workspaceId}: engine profile-view capacity set to ${dailyTarget}/day (ceiling ${hardCeiling}, ${weeklyTarget}/week) on ${accounts.length} seat(s)`);
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: profile-view mandate failed (${e instanceof Error ? e.message : e})`);
    }
  }

  // ONE-SHOT REPAIR, and it must run before any wall is measured today.
  //
  // Until now every send log entry was written when the engine RESERVED the
  // comment, so the log holds entries for comments that never went out. Left
  // alone, the new accounting would count those twice - once as a (false)
  // confirmed send and once as the reservation it still is - and jam the lane
  // shut. Rebuild both logs from the only evidence that means anything: items
  // the engine has confirmed posted. Reservations still in flight drop out of
  // the log entirely and are counted as in-flight, which is what they are.
  if (!state.sendLogTruthBuilt[workspaceId]) {
    state.sendLogTruthBuilt[workspaceId] = true;
    const cutoff = Date.now() - COMMENT_LOG_KEEP_DAYS * 86_400_000;
    const rebuilt: Record<string, string[]> = {};
    const desk: string[] = [];
    let confirmed = 0;
    for (const i of state.items) {
      if (i.workspaceId !== workspaceId || i.kind !== "poster" || i.commentStatus !== "approved") continue;
      // "posted" is the engine's confirmation. Anything still pending is a
      // reservation, and anything failed never happened at all.
      if (i.responseStatus !== "posted" && i.responseStatus !== "responded" && i.responseStatus !== "no_response") continue;
      const at = i.commentPostedAt ?? i.commentReservedAt ?? i.updatedAt;
      if (!at || new Date(at).getTime() < cutoff) continue;
      i.commentCountedAt = i.commentCountedAt ?? at;
      desk.push(at);
      if (i.accountId) (rebuilt[seatLogKey(workspaceId, i.accountId)] ??= []).push(at);
      confirmed++;
    }
    for (const k of Object.keys(state.commentLog)) {
      if (k === workspaceId || k.startsWith(`${workspaceId}::`)) delete state.commentLog[k];
    }
    state.commentLog[workspaceId] = desk.sort();
    for (const [k, arr] of Object.entries(rebuilt)) state.commentLog[k] = arr.sort();
    // dayStats.comments is the same claim in another place; make it agree.
    const today = nowIso().slice(0, 10);
    const st = huntStatsFor(workspaceId);
    st.comments = desk.filter((t) => t.slice(0, 10) === today).length;
    save();
    console.log(`[comment-radar] ${workspaceId}: send log rebuilt from CONFIRMED posts only (${confirmed} kept across ${Object.keys(rebuilt).length} seats; reservations no longer counted as sends)`);
  }

  // Owner mandate: the engine's OWN interaction capacity has to be able to
  // carry the number the desk was asked for. ROLE_HUNTER_INTERACTIONS_MANDATE
  // carries "wsId:dailyTarget:hardCeiling:weeklyTarget" and applies it to every
  // connected seat's policy, one-shot by directive value, exactly like the
  // limits mandate. This is not a second throttle - it is the ONLY one; the
  // lane's own allowance is clamped to it (see refreshEngineRoom). Before this,
  // the lane asked for 14-16 a day against an engine target of 10 and the
  // difference came back as refusals that the card counted as posted.
  for (const m of (process.env.ROLE_HUNTER_INTERACTIONS_MANDATE ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [ws, dayStr, ceilStr, weekStr] = m.split(":");
    if (ws !== workspaceId || state.interactionsMandate[workspaceId] === m) continue;
    const dailyTarget = Number(dayStr);
    const hardCeiling = Number(ceilStr);
    const weeklyTarget = Number(weekStr);
    if (![dailyTarget, hardCeiling, weeklyTarget].every(Number.isFinite)) continue;
    state.interactionsMandate[workspaceId] = m;
    save();
    try {
      const { putPolicy } = await import("./os/policy");
      for (const a of accounts) {
        await putPolicy(workspaceId, a.accountId, {
          categories: { interactions: { dailyTarget, hardCeiling, weeklyTarget } },
        } as Parameters<typeof putPolicy>[2]);
      }
      console.log(`[comment-radar] ${workspaceId}: engine interaction capacity set to ${dailyTarget}/day (ceiling ${hardCeiling}, ${weeklyTarget}/week) on ${accounts.length} seat(s)`);
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: interactions mandate failed (${e instanceof Error ? e.message : e})`);
    }
  }

  // One-shot 2026-08-20, the day the throttle went per-seat: rebuild each
  // seat's send log from the posted items that still remember which seat
  // posted them, so a seat that already sent today starts from its true
  // count instead of zero (and cannot run a fresh full allowance on top of
  // what its profile actually did). The desk-wide log stays untouched.
  if (!state.seatLogBuilt[workspaceId]) {
    state.seatLogBuilt[workspaceId] = true;
    const cutoff = Date.now() - COMMENT_LOG_KEEP_DAYS * 86_400_000;
    const rebuilt: Record<string, string[]> = {};
    for (const i of state.items) {
      if (i.workspaceId !== workspaceId || i.kind !== "poster" || i.commentStatus !== "approved" || !i.accountId) continue;
      const at = i.commentPostedAt ?? i.updatedAt;
      if (!at || new Date(at).getTime() < cutoff) continue;
      (rebuilt[seatLogKey(workspaceId, i.accountId)] ??= []).push(at);
    }
    for (const [k, arr] of Object.entries(rebuilt)) state.commentLog[k] = arr.sort();
    save();
    console.log(`[comment-radar] ${workspaceId}: per-seat send logs rebuilt (${Object.keys(rebuilt).length} seats)`);
  }

  // Seat adoption (owner mandate 2026-08-20: every recruiter runs the lane).
  // A recruiter who connected their LinkedIn for JD Sourcing has a healthy
  // provider login in the SEAT store, but the hunt reads the ENGINE's account
  // store, and until now only the video-watch bridge ever registered engine
  // accounts. Every scan, any workspace seat not yet bound to an engine
  // account is live-verified against the provider (seat.status alone can be
  // weeks stale) and adopted onto the conservative policy: connect once
  // anywhere, hunt everywhere, no re-login and no configuration. A signed-out
  // or unreachable seat is skipped with a log line; the recruiter fixes it
  // through the JD Sourcing card's own reconnect flow.
  try {
    const engineAccounts = await listAccounts(workspaceId);
    const bound = new Set(engineAccounts.flatMap((a) => [a.accountId, a.providerAccountId].filter(Boolean) as string[]));
    for (const seat of await seatsForWorkspace(workspaceId)) {
      if (!seat.accountId || bound.has(seat.accountId)) continue;
      const who = seat.label || seat.userId;

      // Three outcomes, never two. "Signed out" and "we could not ask" are
      // different facts and the seat's stored status is what the recruiter's
      // own JD Sourcing card reads back: a stale "ok" makes that card claim
      // "Your LinkedIn is connected" for a login that is actually dead (seen
      // live 2026-08-20 on a seat last probed three weeks earlier), while
      // flipping a seat to "reconnect" over a network blip is a false alarm
      // that sends a recruiter to re-login for nothing. So only a DEFINITIVE
      // verdict is written back; an unreachable provider leaves the seat
      // exactly as it was and simply skips adoption this tick.
      let verdict: "healthy" | "relogin" | "unknown" = "unknown";
      let detail = "";
      try {
        const acct = await unipileRequest<{ sources?: Array<{ status?: string }> }>(`/accounts/${encodeURIComponent(seat.accountId)}`);
        const bad = (acct.sources ?? [])
          .map((s) => String(s.status ?? ""))
          .filter((s) => /CREDENTIALS|DISCONNECTED|ERROR|STOPPED/i.test(s));
        if (bad.length) { verdict = "relogin"; detail = `provider reports ${bad.join(", ")}`; }
        else { verdict = "healthy"; }
      } catch (e) {
        // 404: the provider account no longer exists, which IS a definitive
        // re-login verdict. Anything else (5xx, auth, DNS, timeout) is us
        // failing to ask, and must never be reported as their fault.
        const status = e instanceof UnipileError ? e.status : 0;
        if (status === 404) { verdict = "relogin"; detail = "the provider has no such account (the login was removed)"; }
        else { detail = e instanceof Error ? e.message : String(e); }
      }

      if (verdict === "relogin") {
        // Write the truth onto the seat so the recruiter's own card shows
        // "Your LinkedIn needs a re-login" and its Reconnect button, instead
        // of a cached "connected" that hides the problem forever.
        try { await markSeatChecked(workspaceId, seat.userId, "reconnect"); } catch { /* log line still stands */ }
        console.log(`[comment-radar] ${workspaceId}: seat "${who}" needs a re-login, card updated (${detail})`);
        continue;
      }
      if (verdict === "unknown") {
        console.log(`[comment-radar] ${workspaceId}: seat "${who}" not checked this tick, provider unreachable (${detail}); seat left untouched`);
        continue;
      }
      const member = listMembers(workspaceId).find((mm) => mm.userId === seat.userId);
      const osAccountId = `seat_${seat.userId}`;
      await ensureAccount(workspaceId, osAccountId, {
        providerAccountId: seat.accountId,
        displayName: member?.name || seat.label || osAccountId,
        ownerUserId: seat.userId,
        connected: true,
        timezone: "America/New_York",
      });
      try {
        await putPolicy(workspaceId, osAccountId, { applyPreset: "conservative", timezone: "America/New_York" });
      } catch { /* policy stays at the engine default if this races */ }
      bound.add(seat.accountId);
      // The probe just verified this login live: stamp the seat so its card
      // reads a FRESH ok rather than a months-old one, and so the next
      // portal visit does not re-probe needlessly.
      try { await markSeatChecked(workspaceId, seat.userId, "ok"); } catch { /* adoption still stands */ }
      console.log(`[comment-radar] ${workspaceId}: adopted seat "${member?.name || who}" into the hunt`);
    }
  } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: seat adoption error (${e instanceof Error ? e.message : e})`);
  }

  const scanned = 0;
  const created = 0;
  let dmCreated = 0;
  try { dmCreated = await scanPosters(workspaceId, accounts, adhoc); } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: market scan error (${e instanceof Error ? e.message : e})`);
  }

  // The engine's capacity, read fresh, BEFORE the rebalance and before
  // autopilot approves anything. Every wall below is measured against it.
  await refreshEngineRoom(workspaceId, accounts);

  // Every scan, before autopilot picks: move waiting comment drafts onto the
  // seats that can still post today. Drafts are written for a post, not for a
  // recruiter, so a backlog stranded on one capped seat is pure waste - and
  // that is exactly what left three of Lume's five seats on zero the day they
  // were adopted (owner mandate 2026-08-20).
  try {
    const moved = rebalanceCommentQueue(workspaceId, accounts);
    if (moved) console.log(`[comment-radar] ${workspaceId}: ${moved} waiting comment draft(s) moved onto seats with allowance left`);
  } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: queue rebalance error (${e instanceof Error ? e.message : e})`);
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

  // Step 0: replies nobody was told about. Firing the reflex is a one-time
  // edge at detection, so a reply seen while the alert did not yet exist (or
  // while it was failing) would sit answered-by-nobody forever. This sweep is
  // the only path that can reach those, and it runs BEFORE the early returns
  // below for exactly that reason. A few per tick, so a backlog arrives as a
  // trickle rather than a burst of texts; the stamps inside the reflex keep
  // it once-ever per thread.
  const unalerted = state.items.filter((i) =>
    i.workspaceId === workspaceId && i.kind === "poster"
    && i.responseStatus === "responded" && !i.replyAlertAt);
  if (unalerted.length) {
    const { posterReplyReflex } = await import("./replyReflex");
    for (const item of unalerted.slice(0, REPLY_REFLEX_CATCHUP_PER_TICK)) {
      try {
        await posterReplyReflex(workspaceId, item, accounts);
        save();
      } catch (e) {
        console.log(`[comment-radar] ${workspaceId}: reply reflex failed for ${item.authorName} (${e instanceof Error ? e.message : e})`);
      }
    }
  }

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
        countCommentOnce(workspaceId, item);
        continue;
      }
      item.commentActionId = rec.id;
      if (rec.status === "success" || rec.status === "submitted") {
        item.responseStatus = "posted";
        item.commentPostedAt = nowIso();
        item.commentProviderId = rec.providerReference;
        item.updatedAt = nowIso();
        // THE moment a comment becomes a comment: the engine says it went out.
        countCommentOnce(workspaceId, item);
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
      // Deliberately NO drafting here (owner ask 2026-08-19): a poster
      // writing back is a live conversation, and the owner wants to read
      // their exact words and answer in their own. The tracker shows the
      // reply with an empty compose box; nothing is written for them.
      console.log(`[comment-radar] ${workspaceId}: ${item.authorName} replied to our comment on their post`);
      // The two things that must happen without anyone watching the card
      // (owner ask 2026-08-20): tell the recruiter whose seat drew the reply,
      // and ask to connect from that same seat while the thread is live.
      // Both are once-ever and neither can throw into the scan.
      const { posterReplyReflex } = await import("./replyReflex");
      await posterReplyReflex(workspaceId, item, accounts);
      save();
    } catch (e) {
      console.log(`[comment-radar] ${workspaceId}: thread check failed for ${item.authorName} (${e instanceof Error ? e.message : e})`);
    }
  }

  return found;
}

/** Post the owner's OWN reply as a threaded response to THEIR comment on
 *  THEIR post. Nothing is machine-written on this path (owner ask
 *  2026-08-19): the text is whatever the owner typed in the tracker. A live
 *  conversation is not a cold touch, so it spends none of the cold-comment
 *  allowance; engine account caps still apply. */
export async function approveFollowUp(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.responseStatus !== "responded" || item.followUpStatus === "approved" || !item.responseCommentId) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  if (!editedText || scrub(editedText).length < 2) {
    return { item, accepted: false, reason: "Write your reply first; nothing is drafted for you on this one." };
  }
  item.followUpText = scrub(editedText).slice(0, MAX_COMMENT_CHARS);
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
  if (!item || item.responseStatus !== "responded" || item.followUpStatus === "approved") return null;
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
      // The phrase builder above is explicitly hiring-side ("people posting about roles they need
      // to fill"), so this lane may comment. It is still gated on the post TEXT showing hiring
      // intent at draft time, which is what catches a phrase that drifted off target.
      commentEligible: true,
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
  dmBank: "mpc" | "growth" | "peer";
  /** Carried from the preset: may the PUBLIC COMMENT lane act on this post?
   *  Only actively-hiring scenarios may (owner decision 2026-08-21). */
  commentEligible?: boolean;
}

/**
 * The function groups this desk actually recruits, derived from its own role keyword bank.
 *
 * Role relevance is worth 10 points in the intent score, and it has to be per-workspace: a funding
 * round that implies operations hiring is a strong signal for an ops desk and a weak one for a
 * finance desk. Deriving it from the keyword bank rather than a setting means it stays correct
 * when the desk changes what it recruits, with nothing to keep in sync.
 *
 * The vocabulary matches tools/orgchart.mjs on purpose, so an implied function can be handed
 * straight to the org chart to work out which seat to contact.
 */
const DESK_FUNCTION_PATTERNS: Array<[string, RegExp]> = [
  ["Finance", /\b(account|accounting|controller|cpa|finance|financial|tax|audit|fp&a|treasury|payroll|bookkeep)/i],
  ["Sales", /\b(sales|account executive|business development|revenue|\bbdr\b|\bsdr\b)/i],
  ["Marketing", /\b(marketing|demand gen|brand|content|seo|communications)/i],
  ["Engineering", /\b(engineer|developer|software|devops|data|platform|security|\bit\b|technology)/i],
  ["Product", /\bproduct\b/i],
  ["Operations", /\b(operations|supply chain|logistics|manufactur|production|plant|warehouse|procurement)/i],
  ["People / HR", /\b(human resources|\bhr\b|people|talent|recruit)/i],
  ["Legal", /\b(legal|counsel|compliance|paralegal)/i],
  ["Customer Success", /\b(customer success|client services|customer experience|implementation)/i],
  ["Clinical", /\b(nurse|nursing|clinical|physician|therapist|medical|patient)/i],
];

function deskFunctionsFor(workspaceId: string): string[] {
  const bank = marketKeywordsFor(workspaceId).join(" ");
  const out = DESK_FUNCTION_PATTERNS.filter(([, re]) => re.test(bank)).map(([f]) => f);
  // A desk with an unreadable bank should not lose the role-relevance signal entirely; finance is
  // this deployment's default desk and is the honest fallback rather than scoring every post zero.
  return out.length ? out : ["Finance"];
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
          hiringIntent: p.hiringIntent, dmBank: p.dmBank, commentEligible: p.commentEligible,
        });
      });
    } else {
      out.push({
        key: p.label, id: p.id,
        serperQ: `site:linkedin.com/posts ${p.orGroup.startsWith("(") ? p.orGroup : `(${p.orGroup})`}`,
        unipileQ: p.orGroup.replace(/["()]|\bOR\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
        hiringIntent: p.hiringIntent, dmBank: p.dmBank, commentEligible: p.commentEligible,
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

/** "3 days ago" / "2 weeks ago" / "Aug 5, 2026" -> an ISO stamp the post-age
 *  gate can actually compare. Anything unrecognised comes back undefined,
 *  which keeps the old behaviour for that result: unknown age, not blocked. */
function isoFromIndexDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const rel = /(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "minute" ? 60_000
      : unit === "hour" ? 3_600_000
      : unit === "day" ? 86_400_000
      : unit === "week" ? 7 * 86_400_000
      : unit === "month" ? 30 * 86_400_000
      : 365 * 86_400_000;
    return new Date(Date.now() - n * ms).toISOString();
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Fallback engine: Google's index of linkedin.com/posts via Serper (the
 *  live Unipile seat's LinkedIn content search returns zero items in every
 *  form - verified 2026-08-12 - while its people search works). Post URLs
 *  carry the author slug and the activity id; profile enrichment and the
 *  send still go through Unipile. */
async function candidatesFromSerper(query: string, page = 1): Promise<{ items: MarketCandidate[]; error?: string }> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { items: [], error: "Serper key not configured on the server." };
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      // gl/hl pin the index to the US edition (owner mandate 2026-08-15):
      // cheaper than discovering a Manchester poster after a paid profile
      // read. DataForSEO already does this with location_code 2840.
      // `page` walks DEEPER into the same query the next time this combo comes
      // round, instead of re-reading the first twenty links into the `seen`
      // gate (2026-08-20).
      body: JSON.stringify({
        q: query, num: MARKET_RESULTS_PER_SEARCH, tbs: MARKET_TIME_WINDOW, gl: "us", hl: "en",
        ...(page > 1 ? { page } : {}),
      }),
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
        // Google answers "3 days ago", never an ISO stamp, so the post-age
        // gate downstream was silently inert on every Serper result: a
        // `new Date("3 days ago")` is NaN and NaN passes a `> maxAge` test.
        // Parsed here, which is what lets the index window widen safely.
        postAt: isoFromIndexDate(r.date),
        authorRef: slugM[1],
        authorName: name || undefined,
      });
    }
    return { items: out };
  } catch (e) { return { items: [], error: `Serper unreachable (${e instanceof Error ? e.message : e})` }; }
}

/**
 * INDEXED-FIRST, APPLIED TO THE PERSON (2026-08-21).
 *
 * Discovery went indexed-first in August: Google finds the post, and the
 * connected seat never runs a LinkedIn search. Screening never followed. So
 * the lane was spending a real profile view - the scarcest thing it touches,
 * on a recruiter's own account - to discover that someone is a recruiter, or
 * that their profile does not resolve at all. Measured over 205 searches: 83%
 * of profile reads ended in a rejection.
 *
 * The same slug we already parsed out of the post URL resolves in Google's
 * index for one credit. Verified live: the result title is "Name - Headline",
 * which is enough to run the peer wall, and an absent result is itself the
 * answer (company page, dead slug, nothing to comment on).
 *
 * It VETOES ONLY ON POSITIVE EVIDENCE. A thin snippet, a missing headline, an
 * unrecognised title: all fall through to the real read. A screen that guesses
 * would cost good leads to save cheap credits, which is the wrong trade.
 */
async function indexedProfileHint(
  workspaceId: string,
  slug: string,
): Promise<{ found: boolean; headline?: string; snippet?: string }> {
  const bank = state.profileHints[workspaceId] ?? (state.profileHints[workspaceId] = {});
  const hit = bank[slug];
  if (hit && Date.now() - new Date(hit.at).getTime() < PROFILE_HINT_TTL_DAYS * 86_400_000) {
    return { found: hit.found, headline: hit.headline, snippet: hit.snippet };
  }
  const key = process.env.SERPER_API_KEY;
  // No key is not a veto: fall through to the read exactly as before.
  if (!key) return { found: true };
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `site:linkedin.com/in/${slug}`, num: 10, gl: "us", hl: "en" }),
    });
    if (!res.ok) return { found: true };
    const data = await res.json() as { organic?: Array<{ link?: string; title?: string; snippet?: string }> };
    const row = (data.organic ?? []).find((r) =>
      new RegExp(`linkedin\\.com/in/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\?|#|$)`, "i").test(r.link ?? ""));
    // Titles read "Name - Headline" or "Name - Title | Company".
    const title = (row?.title ?? "").replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
    const dash = title.indexOf(" - ");
    const headline = dash >= 0 ? title.slice(dash + 3).trim() : undefined;
    const out = { found: !!row, headline: headline || undefined, snippet: row?.snippet };
    bank[slug] = { at: nowIso(), ...out };
    save();
    return out;
  } catch {
    // An engine wobble must never turn into a veto.
    return { found: true };
  }
}

/** What the indexed hint alone is enough to rule out, before a profile view is
 *  spent. High precision only: absence of evidence is never a veto. */
function preReadVeto(hint: { found: boolean; headline?: string; snippet?: string }): string | null {
  if (!hint.found) return "no indexed profile for this slug";
  const blob = [hint.headline, hint.snippet].filter(Boolean).join(" ");
  if (!blob) return null;
  const { title, company } = parseHeadline(hint.headline ?? "");
  const wall = recruiterWall({ title, headline: blob, company });
  if (wall) return wall;
  return null;
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
        postAt: isoFromIndexDate(r.timestamp),
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

  const roles = marketKeywordsFor(workspaceId);
  const stats = huntStatsFor(workspaceId);
  const scanDay = nowIso().slice(0, 10);
  // Public-comment lane: on/off, and how deep its approval queue may get.
  // The cap scales with the connected seats: five recruiters each burning
  // their own daily allowance need five seats' worth of drafts queued.
  const commentLane = commentLimitsFor(workspaceId).enabled;
  const commentQueueCap = COMMENT_QUEUE_MULTIPLE * Math.max(
    dayAllowanceFor(workspaceId, scanDay),
    accounts.reduce((sum, a) => sum + dayAllowanceFor(workspaceId, scanDay, a.accountId), 0),
  );
  let pendingComments = state.items.filter(
    (i) => i.workspaceId === workspaceId && i.commentStatus === "suggested",
  ).length;
  const pendingBySeat = pendingCommentsBySeat(workspaceId);
  /** Drafts the desk still owes itself today: every seat's unmet allowance,
   *  less what is already queued. Positive means the comment lane is the
   *  scarce one and reachable posters should feed it rather than the DM bank. */
  const commentShortfall = (): number =>
    accounts.reduce((sum, a) => sum + Math.max(0, seatRoomToday(workspaceId, a.accountId, scanDay)), 0)
    - pendingComments;
  let totalCreated = 0;
  let readsThisScan = 0;
  // Advances on every READ, unlike `rota`, which advances only when a draft is
  // created. That difference is what let one seat absorb a whole burst.
  let readRota = state.keywordCursor[`${workspaceId}:readrota`] ?? 0;

  /**
   * One (scenario x role) combo: ask the index, screen what comes back, draft
   * for whoever survives. Several of these run per tick (see
   * MARKET_SEARCHES_PER_TICK); `page` walks deeper into the same query each
   * time the combo comes round again.
   */
  const runCombo = async (combo: ScanCombo, page: number): Promise<number> => {
  const keyword = combo.key;

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
  const r = await candidatesFromSerper(combo.serperQ, page);
  candidates = r.items;
  let engineError = r.error;
  // A deep page that has run off the end of the index is not an outage: come
  // back to page one for this combo rather than burning the tick on nothing.
  if (!candidates.length && page > 1) {
    state.keywordCursor[`${workspaceId}:pg:${combo.key}`] = 0;
    const r1 = await candidatesFromSerper(combo.serperQ, 1);
    candidates = r1.items;
    if (candidates.length) engineError = undefined; else engineError = engineError ?? r1.error;
  }
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
  const g = { nopost: 0, seen: 0, intent: 0, weekly: 0, profile: 0, title: 0, dnc: 0, closed: 0, peer: 0, jobSeeker: 0, offMarket: 0, foreignPost: 0, commentFull: 0, commentDraft: 0, commentDupe: 0, commentLeak: 0, commentNotHiring: 0, commentLowIntent: 0, preIndexed: 0, viewCap: 0 };
  // Headcount feeds the company-fit term of the intent score. Loaded ONCE per scan, not per
  // candidate: loadSizeMap is memoised but the lookup runs on every screened post, and a scan
  // reads hundreds. An unresolved company simply scores zero fit rather than being guessed at.
  let sizeMap: Record<string, { count?: number }> = {};
  try { const { loadSizeMap } = await import("../inmarket/companySize"); sizeMap = (await loadSizeMap()) as Record<string, { count?: number }>; } catch { /* sizes unknown */ }
  const headcountFor = (co?: string) => {
    const e = co ? sizeMap[String(co).toLowerCase().trim()] : undefined;
    return e && typeof e.count === "number" && e.count > 0 ? e.count : null;
  };
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

    // THE CHEAP HALF OF THE SCREEN, first. Google's index answers "is this a
    // real person, and are they a recruiter" for a tenth of a cent and no
    // LinkedIn action at all. Only what survives is worth a profile view.
    const hint = await indexedProfileHint(workspaceId, c.authorRef);
    const vetoed = preReadVeto(hint);
    if (vetoed) {
      // Same never-again treatment the post-read walls give: a peer is still a
      // peer next week, and a slug with no profile behind it never gains one.
      closedCache[c.authorRef] = `wall:${nowIso()}`;
      save();
      if (hint.found) { g.peer++; stats.peersBlocked += 1; } else { g.preIndexed++; }
      stats.readsSaved += 1;
      continue;
    }

    // Profile read on the seat that will send. Company pages fail here,
    // which is the point.
    //
    // The tick's read budget is checked HERE, at the only line that spends
    // one: out of budget ends the scan outright rather than paying for more
    // searches whose results nothing is left to screen.
    if (readsThisScan >= POSTER_READS_PER_SCAN) break;
    // The seat that SPENDS the view, on its own rota, skipping any seat out of
    // profile-view room under the engine's policy. Nobody has room = stop.
    const readAccount = pickReadSeat(workspaceId, accounts, readRota);
    if (!readAccount) { g.viewCap++; break; }
    readRota++;
    // Never two views in the same instant: the burst is the tell, not the count.
    if (readsThisScan > 0 && READ_GAP_MAX_MS > 0) {
      const gap = READ_GAP_MIN_MS + Math.floor(seedHash(`${c.authorRef}:gap`) % Math.max(1, READ_GAP_MAX_MS - READ_GAP_MIN_MS + 1));
      await new Promise((r) => setTimeout(r, gap));
    }
    readsThisScan++;
    noteProfileView(workspaceId, readAccount.accountId);
    const sendAccount = pickSendSeat(workspaceId, accounts, scanDay, pendingBySeat, rota);
    stats.profileReads += 1;
    const prof = await fetchProfileLite(readAccount, c.authorRef);
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
    const reachable = prof.openProfile === true || firstDegree;
    // COMMENT-FIRST (owner mandate 2026-08-20: 14-16 posted comments per seat
    // per day). A reachable poster still takes the private DM whenever the
    // desk has its comment drafts covered; when it does not, they take the
    // comment lane instead. The DM bank is deterministic templates over an
    // unlimited supply of open profiles, so it is never what runs out - the
    // drafted comments the five seats spend all day posting are.
    // Every OTHER one, on the lead rota: the MPC DM lane is worth money too
    // and must not fall to zero merely because the comment queue is hungry.
    const direct = reachable && !(COMMENT_FIRST && commentLane && rota % 2 === 0 && commentShortfall() > 0);
    if (!direct) {
      if (!reachable) stats.closedFound += 1;
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

    // THEY ARE LOOKING FOR WORK THEMSELVES.
    //
    // A director-level title says someone COULD authorize a search; it says
    // nothing about whether they currently have a team or a budget. Someone
    // between roles has neither, and offering them candidates reads exactly as
    // badly as it sounds - "I am not hiring but I am looking for work" was the
    // real reply that put this check here (2026-08-21).
    //
    // Deliberately a plain closed-profile entry, NOT a "wall:" never-again one:
    // people get hired, and the cache expires after CLOSED_PROFILE_DAYS, so the
    // same person is reconsidered in a month like any other cooled lead.
    // Two independent reads of the same question, either one sufficient.
    //
    // (a) HAVE THEY SAID they are looking - the opt-in badge and the phrases
    //     people put in a headline.
    // (b) DOES THE RECORD SHOW them employed - owner ask 2026-08-21: check the
    //     current employment against the company we are about to write about,
    //     rather than trusting a headline.
    //
    // (b) is the stronger of the two and catches people who never touch the
    //     badge. On the profile that prompted it, every one of eleven roles
    //     carried an end date and the most recent had finished six weeks
    //     earlier, while the headline still read "Finance Director".
    const employment = employmentVerdict({
      work: prof.work,
      claimedCompany: company ?? undefined,
    });
    const notBuyer = jobSeekerReason({
      openToWorkFlag: prof.openToWork,
      headline: headline ?? undefined,
      summary: prof.summary,
    }) ?? notABuyerReason(employment);
    if (notBuyer) {
      markClosed(prof.providerId);
      g.jobSeeker++;
      console.log(`[comment-radar] ${workspaceId}: skipped ${prof.publicUrl ?? c.authorRef} - ${notBuyer}`);
      continue;
    }

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
      // HIRING POSTS ONLY (owner decision 2026-08-21). This lane used to comment on three kinds of
      // post - an advertised opening, company news (a raise, a second location, a team doubling),
      // and industry conversation - each with its own brief to stop the model inventing a job that
      // was never mentioned. The desk now comments EXCLUSIVELY where someone is actively hiring one
      // of our roles.
      //
      // Two reasons this is the right cut rather than a narrowing for its own sake. The comment is
      // PUBLIC and, since auto-posting is on, goes out without anyone reading it first, so the only
      // safe ground is a post where we have something concrete and provable to say. And the whole
      // value of the lane is that the comment lands on the hiring post itself, reaching an author
      // whose profile may not take a message - which is worth nothing on a post with no role in it.
      //
      // The other scenarios are untouched in DISCOVERY and in the DM lane: a funding round is still
      // a real hiring signal, just not one to comment publicly under. Gated on BOTH the scenario
      // and the post text, so a growth post that slipped into a hiring scenario is still refused.
      // PREDICTIVE HIRING INTENT (owner model 2026-08-21). The gate is no longer "is this a hiring
      // post". By the time someone writes "we're hiring a VP of Finance" every recruiter can see
      // it. What we want is the organisational EVENT that creates the demand, 2 to 12 weeks before
      // the requisition exists: a raise, a sponsor, an acquisition, a new site, a major contract, a
      // new executive, an ERP programme, or the quiet ones ("wearing too many hats", "time to
      // professionalise the org") that almost nobody reads for.
      //
      // The score is what makes widening the net safe. An earlier version of this lane commented on
      // any growth post, which is how the trail filled with congratulations; the version before this
      // one over-corrected to hiring posts only. Scoring lets us take the funding announcement and
      // still refuse "congratulations on another strong quarter", which carries growth language and
      // no catalyst whatsoever. See lib/linkedin/hiringIntent.ts for the weights.
      const intent = readIntent({
        text: c.text,
        authorTitle: title ?? headline,
        headcount: headcountFor(company),
        deskFunctions: deskFunctionsFor(workspaceId),
        postAt: c.postAt,
      });

      // Record EVERY scored post against its company, including ones we will not comment on. The
      // track band exists precisely so a company that is not yet worth a public comment still
      // accumulates heat, and the third weak signal in a fortnight is what puts an account at the
      // top of the list before anyone else has noticed it.
      if (intent.primary && company) {
        if (!state.intentLedger[workspaceId]) state.intentLedger[workspaceId] = {};
        recordSignal(state.intentLedger[workspaceId], {
          company, domain: undefined, read: intent,
          postUrl: c.postUrl, postAt: c.postAt,
          authorName, authorTitle: title ?? headline, excerpt: c.text.slice(0, 240),
        });
      }

      // Comment only from the engage band up. Below it the company is watched, not spoken to.
      if (intent.score < THRESHOLDS.engage) { g.commentLowIntent++; continue; }
      const author = [authorName, title, company ? `at ${company}` : undefined].filter(Boolean).join(", ");
      const brief = commentBrief(intent, jobTitle, city);
      const userMsg = `THEIR POST (by ${author}):\n${c.text.slice(0, 900)}\n\n${brief} Write the comment.${varietyBrief(workspaceId)}`;
      const drafted = await draft(POST_COMMENT_RULES, userMsg);
      if (!drafted || /^\s*SKIP\b/i.test(drafted)) { g.commentDraft++; continue; }
      let candidate = fitComment(scrub(drafted));
      // The closing invitation is the point of the lane (owner 2026-08-19);
      // a draft without one gets one corrective pass, then the lead is
      // dropped rather than queued observation-only.
      if (candidate && !hasClosingInvite(candidate)) {
        const retry = await draft(POST_COMMENT_RULES,
          `${userMsg}\n\nYour previous attempt:\n${candidate}\n\nIt is missing the closing invitation. Keep the observation, and END with one short, low-pressure invitation to engage.`);
        candidate = retry && !/^\s*SKIP\b/i.test(retry) ? fitComment(scrub(retry)) : null;
        if (candidate && !hasClosingInvite(candidate)) candidate = null;
      }
      if (!candidate) { g.commentDraft++; continue; }
      const leak = pitchLeakReason(candidate, c.text) ?? robotTellReason(candidate);
      if (leak) { g.commentLeak++; console.log(`[comment-radar] draft dropped, ${leak}: ${candidate}`); continue; }
      // Compared against what was already posted AND what is still sitting in
      // the approval queue: a single tick drafting eight comments that rhyme
      // with each other is the same tell as posting eight that do.
      if (tooSimilar(candidate, priorComments(workspaceId))) { g.commentDupe++; continue; }
      commentDraft = candidate;
      pendingComments++;
      pendingBySeat[sendAccount.accountId] = (pendingBySeat[sendAccount.accountId] ?? 0) + 1;
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

  save();
  console.log(`[comment-radar] market "${keyword}" p${page} via ${source}: results=${candidates.length} created=${created} reads=${readsThisScan}/${POSTER_READS_PER_SCAN} gates=${JSON.stringify(g)}`);
  return created;
  };

  // The rotation itself: MARKET_SEARCHES_PER_TICK combos per tick, each one
  // picking up where the cursor left off, with a per-combo page cursor so a
  // repeat visit reads new links. An ad-hoc combo (AI Search) runs once and
  // leaves both cursors alone.
  const passes = adhoc ? 1 : MARKET_SEARCHES_PER_TICK;
  for (let pass = 0; pass < passes; pass++) {
    if (totalCreated >= POSTER_NEW_PER_SCAN) break;
    if (readsThisScan >= POSTER_READS_PER_SCAN) break;
    // A full approval queue does not need more searches paid for on top of it.
    if (pass > 0 && pendingComments >= commentQueueCap) break;
    let combo: ScanCombo;
    let page = 1;
    if (adhoc) {
      combo = adhoc;
    } else {
      const combos = scanCombos(workspaceId);
      const idx = (state.keywordCursor[workspaceId] ?? 0) % combos.length;
      state.keywordCursor[workspaceId] = idx + 1;
      combo = combos[idx];
      const pageKey = `${workspaceId}:pg:${combo.key}`;
      const seenTimes = state.keywordCursor[pageKey] ?? 0;
      page = (seenTimes % MARKET_PAGE_DEPTH) + 1;
      state.keywordCursor[pageKey] = seenTimes + 1;
    }
    save();
    try {
      totalCreated += await runCombo(combo, page);
    } catch (e) {
      console.log(`[comment-radar] market "${combo.key}" failed (${e instanceof Error ? e.message : e})`);
    }
  }

  state.keywordCursor[`${workspaceId}:rota`] = rota % 1_000_000;
  state.keywordCursor[`${workspaceId}:readrota`] = readRota % 1_000_000;
  if (seenArr.length > SEEN_CAP) state.seen[workspaceId] = seenArr.slice(-SEEN_CAP);
  save();
  return totalCreated;
}

/* ------------------------------------------------------------------ */
/* Reads + actions                                                      */
/* ------------------------------------------------------------------ */

export interface CommentWatchView {
  status: CommentWatchStatus;
  /** Predictive account watchlist: employers whose public activity says a hire is coming,
   *  ranked by accumulated heat. See lib/linkedin/intentLedger.ts. */
  intentAccounts: RankedAccount[];
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
    /** Approved and reserved with the engine, not yet posted to LinkedIn. */
    queuedInEngine: number;
    /** Poster replies still waiting for the owner's own answer. */
    followUpsOpen: number;
  };
  /** accountId -> the recruiter that seat belongs to. An admin watching five
   *  seats needs to know whose voice a thread is in before answering it, and
   *  the answer posts from the commenting seat whoever clicks the button. */
  seatNames: Record<string, string>;
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
  const awaitingAnswer = (i: CommentLeadItem): boolean =>
    i.responseStatus === "responded" && i.followUpStatus !== "approved" && i.followUpStatus !== "skipped";
  const trackRank = (i: CommentLeadItem): number =>
    awaitingAnswer(i) ? 0
    : i.responseStatus === "responded" ? 1
    : i.responseStatus === "pending" || i.responseStatus === "posted" ? 2
    : i.responseStatus === "failed" ? 3 : 4;
  const tracked = state.items
    .filter((i) => i.workspaceId === workspaceId && i.kind === "poster" && i.commentStatus === "approved")
    .sort((a, b) => trackRank(a) - trackRank(b)
      || (b.commentPostedAt ?? b.updatedAt).localeCompare(a.commentPostedAt ?? a.updatedAt));
  // The card's throttle: per-seat since 2026-08-20 (owner mandate: every
  // recruiter runs the lane on their own walls). The panel shows the DESK's
  // day - the sum of every connected seat's jittered allowance and usage -
  // while perDay/perWeek stay the per-seat configuration the inputs edit.
  // Blocked only when EVERY seat is walled; the next slot is the earliest
  // any seat frees up.
  const seatAccounts = await connectedAccounts(workspaceId);
  await refreshEngineRoom(workspaceId, seatAccounts);
  const seatThrottles = seatAccounts.map((a) => commentThrottleFor(workspaceId, a.accountId));
  const baseThrottle = commentThrottleFor(workspaceId);
  const allSeatsBlocked = seatThrottles.length > 0 && seatThrottles.every((t) => t.blockedReason);
  const commentThrottle: CommentThrottle = seatThrottles.length
    ? {
        enabled: baseThrottle.enabled,
        autoPost: baseThrottle.autoPost,
        perDay: baseThrottle.perDay,
        perWeek: baseThrottle.perWeek,
        todayAllowance: seatThrottles.reduce((s, t) => s + t.todayAllowance, 0),
        todayUsed: seatThrottles.reduce((s, t) => s + t.todayUsed, 0),
        todaySent: seatThrottles.reduce((s, t) => s + t.todaySent, 0),
        todayQueued: seatThrottles.reduce((s, t) => s + t.todayQueued, 0),
        weekUsed: seatThrottles.reduce((s, t) => s + t.weekUsed, 0),
        nextSlotAt: allSeatsBlocked
          ? seatThrottles.map((t) => t.nextSlotAt).filter((s): s is string => !!s).sort()[0]
          : undefined,
        blockedReason: allSeatsBlocked ? seatThrottles.find((t) => t.blockedReason)?.blockedReason : undefined,
        seats: seatThrottles.length,
      }
    : baseThrottle;
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
    commentThrottle,
    // PREDICTIVE ACCOUNT WATCHLIST. Companies whose public activity says they are about to hire,
    // ranked by accumulated heat rather than by whoever posted most recently. The timeline on
    // each row is the reason it is there, which is what makes the list workable instead of just
    // being another score. Pruned on read so a stale ledger cannot inflate it.
    intentAccounts: rankAccounts(pruneLedger(state.intentLedger[workspaceId] ?? {}), Date.now(), 40),
    tracked,
    trackedTally: {
      postedTotal: (state.commentLog[workspaceId] ?? []).length,
      posted7d: (state.commentLog[workspaceId] ?? [])
        .filter((t) => Date.now() - new Date(t).getTime() < 7 * 86_400_000).length,
      responded: tracked.filter((i) => i.responseStatus === "responded").length,
      watching: tracked.filter((i) => i.responseStatus === "pending" || i.responseStatus === "posted").length,
      // Approved and reserved with the engine, not yet out on LinkedIn.
      queuedInEngine: tracked.filter((i) => i.responseStatus === "pending").length,
      noResponse: tracked.filter((i) => i.responseStatus === "no_response").length,
      followUpsOpen: tracked.filter(awaitingAnswer).length,
    },
    seatNames: await seatNamesFor(workspaceId, seatAccounts),
  };
}

/** accountId -> recruiter name, for the seat label on every tracked thread.
 *  Engine accounts registered before seats carried an owner have only a
 *  provider id for a display name, so those fall back to the seat store the
 *  same way the reply alert does. */
async function seatNamesFor(workspaceId: string, accounts: LiAccountState[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let members: ReturnType<typeof listMembers> = [];
  let seats: Awaited<ReturnType<typeof seatsForWorkspace>> = [];
  try { members = listMembers(workspaceId); } catch { /* names degrade below */ }
  try { seats = await seatsForWorkspace(workspaceId); } catch { /* legacy accounts keep their display name */ }
  for (const a of accounts) {
    const provider = a.providerAccountId || a.accountId;
    const userId = a.ownerUserId || seats.find((s) => s.accountId === provider)?.userId;
    const name = userId ? members.find((m) => m.userId === userId)?.name : undefined;
    // Never label a seat with a raw provider id: an unnamed seat says so.
    out[a.accountId] = name || (a.displayName && a.displayName !== a.accountId ? a.displayName : "Unassigned seat");
  }
  return out;
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

/** Model output that is ABOUT the task instead of being the comment: the
 *  epoch-2 rewrite queued "This post is a Independence Day greeting with no
 *  substantive professional content... at the level these rules require" as
 *  if it were a draft. Text like this must never wait for approval. */
const META_DRAFT_RE = /\b(these rules|this post (?:is|offers|contains|has)|no substantive|nothing (?:here )?to (?:react|engage|comment)|as an? (?:ai|assistant)|cannot (?:meaningfully )?(?:comment|engage))\b/i;

const INVITE_ONLY_RULES = `You write ONE closing sentence to append to an existing public LinkedIn comment left by a recruiting agency owner. The sentence is a short, low-pressure invitation to engage if the poster wants help, and it must read like the same person wrote it.
Rules:
- 8 to 16 words. One sentence. No emoji, no exclamation marks, no long dashes, no links, no contact details, no numbers.
- An offer they can take or leave, never a demand: no "DM me", no calendar, no fees, never name a firm.
- On a hiring post the invitation offers help with that search. Otherwise it offers to trade notes on the problem they wrote about, never mentioning hiring or candidates.
- Its wording must not match any invitation in the banned list, and it must not begin with the same two words as any of them.
- Never mention AI.
Return ONLY the sentence, nothing else.`;

/**
 * Rewrite every OPEN public-comment draft under the current copy rules.
 *
 * Exists for rule changes (owner ask 2026-08-19: drafts now close with an
 * invitation to engage): drafting happens once at capture, so a queue built
 * under the old rules would otherwise sit there reading exactly like the
 * copy the owner just rejected. Only "suggested" items are touched; anything
 * approved, skipped, or blocked keeps its history.
 *
 * Shape (learned across epochs 1-3): full rewrites of a whole queue lose to
 * their own guards and churn good text, so the pass is surgical. A draft
 * that already closes with an invitation is only scrub-normalized. A sound
 * observation missing the invitation gets ONE generated closing sentence
 * appended, validated by the same belt. Meta/refusal text gets one full
 * rewrite attempt and otherwise leaves the queue as skipped, because broken
 * text must never sit one tap from public.
 */
export async function redraftOpenComments(workspaceId: string): Promise<{ redrafted: number; kept: number; skipped: number }> {
  await hydrate();
  const open = state.items.filter((i) =>
    i.workspaceId === workspaceId && i.kind === "poster" && i.commentStatus === "suggested" && i.commentDraft);
  let redrafted = 0, kept = 0, skipped = 0;

  const bannedClosings = (): string => {
    const closings = [...new Set(priorComments(workspaceId)
      .map((t) => t.trim().split(/(?<=[.?!])\s+/).pop() ?? "")
      .filter((s) => s.length >= 15 && INVITE_RE.test(s)))].slice(-10);
    return closings.length ? `\n\nBANNED INVITATIONS (already in use):\n${closings.map((s) => `- ${s}`).join("\n")}` : "";
  };

  for (const item of open) {
    const post = item.postExcerpt ?? "";
    const hiring = HIRING_INTENT_RE.test(post);
    const cur = scrub(item.commentDraft ?? "");

    // Broken text: one full-rewrite attempt under the current rules; if the
    // model cannot produce a clean comment (or answers SKIP), the item leaves
    // the queue rather than holding text that must never post.
    // Epoch 5 (2026-08-21): a draft carrying a machine tell is rewritten under
    // the new rules or dropped, on the same path broken text takes. Everything
    // else is left alone - epoch 4 learned that whole-queue rewrites lose more
    // than they fix, so this touches only what the new guard would refuse.
    if (META_DRAFT_RE.test(cur) || robotTellReason(cur)) {
      const author = [item.authorName, item.title, item.company ? `at ${item.company}` : undefined].filter(Boolean).join(", ");
      const role = item.matchedRole ?? "candidate";
      const city = cityFromPost(post) ?? cityFromLocation(item.posterLocation);
      const brief = hiring
        ? `The role they are hiring for is ${role}${city ? ` in ${city}` : ""}.`
        : `They are not advertising a job here, so do NOT mention hiring, recruiting, candidates, or a search. React to the substance of what they wrote as a peer would, and make the closing invitation a peer one: an offer to trade notes on the problem they wrote about.`;
      const drafted = await draft(POST_COMMENT_RULES,
        `THEIR POST (by ${author}):\n${post.slice(0, 900)}\n\n${brief} Write the comment.${varietyBrief(workspaceId, item.commentDraft)}`);
      const candidate = drafted && !/^\s*SKIP\b/i.test(drafted) ? fitComment(scrub(drafted)) : null;
      const priors = priorComments(workspaceId).filter((t) => t !== item.commentDraft);
      if (candidate && hasClosingInvite(candidate) && !pitchLeakReason(candidate, post)
        && !robotTellReason(candidate) && !tooSimilar(candidate, priors)) {
        item.commentDraft = candidate;
        item.updatedAt = nowIso();
        redrafted++;
      } else {
        item.commentStatus = "skipped";
        item.updatedAt = nowIso();
        skipped++;
      }
      continue;
    }

    // Sound observation, no ask: append one generated closing sentence. The
    // observation already cleared every wall once; keeping it and adding the
    // invitation cannot lose the lead the way a rejected full rewrite can.
    if (!hasClosingInvite(cur)) {
      const invite = await draft(INVITE_ONLY_RULES,
        `THEIR POST:\n${post.slice(0, 700)}\n\nTHE COMMENT SO FAR:\n${cur}\n\n${hiring ? "This reacts to a hiring post." : "This is NOT a hiring post; peer framing only."}${bannedClosings()} Write the sentence.`);
      const s = invite ? scrub(invite) : "";
      if (s && s.length <= 200 && INVITE_RE.test(s) && !pitchLeakReason(s, post)) {
        const joined = /[.?!]$/.test(cur) ? `${cur} ${s}` : `${cur}. ${s}`;
        if (joined.length <= MAX_COMMENT_CHARS) {
          item.commentDraft = joined;
          item.updatedAt = nowIso();
          redrafted++;
          continue;
        }
      }
      kept++;
      continue;
    }

    // Already closes with an invitation: normalize only (scrub folds "--").
    if (cur !== item.commentDraft) {
      item.commentDraft = cur;
      item.updatedAt = nowIso();
    }
    kept++;
  }
  if (redrafted || skipped) save();
  return { redrafted, kept, skipped };
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

  // The throttle, on the SEAT that will post (owner mandate 2026-08-20:
  // every recruiter runs their own day/week/spacing walls). Refusals do NOT
  // consume the draft: it stays in the list and can go out in the next slot.
  const throttle = commentThrottleFor(workspaceId, account.accountId);
  if (throttle.blockedReason) {
    return { item, accepted: false, reason: throttle.blockedReason };
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
      // RESERVED, not posted. `accepted` means the engine took the action and
      // scheduled it into this seat's working-hours window; it goes out later,
      // and checkCommentResponses is what counts it when the engine confirms.
      // The text joins the duplicate window now, because it is spoken for now.
      item.commentReservedAt = nowIso();
      noteCommentText(workspaceId, item.commentDraft);
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
