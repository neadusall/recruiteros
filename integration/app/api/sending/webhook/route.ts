/**
 * POST /api/sending/webhook  — Postal webhook receiver.
 * Postal posts message events here (delivered / bounced / held / spam complaint /
 * opens). We normalize and apply them to metrics + suppression + the governor.
 *
 * AUTH (fail-closed): unauthenticated events could forge bounces -> permanent
 * suppression + governor domain pauses, i.e. remote shutdown of the sending
 * stack. So the endpoint requires SENDING_WEBHOOK_SECRET, checked in constant
 * time against `?secret=` or the `x-webhook-secret` header. With no secret
 * configured, events are REJECTED unless SENDING_WEBHOOK_ALLOW_UNSIGNED=1
 * (the explicit dev/bootstrap escape hatch).
 */

import { timingSafeEqual } from "node:crypto";
import { ok, fail, body } from "../../../../lib/api";
import { applyDeliveryEvent, mapPostalEvent } from "../../../../lib/sending/ingest";

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const secret = process.env.SENDING_WEBHOOK_SECRET;
  if (secret) {
    const url = new URL(req.url);
    const provided = url.searchParams.get("secret") || req.headers.get("x-webhook-secret") || "";
    if (!safeEq(provided, secret)) return fail("forbidden", 403);
  } else if (!["1", "true", "yes", "on"].includes((process.env.SENDING_WEBHOOK_ALLOW_UNSIGNED || "").toLowerCase())) {
    // Nothing fails silently: the 403 body says exactly what to configure.
    return fail("webhook_secret_not_configured: set SENDING_WEBHOOK_SECRET (and append ?secret=... to the Postal webhook URL) or SENDING_WEBHOOK_ALLOW_UNSIGNED=1", 403);
  }

  const b = await body<any>(req);
  if (!b) return fail("bad_payload", 400);

  // Postal shape: { event, payload: { message: { to, mail_from / from, ... } } }
  const event = b.event || b.type;
  const type = mapPostalEvent(String(event || ""));
  if (!type) return ok({ ignored: event });

  const msg = b.payload?.message || b.message || {};
  const to = msg.to || b.payload?.to || "";
  const from = msg.mail_from || msg.from || b.payload?.from || "";
  if (!from || !to) return ok({ ignored: "missing_addresses" });

  // Postal includes the opener's user-agent + IP on load/click events; we pass
  // them through so opens can be classified human vs machine (Apple MPP, image
  // proxies, bots) in ingest. Field names vary across Postal versions.
  const userAgent = b.payload?.user_agent || b.payload?.userAgent || msg.user_agent || undefined;
  const ip = b.payload?.ip_address || b.payload?.ip || msg.ip_address || undefined;

  await applyDeliveryEvent({
    type,
    from: String(from),
    to: String(to),
    detail: b.payload?.details || b.payload?.output || undefined,
    eventName: String(event || ""),
    userAgent: userAgent ? String(userAgent) : undefined,
    ip: ip ? String(ip) : undefined,
  });
  return ok({ applied: type });
}
