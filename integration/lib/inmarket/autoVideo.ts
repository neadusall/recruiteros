/**
 * RecruitersOS · In-Market · Background VIDEO compositor (one clip over every job capture)
 *
 * Once a screen capture of a contact's job posting exists (autoCapture.ts), this tick composites
 * your ONE recorded webcam clip over it into a send-ready outreach video — hands-off, for the whole
 * book. One clip covers all (no per-recipient voice synth), and every video is a fixed length
 * (default 42s). Gentle + concurrency-capped like the capture tick; the path to thousands/day is a
 * higher concurrency here AND the same work spread across the worker fleet.
 *
 * It composites only where a capture already exists, records each result in a small map
 * (shotKey -> composite videoKey) so the Clients tab can show the finished video, and never
 * re-composites a row it already did.
 *
 * Gated OFF until configured, so deploying it changes nothing until you opt in:
 *   INMARKET_AUTOVIDEO              = "1"        master switch
 *   INMARKET_AUTOVIDEO_WORKSPACE    = "<wsId>"   whose clip to use (defaults to the auto-enroll workspace)
 *   INMARKET_AUTOVIDEO_CLIP_ID      = "<clipId>" the clip to overlay (defaults to the latest clip in that workspace)
 *   INMARKET_AUTOVIDEO_SECONDS      = "42"       length of every video (5..180)
 *   INMARKET_AUTOVIDEO_BATCH        = "6"        videos attempted per tick
 *   INMARKET_AUTOVIDEO_CONCURRENCY  = "1"        composites run at once (1..6) — the throughput lever
 *   INMARKET_AUTOVIDEO_INTERVAL_SEC = "180"      how often the tick runs
 */

import { loadSnapshot, saveSnapshot } from "../db";

const MAP_KEY = "inmarket_autovideo_map_v1";   // shotKey -> { videoKey, company, role, at }

const TICK_MS = () => Math.max(60, Number(process.env.INMARKET_AUTOVIDEO_INTERVAL_SEC) || 180) * 1000;
const FIRST_DELAY_MS = 120_000;     // let captures get a head start (a video needs a capture first)
const WATCHDOG_MS = 10 * 60 * 1000;

export function autoVideoEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.INMARKET_AUTOVIDEO || "").toLowerCase());
}
function workspaceId(): string { return (process.env.INMARKET_AUTOVIDEO_WORKSPACE || process.env.INMARKET_AUTOENROLL_WORKSPACE || "").trim(); }
function videoSeconds(): number { const n = Number(process.env.INMARKET_AUTOVIDEO_SECONDS); return Number.isFinite(n) && n > 0 ? Math.min(180, Math.max(5, Math.round(n))) : 42; }
function batchSize(): number { return Math.max(1, Math.min(Number(process.env.INMARKET_AUTOVIDEO_BATCH) || 6, 500)); }
function concurrency(): number { return Math.max(1, Math.min(Number(process.env.INMARKET_AUTOVIDEO_CONCURRENCY) || 1, 6)); }

interface MapEntry { videoKey: string; company: string; role: string; at: string }
type VideoMap = Record<string, MapEntry>;

async function loadMap(): Promise<VideoMap> { return (await loadSnapshot<VideoMap>(MAP_KEY).catch(() => null)) || {}; }

