/**
 * RecruitersOS · LinkedIn OS
 * The shared engine entry point. EVERY LinkedIn action request in RecruitersOS
 * comes through `requestLinkedInAction`, whatever created it: a LinkedIn
 * campaign, a multichannel workflow, a hire signal, a manual send, an AI
 * workflow. The pipeline is the spec's, in order:
 *
 *   validate person state -> campaign conflict -> contact pressure ->
 *   account health -> action policy -> available capacity -> RESERVE ->
 *   SCHEDULE -> (executor) -> provider -> ledger update
 *
 * Nothing in this file talks to the provider; execution lives in executor.ts.
 */

import { rid, nowIso } from "../../core/ids";
import { isSuppressed } from "../../response/suppression";
import { ledger, withEngineLock } from "./store";
import {
  categoryCounts, findByIdempotencyKey, policyDay, releaseReservation, saveLedger,
} from "./ledger";
import { getPolicy } from "./policy";
import { getAccount, capacityFactor, executionBlock } from "./health";
import { getIdentity, resolveIdentity, type IdentityHint } from "./identity";
import { computePressure } from "./pressure";
import {
  ensureOutreachState, getOutreachState, setPressure, touchOutbound,
} from "./outreachState";
import { capCategoryOf } from "./types";
import type {
  AccountPolicy, BusinessUnit, LiActionRecord, LiActionType, LiPriority,
  LiSourceType,
} from "./types";

export interface ActionRequest {
  workspaceId: string;
  accountId: string;
  /** Either a resolved identity id, or handles the engine resolves for you. */
  personIdentityId?: string;
  person?: IdentityHint;
  actionType: LiActionType;
  payload?: LiActionRecord["payload"];
  businessUnit: BusinessUnit;
  sourceType: LiSourceType;
  priority?: LiPriority;
  campaignId?: string;
  workflowId?: string;
  workflowEnrollmentId?: string;
  sequenceStepId?: string;
  idempotencyKey?: string;
  approvedBy?: string;
  signalId?: string;
  /** Authorized push past the daily target (never past the hard ceiling). */
  allowOverTarget?: boolean;
}

export interface ActionRequestResult {
  record: LiActionRecord;
  accepted: boolean;
  /** Human explanation when the action is waiting / suppressed / paused. */
  reason?: string;
}

function jitterMinutes(policy: AccountPolicy): number {
  const { minDelayMinutes, maxDelayMinutes, randomizedTiming } = policy.pacing;
  if (!randomizedTiming) return minDelayMinutes;
  return minDelayMinutes + Math.random() * Math.max(0, maxDelayMinutes - minDelayMinutes);
}

function insideWorkingHours(policy: AccountPolicy, at: Date): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: policy.timezone || "UTC", hour: "numeric", weekday: "short", hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd) + 1;
    const { startHour, endHour, days } = policy.workingHours;
    return days.includes(day) && hour >= startHour && hour < endHour;
  } catch {
    return true;
  }
}

/** Next moment inside the working window at/after `from`. */
function nextWorkingMoment(policy: AccountPolicy, from: Date): Date {
  const probe = new Date(from);
  for (let i = 0; i < 24 * 8; i++) {
    if (insideWorkingHours(policy, probe)) return probe;
    probe.setTime(probe.getTime() + 30 * 60_000);
  }
  return from;
}

/**
 * Pacing: the next execution slot on this account. Burst protection walks
 * forward from the latest already-scheduled action; without it actions may
 * share a slot (still jittered by the executor).
 */
function nextSlot(policy: AccountPolicy, rows: LiActionRecord[], accountId: string): Date {
  let base = new Date();
  if (policy.pacing.burstProtection) {
    let latest = 0;
    for (const r of rows) {
      if (r.accountId !== accountId) continue;
      if (r.status === "scheduled" || r.status === "queued" || r.status === "processing") {
        const t = r.scheduledAt ? Date.parse(r.scheduledAt) : 0;
        if (t > latest) latest = t;
      }
    }
    if (latest > Date.now()) base = new Date(latest);
  }
  const spaced = new Date(base.getTime() + jitterMinutes(policy) * 60_000);
  return nextWorkingMoment(policy, spaced);
}

/**
 * Request one LinkedIn action. Returns the ledger record; `accepted` is true
 * when the action was reserved + scheduled, false when it is waiting, paused
 * or suppressed (`reason` explains why, in UI-ready language).
 */
