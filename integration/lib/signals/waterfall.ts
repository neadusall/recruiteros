/**
 * RecruiterOS · Signal Engine
 * Waterfall data collection.
 *
 * A "waterfall" runs a list of providers for one piece of data in priority order and
 * stops at the first acceptable result — the Clay-style enrichment pattern. You try the
 * cheapest / most-trusted provider first, fall through to the next on a miss, and quit
 * the moment you have a confident answer. This buys maximal coverage at minimal cost
 * and never pays a premium provider for data a free one already had.
 *
 * This module is the generic engine. It is field-agnostic: the same machinery resolves
 * a company's domain, a person's work email, a verified phone, the hiring manager for a
 * role, headcount, or tech stack. Each enrichment is just a `WaterfallSpec` — an ordered
 * list of `EnrichmentProvider`s plus an acceptance rule.
 *
 * Design goals carried over from the LinkedIn Engine:
 *   - Provider abstraction: the runner never knows a vendor's name.
 *   - Provenance on every value: which provider, what confidence, what cost.
 *   - Deterministic + cache-friendly: no Date.now / Math.random in the hot path;
 *     callers pass `now` and a cache so reruns are cheap and idempotent.
 */

/* ------------------------------------------------------------------ */
/* Core value + provenance types                                       */
/* ------------------------------------------------------------------ */

/** A single resolved value with full provenance — the unit a waterfall produces. */
export interface EnrichedValue<T> {
  field: string;
  value: T;
  /** 0..1 confidence the provider assigned (e.g. email validation strength). */
  confidence: number;
  /** Id of the provider that produced it. */
  providerId: string;
  /** Relative cost units spent to get it (credits, cents — caller-defined). */
  cost: number;
  /** ISO time the value was obtained. */
  at: string;
  /** Optional raw payload for debugging / re-parsing. */
  raw?: unknown;
}

/** What a provider returns for one lookup: a hit, a miss, or a transient error. */
export type ProviderOutcome<T> =
  | { status: "hit"; value: T; confidence: number; cost?: number; raw?: unknown }
  | { status: "miss"; cost?: number }
  | { status: "error"; error: string; cost?: number };

/* ------------------------------------------------------------------ */
/* Provider contract                                                   */
/* ------------------------------------------------------------------ */

/** Input every provider receives: the subject so far, plus prior waterfall results. */
export interface EnrichmentInput {
  /** Everything known about the entity, accreted as the waterfall progresses. */
  subject: Record<string, unknown>;
  /** Field being resolved (lets a multi-field provider branch). */
  field: string;
  /** Values already resolved by earlier steps in this run, keyed by field. */
  resolved: Record<string, EnrichedValue<unknown>>;
}

/**
 * One step in a waterfall. Implementations call a single vendor (or local heuristic)
 * and return a normalized outcome. They must be side-effect-free beyond the network
 * call so the runner can retry / cache safely.
 */
export interface EnrichmentProvider<T = unknown> {
  readonly id: string;
  readonly label: string;
  /** Relative cost class, for budgeting and ordering. 0 = free/local. */
  readonly cost: number;
  /** Typical confidence ceiling, used for ordering when costs tie. */
  readonly typicalConfidence: number;
  /** True when credentials/config are present. */
  isConfigured(): boolean;
  /** Resolve the field, or report a miss/error. */
  lookup(input: EnrichmentInput): Promise<ProviderOutcome<T>>;
}

/* ------------------------------------------------------------------ */
/* Waterfall specification                                             */
/* ------------------------------------------------------------------ */

export interface WaterfallSpec<T = unknown> {
  /** Field this waterfall resolves, e.g. "email", "domain", "hiringManager". */
  field: string;
  /** Providers in the order they should be tried. */
  providers: EnrichmentProvider<T>[];
  /**
   * Stop as soon as a result reaches this confidence (default 0.9). A hit below it is
   * kept as the running best, and the waterfall keeps falling through to try to beat it.
   */
  acceptConfidence?: number;
  /** Hard ceiling on total cost across providers for this field. */
  maxCost?: number;
  /**
   * "first" — stop at the first acceptable hit (cheapest coverage; the default).
   * "best" — run all configured providers and keep the highest-confidence value.
   */
  mode?: "first" | "best";
}

