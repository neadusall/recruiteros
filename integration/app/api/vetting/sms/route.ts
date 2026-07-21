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
 *
 * Hardening:
 *  - Delivery retries are DEDUPED by message id, so the engine re-posting the
 *    same text can never double-book or double-reply.
 *  - When the workspace has TELNYX_PUBLIC_KEY saved, the ed25519 webhook
 *    signature is REQUIRED and verified over `timestamp|rawBody`; a bad or
 *    stale (>5 min) signature is dropped. No key saved = accepted as-is, the
 *    same trust model as the existing voice webhooks.
 */

import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  findDeskByNumber, findCandidate, findCandidateByPhone, getCandidateById,
  handleScheduleReply, ensureVettingReady,
} from "../../../../lib/vetting";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { cred } from "../../../../lib/providers/http";

/** Telnyx signs `${timestamp}|${rawBody}` with the account's ed25519 key. */
function signatureValid(publicKeyB64: string, signatureB64: string, timestamp: string, rawBody: string): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
    if (rawKey.length !== 32) return false;
    // Wrap the raw 32-byte key in DER SPKI so node's crypto can load it.
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Message ids we've already acted on (bounded; webhook retries are frequent). */
const seenMessages = new Set<string>();

export async function POST(req: Request) {
  const rawBody = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
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

  // Signature check, fail-closed only when the workspace opted in with a key.
  const sigOk = await withWorkspaceCreds(desk.workspaceId, async () => {
    const pub = cred("TELNYX_PUBLIC_KEY").trim();
    if (!pub) return true;
    const sig = req.headers.get("telnyx-signature-ed25519") || "";
    const ts = req.headers.get("telnyx-timestamp") || "";
    if (!sig || !ts) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    return signatureValid(pub, sig, ts, rawBody);
  }).catch(() => true);
  if (!sigOk) return NextResponse.json({ ok: true, ignored: "bad_signature" });

  // Dedupe delivery retries: same message id = already handled.
  const msgId = String(msg?.id ?? event?.id ?? "");
  if (msgId) {
    if (seenMessages.has(msgId)) return NextResponse.json({ ok: true, ignored: "duplicate" });
    if (seenMessages.size > 5000) seenMessages.clear();
    seenMessages.add(msgId);
  }

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
