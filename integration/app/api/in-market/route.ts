/**
 * In-Market Leads (Business Development).
 *
 * GET  /api/in-market                 -> recently promoted in-market prospects (quick recap)
 * POST /api/in-market
 *   { query, industries?, geos?, companyName?, titles?, headcountBands?, limit? }
 *       -> search the market for companies actively hiring (free sources, ranked)
 *   { action: "promote", campaignId, lead, manager? }
 *       -> create a Prospect (the hiring manager, paired to the company) on the campaign
 *
 * BD motion only; the engine searches company-side hiring-intent signals.
 */

import { searchInMarket, promoteLead, companyKey, type InMarketLead, type HiringManagerLead } from "../../../lib/inmarket";
import { getCore } from "../../../lib/core/repository";
import { requireSession, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const all = await getCore().listProspects(g.ctx.workspace.id);
  const promoted = all.filter((p) => p.category === "in_market").slice(0, 50);
  // Daily import read for the Hire Signals banner; also kick the accumulator so the
  // pool fills even before the first search. Best-effort.
  let stats: unknown;
  try {
    const { ensureAccumulator } = await import("../../../lib/inmarket/accumulator");
    const { poolStats } = await import("../../../lib/inmarket/pool");
    ensureAccumulator();
    stats = await poolStats();
  } catch { /* ignore */ }
  return ok({ promoted, stats });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Cost estimate for pushing N selected people (shown in the approve/cancel gate).
  if (b?.action === "estimate") {
    const { estimatePushCost } = await import("../../../lib/inmarket/launch");
    const count = Number(b.count) || (Array.isArray(b.leads) ? b.leads.length : 0);
    return ok({ estimate: estimatePushCost(count, { directDial: b.directDial === true }) });
  }

  // Dive into ONE company's own public ATS board → every open role they're hiring for
  // (no aggregator API), with a hiring manager mapped to each. On-demand (deep-dive button).
  if (b?.action === "company_roles") {
    const company = String(b.company ?? "").trim();
    if (!company) return fail("missing_company", 422);
    try {
      const { resolveCompanyRoles } = await import("../../../lib/inmarket/companyRoles");
      const { hiringManagersFor } = await import("../../../lib/inmarket");
      const r = await resolveCompanyRoles(company, b.domain ? String(b.domain) : undefined);
      const roleTitles = r.roles.map((x) => x.title);
      const roleDates: Record<string, string> = {};
      const roleUrls: Record<string, string> = {};
      for (const x of r.roles) {
        const k = (x.title || "").trim().toLowerCase();
        if (x.postedAt) roleDates[k] = x.postedAt;
        if (x.url) roleUrls[k] = x.url;
      }
      const hiringManagers = hiringManagersFor(roleTitles, undefined, roleDates, 30, roleUrls);
      return ok({ roles: roleTitles, detail: r.roles, hiringManagers, source: r.source, total: roleTitles.length });
    } catch (e: any) {
      return fail(e?.message ?? "company_roles_failed", e?.status ?? 400);
    }
  }

  // Kick the omnichannel orchestrator (n8n) right after an approved batch is promoted.
  if (b?.action === "launch_outreach") {
    const { kickOutreach } = await import("../../../lib/inmarket/launch");
    const result = await kickOutreach({ workspaceId: ws, campaignId: b.campaignId, count: Number(b.count) || 0 });
    return ok({ launch: result });
  }

  if (b?.action === "promote") {
    if (!b.campaignId || !b.lead) return fail("missing_fields", 422, { detail: "campaignId and lead required" });
    try {
      const prospect = await promoteLead(
        ws,
        b.campaignId,
        b.lead as InMarketLead,
        b.manager as HiringManagerLead | undefined,
        { findDirectDial: b.findDirectDial === true },
      );
      return ok({ prospect }, 201);
    } catch (e: any) {
      return fail(e.message ?? "promote_failed", e.status ?? 400);
    }
  }

  // AI decision-maker inference for one company (on demand, uses ANTHROPIC_API_KEY).
  if (b?.action === "refine_managers") {
    const lead = (b.lead ?? {}) as Partial<InMarketLead>;
    try {
      const { aiHiringManagers } = await import("../../../lib/inmarket/aiManagers");
      const hiringManagers = await aiHiringManagers({
        company: lead.company ?? "",
        industry: lead.industry,
        headcountBand: lead.headcountBand,
        roles: lead.roles ?? [],
      });
      if (!hiringManagers) return fail("ai_unavailable", 409, { detail: "set ANTHROPIC_API_KEY (or no roles)" });
      return ok({ hiringManagers });
    } catch (e: any) {
      return fail(e?.message ?? "refine_failed", e?.status ?? 400);
    }
  }

  // ---- Curation: the daily decision-maker list (the database of prospects to market to) ----

  // The real numbers: funnel counts by stage, sliced by hiring signal + function. Bundles the
  // engine heartbeat so the UI can show "pool fed / curated N ago" and flag a stalled engine.
  if (b?.action === "curation_funnel") {
    const { curationFunnel } = await import("../../../lib/inmarket/curation");
    const { engineHealth } = await import("../../../lib/inmarket/accumulator");
    const { searchHealth, hydrateSearchHealth } = await import("../../../lib/inmarket/searchHealth");
    const { fleetStatus } = await import("../../../lib/inmarket/fleet");
    const { commonCrawlHealth } = await import("../../../lib/inmarket/commonCrawl");
    await hydrateSearchHealth().catch(() => undefined); // load persisted status right after a restart
    const [funnel, health] = await Promise.all([curationFunnel(), engineHealth()]);
    // `search` = sustainability of the free name-scraping; `fleet` = the distributed worker boxes;
    // `cc` = THIS (main) box's Common Crawl index-governor health — so the engine pill shows the main
    // server's own per-IP source health, turning the box you already have into the proving ground.
    return ok({ funnel, health, search: searchHealth(), fleet: fleetStatus(), cc: commonCrawlHealth() });
  }

  // Standalone liveness probe for the lead engine (last cycle / last curation tick + errors),
  // plus egress-IP rotation status and the auto-enroll autopilot's daily progress.
  if (b?.action === "engine_health") {
    const { engineHealth } = await import("../../../lib/inmarket/accumulator");
    const { egressEnabled, egressIps } = await import("../../../lib/net/egress");
    const { autoEnrollStatus } = await import("../../../lib/inmarket/autoEnroll");
    const { reoonStatus } = await import("../../../lib/inmarket/reoon");
    const { autoCaptureStatus } = await import("../../../lib/inmarket/autoCapture");
    const { autoVideoStatus } = await import("../../../lib/inmarket/autoVideo");
    const [health, autoEnroll, reoon, autoCapture, autoVideo] = await Promise.all([engineHealth(), autoEnrollStatus(), reoonStatus(), autoCaptureStatus(), autoVideoStatus()]);
    return ok({ health, egress: { enabled: egressEnabled(), ips: egressIps() }, autoEnroll, reoon, autoCapture, autoVideo });
  }

  // Composed-video map (company -> finished outreach video) so the Clients tab can show videos.
  if (b?.action === "autovideo_map") {
    const { autoVideoMapByCompany } = await import("../../../lib/inmarket/autoVideo");
    return ok({ videos: await autoVideoMapByCompany() });
  }

  // ADMIN: complete engine read for the "Engine / Throughput" panel — funnel + every source's
  // health + the EFFECTIVE value of every throughput dial (so the operator sees exactly what each
  // knob is set to and what to raise) + host headroom (disk/cpu/mem). Read-only; spends nothing.
  if (b?.action === "engine_admin") {
    const { curationFunnel } = await import("../../../lib/inmarket/curation");
    const { engineHealth } = await import("../../../lib/inmarket/accumulator");
    const { searchHealth, hydrateSearchHealth } = await import("../../../lib/inmarket/searchHealth");
    const { commonCrawlHealth } = await import("../../../lib/inmarket/commonCrawl");
    const { reoonStatus } = await import("../../../lib/inmarket/reoon");
    const { egressEnabled, egressIps } = await import("../../../lib/net/egress");
    const { autoEnrollStatus } = await import("../../../lib/inmarket/autoEnroll");
    await hydrateSearchHealth().catch(() => undefined);
    const [funnel, health, reoon, autoEnroll] = await Promise.all([
      curationFunnel(), engineHealth(), reoonStatus(), autoEnrollStatus(),
    ]);

    // The effective value of each dial = the env override if set, else the engine's coded default.
    // `crit` flags the throughput-critical knobs the panel highlights; `rec` is the suggested raise.
    const num = (k: string, d: number) => Number(process.env[k]) || d;
    const on = (k: string, dflt = false) => {
      const v = (process.env[k] || "").toLowerCase();
      return v ? ["1", "true", "yes", "on"].includes(v) : dflt;
    };
    const dials = [
      { group: "Sourcing", key: "INMARKET_INFLOW_INTERVAL_SEC", value: num("INMARKET_INFLOW_INTERVAL_SEC", 180), unit: "sec/tick" },
      { group: "Sourcing", key: "RAPID_JOBS_AUTOPILOT", value: on("RAPID_JOBS_AUTOPILOT") ? "on" : "off", note: process.env.RAPID_JOBS_KEY ? "key set" : "no key — paid feed off" },
      { group: "Domain", key: "INMARKET_DOMAIN_BATCH", value: num("INMARKET_DOMAIN_BATCH", 500), unit: "/cycle" },
      { group: "Domain", key: "INMARKET_DOMAIN_CONCURRENCY", value: num("INMARKET_DOMAIN_CONCURRENCY", 16) },
      { group: "Curation", key: "INMARKET_CURATE_INTERVAL_SEC", value: num("INMARKET_CURATE_INTERVAL_SEC", 240), unit: "sec/tick", crit: true, rec: "120 (2× ticks/day)" },
      { group: "Curation", key: "INMARKET_CURATE_BATCH", value: num("INMARKET_CURATE_BATCH", 300), unit: "/tick" },
      { group: "Curation", key: "INMARKET_CURATE_CONCURRENCY", value: num("INMARKET_CURATE_CONCURRENCY", 16) },
      { group: "Curation", key: "INMARKET_CURATE_MIN_SCORE", value: num("INMARKET_CURATE_MIN_SCORE", 10) },
      { group: "Verify (free)", key: "INMARKET_VERIFY_BATCH", value: num("INMARKET_VERIFY_BATCH", 800), unit: "/tick" },
      { group: "Reoon", key: "REOON_API_KEY", value: process.env.REOON_API_KEY ? "set" : "MISSING", crit: true },
      { group: "Reoon", key: "REOON_FIND_BATCH", value: num("REOON_FIND_BATCH", 20), unit: "people/tick", crit: true, rec: "100–300 (the main verified-growth lever)" },
      { group: "Reoon", key: "REOON_VERIFY_BATCH", value: num("REOON_VERIFY_BATCH", 30), unit: "/tick", crit: true, rec: "200–800" },
      { group: "Reoon", key: "REOON_MAX_CANDIDATES", value: num("REOON_MAX_CANDIDATES", 6), unit: "credits/person" },
      { group: "Reoon", key: "REOON_ACCEPT_CATCHALL", value: on("REOON_ACCEPT_CATCHALL", true) ? "on" : "off" },
      { group: "Egress", key: "INMARKET_EGRESS_IPS", value: egressEnabled() ? egressIps().filter((x) => x !== "default").length + " IPs rotating" : "off" },
      { group: "Screenshots", key: "INMARKET_SHOT_BATCH", value: num("INMARKET_SHOT_BATCH", 4), unit: "/tick" },
      { group: "Screenshots", key: "INMARKET_SHOT_CONCURRENCY", value: num("INMARKET_SHOT_CONCURRENCY", 1) },
      { group: "Auto-enroll", key: "INMARKET_AUTOENROLL", value: autoEnroll?.enabled ? "on" : "off" },
    ];

    // Host headroom — disk (the file-snapshot store can fill the box), cpu, memory.
    let system: Record<string, unknown> = {};
    try {
      const os = await import("os");
      const fsp = await import("fs/promises");
      let disk: Record<string, number> | undefined;
      try {
        const s = await (fsp as unknown as { statfs?: (p: string) => Promise<{ blocks: number; bavail: number; bsize: number }> }).statfs?.(process.env.ROS_DATA_DIR || "/");
        if (s) {
          const totalGB = (s.blocks * s.bsize) / 1e9;
          const freeGB = (s.bavail * s.bsize) / 1e9;
          disk = { totalGB: Math.round(totalGB * 10) / 10, freeGB: Math.round(freeGB * 10) / 10, usedPct: Math.round((1 - freeGB / totalGB) * 100) };
        }
      } catch { /* statfs unavailable */ }
      system = {
        cpus: os.cpus().length,
        loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        memTotalGB: Math.round((os.totalmem() / 1e9) * 10) / 10,
        memFreeGB: Math.round((os.freemem() / 1e9) * 10) / 10,
        disk,
      };
    } catch { /* os/fs unavailable */ }

    return ok({ funnel, health, reoon, autoEnroll, search: searchHealth(), cc: commonCrawlHealth(), dials, system });
  }

  // The list itself, for review (filterable; contactableOnly = has a real person + email).
  if (b?.action === "curation_list") {
    const { listCurated } = await import("../../../lib/inmarket/curation");
    const list = await listCurated({
      status: b.status, signalType: b.signalType, function: b.function,
      industry: b.industry ? String(b.industry) : undefined,
      contactableOnly: b.contactableOnly === true, namedOnly: b.namedOnly === true,
      validatedOnly: b.validatedOnly === true, limit: b.limit,
    });
    return ok({ curated: list });
  }

  // Distinct industries present on the curated/enriched list (with contactable + validated counts),
  // for the Hire Signals "search enriched by industry" dropdown.
  if (b?.action === "curation_industries") {
    const { curatedIndustries } = await import("../../../lib/inmarket/curation");
    return ok({ industries: await curatedIndustries() });
  }

  // Review gate, step 1: approve a batch (contactable → queued).
  if (b?.action === "curation_approve") {
    const { approveForBulk } = await import("../../../lib/inmarket/curation");
    const n = await approveForBulk(Array.isArray(b.ids) ? b.ids : []);
    return ok({ approved: n });
  }

  // Review gate, step 2: enroll the approved batch into the BD Bulk MPC sender.
  if (b?.action === "curation_enroll") {
    if (!b.campaignId) return fail("missing_campaign", 422, { detail: "campaignId required" });
    const { enrollToBulk } = await import("../../../lib/inmarket/curation");
    const res = await enrollToBulk(ws, String(b.campaignId), Array.isArray(b.ids) ? b.ids : [], new Date().toISOString());
    return ok(res);
  }

  // Continuous email validation — the external validator pulls the pending list, then streams
  // verdicts back. Invalid addresses are suppressed (never enrolled); valid ones are confirmed.
  if (b?.action === "validation_pending") {
    const { pendingValidationEmails } = await import("../../../lib/inmarket/curation");
    return ok({ emails: await pendingValidationEmails(Math.min(Number(b.limit) || 1000, 5000)) });
  }
  if (b?.action === "validation_results") {
    const { applyEmailValidation } = await import("../../../lib/inmarket/curation");
    const results = Array.isArray(b.results) ? b.results : [];
    const n = await applyEmailValidation(results, new Date().toISOString());
    return ok({ updated: n });
  }

  // INDUSTRY-TARGETED JOB SCRAPE (JSearch): pull fresh hiring companies for ONE chosen industry
  // right now and merge them into the pool (each carries employer_website → the domain for free).
  // This is the "pick an industry, scrape it" control — the background accumulator also rotates
  // industries continuously, but this lets the user target one on demand.
  if (b?.action === "jobfeed_search") {
    const { runJobFeedSourcing, jobFeedEnabled } = await import("../../../lib/inmarket/jobFeed");
    if (!jobFeedEnabled()) return fail("jobfeed_not_configured", 409, { detail: "Set RAPID_JOBS_HOST + RAPID_JOBS_KEY (JSearch on RapidAPI) to enable industry job scraping." });
    const query = String(b.industry || b.query || "").trim();
    if (!query) return fail("missing_industry", 422, { detail: "industry (or query) required" });
    const limit = Math.min(Math.max(Number(b.limit) || 100, 10), 500);
    const scraped = await runJobFeedSourcing({ query, location: b.location ? String(b.location) : undefined, limit });
    return ok({ scraped, industry: query });
  }

  // ---- TARGETED JSEARCH SEARCH QUEUE: author exact searches → queue → run (preview) → pick (commit).
  //      This is the user-controlled alternative to the random JSearch rotation (which is now off by
  //      default). You decide EXACTLY what to scrape and which results actually enter the pool. ----

  // List every saved targeted search (with its last-run status/result).
  if (b?.action === "queue_list") {
    const { listSearches } = await import("../../../lib/inmarket/searchQueue");
    return ok({ searches: await listSearches() });
  }
  // Create or update a targeted search (pass `search.id` to update). Persisted; nothing scrapes here.
  if (b?.action === "queue_save") {
    const { saveSearch } = await import("../../../lib/inmarket/searchQueue");
    try { return ok({ search: await saveSearch((b.search || {}) as Record<string, unknown>) }); }
    catch (e: any) { return fail(e?.message ?? "save_failed", e?.status ?? 422); }
  }
  // Delete a targeted search.
  if (b?.action === "queue_delete") {
    const { deleteSearch } = await import("../../../lib/inmarket/searchQueue");
    return ok({ deleted: await deleteSearch(String(b.id ?? "")) });
  }
  // RUN a targeted search = PREVIEW only: fetch via JSearch with the saved params and return the
  // companies found WITHOUT merging. The user reviews them, then commits the ones they want. Stamps
  // the run onto the saved search so the queue shows "ran · N companies".
  if (b?.action === "queue_run") {
    const { previewJobFeed, jobFeedEnabled } = await import("../../../lib/inmarket/jobFeed");
    if (!jobFeedEnabled()) return fail("jobfeed_not_configured", 409, { detail: "Set RAPID_JOBS_HOST + RAPID_JOBS_KEY (JSearch on RapidAPI) to run targeted searches." });
    const { getSearch, markRun, markError } = await import("../../../lib/inmarket/searchQueue");
    // Accept either a saved id or an ad-hoc search object (run-without-saving).
    const s = b.id ? await getSearch(String(b.id)) : (b.search as Record<string, unknown> | undefined);
    if (!s) return fail("search_not_found", 404);
    const opts = {
      query: String((s as any).query ?? "").trim(),
      location: (s as any).location ? String((s as any).location) : undefined,
      datePosted: (s as any).datePosted ? String((s as any).datePosted) : undefined,
      employmentTypes: Array.isArray((s as any).employmentTypes) ? (s as any).employmentTypes : undefined,
      remoteOnly: (s as any).remoteOnly === true,
      limit: Math.min(Math.max(Number((s as any).limit) || 100, 10), 500),
    };
    if (!opts.query) return fail("missing_query", 422, { detail: "query (role/keywords) required" });
    try {
      const { leads } = await previewJobFeed(opts);
      // SUPPRESS ALREADY-EMAILED: drop companies/roles we've already sent >= N (default 2) emails to,
      // BUT keep a company that comes back with a different job title (a fresh hiring signal).
      const { filterAlreadyEmailed } = await import("../../../lib/inmarket/outreachFilter");
      const f = await filterAlreadyEmailed(ws, leads);
      // POOL MEMBERSHIP: flag which companies are ALREADY pulled (in the pool) vs. NET-NEW, and split
      // the position counts, so the preview can show "X pulled / Y new" and let the user scrape only
      // the fresh ones ("pull a fresh list").
      const { poolCompanyKeySet } = await import("../../../lib/inmarket/pool");
      const inPool = await poolCompanyKeySet();
      const posOf = (l: InMarketLead) => (l.roleDetails?.length || l.roles?.length || 1);
      const annotated = f.leads.map((l) => ({ ...l, inPool: inPool.has(companyKey(l.company || "")) }));
      const companies = annotated.length;
      const jobs = annotated.reduce((s, l) => s + posOf(l), 0);
      const newCompanies = annotated.filter((l) => !l.inPool).length;
      const newPositions = annotated.filter((l) => !l.inPool).reduce((s, l) => s + posOf(l), 0);
      if (b.id) await markRun(String(b.id), { companies, jobs });
      return ok({
        leads: annotated, companies, jobs,
        newCompanies, pulledCompanies: companies - newCompanies,
        newPositions, pulledPositions: jobs - newPositions,
        suppressedCompanies: f.suppressedCompanies, suppressedRoles: f.suppressedRoles, suppressThreshold: f.threshold,
      });
    } catch (e: any) {
      if (b.id) await markError(String(b.id), e?.message ?? "run_failed");
      return fail(e?.message ?? "run_failed", e?.status ?? 400);
    }
  }
  // COMMIT = the "pick" step: merge ONLY the companies the user selected from a run into the pool.
  if (b?.action === "queue_commit") {
    const leads = Array.isArray(b.leads) ? (b.leads as InMarketLead[]) : [];
    if (!leads.length) return fail("no_leads", 422, { detail: "select at least one company to scrape" });
    const { mergeIntoPool } = await import("../../../lib/inmarket/pool");
    await mergeIntoPool(leads);
    if (b.id) {
      const { markCommitted } = await import("../../../lib/inmarket/searchQueue");
      await markCommitted(String(b.id), leads.length);
    }
    return ok({ merged: leads.length });
  }

  // On-demand curation run (the accumulator also does this hourly): research the top companies'
  // decision-makers now and refresh the list.
  if (b?.action === "curate_now") {
    const { queryPool } = await import("../../../lib/inmarket/pool");
    const { curateFromPool } = await import("../../../lib/inmarket/curation");
    const n = Math.min(Number(b.limit) || 60, 300);
    const top = await queryPool({ limit: n } as any, n);
    const report = await curateFromPool(
      top.map((l: any) => ({ company: l.company, domain: l.domain, industry: l.industry, signalType: l.signalType, reason: l.reason, score: l.score, employeeCount: l.employeeCount, roleDetails: l.roleDetails, roles: l.roles, sourceUrl: l.sourceUrl })),
      { limit: n, concurrency: 4, minScore: Number(b.minScore) || 0, nowIso: new Date().toISOString() },
    );
    return ok({ report });
  }

  // Default: a market search.
  const result = await searchInMarket(
    {
      query: b?.query,
      industries: b?.industries,
      geos: b?.geos,
      companyName: b?.companyName,
      roleQuery: b?.roleQuery,
      titles: b?.titles,
      signalTypes: b?.signalTypes,
      headcountBands: b?.headcountBands,
      postedWithinDays: b?.postedWithinDays,
      addedWithinDays: b?.addedWithinDays,
      confirmedSizeOnly: b?.confirmedSizeOnly,
      limit: b?.limit,
    },
    new Date().toISOString(),
    ws,
  );
  return ok(result);
}
