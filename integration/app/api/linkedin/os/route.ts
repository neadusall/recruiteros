/**
 * /api/linkedin/os
 * The LinkedIn OS surface: one session-authed router for the whole tool
 * (overview, campaigns, inbox, people, voice notes, accounts, utilization,
 * limits and policies, activation queue, audit trails).
 *
 * GET  ?view=overview|campaigns|inbox|people|voice|accounts|utilization|limits|queue|activation
 * POST { action: "...", ...payload }
 *
 * Every mutation flows through lib/linkedin/os: this route contains no
 * engine logic and never talks to the provider.
 */

import { ok, fail, body, requireCapability } from "../../../../lib/api";
import { getPolicy, putPolicy, policyPresets } from "../../../../lib/linkedin/os/policy";
import {
  accountOverview, allocationView, explainAction, liveQueue, overviewSnapshot,
  peopleView, personTimeline, recentLedger,
} from "../../../../lib/linkedin/os/overview";
import {
  listLiCampaigns, getLiCampaign, saveLiCampaign, controlLiCampaign,
  enrollPeople, listEnrollments, setEnrollmentStatus, decideVoiceApproval,
} from "../../../../lib/linkedin/os/campaigns";
import {
  listConversations, getConversation, markRead, setIntent,
} from "../../../../lib/linkedin/os/inbox";
import {
  listVoiceAssets, saveVoiceAsset, deleteVoiceAsset, duplicateVoiceAsset,
  listVoiceApprovals, personalizeScript, synthesizeNote,
} from "../../../../lib/linkedin/os/voice";
import {
  listAccounts, ensureAccount, setKillSwitch, setHealth,
} from "../../../../lib/linkedin/os/health";
import {
  requestLinkedInAction, cancelAction, allowTemporaryCapacity,
} from "../../../../lib/linkedin/os/engine";
import { resumeAutomation } from "../../../../lib/linkedin/os/outreachState";
import {
  addActivationBatch, listActivation, cancelActivationEntry,
} from "../../../../lib/linkedin/os/activation";
import { tickLinkedInOs, refreshAccountStatuses } from "../../../../lib/linkedin/os/executor";
import { categoryCounts, listLedger, policyDay } from "../../../../lib/linkedin/os/ledger";
import { capacityFactor, getAccount as getAccountState } from "../../../../lib/linkedin/os/health";
import type { BusinessUnit } from "../../../../lib/linkedin/os/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "overview";
  const bu = (url.searchParams.get("bu") ?? undefined) as BusinessUnit | undefined;
  const accountId = url.searchParams.get("account") ?? undefined;

  try {
    switch (view) {
      case "overview":
        return ok(await overviewSnapshot(ws, bu));
      case "campaigns": {
        const campaigns = await listLiCampaigns(ws);
        const enrollments = await listEnrollments(ws);
        return ok({ campaigns, enrollments });
      }
      case "campaign": {
        const id = url.searchParams.get("id") ?? "";
        const campaign = await getLiCampaign(ws, id);
        if (!campaign) return fail("not_found", 404);
        return ok({ campaign, enrollments: await listEnrollments(ws, id) });
      }
      case "inbox":
        return ok({ conversations: await listConversations(ws) });
      case "conversation": {
        const id = url.searchParams.get("id") ?? "";
        const c = await getConversation(ws, id);
        if (!c) return fail("not_found", 404);
        return ok({ conversation: c, timeline: await personTimeline(ws, c.personIdentityId) });
      }
      case "people":
        return ok({ people: await peopleView(ws, bu) });
      case "person": {
        const id = url.searchParams.get("id") ?? "";
        return ok(await personTimeline(ws, id));
      }
      case "voice":
        return ok({
          assets: await listVoiceAssets(ws),
          approvals: await listVoiceApprovals(ws, "pending"),
        });
      case "accounts": {
        const accounts = await listAccounts(ws);
        const campaigns = await listLiCampaigns(ws);
        const rows = await listLedger(ws);
        return ok({
          accounts: accounts.map((a) => ({
            ...a,
            activeCampaigns: campaigns.filter((c) => c.accountId === a.accountId && c.status === "running").length,
            waitingActions: rows.filter((r) => r.accountId === a.accountId && r.status === "capacity_pending").length,
          })),
        });
      }
      case "utilization": {
        const accounts = await listAccounts(ws);
        const acc = accountId ?? accounts[0]?.accountId;
        if (!acc) return ok({ empty: true });
        return ok({
          overview: await accountOverview(ws, acc),
          allocation: await allocationView(ws, acc),
          queue: await liveQueue(ws, 50),
          ledger: await recentLedger(ws, 60),
        });
      }
      case "limits": {
        const accounts = await listAccounts(ws);
        const acc = accountId ?? accounts[0]?.accountId ?? "default";
        return ok({
          policy: await getPolicy(ws, acc),
          presets: policyPresets(),
          accounts: accounts.map((a) => ({ accountId: a.accountId, displayName: a.displayName })),
        });
      }
      case "queue":
        return ok({ queue: await liveQueue(ws, 200) });
      case "activation":
        return ok(await listActivation(ws));
      default:
        return fail("unknown_view", 404);
    }
  } catch (e: unknown) {
    return fail((e as Error)?.message ?? "error", 500);
  }
}

