/**
 * AI Vetting · Post-call webhook  (PUBLIC — called by the voice engine)
 *   POST /api/vetting/webhook
 *
 * Two shapes arrive here:
 *
 * 1. CURRENT Telnyx surface: the Insight Group webhook fires
 *    `conversation.insights.completed` with only ids + insight results — no
 *    transcript. We resolve the conversation on the owning Telnyx account
 *    (metadata carries the desk + caller numbers and call_control_id), fetch
 *    the message turns as the transcript, create the call record if the
 *    dynamic-variables webhook never did (Telnyx skips it for scheduled
 *    events that carry variables inline), then score as always.
 *
 * 2. LEGACY shape: a transcript-bearing event keyed by call_control_id.
 *    Kept so nothing breaks if an older assistant or a replay posts it.
 *
 * The ED25519 signature is verified for legacy events (a no-op until
 * TELNYX_PUBLIC_KEY is set). Insights events skip it deliberately: every fact
 * we use from them is re-fetched from the Telnyx API with our own key, so a
 * forged POST can at worst make us re-score one of our own real calls.
 * Scoring failures are caught and recorded on the call as "failed" rather
 * than 500-ing the engine.
 */

import { NextResponse } from "next/server";
import { verifyTelnyxVoice, telnyx } from "../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { recordUsage } from "../../../../lib/billing/ledger";
import { rateCost } from "../../../../lib/billing/rates";
import {
  findCallByEngineId, getDeskById, updateCall, scoreCall, getCandidateById,
  maybeAutoLearn, maybeLearnQuestions, startResumeChase, maybeDraftClientReport,
  findDeskByNumber, listVettingWorkspaceIds, createCall, findCandidate,
  getTestInterview,
  type TranscriptTurn, type VettingDesk, type VettingCall,
} from "../../../../lib/vetting";

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

/** Everything a resolved call needs to go through scoring + follow-ups. */
interface ResolvedCall {
  call: VettingCall;
  desk: VettingDesk;
  transcript: TranscriptTurn[];
  recordingUrl?: string;
  dur?: number;
  engineCallId: string;
}

/**
 * Resolve a conversation.insights.completed event into a call + transcript.
 * The webhook names no workspace, and fetching the conversation requires the
 * OWNING account's key, so each vetting workspace's credential context is
 * tried until one returns the conversation (the fleet is small: house + a
 * handful of white-labels).
 */
async function resolveInsightsEvent(conversationId: string): Promise<ResolvedCall | { ignored: string }> {
  for (const ws of listVettingWorkspaceIds()) {
    const found = await withWorkspaceCreds(ws, async () => {
      try {
        const conv: any = await telnyx.getConversation(conversationId);
        const data = conv?.data;
        if (conv?.dryRun || !data) return undefined;
        const msgs: any = await telnyx.getConversationMessages(conversationId);
        return { meta: data.metadata ?? {}, msgs, createdAt: data.created_at, lastAt: data.last_message_at };
      } catch {
        return undefined; // not this account's conversation
      }
    });
    if (!found) continue;

    const agentNum = String(found.meta.telnyx_agent_target ?? "");
    const endUserNum = String(found.meta.telnyx_end_user_target ?? "");
    const callControlId = String(found.meta.call_control_id ?? "");

    // Direction-agnostic: whichever number matches a desk IS the desk.
    let desk = agentNum ? findDeskByNumber(agentNum) : undefined;
    let caller = endUserNum;
    if (!desk && endUserNum) {
      desk = findDeskByNumber(endUserNum);
      if (desk) caller = agentNum;
    }
    if (!desk) return { ignored: "no_desk_for_conversation" };

    const rows: any[] = Array.isArray(found.msgs?.data) ? found.msgs.data : [];
    const first = Date.parse(rows[0]?.created_at ?? "");
    const transcript: TranscriptTurn[] = rows
      .filter((m) => typeof m?.text === "string" && m.text.trim())
      .map((m) => ({
        role: toRole(m.role),
        text: String(m.text),
        atSec: Number.isFinite(first) && Number.isFinite(Date.parse(m.created_at ?? ""))
          ? Math.max(0, Math.round((Date.parse(m.created_at) - first) / 1000))
          : undefined,
      }));

    const startMs = Date.parse(found.createdAt ?? "");
    const endMs = Date.parse(found.lastAt ?? "");
    const dur = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1000)
      : undefined;

    // The context webhook normally opened the record; when Telnyx skipped it
    // (scheduled events with inline variables), open it now so the call still
    // lands in Calls with transcript + scoring.
    let call = (callControlId && findCallByEngineId(callControlId)) || findCallByEngineId(conversationId);
    if (!call) {
      const test = caller ? getTestInterview(desk.id, caller) : undefined;
      const candidate = !test && caller ? findCandidate(desk.id, caller) : undefined;
      call = createCall({
        workspaceId: desk.workspaceId,
        deskId: desk.id,
        candidateId: candidate?.id,
        callerName: test
          ? `${[test.firstName, test.lastName].filter(Boolean).join(" ") || "Tester"} (interview test)`
          : candidate ? `${candidate.firstName} ${candidate.lastName}` : undefined,
        callerPhone: caller || "unknown",
        engineCallId: callControlId || conversationId,
      });
    }
    return { call, desk, transcript, dur, engineCallId: callControlId || conversationId };
  }
  return { ignored: "conversation_not_found_on_any_account" };
}

