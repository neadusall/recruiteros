/**
 * RecruitersOS · Hiring Engine
 * resolveHiringManager — the core inference, end to end.
 *
 * Given a company and a posted role, query the people graph(s) for the target profile,
 * score every candidate on how well they fit "the manager over this role," and return a
 * RANKED set with an honest confidence tier. It never invents a single false answer: when
 * the manager can't be isolated it degrades to the function leader, then the recruiter,
 * then company-only.
 *
 * Tiers (resolver output; the pipeline upgrades `named` → `named_verified` once a contact
 * is verified by the waterfall):
 *   named            — a decision-maker with a strong title+function match, unambiguous
 *   function_leader  — the right function leader, but several plausible candidates
 *   recruiter        — only in-house recruiters/TA found (still a valid contact)
 *   company_only     — no person found; fall back to the company-level BD motion
 *
 * Pure aside from the injected graph calls; no clock/random in the scoring.
 */

import { classifyTitle, type TitleIntel } from "../filters";
import { companyAnchor, normalizeTitle } from "./normalize";
import {
  hiringManagerTarget,
  seniorityRank,
  type HiringManagerTarget,
} from "./targetProfile";
import type { PeopleGraph, PeopleQuery, PersonCandidate } from "./peopleGraph";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ConfidenceTier =
  | "named_verified"
  | "named"
  | "function_leader"
  | "recruiter"
  | "company_only";

export interface RankedManager {
  candidate: PersonCandidate;
  /** 0..1 fit strength. */
  score: number;
  tier: ConfidenceTier;
  titleIntel: TitleIntel;
  /** Human-readable "why this person", e.g. ["VP Engineering at Acme", "title match"]. */
  reasons: string[];
}

export interface ResolveOptions {
  /** People graphs to query, best-first. The resolver merges + dedupes their results. */
  graphs: PeopleGraph[];
  /** Team/product hint from the req, used to disambiguate large companies. */
  team?: string;
  location?: string;
  companyDomain?: string;
  /** Known headcount; small companies collapse to a single unambiguous leader. */
  companySize?: number;
  /** Cap candidates pulled per graph (cost). */
  maxCandidatesPerGraph?: number;
  /** Keep this many alternates beyond the best. */
  alternates?: number;
}

