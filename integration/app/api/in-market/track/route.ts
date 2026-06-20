/**
 * In-Market · PiP video engagement tracking.
 *
 * POST /api/in-market/track   (PUBLIC — fired by the prospect-facing watch page)
 *   { k, t, c?, r?, s?, sid? }
 *     k=videoKey, t=event (open|play|complete|heartbeat), c=company, r=roleTitle,
 *     s=seconds (heartbeat), sid=anonymous session id. Returns 204. CORS-open so the
 *     watch page works even if served from another origin; no session required.
 *
 * GET /api/in-market/track?overview=1   (AUTHED — the PiP Studio "Performance" dashboard)
 *     -> aggregated stats: totals, daily trend, per-video rows, recent activity feed.
 *   GET ?key=<videoKey>  -> stats for one video.
 */

import { requireSession, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  let b: any = {};
  try {
    // Accept JSON or sendBeacon's text/plain body.
    const text = await req.text();
    b = text ? JSON.parse(text) : {};
  } catch { /* ignore malformed beacons */ }

  const k = String(b?.k ?? "").trim();
  const t = String(b?.t ?? "").trim();
  if (!k || !["open", "play", "complete", "heartbeat"].includes(t)) {
    return new Response(null, { status: 204, headers: CORS });
  }
  try {
    const { recordVideoEvent } = await import("../../../../lib/inmarket/videoStats");
    await recordVideoEvent({
      videoKey: k,
      type: t as any,
      company: b?.c ? String(b.c).slice(0, 120) : undefined,
      roleTitle: b?.r ? String(b.r).slice(0, 160) : undefined,
      recipient: b?.rcpt ? String(b.rcpt).slice(0, 120) : undefined,
      seconds: b?.s != null ? Number(b.s) : undefined,
      sessionId: b?.sid ? String(b.sid).slice(0, 64) : undefined,
    });
  } catch { /* best-effort tracking never breaks the viewer */ }
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);

  const key = url.searchParams.get("key");
  if (key) {
    const { statsForVideo } = await import("../../../../lib/inmarket/videoStats");
    return ok({ stat: await statsForVideo(key) });
  }

  const { statsOverview } = await import("../../../../lib/inmarket/videoStats");
  const days = Number(url.searchParams.get("days")) || 14;
  return ok(await statsOverview({ days }));
}
