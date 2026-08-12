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
 * NOTHING posts on its own: replies wait for one-tap approval in the LinkedIn
 * tab and go out through requestLinkedInAction (threaded under the commenter's
 * comment), so account caps, health and the ledger all apply. Approving a HOT
 * reply also stages a connection-note draft that unlocks 24h later, so the
 * follow-up lands after the thread exchange, not on top of it.
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
const CONNECT_DELAY_MS = 24 * 3_600_000;

export type CommentTier = "hot" | "warm" | "community";

export interface CommentLeadItem {
  id: string;
  workspaceId: string;
  /** The owner's post the comment landed on. */
  postId: string;
  postExcerpt: string;
  /** The comment itself. */
  commentId: string;
  commentText: string;
  commentAt?: string;
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
  /** Hot tier: connection-note follow-up staged when the reply is approved. */
  connectText?: string;
  connectStatus?: "suggested" | "approved" | "skipped" | "blocked";
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
  /** ws -> owner switched the listener off. */
  paused: Record<string, boolean>;
  lastScan: Record<string, string>;
}

const KEY = "linkedin_comment_watch_v1";
let state: WatchState = { items: [], seen: {}, ownProfile: {}, paused: {}, lastScan: {} };
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

const CONNECT_RULES = `You write short LinkedIn connection notes for a recruiting agency owner. The recipient recently commented on one of the owner's posts and the owner replied; this note follows that exchange a day later. The reader must never suspect a machine wrote it.
Rules:
- Max 270 characters. Two sentences at most.
- Reference the thread naturally (their take under the post), not their profile.
- No pitch, no links, no "synergies", no emoji, no long dashes, no mention of hiring or services. Connecting to continue the conversation is the whole message.
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

/** Fallback enrichment when the comment payload has no headline. */
async function fetchHeadline(account: LiAccountState, providerId: string): Promise<{ headline?: string; publicUrl?: string }> {
  try {
    const { unipileRequest } = await import("./provider");
    const p = await unipileRequest<Dict>(`/users/${encodeURIComponent(providerId)}?account_id=${account.providerAccountId}`);
    return {
      headline: str(p.headline),
      publicUrl: str(p.public_identifier) ? `https://www.linkedin.com/in/${str(p.public_identifier)}` : undefined,
    };
  } catch { return {}; }
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
        const extra = await fetchHeadline(account, c.authorProviderId);
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
      if (tier === "hot" || tier === "warm") {
        const persona = [c.authorName, title, company ? `at ${company}` : undefined].filter(Boolean).join(", ");
        const text = await draft(REPLY_RULES,
          `MY POST:\n${postExcerpt || "(no text)"}\n\nTHEIR COMMENT (by ${persona}):\n${c.text}\n\nWrite the reply.`);
        if (text) { item.replyText = text; item.replyStatus = "suggested"; }
      }

      state.items.push(item);
      created++;
      save();
    }
  }

  if (seenArr.length > SEEN_CAP) state.seen[workspaceId] = seenArr.slice(-SEEN_CAP);
  state.lastScan[workspaceId] = nowIso();
  prune();
  save();
  return { scanned, created, skipped: null };
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
 *  A HOT item also stages its connection-note follow-up, unlocked in 24h. */
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
      if (item.tier === "hot" && !item.connectStatus) {
        item.connectAfter = new Date(Date.now() + CONNECT_DELAY_MS).toISOString();
        const persona = [item.authorName, item.title, item.company ? `at ${item.company}` : undefined].filter(Boolean).join(", ");
        const note = await draft(CONNECT_RULES,
          `The person: ${persona}.\nMy post they commented under:\n${item.postExcerpt || "(no text)"}\n\nTheir comment:\n${item.commentText}\n\nWrite the connection note.`);
        if (note) { item.connectText = note; item.connectStatus = "suggested"; }
      }
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

export async function skipConnect(workspaceId: string, id: string): Promise<CommentLeadItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.connectStatus !== "suggested") return null;
  item.connectStatus = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Approve the staged connection note. Held until 24h after the reply so the
 *  follow-up lands after the exchange, not on top of it. */
export async function approveConnect(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: CommentLeadItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.connectStatus !== "suggested" || !item.connectText) {
    return { item: item ?? null, accepted: false, reason: "not_open" };
  }
  if (item.connectAfter && item.connectAfter > nowIso()) {
    return { item, accepted: false, reason: "This connect unlocks 24h after your reply, so it lands after the thread exchange." };
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
