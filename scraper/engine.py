"""
RecruiterOS · LinkedIn scraper engine (sidecar)

Wraps the open-source `linkedin-scraper` (Playwright) behind a small, *safe*
async engine. The TypeScript backend never touches Playwright directly — it
calls the FastAPI routes in app.py, which call into here.

Anti-block discipline is the whole point of this module:

  • ONE browser context, ONE page. Every scrape is serialized behind a global
    lock — we never open parallel tabs and never hammer LinkedIn concurrently.
  • Human-like jitter between every action, and a much longer (also jittered)
    pause before paging to the next search page. Pages are loaded slowly with a
    scroll-and-settle so lazy content renders the way a real session would.
  • Per-hour and per-day caps (mirroring the app's rateLimiter.ts philosophy).
    When a cap is hit we raise RateLimited with a retry_after — the caller backs
    off, it never spins.
  • Auth is a single `li_at` session cookie (login_with_cookie). The session is
    reused across requests; we only re-auth when the cookie changes or LinkedIn
    drops us.

The people-search paginator is explicitly *best-effort*: the upstream library
has no people-list scraper, so we extract cards from the live DOM. LinkedIn's
markup changes often (and Sales Navigator is virtualized), so every result
carries warnings when extraction comes up thin rather than silently returning 0.
"""

import asyncio
import logging
import os
import random
import time
from collections import deque
from typing import Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from linkedin_scraper import BrowserManager, PersonScraper, login_with_cookie
from linkedin_scraper.core.exceptions import (
    AuthenticationError,
    RateLimitError,
)

logger = logging.getLogger("scraper.engine")


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, ""))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, ""))
    except (TypeError, ValueError):
        return default


