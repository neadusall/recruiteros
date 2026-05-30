# RecruiterOS · Signal Engine

The framework that finds **companies that are hiring** and the **hiring managers** behind
the roles, by watching the market for every hiring signal, scoring it against your ICP,
and (optionally) triggering a campaign. It also ships the **waterfall data-collection**
engine that enriches each match — domain, work email, phone, hiring manager — provider by
provider, cheapest-first.

This is a framework-agnostic TypeScript module (no ORM, no vendor SDKs — `fetch` only),
so it drops onto the RecruiterOS core models and sits alongside the LinkedIn Engine in
[`../linkedin`](../linkedin).

```
pull(sources) → dedupe + corroborate → roll-up velocity → match + score (ICP) → enrich (waterfall) → trigger
```

## Layers

| File | Responsibility |
|------|----------------|
| `types.ts` | Domain types + the full `SignalType` taxonomy |
| `registry.ts` | **The catalog** — one `SignalDefinition` per signal (weight, half-life, sources) |
| `sources.ts` | Pluggable `SignalSource` connectors that emit raw signals |
| `freeSources.ts` | **The $0 tier** — free/public connectors (more ATS, remote boards, HN, USAspending, GitHub, News RSS) |
| `scoring.ts` | ICP disqualifiers + the 0..100 composite score |
| `filters.ts` | Filter + segment by industry, job title, function, seniority, geo, size, stage |
| `waterfall.ts` | Clay-style enrichment: ordered providers, first/best, with provenance |
| `rapidapi.ts` | Cheap-first contact providers (RapidAPI + Icypeas) + verify, premium as backup |
| `campaignBuilder.ts` | Organize free signals into a reviewable pre-launch campaign draft |
| `collector.ts` | Orchestrates the whole loop and fires `onTrigger` |
| `index.ts` | Public API barrel — import from here |

## The $0 path (free signal coverage)

`freeSources()` returns connectors that hit only public/unauthenticated endpoints, so the
entire company-side picture can be assembled for nothing before any paid call:

| Connector | Free source | Signals |
|-----------|-------------|---------|
| `ExtraAtsSource` | Workable · SmartRecruiters · Recruitee public boards | job_posting, hiring_velocity |
| `RemoteBoardsSource` | Remotive / RemoteOK JSON | job_posting (remote) |
| `HackerNewsHiringSource` | HN "Who is hiring" (Algolia + Firebase) | job_posting |
| `UsaSpendingSource` | USAspending.gov awards | grant_or_contract |
| `GitHubOrgSource` | GitHub REST API | headcount_growth, tech_stack_change |
| `NewsRssSource` | Google News RSS | funding_round, exec_hire, layoff, expansion, M&A |

Combine with the built-in `PublicAtsSource` (Greenhouse/Lever/Ashby), `EdgarSource`
(SEC), and `WarnNoticeSource` (layoffs) for full free coverage.

## Filtering + segmentation

`filters.ts` shapes the target list over already-collected free signals, before spending:

```ts
import { applyFilter, segmentBy, classifyTitle } from "@/integration/lib/signals";

const targeted = applyFilter(signals, {
  industries: ["healthcare", "saas"],
  functions: ["engineering"],
  titleIncludes: ["VP", "Head of", "Director"],
  decisionMakersOnly: true,
  locations: ["US", "remote"],
});

segmentBy(targeted, "function"); // grouped buckets for the review screen
classifyTitle("VP of Engineering"); // → { function: "engineering", seniority: "vp", isDecisionMaker: true }
```

Title intelligence normalizes "VP of Eng", "Head of Engineering", and "Engineering
Director" to one function + seniority, so a single filter matches them all.

## Build a campaign before you launch (free)

`buildCampaign()` turns free signals into a reviewable `CampaignDraft` — targets,
segments, stats, and an enrichment **cost estimate** — without spending anything. Approve
the draft, then `planLaunch()` emits the enrichment jobs + signal-grounded outreach seeds.

