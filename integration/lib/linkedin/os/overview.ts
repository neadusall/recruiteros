/**
 * RecruitersOS · LinkedIn OS
 * Read models for the tool UI: overview, utilization, the live queue, the
 * people table, per-action audit trails and the person cross-channel
 * timeline. Pure aggregation over the engine stores; no mutations here.
 */

import { getCore } from "../../core/repository";
import { listLedger, utilizationFor, policyDay, weeklyUsed } from "./ledger";
import { getPolicy } from "./policy";
import { listAccounts, capacityFactor, recentSignals } from "./health";
import { listLiCampaigns, listEnrollments } from "./campaigns";
import { listConversations } from "./inbox";
import { listIdentities, getIdentity } from "./identity";
import { outreachStates } from "./store";
import { listActivation } from "./activation";
import { allocate, type AllocationInput } from "./allocation";
import { capCategoryOf, HOLDING_STATUSES, USED_STATUSES } from "./types";
import type {
  BusinessUnit, LiAccountState, LiActionRecord, LiCapCategory,
} from "./types";

/* ---------------- account + utilization ---------------- */

export async function accountOverview(workspaceId: string, accountId: string) {
  const [rows, policy, accounts] = await Promise.all([
    listLedger(workspaceId),
    getPolicy(workspaceId, accountId),
    listAccounts(workspaceId),
  ]);
  const account = accounts.find((a) => a.accountId === accountId) ?? null;
  const factor = capacityFactor(account);
  const day = policyDay(policy.timezone);
  const categories = utilizationFor(rows, policy, accountId, day, factor);

  const totalTarget = categories.reduce((s, c) => s + c.effectiveTarget, 0);
  const totalCommitted = categories.reduce((s, c) => s + c.used + c.reserved, 0);
  const totalPct = totalTarget > 0 ? Math.round((totalCommitted / totalTarget) * 100) : 0;

  // Business unit split of today's committed capacity.
  const split: Record<BusinessUnit, number> = { recruiting: 0, bd: 0 };
  for (const r of rows) {
    if (r.accountId !== accountId || r.capacityDay !== day) continue;
    if (USED_STATUSES.includes(r.status) || HOLDING_STATUSES.includes(r.status)) {
      split[r.businessUnit] += 1;
    }
  }
  const committed = split.recruiting + split.bd;
  const recruitingPct = committed ? Math.round((split.recruiting / committed) * 100) : 0;
  const bdPct = committed ? Math.round((split.bd / committed) * 100) : 0;

  const weekly: Partial<Record<LiCapCategory, { used: number; target: number }>> = {};
  (["connections", "messages", "voice_notes"] as LiCapCategory[]).forEach((c) => {
    weekly[c] = { used: weeklyUsed(rows, accountId, c, policy.timezone), target: policy.categories[c].weeklyTarget };
  });

  return {
    account,
    policy,
    day,
    healthFactor: factor,
    utilizationPct: Math.min(100, totalPct),
    recruitingPct,
    bdPct,
    availablePct: Math.max(0, 100 - Math.min(100, totalPct)),
    categories,
    weekly,
    riskSignals: account ? recentSignals(account, 8) : [],
  };
}

/* ---------------- queue views ---------------- */

export interface QueueRow {
  id: string;
  at?: string;
  actionType: string;
  status: string;
  statusReason?: string;
  personName: string;
  campaignName?: string;
  businessUnit: BusinessUnit;
  priority: string;
  accountId: string;
}

export async function liveQueue(workspaceId: string, limit = 100): Promise<QueueRow[]> {
  const [rows, campaigns, idents] = await Promise.all([
    listLedger(workspaceId), listLiCampaigns(workspaceId), listIdentities(workspaceId),
  ]);
  const cName = new Map(campaigns.map((c) => [c.id, c.name]));
  const iName = new Map(idents.map((i) => [i.id, i.fullName ?? "Unknown"]));
  return rows
    .filter((r) => ["scheduled", "queued", "processing", "capacity_pending", "retry_pending", "paused"].includes(r.status))
    .sort((a, b) => (a.scheduledAt ?? a.requestedAt) < (b.scheduledAt ?? b.requestedAt) ? -1 : 1)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      at: r.scheduledAt ?? undefined,
      actionType: r.actionType,
      status: r.status,
      statusReason: r.statusReason,
      personName: iName.get(r.personIdentityId) ?? "Unknown",
      campaignName: r.campaignId ? cName.get(r.campaignId) : undefined,
      businessUnit: r.businessUnit,
      priority: r.priority,
      accountId: r.accountId,
    }));
}

