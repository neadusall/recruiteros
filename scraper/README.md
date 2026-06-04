# LinkedIn scraper sidecar

A small internal FastAPI service that fronts the open-source Playwright
[`linkedin-scraper`](https://github.com/joeyism/linkedin_scraper). It's the
**alternative engine** behind the "Pull LinkedIn profiles" flow in the
Candidates / Prospects tabs — a free, cookie-authenticated path that sits next
to (not instead of) the Unipile API engine.

It is **not** exposed publicly. Caddy never routes to it; only the Next.js `app`
container reaches it over the internal Docker network at `http://scraper:8000`.

## Why a separate service?

The backend is TypeScript/Next.js. Playwright + Chromium is heavy and would bloat
the Node image and its deploys. Isolating it means the browser can crash and
restart on its own, and the scrape workload never blocks the web tier.

## Routes

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{ ok, cookieConfigured }` |
| `POST /scrape/profile` | `{ url, cookie? }` | `{ profile }` — one profile by `/in/` URL (reliable) |
| `POST /scrape/search` | `{ url, limit?, cookie? }` | `{ profiles, warnings }` — best-effort people-search pagination |

Every scrape route is gated by the `X-Scraper-Token` header (`SCRAPER_TOKEN`).

## Auth

A single LinkedIn **`li_at` session cookie**. The backend passes it per request
(it reads `LINKEDIN_LI_AT`); if omitted, the sidecar uses its own `LINKEDIN_LI_AT`.
Get the cookie from a logged-in browser: DevTools → Application → Cookies →
`https://www.linkedin.com` → copy the `li_at` value.

## Anti-block behavior (built in)

- **One** browser context + page; every scrape is **serialized** behind a global
  lock. No parallel tabs, ever.
- Randomized human jitter between actions, and a longer jittered pause **before
  toggling to the next search page** (`SCRAPER_PAGE_DELAY_MIN/MAX`).
- Per-hour and per-day caps (`SCRAPER_MAX_PER_HOUR` / `SCRAPER_MAX_PER_DAY`).
  Hitting a cap returns HTTP 429 with `Retry-After`; the backend backs off.
- Slow scroll-and-settle so lazy-loaded cards render like a real session.

## ⚠️ Best-effort caveat

The upstream library has **no people-search-list scraper** — only single profile
/ company / job scrapers. `POST /scrape/search` extracts cards from the live DOM,
which LinkedIn changes often (and Sales Navigator is virtualized). It returns
`warnings` when extraction is thin rather than silently returning nothing. For
reliable results, prefer single-profile `/in/` URLs (or the Unipile engine) for
list pulls.

## Config

| Env | Default | Purpose |
| --- | --- | --- |
| `LINKEDIN_LI_AT` | — | Fallback session cookie if the backend doesn't send one |
| `SCRAPER_TOKEN` | — | Shared secret required on scrape routes |
| `SCRAPER_HEADLESS` | `true` | Set `false` to watch the browser locally |
| `SCRAPER_MAX_PER_HOUR` | `40` | Scrape units / rolling hour |
| `SCRAPER_MAX_PER_DAY` | `150` | Scrape units / rolling day |
| `SCRAPER_PAGE_DELAY_MIN`/`MAX` | `5` / `11` | Seconds paused before next page |
| `SCRAPER_ACTION_DELAY_MIN`/`MAX` | `1.5` / `3.5` | Seconds between in-page actions |

## Run locally

```bash
cd scraper
pip install -r requirements.txt
python -m playwright install chromium
LINKEDIN_LI_AT=... SCRAPER_HEADLESS=false uvicorn app:app --port 8000
```
