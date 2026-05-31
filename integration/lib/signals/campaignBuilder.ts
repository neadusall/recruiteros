/**
 * RecruiterOS · Signal Engine
 * Pre-launch campaign builder.
 *
 * The product flow the user asked for: "build out a campaign BEFORE we launch a campaign,
 * utilize the free APIs to organize those signals and make it very seamless." This module
 * is that step. It takes raw signals (collected from FREE sources), applies a filter
 * (industry, job title, function, geo...), scores and ranks them, organizes them into a
 * reviewable target list grouped into segments, estimates what enrichment will cost, and
 * proposes a signal-grounded outreach angle per target — all WITHOUT spending anything.
 *
 * The output is a `CampaignDraft`: everything a recruiter needs to review and approve
 * before the first paid enrichment call or the first message goes out. Approving the
 * draft is what flips targets into the enrichment waterfall + the outreach sequence.
 *
 *   collect(free sources) → filter(industry/title/...) → rank → buildCampaign → REVIEW → launch
 */

import type { ICP, Signal, Motion } from "./types";
import { rankSignals, type ScoreContext } from "./scoring";
import { getDefinition } from "./registry";
import {
  applyFilter,
  segmentBy,
  classifyTitle,
  titleOf,
  industriesOf,
  type SignalFilter,
  type Segment,
} from "./filters";

/* ------------------------------------------------------------------ */
/* Target — one row in the campaign, before enrichment                 */
/* ------------------------------------------------------------------ */

/** A single company/person the campaign will pursue, assembled from free signals. */
export interface CampaignTarget {
  /** Stable key (company domain/name, or person id). */
  key: string;
  kind: "company" | "person";
  name: string;
  /** Best title we know (role posted, or the person's). */
  title?: string;
  function?: string;
  seniority?: string;
  industries: string[];
  location?: string;
  /** The signals backing this target, strongest first. */
  signals: Signal[];
  /** Highest signal score among the backing signals (0..100). */
  score: number;
  /** The single best reason to reach out, for the outreach first line. */
  primaryReason: string;
  /** Which contact fields still need enrichment (drives the cost estimate). */
  needs: { email: boolean; phone: boolean; name: boolean };
}

/* ------------------------------------------------------------------ */
/* Campaign draft — the reviewable artifact                            */
/* ------------------------------------------------------------------ */

export interface CampaignDraft {
  name: string;
  motion: Motion;
  /** The filter that shaped this list (echoed back for the UI + audit). */
  filter: SignalFilter;
  /** Ranked targets ready for review. */
  targets: CampaignTarget[];
  /** Targets grouped for review (by function by default). */
  segments: Segment[];
  /** Headline stats for the review screen. */
  stats: {
    signalsConsidered: number;
    signalsMatched: number;
    targets: number;
    companies: number;
    people: number;
    bySignalType: Record<string, number>;
    topIndustries: Array<{ industry: string; count: number }>;
  };
  /** Estimated enrichment spend to fully contact this list (free signals → paid contacts). */
  costEstimate: CostEstimate;
  /** Free-source provenance: this draft cost $0 to assemble. */
  assembledFrom: "free_signals";
}

export interface CostEstimate {
  emailsToFind: number;
  phonesToFind: number;
  /** Cheap-first blended assumptions, surfaced so the number is auditable. */
  assumptions: { emailPerContactUsd: number; phonePerContactUsd: number };
  estEmailCostUsd: number;
  estPhoneCostUsd: number;
  estTotalUsd: number;
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  name: string;
  icp: ICP;
  filter: SignalFilter;
  now: string;
  /** Cap the target list (review ergonomics + cost control). */
  maxTargets?: number;
  /** Whether the campaign intends to pull phones (raises the estimate). */
  wantPhone?: boolean;
  /** Cheap-first cost assumptions; defaults reflect Icypeas-class + RapidAPI pricing. */
  costAssumptions?: Partial<CostEstimate["assumptions"]>;
}

/**
 * Build a reviewable campaign draft from already-collected (free) signals. Pure and
 * deterministic given `now`; performs no network calls, so the whole "organize before
 * launch" step is free and instant.
 */
