/**
 * In-Market · Webcam clips (the recorded "you" for picture-in-picture role videos).
 *
 * POST   /api/in-market/clip   { dataUrl, mime?, label? }   (dataUrl = base64 from MediaRecorder)
 *                              -> store the recording, return its reusable metadata { id, ... }.
 *        (also accepts a raw video body with Content-Type: video/*)
 * GET    /api/in-market/clip                 -> list the signed-in recruiter's own clips.
 * GET    /api/in-market/clip?id=<id>         -> stream one clip for preview (<video> src).
 * DELETE /api/in-market/clip?id=<id>         -> delete one clip.
 *
 * Clips are reusable across roles: record once, composite onto many hiring-signal scrolls.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MediaRecorder webm clips are a few MB; allow generous headroom.
const MAX_BYTES = 60 * 1024 * 1024;

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const me = (g.ctx.user.email || "").trim().toLowerCase();

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const { listClips, readClipBytes, getClip } = await import("../../../../lib/inmarket/roleVideo");

  if (!id) {
    // Recordings are personal: each recruiter sees only their own takes.
    return ok({ clips: await listClips(ws, me) });
  }

  const meta = await getClip(id);
  if (!meta || meta.workspaceId !== ws) return new Response("not found", { status: 404 });
  if (meta.ownerEmail && meta.ownerEmail !== me) return new Response("not found", { status: 404 });
  const got = await readClipBytes(id);
  if (!got) return new Response("not found", { status: 404 });
  return new Response(got.buf as any, {
    status: 200,
    headers: {
      "Content-Type": got.mime || "video/webm",
      "Content-Length": String(got.buf.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  let buf: Buffer;
  let mime = "video/webm";
  let label: string | undefined;

  try {
    if (ctype.startsWith("video/")) {
      // Raw upload.
      buf = Buffer.from(await req.arrayBuffer());
      mime = ctype.split(";")[0];
    } else {
      // JSON { dataUrl } from MediaRecorder → FileReader.readAsDataURL.
      const b = await body<any>(req);
      const dataUrl = String(b?.dataUrl ?? "");
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!m) return fail("missing dataUrl (data:video/...;base64,...)", 422);
      mime = m[1];
      buf = Buffer.from(m[2], "base64");
      label = b?.label ? String(b.label) : undefined;
    }
  } catch (e: any) {
    return fail(e?.message || "bad upload", 400);
  }

  if (!buf.length) return fail("empty clip", 422);
  if (buf.length > MAX_BYTES) return fail("clip too large (max 60MB)", 413);

  const { saveClip } = await import("../../../../lib/inmarket/roleVideo");
  const meta = await saveClip(ws, buf, { mime, label, ownerEmail: g.ctx.user.email });
  return ok({ clip: meta }, 201);
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return fail("missing id", 422);
  const { deleteClip } = await import("../../../../lib/inmarket/roleVideo");
  const okDel = await deleteClip(ws, id, g.ctx.user.email);
  return okDel ? ok({ deleted: id }) : fail("not_found", 404);
}
