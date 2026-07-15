/**
 * RecruitersOS · LinkedIn OS
 * The execution queue. Two jobs each tick:
 *
 *  1. PROMOTE: when capacity frees up (a new day, a released reservation, a
 *     raised target), fairly allocate the headroom across waiting actions by
 *     priority + campaign weight and reserve slots for the winners.
 *  2. EXECUTE: run due scheduled actions against the provider, one careful
 *     step at a time, feeding results back into the ledger, the person
 *     outreach state, the inbox and the account risk engine.
 *
 * Provider calls happen OUTSIDE the engine lock; only ledger state changes
 * are serialized. Idempotency: an action is claimed (queued) under the lock
 * before any provider call, so a concurrent tick can never double-send.
 */

import { nowIso } from "../../core/ids";
import { rid } from "../../core/ids";
import { getCore } from "../../core/repository";
import { getProvider } from "../provider";
import type { LinkedInAccount as EngineAccount, Prospect as EngineProspect } from "../types";
import { ledger, withEngineLock } from "./store";
import { categoryCounts, policyDay, releaseReservation, saveLedger, setStatus } from "./ledger";
import { getPolicy } from "./policy";
import { getAccount, capacityFactor, executionBlock, recordResult, listAccounts } from "./health";
import { allocate, type AllocationInput } from "./allocation";
import { getIdentity, resolveIdentity } from "./identity";
import { noteOutbound } from "./engine";
import { ensureConversation, addMessage } from "./inbox";
import { renderVoiceForAction, voiceAudioUrl } from "./voice";
import { capCategoryOf } from "./types";
import type { LiActionRecord, LiCapCategory } from "./types";

const MAX_RETRIES = 3;
const PER_ACCOUNT_PER_TICK = 4;

/* ------------------------------------------------------------------ */
/* Promotion                                                            */
/* ------------------------------------------------------------------ */

/**
 * Promote waiting (capacity_pending / retry_pending past their backoff)
 * actions into reserved slots wherever headroom exists, in fair-share order.
 */
export async function promoteWaiting(): Promise<number> {
  return withEngineLock(async () => {
    const all = await ledger.all();
    const waiting = all.filter((r) =>
      r.status === "capacity_pending" ||
      (r.status === "retry_pending" && (!r.scheduledAt || r.scheduledAt <= nowIso())));
    if (!waiting.length) return 0;

    let promoted = 0;
    // Group by workspace + account + category.
    const groups = new Map<string, LiActionRecord[]>();
    for (const r of waiting) {
      const cat = capCategoryOf(r.actionType);
      if (!cat) continue;
      const k = `${r.workspaceId}|${r.accountId}|${cat}`;
      if (!groups.has(k)) groups.set(k, []);
      (groups.get(k) as LiActionRecord[]).push(r);
    }

    for (const [key, rows] of groups) {
      const [workspaceId, accountId, category] = key.split("|") as [string, string, LiCapCategory];
      const account = await getAccount(workspaceId, accountId);
      if (executionBlock(account)) continue;
      const policy = await getPolicy(workspaceId, accountId);
      const factor = capacityFactor(account);
      const target = Math.floor(policy.categories[category].dailyTarget * factor);
      const ceiling = policy.categories[category].hardCeiling;
      const day = policyDay(policy.timezone);
      const counts = categoryCounts(all, accountId, category, day);
      const headroom = Math.min(target, ceiling) - (counts.used + counts.reserved);
      if (headroom <= 0) continue;

      // Fair share across sources (campaign / workflow / manual bucket).
      const bySource = new Map<string, LiActionRecord[]>();
      for (const r of rows) {
        const src = r.campaignId ?? r.workflowId ?? `${r.sourceType}`;
        if (!bySource.has(src)) bySource.set(src, []);
        (bySource.get(src) as LiActionRecord[]).push(r);
      }
      const inputs: AllocationInput[] = [];
      for (const [src, srcRows] of bySource) {
        srcRows.sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
        const first = srcRows[0];
        inputs.push({
          key: src,
          name: src,
          businessUnit: first.businessUnit,
          priority: first.priority,
          weight: 30,
          demand: srcRows.length,
          usedToday: 0,
        });
      }
      const slices = allocate(headroom, inputs);
      const spacing = policy.pacing;
      let cursor = Date.now();
      for (const slice of slices) {
        const srcRows = bySource.get(slice.key) as LiActionRecord[];
        for (let i = 0; i < slice.allocated && i < srcRows.length; i++) {
          const r = srcRows[i];
          cursor += (spacing.minDelayMinutes +
            (spacing.randomizedTiming ? Math.random() * Math.max(0, spacing.maxDelayMinutes - spacing.minDelayMinutes) : 0)) * 60_000;
          r.status = "scheduled";
          r.reservedAt = nowIso();
          r.scheduledAt = new Date(cursor).toISOString();
          r.capacityDay = day;
          r.statusReason = undefined;
          promoted++;
        }
      }
    }
    if (promoted) saveLedger();
    return promoted;
  });
}

