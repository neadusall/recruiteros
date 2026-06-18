/**
 * GET  /api/sourcing                 -> this workspace's saved sourcing runs (JD Sourcing tab)
 * POST /api/sourcing
 *   { action: "plan", jd }                         -> JD → ICP + generated searches (no discovery)
 *   { action: "refine", jd, icp, instruction }     -> LLM edits the ICP per a NL instruction → new searches
 *   { action: "run", jd, name?, cap?, minFit? }    -> plan + discovery → ranked candidates (not yet saved)
 *   { action: "save", id?, name, jd, icp, queries, candidates } -> stage a named run
 *   { action: "promote", id, minFit? }             -> push a saved run into Candidates under its name
 *   { action: "enrich", id, top? }                 -> enrich contacts for the top N staged candidates
 *   { action: "vet", id, top? }                    -> deep-vet the top N: read full profile vs JD, verified score
 *   { action: "delete", id }                       -> remove a saved run
 *
 * Discovery-only until promote; contact lookup and deep-vet are on demand. Session-gated.
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  planSourcing, parseJobDescription, generateQueries, runDiscovery,
  listSourcingRuns, saveSourcingRun, deleteSourcingRun, getSourcingRun, promoteSourcingRun,
  fetchFullProfile, profileFetchConfigured, deepVetCandidate, refineIcp, draftJobDescription,
} from "../../../lib/sourcing";
import { enrich, cheapFirstContactWaterfall } from "../../../lib/signals";
import { nowIso } from "../../../lib/core/ids";
import { dbEnabled } from "../../../lib/db";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  // `durable` tells the UI whether saved runs survive a restart. If it's ever false the tab
  // should warn loudly rather than let the user save into volatile memory and lose it silently.
  return ok({ runs: await listSourcingRuns(g.ctx.workspace.id), durable: dbEnabled() });
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

    if (action === "draft") {
      if (!b?.title && !b?.base) return fail("missing_input", 422, { detail: "title or base required" });
      const jd = await draftJobDescription({ title: b.title, company: b.company, companyUrl: b.companyUrl, notes: b.notes, base: b.base });
      return ok({ jd });
    }

    if (action === "refine") {
      if (!b?.icp || !b?.instruction) return fail("missing_fields", 422, { detail: "icp and instruction required" });
      const { icp, changes } = await refineIcp(b.jd ?? "", b.icp, b.instruction);
      return ok({ icp, queries: generateQueries(icp), changes });
    }

    if (action === "run") {
      if (!b?.jd) return fail("missing_jd", 422);
      const icp = await parseJobDescription(b.jd);
      const queries = generateQueries(icp);
      const result = await runDiscovery(queries, icp, {
        cap: typeof b.cap === "number" ? b.cap : 500,
        minFit: typeof b.minFit === "number" ? b.minFit : 10,
      });
      return ok({ icp, queries, ...result });
    }

    if (action === "save") {
      if (!b?.name || !b?.icp) return fail("missing_fields", 422, { detail: "name and icp required" });
      const run = await saveSourcingRun(ws, {
        id: b.id, name: b.name, jd: b.jd ?? "", jdUrl: b.jdUrl, location: b.location,
        icp: b.icp, queries: b.queries ?? [], candidates: b.candidates ?? [],
        warnings: b.warnings ?? [],
        motion: b.motion === "bd" ? "bd" : "recruiting",
      });
      return ok({ run });
    }

    if (action === "promote") {
      if (!b?.id) return fail("missing_id", 422);
      return ok(await promoteSourcingRun(ws, b.id, { minFit: b.minFit, campaignId: b.campaignId, listName: b.listName, tag: b.tag }));
    }

    if (action === "enrich") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const top = Math.max(1, Math.min(b.top ?? 50, run.candidates.length));
      // Include the phone rung — otherwise report.subject.phone below is always undefined.
      // (Mobile direct-dial stays cap-gated separately; this is the cheap business-phone find.)
      const plan = cheapFirstContactWaterfall({ includePhone: true });
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
      await saveSourcingRun(ws, { ...run });
      return ok({ enriched, run });
    }

    if (action === "vet") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const top = Math.max(1, Math.min(b.top ?? 25, 200, run.candidates.length));
      const haveProfiles = profileFetchConfigured();
      const warnings: string[] = [];
      let vetted = 0;
      // Vet the top slice by current (rule) score. The full candidate objects are
      // mutated in place, then the run is re-ranked by verified score.
      const slice = [...run.candidates].sort((a, c) => c.fitScore - a.fitScore).slice(0, top);
      for (const c of slice) {
        let profile;
        if (haveProfiles && c.linkedinUrl) {
          try { profile = await fetchFullProfile(c.linkedinUrl); }
          catch (err) { warnings.push(`profile(${c.fullName}): ${(err as Error).message}`); }
        }
        try {
          const v = await deepVetCandidate(c, run.icp, profile);
          c.verifiedScore = v.verifiedScore; c.verdict = v.verdict;
          c.yearsRelevant = v.yearsRelevant; c.vetStrengths = v.strengths;
          c.vetGaps = v.gaps; c.vetFlags = v.flags; c.vetRationale = v.rationale;
          c.profileFetched = Boolean(profile && profile.experiences.length);
          vetted++;
        } catch (err) { warnings.push(`vet(${c.fullName}): ${(err as Error).message}`); }
      }
      // Re-rank: verified candidates first (by verifiedScore), then the rest by fit.
      run.candidates.sort((a, c) =>
        (c.verifiedScore ?? -1) - (a.verifiedScore ?? -1) || c.fitScore - a.fitScore);
      if (!haveProfiles) warnings.push("profile_fetch_not_configured: set RAPIDAPI_PROFILE_HOST + RAPIDAPI_PROFILE_PATH to vet against full work history (vetted on surface fields only)");
      await saveSourcingRun(ws, { ...run });
      return ok({ vetted, deep: haveProfiles, warnings, run });
    }

    if (action === "delete") {
      if (!b?.id) return fail("missing_id", 422);
      return ok({ ok: await deleteSourcingRun(ws, b.id) });
    }

    return fail("unknown_action", 422);
  } catch (e: any) {
    return fail(e?.message ?? "sourcing_failed", e?.status ?? 400);
  }
}
