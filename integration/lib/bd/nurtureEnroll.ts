/**
 * RecruitersOS · BD · Nurture enrollment (shared)
 *
 * The one place that decides WHO enters the 24-month drip and enrolls them. Used by:
 *   - the portal "Activate" control (POST /api/analytics/nurture enroll_eligible), and
 *   - the in-process auto-enrollment tick (lib/automation/scheduler) that replaces the
 *     n8n poll of /api/prospects/queue — so the drip is fully set-and-forget, no n8n.
 *
 * Eligible = an in-market BD lead, not opted out, not already enrolled (enrollment is
 * also the de-dupe ledger). Recruiting prospects never enter BD nurture.
 */

import { getCore } from "../core/repository";
import { inferPersona } from "./personaMessaging";
import { ensureNurtureReady, enroll, isEnrolled, type NurtureLead } from "./nurture";
import { ensureStrategyReady, recordStrategyOutcome } from "./nurtureStrategy";
import { ensureExperimentReady, assignVariant, recordOutcome } from "./experiment";
import type { Prospect } from "../core/types";

/** Can this prospect enter the BD drip? In-market, not suppressed, not already enrolled. */
export function isNurtureEligible(p: Prospect): boolean {
  if (isEnrolled(p.id)) return false;
  if (p.category !== "in_market") return false;
  if (p.status === "do_not_contact" || p.status === "closed_lost" || p.status === "won") return false;
  return true;
}

/** Freeze the prospect's context into a nurture lead (variant pinned for the framing A/B). */
export function leadForProspect(p: Prospect): NurtureLead {
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

/** How many of a workspace's prospects are eligible to enroll right now. */
export async function countEligible(workspaceId: string): Promise<number> {
  await ensureNurtureReady();
  return (await getCore().listProspects(workspaceId)).filter(isNurtureEligible).length;
}

/**
 * Enroll a workspace's eligible prospects into the 24-month drip, each assigned its A/B
 * strategy + framing, recording the `enrolled` funnel outcome on both axes. `limit` paces
 * the auto-enroll tick (cap per cycle); omit it for the on-demand portal launch.
 */
export async function enrollEligible(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<{ enrolled: number; eligible: number }> {
  await ensureNurtureReady();
  await ensureStrategyReady();
  await ensureExperimentReady();

  const all = (await getCore().listProspects(workspaceId)).filter(isNurtureEligible);
  const batch = opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
  let enrolled = 0;
  for (const p of batch) {
    enroll(workspaceId, p.id, leadForProspect(p), { status: "active" });
    recordOutcome(p.id, "enrolled");
    recordStrategyOutcome(p.id, "enrolled");
    enrolled++;
  }
  return { enrolled, eligible: all.length };
}
