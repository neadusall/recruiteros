/**
 * GET /api/phone/voicemail/audio/{file}
 * Serve a stored voicemail greeting so Telnyx playback_start can fetch it when
 * an unanswered call goes to voicemail, and so the recruiter can preview their
 * own greeting in the BD Phone tab. PUBLIC by necessity (Telnyx's media
 * fetcher carries no session) but file names are opaque random tokens and the
 * reader refuses anything outside its flat directory.
 */

import { NextResponse } from "next/server";
import { readGreeting } from "../../../../../../lib/phone/voicemail";

export async function GET(_req: Request, ctx: { params: { file: string } | Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const bytes = await readGreeting(file);
  if (!bytes) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(bytes as any, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=3600",
    },
  });
}
