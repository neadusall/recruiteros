/**
 * RecruiterOS · Hiring Engine
 * Public API barrel — import the job-order → decision-maker pipeline from here.
 *
 *   import {
 *     pullNetNewWithManagers, indeedSource, linkedInPeopleGraph,
 *     resolveHiringManager, companyAnchor,
 *   } from "@/integration/lib/signals/hiring";
 *
 * Layers:
 *   normalize       — the ONE company/role join key every source must use
 *   coverage        — record free coverage, then suppress crossover (Indeed = net-new only)
 *   targetProfile   — role title → "who manages it" target profile
 *   peopleGraph     — provider-agnostic people search (LinkedIn / Apollo / PDL / static)
 *   resolve         — rank candidates into honest confidence tiers
 *   managerWaterfall— the resolver as an enrichment provider/waterfall step
 *   indeed          — Indeed SignalSource driven by an injected proxy/unlocker fetch
 *   pipeline        — the end-to-end run (free → cover → gated → suppress → pair)
 */

// Normalization (shared join key)
export {
  companyAnchor,
  domainRoot,
  companyKeys,
  normalizeTitle,
  normalizeLocation,
  roleKey,
} from "./normalize";

// Coverage + suppression
export {
  memoryCoverageStore,
  recordCoverage,
  suppressCovered,
} from "./coverage";
export type { CoverageStore, RecordOptions, SuppressLevel, SuppressResult } from "./coverage";

// Target-profile inference
export {
  hiringManagerTarget,
  seniorityRank,
  SENIORITY_LADDER,
} from "./targetProfile";
export type { HiringManagerTarget } from "./targetProfile";

// People graph
export {
  linkedInPeopleGraph,
  httpPeopleGraph,
  staticPeopleGraph,
  buildLinkedInSearchUrl,
  splitName,
} from "./peopleGraph";
export type {
  PeopleGraph,
  PeopleQuery,
  PersonCandidate,
  LinkedInGraphDeps,
  LinkedInSearchProfile,
  HttpGraphDeps,
} from "./peopleGraph";

// Resolver
export { resolveHiringManager } from "./resolve";
export type {
  ConfidenceTier,
  RankedManager,
  ResolveOptions,
  HiringManagerResolution,
} from "./resolve";

// Manager-as-waterfall
export { hiringManagerProvider, hiringManagerWaterfall } from "./managerWaterfall";
export type { ManagerProviderOptions } from "./managerWaterfall";

// Indeed connector
export { IndeedSource, indeedSource, defaultParseIndeed } from "./indeed";
export type {
  IndeedSourceOptions,
  IndeedListing,
  UnlockerFetch,
  UnlockerResponse,
} from "./indeed";

// End-to-end pipeline
export { pullNetNewWithManagers } from "./pipeline";
export type { NetNewOptions, NetNewReport, PairedJob } from "./pipeline";
