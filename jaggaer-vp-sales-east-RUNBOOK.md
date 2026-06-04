# Runbook — sourcing the JAGGAER VP Sales (East) shortlist

A repeatable process to turn the target list in
[`jaggaer-vp-sales-east-sourcing.csv`](jaggaer-vp-sales-east-sourcing.csv) into a
CSV of ~100 real, contactable people. Every step maps to code that already exists
in this repo.

```
  Searches ──► /in/ profile URLs ──► Prospects ──► (filter) ──► enrich ──► export CSV
   (CSV)         (collect)          importFromLinkedInSearch   enrichProspect
```

---

## Phase 0 — Pick the engine (one decision)

| | `unipile` (default) | `scraper` (sidecar) |
| --- | --- | --- |
| Auth | connected LinkedIn account (API keys) | your `li_at` cookie |
| Cost | per Unipile plan | free |
| List pulls | reliable | **best-effort** (prefer single `/in/` URLs) |
| Rate caps | per provider | 40/hr, 150/day (HTTP 429 + Retry-After) |
| Risk | low | your LinkedIn account (ToS) |

- Need **100 in one shot, reliably** → use `unipile` with a Sales Navigator search URL.
- Free / no Unipile keys → use `scraper`, but feed it **individual `/in/` URLs**, not a list URL.

> Compliance note: the `scraper` path drives *your own* logged-in session. Respect
> LinkedIn's ToS and the built-in caps. Keep `li_at` in `LINKEDIN_LI_AT` only; never commit it.

---

## Phase 1 — Build the candidate URL list

Goal: a deduped list of LinkedIn `/in/` profile URLs that match the ICP
(East-Coast VP/RVP/Area-VP enterprise sellers from procurement / S2P / spend / supply-chain / office-of-CFO SaaS).

1. Open the sourcing CSV. For each row, run **either**:
   - the `google_xray_query` in Google (fastest way to harvest public `/in/` URLs), **or**
   - the `linkedin_people_search_url` inside LinkedIn / Sales Navigator.
2. Apply these filters every time (this is the ICP gate):
   - **Title:** VP Sales / Regional VP / Area VP / RVP / Enterprise Sales Director (must currently **manage a team**, not an individual AE).
   - **Geography:** East Coast metro (NY, Boston, DC, Atlanta, Philly, Charlotte, Miami, NJ, NC).
   - **Domain:** procurement / S2P / spend / supply-chain / fintech / office-of-CFO enterprise SaaS.
   - **Seniority signal:** 8+ yrs enterprise SaaS sales, prior quota-carrying *then* leadership.
3. Collect the `/in/` URLs into a file, one per line. Aim for ~150 raw to net ~100 after dedupe/filter.

> Tip: paginate Google with `&start=10`, `&start=20`… per query to go past page 1.
> Tier-1 companies (Coupa, Ivalua, GEP, Ariba, Zycus) should fill the first ~40 slots —
> they are the closest match and worth the most outreach effort.

---

## Phase 2 — Discovery: URLs → Prospects

This calls [`importFromLinkedInSearch`](integration/lib/linkedin/searchImport.ts#L160).
It dedupes by LinkedIn URL, so re-running only adds what's new.

**Option A — one list URL (Unipile):**
```ts
import { importFromLinkedInSearch } from "integration/lib/linkedin/searchImport";

await importFromLinkedInSearch(workspaceId, ownerUserId, {
  url: "<paste Sales Navigator search URL>",
  campaignId: "jaggaer-vp-sales-east",
  category: "jaggaer-vp-east",     // ICP bucket stamped on each prospect
  motion: "recruiting",
  engine: "unipile",
  limit: 100,                       // max 500
});
```

**Option B — many `/in/` URLs (scraper, reliable path):**
```ts
for (const url of profileUrls) {           // your Phase-1 list, one /in/ per line
  await importFromLinkedInSearch(workspaceId, ownerUserId, {
    url,                                    // a single /in/ URL scrapes that one person
    campaignId: "jaggaer-vp-sales-east",
    category: "jaggaer-vp-east",
    motion: "recruiting",
    engine: "scraper",
    limit: 1,
  });
  // respect caps: on ScraperError status 429, sleep Retry-After seconds, then continue
}
```

After this phase you have N Prospects, each with: full name, title/headline,
company, location, LinkedIn URL — and **no contact info yet** (by design).

---

## Phase 3 — Filter & rank to the top 100

Discovery over-pulls. Tighten to the best 100 before you spend on enrichment:

- Drop anyone whose current title is an individual contributor (no team).
- Drop wrong geography / wrong domain that slipped through keyword matches.
- Rank by fit. Suggested score (0–100):
  - +40 Tier-1 S2P competitor (Coupa/Ivalua/GEP/Ariba/Zycus)
  - +25 sells to CFO/CPO today
  - +15 currently a 2nd-line leader (manages managers/AEs)
  - +10 East-Coast metro match
  - +10 vertical match (Mfg / Public Sector / Higher Ed / Life Sci / FinServ)
- Keep the top 100 by score; park the rest as bench.

---

## Phase 4 — Enrichment: get the contact info

Only now do you spend. Per prospect, call
[`enrichProspect`](integration/lib/prospects/index.ts#L144) — it resolves the real
person if needed, then runs the cheapest-first waterfall for email, then phone:

```ts
import { enrichProspect } from "integration/lib/prospects";

for (const id of top100ProspectIds) {
  await enrichProspect(workspaceId, id);          // both email + phone
  // or target one field: enrichProspect(workspaceId, id, "email")
}
```

Cheapest providers run first and the waterfall stops at the first confident hit, so
you never pay a premium vendor for data a free one already had. Misses leave the
field blank for a manual retry — they don't fabricate.

---

## Phase 5 — Export the CSV

The prospects now hold everything. Export the campaign's prospects to CSV with the
columns you want, e.g.:

```
full_name, title, company, location, linkedin_url, email, phone, fit_score, tier, source_company
```

If there's no export button yet, it's a thin add: read the prospects for
`campaignId = "jaggaer-vp-sales-east"` from the core repository and write rows. I can
wire that endpoint/script for you on request.

---

## Phase 6 — Operate it (cadence & guardrails)

- **Throughput:** scraper caps = 40/hr, 150/day → a 100-person pull spans a few hours.
  Run Phase 2 in batches; the 429 backoff handles pacing.
- **Idempotent:** dedupe-by-URL means you can safely re-run any phase; only net-new is added.
- **Spend discipline:** discovery is free; enrichment costs credits — that's why it's a
  separate, on-demand phase against only the top 100.
- **Refresh:** re-run Phase 1–2 monthly to catch job-changers; the dedupe keeps it clean.
- **Secrets:** `LINKEDIN_LI_AT`, `SCRAPER_TOKEN`, and any enrichment API keys live in env
  only.

---

## Quick checklist

- [ ] Engine chosen (unipile vs scraper)
- [ ] Phase 1: ~150 `/in/` URLs harvested from the sourcing CSV queries
- [ ] Phase 2: imported as Prospects under campaign `jaggaer-vp-sales-east`
- [ ] Phase 3: filtered + scored to top 100
- [ ] Phase 4: enriched email/phone on the top 100
- [ ] Phase 5: exported to CSV
- [ ] Caps & ToS respected throughout
