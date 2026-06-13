/**
 * RecruitersOS · Signal Engine
 * Domain types for the hiring-signal framework.
 *
 * The Signal Engine answers one question continuously: "who just became hire-able,
 * and who is about to start hiring?" It does that by watching the market across many
 * sources, normalizing every observation into a `Signal`, resolving it to a real
 * `Company` and/or `Person`, scoring it against the user's ICP, and emitting a ranked
 * work-list that can auto-trigger a campaign.
 *
 * These types are intentionally framework-agnostic so they map cleanly onto the
 * RecruitersOS core models (Campaign, Account, Prospect) and onto the LinkedIn Engine
 * in ../linkedin without coupling to any ORM or vendor SDK.
 */

/* ------------------------------------------------------------------ */
/* Signal taxonomy                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every hiring signal RecruitersOS knows how to detect, grouped by what it tells you.
 *
 * COMPANY-SIDE — "this company is (about to be) hiring", drives Business Development.
 * PEOPLE-SIDE  — "this person just became reachable", drives Recruiting.
 *
 * Add new detectors by extending this union and registering a `SignalDefinition`
 * in ./registry. Nothing else in the engine hard-codes the list.
 */
export type SignalType =
  // ── Company: capital & growth ──────────────────────────────────
  | "funding_round"        // seed → late stage raise; new budget + mandate to hire
  | "ipo_or_s1"            // S-1 filing / IPO; aggressive public-company hiring
  | "acquisition"          // company was acquired; integration + retention churn
  | "merger"               // merger of equals; org reshuffle, redundancy + new roles
  | "revenue_milestone"    // ARR / earnings beat; capacity expansion
  | "grant_or_contract"    // gov grant, RFP win, large contract; staffing to deliver
  // ── Company: hiring intent (the strongest, most direct signals) ─
  | "job_posting"          // a new open role appeared
  | "hiring_velocity"      // a surge in posting cadence vs the company's baseline
  | "job_repost"           // same role reposted; struggling to fill = warm for help
  | "evergreen_role"       // role open > N days; pipeline pain
  | "headcount_growth"     // observed employee-count delta (e.g. LinkedIn)
  | "careers_page_launch"  // new careers site / ATS subdomain detected
  | "ats_detected"         // adopted/changed an ATS; building a hiring function
  // ── Company: leadership & org change ───────────────────────────
  | "exec_hire"            // new VP / C-level; rebuilds their org within ~90 days
  | "exec_departure"       // exec left; backfill + team destabilization
  | "department_head_change" // new function lead (Eng/Sales/Mktg) → team build-out
  | "board_change"         // new board member / chair; strategic shift
  // ── Company: contraction (great talent hits the market) ────────
  | "layoff"               // workforce reduction announced
  | "warn_notice"          // official WARN Act filing (US); precise + dated
  | "office_closure"       // site shutdown; localized talent release
  | "down_round"           // distress financing; flight risk among staff
  | "bankruptcy"           // Ch.7/11; talent + client base in play
  // ── Company: footprint & strategy ──────────────────────────────
  | "office_expansion"     // new office / relocation; greenfield local team
  | "market_entry"         // new country / region / segment
  | "product_launch"       // new product line; team to build + sell it
  | "partnership"          // major partnership / channel deal
  | "tech_stack_change"    // adopted a new technology; specialists needed
  | "intent_surge"         // research/intent spike on hiring-adjacent topics
  | "web_traffic_surge"    // demand spike implying scale pressure
  | "review_velocity"      // Glassdoor/G2 review spike; growth or churn tell
  // ── People: availability ───────────────────────────────────────
  | "open_to_work"         // explicit "open to work" / availability flag
  | "tenure_milestone"     // 3-/4-year marks when people start looking
  | "promotion_passed_over"// title stagnation; quiet flight risk
  | "employer_distress"    // their employer hit a layoff/down-round/exit
  | "layoff_affected"      // person confirmed impacted by a reduction
  | "job_change"           // recently changed jobs; map + nurture for later
  | "profile_update"       // headline/skills refresh; often precedes a search
  | "activity_spike"       // posting/endorsement/engagement surge = momentum
  | "relocation"           // moved / relocating; new market availability
  | "education_completion" // finished a degree/bootcamp/cert; re-entering market
  | "contract_ending";     // contractor/visa term ending; timed availability

/** Which operating system a signal feeds. Mirrors the product's two-OS split. */
export type Motion = "recruiting" | "business_dev";

