/**
 * Built-in booking calendar (PUBLIC; the signed link is the capability).
 *
 * GET  /api/book?w=<workspaceId>&sig=<hmac>  -> brand + the open slots
 * POST /api/book { w, sig, start, name, email, note? } -> book the slot,
 *      email calendar invites (ICS) to the organizer and the guest from the
 *      workspace's own brand mailbox.
 *
 * Powers the /book page that the video watch page embeds in place of a
 * third-party Calendly/TidyCal iframe. See lib/inmarket/booking.ts.
 */

import { body, ok, fail } from "../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Light per-IP throttle so a script can't spray bookings. */
const hits = new Map<string, number[]>();
function allow(ip: string, max = 20, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}
function ipOf(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

async function guarded(w: string, sig: string) {
  const { verifyBookingLink, bookingActive } = await import("../../../lib/inmarket/booking");
  if (!w || !verifyBookingLink(w, sig)) return null;
  const { getSettings } = await import("../../../lib/inmarket/videoSettings");
  const s = await getSettings(w);
  return bookingActive(s) ? s : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const w = (url.searchParams.get("w") || "").trim();
  const s = await guarded(w, (url.searchParams.get("sig") || "").trim());
  if (!s) return fail("booking_unavailable", 404);

  // Brand for the page header: video brand kit first, workspace branding as backup.
  let brandName = s.brandName || "", logoUrl = s.logoUrl || "", accent = s.accent || "";
  try {
    const { getBranding } = await import("../../../lib/branding");
    const b = await getBranding(w);
    brandName = brandName || b.brandName || "";
    logoUrl = logoUrl || b.logoUrl || "";
    accent = accent || b.accentColor || "";
  } catch { /* brand is best-effort */ }

  const { listOpenSlots } = await import("../../../lib/inmarket/booking");
  const slots = await listOpenSlots(w, s);
  return ok(
    { brand: { brandName, logoUrl, accent }, ...slots },
    200,
  );
}

interface BookBody { w?: string; sig?: string; start?: string; name?: string; email?: string; note?: string; phone?: string }

export async function POST(req: Request) {
  if (!allow(ipOf(req))) return fail("too_many_requests", 429);
  const b = (await body<BookBody>(req)) || {};
  const w = String(b.w || "").trim();
  const s = await guarded(w, String(b.sig || "").trim());
  if (!s) return fail("booking_unavailable", 404);

  const name = String(b.name || "").trim().slice(0, 80);
  const email = String(b.email || "").trim().slice(0, 120);
  const note = String(b.note || "").trim().slice(0, 500);
  const phoneRaw = String(b.phone || "").trim().slice(0, 30);
  const start = String(b.start || "").trim();
  if (!name) return fail("name_required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("valid_email_required");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(start)) return fail("bad_slot");

  const { book, normalizePhone } = await import("../../../lib/inmarket/booking");
  // A phone that doesn't normalize is treated as not provided rather than
  // failing the booking: the meeting matters more than the reminder.
  const phone = phoneRaw ? normalizePhone(phoneRaw) || undefined : undefined;
  const res = await book(w, s, start, { name, email, note: note || undefined, phone });
  if (!res.ok) return fail(res.error || "slot_taken", 409);
  return ok({ ok: true, when: res.when, meetingUrl: res.booking?.meetingUrl || "" });
}