/* ------------------------------------------------------------------ */
/* Execution                                                            */
/* ------------------------------------------------------------------ */

function engineAccount(
  accountId: string,
  providerAccountId: string,
  policy: Awaited<ReturnType<typeof getPolicy>>,
  displayName: string,
): EngineAccount {
  return {
    id: accountId,
    providerAccountId,
    ownerUserId: "",
    displayName,
    status: "ok",
    premium: true,
    salesNavigator: true,
    limits: {
      invitesPerDay: policy.categories.connections.hardCeiling,
      messagesPerDay: policy.categories.messages.hardCeiling,
      inmailsPerDay: policy.categories.inmails.hardCeiling,
      profileViewsPerDay: policy.categories.profile_views.hardCeiling,
      workingHours: policy.workingHours,
    },
    timezone: policy.timezone,
  };
}

function slugFromUrl(url?: string): string | undefined {
  const m = (url ?? "").match(/\/(in|sales\/lead|sales\/people|talent\/profile)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[2]) : undefined;
}

/** Claim due actions (scheduled -> queued) under the lock; returns claims. */
async function claimDue(batch: number): Promise<LiActionRecord[]> {
  return withEngineLock(async () => {
    const all = await ledger.all();
    const now = nowIso();
    const perAccount = new Map<string, number>();
    const claimed: LiActionRecord[] = [];
    const due = all
      .filter((r) =>
        (r.status === "scheduled" || r.status === "retry_pending") &&
        r.scheduledAt && r.scheduledAt <= now && r.capacityDay)
      .sort((a, b) => (a.scheduledAt as string) < (b.scheduledAt as string) ? -1 : 1);
    for (const r of due) {
      if (claimed.length >= batch) break;
      const n = perAccount.get(r.accountId) ?? 0;
      if (n >= PER_ACCOUNT_PER_TICK) continue;
      setStatus(r, "queued");
      perAccount.set(r.accountId, n + 1);
      claimed.push(r);
    }
    if (claimed.length) saveLedger();
    return claimed;
  });
}

async function markResult(
  r: LiActionRecord,
  ok: boolean,
  providerReference?: string,
  error?: string,
): Promise<void> {
  await withEngineLock(async () => {
    if (ok) {
      setStatus(r, "success");
      r.providerReference = providerReference;
    } else {
      const retryable = !/not_supported|missing|invalid|suppressed|no_provider_profile/.test(error ?? "");
      if (retryable && r.retryCount < MAX_RETRIES) {
        r.retryCount += 1;
        r.failureReason = error;
        r.status = "retry_pending";
        r.scheduledAt = new Date(Date.now() + 15 * 60_000 * 2 ** (r.retryCount - 1)).toISOString();
      } else {
        setStatus(r, "failed");
        r.failureReason = error;
        // A failed action never holds capacity.
        r.capacityDay = undefined;
      }
    }
    saveLedger();
  });
}

