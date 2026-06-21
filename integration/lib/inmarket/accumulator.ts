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
import { mergeIntoPool, poolCompanySlugs, poolCompanyNames, purgeNonUsFromPool, poolCompaniesToExpand, updateExpandedRolesBatch, purgeOversizedFromPool, purgeStaffingFromPool, reclassifyHiringIntent, recomputePoolMetrics, poolCompaniesMissingDomain, updateDomainsBatch } from "./pool";
import { enrichSizesBatch, outOfBandCompanyKeys } from "./companySize";
import { resolveCompanyRoles } from "./companyRoles";
import { resolveCompanyDomain } from "./domain";
import { directoryBatch } from "./atsDirectory";
import { runJobFeedSourcing, jobFeedEnabled } from "./jobFeed";
import { loadSnapshot, saveSnapshot } from "../db";

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
// DOMAIN BACKFILL — the unlock for contactable volume. Free job-board signals arrive with a
// company NAME but no domain, which starves BOTH decision-maker research and the email guess.
// Each cycle resolves+verifies a rotating batch's real domains and writes them back onto the
// pool, so the Hire Signals tab shows real people + emails and the curation contactable rate
// climbs (target: ~10% → ~50%). Free, verified, cached per company (so it compounds over days).
// THROUGHPUT DIALS — all env-overridable so we can tune toward 5K verified/day from LIVE funnel
// numbers WITHOUT a redeploy. The raised defaults assume egress IP rotation is active
// (INMARKET_EGRESS_IPS) so the free sources are spread across IPs and don't rate-limit. If you
// ever turn rotation off, dial these back down. See docs/platform/hire-signals-5k-setup.md.
const envNum = (k: string, d: number): number => Number(process.env[k]) || d;
// Domain is the GATE for emails (free guessEmail needs name + domain). Resolve aggressively so
// more companies become contactable. Raised defaults (still env-overridable) — these are cheap
// bounded HTTP/DNS probes; dial back via env if a host rate-limits.
const DOMAIN_BATCH = envNum("INMARKET_DOMAIN_BATCH", 500);        // pool companies (missing a domain) resolved per cycle
const DOMAIN_CONCURRENCY = envNum("INMARKET_DOMAIN_CONCURRENCY", 16); // parallel resolves (each = a few bounded HTTP/DNS probes)
let domainCursor = 0;
// Decision-maker curation runs on its OWN fast tick (not the heavy hourly cycle) so the prospect
// database stays living — refreshing every few minutes, walking the whole pool by score. Curation
// also resolves each company's domain on the fly, so a bigger/faster batch lifts BOTH naming and
// the contactable email rate. Raised defaults to push more companies through the funnel per tick.
const CURATE_CYCLE_MS = envNum("INMARKET_CURATE_INTERVAL_SEC", 240) * 1000; // research a fresh batch every N seconds (default 4 min)
const CURATE_BATCH = envNum("INMARKET_CURATE_BATCH", 300);        // companies researched per tick
const CURATE_CANDIDATES = envNum("INMARKET_CURATE_CANDIDATES", 6000); // pool slice we choose the not-yet-done batch from
const CURATE_CONCURRENCY = envNum("INMARKET_CURATE_CONCURRENCY", 16); // parallel researches (rotated across egress IPs)
const CURATE_MIN_SCORE = envNum("INMARKET_CURATE_MIN_SCORE", 10); // research a much wider band (was 25) so the funnel keeps climbing past the top-intent few hundred
const VERIFY_BATCH = envNum("INMARKET_VERIFY_BATCH", 800);        // curated emails free-verified (MX/role/disposable) per tick
const FINDER_BATCH = 40;               // pending people SMTP-verified per tick (opt-in; bounded — slow)
// FAST INFLOW — brand-new hiring companies/postings flow in on their OWN fast tick (every few
// minutes) so prospects appear as they're posted, not once an hour. It runs ONLY the cheap,
// high-yield breadth vacuum (+ a couple of rotating sectors) — never the expensive board
// expansion / size / directory work, which stays on the hourly cycle. This is what makes the
// Hire Signals tab populate in near-real-time without hammering the public ATS endpoints.
const INFLOW_CYCLE_MS = envNum("INMARKET_INFLOW_INTERVAL_SEC", 180) * 1000; // default every 3 min
const INFLOW_FIRST_DELAY_MS = 12_000;   // just after boot, once persistence is up
const FIRST_DELAY_MS = 8_000;           // let the server settle, then start pulling
const CURATE_FIRST_DELAY_MS = 25_000;   // let the pool fill a little before the first curation tick
// WATCHDOGS — a hard ceiling on how long a single run may take. Even with per-fetch timeouts,
// an unforeseen hang (a future un-timeouted source, a stuck await) must NEVER pin the overlap
// guard forever and silently stop the engine. If a run exceeds its watchdog we abandon it,
// release the guard, and let the next tick retry. Each ceiling sits comfortably below its
// interval so an abandoned run is cleared before the next one fires.
const CYCLE_WATCHDOG_MS = 30 * 60 * 1000;   // hourly cycle: abandon after 30 min
const CURATE_WATCHDOG_MS = 7 * 60 * 1000;   // 8-min curation tick: abandon after 7 min
const INFLOW_WATCHDOG_MS = 2 * 60 * 1000;   // 3-min inflow tick: abandon after 2 min

