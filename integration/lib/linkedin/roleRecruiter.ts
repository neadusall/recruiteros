/**
 * RecruitersOS · Role Recruiter
 * Role Hunter's twin, pointed at candidates instead of buyers.
 *
 * Role Hunter hunts people who are HIRING. This hunts people who are LOOKING:
 * qualified professionals who have told LinkedIn they are open to new roles,
 * many of them recently displaced, and reaches them where they can actually be
 * reached.
 *
 * WHAT THE LIVE RESEARCH SAID (probed against prod 2026-08-21, do not
 * re-derive — every number here cost real API calls):
 *
 *  1. `is_open_to_work` comes back on Unipile's profile read and it is the ONLY
 *     reliable qualification signal we have. It is ABSENT rather than false
 *     when the member has it off, so it is read as truthy, never compared.
 *
 *  2. The #OpenToWork hashtag is NOT a signal. Recruiters and agencies have
 *     hijacked it to advertise their own openings to seekers: of ten authors
 *     of role-scoped `#opentowork` posts, ONE was actually flagged open to
 *     work. A plain Recruiter search for the same job title ran 3 in 10 with no
 *     job-seeking language anywhere. So SEARCH is the spine and POSTS are a
 *     reach lane, which is the opposite of how Role Hunter is built.
 *
 *  3. Job seekers do not have Open Profile. Zero of sixteen sampled. Role
 *     Hunter's cheapest channel (the free open-profile DM) does not exist here,
 *     which is what forces the contact ladder below.
 *
 *  4. LinkedIn's own `spotlights: ["OPEN_TO_WORK","ACTIVE_TALENT"]` filter is
 *     in the Unipile Recruiter schema and would replace the read-and-check loop
 *     entirely. All four Recruiter seats answer 401 on it (entitlement, not
 *     credentials: baseline searches on the same seats return 200 with 93,164
 *     results). Spotlights need Recruiter Professional/Corporate; the seats are
 *     Lite. `probeSpotlights` tries it once a day and latches the answer, so
 *     the day a seat is upgraded this lane switches itself on with no deploy.
 *
 *  5. A post's exact date is free: `Number(BigInt(activityId) >> 22n)` is its
 *     millisecond timestamp. Verified against 11 posts. No fuzzy "3 days ago"
 *     parsing, no API call.
 *
 *  6. `tbs=qdr:m` takes indexed post freshness from 14% to 96% under 30 days
 *     with NO loss of volume. Same credit cost. Never run this lane undated.
 *
 * WHAT DOES NOT WORK, so nobody pays to learn it twice: the green #OpenToWork
 * frame is NOT baked into the CDN profile image (0% green rim across nine
 * photos including three confirmed open-to-work — LinkedIn composites it at
 * render time), and the logged-out public profile page does not carry the
 * marker and mostly answers HTTP 999.
 *
 * Everything that sends goes through `requestLinkedInAction`, so the engine
 * stays the only capacity authority — the lesson that cost Role Hunter a day
 * of phantom "posted" counts (a RESERVATION IS NOT A SEND).
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso, rid } from "../core/ids";
import { requestLinkedInAction } from "./os/engine";
import { listAccounts } from "./os/health";
import { unipileRequest, UnipileError } from "./provider";
import { offMarketReason, parseHeadline } from "./commentWatch";
import type { LiAccountState } from "./os/types";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const KEY = "linkedin_role_recruiter_v1";

/** Saved searches worked per tick. Each costs one LinkedIn search on a seat. */
const HUNTS_PER_TICK = Math.max(1, Number(process.env.ROLE_RECRUITER_HUNTS_PER_TICK ?? 2));
/** Search results pulled per hunt per tick. */
const SEARCH_PAGE_SIZE = Math.max(5, Number(process.env.ROLE_RECRUITER_PAGE_SIZE ?? 25));
/**
 * THE budget that matters, exactly as in Role Hunter. A profile view is what
 * LinkedIn counts against a recruiter's account; a search credit is a tenth of
 * a cent. Role Hunter learned this the expensive way (268 views/seat/day
 * against a ~150 published safe threshold) and the fix was to make the scan
 * STOP when the read budget is gone, before another search is paid for.
 *
 * Role Recruiter needs far fewer reads than Role Hunter did, because the search
 * result already carries work_experience, certifications, industry and location:
 * fit is scored for free and a read is spent ONLY to confirm the flag on
 * someone who already passed. Measured base rate is ~30%, so roughly one read
 * in three becomes a lead.
 */
const READS_PER_SCAN = Math.max(1, Number(process.env.ROLE_RECRUITER_READS_PER_SCAN ?? 6));
const READ_GAP_MIN_MS = Math.max(0, Number(process.env.ROLE_RECRUITER_READ_GAP_MIN_MS ?? 2_000));
const READ_GAP_MAX_MS = Math.max(READ_GAP_MIN_MS, Number(process.env.ROLE_RECRUITER_READ_GAP_MAX_MS ?? 9_000));
/** Per-seat daily profile-view ceiling for THIS lane. Role Hunter runs its own
 *  budget on the same seats, so this is deliberately conservative. */
const VIEWS_PER_SEAT_PER_DAY = Math.max(1, Number(process.env.ROLE_RECRUITER_VIEWS_PER_SEAT ?? 25));

/** Touches per seat per working day, before jitter. */
const TOUCHES_PER_SEAT = Math.max(1, Number(process.env.ROLE_RECRUITER_TOUCHES_PER_SEAT ?? 12));
const TOUCHES_PER_SEAT_WEEK = Math.max(1, Number(process.env.ROLE_RECRUITER_TOUCHES_PER_WEEK ?? 60));
/** Drafts auto-executed per tick when autopilot is armed. */
const AUTO_PER_TICK = Math.max(1, Number(process.env.ROLE_RECRUITER_AUTO_PER_TICK ?? 8));

/** Never engage a post older than this. Free to enforce: see activityDate(). */
const MAX_POST_AGE_DAYS = Math.max(1, Number(process.env.ROLE_RECRUITER_MAX_POST_AGE_DAYS ?? 30));
/** Indexed-post window. qdr:w is 100% fresh, qdr:m is 96% at ~1.5x the volume. */
const POST_TIME_WINDOW = process.env.ROLE_RECRUITER_TIME_WINDOW ?? "qdr:m";
/** Never re-touch the same person inside this window, desk-wide. */
const RETOUCH_DAYS = Math.max(1, Number(process.env.ROLE_RECRUITER_RETOUCH_DAYS ?? 30));
/** Leads with no action taken fall out of the queue after this. */
const LEAD_TTL_DAYS = 21;
const SEEN_CAP = 12_000;
const STATS_KEEP_DAYS = 14;

const MAX_NOTE_CHARS = 280;     // LinkedIn's invite note ceiling is 300
const MAX_COMMENT_CHARS = 480;
const MAX_DM_CHARS = 700;

const MODEL = () => process.env.ROLE_RECRUITER_MODEL ?? "claude-haiku-4-5";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One saved search the desk runs on a schedule. */
export interface RrHunt {
  id: string;
  workspaceId: string;
  label: string;
  /** Boolean keywords handed to LinkedIn search. */
  keywords: string;
  /** Titles that count as a fit, for the free triage pass. */
  titles: string[];
  /** Must-have credentials (BCBA, RN, CPA...). One hit is enough. */
  credentials: string[];
  /** Free-text location label shown in the UI. */
  location?: string;
  /** LinkedIn LOCATION parameter id, when the desk resolved one. */
  locationId?: string;
  radiusMiles?: number;
  minYears?: number;
  /** The role we are pitching them, used in the copy. */
  pitchRole?: string;
  active: boolean;
  /** Who created this search. Declared on day one (CLAUDE.md rule 3): saved
   *  searches are user-generated content, and retrofitting ownership later
   *  means backfilling prod snapshots. */
  ownerEmail?: string;
  createdAt: string;
  lastRunAt?: string;
  /** Search paging cursor, so a repeat visit walks deeper. */
  cursor: number;
  /** Lifetime tallies for the hunt row. */
  screened: number;
  reads: number;
  confirmed: number;
}

export type RrChannel = "comment" | "connect" | "message";
export type RrStatus = "draft" | "queued" | "sent" | "failed" | "skipped" | "replied";

