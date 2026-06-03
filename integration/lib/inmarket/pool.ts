/**
 * RecruiterOS · In-Market signal pool
 *
 * A persistent, deduped index of hiring-signal leads accumulated in the background so
 * searches read from a deep pool (thousands of companies) instead of hitting providers
 * live on every request. Backed by the engine's Postgres snapshot layer (ros_kv); with
 * no DATABASE_URL it degrades to empty (so search falls back to live).
 *
 * The pool is GLOBAL (market data, not per-workspace) — every workspace reads the same
 * accumulated who's-hiring index, filtered to its query in memory.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import type { InMarketLead, InMarketQuery } from "./index";
import { industryTokens, dedupeLeads } from "./index";

const KEY = "inmarket_pool_v1";
const MAX_POOL = 8000;                         // cap the stored blob
const TTL_MS = 30 * 24 * 60 * 60 * 1000;       // drop leads not seen for 30 days

interface PoolEntry { lead: InMarketLead; at: number } // at = last-seen epoch ms

async function load(): Promise<PoolEntry[]> {
  const s = await loadSnapshot<PoolEntry[]>(KEY);
  return Array.isArray(s) ? s : [];
}

function keyOf(l: InMarketLead): string {
  return (l.company || l.id || "").toLowerCase().trim();
}

/** Merge freshly collected leads into the pool (dedupe by company, keep highest score,
 *  refresh freshness, expire stale, cap size), and record how many NEW companies were
 *  added today for the activity ticker. No-op without a database. */
export async function mergeIntoPool(leads: InMarketLead[]): Promise<void> {
  if (!leads.length) return;
  const now = Date.now();
  const byKey = new Map<string, PoolEntry>();
  for (const e of await load()) {
    const k = keyOf(e.lead);
    if (k) byKey.set(k, e);
  }
  let added = 0; // companies new to the pool this merge
  for (const l of leads) {
    const k = keyOf(l);
    if (!k) continue;
    const cur = byKey.get(k);
    if (!cur) added++;
    if (!cur || (l.score ?? 0) >= (cur.lead.score ?? 0)) byKey.set(k, { lead: l, at: now });
    else cur.at = now; // keep the higher-scored lead, but mark it freshly seen
  }
  let merged = [...byKey.values()].filter((e) => now - e.at < TTL_MS);
  merged.sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  if (merged.length > MAX_POOL) merged = merged.slice(0, MAX_POOL);
  await saveSnapshot(KEY, merged);
  await recordAdded(added, merged.length);
}

/* ---- Accumulation activity stats (the "newly added today" ticker) ---- */
const STATS_KEY = "inmarket_pool_stats_v1";
interface PoolStats { total: number; lastAddedAt: string | null; days: Record<string, number> }

function today(): string { return new Date().toISOString().slice(0, 10); }

async function recordAdded(added: number, total: number): Promise<void> {
  const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
  s.total = total;
  if (added > 0) {
    const d = today();
    s.days[d] = (s.days[d] || 0) + added;
    s.lastAddedAt = new Date().toISOString();
  }
  // keep ~21 days of history
  const keep = Object.keys(s.days).sort().slice(-21);
  s.days = keep.reduce((m, k) => { m[k] = s.days[k]; return m; }, {} as Record<string, number>);
  await saveSnapshot(STATS_KEY, s);
}

/** Activity stats for the UI ticker: total in pool, added today, last update, and the
 *  recent per-day history (most recent first). */
export async function poolStats(): Promise<{
  total: number; addedToday: number; lastAddedAt: string | null;
  days: Array<{ date: string; added: number }>;
}> {
  const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
  const days = Object.keys(s.days).sort().reverse().slice(0, 7).map((date) => ({ date, added: s.days[date] }));
  return { total: s.total, addedToday: s.days[today()] || 0, lastAddedAt: s.lastAddedAt, days };
}

function leadMatches(lead: InMarketLead, q: InMarketQuery): boolean {
  if (q.signalTypes?.length && !q.signalTypes.includes(lead.signalType as never)) return false;
  if (q.companyName) {
    return lead.company.toLowerCase().includes(q.companyName.toLowerCase().trim());
  }
  const toks = industryTokens(q.industries ?? []);
  if (toks.length) {
    const hay = (lead.company + " " + (lead.industry ?? "") + " " + lead.reason + " " + (lead.roles?.join(" ") ?? "")).toLowerCase();
    if (!toks.some((t) => hay.includes(t))) return false;
  }
  if (q.query) {
    const terms = q.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length) {
      const hay = (lead.company + " " + (lead.industry ?? "") + " " + lead.reason).toLowerCase();
      if (!terms.some((t) => hay.includes(t))) return false;
    }
  }
  return true;
}

/** Read leads matching a query from the pool, deduped + score-sorted, up to `limit`. */
export async function queryPool(q: InMarketQuery, limit: number): Promise<InMarketLead[]> {
  const pool = await load();
  const leads = pool.map((e) => e.lead).filter((l) => leadMatches(l, q));
  return dedupeLeads(leads).slice(0, limit);
}

/** Total companies currently in the pool (for diagnostics). */
export async function poolSize(): Promise<number> {
  return (await load()).length;
}
