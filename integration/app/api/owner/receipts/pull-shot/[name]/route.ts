/**
 * GET /api/owner/receipts/pull-shot/<name>   (OWNER ONLY)
 *
 * The screenshot a failed portal pull left behind: whatever the headless browser was
 * actually looking at when it gave up. When a vendor redesigns their billing page, this is
 * the difference between "it broke" and a five-minute fix, so the console links straight to
 * it from the failure.
 *
 * Owner-gated like the receipts themselves: these frames are of a logged-in billing page.
 */

import { requireOwner } from "../../../../../../lib/api";
import { readPullShot } from "../../../../../../lib/owner/portalPullers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { name: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const bytes = await readPullShot(ctx.params.name || "");
  if (!bytes) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
