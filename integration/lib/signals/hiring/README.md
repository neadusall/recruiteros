# RecruitersOS · Hiring Engine

Pull job orders from gated boards (Indeed, via your proxy/unlocker), **suppress anything
your free sources already found**, and **pair every net-new role with the decision-maker
over it** — inferred from the job title, resolved against a people graph, and returned with
an honest confidence tier.

This module sits on top of the [Signal Engine](../README.md). It reuses its `Signal`
model, its `classifyTitle()` title intelligence, and its Clay-style enrichment
[`waterfall`](../waterfall.ts). Everything stateful (the proxy fetch, the coverage store,
the people graphs, the contact waterfall) is **injected**, so the whole thing runs in a
cron worker, an API route, or a test with no credentials.

```
free pull ──record coverage──▶ [covered set]
                                     │
Indeed (proxy) ──pull──▶ suppress ◀──┘ ──net-new──▶ resolve hiring manager ──▶ enrich contact
                         (drop crossover)            (by job title)            (existing waterfall)
```

## Files

| File | Responsibility |
|------|----------------|
| `normalize.ts` | **The one join key.** `companyAnchor("Stripe, Inc.") === companyAnchor("stripe")`. Every source must anchor through this or suppression leaks duplicates. |
| `coverage.ts` | Record free-source companies, then **suppress** any gated company already covered (the user's "Indeed = net-new only"). Week-bucketed; store is injected. |
| `targetProfile.ts` | Role title → **who manages it**: function, the titles to search, the seniority band. "Backend Engineer" → {Eng Manager, Director Eng, VP Eng}. |
| `peopleGraph.ts` | Provider-agnostic people search: `linkedInPeopleGraph` (wraps your `searchProfiles`), `httpPeopleGraph` (Apollo/PDL/RocketReach), `staticPeopleGraph` (tests). |
| `resolve.ts` | `resolveHiringManager()` — rank candidates and return a **confidence tier**: `named` → `function_leader` → `recruiter` → `company_only`. Never invents a false single answer. |
| `managerWaterfall.ts` | The resolver wrapped as an `EnrichmentProvider` so it drops into any `EnrichmentPlan` before the contact waterfall. |
| `indeed.ts` | `IndeedSource` — a `SignalSource` whose network call is **your injected unlocker**. No `fetch` of its own. Swap proxies without touching the engine. |
| `pipeline.ts` | `pullNetNewWithManagers()` — the whole loop end to end, with per-company-function memoization for cost control. |

## Quick start

```ts
import {
  pullNetNewWithManagers, indeedSource, linkedInPeopleGraph, httpPeopleGraph,
} from "@/integration/lib/signals/hiring";
import { freeSources, cheapFirstContactWaterfall } from "@/integration/lib/signals";

// 1. Your proxy/unlocker (Option B: Bright Data / Oxylabs / ScraperAPI / Zyte).
//    Returns rendered HTML or clean JSON — this is the ONLY place proxies live.
const unlocker = async (url: string) => {
  const r = await fetch("https://unlocker.example/v1/get", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UNLOCKER_KEY}` },
    body: JSON.stringify({ url, render: true, country: "us" }),
  });
  return { status: r.status, body: await r.text(), contentType: r.headers.get("content-type") ?? undefined };
};

// 2. People graph — LinkedIn primary (reuse the connected account), people-data fallback.
const li = linkedInPeopleGraph({
  account,                                  // a connected LinkedIn sending account
  searchProfiles: getProvider().searchProfiles, // the existing provider method
});
const apollo = httpPeopleGraph({
  id: "apollo",
  envKeys: ["APOLLO_API_KEY"],
  fetchCandidates: async (q) => { /* hit Apollo, map to PersonCandidate[] */ return []; },
});