/** Execute one claimed action against the provider. */
async function executeOne(r: LiActionRecord): Promise<void> {
  const policy = await getPolicy(r.workspaceId, r.accountId);
  const accountState = await getAccount(r.workspaceId, r.accountId);
  const block = executionBlock(accountState);
  if (block) {
    // The account degraded between claim and execution: put it back to waiting.
    await withEngineLock(async () => {
      releaseReservation(r, "capacity_pending", block);
      saveLedger();
    });
    return;
  }
  const providerAccountId =
    accountState?.providerAccountId ||
    process.env.UNIPILE_ACCOUNT_ID ||
    r.accountId;
  const account = engineAccount(r.accountId, providerAccountId, policy, accountState?.displayName ?? r.accountId);
  const provider = getProvider();

  const identity = await getIdentity(r.workspaceId, r.personIdentityId);
  if (!identity) {
    await markResult(r, false, undefined, "identity_missing");
    return;
  }

  // Resolve the provider profile id for the LinkedIn product in play.
  let providerProfileId = r.payload.providerProfileId
    ?? identity.providerIds.classic
    ?? identity.providerIds.salesNavigator
    ?? identity.providerIds.recruiter;
  if (!providerProfileId) {
    const slug = slugFromUrl(r.payload.linkedinUrl ?? identity.linkedinUrls[0]);
    if (slug) {
      try {
        const profile = await provider.resolveProfile(account, slug);
        providerProfileId = profile.providerProfileId;
        await resolveIdentity(r.workspaceId, {
          linkedinUrl: identity.linkedinUrls[0],
          providerProfileId,
          fullName: identity.fullName,
          company: identity.company,
        });
      } catch (e: unknown) {
        await markResult(r, false, undefined, `resolve_failed: ${(e as Error)?.message ?? e}`);
        await recordResult(r.workspaceId, r.accountId, false, r.actionType, String((e as Error)?.message ?? e));
        return;
      }
    }
  }
  if (!providerProfileId) {
    await markResult(r, false, undefined, "no_provider_profile");
    return;
  }

  const prospect: EngineProspect = {
    id: identity.id,
    campaignId: r.campaignId ?? "",
    fullName: identity.fullName ?? "",
    firstName: (identity.fullName ?? "").split(/\s+/)[0] ?? "",
    providerProfileId,
    publicProfileUrl: identity.linkedinUrls[0] ? `https://www.${identity.linkedinUrls[0]}` : undefined,
    company: identity.company,
  };

  await withEngineLock(async () => { setStatus(r, "processing"); saveLedger(); });

  try {
    let out: { ok: boolean; providerMessageId?: string; error?: string };
    switch (r.actionType) {
      case "connect":
      case "connect_note":
        out = await provider.sendConnection({ account, prospect, note: r.payload.note });
        break;
      case "message":
        out = await provider.sendMessage({ account, prospect, text: r.payload.text ?? "" });
        break;
      case "attachment": {
        const text = [r.payload.text ?? "", r.payload.attachmentUrl ?? ""].filter(Boolean).join("\n");
        out = await provider.sendMessage({ account, prospect, text });
        break;
      }
      case "inmail":
        out = await provider.sendInMail({
          account, prospect, text: r.payload.text ?? "", subject: r.payload.subject ?? "",
        });
        break;
      case "voice_note": {
        let audio = r.payload.audioUrl;
        let script: string | undefined;
        if (!audio && r.payload.voiceAssetId) {
          const rendered = await renderVoiceForAction(r.workspaceId, r.payload.voiceAssetId, identity);
          if ("error" in rendered) {
            out = { ok: false, error: rendered.error };
            break;
          }
          audio = rendered.url;
          script = rendered.script;
        }
        if (!audio) { out = { ok: false, error: "voice_audio_missing" }; break; }
        r.payload.audioUrl = audio;
        if (script) r.payload.text = script;
        out = await provider.sendVoiceNote({ account, prospect, audio });
        break;
      }
      case "profile_view":
        out = await provider.viewProfile(account, providerProfileId);
        break;
      case "endorse":
        out = await provider.endorseTopSkills(account, providerProfileId);
        break;
      case "like_post":
      case "comment_post": {
        const { unipile } = await import("../../providers");
        if (r.actionType === "comment_post" && r.payload.postUrl) {
          const res: { dryRun?: boolean; id?: string } =
            await unipile.commentOnPost(providerAccountId, r.payload.postUrl, r.payload.text ?? "");
          out = { ok: true, providerMessageId: res?.id };
        } else if (r.actionType === "like_post" && r.payload.postUrl) {
          const res: { dryRun?: boolean; id?: string } =
            await unipile.likePost(providerAccountId, r.payload.postUrl);
          out = { ok: true, providerMessageId: res?.id };
        } else {
          out = { ok: false, error: "post_url_missing" };
        }
        break;
      }
      case "withdraw_invite":
        out = await provider.withdrawInvite(account, providerProfileId);
        break;
      default:
        out = { ok: false, error: "not_supported" };
    }

    if (out.ok) {
      await markResult(r, true, out.providerMessageId);
      await recordResult(r.workspaceId, r.accountId, true, r.actionType);
      await noteOutbound(r);
      await mirrorToTimeline(r);
      await mirrorToInbox(r, identity.fullName ?? "LinkedIn contact");
    } else {
      await markResult(r, false, undefined, out.error ?? "provider_error");
      await recordResult(r.workspaceId, r.accountId, false, r.actionType, out.error ?? "provider_error");
    }
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    await markResult(r, false, undefined, msg);
    await recordResult(r.workspaceId, r.accountId, false, r.actionType, msg);
  }
}

