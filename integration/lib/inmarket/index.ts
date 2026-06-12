/**
 * RecruiterOS · In-Market Leads (Business Development)
 *
 * "Who is in the market for recruiting services right now?" This module turns a
 * recruiter's plain-language search into a ranked list of companies that are
 * actively hiring (and the decision-maker over the role), by driving the Signal
 * Engine's free/public sources, scoring against an ICP, and resolving the buyer.
 *
 * It sits ABOVE Prospects in the BD OS: you search the market here, then promote
 * the best leads into the pipeline, where they continue enriched. The promote
 * step reuses the same `addProspect` path Prospects uses, so the hand-off is
 * seamless and the ATS Person is created once.
 *
 * Cost discipline (per project rules): discovery runs on FREE sources only;
 * paid contact enrichment is cheapest-first and only on promote.
 */

import {
  collect,
  freeSources,
  cheapFirstContactWaterfall,
  enrich,
  classifyTitle,
  type ICP,
  type Signal,
  type SignalType,
  type Company,
  type Person,
  type JobFunction,
} from "../signals";
import { addProspect } from "../prospects";
import { rid } from "../core/ids";
import type { Prospect } from "../core/types";
import { isUsSignal, isUsLead } from "./geo";

/** What the UI sends to search the market. Search EITHER by industry/market OR by
 *  company name — the two are mutually exclusive in the UI, but both narrow the same
 *  ranked stream here. */
export interface InMarketQuery {
  /** Free-text intent, e.g. "fintechs in NYC hiring senior backend engineers". */
  query?: string;
  industries?: string[];
  geos?: string[];
  /** Company-name search: only surface companies whose name matches this text. */
  companyName?: string;
  /** Job-title keyword search: only surface companies hiring a role whose TITLE matches
   *  these keywords (substring, not exact), and narrow each company to just those roles. */
  roleQuery?: string;
  /** Company slugs/names to feed the watchlist-driven sources (ATS boards, GitHub orgs,
   *  News RSS). Used by the background accumulator to deepen role coverage for companies
   *  already in the pool — not a user-facing filter. */
  companyNames?: string[];
  /** Decision-maker titles to anchor the buyer, e.g. ["VP Engineering", "Head of Talent"]. */
  titles?: string[];
  /** Restrict to specific hiring-signal types (funding_round, hiring_velocity, …). */
  signalTypes?: SignalType[];
  headcountBands?: Company["headcountBand"][];
  /** Date search: only leads POSTED ONLINE within the last N days (1, 7, 30, …). */
  postedWithinDays?: number;
  /** Date search: only leads ADDED TO OUR DATABASE within the last N days. */
  addedWithinDays?: number;
  /** Size search: only leads with an AUTHORITATIVE (Wikidata) headcount — drop heuristic
   *  estimates. Lets you narrow strictly on confirmed company sizes. */
  confirmedSizeOnly?: boolean;
  limit?: number;
}

/** One open role mapped to the person who would own filling it. The "deep dive"
 *  into what a company's hiring actually looks like. */
export interface HiringManagerLead {
  /** The open role, as observed, e.g. "Senior Backend Engineer". */
  role: string;
  /** Function the role rolls up to, e.g. "engineering". */
  function: JobFunction;
  /** The title most likely to own the hire, e.g. "VP / Head of Engineering". */
  managerTitle: string;
  /** A real, resolved decision-maker name when the engine found one for this function. */
  managerName?: string;
  managerLinkedin?: string;
  /** Short rationale when the owner was inferred by AI (e.g. "approves eng hires"). */
  why?: string;
  /** True when this manager was resolved by the AI inference rather than the heuristic. */
  ai?: boolean;
  /** When this role was posted on the company's own board (ISO), when known. */
  postedAt?: string;
}

