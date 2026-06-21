/**
 * In-Market · Picture-in-picture role VIDEO.
 *
 * POST /api/in-market/video
 *   { company, roleTitle, roleUrl?, domain?, clipId, pip?, wait?, force? }
 *     -> composite the recorded webcam clip (clipId) as a PiP overlay onto the company's
 *        verified page-scroll capture. Non-blocking by default: returns the cached result,
 *        or status "composing" while a background render runs (page capture + ffmpeg). Pass
 *        wait:true to block until done (CLI/batch). `pip` customizes corner/size/shape/border
 *        (see lib/inmarket/roleVideo PipConfig).
 *
 * GET /api/in-market/video?key=<key>&fmt=gif|mp4
 *     -> stream one composite asset. gif = email-embeddable (muted, loops);
 *        mp4 = full composite WITH your voice (for a watch/landing link). 404 when absent.
 *
 * Runs entirely on our server (ffmpeg + the roleShot capture pipeline). No paid API.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { gif: "image/gif", mp4: "video/mp4" };

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const fmt = (url.searchParams.get("fmt") || "gif").toLowerCase();
  if (fmt !== "gif" && fmt !== "mp4") return fail("bad_format", 400);

  const { readCompositeAsset } = await import("../../../../lib/inmarket/roleVideo");
  const buf = await readCompositeAsset(key, fmt);
  if (!buf) return new Response("not found", { status: 404 });

  return new Response(buf as any, {
    status: 200,
    headers: {
      "Content-Type": MIME[fmt],
      "Content-Length": String(buf.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
    },
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req);
  const company = String(b?.company ?? "").trim();
  const roleTitle = String(b?.roleTitle ?? "").trim();
  const clipId = String(b?.clipId ?? "").trim();
  if (!company || !roleTitle) return fail("missing company or roleTitle", 422);
  if (!clipId) return fail("missing clipId", 422);

  const { getOrStartVideo, composeRoleVideo } = await import("../../../../lib/inmarket/roleVideo");
  const reqShot = {
    company,
    roleTitle,
    roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined,
    domain: b?.domain ? String(b.domain) : undefined,
  };
  // Resolve the voice that speaks the name: explicit override -> this workspace's own clone ->
  // env default. So once the operator clones their voice, every personalized render uses it.
  const { resolveVoiceId } = await import("../../../../lib/inmarket/voiceClone");
  const opts = {
    force: b?.force === true,
    // Personalized cloned-voice "Hey {firstName}," intro (optional).
    firstName: b?.firstName ? String(b.firstName) : undefined,
    voiceId: await resolveVoiceId(ws, b?.voiceId ? String(b.voiceId) : undefined),
  };
  const result = b?.wait === true
    ? await composeRoleVideo(reqShot, clipId, b?.pip, opts)
    : await getOrStartVideo(reqShot, clipId, b?.pip, opts);

  // When the composite is ready, hand the Studio SIGNED, expiring share links to send (the
  // recipient surfaces require a valid signature — see /api/in-market/watch).
  let share;
  if (result.status === "ready" && result.key) {
    const { compositeShareUrls } = await import("../../../../lib/inmarket/shareSign");
    share = compositeShareUrls(result.key, { company, roleTitle });
  }
  return ok({ ...result, share });
}
