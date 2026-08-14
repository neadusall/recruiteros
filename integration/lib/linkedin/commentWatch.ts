/**
 * RecruitersOS · LinkedIn Market Radar ("who is posting that they're hiring?")
 *
 * OTHER PEOPLE'S posts are the market (owner decision 2026-08-12: the radar
 * never scans the owner's own posts). Every tick (15 min by default):
 *
 *   1. one keyword search across ALL of LinkedIn's posts (rotating bank:
 *      "we are hiring", "looking to hire", ... - editable per workspace),
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
}
const AUTO_PER_TICK = 10;        // autopilot approvals per tick (engine caps still apply)

/** The keyword bank is the ROLES the desk places (owner decision 2026-08-13):
 *  each entry is a job title or phrase, searched against LinkedIn posts to
 *  find hiring managers posting that opening. The matched keyword becomes
 *  {job_title} in the MPC message. Editable on the card / keywords_set. */
const DEFAULT_MARKET_KEYWORDS = [
  "BCBA", "RBT", "Clinical Director", "Speech Language Pathologist",
  "Occupational Therapist", "Nurse Practitioner", "Registered Nurse",
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
];
const DEFAULT_SCENARIOS = ["hiring_role", "urgent_backfill", "struggling_to_fill"];

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
  /** The commenter. */
  authorProviderId?: string;
  authorName: string;
  authorHeadline?: string;
  authorPublicUrl?: string;
  networkDistance?: string;
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
}

