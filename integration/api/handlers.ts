/**
 * RecruitersOS · Public API
 * Endpoint handlers — the actual platform surface a customer integrates against.
 *
 * Each handler is a pure function of (AuthedRequest, deps) → ApiResponse, wrapping the
 * signals engine. They contain no transport or framework code; the router dispatches to
 * them and an adapter handles the wire. This is what makes "integrate your application
 * seamlessly" real: a stable, typed HTTP contract over the whole engine.
 *
 * Surface:
 *   GET  /v1/signals/catalog        list every signal we detect (the framework)
 *   POST /v1/signals/collect        run pull → score → (optionally) trigger
 *   POST /v1/signals/ingest         push a customer's own signal in (webhook/manual)
 *   POST /v1/enrich                 run the cheap-first contact waterfall
 *   GET  /v1/config                 read workspace integration config
 *   POST /v1/config/providers       upsert a provider credential + waterfall order
 *   POST /v1/config/webhooks        register a webhook subscription
 */

import {
  apiError,
  apiOk,
  type ApiResponse,
  type AuthedRequest,
  type IntegrationConfig,
  type ProviderCredential,
  type WebhookSubscription,
} from "./types";
import { hasScope } from "./auth";
import {
  publicCatalog,
  publicCategories,
  collect,
  enrich,
  cheapFirstContactWaterfall,
  memoryStores,
  WebhookSource,
  freeSources,
  buildCampaign,
  type ICP,
  type SignalFilter,
  type CollectReport,
  type EnrichmentReport,
} from "../lib/signals";

/* ------------------------------------------------------------------ */
/* Dependencies injected into the handlers                             */
/* ------------------------------------------------------------------ */

/** Storage + side-effects the handlers need, all injectable for tests. */
export interface HandlerDeps {
  /** Current time, ISO. Injected for determinism. */
  now: () => string;
  /** Read/write the workspace's integration config. */
  config: {
    get(workspaceId: string): Promise<IntegrationConfig>;
    upsertProvider(workspaceId: string, p: ProviderCredential): Promise<void>;
    addWebhook(workspaceId: string, w: WebhookSubscription): Promise<void>;
  };
  /** Persist/queue a signal pushed in by a customer. */
  ingestSignal?: (workspaceId: string, signal: unknown) => Promise<void>;
  /** Launch a campaign when a collected signal should trigger one. */
  onTrigger?: (workspaceId: string, signal: unknown) => Promise<void>;
  /** Generate ids (webhook ids, etc.). */
  newId: (prefix: string) => string;
}

/* ------------------------------------------------------------------ */
/* GET /v1/signals/catalog                                             */
/* ------------------------------------------------------------------ */

/**
 * The catalog of every hiring signal RecruitersOS detects — the customer-safe view. It
 * exposes WHAT each signal is (type, label, category, why it matters, strength,
 * freshness) but never WHICH sources/providers supply it. Pass `?grouped=1` for the
 * category-grouped shape used by the UI's signal picker.
 */
export function getCatalog(req: AuthedRequest): ApiResponse {
  if (!hasScope(req.auth, "signals:read")) {
    return apiError(403, "forbidden", "Requires signals:read scope.");
  }
  if (req.query.grouped === "1" || req.query.grouped === "true") {
    return apiOk({ categories: publicCategories() });
  }
  const motion = req.query.motion as ICP["motion"] | undefined;
  const all = publicCatalog();
  const items = motion ? all.filter((d) => d.motion === motion) : all;
  return apiOk({ count: items.length, signals: items });
}

/* ------------------------------------------------------------------ */
/* POST /v1/signals/collect                                            */
/* ------------------------------------------------------------------ */

interface CollectBody {
  icp: ICP;
  watchlist?: { domains?: string[]; companyNames?: string[]; locations?: string[]; keywords?: string[] };
  limit?: number;
  triggerTopN?: number;
  /** When true, top signals are enriched with the cheap-first waterfall. */
  enrich?: boolean;
}

