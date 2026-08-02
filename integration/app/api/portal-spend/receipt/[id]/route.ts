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
 *   dl=1    send it as a file download (attachment, named for the vendor + date) rather
 *           than opening inline, so the client can save the real receipt
 */

import { requireSession } from "../../../../../lib/api";
import { approvedChargeReceiptMeta } from "../../../../../lib/owner/portalSpend";
import { readReceiptArtifact } from "../../../../../lib/owner/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const workspaceId = g.ctx.workspace.id;

  const meta = approvedChargeReceiptMeta(workspaceId, ctx.params.id || "");
  if (!meta) return new Response("not found", { status: 404 });

  const url = new URL(req.url);
  const v = (url.searchParams.get("v") || "png").toLowerCase();
  const which = v === "thumb" ? "thumb" : v === "file" ? "file" : "png";
  const art = await readReceiptArtifact(meta.receiptId, which);
  if (!art) return new Response("not found", { status: 404 });

  // dl=1 -> save the file. Name it for the vendor, date and invoice number so a saved
  // receipt is recognisable on disk; the extension follows the actual bytes' MIME.
  const download = url.searchParams.get("dl") === "1";
  const disposition = download
    ? `attachment; filename="${downloadName(meta, art.mime)}"`
    : "inline";

  return new Response(new Uint8Array(art.bytes), {
    status: 200,
    headers: {
      "Content-Type": art.mime,
      // Private like every invoice: never a shared cache.
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": disposition,
    },
  });
}

/** "receipt-<vendor>-<date>[-#invoice].<ext>", ASCII-safe for a Content-Disposition header. */
function downloadName(
  meta: { vendor?: string; chargedAt?: string; invoiceNumber?: string },
  mime: string,
): string {
  const ext = /pdf/.test(mime) ? "pdf" : /png/.test(mime) ? "png" : /jpe?g/.test(mime) ? "jpg" : /gif/.test(mime) ? "gif" : "bin";
  const slug = (s?: string) => String(s || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const parts = ["receipt", slug(meta.vendor), slug((meta.chargedAt || "").slice(0, 10))];
  if (meta.invoiceNumber) parts.push(slug("inv-" + meta.invoiceNumber));
  return parts.filter(Boolean).join("-") + "." + ext;
}
