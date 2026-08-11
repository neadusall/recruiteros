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
import { searchStockPhotos, generateAiPhoto, type StockPhoto } from "./photoEngine";

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
  /** True when autopilot approved and scheduled this post itself. */
  autopilot?: boolean;
  /** The recruiter canceled an autopilot schedule: that is a veto, so
   *  autopilot leaves this draft alone and posts nothing that day. */
  autopilotHeld?: boolean;
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
  /** Which stat-card look this draft last rendered. Seeded from the draft id
   *  so sibling drafts don't match; each "Create media for me" click walks to
   *  the next look, cycling layouts and light/dark tones. */
  mediaVariant?: number;
  /** The extracted numbers behind the card, cached so cycling looks does not
   *  re-spend an AI call. Invalidated when the text it was cut from changes. */
  mediaSpec?: StatMediaSpec;
  mediaSpecFor?: string;
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
  kind: "upload" | "card" | "stock";
  /** For generated carousels: the slide texts, so the UI can edit + re-render. */
  slides?: string[];
  /** Stock photos: provider dedupe key, e.g. "pexels:12345". */
  providerId?: string;
  /** Credit line required by the photo's license; baked onto composites. */
  credit?: string;
  /** Source page for the photo (human reference, shown in the library). */
  link?: string;
  /** The search that brought this photo in; matches it to future drafts. */
  query?: string;
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
  /** Full hands-off mode: the tool creates the day's post, quality-gates it,
   *  schedules it into the posting slots, and publishes it from the enabling
   *  user's own LinkedIn seat. Canceling a queued autopilot post vetoes that
   *  day. Off by default; the classic approve flow is untouched. */
  autopilot?: boolean;
  /** Whose LinkedIn seat autopilot publishes from: stamped server-side with
   *  the user who switched it on, never client-supplied. */
  autopilotUserId?: string;
  /** IANA timezone the posting slots are written in (captured from the
   *  browser on save, e.g. "America/Chicago"); autopilot schedules with it. */
  timezone?: string;
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
  /** What autopilot last did (or why it held), surfaced in the UI so a quiet
   *  day is always explained: nothing fails or skips silently. */
  autopilotNote?: { at: string; note: string };
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
  await autoAttachCard(ws, draft.id);
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
          await rewriteToDraft(ws, { inspirationId: it.id });
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
  await autoAttachCard(ws, draft.id);
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
  // The graphic tracks the words: a regenerated post refreshes its auto card
  // so the stat never goes stale. Uploaded photos and carousels stay put.
  const att = d.imageId ? s.images.find((i) => i.id === d.imageId) : undefined;
  if (!att || (att.kind === "card" && att.mime === "image/png")) {
    d.imageId = undefined;
    await autoAttachCard(ws, d.id);
  }
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

/** Every draft ships with a creative already attached: the dynamic stat card
 *  built from the post's own numbers (same renderer as "Create media for me";
 *  headline-only when no AI key). Falls back to the branded quote card if the
 *  stat render hiccups. Best-effort: a media failure never blocks the draft. */
async function autoAttachCard(ws: string, draftId: string): Promise<void> {
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d || d.imageId) return;
  try {
    const spec = await draftStatSpec(d);
    d.mediaVariant = d.mediaVariant ?? cardSeed(d.id);
    // Hands-off drafts lead with a real photo look when one is available.
    const img = await renderStatCard(ws, spec, d.mediaVariant, { preferPhoto: true });
    d.imageId = img.id;
    d.updatedAt = nowIso();
    persist();
    return;
  } catch { /* fall through to the quote card */ }
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

/* ------------------------------ autopilot -------------------------------- */

/** Wall-clock time in an IANA zone -> Date, two-pass offset correction. */
function zonedDate(tz: string, y: number, mo: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const asTz = (t: number) => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(t)).reduce<Record<string, string>>((m, x) => (m[x.type] = x.value, m), {});
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) === 24 ? 0 : Number(p.hour), Number(p.minute));
  };
  return new Date(guess - (asTz(guess) - guess));
}

function tzParts(tz: string, at: Date): { y: number; mo: number; d: number; weekday: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(at).reduce<Record<string, string>>((m, x) => (m[x.type] = x.value, m), {});
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), weekday: wd };
}

/** YYYY-MM-DD of an instant in the workspace's zone (posting-day bookkeeping). */
function tzDayKey(tz: string, at: Date): string {
  const p = tzParts(tz, at);
  return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}

/** Best-practice floor for a post that goes out with nobody proofreading it.
 *  Returns the reason it is not fit to publish, or null when clean. */
