/**
 * LinkedIn BD Engagement Assist: the approval queue behind the daily outreach
 * tasks. GET returns today's queue + readiness status (standby until email
 * sending is live and a LinkedIn seat is connected). POST actions:
 *   approve { id, text? }  -> hands the item to the shared LinkedIn engine
 *   skip    { id }
 *   edit    { id, text }
 *   build   {}             -> force a (idempotent) build of today's queue
 * Session-gated with outreach:send, same capability as the LinkedIn tab.
 */
import { ok, fail, body, requireCapability } from "../../../../lib/api";
import {
  engageView, buildEngageQueue, approveEngageItem, skipEngageItem, editEngageItem,
} from "../../../../lib/linkedin/engage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  return ok(await engageView(g.ctx.workspace.id));
}

export async function POST(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; id?: string; text?: string }>(req);
  if (!b || !b.action) return fail("unknown_action");

  if (b.action === "build") {
    const r = await buildEngageQueue(ws);
    return ok({ ...r, view: await engageView(ws) });
  }
  if (!b.id) return fail("missing_id");

  if (b.action === "approve") {
    const r = await approveEngageItem(ws, g.ctx.user.id, g.ctx.user.email, String(b.id), b.text);
    return ok({ accepted: r.accepted, reason: r.reason, view: await engageView(ws) });
  }
  if (b.action === "skip") {
    await skipEngageItem(ws, String(b.id));
    return ok({ view: await engageView(ws) });
  }
  if (b.action === "edit") {
    if (!b.text) return fail("missing_text");
    await editEngageItem(ws, String(b.id), String(b.text));
    return ok({ view: await engageView(ws) });
  }
  return fail("unknown_action");
}
