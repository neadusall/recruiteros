/**
 * RecruitersOS · JD Sourcing — barrel.
 *
 * The flow: parseJobDescription (JD→ICP) → generateQueries (ICP→searches) →
 * runDiscovery (searches→ranked candidates) → saveSourcingRun (stage under a name) →
 * promoteSourcingRun (push to Candidates under that name).
 */

export * from "./types";
export { parseJobDescription, normalizeIcpObject } from "./parseJobDescription";
export { refineIcp, type RefineResult } from "./refineSearch";
export { draftJobDescription, type DraftInput } from "./draftJd";
export { generateQueries, geoVariants } from "./generateQueries";
export { scoreCandidate } from "./score";
export {
  runDiscovery, rapidApiSearchConfigured, verifySourcingSearch,
  googleSearchConfigured, verifyGoogleSearch, searxSearchConfigured,
  serperSearchConfigured, verifySerperSearch,
  dataforseoSearchConfigured, verifyDataForSeoSearch, dataforseoAccountBalance,
  candidateKey, locationFromSnippet, type DiscoveryResult,
} from "./discovery";
export {
  buildProofPlan, isSearchableEvidence, type ProofPlan,
} from "./proofPlan";
export { extractProofTerms, roleSignature, normalizeExtracted } from "./proofExtract";
export {
  recordTermYield, termStatsFor, applyTermStats, isUnbiasedRow,
  type TermStat, type RankedTerms,
} from "./proofStats";
export {
  detectVerticals, termsForVerticals, matchProofTerms, proofScore, proofQueryGroups,
  PROOF_LIBRARY, VERTICAL_LABEL, type ProofTerm, type ProofVertical, type ProofHit,
} from "./proofTerms";
export {
  startBulkList, stepBulkList, bulkListStatus,
  DECISION_MAKER_TITLES, US_GEOS, HEADCOUNT_BANDS,
  type BulkListJob, type StartBulkOptions, type StepResult,
} from "./bulkList";
export {
  startCompanyFirst, stepCompanyFirst, companyFirstStatus, companyFirstConfigured,
  companyFromTitle,
  type CompanyFirstJob, type StartCompanyFirstOptions, type CompanyFirstStepResult,
} from "./companyFirst";
export { reRankCandidates, type ReRankResult } from "./rerank";
export { getSeenKeys, addSeenKeys } from "./seen";
export { fetchFullProfile, profileFetchConfigured, type FullProfile, type ProfileExperience } from "./profile";
export {
  fetchFullProfileCached, getCachedProfile, putCachedProfile,
  getCachedContact, putCachedContact,
  type CachedProfile, type CachedContact,
} from "./cache";
export { cacheKey, scopedKey, isFresh } from "./cacheKeys";
export {
  deepVetCandidate, type VetResult,
  vetBatchAvailable, submitVetBatch, retrieveVetBatch, collectVetBatch,
  type VetBatchItem, type VetBatchProgress, type VetBatchCollection, type VetBatchStatus,
} from "./deepVet";
export {
  listSourcingRuns, getSourcingRun, saveSourcingRun, deleteSourcingRun,
  renameSourcingRun, purgeWorkspaceSourcingRuns, type SaveRunInput,
} from "./store";
export { renameSourcingList, MAX_RUN_NAME, type RenameRunResult } from "./rename";
export {
  laxisWorkerConfigured, koldinfoWorkerReady, serializeCandidatesCsv, parseCsv,
  submitLaxisJob, getLaxisJob, mergeEnrichedCsv, laxisCandKey, jobRowsDone,
  LAXIS_CSV_COLUMNS, MAX_LAXIS_UPLOAD, type LaxisJobStatus, type LaxisMergeResult,
} from "./laxis";
export { promoteSourcingRun, type PromoteResult, type PromoteOptions } from "./promote";
export { mergeSourcingRuns, type MergedRuns } from "./mergeRuns";
export { runSalesNavSourcing, parseSalesNavUrl, searchKindOf, type SalesNavRunResult, type SalesNavRunOptions } from "./salesNav";
export { applySalesNavResult, type SalesNavApplied, type SalesNavApplyOptions } from "./salesNavApply";
export {
  buildSourcingKoldInfoCsv, mergeSourcingKoldInfoCsv, sourcingKoldId,
  buildKoldInfoDbCsv, splitLocation,
  type SourcingKoldMerge,
} from "./koldinfo";
export {
  buildDbDiscoverySpecCsv, parseDbDiscoveryCsv, geoChips,
  submitDbDiscovery, collectDbDiscovery,
} from "./koldinfoDiscovery";
export { getRapidQuota, noteRapidQuota, type RapidQuotaSnapshot } from "./rapidQuota";
export { gapFillContacts, type GapFillResult } from "./gapfill";
export {
  premiumPhoneQuote, runPremiumPhoneBoost, getPremiumPhoneStats, boostableRows,
  boostBudget, boostMonthlyCapUsd,
  type PremiumPhoneQuote, type PremiumPhoneBatchResult, type PremiumPhoneStats,
} from "./premiumPhone";
export { landlineDbReady, fillPhonesFromLandlineDb } from "./landlinePhones";
export {
  listNightItems, addNightItem, removeNightItem, failNightItem, attachNightIcp, tickNightQueue, searchesInFlight,
  type NightItem, type NightStage, type NightAddInput,
} from "./nightQueue";