export async function recentLedger(workspaceId: string, limit = 100): Promise<LiActionRecord[]> {
  const rows = await listLedger(workspaceId);
  return rows
    .slice()
    .sort((a, b) => (b.requestedAt < a.requestedAt ? -1 : 1))
    .slice(0, limit);
}

/* ---------------- allocation view ---------------- */

export async function allocationView(workspaceId: string, accountId: string) {
  const [rows, campaigns, policy, accounts] = await Promise.all([
    listLedger(workspaceId), listLiCampaigns(workspaceId),
    getPolicy(workspaceId, accountId), listAccounts(workspaceId),
  ]);
  const account = accounts.find((a) => a.accountId === accountId) ?? null;
  const factor = capacityFactor(account);
  const day = policyDay(policy.timezone);

  // Demand + usage per source key across ALL capped categories today.
  const demand = new Map<string, number>();
  const used = new Map<string, number>();
  for (const r of rows) {
    if (r.accountId !== accountId) continue;
    if (!capCategoryOf(r.actionType)) continue;
    const key = r.campaignId ?? r.workflowId ?? r.sourceType;
    if (["capacity_pending", "requested", "retry_pending"].includes(r.status)) {
      demand.set(key, (demand.get(key) ?? 0) + 1);
    }
    if (r.capacityDay === day && (USED_STATUSES.includes(r.status) || HOLDING_STATUSES.includes(r.status))) {
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  }
  const totalTarget = (Object.keys(policy.categories) as LiCapCategory[])
    .reduce((s, c) => s + Math.floor(policy.categories[c].dailyTarget * factor), 0);
  const totalCommitted = [...used.values()].reduce((s, v) => s + v, 0);
  const available = Math.max(0, totalTarget - totalCommitted);

  const inputs: AllocationInput[] = [];
  const keys = new Set([...demand.keys(), ...used.keys()]);
  for (const key of keys) {
    const c = campaigns.find((x) => x.id === key);
    inputs.push({
      key,
      name: c?.name ?? (key === "manual" ? "Manual actions" : key === "multichannel_workflow" ? "Multichannel workflows" : key === "hire_signal" ? "Hire signals" : key),
      businessUnit: c?.type ?? "bd",
      priority: c?.priority ?? "normal",
      weight: c?.weight ?? 30,
      minAllocation: c?.minAllocation,
      maxAllocation: c?.maxAllocation,
      demand: demand.get(key) ?? 0,
      usedToday: used.get(key) ?? 0,
    });
  }
  return { available, slices: allocate(available, inputs) };
}

/* ---------------- overview snapshot ---------------- */

export async function overviewSnapshot(workspaceId: string, businessUnit?: BusinessUnit) {
  const [accounts, campaigns, convos, activation] = await Promise.all([
    listAccounts(workspaceId), listLiCampaigns(workspaceId),
    listConversations(workspaceId), listActivation(workspaceId),
  ]);
  const rows = await listLedger(workspaceId);
  const account = accounts[0] ?? null;
  const util = account ? await accountOverview(workspaceId, account.accountId) : null;

  const enroll = await listEnrollments(workspaceId);
  const campaignCards = campaigns
    .filter((c) => c.status !== "archived" && (!businessUnit || c.type === businessUnit))
    .map((c) => {
      const ce = enroll.filter((e) => e.campaignId === c.id);
      const replies = convos.filter((x) => x.campaignId === c.id && x.messages.some((m) => !m.fromSelf)).length;
      return {
        id: c.id, name: c.name, type: c.type, status: c.status, priority: c.priority,
        weight: c.weight, people: ce.length,
        active: ce.filter((e) => ["active", "waiting_capacity", "waiting_accept"].includes(e.status)).length,
        waitingCapacity: ce.filter((e) => e.status === "waiting_capacity").length,
        replies,
        replyRate: ce.length ? Math.round((replies / ce.length) * 1000) / 10 : 0,
      };
    });

  const queued = rows.filter((r) => ["scheduled", "queued", "capacity_pending", "retry_pending"].includes(r.status)).length;
  const needsAttention = convos.filter((c) => c.needsAttention).length;
  const waitingActivation = activation.entries.filter((e) => e.status === "waiting").length;

  // Recent activity feed from the ledger + inbox.
  const feed: Array<{ at: string; text: string; tag: string }> = [];
  for (const c of convos.slice(0, 30)) {
    const last = c.messages[c.messages.length - 1];
    if (last && !last.fromSelf) {
      feed.push({ at: last.at, text: `${c.displayName} replied${last.kind === "voice" ? " to a voice note" : ""}`, tag: c.businessUnit === "recruiting" ? "Recruiting" : "BD" });
    }
  }
  for (const r of rows.slice(-60)) {
    if (r.status === "success") {
      feed.push({ at: r.completedAt ?? r.requestedAt, text: `${r.actionType.replace(/_/g, " ")} sent`, tag: r.businessUnit === "recruiting" ? "Recruiting" : "BD" });
    }
    if (r.status === "capacity_pending") {
      feed.push({ at: r.requestedAt, text: "LinkedIn action delayed for capacity", tag: "System" });
    }
  }
  feed.sort((a, b) => (b.at < a.at ? -1 : 1));

  return {
    account: account ? {
      accountId: account.accountId,
      displayName: account.displayName,
      health: account.health,
      healthReason: account.healthReason,
      connected: account.connected,
      killSwitch: account.killSwitch,
      products: account.products,
    } : null,
    utilization: util,
    campaigns: campaignCards,
    queue: await liveQueue(workspaceId, 12),
    counters: { queued, needsAttention, waitingActivation },
    feed: feed.slice(0, 12),
  };
}

/* ---------------- people ---------------- */

export async function peopleView(workspaceId: string, businessUnit?: BusinessUnit) {
  const [idents, states, enroll, campaigns, rows] = await Promise.all([
    listIdentities(workspaceId),
    outreachStates.all().then((all) => all.filter((s) => s.workspaceId === workspaceId)),
    listEnrollments(workspaceId),
    listLiCampaigns(workspaceId),
    listLedger(workspaceId),
  ]);
  const stateById = new Map(states.map((s) => [s.personIdentityId, s]));
  const cById = new Map(campaigns.map((c) => [c.id, c]));

  return idents
    .map((p) => {
      const s = stateById.get(p.id);
      const e = enroll.find((x) => x.personIdentityId === p.id &&
        !["completed", "stopped", "failed"].includes(x.status));
      const campaign = e ? cById.get(e.campaignId) : undefined;
      const personRows = rows.filter((r) => r.personIdentityId === p.id);
      const lastAction = personRows
        .filter((r) => r.status === "success")
        .sort((a, b) => ((b.completedAt ?? "") < (a.completedAt ?? "") ? -1 : 1))[0];
      return {
        id: p.id,
        name: p.fullName ?? "Unknown",
        company: p.company,
        title: p.title,
        linkedinUrl: p.linkedinUrls[0],
        connectionDegree: p.connectionDegree,
        connected: Boolean(p.connectedAt),
        personTypes: personTypes(p.prospectIds.length > 0, businessUnit),
        businessUnit: e?.businessUnit ?? campaign?.type,
        campaignName: campaign?.name,
        enrollmentStatus: e?.status,
        stepIndex: e ? e.stepIndex + 1 : undefined,
        stepCount: campaign?.steps.length,
        lastActionAt: lastAction?.completedAt,
        lastActionType: lastAction?.actionType,
        lastReplyAt: s?.lastInboundAt,
        pressure: s?.pressureState ?? "low",
        automationPaused: s?.automationPaused ?? false,
        ownerId: s?.ownerId,
      };
    })
    .filter((row) => !businessUnit || !row.businessUnit || row.businessUnit === businessUnit)
    .sort((a, b) => ((b.lastActionAt ?? "") < (a.lastActionAt ?? "") ? -1 : 1));
}

function personTypes(hasProspect: boolean, bu?: BusinessUnit): string[] {
  if (!hasProspect) return ["Person"];
  if (bu === "recruiting") return ["Candidate"];
  if (bu === "bd") return ["Prospect"];
  return ["Prospect"];
}

/* ---------------- audit trail + timeline ---------------- */

/** "Why did RecruitersOS send this?" for one ledger action. */
export async function explainAction(workspaceId: string, actionId: string) {
  const rows = await listLedger(workspaceId);
  const r = rows.find((x) => x.id === actionId);
  if (!r) return null;
  const [identity, campaigns, accounts] = await Promise.all([
    getIdentity(workspaceId, r.personIdentityId),
    listLiCampaigns(workspaceId),
    listAccounts(workspaceId),
  ]);
  const campaign = r.campaignId ? campaigns.find((c) => c.id === r.campaignId) : undefined;
  const account = accounts.find((a) => a.accountId === r.accountId);
  const policy = await getPolicy(workspaceId, r.accountId);
  const states = await outreachStates.all();
  const state = states.find((s) => s.workspaceId === workspaceId && s.personIdentityId === r.personIdentityId);
  return {
    action: r,
    person: identity ? { name: identity.fullName, company: identity.company, title: identity.title } : null,
    source: r.sourceType,
    signalId: r.signalId,
    approvedBy: r.approvedBy,
    campaign: campaign ? { id: campaign.id, name: campaign.name, type: campaign.type } : null,
    businessUnit: r.businessUnit,
    stepId: r.sequenceStepId,
    pressure: state?.pressureState ?? "low",
    account: account ? { id: account.accountId, name: account.displayName, health: account.health } : null,
    policyMode: policy.mode,
    timeline: [
      { label: "Requested", at: r.requestedAt },
      r.reservedAt ? { label: "Reserved", at: r.reservedAt } : null,
      r.scheduledAt ? { label: "Scheduled", at: r.scheduledAt } : null,
      r.submittedAt ? { label: "Submitted", at: r.submittedAt } : null,
      r.completedAt ? { label: r.status === "success" ? "Success" : "Completed", at: r.completedAt } : null,
      r.cancelledAt ? { label: "Cancelled", at: r.cancelledAt } : null,
    ].filter(Boolean),
    provider: "Unipile",
    result: r.status,
    failureReason: r.failureReason,
  };
}

/** One person's full cross-channel timeline (ledger + core activity + inbox). */
export async function personTimeline(workspaceId: string, personIdentityId: string) {
  const identity = await getIdentity(workspaceId, personIdentityId);
  if (!identity) return { identity: null, events: [] };
  const rows = (await listLedger(workspaceId)).filter((r) => r.personIdentityId === personIdentityId);
  const events: Array<{ at: string; channel: string; text: string }> = [];

  for (const r of rows) {
    if (r.status === "success") {
      events.push({ at: r.completedAt ?? r.requestedAt, channel: "linkedin", text: `LinkedIn ${r.actionType.replace(/_/g, " ")} sent` });
    } else if (r.status === "cancelled") {
      events.push({ at: r.cancelledAt ?? r.requestedAt, channel: "system", text: `LinkedIn ${r.actionType.replace(/_/g, " ")} cancelled: ${r.statusReason ?? ""}` });
    }
  }
  const core = getCore();
  for (const pid of identity.prospectIds) {
    try {
      const acts = await core.listActivity(pid);
      for (const a of acts) events.push({ at: a.at, channel: a.channel, text: a.summary });
    } catch { /* per-prospect best-effort */ }
  }
  const convos = await listConversations(workspaceId);
  for (const c of convos) {
    if (c.personIdentityId !== personIdentityId) continue;
    for (const m of c.messages) {
      if (!m.fromSelf) events.push({ at: m.at, channel: "linkedin", text: `Reply received: ${(m.text ?? "(voice reply)").slice(0, 120)}` });
    }
  }
  events.sort((a, b) => (b.at < a.at ? -1 : 1));
  return {
    identity: {
      id: identity.id, name: identity.fullName, company: identity.company,
      title: identity.title, linkedinUrl: identity.linkedinUrls[0],
      connected: Boolean(identity.connectedAt), degree: identity.connectionDegree,
    },
    events: events.slice(0, 200),
  };
}
