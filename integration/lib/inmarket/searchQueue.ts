/**
 * RecruitersOS · In-Market · TARGETED SEARCH QUEUE
 *
 * The user-controlled alternative to the background accumulator's random JSearch rotation.
 * You author EXACT JSearch searches (role/keywords + location + recency + employment type),
 * save them to a queue, then run them on demand — and a preview step lets you pick which
 * companies actually merge into the pool. Nothing scrapes until you press Run.
 *
 * Persisted as ONE blob in the engine's Postgres snapshot layer (ros_kv), same as the pool;
 * with no DATABASE_URL it degrades to in-memory-empty (so the UI still works, just not durable).
 *
 * GLOBAL (market data, not per-workspace) — mirrors how the pool is shared.
 */

import { loadSnapshot, saveSnapshot } from "../db";

const KEY = "inmarket_search_queue_v1";
const MAX_SEARCHES = 200;

/** JSearch date_posted windows (the values JSearch itself accepts). */
export type DatePosted = "all" | "today" | "3days" | "week" | "month";
/** JSearch employment_types values. */
export type EmploymentType = "FULLTIME" | "PARTTIME" | "CONTRACTOR" | "INTERN";
/** Company headcount bands (mirrors companySize.ts Band) used to narrow a search by size. */
export type HeadcountBand = "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1001-5000" | "5000+";

export interface TargetedSearch {
  id: string;
  name: string;                  // a label you give it, e.g. "NYC controllers"
  query: string;                 // job title / role keywords — part of the JSearch `query`
  industry?: string;             // industry / market keywords — folded into the JSearch `query` too
  location?: string;             // "New York, NY" / "Texas" / "United States" (default: nationwide)
  datePosted: DatePosted;        // recency window
  employmentTypes?: EmploymentType[];
  remoteOnly?: boolean;
  headcountBands?: HeadcountBand[]; // narrow to companies in these size bands (0 = any size)
  confirmedSizeOnly?: boolean;   // when narrowing by size, keep only authoritative (Wikidata) headcounts
  limit: number;                 // jobs to pull (10–500)
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;            // last time it was RUN (previewed)
  lastResult?: { companies: number; jobs: number; merged?: number };
  runs: number;                  // how many times it's been run
  status: "draft" | "ran" | "error";
  lastError?: string;
}

async function load(): Promise<TargetedSearch[]> {
  const s = await loadSnapshot<TargetedSearch[]>(KEY);
  return Array.isArray(s) ? s : [];
}
async function save(rows: TargetedSearch[]): Promise<void> {
  await saveSnapshot(KEY, rows.slice(0, MAX_SEARCHES));
}

function newId(): string {
  return "sq_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function clampLimit(n: unknown): number {
  return Math.min(Math.max(Math.round(Number(n) || 100), 10), 500);
}
function cleanDate(d: unknown): DatePosted {
  const v = String(d || "week").toLowerCase();
  return (["all", "today", "3days", "week", "month"].includes(v) ? v : "week") as DatePosted;
}
function cleanEmployment(arr: unknown): EmploymentType[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const ok = ["FULLTIME", "PARTTIME", "CONTRACTOR", "INTERN"];
  const out = arr.map((x) => String(x).toUpperCase()).filter((x) => ok.includes(x)) as EmploymentType[];
  return out.length ? Array.from(new Set(out)) : undefined;
}
function cleanBands(arr: unknown): HeadcountBand[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const ok = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"];
  const out = arr.map((x) => String(x).trim()).filter((x) => ok.includes(x)) as HeadcountBand[];
  return out.length ? Array.from(new Set(out)) : undefined;
}

/** List all saved targeted searches (newest first). */
export async function listSearches(): Promise<TargetedSearch[]> {
  const rows = await load();
  return rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** Fetch one saved search by id. */
export async function getSearch(id: string): Promise<TargetedSearch | undefined> {
  return (await load()).find((s) => s.id === id);
}

/** Create or update a targeted search. Pass an `id` to update; omit it to create. */
export async function saveSearch(input: Partial<TargetedSearch>): Promise<TargetedSearch> {
  const query = String(input.query ?? "").trim();
  const industry = String(input.industry ?? "").trim();
  // A search needs at least ONE keyword source — a job title OR an industry/market.
  if (!query && !industry) { const e = new Error("a job title or an industry is required"); (e as any).status = 422; throw e; }
  const now = new Date().toISOString();
  const rows = await load();
  const base: TargetedSearch = {
    id: String(input.id || "") || newId(),
    name: String(input.name ?? "").trim() || query || industry,
    query,
    industry: industry || undefined,
    location: input.location ? String(input.location).trim() : undefined,
    datePosted: cleanDate(input.datePosted),
    employmentTypes: cleanEmployment(input.employmentTypes),
    remoteOnly: input.remoteOnly === true,
    headcountBands: cleanBands(input.headcountBands),
    confirmedSizeOnly: input.confirmedSizeOnly === true,
    limit: clampLimit(input.limit),
    createdAt: now,
    updatedAt: now,
    runs: 0,
    status: "draft",
  };
  const idx = rows.findIndex((s) => s.id === base.id);
  if (idx >= 0) {
    // Update: preserve run history + created time.
    const prev = rows[idx];
    rows[idx] = { ...prev, ...base, createdAt: prev.createdAt, runs: prev.runs, lastRunAt: prev.lastRunAt, lastResult: prev.lastResult, status: prev.status, updatedAt: now };
  } else {
    rows.unshift(base);
  }
  await save(rows);
  return rows[idx >= 0 ? idx : 0];
}

/** Delete a saved search. */
export async function deleteSearch(id: string): Promise<boolean> {
  const rows = await load();
  const next = rows.filter((s) => s.id !== id);
  if (next.length === rows.length) return false;
  await save(next);
  return true;
}

/** Stamp a successful run (preview fetched) onto a saved search. */
export async function markRun(id: string, result: { companies: number; jobs: number }): Promise<void> {
  const rows = await load();
  const s = rows.find((x) => x.id === id);
  if (!s) return;
  s.lastRunAt = new Date().toISOString();
  s.runs = (s.runs || 0) + 1;
  s.lastResult = { ...result };
  s.status = "ran";
  s.lastError = undefined;
  s.updatedAt = s.lastRunAt;
  await save(rows);
}

/** Stamp a failed run onto a saved search (e.g. feed not configured / fetch error). */
export async function markError(id: string, message: string): Promise<void> {
  const rows = await load();
  const s = rows.find((x) => x.id === id);
  if (!s) return;
  s.status = "error";
  s.lastError = message.slice(0, 300);
  s.updatedAt = new Date().toISOString();
  await save(rows);
}

/** Record how many companies the user actually committed (merged into the pool) from a run. */
export async function markCommitted(id: string, merged: number): Promise<void> {
  const rows = await load();
  const s = rows.find((x) => x.id === id);
  if (!s) return;
  s.lastResult = { ...(s.lastResult || { companies: merged, jobs: merged }), merged };
  s.updatedAt = new Date().toISOString();
  await save(rows);
}
