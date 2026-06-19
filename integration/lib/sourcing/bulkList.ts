/**
 * RecruitersOS · Bulk decision-maker list builder
 *
 * Build a large list (e.g. 100K) of decision-makers (VP/Director level) at companies
 * sized 100-5,000 employees, off the live market — cheaply — and land each verified
 * contact in the Data warehouse. No fabrication: every person comes from a real
 * people-search call; every email is a local permutation that must pass verification
 * before it's kept.
 *
 * THE CHEAP-AND-PRECISE TRICK
 * ---------------------------
 * A single LinkedIn/Sales-Nav-style search only exposes ~2,500 results, and the cheap
 * keyword scrapers don't filter by headcount. We get around both by SPLITTING the pull
 * into a matrix of narrow segments — (decision-maker title) × (US metro) × (headcount
 * band) — and unioning the results. Each segment is well under the 2,500 cap, and the
 * headcount band is pushed into the search itself (Sales-Nav listings accept a
 * `company_headcount` facet, wired in discovery.ts), so the size constraint costs zero
 * extra requests. Listings that ignore the facet still get a free best-effort Wikidata
 * size gate as a backstop (companySize.ts).
 *
 * THE PIPELINE (per person)
 * -------------------------
 *   people-search (discovery.rapidApiPeopleSearch)  → name, title, location, company, URL
 *   → email PERMUTATION (free, local): guess first.last@domain etc. from name + company
 *     domain. By default we keep the best guess as a POTENTIAL email (status "unverified")
 *     and stash every candidate permutation on the record so a separate validation tool can
 *     confirm it later — no paid verification spend. Set `verify: true` to instead run the
 *     paid waterfall (Icypeas + MX/SMTP) and keep only confirmed addresses.
 *   → upsert into the Data warehouse, deduped by linkedin → email → name+company.
 *
 * RESUMABLE BY DESIGN
 * -------------------
 * 100K rows can't be built inside one serverless request. The job is a persisted cursor
 * over the segment matrix: each `stepBulkList()` does a bounded number of search calls and
 * returns progress, so a cron / loop / Autopilot tick drives it to completion and a
 * redeploy mid-run resumes from the next un-scanned page — never re-pulling finished work.
 */

import { rapidApiPeopleSearch, rapidApiSearchConfigured } from "./discovery";
import type { CandidateRow } from "./types";
import { upsertRecords } from "../data/store";
import type { DataRecordInput, ContactStatus } from "../data/types";
import { loadSnapshot, saveSnapshot } from "../db";
import { rid, nowIso } from "../core/ids";

/* ------------------------------------------------------------------ */
/* Seed matrices — the axes we split the pull across                   */
/* ------------------------------------------------------------------ */

/**
 * Decision-maker title keywords across the common functions (US, all industries).
 * VP + Director level per the ICP: each becomes the `name`/keyword of a search segment.
 * Listings treat this as a fuzzy role match, so we keep the phrases canonical.
 */
export const DECISION_MAKER_TITLES: string[] = [
  // Executive / GM
  "VP Operations", "Director of Operations", "VP General Manager", "Managing Director",
  // Sales / Revenue
  "VP Sales", "Director of Sales", "VP Revenue", "VP Business Development",
  // Marketing
  "VP Marketing", "Director of Marketing", "VP Demand Generation",
  // Engineering / Product / IT
  "VP Engineering", "Director of Engineering", "VP Product", "Director of Product",
  "VP Information Technology", "Director of IT",
  // Finance
  "VP Finance", "Director of Finance", "VP Financial Planning",
  // People / HR / Talent
  "VP Human Resources", "Director of Human Resources", "VP Talent Acquisition",
  "Director of Recruiting", "VP People",
  // Customer / Success / Support
  "VP Customer Success", "Director of Customer Experience",
  // Supply chain / Procurement / Manufacturing
  "VP Supply Chain", "Director of Procurement", "VP Manufacturing",
];

/**
 * US metros to split each title across (keeps every segment under the ~2,500 search cap
 * and spreads the pull nationally). Plain names — listings geo-resolve them; for listings
 * that need a numeric geo id, set `geoLocation` on the segment instead.
 */
export const US_GEOS: string[] = [
  "New York", "Los Angeles", "Chicago", "Dallas", "Houston", "Washington DC",
  "San Francisco Bay Area", "Boston", "Atlanta", "Philadelphia", "Phoenix",
  "Seattle", "Miami", "Denver", "Minneapolis", "Detroit", "Austin", "Charlotte",
  "Tampa", "Nashville",
];

/**
 * Headcount bands covering ~100-5,000 employees. Sales-Nav facets are coarse, so "51-200"
 * is included (it carries the 100-199 slice); the free Wikidata backstop drops anything it
 * can positively confirm is under 100 or over 5,000.
 */
export const HEADCOUNT_BANDS: string[] = ["51-200", "201-500", "501-1000", "1001-5000"];

/** Only a verified email clears this bar. The bare permutation guess scores 0.35, so a
 *  value at/above this means a verifier (Icypeas / MX-SMTP) confirmed it. */
