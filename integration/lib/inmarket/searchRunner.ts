/**
 * RecruitersOS · In-Market · SET-AND-FORGET search runner.
 *
 * Processes the targeted-search queue in the background: claims the oldest queued search, scrapes it
 * via JSearch, narrows by size, MERGES the companies into the pool automatically (no manual pick),
 * and stamps per-search progress the UI renders as a bar that ticks off. One search at a time (JSearch
 * is rate-limited and the merge is the point), so a big batch drains steadily while you do other things.
 *
 * Durable + resumable: every step persists through the snapshot layer, so a restart picks the batch up
 * where it left off — completed searches stay done, and a search interrupted mid-run is re-queued at
 * boot (resumeInterruptedRuns) rather than lost. Armed once from instrumentation; also kicked on demand
 * when something is enqueued.
 */

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

const TICK_MS = 4000;

/** Arm the background runner (idempotent). Safe to call on boot and on every enqueue. */
export function ensureSearchRunner(): void {
  if (timer) { void tick(); return; }
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (timer && typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();
  void tick();
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { claimNextQueued } = await import("./searchQueue");
    const s = await claimNextQueued();
    if (s) await processOne(s);
  } catch {
    /* never let a tick error kill the loop */
  } finally {
    busy = false;
  }
}

async function processOne(s: import("./searchQueue").TargetedSearch): Promise<void> {
  const { updateRun, finishRun, failRun } = await import("./searchQueue");
  try {
    const { previewJobFeed, jobFeedEnabled } = await import("./jobFeed");
    if (!jobFeedEnabled()) { await failRun(s.id, "Job feed not configured — set RAPID_JOBS_KEY + RAPID_JOBS_HOST."); return; }

    // 1) Scrape via JSearch (title + industry fold into one keyword query, like the manual path).
    const title = String(s.query ?? "").trim();
    const industry = String(s.industry ?? "").trim();
    const query = [title, industry].filter(Boolean).join(" ").trim();
    if (!query) { await failRun(s.id, "Search has no job title or industry."); return; }
    await updateRun(s.id, { phase: "scraping", progress: 0.25 });
    let { leads, jobs } = await previewJobFeed({
      query,
      location: s.location || undefined,
      datePosted: s.datePosted,
      employmentTypes: s.employmentTypes,
      remoteOnly: s.remoteOnly === true,
      limit: Math.min(Math.max(Number(s.limit) || 100, 10), 500),
    });
    const found = leads.length;

    // 2) Narrow by company-size band (free: Wikidata cache + heuristic), if the search asked for it.
    await updateRun(s.id, { phase: "filtering", progress: 0.55, found, jobs });
    const bands = Array.isArray(s.headcountBands) ? s.headcountBands : [];
    if (bands.length) {
      const { loadSizeMap, fillSizes } = await import("./companySize");
      fillSizes(leads, await loadSizeMap());
      const want = new Set<string>(bands);
      leads = leads.filter((l) => l.headcountBand && want.has(l.headcountBand) && (!s.confirmedSizeOnly || l.sizeEstimated === false));
    }

    // 3) Count net-new vs the pool, then MERGE (auto-commit — this is the set-and-forget part).
    await updateRun(s.id, { phase: "merging", progress: 0.8 });
    const { poolCompanyKeySet, mergeIntoPool } = await import("./pool");
    const { companyKey } = await import("./index");
    const inPool = await poolCompanyKeySet();
    const merged = leads.filter((l) => !inPool.has(companyKey(l.company || ""))).length;
    await mergeIntoPool(leads);

    // 4) Done — the accumulator/curation + Reoon then enrich these companies on their own ticks.
    await finishRun(s.id, { found, merged, jobs });
  } catch (e: unknown) {
    await failRun(s.id, e instanceof Error ? e.message : "run failed");
  }
}
