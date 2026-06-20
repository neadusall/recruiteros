/**
 * In-Market · PUBLIC watch stream for picture-in-picture role videos.
 *
 * GET /api/in-market/watch?key=<key>&fmt=mp4|gif
 *   -> stream a composite asset WITHOUT a session, so a prospect can open the share link
 *      (the watch.html landing page) you send them. The capability is the unguessable key
 *      (it ends in a clip+layout hash) — same "secret URL" model as the owner-console slug.
 *      Read-only by exact key; there is no listing/enumeration. Supports HTTP Range so the
 *      MP4 scrubs/seeks in the browser.
 *
 * The authenticated GET on /api/in-market/video is for the operator (the Studio); this is the
 * public surface for recipients.
 */

import { readCompositeAsset } from "../../../../lib/inmarket/roleVideo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { gif: "image/gif", mp4: "video/mp4" };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const fmt = (url.searchParams.get("fmt") || "mp4").toLowerCase();
  if (fmt !== "gif" && fmt !== "mp4") return new Response("bad format", { status: 400 });

  // SIGNED + EXPIRING: recipient links must carry a valid exp+sig (Loom-style). Forwarded or
  // stale links stop working after the TTL.
  const { verifyShare } = await import("../../../../lib/inmarket/shareSign");
  if (!verifyShare(key, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("This link has expired or is invalid.", { status: 403 });
  }

  const buf = await readCompositeAsset(key, fmt as "gif" | "mp4");
  if (!buf) return new Response("not found", { status: 404 });

  // Email-teaser open: count a GIF load as an approximate email open, EXCEPT the watch-page
  // poster (which passes notrack=1) so we don't double-count the watch view as an email open.
  if (fmt === "gif" && !url.searchParams.get("notrack")) {
    import("../../../../lib/inmarket/videoStats")
      .then((m) => m.recordVideoEvent({ videoKey: key, type: "gif_open" }))
      .catch(() => {});
  }

  const total = buf.length;
  const baseHeaders: Record<string, string> = {
    "Content-Type": MIME[fmt],
    "Accept-Ranges": "bytes",
    // Public, immutable-ish: the key changes whenever the clip/layout changes.
    "Cache-Control": "public, max-age=86400",
  };

  // Range support so <video> can seek (browsers send Range on the MP4).
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
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(chunk.length),
      },
    });
  }

  return new Response(buf as any, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}
