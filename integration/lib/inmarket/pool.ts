/**
 * RecruitersOS · In-Market signal pool
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
import { industryTokens, dedupeLeads, deriveHiringIntentType } from "./index";
import { isStaffingFirm } from "./employer";

const KEY = "inmarket_pool_v1";
const MAX_POOL = 15000;                        // cap the stored blob
const TTL_MS = 90 * 24 * 60 * 60 * 1000;       // keep a 90-day window of hiring activity
export const WINDOW_DAYS = 90;                 // the DB retention window, surfaced in the UI

interface PoolEntry { lead: InMarketLead; at: number; firstAt?: number } // at = last-seen, firstAt = first-seen (epoch ms)

async function load(): Promise<PoolEntry[]> {
  const s = await loadSnapshot<PoolEntry[]>(KEY);
  if (!Array.isArray(s)) return [];
  // Backfill firstAt for entries stored before we tracked it (approximate with last-seen).
  for (const e of s) if (e.firstAt == null) e.firstAt = e.at;
  return s;
}

function keyOf(l: InMarketLead): string {
  return (l.company || l.id || "").toLowerCase().trim();
}

/** Merge freshly collected leads into the pool (dedupe by company, keep highest score,
 *  refresh freshness, expire stale, cap size), and record how many NEW companies were
 *  added today for the activity ticker. No-op without a database. */
export async function mergeIntoPool(leads: InMarketLead[]): Promise<void> {
  // STAFFING GATE (write side): never STORE a staffing/recruiting agency, even if a caller
  // hands one in. collectLeads already filters at ingestion; this is defense-in-depth so the
  // persistent pool can never hold an agency regardless of which path wrote it.
  leads = leads.filter((l) => !isStaffingFirm(l.company));
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
    // Preserve the FIRST time we ever saw this company; stamp it onto the lead as addedAt
    // so the UI can search by "added to our database" date.
    const firstAt = cur?.firstAt ?? now;
    if (!cur || (l.score ?? 0) >= (cur.lead.score ?? 0)) {
      l.addedAt = new Date(firstAt).toISOString();
      byKey.set(k, { lead: l, at: now, firstAt });
    } else {
      cur.at = now;                 // keep the higher-scored lead, mark it freshly seen
      cur.firstAt = firstAt;
      cur.lead.addedAt = new Date(firstAt).toISOString();
    }
  }
  let merged = [...byKey.values()].filter((e) => now - e.at < TTL_MS);
  merged.sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  if (merged.length > MAX_POOL) merged = merged.slice(0, MAX_POOL);
  await saveSnapshot(KEY, merged);
  await recordAdded(added, merged.length);
}

/* ---- Accumulation activity stats (the "newly added today" ticker) ---- */
const STATS_KEY = "inmarket_pool_stats_v1";
interface PoolStats {
  total: number;                 // companies currently in the pool
  positions?: number;            // total open roles summed across the pool (live)
  lastAddedAt: string | null;
  days: Record<string, number>;  // companies added, by day
}

function today(): string { return new Date().toISOString().slice(0, 10); }

async function recordAdded(added: number, total: number): Promise<void> {
  const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
  s.total = total;
  if (added > 0) {
    const d = today();
    s.days[d] = (s.days[d] || 0) + added;
    s.lastAddedAt = new Date().toISOString();
  }
  // keep a 90-day history (matches the DB window)
  const keep = Object.keys(s.days).sort().slice(-WINDOW_DAYS);
  s.days = keep.reduce((m, k) => { m[k] = s.days[k]; return m; }, {} as Record<string, number>);
  await saveSnapshot(STATS_KEY, s);
}

/** Count the open roles a lead represents: its expanded board if we have it, else the role(s)
 *  it surfaced with, else 1 (a hiring company always has at least the role that surfaced it). */
function positionsOf(l: InMarketLead): number {
  return (l.roleDetails?.length || l.roles?.length || 1);
}

/** Recompute and persist the live aggregate metrics (companies + total open positions across
 *  the whole pool). Called at the end of each accumulator cycle so the Hire Signals banner
 *  shows a running, daily-growing open-positions count without the read path summing 15k
 *  leads on every request. No-op without a database. */
export async function recomputePoolMetrics(): Promise<{ total: number; positions: number }> {
  const pool = await load();
  const total = pool.length;
  let positions = 0;
  for (const e of pool) positions += positionsOf(e.lead);
  const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
  s.total = total;
  s.positions = positions;
  await saveSnapshot(STATS_KEY, s);
  return { total, positions };
}

