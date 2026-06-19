/**
 * RecruitersOS · In-Market background accumulator
 *
 * Quietly builds up the signal pool so searches read from thousands of leads without
 * hitting providers live every time. Runs IN-PROCESS (a timer in the long-lived Next
 * server) — no cron, no systemd, no console: it starts on the first search after a
 * deploy and then refreshes on an interval.
 *
 * Rate discipline: each cycle collects only a couple of industries, so the Adzuna trial
 * is spent thin over time (a handful of calls per cycle) instead of all at once. It
 * rotates through every sector, so over a day or two the pool covers the whole market
 * and keeps itself fresh.
 */

import { collectLeads } from "./index";
import { mergeIntoPool, poolCompanySlugs, poolCompanyNames, purgeNonUsFromPool, poolCompaniesToExpand, updateExpandedRolesBatch, purgeOversizedFromPool, purgeStaffingFromPool, reclassifyHiringIntent, recomputePoolMetrics } from "./pool";
import { enrichSizesBatch, oversizedCompanyKeys } from "./companySize";
import { resolveCompanyRoles } from "./companyRoles";
import { directoryBatch } from "./atsDirectory";

// Sectors to keep warm — mirrors the UI's industry chips (non-tech first, since those
// are the sectors free remote boards miss and Adzuna fills).
const INDUSTRIES: string[] = [
  "Healthcare", "Hospitals / Health Systems", "Biotech / Pharma", "Medical Devices",
  "Insurance", "Banking", "Manufacturing", "Aerospace / Defense", "Automotive",
  "Energy", "Oil & Gas", "Renewables / CleanTech", "Utilities", "Construction",
  "Real Estate", "Logistics / Supply Chain", "Retail / eCommerce", "Consumer Goods (CPG)",
  "Food & Beverage", "Hospitality", "Travel / Tourism", "Legal", "Accounting / Tax",
  "Education", "Telecom", "Media / Entertainment", "Marketing / Agency", "Government / Public",
  "Nonprofit", "Agriculture / AgTech", "Technology / SaaS", "Fintech", "Cybersecurity",
  "Data / Analytics", "Sales / GTM",
];

const CYCLE_MS = 60 * 60 * 1000;       // refresh every 60 minutes
const PER_CYCLE = 4;                    // targeted industries per cycle
const COLLECT_CAP = 160;               // leads/sector for the targeted pulls
const VACUUM_CAP = 900;                // leads for the keyword-less breadth pull
const SEED_COMPANIES = 40;             // pool companies probed for deeper roles per cycle
const SEED_CAP = 300;                  // leads from the seeding pass
const SIZE_BATCH = 120;                // companies resolved for headcount (Wikidata) per cycle —
                                       // high, so the <10K cap "bites" within days, not weeks
const EXPAND_BATCH = 120;              // companies whose FULL ATS board we pull per cycle (the
                                       // unlimited free lever — keyless boards, no rate limit)
const EXPAND_STALE_MS = 3 * 24 * 60 * 60 * 1000; // re-pull a company's board after 3 days
const DIRECTORY_BATCH = 80;            // curated ATS-directory slugs probed per cycle (net-new
                                       // companies straight off their own boards — see atsDirectory)
const DIRECTORY_CAP = 1200;            // leads from the directory pass (whole boards → many roles)
const CURATE_BATCH = 50;               // companies whose decision-maker we research per cycle
                                       // (~50/cycle x 24 = a daily named-prospect list that compounds)
const FIRST_DELAY_MS = 8_000;           // let the server settle, then start pulling

let started = false;
let running = false;                    // overlap guard: never let two cycles run at once
let cursor = 0;
let seedCursor = 0;
let sizeCursor = 0;
let directoryCursor = 0;

async function runCycle(): Promise<void> {
  // A cycle now does materially more work (bigger expansion batch); if one ever runs long,
  // skip the next tick rather than stacking concurrent cycles that fight over the pool blob.
  if (running) return;
  running = true;
  try {
    await runCycleInner();
  } finally {
    running = false;
  }
}

