/**
 * RecruitersOS · Signal Engine
 * Public API barrel.
 *
 * Import from here, not from individual files:
 *
 *   import {
 *     collect, catalog, contactWaterfall, enrich, rankSignals,
 *     type Signal, type ICP, type SignalType,
 *   } from "@/integration/lib/signals";
 *
 * The engine is four cooperating layers:
 *   registry  — the catalog of every hiring signal we detect (the "framework")
 *   sources   — pluggable connectors that emit raw signals (job boards, EDGAR, WARN…)
 *   scoring   — ICP match + 0..100 ranking (Pull → Match → Score)
 *   waterfall — Clay-style enrichment: ordered providers, first/best, with provenance
 *   collector — orchestrates the whole loop end to end and triggers campaigns
 */

// Domain types + taxonomy
export type {
  SignalType,
  SignalCategory,
  SubjectKind,
  Motion,
  Signal,
  SignalStatus,
  SignalDefinition,
  SignalScore,
  ICP,
  Company,
  Person,
  GeoPoint,
  FundingStage,
  SourceKind,
  SourceRef,
  PullResult,
} from "./types";

// Registry (the catalog / framework)
export {
  SIGNAL_DEFINITIONS,
  getDefinition,
  definitionsForMotion,
  definitionsInCategory,
  catalog,
  publicCatalog,
  publicCategories,
} from "./registry";
export type { PublicSignalDefinition } from "./registry";

// Sources (connectors + the contract)
export {
  PublicAtsSource,
  EdgarSource,
  WarnNoticeSource,
  PeopleGraphSource,
  WebhookSource,
  defaultSources,
  configuredSources,
  makeSignal,
  signalIdFrom,
  defaultDedupeKey,
  isoWeekOf,
  getJson,
  SourceError,
} from "./sources";
export type {
  SignalSource,
  PullContext,
  WebhookSignalPayload,
} from "./sources";

// Scoring
export {
  scoreSignal,
  rankSignals,
  disqualify,
  fitScore,
  recencyScore,
  corroborationScore,
  urgencyScore,
  headcountBand,
} from "./scoring";
export type { ScoreContext } from "./scoring";

// Waterfall enrichment
export {
  runWaterfall,
  enrich,
  makeProvider,
  contactWaterfall,
  guessDomainProvider,
  emailPatternProvider,
  memoryCache,
} from "./waterfall";
export type {
  EnrichmentProvider,
  EnrichmentInput,
  ProviderOutcome,
  EnrichedValue,
  WaterfallSpec,
  WaterfallResult,
  EnrichmentPlan,
  EnrichmentReport,
  EnrichmentCache,
  RunOptions,
} from "./waterfall";

// Cheap-first contact enrichment (RapidAPI marketplace + Icypeas, premium as backup)
export {
  rapidEmailFinder,
  rapidPersonEnrich,
  rapidPhoneFinder,
  rapidMobileFinder,
  rapidLandlineFinder,
  icypeasEmailFinder,
  emailVerifier,
  cheapFirstContactWaterfall,
  cheapTier,
} from "./rapidapi";
export { apifyDirectDialFinder } from "./apify";
export {
  makeSkipTracePhoneProvider,
  skipTraceConfigured,
  skipTraceUnitCost,
  skipTraceBilling,
  skipTraceCallsPerLookup,
  extractSkipTracePhone,
  SKIPTRACE_DEFAULT_COST_USD,
} from "./skiptrace";
export { classifyLine, classifyContactNumbers, mapLineType } from "./phoneClassify";
export type { LineType, ClassifyResult, ClassifyOptions } from "./phoneClassify";
export type {
  CheapFirstOptions,
  PersonEnrichment,
  PhoneResult,
} from "./rapidapi";

// Collector (orchestration)
export {
  collect,
  pullAll,
  dedupe,
  rollUpVelocity,
  memoryStores,
  trackedTypesForMotion,
} from "./collector";
export type {
  CollectOptions,
  CollectReport,
  CursorStore,
  SeenStore,
  TriggerHandler,
} from "./collector";

// Free / public signal connectors (the $0 coverage tier)
export {
  ExtraAtsSource,
  RemoteBoardsSource,
  HackerNewsHiringSource,
  UsaSpendingSource,
  GitHubOrgSource,
  NewsRssSource,
  ProductHuntSource,
  LayoffsFeedSource,
  freeSources,
} from "./freeSources";

// Filtering + segmentation (industry / job title / function / seniority / geo)
export {
  classifyTitle,
  titleOf,
  industriesOf,
  matchesFilter,
  applyFilter,
  segmentBy,
} from "./filters";
export type {
  SignalFilter,
  Segment,
  JobFunction,
  Seniority,
  TitleIntel,
} from "./filters";

// Pre-launch campaign builder (organize free signals before spending)
export {
  buildCampaign,
  planLaunch,
} from "./campaignBuilder";
export type {
  CampaignDraft,
  CampaignTarget,
  CostEstimate,
  BuildOptions,
  LaunchPlan,
} from "./campaignBuilder";

// Signal-grounded outreach generation (Bernays rapport ladder)
export {
  draftSequence,
  circumstanceLine,
} from "./messaging";
export type {
  Channel,
  Rung,
  MessageContext,
  DraftedMessage,
  DraftedSequence,
  DraftOptions,
} from "./messaging";

// Campaign flow lifecycle (draft → enrich → draft copy → launch-ready)
export {
  prepareCampaign,
  transition,
  toSendItems,
} from "./campaignFlow";
export type {
  CampaignState,
  PreparedTarget,
  LaunchReadyCampaign,
  FlowDeps,
  SendItem,
} from "./campaignFlow";

// Hiring Engine: pull job orders (Indeed via proxy) → suppress crossover → pair the
// decision-maker by job title. See ./hiring for the full submodule.
export {
  // pipeline
  pullNetNewWithManagers,
  // indeed connector (injected proxy/unlocker)
  indeedSource,
  IndeedSource,
  defaultParseIndeed,
  // suppression / coverage
  memoryCoverageStore,
  recordCoverage,
  suppressCovered,
  // hiring-manager resolution
  resolveHiringManager,
  hiringManagerTarget,
  hiringManagerProvider,
  hiringManagerWaterfall,
  // people graphs
  linkedInPeopleGraph,
  httpPeopleGraph,
  staticPeopleGraph,
  // shared join key
  companyAnchor,
  companyKeys,
  domainRoot,
  roleKey,
} from "./hiring";
export type {
  NetNewOptions,
  NetNewReport,
  PairedJob,
  CoverageStore,
  SuppressLevel,
  SuppressResult,
  HiringManagerTarget,
  HiringManagerResolution,
  RankedManager,
  ConfidenceTier,
  ResolveOptions,
  PeopleGraph,
  PeopleQuery,
  PersonCandidate,
  IndeedSourceOptions,
  IndeedListing,
  UnlockerFetch,
  UnlockerResponse,
  ManagerProviderOptions,
} from "./hiring";