export interface RrLead {
  id: string;
  workspaceId: string;
  huntId: string;
  /** Seat that owns this touch. */
  accountId: string;
  /** The recruiter this touch goes out as. Leads themselves are curated
   *  workspace data (CLAUDE.md rule 2), but the touch is authored in a named
   *  person's voice, so it carries their address. */
  ownerEmail?: string;
  name: string;
  firstName?: string;
  slug?: string;
  profileUrl?: string;
  providerId?: string;
  headline?: string;
  location?: string;
  industry?: string;
  currentTitle?: string;
  currentCompany?: string;
  years?: number;
  credentials: string[];
  connections?: number;
  networkDistance?: string;
  openProfile: boolean;
  canInMail: boolean;
  /** How they were found. */
  source: "search" | "post";
  /** Why we believe they are looking. */
  evidence: string;
  postId?: string;
  postUrl?: string;
  postText?: string;
  postAt?: string;
  fit: number;
  fitWhy: string[];
  channel: RrChannel;
  draft?: string;
  status: RrStatus;
  actionId?: string;
  statusReason?: string;
  sentAt?: string;
  createdAt: string;
  /** Set when the recruiter pushed them into the Candidates tab. */
  pushedAt?: string;
  pushedId?: string;
}

/** One day of hunt economics, for the monitoring strip on the card. */
export interface RrDayStats {
  searches: number;
  screened: number;
  vetoed: number;
  reads: number;
  confirmed: number;
  drafted: number;
  sent: number;
}

interface RrState {
  hunts: RrHunt[];
  leads: RrLead[];
  /** ws -> person keys already handled (bounded FIFO). */
  seen: Record<string, string[]>;
  /** ws -> personKey -> ISO of the last touch (the desk-wide re-touch wall). */
  touched: Record<string, Record<string, string>>;
  /** ws::accountId -> ISO stamps of touches actually confirmed by the engine. */
  sendLog: Record<string, string[]>;
  /** ws::accountId -> YYYY-MM-DD -> profile views spent by THIS lane. */
  views: Record<string, Record<string, number>>;
  /** ws -> rotation cursors. */
  cursors: Record<string, number>;
  /** ws -> YYYY-MM-DD -> economics. */
  dayStats: Record<string, Record<string, RrDayStats>>;
  paused: Record<string, boolean>;
  autoMode: Record<string, boolean>;
  limits: Record<string, { perDay: number; perWeek: number }>;
  lastError: Record<string, string>;
  lastScan: Record<string, string>;
  /**
   * ws -> whether this desk's seats can drive LinkedIn's own OPEN_TO_WORK
   * spotlight. Latched from a live probe (see probeSpotlights) and re-probed
   * daily, so a licence upgrade turns the fast lane on with no deploy.
   */
  spotlights: Record<string, { ok: boolean; at: string; detail?: string }>;
}

const empty = (): RrState => ({
  hunts: [], leads: [], seen: {}, touched: {}, sendLog: {}, views: {}, cursors: {},
  dayStats: {}, paused: {}, autoMode: {}, limits: {}, lastError: {}, lastScan: {},
  spotlights: {},
});

let state: RrState = empty();
let hydrated: Promise<void> | null = null;
const persist = debouncedSaver(KEY, () => state);
const save = () => persist();

async function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = loadSnapshot<RrState>(KEY)
      .then((snap) => {
        if (snap && typeof snap === "object") state = { ...empty(), ...snap };
      })
      .catch(() => { /* memory-only until the store is reachable */ });
  }
  return hydrated;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
type Dict = Record<string, unknown>;

function listOf(raw: unknown): Dict[] {
  if (Array.isArray(raw)) return raw as Dict[];
  const r = raw as Dict | undefined;
  for (const k of ["items", "results", "data", "elements"]) {
    const v = r?.[k];
    if (Array.isArray(v)) return v as Dict[];
  }
  return [];
}

/**
 * A LinkedIn activity id is snowflake-shaped: the top 41 bits are a millisecond
 * timestamp. `id >> 22n` is the post's exact publish time, for free, with no
 * API call and no parsing of Google's "3 days ago".
 *
 * Verified 2026-08-21 against eleven posts, including one whose body read "On
 * Monday, June 29, 2026 I officially passed the BCBA examination" and decoded
 * to 2026-07-01, and one labelled "2y" that decoded to exactly two years back.
 *
 * Worth knowing: Role Hunter's post-age gate leans on isoFromIndexDate()
 * parsing relative English, which went silently inert once already. This does
 * not have that failure mode.
 */
export function activityDate(activityId: string): Date | null {
  const id = String(activityId ?? "").trim();
  if (!/^\d{15,}$/.test(id)) return null;
  try {
    const ms = Number(BigInt(id) >> 22n);
    if (!Number.isFinite(ms) || ms < 1_200_000_000_000 || ms > Date.now() + 86_400_000) return null;
    return new Date(ms);
  } catch { return null; }
}

