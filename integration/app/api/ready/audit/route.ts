/**
 * GET /api/ready/audit  — every account, every tool that cannot work.
 *
 * The monitoring half of the readiness safeguard: ros-sentinel reads this on a
 * schedule and emails the owner when a tool goes dark, so a broken connection
 * is found by the system rather than by a recruiter whose work quietly returned
 * nothing. No screen has to be open for this to be noticed.
 *
 * Auth: the owner's session, or the cron secret (x-cron-secret / ?secret=),
 * matching every other unattended job on the box.
 */

import { context, ok } from "../../../../lib/api";
import { isOwnerEmail } from "../../../../lib/owner";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { auditReadiness } from "../../../../lib/ready";

export async function GET(req: Request) {
  const ctx = context(req);
  const owner = Boolean(ctx && isOwnerEmail(ctx.user.email));
  if (!owner) {
    const cron = requireCronAuth(req);
    if (!cron.ok) return cron.response;
  }
  return ok(await auditReadiness(new Date().toISOString()));
}
