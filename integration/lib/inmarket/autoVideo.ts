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
const FAIL_KEY = "inmarket_autovideo_fails_v1"; // shotKey -> { tries, at, reason, benched }

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

/* ------------------------------------------------------------------ */
/* FAILURE MEMO — the reason the fleet ever made progress at all        */
/* ------------------------------------------------------------------ */

/**
 * A job that fails capture used to be recorded NOWHERE: `pending` was simply "every contactable row
 * with no entry in the video map", so a role whose posting can't be captured came back in the very
 * next claim, forever. Measured on one worker box: 315,592 claims in 24h produced 54 videos, with a
 * single dead role re-attempted 161 times in 6 hours. The fleet was spending ~100% of its CPU
 * re-failing the same roles and never reaching fresh work.
 *
 * So every failure is now recorded with an attempt count. A failed key is skipped until its backoff
 * expires (exponential: 30m, 1h, 2h, 4h... capped at 24h), and after MAX_TRIES it is benched
 * permanently. Terminal reasons (an aggregator-only URL, a staffing intermediary) bench on the FIRST
 * failure — retrying those can never produce a different answer.
 */
interface FailEntry { tries: number; at: string; reason?: string; benched?: boolean; company?: string; role?: string }
type FailMap = Record<string, FailEntry>;

const MAX_TRIES = Math.max(1, Number(process.env.INMARKET_VIDEO_MAX_TRIES) || 4);
const BASE_BACKOFF_MS = Math.max(60_000, (Number(process.env.INMARKET_VIDEO_BACKOFF_MIN) || 30) * 60_000);
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** Reasons that can never change on a retry — bench immediately instead of burning 4 attempts. */
const TERMINAL = /staffing|recruiting intermediary|aggregator|no verified company domain|no job url/i;

async function loadFails(): Promise<FailMap> { return (await loadSnapshot<FailMap>(FAIL_KEY).catch(() => null)) || {}; }

/** True when this key should be skipped right now (benched, or still inside its backoff window). */
function isBenched(f: FailEntry | undefined, nowMs: number): boolean {
  if (!f) return false;
  if (f.benched || f.tries >= MAX_TRIES) return true;
  const waited = nowMs - Date.parse(f.at || "");
  if (!Number.isFinite(waited)) return false;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, f.tries - 1));
  return waited < backoff;
}

/**
 * A worker reports the jobs it could NOT compose. Without this the same dead roles are re-claimed
 * every couple of minutes and starve the queue. Returns how many were recorded.
 */
export async function recordVideoFailures(
  failures: Array<{ company: string; role: string; reason?: string }>,
): Promise<number> {
  if (!failures.length) return 0;
  const { shotKey } = await import("./roleShot");
  const fails = await loadFails();
  const nowIso = new Date().toISOString();
  let n = 0;
  for (const f of failures) {
    if (!f.company || !f.role) continue;
    const key = shotKey(f.company, f.role);
    const prev = fails[key];
    const tries = (prev?.tries || 0) + 1;
    const terminal = TERMINAL.test(f.reason || "");
    fails[key] = { tries, at: nowIso, reason: (f.reason || "").slice(0, 200), benched: terminal || tries >= MAX_TRIES, company: f.company, role: f.role };
    n++;
  }
  if (n) await saveSnapshot(FAIL_KEY, fails);
  return n;
}

