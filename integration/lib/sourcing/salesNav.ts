/**
 * RecruitersOS · JD Sourcing · Sales Navigator search mode
 *
 * Turns a pasted LinkedIn Sales Navigator (or classic people-search) URL into a
 * JD Sourcing candidate list, reusing the exact machinery every other search uses:
 *
 * 1. Pull the search's actual members through the connected LinkedIn account
 *    (Unipile when configured, the Playwright scraper sidecar as fallback).
 * 2. Read the search's own filters (titles, geos, companies, keywords) out of the
 *    URL and derive a CandidateICP from them, backfilled from the pulled profiles.
 * 3. EXPAND: run the normal discovery waterfall (KoldInfo DB, free web, Serper,
 *    RapidAPI) on that ICP so the list grows beyond what LinkedIn returned.
 *
 * The caller (the `salesNav` API action) merges the result into a NEW named run or
 * into an EXISTING run via the same dedupe used by Combine lists, so re-running a
 * search, or pointing it at an under-enriched list, adds and fills, never duplicates.
 */

import { listLinkedInAccounts } from "../accounts";
import { toEngineAccount } from "../linkedin/console";
import { getProvider, type SearchProfile } from "../linkedin/provider";
import { scraperConfigured, scrapeSearchViaSidecar } from "../linkedin/scraperProvider";
import { cred } from "../providers/http";
import { scoreCandidate } from "./score";
import { generateQueries } from "./generateQueries";
import { runDiscovery } from "./discovery";
import type { CandidateICP, CandidateRow, SearchBreadth, SourcingQuery } from "./types";

/** Filters recovered from the pasted search URL (best-effort, tolerant). */
export interface SalesNavCriteria {
  keywords: string[];
  titles: string[];
  geos: string[];
  companies: string[];
  industries: string[];
}

/** Same stable person key used across JD Sourcing (mergeRuns, seen-set, batches). */
function personKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

/**
 * Which LinkedIn surface a pasted search URL came from. Drives labels only (the
 * pull + expansion machinery is identical): Recruiter URLs live under /talent/
 * (modern) or /recruiter/ (legacy smartsearch), Sales Navigator under /sales/.
 */
