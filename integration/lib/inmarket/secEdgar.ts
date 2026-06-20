/**
 * RecruitersOS · In-Market · SEC EDGAR officer/director NAME source (free, authoritative)
 *
 * Public companies (and recent filers) MUST name their officers and directors in SEC filings, by law.
 * Form 3/4 "insider" filings are the cleanest: each one carries a STRUCTURED reporting owner — the
 * person's name plus their exact `officerTitle` (e.g. "CHIEF FINANCIAL OFFICER") and isOfficer/isDirector
 * flags. We read those directly: no scraping a live site, no key, no anti-bot — datacenter IPs are the
 * expected client. This names the exact funded / IPO / M&A companies that are our highest-value signals,
 * which the rest of the free pipeline (team pages, news, search) often can't reach.
 *
 * Two hops, both bounded + timed + try/caught (this module NEVER throws — returns [] on any miss):
 *   1. EDGAR full-text search (efts) for the company across insider forms → recent filings, each with the
 *      reporting owner's name + CIK and the issuer (so we confirm it's OUR company, not a namesake).
 *   2. Fetch a few of those filings' XML to read the authoritative officerTitle + isOfficer/isDirector.
 * Cached per company (positive 30d / negative 7d) and rested by a failure circuit-breaker, so we stay
 * polite to SEC at pool scale.
 *
 * NAME ORDER: EDGAR stores reporting-owner names "Last First Middle" ("Riley Janel" = Janel Riley). We
 * reorder to natural "First Middle Last" so the name + email guess are right.
 */

import { companyAnchor } from "../signals/hiring/normalize";
import type { PersonCandidate } from "../signals/hiring/peopleGraph";

const UA = process.env.SEC_EDGAR_USER_AGENT ?? "RecruitersOS signal-engine contact@recruitersos.co";
const FTS = "https://efts.sec.gov/LATEST/search-index";
const ARCH = "https://www.sec.gov/Archives/edgar/data";
const FTS_TIMEOUT_MS = 10_000;
const DOC_TIMEOUT_MS = 8_000;
const MAX_HITS = 30;     // FTS hits scanned per company
const MAX_OWNERS = 8;    // distinct insiders considered
const MAX_DOCS = 5;      // filing XMLs fetched (for authoritative titles) — bounds SEC load per company
const CACHE_MAX = 20_000;
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Entity tokens that mark a "person" name as actually a fund/holder, not a human — never a decision-maker.
const ENTITY_RE = /\b(llc|l\.l\.c|lp|l\.p|inc|corp|ltd|fund|funds|capital|partners|trust|holdings|ventures|management|group|associates|advisors|gmbh|ag|plc)\b/i;

const cache = new Map<string, { at: number; people: PersonCandidate[] }>();

let recentFails = 0;
let restUntil = 0;
function note(ok: boolean): void {
  if (ok) { recentFails = 0; return; }
  if (++recentFails >= 8) { restUntil = Date.now() + 5 * 60 * 1000; recentFails = 0; }
}
function resting(): boolean { return Date.now() < restUntil; }

export function secEdgarHealth(): { resting: boolean; restingForSec: number; cachedCompanies: number } {
  return {
    resting: resting(),
    restingForSec: resting() ? Math.round((restUntil - Date.now()) / 1000) : 0,
    cachedCompanies: cache.size,
  };
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(FTS_TIMEOUT_MS) });
    if (!r.ok) { note(r.status < 500); return null; } // 4xx = "no results" (CC is up); 5xx counts against breaker
    note(true);
    return await r.json();
  } catch { note(false); return null; }
}

async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(DOC_TIMEOUT_MS) });
    if (!r.ok) { note(false); return null; }
    note(true);
    return await r.text();
  } catch { note(false); return null; }
}

