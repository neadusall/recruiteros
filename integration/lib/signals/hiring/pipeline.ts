/**
 * RecruitersOS · Hiring Engine
 * The end-to-end pipeline: pull job orders → suppress crossover → pair the manager.
 *
 * This is the orchestration the whole build exists for, in one call:
 *
 *   1. pull FREE sources                       (the $0 coverage you already run)
 *   2. recordCoverage(free)                    (write every free company into the set)
 *   3. pull GATED sources (Indeed via proxy)   (the net-new candidates)
 *   4. suppressCovered(gated)                  (drop anything the free pull already had)
 *   5. resolveHiringManager(net-new)           (pair each role with its decision-maker)
 *   6. (optional) enrich the manager's contact (your existing waterfall)
 *
 * Manager resolution is memoized per company+function, so a company posting 12 backend
 * roles resolves "who runs Acme eng?" ONCE — keeping 5k jobs/day down to a few hundred
 * resolutions. Everything stateful (coverage store, graphs, contact plan) is injected, so
 * this runs in a cron worker, an API route, or a test with no environment.
 */

import type { ICP, Signal } from "../types";
import type { PullContext, SignalSource } from "../sources";
import { configuredSources } from "../sources";
import { applyFilter, classifyTitle, type SignalFilter } from "../filters";
import { enrich, type EnrichmentPlan, type EnrichmentReport, type RunOptions } from "../waterfall";
import {
  memoryCoverageStore,
  recordCoverage,
  suppressCovered,
  type CoverageStore,
  type SuppressLevel,
} from "./coverage";
import { resolveHiringManager, type HiringManagerResolution, type ResolveOptions } from "./resolve";
import { splitName, type PeopleGraph } from "./peopleGraph";

/* ------------------------------------------------------------------ */
/* Options + report                                                    */
/* ------------------------------------------------------------------ */

export interface NetNewOptions {
  now: string;
  /** Free / public sources to establish coverage. Defaults to the caller's list. */
  freeSources: SignalSource[];
  /** Gated sources to net-new against coverage, e.g. [indeedSource({ fetch })]. */
  gatedSources: SignalSource[];
  /** Coverage store (persist across the free/gated runs). Defaults to in-memory. */
  coverage?: CoverageStore;
  /** Pull context (watchlist, limit) handed to every source. */
  pull?: PullContext;
  /** "company" (default) or "role" suppression granularity. */
  suppressLevel?: SuppressLevel;
  /** Optional filter applied to net-new jobs before resolving managers (ICP shaping). */
  filter?: SignalFilter;

  /** People graphs for manager resolution. If empty, pairing is skipped. */
  graphs?: PeopleGraph[];
  /** Extra resolver options (companySize, team, alternates…). */
  resolveOpts?: Partial<ResolveOptions>;
  /** Cap manager resolutions per run (cost control). Surfaced in the report if hit. */
  maxResolutions?: number;

  /** Optional contact waterfall to enrich the resolved manager (domain→email→phone). */
  contactPlan?: EnrichmentPlan;
  contactOpts?: Omit<RunOptions, "now">;
}

export interface PairedJob {
  /** The net-new job_posting signal. */
  signal: Signal;
  company: string;
  roleTitle: string;
  /** The hiring-manager resolution (best + alternates + tier). */
  manager: HiringManagerResolution;
  /** Contact enrichment for the resolved manager, when a contact plan + manager exist. */
  contact?: EnrichmentReport;
}

