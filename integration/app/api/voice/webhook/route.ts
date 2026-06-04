/**
 * POST /api/voice/webhook
 * Telnyx call-control events for the Voice Drops dialer.
 *
 * The brain of the Premium-AMD dialer. Every call is placed by the Voice Drops
 * engine with a per-call playback plan registered in the voice store (keyed by
 * call_control_id). As Telnyx reports what answered, this routes per call:
 *
 *   MACHINE  -> wait for the greeting/beep, then play the personalized voicemail
 *               playlist (cloned-voice segments) in sequence, then hang up and
 *               record `voicemail_delivered`.
 *   HUMAN    -> speak an HONEST identifier in Telnyx TTS ("This is Ryan with
 *               Executive Search — is this Hector?"), then the sign-off ("Sorry,
 *               wrong number. Thanks."), then hang up. Record `human_answered`.
 *   SILENCE  -> hang up, record `no_answer`.
 *
 * On hangup it meters the call's minutes into the cost ledger (best-effort) from
 * the workspace/motion carried in client_state. The ED25519 signature is
 * verified (no-op until TELNYX_PUBLIC_KEY is set).
 */

import { NextResponse } from "next/server";
import { telnyx, verifyTelnyxVoice } from "../../../../lib/providers";
import { decodeClientState } from "../../../../lib/providers/telnyx";
import { recordUsage } from "../../../../lib/billing/ledger";
import { rateCost } from "../../../../lib/billing/rates";
import type { Motion } from "../../../../lib/core/types";
import {
  getPending, advancePending, clearPending, nextSpoken, recordOutcome,
} from "../../../../lib/voice";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyTelnyxVoice(req, raw)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Telnyx wraps events as { data: { event_type, payload } }.
  const event = payload?.data ?? payload;
  const type: string = event?.event_type ?? event?.type ?? "";
  const ev = event?.payload ?? {};
  const ccid: string = ev?.call_control_id ?? "";
  const state = decodeClientState(ev?.client_state);
  if (!ccid) return NextResponse.json({ ok: true, ignored: "no_call_control_id" });

  let action = "none";

  switch (type) {
    // Premium AMD verdict: who/what answered.
    case "call.machine.detection.ended": {
      const result = String(ev?.result ?? "").toLowerCase();
      if (result === "human" || result === "not_sure") {
        // Honest identifier first; the sign-off follows on call.speak.ended.
        const p = getPending(ccid);
        if (p) await telnyx.speak(ccid, p.identifier);
        action = "human_identify";
      } else if (result === "silence") {
        await recordOutcome(ccid, "no_answer", { result });
        clearPending(ccid);
        await telnyx.hangup(ccid);
        action = "hangup_silence";
      } else {
        // machine: wait for the greeting/beep to finish before dropping the VM.
        action = "await_greeting";
      }
      break;
    }

    // Greeting/beep finished -> start the personalized voicemail playlist.
    case "call.machine.premium.greeting.ended":
    case "call.machine.greeting.ended": {
      const url = advancePending(ccid);
      if (url) {
        await telnyx.playAudio(ccid, url);
        action = "voicemail_started";
      } else {
        // No audio (e.g. dry-run / empty playlist) -> nothing to leave.
        await recordOutcome(ccid, "no_answer", { reason: "no_audio" });
        clearPending(ccid);
        await telnyx.hangup(ccid);
        action = "no_audio_hangup";
      }
      break;
    }

    // One voicemail segment finished -> play the next, or finish + record.
    case "call.playback.ended": {
      const next = advancePending(ccid);
      if (next) {
        await telnyx.playAudio(ccid, next);
        action = "voicemail_next_segment";
      } else {
        await recordOutcome(ccid, "voicemail_delivered");
        clearPending(ccid);
        await telnyx.hangup(ccid);
        action = "voicemail_delivered";
      }
      break;
    }

    // Human-answer TTS finished: 1st = identifier -> speak sign-off; 2nd = done.
    case "call.speak.ended": {
      const n = nextSpoken(ccid);
      const p = getPending(ccid);
      if (n === 1 && p) {
        await telnyx.speak(ccid, p.signoff);
        action = "human_signoff";
      } else {
        await recordOutcome(ccid, "human_answered");
        clearPending(ccid);
        await telnyx.hangup(ccid);
        action = "human_done";
      }
      break;
    }

    // Call over -> meter minutes; record no_answer if nothing terminal landed.
    case "call.hangup": {
      if (getPending(ccid)) {
        await recordOutcome(ccid, "no_answer", { reason: "hangup" });
        clearPending(ccid);
      }
      meterCall(ev, state);
      action = "metered";
      break;
    }

    default:
      action = "ignored";
  }

  return NextResponse.json({ ok: true, event: type, action });
}

/**
 * Meter the call's minutes into the ledger. Bills the workspace/motion carried
 * in client_state; skips silently when the call wasn't tagged.
 */
function meterCall(ev: any, state: Record<string, unknown>): void {
  const workspaceId = typeof state.workspaceId === "string" ? state.workspaceId : "";
  if (!workspaceId) return;
  const motion = (state.motion === "bd" ? "bd" : "recruiting") as Motion;
  const minutes = billableMinutes(ev);
  if (minutes <= 0) return;

  recordUsage({
    workspaceId, motion, category: "messaging", type: "voice_minute", source: "telnyx",
    quantity: minutes, unitCostUsd: rateCost("voice_minute"),
    meta: { callControlId: ev?.call_control_id, hangupCause: ev?.hangup_cause, ref: state.ref },
  });
}

/** Whole minutes billed (rounded up), from Telnyx start/end times on the hangup. */
function billableMinutes(ev: any): number {
  const start = Date.parse(ev?.start_time ?? "");
  const end = Date.parse(ev?.end_time ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.ceil((end - start) / 60000);
}