export async function requestLinkedInAction(req: ActionRequest): Promise<ActionRequestResult> {
  const {
    workspaceId, accountId, actionType, businessUnit, sourceType,
  } = req;
  const priority: LiPriority = req.priority ?? "normal";

  // Idempotency first: a retried worker gets the original record back.
  if (req.idempotencyKey) {
    const existing = await findByIdempotencyKey(workspaceId, req.idempotencyKey);
    if (existing) {
      return { record: existing, accepted: existing.status !== "suppressed", reason: existing.statusReason };
    }
  }

  // Resolve the canonical person (outside the lock; resolveIdentity locks itself).
  const identity = req.personIdentityId
    ? await getIdentity(workspaceId, req.personIdentityId)
    : req.person
      ? await resolveIdentity(workspaceId, req.person)
      : null;
  if (!identity) {
    const record = baseRecord(req, priority, "unknown_person");
    record.status = "suppressed";
    record.statusReason = "Person could not be resolved to an identity";
    await pushRecord(record);
    return { record, accepted: false, reason: record.statusReason };
  }

  const record = baseRecord(req, priority, identity.id);

  // 1. Person state: suppression list, then the global reply/automation pause.
  const handles = [...identity.emails, ...identity.linkedinUrls, ...identity.phones];
  for (const h of handles) {
    if (await isSuppressed(workspaceId, h)) {
      record.status = "suppressed";
      record.statusReason = "Person is on the do-not-contact list";
      await pushRecord(record);
      return { record, accepted: false, reason: record.statusReason };
    }
  }
  const state = await getOutreachState(workspaceId, identity.id);
  if (sourceType !== "manual" && state?.automationPaused) {
    record.status = "suppressed";
    record.statusReason = state.pausedReason ?? "Automation is paused for this person";
    await pushRecord(record);
    return { record, accepted: false, reason: record.statusReason };
  }

  // 2. Campaign conflict: one automated workflow per person at a time.
  if (sourceType !== "manual") {
    const enrollmentKey = req.workflowEnrollmentId;
    const activeEnrollment = state?.activeEnrollmentId;
    if (activeEnrollment && enrollmentKey && activeEnrollment !== enrollmentKey) {
      record.status = "suppressed";
      record.statusReason = "Person is already active in another automated workflow";
      await pushRecord(record);
      return { record, accepted: false, reason: record.statusReason };
    }
  }

  const policy = await getPolicy(workspaceId, accountId);

  // 3. Contact pressure (skip for warmup-class actions and manual sends).
  const pressured = ["connect", "connect_note", "message", "voice_note", "inmail", "attachment"];
  if (sourceType !== "manual" && pressured.includes(actionType)) {
    const reading = await computePressure(workspaceId, identity.id, policy.pressure);
    await setPressure(workspaceId, identity.id, reading.score, reading.state);
    const act = reading.state === "high" ? policy.pressure.highAction
      : reading.state === "elevated" ? policy.pressure.elevatedAction : "none";
    if (act === "pause_review") {
      record.status = "paused";
      record.statusReason = `Contact pressure is ${reading.state.toUpperCase()} (${reading.score} weighted touches in ${policy.pressure.windowDays} days); paused for review`;
      await pushRecord(record);
      return { record, accepted: false, reason: record.statusReason };
    }
    if (act === "defer_low_priority" && (priority === "low" || priority === "normal")) {
      record.status = "capacity_pending";
      record.statusReason = `Deferred: contact pressure is ${reading.state}`;
      await pushRecord(record);
      return { record, accepted: false, reason: record.statusReason };
    }
    // increase_spacing is applied at scheduling time below.
    if (act === "increase_spacing") record.statusReason = "Spacing increased: elevated contact pressure";
  }

  // 4-7. Health, policy, capacity, reservation: atomic under the engine lock.
  return withEngineLock(async () => {
    const account = await getAccount(workspaceId, accountId);
    const block = executionBlock(account);
    if (block) {
      record.status = "capacity_pending";
      record.statusReason = block;
      const all = await ledger.all();
      all.push(record);
      ledger.save();
      return { record, accepted: false, reason: block };
    }

    const category = capCategoryOf(actionType);
    if (category) {
      const all = await ledger.all();
      const factor = capacityFactor(account);
      const target = Math.floor(policy.categories[category].dailyTarget * factor);
      const ceiling = policy.categories[category].hardCeiling;

      // Book against the day the action will actually run.
      const slot = nextSlot(policy, all, accountId);
      const day = policyDay(policy.timezone, slot);
      const counts = categoryCounts(all, accountId, category, day);
      const committed = counts.used + counts.reserved;

      if (committed >= ceiling) {
        record.status = "capacity_pending";
        record.statusReason = `Waiting for LinkedIn capacity: ${committed} of ${ceiling} hard ceiling committed for ${category.replace("_", " ")}`;
        all.push(record);
        ledger.save();
        return { record, accepted: false, reason: record.statusReason };
      }
      if (committed >= target && !req.allowOverTarget) {
        record.status = "capacity_pending";
        record.statusReason = `Waiting for LinkedIn capacity: daily target reached (${committed}/${target} ${category.replace("_", " ")}, hard ceiling ${ceiling})`;
        all.push(record);
        ledger.save();
        return { record, accepted: false, reason: record.statusReason };
      }

      // RESERVE + SCHEDULE.
      record.status = "scheduled";
      record.reservedAt = nowIso();
      let scheduledAt = slot;
      if (record.statusReason?.startsWith("Spacing increased")) {
        scheduledAt = new Date(slot.getTime() + jitterMinutes(policy) * 60_000);
      }
      record.scheduledAt = scheduledAt.toISOString();
      record.capacityDay = policyDay(policy.timezone, scheduledAt);
      record.statusReason = undefined;
      all.push(record);
      ledger.save();
      return { record, accepted: true };
    }

    // Uncapped housekeeping (withdraw_invite): schedule directly.
    record.status = "scheduled";
    record.reservedAt = nowIso();
    record.scheduledAt = nowIso();
    record.capacityDay = policyDay(policy.timezone);
    const all = await ledger.all();
    all.push(record);
    ledger.save();
    return { record, accepted: true };
  });
}

