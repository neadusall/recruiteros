/**
 * Resolve a short watch code -> the video + the brand + the booking calendar.
 *
 * GET /api/in-market/resolve?s=<code>   (PUBLIC — the code is the capability)
 *
 * Powers `vid.<yourdomain>/v/<code>` landing pages: the watch page calls this, gets the signed
 * MP4/GIF URLs plus the owning workspace's brand (logo / accent / name) and its TidyCal booking
 * URL, and renders the branded video + calendar. No auth, no per-request secrets exposed — just
 * the public, expiring asset links.
 */

import { resolveShortLink } from "../../../../lib/inmarket/shortLinks";
import { compositeShareUrls } from "../../../../lib/inmarket/shareSign";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const s = (url.searchParams.get("s") || "").trim();
  if (!s) return Response.json({ error: "missing_code" }, { status: 400 });

  const rec = await resolveShortLink(s);
  if (!rec) return Response.json({ error: "not_found" }, { status: 404 });

  const share = compositeShareUrls(rec.videoKey, { company: rec.company, roleTitle: rec.role });

  // Brand + calendar from the owning workspace (the domain IS the brand).
  let brand: Record<string, unknown> = {};
  if (rec.workspaceId) {
    try {
      const { getBranding } = await import("../../../../lib/branding");
      const { getSettings } = await import("../../../../lib/inmarket/videoSettings");
      const [b, vs] = await Promise.all([getBranding(rec.workspaceId), getSettings(rec.workspaceId)]);
      brand = {
        logoUrl: vs.logoUrl || b.logoUrl,
        accent: vs.accent || b.accentColor,
        brandName: vs.brandName || b.brandName,
        ctaText: vs.ctaText,
        ctaUrl: vs.ctaUrl,
        calendarUrl: vs.calendarUrl,   // TidyCal / Calendly / Cal.com booking URL
        replyEmail: vs.replyEmail,
      };
    } catch { /* brand is best-effort */ }
  }

  return Response.json(
    { key: rec.videoKey, company: rec.company, role: rec.role, mp4: share.mp4, gif: share.gif, brand },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
