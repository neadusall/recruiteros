/**
 * The video fleet is visible on its own: regression suite.
 * Run: npx tsx scripts/test-video-fleet-telemetry.mts   (exits non-zero on failure)
 *
 * On 2026-08-06 video output went to zero with roles queued, and nothing on the box could say
 * whether the render units were dead or the main had nothing to hand them — every video claim and
 * submit was recorded on the SAME counters as research work, so a box that had stopped rendering
 * still read as a busy worker. Output rate was the only signal, and output rate can't tell a dead
 * unit from an empty queue.
 *
 * Both halves of that are pinned here:
 *
 *   videos are not names          a submitted composite must never move namesPerHour, or the
 *                                 research fleet's yield silently absorbs video traffic.
 *   asking is its own signal      a box that claims and gets nothing still counts as an online
 *                                 video worker — "nobody is asking" is the fingerprint of a dead
 *                                 render unit, and it must survive an empty queue.
 */

import { recordClaim, recordSubmit, recordVideoClaim, recordVideoSubmit, fleetStatus } from "../lib/inmarket/fleet";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

/* A research-only box, a video-only box, and one box doing both. */
recordClaim("research-box", 8);
recordSubmit("research-box", 8, 5);

recordVideoClaim("video-box", 4);
recordVideoSubmit("video-box", 3);

recordVideoClaim("idle-video-box", 0);      // claimed, queue was empty — still alive

recordClaim("both-box", 8);
recordSubmit("both-box", 8, 2);
recordVideoClaim("both-box", 2);
recordVideoSubmit("both-box", 2);

const f = fleetStatus();
const by = (id: string) => f.workers.find((w) => w.id === id)!;

/* --- videos are not names --------------------------------------------------- */
check("video submits leave namesPerHour alone", by("video-box").namesPerHour, 0);
check("video submits leave totalNamed alone", by("video-box").totalNamed, 0);
check("a research box keeps its names", by("research-box").totalNamed, 5);
check("a mixed box counts only its research names", by("both-box").totalNamed, 2);
check("videos land on the video counter", by("video-box").totalVideos, 3);
check("fleet video total is the sum", f.totalVideos, 5);
check("research names are not inflated by video", f.totalNamed, 7);

/* --- asking is its own signal ----------------------------------------------- */
check("a research-only box never claimed video", by("research-box").lastVideoClaimSec, null);
check("an empty claim still marks the box alive", by("idle-video-box").lastVideoClaimSec, 0);
check("video-online counts every box that asked", f.videoOnline, 3);
check("fleet reports how long since anyone asked", f.lastVideoClaimSec, 0);

/* A box that only renders video must not be mistaken for an idle research box. */
check("a video-only box reports no research work", by("video-box").totalJobs, 0);
check("...and is still counted as a live video worker", by("video-box").lastVideoClaimSec !== null, true);

console.log(failures ? `\n${failures} FAILED` : "\nall good");
process.exit(failures ? 1 : 0);
