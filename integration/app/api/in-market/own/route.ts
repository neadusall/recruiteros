/**
 * In-Market · Register video ownership (so watch-page replies route to the right workspace).
 *
 * POST /api/in-market/own  { videoKey, company?, roleTitle? }  (AUTHED)
 *   -> record that this workspace + operator owns videoKey, so leads from its public watch page
 *      are scoped + notifications reach the operator. The PiP Studio calls this when a video is
 *      generated. Idempotent.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<any>(req);
  const videoKey = String(b?.videoKey ?? "").trim();
  if (!videoKey) return fail("missing videoKey", 422);
  const { registerVideoOwner } = await import("../../../../lib/inmarket/leads");
  await registerVideoOwner(videoKey, g.ctx.workspace.id, {
    email: g.ctx.user?.email,
    company: b?.company ? String(b.company) : undefined,
    roleTitle: b?.roleTitle ? String(b.roleTitle) : undefined,
  });
  return ok({ ok: true });
}
