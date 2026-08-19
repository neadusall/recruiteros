/**
 * GET /api/voice/audio/{file}
 * Serve a cached voice-clone segment (mp3) so Telnyx playback_start can fetch it
 * during a voicemail drop. PUBLIC by necessity — Telnyx's media fetcher carries
 * no session — but it only ever exposes opaque, pre-rendered audio segments from
 * the clone cache (no listing, no enumeration of who was called).
 */

import { NextResponse } from "next/server";
import { readSegment } from "../../../../../lib/voice";

export async function GET(_req: Request, ctx: { params: { file: string } | Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const bytes = await readSegment(file);
  if (!bytes) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Clone segments are mp3; uploaded pitch recordings may be wav. Telnyx needs
  // the honest content type to play the file.
  const type = /\.wav$/i.test(file) ? "audio/wav" : "audio/mpeg";
  return new NextResponse(bytes as any, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
