/**
 * RecruitersOS · LinkedIn Poster (Tools > BD)
 *
 * Inspiration-to-approved-post pipeline:
 *   1. INBOX      — the recruiter saves posts they like (paste author + text).
 *   2. REWRITE    — the LLM extracts the INSIGHT and rebuilds it as a first-person
 *                   story in the recruiter's own voice (never a paraphrase).
 *   3. MEDIA      — attach one item from the approved library: an image, a PDF
 *                   (LinkedIn renders it as a swipeable document post), a short
 *                   MP4, or a branded quote card generated server-side
 *                   (SVG -> sharp -> PNG).
 *   4. APPROVAL   — nothing ever publishes without an explicit approve. Approve
 *                   posts now or schedules; the automation tick publishes when due.
 *   5. PUBLISH    — through our own LinkedIn engine first (LinkedIn OS's
 *                   Unipile connection, the tool of record for every LinkedIn
 *                   action in RecruitersOS), with Ayrshare (official LinkedIn
 *                   API partner) as an optional alternative when its key is set.
 *
 * Storage follows the house snapshot pattern (lib/db): fast in-memory maps,
 * debounced JSON snapshot, workspace-scoped. Image BYTES live as files in the
 * durable data dir (base64 in the snapshot would bloat every save); only their
 * metadata lives in the snapshot.
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { randomBytes } from "crypto";
import { loadSnapshot, debouncedSaver } from "../db";
import { anthropicClient } from "../sourcing/anthropic";
import { publishLinkedInPost, ayrshareConfigured } from "../providers/ayrshare";
import { publicBaseUrl } from "../inmarket/roleShot";

/* ------------------------------- types ---------------------------------- */

export interface InspirationItem {
  id: string;
  author: string;
  url?: string;
  text: string;
  savedAt: string;
}

export type DraftStatus = "draft" | "approved" | "posted" | "failed" | "discarded";

export interface PosterDraft {
  id: string;
  /** Where the idea came from (kept for attribution in the UI, never posted). */
  sourceId?: string;
  sourceAuthor?: string;
  /** The original post, snapshotted at rewrite time so the side-by-side
   *  compare in Drafts survives the inbox item being deleted. Never posted. */
  sourceText?: string;
  /** True when the AI wrote this from the brand/industry context alone,
   *  with no source post behind it. */
  aiOriginal?: boolean;
  /** True when the post advertises one of the workspace's open jobs
   *  (blind: the client company is never named). */
  jobSpotlight?: boolean;
  /** The job title behind a spotlight, for the UI chip only. */
  jobTitle?: string;
  /** True when the AI wrote the post around a photo the recruiter uploaded. */
  photoPost?: boolean;
  /** 2026 playbook drafts: which weekday pillar and vertical produced this
   *  (e.g. "Desk story" / "Accounting"), for the UI chips only. */
  pillar?: string;
  vertical?: string;
  /** The portal user this draft belongs to. Publishing goes out from THEIR
   *  connected LinkedIn seat, never a teammate's. Stamped at creation and,
   *  as a backstop, at approve/retry time (covers auto-generated drafts). */
  createdBy?: string;
  text: string;
  imageId?: string;
  /** Posted as the post's first comment right after publishing (links belong
   *  there, not in the body: the feed algorithm punishes external links). */
  firstComment?: string;
  firstCommentPosted?: boolean;
  /** Engagement counters pulled back from the provider after publishing. */
  stats?: { reactions?: number; comments?: number; impressions?: number; at: string };
  status: DraftStatus;
  /** ISO time to publish; unset on "post now". */
  scheduledAt?: string;
  postedAt?: string;
  postUrl?: string;
  /** Which path published it: our LinkedIn engine (Unipile) or Ayrshare. */
  provider?: "engine" | "ayrshare";
  providerPostId?: string;
  ayrsharePostId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PosterImage {
  id: string;
  name: string;
  /** File name inside the media dir (id + ext). */
  file: string;
  mime: string;
  kind: "upload" | "card";
  /** For generated carousels: the slide texts, so the UI can edit + re-render. */
  slides?: string[];
  createdAt: string;
}

export interface PosterSettings {
  /** Shown on generated quote cards. */
  displayName: string;
  /** One-liner under the name on cards (e.g. "Technical recruiter · Chicago"). */
  headline: string;
  /** Who you are + how you sound: the ghostwriter's voice contract. */
  voiceProfile: string;
  /** REAL anecdotes the rewriter may draw from. Truth rule: it never invents. */
  storyBank: string;
  /** The recruiter's brand, e.g. "Lume · lumesp.com": steers the rewriter and
   *  is stamped on generated quote cards and carousel slides. */
  brandLine: string;
  /** The market the desk serves, e.g. "ABA therapy and behavioral health
   *  staffing". Grounds original posts in the recruiter's actual industry. */
  industries: string;
  /** Hands-off mode: posts pulled from followed creators are rewritten into
   *  drafts automatically (approval still human, always). Default on. */
  autoRewrite: boolean;
  /** Posting slots for "Approve + next slot": CSV of weekday numbers (0-6,
   *  Sunday=0) and CSV of HH:MM times, interpreted in the recruiter's browser. */
  postingDays: string;
  postingTimes: string;
  /** Ayrshare user-profile key for this workspace (Business plan); blank = primary. */
  ayrshareProfileKey: string;
}

/** A LinkedIn creator the recruiter follows: every new post they publish is
 *  pulled into the inspiration inbox automatically (their archive to rewrite
 *  from). Pulls ride the same LinkedIn OS Unipile connection as publishing. */
export interface WatchedProfile {
  id: string;
  /** Display label in the UI; the inbox author for pulled posts. */
  name: string;
  /** linkedin.com/in/<identifier> public identifier. */
  identifier: string;
  addedAt: string;
  lastPulledAt?: string;
  lastError?: string;
  /** Post ids already archived, so a pull never duplicates inbox items. */
  seenPostIds: string[];
}

/** End-of-day raw material: the 2-minute voice-memo note that makes tomorrow's
 *  post impossible to mistake for AI. The playbook generator draws its one
 *  specific detail from here; it never invents one. */
export interface DeskNote {
  id: string;
  text: string;
  at: string;
}

interface WorkspaceState {
  inbox: InspirationItem[];
  drafts: PosterDraft[];
  images: PosterImage[];
  settings: PosterSettings;
  watchlist: WatchedProfile[];
  deskNotes: DeskNote[];
}

interface Store {
  workspaces: Record<string, WorkspaceState>;
}

/* ------------------------------- store ---------------------------------- */

const SNAP_KEY = "linkedin_poster";
let store: Store = { workspaces: {} };
let loaded: Promise<void> | null = null;
const persist = debouncedSaver(SNAP_KEY, () => store);

async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const snap = await loadSnapshot<Store>(SNAP_KEY);
      if (snap && snap.workspaces) store = snap;
    })();
  }
  return loaded;
}

function defaultSettings(): PosterSettings {
  return {
    displayName: "", headline: "", voiceProfile: "", storyBank: "",
    brandLine: "", industries: "", autoRewrite: true, postingDays: "", postingTimes: "",
    ayrshareProfileKey: "",
  };
}

function wsState(ws: string): WorkspaceState {
  let s = store.workspaces[ws];
  if (!s) {
    s = { inbox: [], drafts: [], images: [], settings: defaultSettings(), watchlist: [], deskNotes: [] };
    store.workspaces[ws] = s;
  }
  if (!s.settings) s.settings = defaultSettings();
  if (!s.watchlist) s.watchlist = [];
  if (!s.deskNotes) s.deskNotes = [];
  return s;
}

function rid(): string {
  return randomBytes(12).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * House rule (permanent): no em-dashes in any user-facing copy. The model is
 * told, but this is the guarantee: unicode em/en dashes become plain
 * punctuation before anything is stored or published.
 */
export function scrubDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, ", ")
    .replace(/,\s*,/g, ",");
}

/* ---------------------------- media files ------------------------------- */

function mediaDir(): string {
  if (process.env.ROS_DATA_DIR) return path.join(process.env.ROS_DATA_DIR, "linkedin-poster-media");
  if (process.env.NODE_ENV === "production") return "/data/linkedin-poster-media";
  return path.join(os.tmpdir(), "ros-poster-media");
}

async function writeMedia(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(mediaDir(), { recursive: true });
  await fs.writeFile(path.join(mediaDir(), file), bytes);
}

/** Bytes + mime for the public media route. Id-addressed, workspace-agnostic
 *  on purpose: Ayrshare fetches these URLs unauthenticated; the 24-hex id is
 *  the capability. */
