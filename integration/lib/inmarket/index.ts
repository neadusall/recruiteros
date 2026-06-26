/**
 * RecruitersOS · In-Market Leads (Business Development)
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
import { resolveRealEmployer } from "./employer";
import { guessEmail } from "./email";
import { shotKey, shotShareUrls } from "./roleShot";

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
  /** Screenshot search: true → only companies that HAVE a verified job-page screenshot; false → only
   *  those that DON'T (the capture backlog); undefined → no screenshot filter. */
  hasScreenshot?: boolean;
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
  /** Free best-guess work email from the manager's name + company domain (syntax only,
   *  unverified — every send is validated first). Present only when a NAME + domain exist. */
  likelyEmail?: string;
  /** The pattern used for likelyEmail, e.g. "first.last". */
  emailPattern?: string;
  /** Always false until a verifier confirms — drives the "unverified" badge in the UI. */
  emailVerified?: boolean;
  /** Short rationale when the owner was inferred by AI (e.g. "approves eng hires"). */
  why?: string;
  /** True when this manager was resolved by the AI inference rather than the heuristic. */
  ai?: boolean;
  /** When this role was posted on the company's own board (ISO), when known. */
  postedAt?: string;
  /** Direct URL to the exact job posting on the company's board, when known. */
  roleUrl?: string;
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
  /** The company's FULL board when auto-expanded from their own ATS (title + date + loc + url). */
  roleDetails?: Array<{ title: string; postedAt?: string; location?: string; url?: string }>;
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
  /** True when this company is already in THIS workspace's Prospects. We surface it
   *  flagged (an "In pipeline" badge) rather than hiding it, so the list is never
   *  silently starved and the count stays honest. */
  inPipeline?: boolean;
  /** True when the posting came from a staffing/recruiting agency and we recovered the real
   *  end employer from the job text — `company` is now the CLIENT, not the agency. */
  employerUnmasked?: boolean;
  /** Free best-guess work email for the company's resolved buyer (syntax only, unverified). */
  buyerLikelyEmail?: string;
  /** The pattern used for buyerLikelyEmail, e.g. "first.last". */
  buyerEmailPattern?: string;
  /** The hiring-need functions this company is hiring for (derived from its open roles), so the
   *  UI can filter the result set by a "what they're hiring for" category in one click. */
  needFunctions?: JobFunction[];
  /** Carried so promote() can resolve the buyer + create the prospect. */
  raw?: { company?: Company; person?: Person };
  /** True when a VERIFIED screenshot of one of this company's open-role pages exists — captured on
   *  the company's OWN careers site (never the ATS). Drives the 📸 badge + the "has screenshot" filter. */
  hasShot?: boolean;
  /** The matched shot's stable key + public asset URLs, when hasShot. */
  shotKey?: string;
  shotWatchUrl?: string;
  shotPosterUrl?: string;
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
  roleUrls?: Record<string, string>,
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
    const roleUrl = roleUrls ? roleUrls[rkey] : undefined;
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
        roleUrl,
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
  // Carry the role(s) on the lead: a multi-role evidence array if present, else the single
  // role title a job_posting/repost carries — so even one-role leads classify into a hiring-need
  // category (and get a hiring-manager row) before any board expansion deepens them.
  const roles = Array.isArray((ev as any).roles)
    ? (ev as any).roles
    : Array.isArray((ev as any).titles)
      ? (ev as any).titles
      : typeof (ev as any).roleTitle === "string" && (ev as any).roleTitle
        ? [(ev as any).roleTitle as string]
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
 * Per-workspace pipeline-tagging (NOT hiding). Companies already in this workspace's
 * Prospects are FLAGGED — never removed — so the Hire Signals list is never silently
 * starved by a workspace that has worked a lot of companies (which is exactly what made
 * the house/admin account look empty next to a fresh white-label account that reads the
 * same global pool). Two flags:
 *   - `inPipeline`: already in Prospects → UI shows an "In pipeline" badge.
 *   - renewed-demand: a fresh signal (repost / surge / long-open) on an in-pipeline company
 *     also gets the re-engage reason + auto follow-up copy, so a repeat need is actionable.
 */
