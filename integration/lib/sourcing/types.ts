/**
 * RecruitersOS · JD Sourcing
 *
 * Types for the "upload a JD → get a ranked list of likely-fit candidates" flow.
 *
 * The pipeline is: JD text → CandidateICP (LLM parse) → SourcingQuery[] (Boolean /
 * X-ray + LinkedIn search URLs) → discovery returns CandidateRow[] → score + rank →
 * staged as a named SourcingRun in the JD Sourcing tab → promoted into Candidates
 * (Prospects) under the same saved name.
 *
 * Everything here is plain data so the same shapes flow through the API, the store,
 * and the UI without coupling to the signal engine's company-oriented ICP.
 */

import type { Motion } from "../core/types";

/**
 * How wide a discovery run casts its net (the Sales-Navigator-style breadth dial).
 *  - focused: the closest title matches only (the pre-2026-07-16 behavior).
 *  - balanced: every title variation of the role rides in the searches (default).
 *  - wide: all title variations + deeper paging + searches beyond the exact
 *    location wording; post-search location filtering keeps the list honest.
 */
export type SearchBreadth = "focused" | "balanced" | "wide";

/** Structured ideal-candidate profile parsed from a job description. */
export interface CandidateICP {
  /** Short human label, e.g. "VP Sales — Source-to-Pay (East Coast)". */
  label: string;
  /** Seniority band the role targets. */
  seniority: "ic" | "manager" | "director" | "vp" | "exec";
  /** Must currently manage a team (2nd-line+ leadership). */
  managesTeam: boolean;
  /** Target candidate titles, most-specific first (drives keywords). */
  titles: string[];
  /** Freeform regions / metros to include, e.g. ["New York","Boston","Atlanta"]. */
  geos: string[];
  /** Whether remote candidates outside the named geos still qualify. */
  remoteOk: boolean;
  /** Industries / domains the ideal candidate sells into or works in. */
  industries: string[];
  /** Named companies to source from (competitors + adjacents). */
  targetCompanies: string[];
  /** Buyer personas the candidate sells to, e.g. ["CFO","CPO","CIO"]. */
  sellsTo: string[];
  /** Verticals to weight, e.g. ["Manufacturing","Public Sector","Life Sciences"]. */
  verticals: string[];
  /** Skills / keywords that signal fit. */
  mustHave: string[];
  niceToHave: string[];
  /** Hard disqualifiers — a match drops the candidate. */
  disqualifiers: string[];
}

/** One runnable search derived from the ICP. */
export interface SourcingQuery {
  /** Target company / theme this query covers (grouping + provenance). */
  group: string;
  /** Human label shown in the UI. */
  label: string;
  /** Google X-ray Boolean string (site:linkedin.com/in ...). */
  xray: string;
  /** A ready Google search URL wrapping the X-ray string. */
  googleUrl: string;
  /** LinkedIn People Search URL (keyword-based; feeds importFromLinkedInSearch). */
  linkedinUrl: string;
  /** Plain keyword for keyword-based people-search APIs (POST {keywords}), e.g. "VP Sales Coupa". */
  keyword: string;
  /* --- Structured filters (Fresh /search/people: precise > fuzzy keyword) ----
   * When set, these feed the listing's dedicated filter params instead of cramming
   * role+company+geo into one name string — far higher precision, fewer wasted requests. */
  /** Just the title/role for the `name` field when structured filters carry company/geo. */
  titleTerm?: string;
  /** Maps to current_company — people who work there NOW (the poaching filter). */
  currentCompany?: string;
  /** Maps to geocode_location — a single metro/region to constrain to. */
  geoLocation?: string;
  /** Maps to past_company — people who USED to work there (alumni sourcing). */
  pastCompany?: string;
}

/** A discovered candidate before they become a Prospect (the staged unit). */
export interface CandidateRow {
  fullName: string;
  title?: string;
  headline?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  imageUrl?: string;
  /** Contact info, populated only after enrichment. */
  email?: string;
  phone?: string;
  /** 0..100 fit score against the ICP. */
  fitScore: number;
  /** Human-readable reasons the score landed where it did. */
  fitReasons: string[];
  /** 0..100 LLM relevance from the optional re-rank pass (sharper than the rule score). */
  llmScore?: number;
  /** Which query group surfaced this row. */
  sourceGroup?: string;
  /** Data source that produced the row (rapidapi / scraper / web). */
  provider?: string;
  /**
   * True when the person states a location OUTSIDE the target geos on a
   * location-pinned search. Out-of-area rows live in their own block after the
   * in-area list (never interleaved) so a geo'd search stays within its geo while
   * nothing found is silently discarded.
   */
  outOfArea?: boolean;

