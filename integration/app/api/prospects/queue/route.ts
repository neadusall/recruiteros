/**
 * GET /api/prospects/queue?ws=<id>&limit=N&sender=&callback=
 * The selection + de-dupe + content feed the omnichannel orchestrator (n8n) pulls.
 * Bearer-authed (RECRUITEROS_API_TOKEN).
 *
 * For each signal-sourced BD prospect (category "in_market") NOT already enrolled:
 *   1. generate the persona/industry/trigger outreach package (content pre-attached),
 *   2. render the LinkedIn voice-note audio,
 *   3. confidence gate — score >= RECRUITEROS_BD_MIN_CONFIDENCE (default 0.7):
 *        - returned for the four-channel push AND enrolled "active" in the 6-month nurture;
 *      below threshold:
 *        - enrolled "needs_review" (held, NOT returned) for human approval / more enrichment.
 *
 * Enrollment in the nurture drip IS the de-dupe ledger: an enrolled prospect is
 * never returned here again, so we never double-outreach the same person.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { getCore } from "../../../../lib/core/repository";
import { draftContent, leadFromProspect } from "../../../../lib/bd/draftContent";
import { ensureNurtureReady, isEnrolled, enroll, type NurtureLead } from "../../../../lib/bd/nurture";
import { ensureExperimentReady, assignVariant, recordOutcome } from "../../../../lib/bd/experiment";

function minConfidence(): number {
  const v = Number(process.env.RECRUITEROS_BD_MIN_CONFIDENCE);
  return Number.isFinite(v) ? v : 0.7;
}

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const ws = url.searchParams.get("ws") ?? "";
  if (!ws) return NextResponse.json({ error: "missing_workspace", detail: "?ws= is required" }, { status: 422 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25), 1), 100);
  const sender = url.searchParams.get("sender") ?? undefined;
  const callbackNumber = url.searchParams.get("callback") ?? undefined;
  const threshold = minConfidence();

  await ensureNurtureReady();
  await ensureExperimentReady();

  const all = await getCore().listProspects(ws);
  // Signal-sourced BD prospects not yet enrolled (enrollment = the de-dupe ledger).
  const candidates = all.filter((p) => p.category === "in_market" && !isEnrolled(p.id)).slice(0, limit);

  const prospects: Array<Record<string, unknown>> = [];
  const held: Array<{ id: string; confidenceScore: number; variant: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const p of candidates) {
    // Stable 50/50 A/B assignment; every touch this prospect gets stays in this model.
    const variant = assignVariant(p.id);
    let draft;
    try {
      const lead = leadFromProspect(p, { sender, callbackNumber, hiringActivity: (p as any).hiringSignal });
      draft = await draftContent(lead, { renderAudio: true, variant });
    } catch (e: any) {
      errors.push({ id: p.id, error: e?.message ?? "generation_failed" });
      continue; // leave un-enrolled so a later pull retries
    }

    const frozen: NurtureLead = {
      firstName: p.firstName,
      fullName: p.fullName,
      title: p.title,
      company: p.company,
      industry: draft.industry,
      persona: draft.persona,
      profileSummary: leadFromProspect(p).profileSummary,
      email: p.email,
      landlinePhone: p.landlinePhone,
      phone: p.phone,
      location: p.location,
      linkedinUrl: p.linkedinUrl,
      providerProfileId: (p as any).providerProfileId,
      variant,
    };

    if (draft.confidenceScore >= threshold) {
      enroll(ws, p.id, frozen, { status: "active" });
      recordOutcome(p.id, "enrolled");
      prospects.push({
        id: p.id,
        firstName: p.firstName,
        company: p.company,
        email: p.email,
        linkedinUrl: p.linkedinUrl,
        providerProfileId: (p as any).providerProfileId,
        variant,
        subject: draft.subject,
        html: draft.html,
        text: draft.text,
        linkedinConnection: draft.linkedinConnection,
        linkedinMessage: draft.linkedinMessage,
        voiceNoteScript: draft.voiceNoteScript,
        audioUrl: draft.voiceNoteAudioUrl,
        voicemailScript: draft.voicemailScript,
        businessTrigger: draft.businessTrigger,
        confidenceScore: draft.confidenceScore,
      });
    } else {
      enroll(ws, p.id, frozen, { status: "needs_review", hold: "low_confidence" });
      held.push({ id: p.id, confidenceScore: draft.confidenceScore, variant });
    }
  }

  return NextResponse.json({
    ok: true,
    workspaceId: ws,
    threshold,
    counts: { candidates: candidates.length, ready: prospects.length, held: held.length, errors: errors.length },
    prospects,
    held,
    errors,
  });
}
