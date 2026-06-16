# 2026-06-16 — JD Sourcing discovery works + tool-wide connection persistence

Session summary. Everything below is on `main` (commits `c88b802` → `13407bd`).

---

## Headline: JD Sourcing now actually finds candidates

The tab could build a brief and a profile, but discovery returned **0 candidates
(scanned 0)** because the configured RapidAPI people-search listing didn't work.

**Diagnosis (tested each host live with the operator's key):**
| Listing | Host | Result |
|---|---|---|
| Linkedin Data Scraper API | `realtime-linkedin-fresh-data` | 404 — "Cannot POST /" (dead endpoint) |
| Realtime LinkedIn Data Scraper | `realtime-linkedin-data-scraper` | Turnstile CAPTCHA — unusable server-side |
| Real-Time LinkedIn Scraper API | `linkedin-data-api` | "no longer providing this service" (discontinued) |
| **Fresh LinkedIn Scraper API (SaleLeads)** | **`fresh-linkedin-scraper-api`** | ✅ **returns real profiles, no CAPTCHA** |

**The winner:** Fresh LinkedIn Scraper API by SaleLeads.
`GET /api/v1/search/people?name=<kw>&page=<n>&limit=10` → `{success, data:[{full_name,
title, location, url, ...}]}`. Server-side, free BASIC tier works for testing.

**Engine wiring** (`integration/lib/sourcing/discovery.ts`):
- GET path now supports a full `{query}`/`{page}` **template**, so any listing's own
  parameter names work (no double-append). Portal path: `/api/v1/search/people?name={query}&page={page}&limit=10`.
- Search term is **keyword-first** (role + company/geo), not a Google X-ray string.
- `mapRow` pulls the employer out of `Role @ Company` / `Role at Company` titles so the
  target-company signal still scores (Fresh embeds company in the title line).
- Response parsing (`data[]`, `full_name`/`title`/`location`/`url`) was already handled.

Portal catalog placeholders/steps updated to the Fresh listing (`lib/connected/index.ts`).

**Also fixed in the AI path:**
- **Lazy Anthropic client** (`lib/sourcing/anthropic.ts`): building the SDK at module
  load threw "Could not resolve authentication method" when the key was unset and froze
  it to the boot-time key. Now read per-call → clean error when unset, live pickup when saved.
- **Empty-profile fallback fixed**: the ICP extractor's token ceiling was too low, so its
  JSON truncated and fell back to an empty "Sourcing profile" (→ 0 searches). Raised the
  ceiling; the UI now warns instead of showing a silent wall of dashes.

---

## JD Sourcing — wide net by design

Per operator direction, loosened generation so a search actually returns people:
- **No company cap** — list all real peer/adjacent companies; the 40-item normalizer cap
  is now 200 (runaway guard only). Each company is its own search.
- **No deal-breakers by default** (they hard-zero a candidate); must-haves capped at ~3.
- **Remote is not a scoring factor** — dropped the +8 "remote" bonus; out-of-geo is never penalized.
- **Min fit default 10** (0 = show every profile found, nothing filtered).
- **Scan up to default 500**, and the input floor (was 100) removed — results are
  candidate-driven, never a minimum.

---

## JD Sourcing — UX

- **Visual 4-step tracker** (Build → Analyze → Find → Save) that lights the current step.
- **"How this works"** help section defining every step, setting, and button.
- **Min fit / Scan up to** explained as two separate plain-English lines + tooltips.
- "What sharpens the search" restyled as an obvious dropdown.
- **User-chosen enrich count** on saved lists (was a forced "top 50").

---

## Connections & persistence (tool-wide)

Operator reported previously-connected integrations (incl. the AI key) showing red after
redeploys. Two root causes, both fixed in `lib/connected/`:
1. **Orphaned creds** — auth/login churn can hand a session a different workspace id,
   orphaning saved creds under the old id. `recoverOrphanedCreds()` runs on
   `listIntegrations` and re-adopts them (single-operator only; no-op under white-label).
2. **Lazy env mirroring** — saved keys only reached `process.env` when the credentials
   module was first touched, so a tool reading the env directly failed right after a deploy.
   `instrumentation.register()` now calls `ensureCredsHydrated()` at boot, before any
   request — every saved connection is live across deploys.

---

## Other

- **Data**: Lume auto-seed host-gated to Lume portals only; unseed stray rows elsewhere
  (`lib/data/autoseed.ts`).
- **Dev tooling**: `npm run dev:fast` (`integration/dev.cjs`) — local preview that re-syncs
  `assets/` + root HTML on change and runs `next dev`, so changes show without a deploy.

---

## Open follow-ups

- **Deep-vet** for JD Sourcing — wire the Fresh listing's `Get User Profile` endpoint
  (profile-by-URL) into the Deep-vet config. Left blank for now.
- **Auto enrich + push** (operator greenlit, not yet built): a per-list "Auto" toggle that
  enriches the chosen top N and pushes them into the Candidates pipeline unattended.
- **Rotate the RapidAPI key** — it was exposed in screenshots during debugging.
