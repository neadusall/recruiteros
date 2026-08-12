/**
 * RecruitersOS · LinkedIn Comment Listener ("who is engaging with my posts?")
 *
 * The owner's posts are getting comments; each commenter is a possible buyer.
 * Every tick (15 min by default) this listener:
 *
 *   1. lists the connected account's OWN recent posts,
 *   2. pulls new comments on them (deduped against everything already seen),
 *   3. enriches each commenter (headline -> title + company, network distance),
 *   4. scores them: decision-maker (classifyTitle) + "is their company hiring
 *      right now" (their own ATS board via resolveCompanyRoles),
 *   5. tiers them hot / warm / community, and
 *   6. for hot + warm, drafts a substance-first reply to their comment.
 *
 * NOTHING posts on its own: everything waits for one-tap approval in the
 * LinkedIn tab and goes out through requestLinkedInAction, so account caps,
 * health and the ledger all apply.
 *
 * HOT commenters (hiring decision-maker AND open roles) get BOTH a
 * connection-note draft and a reply draft, each independently one-tap
 * approvable; no forced ordering (owner decision 2026-08-12).
 *
 * SECOND LANE, "poster leads" (owner decision 2026-08-12): decision-makers in
 * the BD pool who are POSTING on LinkedIn while their company has open roles.
 * No public comment on their post; instead a direct custom message
 * referencing the post: open profiles get it as a free direct InMail, and
 * non-open profiles (who cannot receive a stranger's DM) get the same
 * personalized text shaped as a connection note.
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
// Poster lane pacing: each examined prospect costs a profile read + a posts
// read against the provider, so the sweep trickles through the BD pool.
const POSTER_SCAN_PER_TICK = 20; // prospects examined per tick
const POSTER_NEW_PER_TICK = 8;   // DM drafts created per tick
const POSTER_RECHECK_DAYS = 7;   // how often the same prospect is re-examined
const POST_FRESH_DAYS = 21;      // only message about a reasonably fresh post

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
  /** ws -> prospectId -> last time the poster lane examined them (recheck weekly). */
  posterSeen: Record<string, Record<string, string>>;
  /** ws -> owner switched the listener off. */
  paused: Record<string, boolean>;
  lastScan: Record<string, string>;
}

const KEY = "linkedin_comment_watch_v1";
let state: WatchState = { items: [], seen: {}, ownProfile: {}, posterSeen: {}, paused: {}, lastScan: {} };
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
          paused: snap.paused ?? {},
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

