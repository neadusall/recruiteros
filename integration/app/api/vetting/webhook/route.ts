/**
 * AI Vetting · Post-call webhook  (PUBLIC — called by the voice engine)
 *   POST /api/vetting/webhook
 *
 * Fires when an inbound vetting call ends. Telnyx hands us the transcript (and a
 * recording URL); we find the matching call record, run the 8-category / 100-pt
 * scoring pass against the desk's qualifiers, store the scorecard + summary +
 * next-step, and meter the conversational minutes into the cost ledger.
 *
 * The ED25519 signature is verified (a no-op until TELNYX_PUBLIC_KEY is set),
 * matching the Voice Drops webhook. Scoring failures are caught and recorded on
 * the call as "failed" rather than 500-ing the engine.
 */

import { NextResponse } from "next/server";
import { verifyTelnyxVoice } from "../../../../lib/providers";
import { recordUsage } from "../../../../lib/billing/ledger";
import { rateCost } from "../../../../lib/billing/rates";
import {
  findCallByEngineId, getDeskById, updateCall, scoreCall, getCandidateById,
  buildPostCallEmail,
  type TranscriptTurn,
} from "../../../../lib/vetting";
import { sendWorkspaceEmail } from "../../../../lib/auth";

/** Map an engine speaker label onto our two-role transcript model. */
function toRole(label: unknown): "agent" | "candidate" {
  const s = String(label ?? "").toLowerCase();
  if (s.includes("assistant") || s.includes("agent") || s.includes("bot") || s.includes("ai")) return "agent";
  return "candidate";
}

/** Parse the engine's transcript into ordered turns (tolerant of shapes). */
function parseTranscript(ev: any): TranscriptTurn[] {
  const raw = ev?.transcript ?? ev?.transcription ?? ev?.messages ?? ev?.conversation;
  if (Array.isArray(raw)) {
    return raw
      .map((t: any): TranscriptTurn | null => {
        const text = t?.content ?? t?.text ?? t?.message ?? "";
        if (!text) return null;
        return {
          role: toRole(t?.role ?? t?.speaker ?? t?.participant),
          text: String(text),
          atSec: typeof t?.start === "number" ? Math.round(t.start) : undefined,
        };
      })
      .filter((t): t is TranscriptTurn => Boolean(t));
  }
  // A single transcript string: keep it as one candidate-side blob to score.
  if (typeof raw === "string" && raw.trim()) {
    return [{ role: "candidate", text: raw.trim() }];
  }
  return [];
}

function durationSec(ev: any): number | undefined {
  if (typeof ev?.duration_sec === "number") return ev.duration_sec;
  const start = Date.parse(ev?.start_time ?? "");
  const end = Date.parse(ev?.end_time ?? "");
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.round((end - start) / 1000);
  return undefined;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifyTelnyxVoice(req, rawBody)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: any = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = payload?.data ?? payload;
  const ev = event?.payload ?? event ?? {};
  const engineCallId =
    ev?.call_control_id || ev?.conversation_id || ev?.call_id || ev?.telnyx_call_control_id || "";

  if (!engineCallId) return NextResponse.json({ ok: true, ignored: "no_call_id" });

  const call = findCallByEngineId(engineCallId);
  if (!call) return NextResponse.json({ ok: true, ignored: "no_matching_call" });

  const desk = getDeskById(call.deskId);
  if (!desk) return NextResponse.json({ ok: true, ignored: "no_desk" });

  const transcript = parseTranscript(ev);
  const recordingUrl =
    ev?.recording_url || (Array.isArray(ev?.recording_urls) ? ev.recording_urls[0] : undefined) || ev?.recording?.url;
  const dur = durationSec(ev);

  updateCall(call.id, {
    status: "completed", transcript, recordingUrl, durationSec: dur,
    endedAt: new Date().toISOString(),
  });

  // Meter the conversational minutes (best-effort).
  if (dur && dur > 0) {
    recordUsage({
      workspaceId: call.workspaceId, motion: desk.motion,
      category: "messaging", type: "ai_vetting_minute", source: "telnyx",
      quantity: Math.ceil(dur / 60), unitCostUsd: rateCost("ai_vetting_minute"),
      meta: { callId: call.id, deskId: desk.id, engineCallId },
    });
  }

  // Nothing to score (e.g. caller hung up immediately).
  if (!transcript.length) {
    updateCall(call.id, {
      status: "scored", summary: "Call ended with no usable transcript.",
      qualified: false, scoringConfidence: "low", needsReview: true,
    });
    return NextResponse.json({ ok: true, scored: false, reason: "empty_transcript" });
  }

  try {
    // Pair the JD must-haves against the call AND the caller's LinkedIn background.
    const candidate = call.candidateId ? getCandidateById(call.candidateId) : undefined;
    const s = await scoreCall(desk, transcript, candidate?.enrichment);
    updateCall(call.id, {
      status: "scored",
      scores: s.scores,
      evidence: s.evidence,
      totalScore: s.totalScore,
      marketabilityScore: s.marketabilityScore,
      agentRealism: s.agentRealism,
      verdicts: s.verdicts,
      qualified: s.qualified,
      scoringConfidence: s.scoringConfidence,
      needsReview: s.needsReview,
      summary: s.summary,
      qualifyRationale: s.qualifyRationale,
      nextStepGiven: s.qualified ? desk.nextStepQualified : desk.nextStepUnqualified,
      scoredAt: new Date().toISOString(),
    });

    // Best-effort: email the candidate the role's must-haves so they can update
    // their resume to clearly reflect what they genuinely have. Never blocks or
    // fails the webhook; skipped for thin calls and clear, unfixable mismatches.
    if (candidate?.email && !s.needsReview) {
      try {
        const mail = await buildPostCallEmail(desk, { ...call, verdicts: s.verdicts }, candidate);
        if (mail.worthInviting) {
          await sendWorkspaceEmail(candidate.email, mail.subject, mail.body, call.workspaceId);
        }
      } catch (mailErr: any) {
        console.error("[vetting] post-call coaching email failed:", mailErr?.message || mailErr);
      }
    }

    return NextResponse.json({
      ok: true, scored: true, total: s.totalScore,
      qualified: s.qualified, confidence: s.scoringConfidence,
    });
  } catch (e: any) {
    updateCall(call.id, { status: "failed", summary: `Scoring failed: ${e?.message || "error"}` });
    return NextResponse.json({ ok: true, scored: false, error: e?.message || "scoring_failed" });
  }
}
