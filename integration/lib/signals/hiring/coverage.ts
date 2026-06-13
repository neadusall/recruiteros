/**
 * RecruitersOS · Hiring Engine
 * Coverage + suppression — "Indeed only surfaces what the free sources didn't."
 *
 * The user's rule, verbatim: a gated source (Indeed) must NEVER re-touch a company the
 * free API pulls already found. So the loop is two-phase:
 *
 *   1. recordCoverage(store, freeSignals)   — write every free company into the set
 *   2. suppressCovered(store, indeedSignals) — drop any Indeed company already in it
 *
 * Coverage is bucketed by ISO week, so a company that drops out of the free sources next
 * week becomes eligible for Indeed again — suppression reflects *current* free coverage,
 * not a permanent blocklist.
 *
 * The store is injected (memory default), matching the engine's "swap for Redis/DB in
 * production" convention in collector.ts. For 5k jobs/day the free phase writes a few
 * thousand keys/week and the Indeed phase does one set-membership check per listing.
 */

import type { Signal } from "../types";
import { isoWeekOf } from "../sources";
import { companyKeys, roleKey } from "./normalize";

/* ------------------------------------------------------------------ */
/* Injected store                                                      */
/* ------------------------------------------------------------------ */

/**
 * Persists the set of "already covered" keys. Keys arrive pre-bucketed (week-namespaced),
 * so the store itself is a dumb set — easy to back with Redis (SADD/SISMEMBER) or a
 * Postgres table (unique key, `SELECT 1 ... WHERE key = ANY($1)`).
 */
export interface CoverageStore {
  /** Add keys to the covered set. */
  add(keys: string[]): Promise<void>;
  /** True if ANY of the keys is already covered. */
  hasAny(keys: string[]): Promise<boolean>;
  /** Optional: drop a week's keys (housekeeping). No-op if unsupported. */
  prune?(weekPrefix: string): Promise<void>;
}

/** In-memory store for dev / single-process / tests. */
export function memoryCoverageStore(): CoverageStore {
  const set = new Set<string>();
  return {
    async add(keys) {
      for (const k of keys) set.add(k);
    },
    async hasAny(keys) {
      return keys.some((k) => set.has(k));
    },
    async prune(weekPrefix) {
      for (const k of set) if (k.startsWith(weekPrefix)) set.delete(k);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bucketing                                                           */
/* ------------------------------------------------------------------ */

/** Week-namespace a raw key so coverage is scoped to the current window. */
function bucketed(key: string, week: string): string {
  return `${week}|${key}`;
}

/** The set of bucketed coverage keys a single signal contributes. */
function signalKeys(signal: Signal, week: string, level: SuppressLevel): string[] {
  const company = {
    name: signal.company?.name,
    domain: signal.company?.domain,
  };
  const keys = companyKeys(company).map((k) => bucketed(k, week));
  if (level === "role") {
    keys.push(
      bucketed(
        roleKey({
          ...company,
          title: (signal.evidence.roleTitle as string) ?? signal.evidence.title as string,
          location: signal.evidence.location as string,
        }),
        week,
      ),
    );
  }
  return keys;
}

/* ------------------------------------------------------------------ */
/* Phase 1: record what the free sources cover                         */
/* ------------------------------------------------------------------ */

export type SuppressLevel = "company" | "role";

export interface RecordOptions {
  now: string;
  /** "company" (default): record/suppress whole companies. "role": down to the role. */
  level?: SuppressLevel;
}

/**
 * Write every free signal's company (and optionally role) into the coverage set for the
 * current week. Call this on the output of the free pull, BEFORE pulling Indeed.
 *
 * Returns the number of distinct companies recorded (for the run report).
 */
export async function recordCoverage(
  store: CoverageStore,
  freeSignals: Signal[],
  opts: RecordOptions,
): Promise<number> {
  const level = opts.level ?? "company";
  const week = isoWeekOf(opts.now);
  const all = new Set<string>();
  const companies = new Set<string>();
  for (const s of freeSignals) {
    for (const k of signalKeys(s, week, level)) {
      all.add(k);
      if (k.includes("|n:") || k.includes("|d:")) companies.add(k);
    }
  }
  if (all.size) await store.add([...all]);
  return companies.size;
}

/* ------------------------------------------------------------------ */
/* Phase 2: suppress already-covered companies from the gated pull     */
/* ------------------------------------------------------------------ */

export interface SuppressResult {
  /** Signals whose company (or role) the free sources did NOT already have. */
  netNew: Signal[];
  /** Signals dropped because they were already covered. */
  suppressed: Signal[];
  /** Count of suppressed signals (never silently dropped — surfaced in the report). */
  suppressedCount: number;
  /** Net-new after also de-duplicating within the gated batch itself. */
  netNewDeduped: Signal[];
  /** How many gated signals collided with each other (same role/company). */
  internalDuplicates: number;
}

/**
 * Drop every gated signal whose company is already covered by the free sources, then
 * collapse duplicates *within* the gated batch so the same company/role isn't processed
 * twice. Company-level by default, per the user's "never re-touches a covered company".
 */
export async function suppressCovered(
  store: CoverageStore,
  gatedSignals: Signal[],
  opts: RecordOptions,
): Promise<SuppressResult> {
  const level = opts.level ?? "company";
  const week = isoWeekOf(opts.now);

  const netNew: Signal[] = [];
  const suppressed: Signal[] = [];

  for (const s of gatedSignals) {
    const company = { name: s.company?.name, domain: s.company?.domain };
    const lookup = companyKeys(company).map((k) => bucketed(k, week));
    if (level === "role") {
      lookup.push(
        bucketed(
          roleKey({
            ...company,
            title: (s.evidence.roleTitle as string) ?? (s.evidence.title as string),
            location: s.evidence.location as string,
          }),
          week,
        ),
      );
    }
    if (lookup.length && (await store.hasAny(lookup))) suppressed.push(s);
    else netNew.push(s);
  }

  // De-dup within the surviving net-new batch (Indeed often lists one company many times).
  const seen = new Set<string>();
  const netNewDeduped: Signal[] = [];
  let internalDuplicates = 0;
  for (const s of netNew) {
    const company = { name: s.company?.name, domain: s.company?.domain };
    const key =
      level === "role"
        ? roleKey({
            ...company,
            title: (s.evidence.roleTitle as string) ?? (s.evidence.title as string),
            location: s.evidence.location as string,
          })
        : companyKeys(company)[0] ?? `n:${company.name ?? ""}`;
    if (seen.has(key)) {
      internalDuplicates++;
      continue;
    }
    seen.add(key);
    netNewDeduped.push(s);
  }

  return {
    netNew,
    suppressed,
    suppressedCount: suppressed.length,
    netNewDeduped,
    internalDuplicates,
  };
}