/** Coarse grouping used for filtering, analytics, and UI sectioning. */
export type SignalCategory =
  | "capital"
  | "hiring_intent"
  | "leadership"
  | "contraction"
  | "footprint"
  | "people";

/** The entity a signal is primarily about. */
export type SubjectKind = "company" | "person";

/* ------------------------------------------------------------------ */
/* Signal definition (the "framework" — metadata about each signal)    */
/* ------------------------------------------------------------------ */

/**
 * Static description of a signal type: what it means, how strong it is, how fast it
 * decays, and which sources can produce it. The ./registry holds one of these per
 * `SignalType`. This is the catalog RecruitersOS exposes as a service so users can see
 * exactly what is being watched and tune weighting.
 */
export interface SignalDefinition {
  type: SignalType;
  label: string;                 // human label, e.g. "Hiring surge"
  category: SignalCategory;
  subject: SubjectKind;
  motion: Motion;
  /** One-line explanation of why this signal is an opportunity. */
  rationale: string;
  /**
   * Base strength 0..1 before ICP fit and recency are applied. Direct hiring intent
   * (a posted role) outranks a soft proxy (web-traffic surge).
   */
  baseWeight: number;
  /**
   * Half-life in hours: how quickly the signal goes stale. A WARN notice stays
   * actionable for weeks; an "open to work" flag is hottest in the first 48h.
   */
  halfLifeHours: number;
  /** Source kinds capable of emitting this signal (see SourceKind). */
  emittedBy: SourceKind[];
  /** Keys whose presence in `Signal.evidence` strengthens confidence. */
  evidenceKeys?: string[];
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** The class of data a connector pulls from. Drives routing + dedupe priority. */
export type SourceKind =
  | "job_board"        // Indeed, LinkedIn Jobs, Greenhouse/Lever boards, Ashby…
  | "ats_public"       // public ATS endpoints (Greenhouse, Lever, Ashby JSON)
  | "funding_db"       // Crunchbase, Dealroom, SEC EDGAR
  | "news"             // news / press / RSS / Google News
  | "gov_filing"       // WARN, SEC, USAspending, patents
  | "people_graph"     // LinkedIn / Unipile profile + employment changes
  | "company_graph"    // headcount, firmographics, tech-stack (BuiltWith, Clearbit)
  | "intent"           // Bombora / G2 / web-traffic intent providers
  | "social"           // X, public posts, community signals
  | "webhook"          // inbound push from a partner or the user's own systems
  | "manual";          // recruiter-entered observation

/** Provenance for one raw observation behind a signal. */
export interface SourceRef {
  kind: SourceKind;
  /** Stable id of the connector that produced it, e.g. "greenhouse", "edgar". */
  connector: string;
  /** Canonical URL of the underlying artifact (job post, filing, article). */
  url?: string;
  /** Provider-native id, used for idempotency + dedupe. */
  externalId?: string;
  /** When the source observed it (ISO). Distinct from when we ingested it. */
  observedAt: string;
}

/* ------------------------------------------------------------------ */
/* Resolved entities                                                   */
/* ------------------------------------------------------------------ */

/** A company a signal resolves to, after entity resolution. */
export interface Company {
  id: string;                    // RecruitersOS canonical company id
  name: string;
  domain?: string;               // primary key for dedupe across sources
  linkedinUrl?: string;
  industry?: string;
  /** Employee count band, used for ICP size filters. */
  headcount?: number;
  headcountBand?: "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1001-5000" | "5000+";
  /** Funding stage if known. */
  stage?: FundingStage;
  hqLocation?: GeoPoint;
  /** Locations we have seen the company hire in. */
  hiringLocations?: GeoPoint[];
  techStack?: string[];
}

export type FundingStage =
  | "pre_seed" | "seed" | "series_a" | "series_b" | "series_c"
  | "series_d_plus" | "public" | "bootstrapped" | "unknown";

/** A person a signal resolves to (the hiring manager, or a candidate). */
export interface Person {
  id: string;
  fullName: string;
  firstName?: string;
  headline?: string;
  title?: string;
  companyId?: string;
  companyName?: string;
  linkedinUrl?: string;
  providerProfileId?: string;    // maps to ../linkedin Prospect.providerProfileId
  email?: string;                // resolved by the waterfall, may be null until then
  location?: GeoPoint;
  /** True when this person is a hiring decision-maker for the role in question. */
  isHiringManager?: boolean;
  seniority?: "ic" | "lead" | "manager" | "director" | "vp" | "c_level" | "founder";
}

export interface GeoPoint {
  raw: string;                   // as observed, e.g. "Berlin, DE"
  city?: string;
  region?: string;
  country?: string;              // ISO-3166 alpha-2 where resolvable
  remote?: boolean;
}

/* ------------------------------------------------------------------ */
/* The Signal itself                                                   */
/* ------------------------------------------------------------------ */

/** Lifecycle of a signal as it moves through the engine. */
export type SignalStatus =
  | "raw"          // ingested, not yet resolved/deduped
  | "resolved"     // entity-resolved to a Company/Person
  | "scored"       // ICP-matched + ranked
  | "triggered"    // launched (or fed) a campaign
  | "dismissed"    // filtered out (disqualifier) or user-archived
  | "expired";     // decayed past usefulness

/**
 * A normalized market observation. This is the atomic unit the whole engine moves
 * around: sources produce raw Signals, the collector resolves/dedupes/scores them,
 * and high scorers trigger campaigns.
 */
export interface Signal {
  id: string;
  type: SignalType;
  motion: Motion;
  status: SignalStatus;

