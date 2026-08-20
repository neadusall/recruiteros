/**
 * POST /api/phone-intel/classify-phones
 * Line-check a batch of the pipeline's numbers (Telnyx line-type + business CNAM)
 * and persist each verdict onto the prospect, so the reachability monitor fills in
 * and only ACTUAL business lines ever become droppable. Cached verdicts are skipped
 * (never re-pays). Costs ~$0.0065/number checked.
 *
 * Body: { motion?, limit?, emailedOnly? (default true), workspaceId? (cron only) }
 * Auth: an admin session (telnyx:manage) OR the cron secret (x-cron-secret /
 * ?secret=) with an explicit workspaceId, so it can be run server-side.
 */

import { ok, fail, body, requireCapability } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { classifyPipelinePhones } from "../../../../lib/phoneintel";

export const dynamic = "force-dynamic";

function cronOk(req: Request): boolean {
  const secret = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
  const expected = process.env.RECRUITEROS_CRON_SECRET;
  return Boolean(expected) && secret === expected;
}

export async function POST(req: Request) {
  const b = await body<{ motion?: Motion; limit?: number; emailedOnly?: boolean; workspaceId?: string }>(req);

  let workspaceId: string;
  if (cronOk(req)) {
    if (!b?.workspaceId) return fail("missing_workspace", 422, { detail: "workspaceId required for cron-triggered runs" });
    workspaceId = b.workspaceId;
  } else {
    const g = requireCapability(req, "telnyx:manage");
    if ("response" in g) return g.response;
    workspaceId = g.ctx.workspace.id;
  }

  const motion: Motion | undefined = b?.motion === "bd" ? "bd" : b?.motion === "recruiting" ? "recruiting" : undefined;
  try {
    const result = await classifyPipelinePhones(workspaceId, {
      motion,
      limit: Number.isFinite(b?.limit) ? Math.max(1, Math.floor(b!.limit!)) : undefined,
      emailedOnly: b?.emailedOnly,
    });
    return ok({ result });
  } catch (e: any) {
    return fail("classify_failed", 502, { detail: String(e?.message ?? e).slice(0, 200) });
  }
}
