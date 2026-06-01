/**
 * POST /api/voice/webhook
 * Telnyx call-control events for the voice dialer (separate from the SMS ingest).
 *
 * This is the brain of the Premium-AMD dialer: as Telnyx reports what answered,
 * it decides per call:
 *   human   -> warm-transfer to the recruiter (TELNYX_TRANSFER_NUMBER)
 *   machine -> wait for the greeting/beep, then drop a pre-recorded voicemail
 *              (TELNYX_VOICEMAIL_AUDIO_URL) and hang up
 *   silence -> hang up (no one there)
 * On hangup it meters the call's minutes into the cost ledger (best-effort,
 * using the workspace/motion carried in client_state by /api/voice/dial).
 *
 * Wire this URL (https://<app>/api/voice/webhook) into your Telnyx Call Control
 * application, or rely on the per-call webhook_url the dialer already sets.
 *
 * The ED25519 signature is verified (no-op until TELNYX_PUBLIC_KEY is set).
 */

import { NextResponse } from "next/server";
import { telnyx, verifyTelnyxVoice } from "../../../../lib/providers";
import { decodeClientState } from "../../../../lib/providers/telnyx";
import { recordUsage } from "../../../../lib/billing/ledger";
import { rateCost } from "../../../../lib/billing/rates";
import type { Motion } from "../../../../lib/core/types";

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
  const callControlId: string = ev?.call_control_id ?? "";
  const state = decodeClientState(ev?.client_state);

  let action = "none";

  switch (type) {
    // Premium AMD verdict on who/what answered.
    case "call.machine.detection.ended": {
      const result = String(ev?.result ?? "").toLowerCase();
      if (result === "human" || result === "not_sure") {
        action = await warmTransfer(callControlId);
      } else if (result === "silence") {
        if (callControlId) await telnyx.hangup(callControlId);
        action = "hangup_silence";
      } else {
        // machine: wait for the greeting/beep to end before dropping voicemail.
        action = "await_greeting";
      }
      break;
    }

    // Greeting/beep finished -> safe to drop the voicemail onto the recording.
    case "call.machine.premium.greeting.ended":
    case "call.machine.greeting.ended": {
      action = await dropVoicemail(callControlId);
      break;
    }

    // Voicemail finished playing -> end the call.
    case "call.playback.ended": {
      if (callControlId) await telnyx.hangup(callControlId);
      action = "hangup_after_voicemail";
      break;
    }

    // Call over -> meter the minutes we spent.
    case "call.hangup": {
      meterCall(ev, state);
      action = "metered";
      break;
    }

    default:
      action = "ignored";
  }

  return NextResponse.json({ ok: true, event: type, action });
}

/** Bridge the live human to the recruiter; no-op (logged) if no transfer number. */
async function warmTransfer(callControlId: string): Promise<string> {
  const to = process.env.TELNYX_TRANSFER_NUMBER ?? "";
  if (!callControlId || !to) return "human_no_transfer_number";
  await telnyx.transferCall(callControlId, to);
  return "transferred";
}

/** Play the voicemail drop; hang up immediately if no audio is configured. */
async function dropVoicemail(callControlId: string): Promise<string> {
  if (!callControlId) return "no_call_control_id";
  const audio = process.env.TELNYX_VOICEMAIL_AUDIO_URL ?? "";
  if (!audio) {
    await telnyx.hangup(callControlId);
    return "machine_no_voicemail_audio";
  }
  await telnyx.playAudio(callControlId, audio);
  return "voicemail_started";
}

/**
 * Meter the call's minutes into the ledger. Bills the workspace/motion that
 * client_state carries; skips silently when the call wasn't tagged (so a stray
 * inbound or untagged call never crashes the webhook).
 */
function meterCall(ev: any, state: Record<string, unknown>): void {
  const workspaceId = typeof state.workspaceId === "string" ? state.workspaceId : "";
  if (!workspaceId) return;
  const motion = (state.motion === "bd" ? "bd" : "recruiting") as Motion;

  const minutes = billableMinutes(ev);
  if (minutes <= 0) return;

  recordUsage({
    workspaceId,
    motion,
    category: "messaging",
    type: "voice_minute",
    source: "telnyx",
    quantity: minutes,
    unitCostUsd: rateCost("voice_minute"),
    meta: {
      callControlId: ev?.call_control_id,
      hangupCause: ev?.hangup_cause,
      ref: state.ref,
    },
  });
}

/** Whole minutes billed (rounded up), from Telnyx start/end times on the hangup. */
function billableMinutes(ev: any): number {
  const start = Date.parse(ev?.start_time ?? "");
  const end = Date.parse(ev?.end_time ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.ceil((end - start) / 60000);
}