async function connectedAccounts(workspaceId: string): Promise<LiAccountState[]> {
  try {
    const all = await listAccounts(workspaceId);
    return all.filter((a) => a.providerAccountId && a.connected !== false && !a.killSwitch);
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

const DM_RULES = `You write direct LinkedIn messages for a recruiting agency owner. The recipient is a hiring decision-maker whose company has open roles, and they just published a LinkedIn post; this message goes straight to their inbox. The reader must never suspect a machine wrote it.
Rules:
- Open by engaging ONE specific point from their post: extend it with a concrete observation from recruiting/staffing or a sharp question. Never summarize their post back, never flatter.
- You may include ONE natural sentence acknowledging they are growing (the open roles), and at most one low-key line that this is the space you work in. No hard pitch, no links, no calendar ask, no "quick call".
- 40 to 80 words. Short paragraphs. No exclamation marks, no emoji, no hashtags, no long dashes.
- Banned openers: "Great post", "Love this", "Hope you're well", "I came across". Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align", "synergies".
- End with one genuine question they would want to answer. Never mention AI.
Return ONLY the message text, nothing else.`;

const POSTER_CONNECT_RULES = `You write short LinkedIn connection notes for a recruiting agency owner. The recipient is a hiring decision-maker who just published a LinkedIn post; their profile does not accept direct messages from strangers, so this note is the door-opener. The reader must never suspect a machine wrote it.
Rules:
- Max 270 characters. Two sentences at most.
- Reference ONE specific point from their post naturally. No flattery, no "I came across your profile".
- No pitch, no links, no emoji, no long dashes, no mention of hiring, roles, or services. Connecting to keep talking is the whole message.
- Never mention AI.
Return ONLY the note text, nothing else.`;

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
  const cached = state.ownProfile[workspaceId];
  if (cached && cached.accountId === account.providerAccountId) return cached;
  try {
    const { unipile } = await import("../providers");
    const me = await unipile.getOwnProfile(account.providerAccountId!) as Dict;
    const providerId = str(me.provider_id) ?? str(me.id);
    if (!providerId) return null;
    const own: OwnProfile = {
      accountId: account.providerAccountId!,
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
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(identifier)}?account_id=${account.providerAccountId}`);
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
  if (!status.active) return { scanned: 0, created: 0, skipped: "standby" };

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts[0];
  const own = await ownProfileFor(workspaceId, account);
  if (!own) return { scanned: 0, created: 0, skipped: "own_profile_unresolved" };

  const { unipile } = await import("../providers");
  const seenArr = state.seen[workspaceId] ?? (state.seen[workspaceId] = []);
  const seen = new Set(seenArr);
  let scanned = 0;
  let created = 0;

  let posts: Dict[] = [];
  try {
    posts = listOf(await unipile.listPosts(account.providerAccountId!, own.providerId, POSTS_TO_WATCH));
  } catch { return { scanned: 0, created: 0, skipped: "posts_unavailable" }; }

  for (const post of posts.slice(0, POSTS_TO_WATCH)) {
    if (created >= NEW_PER_TICK) break;
    const postId = str(post.social_id) ?? str(post.id) ?? str(post.post_id);
    if (!postId) continue;
    const postExcerpt = (str(post.text) ?? str(post.commentary) ?? "").slice(0, 700);

    let comments: Dict[] = [];
    try {
      comments = listOf(await unipile.listPostComments(account.providerAccountId!, postId, { limit: COMMENTS_PER_POST }));
    } catch { continue; }

    for (const rawC of comments) {
      if (created >= NEW_PER_TICK) break;
      const c = parseComment(rawC);
      if (!c) continue;
      if (seen.has(c.commentId)) continue;
      // The owner replying in their own threads must never re-enter the queue.
      if (c.authorProviderId && c.authorProviderId === own.providerId) {
        seen.add(c.commentId); seenArr.push(c.commentId);
        continue;
      }
      seen.add(c.commentId); seenArr.push(c.commentId);
      scanned++;

      let headline = c.authorHeadline;
      let publicUrl = c.authorPublicUrl;
      if (!headline && c.authorProviderId) {
        const extra = await fetchProfileLite(account, c.authorProviderId);
        headline = extra.headline;
        publicUrl = publicUrl ?? extra.publicUrl;
      }
      const { title, company } = parseHeadline(headline);
      const intel = classifyTitle(title ?? headline ?? "");
      const peer = looksLikePeer(title, company);
      const hiring = company && !peer ? await checkHiring(company) : undefined;
      const tier = tierOf(intel.isDecisionMaker, peer, hiring?.openRoles ?? 0);

      const item: CommentLeadItem = {
        id: rid("licw"), workspaceId,
        postId, postExcerpt,
        commentId: c.commentId, commentText: c.text.slice(0, 1000), commentAt: c.date,
        authorProviderId: c.authorProviderId, authorName: c.authorName,
        authorHeadline: headline, authorPublicUrl: publicUrl, networkDistance: c.networkDistance,
        title, company,
        seniority: intel.seniority, jobFunction: intel.function,
        decisionMaker: intel.isDecisionMaker, peer, hiring, tier,
        replyStatus: "none",
        createdAt: nowIso(), updatedAt: nowIso(),
      };

      // Hot and warm commenters get a drafted reply immediately; community
      // stays listed with on-demand drafting so goodwill replies are one tap away.
      const persona = [c.authorName, title, company ? `at ${company}` : undefined].filter(Boolean).join(", ");
      if (tier === "hot" || tier === "warm") {
        const text = await draft(REPLY_RULES,
          `MY POST:\n${postExcerpt || "(no text)"}\n\nTHEIR COMMENT (by ${persona}):\n${c.text}\n\nWrite the reply.`);
        if (text) { item.replyText = text; item.replyStatus = "suggested"; }
      }
      // A decision-maker at a company hiring right now also gets a connection
      // note referencing their comment; reply and connect approve independently.
      if (tier === "hot") {
        const note = await draft(CONNECT_RULES,
          `The person: ${persona}.\nMy post they commented under:\n${postExcerpt || "(no text)"}\n\nTheir comment:\n${c.text}\n\nWrite the connection note.`);
        if (note) { item.connectText = note; item.connectStatus = "suggested"; }
      }

      state.items.push(item);
      created++;
      save();
    }
  }

  if (seenArr.length > SEEN_CAP) state.seen[workspaceId] = seenArr.slice(-SEEN_CAP);

  // Lane 2: posting decision-makers with open roles -> direct-message drafts.
  let dmCreated = 0;
  try { dmCreated = await scanPosters(workspaceId, account); } catch { /* lane 1 results stand */ }

  state.lastScan[workspaceId] = nowIso();
  prune();
  save();
  return { scanned, created: created + dmCreated, skipped: null };
}

/* ------------------------------------------------------------------ */
/* The poster lane: decision-makers in the BD pool who are posting      */
/* while their company has open roles. No public comment; a direct      */
/* custom message instead (free InMail to open profiles, plain message  */
/* to existing connections, connection note otherwise).                 */
/* ------------------------------------------------------------------ */

async function scanPosters(workspaceId: string, account: LiAccountState): Promise<number> {
  const seen = state.posterSeen[workspaceId] ?? (state.posterSeen[workspaceId] = {});
  const recheckCutoff = Date.now() - POSTER_RECHECK_DAYS * 86_400_000;
  const inQueue = new Set(
    state.items
      .filter((i) => i.workspaceId === workspaceId && i.kind === "poster" && i.prospectId)
      .map((i) => i.prospectId as string),
  );

  let prospects: Array<{
    id: string; email?: string; linkedinUrl?: string; fullName?: string; firstName?: string;
    company?: string; title?: string; motion?: string;
  }> = [];
  try {
    const { getCore } = await import("../core/repository");
    prospects = (await getCore().listProspects(workspaceId))
      .filter((p) => p.motion === "bd" && p.linkedinUrl && p.title);
  } catch { return 0; }

  const { unipile } = await import("../providers");
  let examined = 0;
  let created = 0;

  for (const p of prospects) {
    if (examined >= POSTER_SCAN_PER_TICK || created >= POSTER_NEW_PER_TICK) break;
    if (inQueue.has(p.id)) continue;
    const last = seen[p.id];
    if (last && new Date(last).getTime() >= recheckCutoff) continue;
    const intel = classifyTitle(p.title ?? "");
    if (!intel.isDecisionMaker || looksLikePeer(p.title, p.company)) { seen[p.id] = nowIso(); continue; }

    examined++;
    seen[p.id] = nowIso();
    save();

    // Benchmark 1: their company has open roles right now (their own board).
    const hiring = p.company ? await checkHiring(p.company) : undefined;
    if (!hiring?.openRoles) continue;

    // Never message anyone on the do-not-contact list or inside the
    // cross-channel recency cooldown.
    const fullName = (p.fullName || p.firstName || "").trim();
    try {
      const { checkContactable } = await import("../outreach/contactGuard");
      const dnc = await checkContactable(workspaceId,
        { email: p.email, linkedinUrl: p.linkedinUrl, fullName: fullName || undefined, company: p.company },
        { checkRecency: true });
      if (!dnc.ok) continue;
    } catch { continue; }

    const slug = slugOf(p.linkedinUrl);
    if (!slug) continue;
    const prof = await fetchProfileLite(account, slug);
    if (!prof.providerId) continue;

    // Benchmark 2: they are posting. Take their freshest real post.
    let posts: Dict[] = [];
    try { posts = listOf(await unipile.listPosts(account.providerAccountId!, prof.providerId, 3)); } catch { continue; }
    const post = posts.map((entry) => ({
      id: str(entry.social_id) ?? str(entry.share_url) ?? str(entry.url) ?? str(entry.id) ?? str(entry.post_id),
      text: (str(entry.text) ?? str(entry.commentary) ?? "").trim(),
      at: str(entry.date) ?? str(entry.parsed_datetime) ?? str(entry.created_at),
    })).find((x) => x.id && x.text.length >= 40);
    if (!post) continue;
    if (post.at) {
      const t = new Date(post.at).getTime();
      if (Number.isFinite(t) && t < Date.now() - POST_FRESH_DAYS * 86_400_000) continue;
    }

    // Open profile or already connected -> a direct message lands; otherwise
    // LinkedIn will not deliver a stranger's DM, so the same personalized
    // text is shaped as a connection note.
    const direct = prof.openProfile === true || prof.networkDistance === "DISTANCE_1";
    const persona = `${fullName || "them"}${p.title ? `, ${p.title}` : ""}${p.company ? ` at ${p.company}` : ""}`;
    const text = await draft(direct ? DM_RULES : POSTER_CONNECT_RULES,
      `THE PERSON: ${persona}. Their company has ${hiring.openRoles} open role(s)${hiring.sample.length ? ` including ${hiring.sample.join(", ")}` : ""}.\n\nTHEIR POST:\n${post.text.slice(0, 700)}\n\nWrite the ${direct ? "message" : "connection note"}.`);
    if (!text) continue;

    state.items.push({
      id: rid("licw"), workspaceId, kind: "poster",
      postId: post.id!, postExcerpt: post.text.slice(0, 700), postAt: post.at,
      commentId: "", commentText: "",
      prospectId: p.id, openProfile: prof.openProfile,
      authorProviderId: prof.providerId,
      authorName: fullName || "LinkedIn member",
      authorHeadline: prof.headline ?? [p.title, p.company].filter(Boolean).join(" at "),
      authorPublicUrl: prof.publicUrl ?? (p.linkedinUrl?.startsWith("http") ? p.linkedinUrl : `https://www.${p.linkedinUrl}`),
      networkDistance: prof.networkDistance,
      title: p.title, company: p.company,
      seniority: intel.seniority, jobFunction: intel.function,
      decisionMaker: true, peer: false, hiring, tier: "hot",
      replyStatus: "none",
      dmText: direct ? text : text.slice(0, 280), dmStatus: "suggested",
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    created++;
    save();
  }

  save();
  return created;
}

/* ------------------------------------------------------------------ */
/* Reads + actions                                                      */
/* ------------------------------------------------------------------ */

export interface CommentWatchView {
  status: CommentWatchStatus;
  lastScan?: string;
  items: CommentLeadItem[];
}

const TIER_RANK: Record<CommentTier, number> = { hot: 0, warm: 1, community: 2 };

export async function commentWatchView(workspaceId: string): Promise<CommentWatchView> {
  await hydrate();
  const status = await commentWatchStatus(workspaceId);
  const items = state.items
    .filter((i) => i.workspaceId === workspaceId)
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.createdAt.localeCompare(a.createdAt));
  return { status, lastScan: state.lastScan[workspaceId], items };
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

/** Approve the poster-lane message. Open profiles get a free direct InMail,
 *  1st-degree connections a plain message, everyone else a connection note. */
export async function approveDm(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.kind !== "poster" || item.dmStatus !== "suggested" || !item.dmText) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  const direct = item.openProfile === true || item.networkDistance === "DISTANCE_1";
  if (editedText && scrub(editedText).length >= 2) item.dmText = scrub(editedText).slice(0, direct ? 1200 : 280);

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts.find((a) => a.ownerUserId === userId) ?? accounts.find((a) => !a.ownerUserId) ?? accounts[0];
  if (!account) {
    item.dmStatus = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  const actionType = !direct ? "connect_note"
    : item.networkDistance === "DISTANCE_1" ? "message" : "inmail";
  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        fullName: item.authorName, linkedinUrl: item.authorPublicUrl,
        company: item.company, title: item.title,
        providerProfileId: item.authorProviderId, prospectId: item.prospectId,
      },
      actionType,
      payload: actionType === "connect_note"
        ? { note: item.dmText, providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl }
        : {
            text: item.dmText,
            ...(actionType === "inmail" ? { subject: `Your post: "${item.postExcerpt.split(/\s+/).slice(0, 6).join(" ")}..."` } : {}),
            providerProfileId: item.authorProviderId, linkedinUrl: item.authorPublicUrl,
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
  const workspaces = [...new Set(all.filter((a) => a.providerAccountId && a.connected !== false).map((a) => a.workspaceId))];
  for (const ws of workspaces) {
    try { await scanWorkspace(ws); } catch { /* next workspace */ }
  }
}
