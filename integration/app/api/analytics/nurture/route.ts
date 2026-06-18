/**
 * GET  /api/analytics/nurture -> the 24-month nurture admin view for the signed-in
 *   workspace: the A/B STRATEGY funnel (authority vs inner_circle), the mpc/consultative
 *   VARIANT funnel, status counts, the count of prospects ELIGIBLE to enroll, whether the
 *   in-process automation clock is running (so the drip is hands-off, no n8n), and every
 *   enrollment with its stage, next-due touch, staged touches and queued signal triggers.
 *
 * POST /api/analytics/nurture
 *   { action: "pause"|"resume"|"complete"|"dormant"|"requeue", prospectId } -> change one
 *   { action: "enroll_eligible" } -> LAUNCH the drip: enroll every eligible BD prospect
 *     into the 24-month nurture (the portal's "push it live" control; the auto-enroll tick
 *     does the same on a timer when Autopilot is on, so no external conductor is needed).
 *
 * Session + capability authed (analytics:view to read, campaigns:create to act). The
 * bearer-authed /api/bd/nurture stays the server-to-server (n8n / Flow D) surface.
 */

import { requireCapability, body, ok, fail } from "../../../../lib/api";
import {
  ensureNurtureReady,
  listEnrollments,
  setStatus,
  getEnrollment,
  planFor,
  type NurtureStatus,
} from "../../../../lib/bd/nurture";
import { countEligible, enrollEligible } from "../../../../lib/bd/nurtureEnroll";
import { ensureStrategyReady, report as strategyReport } from "../../../../lib/bd/nurtureStrategy";
import { ensureExperimentReady, report as variantReport } from "../../../../lib/bd/experiment";
import { automationEnabled, automationArmed } from "../../../../lib/automation/scheduler";

export async function GET(req: Request) {
  const g = requireCapability(req, "analytics:view");
  if ("response" in g) return g.response;
  await ensureNurtureReady();
  await ensureStrategyReady();
  await ensureExperimentReady();

  const ws = g.ctx.workspace.id;
  const enrollments = listEnrollments(ws);
  const counts = enrollments.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return ok({
    counts,
    total: enrollments.length,
    eligible: await countEligible(ws),
    // Is the drip running hands-off in this process (no n8n)? enabled = master switch on;
    // armed = the clock actually started in this server.
    automation: { enabled: automationEnabled(), armed: automationArmed() },
    strategyReport: strategyReport(),
    variantReport: variantReport(),
    enrollments: enrollments.map((e) => ({
      prospectId: e.prospectId,
      status: e.status,
      hold: e.hold,
      strategy: e.strategy,
      variant: e.lead.variant,
      firstName: e.lead.firstName,
      fullName: e.lead.fullName,
      title: e.lead.title,
      company: e.lead.company,
      touchesSent: e.touchesSent,
      engagedCount: e.engagedCount ?? 0,
      nextTouchIndex: e.nextTouchIndex,
      planLength: planFor(e.strategy).length,
      nextDueAt: e.nextDueAt,
      pending: e.pending,
      triggered: e.triggered.filter((t) => !t.actioned),
    })),
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "campaigns:create");
  if ("response" in g) return g.response;
  await ensureNurtureReady();
  const ws = g.ctx.workspace.id;

  const b = await body<{ action?: string; prospectId?: string }>(req);

  // LAUNCH: enroll every eligible BD prospect into the 24-month drip.
  if (b?.action === "enroll_eligible") {
    const r = await enrollEligible(ws);
    return ok({ action: "enroll_eligible", ...r });
  }

  // Per-enrollment status change.
  const valid: NurtureStatus[] = ["paused", "active", "completed", "dormant"];
  const map: Record<string, NurtureStatus> = { pause: "paused", resume: "active", complete: "completed", dormant: "dormant", requeue: "active" };
  const status = b?.action ? map[b.action] : undefined;
  if (!b?.prospectId || !status || !valid.includes(status)) {
    return fail("prospectId + action (pause|resume|complete|dormant|requeue) or action enroll_eligible required", 422);
  }
  if (!getEnrollment(b.prospectId)) return fail("not_enrolled", 404);

  setStatus(b.prospectId, status);
  return ok({ prospectId: b.prospectId, status });
}
