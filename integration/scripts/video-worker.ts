/**
 * RecruitersOS · In-Market · Distributed VIDEO worker
 *
 * Runs on a cheap box with its own CPU. In a loop it:
 *   1. CLAIMs a batch of "make a video" jobs from the main server (company + role + job URL),
 *      plus the clip to overlay and the fixed length,
 *   2. runs the WHOLE pipeline locally — captures the job posting (headless Chromium) and
 *      composites your clip over it (ffmpeg), uploading the finished video to shared object
 *      storage (S3) so the main can serve it,
 *   3. SUBMITs the composite keys back, which the main records so the Clients tab shows the video.
 *
 * This is how video generation scales toward 5K/day: N worker boxes ≈ N× the per-box throughput,
 * the same model as the research fleet. REQUIRES the worker to have: Chromium (Playwright) + ffmpeg,
 * and the ROS_S3_* env (so it can download the clip and upload the composite). See setup-video-worker.sh.
 *
 * Run (on the worker box, repo checked out + npm install + playwright + ffmpeg + ROS_S3_* env):
 *   WORKER_MAIN_URL=https://recruitersos.co WORKER_TOKEN=<same as main INMARKET_WORKER_TOKEN> \
 *   npx tsx integration/scripts/video-worker.ts
 */

import { hostname } from "os";
import { composeRoleVideo, primeClipCache, mirrorComposite } from "../lib/inmarket/roleVideo";

interface Job {
  company: string; role: string; jobUrl?: string; domain?: string; force?: boolean; targetKey?: string;
  // Role-card data: lets this box typeset an honest background when the live posting can't be captured.
  location?: string; postedAt?: string; industry?: string; signalReason?: string; relatedRoles?: string[];
}

const MAIN = (process.env.WORKER_MAIN_URL || "").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN || "";
const WORKER_ID = (process.env.WORKER_ID || hostname() || "video-worker").replace(/[^\w.\-]/g, "").slice(0, 60);
const BATCH = Math.min(Math.max(Number(process.env.VIDEO_WORKER_BATCH) || 8, 1), 100);
const CONCURRENCY = Math.min(Math.max(Number(process.env.VIDEO_WORKER_CONCURRENCY) || 1, 1), 6);
const IDLE_SLEEP_MS = Math.max(Number(process.env.VIDEO_WORKER_IDLE_SLEEP_MS) || 30_000, 5_000);
const HTTP_TIMEOUT_MS = 30_000;

