/**
 * RecruitersOS · Signal Engine
 * Filtering + segmentation — narrow the signal stream to exactly who you want to target.
 *
 * Scoring (./scoring) ranks signals; filtering DECIDES which ones belong in a campaign at
 * all. This is the layer the product's "filter based upon industry, job title" requirement
 * lives in: a declarative `SignalFilter` that the UI and API both build, applied entirely
 * over already-collected free signals so a recruiter can shape a target list before
 * spending anything on enrichment.
 *
 * It also derives the job-title intelligence the rest of the engine needs: normalize a
 * raw title into a function + seniority so "VP of Eng", "Head of Engineering", and
 * "Engineering Director" all match a single "engineering leadership" filter.
 */

import type { Signal, Motion, FundingStage } from "./types";

/* ------------------------------------------------------------------ */
/* Job-title intelligence                                              */
/* ------------------------------------------------------------------ */

export type JobFunction =
  | "engineering" | "product" | "design" | "data" | "sales" | "marketing"
  | "finance" | "operations" | "people_hr" | "customer_success" | "legal"
  | "executive" | "other";

export type Seniority =
  | "intern" | "junior" | "mid" | "senior" | "lead" | "manager"
  | "director" | "vp" | "c_level" | "founder";

/** Keyword → function map. First match wins; ordered most-specific first. */
const FUNCTION_KEYWORDS: Array<[JobFunction, RegExp]> = [
  ["data", /\b(data scientist|data engineer|machine learning|ml |ai |analytics|data analyst)\b/i],
  ["engineering", /\b(engineer|developer|swe|programmer|devops|sre|architect|backend|frontend|full ?stack)\b/i],
  ["product", /\b(product manager|product owner|head of product|cpo|product lead)\b/i],
  ["design", /\b(designer|ux|ui|product design|creative)\b/i],
  ["sales", /\b(sales|account executive|ae\b|sdr|bdr|business development|revenue)\b/i],
  ["marketing", /\b(marketing|growth|demand gen|content|seo|brand|comms)\b/i],
  ["finance", /\b(finance|accounting|controller|fp&a|cfo|treasur)\b/i],
  ["people_hr", /\b(recruit|talent|people ops|hr\b|human resources|chro)\b/i],
  ["customer_success", /\b(customer success|csm|support|account manager)\b/i],
  ["legal", /\b(legal|counsel|compliance|gc\b)\b/i],
  ["operations", /\b(operations|ops\b|program manager|project manager|coo)\b/i],
  ["executive", /\b(ceo|cto|cfo|coo|cmo|cpo|chief|founder|president)\b/i],
];

const SENIORITY_KEYWORDS: Array<[Seniority, RegExp]> = [
  ["founder", /\b(founder|co-?founder)\b/i],
  ["c_level", /\b(chief|ceo|cto|cfo|coo|cmo|cpo|cro|cio)\b/i],
  ["vp", /\b(vp|vice president|svp|evp)\b/i],
  ["director", /\b(director|head of)\b/i],
  ["manager", /\b(manager|mgr)\b/i],
  ["lead", /\b(lead|principal|staff)\b/i],
  ["senior", /\b(senior|sr\.?)\b/i],
  ["junior", /\b(junior|jr\.?|associate|entry)\b/i],
  ["intern", /\b(intern|internship|trainee)\b/i],
];

export interface TitleIntel {
  raw: string;
  function: JobFunction;
  seniority: Seniority;
  /** True when the title is a hiring decision-maker (manager and up). */
  isDecisionMaker: boolean;
}

/** Parse a raw job title into function + seniority. */
export function classifyTitle(raw: string): TitleIntel {
  const fn = FUNCTION_KEYWORDS.find(([, re]) => re.test(raw))?.[0] ?? "other";
  const sen = SENIORITY_KEYWORDS.find(([, re]) => re.test(raw))?.[0] ?? "mid";
  const decisionRanks: Seniority[] = ["manager", "director", "vp", "c_level", "founder"];
  return { raw, function: fn, seniority: sen, isDecisionMaker: decisionRanks.includes(sen) };
}