interface ActionBody {
  action: string;
  [k: string]: unknown;
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const userName = g.ctx.user.name || g.ctx.user.email;
  const b = await body<ActionBody>(req);
  if (!b?.action) return fail("missing_action", 422);

  try {
    switch (b.action) {
      /* ---- limits & policies ---- */
      case "policy_put": {
        const accountId = String(b.accountId ?? "default");
        const policy = await putPolicy(ws, accountId, (b.patch ?? {}) as Parameters<typeof putPolicy>[2]);
        return ok({ policy });
      }

      /* ---- campaigns ---- */
      case "campaign_save":
        return ok({ campaign: await saveLiCampaign(ws, (b.campaign ?? {}) as Parameters<typeof saveLiCampaign>[1]) });
      case "campaign_control": {
        const c = await controlLiCampaign(ws, String(b.id ?? ""), b.op as "start" | "pause" | "complete" | "archive");
        if (!c) return fail("not_found", 404);
        return ok({ campaign: c });
      }
      case "campaign_enroll": {
        const out = await enrollPeople(
          ws,
          String(b.campaignId ?? ""),
          (Array.isArray(b.people) ? b.people : []) as Parameters<typeof enrollPeople>[2],
          { transfer: Boolean(b.transfer) },
        );
        return ok(out);
      }
      case "enrollment_status": {
        const e = await setEnrollmentStatus(ws, String(b.id ?? ""), b.status === "active" ? "active" : "stopped", b.reason as string | undefined);
        if (!e) return fail("not_found", 404);
        return ok({ enrollment: e });
      }
      case "capacity_check": {
        // Pre-launch capacity check for the campaign review step.
        const campaign = await getLiCampaign(ws, String(b.campaignId ?? ""));
        const accountId = campaign?.accountId ?? String(b.accountId ?? "default");
        const policy = await getPolicy(ws, accountId);
        const account = await getAccountState(ws, accountId);
        const factor = capacityFactor(account);
        const day = policyDay(policy.timezone);
        const rows = await listLedger(ws);
        const counts = categoryCounts(rows, accountId, "connections", day);
        const target = Math.floor(policy.categories.connections.dailyTarget * factor);
        const ceiling = policy.categories.connections.hardCeiling;
        const demand = Number(b.demand ?? 0) || (campaign ? (await listEnrollments(ws, campaign.id)).length : 0);
        return ok({
          accountId,
          used: counts.used,
          reserved: counts.reserved,
          target,
          ceiling,
          availableBeforeTarget: Math.max(0, target - counts.used - counts.reserved),
          availableBeforeCeiling: Math.max(0, ceiling - counts.used - counts.reserved),
          demand,
          fitsToday: demand <= Math.max(0, target - counts.used - counts.reserved),
        });
      }

      /* ---- inbox ---- */
      case "inbox_read":
        await markRead(ws, String(b.id ?? ""));
        return ok({ done: true });
      case "inbox_intent": {
        const c = await setIntent(ws, String(b.id ?? ""), String(b.intent ?? ""), userName);
        if (!c) return fail("not_found", 404);
        return ok({ conversation: c });
      }
      case "inbox_send": {
        const c = await getConversation(ws, String(b.conversationId ?? ""));
        if (!c) return fail("not_found", 404);
        const res = await requestLinkedInAction({
          workspaceId: ws,
          accountId: c.accountId || String(b.accountId ?? "default"),
          personIdentityId: c.personIdentityId,
          actionType: "message",
          payload: { text: String(b.text ?? "") },
          businessUnit: c.businessUnit ?? "bd",
          sourceType: "manual",
          priority: "high",
          approvedBy: userName,
        });
        return ok({ accepted: res.accepted, reason: res.reason, actionId: res.record.id });
      }

      /* ---- voice ---- */
      case "voice_save":
        return ok({ asset: await saveVoiceAsset(ws, (b.asset ?? {}) as Parameters<typeof saveVoiceAsset>[1]) });
      case "voice_delete":
        return ok({ deleted: await deleteVoiceAsset(ws, String(b.id ?? "")) });
      case "voice_duplicate": {
        const a = await duplicateVoiceAsset(ws, String(b.id ?? ""));
        if (!a) return fail("not_found", 404);
        return ok({ asset: a });
      }
      case "voice_script": {
        const script = await personalizeScript(String(b.template ?? ""), (b.ctx ?? {}) as Record<string, string>);
        return ok({ script });
      }
      case "voice_test": {
        const synth = await synthesizeNote(String(b.script ?? ""), b.provider as string | undefined, b.voiceId as string | undefined);
        if (synth.dryRun) return ok({ dryRun: true, note: "Voice provider is not configured; no audio was generated" });
        return ok({ url: synth.url, file: synth.file });
      }
      case "voice_approval": {
        const done = await decideVoiceApproval(
          ws, String(b.id ?? ""),
          b.decision === "approved" ? "approved" : "skipped",
          b.script ? { script: String(b.script) } : undefined,
        );
        if (!done) return fail("not_found", 404);
        return ok({ done: true });
      }

      /* ---- accounts ---- */
      case "account_ensure": {
        const a = await ensureAccount(ws, String(b.accountId ?? "default"), {
          displayName: (b.displayName as string) || undefined,
          providerAccountId: (b.providerAccountId as string) || undefined,
          timezone: (b.timezone as string) || undefined,
          products: b.products as { classic: boolean; salesNavigator: boolean; recruiter: boolean } | undefined,
          ownerUserId: g.ctx.user.id,
        });
        return ok({ account: a });
      }
      case "account_kill":
        return ok({ account: await setKillSwitch(ws, String(b.accountId ?? ""), Boolean(b.paused), userName) });
      case "account_pause":
        return ok({ account: await setHealth(ws, String(b.accountId ?? ""), "paused", `Paused by ${userName}`) });
      case "account_resume":
        return ok({ account: await setHealth(ws, String(b.accountId ?? ""), "watch", `Resumed by ${userName}`) });
      case "account_refresh":
        await refreshAccountStatuses(ws);
        return ok({ done: true });

      /* ---- ledger / queue ---- */
      case "action_cancel": {
        const r = await cancelAction(ws, String(b.id ?? ""), `Cancelled by ${userName}`);
        if (!r) return fail("not_found", 404);
        return ok({ record: r });
      }
      case "action_allow": {
        const out = await allowTemporaryCapacity(ws, String(b.id ?? ""), userName);
        if (!out) return fail("not_found", 404);
        return ok(out);
      }
      case "action_explain": {
        const out = await explainAction(ws, String(b.id ?? ""));
        if (!out) return fail("not_found", 404);
        return ok(out);
      }
      case "manual_action": {
        const res = await requestLinkedInAction({
          workspaceId: ws,
          accountId: String(b.accountId ?? "default"),
          person: (b.person ?? {}) as Record<string, string>,
          actionType: (b.actionType ?? "message") as Parameters<typeof requestLinkedInAction>[0]["actionType"],
          payload: (b.payload ?? {}) as Record<string, string>,
          businessUnit: b.businessUnit === "recruiting" ? "recruiting" : "bd",
          sourceType: "manual",
          priority: "high",
          approvedBy: userName,
        });
        return ok({ accepted: res.accepted, reason: res.reason, actionId: res.record.id });
      }
      case "person_resume":
        await resumeAutomation(ws, String(b.personIdentityId ?? ""));
        return ok({ done: true });

      /* ---- activation ---- */
      case "activation_add": {
        const batch = await addActivationBatch({
          workspaceId: ws,
          name: String(b.name ?? "Approved contacts"),
          signalLabel: b.signalLabel as string | undefined,
          signalId: b.signalId as string | undefined,
          companyName: b.companyName as string | undefined,
          mode: b.mode as "dynamic_slow_drip" | "fixed_daily" | "immediate" | undefined,
          dailyTarget: Number(b.dailyTarget ?? 25),
          businessUnit: b.businessUnit === "recruiting" ? "recruiting" : "bd",
          priority: (b.priority ?? "normal") as "critical" | "high" | "normal" | "low",
          ownerId: g.ctx.user.id,
          approvedBy: userName,
          target: (b.target ?? { kind: "linkedin_campaign", id: "" }) as { kind: "linkedin_campaign" | "core_campaign"; id: string; name?: string },
          contacts: (Array.isArray(b.contacts) ? b.contacts : []) as Parameters<typeof addActivationBatch>[0]["contacts"],
        });
        return ok({ batch });
      }
      case "activation_cancel":
        return ok({ done: await cancelActivationEntry(ws, String(b.id ?? "")) });

      /* ---- engine ---- */
      case "tick":
        return ok(await tickLinkedInOs());

      default:
        return fail("unknown_action", 422);
    }
  } catch (e: unknown) {
    return fail((e as Error)?.message ?? "error", 500);
  }
}
