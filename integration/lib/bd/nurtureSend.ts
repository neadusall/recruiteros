/**
 * RecruitersOS · BD · Nurture dispatch
 * Sends one generated nurture touch on its channel:
 *   - email              -> owned MTA (no email->voicemail trigger on nurtures)
 *   - linkedin_voice_note -> render the script to a cloned-voice clip, Unipile voice note
 *   - linkedin_comment    -> find a recent post (Unipile), comment on it
 *
 * LinkedIn sends need an account + the prospect's providerProfileId. When that
 * context (or Unipile) is missing, the touch is reported `staged:true` so the cron
 * records it as pending instead of dropping it. Never throws for missing context.
 */

import { sendEmail, mtaPreferred } from "../providers/mta";
import { unipile } from "../providers";
import { renderSegment } from "../voice/clones";
import { cred } from "../providers/http";
import { toHtml } from "./draftContent";
import type { NurtureEnrollment, NurtureTouch, NurtureContent } from "./nurture";

export interface NurtureSendResult {
  ok: boolean;
  channel: string;
  provider?: string;
  /** True when generated but not sent (no context) — caller should stash it pending. */
  staged?: boolean;
  detail?: string;
}

function accountIdFor(e: NurtureEnrollment): string | undefined {
  return e.lead.linkedinAccountId || process.env.RECRUITEROS_LINKEDIN_ACCOUNT_ID || undefined;
}

function clipKey(text: string): string {
  return "nurt_" + text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 48);
}

export async function dispatchNurture(
  e: NurtureEnrollment,
  touch: NurtureTouch,
  content: NurtureContent,
): Promise<NurtureSendResult> {
  // ATS do-not-contact: coldOutreach inside the MTA covers the STOP/DNC list,
  // but only this guard sees the warehouse doNotContact flag the Loxo sync
  // maintains. No recency check: nurture is an enrolled sequence with its own
  // spacing. Applies to EVERY nurture channel, including the LinkedIn legs.
  try {
    const { checkContactable } = await import("../outreach/contactGuard");
    const c = await checkContactable(
      e.workspaceId,
      { email: e.lead.email, fullName: e.lead.fullName, company: e.lead.company },
      { checkRecency: false },
    );
    if (!c.ok) return { ok: false, channel: touch.channel, detail: c.reason ?? "do_not_contact" };
  } catch { /* guard fails open; the DNC list check still rides in the MTA */ }
  // EMAIL (incl. the earned-ask rung) — send now through the owned MTA.
  // Nurture is marketing mail: coldOutreach enforces the DNC/STOP list and
  // stamps List-Unsubscribe; the CAN-SPAM footer rides in the body.
  if (touch.channel === "email" || touch.channel === "ask_email") {
    if (!e.lead.email || !mtaPreferred()) {
      return { ok: false, channel: touch.channel, staged: true, detail: "no_email_or_mta" };
    }
    let footer = { html: "", text: "" };
    try {
      const { complianceFooter } = await import("../sending/compliance");
      const { notifyBrand } = await import("../outbound/brand");
      footer = complianceFooter(e.workspaceId, e.lead.email, await notifyBrand(e.workspaceId));
    } catch { /* footer is best-effort; the unsubscribe header still rides */ }
    const m = await sendEmail(e.workspaceId, {
      to: e.lead.email,
      subject: content.subject ?? "",
      htmlBody: toHtml(content.body) + footer.html,
      coldOutreach: true,
    });
    return { ok: m.ok, channel: "email", provider: m.provider, detail: m.skipped };
  }

  // LINKEDIN — needs an account + provider profile id + Unipile.
  const accountId = accountIdFor(e);
  const pid = e.lead.providerProfileId;
  if (!accountId || !pid || !unipile.configured()) {
    return { ok: false, channel: touch.channel, staged: true, detail: "no_linkedin_context" };
  }

  // ONE LINKEDIN ENGINE: nurture used to call Unipile directly, so its sends
  // dodged every account policy (pacing, health, contact pressure, the ledger).
  // Both legs now file an ACTION REQUEST with LinkedIn OS like every other
  // automated touch; the engine schedules and executes under the same caps.
  // Suppressed is final; any other rejection stages the touch to retry later.
  const requestViaEngine = async (
    actionType: "voice_note" | "comment_post",
    payload: Record<string, unknown>,
  ): Promise<NurtureSendResult> => {
    const { requestLinkedInAction } = await import("../linkedin/os/engine");
    const res = await requestLinkedInAction({
      workspaceId: e.workspaceId,
      accountId,
      person: {
        prospectId: e.prospectId,
        email: e.lead.email,
        fullName: e.lead.fullName,
        company: e.lead.company,
        providerProfileId: pid,
      },
      actionType,
      payload,
      businessUnit: "bd",
      sourceType: "multichannel_workflow",
      idempotencyKey: `nurture|${e.prospectId}|${e.nextTouchIndex}|${actionType}`,
    });
    if (res.accepted) {
      return { ok: true, channel: touch.channel, provider: "linkedin_engine" };
    }
    if (res.record.status === "suppressed") {
      return { ok: false, channel: touch.channel, detail: "suppressed" };
    }
    return { ok: false, channel: touch.channel, staged: true, detail: res.reason ?? res.record.status };
  };

  if (touch.channel === "linkedin_voice_note") {
    let audioUrl: string | undefined;
    try {
      const r = await renderSegment(
        { key: clipKey(content.body), text: content.body, kind: "static" },
        { voiceId: cred("VOICE_CLONE_VOICE_ID") || undefined },
      );
      audioUrl = r.url;
    } catch {
      /* no audio -> stage */
    }
    if (!audioUrl) return { ok: false, channel: touch.channel, staged: true, detail: "no_audio" };
    return requestViaEngine("voice_note", { audioUrl, text: content.body });
  }

  if (touch.channel === "linkedin_comment") {
    // Post discovery is a read; the COMMENT (the outreach action) goes through the engine.
    const posts: any = await unipile.listPosts(accountId, pid).catch(() => null);
    const items: any[] = posts?.items ?? posts?.data ?? (Array.isArray(posts) ? posts : []);
    const postId = items[0]?.id ?? items[0]?.social_id ?? items[0]?.post_id;
    if (!postId) return { ok: false, channel: "linkedin_comment", staged: true, detail: "no_recent_post" };
    return requestViaEngine("comment_post", { postUrl: String(postId), text: content.body });
  }

  return { ok: false, channel: touch.channel, staged: true, detail: "unknown_channel" };
}