/** company (lowercased) -> latest composite videoKey — for the Clients tab to show finished videos. */
export async function autoVideoMapByCompany(): Promise<Record<string, { videoKey: string; at: string }>> {
  const map = await loadMap();
  const out: Record<string, { videoKey: string; at: string }> = {};
  for (const e of Object.values(map)) {
    const k = (e.company || "").toLowerCase().trim();
    if (!k) continue;
    if (!out[k] || out[k].at < e.at) out[k] = { videoKey: e.videoKey, at: e.at };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* FLEET — hand video jobs to worker boxes so generation scales out     */
/* ------------------------------------------------------------------ */

/**
 * Hand a batch of "make a video" jobs to a worker box: contactable rows that don't have a video yet,
 * plus the clip to overlay and the fixed length. The worker runs the whole pipeline locally
 * (capture → composite → upload to shared S3) and reports the key back via recordVideoResults. A
 * random offset spreads the work so concurrent workers don't all grab the same head; composeRoleVideo
 * is cached by videoKey, so the rare duplicate is just wasted CPU, never a bad asset.
 *
 * Requires shared object storage (ROS_S3_*) so a worker's video is servable by the main — otherwise
 * the composite would live only on the worker's disk.
 */
export async function claimVideoJobs(limit: number): Promise<{ jobs: Array<{ company: string; role: string; jobUrl?: string; domain?: string }>; clipId: string | null; durationSec: number; shared: boolean }> {
  const dur = videoSeconds();
  const clipId = await resolveClipId();
  let shared = false;
  try { shared = (await import("./assetStore")).s3Enabled(); } catch { /* no s3 module */ }
  if (!clipId) return { jobs: [], clipId: null, durationSec: dur, shared };

  const { listCurated } = await import("./curation");
  const { shotKey } = await import("./roleShot");
  const map = await loadMap();
  const rows = await listCurated({ status: "contactable", contactableOnly: true, limit: 6000 });
  const pending: Array<{ company: string; role: string; jobUrl?: string; domain?: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const company = r.company;
    const role = r.role || r.managerTitle;
    if (!company || !role) continue;
    const key = shotKey(company, role);
    if (map[key] || seen.has(key)) continue;
    seen.add(key);
    pending.push({ company, role, jobUrl: r.jobUrl, domain: r.domain });
  }
  const n = Math.max(1, Math.min(limit, 100));
  const start = pending.length > n ? Math.floor(Math.random() * (pending.length - n)) : 0;
  return { jobs: pending.slice(start, start + n), clipId, durationSec: dur, shared };
}

/** A worker reports the videos it composited (keyed by company+role) → record them so the Clients tab shows them. */
export async function recordVideoResults(results: Array<{ company: string; role: string; videoKey: string }>): Promise<number> {
  if (!results.length) return 0;
  const { shotKey } = await import("./roleShot");
  const map = await loadMap();
  const nowIso = new Date().toISOString();
  let n = 0;
  for (const r of results) {
    if (!r.company || !r.role || !r.videoKey) continue;
    map[shotKey(r.company, r.role)] = { videoKey: r.videoKey, company: r.company, role: r.role, at: nowIso };
    n++;
  }
  if (n) {
    await saveSnapshot(MAP_KEY, map);
    totalMade += n;
    try {
      const { makeShortLinks } = await import("./shortLinks");
      await makeShortLinks(results.filter((r) => r.videoKey).map((r) => ({ videoKey: r.videoKey, company: r.company, role: r.role, workspaceId: workspaceId() })));
    } catch { /* short links are best-effort */ }
  }
  return n;
}

let started = false, running = false;
let lastRun = 0, lastMade = 0, totalMade = 0, lastError: string | undefined, activeClip: string | undefined;

/** Live status for the diagnostics surface. */
export async function autoVideoStatus(): Promise<{ enabled: boolean; workspace: string; clipId?: string; seconds: number; lastRun: number; lastMade: number; totalMade: number; lastError?: string }> {
  return { enabled: autoVideoEnabled(), workspace: workspaceId(), clipId: activeClip, seconds: videoSeconds(), lastRun, lastMade, totalMade, lastError };
}

/** Resolve the clip to overlay: the explicit env id, else the latest clip in the workspace. */
async function resolveClipId(): Promise<string | null> {
  const explicit = (process.env.INMARKET_AUTOVIDEO_CLIP_ID || "").trim();
  if (explicit) return explicit;
  const ws = workspaceId();
  if (!ws) return null;
  try {
    const { listClips } = await import("./roleVideo");
    const clips = await listClips(ws);
    if (!clips.length) return null;
    return [...clips].sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.id || null;   // latest by timestamp
  } catch { return null; }
}

async function runTickInner(): Promise<void> {
  if (!autoVideoEnabled()) return;
  lastRun = Date.now();
  const clipId = await resolveClipId();
  activeClip = clipId || undefined;
  if (!clipId) { lastError = "no clip — record one in Video Studio (or set INMARKET_AUTOVIDEO_CLIP_ID)"; return; }

  const { listCurated } = await import("./curation");
  const { capturedKeySet, shotKey } = await import("./roleShot");
  const { composeRoleVideo } = await import("./roleVideo");

  const captured = await capturedKeySet().catch(() => new Set<string>());   // only composite where a capture exists
  const map = await loadMap();
  const rows = await listCurated({ status: "contactable", contactableOnly: true, limit: 5000 });
  const seen = new Set<string>();
  const todo: Array<{ company: string; role: string; jobUrl?: string; domain?: string; key: string }> = [];
  for (const r of rows) {
    const company = r.company;
    const role = r.role || r.managerTitle;
    if (!company || !role) continue;
    const key = shotKey(company, role);
    if (!captured.has(key)) continue;          // no capture to overlay yet — autoCapture handles that
    if (map[key] || seen.has(key)) continue;   // already composed
    seen.add(key);
    todo.push({ company, role, jobUrl: r.jobUrl, domain: r.domain, key });
    if (todo.length >= batchSize()) break;
  }

  const dur = videoSeconds();
  const fresh: MapEntry[] = [];
  let made = 0, cursor = 0;
  const conc = Math.max(1, Math.min(concurrency(), todo.length || 1));
  async function worker() {
    while (cursor < todo.length) {
      const t = todo[cursor++];
      try {
        const res = await composeRoleVideo(
          { company: t.company, roleTitle: t.role, roleUrl: t.jobUrl, domain: t.domain },
          clipId!, undefined, { durationSec: dur },
        );
        if (res.ok && res.status === "ready" && res.key) {
          fresh.push({ videoKey: res.key, company: t.company, role: t.role, at: new Date().toISOString() });
          made++; totalMade++;
        }
      } catch (e) {
        lastError = (e as Error)?.message;
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));

  if (fresh.length) {
    const cur = await loadMap();
    for (const e of fresh) cur[shotKey(e.company, e.role)] = e;
    await saveSnapshot(MAP_KEY, cur);
    try {
      const { makeShortLinks } = await import("./shortLinks");
      await makeShortLinks(fresh.map((e) => ({ videoKey: e.videoKey, company: e.company, role: e.role, workspaceId: workspaceId() })));
    } catch { /* short links are best-effort */ }
  }
  lastMade = made;
}

function withWatchdog(fn: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    fn().then(() => { clearTimeout(timer); finish(); }, (e) => { lastError = (e as Error)?.message; clearTimeout(timer); finish(); });
  });
}

async function runTick(): Promise<void> {
  if (running) return;
  running = true;
  try { await withWatchdog(runTickInner, WATCHDOG_MS); }
  finally { running = false; }
}

/** Idempotently arm the background video compositor. No-op until INMARKET_AUTOVIDEO is set. */
export function ensureAutoVideo(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runTick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runTick(); }, TICK_MS());
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
