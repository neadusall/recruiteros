/**
 * RecruitersOS · Free company-size resolution
 *
 * Fills in a company's headcount band so the In-Market size filter is actually useful,
 * using ONLY free, keyless sources:
 *
 *   1. Wikidata (property P1128 "employees") — authoritative employee counts for
 *      established/known companies, no key, generous rate limits. Cached permanently
 *      (size changes slowly) in the engine's KV snapshot layer.
 *   2. Heuristic estimate — for the long tail Wikidata doesn't cover (small/private
 *      companies), infer a rough band from signals we already have (number of open roles +
 *      funding/IPO signal). Clearly marked as an estimate so it never masquerades as fact.
 *
 * Authoritative always wins over the estimate. Resolution is cached and enriched in the
 * background (a small rotating batch per accumulator cycle), so over time the pool carries
 * real sizes without ever hitting a paid provider.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import type { InMarketLead } from "./index";

type Band = "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1001-5000" | "5000+";

const CACHE_KEY = "inmarket_company_size_v1";
const FRESH_MS = 60 * 24 * 60 * 60 * 1000;   // re-check a known size after 60 days
const NEG_MS = 14 * 24 * 60 * 60 * 1000;     // re-try an unresolved company after 14 days
const UA = "RecruitersOS/1.0 (https://recruitersos.co)";

/** Employee ceiling for the pool: we don't pursue enterprises bigger than this (SMB/mid-
 *  market focus). Enforced on AUTHORITATIVE counts only — a company is excluded only when we
 *  can positively confirm it's too big, never on a heuristic estimate. */
export const MAX_EMPLOYEES = 5_000;

interface SizeEntry { band: Band | null; count?: number; src: "wikidata" | "none"; at: number }
type SizeMap = Record<string, SizeEntry>;

function nameKey(name: string): string { return (name || "").toLowerCase().trim(); }

/** Map an exact employee count to our headcount band. */
export function bandFromCount(n: number): Band {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5000+";
}

/** A rough band when no authoritative source exists, inferred from the hiring footprint we
 *  already observed. Deliberately conservative; always flagged as an estimate by the caller. */
export function heuristicBand(lead: Pick<InMarketLead, "roles" | "signalType" | "reason">): Band {
  const roles = lead.roles?.length ?? 0;
  const text = `${lead.signalType} ${lead.reason ?? ""}`.toLowerCase();
  const big = /\b(ipo|s-1|public|enterprise|fortune|series [d-z]|nasdaq|nyse)\b/.test(text);
  const mid = /\b(series c|unicorn|expansion|nationwide)\b/.test(text);
  let band: Band;
  if (roles >= 12) band = "201-500";
  else if (roles >= 6) band = "51-200";
  else if (roles >= 3) band = "11-50";
  else band = "11-50";
  if (big) band = bandFromCount(6000);
  else if (mid) band = bandFromCount(800);
  return band;
}

async function loadCache(): Promise<SizeMap> {
  const s = await loadSnapshot<SizeMap>(CACHE_KEY);
  return s && typeof s === "object" ? s : {};
}

/** The current size cache (company → band/count), for the search path to apply synchronously. */
export async function loadSizeMap(): Promise<SizeMap> {
  return loadCache().catch(() => ({}));
}

/** Company keys (lowercased names) we've AUTHORITATIVELY confirmed exceed the employee cap,
 *  so the accumulator can purge them from the pool. Heuristic estimates are never included —
 *  only real Wikidata counts above `max`. Keys match pool keyOf() (lowercased company name). */
export async function oversizedCompanyKeys(max = MAX_EMPLOYEES): Promise<Set<string>> {
  const cache = await loadCache().catch(() => ({} as SizeMap));
  const out = new Set<string>();
  for (const k of Object.keys(cache)) {
    const e = cache[k];
    if (e && e.src === "wikidata" && typeof e.count === "number" && e.count > max) out.add(k);
  }
  return out;
}

