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
  "Saw your post for a {job_title}. I just wrapped a {job_title} search and two finalists who did not get the offer are still open. Want me to send them over?",
  "Your {job_title} post came up in my feed. We just closed a {job_title} search and a couple of strong runners-up are still on the market. Happy to share profiles if useful.",
  "Noticed you are hiring a {job_title}. I have a few vetted {job_title} candidates left from a search that just closed, still warm. Worth a look?",
  "Quick one on your {job_title} opening: a search I ran for the same title just ended and the shortlist is still available. Want the top two?",
  "{first_name}, saw the {job_title} post. Just came off a {job_title} search with vetted candidates still warm. I can send a couple today if helpful.",
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
  "Congrats on the growth. We place {job_title}s all day and a search that just closed left a couple of vetted candidates still warm. Useful as you build out?",
  "Sounds like the team is scaling. A {job_title} search I just wrapped left strong runners-up still on the market. Want me to send a couple over?",
  "Growth like that usually means hiring is next. I keep a warm bench of vetted {job_title}s from recent searches. Happy to share a few profiles.",
];

/** Deterministic template pick + fill; trims to the DM threshold. */
function mpcDmFor(seed: string, jobTitle: string, firstName?: string, bank: "mpc" | "growth" = "mpc"): string {
  const pool = bank === "growth" ? GROWTH_DM_TEMPLATES : MPC_DM_TEMPLATES;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  let t = pool[h % pool.length];
  if (t.includes("{first_name}") && !firstName) t = pool[0];
  const out = t
    .replace(/\{job_title\}/g, jobTitle)
    .replace(/\{first_name\}/g, firstName ?? "")
    .replace(/^,\s*/, "")
    .trim();
  return scrub(out).slice(0, MAX_DM_CHARS);
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
let state: WatchState = { items: [], seen: {}, ownProfile: {}, posterSeen: {}, marketKeywords: {}, keywordCursor: {}, scenarios: {}, lastError: {}, paused: {}, autoMode: {}, lastScan: {} };
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

function prune(): void {
  const cutoff = Date.now() - ITEM_TTL_DAYS * 86_400_000;
  state.items = state.items.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
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
  if (!enabled) return 0;
  const APPROVER = "comment-radar-autopilot";
  const rank = (i: CommentLeadItem): number =>
    i.kind === "poster" ? 0 : i.tier === "hot" ? 1 : i.tier === "warm" ? 2 : 3;
  const open = state.items
    .filter((i) => i.workspaceId === workspaceId && i.tier !== "community"
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
  providerId?: string; headline?: string; publicUrl?: string; openProfile?: boolean; networkDistance?: string;
}> {
  try {
    const { unipileRequest } = await import("./provider");
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${providerIdOf(account)}`);
    return {
      providerId: str(p.provider_id) ?? str(p.id),
      headline: str(p.headline),
      publicUrl: str(p.public_identifier) ? `https://www.linkedin.com/in/${str(p.public_identifier)}` : undefined,
      openProfile: typeof p.is_open_profile === "boolean" ? p.is_open_profile : undefined,
      networkDistance: str(p.network_distance),
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

export async function scanWorkspace(workspaceId: string): Promise<{ scanned: number; created: number; skipped: string | null }> {
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
  try { dmCreated = await scanPosters(workspaceId, accounts); } catch (e) {
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
  const clean = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3))].slice(0, 25);
  state.marketKeywords[workspaceId] = clean;
  save();
  return marketKeywordsFor(workspaceId);
}

export function scenariosFor(workspaceId: string): { presets: string[]; custom: Array<{ label: string; phrase: string }> } {
  const sel = state.scenarios[workspaceId];
  return sel ?? { presets: [...DEFAULT_SCENARIOS], custom: [] };
}

export async function setScenarios(
  workspaceId: string,
  presets: string[],
  custom: Array<{ label?: string; phrase?: string }>,
): Promise<void> {
  await hydrate();
  const validIds = new Set(SCENARIO_PRESETS.map((p) => p.id));
  state.scenarios[workspaceId] = {
    presets: [...new Set(presets.filter((p) => validIds.has(p)))],
    custom: custom
      .map((c) => ({ label: String(c.label ?? c.phrase ?? "").trim().slice(0, 60), phrase: String(c.phrase ?? "").trim().slice(0, 120) }))
      .filter((c) => c.phrase.length >= 3)
      .slice(0, 15),
  };
  save();
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

async function scanPosters(workspaceId: string, accounts: LiAccountState[]): Promise<number> {
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
  // combos; 96 ticks/day covers the whole rotation several times over.
  const combos = scanCombos(workspaceId);
  const idx = (state.keywordCursor[workspaceId] ?? 0) % combos.length;
  state.keywordCursor[workspaceId] = idx + 1;
  const combo = combos[idx];
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
    // Break layer: engine failures surface on the card, not just in logs.
    if (r.error) {
      state.lastError[workspaceId] = r.error;
      save();
      console.log(`[comment-radar] market "${keyword}": ${r.error}`);
    } else if (state.lastError[workspaceId]) {
      delete state.lastError[workspaceId];
      save();
    }
  }

  let created = 0;
  // Per-gate counters so a zero-yield search names the gate that ate it.
  const g = { nopost: 0, seen: 0, intent: 0, weekly: 0, profile: 0, title: 0, dnc: 0, closed: 0 };
  for (const c of candidates) {
    if (created >= POSTER_NEW_PER_TICK) break;
    if (c.text.length < 40) { g.nopost++; continue; }
    if (seenPosts.has(c.postId)) { g.seen++; continue; }
    seenPosts.add(c.postId); seenArr.push(c.postId);

    // Hiring-post scenarios require hiring intent in the text; broader
    // scenarios (growth, funding, custom phrases) accept any real post.
    if (combo.hiringIntent && !HIRING_INTENT_RE.test(c.text)) { g.intent++; continue; }

    // One touch per author per week, whichever key we knew them by.
    const lastTouch = seenAuthors[c.authorRef];
    if (lastTouch && new Date(lastTouch).getTime() >= recheckCutoff) { g.weekly++; continue; }
    seenAuthors[c.authorRef] = nowIso();
    save();

    // Profile read on the seat that will send. Company pages fail here,
    // which is the point.
    const sendAccount = accounts[rota % accounts.length];
    const prof = await fetchProfileLite(sendAccount, c.authorRef);
    if (!prof.providerId) { g.profile++; continue; }
    if (own && prof.providerId === own.providerId) { g.profile++; continue; }
    const lastById = seenAuthors[prof.providerId];
    if (lastById && new Date(lastById).getTime() >= recheckCutoff) { g.weekly++; continue; }
    seenAuthors[prof.providerId] = nowIso();

    // Decision-maker title, not a peer staffing firm.
    const headline = c.headline ?? prof.headline;
    const { title, company } = parseHeadline(headline);
    const intel = classifyTitle(title ?? headline ?? "");
    if (!intel.isDecisionMaker || looksLikePeer(title, company)) { g.title++; continue; }

    const authorName = c.authorName ?? "LinkedIn member";

    // Never message anyone on the do-not-contact list or inside the
    // cross-channel recency cooldown.
    try {
      const { checkContactable } = await import("../outreach/contactGuard");
      const dnc = await checkContactable(workspaceId,
        { fullName: authorName, company, linkedinUrl: prof.publicUrl },
        { checkRecency: true });
      if (!dnc.ok) { g.dnc++; continue; }
    } catch { g.dnc++; continue; }

    // OPEN PROFILES ONLY (owner decision 2026-08-13): the DM lands without a
    // connection. Existing 1st-degree connections also take a plain message.
    // Everyone else is skipped, never connect-noted from this lane.
    const direct = prof.openProfile === true || prof.networkDistance === "DISTANCE_1";
    if (!direct) { g.closed++; continue; }

    // Supporting evidence, never a gate: their own board's open roles.
    const hiring = company ? await checkHiring(company) : undefined;

    // The MPC script: deterministic template fill. {job_title} = the matched
    // role for role scenarios, or the desk's primary role for broader ones.
    const id = rid("licw");
    const jobTitle = combo.role ?? roles[0] ?? "candidate";
    const firstName = authorName.split(/\s+/)[0];
    const dmText = mpcDmFor(id, jobTitle, firstName && firstName !== "LinkedIn" ? firstName : undefined, combo.dmBank);

    state.items.push({
      id, workspaceId, kind: "poster",
      postId: c.postId, postExcerpt: c.text.slice(0, 700), postAt: c.postAt,
      commentId: "", commentText: "",
      openProfile: prof.openProfile,
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
}

const TIER_RANK: Record<CommentTier, number> = { hot: 0, warm: 1, community: 2 };

export async function commentWatchView(workspaceId: string): Promise<CommentWatchView> {
  await hydrate();
  const status = await commentWatchStatus(workspaceId);
  const autopilot = await commentWatchAutopilot(workspaceId);
  const items = state.items
    .filter((i) => i.workspaceId === workspaceId)
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.createdAt.localeCompare(a.createdAt));
  return {
    status, autopilot,
    keywords: marketKeywordsFor(workspaceId),
    scenarioPresets: SCENARIO_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
    scenarios: scenariosFor(workspaceId),
    lastError: state.lastError[workspaceId],
    lastScan: state.lastScan[workspaceId],
    items,
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
      payload: { text: item.dmText, providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl },
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
