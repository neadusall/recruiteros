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
import {
  findCallByEngineId, getDeskById,
  parseTranscript, finalizeVettingCall,
} from "../../../../lib/vetting";

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

  // Single shared scoring path — identical to the reconciler's. Idempotent, so if
  // the reconciler already scored this call, finalize no-ops.
  const r = await finalizeVettingCall({ call, desk, transcript, recordingUrl, durationSec: dur });
  return NextResponse.json({ ok: true, ...r });
}
