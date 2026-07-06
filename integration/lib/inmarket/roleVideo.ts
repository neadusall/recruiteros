/**
 * RecruitersOS · In-Market · Picture-in-picture role VIDEO compositor
 *
 * GOAL: take the verified auto-scroll capture of a hiring company's own careers page
 * (lib/inmarket/roleShot) and overlay a RECORDED WEBCAM CLIP of the user as a
 * picture-in-picture (Loom / BombBomb style), so every hiring-signal asset can be
 * personalized per recipient. We emit two assets per (role, clip, layout):
 *
 *   1. a customized GIF  — page scroll + you in the corner, muted, loops (email-embeddable), and
 *   2. an MP4 with audio — the same composite WITH your voice (for a "watch" / landing link).
 *
 * The page-scroll GIF (already captured + correctness-gated by roleShot) is the background;
 * the webcam clip drives the duration and the page loops underneath. The PiP is fully
 * customizable: corner, size, shape (circle / rounded / rectangle) and a colored border.
 *
 * Cost: 100% self-hosted. Compositing is done with ffmpeg (no paid API). The alpha mask +
 * border ring are generated in pure JS (pngjs, already a dep). Outputs are cached on disk
 * under ROS_DATA_DIR/videos so each (role, clip, layout) renders at most once.
 *
 * ffmpeg: resolved from $FFMPEG_PATH or `ffmpeg` on PATH (apt-installable on the server;
 * present via winget on the dev box). If ffmpeg is missing, composition fails gracefully with
 * a clear status — the underlying GIF/PNG assets are unaffected.
 */

