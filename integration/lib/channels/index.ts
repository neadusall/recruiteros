/**
 * RecruitersOS · Channels
 * The send layer: one façade that routes a touch to the right provider, and the
 * enrichment waterfall. This is what the daily cadence calls at 9:00 to push
 * approved drafts, and at 7:30 to resolve contacts.
 *
 *   email     -> Instantly
 *   linkedin  -> Unipile (preferred) or SalesRobot
 *   sms       -> OS Text (post-engagement) / Telnyx (raw 10DLC)
 *   voice     -> Telnyx dialer with Premium AMD
 *
 * Each send returns a normalized result and logs a person_event so the ATS sees
 * every touch, exactly as the reference does.
 */

import { instantly, salesrobot, ostext, telnyx, freshLinkedin, tomba } from "../providers";
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

/**
 * The rendered body is plain text with \n line breaks plus (on the video email) one inline HTML
 * table for the Loom-style thumbnail. Email clients collapse \n in HTML, so the HTML payload
 * converts line breaks to <br> inside a plain sans-serif container — the delivered email keeps its
 * paragraphs and the clickable video card keeps its spacing. The text/plain alternative swaps the
 * embed for its watch link (better spam posture than an html-only message, and image-blocking
 * clients still get a clickable URL).
 */
export function emailPayload(body: string): { html: string; text: string } {
  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222">` +
    body.replace(/\r?\n/g, "<br>") +
    `</div>`;
  const link = (body.match(/<a href="(https?:[^"]+)"/) || [])[1] || "";
  const text = body
    .replace(/<table[\s\S]*?<\/table>/gi, link ? `\nWatch the video: ${link}\n` : "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { html, text };
}

async function dispatch(workspaceId: string, t: SendTouch): Promise<SendResult> {
  switch (t.channel) {
    case "email": {
      // SUPPRESSION GATE (both lists, before ANY provider): the DNC/opt-out list
      // (lib/response/suppression — STOP, unsubscribe) and the bounce/complaint list
      // (lib/sending/store). Previously only the MTA path checked, so a pooled SMTP
      // send could reach someone who had opted out. A suppressed prospect is also
      // flipped to do_not_contact so the cadence stops retrying them every tick.
      if (t.prospect.email) {
        const [dnc, store] = await Promise.all([
          import("../response/suppression"),
          import("../sending/store"),
        ]);
        if ((await dnc.isSuppressed(workspaceId, t.prospect.email)) || (await store.isSuppressed(t.prospect.email))) {
          try {
            const fresh = await getCore().getProspect(t.prospect.id);
            if (fresh && fresh.status !== "do_not_contact") { fresh.status = "do_not_contact"; await getCore().saveProspect(fresh); }
          } catch { /* best-effort status flip */ }
          return { ok: false, channel: "email", provider: "suppressed", error: "suppressed" };
        }
      }
      // Recruiter-owned SMTP inbox pool (lib/senders): when the prospect's campaign
      // is assigned to a recruiter who has an available inbox, send through that
      // recruiter's pool (rotated + sticky per prospect). Falls through to the MTA /
      // Instantly paths below when no pool/inbox applies, so a send is never dropped.
      if (t.prospect.email) {
        const pooled = await trySenderPool(workspaceId, t);
        if (pooled) return pooled;
      }
      // Owned MTA path (self-hosted infrastructure) when opted in; Instantly otherwise.
      const { mtaPreferred, sendEmail } = await import("../providers/mta");
      if (mtaPreferred() && t.prospect.email) {
        const m = await sendEmail(workspaceId, {
          to: t.prospect.email,
          subject: t.subject ?? "",
          htmlBody: emailPayload(t.text).html,
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
      const pid = t.prospect.linkedinUrl ?? "";
      if (t.linkedinProvider === "salesrobot") {
        const r: any = await salesrobot.replyToProspect(pid, t.text);
        return { ok: true, channel: "linkedin", provider: "salesrobot", dryRun: r?.dryRun };
      }
      // SHARED LINKEDIN ENGINE: a multichannel touch is an ACTION REQUEST, not
      // a direct provider call. The LinkedIn OS engine owns policy, global
      // utilization, capacity reservation and execution; this path may never
      // talk to Unipile itself, or two engines would each assume the same
      // account headroom. An accepted request is a scheduled send; a waiting
      // request holds until capacity frees (the engine executes it later).
      const { requestLinkedInAction } = await import("../linkedin/os/engine");
      const accountId = t.campaignChannelIds?.linkedinAccountId || "default";
      const res = await requestLinkedInAction({
        workspaceId,
        accountId,
        person: {
          prospectId: t.prospect.id,
          email: t.prospect.email,
          linkedinUrl: t.prospect.linkedinUrl,
          phone: t.prospect.phone,
          fullName: t.prospect.fullName,
          company: t.prospect.company,
          title: t.prospect.title,
        },
        actionType: t.audioUrl ? "voice_note" : "message",
        payload: { text: t.text, audioUrl: t.audioUrl, linkedinUrl: t.prospect.linkedinUrl },
        businessUnit: t.prospect.motion === "recruiting" ? "recruiting" : "bd",
        sourceType: "multichannel_workflow",
        campaignId: t.campaignId ?? t.prospect.campaignId,
        workflowId: t.campaignId ?? t.prospect.campaignId,
        idempotencyKey: `mc|${accountId}|${t.prospect.id}|${t.campaignId ?? ""}|${t.touch ?? t.variant ?? ""}`,
      });
      if (!res.accepted && ["suppressed", "paused"].includes(res.record.status)) {
        return { ok: false, channel: "linkedin", provider: "linkedin_engine", error: res.reason ?? res.record.status };
      }
      return {
        ok: true,
        channel: "linkedin",
        provider: "linkedin_engine",
        providerMessageId: res.record.id,
        dryRun: false,
      };
    }
    case "sms": {
      const to = t.prospect.phone ?? "";
      // Prefer OS Text (campaign inbox); fall back to raw Telnyx 10DLC.
      if (ostext.configured()) {
        const r: any = await ostext.sendSms(t.campaignChannelIds?.instantlyCampaignId ?? "default", to, t.text);
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

/**
 * Recruiter sender-pool path: route the email through the prospect's campaign
 * recruiter's own SMTP inbox pool (lib/senders), rotated + sticky per prospect.
 * Returns null when it doesn't apply (no campaign / no recruiterId / empty pool)
 * so the caller falls through to the MTA / Instantly providers and never drops a send.
 */
async function trySenderPool(workspaceId: string, t: SendTouch): Promise<SendResult | null> {
  try {
    const campaignId = t.prospect.campaignId;
    if (!campaignId || !t.prospect.email) return null;
    const campaign = await getCore().getCampaign(campaignId);
    const recruiterId = campaign?.recruiterId;
    if (!recruiterId) return null;
    const { pickSender, getInbox, sendViaInbox, recordSend } = await import("../senders");
    let inbox: any = null;
    // Sticky: keep a prospect on its already-chosen inbox across the sequence while
    // it still has capacity; otherwise rotate to the freshest inbox in the pool.
    if (t.prospect.senderInboxId) {
      const cur = await getInbox(workspaceId, t.prospect.senderInboxId);
      if (cur && cur.ownerId === recruiterId && cur.status !== "paused" && cur.status !== "error" && cur.sentToday < cur.dailyCap) inbox = cur;
    }
    if (!inbox) inbox = await pickSender(workspaceId, { recruiterId });
    if (!inbox) return null; // pool empty / all capped -> fall through to MTA/Instantly
    const payload = emailPayload(t.text);
    // Gmail/Yahoo bulk-sender compliance: every cold send carries a signed one-click
    // List-Unsubscribe (lib/sending/unsubscribe) + a mailto fallback on the sending inbox.
    const { unsubscribeHeaders } = await import("../sending/unsubscribe");
    const res = await sendViaInbox(inbox, {
      to: t.prospect.email,
      subject: t.subject ?? "",
      html: payload.html,
      text: payload.text,
      headers: unsubscribeHeaders(workspaceId, t.prospect.email, inbox.email),
    });
    if (!res.ok) return { ok: false, channel: "email", provider: "smtp:" + inbox.provider, error: res.error };
    await recordSend(inbox);
    if (t.prospect.senderInboxId !== inbox.id) {
      try {
        const fresh = await getCore().getProspect(t.prospect.id);
        if (fresh) { fresh.senderInboxId = inbox.id; await getCore().saveProspect(fresh); }
      } catch { /* best-effort stamp */ }
      t.prospect.senderInboxId = inbox.id;
    }
    return { ok: true, channel: "email", provider: "smtp:" + inbox.provider, providerMessageId: res.messageId };
  } catch {
    return null; // any error -> fall through to existing providers
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
