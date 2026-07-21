import { requireCapability, ok, fail } from "../../../../lib/api";
import { resolveOstextTarget } from "../../../../lib/ostextImport";
import { supplyRollup } from "../../../../lib/sourcing/ostextKpi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ostext/kpi?days=30
 *
 * The admin "OS Text Performance" tab's single data call: pairs the JD
 * Sourcing supply side (lists, enrichment fill rates by rung, Boost spend,
 * push parity) with the OS Text engine's send-and-response side (Telnyx cell
 * checks, deliveries, replies, classifications, spend) over one shared
 * window. Admin-gated: this is a workspace-wide command view, not a
 * per-recruiter one.
 */

export async function GET(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 30) || 30));

  const supplyP = supplyRollup(ws, days).catch(() => null);

  let engine: Record<string, unknown> | null = null;
  let accuracy: { sources: unknown[]; trend: unknown[] } = { sources: [], trend: [] };
  let engineError: string | null = null;
  const target = await resolveOstextTarget(ws).catch(() => null);
  if (!target) {
    engineError = "ostext_not_connected";
  } else {
    const headers = { authorization: `Bearer ${target.token}` };
    const [kpiRes, accRes] = await Promise.all([
      fetch(target.base + "/api/kpi-stats?days=" + days, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null),
      fetch(target.base + "/api/phone-accuracy", { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null),
    ]);
    if (kpiRes?.ok) {
      try { engine = (await kpiRes.json()) as Record<string, unknown>; } catch { engineError = "ostext_kpi_failed"; }
    } else {
      // A 404 means the workspace's own engine predates /api/kpi-stats.
      engineError = kpiRes ? (kpiRes.status === 404 ? "ostext_engine_outdated" : "ostext_kpi_failed") : "ostext_unreachable";
    }
    if (accRes?.ok) {
      try {
        const data = (await accRes.json()) as { sources?: unknown; trend?: unknown };
        accuracy = {
          sources: Array.isArray(data.sources) ? data.sources : [],
          trend: Array.isArray(data.trend) ? data.trend : [],
        };
      } catch { /* accuracy is additive; the tab still renders without it */ }
    }
  }

  const supply = await supplyP;
  if (!supply && !engine) return fail(engineError || "kpi_unavailable", 502);
  return ok({ days, supply, engine, accuracy, engineError });
}
