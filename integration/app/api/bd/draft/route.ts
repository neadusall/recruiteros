/**
 * POST /api/bd/draft
 * Generate the full persona-, industry-, and trigger-grounded BD outreach package
 * for one executive lead — the content brain behind the omnichannel funnel.
 * Bearer-authed (RECRUITEROS_API_TOKEN); the scheduler / n8n / enroll-queue calls
 * this to populate a prospect's per-channel content before the channels fire.
 *
 * Body: { lead?, prospect?, sender?, callbackNumber?, hiringActivity?, companyContext?, renderAudio? }
 *   - Pass EITHER a raw `lead` (BdLead) OR a core `prospect` (mapped to a lead).
 *   - hiringActivity: the REAL observed signal (the symptom) that surfaced the lead.
 *   - renderAudio !== false: also synthesize the LinkedIn voice-note script into a
 *     cloned-voice audio clip and return its absolute URL (for /api/linkedin/actions).
 *
 * Returns the validated 12-field PersonaMessage plus n8n-ready flat fields:
 *   { subject, html, text, linkedinConnection, linkedinMessage, voiceNoteScript,
 *     voiceNoteAudioUrl, voicemailScript, businessTrigger, confidenceScore, message }.
 *
 * The engine never fabricates facts — content is reasoned only from the lead context
 * provided (see lib/bd/personaMessaging.ts + docs/playbooks/copywriting-playbook.md).
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { generatePersonaMessage, inferPersona, type BdLead } from "../../../../lib/bd/personaMessaging";
import { renderSegment } from "../../../../lib/voice/clones";
import { getVoiceClient } from "../../../../lib/voice/provider";
import type { Prospect } from "../../../../lib/core/types";

/** Map a core Prospect onto the BdLead the persona engine reasons from. */
function leadFromProspect(p: Partial<Prospect>, extra: { sender?: string; callbackNumber?: string; hiringActivity?: string; companyContext?: string }): BdLead {
  return {
    fullName: p.fullName,
    firstName: p.firstName,
    title: p.title,
    company: p.company,
    persona: inferPersona(p.title),
    hiringActivity: extra.hiringActivity,
    companyContext: extra.companyContext ?? [p.headline, p.location].filter(Boolean).join(" · ") || undefined,
    sender: extra.sender,
    callbackNumber: extra.callbackNumber,
  };
}

/** Cache key for a one-off voice-note render: identical scripts reuse the clip. */
function voiceNoteKey(text: string): string {
  return "linote_" + text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 48);
}

/** Plain-text body (house style) -> minimal HTML for the MTA send. */
function toHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>").trim()}</p>`)
    .join("\n");
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    lead?: BdLead;
    prospect?: Partial<Prospect>;
    sender?: string;
    callbackNumber?: string;
    hiringActivity?: string;
    companyContext?: string;
    renderAudio?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const lead: BdLead | undefined = body.lead
    ? body.lead
    : body.prospect
      ? leadFromProspect(body.prospect, body)
      : undefined;
  if (!lead || (!lead.title && !lead.company)) {
    return NextResponse.json(
      { error: "missing_fields", detail: "a lead/prospect with at least a title or company is required" },
      { status: 422 },
    );
  }

  let message;
  try {
    message = await generatePersonaMessage(lead);
  } catch (e: any) {
    return NextResponse.json({ error: "generation_failed", detail: e?.message ?? String(e) }, { status: 502 });
  }

  // Render the LinkedIn voice-note script into a cloned-voice clip (best-effort;
  // a missing voice config returns a dry-run URL so the funnel still runs).
  let voiceNoteAudioUrl: string | undefined;
  if (body.renderAudio !== false && message.linkedin_voice_note) {
    try {
      const r = await renderSegment(
        { key: voiceNoteKey(message.linkedin_voice_note), text: message.linkedin_voice_note, kind: "static" },
        process.env.VOICE_CLONE_VOICE_ID || undefined,
        getVoiceClient(),
      );
      voiceNoteAudioUrl = r.url;
    } catch {
      /* leave undefined — channel ④ gate skips when no audio */
    }
  }

  return NextResponse.json({
    // n8n-ready flat fields (drop straight onto the enroll payload):
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
    // full reasoning package (for the approval queue / audit):
    message,
  });
}
