/**
 * RecruiterOS · Hiring Engine
 * People-graph abstraction — find the humans who match a target profile.
 *
 * The resolver never knows a vendor's name, exactly like the LinkedIn Engine wraps every
 * backend behind `LinkedInProvider` and the waterfall wraps every enricher behind
 * `EnrichmentProvider`. A `PeopleGraph` takes a structured query (company + target titles)
 * and returns candidate people. Adapters provided:
 *
 *   - linkedInPeopleGraph()  — wraps the existing searchProfiles() (Unipile/in-bridge)
 *   - httpPeopleGraph()      — generic adapter for Apollo / People Data Labs / RocketReach
 *   - staticPeopleGraph()    — fixed list, for tests + deterministic runs
 *
 * Everything is injected (search fn, account, fetcher), so this module pulls in no vendor
 * SDK and runs with no credentials in a test.
 */

import type { JobFunction, Seniority } from "../filters";
import { companyAnchor } from "./normalize";

/* ------------------------------------------------------------------ */
/* Query + candidate shapes                                            */
/* ------------------------------------------------------------------ */

export interface PeopleQuery {
  companyName: string;
  companyDomain?: string;
  /** Target titles to search for, best-first (from the target profile). */
  titles: string[];
  function?: JobFunction;
  seniorityFloor?: Seniority;
  /** Team/product hint from the req, used to disambiguate at large companies. */
  team?: string;
  location?: string;
  /** Max candidates to return. */
  limit?: number;
}

/** One person surfaced by a graph, before scoring/ranking. */
export interface PersonCandidate {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  headline?: string;
  companyName?: string;
  location?: string;
  linkedinUrl?: string;
  providerProfileId?: string;
  /** Graph that produced this candidate. */
  source: string;
  raw?: unknown;
}

export interface PeopleGraph {
  readonly id: string;
  /** True when this graph has what it needs to run (account, key, fn…). */
  isConfigured(): boolean;
  search(query: PeopleQuery): Promise<PersonCandidate[]>;
}

/* ------------------------------------------------------------------ */
/* Helper: split a full name                                           */
/* ------------------------------------------------------------------ */

export function splitName(full: string | undefined): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/* ------------------------------------------------------------------ */
/* LinkedIn search-URL builder                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a LinkedIn people-search URL from a target query. The existing provider's
 * searchProfiles() "accepts the raw URL straight from the address bar", so a keyword
 * search of (title OR title) AND company is enough to surface the manager set.
 */
export function buildLinkedInSearchUrl(query: PeopleQuery): string {
  const titleClause = query.titles.length
    ? "(" + query.titles.slice(0, 6).map((t) => `"${t}"`).join(" OR ") + ")"
    : "";
  const companyClause = query.companyName ? `"${query.companyName}"` : "";
  const teamClause = query.team ? `"${query.team}"` : "";
  const keywords = [titleClause, companyClause, teamClause].filter(Boolean).join(" AND ");
  const params = new URLSearchParams({ keywords });
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Adapter: LinkedIn (wraps the existing searchProfiles)               */
/* ------------------------------------------------------------------ */

/** The minimal slice of a LinkedIn SearchProfile the graph consumes. */
export interface LinkedInSearchProfile {
  providerProfileId: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  title?: string;
  company?: string;
  location?: string;
  publicProfileUrl?: string;
}

export interface LinkedInGraphDeps<Account = unknown> {
  /** The connected sending account to run the search through. */
  account: Account;
  /** Injected: the provider's searchProfiles, e.g. getProvider().searchProfiles. */
  searchProfiles: (opts: {
    account: Account;
    url: string;
    limit?: number;
  }) => Promise<LinkedInSearchProfile[]>;
  /** Override the search-URL builder if you run Sales Navigator / Recruiter. */
  buildSearchUrl?: (query: PeopleQuery) => string;
  id?: string;
}

/**
 * People graph backed by the LinkedIn Engine. Reuses the recruiter's connected account and
 * the same searchProfiles() the Sales-Navigator import already uses, so no new vendor.
 */
export function linkedInPeopleGraph<Account = unknown>(
  deps: LinkedInGraphDeps<Account>,
): PeopleGraph {
  const build = deps.buildSearchUrl ?? buildLinkedInSearchUrl;
  return {
    id: deps.id ?? "linkedin",
    isConfigured: () => Boolean(deps.account && deps.searchProfiles),
    async search(query) {
      const url = build(query);
      const profiles = await deps.searchProfiles({
        account: deps.account,
        url,
        limit: query.limit ?? 25,
      });
      return profiles.map((p) => {
        const split = splitName(p.fullName);
        return {
          fullName: p.fullName,
          firstName: p.firstName ?? split.firstName,
          lastName: p.lastName ?? split.lastName,
          title: p.title ?? p.headline,
          headline: p.headline,
          companyName: p.company,
          location: p.location,
          linkedinUrl: p.publicProfileUrl,
          providerProfileId: p.providerProfileId,
          source: deps.id ?? "linkedin",
          raw: p,
        } satisfies PersonCandidate;
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Adapter: generic HTTP people-data API (Apollo / PDL / RocketReach)  */
/* ------------------------------------------------------------------ */

export interface HttpGraphDeps {
  id: string;
  /** Names of env vars the API key lives in; presence drives isConfigured(). */
  envKeys?: string[];
  /**
   * Injected fetch-and-map: hit your people-data API for the query and return candidates.
   * Keeping this a plain function means the vendor's auth/shape never leaks into the engine
   * and the whole thing stays testable without a key.
   */
  fetchCandidates: (query: PeopleQuery) => Promise<PersonCandidate[]>;
  /** Override the default env-presence check. */
  isConfigured?: () => boolean;
}

/** People graph backed by any people-data API you wire via an injected fetch+map fn. */
export function httpPeopleGraph(deps: HttpGraphDeps): PeopleGraph {
  return {
    id: deps.id,
    isConfigured:
      deps.isConfigured ??
      (() => (deps.envKeys ?? []).every((k) => Boolean(process.env[k]))),
    async search(query) {
      const out = await deps.fetchCandidates(query);
      return out.map((c) => ({ ...c, source: c.source ?? deps.id }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Adapter: static (tests / deterministic runs)                        */
/* ------------------------------------------------------------------ */

/**
 * A graph that returns a fixed candidate pool, filtered to the queried company. Lets the
 * resolver be unit-tested with zero network and makes pipeline demos deterministic.
 */
export function staticPeopleGraph(
  candidates: PersonCandidate[],
  id = "static",
): PeopleGraph {
  return {
    id,
    isConfigured: () => true,
    async search(query) {
      const want = companyAnchor(query.companyName);
      const pool = candidates
        .filter((c) => !want || !c.companyName || companyAnchor(c.companyName) === want)
        .map((c) => ({ ...c, source: c.source ?? id }));
      return query.limit ? pool.slice(0, query.limit) : pool;
    },
  };
}
