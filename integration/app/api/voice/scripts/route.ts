/**
 * Voice Drops · Reusable script library API
 *   GET    /api/voice/scripts?motion=  -> reusable voicemail scripts (voice assets)
 *   PUT    /api/voice/scripts           -> create/update a script
 *   DELETE /api/voice/scripts?id=       -> remove a script
 *
 * These surface in the Campaign Sequences Library as reusable voice assets and
 * can be dropped into a Campaign Studio "Voice drop" step. Session-gated.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import {
  listScripts, upsertScript, deleteScript, renderScript, checkScript, segmentScript,
  DEFAULT_PERSONA, type VoiceScript,
} from "../../../../lib/voice";

function asMotion(v: unknown): Motion | undefined {
  return v === "bd" ? "bd" : v === "recruiting" ? "recruiting" : undefined;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const motion = asMotion(new URL(req.url).searchParams.get("motion"));
  // Attach a preview (rendered sample + duration estimate) so the Library can
  // show the operator roughly how long each drop runs.
  const scripts = listScripts(g.ctx.workspace.id, motion).map((s) => {
    const rendered = renderScript(s.template, { firstName: "there", role: "leader" }, DEFAULT_PERSONA);
    const chk = checkScript(rendered, DEFAULT_PERSONA);
    return { ...s, preview: rendered, estSeconds: chk.seconds, withinSweetSpot: chk.withinSweetSpot };
  });
  return ok({ scripts });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<Partial<VoiceScript>>(req);
  if (!b?.name || !b?.template) return fail("missing_fields", 422);
  const script = upsertScript(g.ctx.workspace.id, { name: b.name, template: b.template, motion: b.motion, voiceId: b.voiceId, id: b.id });
  // Surface the segment breakdown so the operator sees what will be cached/reused.
  const segments = segmentScript(script.template, { firstName: "there", role: "leader" }, DEFAULT_PERSONA);
  return ok({ script, segments: segments.map((s) => ({ kind: s.kind, key: s.key })) });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  return ok({ ok: deleteScript(g.ctx.workspace.id, id) });
}