function autopilotUnfit(text: string): string | null {
  const t = (text || "").trim();
  if (t.length < 180) return "too short";
  if (t.length > 1600) return "too long for a feed post";
  if (/https?:\/\//i.test(t)) return "link in the body";
  if (/(^|\s)#\w/.test(t)) return "hashtag in the body";
  const hook = t.split(/\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  if (hook.split(/\s+/).length > 14) return "hook runs long";
  return null;
}

function apNote(s: WorkspaceState, note: string): void {
  s.autopilotNote = { at: nowIso(), note };
  persist();
}

/**
 * Full hands-off mode. Every run (half-hourly): for each workspace with
 * autopilot on, make sure today's slot (in the desk's own timezone) has a
 * post: pick the best existing clean draft, or write a fresh one, attach
 * media (creation paths do that), and approve it into the slot on the
 * enabling user's seat. tickDuePosts does the actual publish at the minute.
 * A canceled autopilot schedule is a veto: that day posts nothing.
 */
export async function tickAutopilot(now: Date = new Date()): Promise<number> {
  await ensureLoaded();
  let queued = 0;
  for (const [ws, s] of Object.entries(store.workspaces)) {
    const st = s.settings;
    if (!st?.autopilot || !st.autopilotUserId) continue;
    try {
      const tz = st.timezone || "America/Chicago";
      const days = String(st.postingDays || "").split(",").map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6);
      const time = String(st.postingTimes || "").split(",")[0]?.trim() || "07:45";
      const [hh, mm] = time.split(":").map((x) => parseInt(x, 10));
      if (!days.length || !Number.isFinite(hh)) { apNote(s, "Holding: no posting schedule saved in Settings."); continue; }
      const today = tzParts(tz, now);
      if (!days.includes(today.weekday)) continue; // rest day by design
      const slot = zonedDate(tz, today.y, today.mo, today.d, hh, mm || 0);
      // Late is fine within 3 hours of the slot; later than that reads as
      // erratic, so the day is skipped rather than posted at odd hours.
      if (now.getTime() > slot.getTime() + 3 * 3600_000) continue;
      const todayKey = tzDayKey(tz, now);
      const handled = s.drafts.some((d) =>
        (d.status === "posted" && d.postedAt && tzDayKey(tz, new Date(d.postedAt)) === todayKey) ||
        (d.status === "approved" && d.scheduledAt && tzDayKey(tz, new Date(d.scheduledAt)) === todayKey));
      if (handled) continue;
      if (s.drafts.some((d) => d.autopilotHeld && tzDayKey(tz, new Date(d.updatedAt)) === todayKey)) {
        apNote(s, "Holding today: you canceled the queued post, so nothing else goes out.");
        continue;
      }
      // Freshest clean draft wins: playbook > watch rewrite > original > rest.
      const rank = (d: PosterDraft) => (d.pillar ? 3 : d.sourceId || d.sourceText ? 2 : d.aiOriginal ? 1 : 0);
      const fresh = now.getTime() - 72 * 3600_000;
      let pick = s.drafts
        .filter((d) => d.status === "draft" && !d.autopilotHeld && !autopilotUnfit(d.text) &&
          new Date(d.createdAt).getTime() > fresh)
        .sort((a, b) => rank(b) - rank(a) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (!pick) {
        if (!process.env.ANTHROPIC_API_KEY) { apNote(s, "Holding: the AI writer is not enabled on the server."); continue; }
        try {
          const dayNum = Math.floor(now.getTime() / 86_400_000);
          if (dayNum % 2 === 0) {
            try { pick = await createJobSpotlightDraft(ws); } catch { pick = await createOriginalDraft(ws, {}); }
          } else {
            pick = await createOriginalDraft(ws, {});
          }
        } catch {
          apNote(s, "Holding: writing today's post failed; will retry within the half hour.");
          continue;
        }
        const bad = autopilotUnfit(pick.text);
        if (bad) { apNote(s, "Holding: today's generated post did not pass the quality gate (" + bad + "). It is waiting in drafts for your eyes."); continue; }
      }
      const when = new Date(Math.max(slot.getTime(), now.getTime() + 5 * 60_000));
      pick.createdBy = pick.createdBy ?? st.autopilotUserId;
      pick.autopilot = true;
      pick.status = "approved";
      pick.scheduledAt = when.toISOString();
      pick.error = undefined;
      pick.updatedAt = nowIso();
      persist();
      queued += 1;
      apNote(s, "Queued today's post for " + time + " (" + tz + "). Cancel it in Calendar any time before then to veto the day.");
    } catch { /* one workspace's autopilot; never stop the sweep */ }
  }
  return queued;
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
  // Canceling a post autopilot queued is a veto: autopilot must not re-queue
  // it (or write a replacement) the same day.
  if (d.autopilot) { d.autopilot = false; d.autopilotHeld = true; }
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
  "trend": { "startLabel": string, "endLabel": string, "deltaPct": number } | null,
  "share": { "value": number, "label": string } | null,
  "source": string | null,
  "photoQuery": string | null
}

Field rules:
- kicker: a 2 to 5 word section label for the top of the card, <= 34 characters, plain words (it is rendered uppercase).
- headline: the post's sharpest claim in its own words, <= 90 characters. When a hero number exists, the headline must NOT contain that figure: the hero shows the digits, the headline says what they mean (e.g. hero "-30%" + headline "Fewer people are sitting the CPA exam than at any point in a decade").
- hero: the single most striking number, e.g. {"value":"-30%","label":"CPA exam participation since 2016"}. value <= 8 characters including sign and unit; label <= 70 characters. null when the post has no standout number.
- bars: 0, 2, or 3 quantities from the post that share a unit and are worth comparing, largest story first. label <= 34 characters; display is the formatted figure exactly as the post gives it (e.g. "124,200"); amount is its plain numeric value. Use [] when the post has no comparable pair. Never repeat the hero number as a bar unless it is one side of the comparison.
- gap: <= 44 characters naming the difference the bars expose (e.g. "69,000 people short every year"), ONLY if the post states or directly implies it. Otherwise null.
- trend: ONLY when the post states a change over a named period (e.g. "down 30% since 2016"). startLabel = the period start (e.g. "2016"), endLabel = the period end (e.g. "today" or "2026"), deltaPct = the stated percent change as a signed number (e.g. -30). <= 24 characters per label. Otherwise null. Never turn a comparison of two different things into a trend.
- share: ONLY when the post states a part of a whole as a percentage or a fraction (e.g. "46 of 100 mailboxes" -> {"value":46,"label":"mailboxes blocked"}). value = the percentage 1 to 99; label <= 44 characters. Otherwise null.
- source: <= 70 characters of attribution ONLY if the post names a source. Otherwise null.
- photoQuery: a 2 to 4 word stock-photo search phrase for a real photograph that could sit behind this post. Concrete, shootable nouns from the post's world (e.g. "law firm meeting", "nurse hospital hallway", "accountant reviewing documents", "construction site engineer"). Never abstract words (growth, success, trends), never brand or people names. null only when no real-world scene fits.

No other text before or after the JSON.`;

export interface StatMediaSpec {
  kicker: string;
  headline: string;
  hero: { value: string; label: string } | null;
  bars: { label: string; display: string; amount: number }[];
  gap: string | null;
  /** A stated change over a named period; drawn as a trend curve. */
  trend?: { startLabel: string; endLabel: string; deltaPct: number } | null;
  /** A stated part-of-a-whole percentage; drawn as a donut. */
  share?: { value: number; label: string } | null;
  source: string | null;
  /** Stock-photo search phrase for the post's world; null = no scene fits. */
  photoQuery?: string | null;
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
  const trend = raw.trend && cleanStr(raw.trend.startLabel, 24) && cleanStr(raw.trend.endLabel, 24) &&
    Number.isFinite(Number(raw.trend.deltaPct)) && Math.abs(Number(raw.trend.deltaPct)) >= 1 && Number(raw.trend.deltaPct) >= -95 && Number(raw.trend.deltaPct) <= 500
    ? { startLabel: cleanStr(raw.trend.startLabel, 24), endLabel: cleanStr(raw.trend.endLabel, 24), deltaPct: Math.round(Number(raw.trend.deltaPct)) }
    : null;
  const share = raw.share && Number.isFinite(Number(raw.share.value)) && Number(raw.share.value) >= 1 && Number(raw.share.value) <= 99 && cleanStr(raw.share.label, 44)
    ? { value: Math.round(Number(raw.share.value)), label: cleanStr(raw.share.label, 44) }
    : null;
  return {
    kicker: cleanStr(raw.kicker, 34) || "THE MARKET RIGHT NOW",
    headline,
    hero,
    bars,
    gap: bars.length ? cleanStr(raw.gap, 44) || null : null,
    trend,
    share,
    source: cleanStr(raw.source, 70) || null,
    photoQuery: cleanStr(raw.photoQuery, 60) || null,
  };
}

/** No-AI fallback: a clean headline card from the draft's own first line. */
function statSpecNaive(text: string): StatMediaSpec {
  const firstLine = (text.split(/\n/).map((l) => l.trim()).filter(Boolean)[0] ?? text).slice(0, 90);
  return { kicker: "THE MARKET RIGHT NOW", headline: scrubDashes(firstLine), hero: null, bars: [], gap: null, trend: null, share: null, source: null, photoQuery: null };
}

/** When the spec has no photo idea (or an old cached spec predates the field),
 *  fall back to a scene from the desk's own market. */
function fallbackPhotoQuery(settings: PosterSettings): string {
  const first = (settings.industries || "").split(/[,;\n]/)[0]?.trim() ?? "";
  if (first) return first.split(/\s+/).slice(0, 3).join(" ") + " professionals working";
  return "business professionals office meeting";
}

/** Bar with a square baseline (left) and 8px-rounded data end (right). */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(8, w / 2);
  return `M${x} ${y} h${w - r} a${r} ${r} 0 0 1 ${r} ${r} v${h - 2 * r} a${r} ${r} 0 0 1 -${r} ${r} h-${w - r} Z`;
}

/* ---- stat card looks: layout templates x light/dark tones ----------------
 * The same extracted numbers render as genuinely different cards. Templates
 * are eligible by what the spec contains; a variant number walks the combo
 * list, so cycling "Create media for me" changes the look, not the facts.
 */
const CARD_FONT = "FreeSans, DejaVu Sans, Arial, sans-serif";

interface CardTone {
  bg: string; ink: string; secondary: string; muted: string;
  hairline: string; bracket: string; accent: string; neg: string;
  /** Single-hue sequential ramps (lightness-monotonic against this surface;
   *  every bar carries its own text label, so identity never rides on color). */
  ramp2: string[]; ramp3: string[];
}
const CARD_LIGHT: CardTone = {
  bg: "#fcfcfb", ink: "#0b0b0b", secondary: "#52514e", muted: "#898781",
  hairline: "#e1e0d9", bracket: "#c3c2b7", accent: "#2a78d6", neg: "#d03b3b",
  ramp2: ["#2a78d6", "#86b6ef"], ramp3: ["#2a78d6", "#5598e7", "#86b6ef"],
};
const CARD_DARK: CardTone = {
  bg: "#101014", ink: "#f2f2ee", secondary: "#b9b8b1", muted: "#8b8a84",
  hairline: "#2a2a30", bracket: "#4a4a52", accent: "#6aa5eb", neg: "#e66a6a",
  ramp2: ["#5598e7", "#b7d3f6"], ramp3: ["#5598e7", "#86b6ef", "#b7d3f6"],
};

type CardTemplate =
  | "heroLeft" | "heroPoster" | "barsLead" | "splitDuel" | "heroRail" | "statement"
  | "trendDip" | "donut" | "columns" | "panelSplit" | "photoHead";

/** Which layouts this spec can carry, most distinctive first. */
function cardTemplates(spec: StatMediaSpec): CardTemplate[] {
  const t: CardTemplate[] = [];
  if (spec.trend) t.push("trendDip");
  if (spec.share) t.push("donut");
  if (spec.hero && !spec.bars.length) t.push("heroPoster");
  if (spec.bars.length >= 2) t.push("barsLead", "columns");
  if (spec.bars.length === 2) t.push("splitDuel");
  if (spec.hero || spec.bars.length || spec.share) t.push("panelSplit");
  if (spec.hero) t.push("heroRail");
  // With no number at all, heroLeft is just a weaker statement card: skip it.
  if (spec.hero || spec.bars.length) t.push("heroLeft");
  if (!spec.bars.length) t.push("statement");
  return t;
}

/** Every distinct look for this spec: layouts in light (plus the photo card
 *  when the library has uploads), then the same layouts in dark. */
export function cardCombos(spec: StatMediaSpec, photoCount = 0): { template: CardTemplate; dark: boolean }[] {
  const t = cardTemplates(spec);
  const light: { template: CardTemplate; dark: boolean }[] = t.map((x) => ({ template: x, dark: false }));
  if (photoCount > 0) light.push({ template: "photoHead", dark: false });
  return [...light, ...t.map((x) => ({ template: x, dark: true }))];
}

/** Deterministic per-draft starting look, so sibling drafts don't match. */
function cardSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** Font size that keeps `text` inside `maxWidth` at the given width factor. */
function fitFs(text: string, maxWidth: number, baseFs: number, factor = 0.58): number {
  return Math.max(40, Math.min(baseFs, Math.floor(maxWidth / (Math.max(1, text.length) * factor))));
}

function kickerRow(parts: string[], T: CardTone, x: number, y: number, kicker: string): number {
  parts.push(`<rect x="${x}" y="${y - 10}" width="52" height="7" rx="3.5" fill="${T.accent}"/>`);
  parts.push(`<text x="${x + 72}" y="${y}" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="${T.muted}">${escXml(kicker.toUpperCase())}</text>`);
  return y + 84;
}

function headlineBlock(parts: string[], T: CardTone, x: number, y: number, headline: string, fs: number, maxLines = 3, width = 1008): number {
  const lines = wrapLines(headline, Math.floor(width / (fs * 0.5)), maxLines);
  const lineH = Math.round(fs * 1.18);
  for (const l of lines) {
    parts.push(`<text x="${x}" y="${y}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-1" fill="${T.ink}">${escXml(l)}</text>`);
    y += lineH;
  }
  return y;
}

/** Left-aligned hero figure with the label beside it (or under, when wide). */
function heroBlock(parts: string[], T: CardTone, x: number, y: number, hero: { value: string; label: string }, heroFs: number): number {
  const negative = /^[-−↓]/.test(hero.value);
  const fs = fitFs(hero.value, 1008, heroFs);
  const heroW = Math.round(hero.value.length * fs * 0.58) + 30;
  parts.push(`<text x="${x}" y="${y + fs * 0.78}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-4" fill="${negative ? T.neg : T.accent}">${escXml(hero.value)}</text>`);
  if (heroW <= 560) {
    let ly = y + 60;
    for (const l of wrapLines(hero.label, 26, 3)) {
      parts.push(`<text x="${x + heroW}" y="${ly}" font-family="${CARD_FONT}" font-size="31" fill="${T.secondary}">${escXml(l)}</text>`);
      ly += 42;
    }
    return y + fs + 46;
  }
  let ly = y + fs + 34;
  const labLines = wrapLines(hero.label, 64, 2);
  for (const l of labLines) {
    parts.push(`<text x="${x}" y="${ly}" font-family="${CARD_FONT}" font-size="31" fill="${T.secondary}">${escXml(l)}</text>`);
    ly += 42;
  }
  return y + fs + 34 + labLines.length * 42 + 12;
}

/** Labeled horizontal bars + optional gap callout. Scales with `barH`. */
function barsBlock(parts: string[], T: CardTone, x: number, y: number, spec: StatMediaSpec, opts: { barH: number; labelFs: number; valueFs: number; width: number }): number {
  const ramp = spec.bars.length === 2 ? T.ramp2 : T.ramp3;
  const maxAmount = Math.max(...spec.bars.map((b) => b.amount));
  const maxW = opts.width - 220; // room for the value at the tip
  const ends: number[] = [];
  for (let i = 0; i < spec.bars.length; i++) {
    const b = spec.bars[i];
    const w = Math.max(14, Math.round((b.amount / maxAmount) * maxW));
    ends.push(w);
    parts.push(`<text x="${x}" y="${y}" font-family="${CARD_FONT}" font-size="${opts.labelFs}" fill="${T.secondary}">${escXml(b.label)}</text>`);
    y += 22;
    parts.push(`<path d="${barPath(x, y, w, opts.barH)}" fill="${ramp[i]}"/>`);
    parts.push(`<text x="${x + w + 22}" y="${y + Math.round(opts.barH * 0.78)}" font-family="${CARD_FONT}" font-size="${opts.valueFs}" font-weight="700" fill="${T.ink}">${escXml(b.display)}</text>`);
    y += opts.barH + 44;
  }
  const gapFs = Math.max(31, opts.labelFs + 1);
  if (spec.gap && spec.bars.length === 2 && ends[0] - ends[1] > 120) {
    const x0 = x + Math.min(ends[0], ends[1]), x1 = x + Math.max(ends[0], ends[1]);
    parts.push(`<path d="M${x0} ${y - 20} v14 h${x1 - x0} v-14" stroke="${T.bracket}" stroke-width="1.5" fill="none"/>`);
    parts.push(`<text x="${(x0 + x1) / 2}" y="${y + 40}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${gapFs}" font-weight="700" fill="${T.ink}">${escXml(spec.gap)}</text>`);
    y += 76;
  } else if (spec.gap) {
    parts.push(`<text x="${x}" y="${y + 10}" font-family="${CARD_FONT}" font-size="${gapFs}" font-weight="700" fill="${T.ink}">${escXml(spec.gap)}</text>`);
    y += 56;
  }
  return y;
}

/**
 * Overlay for the photo card: a solid dark band across the lower third with
 * the kicker, headline, and hero in white. Composited over a library photo.
 */
export function photoOverlaySvg(spec: StatMediaSpec, credit?: string): string {
  const W = 1200, H = 1500, M = 96;
  const parts: string[] = [];
  if (credit) {
    // Top-right corner: the dark band owns the foot of this layout.
    parts.push(`<text x="${W - 28}" y="44" text-anchor="end" font-family="${CARD_FONT}" font-size="19" fill="#f0f2f6" fill-opacity="0.85">${escXml(credit)}</text>`);
  }
  const hFs = spec.headline.length > 60 ? 56 : 64;
  const hLines = wrapLines(spec.headline, Math.floor((W - 2 * M) / (hFs * 0.5)), 3);
  const heroH = spec.hero ? 150 : 0;
  const bandH = 140 + hLines.length * Math.round(hFs * 1.2) + heroH + 90;
  const bandY = H - bandH;
  parts.push(`<rect x="0" y="${bandY}" width="${W}" height="${bandH}" fill="#0a0c10" fill-opacity="0.78"/>`);
  parts.push(`<rect x="0" y="${bandY}" width="${W}" height="6" fill="#5598e7"/>`);
  let y = bandY + 92;
  parts.push(`<rect x="${M}" y="${y - 10}" width="52" height="7" rx="3.5" fill="#5598e7"/>`);
  parts.push(`<text x="${M + 72}" y="${y}" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="#c9d4e4">${escXml(spec.kicker.toUpperCase())}</text>`);
  y += 78;
  for (const l of hLines) {
    parts.push(`<text x="${M}" y="${y}" font-family="${CARD_FONT}" font-size="${hFs}" font-weight="800" letter-spacing="-1" fill="#ffffff">${escXml(l)}</text>`);
    y += Math.round(hFs * 1.2);
  }
  if (spec.hero) {
    y += 26;
    const negative = /^[-−↓]/.test(spec.hero.value);
    const fs = fitFs(spec.hero.value, 620, 120);
    parts.push(`<text x="${M}" y="${y + fs * 0.78}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-3" fill="${negative ? "#ff8d7a" : "#7db4f2"}">${escXml(spec.hero.value)}</text>`);
    const heroW = Math.round(spec.hero.value.length * fs * 0.58) + 34;
    let ly = y + 46;
    for (const l of wrapLines(spec.hero.label, 30, 2)) {
      parts.push(`<text x="${M + heroW}" y="${ly}" font-family="${CARD_FONT}" font-size="29" fill="#c9d4e4">${escXml(l)}</text>`);
      ly += 40;
    }
  }
  if (spec.source) {
    parts.push(`<text x="${M}" y="${H - 34}" font-family="${CARD_FONT}" font-size="21" fill="#8fa0b8">${escXml(spec.source)}</text>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("\n")}</svg>`;
}

/**
 * 1200x1500 (4:5 portrait, LinkedIn's tallest feed crop) stat card. The
 * template picks the composition, the tone picks the surface; sections are
 * optional and every layout reflows around what the spec actually has.
 */
export function statMediaSvg(spec: StatMediaSpec, template: CardTemplate = "heroLeft", dark = false): string {
  const W = 1200, H = 1500, M = 96;
  const T = dark ? CARD_DARK : CARD_LIGHT;
  const parts: string[] = [];
  let y = 150;

  if (template === "trendDip" && spec.trend) {
    // A stated change over a period, drawn as an indexed curve (start = 100).
    const tr = spec.trend;
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, 52, 3) + 60;
    const negative = tr.deltaPct < 0;
    const lineC = negative ? T.neg : T.accent;
    const chartX = M, chartW = W - 2 * M, chartH = 480;
    const top = y, bottom = y + chartH;
    const endIdx = 100 + tr.deltaPct;
    const vMax = Math.max(100, endIdx) * 1.12;
    const vMin = Math.max(0, Math.min(100, endIdx) * 0.82);
    const yOf = (v: number) => bottom - ((v - vMin) / (vMax - vMin)) * chartH;
    const y0 = yOf(100), y1 = yOf(endIdx);
    for (let i = 1; i <= 3; i++) {
      parts.push(`<rect x="${chartX}" y="${top + (chartH / 4) * i}" width="${chartW}" height="1" fill="${T.hairline}"/>`);
    }
    const x0 = chartX + 14, x1 = chartX + chartW - 14;
    const c1 = x0 + chartW * 0.42, c2 = x0 + chartW * 0.58;
    parts.push(`<path d="M${x0} ${y0} C ${c1} ${y0}, ${c2} ${y1}, ${x1} ${y1} L ${x1} ${bottom} L ${x0} ${bottom} Z" fill="${lineC}" fill-opacity="0.14"/>`);
    parts.push(`<path d="M${x0} ${y0} C ${c1} ${y0}, ${c2} ${y1}, ${x1} ${y1}" stroke="${lineC}" stroke-width="6" fill="none" stroke-linecap="round"/>`);
    parts.push(`<circle cx="${x0}" cy="${y0}" r="9" fill="${T.muted}"/>`);
    parts.push(`<circle cx="${x1}" cy="${y1}" r="12" fill="${lineC}"/>`);
    parts.push(`<circle cx="${x1}" cy="${y1}" r="12" fill="none" stroke="${T.bg}" stroke-width="3"/>`);
    const deltaTxt = (tr.deltaPct > 0 ? "+" : "") + tr.deltaPct + "%";
    const dFs = 120;
    const dY = negative ? top + dFs * 0.9 : bottom - 40;
    parts.push(`<text x="${x1}" y="${dY}" text-anchor="end" font-family="${CARD_FONT}" font-size="${dFs}" font-weight="800" letter-spacing="-3" fill="${lineC}">${escXml(deltaTxt)}</text>`);
    y = bottom + 52;
    parts.push(`<text x="${x0}" y="${y}" font-family="${CARD_FONT}" font-size="30" fill="${T.secondary}">${escXml(tr.startLabel)}</text>`);
    parts.push(`<text x="${x1}" y="${y}" text-anchor="end" font-family="${CARD_FONT}" font-size="30" fill="${T.secondary}">${escXml(tr.endLabel)}</text>`);
    y += 20;
  } else if (template === "donut" && spec.share) {
    // A part of a whole: donut ring, the percentage in the middle.
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, 52, 3) + 70;
    const R = 270, ring = 62, cx = W / 2, cy = y + R + 10;
    const track = (spec.bars.length === 2 ? T.ramp2 : T.ramp3)[spec.bars.length === 2 ? 1 : 2];
    const circ = 2 * Math.PI * R;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${track}" stroke-opacity="0.45" stroke-width="${ring}"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${T.accent}" stroke-width="${ring}" stroke-linecap="round" stroke-dasharray="${(circ * spec.share.value / 100).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`);
    parts.push(`<text x="${cx}" y="${cy + 52}" text-anchor="middle" font-family="${CARD_FONT}" font-size="150" font-weight="800" letter-spacing="-4" fill="${T.ink}">${escXml(spec.share.value + "%")}</text>`);
    y = cy + R + ring / 2 + 74;
    for (const l of wrapLines(spec.share.label, 40, 2)) {
      parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="35" fill="${T.secondary}">${escXml(l)}</text>`);
      y += 48;
    }
  } else if (template === "columns" && spec.bars.length >= 2) {
    // The comparison as vertical columns, values on top.
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, 50, 2) + 70;
    const ramp = spec.bars.length === 2 ? T.ramp2 : T.ramp3;
    const n = spec.bars.length;
    const colW = n === 2 ? 300 : 240;
    const gapW = n === 2 ? 140 : 72;
    const plotH = 560;
    const startX = (W - (n * colW + (n - 1) * gapW)) / 2;
    const maxAmount = Math.max(...spec.bars.map((b) => b.amount));
    const base = y + plotH;
    for (let i = 0; i < n; i++) {
      const b = spec.bars[i];
      const h = Math.max(46, Math.round((b.amount / maxAmount) * (plotH - 90)));
      const x = startX + i * (colW + gapW);
      const r = 10;
      parts.push(`<path d="M${x} ${base} v-${h - r} a${r} ${r} 0 0 1 ${r} -${r} h${colW - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} Z" fill="${ramp[i]}"/>`);
      parts.push(`<text x="${x + colW / 2}" y="${base - h - 26}" text-anchor="middle" font-family="${CARD_FONT}" font-size="42" font-weight="800" fill="${T.ink}">${escXml(b.display)}</text>`);
      let ly = base + 52;
      for (const l of wrapLines(b.label, 18, 2)) {
        parts.push(`<text x="${x + colW / 2}" y="${ly}" text-anchor="middle" font-family="${CARD_FONT}" font-size="29" fill="${T.secondary}">${escXml(l)}</text>`);
        ly += 38;
      }
    }
    parts.push(`<rect x="${M}" y="${base}" width="${W - 2 * M}" height="2" fill="${T.bracket}"/>`);
    y = base + 140;
    if (spec.gap) {
      parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="34" font-weight="700" fill="${T.ink}">${escXml(spec.gap)}</text>`);
      y += 30;
    }
  } else if (template === "panelSplit" && (spec.hero || spec.bars.length || spec.share)) {
    // Color-block: the words live on a solid accent panel, the number below it.
    const panelH = 660;
    parts.push(`<rect x="0" y="0" width="${W}" height="${panelH}" fill="${dark ? "#1c4f8f" : T.accent}"/>`);
    let py = 170;
    parts.push(`<rect x="${M}" y="${py - 10}" width="52" height="7" rx="3.5" fill="#ffffff" fill-opacity="0.9"/>`);
    parts.push(`<text x="${M + 72}" y="${py}" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="#ffffff" fill-opacity="0.75">${escXml(spec.kicker.toUpperCase())}</text>`);
    py += 92;
    const pFs = spec.headline.length > 60 ? 58 : 66;
    for (const l of wrapLines(spec.headline, Math.floor((W - 2 * M) / (pFs * 0.5)), 4)) {
      parts.push(`<text x="${M}" y="${py}" font-family="${CARD_FONT}" font-size="${pFs}" font-weight="800" letter-spacing="-1" fill="#ffffff">${escXml(l)}</text>`);
      py += Math.round(pFs * 1.2);
    }
    y = panelH + 120;
    if (spec.hero) {
      y = heroBlock(parts, T, M, y, spec.hero, 190);
    } else if (spec.bars.length) {
      y = barsBlock(parts, T, M, y, spec, { barH: 44, labelFs: 31, valueFs: 35, width: W - 2 * M });
    } else if (spec.share) {
      y = heroBlock(parts, T, M, y, { value: spec.share.value + "%", label: spec.share.label }, 190);
    }
    // The panel owns the top: pin the group, no vertical centering.
    const src = spec.source
      ? `<text x="${M}" y="${H - 76}" font-family="${CARD_FONT}" font-size="21" fill="${T.muted}">${escXml(spec.source)}</text>`
      : "";
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${W}" height="${H}" fill="${T.bg}"/>${parts.join("\n")}${src}</svg>`;
  } else if (template === "heroPoster" && spec.hero) {
    // Centered poster: the number IS the card; the headline supports it.
    const cx = W / 2;
    parts.push(`<rect x="${cx - 26}" y="${y - 10}" width="52" height="7" rx="3.5" fill="${T.accent}"/>`);
    y += 52;
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="${T.muted}">${escXml(spec.kicker.toUpperCase())}</text>`);
    y += 120;
    const negative = /^[-−↓]/.test(spec.hero.value);
    const fs = fitFs(spec.hero.value, W - 2 * M, 290);
    y += fs;
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-6" fill="${negative ? T.neg : T.accent}">${escXml(spec.hero.value)}</text>`);
    y += 64;
    for (const l of wrapLines(spec.hero.label, 44, 2)) {
      parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="34" fill="${T.secondary}">${escXml(l)}</text>`);
      y += 46;
    }
    y += 56;
    parts.push(`<rect x="${cx - 220}" y="${y}" width="440" height="1" fill="${T.hairline}"/>`);
    y += 78;
    const hFs = 46;
    const hLines = wrapLines(spec.headline, Math.floor((W - 2 * M) / (hFs * 0.5)), 3);
    for (const l of hLines) {
      parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${hFs}" font-weight="700" letter-spacing="-0.5" fill="${T.ink}">${escXml(l)}</text>`);
      y += Math.round(hFs * 1.25);
    }
  } else if (template === "barsLead" && spec.bars.length >= 2) {
    // The comparison is the card: headline compact, bars big.
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, 50, 2) + 56;
    parts.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="1" fill="${T.hairline}"/>`);
    y += 90;
    y = barsBlock(parts, T, M, y, spec, { barH: 64, labelFs: 34, valueFs: 44, width: W - 2 * M });
  } else if (template === "splitDuel" && spec.bars.length === 2) {
    // Two figures head to head; the gap line names the difference.
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, 50, 2) + 70;
    const colW = (W - 2 * M - 80) / 2;
    const xL = M, xR = M + colW + 80;
    const topY = y;
    const fsL = fitFs(spec.bars[0].display, colW, 120);
    const fsR = fitFs(spec.bars[1].display, colW, 120);
    const fs = Math.min(fsL, fsR);
    y += fs;
    parts.push(`<text x="${xL}" y="${y}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-3" fill="${T.accent}">${escXml(spec.bars[0].display)}</text>`);
    parts.push(`<text x="${xR}" y="${y}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-3" fill="${T.ink}">${escXml(spec.bars[1].display)}</text>`);
    y += 56;
    let lyL = y, lyR = y;
    for (const l of wrapLines(spec.bars[0].label, 24, 3)) {
      parts.push(`<text x="${xL}" y="${lyL}" font-family="${CARD_FONT}" font-size="31" fill="${T.secondary}">${escXml(l)}</text>`);
      lyL += 42;
    }
    for (const l of wrapLines(spec.bars[1].label, 24, 3)) {
      parts.push(`<text x="${xR}" y="${lyR}" font-family="${CARD_FONT}" font-size="31" fill="${T.secondary}">${escXml(l)}</text>`);
      lyR += 42;
    }
    y = Math.max(lyL, lyR) + 24;
    parts.push(`<rect x="${M + colW + 39}" y="${topY - fs + 10}" width="2" height="${y - (topY - fs) - 34}" fill="${T.hairline}"/>`);
    if (spec.gap) {
      y += 40;
      parts.push(`<rect x="${M}" y="${y - 26}" width="52" height="7" rx="3.5" fill="${T.accent}"/>`);
      parts.push(`<text x="${M + 72}" y="${y}" font-family="${CARD_FONT}" font-size="36" font-weight="700" fill="${T.ink}">${escXml(spec.gap)}</text>`);
      y += 30;
    }
  } else if (template === "heroRail" && spec.hero) {
    // Editorial: an accent rail runs the content's full height on the left.
    const x = M + 56;
    const railTop = y - 34;
    parts.push(`<text x="${x}" y="${y}" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="${T.muted}">${escXml(spec.kicker.toUpperCase())}</text>`);
    y += 84;
    y = heroBlock(parts, T, x, y, spec.hero, 190) + 24;
    y = headlineBlock(parts, T, x, y, spec.headline, spec.headline.length > 60 ? 54 : 62, 3, W - x - M) + 26;
    if (spec.bars.length) {
      y += 30;
      y = barsBlock(parts, T, x, y, spec, { barH: 36, labelFs: 29, valueFs: 31, width: W - x - M });
    }
    parts.push(`<rect x="${M}" y="${railTop}" width="10" height="${y - railTop - 40}" rx="5" fill="${T.accent}"/>`);
  } else if (template === "statement" && !spec.bars.length) {
    // Typography-led: the claim in display size; the hero rides underneath.
    y = kickerRow(parts, T, M, y, spec.kicker) + 30;
    const fs = spec.headline.length > 70 ? 84 : 96;
    const lines = wrapLines(spec.headline, Math.floor((W - 2 * M) / (fs * 0.5)), 4);
    const lineH = Math.round(fs * 1.14);
    for (const l of lines) {
      parts.push(`<text x="${M}" y="${y}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-2.5" fill="${T.ink}">${escXml(l)}</text>`);
      y += lineH;
    }
    y += 18;
    parts.push(`<rect x="${M}" y="${y}" width="140" height="14" rx="7" fill="${T.accent}"/>`);
    y += 110;
    if (spec.hero) y = heroBlock(parts, T, M, y, spec.hero, 130);
  } else {
    // heroLeft: the classic composition, and the fallback for any spec.
    y = kickerRow(parts, T, M, y, spec.kicker);
    y = headlineBlock(parts, T, M, y, spec.headline, spec.headline.length > 60 ? 58 : 66) + 40;
    if (spec.hero) y = heroBlock(parts, T, M, y, spec.hero, 175);
    if (spec.bars.length) {
      parts.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="1" fill="${T.hairline}"/>`);
      y += 78;
      y = barsBlock(parts, T, M, y, spec, { barH: 40, labelFs: 30, valueFs: 33, width: W - 2 * M });
    }
  }

  // Sparse cards drift toward the optical center; dense cards stay put. The
  // source line is pinned to the bottom edge outside the centering group.
  const shift = Math.max(0, Math.floor((H - 130 - y) / 2) - 60);
  const source = spec.source
    ? `<text x="${M}" y="${H - 76}" font-family="${CARD_FONT}" font-size="21" fill="${T.muted}">${escXml(spec.source)}</text>`
    : "";
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="${T.bg}"/>` +
    `<g transform="translate(0 ${shift})">${parts.join("\n")}</g>${source}</svg>`;
}

/**
 * "Create media for me": read the draft, extract its own numbers (AI when
 * available, headline-only fallback otherwise), render the stat card, save it
 * to the library, and attach it to the draft for approval.
 */
export async function generateStatMedia(ws: string, opts: { draftId: string; imageId?: string }): Promise<{ image: PosterImage; draft: PosterDraft }> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === opts.draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (!d.text.trim()) throw Object.assign(new Error("empty_post"), { status: 400 });

  const spec = await draftStatSpec(d);
  // Each click walks to the next look; the first lands on the draft's own
  // seeded start, so two drafts made the same day don't wear the same card.
  d.mediaVariant = d.mediaVariant == null ? cardSeed(d.id) : d.mediaVariant + 1;
  let img: PosterImage;
  if (opts.imageId) {
    // The recruiter picked a specific photo: design around exactly that one,
    // treatments rotating on repeat picks.
    const photo = s.images.find((i) => i.id === opts.imageId && (i.kind === "stock" || i.kind === "upload") && i.mime.startsWith("image/"));
    if (!photo) throw Object.assign(new Error("image_not_found"), { status: 404 });
    const treats = photoTreatmentsFor(spec);
    const treatment = treats[((d.mediaVariant % treats.length) + treats.length) % treats.length];
    const base = await fs.readFile(path.join(mediaDir(), photo.file));
    const bytes = await renderPhotoLook(base, spec, treatment, s.settings.brandLine || "", photo.credit);
    img = await saveRenderedCard(s, bytes, spec.headline);
  } else {
    img = await renderStatCard(ws, spec, d.mediaVariant);
  }
  d.imageId = img.id;
  d.updatedAt = nowIso();
  persist();
  return { image: img, draft: d };
}

/** The card's numbers (AI when available, headline-only fallback), cached on
 *  the draft so cycling through looks never re-spends the extraction call. */
async function draftStatSpec(d: PosterDraft): Promise<StatMediaSpec> {
  // Specs cached before the photo engine have no photoQuery field at all
  // (undefined, vs null for "no scene fits"); re-extract those once so
  // existing drafts get a real photo scene too.
  if (d.mediaSpec && d.mediaSpecFor === d.text &&
      (d.mediaSpec.photoQuery !== undefined || !process.env.ANTHROPIC_API_KEY)) return d.mediaSpec;
  let spec: StatMediaSpec | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try { spec = await generateStatSpec(d.text); } catch { spec = null; }
  }
  if (!spec) spec = statSpecNaive(d.text);
  d.mediaSpec = spec;
  d.mediaSpecFor = d.text;
  persist();
  return spec;
}

/* ----------------------- real photos in the library ----------------------- */

const STOCK_LIBRARY_CAP = 240;

/** Download a licensed photo into the media library (kind "stock"), normalized
 *  to a clean JPEG. Dedupes on provider id; safe to call repeatedly. */
export async function importStockPhoto(ws: string, photo: StockPhoto, query: string): Promise<PosterImage> {
  await ensureLoaded();
  const s = wsState(ws);
  const key = photo.provider + ":" + photo.providerId;
  const existing = s.images.find((i) => i.kind === "stock" && i.providerId === key);
  if (existing) return existing;
  const { fetchPhotoBytes } = await import("./photoEngine");
  const raw = await fetchPhotoBytes(photo);
  const sharp = (await import("sharp")).default;
  // Normalize: honor EXIF, cap the long edge, re-encode (strips metadata and
  // guarantees a format sharp can composite later).
  const bytes = await sharp(raw)
    .rotate()
    .resize(1600, 2000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  const id = rid();
  const file = id + ".jpg";
  await writeMedia(file, bytes);
  const img: PosterImage = {
    id, file, mime: "image/jpeg", kind: "stock",
    name: (query + (photo.creator ? " (" + photo.creator + ")" : "")).slice(0, 80),
    providerId: key,
    credit: photo.credit ?? undefined,
    link: photo.pageUrl ?? undefined,
    query,
    createdAt: nowIso(),
  };
  s.images.unshift(img);
  // Keep the library tidy: oldest unattached stock photos roll off.
  const attached = new Set(s.drafts.map((d) => d.imageId).filter(Boolean));
  let excess = s.images.filter((i) => i.kind === "stock").length - STOCK_LIBRARY_CAP;
  if (excess > 0) {
    for (let i = s.images.length - 1; i >= 0 && excess > 0; i--) {
      const im = s.images[i];
      if (im.kind === "stock" && !attached.has(im.id)) {
        try { await fs.unlink(path.join(mediaDir(), im.file)); } catch { /* already gone */ }
        s.images.splice(i, 1);
        excess -= 1;
      }
    }
  }
  persist();
  return img;
}

/** The suffixes that turn an industry line into archive searches. */
const ARCHIVE_SUFFIXES = ["professionals working", "office meeting", "team at work"];

/** The searches worth keeping stocked for this desk: its industries crossed
 *  with workplace scenes, plus the scenes its recent posts actually named. */
function archiveQueries(s: WorkspaceState): string[] {
  const qs = new Set<string>();
  for (const ind of (s.settings.industries || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 4)) {
    const base = ind.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    for (const suf of ARCHIVE_SUFFIXES) qs.add(base + " " + suf);
  }
  for (const d of s.drafts.slice(0, 12)) {
    const q = d.mediaSpec?.photoQuery;
    if (q) qs.add(q.trim().toLowerCase());
  }
  if (!qs.size) qs.add("business professionals office meeting");
  return [...qs].slice(0, 10);
}

/**
 * Top up the workspace's photo archive: every archive query keeps a few
 * licensed photos on hand, so media creation picks from a deep local pool
 * instead of fetching cold. Runs daily via the automation scheduler and on
 * demand from the Media tab.
 */
export async function buildStockArchive(ws: string, perQuery = 4): Promise<{ queries: number; added: number }> {
  await ensureLoaded();
  const s = wsState(ws);
  const queries = archiveQueries(s);
  let added = 0;
  for (const q of queries) {
    const count = () => s.images.filter((i) => i.kind === "stock" && i.query === q).length;
    if (count() >= perQuery) continue;
    try {
      const found = await searchStockPhotos(q);
      const have = new Set(s.images.filter((i) => i.kind === "stock").map((i) => i.providerId));
      for (const p of found) {
        if (count() >= perQuery) break;
        if (have.has(p.provider + ":" + p.providerId)) continue;
        try {
          await importStockPhoto(ws, p, q);
          added += 1;
        } catch { /* one bad file; keep going */ }
      }
    } catch { /* this query's providers are down; try the next */ }
  }
  return { queries: queries.length, added };
}

/** Automation sweep: archive top-up for every workspace using the Poster. */
export async function tickStockArchive(): Promise<number> {
  await ensureLoaded();
  let added = 0;
  for (const ws of Object.keys(store.workspaces)) {
    try { added += (await buildStockArchive(ws)).added; } catch { /* next workspace */ }
  }
  return added;
}

/** The photos available for this spec: library stock matching its search
 *  first; otherwise search + import a few. Optional AI generation is the last
 *  rung when stock comes back empty. Never throws; empty = use SVG looks. */
async function ensureStockPhotos(ws: string, spec: StatMediaSpec): Promise<PosterImage[]> {
  const s = wsState(ws);
  const q = (spec.photoQuery ?? "").trim() || fallbackPhotoQuery(s.settings);
  const have = s.images.filter((i) => i.kind === "stock" && i.query === q);
  if (have.length >= 2) return have;
  const out = [...have];
  try {
    const found = await searchStockPhotos(q);
    const seen = new Set(out.map((i) => i.providerId));
    for (const p of found) {
      if (out.length >= 4) break;
      if (seen.has(p.provider + ":" + p.providerId)) continue;
      try { out.push(await importStockPhoto(ws, p, q)); } catch { /* one bad file; keep going */ }
    }
  } catch { /* search down: fall through */ }
  if (!out.length) {
    try {
      const ai = await generateAiPhoto(q);
      if (ai) {
        const sharp = (await import("sharp")).default;
        const bytes = await sharp(ai).resize(1600, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        const id = rid();
        await writeMedia(id + ".jpg", bytes);
        const img: PosterImage = {
          id, file: id + ".jpg", mime: "image/jpeg", kind: "stock",
          name: ("AI photo: " + q).slice(0, 80),
          providerId: "ai:" + q, query: q, createdAt: nowIso(),
        };
        s.images.unshift(img);
        persist();
        out.push(img);
      }
    } catch { /* optional rung */ }
  }
  return out;
}

/* --------------------- photo treatments (brand looks) --------------------- */

type PhotoTreatment = "scrim" | "panel" | "statBig" | "duotone" | "band";

/** Which photo looks this spec can carry, most editorial first. */
function photoTreatmentsFor(spec: StatMediaSpec): PhotoTreatment[] {
  const t: PhotoTreatment[] = ["scrim", "panel"];
  if (spec.hero) t.push("statBig");
  t.push("duotone", "band");
  return t;
}

function creditTag(parts: string[], credit: string | undefined, W: number, H: number, light = true): void {
  if (!credit) return;
  parts.push(`<text x="${W - 28}" y="${H - 26}" text-anchor="end" font-family="${CARD_FONT}" font-size="19" fill="${light ? "#d7dde8" : "#6d6c66"}" fill-opacity="0.9">${escXml(credit)}</text>`);
}

