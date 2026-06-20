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

import { requireSession, body, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp" };

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);

  // ?list=1 — every verified page-scroll GIF available to personalize (PiP Studio gallery).
  if (url.searchParams.get("list")) {
    const { listShots } = await import("../../../../lib/inmarket/roleShot");
    return ok({ shots: await listShots() });
  }

  const key = url.searchParams.get("key") || "";
  const fmt = (url.searchParams.get("fmt") || "gif").toLowerCase();
  if (fmt !== "png" && fmt !== "gif" && fmt !== "webp") return fail("bad_format", 400);

  const { readShotAsset } = await import("../../../../lib/inmarket/roleShot");
  const buf = await readShotAsset(key, fmt);
  if (!buf) return new Response("not found", { status: 404 });

  // `as any` only because BodyInit's Node Buffer typing varies across lib targets.
  return new Response(buf as any, {
    status: 200,
    headers: {
      "Content-Type": MIME[fmt],
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
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