/** One in-market lead surfaced to the recruiter. */
export interface InMarketLead {
  id: string;
  company: string;
  domain?: string;
  industry?: string;
  headcountBand?: string;
  /** Exact employee count when an authoritative free source (Wikidata) had one. */
  employeeCount?: number;
  /** True when the headcount band is a heuristic estimate, not an authoritative lookup. */
  sizeEstimated?: boolean;
  location?: string;
  /** The signal that says they're hiring, e.g. "Posted 9 engineering roles in 7 days". */
  reason: string;
  signalType: string;
  /** 0..100 intent/fit score from the engine. */
  score: number;
  scoreReasons: string[];
  /** The decision-maker over the role, when resolved. */
  buyerName?: string;
  buyerTitle?: string;
  buyerLinkedin?: string;
  /** Roles observed open, for context. */
  roles?: string[];
  /** The company's FULL board when auto-expanded from their own ATS (title + date + loc). */
  roleDetails?: Array<{ title: string; postedAt?: string; location?: string }>;
  /** Which ATS the full board came from, e.g. "Greenhouse"; set once expanded. */
  boardSource?: string;
  /** When we last pulled the company's full board (ISO) — drives the rotation. */
  boardExpandedAt?: string;
  /** Deep dive: each open role mapped to the hiring manager who would own it. */
  hiringManagers?: HiringManagerLead[];
  sourceUrl?: string;
  /** When the underlying signal fired (ISO) — used to detect renewed demand. */
  signalAt?: string;
  /** When the role was POSTED ONLINE (ISO) — the original posting/event date from the
   *  source. Drives the "Posted within" date search. Falls back to ingest time. */
  postedAt?: string;
  /** When this company was FIRST ADDED TO OUR DATABASE (ISO) — stamped by the pool on first
   *  insert, so you can target by how fresh a lead is to us vs. how fresh it is online. */
  addedAt?: string;
  /** True when this company is already in Prospects but a fresh demand signal
   *  (repost / surge / long-open) brought it back — a reason to re-engage. */
  renewed?: boolean;
  renewedReason?: string;
  /** Auto-generated follow-up line for the renewed-demand case. */
  renewedMessage?: string;
  /** Carried so promote() can resolve the buyer + create the prospect. */
  raw?: { company?: Company; person?: Person };
}

/** The title most likely to own a hire for a given function — used to attribute a
 *  hiring manager to each open role even before contact enrichment. */
const MANAGER_TITLE_BY_FUNCTION: Record<JobFunction, string> = {
  engineering: "VP / Head of Engineering",
  product: "Head of Product / CPO",
  design: "Head of Design",
  data: "Head of Data / Analytics",
  sales: "VP Sales / Revenue",
  marketing: "Head of Marketing / CMO",
  finance: "VP Finance / CFO",
  operations: "VP / Head of Operations",
  people_hr: "Head of Talent / People",
  customer_success: "VP Customer Success",
  legal: "General Counsel",
  executive: "CEO / Founder",
  other: "Hiring Manager",
};

/** The hiring-manager ladder per function, DEEPEST FIRST-to-most-senior: the direct
 *  manager, their director, the VP/function head, the C-level owner, and the in-house
 *  talent/recruiting partner who runs the req. Surfacing up to five gives the recruiter a
 *  one-click choice of how many people to touch per role (1 / 3 / 5) so a single open role
 *  becomes multiple warm contacts at the company. The VP rung (index 2) is where a resolved
 *  real decision-maker's name is attached. */
const MANAGER_LADDER: Record<JobFunction, string[]> = {
  engineering: ["Engineering Manager", "Director of Engineering", "VP / Head of Engineering", "CTO", "Technical Recruiter / Talent Partner"],
  product: ["Senior Product Manager", "Group Product Manager", "VP Product / Head of Product", "Chief Product Officer", "Recruiting / Talent Partner"],
  design: ["Design Lead", "Design Manager", "Director of Design", "VP / Head of Design", "Recruiting / Talent Partner"],
  data: ["Data / Analytics Manager", "Director of Data", "VP / Head of Data", "Chief Data Officer", "Technical Recruiter / Talent Partner"],
  sales: ["Sales Manager", "Director of Sales", "VP Sales", "Chief Revenue Officer", "Sales Recruiter / Talent Partner"],
  marketing: ["Marketing Manager", "Director of Marketing", "VP Marketing", "CMO", "Recruiting / Talent Partner"],
  finance: ["Finance Manager", "Director of Finance", "VP Finance", "CFO", "Recruiting / Talent Partner"],
  operations: ["Operations Manager", "Director of Operations", "VP / Head of Operations", "COO", "Recruiting / Talent Partner"],
  people_hr: ["Recruiting Manager", "Talent Acquisition Lead", "Director of People", "VP People / CHRO", "Head of Talent"],
  customer_success: ["Customer Success Manager", "Director of Customer Success", "VP Customer Success", "Chief Customer Officer", "Recruiting / Talent Partner"],
  legal: ["Legal Counsel", "Senior Counsel", "Director of Legal", "General Counsel", "Recruiting / Talent Partner"],
  executive: ["Chief of Staff", "VP / Head of Function", "COO", "CEO / Founder", "Head of Talent"],
  other: ["Hiring Manager", "Senior Manager", "Department Head", "Director", "Recruiting / Talent Partner"],
};

