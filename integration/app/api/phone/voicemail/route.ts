/**
 * /api/phone/voicemail
 *   POST { action: "save",   lineId, audio (base64 WAV), durationSec? }
 *   POST { action: "remove", lineId }
 *
 * A recruiter's voicemail greeting for one of THEIR lines (admins may manage
 * any line). The browser records the mic, encodes a compact mono WAV, and
 * ships it here; unanswered inbound calls then play it and take a message
 * (see lib/phone/calls.ts). Replacing or removing a greeting deletes the old
 * audio file.
 */

import { requireCapability, ok, fail, body } from "../../../../lib/api";
import { getLine, patchLine, ensurePhoneReady } from "../../../../lib/phone/store";
import {
  writeGreeting, deleteGreeting, looksLikeWav,
  MAX_GREETING_BYTES, MAX_GREETING_SECONDS,
} from "../../../../lib/phone/voicemail";
import { nowIso } from "../../../../lib/core/ids";

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const ws = g.ctx.workspace.id;
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");
  const b = await body<any>(req);
  if (!b?.action) return fail("missing_action", 400);

  const line = getLine(ws, String(b.lineId ?? ""));
  if (!line) return fail("line_not_found", 404);
  if (!isAdmin && !line.assignedUserIds.includes(g.ctx.user.id)) {
    return fail("line_not_assigned", 403);
  }

  switch (String(b.action)) {
    case "save": {
      const b64 = typeof b.audio === "string" ? b.audio.replace(/^data:[^,]*,/, "") : "";
      if (!b64) return fail("missing_audio", 400);
      let wav: Buffer;
      try {
        wav = Buffer.from(b64, "base64");
      } catch {
        return fail("invalid_audio", 400);
      }
      if (!looksLikeWav(wav)) return fail("invalid_audio: expected a WAV recording", 400);
      if (wav.length > MAX_GREETING_BYTES) return fail("audio_too_large", 413);
      const durationSec = Math.max(0, Math.min(MAX_GREETING_SECONDS, Math.round(Number(b.durationSec) || 0)));

      const old = line.voicemail?.file;
      const file = await writeGreeting(line.id, wav);
      const updated = patchLine(ws, line.id, {
        voicemail: {
          file,
          durationSec: durationSec || undefined,
          recordedAt: nowIso(),
          recordedBy: g.ctx.user.id,
          recordedByName: g.ctx.user.name || g.ctx.user.email,
        },
      });
      if (old) await deleteGreeting(old);
      return ok({ line: updated });
    }

    case "remove": {
      const old = line.voicemail?.file;
      const updated = patchLine(ws, line.id, { voicemail: undefined });
      if (old) await deleteGreeting(old);
      return ok({ line: updated });
    }

    default:
      return fail("unknown_action", 400);
  }
}
