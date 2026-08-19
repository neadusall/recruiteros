/**
 * POST /api/phone-intel/webhook
 * Telnyx Call Control events for the Phone Intelligence IVR engine.
 *
 * Separate Call Control application from the browser phone (/api/phone/webhook)
 * and the Voice Drops dialer (/api/voice/webhook), so IVR-navigation events
 * never cross wires with live recruiter calls. ED25519 verified once
 * TELNYX_PUBLIC_KEY is set (no-op until then, same as the other voice webhooks).
 */

import { NextResponse } from "next/server";
import { verifyTelnyxVoice } from "../../../../lib/providers";
import { handleIntelEvent } from "../../../../lib/phoneintel/orchestrator";
import { ensureIntelReady } from "../../../../lib/phoneintel/store";

export const dynamic = "force-dynamic";

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
    await ensureIntelReady();
    action = await handleIntelEvent(type, ev);
  } catch (e: any) {
    // Never bounce a webhook: Telnyx retries non-2xx, replaying state.
    console.error(`[phone-intel:webhook] ${type} failed:`, e?.message ?? e);
    action = "error";
  }
  return NextResponse.json({ ok: true, event: type, action });
}