/**
 * Map each observed open role to the people who would own filling it — the direct manager
 * AND the function head, so the recruiter can target either or both. When the engine has
 * resolved a real decision-maker whose function matches, attach their name to the senior
 * rung; everything else stays a canonical title until enrichment resolves a person.
 */
export function hiringManagersFor(
  roles: string[] | undefined,
  buyer?: Person,
  roleDates?: Record<string, string>,
  cap = 8,
): HiringManagerLead[] {
  if (!roles || !roles.length) return [];
  const buyerFn = buyer?.title ? classifyTitle(buyer.title).function : undefined;
  const seen = new Set<string>();
  const out: HiringManagerLead[] = [];
  for (const role of roles.slice(0, cap)) {          // bound payload across many open roles
    const rkey = role.trim().toLowerCase();
    if (!rkey) continue;
    const fn = classifyTitle(role).function;
    const ladder = MANAGER_LADDER[fn] || [MANAGER_TITLE_BY_FUNCTION[fn]];
    const matchesBuyer = !!buyerFn && (fn === buyerFn || buyerFn === "executive");
    const attachIdx = Math.min(2, ladder.length - 1); // attach the resolved person at the VP rung
    const postedAt = roleDates ? roleDates[rkey] : undefined;
    ladder.forEach((managerTitle, idx) => {
      const k = rkey + "::" + managerTitle.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      const attach = matchesBuyer && idx === attachIdx; // real person → leadership rung
      out.push({
        role,
        function: fn,
        managerTitle,
        managerName: attach ? buyer?.fullName : undefined,
        managerLinkedin: attach ? buyer?.linkedinUrl : undefined,
        postedAt,
      });
    });
  }
  return out;
}

/** Build a BD ICP from a loose search. Keyword disqualifiers keep noise down. */
function icpFromQuery(q: InMarketQuery): ICP {
  return {
    id: rid("icp"),
    motion: "business_dev",
    industries: q.industries,
    geos: q.geos,
    titles: q.titles,
    headcountBands: q.headcountBands,
    // Company-side, hiring-intent signals are what "in market for recruiting" means.
    // Honor an explicit signal-type selection from the UI; otherwise watch the core set.
    signalTypes: (q.signalTypes && q.signalTypes.length) ? q.signalTypes : [
      "job_posting", "hiring_velocity", "job_repost", "evergreen_role",
      "headcount_growth", "careers_page_launch", "funding_round", "exec_hire",
      "department_head_change", "office_expansion",
    ],
    autoTriggerThreshold: 0,
  };
}

/** Tokens to match an industry by (from the label), ignoring connector words. */
export function industryTokens(labels: string[]): string[] {
  const stop = new Set(["and", "or", "the", "of", "services", "industry"]);
  return labels
    .flatMap((l) => l.toLowerCase().split(/[^a-z0-9]+/))
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t));
}

/** Does this signal plausibly belong to the requested industries? Matches the
 *  resolved company industry first, then the signal's text (company name + roles +
 *  detail) so job-board rows that carry no industry field still classify. */