export async function readMediaById(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  await ensureLoaded();
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  for (const ws of Object.values(store.workspaces)) {
    const img = ws.images.find((i) => i.id === id);
    if (img) {
      try {
        return { bytes: await fs.readFile(path.join(mediaDir(), img.file)), mime: img.mime };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function mediaUrl(id: string): string {
  return `${publicBaseUrl()}/api/linkedin/poster/media/${id}`;
}

/* ------------------------------ inbox ----------------------------------- */

export async function addInspiration(ws: string, item: { author?: string; url?: string; text: string }): Promise<InspirationItem> {
  await ensureLoaded();
  const s = wsState(ws);
  const it: InspirationItem = {
    id: rid(),
    author: (item.author ?? "").trim() || "Unknown",
    url: (item.url ?? "").trim() || undefined,
    text: item.text.trim(),
    savedAt: nowIso(),
  };
  s.inbox.unshift(it);
  if (s.inbox.length > 200) s.inbox.length = 200;
  persist();
  return it;
}

export async function deleteInspiration(ws: string, id: string): Promise<void> {
  await ensureLoaded();
  const s = wsState(ws);
  s.inbox = s.inbox.filter((i) => i.id !== id);
  persist();
}

/* ----------------------------- desk notes -------------------------------- */

export async function addDeskNote(ws: string, text: string): Promise<DeskNote> {
  await ensureLoaded();
  const s = wsState(ws);
  const t = scrubDashes(text.trim()).slice(0, 2000);
  if (!t) throw Object.assign(new Error("note_text_required"), { status: 400 });
  const n: DeskNote = { id: rid(), text: t, at: nowIso() };
  s.deskNotes.unshift(n);
  if (s.deskNotes.length > 40) s.deskNotes.length = 40;
  persist();
  return n;
}

export async function deleteDeskNote(ws: string, id: string): Promise<void> {
  await ensureLoaded();
  const s = wsState(ws);
  s.deskNotes = s.deskNotes.filter((n) => n.id !== id);
  persist();
}

/* --------------------------- 2026 playbook -------------------------------- */

/**
 * The daily content system from the LinkedIn BD playbook (built on the 2026
 * algorithm research: topic authority, the March 2026 Authenticity Update,
 * saves/sends weighing ~5x a like). Five weekday pillars; the client picks
 * pillar + vertical + topic and sends them here, so the recruiter's browser
 * timezone, not the server's, decides what day it is.
 */
const PLAYBOOK_PILLARS: Record<string, { name: string; length: string; brief: string }> = {
  market_data: {
    name: "Market data",
    length: "500-1000 characters",
    brief: "Open with the number from today's topic, then spend the post on what it means for the person trying to hire. Concrete, useful, zero fluff. The reader should be able to repeat the stat in a meeting.",
  },
  desk_story: {
    name: "Desk story",
    length: "under 600 characters",
    brief: "One anonymized story from a real search: the counteroffer, the candidate who ghosted, the offer accepted in 48 hours. Specific detail from the raw material. No neat moral at the end; let the story sit.",
  },
  playbook: {
    name: "Playbook",
    length: "800-1300 characters",
    brief: "A how-to the buyer can run without hiring anyone: fixing a 4-round interview process, writing a JD senior candidates answer, a counteroffer-proof close. Numbered steps are fine when they are genuinely steps, but vary the rhythm so the list does not read machine-parallel.",
  },
  opinion: {
    name: "Opinion",
    length: "500-1000 characters",
    brief: "A defensible contrarian take against common hiring practice. Take one side and hold it. Aim it at a specific habit (5-round processes, pedigree filters, slow sign-off chains), not at a strawman.",
  },
  human: {
    name: "Human / build-in-public",
    length: "400-900 characters",
    brief: "The week from the desk: a number, a lesson, a placement celebrated in general terms, or what went wrong and what changed. Honest and plain. This post is what makes the other four trusted.",
  },
};

/** The instant-AI-tell kill list from the playbook. Shared by every generator
 *  so no path can produce a post that trips the Authenticity Update. */
const PLAYBOOK_KILL = `NEVER USE (instant AI tells; any one of these sinks the post):
- The words: leverage, delve, landscape, foster, tapestry, unlock, elevate, game-changer, "in today's market".
- The openers: "I'm thrilled to announce", "Let me tell you a story", "Here's the thing", "Let's dive in".
- The "It's not X, it's Y" construction, and rhetorical triads ("faster, smarter, better").
- Em-dashes anywhere. Use commas or periods.
- Perfectly parallel bullet lists where every line has the same rhythm.
- A tidy moral or bow at the end of a story.
- Emoji. Hashtags (zero, always). Links in the body.`;

function playbookSystem(settings: PosterSettings, pillarKey: string, vertical: string, topic: string, notes: string): string {
  const p = PLAYBOOK_PILLARS[pillarKey];
  return `You ghostwrite ONE LinkedIn post for a recruiter doing business development in the ${vertical} hiring market. The buyers reading it are managing partners, CFOs, controllers, and HR or clinical directors. Today's post is the "${p.name}" pillar of their weekly content system.

PILLAR BRIEF: ${p.brief}

TODAY'S TOPIC (grounded in real, published 2026 market research; you may cite ONLY the figures inside it):
${topic}

THE RECRUITER'S RAW MATERIAL (real desk notes from the last few days; the best source for the one specific detail that makes the post unmistakably human):
${notes || "(none today: write from the topic's data angle plus the recruiter's point of view, WITHOUT inventing desk specifics)"}
${settings.brandLine ? `
THE BRAND: the recruiter posts on behalf of ${settings.brandLine}. Sound like a senior recruiter there. Never name other companies' brands or tools.` : ""}
THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

REAL STORY BANK (true anecdotes you may draw from; use at most one per post):
${settings.storyBank || "(none provided)"}

ABSOLUTE TRUTH RULES (non-negotiable, house rule):
- Numbers come ONLY from today's topic, the raw material, or the story bank. NEVER invent a placement, client, candidate, name, figure, or outcome.
- Anonymize everything from the desk: "a controller", "an AmLaw 200 firm", "a 3-hospital system". Never anything identifying.
- If the raw material has a relevant true detail, use exactly one. If not, stay insight-led.

STRUCTURE:
- First line is the hook: under 10 words, curiosity-gap or contrarian, works as the ONLY visible line before the fold.
- One or two lines of context, then the meat, then one takeaway.
- Line break every one or two sentences. Total length: ${p.length}.
- End with one genuine question the buyer would actually answer. No hard CTA, no promised downloads or reports.

HUMAN SIGNALS (use them):
- Contractions. Sentences that start with And or But. Varied sentence length; leave one slightly imperfect sentence alone.
- One specific, verifiable detail when the raw material provides it (a time, a number, a day of the week, a short quote).
- A named feeling where honest: annoyed, relieved, embarrassed.
- An occasional aside in parentheses is fine.

${PLAYBOOK_KILL}

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

/** One playbook post (pillar + vertical + topic chosen client-side) -> Drafts.
 *  Pulls the recruiter's latest desk notes in as raw material automatically. */
export async function createPlaybookDraft(ws: string, opts: { pillar: string; vertical?: string; topic?: string; guidance?: string; userId?: string }): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const pillarKey = PLAYBOOK_PILLARS[opts.pillar] ? opts.pillar : "opinion";
  const vertical = (opts.vertical ?? "").trim().slice(0, 60) || "professional services";
  const topic = (opts.topic ?? "").trim().slice(0, 700) || "a pattern the recruiter is seeing on their desk right now";
  const notes = s.deskNotes.slice(0, 5).map((n) => `- (${n.at.slice(0, 10)}) ${n.text}`).join("\n");

  const client = anthropicClient();
  const user = (opts.guidance?.trim() ? `EXTRA DIRECTION FROM THE RECRUITER: ${opts.guidance.trim().slice(0, 500)}\n\n` : "") + "Write the post now.";
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 1024,
    system: playbookSystem(s.settings, pillarKey, vertical, topic, notes),
    messages: [{ role: "user", content: user }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!out) throw new Error("playbook_empty");

  const draft: PosterDraft = {
    id: rid(),
    text: scrubDashes(out).slice(0, 3000),
    aiOriginal: true,
    pillar: PLAYBOOK_PILLARS[pillarKey].name,
    vertical,
    createdBy: opts.userId,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(draft);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  return draft;
}

/* --------------------------- followed creators --------------------------- */

const WATCHLIST_MAX = 15;
/** A profile is re-pulled by the automation tick once this much time passed. */
const WATCH_PULL_EVERY_MS = 20 * 60 * 60 * 1000;

function parseLinkedInIdentifier(input: string): string | null {
  const t = (input ?? "").trim();
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(t);
  if (m) return decodeURIComponent(m[1]).replace(/\/+$/, "");
  if (/^[\w\-%.]{2,120}$/.test(t)) return t;
  return null;
}

/** "-catherinejohnson" / "max-hansen-1a2b3c" -> "Catherinejohnson" / "Max Hansen".
 *  Best-effort display name when the recruiter leaves the name blank; the raw
 *  slug stays the identifier. */
function slugToName(slug: string): string {
  const words = slug
    .replace(/%[0-9a-f]{2}/gi, " ")
    .split(/[-_.\s]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^[0-9a-f]{6,}$/i.test(w));
  if (!words.length) return slug;
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return /^[A-Za-z .']{2,60}$/.test(name) ? name : slug;
}

export async function addWatchedProfile(ws: string, opts: { name?: string; url: string }): Promise<WatchedProfile> {
  await ensureLoaded();
  const s = wsState(ws);
  const identifier = parseLinkedInIdentifier(opts.url);
  if (!identifier) throw Object.assign(new Error("bad_profile: paste a linkedin.com/in/... profile link"), { status: 400 });
  if (s.watchlist.some((w) => w.identifier.toLowerCase() === identifier.toLowerCase())) {
    throw Object.assign(new Error("already_following"), { status: 400 });
  }
  if (s.watchlist.length >= WATCHLIST_MAX) {
    throw Object.assign(new Error(`watchlist_full: ${WATCHLIST_MAX} profiles max`), { status: 400 });
  }
  const w: WatchedProfile = {
    id: rid(),
    name: (opts.name ?? "").trim() || slugToName(identifier),
    identifier,
    addedAt: nowIso(),
    seenPostIds: [],
  };
  s.watchlist.unshift(w);
  persist();
  return w;
}

export async function removeWatchedProfile(ws: string, id: string): Promise<void> {
  await ensureLoaded();
  const s = wsState(ws);
  s.watchlist = s.watchlist.filter((w) => w.id !== id);
  persist();
}

/** Tolerant reading of Unipile's posts list: field names vary by API version,
 *  so probe the common shapes and keep only real, original posts with text. */
const WATCH_BACKFILL_MS = 190 * 24 * 60 * 60 * 1000; // ~6 months

function parseProviderPosts(r: unknown): Array<{ id: string; text: string; url?: string }> {
  const rec = r as { items?: unknown[]; posts?: unknown[] } | unknown[];
  const arr = Array.isArray(rec) ? rec : (Array.isArray((rec as { items?: unknown[] })?.items) ? (rec as { items: unknown[] }).items : (rec as { posts?: unknown[] })?.posts) ?? [];
  const out: Array<{ id: string; text: string; url?: string }> = [];
  for (const raw of arr) {
    const p = raw as Record<string, unknown>;
    if (!p || p.is_repost === true || p.repost_id) continue;
    const id = String(p.id ?? p.post_id ?? p.social_id ?? "").trim();
    const text = String(p.text ?? p.commentary ?? p.content ?? "").trim();
    const url = typeof p.share_url === "string" ? p.share_url : typeof p.permalink === "string" ? p.permalink : undefined;
    // Keep roughly six months of history when the provider reports a date;
    // posts without a parseable date are kept.
    const rawAt = p.parsed_datetime ?? p.created_at ?? p.date ?? p.posted_at;
    if (typeof rawAt === "string") {
      const at = Date.parse(rawAt);
      if (Number.isFinite(at) && Date.now() - at > WATCH_BACKFILL_MS) continue;
    }
    if (id && text) out.push({ id, text, url });
  }
  return out;
}

/** Pull a followed creator's recent posts into the inspiration inbox (deduped
 *  against everything already archived). Returns how many landed. */
export async function pullWatchedProfile(ws: string, id: string): Promise<{ added: number; drafted: number }> {
  await ensureLoaded();
  const s = wsState(ws);
  const w = s.watchlist.find((x) => x.id === id);
  if (!w) throw Object.assign(new Error("profile_not_found"), { status: 404 });
  const acct = await resolveReadAccount(ws);
  if (!acct) {
    throw Object.assign(new Error("engine_not_ready: connect a LinkedIn account first (JD Sourcing tab, Connect my LinkedIn)"), { status: 409 });
  }
  try {
    const { unipile } = await import("../providers");
    // First pull digs into the archive (about six months back, provider
    // permitting); later pulls just top up with what's new.
    const posts = parseProviderPosts(await unipile.listPosts(acct.providerAccountId, w.identifier, w.lastPulledAt ? 10 : 40));
    const fresh: InspirationItem[] = [];
    for (const p of posts) {
      if (w.seenPostIds.includes(p.id)) continue;
      w.seenPostIds.unshift(p.id);
      fresh.push(await addInspiration(ws, { author: w.name, url: p.url, text: p.text }));
    }
    if (w.seenPostIds.length > 200) w.seenPostIds.length = 200;
    w.lastPulledAt = nowIso();
    w.lastError = undefined;
    persist();
    // Hands-off mode: rewrite what just landed into drafts awaiting approval.
    // Capped per pull so a prolific creator can't burn the AI budget; a
    // rewrite failure (key, quota) stops quietly, the inbox items remain.
    let drafted = 0;
    if (s.settings.autoRewrite !== false && process.env.ANTHROPIC_API_KEY) {
      for (const it of fresh.slice(0, 5)) {
        try {
          const nd = await rewriteToDraft(ws, { inspirationId: it.id });
          await autoAttachCard(ws, nd.id);
          drafted += 1;
        } catch { break; }
      }
    }
    return { added: fresh.length, drafted };
  } catch (e) {
    w.lastPulledAt = nowIso();
    w.lastError = (e as Error).message;
    persist();
    throw e;
  }
}

/** Automation tick: refresh every workspace's followed creators, one profile
 *  at a time, only when its last pull is old enough. Errors stay on the
 *  profile row; one bad profile never stops the sweep. */
export async function tickWatchedProfiles(now: Date = new Date()): Promise<number> {
  await ensureLoaded();
  let pulled = 0;
  for (const [ws, s] of Object.entries(store.workspaces)) {
    if (!s.watchlist?.length) continue;
    if (!(await resolveReadAccount(ws))) continue;
    for (const w of s.watchlist) {
      const last = w.lastPulledAt ? new Date(w.lastPulledAt).getTime() : 0;
      if (now.getTime() - last < WATCH_PULL_EVERY_MS) continue;
      try {
        await pullWatchedProfile(ws, w.id);
        pulled += 1;
      } catch { /* recorded on the profile row; keep sweeping */ }
    }
  }
  return pulled;
}

/* ----------------------------- rewriter --------------------------------- */

const MODEL = () => process.env.RECRUITEROS_POSTER_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

function rewriteSystem(settings: PosterSettings): string {
  return `You ghostwrite LinkedIn posts for a recruiter. You are given a SOURCE POST someone else wrote. Your job is NOT to paraphrase it. Extract the underlying INSIGHT, discard the wording entirely, and rebuild it as a first-person post in the recruiter's own voice, so it reads as their real story and point of view.
${settings.brandLine ? `
THE BRAND: the recruiter posts on behalf of ${settings.brandLine}. Sound like a senior recruiter there: confident, credible, client-and-candidate focused. Keep every claim consistent with a recruiting firm. Never name other companies' brands or tools.
` : ""}
THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

REAL STORY BANK (true anecdotes you may draw from; use at most one per post):
${settings.storyBank || "(none provided)"}

ABSOLUTE TRUTH RULES (non-negotiable, house rule):
- NEVER fabricate a placement, a client, a candidate, a name, a number, a metric, or an outcome.
- If the story bank has a relevant TRUE story, tell it. If not, write insight-led from professional experience in general terms, without inventing specifics.
- Never imply the source post's experiences happened to the recruiter.

FORMAT RULES:
- First line is the hook: under 10 words, no clickbait, makes a scroller stop.
- Short paragraphs, 1-2 sentences each, blank line between them. 600-1300 characters total.
- End with one light question or takeaway line, not a hard CTA.
- Use contractions; vary sentence length; it should read the way the recruiter talks on the phone.
- No "I saw a post about..." framing. The idea is presented as the recruiter's own thinking.

${PLAYBOOK_KILL}

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

export async function rewriteToDraft(ws: string, opts: {
  inspirationId?: string;
  text?: string;
  author?: string;
  guidance?: string;
  userId?: string;
}): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  let sourceText = (opts.text ?? "").trim();
  let sourceAuthor = (opts.author ?? "").trim();
  let sourceId: string | undefined;
  if (opts.inspirationId) {
    const src = s.inbox.find((i) => i.id === opts.inspirationId);
    if (!src) throw Object.assign(new Error("inspiration_not_found"), { status: 404 });
    sourceText = src.text;
    sourceAuthor = src.author;
    sourceId = src.id;
  }
  if (!sourceText) throw Object.assign(new Error("source_text_required"), { status: 400 });

  const text = await generateRewrite(s.settings, sourceText, opts.guidance);
  const draft: PosterDraft = {
    id: rid(),
    sourceId,
    sourceAuthor: sourceAuthor || undefined,
    sourceText: sourceText.slice(0, 6000),
    text,
    createdBy: opts.userId,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(draft);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  return draft;
}

export async function regenerateDraft(ws: string, draftId: string, guidance?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  const src = d.sourceId ? s.inbox.find((i) => i.id === d.sourceId) : undefined;
  const sourceText = src?.text ?? d.sourceText ?? d.text;
  if (!d.sourceText && src) d.sourceText = src.text.slice(0, 6000);
  d.text = await generateRewrite(s.settings, sourceText, guidance);
  d.status = "draft";
  d.scheduledAt = undefined;
  d.error = undefined;
  d.updatedAt = nowIso();
  persist();
  return d;
}

async function generateRewrite(settings: PosterSettings, sourceText: string, guidance?: string): Promise<string> {
  const client = anthropicClient();
  const user =
    `SOURCE POST:\n"""\n${sourceText.slice(0, 6000)}\n"""\n` +
    (guidance ? `\nEXTRA DIRECTION FROM THE RECRUITER: ${guidance.slice(0, 500)}\n` : "") +
    `\nWrite the recruiter's post now.`;
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 1024,
    system: rewriteSystem(settings),
    messages: [{ role: "user", content: user }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!out) throw new Error("rewrite_empty");
  return scrubDashes(out).slice(0, 3000);
}

/* --------------------------- original posts ------------------------------ */

/** Rotating angles keep a daily original from sounding like the same post. */
const ORIGINAL_ANGLES = [
  "advice for candidates in this market: one concrete, usable insight",
  "an insight for hiring managers about what actually attracts great people",
  "a market observation recruiters see before anyone else does",
  "a common hiring myth in this industry, and the reality",
  "an opinion about the hiring process: what should change and why",
  "a lesson from the recruiting desk, told plainly",
];

function originalSystem(settings: PosterSettings, angle: string): string {
  return `You write ORIGINAL LinkedIn posts for a recruiter. There is no source post: you create the idea yourself from the recruiter's real market context below.
${settings.brandLine ? `
THE BRAND: the recruiter posts on behalf of ${settings.brandLine}. Sound like a senior recruiter there: confident, credible, client-and-candidate focused. Never name other companies' brands or tools.
` : ""}${settings.industries ? `
THE MARKET THEY SERVE (stay inside it, be specific to it):
${settings.industries}
` : ""}
TODAY'S ANGLE: ${angle}

THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

REAL STORY BANK (true anecdotes you may draw from; use at most one per post):
${settings.storyBank || "(none provided)"}

ABSOLUTE TRUTH RULES (non-negotiable, house rule):
- NEVER fabricate a placement, a client, a candidate, a name, a number, a statistic, or an outcome.
- Market commentary stays general and observational; cite NO specific figures unless they appear in the story bank.
- If the story bank has a relevant TRUE story, tell it. Otherwise write insight-led, without inventing specifics.

FORMAT RULES:
- First line is the hook: under 10 words, no clickbait, makes a scroller stop.
- Short paragraphs, 1-2 sentences each, blank line between them. 600-1300 characters total.
- End with one light question or takeaway line, not a hard CTA.
- Use contractions; vary sentence length; it should read the way the recruiter talks on the phone.

${PLAYBOOK_KILL}

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

async function generateOriginal(settings: PosterSettings, angle: string, topic?: string): Promise<string> {
  const client = anthropicClient();
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 1024,
    system: originalSystem(settings, angle),
    messages: [{ role: "user", content: topic?.trim() ? `The recruiter wants the post about: ${topic.trim().slice(0, 400)}\n\nWrite the post now.` : "Write the post now." }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!out) throw new Error("original_empty");
  return scrubDashes(out).slice(0, 3000);
}

/** Every hands-off draft ships with a creative already attached: a branded
 *  quote card cut from the hook line. One click swaps it for a carousel or a
 *  library image. Best-effort: a render hiccup never blocks the draft. */
async function autoAttachCard(ws: string, draftId: string): Promise<void> {
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d || d.imageId) return;
  const hook = (d.text.split("\n")[0] || "").trim();
  if (!hook) return;
  try {
    const img = await generateQuoteCard(ws, { headline: hook.slice(0, 140) });
    d.imageId = img.id;
    d.updatedAt = nowIso();
    persist();
  } catch { /* creative is a bonus, never a blocker */ }
}

/** One original, brand-grounded post -> Drafts, creative attached. */
export async function createOriginalDraft(ws: string, opts: { topic?: string; userId?: string }): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const angle = ORIGINAL_ANGLES[s.drafts.filter((d) => d.aiOriginal).length % ORIGINAL_ANGLES.length];
  const text = await generateOriginal(s.settings, angle, opts.topic);
  const draft: PosterDraft = {
    id: rid(),
    text,
    aiOriginal: true,
    createdBy: opts.userId,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(draft);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  await autoAttachCard(ws, draft.id);
  return draft;
}

/* ------------------------------ photo posts ------------------------------- */

function photoSystem(settings: PosterSettings, notes: string): string {
  return `You ghostwrite ONE LinkedIn post for a recruiter, built around a photo THEY took and are attaching to the post. You are shown the photo. Write the post it belongs to: the photo is the proof of a real moment, the text gives it meaning for the recruiter's market.

GROUNDING RULES (non-negotiable):
- Reference ONLY what is plainly visible in the photo. Never guess or invent names, companies, clients, locations, events, or outcomes from it.
- People in the photo stay anonymous unless the recruiter's notes below name them.
- If the photo is a document, chart, or screen, you may read figures straight off it, and ONLY those figures.
- When unsure what the photo shows, write around the moment ("this morning's desk", "notes from a search in progress") rather than making a specific claim.

THE RECRUITER'S RAW MATERIAL (real desk notes from the last few days; use at most one true detail):
${notes || "(none today)"}
${settings.brandLine ? `
THE BRAND: the recruiter posts on behalf of ${settings.brandLine}. Sound like a senior recruiter there.` : ""}
THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

STRUCTURE:
- First line is the hook: under 10 words, and it must NOT describe the photo ("A photo of..." is dead on arrival). The photo intrigues; the hook explains why it matters.
- Short lines, a line break every one or two sentences, 60 to 150 words.
- End with one genuine question the reader would actually answer. No hard CTA.

HUMAN SIGNALS (use them):
- Contractions. Sentences that start with And or But. Varied sentence length.
- A named feeling where honest: annoyed, relieved, proud, embarrassed.

${PLAYBOOK_KILL}

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

/**
 * Photo-first drafting: the recruiter uploads a real photo and the AI writes
 * the post around it (vision call), attaching that photo to the new draft.
 */
export async function createPhotoDraft(ws: string, opts: { imageId: string; guidance?: string; userId?: string }): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const img = s.images.find((i) => i.id === opts.imageId);
  if (!img) throw Object.assign(new Error("image_not_found"), { status: 404 });
  if (!img.mime.startsWith("image/")) {
    throw Object.assign(new Error("photo_only: pick a photo (PNG, JPG, or WebP); a PDF or video can't drive a written post"), { status: 400 });
  }
  const media = await readMediaById(img.id);
  if (!media) throw Object.assign(new Error("image_not_found"), { status: 404 });

  // Normalize for the vision call: JPEG, long edge capped at 1568px (the
  // model's sweet spot), which also keeps any 8MB upload under the API's
  // per-image ceiling.
  const sharp = (await import("sharp")).default;
  const prepped = await sharp(media.bytes)
    .rotate() // honor EXIF orientation from phone cameras
    .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const notes = s.deskNotes.slice(0, 5).map((n) => `- (${n.at.slice(0, 10)}) ${n.text}`).join("\n");
  const client = anthropicClient();
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 1024,
    system: photoSystem(s.settings, notes),
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: prepped.toString("base64") } },
        {
          type: "text",
          text: (opts.guidance?.trim() ? `EXTRA DIRECTION FROM THE RECRUITER: ${opts.guidance.trim().slice(0, 500)}\n\n` : "") +
            "Write the post now.",
        },
      ],
    }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!out) throw new Error("photo_post_empty");

  const draft: PosterDraft = {
    id: rid(),
    text: scrubDashes(out),
    imageId: img.id,
    photoPost: true,
    createdBy: opts.userId,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(draft);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  return draft;
}

/* ----------------------------- job spotlights ----------------------------- */

function jobSpotlightSystem(settings: PosterSettings): string {
  return `You write a LinkedIn post advertising ONE open role for a recruiter. It is a BLIND ad: the client company must stay confidential.

CONFIDENTIALITY RULES (non-negotiable):
- NEVER name the employer, the client company, or anything that identifies it (no company name, product names, office addresses, or "the only X in Y" phrasing).
- Refer to it generically: "my client", "a growing team", "a well-run practice", whatever fits the JD.
${settings.brandLine ? `- The RECRUITER'S brand may be referenced naturally: they post on behalf of ${settings.brandLine}.
` : ""}
TRUTH RULES:
- Everything about the role comes ONLY from the job description below. Do not invent perks, salary, benefits, team size, or anything else.
- Mention compensation only if the JD states it.

THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

FORMAT RULES:
- First line is the hook: under 10 words, aimed at the person who should want this job.
- Short paragraphs, 1-2 sentences each, blank line between them. 500-1100 characters total.
- Cover: what the role is, where (if stated), what makes it genuinely good (from the JD only).
- End with a simple next step: DM the recruiter or comment to hear more. No links.

${PLAYBOOK_KILL}

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

/** One open job -> a blind spotlight post in Drafts, creative attached.
 *  Rotates through open jobs so repeated posts cover the whole desk. */
export async function createJobSpotlightDraft(ws: string, userId?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const { ensureJobsReady, listJds } = await import("../jobs");
  await ensureJobsReady();
  const open = listJds(ws).filter((j) => j.status === "open" && j.text.trim());
  if (!open.length) throw Object.assign(new Error("no_open_jobs: add jobs to the Job Library first"), { status: 409 });
  const job = open[s.drafts.filter((d) => d.jobSpotlight).length % open.length];

  const client = anthropicClient();
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 1024,
    system: jobSpotlightSystem(s.settings),
    messages: [{ role: "user", content: `JOB TITLE: ${job.title}\n\nJOB DESCRIPTION:\n"""\n${job.text.slice(0, 5000)}\n"""\n\nWrite the blind spotlight post now.` }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!out) throw new Error("spotlight_empty");

  const draft: PosterDraft = {
    id: rid(),
    text: scrubDashes(out).slice(0, 3000),
    aiOriginal: true,
    jobSpotlight: true,
    jobTitle: job.title.slice(0, 80),
    createdBy: userId,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(draft);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  await autoAttachCard(ws, draft.id);
  return draft;
}

/**
 * Hands-off originals: one fresh draft per workspace per day, so the recruiter
 * always has something to approve. Alternates between a brand-grounded
 * original and a blind spotlight of an open job (when the Job Library has
 * any). Skips quietly when the drafts pile is already deep.
 */
export async function tickDailyOriginals(now: Date = new Date()): Promise<number> {
  await ensureLoaded();
  if (!process.env.ANTHROPIC_API_KEY) return 0;
  const today = now.toISOString().slice(0, 10);
  const dayNum = Math.floor(now.getTime() / 86_400_000);
  let made = 0;
  for (const [ws, s] of Object.entries(store.workspaces)) {
    const st = s.settings;
    if (!st || st.autoRewrite === false) continue;
    if (!(st.brandLine || st.industries || st.voiceProfile)) continue;
    if (s.drafts.some((d) => d.aiOriginal && d.createdAt.slice(0, 10) === today)) continue;
    if (s.drafts.filter((d) => d.status === "draft").length >= 6) continue;
    try {
      if (dayNum % 2 === 0) {
        try { await createJobSpotlightDraft(ws); } catch { await createOriginalDraft(ws, {}); }
      } else {
        await createOriginalDraft(ws, {});
      }
      made += 1;
    } catch { /* key or quota; tomorrow's tick retries */ }
  }
  return made;
}

/* ------------------------------ drafts ---------------------------------- */

export async function updateDraft(ws: string, draftId: string, patch: { text?: string; imageId?: string | null; firstComment?: string }): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  if (typeof patch.text === "string") d.text = scrubDashes(patch.text).slice(0, 3000);
  if (typeof patch.firstComment === "string") d.firstComment = scrubDashes(patch.firstComment).slice(0, 1200) || undefined;
  if (patch.imageId !== undefined) {
    if (patch.imageId && !s.images.some((i) => i.id === patch.imageId)) {
      throw Object.assign(new Error("image_not_found"), { status: 404 });
    }
    d.imageId = patch.imageId || undefined;
  }
  d.updatedAt = nowIso();
  persist();
  return d;
}

export async function discardDraft(ws: string, draftId: string): Promise<void> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) return;
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  d.status = "discarded";
  d.updatedAt = nowIso();
  persist();
}

/**
 * THE approval gate. Everything upstream is suggestion; this is the only door
 * to LinkedIn. `when` in the future schedules; absent/past publishes now.
 */
export async function approveDraft(ws: string, draftId: string, when?: string, userId?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  if (!d.text.trim()) throw Object.assign(new Error("empty_post"), { status: 400 });
  // Auto-generated drafts have no author yet: the approver claims them, so the
  // publish rides the approver's own LinkedIn seat.
  if (!d.createdBy && userId) d.createdBy = userId;

  const at = when ? new Date(when) : null;
  if (at && Number.isFinite(at.getTime()) && at.getTime() > Date.now() + 30_000) {
    d.status = "approved";
    d.scheduledAt = at.toISOString();
    d.error = undefined;
    d.updatedAt = nowIso();
    persist();
    return d;
  }
  return publishDraft(ws, d);
}

/** Un-schedule an approved post back to editable draft. */
export async function cancelSchedule(ws: string, draftId: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status !== "approved") throw Object.assign(new Error("not_scheduled"), { status: 400 });
  d.status = "draft";
  d.scheduledAt = undefined;
  d.updatedAt = nowIso();
  persist();
  return d;
}

/**
 * Can this RECRUITER publish through our own LinkedIn engine (Unipile)?
 * Ready = the Unipile key is set AND an account is resolvable for them:
 * their own per-recruiter seat first ("Connect my LinkedIn" on the JD
 * Sourcing tab), then the LinkedIn OS engine accounts store as the legacy
 * workspace fallback. Ayrshare stays as an optional official-API alternative.
 */
export interface EnginePublishStatus {
  configured: boolean;
  account: { accountId: string; displayName?: string } | null;
  ready: boolean;
}

interface PublishAccount {
  providerAccountId: string;
  displayName?: string;
}

/** The account a PUBLISH may use. Per-user: a post goes out from its author's
 *  own connected LinkedIn, never a teammate's. Null = nothing safe to use. */
async function resolvePublishAccount(ws: string, userId?: string): Promise<PublishAccount | null> {
  if (userId) {
    try {
      const { seatForUser } = await import("./seats");
      const seat = await seatForUser(ws, userId);
      if (seat && seat.status === "ok") return { providerAccountId: seat.accountId, displayName: seat.label };
    } catch { /* seats store unavailable */ }
  }
  try {
    const { listAccounts } = await import("./os/health");
    const acct = (await listAccounts(ws)).find((a) => a.providerAccountId);
    if (acct) return { providerAccountId: acct.providerAccountId as string, displayName: acct.displayName };
  } catch { /* engine store unavailable */ }
  return null;
}

/** Read-only account (watch pulls, stats): any healthy identity in the
 *  workspace will do; publishing never routes through here. */
async function resolveReadAccount(ws: string): Promise<PublishAccount | null> {
  try {
    const { unipile } = await import("../providers");
    if (!unipile.configured()) return null;
  } catch {
    return null;
  }
  const engineAcct = await resolvePublishAccount(ws);
  if (engineAcct) return engineAcct;
  try {
    const { anySeatForWorkspace } = await import("./seats");
    const seat = await anySeatForWorkspace(ws);
    if (seat) return { providerAccountId: seat.accountId, displayName: seat.label };
  } catch { /* seats store unavailable */ }
  return null;
}

export async function enginePublishStatus(ws: string, userId?: string): Promise<EnginePublishStatus> {
  try {
    const { unipile } = await import("../providers");
    const configured = unipile.configured();
    const acct = await resolvePublishAccount(ws, userId);
    return {
      configured,
      account: acct ? { accountId: acct.providerAccountId, displayName: acct.displayName } : null,
      ready: configured && !!acct,
    };
  } catch {
    return { configured: false, account: null, ready: false };
  }
}

async function publishDraft(ws: string, d: PosterDraft): Promise<PosterDraft> {
  const s = wsState(ws);
  try {
    const engine = await enginePublishStatus(ws, d.createdBy);
    if (engine.ready && engine.account) {
      // Our own pipe: the author's connected LinkedIn (their seat), or the
      // legacy LinkedIn OS engine account as the workspace fallback.
      const { unipile } = await import("../providers");
      const providerAccountId = engine.account.accountId;
      let attachments: Array<{ bytes: Buffer; mime: string; name: string }> | undefined;
      if (d.imageId) {
        const media = await readMediaById(d.imageId);
        if (media) {
          const meta = s.images.find((i) => i.id === d.imageId);
          const ext = MIME_EXT[media.mime] ?? ".jpg";
          // LinkedIn shows a document post's file name as its title, so keep
          // the library name instead of a generic "post.pdf".
          const base = (meta?.name ?? "post").replace(/\.[A-Za-z0-9]+$/, "").replace(/[^\w\- .]+/g, "").trim().slice(0, 60) || "post";
          attachments = [{ bytes: media.bytes, mime: media.mime, name: base + ext }];
        }
      }
      const r = await unipile.createPost(providerAccountId, d.text, attachments);
      if (r.dryRun) throw new Error("engine_not_configured: set UNIPILE_API_KEY");
      d.provider = "engine";
      d.providerPostId = r.id;
      d.postUrl = undefined; // the engine path doesn't return a share URL
      const fc = (d.firstComment ?? "").trim();
      if (fc && r.id) {
        // Never let a comment hiccup fail an already-published post.
        try {
          await unipile.commentOnPost(providerAccountId, r.id, fc);
          d.firstCommentPosted = true;
        } catch {
          d.firstCommentPosted = false;
        }
      }
    } else if (ayrshareConfigured()) {
      const r = await publishLinkedInPost({
        text: d.text,
        mediaUrls: d.imageId ? [mediaUrl(d.imageId)] : undefined,
        profileKey: s.settings.ayrshareProfileKey || undefined,
      });
      d.provider = "ayrshare";
      d.providerPostId = r.id || undefined;
      d.ayrsharePostId = r.id || undefined;
      d.postUrl = r.postUrl;
    } else {
      throw new Error("no_publisher: connect YOUR LinkedIn first (JD Sourcing tab, the Connect my LinkedIn button); each person's posts publish from their own account");
    }
    d.status = "posted";
    d.postedAt = nowIso();
    d.error = undefined;
  } catch (e) {
    d.status = "failed";
    d.error = (e as Error).message;
  }
  d.updatedAt = nowIso();
  persist();
  return d;
}

/** Retry a failed publish immediately. */
export async function retryDraft(ws: string, draftId: string, userId?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status !== "failed") throw Object.assign(new Error("not_failed"), { status: 400 });
  if (!d.createdBy && userId) d.createdBy = userId;
  return publishDraft(ws, d);
}

/* ------------------------------ images ---------------------------------- */

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
};

/** Unipile accepts post attachments up to 15MB (image, PDF, or video). Images
 *  keep the tighter 8MB cap; a feed photo never needs more. */
export async function uploadImage(ws: string, opts: { name?: string; dataUrl: string }): Promise<PosterImage> {
  await ensureLoaded();
  const s = wsState(ws);
  const m = /^data:(image\/(?:png|jpeg|webp)|application\/pdf|video\/mp4);base64,([A-Za-z0-9+/=]+)$/.exec(opts.dataUrl);
  if (!m) throw Object.assign(new Error("bad_media: expected a png, jpeg, webp, pdf, or mp4 data URL"), { status: 400 });
  const mime = m[1];
  const bytes = Buffer.from(m[2], "base64");
  const maxMb = mime.startsWith("image/") ? 8 : 15;
  if (bytes.length > maxMb * 1024 * 1024) throw Object.assign(new Error(`media_too_large: ${maxMb}MB max`), { status: 400 });
  const id = rid();
  const file = id + MIME_EXT[mime];
  await writeMedia(file, bytes);
  const img: PosterImage = { id, name: (opts.name ?? "image").slice(0, 80), file, mime, kind: "upload", createdAt: nowIso() };
  s.images.unshift(img);
  persist();
  return img;
}

export async function deleteImage(ws: string, id: string): Promise<void> {
  await ensureLoaded();
  const s = wsState(ws);
  const img = s.images.find((i) => i.id === id);
  if (!img) return;
  s.images = s.images.filter((i) => i.id !== id);
  for (const d of s.drafts) if (d.imageId === id && d.status !== "posted") d.imageId = undefined;
  persist();
  try { await fs.unlink(path.join(mediaDir(), img.file)); } catch { /* already gone */ }
}

/* --------------------------- quote cards -------------------------------- */

function escXml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Greedy word-wrap for the SVG headline (no text measurement in libvips). */
function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length + cur.length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, "") + "…";
  }
  return lines;
}

/**
 * Meridian-styled 1080x1080 quote card: solid surfaces, one accent, no
 * gradients. Rendered to PNG with sharp and saved into the approved library.
 */
export async function generateQuoteCard(ws: string, opts: { headline: string }): Promise<PosterImage> {
  await ensureLoaded();
  const s = wsState(ws);
  const headline = scrubDashes(opts.headline.trim()).slice(0, 220);
  if (!headline) throw Object.assign(new Error("headline_required"), { status: 400 });

  const size = 1080;
  const fontSize = headline.length > 120 ? 52 : headline.length > 70 ? 60 : 68;
  const maxChars = Math.floor((size - 200) / (fontSize * 0.52));
  const lines = wrapLines(headline, maxChars, 7);
  const lineH = Math.round(fontSize * 1.28);
  const blockH = lines.length * lineH;
  const startY = Math.round((size - blockH) / 2 - 40 + fontSize);

  const name = escXml(s.settings.displayName || "");
  const headlineSub = escXml(s.settings.headline || "");
  const tspans = lines
    .map((l, i) => `<tspan x="100" y="${startY + i * lineH}">${escXml(l)}</tspan>`)
    .join("");

  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#f7f8fa"/>
  <rect x="40" y="40" width="${size - 80}" height="${size - 80}" rx="24" fill="#ffffff" stroke="#e5e8ee" stroke-width="2"/>
  <rect x="100" y="${startY - fontSize - 46}" width="76" height="10" rx="5" fill="#2e5bd7"/>
  <text font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#14181f" letter-spacing="-1">${tspans}</text>
  ${name ? `<text x="100" y="${size - 150}" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="700" fill="#14181f">${name}</text>` : ""}
  ${headlineSub ? `<text x="100" y="${size - 104}" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="27" fill="#4b5364">${headlineSub}</text>` : ""}
  ${s.settings.brandLine ? `<text x="${size - 100}" y="${size - 104}" text-anchor="end" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="600" fill="#2e5bd7">${escXml(s.settings.brandLine)}</text>` : ""}
  <rect x="100" y="${size - 190}" width="46" height="6" rx="3" fill="#2e5bd7"/>
</svg>`;

  const sharp = (await import("sharp")).default;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const id = rid();
  const file = id + ".png";
  await writeMedia(file, bytes);
  const img: PosterImage = {
    id, file, mime: "image/png", kind: "card",
    name: ("Card: " + headline).slice(0, 80),
    createdAt: nowIso(),
  };
  s.images.unshift(img);
  persist();
  return img;
}

/* ------------------------------ carousels -------------------------------- */

const CAROUSEL_SYSTEM = `You turn ONE LinkedIn post by a recruiter into a swipeable carousel. Use ONLY what the post says; never add facts, numbers, names, or claims that are not in it.

Rules:
- 5 to 7 slides. Slide 1 is the hook: under 10 words, pulled from the post's core idea.
- Middle slides: one idea each, under 220 characters, plain confident sentences.
- Last slide: the post's takeaway or closing question. Nothing invented.
- NO em-dashes. No emoji. No hashtags.

Return ONLY a JSON array of strings, one string per slide. No other text.`;

async function generateSlides(sourceText: string): Promise<string[]> {
  const client = anthropicClient();
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 900,
    system: CAROUSEL_SYSTEM,
    messages: [{ role: "user", content: sourceText.slice(0, 4000) }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const start = out.indexOf("["), end = out.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("carousel_parse");
  const arr = JSON.parse(out.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("carousel_parse");
  const slides = arr
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => scrubDashes(x.trim()).slice(0, 240));
  if (slides.length < 2 || slides.length > 10) throw new Error("carousel_parse");
  return slides;
}

/** No-AI fallback: hook = first line, then sentences grouped into slides. */
function splitSlidesNaive(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hook = paras.shift() ?? text.slice(0, 120);
  const slides = [hook.slice(0, 220)];
  let cur = "";
  for (const p of paras) {
    if ((cur + " " + p).trim().length > 220) {
      if (cur) slides.push(cur);
      cur = p.slice(0, 220);
    } else {
      cur = (cur + " " + p).trim();
    }
  }
  if (cur) slides.push(cur);
  if (slides.length < 2) {
    const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
    slides.length = 0;
    let acc = "";
    for (const sn of sentences) {
      if ((acc + " " + sn).trim().length > 200 && acc) { slides.push(acc); acc = sn; }
      else acc = (acc + " " + sn).trim();
    }
    if (acc) slides.push(acc);
  }
  return slides.slice(0, 7);
}

function slideSvg(text: string, index: number, total: number, settings: PosterSettings): string {
  const size = 1080;
  const isHook = index === 0;
  const fs = isHook ? (text.length > 60 ? 62 : 74) : text.length > 160 ? 46 : text.length > 90 ? 54 : 62;
  const maxChars = Math.floor((size - 200) / (fs * 0.52));
  const lines = wrapLines(text, maxChars, 8);
  const lineH = Math.round(fs * 1.3);
  const startY = Math.round((size - lines.length * lineH) / 2 - 20 + fs);
  const name = escXml(settings.displayName || "");
  const byline = escXml(settings.headline || "");
  const brand = escXml(settings.brandLine || "");
  const tspans = lines
    .map((l, i) => `<tspan x="100" y="${startY + i * lineH}">${escXml(l)}</tspan>`)
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#f7f8fa"/>
  <rect x="40" y="40" width="${size - 80}" height="${size - 80}" rx="24" fill="#ffffff" stroke="#e5e8ee" stroke-width="2"/>
  <rect x="100" y="${startY - fs - 46}" width="76" height="10" rx="5" fill="#2e5bd7"/>
  <text font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="${fs}" font-weight="${isHook ? 700 : 600}" fill="#14181f" letter-spacing="-1">${tspans}</text>
  ${name ? `<text x="100" y="${size - 150}" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="32" font-weight="700" fill="#14181f">${name}</text>` : ""}
  ${byline ? `<text x="100" y="${size - 106}" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="26" fill="#4b5364">${byline}</text>` : ""}
  ${brand ? `<text x="${size - 100}" y="${size - 106}" text-anchor="end" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="600" fill="#2e5bd7">${brand}</text>` : ""}
  <text x="${size - 100}" y="${size - 150}" text-anchor="end" font-family="FreeSans, DejaVu Sans, Arial, sans-serif" font-size="26" fill="#8a93a5">${index + 1} / ${total}</text>
</svg>`;
}

/**
 * Turn a draft into a LinkedIn document post: split it into slides (AI when
 * available, structural fallback otherwise), render each as a branded Meridian
 * slide, assemble the PDF, save it to the library, and attach it to the draft.
 */
export async function generateCarousel(ws: string, opts: { draftId: string; slides?: string[] }): Promise<{ image: PosterImage; slides: string[] }> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === opts.draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (!d.text.trim()) throw Object.assign(new Error("empty_post"), { status: 400 });

  // Explicit slides (the UI's slide editor re-rendering) skip the AI split.
  let slides: string[] | null = (opts.slides ?? [])
    .map((x) => scrubDashes(String(x).trim()).slice(0, 240))
    .filter(Boolean)
    .slice(0, 10);
  if (slides.length < 2) slides = null;
  if (!slides && process.env.ANTHROPIC_API_KEY) {
    try { slides = await generateSlides(d.text); } catch { slides = null; }
  }
  if (!slides) slides = splitSlidesNaive(d.text);

  const sharp = (await import("sharp")).default;
  const { jpegsToPdf } = await import("./carouselPdf");
  const jpegs = [];
  for (let i = 0; i < slides.length; i++) {
    jpegs.push({
      bytes: await sharp(Buffer.from(slideSvg(slides[i], i, slides.length, s.settings))).jpeg({ quality: 92 }).toBuffer(),
      width: 1080,
      height: 1080,
    });
  }
  const pdf = jpegsToPdf(jpegs);
  const id = rid();
  const file = id + ".pdf";
  await writeMedia(file, pdf);
  const img: PosterImage = {
    id, file, mime: "application/pdf", kind: "card",
    name: ("Carousel: " + slides[0]).slice(0, 80),
    slides,
    createdAt: nowIso(),
  };
  s.images.unshift(img);
  d.imageId = id;
  d.updatedAt = nowIso();
  persist();
  return { image: img, slides };
}

/* ----------------------------- AI stat media ------------------------------ */

const STAT_MEDIA_SYSTEM = `You design the data graphic for ONE LinkedIn post by a recruiter. Extract ONLY numbers and claims that are literally in the post. Never invent, estimate, round differently, or add outside facts. No em-dashes anywhere.

Return ONLY a JSON object:
{
  "kicker": string,
  "headline": string,
  "hero": { "value": string, "label": string } | null,
  "bars": [ { "label": string, "display": string, "amount": number } ],
  "gap": string | null,
  "source": string | null
}

Field rules:
- kicker: a 2 to 5 word section label for the top of the card, <= 34 characters, plain words (it is rendered uppercase).
- headline: the post's sharpest claim in its own words, <= 90 characters.
- hero: the single most striking number, e.g. {"value":"-30%","label":"CPA exam participation since 2016"}. value <= 8 characters including sign and unit; label <= 70 characters. null when the post has no standout number.
- bars: 0, 2, or 3 quantities from the post that share a unit and are worth comparing, largest story first. label <= 34 characters; display is the formatted figure exactly as the post gives it (e.g. "124,200"); amount is its plain numeric value. Use [] when the post has no comparable pair. Never repeat the hero number as a bar unless it is one side of the comparison.
- gap: <= 44 characters naming the difference the bars expose (e.g. "69,000 people short every year"), ONLY if the post states or directly implies it. Otherwise null.
- source: <= 70 characters of attribution ONLY if the post names a source. Otherwise null.

No other text before or after the JSON.`;

interface StatMediaSpec {
  kicker: string;
  headline: string;
  hero: { value: string; label: string } | null;
  bars: { label: string; display: string; amount: number }[];
  gap: string | null;
  source: string | null;
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === "string" ? scrubDashes(v.trim()).slice(0, max) : "";
}

async function generateStatSpec(text: string): Promise<StatMediaSpec> {
  const client = anthropicClient();
  const msg = await client.messages.create({
    model: MODEL(),
    max_tokens: 700,
    system: STAT_MEDIA_SYSTEM,
    messages: [{ role: "user", content: text.slice(0, 4000) }],
  });
  const out = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const start = out.indexOf("{"), end = out.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("stat_media_parse");
  const raw = JSON.parse(out.slice(start, end + 1));
  const headline = cleanStr(raw.headline, 90);
  if (!headline) throw new Error("stat_media_parse");
  const hero = raw.hero && cleanStr(raw.hero.value, 8) && cleanStr(raw.hero.label, 70)
    ? { value: cleanStr(raw.hero.value, 8), label: cleanStr(raw.hero.label, 70) }
    : null;
  let bars = (Array.isArray(raw.bars) ? raw.bars : [])
    .map((b: any) => ({ label: cleanStr(b?.label, 34), display: cleanStr(b?.display, 12), amount: Number(b?.amount) }))
    .filter((b: { label: string; display: string; amount: number }) => b.label && b.display && Number.isFinite(b.amount) && b.amount > 0)
    .slice(0, 3);
  if (bars.length < 2) bars = [];
  return {
    kicker: cleanStr(raw.kicker, 34) || "THE MARKET RIGHT NOW",
    headline,
    hero,
    bars,
    gap: bars.length ? cleanStr(raw.gap, 44) || null : null,
    source: cleanStr(raw.source, 70) || null,
  };
}

/** No-AI fallback: a clean headline card from the draft's own first line. */
function statSpecNaive(text: string): StatMediaSpec {
  const firstLine = (text.split(/\n/).map((l) => l.trim()).filter(Boolean)[0] ?? text).slice(0, 90);
  return { kicker: "THE MARKET RIGHT NOW", headline: scrubDashes(firstLine), hero: null, bars: [], gap: null, source: null };
}

/** Bar with a square baseline (left) and 8px-rounded data end (right). */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(8, w / 2);
  return `M${x} ${y} h${w - r} a${r} ${r} 0 0 1 ${r} ${r} v${h - 2 * r} a${r} ${r} 0 0 1 -${r} ${r} h-${w - r} Z`;
}

/**
 * 1200x1500 (4:5 portrait, LinkedIn's tallest feed crop) stat card: light
 * surface, ink text, single blue ramp for the bars, red reserved for a
 * negative hero. Sections are optional and the layout reflows around them.
 */
function statMediaSvg(spec: StatMediaSpec): string {
  const W = 1200, H = 1500, M = 96;
  const FONT = "FreeSans, DejaVu Sans, Arial, sans-serif";
  const INK = "#0b0b0b", SECONDARY = "#52514e", MUTED = "#898781";
  const HAIRLINE = "#e1e0d9", BRACKET = "#c3c2b7", BLUE = "#2a78d6", RED = "#d03b3b";
  // One blue ramp, darkest first: 2 bars use the far-apart validated pair,
  // 3 bars insert the middle step between them.
  const RAMP = spec.bars.length === 2 ? ["#2a78d6", "#86b6ef"] : ["#2a78d6", "#5598e7", "#86b6ef"];
  const parts: string[] = [];
  let y = 150;

  parts.push(`<rect x="${M}" y="${y - 10}" width="52" height="7" rx="3.5" fill="${BLUE}"/>`);
  parts.push(`<text x="${M + 72}" y="${y}" font-family="${FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="${MUTED}">${escXml(spec.kicker.toUpperCase())}</text>`);
  y += 84;

  const hFs = spec.headline.length > 60 ? 58 : 66;
  const hLines = wrapLines(spec.headline, Math.floor((W - 2 * M) / (hFs * 0.5)), 3);
  const hLineH = Math.round(hFs * 1.18);
  for (const l of hLines) {
    parts.push(`<text x="${M}" y="${y}" font-family="${FONT}" font-size="${hFs}" font-weight="800" letter-spacing="-1" fill="${INK}">${escXml(l)}</text>`);
    y += hLineH;
  }
  y += 40;

  if (spec.hero) {
    const negative = /^[-−↓]/.test(spec.hero.value);
    const heroFs = 175;
    const heroW = Math.round(spec.hero.value.length * heroFs * 0.58) + 30;
    parts.push(`<text x="${M}" y="${y + heroFs * 0.78}" font-family="${FONT}" font-size="${heroFs}" font-weight="800" letter-spacing="-4" fill="${negative ? RED : BLUE}">${escXml(spec.hero.value)}</text>`);
    if (heroW <= 560) {
      // Label beside the number.
      let ly = y + 60;
      for (const l of wrapLines(spec.hero.label, 26, 3)) {
        parts.push(`<text x="${M + heroW}" y="${ly}" font-family="${FONT}" font-size="31" fill="${SECONDARY}">${escXml(l)}</text>`);
        ly += 42;
      }
      y += heroFs + 46;
    } else {
      // Wide number: the label drops below it so nothing runs off the edge.
      let ly = y + heroFs + 34;
      const labLines = wrapLines(spec.hero.label, 64, 2);
      for (const l of labLines) {
        parts.push(`<text x="${M}" y="${ly}" font-family="${FONT}" font-size="31" fill="${SECONDARY}">${escXml(l)}</text>`);
        ly += 42;
      }
      y += heroFs + 34 + labLines.length * 42 + 12;
    }
  }

  if (spec.bars.length) {
    parts.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="1" fill="${HAIRLINE}"/>`);
    y += 78;
    const maxAmount = Math.max(...spec.bars.map((b) => b.amount));
    const maxW = W - 2 * M - 220; // room for the value at the tip
    const ends: number[] = [];
    for (let i = 0; i < spec.bars.length; i++) {
      const b = spec.bars[i];
      const w = Math.max(14, Math.round((b.amount / maxAmount) * maxW));
      ends.push(w);
      parts.push(`<text x="${M}" y="${y}" font-family="${FONT}" font-size="30" fill="${SECONDARY}">${escXml(b.label)}</text>`);
      y += 22;
      parts.push(`<path d="${barPath(M, y, w, 40)}" fill="${RAMP[i]}"/>`);
      parts.push(`<text x="${M + w + 22}" y="${y + 31}" font-family="${FONT}" font-size="33" font-weight="700" fill="${INK}">${escXml(b.display)}</text>`);
      y += 84;
    }
    if (spec.gap && spec.bars.length === 2 && ends[0] - ends[1] > 120) {
      const x0 = M + Math.min(ends[0], ends[1]), x1 = M + Math.max(ends[0], ends[1]);
      parts.push(`<path d="M${x0} ${y - 20} v14 h${x1 - x0} v-14" stroke="${BRACKET}" stroke-width="1.5" fill="none"/>`);
      parts.push(`<text x="${(x0 + x1) / 2}" y="${y + 40}" text-anchor="middle" font-family="${FONT}" font-size="31" font-weight="700" fill="${INK}">${escXml(spec.gap)}</text>`);
      y += 76;
    } else if (spec.gap) {
      parts.push(`<text x="${M}" y="${y + 10}" font-family="${FONT}" font-size="31" font-weight="700" fill="${INK}">${escXml(spec.gap)}</text>`);
      y += 56;
    }
  }

  // Sparse cards drift toward the optical center; dense cards stay put. The
  // source line is pinned to the bottom edge outside the centering group.
  const shift = Math.max(0, Math.floor((H - 130 - y) / 2) - 60);
  const source = spec.source
    ? `<text x="${M}" y="${H - 76}" font-family="${FONT}" font-size="21" fill="${MUTED}">${escXml(spec.source)}</text>`
    : "";
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>` +
    `<g transform="translate(0 ${shift})">${parts.join("\n")}</g>${source}</svg>`;
}

/**
 * "Create media for me": read the draft, extract its own numbers (AI when
 * available, headline-only fallback otherwise), render the stat card, save it
 * to the library, and attach it to the draft for approval.
 */
export async function generateStatMedia(ws: string, opts: { draftId: string }): Promise<{ image: PosterImage; draft: PosterDraft }> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === opts.draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (!d.text.trim()) throw Object.assign(new Error("empty_post"), { status: 400 });

  let spec: StatMediaSpec | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try { spec = await generateStatSpec(d.text); } catch { spec = null; }
  }
  if (!spec) spec = statSpecNaive(d.text);

  const sharp = (await import("sharp")).default;
  const bytes = await sharp(Buffer.from(statMediaSvg(spec))).png().toBuffer();
  const id = rid();
  const file = id + ".png";
  await writeMedia(file, bytes);
  const img: PosterImage = {
    id, file, mime: "image/png", kind: "card",
    name: ("AI media: " + spec.headline).slice(0, 80),
    createdAt: nowIso(),
  };
  s.images.unshift(img);
  d.imageId = id;
  d.updatedAt = nowIso();
  persist();
  return { image: img, draft: d };
}

/* --------------------------- reuse + performance -------------------------- */

/** Evergreen recycling: copy a posted (or any) draft back into Drafts. */
export async function duplicateDraft(ws: string, draftId: string, userId?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  const nd: PosterDraft = {
    id: rid(),
    sourceId: d.sourceId,
    sourceAuthor: d.sourceAuthor,
    sourceText: d.sourceText,
    text: d.text,
    createdBy: userId ?? d.createdBy,
    imageId: d.imageId && s.images.some((i) => i.id === d.imageId) ? d.imageId : undefined,
    firstComment: d.firstComment,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  s.drafts.unshift(nd);
  if (s.drafts.length > 300) s.drafts.length = 300;
  persist();
  return nd;
}

const STATS_FRESH_MS = 6 * 60 * 60 * 1000;
const STATS_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

function num(p: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Pull engagement counters for recent engine-published posts. `force` skips
 *  the freshness gate (the manual "Refresh performance" button). */
export async function refreshPostStats(ws: string, force = false): Promise<number> {
  await ensureLoaded();
  const s = wsState(ws);
  const acct = await resolveReadAccount(ws);
  if (!acct) {
    throw Object.assign(new Error("engine_not_ready: connect a LinkedIn account first (JD Sourcing tab, Connect my LinkedIn)"), { status: 409 });
  }
  const { unipile } = await import("../providers");
  const now = Date.now();
  const targets = s.drafts.filter((d) =>
    d.status === "posted" && d.provider === "engine" && d.providerPostId &&
    d.postedAt && now - new Date(d.postedAt).getTime() < STATS_WINDOW_MS &&
    (force || !d.stats || now - new Date(d.stats.at).getTime() > STATS_FRESH_MS),
  ).slice(0, 20);
  let updated = 0;
  for (const d of targets) {
    try {
      const p = (await unipile.getPost(acct.providerAccountId, d.providerPostId as string)) as Record<string, unknown>;
      const reactions = num(p, "reaction_counter", "reactions_count", "like_count", "num_likes");
      const comments = num(p, "comment_counter", "comments_count", "num_comments");
      const impressions = num(p, "impression_counter", "impressions_count", "view_count");
      if (reactions !== undefined || comments !== undefined || impressions !== undefined) {
        d.stats = { reactions, comments, impressions, at: nowIso() };
        d.updatedAt = nowIso();
        updated += 1;
      }
    } catch { /* one post's counters; keep going */ }
  }
  if (updated) persist();
  return updated;
}

/** Automation sweep: refresh counters everywhere the engine is connected. */
export async function tickAllPostStats(): Promise<number> {
  await ensureLoaded();
  let updated = 0;
  for (const ws of Object.keys(store.workspaces)) {
    try { updated += await refreshPostStats(ws, false); } catch { /* engine not ready */ }
  }
  return updated;
}

/* ----------------------------- settings --------------------------------- */

export async function getSettings(ws: string): Promise<PosterSettings> {
  await ensureLoaded();
  return wsState(ws).settings;
}

export async function saveSettings(ws: string, patch: Partial<PosterSettings>): Promise<PosterSettings> {
  await ensureLoaded();
  const s = wsState(ws);
  const clean = (v: unknown, max: number) => (typeof v === "string" ? scrubDashes(v).slice(0, max) : undefined);
  const next: PosterSettings = {
    displayName: clean(patch.displayName, 80) ?? s.settings.displayName,
    headline: clean(patch.headline, 120) ?? s.settings.headline,
    voiceProfile: clean(patch.voiceProfile, 4000) ?? s.settings.voiceProfile,
    storyBank: clean(patch.storyBank, 8000) ?? s.settings.storyBank,
    brandLine: clean(patch.brandLine, 80) ?? s.settings.brandLine ?? "",
    industries: clean(patch.industries, 500) ?? s.settings.industries ?? "",
    autoRewrite: typeof patch.autoRewrite === "boolean" ? patch.autoRewrite : s.settings.autoRewrite !== false,
    postingDays: clean(patch.postingDays, 40) ?? s.settings.postingDays ?? "",
    postingTimes: clean(patch.postingTimes, 60) ?? s.settings.postingTimes ?? "",
    ayrshareProfileKey: typeof patch.ayrshareProfileKey === "string" ? patch.ayrshareProfileKey.trim().slice(0, 120) : s.settings.ayrshareProfileKey,
  };
  s.settings = next;
  persist();
  return next;
}

/* ------------------------------- reads ---------------------------------- */

export interface PosterState {
  inbox: InspirationItem[];
  drafts: PosterDraft[];
  images: PosterImage[];
  settings: PosterSettings;
  watchlist: WatchedProfile[];
  deskNotes: DeskNote[];
}

export async function getState(ws: string): Promise<PosterState> {
  await ensureLoaded();
  const s = wsState(ws);
  return {
    inbox: s.inbox,
    drafts: s.drafts.filter((d) => d.status !== "discarded"),
    images: s.images,
    settings: s.settings,
    watchlist: s.watchlist,
    deskNotes: s.deskNotes,
  };
}

/* ---------------------------- scheduler tick ----------------------------- */

/**
 * Publish every approved post whose time has come. Wired into the automation
 * scheduler (lib/automation/scheduler.ts); also safe to call ad hoc.
 */
export async function tickDuePosts(now: Date = new Date()): Promise<number> {
  await ensureLoaded();
  let published = 0;
  for (const [ws, s] of Object.entries(store.workspaces)) {
    for (const d of s.drafts) {
      if (d.status !== "approved" || !d.scheduledAt) continue;
      if (new Date(d.scheduledAt).getTime() > now.getTime()) continue;
      try {
        await publishDraft(ws, d);
        published += 1;
      } catch { /* recorded on the draft as failed; never stop the tick */ }
    }
  }
  return published;
}