/** Activity stats for the UI ticker: companies in pool, total open positions, added today,
 *  last update, the 90-day DB window, and the recent per-day history (most recent first). */
export async function poolStats(): Promise<{
  total: number; openPositions: number; windowDays: number;
  addedToday: number; lastAddedAt: string | null;
  days: Array<{ date: string; added: number }>;
}> {
  const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
  const days = Object.keys(s.days).sort().reverse().slice(0, 7).map((date) => ({ date, added: s.days[date] }));
  return {
    total: s.total, openPositions: s.positions || 0, windowDays: WINDOW_DAYS,
    addedToday: s.days[today()] || 0, lastAddedAt: s.lastAddedAt, days,
  };
}

function leadMatches(lead: InMarketLead, q: InMarketQuery): boolean {
  if (q.signalTypes?.length && !q.signalTypes.includes(lead.signalType as never)) return false;
  if (q.companyName) {
    return lead.company.toLowerCase().includes(q.companyName.toLowerCase().trim());
  }
  // Title search: at least one open role's TITLE must match the keywords (substring).
  if (q.roleQuery && q.roleQuery.trim()) {
    const toks = q.roleQuery.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length >= 2);
    if (toks.length) {
      const titles = (lead.roleDetails?.map((d) => d.title) ?? lead.roles ?? []).join(" || ").toLowerCase();
      if (!toks.some((t) => titles.includes(t))) return false;
    }
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
  // STAFFING GATE (read side): filter agencies out of every result set, so even legacy pool
  // entries stored before this gate existed never surface in Hire Signals. The purge below
  // removes them permanently; this guarantees they're invisible in the meantime.
  const leads = pool.map((e) => e.lead).filter((l) => !isStaffingFirm(l.company) && leadMatches(l, q));
  return dedupeLeads(leads).slice(0, limit);
}

/** Total companies currently in the pool (for diagnostics). */
export async function poolSize(): Promise<number> {
  return (await load()).length;
}

/** One-time cleanup: drop every stored lead we can't positively place in the United States,
 *  so the existing pool matches the US-only policy. Returns how many were removed. No-op
 *  without a database. */
export async function purgeNonUsFromPool(): Promise<number> {
  const { isUsLead } = await import("./geo");
  const pool = await load();
  if (!pool.length) return 0;
  const kept = pool.filter((e) => isUsLead(e.lead));
  const removed = pool.length - kept.length;
  if (removed > 0) {
    await saveSnapshot(KEY, kept);
    // Keep the activity stats' total honest after the purge.
    const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
    s.total = kept.length;
    await saveSnapshot(STATS_KEY, s);
  }
  return removed;
}

/** Re-derive every stored lead's hiring-intent signal type from the roles we already hold, so
 *  the "Hiring signals" filter spreads across surge / long-open / posting instead of being all
 *  "New job posting". Cheap, idempotent; runs each cycle so the existing pool updates without
 *  waiting on re-expansion. Returns how many leads changed type. No-op without a DB. */
export async function reclassifyHiringIntent(): Promise<number> {
  const pool = await load();
  if (!pool.length) return 0;
  let changed = 0;
  for (const e of pool) {
    const details = e.lead.roleDetails?.length
      ? e.lead.roleDetails
      : (e.lead.roles ?? []).map((title) => ({ title }));
    if (!details.length) continue;
    const next = deriveHiringIntentType(details);
    if (next !== e.lead.signalType) { e.lead.signalType = next; changed++; }
  }
  if (changed) await saveSnapshot(KEY, pool);
  return changed;
}

/** One-time (cheap to re-run) cleanup: permanently drop every stored lead whose company is a
 *  staffing/recruiting agency, so the pool only ever holds real end employers. Runs each
 *  accumulator cycle as a guard, like purgeNonUsFromPool. Returns how many were removed. */
export async function purgeStaffingFromPool(): Promise<number> {
  const pool = await load();
  if (!pool.length) return 0;
  const kept = pool.filter((e) => !isStaffingFirm(e.lead.company));
  const removed = pool.length - kept.length;
  if (removed > 0) {
    await saveSnapshot(KEY, kept);
    const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
    s.total = kept.length;
    await saveSnapshot(STATS_KEY, s);
  }
  return removed;
}

/** Drop every pool company we've authoritatively confirmed exceeds the employee cap (keys
 *  from companySize.oversizedCompanyKeys). Keeps the pool SMB/mid-market and frees slots for
 *  companies actually worth pursuing. Returns how many were removed. No-op without a DB. */
