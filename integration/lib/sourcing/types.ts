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
  warnings: string[];
  createdAt: string;
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
  /** Which engines to use, in cheapest-first order. Defaults to whatever is configured. */
  engines?: Array<"google" | "rapidapi" | "scraper">;
  /** Candidate keys (see candidateKey) to skip — the cross-run "seen" set for fresh-only runs. */
  excludeKeys?: Set<string>;
}