function applyTaken(leads: InMarketLead[], taken: Set<string>): InMarketLead[] {
  if (!taken.size) return leads;
  return leads.map((l) => {
    const co = (l.company || "").toLowerCase().trim();
    if (!taken.has(co)) return l;
    if (RENEWED_TYPES.has(l.signalType as SignalType)) {
      const info = renewedInfo(l);
      return { ...l, inPipeline: true, renewed: true, renewedReason: info.reason, renewedMessage: info.message };
    }
    return { ...l, inPipeline: true };
  });
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
  const roleUrls: Record<string, string> = {};
  if (kept) for (const d of kept) {
    const k = d.title.trim().toLowerCase();
    if (d.postedAt) roleDates[k] = d.postedAt;
    if (d.url) roleUrls[k] = d.url;
  }
  const buyer = lead.buyerName || lead.buyerTitle
    ? ({ fullName: lead.buyerName, title: lead.buyerTitle, linkedinUrl: lead.buyerLinkedin } as Person)
    : undefined;
  const managers = titles.length ? hiringManagersFor(titles, buyer, roleDates, 30, roleUrls) : lead.hiringManagers;

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
/**
 * Attach the FREE best-guess work email to a lead's buyer and each named hiring manager, from
 * the person's name + the company domain. Syntax only + unverified (every send is validated
 * first) — so it only appears where we actually have a NAME and a domain, never fabricated.
 * Applied at the display chokepoint so pooled, live, and merged results all carry it.
 */
export function withLikelyEmails(leads: InMarketLead[]): InMarketLead[] {
  return leads.map((l) => {
    // Tag the hiring-need functions for this lead (from its open roles) so the UI can filter the
    // result set by a "what they're hiring for" category. Cheap + done for every lead.
    const titlesForFns = l.roleDetails?.length ? l.roleDetails.map((d) => d.title) : (l.roles ?? []);
    const needFunctions = titlesForFns.length
      ? [...new Set(titlesForFns.map((t) => classifyTitle(t).function))]
      : l.needFunctions;
    l = needFunctions ? { ...l, needFunctions } : l;

    const domain = l.domain;
    if (!domain) return l;                       // no domain (incl. unmasked clients) → no guess
    let buyerLikelyEmail = l.buyerLikelyEmail, buyerEmailPattern = l.buyerEmailPattern;
    if (l.buyerName && !buyerLikelyEmail) {
      const g = guessEmail(l.buyerName.split(/\s+/)[0], l.buyerName.split(/\s+/).slice(1).join(" "), domain);
      if (g.email) { buyerLikelyEmail = g.email; buyerEmailPattern = g.pattern; }
    }
    let managers = l.hiringManagers;
    if (managers && managers.length) {
      managers = managers.map((m) => {
        if (!m.managerName || m.likelyEmail) return m;
        const g = guessEmail(m.managerName.split(/\s+/)[0], m.managerName.split(/\s+/).slice(1).join(" "), domain);
        return g.email ? { ...m, likelyEmail: g.email, emailPattern: g.pattern, emailVerified: false } : m;
      });
    }
    return { ...l, buyerLikelyEmail, buyerEmailPattern, hiringManagers: managers };
  });
}

/**
 * Roll a company's raw open roles up into the SPECIFIC hiring-intent signal type, so the
 * "Hiring signals" filter spreads across real categories instead of being 99% "New job posting".
 * Derived purely from the board we already have (no extra calls):
 *   - many open roles right now            → hiring_velocity  (a hiring SURGE — the hottest BD target)
 *   - a role that's been open a long time  → evergreen_role   (pipeline pain you can solve)
 *   - otherwise                            → job_posting      (a single fresh open role)
 * job_repost needs posting history we don't track here, so it's left to the repost detector.
 */
export function deriveHiringIntentType(
  roleDetails?: Array<{ title?: string; postedAt?: string }>,
  rolesCount?: number,
  nowMs?: number,
): SignalType {
  const n = rolesCount ?? roleDetails?.length ?? 0;
  if (n >= 5) return "hiring_velocity";          // 5+ concurrent openings = a surge
  if (roleDetails && roleDetails.length) {
    const now = nowMs ?? Date.now();
    const LONG_OPEN_MS = 45 * 24 * 60 * 60 * 1000;
    const hasLongOpen = roleDetails.some((r) => {
      const t = r.postedAt ? Date.parse(r.postedAt) : NaN;
      return !isNaN(t) && now - t > LONG_OPEN_MS;
    });
    if (hasLongOpen) return "evergreen_role";
  }
  return "job_posting";
}

/**
 * Canonical dedup key for a company. Lowercases, strips accents/punctuation and common
 * legal suffixes (Inc, LLC, Ltd, Corp, GmbH…), and collapses whitespace, so "Stripe",
 * "Stripe, Inc." and "Stripe Inc" all map to ONE key. Used by BOTH the read-side
 * (dedupeLeads) and the merge-side (pool.keyOf) so a company can never appear twice
 * anywhere. Conservative on purpose (keeps distinguishing words like "group"/"labs") so
 * it never merges two genuinely different companies.
 */
export function companyKey(name: string): string {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")                                          // decompose accents (é -> e + mark)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")                                 // drop marks + punctuation -> space
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|gmbh|plc|ag|nv|bv|srl|sas|sa|pty|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedupe leads by company (normalized), keeping the highest-scored, score-sorted. */
export function dedupeLeads(leads: InMarketLead[]): InMarketLead[] {
  const by = new Map<string, InMarketLead>();
  for (const l of leads) {
    const key = companyKey(l.company || l.id);
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
  // REAL-EMPLOYER GATE: never surface the staffing/recruiting agency that posted a role on a
  // client's behalf — we want the company actually hiring. For each lead: keep real employers,
  // rewrite to the client when an agency named it in the job text, drop when the client is
  // anonymous. Free + deterministic, so it runs on every lead at $0 (see ./employer). Applied
  // at ingestion so no agency ever enters the pool. Stamp "added to our DB" = now for fresh
  // leads (the pool overrides this with the true first-seen time on merge).
  const out: InMarketLead[] = [];
  for (const s of ranked) {
    if (out.length >= cap) break;
    const l = toLead(s);
    const res = resolveRealEmployer(l.company, `${l.reason} ${s.title}`);
    if (res.kind === "drop") continue;            // agency, anonymous client → not actionable
    if (res.kind === "unmasked") {
      // The named domain belonged to the AGENCY; clear it so contact enrichment re-derives the
      // client's own domain from the recovered employer name (guessDomainProvider).
      l.company = res.realEmployer;
      l.domain = undefined;
      l.employerUnmasked = true;
      if (l.raw?.company) l.raw = { ...l.raw, company: { ...l.raw.company, name: res.realEmployer, domain: undefined } };
    }
    l.addedAt = nowIso;
    out.push(l);
  }
  return out;
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

/** Human label per job function for the "what they're hiring for" breakdown. */
const FUNCTION_LABEL: Record<JobFunction, string> = {
  engineering: "💻 Engineering",
  product: "📦 Product",
  design: "🎨 Design",
  data: "📊 Data / AI",
  sales: "📈 Sales / GTM",
  marketing: "📣 Marketing",
  finance: "💵 Finance",
  operations: "⚙️ Operations",
  people_hr: "🧑‍🤝‍🧑 People / HR",
  customer_success: "🤝 Customer Success",
  legal: "⚖️ Legal",
  executive: "👔 Executive / Leadership",
  other: "🧩 Other",
};

/**
 * "What are they hiring for?" — the specific hiring-NEED categories behind a result set, by
 * function, with both the number of COMPANIES hiring for that function and the total open
 * ROLES in it. This is the actionable complement to signalBreakdown ("why they're hiring"):
 * it tells the recruiter exactly which desks to pitch. Sorted most-companies first.
 */
export function hiringNeedsBreakdown(
  leads: InMarketLead[],
): Array<{ function: JobFunction; label: string; companies: number; roles: number }> {
  const companies = new Map<JobFunction, number>();
  const roles = new Map<JobFunction, number>();
  for (const l of leads) {
    const titles = l.roleDetails?.length ? l.roleDetails.map((d) => d.title) : (l.roles ?? []);
    if (!titles.length) continue;
    const fns = new Set<JobFunction>();
    for (const t of titles) {
      const fn = classifyTitle(t).function;
      fns.add(fn);
      roles.set(fn, (roles.get(fn) ?? 0) + 1);
    }
    for (const fn of fns) companies.set(fn, (companies.get(fn) ?? 0) + 1);
  }
  return [...companies.entries()]
    .map(([fn, c]) => ({ function: fn, label: FUNCTION_LABEL[fn], companies: c, roles: roles.get(fn) ?? 0 }))
    .sort((a, b) => b.companies - a.companies);
}

/**
 * ON-DEMAND PAID-FEED FRESHEN. Selecting an industry/role/company should actually PULL that slice
 * from the paid job feed (JSearch) — not just filter what the background rotation happened to have.
 * We fire a small live pull for the exact selection and merge it into the shared pool, so the very
 * next pool read in this same search includes those freshest employers. Throttled per query-key
 * (10-min TTL, in-memory) so rapid clicking can never burn the monthly request budget; no-op when the
 * feed isn't configured. The background rotation still does the heavy volume — this is the "it's
 * pulling THIS industry right now" responsiveness on top.
 */
const lastLiveJobFeed = new Map<string, number>();
const LIVE_JOBFEED_TTL_MS = 10 * 60 * 1000;
function jobFeedQueryFor(q: InMarketQuery): string | null {
  if (q.companyName?.trim()) return q.companyName.trim();
  if (q.roleQuery?.trim()) return q.roleQuery.trim();
  if (q.industries?.length) return q.industries.length === 1 ? q.industries[0] : q.industries.slice(0, 3).join(" OR ");
  if (q.query?.trim()) return q.query.trim();
  return null;
}
async function freshenFromJobFeed(q: InMarketQuery): Promise<number> {
  const term = jobFeedQueryFor(q);
  if (!term) return 0;
  try {
    const { jobFeedEnabled, runJobFeedSourcing } = await import("./jobFeed");
    if (!jobFeedEnabled()) return 0;
    const key = term.toLowerCase();
    const now = Date.now();
    if (now - (lastLiveJobFeed.get(key) ?? 0) < LIVE_JOBFEED_TTL_MS) return 0; // pulled recently → skip (budget)
    lastLiveJobFeed.set(key, now);
    // Small slice (≈3 requests) for snappy responsiveness; merged into the pool for this + future reads.
    return await runJobFeedSourcing({ query: term, location: "United States", limit: 30 });
  } catch {
    return 0;
  }
}

/** Stamp each lead with whether a verified job-page screenshot exists for one of its open roles
 *  (checking the company's top few roles), plus the shot's public watch/poster URLs. Cheap: one
 *  Set membership test per role against the preloaded captured-key set. */
function stampShots(leads: InMarketLead[], keySet: Set<string>): InMarketLead[] {
  if (!keySet.size) return leads.map((l) => (l.hasShot ? l : { ...l, hasShot: false }));
  return leads.map((l) => {
    const titles = (l.roleDetails?.length ? l.roleDetails.map((d) => d.title) : (l.roles ?? [])).slice(0, 3);
    for (const t of titles) {
      const k = shotKey(l.company, t);
      if (keySet.has(k)) {
        const urls = shotShareUrls(k);
        return { ...l, hasShot: true, shotKey: k, shotWatchUrl: urls.watch, shotPosterUrl: urls.poster };
      }
    }
    return { ...l, hasShot: false };
  });
}

/** Narrow by screenshot presence when the UI asked for it (true = only with, false = only without). */
function applyShotFilter(leads: InMarketLead[], q: InMarketQuery): InMarketLead[] {
  if (q.hasScreenshot === undefined) return leads;
  return leads.filter((l) => !!l.hasShot === q.hasScreenshot);
}

/** Screenshot coverage over a matched set: how many companies carry a verified job-page screenshot,
 *  and the % — so the UI can show "📸 32% have a screenshot" right on the filter. Computed on the
 *  STAMPED (pre-shot-filter) set so the % reflects true coverage, not the post-filter view. */
export function shotCoverage(leads: InMarketLead[]): { withShot: number; total: number; pct: number } {
  const total = leads.length;
  const withShot = leads.reduce((n, l) => n + (l.hasShot ? 1 : 0), 0);
  return { withShot, total, pct: total ? Math.round((withShot / total) * 1000) / 10 : 0 };
}

export async function searchInMarket(
  q: InMarketQuery,
  nowIso: string,
  workspaceId?: string,
): Promise<{ leads: InMarketLead[]; pulled: number; warnings: string[]; stats?: unknown; signalBreakdown?: Array<{ signalType: string; count: number }>; needsBreakdown?: Array<{ function: JobFunction; label: string; companies: number; roles: number }>; shotStats?: { withShot: number; total: number; pct: number } }> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 1000);

  // Per-user suppression: hide companies the workspace has already taken into Prospects,
  // so you never re-target (and double-send to) a company you're already working. This is
  // per-workspace — the global pool is shared, but each user's taken-list is their own.
  const taken = workspaceId ? await takenCompanies(workspaceId) : new Set<string>();
  // Resolve company sizes (free: Wikidata cache + heuristic) so the size filter has data.
  const { loadSizeMap, fillSizes, MAX_EMPLOYEES, MIN_EMPLOYEES } = await import("./companySize");
  const sizeMap = await loadSizeMap().catch(() => ({} as Record<string, never>));
  // Hard 100-5,000 employee policy (mid-market focus): never surface a company we've
  // authoritatively confirmed is outside the band. employeeCount is set by fillSizes only
  // from real Wikidata counts, so heuristic estimates are never excluded here.
  const underCap = (l: InMarketLead) =>
    !(typeof l.employeeCount === "number" && (l.employeeCount < MIN_EMPLOYEES || l.employeeCount > MAX_EMPLOYEES));
  const fresh = (arr: InMarketLead[]) =>
    withLikelyEmails(applySizeFilter(applyDateFilter(applyTaken(applyRoleView(fillSizes(arr.filter(isUsLead), sizeMap as never), q), taken), q, nowIso), q).filter(underCap));

  try {
    const { ensureAccumulator } = await import("./accumulator");
    const { queryPool, mergeIntoPool, poolStats } = await import("./pool");
    ensureAccumulator(); // start the background collector (no-op once running)
    // Live paid-feed pull for THIS selection (throttled, best-effort) BEFORE we read the pool, so the
    // freshest employers for the chosen industry/role are merged in and show up in this same search.
    await freshenFromJobFeed(q);
    const stats = await poolStats().catch(() => undefined);
    // Preload the set of companies/roles that already have a verified job-page screenshot, so we can
    // stamp the 📸 badge + honor the "has screenshot" filter on the full matched set (honest counts).
    const { capturedKeySet } = await import("./roleShot");
    const shotKeys = await capturedKeySet().catch(() => new Set<string>());

    // Pull the FULL matching set from the pool so `pulled` reflects the true total
    // available for this industry (which grows daily as the accumulator fills the pool),
    // even though we only display `limit`. Already-in-Prospects companies are FLAGGED, not
    // dropped, so a workspace that has worked many companies still sees the full pool (and
    // the count never falls under the live-fallback threshold just from suppression).
    // Stamp 📸 status on the FULL set (so coverage % is honest), then apply the has-screenshot filter.
    const pooledStamped = stampShots(fresh(await queryPool(q, 10000)), shotKeys);
    const pooledAll = applyShotFilter(pooledStamped, q);
    if (pooledAll.length >= 24) {
      return { leads: pooledAll.slice(0, limit), pulled: pooledAll.length, warnings: [], stats, signalBreakdown: signalBreakdown(pooledAll), needsBreakdown: hiringNeedsBreakdown(pooledAll), shotStats: shotCoverage(pooledStamped) };
    }
    // Pool thin for this query → live collect, return it, and grow the pool.
    const live = await collectLeads(q, nowIso, Math.max(limit, 200));
    void mergeIntoPool(live).catch(() => {});
    const mergedStamped = stampShots(fresh(dedupeLeads([...pooledStamped, ...live])), shotKeys);
    const merged = applyShotFilter(mergedStamped, q);
    return { leads: merged.slice(0, limit), pulled: merged.length, warnings: [], stats, signalBreakdown: signalBreakdown(merged), needsBreakdown: hiringNeedsBreakdown(merged), shotStats: shotCoverage(mergedStamped) };
  } catch (err) {
    // Pool/accumulator unavailable → pure live fallback (original behavior).
    try {
      const live = fresh(await collectLeads(q, nowIso, Math.max(limit, 200)));
      return { leads: live.slice(0, limit), pulled: live.length, warnings: ["pool_unavailable"], signalBreakdown: signalBreakdown(live), needsBreakdown: hiringNeedsBreakdown(live) };
    } catch (e) {
      return { leads: [], pulled: 0, warnings: [`search_failed: ${(e as Error).message}`], signalBreakdown: [], needsBreakdown: [] };
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

  // HARD STAFFING GUARD (action plane): never let an agency reach Prospects. If a staffing
  // lead somehow got this far, try to recover the real client from its signal text; if it's an
  // anonymous client, refuse the promote rather than build outreach to a recruiting firm.
  {
    const resolved = resolveRealEmployer(lead.company, `${lead.reason} ${lead.roles?.join(" ") ?? ""}`);
    if (resolved.kind === "drop") {
      throw new Error(`Refusing to promote "${lead.company}": it's a staffing/recruiting agency, not the hiring company (${resolved.reason}).`);
    }
    if (resolved.kind === "unmasked") {
      lead = { ...lead, company: resolved.realEmployer, domain: undefined, employerUnmasked: true };
    }
  }

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
