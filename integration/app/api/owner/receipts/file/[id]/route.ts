/**
 * GET /api/owner/receipts/file/<id>?v=png|thumb|file   (OWNER ONLY)
 *
 * Serves the receipt itself: the rendered PNG the console shows, its thumbnail for the
 * month grid, or the original PDF/image as the vendor sent it. Owner-gated like every other
 * /api/owner/* route — an invoice is not a share link.
 */

import { requireOwner } from "../../../../../../lib/api";
import { readReceiptArtifact } from "../../../../../../lib/owner/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const v = (new URL(req.url).searchParams.get("v") || "png").toLowerCase();
  const which = v === "thumb" ? "thumb" : v === "file" ? "file" : "png";
  const art = await readReceiptArtifact(ctx.params.id || "", which);
  if (!art) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(art.bytes), {
    status: 200,
    headers: {
      "Content-Type": art.mime,
      // Artifacts are immutable once written, but they are private: no shared caches.
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": which === "file" ? "inline" : "inline",
    },
  });
}
