/**
 * RecruitersOS · LinkedIn OS
 * Slow-drip activation: approved contacts (hire signals, big lists) wait in
 * an activation queue and enter their workflow at the fastest RESPONSIBLE
 * pace, checked against real channel capacity each day:
 *
 *   LinkedIn: the shared engine's live headroom (target minus committed)
 *   Email:    the recruiter sender pool's remaining sends today
 *   Pressure: the person's cross-channel contact pressure state
 *
 * Nothing activates blind; every waiting row carries a human reason.
 */

import { rid, nowIso } from "../../core/ids";
import { activationBatches, activationEntries, ledger } from "./store";
import { categoryCounts, policyDay } from "./ledger";
import { getPolicy } from "./policy";
import { getAccount, capacityFactor, executionBlock } from "./health";
import { getOutreachState } from "./outreachState";
import { computePressure } from "./pressure";
import { resolveIdentity } from "./identity";
import { enrollPeople, getLiCampaign } from "./campaigns";
import { PRIORITY_RANK } from "./types";
import type { ActivationBatch, ActivationEntry, BusinessUnit, LiPriority } from "./types";

export interface ApprovedContact {
  fullName: string;
  email?: string;
  linkedinUrl?: string;
  phone?: string;
  company?: string;
  title?: string;
  prospectId?: string;
}

export interface AddBatchInput {
  workspaceId: string;
  name: string;
  signalLabel?: string;
  signalId?: string;
  companyName?: string;
  mode?: ActivationBatch["mode"];
  dailyTarget?: number;
  businessUnit: BusinessUnit;
  priority?: LiPriority;
  ownerId?: string;
  approvedBy?: string;
  target: ActivationEntry["target"];
  contacts: ApprovedContact[];
}

/** Approve a batch of contacts into the activation queue (post review). */
export async function addActivationBatch(input: AddBatchInput): Promise<ActivationBatch> {
  const batches = await activationBatches.all();
  const entries = await activationEntries.all();
  const batch: ActivationBatch = {
    id: rid("libatch"),
    workspaceId: input.workspaceId,
    name: input.name,
    signalLabel: input.signalLabel,
    signalId: input.signalId,
    companyName: input.companyName,
    mode: input.mode ?? "dynamic_slow_drip",
    dailyTarget: Math.min(500, Math.max(1, input.dailyTarget ?? 25)),
    businessUnit: input.businessUnit,
    createdAt: nowIso(),
  };
  batches.push(batch);
  activationBatches.save();

  for (const c of input.contacts.slice(0, 2000)) {
    const identity = await resolveIdentity(input.workspaceId, {
      prospectId: c.prospectId,
      email: c.email,
      linkedinUrl: c.linkedinUrl,
      phone: c.phone,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
    });
    entries.push({
      id: rid("liactq"),
      workspaceId: input.workspaceId,
      batchId: batch.id,
      personIdentityId: identity.id,
      prospectId: c.prospectId,
      displayName: c.fullName || identity.fullName || "Unknown",
      signalLabel: input.signalLabel,
      target: input.target,
      businessUnit: input.businessUnit,
      priority: input.priority ?? "normal",
      ownerId: input.ownerId,
      status: "waiting",
      waitReason: "Campaign activation target",
      approvedBy: input.approvedBy,
      approvedAt: nowIso(),
    });
  }
  activationEntries.save();
  return batch;
}

export async function listActivation(workspaceId: string): Promise<{
  batches: ActivationBatch[]; entries: ActivationEntry[];
}> {
  const batches = (await activationBatches.all()).filter((b) => b.workspaceId === workspaceId);
  const entries = (await activationEntries.all()).filter((e) => e.workspaceId === workspaceId);
  return { batches, entries };
}

export async function cancelActivationEntry(workspaceId: string, id: string): Promise<boolean> {
  const entries = await activationEntries.all();
  const e = entries.find((x) => x.workspaceId === workspaceId && x.id === id);
  if (!e || e.status !== "waiting") return false;
  e.status = "cancelled";
  activationEntries.save();
  return true;
}

/** Remaining LinkedIn connection headroom today for an account. */
async function linkedinHeadroom(workspaceId: string, accountId: string): Promise<{ open: number; reason?: string }> {
  const account = await getAccount(workspaceId, accountId);
  const block = executionBlock(account);
  if (block) return { open: 0, reason: block };
  const policy = await getPolicy(workspaceId, accountId);
  const factor = capacityFactor(account);
  const day = policyDay(policy.timezone);
  const all = await ledger.all();
  const counts = categoryCounts(all, accountId, "connections", day);
  const target = Math.floor(policy.categories.connections.dailyTarget * factor);
  const open = target - (counts.used + counts.reserved + counts.waiting);
  return open > 0
    ? { open }
    : { open: 0, reason: "Waiting for LinkedIn capacity" };
}

/** Remaining email pool capacity today for the workspace. */
async function emailHeadroom(workspaceId: string): Promise<{ open: number; reason?: string }> {
  try {
    const { poolCapacity } = await import("../../senders");
    const cap = await poolCapacity(workspaceId);
    if (cap.inboxes === 0) return { open: Number.MAX_SAFE_INTEGER }; // no pool: not the gate
    return cap.remainingToday > 0
      ? { open: cap.remainingToday }
      : { open: 0, reason: "Waiting for email capacity" };
  } catch {
    return { open: Number.MAX_SAFE_INTEGER };
  }
}