if (!MAIN || !TOKEN) {
  console.error("[video-worker] set WORKER_MAIN_URL and WORKER_TOKEN. Exiting.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

let consecutiveFails = 0;

async function callMain(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${MAIN}/api/in-market/worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, worker: WORKER_ID, ...payload }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Chromium-is-dead signatures. On the 2GB render boxes the browser gets OOM-killed mid-batch;
 *  from then on EVERY job fast-fails with one of these until the service restarts. Those are
 *  facts about this box, not about the row, so they must never reach the failure ledger: four
 *  of them bench a perfectly good posting permanently. Detect, withhold, exit for a clean
 *  restart (systemd brings the worker back in ~10s with a fresh browser). */
const BROWSER_DEAD_RE = /has been closed|has been disconnected|browserType\.launch|Protocol error|Target (?:page|closed)/i;
/** A real capture navigates pages (12s goto timeouts); a sub-2s "role not found" means the
 *  browser was already dead and the probes never actually ran. Withheld, never reported. */
const SUSPECT_FAST_MS = 2_000;

interface Composed {
  results: Array<{ company: string; role: string; videoKey: string }>;
  failures: Array<{ company: string; role: string; reason: string }>;
  browserDead: boolean;
}

/** Compose a batch of videos concurrently with THIS box's CPU. Per-job errors are skipped, never fatal. */
async function compose(jobs: Job[], clipId: string, durationSec: number): Promise<Composed> {
  const out: Array<{ company: string; role: string; videoKey: string }> = [];
  const failures: Array<{ company: string; role: string; reason: string }> = [];
  let browserDead = false;
  let suspects = 0;
  let cursor = 0;
  async function w(): Promise<void> {
    while (cursor < jobs.length) {
      const j = jobs[cursor++];
      if (!j?.company || !j?.role) continue;
      if (browserDead) continue;   // stop burning the rest of the batch on a dead browser
      const t0 = Date.now();
      try {
        const res = await composeRoleVideo(
          {
            company: j.company, roleTitle: j.role, roleUrl: j.jobUrl, domain: j.domain,
            location: j.location, postedAt: j.postedAt, industry: j.industry,
            signalReason: j.signalReason, relatedRoles: j.relatedRoles,
          },
          clipId, undefined, { durationSec, force: j.force === true },
        );
        if (res.ok && res.status === "ready" && res.key) {
          // Rebuild jobs carry the OLD videoKey (what the emailed links point at): mirror the
          // fresh render onto it so every link in the wild starts serving the smooth video, and
          // report the old key so the main's map entry leaves the rebuild sweep.
          let reportKey = res.key;
          if (j.targetKey && j.targetKey !== res.key) {
            const mirrored = await mirrorComposite(res.key, j.targetKey).catch(() => false);
            if (mirrored) reportKey = j.targetKey;
            else console.error(`[video-worker] ${ts()} ${j.company} / ${j.role}: rendered ${res.key} but mirror onto ${j.targetKey} failed`);
          }
          out.push({ company: j.company, role: j.role, videoKey: reportKey });
        }
        else {
          const reason = res.reason || res.status;
          console.error(`[video-worker] ${ts()} ${j.company} / ${j.role}: ${res.status}${res.reason ? ` (${res.reason})` : ""}`);
          if (BROWSER_DEAD_RE.test(reason)) browserDead = true;
          else if (Date.now() - t0 < SUSPECT_FAST_MS && ++suspects >= 2) browserDead = true;
          else failures.push({ company: j.company, role: j.role, reason });
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[video-worker] ${ts()} compose ${j.company} / ${j.role}: ${msg}`);
        if (BROWSER_DEAD_RE.test(msg)) browserDead = true;
        else failures.push({ company: j.company, role: j.role, reason: msg });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, w));
  // A dead browser invalidates the whole batch's failures: they were never real attempts.
  return { results: out, failures: browserDead ? [] : failures, browserDead };
}

async function loop(): Promise<void> {
  console.log(`[video-worker] ${ts()} started "${WORKER_ID}" → ${MAIN} (batch ${BATCH}, concurrency ${CONCURRENCY})`);
  for (;;) {
    try {
      const claim = await callMain("claim_video", { limit: BATCH });
      const jobs = (Array.isArray(claim.jobs) ? claim.jobs : []) as Job[];
      const clipId = typeof claim.clipId === "string" ? claim.clipId : "";
      const durationSec = Number(claim.durationSec) || 42;
      consecutiveFails = 0;

      if (claim.shared === false) {
        console.error(`[video-worker] ${ts()} main has no shared storage (ROS_S3_*) — a worker's video could not be served. Sleeping.`);
        await sleep(120_000); continue;
      }
      if (!clipId) {
        console.log(`[video-worker] ${ts()} no clip configured on main (record one in Video Studio / set INMARKET_AUTOVIDEO_CLIP_ID). Sleeping.`);
        await sleep(120_000); continue;
      }
      if (!jobs.length) { await sleep(IDLE_SLEEP_MS); continue; }

      // The clip registry lives on the main (Postgres snapshot KV) which this box cannot reach;
      // the claim payload carries the clip's metadata, so prime the local registry with it.
      if (claim.clip && typeof claim.clip === "object") {
        await primeClipCache(claim.clip as Parameters<typeof primeClipCache>[0]).catch(() => {});
      }

      const { results, failures, browserDead } = await compose(jobs, clipId, durationSec);
      // Always report BOTH. A failure the main never hears about is re-handed to a worker every
      // cycle forever, which is exactly how the fleet came to spend all its CPU on dead roles.
      if (results.length || failures.length) await callMain("submit_video", { results, failures });
      console.log(`[video-worker] ${ts()} claimed ${jobs.length} -> composed ${results.length}, failed ${failures.length}`);
      if (browserDead) {
        // Chromium is gone. Every further job would fast-fail and, four strikes in, bench a good
        // posting for good. Exit instead; systemd restarts us with a fresh browser in ~10s.
        console.error(`[video-worker] ${ts()} browser crash detected, exiting for a clean restart`);
        process.exit(1);
      }
    } catch (e) {
      consecutiveFails++;
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveFails, 5));
      console.error(`[video-worker] ${ts()} error: ${(e as Error).message} — backoff ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
}

loop().catch((e) => { console.error(`[video-worker] fatal: ${(e as Error)?.message}`); process.exit(1); });
