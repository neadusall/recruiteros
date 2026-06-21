/**
 * In-Market · Watch-page replies & leads.
 *
 * POST /api/in-market/lead   (PUBLIC — the recipient reply box / mini lead form)
 *   { k, type?, name?, email?, message?, c?, r?, rcpt? }
 *     -> store the reply/lead, scope it to the owning workspace, notify the operator. Returns 200
 *        { ok:true }. CORS-open so the watch page works from any origin; no session required.
 *
 * GET /api/in-market/lead   (AUTHED — operator)
 *     -> this workspace's replies/leads, newest first (PiP Studio "Replies").
 */

import { requireSession, ok } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
export async function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(req: Request) {
  let b: any = {};
  try { const t = await req.text(); b = t ? JSON.parse(t) : {}; } catch { /* ignore */ }
  const k = String(b?.k ?? "").trim();
  if (!k) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const { recordLead } = await import("../../../../lib/inmarket/leads");
    await recordLead({ videoKey: k, type: b?.type, name: b?.name, email: b?.email, message: b?.message, company: b?.c, roleTitle: b?.r, recipient: b?.rcpt });
  } catch { /* best-effort; never break the recipient */ }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const { listLeads } = await import("../../../../lib/inmarket/leads");
  return ok({ leads: await listLeads(g.ctx.workspace.id) });
}
