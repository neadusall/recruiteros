/**
 * RecruitersOS · Signal Engine
 * The collector — orchestration of the full signal flow.
 *
 * This is the conductor that implements the product's four-step loop end to end
 * (signals.html: Pull → Match → Score → Trigger), with dedupe and the velocity
 * roll-up in between:
 *
 *     pull(sources)            → raw signals from every configured connector
 *       └─ dedupe + merge      → corroborate multi-source agreement into one record
 *           └─ rollUp          → many job_postings on one company → hiring_velocity
 *               └─ resolve     → optionally enrich the subject via the waterfall
 *                   └─ rank    → ICP match + score (scoring.ts) into a work-list
 *                       └─ trigger → high scorers fire onTrigger (build a campaign)
 *
 * Everything stateful (cursors, the seen-set, the campaign launcher) is injected, so
 * this module is pure orchestration and can run in a cron worker, an API route, or a
 * test with no environment.
 */

import type { ICP, PullResult, Signal, SignalType } from "./types";
import type { SignalSource, PullContext } from "./sources";
import { configuredSources } from "./sources";
import { rankSignals, type ScoreContext } from "./scoring";
import { getDefinition } from "./registry";
import {
  enrich,
  type EnrichmentPlan,
  type EnrichmentReport,
  type RunOptions,
} from "./waterfall";

/* ------------------------------------------------------------------ */
/* Injected collaborators                                              */
/* ------------------------------------------------------------------ */

/** Persists per-source cursors so polling is incremental across runs. */
export interface CursorStore {
  get(sourceId: string): Promise<string | undefined>;
  set(sourceId: string, cursor: string): Promise<void>;
}

/** Remembers signals we have already acted on, so we don't re-trigger. */
export interface SeenStore {
  has(dedupeKey: string): Promise<boolean>;
  add(dedupeKey: string): Promise<void>;
}

/** Called for each signal that clears the auto-trigger threshold. */
export type TriggerHandler = (signal: Signal) => Promise<void> | void;

export interface CollectOptions {
  icp: ICP;
  now: string;                       // ISO; injected for determinism
  sources?: SignalSource[];          // defaults to all configured sources
  pull?: PullContext;                // watchlist, since, limit
  cursors?: CursorStore;
  seen?: SeenStore;
  /** If set, top-ranked signals are enriched via this plan before triggering. */
  enrichmentPlan?: EnrichmentPlan;
  enrichmentOpts?: Omit<RunOptions, "now">;
  /** Fired for every signal whose score says shouldTrigger. */
  onTrigger?: TriggerHandler;
  /** Only enrich + consider triggering the top N ranked signals (cost control). */
  triggerTopN?: number;
}

