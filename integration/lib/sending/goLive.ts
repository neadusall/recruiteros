/**
 * RecruitersOS · Send Queue · GO-LIVE readiness
 *
 * The pre-flight for the Sending.ac cold-send path. It answers one question for the operator: "if I
 * turn Autopilot on, will the 2 cold/day per inbox actually go out through my Sending.ac inboxes?"
 *
 * It inspects the chosen Send Queue campaign + the workspace inbox pool and returns a checklist:
 *   1. inboxes imported           (Sending.ac inboxes exist in this workspace)
 *   2. campaign tied to recruiter  (campaign.recruiterId set — else the send falls back to MTA/Instantly)
 *   3. inboxes assigned            (that recruiter actually owns inboxes with send capacity)
 *   4. outreach model approved     (Autopilot refuses to send an unapproved model)
 *   5. send-ready gate on          (campaign.sendQueue — holds prospects until email+video+page ready)
 *   6. automation enabled          (AUTOMATION_ENABLED env — the master clock)
 * Plus the arming status (Autopilot on/off, launch date + days until) which does NOT gate "wired".
 *
 * Required checks (1-6) all-green => `ready` (the plumbing is sound). Arming (Autopilot toggle, launch
 * date) is shown separately: with a future launch date the campaign self-launches on that day even
 * with Autopilot already on, so you can arm everything now and walk away during warm-up.
 */

import { getCore } from "../core/repository";
import { listInboxes, coldCap, canSendViaMailboxApi } from "../senders";
import { automationEnabled } from "../automation/scheduler";
import { footerAddressMissing } from "./compliance";
import { unsubSecretIsFallback } from "./unsubscribe";
import type { Campaign } from "../core/types";

