/**
 * In-Market · captions for a role video.
 *
 * GET /api/in-market/captions?key=<videoKey>&exp&sig   (PUBLIC — the watch page's <track>)
 *   -> WebVTT for the recording behind this video, or 204 when there is no transcript yet.
 *      Signed exactly like the asset stream, so it is never an enumeration surface.
 *
 * POST /api/in-market/captions  { clipId, force?, text? }   (AUTHED — PiP Studio)
 *   -> transcribe a RECORDING once and cache it forever, or store hand-written captions.
 *      Every personalized video built on that recording then serves the same transcript, so
 *      the spend is per take, not per send.
 */

import { ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = (url.searchParams.get("key") || "").trim();
  if (!key) return new Response("missing key", { status: 400 });

  const { verifyShare } = await import("../../../../lib/inmarket/shareSign");
  if (!verifyShare(key, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("This link has expired or is invalid.", { status: 403 });
  }

  let vtt: string | null = null;
  try {
    const { videoWorkspaceId } = await import("../../../../lib/inmarket/viewerId");
    const { captionsForVideo } = await import("../../../../lib/inmarket/captions");
    vtt = await captionsForVideo(key, (await videoWorkspaceId(key)) || undefined);
  } catch { /* a video with no captions simply plays without them */ }

  if (!vtt) return new Response(null, { status: 204 });
  return new Response(vtt, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;

  let b: any = {};
  try { b = await req.json(); } catch { /* empty body handled below */ }
  const clipId = String(b?.clipId || "").trim();
  if (!clipId) return fail("missing_clipId", 422);

  const { transcribeClip, setManualCaptions } = await import("../../../../lib/inmarket/captions");

  if (typeof b?.text === "string" && b.text.trim()) {
    const c = await setManualCaptions(clipId, b.text, Number(b?.durationSec) || 60);
    if (!c) return fail("bad_text", 422);
    return ok({ captions: { clipId: c.clipId, text: c.text, source: c.source, at: c.at }, cached: false, charged: false });
  }

  const res = await transcribeClip(clipId, { force: !!b?.force });
  if (res.ok === false) {
    const err = res.error;
    const detail = err === "no_api_key"
      ? "Connect ElevenLabs under Setup first, then try again."
      : err === "clip_not_found"
      ? "That recording is no longer on file."
      : /missing the permission speech_to_text|missing_permissions/i.test(err)
      // The key works but was issued without the transcription scope: an exact, fixable answer
      // beats a raw 401 the operator has to decode.
      ? "Your ElevenLabs key does not have the Speech to Text permission. Open ElevenLabs, edit that API key, tick Speech to Text, save, and try again."
      : /elevenlabs_4\d\d/.test(err)
      ? "ElevenLabs rejected the request. Check the API key under Setup."
      : "Could not transcribe that recording. Try again in a moment.";
    return fail(err, 502, { detail });
  }
  return ok({
    captions: {
      clipId: res.captions.clipId, text: res.captions.text,
      source: res.captions.source, at: res.captions.at, words: res.captions.words.length,
    },
    cached: res.cached,
    // Honest cost reporting: a cached hit is free, and every video on this take reuses it.
    charged: !res.cached,
  });
}