# --- Tunables (env-overridable so ops can tighten without a rebuild) ----------
ACTION_DELAY_MIN = _f("SCRAPER_ACTION_DELAY_MIN", 1.5)   # between in-page actions
ACTION_DELAY_MAX = _f("SCRAPER_ACTION_DELAY_MAX", 3.5)
PAGE_DELAY_MIN = _f("SCRAPER_PAGE_DELAY_MIN", 5.0)       # before toggling next page
PAGE_DELAY_MAX = _f("SCRAPER_PAGE_DELAY_MAX", 11.0)
MAX_PER_HOUR = _i("SCRAPER_MAX_PER_HOUR", 40)            # scrape units / rolling hour
MAX_PER_DAY = _i("SCRAPER_MAX_PER_DAY", 150)             # scrape units / rolling day
HEADLESS = os.getenv("SCRAPER_HEADLESS", "true").lower() != "false"
USER_AGENT = os.getenv(
    "SCRAPER_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)


class RateLimited(Exception):
    """A local cap (per-hour/day) was hit. Carries seconds to back off."""

    def __init__(self, retry_after: float, scope: str):
        super().__init__(f"rate_limited ({scope}); retry after {retry_after:.0f}s")
        self.retry_after = retry_after
        self.scope = scope


async def _human_pause(lo: float, hi: float) -> None:
    await asyncio.sleep(random.uniform(lo, hi))


def _looks_like_profile_url(url: str) -> bool:
    return "linkedin.com/in/" in (url or "")


def _with_page_param(url: str, page: int) -> str:
    """Return `url` with its `page` query param set — how both LinkedIn search
    and Sales Navigator advance result pages."""
    parts = urlparse(url)
    q = parse_qs(parts.query)
    q["page"] = [str(page)]
    flat = urlencode({k: v[-1] for k, v in q.items()})
    return urlunparse(parts._replace(query=flat))


class ScraperEngine:
    """Singleton-style engine: one browser, one page, serialized access."""

    def __init__(self) -> None:
        self._browser: Optional[BrowserManager] = None
        self._lock = asyncio.Lock()           # serialize ALL scraping
        self._cookie: Optional[str] = None    # li_at currently authenticated with
        self._hits: deque[float] = deque()    # timestamps of recent scrape units

    # -- lifecycle -------------------------------------------------------------
    async def _ensure_browser(self, cookie: str) -> None:
        """Start the browser + authenticate if needed. Re-auths when the cookie
        rotates or the session was lost."""
        if self._browser is not None and self._cookie == cookie:
            return
        if self._browser is not None:
            # cookie changed — tear down the old authenticated context.
            await self.close()
        logger.info("Launching browser (headless=%s)", HEADLESS)
        bm = BrowserManager(headless=HEADLESS, user_agent=USER_AGENT)
        await bm.start()
        await login_with_cookie(bm.page, cookie)
        self._browser = bm
        self._cookie = cookie

    async def close(self) -> None:
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception as e:  # pragma: no cover - best effort teardown
                logger.warning("Error closing browser: %s", e)
        self._browser = None
        self._cookie = None

    # -- rate limiting ---------------------------------------------------------
    def _check_caps(self, units: int = 1) -> None:
        now = time.time()
        while self._hits and now - self._hits[0] > 86400:
            self._hits.popleft()
        in_hour = sum(1 for t in self._hits if now - t <= 3600)
        in_day = len(self._hits)
        if in_hour + units > MAX_PER_HOUR:
            oldest_in_hour = next(t for t in self._hits if now - t <= 3600)
            raise RateLimited(3600 - (now - oldest_in_hour), "hour")
        if in_day + units > MAX_PER_DAY:
            raise RateLimited(86400 - (now - self._hits[0]), "day")

    def _record(self, units: int = 1) -> None:
        now = time.time()
        for _ in range(units):
            self._hits.append(now)

    # -- public API ------------------------------------------------------------
    async def scrape_profile(self, url: str, cookie: str) -> dict:
        """Scrape ONE profile by /in/ URL. Reliable path."""
        async with self._lock:
            self._check_caps(1)
            await self._ensure_browser(cookie)
            assert self._browser is not None
            try:
                scraper = PersonScraper(self._browser.page)
                person = await scraper.scrape(url)
            except RateLimitError as e:
                raise RateLimited(900, "linkedin") from e
            self._record(1)
            await _human_pause(ACTION_DELAY_MIN, ACTION_DELAY_MAX)
            return _profile_from_person(person, url)

    async def scrape_search(self, url: str, limit: int, cookie: str) -> dict:
        """Best-effort: page through a people-search URL collecting cards.

        Returns {"profiles": [...], "warnings": [...]}. Each search *page* counts
        as one rate-limit unit. Stops at `limit`, at the last page, or when a page
        yields nothing new (two empty pages in a row = done)."""
        async with self._lock:
            await self._ensure_browser(cookie)
            assert self._browser is not None
            page = self._browser.page

            profiles: list[dict] = []
            warnings: list[str] = []
            seen: set[str] = set()
            sales_nav = "/sales/" in url
            if sales_nav:
                warnings.append(
                    "Sales Navigator list is virtualized; extraction is best-effort "
                    "and may yield lead URLs rather than public /in/ URLs."
                )

            empty_streak = 0
            page_no = 1
            # LinkedIn shows ~10/page (search) / ~25 (sales nav). Cap page count so
            # a huge limit can't run away; each page is a rate-limit unit.
            max_pages = max(1, min(40, -(-limit // (25 if sales_nav else 10)) + 1))

            while len(profiles) < limit and page_no <= max_pages and empty_streak < 2:
                # One rate-limit unit per page; bail cleanly if a cap is hit.
                try:
                    self._check_caps(1)
                except RateLimited:
                    if profiles:
                        warnings.append("Stopped early: local rate cap reached.")
                        break
                    raise

                target = _with_page_param(url, page_no)
                try:
                    await page.goto(target, wait_until="domcontentloaded", timeout=60000)
                except Exception as e:
                    warnings.append(f"page {page_no} failed to load: {e}")
                    break

                # Let the SPA settle, then scroll so lazy cards render.
                await _human_pause(ACTION_DELAY_MIN, ACTION_DELAY_MAX)
                await _slow_scroll(page)
                self._record(1)

                try:
                    cards = await page.evaluate(_EXTRACT_JS, sales_nav)
                except Exception as e:
                    warnings.append(f"page {page_no} extraction error: {e}")
                    cards = []

                new_this_page = 0
                for c in cards:
                    key = (c.get("profileUrl") or c.get("name") or "").strip().lower()
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    profiles.append(c)
                    new_this_page += 1
                    if len(profiles) >= limit:
                        break

                empty_streak = empty_streak + 1 if new_this_page == 0 else 0
                page_no += 1

                # Long, human-like pause BEFORE toggling to the next page.
                if len(profiles) < limit and page_no <= max_pages:
                    await _human_pause(PAGE_DELAY_MIN, PAGE_DELAY_MAX)

            if not profiles:
                warnings.append(
                    "No profiles extracted — LinkedIn markup may have changed, the "
                    "URL may not be a people search, or the session lacks access."
                )
            return {"profiles": profiles[:limit], "warnings": warnings}


def _profile_from_person(person, url: str) -> dict:
    """Map the library's Person model onto our SearchProfile-ish shape."""
    name = (getattr(person, "name", None) or "").strip()
    parts = name.split()
    emails = [c.value for c in getattr(person, "contacts", []) or [] if getattr(c, "type", "") == "email"]
    phones = [c.value for c in getattr(person, "contacts", []) or [] if getattr(c, "type", "") == "phone"]
    return {
        "name": name or None,
        "firstName": parts[0] if parts else None,
        "lastName": parts[-1] if len(parts) > 1 else None,
        "headline": getattr(person, "about", None),
        "title": person.job_title,
        "company": person.company,
        "location": getattr(person, "location", None),
        "profileUrl": getattr(person, "linkedin_url", None) or url,
        "imageUrl": None,
        "email": emails[0] if emails else None,
        "phone": phones[0] if phones else None,
    }


async def _slow_scroll(page) -> None:
    """Scroll the page in steps with pauses so lazy-loaded cards render — the way
    a human scanning results would, not an instant jump to the bottom."""
    try:
        for _ in range(5):
            await page.mouse.wheel(0, random.randint(600, 1100))
            await asyncio.sleep(random.uniform(0.6, 1.4))
    except Exception:
        pass


# Runs in the page context. `salesNav` toggles the selector strategy. Returns a
# plain array of {name, title, company, location, profileUrl, imageUrl}. Kept
# defensive: missing fields come back null rather than throwing.
_EXTRACT_JS = """
(salesNav) => {
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : null);
  const out = [];
  if (salesNav) {
    const rows = document.querySelectorAll('[data-anonymize="person-name"]');
    rows.forEach((nameEl) => {
      const card = nameEl.closest('li') || nameEl.closest('tr') || nameEl.parentElement;
      const link = card ? card.querySelector('a[href*="/sales/lead/"], a[href*="/in/"]') : null;
      const img = card ? card.querySelector('img') : null;
      out.push({
        name: txt(nameEl),
        title: txt(card && card.querySelector('[data-anonymize="title"]')),
        company: txt(card && card.querySelector('[data-anonymize="company-name"]')),
        location: txt(card && card.querySelector('[data-anonymize="location"]')),
        profileUrl: link ? link.href.split('?')[0] : null,
        imageUrl: img ? (img.src || null) : null,
      });
    });
  } else {
    const seen = new Set();
    document.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      const href = a.href.split('?')[0];
      if (!/\\/in\\//.test(href) || seen.has(href)) return;
      const card = a.closest('li') || a.closest('div');
      const name = txt(a.querySelector('span[aria-hidden="true"]')) || txt(a);
      if (!name || name.length > 80) return;  // skip nav/utility links
      seen.add(href);
      const img = card ? card.querySelector('img') : null;
      // Heuristic: the subtitle line under the name carries title/company.
      const subtitle = card ? card.querySelector('.entity-result__primary-subtitle, .t-14.t-black.t-normal') : null;
      const loc = card ? card.querySelector('.entity-result__secondary-subtitle, .t-14.t-normal') : null;
      out.push({
        name,
        title: txt(subtitle),
        company: null,
        location: txt(loc),
        profileUrl: href,
        imageUrl: img ? (img.src || null) : null,
      });
    });
  }
  return out;
}
"""


# Module-level singleton the FastAPI app shares.
engine = ScraperEngine()