/** Outbound messages appear in the LinkedIn inbox thread immediately. */
async function mirrorToInbox(r: LiActionRecord, displayName: string): Promise<void> {
  if (!["message", "voice_note", "inmail", "attachment"].includes(r.actionType)) return;
  try {
    const convo = await ensureConversation({
      workspaceId: r.workspaceId,
      accountId: r.accountId,
      personIdentityId: r.personIdentityId,
      displayName,
      businessUnit: r.businessUnit,
      campaignId: r.campaignId,
    });
    addMessage({
      conversation: convo,
      fromSelf: true,
      kind: r.actionType === "voice_note" ? "voice" : r.actionType === "inmail" ? "inmail" : "text",
      text: r.payload.text,
      audioUrl: r.actionType === "voice_note" && r.payload.voiceAssetId && !r.payload.audioUrl
        ? voiceAudioUrl(r.payload.voiceAssetId)
        : r.payload.audioUrl,
      providerMessageId: r.providerReference,
    });
  } catch { /* inbox mirror is best-effort */ }
}

/** Every executed action lands on the person's cross-channel timeline. */
async function mirrorToTimeline(r: LiActionRecord): Promise<void> {
  try {
    const identity = await getIdentity(r.workspaceId, r.personIdentityId);
    const prospectId = identity?.prospectIds[0];
    if (!prospectId) return;
    const label = r.actionType.replace(/_/g, " ");
    await getCore().recordActivity({
      id: rid("act"),
      workspaceId: r.workspaceId,
      prospectId,
      channel: "linkedin",
      type: "linkedin_sent",
      summary: `LinkedIn ${label} sent`,
      at: nowIso(),
      campaignId: r.campaignId,
      touch: r.sequenceStepId,
    });
  } catch { /* timeline is best-effort */ }
}

/* ------------------------------------------------------------------ */
/* The tick                                                             */
/* ------------------------------------------------------------------ */

/**
 * One full engine cycle: promote waiting work into freed capacity, execute
 * due actions, then advance campaign enrollments and the activation queue.
 * Called by the automation scheduler (and the manual cron endpoint).
 */
export async function tickLinkedInOs(batch = 25): Promise<{
  promoted: number; executed: number; enrollments: number; activated: number;
}> {
  const promoted = await promoteWaiting();
  const claimed = await claimDue(batch);
  for (const r of claimed) {
    try { await executeOne(r); } catch { /* one action must not stop the tick */ }
  }
  let enrollmentsProcessed = 0;
  try {
    const { tickCampaignRunner } = await import("./campaigns");
    enrollmentsProcessed = await tickCampaignRunner();
  } catch { /* runner has its own guards */ }
  let activated = 0;
  try {
    const { tickActivation } = await import("./activation");
    activated = await tickActivation();
  } catch { /* activation has its own guards */ }
  return { promoted, executed: claimed.length, enrollments: enrollmentsProcessed, activated };
}

/** Health sweep used by the accounts UI (best-effort provider probe). */
export async function refreshAccountStatuses(workspaceId: string): Promise<void> {
  const accountsList = await listAccounts(workspaceId);
  const provider = getProvider();
  for (const a of accountsList) {
    if (!a.providerAccountId) continue;
    try {
      const policy = await getPolicy(workspaceId, a.accountId);
      const acct = engineAccount(a.accountId, a.providerAccountId, policy, a.displayName);
      const status = await provider.getAccountStatus(acct);
      if (status === "disconnected") {
        const { setHealth } = await import("./health");
        a.connected = false;
        await setHealth(workspaceId, a.accountId, "disconnected", "Provider reports the account needs reconnecting");
      }
    } catch { /* probe is best-effort */ }
  }
}