/** Counts for the diagnostics surface: how much of the book is permanently un-videoable. */
export async function videoFailureStats(): Promise<{ tracked: number; benched: number; retrying: number; topReasons: Array<{ reason: string; n: number }> }> {
  const fails = await loadFails();
  const now = Date.now();
  let benched = 0, retrying = 0;
  const reasons = new Map<string, number>();
  for (const f of Object.values(fails)) {
    if (f.benched || f.tries >= MAX_TRIES) benched++;
    else if (isBenched(f, now)) retrying++;
    const r = (f.reason || "unknown").slice(0, 60);
    reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  const topReasons = [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 8);
  return { tracked: Object.keys(fails).length, benched, retrying, topReasons };
}

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
 * What a worker needs to render one video. The card fields carry the role's real signal data so a
 * box that cannot capture the live posting can still typeset an honest background from it.
 */
export interface VideoJob {
  company: string;
  role: string;
  jobUrl?: string;
  domain?: string;
  force?: boolean;
  targetKey?: string;
  location?: string;
  postedAt?: string;
  industry?: string;
  signalReason?: string;
  relatedRoles?: string[];
}

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
export async function claimVideoJobs(limit: number): Promise<{ jobs: Array<VideoJob>; clipId: string | null; clip?: import("./roleVideo").ClipMeta | null; durationSec: number; shared: boolean }> {
  const dur = videoSeconds();
  const clipId = await resolveClipId();
  let shared = false;
  try { shared = (await import("./assetStore")).s3Enabled(); } catch { /* no s3 module */ }
  if (!clipId) return { jobs: [], clipId: null, durationSec: dur, shared };

  // Ship the clip METADATA with the claim: the registry lives in the main's Postgres snapshot
  // KV, which worker boxes deliberately cannot reach (they only get the token + S3). Without
  // this a worker resolves the clip bytes from S3 but getClip() returns null and every job
  // fails "no_clip". The worker primes its local registry from this record.
  const clip = await (await import("./roleVideo")).getClip(clipId).catch(() => null);

  const { listCurated } = await import("./curation");
  const { shotKey } = await import("./roleShot");
  const map = await loadMap();
  const fails = await loadFails();
  const nowMs = Date.now();
  const rows = await listCurated({ status: "contactable", contactableOnly: true, limit: 6000 });
  const pending: Array<VideoJob> = [];
  const rebuilds: Array<VideoJob> = [];
  const rowByKey = new Map<string, (typeof rows)[number]>();
  const seen = new Set<string>();
  // Every open role per company, so a worker that must fall back to a typeset card can show the
  // company's full hiring surge instead of a single lonely title.
  const rolesByCompany = new Map<string, string[]>();
  for (const r of rows) {
    const c = (r.company || "").toLowerCase().trim();
    const t = (r.role || "").trim();
    if (!c || !t) continue;
    const list = rolesByCompany.get(c) || [];
    if (!list.includes(t)) list.push(t);
    rolesByCompany.set(c, list);
  }
  for (const r of rows) {
    const company = r.company;
    const role = r.role || r.managerTitle;
    if (!company || !role) continue;
    const key = shotKey(company, role);
    if (seen.has(key)) continue;
    seen.add(key);
    rowByKey.set(key, r);
    // Skip anything already done, benched, or still inside its retry backoff — otherwise the
    // batch fills with roles that just failed and the fleet never reaches new work.
    if (map[key]) continue;
    if (isBenched(fails[key], nowMs)) continue;
    pending.push({
      company, role, jobUrl: r.jobUrl, domain: r.domain,
      location: r.jobLocation, postedAt: r.jobPostedAt, industry: r.industry,
      signalReason: r.signalReason, relatedRoles: rolesByCompany.get(company.toLowerCase().trim()),
    });
  }
  // ONE-TIME rebuild sweep: composites made before the smooth-PiP compose fix shipped were
  // encoded at the scroll background's sparse VFR timing (~3fps average), so the webcam PiP is
  // choppy. Drive the sweep off the VIDEO MAP itself (every video ever made, regardless of the
  // prospect row's current status), enrich with the curated row's jobUrl when available, and
  // carry targetKey so the worker overwrites the OLD link's assets even when the fresh render
  // lands under a different videoKey (e.g. the clip was re-recorded since). recordVideoResults
  // refreshes `at`, so each entry leaves the sweep after its rebuild. Rebuilds go FIRST: the set
  // is small and finite (links already in prospects' inboxes play choppy until re-rendered),
  // while the new-video backlog is thousands of rows deep and resumes as soon as the sweep drains.
  for (const [key, done] of Object.entries(map)) {
    if (!done?.company || !done.role || !done.videoKey) continue;
    if (done.at >= REBUILD_BEFORE) continue;
    const row = rowByKey.get(key);
    rebuilds.push({ company: done.company, role: done.role, jobUrl: row?.jobUrl, domain: row?.domain, force: true, targetKey: done.videoKey });
  }
  const n = Math.max(1, Math.min(limit, 100));
  const batch = rebuilds.slice(0, n);
  if (batch.length < n && pending.length) {
    const room = n - batch.length;
    const start = pending.length > room ? Math.floor(Math.random() * (pending.length - room)) : 0;
    batch.push(...pending.slice(start, start + room));
  }
  return { jobs: batch, clipId, clip, durationSec: dur, shared };
}

/** Composites recorded before this instant get re-rendered once (smooth-PiP compose fix). */
const REBUILD_BEFORE = (process.env.INMARKET_VIDEO_REBUILD_BEFORE || "2026-08-04T14:00:00.000Z").trim();

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
