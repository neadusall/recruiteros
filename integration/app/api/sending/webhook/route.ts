/**
 * POST /api/sending/webhook  — Postal webhook receiver.
 * Postal posts message events here (delivered / bounced / held / spam complaint /
 * opens). We normalize and apply them to metrics + suppression + the governor.
 *
 * No session (Postal is server-to-server). Optionally verify a shared secret via
 * SENDING_WEBHOOK_SECRET (?secret= or X-Postal-Signature presence).
 */

import { ok, fail, body } from "../../../../lib/api";
import { applyDeliveryEvent, mapPostalEvent } from "../../../../lib/sending/ingest";

export async function POST(req: Request) {
  const secret = process.env.SENDING_WEBHOOK_SECRET;
  if (secret) {
    const url = new URL(req.url);
    if (url.searchParams.get("secret") !== secret) return fail("forbidden", 403);
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

  await applyDeliveryEvent({
    type,
    from: String(from),
    to: String(to),
    detail: b.payload?.details || b.payload?.output || undefined,
  });
  return ok({ applied: type });
}
