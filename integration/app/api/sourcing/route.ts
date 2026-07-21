/**
 * GET  /api/sourcing                 -> this workspace's saved sourcing runs (JD Sourcing tab)
 * POST /api/sourcing
 *   { action: "plan", jd, breadth? }               -> JD → ICP + generated searches (no discovery)
 *   { action: "engines" }                          -> which discovery sources are active (UI "Search power" readout)
 *   { action: "refine", jd, icp, instruction }     -> LLM edits the ICP per a NL instruction → new searches
 *   { action: "run", jd, name?, cap?, minFit?, breadth? } -> plan + discovery → ranked candidates (not yet saved)
 *   { action: "save", id?, name, jd, icp, queries, candidates } -> stage a named run
 *   { action: "promote", id, minFit? }             -> push a saved run into Candidates under its name
 *   { action: "enrich", id, top? }                 -> enrich contacts for the top N staged candidates
 *   { action: "premiumPhoneQuote", id }            -> price the paid phone boost: rows still missing a phone, est cost from the rolling hit rate
 *   { action: "premiumPhoneRun", id, max? }        -> RECRUITER-TRIGGERED paid phone rung (skip-trace listing) over the next `max` phone-less rows; ledger-attributed to the caller
 *   { action: "premiumPhoneQueue", id, max }       -> queue the approved boost on the overnight queue: runs server-side, one boost at a time, free chain finished first if the list is not fully enriched
 *   { action: "vet", id, top? }                    -> deep-vet the top N: submits a 50%-cheaper Message Batch (sync fallback)
 *   { action: "vetStatus", id }                    -> poll the in-flight vet batch; ingests results once it ends
 *   { action: "koldinfoExport", id, top? }         -> FIRST rung (free): CSV of candidates still missing an email, for KoldInfo
 *   { action: "koldinfoImport", id, csv }          -> merge KoldInfo's result CSV back onto the run (fills blank emails)
 *   { action: "koldinfoEnrich", id }               -> AUTOMATED first rung: browser worker runs KoldInfo itself (submits a job)
 *   { action: "koldinfoStatus", id }               -> poll the KoldInfo job; auto-merges found emails + phones when done
 *   { action: "laxisEnrich", id, top? }            -> SECOND pass: enrich via the Laxis browser worker (submits a job)
 *   { action: "laxisStatus", id, gapFill? }        -> poll the Laxis job; merges the enriched CSV + runs the gap-fill waterfall
 *   { action: "ostext", id, name?, validate? }     -> push the run's phone-holding candidates into an OS Text SMS campaign
 *   { action: "merge", ids, name?, deleteSources? } -> combine 2+ saved runs into one deduped list (fills blanks, keeps best row)
 *   { action: "salesNav", url, name?, targetRunId?, limit?, expand?, breadth? } -> pull a pasted Sales Navigator search + waterfall expansion into a new or existing list (deduped)
 *   { action: "delete", id }                       -> remove a saved run
 *
 * Discovery-only until promote; contact lookup and deep-vet are on demand. Session-gated.
 */

import { body, ok, fail, requireCapability } from "../../../lib/api";
import {
  planSourcing, pinIcpLocation, parseJobDescription, generateQueries, runDiscovery, parseRadiusMi,
  googleSearchConfigured, searxSearchConfigured, serperSearchConfigured, rapidApiSearchConfigured,
  listSourcingRuns, saveSourcingRun, deleteSourcingRun, getSourcingRun, promoteSourcingRun,
  profileFetchConfigured, deepVetCandidate, refineIcp, draftJobDescription,
  vetBatchAvailable, submitVetBatch, retrieveVetBatch, collectVetBatch,
  fetchFullProfileCached, getCachedContact, putCachedContact,
  reRankCandidates, getSeenKeys, addSeenKeys,
  laxisWorkerConfigured, koldinfoWorkerReady, serializeCandidatesCsv, submitLaxisJob, getLaxisJob, mergeEnrichedCsv,
  MAX_LAXIS_UPLOAD,
  buildSourcingKoldInfoCsv, mergeSourcingKoldInfoCsv, buildKoldInfoDbCsv,
  startBulkList, stepBulkList, bulkListStatus,
  startCompanyFirst, stepCompanyFirst, companyFirstStatus,
  mergeSourcingRuns, getRapidQuota, runSalesNavSourcing, searchKindOf,
  gapFillContacts, listNightItems, addNightItem, removeNightItem,
  landlineDbReady,
  premiumPhoneQuote, runPremiumPhoneBoost,
} from "../../../lib/sourcing";
import type { CandidateRow, SearchBreadth, VetBatchItem, SourcingRun } from "../../../lib/sourcing";
import { sendRunNow } from "../../../lib/sourcing/autoflow";
import { pickSameRoleMaster } from "../../../lib/sourcing/sameRole";
import { enrich, cheapFirstContactWaterfall } from "../../../lib/signals";
import { withWorkspaceCreds } from "../../../lib/connected";
import { cred } from "../../../lib/providers/http";
import { nowIso } from "../../../lib/core/ids";
import { dbEnabled } from "../../../lib/db";
import { ostextImport, ostextStarterTemplate, type OsTextContact } from "../../../lib/ostextImport";

/** Stable per-candidate key: LinkedIn URL when present, else name+company. Used to
 *  re-attach a batch result to the right candidate even after the list is re-sorted. */
function candKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

/** The UI's search-breadth dial, defaulting to balanced on anything unexpected. */
function parseBreadth(v: unknown): SearchBreadth {
  return v === "focused" || v === "wide" ? v : "balanced";
}


/**
 * Chunks are laid out on a fixed grid of `step`-sized offsets (0, step, 2·step, …). Return
 * the first grid offset below `total` that is NOT already enriched, or null if every chunk
 * is done. Deterministic + done-aware, so resuming a multi-batch Laxis pull always advances
 * to a fresh chunk and can never loop on one that already came back.
 */
function nextLaxisOffset(doneOffsets: number[], total: number, step: number): number | null {
  if (step <= 0) return null;
  for (let o = 0; o < total; o += step) if (!doneOffsets.includes(o)) return o;
  return null;
}


/** Apply a parsed verdict onto a candidate row (shared by sync + batch ingest).
 *  profileFetched is stamped by the caller (it knows whether a real profile was read). */
function applyVerdict(c: CandidateRow, v: {
  verifiedScore: number; verdict: CandidateRow["verdict"]; yearsRelevant?: number;
  strengths: string[]; gaps: string[]; flags: string[]; rationale: string;
}): void {
  c.verifiedScore = v.verifiedScore; c.verdict = v.verdict;
  c.yearsRelevant = v.yearsRelevant; c.vetStrengths = v.strengths;
  c.vetGaps = v.gaps; c.vetFlags = v.flags; c.vetRationale = v.rationale;
}

/** Verified-first ranking: vetted candidates by verified score, then the rest by fit. */
function rankByVerdict(rows: CandidateRow[]): void {
  rows.sort((a, c) => (c.verifiedScore ?? -1) - (a.verifiedScore ?? -1) || c.fitScore - a.fitScore);
}

