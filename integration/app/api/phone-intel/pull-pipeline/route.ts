/**
 * POST /api/phone-intel/pull-pipeline
 * Pull emailed prospects from the pipeline into the Phone Intel queue as role
 * voicemails: for each prospect that was EMAILED and has a CORPORATE phone number,
 * assemble a voicemail about the SAME open role we emailed them about (credit-saver
 * splice) and stage it. Nothing dials until an admin starts the queue.
 *
 * Body: { motion?: "bd" | "recruiting", limit?: number }
 * Admin-gated (telnyx:manage) — it stages real calls.
 */

import { requireCapability, ok, fail, body } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { pullRoleVoicemailsFromPipeline } from "../../../../lib/phoneintel";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  const b = await body<{ motion?: Motion; limit?: number }>(req);
  const motion: Motion | undefined = b?.motion === "bd" ? "bd" : b?.motion === "recruiting" ? "recruiting" : undefined;
  try {
    const summary = await pullRoleVoicemailsFromPipeline(g.ctx.workspace.id, {
      motion,
      limit: Number.isFinite(b?.limit) ? Math.max(1, Math.floor(b!.limit!)) : undefined,
    });
    return ok({ summary });
  } catch (e: any) {
    return fail("pull_failed", 502, { detail: String(e?.message ?? e).slice(0, 200) });
  }
}