/** Stable identity for the dedupe + re-touch walls. */
function personKey(l: { slug?: string; profileUrl?: string; providerId?: string; name?: string }): string {
  const slug = l.slug
    ?? (l.profileUrl ? /linkedin\.com\/in\/([^/?#]+)/i.exec(l.profileUrl)?.[1] : undefined);
  if (slug) return `in:${slug.toLowerCase()}`;
  if (l.providerId) return `pid:${l.providerId}`;
  return `nm:${(l.name ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function statsFor(workspaceId: string): RrDayStats {
  const byDay = state.dayStats[workspaceId] ?? (state.dayStats[workspaceId] = {});
  const today = day();
  if (!byDay[today]) byDay[today] = { searches: 0, screened: 0, vetoed: 0, reads: 0, confirmed: 0, drafted: 0, sent: 0 };
  for (const k of Object.keys(byDay)) {
    if ((Date.now() - Date.parse(`${k}T00:00:00Z`)) / 86_400_000 > STATS_KEEP_DAYS) delete byDay[k];
  }
  return byDay[today];
}

function noteSeen(workspaceId: string, key: string): void {
  const arr = state.seen[workspaceId] ?? (state.seen[workspaceId] = []);
  if (!arr.includes(key)) arr.push(key);
  if (arr.length > SEEN_CAP) arr.splice(0, arr.length - SEEN_CAP);
}

function prune(): void {
  const cutoff = Date.now() - LEAD_TTL_DAYS * 86_400_000;
  const before = state.leads.length;
  state.leads = state.leads.filter((l) => {
    if (l.status === "sent" || l.status === "replied" || l.pushedAt) return true;
    return Date.parse(l.createdAt) >= cutoff;
  });
  if (state.leads.length !== before) save();
}

function providerIdOf(a: LiAccountState): string | undefined {
  // The executor's own fallback chain: a live seat's engine record can carry a
  // null providerAccountId, in which case accountId IS the Unipile id.
  return a.providerAccountId ?? process.env.UNIPILE_ACCOUNT_ID ?? a.accountId;
}

async function connectedAccounts(workspaceId: string): Promise<LiAccountState[]> {
  try {
    const all = await listAccounts(workspaceId);
    // Same readiness chain the executor uses: a live seat can carry a null
    // providerAccountId, in which case accountId IS the Unipile id, so a filter
    // that demands providerAccountId silently arms nothing.
    return all.filter((a) => providerIdOf(a) && a.connected !== false && !a.killSwitch
      && a.health !== "paused" && a.health !== "disconnected");
  } catch { return []; }
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

/**
 * The wall that does most of the work in THIS tool. Role Hunter's peer wall
 * exists to avoid pitching a rival agency; here it exists because the
 * #OpenToWork hashtag and half of every "open to work" search result are
 * recruiters, coaches and agencies talking ABOUT job seekers. Nine of the ten
 * false positives in the live sample were caught by exactly these terms.
 */
const SELLER_RE = new RegExp([
  "recruit(er|ing|ment)", "talent acquisition", "\\bTA\\b", "headhunt", "staffing",
  "career coach", "resume writer", "resume review", "cv writer", "job coach",
  "outplacement", "executive search", "search firm", "sourcer", "\\bRPO\\b",
  "i hire", "we're hiring", "we are hiring", "now hiring", "hiring manager at",
  "talent partner", "people partner", "hr consultant", "employer brand",
  "thought leader", "keynote speaker", "course creator",
].join("|"), "i");

/** Language that a HUMAN uses about their own search, not a vendor's pitch. */
const SEEKER_RE = new RegExp([
  "open to work", "opentowork", "seeking (a )?(new )?(role|position|opportunit)",
  "looking for (my |a )?(next|new)", "actively (seeking|looking|interviewing)",
  "recently (laid off|let go|impacted)", "position was eliminated",
  "impacted by (the )?(recent )?(layoff|reduction|rif)", "my (role|position) was (eliminated|cut)",
  "back on the market", "available immediately", "between roles",
  "job search(ing)?", "would appreciate any (leads|referrals)",
].join("|"), "i");

/** Vendor-shaped post text: someone advertising roles AT job seekers. */
function sellerPostReason(text: string): string | null {
  const t = text ?? "";
  if (/\bapply (now|here|today)\b|\bDM me your resume\b|\bsend (me )?your (resume|cv)\b/i.test(t)) {
    return "post is advertising roles, not seeking one";
  }
  if (/\bwe (are|'re) (hiring|looking for)\b|\bmy client is\b|\bopen role(s)? (at|with)\b/i.test(t)) {
    return "post is a job advert";
  }
  return null;
}

function sellerReason(o: { headline?: string; title?: string; company?: string }): string | null {
  const blob = [o.headline, o.title, o.company].filter(Boolean).join(" ");
  if (!blob) return null;
  if (SELLER_RE.test(blob)) return "recruiter, coach or agency, not a candidate";
  return null;
}

/* ------------------------------------------------------------------ */
/* Fit scoring (free: runs on the search payload, before any read)     */
/* ------------------------------------------------------------------ */

function tokens(s: string): string[] {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9+#. ]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

/**
 * Score a search hit against the hunt WITHOUT spending a profile view. This is
 * the whole reason Role Recruiter can afford to run: the Recruiter search item
 * already carries work_experience, education, certifications, industry,
 * connections and location, so a read is only ever spent to confirm the flag on
 * somebody who already looks right.
 */
function scoreFit(hunt: RrHunt, p: {
  headline?: string; currentTitle?: string; currentCompany?: string;
  credentials: string[]; years?: number; industry?: string; location?: string;
}): { fit: number; why: string[] } {
  const why: string[] = [];
  let fit = 0;

  const hay = tokens([p.headline, p.currentTitle, p.industry].filter(Boolean).join(" "));
  const haySet = new Set(hay);

  // Title match is the heaviest term: the desk named these titles.
  const titleHit = hunt.titles.find((t) => {
    const need = tokens(t);
    return need.length > 0 && need.every((w) => haySet.has(w));
  });
  if (titleHit) { fit += 45; why.push(`title matches "${titleHit}"`); }
  else {
    // Partial: any single distinctive word from any wanted title.
    const partial = hunt.titles.some((t) => tokens(t).some((w) => w.length > 4 && haySet.has(w)));
    if (partial) { fit += 18; why.push("adjacent title"); }
  }

  // Credentials are binary in licensed desks: a BCBA req needs a BCBA.
  if (hunt.credentials.length) {
    const have = hunt.credentials.filter((c) =>
      p.credentials.some((x) => x.toLowerCase().includes(c.toLowerCase()))
      || new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test([p.headline, p.currentTitle].join(" ")));
    if (have.length) { fit += 30; why.push(`holds ${have.join(", ")}`); }
    else fit -= 25;
  }

  if (hunt.minYears && p.years !== undefined) {
    if (p.years >= hunt.minYears) { fit += 12; why.push(`${p.years}y experience`); }
    else fit -= 20;
  }

  if (hunt.location && p.location) {
    const want = tokens(hunt.location);
    const got = new Set(tokens(p.location));
    if (want.some((w) => w.length > 3 && got.has(w))) { fit += 13; why.push(`in ${p.location}`); }
  }

  return { fit: Math.max(0, Math.min(100, fit)), why };
}

/* ------------------------------------------------------------------ */
/* Unipile reads                                                       */
/* ------------------------------------------------------------------ */

interface SearchHit {
  name: string;
  firstName?: string;
  slug?: string;
  profileUrl?: string;
  providerId?: string;
  headline?: string;
  location?: string;
  industry?: string;
  currentTitle?: string;
  currentCompany?: string;
  years?: number;
  credentials: string[];
  connections?: number;
  networkDistance?: string;
  canInMail: boolean;
}

function yearsFrom(work: Dict[]): number | undefined {
  let months = 0;
  for (const w of work) {
    const s = (w.start ?? {}) as Dict; const e = (w.end ?? {}) as Dict;
    const sy = Number(s.year); const ey = Number(e.year) || new Date().getFullYear();
    if (!Number.isFinite(sy) || sy < 1950) continue;
    months += Math.max(0, (ey - sy) * 12);
  }
  return months ? Math.round(months / 12) : undefined;
}

function hitFromSearchItem(it: Dict): SearchHit | null {
  const name = str(it.name);
  if (!name) return null;
  const work = listOf(it.work_experience);
  const current = work[0] as Dict | undefined;
  const certs = listOf(it.certifications).map((c) => str(c.name)).filter(Boolean) as string[];
  const skills = listOf(it.skills).map((s) => str(s.name) ?? (typeof s === "string" ? s : undefined)).filter(Boolean) as string[];
  const headline = str(it.headline);
  const parsed = parseHeadline(headline);
  return {
    name,
    firstName: str(it.first_name) ?? name.split(/\s+/)[0],
    slug: str(it.public_identifier),
    profileUrl: str(it.public_profile_url) ?? (str(it.public_identifier) ? `https://www.linkedin.com/in/${str(it.public_identifier)}` : undefined),
    providerId: str(it.id) ?? str(it.member_urn) ?? undefined,
    headline,
    location: str(it.location),
    industry: str(it.industry),
    currentTitle: str(current?.role as string) ?? str(current?.position as string) ?? parsed.title,
    currentCompany: str(current?.company as string) ?? parsed.company,
    years: yearsFrom(work),
    credentials: [...new Set([...certs, ...skills])].slice(0, 20),
    connections: Number.isFinite(Number(it.connections_count)) ? Number(it.connections_count) : undefined,
    networkDistance: str(it.network_distance),
    canInMail: it.can_send_inmail === true,
  };
}

/**
 * Ask LinkedIn for people. Recruiter API where the seat has it (richer payload,
 * native filters), Sales Navigator otherwise, classic as the floor.
 *
 * The spotlight filter is attempted FIRST on every desk whose latched probe
 * says it works. That single parameter is the difference between reading
 * profiles to find the ~30% who are looking and asking LinkedIn for the people
 * who are looking.
 */
async function searchPeople(
  account: LiAccountState,
  hunt: RrHunt,
  page: number,
  useSpotlight: boolean,
): Promise<{ hits: SearchHit[]; total?: number; spotlightRejected?: boolean; error?: string }> {
  const pid = providerIdOf(account);
  if (!pid) return { hits: [], error: "seat has no provider account id" };

  const body: Dict = {
    api: "recruiter",
    category: "people",
    keywords: hunt.keywords,
  };
  if (hunt.locationId) {
    body.location = [{ id: hunt.locationId, ...(hunt.radiusMiles ? {} : {}) }];
    if (hunt.radiusMiles) body.location_within_area = hunt.radiusMiles;
  }
  if (hunt.minYears) body.tenure = { min: hunt.minYears };
  if (useSpotlight) body.spotlights = ["OPEN_TO_WORK"];

  const run = async (payload: Dict) => unipileRequest<Dict>(
    `/linkedin/search?account_id=${encodeURIComponent(pid)}${page > 1 ? `&cursor=${page}` : ""}`,
    { method: "POST", body: JSON.stringify(payload) },
  );

  try {
    const res = await run(body);
    const items = listOf(res.items).slice(0, SEARCH_PAGE_SIZE);
    const paging = (res.paging ?? {}) as Dict;
    return { hits: items.map(hitFromSearchItem).filter(Boolean) as SearchHit[], total: Number(paging.total_count) || undefined };
  } catch (e) {
    const status = e instanceof UnipileError ? e.status : 0;
    // 401 here is LinkedIn refusing the ENTITLEMENT, not our credentials: the
    // same seat answers 200 on the same call without `spotlights`. Latch it and
    // retry without, so a Lite desk still hunts.
    if (useSpotlight && (status === 401 || status === 403 || status === 422)) {
      return { hits: [], spotlightRejected: true };
    }
    // Recruiter API unavailable on this seat: fall back down the ladder.
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      for (const api of ["sales_navigator", "classic"]) {
        try {
          const res2 = await run({ api, category: "people", keywords: hunt.keywords });
          const items = listOf(res2.items).slice(0, SEARCH_PAGE_SIZE);
          if (items.length) {
            return { hits: items.map(hitFromSearchItem).filter(Boolean) as SearchHit[] };
          }
        } catch { /* try the next rung */ }
      }
    }
    return { hits: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The qualification gate. One profile view, and the only thing that reliably
 * says this person is looking.
 *
 * `is_open_to_work` is ABSENT rather than false when the member has it off, so
 * it is read as truthy. Never `=== false`.
 */
async function readOpenToWork(account: LiAccountState, identifier: string): Promise<{
  openToWork: boolean; openProfile: boolean; location?: string; headline?: string;
  networkDistance?: string; providerId?: string; ok: boolean;
} | null> {
  const pid = providerIdOf(account);
  if (!pid) return null;
  try {
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(pid)}`);
    return {
      ok: true,
      openToWork: p.is_open_to_work === true,
      openProfile: p.is_open_profile === true,
      location: str(p.location),
      headline: str(p.headline),
      networkDistance: str(p.network_distance),
      providerId: str(p.provider_id) ?? str(p.id),
    };
  } catch {
    return null;
  }
}

/**
 * Ask once a day whether this desk can drive LinkedIn's own OPEN_TO_WORK
 * spotlight. Latched in state so the answer costs one call a day, and so the
 * day somebody upgrades a seat the fast lane switches itself on.
 */
async function probeSpotlights(workspaceId: string, account: LiAccountState): Promise<boolean> {
  const cur = state.spotlights[workspaceId];
  if (cur && Date.now() - Date.parse(cur.at) < 86_400_000) return cur.ok;
  const pid = providerIdOf(account);
  if (!pid) return false;
  let ok = false;
  let detail: string | undefined;
  try {
    await unipileRequest<Dict>(`/linkedin/search?account_id=${encodeURIComponent(pid)}`, {
      method: "POST",
      body: JSON.stringify({ api: "recruiter", category: "people", keywords: "engineer", spotlights: ["OPEN_TO_WORK"] }),
    });
    ok = true;
  } catch (e) {
    ok = false;
    detail = e instanceof UnipileError && e.status === 401
      ? "Recruiter Lite: LinkedIn's Open-to-Work spotlight needs Recruiter Professional or Corporate."
      : (e instanceof Error ? e.message : String(e));
  }
  state.spotlights[workspaceId] = { ok, at: nowIso(), detail };
  save();
  return ok;
}

/* ------------------------------------------------------------------ */
/* Indexed post discovery (the reach lane)                             */
/* ------------------------------------------------------------------ */

interface PostHit {
  postId: string; postUrl: string; text: string; postAt?: string;
  slug: string; name?: string;
}

function nameFromSlug(slug: string): string | undefined {
  const parts = slug.split("-").filter((p) => p && !/\d/.test(p));
  if (parts.length < 2) return undefined;
  return parts.slice(0, 3).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function parsePostRow(link: string, title: string, snippet: string): PostHit | null {
  const slugM = /linkedin\.com\/posts\/([^_/?#]+)_/i.exec(link);
  const idM = /activity[-:](\d{10,})/i.exec(link);
  if (!slugM || !idM) return null;
  const when = activityDate(idM[1]);
  const name = (title || "").split(/\s+on LinkedIn/i)[0].trim();
  const afterColon = title.includes(":") ? title.slice(title.indexOf(":") + 1).trim() : "";
  return {
    postId: idM[1],
    postUrl: link,
    text: [afterColon, snippet].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    postAt: when ? when.toISOString() : undefined,
    slug: slugM[1],
    name: name || nameFromSlug(slugM[1]),
  };
}

async function postsFromSerper(query: string): Promise<{ items: PostHit[]; error?: string }> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { items: [], error: "Serper key not configured on the server." };
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      // tbs is NOT optional here. Undated, only 14% of these results are under
      // 30 days old and a two-year-old "open to work" post is a person with a
      // job. qdr:m measured 96% fresh at the same volume and the same 1 credit.
      body: JSON.stringify({ q: query, tbs: POST_TIME_WINDOW, gl: "us", hl: "en" }),
    });
    if (!res.ok) {
      let msg = `Serper ${res.status}`;
      try { const b = await res.json() as { message?: string }; if (b?.message) msg = `Search engine: ${b.message} (Serper)`; } catch { /* status only */ }
      return { items: [], error: msg };
    }
    const data = await res.json() as { organic?: Array<{ link?: string; title?: string; snippet?: string }> };
    const out: PostHit[] = [];
    for (const r of data.organic ?? []) {
      const hit = parsePostRow(r.link ?? "", r.title ?? "", r.snippet ?? "");
      if (hit) out.push(hit);
    }
    return { items: out };
  } catch (e) { return { items: [], error: `Serper unreachable (${e instanceof Error ? e.message : e})` }; }
}

async function postsFromDataForSeo(query: string): Promise<{ items: PostHit[]; error?: string }> {
  const login = process.env.DATAFORSEO_LOGIN;
  const pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) return { items: [], error: "DataForSEO not configured." };
  try {
    const auth = Buffer.from(`${login}:${pass}`).toString("base64");
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: "en", depth: 20 }]),
    });
    if (!res.ok) return { items: [], error: `Search engine: DataForSEO ${res.status}` };
    const data = await res.json() as { tasks?: Array<{ result?: Array<{ items?: Array<Dict> }> }> };
    const rows = (data.tasks?.[0]?.result?.[0]?.items ?? []).filter((i) => i.type === "organic");
    const out: PostHit[] = [];
    for (const r of rows) {
      const hit = parsePostRow(str(r.url) ?? "", str(r.title) ?? "", str(r.description) ?? "");
      if (hit) out.push(hit);
    }
    return { items: out };
  } catch (e) { return { items: [], error: `DataForSEO unreachable (${e instanceof Error ? e.message : e})` }; }
}

/** The query that finds a seeker rather than a recruiter advertising at them. */
function postQueryFor(hunt: RrHunt): string {
  const role = hunt.titles[0] ?? hunt.keywords;
  return `site:linkedin.com/posts "#opentowork" "${role}"`;
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/**
 * PERMANENT copy rule for this lane: never state or imply we know they were
 * laid off. The flag says "open to new roles"; it does not say why, and
 * inferring redundancy in a first touch reads as surveillance to the one person
 * least able to shrug it off.
 *
 * Also: no em-dashes anywhere in outbound copy (standing house rule).
 */
const LAYOFF_RE = /\b(laid off|let go|lost your job|out of work|between jobs|(?:redundan|downsiz|riff|unemploy)\w*)\b/i;
const LINK_RE = /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.\w{2,}\b|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/i;
const PRESSURE_RE = /\b(calendly|book a call|apply now|limited time|act fast|don't miss)\b/i;

function fold(text: string): string {
  return String(text ?? "")
    .replace(/\s*[—–]\s*/g, ", ")   // em/en dash out, house rule
    .replace(/\s*--\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

function copyLeakReason(text: string): string | null {
  if (LAYOFF_RE.test(text)) return "copy implies we know they were laid off";
  if (LINK_RE.test(text)) return "copy carries a link, address or number";
  if (PRESSURE_RE.test(text)) return "copy reads as hard sell";
  return null;
}

/** Trim to a ceiling on a sentence boundary, never mid-word. */
function fit(text: string, max: number): string | null {
  const t = fold(text);
  if (t.length <= max) return t || null;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
  const sp = cut.lastIndexOf(" ");
  return sp > 0 ? cut.slice(0, sp).trim() : null;
}

const CONNECT_NOTES = [
  "Hi {first}, I saw you're open to new roles. I run a {role} desk and have a search live in {city} right now. Happy to send the details over if it's useful.",
  "Hi {first}, your {title} background lines up with a {role} search I'm working on. You're showing as open to new roles, so I thought I'd reach out directly.",
  "Hi {first}, I recruit in {field} and noticed you're open to opportunities. I have a role open that looks close to your experience. Worth a look?",
  "Hi {first}, I work a {role} desk and your profile stood out. You're marked open to new roles, so I wanted to introduce myself rather than guess.",
];

const OPEN_DMS = [
  "Hi {first}, thanks for connecting. I run a {role} desk and I have a search live in {city} that matches your background. Would it help if I sent the detail across so you can decide whether it's worth a conversation?",
  "Hi {first}, good to be connected. You're showing as open to new roles and I have a {role} opening that lines up with your {title} experience. Want me to send it over?",
];

const POST_COMMENTS = [
  "Your {title} experience is exactly what I'm hearing demand for right now. I run a {role} desk, happy to share what I'm seeing if that's useful to your search.",
  "Good on you for putting this out there. I work a {role} desk in {field} and there is real movement at the moment. Glad to compare notes if you'd like.",
];

function pick<T>(bank: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return bank[h % bank.length];
}

function fillCopy(tpl: string, l: RrLead, hunt: RrHunt): string {
  const city = (l.location ?? hunt.location ?? "").split(",")[0].trim();
  const out = tpl
    .replace(/\{first\}/g, l.firstName ?? l.name.split(/\s+/)[0])
    .replace(/\{title\}/g, l.currentTitle ?? hunt.titles[0] ?? "background")
    .replace(/\{role\}/g, hunt.pitchRole ?? hunt.titles[0] ?? hunt.keywords)
    .replace(/\{field\}/g, hunt.titles[0] ?? hunt.keywords)
    .replace(/\{city\}/g, city || "your area");
  // A missing city leaves "in your area", never a dangling preposition.
  return fold(out.replace(/\s+in\s*,/g, ","));
}

function draftFor(l: RrLead, hunt: RrHunt): string | null {
  const seed = `${l.id}|${hunt.id}`;
  const raw = l.channel === "comment" ? fillCopy(pick(POST_COMMENTS, seed), l, hunt)
    : l.channel === "message" ? fillCopy(pick(OPEN_DMS, seed), l, hunt)
      : fillCopy(pick(CONNECT_NOTES, seed), l, hunt);
  const max = l.channel === "comment" ? MAX_COMMENT_CHARS : l.channel === "message" ? MAX_DM_CHARS : MAX_NOTE_CHARS;
  const text = fit(raw, max);
  if (!text) return null;
  if (copyLeakReason(text)) return null;
  return text;
}

/* ------------------------------------------------------------------ */
/* Throttle                                                            */
/* ------------------------------------------------------------------ */

function seedHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  // FNV-1a alone is NOT enough here. Our keys share a long prefix and differ
  // only at the end ("<ws>|<seat>|YYYY-MM-DD"), and the last byte reaches only
  // the low bits before the final multiply: every day of a month hashed into
  // 0.22-0.30, so every seat drew the SAME allowance all month, which is the
  // one thing this jitter exists to prevent. The avalanche below spreads the
  // last byte across all 32 bits. Caught by scripts/test-role-recruiter.mts.
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function limitsFor(workspaceId: string): { perDay: number; perWeek: number } {
  return state.limits[workspaceId] ?? { perDay: TOUCHES_PER_SEAT, perWeek: TOUCHES_PER_SEAT_WEEK };
}

/** Per-seat daily allowance, jittered so two seats never move in lockstep. */
function allowanceFor(workspaceId: string, accountId: string, d: string): number {
  const base = limitsFor(workspaceId).perDay;
  const j = 0.85 + seedHash(`${workspaceId}|${accountId}|${d}`) * 0.3;
  return Math.max(1, Math.round(base * j));
}

function logKey(workspaceId: string, accountId: string): string { return `${workspaceId}::${accountId}`; }

function usage(workspaceId: string, accountId: string): { today: number; week: number; last?: string } {
  const log = state.sendLog[logKey(workspaceId, accountId)] ?? [];
  const d = day();
  const weekAgo = Date.now() - 7 * 86_400_000;
  return {
    today: log.filter((t) => t.slice(0, 10) === d).length,
    week: log.filter((t) => Date.parse(t) >= weekAgo).length,
    last: log[log.length - 1],
  };
}

/** Confirmed sends only. A reservation is NOT a send: Role Hunter counted
 *  reservations and reported 36 posted when 14 were on LinkedIn. */
function recordSend(workspaceId: string, accountId: string): void {
  const k = logKey(workspaceId, accountId);
  const log = state.sendLog[k] ?? (state.sendLog[k] = []);
  log.push(nowIso());
  if (log.length > 2000) log.splice(0, log.length - 2000);
  save();
}

function seatRoom(workspaceId: string, accountId: string): number {
  const d = day();
  const u = usage(workspaceId, accountId);
  const inflight = state.leads.filter(
    (l) => l.workspaceId === workspaceId && l.accountId === accountId && l.status === "queued",
  ).length;
  const perWeek = limitsFor(workspaceId).perWeek;
  return Math.max(0, Math.min(
    allowanceFor(workspaceId, accountId, d) - u.today - inflight,
    perWeek - u.week - inflight,
  ));
}

function viewsToday(workspaceId: string, accountId: string): number {
  return state.views[logKey(workspaceId, accountId)]?.[day()] ?? 0;
}

function noteView(workspaceId: string, accountId: string): void {
  const k = logKey(workspaceId, accountId);
  const byDay = state.views[k] ?? (state.views[k] = {});
  const d = day();
  byDay[d] = (byDay[d] ?? 0) + 1;
  for (const key of Object.keys(byDay)) {
    if ((Date.now() - Date.parse(`${key}T00:00:00Z`)) / 86_400_000 > 14) delete byDay[key];
  }
  save();
}

/** The seat that reads next: one with view room, dealt round-robin so a burst
 *  never lands on one recruiter (Role Hunter's exact bug). */
function pickReadSeat(workspaceId: string, accounts: LiAccountState[], rota: number): LiAccountState | null {
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[(rota + i) % accounts.length];
    if (viewsToday(workspaceId, a.accountId) < VIEWS_PER_SEAT_PER_DAY) return a;
  }
  return null;
}

/** The seat that sends next: dealt on SHARE of its own allowance, never raw
 *  room, because allowances are jittered and raw room starves the low seat. */
function pickSendSeat(workspaceId: string, accounts: LiAccountState[]): LiAccountState | null {
  const d = day();
  let best: LiAccountState | null = null;
  let bestShare = 0;
  for (const a of accounts) {
    const room = seatRoom(workspaceId, a.accountId);
    if (room <= 0) continue;
    const share = room / Math.max(1, allowanceFor(workspaceId, a.accountId, d));
    if (share > bestShare) { bestShare = share; best = a; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

function huntsFor(workspaceId: string): RrHunt[] {
  return state.hunts.filter((h) => h.workspaceId === workspaceId);
}

/** True when this person is already spoken for: seen, recently touched, or
 *  already sitting in the queue. */
function alreadyHandled(workspaceId: string, key: string): boolean {
  if ((state.seen[workspaceId] ?? []).includes(key)) return true;
  const last = state.touched[workspaceId]?.[key];
  if (last && Date.now() - Date.parse(last) < RETOUCH_DAYS * 86_400_000) return true;
  return false;
}

async function dncBlocked(workspaceId: string, l: { name: string; profileUrl?: string }): Promise<boolean> {
  try {
    const { checkContactable } = await import("../outreach/contactGuard");
    const res = await checkContactable(workspaceId, { fullName: l.name, linkedinUrl: l.profileUrl }, { checkRecency: false });
    return !res.ok;
  } catch {
    // A guard that cannot answer must not silently open the gate.
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a lead from a confirmed open-to-work person. */
function makeLead(
  workspaceId: string, hunt: RrHunt, seat: LiAccountState, hit: SearchHit,
  extra: { openProfile: boolean; networkDistance?: string; evidence: string; source: "search" | "post";
           post?: PostHit; fit: number; fitWhy: string[] },
): RrLead {
  // The contact ladder, decided by what is actually available. Zero of sixteen
  // sampled seekers had Open Profile, so the free DM lane does not exist: a
  // fresh post is the highest-consent touch we have, a connection request is
  // the workhorse, and a plain DM only works if we are already connected.
  const dist = extra.networkDistance ?? hit.networkDistance ?? "";
  const channel: RrChannel =
    extra.source === "post" && extra.post ? "comment"
      : /FIRST/i.test(dist) ? "message"
        : "connect";
  return {
    id: rid("prl"),
    workspaceId,
    huntId: hunt.id,
    accountId: seat.accountId,
    ownerEmail: seat.ownerUserId,
    name: hit.name,
    firstName: hit.firstName,
    slug: hit.slug,
    profileUrl: hit.profileUrl,
    providerId: hit.providerId,
    headline: hit.headline,
    location: hit.location,
    industry: hit.industry,
    currentTitle: hit.currentTitle,
    currentCompany: hit.currentCompany,
    years: hit.years,
    credentials: hit.credentials.slice(0, 8),
    connections: hit.connections,
    networkDistance: dist || undefined,
    openProfile: extra.openProfile,
    canInMail: hit.canInMail,
    source: extra.source,
    evidence: extra.evidence,
    postId: extra.post?.postId,
    postUrl: extra.post?.postUrl,
    postText: extra.post?.text?.slice(0, 600),
    postAt: extra.post?.postAt,
    fit: extra.fit,
    fitWhy: extra.fitWhy,
    channel,
    status: "draft",
    createdAt: nowIso(),
  };
}

/** Lane A: search, triage free, confirm with one read. */
async function runSearchLane(
  workspaceId: string, hunt: RrHunt, accounts: LiAccountState[], budget: { reads: number },
): Promise<number> {
  const stats = statsFor(workspaceId);
  const spotlightOk = await probeSpotlights(workspaceId, accounts[0]);
  const searchSeat = accounts[0];

  const res = await searchPeople(searchSeat, hunt, hunt.cursor + 1, spotlightOk);
  if (res.spotlightRejected) {
    state.spotlights[workspaceId] = {
      ok: false, at: nowIso(),
      detail: "Recruiter Lite: LinkedIn's Open-to-Work spotlight needs Recruiter Professional or Corporate.",
    };
    save();
    return runSearchLane(workspaceId, hunt, accounts, budget);
  }
  stats.searches++;
  hunt.cursor = res.hits.length ? hunt.cursor + 1 : 0;
  hunt.lastRunAt = nowIso();

  if (res.error && !res.hits.length) {
    state.lastError[workspaceId] = res.error;
    save();
    return 0;
  }
  if (state.lastError[workspaceId]) { delete state.lastError[workspaceId]; save(); }

  let created = 0;
  let readRota = state.cursors[`${workspaceId}:readrota`] ?? 0;

  for (const hit of res.hits) {
    if (budget.reads <= 0) break;
    stats.screened++; hunt.screened++;

    const key = personKey(hit);
    if (alreadyHandled(workspaceId, key)) continue;

    // Free gates first: nothing below here costs a LinkedIn action.
    const seller = sellerReason({ headline: hit.headline, title: hit.currentTitle, company: hit.currentCompany });
    if (seller) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    const off = await offMarketReason(hit.location);
    if (off) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    const { fit: score, why } = scoreFit(hunt, hit);
    if (score < 40) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    if (!hit.slug && !hit.providerId) { stats.vetoed++; continue; }

    // Spotlight desks already know the answer; Lite desks buy it with one view.
    let openToWork = spotlightOk;
    let openProfile = false;
    let dist = hit.networkDistance;

    if (!spotlightOk) {
      const seat = pickReadSeat(workspaceId, accounts, readRota++);
      if (!seat) break;                     // every seat out of view room: stop the scan
      await sleep(READ_GAP_MIN_MS + Math.random() * (READ_GAP_MAX_MS - READ_GAP_MIN_MS));
      const prof = await readOpenToWork(seat, hit.slug ?? hit.providerId!);
      noteView(workspaceId, seat.accountId);
      budget.reads--; stats.reads++; hunt.reads++;
      if (!prof) { noteSeen(workspaceId, key); continue; }
      openToWork = prof.openToWork;
      openProfile = prof.openProfile;
      dist = prof.networkDistance ?? dist;
      if (!openToWork) { noteSeen(workspaceId, key); continue; }
    }

    if (await dncBlocked(workspaceId, { name: hit.name, profileUrl: hit.profileUrl })) {
      noteSeen(workspaceId, key); continue;
    }

    const seat = pickSendSeat(workspaceId, accounts) ?? accounts[0];
    const lead = makeLead(workspaceId, hunt, seat, hit, {
      openProfile, networkDistance: dist, source: "search",
      evidence: spotlightOk ? "LinkedIn Open-to-Work spotlight" : "Open to work confirmed on profile",
      fit: score, fitWhy: why,
    });
    lead.draft = draftFor(lead, hunt) ?? undefined;
    if (!lead.draft) { noteSeen(workspaceId, key); continue; }

    state.leads.push(lead);
    noteSeen(workspaceId, key);
    stats.confirmed++; stats.drafted++; hunt.confirmed++;
    created++;
  }

  state.cursors[`${workspaceId}:readrota`] = readRota;
  save();
  return created;
}

/** Lane B: indexed posts. Low yield as a signal, but it hands us a live post to
 *  engage and the candidate's own words about what they want. */
async function runPostLane(
  workspaceId: string, hunt: RrHunt, accounts: LiAccountState[], budget: { reads: number },
): Promise<number> {
  const stats = statsFor(workspaceId);
  const query = postQueryFor(hunt);

  let { items, error } = await postsFromSerper(query);
  if (!items.length) {
    const dfs = await postsFromDataForSeo(query);
    items = dfs.items;
    error = items.length ? undefined : [error, dfs.error].filter(Boolean).join(" | ") || undefined;
  }
  stats.searches++;
  if (error && !items.length) { state.lastError[workspaceId] = error; save(); return 0; }

  let created = 0;
  let readRota = state.cursors[`${workspaceId}:readrota`] ?? 0;
  const cutoff = Date.now() - MAX_POST_AGE_DAYS * 86_400_000;

  for (const p of items) {
    if (budget.reads <= 0) break;
    stats.screened++; hunt.screened++;

    // FREE and exact: the activity id is the post's timestamp. A stale
    // #OpenToWork post is a person who has a job.
    if (!p.postAt || Date.parse(p.postAt) < cutoff) { stats.vetoed++; continue; }

    const key = personKey({ slug: p.slug, name: p.name });
    if (alreadyHandled(workspaceId, key)) continue;

    // The hashtag is hijacked: kill the vendors on the free text first.
    const sellerPost = sellerPostReason(p.text);
    if (sellerPost) { stats.vetoed++; noteSeen(workspaceId, key); continue; }
    if (SELLER_RE.test(p.text)) { stats.vetoed++; noteSeen(workspaceId, key); continue; }
    if (!SEEKER_RE.test(p.text)) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    const seat = pickReadSeat(workspaceId, accounts, readRota++);
    if (!seat) break;
    await sleep(READ_GAP_MIN_MS + Math.random() * (READ_GAP_MAX_MS - READ_GAP_MIN_MS));
    const prof = await readOpenToWork(seat, p.slug);
    noteView(workspaceId, seat.accountId);
    budget.reads--; stats.reads++; hunt.reads++;
    if (!prof) { noteSeen(workspaceId, key); continue; }

    // A fresh first-person seeker post is evidence in its own right, so the
    // flag is not the only way through this lane. Their own words count.
    const evidence = prof.openToWork
      ? "Open to work confirmed, and posted about their search"
      : "Posted about their own search in the last 30 days";
    if (!prof.openToWork && !SEEKER_RE.test(p.text)) { noteSeen(workspaceId, key); continue; }

    const off = await offMarketReason(prof.location);
    if (off) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    const parsed = parseHeadline(prof.headline);
    const hit: SearchHit = {
      name: p.name ?? nameFromSlug(p.slug) ?? p.slug,
      firstName: (p.name ?? nameFromSlug(p.slug) ?? "").split(/\s+/)[0] || undefined,
      slug: p.slug,
      profileUrl: `https://www.linkedin.com/in/${p.slug}`,
      providerId: prof.providerId,
      headline: prof.headline,
      location: prof.location,
      currentTitle: parsed.title,
      currentCompany: parsed.company,
      credentials: [],
      networkDistance: prof.networkDistance,
      canInMail: false,
    };

    const seller = sellerReason({ headline: hit.headline, title: hit.currentTitle, company: hit.currentCompany });
    if (seller) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    const { fit: score, why } = scoreFit(hunt, hit);
    if (score < 25) { stats.vetoed++; noteSeen(workspaceId, key); continue; }

    if (await dncBlocked(workspaceId, { name: hit.name, profileUrl: hit.profileUrl })) {
      noteSeen(workspaceId, key); continue;
    }

    const sendSeat = pickSendSeat(workspaceId, accounts) ?? accounts[0];
    const lead = makeLead(workspaceId, hunt, sendSeat, hit, {
      openProfile: prof.openProfile, networkDistance: prof.networkDistance,
      source: "post", post: p, evidence, fit: score, fitWhy: why,
    });
    lead.draft = draftFor(lead, hunt) ?? undefined;
    if (!lead.draft) { noteSeen(workspaceId, key); continue; }

    state.leads.push(lead);
    noteSeen(workspaceId, key);
    stats.confirmed++; stats.drafted++; hunt.confirmed++;
    created++;
  }

  state.cursors[`${workspaceId}:readrota`] = readRota;
  save();
  return created;
}

/** One workspace's tick. */
export async function scanWorkspace(workspaceId: string, opts: { huntId?: string } = {}): Promise<{
  created: number; reads: number; reason?: string;
}> {
  await hydrate();
  prune();

  if (state.paused[workspaceId] && !opts.huntId) return { created: 0, reads: 0, reason: "paused" };

  const accounts = await connectedAccounts(workspaceId);
  if (!accounts.length) return { created: 0, reads: 0, reason: "No healthy LinkedIn seat connected." };

  const active = huntsFor(workspaceId).filter((h) => opts.huntId ? h.id === opts.huntId : h.active);
  if (!active.length) return { created: 0, reads: 0, reason: "No active searches." };

  // Rotate which hunts get worked, so ten saved searches do not need ten times
  // the budget: each comes round in turn and walks deeper on its next visit.
  const cursor = state.cursors[`${workspaceId}:hunt`] ?? 0;
  const take = opts.huntId ? active : Array.from({ length: Math.min(HUNTS_PER_TICK, active.length) },
    (_, i) => active[(cursor + i) % active.length]);
  state.cursors[`${workspaceId}:hunt`] = (cursor + take.length) % Math.max(1, active.length);

  const budget = { reads: READS_PER_SCAN };
  let created = 0;
  for (const hunt of take) {
    if (budget.reads <= 0) break;
    try { created += await runSearchLane(workspaceId, hunt, accounts, budget); }
    catch (e) { console.log(`[role-recruiter] search lane "${hunt.label}": ${e instanceof Error ? e.message : e}`); }
    if (budget.reads <= 0) break;
    try { created += await runPostLane(workspaceId, hunt, accounts, budget); }
    catch (e) { console.log(`[role-recruiter] post lane "${hunt.label}": ${e instanceof Error ? e.message : e}`); }
  }

  state.lastScan[workspaceId] = nowIso();
  save();

  if (autopilotOn(workspaceId)) {
    const sent = await autoExecute(workspaceId);
    if (sent) console.log(`[role-recruiter] ${workspaceId}: autopilot queued ${sent}`);
  }

  console.log(`[role-recruiter] ${workspaceId}: hunts=${take.length} created=${created} reads=${READS_PER_SCAN - budget.reads}`);
  return { created, reads: READS_PER_SCAN - budget.reads };
}

/** Every workspace with at least one active saved search. */
export async function tickRoleRecruiter(): Promise<void> {
  await hydrate();
  const ids = [...new Set(state.hunts.filter((h) => h.active).map((h) => h.workspaceId))];
  for (const ws of ids) {
    try { await scanWorkspace(ws); }
    catch (e) { console.log(`[role-recruiter] ${ws} scan failed: ${e instanceof Error ? e.message : e}`); }
  }
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

function autopilotOn(workspaceId: string): boolean {
  return state.autoMode[workspaceId] === true;
}

/**
 * Hand one drafted touch to the engine. The engine remains the ONLY capacity
 * authority: `accepted` here means RESERVED, not sent, so the lead goes to
 * "queued" and only `reconcile()` promotes it to "sent" once the ledger says
 * the action actually executed.
 */
export async function sendLead(
  workspaceId: string, leadId: string, textOverride?: string, approvedBy?: string,
): Promise<{ ok: boolean; reason?: string }> {
  await hydrate();
  const lead = state.leads.find((l) => l.id === leadId && l.workspaceId === workspaceId);
  if (!lead) return { ok: false, reason: "Lead not found." };
  if (lead.status === "queued" || lead.status === "sent") return { ok: false, reason: "Already sent." };

  const hunt = state.hunts.find((h) => h.id === lead.huntId);
  const text = fold(textOverride ?? lead.draft ?? "");
  if (!text) return { ok: false, reason: "Nothing to send." };

  const leak = copyLeakReason(text);
  if (leak) return { ok: false, reason: leak };

  const max = lead.channel === "comment" ? MAX_COMMENT_CHARS : lead.channel === "message" ? MAX_DM_CHARS : MAX_NOTE_CHARS;
  if (text.length > max) return { ok: false, reason: `Too long for a ${lead.channel} (${text.length}/${max}).` };

  if (seatRoom(workspaceId, lead.accountId) <= 0) {
    // Try to move the draft to a seat that still has room: a draft is written
    // for a PERSON, not a recruiter.
    const accounts = await connectedAccounts(workspaceId);
    const alt = pickSendSeat(workspaceId, accounts);
    if (!alt) return { ok: false, reason: "Every seat is at its daily limit." };
    lead.accountId = alt.accountId;
  }

  const actionType = lead.channel === "comment" ? "comment_post"
    : lead.channel === "message" ? "message" : "connect_note";

  // connect_note carries `note`, everything else carries `text`, and comment_post
  // wants the bare activity id in `postUrl` (the executor normalizes it).
  const payload = lead.channel === "comment"
    ? { postUrl: lead.postId, text, providerProfileId: lead.providerId, linkedinUrl: lead.profileUrl }
    : lead.channel === "connect"
      ? { note: text, providerProfileId: lead.providerId, linkedinUrl: lead.profileUrl }
      : { text, providerProfileId: lead.providerId, linkedinUrl: lead.profileUrl, openProfile: lead.openProfile && !/FIRST/i.test(lead.networkDistance ?? "") };

  const res = await requestLinkedInAction({
    workspaceId,
    accountId: lead.accountId,
    person: {
      fullName: lead.name,
      linkedinUrl: lead.profileUrl,
      providerProfileId: lead.providerId,
      title: lead.currentTitle,
      company: lead.currentCompany,
      providerProduct: "recruiter",
    },
    actionType,
    payload,
    businessUnit: "recruiting",
    // "manual" is the engine's escape hatch: it skips the automation-paused and
    // reply-stop gates because a human just clicked. An autopilot send must NOT
    // have that, so it goes in as ai_workflow and stays under every global stop.
    sourceType: approvedBy ? "manual" : "ai_workflow",
    ...(approvedBy ? { approvedBy } : {}),
    workflowId: "role_recruiter",
    idempotencyKey: `pr|${workspaceId}|${lead.id}`,
  });

  lead.actionId = res.record.id;
  lead.draft = text;
  if (res.accepted) {
    lead.status = "queued";
    lead.statusReason = undefined;
    const t = state.touched[workspaceId] ?? (state.touched[workspaceId] = {});
    t[personKey(lead)] = nowIso();
  } else {
    lead.status = "failed";
    lead.statusReason = res.reason ?? "The engine declined this action.";
  }
  save();
  return { ok: res.accepted, reason: res.reason };
}

/** Autopilot: at most one touch per seat per tick, engine caps still on top. */
async function autoExecute(workspaceId: string): Promise<number> {
  const accounts = await connectedAccounts(workspaceId);
  const usedSeats = new Set<string>();
  let sent = 0;
  const queue = state.leads
    .filter((l) => l.workspaceId === workspaceId && l.status === "draft" && l.draft)
    .sort((a, b) => b.fit - a.fit);

  for (const lead of queue) {
    if (sent >= AUTO_PER_TICK) break;
    if (usedSeats.has(lead.accountId)) continue;
    if (seatRoom(workspaceId, lead.accountId) <= 0) continue;
    const res = await sendLead(workspaceId, lead.id);
    if (res.ok) { usedSeats.add(lead.accountId); sent++; statsFor(workspaceId).sent++; }
    if (usedSeats.size >= accounts.length) break;
  }
  return sent;
}

/**
 * Promote reservations to confirmed sends off the engine ledger. This is the
 * ONLY place a touch is counted against a seat's allowance, and the only place
 * the card is allowed to say "sent".
 */
export async function reconcile(workspaceId: string): Promise<number> {
  await hydrate();
  const pending = state.leads.filter((l) => l.workspaceId === workspaceId && l.status === "queued" && l.actionId);
  if (!pending.length) return 0;
  let moved = 0;
  try {
    const { getAction } = await import("./os/ledger");
    for (const lead of pending) {
      const row = await getAction(workspaceId, lead.actionId!) as unknown as Dict | null;
      if (!row) continue;
      const status = String(row.status ?? "");
      if (status === "success" || status === "submitted" || status === "sent") {
        lead.status = "sent";
        lead.sentAt = str(row.executedAt) ?? nowIso();
        // The ONE place a touch is counted against a seat. A reservation is not
        // a send: Role Hunter counted reservations and its card read 36 posted
        // when 14 were on LinkedIn.
        recordSend(workspaceId, lead.accountId);
        statsFor(workspaceId).sent++;
        moved++;
      } else if (status === "failed" || status === "suppressed" || status === "cancelled") {
        lead.status = "failed";
        lead.statusReason = str(row.statusReason) ?? "The engine could not send this.";
        moved++;
      }
    }
    if (moved) save();
  } catch {
    // A ledger read failure must never move a lead: silence is not evidence.
  }
  return moved;
}

/* ------------------------------------------------------------------ */
/* Hunts + queue management (the API surface)                          */
/* ------------------------------------------------------------------ */

function splitList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 24);
  return String(raw ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 24);
}

export async function saveHunt(workspaceId: string, input: Dict, ownerEmail?: string): Promise<RrHunt> {
  await hydrate();
  const id = str(input.id);
  const existing = id ? state.hunts.find((h) => h.id === id && h.workspaceId === workspaceId) : undefined;
  const titles = splitList(input.titles);
  const hunt: RrHunt = existing ?? {
    id: rid("prh"),
    workspaceId,
    label: "",
    keywords: "",
    titles: [],
    credentials: [],
    active: true,
    createdAt: nowIso(),
    cursor: 0,
    screened: 0,
    reads: 0,
    confirmed: 0,
  };
  hunt.label = str(input.label) ?? titles[0] ?? str(input.keywords) ?? "Untitled search";
  hunt.keywords = str(input.keywords) ?? titles.join(" OR ") ?? "";
  hunt.titles = titles.length ? titles : hunt.titles;
  hunt.credentials = splitList(input.credentials);
  hunt.location = str(input.location);
  hunt.locationId = str(input.locationId);
  hunt.radiusMiles = Number(input.radiusMiles) || undefined;
  hunt.minYears = Number(input.minYears) || undefined;
  hunt.pitchRole = str(input.pitchRole);
  if (typeof input.active === "boolean") hunt.active = input.active;
  if (!hunt.ownerEmail && ownerEmail) hunt.ownerEmail = ownerEmail;
  if (!existing) state.hunts.push(hunt);
  save();
  return hunt;
}

export async function removeHunt(workspaceId: string, id: string): Promise<void> {
  await hydrate();
  state.hunts = state.hunts.filter((h) => !(h.id === id && h.workspaceId === workspaceId));
  state.leads = state.leads.filter((l) => !(l.huntId === id && l.status === "draft"));
  save();
}

export async function toggleHunt(workspaceId: string, id: string, active: boolean): Promise<void> {
  await hydrate();
  const h = state.hunts.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (h) { h.active = active; save(); }
}

export async function editLead(workspaceId: string, id: string, text: string): Promise<boolean> {
  await hydrate();
  const l = state.leads.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!l) return false;
  l.draft = fold(text);
  save();
  return true;
}

