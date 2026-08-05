/**
 * Recording ingest for the self-hosted meet server (cron-secret guarded).
 *
 * POST /api/meet/recording?room=<room>&mime=audio/ogg  (raw audio body)
 *   Called by the recorder's finalize hook after every call: it converts the
 *   recording to compact audio and ships it here. The 5-minute automation
 *   tick then transcribes, summarizes, and emails the booking mailbox.
 */

import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { saveRecording } from "../../../../lib/meet/recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const room = (url.searchParams.get("room") || "").trim();
  const mime = (url.searchParams.get("mime") || "audio/ogg").trim().slice(0, 40);
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    const rec = await saveRecording(room, mime, buf);
    return Response.json({ ok: true, id: rec.id, matched: !!rec.workspaceId });
  } catch (e) {
    const err = e as Error & { status?: number };
    return Response.json({ ok: false, error: err.message || "ingest_failed" }, { status: err.status && err.status >= 400 ? err.status : 500 });
  }
}
