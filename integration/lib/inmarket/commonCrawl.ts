/**
 * RecruitersOS · In-Market · Common Crawl team-page miner (free, UNBLOCKABLE naming source)
 *
 * Search engines block live scraping. Common Crawl doesn't have to be scraped — it's a free, public
 * ARCHIVE of the already-crawled web on AWS S3. We look a company's team / about / leadership pages
 * up in the CC URL index, pull the STORED HTML by byte range (HTTP 206), and parse it for
 * decision-maker names — never touching the live site, so there is nothing to block or rate-limit.
 * This is the free-at-scale naming floor: it even works for Cloudflare-protected sites (CC captured
 * them when its own crawler had access), which our live fetch can't reach.
 *
 * STRONG + SUSTAINABLE — failsafes so it keeps producing under load and never stalls the engine:
 *   • every request is timed out and try/caught — any failure returns [] (this module NEVER throws);
 *   • results are cached per domain (positive 30d / negative 7d) so we hit CC at most once per
 *     company per month, keeping us polite at pool scale;
 *   • a rolling failure CIRCUIT-BREAKER rests the whole source for 5 min if CC goes unreachable, so
 *     a CC outage degrades gracefully (the other free sources carry) instead of wedging curation;
 *   • bounded paths / records / body size so one company can never fan out unbounded;
 *   • collection fallback (tries the two most-recent crawls) for coverage.
 */

import { gunzipSync } from "zlib";

const UA = "RecruitersOS/1.0 (+https://recruiteros.app; archive research)";
const IDX = "https://index.commoncrawl.org";
const DATA = "https://data.commoncrawl.org";
const IDX_TIMEOUT_MS = 12_000;
const WARC_TIMEOUT_MS = 15_000;
const MAX_BODY = 700_000;          // cap parsed HTML per page
const MAX_RECORD_BYTES = 5_000_000; // never Range-fetch a pathological record
const MAX_PAGES = 3;               // team pages pulled per company
const CACHE_MAX = 20_000;
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* Reputation governor for the hosted INDEX server (index.commoncrawl.org).
 * The WARC data host (data.commoncrawl.org → S3) is robust and indifferent to client/IP; the index
 * server is fragile and per-IP rate-limited — measured (June 2026): it 503s/timeouts after a handful
 * of requests even sequentially, and fails ~100% at concurrency ≥4. So EVERY index request funnels
 * through one paced, single-flight, adaptive governor — independent of how many researches the worker
 * runs in parallel. We deliberately sit well below the ceiling to never red-flag this box's IP. */
const clampInt = (v: string | undefined, def: number, lo: number, hi: number): number =>
  Math.min(Math.max(Number.isFinite(Number(v)) && v ? Math.round(Number(v)) : def, lo), hi);
const IDX_CONCURRENCY = clampInt(process.env.CC_INDEX_CONCURRENCY, 1, 1, 3);     // hard cap (1 = serialized)
const IDX_MIN_INTERVAL_MS = clampInt(process.env.CC_INDEX_MIN_INTERVAL_MS, 7_500, 500, 30_000); // pacing floor — ~1 index hit / 7.5s, deliberately ~15-20% UNDER the rate where the index starts tripping the breaker (observed ~6s). Headroom keeps the IP clean with ZERO rest-downtime. Slow & steady beats fast & resting. Override with CC_INDEX_MIN_INTERVAL_MS.
const IDX_MAX_INTERVAL_MS = clampInt(process.env.CC_INDEX_MAX_INTERVAL_MS, 30_000, 2_000, 120_000); // adaptive ceiling
const IDX_MAX_COOLDOWN_MS = 60_000;  // cap on a single Retry-After / throttle pause

