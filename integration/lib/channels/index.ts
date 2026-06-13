/**
 * RecruitersOS · Channels
 * The send layer: one façade that routes a touch to the right provider, and the
 * enrichment waterfall. This is what the daily cadence calls at 9:00 to push
 * approved drafts, and at 7:30 to resolve contacts.
 *
 *   email     -> Instantly
 *   linkedin  -> Unipile (preferred) or SalesRobot
 *   sms       -> TalTxt (post-engagement) / Telnyx (raw 10DLC)
 *   voice     -> Telnyx dialer with Premium AMD
 *
 * Each send returns a normalized result and logs a person_event so the ATS sees
 * every touch, exactly as the reference does.
 */

import { instantly, unipile, salesrobot, taltxt, telnyx, freshLinkedin, tomba } from "../providers";
import { cred } from "../providers/http";
import { withWorkspaceCreds } from "../connected";
import { getCore } from "../core/repository";
import { getAts } from "../ats";
import { rid, nowIso } from "../core/ids";
import { classifyContactNumbers } from "../signals/phoneClassify";
import type { Channel, Motion, Prospect } from "../core/types";

export interface SendResult {
  ok: boolean;
  channel: Channel;
  provider: string;
  providerMessageId?: string;
  dryRun?: boolean;
  error?: string;
}

export interface SendTouch {
  channel: Channel;
  prospect: Prospect;
  text: string;
  subject?: string;
  audioUrl?: string;
  campaignChannelIds?: { instantlyCampaignId?: string; linkedinAccountId?: string };
  linkedinProvider?: "unipile" | "salesrobot";
  /** Voice campaign to enqueue this prospect into when an email is sent (the
   *  reactive email-sent → voice-drop trigger). Falls back to the env default. */
  voiceCampaignId?: string;
  /** Outreach-analytics attribution, stamped onto the logged ActivityEvent. */
  campaignId?: string;
  variant?: string;
  touch?: string;
}

/** Send one touch on its channel, then log the activity to the ATS. */
export async function sendTouch(workspaceId: string, t: SendTouch): Promise<SendResult> {
  // BD policy: SMS is disabled for the business-development motion. BD's spoken
  // channels are the LinkedIn voice note and the voicemail drop — never SMS.
  // Hard block here so no sequence, drafter, or n8n misconfig can bypass it.
  if (t.channel === "sms" && t.prospect.motion === "bd") {
    return { ok: false, channel: "sms", provider: "blocked", error: "sms_disabled_for_bd" };
  }

  let result: SendResult;
  try {
    // Credential isolation: resolve the sending provider against THIS workspace's
    // own (or operator-granted) keys — a customer never rides the house env keys.
    // The house workspace runs unisolated, so nothing changes for the operator.
    result = await withWorkspaceCreds(workspaceId, () => dispatch(workspaceId, t));
  } catch (e: any) {
    result = { ok: false, channel: t.channel, provider: "?", error: e?.message ?? String(e) };
  }
  await logTouch(workspaceId, t, result);

  // Reactive trigger: emailing a prospect makes them eligible for a voicemail
  // drop (RECRUITEROS-BACKEND.md §4-C). Opt-in, fire-and-forget — it must never
  // block or fail the email send.
  if (t.channel === "email" && result.ok) {
    void triggerVoiceOnEmailSent(workspaceId, t).catch(() => { /* best-effort */ });
  }

  return result;
}

/** Enqueue the emailed prospect into its voice campaign (opt-in; dynamic import
 *  so the voice engine is only loaded when the trigger is actually used). */
async function triggerVoiceOnEmailSent(workspaceId: string, t: SendTouch): Promise<void> {
  const { voiceOnSendEnabled, voiceOnEmailSent } = await import("../voice/onEmailSent");
  if (!voiceOnSendEnabled()) return;
  await voiceOnEmailSent(workspaceId, t.prospect, {
    motion: t.prospect.motion,
    voiceCampaignId: t.voiceCampaignId,
  });
}