import { join } from "node:path";
import { mkdir, writeFile, readFile, stat, unlink, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { captureRoleShot, renderScrollVideoAtDuration, shotKey, shotsDir, type ShotRequest } from "./roleShot";
import { loadSnapshot, debouncedSaver } from "../db";
import { s3Enabled, s3Put, s3Get, s3Head } from "./assetStore";

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

export type PipCorner = "br" | "bl" | "tr" | "tl";
export type PipShape = "circle" | "rounded" | "rect";

/** Where + how the recorded clip sits on top of the page scroll. All sizes are % of the
 *  background width so layouts are resolution-independent. */
export interface PipConfig {
  corner: PipCorner;
  /** PiP width as a % of the background width (clamped 12–55). */
  sizePct: number;
  /** Inset from the edges, as a % of the background width (clamped 0–20). */
  marginPct: number;
  shape: PipShape;
  /** Border ring thickness in px (0 = no border). */
  borderPx: number;
  /** Border color, "#rrggbb". */
  borderColor: string;
  /** Corner radius for "rounded", as a % of the PiP width (clamped 0–50). */
  radiusPct: number;
  /** FREE position: bubble top-left as a % of the free space (0–100). When BOTH are set they
   *  override `corner`/`marginPct` — this is the Loom-style drag-anywhere placement. */
  xPct?: number;
  yPct?: number;
}

export const DEFAULT_PIP: PipConfig = {
  corner: "br",
  sizePct: 26,
  marginPct: 3,
  shape: "circle",
  borderPx: 4,
  borderColor: "#19c37d", // RecruitersOS green
  radiusPct: 18,
};

export type VideoStatus =
  | "ready"      // composite assets exist on disk
  | "composing"  // a background render is in progress; re-request shortly
  | "no_shot"    // the page-scroll GIF couldn't be captured/verified (see roleShot reason)
  | "no_clip"    // the referenced webcam clip doesn't exist
  | "no_ffmpeg"  // ffmpeg isn't installed/resolvable
  | "error";

export interface VideoResult {
  ok: boolean;
  status: VideoStatus;
  /** Stable key the composite assets are stored/served under. */
  key?: string;
  /** Which composite assets exist, by format. Served via the video route by (key, fmt). */
  files?: { gif?: boolean; mp4?: boolean };
  /** The page we used as the background (the company's own careers URL). */
  pageUrl?: string;
  reason?: string;
  at?: string;
}

/** A stored webcam recording the user can reuse across many roles. */
export interface ClipMeta {
  id: string;
  workspaceId: string;
  ext: string;        // container ext, e.g. "webm" | "mp4"
  mime: string;
  bytes: number;
  label?: string;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

// The GIF is the EMAIL TEASER (the full video + audio lives on the watch page), so it's tuned
// for inbox weight + deliverability: narrow, low fps, and capped to a short looping teaser.
const GIF_W = 480;             // email GIF width (downscaled from the full composite)
const GIF_FPS = 10;
const EMAIL_GIF_SECONDS = 8;   // cap the teaser length; the watch-page MP4 plays the whole take
const CLIPS_CACHE_KEY = "inmarket_clips_v1";
const VIDEOS_CACHE_KEY = "inmarket_videos_v1";

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function videosDir(): string {
  const base = process.env.ROS_DATA_DIR || join(process.cwd(), ".data");
  return join(base, "videos");
}
function clipsDir(): string {
  return join(videosDir(), "clips");
}
function clipPath(id: string, ext: string): string {
  return join(clipsDir(), `${id}.${ext}`);
}
function compositePath(key: string, fmt: "gif" | "mp4"): string {
  return join(videosDir(), `${key}.${fmt}`);
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Clip registry (durable via the Postgres snapshot KV)               */
/* ------------------------------------------------------------------ */

let clipMem: Map<string, ClipMeta> | null = null;
let clipLoading: Promise<void> | null = null;

async function ensureClips(): Promise<Map<string, ClipMeta>> {
  if (clipMem) return clipMem;
  if (!clipLoading) {
    clipLoading = (async () => {
      const raw = (await loadSnapshot<Record<string, ClipMeta>>(CLIPS_CACHE_KEY).catch(() => null)) || {};
      clipMem = new Map(Object.entries(raw));
    })().catch(() => { clipMem = new Map(); });
  }
  await clipLoading;
  return clipMem ?? (clipMem = new Map());
}
const saveClips = debouncedSaver(CLIPS_CACHE_KEY, () => (clipMem ? Object.fromEntries(clipMem) : {}), 1000);

const EXT_BY_MIME: Record<string, string> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

/** Persist an uploaded webcam recording. Returns its reusable metadata. */
export async function saveClip(
  workspaceId: string,
  data: Buffer,
  opts: { mime?: string; label?: string } = {},
): Promise<ClipMeta> {
  const mime = (opts.mime || "video/webm").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime] || "webm";
  const id = randomUUID();
  await mkdir(clipsDir(), { recursive: true });
  await writeFile(clipPath(id, ext), data);
  if (s3Enabled()) {
    // Mirror the source clip to object storage. Clips are few (recorded once, reused across many
    // sends) so we keep the local copy too — the in-flight render consumes it without a round-trip.
    try { await s3Put(clipS3Key(id, ext), data, mime); } catch { /* keep local-only on failure */ }
  }
  const meta: ClipMeta = {
    id, workspaceId, ext, mime, bytes: data.length,
    label: opts.label?.slice(0, 120), at: new Date().toISOString(),
  };
  const clips = await ensureClips();
  clips.set(id, meta);
  saveClips();
  return meta;
}

export async function getClip(id: string): Promise<ClipMeta | null> {
  if (!/^[a-f0-9-]{8,40}$/i.test(id)) return null;
  const clips = await ensureClips();
  return clips.get(id) ?? null;
}

export async function readClipBytes(id: string): Promise<{ buf: Buffer; mime: string } | null> {
  const meta = await getClip(id);
  if (!meta) return null;
  try {
    return { buf: await readFile(clipPath(id, meta.ext)), mime: meta.mime };
  } catch {
    // Local copy evicted after S3 offload — pull from object storage.
    if (s3Enabled()) {
      const buf = await s3Get(clipS3Key(id, meta.ext));
      if (buf) return { buf, mime: meta.mime };
    }
    return null;
  }
}

/** Absolute local path of a stored clip (re-materialized from S3 if evicted) for ffmpeg consumers. */
export async function localClipPath(id: string): Promise<string | null> {
  const meta = await getClip(id);
  if (!meta) return null;
  await materializeClip(meta);
  const p = clipPath(meta.id, meta.ext);
  return (await fileExists(p)) ? p : null;
}

export async function listClips(workspaceId: string): Promise<ClipMeta[]> {
  const clips = await ensureClips();
  return [...clips.values()]
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function deleteClip(workspaceId: string, id: string): Promise<boolean> {
  const clips = await ensureClips();
  const meta = clips.get(id);
  if (!meta || meta.workspaceId !== workspaceId) return false;
  clips.delete(id);
  saveClips();
  await unlink(clipPath(id, meta.ext)).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ */
/* Composite verdict cache (so a layout renders at most once)         */
/* ------------------------------------------------------------------ */

interface VideoRow extends VideoResult { at: string }
let vidMem: Map<string, VideoRow> | null = null;
let vidLoading: Promise<void> | null = null;

async function ensureVideos(): Promise<Map<string, VideoRow>> {
  if (vidMem) return vidMem;
  if (!vidLoading) {
    vidLoading = (async () => {
      const raw = (await loadSnapshot<Record<string, VideoRow>>(VIDEOS_CACHE_KEY).catch(() => null)) || {};
      vidMem = new Map(Object.entries(raw));
    })().catch(() => { vidMem = new Map(); });
  }
  await vidLoading;
  return vidMem ?? (vidMem = new Map());
}
const saveVideos = debouncedSaver(VIDEOS_CACHE_KEY, () => (vidMem ? Object.fromEntries(vidMem) : {}), 1500);

/* ------------------------------------------------------------------ */
/* PiP config + key derivation                                        */
/* ------------------------------------------------------------------ */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Coerce arbitrary client input into a safe, bounded PipConfig. */
export function normalizePip(p?: Partial<PipConfig> | null): PipConfig {
  const d = DEFAULT_PIP;
  const corner = (["br", "bl", "tr", "tl"] as PipCorner[]).includes(p?.corner as PipCorner) ? (p!.corner as PipCorner) : d.corner;
  const shape = (["circle", "rounded", "rect"] as PipShape[]).includes(p?.shape as PipShape) ? (p!.shape as PipShape) : d.shape;
  const color = /^#[0-9a-f]{6}$/i.test(String(p?.borderColor)) ? String(p!.borderColor) : d.borderColor;
  const hasFree = p?.xPct != null && p?.yPct != null && Number.isFinite(Number(p?.xPct)) && Number.isFinite(Number(p?.yPct));
  return {
    corner, shape, borderColor: color,
    sizePct: clamp(Number(p?.sizePct ?? d.sizePct), 12, 55),
    marginPct: clamp(Number(p?.marginPct ?? d.marginPct), 0, 20),
    borderPx: clamp(Math.round(Number(p?.borderPx ?? d.borderPx)), 0, 24),
    radiusPct: clamp(Number(p?.radiusPct ?? d.radiusPct), 0, 50),
    ...(hasFree ? { xPct: clamp(Number(p!.xPct), 0, 100), yPct: clamp(Number(p!.yPct), 0, 100) } : {}),
  };
}

/** Stable composite key for a (role, clip, layout[, spoken first name]) tuple. Including the
 *  normalized name means each "Hey Sarah" composite is reused for every Sarah at that role. */
export function videoKey(company: string, roleTitle: string, clipId: string, pip: PipConfig, firstName?: string | null, durationSec?: number): string {
  const rk = shotKey(company, roleTitle);
  const nm = (firstName || "").trim().toLowerCase();
  // durationSec is the EXPLICIT override (0 = auto-match the clip's own length, which is already
  // pinned down by clipId) — so an overridden length caches as its own composite.
  const dur = durationSec && durationSec > 0 ? Math.round(durationSec) : 0;
  const h = createHash("sha1").update(JSON.stringify({ clipId, pip, nm, dur })).digest("hex").slice(0, 12);
  return `${rk}__${h}`;
}

/** Read one composite asset for the serve route. Returns null when absent. */
export async function readCompositeAsset(key: string, fmt: "gif" | "mp4"): Promise<Buffer | null> {
  if (!/^[a-z0-9_-]{3,120}$/.test(key)) return null;
  try {
    return await readFile(compositePath(key, fmt));
  } catch {
    // Local copy evicted after S3 offload — serve from object storage.
    if (s3Enabled()) return s3Get(compositeS3Key(key, fmt));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Object-storage offload (S3-compatible; inert until ROS_S3_* set)    */
/* ------------------------------------------------------------------ */

function compositeS3Key(key: string, fmt: "gif" | "mp4"): string { return `videos/${key}.${fmt}`; }
function clipS3Key(id: string, ext: string): string { return `clips/${id}.${ext}`; }
const MIME_BY_FMT: Record<"gif" | "mp4", string> = { gif: "image/gif", mp4: "video/mp4" };

/** Dedup/exists check spanning the local render cache AND object storage. */
async function compositeExists(key: string, fmt: "gif" | "mp4"): Promise<boolean> {
  if (await fileExists(compositePath(key, fmt))) return true;
  if (s3Enabled()) return s3Head(compositeS3Key(key, fmt));
  return false;
}

/** After a successful render, push the two served artifacts to object storage and drop the local
 *  copies — so the app disk stays flat regardless of how many recipients are rendered. On upload
 *  failure the local copy is kept (the read path still finds it), so nothing is ever lost. */
async function publishComposite(key: string, files: VideoResult["files"]): Promise<void> {
  if (!s3Enabled()) return;
  for (const fmt of ["mp4", "gif"] as const) {
    if (!files?.[fmt]) continue;
    const local = compositePath(key, fmt);
    try {
      await s3Put(compositeS3Key(key, fmt), await readFile(local), MIME_BY_FMT[fmt]);
      await unlink(local).catch(() => {});
    } catch { /* keep the local copy on failure */ }
  }
}

/** Ensure the source clip is on local disk so ffmpeg (which can't read S3) can consume it. */
async function materializeClip(clip: ClipMeta): Promise<void> {
  const local = clipPath(clip.id, clip.ext);
  if (await fileExists(local)) return;
  if (!s3Enabled()) return;
  const buf = await s3Get(clipS3Key(clip.id, clip.ext));
  if (buf) {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(local, buf);
  }
}

/* ------------------------------------------------------------------ */
/* Mask + border generation (pure JS via pngjs)                       */
/* ------------------------------------------------------------------ */

let _PNG: any;
async function getPNG(): Promise<any> {
  if (_PNG) return _PNG;
  const m: any = await import("pngjs");
  _PNG = m.PNG ?? m.default?.PNG ?? m.default;
  return _PNG;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Signed distance to a rounded rectangle centered in a w×h box (<=0 means inside). */
function sdRoundRect(x: number, y: number, w: number, h: number, r: number): number {
  const cx = w / 2, cy = h / 2;
  const halfW = w / 2, halfH = h / 2;
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** True when (x,y) is inside the PiP shape. */
function insideShape(shape: PipShape, x: number, y: number, w: number, h: number, r: number): boolean {
  if (shape === "rect") return true;
  if (shape === "circle") {
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  }
  return sdRoundRect(x + 0.5, y + 0.5, w, h, r) <= 0;
}

/** Distance to the shape edge — used to lay down a border band of `borderPx`. */
function edgeDistance(shape: PipShape, x: number, y: number, w: number, h: number, r: number): number {
  if (shape === "circle") {
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2;
    return rad - Math.hypot(x + 0.5 - cx, y + 0.5 - cy); // >=0 inside, distance to rim
  }
  if (shape === "rounded") {
    return -sdRoundRect(x + 0.5, y + 0.5, w, h, r); // >=0 inside
  }
  // rect: distance to nearest of the four edges
  return Math.min(x, y, w - 1 - x, h - 1 - y);
}

/** Grayscale alpha mask (white = keep, black = cut) for ffmpeg `alphamerge`. */
async function genMaskPng(shape: PipShape, w: number, h: number, r: number): Promise<Buffer> {
  const PNG = await getPNG();
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      const v = insideShape(shape, x, y, w, h, r) ? 255 : 0;
      png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** RGBA border ring (transparent center) overlaid on top of the masked clip. */
async function genBorderPng(
  shape: PipShape, w: number, h: number, r: number, borderPx: number, color: string,
): Promise<Buffer> {
  const PNG = await getPNG();
  const [cr, cg, cb] = hexRgb(color);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      const d = edgeDistance(shape, x, y, w, h, r); // >=0 inside the shape
      const onRing = d >= 0 && d <= borderPx;
      png.data[i] = cr; png.data[i + 1] = cg; png.data[i + 2] = cb;
      png.data[i + 3] = onRing ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

/* ------------------------------------------------------------------ */
/* ffmpeg                                                              */
/* ------------------------------------------------------------------ */

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Run ffmpeg with an arg array. Rejects with the tail of stderr on failure. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegBin(), args, { windowsHide: true });
    } catch (e) {
      return reject(new Error(`ffmpeg spawn failed: ${(e as Error).message}`));
    }
    let err = "";
    proc.stderr?.on("data", (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    proc.on("error", (e: any) => reject(e?.code === "ENOENT" ? new Error("ffmpeg_not_found") : e));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
}

/** Quick probe so we can return a friendly `no_ffmpeg` status instead of a cryptic error. */
async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runFfmpeg(["-hide_banner", "-version"]);
    return true;
  } catch {
    return false;
  }
}

/** ffprobe binary — derived from FFMPEG_PATH (…/ffmpeg → …/ffprobe) or FFPROBE_PATH, else "ffprobe". */
function ffprobeBin(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ff = process.env.FFMPEG_PATH;
  if (ff && /ffmpeg/i.test(ff)) return ff.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return "ffprobe";
}

/** Duration of a media file in ms (the recorded webcam clip), or null if ffprobe can't read it. */
async function probeDurationMs(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    let out = "";
    proc.stdout?.on("data", (d) => { out += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const sec = parseFloat(out.trim());
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* The composite                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the ffmpeg filter graph that lays the (masked, bordered) webcam clip onto the looping
 * page-scroll background. Produces the full-res composite (input to both the MP4 and the GIF).
 */
function buildFilter(
  bgW: number, bgH: number, pip: PipConfig, hasMask: boolean, hasBorder: boolean,
): { filter: string; outLabel: string } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const pipW = even((pip.sizePct / 100) * bgW);
  const pipH = pip.shape === "circle" ? pipW : even(pipW * 0.62); // circles are square; others 16:10-ish
  const margin = Math.round((pip.marginPct / 100) * bgW);

  // Placement: free drag (xPct/yPct of the free space) overrides corner+margin.
  let X: string, Y: string;
  if (pip.xPct != null && pip.yPct != null) {
    X = `(W-w)*${(pip.xPct / 100).toFixed(4)}`;
    Y = `(H-h)*${(pip.yPct / 100).toFixed(4)}`;
  } else {
    const left = pip.corner === "bl" || pip.corner === "tl";
    const top = pip.corner === "tl" || pip.corner === "tr";
    X = left ? `${margin}` : `W-w-${margin}`;
    Y = top ? `${margin}` : `H-h-${margin}`;
  }

  // Input order: [0]=bg gif, [1]=clip, [2]=mask?, [3]=border?
  const maskIdx = 2;
  const borderIdx = hasMask ? 3 : 2;

  const parts: string[] = [];
  parts.push(`[0:v]scale=${bgW}:${bgH}:force_original_aspect_ratio=decrease,pad=${bgW}:${bgH}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[bg]`);
  parts.push(`[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},setsar=1[fg0]`);

  let fg = "fg0";
  if (hasMask) {
    parts.push(`[${maskIdx}:v]format=gray,scale=${pipW}:${pipH}[mk]`);
    parts.push(`[fg0][mk]alphamerge[fgm]`);
    fg = "fgm";
  }
  parts.push(`[bg][${fg}]overlay=${X}:${Y}:format=auto[ov0]`);

  let last = "ov0";
  if (hasBorder) {
    parts.push(`[${borderIdx}:v]scale=${pipW}:${pipH}[bd]`);
    parts.push(`[ov0][bd]overlay=${X}:${Y}[ov1]`);
    last = "ov1";
  }
  return { filter: parts.join(";"), outLabel: last };
}

/** Background dimensions from roleShot's capture constants (the GIF is FRAME_W×FRAME_H). */
const BG_W = 1000;
const BG_H = 620;

async function compose(
  key: string, bgPath: string, clip: ClipMeta, pip: PipConfig,
  introAudioPath?: string | null, introFacePath?: string | null,
): Promise<{ files: VideoResult["files"] }> {
  await mkdir(videosDir(), { recursive: true });
  const clipFile = clipPath(clip.id, clip.ext);

  const wantMask = pip.shape !== "rect";
  const wantBorder = pip.borderPx > 0;

  // Write the mask + border helper PNGs (sized to the PiP box).
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const pipW = even((pip.sizePct / 100) * BG_W);
  const pipH = pip.shape === "circle" ? pipW : even(pipW * 0.62);
  const radius = Math.round((pip.radiusPct / 100) * pipW);

  const tmpMask = join(videosDir(), `${key}.mask.png`);
  const tmpBorder = join(videosDir(), `${key}.border.png`);
  if (wantMask) await writeFile(tmpMask, await genMaskPng(pip.shape, pipW, pipH, radius));
  if (wantBorder) await writeFile(tmpBorder, await genBorderPng(pip.shape, pipW, pipH, radius, pip.borderPx, pip.borderColor));

  const inputs = (): string[] => {
    const a = ["-stream_loop", "-1", "-i", bgPath, "-i", clipFile];
    if (wantMask) a.push("-i", tmpMask);
    if (wantBorder) a.push("-i", tmpBorder);
    return a;
  };

  const baseMp4 = join(videosDir(), `${key}.base.mp4`);
  const blendedIntro = join(videosDir(), `${key}.introx.wav`);
  const files: VideoResult["files"] = {};
  try {
    // (1) BASE composite WITH the user's voice. Background looped (-stream_loop -1); the webcam
    //     clip drives the length (-shortest). Written to a temp so the GIF derives from it and the
    //     optional name-intro can be prepended for the final MP4.
    {
      const { filter, outLabel } = buildFilter(BG_W, BG_H, pip, wantMask, wantBorder);
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        ...inputs(),
        "-filter_complex", filter, "-map", `[${outLabel}]`, "-map", "1:a?",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest",
        baseMp4,
      ]);
    }
    // (2) GIF — the LIVELY email teaser, derived from the base (no name-intro hold). Deriving from
    //     the finite base (not the infinitely-looped bg) lets palettegen see a clean EOF.
    {
      const gw = Math.max(2, Math.round(GIF_W / 2) * 2);
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-t", String(EMAIL_GIF_SECONDS), "-i", baseMp4,
        "-filter_complex",
        `fps=${GIF_FPS},scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        "-loop", "0",
        compositePath(key, "gif"),
      ]);
      files.gif = true;
    }
    // (3) FINAL MP4 — prepend the personalized "Hey {name}," greeting. Preference order:
    //     (a) LIP-SYNCED greeting (the cloned name AND the mouth matches it),
    //     (b) cloned voice over a frozen first frame (no mouth motion),
    //     (c) the bare base composite (no name) — each degrades cleanly to the next.
    let prepended = false;
    if (introFacePath && introAudioPath) prepended = await prependLipSyncGreeting(key, baseMp4, introFacePath, introAudioPath, pip);
    if (!prepended && introAudioPath) prepended = await prependNameIntro(key, baseMp4, introAudioPath);
    if (!prepended) await rename(baseMp4, compositePath(key, "mp4"));
    files.mp4 = true;
  } finally {
    await unlink(tmpMask).catch(() => {});
    await unlink(tmpBorder).catch(() => {});
    await unlink(baseMp4).catch(() => {});
    await unlink(blendedIntro).catch(() => {});
  }
  return { files };
}

/**
 * Prepend the cloned-voice name intro to the composite: freeze the first frame for the length of
 * the "Hey {name}," audio (so there's no lip-sync mismatch), then play the recorded composite.
 * Writes compositePath(key,"mp4"). Returns false (caller keeps the base) on any ffmpeg failure.
 */
async function prependNameIntro(key: string, baseMp4: string, audioPath: string): Promise<boolean> {
  const ff = join(videosDir(), `${key}.ff.png`);
  const intro = join(videosDir(), `${key}.intro.mp4`);
  try {
    // First frame of the composite (mouth-neutral hold during the spoken name).
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", baseMp4, "-frames:v", "1", ff]);
    // Still-frame intro lasting exactly the name audio (capped at 6s for safety).
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-i", ff, "-i", audioPath, "-t", "6",
      "-vf", `scale=${BG_W}:${BG_H},format=yuv420p,fps=30,setsar=1`,
      "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", intro,
    ]);
    // Concat intro + composite, normalizing streams so the join is clean.
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error", "-i", intro, "-i", baseMp4,
      "-filter_complex",
      `[0:v]fps=30,scale=${BG_W}:${BG_H},setsar=1[v0];[1:v]fps=30,scale=${BG_W}:${BG_H},setsar=1[v1];` +
      `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", compositePath(key, "mp4"),
    ]);
    return true;
  } catch (e) {
    console.error(`[roleVideo] name-intro prepend failed for ${key}:`, (e as Error).message);
    return false;
  } finally {
    await unlink(ff).catch(() => {});
    await unlink(intro).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Lip-synced greeting (the cloned name AND a matching mouth)          */
/* ------------------------------------------------------------------ */

function greetingsDir(): string {
  return join(videosDir(), "greetings");
}
/** Cache one lip-synced greeting per (clip, voice, name) — render the mouth for "Hey Sarah," once. */
function greetingFaceCachePath(clipId: string, voiceId: string | undefined, name: string): string {
  const h = createHash("sha1").update(`${clipId}|${voiceId || "default"}|${name.toLowerCase()}`).digest("hex").slice(0, 16);
  return join(greetingsDir(), `${h}.mp4`);
}

/**
 * Produce a SHORT video of the operator's face with the mouth re-rendered to say the cloned
 * "Hey {name}," audio, via the pluggable lip-sync microservice (lib/inmarket/lipSync). Cached per
 * (clip, voice, name) so a name is lip-synced ONCE and reused forever — matching the audio cache,
 * since lip-sync is the expensive step. Returns null (caller uses the frozen-frame intro) when
 * lip-sync isn't configured or the render fails.
 */
async function buildLipSyncedFace(
  clip: ClipMeta, introAudioPath: string, firstName: string, voiceId?: string,
): Promise<string | null> {
  const { lipSyncConfigured, lipSyncToFile } = await import("./lipSync");
  if (!lipSyncConfigured()) return null;

  await mkdir(greetingsDir(), { recursive: true });
  const cachePath = greetingFaceCachePath(clip.id, voiceId, firstName);
  if (await fileExists(cachePath)) return cachePath; // already synced this name in this voice

  // Face driver = first ~4s of the clip, re-encoded to a clean mp4 the model can decode. Reused
  // across names for this clip (the model only needs a neutral talking face to drive).
  const driver = join(greetingsDir(), `${clip.id}.driver.mp4`);
  try {
    if (!(await fileExists(driver))) {
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error", "-i", clipPath(clip.id, clip.ext),
        "-t", "4", "-an", "-vf", `scale=${BG_W}:-2,format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", driver,
      ]);
    }
    const ok = await lipSyncToFile(driver, introAudioPath, cachePath);
    return ok ? cachePath : null;
  } catch (e) {
    console.error("[roleVideo] lip-sync face build failed:", (e as Error).message);
    return null;
  }
}

/** Concatenate two composites (greeting then body), normalizing v/a so the seam is clean. */
async function concatTwo(aMp4: string, bMp4: string, outMp4: string): Promise<void> {
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error", "-i", aMp4, "-i", bMp4,
    "-filter_complex",
    `[0:v]fps=30,scale=${BG_W}:${BG_H},setsar=1[v0];[1:v]fps=30,scale=${BG_W}:${BG_H},setsar=1[v1];` +
    `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outMp4,
  ]);
}

/**
 * Composite the lip-synced face as the PiP bubble over a STILL hold of the body's first frame (the
 * page + the original static bubble), so the page is steady while the mouth says the name and the
 * lip-synced bubble sits exactly where the body bubble is. Audio = the cloned-name mp3. Returns the
 * greeting mp4 path, or null on failure.
 */
async function composeGreeting(
  key: string, framePng: string, faceVideoPath: string, audioPath: string, pip: PipConfig,
): Promise<string | null> {
  const greetingOut = join(videosDir(), `${key}.greet.mp4`);
  const wantMask = pip.shape !== "rect";
  const wantBorder = pip.borderPx > 0;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const pipW = even((pip.sizePct / 100) * BG_W);
  const pipH = pip.shape === "circle" ? pipW : even(pipW * 0.62);
  const radius = Math.round((pip.radiusPct / 100) * pipW);
  const tmpMask = join(videosDir(), `${key}.gmask.png`);
  const tmpBorder = join(videosDir(), `${key}.gborder.png`);
  try {
    if (wantMask) await writeFile(tmpMask, await genMaskPng(pip.shape, pipW, pipH, radius));
    if (wantBorder) await writeFile(tmpBorder, await genBorderPng(pip.shape, pipW, pipH, radius, pip.borderPx, pip.borderColor));

    // Inputs: [0]=held frame (looped image), [1]=lip-synced face, [2]=mask?, [3]=border?, last=audio.
    const inputs = ["-loop", "1", "-i", framePng, "-i", faceVideoPath];
    if (wantMask) inputs.push("-i", tmpMask);
    if (wantBorder) inputs.push("-i", tmpBorder);
    inputs.push("-i", audioPath);
    const audioIdx = 2 + (wantMask ? 1 : 0) + (wantBorder ? 1 : 0);

    const { filter, outLabel } = buildFilter(BG_W, BG_H, pip, wantMask, wantBorder);
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error", ...inputs,
      "-filter_complex", filter, "-map", `[${outLabel}]`, "-map", `${audioIdx}:a`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", greetingOut,
    ]);
    return greetingOut;
  } catch (e) {
    console.error(`[roleVideo] greeting composite failed for ${key}:`, (e as Error).message);
    return null;
  } finally {
    await unlink(tmpMask).catch(() => {});
    await unlink(tmpBorder).catch(() => {});
  }
}

/** Prepend the lip-synced greeting to the body composite. Returns false on any failure. */
async function prependLipSyncGreeting(
  key: string, baseMp4: string, faceVideoPath: string, audioPath: string, pip: PipConfig,
): Promise<boolean> {
  const ff = join(videosDir(), `${key}.gff.png`);
  let greeting: string | null = null;
  try {
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", baseMp4, "-frames:v", "1", ff]);
    greeting = await composeGreeting(key, ff, faceVideoPath, audioPath, pip);
    if (!greeting) return false;
    await concatTwo(greeting, baseMp4, compositePath(key, "mp4"));
    return true;
  } catch (e) {
    console.error(`[roleVideo] lip-sync greeting prepend failed for ${key}:`, (e as Error).message);
    return false;
  } finally {
    await unlink(ff).catch(() => {});
    if (greeting) await unlink(greeting).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

const inflight = new Map<string, Promise<VideoResult>>();

/**
 * Lazy, NON-BLOCKING entry point for the UI. Returns the cached composite immediately when it
 * exists; otherwise kicks the render off in the background and returns status "composing" (a
 * full render takes a few seconds, plus a page capture the first time). The client polls by
 * calling again.
 */
export async function getOrStartVideo(
  req: ShotRequest, clipId: string, pipIn?: Partial<PipConfig>, opts?: { force?: boolean; firstName?: string; voiceId?: string; durationSec?: number },
): Promise<VideoResult> {
  const pip = normalizePip(pipIn);
  const key = videoKey(req.company, req.roleTitle, clipId, pip, opts?.firstName, opts?.durationSec);

  if (!opts?.force && (await compositeExists(key, "gif"))) {
    const cache = await ensureVideos();
    const hit = cache.get(key);
    return hit ? stripRow(hit) : { ok: true, status: "ready", key, files: { gif: true, mp4: await compositeExists(key, "mp4") }, at: new Date().toISOString() };
  }
  if (inflight.has(key)) {
    return { ok: false, status: "composing", key, reason: "composite in progress", at: new Date().toISOString() };
  }
  const p = composeRoleVideo(req, clipId, pip, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return { ok: false, status: "composing", key, reason: "composite started", at: new Date().toISOString() };
}

/**
 * Render (or return cached) the PiP composite for a (role, clip, layout). AWAITS the full
 * render — use getOrStartVideo() from request handlers; call this directly only to block
 * (e.g. a CLI/batch job).
 */
export async function composeRoleVideo(
  req: ShotRequest, clipId: string, pipIn?: Partial<PipConfig>, opts?: { force?: boolean; firstName?: string; voiceId?: string; durationSec?: number },
): Promise<VideoResult> {
  const pip = normalizePip(pipIn);
  const key = videoKey(req.company, req.roleTitle, clipId, pip, opts?.firstName, opts?.durationSec);
  const now = () => new Date().toISOString();

  if (!opts?.force && (await compositeExists(key, "gif"))) {
    return { ok: true, status: "ready", key, files: { gif: true, mp4: await compositeExists(key, "mp4") }, at: now() };
  }

  let result: VideoResult;
  try {
    const clip = await getClip(clipId);
    if (!clip) {
      result = { ok: false, status: "no_clip", key, reason: "webcam clip not found", at: now() };
    } else if (!(await ffmpegAvailable())) {
      result = { ok: false, status: "no_ffmpeg", key, reason: "ffmpeg not installed (set FFMPEG_PATH or apt-get install ffmpeg)", at: now() };
    } else {
      await materializeClip(clip); // ffmpeg needs a local source clip; re-fetch from S3 if evicted
      // Background = the FULL natural-scroll MP4 from roleShot (the .gif is now the short email
      // teaser with a play button, so it must NOT be used here). Reuse it when on disk; only run
      // the slow Playwright capture when it's missing or a re-render is forced.
      let bgPath = join(shotsDir(), `${shotKey(req.company, req.roleTitle)}.mp4`);
      let pageUrl: string | undefined;
      let haveShot = !opts?.force && (await fileExists(bgPath));
      if (!haveShot) {
        const shot = await captureRoleShot(req, { force: opts?.force });
        pageUrl = shot.pageUrl;
        haveShot = shot.ok && shot.status === "company_site" && (await fileExists(bgPath));
        if (!haveShot) {
          result = { ok: false, status: "no_shot", key, reason: shot.reason || "no verified page-scroll video for this role", at: now() };
        }
      }
      if (haveShot) {
        // DURATION MATCH: render a page-scroll video that lasts EXACTLY as long as the webcam clip
        // (or an explicit override), so the composite is ONE clean top→bottom pass instead of the page
        // looping/restarting (clip longer than scroll) or being cut off mid-page (clip shorter). The
        // target is the explicit durationSec when given, else the recorded clip's own length + a small
        // buffer so `-shortest` trims to a single pass. Falls back to the default looped bg on any miss.
        let targetMs: number | null = opts?.durationSec && opts.durationSec > 0 ? Math.round(opts.durationSec * 1000) : null;
        if (!targetMs) {
          const clipMs = await probeDurationMs(clipPath(clip.id, clip.ext)).catch(() => null);
          if (clipMs) targetMs = clipMs + 800;
        }
        if (targetMs) {
          const matched = await renderScrollVideoAtDuration(shotKey(req.company, req.roleTitle), targetMs).catch(() => null);
          if (matched) bgPath = matched;
        }
        // Optional cloned-voice "Hey {firstName}," intro (cached by voice+name; null degrades gracefully).
        const { nameIntroAudio, cleanFirstName } = await import("./nameAudio");
        let introAudio = await nameIntroAudio(opts?.firstName, opts?.voiceId).catch(() => null);
        // Re-master the studio-clean TTS name into the RECORDING's own sonic space (loudness,
        // bandwidth, breathing room) so the splice is inaudible. Must happen BEFORE lip-sync so
        // the mouth is driven by the exact audio that ships. Null → splice the raw intro.
        if (introAudio) {
          const { blendIntroToBody } = await import("./audioBlend");
          await mkdir(videosDir(), { recursive: true });
          const blended = await blendIntroToBody(introAudio, clipPath(clip.id, clip.ext), join(videosDir(), `${key}.introx.wav`)).catch(() => null);
          if (blended) introAudio = blended;
        }
        // When a lip-sync service is configured, also render a mouth-matched face for the name
        // (cached per name). Null => compose() falls back to the frozen-frame cloned-voice intro.
        let introFace: string | null = null;
        if (introAudio) {
          const nm = cleanFirstName(opts?.firstName);
          if (nm) introFace = await buildLipSyncedFace(clip, introAudio, nm, opts?.voiceId).catch(() => null);
        }
        const { files } = await compose(key, bgPath, clip, pip, introAudio, introFace);
        await publishComposite(key, files); // offload to object storage; frees local disk
        result = { ok: true, status: "ready", key, files, pageUrl, at: now() };
      } else {
        result = result! ?? { ok: false, status: "no_shot", key, reason: "no verified page-scroll GIF for this role", at: now() };
      }
    }
  } catch (e) {
    const msg = (e as Error).message || "compose failed";
    result = { ok: false, status: msg === "ffmpeg_not_found" ? "no_ffmpeg" : "error", key, reason: msg, at: now() };
  }

  try {
    const cache = await ensureVideos();
    cache.set(key, { ...result, at: result.at || now() } as VideoRow);
    saveVideos();
  } catch { /* best-effort */ }
  return result;
}

function stripRow(row: VideoRow): VideoResult {
  const { ...rest } = row;
  return rest;
}
