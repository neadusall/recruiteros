/**
 * RecruitersOS · In-Market · Bulk personalized video engine (the "thousands" path)
 *
 * Sendspark's promise is record-once / render-many: one base recording, a CSV of recipients, a
 * personalized video each. We do the same — for a (role, clip, layout) we render one composite per
 * first name, each opening with the lip-synced, cloned-voice "Hey {name},".
 *
 * The first render for a role captures + verifies the page scroll (slow, once); every later name
 * reuses that background and the cached name-audio / lip-sync, so per-name work is just the ffmpeg
 * splice. Renders run through a small concurrency gate (VIDEO_RENDER_CONCURRENCY, default 2) so a
 * 1,000-name batch doesn't fork 1,000 ffmpeg/GPU jobs at once.
 *
 * The route is NON-BLOCKING: startBulk() kicks jobs off and returns their current status keyed by
 * composite key; the client re-POSTs to poll until every recipient is "ready". A name already
 * rendered (cache hit) returns "ready" instantly and never re-bills.
 */

import { composeRoleVideo, normalizePip, pipVariants, videoKey, type PipConfig, type VideoStatus } from "./roleVideo";
import { cleanFirstName } from "./nameAudio";
import type { ShotRequest } from "./roleShot";

export interface BulkRecipient {
  firstName: string;
  email?: string;
}

export interface BulkJobResult {
  firstName: string;
  email?: string;
  /** Normalized name actually spoken (null = not safe to say; renders without a name). */
  spokenName: string | null;
  key: string;
  status: VideoStatus;
  error?: string;
}

interface JobState { status: VideoStatus; error?: string; at: number }

/* ---------------- concurrency gate ---------------- */

function maxConcurrency(): number {
  const n = Number(process.env.VIDEO_RENDER_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.min(8, n) : 2;
}
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < maxConcurrency()) { active++; return; }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release(): void {
  active = Math.max(0, active - 1);
  const w = waiters.shift();
  if (w) w();
}

/* ---------------- job tracking (across polls) ---------------- */

const jobs = new Map<string, JobState>();

/**
 * Kick off (or report) a personalized render per recipient. Returns each recipient's current
 * status immediately; the client polls by calling again until all are "ready".
 */
export function startBulk(
  req: ShotRequest,
  clips: string | string[],
  pipIn: Partial<PipConfig> | undefined,
  voiceId: string | undefined,
  recipients: BulkRecipient[],
  opts?: { diversify?: boolean },
): BulkJobResult[] {
  // DIVERSITY: spread recipients across the operator's recordings AND a set of derived PiP layouts,
  // so co-located decision-makers never receive an identical-looking video. With 2 clips and 3
  // recipients you get 3 distinct composites; with 1 clip the layout variants still differentiate.
  const clipIds = (Array.isArray(clips) ? clips : [clips]).map((c) => String(c).trim()).filter(Boolean);
  if (!clipIds.length) return recipients.map((r) => ({ firstName: r.firstName, email: r.email, spokenName: null, key: "", status: "no_clip" as VideoStatus }));
  const basePip = normalizePip(pipIn);
  const diversify = opts?.diversify !== false && (clipIds.length > 1 || recipients.length > 1);
  const layouts = diversify ? pipVariants(basePip) : [basePip];
  const K = clipIds.length, V = layouts.length;

  return recipients.map((rcpt, i) => {
    const clipId = clipIds[i % K];
    const pip = layouts[Math.floor(i / K) % V];
    const spoken = cleanFirstName(rcpt.firstName);
    const key = videoKey(req.company, req.roleTitle, clipId, pip, spoken);
    const existing = jobs.get(key);
    const base = { firstName: rcpt.firstName, email: rcpt.email, spokenName: spoken, key };

    if (existing) return { ...base, status: existing.status, error: existing.error };

    jobs.set(key, { status: "composing", at: Date.now() });
    // Fire-and-track. composeRoleVideo checks the on-disk cache first, so a name already rendered
    // resolves instantly; otherwise it runs behind the concurrency gate.
    void (async () => {
      await acquire();
      try {
        const r = await composeRoleVideo(req, clipId, pip, { firstName: spoken || undefined, voiceId });
        jobs.set(key, { status: r.status, error: r.reason, at: Date.now() });
      } catch (e) {
        jobs.set(key, { status: "error", error: (e as Error).message, at: Date.now() });
      } finally {
        release();
      }
    })();

    return { ...base, status: "composing" as VideoStatus };
  });
}

/** Live counts for the UI progress bar. */
export function bulkQueueStats(): { active: number; queued: number } {
  return { active, queued: waiters.length };
}