export async function purgeOversizedFromPool(oversizedKeys: Set<string>): Promise<number> {
  if (!oversizedKeys.size) return 0;
  const pool = await load();
  if (!pool.length) return 0;
  const kept = pool.filter((e) => !oversizedKeys.has(keyOf(e.lead)));
  const removed = pool.length - kept.length;
  if (removed > 0) {
    await saveSnapshot(KEY, kept);
    // Keep the activity stats' total honest after the purge.
    const s = (await loadSnapshot<PoolStats>(STATS_KEY)) || { total: 0, lastAddedAt: null, days: {} };
    s.total = kept.length;
    await saveSnapshot(STATS_KEY, s);
  }
  return removed;
}

/** Best-effort ATS/GitHub slug from a company display name: lowercased, legal suffixes
 *  stripped, punctuation removed. e.g. "Stripe, Inc." -> "stripe". Not guaranteed to be a
 *  real slug — the seeded sources fail gracefully on a miss — but resolves the common case
 *  (single-word brands, the bulk of public ATS boards). */
function slugifyCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|plc|sa|ag|srl|bv|pte|group|holdings|technologies|labs|software|systems)\b/g, "")
    .replace(/[.,&'"`/()]/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** A rotating slice of raw company NAMES from the pool (highest-scored first), to feed the
 *  free company-size resolver (Wikidata) in the background. `offset` rotates over cycles. */
export async function poolCompanyNames(offset: number, limit: number): Promise<{ names: string[]; total: number }> {
  const pool = (await load()).sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  const seen = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const idx = (offset + i) % pool.length;
    const nm = (pool[idx].lead.company || "").trim();
    const k = nm.toLowerCase();
    if (!nm || seen.has(k) || isStaffingFirm(nm)) continue;
    seen.add(k);
    names.push(nm);
    if (names.length >= limit) break;
  }
  return { names, total: pool.length };
}

/** Companies whose full ATS board we haven't pulled yet (or not in `staleMs`), highest-
 *  scored first — the background board-expansion works through these. */
export async function poolCompaniesToExpand(limit: number, staleMs: number, excludeKeys?: Set<string>): Promise<Array<{ company: string; domain?: string }>> {
  const now = Date.now();
  const pool = (await load()).sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  const out: Array<{ company: string; domain?: string }> = [];
  for (const e of pool) {
    const at = e.lead.boardExpandedAt ? Date.parse(e.lead.boardExpandedAt) : 0;
    if (at && now - at < staleMs) continue;           // recently expanded → skip
    if (!e.lead.company || isStaffingFirm(e.lead.company)) continue; // never expand an agency board
    // SMB priority: don't spend the expensive full-board pull on companies we've confirmed
    // are over the employee cap — they're about to be purged anyway. Expansion effort goes
    // to SMB/mid-market and not-yet-sized companies first.
    if (excludeKeys?.has(keyOf(e.lead))) continue;
    out.push({ company: e.lead.company, domain: e.lead.domain });
    if (out.length >= limit) break;
  }
  return out;
}

/** Store a company's FULL board (titles + per-role dates) onto its pool lead, so searches and
 *  the deep-dive show every role they're hiring for. Stamps boardExpandedAt either way (a
 *  no-board company is marked so we don't keep retrying it every cycle). */
export async function updateExpandedRoles(
  company: string,
  payload: { roleDetails: Array<{ title: string; postedAt?: string; location?: string }>; source: string },
): Promise<void> {
  const key = (company || "").toLowerCase().trim();
  if (!key) return;
  const pool = await load();
  const e = pool.find((x) => keyOf(x.lead) === key);
  if (!e) return;
  e.lead.boardExpandedAt = new Date().toISOString();
  if (payload.roleDetails.length) {
    e.lead.roleDetails = payload.roleDetails.slice(0, 150);
    e.lead.roles = e.lead.roleDetails.map((d) => d.title);
    e.lead.boardSource = payload.source;
    e.lead.signalType = deriveHiringIntentType(e.lead.roleDetails); // surge / long-open / posting
    const newest = e.lead.roleDetails.map((d) => d.postedAt).filter(Boolean).sort().slice(-1)[0];
    if (newest) { e.lead.postedAt = newest; e.lead.signalAt = e.lead.signalAt || newest; }
  }
  await saveSnapshot(KEY, pool);
}

/** Batched board-expansion writer: applies MANY companies' full boards in ONE load + ONE
 *  save, instead of rewriting the whole pool blob per company. This is what makes a large
 *  per-cycle expansion batch safe on the single-blob KV store — without it, expanding N
 *  companies serialized the entire pool N times. Same per-company semantics as
 *  updateExpandedRoles (stamp boardExpandedAt either way; store up to 150 roles). */
export async function updateExpandedRolesBatch(
  updates: Array<{ company: string; roleDetails: Array<{ title: string; postedAt?: string; location?: string }>; source: string }>,
): Promise<void> {
  if (!updates.length) return;
  const pool = await load();
  const byKey = new Map<string, PoolEntry>();
  for (const e of pool) { const k = keyOf(e.lead); if (k) byKey.set(k, e); }
  const stamp = new Date().toISOString();
  let touched = 0;
  for (const u of updates) {
    const key = (u.company || "").toLowerCase().trim();
    if (!key) continue;
    const e = byKey.get(key);
    if (!e) continue;
    e.lead.boardExpandedAt = stamp;
    touched++;
    if (u.roleDetails.length) {
      e.lead.roleDetails = u.roleDetails.slice(0, 150);
      e.lead.roles = e.lead.roleDetails.map((d) => d.title);
      e.lead.boardSource = u.source;
      e.lead.signalType = deriveHiringIntentType(e.lead.roleDetails); // surge / long-open / posting
      const newest = e.lead.roleDetails.map((d) => d.postedAt).filter(Boolean).sort().slice(-1)[0];
      if (newest) { e.lead.postedAt = newest; e.lead.signalAt = e.lead.signalAt || newest; }
    }
  }
  if (touched) await saveSnapshot(KEY, pool);
}

/** A rotating slice of pool companies that DON'T yet have a resolved domain, highest-scored
 *  first — the background domain-backfill works through these. A domain is the unlock for both
 *  decision-maker research and the email guess, so backfilling it across the pool is what lets
 *  the Hire Signals tab show real people + emails (and feeds the curation contactable rate).
 *  Excludes unmasked-agency clients (their domain was deliberately cleared). */
export async function poolCompaniesMissingDomain(
  offset: number,
  limit: number,
): Promise<{ targets: Array<{ company: string; sourceUrl?: string }>; total: number }> {
  const pool = (await load()).sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  const targets: Array<{ company: string; sourceUrl?: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < pool.length; i++) {
    const idx = (offset + i) % pool.length;
    const l = pool[idx].lead;
    if (l.domain || l.employerUnmasked) continue;        // already has one / domain cleared on purpose
    const k = keyOf(l);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    targets.push({ company: l.company, sourceUrl: l.sourceUrl });
    if (targets.length >= limit) break;
  }
  return { targets, total: pool.length };
}

/** Batched domain writer: stamp resolved domains onto MANY pool leads in ONE load + ONE save
 *  (same single-blob discipline as updateExpandedRolesBatch). Only sets a domain where one is
 *  missing, so it never clobbers a domain a source already provided. */
export async function updateDomainsBatch(
  updates: Array<{ company: string; domain: string }>,
): Promise<number> {
  if (!updates.length) return 0;
  const pool = await load();
  const byKey = new Map<string, PoolEntry>();
  for (const e of pool) { const k = keyOf(e.lead); if (k) byKey.set(k, e); }
  let touched = 0;
  for (const u of updates) {
    const key = (u.company || "").toLowerCase().trim();
    const domain = (u.domain || "").trim().toLowerCase();
    if (!key || !domain) continue;
    const e = byKey.get(key);
    if (!e || e.lead.domain) continue;                    // gone, or already has a domain
    e.lead.domain = domain;
    touched++;
  }
  if (touched) await saveSnapshot(KEY, pool);
  return touched;
}

/** A rotating slice of company slugs from the pool, to seed the watchlist-driven sources
 *  (ATS boards, GitHub orgs) so they deepen role coverage for known companies. Highest-
 *  scored first; `offset` rotates through the whole pool over successive cycles. */
export async function poolCompanySlugs(offset: number, limit: number): Promise<{ slugs: string[]; total: number }> {
  const pool = (await load()).sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const idx = (offset + i) % pool.length;
    const name = pool[idx].lead.company || "";
    if (isStaffingFirm(name)) continue;                // never seed an agency slug
    const s = slugifyCompany(name);
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    slugs.push(s);
    if (slugs.length >= limit) break;
  }
  return { slugs, total: pool.length };
}