/** Strip the "(CIK 000…)" / "(TICKER)" parentheticals EDGAR appends to a display name. */
function stripParens(s: string): string {
  return String(s).replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/** EDGAR "Last First Middle" → natural "First Middle Last". */
function naturalName(secName: string): string {
  const parts = stripParens(secName).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(" ");
  return [...parts.slice(1), parts[0]].join(" ");
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

/** A real human name (2–4 words, no entity tokens). Standalone to avoid an import cycle with decisionMaker. */
function isPersonName(s: string): boolean {
  if (ENTITY_RE.test(s)) return false;
  const n = s.split(/\s+/).filter(Boolean).length;
  return n >= 2 && n <= 4;
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}
function boolTag(xml: string, name: string): boolean {
  return new RegExp(`<${name}>\\s*(1|true)\\s*</${name}>`, "i").test(xml);
}

interface Owner { name: string; cik: string; accNoDash: string; filename: string }

/**
 * Return the named officers/directors of a company from SEC insider filings (best-effort, cached).
 * [] on any miss/outage/non-filer — never throws. Each candidate carries source "sec_edgar" so the
 * resolver scores it (and the provenance floor keeps it if the exact title doesn't match the role).
 */
export async function edgarOfficers(company: string): Promise<PersonCandidate[]> {
  const anchor = companyAnchor(company);
  if (!anchor || anchor.length < 2) return [];

  const cached = cache.get(anchor);
  if (cached && Date.now() - cached.at < (cached.people.length ? POS_TTL_MS : NEG_TTL_MS)) return cached.people;
  if (resting()) return cached?.people ?? [];

  // 1) Find recent insider (Form 3/4) filings that mention this company.
  const j = await getJson(`${FTS}?q=${encodeURIComponent(`"${company}"`)}&forms=3,4`) as
    { hits?: { hits?: Array<{ _id?: string; _source?: { display_names?: string[]; ciks?: string[] } }> } } | null;
  const hits = j?.hits?.hits ?? [];

  // Collect DISTINCT insiders whose ISSUER is actually our company (not a namesake mention).
  const owners = new Map<string, Owner>();
  for (const h of hits.slice(0, MAX_HITS)) {
    const dn = h._source?.display_names ?? [];
    const ciks = h._source?.ciks ?? [];
    if (dn.length < 2 || ciks.length < 2 || !h._id) continue;
    const issuerIdx = dn.findIndex((s) => companyAnchor(stripParens(s)) === anchor);
    if (issuerIdx < 0) continue;
    const ownerIdx = dn.findIndex((_, i) => i !== issuerIdx);
    if (ownerIdx < 0) continue;
    const ownerName = stripParens(dn[ownerIdx]);
    const ownerCik = String(ciks[ownerIdx] ?? "").replace(/^0+/, "");
    if (!ownerCik || owners.has(ownerCik) || !isPersonName(ownerName)) continue;
    const [acc, filename] = String(h._id).split(":");
    if (!acc || !filename) continue;
    owners.set(ownerCik, { name: ownerName, cik: ownerCik, accNoDash: acc.replace(/-/g, ""), filename });
    if (owners.size >= MAX_OWNERS) break;
  }

  // 2) Read each insider's filing for the authoritative title + officer/director flags.
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  let docs = 0;
  for (const o of owners.values()) {
    if (docs >= MAX_DOCS) break;
    docs++;
    const xml = await getText(`${ARCH}/${o.cik}/${o.accNoDash}/${o.filename}`);
    if (!xml) continue;
    const isOfficer = boolTag(xml, "isOfficer");
    const isDirector = boolTag(xml, "isDirector");
    if (!isOfficer && !isDirector) continue;                       // skip pure 10% holders / funds
    const rawTitle = tag(xml, "officerTitle");
    const title = rawTitle ? titleCase(rawTitle) : isDirector ? "Board Director" : "Officer";
    const full = naturalName(o.name);
    if (!isPersonName(full)) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const [firstName, ...rest] = full.split(/\s+/);
    out.push({
      fullName: full,
      firstName,
      lastName: rest.join(" "),
      title,
      headline: title,
      source: "sec_edgar",
      companyName: company,
    } as PersonCandidate);
  }

  if (cache.size >= CACHE_MAX) {
    for (const k of cache.keys()) { cache.delete(k); if (cache.size < CACHE_MAX * 0.9) break; }
  }
  cache.set(anchor, { at: Date.now(), people: out });
  return out;
}