let started = false;
let running = false;                    // overlap guard: never let two cycles run at once
let curating = false;                   // overlap guard for the curation tick
let inflowing = false;                  // overlap guard for the fast inflow tick
let cursor = 0;
let seedCursor = 0;
let sizeCursor = 0;
let directoryCursor = 0;
// PAID JOB FEED (Active Jobs DB / RapidAPI) — the breadth lever past the free ceiling. Inert (no-op)
// until RAPID_JOBS_KEY + RAPID_JOBS_HOST are set. Offset-rotated so each cycle pulls a fresh page;
// bounded to the hourly cycle (not the 3-min inflow tick) to keep API spend predictable.
const JOBFEED_PAGE = envNum("RAPID_JOBS_PAGE", 50);                  // JOBS pulled per category (JSearch: num_pages = /10)
const JOBFEED_PAGES_PER_CYCLE = envNum("RAPID_JOBS_PAGES_PER_CYCLE", 4); // distinct category queries per hourly cycle
// Defaults ≈ 4 cats × 5 req = 20 req/cycle → ~14K req/mo → ~140K jobs/mo (fits the Ultra/$75 tier).
// Dial up RAPID_JOBS_PAGE / RAPID_JOBS_PAGES_PER_CYCLE to push toward 200K+; down for a smaller plan.
let jobFeedCursor = 0;

/* ------------------------------------------------------------------ */
/* Liveness heartbeat — so a silent death is detectable                */
/* ------------------------------------------------------------------ */
const HEALTH_KEY = "inmarket_engine_health_v1";

export interface EngineHealth {
  bootAt: string;
  cycles: number;
  curationTicks: number;
  lastCycleAt?: string;
  lastCycleMs?: number;
  lastCycleOk?: boolean;
  lastCycleError?: string;
  lastCurationAt?: string;
  lastCurationMs?: number;
  lastCurationOk?: boolean;
  lastCurationError?: string;
}

const health: EngineHealth = { bootAt: new Date().toISOString(), cycles: 0, curationTicks: 0 };

/** Persist the heartbeat so the UI can show "last fed N ago" even right after a restart. */
async function persistHealth(): Promise<void> {
  try { await saveSnapshot(HEALTH_KEY, health); } catch { /* best-effort */ }
}

/** Current engine liveness — prefers the in-memory heartbeat, falls back to the persisted one. */
export async function engineHealth(): Promise<EngineHealth> {
  if (health.lastCycleAt || health.lastCurationAt) return health;
  const saved = await loadSnapshot<EngineHealth>(HEALTH_KEY);
  return saved ?? health;
}

