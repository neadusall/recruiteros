/**
 * POST /api/phone/webhook
 * Telnyx call-control events for the browser phone (BD Phone).
 *
 * Separate from /api/voice/webhook (the Voice Drops AMD dialer): this app's
 * Call Control application points here, so drop campaigns and live phone
 * calls never cross wires. ED25519 signature verified (no-op until
 * TELNYX_PUBLIC_KEY is set, enforced the moment it is).
 *
 * The heavy lifting (leg routing, bridging, the recording -> transcription ->
 * analysis pipeline) lives in lib/phone/calls.ts.
 */

import { NextResponse } from "next/server";
import { verifyTelnyxVoice } from "../../../../lib/providers";
import { handlePhoneEvent } from "../../../../lib/phone/calls";

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

  const event = payload?.data ?? payload;
  const type: string = event?.event_type ?? event?.type ?? "";
  const ev = event?.payload ?? {};

  let action = "ignored";
  try {
    action = await handlePhoneEvent(type, ev);
  } catch (e: any) {
    // Never bounce a webhook: Telnyx retries on non-2xx, which would replay
    // state transitions. Log and accept.
    console.error(`[phone:webhook] ${type} failed:`, e?.message ?? e);
    action = "error";
  }
  return NextResponse.json({ ok: true, event: type, action });
}