/** Run one pass of the collector and return the scored work-list (+ any triggers). */
export async function postCollect(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "signals:read")) {
    return apiError(403, "forbidden", "Requires signals:read scope.");
  }
  const body = req.body as CollectBody | undefined;
  if (!body?.icp) return apiError(400, "invalid_request", "Body must include an `icp`.");

  const stores = memoryStores(); // production: resolve per-workspace persistent stores
  let report: CollectReport;
  try {
    report = await collect({
      icp: body.icp,
      now: deps.now(),
      pull: { watchlist: body.watchlist, limit: body.limit ?? 100 },
      cursors: stores.cursors,
      seen: stores.seen,
      triggerTopN: body.triggerTopN ?? 25,
      enrichmentPlan: body.enrich ? cheapFirstContactWaterfall() : undefined,
      onTrigger: deps.onTrigger
        ? (signal) => deps.onTrigger!(req.auth.workspaceId, signal)
        : undefined,
    });
  } catch (err) {
    return apiError(502, "collector_failed", (err as Error).message);
  }

  return apiOk({
    pulled: report.pulled,
    deduped: report.deduped,
    ranked: report.ranked,
    triggered: report.triggered.map((s) => s.id),
    enrichment: report.enrichment,
    warnings: report.warnings,
  });
}

/* ------------------------------------------------------------------ */
/* POST /v1/signals/ingest                                             */
/* ------------------------------------------------------------------ */

/** Push a customer's own signal into RecruitersOS (their app as a source). */
export async function postIngest(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "signals:write")) {
    return apiError(403, "forbidden", "Requires signals:write scope.");
  }
  const payload = req.body as Parameters<WebhookSource["ingest"]>[0] | undefined;
  if (!payload?.type || !payload?.title || !payload?.anchor) {
    return apiError(400, "invalid_request", "Body must include at least { type, title, detail, anchor }.");
  }
  let signal;
  try {
    signal = new WebhookSource().ingest(payload, deps.now());
  } catch (err) {
    return apiError(400, "invalid_signal", (err as Error).message);
  }
  if (deps.ingestSignal) await deps.ingestSignal(req.auth.workspaceId, signal);
  return apiOk({ accepted: true, signal }, 202);
}

/* ------------------------------------------------------------------ */
/* POST /v1/campaigns/build                                            */
/* ------------------------------------------------------------------ */

interface BuildBody {
  name: string;
  icp: ICP;
  filter: SignalFilter;
  watchlist?: { domains?: string[]; companyNames?: string[]; locations?: string[]; keywords?: string[] };
  maxTargets?: number;
  wantPhone?: boolean;
  /** When true, only free sources are polled (default) — assemble the list for $0. */
  freeOnly?: boolean;
}

/**
 * Organize FREE signals into a reviewable campaign draft BEFORE launch. Pulls from the
 * free/public connectors, applies the industry/job-title filter, ranks, segments, and
 * returns the target list + cost estimate — all without spending on enrichment.
 */
export async function postBuildCampaign(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "signals:read")) {
    return apiError(403, "forbidden", "Requires signals:read scope.");
  }
  const body = req.body as BuildBody | undefined;
  if (!body?.icp || !body?.filter || !body?.name) {
    return apiError(400, "invalid_request", "Body must include { name, icp, filter }.");
  }
  const stores = memoryStores();
  let collected: CollectReport;
  try {
    collected = await collect({
      icp: body.icp,
      now: deps.now(),
      sources: body.freeOnly === false ? undefined : freeSources(),
      pull: { watchlist: body.watchlist, limit: 300 },
      cursors: stores.cursors,
      seen: stores.seen,
    });
  } catch (err) {
    return apiError(502, "collect_failed", (err as Error).message);
  }
  const draft = buildCampaign(collected.ranked, {
    name: body.name,
    icp: body.icp,
    filter: body.filter,
    now: deps.now(),
    maxTargets: body.maxTargets ?? 100,
    wantPhone: body.wantPhone,
  });
  return apiOk({ draft, warnings: collected.warnings });
}