/** Outcome of running one waterfall. */
export interface WaterfallResult<T = unknown> {
  field: string;
  /** The chosen value, or null if every provider missed. */
  value: EnrichedValue<T> | null;
  /** Per-provider trace for observability (shown in the enrichment UI / logs). */
  attempts: Array<{
    providerId: string;
    status: ProviderOutcome<T>["status"];
    confidence?: number;
    cost: number;
    error?: string;
  }>;
  /** Total cost actually spent. */
  totalCost: number;
}

/* ------------------------------------------------------------------ */
/* Cache (pluggable; in-memory default)                                */
/* ------------------------------------------------------------------ */

export interface EnrichmentCache {
  get(key: string): Promise<EnrichedValue<unknown> | undefined>;
  set(key: string, value: EnrichedValue<unknown>): Promise<void>;
}

const memCache = new Map<string, EnrichedValue<unknown>>();
export const memoryCache: EnrichmentCache = {
  async get(key) {
    return memCache.get(key);
  },
  async set(key, value) {
    memCache.set(key, value);
  },
};

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** ISO timestamp stamped onto produced values (keeps the runner deterministic). */
  now: string;
  /** Cache for resolved values; defaults to an in-memory map. */
  cache?: EnrichmentCache;
  /** Stable key for the entity (e.g. company domain or person id) for caching. */
  cacheKey?: string;
}

/**
 * Run a single waterfall. Tries providers in order, short-circuits per the spec's mode
 * and accept-confidence, respects the cost ceiling, and records a full attempt trace.
 */
export async function runWaterfall<T>(
  spec: WaterfallSpec<T>,
  subject: Record<string, unknown>,
  resolved: Record<string, EnrichedValue<unknown>>,
  opts: RunOptions,
): Promise<WaterfallResult<T>> {
  const accept = spec.acceptConfidence ?? 0.9;
  const mode = spec.mode ?? "first";
  const cache = opts.cache ?? memoryCache;
  const cacheKey = opts.cacheKey ? `${opts.cacheKey}:${spec.field}` : undefined;

  // Cache short-circuit: a confident cached value skips the whole waterfall.
  if (cacheKey) {
    const cached = (await cache.get(cacheKey)) as EnrichedValue<T> | undefined;
    if (cached && cached.confidence >= accept) {
      return {
        field: spec.field,
        value: cached,
        attempts: [{ providerId: "cache", status: "hit", confidence: cached.confidence, cost: 0 }],
        totalCost: 0,
      };
    }
  }

  const attempts: WaterfallResult<T>["attempts"] = [];
  let best: EnrichedValue<T> | null = null;
  let totalCost = 0;

  for (const provider of spec.providers) {
    if (!provider.isConfigured()) {
      attempts.push({ providerId: provider.id, status: "miss", cost: 0, error: "not configured" });
      continue;
    }
    if (typeof spec.maxCost === "number" && totalCost + provider.cost > spec.maxCost) {
      attempts.push({ providerId: provider.id, status: "miss", cost: 0, error: "cost ceiling reached" });
      break;
    }

    let outcome: ProviderOutcome<T>;
    try {
      outcome = await provider.lookup({ subject, field: spec.field, resolved });
    } catch (err) {
      outcome = { status: "error", error: (err as Error).message };
    }

    const spent = outcome.cost ?? (outcome.status === "hit" ? provider.cost : 0);
    totalCost += spent;
    attempts.push({
      providerId: provider.id,
      status: outcome.status,
      confidence: outcome.status === "hit" ? outcome.confidence : undefined,
      cost: spent,
      error: outcome.status === "error" ? outcome.error : undefined,
    });

    if (outcome.status !== "hit") continue;

    const candidate: EnrichedValue<T> = {
      field: spec.field,
      value: outcome.value,
      confidence: outcome.confidence,
      providerId: provider.id,
      cost: spent,
      at: opts.now,
      raw: outcome.raw,
    };
    if (!best || candidate.confidence > best.confidence) best = candidate;

    // Short-circuit: confident enough, or first-mode with any hit that we accept.
    if (best.confidence >= accept) break;
    if (mode === "first") break;
  }

  if (best && cacheKey) await cache.set(cacheKey, best as EnrichedValue<unknown>);
  return { field: spec.field, value: best, attempts, totalCost };
}