async function dispatch(workspaceId: string, t: SendTouch): Promise<SendResult> {
  switch (t.channel) {
    case "email": {
      // Owned MTA path (self-hosted infrastructure) when opted in; Instantly otherwise.
      const { mtaPreferred, sendEmail } = await import("../providers/mta");
      if (mtaPreferred() && t.prospect.email) {
        const m = await sendEmail(workspaceId, {
          to: t.prospect.email,
          subject: t.subject ?? "",
          htmlBody: t.text,
          fromName: t.prospect.company ? undefined : undefined,
        });
        // A clean skip (no capacity / not ready) falls through to Instantly so a
        // send is never silently dropped during warm-up.
        if (m.ok) return { ok: true, channel: "email", provider: "mta", providerMessageId: m.messageId };
        if (m.skipped === "suppressed") return { ok: false, channel: "email", provider: "mta", error: "suppressed" };
      }
      const cid = t.campaignChannelIds?.instantlyCampaignId ?? "";
      const r: any = await instantly.addLeads(cid, [{ email: t.prospect.email ?? "", first_name: t.prospect.firstName, company_name: t.prospect.company, custom_variables: { subject: t.subject, body: t.text } }]);
      return { ok: true, channel: "email", provider: "instantly", dryRun: r?.dryRun, providerMessageId: r?.id };
    }
    case "linkedin": {
      const accountId = t.campaignChannelIds?.linkedinAccountId ?? "";
      const pid = t.prospect.linkedinUrl ?? "";
      if (t.linkedinProvider === "salesrobot") {
        const r: any = await salesrobot.replyToProspect(pid, t.text);
        return { ok: true, channel: "linkedin", provider: "salesrobot", dryRun: r?.dryRun };
      }
      const r: any = t.audioUrl
        ? await unipile.sendVoiceNote(accountId, pid, t.audioUrl)
        : await unipile.sendMessage(accountId, pid, t.text);
      return { ok: true, channel: "linkedin", provider: "unipile", dryRun: r?.dryRun, providerMessageId: r?.id };
    }
    case "sms": {
      const to = t.prospect.phone ?? "";
      // Prefer TalTxt (campaign inbox); fall back to raw Telnyx 10DLC.
      if (taltxt.configured()) {
        const r: any = await taltxt.sendSms(t.campaignChannelIds?.instantlyCampaignId ?? "default", to, t.text);
        return { ok: true, channel: "sms", provider: "taltxt", dryRun: r?.dryRun };
      }
      const r: any = await telnyx.sendSms(to, t.text);
      return { ok: true, channel: "sms", provider: "telnyx", dryRun: r?.dryRun, providerMessageId: r?.data?.id };
    }
    case "voice": {
      const to = t.prospect.phone ?? "";
      const r: any = await telnyx.dialWithAmd(to, cred("TELNYX_CONNECTION_ID"), `${appUrl()}/api/voice/webhook`);
      return { ok: true, channel: "voice", provider: "telnyx", dryRun: r?.dryRun, providerMessageId: r?.data?.call_control_id };
    }
    default:
      return { ok: false, channel: t.channel, provider: "?", error: "unknown_channel" };
  }
}

async function logTouch(workspaceId: string, t: SendTouch, r: SendResult): Promise<void> {
  const core = getCore();
  const ref = t.prospect.atsPersonId ?? t.prospect.email ?? t.prospect.id;
  const eventId = await getAts().pushPersonEvent({
    personRef: ref,
    activityType: `${cap(t.channel)} ${t.subject ? "(" + t.subject + ")" : "sent"}`,
    channel: t.channel,
    note: r.dryRun ? `[dry-run via ${r.provider}] ${t.text.slice(0, 120)}` : t.text.slice(0, 140),
    at: nowIso(),
  });
  await core.recordActivity({
    id: rid("act"), workspaceId, prospectId: t.prospect.id,
    channel: t.channel, type: `${t.channel}_sent`,
    summary: `${cap(t.channel)} via ${r.provider}${r.dryRun ? " (dry-run)" : ""}`,
    at: nowIso(), atsEventId: eventId,
    campaignId: t.campaignId, variant: t.variant, touch: t.touch,
  });
}

/* ---------------- enrichment waterfall (7:30 cadence step) ---------------- */

export interface Enriched {
  email?: string;
  title?: string;
  company?: string;
  /** Mobile / landline, split by the Telnyx line-type classify step. */
  mobilePhone?: string;
  landlinePhone?: string;
  source: string[];
}

/**
 * Resolve a prospect's contact + role, cheapest source first:
 *   1. Fresh LinkedIn (profile -> title/company)
 *   2. Tomba (email-finder from name + company domain)
 * Returns whatever was found; callers merge onto the prospect.
 */
export async function enrich(prospect: Prospect, opts: { motion?: Motion } = {}): Promise<Enriched> {
  // Isolation: the enrichment rungs (Fresh LinkedIn, Tomba, Telnyx line-type
  // lookup) all cost money — resolve them against this workspace's own keys, not
  // the operator's env, so a customer's enrichment bills to their own accounts.
  return withWorkspaceCreds(prospect.workspaceId, () => enrichResolve(prospect, opts));
}

async function enrichResolve(prospect: Prospect, opts: { motion?: Motion } = {}): Promise<Enriched> {
  const out: Enriched = { source: [] };

  if (prospect.linkedinUrl && freshLinkedin.configured()) {
    try {
      const p: any = await freshLinkedin.getProfile(prospect.linkedinUrl);
      if (p && !p.dryRun) {
        out.title = p?.data?.headline ?? p?.headline;
        out.company = p?.data?.company ?? p?.company;
        out.source.push("fresh_linkedin");
      }
    } catch { /* fall through to next rung */ }
  }

  if (!prospect.email && prospect.company && tomba.configured()) {
    try {
      const domain = guessDomain(prospect.company);
      const [first, ...rest] = prospect.fullName.split(/\s+/);
      const r: any = await tomba.emailFinder(domain, first, rest.join(" "));
      const email = r?.data?.email;
      if (email) { out.email = email; out.source.push("tomba"); }
    } catch { /* leave unresolved for manual entry */ }
  }

  // Line-type classify: split a known number into mobile vs landline via Telnyx
  // (metered to the cost ledger). Skips when already split or no number/Telnyx.
  if (prospect.phone && !prospect.mobilePhone && !prospect.landlinePhone) {
    try {
      const split = await classifyContactNumbers(
        { phone: prospect.phone },
        { workspaceId: prospect.workspaceId, motion: opts.motion },
      );
      if (split.mobilePhone) { out.mobilePhone = split.mobilePhone; out.source.push("telnyx_lookup"); }
      if (split.landlinePhone) { out.landlinePhone = split.landlinePhone; out.source.push("telnyx_lookup"); }
    } catch { /* classify is best-effort; leave numbers untyped */ }
  }

  return out;
}

function guessDomain(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
}
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function appUrl(): string { return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co"; }