  /** Short headline, e.g. "Verla Health raised a $40M Series B". */
  title: string;
  /** One or two sentences of context for the recruiter and the AI personalizer. */
  detail: string;

  /** Resolved subject(s). At least one is present after resolution. */
  company?: Company;
  person?: Person;

  /**
   * Structured, signal-specific facts the scorer and personalizer can use.
   * e.g. { amountUsd: 40_000_000, stage: "series_b", investors: ["…"] }
   *      { rolesPosted: 9, window: "7d", functions: ["engineering"] }
   *      { reductionPct: 40, affectedCount: 120, effectiveDate: "2026-06-15" }
   */
  evidence: Record<string, unknown>;

  /** Every source that contributed (one signal can be corroborated by many). */
  sources: SourceRef[];

  /** When the underlying event happened (best estimate, ISO). */
  eventAt: string;
  /** When RecruitersOS first ingested it (ISO). */
  ingestedAt: string;

  /** Populated by the scorer; see ./scoring. */
  score?: SignalScore;

  /** Free dedupe/grouping key (e.g. domain+type+week). */
  dedupeKey: string;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * The Ideal Customer / Candidate Profile a user defines per workspace or campaign.
 * Signals are matched against this to drop the irrelevant and rank what remains.
 */
export interface ICP {
  id: string;
  motion: Motion;
  /** Signal types this ICP cares about; empty = all for the motion. */
  signalTypes?: SignalType[];
  /** Per-signal-type weight overrides (multiplies SignalDefinition.baseWeight). */
  weightOverrides?: Partial<Record<SignalType, number>>;

  industries?: string[];
  headcountBands?: Company["headcountBand"][];
  stages?: FundingStage[];
  /** ISO alpha-2 countries / freeform regions to include. */
  geos?: string[];
  remoteOk?: boolean;
  titles?: string[];             // target hiring-manager or candidate titles
  techStack?: string[];

  /** Hard disqualifiers: any match drops the signal outright. */
  disqualifiers?: {
    industries?: string[];
    geos?: string[];
    stages?: FundingStage[];
    maxHeadcount?: number;
    minHeadcount?: number;
    keywords?: string[];         // appear in title/detail → drop
  };

  /** Score at or above which a signal may auto-trigger a campaign (0..100). */
  autoTriggerThreshold?: number;
}

/** Output of scoring one signal against one ICP. */
export interface SignalScore {
  /** Final 0..100 rank used to order the work-list. */
  value: number;
  /** Contribution breakdown, for transparency in the UI. */
  components: {
    base: number;        // from SignalDefinition.baseWeight
    fit: number;         // ICP match strength
    recency: number;     // time-decay multiplier applied
    corroboration: number; // boost for multi-source agreement
    urgency: number;     // signal-specific time pressure (e.g. WARN date)
  };
  /** True when value >= ICP.autoTriggerThreshold. */
  shouldTrigger: boolean;
  /** Human-readable "why this ranked here", e.g. ["Series B fit", "posted 9 roles"]. */
  reasons: string[];
  /** Disqualifier that dropped it, when value === 0. */
  disqualifiedBy?: string;
}

/* ------------------------------------------------------------------ */
/* Source contract result                                              */
/* ------------------------------------------------------------------ */

/** What a source connector returns from one poll. */
export interface PullResult {
  signals: Signal[];
  /** Opaque cursor for incremental polling (store + pass back next pull). */
  cursor?: string;
  /** Soft rate-limit hint: do not poll again before this (ISO). */
  nextPollAfter?: string;
  /** Non-fatal issues (a sub-source failed, partial page, etc.). */
  warnings?: string[];
}