```ts
import { buildCampaign, planLaunch } from "@/integration/lib/signals";

const draft = buildCampaign(freeSignals, {
  name: "Series B healthcare · Eng leadership",
  icp,
  filter: { industries: ["healthcare"], functions: ["engineering"], decisionMakersOnly: true },
  now: new Date().toISOString(),
  maxTargets: 100,
});

draft.stats;        // signalsMatched, companies, people, top industries
draft.costEstimate; // emailsToFind, est $ to enrich the whole list (cheap-first)
const plan = planLaunch(draft); // enrichmentJobs[] + outreachSeeds[] once approved
```

Over the API: `POST /v1/campaigns/build` runs this end to end (free sources by default).

## The full campaign flow (draft → live)

`campaignFlow.ts` runs an approved draft to launch-ready with an explicit state machine,
so nothing launches half-built:

```
draft ──approve──▶ enriching ──▶ drafting ──▶ ready ──launch──▶ live
 (free)        cheapest-first   signal-grounded   every target has
                 waterfall       sequences        a contact + sequence
```

```ts
import { prepareCampaign, toSendItems, draftSequence } from "@/integration/lib/signals";

const ready = await prepareCampaign(draft, {
  now: new Date().toISOString(),
  enrichSubject: (subject) => enrich(cheapFirstContactWaterfall(), subject, { now }),
  sender: "Jamie",
});

ready.stats;        // targets, enriched, drafted, launchable, skipped, enrichmentCostUsd
ready.launchable;   // targets with a contact AND a drafted sequence
toSendItems(ready); // flat, ordered send items for the deploy layer (email/LinkedIn/SMS)
```

Outreach is generated by `messaging.ts` — every touch is anchored to the target's real
signal and plays a rapport-first rung (recognize → relate → invite → pitch → release),
straight from `COPY-PLAYBOOK.md`. It is deterministic (runs with no API key); pass a
`personalize` hook to upgrade any draft with the LLM personalizer. Targets with no
reachable contact are flagged, never silently dropped.

## The signal catalog (what we watch)

Defined in `registry.ts`. Two motions share one infrastructure (mirrors the product's
two-OS split):

**Company-side → Business Development OS**
- **Capital:** funding round, IPO / S-1, acquisition, merger, revenue milestone, grant / contract
- **Hiring intent:** new job posting, hiring surge (velocity), role reposted, long-open role, headcount growth, careers-page launch, ATS adopted
- **Leadership:** new exec, exec departure, new function lead, board change
- **Footprint:** office expansion, new market, product launch, partnership, tech adoption, intent surge, traffic surge, review velocity

**Company contraction & people-side → Recruiting OS**
- **Contraction:** layoff, WARN notice, office closure, down round, bankruptcy
- **People availability:** open to work, tenure milestone, title stagnation, employer distress, layoff-affected, job change, profile refresh, activity spike, relocation, graduation / cert, contract ending

Each definition carries a `baseWeight` (direct hiring intent ranks above soft proxies)
and a `halfLifeHours` (a WARN notice stays hot for weeks; "open to work" cools in 48h).

Expose the catalog as a service:

```ts
import { catalog } from "@/integration/lib/signals";
app.get("/api/signals/catalog", (_req, res) => res.json(catalog()));
```

## Adding a signal

1. Add the type to the `SignalType` union in `types.ts`.
2. Add a `SignalDefinition` to `SIGNAL_DEFINITIONS` in `registry.ts`.
3. (Optional) have a connector emit it via `makeSignal({ type, ... })`.

Nothing else hard-codes the list — scoring, dedupe, and the API pick it up automatically.

## Adding a source

Implement `SignalSource` (or push to `WebhookSource.ingest`) and add it to
`defaultSources()`. Connectors only normalize their provider's payloads into raw
`Signal`s; resolution, dedupe, and scoring happen downstream.

