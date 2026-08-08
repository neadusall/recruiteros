/**
 * RecruitersOS · Signal Watchlists · vertical presets
 *
 * A watchlist has twelve fields, and the three that decide whether it produces anything
 * are the three nobody guesses right on the first try: which segment string the news feed
 * actually returns companies for, which signals to hunt, and which roles to research a
 * decision-maker for. These presets carry all three, measured rather than assumed.
 *
 * WHERE THE SEGMENTS COME FROM. scripts/selftest-news-capacity.mts was run across twenty
 * candidate verticals over a 30-day window: 1,877 headlines, 379 distinct companies. The
 * six kept here led on supply AND on the rate at which a headline yields a usable company
 * name, which is the number that decides how much of a sweep is wasted. Several plausible
 * verticals were dropped on that evidence — chemical distribution returned 2 companies in
 * thirty days, building products 3, and cold chain named only 13% of what it saw.
 *
 * WHY product_launch IS NOT IN ANY PRESET. It was the single highest-VOLUME signal in that
 * sweep (110 of 412 leads) and carries the lowest intent score in newsDiscover (46, against
 * funding's 72). Enabling it inflates the news arm with weak leads and drags its reply rate
 * down, which would lose the head-to-head against Hire Signals for a reason that has
 * nothing to do with news being worse. Volume is not the goal; the arm is a quality play.
 *
 * The tiers are about CREDIBILITY, not quality. Beat 3 of the news pitch is a claim about
 * what this desk recruits into and what its people already understand. A vertical the desk
 * cannot defend turns that beat into filler, and filler attached to a real funding round is
 * worse than sending nothing. Tier A is defensible on a logistics and supply-chain desk
 * today. Tier B pays better and supplies more, and should be switched on only once the desk
 * can honestly claim it.
 */

import type { WatchlistInput } from "./store";

export interface VerticalPreset {
  key: string;
  /** Watchlist name as it will appear in the UI. */
  name: string;
  /** "a" = defensible on a logistics/supply-chain desk now. "b" = higher fee, needs a desk. */
  tier: "a" | "b";
  segment: string;
  newsSignals: string[];
  targetRoles: string[];
  /** Distinct companies this segment produced in the 30-day measurement. 40 means it hit
   *  the probe's ceiling and the true figure is higher. */
  measuredCompanies30d: number;
  /** Share of headlines that yielded a usable company name. Low = a wasteful sweep. */
  namedPct: number;
  /** Why this vertical is here, in one line a recruiter can agree or disagree with. */
  rationale: string;
}

export const VERTICAL_PRESETS: VerticalPreset[] = [
  /* ---- Tier A: defensible on the current desk ---- */
  {
    key: "third_party_logistics",
    name: "Third party logistics · news",
    tier: "a",
    segment: "third party logistics",
    // A new DC or a closed acquisition is an operations hiring event; funding is the
    // weaker third here because 3PL growth is more often contract-led than VC-led.
    newsSignals: ["office_expansion", "acquisition", "funding_round"],
    targetRoles: ["Operations Manager", "Warehouse Manager", "Account Executive"],
    measuredCompanies30d: 40,
    namedPct: 40,
    rationale: "Highest supply inside the existing desk claim. Volume model, moderate fee per placement.",
  },
  {
    key: "warehouse_automation",
    name: "Warehouse automation · news",
    tier: "a",
    segment: "warehouse automation",
    newsSignals: ["funding_round", "office_expansion", "exec_hire"],
    targetRoles: ["Controls Engineer", "Project Manager", "Account Executive"],
    measuredCompanies30d: 27,
    namedPct: 33,
    rationale: "The bridge vertical: inside logistics credibility, but the roles pay like automation.",
  },
  {
    key: "supply_chain_software",
    name: "Supply chain software · news",
    tier: "a",
    // Lower volume than the others and kept anyway: 60% of headlines named a company,
    // the best measured, so far less of each sweep is thrown away.
    segment: "supply chain software",
    newsSignals: ["funding_round", "exec_hire"],
    targetRoles: ["Account Executive", "Software Engineer", "Customer Success Manager"],
    measuredCompanies30d: 14,
    namedPct: 60,
    rationale: "Best name rate measured. Post-raise SaaS scales GTM and engineering at once, so funding maps to hiring faster than anywhere else in the set.",
  },

  /* ---- Tier B: better economics, needs a desk that can claim it ---- */
  {
    key: "industrial_automation",
    name: "Industrial automation · news",
    tier: "b",
    segment: "industrial automation",
    newsSignals: ["funding_round", "office_expansion", "acquisition"],
    targetRoles: ["Controls Engineer", "Automation Engineer", "Service Manager"],
    measuredCompanies30d: 40,
    namedPct: 39,
    rationale: "Best fee economics in the set. Controls and automation engineers are scarce, do not answer job boards, and the buyers are fragmented mid-market with no procurement wall.",
  },
  {
    key: "aerospace_manufacturing",
    name: "Aerospace manufacturing · news",
    tier: "b",
    segment: "aerospace manufacturing",
    newsSignals: ["office_expansion", "acquisition", "funding_round"],
    targetRoles: ["Manufacturing Engineer", "Quality Engineer", "CNC Machinist"],
    measuredCompanies30d: 40,
    namedPct: 33,
    rationale: "Clearance and AS9100 requirements shrink the candidate pool, which is what makes tier 2/3 suppliers pay.",
  },
  {
    key: "behavioral_health",
    name: "Behavioral health · news",
    tier: "b",
    // Acquisition and expansion lead deliberately: this vertical is consolidating, and a
    // rollup opening or buying a location is immediate clinician hiring.
    segment: "behavioral health",
    newsSignals: ["acquisition", "office_expansion", "exec_hire"],
    targetRoles: ["Clinical Director", "Behavior Analyst", "Clinical Manager"],
    measuredCompanies30d: 40,
    namedPct: 47,
    rationale: "Highest supply and name rate measured, and structurally the best fit for this arm: PE rollups generate constant acquisition and new-location news, and a new clinic is immediate hiring.",
  },
];

export function presetByKey(key: string): VerticalPreset | undefined {
  return VERTICAL_PRESETS.find((p) => p.key === key);
}

/**
 * A preset as a saveable watchlist. Deliberately conservative defaults for a first run:
 * hourly rather than every 15 minutes, and a small per-poll company cap, so a newly
 * enabled vertical cannot dump hundreds of companies into the belt before anyone has read
 * a single email it produced. Both are editable afterwards.
 */
export function presetToWatchlist(p: VerticalPreset, over?: Partial<WatchlistInput>): WatchlistInput {
  return {
    name: p.name,
    source: "news",
    // A news list searches its segment; `query` is unused on this arm but the store
    // normalizes it either way.
    query: "",
    segment: p.segment,
    newsSignals: p.newsSignals,
    targetRoles: p.targetRoles,
    newsWindowDays: 14,
    everyMinutes: 60,
    limit: 40,
    perPollCompanyCap: 10,
    active: true,
    ...over,
  };
}