/** The shared tail: attach, meter, score, and kick every follow-up loop. */
async function finishCall(r: ResolvedCall) {
  const { call, desk, transcript, recordingUrl, dur, engineCallId } = r;

  updateCall(call.id, {
    status: "completed", transcript, recordingUrl, durationSec: dur,
    // Same math as the billing meter below, kept on the call so the desk's
    // health strip can show real spend without a ledger join.
    costUsd: dur && dur > 0 ? Math.round(Math.ceil(dur / 60) * rateCost("ai_vetting_minute") * 100) / 100 : undefined,
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
      extracted: s.extracted,
      qualified: s.qualified,
      scoringConfidence: s.scoringConfidence,
      needsReview: s.needsReview,
      summary: s.summary,
      qualifyRationale: s.qualifyRationale,
      nextStepGiven: s.qualified ? desk.nextStepQualified : desk.nextStepUnqualified,
      scoredAt: new Date().toISOString(),
    });

    // The resume chase: thank-you email (the tailored coaching note) + thank-you
    // text right now, then the 24h email / 48h SMS reminder ladder until the
    // updated resume lands. Fire-and-forget; never blocks the engine.
    void startResumeChase(desk.id, call.id);

    // The client side: organize this screen into a working summary + intro
    // email draft, held for the recruiter's review and gated on the resume.
    void maybeDraftClientReport(desk.id, call.id);

    // Self-improvement: count this scored call toward the desk's auto-learn
    // trigger; when the cadence is hit, an optimizer pass runs, applies, and
    // re-provisions the live agent. Fire-and-forget - never blocks the engine.
    void maybeAutoLearn(desk.id);

    // Question intelligence: harvest what the CANDIDATE asked on this call,
    // roll it into the desk's topic clusters, draft grounded answers for new
    // gaps, and (auto-teach on) teach + text the answer back. Fire-and-forget.
    void maybeLearnQuestions(desk.id, call.id);

    return NextResponse.json({
      ok: true, scored: true, total: s.totalScore,
      qualified: s.qualified, confidence: s.scoringConfidence,
    });
  } catch (e: any) {
    updateCall(call.id, { status: "failed", summary: `Scoring failed: ${e?.message || "error"}` });
    return NextResponse.json({ ok: true, scored: false, error: e?.message || "scoring_failed" });
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  let payload: any = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = payload?.data ?? payload;
  const ev = event?.payload ?? event ?? {};

  // Current surface: the Insight Group webhook. Unsigned by design here — see
  // the header comment; everything used is re-fetched with our own API key.
  const eventType = String(payload?.event_type ?? event?.event_type ?? "");
  const conversationId = String(payload?.conversation_id ?? ev?.conversation_id ?? "");
  if (eventType === "conversation.insights.completed" && conversationId) {
    const r = await resolveInsightsEvent(conversationId);
    if ("ignored" in r) return NextResponse.json({ ok: true, ignored: r.ignored });
    return finishCall(r);
  }

  // Legacy transcript-bearing events keep their signature check.
  if (!verifyTelnyxVoice(req, rawBody)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

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

  return finishCall({ call, desk, transcript, recordingUrl, dur, engineCallId });
}
