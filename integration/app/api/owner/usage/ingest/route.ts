/**
 * POST /api/owner/usage/ingest  (OWNER or service key)
 * Append a cost event to the ledger from anywhere: an enrichment job, a send
 * batch, an AI call, or an external provider invoice. Authenticated by an owner
 * session OR a Bearer USAGE_INGEST_KEY (so background workers can report spend).
 *
 * Body:
 *   { workspaceId, motion?, category?, type, source?, quantity?, unitCostUsd?, costUsd?, meta? }
 */

import { ok, fail, body, context } from "../../../../../lib/api";
import { recordUsage, recordExternalSpend } from "../../../../../lib/billing/ledger";
import { isOwnerEmail } from "../../../../../lib/owner";
import type { Motion } from "../../../../../lib/core/types";

function authed(req: Request): boolean {
  const key = process.env.USAGE_INGEST_KEY;
  const h = req.headers.get("authorization") ?? "";
  if (key && h === `Bearer ${key}`) return true;
  const ctx = context(req);
  return Boolean(ctx && isOwnerEmail(ctx.user.email));
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("not_found", 404);
  const b = await body<{
    workspaceId: string; motion?: Motion; category?: any; type?: string; source?: string;
    quantity?: number; unitCostUsd?: number; costUsd?: number; meta?: Record<string, unknown>;
  }>(req);
  if (!b || !b.workspaceId) return fail("workspaceId required", 400);

  // Invoice-style lump spend (no per-unit math).
  if (b.costUsd != null && b.quantity == null && b.unitCostUsd == null) {
    const ev = recordExternalSpend({
      workspaceId: b.workspaceId, motion: b.motion, source: b.source ?? "external",
      costUsd: b.costUsd, type: b.type, meta: b.meta,
    });
    return ok({ recorded: true, event: ev });
  }

  const ev = recordUsage({
    workspaceId: b.workspaceId,
    motion: b.motion ?? "recruiting",
    category: b.category ?? "other",
    type: b.type ?? "usage",
    source: b.source,
    quantity: b.quantity ?? 1,
    unitCostUsd: b.unitCostUsd ?? 0,
    costUsd: b.costUsd,
    meta: b.meta,
  });
  return ok({ recorded: true, event: ev });
}