/**
 * Run `fn`, but reject if it hasn't settled within `ms`. The underlying work may keep running
 * in the background (JS can't truly cancel it), but the caller's overlap guard is released so
 * the engine keeps ticking instead of wedging forever on one stuck run.
 */
function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s watchdog`));
    }, ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    fn().then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

async function runCycle(): Promise<void> {
  // A cycle now does materially more work (bigger expansion batch); if one ever runs long,
  // skip the next tick rather than stacking concurrent cycles that fight over the pool blob.
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let ok = true, err: string | undefined;
  try {
    await withTimeout(runCycleInner, CYCLE_WATCHDOG_MS, "pool cycle");
  } catch (e) {
    ok = false; err = (e as Error)?.message ?? String(e);
  } finally {
    running = false;
    health.cycles++;
    health.lastCycleAt = new Date().toISOString();
    health.lastCycleMs = Date.now() - startedAt;
    health.lastCycleOk = ok;
    health.lastCycleError = err;
    void persistHealth();
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
  // Out-of-band = authoritatively confirmed under 100 OR over 5,000 employees. Kept out of
  // the expensive board-expansion below and purged from the pool, so it stays 100-5,000.
  let outOfBand = new Set<string>();
  try { outOfBand = await outOfBandCompanyKeys(); } catch { /* best-effort */ }

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

  // 1.5) PAID JOB FEED — the breadth lever past the free ceiling. Each cycle pulls a few rotating
  //    CATEGORIES (sectors) of US jobs from the paid feed (JSearch ~10 jobs/request) and merges them
  //    into the pool, where the enrichment fleet turns them into contacts. Rotating the query across
  //    INDUSTRIES is what gives the non-tech breadth the free pool lacks. No-op (zero spend) until
  //    RAPID_JOBS_KEY + RAPID_JOBS_HOST are set; request volume is bounded by RAPID_JOBS_PAGE ×
  //    RAPID_JOBS_PAGES_PER_CYCLE so you tune it to your plan's monthly request quota.
  if (jobFeedEnabled()) {
    for (let p = 0; p < JOBFEED_PAGES_PER_CYCLE; p++) {
      const q = INDUSTRIES[jobFeedCursor % INDUSTRIES.length];
      jobFeedCursor++;
      try { await runJobFeedSourcing({ query: q, location: "United States", limit: JOBFEED_PAGE }); }
      catch { break; }
    }
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
    const targets = await poolCompaniesToExpand(EXPAND_BATCH, EXPAND_STALE_MS, outOfBand);
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

  // 4.5) DOMAIN BACKFILL — resolve+verify a real web domain for a rotating batch of pool
  //    companies that don't have one yet, and stamp it back onto the lead. THIS is the gate that
  //    was starving the funnel: no domain → no team-page research → no email → nothing
  //    contactable. With a domain in place, decision-maker research and the email guess both
  //    light up, and the read path (withLikelyEmails) shows real emails on the Hire Signals tab.
  //    Free, verified (anti-squatter homepage check + MX), cached — so coverage compounds daily.
  try {
    const { targets, total } = await poolCompaniesMissingDomain(domainCursor, DOMAIN_BATCH);
    if (targets.length) {
      domainCursor = total ? (domainCursor + targets.length) % total : 0;
      const found: Array<{ company: string; domain: string }> = [];
      let i = 0;
      const worker = async () => {
        while (i < targets.length) {
          const t = targets[i++];
          try {
            const r = await resolveCompanyDomain(t.company, { sourceUrl: t.sourceUrl });
            if (r?.domain) found.push({ company: t.company, domain: r.domain });
          } catch { /* skip this company this cycle */ }
        }
      };
      await Promise.all(Array.from({ length: DOMAIN_CONCURRENCY }, worker));
      if (found.length) await updateDomainsBatch(found);
    }
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
    // Enforce the target band [MIN_EMPLOYEES, MAX_EMPLOYEES] = 100-5,000: drop any pool
    // company Wikidata has now confirmed is below 100 OR above 5,000. Re-read the set so it
    // includes companies resolved THIS cycle. Authoritative counts only — heuristic
    // estimates are never purged. (purgeOversizedFromPool just removes the given keys.)
    try {
      outOfBand = await outOfBandCompanyKeys();
      if (outOfBand.size) await purgeOversizedFromPool(outOfBand);
    } catch { /* best-effort */ }
  } catch {
    /* size enrichment is best-effort */
  }

  // 5.5) RECLASSIFY INTENT — re-derive each lead's hiring-intent type (surge / long-open /
  //    posting) from the roles we now hold, so the "Hiring signals" filter spreads across real
  //    categories instead of being all "New job posting". Cheap + idempotent.
  try { await reclassifyHiringIntent(); } catch { /* best-effort */ }

  // 6) RECOMPUTE METRICS — after this cycle's merges, expansions and purges, refresh the live
  //    aggregates (companies + total open positions across the 90-day pool) so the Hire Signals
  //    banner shows a running, daily-growing count without summing the whole pool per request.
  try { await recomputePoolMetrics(); } catch { /* best-effort */ }
}

/**
 * CURATION TICK — the living-database engine. Every few minutes, pull a large pool slice by score
 * and research the actual decision-maker (name + likely email) for the next batch that isn't
 * already done/fresh, upserting tracked CuratedProspects. Because curateFromPool skips
 * recently-curated companies, successive ticks ADVANCE through the whole pool, then refresh the
 * oldest — so the prospect list keeps growing and stays current without re-doing the same names.
 * Free + behind the review gate; nothing sends automatically.
 */
/**
 * FAST INFLOW tick — runs only the cheap, high-yield pulls that surface brand-new hiring
 * companies, on a short interval, so the pool grows in near-real-time. Deliberately excludes
 * the expensive board-expansion / size / directory / domain work (that stays on the hourly
 * cycle), so running it every few minutes is safe for the public ATS endpoints.
 */
async function runInflowTickInner(): Promise<void> {
  const now = new Date().toISOString();
  // BREADTH VACUUM — the main inflow of net-new hiring companies + postings.
  try {
    const all = await collectLeads({ limit: VACUUM_CAP }, now, VACUUM_CAP);
    await mergeIntoPool(all);
  } catch { /* next tick retries */ }
  // A couple of rotating sectors so non-tech breadth keeps arriving between heavy cycles.
  for (let i = 0; i < 2; i++) {
    const industry = INDUSTRIES[cursor % INDUSTRIES.length];
    cursor++;
    try {
      const leads = await collectLeads({ industries: [industry], limit: COLLECT_CAP }, now, COLLECT_CAP);
      await mergeIntoPool(leads);
    } catch { /* skip this sector this tick */ }
  }
  // Refresh the live banner aggregates so the new count shows immediately.
  try { await recomputePoolMetrics(); } catch { /* best-effort */ }
}

async function runInflowTick(): Promise<void> {
  // Skip if a fast tick is already running, or the heavy hourly cycle is mid-run (it does its
  // own vacuum) — never stack redundant pulls.
  if (inflowing || running) return;
  inflowing = true;
  try {
    await withTimeout(runInflowTickInner, INFLOW_WATCHDOG_MS, "inflow tick");
  } catch { /* abandoned by the watchdog; the next tick retries */ }
  finally { inflowing = false; }
}

async function runCurationTickInner(): Promise<void> {
  const now = new Date().toISOString();
  const { queryPool } = await import("./pool");
  const { curateFromPool, pendingValidationEmails, applyEmailValidation } = await import("./curation");
  const candidates = await queryPool({ limit: CURATE_CANDIDATES } as never, CURATE_CANDIDATES);
  if (candidates.length) {
    await curateFromPool(
      candidates.map((l) => ({
        company: l.company, domain: l.domain, industry: l.industry, signalType: l.signalType,
        reason: l.reason, score: l.score, employeeCount: l.employeeCount, roleDetails: l.roleDetails, roles: l.roles,
        sourceUrl: l.sourceUrl,
      })),
      { limit: CURATE_BATCH, concurrency: CURATE_CONCURRENCY, minScore: CURATE_MIN_SCORE, nowIso: now },
    );
  }

  // FREE EMAIL VERIFICATION — same continuous-validation seam the external paid validator uses,
  // but run in-process at $0: pull a batch of still-unverified curated emails and apply free
  // MX / role-account / disposable verdicts. Undeliverable ones are marked invalid (dropped from
  // the send queue); deliverable-but-unconfirmed ones are LEFT pending (we never assert a "valid"
  // we can't prove). This makes the funnel's invalid count real and keeps dead emails out of BD
  // Bulk — turning "guessed" into "deliverable-likely" for free and safely.
  try {
    const pending = await pendingValidationEmails(VERIFY_BATCH);
    if (pending.length) {
      const { verifyEmailsFree } = await import("./emailVerify");
      const results = await verifyEmailsFree(pending);
      if (results.length) await applyEmailValidation(results, new Date().toISOString());
    }
  } catch { /* best-effort; the next tick retries */ }

  // EMAIL FINDER (opt-in, SMTP) — the right way to convert guesses into VALID prospects: walk each
  // pending person's permutations and SMTP-verify until one is accepted, then keep that real
  // address. No-op unless INMARKET_EMAIL_FINDER/INMARKET_SMTP_VERIFY is set (needs outbound port
  // 25). Small batch per tick so it never floods a single MTA.
  try {
    const { smtpEnabled } = await import("./emailVerify");
    if (smtpEnabled()) {
      const { findEmailsBySmtp } = await import("./curation");
      await findEmailsBySmtp(FINDER_BATCH, new Date().toISOString());
    }
  } catch { /* best-effort; the next tick retries */ }
}

async function runCurationTick(): Promise<void> {
  if (curating) return;
  curating = true;
  const startedAt = Date.now();
  let ok = true, err: string | undefined;
  try {
    await withTimeout(runCurationTickInner, CURATE_WATCHDOG_MS, "curation tick");
  } catch (e) {
    ok = false; err = (e as Error)?.message ?? String(e);
  } finally {
    curating = false;
    health.curationTicks++;
    health.lastCurationAt = new Date().toISOString();
    health.lastCurationMs = Date.now() - startedAt;
    health.lastCurationOk = ok;
    health.lastCurationError = err;
    void persistHealth();
  }
}

/**
 * Idempotently start the background accumulator. Safe to call on every request — it only
 * arms the timers once per process. Errors inside cycles are swallowed so they never
 * affect a user's search.
 */
export function ensureAccumulator(): void {
  if (started) return;
  started = true;
  // Heavy pool-building cycle (hourly).
  setTimeout(() => { void runCycle(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runCycle(); }, CYCLE_MS);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
  // Fast inflow tick (every few minutes) — new hiring companies arrive in near-real-time,
  // not once an hour, so the Hire Signals tab populates as roles get posted.
  setTimeout(() => { void runInflowTick(); }, INFLOW_FIRST_DELAY_MS);
  const f = setInterval(() => { void runInflowTick(); }, INFLOW_CYCLE_MS);
  if (typeof f === "object" && f && "unref" in f) (f as { unref: () => void }).unref();
  // Fast decision-maker curation tick (every few minutes) — keeps the prospect DB living.
  setTimeout(() => { void runCurationTick(); }, CURATE_FIRST_DELAY_MS);
  const c = setInterval(() => { void runCurationTick(); }, CURATE_CYCLE_MS);
  if (typeof c === "object" && c && "unref" in c) (c as { unref: () => void }).unref();
}