function matchesIndustry(s: Signal, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const ind = (s.company?.industry ?? "").toLowerCase();
  if (ind && tokens.some((t) => ind.includes(t))) return true;
  const hay = (
    (s.company?.name ?? "") + " " + s.title + " " + s.detail + " " +
    (Array.isArray((s.evidence as any)?.roles) ? (s.evidence as any).roles.join(" ") : "")
  ).toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

function geoText(c?: Company): string | undefined {
  const g = c?.hqLocation || (c?.hiringLocations && c.hiringLocations[0]);
  return g?.raw;
}

function toLead(s: Signal): InMarketLead {
  const ev = s.evidence || {};
  const roles = Array.isArray((ev as any).roles)
    ? (ev as any).roles
    : Array.isArray((ev as any).titles)
      ? (ev as any).titles
      : undefined;
  return {
    id: s.id,
    company: s.company?.name ?? s.title,
    domain: s.company?.domain,
    industry: s.company?.industry,
    headcountBand: s.company?.headcountBand,
    location: geoText(s.company) || (typeof (ev as any).location === "string" ? (ev as any).location : undefined),
    reason: s.detail || s.title,
    signalType: s.type,
    score: s.score?.value ?? 0,
    scoreReasons: s.score?.reasons ?? [],
    buyerName: s.person?.fullName,
    buyerTitle: s.person?.title,
    buyerLinkedin: s.person?.linkedinUrl,
    roles,
    hiringManagers: hiringManagersFor(roles, s.person),
    sourceUrl: s.sources && s.sources[0] ? s.sources[0].url : undefined,
    signalAt: s.eventAt || s.ingestedAt,
    postedAt: s.eventAt || s.ingestedAt,
    raw: { company: s.company, person: s.person },
  };
}

/** Signal types meaning "still/again hiring → stronger demand"; these re-surface a
 *  company even after it's been taken into Prospects, flagged for re-engagement. */
const RENEWED_TYPES = new Set<SignalType>(["job_repost", "hiring_velocity", "evergreen_role"]);

/** A reason + ready-to-send follow-up line for a renewed-demand lead, grounded in the
 *  exact signal so the recruiter can re-engage with relevant messaging. */
function renewedInfo(lead: InMarketLead): { reason: string; message: string } {
  const co = lead.company;
  const role = (lead.roles && lead.roles[0]) || lead.buyerTitle || "the role";
  if (lead.signalType === "job_repost") {
    return {
      reason: "Reposted role — stronger demand",
      message: `Quick follow-up on ${co} — I noticed the ${role} role was reposted. A repost usually means the search is dragging on. I have pre-vetted candidates matched to it and could send a couple over today. Worth a 15-minute call this week?`,
    };
  }
  if (lead.signalType === "hiring_velocity") {
    return {
      reason: "Hiring surge — capacity strain",
      message: `${co} is in a clear hiring surge right now. Teams scaling this fast hit capacity quickly — happy to take ${role} (and the others) off your plate with candidates ready to move. Open to a quick call?`,
    };
  }
  return {
    reason: "Long-open role — pipeline pain",
    message: `The ${role} at ${co} has been open a while, which usually means the pipeline has gone thin. I have candidates matched to the JD — want me to send two or three to look at?`,
  };
}

/**
 * Per-workspace suppression WITH renewed-demand re-surfacing: companies already in
 * Prospects are hidden — UNLESS a fresh demand signal (repost / surge / long-open) brings
 * them back, in which case they re-appear flagged + with auto-generated follow-up copy, so
 * a repeat need becomes a reason to re-engage rather than a silent duplicate.
 */
function applyTaken(leads: InMarketLead[], taken: Set<string>): InMarketLead[] {
  if (!taken.size) return leads;
  const out: InMarketLead[] = [];
  for (const l of leads) {
    const co = (l.company || "").toLowerCase().trim();
    if (!taken.has(co)) { out.push(l); continue; }
    if (RENEWED_TYPES.has(l.signalType as SignalType)) {
      const info = renewedInfo(l);
      out.push({ ...l, renewed: true, renewedReason: info.reason, renewedMessage: info.message });
    }
    // otherwise: already worked + no new demand signal → suppress
  }
  return out;
}

/** Tokenize a title query into lowercased keywords (>=2 chars). */
function roleTokens(q?: string): string[] {
  return (q ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length >= 2);
}

/**
 * Read-time view of a lead:
 *  - regenerate hiring managers from the company's FULL expanded board (so 1/3/5 + push work
 *    across every role, with each role's posting date attached), and
 *  - when a title search is active, NARROW the lead to only the roles whose title matches the
 *    keywords (the "separation") — returning null when nothing matches so it's filtered out.
 */
function expandLeadView(lead: InMarketLead, tokens: string[]): InMarketLead | null {
  const details = lead.roleDetails && lead.roleDetails.length ? lead.roleDetails : null;
  let titles = details ? details.map((d) => d.title) : (lead.roles ?? []);
  let kept = details;

  if (tokens.length) {
    const match = (t: string) => { const low = t.toLowerCase(); return tokens.some((k) => low.includes(k)); };
    if (kept) { kept = kept.filter((d) => match(d.title)); titles = kept.map((d) => d.title); }
    else titles = titles.filter(match);
    if (!titles.length) return null;             // no role matches this title search → drop
  }
  if (!details && !lead.hiringManagers?.length && !titles.length) return lead;

  // Build the role->postedAt map and regenerate managers across the (possibly narrowed) set.
  const roleDates: Record<string, string> = {};
  if (kept) for (const d of kept) if (d.postedAt) roleDates[d.title.trim().toLowerCase()] = d.postedAt;
  const buyer = lead.buyerName || lead.buyerTitle
    ? ({ fullName: lead.buyerName, title: lead.buyerTitle, linkedinUrl: lead.buyerLinkedin } as Person)
    : undefined;
  const managers = titles.length ? hiringManagersFor(titles, buyer, roleDates, 30) : lead.hiringManagers;

  // Freshest role date becomes the lead's postedAt so the date filter reflects live demand.
  let postedAt = lead.postedAt;
  if (kept && kept.length) {
    const newest = kept.map((d) => d.postedAt).filter(Boolean).sort().slice(-1)[0];
    if (newest) postedAt = newest;
  }
  return { ...lead, roles: titles, roleDetails: kept ?? lead.roleDetails, hiringManagers: managers, postedAt };
}

/** Apply the read-time expansion + title separation across a set of leads. */
function applyRoleView(leads: InMarketLead[], q: InMarketQuery): InMarketLead[] {
  const tokens = roleTokens(q.roleQuery);
  const out: InMarketLead[] = [];
  for (const l of leads) { const v = expandLeadView(l, tokens); if (v) out.push(v); }
  return out;
}

/** Keep only leads whose date falls within the requested window. Applied at SEARCH time
 *  (never during accumulation, so ingestion still captures everything). `postedWithinDays`
 *  filters on the online posting date; `addedWithinDays` on when we first stored it. */
function applyDateFilter(leads: InMarketLead[], q: InMarketQuery, nowIso: string): InMarketLead[] {
  const now = Date.parse(nowIso) || Date.now();
  const within = (iso: string | undefined, days: number): boolean => {
    if (!days) return true;
    const t = iso ? Date.parse(iso) : NaN;
    if (isNaN(t)) return false;            // no date → excluded when a window is requested
    return now - t <= days * 24 * 60 * 60 * 1000;
  };
  const pd = q.postedWithinDays ?? 0, ad = q.addedWithinDays ?? 0;
  if (!pd && !ad) return leads;
  return leads.filter((l) => within(l.postedAt ?? l.signalAt, pd) && within(l.addedAt, ad));
}

/** Narrow by company size: keep only leads whose resolved headcount band is in the
 *  requested set. Leads with no resolved size are excluded when a size filter is active
 *  (true narrowing). Free job-board leads often lack a size; Adzuna + contact enrichment
 *  fill it, so coverage of this filter grows as those are enabled. */
function applySizeFilter(leads: InMarketLead[], q: InMarketQuery): InMarketLead[] {
  let out = leads;
  // Confirmed-only: keep authoritative/source sizes, drop only heuristic estimates.
  if (q.confirmedSizeOnly) out = out.filter((l) => l.sizeEstimated !== true && !!l.headcountBand);
  const bands = q.headcountBands?.filter(Boolean) as string[] | undefined;
  if (bands?.length) {
    const set = new Set(bands);
    out = out.filter((l) => !!l.headcountBand && set.has(l.headcountBand));
  }
  return out;
}

/**
 * Search the market for companies in-market for recruiting help. Free sources
 * only; returns ranked leads (highest intent first). Network failures degrade to
 * an empty list with a warning, never throw.
 */
/** Dedupe leads by company (case-insensitive), keeping the highest-scored, score-sorted. */
export function dedupeLeads(leads: InMarketLead[]): InMarketLead[] {
  const by = new Map<string, InMarketLead>();
  for (const l of leads) {
    const key = (l.company || l.id).toLowerCase().trim();
    if (!key) continue;
    const cur = by.get(key);
    if (!cur || (l.score ?? 0) > (cur.score ?? 0)) by.set(key, l);
  }
  return [...by.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * LIVE collect for a query → matched leads (the source-hitting path). Used both by the
 * on-demand search fallback and by the background accumulator. Keywords are pushed to the
 * sources so aggregators (Adzuna) query the industry/role directly.
 */
export async function collectLeads(q: InMarketQuery, nowIso: string, cap = 300): Promise<InMarketLead[]> {
  const keywords: string[] = [];
  if (q.companyName) keywords.push(q.companyName.trim());
  if (q.query) keywords.push(...q.query.split(/\s+/).filter((t) => t.length > 2));
  if (q.industries?.length) keywords.push(...industryTokens(q.industries));
  // Title search: push the title keywords to the sources (Adzuna `what=`, board filters) so
  // the live pull targets that role directly — this is what boosts title-specific volume.
  const titleToks = roleTokens(q.roleQuery);
  if (titleToks.length) keywords.push(...titleToks);
  const watchlist: { keywords?: string[]; companyNames?: string[] } = {};
  if (keywords.length) watchlist.keywords = keywords;
  // Feed company names/slugs to the watchlist-driven sources (ATS boards, GitHub, News)
  // so they activate during background accumulation and deepen role coverage.
  if (q.companyNames?.length) watchlist.companyNames = q.companyNames;
  const report = await collect({
    icp: icpFromQuery(q),
    now: nowIso,
    sources: freeSources(),
    pull: { watchlist, limit: cap },
  });
  const kw = (q.query ?? "").toLowerCase().trim();
  const nameKw = (q.companyName ?? "").toLowerCase().trim();
  const indTokens = industryTokens(q.industries ?? []);
  const wantTypes = new Set<SignalType>(q.signalTypes ?? []);
  let ranked = report.ranked.filter((s) => s.motion === "business_dev" && (s.score?.value ?? 0) > 0);
  if (wantTypes.size) {
    const before = ranked;
    ranked = ranked.filter((s) => wantTypes.has(s.type));
    if (ranked.length === 0) ranked = before;
  }
  if (nameKw) {
    const before = ranked;
    ranked = ranked.filter((s) => (s.company?.name ?? s.title).toLowerCase().includes(nameKw));
    if (ranked.length === 0) ranked = before;
  } else if (indTokens.length) {
    ranked = ranked.filter((s) => matchesIndustry(s, indTokens));
  } else if (kw) {
    const terms = kw.split(/\s+/).filter((t) => t.length > 2);
    const before = ranked;
    ranked = ranked.filter((s) => {
      const hay = (s.title + " " + s.detail + " " + (s.company?.industry ?? "")).toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
    if (ranked.length === 0) ranked = before;
  }
  // Title search: keep only signals whose role TITLE matches the keywords (live-pull path).
  if (titleToks.length) {
    const before = ranked;
    ranked = ranked.filter((s) => {
      const rt = ((s.evidence as any)?.roleTitle ?? "") + " " + s.title;
      const low = rt.toLowerCase();
      return titleToks.some((t) => low.includes(t));
    });
    if (ranked.length === 0) ranked = before;
  }
  // US-ONLY: drop any signal we can't positively place in the United States (the recruiter
  // works US roles only). Applied at ingestion so nothing non-US ever enters the pool.
  ranked = ranked.filter((s) => isUsSignal(s));
  // Stamp "added to our DB" = now for freshly collected leads. The pool overrides this with
  // the true first-seen time for companies it has already stored (see mergeIntoPool).
  return ranked.slice(0, cap).map((s) => {
    const l = toLead(s);
    l.addedAt = nowIso;
    return l;
  });
}

/**
 * Search the market. Reads from the ACCUMULATED POOL first (thousands of leads built up
 * in the background, zero live API calls); only falls back to a live collect when the
 * pool is thin for this query — and feeds those live results back into the pool. The
 * background accumulator keeps the pool full, so over time searches stop hitting the
 * providers (and the Adzuna trial) entirely. Fully resilient: any pool error degrades to
 * the original live behavior.
 */
/** Count companies by their hiring-signal type across the FULL matched set, so the
 *  Hire Signals UI can show the actual number behind each reason + a true total
 *  (independent of how many are displayed). Sorted most-common first. */
export function signalBreakdown(leads: InMarketLead[]): Array<{ signalType: string; count: number }> {
  const m = new Map<string, number>();
  for (const l of leads) {
    const t = l.signalType || "other";
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([signalType, count]) => ({ signalType, count })).sort((a, b) => b.count - a.count);
}

export async function searchInMarket(
  q: InMarketQuery,
  nowIso: string,
  workspaceId?: string,
): Promise<{ leads: InMarketLead[]; pulled: number; warnings: string[]; stats?: unknown; signalBreakdown?: Array<{ signalType: string; count: number }> }> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 1000);

  // Per-user suppression: hide companies the workspace has already taken into Prospects,
  // so you never re-target (and double-send to) a company you're already working. This is
  // per-workspace — the global pool is shared, but each user's taken-list is their own.
  const taken = workspaceId ? await takenCompanies(workspaceId) : new Set<string>();
  // Resolve company sizes (free: Wikidata cache + heuristic) so the size filter has data.
  const { loadSizeMap, fillSizes, MAX_EMPLOYEES } = await import("./companySize");
  const sizeMap = await loadSizeMap().catch(() => ({} as Record<string, never>));
  // Hard <10K-employee policy: never surface a company we've authoritatively confirmed is
  // bigger than the cap (SMB/mid-market focus). employeeCount is set by fillSizes only from
  // real Wikidata counts, so heuristic estimates are never excluded here.
  const underCap = (l: InMarketLead) => !(typeof l.employeeCount === "number" && l.employeeCount > MAX_EMPLOYEES);
  const fresh = (arr: InMarketLead[]) =>
    applySizeFilter(applyDateFilter(applyTaken(applyRoleView(fillSizes(arr.filter(isUsLead), sizeMap as never), q), taken), q, nowIso), q).filter(underCap);

  try {
    const { ensureAccumulator } = await import("./accumulator");
    const { queryPool, mergeIntoPool, poolStats } = await import("./pool");
    ensureAccumulator(); // start the background collector (no-op once running)
    const stats = await poolStats().catch(() => undefined);

    // Pull the FULL matching set from the pool so `pulled` reflects the true total
    // available for this industry (which grows daily as the accumulator fills the pool),
    // even though we only display `limit`. Then drop taken companies + apply date search.
    const pooledAll = fresh(await queryPool(q, 10000));
    if (pooledAll.length >= 24) {
      return { leads: pooledAll.slice(0, limit), pulled: pooledAll.length, warnings: [], stats, signalBreakdown: signalBreakdown(pooledAll) };
    }
    // Pool thin for this query → live collect, return it, and grow the pool.
    const live = await collectLeads(q, nowIso, Math.max(limit, 200));
    void mergeIntoPool(live).catch(() => {});
    const merged = fresh(dedupeLeads([...pooledAll, ...live]));
    return { leads: merged.slice(0, limit), pulled: merged.length, warnings: [], stats, signalBreakdown: signalBreakdown(merged) };
  } catch (err) {
    // Pool/accumulator unavailable → pure live fallback (original behavior).
    try {
      const live = fresh(await collectLeads(q, nowIso, Math.max(limit, 200)));
      return { leads: live.slice(0, limit), pulled: live.length, warnings: ["pool_unavailable"], signalBreakdown: signalBreakdown(live) };
    } catch (e) {
      return { leads: [], pulled: 0, warnings: [`search_failed: ${(e as Error).message}`], signalBreakdown: [] };
    }
  }
}

/** Companies the workspace has already taken into Prospects (lowercased), so Hire
 *  Signals can hide them and avoid duplicate outreach. Best-effort; empty on error. */
async function takenCompanies(workspaceId: string): Promise<Set<string>> {
  try {
    const { getCore } = await import("../core/repository");
    const prospects = await getCore().listProspects(workspaceId);
    const set = new Set<string>();
    for (const p of prospects) {
      const c = (p.company || "").toLowerCase().trim();
      if (c) set.add(c);
    }
    return set;
  } catch {
    return new Set<string>();
  }
}

/**
 * Promote an in-market lead into the BD pipeline as a Prospect — paired to its company.
 *
 * The created prospect is a PERSON (the hiring manager), not the raw signal: when a
 * `manager` is passed (a row the recruiter selected from the company's deep dive) that
 * person becomes the prospect; otherwise we fall back to the company's resolved buyer.
 * Either way the prospect carries the company name + domain so the Prospects section can
 * enrich a company email + phone for outreach. Contact resolution is cheapest-first and
 * best-effort here; with no provider keys set it no-ops and the recruiter enriches later.
 */
export async function promoteLead(
  workspaceId: string,
  campaignId: string,
  lead: InMarketLead,
  manager?: HiringManagerLead,
  opts?: { findDirectDial?: boolean },
): Promise<Prospect> {
  let email: string | undefined;
  let phone: string | undefined;

  // Resolve who the prospect actually is: the selected hiring manager, else the buyer.
  const personName = manager?.managerName || lead.buyerName;
  const fullName = personName || `${lead.company} — ${manager?.managerTitle || "hiring manager"}`;
  const title = manager?.managerTitle || lead.buyerTitle;
  const linkedinUrl = manager?.managerLinkedin || lead.buyerLinkedin;
  const company = lead.company;
  const domain = lead.domain || lead.raw?.company?.domain;

  if (personName && domain) {
    try {
      const [first, ...rest] = personName.split(/\s+/);
      const plan = cheapFirstContactWaterfall();
      const report = await enrich(
        plan,
        {
          name: company,
          companyName: company,
          domain,
          fullName: personName,
          firstName: first,
          lastName: rest.join(" "),
          linkedinUrl,
          title,
        },
        { now: new Date().toISOString() },
      );
      const e = report.subject.email;
      const p = report.subject.phone;
      if (typeof e === "string") email = e;
      if (typeof p === "string") phone = p;
    } catch {
      /* leave unresolved; recruiter can enrich later from Prospects */
    }
  }

  // OPT-IN verified direct-dial: only when the Hire Signals "Find direct dials" setting is on.
  // Resolves the PERSON'S own line and accepts ONLY a landline/VoIP (never a switchboard,
  // never a mobile). On a hit it becomes the prospect's primary number; misses are free.
  if (opts?.findDirectDial && personName && (company || domain)) {
    try {
      const { resolveDirectDial } = await import("./directDial");
      const dd = await resolveDirectDial(workspaceId, "bd", {
        fullName: personName, company, companyName: company, domain, email, title, linkedinUrl,
      });
      if (dd.phone) phone = dd.phone; // verified person-direct landline/VoIP
    } catch {
      /* best-effort; keep whatever the cheap waterfall resolved */
    }
  }

  return addProspect({
    workspaceId,
    campaignId,
    fullName,
    email,
    phone,
    company,
    companyDomain: domain,
    title,
    linkedinUrl,
    category: "in_market",
    // In-market promotion is a BUSINESS DEVELOPMENT motion — tag it so the BD-only
    // A/B experiment + workflow apply, and candidate outreach stays separate.
    motion: "bd",
    // Carry the actual hiring signal through so the outreach drafter speaks to it.
    signalType: lead.signalType,
    signalReason: lead.reason,
    warmth: Math.max(50, Math.round(lead.score)),
  });
}