const KEY = "linkedin_comment_watch_v1";
let state: WatchState = { items: [], seen: {}, ownProfile: {}, posterSeen: {}, closedProfiles: {}, dayStats: {}, autoIndustries: {}, marketKeywords: {}, keywordCursor: {}, scenarios: {}, lastError: {}, paused: {}, autoMode: {}, lastScan: {} };

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
  const s = ws[day] ?? (ws[day] = { searches: 0, screened: 0, profileReads: 0, readsSaved: 0, closedFound: 0, hiringChecks: 0, leads: 0, peersBlocked: 0 });
  // Backfill for day rows written by older builds (avoids NaN on +=).
  if (s.peersBlocked === undefined) s.peersBlocked = 0;
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
          lastError: snap.lastError ?? {},
          paused: snap.paused ?? {},
          autoMode: snap.autoMode ?? {},
          lastScan: snap.lastScan ?? {},
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
    || i.connectStatus === "suggested" || i.connectStatus === "blocked";
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
      if (new Date(m[k]).getTime() < closedCutoff) delete m[k];
    }
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
      && (i.dmStatus === "suggested" || i.replyStatus === "suggested" || i.connectStatus === "suggested"))
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
- Never mention AI, never pitch services, never link, never suggest connecting or a call. The only goal is one more genuine exchange in the thread.
Return ONLY the reply text, nothing else.`;

const CONNECT_RULES = `You write short LinkedIn connection notes for a recruiting agency owner. The recipient just commented on one of the owner's posts; this note is the FIRST direct touch and arrives while their comment is still fresh. The reader must never suspect a machine wrote it.
Rules:
- Max 270 characters. Two sentences at most.
- Reference their comment naturally (their take under the post), not their profile or their company.
- No pitch, no links, no "synergies", no emoji, no long dashes, no mention of hiring, roles, or services. Connecting to keep talking is the whole message.
- Never mention AI.
Return ONLY the note text, nothing else.`;

const DM_RULES = `You write direct LinkedIn messages for a recruiting agency owner. The recipient is a hiring decision-maker who just published a LinkedIn post about a role they need to fill or talent they are looking for; this message goes straight to their inbox while the post is fresh. The reader must never suspect a machine wrote it.
Rules:
- Anchor the message in the SPECIFIC need from their post: the exact role, team, or hiring challenge they described, in their own framing. Never summarize their post back, never flatter.
- One low-key line that this exact kind of search is what the owner does all day; offering to send over a couple of strong profiles is allowed. No hard pitch, no links, no calendar ask, no "quick call".
- 40 to 80 words. Short paragraphs. No exclamation marks, no emoji, no hashtags, no long dashes.
- Banned openers: "Great post", "Love this", "Hope you're well", "I came across", "I saw your post". Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align", "synergies".
- End with one genuine question about the search (the bar, the sticking point, the timeline). Never mention AI.
Return ONLY the message text, nothing else.`;

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
}> {
  try {
    const { unipileRequest } = await import("./provider");
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${providerIdOf(account)}`);
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

  const scanned = 0;
  const created = 0;
  let dmCreated = 0;
  try { dmCreated = await scanPosters(workspaceId, accounts, adhoc); } catch (e) {
    console.log(`[comment-radar] ${workspaceId}: market scan error (${e instanceof Error ? e.message : e})`);
  }

  // Autopilot: when armed, the fresh drafts go straight out through the engine.
  let sent = 0;
  try { sent = await autoExecute(workspaceId); } catch { /* drafts stay open for manual review */ }

  state.lastScan[workspaceId] = nowIso();
  prune();
  save();
  console.log(`[comment-radar] ${workspaceId}: scanned=${scanned} created=${created + dmCreated} autopilot_sent=${sent}`);
  return { scanned, created: created + dmCreated, skipped: null };
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
      for (const role of roles) {
        out.push({
          key: `${p.label}: ${role}`, role,
          serperQ: `site:linkedin.com/posts "${role}" (${p.orGroup})`,
          unipileQ: `${role} hiring`,
          hiringIntent: p.hiringIntent, dmBank: p.dmBank,
        });
      }
    } else {
      out.push({
        key: p.label,
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
      body: JSON.stringify({ q: query, num: MARKET_RESULTS_PER_SEARCH, tbs: "qdr:w" }),
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

  const { unipile } = await import("../providers");
  let source = "unipile";
  let candidates: MarketCandidate[] = [];
  try {
    candidates = candidatesFromUnipile(listOf(await unipile.searchPosts(providerIdOf(account)!, combo.unipileQ, MARKET_RESULTS_PER_SEARCH)));
  } catch (e) {
    console.log(`[comment-radar] unipile post search failed for "${keyword}" (${e instanceof Error ? e.message : e})`);
  }
  if (!candidates.length) {
    source = "serper";
    const r = await candidatesFromSerper(combo.serperQ);
    candidates = r.items;
    let engineError = r.error;
    // Second failover: DataForSEO absorbs the volume when Serper is dry
    // (out of credits, seen live 2026-08-13).
    if (!candidates.length) {
      source = "dataforseo";
      const d2 = await candidatesFromDataForSeo(combo.serperQ);
      candidates = d2.items;
      if (candidates.length) engineError = undefined;
      else engineError = [engineError, d2.error].filter(Boolean).join(" | ") || undefined;
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
  }

  let created = 0;
  // Per-gate counters so a zero-yield search names the gate that ate it.
  const g = { nopost: 0, seen: 0, intent: 0, weekly: 0, profile: 0, title: 0, dnc: 0, closed: 0, peer: 0 };
  const stats = huntStatsFor(workspaceId);
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

    // One touch per author per week, whichever key we knew them by.
    const lastTouch = seenAuthors[c.authorRef];
    if (lastTouch && new Date(lastTouch).getTime() >= recheckCutoff) { g.weekly++; continue; }

    // Closed-profile memory (owner ask 2026-08-14): someone we already know
    // can't receive a DM is skipped for CLOSED_PROFILE_DAYS without spending
    // another profile read on them.
    const closedCache = state.closedProfiles[workspaceId] ?? (state.closedProfiles[workspaceId] = {});
    const closedCutoff = Date.now() - CLOSED_PROFILE_DAYS * 86_400_000;
    const closedAt = closedCache[c.authorRef];
    if (closedAt && new Date(closedAt).getTime() >= closedCutoff) { g.closed++; stats.readsSaved += 1; continue; }
    seenAuthors[c.authorRef] = nowIso();
    save();

    // Profile read on the seat that will send. Company pages fail here,
    // which is the point.
    const sendAccount = accounts[rota % accounts.length];
    stats.profileReads += 1;
    const prof = await fetchProfileLite(sendAccount, c.authorRef);
    if (!prof.providerId) { g.profile++; continue; }
    if (own && prof.providerId === own.providerId) { g.profile++; continue; }
    const lastById = seenAuthors[prof.providerId];
    if (lastById && new Date(lastById).getTime() >= recheckCutoff) { g.weekly++; continue; }
    seenAuthors[prof.providerId] = nowIso();

    // OPEN PROFILES ONLY (owner decision 2026-08-13): the DM lands without a
    // connection. Existing 1st-degree connections also take a plain message.
    // Everyone else is skipped, never connect-noted from this lane. Gated
    // FIRST so a closed profile costs exactly one profile read - none of the
    // classification, DNC, or hiring-board work below runs for them - and is
    // remembered so future hunts spend nothing at all.
    const direct = prof.openProfile === true || prof.networkDistance === "DISTANCE_1";
    if (!direct) {
      closedCache[c.authorRef] = nowIso();
      if (prof.providerId) closedCache[prof.providerId] = nowIso();
      g.closed++; stats.closedFound += 1; save(); continue;
    }

    // Decision-maker title, not a peer staffing firm.
    const headline = c.headline ?? prof.headline;
    const { title, company } = parseHeadline(headline);
    const intel = classifyTitle(title ?? headline ?? "");
    // The recruiter wall: agency-side posters are never captured at all.
    if (recruiterWall({ title, headline, company, postText: c.text }) || looksLikePeer(title, company)) {
      g.peer++; stats.peersBlocked += 1; continue;
    }
    if (!intel.isDecisionMaker) { g.title++; continue; }

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

    // The MPC script: deterministic template fill. {job_title} = the matched
    // role for role scenarios, or the desk's primary role for broader ones.
    const id = rid("licw");
    const jobTitle = combo.role ?? roles[0] ?? "candidate";
    const firstName = authorName.split(/\s+/)[0];
    // {current_city}: the post text names where the role is; the poster's
    // profile location is the fallback; "your market" when neither is known.
    const city = cityFromPost(c.text) ?? cityFromLocation(prof.location);
    const dmText = mpcDmFor(id, jobTitle, firstName && firstName !== "LinkedIn" ? firstName : undefined, combo.dmBank, city);

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
      title: title ?? headline, company,
      seniority: intel.seniority, jobFunction: intel.function,
      decisionMaker: true, peer: false, hiring, tier: "hot",
      replyStatus: "none",
      dmText, dmStatus: "suggested",
      createdAt: nowIso(), updatedAt: nowIso(),
    });
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
      && !(i.dmStatus === "suggested" && wallForItem(i)))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.createdAt.localeCompare(a.createdAt));
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
