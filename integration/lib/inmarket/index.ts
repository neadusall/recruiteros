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
  type ICP,
  type Signal,
  type Company,
  type Person,
} from "../signals";
import { addProspect } from "../prospects";
import { rid } from "../core/ids";
import type { Prospect } from "../core/types";

/** What the UI sends to search the market. */
export interface InMarketQuery {
  /** Free-text intent, e.g. "fintechs in NYC hiring senior backend engineers". */
  query?: string;
  industries?: string[];
  geos?: string[];
  /** Decision-maker titles to anchor the buyer, e.g. ["VP Engineering", "Head of Talent"]. */
  titles?: string[];
  headcountBands?: Company["headcountBand"][];
  limit?: number;
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
  sourceUrl?: string;
  /** Carried so promote() can resolve the buyer + create the prospect. */
  raw?: { company?: Company; person?: Person };
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
    signalTypes: [
      "job_posting", "hiring_velocity", "job_repost", "evergreen_role",
      "headcount_growth", "careers_page_launch", "funding_round", "exec_hire",
      "department_head_change", "office_expansion",
    ],
    autoTriggerThreshold: 0,
  };
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
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  try {
    const report = await collect({
      icp: icpFromQuery(q),
      now: nowIso,
      sources: freeSources(),
      pull: { watchlist: [], limit: limit * 3 },
    });
    const kw = (q.query ?? "").toLowerCase().trim();
    let ranked = report.ranked.filter((s) => s.motion === "business_dev" && (s.score?.value ?? 0) > 0);
    if (kw) {
      // Light keyword refinement over the free-text box.
      const terms = kw.split(/\s+/).filter((t) => t.length > 2);
      ranked = ranked.filter((s) => {
        const hay = (s.title + " " + s.detail + " " + (s.company?.industry ?? "")).toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
      if (ranked.length === 0) ranked = report.ranked.filter((s) => s.motion === "business_dev"); // fall back, don't strand the user
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
 * Promote an in-market lead into the BD pipeline as a Prospect. Resolves the
 * buyer's contact cheapest-first (only now do we spend), then creates the
 * prospect on the given campaign. Returns the new prospect.
 */
export async function promoteLead(
  workspaceId: string,
  campaignId: string,
  lead: InMarketLead,
): Promise<Prospect> {
  let email: string | undefined;
  let phone: string | undefined;

  const fullName = lead.buyerName || `${lead.company} (hiring manager)`;
  const company = lead.company;
  const title = lead.buyerTitle;
  const domain = lead.domain || lead.raw?.company?.domain;

  // Cheap-first contact enrichment, best-effort. Builds a cheapest-first plan and
  // runs it; with no provider keys set every step no-ops, so this safely yields
  // nothing and the recruiter can enrich later. Phone is left off (costly).
  if (lead.buyerName && domain) {
    try {
      const [first, ...rest] = lead.buyerName.split(/\s+/);
      const plan = cheapFirstContactWaterfall();
      const report = await enrich(
        plan,
        {
          name: company,
          companyName: company,
          domain,
          fullName: lead.buyerName,
          firstName: first,
          lastName: rest.join(" "),
          linkedinUrl: lead.buyerLinkedin,
          title: lead.buyerTitle,
        },
        { now: new Date().toISOString() },
      );
      const e = report.subject.email;
      const p = report.subject.phone;
      if (typeof e === "string") email = e;
      if (typeof p === "string") phone = p;
    } catch {
      /* leave unresolved; recruiter can enrich later */
    }
  }

  return addProspect({
    workspaceId,
    campaignId,
    fullName,
    email,
    phone,
    company,
    title,
    linkedinUrl: lead.buyerLinkedin,
    category: "in_market",
    warmth: Math.max(50, Math.round(lead.score)),
  });
}
