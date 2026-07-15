/**
 * RecruitersOS · LinkedIn OS
 * Person-level outreach state + the GLOBAL REPLY STOP.
 *
 * One person, one automation reality. When a reply arrives on ANY channel
 * (email, LinkedIn, SMS, voice) the stop runs immediately, BEFORE any AI
 * classification: pause the person's automation, cancel every pending
 * LinkedIn action, release the reserved capacity, pause enrollments, and flip
 * the core prospect status so the email cadence engines drop the person too.
 */

import { getCore } from "../../core/repository";
import { rid, nowIso } from "../../core/ids";
import { enrollments, outreachStates, withEngineLock } from "./store";
import { listLedger, releaseReservation, saveLedger } from "./ledger";
import { getIdentity } from "./identity";
import type { PersonOutreachState } from "./types";

export async function getOutreachState(
  workspaceId: string,
  personIdentityId: string,
): Promise<PersonOutreachState | null> {
  const all = await outreachStates.all();
  return all.find((s) => s.workspaceId === workspaceId && s.personIdentityId === personIdentityId) ?? null;
}

export async function ensureOutreachState(
  workspaceId: string,
  personIdentityId: string,
): Promise<PersonOutreachState> {
  const all = await outreachStates.all();
  let s = all.find((x) => x.workspaceId === workspaceId && x.personIdentityId === personIdentityId);
  if (!s) {
    s = {
      personIdentityId,
      workspaceId,
      replyDetected: false,
      automationPaused: false,
      contactPressureScore: 0,
      pressureState: "low",
      updatedAt: nowIso(),
    };
    all.push(s);
    outreachStates.save();
  }
  return s;
}

export async function touchOutbound(
  workspaceId: string,
  personIdentityId: string,
  channel: string,
): Promise<void> {
  const s = await ensureOutreachState(workspaceId, personIdentityId);
  s.lastOutboundAt = nowIso();
  s.lastOutboundChannel = channel;
  s.updatedAt = nowIso();
  outreachStates.save();
}

export async function setActiveEnrollment(
  workspaceId: string,
  personIdentityId: string,
  fields: Partial<Pick<PersonOutreachState,
    "activeWorkflowId" | "activeEnrollmentId" | "activeSource" | "activeBusinessUnit" | "ownerId">>,
): Promise<void> {
  const s = await ensureOutreachState(workspaceId, personIdentityId);
  Object.assign(s, fields);
  s.updatedAt = nowIso();
  outreachStates.save();
}

export async function setPressure(
  workspaceId: string,
  personIdentityId: string,
  score: number,
  state: PersonOutreachState["pressureState"],
): Promise<void> {
  const s = await ensureOutreachState(workspaceId, personIdentityId);
  s.contactPressureScore = score;
  s.pressureState = state;
  s.updatedAt = nowIso();
  outreachStates.save();
}

export interface ReplyStopResult {
  cancelledActions: number;
  releasedReservations: number;
  pausedEnrollments: number;
  prospectsFlipped: number;
}

/**
 * THE global reply stop. Idempotent; safe to call on every inbound event.
 * Runs under the engine lock so a reply racing an executor cycle can never
 * let a cancelled action slip out.
 */
export async function globalReplyStop(
  workspaceId: string,
  personIdentityId: string,
  channel: string,
  opts: { reason?: string } = {},
): Promise<ReplyStopResult> {
  const result = await withEngineLock(async (): Promise<ReplyStopResult> => {
    const out: ReplyStopResult = {
      cancelledActions: 0, releasedReservations: 0, pausedEnrollments: 0, prospectsFlipped: 0,
    };
    const s = await ensureOutreachState(workspaceId, personIdentityId);
    s.replyDetected = true;
    s.replyChannel = channel;
    s.lastInboundAt = nowIso();
    s.lastInboundChannel = channel;
    s.automationPaused = true;
    s.pausedReason = opts.reason ?? `Replied on ${channel}`;
    s.pausedAt = nowIso();
    s.updatedAt = nowIso();
    outreachStates.save();

    // Cancel every LinkedIn action that has not reached the provider yet.
    const rows = await listLedger(workspaceId);
    for (const r of rows) {
      if (r.personIdentityId !== personIdentityId) continue;
      if (["requested", "capacity_pending", "retry_pending"].includes(r.status)) {
        releaseReservation(r, "cancelled", `Reply received on ${channel}`);
        out.cancelledActions++;
      } else if (["reserved", "scheduled", "queued"].includes(r.status)) {
        releaseReservation(r, "cancelled", `Reply received on ${channel}`);
        out.cancelledActions++;
        out.releasedReservations++;
      }
      // processing/submitted are already at the provider: leave them be.
    }
    saveLedger();

    // Pause every active LinkedIn enrollment for the person.
    const enr = await enrollments.all();
    for (const e of enr) {
      if (e.workspaceId !== workspaceId || e.personIdentityId !== personIdentityId) continue;
      if (["active", "waiting_capacity", "waiting_accept"].includes(e.status)) {
        e.status = "paused_replied";
        e.nextRunAt = null;
        e.lastEventAt = nowIso();
        out.pausedEnrollments++;
      }
    }
    enrollments.save();
    return out;
  });

  // Flip the linked core prospects so the email cadences drop the person too.
  // runAutopilot only processes status in {queued, in_sequence}; "replied"
  // removes them from every future tick. Outside the lock: core has its own store.
  const identity = await getIdentity(workspaceId, personIdentityId);
  if (identity) {
    const core = getCore();
    for (const pid of identity.prospectIds) {
      try {
        const p = await core.getProspect(pid);
        if (p && (p.status === "queued" || p.status === "in_sequence")) {
          p.status = "replied";
          p.lastChannel = channel as typeof p.lastChannel;
          await core.saveProspect(p);
          result.prospectsFlipped++;
        }
      } catch { /* best-effort per prospect */ }
    }
    // One timeline entry so every surface shows the stop.
    try {
      const first = identity.prospectIds[0];
      if (first) {
        await core.recordActivity({
          id: rid("act"),
          workspaceId,
          prospectId: first,
          channel: "system",
          type: "automation_paused",
          summary: `Global automation paused (${channel} reply): ${result.cancelledActions} future actions cancelled, ${result.releasedReservations} LinkedIn reservations released`,
          at: nowIso(),
        });
      }
    } catch { /* timeline is best-effort */ }
  }
  return result;
}

/** Resume a person's automation after human review. */
export async function resumeAutomation(
  workspaceId: string,
  personIdentityId: string,
): Promise<void> {
  const s = await ensureOutreachState(workspaceId, personIdentityId);
  s.automationPaused = false;
  s.pausedReason = undefined;
  s.replyDetected = false;
  s.updatedAt = nowIso();
  outreachStates.save();
}

/**
 * Reply-stop by core prospect id: the bridge the Response webhook pipeline
 * calls (its `pauseSequences` callback). Resolves the prospect to a canonical
 * identity first so the stop covers every face of the person.
 */
export async function replyStopByProspectId(
  workspaceId: string,
  prospectId: string,
  channel: string,
): Promise<ReplyStopResult | null> {
  const core = getCore();
  const p = await core.getProspect(prospectId);
  if (!p) return null;
  const { resolveIdentity } = await import("./identity");
  const identity = await resolveIdentity(workspaceId, {
    prospectId: p.id,
    email: p.email,
    linkedinUrl: p.linkedinUrl,
    phone: p.phone,
    fullName: p.fullName,
    company: p.company,
  });
  return globalReplyStop(workspaceId, identity.id, channel);
}
