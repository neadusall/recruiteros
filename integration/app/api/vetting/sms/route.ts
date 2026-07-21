/**
 * AI Vetting · Inbound SMS webhook  (PUBLIC, called by the messaging engine)
 *   POST /api/vetting/sms
 *
 * Texts TO a vetting desk's own number land here. The load-bearing case is the
 * scheduling loop: we asked a candidate "what day and time works for a call?"
 * and this is their answer ("today at 4pm EST", "tomorrow morning", "can we do
 * 6 instead"). We resolve the desk by the dialed number, the candidate by the
 * sender's number, parse the reply, and book / rebook / clarify, and the whole
 * exchange stays on the desk's one number.
 *
 * Point the desk numbers' messaging-profile inbound webhook at this route.
 * Unknown senders and non-message events are acknowledged and ignored (never
 * an error back to the engine, that would retry-spam us).
 */

import { NextResponse } from "next/server";
import {
  findDeskByNumber, findCandidate, findCandidateByPhone, getCandidateById,
  handleScheduleReply, ensureVettingReady,
} from "../../../../lib/vetting";

export async function POST(req: Request) {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true, ignored: "invalid_json" });
  }

  // Telnyx wraps events as { data: { event_type, payload } }; accept flat too.
  const event = payload?.data ?? payload;
  const type = event?.event_type ?? event?.type;
  if (type && type !== "message.received") {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const msg = event?.payload ?? event;
  const from = String(msg?.from?.phone_number ?? msg?.from ?? "");
  const to = String(
    Array.isArray(msg?.to) ? (msg.to[0]?.phone_number ?? msg.to[0] ?? "") : (msg?.to?.phone_number ?? msg?.to ?? ""),
  );
  const text = String(msg?.text ?? "").trim();
  if (!from || !to || !text) return NextResponse.json({ ok: true, ignored: "no_text" });

  await ensureVettingReady();
  const desk = findDeskByNumber(to);
  if (!desk) return NextResponse.json({ ok: true, ignored: "no_desk" });

  // The desk's own candidate first; a workspace-wide phone match covers a
  // candidate answering from the number on their OTHER desk's file.
  const candidate =
    findCandidate(desk.id, from) ?? findCandidateByPhone(desk.workspaceId, from);
  if (!candidate) return NextResponse.json({ ok: true, ignored: "unknown_sender" });

  const res = await handleScheduleReply(candidate.id, text, "sms");
  const fresh = getCandidateById(candidate.id);
  return NextResponse.json({
    ok: true,
    handled: res.handled,
    outcome: res.outcome,
    status: fresh?.screen?.status ?? null,
  });
}