export async function skipLead(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const l = state.leads.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!l) return false;
  l.status = "skipped";
  noteSeen(workspaceId, personKey(l));
  save();
  return true;
}

export async function setPaused(workspaceId: string, paused: boolean): Promise<void> {
  await hydrate();
  state.paused[workspaceId] = paused;
  save();
}

export async function setAuto(workspaceId: string, on: boolean): Promise<void> {
  await hydrate();
  state.autoMode[workspaceId] = on;
  save();
}

export async function setLimits(workspaceId: string, perDay?: number, perWeek?: number): Promise<void> {
  await hydrate();
  const cur = limitsFor(workspaceId);
  state.limits[workspaceId] = {
    perDay: Math.max(1, Math.min(40, Number(perDay) || cur.perDay)),
    perWeek: Math.max(1, Math.min(200, Number(perWeek) || cur.perWeek)),
  };
  save();
}

/**
 * Push confirmed candidates into the Candidates tab, so a lead that answers is
 * worked in the pipeline like any other candidate rather than living in this
 * tool forever.
 */
export async function pushToCandidates(
  workspaceId: string, ids: string[], listName?: string,
): Promise<{ pushed: number; deduped: number; listId?: string; error?: string }> {
  await hydrate();
  const leads = state.leads.filter((l) => l.workspaceId === workspaceId && ids.includes(l.id) && !l.pushedAt);
  if (!leads.length) return { pushed: 0, deduped: 0 };
  const name = (listName || "").trim() || "Role Recruiter";
  try {
    const { getCore } = await import("../core/repository");
    const { addProspect } = await import("../prospects");
    const { createCampaign } = await import("../campaigns");
    const { upsertProspectList } = await import("../prospect-lists");
    const core = getCore();

    // Get-or-create BY NAME, the same rule JD Sourcing's promote applies, so a
    // second push tops the campaign up instead of forking a twin.
    let campaignId = (await core.listCampaigns(workspaceId))
      .find((c) => c.motion === "recruiting" && c.name.trim().toLowerCase() === name.toLowerCase())?.id;
    if (!campaignId) {
      campaignId = (await createCampaign({
        workspaceId, motion: "recruiting", name,
        goal: "Candidates confirmed open to work by Role Recruiter",
        icp: { accountProfile: "", persona: "", disqualifiers: [] },
        signals: [],
      })).id;
    }

    const prospectIds: string[] = [];
    let pushed = 0; let deduped = 0;
    for (const l of leads) {
      if (l.profileUrl) {
        const existing = await core.findProspectByLinkedin(workspaceId, l.profileUrl);
        if (existing) {
          deduped++; prospectIds.push(existing.id);
          l.pushedAt = nowIso(); l.pushedId = existing.id;
          continue;
        }
      }
      const p = await addProspect({
        workspaceId, campaignId, motion: "recruiting",
        fullName: l.name,
        title: l.currentTitle,
        headline: l.headline,
        company: l.currentCompany,
        location: l.location,
        linkedinUrl: l.profileUrl,
        category: name,
      });
      prospectIds.push(p.id);
      l.pushedAt = nowIso(); l.pushedId = p.id;
      pushed++;
    }

    let listId: string | undefined;
    try {
      const list = await upsertProspectList(workspaceId, { name, prospectIds });
      listId = (list as unknown as Dict)?.id as string | undefined;
    } catch { /* the prospects landed; the saved list is a convenience */ }

    save();
    return { pushed, deduped, listId };
  } catch (e) {
    return { pushed: 0, deduped: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

export interface RrView {
  ready: boolean;
  reasons: string[];
  paused: boolean;
  autopilot: boolean;
  limits: { perDay: number; perWeek: number };
  spotlight: { ok: boolean; detail?: string };
  lastScan?: string;
  lastError?: string;
  hunts: RrHunt[];
  seats: Array<{ accountId: string; name?: string; today: number; allowance: number; views: number; viewCap: number }>;
  queue: RrLead[];
  sent: RrLead[];
  tallies: { drafts: number; queued: number; sent7: number; confirmed7: number; pushed: number };
  stats: Array<{ day: string } & RrDayStats>;
}

export async function roleRecruiterView(workspaceId: string): Promise<RrView> {
  await hydrate();
  prune();
  await reconcile(workspaceId);

  const accounts = await connectedAccounts(workspaceId);
  const reasons: string[] = [];
  if (!accounts.length) reasons.push("No healthy LinkedIn seat is connected.");
  if (!process.env.SERPER_API_KEY && !process.env.DATAFORSEO_LOGIN) {
    reasons.push("No search engine configured, so the post lane is off.");
  }
  if (!huntsFor(workspaceId).some((h) => h.active)) reasons.push("No active saved search.");

  const mine = state.leads.filter((l) => l.workspaceId === workspaceId);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const byDay = state.dayStats[workspaceId] ?? {};

  return {
    ready: accounts.length > 0 && huntsFor(workspaceId).some((h) => h.active),
    reasons,
    paused: state.paused[workspaceId] === true,
    autopilot: autopilotOn(workspaceId),
    limits: limitsFor(workspaceId),
    spotlight: {
      ok: state.spotlights[workspaceId]?.ok === true,
      detail: state.spotlights[workspaceId]?.detail,
    },
    lastScan: state.lastScan[workspaceId],
    lastError: state.lastError[workspaceId],
    hunts: huntsFor(workspaceId),
    seats: accounts.map((a) => ({
      accountId: a.accountId,
      name: a.displayName,
      today: usage(workspaceId, a.accountId).today,
      allowance: allowanceFor(workspaceId, a.accountId, day()),
      views: viewsToday(workspaceId, a.accountId),
      viewCap: VIEWS_PER_SEAT_PER_DAY,
    })),
    queue: mine.filter((l) => l.status === "draft" || l.status === "queued" || l.status === "failed")
      .sort((a, b) => b.fit - a.fit).slice(0, 200),
    sent: mine.filter((l) => l.status === "sent" || l.status === "replied")
      .sort((a, b) => Date.parse(b.sentAt ?? b.createdAt) - Date.parse(a.sentAt ?? a.createdAt)).slice(0, 100),
    tallies: {
      drafts: mine.filter((l) => l.status === "draft").length,
      queued: mine.filter((l) => l.status === "queued").length,
      sent7: mine.filter((l) => l.status === "sent" && Date.parse(l.sentAt ?? l.createdAt) >= weekAgo).length,
      confirmed7: mine.filter((l) => Date.parse(l.createdAt) >= weekAgo).length,
      pushed: mine.filter((l) => !!l.pushedAt).length,
    },
    stats: Object.keys(byDay).sort().slice(-STATS_KEEP_DAYS).map((d) => ({ day: d, ...byDay[d] })),
  };
}

/** Health-board probe: the System Health rule is that every new subsystem
 *  registers a check, so a silent lane cannot look healthy. */
export async function roleRecruiterHealth(workspaceId: string): Promise<{
  ok: boolean; detail: string;
}> {
  await hydrate();
  const active = huntsFor(workspaceId).filter((h) => h.active).length;
  if (!active) return { ok: true, detail: "No active searches (idle by design)." };
  const last = state.lastScan[workspaceId];
  const stale = !last || Date.now() - Date.parse(last) > 3 * 3_600_000;
  if (stale) return { ok: false, detail: `No scan in the last 3 hours (last ${last ?? "never"}).` };
  const err = state.lastError[workspaceId];
  if (err) return { ok: false, detail: err };
  return { ok: true, detail: `${active} active search${active === 1 ? "" : "es"}, last scan ${last}.` };
}

/** Test seam: the throttle and date maths without a live snapshot behind them. */
export const __roleRecruiterTestHooks = {
  activityDate,
  scoreFit,
  sellerReason,
  sellerPostReason,
  copyLeakReason,
  fold,
  fit,
  personKey,
  SEEKER_RE,
  SELLER_RE,
  reset(next?: Partial<RrState>) { state = { ...empty(), ...(next ?? {}) }; hydrated = Promise.resolve(); },
  state() { return state; },
  seatRoom,
  allowanceFor,
  pickSendSeat,
};
