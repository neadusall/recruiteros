/**
 * GET /api/phone/calls/[id]/recording
 * Auth-gated audio playback for a call recording.
 *
 * Telnyx download URLs are short-lived, so the browser never gets one
 * directly: this proxies the audio through the session-checked API (fetching
 * a fresh URL from the Recordings API when the cached one has expired) and
 * streams it with Range support disabled but full-body playback fine for
 * the in-record player.
 */

import { requireCapability, fail } from "../../../../../../lib/api";
import { getCall, ensurePhoneReady } from "../../../../../../lib/phone/store";
import { refreshRecordingUrl } from "../../../../../../lib/phone/calls";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const call = getCall(g.ctx.workspace.id, params.id);
  if (!call) return fail("not_found", 404);
  if (!call.recording.recordingId && !call.recording.url) return fail("no_recording", 404);

  let url = "";
  try {
    url = await refreshRecordingUrl(call);
  } catch {
    url = call.recording.url ?? "";
  }
  if (!url) return fail("recording_unavailable", 404);

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) return fail("recording_fetch_failed", 502);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "private, max-age=300",
    },
  });
}