/** Editorial magazine look: full-bleed photo, dark gradient up from the foot,
 *  kicker at the top, the claim and its number at the bottom. */
function photoScrimSvg(spec: StatMediaSpec, brand: string, credit?: string): string {
  const W = 1200, H = 1500, M = 96;
  const parts: string[] = [];
  parts.push(`<defs><linearGradient id="sc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0c10" stop-opacity="0"/><stop offset="0.42" stop-color="#0a0c10" stop-opacity="0.06"/><stop offset="0.72" stop-color="#0a0c10" stop-opacity="0.62"/><stop offset="1" stop-color="#0a0c10" stop-opacity="0.92"/></linearGradient><linearGradient id="tc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0c10" stop-opacity="0.5"/><stop offset="1" stop-color="#0a0c10" stop-opacity="0"/></linearGradient></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#sc)"/>`);
  parts.push(`<rect width="${W}" height="220" fill="url(#tc)"/>`);
  parts.push(`<rect x="${M}" y="108" width="52" height="7" rx="3.5" fill="#5598e7"/>`);
  parts.push(`<text x="${M + 72}" y="118" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="#e6ecf5">${escXml(spec.kicker.toUpperCase())}</text>`);
  const hFs = spec.headline.length > 60 ? 60 : 70;
  const hLines = wrapLines(spec.headline, Math.floor((W - 2 * M) / (hFs * 0.5)), 3);
  const heroH = spec.hero ? 190 : 0;
  let y = H - 120 - heroH - hLines.length * Math.round(hFs * 1.16);
  for (const l of hLines) {
    parts.push(`<text x="${M}" y="${y}" font-family="${CARD_FONT}" font-size="${hFs}" font-weight="800" letter-spacing="-1.5" fill="#ffffff">${escXml(l)}</text>`);
    y += Math.round(hFs * 1.16);
  }
  if (spec.hero) {
    y += 40;
    const negative = /^[-−↓]/.test(spec.hero.value);
    const fs = fitFs(spec.hero.value, 640, 140);
    parts.push(`<text x="${M}" y="${y + fs * 0.6}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-4" fill="${negative ? "#ff8d7a" : "#7db4f2"}">${escXml(spec.hero.value)}</text>`);
    const heroW = Math.round(spec.hero.value.length * fs * 0.58) + 34;
    let ly = y + 22;
    for (const l of wrapLines(spec.hero.label, 30, 2)) {
      parts.push(`<text x="${M + heroW}" y="${ly}" font-family="${CARD_FONT}" font-size="29" fill="#d7dde8">${escXml(l)}</text>`);
      ly += 40;
    }
  }
  if (brand) parts.push(`<text x="${M}" y="${H - 26}" font-family="${CARD_FONT}" font-size="21" fill="#aab6c8">${escXml(brand)}</text>`);
  creditTag(parts, credit, W, H);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("\n")}</svg>`;
}

/** Clean B2B look: photo on top, a calm light panel below carrying the story.
 *  The photo is composited over the transparent top region afterwards. */
function photoPanelSvg(spec: StatMediaSpec, brand: string, credit?: string): string {
  const W = 1200, H = 1500, M = 96, PH = 860;
  const T = CARD_LIGHT;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`);
  parts.push(`<rect x="0" y="${PH}" width="${W}" height="6" fill="${T.accent}"/>`);
  let y = PH + 104;
  y = kickerRow(parts, T, M, y, spec.kicker);
  const hFs = spec.headline.length > 60 ? 50 : 56;
  y = headlineBlock(parts, T, M, y, spec.headline, hFs, 3) + 26;
  if (spec.hero) {
    const negative = /^[-−↓]/.test(spec.hero.value);
    const fs = fitFs(spec.hero.value, 620, 120);
    parts.push(`<text x="${M}" y="${y + fs * 0.62}" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-3" fill="${negative ? T.neg : T.accent}">${escXml(spec.hero.value)}</text>`);
    const heroW = Math.round(spec.hero.value.length * fs * 0.58) + 34;
    let ly = y + 24;
    for (const l of wrapLines(spec.hero.label, 30, 2)) {
      parts.push(`<text x="${M + heroW}" y="${ly}" font-family="${CARD_FONT}" font-size="28" fill="${T.secondary}">${escXml(l)}</text>`);
      ly += 38;
    }
  }
  if (brand) parts.push(`<text x="${M}" y="${H - 40}" font-family="${CARD_FONT}" font-size="21" fill="${T.muted}">${escXml(brand)}</text>`);
  creditTag(parts, credit, W, H, false);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("\n")}</svg>`;
}

/** Poster look: darkened photo, one giant number in the middle of it. */
function photoStatBigSvg(spec: StatMediaSpec, brand: string, credit?: string): string {
  const W = 1200, H = 1500, C = W / 2;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#0a0c10" fill-opacity="0.58"/>`);
  parts.push(`<rect x="${C - 26}" y="150" width="52" height="7" rx="3.5" fill="#5598e7"/>`);
  parts.push(`<text x="${C}" y="212" text-anchor="middle" font-family="${CARD_FONT}" font-size="25" font-weight="700" letter-spacing="4.5" fill="#e6ecf5">${escXml(spec.kicker.toUpperCase())}</text>`);
  const hero = spec.hero as { value: string; label: string };
  const negative = /^[-−↓]/.test(hero.value);
  const fs = fitFs(hero.value, W - 160, 330);
  parts.push(`<text x="${C}" y="${H / 2 + fs * 0.28}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${fs}" font-weight="800" letter-spacing="-8" fill="${negative ? "#ff8d7a" : "#8fbdf5"}">${escXml(hero.value)}</text>`);
  let y = H / 2 + fs * 0.28 + 86;
  for (const l of wrapLines(hero.label, 34, 2)) {
    parts.push(`<text x="${C}" y="${y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="34" fill="#e6ecf5">${escXml(l)}</text>`);
    y += 48;
  }
  const hLines = wrapLines(spec.headline, 42, 2);
  let hy = H - 150 - (hLines.length - 1) * 54;
  for (const l of hLines) {
    parts.push(`<text x="${C}" y="${hy}" text-anchor="middle" font-family="${CARD_FONT}" font-size="40" font-weight="700" fill="#ffffff">${escXml(l)}</text>`);
    hy += 54;
  }
  if (brand) parts.push(`<text x="${C}" y="${H - 26}" text-anchor="middle" font-family="${CARD_FONT}" font-size="21" fill="#aab6c8">${escXml(brand)}</text>`);
  creditTag(parts, credit, W, H);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("\n")}</svg>`;
}

/** Photo + treatment -> finished 1200x1500 PNG. Exported for render harnesses. */
export async function renderPhotoLook(baseBytes: Buffer, spec: StatMediaSpec, treatment: PhotoTreatment, brand: string, credit?: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  // Small photos can't carry a full-bleed 1200x1500 crop without a mushy
  // upscale; they drop to the panel look, whose photo region is shallow.
  if (treatment !== "panel") {
    const meta = await sharp(baseBytes).rotate().metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    if (!w || !h || Math.max(1200 / w, 1500 / h) > 1.45) treatment = "panel";
  }
  if (treatment === "panel") {
    const photo = await sharp(baseBytes).rotate().resize(1200, 860, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
    return sharp(Buffer.from(photoPanelSvg(spec, brand, credit)))
      .png()
      .composite([{ input: photo, top: 0, left: 0 }])
      .toBuffer();
  }
  let base = sharp(baseBytes).rotate().resize(1200, 1500, { fit: "cover" });
  if (treatment === "duotone") {
    // Brand-blue duotone: grayscale, tinted toward the accent, slightly dimmed
    // so the type always clears it.
    base = base.grayscale().tint({ r: 74, g: 128, b: 196 }).modulate({ brightness: 0.92 });
  }
  const overlay =
    treatment === "statBig" ? photoStatBigSvg(spec, brand, credit) :
    treatment === "band" ? photoOverlaySvg(spec, credit) :
    photoScrimSvg(spec, brand, credit);
  return base.composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

/** Render the spec in the variant's look -> PNG -> library. Real photos lead:
 *  licensed stock (auto-imported for the post's own scene) and the recruiter's
 *  uploads carry branded treatments; the SVG data-graphic layouts follow. */
async function renderStatCard(ws: string, spec: StatMediaSpec, variant: number, opts: { preferPhoto?: boolean } = {}): Promise<PosterImage> {
  const s = wsState(ws);
  const brand = s.settings.brandLine || "";
  // Real photos from the library become card backdrops; generated cards and
  // PDFs are excluded so a card never sits on top of another card.
  const uploads = s.images.filter((i) => i.kind === "upload" && i.mime.startsWith("image/"));
  let stock: PosterImage[] = [];
  try { stock = await ensureStockPhotos(ws, spec); } catch { stock = []; }

  // Photo looks first (treatment-major, so consecutive clicks change the
  // photo before repeating a treatment), then the SVG chart layouts.
  const treats = photoTreatmentsFor(spec);
  const pics = stock.slice(0, 3);
  const photoLooks: { img: PosterImage; treatment: PhotoTreatment }[] = [];
  for (let ti = 0; ti < treats.length; ti++) {
    for (let pi = 0; pi < pics.length; pi++) {
      photoLooks.push({ img: pics[pi], treatment: treats[(ti + pi) % treats.length] });
    }
  }
  const svgCombos = cardCombos(spec, uploads.length);
  const total = photoLooks.length + svgCombos.length;
  const idx = opts.preferPhoto && photoLooks.length
    ? ((variant % photoLooks.length) + photoLooks.length) % photoLooks.length
    : ((variant % total) + total) % total;

  const sharp = (await import("sharp")).default;
  let bytes: Buffer | null = null;
  if (idx < photoLooks.length) {
    const look = photoLooks[idx];
    try {
      const base = await fs.readFile(path.join(mediaDir(), look.img.file));
      bytes = await renderPhotoLook(base, spec, look.treatment, brand, look.img.credit);
    } catch { bytes = null; /* bad or missing photo file: use an SVG look */ }
  } else {
    const combo = svgCombos[idx - photoLooks.length];
    if (combo.template === "photoHead" && uploads.length) {
      try {
        const photo = uploads[((variant % uploads.length) + uploads.length) % uploads.length];
        const base = await fs.readFile(path.join(mediaDir(), photo.file));
        bytes = await sharp(base)
          .rotate() // honor EXIF before the cover crop
          .resize(1200, 1500, { fit: "cover" })
          .composite([{ input: Buffer.from(photoOverlaySvg(spec)) }])
          .png()
          .toBuffer();
      } catch { bytes = null; }
    }
    if (!bytes) {
      const t = combo.template === "photoHead" ? cardTemplates(spec)[0] : combo.template;
      bytes = await sharp(Buffer.from(statMediaSvg(spec, t, combo.dark))).png().toBuffer();
    }
  }
  if (!bytes) {
    bytes = await sharp(Buffer.from(statMediaSvg(spec, cardTemplates(spec)[0], false))).png().toBuffer();
  }
  return saveRenderedCard(s, bytes, spec.headline);
}

/** Finished PNG -> media library entry (kind "card"). */
async function saveRenderedCard(s: WorkspaceState, bytes: Buffer, headline: string): Promise<PosterImage> {
  const id = rid();
  const file = id + ".png";
  await writeMedia(file, bytes);
  const img: PosterImage = {
    id, file, mime: "image/png", kind: "card",
    name: ("AI media: " + headline).slice(0, 80),
    createdAt: nowIso(),
  };
  s.images.unshift(img);
  persist();
  return img;
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

export async function saveSettings(ws: string, patch: Partial<PosterSettings>, userId?: string): Promise<PosterSettings> {
  await ensureLoaded();
  const s = wsState(ws);
  const clean = (v: unknown, max: number) => (typeof v === "string" ? scrubDashes(v).slice(0, max) : undefined);
  // Timezone must be a real IANA zone or it is ignored.
  let tz = s.settings.timezone;
  if (typeof patch.timezone === "string" && patch.timezone.trim()) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone.trim() }); tz = patch.timezone.trim().slice(0, 60); } catch { /* keep old */ }
  }
  // Autopilot publishes from a real person's seat: stamp whoever turns it on.
  let autopilot = s.settings.autopilot === true;
  let autopilotUserId = s.settings.autopilotUserId;
  if (typeof patch.autopilot === "boolean") {
    autopilot = patch.autopilot;
    if (patch.autopilot && userId) autopilotUserId = userId;
  }
  const next: PosterSettings = {
    autopilot,
    autopilotUserId,
    timezone: tz,
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
  autopilotNote?: { at: string; note: string };
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
    autopilotNote: s.autopilotNote,
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