export interface CollectReport {
  pulled: number;
  deduped: number;
  ranked: Signal[];                  // scored + sorted work-list
  triggered: Signal[];               // subset that fired onTrigger
  enrichment: Record<string, EnrichmentReport>; // by signal id, when enrichment ran
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Stage 1: pull                                                       */
/* ------------------------------------------------------------------ */

/** Poll every source once, advancing cursors. Source failures degrade gracefully. */
export async function pullAll(opts: CollectOptions): Promise<{ signals: Signal[]; warnings: string[] }> {
  const sources = configuredSources(opts.sources);
  const warnings: string[] = [];
  const signals: Signal[] = [];

  const results = await Promise.all(
    sources.map(async (src): Promise<PullResult> => {
      try {
        const cursor = opts.cursors ? await opts.cursors.get(src.id) : opts.pull?.cursor;
        const out = await src.pull({ ...opts.pull, cursor });
        if (out.cursor && opts.cursors) await opts.cursors.set(src.id, out.cursor);
        return out;
      } catch (err) {
        return { signals: [], warnings: [`${src.id}: ${(err as Error).message}`] };
      }
    }),
  );

  for (const r of results) {
    signals.push(...r.signals);
    if (r.warnings) warnings.push(...r.warnings);
  }
  return { signals, warnings };
}

/* ------------------------------------------------------------------ */
/* Stage 2: dedupe + merge (corroboration)                             */
/* ------------------------------------------------------------------ */

/**
 * Collapse signals that share a `dedupeKey` into one record, unioning their sources so
 * the scorer's corroboration component can reward multi-source agreement. The merged
 * record keeps the earliest eventAt and the richest title/detail/evidence.
 */
export function dedupe(signals: Signal[]): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const s of signals) {
    const existing = byKey.get(s.dedupeKey);
    if (!existing) {
      byKey.set(s.dedupeKey, { ...s, sources: [...s.sources] });
      continue;
    }
    // Merge sources (dedupe by connector+externalId), keep earliest event.
    const seen = new Set(existing.sources.map((x) => `${x.connector}:${x.externalId}`));
    for (const src of s.sources) {
      const k = `${src.connector}:${src.externalId}`;
      if (!seen.has(k)) {
        existing.sources.push(src);
        seen.add(k);
      }
    }
    if (new Date(s.eventAt) < new Date(existing.eventAt)) existing.eventAt = s.eventAt;
    // Prefer the longer detail and any richer evidence.
    if (s.detail.length > existing.detail.length) existing.detail = s.detail;
    existing.evidence = { ...s.evidence, ...existing.evidence };
    existing.company = existing.company ?? s.company;
    existing.person = existing.person ?? s.person;
    existing.status = "resolved";
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ */
/* Stage 3: hiring-velocity roll-up                                    */
/* ------------------------------------------------------------------ */

/**
 * Many individual `job_posting` signals on the same company within the dedupe window
 * are, together, the much stronger `hiring_velocity` signal. This derives that
 * composite when the count crosses a threshold, while leaving the individual postings
 * in place (they're still useful for role-level targeting).
 */
export function rollUpVelocity(signals: Signal[], opts: { minRoles?: number; now: string }): Signal[] {
  const minRoles = opts.minRoles ?? 3;
  const postingsByCompany = new Map<string, Signal[]>();

  for (const s of signals) {
    if (s.type !== "job_posting") continue;
    const key = (s.company?.domain ?? s.company?.name ?? "").toLowerCase();
    if (!key) continue;
    (postingsByCompany.get(key) ?? postingsByCompany.set(key, []).get(key)!).push(s);
  }

  const derived: Signal[] = [];
  for (const [key, postings] of postingsByCompany) {
    if (postings.length < minRoles) continue;
    const def = getDefinition("hiring_velocity");
    const functions = [...new Set(postings.map((p) => p.evidence.function).filter(Boolean))];
    const company = postings[0].company;
    const earliest = postings.reduce((a, b) => (a.eventAt < b.eventAt ? a : b)).eventAt;
    derived.push({
      id: `sig_velocity_${key}`.replace(/[^a-zA-Z0-9_]/g, "_"),
      type: "hiring_velocity",
      motion: def.motion,
      status: "resolved",
      title: `${company?.name ?? key} posted ${postings.length} roles recently`,
      detail: `A surge of ${postings.length} open roles${functions.length ? ` across ${functions.join(", ")}` : ""} signals a team stretched past capacity.`,
      company,
      evidence: {
        rolesPosted: postings.length,
        window: "dedupe-window",
        functions,
        roleIds: postings.map((p) => p.id),
      },
      sources: postings.flatMap((p) => p.sources),
      eventAt: earliest,
      ingestedAt: opts.now,
      dedupeKey: `hiring_velocity:${key}:rollup`,
    });
  }
  return [...signals, ...derived];
}

/* ------------------------------------------------------------------ */
/* Stage 4: optional enrichment of top signals (the waterfall)         */
/* ------------------------------------------------------------------ */

/**
 * Build the enrichment subject from a signal's resolved entity and run the plan. Only
 * applied to the top-ranked few to control credit spend, since the waterfall can hit
 * paid providers.
 */
async function enrichSignal(
  signal: Signal,
  plan: EnrichmentPlan,
  opts: RunOptions,
): Promise<EnrichmentReport> {
  const subject: Record<string, unknown> = signal.person
    ? {
        firstName: signal.person.firstName,
        fullName: signal.person.fullName,
        companyName: signal.person.companyName ?? signal.company?.name,
        domain: signal.company?.domain,
      }
    : {
        companyName: signal.company?.name,
        domain: signal.company?.domain,
      };
  return enrich(plan, subject, opts);
}

/* ------------------------------------------------------------------ */
/* The full run                                                        */
/* ------------------------------------------------------------------ */

/**
 * Execute the entire flow once. Designed to be called on a schedule (cron worker) or on
 * demand from an API route. Returns a full report for observability and the UI feed.
 */
export async function collect(opts: CollectOptions): Promise<CollectReport> {
  const scoreCtx: ScoreContext = { now: opts.now };

  // 1. Pull
  const { signals: raw, warnings } = await pullAll(opts);

  // 2. Dedupe + 3. roll up velocity
  const merged = dedupe(raw);
  const withVelocity = rollUpVelocity(merged, { now: opts.now });

  // 4. Match + score → ranked work-list
  const ranked = rankSignals(withVelocity, opts.icp, scoreCtx);

  // 5. Enrich + trigger the top N
  const triggered: Signal[] = [];
  const enrichment: Record<string, EnrichmentReport> = {};
  const candidates =
    typeof opts.triggerTopN === "number" ? ranked.slice(0, opts.triggerTopN) : ranked;

  for (const signal of candidates) {
    if (!signal.score?.shouldTrigger) continue;
    if (opts.seen && (await opts.seen.has(signal.dedupeKey))) continue;

    if (opts.enrichmentPlan) {
      try {
        enrichment[signal.id] = await enrichSignal(signal, opts.enrichmentPlan, {
          now: opts.now,
          ...opts.enrichmentOpts,
        });
      } catch (err) {
        warnings.push(`enrich ${signal.id}: ${(err as Error).message}`);
      }
    }

    signal.status = "triggered";
    if (opts.onTrigger) await opts.onTrigger(signal);
    if (opts.seen) await opts.seen.add(signal.dedupeKey);
    triggered.push(signal);
  }

  return {
    pulled: raw.length,
    deduped: merged.length,
    ranked,
    triggered,
    enrichment,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory default stores (dev / single-process)                     */
/* ------------------------------------------------------------------ */

/** Simple in-memory cursor + seen stores. Swap for Redis / DB in production. */
export function memoryStores(): { cursors: CursorStore; seen: SeenStore } {
  const cursorMap = new Map<string, string>();
  const seenSet = new Set<string>();
  return {
    cursors: {
      async get(id) {
        return cursorMap.get(id);
      },
      async set(id, c) {
        cursorMap.set(id, c);
      },
    },
    seen: {
      async has(k) {
        return seenSet.has(k);
      },
      async add(k) {
        seenSet.add(k);
      },
    },
  };
}

/** Convenience: the set of signal types a given motion will surface, for UI filters. */
export function trackedTypesForMotion(icp: ICP): SignalType[] {
  if (icp.signalTypes?.length) return icp.signalTypes;
  return []; // empty = "all for this motion", resolved by the registry at query time
}
