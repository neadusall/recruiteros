/**
 * RecruiterOS · Channels
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
import { getCore } from "../core/repository";
import { getAts } from "../ats";
import { rid, nowIso } from "../core/ids";
import type { Channel, Prospect } from "../core/types";

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
}

/** Send one touch on its channel, then log the activity to the ATS. */
export async function sendTouch(workspaceId: string, t: SendTouch): Promise<SendResult> {
  let result: SendResult;
  try {
    result = await dispatch(t);
  } catch (e: any) {
    result = { ok: false, channel: t.channel, provider: "?", error: e?.message ?? String(e) };
  }
  await logTouch(workspaceId, t, result);
  return result;
}

async function dispatch(t: SendTouch): Promise<SendResult> {
  switch (t.channel) {
    case "email": {
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
      const r: any = await telnyx.dialWithAmd(to, process.env.TELNYX_CONNECTION_ID ?? "", `${appUrl()}/api/voice/webhook`);
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
  });
}

/* ---------------- enrichment waterfall (7:30 cadence step) ---------------- */

export interface Enriched {
  email?: string;
  title?: string;
  company?: string;
  source: string[];
}

/**
 * Resolve a prospect's contact + role, cheapest source first:
 *   1. Fresh LinkedIn (profile -> title/company)
 *   2. Tomba (email-finder from name + company domain)
 * Returns whatever was found; callers merge onto the prospect.
 */
export async function enrich(prospect: Prospect): Promise<Enriched> {
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

  return out;
}

function guessDomain(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
}
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function appUrl(): string { return process.env.RECRUITEROS_APP_URL ?? "https://app.recruiteros.co"; }