/* ------------------------------------------------------------------ */
/* POST /v1/enrich                                                     */
/* ------------------------------------------------------------------ */

interface EnrichBody {
  /** The subject to enrich: name + company are the usual minimum. */
  subject: Record<string, unknown>;
  /** Include the phone waterfall (off by default — costly, low yield). */
  includePhone?: boolean;
  /** Optional credit ceiling for this request. */
  budget?: number;
}

/** Run the cheap-first contact waterfall for one subject. */
export async function postEnrich(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "enrich:read")) {
    return apiError(403, "forbidden", "Requires enrich:read scope.");
  }
  const body = req.body as EnrichBody | undefined;
  if (!body?.subject || typeof body.subject !== "object") {
    return apiError(400, "invalid_request", "Body must include a `subject` object.");
  }
  let report: EnrichmentReport;
  try {
    const plan = cheapFirstContactWaterfall({
      includePhone: body.includePhone,
      budget: body.budget,
    });
    report = await enrich(plan, body.subject, { now: deps.now() });
  } catch (err) {
    return apiError(502, "enrich_failed", (err as Error).message);
  }
  return apiOk({
    resolved: report.resolved,
    totalCost: report.totalCost,
    budgetExhausted: report.budgetExhausted,
    trace: report.results.map((r) => ({ field: r.field, attempts: r.attempts })),
  });
}

/* ------------------------------------------------------------------ */
/* Config endpoints                                                    */
/* ------------------------------------------------------------------ */

/** GET /v1/config — the workspace's keys (no secrets), providers, webhooks. */
export async function getConfig(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "config:write")) {
    return apiError(403, "forbidden", "Requires config:write scope.");
  }
  const cfg = await deps.config.get(req.auth.workspaceId);
  // Redact provider secret VALUES; keep which keys are set so the UI can show status.
  const providers = cfg.providers.map((p) => ({
    ...p,
    secrets: Object.fromEntries(Object.keys(p.secrets).map((k) => [k, "set"])),
  }));
  return apiOk({ ...cfg, providers });
}

/** POST /v1/config/providers — upsert a provider credential + its waterfall order. */
export async function postProvider(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "config:write")) {
    return apiError(403, "forbidden", "Requires config:write scope.");
  }
  const p = req.body as ProviderCredential | undefined;
  if (!p?.providerId || typeof p.secrets !== "object") {
    return apiError(400, "invalid_request", "Body must include { providerId, secrets, enabled, order }.");
  }
  await deps.config.upsertProvider(req.auth.workspaceId, {
    providerId: p.providerId,
    secrets: p.secrets,
    enabled: p.enabled ?? true,
    order: typeof p.order === "number" ? p.order : 100,
  });
  return apiOk({ saved: true, providerId: p.providerId });
}

/** POST /v1/config/webhooks — register a webhook subscription. */
export async function postWebhook(req: AuthedRequest, deps: HandlerDeps): Promise<ApiResponse> {
  if (!hasScope(req.auth, "config:write")) {
    return apiError(403, "forbidden", "Requires config:write scope.");
  }
  const b = req.body as Partial<WebhookSubscription> | undefined;
  if (!b?.url || !Array.isArray(b.events) || b.events.length === 0) {
    return apiError(400, "invalid_request", "Body must include { url, events[] }.");
  }
  if (!/^https:\/\//.test(b.url)) {
    return apiError(400, "invalid_request", "Webhook url must be https.");
  }
  const sub: WebhookSubscription = {
    id: deps.newId("whk"),
    workspaceId: req.auth.workspaceId,
    url: b.url,
    events: b.events,
    signingSecret: b.signingSecret ?? deps.newId("whsec"),
    active: true,
    createdAt: deps.now(),
  };
  await deps.config.addWebhook(req.auth.workspaceId, sub);
  // Return the signing secret once so the integrator can verify deliveries.
  return apiOk({ id: sub.id, signingSecret: sub.signingSecret, events: sub.events }, 201);
}