/** Pull the most relevant title text out of a signal (role posted, or the person). */
export function titleOf(signal: Signal): string | undefined {
  return (
    (signal.evidence.roleTitle as string | undefined) ??
    signal.person?.title ??
    signal.person?.headline ??
    (signal.evidence.title as string | undefined)
  );
}

/* ------------------------------------------------------------------ */
/* Industry inference (free, keyword-based)                            */
/* ------------------------------------------------------------------ */

/** Coarse industry tags inferred from text when a firmographic source isn't available. */
const INDUSTRY_KEYWORDS: Array<[string, RegExp]> = [
  ["healthcare", /\b(health|medical|clinical|patient|biotech|pharma|hospital)\b/i],
  ["fintech", /\b(fintech|payments|banking|lending|trading|crypto|insurance|insurtech)\b/i],
  ["saas", /\b(saas|b2b software|platform|api|developer tools|cloud)\b/i],
  ["ecommerce", /\b(ecommerce|e-commerce|retail|marketplace|d2c|consumer goods)\b/i],
  ["ai_ml", /\b(\bai\b|artificial intelligence|machine learning|llm|generative)\b/i],
  ["cybersecurity", /\b(security|cyber|infosec|threat|identity)\b/i],
  ["edtech", /\b(edtech|education|learning|tutoring|university)\b/i],
  ["logistics", /\b(logistics|supply chain|freight|delivery|fleet)\b/i],
  ["gaming", /\b(gaming|games|esports)\b/i],
  ["climate", /\b(climate|clean ?tech|energy|solar|sustainab|carbon)\b/i],
];

/** Best-effort industry tags for a signal from its company + text. */
export function industriesOf(signal: Signal): string[] {
  if (signal.company?.industry) return [signal.company.industry.toLowerCase()];
  const hay = `${signal.title} ${signal.detail} ${signal.company?.name ?? ""}`;
  return INDUSTRY_KEYWORDS.filter(([, re]) => re.test(hay)).map(([tag]) => tag);
}

/* ------------------------------------------------------------------ */
/* The filter                                                          */
/* ------------------------------------------------------------------ */

/**
 * A declarative filter the UI/API builds. Every field is optional; a signal must pass
 * ALL specified fields (AND semantics) to survive. Built to run over free signals so the
 * target list is shaped before any paid enrichment.
 */
export interface SignalFilter {
  motion?: Motion;
  /** Keep only these signal types. */
  signalTypes?: Signal["type"][];

  /** Industry tags (any-of). Matched against inferred + firmographic industry. */
  industries?: string[];
  /** Job functions (any-of), derived from the role/person title. */
  functions?: JobFunction[];
  /** Free-text title contains (any-of), case-insensitive. e.g. ["VP", "Head of"]. */
  titleIncludes?: string[];
  /** Minimum seniority to keep (decision-maker targeting). */
  minSeniority?: Seniority;
  /** Only keep signals whose title is a hiring decision-maker. */
  decisionMakersOnly?: boolean;

  /** ISO alpha-2 countries or free-text locations (any-of). */
  locations?: string[];
  remoteOk?: boolean;

  headcountBands?: Signal["company"] extends infer C ? (C extends { headcountBand?: infer B } ? B[] : never) : never;
  stages?: FundingStage[];

  /** Title/detail must contain at least one of these. */
  keywordsAny?: string[];
  /** Drop if title/detail contains any of these. */
  keywordsNone?: string[];

  /** Minimum score (when signals are already scored). */
  minScore?: number;
}

const SENIORITY_ORDER: Seniority[] = [
  "intern", "junior", "mid", "senior", "lead", "manager", "director", "vp", "c_level", "founder",
];

