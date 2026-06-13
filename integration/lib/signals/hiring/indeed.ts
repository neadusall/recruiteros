/**
 * RecruitersOS · Hiring Engine
 * Indeed connector — a SignalSource whose network call is the injected unlocker.
 *
 * Indeed is HTML + Cloudflare + JS + CAPTCHA, not an open JSON API, so unlike the free
 * ATS connectors this one does NOT call `fetch` itself. You inject an `UnlockerFetch` — a
 * managed unlocker / SERP API (Bright Data, Oxylabs, ScraperAPI, Zyte) or your own
 * residential-proxy client — that returns rendered HTML or clean JSON. The connector then
 * normalizes listings into `job_posting` signals, anchoring every company through the
 * SHARED `companyAnchor()` so the coverage/suppress layer recognizes it against the free
 * pulls. Swap the unlocker without touching the rest of the engine.
 *
 * The default parser is best-effort (JSON-first, then an embedded-blob fallback). The
 * `parse` seam is the recommended place to adapt to exactly what YOUR unlocker returns.
 */

import type { PullContext, SignalSource } from "../sources";
import type { PullResult, Signal, SourceKind, SignalType } from "../types";
import { makeSignal } from "../sources";
import { companyAnchor } from "./normalize";

/* ------------------------------------------------------------------ */
/* Injected unlocker contract                                          */
/* ------------------------------------------------------------------ */

export interface UnlockerResponse {
  status: number;
  /** Rendered HTML or JSON text. */
  body: string;
  contentType?: string;
}

/** Fetch a URL through your proxy/unlocker and return its (rendered) body. */
export type UnlockerFetch = (url: string) => Promise<UnlockerResponse>;

/** A normalized Indeed listing — the shape the parser must produce. */
export interface IndeedListing {
  jobId: string;
  title: string;
  company: string;
  location?: string;
  /** ISO date the role was posted, if exposed. */
  postedAt?: string;
  url?: string;
  description?: string;
  remote?: boolean;
  salary?: string;
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface IndeedSourceOptions {
  /** Injected unlocker/proxy fetch. Required — without it the source is "not configured". */
  fetch?: UnlockerFetch;
  /** Indeed host (country), default "www.indeed.com". */
  host?: string;
  /** Default search query when the watchlist doesn't supply keywords. */
  query?: string;
  /** Default location filter (e.g. "United States", "Remote"). */
  location?: string;
  /** How many result pages to walk per pull (Indeed shows ~15/page). Default 5. */
  pages?: number;
  /** Hard cap on listings emitted per pull. Default 200. */
  maxListings?: number;
  /** Build the list/search URLs for a pull. Defaults to Indeed keyword+location search. */
  buildSearchUrls?: (ctx: PullContext, opts: IndeedSourceOptions) => string[];
  /** Parse one unlocker response into listings. Override to match your unlocker's output. */
  parse?: (res: UnlockerResponse, url: string) => IndeedListing[];
  /** Connector id (default "indeed"). */
  id?: string;
}

/* ------------------------------------------------------------------ */
/* Default URL builder + parser                                        */
/* ------------------------------------------------------------------ */

function defaultBuildSearchUrls(ctx: PullContext, opts: IndeedSourceOptions): string[] {
  const host = opts.host ?? "www.indeed.com";
  const keywords = ctx.watchlist?.keywords?.join(" ") || opts.query || "";
  const location = ctx.watchlist?.locations?.[0] || opts.location || "";
  const pages = opts.pages ?? 5;
  const urls: string[] = [];
  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams();
    if (keywords) params.set("q", keywords);
    if (location) params.set("l", location);
    if (i > 0) params.set("start", String(i * 10));
    urls.push(`https://${host}/jobs?${params.toString()}`);
  }
  return urls;
}

/**
 * Best-effort default parser. Prefers JSON (many unlockers return parsed results); falls
 * back to Indeed's embedded `mosaic-provider-jobcards` blob. Returns [] (not an error) when
 * it can't find listings, so a markup change degrades to "no results + a warning" rather
 * than a crash. Replace with a parser tuned to your unlocker for production.
 */
