/**
 * In-Market · Picture-in-picture role VIDEO.
 *
 * POST /api/in-market/video
 *   { company, roleTitle, roleUrl?, domain?, clipId, pip?, wait?, force?, durationSec? }
 *     durationSec: optional explicit page-scroll length; omitted → auto-match the webcam clip length.
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

import { body, ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { gif: "image/gif", mp4: "video/mp4", jpg: "image/jpeg" };

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const fmt = (url.searchParams.get("fmt") || "gif").toLowerCase();
  if (fmt !== "gif" && fmt !== "mp4" && fmt !== "jpg") return fail("bad_format", 400);

  const { readCompositeAsset } = await import("../../../../lib/inmarket/roleVideo");
  const buf = await readCompositeAsset(key, fmt);
  if (!buf) return new Response("not found", { status: 404 });

  // Short cache + REAL Range support (this route used to advertise Accept-Ranges but ignore the
  // header and pin a 24h private cache, so the in-app preview kept replaying a stale render and
  // could not stream/seek properly - the operator saw a broken video while the public link was
  // fine). Mirrors the public watch route.
  const total = buf.length;
  const baseHeaders: Record<string, string> = {
    "Content-Type": MIME[fmt],
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (isNaN(start) || start > end || start >= total) {
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const chunk = buf.subarray(start, end + 1);
    return new Response(chunk as any, {
      status: 206,
      headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(chunk.length) },
    });
  }

  return new Response(buf as any, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
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
  // Optional explicit scroll length (seconds). When omitted, the page scroll auto-matches the
  // recorded clip's own length so the composite is one clean pass. Clamped to a sane 5–180s.
  const durRaw = Number(b?.durationSec);
  const durationSec = Number.isFinite(durRaw) && durRaw > 0 ? Math.min(180, Math.max(5, Math.round(durRaw))) : undefined;
  const opts = {
    force: b?.force === true,
    // Personalized cloned-voice "Hey {firstName}," intro (optional).
    firstName: b?.firstName ? String(b.firstName) : undefined,
    voiceId: await resolveVoiceId(ws, b?.voiceId ? String(b.voiceId) : undefined),
    durationSec,
  };
  const result = b?.wait === true
    ? await composeRoleVideo(reqShot, clipId, b?.pip, opts)
    : await getOrStartVideo(reqShot, clipId, b?.pip, opts);

  // When the composite is ready, hand the Studio SIGNED, expiring share links to send (the
  // recipient surfaces require a valid signature — see /api/in-market/watch).
  let share;
  if (result.status === "ready" && result.key) {
    const { compositeShareUrls } = await import("../../../../lib/inmarket/shareSign");
    const { notifyBrand } = await import("../../../../lib/outbound/brand");
    const base = (await notifyBrand(ws).catch(() => null))?.appUrl;
    share = compositeShareUrls(result.key, { company, roleTitle, base });
    // Record key -> workspace so the public watch page resolves this workspace's brand kit.
    try {
      const { makeShortLinks } = await import("../../../../lib/inmarket/shortLinks");
      await makeShortLinks([{ videoKey: result.key, company, role: roleTitle, workspaceId: ws }]);
    } catch { /* best-effort */ }
  }
  return ok({ ...result, share });
}
