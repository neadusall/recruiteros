/**
 * RecruitersOS · In-Market · LIVE ENRICHMENT FEED
 *
 * A bounded, in-memory feed of the most recent per-company enrichment events, so the Hire Signals
 * curation view can show searches PROGRESSING in real time: a company is CLAIMED (searching), then
 * comes back NAMED (a real decision-maker found), VERIFIED (email confirmed), or MISSED. Pure live
 * telemetry — it feeds the `curation_funnel` read, resets on redeploy (like fleet.ts), and is capped
 * so a flood of companies can never grow it unbounded. ONE row per company: the latest state wins and
 * only advances forward (searching → named → verified), so the UI reads as clean progression, not
 * flicker. Single main process → an in-memory map is enough.
 */

export type EnrichState = "searching" | "named" | "verified" | "missed";

export interface EnrichEvent {
  at: number;            // epoch ms of the latest transition
  company: string;
  role?: string;
  worker?: string;
  state: EnrichState;
  manager?: string;      // decision-maker name, once found
}

const MAX = 240;                              // a few minutes of fleet-wide activity, bounded
const feed = new Map<string, EnrichEvent>();  // keyed by company → one live row, latest state wins

function key(company: string): string { return company.toLowerCase().trim().slice(0, 120); }
function rank(s: EnrichState): number { return s === "searching" ? 0 : s === "missed" ? 1 : s === "named" ? 2 : 3; }

function evict(): void {
  while (feed.size > MAX) {
    let oldest: string | null = null, t = Infinity;
    for (const [k, v] of feed) if (v.at < t) { t = v.at; oldest = k; }
    if (oldest === null) break;
    feed.delete(oldest);
  }
}

function put(ev: EnrichEvent): void {
  const k = key(ev.company);
  if (!k) return;
  const prev = feed.get(k);
  // Never move a company BACKWARD within a live window (a late "searching" claim shouldn't un-name a
  // company that just came back named) — just refresh its timestamp so it stays near the top.
  if (prev && rank(ev.state) < rank(prev.state) && ev.at - prev.at < 120_000) {
    prev.at = ev.at;
    return;
  }
  feed.set(k, { role: prev?.role, manager: prev?.manager, ...ev });
  evict();
}

/** A worker CLAIMED companies to research this cycle — show each as searching. */
export function recordClaimed(worker: string, items: Array<{ company?: string | null; role?: string | null }>): void {
  const now = Date.now();
  for (const it of items) {
    const company = String(it?.company ?? "").trim();
    if (company) put({ at: now, company, role: it?.role ? String(it.role).slice(0, 120) : undefined, worker, state: "searching" });
  }
}

/** A worker SUBMITTED researched rows — advance each company to named (person found) or missed. */
export function recordResearched(
  worker: string,
  rows: Array<{ company?: string | null; managerName?: string | null; emailValidated?: boolean }>,
): void {
  const now = Date.now();
  for (const r of rows) {
    const company = String(r?.company ?? "").trim();
    if (!company) continue;
    const manager = r?.managerName ? String(r.managerName).slice(0, 120) : undefined;
    const state: EnrichState = r?.emailValidated ? "verified" : manager ? "named" : "missed";
    put({ at: now, company, worker, state, manager });
  }
}

/** Email verification confirmed a company's contact — mark it verified (the completed state). */
export function recordVerified(company: string | null | undefined, manager?: string | null): void {
  const c = String(company ?? "").trim();
  if (c) put({ at: Date.now(), company: c, manager: manager ? String(manager).slice(0, 120) : undefined, state: "verified" });
}

/** Newest-first snapshot for the UI. */
export function recentEnrichment(limit = 60): EnrichEvent[] {
  const cap = Math.max(1, Math.min(limit, MAX));
  return Array.from(feed.values()).sort((a, b) => b.at - a.at).slice(0, cap);
}
