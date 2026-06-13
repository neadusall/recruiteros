/**
 * RecruitersOS · Providers · Webhook signature verification
 * One verifier per inbound source, so the Response webhook route can authenticate
 * every provider before processing.
 *
 *  - Instantly / SalesRobot / Unipile: HMAC-SHA256 over the raw body.
 *  - TalTxt / Telnyx:                  ED25519 over `timestamp|payload`.
 *
 * Each is a no-op (returns true) when its secret is unset, so dev works without
 * credentials; set the secret in production to enforce.
 */

import { createHmac, timingSafeEqual, verify as edVerify } from "node:crypto";
import type { ResponseSource } from "../response/types";

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function hmacOk(raw: string, sig: string, secret?: string): boolean {
  if (!secret) return true;
  if (!sig) return false;
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEq(sig.replace(/^sha256=/, ""), digest);
}

/** ED25519 over `${timestamp}|${raw}` against a base64 public key (Telnyx style). */
function ed25519Ok(raw: string, sig: string, timestamp: string, publicKeyB64?: string): boolean {
  if (!publicKeyB64) return true;
  if (!sig || !timestamp) return false;
  try {
    const key = {
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der" as const,
      type: "spki" as const,
    };
    return edVerify(null, Buffer.from(`${timestamp}|${raw}`), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/** Verify the inbound webhook signature for a given source. */
export function verifyWebhook(source: ResponseSource, req: Request, raw: string): boolean {
  const h = (name: string) => req.headers.get(name) ?? "";
  switch (source) {
    case "instantly":
      return hmacOk(raw, h("x-instantly-signature"), process.env.INSTANTLY_WEBHOOK_SECRET);
    case "salesrobot":
      return hmacOk(raw, h("x-salesrobot-signature"), process.env.SALESROBOT_WEBHOOK_SECRET);
    case "unipile":
      return hmacOk(raw, h("x-unipile-signature"), process.env.UNIPILE_WEBHOOK_SECRET);
    case "taltxt":
      return ed25519Ok(raw, h("telnyx-signature-ed25519"), h("telnyx-timestamp"), process.env.TALTXT_PUBLIC_KEY);
    default:
      return true;
  }
}

/** Telnyx voice webhook (separate from the SMS reply ingest). */
export function verifyTelnyxVoice(req: Request, raw: string): boolean {
  const sig = req.headers.get("telnyx-signature-ed25519") ?? "";
  const ts = req.headers.get("telnyx-timestamp") ?? "";
  return ed25519Ok(raw, sig, ts, process.env.TELNYX_PUBLIC_KEY);
}