export interface GoLiveCheck {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface GoLiveReadiness {
  campaignId?: string;
  campaignName?: string;
  ready: boolean;                 // all REQUIRED checks pass (the wiring is sound)
  autopilotOn: boolean;           // arming status (not required for "wired")
  launchDate?: string;            // YYYY-MM-DD
  daysUntilLaunch?: number;       // >0 = holds until then; 0 = launches today; undefined = no date
  checks: GoLiveCheck[];
}

/** Pick the campaign the Send Queue is set up for: the caller's chosen one, else the first
 *  campaign flagged `sendQueue`, else undefined. */
function pickCampaign(campaigns: Campaign[], preferId?: string): Campaign | undefined {
  if (preferId) { const m = campaigns.find((c) => c.id === preferId); if (m) return m; }
  return campaigns.find((c) => !!c.sendQueue);
}

export async function goLiveReadiness(
  workspaceId: string,
  todayIso: string,
  preferCampaignId?: string,
): Promise<GoLiveReadiness> {
  const core = getCore();
  const [campaigns, inboxes] = await Promise.all([
    core.listCampaigns(workspaceId),
    listInboxes(workspaceId),
  ]);

  const c = pickCampaign(campaigns, preferCampaignId);
  const totalInboxes = inboxes.length;
  const recruiterId = c?.recruiterId;
  const ownedInboxes = recruiterId ? inboxes.filter((m) => m.ownerId === recruiterId) : [];
  // Capacity only counts inboxes this platform can ACTUALLY send from: a stored SMTP
  // login, or a Sending.ac mailbox reachable through the Mailbox API. The rotation skips
  // anything else (lib/senders/pool.ts), so counting it here would report a pool that
  // could never be spent — the failure that let a credential-less OAuth fleet read as
  // "ready" for sends with nowhere to go.
  const sendableOwned = ownedInboxes.filter((m) => !!m.smtpPassEnc || canSendViaMailboxApi(m));
  const ownedCapacity = sendableOwned.reduce((n, m) => n + coldCap(m.dailyCap), 0);
  const ownedNoCreds = ownedInboxes.length - sendableOwned.length;

  const checks: GoLiveCheck[] = [
    {
      key: "inboxes_imported", required: true, ok: totalInboxes > 0,
      label: "Sending.ac inboxes imported",
      detail: totalInboxes > 0 ? `${totalInboxes.toLocaleString()} inbox${totalInboxes === 1 ? "" : "es"} in this workspace` : "Import your inbox CSV on the Senders screen",
    },
    {
      key: "campaign_recruiter", required: true, ok: !!recruiterId,
      label: "Campaign tied to a recruiter",
      detail: recruiterId ? "Set: sends route through that recruiter's inbox pool" : "Pick a recruiter in the campaign setup, or sends fall back to MTA/Instantly",
    },
    {
      key: "inboxes_assigned", required: true, ok: sendableOwned.length > 0,
      label: "Inboxes assigned to that recruiter",
      detail: !recruiterId ? "Set the campaign's recruiter first"
        : sendableOwned.length > 0
          ? `${sendableOwned.length.toLocaleString()} inboxes · ${ownedCapacity.toLocaleString()} cold sends/day`
            + (ownedNoCreds > 0 ? ` (${ownedNoCreds.toLocaleString()} more have no login yet)` : "")
        : ownedInboxes.length > 0
          ? `${ownedInboxes.length.toLocaleString()} inboxes assigned but none hold a sending login: press 'Pull Sending.ac logins' on the Senders screen`
        : "That recruiter owns no inboxes: assign the pool to them on the Senders screen",
    },
    {
      key: "model_approved", required: true, ok: !!c?.outreachApproved,
      label: "Outreach model approved",
      detail: c?.outreachApproved ? "Approved: Autopilot may send it" : "Draft + approve the Day-0 text / Day-1 video sequence in Campaign Studio",
    },
    {
      key: "send_ready_gate", required: true, ok: !!c?.sendQueue,
      label: "Send-ready gate on",
      detail: c?.sendQueue ? "On: holds prospects until email + video + page are ready" : "Click 'Set up as Send Queue campaign'",
    },
    {
      key: "automation_enabled", required: true, ok: automationEnabled(),
      label: "Automation clock enabled",
      detail: automationEnabled() ? "On: the scheduler ticks the Autopilot" : "Set AUTOMATION_ENABLED=on in the server env (the master switch)",
    },
  ];

  // Deliverability + compliance rows. Holds/paused inboxes are excluded from the
  // capacity math above; these rows surface WHY a pool is thin and stop a launch
  // that would violate CAN-SPAM or send from an unhealthy fleet.
  const heldInboxes = inboxes.filter((m) => m.status === "paused" || m.status === "error").length;
  const usableOwned = ownedInboxes.filter((m) => m.status === "active" || m.status === "warming").length;
  let footerMissing = false;
  try {
    const { notifyBrand } = await import("../outbound/brand");
    footerMissing = footerAddressMissing(workspaceId, await notifyBrand(workspaceId));
  } catch { /* fail-open row */ }
  checks.push(
    {
      key: "postal_address", required: true, ok: !footerMissing,
      label: "CAN-SPAM postal address set",
      detail: footerMissing
        ? "Set the workspace postal address (Senders screen) - required on every cold email footer"
        : "Set: every cold email carries the compliance footer",
    },
    {
      key: "unsub_secret", required: true, ok: !unsubSecretIsFallback(),
      label: "Unsubscribe signing secret set",
      detail: unsubSecretIsFallback()
        ? "Set RECRUITEROS_UNSUB_SECRET in the server env - unsubscribe links are forgeable on the dev fallback"
        : "Set: one-click unsubscribe links are HMAC-signed",
    },
    {
      key: "pool_health", required: false, ok: heldInboxes === 0,
      label: "Inbox pool clear of health holds",
      detail: heldInboxes === 0
        ? "No inboxes paused or in error"
        : `${heldInboxes.toLocaleString()} inbox${heldInboxes === 1 ? "" : "es"} paused/errored (health guard or SMTP failures) - ${usableOwned.toLocaleString()} usable in this recruiter's pool`,
    },
  );

  const autopilotOn = !!(c?.autoRun && c?.status === "active");
  const launchDate = c?.scheduledFor && /^\d{4}-\d{2}-\d{2}$/.test(c.scheduledFor) ? c.scheduledFor : undefined;
  let daysUntilLaunch: number | undefined;
  if (launchDate) {
    const today = todayIso.slice(0, 10);
    const ms = Date.parse(launchDate + "T00:00:00Z") - Date.parse(today + "T00:00:00Z");
    daysUntilLaunch = Math.round(ms / 86_400_000);
  }

  const ready = checks.filter((k) => k.required).every((k) => k.ok);
  return {
    campaignId: c?.id,
    campaignName: c?.name,
    ready,
    autopilotOn,
    launchDate,
    daysUntilLaunch,
    checks,
  };
}
