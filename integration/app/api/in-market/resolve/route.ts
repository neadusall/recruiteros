/**
 * Resolve a watch link -> the video + the brand + the booking calendar.
 *
 * GET /api/in-market/resolve?s=<code>                  (PUBLIC - the code is the capability)
 * GET /api/in-market/resolve?k=<videoKey>&exp&sig      (PUBLIC - signed share link required)
 *
 * Powers the branded video landing pages: the watch page calls this, gets the signed MP4/GIF
 * URLs plus the owning workspace's brand (logo / accent / name / CTA) and its booking calendar,
 * and renders the branded video + calendar. The `k` form serves every link already in the wild:
 * it must carry a VALID exp+sig (the same share signature the asset stream checks), and the
 * owning workspace is recovered through the deterministic short-code record.
 */

import { resolveShortLink, shortCodeFor } from "../../../../lib/inmarket/shortLinks";
import { compositeShareUrls, verifyShare } from "../../../../lib/inmarket/shareSign";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const s = (url.searchParams.get("s") || "").trim();
  const k = (url.searchParams.get("k") || "").trim();
  if (!s && !k) return Response.json({ error: "missing_code" }, { status: 400 });

  let rec = null;
  if (s) {
    rec = await resolveShortLink(s);
    if (!rec) return Response.json({ error: "not_found" }, { status: 404 });
  } else {
    // Raw-key form: only for holders of a validly signed link (never an enumeration surface).
    if (!verifyShare(k, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return Response.json({ error: "invalid_sig" }, { status: 403 });
    }
    rec = await resolveShortLink(shortCodeFor(k));
    if (!rec) rec = { videoKey: k, company: "", role: "", workspaceId: undefined, at: "" };
  }

  // Brand + calendar from the owning workspace (the domain IS the brand).
  let brand: Record<string, unknown> = {};
  let whiteLabel = false;
  let base: string | undefined;
  if (rec.workspaceId) {
    try {
      const { getBranding } = await import("../../../../lib/branding");
      const { getSettings } = await import("../../../../lib/inmarket/videoSettings");
      const { notifyBrand } = await import("../../../../lib/outbound/brand");
      const { withBookingCalendar } = await import("../../../../lib/inmarket/booking");
      const [b, vs0, nb] = await Promise.all([
        getBranding(rec.workspaceId), getSettings(rec.workspaceId), notifyBrand(rec.workspaceId),
      ]);
      // Built-in booking page (when on) wins over any third-party calendar URL.
      const vs = await withBookingCalendar(rec.workspaceId, vs0);
      whiteLabel = nb.whiteLabel;
      base = nb.appUrl;
      brand = {
        logoUrl: vs.logoUrl || b.logoUrl,
        accent: vs.accent || b.accentColor,
        brandName: vs.brandName || b.brandName || (nb.whiteLabel ? nb.name : undefined),
        ctaText: vs.ctaText,
        ctaUrl: vs.ctaUrl,
        calendarUrl: vs.calendarUrl,   // built-in /book page or TidyCal / Calendly / Cal.com URL
        replyEmail: vs.replyEmail,
      };
    } catch { /* brand is best-effort */ }
  }
  // Default booking calendar when a workspace hasn't set its own, so every video has a calendar
  // on the landing page out of the box. HOUSE ONLY: a white-label tenant's prospects must never
  // see the house calendar, so tenants get one only from their own brand kit.
  if (!brand.calendarUrl && !whiteLabel) {
    let fallback = (process.env.RECRUITEROS_DEFAULT_CALENDAR_URL || "").trim();
    if (!fallback) {
      try { fallback = (await import("../../../../lib/bd/booking")).bookingUrl("consultative"); } catch { /* none */ }
    }
    if (fallback) brand.calendarUrl = fallback;
  }

  const share = compositeShareUrls(rec.videoKey, { company: rec.company, roleTitle: rec.role, base });

  return Response.json(
    { key: rec.videoKey, company: rec.company, role: rec.role, mp4: share.mp4, gif: share.gif, brand },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