// 3. Run the loop.
const report = await pullNetNewWithManagers({
  now: new Date().toISOString(),
  freeSources: freeSources(),                       // establishes coverage
  gatedSources: [indeedSource({ fetch: unlocker, query: "software engineer", location: "United States" })],
  graphs: [li, apollo],                             // LinkedIn first, Apollo as fallback
  suppressLevel: "company",                         // never re-touch a covered company
  maxResolutions: 300,                              // cost cap; surfaced if hit
  contactPlan: cheapFirstContactWaterfall(),        // optional: resolve the manager's email/phone
});

report.suppressed;        // how many Indeed rows collided with the free pull (dropped)
report.netNew;            // companies Indeed added that the free sources missed
report.paired[0].manager; // { best, alternates, tier, target, ... }
report.paired[0].contact; // email/phone with provenance, when contactPlan was passed
```

## Suppression: "Indeed only surfaces what the free sources didn't"

Two-phase, week-bucketed:

1. `recordCoverage(store, freeSignals)` writes every free company's keys (domain root +
   name anchor) into the set for the current ISO week.
2. `suppressCovered(store, indeedSignals)` drops any Indeed company whose keys are already
   in the set, then de-dupes the survivors so one company posting 12 roles is processed
   once.

It's **company-level by default** (`suppressLevel: "company"`) — your confirmed rule.
Switch to `"role"` to let Indeed add *other* roles at a company the free sources only
partially covered. Coverage resets weekly, so a company that drops out of the free feeds
becomes eligible for Indeed again.

The store is injected. The in-memory default is fine for a single process; for the real
free-then-Indeed split (different schedules) back it with Redis or Postgres:

```ts
const coverage: CoverageStore = {
  async add(keys)   { await redis.sadd("coverage", ...keys); },
  async hasAny(keys){ return (await redis.smismember("coverage", keys)).some(Boolean); },
};
```

## Confidence tiers (the honest part)

Indeed almost never names the hiring manager, so the resolver **infers and verifies** — it
does not pretend to extract. Every resolution carries a tier:

| Tier | Meaning | Use |
|------|---------|-----|
| `named_verified` | A decision-maker with a verified contact (set by the pipeline after the email waterfall confirms). | Outreach-ready. |
| `named` | A strong title+function match, unambiguous (small co or single leader). | High-confidence. |
| `function_leader` | The right function leader, but several plausible people. | Good; pick from `alternates`. |
| `recruiter` | Only in-house recruiters/TA found. | Still a valid contact. |
| `company_only` | No person resolved. | Fall back to the company-level BD motion. |

Scoring blends function match (0.30), seniority fit — peaks "one level up" (0.30), title
match (0.25), team/product hint (0.10), and location (0.05). `best.reasons[]` explains
every pick for the UI.

## Cost at 5k jobs/day

Manager resolution is **memoized per company+function**, so a company's 12 backend reqs
resolve "who runs Acme eng?" once. After suppression trims to net-new companies, 5k
jobs/day collapses to a few hundred resolutions — set `maxResolutions` to cap spend; the
report flags `resolutionsCapped` rather than silently truncating.

## Adapting the Indeed parser

`indeed.ts` ships a best-effort `defaultParseIndeed` (JSON-first, HTML-blob fallback). It
returns `[]` + a warning on a markup change rather than crashing. **The `parse` option is
the seam** — point it at exactly what your unlocker returns (many return structured JSON,
which is the happy path):

```ts
indeedSource({
  fetch: unlocker,
  parse: (res) => JSON.parse(res.body).jobs.map((j) => ({
    jobId: j.id, title: j.title, company: j.companyName, location: j.location, url: j.url,
  })),
});
```

## Note on `classifyTitle`

The shared `../filters.ts` keyword classifier has a word-boundary quirk: `\bengineer\b`
doesn't match "Engineer**ing**", so `classifyTitle("Director of Engineering").function`
returns `"other"`. The resolver is robust to this (a target-title match implies the
function), and recruiter detection here matches the `-er`/`-ing` forms. If you want the
base classifier fixed too, broaden those regexes in `../filters.ts` — but that's shared by
segmentation and filtering, so verify those paths first.
```
