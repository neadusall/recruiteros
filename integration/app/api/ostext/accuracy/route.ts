import { requireSession, ok, fail } from "../../../../lib/api";
import { resolveOstextTarget } from "../../../../lib/ostextImport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ostext/accuracy
 *
 * The phone-accuracy scoreboard: proxies the workspace's OS Text engine
 * (/api/phone-accuracy) so Outbound Performance can show, per phone source
 * (Boost skip trace, KoldInfo, Laxis, in-house DB, finder), how the numbers
 * actually performed: Telnyx cell-check pass rate, delivery rate, reply rate,
 * and the wrong-number rate from AI-classified replies. Workspace isolation
 * comes free from resolveOstextTarget (own engine when connected, house
 * engine only when entitled).
 */

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const target = await resolveOstextTarget(g.ctx.workspace.id).catch(() => null);
  if (!target) return fail("ostext_not_connected", 503);

  let res: Response;
  try {
    res = await fetch(target.base + "/api/phone-accuracy", {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fail("ostext_unreachable", 502);
  }
  let data: { sources?: unknown; trend?: unknown } = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) return fail("ostext_accuracy_failed", 502);
  return ok({
    sources: Array.isArray(data.sources) ? data.sources : [],
    trend: Array.isArray(data.trend) ? data.trend : [],
  });
}
