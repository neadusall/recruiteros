/**
 * RecruitersOS · AI Vetting · Call finalize (the single scoring code path)
 *
 * BOTH triggers — the post-call webhook and the reconciler — funnel through this
 * ONE function so a call is scored identically no matter how its transcript
 * arrived. It is idempotent: a call already `scored`/`failed` is left untouched,
 * so the webhook and a later reconciler sweep can never double-score or
 * double-bill the same call.
 *
 * Steps: mark completed → meter conversational minutes → score against the
 * desk's qualifiers → persist the scorecard → best-effort coaching email.
 */

import { recordUsage } from "../billing/ledger";
import { rateCost } from "../billing/rates";
import { updateCall, getCandidateById } from "./store";
import { scoreCall } from "./scoring";
import { buildPostCallEmail } from "./resumeCoach";
import { sendWorkspaceEmail } from "../auth";
import type { VettingCall, VettingDesk, TranscriptTurn } from "./types";

export interface FinalizeInput {
  call: VettingCall;
  desk: VettingDesk;
  transcript: TranscriptTurn[];
  recordingUrl?: string;
  durationSec?: number;
}

export interface FinalizeResult {
  scored: boolean;
  total?: number;
  qualified?: boolean;
  confidence?: string;
  reason?: string;
}

export async function finalizeVettingCall(input: FinalizeInput): Promise<FinalizeResult> {
  const { call, desk, transcript, recordingUrl, durationSec } = input;

  // Idempotency guard — the load-bearing line that makes two triggers safe.
  if (call.status === "scored" || call.status === "failed") {
    return { scored: call.status === "scored", reason: "already_final" };
  }

  const dur = durationSec ?? call.durationSec;
  updateCall(call.id, {
    status: "completed",
    transcript,
    recordingUrl: recordingUrl ?? call.recordingUrl,
    durationSec: dur,
    endedAt: call.endedAt ?? new Date().toISOString(),
  });

  // Meter the conversational minutes (best-effort). Runs once: the guard above
  // stops a re-finalize, so this can't double-bill.
  if (dur && dur > 0) {
    recordUsage({
      workspaceId: call.workspaceId,
      motion: desk.motion,
      category: "messaging",
      type: "ai_vetting_minute",
      source: "telnyx",
      quantity: Math.ceil(dur / 60),
      unitCostUsd: rateCost("ai_vetting_minute"),
      meta: { callId: call.id, deskId: desk.id, engineCallId: call.engineCallId },
    });
  }

  // Nothing to score (caller hung up immediately / no usable transcript).
  if (!transcript.length) {
    updateCall(call.id, {
      status: "scored",
      summary: "Call ended with no usable transcript.",
      qualified: false,
      scoringConfidence: "low",
      needsReview: true,
      scoredAt: new Date().toISOString(),
    });
    return { scored: false, reason: "empty_transcript" };
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

    // Best-effort: email the candidate the role's must-haves so they can tune
    // their resume. Never blocks or fails finalize; skipped for thin/unfixable calls.
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

    return { scored: true, total: s.totalScore, qualified: s.qualified, confidence: s.scoringConfidence };
  } catch (e: any) {
    updateCall(call.id, { status: "failed", summary: `Scoring failed: ${e?.message || "error"}` });
    return { scored: false, reason: e?.message || "scoring_failed" };
  }
}