// 10s hard timeout: a hung Wikidata socket must NEVER stall the accumulator's size pass.
// Without this an unresponsive endpoint leaves the await pending forever, which wedges the
// whole hourly cycle behind its overlap guard (it never feeds leads again until a restart).
const SIZE_FETCH_TIMEOUT_MS = 10_000;
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(SIZE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

/** Looks organization-ish? Cheap guard against matching a non-company Wikidata entity. */
function looksLikeOrg(desc?: string): boolean {
  if (!desc) return false;
  return /\b(company|corporation|business|enterprise|firm|manufacturer|retailer|bank|airline|brand|organization|organisation|startup|chain|conglomerate|provider|agency|institution|publisher|developer|studio|group)\b/i.test(desc);
}

/** Resolve one company's employee count from Wikidata (P1128). Two keyless calls:
 *  find the entity, then read its employees claim. Returns null when not found. */
async function wikidataSize(name: string): Promise<{ band: Band; count: number } | null> {
  const search = await getJson<{ search?: Array<{ id: string; description?: string; label?: string }> }>(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=3&format=json&origin=*`,
  );
  const hit = (search?.search ?? []).find((h) => looksLikeOrg(h.description)) ?? search?.search?.[0];
  if (!hit?.id) return null;
  const claims = await getJson<{ claims?: { P1128?: Array<{ mainsnak?: { datavalue?: { value?: { amount?: string } } } }> } }>(
    `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${hit.id}&property=P1128&format=json&origin=*`,
  );
  const arr = claims?.claims?.P1128 ?? [];
  const last = arr[arr.length - 1];
  const raw = last?.mainsnak?.datavalue?.value?.amount;
  if (!raw) return null;
  const count = Math.abs(parseInt(String(raw).replace(/^\+/, ""), 10));
  if (!isFinite(count) || count <= 0) return null;
  return { band: bandFromCount(count), count };
}

/** Enrich a batch of company names from Wikidata, writing results (positive + negative) to
 *  the cache. Rate-disciplined: caps how many uncached companies it resolves per call, in
 *  small concurrent chunks. Safe no-op without a database. */
export async function enrichSizesBatch(names: string[], max = 25): Promise<number> {
  const cache = await loadCache();
  const now = Date.now();
  const isStale = (e?: SizeEntry) =>
    !e || (e.src === "wikidata" ? now - e.at > FRESH_MS : now - e.at > NEG_MS);
  const todo: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const k = nameKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (isStale(cache[k])) todo.push(n);
    if (todo.length >= max) break;
  }
  if (!todo.length) return 0;
  let resolved = 0;
  for (let i = 0; i < todo.length; i += 5) {
    const chunk = todo.slice(i, i + 5);
    const results = await Promise.all(chunk.map((n) => wikidataSize(n).catch(() => null)));
    chunk.forEach((n, j) => {
      const r = results[j];
      cache[nameKey(n)] = r
        ? { band: r.band, count: r.count, src: "wikidata", at: now }
        : { band: null, src: "none", at: now };
      if (r) resolved++;
    });
  }
  await saveSnapshot(CACHE_KEY, cache);
  return resolved;
}

/** Fill each lead's headcount band from the size cache (authoritative) or a heuristic
 *  estimate, so the size filter always has something to narrow on. Mutates + returns the
 *  leads. `sizeEstimated` marks heuristic guesses; `employeeCount` carries the real number
 *  when Wikidata had it. Leads that already had a resolved band are left untouched. */
export function fillSizes(leads: InMarketLead[], cache: SizeMap): InMarketLead[] {
  for (const l of leads) {
    const cached = cache[nameKey(l.company)];
    if (cached && cached.band) {
      l.headcountBand = cached.band;
      l.employeeCount = cached.count;
      l.sizeEstimated = false;
    } else if (!l.headcountBand) {
      l.headcountBand = heuristicBand(l);
      l.sizeEstimated = true;
    }
  }
  return leads;
}