function baseRecord(req: ActionRequest, priority: LiPriority, personIdentityId: string): LiActionRecord {
  return {
    id: rid("liact"),
    workspaceId: req.workspaceId,
    accountId: req.accountId,
    personIdentityId,
    campaignId: req.campaignId,
    workflowId: req.workflowId,
    workflowEnrollmentId: req.workflowEnrollmentId,
    sequenceStepId: req.sequenceStepId,
    businessUnit: req.businessUnit,
    sourceType: req.sourceType,
    actionType: req.actionType,
    priority,
    idempotencyKey: req.idempotencyKey ?? rid("lik"),
    payload: req.payload ?? {},
    status: "requested",
    requestedAt: nowIso(),
    retryCount: 0,
    approvedBy: req.approvedBy,
    signalId: req.signalId,
  };
}

async function pushRecord(record: LiActionRecord): Promise<void> {
  await withEngineLock(async () => {
    const all = await ledger.all();
    all.push(record);
    ledger.save();
  });
}

/** Cancel one pending action and release its reservation. */
export async function cancelAction(
  workspaceId: string,
  actionId: string,
  reason: string,
): Promise<LiActionRecord | null> {
  return withEngineLock(async () => {
    const all = await ledger.all();
    const r = all.find((x) => x.workspaceId === workspaceId && x.id === actionId) ?? null;
    if (!r) return null;
    if (["requested", "capacity_pending", "reserved", "scheduled", "queued", "retry_pending", "paused"].includes(r.status)) {
      releaseReservation(r, "cancelled", reason);
      saveLedger();
    }
    return r;
  });
}

/**
 * Promote one waiting action past the daily target (authorized "Allow
 * Temporary Capacity"). Still refuses to pass the hard ceiling: that wall is
 * never silently crossed.
 */
export async function allowTemporaryCapacity(
  workspaceId: string,
  actionId: string,
  by: string,
): Promise<ActionRequestResult | null> {
  const record = await withEngineLock(async () => {
    const all = await ledger.all();
    return all.find((x) => x.workspaceId === workspaceId && x.id === actionId) ?? null;
  });
  if (!record || record.status !== "capacity_pending") return null;
  const policy = await getPolicy(workspaceId, record.accountId);
  return withEngineLock(async () => {
    const all = await ledger.all();
    const category = capCategoryOf(record.actionType);
    if (category) {
      const slot = nextSlot(policy, all, record.accountId);
      const day = policyDay(policy.timezone, slot);
      const counts = categoryCounts(all, record.accountId, category, day);
      const ceiling = policy.categories[category].hardCeiling;
      if (counts.used + counts.reserved >= ceiling) {
        record.statusReason = `Still waiting: the hard ceiling (${ceiling}) is committed; the ceiling is never bypassed`;
        saveLedger();
        return { record, accepted: false, reason: record.statusReason };
      }
      record.status = "scheduled";
      record.reservedAt = nowIso();
      record.scheduledAt = slot.toISOString();
      record.capacityDay = day;
      record.statusReason = `Temporary capacity allowed by ${by}`;
      record.approvedBy = by;
      saveLedger();
      return { record, accepted: true };
    }
    return { record, accepted: false, reason: "Action is not capacity gated" };
  });
}

/** Record the outbound on the person state after a successful execution. */
export async function noteOutbound(record: LiActionRecord): Promise<void> {
  await ensureOutreachState(record.workspaceId, record.personIdentityId);
  await touchOutbound(record.workspaceId, record.personIdentityId, `linkedin_${record.actionType}`);
}
