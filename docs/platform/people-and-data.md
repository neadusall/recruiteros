# Platform Reference — People & Data

Who you reach, and the data behind it. All paths are under
[`integration/lib/`](../../integration/lib/). See the [platform index](README.md) for the other groups.

---

### prospects
- **Purpose:** Pipeline lifecycle management and automation rules that move prospects between stages (queued, in_sequence, replied, booked, won, nurture, closed_lost). Bidirectional ATS sync; every add/edit upserts a Person record and status changes log events.
- **Key files:** `index.ts` (lifecycle definitions, main flow), core integration for prospect CRUD and ATS sync.
- **Main exports / entry points:** `addProspect()` (manual add or CSV upload with dedup), `enrichProspect()` (resolve hiring-manager name, then contact via waterfall), `transition()` (move status + log activity), `applyLifecycleRules()` (day-28 auto-nurture sweep).
- **Depends on:** `core/repository`, `ats` (Person sync), `signals` (enrichment waterfall), `data` (free warehouse backfill).
- **Start here:** `integration/lib/prospects/index.ts` — read `LIFECYCLE` first, then `addProspect()`.

### prospect-lists
- **Purpose:** Named, saved sets of prospects (audiences). Recruiters bulk-select prospects and save them by name, then assign that list as the campaign audience in Campaign Studio.
- **Key files:** `index.ts` (in-memory store with CRUD, durable persistence via db snapshot).
- **Main exports / entry points:** `listProspectLists()`, `getProspectList()`, `upsertProspectList()`, `deleteProspectList()`.
- **Depends on:** `db` (snapshot persistence), `core/ids`.
- **Start here:** `integration/lib/prospect-lists/index.ts` — simple per-workspace CRUD with dedup.

### importmotion
- **Purpose:** Per-workspace preference for which motion (Recruiting or BD) LinkedIn scrapes land into. The Chrome extension reads this so leads drop into the active motion, not a fixed one.
- **Key files:** `index.ts` (Map<workspaceId, Motion>; lazy-loaded from snapshot).
- **Main exports / entry points:** `getImportMotion()`, `setImportMotion()`.
- **Depends on:** `db` (durable snapshot via loadSnapshot / debouncedSaver).
- **Start here:** `integration/lib/importmotion/index.ts` — tiny; shows the durable-store pattern.

### inmarket
- **Purpose:** "Who is in the market for recruiting help right now?" Turns free-text search into ranked companies actively hiring (with decision-makers), combining Signal Engine free sources, ICP scoring, and buyer resolution. Sits above Prospects in the BD OS.
- **Key files:** `index.ts` (main search API), `pool.ts` (persistent accumulated pool), `accumulator.ts` (background refresh on a timer).
- **Main exports / entry points:** `searchInMarket()` (query + suppression), `collectLeads()` (live source-hitting), `promoteLead()` (convert to Prospect with enrichment), `dedupeLeads()`.
- **Depends on:** `signals` (free sources, collect, enrich, scoring), `prospects` (addProspect), pool/accumulator.
- **Start here:** `integration/lib/inmarket/index.ts` — read `searchInMarket()` for query → lead → prospect.

### signals
- **Purpose:** Signal Engine — finds companies hiring and hiring managers by watching the market (job boards, SEC, WARN notices, funding, news…), scoring against ICPs, and optionally triggering campaigns. Also ships the waterfall enrichment engine (domain, email, phone, cheapest-first).
- **Key files:** `index.ts` (barrel), `collector.ts` (orchestration), `registry.ts` (signal definitions + catalog), `sources.ts` (connectors), `scoring.ts` (ICP + 0..100 rank), `waterfall.ts` (provider chain), `filters.ts` (industry/title/geo), `freeSources.ts` (zero-cost connectors).
- **Main exports / entry points:** `collect()` (end-to-end), `enrich()` (waterfall for a subject), `scoreSignal()` / `rankSignals()`, `catalog()` (public definitions), `classifyTitle()`.
- **Depends on:** `core` types, `signals/hiring` (job order + manager resolution), external APIs via providers (RapidAPI, Apify, Unipile).
- **Start here:** `integration/lib/signals/README.md`, then `index.ts`; deep-dive `collector.ts`.

