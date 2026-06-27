/**
 * Send Queue — the rolling-buffer readiness dashboard.
 *
 * GET /api/send-queue -> { overview } : send-ready supply, runway, per-day projection (firsts +
 *   next-day video seconds), the needs-assets breakdown, and per-campaign readiness. Read-only;
 *   the heavy lifting (enrollment, sending) stays in the cadence/autopilot engine.
 */

import { sendQueueOverview } from "../../../lib/sending/sendReady";
import { requireSession, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  try {
    const overview = await sendQueueOverview(g.ctx.workspace.id, new Date().toISOString());
    return ok({ overview });
  } catch (e: any) {
    return fail(e?.message ?? "send_queue_failed", e?.status ?? 500);
  }
}
