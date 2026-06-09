/**
 * RecruiterOS · In-Market background accumulator
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
import { mergeIntoPool, poolCompanySlugs } from "./pool";

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
const COLLECT_CAP = 120;               // leads/sector for the targeted pulls
const VACUUM_CAP = 600;                // leads for the keyword-less breadth pull
const SEED_COMPANIES = 40;             // pool companies probed for deeper roles per cycle
const SEED_CAP = 300;                  // leads from the seeding pass
const FIRST_DELAY_MS = 8_000;           // let the server settle, then start pulling

let started = false;
let cursor = 0;
let seedCursor = 0;

async function runCycle(): Promise<void> {
  const now = new Date().toISOString();

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
