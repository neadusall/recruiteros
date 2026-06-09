/**
 * RecruiterOS · BD · Nurture dispatch
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
import { getVoiceClient } from "../voice/provider";
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
  // EMAIL — send now through the owned MTA.
  if (touch.channel === "email") {
    if (!e.lead.email || !mtaPreferred()) {
      return { ok: false, channel: "email", staged: true, detail: "no_email_or_mta" };
    }
    const m = await sendEmail(e.workspaceId, {
      to: e.lead.email,
      subject: content.subject ?? "",
      htmlBody: toHtml(content.body),
    });
    return { ok: m.ok, channel: "email", provider: m.provider, detail: m.skipped };
  }

  // LINKEDIN — needs an account + provider profile id + Unipile.
  const accountId = accountIdFor(e);
  const pid = e.lead.providerProfileId;
  if (!accountId || !pid || !unipile.configured()) {
    return { ok: false, channel: touch.channel, staged: true, detail: "no_linkedin_context" };
  }

  if (touch.channel === "linkedin_voice_note") {
    let audioUrl: string | undefined;
    try {
      const r = await renderSegment(
        { key: clipKey(content.body), text: content.body, kind: "static" },
        process.env.VOICE_CLONE_VOICE_ID || undefined,
        getVoiceClient(),
      );
      audioUrl = r.url;
    } catch {
      /* no audio -> stage */
    }
    if (!audioUrl) return { ok: false, channel: touch.channel, staged: true, detail: "no_audio" };
    const r: any = await unipile.sendVoiceNote(accountId, pid, audioUrl);
    return { ok: true, channel: touch.channel, provider: "unipile", detail: r?.dryRun ? "dry_run" : undefined };
  }

  if (touch.channel === "linkedin_comment") {
    const posts: any = await unipile.listPosts(accountId, pid).catch(() => null);
    const items: any[] = posts?.items ?? posts?.data ?? (Array.isArray(posts) ? posts : []);
    const postId = items[0]?.id ?? items[0]?.social_id ?? items[0]?.post_id;
    if (!postId) return { ok: false, channel: "linkedin_comment", staged: true, detail: "no_recent_post" };
    const r: any = await unipile.commentOnPost(accountId, String(postId), content.body);
    return { ok: true, channel: "linkedin_comment", provider: "unipile", detail: r?.dryRun ? "dry_run" : undefined };
  }

  return { ok: false, channel: touch.channel, staged: true, detail: "unknown_channel" };
}
