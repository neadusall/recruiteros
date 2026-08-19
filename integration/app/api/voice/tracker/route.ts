/**
 * GET /api/voice/tracker?motion=
 * The outbound voicemail tracker: every lead across this workspace's Voice Drops
 * campaigns with what happened on the call and the recommended next step, plus
 * rollup totals and the reusable voice-clip archive (so the operator sees the
 * credit-saving library grow). Read-only, session-gated on voice:dial.
 */

import { ok, requireCapability } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { voiceTracker, voiceArchiveStats } from "../../../../lib/voice";

function asMotion(v: unknown): Motion | undefined {
  return v === "bd" ? "bd" : v === "recruiting" ? "recruiting" : undefined;
}

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const motion = asMotion(new URL(req.url).searchParams.get("motion"));
  const tracker = voiceTracker(g.ctx.workspace.id, motion);
  const archive = await voiceArchiveStats();
  return ok({ ...tracker, archive });
}