import { parseJobDescription } from "./parseJobDescription";
import { generateQueries } from "./generateQueries";
import { buildProofPlan } from "./proofPlan";
import type { CandidateICP, SearchBreadth, SourcingQuery } from "./types";

export interface SourcingPlan {
  icp: CandidateICP;
  queries: SourcingQuery[];
  /** Honest note when the role is narrow (qualified universe likely < target). */
  note?: string;
  /** The long-tail evidence this role is being qualified on: which vertical vocabulary
   *  applied, and which terms the JD itself contributed. Rides with the plan so a run
   *  scores on the same evidence its queries searched for. */
  proof?: { verticals: string[]; terms: number; fromJd: string[] };
}

export { pinIcpLocation } from "./pinLocation";
import { pinIcpLocation } from "./pinLocation";
export {
  geocodeUsPlace, haversineMi, withinRadius, distanceFromCenter, citiesWithinRadius,
  statesWithinRadius, radiusBudgetMi, parseRadiusMi, stripRadiusSuffix, formatPlace,
  MAX_RADIUS_MI, EXACT_RADIUS_MI, enforcedRadiusMi,
} from "./geoRadius";
export { enforceGeo, enforceRunGeo } from "./geoEnforce";
export type { GeoEnforceResult, RunGeo } from "./geoEnforce";
export {
  applyRemoteIcp, isRemoteRun, locationSaysRemote, rowSaysRemote, nationalGeoTargets,
  NATIONAL_METROS, REMOTE_PHRASES, REMOTE_LABEL,
} from "./remoteMode";
import { parseRadiusMi } from "./geoRadius";
import { applyRemoteIcp } from "./remoteMode";

/** Parse a JD and generate its search set in one call (no discovery yet). */
export async function planSourcing(
  jd: string,
  location?: string,
  breadth?: SearchBreadth,
  radiusMi?: number,
  /** Remote role: no center, no radius, national fan-out. Overrides `location`. */
  remote?: boolean,
): Promise<SourcingPlan> {
  const miles = remote ? 0 : parseRadiusMi(radiusMi, location);
  const parsed = await parseJobDescription(jd);
  // Exactly one of the two geography shapers runs: the pin for a typed location, or the
  // clear-out for a remote role. Running neither is what leaves the LLM's invented metro
  // list in place, which is the bug this mode exists to close.
  const icp = remote ? applyRemoteIcp(parsed) : pinIcpLocation(parsed, location, miles);
  // PRECISION PASS: work out what counts as proof for this role before building the
  // queries, so the search set includes booleans that carry the evidence terms. The
  // plan is rebuilt (cheaply, no model call) at run time from the same ICP, so a run
  // always scores on exactly the evidence it searched for.
  const proof = buildProofPlan(icp, jd);
  const queries = generateQueries(icp, { breadth, radiusMi: miles, remote, proofGroups: proof.queryGroups });
  // Empty across the load-bearing fields means the profile couldn't be built from the
  // brief (e.g. the model returned unparseable output). Say so plainly rather than
  // silently handing back a profile of dashes that finds nobody.
  const empty = !icp.titles.length && !icp.targetCompanies.length && !icp.geos.length;
  return {
    icp,
    queries,
    // Only the parse-failure note survives here; the old "senior/narrow role" caveat
    // read as clutter under the plan card and was cut on user request (2026-07-16).
    note: empty
      ? "Couldn't read the brief into a profile. Click Analyze again, or add a few concrete details to the brief: a clear job title, real example companies, and a location."
      : undefined,
    proof: { verticals: proof.verticals, terms: proof.terms.length, fromJd: proof.fromJd },
  };
}
