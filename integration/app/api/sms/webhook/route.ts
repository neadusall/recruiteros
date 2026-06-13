/**
 * POST /api/sms/webhook
 * Inbound text ingest from Telnyx (or your internal SMS tool).
 *
 * On each inbound message it classifies intent, then either auto-replies in the
 * recruiter's voice or escalates a hot candidate to a human. This is the loop
 * that makes texting the money maker: it never sleeps and never drops a lead.
 *
 * Wire this URL into your Telnyx messaging profile (inbound webhook).
 */

import { NextResponse } from "next/server";
import { getSmsProvider } from "../../../../lib/sms/provider";
import { handleInbound, type ConversationContext } from "../../../../lib/sms/conversation";

/**
 * Look up conversation context (campaign, role, history) for a number.
 * Replace with a real lookup against your RecruitersOS store. The stub keeps the
 * route runnable end to end.
 */
async function loadContext(_from: string): Promise<ConversationContext & { recruiterNumber?: string }> {
  return { history: [] };
}

export async function POST(req: Request) {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Telnyx wraps events as { data: { event_type, payload } }.
  const event = payload?.data ?? payload;
  const type = event?.event_type ?? event?.type;
  if (type && type !== "message.received") {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const msg = event?.payload ?? event;
  const from = String(msg?.from?.phone_number ?? msg?.from ?? "");
  const to = String(msg?.to?.[0]?.phone_number ?? msg?.to ?? "");
  const text = String(msg?.text ?? "");
  if (!from || !text) return NextResponse.json({ ok: true, ignored: "no_text" });

  const ctx = await loadContext(from);
  const decision = await handleInbound(text, ctx);

  // Auto-reply in the recruiter's voice when the AI is confident and it is warm.
  if (decision.autoReply) {
    await getSmsProvider().send({ from: to, to: from, text: decision.autoReply });
  }

  // The caller (RecruitersOS) should persist the decision and, on escalate,
  // notify the recruiter. Returned here so a thin webhook can act on it too.
  return NextResponse.json({
    ok: true,
    intent: decision.intent,
    escalate: decision.escalate,
    replied: Boolean(decision.autoReply),
    reason: decision.reason,
  });
}
