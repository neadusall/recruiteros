/**
 * RecruitersOS · LinkedIn Poster (Tools > BD)
 *
 * Inspiration-to-approved-post pipeline:
 *   1. INBOX      — the recruiter saves posts they like (paste author + text).
 *   2. REWRITE    — the LLM extracts the INSIGHT and rebuilds it as a first-person
 *                   story in the recruiter's own voice (never a paraphrase).
 *   3. IMAGE      — attach one from the approved library, or generate a branded
 *                   quote card server-side (SVG -> sharp -> PNG).
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
  text: string;
  imageId?: string;
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
  /** Ayrshare user-profile key for this workspace (Business plan); blank = primary. */
  ayrshareProfileKey: string;
}

interface WorkspaceState {
  inbox: InspirationItem[];
  drafts: PosterDraft[];
  images: PosterImage[];
  settings: PosterSettings;
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
  return { displayName: "", headline: "", voiceProfile: "", storyBank: "", ayrshareProfileKey: "" };
}

function wsState(ws: string): WorkspaceState {
  let s = store.workspaces[ws];
  if (!s) {
    s = { inbox: [], drafts: [], images: [], settings: defaultSettings() };
    store.workspaces[ws] = s;
  }
  if (!s.settings) s.settings = defaultSettings();
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

/* ----------------------------- rewriter --------------------------------- */

const MODEL = () => process.env.RECRUITEROS_POSTER_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

function rewriteSystem(settings: PosterSettings): string {
  return `You ghostwrite LinkedIn posts for a recruiter. You are given a SOURCE POST someone else wrote. Your job is NOT to paraphrase it. Extract the underlying INSIGHT, discard the wording entirely, and rebuild it as a first-person post in the recruiter's own voice, so it reads as their real story and point of view.

THE RECRUITER'S VOICE PROFILE (follow it exactly):
${settings.voiceProfile || "Plainspoken, direct, warm. A working recruiter talking to their market, not a content marketer."}

REAL STORY BANK (true anecdotes you may draw from; use at most one per post):
${settings.storyBank || "(none provided)"}

ABSOLUTE TRUTH RULES (non-negotiable, house rule):
- NEVER fabricate a placement, a client, a candidate, a name, a number, a metric, or an outcome.
- If the story bank has a relevant TRUE story, tell it. If not, write insight-led from professional experience in general terms, without inventing specifics.
- Never imply the source post's experiences happened to the recruiter.

FORMAT RULES:
- First line is the hook: under 60 characters, no clickbait, makes a scroller stop.
- Short paragraphs, 1-2 sentences each, blank line between them. 600-1300 characters total.
- End with one light question or takeaway line, not a hard CTA.
- NO em-dashes anywhere. Use commas, colons, periods, or parentheses instead.
- No emoji. No hashtag walls: zero to three relevant hashtags at the very end, or none.
- No "I saw a post about..." framing. The idea is presented as the recruiter's own thinking.

Return ONLY the post text. No preamble, no quotes around it, no markdown.`;
}

export async function rewriteToDraft(ws: string, opts: {
  inspirationId?: string;
  text?: string;
  author?: string;
  guidance?: string;
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
    text,
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
  const sourceText = src?.text ?? d.text;
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

/* ------------------------------ drafts ---------------------------------- */

export async function updateDraft(ws: string, draftId: string, patch: { text?: string; imageId?: string | null }): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  if (typeof patch.text === "string") d.text = scrubDashes(patch.text).slice(0, 3000);
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
export async function approveDraft(ws: string, draftId: string, when?: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status === "posted") throw Object.assign(new Error("already_posted"), { status: 400 });
  if (!d.text.trim()) throw Object.assign(new Error("empty_post"), { status: 400 });

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
 * Can the workspace publish through our own LinkedIn engine (LinkedIn OS ->
 * Unipile)? Ready = the Unipile key is set AND the workspace has a linked
 * LinkedIn account in the engine. This is the PRIMARY publish path; Ayrshare
 * stays as an optional official-API alternative.
 */
export interface EnginePublishStatus {
  configured: boolean;
  account: { accountId: string; displayName?: string } | null;
  ready: boolean;
}

export async function enginePublishStatus(ws: string): Promise<EnginePublishStatus> {
  try {
    const { unipile } = await import("../providers");
    const { listAccounts } = await import("./os/health");
    const configured = unipile.configured();
    const acct = (await listAccounts(ws)).find((a) => a.providerAccountId) ?? null;
    return {
      configured,
      account: acct ? { accountId: acct.accountId, displayName: acct.displayName } : null,
      ready: configured && !!acct,
    };
  } catch {
    return { configured: false, account: null, ready: false };
  }
}

async function publishDraft(ws: string, d: PosterDraft): Promise<PosterDraft> {
  const s = wsState(ws);
  try {
    const engine = await enginePublishStatus(ws);
    if (engine.ready) {
      // Our own pipe: the LinkedIn OS Unipile connection (tool of record).
      const { unipile } = await import("../providers");
      const { listAccounts } = await import("./os/health");
      const acct = (await listAccounts(ws)).find((a) => a.providerAccountId)!;
      let attachments: Array<{ bytes: Buffer; mime: string; name: string }> | undefined;
      if (d.imageId) {
        const media = await readMediaById(d.imageId);
        if (media) {
          const ext = media.mime === "image/png" ? ".png" : media.mime === "image/webp" ? ".webp" : ".jpg";
          attachments = [{ bytes: media.bytes, mime: media.mime, name: "post" + ext }];
        }
      }
      const r = await unipile.createPost(acct.providerAccountId as string, d.text, attachments);
      if (r.dryRun) throw new Error("engine_not_configured: set UNIPILE_API_KEY");
      d.provider = "engine";
      d.providerPostId = r.id;
      d.postUrl = undefined; // the engine path doesn't return a share URL
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
      throw new Error("no_publisher: connect your LinkedIn account in the LinkedIn tool (our engine), or set AYRSHARE_API_KEY as an alternative");
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
export async function retryDraft(ws: string, draftId: string): Promise<PosterDraft> {
  await ensureLoaded();
  const s = wsState(ws);
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d) throw Object.assign(new Error("draft_not_found"), { status: 404 });
  if (d.status !== "failed") throw Object.assign(new Error("not_failed"), { status: 400 });
  return publishDraft(ws, d);
}

/* ------------------------------ images ---------------------------------- */

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export async function uploadImage(ws: string, opts: { name?: string; dataUrl: string }): Promise<PosterImage> {
  await ensureLoaded();
  const s = wsState(ws);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(opts.dataUrl);
  if (!m) throw Object.assign(new Error("bad_image: expected a png, jpeg, or webp data URL"), { status: 400 });
  const mime = m[1];
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 8 * 1024 * 1024) throw Object.assign(new Error("image_too_large: 8MB max"), { status: 400 });
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
}

export async function getState(ws: string): Promise<PosterState> {
  await ensureLoaded();
  const s = wsState(ws);
  return {
    inbox: s.inbox,
    drafts: s.drafts.filter((d) => d.status !== "discarded"),
    images: s.images,
    settings: s.settings,
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