// Team-roster path prefixes, best-first (rosters before the company-story "about").
const PATHS = ["team", "leadership", "our-team", "about-us", "about", "people", "company/team"];
// Strict team-page matcher applied to index hits, so a prefix like "/team" can't pull "/team-parker".
const TEAM_RE = /\/(about|about-us|team|leadership|our-team|people|management|who-we-are|meet-the-team|staff|company\/team)(\/|\?|#|$)/i;

/* ------------------------------------------------------------------ */
/* State: collection list, per-domain cache, failure circuit-breaker   */
/* ------------------------------------------------------------------ */

let collections: { at: number; ids: string[] } = { at: 0, ids: [] };
const domainCache = new Map<string, { at: number; pages: string[] }>();

let recentFails = 0;
let breakerUntil = 0;
let breakerTrips = 0;            // consecutive trips → escalating rest (a persistently angry IP rests longer)
function note(ok: boolean): void {
  if (ok) { recentFails = 0; breakerTrips = Math.max(0, breakerTrips - 1); return; }
  if (++recentFails >= 8) {
    breakerTrips++;
    const rest = Math.min(30 * 60 * 1000, 5 * 60 * 1000 * breakerTrips); // 5,10,15…min, capped at 30
    breakerUntil = Date.now() + rest;
    recentFails = 0;
  }
}
function breakerOpen(): boolean { return Date.now() < breakerUntil; }

/* ------------------------------------------------------------------ */
/* Index governor: single-flight, paced, adaptive, Retry-After aware   */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let idxInterval = IDX_MIN_INTERVAL_MS; // adaptive spacing: grows on throttle, relaxes on clean success
let idxCooldownUntil = 0;              // global pause (honors Retry-After) — nothing hits the index until then
let nextSlot = 0;                      // earliest epoch ms the next request may START (reserved atomically)
let jitterSeed = 0;                    // tiny deterministic spread so requests don't lock-step
let inFlight = 0;                      // live in-flight index requests (observability)

// Counting semaphore with DIRECT hand-off: release passes the permit straight to the next waiter and
// never increments while one is queued, so the in-flight cap can't be over-subscribed (the bug the old
// `idxActive++`-after-await had). Default IDX_CONCURRENCY = 1 → strictly one index request at a time.
let permits = IDX_CONCURRENCY;
const permitQueue: Array<() => void> = [];
function acquirePermit(): Promise<void> {
  if (permits > 0) { permits--; return Promise.resolve(); }
  return new Promise<void>((res) => permitQueue.push(res));
}
function releasePermit(): void {
  const next = permitQueue.shift();
  if (next) next(); else permits++;
}

/** Reserve the next paced start time. SYNCHRONOUS — no await, so it's atomic under JS's single thread:
 *  concurrent callers get sequential, non-overlapping slots ≥ idxInterval apart. Honors the adaptive
 *  interval AND the global cooldown, so spacing can never be raced past. */
function claimSlot(): number {
  const start = Math.max(Date.now(), nextSlot, idxCooldownUntil);
  jitterSeed = (jitterSeed + 137) % 400;             // 0–399ms spread, no Math.random
  nextSlot = start + idxInterval + jitterSeed;
  return start;
}
/** Back off after a 503/429: widen spacing, set a global cooldown (Retry-After if given), feed the breaker. */
function onThrottle(retryAfter: string | null): void {
  idxInterval = Math.min(IDX_MAX_INTERVAL_MS, Math.round(idxInterval * 1.8) + 500);
  const ra = Number(retryAfter);
  const cd = Number.isFinite(ra) && ra > 0 ? ra * 1000 : idxInterval;
  idxCooldownUntil = Math.max(idxCooldownUntil, Date.now() + Math.min(cd, IDX_MAX_COOLDOWN_MS));
  note(false);
}
/** Record a non-throttle index outcome: relax pacing toward the floor on success; feed the breaker. */
function onIdxResult(serverResponded: boolean): void {
  if (serverResponded) idxInterval = Math.max(IDX_MIN_INTERVAL_MS, Math.round(idxInterval * 0.9));
  note(serverResponded);
}

/** Liveness for the engine-health surface (so a CC outage is visible, not silent). */
export function commonCrawlHealth(): {
  resting: boolean; restingForSec: number; collections: string[]; cachedDomains: number;
  /** Live governor telemetry — wire these into your monitor/thresholds (see below). */
  index: { spacingMs: number; concurrency: number; inFlight: number; cooldownForSec: number; breakerTrips: number };
} {
  const nowMs = Date.now();
  return {
    resting: breakerOpen(),
    restingForSec: breakerOpen() ? Math.round((breakerUntil - nowMs) / 1000) : 0,
    collections: collections.ids.slice(),
    cachedDomains: domainCache.size,
    index: {
      spacingMs: idxInterval,                                                  // current adaptive spacing
      concurrency: IDX_CONCURRENCY,                                            // hard in-flight cap
      inFlight,
      cooldownForSec: idxCooldownUntil > nowMs ? Math.round((idxCooldownUntil - nowMs) / 1000) : 0,
      breakerTrips,                                                            // escalation level (0 = healthy)
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fetch helpers (timed out, never throw)                              */
/* ------------------------------------------------------------------ */

/** The ONLY way to touch the index server: governed (paced, single-flight, adaptive, breaker-aware).
 *  Records throttle/health centrally so callers just read the body — they no longer call note(). */
async function idxFetch(url: string): Promise<Response | null> {
  if (breakerOpen()) return null;               // resting — don't pile on a hurting IP
  await acquirePermit();                         // at most IDX_CONCURRENCY in flight (default 1)
  try {
    const wait = claimSlot() - Date.now();       // race-free paced start (≥ idxInterval since the last)
    if (wait > 0) await sleep(wait);
    inFlight++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(IDX_TIMEOUT_MS) });
      if (res.status === 503 || res.status === 429) { onThrottle(res.headers.get("retry-after")); return res; }
      onIdxResult(true);                         // any HTTP reply (200/404/…) means the server is up
      return res;
    } catch {
      onIdxResult(false);                        // network error / timeout — counts against the breaker
      return null;
    } finally {
      inFlight--;
    }
  } finally {
    releasePermit();
  }
}

async function latestCollections(): Promise<string[]> {
  if (collections.ids.length && Date.now() - collections.at < 24 * 60 * 60 * 1000) return collections.ids;
  const res = await idxFetch(`${IDX}/collinfo.json`);
  if (!res || !res.ok) {
    // Can't even list crawls → nothing downstream can work. If we have no cached collection to fall back
    // on, rest the whole source briefly so a cold/throttled index doesn't bleed a ~10s timeout PER company
    // until the breaker trips after 8 strikes. One probe per minute when cold (vs. eight) — snappier + politer.
    if (!collections.ids.length) breakerUntil = Math.max(breakerUntil, Date.now() + 60_000);
    return collections.ids; // keep stale on failure (idxFetch already noted health)
  }
  try {
    const j = (await res.json()) as Array<{ id?: string }>;
    const ids = j.map((c) => c.id).filter((x): x is string => !!x).slice(0, 2); // two most-recent crawls
    if (ids.length) collections = { at: Date.now(), ids };
  } catch { /* keep stale */ }
  return collections.ids;
}

interface Rec { url: string; filename: string; offset: string; length: string }

async function indexLookup(col: string, domain: string): Promise<Rec[]> {
  const out: Rec[] = [];
  const seen = new Set<string>();
  for (const p of PATHS) {
    if (out.length >= MAX_PAGES) break;
    const res = await idxFetch(`${IDX}/${col}-index?url=${encodeURIComponent(domain + "/" + p)}&matchType=prefix&output=json&limit=6`);
    if (!res || !res.ok) continue;                        // miss/throttle/outage — idxFetch already noted health
    let text = ""; try { text = await res.text(); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim() || out.length >= MAX_PAGES) break;
      let j: { url?: string; status?: string | number; filename?: string; offset?: string | number; length?: string | number };
      try { j = JSON.parse(line); } catch { continue; }
      if (j.status !== undefined && String(j.status) !== "200") continue;
      if (!TEAM_RE.test(j.url || "")) continue;          // strict: drop /team-parker, /aboutus-blog, …
      const key = (j.url || "").replace(/\?.*$/, "");     // dedupe ignoring query string
      if (seen.has(key)) continue; seen.add(key);
      if (j.filename && j.offset !== undefined && j.length !== undefined) {
        out.push({ url: j.url!, filename: String(j.filename), offset: String(j.offset), length: String(j.length) });
      }
    }
  }
  return out;
}