/**
 * The cheap-first contact waterfall over the top N rows that are still missing an email.
 * Cache-first (a contact resolved for this person in any run is reused free), then the
 * paid waterfall. Mutates the rows in place; the CALLER persists the run. Shared by the
 * `enrich` action and the Laxis gap-fill (Laxis runs first, this fills what it left blank).
 */
// The waterfall itself lives in lib/sourcing/gapfill.ts (shared with the overnight queue).

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  // Job Library self-heal: lists pushed before the library existed pair their
  // contacts retroactively, once per process. Fire-and-forget.
  try {
    const { backfillPromotedRunPairings } = await import("../../../lib/sourcing/jdpair");
    void backfillPromotedRunPairings(g.ctx.workspace.id);
  } catch { /* never blocks the tab */ }
  // `durable` tells the UI whether saved runs survive a restart. If it's ever false the tab
  // should warn loudly rather than let the user save into volatile memory and lose it silently.
  // apiQuota: the paid people-search/profile subscriptions' latest credit readings
  // (captured from RapidAPI's response headers; fills in after the first search).
  // "people" only: the job-feed (JSearch) subscription has its own meter in Hire Signals.
  return ok({
    runs: await listSourcingRuns(g.ctx.workspace.id),
    durable: dbEnabled(),
    apiQuota: await getRapidQuota("people"),
    // The overnight queue (newest last), so the tab can show what is cooking.
    nightQueue: await listNightItems(g.ctx.workspace.id),
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = b?.action ?? "plan";
  // The signed-in recruiter, stamped onto every run THEY create so the background
  // auto-send credits its OS Text campaign (owner chip + "this is <name>" starter
  // text) to the person who ran the search, not the workspace owner.
  const actor = { userId: g.ctx.user.id, name: g.ctx.user.name || "", email: g.ctx.user.email || "" };

  try {
    if (action === "plan") {
      if (!b?.jd) return fail("missing_jd", 422);
      return ok(await planSourcing(b.jd, b.location, parseBreadth(b.breadth), b.radiusMi as number));
    }

    /* Which discovery sources will actually run right now — the UI's "Search power"
     * readout, so a recruiter can SEE a missing key instead of finding out from a
     * thin run. MUST run inside withWorkspaceCreds: keys pasted in Setup live in the
     * workspace store, and cred() only sees that store inside this wrapper — without
     * it the readout (and the run below) silently ignored every Setup-pasted key. */
    if (action === "engines") {
      return ok(await withWorkspaceCreds(ws, async () => ({
        engines: {
          database: await koldinfoWorkerReady(),
          wideWeb: serperSearchConfigured(),
          freeWeb: googleSearchConfigured() || searxSearchConfigured(),
          peopleApi: rapidApiSearchConfigured(),
        },
        // Phone-source readout: which of the phone rungs can actually fire right now.
        // Same honesty rule as the search pills: a recruiter should see a dead phone
        // source here, not discover it from a list with 0 phones.
        phoneSources: {
          vendorEnrich: laxisWorkerConfigured(), // KoldInfo + Laxis ride the same worker
          inHouseDb: await landlineDbReady(),
          paidFinder: Boolean(cred("RAPIDAPI_KEY") && cred("RAPIDAPI_PHONE_HOST") && cred("RAPIDAPI_PHONE_PATH")),
        },
      })));
    }

    if (action === "draft") {
      if (!b?.title && !b?.base) return fail("missing_input", 422, { detail: "title or base required" });
      const jd = await draftJobDescription({ title: b.title, company: b.company, companyUrl: b.companyUrl, notes: b.notes, base: b.base });
      return ok({ jd });
    }

    if (action === "refine") {
      if (!b?.icp || !b?.instruction) return fail("missing_fields", 422, { detail: "icp and instruction required" });
      const { icp, changes } = await refineIcp(b.jd ?? "", b.icp, b.instruction);
      // Refine is prompted to "expand vague geography into concrete metros", so re-pin the
      // typed location over its geos. Without this the previewed profile and queries show a
      // wider area than the run will actually search (the run re-pins at `action: "run"`),
      // which reads as the radius being ignored even when the results are correct.
      const refineRadius = parseRadiusMi(b.radiusMi, b.location);
      const pinned = pinIcpLocation(icp, b.location, refineRadius);
      return ok({
        icp: pinned,
        queries: generateQueries(pinned, { breadth: parseBreadth(b.breadth), radiusMi: refineRadius }),
        changes,
      });
    }

    if (action === "run") {
      if (!b?.jd) return fail("missing_jd", 422);
      // A typed hiring location is ground truth: it pins the ICP's geos (the LLM parse
      // otherwise drifts to a national metro list) and turns on the strict-location drop.
      // A client-supplied ICP (a Dive-deeper refinement) wins over re-parsing the JD,
      // so refined searches actually run on the refined profile.
      const clientIcp = b.icp && typeof b.icp === "object" && Array.isArray(b.icp.titles) ? b.icp : undefined;
      // The radius the recruiter picked, as a NUMBER. The UI also bakes it into the
      // location label ("Fair Lawn, NJ +25mi"), so fall back to reading it back out of
      // there for older clients / re-runs of saved lists that only stored the label.
      const radiusMi = parseRadiusMi(b.radiusMi, b.location);
      const icp = pinIcpLocation(clientIcp ?? (await parseJobDescription(b.jd)), b.location, radiusMi);
      // Breadth drives the query FAN-OUT here (how many title-chunk × geo searches
      // run) and the per-query paging depth inside runDiscovery.
      const breadth = parseBreadth(b.breadth);
      const queries = generateQueries(icp, { breadth, radiusMi });
      // Cross-run "seen" memory: fresh-only excludes anyone surfaced in prior runs.
      const excludeKeys = b.freshOnly === true ? await getSeenKeys(ws) : undefined;
      // withWorkspaceCreds: the engines read their keys via cred(), which only sees
      // Setup-pasted (workspace-store) keys inside this wrapper. Without it a Serper/
      // RapidAPI key saved in Setup was invisible to the actual search (env-only).
      const result = await withWorkspaceCreds(ws, () => runDiscovery(queries, icp, {
        cap: typeof b.cap === "number" ? b.cap : 500,
        minFit: typeof b.minFit === "number" ? b.minFit : 10,
        breadth,
        excludeKeys,
        strictGeo: b.strictGeo !== false && Boolean(((b.location as string) || "").trim()),
        // OPT-IN: the separate out-of-area list only when the recruiter asked for it,
        // so a geo'd run stays geo-only (and credit-safe) by default.
        keepOutOfArea: b.outsideGeo === true,
        radiusMi,
        geoCenter: (b.location as string) || "",
      }));
      // Remember who we surfaced so a later fresh-only run skips them.
      await addSeenKeys(ws, result.candidates.map(candKey));
      return ok({ icp, queries, ...result, freshOnly: b.freshOnly === true });
    }

    /* --- Sales Navigator search mode -------------------------------------
     * Paste a Sales Navigator (or LinkedIn people-search) URL: its members are
     * pulled through the connected LinkedIn seat, the URL's own filters become
     * the ICP, and the standard discovery waterfall expands the pool. The result
     * lands in a NAMED list: an explicit targetRunId, or a name matching an
     * existing list (either search type), merges into that list with the same
     * dedupe as Combine lists: blanks filled both ways, never a duplicate row
     * and never a duplicate list. A fresh name creates a new list. */
    if (action === "salesNav") {
      const url = typeof b?.url === "string" ? b.url.trim() : "";
      if (!url) return fail("missing_url", 422, { detail: "paste a LinkedIn Sales Navigator, Recruiter, or people-search URL" });
      const result = await withWorkspaceCreds(ws, () => runSalesNavSourcing(ws, g.ctx.user.id, {
        url,
        limit: typeof b.limit === "number" ? b.limit : undefined,
        expand: b.expand !== false,
        breadth: parseBreadth(b.breadth),
        cap: typeof b.cap === "number" ? b.cap : undefined,
        minFit: typeof b.minFit === "number" ? b.minFit : undefined,
      }));
      if (!result.candidates.length) {
        return fail("empty_salesnav_run", 422, {
          detail: "nothing came back: the LinkedIn pull found no members and the waterfall had no usable filters to run on. " +
            (result.warnings[0] || "check the URL and that LinkedIn/Unipile is connected under Setup"),
          warnings: result.warnings,
        });
      }

      // Resolve the destination list: explicit pick > case-insensitive name match
      // (so re-using a name can never spawn a duplicate list) > brand-new list.
      const existing = await listSourcingRuns(ws);
      const typedName = typeof b.name === "string" ? b.name.trim() : "";
      let target: SourcingRun | undefined;
      if (typeof b.targetRunId === "string" && b.targetRunId) {
        target = existing.find((r) => r.id === b.targetRunId);
        if (!target) return fail("run_not_found", 404, { detail: b.targetRunId });
      } else if (typedName) {
        target = existing.find((r) => r.name.trim().toLowerCase() === typedName.toLowerCase());
      }

      if (target) {
        // Merge into the existing list via the same regression-tested dedupe the
        // Combine button uses: stronger row wins, blanks filled from the other
        // side, so an under-enriched older list gains contact/identity data
        // without ever gaining a duplicate person.
        const incoming: SourcingRun = {
          id: "salesnav_incoming", workspaceId: ws, name: target.name, motion: target.motion,
          jd: "", jdUrl: url, icp: result.icp, queries: result.queries,
          candidates: result.candidates, warnings: [], createdAt: nowIso(), updatedAt: nowIso(),
        };
        const before = target.candidates.length;
        const { candidates, overlap } = mergeSourcingRuns([target, incoming]);
        target.candidates = candidates;
        const added = candidates.length - before;
        // New people joined a list whose chunk ledger may already read "fully
        // enriched"; left alone, the Laxis + gap-fill rungs would skip every new
        // row forever. Re-open the chain honestly: the KoldInfo rungs only ever
        // target blank-email rows, and the Laxis serializer never re-buys a row
        // holding both an email and a phone, so re-running the chain only spends
        // on rows that genuinely still need data.
        if (added > 0) {
          delete target.laxisProgress;
          delete target.laxisSkipped;
          // Re-arm the autoflow sweeper's one-resume rule for the reopened
          // chain: if the tab driving this merge dies before restarting
          // enrichment, the sweeper may queue a fresh server-side resume (and
          // its top-up rule then pushes whatever new phones it finds on to
          // Candidates + OS Text). A resumedAt left over from a PREVIOUS
          // orphaning would otherwise block that forever.
          if (target.autoflow) delete target.autoflow.resumedAt;
        }
        // A list saved before its ICP could be built adopts the derived one, so
        // scoring/vetting on the merged list has a real profile to work from.
        if (!target.icp?.titles?.length && result.icp.titles.length) target.icp = result.icp;
        if (!target.jdUrl) target.jdUrl = url;
        target.queries = target.queries.concat(result.queries).slice(0, 200);
        const saved = await saveSourcingRun(ws, { ...target });
        await addSeenKeys(ws, result.candidates.map(candKey));
        return ok({
          run: saved, mode: "merged", name: saved.name,
          linkedinFound: result.linkedinFound, expanded: result.expanded,
          added, overlap, total: candidates.length,
          warnings: result.warnings, account: result.account,
        });
      }

      const name = typedName || result.icp.label || `${searchKindOf(url)} search`;
      const saved = await saveSourcingRun(ws, {
        name,
        jd: `Sourced from a pasted ${searchKindOf(url)} search URL.\nURL: ${url}\n` +
          `Titles: ${result.icp.titles.join(", ") || "(from results)"}\n` +
          `Locations: ${result.icp.geos.join(", ") || "(any)"}` +
          (result.icp.mustHave.length ? `\nKeywords: ${result.icp.mustHave.join(", ")}` : ""),
        jdUrl: url,
        location: result.icp.geos[0],
        icp: result.icp, queries: result.queries, candidates: result.candidates,
        warnings: result.warnings, motion: "recruiting",
        createdBy: actor,
        apiUsage: result.apiUsage ? {
          rapidapi: Number(result.apiUsage.rapidapi) || 0,
          serper: Number(result.apiUsage.serper) || 0,
          google: Number(result.apiUsage.google) || 0,
        } : undefined,
      });
      await addSeenKeys(ws, result.candidates.map(candKey));
      return ok({
        run: saved, mode: "created", name: saved.name,
        linkedinFound: result.linkedinFound, expanded: result.expanded,
        added: result.candidates.length, overlap: 0, total: result.candidates.length,
        warnings: result.warnings, account: result.account,
      });
    }

    /* --- Bulk decision-maker list builder (resumable) ---------------------
     * bulkStart: plan the segment matrix + zero progress (target/requireEmail optional)
     * bulkStep:  do a bounded batch of search calls; call repeatedly until done
     * bulkStatus: read progress without doing work */
    if (action === "bulkStart") {
      const job = await startBulkList(ws, {
        target: typeof b.target === "number" ? b.target : undefined,
        requireEmail: b.requireEmail !== false,
        verify: b.verify === true, // default: keep free permutations, validate later
        titles: Array.isArray(b.titles) ? b.titles : undefined,
        geos: Array.isArray(b.geos) ? b.geos : undefined,
        headcountBands: Array.isArray(b.headcountBands) ? b.headcountBands : undefined,
      });
      return ok({ job });
    }

    if (action === "bulkStep") {
      // Same withWorkspaceCreds rule as "run": the step's people-search calls read
      // their keys via cred(), which misses Setup-pasted keys outside this wrapper.
      const r = await withWorkspaceCreds(ws, () => stepBulkList(ws, typeof b.maxRequests === "number" ? b.maxRequests : 6));
      return ok(r);
    }

    if (action === "bulkStatus") {
      return ok({ job: await bulkListStatus(ws) });
    }

    /* --- Company-first builder: in-band companies → their VP/Director people --- */
    if (action === "companyStart") {
      const job = await startCompanyFirst(ws, {
        target: typeof b.target === "number" ? b.target : undefined,
        requireEmail: b.requireEmail !== false,
        titles: Array.isArray(b.titles) ? b.titles : undefined,
        geos: Array.isArray(b.geos) ? b.geos : undefined,
      });
      return ok({ job });
    }

    if (action === "companyStep") {
      const r = await withWorkspaceCreds(ws, () => stepCompanyFirst(ws, typeof b.maxRequests === "number" ? b.maxRequests : 8));
      return ok(r);
    }

    if (action === "companyStatus") {
      return ok({ job: await companyFirstStatus(ws) });
    }

    /* --- Overnight queue: search (or enrich an existing list) unattended ------
     * queueAdd:    {kind:"search", jd, location?, name?, breadth?, outsideGeo?}
     *              {kind:"enrich", id}   -> enrich an existing saved list
     * queueRemove: {id}                  -> drop a queued/finished item
     * The server-side processor (lib/sourcing/nightQueue) advances items on a cron
     * tick, so queued work finishes with no browser tab open. Nothing is promoted
     * or sent automatically; finished lists just appear enriched. */
    if (action === "queueAdd") {
      if (b?.kind === "enrich") {
        if (!b?.id) return fail("missing_id", 422);
        const run = await getSourcingRun(ws, b.id);
        if (!run) return fail("run_not_found", 404);
        const item = await addNightItem(ws, { kind: "enrich", name: run.name, runId: run.id });
        return ok({ item });
      }
      if (!b?.jd) return fail("missing_jd", 422);
      const name = (typeof b.name === "string" && b.name.trim()) ||
        `Overnight search · ${new Date().toLocaleDateString()}`;
      const item = await addNightItem(ws, {
        kind: "search", name, jd: b.jd, location: b.location,
        breadth: parseBreadth(b.breadth), outsideGeo: b.outsideGeo === true,
        createdBy: actor,
      });
      return ok({ item });
    }

    if (action === "queueRemove") {
      if (!b?.id) return fail("missing_id", 422);
      return ok({ removed: await removeNightItem(ws, b.id) });
    }

    if (action === "rerank") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const top = Math.max(1, Math.min(b.top ?? 100, 100, run.candidates.length));
      const { candidates, ranked, warning } = await reRankCandidates(run.candidates, run.icp, top);
      run.candidates = candidates;
      await saveSourcingRun(ws, { ...run });
      return ok({ ranked, warning, run });
    }

    if (action === "save") {
      if (!b?.name || !b?.icp) return fail("missing_fields", 422, { detail: "name and icp required" });
      const run = await saveSourcingRun(ws, {
        id: b.id, name: b.name, jd: b.jd ?? "", jdUrl: b.jdUrl, location: b.location,
        icp: b.icp, queries: b.queries ?? [], candidates: b.candidates ?? [],
        warnings: b.warnings ?? [],
        motion: b.motion === "bd" ? "bd" : "recruiting",
        createdBy: actor,
        // The run's search-API spend, stamped onto the list (sanitized: counts only).
        apiUsage: b.apiUsage && typeof b.apiUsage === "object" ? {
          rapidapi: Number(b.apiUsage.rapidapi) || 0,
          serper: Number(b.apiUsage.serper) || 0,
          google: Number(b.apiUsage.google) || 0,
        } : undefined,
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
      // Include the phone rung — otherwise report.subject.phone is always undefined.
      // (Mobile direct-dial stays cap-gated separately; this is the cheap business-phone find.)
      const top = Math.max(1, Math.min(b.top ?? 50, run.candidates.length));
      const { enriched, phones, cacheHits } = await gapFillContacts(ws, run.candidates.slice(0, top));
      await saveSourcingRun(ws, { ...run });
      return ok({ enriched, phones, cacheHits, run });
    }

    // ---- Premium phone boost: the recruiter-triggered "$0.10 tool" ----
    // NEVER automatic. The UI offers it once the free chain has finished, with an
    // estimate priced from the workspace's own rolling hit rate; the recruiter
    // decides, the spend lands in the billing ledger attributed to that recruiter.
    if (action === "premiumPhoneQuote") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      return ok({ quote: await premiumPhoneQuote(ws, run, g.ctx.user.email || "") });
    }

    if (action === "premiumPhoneRun") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      // Don't buy numbers while the free chain is still (or resumably) mid-flight:
      // it may be about to fill the same rows for nothing.
      if (run.koldJob || run.koldDbJob || run.laxisJob) {
        return fail("enrichment_in_flight", 409, {
          detail: "free enrichment is still running on this list; let it finish (or press Enrich to resume it), then boost what is left",
        });
      }
      const result = await runPremiumPhoneBoost(ws, run, {
        max: b.max,
        actor: { userId: g.ctx.user.id, userEmail: g.ctx.user.email || "" },
      });
      await saveSourcingRun(ws, { ...run });
      return ok({ ...result, run });
    }

    // HANDS-OFF boost: put the approved run on the server-side overnight queue
    // instead of batch-looping from the tab. Presses on several lists line up and
    // run back-to-back (one at a time), a half-enriched list gets the free chain
    // finished first, and closing the tab changes nothing. The recruiter's approval
    // (count + the estimate dialog) already happened client-side; the server still
    // enforces the monthly budget on every batch regardless.
    if (action === "premiumPhoneQueue") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const actorEmail = (g.ctx.user.email || "").trim();
      if (!actorEmail) {
        return fail("no_actor", 422, { detail: "this spend could not be attributed to your account; sign out, sign back in, and try again" });
      }
      const wanted = Math.round(Number(b.max));
      if (!Number.isFinite(wanted) || wanted < 1) return fail("missing_max", 422);
      const queue = await listNightItems(ws);
      const activeBoosts = queue.filter((i) => i.kind === "boost" && i.stage !== "done" && i.stage !== "error");
      // One live boost item per list: a second press on the same list is a no-op
      // (the queued run already covers it), not a second bill.
      const existing = activeBoosts.find((i) => i.runId === run.id);
      if (existing) return ok({ item: existing, alreadyQueued: true, waitingBehind: 0 });
      const item = await addNightItem(ws, {
        kind: "boost", name: run.name, runId: run.id,
        boost: { wanted, actorUserId: g.ctx.user.id, actorEmail },
      });
      return ok({ item, waitingBehind: activeBoosts.length });
    }

    // KoldInfo is the FIRST enrichment rung (free CSV round-trip the operator drives):
    // export the candidates still missing an email, enrich in KoldInfo, import the result.
    // It runs BEFORE Laxis so Laxis credits only go to rows KoldInfo couldn't fill.
    if (action === "koldinfoExport") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const top = Math.max(1, Math.min(b.top ?? run.candidates.length, run.candidates.length));
      const { csv, count, skipped } = buildSourcingKoldInfoCsv(run.candidates.slice(0, top));
      if (!count) return fail("no_rows_to_export", 422, { detail: "every candidate in range already has an email — nothing for KoldInfo to fill" });
      const slug = (run.name || "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
      return ok({ csv, count, skipped, filename: `koldinfo-${slug}.csv` });
    }

    if (action === "koldinfoImport") {
      if (!b?.id) return fail("missing_id", 422);
      if (!b?.csv || typeof b.csv !== "string") return fail("missing_csv", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const merged = mergeSourcingKoldInfoCsv(run.candidates, b.csv);
      if (!merged.parsed) return fail("no_emails_in_csv", 422, { detail: "no email column (by name or content) found in that file — is it KoldInfo's result export?" });
      await saveSourcingRun(ws, { ...run });
      return ok({ ...merged, run });
    }

    // AUTOMATED KoldInfo first rung: same free-emails-first economics as the manual CSV
    // round-trip, but the browser worker drives app.koldinfo.com itself (upload, wait,
    // download): submit here, poll {action:"koldinfoStatus"}, and the result emails are
    // merged automatically. The UI's Auto-enrich chain runs this, then Laxis.
    if (action === "koldinfoEnrich") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      // Already running? Don't double-submit; tell the UI to keep polling.
      if (run.koldJob) {
        return ok({ submitted: true, jobId: run.koldJob.jobId, count: run.koldJob.count, alreadyRunning: true });
      }
      if (!laxisWorkerConfigured() || !(await koldinfoWorkerReady())) {
        return fail("koldinfo_worker_not_configured", 409, {
          detail: "set KOLDINFO_EMAIL and KOLDINFO_PASSWORD in .env.production (the enrichment worker logs into app.koldinfo.com with them), then redeploy the laxis-worker",
        });
      }
      const { csv, count, skipped } = buildSourcingKoldInfoCsv(run.candidates);
      // Nothing missing an email → the free rung has nothing to do; the chain goes to Laxis.
      if (!count) return ok({ submitted: false, nothingMissing: true, skipped });
      const jobId = await submitLaxisJob(csv, "koldinfo");
      run.koldJob = { jobId, submittedAt: nowIso(), count };
      await saveSourcingRun(ws, { ...run });
      return ok({ submitted: true, jobId, count, skipped });
    }

    if (action === "koldinfoStatus") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      if (!run.koldJob) return ok({ done: true, status: "none" });
      const job = await getLaxisJob(run.koldJob.jobId);
      if (job.status === "queued" || job.status === "running") {
        return ok({ done: false, status: job.status, stage: job.stage });
      }
      if (job.status === "error") {
        delete run.koldJob;
        await saveSourcingRun(ws, { ...run });
        return ok({ done: true, status: "error", warnings: [`koldinfo_job_error: ${job.error ?? "unknown"}`], run });
      }
      // Done — merge the found emails onto the candidates (blanks only, vendor-invalid dropped).
      const warnings: string[] = [];
      let merged = { parsed: 0, matched: 0, emails: 0, invalid: 0, unmatched: 0 };
      if (job.enrichedCsv) merged = mergeSourcingKoldInfoCsv(run.candidates, job.enrichedCsv);
      else warnings.push("koldinfo_done_but_no_csv_returned");
      delete run.koldJob;
      await saveSourcingRun(ws, { ...run });
      return ok({ done: true, status: "done", merged, warnings, run });
    }

    // AUTOMATED KoldInfo DB-lookup rung (name + city/state over People DB + Business
    // Email DB). Runs AFTER koldinfoEnrich: it needs no LinkedIn URL, so it reaches the
    // candidates the LinkedIn-URL enrichment could not touch. Same free-first economics
    // (reading the DB grid spends no export credit). Submit here, poll koldinfoDbStatus.
    if (action === "koldinfoDbEnrich") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      if (run.koldDbJob) {
        return ok({ submitted: true, jobId: run.koldDbJob.jobId, count: run.koldDbJob.count, alreadyRunning: true });
      }
      if (!laxisWorkerConfigured() || !(await koldinfoWorkerReady())) {
        return fail("koldinfo_worker_not_configured", 409, {
          detail: "set KOLDINFO_EMAIL and KOLDINFO_PASSWORD in .env.production, then redeploy the laxis-worker",
        });
      }
      const { csv, count, skipped } = buildKoldInfoDbCsv(run.candidates, run.location);
      if (!count) return ok({ submitted: false, nothingMissing: true, skipped });
      const jobId = await submitLaxisJob(csv, "koldinfo-db");
      run.koldDbJob = { jobId, submittedAt: nowIso(), count };
      await saveSourcingRun(ws, { ...run });
      return ok({ submitted: true, jobId, count, skipped });
    }

    if (action === "koldinfoDbStatus") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      if (!run.koldDbJob) return ok({ done: true, status: "none" });
      const job = await getLaxisJob(run.koldDbJob.jobId);
      if (job.status === "queued" || job.status === "running") {
        return ok({ done: false, status: job.status, stage: job.stage });
      }
      if (job.status === "error") {
        delete run.koldDbJob;
        await saveSourcingRun(ws, { ...run });
        return ok({ done: true, status: "error", warnings: [`koldinfo_db_job_error: ${job.error ?? "unknown"}`], run });
      }
      // The DB-lookup result CSV uses the same person_email / person_sanitized_phone /
      // ros_id / status columns, so the format-agnostic merge re-links it unchanged.
      const warnings: string[] = [];
      let merged = { parsed: 0, matched: 0, emails: 0, phones: 0, invalid: 0, unmatched: 0 };
      if (job.enrichedCsv) merged = mergeSourcingKoldInfoCsv(run.candidates, job.enrichedCsv);
      else warnings.push("koldinfo_db_done_but_no_csv_returned");
      delete run.koldDbJob;
      await saveSourcingRun(ws, { ...run });
      return ok({ done: true, status: "done", merged, warnings, run });
    }

    // Laxis is the SECOND enrichment pass (after the free KoldInfo rung). Serialize the
    // staged rows to a CSV and hand it to the browser worker, which uploads it to
    // app.laxis.tech/prospect-search, runs Laxis's enrichment, and returns the enriched
    // CSV. Rows that already have an email AND phone are not sent (no credit spent).
    // Async (a browser job), so this mirrors the deep-vet batch shape: submit here,
    // poll {action:"laxisStatus"}.
    if (action === "laxisEnrich") {
      if (!b?.id) return fail("missing_id", 422);
      if (!laxisWorkerConfigured()) {
        return fail("laxis_worker_not_configured", 409, {
          detail: "set LAXIS_WORKER_URL on the app and LAXIS_EMAIL/LAXIS_PASSWORD on the laxis-worker",
        });
      }
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      // Already running? Don't double-submit — tell the UI to keep polling.
      if (run.laxisJob) {
        return ok({ submitted: true, jobId: run.laxisJob.jobId, count: run.laxisJob.count, alreadyRunning: true });
      }
      // Laxis caps an import at 1,000 contacts. Send at most one 1,000-row chunk per job,
      // starting at `start`. The UI paginates (0, 1000, 2000…), but we also track which
      // offsets are already enriched on the run itself — so a resumed pull (tab closed
      // mid-batch, say) can ask "where do I continue?" and we never re-grab a done chunk.
      // Chunks sit on a fixed 1,000-row grid (Laxis's per-import cap). Resolve the offset:
      // explicit `start` if given, else the first grid offset not yet enriched (resume).
      const step = MAX_LAXIS_UPLOAD;
      const limit = Math.min(b.top ?? MAX_LAXIS_UPLOAD, MAX_LAXIS_UPLOAD);
      const total = run.candidates.length;
      const progress = run.laxisProgress ?? { doneOffsets: [], total, nextStart: 0, updatedAt: nowIso() };
      const laxisCooldownOn = run.laxisDownUntil ? Date.parse(run.laxisDownUntil) > Date.now() : false;
      let resumeStart = nextLaxisOffset(progress.doneOffsets, total, step);
      // A finished chain holding batches that ran WITHOUT Laxis (it was down at the
      // time): pressing Enrich re-opens exactly those offsets so they get their real
      // Laxis pass, now that the worker looks reachable again.
      if (resumeStart === null && b.start == null && run.laxisSkipped?.offsets.length && !laxisCooldownOn) {
        const reopen = new Set(run.laxisSkipped.offsets);
        progress.doneOffsets = progress.doneOffsets.filter((o) => !reopen.has(o));
        delete run.laxisSkipped;
        resumeStart = nextLaxisOffset(progress.doneOffsets, total, step);
        run.laxisProgress = { ...progress, total, nextStart: resumeStart, updatedAt: nowIso() };
      }
      const start = b.start != null ? Math.max(0, Number(b.start) || 0) : (resumeStart ?? 0);
      // Already enriched this chunk (a resume landed on a done offset, or every chunk is
      // done)? Don't re-submit or re-grab — just report the next un-enriched offset.
      if (resumeStart === null || progress.doneOffsets.includes(start)) {
        return ok({ submitted: false, alreadyDone: true, start, nextStart: resumeStart, doneOffsets: progress.doneOffsets });
      }
      // Laxis went down mid-run (login wall, UI drift): while the short cooldown is on,
      // don't feed this chunk to the dead worker. The in-house waterfall still runs, the
      // chunk is marked done so the chain KEEPS MOVING, and the skip is remembered so
      // Enrich can re-run these batches through Laxis once it is back.
      if (laxisCooldownOn) {
        const rows = run.candidates.slice(start, start + limit);
        let gapFill: { enriched: number; phones: number; cacheHits: number } =
          { enriched: 0, phones: 0, cacheHits: 0 };
        try { gapFill = await gapFillContacts(ws, rows); } catch { /* waterfall is best-effort here */ }
        const doneOffsets = Array.from(new Set([...progress.doneOffsets, start])).sort((a, b2) => a - b2);
        const nextStart = nextLaxisOffset(doneOffsets, total, step);
        run.laxisProgress = { doneOffsets, total, nextStart, updatedAt: nowIso() };
        const skipped = run.laxisSkipped ?? { offsets: [], error: "laxis_down_cooldown", at: nowIso() };
        if (!skipped.offsets.includes(start)) skipped.offsets.push(start);
        skipped.at = nowIso();
        run.laxisSkipped = skipped;
        await saveSourcingRun(ws, { ...run });
        return ok({ submitted: false, alreadyDone: true, laxisSkipped: true, gapFill, start, nextStart, doneOffsets });
      }
      const targetRows = run.candidates.slice(start, start + limit);
      if (!targetRows.length) return fail("no_candidates", 422, { detail: `no rows at offset ${start}` });
      // Laxis enriches from linkedin_url; rows with neither a LinkedIn URL nor an email are
      // skipped, and rows already holding both an email and a phone are excluded (complete).
      const { csv, sent, skipped, complete } = serializeCandidatesCsv(targetRows);
      if (!sent) {
        return fail("no_enrichable_rows", 422, {
          detail: complete === targetRows.length
            ? "every candidate in this batch already has an email and phone — nothing for Laxis to add"
            : "no candidates in this batch have a LinkedIn URL or email for Laxis to key off",
        });
      }
      const jobId = await submitLaxisJob(csv);
      run.laxisJob = {
        jobId, submittedAt: nowIso(), count: targetRows.length, start, sent,
        targets: targetRows.map(candKey),
      };
      run.laxisProgress = { ...progress, total, updatedAt: nowIso() };
      await saveSourcingRun(ws, { ...run });
      const remaining = Math.max(0, total - (start + targetRows.length));
      return ok({ submitted: true, jobId, sent, skipped, complete, start, remaining, nextStart: remaining ? start + targetRows.length : null });
    }

    if (action === "laxisStatus") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      if (!run.laxisJob) return ok({ done: true, status: "none", laxis: null });

      const job = await getLaxisJob(run.laxisJob.jobId);
      if (job.status === "queued" || job.status === "running") {
        return ok({ done: false, status: job.status, stage: job.stage });
      }

      const start = run.laxisJob.start ?? 0;
      const count = run.laxisJob.count;
      if (job.status === "error") {
        delete run.laxisJob;
        const errMsg = String(job.error ?? "unknown");
        // A lost job (worker restarted, retention expired) is retryable: the client
        // resubmits this chunk, nothing is marked done.
        if (/job_not_found/i.test(errMsg)) {
          await saveSourcingRun(ws, { ...run });
          return ok({ done: true, status: "error", warnings: [`laxis_job_error: ${errMsg}`], run });
        }
        // Any other worker failure (login wall, UI drift, credentials) must NOT stall
        // the chain: run the in-house waterfall over this chunk, mark its offset done,
        // remember it ran without Laxis, and pause Laxis submits briefly so the rest of
        // the list finishes fast instead of re-hitting a dead login chunk after chunk.
        const warnings = [`laxis_job_error: ${errMsg}`];
        let gapFill: { enriched: number; phones: number; cacheHits: number } =
          { enriched: 0, phones: 0, cacheHits: 0 };
        try { gapFill = await gapFillContacts(ws, run.candidates.slice(start, start + count)); }
        catch (err) { warnings.push(`gap_fill_failed: ${(err as Error).message}`); }
        const total = run.candidates.length;
        const prog = run.laxisProgress ?? { doneOffsets: [], total, nextStart: 0, updatedAt: nowIso() };
        const doneOffsets = Array.from(new Set([...prog.doneOffsets, start])).sort((a, b2) => a - b2);
        const nextStart = nextLaxisOffset(doneOffsets, total, MAX_LAXIS_UPLOAD);
        run.laxisProgress = { doneOffsets, total, nextStart, updatedAt: nowIso() };
        const skipped = run.laxisSkipped ?? { offsets: [], error: errMsg, at: nowIso() };
        if (!skipped.offsets.includes(start)) skipped.offsets.push(start);
        skipped.error = errMsg;
        skipped.at = nowIso();
        run.laxisSkipped = skipped;
        if (/login_failed|credentials_missing|login_form_not_found|step_unresolved/i.test(errMsg)) {
          run.laxisDownUntil = new Date(Date.now() + 30 * 60_000).toISOString();
        }
        await saveSourcingRun(ws, { ...run });
        return ok({ done: true, status: "done", laxis: { matched: 0, emails: 0, phones: 0, unmatched: 0 }, gapFill, warnings, laxisSkipped: true, nextStart, doneOffsets, run });
      }

      // Done — merge Laxis's enriched CSV back onto the rows (by LinkedIn URL → name+company).
      const warnings: string[] = [];
      let laxis = { matched: 0, emails: 0, phones: 0, unmatched: 0 };
      if (job.enrichedCsv) {
        laxis = mergeEnrichedCsv(run.candidates, job.enrichedCsv);
      } else {
        warnings.push("laxis_done_but_no_csv_returned");
      }
      delete run.laxisJob;
      delete run.laxisDownUntil; // a job came back: the worker is reachable again

      // Laxis was the first pass; the cheap in-house waterfall fills whatever it left blank
      // (unless the caller opts out). One seamless flow from the recruiter's side.
      let gapFill: { enriched: number; phones: number; cacheHits: number } =
        { enriched: 0, phones: 0, cacheHits: 0 };
      if (b.gapFill !== false) {
        try { gapFill = await gapFillContacts(ws, run.candidates.slice(start, start + count)); }
        catch (err) { warnings.push(`gap_fill_failed: ${(err as Error).message}`); }
      }
      // Mark this chunk done and advance the resume cursor to the next un-enriched grid
      // offset, so re-running (or auto-continue) never re-grabs a chunk already pulled.
      const prog = run.laxisProgress ?? { doneOffsets: [], total: run.candidates.length, nextStart: 0, updatedAt: nowIso() };
      const total = run.candidates.length;
      const doneOffsets = Array.from(new Set([...prog.doneOffsets, start])).sort((a, b) => a - b);
      const nextStart = nextLaxisOffset(doneOffsets, total, MAX_LAXIS_UPLOAD);
      run.laxisProgress = { doneOffsets, total, nextStart, updatedAt: nowIso() };
      await saveSourcingRun(ws, { ...run });
      return ok({ done: true, status: "done", laxis, gapFill, warnings, nextStart, doneOffsets, run });
    }

    if (action === "vet") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      // Already running? Don't double-submit — tell the UI to keep polling.
      if (run.vetBatch) return ok({ batched: true, batchId: run.vetBatch.batchId, submitted: run.vetBatch.targets.length, deep: run.vetBatch.deep, alreadyRunning: true });

      const top = Math.max(1, Math.min(b.top ?? 25, 200, run.candidates.length));
      const haveProfiles = profileFetchConfigured();
      const warnings: string[] = [];
      // The top slice by current (rule) score. Fetch profiles up front so both the
      // batch and the sync fallback vet against full work history.
      const slice = [...run.candidates].sort((a, c) => c.fitScore - a.fitScore).slice(0, top);
      const items: VetBatchItem[] = [];
      let profileCacheHits = 0;
      for (const c of slice) {
        let profile;
        if (haveProfiles && c.linkedinUrl) {
          // Cache-first: a fresh profile we've already fetched for this person (any
          // run, this workspace) is reused for free instead of a paid lookup.
          try {
            const got = await fetchFullProfileCached(ws, c.linkedinUrl);
            profile = got.profile;
            if (got.cached) profileCacheHits++;
          } catch (err) { warnings.push(`profile(${c.fullName}): ${(err as Error).message}`); }
        }
        c.profileFetched = Boolean(profile && profile.experiences.length);
        items.push({ customId: `vet_${items.length}`, row: c, icp: run.icp, profile });
      }
      if (profileCacheHits) warnings.push(`profile_cache: ${profileCacheHits} of ${items.length} profile(s) served from cache (no paid lookup)`);
      if (!haveProfiles) warnings.push("profile_fetch_not_configured: set RAPIDAPI_PROFILE_HOST + RAPIDAPI_PROFILE_PATH to vet against full work history (vetted on surface fields only)");

      // Preferred path: submit one batch at half the token price, return immediately,
      // and let the UI poll {action:"vetStatus"}. Falls back to inline vetting if the
      // batch can't be submitted, so the feature never hard-depends on it.
      if (vetBatchAvailable() && items.length) {
        try {
          const batchId = await submitVetBatch(items);
          run.vetBatch = {
            batchId, submittedAt: nowIso(), top: items.length, deep: haveProfiles,
            targets: items.map((it) => candKey(it.row)), warnings,
          };
          await saveSourcingRun(ws, { ...run });
          return ok({ batched: true, batchId, submitted: items.length, deep: haveProfiles, profileCacheHits, warnings });
        } catch (err) {
          warnings.push(`batch_submit_failed_falling_back: ${(err as Error).message}`);
        }
      }

      // Synchronous fallback: vet inline (the profiles are already fetched on the items).
      let vetted = 0;
      for (const it of items) {
        try {
          applyVerdict(it.row, await deepVetCandidate(it.row, run.icp, it.profile));
          vetted++;
        } catch (err) { warnings.push(`vet(${it.row.fullName}): ${(err as Error).message}`); }
      }
      rankByVerdict(run.candidates);
      await saveSourcingRun(ws, { ...run });
      return ok({ batched: false, vetted, deep: haveProfiles, profileCacheHits, warnings, run });
    }

    if (action === "vetStatus") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      if (!run.vetBatch) return ok({ done: true, vetted: 0, status: "none" });

      const { status, counts } = await retrieveVetBatch(run.vetBatch.batchId);
      if (status !== "ended") return ok({ done: false, status, counts });

      // Batch finished — ingest results, re-attach by stable key, re-rank, clear the batch.
      const { results, errors } = await collectVetBatch(run.vetBatch.batchId);
      const targets = run.vetBatch.targets;
      const deep = run.vetBatch.deep;
      const byKey = new Map(run.candidates.map((c) => [candKey(c), c]));
      let vetted = 0;
      for (const [customId, v] of Object.entries(results)) {
        const idx = parseInt(customId.replace("vet_", ""), 10);
        const key = targets[idx];
        const c = key ? byKey.get(key) : undefined;
        if (!c) continue;
        applyVerdict(c, v);
        vetted++;
      }
      rankByVerdict(run.candidates);
      const warnings = (run.vetBatch.warnings ?? []).concat(errors);
      delete run.vetBatch;
      await saveSourcingRun(ws, { ...run });
      return ok({ done: true, vetted, deep, warnings, run });
    }

    // Push the run's candidates straight into an OS Text SMS campaign (creates or
    // tops up a campaign under the given name). Only rows that already hold a phone
    // go over; each is sent with the full merge-column set (first/last name, company,
    // job title, location, email, LinkedIn URL) so every OS Text {token} can fill in.
    if (action === "ostext") {
      if (!b?.id) return fail("missing_id", 422);
      const run = await getSourcingRun(ws, b.id);
      if (!run) return fail("run_not_found", 404);
      const name = ((b.name as string) || run.name || "").trim();
      if (!name) return fail("missing_name", 422);
      let noPhone = 0;
      const contacts: OsTextContact[] = [];
      for (const c of run.candidates) {
        if (!c.phone) { noPhone++; continue; }
        const parts = (c.fullName || "").trim().split(/\s+/);
        const custom: Record<string, string> = {};
        if (c.headline) custom.headline = c.headline;
        if (typeof c.verifiedScore === "number") custom.tag = `vetted-${c.verdict ?? "scored"}`;
        // Provenance for the phone-accuracy metric (tallied per source in OS Text).
        if (c.phoneSource) custom.phone_source = c.phoneSource;
        contacts.push({
          firstName: parts[0] || "",
          lastName: parts.slice(1).join(" "),
          company: c.company || "",
          jobTitle: c.title || c.headline || "",
          phone: c.phone,
          email: c.email || "",
          linkedinUrl: c.linkedinUrl || "",
          location: c.location || "",
          customFields: custom,
        });
      }
      if (!contacts.length) {
        return fail("no_contacts_with_phone", 422, {
          detail: "No candidate on this list has a phone number yet. Press Enrich first (it fills emails and phones), then send again.",
          noPhone,
        });
      }
      const recruiter = g.ctx.user.name || "";
      const template = ((b.template as string) || "").trim() || ostextStarterTemplate(recruiter, run.name || name);
      let data: Record<string, unknown>;
      try {
        data = await ostextImport({
          name,
          template,
          positionSummary: `Pushed from JD Sourcing list "${run.name}" (${contacts.length} contacts).`,
          recruiterName: recruiter,
          recruiterEmail: g.ctx.user.email || "",
          contacts,
          // SAFEGUARD (user mandate): every pushed number gets Telnyx cell-line
          // confirmation on arrival; only confirmed mobiles survive to be texted.
          // Not client-controllable — the checkbox opt-out is gone on purpose.
          validate: true,
          // NO-DOUBLE-CONTACT GUARD: sourced people who are already in the ATS
          // conversation (DNC or contacted within the cooldown) are filtered by
          // the shared importer; tallies come back as protectedDnc/protectedRecent.
          workspaceId: g.ctx.workspace.id,
          // The recruiter's assigned phone line (Numbers page) becomes the
          // campaign's SMS from-number: same number for their calls and texts.
          fromUserId: g.ctx.user.id,
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        const code = err.code || "ostext_import_failed";
        return fail(code, code === "ostext_not_connected" ? 503 : 502, { detail: err.message });
      }
      const guarded = (Number(data.protectedDnc) || 0) + (Number(data.protectedRecent) || 0);
      // Job Library: an OS Text push is a candidate-JD tie too; pair everyone
      // pushed to this run's JD (fire-and-forget, dedupe upstream).
      try {
        const { pairRunToJobLibrary } = await import("../../../lib/sourcing/jdpair");
        void pairRunToJobLibrary(run, `OS Text: ${run.name}`);
      } catch { /* never blocks the push */ }
      return ok({ ...data, pushed: Math.max(0, contacts.length - guarded), noPhone });
    }

    // Combine several saved runs (near-identical searches for the same role) into ONE
    // deduped master list, so the recruiter enriches once and pushes once instead of
    // juggling overlapping lists. Dedupe key is the same stable candKey used everywhere
    // (LinkedIn URL, else name+company). When the same person appears on two lists the
    // stronger row wins (verified score, then fit) and its blanks are filled from the
    // other row — an email found on list A and a phone found on list B both survive.
    if (action === "merge") {
      const ids: string[] = Array.isArray(b?.ids) ? b.ids.filter((x: unknown) => typeof x === "string") : [];
      if (ids.length < 2) return fail("need_two_lists", 422, { detail: "pick at least two saved lists to combine" });
      const runs: SourcingRun[] = [];
      for (const id of ids) {
        const r = await getSourcingRun(ws, id);
        if (!r) return fail("run_not_found", 404, { detail: id });
        runs.push(r);
      }
      // Pure, regression-tested merge (lib/sourcing/mergeRuns.ts): dedupe by the
      // stable person key, stronger row wins, blanks filled from the loser, deep-vet
      // verdicts carried over whole, verified-first re-rank.
      const { candidates, overlap, anchor } = mergeSourcingRuns(runs);
      // DOWNSTREAM CONTINUITY (2026-07-21): when a source already reached
      // Candidates/OS Text, the combined list must KEEP that identity. The OS Text
      // engine keys campaigns by EXACT name, so a "(combined)" rename forked a THIRD
      // campaign next to the sources' two — the auto-send now tops up the campaign
      // that already exists (and may hold replies) instead. A recruiter-typed name
      // still wins: an explicit rename is an explicit request for a fresh campaign.
      const master = pickSameRoleMaster(runs);
      const carried = master.autoflow?.sentAt || master.promotedCampaignId ? master : undefined;
      const name = ((b.name as string) || "").trim() || (carried ? carried.name : `${anchor.name} (combined)`);
      const mergedRun = await saveSourcingRun(ws, {
        name, jd: anchor.jd, jdUrl: anchor.jdUrl, location: anchor.location,
        icp: anchor.icp,
        queries: runs.flatMap((r) => r.queries),
        candidates,
        warnings: [],
        motion: anchor.motion,
        // A combined list is born finished (its sources were already enriched), so it
        // auto-sends to Candidates + OS Text immediately; combinedFrom makes the promote
        // RETAG everyone it holds with the combined name, so one tag in Candidates pulls
        // the whole refined set for campaign assignment.
        sendAsap: anchor.motion !== "bd",
        combinedFrom: ids,
        // Keep the sources' recruiter on the combined list; a creator-less legacy
        // set falls to whoever pressed Combine.
        createdBy: master.createdBy || runs.find((r) => r.createdBy)?.createdBy || actor,
      });
      if (carried && name === carried.name) {
        // Promote leg reuses the existing campaign/list; the sentAt stamp makes the
        // in-request send a TOP-UP (adds only what's new) rather than a first send.
        mergedRun.promotedCampaignId = carried.promotedCampaignId;
        mergedRun.promotedListId = carried.promotedListId;
        if (carried.autoflow?.sentAt) {
          mergedRun.autoflow = { sentAt: carried.autoflow.sentAt, phonesAtSend: carried.autoflow.phonesAtSend, attempts: 0 };
        }
        await saveSourcingRun(ws, { ...mergedRun });
      }
      // Optionally retire the sources — safe, the combined list holds every candidate.
      // A source with an enrich/vet job still in flight is kept so the job isn't stranded.
      let deleted = 0;
      const keptBusy: string[] = [];
      if (b.deleteSources === true) {
        for (const r of runs) {
          if (r.vetBatch || r.laxisJob || r.koldJob) { keptBusy.push(r.name); continue; }
          if (await deleteSourcingRun(ws, r.id)) deleted++;
        }
      }
      // Fire the auto-send now, in-request but not awaited (Telnyx phone validation on
      // the OS Text leg can take a minute). The nightqueue sweeper's sendAsap branch
      // re-fires it within ~2 minutes if this process dies before the send lands.
      const autoSend = mergedRun.sendAsap === true;
      if (autoSend) {
        void sendRunNow(mergedRun).catch((e) =>
          console.warn(`[sourcing] combined-list auto-send of "${mergedRun.name}" failed (sweeper will retry): ${(e as Error).message}`));
      }
      return ok({ run: mergedRun, total: candidates.length, overlap, sources: runs.length, deleted, keptBusy, autoSend, tag: name });
    }

    if (action === "delete") {
      if (!b?.id) return fail("missing_id", 422);
      return ok({ ok: await deleteSourcingRun(ws, b.id) });
    }

    return fail("unknown_action", 422);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 400;
    // An upstream provider rejecting ITS credentials (Anthropic/RapidAPI → 401/403)
    // must not reach the browser as a 401: the app shell reads that as a dead session
    // and signs the user out mid-task. Surface it as a 502 with the cause intact so
    // the tool shows "update the AI key in Setup", not a bounce to /login.
    if (status === 401 || status === 403) {
      return fail("provider_auth_failed", 502, {
        detail: `an external provider rejected its API key (${e?.message ?? "auth error"}): update it under Setup / Connected`,
      });
    }
    return fail(e?.message ?? "sourcing_failed", status);
  }
}