/* ------------------------------------------------------------------ */
/* Pipeline: run several waterfalls in dependency order                */
/* ------------------------------------------------------------------ */

/**
 * A full enrichment pipeline is several waterfalls run in sequence, where later fields
 * can use earlier results (resolve domain → then email → then verified phone). Each
 * field's resolved value is accreted into the shared `resolved` map and merged back
 * into `subject`, so downstream providers see everything found so far.
 *
 * This is the "structuring the waterfall data collection" layer the product flow needs:
 * a recruiter (or a triggered campaign) declares the fields they want, and the engine
 * walks them in order, cheapest-first, recording exactly where every value came from.
 */
export interface EnrichmentPlan {
  /** Ordered waterfalls. Order matters: earlier fields feed later ones. */
  steps: WaterfallSpec[];
  /** Global cost ceiling across all steps; stop enriching once hit. */
  budget?: number;
}

export interface EnrichmentReport {
  /** Final accreted subject (original fields + every resolved value, flattened). */
  subject: Record<string, unknown>;
  /** Resolved values by field, with full provenance. */
  resolved: Record<string, EnrichedValue<unknown>>;
  /** Per-field waterfall results, in execution order. */
  results: WaterfallResult[];
  totalCost: number;
  /** True if the budget ceiling stopped the pipeline early. */
  budgetExhausted: boolean;
}

/** Execute an enrichment plan against a starting subject. */
export async function enrich(
  plan: EnrichmentPlan,
  subject: Record<string, unknown>,
  opts: RunOptions,
): Promise<EnrichmentReport> {
  const resolved: Record<string, EnrichedValue<unknown>> = {};
  const results: WaterfallResult[] = [];
  const working = { ...subject };
  let totalCost = 0;
  let budgetExhausted = false;

  for (const spec of plan.steps) {
    if (typeof plan.budget === "number" && totalCost >= plan.budget) {
      budgetExhausted = true;
      break;
    }
    // Pass remaining budget down as the per-field ceiling when a global budget is set.
    const remaining =
      typeof plan.budget === "number" ? plan.budget - totalCost : spec.maxCost;
    const result = await runWaterfall(
      { ...spec, maxCost: remaining ?? spec.maxCost },
      working,
      resolved,
      opts,
    );
    results.push(result);
    totalCost += result.totalCost;
    if (result.value) {
      resolved[spec.field] = result.value;
      working[spec.field] = result.value.value; // accrete for downstream steps
    }
  }

  return { subject: working, resolved, results, totalCost, budgetExhausted };
}

/* ------------------------------------------------------------------ */
/* Local (free) providers — the top of every waterfall                 */
/* ------------------------------------------------------------------ */

/**
 * Derive a company domain from its name with a couple of cheap heuristics, before
 * spending a credit on a paid firmographics provider. Confidence is deliberately
 * modest so a verified provider downstream can still win in "best" mode.
 */
export const guessDomainProvider: EnrichmentProvider<string> = {
  id: "domain_heuristic",
  label: "Domain heuristic (local)",
  cost: 0,
  typicalConfidence: 0.45,
  isConfigured: () => true,
  async lookup({ subject }) {
    const name = String(subject.name ?? subject.companyName ?? "").trim();
    if (!name) return { status: "miss" };
    const slug = name.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|corp|co)\b/g, "").replace(/[^a-z0-9]/g, "");
    if (!slug) return { status: "miss" };
    return { status: "hit", value: `${slug}.com`, confidence: 0.45, cost: 0 };
  },
};