/** Does one signal pass one filter? */
export function matchesFilter(signal: Signal, f: SignalFilter): boolean {
  if (f.motion && signal.motion !== f.motion) return false;
  if (f.signalTypes?.length && !f.signalTypes.includes(signal.type)) return false;
  if (typeof f.minScore === "number" && (signal.score?.value ?? 0) < f.minScore) return false;

  const hay = `${signal.title} ${signal.detail}`.toLowerCase();
  if (f.keywordsAny?.length && !f.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return false;
  if (f.keywordsNone?.length && f.keywordsNone.some((k) => hay.includes(k.toLowerCase()))) return false;

  if (f.industries?.length) {
    const inds = industriesOf(signal);
    if (!f.industries.some((want) => inds.includes(want.toLowerCase()))) return false;
  }

  const title = titleOf(signal);
  if (f.functions?.length || f.minSeniority || f.decisionMakersOnly || f.titleIncludes?.length) {
    if (!title) return false;
    const intel = classifyTitle(title);
    if (f.functions?.length && !f.functions.includes(intel.function)) return false;
    if (f.titleIncludes?.length && !f.titleIncludes.some((t) => title.toLowerCase().includes(t.toLowerCase()))) return false;
    if (f.decisionMakersOnly && !intel.isDecisionMaker) return false;
    if (f.minSeniority) {
      const need = SENIORITY_ORDER.indexOf(f.minSeniority);
      const have = SENIORITY_ORDER.indexOf(intel.seniority);
      if (have < need) return false;
    }
  }

  if (f.locations?.length || f.remoteOk) {
    const loc = `${signal.evidence.location ?? ""} ${signal.company?.hqLocation?.raw ?? ""} ${signal.person?.location?.raw ?? ""}`.toLowerCase();
    const isRemote = /remote/.test(loc) || signal.evidence.remote === true || signal.company?.hqLocation?.remote === true;
    const geoHit = f.locations?.some((l) => loc.includes(l.toLowerCase())) ?? false;
    if (!(geoHit || (f.remoteOk && isRemote))) return false;
  }

  if (f.headcountBands && (f.headcountBands as string[]).length) {
    const band = signal.company?.headcountBand;
    if (!band || !(f.headcountBands as string[]).includes(band)) return false;
  }
  if (f.stages?.length) {
    const stage = signal.company?.stage ?? (signal.evidence.stage as FundingStage | undefined);
    if (!stage || !f.stages.includes(stage)) return false;
  }

  return true;
}

/** Apply a filter to a batch, preserving order. */
export function applyFilter(signals: Signal[], f: SignalFilter): Signal[] {
  return signals.filter((s) => matchesFilter(s, f));
}

/* ------------------------------------------------------------------ */
/* Segmentation                                                        */
/* ------------------------------------------------------------------ */

export interface Segment {
  key: string;
  label: string;
  signals: Signal[];
}

/** Group signals into segments by a dimension, for the pre-launch review UI. */
export function segmentBy(
  signals: Signal[],
  dim: "function" | "industry" | "signalType" | "seniority" | "company",
): Segment[] {
  const buckets = new Map<string, Signal[]>();
  const add = (key: string, s: Signal) => {
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(s);
  };

  for (const s of signals) {
    if (dim === "signalType") add(s.type, s);
    else if (dim === "company") add((s.company?.name ?? "unknown").toLowerCase(), s);
    else if (dim === "industry") (industriesOf(s).length ? industriesOf(s) : ["unknown"]).forEach((i) => add(i, s));
    else {
      const t = titleOf(s);
      if (!t) { add("unknown", s); continue; }
      const intel = classifyTitle(t);
      add(dim === "function" ? intel.function : intel.seniority, s);
    }
  }

  return [...buckets.entries()]
    .map(([key, sigs]) => ({ key, label: prettyKey(key), signals: sigs }))
    .sort((a, b) => b.signals.length - a.signals.length);
}

function prettyKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
