/**
 * In-Market · Brand kit logo upload + serving.
 *
 * POST /api/in-market/brand-logo { dataUrl }   (data:image/...;base64,... from a file picker)
 *      -> store the image and point this workspace's brand kit logoUrl at the hosted copy;
 *         returns the updated settings (same shape as PUT /api/in-market/settings).
 * GET  /api/in-market/brand-logo?id=<uuid>.<ext> -> serve the image. Public on purpose: the
 *      recipient watch page loads it without a session; ids are unguessable UUIDs, the same
 *      trust model as the share links themselves.
 */

import { join } from "node:path";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { body, ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

const FILE_RE = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
const LOGO_PATH_RE = /^\/api\/in-market\/brand-logo\?id=([0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/;

function brandDir(): string {
  const base = process.env.ROS_DATA_DIR || join(process.cwd(), ".data");
  return join(base, "videos", "brand");
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!FILE_RE.test(id)) return new Response("not found", { status: 404 });
  const buf = await readFile(join(brandDir(), id)).catch(() => null);
  if (!buf) return new Response("not found", { status: 404 });
  const ext = id.slice(id.lastIndexOf(".") + 1);
  return new Response(buf as any, {
    status: 200,
    headers: {
      "Content-Type": EXT_TO_MIME[ext] || "application/octet-stream",
      "Content-Length": String(buf.length),
      // A replaced logo gets a NEW id, so the bytes behind an id never change.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req).catch(() => null);
  const m = String(b?.dataUrl ?? "").match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s);
  if (!m) return fail("missing dataUrl (data:image/png|jpeg|webp|gif;base64,...)", 422);
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return fail("empty image", 422);
  if (buf.length > MAX_BYTES) return fail("logo too large (max 2MB)", 413);

  const { randomUUID } = await import("node:crypto");
  const file = `${randomUUID()}.${MIME_TO_EXT[m[1]]}`;
  await mkdir(brandDir(), { recursive: true });
  await writeFile(join(brandDir(), file), buf);

  const { getSettings, saveSettings } = await import("../../../../lib/inmarket/videoSettings");
  const prev = (await getSettings(ws)).logoUrl || "";
  const settings = await saveSettings(ws, { logoUrl: `/api/in-market/brand-logo?id=${file}` });

  // Replaced an earlier upload: drop the orphaned file (best effort).
  const old = prev.match(LOGO_PATH_RE);
  if (old && old[1] !== file) await unlink(join(brandDir(), old[1])).catch(() => {});

  return ok({ settings }, 201);
}
