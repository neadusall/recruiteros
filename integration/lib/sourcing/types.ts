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
import type { PreflightReport } from "./preflight";

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
  /** The search result's snippet: a line or two of the profile's About/summary text.
   *  Free evidence that used to be discarded whenever a headline existed, and the
   *  place long-tail proof ("CPA", "ASC 740", "BCBA", "PointClickCare") actually
   *  shows up. Read by proof scoring; never shown raw to a recruiter. */
  snippet?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  imageUrl?: string;
  /** Contact info, populated only after enrichment. */
  email?: string;
  phone?: string;
  /**
   * Which rung produced the phone: "skiptrace" (Boost), "koldinfo", "laxis",
   * "landlinedb", "finder" (generic RapidAPI phone/mobile listing). Travels with
   * the number into OS Text (customFields.phone_source) so send/response outcomes
   * can be tracked back to the source that supplied the number (the phone-accuracy
   * metric). Absent = source unknown (legacy rows, CSV imports).
   */
  phoneSource?: string;
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

  /**
   * True when this row survived the location filter WITHOUT being measured — its stated
   * location would not resolve to a coordinate, so it was kept on the never-empty rule
   * rather than because the radius cleared it.
   *
   * It exists so an unmeasured row can be re-judged later: enrichment often fills in a
   * real city after the search is over, and `enforceRunGeo` re-measures every row still
   * carrying this flag. Without it a person whose location only became readable
   * post-search would sit in the deliverable list as though the mileage had passed them.
   */
  geoUnverified?: boolean;

  /**
   * Straight-line miles from the recruiter's typed location, when both that location and
   * the person's stated one could be resolved to coordinates. Undefined means "not
   * measurable" (no radius picked, or a location the place table does not know) — it is
   * never a stand-in for "far away". Surfaced so the recruiter can see WHY a row counted
   * as local, and so ranking can prefer the nearer of two equally good people.
   */
  milesFromTarget?: number;

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
  /** The recruiter who ran (or queued) the search. The server-side auto-send
   *  stamps THEM as the OS Text campaign owner and texts introduce them by
   *  name; absent (legacy runs, pre-2026-07-21), the campaign lands Unassigned
   *  and admins get the new-candidates ping instead. */
  createdBy?: { userId: string; name: string; email: string };
  /** Stamped when the SERVER saved this run at the end of a live search (the
   *  2026-08-05 tab-independence fix). Lets the "save" action recognize an old
   *  cached client's follow-up save of the same result and return this run
   *  instead of creating a duplicate list. */
  serverSavedAt?: string;
  /** The name the recruiter saves it under — reused as the Candidates list name. */
  name: string;
  motion: Motion;
  jd: string;
  jdUrl?: string;
  /** City & state of the role, as entered by the recruiter (saved with the list). The
   *  label carries the radius suffix ("Howell, NJ +25mi"). */
  location?: string;
  /**
   * The mileage the recruiter picked, as a NUMBER (0 = "Exact").
   *
   * The label above already encodes it, but a saved list has to be able to re-enforce
   * its own radius long after the search — on a merge, after enrichment, before delivery
   * — and re-deriving the number from prose every time is how a list quietly ends up
   * enforcing a different radius than the one it was run with.
   */
  radiusMi?: number;
  /**
   * True when this list came from a REMOTE search: no center, no radius, the whole US.
   *
   * Persisted because every later pass over a saved list asks it where it was pinned —
   * `enforceRunGeo` before delivery, the same-role auto-combine, a re-run from the
   * overnight queue. Without the flag those would read the empty location as "unpinned"
   * and quietly apply a different rule than the search was run with.
   */
  remote?: boolean;
  icp: CandidateICP;
  queries: SourcingQuery[];
  candidates: CandidateRow[];
  /** Quota'd search-API requests the discovery run spent building this list, by
   *  engine (rapidapi = the paid people-search listing's monthly credits). */
  apiUsage?: { rapidapi?: number; serper?: number; google?: number; dataforseo?: number };
  /**
   * The name this run's OS Text campaign was actually created under. The engine's
   * /api/import get-or-creates a campaign BY EXACT NAME, so a renamed list must
   * keep pushing top-ups under the original name or the rename would fork a
   * second, half-empty campaign. Stamped from the engine's answer on first push;
   * absent on runs that have never been pushed (they use the current name).
   */
  ostextName?: string;
  /** Set once promoted into Candidates, with the created campaign + list ids.
   *  promotedCount = everyone delivered (new + already-in-pipeline), not net-new. */
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
   * When the enrichment chain's FIRST rung was submitted (set once, kept across
   * resumes). Lets the UI show a truthful elapsed/projected time for the chain.
   */
  enrichStartedAt?: string;
  /**
   * Stamped once, when the chain's last chunk completes: the real wall-clock
   * duration of this run's enrichment. Finished runs feed the saved-list ETA
   * (median per-row pace of this workspace's own chains).
   */
  enrichStats?: { finishedAt: string; ms: number; rows: number };
  /**
   * Chunks that were completed WITHOUT their Laxis pass because the worker was down
   * (login wall, UI drift, credentials) when they ran: the in-house waterfall still
   * filled them and their offsets were marked done so the chain never stalls. Pressing
   * Enrich once Laxis is back re-opens exactly these offsets for a real Laxis pass.
   */
  laxisSkipped?: { offsets: number[]; error: string; at: string };
  /**
   * Short cooldown after a fatal Laxis worker failure (login wall etc.): until this
   * time, enrichment skips the Laxis submit for this run (waterfall-only, chunks still
   * marked done) instead of feeding every remaining chunk to a dead login.
   */
  laxisDownUntil?: string;
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
    /**
     * Total candidates on the run at the last send. A later merge (Sales Nav /
     * pasted-search / Combine) can add PEOPLE without adding phones; this stamp
     * lets the top-up rule deliver them to Candidates anyway. Optional: stamps
     * written before 2026-07-21 lack it, and the rule then falls back to the
     * phones-only trigger.
     */
    peopleAtSend?: number;
    /**
     * Order-independent signature of WHO the last send carried (see
     * autoflow.deliverySignature): the people on the list, and which of them held
     * a phone. The two counters above are aggregates, so a merge that swapped
     * members without changing the totals — a combine that deduped K people away
     * and added K different ones — left them both false and the newcomers never
     * shipped. The signature moves whenever the SET moves. Absent on stamps
     * written before 2026-08-07; those ride the counter triggers alone.
     */
    sentSignature?: string;
    attempts: number;
    /** People the outreach quality bar held back at the last send, and the bar it used.
     *  Stamped so the run card can explain a delivered count that is smaller than the
     *  list, instead of leaving the recruiter to wonder where the rest went. */
    belowBarHeld?: number;
    barUsed?: number;
    /** When the sweeper LAST queued a server-side resume for an orphaned chain. The stamp
     *  expires (see autoflow.resumeInHand): a resume that wedges must be retryable, or the
     *  list's card spins "Enriching now" forever with nothing driving it. */
    resumedAt?: string;
    /** How many server-side resumes this chain has been given, so a chain that will never
     *  finish stops asking. Absent on stamps written before 2026-08-06; those count as 1. */
    resumes?: number;
    /** Last failure (kept for ops visibility); cleared on a clean send. */
    error?: string;
    /**
     * When this run FIRST hit an unreachable OS Text engine in the current
     * outage; cleared the moment a send gets through. An engine that is down is
     * an infrastructure fact, not a verdict on this run, so while the outage is
     * young the failed pushes do not spend the run's retry budget (see
     * autoflow.OUTAGE_GRACE_MS). The stamp is what keeps that refund bounded:
     * an engine that has been unreachable for a day is genuinely broken, and
     * from then on the run parks with its reason instead of retrying forever.
     */
    outageSince?: string;
    /**
     * Last time the parity backfill lane acted on this run. The parity lane
     * covers what the fresh-window sweeper won't (lists idle past FRESH_MS,
     * runs parked by MAX_ATTEMPTS) so no phone-bearing list ever stays out of
     * OS Text; this stamp rate-limits it to one attempt per run per day.
     */
    parityAt?: string;
    /**
     * What the OS Text engine said about the last push: how many contacts it
     * actually took (added), how many it left out because a fresh Telnyx check
     * already judged the number not a cell (knownNonMobile), and how many went
     * straight to textable on a prior cell confirmation (confirmedCell). This
     * is why a campaign can hold fewer people than the list has phones.
     */
    lastImport?: { at: string; added: number; knownNonMobile: number; confirmedCell: number };
  };
  /**
   * Verdict from the last pre-push preflight (lib/sourcing/preflight): how many
   * people would actually be textable, what happens to everyone who wouldn't,
   * and any shortfall the engine's answer couldn't account for. Stamped on every
   * push attempt — including a blocked one, which is the point: a push that
   * can't deliver leaves its reason here instead of leaving an empty campaign.
   */
  preflight?: PreflightReport;
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
  /**
   * Rows the worker reports finished so far (DB-lookup rung only — see laxis.jobRowsDone).
   * That rung merges ALL-OR-NOTHING at the end, so without this stamp the run record sits
   * untouched for the whole pass: the saved-list card could only model a clock, and a
   * browser chewing through 500 names looked exactly like a dead job (2026-08-06).
   */
  done?: number;
  /** When `done` last CHANGED — not when it was last polled. This is the honest stall
   *  clock: a job that keeps answering but stops counting is stuck, and submittedAt
   *  can't see that. */
  progressAt?: string;
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
  /** Whose evidence ledger this run reads and writes (lib/sourcing/proofStats). Omitted
   *  means the run still uses proof scoring, it just neither learns from nor benefits
   *  from measured yield, which is the correct behaviour for a workspace-less caller. */
  workspaceId?: string;
  /** Drop rows scoring below this fit threshold (0..100). Default 45. */
  minFit?: number;
  /** Which engines to use, in cheapest-first order. Defaults to whatever is configured.
   *  "koldinfo" is the free contact-database sweep (title + geo over the Business Email
   *  DB via the browser worker) — a candidate SOURCE that arrives with emails/phones. */
  engines?: Array<"koldinfo" | "google" | "searx" | "dataforseo" | "serper" | "rapidapi" | "scraper">;
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
  /**
   * The recruiter's drive-radius pick, in miles (0 / undefined = "Exact", no radius).
   *
   * Paired with `geoCenter`, this is what makes "in area" a MEASURED fact instead of a
   * fuzzy place-name string match. Before this existed the radius was flattened into LLM
   * prose and discarded, so the effective radius was "anywhere sharing a state token".
   */
  radiusMi?: number;
  /** The typed location the radius is measured from ("Fair Lawn, NJ"). */
  geoCenter?: string;
  /**
   * REMOTE ROLE: search the whole country and filter nobody on location.
   *
   * Not the same as leaving `geoCenter` blank. A blank location means "the recruiter did
   * not say", and the run still carries whatever metros the LLM parse invented; this
   * means "there is no location", which switches off the radius, the strict-location
   * drop and the out-of-area split, and switches ON the national query fan-out plus the
   * remote-wording searches (see remoteMode.ts).
   */
  remote?: boolean;
}
