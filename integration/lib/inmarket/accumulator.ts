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
import { mergeIntoPool } from "./pool";

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

const CYCLE_MS = 3 * 60 * 60 * 1000;   // refresh every 3 hours
const PER_CYCLE = 2;                    // industries per cycle (keeps provider calls low)
const FIRST_DELAY_MS = 20_000;          // let the server settle before the first pull

let started = false;
let cursor = 0;

async function runCycle(): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < PER_CYCLE; i++) {
    const industry = INDUSTRIES[cursor % INDUSTRIES.length];
    cursor++;
    try {
      const leads = await collectLeads({ industries: [industry], limit: 200 }, now, 200);
      await mergeIntoPool(leads);
    } catch {
      /* skip this industry this cycle; try the next on the following tick */
    }
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