async function warcBody(rec: Rec): Promise<string | null> {
  const start = Number(rec.offset), len = Number(rec.length);
  if (!isFinite(start) || !isFinite(len) || len <= 0 || len > MAX_RECORD_BYTES) return null;
  let res: Response;
  try {
    res = await fetch(`${DATA}/${rec.filename}`, {
      headers: { "User-Agent": UA, Range: `bytes=${start}-${start + len - 1}` },
      signal: AbortSignal.timeout(WARC_TIMEOUT_MS),
    });
  } catch { note(false); return null; }
  if (!res.ok && res.status !== 206) { note(false); return null; }
  note(true);
  let buf: Buffer;
  try { buf = Buffer.from(await res.arrayBuffer()); } catch { return null; }
  let raw: Buffer;
  try { raw = gunzipSync(buf); } catch { raw = buf; } // tolerate a non-gzipped record
  // A WARC record = WARC headers \r\n\r\n HTTP headers \r\n\r\n BODY. Skip both header blocks.
  const head = raw.toString("utf8", 0, Math.min(raw.length, 8_000));
  const i1 = head.indexOf("\r\n\r\n");
  if (i1 < 0) return null;
  const i2 = head.indexOf("\r\n\r\n", i1 + 4);
  const bodyStart = i2 >= 0 ? i2 + 4 : i1 + 4;
  const body = raw.toString("utf8", bodyStart, Math.min(raw.length, bodyStart + MAX_BODY));
  return body.length > 200 ? body : null;
}