export function searchKindOf(url: string): "LinkedIn Recruiter" | "Sales Navigator" | "LinkedIn" {
  if (/linkedin\.com\/(talent|recruiter)\//i.test(url)) return "LinkedIn Recruiter";
  if (/linkedin\.com\/sales\//i.test(url)) return "Sales Navigator";
  return "LinkedIn";
}

const looksLikeId = (v: string) => /^(urn:|\d+$)/i.test(v.trim());

function cleanValue(raw: string): string {
  return raw.replace(/^%22|%22$/g, "").replace(/^"|"$/g, "").replace(/\+/g, " ").trim();
}

function pushUnique(list: string[], v: string): void {
  const val = cleanValue(v);
  if (!val || looksLikeId(val)) return;
  if (!list.some((x) => x.toLowerCase() === val.toLowerCase())) list.push(val);
}

/** Recruiter's legacy params pack alternates into one value ("RN OR Registered Nurse",
 *  "A | B"): split them so each alternate becomes its own ICP entry. */
function pushEach(list: string[], v: string): void {
  for (const part of v.split(/\s+OR\s+|\|/i)) pushUnique(list, part);
}

/** Which ICP bucket a Sales Navigator filter `type:` feeds. */
function bucketFor(type: string): keyof SalesNavCriteria | null {
  if (/TITLE|FUNCTION/.test(type)) return "titles";
  if (/GEO|REGION|POSTAL|STATE|CITY/.test(type)) return "geos";
  if (/COMPANY_HEADCOUNT|COMPANY_TYPE/.test(type)) return null; // size/type bands, not names
  if (/COMPANY/.test(type)) return "companies";
  if (/INDUSTRY/.test(type)) return "industries";
  return null;
}

/**
 * Best-effort read of the search filters INSIDE the URL. Sales Navigator encodes a
 * LISP-ish query DSL (`query=(...,filters:List((type:TITLE,values:List((text:...`),
 * classic people-search uses plain params. Saved-search URLs (`savedSearchId=`)
 * carry no inline filters at all; then the pulled profiles alone shape the ICP.
 */
export function parseSalesNavUrl(url: string): SalesNavCriteria {
  const out: SalesNavCriteria = { keywords: [], titles: [], geos: [], companies: [], industries: [] };
  let text = url;
  // Percent-decode up to twice (Sales Nav double-encodes values inside `query=`).
  for (let i = 0; i < 2; i++) {
    try {
      const dec = decodeURIComponent(text);
      if (dec === text) break;
      text = dec;
    } catch { break; }
  }

  // Free-text keywords: `keywords:foo bar` (DSL) or `keywords=foo` (classic).
  for (const m of text.matchAll(/keywords[:=]([^,&()]+)/gi)) pushUnique(out.keywords, m[1]);

  // Typed filter blocks: slice the DSL at each `(type:` (every filter block opens
  // that way; a bare /type:/ split would also fire on `selectionType:`) and harvest
  // `text:` values within the segment. Slicing sidesteps the nested-paren grammar.
  const segments = text.split(/\(type:/i).slice(1);
  for (const seg of segments) {
    const type = (seg.match(/^([A-Z_]+)/) || [])[1] || "";
    const bucket = bucketFor(type);
    if (!bucket) continue;
    for (const m of seg.matchAll(/text:([^,()]+)/gi)) pushUnique(out[bucket], m[1]);
  }

  // Classic people-search + Recruiter params. Recruiter's legacy smartsearch spells
  // its filters as plain params (searchKeywords, title, locations, companies…);
  // MODERN /talent/search URLs usually carry only opaque ids (the filters live on
  // LinkedIn's side), which correctly parses to empty criteria here: the pulled
  // members then shape the ICP instead.
  try {
    const params = new URL(url).searchParams;
    for (const [key, bucket] of [
      ["titleFreeText", "titles"], ["title", "titles"], ["titles", "titles"], ["jobTitle", "titles"],
      ["company", "companies"], ["currentCompany", "companies"], ["companies", "companies"],
      ["industry", "industries"], ["industries", "industries"],
      ["location", "geos"], ["locations", "geos"], ["geo", "geos"],
      ["searchKeywords", "keywords"],
    ] as Array<[string, keyof SalesNavCriteria]>) {
      const v = params.get(key);
      if (v) pushEach(out[bucket], v);
    }
  } catch { /* not a parseable URL shape; the DSL pass above already ran */ }

  return out;
}

/** Top-N most frequent non-empty values of a field across the pulled profiles. */
function topValues(rows: CandidateRow[], pick: (c: CandidateRow) => string | undefined, n: number): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const r of rows) {
    const raw = (pick(r) || "").replace(/,?\s*(united states|usa)$/i, "").trim();
    if (!raw) continue;
    const k = raw.toLowerCase();
    const e = counts.get(k);
    if (e) e.n++; else counts.set(k, { label: raw, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, n).map((e) => e.label);
}

function inferSeniority(title: string): CandidateICP["seniority"] {
  const t = title.toLowerCase();
  // Word-bounded: "director" contains "cto", "vice president" contains "president".
  if (/\b(chief|cxo|ceo|cfo|coo|cro|cto|founder)\b/.test(t) || /(?<!vice )\bpresident\b/.test(t)) return "exec";
  if (/\bvp\b|vice president/.test(t)) return "vp";
  if (/director|head of/.test(t)) return "director";
  if (/manager|lead\b/.test(t)) return "manager";
  return "ic";
}

/**
 * Build the ICP that drives scoring + the discovery-waterfall expansion: the URL's
 * own filters first (they ARE the recruiter's intent), profile facts as backfill.
 */
export function icpFromSalesNav(criteria: SalesNavCriteria, profiles: CandidateRow[], kindLabel = "Sales Navigator"): CandidateICP {
  const titles = criteria.titles.length ? criteria.titles.slice(0, 8)
    : topValues(profiles, (c) => c.title || c.headline, 6);
  if (!titles.length && criteria.keywords.length) titles.push(...criteria.keywords.slice(0, 4));
  const geos = criteria.geos.length ? criteria.geos.slice(0, 8) : topValues(profiles, (c) => c.location, 4);
  const targetCompanies = criteria.companies.length ? criteria.companies.slice(0, 10)
    : topValues(profiles, (c) => c.company, 8);
  const lead = titles[0] || criteria.keywords[0] || `${kindLabel} search`;
  const seniority = inferSeniority(lead);
  return {
    label: lead + (geos.length ? ` (${geos[0]})` : ""),
    seniority,
    managesTeam: seniority !== "ic",
    titles,
    geos,
    remoteOk: geos.length === 0,
    industries: criteria.industries.slice(0, 6),
    targetCompanies,
    sellsTo: [],
    verticals: [],
    mustHave: criteria.keywords.slice(0, 6),
    niceToHave: [],
    disqualifiers: [],
  };
}

function profileToRow(p: SearchProfile, kindLabel: string): CandidateRow {
  return {
    fullName: p.fullName,
    title: p.title,
    headline: p.headline,
    company: p.company,
    location: p.location,
    linkedinUrl: p.publicProfileUrl,
    imageUrl: p.imageUrl,
    fitScore: 0,
    fitReasons: [],
    sourceGroup: kindLabel.toLowerCase(),
    provider: "linkedin",
  };
}

interface FetchResult { rows: CandidateRow[]; warnings: string[]; account?: string }

/**
 * Pull the search's members through whatever LinkedIn backend is live: a connected
 * account / Unipile seat first, scraper sidecar as fallback. Never throws: a dead
 * LinkedIn leg degrades to warnings and the waterfall expansion still runs, so the
 * bar always produces candidates when the URL carries usable filters.
 */
async function fetchSearchMembers(ws: string, ownerUserId: string, url: string, limit: number, kindLabel: string): Promise<FetchResult> {
  const warnings: string[] = [];
  const core = listLinkedInAccounts(ws).find((a) => a.active && a.warmup !== "flagged");
  const unipileAccountId = cred("UNIPILE_ACCOUNT_ID") || process.env.UNIPILE_ACCOUNT_ID;
  const hasUnipile = Boolean(cred("UNIPILE_DSN") && cred("UNIPILE_API_KEY"));

  // Provider leg: needs a seat to drive. Skip cleanly (not an error) when the
  // workspace has neither a connected account nor a Unipile seat.
  if (core || (hasUnipile && unipileAccountId)) {
    const account = core
      ? toEngineAccount(core, ownerUserId)
      : {
          id: unipileAccountId!, providerAccountId: unipileAccountId!, ownerUserId,
          displayName: "Unipile LinkedIn", status: "ok" as const, premium: true, salesNavigator: true,
          limits: { invitesPerDay: 25, messagesPerDay: 50, inmailsPerDay: 10, profileViewsPerDay: 80, workingHours: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] } },
          timezone: "UTC",
        };
    try {
      const profiles = await getProvider().searchProfiles({ account, url, limit });
      if (profiles.length) {
        return { rows: profiles.map((p) => profileToRow(p, kindLabel)), warnings, account: core?.handle || "Unipile LinkedIn" };
      }
      warnings.push("linkedin(search): the connected account returned no members for this URL");
    } catch (err) {
      warnings.push(`linkedin(search): ${(err as Error).message}`);
    }
  } else {
    warnings.push("linkedin_not_connected: no LinkedIn account or Unipile seat is set up, so the search's own members could not be pulled; candidates below come from the discovery waterfall run on the URL's filters");
  }

  // Scraper sidecar fallback (cookie-authenticated, best-effort).
  if (scraperConfigured()) {
    try {
      const { profiles, warnings: w } = await scrapeSearchViaSidecar(url, Math.min(limit, 100));
      if (w?.length) warnings.push(...w.map((x) => `scraper(salesnav): ${x}`));
      if (profiles.length) return { rows: profiles.map((p) => profileToRow(p, kindLabel)), warnings, account: "scraper sidecar" };
    } catch (err) {
      warnings.push(`scraper(salesnav): ${(err as Error).message}`);
    }
  }
  return { rows: [], warnings };
}

export interface SalesNavRunOptions {
  url: string;
  /** Cap on members pulled from the LinkedIn search itself (default 200, max 500). */
  limit?: number;
  /** Also run the discovery waterfall on the derived ICP (default true). */
  expand?: boolean;
  breadth?: SearchBreadth;
  /** Cap on waterfall-found candidates added on top of the LinkedIn members. */
  cap?: number;
  minFit?: number;
}

export interface SalesNavRunResult {
  candidates: CandidateRow[];
  icp: CandidateICP;
  criteria: SalesNavCriteria;
  queries: SourcingQuery[];
  warnings: string[];
  apiUsage?: { rapidapi?: number; serper?: number; google?: number };
  /** Members pulled straight from the LinkedIn search. */
  linkedinFound: number;
  /** Additional candidates the discovery waterfall contributed. */
  expanded: number;
  account?: string;
}

/**
 * The whole Sales Navigator search mode: pull members, derive the ICP, expand via
 * the standard discovery waterfall, dedupe (LinkedIn rows win; waterfall rows fill
 * their blanks). MUST run inside withWorkspaceCreds so Setup-pasted keys apply.
 */
export async function runSalesNavSourcing(ws: string, ownerUserId: string, opts: SalesNavRunOptions): Promise<SalesNavRunResult> {
  const url = (opts.url || "").trim();
  if (!/^https?:\/\/(www\.)?linkedin\.com\//i.test(url)) {
    const err = new Error("not_a_linkedin_url") as Error & { status: number };
    err.status = 422;
    throw err;
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const kind = searchKindOf(url);
  const criteria = parseSalesNavUrl(url);
  const fetched = await fetchSearchMembers(ws, ownerUserId, url, limit, kind);
  const warnings = [...fetched.warnings];
  // Recruiter's modern /talent/ URLs usually keep their filters on LinkedIn's side
  // (the URL only carries opaque ids). When that happens AND the member pull came
  // back empty, say exactly what to do instead of failing mysteriously.
  const criteriaEmpty = !criteria.titles.length && !criteria.keywords.length
    && !criteria.geos.length && !criteria.companies.length && !criteria.industries.length;
  if (kind === "LinkedIn Recruiter" && criteriaEmpty && !fetched.rows.length) {
    warnings.push(
      "recruiter_url_note: Recruiter search URLs usually keep their filters on LinkedIn's side, so the URL alone can't seed the search waterfall. Connect the LinkedIn seat under Setup so the search's own members can be pulled, or use Recruiter's legacy smartsearch URL (it spells the filters out).",
    );
  }
  const icp = icpFromSalesNav(criteria, fetched.rows, kind);

  // Score the LinkedIn members against the derived ICP, floored: they matched the
  // recruiter's own search filters, so they never rank as strangers.
  for (const row of fetched.rows) {
    const s = scoreCandidate(row, icp);
    row.fitScore = Math.max(s.fitScore, 55);
    row.fitReasons = [`Matched your ${kind} search`, ...s.fitReasons];
  }

  const byKey = new Map<string, CandidateRow>();
  for (const row of fetched.rows) byKey.set(personKey(row), row);

  // EXPAND: the normal discovery waterfall on the derived ICP, so the list grows
  // beyond LinkedIn's page. Geo honesty comes from ICP-geo scoring rather than the
  // strict drop: URL filters are often broader than a typed city + radius.
  let queries: SourcingQuery[] = [];
  let apiUsage: SalesNavRunResult["apiUsage"];
  let expanded = 0;
  if (opts.expand !== false && icp.titles.length) {
    const breadth = opts.breadth ?? "balanced";
    queries = generateQueries(icp, { breadth });
    if (queries.length) {
      const disc = await runDiscovery(queries, icp, {
        cap: Math.min(Math.max(opts.cap ?? 300, 25), 2000),
        minFit: typeof opts.minFit === "number" ? opts.minFit : 10,
        breadth,
        strictGeo: false,
      });
      warnings.push(...disc.warnings);
      apiUsage = disc.usage;
      for (const row of disc.candidates) {
        const k = personKey(row);
        const prev = byKey.get(k);
        if (!prev) { byKey.set(k, row); expanded++; continue; }
        // Same person surfaced by both: the LinkedIn row stays, the waterfall row
        // donates whatever the LinkedIn card was missing.
        for (const f of ["email", "phone", "title", "headline", "company", "location", "imageUrl"] as const) {
          if (!prev[f] && row[f]) prev[f] = row[f];
        }
      }
    }
  } else if (opts.expand !== false && !icp.titles.length) {
    warnings.push("no_expandable_filters: the URL carried no readable titles or keywords and the search returned no members to learn from, so the waterfall expansion was skipped");
  }

  const candidates = [...byKey.values()].sort((a, b) => b.fitScore - a.fitScore);
  return {
    candidates, icp, criteria, queries, warnings, apiUsage,
    linkedinFound: fetched.rows.length, expanded, account: fetched.account,
  };
}
