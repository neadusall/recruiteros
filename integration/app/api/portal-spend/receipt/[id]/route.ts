/**
 * GET /api/portal-spend/receipt/<chargeId>?v=png|thumb|file   (any signed-in member)
 *
 * The client-facing invoice image behind a pushed Spending line. The <id> is the
 * CHARGE id, never the vault receipt id: the endpoint resolves the receipt from
 * the charge server-side and only if that charge is APPROVED and belongs to the
 * caller's own workspace. So a client can view the invoice for a line on their
 * own live statement and nothing else — invoices stay scoped, exactly like the
 * owner-only file route, but gated on the client's session instead.
 *
 *   v=png   (default) the rendered invoice image the statement shows
 *   v=thumb the small thumbnail
 *   v=file  the original PDF/image as the vendor sent it
 */

import { requireSession } from "../../../../../lib/api";
import { approvedChargeReceiptId } from "../../../../../lib/owner/portalSpend";
import { readReceiptArtifact } from "../../../../../lib/owner/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const workspaceId = g.ctx.workspace.id;

  const receiptId = approvedChargeReceiptId(workspaceId, ctx.params.id || "");
  if (!receiptId) return new Response("not found", { status: 404 });

  const v = (new URL(req.url).searchParams.get("v") || "png").toLowerCase();
  const which = v === "thumb" ? "thumb" : v === "file" ? "file" : "png";
  const art = await readReceiptArtifact(receiptId, which);
  if (!art) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(art.bytes), {
    status: 200,
    headers: {
      "Content-Type": art.mime,
      // Private like every invoice: never a shared cache.
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
    },
  });
}
