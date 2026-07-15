/**
 * Public media endpoint for LinkedIn Poster images.
 *
 * Deliberately unauthenticated: Ayrshare (and LinkedIn's fetcher behind it)
 * must be able to GET the image when a post publishes. The 24-hex random id is
 * the capability; ids are unguessable and unlisted. Same trade the roleShot
 * share links make.
 */

import { readMediaById } from "../../../../../../lib/linkedin/poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const media = await readMediaById(ctx.params.id || "");
  if (!media) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(media.bytes), {
    status: 200,
    headers: {
      "Content-Type": media.mime,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
