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
function note(ok: boolean): void {
  if (ok) { recentFails = 0; return; }
  if (++recentFails >= 8) { breakerUntil = Date.now() + 5 * 60 * 1000; recentFails = 0; } // rest 5 min
}
function breakerOpen(): boolean { return Date.now() < breakerUntil; }

/** Liveness for the engine-health surface (so a CC outage is visible, not silent). */
export function commonCrawlHealth(): { resting: boolean; restingForSec: number; collections: string[]; cachedDomains: number } {
  return {
    resting: breakerOpen(),
    restingForSec: breakerOpen() ? Math.round((breakerUntil - Date.now()) / 1000) : 0,
    collections: collections.ids.slice(),
    cachedDomains: domainCache.size,
  };
}

/* ------------------------------------------------------------------ */
/* Fetch helpers (timed out, never throw)                              */
/* ------------------------------------------------------------------ */

async function idxFetch(url: string): Promise<Response | null> {
  try { return await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(IDX_TIMEOUT_MS) }); }
  catch { return null; }
}

async function latestCollections(): Promise<string[]> {
  if (collections.ids.length && Date.now() - collections.at < 24 * 60 * 60 * 1000) return collections.ids;
  const res = await idxFetch(`${IDX}/collinfo.json`);
  if (!res || !res.ok) { note(!!res); return collections.ids; } // keep stale on failure
  note(true);
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
    if (!res) { note(false); continue; }
    if (res.status === 404) { note(true); continue; }   // 404 = "no capture" (normal) → CC is up
    if (!res.ok) { note(false); continue; }
    note(true);
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
