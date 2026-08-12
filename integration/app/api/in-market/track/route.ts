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
 *
 * DELETE /api/in-market/track?key=<videoKey>   (AUTHED)
 *     -> drop one video's stats, for internal views that would skew the numbers.
 */

import { ok, fail, requireCapability } from "../../../../lib/api";

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

  // Is this a person or a security scanner? Email gateways fetch every link in a cold email
  // within seconds of delivery, so an unjudged "open" is not evidence anyone saw anything.
  let machine = false;
  let machineReason: string | undefined;
  try {
    const { classifyViewer, clientIp } = await import("../../../../lib/inmarket/viewerId");
    const verdict = await classifyViewer(req.headers.get("user-agent") || "", clientIp(req.headers));
    machine = verdict.kind === "machine";
    machineReason = verdict.reason;
  } catch { /* unjudged traffic counts as a person, never the other way round */ }

  // Who was it? The link's rcpt may be a prospect id or an email; when it carries neither, a
  // video sent to exactly one person identifies its own watcher.
  let who: import("../../../../lib/inmarket/viewerId").ViewerIdentity | null = null;
  if (!machine) {
    try {
      const { identifyViewer } = await import("../../../../lib/inmarket/viewerId");
      who = await identifyViewer(k, b?.rcpt ? String(b.rcpt).slice(0, 160) : undefined);
    } catch { /* an anonymous watch is still a watch */ }
  }

  try {
    const { recordVideoEvent } = await import("../../../../lib/inmarket/videoStats");
    await recordVideoEvent({
      videoKey: k,
      type: t as any,
      company: b?.c ? String(b.c).slice(0, 120) : undefined,
      roleTitle: b?.r ? String(b.r).slice(0, 160) : undefined,
      recipient: who?.prospectId || (b?.rcpt ? String(b.rcpt).slice(0, 120) : undefined),
      seconds: b?.s != null ? Number(b.s) : undefined,
      sessionId: b?.sid ? String(b.sid).slice(0, 64) : undefined,
      machine, machineReason,
      viewerName: who?.name, viewerEmail: who?.email, viewerCompany: who?.company,
    });
  } catch { /* best-effort tracking never breaks the viewer */ }

  // Watch-to-connect: a real play by a real person queues the sending recruiter's LinkedIn
  // request. Fire-and-forget so the beacon stays instant; the handler owns all dedupe and
  // safety gates. A scanner must never reach this: it would ask a stranger to connect off a
  // click they never made.
  if (t === "play" && !machine && who?.prospectId) {
    import("../../../../lib/linkedin/os/watchConnect")
      .then((m) => m.handleVideoWatch(who!.prospectId!, k))
      .catch(() => { /* never surfaces to the viewer */ });
  }
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const url = new URL(req.url);

  const key = url.searchParams.get("key");
  if (key) {
    const { statsForVideo } = await import("../../../../lib/inmarket/videoStats");
    return ok({ stat: await statsForVideo(key) });
  }

  // Label any rows whose link never carried a company/role before reading the board, so the
  // dashboard shows who a video was for instead of a bare dot. Cheap and idempotent: it only
  // touches rows that are still blank.
  try {
    const { backfillVideoLabels } = await import("../../../../lib/inmarket/viewerId");
    await backfillVideoLabels();
  } catch { /* the board still renders with blank labels */ }

  const { statsOverview } = await import("../../../../lib/inmarket/videoStats");
  const days = Number(url.searchParams.get("days")) || 14;
  return ok(await statsOverview({ days }));
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return fail("missing_key", 422);
  const { removeVideoStats } = await import("../../../../lib/inmarket/videoStats");
  const removed = await removeVideoStats(key);
  if (!removed) return fail("not_found", 404, { detail: "That video has no stats to remove." });
  return ok({ removed: true, videoKey: key });
}
