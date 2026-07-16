/**
 * RecruitersOS · JD Sourcing · FREE in-house phone rung (LandlineDB).
 *
 * LandlineDB is our own Postgres of ~2.9M public-record contact rows (FMCSA carriers,
 * CMS/NPPES healthcare, state license boards…), ~2.5M of them with a named person AND a
 * phone, ~960k with an explicit cell (cell_e164). It costs nothing to query, so it runs
 * BEFORE any paid phone lookup in the gap-fill.
 *
 * Matching is deliberately conservative: texting the WRONG person is worse than finding
 * no number. A row is accepted only when the full name matches exactly AND either the
 * company corroborates it or it is the single name-match in the candidate's own state.
 * Cell numbers win over office lines; OS Text's Telnyx gate still validates line type.
 *
 * Environments without the database (local dev) probe once, fail fast, and disable the
 * rung for the life of the process — the gap-fill just moves on to the next source.
 */

import type { CandidateRow } from "./types";
import { landlineDb } from "../landline/db";

const STATE_ABBREV: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

/** Best-effort US state abbreviation out of a free-text location ("Fair Lawn, NJ",
 *  "New Jersey", "Greater Chicago Area" → ""). Empty when unknown. */
export function stateFromLocation(location?: string): string {
  const loc = (location || "").toLowerCase();
  if (!loc) return "";
  for (const [name, ab] of Object.entries(STATE_ABBREV)) {
    if (loc.includes(name)) return ab;
  }
  const m = (location || "").match(/(?:^|[\s,])([A-Z]{2})(?:$|[\s,.)])/);
  if (m && Object.values(STATE_ABBREV).includes(m[1])) return m[1];
  return "";
}

const normName = (s?: string): string => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Significant lowercase tokens of a company name (legal suffixes and glue dropped). */
function companyTokens(s?: string): Set<string> {
  const STOP = new Set(["inc", "llc", "ltd", "corp", "co", "company", "the", "of", "and", "group", "services", "service", "solutions"]);
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

interface DbRow {
  person: string | null;
  company: string | null;
  state: string | null;
  cell_e164: string | null;
  phone_e164: string | null;
}

// One availability probe per process: no DB (dev box) → the rung is off, silently.
let available: Promise<boolean> | null = null;
function dbAvailable(): Promise<boolean> {
  if (!available) {
    available = landlineDb()
      .query("SELECT 1 FROM records LIMIT 1")
      .then(() => true)
      .catch(() => false);
  }
  return available;
}

/** Is the in-house phone database reachable? (Search-power readout.) */
export function landlineDbReady(): Promise<boolean> {
  return dbAvailable();
}

/**
 * Fill phones on `rows` (blanks only) from LandlineDB. Mutates in place; returns how
 * many rows gained a phone. Batched (one query per ~300 names), so big lists stay fast.
 */
export async function fillPhonesFromLandlineDb(rows: CandidateRow[]): Promise<number> {
  const want = rows.filter((c) => !(c.phone || "").trim() && normName(c.fullName).split(" ").length >= 2);
  if (!want.length) return 0;
  if (!(await dbAvailable())) return 0;

  const names = Array.from(new Set(want.map((c) => normName(c.fullName))));
  const byName = new Map<string, DbRow[]>();
  const db = landlineDb();
  for (let i = 0; i < names.length; i += 300) {
    const chunk = names.slice(i, i + 300);
    try {
      const res = await db.query(
        `SELECT person, company, state, cell_e164, phone_e164
           FROM records
          WHERE lower(person) = ANY($1)
            AND (cell_e164 IS NOT NULL OR phone_e164 IS NOT NULL)
          LIMIT 5000`,
        [chunk],
      );
      for (const r of res.rows as DbRow[]) {
        const key = normName(r.person || "");
        if (!key) continue;
        const list = byName.get(key) || [];
        if (list.length < 25) list.push(r); // a hyper-common name is unmatchable anyway
        byName.set(key, list);
      }
    } catch {
      return 0; // transport hiccup mid-run: stop the rung, never the chain
    }
  }

  let filled = 0;
  for (const c of want) {
    const hits = byName.get(normName(c.fullName));
    if (!hits || !hits.length) continue;
    const candState = stateFromLocation(c.location);
    const candCo = companyTokens(c.company);
    let best: DbRow | null = null;
    let bestScore = 0;
    let stateMatches = 0;
    for (const r of hits) {
      const rowState = (r.state || "").toUpperCase();
      if (candState && rowState && rowState !== candState) continue; // hard conflict
      const co = companyTokens(r.company || "");
      let overlap = 0;
      for (const t of candCo) if (co.has(t)) overlap++;
      const score = (overlap ? 2 : 0) + (candState && rowState === candState ? 1 : 0);
      if (candState && rowState === candState) stateMatches++;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    // Accept on company corroboration, or on a UNIQUE name+state match.
    const ok = best && (bestScore >= 2 || (bestScore === 1 && stateMatches === 1));
    if (!ok || !best) continue;
    const phone = (best.cell_e164 || best.phone_e164 || "").trim();
    if (!phone) continue;
    c.phone = phone;
    filled++;
  }
  return filled;
}