export function defaultParseIndeed(res: UnlockerResponse, _url: string): IndeedListing[] {
  const body = res.body ?? "";
  // 1) JSON response (unlocker returned structured data).
  const looksJson =
    (res.contentType ?? "").includes("json") || /^\s*[[{]/.test(body);
  if (looksJson) {
    try {
      const data = JSON.parse(body);
      const rows: any[] =
        data.results ?? data.jobs ?? data.hits ?? data.data ?? (Array.isArray(data) ? data : []);
      return rows.map(normalizeJsonRow).filter((r): r is IndeedListing => Boolean(r));
    } catch {
      /* fall through to HTML */
    }
  }
  // 2) Embedded jobcards blob inside the HTML.
  const m = body.match(/jobcards["']?\s*:\s*(\{[\s\S]*?\})\s*[,}]/i);
  if (m) {
    try {
      const blob = JSON.parse(m[1]);
      const results: any[] = blob.results ?? [];
      return results.map(normalizeJsonRow).filter((r): r is IndeedListing => Boolean(r));
    } catch {
      /* give up gracefully */
    }
  }
  return [];
}

function normalizeJsonRow(row: any): IndeedListing | null {
  if (!row) return null;
  const jobId = String(row.jobkey ?? row.jobKey ?? row.id ?? row.jk ?? "").trim();
  const title = String(row.title ?? row.jobTitle ?? row.displayTitle ?? "").trim();
  const company = String(row.company ?? row.companyName ?? row.employer ?? "").trim();
  if (!title || !company) return null;
  const loc =
    row.formattedLocation ?? row.location ?? row.jobLocationCity ?? row.locationName;
  return {
    jobId: jobId || `${company}:${title}`,
    title,
    company,
    location: loc ? String(loc) : undefined,
    postedAt: row.pubDate ? toIso(row.pubDate) : row.postedAt ? String(row.postedAt) : undefined,
    url: row.url ?? row.link ?? (jobId ? `https://www.indeed.com/viewjob?jk=${jobId}` : undefined),
    description: row.snippet ?? row.description,
    remote: /remote/i.test(`${loc ?? ""} ${row.title ?? ""}`),
    salary: row.salarySnippet?.text ?? row.salary,
  };
}

function toIso(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  try {
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* The connector                                                       */
/* ------------------------------------------------------------------ */

export class IndeedSource implements SignalSource {
  readonly id: string;
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Indeed (via unlocker)";

  constructor(private readonly opts: IndeedSourceOptions = {}) {
    this.id = opts.id ?? "indeed";
  }

  /** Configured once a proxy/unlocker fetch is injected. */
  isConfigured(): boolean {
    return typeof this.opts.fetch === "function";
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const warnings: string[] = [];
    if (!this.opts.fetch) {
      return { signals: [], warnings: ["indeed: no unlocker fetch injected"] };
    }

    const build = this.opts.buildSearchUrls ?? defaultBuildSearchUrls;
    const parse = this.opts.parse ?? defaultParseIndeed;
    const maxListings = this.opts.maxListings ?? 200;
    const urls = build(ctx, this.opts);

    const signals: Signal[] = [];
    const seen = new Set<string>();

    for (const url of urls) {
      if (signals.length >= maxListings) break;
      let res: UnlockerResponse;
      try {
        res = await this.opts.fetch(url);
      } catch (err) {
        warnings.push(`indeed fetch "${url}": ${(err as Error).message}`);
        continue;
      }
      if (res.status >= 400) {
        warnings.push(`indeed "${url}": status ${res.status}`);
        continue;
      }
      let listings: IndeedListing[];
      try {
        listings = parse(res, url);
      } catch (err) {
        warnings.push(`indeed parse "${url}": ${(err as Error).message}`);
        continue;
      }
      if (!listings.length) warnings.push(`indeed "${url}": 0 listings parsed`);

      for (const l of listings) {
        if (signals.length >= maxListings) break;
        const externalId = `${this.id}:${l.jobId}`;
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        const anchor = companyAnchor(l.company) || l.company.toLowerCase();
        signals.push(
          makeSignal({
            type: "job_posting",
            title: `${l.company} is hiring: ${l.title}`,
            detail: `Open role "${l.title}"${l.location ? ` in ${l.location}` : ""} (Indeed). Direct hiring intent.`,
            evidence: {
              roleTitle: l.title,
              location: l.location,
              applyUrl: l.url,
              remote: l.remote,
              salary: l.salary,
              snippet: l.description,
              ats: "Indeed",
            },
            source: {
              kind: this.kind,
              connector: this.id,
              url: l.url,
              externalId,
              observedAt: now,
            },
            eventAt: l.postedAt ?? now,
            ingestedAt: now,
            anchor,
            companyHint: { id: "", name: l.company },
          }),
        );
      }
    }

    // Soft rate-limit hint: Indeed is gated; don't hammer it.
    return { signals, warnings, nextPollAfter: undefined };
  }
}

/** Convenience factory mirroring the free-source `freeSources()` style. */
export function indeedSource(opts: IndeedSourceOptions = {}): IndeedSource {
  return new IndeedSource(opts);
}