Built-in connectors: **PublicAtsSource** (Greenhouse / Lever / Ashby public boards, no
auth — the highest-signal source), **EdgarSource** (SEC filings), **WarnNoticeSource**
(US layoff notices), **PeopleGraphSource** (LinkedIn profile changes via Unipile — reuses
the LinkedIn Engine's provider), and **WebhookSource** (partner / first-party push,
including the Telnyx project's signed `call.summarized` events).

## Scoring

`scoreSignal(signal, icp, { now })` → 0..100 with a transparent breakdown:

```
base · 0.30   signal strength from the registry
fit · 0.30    ICP match (industry, size, stage, geo, title, tech)
recency · 0.20  exp. decay on the signal's half-life
urgency · 0.15  deadline pressure (WARN date, contract end, …)
corroboration · 0.05  multi-source agreement
```

Hard ICP disqualifiers drop a signal to 0 before scoring. `rankSignals` returns the
sorted work-list; `score.shouldTrigger` flags anything over the ICP's auto-trigger
threshold.

## Waterfall data collection

A waterfall runs providers for one field in priority order and stops at the first
confident hit — maximal coverage, minimal spend.

```ts
import { contactWaterfall, enrich, makeProvider } from "@/integration/lib/signals";

const hunter = makeProvider<string>({
  id: "hunter", label: "Hunter.io", cost: 1, typicalConfidence: 0.85,
  envKeys: ["HUNTER_API_KEY"],
  fn: async ({ subject, resolved }) => {
    const domain = resolved.domain?.value ?? subject.domain;
    // …call Hunter, map to { status:"hit", value, confidence } or { status:"miss" }
  },
});

const plan = contactWaterfall(
  /* domain providers */ [clearbitDomain],
  /* email providers  */ [hunter, apollo, prospeo],   // tried in this order
);

const report = await enrich(plan, { companyName, firstName, lastName }, { now });
report.resolved.email; // { value, confidence, providerId, cost, at } — full provenance
```

- **`mode: "first"`** stops at the first acceptable hit (default; cheapest).
- **`mode: "best"`** runs all providers and keeps the highest-confidence value.
- `maxCost` / `budget` cap spend; `acceptConfidence` sets the short-circuit bar.
- Local, free providers (`guessDomainProvider`, `emailPatternProvider`) lead every
  waterfall so paid credits are only spent to verify or beat them.
- Every value carries provenance (provider, confidence, cost, timestamp) and the full
  attempt trace is returned for the enrichment UI.

## Running the loop

```ts
import { collect, memoryStores, contactWaterfall } from "@/integration/lib/signals";

const { cursors, seen } = memoryStores(); // swap for Redis / DB in production

const report = await collect({
  icp,
  now: new Date().toISOString(),
  pull: { watchlist: { companyNames: trackedBoardSlugs }, limit: 200 },
  cursors,
  seen,
  enrichmentPlan: contactWaterfall([], [hunter, apollo]),
  triggerTopN: 25,
  onTrigger: async (signal) => {
    // build a campaign from the signal (Sourcing → Outreach), grounded in the evidence
    await campaigns.createFromSignal(signal);
  },
});

report.ranked;     // scored work-list for the Signals tab
report.triggered;  // signals that auto-launched a campaign
report.enrichment; // waterfall provenance per triggered signal
```

Run it on a schedule (cron worker) or behind an API route. It is pure orchestration —
all state (cursors, seen-set, the campaign launcher) is injected.

## Environment

| Var | Used by |
|-----|---------|
| `SEC_EDGAR_USER_AGENT` | EdgarSource (SEC requires a descriptive UA) |
| `WARN_FEED_URL` | WarnNoticeSource (normalized WARN aggregate feed) |
| `UNIPILE_DSN`, `UNIPILE_API_KEY` | PeopleGraphSource (shared with the LinkedIn Engine) |
| _your provider keys_ | waterfall providers you add via `makeProvider({ envKeys })` |

Public ATS boards (Greenhouse / Lever / Ashby) need no credentials.
