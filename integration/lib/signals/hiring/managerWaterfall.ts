/**
 * RecruitersOS · Hiring Engine
 * The hiring-manager step as a waterfall provider.
 *
 * waterfall.ts is field-agnostic and explicitly calls out "the hiring manager for a role"
 * as a target field. This wraps resolveHiringManager() as an `EnrichmentProvider<RankedManager>`
 * for the `hiringManager` field, so HM resolution becomes a first-class step you can drop
 * into any `EnrichmentPlan` ahead of the contact (domain → email → phone) waterfall.
 *
 * The provider reads `companyName` + `roleTitle` from the enrichment subject, resolves the
 * manager, and — on a hit — accretes the manager's name into the subject so the downstream
 * email/phone waterfalls resolve THAT person, not the company generically.
 */

import type {
  EnrichmentProvider,
  EnrichmentInput,
  ProviderOutcome,
  WaterfallSpec,
} from "../waterfall";
import {
  resolveHiringManager,
  type HiringManagerResolution,
  type RankedManager,
  type ResolveOptions,
} from "./resolve";
import { splitName } from "./peopleGraph";

export interface ManagerProviderOptions extends ResolveOptions {
  /** Provider id (default "hiring_manager"). */
  id?: string;
  /**
   * Minimum resolution score to count as a hit. Below this the step misses and the
   * subject is left company-only. Default 0.4 (i.e. at least a function leader).
   */
  minScore?: number;
  /** Relative cost units this step charges (people-graph credits). Default 1. */
  cost?: number;
}

/**
 * Build the hiring-manager enrichment provider. The resolved RankedManager is returned as
 * the value (full resolution is on `raw`), and the manager's name fields are written back
 * onto the subject for downstream contact steps.
 */
export function hiringManagerProvider(opts: ManagerProviderOptions): EnrichmentProvider<RankedManager> {
  const minScore = opts.minScore ?? 0.4;
  return {
    id: opts.id ?? "hiring_manager",
    label: "Hiring manager (people-graph inference)",
    cost: opts.cost ?? 1,
    typicalConfidence: 0.7,
    isConfigured: () => opts.graphs.some((g) => g.isConfigured()),
    async lookup(input: EnrichmentInput): Promise<ProviderOutcome<RankedManager>> {
      const company = String(
        input.subject.companyName ?? input.subject.company ?? "",
      ).trim();
      const roleTitle = String(
        input.subject.roleTitle ?? input.subject.title ?? "",
      ).trim();
      if (!company || !roleTitle) return { status: "miss" };

      const resolution = await resolveHiringManager(company, roleTitle, opts);
      const best = resolution.best;
      if (!best || best.score < minScore) {
        return { status: "miss", cost: opts.cost ?? 1 };
      }

      // Accrete the resolved person onto the subject so email/phone steps target them.
      const name = best.candidate;
      const split = splitName(name.fullName);
      input.subject.fullName = name.fullName;
      input.subject.firstName = name.firstName ?? split.firstName;
      input.subject.lastName = name.lastName ?? split.lastName;
      if (name.linkedinUrl) input.subject.linkedinUrl = name.linkedinUrl;

      return {
        status: "hit",
        value: best,
        confidence: best.score,
        cost: opts.cost ?? 1,
        raw: resolution as HiringManagerResolution,
      };
    },
  };
}

/** A one-step waterfall that resolves the `hiringManager` field. */
export function hiringManagerWaterfall(opts: ManagerProviderOptions): WaterfallSpec<RankedManager> {
  return {
    field: "hiringManager",
    providers: [hiringManagerProvider(opts)],
    mode: "first",
    acceptConfidence: opts.minScore ?? 0.4,
  };
}
