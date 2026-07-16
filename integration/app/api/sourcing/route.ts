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
 *   { action: "delete", id }                       -> remove a saved run
 *
 * Discovery-only until promote; contact lookup and deep-vet are on demand. Session-gated.
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  planSourcing, pinIcpLocation, parseJobDescription, generateQueries, runDiscovery,
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
  mergeSourcingRuns,
} from "../../../lib/sourcing";
import type { CandidateRow, SearchBreadth, VetBatchItem, SourcingRun } from "../../../lib/sourcing";
import { enrich, cheapFirstContactWaterfall } from "../../../lib/signals";
import { withWorkspaceCreds } from "../../../lib/connected";
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
async function gapFillContacts(ws: string, rows: CandidateRow[]): Promise<{ enriched: number; cacheHits: number }> {
  const plan = cheapFirstContactWaterfall({ includePhone: true });
  let enriched = 0;
  let contactCacheHits = 0;
  for (const c of rows) {
    if (c.email) continue;
    const personKey = c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`;
    const cached = await getCachedContact(ws, personKey);
    if (cached && (cached.email || cached.phone)) {
      if (cached.email) { c.email = cached.email; enriched++; }
      if (cached.phone) c.phone = cached.phone;
      contactCacheHits++;
      continue;
    }
    const [first, ...rest] = (c.fullName || "").trim().split(/\s+/);
    try {
      const report = await enrich(plan, {
        name: c.company, companyName: c.company, fullName: c.fullName,
        firstName: first, lastName: rest.join(" "), linkedinUrl: c.linkedinUrl, title: c.title,
      }, { now: nowIso() });
      const e = report.subject.email; const ph = report.subject.phone;
      if (typeof e === "string") { c.email = e; enriched++; }
      if (typeof ph === "string") c.phone = ph;
      await putCachedContact(ws, personKey, {
        email: typeof e === "string" ? e : undefined,
        phone: typeof ph === "string" ? ph : undefined,
      });
    } catch { /* leave unresolved */ }
  }
  return { enriched, cacheHits: contactCacheHits };
}

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
      return ok(await planSourcing(b.jd, b.location, parseBreadth(b.breadth)));
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
      return ok({ icp, queries: generateQueries(icp, { breadth: parseBreadth(b.breadth) }), changes });
    }

    if (action === "run") {
      if (!b?.jd) return fail("missing_jd", 422);
      // A typed hiring location is ground truth: it pins the ICP's geos (the LLM parse
      // otherwise drifts to a national metro list) and turns on the strict-location drop.
      // A client-supplied ICP (a Dive-deeper refinement) wins over re-parsing the JD,
      // so refined searches actually run on the refined profile.
      const clientIcp = b.icp && typeof b.icp === "object" && Array.isArray(b.icp.titles) ? b.icp : undefined;
      const icp = pinIcpLocation(clientIcp ?? (await parseJobDescription(b.jd)), b.location);
      // Breadth drives the query FAN-OUT here (how many title-chunk × geo searches
      // run) and the per-query paging depth inside runDiscovery.
      const breadth = parseBreadth(b.breadth);
      const queries = generateQueries(icp, { breadth });
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
      }));
      // Remember who we surfaced so a later fresh-only run skips them.
      await addSeenKeys(ws, result.candidates.map(candKey));
      return ok({ icp, queries, ...result, freshOnly: b.freshOnly === true });
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
      const { enriched, cacheHits } = await gapFillContacts(ws, run.candidates.slice(0, top));
      await saveSourcingRun(ws, { ...run });
      return ok({ enriched, cacheHits, run });
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
      const resumeStart = nextLaxisOffset(progress.doneOffsets, total, step);
      const start = b.start != null ? Math.max(0, Number(b.start) || 0) : (resumeStart ?? 0);
      // Already enriched this chunk (a resume landed on a done offset, or every chunk is
      // done)? Don't re-submit or re-grab — just report the next un-enriched offset.
      if (resumeStart === null || progress.doneOffsets.includes(start)) {
        return ok({ submitted: false, alreadyDone: true, start, nextStart: resumeStart, doneOffsets: progress.doneOffsets });
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
        await saveSourcingRun(ws, { ...run });
        return ok({ done: true, status: "error", warnings: [`laxis_job_error: ${job.error ?? "unknown"}`], run });
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

      // Laxis was the first pass; the cheap in-house waterfall fills whatever it left blank
      // (unless the caller opts out). One seamless flow from the recruiter's side.
      let gapFill = { enriched: 0, cacheHits: 0 };
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
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        const code = err.code || "ostext_import_failed";
        return fail(code, code === "ostext_not_connected" ? 503 : 502, { detail: err.message });
      }
      const guarded = (Number(data.protectedDnc) || 0) + (Number(data.protectedRecent) || 0);
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
      const name = ((b.name as string) || "").trim() || `${anchor.name} (combined)`;
      const mergedRun = await saveSourcingRun(ws, {
        name, jd: anchor.jd, jdUrl: anchor.jdUrl, location: anchor.location,
        icp: anchor.icp,
        queries: runs.flatMap((r) => r.queries),
        candidates,
        warnings: [],
        motion: anchor.motion,
      });
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
      return ok({ run: mergedRun, total: candidates.length, overlap, sources: runs.length, deleted, keptBusy });
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
