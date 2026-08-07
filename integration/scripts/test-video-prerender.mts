/**
 * Ahead-of-demand video rendering must never delay a role someone is waiting to mail.
 * Run: npx tsx scripts/test-video-prerender.mts   (exits non-zero on failure)
 *
 * WHY THIS EXISTS. Until 2026-08-07 the render gate was "contactable" (a curated row with a
 * decision-maker email), which made video production strictly SERIAL behind email enrichment.
 * Measured that day: all 1,207 contactable company+role pairs already had a video (claimable queue
 * depth 1) while 1,871 researched roles waited on a name, so ~4,500 videos/day of capacity produced
 * 2-9 an hour. claimVideoJobs now also hands out researched-but-not-contactable roles.
 *
 * That is a safe win ONLY while the priority holds. The failure this pins is priority inversion:
 * if ahead-of-demand work can ever crowd out a contactable role, outreach that is ready to send
 * starts waiting behind videos for people nobody can email yet - the exact serialization the
 * change was made to remove, pointed the other way and much harder to notice.
 *
 * Runs against the REAL claimVideoJobs with a temp ROS_DATA_DIR file store. No network, no S3, no
 * clip registry: the claim path tolerates all three being absent, and none of them affect tiering.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set BEFORE lib/db is imported: it is what selects the file backend over memory.
const DIR = mkdtempSync(join(tmpdir(), "ros-prerender-"));
process.env.ROS_DATA_DIR = DIR;
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_PASSWORD;
// A clip id is the one hard precondition of a claim (no clip = empty claim, by design).
process.env.INMARKET_AUTOVIDEO_CLIP_ID = "clip_test";
// Shared storage is a precondition too: a worker's composite has to be servable by the main, so an
// unconfigured bucket short-circuits the claim's `reason`. These are config-presence checks only
// (s3Enabled reads env, nothing here ever opens a connection), and they must be set before
// assetStore is first imported because the bucket name is read at module init.
process.env.ROS_S3_BUCKET = "test-bucket";
process.env.ROS_S3_ENDPOINT = "https://s3.invalid";
process.env.ROS_S3_ACCESS_KEY_ID = "test";
process.env.ROS_S3_SECRET_ACCESS_KEY = "test";

const { claimVideoJobs } = await import("../lib/inmarket/autoVideo");
const { shotKey } = await import("../lib/inmarket/roleShot");

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : `\n      got  ${g}\n      want ${w}`}`);
}

/** Seed the snapshot files claimVideoJobs reads. */
function seed(rows: Array<Record<string, unknown>>, map: Record<string, unknown> = {}): void {
  writeFileSync(join(DIR, "snap_inmarket_curation_v1.json"), JSON.stringify(rows));
  writeFileSync(join(DIR, "snap_inmarket_autovideo_map_v1.json"), JSON.stringify(map));
  writeFileSync(join(DIR, "snap_inmarket_autovideo_fails_v1.json"), JSON.stringify({}));
}
const row = (o: Record<string, unknown>) => ({
  id: `cp_${o.company}_${o.role}`, signalType: "job_posting", signalReason: "hiring",
  function: "engineering", score: 50, managerTier: "company_only", curatedAt: "2026-08-07T00:00:00.000Z",
  managerTitle: "Head of Engineering", ...o,
});

const CONTACTABLE = row({ company: "Acme", role: "Staff Engineer", status: "contactable", likelyEmail: "a@acme.com", domain: "acme.com" });
const SOURCED_A = row({ company: "Initech", role: "Backend Engineer", status: "sourced", domain: "initech.com" });
const SOURCED_B = row({ company: "Globex", role: "Data Engineer", status: "sourced", domain: "globex.com" });

console.log("— the queue is no longer gated on having an email —");
seed([CONTACTABLE, SOURCED_A, SOURCED_B]);
let c = await claimVideoJobs(10);
check("contactable work is counted as pending", c.pending, 1);
check("researched roles with no email are claimable", c.prerender, 2);
check("all three are handed out", c.jobs.length, 3);
check("the claim reports work available", c.reason, "ok");

console.log("— priority: a role someone can mail always goes first —");
seed([SOURCED_A, SOURCED_B, CONTACTABLE]);   // contactable deliberately LAST in the book
c = await claimVideoJobs(1);
check("with room for one job, the contactable role wins", c.jobs.map((j) => j.company), ["Acme"]);
seed([SOURCED_A, SOURCED_B, CONTACTABLE]);
c = await claimVideoJobs(2);
check("contactable still leads a larger batch", c.jobs[0].company, "Acme");

console.log("— a role already rendered is not rendered again —");
seed([CONTACTABLE, SOURCED_A], { [shotKey("Initech", "Backend Engineer")]: { videoKey: "v1", company: "Initech", role: "Backend Engineer", at: "2026-08-07T12:00:00.000Z" } });
c = await claimVideoJobs(10);
check("the rendered ahead-of-demand role leaves the queue", c.prerender, 0);
check("only the contactable role is left", c.jobs.map((j) => j.company), ["Acme"]);

console.log("— a role never queues twice —");
// Same company+role present as BOTH a contactable row and a sourced row: one shotKey, one job.
seed([CONTACTABLE, row({ company: "Acme", role: "Staff Engineer", status: "sourced", domain: "acme.com", id: "cp_dupe" })]);
c = await claimVideoJobs(10);
check("the duplicate key is not queued as ahead-of-demand", c.prerender, 0);
check("exactly one job for the shared key", c.jobs.length, 1);

console.log("— the off switch and the storage cap —");
seed([CONTACTABLE, SOURCED_A, SOURCED_B]);
process.env.INMARKET_VIDEO_PRERENDER = "0";
c = await claimVideoJobs(10);
check("INMARKET_VIDEO_PRERENDER=0 disables it entirely", c.prerender, 0);
check("contactable work is untouched by the off switch", c.pending, 1);
delete process.env.INMARKET_VIDEO_PRERENDER;

seed([CONTACTABLE, SOURCED_A, SOURCED_B]);
process.env.INMARKET_VIDEO_PRERENDER_MAX = "0";
c = await claimVideoJobs(10);
check("a zero cap holds the ahead-of-demand queue at zero", c.prerender, 0);
process.env.INMARKET_VIDEO_PRERENDER_MAX = "1";
seed([CONTACTABLE, SOURCED_A, SOURCED_B]);
c = await claimVideoJobs(10);
check("the cap bounds how far ahead the fleet works", c.prerender, 1);
delete process.env.INMARKET_VIDEO_PRERENDER_MAX;

console.log("— suppressed rows are never rendered —");
seed([row({ company: "Dead", role: "Ghost Role", status: "suppressed", domain: "dead.com" })]);
c = await claimVideoJobs(10);
check("a suppressed row is not ahead-of-demand work", c.prerender, 0);
check("nothing is handed out", c.jobs.length, 0);
check("an empty book reads as an empty queue", c.reason, "queue_empty");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