export function buildCampaign(signals: Signal[], opts: BuildOptions): CampaignDraft {
  const ctx: ScoreContext = { now: opts.now };

  // 1. Filter to the ICP's audience (industry / title / function / geo...).
  const matched = applyFilter(signals, opts.filter);

  // 2. Score + rank what survived.
  const ranked = rankSignals(matched, opts.icp, ctx);

  // 3. Fold signals into one target per entity, keeping the strongest signal on top.
  const byEntity = new Map<string, Signal[]>();
  for (const s of ranked) {
    const key = targetKey(s);
    (byEntity.get(key) ?? byEntity.set(key, []).get(key)!).push(s);
  }

  let targets: CampaignTarget[] = [...byEntity.entries()].map(([key, sigs]) => {
    const top = sigs[0];
    const title = titleOf(top);
    const intel = title ? classifyTitle(title) : undefined;
    const isPerson = Boolean(top.person);
    return {
      key,
      kind: isPerson ? "person" : "company",
      name: top.person?.fullName ?? top.company?.name ?? key,
      title,
      function: intel?.function,
      seniority: intel?.seniority,
      industries: industriesOf(top),
      location:
        (top.evidence.location as string | undefined) ??
        top.company?.hqLocation?.raw ??
        top.person?.location?.raw,
      signals: sigs,
      score: top.score?.value ?? 0,
      primaryReason: reasonFor(top),
      needs: {
        email: isPerson ? !top.person?.email : true,
        phone: opts.wantPhone === true,
        name: isPerson ? !top.person?.fullName : true,
      },
    };
  });

  // 4. Rank targets by their best signal, cap the list.
  targets.sort((a, b) => b.score - a.score);
  if (opts.maxTargets) targets = targets.slice(0, opts.maxTargets);

  // 5. Segment + stats + cost estimate for the review screen.
  const segments = segmentBy(
    targets.flatMap((t) => t.signals),
    opts.filter.functions?.length ? "function" : "signalType",
  );

  const stats = computeStats(signals.length, matched.length, targets);
  const costEstimate = estimateCost(targets, opts);

  return {
    name: opts.name,
    motion: opts.icp.motion,
    filter: opts.filter,
    targets,
    segments,
    stats,
    costEstimate,
    assembledFrom: "free_signals",
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function targetKey(s: Signal): string {
  if (s.person) return `p:${(s.person.providerProfileId ?? s.person.id ?? s.person.fullName).toLowerCase()}`;
  return `c:${(s.company?.domain ?? s.company?.name ?? "unknown").toLowerCase()}`;
}

/** The single strongest reason to reach out, used as the outreach first-line seed. */
function reasonFor(s: Signal): string {
  const def = getDefinition(s.type);
  const ev = s.evidence as Record<string, unknown>;
  switch (s.type) {
    case "hiring_velocity":
      return `posted ${ev.rolesPosted ?? "several"} roles recently`;
    case "funding_round":
      return ev.amountUsd ? `just raised ${formatUsd(Number(ev.amountUsd))}` : "just raised a round";
    case "warn_notice":
    case "layoff":
      return `a reduction puts strong people on the market`;
    case "exec_hire":
      return `a new ${ev.title ?? "leader"} is rebuilding the team`;
    case "job_posting":
    case "job_repost":
      return `is hiring for ${ev.roleTitle ?? "an open role"}`;
    case "office_expansion":
      return `is opening ${ev.location ?? "a new location"}`;
    default:
      return def.label.toLowerCase();
  }
}

function computeStats(considered: number, matched: number, targets: CampaignTarget[]): CampaignDraft["stats"] {
  const bySignalType: Record<string, number> = {};
  const industryCounts = new Map<string, number>();
  let companies = 0;
  let people = 0;
  for (const t of targets) {
    if (t.kind === "company") companies++;
    else people++;
    for (const s of t.signals) bySignalType[s.type] = (bySignalType[s.type] ?? 0) + 1;
    for (const ind of t.industries) industryCounts.set(ind, (industryCounts.get(ind) ?? 0) + 1);
  }
  const topIndustries = [...industryCounts.entries()]
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  return { signalsConsidered: considered, signalsMatched: matched, targets: targets.length, companies, people, bySignalType, topIndustries };
}

/**
 * Estimate enrichment spend. Defaults reflect the cheap-first waterfall: an email
 * resolves for a few tenths of a cent (Icypeas-class) plus a verify, and a phone is an
 * order of magnitude more and lower-yield. Surfaced with assumptions so the figure is
 * auditable, not a black box.
 */
function estimateCost(targets: CampaignTarget[], opts: BuildOptions): CostEstimate {
  const assumptions = {
    emailPerContactUsd: opts.costAssumptions?.emailPerContactUsd ?? 0.006, // Icypeas + verify, blended
    phonePerContactUsd: opts.costAssumptions?.phonePerContactUsd ?? 0.02, // cheap-first RapidAPI lookup (mobile + landline enriched as separate fields downstream)
  };
  const emailsToFind = targets.filter((t) => t.needs.email).length;
  const phonesToFind = opts.wantPhone ? targets.filter((t) => t.needs.phone).length : 0;
  const estEmailCostUsd = round(emailsToFind * assumptions.emailPerContactUsd);
  const estPhoneCostUsd = round(phonesToFind * assumptions.phonePerContactUsd);
  return {
    emailsToFind,
    phonesToFind,
    assumptions,
    estEmailCostUsd,
    estPhoneCostUsd,
    estTotalUsd: round(estEmailCostUsd + estPhoneCostUsd),
  };
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n}`;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Launch hand-off                                                     */
/* ------------------------------------------------------------------ */

/**
 * Once a draft is approved, this produces the work items the rest of the platform acts on:
 * the enrichment jobs (one per target that needs contact data) and the outreach seeds
 * (the signal-grounded first line per target). This is the seam between the FREE
 * organize-before-launch phase and the PAID execution phase.
 */
export interface LaunchPlan {
  enrichmentJobs: Array<{ targetKey: string; subject: Record<string, unknown> }>;
  outreachSeeds: Array<{ targetKey: string; reason: string; signalType: string }>;
}

export function planLaunch(draft: CampaignDraft): LaunchPlan {
  return {
    enrichmentJobs: draft.targets
      .filter((t) => t.needs.email || t.needs.phone || t.needs.name)
      .map((t) => ({
        targetKey: t.key,
        subject: {
          fullName: t.kind === "person" ? t.name : undefined,
          companyName: t.kind === "company" ? t.name : t.signals[0]?.company?.name,
          domain: t.signals[0]?.company?.domain,
          title: t.title,
        },
      })),
    outreachSeeds: draft.targets.map((t) => ({
      targetKey: t.key,
      reason: t.primaryReason,
      signalType: t.signals[0]?.type ?? "unknown",
    })),
  };
}
