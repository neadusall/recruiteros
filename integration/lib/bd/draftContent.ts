/**
 * RecruiterOS · BD · Draft content builder
 * Shared helper that turns a lead/prospect into the n8n-ready outreach payload:
 * runs the persona engine, flattens the channels, and renders the LinkedIn
 * voice-note script into a cloned-voice clip. Used by both POST /api/bd/draft
 * (one-off) and GET /api/prospects/queue (batch), so the two never diverge.
 */

import { generatePersonaMessage, inferPersona, type BdLead, type PersonaMessage } from "./personaMessaging";
import { renderSegment } from "../voice/clones";
import { getVoiceClient } from "../voice/provider";
import type { Prospect } from "../core/types";

export interface DraftPayload {
  subject: string;
  text: string;
  html: string;
  linkedinConnection: string;
  linkedinMessage: string;
  voiceNoteScript: string;
  voiceNoteAudioUrl?: string;
  voicemailScript: string;
  businessTrigger: string[];
  confidenceScore: number;
  /** Echoed back so callers can persist the frozen lead context (nurture grounding). */
  industry: string;
  persona: string;
  /** Full reasoning package for the approval queue / audit. */
  message: PersonaMessage;
}

/** Map a core Prospect onto the BdLead the persona engine reasons from. */
export function leadFromProspect(
  p: Partial<Prospect>,
  extra: { sender?: string; callbackNumber?: string; hiringActivity?: string; companyContext?: string; profileSummary?: string } = {},
): BdLead {
  return {
    fullName: p.fullName,
    firstName: p.firstName,
    title: p.title,
    company: p.company,
    industry: p.category && p.category !== "in_market" ? p.category : undefined,
    persona: inferPersona(p.title),
    hiringActivity: extra.hiringActivity,
    companyContext: extra.companyContext ?? ([p.headline, p.location].filter(Boolean).join(" · ") || undefined),
    // Ground in the prospect's own words when we have them.
    profileSummary: extra.profileSummary ?? ([p.headline, p.title && p.company ? `${p.title} at ${p.company}` : null, p.location].filter(Boolean).join(" · ") || undefined),
    sender: extra.sender,
    callbackNumber: extra.callbackNumber,
  };
}

/** Cache key for a one-off voice-note render: identical scripts reuse the clip. */
function voiceNoteKey(text: string): string {
  return "linote_" + text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 48);
}

/** Plain-text body (house style) -> minimal HTML for the MTA send. */
export function toHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>").trim()}</p>`)
    .join("\n");
}

/** Generate + flatten the full outreach package for one lead. */
export async function draftContent(lead: BdLead, opts: { renderAudio?: boolean } = {}): Promise<DraftPayload> {
  const message = await generatePersonaMessage(lead);

  let voiceNoteAudioUrl: string | undefined;
  if (opts.renderAudio !== false && message.linkedin_voice_note) {
    try {
      const r = await renderSegment(
        { key: voiceNoteKey(message.linkedin_voice_note), text: message.linkedin_voice_note, kind: "static" },
        process.env.VOICE_CLONE_VOICE_ID || undefined,
        getVoiceClient(),
      );
      voiceNoteAudioUrl = r.url;
    } catch {
      /* leave undefined — the voice-note gate skips when no audio */
    }
  }

  return {
    subject: message.email.subject,
    text: message.email.body,
    html: toHtml(message.email.body),
    linkedinConnection: message.linkedin_connection,
    linkedinMessage: message.linkedin_message,
    voiceNoteScript: message.linkedin_voice_note,
    voiceNoteAudioUrl,
    voicemailScript: message.voicemail,
    businessTrigger: message.business_trigger,
    confidenceScore: message.confidence_score,
    industry: message.industry,
    persona: message.persona,
    message,
  };
}
