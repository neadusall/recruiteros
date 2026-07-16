/**
 * RecruitersOS · JD Sourcing · KoldInfo DATABASE DISCOVERY (the free Sales-Nav rung).
 *
 * Every other KoldInfo door we drive is ENRICHMENT: it starts from people we already
 * found and fills their contact info. This one is a candidate SOURCE: it asks the
 * 57M-row Business Email DB the Sales-Navigator question directly — "who are the
 * <titles> in <cities/states>?" — via the browser worker's `koldinfo-db-search` flow
 * (one filter query, grid read page by page). Rows come back WITH emails and phones
 * attached, and grid reads spend zero credits, so this is the cheapest per-candidate
 * source in the whole engine list.
 *
 * Shape: build a one-row spec CSV from the ICP → submit to the worker → poll → parse
 * the result CSV into CandidateRows (provider "koldinfo"). Discovery overlaps the web
 * X-ray pass: runDiscovery submits the job first, runs the web engines, then collects.
 */

import type { CandidateICP, CandidateRow } from "./types";
import { US_STATE_FULL } from "./score";
import { submitLaxisJob, getLaxisJob, parseCsv } from "./laxis";

/** Full state name for an abbreviation, capitalized ("nj" → "New Jersey"). */
function stateFullName(abbrev: string): string | undefined {
  const full = US_STATE_FULL[abbrev.toLowerCase()];
  return full ? full.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : undefined;
}
const ABBREV_BY_FULL: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_FULL).map(([ab, full]) => [full, ab.toUpperCase()]),
);

/**
 * ICP geos → the DB filter's city and state chips. "Fair Lawn, NJ" contributes city
 * "Fair Lawn" plus state chips "NJ" AND "New Jersey" (Contains is a substring test,
 * so neither form matches the other — both ride as chips). A geo with no comma is
 * treated as a state when it IS one ("New Jersey"), else as a city/metro name.
 */
export function geoChips(geos: string[]): { cities: string[]; states: string[] } {
  const cities = new Set<string>();
  const states = new Set<string>();
  const addState = (s: string) => {
    const t = s.trim();
    if (!t) return;
    const lower = t.toLowerCase();
    if (US_STATE_FULL[lower]) { states.add(t.toUpperCase()); const full = stateFullName(t); if (full) states.add(full); }
    else if (ABBREV_BY_FULL[lower]) { states.add(t.replace(/\b[a-z]/g, (ch) => ch.toUpperCase())); states.add(ABBREV_BY_FULL[lower]); }
  };
  for (const geo of geos || []) {
    const parts = (geo || "").split(",").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (parts.length >= 2) {
      // "City, ST" / "City, State": strip metro suffixes so the chip matches the DB's city values.
      const city = parts[0].replace(/\b(greater|area|metro(politan)?( area)?|metroplex)\b/gi, "").replace(/\s+/g, " ").trim();
      if (city) cities.add(city);
      addState(parts[1]);
    } else {
      const solo = parts[0];
      const lower = solo.toLowerCase();
      if (US_STATE_FULL[lower] || ABBREV_BY_FULL[lower]) addState(solo);
      else {
        const city = solo.replace(/\b(greater|area|metro(politan)?( area)?|metroplex)\b/gi, "").replace(/\s+/g, " ").trim();
        if (city) cities.add(city);
      }
    }
  }
  return { cities: [...cities].slice(0, 8), states: [...states].slice(0, 6) };
}

function pipeCell(values: string[]): string {
  const s = values.map((v) => v.replace(/\|/g, " ").trim()).filter(Boolean).join("|");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The worker's one-row spec CSV, or null when the ICP has nothing the database can
 * filter on (no titles → a geo-only sweep would be noise, so we skip the pass).
 */
export function buildDbDiscoverySpecCsv(icp: CandidateICP, limit: number): string | null {
  const titles = (icp.titles || []).map((t) => t.trim()).filter(Boolean).slice(0, 8);
  if (!titles.length) return null;
  const { cities, states } = geoChips(icp.geos || []);
  const capped = Math.max(1, Math.min(Math.floor(limit) || 200, 1000));
  return [
    "titles,cities,states,limit",
    [pipeCell(titles), pipeCell(cities), pipeCell(states), String(capped)].join(","),
  ].join("\n") + "\n";
}

/** Parse the worker's discovery result CSV into scored-ready CandidateRows. */
export function parseDbDiscoveryCsv(csv: string): CandidateRow[] {
  const { rows } = parseCsv(csv || "");
  const out: CandidateRow[] = [];
  for (const r of rows) {
    const fullName = (r.full_name || "").trim();
    if (!fullName) continue;
    // A vendor-flagged email must not ride into outreach; the row itself still counts.
    const emailOk = !/unavailable|invalid/i.test(r.email_status || "");
    const city = (r.city || "").trim();
    const state = (r.state || "").trim();
    out.push({
      fullName,
      title: (r.title || "").trim() || undefined,
      headline: (r.seniority || "").trim() || undefined,
      company: (r.company || "").trim() || undefined,
      location: city && state ? `${city}, ${state}` : city || state || undefined,
      linkedinUrl: (r.linkedin_url || "").trim() || undefined,
      email: emailOk ? (r.email || "").trim() || undefined : undefined,
      phone: (r.phone || "").trim() || undefined,
      fitScore: 0,
      fitReasons: [],
      provider: "koldinfo",
    });
  }
  return out;
}

/** Submit the discovery job. Returns the worker jobId, or null when the ICP can't feed it. */
export async function submitDbDiscovery(icp: CandidateICP, limit: number): Promise<string | null> {
  const spec = buildDbDiscoverySpecCsv(icp, limit);
  if (!spec) return null;
  return submitLaxisJob(spec, "koldinfo-db-search");
}

/**
 * Poll the discovery job until it finishes or `deadlineMs` from now passes. A timeout
 * is not an error state on the worker (the job keeps running and its result is kept
 * for 48h) — we just stop waiting so the search request returns.
 */
export async function collectDbDiscovery(jobId: string, deadlineMs: number): Promise<{ rows: CandidateRow[]; error?: string }> {
  const deadline = Date.now() + Math.max(5_000, deadlineMs);
  for (;;) {
    let status;
    try {
      status = await getLaxisJob(jobId);
    } catch (e) {
      return { rows: [], error: (e as Error).message };
    }
    if (status.status === "done") return { rows: parseDbDiscoveryCsv(status.enrichedCsv || "") };
    if (status.status === "error") return { rows: [], error: status.error || "database sweep failed" };
    if (Date.now() >= deadline) {
      return { rows: [], error: "the database sweep was still running when the search finished; its people will appear on the next run" };
    }
    await new Promise((res) => setTimeout(res, 4_000));
  }
}
