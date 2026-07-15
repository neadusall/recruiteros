/**
 * RecruitersOS · LinkedIn OS
 * LinkedIn campaigns + the sequence runner. A campaign NEVER sends anything
 * itself: every executable step becomes an action request into the shared
 * engine, which owns policy, utilization, reservation and execution. The
 * runner's whole job is walking people through steps and reacting to what
 * the ledger + events say happened.
 */

import { rid, nowIso, isoPlusHours } from "../../core/ids";
import { getCore } from "../../core/repository";
import { isSuppressed } from "../../response/suppression";
import { campaigns, enrollments } from "./store";
import { getAction } from "./ledger";
import { requestLinkedInAction } from "./engine";
import { resolveIdentity, getIdentity } from "./identity";
import { ensureOutreachState, getOutreachState, setActiveEnrollment } from "./outreachState";
import {
  addVoiceApproval, contextFromIdentity, getVoiceAsset, personalizeScript,
  renderScript, setVoiceApproval, synthesizeNote, bumpVoiceStat,
} from "./voice";
import { voiceApprovals } from "./store";
import type {
  BusinessUnit, LiCampaign, LiEnrollment, LiStep, LiActionType, PersonIdentity,
} from "./types";

/* ---------------- CRUD ---------------- */

export async function listLiCampaigns(workspaceId: string): Promise<LiCampaign[]> {
  const all = await campaigns.all();
  return all.filter((c) => c.workspaceId === workspaceId);
}

export async function getLiCampaign(workspaceId: string, id: string): Promise<LiCampaign | null> {
  const all = await campaigns.all();
  return all.find((c) => c.workspaceId === workspaceId && c.id === id) ?? null;
}

export interface SaveCampaignInput {
  id?: string;
  name?: string;
  type?: BusinessUnit;
  accountId?: string;
  entity?: LiCampaign["entity"];
  priority?: LiCampaign["priority"];
  weight?: number;
  minAllocation?: number;
  maxAllocation?: number;
  objective?: string;
  ownerId?: string;
  ownerName?: string;
  steps?: LiStep[];
  voiceApproval?: LiCampaign["voiceApproval"];
  schedule?: LiCampaign["schedule"];
  dailyEnrollTarget?: number;
}

const STEP_TYPES = new Set([
  "view_profile", "connect", "connect_note", "wait", "wait_random",
  "wait_until_accepted", "message", "voice_note", "inmail", "attachment",
  "like_post", "comment_post", "ai_decision", "if_else", "wait_for_reply",
  "manual_task", "update_person", "add_tag", "move_stage", "create_todo",
  "notify_user", "stop", "transfer_workflow",
]);

function sanitizeSteps(steps: LiStep[] | undefined): LiStep[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && STEP_TYPES.has(String(s.type)))
    .slice(0, 60)
    .map((s) => ({
      id: typeof s.id === "string" && s.id ? s.id : rid("listep"),
      type: s.type,
      label: s.label?.slice(0, 120),
      hours: numOr(s.hours, 0, 24 * 90),
      maxHours: numOr(s.maxHours, 0, 24 * 90),
      text: typeof s.text === "string" ? s.text.slice(0, 4000) : undefined,
      subject: typeof s.subject === "string" ? s.subject.slice(0, 200) : undefined,
      voiceAssetId: typeof s.voiceAssetId === "string" ? s.voiceAssetId : undefined,
      condition: typeof s.condition === "string" ? s.condition : undefined,
      yesIndex: numOr(s.yesIndex, 0, 60),
      noIndex: numOr(s.noIndex, 0, 60),
      timeoutDays: numOr(s.timeoutDays, 0, 90),
      tag: typeof s.tag === "string" ? s.tag.slice(0, 60) : undefined,
      stage: typeof s.stage === "string" ? s.stage.slice(0, 60) : undefined,
      note: typeof s.note === "string" ? s.note.slice(0, 500) : undefined,
    }));
}

function numOr(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
}

