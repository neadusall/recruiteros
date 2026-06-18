/**
 * GET  /api/analytics/nurture -> the 24-month nurture admin view for the signed-in
 *   workspace: the A/B STRATEGY funnel (authority vs inner_circle), the mpc/consultative
 *   VARIANT funnel, status counts, and every enrollment with its stage, next-due touch,
 *   staged (pending) LinkedIn touches and queued signal triggers.
 *
 * POST /api/analytics/nurture -> change one enrollment's status.
 *   { action: "pause"|"resume"|"complete"|"dormant"|"requeue", prospectId }
 *
 * Session + capability authed (analytics:view to read, campaigns:create to act), so the
 * admin SPA can call it with the cookie. The bearer-authed /api/bd/nurture stays the
 * server-to-server (n8n / Flow D) surface.
 */

import { requireCapability, body, ok, fail } from "../../../../lib/api";
import { ensureNurtureReady, listEnrollments, setStatus, getEnrollment, planFor, type NurtureStatus } from "../../../../lib/bd/nurture";
import { ensureStrategyReady, report as strategyReport } from "../../../../lib/bd/nurtureStrategy";
import { ensureExperimentReady, report as variantReport } from "../../../../lib/bd/experiment";

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

  const b = await body<{ action?: string; prospectId?: string }>(req);
  const valid: NurtureStatus[] = ["paused", "active", "completed", "dormant"];
  const map: Record<string, NurtureStatus> = { pause: "paused", resume: "active", complete: "completed", dormant: "dormant", requeue: "active" };
  const status = b?.action ? map[b.action] : undefined;
  if (!b?.prospectId || !status || !valid.includes(status)) {
    return fail("prospectId + action (pause|resume|complete|dormant|requeue) required", 422);
  }
  if (!getEnrollment(b.prospectId)) return fail("not_enrolled", 404);

  setStatus(b.prospectId, status);
  return ok({ prospectId: b.prospectId, status });
}
