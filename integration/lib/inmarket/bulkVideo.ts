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

import { composeRoleVideo, normalizePip, videoKey, type PipConfig, type VideoStatus } from "./roleVideo";
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
  clipId: string,
  pipIn: Partial<PipConfig> | undefined,
  voiceId: string | undefined,
  recipients: BulkRecipient[],
): BulkJobResult[] {
  const pip = normalizePip(pipIn);
  return recipients.map((rcpt) => {
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
