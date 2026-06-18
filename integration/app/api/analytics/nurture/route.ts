/**
 * GET  /api/analytics/nurture -> the 24-month nurture admin view for the signed-in
 *   workspace: the A/B STRATEGY funnel (authority vs inner_circle), the mpc/consultative
 *   VARIANT funnel, status counts, the count of prospects ELIGIBLE to enroll, and every
 *   enrollment with its stage, next-due touch, staged (pending) LinkedIn touches and
 *   queued signal triggers.
 *
 * POST /api/analytics/nurture
 *   { action: "pause"|"resume"|"complete"|"dormant"|"requeue", prospectId } -> change one
 *   { action: "enroll_eligible" } -> LAUNCH the drip: enroll every eligible BD prospect
 *     (in-market, not opted out, not already enrolled) into the 24-month nurture, each
 *     assigned its A/B strategy + framing. This is the portal's "push it live" control.
 *
 * Session + capability authed (analytics:view to read, campaigns:create to act), so the
 * admin SPA can call it with the cookie. The bearer-authed /api/bd/nurture stays the
 * server-to-server (n8n / Flow D) surface.
 */

import { requireCapability, body, ok, fail } from "../../../../lib/api";
import { getCore } from "../../../../lib/core/repository";
import { inferPersona } from "../../../../lib/bd/personaMessaging";
import {
  ensureNurtureReady,
  listEnrollments,
  setStatus,
  getEnrollment,
  enroll,
  isEnrolled,
  planFor,
  type NurtureStatus,
  type NurtureLead,
} from "../../../../lib/bd/nurture";
import { ensureStrategyReady, report as strategyReport, recordStrategyOutcome } from "../../../../lib/bd/nurtureStrategy";
import { ensureExperimentReady, report as variantReport, assignVariant, recordOutcome } from "../../../../lib/bd/experiment";
import type { Prospect } from "../../../../lib/core/types";

/** A prospect can be enrolled into the BD drip if it is an in-market BD lead, not
 *  already enrolled, and not suppressed. Keeps recruiting prospects out of BD nurture. */
function isEligible(p: Prospect): boolean {
  if (isEnrolled(p.id)) return false;
  if (p.category !== "in_market") return false;
  if (p.status === "do_not_contact" || p.status === "closed_lost" || p.status === "won") return false;
  return true;
}

function leadFor(p: Prospect): NurtureLead {
  return {
    firstName: p.firstName,
    fullName: p.fullName,
    title: p.title,
    company: p.company,
    persona: inferPersona(p.title) as string | undefined,
    profileSummary: p.headline,
    email: p.email,
    landlinePhone: p.landlinePhone,
    phone: p.phone,
    location: p.location,
    linkedinUrl: p.linkedinUrl,
    providerProfileId: (p as any).providerProfileId,
    variant: assignVariant(p.id),
  };
}

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
  const eligible = (await getCore().listProspects(ws)).filter(isEligible).length;

  return ok({
    counts,
    total: enrollments.length,
    eligible,
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
  await ensureStrategyReady();
  await ensureExperimentReady();
  const ws = g.ctx.workspace.id;

  const b = await body<{ action?: string; prospectId?: string }>(req);

  // LAUNCH: enroll every eligible BD prospect into the 24-month drip.
  if (b?.action === "enroll_eligible") {
    const eligible = (await getCore().listProspects(ws)).filter(isEligible);
    let enrolled = 0;
    for (const p of eligible) {
      enroll(ws, p.id, leadFor(p), { status: "active" });
      recordOutcome(p.id, "enrolled");
      recordStrategyOutcome(p.id, "enrolled");
      enrolled++;
    }
    return ok({ action: "enroll_eligible", enrolled });
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
