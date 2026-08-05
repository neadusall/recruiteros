/**
 * RecruitersOS · Signal Watchlists · signal stacking
 *
 * A job posting alone is one signal; a job posting PLUS a funding round or a
 * fresh executive hire is a different class of lead (stacked-signal outreach
 * replies at a multiple of single-signal). This module takes the tick's fresh
 * companies and asks the FREE news connector (Google News RSS, keyless) which
 * of them show a second corroborating signal, then hands back a per-company
 * stack the poll uses to (a) boost the lead's score so hot companies jump the
 * curation queue, and (b) enrich the recruiter-facing "why now" reason with
 * the plain-English fact. No paid calls, fails open to "no stack".
 *
 * Budget shape: one news pull covers ≤10 companies × 6 query types, so the
 * per-tick company cap (SIGNALS_STACK_MAX_PER_TICK, default 20) bounds the
 * added tick time; the whole sweep is timeboxed and cached for a day.
 */

import { NewsRssSource } from "../freeSources";
import type { Signal } from "../types";

export interface CompanyStack {
  /** Distinct corroborating signal types found, e.g. ["funding_round"]. */
  types: string[];
  /** Additive score boost (0..25) the poll applies to the lead's 0..100 score. */
  boost: number;
  /** Recruiter-facing "why now" fragment, e.g. "raised a funding round this month". */
  whyNow?: string;
  /** True when a layoff/distress signal was seen (a caution, not a boost). */
  caution?: boolean;
}

/** Per-type score boost. Funding is the highest-converting stack; a layoff is
 *  a caution flag for perm hiring, never a boost. */
const BOOST: Record<string, number> = {
  funding_round: 15,
  exec_hire: 10,
  acquisition: 6,
  office_expansion: 6,
  market_entry: 5,
  layoff: 0,
};

const WHY_NOW: Record<string, string> = {
  funding_round: "just raised a funding round",
  exec_hire: "just brought in new leadership",
  acquisition: "in the middle of an acquisition",
  office_expansion: "opening a new office",
  market_entry: "expanding into a new market",
};

/** Only news younger than this corroborates a live hiring signal. */
const FRESH_DAYS = 45;
const BATCH = 10;                       // NewsRssSource caps companies per pull
const CACHE_MS = 24 * 3600_000;         // a company's news doesn't change per tick
const cache = new Map<string, { at: number; stack: CompanyStack | null }>();

export function stackingEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.SIGNALS_STACK || "").toLowerCase());
}

function maxCompaniesPerTick(): number {
  const n = Number(process.env.SIGNALS_STACK_MAX_PER_TICK);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
}

function sweepTimeboxMs(): number {
  const n = Number(process.env.SIGNALS_STACK_TIMEBOX_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 25_000;
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

function isFresh(s: Signal): boolean {
  const at = Date.parse(s.eventAt || s.ingestedAt || "");
  return Number.isFinite(at) && Date.now() - at < FRESH_DAYS * 24 * 3600_000;
}

function stackFromSignals(company: string, signals: Signal[]): CompanyStack | null {
  const mine = signals.filter(
    (s) => norm(s.company?.name || "") === norm(company) && isFresh(s),
  );
  if (!mine.length) return null;
  const types = [...new Set(mine.map((s) => s.type))];
  const boost = Math.min(25, types.reduce((sum, t) => sum + (BOOST[t] ?? 0), 0));
  const caution = types.includes("layoff");
  const best = types.filter((t) => WHY_NOW[t]).sort((a, b) => (BOOST[b] ?? 0) - (BOOST[a] ?? 0))[0];
  if (!boost && !caution) return null;
  return { types, boost, whyNow: best ? WHY_NOW[best] : undefined, caution };
}

/**
 * Look up corroborating signals for these companies. Returns only companies
 * with a stack (or a caution); everything else is absent from the map. Never
 * throws: a news outage degrades to single-signal behavior.
 */
export async function stackCompanies(names: string[]): Promise<Map<string, CompanyStack>> {
  const out = new Map<string, CompanyStack>();
  if (!stackingEnabled() || !names.length) return out;

  // Serve cached verdicts first; only genuinely-new companies spend the sweep budget.
  const toFetch: string[] = [];
  for (const name of names) {
    const hit = cache.get(norm(name));
    if (hit && Date.now() - hit.at < CACHE_MS) {
      if (hit.stack) out.set(name, hit.stack);
    } else {
      toFetch.push(name);
    }
  }
  const budget = toFetch.slice(0, maxCompaniesPerTick());
  if (!budget.length) return out;

  const deadline = Date.now() + sweepTimeboxMs();
  const source = new NewsRssSource();
  for (let i = 0; i < budget.length; i += BATCH) {
    if (Date.now() >= deadline) break; // out of time: the rest stay uncached and retry next tick
    const batch = budget.slice(i, i + BATCH);
    try {
      const { signals } = await source.pull({ watchlist: { companyNames: batch } });
      for (const name of batch) {
        const stack = stackFromSignals(name, signals);
        cache.set(norm(name), { at: Date.now(), stack });
        if (stack) out.set(name, stack);
      }
    } catch {
      /* one bad batch never kills the sweep; those companies retry next tick */
    }
  }
  return out;
}