  /* --- Stage-2 deep-vet (LLM reads the full profile vs the JD) ------------- */
  /** 0..100 verified fit after reading the candidate's full work history. */
  verifiedScore?: number;
  /** Headline verdict from the deep-vet pass. */
  verdict?: "strong" | "possible" | "weak" | "no";
  /** Estimated years of role-relevant experience. */
  yearsRelevant?: number;
  /** What genuinely fits (from the work history, not the title line). */
  vetStrengths?: string[];
  /** Where the candidate falls short of the JD. */
  vetGaps?: string[];
  /** Risk flags: job_hopping, title_inflation, domain_mismatch, gap, etc. */
  vetFlags?: string[];
  /** One-line human-readable rationale for the verified score. */
  vetRationale?: string;
  /** True once the full profile was fetched (vs vetted on shallow fields only). */
  profileFetched?: boolean;
  /**
   * When the paid phone boost last attempted this row (hit or miss). A missed
   * lookup is never re-billed: boosted rows are excluded from later boost passes,
   * so pressing Boost phones repeatedly only ever pays for fresh rows.
   */
  premiumPhoneTriedAt?: string;
}

/** A named, saved sourcing result that lives in the JD Sourcing tab (staging). */
export interface SourcingRun {
  id: string;
  workspaceId: string;
  /** The name the recruiter saves it under — reused as the Candidates list name. */
  name: string;
  motion: Motion;
  jd: string;
  jdUrl?: string;
  /** City & state of the role, as entered by the recruiter (saved with the list). */
  location?: string;
  icp: CandidateICP;
  queries: SourcingQuery[];
  candidates: CandidateRow[];
  /** Quota'd search-API requests the discovery run spent building this list, by
   *  engine (rapidapi = the paid people-search listing's monthly credits). */
  apiUsage?: { rapidapi?: number; serper?: number; google?: number };
  /** Set once promoted into Candidates, with the created campaign + list ids. */
  promotedCampaignId?: string;
  promotedListId?: string;
  promotedCount?: number;
  /**
   * A deep-vet batch currently in flight (Message Batches API). Present from submit
   * until the results are ingested, then cleared. Persisted so a redeploy mid-batch
   * doesn't strand it — the tab resumes polling by batchId.
   */
  vetBatch?: VetBatchRef;
  /**
   * A Laxis enrichment job currently in flight on the browser worker. Present from
   * submit until the enriched CSV is merged back, then cleared. Parked on the run so a
   * redeploy mid-job doesn't strand it — the tab resumes polling by jobId.
   */
  laxisJob?: LaxisJobRef;
  /**
   * A KoldInfo bulk-find job (the FREE first enrichment rung) in flight on the browser
   * worker. Present from submit until the result emails are merged back, then cleared.
   * Parked on the run so a redeploy mid-job doesn't strand it.
   */
  koldJob?: KoldJobRef;
  /**
   * A KoldInfo DATABASE-lookup job (name + city/state search over People DB +
   * Business Email DB) in flight on the browser worker. This is the rung that needs NO
   * LinkedIn URL, so it reaches candidates the LinkedIn-URL enrichment (koldJob) cannot.
   * Runs right after koldJob and before Laxis. Cleared once its results are merged.
   */
  koldDbJob?: KoldJobRef;
  /**
   * Chunk-level progress for multi-batch Laxis enrichment (Laxis caps each import at
   * 1,000 rows, so a big list is enriched in sequential 1,000-row chunks). Records which
   * chunk offsets have already been enriched + merged so that re-running — after the tab
   * was closed mid-pull, or a chunk errored — resumes from the next un-enriched chunk and
   * never re-grabs data Laxis already pulled (no wasted credits / time).
   */
  laxisProgress?: LaxisProgress;
  /**
   * Server-side auto-send bookkeeping (lib/sourcing/autoflow): stamped once the
   * sweeper (or a retry of it) pushed this list on to Candidates + OS Text, so a
   * finished list is never pushed twice — and a later enrichment that finds MORE
   * phones than phonesAtSend triggers exactly one top-up re-send.
   */
  autoflow?: {
    sentAt?: string;
    /** Candidates holding a phone at the last send — the top-up trigger. */
    phonesAtSend: number;
    attempts: number;
    /** When the sweeper queued a server-side resume for an orphaned chain. */
    resumedAt?: string;
    /** Last failure (kept for ops visibility); cleared on a clean send. */
    error?: string;
  };
  /**
   * Skip the settle/idle waits: auto-send this run on the very next sweep (and the
   * merge handler fires one immediately in-request). Set on runs born finished,
   * e.g. a "Combine lists" merge of already-enriched lists.
   */
  sendAsap?: boolean;
  /**
   * Source run ids this run was combined from (the "Combine lists" merge).
   * Presence marks a combined master list: its promote retags every person it
   * holds (even ones already in the pipeline from the source lists) with the
   * combined list's name, so the whole set is pullable by one tag in Candidates.
   */
  combinedFrom?: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

/** Chunk-level progress for multi-batch Laxis enrichment, so a resumed pull skips done work. */
export interface LaxisProgress {
  /** Start offsets of chunks already enriched + merged (deduped, ascending). */
  doneOffsets: number[];
  /** Candidate count when enrichment began — basis for the nextStart calculation. */
  total: number;
  /** The next offset still needing enrichment, or null when every chunk is done. */
  nextStart: number | null;
  updatedAt: string;
}

/** A Laxis enrichment job in flight, parked on the run so polling survives a redeploy. */
export interface LaxisJobRef {
  /** The worker's job id to poll. */
  jobId: string;
  submittedAt: string;
  /** Offset of this chunk within run.candidates (Laxis caps each import at 1,000). */
  start?: number;
  /** Size of the candidate window this job covers (used for the gap-fill slice). */
  count: number;
  /** How many rows actually went to Laxis (those with a LinkedIn URL or email). */
  sent?: number;
  /** Stable candidate keys in the order they were serialized (diagnostics / re-attach). */
  targets: string[];
}

/** A KoldInfo bulk-find job in flight, parked on the run so polling survives a redeploy. */
export interface KoldJobRef {
  /** The worker's job id to poll. */
  jobId: string;
  submittedAt: string;
  /** How many missing-email rows were sent to KoldInfo. */
  count: number;
}

/** A deep-vet batch in flight, parked on the run so polling survives a redeploy. */
export interface VetBatchRef {
  /** Anthropic Message Batches id to poll. */
  batchId: string;
  submittedAt: string;
  /** How many of the top-ranked candidates were submitted. */
  top: number;
  /** True if full profiles were fetched before submitting (deep vs surface-only). */
  deep: boolean;
  /**
   * Candidate keys in submit order; custom_id "vet_<i>" maps to targets[i]. Lets us
   * re-attach a result to the right candidate even if the list was re-sorted since.
   */
  targets: string[];
  /** Warnings captured at submit time (e.g. profile fetch failures). */
  warnings?: string[];
}

/** Knobs for a discovery run. */
export interface DiscoveryOptions {
  /** Stop once this many ranked, deduped rows are collected. Default 3000. */
  cap?: number;
  /** Drop rows scoring below this fit threshold (0..100). Default 45. */
  minFit?: number;
  /** Which engines to use, in cheapest-first order. Defaults to whatever is configured.
   *  "koldinfo" is the free contact-database sweep (title + geo over the Business Email
   *  DB via the browser worker) — a candidate SOURCE that arrives with emails/phones. */
  engines?: Array<"koldinfo" | "google" | "searx" | "serper" | "rapidapi" | "scraper">;
  /** Candidate keys (see candidateKey) to skip — the cross-run "seen" set for fresh-only runs. */
  excludeKeys?: Set<string>;
  /**
   * Drop candidates whose stated location is OUTSIDE the ICP geos (rows with no
   * location are kept — snippets often omit it). On by default when the recruiter
   * pinned an explicit hiring location.
   */
  strictGeo?: boolean;
  /**
   * OPT-IN: also return the out-of-area people as a separate marked block after the
   * in-area list. OFF by default so a geo'd run stays geo-only and downstream paid
   * steps (deep-vet, enrichment credits) are never spent on non-locals unless the
   * recruiter explicitly asked to see them. When off, out-of-area rows are dropped
   * (still buffered for the never-empty rescue).
   */
  keepOutOfArea?: boolean;
  /**
   * Search breadth: controls how deep each engine pages per query (query FAN-OUT is
   * decided earlier, in generateQueries). Default "balanced".
   */
  breadth?: SearchBreadth;
}
