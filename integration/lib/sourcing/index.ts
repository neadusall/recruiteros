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
  candidateKey, locationFromSnippet, type DiscoveryResult,
} from "./discovery";
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
  purgeWorkspaceSourcingRuns, type SaveRunInput,
} from "./store";
export {
  laxisWorkerConfigured, koldinfoWorkerReady, serializeCandidatesCsv, parseCsv,
  submitLaxisJob, getLaxisJob, mergeEnrichedCsv, laxisCandKey,
  LAXIS_CSV_COLUMNS, MAX_LAXIS_UPLOAD, type LaxisJobStatus, type LaxisMergeResult,
} from "./laxis";
export { promoteSourcingRun, type PromoteResult, type PromoteOptions } from "./promote";
export { mergeSourcingRuns, type MergedRuns } from "./mergeRuns";
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
  listNightItems, addNightItem, removeNightItem, tickNightQueue,
  type NightItem, type NightStage, type NightAddInput,
} from "./nightQueue";

import { parseJobDescription } from "./parseJobDescription";
import { generateQueries } from "./generateQueries";
import type { CandidateICP, SearchBreadth, SourcingQuery } from "./types";

export interface SourcingPlan {
  icp: CandidateICP;
  queries: SourcingQuery[];
  /** Honest note when the role is narrow (qualified universe likely < target). */
  note?: string;
}

export { pinIcpLocation } from "./pinLocation";
import { pinIcpLocation } from "./pinLocation";

/** Parse a JD and generate its search set in one call (no discovery yet). */
export async function planSourcing(jd: string, location?: string, breadth?: SearchBreadth): Promise<SourcingPlan> {
  const icp = pinIcpLocation(await parseJobDescription(jd), location);
  const queries = generateQueries(icp, { breadth });
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
  };
}
