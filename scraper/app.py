"""
RecruiterOS · LinkedIn scraper sidecar (FastAPI)

A tiny internal HTTP service that fronts the Playwright-based `linkedin-scraper`.
NOT exposed publicly — Caddy never routes to it; only the Next.js `app` container
reaches it on the internal Docker network (http://scraper:8000).

Routes
  GET  /health                      -> liveness + whether a cookie is configured
  POST /scrape/profile {url,cookie} -> one profile by /in/ URL (reliable)
  POST /scrape/search  {url,limit,cookie} -> best-effort people-search pagination

The `cookie` (li_at) is sent per request by the backend (which reads it from
LINKEDIN_LI_AT); if omitted, the sidecar falls back to its own LINKEDIN_LI_AT
env. A shared secret (SCRAPER_TOKEN) gates every scrape route so nothing on the
internal net can drive the browser but our app.
"""

import logging
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from engine import engine, RateLimited
from linkedin_scraper.core.exceptions import AuthenticationError

logging.basicConfig(level=os.getenv("SCRAPER_LOG_LEVEL", "INFO"))
logger = logging.getLogger("scraper.app")

app = FastAPI(title="RecruiterOS LinkedIn Scraper", version="1.0.0")

SCRAPER_TOKEN = os.getenv("SCRAPER_TOKEN", "")
ENV_COOKIE = os.getenv("LINKEDIN_LI_AT", "")


def _auth(token: str | None) -> None:
    """Gate scrape routes with the shared secret (skipped if none is set, e.g. dev)."""
    if SCRAPER_TOKEN and token != SCRAPER_TOKEN:
        raise HTTPException(status_code=401, detail="bad_token")


def _cookie(req_cookie: str | None) -> str:
    cookie = (req_cookie or ENV_COOKIE or "").strip()
    if not cookie:
        raise HTTPException(status_code=409, detail="no_cookie")
    return cookie


class ProfileReq(BaseModel):
    url: str
    cookie: str | None = None


class SearchReq(BaseModel):
    url: str
    limit: int = Field(default=100, ge=1, le=500)
    cookie: str | None = None


@app.get("/health")
async def health():
    return {"ok": True, "cookieConfigured": bool(ENV_COOKIE)}


@app.post("/scrape/profile")
async def scrape_profile(req: ProfileReq, x_scraper_token: str | None = Header(default=None)):
    _auth(x_scraper_token)
    cookie = _cookie(req.cookie)
    try:
        profile = await engine.scrape_profile(req.url, cookie)
        return {"profile": profile}
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e), headers={"Retry-After": str(int(e.retry_after))})
    except AuthenticationError as e:
        raise HTTPException(status_code=401, detail=f"auth_failed: {e}")
    except Exception as e:  # noqa: BLE001 - surface a clean 502 to the backend
        logger.exception("profile scrape failed")
        raise HTTPException(status_code=502, detail=f"scrape_failed: {e}")


@app.post("/scrape/search")
async def scrape_search(req: SearchReq, x_scraper_token: str | None = Header(default=None)):
    _auth(x_scraper_token)
    cookie = _cookie(req.cookie)
    try:
        result = await engine.scrape_search(req.url, req.limit, cookie)
        return result
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e), headers={"Retry-After": str(int(e.retry_after))})
    except AuthenticationError as e:
        raise HTTPException(status_code=401, detail=f"auth_failed: {e}")
    except Exception as e:  # noqa: BLE001
        logger.exception("search scrape failed")
        raise HTTPException(status_code=502, detail=f"scrape_failed: {e}")


@app.on_event("shutdown")
async def _shutdown():
    await engine.close()