export interface NetNewReport {
  freePulled: number;
  coveredCompanies: number;
  gatedPulled: number;
  suppressed: number;
  internalDuplicates: number;
  netNew: number;
  resolutionsRun: number;
  resolutionsCapped: boolean;
  paired: PairedJob[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Small local pull helper (no ICP/scoring coupling)                   */
/* ------------------------------------------------------------------ */

async function pullSources(
  sources: SignalSource[],
  pull: PullContext | undefined,
  warnings: string[],
): Promise<Signal[]> {
  const configured = configuredSources(sources);
  const out: Signal[] = [];
  const results = await Promise.all(
    configured.map(async (src) => {
      try {
        return await src.pull(pull ?? {});
      } catch (err) {
        return { signals: [], warnings: [`${src.id}: ${(err as Error).message}`] };
      }
    }),
  );
  for (const r of results) {
    out.push(...r.signals);
    if (r.warnings) warnings.push(...r.warnings);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

export async function pullNetNewWithManagers(opts: NetNewOptions): Promise<NetNewReport> {
  const warnings: string[] = [];
  const store = opts.coverage ?? memoryCoverageStore();
  const level = opts.suppressLevel ?? "company";

  // 1 + 2. Free pull → record coverage.
  const free = await pullSources(opts.freeSources, opts.pull, warnings);
  const coveredCompanies = await recordCoverage(store, free, { now: opts.now, level });

  // 3. Gated pull (Indeed via the injected unlocker).
  const gated = await pullSources(opts.gatedSources, opts.pull, warnings);

  // 4. Suppress crossover, then de-dup within the gated batch.
  const sup = await suppressCovered(store, gated, { now: opts.now, level });
  let netNew = sup.netNewDeduped;

  // Optional ICP shaping before we spend on resolution.
  if (opts.filter) netNew = applyFilter(netNew, opts.filter);

  // 5. Pair each net-new role with its hiring manager (memoized per company+function).
  const paired: PairedJob[] = [];
  const graphs = opts.graphs ?? [];
  const cap = opts.maxResolutions ?? Infinity;
  let resolutionsRun = 0;
  let resolutionsCapped = false;
  const memo = new Map<string, HiringManagerResolution>();

  for (const signal of netNew) {
    const company = signal.company?.name ?? "";
    const roleTitle = (signal.evidence.roleTitle as string) ?? signal.title;
    if (!company || !roleTitle) continue;

    let manager: HiringManagerResolution;
    if (graphs.length === 0) {
      // No graph wired: still emit the company-only resolution so callers see the role.
      manager = await resolveHiringManager(company, roleTitle, { graphs: [], ...opts.resolveOpts });
    } else {
      const fn = classifyTitle(roleTitle).function;
      const memoKey = `${company.toLowerCase()}|${fn}`;
      const cached = memo.get(memoKey);
      if (cached) {
        manager = { ...cached, roleTitle }; // reuse the people lookup; relabel the role
      } else {
        if (resolutionsRun >= cap) {
          resolutionsCapped = true;
          continue; // skip resolution past the cap, but keep counting net-new
        }
        manager = await resolveHiringManager(company, roleTitle, {
          graphs,
          companyDomain: signal.company?.domain,
          team: (signal.evidence.team as string) ?? undefined,
          location: signal.evidence.location as string | undefined,
          ...opts.resolveOpts,
        });
        memo.set(memoKey, manager);
        resolutionsRun++;
        if (manager.warnings.length) warnings.push(...manager.warnings.map((w) => `resolve(${company}): ${w}`));
      }
    }

    // 6. Optional contact enrichment for the resolved manager.
    let contact: EnrichmentReport | undefined;
    if (opts.contactPlan && manager.best) {
      const name = manager.best.candidate;
      const split = splitName(name.fullName);
      try {
        contact = await enrich(
          opts.contactPlan,
          {
            fullName: name.fullName,
            firstName: name.firstName ?? split.firstName,
            lastName: name.lastName ?? split.lastName,
            companyName: company,
            domain: signal.company?.domain,
          },
          { now: opts.now, ...opts.contactOpts },
        );
        // Upgrade tier to verified when a high-confidence email was resolved.
        const email = contact.resolved.email;
        if (email && email.confidence >= 0.85 && manager.best.tier === "named") {
          manager = { ...manager, best: { ...manager.best, tier: "named_verified" }, tier: "named_verified" };
        }
      } catch (err) {
        warnings.push(`contact(${name.fullName}): ${(err as Error).message}`);
      }
    }

    paired.push({ signal, company, roleTitle, manager, contact });
  }

  return {
    freePulled: free.length,
    coveredCompanies,
    gatedPulled: gated.length,
    suppressed: sup.suppressedCount,
    internalDuplicates: sup.internalDuplicates,
    netNew: netNew.length,
    resolutionsRun,
    resolutionsCapped,
    paired,
    warnings,
  };
}

/** Re-exported so callers can satisfy NetNewOptions without importing the unused ICP. */
export type { ICP };
