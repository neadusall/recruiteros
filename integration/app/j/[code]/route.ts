/**
 * Short join links for meeting texts and emails: /j/<code> resolves the
 * booking and 302s to a FRESH branded join URL (token re-minted at click
 * time, guest name prefilled). Public by design: the unguessable code is the
 * capability, and a dead code answers with a friendly page, not an error dump.
 */

import { joinUrlForBooking } from "../../../lib/inmarket/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { code: string } }) {
  const url = await joinUrlForBooking(ctx.params?.code || "");
  if (url) return Response.redirect(url, 302);
  return new Response(
    "<!doctype html><meta charset='utf-8'><title>Meeting link</title>" +
    "<body style='font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#4b5364'>" +
    "<div style='max-width:420px;text-align:center'><h2 style='color:#14181f'>This meeting link has expired</h2>" +
    "<p>The call this link belonged to is over or was rescheduled. Reply to your confirmation email and we'll set a new time.</p></div>",
    { status: 410, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
