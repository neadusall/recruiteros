/**
 * RecruitersOS · In-Market · Background RETENTION sweeper (30-day video lifecycle)
 *
 * At fleet scale (3K+ composites/day, ~8 MB each) storage grows ~25 GB/day — without expiry the
 * bucket hits multi-TB inside two months and never stops. This tick is the flip side of the
 * pipeline: everything the fleet renders is aged out after INMARKET_RETENTION_DAYS (default 30),
 * which caps the working set at roughly days × daily-rate (30 × 3K ≈ 90–170K videos ≈ 0.8–1.4 TB)
 * so a fixed-size self-hosted store (MinIO / Hetzner Object Storage / R2) stays flat forever.
 *
 * Three sweeps per tick, all idempotent + best-effort:
 *   1. TRUTH  — roleVideo.expireCompositesBefore(): rows in the render cache older than the
 *      window → delete their mp4/gif/jpg from object storage + local disk, mark "expired".
 *      The row + autovideo-map entry survive, so the fleet never re-renders expired work.
 *   2. ORPHANS — s3List("videos/"): any object older than the window that sweep 1 missed
 *      (KV lost, worker crashed mid-submit, pre-retention backlog) is deleted by LastModified.
 *      "clips/" (the operator's few source recordings) is deliberately NEVER touched.
 *   3. DISK   — local ROS_DATA_DIR/videos + /shots files older than the window (composites
 *      stranded by a failed S3 upload, regenerable shot backgrounds, crashed temp dirs).
 *
 * Recipient links stop working at the share TTL (RECRUITEROS_SHARE_TTL_DAYS) — keep that ≤ the
 * retention window so links expire before the bytes do, never the other way around.
 *
 * Gated OFF until configured, same contract as autoCapture/autoVideo:
 *   INMARKET_RETENTION              = "1"     master switch
 *   INMARKET_RETENTION_DAYS         = "30"    age-out window (min 7 — a fat-finger of "1" must
 *                                             not delete this month's sends)
 *   INMARKET_RETENTION_INTERVAL_SEC = "21600" tick cadence (default 6h)
 */

import { join } from "node:path";
import { readdir, stat, unlink, rm } from "node:fs/promises";

const TICK_MS = () => Math.max(600, Number(process.env.INMARKET_RETENTION_INTERVAL_SEC) || 21_600) * 1000;
const FIRST_DELAY_MS = 5 * 60_000;   // let the box settle after a deploy before sweeping
const WATCHDOG_MS = 20 * 60_000;     // a huge first sweep must not wedge the tick forever

export function retentionEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.INMARKET_RETENTION || "").toLowerCase());
}
export function retentionDays(): number {
  return Math.max(7, Number(process.env.INMARKET_RETENTION_DAYS) || 30);
}

let started = false, running = false;
let lastRun = 0, lastExpired = 0, totalExpired = 0, lastFreedBytes = 0, lastError: string | undefined;

/** Live status for the diagnostics surface (engine_health). */
export function retentionStatus(): {
  enabled: boolean; days: number; lastRun: number; lastExpired: number; totalExpired: number; lastFreedBytes: number; lastError?: string;
} {
  return { enabled: retentionEnabled(), days: retentionDays(), lastRun, lastExpired, totalExpired, lastFreedBytes, lastError };
}

/** Delete files (not subdirs) in `dir` older than cutoff; sweep stranded .tmp_* dirs too. */
async function sweepDir(dir: string, cutoffMs: number): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return { files, bytes }; }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) {
        // Render temp dirs (.tmp_mp4_*, .tmp_tease_*) are removed in-line by their renderers;
        // one only survives here if the process died mid-render. Old = safe to remove whole.
        if (name.startsWith(".tmp_") && st.mtimeMs < cutoffMs) {
          await rm(p, { recursive: true, force: true });
          files++;
        }
        continue; // named subdirs (clips/, greetings/) are NOT retention targets
      }
      if (st.mtimeMs < cutoffMs) {
        await unlink(p);
        files++; bytes += st.size;
      }
    } catch { /* one bad entry never stops the sweep */ }
  }
  return { files, bytes };
}

async function runTickInner(): Promise<void> {
  if (!retentionEnabled()) return;
  lastRun = Date.now();
  const cutoffMs = Date.now() - retentionDays() * 86_400_000;
  let expired = 0, freed = 0;

  // (1) TRUTH — expire aged rows in the render cache (deletes their S3 + local artifacts).
  const { expireCompositesBefore, videosDir } = await import("./roleVideo");
  expired += await expireCompositesBefore(cutoffMs);

  // (2) ORPHANS — anything under videos/ the cache doesn't know about, by LastModified.
  const { s3Enabled, s3List, s3Del } = await import("./assetStore");
  if (s3Enabled()) {
    for (const o of await s3List("videos/")) {
      if (o.at && o.at < cutoffMs) {
        await s3Del(o.key);
        expired++; freed += o.size;
      }
    }
  }

  // (3) DISK — local composites stranded by failed uploads + regenerable shot backgrounds.
  const { shotsDir } = await import("./roleShot");
  for (const dir of [videosDir(), shotsDir()]) {
    const r = await sweepDir(dir, cutoffMs);
    expired += r.files; freed += r.bytes;
  }

  lastExpired = expired;
  totalExpired += expired;
  lastFreedBytes = freed;
  if (expired) console.log(`[retention] swept ${expired} asset(s), ~${(freed / 1e9).toFixed(2)} GB freed (window ${retentionDays()}d)`);
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

/**
 * Idempotently arm the retention sweeper. Safe to call on every boot; a complete no-op until
 * INMARKET_RETENTION=1, so shipping this changes nothing until you opt in.
 */
export function ensureRetention(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runTick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runTick(); }, TICK_MS());
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
