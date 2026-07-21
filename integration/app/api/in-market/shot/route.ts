/**
 * In-Market · Role screenshot assets.
 *
 * POST /api/in-market/shot
 *   { company, roleTitle, roleUrl?, domain?, force?, wait? }
 *     -> lazily capture (or return cached) the job post AS IT LIVES ON THE HIRING
 *        COMPANY'S OWN careers page: a full-page PNG still + an auto-scroll GIF/WebP.
 *        Non-blocking by default: returns the cached result, or status "capturing" while a
 *        background render runs (~20s) — the client re-requests to pick up the result. Pass
 *        wait:true to block until the capture finishes (CLI/batch). Captures nothing unless we
 *        can verify the company's own site + the right role (see lib/inmarket/roleShot).
 *
 * GET /api/in-market/shot?key=<key>&fmt=gif|webp|png
 *     -> stream one cached asset for <img>/<video-like> display. 404 when absent.
 *
 * Runs entirely on our server (Playwright + Chromium); assets persist under ROS_DATA_DIR.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4" };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const watch = url.searchParams.get("watch");
  const fmtParam = (url.searchParams.get("fmt") || "").toLowerCase();

  // PUBLIC-BY-KEY: the email teaser links to the watch page and the recipient is NOT logged in,
  // so assets + watch page are served without a session — the unguessable shot key IS the
  // capability (Loom-style share links). Listing/capture below stay authed.
  if (key && (watch || fmtParam)) {
    const { readShotAsset } = await import("../../../../lib/inmarket/roleShot");
    if (watch) {
      const html = await readShotAsset(key, "html");
      if (!html) return new Response("not found", { status: 404 });
      return new Response(html as any, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    const fmt = fmtParam || "gif";
    if (!MIME[fmt]) return fail("bad_format", 400);
    const buf = await readShotAsset(key, fmt as any);
    if (!buf) return new Response("not found", { status: 404 });
    const ct = MIME[fmt];
    const total = buf.length;

    // HTTP Range — lets the watch-page <video> stream and SEEK instead of downloading the whole
    // MP4 up front. Browsers send `Range: bytes=...` for media; honor it with a 206 response.
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start)) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" } });
        }
        const chunk = buf.subarray(start, end + 1);
        return new Response(chunk as any, {
          status: 206,
          headers: {
            "Content-Type": ct, "Content-Length": String(chunk.length),
            "Content-Range": `bytes ${start}-${end}/${total}`, "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    }
    // `as any` only because BodyInit's Node Buffer typing varies across lib targets.
    return new Response(buf as any, {
      status: 200,
      headers: { "Content-Type": ct, "Content-Length": String(total), "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" },
    });
  }

  // Authed: listing the available shots (PiP Studio gallery).
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  if (url.searchParams.get("list")) {
    const { listShots } = await import("../../../../lib/inmarket/roleShot");
    return ok({ shots: await listShots() });
  }
  return fail("bad_request", 400);
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;

  const b = await body<any>(req);
  const company = String(b?.company ?? "").trim();
  const roleTitle = String(b?.roleTitle ?? "").trim();
  if (!company || !roleTitle) return fail("missing company or roleTitle", 422);

  const { getOrStartShot, captureRoleShot } = await import("../../../../lib/inmarket/roleShot");
  const reqShot = {
    company,
    roleTitle,
    roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined,
    domain: b?.domain ? String(b.domain) : undefined,
  };
  const opts = { force: b?.force === true };
  const result = b?.wait === true ? await captureRoleShot(reqShot, opts) : await getOrStartShot(reqShot, opts);
  return ok(result);
}