/* ------------------------------------------------------------------ */
/* Public: archived team/about/leadership HTML for a company domain    */
/* ------------------------------------------------------------------ */

/**
 * Return the archived HTML of a company's team/about/leadership pages from Common Crawl (best-effort,
 * cached). The caller parses these with the same JSON-LD / microdata / card extractors used for live
 * team pages. Returns [] on any miss/outage — never throws.
 */
export async function ccTeamPages(domain: string): Promise<string[]> {
  const d = (domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").toLowerCase();
  if (!d.includes(".")) return [];

  const cached = domainCache.get(d);
  if (cached && Date.now() - cached.at < (cached.pages.length ? POS_TTL_MS : NEG_TTL_MS)) return cached.pages;
  if (breakerOpen()) return cached?.pages ?? []; // CC resting → don't pile on; reuse any stale pages

  const cols = await latestCollections();
  if (!cols.length) return cached?.pages ?? [];

  const pages: string[] = [];
  for (const col of cols) {
    if (pages.length >= MAX_PAGES) break;
    let recs: Rec[] = [];
    try { recs = await indexLookup(col, d); } catch { continue; }
    for (const r of recs) {
      if (pages.length >= MAX_PAGES) break;
      const html = await warcBody(r);
      if (html) pages.push(html);
    }
  }

  // Cache the verdict (positive or negative) and bound the map.
  if (domainCache.size >= CACHE_MAX) {
    for (const k of domainCache.keys()) { domainCache.delete(k); if (domainCache.size < CACHE_MAX * 0.9) break; }
  }
  domainCache.set(d, { at: Date.now(), pages });
  return pages;
}
