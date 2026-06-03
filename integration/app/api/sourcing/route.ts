/**
 * GET  /api/sourcing                 -> this workspace's saved sourcing runs (JD Sourcing tab)
 * POST /api/sourcing
 *   { action: "plan", jd }                         -> JD → ICP + generated searches (no discovery)
 *   { action: "run", jd, name?, cap?, minFit? }    -> plan + discovery → ranked candidates (not yet saved)
 *   { action: "save", id?, name, jd, icp, queries, candidates } -> stage a named run
 *   { action: "promote", id, minFit? }             -> push a saved run into Candidates under its name
 *   { action: "enrich", id, top? }                 -> enrich contacts for the top N staged candidates
 *   { action: "delete", id }                       -> remove a saved run
 *
 * Discovery-only until promote; contact lookup is on demand. Session-gated.
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  planSourcing, parseJobDescription, generateQueries, runDiscovery,
  listSourcingRuns, saveSourcingRun, deleteSourcingRun, getSourcingRun, promoteSourcingRun,
} from "../../../lib/sourcing";
import { enrich, cheapFirstContactWaterfall } from "../../../lib/signals";
import { nowIso } from "../../../lib/core/ids";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ runs: listSourcingRuns(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = b?.action ?? "plan";

  try {
    if (action === "plan") {
      if (!b?.jd) return fail("missing_jd", 422);
      return ok(await planSourcing(b.jd));
    }

    if (action === "run") {
      if (!b?.jd) return fail("missing_jd", 422);
      const icp = await parseJobDescription(b.jd);
      const queries = generateQueries(icp);
      const result = await runDiscovery(queries, icp, {
        cap: typeof b.cap === "number" ? b.cap : 3000,
        minFit: typeof b.minFit === "number" ? b.minFit : 45,
      });
      return ok({ icp, queries, ...result });
    }

    if (action === "save") {
      if (!b?.name || !b?.icp) return fail("missing_fields", 422, { detail: "name and icp required" });
      const run = saveSourcingRun(ws, {
        id: b.id, name: b.name, jd: b.jd ?? "", jdUrl: b.jdUrl,
        icp: b.icp, queries: b.queries ?? [], candidates: b.candidates ?? [],
        warnings: b.warnings ?? [],
        motion: b.motion === "bd" ? "bd" : "recruiting",
      });
      return ok({ run });
    }

    if (action === "promote") {
      if (!b?.id) return fail("missing_id", 422);
      return ok(await promoteSourcingRun(ws, b.id, { minFit: b.minFit, campaignId: b.campaignId }));
    }

    if (action === "enrich") {
      if (!b?.id) return fail("missing_id", 422);
      const run = getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const top = Math.max(1, Math.min(b.top ?? 50, run.candidates.length));
      const plan = cheapFirstContactWaterfall();
      let enriched = 0;
      for (const c of run.candidates.slice(0, top)) {
        if (c.email) continue;
        const [first, ...rest] = (c.fullName || "").trim().split(/\s+/);
        try {
          const report = await enrich(plan, {
            name: c.company, companyName: c.company, fullName: c.fullName,
            firstName: first, lastName: rest.join(" "), linkedinUrl: c.linkedinUrl, title: c.title,
          }, { now: nowIso() });
          const e = report.subject.email; const ph = report.subject.phone;
          if (typeof e === "string") { c.email = e; enriched++; }
          if (typeof ph === "string") c.phone = ph;
        } catch { /* leave unresolved */ }
      }
      saveSourcingRun(ws, { ...run });
      return ok({ enriched, run });
    }

    if (action === "delete") {
      if (!b?.id) return fail("missing_id", 422);
      return ok({ ok: deleteSourcingRun(ws, b.id) });
    }

    return fail("unknown_action", 422);
  } catch (e: any) {
    return fail(e?.message ?? "sourcing_failed", e?.status ?? 400);
  }
}
