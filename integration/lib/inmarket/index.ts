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
  /** When the underlying signal fired (ISO) — used to detect renewed demand. */
  signalAt?: string;
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
    signalAt: s.eventAt || s.ingestedAt,
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
  const report = await collect({
    icp: icpFromQuery(q),
    now: nowIso,
    sources: freeSources(),
    pull: { watchlist: keywords.length ? { keywords } : {}, limit: cap },
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
  return ranked.slice(0, cap).map(toLead);
}

/**
 * Search the market. Reads from the ACCUMULATED POOL first (thousands of leads built up
 * in the background, zero live API calls); only falls back to a live collect when the
 * pool is thin for this query — and feeds those live results back into the pool. The
 * background accumulator keeps the pool full, so over time searches stop hitting the
 * providers (and the Adzuna trial) entirely. Fully resilient: any pool error degrades to
 * the original live behavior.
 */
export async function searchInMarket(
  q: InMarketQuery,
  nowIso: string,
  workspaceId?: string,
): Promise<{ leads: InMarketLead[]; pulled: number; warnings: string[]; stats?: unknown }> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 1000);

  // Per-user suppression: hide companies the workspace has already taken into Prospects,
  // so you never re-target (and double-send to) a company you're already working. This is
  // per-workspace — the global pool is shared, but each user's taken-list is their own.
  const taken = workspaceId ? await takenCompanies(workspaceId) : new Set<string>();
  const fresh = (arr: InMarketLead[]) => applyTaken(arr, taken);

  try {
    const { ensureAccumulator } = await import("./accumulator");
    const { queryPool, mergeIntoPool, poolStats } = await import("./pool");
    ensureAccumulator(); // start the background collector (no-op once running)
    const stats = await poolStats().catch(() => undefined);

    // Pull the FULL matching set from the pool so `pulled` reflects the true total
    // available for this industry (which grows daily as the accumulator fills the pool),
    // even though we only display `limit`. Then drop taken companies.
    const pooledAll = fresh(await queryPool(q, 10000));
    if (pooledAll.length >= 24) {
      return { leads: pooledAll.slice(0, limit), pulled: pooledAll.length, warnings: [], stats };
    }
    // Pool thin for this query → live collect, return it, and grow the pool.
    const live = await collectLeads(q, nowIso, Math.max(limit, 200));
    void mergeIntoPool(live).catch(() => {});
    const merged = fresh(dedupeLeads([...pooledAll, ...live]));
    return { leads: merged.slice(0, limit), pulled: merged.length, warnings: [], stats };
  } catch (err) {
    // Pool/accumulator unavailable → pure live fallback (original behavior).
    try {
      const live = fresh(await collectLeads(q, nowIso, Math.max(limit, 200)));
      return { leads: live.slice(0, limit), pulled: live.length, warnings: ["pool_unavailable"] };
    } catch (e) {
      return { leads: [], pulled: 0, warnings: [`search_failed: ${(e as Error).message}`] };
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