const MIN_VERIFIED_CONFIDENCE = 0.75;
/** At/above this we call it fully verified; between the two it's "probable". */
const STRONG_CONFIDENCE = 0.85;

/* ------------------------------------------------------------------ */
/* Job state (persisted, resumable)                                    */
/* ------------------------------------------------------------------ */

interface Segment {
  title: string;
  geo: string;
  headcount: string;
}

export interface BulkListJob {
  id: string;
  workspaceId: string;
  status: "running" | "paused" | "done";
  /** How many verified contacts we're aiming for. */
  target: number;
  /** Keep a record only when an email could be formed (the ICP default). */
  requireEmail: boolean;
  /** Run the paid verify waterfall and keep only confirmed emails. Default false —
   *  keep the free permutation as a "potential" email and validate it later. */
  verify: boolean;
  /** The precomputed segment matrix and where we are in it. */
  segments: Segment[];
  cursor: number;   // index into segments
  page: number;     // 1-based page within the current segment
  /** Tallies. */
  collected: number;   // records upserted (counts toward target)
  scanned: number;     // people seen across all segments
  enrichAttempts: number;
  verifiedEmails: number;
  /** Coarse spend estimate in waterfall cost-units (the ledger holds the real $$). */
  spendUnits: number;
  /** Dedup keys already processed, so a resumed step never re-enriches the same person. */
  seenKeys: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

const jobKey = (workspaceId: string) => `bulk_list_job_v1:${workspaceId}`;

export async function bulkListStatus(workspaceId: string): Promise<BulkListJob | null> {
  return (await loadSnapshot<BulkListJob>(jobKey(workspaceId))) ?? null;
}

async function persist(job: BulkListJob): Promise<void> {
  job.updatedAt = nowIso();
  await saveSnapshot(jobKey(job.workspaceId), job);
}

/** Build the full segment matrix in a stable order (title-major, then geo, then band). */
function buildSegments(titles: string[], geos: string[], bands: string[]): Segment[] {
  const out: Segment[] = [];
  for (const title of titles) {
    for (const geo of geos) {
      for (const headcount of bands) out.push({ title, geo, headcount });
    }
  }
  return out;
}

export interface StartBulkOptions {
  target?: number;
  requireEmail?: boolean;
  /** Paid email verification. Default false (keep free permutations, validate later). */
  verify?: boolean;
  titles?: string[];
  geos?: string[];
  headcountBands?: string[];
}

/**
 * Create (or reset) the bulk-list job for a workspace. Idempotent on the cursor: a fresh
 * start re-plans the segment matrix and zeroes progress. Refuses to start with no search
 * provider configured rather than silently producing nothing.
 */
export async function startBulkList(ws: string, opts: StartBulkOptions = {}): Promise<BulkListJob> {
  if (!rapidApiSearchConfigured()) {
    throw new Error(
      "No people-search provider configured. Set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST " +
        "(and RAPIDAPI_PEOPLE_SEARCH_PATH for your listing) before starting a bulk list.",
    );
  }
  const segments = buildSegments(
    opts.titles ?? DECISION_MAKER_TITLES,
    opts.geos ?? US_GEOS,
    opts.headcountBands ?? HEADCOUNT_BANDS,
  );
  const now = nowIso();
  const job: BulkListJob = {
    id: rid("bulk"),
    workspaceId: ws,
    status: "running",
    target: Math.max(1, opts.target ?? 100_000),
    requireEmail: opts.requireEmail ?? true,
    verify: opts.verify ?? false,
    segments,
    cursor: 0,
    page: 1,
    collected: 0,
    scanned: 0,
    enrichAttempts: 0,
    verifiedEmails: 0,
    spendUnits: 0,
    seenKeys: [],
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  await persist(job);
  return job;
}

/* ------------------------------------------------------------------ */
/* The work step                                                       */
/* ------------------------------------------------------------------ */

/** Stable per-person key for cross-step dedup (mirrors the warehouse's own key order). */
function personKey(r: CandidateRow): string {
  if (r.linkedinUrl) return "li:" + r.linkedinUrl.toLowerCase().replace(/\/+$/, "").trim();
  return "nc:" + ((r.fullName || "") + "|" + (r.company || "")).toLowerCase().trim();
}

/** Split a full name into first / last for the email permutation. */
function splitName(full: string): { first: string; last: string } {
  const parts = (full || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}

/** Map a CandidateRow's free-text location to city/state (best-effort, US-shaped). */
function splitLocation(loc?: string): { city?: string; state?: string } {
  if (!loc) return {};
  const [city, state] = loc.split(",").map((s) => s.trim());
  return { city: city || undefined, state: state || undefined };
}

export interface StepResult {
  job: BulkListJob;
  /** Records added by this step. */
  added: number;
  /** People-search calls this step made. */
  requests: number;
  done: boolean;
}

/**
 * Advance the job by up to `maxRequests` people-search calls. Each call's results are
 * deduped, optionally email-verified, and upserted into the warehouse. Bounded so it fits
 * comfortably inside one serverless invocation; call it repeatedly (cron / loop) until
 * `done`. Safe to call when already done — it no-ops.
 */
export async function stepBulkList(ws: string, maxRequests = 6): Promise<StepResult> {
  const job = await bulkListStatus(ws);
  if (!job) throw new Error("No bulk-list job. Start one first.");
  if (job.status === "done" || job.collected >= job.target) {
    job.status = "done";
    await persist(job);
    return { job, added: 0, requests: 0, done: true };
  }

  const seen = new Set(job.seenKeys);
  const { enrich, cheapFirstContactWaterfall, contactWaterfall } = await import("../signals");
  // Default: free local permutation only (domain guess + first.last@domain), no paid spend.
  // verify mode: the cheap-first waterfall (Icypeas + MX/SMTP) to keep only confirmed emails.
  const plan = job.verify ? cheapFirstContactWaterfall() : contactWaterfall();

  let added = 0;
  let requests = 0;
  const batch: DataRecordInput[] = [];

  while (requests < maxRequests && job.cursor < job.segments.length && job.collected + added < job.target) {
    const seg = job.segments[job.cursor];
    let rows: CandidateRow[] = [];
    try {
      rows = await rapidApiPeopleSearch({
        name: seg.title,
        page: job.page,
        limit: 100,
        geoLocation: seg.geo,
        headcount: seg.headcount,
      });
      requests++;
    } catch (e: any) {
      job.warnings.push(`segment ${job.cursor} p${job.page} (${seg.title} / ${seg.geo}): ${(e && e.message) || e}`);
      // Listing hiccup on this page — move to the next segment rather than spin.
      job.cursor++;
      job.page = 1;
      continue;
    }

    // A short page means the segment is exhausted → advance; otherwise paginate.
    if (rows.length === 0) {
      job.cursor++;
      job.page = 1;
    } else {
      job.page++;
      if (rows.length < 25 || job.page > 100) { job.cursor++; job.page = 1; } // sales-nav exposes ≤100 pages
    }

    for (const r of rows) {
      if (job.collected + added >= job.target) break;
      const key = personKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      job.scanned++;
      if (!r.fullName) continue;

      const { first, last } = splitName(r.fullName);
      let email: string | undefined;
      let emailStatus: ContactStatus | undefined;
      let permutations: string[] | undefined;
      let companyDomain: string | undefined; // the guessed company URL (also used for the email)

      if (first && last && r.company) {
        try {
          job.enrichAttempts++;
          const report = await enrich(
            plan,
            {
              name: r.company,
              companyName: r.company,
              fullName: r.fullName,
              firstName: first,
              lastName: last,
              title: r.title,
              linkedinUrl: r.linkedinUrl,
            },
            { now: nowIso() },
          );
          job.spendUnits += report.totalCost || 0;
          const dom = report.resolved.domain;
          if (dom && typeof dom.value === "string") companyDomain = dom.value;
          const resolved = report.resolved.email;
          if (resolved && typeof resolved.value === "string") {
            if (job.verify) {
              // Paid mode: only trust a verifier-confirmed address.
              if (resolved.confidence >= MIN_VERIFIED_CONFIDENCE) {
                email = resolved.value;
                emailStatus = resolved.confidence >= STRONG_CONFIDENCE ? "verified" : "probable";
                job.verifiedEmails++;
              }
            } else {
              // Free mode: keep the best permutation as a potential email; stash all
              // candidates so a downstream tool can validate/choose later.
              email = resolved.value;
              emailStatus = "unverified";
              const perms = (resolved.raw as { permutations?: unknown })?.permutations;
              if (Array.isArray(perms)) permutations = perms.filter((p): p is string => typeof p === "string");
            }
          }
        } catch {
          /* enrichment miss — record still has name/title/company/location/linkedin */
        }
      }

      if (job.requireEmail && !email) continue; // skip rows we couldn't form any email for

      const { city, state } = splitLocation(r.location);
      batch.push({
        fullName: r.fullName,
        firstName: first || undefined,
        lastName: last || undefined,
        title: r.title,
        seniority: "decision-maker",
        company: r.company,
        companyDomain,                 // guessed company URL (e.g. acme.com)
        email,
        emailStatus,
        linkedinUrl: r.linkedinUrl,
        image: r.imageUrl,
        city,                          // person's location (city)
        state,
        country: "United States",
        tags: ["bulk-list", "decision-maker", seg.headcount],
        origin: `bulk:${seg.title}`,
        source: "manual",
        raw: {
          company_headcount: seg.headcount,          // the size band we searched within
          // Every candidate address for this person, ready to feed a validation tool.
          ...(permutations && permutations.length
            ? { email_permutations: permutations.join(", ") }
            : {}),
        },
      });
      added++;
    }
  }

  if (batch.length) await upsertRecords(ws, batch);
  job.collected += added;
  job.seenKeys = [...seen];
  if (job.cursor >= job.segments.length || job.collected >= job.target) job.status = "done";
  await persist(job);

  return { job, added, requests, done: job.status === "done" };
}
