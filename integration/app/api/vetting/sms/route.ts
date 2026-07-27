/**
 * AI Vetting · Inbound SMS webhook + router  (PUBLIC, called by the messaging engine)
 *   POST /api/vetting/sms
 *
 * ONE number can serve both AI Vetting and OS Text: point the number's
 * messaging-profile inbound webhook here and this route dispatches. A text TO a
 * vetting desk's number FROM a known vetting candidate is handled here (the
 * scheduling loop: we asked "what day and time works?", this is the answer).
 * EVERYTHING else is forwarded byte-for-byte to the OS Text engine over the
 * internal docker network: campaign replies, unknown senders, non-desk numbers,
 * and every non-message.received event (delivery receipts feed OS Text stats).
 * Forwarding preserves the raw body + Telnyx signature headers, so the engine's
 * own ed25519 verification still passes.
 *
 * Opt-out keywords (STOP etc.) from a vetting candidate are ALSO forwarded so
 * the engine's compliance ledger always sees them, even when the scheduling
 * loop treats the same text as a decline.
 *
 * Hardening:
 *  - Delivery retries are DEDUPED by message id, so the engine re-posting the
 *    same text can never double-book or double-reply.
 *  - When the workspace has TELNYX_PUBLIC_KEY saved, the ed25519 webhook
 *    signature is REQUIRED and verified over `timestamp|rawBody`; a bad or
 *    stale (>5 min) signature is dropped. No key saved = accepted as-is, the
 *    same trust model as the existing voice webhooks.
 *  - A failed forward answers 502 so Telnyx retries; nothing is lost to a
 *    momentary engine restart.
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

/** OS Text engine webhook, reachable on the compose-internal network. */
const OSTEXT_FORWARD_URL =
  process.env.OSTEXT_WEBHOOK_FORWARD_URL || "http://taltxt:3000/ostext-app/api/webhooks/telnyx";

/** Carrier opt-out keywords must reach the engine's compliance ledger too. */
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

/**
 * Relay the untouched event to the OS Text engine. Raw body + the Telnyx
 * signature headers pass through so the engine verifies exactly what Telnyx
 * signed. Non-2xx (or an unreachable engine) answers 502 so Telnyx retries.
 */
async function forwardToOsText(req: Request, rawBody: string): Promise<NextResponse> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const h of ["telnyx-signature-ed25519", "telnyx-timestamp", "x-telnyx-shared-secret"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const res = await fetch(OSTEXT_FORWARD_URL, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(
      { ok: res.ok, forwarded: "ostext", engineStatus: res.status },
      { status: res.ok ? 200 : 502 },
    );
  } catch {
    return NextResponse.json({ ok: false, forwarded: "ostext", error: "engine_unreachable" }, { status: 502 });
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
    // Delivery receipts and every other message event belong to OS Text.
    return forwardToOsText(req, rawBody);
  }

  const msg = event?.payload ?? event;
  const from = String(msg?.from?.phone_number ?? msg?.from ?? "");
  const to = String(
    Array.isArray(msg?.to) ? (msg.to[0]?.phone_number ?? msg.to[0] ?? "") : (msg?.to?.phone_number ?? msg?.to ?? ""),
  );
  const text = String(msg?.text ?? "").trim();
  if (!from || !to || !text) return forwardToOsText(req, rawBody);

  await ensureVettingReady();
  const desk = findDeskByNumber(to);
  if (!desk) return forwardToOsText(req, rawBody);

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

  // The desk's own candidate first; a workspace-wide phone match covers a
  // candidate answering from the number on their OTHER desk's file. A sender
  // vetting doesn't know is OS Text's message, not ours.
  const candidate =
    findCandidate(desk.id, from) ?? findCandidateByPhone(desk.workspaceId, from);
  if (!candidate) return forwardToOsText(req, rawBody);

  // Dedupe delivery retries: same message id = already handled. Marked only on
  // the handled path so forwarded events always reach the engine.
  const msgId = String(msg?.id ?? event?.id ?? "");
  if (msgId) {
    if (seenMessages.has(msgId)) return NextResponse.json({ ok: true, ignored: "duplicate" });
    if (seenMessages.size > 5000) seenMessages.clear();
    seenMessages.add(msgId);
  }

  // STOP and friends: vetting reads it as a decline, the engine's opt-out
  // ledger must record it too. Fire-and-forget; our own reply still goes out.
  if (OPT_OUT.test(text)) void forwardToOsText(req, rawBody).catch(() => {});

  const res = await handleScheduleReply(candidate.id, text, "sms");
  const fresh = getCandidateById(candidate.id);
  return NextResponse.json({
    ok: true,
    handled: res.handled,
    outcome: res.outcome,
    status: fresh?.screen?.status ?? null,
  });
}