const dayKey = (): string => nowIso().slice(0, 10);

/**
 * One activation pass: per batch, activate up to the daily target, but only
 * as far as today's channel capacity responsibly allows. Priority order:
 * critical batches drink first; inside a batch, FIFO by approval time.
 */
export async function tickActivation(): Promise<number> {
  const batches = await activationBatches.all();
  const entries = await activationEntries.all();
  if (!entries.some((e) => e.status === "waiting")) return 0;

  let activatedTotal = 0;
  const byWs = new Map<string, ActivationBatch[]>();
  for (const b of batches) {
    if (!byWs.has(b.workspaceId)) byWs.set(b.workspaceId, []);
    (byWs.get(b.workspaceId) as ActivationBatch[]).push(b);
  }

  for (const [workspaceId, wsBatches] of byWs) {
    const email = await emailHeadroom(workspaceId);
    let emailOpen = email.open;

    // Sort batches by the priority of their waiting entries (critical first).
    const sorted = wsBatches.slice().sort((a, b) => {
      const pa = Math.min(...entries.filter((e) => e.batchId === a.id && e.status === "waiting").map((e) => PRIORITY_RANK[e.priority]), 9);
      const pb = Math.min(...entries.filter((e) => e.batchId === b.id && e.status === "waiting").map((e) => PRIORITY_RANK[e.priority]), 9);
      return pa - pb;
    });

    for (const batch of sorted) {
      const waiting = entries
        .filter((e) => e.batchId === batch.id && e.status === "waiting")
        .sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1));
      if (!waiting.length) continue;

      const activatedToday = entries.filter((e) =>
        e.batchId === batch.id && e.status === "activated" &&
        (e.activatedAt ?? "").slice(0, 10) === dayKey()).length;
      let budget = batch.mode === "immediate"
        ? waiting.length
        : Math.max(0, batch.dailyTarget - activatedToday);
      if (budget <= 0) {
        for (const e of waiting) e.waitReason = "Campaign activation target";
        continue;
      }

      // LinkedIn headroom is per target campaign account.
      const liOpenByAccount = new Map<string, { open: number; reason?: string }>();

      for (const e of waiting) {
        if (budget <= 0) { e.waitReason = "Campaign activation target"; continue; }

        // Channel capacity gates.
        if (e.target.kind === "linkedin_campaign") {
          const campaign = await getLiCampaign(workspaceId, e.target.id);
          if (!campaign) { e.status = "cancelled"; e.waitReason = "Target campaign was deleted"; continue; }
          if (!liOpenByAccount.has(campaign.accountId)) {
            liOpenByAccount.set(campaign.accountId, await linkedinHeadroom(workspaceId, campaign.accountId));
          }
          const li = liOpenByAccount.get(campaign.accountId) as { open: number; reason?: string };
          if (li.open <= 0) { e.waitReason = li.reason ?? "Waiting for LinkedIn capacity"; e.expected = "Later today or next operating window"; continue; }
          li.open -= 1;
        } else if (emailOpen <= 0) {
          e.waitReason = email.reason ?? "Waiting for email capacity";
          e.expected = "Later today or next operating window";
          continue;
        }

        // Pressure gate.
        try {
          const state = await getOutreachState(workspaceId, e.personIdentityId);
          if (state?.automationPaused) { e.status = "skipped"; e.waitReason = state.pausedReason ?? "Automation paused"; continue; }
          if (e.target.kind === "linkedin_campaign") {
            const campaign = await getLiCampaign(workspaceId, e.target.id);
            if (campaign) {
              const policy = await getPolicy(workspaceId, campaign.accountId);
              const p = await computePressure(workspaceId, e.personIdentityId, policy.pressure);
              if (p.state === "high" || p.state === "elevated") {
                e.waitReason = "Contact pressure cooldown";
                e.expected = "When pressure returns to normal";
                continue;
              }
            }
          }
        } catch { /* pressure is advisory at activation time */ }

        // Activate.
        if (e.target.kind === "linkedin_campaign") {
          const res = await enrollPeople(workspaceId, e.target.id, [{
            prospectId: e.prospectId,
            fullName: e.displayName,
          }], { transfer: false });
          if (res.conflicts.length) {
            e.waitReason = "Higher priority campaign owns this person";
            continue;
          }
          if (!res.enrolled) {
            e.status = "skipped";
            e.waitReason = res.skipped[0]?.reason ?? "Could not enroll";
            continue;
          }
        } else {
          // Core (multichannel/email) campaign: flip the prospect to queued so
          // the cadence engines pick it up on their next tick.
          try {
            if (e.prospectId) {
              const { getCore } = await import("../../core/repository");
              const p = await getCore().getProspect(e.prospectId);
              if (p) {
                p.campaignId = e.target.id;
                p.status = "queued";
                await getCore().saveProspect(p);
              }
            }
            emailOpen -= 1;
          } catch { /* activation is per-entry best-effort */ }
        }
        e.status = "activated";
        e.activatedAt = nowIso();
        e.waitReason = undefined;
        e.expected = undefined;
        budget -= 1;
        activatedTotal += 1;
      }
    }
  }
  if (activatedTotal) activationEntries.save();
  else activationEntries.save(); // persist refreshed wait reasons too
  return activatedTotal;
}
