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
export { generateQueries } from "./generateQueries";
export { scoreCandidate } from "./score";
export { runDiscovery, rapidApiSearchConfigured, verifySourcingSearch, type DiscoveryResult } from "./discovery";
export { fetchFullProfile, profileFetchConfigured, type FullProfile, type ProfileExperience } from "./profile";
export { deepVetCandidate, type VetResult } from "./deepVet";
export {
  listSourcingRuns, getSourcingRun, saveSourcingRun, deleteSourcingRun,
  purgeWorkspaceSourcingRuns, type SaveRunInput,
} from "./store";
export { promoteSourcingRun, type PromoteResult, type PromoteOptions } from "./promote";

import { parseJobDescription } from "./parseJobDescription";
import { generateQueries } from "./generateQueries";
import type { CandidateICP, SourcingQuery } from "./types";

export interface SourcingPlan {
  icp: CandidateICP;
  queries: SourcingQuery[];
  /** Honest note when the role is narrow (qualified universe likely < target). */
  note?: string;
}

/** Parse a JD and generate its search set in one call (no discovery yet). */
export async function planSourcing(jd: string): Promise<SourcingPlan> {
  const icp = await parseJobDescription(jd);
  const queries = generateQueries(icp);
  const narrow = icp.seniority === "vp" || icp.seniority === "exec";
  return {
    icp,
    queries,
    note: narrow
      ? "Senior/narrow role: the truly-qualified pool is likely a few hundred, not thousands. Discovery returns everyone above the fit threshold, capped — the count is honest, not padded."
      : undefined,
  };
}