export interface HiringManagerResolution {
  company: string;
  roleTitle: string;
  target: HiringManagerTarget;
  best: RankedManager | null;
  alternates: RankedManager[];
  /** Overall tier = best?.tier ?? "company_only". */
  tier: ConfidenceTier;
  candidatesConsidered: number;
  graphsQueried: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Candidate scoring                                                   */
/* ------------------------------------------------------------------ */

// No trailing \b: must still match the "-er"/"-ing" forms ("Recruiter", "Recruiting").
const RECRUITER_RE = /(recruit|talent acquisition|sourcer|sourcing|ta partner|people ops)/i;

/** Is this candidate plausibly at the target company (not a namesake elsewhere)? */
function companyMatches(candidate: PersonCandidate, company: string): boolean {
  if (!candidate.companyName) return true; // graph didn't say; don't exclude
  return companyAnchor(candidate.companyName) === companyAnchor(company);
}

interface Scored {
  candidate: PersonCandidate;
  score: number;
  intel: TitleIntel;
  isRecruiter: boolean;
  reasons: string[];
}

/**
 * Score one candidate against the target. Weighted blend, all 0..1:
 *   function match   0.30  — same function as the role
 *   seniority fit    0.30  — within the manager band, peaks "one level up"
 *   title match      0.25  — title contains a target title (earlier = closer)
 *   team match       0.10  — req's team/product appears in title/headline
 *   location match   0.05  — location overlap
 */
function scoreCandidate(
  candidate: PersonCandidate,
  target: HiringManagerTarget,
  opts: ResolveOptions,
): Scored {
  const titleText = candidate.title ?? candidate.headline ?? "";
  const intel = classifyTitle(titleText);
  const reasons: string[] = [];
  const isRecruiter = RECRUITER_RE.test(titleText);

  // Seniority fit: peaks at "one level up", decays with distance, 0 below the floor.
  const floor = seniorityRank(target.seniorityFloor);
  const have = seniorityRank(intel.seniority);
  let senScore = 0;
  if (have >= floor) {
    const idealDistance = Math.abs(have - floor); // 0 == exactly at the floor (closest mgr)
    senScore = Math.max(0.2, 1 - idealDistance * 0.18);
    if (intel.isDecisionMaker) reasons.push(`${intel.seniority}-level (decision-maker)`);
  }

  // Title match: best when an earlier (closer) target title is contained.
  let titleScore = 0;
  let titleMatched = false;
  const normCandidate = normalizeTitle(titleText);
  for (let i = 0; i < target.candidateTitles.length; i++) {
    const t = normalizeTitle(target.candidateTitles[i]);
    if (t && normCandidate.includes(t)) {
      titleScore = Math.max(0.5, 1 - i * 0.08);
      titleMatched = true;
      reasons.push(`title ≈ "${target.candidateTitles[i]}"`);
      break;
    }
  }

  // In-house recruiters staff reqs across functions, so they're scored on a flat baseline
  // (not the function rubric) — a valid but weaker contact than the line manager. Capped
  // below the function-leader threshold so a real decision-maker always outranks them.
  if (isRecruiter) {
    reasons.unshift("in-house recruiter");
    return {
      candidate,
      score: Math.min(0.5, 0.35 + 0.1 * senScore),
      intel,
      isRecruiter,
      reasons,
    };
  }

  // Function match. A target-title hit implies the same function even when the keyword
  // classifier misses the "-ing" form (classifyTitle("…Engineering") returns "other"),
  // so a title match satisfies the function requirement.
  let fnScore = 0;
  if (titleMatched || intel.function === target.roleFunction) {
    fnScore = 1;
    if (!titleMatched) reasons.push(`${target.roleFunction} function`);
  } else if (intel.function === "executive") {
    fnScore = 0.7; // a generalist exec can own any function at a small co
  }

  // Team match.
  let teamScore = 0;
  if (opts.team) {
    const hay = `${titleText} ${candidate.headline ?? ""}`.toLowerCase();
    if (hay.includes(opts.team.toLowerCase())) {
      teamScore = 1;
      reasons.push(`mentions "${opts.team}"`);
    }
  }

  // Location match.
  let locScore = 0;
  if (opts.location && candidate.location) {
    const a = candidate.location.toLowerCase();
    const b = opts.location.toLowerCase();
    if (a.includes(b) || b.includes(a)) {
      locScore = 1;
      reasons.push("location match");
    }
  }

  const score =
    0.3 * fnScore + 0.3 * senScore + 0.25 * titleScore + 0.1 * teamScore + 0.05 * locScore;

  return { candidate, score, intel, isRecruiter, reasons };
}

/* ------------------------------------------------------------------ */
/* Dedupe candidates across graphs                                     */
/* ------------------------------------------------------------------ */

function candidateKey(c: PersonCandidate): string {
  return (
    c.linkedinUrl?.toLowerCase() ??
    c.providerProfileId?.toLowerCase() ??
    `${c.fullName.toLowerCase()}@${companyAnchor(c.companyName)}`
  );
}

/* ------------------------------------------------------------------ */
/* Tier assignment                                                     */
/* ------------------------------------------------------------------ */

function tierFor(
  top: Scored | undefined,
  decisionMakers: Scored[],
  opts: ResolveOptions,
): ConfidenceTier {
  if (!top) return "company_only";
  // Only recruiters surfaced.
  if (top.isRecruiter && decisionMakers.length === 0) return "recruiter";

  const strong = decisionMakers.filter((c) => c.score >= 0.55);
  const isSmall = typeof opts.companySize === "number" && opts.companySize <= 50;
  const unambiguous = strong.length === 1 || isSmall;

  if (top.score >= 0.6 && top.intel.isDecisionMaker && unambiguous) return "named";
  if (top.intel.isDecisionMaker && top.score >= 0.4) return "function_leader";
  if (top.isRecruiter) return "recruiter";
  return "function_leader";
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

export async function resolveHiringManager(
  company: string,
  roleTitle: string,
  opts: ResolveOptions,
): Promise<HiringManagerResolution> {
  const target = hiringManagerTarget(roleTitle, { companySize: opts.companySize });
  const warnings: string[] = [];
  const graphsQueried: string[] = [];

  const query: PeopleQuery = {
    companyName: company,
    companyDomain: opts.companyDomain,
    titles: target.candidateTitles,
    function: target.roleFunction,
    seniorityFloor: target.seniorityFloor,
    team: opts.team,
    location: opts.location,
    limit: opts.maxCandidatesPerGraph ?? 25,
  };

  // Query every configured graph, tolerate individual failures.
  const pools = await Promise.all(
    opts.graphs.map(async (g) => {
      if (!g.isConfigured()) {
        warnings.push(`${g.id}: not configured`);
        return [] as PersonCandidate[];
      }
      graphsQueried.push(g.id);
      try {
        return await g.search(query);
      } catch (err) {
        warnings.push(`${g.id}: ${(err as Error).message}`);
        return [] as PersonCandidate[];
      }
    }),
  );

  // Merge + dedupe across graphs (earlier graph wins on tie).
  const byKey = new Map<string, PersonCandidate>();
  for (const pool of pools) {
    for (const c of pool) {
      if (!companyMatches(c, company)) continue;
      const k = candidateKey(c);
      if (!byKey.has(k)) byKey.set(k, c);
    }
  }
  const candidates = [...byKey.values()];

  // Score + sort (descending). Stable: ties keep insertion order.
  const scored = candidates
    .map((c) => scoreCandidate(c, target, opts))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const decisionMakers = scored.filter((s) => s.intel.isDecisionMaker && !s.isRecruiter);
  const top = scored[0];
  const tier = tierFor(top, decisionMakers, opts);

  const toRanked = (s: Scored, t: ConfidenceTier): RankedManager => ({
    candidate: s.candidate,
    score: Math.round(s.score * 100) / 100,
    tier: t,
    titleIntel: s.intel,
    reasons: dedupeReasons(s.reasons, s.candidate, company),
  });

  if (!top) {
    return {
      company,
      roleTitle,
      target,
      best: null,
      alternates: [],
      tier: "company_only",
      candidatesConsidered: 0,
      graphsQueried,
      warnings,
    };
  }

  const keepAlts = opts.alternates ?? 3;
  const best = toRanked(top, tier);
  const alternates = scored
    .slice(1, 1 + keepAlts)
    .map((s) =>
      toRanked(s, s.intel.isDecisionMaker && !s.isRecruiter ? "function_leader" : "recruiter"),
    );

  return {
    company,
    roleTitle,
    target,
    best,
    alternates,
    tier,
    candidatesConsidered: scored.length,
    graphsQueried,
    warnings,
  };
}

function dedupeReasons(reasons: string[], c: PersonCandidate, company: string): string[] {
  const head = c.title ? `${c.title}${c.companyName ? ` at ${c.companyName}` : ` at ${company}`}` : undefined;
  const all = head ? [head, ...reasons] : reasons;
  return [...new Set(all)];
}
