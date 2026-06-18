# `lib/sourcing` — JD Sourcing engine

Upload a JD → get a ranked list of likely-fit candidates → enrich/vet → push to Candidates.
This is the map of the domain. **Start at [`index.ts`](./index.ts)** (the barrel) to see every export.

## The flow (and which file owns each step)

```
JD text
  │  draftJd.ts ............. (optional) build/strengthen a sourcing brief from title+company+notes
  ▼
parseJobDescription.ts ..... JD → CandidateICP (titles, geos, companies, must-haves)   [LLM]
  │  refineSearch.ts ........ "dive deeper": edit the ICP from a natural-language instruction [LLM]
  ▼
generateQueries.ts ......... ICP → runnable people-searches (one per company + broad geo/industry)
  ▼
discovery.ts ............... run the searches against the RapidAPI listing → candidate rows
  │  score.ts .............. rule-based fit score (title/seniority/company/geo/must-have)
  │  seen.ts ............... cross-run memory so "fresh only" skips already-surfaced people
  │  rerank.ts ............. (optional) LLM re-rank of the shortlist                       [LLM]
  ▼
store.ts ................... save the run under a name (durable via lib/db)
  │  deepVet.ts ............ deep-vet top N: verified score + verdict (Message Batch, sync fallback) [LLM]
  │    vetParse.ts ......... pure parser: model response → VetResult
  │    profile.ts .......... fetch full work history the deep-vet reads
  │  laxis.ts .............. first-pass contact enrichment via the Laxis browser worker (../../../laxis-worker)
  │  cache.ts .............. shared people cache (profile + contact) so paid lookups are reused
  │    cacheKeys.ts ........ pure key + freshness helpers (no runtime imports — eval-safe)
  ▼
promote.ts ................. push the saved run into the Candidates (Prospects) pipeline
```

## Files at a glance

| File | What it owns |
|---|---|
| `index.ts` | Barrel — every public export + `planSourcing()` (parse + generate in one call). |
| `types.ts` | Shared types: `CandidateICP`, `CandidateRow`, `SourcingQuery`, `SourcingRun`. |
| `anthropic.ts` | Lazy Anthropic client for all LLM stages (key read per-call). |
| `draftJd.ts` | Build/strengthen a sourcing-ready JD brief. *(LLM)* |
| `parseJobDescription.ts` | JD → structured `CandidateICP`. *(LLM)* |
| `refineSearch.ts` | Natural-language refinement of the ICP. *(LLM)* |
| `generateQueries.ts` | `CandidateICP` → searches (templated GET path supported). |
| `discovery.ts` | Discovery orchestrator + the RapidAPI people-search transport. |
| `score.ts` | Rule-based fit scoring against the ICP. |
| `rerank.ts` | Optional LLM re-rank of the shortlist. *(LLM)* |
| `seen.ts` | Per-workspace "already surfaced" keys (fresh-only runs). |
| `deepVet.ts` | Deep-vet via Anthropic Message Batches (50% cheaper) + sync fallback. *(LLM)* |
| `vetParse.ts` | Pure parser: deep-vet response → `VetResult`. |
| `profile.ts` | Full-profile fetch for the deep-vet. |
| `laxis.ts` | Laxis browser-worker enrichment client (submit/poll/merge CSV). |
| `cache.ts` | Shared profile + contact cache (reuse paid lookups across runs). |
| `cacheKeys.ts` | Pure cache-key + freshness helpers (no imports — eval-safe). |
| `store.ts` | Saved-run staging store (durable via `lib/db`). |
| `promote.ts` | Promote a saved run into Candidates/Prospects. |

## Where it's wired
- **API:** [`integration/app/api/sourcing/route.ts`](../../app/api/sourcing/route.ts) — actions `plan / draft / refine / run / rerank / save / promote / enrich / vet / vetStatus / laxisEnrich / laxisStatus / delete`.
- **UI:** `assets/js/command.js` → `renderJdSourcing()` (search by that name).
- **Connection:** Setup → Connected → "JD Sourcing (RapidAPI people search)". Provider = **Fresh LinkedIn Scraper API (SaleLeads)**, `GET /api/v1/search/people?name={query}&page={page}&limit=10`.