export async function saveLiCampaign(workspaceId: string, input: SaveCampaignInput): Promise<LiCampaign> {
  const all = await campaigns.all();
  let c = input.id ? all.find((x) => x.workspaceId === workspaceId && x.id === input.id) : undefined;
  if (!c) {
    c = {
      id: rid("licmp"),
      workspaceId,
      name: input.name || "Untitled LinkedIn campaign",
      type: input.type === "recruiting" ? "recruiting" : "bd",
      accountId: input.accountId || "default",
      priority: input.priority ?? "normal",
      weight: input.weight ?? 30,
      status: "draft",
      steps: [],
      voiceApproval: input.voiceApproval ?? "review_first_10",
      voiceApprovedCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    all.push(c);
  }
  if (input.name) c.name = input.name.slice(0, 140);
  if (input.type) c.type = input.type === "recruiting" ? "recruiting" : "bd";
  if (input.accountId) c.accountId = input.accountId;
  if (input.entity !== undefined) c.entity = input.entity;
  if (input.priority && ["critical", "high", "normal", "low"].includes(input.priority)) c.priority = input.priority;
  if (input.weight !== undefined) c.weight = Math.min(100, Math.max(1, Number(input.weight) || 30));
  if (input.minAllocation !== undefined) c.minAllocation = numOr(input.minAllocation, 0, 500);
  if (input.maxAllocation !== undefined) c.maxAllocation = numOr(input.maxAllocation, 0, 1000);
  if (input.objective !== undefined) c.objective = String(input.objective).slice(0, 300);
  if (input.ownerId !== undefined) c.ownerId = input.ownerId;
  if (input.ownerName !== undefined) c.ownerName = String(input.ownerName).slice(0, 120);
  if (input.steps) c.steps = sanitizeSteps(input.steps);
  if (input.voiceApproval && ["automated", "review_first_10", "manual"].includes(input.voiceApproval)) {
    c.voiceApproval = input.voiceApproval;
  }
  if (input.schedule !== undefined) c.schedule = input.schedule;
  if (input.dailyEnrollTarget !== undefined) c.dailyEnrollTarget = numOr(input.dailyEnrollTarget, 1, 500);
  c.updatedAt = nowIso();
  campaigns.save();
  return c;
}

export async function controlLiCampaign(
  workspaceId: string,
  id: string,
  action: "start" | "pause" | "complete" | "archive",
): Promise<LiCampaign | null> {
  const c = await getLiCampaign(workspaceId, id);
  if (!c) return null;
  if (action === "start") {
    if (!c.steps.length) return c;
    c.status = "running";
  }
  if (action === "pause") c.status = "paused";
  if (action === "complete") c.status = "completed";
  if (action === "archive") c.status = "archived";
  c.updatedAt = nowIso();
  campaigns.save();
  return c;
}

/* ---------------- enrollment ---------------- */

export interface AudiencePerson {
  prospectId?: string;
  fullName?: string;
  firstName?: string;
  email?: string;
  linkedinUrl?: string;
  phone?: string;
  company?: string;
  title?: string;
}

export interface EnrollOutcome {
  enrolled: number;
  skipped: Array<{ name: string; reason: string }>;
  conflicts: Array<{
    name: string;
    personIdentityId: string;
    activeEnrollmentId: string;
    activeCampaignId?: string;
    activeCampaignName?: string;
    activeBusinessUnit?: string;
  }>;
}

/**
 * Enroll people with the full pre-enrollment check from the spec: duplicate
 * identity, existing campaign, existing workflow, reply state, recent
 * outreach pressure, suppression. Conflicts are RETURNED for a human decision
 * (keep / transfer / review), never silently double-enrolled.
 */
export async function enrollPeople(
  workspaceId: string,
  campaignId: string,
  people: AudiencePerson[],
  opts: { transfer?: boolean } = {},
): Promise<EnrollOutcome> {
  const c = await getLiCampaign(workspaceId, campaignId);
  const out: EnrollOutcome = { enrolled: 0, skipped: [], conflicts: [] };
  if (!c) { out.skipped.push({ name: "(all)", reason: "campaign_missing" }); return out; }

  const allEnr = await enrollments.all();
  const allCampaigns = await campaigns.all();

  for (const person of people.slice(0, 2000)) {
    const name = person.fullName || person.email || person.linkedinUrl || "Unknown";
    if (!person.email && !person.linkedinUrl && !person.prospectId) {
      out.skipped.push({ name, reason: "No email, LinkedIn URL or prospect reference" });
      continue;
    }
    const identity = await resolveIdentity(workspaceId, {
      prospectId: person.prospectId,
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      phone: person.phone,
      fullName: person.fullName,
      company: person.company,
      title: person.title,
    });

    // Suppression.
    const handles = [...identity.emails, ...identity.linkedinUrls, ...identity.phones];
    let suppressed = false;
    for (const h of handles) {
      if (await isSuppressed(workspaceId, h)) { suppressed = true; break; }
    }
    if (suppressed) { out.skipped.push({ name, reason: "On the do-not-contact list" }); continue; }

    // Reply state.
    const state = await getOutreachState(workspaceId, identity.id);
    if (state?.replyDetected || state?.automationPaused) {
      out.skipped.push({ name, reason: state.pausedReason ?? "Person has replied; automation is paused" });
      continue;
    }

    // Duplicate in THIS campaign.
    const dup = allEnr.find((e) =>
      e.workspaceId === workspaceId && e.campaignId === campaignId &&
      e.personIdentityId === identity.id &&
      !["completed", "stopped", "failed"].includes(e.status));
    if (dup) { out.skipped.push({ name, reason: "Already enrolled in this campaign" }); continue; }

    // Active anywhere else: conflict for a human decision (or transfer).
    const active = allEnr.find((e) =>
      e.workspaceId === workspaceId && e.personIdentityId === identity.id &&
      ["active", "waiting_capacity", "waiting_accept", "paused_pressure", "paused_review"].includes(e.status));
    if (active && !opts.transfer) {
      const activeCampaign = allCampaigns.find((x) => x.id === active.campaignId);
      out.conflicts.push({
        name,
        personIdentityId: identity.id,
        activeEnrollmentId: active.id,
        activeCampaignId: active.campaignId,
        activeCampaignName: activeCampaign?.name,
        activeBusinessUnit: active.businessUnit,
      });
      continue;
    }
    if (active && opts.transfer) {
      active.status = "stopped";
      active.stopReason = `Transferred to ${c.name}`;
      active.nextRunAt = null;
    }

    const e: LiEnrollment = {
      id: rid("lienr"),
      workspaceId,
      campaignId,
      personIdentityId: identity.id,
      prospectId: person.prospectId ?? identity.prospectIds[0],
      accountId: c.accountId,
      businessUnit: c.type,
      status: "active",
      stepIndex: 0,
      iteration: 0,
      nextRunAt: nowIso(),
      enrolledAt: nowIso(),
    };
    allEnr.push(e);
    await ensureOutreachState(workspaceId, identity.id);
    await setActiveEnrollment(workspaceId, identity.id, {
      activeWorkflowId: campaignId,
      activeEnrollmentId: e.id,
      activeSource: "linkedin_campaign",
      activeBusinessUnit: c.type,
      ownerId: c.ownerId,
    });
    out.enrolled++;
  }
  enrollments.save();
  return out;
}

export async function listEnrollments(workspaceId: string, campaignId?: string): Promise<LiEnrollment[]> {
  const all = await enrollments.all();
  return all.filter((e) => e.workspaceId === workspaceId && (!campaignId || e.campaignId === campaignId));
}

export async function setEnrollmentStatus(
  workspaceId: string,
  enrollmentId: string,
  status: "active" | "stopped",
  reason?: string,
): Promise<LiEnrollment | null> {
  const all = await enrollments.all();
  const e = all.find((x) => x.workspaceId === workspaceId && x.id === enrollmentId) ?? null;
  if (!e) return null;
  e.status = status;
  if (status === "active") e.nextRunAt = nowIso();
  if (status === "stopped") { e.nextRunAt = null; e.stopReason = reason ?? "Stopped manually"; }
  enrollments.save();
  return e;
}

/* ---------------- the runner ---------------- */

const ACTION_STEPS: Partial<Record<LiStep["type"], LiActionType>> = {
  view_profile: "profile_view",
  connect: "connect",
  connect_note: "connect_note",
  message: "message",
  voice_note: "voice_note",
  inmail: "inmail",
  attachment: "attachment",
  like_post: "like_post",
  comment_post: "comment_post",
};

function stepIdempotencyKey(e: LiEnrollment, step: LiStep): string {
  return `${e.accountId}|${e.id}|${step.id}|${e.iteration}`;
}

function personCtx(identity: PersonIdentity) {
  return contextFromIdentity(identity);
}

async function repliedAnywhere(workspaceId: string, personIdentityId: string): Promise<boolean> {
  const s = await getOutreachState(workspaceId, personIdentityId);
  return Boolean(s?.replyDetected);
}

/** Advance one enrollment as far as it can go this cycle (bounded). */
async function runEnrollment(c: LiCampaign, e: LiEnrollment): Promise<void> {
  for (let hops = 0; hops < 10; hops++) {
    if (e.status !== "active" && e.status !== "waiting_capacity") return;
    if (e.nextRunAt && e.nextRunAt > nowIso()) return;

    // A pending action decides whether we may advance.
    if (e.pendingActionId) {
      const a = await getAction(e.workspaceId, e.pendingActionId);
      if (!a) { e.pendingActionId = undefined; }
      else if (a.status === "success") {
        e.pendingActionId = undefined;
        e.status = "active";
        e.stepIndex += 1;
        e.lastEventAt = nowIso();
        if (a.actionType === "voice_note" && a.payload.voiceAssetId) {
          await bumpVoiceStat(e.workspaceId, a.payload.voiceAssetId, "sent");
        }
      } else if (a.status === "failed") {
        e.pendingActionId = undefined;
        e.status = "failed";
        e.stopReason = a.failureReason ?? "Action failed";
        e.nextRunAt = null;
        return;
      } else if (a.status === "cancelled" || a.status === "suppressed") {
        e.pendingActionId = undefined;
        e.status = "paused_replied";
        e.stopReason = a.statusReason;
        e.nextRunAt = null;
        return;
      } else if (a.status === "capacity_pending") {
        e.status = "waiting_capacity";
        e.nextRunAt = isoPlusHours(1);
        return;
      } else {
        // reserved / scheduled / queued / processing / submitted: check later.
        e.status = "active";
        e.nextRunAt = isoPlusHours(0.25);
        return;
      }
    }

    // A pending voice approval gates the step.
    if (e.pendingApprovalId) {
      const approvals = await voiceApprovals.all();
      const item = approvals.find((v) => v.id === e.pendingApprovalId);
      if (!item || item.status === "skipped") {
        e.pendingApprovalId = undefined;
        e.stepIndex += 1; // skipped: move past the voice step
      } else if (item.status === "approved") {
        e.pendingApprovalId = undefined;
        await requestStepAction(c, e, c.steps[e.stepIndex], { approvedScript: item.script, approvedAudio: item.audioFile });
        return;
      } else {
        e.nextRunAt = isoPlusHours(2);
        return;
      }
    }

    const step = c.steps[e.stepIndex];
    if (!step) {
      e.status = "completed";
      e.completedAt = nowIso();
      e.nextRunAt = null;
      return;
    }

    switch (step.type) {
      case "wait": {
        e.stepIndex += 1;
        e.nextRunAt = isoPlusHours(step.hours ?? 24);
        return;
      }
      case "wait_random": {
        const lo = step.hours ?? 4;
        const hi = Math.max(lo, step.maxHours ?? lo + 8);
        e.stepIndex += 1;
        e.nextRunAt = isoPlusHours(lo + Math.random() * (hi - lo));
        return;
      }
      case "wait_until_accepted": {
        const identity = await getIdentity(e.workspaceId, e.personIdentityId);
        if (e.connectedAt || identity?.connectedAt) {
          e.status = "active";
          e.stepIndex += 1;
          continue;
        }
        const started = e.waitingSince ?? nowIso();
        e.waitingSince = started;
        const timeoutDays = step.timeoutDays ?? 21;
        if (Date.parse(started) + timeoutDays * 86_400_000 < Date.now()) {
          if (step.noIndex !== undefined) { e.stepIndex = step.noIndex; e.waitingSince = undefined; continue; }
          e.status = "completed";
          e.stopReason = "Connection was not accepted in time";
          e.completedAt = nowIso();
          e.nextRunAt = null;
          return;
        }
        e.status = "waiting_accept";
        e.nextRunAt = isoPlusHours(6);
        return;
      }
      case "wait_for_reply": {
        const waited = e.waitingSince ?? nowIso();
        e.waitingSince = waited;
        if (await repliedAnywhere(e.workspaceId, e.personIdentityId)) {
          // The global stop pauses the enrollment; belt and braces here.
          e.status = "paused_replied";
          e.nextRunAt = null;
          return;
        }
        const waitHours = step.hours ?? 48;
        if (Date.parse(waited) + waitHours * 3_600_000 < Date.now()) {
          e.waitingSince = undefined;
          e.stepIndex += 1;
          continue;
        }
        e.nextRunAt = isoPlusHours(2);
        return;
      }
      case "if_else": {
        const yes = await repliedAnywhere(e.workspaceId, e.personIdentityId);
        e.stepIndex = yes
          ? (step.yesIndex ?? e.stepIndex + 1)
          : (step.noIndex ?? e.stepIndex + 1);
        continue;
      }
      case "ai_decision": {
        // Real signal: the latest classified conversation intent for the person.
        const { conversations } = await import("./store");
        const convos = await conversations.all();
        const convo = convos.find((x) =>
          x.workspaceId === e.workspaceId && x.personIdentityId === e.personIdentityId);
        const positive = convo?.intent
          ? ["positive", "soft_yes", "referral"].includes(convo.intent)
          : false;
        e.stepIndex = positive
          ? (step.yesIndex ?? e.stepIndex + 1)
          : (step.noIndex ?? e.stepIndex + 1);
        continue;
      }
      case "stop":
      case "transfer_workflow": {
        e.status = "completed";
        e.stopReason = step.type === "transfer_workflow" ? "Transferred by workflow step" : "Stopped by workflow step";
        e.completedAt = nowIso();
        e.nextRunAt = null;
        return;
      }
      case "manual_task":
      case "create_todo":
      case "notify_user": {
        await recordEnrollmentActivity(e, step.type, step.note ?? step.label ?? step.type);
        e.stepIndex += 1;
        continue;
      }
      case "add_tag":
      case "move_stage":
      case "update_person": {
        await applyPersonUpdate(e, step);
        e.stepIndex += 1;
        continue;
      }
      default: {
        const actionType = ACTION_STEPS[step.type];
        if (!actionType) { e.stepIndex += 1; continue; }
        // Voice approval gate.
        if (actionType === "voice_note" && needsVoiceApproval(c)) {
          await createVoiceApprovalForStep(c, e, step);
          return;
        }
        await requestStepAction(c, e, step);
        return;
      }
    }
  }
}

function needsVoiceApproval(c: LiCampaign): boolean {
  if (c.voiceApproval === "manual") return true;
  if (c.voiceApproval === "review_first_10") return c.voiceApprovedCount < 10;
  return false;
}

async function createVoiceApprovalForStep(c: LiCampaign, e: LiEnrollment, step: LiStep): Promise<void> {
  const identity = await getIdentity(e.workspaceId, e.personIdentityId);
  if (!identity) { e.status = "failed"; e.stopReason = "identity_missing"; e.nextRunAt = null; return; }
  let script = step.text ?? "";
  if (step.voiceAssetId) {
    const asset = await getVoiceAsset(e.workspaceId, step.voiceAssetId);
    if (asset?.script) script = asset.script;
  }
  const personalized = await personalizeScript(script || "Hi {first_name}, quick voice note for you.", personCtx(identity));
  // Preview audio is best-effort; approval works from the script alone.
  let audioFile: string | undefined;
  try {
    const asset = step.voiceAssetId ? await getVoiceAsset(e.workspaceId, step.voiceAssetId) : null;
    const synth = await synthesizeNote(personalized, asset?.provider, asset?.voiceId);
    if (!synth.dryRun) audioFile = synth.file;
  } catch { /* preview only */ }
  const item = await addVoiceApproval({
    workspaceId: e.workspaceId,
    campaignId: c.id,
    actionId: "",
    personIdentityId: identity.id,
    personName: identity.fullName ?? "Unknown",
    script: personalized,
    audioFile,
  });
  e.pendingApprovalId = item.id;
  e.nextRunAt = isoPlusHours(2);
}

async function requestStepAction(
  c: LiCampaign,
  e: LiEnrollment,
  step: LiStep,
  approved?: { approvedScript?: string; approvedAudio?: string },
): Promise<void> {
  const identity = await getIdentity(e.workspaceId, e.personIdentityId);
  if (!identity) { e.status = "failed"; e.stopReason = "identity_missing"; e.nextRunAt = null; return; }
  const actionType = ACTION_STEPS[step.type] as LiActionType;
  const ctx = personCtx(identity);
  const payload: Record<string, unknown> = {};
  if (step.text) payload.text = renderScript(step.text, ctx);
  if (step.subject) payload.subject = renderScript(step.subject, ctx);
  if (step.type === "connect_note" && step.text) payload.note = renderScript(step.text, ctx).slice(0, 280);
  if (step.voiceAssetId) payload.voiceAssetId = step.voiceAssetId;
  if (approved?.approvedScript) payload.text = approved.approvedScript;
  if (approved?.approvedAudio) {
    const { voiceAudioUrl } = await import("./voice");
    payload.audioUrl = voiceAudioUrl(approved.approvedAudio);
  }
  if (identity.linkedinUrls[0]) payload.linkedinUrl = identity.linkedinUrls[0];

  const res = await requestLinkedInAction({
    workspaceId: e.workspaceId,
    accountId: e.accountId,
    personIdentityId: identity.id,
    actionType,
    payload,
    businessUnit: e.businessUnit,
    sourceType: "linkedin_campaign",
    priority: c.priority,
    campaignId: c.id,
    workflowEnrollmentId: e.id,
    sequenceStepId: step.id,
    idempotencyKey: stepIdempotencyKey(e, step),
  });

  e.pendingActionId = res.record.id;
  e.lastEventAt = nowIso();
  if (res.accepted) {
    e.status = "active";
    e.nextRunAt = res.record.scheduledAt ?? isoPlusHours(0.25);
  } else if (res.record.status === "capacity_pending") {
    e.status = "waiting_capacity";
    e.nextRunAt = isoPlusHours(1);
  } else if (res.record.status === "paused") {
    e.status = "paused_pressure";
    e.nextRunAt = null;
  } else {
    // suppressed
    e.status = "paused_replied";
    e.stopReason = res.reason;
    e.nextRunAt = null;
  }
}

async function applyPersonUpdate(e: LiEnrollment, step: LiStep): Promise<void> {
  try {
    if (!e.prospectId) return;
    const core = getCore();
    const p = await core.getProspect(e.prospectId);
    if (!p) return;
    if (step.type === "move_stage" && step.stage) {
      const allowed = ["queued", "in_sequence", "replied", "booked", "won", "nurture", "closed_lost", "do_not_contact"];
      if (allowed.includes(step.stage)) p.status = step.stage as typeof p.status;
    }
    if (step.type === "add_tag" && step.tag) {
      p.category = p.category ? `${p.category},${step.tag}` : step.tag;
    }
    await core.saveProspect(p);
    await recordEnrollmentActivity(e, step.type, step.tag ?? step.stage ?? "updated");
  } catch { /* best-effort */ }
}

async function recordEnrollmentActivity(e: LiEnrollment, type: string, summary: string): Promise<void> {
  try {
    if (!e.prospectId) return;
    await getCore().recordActivity({
      id: rid("act"),
      workspaceId: e.workspaceId,
      prospectId: e.prospectId,
      channel: "linkedin",
      type: `workflow_${type}`,
      summary,
      at: nowIso(),
      campaignId: e.campaignId,
    });
  } catch { /* best-effort */ }
}

/** One runner pass over every running campaign's due enrollments. */
export async function tickCampaignRunner(batch = 200): Promise<number> {
  const allC = await campaigns.all();
  const allE = await enrollments.all();
  const running = new Map(allC.filter((c) => c.status === "running").map((c) => [c.id, c]));
  if (!running.size) return 0;

  const now = nowIso();
  const due = allE
    .filter((e) => {
      if (!running.has(e.campaignId)) return false;
      if (!["active", "waiting_capacity", "waiting_accept"].includes(e.status)) return false;
      if (e.pendingApprovalId) return (e.nextRunAt ?? now) <= now;
      return (e.nextRunAt ?? now) <= now || Boolean(e.pendingActionId);
    })
    .slice(0, batch);

  let processed = 0;
  for (const e of due) {
    const c = running.get(e.campaignId);
    if (!c) continue;
    // Schedule window: outside start/end dates the campaign idles.
    if (c.schedule?.startDate && nowIso().slice(0, 10) < c.schedule.startDate) continue;
    if (c.schedule?.endDate && nowIso().slice(0, 10) > c.schedule.endDate) continue;
    try {
      // waiting_accept enrollments only poll the accept gate.
      if (e.status === "waiting_accept") e.status = "active";
      await runEnrollment(c, e);
      processed++;
    } catch { /* one enrollment must not stop the pass */ }
  }
  if (processed) enrollments.save();
  return processed;
}

/** Approve or skip a voice item, updating the campaign's approved counter. */
export async function decideVoiceApproval(
  workspaceId: string,
  approvalId: string,
  decision: "approved" | "skipped",
  edits?: { script?: string },
): Promise<boolean> {
  const item = await setVoiceApproval(workspaceId, approvalId, decision, edits);
  if (!item) return false;
  if (decision === "approved") {
    const c = await getLiCampaign(workspaceId, item.campaignId);
    if (c) {
      c.voiceApprovedCount += 1;
      campaigns.save();
    }
    // Regenerate audio when the script was edited during review.
    if (edits?.script) {
      try {
        const synth = await synthesizeNote(item.script);
        if (!synth.dryRun) {
          item.audioFile = synth.file;
          voiceApprovals.save();
        }
      } catch { /* audio can be re-rendered at execution */ }
    }
  }
  return true;
}
