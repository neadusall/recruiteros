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
  /** Decision-maker titles to anchor the buyer, e.g. ["VP Engineering", "Head of Talent"]. */
  titles?: string[];
  /** Restrict to specific hiring-signal types (funding_round, hiring_velocity, …). */
  signalTypes?: SignalType[];
  headcountBands?: Company["headcountBand"][];
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
}

/** One in-market lead surfaced to the recruiter. */
export interface InMarketLead {
  id: string;
  company: string;
  domain?: string;
  industry?: string;
  headcountBand?: string;
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
  /** Deep dive: each open role mapped to the hiring manager who would own it. */
  hiringManagers?: HiringManagerLead[];
  sourceUrl?: string;
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

/**
 * Map each observed open role to the person who would own filling it. When the engine
 * has already resolved a real decision-maker for the company, attach their name to the
 * role whose function matches their title; everything else falls back to the canonical
 * manager title for that function.
 */
function hiringManagersFor(roles: string[] | undefined, buyer?: Person): HiringManagerLead[] {
  if (!roles || !roles.length) return [];
  const buyerFn = buyer?.title ? classifyTitle(buyer.title).function : undefined;
  const seen = new Set<string>();
  const out: HiringManagerLead[] = [];
  for (const role of roles) {
    const key = role.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fn = classifyTitle(role).function;
    const matchesBuyer = !!buyerFn && (fn === buyerFn || buyerFn === "executive");
    out.push({
      role,
      function: fn,
      managerTitle: MANAGER_TITLE_BY_FUNCTION[fn],
      managerName: matchesBuyer ? buyer?.fullName : undefined,
      managerLinkedin: matchesBuyer ? buyer?.linkedinUrl : undefined,
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
function industryTokens(labels: string[]): string[] {
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
    location: geoText(s.company),
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
    raw: { company: s.company, person: s.person },
  };
}

/**
 * Search the market for companies in-market for recruiting help. Free sources
 * only; returns ranked leads (highest intent first). Network failures degrade to
 * an empty list with a warning, never throw.
 */
export async function searchInMarket(
  q: InMarketQuery,
  nowIso: string,
): Promise<{ leads: InMarketLead[]; pulled: number; warnings: string[] }> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 300);
  try {
    const report = await collect({
      icp: icpFromQuery(q),
      now: nowIso,
      sources: freeSources(),
      pull: { watchlist: {}, limit: limit * 3 },
    });
    const kw = (q.query ?? "").toLowerCase().trim();
    const nameKw = (q.companyName ?? "").toLowerCase().trim();
    const indTokens = industryTokens(q.industries ?? []);
    const wantTypes = new Set<SignalType>(q.signalTypes ?? []);
    let ranked = report.ranked.filter((s) => s.motion === "business_dev" && (s.score?.value ?? 0) > 0);

    // Hard signal-type filter when the UI picked specific types (e.g. only "funding").
    if (wantTypes.size) {
      const before = ranked;
      ranked = ranked.filter((s) => wantTypes.has(s.type));
      if (ranked.length === 0) ranked = before; // selection too narrow → don't strand
    }

    if (nameKw) {
      // Company-name search: match the resolved company name (or the headline) only.
      const before = ranked;
      ranked = ranked.filter((s) => (s.company?.name ?? s.title).toLowerCase().includes(nameKw));
      if (ranked.length === 0) ranked = before; // don't strand the user on a thin match
    } else if (indTokens.length) {
      // Industry search: ACTUALLY filter to companies that match the industry (this is
      // the fix for "every industry returns the same list" — before, industry only
      // re-ranked). Thin/empty results for a sector reflect real free-source coverage.
      ranked = ranked.filter((s) => matchesIndustry(s, indTokens));
    } else if (kw) {
      // Light keyword refinement over the free-text box.
      const terms = kw.split(/\s+/).filter((t) => t.length > 2);
      const before = ranked;
      ranked = ranked.filter((s) => {
        const hay = (s.title + " " + s.detail + " " + (s.company?.industry ?? "")).toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
      if (ranked.length === 0) ranked = before; // don't strand the user
    }
    return {
      leads: ranked.slice(0, limit).map(toLead),
      pulled: report.pulled,
      warnings: report.warnings,
    };
  } catch (err) {
    return { leads: [], pulled: 0, warnings: [`search_failed: ${(err as Error).message}`] };
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
    warmth: Math.max(50, Math.round(lead.score)),
  });
}