### sourcing
- **Purpose:** "Upload a JD → get ranked candidate matches." Parses JDs to ICPs, generates Boolean/X-ray and LinkedIn searches, discovers candidates, scores them, stages results as a named SourcingRun, then promotes into Candidates.
- **Key files:** `index.ts` (barrel + planSourcing), `types.ts` (CandidateICP, SourcingQuery, CandidateRow, SourcingRun), `parseJobDescription.ts` (JD→ICP LLM), `generateQueries.ts`, `discovery.ts`, `score.ts`, `store.ts`, `promote.ts`.
- **Main exports / entry points:** `planSourcing()` (JD→ICP+queries), `runDiscovery()`, `saveSourcingRun()`, `promoteSourcingRun()`.
- **Depends on:** `signals` (enrichment on promote), `prospects` (addProspect), `core` types.
- **Start here:** `integration/lib/sourcing/index.ts`, then `types.ts` for the shape flow.

### linkedin
- **Purpose:** LinkedIn Engine — provider abstraction + Unipile implementation behind one `LinkedInProvider` interface (swap Unipile for HeyReach / SalesRobot / custom). Handles auth, account management, cadence execution, messaging, InMail, voice notes, rate limiting, reply classification.
- **Key files:** `provider.ts` (contract + Unipile/internal impl), `sequenceEngine.ts` (cadence orchestration), `types.ts` (LinkedInAccount, Prospect, Sequence, Enrollment), `rateLimiter.ts`, `auth.ts`, `classify.ts`, `personalize.ts`.
- **Main exports / entry points:** `getProvider()` (swap backend), sequenceEngine exports, `listMessages()` / `sendConnection()` / `sendMessage()` / `sendInMail()` / `sendVoiceNote()`.
- **Depends on:** `core` types, Unipile API (or internal bridge), external LLM for personalize/classify.
- **Start here:** `integration/lib/linkedin/provider.ts`, then `sequenceEngine.ts`.

### data
- **Purpose:** People-data warehouse — workspace-scoped table of DataRecords imported from licensed providers (ZoomInfo, etc.) held locally so lookups + enrichment happen without a live call every time. Supports CSV import or live API when configured.
- **Key files:** `index.ts` (barrel), `store.ts` (in-memory table, durable snapshot), `types.ts` (DataRecord), `import.ts` (CSV parsing), `enrich.ts` (backfill from warehouse), `providers/index.ts` (pluggable adapters).
- **Main exports / entry points:** `listRecords()` / `saveRecord()` / `upsertRecords()`, `rowsToInputs()` (CSV→input), `backfillFromWarehouse()` (free prospect lookup), `findRecordForPerson()` (dedup).
- **Depends on:** `db` (snapshot), `core/ids`.
- **Start here:** `integration/lib/data/types.ts`, then `store.ts`; see `enrich.ts` for backfill.

### db
- **Purpose:** Tiny, dependency-light durable persistence layer. Modules keep fast in-memory stores; this snapshots them (Postgres, file-based, or memory-only). Each module calls `loadSnapshot(key)` once on boot and `saveSnapshot(key, data)` after mutations.
- **Key files:** `index.ts` (mode selection, file/Postgres backend abstraction, loadSnapshot, saveSnapshot, debouncedSaver).
- **Main exports / entry points:** `loadSnapshot<T>(key)`, `saveSnapshot(key, data)`, `debouncedSaver(key, getData)`, `dbEnabled()`, `dbPing()`.
- **Depends on:** `pg` (Postgres), `fs`; no other lib/ modules depend on the backend choice.
- **Start here:** `integration/lib/db/index.ts` — top comment explains mode priority (Postgres > file > memory).
