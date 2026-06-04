# JD → 1,000 prospects — design & the most affordable stack

Upload a job description → get ~1,000 ranked, likely-fit prospects. This is mostly
an **orchestration layer over engine you already have**; the new parts are marked ★.

```
 JD upload
   │  ★ parseJobDescription()        LLM (Haiku) → structured ICP
   ▼
 ICP  { titles[], seniority, geos[], industries[], target_companies[], must/nice/dq }
   │  ★ generateQueries(ICP)         ICP → LinkedIn search URLs + Google X-ray strings
   ▼
 Search queries  (dozens)
   │  importFromLinkedInSearch()     EXISTING — discovery → Prospects (dedupe by URL)
   ▼
 Raw prospects  (over-pull ~1,500)
   │  ★ scoreFit(prospect, ICP)      rule-based (free) + LLM only on the top slice
   ▼
 Top 1,000 ranked
   │  enrichProspect()               EXISTING — cheapest-first email/phone, ON DEMAND
   ▼
 CSV export
```

---

## What's new vs reused

| Component | Status | Notes |
| --- | --- | --- |
| JD parser → ICP | ★ new | One LLM call. Reuses `anthropic()` client. |
| ICP → query generator | ★ new | Pure logic + optional LLM company-list expansion. |
| Orchestration loop | ★ new | Fan out queries, collect, dedupe, cap. |
| Fit scoring | ★ new | Rule-based bulk + LLM top-slice. |
| Discovery (search → prospects) | ✅ reuse | `importFromLinkedInSearch` |
| Dedupe by LinkedIn URL | ✅ reuse | built into the import |
| Contact enrichment | ✅ reuse | `enrichProspect` + cheapest-first waterfall |
| Prospect storage | ✅ reuse | `addProspect` / core repository |

---

## The most affordable way (cost per job, for ~1,000 prospects)

The trick to keeping it cheap is **separating the three cost layers** and only paying
for the expensive one on the people you actually pursue.

### 1. JD parsing — effectively free
One LLM call per JD. A JD is a few thousand tokens. On **Claude Haiku** that's
**~$0.001–0.005 per job**. Negligible. Do not use a frontier model here.

### 2. Discovery (name / title / company / location / LinkedIn URL) — the scale layer
Three options, cheapest → safest:

| Source | Cost / 1,000 | Speed | Trade-off |
| --- | --- | --- | --- |
| **Scraper sidecar** (your `li_at`) | **$0** | ~7 days (150/day cap) | ToS risk on your account; slow |
| **RapidAPI LinkedIn-search** | **~$0.20–$2** | minutes | unverified/variable data; already wired transport |
| Premium people-API (PDL / Apollo) | ~$10–$100 | minutes | cleaner data, real cost |

**Recommendation:** RapidAPI search for scale (it's the cheapest *fast* path and the
[transport already exists](integration/lib/signals/rapidapi.ts)), with the free scraper
as a $0 fallback for low volume. Treat RapidAPI data as modest-confidence (the repo
already does) and let the fit-score + enrichment verification catch bad rows.

### 3. Fit scoring — keep it mostly free
- **Rule-based score for all ~1,500 raw** (title match, geo, target-company, seniority
  keywords): **$0**, instant.
- **LLM re-score only the top ~150** for nuance: Haiku, **~$0.10–0.50 per job**.

### 4. Contact enrichment — on demand, never the whole 1,000 upfront
This is the classic cost trap. With the cheapest-first waterfall at **$0.004–0.02/hit**:
- Enrich only the slice you'll actually contact (say top 200) → **~$1–4**.
- Enriching all 1,000 anyway is still only **~$4–20** — but do it on demand, by selection.

### Bottom line per job

| Scenario | Discovery | Score | Contacts | **Total / job** |
| --- | --- | --- | --- | --- |
| **Cheapest** (scraper, rule-score, enrich top 200) | $0 | $0 | ~$2 | **~$2 + time** |
| **Recommended** (RapidAPI, hybrid score, enrich top 200) | ~$1 | ~$0.30 | ~$2 | **~$3–5** |
| All-in (RapidAPI, enrich all 1,000) | ~$1 | ~$0.30 | ~$15 | **~$16** |

So **~$3–5 per job** for 1,000 ranked prospects with contacts on the top slice. The
only fixed cost is a RapidAPI subscription (often a low monthly minimum) + your existing
Anthropic key.

---

## ⚠️ Honest caveats

1. **1,000 may exceed the real qualified universe** for a senior, narrow role (a VP
   Sales East-Coast S2P role realistically has a few hundred true fits, not 1,000).
   Forcing the number widens the net and dilutes fit. **Better default:** generate all
   who clear a fit threshold, *capped* at 1,000 — and report the honest count. For broad
   IC roles (e.g. "Enterprise AE"), 1,000 is realistic.
2. **Marketplace (RapidAPI) data is unverified and listings come and go** — the repo
   already flags this. Modest confidence + a verification step before outreach trusts it.
3. **Scraping uses your own LinkedIn session** — ToS risk sits on your account. The caps
   exist for a reason; keep them.
4. **Scoring is a model's opinion, not ground truth.** Keep a human in the loop on the
   top slice before any outreach.

---

## Build order (each phase independently useful)

1. **`parseJobDescription(jd) → ICP`** — LLM call, no external accounts. *Build first.*
2. **`generateQueries(ICP) → searchUrls[]`** — feeds the existing import. *Build first.*
3. **Orchestrator** — loop queries → `importFromLinkedInSearch` → dedupe → cap.
4. **`scoreFit` (rule-based)** then optional LLM top-slice.
5. **Upload UI** + **CSV export**.

Phases 1–2 need only the Anthropic key you already have, and they immediately make the
manual runbook automatic. Discovery source (Phase 3) is the one decision that sets cost
and risk.
