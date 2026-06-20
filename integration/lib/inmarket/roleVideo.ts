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
import { mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { captureRoleShot, shotKey, shotsDir, type ShotRequest } from "./roleShot";
import { loadSnapshot, debouncedSaver } from "../db";

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
    return null;
  }
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
  return {
    corner, shape, borderColor: color,
    sizePct: clamp(Number(p?.sizePct ?? d.sizePct), 12, 55),
    marginPct: clamp(Number(p?.marginPct ?? d.marginPct), 0, 20),
    borderPx: clamp(Math.round(Number(p?.borderPx ?? d.borderPx)), 0, 24),
    radiusPct: clamp(Number(p?.radiusPct ?? d.radiusPct), 0, 50),
  };
}

/** Stable composite key for a (role, clip, layout) triple. */
export function videoKey(company: string, roleTitle: string, clipId: string, pip: PipConfig): string {
  const rk = shotKey(company, roleTitle);
  const h = createHash("sha1").update(JSON.stringify({ clipId, pip })).digest("hex").slice(0, 12);
  return `${rk}__${h}`;
}

/** Read one composite asset for the serve route. Returns null when absent. */
export async function readCompositeAsset(key: string, fmt: "gif" | "mp4"): Promise<Buffer | null> {
  if (!/^[a-z0-9_-]{3,120}$/.test(key)) return null;
  try {
    return await readFile(compositePath(key, fmt));
  } catch {
    return null;
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

  // Corner placement.
  const left = pip.corner === "bl" || pip.corner === "tl";
  const top = pip.corner === "tl" || pip.corner === "tr";
  const X = left ? `${margin}` : `W-w-${margin}`;
  const Y = top ? `${margin}` : `H-h-${margin}`;

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
  key: string, gifPath: string, clip: ClipMeta, pip: PipConfig,
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
    const a = ["-stream_loop", "-1", "-i", gifPath, "-i", clipFile];
    if (wantMask) a.push("-i", tmpMask);
    if (wantBorder) a.push("-i", tmpBorder);
    return a;
  };

  const files: VideoResult["files"] = {};
  try {
    // (1) MP4 — the composite WITH the user's voice (the source of truth + the watch-link asset).
    //     The page-scroll background is looped (-stream_loop -1) and the webcam clip drives the
    //     length (-shortest).
    {
      const { filter, outLabel } = buildFilter(BG_W, BG_H, pip, wantMask, wantBorder);
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        ...inputs(),
        "-filter_complex", filter, "-map", `[${outLabel}]`, "-map", "1:a?",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest",
        compositePath(key, "mp4"),
      ]);
      files.mp4 = true;
    }
    // (2) GIF — derived FROM the finished MP4 (muted, loops; email-embeddable). Deriving from the
    //     finite MP4 (rather than re-compositing the infinitely-looped background) is what lets
    //     palettegen see a clean EOF — a single-pass palette over a -stream_loop input errors out.
    {
      const gw = Math.max(2, Math.round(GIF_W / 2) * 2);
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-t", String(EMAIL_GIF_SECONDS), "-i", compositePath(key, "mp4"),
        "-filter_complex",
        `fps=${GIF_FPS},scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        "-loop", "0",
        compositePath(key, "gif"),
      ]);
      files.gif = true;
    }
  } finally {
    await unlink(tmpMask).catch(() => {});
    await unlink(tmpBorder).catch(() => {});
  }
  return { files };
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
  req: ShotRequest, clipId: string, pipIn?: Partial<PipConfig>, opts?: { force?: boolean },
): Promise<VideoResult> {
  const pip = normalizePip(pipIn);
  const key = videoKey(req.company, req.roleTitle, clipId, pip);

  if (!opts?.force && (await fileExists(compositePath(key, "gif")))) {
    const cache = await ensureVideos();
    const hit = cache.get(key);
    return hit ? stripRow(hit) : { ok: true, status: "ready", key, files: { gif: true, mp4: await fileExists(compositePath(key, "mp4")) }, at: new Date().toISOString() };
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
  req: ShotRequest, clipId: string, pipIn?: Partial<PipConfig>, opts?: { force?: boolean },
): Promise<VideoResult> {
  const pip = normalizePip(pipIn);
  const key = videoKey(req.company, req.roleTitle, clipId, pip);
  const now = () => new Date().toISOString();

  if (!opts?.force && (await fileExists(compositePath(key, "gif")))) {
    return { ok: true, status: "ready", key, files: { gif: true, mp4: await fileExists(compositePath(key, "mp4")) }, at: now() };
  }

  let result: VideoResult;
  try {
    const clip = await getClip(clipId);
    if (!clip) {
      result = { ok: false, status: "no_clip", key, reason: "webcam clip not found", at: now() };
    } else if (!(await ffmpegAvailable())) {
      result = { ok: false, status: "no_ffmpeg", key, reason: "ffmpeg not installed (set FFMPEG_PATH or apt-get install ffmpeg)", at: now() };
    } else {
      // Reuse the already-verified page-scroll GIF when it's on disk; only run the (slow,
      // Playwright) capture when it's missing or a re-render is forced. This keeps composition
      // fast and resilient when the shot verdict cache was lost (e.g. a restart without a DB)
      // but the verified GIF still sits on disk.
      const gifPath = join(shotsDir(), `${shotKey(req.company, req.roleTitle)}.gif`);
      let pageUrl: string | undefined;
      let haveShot = !opts?.force && (await fileExists(gifPath));
      if (!haveShot) {
        const shot = await captureRoleShot(req, { force: opts?.force });
        pageUrl = shot.pageUrl;
        haveShot = shot.ok && shot.status === "company_site" && (await fileExists(gifPath));
        if (!haveShot) {
          result = { ok: false, status: "no_shot", key, reason: shot.reason || "no verified page-scroll GIF for this role", at: now() };
        }
      }
      if (haveShot) {
        const { files } = await compose(key, gifPath, clip, pip);
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
