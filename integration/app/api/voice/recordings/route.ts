/**
 * Voice Drops · Pre-recorded pitch library
 *   GET    /api/voice/recordings        -> your recordings (admins: whole workspace)
 *   POST   /api/voice/recordings        -> save one { name, audio(base64), mime, durationSec?, identifiesAttested? }
 *   PATCH  /api/voice/recordings        -> update { id, name? | identifiesAttested? | durationSec? }
 *   DELETE /api/voice/recordings?id=    -> remove the record + its audio file
 *
 * A recording is the operator's OWN voice pitch, dropped onto voicemails after a
 * personalized cloned-voice intro (campaign messageMode "recording"). PERSONAL
 * artifact rules apply (CLAUDE.md rule 2): every record is owner-stamped and
 * plain members only ever see / touch their own; workspace owner and admin keep
 * the full-workspace view. Audio bytes live in the voice cache volume and are
 * served to Telnyx via the existing public /api/voice/audio/{file} route
 * (opaque rec_* names only, no listing).
 *
 * Session-gated on voice:dial. Uploads are mp3 or wav, capped at 10 MB.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import { isWorkspaceAdmin, requesterEmail } from "../../../../lib/inmarket/ownership";
import { rid } from "../../../../lib/core/ids";
import {
  listRecordings, getRecording, addRecording, updateRecording, deleteRecording,
  canUseRecording, saveRecordingAudio, deleteRecordingAudio, audioUrl,
  type VoiceRecording,
} from "../../../../lib/voice";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB of decoded audio

function publicShape(rec: VoiceRecording) {
  return { ...rec, url: audioUrl(rec.file) };
}

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const rows = listRecordings(g.ctx.workspace.id, requesterEmail(g.ctx), isWorkspaceAdmin(g.ctx));
  return ok({ recordings: rows.map(publicShape) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const b = await body<any>(req);
  const name = (b?.name || "").trim();
  const mime = b?.mime === "audio/wav" ? "audio/wav" : b?.mime === "audio/mpeg" ? "audio/mpeg" : null;
  const b64 = typeof b?.audio === "string" ? b.audio : "";
  if (!name) return fail("missing_fields", 422, { detail: "name is required" });
  if (!mime) return fail("bad_mime", 422, { detail: "audio must be mp3 (audio/mpeg) or wav (audio/wav)" });
  if (!b64) return fail("missing_fields", 422, { detail: "audio (base64) is required" });

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
  } catch {
    return fail("bad_audio", 422, { detail: "audio is not valid base64" });
  }
  if (!bytes.length) return fail("bad_audio", 422, { detail: "audio is empty" });
  if (bytes.length > MAX_BYTES) return fail("too_large", 413, { detail: "keep recordings under 10 MB (about 10 minutes of mp3)" });

  const id = rid("vrec");
  const file = await saveRecordingAudio(id, bytes, mime === "audio/wav" ? "wav" : "mp3");
  const rec = addRecording({
    id,
    workspaceId: g.ctx.workspace.id,
    ownerEmail: requesterEmail(g.ctx),
    name,
    file,
    mime,
    bytes: bytes.length,
    durationSec: Number.isFinite(b?.durationSec) ? Math.max(0, Math.round(b.durationSec)) : undefined,
    identifiesAttested: !!b?.identifiesAttested,
    createdBy: g.ctx.user.email,
  });
  return ok({ recording: publicShape(rec) });
}

export async function PATCH(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const b = await body<any>(req);
  if (!b?.id) return fail("missing_id", 422);
  const rec = getRecording(g.ctx.workspace.id, b.id);
  if (!rec) return fail("not_found", 404);
  if (!canUseRecording(rec, requesterEmail(g.ctx), isWorkspaceAdmin(g.ctx))) return fail("forbidden", 403);
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.identifiesAttested === "boolean") patch.identifiesAttested = b.identifiesAttested;
  if (Number.isFinite(b.durationSec)) patch.durationSec = Math.max(0, Math.round(b.durationSec));
  const updated = updateRecording(g.ctx.workspace.id, b.id, patch);
  return ok({ recording: updated ? publicShape(updated) : null });
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  const rec = getRecording(g.ctx.workspace.id, id);
  if (!rec) return ok({ ok: false });
  if (!canUseRecording(rec, requesterEmail(g.ctx), isWorkspaceAdmin(g.ctx))) return fail("forbidden", 403);
  const removed = deleteRecording(g.ctx.workspace.id, id);
  if (removed) await deleteRecordingAudio(removed.file);
  return ok({ ok: !!removed });
}