/**
 * Construct likely work-email permutations from a person's name + company domain.
 * Free, but unverified — confidence is low so an email-verification provider supersedes
 * it. Returns the single most common pattern (first.last@domain); the full permutation
 * set is exposed via `raw` for a verifier to test.
 */
export const emailPatternProvider: EnrichmentProvider<string> = {
  id: "email_pattern",
  label: "Email permutation (local)",
  cost: 0,
  typicalConfidence: 0.35,
  isConfigured: () => true,
  async lookup({ subject, resolved }) {
    const first = String(subject.firstName ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const lastRaw = String(subject.lastName ?? subject.fullName ?? "").toLowerCase();
    const last = lastRaw.split(/\s+/).pop()?.replace(/[^a-z]/g, "") ?? "";
    const domain =
      (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "");
    if (!first || !last || !domain) return { status: "miss" };
    const permutations = [
      `${first}.${last}@${domain}`,
      `${first}@${domain}`,
      `${first[0]}${last}@${domain}`,
      `${first}${last}@${domain}`,
      `${last}.${first}@${domain}`,
    ];
    return {
      status: "hit",
      value: permutations[0],
      confidence: 0.35,
      cost: 0,
      raw: { permutations },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Adapter helper: wrap any async vendor call as a provider            */
/* ------------------------------------------------------------------ */

/**
 * Turn a plain async function into an `EnrichmentProvider`. Most paid vendors only need
 * this thin wrapper — point `fn` at your `fetch` call and map the response. Keeps each
 * connector to a few lines, exactly like the LinkedIn `attempt()` wrapper.
 */
export function makeProvider<T>(config: {
  id: string;
  label: string;
  cost: number;
  typicalConfidence: number;
  envKeys?: string[];
  fn: (input: EnrichmentInput) => Promise<ProviderOutcome<T>>;
}): EnrichmentProvider<T> {
  return {
    id: config.id,
    label: config.label,
    cost: config.cost,
    typicalConfidence: config.typicalConfidence,
    isConfigured: () =>
      (config.envKeys ?? []).every((k) => Boolean(process.env[k])),
    lookup: config.fn,
  };
}

/* ------------------------------------------------------------------ */
/* Prebuilt waterfalls for the most common recruiting fields           */
/* ------------------------------------------------------------------ */

/**
 * Domain → Email is the canonical recruiting waterfall: figure out the company domain,
 * then resolve a verified work email. Local heuristics lead; callers append their paid
 * providers (Clearbit, Hunter, Apollo, Prospeo, ContactOut…) via `makeProvider`.
 *
 * Example:
 *   const plan = contactWaterfall([clearbitDomain], [hunterEmail, apolloEmail]);
 *   await enrich(plan, { companyName, firstName, lastName }, { now });
 */
export function contactWaterfall(
  domainProviders: EnrichmentProvider<string>[] = [],
  emailProviders: EnrichmentProvider<string>[] = [],
  phoneProviders: EnrichmentProvider<string>[] = [],
): EnrichmentPlan {
  const steps: WaterfallSpec[] = [
    {
      field: "domain",
      providers: [guessDomainProvider, ...domainProviders] as EnrichmentProvider[],
      mode: "best",
      acceptConfidence: 0.9,
    },
    {
      field: "email",
      providers: [emailPatternProvider, ...emailProviders] as EnrichmentProvider[],
      mode: "best",          // keep falling through to verify/upgrade the pattern guess
      acceptConfidence: 0.85,
    },
  ];
  if (phoneProviders.length) {
    steps.push({
      field: "phone",
      providers: phoneProviders as EnrichmentProvider[],
      mode: "first",
      acceptConfidence: 0.8,
    });
  }
  return { steps };
}