async function runCycleInner(): Promise<void> {
  const now = new Date().toISOString();

  // US-ONLY cleanup: prune any non-US leads still stored in the pool (one-time effect once
  // it's clean; cheap to re-run each cycle as a guard).
  try { await purgeNonUsFromPool(); } catch { /* best-effort */ }

  // STAFFING-ONLY cleanup: prune any staffing/recruiting agency still stored in the pool, so
  // we only ever build outreach toward the company actually hiring — never the agency.
  try { await purgeStaffingFromPool(); } catch { /* best-effort */ }

  // Companies we've already authoritatively confirmed are over the employee cap — used below
  // to keep them out of the expensive board-expansion (SMB priority). Refreshed after this
  // cycle's size resolution so the purge picks up newly-confirmed megacorps too.
  let oversized = new Set<string>();
  try { oversized = await oversizedCompanyKeys(); } catch { /* best-effort */ }

  // 1) BREADTH VACUUM — pull every free board with NO industry keyword, so every hiring
  //    company on every board enters the pool. Industry filtering still happens later at
  //    SEARCH time (queryPool), so users keep their per-sector view. This is the main fix
  //    for low inflow: the old per-industry pulls discarded ~90% of each board (a remote
  //    SaaS role doesn't contain the token "healthcare"), starving the pool. The vacuum
  //    keeps it all, and a higher cap also unlocks deeper pagination (e.g. The Muse).
  try {
    const all = await collectLeads({ limit: VACUUM_CAP }, now, VACUUM_CAP);
    await mergeIntoPool(all);
  } catch {
    /* vacuum failed this tick; the targeted pulls below still run */
  }

  // 2) TARGETED DEPTH — rotate through sectors so the keyword-driven sources (Adzuna's
  //    `what=`, Google News RSS) pull sector-specific companies the generic feeds under-
  //    cover. This is where non-tech breadth comes from once Adzuna is keyed.
  for (let i = 0; i < PER_CYCLE; i++) {
    const industry = INDUSTRIES[cursor % INDUSTRIES.length];
    cursor++;
    try {
      const leads = await collectLeads({ industries: [industry], limit: COLLECT_CAP }, now, COLLECT_CAP);
      await mergeIntoPool(leads);
    } catch {
      /* skip this industry this cycle; try the next on the following tick */
    }
  }

  // 3) SEED ATS + GITHUB — feed a rotating slice of known pool companies (as slugs) to the
  //    watchlist-driven sources (Workable/SmartRecruiters/Recruitee + GitHub orgs + News
  //    RSS), which are otherwise inert without a company list. This deepens role/manager
  //    coverage for companies already in the pool (more open roles -> richer velocity
  //    roll-up -> more hiring managers). Slugs are best-effort; misses fail gracefully.
  try {
    const { slugs, total } = await poolCompanySlugs(seedCursor, SEED_COMPANIES);
    if (slugs.length) {
      seedCursor = total ? (seedCursor + slugs.length) % total : 0;
      const leads = await collectLeads({ companyNames: slugs, limit: SEED_CAP }, now, SEED_CAP);
      await mergeIntoPool(leads);
    }
  } catch {
    /* seeding is best-effort; skip this tick on any failure */
  }

  // 3.5) ATS DIRECTORY — probe a rotating batch of KNOWN real public-ATS slugs (Greenhouse/
  //    Lever/Ashby/Workable/…) straight off their own boards. This is the unlimited free volume
  //    lever: each slug is one keyless request returning a whole company's open roles, so a
  //    handful of slugs/cycle becomes hundreds of net-new roles at real companies. Runs through
  //    collectLeads so the staffing gate, US filter, scoring, and dedupe all apply. The directory
  //    self-grows from the slugified pool, so coverage compounds toward 10–20K/day over time.
  try {
    const { slugs, nextOffset } = directoryBatch(directoryCursor, DIRECTORY_BATCH);
    if (slugs.length) {
      directoryCursor = nextOffset;
      const leads = await collectLeads({ companyNames: slugs, limit: DIRECTORY_CAP }, now, DIRECTORY_CAP);
      await mergeIntoPool(leads);
    }
  } catch {
    /* directory pass is best-effort; the rest of the cycle still runs */
  }

  // 4) AUTO-EXPAND BOARDS — for a rotating batch of pool companies, pull their OWN public ATS
  //    board and store EVERY open role (titles + per-role posting dates) onto the lead, so a
  //    company that surfaced from one listing automatically shows all of its roles — no click.
  //    This is what bulks the pool from "1 role per company" to whole boards (tens of roles).
  try {
    const targets = await poolCompaniesToExpand(EXPAND_BATCH, EXPAND_STALE_MS, oversized);
    // Resolve each company's board sequentially (one request per host at a time — gentle on
    // the public ATS endpoints), accumulate the results, then commit them all in a SINGLE
    // pool write. This keeps a large EXPAND_BATCH cheap on the single-blob KV store.
    const updates: Array<{ company: string; roleDetails: Array<{ title: string; postedAt?: string; location?: string }>; source: string }> = [];
    for (const t of targets) {
      try {
        const r = await resolveCompanyRoles(t.company, t.domain);
        updates.push({
          company: t.company,
          roleDetails: r.roles.map((x) => ({ title: x.title, postedAt: x.postedAt, location: x.location })),
          source: r.source,
        });
      } catch { /* skip this company this cycle */ }
    }
    if (updates.length) await updateExpandedRolesBatch(updates);
  } catch { /* best-effort */ }

  // 5) RESOLVE COMPANY SIZE — look up real headcounts for a rotating batch of pool companies
  //    from Wikidata (free, keyless), cached so the size filter carries authoritative sizes
  //    over time. Companies Wikidata doesn't cover fall back to a marked estimate at search.
  try {
    const { names, total } = await poolCompanyNames(sizeCursor, SIZE_BATCH);
    if (names.length) {
      sizeCursor = total ? (sizeCursor + names.length) % total : 0;
      await enrichSizesBatch(names, SIZE_BATCH);
    }
    // Enforce the employee cap (companySize.MAX_EMPLOYEES): drop any pool company Wikidata has
    // now confirmed is over it. Re-read the set so it includes companies resolved THIS cycle.
    // Authoritative counts only — heuristic estimates are never purged.
    try {
      oversized = await oversizedCompanyKeys();
      if (oversized.size) await purgeOversizedFromPool(oversized);
    } catch { /* best-effort */ }
  } catch {
    /* size enrichment is best-effort */
  }

  // 5.5) RECLASSIFY INTENT — re-derive each lead's hiring-intent type (surge / long-open /
  //    posting) from the roles we now hold, so the "Hiring signals" filter spreads across real
  //    categories instead of being all "New job posting". Cheap + idempotent.
  try { await reclassifyHiringIntent(); } catch { /* best-effort */ }

  // 5.7) CURATE DECISION-MAKERS — research the actual hiring manager for a rotating batch of the
  //    highest-intent companies (free: team page / news / GitHub), build their likely email, and
  //    upsert a tracked CuratedProspect. This is what turns the raw signal pool into the daily
  //    list of real people we can market to. Bounded per cycle so the list compounds over the day
  //    without hammering the free sources. Behind the review gate — nothing sends automatically.
  try {
    const { queryPool } = await import("./pool");
    const { curateFromPool } = await import("./curation");
    const top = await queryPool({ limit: CURATE_BATCH } as never, CURATE_BATCH);
    if (top.length) {
      await curateFromPool(
        top.map((l) => ({
          company: l.company, domain: l.domain, industry: l.industry, signalType: l.signalType,
          reason: l.reason, score: l.score, employeeCount: l.employeeCount, roleDetails: l.roleDetails, roles: l.roles,
        })),
        { limit: CURATE_BATCH, concurrency: 4, minScore: 40, nowIso: now },
      );
    }
  } catch { /* curation is best-effort; never blocks the cycle */ }

  // 6) RECOMPUTE METRICS — after this cycle's merges, expansions and purges, refresh the live
  //    aggregates (companies + total open positions across the 90-day pool) so the Hire Signals
  //    banner shows a running, daily-growing count without summing the whole pool per request.
  try { await recomputePoolMetrics(); } catch { /* best-effort */ }
}

/**
 * Idempotently start the background accumulator. Safe to call on every request — it only
 * arms the timers once per process. Errors inside cycles are swallowed so they never
 * affect a user's search.
 */
export function ensureAccumulator(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runCycle(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runCycle(); }, CYCLE_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
